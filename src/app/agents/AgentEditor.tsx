"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentConfig } from "@/lib/mock-data";
import ChannelsSection from "./ChannelsSection";

// ─── Static config ──────────────────────────────────────────────────────────

const GLYPHS = ["◆", "◇", "▲", "◈", "●", "■", "◐", "◉", "✦", "△", "□", "◊", "♦", "◎"];

type Provider = "claude" | "openai";

const PROVIDERS = [
  { id: "claude" as const, label: "CLAUDE", sub: "claude cli" },
  { id: "openai" as const, label: "OPENAI", sub: "codex cli" },
];

const MODELS = [
  { id: "inherit",                       label: "INHERIT", sub: "parent" },
  { id: "claude-haiku-4-5-20251001",     label: "HAIKU",   sub: "cheap" },
  { id: "claude-sonnet-4-6",             label: "SONNET",  sub: "default" },
  { id: "claude-opus-4-7",               label: "OPUS",    sub: "max" },
];

const PERMS = [
  { id: "auto",              label: "DEFAULT", sub: "ask" },
  { id: "acceptEdits",       label: "ACCEPT",  sub: "auto-edit" },
  { id: "plan",              label: "PLAN",    sub: "read-only" },
  { id: "bypassPermissions", label: "BYPASS",  sub: "yolo" },
] as const;

const MEM = [
  { id: "NONE",    label: "NONE",    sub: "fresh" },
  { id: "SESSION", label: "SESSION", sub: "this run" },
  { id: "USER",    label: "USER",    sub: "project" },
  { id: "GLOBAL",  label: "GLOBAL",  sub: "cross-proj" },
] as const;

const TOOL_PRESETS = ["Read", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Edit"];

const PERM_HINT: Record<string, string> = {
  auto: "agent acts freely within allowed tools",
  acceptEdits: "agent applies edits without confirm but stops before destructive ops",
  plan: "agent proposes a plan and waits for approval",
  bypassPermissions: "agent acts on any tool — use only for trusted system agents",
};

const ICO = {
  folder: (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 5.5h5l1.5 2h8.5v9a1 1 0 01-1 1H3.5a1 1 0 01-1-1v-11z" />
    </svg>
  ),
  arrow: (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 10h10M11 6l4 4-4 4" />
    </svg>
  ),
};

// ─── Reusable bits ──────────────────────────────────────────────────────────

function SectionHeader({ num, title, sub }: { num: string; title: string; sub?: string }) {
  return (
    <div className="section-hd">
      <div className="section-hd-left">
        <span className="num">{num}</span>
        <span className="section-title">{title}</span>
      </div>
      {sub && <span className="section-hd-sub">{sub}</span>}
    </div>
  );
}

function PillGroup<T extends string>({ value, options, onChange }: {
  value: T;
  options: readonly { id: T; label: string; sub: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="pill-row cols-4">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)}
          className={`pill${value === o.id ? " on" : ""}`}>
          <span className="lbl">{o.label}</span>
          <span className="sub">{o.sub}</span>
        </button>
      ))}
    </div>
  );
}

// ─── The editor ─────────────────────────────────────────────────────────────

export default function AgentEditor({
  id, isNew = false, onDeleted, onCreated,
}: {
  id: string;
  isNew?: boolean;
  onDeleted?: () => void;
  onCreated?: (newId: string) => void;
}) {
  const router = useRouter();

  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [newId, setNewId] = useState("");                    // only used in create mode
  const [name, setName] = useState("");
  const [glyph, setGlyph] = useState("◆");
  const [cwd, setCwd] = useState("~");
  const [provider, setProvider] = useState<Provider>("claude");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [permissionMode, setPermissionMode] = useState<AgentConfig["permissionMode"]>("auto");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [allowedTools, setAllowedTools] = useState<string[]>(["Bash", "Read", "Edit", "Write"]);
  const [maxTurns, setMaxTurns] = useState(0);
  const [memoryScope, setMemoryScope] = useState<"NONE" | "SESSION" | "USER" | "GLOBAL">("USER");
  const [skills, setSkills] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<{ id: string; name: string; source: string }[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isMain = id === "_main";

  // Load available skills once
  useEffect(() => {
    fetch("/api/skills")
      .then((r) => r.json())
      .then((data: { id: string; name: string; source: string }[]) => {
        setAvailableSkills(data.map((s) => ({ id: s.id, name: s.name, source: s.source })));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) {
      // Reset to empty create-state when switching to "new" mode
      setCfg(null); setLoading(false); setError(null);
      setNewId(""); setName(""); setGlyph("◆"); setCwd("~");
      setProvider("claude"); setModel("claude-sonnet-4-6"); setPermissionMode("auto");
      setSystemPrompt(""); setAllowedTools(["Bash", "Read", "Edit", "Write"]);
      setMemoryScope("USER"); setSkills([]);
      return;
    }
    setLoading(true);
    setError(null);
    setCfg(null);
    fetch(`/api/agents/${id}`)
      .then((r) => r.json())
      .then((data: AgentConfig) => {
        if ((data as unknown as { error?: string })?.error) {
          setError("Agent introuvable.");
          return;
        }
        setCfg(data);
        setName(data.name);
        setGlyph(data.glyph || data.name.charAt(0).toUpperCase() || "◆");
        setCwd(data.cwd);
        setProvider(data.provider ?? "claude");
        setModel(data.model);
        setPermissionMode(data.permissionMode);
        setSystemPrompt(data.systemPrompt);
        setAllowedTools(data.allowedTools);
        setMemoryScope(data.memoryScope ?? "USER");
        setSkills(data.skills ?? []);
      })
      .catch(() => setError("Impossible de charger l'agent"))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const dirty = useMemo(() => {
    if (isNew) {
      // In create mode, "dirty" means valid enough to attempt save
      return newId.trim().length > 0;
    }
    if (!cfg) return false;
    const cfgGlyph = cfg.glyph || cfg.name.charAt(0).toUpperCase() || "◆";
    return (
      name !== cfg.name ||
      glyph !== cfgGlyph ||
      cwd !== cfg.cwd ||
      provider !== (cfg.provider ?? "claude") ||
      model !== cfg.model ||
      permissionMode !== cfg.permissionMode ||
      systemPrompt !== cfg.systemPrompt ||
      JSON.stringify(allowedTools) !== JSON.stringify(cfg.allowedTools) ||
      memoryScope !== (cfg.memoryScope ?? "USER")
    );
  }, [isNew, newId, cfg, name, glyph, cwd, provider, model, permissionMode, systemPrompt, allowedTools, memoryScope]);

  const reset = () => {
    if (isNew) {
      setNewId(""); setName(""); setGlyph("◆"); setCwd("~");
      setProvider("claude"); setModel("claude-sonnet-4-6"); setPermissionMode("auto");
      setSystemPrompt(""); setAllowedTools(["Bash", "Read", "Edit", "Write"]);
      setMemoryScope("USER"); setError(null);
      return;
    }
    if (!cfg) return;
    setName(cfg.name);
    setGlyph(cfg.glyph || cfg.name.charAt(0).toUpperCase() || "◆");
    setCwd(cfg.cwd); setProvider(cfg.provider ?? "claude"); setModel(cfg.model);
    setPermissionMode(cfg.permissionMode); setSystemPrompt(cfg.systemPrompt);
    setAllowedTools(cfg.allowedTools);
    setMemoryScope(cfg.memoryScope ?? "USER");
    setSkills(cfg.skills ?? []);
  };

  const save = async () => {
    setSaving(true); setError(null);
    if (isNew) {
      const cleanId = newId.trim();
      if (!cleanId || !/^[a-zA-Z0-9_-]+$/.test(cleanId)) {
        setSaving(false);
        setError("id requis : alphanumeric / _ / -");
        return;
      }
      const res = await fetch(`/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: cleanId,
          name: name.trim() || cleanId,
          glyph, cwd, provider, model, permissionMode,
          systemPrompt, allowedTools, memoryScope, skills,
        }),
      });
      setSaving(false);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      const created = (await res.json()) as AgentConfig;
      onCreated?.(created.id);
      return;
    }

    const res = await fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name, glyph, cwd, provider, model, permissionMode,
        systemPrompt, allowedTools, memoryScope, skills,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    const updated = (await res.json()) as AgentConfig;
    setCfg(updated);
    setSavedAt(Date.now());
  };

  const remove = async () => {
    setDeleting(true);
    const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) {
      onDeleted?.();
    } else {
      setConfirmDelete(false);
      setError("Suppression échouée");
    }
  };

  const toggleTool = (t: string) => {
    setAllowedTools((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
  };

  const promptLines = systemPrompt.split("\n").length;
  const promptChars = systemPrompt.length;

  if (loading) return <div className="center-state">loading…</div>;
  if (error && !cfg && !isNew) return <div className="center-state err">{error}</div>;
  if (!cfg && !isNew) return null;

  const role = isMain ? "orchestrator" : "subagent";
  const saveLabel = saving ? (isNew ? "creating…" : "saving…")
    : dirty ? (isNew ? "ready to create" : "unsaved changes")
    : savedAt ? `all changes saved · ${new Date(savedAt).toTimeString().slice(0, 5)}`
    : isNew ? "fill in an id to create" : "no changes";

  return (
    <div className="edit-root">
      {/* ── header ────────────────────────────────────────────────── */}
      <header className="edit-hd">
        <div className="glyph-lg">{glyph}</div>
        <div>
          <h1>{isNew ? (newId || "new-agent") : name}</h1>
          <div className="breadcrumb">
            <span className="crumb">agents</span><span>/</span>
            {isNew ? (
              <span className="crumb active" style={{ color: "var(--accent)" }}>new agent</span>
            ) : (
              <>
                <span className="crumb">{role}</span><span>/</span>
                <span className="crumb active">{id}</span>
                {isMain && <>
                  <span style={{ marginLeft: 8, opacity: 0.5 }}>·</span>
                  <span style={{ color: "var(--accent)" }}>CHANNELS HUB</span>
                </>}
              </>
            )}
          </div>
        </div>
        <div className="edit-hd-actions">
          {!isNew && !confirmDelete && (
            <>
              <button className="btn btn-ghost btn-sm" disabled>Duplicate</button>
              {!isMain && (
                <button className="btn btn-ghost btn-sm btn-delete" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              )}
            </>
          )}
          {!isNew && confirmDelete && (
            <>
              <span style={{ fontSize: 11, color: "var(--err)" }}>Confirm?</span>
              <button className="btn btn-sm" style={{ background: "var(--err)", color: "#fff", borderColor: "var(--err)" }}
                onClick={remove} disabled={deleting}>{deleting ? "…" : "Yes, delete"}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          )}
        </div>
      </header>

      {/* ── body: split layout (CLAUDE.md + config sections) ────── */}
      <div className="edit-body">
        <div className="claude-pane">
          <div className="hd">
            <div>
              <div className="lbl">{"// CLAUDE.MD"}</div>
              <div className="sub">System prompt loaded into the agent on every spawn. Markdown supported.</div>
            </div>
            <div className="count">{promptLines} lines · {promptChars} chars</div>
          </div>
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} spellCheck={false} />
        </div>

        <aside className="config-pane scroll">
          {/* 01 IDENTITY */}
          <section className="section">
            <SectionHeader num="01" title="Identity" sub="how this agent is summoned" />
            {isNew && (
              <div className="field" style={{ marginBottom: 14 }}>
                <label className="field-label">
                  ID <span style={{ color: "var(--text-faint)", textTransform: "lowercase", letterSpacing: 0 }}>filesystem-safe · immuable</span>
                </label>
                <input className="input mono" autoFocus placeholder="e.g. forge"
                  value={newId} onChange={(e) => setNewId(e.target.value)} />
                <div className="field-hint">alphanumeric / _ / - · sera le nom du dossier dans <code>.orchestria/agents/</code></div>
              </div>
            )}
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">Name</label>
              <input className="input mono" value={name} onChange={(e) => setName(e.target.value)}
                placeholder={isNew ? "(défaut: id)" : ""} />
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">Glyph <span style={{ color: "var(--text-faint)", textTransform: "lowercase", letterSpacing: 0 }}>single char</span></label>
              <div className="glyph-grid">
                {GLYPHS.map((g) => (
                  <button key={g} type="button" onClick={() => setGlyph(g)} className={glyph === g ? "on" : ""}>{g}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">Working directory <span style={{ color: "var(--text-faint)", textTransform: "lowercase", letterSpacing: 0 }}>default ~/</span></label>
              <div className="picker-input">
                <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
                <button
                  className="pick-btn"
                  title="Choisir un dossier"
                  type="button"
                  onClick={async () => {
                    const res = await fetch("/api/system/pick-folder", { method: "POST" });
                    if (!res.ok) return;
                    const j = await res.json() as { path?: string; cancelled?: boolean };
                    if (!j.cancelled && j.path) setCwd(j.path);
                  }}
                >
                  {ICO.folder}
                </button>
              </div>
              <div className="field-hint">cwd where Claude Code spawns — determines which CLAUDE.md project file is loaded</div>
            </div>
          </section>

          {/* 02 MODEL & MEMORY */}
          <section className="section">
            <SectionHeader num="02" title="Model & memory" sub="cc subagent settings" />
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">Provider <span style={{ color: "var(--text-faint)", textTransform: "lowercase", letterSpacing: 0 }}>which AI CLI runs this agent</span></label>
              <PillGroup
                value={provider}
                options={PROVIDERS}
                onChange={(v) => {
                  setProvider(v);
                  // Keep the model field meaningful when switching backends.
                  if (v === "openai" && /^(claude|inherit)/.test(model)) setModel("");
                  if (v === "claude" && !/^claude/.test(model)) setModel("claude-sonnet-4-6");
                }} />
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">Model</label>
              {provider === "claude" ? (
                <PillGroup value={model} options={MODELS} onChange={setModel} />
              ) : (
                <>
                  <input className="input mono" value={model} placeholder="codex default"
                    onChange={(e) => setModel(e.target.value)} />
                  <div className="field-hint">
                    OpenAI/Codex model id (e.g. <code>gpt-5-codex</code>). Leave empty to use the
                    {" "}<code>codex</code> CLI default, or set <code>ORCHESTRIA_OPENAI_MODEL</code> to override globally.
                  </div>
                </>
              )}
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">Memory scope <span style={{ color: "var(--text-faint)", textTransform: "lowercase", letterSpacing: 0 }}>cross-session learnings</span></label>
              <PillGroup value={memoryScope} options={MEM} onChange={setMemoryScope} />
              <div className="scope-hint">
                {memoryScope === "NONE" && <>Fresh à chaque spawn — pas de session ni de notes.</>}
                {memoryScope === "SESSION" && <>Reprise de session Claude (continuité), pas de notes persistantes.</>}
                {memoryScope === "USER" && <>Notes persistantes dans <code>.orchestria/agents/{isNew ? (newId || "<id>") : id}/memory/*.md</code> (suit le repo).</>}
                {memoryScope === "GLOBAL" && <>Notes projet + notes partagées dans <code>~/.orchestria/global-memory/*.md</code> (cross-projet).</>}
              </div>
            </div>
            <div className="field">
              <label className="field-label">Max turns <span style={{ color: "var(--text-faint)", textTransform: "lowercase", letterSpacing: 0 }}>{maxTurns === 0 ? "unlimited" : String(maxTurns)}</span></label>
              <div className="slider-row">
                <input type="range" min={0} max={50} step={1} value={maxTurns}
                  onChange={(e) => setMaxTurns(parseInt(e.target.value))} />
                <span className="v">{maxTurns}</span>
              </div>
              <div className="field-hint">0 = no cap on the agentic loop</div>
            </div>
          </section>

          {/* 03 PERMISSIONS */}
          <section className="section">
            <SectionHeader num="03" title="Permissions" sub="trust scope" />
            <div className="field" style={{ marginBottom: 16 }}>
              <label className="field-label">Permission mode</label>
              <PillGroup
                value={permissionMode}
                options={PERMS.map((p) => ({ id: p.id, label: p.label, sub: p.sub }))}
                onChange={(v) => setPermissionMode(v as AgentConfig["permissionMode"])} />
              <div className="field-hint">{PERM_HINT[permissionMode]}</div>
            </div>
            <div className="field">
              <label className="field-label">Allowed tools · {allowedTools.length} enabled</label>
              <div className="tool-chips">
                {TOOL_PRESETS.map((t) => {
                  const on = allowedTools.includes(t);
                  return (
                    <button key={t} className={`tool-chip${on ? " on" : ""}`} onClick={() => toggleTool(t)}>
                      {t.toLowerCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* 04 SKILLS */}
          <section className="section">
            <SectionHeader num="04" title="Skills" sub="injected on spawn" />
            <div className="field">
              <label className="field-label">OrchestrIA skills · {availableSkills.filter(s => s.source === "project").length} available</label>
              <div className="tool-chips" style={{ flexWrap: "wrap" }}>
                {availableSkills.filter(s => s.source === "project").length === 0 ? (
                  <span style={{ fontSize: 11, color: "var(--text-faint)" }}>No project skills yet.</span>
                ) : availableSkills.filter(s => s.source === "project").map((s) => {
                  const on = skills.includes(s.id);
                  return (
                    <button key={s.id} className={`tool-chip${on ? " on" : ""}`}
                      onClick={() => setSkills((prev) => on ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                      title={s.id}>
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label className="field-label">Claude native skills · {availableSkills.filter(s => s.source !== "project").length} available</label>
              <div className="tool-chips" style={{ flexWrap: "wrap" }}>
                {availableSkills.filter(s => s.source !== "project").length === 0 ? (
                  <span style={{ fontSize: 11, color: "var(--text-faint)" }}>No native skills found.</span>
                ) : availableSkills.filter(s => s.source !== "project").map((s) => {
                  const on = skills.includes(s.id);
                  return (
                    <button key={s.id} className={`tool-chip${on ? " on" : ""}`}
                      style={on ? {} : { borderColor: "rgba(200,156,255,0.3)", color: "var(--text-dim)" }}
                      onClick={() => setSkills((prev) => on ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                      title={s.id}>
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="field-hint" style={{ marginTop: 6 }}>
              Skills sélectionnés sont injectés dans le system prompt à chaque spawn.
            </div>
          </section>

          {/* 05 CHANNELS — only on _main, and only after creation */}
          {isMain && !isNew && (
            <section className="section">
              <SectionHeader num="05" title="Channels" sub="where _main can be reached" />
              <ChannelsSection />
            </section>
          )}

          {dirty && <div className="dirty-alert">⚠ changes pending — SAVE to apply</div>}
        </aside>
      </div>

      {/* ── sticky footer ─────────────────────────────────────── */}
      <div className="edit-footer">
        <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
          {isNew ? "Create agent" : "Save"}
        </button>
        <button className="btn btn-ghost" onClick={reset} disabled={!dirty || saving}>Reset</button>
        <div className={`save-status${dirty || saving ? "" : " saved"}${error ? " error" : ""}`}>
          <span className="d" />
          <span>{error ?? saveLabel}</span>
        </div>
        {!isNew && (
          <button className="open-chat" onClick={() => router.push(`/chat?agent=${encodeURIComponent(id)}`)}
            style={{ background: "transparent", border: 0, cursor: "pointer" }}>
            Open chat with <span className="mono" style={{ marginLeft: 4 }}>{name}</span>
            {ICO.arrow}
          </button>
        )}
      </div>
    </div>
  );
}
