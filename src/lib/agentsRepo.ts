import fs from "fs";
import path from "path";
import os from "os";
import type { AgentConfig } from "./mock-data";

export const AGENTS_DIR = path.join(process.cwd(), ".orchestria", "agents");

// ─── Native agents (from ~/.claude/skills/) ──────────────────────────────────

const NATIVE_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");

/** Parse minimal YAML-like frontmatter between --- delimiters */
function parseFrontmatter(content: string): { name?: string; description?: string; allowedTools?: string[] } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const block = fmMatch[1];

  // name: value
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1].trim();

  // description: | followed by indented lines (block scalar)
  let description: string | undefined;
  const descBlock = block.match(/^description:\s*\|\s*\n((?:[ \t]+.+\n?)+)/m);
  if (descBlock) {
    description = descBlock[1]
      .split("\n")
      .map((l) => l.replace(/^\s{2}/, "").trimEnd())
      .filter(Boolean)
      .join(" ")
      .trim();
  } else {
    const descInline = block.match(/^description:\s*(.+)$/m);
    if (descInline) description = descInline[1].trim();
  }

  // allowed-tools: list
  const toolsMatch = block.match(/^allowed-tools:\s*\n((?:[ \t]+-[ \t]+.+\n?)+)/m);
  const allowedTools = toolsMatch
    ? toolsMatch[1].split("\n").map((l) => l.replace(/^\s+-\s*/, "").trim()).filter(Boolean)
    : undefined;

  return { name, description, allowedTools };
}

export function listNativeAgents(): AgentConfig[] {
  if (!fs.existsSync(NATIVE_SKILLS_DIR)) return [];
  const entries = fs.readdirSync(NATIVE_SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  return entries.map((d) => {
    const skillMd = path.join(NATIVE_SKILLS_DIR, d.name, "SKILL.md");
    let name = d.name;
    let description = "";
    let allowedTools: string[] = [];

    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, "utf8");
      const fm = parseFrontmatter(content);
      if (fm.name) name = fm.name;
      if (fm.description) description = fm.description;
      if (fm.allowedTools) allowedTools = fm.allowedTools;
    }

    return {
      id: d.name,
      name,
      model: "native",
      permissionMode: "auto" as AgentConfig["permissionMode"],
      systemPrompt: description,
      cwd: "~",
      allowedTools,
      channels: {},
      missions: 0,
      source: "skill" as const,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// ─── Claude agents (.claude/agents/*.md) ─────────────────────────────────────

/** Parse a .claude/agents/*.md file — YAML frontmatter + body as system prompt */
function parseClaudeAgentMd(content: string): { name?: string; description?: string; model?: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const block = fmMatch[1];

  const nameMatch = block.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = block.match(/^description:\s*["']?([\s\S]*?)["']?\s*$/m);
  const modelMatch = block.match(/^model:\s*(.+)$/m);

  return {
    name: nameMatch?.[1].trim(),
    description: descMatch?.[1].replace(/\\n/g, " ").replace(/\s+/g, " ").trim(),
    model: modelMatch?.[1].trim(),
  };
}

function listClaudeAgentsFromDir(dir: string): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const id = f.replace(/\.md$/, "");
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      const fm = parseClaudeAgentMd(content);
      // body (system prompt) = content after closing ---
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const systemPrompt = bodyMatch?.[1].trim() ?? "";

      return {
        id,
        name: fm.name ?? id,
        model: fm.model ?? "claude-sonnet-4-6",
        permissionMode: "auto" as AgentConfig["permissionMode"],
        systemPrompt,
        cwd: "~",
        allowedTools: [],
        channels: {},
        missions: 0,
        source: "agent" as const,
        // store description separately (shown as subtitle in UI)
        _description: fm.description,
      } as AgentConfig & { _description?: string };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function listClaudeAgents(): AgentConfig[] {
  const globalDir = path.join(os.homedir(), ".claude", "agents");
  const projectDir = path.join(process.cwd(), ".claude", "agents");
  const seen = new Set<string>();
  const results: AgentConfig[] = [];
  for (const agent of [...listClaudeAgentsFromDir(globalDir), ...listClaudeAgentsFromDir(projectDir)]) {
    if (!seen.has(agent.id)) { seen.add(agent.id); results.push(agent); }
  }
  return results;
}

type Provider = "claude" | "openai";

function normProvider(v: unknown): Provider {
  return v === "openai" ? "openai" : "claude";
}

interface RawConfig {
  id?: string;
  name?: string;
  glyph?: string;
  model?: string;
  provider?: string;
  permissionMode?: string;
  permission_mode?: string;
  cwd?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  channels?: Record<string, { on: boolean; value: string }>;
  remote?: { on: boolean; url: string };
  parent?: string;
  memoryScope?: "NONE" | "SESSION" | "USER" | "GLOBAL";
  skills?: string[];
}

function readSystemPrompt(name: string): string {
  const p = path.join(AGENTS_DIR, name, "system-prompt.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function toAgentConfig(name: string, raw: RawConfig): AgentConfig {
  return {
    id: raw.id ?? name,
    name: raw.name ?? name,
    glyph: raw.glyph,
    model: raw.model ?? "claude-sonnet-4-6",
    provider: normProvider(raw.provider),
    permissionMode: (raw.permissionMode ?? raw.permission_mode ?? "auto") as AgentConfig["permissionMode"],
    systemPrompt: readSystemPrompt(name),
    cwd: raw.cwd ?? "~",
    allowedTools: raw.allowedTools ?? [],
    deniedTools: raw.deniedTools,
    channels: raw.channels ?? {},
    remote: raw.remote,
    missions: 0,
    parent: raw.parent,
    source: "orchestria" as const,
    memoryScope: raw.memoryScope ?? "USER",
    skills: raw.skills ?? [],
  };
}

export function listAgentConfigs(): AgentConfig[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const cfg = path.join(AGENTS_DIR, d.name, "config.json");
      if (!fs.existsSync(cfg)) return null;
      const raw = JSON.parse(fs.readFileSync(cfg, "utf8")) as RawConfig;
      return toAgentConfig(d.name, raw);
    })
    .filter((x): x is AgentConfig => x !== null);
}

export function getAgentConfig(name: string): AgentConfig | null {
  const cfg = path.join(AGENTS_DIR, name, "config.json");
  if (!fs.existsSync(cfg)) return null;
  const raw = JSON.parse(fs.readFileSync(cfg, "utf8")) as RawConfig;
  return toAgentConfig(name, raw);
}

export interface CreateAgentInput {
  id: string;
  name?: string;
  model?: string;
  provider?: Provider;
  permissionMode?: AgentConfig["permissionMode"];
  systemPrompt?: string;
  cwd?: string;
  allowedTools?: string[];
  parent?: string;
  skills?: string[];
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

export function createAgent(input: CreateAgentInput): AgentConfig {
  if (!ID_RE.test(input.id)) {
    throw new Error("agent id must match /^[a-zA-Z0-9_-]+$/");
  }
  const dir = path.join(AGENTS_DIR, input.id);
  if (fs.existsSync(dir)) {
    throw new Error(`agent "${input.id}" already exists`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const config: RawConfig = {
    id: input.id,
    name: input.name ?? input.id,
    model: input.model ?? "claude-sonnet-4-6",
    provider: normProvider(input.provider),
    permissionMode: input.permissionMode ?? "auto",
    cwd: input.cwd ?? "~",
    allowedTools: input.allowedTools ?? [],
    channels: {},
    skills: input.skills ?? [],
  };
  if (input.parent) config.parent = input.parent;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "system-prompt.md"), (input.systemPrompt ?? "").trimStart() + "\n");
  return toAgentConfig(input.id, config);
}

export interface UpdateAgentInput {
  name?: string;
  glyph?: string;
  model?: string;
  provider?: Provider;
  permissionMode?: AgentConfig["permissionMode"];
  systemPrompt?: string;
  cwd?: string;
  allowedTools?: string[];
  parent?: string | null;
  memoryScope?: "NONE" | "SESSION" | "USER" | "GLOBAL";
  skills?: string[];
}

export function updateAgent(id: string, patch: UpdateAgentInput): AgentConfig | null {
  const dir = path.join(AGENTS_DIR, id);
  const cfgPath = path.join(dir, "config.json");
  if (!fs.existsSync(cfgPath)) return null;
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as RawConfig;

  if (patch.name !== undefined)            raw.name = patch.name;
  if (patch.glyph !== undefined)           raw.glyph = patch.glyph;
  if (patch.model !== undefined)           raw.model = patch.model;
  if (patch.provider !== undefined)        raw.provider = normProvider(patch.provider);
  if (patch.permissionMode !== undefined)  raw.permissionMode = patch.permissionMode;
  if (patch.cwd !== undefined)             raw.cwd = patch.cwd;
  if (patch.allowedTools !== undefined)    raw.allowedTools = patch.allowedTools;
  if (patch.parent !== undefined) {
    if (patch.parent === null) delete raw.parent;
    else raw.parent = patch.parent;
  }
  if (patch.memoryScope !== undefined) raw.memoryScope = patch.memoryScope;
  if (patch.skills !== undefined) raw.skills = patch.skills;

  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");

  if (patch.systemPrompt !== undefined) {
    fs.writeFileSync(path.join(dir, "system-prompt.md"), patch.systemPrompt);
  }

  return toAgentConfig(id, raw);
}

export function deleteAgent(name: string): boolean {
  const dir = path.join(AGENTS_DIR, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
