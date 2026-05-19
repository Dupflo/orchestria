import fs from "fs";
import path from "path";
import os from "os";
import type { AgentFileConfig, MemoryScope, ProviderId } from "./types";

export const ORCHESTRIA_HOME = path.join(process.cwd(), ".orchestria");
/** Cross-project, user-wide memory store. */
export const USER_ORCHESTRIA_HOME = path.join(os.homedir(), ".orchestria");
/** Where GLOBAL-scope memory notes live. */
export const GLOBAL_MEMORY_DIR = path.join(USER_ORCHESTRIA_HOME, "global-memory");

const AGENT_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Agent names flow in from URL params, request bodies and channel payloads.
 * They are used to build filesystem paths, so anything outside this charset
 * (notably `.` / `/`) would allow path traversal out of the agents dir.
 */
export function assertSafeAgentName(name: string): void {
  if (typeof name !== "string" || !AGENT_NAME_RE.test(name)) {
    throw new Error(`invalid agent name: ${JSON.stringify(name)}`);
  }
}

export function agentDir(name: string): string {
  assertSafeAgentName(name);
  return path.join(ORCHESTRIA_HOME, "agents", name);
}

export function loadAgentConfig(name: string): AgentFileConfig {
  const file = path.join(agentDir(name), "config.json");
  if (!fs.existsSync(file)) {
    throw new Error(`agent "${name}" not found (missing ${file})`);
  }
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as Partial<AgentFileConfig> & { permission_mode?: string };
  // Normalize here (not via getProvider's strict lookup) so a typo'd provider
  // in config falls back to claude instead of throwing and killing the mission.
  const provider: ProviderId = parsed.provider === "openai" ? "openai" : "claude";
  return {
    cwd: parsed.cwd?.replace(/^~/, os.homedir()) ?? os.homedir(),
    model: parsed.model ?? "sonnet",
    provider,
    permissionMode: (parsed.permissionMode ?? parsed.permission_mode ?? "auto") as AgentFileConfig["permissionMode"],
    allowedTools: parsed.allowedTools,
    deniedTools: parsed.deniedTools,
    memoryScope: parsed.memoryScope ?? "USER",
  };
}

/** Returns "" if no system-prompt.md is present (it's optional). */
export function loadSystemPrompt(name: string): string {
  const file = path.join(agentDir(name), "system-prompt.md");
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

export function ensureMemoryDir(name: string): string {
  const dir = path.join(agentDir(name), "memory");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureLogsDir(name: string): string {
  const dir = path.join(agentDir(name), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readMdDir(dir: string, prefix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md")).sort()
    .map((f) => {
      const content = fs.readFileSync(path.join(dir, f), "utf8").trim();
      return content ? `### ${prefix}${f}\n\n${content}` : "";
    })
    .filter(Boolean);
}

/**
 * Concatenates memory notes into a system-prompt appendix, respecting scope:
 *   NONE    → empty (no notes loaded)
 *   SESSION → empty (continuity is handled via Claude session resume, not files)
 *   USER    → project-local memory   (<project>/.orchestria/agents/<id>/memory/*.md)
 *   GLOBAL  → USER + user-home memory (~/.orchestria/global-memory/*.md)
 */
export function loadMemory(name: string, scope: MemoryScope = "USER"): string {
  if (scope === "NONE" || scope === "SESSION") return "";

  const parts: string[] = [];

  // Project-scoped memory (lives next to the agent, follows the repo)
  parts.push(...readMdDir(path.join(agentDir(name), "memory"), "memory/"));

  // User-scoped memory (cross-project, shared between all agents/projects)
  if (scope === "GLOBAL") {
    parts.push(...readMdDir(GLOBAL_MEMORY_DIR, "~/.orchestria/global-memory/"));
  }

  if (parts.length === 0) return "";
  return `\n\n---\n## Agent memory\n\n${parts.join("\n\n")}`;
}

/** Append a note to the appropriate memory store for the given scope. */
export function appendMemoryNote(name: string, scope: MemoryScope, note: string, file = "notes.md"): string | null {
  if (scope === "NONE" || scope === "SESSION") return null;
  const dir = scope === "GLOBAL"
    ? GLOBAL_MEMORY_DIR
    : path.join(agentDir(name), "memory");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  const ts = new Date().toISOString();
  fs.appendFileSync(target, `\n\n<!-- ${ts} -->\n${note.trim()}\n`);
  return target;
}
