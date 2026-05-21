import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { safeJson } from "@/lib/api/json";
import { removeConversationEntries, clearAllConversations } from "@/lib/memory/autorecord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MissionRow {
  id: string;
  title: string;
  start_ts: number;
  end_ts: number | null;
  status: string;
  claude_session_id: string | null;
  kind: string;
  source_channel: string | null;
}

interface EventRow {
  ts: number;
  kind: string;
  body: string;
}

interface ChatMessage {
  id: string;
  who: "user" | "agent";
  text: string;
  ts: number;
  missionId: string;
  status: string;
  sourceChannel?: string | null;
  kind?: string;
}

function extractAssistantText(events: EventRow[]): string {
  // First pass — prefer the canonical "this is the final answer" event each
  // provider emits, scanned newest-first:
  //   Claude: kind === "result" with payload.result
  //   Codex:  kind === "item.completed" with item.type === "agent_message"
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "result") {
      const p = safeJson<{ result?: string }>(e.body, {});
      if (typeof p.result === "string") return p.result;
    }
    if (e.kind === "item.completed") {
      const p = safeJson<{ item?: { type?: string; text?: string; content?: string } }>(e.body, {});
      const item = p.item;
      if (item && (item.type === "agent_message" || item.type === "assistant_message")) {
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
      }
    }
  }
  // Fallback — stitch streamed chunks (Claude `assistant` events) or flat
  // `agent_message` events that some Codex builds emit at the top level.
  const parts: string[] = [];
  for (const e of events) {
    if (e.kind === "assistant") {
      const p = safeJson<{ message?: { content?: Array<{ type?: string; text?: string }> } }>(e.body, {});
      const content = p.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        }
      }
      continue;
    }
    if (e.kind === "agent_message" || e.kind === "assistant_message") {
      const p = safeJson<{ text?: string; content?: string }>(e.body, {});
      if (typeof p.text === "string") parts.push(p.text);
      else if (typeof p.content === "string") parts.push(p.content);
    }
  }
  return parts.join("");
}

export async function GET(req: Request, { params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  const db = getDb();
  const { searchParams } = new URL(req.url);
  const explicitSession = searchParams.get("session_id");

  // Session resolution :
  // - Explicit `?session_id=X` → load that historical session (chat-only, no channel mix)
  // - Otherwise → latest chat session (default behavior, mixed with channel log)
  let sessionId: string | null = null;
  if (explicitSession) {
    sessionId = explicitSession;
  } else {
    const latest = db
      .prepare(
        `SELECT claude_session_id FROM missions
         WHERE agent_id = ? AND claude_session_id IS NOT NULL AND kind = 'chat'
         ORDER BY start_ts DESC LIMIT 1`
      )
      .get(agent) as { claude_session_id: string } | undefined;
    sessionId = latest?.claude_session_id ?? null;
  }

  // Pull missions :
  // - When viewing a specific (historical) session → only chat messages from that session
  // - When viewing the current/latest session → chat from that session + all channel messages
  //   + recent standalone missions that have output (proactive agent writes)
  const missions = explicitSession
    ? db.prepare(
        `SELECT id, title, start_ts, end_ts, status, claude_session_id, kind, source_channel
         FROM missions
         WHERE agent_id = ? AND kind = 'chat' AND claude_session_id = ?
         ORDER BY start_ts ASC`
      ).all(agent, sessionId) as MissionRow[]
    : db.prepare(
        `SELECT id, title, start_ts, end_ts, status, claude_session_id, kind, source_channel
         FROM missions
         WHERE agent_id = ?
           AND (
             (kind = 'chat' AND claude_session_id = ?)
             OR kind = 'channel'
             OR (kind = 'mission' AND end_ts IS NOT NULL AND start_ts >= strftime('%s','now','-7 days'))
           )
         ORDER BY start_ts ASC`
      ).all(agent, sessionId ?? "__no_session__") as MissionRow[];

  const messages: ChatMessage[] = [];
  for (const m of missions) {
    messages.push({
      id: `u_${m.id}`,
      who: "user",
      text: m.title,
      ts: m.start_ts,
      missionId: m.id,
      status: m.status,
      sourceChannel: m.source_channel,
      kind: m.kind,
    });
    const events = db
      .prepare("SELECT ts, kind, body FROM events WHERE mission_id = ? ORDER BY id ASC")
      .all(m.id) as EventRow[];
    const text = extractAssistantText(events);
    if (text) {
      messages.push({
        id: `a_${m.id}`,
        who: "agent",
        text,
        ts: m.end_ts ?? m.start_ts,
        missionId: m.id,
        status: m.status,
        sourceChannel: m.source_channel,
        kind: m.kind,
      });
    }
  }

  return NextResponse.json({ sessionId, messages });
}

/**
 * DELETE behaviour :
 *   (no query)        → no-op (kept for "+ New chat" pattern, frontend reset only)
 *   ?all=1            → wipe ALL chat history for this agent (missions + events).
 *                       Channel missions stay intact (séparate audit trail).
 *   ?session_id=X     → wipe one specific session (missions + events) for this agent.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  const { searchParams } = new URL(req.url);
  const wipeAll = searchParams.get("all") === "1";
  const wipeSession = searchParams.get("session_id");
  const db = getDb();

  if (wipeAll) {
    // Effacer toutes les missions chat + channel pour cet agent
    const rows = db.prepare(
      `SELECT id FROM missions WHERE agent_id = ? AND kind IN ('chat', 'channel')`
    ).all(agent) as { id: string }[];
    const ids = rows.map((r) => r.id);
    const delEvents = db.prepare(`DELETE FROM events WHERE mission_id = ?`);
    const delMission = db.prepare(`DELETE FROM missions WHERE id = ?`);
    db.transaction(() => {
      for (const id of ids) { delEvents.run(id); delMission.run(id); }
    })();
    try { clearAllConversations(agent); } catch (e) { console.warn("[chat] clearAllConversations failed", e); }
    return NextResponse.json({ ok: true, deleted: ids.length });
  }

  if (wipeSession) {
    const rows = db.prepare(
      `SELECT id FROM missions
       WHERE agent_id = ? AND kind = 'chat' AND claude_session_id = ?`
    ).all(agent, wipeSession) as { id: string }[];
    const ids = rows.map((r) => r.id);
    const delEvents = db.prepare(`DELETE FROM events WHERE mission_id = ?`);
    const delMission = db.prepare(`DELETE FROM missions WHERE id = ?`);
    db.transaction(() => {
      for (const id of ids) { delEvents.run(id); delMission.run(id); }
    })();
    // Remove matching blocks from conversations.md (USER + GLOBAL)
    try { removeConversationEntries(agent, ids); } catch (e) { console.warn("[chat] removeConversationEntries failed", e); }
    return NextResponse.json({ ok: true, deleted: ids.length });
  }

  // No-op : just a frontend "+ New chat" reset
  return NextResponse.json({ ok: true, deleted: 0 });
}
