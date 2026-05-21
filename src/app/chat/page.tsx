"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentConfig } from "@/lib/mock-data";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatBubble {
  id: string;
  who: "user" | "agent" | "system";
  text: string;
  ts: number;
  missionId?: string;
  status?: string;
  streaming?: boolean;
  sourceChannel?: string | null;
  kind?: string;
}

interface SseEvent {
  type: string;
  timestamp: number;
  payload: unknown;
}

interface HistoryResponse {
  sessionId: string | null;
  messages: {
    id: string;
    who: "user" | "agent";
    text: string;
    ts: number;
    missionId: string;
    status: string;
    sourceChannel?: string | null;
    kind?: string;
  }[];
}

interface SessionSummary {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  firstTitle: string;
}

type ChatMode = "question" | "mission" | "routine";

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractStreamingText(ev: SseEvent): string | null {
  // ── Claude CLI shapes ────────────────────────────────────────────────────
  if (ev.type === "result") {
    const p = ev.payload as { result?: string };
    if (typeof p.result === "string") return p.result;
  }
  if (ev.type === "assistant") {
    const p = ev.payload as { message?: { content?: Array<{ type?: string; text?: string }> } };
    const content = p.message?.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
      }
      if (parts.length) return parts.join("");
    }
  }
  // ── Codex CLI shapes (`codex exec --json`) ───────────────────────────────
  // Streamed agent messages arrive as item.updated (partial) and item.completed
  // (final), each carrying the *cumulative* text under `item.text`. Command
  // executions also flow through these event types — gate on item.type so we
  // don't overwrite the bubble with shell output.
  if (ev.type === "item.updated" || ev.type === "item.completed") {
    const p = ev.payload as { item?: { type?: string; text?: string; content?: string } };
    const item = p.item;
    if (item && (item.type === "agent_message" || item.type === "assistant_message")) {
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
    }
  }
  // Some Codex builds emit a flat `agent_message` event with text at top level.
  if (ev.type === "agent_message" || ev.type === "assistant_message") {
    const p = ev.payload as { text?: string; content?: string };
    if (typeof p.text === "string") return p.text;
    if (typeof p.content === "string") return p.content;
  }
  return null;
}

function fmtTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return d.toTimeString().slice(0, 5);
}

function fmtRelative(epochSec: number): string {
  const delta = Math.floor(Date.now() / 1000) - epochSec;
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function fmtDay(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  if (isToday) return `Today · ${day}`;
  if (isYest) return `Yesterday · ${day}`;
  return day;
}

const ICON_SEND = (
  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
    <path d="M3 10l14-6-5 14-3-6-6-2z" />
  </svg>
);
const ICON_STOP = (
  <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <rect x="5" y="5" width="10" height="10" rx="1" />
  </svg>
);
const ICON_EDIT = (
  <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 4l3 3-9 9H4v-3l9-9z" />
  </svg>
);

// ─── Components ─────────────────────────────────────────────────────────────

function Bubble({ m }: { m: ChatBubble }) {
  const isUser = m.who === "user";
  const isSystem = m.who === "system";
  const isMission = m.kind === "mission";

  return (
    <div className={`msg-wrap ${isUser ? "user" : "agent"}`}>
      <div className="msg-col">
        {isMission && m.who === "user" && (
          <div style={{
            fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-mono, monospace)",
            marginBottom: 2, display: "flex", alignItems: "center", gap: 6,
            justifyContent: "flex-end",
          }}>
            <span style={{ background: "var(--warn-soft)", color: "var(--warn)", padding: "1px 6px", borderRadius: 3, fontSize: 9, letterSpacing: "0.05em" }}>MISSION</span>
            {m.missionId && (
              <a href={`/missions?id=${m.missionId}`} style={{ color: "var(--accent)", textDecoration: "none", fontSize: 9 }}>
                view log →
              </a>
            )}
          </div>
        )}
        {isMission && m.who === "agent" && m.missionId && (
          <div style={{
            fontSize: 9, color: "var(--text-faint)", fontFamily: "var(--font-mono, monospace)",
            marginBottom: 2,
          }}>
            <a href={`/missions?id=${m.missionId}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
              ↗ view full log
            </a>
          </div>
        )}
        <div className={`bubble ${isUser ? "user" : isSystem ? "system" : "agent"}`}>
          {isUser || isSystem ? (
            m.text || (m.streaming ? "…" : "")
          ) : (
            <>
              {m.text ? (
                <div className="chat-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                </div>
              ) : m.streaming ? (
                <span style={{ opacity: 0.5 }}>…</span>
              ) : null}
              {m.streaming && m.text && <span className="cursor">▍</span>}
            </>
          )}
        </div>
        <div className="msg-meta">
          {isUser ? (
            <>
              {m.sourceChannel && <span className="via">via {m.sourceChannel}</span>}
              <span className="time mono">{fmtTime(m.ts)}</span>
              <span className="who user">you</span>
            </>
          ) : (
            <>
              <span className="who">{isSystem ? "system" : "agent"}</span>
              <span className="time mono">· {fmtTime(m.ts)}</span>
              {m.sourceChannel && <span className="via">via {m.sourceChannel}</span>}
              {isMission && m.missionId && (
                <a href={`/missions?id=${m.missionId}`}
                  style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: 6, textDecoration: "none" }}>
                  log
                </a>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Thinking({ step }: { step: string }) {
  return (
    <div className="msg-wrap agent">
      <div className="msg-col">
        <div className="thinking">
          <span className="dots"><span /><span /><span /></span>
          <span>agent thinking</span>
          <span className="step">— {step}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

function ChatPageContent() {
  const sp = useSearchParams();
  const router = useRouter();
  const agentId = sp.get("agent");

  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [viewSession, setViewSession] = useState<string | null>(null); // null = latest
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [input, setInput] = useState("");
  // Per-agent in-flight tracking so a running mission on agent A does not
  // freeze the chat input for every other agent (the symptom was "I have to
  // refresh to talk to someone else").
  const [busyAgents, setBusyAgents] = useState<Set<string>>(new Set());
  const [thinkingByAgent, setThinkingByAgent] = useState<Map<string, string>>(new Map());
  // Mission id currently running for each agent — kept across agent switches
  // so the stop button can still target it when the user navigates back.
  const [runningByAgent, setRunningByAgent] = useState<Map<string, string>>(new Map());
  const busy = agentId ? busyAgents.has(agentId) : false;
  const thinkingStep = agentId ? thinkingByAgent.get(agentId) ?? null : null;
  const runningMissionId = agentId ? runningByAgent.get(agentId) ?? null : null;
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [mode, setMode] = useState<ChatMode>("question");
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // One EventSource per in-flight chat mission so switching agents does not
  // tear down the stream that still needs to update the originating bubble.
  const ssesRef = useRef<Map<string, EventSource>>(new Map());
  // Latest viewed agentId, read from SSE callbacks (closure-captured values
  // would be stale once the user navigates).
  const agentIdRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { agentIdRef.current = agentId; }, [agentId]);

  const markBusy = (aid: string, b: boolean) => {
    setBusyAgents((prev) => {
      if (b ? prev.has(aid) : !prev.has(aid)) return prev;
      const next = new Set(prev);
      if (b) next.add(aid); else next.delete(aid);
      return next;
    });
  };
  const setThinkingFor = (aid: string, step: string | null) => {
    setThinkingByAgent((prev) => {
      const cur = prev.get(aid) ?? null;
      if (cur === step) return prev;
      const next = new Map(prev);
      if (step === null) next.delete(aid); else next.set(aid, step);
      return next;
    });
  };
  const setRunningFor = (aid: string, mid: string | null) => {
    setRunningByAgent((prev) => {
      const cur = prev.get(aid) ?? null;
      if (cur === mid) return prev;
      const next = new Map(prev);
      if (mid === null) next.delete(aid); else next.set(aid, mid);
      return next;
    });
  };

  const haltCurrent = async () => {
    if (!runningMissionId) return;
    await fetch(`/api/missions/${runningMissionId}/halt`, { method: "POST" })
      .catch(() => { /* server will still emit MissionComplete on its own */ });
    // No optimistic UI cleanup — the SSE handler clears busy/thinking when
    // MissionComplete arrives from the killed PTY, which is the single source
    // of truth for "this mission is over".
  };

  // load agents
  useEffect(() => {
    fetch("/api/agents?native=1")
      .then((r) => r.json())
      .then((data: AgentConfig[]) => {
        setAgents(data);
        const firstMos = data.find((a) => a.source === "orchestria" || !a.source);
        if (!agentId && firstMos) {
          router.replace(`/chat?agent=${encodeURIComponent(firstMos.id)}`);
        }
      });
  }, [agentId, router]);

  // load history when agent or selected session changes
  const reloadHistory = (silent = false) => {
    if (!agentId) return;
    if (!silent) setLoadingHistory(true);
    const url = viewSession
      ? `/api/chat/${encodeURIComponent(agentId)}?session_id=${encodeURIComponent(viewSession)}`
      : `/api/chat/${encodeURIComponent(agentId)}`;
    return fetch(url)
      .then((r) => r.json())
      .then((data: HistoryResponse) => {
        setSessionId(data.sessionId);
        setMessages((prev) => {
          const streaming = prev.filter((m) => m.streaming);
          const fresh = data.messages.map((m) => ({ ...m } as ChatBubble));
          const freshIds = new Set(fresh.map((m) => m.missionId).filter(Boolean));
          const kept = streaming.filter((m) => !m.missionId || !freshIds.has(m.missionId));
          return [...fresh, ...kept];
        });
      })
      .finally(() => { if (!silent) setLoadingHistory(false); });
  };

  const reloadSessions = () => {
    if (!agentId) return;
    fetch(`/api/chat/${encodeURIComponent(agentId)}/sessions`)
      .then((r) => r.json())
      .then((data: SessionSummary[]) => setSessions(data))
      .catch(() => setSessions([]));
  };

  useEffect(() => {
    if (!agentId) return;
    setMessages([]);
    setSessionId(null);
    setViewSession(null);
    setSessionMenuOpen(false);
    // Intentionally NOT closing in-flight EventSources here — missions for
    // other agents keep streaming so their final result lands when the user
    // navigates back to them.
    reloadHistory();
    reloadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Reload history when the viewed session changes
  useEffect(() => {
    if (!agentId) return;
    reloadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewSession]);

  // auto-scroll to bottom on new messages
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, busy, thinkingStep]);

  useEffect(() => () => {
    for (const es of ssesRef.current.values()) es.close();
    ssesRef.current.clear();
  }, []);

  // close session menu on outside click / Escape
  useEffect(() => {
    if (!sessionMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!(t instanceof Element)) return;
      if (t.closest(".session-menu") || t.closest(".session-pill")) return;
      setSessionMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSessionMenuOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [sessionMenuOpen]);

  // live stream: pick up channel-spawned missions for the current agent
  useEffect(() => {
    if (!agentId) return;
    const es = new EventSource("/api/live/stream");
    let pending: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; reloadHistory(true); }, 500);
    };
    es.onmessage = (msg) => {
      try {
        const { agentId: a } = JSON.parse(msg.data) as { agentId?: string };
        if (a === agentId) scheduleReload();
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* auto-reconnect */ };
    return () => { es.close(); if (pending) clearTimeout(pending); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // One SSE per running mission. `forAgentId` is the agent that owns the
  // mission — kept around so callbacks can update only that agent's state
  // (busy / thinking / sessionId) even after the user navigates elsewhere.
  const attachSse = (mid: string, agentBubbleId: string, forAgentId: string) => {
    const es = new EventSource(`/api/missions/${mid}/stream`);
    ssesRef.current.set(mid, es);
    setRunningFor(forAgentId, mid);
    let lastResultText: string | null = null;
    setThinkingFor(forAgentId, "loading context");
    es.onmessage = (msg) => {
      const ev = JSON.parse(msg.data) as SseEvent;
      const isCurrent = agentIdRef.current === forAgentId;
      // Session id lives under different keys across providers — `session_id`
      // for Claude, `thread_id` for Codex. Try the common ones.
      const p = ev.payload as { session_id?: string; thread_id?: string; conversation_id?: string } | null;
      const sid = p?.session_id ?? p?.thread_id ?? p?.conversation_id ?? null;
      // Only touch the shared sessionId when the user is viewing this agent —
      // otherwise we'd overwrite another agent's session pill.
      if (isCurrent && typeof sid === "string" && sid) {
        setSessionId((prev) => prev ?? sid);
      }

      if (ev.type === "system") setThinkingFor(forAgentId, "loading context");
      else if (ev.type === "tool_use" || ev.type === "tool_result") setThinkingFor(forAgentId, "running tool");
      else if (ev.type === "assistant") setThinkingFor(forAgentId, "drafting response");
      // Codex CLI emits its own type taxonomy — give the user the same kind
      // of progress signal instead of leaving the indicator stuck at the
      // initial "loading context" until MissionComplete fires.
      else if (ev.type === "thread.started" || ev.type === "turn.started") setThinkingFor(forAgentId, "loading context");
      else if (ev.type === "item.started" || ev.type === "tool_call") setThinkingFor(forAgentId, "running tool");
      else if (ev.type === "item.completed" || ev.type === "turn.completed" || ev.type === "agent_message") setThinkingFor(forAgentId, "drafting response");

      if (ev.type === "MissionComplete") {
        // The bubble only exists in `messages` when the user is viewing
        // `forAgentId`; if they navigated away, this map is a no-op (the
        // persisted result will be picked up by reloadHistory on return).
        const cp = ev.payload as { status?: string; exitCode?: number } | null;
        const finalStatus = cp?.status === "failed" ? "failed" : "done";
        setMessages((prev) => prev.map((m) => {
          if (m.id !== agentBubbleId) return m;
          // If we never captured any agent text but the mission ended,
          // surface a hint pointing at /missions — otherwise the bubble
          // would be silently empty (common with a CLI that errored out
          // before emitting any structured event, e.g. unknown codex flag).
          const text = lastResultText ?? m.text;
          const filled = text || (finalStatus === "failed"
            ? `_⚠ Mission failed (exit ${cp?.exitCode ?? "?"}). The CLI produced no agent output — open this mission in /missions to see the raw stderr._`
            : text);
          return { ...m, text: filled, streaming: false, status: finalStatus };
        }));
        markBusy(forAgentId, false);
        setThinkingFor(forAgentId, null);
        setRunningFor(forAgentId, null);
        if (isCurrent) reloadSessions();
        es.close();
        ssesRef.current.delete(mid);
        return;
      }

      const text = extractStreamingText(ev);
      if (!text) return;
      lastResultText = text;
      setMessages((prev) => prev.map((m) =>
        m.id === agentBubbleId ? { ...m, text, streaming: true } : m
      ));
    };
    es.onerror = () => { /* keep alive */ };
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !agentId || busyAgents.has(agentId)) return;
    // Pin the originating agent so an in-flight navigation does not redirect
    // the busy/thinking state onto another agent.
    const forAgentId = agentId;
    markBusy(forAgentId, true);
    setInput("");
    setThinkingFor(forAgentId, "routing intent");

    const tempUserId = `u_tmp_${Date.now()}`;
    const tempAgentId = `a_tmp_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempUserId, who: "user", text, ts: Date.now() / 1000 },
      { id: tempAgentId, who: "agent", text: "", ts: Date.now() / 1000, streaming: true },
    ]);

    const res = await fetch("/api/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: forAgentId,
        mission: text,
        // Resume the session currently in view (historic or latest). null when viewer is in "new chat".
        resume_session_id: viewSession ?? sessionId ?? undefined,
        kind: "chat",
        mode, // backend may ignore; sent for future use
      }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string; hint?: string } | null;
      const errText = [
        `Spawn failed (HTTP ${res.status})`,
        err?.error ? `→ ${err.error}` : null,
        err?.hint ? `\n💡 ${err.hint}` : null,
      ].filter(Boolean).join("\n");
      setMessages((prev) => prev
        .filter((m) => m.id !== tempAgentId)
        .concat({ id: `s_${Date.now()}`, who: "system", text: errText, ts: Date.now() / 1000 }));
      markBusy(forAgentId, false);
      setThinkingFor(forAgentId, null);
      return;
    }
    const json = (await res.json()) as { mission_id: string };
    setMessages((prev) => prev.map((m) =>
      m.id === tempAgentId ? { ...m, missionId: json.mission_id } : m
    ));
    attachSse(json.mission_id, tempAgentId, forAgentId);
  };

  const switchAgent = (id: string) => {
    router.push(`/chat?agent=${encodeURIComponent(id)}`);
  };

  const newChat = () => {
    // Pure frontend reset — past sessions remain browsable via the session picker.
    setViewSession(null);
    setSessionId(null);
    setMessages([]);
    setSessionMenuOpen(false);
  };

  const openSession = (sid: string) => {
    setViewSession(sid);
    setSessionMenuOpen(false);
  };

  const deleteSession = async (sid: string) => {
    if (!agentId) return;
    if (!confirm("Supprimer définitivement cette session ?\nToutes les missions et events liés seront effacés.")) return;
    await fetch(`/api/chat/${encodeURIComponent(agentId)}?session_id=${encodeURIComponent(sid)}`, { method: "DELETE" });
    if (viewSession === sid) setViewSession(null);
    if (sessionId === sid) { setSessionId(null); setMessages([]); }
    reloadSessions();
    reloadHistory(true);
  };

  const resetAllChat = async () => {
    if (!agentId) return;
    if (!confirm(`Supprimer TOUT l'historique de chat de ${agentId} ?\nCela efface définitivement toutes les conversations et events.\nLes missions canal (Telegram/iMessage) ne sont pas touchées.`)) return;
    await fetch(`/api/chat/${encodeURIComponent(agentId)}?all=1`, { method: "DELETE" });
    setViewSession(null); setSessionId(null); setMessages([]);
    setSessionMenuOpen(false);
    reloadSessions();
    reloadHistory(true);
  };

  const currentAgent = agents.find((a) => a.id === agentId);

  // ── stats (session totals) ───────────────────────────────────────────────
  const totals = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    for (const m of messages) {
      if (m.text) tokens += Math.ceil(m.text.length / 3.5);
    }
    cost = (tokens / 1000) * 0.003;
    return { tokens, cost };
  }, [messages]);

  // ── slash-command skill autocomplete ─────────────────────────────────────
  const skills = agents.filter((a) => a.source === "skill");
  const slashSuggestions = slashQuery === null ? [] : skills
    .filter((s) =>
      slashQuery === "" ||
      s.name.toLowerCase().includes(slashQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(slashQuery.toLowerCase())
    )
    .slice(0, 8);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    // auto-resize
    e.target.style.height = "auto";
    e.target.style.height = Math.min(200, e.target.scrollHeight) + "px";
    // slash detection
    const cursor = e.target.selectionStart ?? val.length;
    const upToCursor = val.slice(0, cursor);
    const match = upToCursor.match(/(?:^|\s)\/(\S*)$/);
    if (match) { setSlashQuery(match[1]); setSlashIdx(0); }
    else setSlashQuery(null);
  };

  const selectSkill = (skill: AgentConfig) => {
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? input.length;
    const upToCursor = input.slice(0, cursor);
    const match = upToCursor.match(/(?:^|\s)(\/\S*)$/);
    if (match) {
      const start = cursor - match[1].length;
      setInput(input.slice(0, start) + `/${skill.id} ` + input.slice(cursor));
    }
    setSlashQuery(null);
    setTimeout(() => el?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashQuery !== null && slashSuggestions.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashSuggestions.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); selectSkill(slashSuggestions[slashIdx]); return; }
      if (e.key === "Escape") { setSlashQuery(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // ── group messages by day ────────────────────────────────────────────────
  const dayGroups: { day: string; msgs: ChatBubble[] }[] = [];
  for (const m of messages) {
    const day = fmtDay(m.ts);
    if (dayGroups.length === 0 || dayGroups[dayGroups.length - 1].day !== day) {
      dayGroups.push({ day, msgs: [m] });
    } else {
      dayGroups[dayGroups.length - 1].msgs.push(m);
    }
  }

  const mosAgents = agents.filter((a) => a.source === "orchestria" || !a.source);
  const nativeAgents = agents.filter((a) => a.source === "agent");
  const glyph = (currentAgent?.name ?? "?").charAt(0).toUpperCase();
  const modeHint: Record<ChatMode, string> = {
    question: "single Q&A · no side effects",
    mission: "multi-step task · agent owns it until done",
    routine: "scheduled · runs in background",
  };

  return (
    <div className="chat-root">
      {/* ── left agent rail (kept feature) ─────────────────────────────────── */}
      <aside className="chat-rail scroll">
        <div className="group-hd">AGENTS</div>
        {mosAgents.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-faint)", padding: "8px 4px" }}>
            No agents yet.<br />Create one in <code>/agents</code>.
          </div>
        ) : (
          mosAgents.map((a) => (
            <div key={a.id}
              className={`agent-row${a.id === agentId ? " active" : ""}`}
              onClick={() => switchAgent(a.id)}>
              <span className="dot" />
              <span className="nm">{a.name}</span>
            </div>
          ))
        )}

        {nativeAgents.length > 0 && (
          <>
            <div className="group-hd" style={{ color: "var(--ok)" }}>
              CLAUDE AGENTS
              <span className="count">{nativeAgents.length}</span>
            </div>
            {nativeAgents.map((a) => (
              <div key={a.id}
                className={`agent-row native${a.id === agentId ? " active" : ""}`}
                style={{ opacity: 0.85 }}
                onClick={() => switchAgent(a.id)}>
                <span className="dot" />
                <span className="nm">{a.name}</span>
              </div>
            ))}
          </>
        )}
      </aside>

      {/* ── main chat column ──────────────────────────────────────────────── */}
      <div className="chat-col">
        {/* header */}
        <header className="chat-hd">
          <div className="av">
            {glyph}
            <span className="live" />
          </div>
          <div>
            <div className="name-row">
              <h1>{currentAgent?.name ?? "—"}</h1>
              <span className="badge ok"><span className="d" />active</span>
              {currentAgent?.model && (
                <span className="badge mono" style={{ textTransform: "none" }}>
                  {currentAgent.model.replace(/^claude-/, "")}
                </span>
              )}
            </div>
            <div className="role" style={{ position: "relative" }}>
              <button
                className="session-pill"
                onClick={() => setSessionMenuOpen((v) => !v)}
                disabled={sessions.length === 0 && !sessionId}>
                {viewSession
                  ? <>📚 viewing session <span className="mono">{viewSession.slice(0, 8)}…</span></>
                  : sessionId
                    ? <>● session <span className="mono">{sessionId.slice(0, 8)}…</span></>
                    : "no active session"}
                {sessions.length > 0 && <span style={{ marginLeft: 6, opacity: 0.6 }}>▾ {sessions.length}</span>}
              </button>
              {currentAgent?.permissionMode && <span style={{ marginLeft: 6 }}>· {currentAgent.permissionMode}</span>}

              {sessionMenuOpen && (
                <div className="session-menu">
                  <button className="sm-item current" onClick={newChat}>
                    <span className="ic">＋</span>
                    <span className="nm">+ New chat</span>
                    <span className="sub">starts a fresh Claude session on next send</span>
                  </button>
                  {!viewSession && (
                    <div className="sm-section">CURRENT</div>
                  )}
                  {sessions.length > 0 && (
                    <>
                      {viewSession && (
                        <button className="sm-item" onClick={() => { setViewSession(null); setSessionMenuOpen(false); }}>
                          <span className="ic">↩</span>
                          <span className="nm">Back to latest</span>
                        </button>
                      )}
                      <div className="sm-section">PAST SESSIONS · {sessions.length}</div>
                      {sessions.map((s) => {
                        const active = viewSession === s.sessionId || (!viewSession && sessionId === s.sessionId);
                        return (
                          <div key={s.sessionId} className={`sm-row${active ? " on" : ""}`}>
                            <button className="sm-item flex"
                              onClick={() => openSession(s.sessionId)}>
                              <span className="ic mono">{s.sessionId.slice(0, 4)}</span>
                              <span className="nm">{s.firstTitle || "(empty)"}</span>
                              <span className="sub">{s.messageCount} msg · {fmtRelative(s.lastTs)}</span>
                            </button>
                            <button className="sm-del" title="Supprimer cette session"
                              onClick={(e) => { e.stopPropagation(); deleteSession(s.sessionId); }}>×</button>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {sessions.length > 0 && (
                    <>
                      <div className="sm-divider" />
                      <button className="sm-item danger" onClick={resetAllChat}>
                        <span className="ic">⌫</span>
                        <span className="nm">Reset all chat history</span>
                        <span className="sub">irréversible</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="chat-hd-stats">
            <div className="stat-pair">
              <span className="k">tokens</span>
              <span className="v">{totals.tokens.toLocaleString()}</span>
            </div>
            <div className="stat-pair">
              <span className="k">session cost</span>
              <span className="v">${totals.cost.toFixed(2)}</span>
            </div>
            {viewSession && (
              <button className="btn-newchat" onClick={() => { setViewSession(null); }}>
                ← latest
              </button>
            )}
            {!viewSession && sessionId && (
              <button className="btn-newchat" onClick={newChat}>+ New chat</button>
            )}
            {currentAgent && (currentAgent.source === "orchestria" || !currentAgent.source) && (
              <a className="btn btn-ghost btn-sm"
                href={`/agents?id=${encodeURIComponent(currentAgent.id)}`}>
                {ICON_EDIT}<span style={{ marginLeft: 4 }}>Edit config</span>
              </a>
            )}
          </div>
        </header>

        {/* body */}
        <div ref={bodyRef} className="chat-body scroll">
          {loadingHistory ? (
            <div className="empty-state">Loading history…</div>
          ) : messages.length === 0 && !busy ? (
            <div className="empty-state">
              {currentAgent ? `Send a message to ${currentAgent.name}.` : "Select an agent to start chatting."}
            </div>
          ) : (
            dayGroups.map((g, i) => (
              <div key={i}>
                <div className="day-divider">
                  <span className="ln" />
                  <span>{g.day}</span>
                  <span className="ln" />
                </div>
                {g.msgs.map((m) => <Bubble key={m.id} m={m} />)}
              </div>
            ))
          )}
          {busy && thinkingStep && (
            <Thinking step={thinkingStep} />
          )}
          <div ref={bottomRef} />
        </div>

        {/* input */}
        <div className="input-area">
          <div className="input-wrap">
            {slashQuery !== null && slashSuggestions.length > 0 && (
              <div className="slash-popup">
                <div className="hd">
                  <span>SKILLS — {slashSuggestions.length} match{slashSuggestions.length > 1 ? "es" : ""}</span>
                  <span style={{ opacity: 0.5 }}>↑↓ · ↵ select · Esc close</span>
                </div>
                {slashSuggestions.map((s, i) => (
                  <div key={s.id}
                    className={`item${i === slashIdx ? " on" : ""}`}
                    onClick={() => selectSkill(s)}
                    onMouseEnter={() => setSlashIdx(i)}>
                    <div className="top">
                      <span className="badge">skill</span>
                      <span className="nm">{s.name}</span>
                      <span className="id">/{s.id}</span>
                    </div>
                    {s.systemPrompt && <div className="desc">{s.systemPrompt}</div>}
                  </div>
                ))}
              </div>
            )}

            <div className="input-row">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={currentAgent ? `Message ${currentAgent.name}…  (⏎ to send, ⇧⏎ for newline)` : "Pick an agent first"}
                rows={1}
                // Always typeable — only the action button reflects in-flight
                // state. Lets the user compose the next message while a
                // mission is still streaming. `send()` itself guards against
                // double-spawn for the same agent.
                disabled={!currentAgent}
              />
              {busy ? (
                <button
                  className="send-btn"
                  onClick={haltCurrent}
                  disabled={!runningMissionId}
                  title={runningMissionId ? "Stop this mission" : "Starting…"}
                  aria-label="Stop"
                  style={{ background: "var(--err)", color: "#fff", borderColor: "var(--err)" }}>
                  {runningMissionId ? ICON_STOP : <span style={{ opacity: 0.5 }}>…</span>}
                </button>
              ) : (
                <button className="send-btn" onClick={send} disabled={!input.trim() || !currentAgent} aria-label="Send">
                  {ICON_SEND}
                </button>
              )}
            </div>

            <div className="input-footer">
              <div className="mode-tabs">
                {(["question", "mission", "routine"] as ChatMode[]).map((m) => (
                  <div key={m} data-m={m} className={`mt${mode === m ? " on" : ""}`} onClick={() => setMode(m)}>
                    <span className="d" />
                    <span style={{ textTransform: "capitalize" }}>{m}</span>
                  </div>
                ))}
              </div>
              <span className="hint" style={{ marginLeft: 10 }}>{modeHint[mode]}</span>
              <span className="spacer" />
              <span className="hint"><span className="kbd">/</span>skills</span>
              <span className="hint" style={{ marginLeft: 8 }}><span className="kbd">⇧⏎</span>newline</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="chat-root">
          <div className="chat-col" style={{ justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
            <div className="empty-state">Chargement du chat…</div>
          </div>
        </div>
      }
    >
      <ChatPageContent />
    </Suspense>
  );
}
