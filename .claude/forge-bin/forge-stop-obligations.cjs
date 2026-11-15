#!/usr/bin/env node
'use strict';
/**
 * forge-stop-obligations.cjs — (2026-10-10; audit
 * enforcement-core T3/T8/T10 + P1 "call sites"). Two jobs in one zero-dependency file:
 *
 *  1. The project STOP HOOK (registered in .claude/settings.json through forge-settings-merge.cjs). When Claude
 *     stops while a Forge run is active, it prints that run's outstanding obligations — the ones
 *     `forge-runcontract.cjs plan` marks overdue or due now — as a short ADVISORY message for the owner
 *     (`{"systemMessage": ...}` on stdout, exit 0). It never blocks a stop (three exceptions: I.7, I.8 and I.9 below), honours `stop_hook_active` (prints
 *     nothing while Claude is already continuing because of a stop hook), and prints NOTHING when there is no
 *     active run or nothing is due. Budget: under 1 s (a failsafe timer exits silently at STOP_DEADLINE_MS).
 *     WP-SCRIBE-REPEAT: independent of a run, it also adds ONE line naming owner repeats (scribe items
 *     with repeat_of) whose chain has no HARD RULE link yet (`forge-scribe.cjs transition R-n repeat-rule --ref
 *     standing_rule:<id>|decision_logged:<event_id>`). Advisory like the rest; it never blocks.
 *     Honest limit: a Stop-hook systemMessage is shown to the OWNER; Claude itself does not read it. The model
 *     sees the same obligations through the compaction re-inject (forge-snapshot-reinject.cjs) and through
 *     `node .claude/forge-bin/forge-runcontract.cjs plan --run <id>`.
 *     I.7 RUN-REQUIRED (the ONE blocking part): when THIS session (payload session_id) has
 *     >= NORUN_MIN_SUBAGENTS finished subagents in <runs>/_hooks/subagent-stop.jsonl (forge-subagent-stop.cjs) and no
 *     genuine run was started or updated inside the session window, the stop is BLOCKED once per session
 *     (`{"decision":"block","reason":...}`, Claude reads the reason) with the exact commands to mint the mission
 *     ledger. See the "I.7 run-required" section below for the window, the exclusions and the honest limits.
 *     I.8 OPEN-SUBAGENTS (category finding H1, the second blocking part): when THIS session has subagents
 *     that STARTED (<runs>/_hooks/subagent-start.jsonl, forge-subagent-start.cjs, within the last 2 hours) and never
 *     STOPPED (no subagent-stop.jsonl line with the same agent_id), the stop is BLOCKED with the NL + EN reason and the
 *     exact wait command (node .claude/forge-bin/forge-wait.cjs --session <id>): a headless session that ends its turn
 *     gets them killed. It also blocks under stop_hook_active, bounded by OPEN_SUB_MAX_BLOCKS (6) blocks per session;
 *     after that it is advisory only. See the "I.8 open-subagents" section for the honest limits.
 *     I.9 RED-CONTRACT (R8B-F3, the third blocking part): only in a /forge build session (marker
 *     <runs>/_hooks/forge-session/<sha256(session_id)[:16]>.json, written by forge-scribe-hook.cjs; absent = do nothing), the
 *     stop is BLOCKED when the session's run is open with a contract NOT DONE, was failure-closed in this session over a
 *     Lead-doable rule without a named blocker, or when the Lead wrote app files itself and there is no run. The reason (what
 *     the model reads, unlike the advisory systemMessage) lists the open rules and the first exact command (NEXT:
 *     forge-runcontract.cjs plan --run <id> plus the first due item). Also under stop_hook_active, at most RED_MAX_BLOCKS (3)
 *     blocks per session, then advisory only. See the "I.9 red-contract" section for the honest limits.
 *
 *  2. The SHARED HELPERS the three hook call sites use, so they agree on one definition:
 *       findActiveRun(root)       — "the active run": the most recently appended run (events.jsonl mtime) among
 *                                   the newest MAX_CANDIDATES within ACTIVE_MAX_AGE_MS, that has a run_started
 *                                   event (or a run.json), is not finalized (no run-finalized.json) and is not
 *                                   closed (its last non-audit event is not run_completed). Doctor-receipt-only
 *                                   folders never qualify. Never throws. The gate record and the Stop advisory
 *                                   first use the session's own active-run pointer (sessionActiveRun).
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
 * env FORGE_RUN_REQUIRED_STOP=off silences only the I.7 run-required block;
 * env FORGE_OPEN_SUBAGENTS_STOP=off silences only the I.8 open-subagents block;
 * env FORGE_RED_CONTRACT_STOP=off silences only the I.9 red-contract block;
 * env FORGE_GATE_RUN_EVENT=off stops the gate hook's gate_blocked record (its verdict is unaffected either way).
 * (A forge-config key would be the beginner-friendly switch; FORGE_CONFIG_SCHEMA.json is outside this work
 * package, so that is a recorded follow-up, not a silent gap.)
 *
 * MODEL: findActiveRun · obligationsFor · formatObligations · appendRunEvent · evaluateRunRequired · evaluateRedContract ·
 * runStop(payload, opts) -> {print, text, block, block_text, norun, open_subagents, red_contract, reason, run_id, due_count, ms}. CLI: stdin (the Stop hook JSON) ->
 * runStop -> stdout JSON ({"systemMessage"} and/or {"decision":"block","reason"}) or nothing -> exit 0, always.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// WP 2.1: forge-paths.cjs is optional (guarded): without it (a copied hook, an older install) the default root is the
// project this file lives in and the runs folder is .claude/forge-runs, exactly as before. With it a plugin copy
// finds the project from CLAUDE_PROJECT_DIR / the cwd (never its own folder; none found -> null, the hook stays
// silent), and the active run is looked up in the ACTIVE runs folder (.forge/runs once <root>/.forge/ exists).
let forgePaths = null;
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.stateDir === 'function' && typeof fp.scriptRoot === 'function') forgePaths = fp; } catch { forgePaths = null; }
function defaultRoot() {
  if (!forgePaths) return path.resolve(__dirname, '..', '..'); // forge-paths fallback
  try { return forgePaths.scriptRoot(__dirname); } catch { return null; }
}
function runsDirOf(root) {
  const legacy = path.join(root, '.claude', 'forge-runs');
  if (!forgePaths) return legacy;
  try { return forgePaths.stateDir(root, 'runs'); } catch { return legacy; }
}
const DEFAULT_ROOT = defaultRoot();
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
    const runsDir = runsDirOf(root);
    let dirents;
    try { dirents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return { run: null, reason: 'no ' + path.relative(path.resolve(root), runsDir).split(path.sep).join('/') + ' folder', skipped }; }
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

/** sessionActiveRun(root, sessionId, opts) -> the findActiveRun() shape for THIS session. FB-CONTRACT-1-F5 (audit
 *  with two sessions in one project, "the newest open run" is often the other session's run. The session's
 *  own active-run pointer (forge-active-run.cjs) decides first; a pointer to a finalized or closed run means this session
 *  has no open run. Only without a pointer does the project-wide findActiveRun() decide. Never throws. */
function sessionActiveRun(root, sessionId, opts) {
  try {
    const A = typeof sessionId === 'string' && sessionId ? siblingModule(root, 'forge-active-run.cjs') : null;
    const p = A && typeof A.readActiveRun === 'function' ? A.readActiveRun(root, sessionId, { now: opts && opts.now }) : null;
    const id = p && typeof p.run === 'string' && RUN_ID_RE.test(p.run) ? p.run : null;
    if (id) {
      const runDir = path.join(runsDirOf(root), id);
      if (fs.existsSync(path.join(runDir, 'run-finalized.json'))) return { run: null, reason: 'this session\'s run ' + id + ' is finalized', skipped: [] };
      if (fs.statSync(path.join(runDir, 'events.jsonl')).size > MAX_EVENTS_BYTES) return { run: null, reason: 'this session\'s run ' + id + ': events log too large to read in a hook', skipped: [] };
      const { events } = readEventsLenient(path.join(runDir, 'events.jsonl'));
      const st = openStateOf(events);
      if (st.closed) return { run: null, reason: 'this session\'s run ' + id + ' is closed (run_completed)', skipped: [] };
      if (events.length) return { run: { run_id: id, runDir, events: events.length, last_event_at: st.lastEventMs === null ? null : new Date(st.lastEventMs).toISOString() }, reason: null, skipped: [] };
    }
  } catch { /* an unreadable pointer falls back to the project-wide lookup below */ }
  return findActiveRun(root, opts);
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
 *  {ok:false} plus one honest line naming the command to run by hand). opts.mode 'stop'|'reinject'; opts.plan reuses a
 *  planFor() result for the same run (the Stop hook's I.9 already computed it). */
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
    let plan = opts.plan && opts.plan.run_id === runId ? opts.plan : null; // I.9 already computed it for this run
    if (!plan) { try { plan = rc.planFor({ run_id: runId }, { root }); } catch (e) { return fail(short(e)); } }
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
    if (!root) return { recorded: false, reason: 'no project root (a plugin copy outside any project)' };
    const act = sessionActiveRun(root, payload.session_id, { now: opts.now });
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
/** siblingModule(root, name) -> the project's own copy (<root>/.claude/forge-bin/<name>), else this file's sibling, else
 *  null. Each candidate in its own try/catch: a broken copy never breaks the Stop hook. */
function siblingModule(root, name) {
  for (const p of [path.join(root, '.claude', 'forge-bin', name), path.join(__dirname, name)]) {
    try { if (fs.existsSync(p)) return require(p); } catch { /* try the next copy */ }
  }
  return null;
}
function repeatObligationLine(root, opts) {
  try {
    let S = opts && opts.scribeStore !== undefined ? opts.scribeStore : undefined;
    const injectedStore = S !== undefined;
    if (S === undefined) S = siblingModule(root, 'forge-scribe-store.cjs');
    if (!S || typeof S.unaddressedRepeats !== 'function') return null;
    const p = S.paths(root);
    if (!fs.existsSync(p.ledger)) return null;
    // OWNER VIEW (WP 3.8 follow-up): stored repeat_of links are re-judged by forge-scribe.cjs ownerView with the scribe
    // config before counting, exactly like the digest and `list` — a stale (hand-back) link no longer creates a false
    // REPEAT line, and no longer joins a genuine repeat to an already-addressed chain where it would be hidden. Seams:
    // opts.scribe / opts.classify inject the two modules; with an injected store and neither injected, the raw links
    // are used (that test seam judges the store's own items). Missing or broken modules -> the raw links (fail-open).
    let SC = opts && opts.scribe !== undefined ? opts.scribe : undefined;
    let C = opts && opts.classify !== undefined ? opts.classify : undefined;
    const viewSeam = SC !== undefined || C !== undefined;
    if (!injectedStore || viewSeam) {
      if (SC === undefined) SC = siblingModule(root, 'forge-scribe.cjs');
      if (C === undefined) C = siblingModule(root, 'forge-scribe-classify.cjs');
    }
    const st = S.loadState(p);
    let view = st;
    if (SC && typeof SC.ownerView === 'function' && C && typeof C.loadConfig === 'function') {
      try { view = SC.ownerView(st, C.loadConfig()); } catch { view = st; }
    }
    const reps = S.unaddressedRepeats(view);
    if (!reps.length) return null;
    const top = reps[0];
    const others = reps.slice(1, 4).map((i) => i.rid + ' x' + (i.repeat_count || 2)).join(', ');
    const line = '[forge-scribe] ' + reps.length + ' owner repeat(s) without a HARD RULE: ' + top.rid + ' ' + S.repeatTag(top)
      + (others ? ' (also ' + others + (reps.length > 4 ? ', …' : '') + ')' : '')
      + ' — make it a HARD RULE, then: node .claude/forge-bin/forge-scribe.cjs transition ' + top.rid + ' repeat-rule --ref standing_rule:<id>|decision_logged:<event_id>';
    return { line: oneLine(line, REPEAT_LINE_MAX_CHARS), count: reps.length };
  } catch { return null; }
}

// ---- I.7 run-required a multi-agent session that never started or updated a mission run ----
// Own mistake 2026-10-24: a 14-hour mission ran dozens of subagents without a run id although CLAUDE.md "Mission
// ledger" requires one; the rule was prose only. Evidence is the HARNESS-written SubagentStop log (never a claim):
// THIS session's lines in <runs>/_hooks/subagent-stop(.1).jsonl. Fires when >= NORUN_MIN_SUBAGENTS distinct agent_ids
// finished (pure research types excluded) and no genuine run (run_started or run.json; doctor receipts never count) has
// an event inside the session window, nor is FORGE_RUN_ID (or a stop line's `run`) an existing run folder. Window start
// = the session's earliest known moment (first subagent stop, or the first line of its own _toollog file when earlier)
// minus NORUN_LOOKBACK_MS, so a run minted BEFORE the work (the rule itself) counts. Reads only those logs and run
// event logs: never the payload's transcript, never prompt or message text. Fail-open: any error -> no block.
const NORUN_MIN_SUBAGENTS = 3;
const NORUN_EXCLUDED_TYPES = new Set(['Explore', 'Plan', 'claude-code-guide']); // pure read-only research agent types
const NORUN_LOOKBACK_MS = 60 * 60 * 1000;
const NORUN_CLOCK_SKEW_MS = 5 * 60 * 1000;      // mtime pre-filter slack for the run folders
const NORUN_MAX_LOG_BYTES = 4 * 1024 * 1024;    // per hook-log generation (the writer rotates at 1 MB)
const NORUN_MAX_RUN_DIRS = 16;                  // newest run folders changed inside the window that are read
const NORUN_HEAD_BYTES = 4096;
const NORUN_STATE_DIR = 'run-required-stop';    // <active runs>/_hooks/run-required-stop/<sha256(session)[:24]>.json
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/; // = forge-toolhook SESSION_RE (the writer's session bucket)

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function runName(r) { return typeof r === 'string' && RUN_ID_RE.test(r) && r[0] !== '_' ? r : null; }
function sessionHash(sid) { return crypto.createHash('sha256').update(sid, 'utf8').digest('hex').slice(0, 24); }
function isForgeProjectDir(root) {
  if (isDir(path.join(root, '.claude', 'forge-bin'))) return true;
  if (forgePaths && typeof forgePaths.layout === 'function') { try { return forgePaths.layout(root) === 'forge'; } catch { return false; } }
  return isDir(path.join(root, '.forge'));
}
/** runsDirsOf(root) -> the runs folders that exist, active first (both layouts during a partial migration). */
function runsDirsOf(root) {
  if (forgePaths && typeof forgePaths.existingStateDirs === 'function') { try { return forgePaths.existingStateDirs(root, 'runs'); } catch { /* active only */ } }
  const d = runsDirOf(root);
  return isDir(d) ? [d] : [];
}
function headLine(file) {
  let fd = null;
  try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(NORUN_HEAD_BYTES); const n = fs.readSync(fd, b, 0, b.length, 0); return b.toString('utf8', 0, n).replace(/^\uFEFF/, '').split(/\r?\n/)[0]; }
  catch { return ''; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
}
/** sessionStops(dirs, sid) -> [{ms, id, type, run}] — this session's SubagentStop lines (both generations). */
function sessionStops(dirs, sid) {
  const out = [];
  for (const d of dirs) for (const n of ['subagent-stop.1.jsonl', 'subagent-stop.jsonl']) {
    let raw;
    try { const f = path.join(d, '_hooks', n); if (fs.statSync(f).size > NORUN_MAX_LOG_BYTES) continue; raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.includes(sid)) continue;
      let r; try { r = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { continue; }
      const ms = r && r.session === sid && typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      if (Number.isFinite(ms)) out.push({ ms, id: typeof r.agent_id === 'string' && r.agent_id ? r.agent_id : null, type: typeof r.agent_type === 'string' ? r.agent_type : null, run: runName(r.run) });
    }
  }
  return out;
}
/** toolLogStartMs(dirs, sid) -> ts of the first line of the session's own tool log (forge-toolhook), or null. */
function toolLogStartMs(dirs, sid) {
  let min = null;
  for (const d of dirs) for (const n of [sid + '.1.jsonl', sid + '.jsonl']) {
    let ms = NaN;
    try { const r = JSON.parse(headLine(path.join(d, '_toollog', n))); ms = r && r.session === sid ? Date.parse(r.ts) : NaN; } catch { ms = NaN; }
    if (Number.isFinite(ms) && (min === null || ms < min)) min = ms;
  }
  return min;
}
/** runTouchedSince(dirs, sinceMs) -> {covered, run_id, reason}. Only folders whose events.jsonl changed inside the window
 *  are read; a log too large to read in a hook counts as covered (fail-open). */
function runTouchedSince(dirs, sinceMs) {
  const cands = [];
  for (const d of dirs) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || !runName(e.name)) continue;
      let st; try { st = fs.statSync(path.join(d, e.name, 'events.jsonl')); } catch { continue; }
      if (st.isFile() && st.mtimeMs >= sinceMs - NORUN_CLOCK_SKEW_MS) cands.push({ dir: path.join(d, e.name), name: e.name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of cands.slice(0, NORUN_MAX_RUN_DIRS)) {
    if (c.size > MAX_EVENTS_BYTES) return { covered: true, run_id: c.name, reason: 'run log ' + c.name + ' changed in this session (too large to read in a hook)' };
    const evs = readEventsLenient(path.join(c.dir, 'events.jsonl')).events;
    const st = openStateOf(evs);
    if (!st.genuine && !hasRunJson(c.dir)) continue;
    // FB-CONTRACT-1-F5: a hook-written event (gate_blocked, session_resumed) is not the session updating the run
    const work = evs.filter((e) => !HOOK_EVENT_TYPES.has(e.event_type));
    if (!work.length) continue;
    const lastWork = openStateOf(work).lastEventMs;
    if ((lastWork === null ? c.mtimeMs : lastWork) >= sinceMs) return { covered: true, run_id: c.name, reason: 'run ' + c.name + ' was started or updated in this session' };
  }
  return { covered: false, run_id: null, reason: null };
}
/** evaluateRunRequired(payload, root, opts) -> {fire, reason, subagents, run_id, first_stop_at?, window_start?}. READ-ONLY
 *  (writes nothing; the replay and the doctor may call it on a real project). opts.env. Never throws. */
function evaluateRunRequired(payload, root, opts) {
  const res = (o) => Object.assign({ fire: false, reason: null, subagents: 0, run_id: null }, o);
  try {
    const env = (opts && opts.env) || process.env;
    if (isOff(env.FORGE_RUN_REQUIRED_STOP)) return res({ reason: 'disabled (FORGE_RUN_REQUIRED_STOP=off)' });
    const sid = payload && typeof payload === 'object' && typeof payload.session_id === 'string' ? payload.session_id : '';
    if (!SESSION_RE.test(sid) || sid === 'unknown-session') return res({ reason: 'no usable session_id' });
    if (!root || !isForgeProjectDir(root)) return res({ reason: 'not a Forge project (no .claude/forge-bin, no .forge)' });
    const dirs = runsDirsOf(root);
    if (dirs.some((d) => fs.existsSync(path.join(d, '_hooks', NORUN_STATE_DIR, sessionHash(sid) + '.json')))) return res({ reason: 'already reminded once in this session' });
    const stops = sessionStops(dirs, sid);
    const ids = new Set(stops.filter((s) => s.id && !NORUN_EXCLUDED_TYPES.has(s.type)).map((s) => s.id));
    if (ids.size < NORUN_MIN_SUBAGENTS) return res({ reason: ids.size + ' counted subagent(s) in this session (threshold ' + NORUN_MIN_SUBAGENTS + ')', subagents: ids.size }); // NORUN-THRESHOLD
    for (const r of [runName(String(env.FORGE_RUN_ID || ''))].concat(stops.map((s) => s.run))) {
      if (r && dirs.some((d) => isDir(path.join(d, r)))) return res({ reason: 'run ' + r + ' is set for this session', subagents: ids.size, run_id: r });
    }
    const firstStop = stops.reduce((m, s) => Math.min(m, s.ms), Infinity);
    const tl = toolLogStartMs(dirs, sid);
    const since = Math.min(firstStop, tl === null ? firstStop : tl) - NORUN_LOOKBACK_MS;
    const t = runTouchedSince(dirs, since);
    if (t.covered) return res({ reason: t.reason, subagents: ids.size, run_id: t.run_id });
    return res({ fire: true, reason: ids.size + ' subagents finished, no run started or updated in this session', subagents: ids.size, first_stop_at: new Date(firstStop).toISOString(), window_start: new Date(since).toISOString() });
  } catch (e) {
    return res({ reason: 'internal: ' + short(e) });
  }
}
/** runRequiredMessage(n, nowMs) -> the block text (NL + EN, exact next commands). */
function runRequiredMessage(n, nowMs) {
  const day = new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString().slice(0, 10);
  const le = 'node .claude/forge-dashboard/log-event.cjs <run_id> ';
  return [
    '[forge] No mission run / geen missie-run: ' + n + ' subagents finished in this session, but no Forge run was started or updated during it.',
    'EN: the Mission ledger rule (CLAUDE.md) says tasks exist BEFORE the work, and completion is proven only by the finalize receipt (run-finalized.json). Do this now, then carry on:',
    'NL: de Mission-ledger-regel (CLAUDE.md) zegt: taken bestaan VOOR het werk, en klaar is pas bewezen met het finalize-bewijs (run-finalized.json). Doe dit nu en ga daarna verder:',
    '  1. ' + le + 'run_started \'{"agent":"lead","task":"<mission in one line>"}\'   # Git Bash; PowerShell 5.1 drops the quotes: put the JSON in a file and pass --file <payload.json>',
    '  2. one per lane / een per lane: ' + le + 'agent_work_package_created \'{"agent":"<boss>","wp_id":"WP-1","task":"<lane>"}\'   # PowerShell: --file <payload.json>',
    '  3. node .claude/forge-bin/forge-runcontract.cjs plan --run <run_id>   (follow its sequence; it ends with check --finalize)',
    'Work already done / werk dat al klaar is: log it honestly with "retro":true in the JSON; log-event stamps the real time, so never back-date / nooit terugdateren.',
    '<run_id> e.g. forge-' + day + '-<short-name>. This fires once per session; opt-out: FORGE_RUN_REQUIRED_STOP=off.',
  ].join('\n');
}
/** runRequiredStop(payload, root, opts) -> {block, text, reason, subagents}. The once-per-session marker is written
 *  BEFORE blocking (exclusive create); when it cannot be written there is no block ("once" cannot be promised). */
function runRequiredStop(payload, root, opts) {
  opts = opts || {};
  const ev = evaluateRunRequired(payload, root, opts);
  if (!ev.fire) return { block: false, text: null, reason: ev.reason, subagents: ev.subagents };
  const no = (why) => ({ block: false, text: null, reason: why, subagents: ev.subagents });
  const dir = path.join(runsDirOf(root), '_hooks', NORUN_STATE_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return no('once-marker not written (' + short(e) + ') — not blocking'); }
  try {
    fs.writeFileSync(path.join(dir, sessionHash(payload.session_id) + '.json'), JSON.stringify({ ts: new Date(typeof opts.now === 'number' ? opts.now : Date.now()).toISOString(), subagents: ev.subagents }) + '\n', { flag: 'wx' }); // NORUN-ONESHOT
  } catch (e) {
    return no(e && e.code === 'EEXIST' ? 'already reminded once in this session' : 'once-marker not written (' + short(e) + ') — not blocking');
  }
  return { block: true, text: runRequiredMessage(ev.subagents, opts.now), reason: ev.reason, subagents: ev.subagents };
}
// ---- end I.7 run-required ----

// ---- I.8 open-subagents (category finding H1): the turn ends while this session's subagents still run ----
// A headless `claude -p` Lead launched a background Workflow and ended its turn; Claude Code exited ~10 minutes later and
// killed the running subagent ("[Request interrupted by user for tool use]"), the run stayed NOT DONE. Evidence is the
// HARNESS-written pair <runs>/_hooks/subagent-start.jsonl / subagent-stop.jsonl: a start line of THIS session (within
// forge-wait.cjs OPEN_MAX_AGE_MS = 2 h) with no stop line of the same agent_id. Unlike I.7 it ALSO blocks under
// stop_hook_active (a forge-wait that timed out at --max-sec must not end the turn), so it is bounded by its own cap:
// at most OPEN_SUB_MAX_BLOCKS blocks per session (counter under <runs>/_hooks/open-subagents-stop/), written BEFORE
// blocking; after the cap, or when the counter cannot be written, it is advisory only (systemMessage). It acts only in a
// headless session (CLAUDE_CODE_ENTRYPOINT starting with "sdk", e.g. sdk-cli for `claude -p`; FORGE_OPEN_SUBAGENTS_STOP=on
// forces it). Honest limit: a subagent whose SubagentStop hook never ran looks open for 2 hours. Fail-open.
const OPEN_SUB_MAX_BLOCKS = 6;
const OPEN_SUB_STATE_DIR = 'open-subagents-stop'; // <active runs>/_hooks/open-subagents-stop/<sha256(session)[:24]>.json
function waitCommand(sid) { return 'node .claude/forge-bin/forge-wait.cjs --session ' + sid; }
/** evaluateOpenSubagents(payload, root, opts) -> {open, count, types, reason}. READ-ONLY. Never throws. */
function evaluateOpenSubagents(payload, root, opts) {
  const res = (o) => Object.assign({ open: false, count: 0, types: '', reason: null }, o);
  try {
    const env = (opts && opts.env) || process.env;
    if (isOff(env.FORGE_OPEN_SUBAGENTS_STOP)) return res({ reason: 'disabled (FORGE_OPEN_SUBAGENTS_STOP=off)' });
    // Only headless sessions lose their subagents when the turn ends. Measured 2026-11-07: `claude -p` runs with
    // CLAUDE_CODE_ENTRYPOINT=sdk-cli, an interactive session with "cli" (it waits for background work by itself).
    // FORGE_OPEN_SUBAGENTS_STOP=on forces the block in any session.
    const entry = String(env.CLAUDE_CODE_ENTRYPOINT || '');
    if (!/^sdk/i.test(entry) && String(env.FORGE_OPEN_SUBAGENTS_STOP || '').toLowerCase() !== 'on') return res({ reason: 'not a headless session (CLAUDE_CODE_ENTRYPOINT=' + (entry || 'unset') + ')' });
    const sid = payload && typeof payload === 'object' && typeof payload.session_id === 'string' ? payload.session_id : '';
    if (!SESSION_RE.test(sid) || sid === 'unknown-session') return res({ reason: 'no usable session_id' });
    if (!root || !isForgeProjectDir(root)) return res({ reason: 'not a Forge project' });
    const W = siblingModule(root, 'forge-wait.cjs');
    if (!W || typeof W.openAgents !== 'function') return res({ reason: 'forge-wait.cjs is not available' });
    const open = W.openAgents(runsDirsOf(root), { session: sid, now: opts && opts.now });
    if (!open.length) return res({ reason: 'no open subagents in this session' });
    return res({ open: true, count: open.length, types: oneLine(W.typesOf(open), 160), reason: open.length + ' open subagent(s)' });
  } catch (e) { return res({ reason: 'internal: ' + short(e) }); }
}
function openSubagentsMessage(ev, sid, capped) {
  return [
    '[forge] ' + ev.count + ' subagent(s) still running / nog bezig in this session: ' + ev.types + '.',
    'EN: a headless session (claude -p) that ends its turn now gets them killed and the run stays NOT DONE. Wait in the foreground first:',
    'NL: een headless sessie (claude -p) die nu de beurt beeindigt, laat ze afbreken en de run blijft NIET KLAAR. Wacht eerst in de voorgrond:',
    '  ' + waitCommand(sid) + '   (exit 0 = all done; exit 3 = still open after 540 s: run it again)',
    capped ? 'Advisory only: the ' + OPEN_SUB_MAX_BLOCKS + '-block cap for this session is reached. Opt-out: FORGE_OPEN_SUBAGENTS_STOP=off.'
      : 'Blocks at most ' + OPEN_SUB_MAX_BLOCKS + ' times per session; opt-out: FORGE_OPEN_SUBAGENTS_STOP=off.',
  ].join('\n');
}
/** openSubagentsStop(payload, root, opts) -> {block, text, advisory, reason, count}. The per-session counter is written
 *  BEFORE blocking; when it cannot be written the result is advisory only (the cap could not be promised). */
function openSubagentsStop(payload, root, opts) {
  opts = opts || {};
  const ev = evaluateOpenSubagents(payload, root, opts);
  const base = { block: false, text: null, advisory: null, reason: ev.reason, count: ev.count };
  if (!ev.open) return base;
  const sid = payload.session_id;
  const advise = (why) => Object.assign(base, { advisory: openSubagentsMessage(ev, sid, true), reason: why });
  const dir = path.join(runsDirOf(root), '_hooks', OPEN_SUB_STATE_DIR);
  const file = path.join(dir, sessionHash(sid) + '.json');
  let blocks = 0;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); blocks = Number.isInteger(j && j.blocks) && j.blocks > 0 ? j.blocks : 0; } catch { blocks = 0; }
  if (blocks >= OPEN_SUB_MAX_BLOCKS) return advise('block cap reached (' + blocks + ')'); // OPENSUB-CAP
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ blocks: blocks + 1, ts: new Date(typeof opts.now === 'number' ? opts.now : Date.now()).toISOString(), open: ev.count }) + '\n');
  } catch (e) { return advise('block counter not written (' + short(e) + ') — not blocking'); }
  return Object.assign(base, { block: true, text: openSubagentsMessage(ev, sid, false), reason: ev.reason + ', block ' + (blocks + 1) + '/' + OPEN_SUB_MAX_BLOCKS });
}
// ---- end I.8 open-subagents ----

// ---- I.9 red-contract (R8B-F3): a /forge build session ends its turn over a red run contract ----
// Round 8b: Leads on the GOAT router model skipped the /forge procedure (no plan, no memory/prefs, no work packages); the
// android Lead wrote the app itself and closed its run "partial" over 9 red rules, and Forge only recorded and advised
// (an advisory systemMessage reaches the owner, never the model). I.9 acts only in a /forge build session: a marker
// <runs>/_hooks/forge-session/<sha256(session_id)[:16]>.json {kind:'forge-build', created_at} written by
// forge-scribe-hook.cjs; a missing or unparsable marker means "not a /forge build session" and I.9 does nothing. The
// session's run is the active-run pointer (forge-active-run.cjs) when that run was touched since the marker, else the
// newest genuine run touched since then. It BLOCKS (the reason is what the model reads) when (i) that run is open and its
// contract is NOT DONE, (ii) it was failure-closed in this session while a Lead-doable rule (forge-runcontract.cjs
// LEAD_DOABLE_RULES) is open and the close names no blocker, or (iii) the Lead itself (tool-log agent_id null) wrote app
// files (outside .claude/, .forge/, _scratch/) and there is no run. (i) waits while a subagent of this session still runs
// (an interactive Lead may end its turn then; I.8 owns waiting in a headless one). Like I.8 it also blocks under stop_hook_active, bounded
// by RED_MAX_BLOCKS blocks per session (counter written BEFORE blocking; after the cap, or when it cannot be written, it is
// advisory only). Honest limits: the checker's plan must finish inside the settings.json Stop hook timeout (STOP_DEADLINE_MS
// only bounds the stdin read; a hook killed by that timeout blocks nothing: fail-open); the session window starts at the
// marker's created_at; two /forge sessions in one project share the fallback run pointer (session null), so I.9 can name
// the other session's run (still capped at RED_MAX_BLOCKS). Fail-open on every error.
const RED_MAX_BLOCKS = 3;
const RED_STATE_DIR = 'red-contract-stop';        // <active runs>/_hooks/red-contract-stop/<sha256(session)[:24]>.json
const SESSION_MARKER_DIR = 'forge-session';        // <runs>/_hooks/forge-session/<sha256(session)[:16]>.json (read only)
const MARKER_MAX_BYTES = 4096;
const MARKER_SKEW_MS = 5 * 60 * 1000;              // clock slack before the marker's created_at
const LEAD_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const NOT_APP_PREFIXES = ['.claude/', '.forge/', '_scratch/'];
const LIST_MAX_CHARS = 300;

/** readSessionMarker(dirs, sid) -> {created_ms} | null: the /forge build-session marker, or null (absent, unparsable,
 *  another kind, another session's hash, no valid created_at). */
function readSessionMarker(dirs, sid) {
  const sha = crypto.createHash('sha256').update(sid, 'utf8').digest('hex').slice(0, 16);
  for (const d of dirs) {
    const f = path.join(d, '_hooks', SESSION_MARKER_DIR, sha + '.json');
    let j;
    try { if (fs.statSync(f).size > MARKER_MAX_BYTES) continue; j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j) || j.kind !== 'forge-build') continue;
    if (j.session_sha !== undefined && j.session_sha !== sha) continue;
    const ms = typeof j.created_at === 'string' ? Date.parse(j.created_at) : NaN;
    if (Number.isFinite(ms)) return { created_ms: ms };
  }
  return null;
}
/** appTarget(t) -> the project-relative path of an app file, or null (absolute = outside the project, or a Forge/scratch path). */
function appTarget(t) {
  if (typeof t !== 'string' || !t || path.isAbsolute(t) || /^[A-Za-z]:/.test(t)) return null;
  const rel = t.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!rel || rel === '.' || rel.startsWith('../')) return null;
  const low = rel.toLowerCase();
  return NOT_APP_PREFIXES.some((p) => low === p.slice(0, -1) || low.startsWith(p)) ? null : rel;
}
/** leadAppWrites(dirs, sid, sinceMs) -> {count, sample}: Write/Edit calls by the Lead itself (agent_id null) on app files,
 *  from the session's own tool log (forge-toolhook <runs>/_toollog/<session>(.1).jsonl). */
function leadAppWrites(dirs, sid, sinceMs) {
  const sample = [];
  let count = 0;
  for (const d of dirs) for (const n of [sid + '.1.jsonl', sid + '.jsonl']) {
    let raw;
    try { const f = path.join(d, '_toollog', n); if (fs.statSync(f).size > NORUN_MAX_LOG_BYTES) continue; raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.includes('"path"')) continue;
      let r; try { r = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { continue; }
      if (!r || r.session !== sid || r.agent_id !== null || !LEAD_WRITE_TOOLS.has(r.tool) || r.target_kind !== 'path' || r.ok === false) continue;
      const ms = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      const rel = appTarget(r.target);
      if (!Number.isFinite(ms) || ms < sinceMs || !rel) continue;
      count++;
      if (sample.length < 3 && !sample.includes(rel)) sample.push(rel);
    }
  }
  return { count, sample };
}
/** runTouched(dir, sinceMs) — a genuine run (run_started or run.json) whose log changed at or after sinceMs. */
function runTouched(dir, sinceMs) {
  const f = path.join(dir, 'events.jsonl');
  let st; try { st = fs.statSync(f); } catch { return false; }
  if (!st.isFile() || st.mtimeMs < sinceMs - NORUN_CLOCK_SKEW_MS) return false;
  if (st.size > MAX_EVENTS_BYTES) return true;
  const s = openStateOf(readEventsLenient(f).events);
  return (s.genuine || hasRunJson(dir)) && (s.lastEventMs === null ? st.mtimeMs : s.lastEventMs) >= sinceMs;
}
/** sessionRunOf(root, dirs, sid, sinceMs, now) -> {run_id, dir} | null — the pointer's run when it was touched in this
 *  session, else the newest genuine run touched since sinceMs. */
function sessionRunOf(root, dirs, sid, sinceMs, now) {
  const A = siblingModule(root, 'forge-active-run.cjs');
  if (A && typeof A.readActiveRun === 'function') {
    const p = A.readActiveRun(root, sid, { now });
    const id = p && runName(p.run);
    if (id) for (const d of dirs) if (runTouched(path.join(d, id), sinceMs)) return { run_id: id, dir: path.join(d, id) };
  }
  const t = runTouchedSince(dirs, sinceMs);
  if (!t.covered || !t.run_id) return null;
  const d = dirs.find((x) => isDir(path.join(x, t.run_id)));
  return d ? { run_id: t.run_id, dir: path.join(d, t.run_id) } : null;
}
function lastRunCompleted(dir) {
  const evs = readEventsLenient(path.join(dir, 'events.jsonl')).events;
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].event_type === 'run_completed') return evs[i];
  return null;
}
function idList(ids) { return oneLine(ids.join(', '), LIST_MAX_CHARS); }
function firstDue(plan, ids) {
  const obs = Array.isArray(plan.obligations) ? plan.obligations : [];
  const o = obs.find((x) => x && (!ids || ids.includes(x.id)) && x.severity === 'block' && (x.due === 'overdue' || x.due === 'due-now'))
    || obs.find((x) => x && (!ids || ids.includes(x.id)));
  return o ? oneLine(o.id + ': ' + (o.how || o.reason || ''), 240) : (plan.next && plan.next.text ? oneLine(plan.next.text, 240) : null);
}
const BLOCKER_LINE = 'A failure close (status failed/partial) over Lead-doable rules is refused by log-event unless it carries a "blocker" field naming what the Lead cannot do itself (a hard gate, an owner-queue item, or a work package that failed after its one escalation).';
function openRedMessage(plan, doable) {
  const c = plan.contract || {};
  const missing = Array.isArray(c.missing) ? c.missing : [];
  const claimed = plan.state && plan.state.status === 'completed';
  const next = firstDue(plan, null);
  return [
    '[forge] Run ' + plan.run_id + (claimed ? ' claims completion but its' : ' is still open and its') + ' run contract is NOT DONE (' + missing.length + ' missing: ' + idList(missing) + '). Do not end the turn yet.',
    'EN: this is a /forge build session. Finish the procedure (memory, prefs, research, plan, skill map, work packages, verify, report) or close the run honestly.' + (doable.length ? ' The Lead can do these itself now: ' + idList(doable.map((x) => x.id)) + '.' : ''),
    'NL: dit is een /forge-bouwsessie. Maak de procedure af (geheugen, voorkeuren, onderzoek, plan, skill-map, werkpakketten, verificatie, rapport) of sluit de run eerlijk af.' + (doable.length ? ' Dit kan de Lead nu zelf: ' + idList(doable.map((x) => x.id)) + '.' : ''),
    'NEXT: ' + planCommand(plan.run_id),
  ].concat(next ? ['then: ' + next] : [], [BLOCKER_LINE]).join('\n');
}
function failureCloseMessage(plan, doable, close) {
  const word = ['status', 'outcome', 'verdict', 'result'].map((f) => close && typeof close[f] === 'string' ? close[f] : '').find(Boolean) || 'failed';
  const next = firstDue(plan, doable.map((x) => x.id));
  const c = plan.contract || {};
  const other = (Array.isArray(c.missing) ? c.missing : []).concat(Array.isArray(c.warnings) ? c.warnings : []).filter((id) => !doable.some((x) => x.id === id));
  return [
    '[forge] Run ' + plan.run_id + ' was closed as "' + oneLine(word, 40) + '" in this session while rules the Lead can do itself are still open: ' + idList(doable.map((x) => x.id)) + '.',
  ].concat(other.length ? ['(also open, not counted as Lead-doable: ' + idList(other) + ')'] : [], [
    'EN: a failure close is for a real blocker, not for skipped steps. Do these, log them (that reopens the run), then close again; or, when something the Lead cannot do itself really stopped the run, log a new run_completed with a "blocker" field that names it.',
    'NL: een faal-afsluiting is voor een echte blokkade, niet voor overgeslagen stappen. Doe deze, log ze (de run gaat dan weer open) en sluit opnieuw af; of log, als iets wat de Lead niet zelf kan de run echt stopte, een nieuwe run_completed met een "blocker"-veld dat het noemt.',
    'NEXT: ' + planCommand(plan.run_id),
  ], next ? ['then: ' + next] : []).join('\n');
}
function noRunMessage(w, sid, nowMs) {
  const day = new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString().slice(0, 10);
  return [
    '[forge] This /forge build session wrote ' + w.count + ' app file(s) with the Lead itself (e.g. ' + idList(w.sample) + '), but no Forge run was started or updated in it.',
    'EN: in a /forge build the run and its work packages exist BEFORE the work, and Bosses write the app. Mint the mission ledger now, then follow the plan:',
    'NL: in een /forge-build bestaan de run en de werkpakketten VOOR het werk, en schrijven de Bosses de app. Maak het missie-logboek nu aan en volg daarna het plan:',
    '  1. node .claude/forge-dashboard/log-event.cjs <run_id> run_started \'{"agent":"lead","task":"<mission in one line>"}\'   # Git Bash; PowerShell 5.1 drops the quotes: put the JSON in a file and pass --file <payload.json>',
    '  2. node .claude/forge-bin/forge-active-run.cjs set <run_id> --session ' + sid,
    'NEXT: node .claude/forge-bin/forge-runcontract.cjs plan --run <run_id>   (<run_id> e.g. forge-' + day + '-<short-name>; log work already done with "retro":true, never back-dated)',
  ].join('\n');
}
/** evaluateRedContract(payload, root, opts) -> {fire, kind:'open-red'|'failure-close'|'no-run'|null, run_id, text, reason,
 *  plan}. READ-ONLY. opts.env, opts.now, opts.runcontract (test seam, null = absent). Never throws. */
function evaluateRedContract(payload, root, opts) {
  opts = opts || {};
  const res = (o) => Object.assign({ fire: false, kind: null, run_id: null, text: null, reason: null, plan: null }, o);
  try {
    const env = opts.env || process.env;
    if (isOff(env.FORGE_RED_CONTRACT_STOP)) return res({ reason: 'disabled (FORGE_RED_CONTRACT_STOP=off)' });
    const sid = payload && typeof payload === 'object' && typeof payload.session_id === 'string' ? payload.session_id : '';
    if (!SESSION_RE.test(sid) || sid === 'unknown-session') return res({ reason: 'no usable session_id' });
    if (!root || !isForgeProjectDir(root)) return res({ reason: 'not a Forge project' });
    const dirs = runsDirsOf(root);
    const mk = readSessionMarker(dirs, sid);
    if (!mk) return res({ reason: 'no /forge session marker (not a /forge build session)' });
    const since = mk.created_ms - MARKER_SKEW_MS;
    const run = sessionRunOf(root, dirs, sid, since, opts.now);
    if (!run) {
      const w = leadAppWrites(dirs, sid, since);
      if (!w.count) return res({ reason: 'no run, and the Lead wrote no app files in this /forge session' });
      return res({ fire: true, kind: 'no-run', text: noRunMessage(w, sid, opts.now), reason: w.count + ' app file(s) written by the Lead, no run' });
    }
    const rc = loadRunContract(root, opts);
    if (!rc || typeof rc.planFor !== 'function') return res({ run_id: run.run_id, reason: 'forge-runcontract.cjs planFor is not available' });
    const plan = rc.planFor({ run_id: run.run_id }, { root });
    if (!plan || !plan.state || !plan.contract) return res({ run_id: run.run_id, reason: 'the plan has no state or contract' });
    const out = (o) => res(Object.assign({ run_id: run.run_id, plan }, o));
    if (plan.finalized && plan.finalized.completion_proof) return out({ reason: 'finalized' });
    const doable = typeof rc.leadDoableOf === 'function' ? rc.leadDoableOf(plan.contract) : [];
    if (plan.state.status === 'closed-failed') {
      if (typeof rc.leadDoableOf !== 'function' || typeof rc.failureCloseBlocker !== 'function') return out({ reason: 'closed as failed; this checker has no leadDoableOf/failureCloseBlocker' });
      const close = lastRunCompleted(run.dir);
      const closeMs = close ? Date.parse(close.ingested_at || close.timestamp) : NaN;
      if (!Number.isFinite(closeMs) || closeMs < since) return out({ reason: 'closed as failed before this /forge session' });
      if (rc.failureCloseBlocker(close)) return out({ reason: 'the failure close names a blocker' });
      if (!doable.length) return out({ reason: 'the failure close leaves no Lead-doable rule open' });
      return out({ fire: true, kind: 'failure-close', text: failureCloseMessage(plan, doable, close), reason: 'failure close over ' + doable.length + ' Lead-doable rule(s)' });
    }
    if (plan.contract.ok === true) return out({ reason: 'contract OK' });
    // an interactive Lead may end its turn while its background subagents work (the harness wakes it); I.8 owns waiting
    const W = siblingModule(root, 'forge-wait.cjs');
    const running = W && typeof W.openAgents === 'function' ? W.openAgents(dirs, { session: sid, now: opts.now }) : [];
    if (running.length) return out({ reason: running.length + ' subagent(s) of this session still running — the run is in progress' });
    return out({ fire: true, kind: 'open-red', text: openRedMessage(plan, doable), reason: 'run open, contract NOT DONE' });
  } catch (e) { return res({ reason: 'internal: ' + short(e) }); }
}
/** redContractStop(payload, root, opts) -> {block, text, advisory, reason, kind, run_id, plan}. The per-session counter is
 *  written BEFORE blocking; at the cap, or when it cannot be written, the result is advisory only. */
function redContractStop(payload, root, opts) {
  opts = opts || {};
  const ev = evaluateRedContract(payload, root, opts);
  const base = { block: false, text: null, advisory: null, reason: ev.reason, kind: ev.kind, run_id: ev.run_id, plan: ev.plan };
  if (!ev.fire) return base;
  const advise = (why) => Object.assign(base, { advisory: ev.text + '\nAdvisory only: the ' + RED_MAX_BLOCKS + '-block cap for this session is reached. Opt-out: FORGE_RED_CONTRACT_STOP=off.', reason: why });
  const dir = path.join(runsDirOf(root), '_hooks', RED_STATE_DIR);
  const file = path.join(dir, sessionHash(payload.session_id) + '.json');
  let blocks = 0;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); blocks = Number.isInteger(j && j.blocks) && j.blocks > 0 ? j.blocks : 0; } catch { blocks = 0; }
  if (blocks >= RED_MAX_BLOCKS) return advise('block cap reached (' + blocks + ')'); // REDCONTRACT-CAP
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ blocks: blocks + 1, ts: new Date(typeof opts.now === 'number' ? opts.now : Date.now()).toISOString(), kind: ev.kind, run: ev.run_id }) + '\n');
  } catch (e) { return advise('block counter not written (' + short(e) + ') — not blocking'); }
  return Object.assign(base, { block: true, text: ev.text + '\nBlocks at most ' + RED_MAX_BLOCKS + ' times per session (this is block ' + (blocks + 1) + '/' + RED_MAX_BLOCKS + '); opt-out: FORGE_RED_CONTRACT_STOP=off.', reason: ev.reason + ', block ' + (blocks + 1) + '/' + RED_MAX_BLOCKS });
}
// ---- end I.9 red-contract ----

/** runStop(payload, opts) -> {print, text, block, block_text, norun, open_subagents, red_contract, reason, run_id, due_count,
 *  repeats, ms}. Never throws. */
function runStop(payload, opts) {
  opts = opts || {};
  const t0 = Date.now();
  let rep = null, nr = null, os8 = null, r9 = null;
  const out = (o) => {
    const r = Object.assign({ print: false, text: null, reason: null, run_id: null, due_count: null }, o, { repeats: rep ? rep.count : 0 });
    if (os8 && os8.advisory) { r.print = true; r.text = (r.text ? r.text + '\n' : '') + os8.advisory; }
    if (r9 && r9.advisory) { r.print = true; r.text = (r.text ? r.text + '\n' : '') + r9.advisory; }
    if (rep) { r.print = true; r.text = (r.text ? r.text + '\n' : '') + rep.line; } // the repeat line is always ONE line, last
    // I.7 already asks to mint a run: its text covers I.9's no-run case on the same stop
    const blocks = [nr, os8, r9].filter((b) => b && b.block && !(b === r9 && r9.kind === 'no-run' && nr && nr.block));
    r.block = blocks.length > 0;
    r.block_text = r.block ? blocks.map((b) => b.text).join('\n\n') : null;
    r.norun = nr ? { reason: nr.reason, subagents: nr.subagents } : null;
    r.open_subagents = os8 ? { reason: os8.reason, count: os8.count, block: os8.block } : null;
    r.red_contract = r9 ? { reason: r9.reason, kind: r9.kind, run_id: r9.run_id, block: r9.block } : null;
    r.ms = Date.now() - t0;
    return r;
  };
  try {
    const env = opts.env || process.env;
    if (isOff(env.FORGE_STOP_OBLIGATIONS)) return out({ reason: 'disabled (FORGE_STOP_OBLIGATIONS=off)' });
    const root = resolveRoot(opts);
    if (!root) return out({ reason: 'no project root (a plugin copy outside any project)' });
    // I.8 runs BEFORE the stop_hook_active check on purpose (see its section): bounded by its own per-session cap
    os8 = openSubagentsStop(payload, root, { env, now: opts.now });
    // I.9 also runs BEFORE the stop_hook_active check, bounded by its own per-session cap (RED_MAX_BLOCKS)
    r9 = redContractStop(payload, root, { env, now: opts.now, runcontract: opts.runcontract });
    if (payload && typeof payload === 'object' && payload.stop_hook_active === true) return out({ reason: 'stop_hook_active — already continuing because of a stop hook' });
    nr = runRequiredStop(payload, root, { env, now: opts.now });
    rep = repeatObligationLine(root, opts);
    const act = sessionActiveRun(root, payload && typeof payload === 'object' ? payload.session_id : null, { now: opts.now });
    if (!act.run) return out({ reason: act.reason });
    if (r9.block && r9.run_id === act.run.run_id) return out({ reason: 'the I.9 block carries this run\'s obligations', run_id: act.run.run_id });
    const ob = obligationsFor(root, act.run.run_id, { mode: 'stop', runcontract: opts.runcontract, plan: r9.plan });
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
  evaluateRunRequired, runRequiredStop, runRequiredMessage, NORUN_MIN_SUBAGENTS, NORUN_EXCLUDED_TYPES, NORUN_LOOKBACK_MS, NORUN_STATE_DIR,
  evaluateOpenSubagents, openSubagentsStop, openSubagentsMessage, OPEN_SUB_MAX_BLOCKS, OPEN_SUB_STATE_DIR,
  evaluateRedContract, redContractStop, readSessionMarker, leadAppWrites, appTarget, RED_MAX_BLOCKS, RED_STATE_DIR, SESSION_MARKER_DIR,
  ACTIVE_MAX_AGE_MS, MAX_CANDIDATES, OBLIGATION_MAX_LINES, OBLIGATION_MAX_CHARS, STOP_DEADLINE_MS,
  APPEND_TIMEOUT_MS, APPEND_ENV_VAR, HOOK_EVENT_TYPES, RECORD_BUDGET_END_MS, RECORD_MAX_MS, RECORD_MIN_MS,
};

// ---- CLI (Stop hook target — ALWAYS exits 0; prints {"systemMessage"}, the I.7 / I.8 / I.9 {"decision":"block","reason"} (I.7
// once per session, I.8 at most OPEN_SUB_MAX_BLOCKS times, I.9 at most RED_MAX_BLOCKS times), all in ONE object, or nothing) ----
if (require.main === module) {
  let done = false;
  const finish = (obj) => {
    if (done) return;
    done = true;
    if (obj) { try { fs.writeSync(1, JSON.stringify(obj) + '\n'); } catch { /* nothing left to report to */ } }
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
    const msg = r.print ? { systemMessage: r.text } : null;
    finish(r.block ? Object.assign({ decision: 'block', reason: r.block_text }, msg || {}) : msg);
  });
  process.stdin.resume();
}
