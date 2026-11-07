// App router — target selection (design sections 4.2 and 4.3). Pure: no I/O, inputs never changed.
//
// Walks the effective chain and picks the first eligible entry, with stickiness: a conversation stays
// on its target while that target is eligible. A proactive switch (near the threshold) and every
// switch back ("return": a capability upgrade, return=asap between Claude accounts, or in model-first
// the user's own model or Codex once it works again) wait for the cooldown and count toward the
// 6-per-24-hours cap. A real limit, a lost login or a down provider always switches. Nothing usable
// left -> exhausted, with the earliest KNOWN free time (never invented).
import { effectiveChain } from './chain-schema.mjs';
import { targetState } from './usage-readings.mjs';
import { CAPABILITY_BY_KIND, LIMITS } from './contract.mjs';

const FAILOVER_REASON = Object.freeze({ rate_limited: 'switch-limit', logged_out: 'switch-login', down: 'switch-down' });
const STATE_REASON = Object.freeze({ exhausted: 'switch-limit', 'needs-login': 'switch-login', down: 'switch-down', 'near-limit': 'switch-threshold' });

const ts = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

function cooldownPassed(conv, defaults, now) {
  const at = ts(conv && conv.switched_at);
  if (!Number.isFinite(at)) return true;
  return now - at >= (defaults.cooldown_min ?? LIMITS.COOLDOWN_DEFAULT) * 60_000;
}
function underCap(conv) {
  const n = conv && Number.isInteger(conv.proactive_switches_24h) ? conv.proactive_switches_24h : 0;
  return n < LIMITS.MAX_PROACTIVE_SWITCHES_24H;
}

function fromOf(item) {
  if (!item) return null;
  const s = item.st;
  const limited = s.state === 'exhausted';
  return {
    target_id: item.entry.id,
    label: item.entry.label,
    kind: item.entry.kind,
    window: limited ? (item.hitWindow ?? s.max_window) : s.max_window,
    pct: s.max_pct,
    resume_at: s.resume_at,
  };
}

function target(item, reason, { switched, proactive, from }) {
  return {
    kind: 'target',
    entry: item.entry,
    reason,
    switched,
    proactive,
    capability: CAPABILITY_BY_KIND[item.entry.kind] || 'answers-only',
    state: item.st.state,
    from: switched ? from : null,
  };
}

function exhaustedResult(items) {
  let best = null;
  for (const it of items) {
    if (it.st.state !== 'exhausted' || !it.st.resume_at) continue;
    if (!best || ts(it.st.resume_at) < ts(best.st.resume_at)) best = it;
  }
  return best
    ? { kind: 'exhausted', resume_at: best.st.resume_at, first_free: { target_id: best.entry.id, label: best.entry.label } }
    : { kind: 'exhausted', resume_at: null, first_free: null };
}

/** First eligible (ready/unknown) candidate; then, as a last resort, a near-limit one (it still has room). */
function firstUsable(candidates) {
  return candidates.find((c) => c.st.eligible) || candidates.find((c) => c.st.state === 'near-limit') || null;
}

function leastRecentlyUsedClaude(candidates, readings) {
  const claude = candidates.filter((c) => c.st.eligible && c.entry.kind === 'claude-account');
  let best = null;
  let bestAt = Infinity;
  for (const c of claude) {
    const at = ts(readings[c.entry.id] && readings[c.entry.id].last_used_at);
    const key = Number.isFinite(at) ? at : -Infinity; // never used = least recent
    if (best === null || key < bestAt) { best = c; bestAt = key; }
  }
  return best;
}

/**
 * Picks the target for the next turn.
 * @param {object} args
 * @param {object} args.config     a validated router config
 * @param {Record<string, object>} [args.readings]  readReadings()
 * @param {null|{target_id: string|null, switched_at: string|null, proactive_switches_24h?: number}} [args.conv]
 *   the conversation's current target (null or target_id null = a new conversation)
 * @param {number} [args.now]
 * @param {string|null} [args.requestedModel]
 * @param {string[]} [args.exclude]  ids never picked (attempt 2 excludes attempt 1's target)
 * @param {'rate_limited'|'logged_out'|'down'|null} [args.failover]  why attempt 1 failed (sets the reason)
 * @returns {import('./contract.mjs').RouteDecision}
 */
export function selectTarget({ config, readings = {}, conv = null, now = Date.now(), requestedModel = null, exclude = [], failover = null } = {}) {
  if (!config || config.mode === 'off') return { kind: 'off' };
  const defaults = config.defaults || {};
  const excluded = new Set(Array.isArray(exclude) ? exclude : []);
  const items = effectiveChain(config).map((entry, index) => {
    const rec = readings[entry.id] || null;
    const st = targetState(entry, rec, { now, defaultThresholdPct: defaults.threshold_pct ?? LIMITS.THRESHOLD_DEFAULT, requestedModel });
    return { entry, index, st, hitWindow: rec && rec.limit_hit ? rec.limit_hit.window : null };
  });
  if (items.length === 0) return { kind: 'exhausted', resume_at: null, first_free: null };

  const pool = items.filter((it) => !excluded.has(it.entry.id));
  const currentId = conv && typeof conv.target_id === 'string' ? conv.target_id : null;
  const current = currentId ? items.find((it) => it.entry.id === currentId) || null : null;

  // A new conversation.
  if (!currentId) {
    const first = firstUsable(pool);
    if (!first) return exhaustedResult(items);
    const pickItem = defaults.strategy === 'spread' && first.entry.kind === 'claude-account' && first.st.eligible
      ? leastRecentlyUsedClaude(pool, readings) || first
      : first;
    return target(pickItem, 'first', { switched: false, proactive: false, from: null });
  }

  // The current target left the chain (disabled, removed, gated): start over, but say we moved.
  if (!current) {
    const first = firstUsable(pool);
    if (!first) return exhaustedResult(items);
    const stored = Array.isArray(config.entries) ? config.entries.find((e) => e && e.id === currentId) : null;
    const from = { target_id: currentId, label: stored ? stored.label : currentId, kind: stored ? stored.kind : null, window: null, pct: null, resume_at: null };
    return target(first, 'first', { switched: true, proactive: false, from });
  }

  const others = pool.filter((it) => it !== current);
  const forced = excluded.has(current.entry.id) || ['exhausted', 'needs-login', 'down'].includes(current.st.state);
  if (forced) {
    const next = firstUsable(others);
    if (!next) return exhaustedResult(items);
    const reason = (excluded.has(current.entry.id) && FAILOVER_REASON[failover]) || STATE_REASON[current.st.state] || 'switch-limit';
    return target(next, reason, { switched: true, proactive: false, from: fromOf(current) });
  }

  const mayMove = cooldownPassed(conv, defaults, now) && underCap(conv);
  if (current.st.state === 'near-limit') {
    const next = mayMove ? others.find((it) => it.st.eligible) : null;
    if (next) return target(next, 'switch-threshold', { switched: true, proactive: true, from: fromOf(current) });
    return target(current, 'sticky', { switched: false, proactive: false, from: null });
  }

  // Eligible current target: stay, unless a way back up the chain is open (the earliest one wins).
  if (mayMove) {
    const back = others.find((it) => it.index < current.index && it.st.eligible && isWayBack(it.entry, current.entry, config.mode, defaults));
    if (back) return target(back, 'return', { switched: true, proactive: true, from: fromOf(current) });
  }
  return target(current, 'sticky', { switched: false, proactive: false, from: null });
}

/**
 * May a conversation on `current` go back to the earlier entry `earlier`?
 *  - to a Claude account: from a model or Codex (a capability upgrade), or between Claude accounts
 *    only with return=asap (and not with strategy spread);
 *  - to a model or Codex: only in model-first, where the user chose it as the first entry; the
 *    conversation left it because it was down or limited, and it works again.
 */
function isWayBack(earlier, current, mode, defaults) {
  if (earlier.kind === 'claude-account') {
    if (current.kind !== 'claude-account') return true;
    return defaults.return === 'asap' && defaults.strategy !== 'spread';
  }
  return mode === 'model-first';
}
