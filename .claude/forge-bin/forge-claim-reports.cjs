#!/usr/bin/env node
'use strict';
/**
 * forge-claim-reports.cjs — WHICH reports belong to a run, for forge-claim-check.cjs (run
 * review round 1 HIGH 1). The second "every package was verified" incident was in
 * the project-level EINDRAPPORT of that day in the docs folder, outside every run folder, so judging <run>/final-report.md alone left
 * the same sentence free to be written there again. This module is the ONE entry point that names every
 * owner-facing report of a run; forge-claim-check judges them, forge-endreview record and forge-finalize refuse.
 *
 * THE REPORTS OF A RUN:
 *   run    <run>/final-report.md;
 *   event  every .md path whose file name holds "report" or "rapport", named by the run's report_generated /
 *          prd_generated events (fields path, artifact, output_artifact, evidence, report, file; a value may be a
 *          sentence or an "a; b" list), resolved against the project root, <root>/.claude and the run folder.
 *          A path inside ANOTHER run's folder is left to that run (a prd event that points at the previous run's
 *          report is that run's evidence); a path outside the project is never read; both are noted;
 *   docs   docs/**\/EINDRAPPORT*.md and docs/**\/*final*report*.md changed during the run: since its first event
 *          timestamp, until its run_finalized when the run is sealed (else 6 h after its last event). When the project root is a git top level:
 *          committed in that window (git log --since/--until, read-only, no network) OR dirty/untracked with an
 *          mtime in it (a checkout that only touches mtimes does not count); otherwise by mtime. A ledger without
 *          timestamps has no window: the docs reports are skipped WITH a note, never silently.
 *
 * API: reportsForRun({root?, runDir, events}) -> {root, reports[{file, rel, source: run|event|docs}], notes[]}
 *      (root is inferred from a legacy <root>/.claude/forge-runs/<id> folder when not passed; unknown root = no docs
 *      scan, with a note). Zero dependencies; bounded walk (depth 8, 20000 entries); git runs with a 15 s timeout.
 *      changedAfter(root, sinceMs, files, notes, {anchor}) -> Set of the files changed after sinceMs (round 3, sealed
 *      drift): when the root is a git top level, a commit touching the file after the SEAL COMMIT (the commit that
 *      added the anchor, the run's run-finalized.json — the Lead commits receipt and report together seconds after
 *      the seal, which is bookkeeping, not drift; without a tracked anchor: after sinceMs) or a dirty/untracked file;
 *      a tracked, clean file is unchanged whatever its mtime (a checkout touches mtimes); an untracked or ignored
 *      file (run folders may be ignored) and every file without git go by mtime (2 s slack). Read-only, no network.
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const REPORT_FILE = 'final-report.md';
const REPORT_EVENTS = new Set(['report_generated', 'prd_generated']);
const PATH_FIELDS = ['path', 'artifact', 'output_artifact', 'evidence', 'report', 'file'];
const MAX_WALK = 20000, MAX_DEPTH = 8, MAX_PATH = 400, GIT_TIMEOUT_MS = 15000;
const OPEN_SLACK_MS = 6 * 3600e3; // an open run owns docs changes up to 6 h after its last event
const MTIME_SLACK_MS = 2000; // a file system timestamp within 2 s of the seal is not "after" it
const MAX_PATHSPECS = 256;
const WIN32 = process.platform === 'win32';

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const outside = (base, f) => { const r = path.relative(base, f); return r === '' ? false : r.startsWith('..') || path.isAbsolute(r); };
const keyOf = (rel) => { const k = String(rel).split(path.sep).join('/'); return WIN32 ? k.toLowerCase() : k; };
const relOf = (base, f) => path.relative(base, f).split(path.sep).join('/');
const isReportName = (b) => { b = b.toLowerCase(); return b.endsWith('.md') && (b.includes('report') || b.includes('rapport')); };
function isDocsReportName(b) {
  b = b.toLowerCase();
  if (!b.endsWith('.md')) return false;
  if (b.startsWith('eindrapport')) return true;
  const f = b.indexOf('final');
  return f >= 0 && b.indexOf('report', f + 5) >= 0;
}
/** inferRoot(runDir) — <root>/.claude/forge-runs/<id> -> <root>; any other layout -> null (pass root explicitly). */
function inferRoot(dir) {
  const runs = path.dirname(dir), claude = path.dirname(runs);
  return path.basename(runs) === 'forge-runs' && path.basename(claude) === '.claude' ? path.dirname(claude) : null;
}
/** eventPaths(e) -> the .md report paths a report/prd event names. */
function eventPaths(e) {
  const out = [];
  for (const k of PATH_FIELDS) {
    if (typeof e[k] !== 'string') continue;
    for (const w of e[k].split(/[\s;,]+/)) {
      if (!w || w.length > MAX_PATH) continue;
      const p = w.replace(/^[`'"(<[]+/, '').replace(/[`'")>\]:.]+$/, '');
      if (p.toLowerCase().endsWith('.md') && isReportName(path.basename(p))) out.push(p);
    }
  }
  return out;
}
/** namedReports(root, dir, events, notes) -> absolute paths of existing reports named by report/prd events. */
function namedReports(root, dir, events, notes) {
  const out = [];
  for (const e of events) {
    if (!e || !REPORT_EVENTS.has(e.event_type)) continue;
    for (const p of eventPaths(e)) {
      const cands = path.isAbsolute(p) ? [p] : [root, root && path.join(root, '.claude'), dir].filter(Boolean).map((b) => path.resolve(b, p));
      const f = cands.find(isFile);
      if (!f) { notes.push(e.event_type + ' names ' + p + ', which was not found: not judged'); continue; }
      if (root && outside(root, f)) { notes.push(e.event_type + ' names ' + p + ', which is outside the project: not judged'); continue; }
      out.push(f);
    }
  }
  return out;
}
/** runWindow(events) -> {since, until} | null — from the first event timestamp; until = the run_finalized time when
 *  sealed, else 6 h after the last event (real replay: without that bound, 52 old unsealed runs all claimed the same
 *  docs report written today). finalize and endreview record run right after the run's last event, so they are inside. */
function runWindow(events) {
  let since = Infinity, last = -Infinity, until = Infinity, sealed = false;
  for (const e of events) {
    const t = e && Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    if (t < since) since = t;
    if (t > last) last = t;
    if (e.event_type === 'run_finalized') { until = t; sealed = true; }
  }
  return Number.isFinite(since) ? { since, until: sealed ? until : last + OPEN_SLACK_MS } : null;
}
function walkDocs(root, notes) {
  const out = [], stack = [[path.join(root, 'docs'), 0]];
  let seen = 0;
  while (stack.length) {
    const [d, depth] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > MAX_WALK) { notes.push('docs/ holds more than ' + MAX_WALK + ' entries: the report walk stopped there'); return out; }
      if (e.isDirectory()) { if (depth < MAX_DEPTH && !e.name.startsWith('.') && e.name !== 'node_modules') stack.push([path.join(d, e.name), depth + 1]); }
      else if (e.isFile() && isDocsReportName(e.name)) out.push(path.join(d, e.name));
    }
  }
  return out;
}
function samePath(a, b) {
  const n = (p) => { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch { /* keep the resolved path */ } return WIN32 ? r.toLowerCase() : r; };
  return n(a) === n(b);
}
const gitAt = (root) => (args) => spawnSync('git', ['--no-optional-locks'].concat(args), { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** gitChanges(root, win, pathspecs = ['docs'], withTracked, afterCommit) -> {committed:Set, dirty:Set, tracked?:Set} | null —
 *  read-only git over the given pathspecs (relative to root); committed = touched in the window, or strictly after
 *  afterCommit when given; null = not a git top level here or git failed. */
function gitChanges(root, win, pathspecs, withTracked, afterCommit) {
  const git = gitAt(root);
  const specs = ['--'].concat(Array.isArray(pathspecs) && pathspecs.length ? pathspecs.slice(0, MAX_PATHSPECS) : ['docs']);
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top || top.status !== 0 || !samePath(String(top.stdout).trim(), root)) return null;
  const range = afterCommit ? [afterCommit + '..HEAD'] : ['--since=' + iso(win.since - 1000)].concat(Number.isFinite(win.until) ? ['--until=' + iso(win.until + 1000)] : []);
  const log = git(['log', '-z', '--no-renames', '--name-only', '--pretty=format:'].concat(range, specs));
  const st = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'].concat(specs));
  if (!log || log.status !== 0 || !st || st.status !== 0) return null;
  const committed = new Set(String(log.stdout).split(/[\0\n]/).map((s) => s.trim()).filter(Boolean).map(keyOf));
  const dirty = new Set(), parts = String(st.stdout).split('\0');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length < 4) continue;
    dirty.add(keyOf(parts[i].slice(3)));
    if (/[RC]/.test(parts[i].slice(0, 2))) i++; // a rename/copy entry is followed by its source path
  }
  const out = { committed, dirty };
  if (withTracked) {
    const ls = git(['ls-files', '-z'].concat(specs));
    if (!ls || ls.status !== 0) return null;
    out.tracked = new Set(String(ls.stdout).split('\0').map((s) => s.trim()).filter(Boolean).map(keyOf));
  }
  return out;
}
/** sealCommitOf(root, anchor) -> the hash of the commit that ADDED the anchor file (the seal commit), or null when the
 *  anchor is untracked, outside the root or git is not a top level here. */
function sealCommitOf(root, anchor) {
  if (!root || !anchor || outside(root, anchor)) return null;
  const git = gitAt(root);
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top || top.status !== 0 || !samePath(String(top.stdout).trim(), root)) return null;
  const r = git(['log', '--diff-filter=A', '--format=%H', '--', relOf(root, anchor)]);
  if (!r || r.status !== 0) return null;
  const hashes = String(r.stdout).split(/\s+/).filter(Boolean);
  return hashes.length ? hashes[hashes.length - 1] : null; // the first add (oldest) is the seal commit
}
/** changedAfter(root, sinceMs, files, notes, {anchor}) -> Set of absolute paths changed after sinceMs (see the header). */
function changedAfter(root, sinceMs, files, notes, opts) {
  const out = new Set();
  const list = (Array.isArray(files) ? files : []).map((f) => path.resolve(f));
  if (!list.length || !Number.isFinite(sinceMs)) return out;
  const mtimeAfter = (f) => { try { return fs.statSync(f).mtimeMs > sinceMs + MTIME_SLACK_MS; } catch { return false; } };
  const inRoot = root ? list.filter((f) => !outside(root, f)) : [];
  const sealCommit = inRoot.length && opts && opts.anchor ? sealCommitOf(root, path.resolve(opts.anchor)) : null;
  const range = sealCommit ? [sealCommit + '..HEAD'] : ['--since=' + iso(sinceMs - 1000)];
  const g = inRoot.length ? gitChanges(root, { since: sinceMs, until: Infinity }, inRoot.map((f) => relOf(root, f)), true, range[0].endsWith('..HEAD') ? sealCommit : null) : null;
  if (!g && root && inRoot.length && Array.isArray(notes)) notes.push('not a git top level (or git failed): changes after the seal are judged by mtime');
  else if (g && Array.isArray(notes) && opts && opts.anchor && !sealCommit) notes.push('the receipt is not committed yet: changes after the seal are judged by time, not by the seal commit');
  for (const f of list) {
    if (g && !outside(root, f)) {
      const k = keyOf(path.relative(root, f));
      if (g.committed.has(k) || g.dirty.has(k) || (!g.tracked.has(k) && mtimeAfter(f))) out.add(f);
    } else if (mtimeAfter(f)) out.add(f);
  }
  return out;
}
/** docsReports(root, events, notes) — docs/**\/EINDRAPPORT*.md and docs/**\/*final*report*.md changed during the run. */
function docsReports(root, events, notes) {
  if (!root) { notes.push('project root unknown: docs reports were not judged (pass --root)'); return []; }
  const cands = walkDocs(root, notes);
  if (!cands.length) return [];
  const win = runWindow(events);
  if (!win) { notes.push('no event timestamp in the ledger: ' + cands.length + ' docs report(s) cannot be tied to this run and were not judged'); return []; }
  const mtimeIn = (f) => { try { const m = fs.statSync(f).mtimeMs; return m >= win.since && m <= win.until; } catch { return false; } };
  const g = gitChanges(root, win, ['docs'], false);
  const inWindow = g ? (f) => { const k = keyOf(path.relative(root, f)); return g.committed.has(k) || (g.dirty.has(k) && mtimeIn(f)); } : mtimeIn;
  return cands.filter((f) => inWindow(f));
}
/** reportsForRun({root?, runDir, events}) -> {root, reports[{file, rel, source}], notes[]} — THE one entry point. */
function reportsForRun(opts) {
  const dir = path.resolve(opts.runDir);
  const root = opts.root ? path.resolve(opts.root) : inferRoot(dir);
  const events = Array.isArray(opts.events) ? opts.events : [];
  const reports = [], notes = [], seen = new Set(), runsBase = path.dirname(dir);
  const otherRun = (f) => !outside(runsBase, f) && outside(dir, f);
  const add = (f, source) => {
    const key = keyOf(path.resolve(f));
    if (seen.has(key)) return;
    if (otherRun(f)) { notes.push(relOf(root || runsBase, f) + ' belongs to another run: judged by that run, not this one'); return; }
    seen.add(key);
    reports.push({ file: path.resolve(f), rel: relOf(root || dir, f), source });
  };
  const own = path.join(dir, REPORT_FILE);
  if (isFile(own)) add(own, 'run');
  for (const f of namedReports(root, dir, events, notes)) add(f, 'event');
  for (const f of docsReports(root, events, notes)) add(f, 'docs');
  return { root, reports, notes };
}

module.exports = { reportsForRun, changedAfter, sealCommitOf, runWindow, eventPaths, isDocsReportName, isReportName, inferRoot, REPORT_FILE };
