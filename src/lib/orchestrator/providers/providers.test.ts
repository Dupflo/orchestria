import { describe, it, expect, afterEach } from "vitest";
import { getProvider, isProviderId, DEFAULT_PROVIDER } from "./index";
import { claudeProvider } from "./claude";
import { openaiProvider } from "./openai";
import type { AgentFileConfig } from "../types";

function cfg(over: Partial<AgentFileConfig> = {}): AgentFileConfig {
  return {
    cwd: "/tmp",
    model: "claude-sonnet-4-6",
    provider: "claude",
    permissionMode: "auto",
    ...over,
  };
}

describe("provider registry", () => {
  it("defaults to claude when no id is given", () => {
    expect(getProvider().id).toBe(DEFAULT_PROVIDER);
    expect(getProvider(null).id).toBe("claude");
  });

  it("resolves known ids", () => {
    expect(getProvider("claude")).toBe(claudeProvider);
    expect(getProvider("openai")).toBe(openaiProvider);
  });

  it("throws on an unknown id", () => {
    expect(() => getProvider("gemini")).toThrow(/unknown provider/);
  });

  it("isProviderId guards the union", () => {
    expect(isProviderId("claude")).toBe(true);
    expect(isProviderId("openai")).toBe(true);
    expect(isProviderId("nope")).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
  });
});

describe("claudeProvider.buildArgs", () => {
  it("builds a non-interactive streaming-json invocation", () => {
    const args = claudeProvider.buildArgs({
      config: cfg({ allowedTools: ["Bash", "Read"] }),
      systemPrompt: "be terse",
      prompt: "do the thing",
    });
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("Bash,Read");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("be terse");
    // prompt is the trailing positional after the `--` separator
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("do the thing");
  });

  it("adds --resume only when resuming", () => {
    expect(claudeProvider.buildArgs({ config: cfg(), systemPrompt: "", prompt: "p" }))
      .not.toContain("--resume");
    const args = claudeProvider.buildArgs({ config: cfg(), systemPrompt: "", prompt: "p", resumeSessionId: "s1" });
    expect(args[args.indexOf("--resume") + 1]).toBe("s1");
  });
});

describe("claudeProvider parsing", () => {
  it("parses a json event and ignores noise lines", () => {
    expect(claudeProvider.parseLine("starting up…")).toBeNull();
    const ev = claudeProvider.parseLine('{"type":"assistant","session_id":"abc"}');
    expect(ev?.type).toBe("assistant");
    expect(claudeProvider.sessionIdFrom(ev!)).toBe("abc");
  });

  it("extracts cost & tokens from a result event only", () => {
    const other = { type: "assistant", timestamp: 0, payload: { total_cost_usd: 9 } };
    expect(claudeProvider.usageFrom(other)).toBeNull();
    const result = {
      type: "result",
      timestamp: 0,
      payload: { total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 50 } },
    };
    expect(claudeProvider.usageFrom(result)).toEqual({ costUsd: 0.42, tokensIn: 100, tokensOut: 50 });
  });
});

describe("openaiProvider.buildArgs (codex exec)", () => {
  afterEach(() => {
    delete process.env.ORCHESTRIA_OPENAI_MODEL;
  });

  it("uses `codex exec --json` with a sandbox and skips the git check", () => {
    const args = openaiProvider.buildArgs({ config: cfg(), systemPrompt: "", prompt: "hi" });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args[args.length - 1]).toBe("hi");
  });

  it("maps permission modes onto the sandbox", () => {
    expect(openaiProvider.buildArgs({ config: cfg({ permissionMode: "plan" }), systemPrompt: "", prompt: "p" }))
      .toContain("read-only");
    expect(openaiProvider.buildArgs({ config: cfg({ permissionMode: "bypassPermissions" }), systemPrompt: "", prompt: "p" }))
      .toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("does not forward a Claude model id, but forwards a real one or an env override", () => {
    expect(openaiProvider.buildArgs({ config: cfg(), systemPrompt: "", prompt: "p" }))
      .not.toContain("--model");
    const explicit = openaiProvider.buildArgs({ config: cfg({ model: "gpt-5-codex" }), systemPrompt: "", prompt: "p" });
    expect(explicit[explicit.indexOf("--model") + 1]).toBe("gpt-5-codex");
    process.env.ORCHESTRIA_OPENAI_MODEL = "o4-mini";
    const env = openaiProvider.buildArgs({ config: cfg(), systemPrompt: "", prompt: "p" });
    expect(env[env.indexOf("--model") + 1]).toBe("o4-mini");
  });

  it("folds the system prompt into the prompt and supports resume", () => {
    const args = openaiProvider.buildArgs({ config: cfg(), systemPrompt: "SYS", prompt: "USER" });
    expect(args[args.length - 1]).toBe("SYS\n\n---\n\nUSER");
    const resumed = openaiProvider.buildArgs({ config: cfg(), systemPrompt: "", prompt: "p", resumeSessionId: "t9" });
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "t9"]);
  });
});

describe("openaiProvider parsing (defensive across codex schemas)", () => {
  it("derives type from flat or enveloped json", () => {
    expect(openaiProvider.parseLine('{"type":"item.completed"}')?.type).toBe("item.completed");
    expect(openaiProvider.parseLine('{"msg":{"type":"agent_message"}}')?.type).toBe("agent_message");
    expect(openaiProvider.parseLine("just text")).toBeNull();
  });

  it("finds the session id under several keys", () => {
    const a = openaiProvider.parseLine('{"type":"thread.started","thread_id":"th_1"}')!;
    expect(openaiProvider.sessionIdFrom(a)).toBe("th_1");
    const b = openaiProvider.parseLine('{"type":"x","session":{"id":"sess_2"}}')!;
    expect(openaiProvider.sessionIdFrom(b)).toBe("sess_2");
  });

  it("extracts token usage from common shapes (no USD cost)", () => {
    const a = openaiProvider.parseLine('{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":7}}')!;
    expect(openaiProvider.usageFrom(a)).toEqual({ costUsd: null, tokensIn: 12, tokensOut: 7 });
    const b = openaiProvider.parseLine('{"type":"token_count","info":{"total_token_usage":{"prompt_tokens":3,"completion_tokens":4}}}')!;
    expect(openaiProvider.usageFrom(b)).toEqual({ costUsd: null, tokensIn: 3, tokensOut: 4 });
    const none = openaiProvider.parseLine('{"type":"item.started"}')!;
    expect(openaiProvider.usageFrom(none)).toBeNull();
  });
});
