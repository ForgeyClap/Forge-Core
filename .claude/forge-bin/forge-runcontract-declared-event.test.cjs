#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract-declared-event.test.cjs — category tests O26. chinees-restaurant-site-v2 declared
 * `complexity: "L2"` on its run_started event, but the contract read the declared level only from run.json — which a
 * headless session could not write (O25) — and judged the run L1 (derived from 3 dispatches), so every L2 rule stayed
 * off. Guard: the level declared on run_started counts as a declaration too (it can only RAISE the level).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-declared-ev-'));
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');

function project(events, runJson) {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  const rules = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(rules, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), path.join(rules, 'FORGE_HARD_RULES.json'));
  const dir = path.join(root, '.claude', 'forge-runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (runJson) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(runJson));
  return root;
}
const ev = (complexity) => [
  Object.assign({ event_type: 'run_started', agent: 'Lead', timestamp: '2026-11-07T02:37:03.847Z' }, complexity ? { complexity } : {}),
  { event_type: 'subagent_started', agent: 'verify-boss', timestamp: '2026-11-07T02:50:00.000Z' },
];

t('run_started complexity L2 without run.json makes the run L2 (declared)', () => {
  const r = RC.check({ run_id: 'r1' }, { root: project(ev('L2')), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L2', JSON.stringify({ c: r.complexity, s: r.complexity_source }));
  assert.strictEqual(r.complexity_source, 'declared');
});
t('without any declaration the derived level still applies (L1)', () => {
  const r = RC.check({ run_id: 'r1' }, { root: project(ev(null)), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L1');
});
t('run.json L3 and run_started L2: the higher one wins', () => {
  const r = RC.check({ run_id: 'r1' }, { root: project(ev('L2'), { complexity: 'L3' }), ownerProfilePath: NO_PROFILE });
  assert.strictEqual(r.complexity, 'L3');
});
t('a run_started complexity can never LOWER a higher derived level', () => {
  const many = ev('L1').concat(Array.from({ length: 12 }, (_, i) => ({ event_type: 'subagent_started', agent: 'build-boss', dispatch_id: 'd' + i, timestamp: '2026-11-07T02:5' + (i % 9) + ':00.000Z' })));
  const r = RC.check({ run_id: 'r1' }, { root: project(many), ownerProfilePath: NO_PROFILE });
  assert.notStrictEqual(r.complexity, 'L1', JSON.stringify(r.complexity));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
