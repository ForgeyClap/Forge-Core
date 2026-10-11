#!/usr/bin/env node
'use strict';
/**
 * forge-stop-obligations.cjs — (2026-10-10; audit
 * enforcement-core T3/T8/T10 + P1 "call sites"). Two jobs in one zero-dependency file:
 *
 *  1. The project STOP HOOK (registered in .claude/settings.json through forge-settings-merge.cjs). When Claude
 *     stops while a Forge run is active, it prints that run's outstanding obligations — the ones
 *     `forge-runcontract.cjs plan` marks overdue or due now — as a short ADVISORY message for the owner
 *     (`{"systemMessage": ...}` on stdout, exit 0). It never blocks a stop, honours `stop_hook_active` (prints
 *     nothing while Claude is already continuing because of a stop hook), and prints NOTHING when there is no
 *     active run or nothing is due. Budget: under 1 s (a failsafe timer exits silently at STOP_DEADLINE_MS).
 *     WP-SCRIBE-REPEAT: independent of a run, it also adds ONE line naming owner repeats (scribe items
 *     with repeat_of) whose chain has no HARD RULE link yet (`forge-scribe.cjs transition R-n repeat-rule --ref
 *     standing_rule:<id>|decision_logged:<event_id>`). Advisory like the rest; it never blocks.
 *     Honest limit: a Stop-hook systemMessage is shown to the OWNER; Claude itself does not read it. The model
 *     sees the same obligations through the compaction re-inject (forge-snapshot-reinject.cjs) and through
 *     `node .claude/forge-bin/forge-runcontract.cjs plan --run <id>`.
 *
 *  2. The SHARED HELPERS the three hook call sites use, so they agree on one definition:
 *       findActiveRun(root)       — "the active run": the most recently appended run (events.jsonl mtime) among
 *                                   the newest MAX_CANDIDATES within ACTIVE_MAX_AGE_MS, that has a run_started
 *                                   event (or a run.json), is not finalized (no run-finalized.json) and is not
 *                                   closed (its last non-audit event is not run_completed). Doctor-receipt-only
 *                                   folders never qualify. Never throws.
 *       obligationsFor(root, id)  — forge-runcontract.cjs planFor() condensed to <= OBLIGATION_MAX_LINES lines and
 *                                   <= OBLIGATION_MAX_CHARS characters. Fails open: a corrupt log, a missing
 *                                   checker or a throwing plan gives {ok:false, reason} plus ONE honest line.
 *       appendRunEvent(...)       — one best-effort append through the project's own log-event.cjs (the single
 *                                   writer: strict vocabulary, hash chain, lock), as a CHILD process with a hard
 *                                   timeout, so a held lock or a slow disk can never stall the calling hook. Only
 *                                   the two hook events (gate_blocked, session_resumed) are allowed. Never throws.
 *       recordGateBlock(...)      — the gate hook's run record: on a final block (exit 2) of a LIVE Claude Code call
 *                                   (session_id + transcript_path present) one gate_blocked {gate, gates,
 *                                   command_digest (sha256 only), tool} on the active run, inside a time budget
 *                                   that ends RECORD_BUDGET_END_MS after the hook process started. Never throws.
 *     Callers: forge-gate-hook.cjs (gate_blocked on a block), forge-snapshot-reinject.cjs (obligations block +
 *     session_resumed after a compaction), and this file's own Stop hook.
 *
 * OPT-OUT: env FORGE_STOP_OBLIGATIONS=off silences the Stop hook (removing its settings.json entry removes it);
 * env FORGE_GATE_RUN_EVENT=off stops the gate hook's gate_blocked record (its verdict is unaffected either way).
 * (A forge-config key would be the beginner-friendly switch; FORGE_CONFIG_SCHEMA.json is outside this work
 * package, so that is a recorded follow-up, not a silent gap.)
 *
 * MODEL: findActiveRun · obligationsFor · formatObligations · appendRunEvent · runStop(payload, opts) ->
 * {print, text, reason, run_id, due_count, ms}. CLI: stdin (the Stop hook JSON) -> runStop -> stdout JSON or
 * nothing -> exit 0, always.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // a run silent for a day is not "active" (paused/abandoned)
const MAX_CANDIDATES = 8;                       // newest run folders inspected (bounded hook cost)
const MAX_EVENTS_BYTES = 8 * 1024 * 1024;       // a log larger than this is not parsed inside a hook
const OBLIGATION_MAX_LINES = 10;
const OBLIGATION_MAX_CHARS = 1600;               // ~400 tokens (chars/4)
const OBLIGATION_ITEM_LINES = 6;                // header + 6 items + "more" + Next + pointer = 10
const LINE_MAX_CHARS = 180;
const STOP_DEADLINE_MS = 900;
const APPEND_TIMEOUT_MS = 2500;
const APPEND_MIN_MS = 300;
const APPEND_MAX_MS = 5000;
const APPEND_ENV_VAR = 'FORGE_HOOK_EVENT_JSON';
const HOOK_EVENT_TYPES = new Set(['gate_blocked', 'session_resumed']);
// mirrors forge-runcontract.cjs POST_COMPLETION_AUDIT_TYPES: after run_completed only these keep a run closed
const POST_COMPLETION_AUDIT = new Set(['run_finalized', 'gate_evaluated', 'contract_checked']);
const MAX_STDIN_BYTES = 1024 * 1024;

function short(e) { return String((e && (e.message || e.code)) || e || 'unknown error').split('\n')[0].slice(0, 200); }
function oneLine(s, max) {
  // single line, no control characters, bounded — hook output is re-read as context, never as instructions
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = max || LINE_MAX_CHARS;
  return t.length > m ? t.slice(0, m - 1) + '…' : t;
}
function isOff(v) { return /^(off|0|false|no)$/i.test(String(v == null ? '' : v).trim()); }
function tsMs(e) { const ms = e && typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN; return Number.isFinite(ms) ? ms : null; }

/** readEventsLenient(file) -> {events, malformed} — BOM-tolerant, bad lines skipped, never throws. */
function readEventsLenient(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { events: [], malformed: 0, unreadable: true }; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const events = [];
  let malformed = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const e = JSON.parse(s); if (e && typeof e === 'object' && !Array.isArray(e)) events.push(e); else malformed++; } catch { malformed++; }
  }
  return { events, malformed };
}

/** openStateOf(events) -> {genuine, closed, lastEventMs} from a run's own events (no checker needed). */
function openStateOf(events) {
  let genuine = false, completed = -1, lastMs = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.event_type === 'run_started') genuine = true;
    if (e.event_type === 'run_completed') completed = i;
    const ms = tsMs(e);
    if (ms !== null && (lastMs === null || ms > lastMs)) lastMs = ms;
  }
  let closed = false;
  if (completed >= 0) {
    closed = true;
    for (let i = completed + 1; i < events.length; i++) {
      if (!POST_COMPLETION_AUDIT.has(events[i].event_type)) { closed = false; break; } // reopened by later work
    }
  }
  return { genuine, closed, lastEventMs: lastMs };
}

function hasRunJson(runDir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')); return !!j && typeof j === 'object' && !Array.isArray(j); }
  catch { return false; }
}

/** findActiveRun(root, opts) -> {run:{run_id, runDir, last_event_at, events}|null, reason, skipped:[...]}.
 *  opts.now (ms), opts.maxAgeMs, opts.maxCandidates — test seams. See the file header for the definition. */
function findActiveRun(root, opts) {
  opts = opts || {};
  const skipped = [];
  try {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : ACTIVE_MAX_AGE_MS;
    const runsDir = path.join(root, '.claude', 'forge-runs');
    let dirents;
    try { dirents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return { run: null, reason: 'no .claude/forge-runs folder', skipped }; }
    const cands = [];
    for (const d of dirents) {
      if (!d.isDirectory() || !RUN_ID_RE.test(d.name)) continue;
      let st;
      try { st = fs.statSync(path.join(runsDir, d.name, 'events.jsonl')); } catch { continue; }
      if (!st.isFile() || now - st.mtimeMs > maxAge) continue;
      cands.push({ name: d.name, mtimeMs: st.mtimeMs, size: st.size });
    }
    cands.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    const limit = typeof opts.maxCandidates === 'number' ? opts.maxCandidates : MAX_CANDIDATES;
    for (const c of cands.slice(0, limit)) {
      const runDir = path.join(runsDir, c.name);
      if (fs.existsSync(path.join(runDir, 'run-finalized.json'))) { skipped.push(c.name + ': finalized'); continue; }
      if (c.size > MAX_EVENTS_BYTES) { skipped.push(c.name + ': events log too large to read in a hook'); continue; }
      const { events } = readEventsLenient(path.join(runDir, 'events.jsonl'));
      const st = openStateOf(events);
      if (!st.genuine && !hasRunJson(runDir)) { skipped.push(c.name + ': no run_started (not a dispatched run)'); continue; }
      if (st.closed) { skipped.push(c.name + ': closed (run_completed)'); continue; }
      if (st.lastEventMs !== null && now - st.lastEventMs > maxAge) { skipped.push(c.name + ': last event older than the active window'); continue; }
      return {
        run: { run_id: c.name, runDir, events: events.length, last_event_at: st.lastEventMs === null ? null : new Date(st.lastEventMs).toISOString() },
        reason: null, skipped,
      };
    }
    return { run: null, reason: cands.length ? 'no open run among the ' + Math.min(cands.length, limit) + ' most recent' : 'no run appended to within the active window', skipped };
  } catch (e) {
    return { run: null, reason: 'active-run lookup failed: ' + short(e), skipped };
  }
}

/** loadRunContract(root, opts) — the project's own forge-runcontract.cjs, else this file's sibling copy; null if
 *  neither loads. opts.runcontract injects a module (tests; null = "absent"). */
function loadRunContract(root, opts) {
  if (opts && opts.runcontract !== undefined) return opts.runcontract;
  for (const p of [path.join(root, '.claude', 'forge-bin', 'forge-runcontract.cjs'), path.join(__dirname, 'forge-runcontract.cjs')]) {
    try { if (fs.existsSync(p)) return require(p); } catch { /* try the next copy */ }
  }
  return null;
}

function planCommand(runId) { return 'node .claude/forge-bin/forge-runcontract.cjs plan --run ' + runId; }

/** capLines(lines, maxLines, maxChars) — at most maxLines lines and maxChars characters, cut at a line boundary. */
function capLines(lines, maxLines, maxChars) {
  const out = [];
  let used = 0;
  for (const l of lines.slice(0, maxLines)) {
    const add = (out.length ? 1 : 0) + l.length;
    if (used + add > maxChars) break;
    out.push(l);
    used += add;
  }
  return out;
}

/** formatObligations(plan, due, opts) -> lines (<= OBLIGATION_MAX_LINES, <= OBLIGATION_MAX_CHARS). opts.mode
 *  'stop' | 'reinject' only changes the header wording. */
function formatObligations(plan, due, opts) {
  opts = opts || {};
  const c = plan.contract || {};
  const st = plan.state || {};
  const missing = Array.isArray(c.missing) ? c.missing.length : 0;
  const head = '[forge] run ' + plan.run_id + ' — ' + (st.status || '?') + ' (phase ' + (st.phase || '?') + ') · contract '
    + (c.ok ? 'OK' : 'NOT DONE (' + missing + ' missing)') + ' · ' + due.length + ' obligation(s) due now'
    + (opts.mode === 'stop' ? ' (advisory)' : '');
  const headLine = oneLine(head, 220);
  // the tail (Next + the plan command) is reserved first, so a long item list can never push it out
  const tail = [];
  if (plan.next && plan.next.text) tail.push(oneLine('Next: ' + plan.next.text));
  tail.push(oneLine('Full list + completion steps: ' + planCommand(plan.run_id)));
  const items = due.map((o) => '  ' + oneLine((o.severity === 'block' ? '✗' : '⚠') + ' [' + o.severity + '] ' + o.id + ' — ' + o.due + ' — ' + (o.how || o.reason || ''), LINE_MAX_CHARS - 2));
  const MORE_RESERVE = 20; // room for "  … +NN more"
  let chars = OBLIGATION_MAX_CHARS - headLine.length - tail.reduce((n, l) => n + 1 + l.length, 0);
  const maxItemLines = Math.min(OBLIGATION_ITEM_LINES, OBLIGATION_MAX_LINES - 1 - tail.length);
  const picked = [];
  for (const l of items) {
    const needMore = items.length > picked.length + 1;
    if (picked.length + 1 + (needMore ? 1 : 0) > maxItemLines + 1) break;
    if (1 + l.length + (needMore ? MORE_RESERVE : 0) > chars) break;
    picked.push(l);
    chars -= 1 + l.length;
  }
  const rest = items.length - picked.length;
  const lines = [headLine].concat(picked, rest ? ['  … +' + rest + ' more'] : [], tail);
  return capLines(lines, OBLIGATION_MAX_LINES, OBLIGATION_MAX_CHARS); // a last safety net; the budget above already fits
}

/** obligationsFor(root, runId, opts) -> {ok, run_id, due_count, lines, text, reason}. Never throws (fail-open:
 *  {ok:false} plus one honest line naming the command to run by hand). opts.mode 'stop'|'reinject'. */
function obligationsFor(root, runId, opts) {
  opts = opts || {};
  const fail = (reason, unavailable) => {
    const lines = [oneLine('[forge] run ' + runId + ': obligations could not be computed — run ' + planCommand(runId) + ' (' + oneLine(reason, 140) + ')', 320)];
    return { ok: false, unavailable: !!unavailable, run_id: runId, due_count: null, lines, text: lines.join('\n'), reason };
  };
  try {
    if (!RUN_ID_RE.test(String(runId || ''))) return fail('invalid run id');
    const rc = loadRunContract(root, opts);
    if (!rc || typeof rc.planFor !== 'function') return fail('forge-runcontract.cjs planFor is not available', true);
    let plan;
    try { plan = rc.planFor({ run_id: runId }, { root }); } catch (e) { return fail(short(e)); }
    if (!plan || !Array.isArray(plan.obligations)) return fail('the plan has no obligations list');
    const due = plan.obligations.filter((o) => o && (o.due === 'overdue' || o.due === 'due-now'));
    const lines = formatObligations(plan, due, opts);
    return { ok: true, run_id: runId, due_count: due.length, lines, text: lines.join('\n'), reason: null };
  } catch (e) {
    return fail('internal: ' + short(e));
  }
}

/** appendRunEvent(root, runId, eventType, fields, opts) -> {ok, reason}. ONE attempt, never retried (a retry
 *  after a timeout could write a second copy). The child gets FORGE_EVENTS_LOCK_TIMEOUT_MS below its own kill
 *  timeout, so it gives up on a held lock cleanly instead of being killed while holding it. Never throws. */
function appendRunEvent(root, runId, eventType, fields, opts) {
  opts = opts || {};
  try {
    if (!RUN_ID_RE.test(String(runId || ''))) return { ok: false, reason: 'invalid run id' };
    if (!HOOK_EVENT_TYPES.has(eventType)) return { ok: false, reason: 'event type ' + eventType + ' is not a hook event' };
    const logEvent = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
    if (!fs.existsSync(logEvent)) return { ok: false, reason: 'log-event.cjs not found in this project' };
    const req = Number(opts.timeoutMs);
    const timeoutMs = Math.max(APPEND_MIN_MS, Math.min(APPEND_MAX_MS, Number.isFinite(req) && req > 0 ? req : APPEND_TIMEOUT_MS));
    const env = Object.assign({}, process.env, {
      [APPEND_ENV_VAR]: JSON.stringify(fields || {}),
      FORGE_EVENTS_LOCK_TIMEOUT_MS: String(Math.max(100, timeoutMs - 400)),
    });
    const r = spawnSync(process.execPath, [logEvent, runId, eventType, '--env', APPEND_ENV_VAR], {
      cwd: root, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) return { ok: false, reason: r.error.code === 'ETIMEDOUT' ? 'log-event timed out after ' + timeoutMs + 'ms' : short(r.error) };
    if (r.status !== 0) return { ok: false, reason: 'log-event exited ' + r.status + ': ' + oneLine(r.stderr, 200) };
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: 'internal: ' + short(e) };
  }
}

// ---- gate_blocked run record (called by forge-gate-hook.cjs::recordGateBlocked, AFTER its verdict is final) ----
// The whole record step must end before RECORD_BUDGET_END_MS after the hook process started (the settings.json
// gate-hook timeout is 10 s); one append gets at most RECORD_MAX_MS and is skipped with less than RECORD_MIN_MS.
const RECORD_BUDGET_END_MS = 8000;
const RECORD_MAX_MS = 2500;
const RECORD_MIN_MS = 400;
function nonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

/** recordGateBlock(rawOrPayload, runResult, opts) -> {recorded, run_id?, gate?, reason}. runResult is
 *  forge-gate-hook run()'s result ({exitCode, gates}); only exitCode 2 is recorded. Seams: opts.projectRoot (the
 *  gate hook passes its own project), opts.env, opts.elapsedMs (time already spent; the CLI passes its process
 *  uptime, a direct call defaults to 0), opts.now, opts.append (replaces appendRunEvent). Never throws. */
function recordGateBlock(rawOrPayload, runResult, opts) {
  opts = opts || {};
  try {
    if (!runResult || runResult.exitCode !== 2) return { recorded: false, reason: 'not a block' };
    const env = opts.env || process.env;
    if (isOff(env.FORGE_GATE_RUN_EVENT)) return { recorded: false, reason: 'FORGE_GATE_RUN_EVENT=off' };
    const payload = typeof rawOrPayload === 'string' ? JSON.parse(rawOrPayload) : rawOrPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { recorded: false, reason: 'no payload' };
    // Claude Code sends session_id + transcript_path on every real tool call; a test or hand-fed payload does not,
    // and must never write into a real run.
    if (!nonEmptyString(payload.session_id) || !nonEmptyString(payload.transcript_path)) {
      return { recorded: false, reason: 'not a live Claude Code call (no session_id/transcript_path)' };
    }
    const elapsed = typeof opts.elapsedMs === 'number' ? opts.elapsedMs : 0;
    const budget = Math.min(RECORD_MAX_MS, RECORD_BUDGET_END_MS - elapsed);
    if (!(budget >= RECORD_MIN_MS)) return { recorded: false, reason: 'no time budget left (' + Math.round(elapsed) + 'ms spent)' };
    const root = opts.projectRoot ? path.resolve(opts.projectRoot) : DEFAULT_ROOT;
    const act = findActiveRun(root, { now: opts.now });
    if (!act.run) return { recorded: false, reason: 'no active run (' + act.reason + ')' };
    const input = payload.tool_input;
    const command = input && typeof input === 'object' && typeof input.command === 'string' ? input.command : '';
    const gates = Array.isArray(runResult.gates) && runResult.gates.length ? runResult.gates.slice(0, 8).map(String) : ['unknown'];
    const fields = {
      agent: 'system', role: 'gate-hook', gate: gates[0], gates,
      command_digest: 'sha256:' + crypto.createHash('sha256').update(command, 'utf8').digest('hex'),
      tool: typeof payload.tool_name === 'string' ? payload.tool_name : null,
      note: 'forge-gate-hook blocked this command (exit 2); resolve with owner_override or decision_logged carrying the same gate',
    };
    const append = typeof opts.append === 'function' ? opts.append : appendRunEvent;
    const res = append(root, act.run.run_id, 'gate_blocked', fields, { timeoutMs: budget });
    return { recorded: !!(res && res.ok), run_id: act.run.run_id, gate: gates[0], reason: res && res.ok ? null : ((res && res.reason) || 'append failed') };
  } catch (e) {
    return { recorded: false, reason: 'internal: ' + short(e) };
  }
}

/** resolveRoot(opts) — opts.projectRoot, else CLAUDE_PROJECT_DIR (Claude Code sets it for hooks), else the project
 *  this file lives in. */
function resolveRoot(opts) {
  if (opts && opts.projectRoot) return path.resolve(opts.projectRoot);
  const env = (opts && opts.env) || process.env;
  if (env.CLAUDE_PROJECT_DIR) return path.resolve(env.CLAUDE_PROJECT_DIR);
  return DEFAULT_ROOT;
}

// ---- owner repeats (WP-SCRIBE-REPEAT) ----
const REPEAT_LINE_MAX_CHARS = 360;
/** repeatObligationLine(root, opts) -> {line, count} | null. ONE short line naming the owner repeats (scribe items with
 *  repeat_of) whose chain has no HARD RULE link yet (forge-scribe-store.cjs unaddressedRepeats). Run-independent, not
 *  blocking. Uses the project's own scribe store (else this file's sibling); no scribe ledger = null. Never throws.
 *  opts.scribeStore injects the store module (tests; null = absent). */
function repeatObligationLine(root, opts) {
  try {
    let S = opts && opts.scribeStore !== undefined ? opts.scribeStore : undefined;
    if (S === undefined) {
      S = null;
      for (const p of [path.join(root, '.claude', 'forge-bin', 'forge-scribe-store.cjs'), path.join(__dirname, 'forge-scribe-store.cjs')]) {
        try { if (fs.existsSync(p)) { S = require(p); break; } } catch { /* try the next copy */ }
      }
    }
    if (!S || typeof S.unaddressedRepeats !== 'function') return null;
    const p = S.paths(root);
    if (!fs.existsSync(p.ledger)) return null;
    const reps = S.unaddressedRepeats(S.loadState(p));
    if (!reps.length) return null;
    const top = reps[0];
    const others = reps.slice(1, 4).map((i) => i.rid + ' x' + (i.repeat_count || 2)).join(', ');
    const line = '[forge-scribe] ' + reps.length + ' owner repeat(s) without a HARD RULE: ' + top.rid + ' ' + S.repeatTag(top)
      + (others ? ' (also ' + others + (reps.length > 4 ? ', …' : '') + ')' : '')
      + ' — make it a HARD RULE, then: node .claude/forge-bin/forge-scribe.cjs transition ' + top.rid + ' repeat-rule --ref standing_rule:<id>|decision_logged:<event_id>';
    return { line: oneLine(line, REPEAT_LINE_MAX_CHARS), count: reps.length };
  } catch { return null; }
}

/** runStop(payload, opts) -> {print, text, reason, run_id, due_count, repeats, ms}. Never throws. */
function runStop(payload, opts) {
  opts = opts || {};
  const t0 = Date.now();
  let rep = null;
  const out = (o) => {
    const r = Object.assign({ print: false, text: null, reason: null, run_id: null, due_count: null }, o, { repeats: rep ? rep.count : 0 });
    if (rep) { r.print = true; r.text = (r.text ? r.text + '\n' : '') + rep.line; } // the repeat line is always ONE line, last
    r.ms = Date.now() - t0;
    return r;
  };
  try {
    const env = opts.env || process.env;
    if (isOff(env.FORGE_STOP_OBLIGATIONS)) return out({ reason: 'disabled (FORGE_STOP_OBLIGATIONS=off)' });
    if (payload && typeof payload === 'object' && payload.stop_hook_active === true) return out({ reason: 'stop_hook_active — already continuing because of a stop hook' });
    const root = resolveRoot(opts);
    rep = repeatObligationLine(root, opts);
    const act = findActiveRun(root, { now: opts.now });
    if (!act.run) return out({ reason: act.reason });
    const ob = obligationsFor(root, act.run.run_id, { mode: 'stop', runcontract: opts.runcontract });
    // an older checker without planFor (version skew in a synced project) is a tooling gap, not an obligation:
    // stay silent instead of repeating it at every stop; a plan that THROWS (e.g. a corrupt log) is surfaced
    if (!ob.ok && ob.unavailable) return out({ reason: ob.reason, run_id: act.run.run_id });
    if (!ob.ok) return out({ print: true, text: ob.text, reason: ob.reason, run_id: act.run.run_id });
    if (!ob.due_count) return out({ reason: 'nothing due', run_id: act.run.run_id, due_count: 0 });
    return out({ print: true, text: ob.text, run_id: act.run.run_id, due_count: ob.due_count });
  } catch (e) {
    return out({ reason: 'internal: ' + short(e) }); // advisory: an internal error prints nothing
  }
}

module.exports = {
  findActiveRun, obligationsFor, formatObligations, appendRunEvent, recordGateBlock, runStop, repeatObligationLine, readEventsLenient, openStateOf,
  loadRunContract, resolveRoot, capLines, oneLine,
  ACTIVE_MAX_AGE_MS, MAX_CANDIDATES, OBLIGATION_MAX_LINES, OBLIGATION_MAX_CHARS, STOP_DEADLINE_MS,
  APPEND_TIMEOUT_MS, APPEND_ENV_VAR, HOOK_EVENT_TYPES, RECORD_BUDGET_END_MS, RECORD_MAX_MS, RECORD_MIN_MS,
};

// ---- CLI (Stop hook target — ALWAYS exits 0, never blocks; prints {"systemMessage"} or nothing) ----
if (require.main === module) {
  let done = false;
  const finish = (text) => {
    if (done) return;
    done = true;
    if (text) { try { fs.writeSync(1, JSON.stringify({ systemMessage: text }) + '\n'); } catch { /* nothing left to report to */ } }
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
    // an unreadable payload cannot say whether stop_hook_active is set: print nothing (advisory, fail-open)
    if (!payload || typeof payload !== 'object') { finish(null); return; }
    const r = runStop(payload, {});
    finish(r.print ? r.text : null);
  });
  process.stdin.resume();
}
