#!/usr/bin/env node
'use strict';
/**
 * forge-rule-promotion.cjs — decides from EVIDENCE (not memory) whether a `warn` rule in FORGE_HARD_RULES.json
 * may be promoted to `block` (BLUEPRINT.md " ", migration step M6; prepared as of run
 *).
 *
 * A warn rule with a `since` date is READY only when the N most recent REAL, completed runs that the rule
 * applies to ALL satisfied it (default N = 3), with zero violations in that window. Runs the rule does not apply
 * to (trigger, applies_if_exists) and runs that started before its `since` (historical_exempt) are skipped, never
 * counted. Fewer than N applicable runs = INSUFFICIENT DATA. A rule this checker cannot judge (unknown check type
 * or trigger) = UNEVALUATED, never READY.
 *
 * Every per-run verdict comes from forge-runcontract.cjs::check() (the ONE evaluator) — nothing is re-implemented
 * here. check() is called read-only (no logEvent), so this tool writes nothing anywhere.
 *
 * Which runs count:
 *   - a folder under the runs dir that has run.json or a run_started event (a real run),
 *   - completed: a run-finalized.json file, or a run_completed / run_finalized event,
 *   - not a fixture/test run: names starting with "_" or ".", or matching TEST_RUN_RE (the ids test suites use).
 *
 * CLI:
 *   node forge-rule-promotion.cjs [report] [--json] [--window N] [--rules <file>] [--runs-dir <dir>] [--root <dir>] [--verbose]
 *   node forge-rule-promotion.cjs plan     [--json] [same options]
 *   exit 0 = evaluated (whatever the verdicts) · 1 = could not run (bad args, unreadable rules file)
 * There is deliberately NO `apply`: promotion stays a deliberate, reviewed edit of FORGE_HARD_RULES.json with its
 * own commit. `plan` only prints the exact edit.
 */
const fs = require('fs');
const path = require('path');
const RC = require('./forge-runcontract.cjs');

// WP 2.1 (opt-in .forge layout): without --runs-dir the runs are discovered in EVERY run folder that exists
// (forge-paths.cjs existingStateDirs; a project without .forge reads exactly .claude/forge-runs as before). The rules
// file is config and stays in .claude/config/orchestration. Guarded: an older or missing forge-paths.cjs keeps the
// legacy literals. A plugin copy outside any project has no default root (evaluate() then refuses).
const forgePaths = (() => { try { const m = require('./forge-paths.cjs'); return m && typeof m.existingStateDirs === 'function' && typeof m.scriptRoot === 'function' ? m : null; } catch { return null; } })();
function viaForgePaths(fn, legacy) { if (forgePaths) { try { return fn(forgePaths); } catch { /* unresolvable root or canon: legacy */ } } return legacy(); }
const DEFAULT_ROOT = viaForgePaths((P) => P.scriptRoot(__dirname), () => path.resolve(__dirname, '..', '..'));
const DEFAULT_WINDOW = 3;
const MAX_DEFAULT_LINES = 40;
/** Run ids the project's own test suites use for fixtures (fx-1, forge-testrun-…, selftest-…, tmp-…, e2e-…). */
const TEST_RUN_RE = /(^|[-_.])(test|tests|testrun|selftest|fixture|fixtures|fx|tmp|e2e)([-_.0-9]|$)/i;

const USAGE = [
  'Usage: node forge-rule-promotion.cjs [report|plan] [--json] [--window N] [--rules <file>] [--runs-dir <dir>] [--root <dir>] [--verbose]',
  '  report (default)  per warn rule with a `since` date: READY / NOT READY / INSUFFICIENT DATA / UNEVALUATED,',
  '                    judged by forge-runcontract.cjs over the N most recent real, completed, applicable runs.',
  '  plan              the exact FORGE_HARD_RULES.json edit promoting the READY rules would make (warn -> block),',
  '                    the expected effect on the last N runs, and the honesty-core exclusions. Writes nothing.',
  '  There is no `apply`: promoting a rule stays a deliberate, reviewed edit of FORGE_HARD_RULES.json with its own commit.',
].join('\n');

function parseArgs(argv) {
  const o = { cmd: 'report', json: false, window: DEFAULT_WINDOW, rules: null, runsDir: null, root: null, verbose: false };
  const rest = argv.slice();
  if (rest[0] && !rest[0].startsWith('-')) o.cmd = rest.shift();
  if (o.cmd === 'apply') throw new Error('apply is deliberately not built — promotion is a reviewed edit of FORGE_HARD_RULES.json with its own commit; use `plan` to see the exact edit');
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => { const v = rest[++i]; if (v === undefined || v.startsWith('--')) throw new Error(a + ' needs a value'); return v; };
    if (a === '--json') o.json = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--window') {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('--window must be a whole number from 1 to 50');
      o.window = n;
    } else if (a === '--rules') o.rules = val();
    else if (a === '--runs-dir') o.runsDir = val();
    else if (a === '--root') o.root = val();
    else if (a === '--help' || a === '-h') o.cmd = 'help';
    else throw new Error('unknown option ' + a);
  }
  if (!['report', 'plan', 'help'].includes(o.cmd)) throw new Error('unknown command "' + o.cmd + '"');
  return o;
}

/** Lenient line parse, used ONLY to find candidate runs, their start time and completion. The verdict itself
 *  always comes from RC.check(), which reads the log strictly (hash chain included). */
function looseEvents(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch { /* strict read in check() reports it */ }
  }
  return out;
}
const typeOf = (e) => String(e.event_type || e.type || e.event || '');

function isTestRunId(id) {
  return id.startsWith('_') || id.startsWith('.') || TEST_RUN_RE.test(id);
}

/** discoverRuns(runsDir) -> {candidates:[{id, dir, startMs}], ignored_test, not_real, not_completed} */
function discoverRuns(runsDir) {
  const res = { candidates: [], ignored_test: [], not_real: [], not_completed: [] };
  let entries = [];
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return res; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    if (isTestRunId(id)) { res.ignored_test.push(id); continue; }
    const dir = path.join(runsDir, id);
    const events = looseEvents(path.join(dir, 'events.jsonl'));
    let runMeta = null;
    try { runMeta = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch { runMeta = null; }
    const hasRunJson = fs.existsSync(path.join(dir, 'run.json'));
    if (!hasRunJson && !events.some((e) => typeOf(e) === 'run_started')) { res.not_real.push(id); continue; }
    const completed = fs.existsSync(path.join(dir, 'run-finalized.json'))
      || events.some((e) => typeOf(e) === 'run_completed' || typeOf(e) === 'run_finalized');
    if (!completed) { res.not_completed.push(id); continue; }
    const start = RC.runStartedAt(events, runMeta);
    res.candidates.push({ id, dir, startMs: start ? start.ms : null });
  }
  // newest first; an undatable run sorts last (it is exempt from every warn rule with a `since` anyway)
  res.candidates.sort(newestFirst);
  return res;
}
function newestFirst(a, b) { return (b.startMs === null ? -Infinity : b.startMs) - (a.startMs === null ? -Infinity : a.startMs) || (a.id < b.id ? 1 : -1); }
/** discoverRunsIn(dirs) — WP 2.1: discoverRuns over several run folders (active first; a run id found in an earlier
 *  folder wins), merged and sorted like one. One folder -> exactly discoverRuns(dir). */
function discoverRunsIn(dirs) {
  if (dirs.length === 1) return discoverRuns(dirs[0]);
  const out = { candidates: [], ignored_test: [], not_real: [], not_completed: [] };
  const seen = new Set();
  for (const d of dirs) {
    const r = discoverRuns(d);
    const ids = new Set();
    for (const k of Object.keys(out)) {
      for (const x of r[k]) {
        const id = typeof x === 'string' ? x : x.id;
        if (seen.has(id)) continue;
        ids.add(id);
        out[k].push(x);
      }
    }
    for (const id of ids) seen.add(id);
  }
  out.candidates.sort(newestFirst);
  return out;
}

/** statusOf(result, ruleId) -> {status, reason} for one rule on one check() result. */
function statusOf(result, ruleId) {
  const det = (result.rule_details || {})[ruleId] || {};
  const why = (fallback) => (typeof det.reason === 'string' && det.reason ? det.reason : fallback);
  const ex = (result.historical_exempt || []).find((x) => x.id === ruleId);
  if (ex) return { status: 'exempt', reason: ex.reason };
  if ((result.phase_deferred || []).includes(ruleId)) return { status: 'not-applicable', reason: 'phase not due' };
  const un = (result.unevaluated || []).find((x) => x.id === ruleId);
  if (un) return un.applicable === false ? { status: 'not-applicable', reason: un.reason } : { status: 'unevaluated', reason: un.reason };
  if ((result.satisfied || []).includes(ruleId)) return { status: 'satisfied', reason: null };
  if ((result.warnings || []).includes(ruleId) || (result.missing || []).includes(ruleId) || (result.missing || []).includes('unknown-rule:' + ruleId)) {
    return { status: 'violated', reason: why('rule not met (no detail reported by the checker)') };
  }
  const ov = (result.overridden || []).find((x) => x.id === ruleId);
  if (ov) return { status: 'violated', reason: 'not met; cleared only by an owner override (' + ov.reason + ')' };
  const na = (result.not_applicable || []).find((x) => x.id === ruleId);
  if (na) return { status: 'not-applicable', reason: na.reason };
  return { status: 'not-applicable', reason: 'the rule trigger does not apply to this run' };
}

/** evaluate(opts) -> the full JSON report (see the test for the shape). Throws only when the rules file cannot be read. */
function evaluate(opts) {
  opts = opts || {};
  if (!opts.root && !DEFAULT_ROOT) throw new Error('no project root found (this copy is not inside a project) — pass --root <dir>');
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const rulesPath = path.resolve(opts.rules || path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const activeRuns = viaForgePaths((P) => P.stateDir(root, 'runs'), () => path.join(root, '.claude', 'forge-runs'));
  const runsDir = path.resolve(opts.runsDir || activeRuns);
  const runsDirs = opts.runsDir ? [runsDir] : viaForgePaths((P) => { const d = P.existingStateDirs(root, 'runs'); return d.length ? d : [runsDir]; }, () => [runsDir]);
  const N = opts.window || DEFAULT_WINDOW;

  const meta = RC.loadRulesMeta(rulesPath);
  const allRules = meta.data.rules;
  const unknownIds = new Map();
  for (const u of meta.unknownTriggers || []) unknownIds.set(u.id, 'unknown trigger "' + u.trigger + '"');
  for (const u of meta.unknownCheckTypes || []) unknownIds.set(u.id, 'check type "' + u.check_type + '" ' + (u.reason ? 'uses an option this checker does not know (' + u.reason + ')' : 'is unknown to forge-runcontract.cjs'));
  const targets = allRules.filter((r) => r.severity === 'warn' && r.since !== undefined);
  const honestyCore = allRules.filter((r) => r.cannot_override === true).map((r) => r.id);

  const disc = discoverRunsIn(runsDirs);
  const minSince = targets.reduce((m, r) => { const s = RC.sinceMs(r.since); return s !== null && s < m ? s : m; }, Infinity);
  const judged = [];
  const unreadable = [];
  const exemptAll = [];
  for (const c of disc.candidates) {
    // cheap skip: a run that provably started before every target's `since` is historical-exempt for all of them
    if (c.startMs !== null && c.startMs < minSince) { exemptAll.push(c.id); continue; }
    try {
      const result = RC.check({ run_id: c.id }, { root, runDir: c.dir, rulesPath });
      judged.push({ id: c.id, startMs: c.startMs, started_at: result.run_started_at, result });
    } catch (e) {
      unreadable.push({ run_id: c.id, reason: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  }

  const rules = targets.map((rule) => {
    const perRun = judged.map((j) => Object.assign({ run_id: j.id, started_at: j.started_at }, statusOf(j.result, rule.id)));
    const applicable = perRun.filter((p) => p.status === 'satisfied' || p.status === 'violated' || p.status === 'unevaluated');
    const window = applicable.slice(0, N);
    const violations = window.filter((p) => p.status === 'violated').map((p) => ({ run_id: p.run_id, reason: p.reason }));
    let verdict; let reason;
    if (unknownIds.has(rule.id)) { verdict = 'UNEVALUATED'; reason = 'forge-runcontract.cjs cannot judge this rule: ' + unknownIds.get(rule.id) + ' — sync the checker first'; }
    else if (window.some((p) => p.status === 'unevaluated')) { verdict = 'UNEVALUATED'; reason = 'the checker could not judge it on ' + window.filter((p) => p.status === 'unevaluated').map((p) => p.run_id).join(', '); }
    else if (violations.length) { verdict = 'NOT READY'; reason = violations.length + ' of the last ' + window.length + ' applicable run(s) violated it'; }
    else if (window.length < N) { verdict = 'INSUFFICIENT DATA'; reason = 'only ' + window.length + ' applicable real completed run(s) since ' + rule.since + ', need ' + N; }
    else { verdict = 'READY'; reason = 'the last ' + N + ' applicable runs all satisfied it'; }
    return {
      id: rule.id, phase: rule.phase || 'complete', since: rule.since, severity: rule.severity,
      honesty_core: rule.cannot_override === true, verdict, reason,
      applicable_count: applicable.length, window, violations,
      exempt_runs: perRun.filter((p) => p.status === 'exempt').map((p) => p.run_id),
      not_applicable_runs: perRun.filter((p) => p.status === 'not-applicable').map((p) => p.run_id),
    };
  });

  return {
    tool: 'forge-rule-promotion', window: N, rules_path: rulesPath, runs_dir: runsDir,
    runs: {
      judged: judged.map((j) => j.id), exempt_for_all: exemptAll, unreadable,
      ignored_test: disc.ignored_test, not_real: disc.not_real, not_completed: disc.not_completed,
    },
    honesty_core: honestyCore,
    rules,
  };
}

/** planFrom(report) -> the edit promotion would make; nothing is written. */
function planFrom(report) {
  const ready = report.rules.filter((r) => r.verdict === 'READY');
  return {
    tool: 'forge-rule-promotion', mode: 'plan', writes: false, rules_path: report.rules_path, window: report.window,
    edits: ready.map((r) => ({
      rule_id: r.id, file: report.rules_path, field: 'severity', from: r.severity, to: 'block',
      effect: r.window.map((w) => ({ run_id: w.run_id, still_passes: w.status === 'satisfied' })),
    })),
    not_promoted: report.rules.filter((r) => r.verdict !== 'READY').map((r) => ({ rule_id: r.id, verdict: r.verdict, reason: r.reason })),
    honesty_core: report.honesty_core,
  };
}

const short = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };

function formatReport(rep, verbose) {
  const lines = [];
  lines.push('Rule promotion check (warn -> block needs the last ' + rep.window + ' applicable real runs all satisfied)');
  lines.push('Runs judged: ' + rep.runs.judged.length + ' · older than every rule: ' + rep.runs.exempt_for_all.length
    + ' · not completed: ' + rep.runs.not_completed.length + ' · test/fixture ignored: ' + rep.runs.ignored_test.length
    + ' · unreadable: ' + rep.runs.unreadable.length);
  lines.push('');
  const W = [28, 9, 11, 18, 9];
  lines.push(pad('Rule', W[0]) + pad('Phase', W[1]) + pad('Since', W[2]) + pad('Verdict', W[3]) + pad('Window', W[4]) + 'Why');
  lines.push('-'.repeat(W.reduce((a, b) => a + b, 0) + 30));
  for (const r of rep.rules) {
    const ok = r.window.filter((w) => w.status === 'satisfied').length;
    lines.push(pad(short(r.id, W[0] - 1), W[0]) + pad(r.phase, W[1]) + pad(r.since, W[2]) + pad(r.verdict, W[3])
      + pad(ok + '/' + r.window.length + ' ok', W[4]) + short(r.reason, verbose ? 400 : 70));
  }
  if (!rep.rules.length) lines.push('(no warn rule with a `since` date in ' + rep.rules_path + ')');
  const details = [];
  for (const r of rep.rules) for (const v of r.violations) details.push('  ' + r.id + ' @ ' + v.run_id + ': ' + short(v.reason, verbose ? 400 : 110));
  for (const u of rep.runs.unreadable) details.push('  unreadable run ' + u.run_id + ': ' + short(u.reason, verbose ? 400 : 110));
  if (details.length) {
    lines.push('');
    lines.push('Failing runs:');
    const room = verbose ? details.length : Math.max(1, MAX_DEFAULT_LINES - lines.length - 2);
    lines.push(...details.slice(0, room));
    if (details.length > room) lines.push('  … ' + (details.length - room) + ' more (use --verbose or --json)');
  }
  lines.push('');
  lines.push('Nothing was written. Promotion is a reviewed edit of FORGE_HARD_RULES.json with its own commit (see `plan`).');
  return lines.join('\n');
}

function formatPlan(plan) {
  const lines = [];
  lines.push('Promotion plan (dry run — nothing is written; there is no apply command)');
  lines.push('File: ' + plan.rules_path);
  if (!plan.edits.length) lines.push('No rule is READY, so no edit would be made.');
  for (const e of plan.edits) {
    lines.push('  rules[id="' + e.rule_id + '"].severity: "' + e.from + '" -> "' + e.to + '"');
    const passing = e.effect.filter((x) => x.still_passes).length;
    lines.push('    effect on the last ' + e.effect.length + ' applicable runs: ' + passing + '/' + e.effect.length + ' would still pass (' + e.effect.map((x) => x.run_id).join(', ') + ')');
  }
  if (plan.not_promoted.length) lines.push('Not promoted: ' + plan.not_promoted.map((n) => n.rule_id + ' (' + n.verdict + ')').join(', '));
  lines.push('Honesty core (cannot_override:true, never cleared by an owner override; promotion never changes that): '
    + (plan.honesty_core.length ? plan.honesty_core.join(', ') : 'none'));
  lines.push('A promoted rule keeps its `override` and `cannot_override` fields exactly as they are.');
  return lines.join('\n');
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error('forge-rule-promotion: ' + e.message + '\n' + USAGE); return 1; }
  if (o.cmd === 'help') { console.log(USAGE); return 0; }
  let rep;
  try { rep = evaluate(o); } catch (e) { console.error('forge-rule-promotion: could not run: ' + (e && e.message ? e.message : e)); return 1; }
  if (o.cmd === 'plan') {
    const plan = planFrom(rep);
    console.log(o.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
  } else {
    console.log(o.json ? JSON.stringify(rep, null, 2) : formatReport(rep, o.verbose));
  }
  return 0;
}

module.exports = { evaluate, planFrom, formatReport, formatPlan, discoverRuns, statusOf, isTestRunId, parseArgs, TEST_RUN_RE, DEFAULT_WINDOW, USAGE };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
