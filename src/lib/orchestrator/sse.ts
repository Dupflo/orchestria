import type { ClaudeEvent } from "./types";

type Listener = (event: ClaudeEvent) => void;
type GlobalListener = (info: { missionId: string; agentId: string; event: ClaudeEvent }) => void;

interface BroadcastRecord {
  missionId: string;
  agentId: string;
  event: ClaudeEvent;
  ts: number;
}

/**
 * In-memory ring buffer of recent broadcasts so that a client opening the
 * visualizer mid-stream gets a snapshot of the last activity instead of an
 * empty mesh. Memory-only — a server restart wipes it; the canonical record
 * for past events lives in the `events` SQLite table.
 */
const MAX_RECENT = 200;

const g = globalThis as {
  __mosSseListeners?: Map<string, Set<Listener>>;
  __mosSseGlobalListeners?: Set<GlobalListener>;
  __mosSseRecent?: BroadcastRecord[];
};
const listeners = (g.__mosSseListeners ??= new Map());
const globalListeners = (g.__mosSseGlobalListeners ??= new Set());
const recent = (g.__mosSseRecent ??= []);

export function sseSubscribe(missionId: string, listener: Listener): () => void {
  let set = listeners.get(missionId);
  if (!set) {
    set = new Set();
    listeners.set(missionId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(missionId);
  };
}

export function sseSubscribeGlobal(listener: GlobalListener): () => void {
  globalListeners.add(listener);
  return () => { globalListeners.delete(listener); };
}

export function sseBroadcast(missionId: string, event: ClaudeEvent, agentId = ""): void {
  const set = listeners.get(missionId);
  if (set) for (const l of set) l(event);
  for (const l of globalListeners) l({ missionId, agentId, event });
  recent.push({ missionId, agentId, event, ts: Date.now() });
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
}

/** Snapshot of the recent-broadcast buffer (oldest first). */
export function sseRecentBroadcasts(): BroadcastRecord[] {
  return recent.slice();
}

/** Drop everything from the ring buffer (exposed via POST /api/live/clear). */
export function sseClearRecent(): void {
  recent.length = 0;
}
