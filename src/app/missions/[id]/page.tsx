"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

interface MissionDetail {
  mission: {
    id: string;
    agent_id: string;
    title: string;
    status: string;
    start_ts: number;
    end_ts: number | null;
    source_channel: string | null;
  };
  events: { id: number; ts: number; kind: string; payload: unknown }[];
  live: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  running: "var(--ok)",
  pending: "var(--warn)",
  done: "var(--text-faint)",
  failed: "var(--err)",
  halted: "var(--warn)",
};

export default function MissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<MissionDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const TERMINAL = new Set(["done", "failed", "halted"]);
    const load = () => {
      fetch(`/api/missions/${id}`)
        .then((r) => {
          if (r.status === 404) { setNotFound(true); return null; }
          return r.json();
        })
        .then((d: MissionDetail | null) => {
          if (!d) return;
          setData(d);
          if (TERMINAL.has(d.mission.status) && t !== null) {
            clearInterval(t);
            t = null;
          }
        });
    };
    load();
    t = setInterval(load, 2000);
    return () => { if (t !== null) clearInterval(t); };
  }, [id]);

  if (notFound) {
    return (
      <div style={{ padding: 40, color: "var(--text-faint)" }}>
        Mission <span className="mono">{id}</span> not found.{" "}
        <Link href="/missions" style={{ color: "var(--accent)" }}>← Back</Link>
      </div>
    );
  }
  if (!data) return <div style={{ padding: 40, color: "var(--text-faint)" }}>Loading…</div>;
  const { mission, events } = data;

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 24px" }}>
      <Link href="/missions" style={{ fontSize: 12, color: "var(--text-faint)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 20 }}>
        ← Missions
      </Link>

      <div className="os-card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h1 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600 }}>{mission.title}</h1>
            <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
              {mission.id} · {mission.agent_id}{mission.source_channel ? ` · via ${mission.source_channel}` : ""}
            </div>
          </div>
          <span style={{ fontSize: 12, color: STATUS_COLORS[mission.status] ?? "var(--text-faint)", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLORS[mission.status] ?? "var(--text-faint)", display: "inline-block" }} />
            {mission.status}
          </span>
        </div>
      </div>

      <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-dim)", marginBottom: 12 }}>
        Events ({events.length})
      </h2>
      {events.length === 0 ? (
        <div style={{ color: "var(--text-faint)", fontSize: 13, padding: "20px 0" }}>No events yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {events.map((e) => (
            <details key={e.id} style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg-elev)" }}>
              <summary style={{ cursor: "pointer", display: "flex", gap: 12, fontSize: 12, alignItems: "center" }}>
                <span className="mono" style={{ color: "var(--text-faint)", flexShrink: 0 }}>
                  {new Date(e.ts * 1000).toLocaleTimeString()}
                </span>
                <span className="mono" style={{ color: "var(--accent)", flexShrink: 0 }}>{e.kind}</span>
              </summary>
              <pre className="mono" style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
