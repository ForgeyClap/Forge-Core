#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-doctor-retry.test.cjs — SD-FLAKE. After the pooled (or sequential) pass the doctor re-runs every
 * red suite ONCE, alone and sequentially. A suite that passes on that retry counts as passing but is listed as flaky
 * (result, text report, --json, receipt); a suite that fails again stays red with both attempts' test names; more
 * than 5 red suites is breakage, not flakiness (no retry); FORGE_DOCTOR_RETRY=0 is strict mode (no retry).
 * Fixture suites keep their attempt count in a marker file inside their own hermetic root (never the suite's private
 * TEMP, which is removed after each attempt). One temp folder for everything, removed at the end.
 * Harness: this project's ok/FAIL lines + trailing "N passed, M failed" tally (runTests reads it).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const D = require('./forge-doctor.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-retry-'));
let pass = 0, fail = 0, seq = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); }
};

function mkRoot() {
  const r = path.join(TMP, 'r' + (++seq));
  fs.mkdirSync(path.join(r, '.claude', 'forge-bin'), { recursive: true });
  return r;
}
const put = (r, name, src) => fs.writeFileSync(path.join(r, '.claude', 'forge-bin', name + '.test.cjs'), src);
const PASS_SRC = "console.log('  ok  fine');\nconsole.log('2 passed, 0 failed');\n";
/** attempt-counting suite: `first` runs on attempt 1, `later` on every attempt after it. */
const counted = (r, name, first, later) => put(r, name,
  "const fs = require('fs');\nconst m = " + JSON.stringify(path.join(r, name + '.attempts')) + ";\n" +
  "let n = 0; try { n = Number(fs.readFileSync(m, 'utf8')) || 0; } catch { n = 0; }\n" +
  "fs.writeFileSync(m, String(n + 1));\n" +
  'if (n === 0) {\n' + first + '\n} else {\n' + later + '\n}\n');
const attempts = (r, name) => { try { return Number(fs.readFileSync(path.join(r, name + '.attempts'), 'utf8')); } catch { return 0; } };
const FAIL_ONCE = "console.log('  FAIL first-run case under load'); console.log('1 passed, 1 failed'); process.exit(1);";
const FAIL_AGAIN = "console.log('  FAIL second-run case still broken'); console.log('1 passed, 1 failed'); process.exit(1);";
const PASS_NOW = "console.log('3 passed, 0 failed');";
const HANG = 'for (;;) {}';
const byName = (rep, n) => (rep.perSuite || []).find((s) => s.suite === n) || {};
const flakyOf = (rep, n) => (Array.isArray(rep.flaky) ? rep.flaky : []).find((f) => f.suite === n + '.test.cjs');
const summaryOf = (rep) => D.printSummary({ ok: rep.ok, root: 'fixture', checks: fakeChecks(rep), advisory: {} });
function fakeChecks(tests) {
  // printSummary reads a handful of other checks; give it the smallest honest shape.
  return {
    node_check: { ok: true, total: 1 }, tests, strict_events: { ok: true, known_accepted: true, unknown_rejected: true },
    dashboard_spa: { ok: true, present: [] }, leak_scan: { ok: true, files: 0, hits: [] },
  };
}
const withEnv = (key, val, fn) => {
  const saved = process.env[key];
  if (val === undefined) delete process.env[key]; else process.env[key] = val;
  try { return fn(); } finally { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; }
};

// make sure a strict-mode value from the caller's shell cannot leak into the cases that expect the retry
delete process.env.FORGE_DOCTOR_RETRY;

for (const mode of [{ label: 'pool', jobs: 3 }, { label: 'sequential', jobs: 1 }]) {
  // 1) fails first, passes on the retry -> green, listed as flaky, warning line in the text report
  const R1 = mkRoot();
  put(R1, 'a-ok', PASS_SRC);
  counted(R1, 'b-flaky', FAIL_ONCE, PASS_NOW);
  const r1 = D.runTests(R1, { jobs: mode.jobs, timeoutMs: 60000, durationsFile: path.join(R1, 'd.json') });
  const f1 = flakyOf(r1, 'b-flaky');
  t(mode.label + ': a suite that fails once and passes alone on the retry is green overall', r1.ok === true && r1.suitesFailed === 0 && r1.suitesBlocked === 0 && byName(r1, 'b-flaky.test.cjs').ok === true, JSON.stringify(r1));
  t(mode.label + ': the flaky suite ran exactly twice (pass + one retry) and the green suite once', attempts(R1, 'b-flaky') === 2);
  t(mode.label + ': the flaky suite is listed with its first attempt and the retry', !!f1 && f1.first && f1.first.failed === 1 && f1.first.timedOut === false
    && Array.isArray(f1.first.failures) && /first-run case under load/.test(f1.first.failures[0]) && f1.retry && f1.retry.passed === 3 && f1.retry.failed === 0, JSON.stringify(r1.flaky));
  t(mode.label + ': the perSuite entry is marked flaky (never silently green)', byName(r1, 'b-flaky.test.cjs').flaky === true);
  t(mode.label + ': the retry block says it ran for 1 suite', r1.retry && r1.retry.ran === true && r1.retry.retried === 1, JSON.stringify(r1.retry));
  const s1 = summaryOf(r1);
  t(mode.label + ': the text report prints one warning line naming the suite and the first attempt\'s failing test',
    /b-flaky\.test\.cjs.*passed alone on retry: flaky under load.*first-run case under load/.test(s1)
    && s1.split('\n').filter((l) => /flaky under load/.test(l)).length === 1, s1);

  // 2) fails both runs -> red, with the retry's test names and the first attempt's
  const R2 = mkRoot();
  put(R2, 'a-ok', PASS_SRC);
  counted(R2, 'b-broken', FAIL_ONCE, FAIL_AGAIN);
  const r2 = D.runTests(R2, { jobs: mode.jobs, timeoutMs: 60000, durationsFile: path.join(R2, 'd.json') });
  const e2 = byName(r2, 'b-broken.test.cjs');
  t(mode.label + ': a suite that fails the retry too stays red', r2.ok === false && r2.suitesFailed === 1 && e2.ok === false && attempts(R2, 'b-broken') === 2, JSON.stringify(r2));
  t(mode.label + ': the red suite carries the retry\'s failing test names and the first attempt\'s',
    Array.isArray(e2.failures) && /second-run case still broken/.test(e2.failures[0])
    && e2.first && Array.isArray(e2.first.failures) && /first-run case under load/.test(e2.first.failures[0]), JSON.stringify(e2));
  t(mode.label + ': a suite red on both attempts is not listed as flaky', (r2.flaky || []).length === 0 && e2.flaky !== true);
  const s2 = summaryOf(r2);
  t(mode.label + ': the text report names the retry\'s and the first attempt\'s failing tests', /second-run case still broken/.test(s2) && /first-run case under load/.test(s2), s2);

  // 3) FB-CONFIG-3-F1/F2: times out first (test-only timeoutMs seam) -> never retried, stays blocked (a hang under load is
  //    never accepted as flaky, the forge-sync rule), and it costs no second full time limit
  const R3 = mkRoot();
  put(R3, 'a-ok', PASS_SRC);
  counted(R3, 'b-slow', HANG, PASS_NOW);
  const r3 = D.runTests(R3, { jobs: mode.jobs, timeoutMs: 2500, durationsFile: path.join(R3, 'd.json') });
  t(mode.label + ': a suite that times out first is not retried and stays blocked', r3.ok === false && r3.suitesBlocked === 1 && attempts(R3, 'b-slow') === 1 && !flakyOf(r3, 'b-slow'), JSON.stringify(r3));
  t(mode.label + ': the text report says the timed-out suite was not retried', /not retried: b-slow.test.cjs.*timed out/i.test(summaryOf(r3)), summaryOf(r3));
  // 3b) FB-CONFIG-3-F1: a retry that runs fewer tests than the first attempt covered is not accepted as green
  const R3b = mkRoot();
  put(R3b, 'a-ok', PASS_SRC);
  counted(R3b, 'b-thin', "console.log('  FAIL deep case'); console.log('100 passed, 2 failed'); process.exit(1);", PASS_NOW);
  const r3b = D.runTests(R3b, { jobs: mode.jobs, durationsFile: path.join(R3b, 'd.json') });
  const e3b = byName(r3b, 'b-thin.test.cjs');
  t(mode.label + ': a retry with less coverage (3 passed after 100+2) stays red', r3b.ok === false && e3b.ok === false && e3b.flaky !== true && attempts(R3b, 'b-thin') === 2 && !flakyOf(r3b, 'b-thin'), JSON.stringify(e3b));
  t(mode.label + ': the first attempt keeps its passed count', e3b.first && e3b.first.passed === 100, JSON.stringify(e3b.first));
}

// 3c) FB-CONFIG-3-F2: the retries share one time budget; each retry gets at most what is left
{
  const S = require('./doctor/suite-retry.cjs');
  let clock = 0;
  const got = [];
  const red = (n) => ({ suite: n, ok: false, passed: 1, failed: 1, failures: ['FAIL x'] });
  const res = S.retryRedSuites([red('a'), red('b'), red('c')], (i, leftMs) => { got.push([i, leftMs]); clock += 600; return { suite: 'x', ok: true, passed: 5, failed: 0 }; }, { retryBudgetMs: 1000, now: () => clock }, {});
  t('retry budget: two retries ran, the second with the 400 ms that were left', got.length === 2 && got[0][1] === 1000 && got[1][1] === 400, JSON.stringify(got));
  t('retry budget: the third red suite is not retried and stays red, with the budget named', res.perSuite[2].ok === false && /budget/.test(res.perSuite[2].notRetried || ''), JSON.stringify(res.perSuite[2]));
}

// 4) six red suites -> breakage, not flakiness: no retry, red, one reason line
{
  const R4 = mkRoot();
  put(R4, 'a-ok', PASS_SRC);
  for (let i = 0; i < 6; i++) counted(R4, 'x' + i, FAIL_ONCE, PASS_NOW);
  const r4 = D.runTests(R4, { jobs: 3, timeoutMs: 60000, durationsFile: path.join(R4, 'd.json') });
  t('more than 5 red suites: no retry runs (every red suite ran once)', [0, 1, 2, 3, 4, 5].every((i) => attempts(R4, 'x' + i) === 1));
  t('more than 5 red suites: the verdict stays red with all six failed', r4.ok === false && r4.suitesFailed === 6 && (r4.flaky || []).length === 0, JSON.stringify(r4.retry));
  t('more than 5 red suites: the retry block says why it did not run', r4.retry && r4.retry.ran === false && /6 suites.*more than 5.*breakage/i.test(r4.retry.reason || ''), JSON.stringify(r4.retry));
  const s4 = summaryOf(r4);
  t('more than 5 red suites: the text report carries exactly one reason line', s4.split('\n').filter((l) => /breakage, not flakiness/.test(l)).length === 1, s4);
  // exactly 5 still retries
  const R5 = mkRoot();
  for (let i = 0; i < 5; i++) counted(R5, 'y' + i, FAIL_ONCE, PASS_NOW);
  const r5 = D.runTests(R5, { jobs: 3, timeoutMs: 60000, durationsFile: path.join(R5, 'd.json') });
  t('exactly 5 red suites are still retried (all five flaky, green)', r5.ok === true && (r5.flaky || []).length === 5 && r5.retry.retried === 5, JSON.stringify(r5.retry));
}

// 5) FORGE_DOCTOR_RETRY=0 -> strict mode, no retry
{
  const R6 = mkRoot();
  put(R6, 'a-ok', PASS_SRC);
  counted(R6, 'b-flaky', FAIL_ONCE, PASS_NOW);
  const r6 = withEnv('FORGE_DOCTOR_RETRY', '0', () => D.runTests(R6, { jobs: 2, timeoutMs: 60000, durationsFile: path.join(R6, 'd.json') }));
  t('FORGE_DOCTOR_RETRY=0: no retry, the suite ran once and the verdict is red', r6.ok === false && r6.suitesFailed === 1 && attempts(R6, 'b-flaky') === 1 && (r6.flaky || []).length === 0, JSON.stringify(r6));
  t('FORGE_DOCTOR_RETRY=0: the retry block names strict mode', r6.retry && r6.retry.ran === false && /FORGE_DOCTOR_RETRY=0/.test(r6.retry.reason || ''), JSON.stringify(r6.retry));
  // a green run needs no retry and says so without noise
  const R7 = mkRoot();
  put(R7, 'a-ok', PASS_SRC); put(R7, 'b-ok', PASS_SRC);
  const r7 = D.runTests(R7, { jobs: 2, timeoutMs: 60000, durationsFile: path.join(R7, 'd.json') });
  t('an all-green run retries nothing and lists no flaky suite', r7.ok === true && r7.retry && r7.retry.retried === 0 && Array.isArray(r7.flaky) && r7.flaky.length === 0, JSON.stringify(r7.retry));
  t('an all-green run prints no flaky or reason line', !/flaky under load|breakage, not flakiness/.test(summaryOf(r7)));
}

// 6) the receipt carries the flaky list (same guard function forge-doctor.cjs --receipt calls)
{
  const G = require('./forge-sync-publish-guard.cjs');
  const R8 = mkRoot();
  fs.mkdirSync(path.join(R8, '_scratch'), { recursive: true });
  const flaky = [{ suite: 'b.test.cjs', first: { failed: 1, timedOut: false, failures: ['FAIL x'] }, retry: { passed: 3, failed: 0 } }];
  const start = { root: R8, devDir: path.join(R8, '.claude'), startedAt: new Date().toISOString(), hashes: {}, fingerprint: 'none' };
  let w = null, err = null;
  try { w = G.finishDoctorReceipt(start, { ok: true, checks: { tests: { ok: true, suites: 2, suitesFailed: 0, passed: 5, failed: 0, flaky } } }); } catch (e) { err = e; }
  t('the receipt file carries the flaky list', !!w && w.receipt.tests && Array.isArray(w.receipt.tests.flaky) && w.receipt.tests.flaky.length === 1
    && w.receipt.tests.flaky[0].suite === 'b.test.cjs' && JSON.parse(fs.readFileSync(w.path, 'utf8')).tests.flaky[0].retry.passed === 3, err ? err.message : JSON.stringify(w && w.receipt.tests));
  let w0 = null;
  try { w0 = G.finishDoctorReceipt(start, { ok: true, checks: { tests: { ok: true, suites: 1, suitesFailed: 0, passed: 1, failed: 0 } } }); } catch { w0 = null; }
  t('a receipt without flaky suites records an empty flaky list', !!w0 && Array.isArray(w0.receipt.tests.flaky) && w0.receipt.tests.flaky.length === 0);
}

// 7) the real forge-doctor.cjs CLI (--json) on a hermetic root: the tests check carries the flaky list
{
  const R9 = mkRoot();
  put(R9, 'a-ok', PASS_SRC);
  counted(R9, 'b-flaky', FAIL_ONCE, PASS_NOW);
  const env = Object.assign({}, process.env, { FORGE_DOCTOR_JOBS: '2' });
  delete env.FORGE_DOCTOR_RETRY;
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-doctor.cjs'), '--root', R9, '--json'],
    { encoding: 'utf8', cwd: R9, env, timeout: 300000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let rep = null; try { rep = JSON.parse(cli.stdout); } catch { rep = null; }
  const tests = rep && rep.checks && rep.checks.tests;
  t('CLI --json: exactly one JSON report with a tests check', !!tests, 'status ' + cli.status + ' ' + String(cli.stderr || cli.stdout || '').slice(0, 400));
  t('CLI --json: the tests check is green with the flaky suite listed', !!tests && tests.ok === true && Array.isArray(tests.flaky) && tests.flaky.length === 1
    && tests.flaky[0].suite === 'b-flaky.test.cjs' && tests.retry && tests.retry.ran === true, JSON.stringify(tests && { ok: tests.ok, flaky: tests.flaky, retry: tests.retry }));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort: our own temp folder */ }
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
