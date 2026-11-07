#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract-skillmap.test.cjs — category tests, owner rule 1 "do the agents connect the skills to the
 * agents or to the category correctly". /forge step 3a says every run records Skill Discovery (`skill_discovery` ->
 * `skill_map_created`; no subagent without a skill/method route). Three v1 runs never ran it and restaurant-v2 closed
 * CONTRACT OK without it: no contract rule asked for it. Guard: rule `skill-map-recorded` (block, always) is NOT DONE
 * until the run logged skill_map_created or skill_discovery, and the real rules file carries it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-skillmap-'));
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');

function runWith(events) {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  const rulesTo = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(rulesTo, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), path.join(rulesTo, 'FORGE_HARD_RULES.json'));
  const dir = path.join(root, '.claude', 'forge-runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return RC.check({ run_id: 'r1' }, { root, ownerProfilePath: NO_PROFILE });
}
const BASE = [
  { event_type: 'run_started', agent: 'orchestrator' },
  { event_type: 'memory_loaded', agent: 'orchestrator' },
  { event_type: 'owner_prefs_loaded', agent: 'orchestrator' },
  { event_type: 'research_done', agent: 'orchestrator' },
];
const missingIds = (r) => (r.missing || []).map((m) => (typeof m === 'string' ? m : m.id || m.rule));

t('the real rules file has skill-map-recorded as a blocking, always-on rule', () => {
  const rule = RC.listRules().find((r) => r.id === 'skill-map-recorded');
  assert.ok(rule, 'rule missing');
  assert.strictEqual(rule.severity, 'block');
  assert.strictEqual(rule.trigger, 'always');
});
t('a run without skill discovery is NOT DONE on skill-map-recorded', () => {
  assert.ok(missingIds(runWith(BASE)).includes('skill-map-recorded'), JSON.stringify(runWith(BASE).missing));
});
t('skill_map_created satisfies it', () => {
  assert.ok(!missingIds(runWith(BASE.concat([{ event_type: 'skill_map_created', agent: 'orchestrator', skills: { 'WP-A': 'forge-game' } }]))).includes('skill-map-recorded'));
});
t('skill_discovery alone satisfies it too (a run that found no skill to attach still records that it looked)', () => {
  assert.ok(!missingIds(runWith(BASE.concat([{ event_type: 'skill_discovery', agent: 'orchestrator', result: 'no project skill fits; method route: native' }]))).includes('skill-map-recorded'));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
