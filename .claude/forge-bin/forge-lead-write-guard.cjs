#!/usr/bin/env node
'use strict';
/**
 * forge-lead-write-guard.cjs — R8B-F2: the Lead of a /forge build writes app files itself.
 *
 * WHY: in category round 8b the Lead (Sonnet 5.5 as GOAT router) skipped the /forge procedure. The android Lead never
 * ran the start step (no owner_prefs_loaded, no memory_loaded, no work package) and wrote the whole app itself: 10 Write
 * + 1 Edit in .claude/forge-runs/_toollog with agent_id null (main thread), while subagent calls in the same log carry
 * an agent_id. Forge only recorded it. This module is the judgement forge-toolhook.cjs (PostToolUse, matcher
 * Write|Edit|MultiEdit|NotebookEdit|Bash) asks for after a write; the toolhook prints the feedback and records the
 * decision on its ledger line. No new hook entry: the toolhook is already wired.
 *
 * WHEN IT ACTS — all of these hold, otherwise the decision is `skipped` (with a short constant `why`):
 *   - the tool is Write, Edit, MultiEdit or NotebookEdit;
 *   - the payload has no agent_id (the main thread, i.e. the Lead; subagent calls carry one);
 *   - the session has a /forge session marker: <runs>/_hooks/forge-session/<sha16>.json, sha16 = the first 16 hex chars
 *     of sha256(session_id), JSON {schema, session_sha, kind:'forge-build', created_at, prompt_rid}. Written by
 *     forge-scribe-hook.cjs; this module only reads it. Missing, unparsable, another kind or another session_sha =
 *     not a /forge build session: do nothing (fail open);
 *   - the target is inside the project and outside .claude/, .forge/, _scratch/ and the OS temp folder (the temp rule
 *     only applies when the project itself does not live in the temp folder).
 * Then config `lead-write-guard` (default on) is read; off -> `off`.
 *
 * THE TWO CASES (the write already happened, so the reason says what to do NOW):
 *   a) no active run for this session (forge-active-run.cjs), or the active run has no owner_prefs_loaded or no
 *      memory_loaded event -> run `node .claude/forge-bin/forge-start.cjs --text "<request>"` first;
 *   b) the active run has no work package -> the Lead is the router: log agent_work_package_created and dispatch
 *      build-boss/ui-boss. Only a work package that names a non-Lead assignee (agent, owner or handoff) is a dispatch.
 *      A Lead work package (agent Lead / orchestrator, nobody else named) never counts as one, with or without runtime
 *      "internal"; when it has runtime "internal", a reason of 20+ characters and 1-2 files, writes to exactly those
 *      files pass. A work package that names no assignee at all is ignored.
 * Each case is SHOWN at most once per session (state file <runs>/_hooks/lead-write-guard/<sha16>.json: schema, session
 * sha, shown times; no paths, no prompts). A repeat is recorded only (shown:false). When the state file cannot be
 * written the verdict is recorded but never shown: the guard does not block because of its own error.
 *
 * COST: only the active run's events.jsonl is read (bounded, lines filtered by substring before JSON.parse); no contract
 * evaluation. evaluate() NEVER throws: any error gives `skipped` / `error`. The guard never blocks on what it cannot
 * read: a run pointer that is there but unreadable (run-pointer-unreadable), a missing or broken forge-active-run.cjs
 * (run-pointer-unavailable) and an unreadable events.jsonl (events-unreadable) are `skipped`. Only NO pointer file at all,
 * or a cleared, stale or other-session pointer, means "no active run" (case a).
 * Known gaps: by design of the spec, a write through Bash/PowerShell is not judged and a payload the toolhook had to
 * truncate (over 256 KB) is skipped, because agent_id cannot be read reliably from it. Two Lead writes whose hooks
 * run at the very same moment can both show the notice (the once-state is read, then rewritten, not locked).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

let fp = null;
try { const m = require('./forge-paths.cjs'); if (m && typeof m.stateDir === 'function') fp = m; } catch { fp = null; }

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DECISIONS = ['ok', 'blocked-a', 'blocked-b', 'off', 'skipped'];
const CONFIG_KEY = 'lead-write-guard';
const EXCLUDED_TOP = ['.claude', '.forge', '_scratch'];
const MARKER_MAX_BYTES = 4096;
const STATE_MAX_BYTES = 4096;
const EVENTS_MAX_BYTES = 32 * 1024 * 1024;
const MIN_REASON_CHARS = 20;
const MAX_LEAD_FILES = 2;
const IS_WIN = process.platform === 'win32';
const START_CMD = 'node .claude/forge-bin/forge-start.cjs --text "<request>"';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.length ? v : null; }
function result(decision, why, extra) { return Object.assign({ decision, why, shown: false, run: null, feedback: null }, extra || {}); }

function runsDir(root) {
  const legacy = path.join(root, '.claude', 'forge-runs');
  if (!fp) return legacy;
  try { return fp.stateDir(root, 'runs'); } catch { return legacy; }
}
function sessionSha(sessionId) { return crypto.createHash('sha256').update(String(sessionId), 'utf8').digest('hex').slice(0, 16); }
function markerPath(root, sessionId) { return path.join(runsDir(root), '_hooks', 'forge-session', sessionSha(sessionId) + '.json'); }
function statePath(root, sessionId) { return path.join(runsDir(root), '_hooks', 'lead-write-guard', sessionSha(sessionId) + '.json'); }

/** readSmallJson(file, max) -> the parsed object, or null (absent, too big, not a file, not JSON, not an object). */
function readSmallJson(file, max) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return isObj(v) ? v : null;
  } catch { return null; }
}

/** hasMarker(root, sessionId) -> true only for a readable forge-build marker of THIS session. */
function hasMarker(root, sessionId) {
  const m = readSmallJson(markerPath(root, sessionId), MARKER_MAX_BYTES);
  if (!m || m.kind !== 'forge-build') return false;
  return m.session_sha === undefined || m.session_sha === sessionSha(sessionId);
}

const norm = (p) => (IS_WIN ? p.toLowerCase() : p);
/** inside(base, p) -> p is base or below it (lexical, case-insensitive on Windows). */
function inside(base, p) {
  const rel = path.relative(norm(path.resolve(base)), norm(path.resolve(p)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
/** classifyTarget(root, file, tmpDir) -> { why: null|'outside-project'|'excluded-path', abs, rel }. */
function classifyTarget(root, file, tmpDir) {
  const abs = path.resolve(root, file);
  if (!inside(root, abs)) return { why: 'outside-project', abs, rel: null };
  const rel = path.relative(path.resolve(root), abs);
  const top = norm(rel.split(/[\\/]+/)[0] || '');
  if (EXCLUDED_TOP.some((d) => norm(d) === top)) return { why: 'excluded-path', abs, rel };
  if (tmpDir && inside(tmpDir, abs) && !inside(tmpDir, root)) return { why: 'excluded-path', abs, rel };
  return { why: null, abs, rel };
}

/** configOn(root, opts) -> the lead-write-guard value (default true) through forge-toolhook's fail-safe configRead. */
function configOn(root, opts) {
  try {
    const th = require('./forge-toolhook.cjs'); // eslint-disable-line global-require
    if (typeof th.configRead !== 'function') return true;
    return th.configRead(CONFIG_KEY, true, { projectRoot: root, configModule: opts.configModule }).value !== false;
  } catch { return true; }
}

/** activeRun(root, sessionId, mod) -> {run} (a run id, or null = no active run for this session) or {unreadable: why}
 *  when forge-active-run.cjs is missing, incomplete or throws (run-pointer-unavailable), or a pointer file is there but
 *  cannot be read (run-pointer-unreadable): then the guard fails open. readActiveRun answers "no pointer at all" with
 *  source null and the reason 'no active-run pointer'; any other source-less answer is an unreadable pointer, a missing
 *  root or its own caught error. mod injects the module (tests; null = absent). */
function activeRun(root, sessionId, mod) {
  let ar = mod;
  if (ar === undefined) { try { ar = require('./forge-active-run.cjs'); } catch { ar = null; } } // eslint-disable-line global-require
  if (!ar || typeof ar.readActiveRun !== 'function') return { unreadable: 'run-pointer-unavailable' };
  let r;
  try { r = ar.readActiveRun(root, sessionId); } catch { return { unreadable: 'run-pointer-unavailable' }; }
  if (!isObj(r)) return { unreadable: 'run-pointer-unavailable' };
  if (str(r.run)) return { run: r.run };
  if (r.source == null && r.reason !== 'no active-run pointer') return { unreadable: 'run-pointer-unreadable' };
  return { run: null };
}

const isLeadName = (v) => /^(lead|orchestrator)$/i.test(String(v || '').trim());
/** assignee(e) -> 'dispatch' when the work package names a non-Lead assignee (agent, owner or handoff), 'lead' when it is
 *  the Lead's own (agent Lead / orchestrator or role Lead, nobody else named), null when it names no assignee at all. */
function assignee(e) {
  const named = [e.agent, e.owner, e.handoff].filter((v) => typeof v === 'string' && v.trim());
  if (named.some((v) => !isLeadName(v))) return 'dispatch';
  return named.length || /^lead$/i.test(String(e.role || '').trim()) ? 'lead' : null;
}
/** leadFiles(e) -> the files a valid Lead-internal work package covers (runtime internal, a 20+ char reason, 1-2 files),
 *  or null when it does not qualify. */
function leadFiles(e) {
  if (String(e.runtime || '').trim().toLowerCase() !== 'internal') return null;
  if (typeof e.reason !== 'string' || e.reason.trim().length < MIN_REASON_CHARS) return null;
  const f = e.files;
  if (!Array.isArray(f) || f.length < 1 || f.length > MAX_LEAD_FILES) return null;
  return f.every((x) => typeof x === 'string' && x.trim().length) ? f.map((x) => x.trim()) : null;
}

/** readRunFacts(root, runId) -> { prefs, memory, dispatch, leadFiles: [..], invalidLead } or null when unreadable. */
function readRunFacts(root, runId) {
  const dirs = [path.join(runsDir(root), runId), path.join(root, '.claude', 'forge-runs', runId)];
  let raw = null;
  for (const d of dirs) {
    const f = path.join(d, 'events.jsonl');
    try {
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > EVENTS_MAX_BYTES) return null;
      raw = fs.readFileSync(f, 'utf8');
      break;
    } catch { /* try the next folder */ }
  }
  if (raw === null) return null;
  const out = { prefs: false, memory: false, dispatch: false, leadFiles: [], invalidLead: 0 };
  for (const line of raw.split('\n')) {
    if (!line.includes('owner_prefs_loaded') && !line.includes('memory_loaded') && !line.includes('agent_work_package_created')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!isObj(e)) continue;
    if (e.event_type === 'owner_prefs_loaded') out.prefs = true;
    else if (e.event_type === 'memory_loaded') out.memory = true;
    else if (e.event_type === 'agent_work_package_created') {
      const who = assignee(e);
      if (who === 'dispatch') { out.dispatch = true; continue; }
      if (who === null) continue;
      const files = leadFiles(e);
      if (files) out.leadFiles.push(...files); else out.invalidLead++;
    }
  }
  return out;
}

const slash = (p) => String(p).split(/[\\/]+/).join('/');
function reasonA(rel, runId, missing) {
  const detail = runId
    ? { en: 'run ' + runId + ' has no ' + missing.join(' and no '), nl: 'run ' + runId + ' mist ' + missing.join(' en ') }
    : { en: 'no active run for this session', nl: 'geen actieve run voor deze sessie' };
  return 'FORGE LEAD WRITE (' + rel + '): the /forge run was not started (' + detail.en + ').\n'
    + '- NL: Dit is een /forge-bouwsessie en jij bent de Lead, maar de run is niet gestart (' + detail.nl + '). De wijziging staat er al. '
    + 'Doe nu eerst: ' + START_CMD + ' (met het verzoek van de eigenaar). Dat start de run en laadt voorkeuren en geheugen; bouw daarna via werkpakketten.\n'
    + '- EN: This is a /forge build session and you are the Lead, but the run was not started (' + detail.en + '). The change is already written. '
    + 'Do this now: ' + START_CMD + ' (with the owner\'s request). It starts the run and loads prefs and memory; then build through work packages.\n'
    + '(Shown once per session; later Lead writes are recorded. / Een keer per sessie getoond; latere Lead-writes worden vastgelegd.)';
}
function reasonB(rel, runId, facts) {
  const covers = facts.leadFiles.length ? ' Your Lead work package covers only: ' + facts.leadFiles.map(slash).join(', ') + '.' : '';
  const invalid = facts.invalidLead ? ' ' + facts.invalidLead + ' Lead work package(s) do not count (they need runtime "internal", a reason of 20+ characters and 1-2 files).' : '';
  // FB-GUARDS-1-F16: the JSON goes in on stdin (--batch), so it works the same in Git Bash and PowerShell 5.1; a JSON
  // command-line argument loses its inner double quotes in PowerShell 5.1.
  const example = 'echo \'' + JSON.stringify({ event_type: 'agent_work_package_created', agent: 'Lead', runtime: 'internal', reason: '<why the Lead fixes this itself>', files: [rel] }).replace(/'/g, '\\u0027')
    + '\' | node .claude/forge-dashboard/log-event.cjs --batch ' + runId;
  return 'FORGE LEAD WRITE (' + rel + '): run ' + runId + ' has no work package.' + covers + invalid + '\n'
    + '- NL: Jij bent de router van deze /forge-run en run ' + runId + ' heeft nog geen werkpakket. De wijziging staat er al. '
    + 'Doe nu: log een agent_work_package_created en stuur build-boss of ui-boss op zijn route. Echt een fix van een of twee bestanden door de Lead zelf? '
    + 'Log dan agent_work_package_created met agent "Lead", runtime "internal", een reason van minstens 20 tekens en files (hooguit 2); schrijven naar precies die bestanden gaat dan door.\n'
    + '- EN: You are the router of this /forge run and run ' + runId + ' has no work package yet. The change is already written. '
    + 'Now: log an agent_work_package_created and dispatch build-boss or ui-boss on its route. A genuine one- or two-file Lead fix? '
    + 'Then log agent_work_package_created with agent "Lead", runtime "internal", a reason of 20+ characters and files (at most 2); writes to exactly those files then pass.\n'
    + 'Example: ' + example + '\n'
    + '(Shown once per session; later Lead writes are recorded. / Een keer per sessie getoond; latere Lead-writes worden vastgelegd.)';
}

/** violation(root, sessionId, which, runId, reason) -> blocked-<which>: shown once per case per session. */
function violation(root, sessionId, which, runId, reason) {
  const decision = 'blocked-' + which;
  const file = statePath(root, sessionId);
  const prev = readSmallJson(file, STATE_MAX_BYTES);
  const shown = prev && isObj(prev.shown) ? prev.shown : {};
  if (typeof shown[which] === 'string') return result(decision, 'repeat', { run: runId });
  const next = { schema: 1, session_sha: sessionSha(sessionId), shown: { a: typeof shown.a === 'string' ? shown.a : null, b: typeof shown.b === 'string' ? shown.b : null } };
  next.shown[which] = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch { return result(decision, 'state-unwritable', { run: runId }); }
  return result(decision, 'shown', { run: runId, shown: true, feedback: { decision: 'block', reason } });
}

/** evaluate(payload, opts) -> { decision, why, shown, run, feedback }. decision is one of DECISIONS; feedback is the
 *  PostToolUse object {decision:'block', reason} only when shown. opts: root (the project root the toolhook acts on),
 *  tmpDir (default os.tmpdir()), configModule and activeRunModule (tests). NEVER throws. */
function evaluate(payload, opts) {
  opts = opts || {};
  try {
    if (!isObj(payload)) return result('skipped', 'no-payload');
    if (!WRITE_TOOLS.has(payload.tool_name)) return result('skipped', 'not-a-write');
    if (str(payload.agent_id)) return result('skipped', 'subagent');
    const sessionId = str(payload.session_id);
    if (!sessionId) return result('skipped', 'no-session');
    if (opts.root !== undefined && !str(opts.root)) return result('skipped', 'no-root');
    const root = path.resolve(opts.root || (fp ? fp.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..'))); // forge-paths fallback
    const input = isObj(payload.tool_input) ? payload.tool_input : null;
    const file = input && (str(input.file_path) || str(input.notebook_path) || str(input.filePath));
    if (!file) return result('skipped', 'no-target');
    if (!hasMarker(root, sessionId)) return result('skipped', 'no-marker');
    const tgt = classifyTarget(root, file, opts.tmpDir !== undefined ? opts.tmpDir : os.tmpdir());
    if (tgt.why) return result('skipped', tgt.why);
    if (!configOn(root, opts)) return result('off', 'config-off');
    const rel = slash(tgt.rel);
    const pointer = activeRun(root, sessionId, opts.activeRunModule);
    if (pointer.unreadable) return result('skipped', pointer.unreadable);
    const runId = pointer.run;
    if (!runId) return violation(root, sessionId, 'a', null, reasonA(rel, null, []));
    const facts = readRunFacts(root, runId);
    if (!facts) return result('skipped', 'events-unreadable', { run: runId });
    const missing = [!facts.prefs && 'owner_prefs_loaded', !facts.memory && 'memory_loaded'].filter(Boolean);
    if (missing.length) return violation(root, sessionId, 'a', runId, reasonA(rel, runId, missing));
    if (facts.dispatch) return result('ok', 'work-package', { run: runId });
    if (facts.leadFiles.some((f) => norm(path.resolve(root, f)) === norm(tgt.abs))) return result('ok', 'lead-internal-wp', { run: runId });
    return violation(root, sessionId, 'b', runId, reasonB(rel, runId, facts));
  } catch { return result('skipped', 'error'); }
}

module.exports = { evaluate, sessionSha, markerPath, statePath, classifyTarget, readRunFacts, WRITE_TOOLS, DECISIONS, CONFIG_KEY };

if (require.main === module) {
  console.log('Usage: forge-lead-write-guard.cjs is a module, not a command.');
  console.log('  forge-toolhook.cjs (PostToolUse) calls evaluate() after a Lead Write/Edit/MultiEdit/NotebookEdit in a /forge');
  console.log('  build session and records the decision (ok|blocked-a|blocked-b|off|skipped) on its _toollog line. Turn it off');
  console.log('  only as the owner: node .claude/forge-bin/forge-config.cjs set lead-write-guard off');
  process.exit(0);
}
