#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract-skill-delivered.test.cjs — category finding SK1 part 2. skill-map-recorded only asks
 * that a map was LOGGED; on three measured runs the agents never opened the skills it assigned. Guard: rule
 * `skill-delivered` (block, complexity >= L2) compares the run's latest skill map (normalised by forge-skillmap.cjs) with
 * the skills each agent type really opened, as recorded on its SubagentStop lines (skills_opened, transcript_scanned).
 * Map shapes: the restaurant run (agent-keyed lists) and the windows run (WP-keyed free text).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 700) : '')); } };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rc-skilldel-')));
const NO_PROFILE = path.join(TMP, 'no-owner-profile.json');
const RULES = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const SKILLS = ['frontend-design', 'forge-website', 'forge-debug', 'systematic-debugging', 'humanizer', 'forge-verify'];
const START = '2026-11-07T10:00:00.000Z';
const at = (min) => new Date(Date.parse(START) + min * 60000).toISOString();
let n = 0;

/** runWith(events, stopLines, opts) -> check() result for run r1 in a fresh root with the real rules and six skills. */
function runWith(events, stopLines, opts) {
  const root = path.join(TMP, 'p' + (++n));
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(RULES, path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  for (const s of SKILLS) { fs.mkdirSync(path.join(root, '.claude', 'skills', s), { recursive: true }); fs.writeFileSync(path.join(root, '.claude', 'skills', s, 'SKILL.md'), '# ' + s + '\n'); }
  const dir = path.join(root, '.claude', 'forge-runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (stopLines) {
    const hooks = path.join(root, '.claude', 'forge-runs', '_hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'subagent-stop.jsonl'), stopLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return RC.check(Object.assign({ run_id: 'r1' }, (opts && opts.params) || {}), { root, ownerProfilePath: NO_PROFILE });
}
const base = (level, map, extra) => [
  { event_type: 'run_started', agent: 'orchestrator', complexity: level || 'L2', timestamp: START },
  { event_type: 'memory_loaded', agent: 'orchestrator', timestamp: at(1) },
].concat(map === undefined ? [] : [Object.assign({ event_type: 'skill_map_created', agent: 'orchestrator', timestamp: at(2) }, map)], extra || []);
let aid = 0;
const stop = (type, opened, extra) => Object.assign({ ts: at(10), event: 'SubagentStop', agent_id: 'a' + (++aid).toString(16).padStart(6, '0'), agent_type: type, run: 'r1', skills_opened: opened, transcript_scanned: true }, extra || {});
const detail = (r) => (r.rule_details || {})['skill-delivered'] || {};
const missing = (r) => (r.missing || []).includes('skill-delivered');
const RESTAURANT = { map: { 'ui-boss': ['frontend-design', 'forge-website'], 'build-boss': ['forge-debug'], 'verify-boss': ['forge-verify'] } };
const WINDOWS = { map: { WP1: 'build-boss: forge-debug and systematic-debugging for the installer bug', WP2: 'Docs Boss: humanizer on the README' } };

console.log('forge-runcontract skill-delivered tests (hermetic root=' + TMP + ')');

const rules = RC.listRules();
const idx = rules.findIndex((r) => r.id === 'skill-delivered');
const rule = rules[idx];
t('the real rules file has skill-delivered: block, complexity >= L2, run-evidence skill-delivery', rule && rule.severity === 'block' && rule.trigger === 'complexity:>=L2' && rule.check.type === 'run-evidence' && rule.check.evidence === 'skill-delivery', JSON.stringify(rule));
t('it sits right after skill-map-recorded', idx > 0 && rules[idx - 1].id === 'skill-map-recorded');
t('it carries an NL and EN message and a next step', rule && rule.message && rule.message.en && rule.message.nl && rule.next_step);

// restaurant shape
let r = runWith(base('L2', RESTAURANT), [stop('ui-boss', ['frontend-design', 'forge-website']), stop('build-boss', ['forge-debug']), stop('verify-boss', ['forge-verify', 'forge-code-review'])]);
t('restaurant map, every dispatched agent opened its skills: met', !missing(r) && detail(r).ok === true, JSON.stringify(detail(r)));

r = runWith(base('L2', RESTAURANT), [stop('ui-boss', ['frontend-design']), stop('build-boss', ['forge-debug']), stop('verify-boss', ['forge-verify'])]);
t('ui-boss never opened forge-website: NOT DONE, naming the agent and the skill', missing(r) && /ui-boss/.test(detail(r).reason) && /forge-website/.test(detail(r).reason) && !/frontend-design/.test((detail(r).reason.match(/ui-boss[^;|]*/) || [''])[0].replace(/forge-website/, '')), detail(r).reason);
t('... and the failure carries the NL+EN message', detail(r).message && /skill/i.test(detail(r).message.en) && detail(r).message.nl, JSON.stringify(detail(r).message));

r = runWith(base('L2', RESTAURANT), [stop('ui-boss', ['frontend-design']), stop('ui-boss', ['forge-website']), stop('build-boss', ['forge-debug']), stop('verify-boss', ['forge-verify'])]);
t('two ui-boss dispatches: the union of what they opened counts', !missing(r), detail(r).reason);

r = runWith(base('L2', RESTAURANT), [stop('ui-boss', ['frontend-design', 'forge-website'])]);
t('build-boss and verify-boss never dispatched: listed in the detail, not a failure', !missing(r) && /not dispatched/i.test(detail(r).reason) && /build-boss/.test(detail(r).reason) && Array.isArray(detail(r).skill_delivery.not_dispatched) && detail(r).skill_delivery.not_dispatched.includes('verify-boss'), JSON.stringify(detail(r)));

r = runWith(base('L2', RESTAURANT), [{ ts: at(10), event: 'SubagentStop', agent_id: 'a1', agent_type: 'ui-boss', run: 'r1' }]);
t('stop lines without transcript_scanned (older install): met, "not measured"', !missing(r) && /not measured/i.test(detail(r).reason), detail(r).reason);
r = runWith(base('L2', RESTAURANT), null);
t('no stop log at all: met, "not measured"', !missing(r) && /not measured/i.test(detail(r).reason), detail(r).reason);

r = runWith(base('L2', RESTAURANT), [stop('ui-boss', [], { transcript_scanned: false }), stop('build-boss', ['forge-debug'])]);
t('a type whose transcript could not be scanned is not judged (listed), the others are', !missing(r) && /ui-boss/.test(detail(r).reason), detail(r).reason);

// run binding and the time window
r = runWith(base('L2', RESTAURANT), [stop('ui-boss', ['frontend-design'], { run: 'another-run' })]);
t('a stop line stamped with another run does not count (this run: not measured)', !missing(r) && /not measured/i.test(detail(r).reason), detail(r).reason);
r = runWith(base('L2', RESTAURANT), [stop('ui-boss', ['frontend-design'], { run: undefined })]);
t('an unstamped line inside the run window counts (and fails here)', missing(r) && /forge-website/.test(detail(r).reason), detail(r).reason);
r = runWith(base('L2', RESTAURANT), [stop('ui-boss', ['frontend-design'], { run: undefined, ts: '2026-11-06T09:00:00.000Z' })]);
t('an unstamped line from before run_started does not count', !missing(r), detail(r).reason);

// the windows shape (WP-keyed free text)
r = runWith(base('L2', WINDOWS), [stop('build-boss', ['forge-debug']), stop('docs-boss', ['humanizer'])]);
t('windows map: build-boss never opened systematic-debugging: NOT DONE, named', missing(r) && /build-boss/.test(detail(r).reason) && /systematic-debugging/.test(detail(r).reason), detail(r).reason);
r = runWith(base('L2', WINDOWS), [stop('build-boss', ['forge-debug', 'systematic-debugging']), stop('docs-boss', ['humanizer'])]);
t('windows map, everything opened: met', !missing(r), detail(r).reason);

// maps that name no real skill
r = runWith(base('L2', { map: { WP1: 'native method route', WP2: 'not-a-skill-xyz' } }), [stop('build-boss', [])]);
t('a map that normalises to {}: NOT DONE with the agent-keyed shape to log', missing(r) && /names no real skills per agent/.test(detail(r).reason) && detail(r).reason.includes('{"<agent-type>": ["<skill>"]}'), detail(r).reason);
r = runWith(base('L2', { skills: { 'ui-boss': ['frontend-design'] } }), [stop('ui-boss', ['frontend-design'])]);
t('the "skills" field (the shape skill-map-recorded used to suggest) is read too', !missing(r) && detail(r).ok === true, detail(r).reason);
r = runWith(base('L2', undefined, [{ event_type: 'skill_discovery', agent: 'orchestrator', timestamp: at(2), result: 'no project skill fits; native route' }]), [stop('build-boss', [])]);
t('no skill map at all (skill_discovery only): skill-delivered does not judge it', !missing(r), detail(r).reason);

// the last map wins
r = runWith(base('L2', { map: { 'ui-boss': ['forge-website'] } }, [{ event_type: 'skill_map_created', agent: 'orchestrator', timestamp: at(3), map: { 'ui-boss': ['frontend-design'] } }]), [stop('ui-boss', ['frontend-design'])]);
// SK2 (restaurant-v4): after skill-delivered failed, the Lead logged a "corrected" map listing only what was
// opened. A later map may ADD skills, never drop them: every map of the run counts together.
t('a later skill_map_created cannot drop an assigned skill (all maps count together)', missing(r) && /forge-website/.test(detail(r).reason), detail(r).reason);
r = runWith(base('L2', { map: { 'ui-boss': ['frontend-design'] } }, [{ event_type: 'skill_map_created', agent: 'orchestrator', timestamp: at(3), map: { 'ui-boss': ['forge-website'] } }]), [stop('ui-boss', ['frontend-design', 'forge-website'])]);
t('a later map that adds a skill: both are required, both opened -> met', !missing(r), detail(r).reason);

// SK4 (windows-v5): the Lead's map covered only the reviewers (verify-boss, test-boss) and build-boss built the
// whole game with no assigned skill; the contract said OK. An EXECUTING agent type (it builds, makes the UI or tests)
// that was dispatched in this run but has no skill in any map of the run fails the rule. Planning and recording roles
// (head-chef, boss, scribe, skill-boss, docs-boss, search-boss) and read-only reviewers are not judged this way.
const REVIEW_ONLY = { map: { 'verify-boss': ['forge-verify'], 'test-boss': ['forge-verify'] } };
r = runWith(base('L2', REVIEW_ONLY), [stop('build-boss', []), stop('verify-boss', ['forge-verify']), stop('test-boss', ['forge-verify'])]);
t('SK4: build-boss dispatched with no skill in any map: NOT DONE, naming build-boss as unassigned', missing(r) && /build-boss/.test(detail(r).reason) && /no assigned skill/i.test(detail(r).reason) && (detail(r).skill_delivery.unassigned || []).includes('build-boss'), JSON.stringify(detail(r)));
r = runWith(base('L2', REVIEW_ONLY), [stop('ui-boss', ['frontend-design']), stop('verify-boss', ['forge-verify'])]);
t('SK4: ui-boss dispatched unassigned fails even though it opened a skill on its own', missing(r) && /ui-boss/.test(detail(r).reason), detail(r).reason);
r = runWith(base('L2', RESTAURANT), [stop('head-chef', []), stop('ui-boss', ['frontend-design', 'forge-website']), stop('build-boss', ['forge-debug']), stop('verify-boss', ['forge-verify']), stop('docs-boss', []), stop('Explore', [])]);
t('SK4: head-chef, docs-boss and a built-in Explore dispatched unassigned are not failures', !missing(r), detail(r).reason);
r = runWith(base('L2', REVIEW_ONLY), [{ ts: at(10), event: 'SubagentStop', agent_id: 'a9', agent_type: 'build-boss', run: 'r1' }]);
t('SK4: an older install without transcript_scanned stays "not measured"', !missing(r) && /not measured/i.test(detail(r).reason), detail(r).reason);
r = runWith(base('L2', REVIEW_ONLY), [stop('forge:build-boss', [])]);
t('SK4: a plugin-prefixed agent type (forge:build-boss) is recognised as build-boss', missing(r) && /build-boss/.test(detail(r).reason), detail(r).reason);

// complexity gate
r = runWith(base('L1', RESTAURANT), [stop('ui-boss', [])]);
t('an L1 run is not judged by skill-delivered', !missing(r) && !(r.satisfied || []).includes('skill-delivered'), JSON.stringify(detail(r)));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
