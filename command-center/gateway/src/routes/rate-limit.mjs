// Anti-runaway rate limit for the two conversation write routes (moved verbatim out of server.mjs,
// WP A11 part 1). server.mjs re-exports the two test seams so existing tests keep importing them
// from '../src/server.mjs'.
//
// fix-test-hygiene (owner-flagged system-checkup finding, MEDIUM/INFO): POST /api/conversations and
// POST /api/conversations/:id/messages had NO request-count limit at all — exec-bridge.mjs's
// MAX_CONCURRENT_EXECUTIONS=3 and the 409 duplicate-send guard only bound concurrent EXECUTION
// (how many `claude` child processes run at once / one pending turn per conversation), not how many
// HTTP requests can be fired. A misbehaving script or a runaway retry loop could still call either
// route an unbounded number of times per second.
//
// This is a small in-memory token bucket, one per route family, and it is an ANTI-RUNAWAY BRAKE,
// NOT a security control — this gateway is loopback-only and single-user (see security.mjs's
// EXEC_TOKEN comment for the actual trust boundary: same-origin-plus-token against a separate local
// process). It exists purely so a stuck loop can't hammer conversation-create/message-send
// indefinitely; it does not replace or weaken the existing exec-token/409/containment checks,
// which are unchanged.
//
// Limits: capacity 60, refilling to full capacity over a 60-second window (~1 req/s sustained,
// burst up to 60) — PER route family, independently. Chosen from this repo's own real usage as the
// evidence floor: routes-wp4.test.mjs (the heaviest real caller of these two routes) fires 37 real
// POST /api/conversations calls and 23 real POST .../messages calls in a single run, all comfortably
// under 60 with wide margin, so no legitimate dashboard session — or this project's own existing
// test suite — ever gets near this ceiling. A runaway script making dozens of requests per second
// trips it within its first second.
//
// App router (APP-ROUTER-DESIGN.md 6.1): two more buckets with the same capacity, appRouterWrite
// (POST /api/app-router and POST /api/app-router/profiles) and appRouterTest (POST
// /api/app-router/targets/:id/test). The test route keeps its own stricter per-target window on top
// (one quota-using probe per target per 5 minutes, in routes/app-router.mjs); this bucket is only the
// same anti-runaway brake as the conversation routes.
import { sendJson } from './http.mjs';

const RATE_LIMIT_DEFAULT_CAPACITY = 60;
const RATE_LIMIT_DEFAULT_REFILL_MS = 60_000;

let rateLimitCapacity = RATE_LIMIT_DEFAULT_CAPACITY;
let rateLimitRefillMs = RATE_LIMIT_DEFAULT_REFILL_MS;
let rateLimitClockOverride = null;

function rateLimitNow() { return rateLimitClockOverride ? rateLimitClockOverride() : Date.now(); }

function createTokenBucket() {
  let tokens = rateLimitCapacity;
  let lastRefillMs = rateLimitNow();
  return {
    tryConsume() {
      const t = rateLimitNow();
      const elapsedMs = Math.max(0, t - lastRefillMs);
      if (elapsedMs > 0) {
        const refilled = (elapsedMs / rateLimitRefillMs) * rateLimitCapacity;
        tokens = Math.min(rateLimitCapacity, tokens + refilled);
        lastRefillMs = t;
      }
      if (tokens >= 1) {
        tokens -= 1;
        return { allowed: true };
      }
      const missingTokens = 1 - tokens;
      const msUntilNextToken = Math.ceil((missingTokens / rateLimitCapacity) * rateLimitRefillMs);
      return { allowed: false, retryAfterMs: Math.max(1, msUntilNextToken) };
    },
  };
}

/** Every bucket key. A key outside this list is a programming error (checkRateLimit throws on it). */
export const RATE_LIMIT_BUCKETS = Object.freeze(['conversationCreate', 'conversationMessage', 'appRouterWrite', 'appRouterTest']);

function freshBuckets() {
  return Object.fromEntries(RATE_LIMIT_BUCKETS.map((key) => [key, createTokenBucket()]));
}

let rateLimitBuckets = freshBuckets();

// Test-only override seams (mirror this codebase's existing `_set*ForTests` convention, e.g.
// conversations.mjs's `_setConversationsDirForTests`). Production code never calls either —
// `rateLimitBuckets`/`rateLimitCapacity`/`rateLimitRefillMs` always keep the real defaults above in
// a real gateway process.
export function _setRateLimitClockForTests(fn) { rateLimitClockOverride = fn; }
/** Shrinks (or restores, when called with no args) the bucket capacity/window and always rebuilds
 *  fresh, full buckets — so a rate-limit test can trip the limit with a handful of requests instead
 *  of the real production capacity, without a real multi-second sleep. */
export function _configureRateLimitForTests({ capacity = RATE_LIMIT_DEFAULT_CAPACITY, refillMs = RATE_LIMIT_DEFAULT_REFILL_MS } = {}) {
  rateLimitCapacity = capacity;
  rateLimitRefillMs = refillMs;
  rateLimitBuckets = freshBuckets();
}

/** Returns true (caller proceeds) or sends a real 429 + Retry-After and returns false. */
export function checkRateLimit(bucketKey, res) {
  const bucket = rateLimitBuckets[bucketKey];
  if (!bucket) throw new Error('rate limit: unknown bucket ' + String(bucketKey));
  const result = bucket.tryConsume();
  if (result.allowed) return true;
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  sendJson(
    res,
    429,
    {
      ok: false,
      error: 'rate limit exceeded for this route (anti-runaway brake, not a security boundary) — retry in ' + retryAfterSeconds + 's',
      retry_after_ms: result.retryAfterMs,
    },
    { 'Retry-After': String(retryAfterSeconds) },
  );
  return false;
}
