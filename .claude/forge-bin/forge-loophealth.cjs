#!/usr/bin/env node
'use strict';
/**
 * forge-loophealth.cjs — a read-only, advisory LOOP-HEALTH check over the tool-call ledger that
 * forge-toolhook.cjs already writes. It answers one narrow question: "is one file being edited over and
 * over without converging?" — nothing forge-heartbeat.cjs (silence) or forge-verify.cjs's
 * loopConvergence() (review rounds) already covers.
 *
 * WHY (PRD prd-w2-discipline, module M3, ac-3): forge-toolhook logs every Write/Edit/MultiEdit/
 * NotebookEdit call, but nothing counts repeated edits to the SAME target, so a busy-but-not-converging
 * loop stays invisible until a human notices. This tool is a cheap, read-only lens over that existing
 * ledger — it never writes, deletes, or touches the network, and it never fails a build on its own
 * (advisory, exit 0; `--strict` is the one opt-in exception).
 *
 * WHERE IT READS (see forge-toolhook.cjs's own header for why the ledger lives here):
 *   .claude/forge-runs/_toollog/<session>.jsonl        (current generation)
 *   .claude/forge-runs/_toollog/<session>.1.jsonl      (one rotated generation, kept at 4MB rotation)
 *   .claude/forge-runs/<run_id>/run.json               (only for the time-window fallback)
 *
 * WHICH LINES BELONG TO A RUN (--run <id>) — decided PER LINE:
 *   1. A TAGGED line (forge-toolhook stamps `run` only when FORGE_RUN_ID was set, so it is often
 *      missing) belongs to exactly the run it names: `run === runId` counts, a line tagged for any other
 *      run never does, whatever its timestamp.
 *   2. An UNTAGGED line counts when its `ts` falls inside the run's window: `<runId>/run.json`'s
 *      `started_at` through `finalized_at` (or, when a run finished without a `finalized_at` but DOES carry
 *      `completed_at` on a `"completed"` status — a real shape observed in this project's own run.json
 *      history — that `completed_at`; otherwise `now`). A window end before its start is clamped to the
 *      start rather than ever inverting the range.
 *   Basis: 'run-field' (only tagged lines), 'time-window' (only untagged lines), 'mixed' (both), or
 *   'none' when there is no tagged line AND no usable run.json window — nothing is flagged and a clear
 *   note explains why. That is not an error; a brand-new run simply has nothing to measure yet.
 *
 * WHICH LINES BELONG TO A SESSION (--session <id>): exactly `<id>.jsonl` + `<id>.1.jsonl`, filtered to
 * `session === id` as a cheap belt-and-braces check — basis 'session'.
 *
 * WHAT COUNTS AS AN EDIT: a line whose `tool` is Write, Edit, MultiEdit or NotebookEdit AND whose
 * `target` is a non-empty string. EVERY attempt counts, including a failed one (`ok:false`) — a loop that
 * keeps failing the same edit is still a loop; `ok_count` on each flagged entry reports how many of those
 * attempts actually succeeded. Every other tool, and any edit-tool line with no target, is ignored
 * entirely (never counted, never a reason to flag).
 *
 * SAFETY: never follows a symlink (the `_toollog` directory itself, a file inside it, or `run.json`'s own
 * path are each `lstat`-checked before being trusted — a symlinked entry is treated as absent, never
 * read). Every id (`runId`/`sessionId`) is validated against ID_RE before it ever reaches a path, so no
 * path-traversal character (a slash) can reach `path.join`. Files here are capped at 4MB by
 * forge-toolhook's own rotation, so reading one whole is fine; a malformed line is skipped and counted
 * rather than crashing the scan.
 *
 * Module API: { analyze, EDIT_TOOLS, DEFAULT_THRESHOLD, ID_RE, DEFAULT_ROOT }
 *   analyze({ root, runId, sessionId, threshold = 5, now }) -> {
 *     basis: 'run-field' | 'time-window' | 'mixed' | 'session' | 'none',
 *     window: { from, to } | null,
 *     threshold, files_read, lines_scanned, lines_malformed, edits_counted,
 *     flagged: [{ target, count, ok_count, failed_count, unknown_count, first_ts, last_ts, sessions }],   // sorted by count desc
 *     note: string | null,   // a plain-language reason, only when there is something worth saying
 *   }
 *   Exactly one of `runId`/`sessionId` must be given; both or neither throws.
 *
 * CLI: node forge-loophealth.cjs --run <id> | --session <id> [--threshold N] [--json] [--strict] [--root <dir>]
 *   Always exits 0 (advisory). `--strict` exits 3 when anything is flagged, so a run checklist can gate
 *   on it deliberately without this tool ever surprising a normal build. Exit 1 on bad CLI arguments or
 *   an invalid id — that is a usage mistake, not a loop-health finding.
 */
const fs = require('fs');
const path = require('path');

// WP 2.1 state paths: forge-paths.cjs decides the layout (the opt-in .forge/ folder, else the legacy .claude/forge-*
// folders exactly as before). Guarded: a missing or older forge-paths.cjs keeps the legacy paths and never crashes.
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.stateDir === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function statePath(root, key, read) {
  const legacy = path.join(root, '.claude', 'forge-' + key);
  if (!forgePaths) return legacy;
  try { return forgePaths.layout(root) !== 'forge' ? legacy : (read ? forgePaths.resolveExisting(root, key) : forgePaths.stateDir(root, key)); }
  catch (e) { if (process.env.FORGE_STATE_DIR || fs.existsSync(path.join(root, '.forge'))) throw e; return legacy; }
}
/** runDirOf(root, id) -> <runs>/<id>: the active runs folder, or the legacy one when <id> only exists there. */
function runDirOf(root, id) {
  const active = path.join(statePath(root, 'runs'), id), legacy = path.join(root, '.claude', 'forge-runs', id);
  return active !== legacy && !fs.existsSync(active) && fs.existsSync(legacy) ? legacy : active;
}
// this copy's project (forge-paths scriptRoot); null for a plugin copy outside any project -> analyze() needs a root
const DEFAULT_ROOT = forgePaths ? forgePaths.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..');
const DEFAULT_THRESHOLD = 5;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// No slash of any kind is allowed, so a validated id can never escape the directory it is joined into —
// '..' alone still matches (it has no separator) but produces only a literal, harmless path component.
// Lead review: a dots-only id ('.', '..') has no slash but still names the current or parent
// folder, so it is rejected too.
const ID_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

function stripBom(s) { return (typeof s === 'string' && s.charCodeAt(0) === 0xFEFF) ? s.slice(1) : s; }
function parseIso(s) {
  if (typeof s !== 'string' || !s.length) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}
function validateId(id, label) {
  if (typeof id !== 'string' || !id.length || !ID_RE.test(id)) {
    throw new Error('invalid ' + label + ': ' + JSON.stringify(id) + ' (allowed characters: letters, digits, "." "_" "-")');
  }
  return id;
}

function toollogDir(root) { return runDirOf(root, '_toollog'); }

/** toollogDirUsable — true only when `_toollog` exists AND is a real directory, never a symlink/junction
 *  (lstat does not follow a link, so a symlinked entry correctly reports isDirectory()===false here). */
function toollogDirUsable(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return false; }
  return st.isDirectory();
}

/** listAllJsonlFiles — every current + rotated generation across every session (run-mode scope). Only
 *  plain files are trusted; a symlink masquerading as a `.jsonl` entry is skipped, never followed. */
function listAllJsonlFiles(dir) {
  if (!toollogDirUsable(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || (typeof e.isSymbolicLink === 'function' && e.isSymbolicLink())) continue;
    if (!/\.jsonl$/i.test(e.name)) continue;
    out.push(path.join(dir, e.name));
  }
  return out.sort();
}

/** listSessionJsonlFiles — exactly the two generations of ONE session (session-mode scope): the current
 *  file and its single rotated generation, by their own documented naming convention. */
function listSessionJsonlFiles(dir, sessionId) {
  if (!toollogDirUsable(dir)) return [];
  const out = [];
  for (const name of [sessionId + '.jsonl', sessionId + '.1.jsonl']) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile()) continue; // absent, a directory, or a symlink (lstat never follows it) — skip
    out.push(p);
  }
  return out;
}

/** readAllLines(files) -> { files_read, lines_scanned, lines_malformed, records }. Pure, hermetic: reads
 *  each file whole (capped at 4MB by forge-toolhook's own rotation) and parses line by line. A line that
 *  fails to parse, or parses to anything other than a plain object, is counted as malformed and skipped —
 *  never thrown, never crashes the scan. */
function readAllLines(files) {
  let files_read = 0, lines_scanned = 0, lines_malformed = 0;
  const records = [];
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; } // vanished between listing and reading
    files_read++;
    raw = stripBom(raw);
    for (const rawLine of raw.split(/\r?\n/)) {
      const s = rawLine.trim();
      if (!s) continue;
      lines_scanned++;
      let obj;
      try { obj = JSON.parse(s); } catch { lines_malformed++; continue; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { lines_malformed++; continue; }
      const ts = typeof obj.ts === 'string' ? obj.ts : null;
      records.push({
        tool: typeof obj.tool === 'string' ? obj.tool : null,
        target: (typeof obj.target === 'string' && obj.target.length) ? obj.target : null,
        ok: obj.ok === true ? true : (obj.ok === false ? false : null),
        ts,
        tsMs: parseIso(ts),
        session: (typeof obj.session === 'string' && obj.session.length) ? obj.session : null,
        run: (typeof obj.run === 'string' && obj.run.length) ? obj.run : null,
      });
    }
  }
  return { files_read, lines_scanned, lines_malformed, records };
}

/** readRunJson(root, runId) -> plain object | null. Never follows a symlink in place of the real file;
 *  never throws (a missing, unreadable, or malformed run.json is uniformly "null" — the caller folds
 *  that into basis 'none'). */
function readRunJson(root, runId) {
  const p = path.join(runDirOf(root, runId), 'run.json');
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (!st.isFile()) return null;
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  let data;
  try { data = JSON.parse(stripBom(raw)); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

/** runTimeWindow(root, runId, now) -> { fromMs, toMs } | null. null means "basis 'none'": no run.json,
 *  or no usable `started_at`. The end of the window prefers `finalized_at`, then (only for a `"completed"`
 *  run that never got a `finalized_at`) `completed_at`, then `now` — see the file header for why. */
function runTimeWindow(root, runId, now) {
  const data = readRunJson(root, runId);
  if (!data) return null;
  const fromMs = parseIso(data.started_at);
  if (fromMs === null) return null;
  let toMs = parseIso(data.finalized_at);
  if (toMs === null && data.status === 'completed') toMs = parseIso(data.completed_at);
  if (toMs === null) toMs = now;
  if (toMs < fromMs) toMs = fromMs; // defensive: a window must never invert
  return { fromMs, toMs };
}

/** buildResult — groups the already-scoped `records` by target, counts edit attempts, and produces the
 *  final shape documented in the file header. `dirExists` only supplies the fallback note when nothing
 *  more specific (e.g. "no run.json") already explains an empty result. */
/** normalizeTarget(target, root) -> { display, key }. Lead review: the tool log spells one file in
 *  several ways (backslashes, an absolute path inside the project, a leading './', and on Windows different
 *  letter case), which used to split one file's edits across several targets and hide a real loop. The display
 *  form is project-relative with forward slashes when the path is inside the root; the key also folds case on
 *  Windows, where the file system does too. A path outside the root keeps its own (slash-normalised) spelling. */
function normalizeTarget(target, root) {
  // resolve EVERY target against the project root with the platform's own path
  // rules (so internal '.'/'..', doubled separators and a path that leaves and re-enters the root all land on
  // one absolute path), then show it project-relative when it is inside the root. Windows drive and UNC
  // semantics are kept (W2-N02): '\\server\share\a.js' and '/server/share/a.js' resolve to different files.
  // A backslash only separates folders on Windows; elsewhere a log line written on Windows is read with '/'.
  let t = process.platform === 'win32' ? target : target.replace(/\\/g, '/');
  // Verify Boss residual: a Windows long-path spelling names the same file as its normal form —
  // '\\?\C:\x' is 'C:\x' and '\\?\UNC\server\share\x' is '\\server\share\x'.
  if (process.platform === 'win32') {
    if (/^\\\\\?\\UNC\\/i.test(t)) t = '\\\\' + t.slice(8);
    else if (/^\\\\\?\\[A-Za-z]:\\/.test(t)) t = t.slice(4);
  }
  const abs = path.resolve(root, t);
  const rel = path.relative(root, abs);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const display = (inside ? rel : abs).split(path.sep).join('/');
  const key = process.platform === 'win32' ? display.toLowerCase() : display;
  return { display, key };
}

function buildResult(basis, window, threshold, read, records, note, dirExists, root) {
  const edits = records.filter((r) => EDIT_TOOLS.has(r.tool) && r.target);
  const byTarget = new Map();
  for (const r of edits) {
    const nt = normalizeTarget(r.target, root);
    let g = byTarget.get(nt.key);
    if (!g) {
      g = { target: nt.display, count: 0, ok_count: 0, failed_count: 0, unknown_count: 0, first_ts: null, last_ts: null, first_tsMs: null, last_tsMs: null, sessions: new Set() };
      byTarget.set(nt.key, g);
    }
    g.count++;
    // ok:null (ok_basis 'absent') means the hook could not see the tool's result — unknown, never a failure.
    if (r.ok === true) g.ok_count++;
    else if (r.ok === false) g.failed_count++;
    else g.unknown_count++;
    if (r.tsMs !== null) {
      if (g.first_tsMs === null || r.tsMs < g.first_tsMs) { g.first_tsMs = r.tsMs; g.first_ts = r.ts; }
      if (g.last_tsMs === null || r.tsMs > g.last_tsMs) { g.last_tsMs = r.tsMs; g.last_ts = r.ts; }
    }
    if (r.session) g.sessions.add(r.session);
  }
  const flagged = Array.from(byTarget.values())
    .filter((g) => g.count >= threshold)
    .map((g) => ({ target: g.target, count: g.count, ok_count: g.ok_count, failed_count: g.failed_count, unknown_count: g.unknown_count, first_ts: g.first_ts, last_ts: g.last_ts, sessions: Array.from(g.sessions).sort() }))
    .sort((a, b) => (b.count - a.count) || a.target.localeCompare(b.target));

  // the folder named as it is in this project's layout (legacy: exactly the old .claude/forge-runs/_toollog text)
  const finalNote = note || (dirExists === false
    ? 'no ' + path.relative(root, toollogDir(root)).split(path.sep).join('/') + ' folder yet — nothing has been logged for this project'
    : null);

  return {
    basis,
    window: window || null,
    threshold,
    files_read: read.files_read,
    lines_scanned: read.lines_scanned,
    lines_malformed: read.lines_malformed,
    edits_counted: edits.length,
    flagged,
    note: finalNote,
  };
}

function analyzeByRun(root, runId, threshold, now) {
  const dir = toollogDir(root);
  const dirExists = toollogDirUsable(dir);
  const read = readAllLines(listAllJsonlFiles(dir));

  // ownership is decided PER RECORD. A line tagged with a run belongs to that run and no other;
  // only an untagged line is attributed by the run's time window. One tagged line therefore never hides
  // untagged edits, and another run's tagged edits are never pulled in through an overlapping window.
  const tagged = read.records.filter((r) => r.run === runId);
  const window = runTimeWindow(root, runId, now);
  if (!window && tagged.length === 0) {
    return buildResult('none', null, threshold, read, [], 'no run.json (or no usable started_at) for run "' + runId + '" — nothing can be flagged for it', dirExists, root);
  }
  const untagged = window
    ? read.records.filter((r) => !r.run && r.tsMs !== null && r.tsMs >= window.fromMs && r.tsMs <= window.toMs)
    : [];
  const basis = tagged.length && untagged.length ? 'mixed' : (tagged.length ? 'run-field' : 'time-window');
  const windowOut = window ? { from: new Date(window.fromMs).toISOString(), to: new Date(window.toMs).toISOString() } : null;
  return buildResult(basis, windowOut, threshold, read, tagged.concat(untagged), null, dirExists, root);
}

function analyzeBySession(root, sessionId, threshold) {
  const dir = toollogDir(root);
  const dirExists = toollogDirUsable(dir);
  const read = readAllLines(listSessionJsonlFiles(dir, sessionId));
  const sessionRecords = read.records.filter((r) => r.session === sessionId);
  return buildResult('session', null, threshold, read, sessionRecords, null, dirExists, root);
}

/** analyze({ root, runId, sessionId, threshold, now }) -> see file header for the full return shape.
 *  Exactly one of runId/sessionId is required; both or neither is a usage error (thrown, never silently
 *  guessed). Never writes, deletes, or touches the network. */
function analyze(opts) {
  opts = opts || {};
  const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
  if (!root) throw new Error('no project root found (no .claude, .forge or .git above the current folder; pass --root)');
  const threshold = (Number.isFinite(opts.threshold) && opts.threshold > 0) ? Math.floor(opts.threshold) : DEFAULT_THRESHOLD;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const hasRun = opts.runId !== undefined && opts.runId !== null;
  const hasSession = opts.sessionId !== undefined && opts.sessionId !== null;
  if (hasRun && hasSession) throw new Error('analyze() takes either runId or sessionId, not both');
  if (!hasRun && !hasSession) throw new Error('analyze() requires either opts.runId or opts.sessionId');
  if (hasRun) return analyzeByRun(root, validateId(String(opts.runId), 'run id'), threshold, now);
  return analyzeBySession(root, validateId(String(opts.sessionId), 'session id'), threshold);
}

/** outcomeWords(flaggedEntry) -> "N succeeded[, M failed][, K result unknown]" — the plain words both this
 *  CLI and forge-verify's Loop Health section print, so an unknown result is never read as a failure. */
function outcomeWords(f) {
  const parts = [f.ok_count + ' succeeded'];
  if (f.failed_count) parts.push(f.failed_count + ' failed');
  if (f.unknown_count) parts.push(f.unknown_count + ' result unknown');
  return parts.join(', ');
}

module.exports = { analyze, outcomeWords, normalizeTarget, EDIT_TOOLS, DEFAULT_THRESHOLD, ID_RE, DEFAULT_ROOT };

// ---- CLI --------------------------------------------------------------------------------------------
if (require.main === module) {
  function parseArgs(argv) {
    const out = { run: null, session: null, threshold: null, json: false, strict: false, root: null, help: false };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--run') out.run = argv[++i];
      else if (a === '--session') out.session = argv[++i];
      else if (a === '--threshold') out.threshold = Number(argv[++i]);
      else if (a === '--json') out.json = true;
      else if (a === '--strict') out.strict = true;
      else if (a === '--root') out.root = argv[++i];
      else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
  }

  function printHuman(result, idLabel) {
    const scopeWord = result.basis === 'session' ? 'in this session' : 'in this run';
    const lines = [];
    lines.push(
      'Loop health (' + idLabel + ') — basis: ' + result.basis + ' — threshold: ' + result.threshold +
      ' — ' + result.edits_counted + ' edit attempt(s) across ' + result.files_read + ' file(s), ' +
      result.lines_scanned + ' line(s) scanned (' + result.lines_malformed + ' malformed)' +
      (result.note ? ' — ' + result.note : '')
    );
    if (result.flagged.length === 0) {
      lines.push('  nothing flagged.');
    } else {
      for (const f of result.flagged) {
        lines.push('  ' + f.target + ' edited ' + f.count + ' times (' + outcomeWords(f) + ') ' + scopeWord +
          ' — busy but maybe not converging; check whether the approach needs to change');
      }
    }
    console.log(lines.join('\n'));
  }

  const USAGE = 'Usage: node forge-loophealth.cjs --run <id> | --session <id> [--threshold N] [--json] [--strict] [--root <dir>]';

  function cliMain(opts) {
    const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
    if (!root) throw new Error('no project root found (no .claude, .forge or .git above the current folder; pass --root)');
    const threshold = (Number.isFinite(opts.threshold) && opts.threshold > 0) ? Math.floor(opts.threshold) : DEFAULT_THRESHOLD;
    const result = analyze({ root, runId: opts.run, sessionId: opts.session, threshold });
    printHuman(result, opts.run || opts.session);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    process.exitCode = (opts.strict && result.flagged.length > 0) ? 3 : 0;
  }

  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    console.log('  Advisory, read-only loop-health check over .claude/forge-runs/_toollog/. Always exits 0,');
    console.log('  except --strict (exits 3 when something is flagged) or a bad argument/invalid id (exits 1).');
    process.exitCode = 0;
  } else if (!opts.run && !opts.session) {
    console.error(USAGE);
    console.error('forge-loophealth: pass exactly one of --run <id> or --session <id>');
    process.exitCode = 1;
  } else if (opts.run && opts.session) {
    console.error(USAGE);
    console.error('forge-loophealth: use either --run or --session, not both');
    process.exitCode = 1;
  } else {
    try { cliMain(opts); } catch (e) { console.error('forge-loophealth: ' + e.message); process.exitCode = 1; }
  }
}
