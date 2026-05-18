import type Database from "better-sqlite3";
import { getDb } from "../db";

/**
 * Fleet digest (moat, loop 2 — the *visible* weekly value).
 *
 * A routine prompt may contain `{{FLEET_STATS}}` (or `{{FLEET_STATS:N}}` for
 * an N-day window). At fire time the scheduler expands it into a real
 * activity summary computed from `missions`. The agent then turns that into
 * a digest and the existing notify path pushes it to Telegram — no new
 * scheduling or channel machinery, and nothing leaves the machine.
 *
 * `computeFleetStats` takes a db handle (no singleton, no I/O beyond the
 * query) so it is unit-testable against an in-memory database.
 */

interface Row {
  agent_id: string;
  status: string;
  cost_usd: number | null;
}

export function computeFleetStats(
  db: Database.Database,
  nowMs: number,
  windowDays = 7,
): string {
  const cutoff = Math.floor(nowMs / 1000) - windowDays * 86_400;
  const since = new Date(cutoff * 1000).toISOString().slice(0, 10);
  const rows = db
    .prepare(`SELECT agent_id, status, cost_usd FROM missions WHERE start_ts >= ?`)
    .all(cutoff) as Row[];

  const head = `**Fleet activity — last ${windowDays}d** (since ${since})`;
  if (rows.length === 0) return `${head}\n\nNo agent activity in this window.`;

  let totalCost = 0;
  let failures = 0;
  const byAgent = new Map<string, { n: number; cost: number; fail: number }>();
  for (const r of rows) {
    const cost = typeof r.cost_usd === "number" ? r.cost_usd : 0;
    const failed = r.status === "failed" || r.status === "halted";
    totalCost += cost;
    if (failed) failures++;
    const a = byAgent.get(r.agent_id) ?? { n: 0, cost: 0, fail: 0 };
    a.n++;
    a.cost += cost;
    if (failed) a.fail++;
    byAgent.set(r.agent_id, a);
  }

  const agents = [...byAgent.entries()].sort(
    (x, y) => y[1].n - x[1].n || x[0].localeCompare(y[0]),
  );

  return [
    head,
    "",
    `- Missions: ${rows.length}${failures ? ` (${failures} failed)` : ""}`,
    `- Spend: $${totalCost.toFixed(4)}`,
    "",
    "By agent:",
    ...agents.map(
      ([id, s]) =>
        `- ${id}: ${s.n} mission${s.n === 1 ? "" : "s"}, $${s.cost.toFixed(4)}` +
        (s.fail ? `, ${s.fail} failed` : ""),
    ),
  ].join("\n");
}

function buildFleetStats(windowDays: number): string {
  return computeFleetStats(getDb(), Date.now(), windowDays);
}

const FLEET_RE = /\{\{FLEET_STATS(?::(\d+))?\}\}/g;

/**
 * Replace `{{FLEET_STATS}}` / `{{FLEET_STATS:N}}` in a routine prompt with a
 * freshly-computed activity summary. No token → returned unchanged and the
 * database is never touched (keeps normal routine fires free).
 */
export function expandRoutinePlaceholders(prompt: string): string {
  if (!prompt.includes("{{FLEET_STATS")) return prompt;
  return prompt.replace(FLEET_RE, (_m, days?: string) =>
    buildFleetStats(days ? Number(days) : 7),
  );
}
