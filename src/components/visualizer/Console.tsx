"use client";

import { useRef, useState, useMemo, useEffect } from "react";
import type { StreamEvent } from "@/lib/mock-data";

type FilterKey = "all" | "info" | "ok" | "warn" | "err" | "tool";

interface Props {
  events: StreamEvent[];
  filter: FilterKey;
  setFilter: (f: FilterKey) => void;
  focusAgent: string | null;
  onPickAgent: (id: string | null) => void;
  onClear?: () => void;
}

export default function Console({ events, filter, setFilter, focusAgent, onPickAgent, onClear }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [autoscroll, setAutoscroll] = useState(true);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: events.length, info: 0, ok: 0, warn: 0, err: 0, tool: 0 };
    for (const e of events) if (c[e.lvl] !== undefined) c[e.lvl]++;
    return c;
  }, [events]);

  const filtered = useMemo(() => {
    let evs = events;
    if (filter !== "all") evs = evs.filter((e) => e.lvl === filter);
    if (focusAgent) evs = evs.filter((e) => e.agent === focusAgent);
    return evs.slice(-160);
  }, [events, filter, focusAgent]);

  useEffect(() => {
    if (autoscroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [filtered, autoscroll]);

  return (
    <div className="console">
      <div className="console-hd">
        <div className="title"><span className="d" />kernel.events</div>
        <span style={{ color: "var(--text-faint)", marginLeft: 6 }}>
          streaming → .orchestria/runs/2026-05-11T14-22.jsonl
        </span>
        {focusAgent && (
          <span className="pill" style={{ marginLeft: 12 }}>
            <span style={{ color: "var(--text-faint)" }}>focus:</span>
            <span className="mono">{focusAgent}</span>
            <span onClick={() => onPickAgent(null)} style={{ cursor: "default", marginLeft: 4 }}>×</span>
          </span>
        )}
        <div className="filter-tabs">
          {(["all", "info", "ok", "warn", "err", "tool"] as FilterKey[]).map((k) => (
            <div key={k} className={`ftab${filter === k ? " active" : ""}`} onClick={() => setFilter(k)}>
              <span>{k}</span><span className="c">{counts[k] ?? 0}</span>
            </div>
          ))}
          <label className="ftab" style={{ cursor: "default", marginLeft: 6 }}>
            <input type="checkbox" checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
              style={{ accentColor: "#E07A5F", width: 11, height: 11 }} />
            auto-scroll
          </label>
          {onClear && (
            <button
              className="ftab"
              onClick={onClear}
              title="Clear the kernel: reset mesh activity and event log"
              style={{ marginLeft: 6, cursor: "pointer", border: 0, background: "transparent", color: "var(--text-faint)" }}>
              <span style={{ marginRight: 4 }}>×</span>clear
            </button>
          )}
        </div>
      </div>
      <div className="console-body" ref={bodyRef}>
        {filtered.map((e) => (
          <div key={e.id} className={`evt ${e.lvl}`}>
            <span className="ts mono">{e.ts}</span>
            <span className="agent mono" onClick={() => onPickAgent(e.agent)} style={{ cursor: "default" }}>
              <span className="lvl">{e.lvl.toUpperCase().padEnd(4, " ")}</span>{e.agent}
            </span>
            <span className="msg">
              {e.boot
                ? <span className="arg mono">{e.parts[0]}</span>
                : e.parts.map((p, i) => (
                  <span key={i}>
                    {i > 0 && <span className="arrow"> </span>}
                    <span className={i === 0 ? "mono" : i === 1 ? "arg mono" : "mono"}
                      style={i === 0 ? { color: "var(--text)" } : i === 1 ? { color: "var(--accent)" } : { color: "var(--text-dim)" }}>
                      {p}
                    </span>
                  </span>
                ))
              }
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
