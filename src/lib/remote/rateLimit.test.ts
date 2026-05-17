import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, _internals } from "./rateLimit";

beforeEach(() => _internals.clear());

describe("rateLimit", () => {
  it("allows up to `limit` calls in the window, then blocks", () => {
    for (let i = 0; i < 5; i++) expect(rateLimit("k", 5, 60_000)).toBe(true);
    expect(rateLimit("k", 5, 60_000)).toBe(false);
  });

  it("resets after the window elapses", async () => {
    expect(rateLimit("k", 1, 5)).toBe(true);
    expect(rateLimit("k", 1, 5)).toBe(false);
    await new Promise((r) => setTimeout(r, 8));
    expect(rateLimit("k", 1, 5)).toBe(true);
  });

  it("does not retain expired buckets (no unbounded growth)", () => {
    for (let i = 0; i < 50; i++) rateLimit(`key-${i}`, 10, 1000);
    expect(_internals.count()).toBe(50);
    // All buckets expire by now+2000; sweeping must drop every one.
    _internals.sweepExpired(Date.now() + 2000);
    expect(_internals.count()).toBe(0);
  });
});
