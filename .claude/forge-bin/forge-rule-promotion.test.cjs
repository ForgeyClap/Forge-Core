#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-rule-promotion.cjs. Every fixture project lives in its own os.mkdtemp root
 *  with a synthetic rules file and synthetic runs; the real project is never written. Prints "N passed, M failed". */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const P = require('./forge-rule-promotion.cjs');
const TOOL = path.join(__dirname, 'forge-rule-promotion.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rule-promotion-'));
const R = (id, check, more) => Object.assign({ id, rule: 'fixture rule ' + id, trigger: 'always', check, severity: 'warn', override: 'owner_override rule:' + id, source: 'test fixture' }, more || {});
const RULES = [
  R('core-block', { type: 'event-present', key: 'run_started' }, { severity: 'block', override: 'UN-OVERRIDABLE — honesty core', cannot_override: true }),
  R('thing-done', { type: 'event-present', key: 'thing_done' }, { since: '2026-10-09', phase: 'complete' }),
  R('web-shot', { type: 'event-present', key: 'browser_screenshot_captured' }, { since: '2026-10-09', trigger: 'web' }),
  R('if-exists', { type: 'event-present', key: 'thing_done' }, { since: '2026-10-09', applies_if_exists: '.claude/not-here.jsonl' }),
  R('future-type', { type: 'brand-new-check', whatever: true }, { since: '2026-10-09' }),
  R('old-warn', { type: 'event-present', key: 'thing_done' }), // warn without since: not a promotion target
];

let n = 0;
function mkRoot(rules) {
  const root = path.join(BASE, 'p' + (++n));
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({ version: 2, owners_allowlist: ['owner'], rules: rules || RULES }), 'utf8');
  return root;
}
/** run(root, id, day, opts): a real run started on 2026-10-<day>; opts.done adds thing_done, opts.open leaves it
 *  without completion, opts.domain writes run.json with that domain, opts.noStart omits run_started. */
function run(root, id, day, opts) {
  opts = opts || {};
  const dir = path.join(root, '.claude', 'forge-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.parse('2026-10-' + String(day).padStart(2, '0') + 'T10:00:00Z');
  const evs = [];
  if (!opts.noStart) evs.push({ event_type: 'run_started', task: 'fixture' });
  evs.push({ event_type: 'agent_note', note: 'work' });
  if (opts.done) evs.push({ event_type: 'thing_done' });
  if (!opts.open) evs.push({ event_type: 'run_completed' });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), evs.map((e, i) => JSON.stringify(Object.assign({ timestamp: new Date(base + i * 1000).toISOString() }, e))).join('\n') + '\n', 'utf8');
  if (opts.domain) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run_id: id, domain: opts.domain }), 'utf8');
}
const ruleOf = (rep, id) => rep.rules.find((r) => r.id === id) || {};

console.log('forge-rule-promotion tests (hermetic base=' + BASE + ')');

// 1) satisfied -> READY; exempt, test, unfinished and non-real runs are never counted
{
  const root = mkRoot();
  run(root, 'forge-2026-10-10-a', 10, { done: true });
  run(root, 'forge-2026-10-11-b', 11, { done: true });
  run(root, 'forge-2026-10-12-c', 12, { done: true });
  run(root, 'forge-2026-10-01-old', 1, {});            // historical-exempt (before since), violates
  run(root, 'fx-7', 13, {});                            // test fixture id, violates
  run(root, 'forge-testrun-2', 13, {});                 // test fixture id, violates
  run(root, 'selftest-run', 13, {});                    // test fixture id, violates
  run(root, 'forge-2026-10-13-open', 13, { open: true }); // not completed, violates
  run(root, 'forge-2026-10-13-nostart', 13, { noStart: true }); // no run.json, no run_started: not real
  const rep = P.evaluate({ root });
  const r = ruleOf(rep, 'thing-done');
  t('satisfied: 3 applicable satisfied runs -> READY', r.verdict === 'READY' && r.window.length === 3 && r.violations.length === 0, JSON.stringify(r));
  t('historical-exempt run (before since) is not judged', rep.runs.exempt_for_all.includes('forge-2026-10-01-old') && !r.window.some((w) => w.run_id === 'forge-2026-10-01-old'));
  t('test-run ids (fx-, testrun, selftest) are ignored', ['fx-7', 'forge-testrun-2', 'selftest-run'].every((id) => rep.runs.ignored_test.includes(id)), JSON.stringify(rep.runs));
  t('unfinished run is not counted', rep.runs.not_completed.includes('forge-2026-10-13-open'));
  t('a folder without run.json or run_started is not a real run', rep.runs.not_real.includes('forge-2026-10-13-nostart'));
  t('only warn rules with a since date are listed', !rep.rules.some((x) => x.id === 'core-block' || x.id === 'old-warn') && rep.rules.length === 4);
  t('honesty core lists cannot_override rules', rep.honesty_core.length === 1 && rep.honesty_core[0] === 'core-block');
  t('unknown check type -> UNEVALUATED, never READY', ruleOf(rep, 'future-type').verdict === 'UNEVALUATED' && /brand-new-check/.test(ruleOf(rep, 'future-type').reason), JSON.stringify(ruleOf(rep, 'future-type')));
  t('applies_if_exists absent -> every run not-applicable -> INSUFFICIENT DATA', ruleOf(rep, 'if-exists').verdict === 'INSUFFICIENT DATA' && ruleOf(rep, 'if-exists').not_applicable_runs.length === 3);
  const plan = P.planFrom(rep);
  t('plan: READY rule gets exactly one severity edit warn -> block', plan.writes === false && plan.edits.length === 1 && plan.edits[0].rule_id === 'thing-done' && plan.edits[0].from === 'warn' && plan.edits[0].to === 'block');
  t('plan: effect on last N runs all still pass', plan.edits[0].effect.length === 3 && plan.edits[0].effect.every((e) => e.still_passes));
  t('plan: unevaluated/insufficient rules are not promoted', plan.not_promoted.some((x) => x.rule_id === 'future-type' && x.verdict === 'UNEVALUATED'));
  const txt = P.formatPlan(plan);
  t('plan text names the edit, the honesty core and says nothing is written', /rules\[id="thing-done"\]\.severity: "warn" -> "block"/.test(txt) && /Honesty core.*core-block/.test(txt) && /nothing is written/.test(txt));
  const rtxt = P.formatReport(rep);
  t('report text is one table within 40 lines', rtxt.split('\n').length <= 40 && /READY/.test(rtxt) && /UNEVALUATED/.test(rtxt));
}

// 2) violated -> NOT READY with the failing run and the checker's reason
{
  const root = mkRoot();
  run(root, 'forge-2026-10-10-a', 10, { done: true });
  run(root, 'forge-2026-10-11-b', 11, { done: true });
  run(root, 'forge-2026-10-12-bad', 12, {});
  const r = ruleOf(P.evaluate({ root }), 'thing-done');
  t('violated: newest run misses it -> NOT READY', r.verdict === 'NOT READY' && r.violations.length === 1 && r.violations[0].run_id === 'forge-2026-10-12-bad', JSON.stringify(r));
  t('violated: a reason string is carried', typeof r.violations[0].reason === 'string' && r.violations[0].reason.length > 0);
  const plan = P.planFrom(P.evaluate({ root }));
  t('plan: NOT READY rule produces no edit', !plan.edits.some((e) => e.rule_id === 'thing-done'));
}

// 3) insufficient: fewer than N applicable runs
{
  const root = mkRoot();
  run(root, 'forge-2026-10-10-a', 10, { done: true });
  run(root, 'forge-2026-10-11-b', 11, { done: true });
  const r = ruleOf(P.evaluate({ root }), 'thing-done');
  t('insufficient: 2 satisfied runs with window 3 -> INSUFFICIENT DATA', r.verdict === 'INSUFFICIENT DATA' && r.applicable_count === 2);
  t('--window 2 makes the same evidence READY', ruleOf(P.evaluate({ root, window: 2 }), 'thing-done').verdict === 'READY');
}

// 4) window: an older violation outside the last N does not block
{
  const root = mkRoot();
  run(root, 'forge-2026-10-10-bad', 10, {});
  run(root, 'forge-2026-10-11-a', 11, { done: true });
  run(root, 'forge-2026-10-12-b', 12, { done: true });
  run(root, 'forge-2026-10-13-c', 13, { done: true });
  const r = ruleOf(P.evaluate({ root }), 'thing-done');
  t('window: only the 3 most recent applicable runs count', r.verdict === 'READY' && !r.window.some((w) => w.run_id === 'forge-2026-10-10-bad') && r.window[0].run_id === 'forge-2026-10-13-c', JSON.stringify(r.window));
}

// 5) not-applicable runs are skipped, not counted (web trigger)
{
  const root = mkRoot();
  run(root, 'forge-2026-10-10-w1', 10, { domain: 'website' });
  run(root, 'forge-2026-10-11-api', 11, { domain: 'api', done: true });
  run(root, 'forge-2026-10-12-api', 12, { domain: 'api', done: true });
  const r = ruleOf(P.evaluate({ root }), 'web-shot');
  t('not-applicable: non-web runs skipped; the one web run violated -> NOT READY', r.verdict === 'NOT READY' && r.not_applicable_runs.length === 2 && r.applicable_count === 1, JSON.stringify(r));
}

// 6) a rules file whose only target has an unknown check type: UNEVALUATED even with plenty of runs
{
  const root = mkRoot([R('only-future', { type: 'zz-future-check' }, { since: '2026-10-09' })]);
  for (let d = 10; d <= 14; d++) run(root, 'forge-2026-10-' + d + '-r', d, { done: true });
  const rep = P.evaluate({ root });
  t('unknown check type with 5 runs -> UNEVALUATED, never READY', rep.rules[0].verdict === 'UNEVALUATED' && P.planFrom(rep).edits.length === 0);
}

// 7) CLI: JSON shape, plan, apply refused, usage
{
  const root = mkRoot();
  run(root, 'forge-2026-10-10-a', 10, { done: true });
  const node = process.execPath;
  const j = spawnSync(node, [TOOL, 'report', '--json', '--root', root], { encoding: 'utf8' });
  let data = null; try { data = JSON.parse(j.stdout); } catch { data = null; }
  t('CLI --json exits 0 and parses', j.status === 0 && data !== null, j.stderr);
  const shapeOk = data && data.tool === 'forge-rule-promotion' && data.window === 3 && Array.isArray(data.rules)
    && data.runs && Array.isArray(data.runs.judged) && Array.isArray(data.runs.ignored_test) && Array.isArray(data.honesty_core)
    && data.rules.every((r) => ['id', 'phase', 'since', 'severity', 'honesty_core', 'verdict', 'reason', 'applicable_count', 'window', 'violations', 'exempt_runs', 'not_applicable_runs'].every((k) => k in r))
    && data.rules.every((r) => ['READY', 'NOT READY', 'INSUFFICIENT DATA', 'UNEVALUATED'].includes(r.verdict));
  t('JSON shape has the documented fields and verdicts', shapeOk, j.stdout.slice(0, 400));
  const rulesOnly = path.join(root, 'custom-rules.json');
  fs.writeFileSync(rulesOnly, JSON.stringify({ version: 2, owners_allowlist: ['owner'], rules: [R('x', { type: 'event-present', key: 'thing_done' }, { since: '2026-10-09' })] }), 'utf8');
  const jr = spawnSync(node, [TOOL, '--json', '--root', root, '--rules', rulesOnly, '--runs-dir', path.join(root, '.claude', 'forge-runs')], { encoding: 'utf8' });
  let d2 = null; try { d2 = JSON.parse(jr.stdout); } catch { d2 = null; }
  t('--rules and --runs-dir are honoured', d2 && d2.rules.length === 1 && d2.rules[0].id === 'x' && d2.rules[0].applicable_count === 1, jr.stdout.slice(0, 300) + jr.stderr);
  const pj = spawnSync(node, [TOOL, 'plan', '--json', '--root', root], { encoding: 'utf8' });
  let pd = null; try { pd = JSON.parse(pj.stdout); } catch { pd = null; }
  t('plan --json: writes:false, edits array', pj.status === 0 && pd && pd.writes === false && Array.isArray(pd.edits));
  const before = fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8');
  spawnSync(node, [TOOL, 'plan', '--root', root], { encoding: 'utf8' });
  t('plan never changes the rules file', fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8') === before);
  const ap = spawnSync(node, [TOOL, 'apply', '--rule', 'thing-done', '--yes', '--root', root], { encoding: 'utf8' });
  t('apply is not built: exit 1 with an explanation', ap.status === 1 && /deliberately not built/.test(ap.stderr), ap.stderr);
  const h = spawnSync(node, [TOOL, '--help'], { encoding: 'utf8' });
  t('usage says there is no apply', h.status === 0 && /no `apply`/.test(h.stdout));
  const bad = spawnSync(node, [TOOL, '--window', '0'], { encoding: 'utf8' });
  t('bad --window -> exit 1', bad.status === 1);
  const txt = spawnSync(node, [TOOL, '--root', root], { encoding: 'utf8' });
  t('default text output <= 40 lines', txt.status === 0 && txt.stdout.trim().split('\n').length <= 40);
}

// 8) isTestRunId does not swallow real run ids
t('real run ids are not treated as test runs', !P.isTestRunId('forge-2026-10-09-forge-core-overhaul') && !P.isTestRunId('forge-2026-07-15-testloop') && P.isTestRunId('_testlogs'));

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
