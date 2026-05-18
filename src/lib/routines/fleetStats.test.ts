import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db";
import { computeFleetStats, expandRoutinePlaceholders } from "./fleetStats";

const NOW = Date.UTC(2026, 4, 18) ; // 2026-05-18
const DAY = 86_400;

function seed(db: Database.Database) {
  const nowSec = Math.floor(NOW / 1000);
  const ins = db.prepare(
    `INSERT INTO missions (id, agent_id, title, status, cost_usd, start_ts) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // in-window (last 7d)
  ins.run("m1", "_main", "t", "done", 0.5, nowSec - 1 * DAY);
  ins.run("m2", "_main", "t", "failed", 0.25, nowSec - 2 * DAY);
  ins.run("m3", "_main", "t", "done", 0.25, nowSec - 3 * DAY);
  ins.run("m4", "pinger", "t", "halted", 0.1, nowSec - 1 * DAY);
  // out-of-window (older than 7d) — must be excluded
  ins.run("m5", "_main", "t", "done", 99, nowSec - 30 * DAY);
}

describe("computeFleetStats", () => {
  it("aggregates in-window missions, excludes older ones, sorts by count", () => {
    const db = new Database(":memory:");
    applySchema(db);
    seed(db);

    const out = computeFleetStats(db, NOW, 7);
    expect(out).toContain("last 7d");
    expect(out).toContain("Missions: 4 (2 failed)"); // m1..m4, m2+m4 failed; m5 excluded
    expect(out).toContain("Spend: $1.1000"); // 0.5+0.25+0.25+0.1, excludes the $99
    // _main (3) before pinger (1); failures annotated
    const mainIdx = out.indexOf("- _main: 3 missions, $1.0000, 1 failed");
    const pingIdx = out.indexOf("- pinger: 1 mission, $0.1000, 1 failed");
    expect(mainIdx).toBeGreaterThan(-1);
    expect(pingIdx).toBeGreaterThan(mainIdx);
  });

  it("reports an empty window cleanly", () => {
    const db = new Database(":memory:");
    applySchema(db);
    expect(computeFleetStats(db, NOW, 7)).toContain("No agent activity in this window.");
  });
});

describe("expandRoutinePlaceholders", () => {
  it("returns the prompt untouched (and never hits the DB) when no token", () => {
    const p = "Just a normal routine prompt with no placeholder.";
    expect(expandRoutinePlaceholders(p)).toBe(p);
  });
});
