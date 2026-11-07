#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract-shape-declared.test.cjs — category tests F14. The quality rules (plan card,
 * anticipation, craft review, screenshot evidence) apply only when the run DECLARES its shape: run.json
 * deliverable_types, plan-card.json or anticipate.json. Measured: android-v5/v6, windows-v5/v6 and restaurant-v6 wrote
 * none of the three, so every one of those rules was silently "not applicable" (restaurant-v6 shipped a website with no
 * screenshot record and the contract said OK). /forge already tells the Lead to run forge-anticipate apply and the
 * plan card; nothing checked it. Guard: rule `run-shape-declared` (block, complexity >= L2): the run folder holds an
 * anticipate.json applied for this run, a plan-card.json written by forge-plan-card.cjs, or a run.json that declares
 * deliverable_types. No agent exception; owner_override only. The shape rules themselves are unchanged: still never
 * inferred from the domain.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 700) : '')); } };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-shapedecl-')));
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const RULES = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const ID = 'run-shape-declared';
const START = '2026-11-07T12:00:00.000Z';
let n = 0;

/** runWith(level, files, extra) -> check() for run r1 in a fresh root with the real rules. files: {name: object|string}. */
function runWith(level, files, extra) {
  const root = path.join(TMP, 'p' + (++n));
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(RULES, path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const dir = path.join(root, '.claude', 'forge-runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    { event_type: 'run_started', agent: 'orchestrator', complexity: level, timestamp: START },
    { event_type: 'memory_loaded', agent: 'orchestrator', timestamp: START },
  ].concat(extra || []);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  for (const [name, body] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return RC.check({ run_id: 'r1' }, { root, ownerProfilePath: NO_PROFILE });
}
const missing = (r) => (r.missing || []).includes(ID);
const sat = (r) => (r.satisfied || []).includes(ID);
const detail = (r) => (r.rule_details || {})[ID] || {};
const ANTICIPATE = { v: 1, tool: 'forge-anticipate', run_id: 'r1', status: 'applied', input: { lanes: 1, type: null }, deliverable_types: ['web-ui', 'code'], active: [] };
const CARD = { cardHash: 'a'.repeat(64), ready: ['WP1', 'WP2'], blocked: [], lanes: { expected: 2, collisions: [] } };

console.log('forge-runcontract run-shape-declared tests (hermetic root=' + TMP + ')');

const rules = RC.listRules();
const rule = rules.find((r) => r.id === ID);
t('the real rules file has run-shape-declared: block, complexity >= L2, run-evidence shape-declared, since 2026-11-07', !!rule && rule.severity === 'block' && rule.trigger === 'complexity:>=L2' && rule.check.type === 'run-evidence' && rule.check.evidence === 'shape-declared' && rule.since === '2026-11-07', JSON.stringify(rule));
t('it names forge-anticipate apply in next_step and carries NL+EN messages', !!rule && /forge-anticipate\.cjs apply --run <run_id>/.test(rule.next_step || '') && rule.message && rule.message.en && rule.message.nl);
t('no agent exception: only owner_override clears it', !!rule && rule.check.exception === undefined && /owner_override/.test(rule.override || ''));

let r = runWith('L2', {});
t('the restaurant-v6 shape (L2, no run.json, no plan card, no anticipate.json): NOT DONE', missing(r) && r.ok === false, JSON.stringify(detail(r)));
t('... the reason names the three files and the next step carries the run id', /anticipate\.json/.test(detail(r).reason || '') && /plan-card\.json/.test(detail(r).reason || '') && /--run r1/.test(detail(r).next_step || ''), JSON.stringify(detail(r)));

r = runWith('L2', { 'anticipate.json': ANTICIPATE });
t('anticipate.json applied for this run: met', sat(r) && !missing(r), JSON.stringify(detail(r)));
r = runWith('L2', { 'anticipate.json': Object.assign({}, ANTICIPATE, { run_id: 'another-run' }) });
t('anticipate.json of another run does not count', missing(r), JSON.stringify(detail(r)));
r = runWith('L2', { 'anticipate.json': Object.assign({}, ANTICIPATE, { status: 'planned' }) });
t('anticipate.json only planned (never applied) does not count', missing(r), JSON.stringify(detail(r)));
r = runWith('L2', { 'plan-card.json': CARD });
t('a plan card written by forge-plan-card (card hash): met', sat(r), JSON.stringify(detail(r)));
r = runWith('L2', { 'plan-card.json': Object.assign({}, CARD, { cardHash: 'nope' }) });
t('a hand-made plan-card.json without a card hash does not count', missing(r), JSON.stringify(detail(r)));
r = runWith('L2', { 'run.json': { deliverable_types: ['game-and-interactive'] } });
t('run.json declaring deliverable_types: met', sat(r), JSON.stringify(detail(r)));
r = runWith('L2', { 'run.json': { complexity: 'L2' } });
t('run.json without deliverable_types does not count', missing(r), JSON.stringify(detail(r)));
r = runWith('L2', { 'anticipate.json': '{not json' });
t('an unreadable anticipate.json does not count, and says so', missing(r) && /unreadable/.test(detail(r).reason || ''), JSON.stringify(detail(r)));

r = runWith('L1', {});
t('an L1 run is not judged by run-shape-declared', !missing(r) && !sat(r), JSON.stringify(detail(r)));

r = runWith('L2', {}, [{ event_type: 'owner_override', rule: ID, reason: 'owner said this quick fix needs no plan card', by: 'owner' }]);
t('a valid owner_override clears it', !missing(r) && (r.overridden || []).some((x) => x.id === ID), JSON.stringify(r.overridden));
r = runWith('L2', {}, [{ event_type: 'decision_logged', agent: 'orchestrator', rule: ID, decision: 'not-applicable', reason: 'a game needs no plan card here' }]);
t('an agent decision_logged does not clear it', missing(r));

// Mutation: with the rule removed the restaurant-v6 shape would pass again.
{
  const noRule = JSON.parse(fs.readFileSync(RULES, 'utf8'));
  noRule.rules = noRule.rules.filter((x) => x.id !== ID);
  const root = path.join(TMP, 'm1');
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify(noRule));
  const dir = path.join(root, '.claude', 'forge-runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ event_type: 'run_started', agent: 'orchestrator', complexity: 'L2', timestamp: START }) + '\n');
  const m = RC.check({ run_id: 'r1' }, { root, ownerProfilePath: NO_PROFILE });
  t('MUTANT rule removed: the undeclared run is not flagged -> the NOT DONE test above would fail', !(m.missing || []).includes(ID));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
