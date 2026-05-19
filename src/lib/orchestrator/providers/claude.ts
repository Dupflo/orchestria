import type { ClaudeEvent } from "../types";
import type { AgentProvider, ProviderSpawnInput, ProviderUsage } from "./types";
import { resolveCliBin } from "./util";

function buildArgs({ config, systemPrompt, prompt, resumeSessionId }: ProviderSpawnInput): string[] {
  // --output-format stream-json only works with --print (non-interactive).
  const args: string[] = [
    "--print",
    "--model", config.model,
    "--permission-mode", config.permissionMode,
    "--output-format", "stream-json",
    "--verbose",
  ];
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  if (systemPrompt.trim()) {
    args.push("--append-system-prompt", systemPrompt);
  }
  if (config.allowedTools?.length) {
    args.push("--allowed-tools", config.allowedTools.join(","));
  }
  if (config.deniedTools?.length) {
    args.push("--disallowed-tools", config.deniedTools.join(","));
  }
  // `--allowed-tools` / `--disallowed-tools` are variadic — without `--`
  // the parser would consume the prompt as a tool name.
  args.push("--", prompt);
  return args;
}

function parseLine(line: string): ClaudeEvent | null {
  const start = line.indexOf("{");
  if (start < 0) return null;
  const json = line.slice(start);
  if (!json.endsWith("}")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type
    : typeof o.subtype === "string" ? o.subtype
    : "unknown";
  return { type, timestamp: Date.now(), payload: obj };
}

export const claudeProvider: AgentProvider = {
  id: "claude",
  bin: "claude",
  label: "Claude Code",
  resolveBin: () => resolveCliBin("claude"),
  buildArgs,
  parseLine,
  sessionIdFrom(ev: ClaudeEvent): string | null {
    const p = ev.payload as { session_id?: unknown } | null;
    return p && typeof p.session_id === "string" ? p.session_id : null;
  },
  usageFrom(ev: ClaudeEvent): ProviderUsage | null {
    if (ev.type !== "result") return null;
    const p = ev.payload as Record<string, unknown>;
    const cost = typeof p.total_cost_usd === "number" ? p.total_cost_usd : null;
    const usage = p.usage as Record<string, unknown> | null | undefined;
    const tokIn = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
    const tokOut = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
    if (cost === null && tokIn === null && tokOut === null) return null;
    return { costUsd: cost, tokensIn: tokIn, tokensOut: tokOut };
  },
};
