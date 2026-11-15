#!/usr/bin/env node
'use strict';
// forge-skill-use.cjs - SD-T11: how often each skill was really used, measured from the hook lines.
//   Reads .claude/forge-runs/_hooks/subagent-start.jsonl (`skills_preloaded`, the skills: preload of the agent file)
//   and subagent-stop.jsonl (`skills_opened`, the skills the agent's own transcript opened). Only lines that carry a
//   `run` id count; the window is the last N runs (default 10), ordered by each run's latest line. Read-only.
//   hookWindow() exposes the raw lines of that window (SD-T12c).
//   A start line without `skills_preloaded` (written before that field existed) leaves preloads NOT MEASURED.
//
//   node forge-skill-use.cjs [--root <dir>] [--last N] [--json]
const fs = require('fs');
const path = require('path');

const HOOKS_REL = ['.claude', 'forge-runs', '_hooks'];
// FB-SKILLTOOLS-F9: the hook writers use forge-paths stateDir(root,'runs')/_hooks (.forge/runs in the forge layout);
// read the same folder, and keep the legacy path when forge-paths is missing or cannot resolve.
function defaultHooksDir(root) {
  try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.stateDir === 'function') return path.join(fp.stateDir(root, 'runs'), '_hooks'); } catch { /* legacy below */ }
  return path.join(root, ...HOOKS_REL);
}
const DEFAULT_LAST_RUNS = 10;
const MAX_NAME = 200;
const USE_STATUSES = ['used', 'unused-in-runs', 'not-measured'];

function readLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && typeof j === 'object' && typeof j.run === 'string' && j.run) out.push(j); } catch { /* a torn or foreign line is skipped, never fatal */ }
  }
  return out;
}

/** names(list) -> the distinct, sane skill names in one line's array (a skill named twice in a line counts once). */
function names(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const n of list) if (typeof n === 'string' && n.trim() && n.length <= MAX_NAME) seen.add(n.trim());
  return [...seen];
}

function lastRunsOf(lines, n) {
  const latest = new Map();
  for (const l of lines) {
    const ts = typeof l.ts === 'string' ? l.ts : '';
    if (!latest.has(l.run) || ts > latest.get(l.run)) latest.set(l.run, ts);
  }
  return [...latest.entries()].sort((a, b) => (b[1] < a[1] ? -1 : b[1] > a[1] ? 1 : a[0].localeCompare(b[0]))).slice(0, n).map((e) => e[0]);
}

/** hookWindow(root, {lastRuns, hooksDir}) -> {runs, starts, stops}: the parsed start and stop lines (with a run id) of
 *  the last N runs, in file order (SD-T12c: the doctor's measured-delivery check joins them per agent). Never throws. */
function hookWindow(root, opts) {
  const o = opts || {};
  const last = Number.isInteger(o.lastRuns) && o.lastRuns > 0 ? o.lastRuns : DEFAULT_LAST_RUNS;
  const dir = o.hooksDir || defaultHooksDir(root || '.');
  const starts = readLines(path.join(dir, 'subagent-start.jsonl'));
  const stops = readLines(path.join(dir, 'subagent-stop.jsonl'));
  const runs = lastRunsOf(starts.concat(stops), last);
  const inWindow = new Set(runs);
  return { runs, starts: starts.filter((l) => inWindow.has(l.run)), stops: stops.filter((l) => inWindow.has(l.run)) };
}

/** skillUseReport(root, {lastRuns, hooksDir}) -> {measured, preload_measured, runs, lines:{start, stop}, map}.
 *  map: Map<skill, {preloaded, opened, runs}>. Never throws on missing or malformed files. */
function skillUseReport(root, opts) {
  const { runs, starts: s, stops: e } = hookWindow(root, opts);
  const acc = new Map();
  const get = (k) => { if (!acc.has(k)) acc.set(k, { preloaded: 0, opened: 0, runSet: new Set() }); return acc.get(k); };
  for (const l of s) for (const k of names(l.skills_preloaded)) { const a = get(k); a.preloaded++; a.runSet.add(l.run); }
  for (const l of e) for (const k of names(l.skills_opened)) { const a = get(k); a.opened++; a.runSet.add(l.run); }
  const map = new Map([...acc.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, a]) => [k, { preloaded: a.preloaded, opened: a.opened, runs: a.runSet.size }]));
  return {
    measured: s.length + e.length > 0,
    preload_measured: s.some((l) => Array.isArray(l.skills_preloaded)),
    runs, lines: { start: s.length, stop: e.length }, map,
  };
}

/** skillUse(root, {lastRuns}) -> Map<skill, {preloaded, opened, runs}> (the plan's interface). */
function skillUse(root, opts) { return skillUseReport(root, opts).map; }

/** useFor(name, report) -> the registry `use` value for one skill: {preloaded, opened, runs, status, preload_measured}. */
function useFor(name, report) {
  const r = report || { measured: false, preload_measured: false, map: new Map() };
  const c = r.map.get(name) || { preloaded: 0, opened: 0, runs: 0 };
  const status = !r.measured ? 'not-measured' : (c.preloaded + c.opened > 0 ? 'used' : 'unused-in-runs');
  return { preloaded: c.preloaded, opened: c.opened, runs: c.runs, status, preload_measured: r.preload_measured === true };
}

function findRoot(start) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, '.claude'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function main(argv) {
  let root = null, last = DEFAULT_LAST_RUNS, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) root = argv[++i];
    else if (a === '--last' && argv[i + 1]) { last = parseInt(argv[++i], 10); if (!(last > 0)) { process.stderr.write('--last needs a positive number\n'); return 2; } }
    else if (a === '--json') json = true;
    else { process.stderr.write('usage: forge-skill-use.cjs [--root <dir>] [--last N] [--json]\n'); return 2; }
  }
  root = root ? path.resolve(root) : findRoot(process.cwd());
  if (!root) { process.stderr.write('forge-skill-use: no project root found (no .claude above the current folder) - pass --root <dir>\n'); return 2; }
  const r = skillUseReport(root, { lastRuns: last });
  if (json) {
    process.stdout.write(JSON.stringify({ measured: r.measured, preload_measured: r.preload_measured, runs: r.runs, lines: r.lines, skills: Object.fromEntries(r.map) }, null, 2) + '\n');
    return 0;
  }
  const L = ['skill use, last ' + last + ' runs: ' + r.runs.length + ' run(s), ' + r.lines.start + ' start line(s), ' + r.lines.stop + ' stop line(s), ' + r.map.size + ' skill(s) seen'
    + (r.measured ? '' : ' - NOT MEASURED (no hook lines)') + (r.measured && !r.preload_measured ? ' - preloads not measured (no start line has skills_preloaded)' : '')];
  for (const [k, c] of r.map) L.push('  ' + k + ': preloaded ' + c.preloaded + ', opened ' + c.opened + ', runs ' + c.runs);
  process.stdout.write(L.join('\n') + '\n');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { skillUse, skillUseReport, hookWindow, useFor, main, HOOKS_REL, DEFAULT_LAST_RUNS, USE_STATUSES };
