'use strict';
/**
 * doctor/suite-retry.cjs — SD-FLAKE: one retry for red suites after the doctor's test pass.
 *
 * On a loaded machine (other lanes, an install beside other suites) stopwatch-style suites failed or timed out in the
 * pool although they passed alone, and each such flake turned the doctor red (an install rolled back, a publish
 * receipt stayed red). After the pooled (or sequential) pass, runTests() hands the red suites to retryRedSuites():
 *   - each red suite is re-run ONCE, alone and sequentially, after the pool has finished, with the same per-suite
 *     limit and the same temp isolation (the caller's runOne = runSuiteSequential + the unchanged verdict code);
 *   - a suite that passes the retry counts as passing but is marked flaky (entry.flaky + one item in `flaky`), so the
 *     text report, --json and the receipt all carry it: never silently green;
 *   - a suite that fails the retry stays red with the retry's failing names, and keeps the first attempt in `first`;
 *   - more than RETRY_MAX_RED red suites is breakage, not flakiness: no retry, red, `retry.reason` says why;
 *   - FORGE_DOCTOR_RETRY=0 (or opts.retry === false) is strict mode: no retry.
 * Zero dependencies; this module runs nothing itself (runOne is injected), so it cannot import checks-core in a cycle.
 */

const RETRY_MAX_RED = 5;
// FB-CONFIG-3-F2: all retries together get at most this long; each retry runs with min(its limit, what is left).
const RETRY_BUDGET_MS = 10 * 60 * 1000;

/** retryDisabledReason(opts, env) -> null when the retry may run, else the one-line reason it does not. */
function retryDisabledReason(opts, env) {
  if (opts && opts.retry === false) return 'retry switched off by the caller (strict mode)';
  const v = (env || process.env).FORGE_DOCTOR_RETRY;
  if (v !== undefined && String(v).trim() === '0') return 'FORGE_DOCTOR_RETRY=0 (strict mode): red suites are not retried';
  return null;
}

const firstOf = (e) => {
  const first = { passed: e.passed, failed: e.failed, timedOut: !!e.timedOut, failures: Array.isArray(e.failures) ? e.failures.slice() : [] };
  if (e.signal) first.signal = e.signal;
  return first;
};

/**
 * retryRedSuites(perSuite, runOne, opts, env) -> {perSuite, flaky, retry}
 *   perSuite: the first-pass entries (not mutated; a new array is returned)
 *   runOne(index, leftMs) -> a fresh verdict entry for that suite, run alone within leftMs (the retry budget left)
 *   FB-CONFIG-3-F1 (the forge-sync isolatedAcceptance rule): a first attempt that TIMED OUT is never retried (a hang
 *   under load is not flaky), and a passing retry counts only when it ran at least as many tests as the first attempt
 *   covered (passed + failed). opts.retryBudgetMs / opts.now are seams for tests.
 *   retry: {ran, retried, max, reason}
 */
function retryRedSuites(perSuite, runOne, opts, env) {
  const red = [];
  perSuite.forEach((e, i) => { if (e && e.ok === false) red.push(i); });
  const retry = { ran: false, retried: 0, max: RETRY_MAX_RED, reason: '' };
  if (red.length === 0) return { perSuite: perSuite.slice(), flaky: [], retry };
  const off = retryDisabledReason(opts, env);
  if (off) return { perSuite: perSuite.slice(), flaky: [], retry: Object.assign(retry, { reason: off }) };
  if (red.length > RETRY_MAX_RED) {
    return { perSuite: perSuite.slice(), flaky: [], retry: Object.assign(retry, {
      reason: red.length + ' suites failed or timed out in the first pass (more than ' + RETRY_MAX_RED + '): breakage, not flakiness — no retry' }) };
  }
  const out = perSuite.slice();
  const flaky = [];
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
  const budget = (opts && Number.isFinite(opts.retryBudgetMs)) ? opts.retryBudgetMs : RETRY_BUDGET_MS;
  const t0 = now();
  let retried = 0;
  for (const i of red) {
    const first = firstOf(perSuite[i]);
    if (first.timedOut) { out[i] = Object.assign({}, perSuite[i], { notRetried: 'timed out in the first pass: a hang under load is never accepted as flaky' }); continue; }
    const leftMs = budget - (now() - t0);
    if (leftMs <= 0) { out[i] = Object.assign({}, perSuite[i], { notRetried: 'the retry budget (' + Math.round(budget / 1000) + ' s) is used up' }); continue; }
    const again = runOne(i, leftMs);
    retried++;
    const covered = (Number(first.passed) || 0) + (Number(first.failed) || 0);
    if (again && again.ok === true && !(Number(again.passed) < covered)) {
      out[i] = Object.assign({}, again, { flaky: true, first });
      flaky.push({ suite: perSuite[i].suite, first, retry: { passed: again.passed, failed: again.failed } });
    } else {
      const thin = again && again.ok === true ? { ok: false, coverage: 'the retry ran ' + again.passed + ' test(s), fewer than the ' + covered + ' the first attempt covered' } : {};
      out[i] = Object.assign({}, again || perSuite[i], { retried: true, first }, thin);
    }
  }
  retry.ran = retried > 0;
  retry.retried = retried;
  return { perSuite: out, flaky, retry };
}

/** firstAttemptText(first) -> short text for the report: the first attempt's failing names, or that it timed out. */
function firstAttemptText(first) {
  if (!first) return '';
  if (first.timedOut) return 'first attempt timed out';
  const names = Array.isArray(first.failures) ? first.failures : [];
  if (names.length) return 'first attempt failed: ' + names.join(' | ');
  return 'first attempt failed (' + (first.failed > 0 ? first.failed + ' failed' : 'crashed, no tally or non-zero exit') + ')';
}

/** retryReportLines(tests) -> the warning / reason lines the text report prints under the tests line. */
function retryReportLines(tests) {
  const lines = [];
  if (!tests || typeof tests !== 'object') return lines;
  for (const f of Array.isArray(tests.flaky) ? tests.flaky : []) {
    lines.push('  ⚠ flaky suite: ' + f.suite + ' — passed alone on retry: flaky under load (' + firstAttemptText(f.first) + ')');
  }
  for (const s of Array.isArray(tests.perSuite) ? tests.perSuite : []) {
    if (!s || s.ok !== false || !s.retried) continue;
    const now = s.timedOut ? 'retry timed out' : s.coverage ? s.coverage : 'retry failed' + (Array.isArray(s.failures) && s.failures.length ? ': ' + s.failures.join(' | ') : '');
    lines.push('  ✗ red after retry: ' + s.suite + ' — ' + now + ' · ' + firstAttemptText(s.first));
  }
  for (const s of Array.isArray(tests.perSuite) ? tests.perSuite : []) {
    if (s && s.ok === false && s.notRetried) lines.push('  ✗ not retried: ' + s.suite + ' — ' + s.notRetried);
  }
  const r = tests.retry;
  if (r && r.ran === false && r.reason) lines.push('  ⚠ no retry: ' + r.reason);
  return lines;
}

module.exports = { RETRY_MAX_RED, RETRY_BUDGET_MS, retryDisabledReason, retryRedSuites, firstAttemptText, retryReportLines };
