// ─── Core types ──────────────────────────────────────────────────────────────

export interface AgentRole {
  label: string;
  color: string;
}

export type AgentStatus = "active" | "waiting" | "idle" | "err";
export type PermissionMode = "auto" | "acceptEdits" | "plan" | "bypassPermissions";
export type MissionStatus = "pending" | "running" | "done" | "failed" | "halted";
export type EventLevel = "info" | "ok" | "warn" | "err" | "tool";

export interface Agent {
  id: string;
  name: string;
  glyph: string;
  role: keyof typeof AGENT_ROLES;
  status: AgentStatus;
  task: string;
  progress: number;
  tokens: number;
  cost: number;
  runtime: string;
  model: string;
  tools: string[];
  pos?: { x: number; y: number };
  pinned?: boolean;
  source?: "orchestria" | "skill" | "agent";
}

export interface Edge {
  source: string;
  target: string;
  weight: number;
}

export type MemoryScope = "NONE" | "SESSION" | "USER" | "GLOBAL";

export interface AgentConfig {
  id: string;
  name: string;
  /** Single-character display glyph shown on cards / mesh nodes */
  glyph?: string;
  model: string;
  /** Which AI CLI backs this agent (defaults to "claude"). */
  provider?: "claude" | "openai";
  permissionMode: PermissionMode;
  systemPrompt: string;
  cwd: string;
  allowedTools: string[];
  deniedTools?: string[];
  planMax?: boolean;
  channels: Record<string, { on: boolean; value: string }>;
  remote?: { on: boolean; url: string };
  missions: number;
  parent?: string;
  /** Where this agent comes from */
  source?: "orchestria" | "skill" | "agent";
  /** Memory persistence policy */
  memoryScope?: MemoryScope;
  /** Skills attached to this agent (invoked via /skill-id prefix) */
  skills?: string[];
}

export interface Mission {
  id: string;
  agentId: string;
  title: string;
  status: MissionStatus;
  domain: "engineering" | "writing" | "research" | "ops" | "product" | "life";
  start: string;
  duration: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export interface MissionEvent {
  ts: string;
  type: string;
  kind: "start" | "ok" | "warn" | "err" | "tool" | "end";
  body: string;
}

export interface KanbanCard {
  id: string;
  title: string;
  agent: string;
  col: "backlog" | "todo" | "doing" | "done";
  domain: string;
  costUsd: number | null;
  progress?: number;
  eta?: string;
  due?: string;
  dueSoon?: boolean;
  tags: string[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: "dev" | "content" | "ops" | "life";
  source: "built-in" | "custom";
  invocations30d: number;
  agents: string[];
  enabled: boolean;
  code?: string;
  sparkData: number[];
}

export interface StreamEvent {
  id: number;
  ts: string;
  lvl: EventLevel;
  agent: string;
  parts: string[];
  boot?: boolean;
}

export interface MemoryFile {
  name: string;
  size: string;
  tokens: number;
  kind: "md" | "jsonl";
  dirty?: boolean;
  body?: string;
}

export interface ChatMessage {
  id: number;
  who: "user" | "agent";
  time: string;
  text?: string;
  blocks?: Array<
    | { type: "p";    text: string }
    | { type: "ul";   items: string[] }
    | { type: "code"; lang: string; code: string }
    | { type: "tool"; name: string; args: string; ms: number }
  >;
}

// ─── Design tokens ───────────────────────────────────────────────────────────

export const AGENT_ROLES: Record<string, AgentRole> = {
  orchestrator: { label: "Orchestrator", color: "#E07A5F" },
  retriever:    { label: "Retriever",    color: "#7ec5ff" },
  reasoner:     { label: "Reasoner",     color: "#c89cff" },
  executor:     { label: "Executor",     color: "#8be38b" },
  sentinel:     { label: "Sentinel",     color: "#e6b85c" },
  scribe:       { label: "Scribe",       color: "#9a9a93" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export type AgentLiveState = Agent;

export function fmtTs(deltaSec: number): string {
  const t = Math.floor(Date.now() / 1000) + deltaSec;
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function makeEvent(id: number, agentId?: string): StreamEvent {
  return {
    id,
    ts: fmtTs(0),
    lvl: "info",
    agent: agentId ?? "kernel",
    parts: ["heartbeat"],
  };
}

// ─── Empty seeds (populate via runtime, not statically) ──────────────────────

export const AGENTS: Agent[] = [];
export const EDGES: [string, string, number][] = [];
export const SEED_EVENTS: StreamEvent[] = [];
export const MOCK_AGENT_CONFIGS: AgentConfig[] = [];
export const MOCK_MISSIONS: Mission[] = [];
export const MOCK_EVENTS: Record<string, MissionEvent[]> = {};
export const MOCK_KANBAN: KanbanCard[] = [];
export const MOCK_SKILLS: Skill[] = [];
export const MOCK_RADAR_DATA: { domain: string; spend: number; missions: number; tokens: number }[] = [];
export const MOCK_DAILY_TOKENS: { day: string; tokensIn: number; tokensOut: number; spendAi: number; spendEx: number }[] = [];
export const MOCK_AGENTS_DASHBOARD: { id: string; glyph: string; role: string; load: number; missions: number }[] = [];
export const MOCK_MEMORY_AGENTS: { id: string; glyph: string; name: string; tokens: number }[] = [];
export const MOCK_MEMORY_FILES: Record<string, MemoryFile[]> = {};
export const MOCK_CHAT_SEEDS: Record<string, ChatMessage[]> = {};
