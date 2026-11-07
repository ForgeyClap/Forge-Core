# Cost patterns — calculator, budget guard, retry rule, burn checklist

Forge wording. Ideas from ECC `cost-aware-llm-pipeline` and `ecc-tools-cost-audit` (pinned catalog
`e2b8a51`, MIT, Copyright (c) 2026 Affaan Mustafa); the Python code there is NOT copied — the functions
below are new Node code. Prices are always passed in: Forge keeps no price table, because prices change.

## Offline cost calculator (Node, no dependencies)
```js
// Cost of one API call from the provider's usage counters. Prices are USD per million tokens.
function callCost(usage, price) {
  const per = (n, p) => ((n || 0) * (p || 0)) / 1e6;
  return per(usage.input_tokens, price.input)
    + per(usage.cache_creation_input_tokens, price.cacheWrite)
    + per(usage.cache_read_input_tokens, price.cacheRead)
    + per(usage.output_tokens, price.output);
}

// Share of input served from cache; null when the counters were not logged (= unmeasured).
function cacheHitRate(usage) {
  const read = usage.cache_read_input_tokens;
  if (read === undefined) return null;
  const total = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + read;
  return total ? read / total : null;
}
```
Report `null` as "unmeasured", never as 0 % or as a guess.

## Budget guard (check before the call, never after)
```js
// Returns a NEW tracker; never mutates the old one.
function addSpend(tracker, cost) {
  return Object.freeze({ limit: tracker.limit, spent: tracker.spent + cost, calls: tracker.calls + 1 });
}
function assertBudget(tracker, nextEstimate) {
  if (tracker.spent + nextEstimate > tracker.limit) {
    throw new Error(`budget limit ${tracker.limit} would be exceeded (spent ${tracker.spent})`);
  }
}
```
Set the limit before a batch starts. Fail early rather than overspend; log the stop, never swallow it.

## Retry only what can succeed later
- Retry: timeouts, connection resets, HTTP 429 (respect `retry-after`), HTTP 5xx. Exponential backoff,
  a small cap (for example 3), and a total time limit.
- Do not retry: 400 (bad request), 401/403 (auth), 404, validation errors, budget stops. Fail fast with a
  clear error — a deterministic failure retried is money burned for nothing.

## Burn checklist (apps that spend per request)
Trace the entry points before theorising: every route into the expensive call, every queue producer and
consumer, every place usage is checked and every place it is charged.
1. **Recursion:** can the app's own output (a branch, a PR, a message, a webhook write) trigger the same
   path again? Treat this as the first fix.
2. **Quota race:** quota checked at the front door, charged inside the worker — reserve usage atomically
   before the work, release it on failure.
3. **Tier leak:** can a free or capped user reach the premium model when its key is present?
4. **Fan-out and retry burn:** duplicate jobs for one event, retries on non-transient errors.
5. **Spend before persist:** the model call succeeded but the result was not stored; store first or make
   the job idempotent so a rerun does not pay twice.
Fix in this order, one to three direct fixes per pass, each with a regression test. State the final
status exactly: changed locally / verified locally — push and deploy stay owner-gated.
