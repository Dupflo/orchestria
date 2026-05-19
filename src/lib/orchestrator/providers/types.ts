import type { AgentFileConfig, ClaudeEvent, ProviderId } from "../types";

export interface ProviderUsage {
  /** USD cost if the CLI reports it (Claude does, the Codex CLI does not). */
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface ProviderSpawnInput {
  config: AgentFileConfig;
  systemPrompt: string;
  prompt: string;
  resumeSessionId?: string;
}

/**
 * A provider is a thin strategy over one agentic CLI driven through node-pty.
 * It owns everything CLI-specific: binary resolution, argv construction, and
 * parsing the tool's streaming output into the normalized `ClaudeEvent`.
 * Everything else (PTY plumbing, persistence, SSE) is provider-agnostic.
 */
export interface AgentProvider {
  readonly id: ProviderId;
  /** CLI binary name, used for PATH checks and error messages. */
  readonly bin: string;
  /** Human label for the UI / error hints. */
  readonly label: string;
  /** Absolute path to the CLI; throws if it is not installed. */
  resolveBin(): string;
  /** argv for a single non-interactive, streaming-JSON run. */
  buildArgs(input: ProviderSpawnInput): string[];
  /** Parse one stdout line into a normalized event, or null if it is not one. */
  parseLine(line: string): ClaudeEvent | null;
  /** Pull the provider's resumable session id out of an event, or null. */
  sessionIdFrom(ev: ClaudeEvent): string | null;
  /** Pull cost/token usage out of a terminal event, or null. */
  usageFrom(ev: ClaudeEvent): ProviderUsage | null;
}
