import type { ProviderId } from "../types";
import type { AgentProvider } from "./types";
import { claudeProvider } from "./claude";
import { openaiProvider } from "./openai";

export const PROVIDERS: Record<ProviderId, AgentProvider> = {
  claude: claudeProvider,
  openai: openaiProvider,
};

export const DEFAULT_PROVIDER: ProviderId = "claude";

/** True for provider ids OrchestrIA knows how to drive. */
export function isProviderId(id: unknown): id is ProviderId {
  return id === "claude" || id === "openai";
}

/**
 * Strict lookup: throws on an unknown id. Callers reading from agent config
 * should normalize first (see loadAgentConfig) so a config typo can't kill
 * a mission.
 */
export function getProvider(id?: string | null): AgentProvider {
  if (!id) return PROVIDERS[DEFAULT_PROVIDER];
  if (!isProviderId(id)) {
    throw new Error(`unknown provider "${id}" (expected: ${Object.keys(PROVIDERS).join(", ")})`);
  }
  return PROVIDERS[id];
}

export { binOnPath } from "./util";
export type { AgentProvider, ProviderSpawnInput, ProviderUsage } from "./types";
