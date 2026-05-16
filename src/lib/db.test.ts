import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./db";

function cols(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

describe("applySchema (migration idempotency + legacy healing)", () => {
  it("creates the full schema on a fresh database", () => {
    const db = new Database(":memory:");
    applySchema(db);

    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
        .map((r) => r.name),
    );
    for (const t of ["missions", "events", "remote_tokens", "kanban_cards", "routines"]) {
      expect(tables.has(t)).toBe(true);
    }
    // ensureColumn-added columns are present
    expect(cols(db, "missions")).toContain("kind");
    expect(cols(db, "missions")).toContain("routine_id");
    expect(cols(db, "routines")).toContain("interval_seconds");
    expect(cols(db, "routines")).toContain("target_chat_ids");
  });

  it("is idempotent — running repeatedly is stable and never throws", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const after1 = cols(db, "missions");
    expect(() => {
      applySchema(db);
      applySchema(db);
    }).not.toThrow();
    expect(cols(db, "missions")).toEqual(after1);

    // schema is usable: insert + read back, `kind` defaults to 'mission'
    db.prepare(`INSERT INTO missions (id, agent_id, title) VALUES (?, ?, ?)`)
      .run("m1", "_main", "hello");
    const row = db.prepare(`SELECT id, kind FROM missions WHERE id = ?`).get("m1") as
      { id: string; kind: string };
    expect(row).toEqual({ id: "m1", kind: "mission" });
  });

  it("heals a legacy routines table (title→name, cron→cron_expr, enabled→paused, backfills)", () => {
    const db = new Database(":memory:");
    // Old raw-SQL shape that early agents created.
    db.exec(`CREATE TABLE routines (
      id TEXT PRIMARY KEY, title TEXT, cron TEXT, enabled INTEGER, agent_id TEXT
    )`);
    db.prepare(`INSERT INTO routines (id, title, cron, enabled, agent_id) VALUES (?, ?, ?, ?, ?)`)
      .run("r-on", "Daily digest", "0 8 * * *", 1, "_main");
    db.prepare(`INSERT INTO routines (id, title, cron, enabled, agent_id) VALUES (?, ?, ?, ?, ?)`)
      .run("r-off", "Paused job", "0 9 * * *", 0, "_main");

    applySchema(db);

    const c = cols(db, "routines");
    expect(c.has("name")).toBe(true);
    expect(c.has("cron_expr")).toBe(true);
    expect(c.has("title")).toBe(false);
    expect(c.has("cron")).toBe(false);
    expect(c.has("paused")).toBe(true);

    const on = db.prepare(`SELECT name, cron_expr, paused, prompt, next_run_ts FROM routines WHERE id = ?`)
      .get("r-on") as { name: string; cron_expr: string; paused: number; prompt: string; next_run_ts: number | null };
    expect(on.name).toBe("Daily digest");
    expect(on.cron_expr).toBe("0 8 * * *");
    expect(on.paused).toBe(0);                 // enabled=1 → not paused
    expect(on.prompt).toBe("Daily digest");    // backfilled from name
    expect(on.next_run_ts).not.toBeNull();     // scheduler will pick it up

    const off = db.prepare(`SELECT paused, next_run_ts FROM routines WHERE id = ?`)
      .get("r-off") as { paused: number; next_run_ts: number | null };
    expect(off.paused).toBe(1);                // enabled=0 → paused
    expect(off.next_run_ts).toBeNull();        // paused rows aren't scheduled
  });
});
