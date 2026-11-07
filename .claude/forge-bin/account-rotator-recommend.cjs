#!/usr/bin/env node
'use strict';
/**
 * account-rotator-recommend.cjs — the TOKEN-MODE tick of the account rotator (owner direction 2026-10-09: switching
 * happens through setup tokens and a NEW session — `launch --auto`; the Claude login files are never written here).
 *
 * Under the transaction lock, after account-rotator.cjs measured the file-active login (only with a token whose
 * ownership is established): measure every token account with its OWN setup token (a 401/403 = honestly 'unmeasurable',
 * then the bound login's reading, then last-known, then round-robin — never an invented percentage), decide which
 * account is "current" (the token account launched most recently, else the file-active login), and when the current
 * account is at/over the threshold record the RECOMMENDATION: state.recommendation, handoff.json (phase 'recommend'),
 * the notification file and one log line per (current, pick). No pause, no swap, no guard-state write: a running
 * session cannot change its own environment, so the owner (or the `launch` wrapper) starts the next session.
 */
const crypto = require('crypto');
const core = require('./account-rotator-core.cjs');
const vault = require('./account-rotator-vault.cjs');
const tok = require('./account-rotator-token.cjs');
const handoff = require('./account-rotator-handoff.cjs');
const flags = require('./account-rotator-flags.cjs');

const LAUNCH_HINT = 'node .claude/forge-bin/account-rotator.cjs launch --auto -- <claude args>';
const iso = (ms) => new Date(ms).toISOString();

/** tickRecommend(ctx, e) -> {action:'none'|'wait'|'recommend'|'would-recommend', ...}. e = {st, delta, slots, active,
 *  meas, trigger, log, noteOnce} from account-rotator.cjs tickLocked (delta is mutated: readings/tokenReadings/set). */
async function tickRecommend(ctx, e) {
  const { P, S, deps } = ctx;
  const now = deps.now();
  const T = S.threshold.value;
  const { st, delta, slots, active, meas, log, noteOnce } = e;
  const readings = Object.assign({}, st.readings, delta.readings);
  const tokenSlots = slots.filter((s) => !s.broken && s.token);
  const { tr, ar } = await tok.measureTokens(tokenSlots, { tokenReadings: st.tokenReadings, readings }, deps, now);
  for (const s of tokenSlots) {
    if (tr[s.name] && tr[s.name] !== st.tokenReadings[s.name]) delta.tokenReadings[s.name] = tr[s.name];
    if (ar[s.name] && ar[s.name] !== readings[s.name]) delta.readings[s.name] = ar[s.name];
  }
  // an orgBlocked slot's launch never became a working session, so it is never the "current" account
  const launched = tokenSlots.filter((s) => !flags.isOrgBlocked(st.slotFlags, s.name)).map((s) => ({ name: s.name, at: Date.parse((tr[s.name] || {}).lastUsedAt) })).filter((x) => Number.isFinite(x.at)).sort((a, b) => b.at - a.at)[0];
  const current = launched ? launched.name : active;
  const curSlot = current ? slots.find((s) => s.name === current) : null;
  const curRec = !current ? null : current === active && meas ? Object.assign({}, readings[active]) : curSlot && curSlot.token ? tok.tokenReading(curSlot, tr, ar) : readings[current];
  const curReading = core.effectiveReading(curRec, now);
  const trigger = current === active && meas ? e.trigger : core.crossed(curReading.windows, T);
  const view = tokenSlots.map((s) => ({ name: s.name, eligible: !flags.isOrgBlocked(st.slotFlags, s.name), reading: core.effectiveReading(tok.tokenReading(s, tr, ar), now), lastUsedAt: (tr[s.name] || {}).lastUsedAt || null }));
  if (!tokenSlots.length) {
    noteOnce(st, delta, 'token:none', 'TOKEN-MODUS zonder setup-tokens — niets aan te bevelen; `claude setup-token` -> `enroll-token <naam>` per account (of bestandsmodus: /forge config set account-rotator.mode file) / TOKEN MODE without setup tokens — nothing to recommend', log);
    return { action: 'none', reason: 'no-token-accounts', active: current, mode: 'token', trigger };
  }
  if (!trigger.length && !ctx.manual) {
    if (!ctx.dryRun && st.recommendation && st.recommendation.from === current) delta.set.recommendation = null; // the current account is fine again
    return { action: 'none', reason: 'below-threshold', active: current, maxPct: curReading.maxPct, mode: 'token' };
  }
  const sel = core.selectTarget({ accounts: view, activeName: current, threshold: T, now, lastLeft: null, skipUntested: true });
  let pick = null; let why = null; let tier = null;
  if (sel.target && sel.tier !== 'unknown') { pick = sel.target; tier = sel.tier; why = sel.tier + ' ' + core.fmtPct((sel.ranked[0] || {}).maxPct); }
  else {
    const unknown = sel.ranked.filter((r) => r.tier === 'unknown').map((r) => view.find((x) => x.name === r.name));
    if (unknown.length) { const rr = core.roundRobin(unknown, now); pick = rr.name; tier = 'unknown'; why = rr.why; }
  }
  if (!pick) {
    if (!ctx.dryRun) { handoff.recordWaiting(P, { from: current, trigger, now, soonestResetAt: sel.soonestResetAt }); delta.set.recommendation = null; }
    noteOnce(st, delta, 'wait:' + sel.soonestResetAt, 'GEEN BRUIKBAAR TOKEN-ACCOUNT — geen aanbeveling; vroegste reset ' + (sel.soonestResetAt || 'onbekend') + ' / NO USABLE TOKEN ACCOUNT — no recommendation; soonest reset ' + (sel.soonestResetAt || 'unknown'), log);
    return { action: 'wait', reason: 'no-usable-account', soonestResetAt: sel.soonestResetAt, active: current, trigger, mode: 'token' };
  }
  const trig = trigger.map((w) => ({ label: w.label, pct: w.pct }));
  if (ctx.dryRun) return { action: 'would-recommend', from: current, to: pick, tier, why, trigger: trig, mode: 'token' };
  delta.set.recommendation = { name: pick, why, tier, from: current, at: iso(now), trigger: trig, launch: LAUNCH_HINT };
  vault.writeHandoffFile(P, { version: 2, id: crypto.randomUUID(), phase: 'recommend', reason: ctx.manual ? 'manual' : 'threshold', kind: 'token', from: current, to: pick, trigger: trig, at: iso(now),
    note: 'token mode: no login file was touched — start a new session with `launch --auto` (or `launch --account ' + pick + '`); a running session keeps its own account' });
  noteOnce(st, delta, 'recommend:' + current + ':' + pick, 'AANBEVELING / RECOMMENDATION — ' + (current || '(onbekend/unknown)') + ' ' + handoff.triggerText(trigger) + ' -> ' + pick + ' (' + why + '): ' + LAUNCH_HINT, log);
  return { action: 'recommend', from: current, to: pick, tier, why, trigger: trig, mode: 'token' };
}

module.exports = { LAUNCH_HINT, tickRecommend };
