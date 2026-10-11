#!/usr/bin/env node
'use strict';
/**
 * account-rotator-handoff.cjs — the FULL handoff around an account switch (owner amendment 2026-10-09: "save
 * everything, switch, then everything continues automatically" — same discipline as usage-guard). Runs under the
 * vault's transaction lock, AFTER account-rotator-txn.cjs preflight() passed (nothing is paused before that).
 *
 *   1 SAVE      handoff.json (token-free) first; running Paperclip agents paused through usage-guard.cjs's OWN helpers
 *               (allAgents/pc/journalAppend: pause-intent -> paused | pause-failed (4xx: certainly not applied) |
 *               pause-unknown (network/5xx: ambiguous, reconciled against the agent's actual state — AR-V08), one
 *               pauseId per round, each record marked by:'account-rotator'); a pause notice in the guard state for active
 *               sessions (tool calls are denied by the session hook while it stands — at most PAUSE_SAFETY_MS, then the
 *               hook self-heals).
 *   2 SWITCH    the transactional swap per hop; every COMMITTED swap is recorded durably the moment it commits
 *               (deps.recordSwap, AR-09 — idempotent by transaction id, with the obligation kept in txn.json until the
 *               state file took it, AR-V10) and an onward hop only runs while the 24 h allowance has room left.
 *   3 OUTCOME   tri-state (AR-05 / AR-V05, per hop): 'verified' (THIS hop's login measured live), 'unmeasurable-fallback'
 *               (files committed but the live measurement failed — no CONTINUE, not reported ok, verified later or
 *               rolled back by the caller), 'failed' (not committed, or unresolved — the failed target is never claimed
 *               active, AR-06). CONTINUE is written only for 'verified' without 'exhausted' (an exhausted result — still
 *               over the threshold — never clears a real usage-guard pause and never writes CONTINUE, AR-07).
 *   FINALLY     on EVERY exit path (including an exception): the pause notice is removed again unless CONTINUE replaced
 *               it, and every agent this round paused is resumed — what cannot be resumed stays unresolved in the
 *               journal, where reconcileHandoff() (and usage-guard's own reconciliation) picks it up; a failed notice
 *               restoration is kept as an obligation in handoff.json and retried by reconcileHandoff() (AR-V08).
 *   FILE MODE ONLY — the default token mode never runs this handoff (account-rotator-recommend.cjs instead).
 *
 * GUARD-STATE CONTRACT: the rotator's guard-state writes carry NO `account` stamp — the global session hook compares
 * the stamp with a raw fingerprint while usage-guard stamps an opaque label, so today the hook ignores every
 * label-stamped state (verified with a sandboxed probe; owner patch proposed). usage-guard adopts an unstamped state
 * on its next tick without a reset, so the CONTINUE write itself drops the previous account's facts, exactly like
 * stateForAccount() does on a real switch. The paused-agent journal stays the account-independent compensation source.
 */
const crypto = require('crypto');
const vault = require('./account-rotator-vault.cjs');
const core = require('./account-rotator-core.cjs');

const PAUSE_SAFETY_MS = 5 * 60 * 1000;
const CARRY_KEYS = ['pauseAt', 'weekPauseAt', 'resumeAt', 'nvidiaShiftAt', 'lastCheckAt', 'heartbeatAt'];
const SNAPSHOT_KEYS = ['mode', 'notice', 'lastPauseAt', 'resumeAtEpoch', 'account', 'rotatorHandoff'];
const BY = 'account-rotator';

let _guard = null;
function guardLib() { if (!_guard) _guard = require('./usage-guard.cjs'); return _guard; }
const pick = (lang, nl, en) => (lang === 'nl' ? nl : en);
const iso = (ms) => new Date(ms).toISOString();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function triggerText(trigger) { return (trigger || []).map((t) => t.label + ' ' + core.fmtPct(t.pct)).join(' + ') || 'handmatig/manual'; }
function langOf(g) { try { return g.resolveGuardLanguage({}); } catch { return 'en'; } }
function labelOf(g) { try { const id = g.readAccountIdentity(); return id && id.fp ? id.fp : null; } catch { return null; } }
function guardStatePath(g) { return g.stateLockPath().replace(/\.lock$/, ''); }
function writeGuardState(g, obj, fence) {
  vault.atomicWrite(guardStatePath(g), vault.scrub(JSON.stringify(obj, null, 2)) + '\n', { mode: 0o644, beforeRename: () => !fence || fence() });
}

// ---- Paperclip agents (through the guard's own helpers and journal) ----------------------------------------
/** pauseAgents — every pause response is classified (AR-V08): 2xx = paused · 4xx = certainly NOT applied
 *  ('pause-failed', resolved) · anything else (network error, timeout, 5xx) = AMBIGUOUS — Paperclip may well have
 *  applied it: journaled 'pause-unknown' (unresolved) and kept in the resume list, so it is reconciled against the
 *  agent's ACTUAL state later, never dropped. */
async function pauseAgents(g, h, fromLabel, log) {
  const agents = await g.allAgents({});
  if (!agents) return { runtime: 'unreachable', pauseId: null, paused: [] };
  const toPause = agents.filter((a) => a.status !== 'paused');
  if (!toPause.length) return { runtime: 'up', pauseId: null, paused: [] };
  const pauseId = crypto.randomUUID();
  const reason = 'ACCOUNT ROTATOR: account switch ' + h.from + ' -> ' + h.to + ' (' + triggerText(h.trigger) + ') — paused for the swap, resumes automatically';
  const paused = [];
  let unknown = 0;
  for (const a of toPause) {
    g.journalAppend({ agentId: a.id, name: a.name, company: a.company, action: 'pause-intent', pauseId, accountFp: fromLabel, resolved: false, by: BY });
    const r = await g.pc('POST', '/api/agents/' + a.id + '/pause', { reason });
    const status = Number(r && r.status) || 0;
    if (status >= 200 && status < 300) {
      paused.push({ id: a.id, name: a.name, company: a.company });
      g.journalAppend({ agentId: a.id, name: a.name, company: a.company, action: 'paused', pauseId, accountFp: fromLabel, resolved: false, by: BY });
    } else if (status >= 400 && status < 500) {
      g.journalAppend({ agentId: a.id, action: 'pause-failed', pauseId, resolved: true, by: BY, status });
    } else {
      unknown++;
      paused.push({ id: a.id, name: a.name, company: a.company, unknown: true });
      g.journalAppend({ agentId: a.id, name: a.name, company: a.company, action: 'pause-unknown', pauseId, accountFp: fromLabel, resolved: false, by: BY, status });
    }
  }
  try { g.compactJournalIfNeeded(); } catch { /* diagnostic only */ }
  log('HANDOFF SAVE — ' + (paused.length - unknown) + '/' + toPause.length + ' Paperclip agent(s) paused' + (unknown ? ', ' + unknown + ' ambiguous (reconciled against actual state)' : '') + ' (journal pauseId recorded)');
  return { runtime: 'up', pauseId, paused };
}
/** resumeAgents — an agent whose pause outcome was ambiguous is first looked up: paused now -> resumed like the others;
 *  running (or gone) -> 'not-paused' (resolved, nothing to undo); Paperclip unreachable -> left unresolved for reconcile. */
async function resumeAgents(g, pauseId, paused, log) {
  let ok = 0;
  const failed = [];
  let actual;
  const stateOf = async (id) => { if (actual === undefined) { try { actual = await g.allAgents({}); } catch { actual = null; } } return actual ? (actual.find((x) => x.id === id) || null) : undefined; };
  for (const a of paused || []) {
    if (a.unknown) {
      const cur = await stateOf(a.id);
      if (cur === undefined) { failed.push(a.id); continue; } // runtime unreachable: stays unresolved in the journal
      if (!cur || cur.status !== 'paused') { ok++; g.journalAppend({ agentId: a.id, action: 'not-paused', pauseId, resolved: true, by: BY }); continue; }
    }
    const r = await g.pc('POST', '/api/agents/' + a.id + '/resume', {});
    if ((r.status >= 200 && r.status < 300) || r.status === 404 || r.status === 410) {
      ok++;
      g.journalAppend({ agentId: a.id, action: 'resumed', pauseId, resolved: true, by: BY, ...(r.status === 404 || r.status === 410 ? { reason: 'agent-not-found' } : {}) });
    } else failed.push(a.id); // left unresolved in the journal — reconcileHandoff / usage-guard retry it
  }
  if ((paused || []).length) log('HANDOFF — ' + ok + '/' + paused.length + ' Paperclip agent(s) resumed' + (failed.length ? ' (' + failed.length + ' left in the journal for reconcile)' : ''));
  return { ok, failed };
}

// ---- guard state: pause notice, CONTINUE notice, restore -----------------------------------------------------
async function writePauseNotice(g, h, now) {
  const lang = langOf(g);
  const r = await g.withStateLock((fence) => {
    const cur = g.readState();
    if (cur.mode === 'paused' || cur.mode === 'corrupt') return { touched: false, why: 'guard state is ' + cur.mode + ' — left untouched' };
    const snapshot = {};
    for (const k of SNAPSHOT_KEYS) if (has(cur, k)) snapshot[k] = cur[k];
    const next = Object.assign({}, cur, {
      mode: 'paused', lastPauseAt: iso(now), resumeAtEpoch: now + PAUSE_SAFETY_MS,
      rotatorHandoff: { id: h.id, phase: 'switching', at: iso(now) },
      notice: pick(lang,
        '⏸ ACCOUNT ROTATOR — accountwissel bezig (' + h.from + ' -> ' + h.to + ', trigger ' + triggerText(h.trigger) + '). Dit duurt seconden (hooguit 5 minuten): wacht even en probeer deze stap opnieuw; daarna gaat het werk vanzelf verder.',
        '⏸ ACCOUNT ROTATOR — account switch in progress (' + h.from + ' -> ' + h.to + ', trigger ' + triggerText(h.trigger) + '). This takes seconds (at most 5 minutes): wait a moment and retry this step; work continues automatically afterwards.'),
    });
    delete next.account;
    if (!fence()) return { touched: false, why: 'fenced' };
    writeGuardState(g, next, fence);
    return { touched: true, snapshot };
  });
  return r.ok ? r.value : { touched: false, why: r.reason };
}
async function writeContinueNotice(g, h, ctx) {
  const lang = langOf(g);
  const now = ctx.now;
  const r = await g.withStateLock((fence) => {
    const cur = g.readState();
    if (cur.mode === 'corrupt') return { written: false, why: 'guard state is corrupt — left for usage-guard to recover' };
    if (cur.mode === 'paused' && !(cur.rotatorHandoff && cur.rotatorHandoff.id === h.id) && Array.isArray(cur.trigger) && cur.trigger.length
      && cur.account && ctx.toLabel && cur.account.fp === ctx.toLabel) return { written: false, why: 'usage-guard paused the new account itself' };
    const next = { mode: 'ok' };
    for (const k of CARRY_KEYS) if (has(cur, k)) next[k] = cur[k];
    Object.assign(next, {
      previousAccount: { fp: ctx.fromLabel || null, switchedAt: iso(now), lastPercents: cur.percents || null, by: BY },
      lastResumeAt: iso(now), pendingCheckup: true,
      rotatorHandoff: { id: h.id, phase: 'continued', at: iso(now), from: h.from, to: h.to },
      accountSwitchNotice: pick(lang, 'ACCOUNT ROTATOR: account gewisseld ' + h.from + ' -> ' + h.to + '.', 'ACCOUNT ROTATOR: account switched ' + h.from + ' -> ' + h.to + '.'),
      resumeNotice: pick(lang,
        '✅ ACCOUNT ROTATOR — account gewisseld ' + h.from + ' -> ' + h.to + ' (trigger ' + triggerText(h.trigger) + '). GA VERDER met het onderbroken werk. '
          + 'VERPLICHTE CHECKUP: (1) verifieer dat je eigen taakstatus klopt met de werkelijkheid, (2) verifieer via de Paperclip API dat de agents echt hervat zijn ('
          + ctx.resumed + '/' + ctx.pausedCount + ' hervat door de rotator), (3) rapporteer eerlijk wat wel/niet doorliep.',
        '✅ ACCOUNT ROTATOR — account switched ' + h.from + ' -> ' + h.to + ' (trigger ' + triggerText(h.trigger) + '). CONTINUE the interrupted work. '
          + 'MANDATORY CHECKUP: (1) verify your own task status matches reality, (2) verify via the Paperclip API that the agents really resumed ('
          + ctx.resumed + '/' + ctx.pausedCount + ' resumed by the rotator), (3) report honestly what did/did not continue.'),
    });
    if (!fence()) return { written: false, why: 'fenced' };
    writeGuardState(g, next, fence);
    return { written: true };
  });
  return r.ok ? r.value : { written: false, why: r.reason };
}
async function restoreGuardState(g, h) {
  const r = await g.withStateLock((fence) => {
    const cur = g.readState();
    if (!cur.rotatorHandoff || cur.rotatorHandoff.id !== h.id) return { restored: false, why: 'guard state changed since the handoff began — the newer write wins' };
    const next = Object.assign({}, cur);
    const snap = (h.guardState && h.guardState.snapshot) || {};
    for (const k of SNAPSHOT_KEYS) { if (has(snap, k)) next[k] = snap[k]; else delete next[k]; }
    if (!fence()) return { restored: false, why: 'fenced' };
    writeGuardState(g, next, fence);
    return { restored: true };
  });
  return r.ok ? r.value : { restored: false, why: r.reason };
}

/** runHandoff(ctx) -> {ok, outcome, exhausted, unresolved, committedTo, verifiedTo, active, hops, reason, handoff}.
 *  ctx = {P, from, to, trigger, threshold, kind, reason, maxHops?, deps: {swap(name) (async, preflight+swap),
 *  measureActive(), pickNext(triedSet), allowanceLeft(), recordSwap(entry) -> bool, readTxn()?, now(), log(msg), guard?}}.
 *  AR-V05: the PHYSICAL commit (committedTo) and the measurement verdict (verifiedTo / outcome) are tracked separately
 *  and reset per hop — a later hop never inherits an earlier hop's 'verified'; on an exception the result is derived
 *  from the durable transaction record (deps.readTxn), not from whatever the loop had reached. */
async function runHandoff(ctx) {
  const d = ctx.deps;
  const g = d.guard || guardLib();
  const P = ctx.P;
  const log = d.log;
  const now = d.now();
  const fromLabel = labelOf(g);
  const h = { version: 2, id: crypto.randomUUID(), phase: 'saving', reason: ctx.reason || 'threshold', kind: ctx.kind || 'auto', trigger: ctx.trigger || [],
    from: ctx.from, to: ctx.to, at: iso(now), resumeAt: iso(now + PAUSE_SAFETY_MS), hops: [], pauseId: null, pausedAgents: [], guardState: { touched: false }, obligations: {} };
  let pa = { paused: [], pauseId: null };
  let gp = { touched: false };
  let outcome = 'failed'; let exhausted = false; let unresolved = false; let committedTo = null; let verifiedTo = null; let reason = null;
  let continueWritten = false; let resumed = false; let current = ctx.to;
  try {
    vault.writeHandoffFile(P, h); // SAVE is on disk before anything changes
    pa = await pauseAgents(g, h, fromLabel, log);
    h.pauseId = pa.pauseId; h.pausedAgents = pa.paused; h.paperclip = pa.runtime;
    gp = await writePauseNotice(g, h, now);
    h.guardState = gp; h.phase = 'switching';
    vault.writeHandoffFile(P, h);
    const tried = new Set([ctx.from]);
    let prev = ctx.from;
    const maxHops = Number.isFinite(ctx.maxHops) ? ctx.maxHops : core.MAX_HOPS;
    for (let hop = 0; hop < maxHops && current; hop++) {
      if (hop > 0 && d.allowanceLeft() < 1) { h.allowanceStop = true; log('HANDOFF — daily swap allowance used up; no onward hop'); break; }
      tried.add(current);
      const sw = await d.swap(current);
      const step = { to: current, ok: !!sw.ok, outcome: sw.outcome || null, reason: sw.reason || null, txnId: sw.txnId || null };
      if (sw.ok) { committedTo = current; verifiedTo = null; outcome = 'unmeasurable-fallback'; exhausted = false; reason = null; } // physical commit first (AR-V05)
      h.hops.push(step); vault.writeHandoffFile(P, h);
      if (!sw.ok) {
        reason = sw.reason;
        if (sw.unresolved) { unresolved = true; outcome = 'failed'; committedTo = null; }
        break; // hop 0: nothing committed; an onward hop: still on the previous committed account (its verdict stands)
      }
      const accounted = await d.recordSwap({ at: iso(d.now()), from: prev, to: current, txnId: sw.txnId || null, kind: h.kind, hop });
      if (accounted === false) { h.obligations.recordSwap = true; log('HANDOFF — swap accounting deferred (state file busy); the transaction record keeps the obligation'); }
      const v = await d.measureActive();
      step.verify = v.ok ? { ok: true, maxPct: v.maxPct } : { ok: false, error: v.error || 'unmeasured' };
      if (!v.ok) { reason = v.error || 'unmeasured'; break; } // outcome stays 'unmeasurable-fallback' for THIS hop
      const full = core.crossed(v.windows, ctx.threshold).length > 0;
      outcome = 'verified'; verifiedTo = current; exhausted = full;
      if (full) {
        step.full = true;
        const next = d.pickNext(tried);
        log('HANDOFF VERIFY — ' + current + ' is actually at ' + core.fmtPct(v.maxPct) + ' (>= ' + ctx.threshold + '%)' + (next && hop + 1 < maxHops ? ' — trying ' + next : ' — no further hop'));
        if (next && hop + 1 < maxHops) { prev = current; current = next; continue; }
      }
      break;
    }
    if (outcome === 'verified' && verifiedTo === committedTo && !exhausted && !unresolved) {
      const ra = await resumeAgents(g, h.pauseId, h.pausedAgents, log);
      resumed = true; h.resumed = ra.ok;
      const gc = await writeContinueNotice(g, h, { now: d.now(), fromLabel, toLabel: labelOf(g), resumed: ra.ok, pausedCount: h.pausedAgents.length });
      continueWritten = !!gc.written; h.continueNotice = gc;
    }
  } catch (e) {
    reason = reason || 'unexpected error during the handoff (' + ((e && e.name) || 'Error') + ')';
    h.error = reason;
    // derive the physical state from the durable record: a swap that committed inside the failing step counts
    try {
      const t = typeof d.readTxn === 'function' ? d.readTxn() : null;
      if (t && t.phase === 'done' && ['committed', 'rolled-forward'].includes(t.outcome) && t.to === current && committedTo !== current) { committedTo = current; verifiedTo = null; }
    } catch { /* no record readable */ }
    outcome = !committedTo ? 'failed' : verifiedTo === committedTo ? 'verified' : 'unmeasurable-fallback';
    if (outcome !== 'verified') exhausted = false;
  } finally {
    try { if (!continueWritten && gp.touched) h.guardRestore = await restoreGuardState(g, h); } catch { h.guardRestore = { restored: false, why: 'error' }; }
    if (!continueWritten && gp.touched && !(h.guardRestore && h.guardRestore.restored) && !/newer write wins/.test((h.guardRestore && h.guardRestore.why) || '')) h.obligations.guardRestore = { why: (h.guardRestore && h.guardRestore.why) || 'unknown' }; // AR-V08: retried by reconcileHandoff
    try { if (!resumed && pa.paused.length) { const ra = await resumeAgents(g, pa.pauseId, pa.paused, log); h.resumed = ra.ok; if (ra.failed.length) h.obligations.resume = ra.failed; } } catch { h.resumeError = true; h.obligations.resume = pa.paused.map((a) => a.id); }
    h.outcome = outcome; h.exhausted = exhausted; h.unresolved = unresolved; h.committedTo = committedTo; h.verifiedTo = verifiedTo;
    h.phase = unresolved ? 'unresolved' : outcome === 'verified' ? (exhausted ? 'exhausted' : 'continued') : outcome === 'unmeasurable-fallback' ? 'unverified'
      : (h.hops[0] && h.hops[0].outcome === 'rolled-back' ? 'rolled-back' : 'failed');
    if (!Object.keys(h.obligations).length) delete h.obligations;
    try { vault.writeHandoffFile(P, h); } catch { /* the log line below still records it */ }
    log('HANDOFF ' + h.phase.toUpperCase() + ' — ' + ctx.from + ' -> ' + (committedTo || ctx.to) + ' · outcome ' + outcome + (exhausted ? ' (still over the threshold — usage-guard\'s own pause remains the fallback)' : '')
      + (reason ? ' · ' + reason : '') + ' · pause notice ' + (continueWritten ? 'replaced by CONTINUE' : gp.touched ? (h.guardRestore && h.guardRestore.restored ? 'removed' : 'not removed (' + (h.guardRestore && h.guardRestore.why) + ')') : 'not written'));
  }
  return { ok: outcome === 'verified', outcome, exhausted, unresolved, committedTo, verifiedTo, active: outcome === 'verified' ? committedTo : null, phase: h.phase, hops: h.hops, reason, handoff: h };
}

/** reconcileHandoff(P, g, log) — startup cleanup (AR-07 / AR-V08): a handoff left in 'saving'/'switching' by a dead
 *  process gets its guard notice restored (only while the guard state still carries that handoff's marker); a FINISHED
 *  handoff that still carries a guardRestore obligation is retried the same way; every agent this tool paused (or may
 *  have paused — 'pause-unknown') that is still unresolved in the journal is resumed against its actual state. Runs
 *  under the txn lock. */
async function reconcileHandoff(P, g, log) {
  const out = { restored: false, resumed: 0 };
  const h = vault.readHandoffFile(P);
  if (h && (h.phase === 'saving' || h.phase === 'switching')) {
    if (h.guardState && h.guardState.touched) { const rs = await restoreGuardState(g, h); out.restored = !!rs.restored; }
    h.phase = 'recovered'; h.recoveredAt = new Date().toISOString();
    vault.writeHandoffFile(P, h);
    log('RECONCILE — an interrupted handoff (' + h.from + ' -> ' + h.to + ') was cleaned up; pause notice ' + (out.restored ? 'removed' : 'not ours any more'));
  } else if (h && h.obligations && h.obligations.guardRestore && h.guardState && h.guardState.touched) {
    const rs = await restoreGuardState(g, h);
    if (rs.restored || /newer write wins/.test(rs.why || '')) { delete h.obligations.guardRestore; if (!Object.keys(h.obligations).length) delete h.obligations; h.guardRestore = rs; vault.writeHandoffFile(P, h); out.restored = !!rs.restored; log('RECONCILE — the pause notice of handoff ' + h.from + ' -> ' + h.to + ' was ' + (rs.restored ? 'restored (retried obligation)' : 'already replaced by a newer guard write')); }
  }
  let open = [];
  try { open = g.unresolvedPausedAgents().filter((r) => r && r.by === BY); } catch { open = []; }
  const byPause = new Map();
  for (const r of open) { const k = r.pauseId || ''; if (!byPause.has(k)) byPause.set(k, []); byPause.get(k).push({ id: r.agentId, name: r.name, company: r.company, unknown: r.action === 'pause-unknown' }); }
  for (const [pauseId, list] of byPause) { const ra = await resumeAgents(g, pauseId || null, list, log); out.resumed += ra.ok; }
  return out;
}

/** recordWaiting(P, o) — no usable account: no swap; the handoff says so and names the soonest reset. */
function recordWaiting(P, o) {
  const h = { version: 1, id: crypto.randomUUID(), phase: 'waiting', reason: 'no-usable-account', from: o.from, to: null,
    trigger: o.trigger || [], at: iso(o.now), soonestResetAt: o.soonestResetAt || null,
    note: 'no enrolled account is below the threshold — no switch; usage-guard\'s own pause and reset-based auto-resume remain the fallback; the rotator switches automatically as soon as an account is usable again' };
  vault.writeHandoffFile(P, h);
  return h;
}

module.exports = { PAUSE_SAFETY_MS, runHandoff, reconcileHandoff, recordWaiting, pauseAgents, resumeAgents, writePauseNotice, writeContinueNotice, restoreGuardState, guardLib, triggerText, labelOf };
