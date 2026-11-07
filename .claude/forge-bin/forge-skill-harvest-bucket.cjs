'use strict';
// forge-skill-harvest-bucket.cjs — one shared token bucket per GitHub rate-limit resource (SA-HARVEST-FAST).
// Parallel workers in one process all draw from the same bucket, so together they never exceed the documented limits:
//   core 5000 requests/h, GraphQL 5000 points/h, search 30/min, code search 10/min (docs.github.com, "Rate limits for the
//   REST API" and "Rate limits and query limits for the GraphQL API"), plus the documented secondary per-minute caps
//   (REST 900 points/min, GraphQL 2000 points/min). The server's own x-ratelimit-* numbers override the local count, so
//   other processes on the same account (another enumerate, the fetch shards) are counted too. One account, one token:
//   this never rotates accounts or tokens to get around a limit.
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const LIMITS = {
  core: { windows: [{ cap: 5000, ms: HOUR }, { cap: 900, ms: MIN }], minGapMs: 0 },
  graphql: { windows: [{ cap: 5000, ms: HOUR }, { cap: 2000, ms: MIN }], minGapMs: 300 },
  search: { windows: [{ cap: 30, ms: MIN }], minGapMs: 2000 },
  code_search: { windows: [{ cap: 10, ms: MIN }], minGapMs: 6000 },
};
const MAX_WAIT_MS = 65 * MIN;

// createBucket(spec, clock) -> { acquire(n), observe({ remaining, resetMs }), snapshot() }.
// clock = { now(), sleep(ms) }. acquire() calls are serialised, so concurrent workers cannot overspend.
function createBucket(spec, clock) {
  const wins = spec.windows.map((w) => ({ cap: w.cap, ms: w.ms, used: 0, start: null }));
  const gap = spec.minGapMs || 0;
  let last = null; let chain = Promise.resolve();

  const roll = (now) => wins.forEach((w) => { if (w.start === null || now - w.start >= w.ms) { w.start = now; w.used = 0; } });
  // `t` only moves forward: after a sleep it is at least the time we slept until, so a clock that lags (or a test
  // clock that never moves) cannot make this loop spin.
  async function take(n) {
    let t = Math.max(clock.now(), last === null ? -Infinity : last);
    for (;;) {
      roll(t);
      let wait = last === null ? 0 : last + gap - t;
      for (const w of wins) if (w.used > 0 && w.used + n > w.cap) wait = Math.max(wait, w.start + w.ms - t);
      if (wait <= 0) break;
      const nap = Math.min(wait, MAX_WAIT_MS);
      await clock.sleep(nap);
      t = Math.max(clock.now(), t + nap);
    }
    wins.forEach((w) => { w.used += n; });
    last = t;
  }
  return {
    acquire(n = 1) {
      const cost = Math.max(1, Math.ceil(Number(n) || 1));
      const p = chain.then(() => take(cost));
      chain = p.catch(() => {});
      return p;
    },
    // Sync the long window with what the server says is left until its reset.
    observe({ remaining, resetMs }) {
      const w = wins[0];
      if (!Number.isFinite(remaining) || !Number.isFinite(resetMs) || remaining < 0) return;
      w.start = resetMs - w.ms;
      w.used = Math.max(0, w.cap - remaining);
    },
    snapshot: () => wins.map((w) => ({ cap: w.cap, ms: w.ms, used: w.used, start: w.start })),
  };
}

// The bucket for one resource on this ctx (created on first use, shared by every worker using the ctx).
function bucketFor(ctx, resource) {
  ctx._buckets = ctx._buckets || {};
  if (!ctx._buckets[resource]) ctx._buckets[resource] = createBucket(LIMITS[resource] || LIMITS.core, ctx);
  return ctx._buckets[resource];
}

// Read the rate-limit state a response reports (REST headers, or a GraphQL rateLimit field) into the bucket.
function observeResponse(ctx, resource, headers, json) {
  const h = headers || {};
  const name = LIMITS[h['x-ratelimit-resource']] ? h['x-ratelimit-resource'] : resource;
  if (h['x-ratelimit-remaining'] !== undefined && h['x-ratelimit-reset'] !== undefined) {
    bucketFor(ctx, name).observe({ remaining: Number(h['x-ratelimit-remaining']), resetMs: Number(h['x-ratelimit-reset']) * 1000 });
    return;
  }
  const rl = json && json.data && json.data.rateLimit;
  if (rl && rl.remaining !== undefined && rl.resetAt) bucketFor(ctx, 'graphql').observe({ remaining: Number(rl.remaining), resetMs: Date.parse(rl.resetAt) });
}

module.exports = { LIMITS, createBucket, bucketFor, observeResponse, MAX_WAIT_MS };
