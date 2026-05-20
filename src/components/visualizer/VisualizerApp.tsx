"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import AgentGraph from "./AgentGraph";
import StatOverlay from "./StatOverlay";
import Legend from "./Legend";
import ZoomControls from "./ZoomControls";
import DetailPanel from "./DetailPanel";
import Console from "./Console";
import MeshToolbar from "./MeshToolbar";
import { TweaksPanel, TweakSection, TweakToggle, TweakRadio, TweakColor, useTweaks } from "./TweaksPanel";
import { type Agent, type AgentConfig, type AgentLiveState, type StreamEvent } from "@/lib/mock-data";

function synthesizeAgent(config: AgentConfig, index: number): Agent {
  const role = inferRole(config.id);
  return {
    id: config.id,
    name: config.name,
    glyph: config.glyph || config.name.charAt(0).toUpperCase() || "?",
    role,
    status: "idle",
    task: "",
    progress: 0,
    tokens: 0,
    cost: 0,
    runtime: "0s",
    model: config.model,
    tools: config.allowedTools,
    pinned: config.id === "_main" || index === 0,
    source: config.source,
  };
}

function summarizeEvent(ev: { type: string; payload: unknown }): string | null {
  if (ev.type === "MissionComplete") {
    const p = ev.payload as { status?: string; exitCode?: number };
    return `mission ${p.status ?? "done"} (exit ${p.exitCode ?? 0})`;
  }
  if (ev.type === "assistant") {
    const p = ev.payload as { message?: { content?: Array<{ type?: string; text?: string; name?: string }> } };
    const content = p.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          return c.text.trim().slice(0, 120);
        }
        if (c?.type === "tool_use" && c.name) return `↗ ${c.name}`;
      }
    }
    return "assistant ▍";
  }
  if (ev.type === "user") {
    const p = ev.payload as { message?: { content?: Array<{ type?: string; content?: unknown }> } };
    const content = p.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === "tool_result") return "↙ tool result";
      }
    }
    return null;
  }
  if (ev.type === "system") return "system init";
  if (ev.type === "result") {
    const p = ev.payload as { result?: string };
    return typeof p.result === "string" ? p.result.slice(0, 120) : "result";
  }
  return null;
}

function inferRole(id: string): Agent["role"] {
  if (id === "_main" || id === "kernel") return "orchestrator";
  if (id === "atlas" || id === "scout") return "retriever";
  if (id === "loom") return "reasoner";
  if (id === "ledger" || id === "harbor" || id === "warden") return "sentinel";
  if (id === "echo" || id === "mosaic") return "scribe";
  return "executor";
}

type FilterKey = "all" | "info" | "ok" | "warn" | "err" | "tool";

const TWEAK_DEFAULTS = {
  showLabels: true,
  edgeMode: "curved" as "curved" | "straight",
  accent: "#E07A5F",
};

const PULSE_RATE = 2.6;

export default function VisualizerApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS, "orchestria-tweaks-settings");

  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentMap, setAgentMap] = useState<Record<string, AgentLiveState>>({});
  const [edges, setEdges] = useState<[string, string, number][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showNative, setShowNative] = useState(false);
  const [allCfgs, setAllCfgs] = useState<AgentConfig[]>([]);

  useEffect(() => {
    fetch("/api/agents?native=1")
      .then((r) => r.json())
      .then((cfgs: AgentConfig[]) => {
        setAllCfgs(cfgs);
      });
  }, []);

  useEffect(() => {
    // showNative = agents natifs seulement (source="agent"), PAS les skills (source="skill")
    const cfgs = showNative
      ? allCfgs.filter((c) => c.source !== "skill")
      : allCfgs.filter((c) => c.source === "orchestria" || !c.source);
    const list = cfgs.map((c, i) => synthesizeAgent(c, i));
    setAgents(list);
    const map: Record<string, AgentLiveState> = {};
    for (const a of list) map[a.id] = { ...a };
    setAgentMap((prev) => {
      // preserve live status from previous map
      const next: Record<string, AgentLiveState> = {};
      for (const a of list) next[a.id] = prev[a.id] ?? { ...a };
      return next;
    });

    const ids = new Set(cfgs.map((c) => c.id));
    const rootId = cfgs.find((c) => c.id === "_main")?.id ?? cfgs[0]?.id;
    const derived: [string, string, number][] = [];
    for (const c of cfgs) {
      if (c.source === "skill" || c.source === "agent") {
        // native agents connect to _main (or root) with a lighter weight
        if (rootId && rootId !== c.id) derived.push([rootId, c.id, 0.3]);
      } else {
        const parentId = c.parent ?? (c.id !== rootId ? rootId : undefined);
        if (parentId && ids.has(parentId) && parentId !== c.id) {
          derived.push([parentId, c.id, 1]);
        }
      }
    }
    setEdges(derived);
  }, [allCfgs, showNative]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [consoleFocus, setConsoleFocus] = useState<string | null>(null);
  const [dims, setDims] = useState({ width: 1400, height: 800 });
  const zoomRef = useRef<{ in: () => void; out: () => void; home: () => void } | null>(null);

  useEffect(() => {
    const onR = () => setDims({ width: window.innerWidth, height: window.innerHeight });
    onR();
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);

  const stats = useMemo(() => {
    const vals = Object.values(agentMap);
    const active = vals.filter((v) => v.status === "active").length;
    const tokens = vals.reduce((s, v) => s + v.tokens, 0);
    const cost = vals.reduce((s, v) => s + v.cost, 0);
    return {
      total: vals.length,
      active,
      tokens,
      cost,
      tps: 0,
      latency: 0,
      spark: Array.from({ length: 28 }, () => 0),
    };
  }, [agentMap]);

  const [events, setEvents] = useState<StreamEvent[]>([]);
  const selectedAgent = agents.find((a) => a.id === selected) || null;

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", t.accent);
    document.documentElement.style.setProperty("--accent-soft", t.accent + "29");
  }, [t.accent]);

  // global live event stream → updates agentMap status + console
  useEffect(() => {
    const es = new EventSource("/api/live/stream");
    let counter = 0;
    es.onmessage = (msg) => {
      const { agentId, event } = JSON.parse(msg.data) as {
        missionId: string;
        agentId: string;
        event: { type: string; timestamp: number; payload: unknown };
      };
      if (!agentId) return;

      // derive status from event type
      const t = event.type;
      let nextStatus: "active" | "waiting" | "err" | "idle" | null = null;
      let lvl: StreamEvent["lvl"] = "info";
      if (t === "MissionComplete") {
        const p = event.payload as { status?: string };
        nextStatus = p.status === "failed" ? "err" : "idle";
        lvl = p.status === "failed" ? "err" : "ok";
      } else if (t === "system" || t === "user") {
        nextStatus = "active";
      } else if (t === "assistant" || t === "result") {
        nextStatus = "active";
        lvl = "ok";
      } else if (t === "tool_use" || t === "tool_result") {
        nextStatus = "active";
        lvl = "tool";
      }

      if (nextStatus) {
        setAgentMap((prev) => ({
          ...prev,
          [agentId]: { ...(prev[agentId] ?? { id: agentId } as AgentLiveState), status: nextStatus! },
        }));
      }

      // build a console line
      const summary = summarizeEvent(event);
      if (summary) {
        setEvents((prev) => {
          const next: StreamEvent = {
            id: ++counter,
            ts: new Date(event.timestamp).toLocaleTimeString(),
            lvl,
            agent: agentId,
            parts: [summary],
          };
          return [...prev.slice(-199), next];
        });
      }
    };
    es.onerror = () => { /* auto-reconnects */ };
    return () => es.close();
  }, []);

  const handleZoomRef = useCallback((api: { in: () => void; out: () => void; home: () => void }) => {
    zoomRef.current = api;
  }, []);

  const clearKernel = useCallback(async () => {
    // Empty the event log and bring every agent back to idle. Existing pulses
    // are not torn down explicitly — once their source agent is idle, useTraffic
    // stops spawning new ones and the in-flight pulses fade out within ~1s.
    setEvents([]);
    setAgentMap((prev) => {
      const next: Record<string, AgentLiveState> = {};
      for (const [id, a] of Object.entries(prev)) next[id] = { ...a, status: "idle" };
      return next;
    });
    // Best-effort flush of the server replay buffer so the *next* time the
    // page is opened it does not re-hydrate stale activity.
    await fetch("/api/live/clear", { method: "POST" }).catch(() => { /* non-fatal */ });
  }, []);

  return (
    <div className="viz-root">
      <AgentGraph
        agents={agents}
        agentMap={agentMap}
        edges={edges}
        selected={selected}
        onSelect={(id) => setSelected((s) => (s === id ? null : id))}
        dims={dims}
        showLabels={t.showLabels}
        edgeMode={t.edgeMode}
        pulseRate={PULSE_RATE}
        onZoomRef={handleZoomRef}
      />

      <div className="frame">
        <StatOverlay stats={stats} />
        <Legend />
        <ZoomControls
          onZoomIn={() => zoomRef.current?.in()}
          onZoomOut={() => zoomRef.current?.out()}
          onZoomHome={() => zoomRef.current?.home()}
        />
        {/* Commander disabled — MeshToolbar handles the same spawn/run action at the top */}
        {/* <Commander onSubmit={(text) => console.log("commander:", text)} /> */}
        <MeshToolbar
          selectedAgent={allCfgs.find((c) => c.id === selected) ?? null}
          mosAgents={allCfgs.filter((c) => c.source === "orchestria" || !c.source)}
          onAgentCreated={(cfg) => {
            setAllCfgs((prev) => [...prev, cfg]);
            setSelected(cfg.id);
          }}
          onAgentRemoved={(id) => {
            setAllCfgs((prev) => prev.filter((c) => c.id !== id));
            setSelected(null);
          }}
          onMissionSpawned={(mid) => console.log("mission spawned:", mid)}
        />
        <DetailPanel
          agent={selectedAgent}
          agentMap={agentMap}
          agents={agents}
          edges={edges}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
        <Console
          events={events}
          filter={filter}
          setFilter={setFilter}
          focusAgent={consoleFocus}
          onPickAgent={setConsoleFocus}
          onClear={clearKernel}
        />
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Display" />
        <TweakToggle label="Node labels" value={t.showLabels} onChange={(v) => setTweak("showLabels", v)} />
        <TweakToggle label="Agents natifs" value={showNative} onChange={setShowNative} />
        <TweakRadio label="Edges" value={t.edgeMode} options={["curved", "straight"]} onChange={(v) => setTweak("edgeMode", v as "curved" | "straight")} />
        <TweakColor label="Accent" value={t.accent}
          options={["#E07A5F", "#7ec5ff", "#8be38b", "#c89cff", "#e6b85c"]}
          onChange={(v) => setTweak("accent", v)} />
      </TweaksPanel>
    </div>
  );
}
