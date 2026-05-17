const buckets = new Map<string, { count: number; resetAt: number }>();

// Hard ceiling on distinct keys held in memory. A churn of unique keys
// (e.g. many short-lived jti values) must not grow this map unbounded.
const MAX_BUCKETS = 10_000;

function sweepExpired(now: number): void {
  for (const [k, b] of buckets) {
    if (b.resetAt < now) buckets.delete(k);
  }
}

export function rateLimit(key: string, limit = 10, windowMs = 1000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    if (buckets.size >= MAX_BUCKETS) sweepExpired(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

/** Test/diagnostic hooks — not part of the public rate-limit API. */
export const _internals = {
  sweepExpired,
  count: () => buckets.size,
  clear: () => buckets.clear(),
};
