"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { AgentConfig } from "@/lib/mock-data";
import type { ChannelConfig, ChannelType } from "@/lib/channels/types";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChannelEntry { name: string; config: ChannelConfig }
interface RunningInfo  { name: string; type: string; polling: boolean }
interface Subscriber   { chat_id: number; username?: string; first_name?: string; message_count: number }

interface ChannelsResponse {
  configured: ChannelEntry[];
  running: RunningInfo[];
  subscribers: Record<string, Subscriber[]>;
}

const TYPE_META: Record<ChannelType, { label: string; color: string; glyph: string }> = {
  telegram: { label: "Telegram", color: "#229ED9", glyph: "◇" },
  discord:  { label: "Discord",  color: "#5865F2", glyph: "◆" },
  webhook:  { label: "Webhook",  color: "#e6b85c", glyph: "▷" },
  imessage: { label: "iMessage", color: "#34d399", glyph: "◈" },
};

const NEW_SENTINEL = "__new__";
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

// ─── Sidebar item ───────────────────────────────────────────────────────────

function ChannelItem({ entry, running, subsCount, active, onSelect }: {
  entry: ChannelEntry;
  running: boolean;
  subsCount: number;
  active: boolean;
  onSelect: () => void;
}) {
  const meta = TYPE_META[entry.config.type];
  return (
    <div className={`ch-item${active ? " active" : ""}`} onClick={onSelect}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
        borderRadius: 6, cursor: "pointer", marginBottom: 4,
        background: active ? "var(--bg-elev-2)" : "transparent",
        border: `1px solid ${active ? "var(--line-strong)" : "transparent"}`,
      }}>
      <span style={{ color: meta.color, fontSize: 16, fontFamily: "var(--font-mono, monospace)" }}>{meta.glyph}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {entry.name}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2, display: "flex", gap: 8 }}>
          <span>{meta.label.toLowerCase()}</span>
          <span>→ <span className="mono" style={{ color: "var(--text-dim)" }}>{entry.config.default_agent}</span></span>
        </div>
      </div>
      <span style={{
        fontSize: 9, padding: "2px 6px", borderRadius: 3,
        color: running ? "var(--ok)" : "var(--text-faint)",
        border: `1px solid ${running ? "var(--ok)" : "var(--text-faint)"}`,
        letterSpacing: "0.04em",
      }}>
        {running ? "ON" : "OFF"}
      </span>
      {subsCount > 0 && (
        <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{subsCount} sub</span>
      )}
    </div>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────────

function ChannelEditor({ name, initial, agents, running, subscribers, onSaved, onDeleted }: {
  name: string;
  initial: ChannelEntry | null; // null = new
  agents: AgentConfig[];
  running: boolean;
  subscribers: Subscriber[];
  onSaved: (newName: string) => void;
  onDeleted: () => void;
}) {
  const isNew = initial === null;
  const [draftName, setDraftName] = useState(isNew ? "" : name);
  const [type, setType] = useState<ChannelType>(initial?.config.type ?? "telegram");
  const [defaultAgent, setDefaultAgent] = useState(initial?.config.default_agent ?? agents[0]?.id ?? "_main");

  // Telegram
  const [tgToken, setTgToken] = useState(
    initial?.config.type === "telegram" ? (initial.config.bot_token ?? initial.config.bot_token_env ?? "") : ""
  );
  const [tgAllowed, setTgAllowed] = useState(
    initial?.config.type === "telegram" ? (initial.config.allowed_chat_ids ?? []).join(", ") : ""
  );

  // Discord
  const [dcToken, setDcToken] = useState(
    initial?.config.type === "discord" ? (initial.config.bot_token_env ?? "") : ""
  );
  const [dcGuild, setDcGuild] = useState(initial?.config.type === "discord" ? (initial.config.guild_id ?? "") : "");
  const [dcChannel, setDcChannel] = useState(initial?.config.type === "discord" ? (initial.config.channel_id ?? "") : "");

  // Webhook
  const [whSecret, setWhSecret] = useState(initial?.config.type === "webhook" ? initial.config.secret_env : "");
  const [whHeader, setWhHeader] = useState(initial?.config.type === "webhook" ? (initial.config.signature_header ?? "") : "");

  // Agent routing — comma-list of "@tag:agent" pairs, parsed on save.
  const [routing, setRouting] = useState(() => {
    const r = initial?.config.agent_routing ?? {};
    return Object.entries(r).map(([tag, agent]) => `${tag}:${agent}`).join(", ");
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tgTokenLooksRaw = tgToken.includes(":") || tgToken.length > 40;
  const dcTokenLooksRaw = dcToken.includes(".") || dcToken.length > 40;

  const save = async () => {
    setError(null);
    const finalName = isNew ? draftName.trim() : name;
    if (isNew && !NAME_RE.test(finalName)) {
      setError("name: alphanumeric / _ / - uniquement");
      return;
    }
    if (!defaultAgent) {
      setError("default_agent requis");
      return;
    }

    const parsedRouting: Record<string, string> = {};
    for (const pair of routing.split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = pair.match(/^(@?[A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*([A-Za-z0-9_-]+)$/);
      if (!m) { setError(`routing invalide: "${pair}" — utilise @tag:agent_id`); return; }
      const tag = m[1].startsWith("@") ? m[1] : `@${m[1]}`;
      parsedRouting[tag] = m[2];
    }
    const routingField = Object.keys(parsedRouting).length > 0 ? { agent_routing: parsedRouting } : {};

    let config: ChannelConfig;
    if (type === "telegram") {
      if (!tgToken.trim()) { setError("bot token requis"); return; }
      const ids = tgAllowed.split(",").map((s) => s.trim()).filter(Boolean)
        .map(Number).filter((n) => Number.isFinite(n));
      config = {
        type, default_agent: defaultAgent, ...routingField,
        ...(tgTokenLooksRaw ? { bot_token: tgToken.trim() } : { bot_token_env: tgToken.trim() }),
        ...(ids.length ? { allowed_chat_ids: ids } : {}),
      };
    } else if (type === "discord") {
      if (!dcToken.trim()) { setError("bot token env var requis"); return; }
      config = {
        type, default_agent: defaultAgent, ...routingField,
        bot_token_env: dcToken.trim(),
        ...(dcGuild.trim() ? { guild_id: dcGuild.trim() } : {}),
        ...(dcChannel.trim() ? { channel_id: dcChannel.trim() } : {}),
      };
    } else if (type === "webhook") {
      if (!whSecret.trim()) { setError("secret_env requis"); return; }
      config = {
        type, default_agent: defaultAgent, ...routingField,
        secret_env: whSecret.trim(),
        ...(whHeader.trim() ? { signature_header: whHeader.trim() } : {}),
      };
    } else {
      setError(`type non supporté côté UI: ${type}`);
      return;
    }

    setSaving(true);
    const res = await fetch(`/api/channels/${finalName}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    setSaving(false);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || j.error) { setError(j.error ?? `HTTP ${res.status}`); return; }
    onSaved(finalName);
  };

  const remove = async () => {
    setSaving(true);
    const res = await fetch(`/api/channels/${name}`, { method: "DELETE" });
    setSaving(false);
    if (res.ok) onDeleted();
    else setError("delete failed");
  };

  const meta = TYPE_META[type];
  const mosAgents = agents.filter((a) => a.source === "orchestria" || !a.source);

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <span style={{ color: meta.color, fontSize: 24, fontFamily: "var(--font-mono, monospace)" }}>{meta.glyph}</span>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>
            {isNew ? "New channel" : name}
          </h1>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
            channels / {isNew ? "new" : name} {running && !isNew && <span style={{ color: "var(--ok)", marginLeft: 6 }}>● ONLINE</span>}
          </div>
        </div>
        {!isNew && !confirmDelete && (
          <button onClick={() => setConfirmDelete(true)}
            style={{ background: "transparent", border: "1px solid var(--err)", color: "var(--err)", padding: "6px 12px", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>
            Delete
          </button>
        )}
        {confirmDelete && (
          <>
            <span style={{ fontSize: 11, color: "var(--err)" }}>Confirm?</span>
            <button onClick={remove} disabled={saving}
              style={{ background: "var(--err)", color: "#fff", border: 0, padding: "6px 12px", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>
              Yes, delete
            </button>
            <button onClick={() => setConfirmDelete(false)}
              style={{ background: "transparent", border: "1px solid var(--line)", color: "var(--text-dim)", padding: "6px 12px", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>
              Cancel
            </button>
          </>
        )}
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Name */}
        <Field label="NAME" hint="Identifiant interne · alphanumeric / _ / - · sera le nom du fichier .orchestria/channels/&lt;name&gt;.json">
          <input className="input mono" value={isNew ? draftName : name}
            onChange={(e) => setDraftName(e.target.value)} disabled={!isNew}
            placeholder="telegram-atlas" autoFocus={isNew} />
        </Field>

        {/* Type */}
        <Field label="TYPE">
          <div style={{ display: "flex", gap: 8 }}>
            {(["telegram", "discord", "webhook"] as ChannelType[]).map((t) => (
              <button key={t} onClick={() => isNew && setType(t)} disabled={!isNew}
                style={{
                  padding: "6px 12px", borderRadius: 4, fontSize: 12, cursor: isNew ? "pointer" : "default",
                  background: type === t ? "var(--bg-elev-2)" : "transparent",
                  border: `1px solid ${type === t ? TYPE_META[t].color : "var(--line)"}`,
                  color: type === t ? "var(--text)" : "var(--text-dim)",
                  opacity: !isNew && type !== t ? 0.4 : 1,
                }}>
                <span style={{ color: TYPE_META[t].color, marginRight: 6 }}>{TYPE_META[t].glyph}</span>
                {TYPE_META[t].label}
              </button>
            ))}
          </div>
        </Field>

        {/* Default agent */}
        <Field label="DEFAULT AGENT" hint="Quel agent reçoit les messages quand aucun @tag n'est utilisé.">
          <select className="input mono" value={defaultAgent} onChange={(e) => setDefaultAgent(e.target.value)}>
            {mosAgents.length === 0 && <option value="">(aucun agent)</option>}
            {mosAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
            ))}
          </select>
        </Field>

        {/* Type-specific */}
        {type === "telegram" && (
          <>
            <Field
              label={`BOT TOKEN ${tgToken ? (tgTokenLooksRaw ? "← token brut" : "← env var") : "(token brut OU nom de var d'env)"}`}
              hint={tgTokenLooksRaw
                ? `⚠ Stocké en clair dans .orchestria/channels/${isNew ? draftName : name}.json — préfère une env var.`
                : "Obtiens le token via @BotFather, mets-le dans .env.local sous ce nom."}>
              <input className="input mono"
                type={tgTokenLooksRaw ? "password" : "text"}
                value={tgToken} onChange={(e) => setTgToken(e.target.value)}
                placeholder="TELEGRAM_BOT_TOKEN  ou  1234567:ABCdef..." />
            </Field>
            <Field label="ALLOWED CHAT IDS" hint="CSV des chat_ids autorisés à parler au bot. Vide = tout le monde.">
              <input className="input mono" placeholder="123456789, 987654321"
                value={tgAllowed} onChange={(e) => setTgAllowed(e.target.value)} />
            </Field>
          </>
        )}

        {type === "discord" && (
          <>
            <Field label="BOT TOKEN ENV VAR" hint="Nom de la variable d'env contenant le token du bot Discord.">
              <input className="input mono"
                type={dcTokenLooksRaw ? "password" : "text"}
                value={dcToken} onChange={(e) => setDcToken(e.target.value)}
                placeholder="DISCORD_BOT_TOKEN" />
            </Field>
            <Field label="GUILD ID (optionnel)" hint="Restreindre le bot à un serveur Discord.">
              <input className="input mono" placeholder="123456789012345678"
                value={dcGuild} onChange={(e) => setDcGuild(e.target.value)} />
            </Field>
            <Field label="CHANNEL ID (optionnel)" hint="Restreindre les réponses à un canal spécifique.">
              <input className="input mono" placeholder="987654321098765432"
                value={dcChannel} onChange={(e) => setDcChannel(e.target.value)} />
            </Field>
            <div style={{ padding: "8px 12px", background: "rgba(88,101,242,0.08)", border: "1px solid rgba(88,101,242,0.2)", borderRadius: 4, fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
              ℹ Le handler Discord arrive dans le prochain commit. La config est saved mais aucun bot ne tourne encore.
            </div>
          </>
        )}

        {type === "webhook" && (
          <>
            <Field label="SECRET ENV VAR" hint="Variable d'env contenant le secret HMAC pour signer les requêtes entrantes.">
              <input className="input mono" placeholder="ORCHESTRIA_WEBHOOK_SECRET"
                value={whSecret} onChange={(e) => setWhSecret(e.target.value)} />
            </Field>
            <Field label="SIGNATURE HEADER (optionnel)" hint="Nom du header HTTP portant la signature. Défaut: x-orchestria-signature.">
              <input className="input mono" placeholder="x-orchestria-signature"
                value={whHeader} onChange={(e) => setWhHeader(e.target.value)} />
            </Field>
          </>
        )}

        {/* Agent routing (advanced) */}
        <Field
          label="AGENT ROUTING (optionnel)"
          hint='CSV de paires "@tag:agent_id". Quand un message commence par @tag, il est routé vers cet agent au lieu du default. Ex: "@research:atlas, @ops:ledger".'>
          <input className="input mono" placeholder="@research:atlas, @ops:ledger"
            value={routing} onChange={(e) => setRouting(e.target.value)} />
        </Field>

        {/* Subscribers (read-only summary) */}
        {!isNew && subscribers.length > 0 && (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: 6 }}>
            <div style={{ fontSize: 10, color: "var(--text-faint)", letterSpacing: "0.05em", marginBottom: 8 }}>
              SUBSCRIBERS · {subscribers.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {subscribers.map((s) => (
                <div key={s.chat_id} style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", gap: 8, fontFamily: "var(--font-mono, monospace)" }}>
                  <span>{s.chat_id}</span>
                  {(s.first_name || s.username) && (
                    <span style={{ color: "var(--text-faint)" }}>
                      — {s.first_name ?? ""}{s.username ? ` @${s.username}` : ""}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: 10 }}>{s.message_count} msg</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        {error && (
          <div style={{ padding: "8px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid var(--err)", borderRadius: 4, fontSize: 12, color: "var(--err)" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={save} disabled={saving}
            style={{ background: "var(--accent)", color: "#0a0a0a", border: 0, padding: "8px 16px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            {saving ? "…" : isNew ? "Create channel" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 6, letterSpacing: "0.05em" }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

function ChannelsPageInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const selectedName = sp.get("name");

  const [data, setData] = useState<ChannelsResponse | null>(null);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    const [chRes, agRes] = await Promise.all([
      fetch("/api/channels").then((r) => r.json() as Promise<ChannelsResponse>),
      fetch("/api/agents").then((r) => r.json() as Promise<AgentConfig[]>),
    ]);
    setData(chRes);
    setAgents(agRes);
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  const select = (name: string | null) => {
    if (!name) router.replace("/channels");
    else router.replace(`/channels?name=${encodeURIComponent(name)}`);
  };

  const isRunning = (name: string) => data?.running.some((r) => r.name === name) ?? false;
  const subsFor = (name: string) => data?.subscribers[name] ?? [];

  const selectedEntry = useMemo(() => {
    if (!selectedName || selectedName === NEW_SENTINEL) return null;
    return data?.configured.find((c) => c.name === selectedName) ?? null;
  }, [selectedName, data]);

  // Group by type so the rail reads "Telegram (3) · Discord (1) · Webhook (2)".
  const groups = useMemo(() => {
    const byType = new Map<ChannelType, ChannelEntry[]>();
    for (const e of data?.configured ?? []) {
      const arr = byType.get(e.config.type) ?? [];
      arr.push(e);
      byType.set(e.config.type, arr);
    }
    return Array.from(byType.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  if (loading) return <div style={{ padding: 40, color: "var(--text-faint)" }}>Loading channels…</div>;

  const isNew = selectedName === NEW_SENTINEL;
  const showEditor = isNew || selectedEntry;

  return (
    <div style={{ display: "flex", minHeight: "calc(100vh - 56px)" }}>
      {/* Rail */}
      <aside style={{ width: 320, borderRight: "1px solid var(--line)", padding: 16, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 13, letterSpacing: "0.08em", color: "var(--text-faint)" }}>CHANNELS</h2>
          <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
            {data?.configured.length ?? 0} configured · {data?.running.length ?? 0} running
          </span>
        </div>

        <button onClick={() => select(NEW_SENTINEL)}
          style={{
            width: "100%", marginBottom: 16, padding: "10px 12px", borderRadius: 6, fontSize: 12,
            background: isNew ? "var(--bg-elev-2)" : "transparent",
            border: `1px dashed ${isNew ? "var(--accent)" : "var(--line-strong)"}`,
            color: isNew ? "var(--accent)" : "var(--text-dim)",
            cursor: "pointer", letterSpacing: "0.04em",
          }}>
          + New channel
        </button>

        {groups.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-faint)", padding: "8px 4px", lineHeight: 1.6 }}>
            No channels yet.<br />
            Create one to receive Telegram, Discord or webhook messages.
          </div>
        ) : groups.map(([t, entries]) => (
          <div key={t} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "var(--text-faint)", letterSpacing: "0.06em", marginBottom: 6 }}>
              {TYPE_META[t].label.toUpperCase()} · {entries.length}
            </div>
            {entries.map((e) => (
              <ChannelItem key={e.name} entry={e}
                running={isRunning(e.name)}
                subsCount={subsFor(e.name).length}
                active={selectedName === e.name}
                onSelect={() => select(e.name)} />
            ))}
          </div>
        ))}
      </aside>

      {/* Editor */}
      <main style={{ flex: 1, overflowY: "auto" }}>
        {showEditor ? (
          <ChannelEditor
            key={selectedName ?? "new"}
            name={selectedEntry?.name ?? ""}
            initial={selectedEntry}
            agents={agents}
            running={selectedEntry ? isRunning(selectedEntry.name) : false}
            subscribers={selectedEntry ? subsFor(selectedEntry.name) : []}
            onSaved={(newName) => { reload(); select(newName); }}
            onDeleted={() => { reload(); select(null); }}
          />
        ) : (
          <div style={{ padding: 40, color: "var(--text-faint)", maxWidth: 560 }}>
            <h2 style={{ margin: 0, fontSize: 14, color: "var(--text-dim)" }}>Select a channel on the left, or create a new one.</h2>
            <p style={{ fontSize: 12, lineHeight: 1.6, marginTop: 16 }}>
              Channels are stored as JSON files in <code className="mono">.orchestria/channels/</code>.
              Each file is one independent listener — so you can run, for instance, three
              separate Telegram bots (<code className="mono">telegram-atlas.json</code>,{" "}
              <code className="mono">telegram-ledger.json</code>,{" "}
              <code className="mono">telegram-main.json</code>), each bound to a different
              <code className="mono"> default_agent</code>.
            </p>
            <p style={{ fontSize: 12, lineHeight: 1.6 }}>
              Bot credentials (tokens, secrets) live in those files — they are git-ignored.
              Only <code className="mono">*.json.example</code> is tracked.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

export default function ChannelsPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: "var(--text-faint)" }}>Loading…</div>}>
      <ChannelsPageInner />
    </Suspense>
  );
}
