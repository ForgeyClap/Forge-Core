#!/usr/bin/env node
'use strict';
/**
 * account-rotator.cjs — keep Claude Code on an enrolled Claude Max account that still has room (run
 * escalation round). Zero dependencies.
 *
 * TWO MODES (account-rotator.mode, owner direction 2026-10-09 — "switch via tokens"):
 *  - token (DEFAULT): the watcher MEASURES every enrolled account, RECORDS the recommended one (state.recommendation,
 *    handoff.json phase 'recommend', ~/.claude/FORGE_ACCOUNT_ROTATION.json) and never touches the Claude login files.
 *    The switch itself is a NEW session: `launch --auto -- <claude args>` (account-rotator-token.cjs).
 *  - file (EXPERIMENTAL, explicit opt-in): the watcher swaps the login files of running sessions itself. A Codex review
 *    showed that swap cannot be made race-free against Claude Code's own token refresher: it is best-effort, detected and
 *    repaired (account-rotator-txn.cjs), never atomic.
 *
 * EVERY account-changing step runs inside ONE transaction lock (vault.withTxnLock, AR-02): reconcile an unfinished swap
 * (txn.reconcile + txn.repairUnresolved), pick up an unaccounted committed swap (AR-V10), reconcile an interrupted
 * handoff -> re-read identity, state, cooldown -> measure -> decide -> preflight -> handoff (file mode) or
 * recommendation (token mode). The active login is measured ONLY while its token is the slot's own or its ownership was
 * established independently (AR-V01 — txn.corroboratedCapture); an unknown token is never attributed to a slot.
 * Outcomes are tri-state (AR-05): 'verified' sets state.active and CONTINUE; 'unmeasurable-fallback' leaves a
 * pendingVerify that a later tick verifies (threshold rules apply then too, AR-V06) or — after 2 genuine 401s on an
 * AUTOMATIC switch, or after PENDING_VERIFY_MAX_MS in any pending state (AR-V07) — rolls back to the previous, known-good
 * login and marks the failed slot needs-relogin; 'failed' counts toward the failure backoff and the daily cap. A 401
 * on a stored access token past its own expiry while the login file is still exactly what we wrote is "awaiting first
 * use", not a failure — bounded by the same PENDING_VERIFY_MAX_MS. An owner-requested switch (`switch <name>`,
 * `switch --auto`, `--force`) takes precedence over a pending verification; `--force` on a consistent login supersedes an
 * unresolved transaction, as does `enroll <name> --force`.
 *
 * Commands: see account-rotator-cli.cjs (`node .claude/forge-bin/account-rotator.cjs help`).
 * SAFETY: tokens never printed/logged/stored outside the vault (vault.scrub); inactive accounts never refreshed; a fetch
 * error is never "fine" and never "full"; processes are stopped only by their exact, verified pid.
 */
const fs = require('fs');
const crypto = require('crypto');
const core = require('./account-rotator-core.cjs');
const vault = require('./account-rotator-vault.cjs');
const txn = require('./account-rotator-txn.cjs');
const handoff = require('./account-rotator-handoff.cjs');
const M = require('./account-rotator-measure.cjs');
const tok = require('./account-rotator-token.cjs');
const recommend = require('./account-rotator-recommend.cjs');

const iso = (ms) => new Date(ms).toISOString();
function noteOnce(st, delta, key, msg, logFn) { if (st.lastNoticeKey === key) return; delta.lastNoticeKey = key; logFn(msg); }
const eligibleFor = (flags) => (s) => M.fileEligible(s) && !(flags && flags[s.name] && flags[s.name].needsRelogin);
const modeOf = (S) => (S && S.mode && S.mode.value === 'file' ? 'file' : 'token');

/** tick(ctx) -> {action, reason, ...}. ctx = {P, S, deps, dryRun, manual: {target}|{auto}, force, lockTimeoutMs}. */
async function tick(ctx) {
  const timeoutMs = Number.isFinite(ctx.lockTimeoutMs) ? ctx.lockTimeoutMs : (ctx.manual ? 120000 : 10000);
  const r = await vault.withTxnLock(ctx.P, () => tickLocked(ctx), { timeoutMs });
  if (!r.ok) return { action: 'none', reason: 'busy', detail: 'another account transaction is running (' + r.reason + ')' };
  return r.value;
}
/** reconcileAll — unfinished swap (reconcile, then an ownership repair for an unknown token), interrupted handoff. */
async function reconcileAll(P, deps, log, capOpts, dryRun) {
  let rec = txn.reconcile(P);
  if (rec.action !== 'none') log('RECONCILE — swap ' + (rec.txn && rec.txn.from) + ' -> ' + (rec.txn && rec.txn.to) + ': ' + rec.action + (rec.reason ? ' — ' + rec.reason : ''));
  if (rec.removed && rec.removed.length) log('RECONCILE — removed ' + rec.removed.length + ' temp file(s) left by a dead process');
  if (rec.action === 'unresolved' && rec.cls === 'unknown' && !dryRun) {
    const rp = await txn.repairUnresolved(P, capOpts);
    if (rp.action === 'repaired') {
      log('REPAIR — the unknown login was established as ' + rp.slot + ' (' + rp.how + ') and captured (previous generation kept); swap ' + rp.then.txn.from + ' -> ' + rp.then.txn.to + ': ' + rp.then.action);
      rec = Object.assign({}, rp.then, { repaired: rp });
    } else if (rp.action === 'unresolved') log('REPAIR — ownership of the unknown login could not be established yet: ' + rp.reason);
  }
  try { await handoff.reconcileHandoff(P, deps.guard || handoff.guardLib(), log); } catch (e) { log('RECONCILE — handoff cleanup failed (' + ((e && e.name) || 'Error') + ')'); }
  return rec;
}
async function tickLocked(ctx) {
  const { P, S, deps } = ctx;
  const now = deps.now();
  const T = S.threshold.value;
  const mode = modeOf(S);
  const realLog = (m) => vault.log(P, m, { quiet: !!deps.quiet });
  const log = ctx.dryRun ? () => {} : realLog; // a dry run records only reconcile notes and the readings it measured
  const st0 = vault.readState(P);
  const measure = (token) => M.measureToken(token, deps);
  const capOpts = { settleMs: deps.settleMs, identify: deps.identify, hooks: deps.swapHooks, measure, readings: st0.readings, now };
  const delta = { readings: {}, tokenReadings: {}, history: [], swaps: [], failures: [], set: {}, consecutive: null, accountTxnIds: [] };
  const rec = await reconcileAll(P, deps, realLog, capOpts, ctx.dryRun);
  if (rec.repaired && rec.repaired.reading && rec.repaired.slot) delta.readings[rec.repaired.slot] = M.liveReading(rec.repaired.reading, now, { viaSlotToken: true });
  const un = txn.unaccounted(P); // AR-V10: a committed swap the state file has not recorded yet
  if (un) {
    if (!(st0.swaps || []).some((s) => s && s.txnId === un.id)) delta.swaps.push({ at: un.closedAt || iso(now), from: un.from, to: un.to, txnId: un.id, kind: un.outcome === 'recovered-forward' ? 'recovered' : 'committed' });
    delta.accountTxnIds.push(un.id);
  }
  if (rec.action === 'forward') {
    delta.set.pendingVerify = { to: rec.txn.to, from: rec.txn.from, at: iso(now), auto: true, failures: 0, credsGen: vault.generation(P.creds), trigger: [] };
  } else if (rec.action === 'back' && rec.rolledBack) {
    delta.failures.push({ at: iso(now), reason: 'interrupted swap rolled back by reconcile', target: rec.txn.to });
    delta.consecutive = 'inc';
  }
  const st = vault.readState(P);
  const slots = vault.listSlots(P);
  const finish = async (res) => {
    if (!ctx.dryRun && delta.lastNoticeKey === undefined && (res.action === 'switched' || res.reason === 'below-threshold')) delta.lastNoticeKey = null;
    const saved = await vault.updateState(P, (s) => {
      s.readings = Object.assign({}, s.readings, delta.readings);
      s.tokenReadings = Object.assign({}, s.tokenReadings, delta.tokenReadings);
      for (const e of delta.swaps) if (!e.txnId || !(s.swaps || []).some((x) => x && x.txnId === e.txnId)) s.swaps = (s.swaps || []).concat([e]);
      s.failures = (s.failures || []).concat(delta.failures);
      if (delta.consecutive === 'inc') s.consecutiveFailures = (Number(s.consecutiveFailures) || 0) + 1;
      if (delta.consecutive === 'reset') s.consecutiveFailures = 0;
      if (Object.prototype.hasOwnProperty.call(delta.set, 'pendingVerify')) s.pendingVerify = delta.set.pendingVerify;
      if (ctx.dryRun) return;
      s.history = (s.history || []).concat(delta.history);
      for (const [k, v] of Object.entries(delta.set)) if (k !== 'pendingVerify') s[k] = v;
      if (delta.lastNoticeKey !== undefined) s.lastNoticeKey = delta.lastNoticeKey;
      s.lastTickAt = iso(now);
    });
    if (saved) for (const id of delta.accountTxnIds) txn.markAccounted(P, id);
    if (!saved && !ctx.dryRun) realLog('LET OP / WARNING — state.json kon niet worden bijgewerkt (lock bezet) / could not be updated (lock busy)');
    if (!ctx.dryRun) writeNotification(P, slots, now, T, res, mode);
    return res;
  };
  if (rec.action === 'unresolved') {
    const sup = ctx.manual && ctx.force && !ctx.dryRun ? supersedeIfConsistent(P, slots, 'owner-forced switch on a consistent login') : null;
    if (sup) realLog('ONOPGELOSTE WISSEL GESLOTEN / UNRESOLVED SWAP CLOSED — ' + sup.from + ' -> ' + sup.to + ' superseded by the owner (--force); the login files are consistent with slot ' + sup.activeName);
    else {
      noteOnce(st, delta, 'unresolved:' + rec.txn.id, 'ONOPGELOSTE WISSEL / UNRESOLVED SWAP — ' + rec.reason, realLog);
      return finish({ action: ctx.manual ? 'refused' : 'none', reason: 'unresolved-transaction', detail: rec.reason + (ctx.manual && !ctx.force ? ' — the login files are not consistent with any slot; --force cannot help until they are' : '') });
    }
  }
  if (st.disabled && !(ctx.manual && ctx.force)) return finish({ action: 'none', reason: 'disabled' });
  // ---- the active login: identified by the files, MEASURED only with a token whose ownership is established ----------
  let active = null; let untrusted = null; let meas = null; let live = vault.readLive(P);
  if (!live.ok) {
    if (mode === 'file') { noteOnce(st, delta, 'live:' + live.reason, 'GEEN ACTIE / NO ACTION — ' + live.reason, log); return finish({ action: 'none', reason: 'no-login', detail: live.reason }); }
    live = null;
  }
  const m = live ? vault.matchActive(live, slots) : { slot: null, reason: 'no-login' };
  if (!m.slot) {
    if (mode === 'file') {
      noteOnce(st, delta, 'match:' + m.reason, m.reason === 'not-enrolled' ? 'actieve login is niet ingeschreven — geen wissel / active login is not enrolled — no switch (run: enroll <name>)'
        : 'actieve login niet eenduidig (' + m.reason + ') — niets gewijzigd / active login ambiguous or inconsistent — nothing changed', log);
      return finish({ action: 'none', reason: 'active-not-enrolled', detail: m.reason });
    }
  } else {
    active = m.slot.name;
    if (!m.inSync || !vault.sameJson(m.slot.oauthAccount, live.profile.oauthAccount)) {
      if (ctx.dryRun) untrusted = 'the active login changed since it was saved (dry run: not captured)';
      else {
        const c = await txn.corroboratedCapture(P, m.slot, capOpts);
        if (c.captured) {
          log('login van ' + active + ' bijgewerkt in de kluis (vorige generatie bewaard, bewijs: ' + c.how + ') / vault copy of ' + active + ' refreshed (previous generation kept, proof: ' + c.how + ')');
          if (c.reading) { meas = c.reading; delta.readings[active] = Object.assign({}, st.readings[active] || {}, M.liveReading(c.reading, now, { viaSlotToken: true }), { lastError: null }); }
        } else if (!c.unchanged) { untrusted = c.reason; log('login van ' + active + ' NIET bijgewerkt / NOT refreshed — ' + c.reason + (c.refused ? '' : ' (' + txn.OWNER_HINT + ')')); }
      }
    }
  }
  if (untrusted) {
    noteOnce(st, delta, 'untrusted:' + active, 'ACTIEVE LOGIN NIET GEVERIFIEERD / ACTIVE LOGIN UNVERIFIED — ' + active + ': ' + untrusted + ' — niet gemeten, geen wissel / not measured, no switch', log);
    if (mode === 'file') return finish({ action: ctx.manual ? 'refused' : 'none', reason: 'active-unverified', detail: untrusted, active });
    active = null; live = null;
  }
  const pv = Object.prototype.hasOwnProperty.call(delta.set, 'pendingVerify') ? delta.set.pendingVerify : st.pendingVerify;
  if (pv && !ctx.dryRun && (ctx.manual || mode === 'token')) { delta.set.pendingVerify = null; log('verificatie van ' + pv.from + ' -> ' + pv.to + ' vervalt: ' + (ctx.manual ? 'handmatige wissel heeft voorrang / a manual switch takes precedence' : 'token-modus / token mode')); }
  else if (pv && !ctx.dryRun && active) return finish(await handlePendingVerify(ctx, { st, delta, pv, live, active, log }));
  if (active && !meas) {
    meas = await M.measureToken(live.creds.claudeAiOauth.accessToken, deps);
    if (!meas.ok) {
      delta.readings[active] = Object.assign({}, st.readings[active] || {}, { lastError: meas.error, lastErrorAt: iso(now) });
      log('CHECK FAILED (geen actie — fail-safe / no action — fail-safe): ' + meas.error);
      if (!ctx.manual && mode === 'file') return finish({ action: 'none', reason: 'check-failed', error: meas.error, active });
      meas = null; // a manual switch away from an unmeasurable active account may still proceed (AR-V07)
    } else delta.readings[active] = Object.assign({}, st.readings[active] || {}, M.liveReading(meas, now, { viaSlotToken: true }), { lastError: null });
  }
  if (active && meas && !ctx.dryRun && st.active !== active) delta.set.active = active;
  const trigger = meas ? core.crossed(meas.windows, T) : [];
  if (mode === 'token') return finish(await recommend.tickRecommend(ctx, { st, delta, slots, active, meas, trigger, log, noteOnce }));
  if (!trigger.length && !ctx.manual) return finish({ action: 'none', reason: 'below-threshold', active, maxPct: meas.maxPct });
  const readings = Object.assign({}, st.readings, delta.readings);
  await M.refreshInactive(slots, active, readings, deps, now, {});
  for (const s of slots) if (s.name !== active && readings[s.name] !== st.readings[s.name]) delta.readings[s.name] = readings[s.name];
  const selectFrom = (exclude) => core.selectTarget({ accounts: M.view(slots, readings, now, eligibleFor(ctx.force ? {} : st.slotFlags)), activeName: active, threshold: T, now, lastLeft: st.lastLeft, exclude });
  let target = null; let tier = null; let sel = null;
  if (ctx.manual && ctx.manual.target) {
    const t = slots.find((s) => s.name === ctx.manual.target);
    if (!t || !M.fileEligible(t)) return finish({ action: 'refused', reason: 'target-not-usable', detail: 'slot ' + ctx.manual.target + ' has no file-mode login' });
    if (t.name === active) return finish({ action: 'refused', reason: 'already-active' });
    target = t.name; tier = 'manual';
  } else {
    if (!ctx.manual) {
      const fg = core.failureGate({ failures: st.failures, consecutive: st.consecutiveFailures, now });
      if (!fg.ok) {
        noteOnce(st, delta, 'fail:' + fg.reason, fg.reason === 'fail-cap' ? 'GESTOPT / STOPPED — 6 mislukte wissels in 24 uur; de rotator probeert het niet meer tot ' + fg.nextAt + ' / 6 failed switches in 24 h; no more attempts until ' + fg.nextAt
          : 'wachttijd na een mislukte wissel tot ' + fg.nextAt + ' / backing off after a failed switch until ' + fg.nextAt, log);
        return finish({ action: 'none', reason: fg.reason, nextAt: fg.nextAt, active });
      }
      const af = core.antiFlap({ swaps: st.swaps, now, cooldownMin: S['cooldown-min'].value });
      if (!af.ok) { noteOnce(st, delta, 'antiflap:' + af.reason, 'drempel bereikt maar ' + af.reason + ' tot ' + af.nextAt + ' — geen wissel / threshold reached but ' + af.reason + ' until ' + af.nextAt + ' — no switch', log); return finish({ action: 'none', reason: af.reason, nextAt: af.nextAt, active }); }
    }
    sel = selectFrom(new Set());
    if (!sel.target) {
      if (!ctx.dryRun) handoff.recordWaiting(P, { from: active, trigger, now, soonestResetAt: sel.soonestResetAt });
      noteOnce(st, delta, 'wait:' + sel.soonestResetAt, 'GEEN BRUIKBAAR ACCOUNT — geen wissel; usage-guard pauzeert zelf bij zijn grens; vroegste reset ' + (sel.soonestResetAt || 'onbekend') + ' / NO USABLE ACCOUNT — no switch; usage-guard pauses at its own limit; soonest reset ' + (sel.soonestResetAt || 'unknown'), log);
      return finish({ action: 'wait', reason: 'no-usable-account', soonestResetAt: sel.soonestResetAt, active, trigger });
    }
    target = sel.target; tier = sel.tier;
  }
  if (ctx.dryRun) return finish({ action: 'would-switch', from: active, to: target, tier, trigger, ranked: sel ? sel.ranked : [] });
  const pf0 = await txn.preflight(P, target, Object.assign({ slotFlags: st.slotFlags, allowNeedsRelogin: !!ctx.force }, capOpts)); // before ANY pause
  if (!pf0.ok) {
    noteOnce(st, delta, 'preflight:' + target + ':' + pf0.reason, 'GEEN WISSEL / NO SWITCH — voorwaarde niet voldaan / precondition failed: ' + pf0.reason, log);
    return finish({ action: 'none', reason: 'preflight-failed', detail: pf0.reason, active, to: target });
  }
  const res = await runSwitch(ctx, { from: active, to: target, trigger, kind: ctx.manual ? 'manual' : 'auto', pf0, readings, selectFrom, log });
  return finish(recordOutcome(ctx, delta, res, { active, target, tier, trigger, now }));
}
/** supersedeIfConsistent — an unresolved transaction may be closed by the owner only while the two login files are
 *  consistent with ONE enrolled slot (its exact stored token); never on an unknown token. */
function supersedeIfConsistent(P, slots, why) {
  const live = vault.readLive(P);
  if (!live.ok) return null;
  const m = vault.matchActive(live, slots);
  if (!m.slot || !m.inSync || !vault.sameJson(m.slot.oauthAccount, live.profile.oauthAccount)) return null;
  const t = txn.supersede(P, why + ' (' + m.slot.name + ')');
  return t ? Object.assign({ activeName: m.slot.name }, t) : null;
}
/** runSwitch — the handoff with the transactional swap per hop; swaps recorded durably as they commit (AR-09/AR-V10). */
async function runSwitch(ctx, o) {
  const { P, S, deps } = ctx;
  let firstPf = o.pf0;
  const verified = {};
  const measure = (token) => M.measureToken(token, deps);
  return handoff.runHandoff({
    P, from: o.from, to: o.to, trigger: o.trigger, threshold: S.threshold.value, kind: o.kind, reason: o.reason || (o.kind === 'manual' ? 'manual' : 'threshold'), maxHops: o.maxHops,
    deps: {
      guard: deps.guard, now: deps.now, log: o.log, readTxn: () => txn.readTxn(P),
      swap: async (name) => {
        const st = vault.readState(P);
        const pf = firstPf && firstPf.target && firstPf.target.name === name ? firstPf
          : await txn.preflight(P, name, { settleMs: deps.settleMs, identify: deps.identify, hooks: deps.swapHooks, measure, readings: st.readings, now: deps.now(), slotFlags: st.slotFlags, allowNeedsRelogin: o.kind === 'rollback' || !!ctx.force });
        firstPf = null;
        if (!pf.ok) return { ok: false, rolledBack: true, outcome: 'preflight-failed', reason: pf.reason };
        if (deps.swapImpl) return deps.swapImpl(P, pf, { hooks: deps.swapHooks });
        return txn.swapLogin(P, pf, { hooks: deps.swapHooks });
      },
      measureActive: async () => {
        const l = vault.readLive(P);
        if (!l.ok) return { ok: false, error: l.reason };
        const r = await M.measureToken(l.creds.claudeAiOauth.accessToken, deps);
        const mm = vault.matchActive(l, vault.listSlots(P));
        if (r.ok && mm.slot && mm.inSync) { verified[mm.slot.name] = M.liveReading(r, deps.now(), { viaSlotToken: true }); if (o.readings) o.readings[mm.slot.name] = verified[mm.slot.name]; } // never attributed on the uuid alone
        return r;
      },
      pickNext: (tried) => (o.selectFrom ? o.selectFrom(tried).target : null),
      allowanceLeft: () => core.allowanceLeft(vault.readState(P).swaps, deps.now()),
      recordSwap: async (entry) => {
        const saved = await vault.updateState(P, (s) => { if (entry.txnId && (s.swaps || []).some((x) => x && x.txnId === entry.txnId)) return; s.swaps = (s.swaps || []).concat([entry]); });
        if (saved && entry.txnId) txn.markAccounted(P, entry.txnId);
        return !!saved;
      },
    },
  }).then((res) => Object.assign(res, { verifiedReadings: verified }));
}
function recordOutcome(ctx, delta, res, o) {
  const { P, deps } = ctx;
  const at = iso(o.now);
  Object.assign(delta.readings, res.verifiedReadings || {});
  delta.history.push({ at, from: o.active, to: res.committedTo, requested: o.target, kind: ctx.manual ? 'manual' : 'auto', tier: o.tier, outcome: res.outcome,
    exhausted: !!res.exhausted, unresolved: !!res.unresolved, hops: res.hops.length, trigger: o.trigger.map((w) => ({ label: w.label, pct: w.pct })) });
  if (res.committedTo && res.committedTo !== o.active) {
    delta.set.lastLeft = { name: o.active, at, resetsAt: core.soonestReset(o.trigger, o.now) || null };
    delta.set.lastSwitch = { from: o.active, to: res.committedTo, at, reason: ctx.manual ? 'manual' : 'threshold', outcome: res.outcome };
  }
  if (res.outcome === 'verified') {
    delta.set.active = res.committedTo; delta.set.pendingVerify = null; delta.consecutive = 'reset';
    try { fs.unlinkSync(P.backup); } catch { /* none */ } // L1: the pre-switch backup goes once the swap is verified
  } else if (res.outcome === 'unmeasurable-fallback') {
    delta.set.pendingVerify = { to: res.committedTo, from: o.active, at, auto: !ctx.manual, failures: 0, credsGen: vault.generation(P.creds), trigger: o.trigger.map((w) => ({ label: w.label, pct: w.pct })) };
  } else if (!(res.hops[0] && res.hops[0].outcome === 'preflight-failed' && res.hops.length === 1)) {
    delta.failures.push({ at, reason: res.reason || res.outcome, target: o.target });
    delta.consecutive = 'inc';
  }
  const word = res.outcome === 'verified' ? 'WISSEL / SWITCHED ' : res.outcome === 'unmeasurable-fallback' ? 'WISSEL NIET GEVERIFIEERD / SWITCH UNVERIFIED ' : 'WISSEL MISLUKT / SWITCH FAILED ';
  vault.log(P, word + o.active + ' -> ' + (res.committedTo || o.target) + ' (' + (ctx.manual ? 'handmatig/manual' : handoff.triggerText(o.trigger)) + ')'
    + (res.unresolved ? ' — NIET teruggezet, onopgelost / NOT rolled back, unresolved (reconcile next round)' : res.outcome === 'failed' && res.hops[0] && res.hops[0].outcome === 'rolled-back' ? ' — teruggezet / rolled back' : '')
    + (res.reason ? ' — ' + res.reason : ''), { quiet: !!deps.quiet });
  const action = res.outcome === 'verified' ? 'switched' : res.outcome === 'unmeasurable-fallback' ? 'switched-unverified' : 'switch-failed';
  return { action, outcome: res.outcome, ok: res.ok, from: o.active, to: res.active, committedTo: res.committedTo, requested: o.target, tier: o.tier,
    exhausted: !!res.exhausted, unresolved: !!res.unresolved, phase: res.phase, hops: res.hops, reason: res.reason || null };
}
/** handlePendingVerify — a committed but unverified switch: verify it now (same threshold/exhaustion rules as an
 *  immediate verification, CONTINUE only when actually written — AR-V06), count a genuine 401, and bound every pending
 *  state by PENDING_VERIFY_MAX_MS (AR-V07). */
async function handlePendingVerify(ctx, e) {
  const { P, S, deps } = ctx;
  const { st, delta, pv, live, active, log } = e;
  const now = deps.now();
  const T = S.threshold.value;
  if (active !== pv.to) { delta.set.pendingVerify = null; log('verificatie vervalt: actief is ' + active + ', niet ' + pv.to + ' / pending verification dropped'); return { action: 'none', reason: 'pending-dropped', active }; }
  const age = now - Date.parse(pv.at);
  const timedOut = !Number.isFinite(age) || age > core.PENDING_VERIFY_MAX_MS;
  const mv = await M.measureToken(live.creds.claudeAiOauth.accessToken, deps);
  if (mv.ok) {
    delta.readings[active] = M.liveReading(mv, now, { viaSlotToken: true });
    delta.set.pendingVerify = null; delta.set.active = active; delta.consecutive = 'reset';
    try { fs.unlinkSync(P.backup); } catch { /* none */ }
    const full = core.crossed(mv.windows, T);
    if (full.length) {
      log('GEVERIFIEERD MAAR VOL / VERIFIED BUT EXHAUSTED — ' + pv.from + ' -> ' + pv.to + ' werkt live maar zit op ' + core.fmtPct(mv.maxPct) + ' (>= ' + T + '%): geen CONTINUE / works live but is over the threshold: no CONTINUE');
      return { action: 'verified', reason: 'deferred-verification', exhausted: true, active, maxPct: mv.maxPct, continueWritten: false };
    }
    const g = deps.guard || handoff.guardLib();
    const h = { id: 'verify-' + now, from: pv.from, to: pv.to, trigger: pv.trigger || [] };
    let gc = { written: false, why: 'error' };
    try { gc = await handoff.writeContinueNotice(g, h, { now, fromLabel: null, toLabel: handoff.labelOf(g), resumed: 0, pausedCount: 0 }); } catch (err) { gc = { written: false, why: 'error (' + ((err && err.name) || 'Error') + ')' }; }
    log('GEVERIFIEERD / VERIFIED — ' + pv.from + ' -> ' + pv.to + ' werkt live / works live; CONTINUE ' + (gc.written ? 'geschreven / written' : 'NIET geschreven / NOT written (' + (gc.why || '?') + ')'));
    return { action: 'verified', reason: 'deferred-verification', active, maxPct: mv.maxPct, continueWritten: !!gc.written, continueWhy: gc.written ? null : gc.why || null };
  }
  if (mv.kind !== 'unauthorized') return { action: 'none', reason: 'check-failed', error: mv.error, active };
  const untouched = vault.generation(P.creds) === pv.credsGen;
  if (untouched && M.expiresMs(live.creds.claudeAiOauth) <= now && !timedOut) {
    noteOnce(st, delta, 'await:' + pv.to, 'wacht op eerste gebruik: het opgeslagen token van ' + pv.to + ' is verlopen en nog niet ververst / awaiting first use: ' + pv.to + '\'s stored token expired and nothing has refreshed it yet', log);
    return { action: 'none', reason: 'awaiting-refresh', active };
  }
  let failures = (Number(pv.failures) || 0) + 1;
  if (timedOut) { failures = Math.max(failures, 2); log('VERIFICATIE VERLOPEN / PENDING VERIFICATION TIMED OUT — ' + pv.to + ' is na ' + Math.round(core.PENDING_VERIFY_MAX_MS / 60000) + ' min nog steeds niet geverifieerd / still unverified'); }
  if (failures < 2 || (!pv.auto && !timedOut)) {
    delta.set.pendingVerify = Object.assign({}, pv, { failures });
    log('NIET GEVERIFIEERD / NOT VERIFIED — ' + pv.to + ' gaf 401 (' + failures + '/2)' + (pv.auto ? '' : ' — handmatige wissel: geen automatische terugzet / manual switch: no automatic rollback'));
    return { action: 'none', reason: 'unverified', failures, active };
  }
  delta.set.slotFlags = Object.assign({}, st.slotFlags, { [pv.to]: { needsRelogin: true, at: iso(now) } });
  if (!pv.auto) {
    delta.set.pendingVerify = null;
    log('HANDMATIGE WISSEL NIET GEVERIFIEERD / MANUAL SWITCH UNVERIFIED — ' + pv.to + ' heeft een nieuwe login nodig (claude /login, dan enroll ' + pv.to + ' --force); niet automatisch teruggezet / needs a new login; not rolled back automatically');
    return { action: 'none', reason: 'unverified-timeout', needsRelogin: pv.to, active };
  }
  log('TERUGZETTEN / ROLLING BACK — ' + pv.to + (timedOut ? ' bleef onverifieerbaar' : ' gaf twee keer 401') + '; terug naar ' + pv.from + ' (laatst bekende goede login); ' + pv.to + ' heeft een nieuwe login nodig / back to the last known good login; needs a new login');
  const pf = await txn.preflight(P, pv.from, { settleMs: deps.settleMs, identify: deps.identify, hooks: deps.swapHooks, measure: (t) => M.measureToken(t, deps), readings: st.readings, now, slotFlags: {}, allowNeedsRelogin: true });
  if (!pf.ok) { delta.set.pendingVerify = Object.assign({}, pv, { failures }); return { action: 'none', reason: 'rollback-preflight-failed', detail: pf.reason, active }; }
  const res = await runSwitch(ctx, { from: pv.to, to: pv.from, trigger: [], kind: 'rollback', reason: 'rollback-needs-relogin', pf0: pf, maxHops: 1, log });
  delta.history.push({ at: iso(now), from: pv.to, to: res.committedTo, requested: pv.from, kind: 'rollback', outcome: res.outcome, hops: res.hops.length });
  if (res.committedTo === pv.from) {
    delta.set.pendingVerify = res.outcome === 'verified' ? null : { to: pv.from, from: pv.to, at: iso(now), auto: false, failures: 0, credsGen: vault.generation(P.creds), trigger: [] };
    if (res.outcome === 'verified') delta.set.active = pv.from;
  } else {
    delta.set.pendingVerify = Object.assign({}, pv, { failures });
    delta.failures.push({ at: iso(now), reason: 'rollback failed: ' + (res.reason || res.outcome), target: pv.from }); delta.consecutive = 'inc';
  }
  return { action: res.committedTo === pv.from ? 'rolled-back-needs-relogin' : 'switch-failed', outcome: res.outcome, from: pv.to, to: res.committedTo, needsRelogin: pv.to, reason: res.reason || null };
}
function writeNotification(P, slots, now, T, res, mode) {
  const st = vault.readState(P);
  const launchHint = 'node .claude/forge-bin/account-rotator.cjs launch --auto -- <claude args>';
  const notice = res.action === 'wait'
    ? 'GEEN BRUIKBAAR ACCOUNT — alle ingeschreven accounts zitten op of boven ' + T + '%; geen wissel, usage-guard pauzeert bij zijn eigen grens; vroegste reset ' + (res.soonestResetAt || 'onbekend') + ' / NO USABLE ACCOUNT — every enrolled account is at or over ' + T + '%; no switch, usage-guard pauses at its own limit; soonest reset ' + (res.soonestResetAt || 'unknown')
    : res.action === 'recommend' ? 'AANBEVELING — ' + (res.from || 'huidige account') + ' zit op de drempel; start een nieuwe sessie met ' + res.to + ': ' + launchHint + ' / RECOMMENDATION — ' + (res.from || 'the current account') + ' reached the threshold; start a new session with ' + res.to + ': ' + launchHint
      : res.action === 'switched' ? 'account gewisseld / switched ' + res.from + ' -> ' + res.to
        : res.action === 'switched-unverified' ? 'gewisseld maar nog niet geverifieerd / switched but not verified yet: ' + res.from + ' -> ' + res.committedTo
          : res.action === 'rolled-back-needs-relogin' ? 'TERUGGEZET — ' + res.needsRelogin + ' heeft een nieuwe login nodig (claude /login, dan enroll ' + res.needsRelogin + ' --force) / ROLLED BACK — ' + res.needsRelogin + ' needs a new login'
            : res.action === 'switch-failed' ? 'wissel mislukt / switch failed' + (res.unresolved ? ' en NIET teruggezet — onopgelost / and NOT rolled back — unresolved' : '') + ': ' + (res.reason || '?')
              : res.reason === 'fail-cap' ? 'GESTOPT: 6 mislukte wissels in 24 uur / STOPPED: 6 failed switches in 24 h' : res.reason === 'unresolved-transaction' ? 'ONOPGELOSTE WISSEL / UNRESOLVED SWAP — ' + (res.detail || '')
                : res.reason === 'active-unverified' ? 'ACTIEVE LOGIN NIET GEVERIFIEERD / ACTIVE LOGIN UNVERIFIED — ' + (res.detail || '') : null;
  vault.writeNotification(P, {
    mode: mode || 'token', active: st.active || null, threshold: T, notice, lastResult: { action: res.action, reason: res.reason || null, at: iso(now) },
    recommendation: st.recommendation || null,
    lastSwitch: st.lastSwitch || null, disabled: !!st.disabled, pendingVerify: st.pendingVerify ? { to: st.pendingVerify.to, from: st.pendingVerify.from, failures: st.pendingVerify.failures || 0 } : null,
    accounts: slots.filter((s) => !s.broken).map((s) => {
      const rec = core.slotMode(s) === 'token' ? tok.tokenReading(s, st.tokenReadings, st.readings) : st.readings[s.name];
      const r = core.effectiveReading(rec, now);
      const j = core.judge(r, T);
      return { name: s.name, mode: core.slotMode(s), status: r.status, maxPct: r.maxPct, usable: j.usable, needsRelogin: !!(st.slotFlags[s.name] && st.slotFlags[s.name].needsRelogin),
        windows: r.windows.map((w) => ({ label: w.label, pct: w.pct, resetsAt: w.resetsAt })), measuredAt: r.measuredAt };
    }),
  });
}

module.exports = Object.assign({}, M, { tick, runSwitch, handlePendingVerify, writeNotification, reconcileAll, supersedeIfConsistent, modeOf, newId: () => crypto.randomUUID() });

// CLI: the command layer lives in account-rotator-cli.cjs (it requires this file; kept separate for size).
if (require.main === module) {
  require('./account-rotator-cli.cjs').main(process.argv.slice(2), {}).then((code) => { process.exitCode = code; },
    (e) => { console.error('account-rotator: onverwachte fout / unexpected error — ' + vault.scrub((e && e.message) || String(e))); process.exitCode = 1; });
}
