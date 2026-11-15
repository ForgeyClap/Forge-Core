'use strict';
// forge-doctor-report.test.cjs — doctor/report.cjs printSummary (audit FB-CONFIG-2-F5): an advisory that
// fails must show in the human summary. global_forge_handover, eol_drift and claim_sealed_drift were computed but never
// printed, so the summary ended ALL GREEN while the finding lived only in --json.
const D = require('./forge-doctor.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const checks = {
  node_check: { ok: true, total: 0 }, tests: { ok: true, suites: 0, passed: 0, failed: 0, perSuite: [] },
  strict_events: { ok: true, known_accepted: 0, unknown_rejected: 0 }, dashboard_spa: { ok: true, present: [] },
  leak_scan: { ok: true, scanned: 0, source: 'git', sources: [], skipped: [], hits: [], notScanned: [] },
};
const failing = (key) => ({ ok: false, applicable: true, reason: 'STUB-' + key + ' failed', summary: 'STUB-' + key + ' failed', problems: ['STUB-' + key + ' failed'], drift: [{ file: 'STUB-' + key + '.cjs', before: 'lf', after: 'crlf' }], findings: [], fix: 'fix it' });
const summary = (advisory) => D.printSummary({ root: 'x', ok: true, checks, advisory });

console.log('forge-doctor-report tests');

for (const key of ['global_forge_handover', 'eol_drift', 'claim_sealed_drift']) {
  t(key + ': a failing result has its own ⚠ line in the summary', () => {
    const s = summary({ [key]: failing(key) });
    ok(s.split('\n').some((l) => l.includes('⚠') && l.includes('STUB-' + key)), s);
  });
}
t('generic fallback: an advisory key with no dedicated line still prints when it fails', () => {
  const s = summary({ some_new_check: { ok: false, applicable: true, reason: 'STUB-new failed' } });
  ok(s.split('\n').some((l) => l.includes('⚠') && l.includes('some_new_check') && l.includes('STUB-new failed')), s);
});
t('every ADVISORY_CHECKS key with a failing stub reaches the summary text', () => {
  const missing = [];
  for (const key of D.DOCTOR_CHECK_ORDER.advisory) {
    if (['command_center_location', 'beginner_setup', 'completeness', 'backfill_continuity', 'run_liveness', 'context_budget', 'unpublished', 'structure', 'always_loaded_budget', 'skill_lint', 'agent_lint', 'config_scan', 'harness_score', 'listing_budget', 'gate_watchdog_health', 'plugin_validate'].includes(key)) continue; // own result shapes, printed every run
    const s = summary({ [key]: failing(key) });
    if (!s.includes('STUB-' + key)) missing.push(key);
  }
  ok(missing.length === 0, 'not printed: ' + missing.join(', '));
});
t('a passing advisory with no dedicated line adds no fallback noise', () => {
  const s = summary({ some_new_check: { ok: true, applicable: true } });
  ok(!s.includes('some_new_check'), s);
});
// CF-5-F5 / CF-5-F6: a month-old baseline kept the context budget tripped for good, and the skill listing's
// over-budget state was buried in one long finding with no share per source.
const budget = (generatedAt, over) => ({ ok: false, total_approx_tokens: 100, posts: [], notes: [], findings: [{ detail: 'STUB-finding' }],
  baseline: { generated_at: generatedAt },
  skill_listing: { approx_tokens: 20000, budget_approx_tokens: 2000, over_budget: over },
  skill_sources: [{ id: 'skill_catalog_project', chars: 1000, skills: 10, exists: true, in_project: true },
    { id: 'skill_catalog_global', chars: 7000, skills: 70, exists: true, in_project: false },
    { id: 'skill_catalog_plugins', chars: 2000, skills: 20, exists: true, in_project: false }] });
t('CF-5-F5: a baseline older than 14 days with open findings gets its own named line', () => {
  const s = summary({ context_budget: budget('2026-10-10T19:14:38.305Z', false) });
  ok(s.split('\n').some((l) => l.includes('⚠') && /context baseline/.test(l) && l.includes('2026-10-10') && /--write-baseline/.test(l)), s);
});
t('CF-5-F5: a fresh baseline gets no baseline line', () => {
  const s = summary({ context_budget: budget(new Date(Date.now() - 86400000).toISOString(), false) });
  ok(!/context baseline/.test(s), s);
});
t('CF-5-F6: an over-budget skill listing gets a named line with the share per source', () => {
  const s = summary({ context_budget: budget(new Date().toISOString(), true) });
  ok(s.split('\n').some((l) => l.includes('⚠') && /skill listing/.test(l) && /10x/.test(l) && /project 10%/.test(l) && /global 70%/.test(l) && /plugins 20%/.test(l)), s);
});
t('CF-5-F6: a listing within budget gets no listing line', () => {
  ok(!/skill listing \(advisory/.test(summary({ context_budget: budget(new Date().toISOString(), false) })));
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
