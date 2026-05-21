import fs from "fs";
import path from "path";
import { SpawnedAgent } from "./agent";
import { getProvider } from "./providers";
import { loadAgentConfig, loadSystemPrompt, loadMemory, ensureLogsDir, ORCHESTRIA_HOME } from "./config";
import { sseBroadcast } from "./sse";
import { getDb } from "../db";
import { createCard, updateCardByMissionId } from "../kanbanRepo";
import type { ClaudeEvent } from "./types";

function newMissionId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max concurrently-running agents. A flood (webhook/Telegram) must not spawn unbounded PTYs. */
const MAX_CONCURRENT = envInt("ORCHESTRIA_MAX_CONCURRENT", 8);
/** Wall-clock kill for a single mission, so a hung/looping `claude` can't live forever. */
const MISSION_TIMEOUT_MS = envInt("ORCHESTRIA_MISSION_TIMEOUT_MS", 30 * 60 * 1000);

export type SpawnKind = "chat" | "mission" | "channel";

export interface SpawnOptions {
  sourceChannel?: string;
  sourceMeta?: Record<string, unknown>;
  resumeSessionId?: string;
  kind?: SpawnKind;
  /** When true, do not INSERT a kanban row — caller already has a card to PATCH with mission_id (e.g. Board spawn). */
  skipKanbanCard?: boolean;
  /** Routine that triggered this run, if any (for cron-scheduled missions). */
  routineId?: string;
}

type CompletionListener = (info: {
  missionId: string;
  agentName: string;
  status: "done" | "failed" | "halted";
  sourceChannel: string | null;
  sourceMeta: Record<string, unknown> | null;
}) => void;

class AgentRegistry {
  private live = new Map<string, SpawnedAgent>();
  private completionListeners = new Set<CompletionListener>();

  onMissionComplete(listener: CompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => this.completionListeners.delete(listener);
  }

  spawn(agentName: string, mission: string, opts: SpawnOptions = {}): SpawnedAgent {
    if (this.live.size >= MAX_CONCURRENT) {
      throw new Error(
        `agent concurrency limit reached (${MAX_CONCURRENT}); try again once a running mission finishes`,
      );
    }
    const config = loadAgentConfig(agentName);
    const provider = getProvider(config.provider);
    const scope = config.memoryScope ?? "USER";
    const systemPrompt = loadSystemPrompt(agentName) + loadMemory(agentName, scope);
    const missionId = newMissionId();
    const sourceChannel = opts.sourceChannel ?? null;
    const sourceMeta = opts.sourceMeta ?? null;
    // If scope is NONE, never resume a previous session — always start fresh
    const resumeSessionId = scope === "NONE" ? undefined : opts.resumeSessionId;

    const db = getDb();
    const kind = opts.kind ?? "mission";
    db.prepare(
      `INSERT INTO missions (id, agent_id, title, status, start_ts, created_at, source_channel, source_meta, kind, routine_id)
       VALUES (?, ?, ?, 'running', unixepoch(), unixepoch(), ?, ?, ?, ?)`
    ).run(missionId, agentName, mission, sourceChannel, sourceMeta ? JSON.stringify(sourceMeta) : null, kind, opts.routineId ?? null);

    const agent = new SpawnedAgent(missionId, agentName, provider, config, systemPrompt, mission, resumeSessionId);
    this.live.set(missionId, agent);

    const timeoutTimer = setTimeout(() => {
      if (this.live.has(missionId)) agent.kill();
    }, MISSION_TIMEOUT_MS);
    timeoutTimer.unref?.();

    if (kind !== "chat" && !opts.skipKanbanCard) {
      createCard({ title: mission, agent: agentName, col: "doing", mission_id: missionId });
    }

    const setSession = db.prepare("UPDATE missions SET claude_session_id = ? WHERE id = ?");
    agent.on("session", (sid: string) => {
      setSession.run(sid, missionId);
    });

    const insertEvent = db.prepare(
      `INSERT INTO events (mission_id, agent_id, ts, kind, body) VALUES (?, ?, ?, ?, ?)`
    );
    const finishMission = db.prepare(
      `UPDATE missions SET status = ?, end_ts = unixepoch() WHERE id = ?`
    );
    const updateCost = db.prepare(
      `UPDATE missions SET cost_usd = ?, tokens_in = ?, tokens_out = ? WHERE id = ?`
    );

    agent.on("event", (ev: ClaudeEvent) => {
      insertEvent.run(missionId, agentName, Math.floor(ev.timestamp / 1000), ev.type, JSON.stringify(ev.payload));
      sseBroadcast(missionId, ev, agentName);
      this.appendLog(agentName, ev);
      // Cost & token usage extraction is provider-specific (Claude reports a
      // USD cost on its `result` event; Codex reports token counts only).
      const usage = provider.usageFrom(ev);
      if (usage) {
        updateCost.run(usage.costUsd ?? 0, usage.tokensIn ?? 0, usage.tokensOut ?? 0, missionId);
      }
    });

    // Persist non-JSON lines too — CLI errors (unknown flags, panics, prompts
    // for confirmation) never reach `agent.on("event")` because they aren't
    // structured events, so without this they were dropped on the floor and
    // a chat bubble would stay empty with no clue why. Capped at ~200 raw
    // lines per mission so a runaway log doesn't bloat the DB.
    let rawCount = 0;
    agent.on("raw", (line: string) => {
      if (rawCount >= 200) return;
      rawCount++;
      const stamp = Date.now();
      const payload = { line };
      insertEvent.run(missionId, agentName, Math.floor(stamp / 1000), "raw", JSON.stringify(payload));
      sseBroadcast(missionId, { type: "raw", timestamp: stamp, payload }, agentName);
    });


    agent.on("done", (exitCode: number) => {
      clearTimeout(timeoutTimer);
      const finalStatus: "done" | "failed" = exitCode === 0 ? "done" : "failed";
      finishMission.run(finalStatus, missionId);
      const closing: ClaudeEvent = {
        type: "MissionComplete",
        timestamp: Date.now(),
        payload: { exitCode, status: finalStatus },
      };
      insertEvent.run(missionId, agentName, Math.floor(closing.timestamp / 1000), closing.type, JSON.stringify(closing.payload));
      sseBroadcast(missionId, closing, agentName);
      this.live.delete(missionId);
      // On mission complete, sync the kanban card with the mission outcome:
      // success → move the card to the `done` column, failure → keep it where
      // it is but tag it red so the UI shows the regression. Channel-spawned
      // chats don't have a card (kind === "chat") and `skipKanbanCard` is set
      // when the caller (e.g. the Board) owns its own card.
      if (kind !== "chat" && !opts.skipKanbanCard) {
        if (finalStatus === "failed") {
          updateCardByMissionId(missionId, { tags: ["failed"] });
        } else {
          updateCardByMissionId(missionId, { col: "done" });
        }
      }
      for (const l of this.completionListeners) {
        l({ missionId, agentName, status: finalStatus, sourceChannel, sourceMeta });
      }
    });

    return agent;
  }

  get(missionId: string): SpawnedAgent | undefined {
    return this.live.get(missionId);
  }

  list(): { missionId: string; agentName: string; startedAt: number }[] {
    return Array.from(this.live.values()).map((a) => ({
      missionId: a.missionId,
      agentName: a.agentName,
      startedAt: a.startedAt,
    }));
  }

  private appendLog(agentName: string, ev: ClaudeEvent): void {
    const dir = ensureLogsDir(agentName);
    fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify(ev) + "\n");
  }
}

const g = globalThis as { __mosRegistry?: AgentRegistry };
export const registry = (g.__mosRegistry ??= new AgentRegistry());

void ORCHESTRIA_HOME;
