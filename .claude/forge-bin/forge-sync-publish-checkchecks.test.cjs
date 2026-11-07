#!/usr/bin/env node
'use strict';
/**
 * forge-sync-publish-checkchecks.test.cjs — category tests I1. A test whose helper the doctor's
 * check_the_checks misread reached the template, and every fresh install then ran a 30-minute doctor and rolled back
 * (three v5 projects). check_the_checks is a static scan of the test files that takes ~0.2 s. Guard: publish-template
 * refuses --apply when the development tree's own check_the_checks is red, naming the suites, before anything is written.
 */
const assert = require('assert');
const path = require('path');
const S = require('./forge-sync.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const plan = (devDir) => ({ dev: { git: { available: true, head: 'abc', dirtyPaths: [] } }, blocked: [], devMissingBlocking: [], templateDir: path.join(__dirname, '__no_template__'), devDir });

t('publishApplyBlockers is exported', () => assert.strictEqual(typeof S.publishApplyBlockers, 'function'));
t('a red check_the_checks in the dev tree refuses the publish and names the suite', () => {
  const r = S.publishApplyBlockers(plan('X'), { checkTheChecks: () => ({ ok: false, checked: 2, noOp: [{ suite: 'forge-wait.test.cjs', line: 49, reason: 'bare function literal' }] }) });
  assert.ok(r.some((x) => /check_the_checks/.test(x) && /forge-wait\.test\.cjs/.test(x)), JSON.stringify(r));
});
t('a green check_the_checks adds no blocker', () => {
  assert.deepStrictEqual(S.publishApplyBlockers(plan('X'), { checkTheChecks: () => ({ ok: true, checked: 2, noOp: [] }) }), []);
});
t('the real development tree passes (default: its own forge-doctor.cjs is used)', () => {
  const r = S.publishApplyBlockers(plan(path.resolve(__dirname, '..')), {});
  assert.ok(!r.some((x) => /check_the_checks/.test(x)), JSON.stringify(r));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
