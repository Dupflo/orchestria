import type { ClaudeEvent } from "../types";
import type { AgentProvider, ProviderSpawnInput, ProviderUsage } from "./types";
import { resolveCliBin } from "./util";

// Agent configs historically carry a Claude model id (the legacy default).
// Only forward `--model` when it is clearly an OpenAI/Codex model or an
// explicit env override — otherwise let the `codex` CLI use its own default
// rather than passing it a model name it will reject.
function pickModel(model: string): string | null {
  const env = process.env.ORCHESTRIA_OPENAI_MODEL?.trim();
  if (env) return env;
  if (/^(claude|sonnet|opus|haiku|native|inherit)/i.test(model)) return null;
  return model;
}

// `codex exec` is fully non-interactive (no approval prompts); the sandbox
// flag governs what it may touch. Map OrchestrIA's permission modes onto it.
function sandboxFlags(mode: string): string[] {
  switch (mode) {
    case "bypassPermissions":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    case "plan":
      return ["--sandbox", "read-only"];
    default:
      return ["--sandbox", "workspace-write"];
  }
}

function buildArgs({ config, systemPrompt, prompt, resumeSessionId }: ProviderSpawnInput): string[] {
  // Codex has no --append-system-prompt; fold it into the prompt instead.
  const finalPrompt = systemPrompt.trim()
    ? `${systemPrompt.trim()}\n\n---\n\n${prompt}`
    : prompt;
  const flags: string[] = ["--json", "--skip-git-repo-check", ...sandboxFlags(config.permissionMode)];
  const model = pickModel(config.model);
  if (model) flags.push("--model", model);
  if (resumeSessionId) {
    return ["exec", "resume", resumeSessionId, ...flags, finalPrompt];
  }
  return ["exec", ...flags, finalPrompt];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// The Codex `--json` schema differs across CLI versions (flat `type` vs the
// older `{ msg: { type } }` envelope), so probe defensively.
function pickType(o: Record<string, unknown>): string {
  if (typeof o.type === "string") return o.type;
  const msg = asRecord(o.msg);
  if (msg && typeof msg.type === "string") return msg.type;
  return "unknown";
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
  return { type: pickType(obj as Record<string, unknown>), timestamp: Date.now(), payload: obj };
}

function findSession(o: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    o.thread_id,
    o.session_id,
    o.conversation_id,
    asRecord(o.thread)?.id,
    asRecord(o.session)?.id,
    asRecord(o.msg)?.session_id,
    asRecord(o.payload)?.thread_id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return null;
}

function findUsage(o: Record<string, unknown>): ProviderUsage | null {
  const buckets = [
    asRecord(o.usage),
    asRecord(o.token_usage),
    asRecord(o.total_token_usage),
    asRecord(asRecord(o.info)?.total_token_usage),
    asRecord(asRecord(o.msg)?.usage),
    asRecord(asRecord(o.payload)?.usage),
  ].filter((b): b is Record<string, unknown> => !!b);
  for (const u of buckets) {
    const tokIn = num(u.input_tokens) ?? num(u.prompt_tokens);
    const tokOut = num(u.output_tokens) ?? num(u.completion_tokens);
    if (tokIn !== null || tokOut !== null) {
      // The Codex CLI does not surface a USD cost.
      return { costUsd: null, tokensIn: tokIn, tokensOut: tokOut };
    }
  }
  return null;
}

export const openaiProvider: AgentProvider = {
  id: "openai",
  bin: "codex",
  label: "OpenAI Codex",
  resolveBin: () => resolveCliBin("codex"),
  buildArgs,
  parseLine,
  sessionIdFrom(ev: ClaudeEvent): string | null {
    const p = asRecord(ev.payload);
    return p ? findSession(p) : null;
  },
  usageFrom(ev: ClaudeEvent): ProviderUsage | null {
    const p = asRecord(ev.payload);
    return p ? findUsage(p) : null;
  },
};
