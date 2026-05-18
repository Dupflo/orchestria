import { dueRoutines, markRoutineFired, getRoutine, type RoutineRow } from "./repo";
import { expandRoutinePlaceholders } from "./fleetStats";
import { registry } from "../orchestrator/registry";
import { getDb } from "../db";
import { tryLoadChannelConfig } from "../channels/config";
import { listSubscribers } from "../channels/subscribers";
import { sendTelegramMessage } from "../channels/handlers/telegram";
import { buildMissionOutput } from "../remote/output";

const TICK_MS = 30_000; // check every 30s

const g = globalThis as { __mosRoutineSched?: { interval: NodeJS.Timeout; unsubMissions?: () => void } };

export function startScheduler(): boolean {
  if (g.__mosRoutineSched) return false;

  const tick = () => {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const due = dueRoutines(nowSec);
      for (const r of due) {
        try {
          const prompt = expandRoutinePlaceholders(r.prompt);
          const mission = r.skill_ref ? `${r.skill_ref}\n\n${prompt}` : prompt;
          registry.spawn(r.agent_id, mission, { kind: "mission", routineId: r.id, skipKanbanCard: true });
          // Set last_status to "running" optimistically; markRoutineFired updates next_run_ts
          markRoutineFired(r.id, "running");
        } catch (e) {
          console.error(`[routines] failed to fire ${r.id}:`, e);
          markRoutineFired(r.id, "failed");
        }
      }
    } catch (e) {
      console.error("[routines] tick error:", e);
    }
  };

  const interval = setInterval(tick, TICK_MS);
  tick(); // run immediately on startup

  // When a mission spawned by a routine finishes:
  //   1. update its last_status
  //   2. deliver output to notify_channel if configured (e.g. ping → telegram)
  const unsubMissions = registry.onMissionComplete((info) => {
    try {
      const row = getDb().prepare(`SELECT routine_id FROM missions WHERE id = ?`).get(info.missionId) as { routine_id: string | null } | undefined;
      if (!row?.routine_id) return;
      getDb().prepare(`UPDATE routines SET last_status = ? WHERE id = ?`).run(info.status, row.routine_id);

      const routine = getRoutine(row.routine_id);
      if (routine) {
        void deliverRoutineNotification(routine, info).catch((e) =>
          console.error(`[routines] notify failed for ${routine.id}:`, e)
        );
      }
    } catch (e) {
      console.error("[routines] completion hook error:", e);
    }
  });

  g.__mosRoutineSched = { interval, unsubMissions };
  return true;
}

export function stopScheduler(): void {
  if (!g.__mosRoutineSched) return;
  clearInterval(g.__mosRoutineSched.interval);
  g.__mosRoutineSched.unsubMissions?.();
  delete g.__mosRoutineSched;
}

/**
 * Sends a routine's output to its configured notify channel.
 * Skips silently if notify_on doesn't match the status.
 *   notify_on = "always"  → every run
 *   notify_on = "failure" → only failed/halted runs
 *   notify_on = "never"   → noop
 */
async function deliverRoutineNotification(
  routine: RoutineRow,
  info: { missionId: string; status: "done" | "failed" | "halted" },
): Promise<void> {
  if (routine.notify_on === "never" || !routine.notify_channel) return;
  if (routine.notify_on === "failure" && info.status === "done") return;

  const config = tryLoadChannelConfig(routine.notify_channel);
  if (!config) {
    console.warn(`[routines] ${routine.id}: notify_channel "${routine.notify_channel}" not found`);
    return;
  }

  const output = buildMissionOutput(info.missionId) || `(routine ${routine.id} ${info.status} with no text output)`;
  const prefix = info.status === "done"
    ? `⏰ *${routine.name}*\n`
    : `🚨 *${routine.name}* — ${info.status.toUpperCase()}\n`;
  const body = prefix + output;

  if (config.type === "telegram") {
    // Resolve recipients:
    //   - if target_chat_ids is set on the routine → use that explicit list
    //   - otherwise → broadcast to all known channel subscribers
    let recipients: number[] = [];
    if (routine.target_chat_ids) {
      try {
        const parsed = JSON.parse(routine.target_chat_ids) as unknown;
        if (Array.isArray(parsed)) {
          recipients = parsed.map(Number).filter((n) => Number.isFinite(n));
        } else if (typeof parsed === "number" && Number.isFinite(parsed)) {
          // legacy/agent-inserted form: a bare number instead of [number]
          recipients = [parsed];
        }
      } catch {
        // not JSON: try comma-separated or single-number string
        const fallback = String(routine.target_chat_ids)
          .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        recipients = fallback;
      }
    } else {
      recipients = listSubscribers(routine.notify_channel).map((s) => s.chat_id);
    }
    if (recipients.length === 0) {
      console.warn(`[routines] ${routine.id}: no telegram recipients — send any message to the bot first to register your chat_id, or set target_chat_ids on the routine`);
      return;
    }
    for (const chatId of recipients) {
      try {
        await sendTelegramMessage(config, chatId, body);
      } catch (e) {
        console.error(`[routines] failed to send to chat ${chatId}:`, e);
      }
    }
    return;
  }

  // Other channel types (discord, imessage, webhook) — not implemented yet for routine delivery
  console.warn(`[routines] ${routine.id}: delivery to ${config.type} channels not implemented`);
}
