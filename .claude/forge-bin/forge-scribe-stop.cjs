#!/usr/bin/env node
'use strict';
/**
 * forge-scribe-stop.cjs — the scribe's project Stop hook (part ii,
 * 2026-10-10; audit SCRIBE-F3; Codex R3 SC-07/SC-12 the same day). When Claude is about to stop while a Forge run is
 * active, and an owner request that forge-scribe-hook.cjs captured IN THIS SESSION is still unplanned (status
 * unclassified or open: no link, no defer/answer/cancel), it BLOCKS the stop once with exit 2 and a three-line plain
 * message on stderr (Claude Code shows stderr of a blocking Stop hook to Claude): what is open, and the exact command to
 * plan, carry over or answer it. Claude then deals with it and stops normally.
 *
 * ONCE PER ITEM, NEVER A LOOP: it prints nothing and exits 0 while `stop_hook_active` is true (Claude is already
 * continuing because of a stop hook), and every item it reminded about is recorded for this session in
 * .claude/forge-scribe/hook-state.json as a compact range string ("1-5,7") with NO item cap (SC-12: the old 200-id cap
 * let 201 open items cycle), so the same item never blocks a second time in that session. When that record cannot be
 * written, it does NOT block (it cannot promise "once"). Planned, in-progress, done, defer-proposed, deferred, answered
 * and cancelled items never block; neither do items another session captured.
 *
 * START: like every scribe entry point it first re-folds inbox prompts that a crash left without an item (SC-07), best
 * effort and BOUNDED (Codex R5 SV-09: at most RECOVER_BATCH per stop, none started after RECOVER_BUDGET_MS — a timer
 * cannot interrupt synchronous work in Node, see DEADLINE in forge-scribe-hook.cjs). A prompt of this session that is
 * still not an item is an ORPHAN and is reported like an open item (once per prompt id, `reminded_p`), so an unfolded
 * backlog never lets a stop through silently; the gate counts the same orphans as open.
 * FAIL-OPEN: no active run, no session_id, no scribe in the project, an unreadable store or any error -> exit 0,
 * nothing printed. A failsafe timer exits 0 silently after STOP_DEADLINE_MS. No LLM call, no network.
 * OPT-OUT: env FORGE_SCRIBE_STOP=off (or remove its entry from the Stop hooks in .claude/settings.json).
 * MODEL: runStop(payload, opts) -> {block, text, reason, rids, run_id, ms}. Seams: the same as forge-scribe-hook.cjs
 * (opts.projectRoot, opts.env, opts.scribe, opts.activeRun, opts.now).
 */
const fs = require('fs');
const H = require('./forge-scribe-hook.cjs');

const STOP_DEADLINE_MS = 3000;
const LOCK_WAIT_MS = 600;
const RECOVER_BATCH = 8;          // R5 SV-09: at most this many crash orphans folded per stop ...
const RECOVER_BUDGET_MS = 700;    // ... and none started after this much time since the hook began (see DEADLINE in forge-scribe-hook.cjs)
const OPEN_STATUSES = ['unclassified', 'open'];
const MAX_LISTED = 6;
const TITLE_MAX = 48;
const LINE_MAX = 420;
const MAX_STDIN_BYTES = 1024 * 1024;

function messageFor(items, runId, orphans) {
  const cli = H.CLI;
  const orph = orphans || [];
  // orphans first: they are not even items yet (a crash backlog the bounded recovery has not folded)
  const all = orph.map((r) => r.pid + ' (not an item yet) "' + H.oneLine(r.text, TITLE_MAX) + '"')
    .concat(items.map((i) => i.rid + ' (' + i.class + ') "' + H.oneLine(i.title, TITLE_MAX) + '"'));
  const more = all.length > MAX_LISTED ? ' +' + (all.length - MAX_LISTED) + ' more (' + cli + ' list --status unclassified,open)' : '';
  return [
    H.oneLine('[forge-scribe] Owner request(s) captured this session are not planned yet (run ' + runId + ')' + (orph.length ? ', ' + orph.length + ' of them not an item yet' : '') + ': ' + all.slice(0, MAX_LISTED).join(', ') + more, LINE_MAX),
    H.oneLine((orph.length ? orph.length + ' prompt(s) are not items yet (crash recovery runs in batches) — first: ' + cli + ' recover; then ' : '')
      + 'Before you stop, for each: plan it — ' + cli + ' link R-n --wp <wp_id> --run ' + runId + ' — or propose to carry it over — '
      + cli + ' transition R-n defer --reason "<why>" (the owner confirms at the end; unclassified: ' + cli + ' classify R-n <class> first; question/ack: transition R-n answer --reason "<where>").', LINE_MAX),
    'This reminder fires once per item (FORGE_SCRIBE_STOP=off silences it); owner acks stay batched for the end of the run.',
  ].join('\n');
}
/** P-id sets are stored like the R-id sets (compact numeric ranges, no cap) under `reminded_p`. */
const encodePids = (pids) => H.encodeRids(Array.from(pids || []).map((p) => 'R-' + parseInt(String(p).replace(/^P-/i, ''), 10)));
const decodePids = (s) => new Set(Array.from(H.decodeRids(s)).map((r) => 'P-' + String(parseInt(r.slice(2), 10)).padStart(6, '0')));
function remindedPOf(rec) { return decodePids(rec && typeof rec.reminded_p === 'string' ? rec.reminded_p : ''); }

/** remindedOf(rec) — the session's reminded ids (the compact string, plus a pre-R3 `stop_blocked` array). */
function remindedOf(rec) {
  const s = H.decodeRids(rec && typeof rec.reminded === 'string' ? rec.reminded : '');
  if (rec && Array.isArray(rec.stop_blocked)) for (const r of rec.stop_blocked) s.add(String(r));
  return s;
}

/** runStop(payload, opts) -> see the header MODEL. Never throws. */
function runStop(payload, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const out = (o) => Object.assign({ block: false, text: null, reason: null, rids: [], run_id: null }, o, { ms: Date.now() - t0 });
  try {
    const env = opts.env || process.env;
    if (H.isOff(env.FORGE_SCRIBE_STOP)) return out({ reason: 'disabled (FORGE_SCRIBE_STOP=off)' });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out({ reason: 'no hook payload' });
    if (payload.stop_hook_active === true) return out({ reason: 'stop_hook_active — already continuing because of a stop hook' });
    const sessionId = H.str(payload.session_id, 200);
    if (!sessionId) return out({ reason: 'no session_id — cannot tell which items this session captured' });
    const root = H.resolveRoot(opts);
    const mod = H.loadScribe(root, opts);
    if (!mod) return out({ reason: 'forge-scribe is not installed in this project' });
    const { S, SC } = mod;
    const p = S.paths(root);
    if (!fs.existsSync(p.ledger) && !fs.existsSync(p.inbox)) return out({ reason: 'the scribe has captured nothing in this project' });
    const act = H.activeRunOf(root, opts);
    if (!act) return out({ reason: 'no active run' });
    // R5 SV-09: a BOUNDED crash-recovery batch with a deadline (never an unbounded replay); what is left stays an orphan
    let recovered = [];
    if (SC && typeof SC.recover === 'function') {
      try {
        recovered = SC.recover({ root, config: opts.config, now: opts.now, lockWaitMs: LOCK_WAIT_MS,
          max: Number.isFinite(opts.recoverBatch) ? opts.recoverBatch : RECOVER_BATCH, deadline: t0 + (Number.isFinite(opts.recoverBudgetMs) ? opts.recoverBudgetMs : RECOVER_BUDGET_MS) }) || [];
      } catch { recovered = []; /* best effort: the orphans below still block */ }
    }
    const mine = S.readJsonl(p.inbox, false).filter((r) => r && r.session_id === sessionId && typeof r.pid === 'string');
    const pids = new Set(mine.map((r) => r.pid));
    if (!pids.size) return out({ reason: 'nothing captured in this session', run_id: act.run_id, recovered: recovered.length });
    const state = S.loadState(p);
    const itemPids = new Set(Object.values(state.items || {}).map((i) => i && i.pid).filter(Boolean));
    const open = Object.values(state.items || {}).filter((i) => i && pids.has(i.pid) && OPEN_STATUSES.includes(i.status))
      .sort((a, b) => String(a.rid).localeCompare(String(b.rid)));
    // an owner prompt of this session that is not an item yet (an orphan the bounded recovery has not folded) is open too
    const orphans = mine.filter((r) => /^P-\d+$/.test(r.pid) && typeof r.text === 'string' && !r.duplicate_of && !itemPids.has(r.pid));
    if (!open.length && !orphans.length) return out({ reason: 'every request captured this session is planned or closed', run_id: act.run_id, recovered: recovered.length });
    const key = H.sessionKey(sessionId);
    const rec = H.sessionRecord(p, key);
    const already = remindedOf(rec);
    const alreadyP = remindedPOf(rec);
    const fresh = open.filter((i) => !already.has(i.rid));
    const freshO = orphans.filter((r) => !alreadyP.has(r.pid));
    if (!fresh.length && !freshO.length) return out({ reason: 'each open item of this session was already reminded once', run_id: act.run_id, recovered: recovered.length });
    const iso = (typeof opts.now === 'function' ? opts.now() : new Date()).toISOString();
    try {
      H.updateSession(S, p, key, (r) => {
        const all = remindedOf(r);
        for (const i of fresh) all.add(i.rid);
        r.reminded = H.encodeRids(all);
        if (freshO.length) { const allP = remindedPOf(r); for (const o of freshO) allP.add(o.pid); r.reminded_p = encodePids(allP); }
        delete r.stop_blocked;
        return r;
      }, iso, { waitMs: LOCK_WAIT_MS });
    } catch (e) {
      return out({ reason: 'could not record the reminder (' + String(e && e.message || e).slice(0, 120) + ') — not blocking, "once" cannot be promised', run_id: act.run_id, recovered: recovered.length });
    }
    return out({ block: true, text: messageFor(fresh, act.run_id, freshO), rids: fresh.map((i) => i.rid), pids: freshO.map((r) => r.pid), run_id: act.run_id, recovered: recovered.length, orphans: orphans.length });
  } catch (e) {
    return out({ reason: 'internal: ' + String(e && e.message || e).split('\n')[0].slice(0, 200) });
  }
}

module.exports = { runStop, messageFor, remindedOf, remindedPOf, encodePids, decodePids, STOP_DEADLINE_MS, OPEN_STATUSES, RECOVER_BATCH, RECOVER_BUDGET_MS };

// ---- CLI (Stop hook target — exit 2 + stderr text to block once, otherwise exit 0 and nothing) ----
if (require.main === module) {
  let done = false;
  const finish = (text) => {
    if (done) return;
    done = true;
    if (text) {
      try { fs.writeSync(2, text + '\n'); } catch { process.exit(0); }
      process.exit(2);
    }
    process.exit(0);
  };
  const failsafe = setTimeout(() => finish(null), STOP_DEADLINE_MS);
  if (failsafe.unref) failsafe.unref();
  const chunks = [];
  let size = 0;
  process.stdin.on('data', (c) => { size += c.length; if (size <= MAX_STDIN_BYTES) chunks.push(c); });
  process.stdin.on('error', () => finish(null));
  process.stdin.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { payload = null; }
    // an unreadable payload cannot say whether stop_hook_active is set: never block on it
    if (!payload || typeof payload !== 'object' || size > MAX_STDIN_BYTES) { finish(null); return; }
    let r = null;
    try { r = runStop(payload, {}); } catch { r = null; }
    finish(r && r.block ? r.text : null);
  });
  process.stdin.resume();
}
