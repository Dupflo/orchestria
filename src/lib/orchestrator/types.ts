export type PermissionMode = "auto" | "acceptEdits" | "plan" | "bypassPermissions";

export type LiveStatus = "running" | "completed" | "failed" | "halted";

export type MemoryScope = "NONE" | "SESSION" | "USER" | "GLOBAL";

/** Which AI CLI backs an agent. `claude` drives `claude`, `openai` drives `codex`. */
export type ProviderId = "claude" | "openai";

export interface AgentFileConfig {
  cwd: string;
  model: string;
  /** Always resolved by loadAgentConfig (defaults to "claude"). */
  provider: ProviderId;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
  parent?: string;
  memoryScope?: MemoryScope;
}

/**
 * Normalized agent event. Named for historical reasons — it is the common
 * shape every provider's CLI output is parsed into, not Claude-specific.
 */
export interface ClaudeEvent {
  type: string;
  timestamp: number;
  payload: unknown;
}

export interface SpawnRequest {
  agent_name: string;
  mission: string;
  /** Board and other UIs that already have a kanban row should set this so spawn does not INSERT a second card. */
  skip_kanban_card?: boolean;
}

export interface SendRequest {
  input: string;
}
