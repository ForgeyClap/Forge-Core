#!/usr/bin/env node
'use strict';
/**
 * forge-skill-delivery.test.cjs — SD-T5 (default skills). skill-delivered used to count only the skills an
 * agent OPENED (SubagentStop skills_opened). A skill preloaded through the agent file's `skills:` is in the agent's
 * context from turn one and never shows up as an open, so a correctly preloaded agent failed. Delivered is now
 * preloaded (SubagentStart skills_preloaded) ∪ opened, and the role baseline from FORGE_DEFAULT_SKILLS.json is an
 * assignment, so a dispatched executor with a baseline is never "unassigned".
 */
const path = require('path');
// A missing module (the RED state) gives empty answers, so the suite prints a tally instead of crashing.
const EMPTY_SD = { delivered: [], missing: [], unassigned: [], not_dispatched: [], not_scanned: [], baseline_unmeasured: [] };
const SD = (() => {
  try { return require('./forge-skill-delivery.cjs'); } catch (e) {
    console.error('  (forge-skill-delivery.cjs not loadable: ' + (e && e.code || e) + ')');
    return { deliveredFor: () => new Set(), assignedFor: () => [], judgeDelivery: () => EMPTY_SD, measured: () => undefined };
  }
})();
const DS = require('./forge-default-skills.cjs');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };

const REPO = path.resolve(__dirname, '..', '..');
const loaded = DS.loadDefaults(REPO);
const DATA = loaded.data;
const start = (type, preloaded) => Object.assign({ event: 'SubagentStart', agent_type: type }, preloaded === undefined ? {} : { skills_preloaded: preloaded });
const stop = (type, opened, scanned) => ({ event: 'SubagentStop', agent_type: type, skills_opened: opened, transcript_scanned: scanned === undefined ? true : scanned });
const KNOWN = new Set(['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail', 'forge-craft', 'forge-ui-polish', 'forge-website', 'forge-verify', 'frontend-design']);
const EXEC = new Set(['build-boss', 'ui-boss', 'test-boss']);

console.log('forge-skill-delivery tests');
t('the repo defaults load (precondition)', loaded.ok === true, JSON.stringify(loaded.problems));

// deliveredFor
let d = SD.deliveredFor('build-boss', [start('build-boss', ['forge-testing'])], [stop('build-boss', [])]);
t('preload counts: a preloaded skill is delivered although it was never opened', d instanceof Set && d.has('forge-testing'), JSON.stringify([...(d || [])]));
d = SD.deliveredFor('build-boss', [], [stop('build-boss', ['Forge-Debug'])]);
t('opened counts (lowercased)', d.has('forge-debug'), JSON.stringify([...d]));
d = SD.deliveredFor('build-boss', [start('ui-boss', ['forge-craft'])], [stop('ui-boss', ['forge-website'])]);
t('another agent type\'s lines do not count', d.size === 0, JSON.stringify([...d]));
d = SD.deliveredFor('Build Boss', [start('forge:build-boss', ['ponytail'])], [stop('build_boss', ['forge-debug'])]);
t('display names and plugin prefixes resolve to the same type', d.has('ponytail') && d.has('forge-debug'), JSON.stringify([...d]));
d = SD.deliveredFor('build-boss', [], [stop('build-boss', ['forge-debug'], false)]);
t('an unscanned stop line contributes no opens', d.size === 0, JSON.stringify([...d]));
d = SD.deliveredFor(null, 'junk', 42);
t('total: junk input gives an empty set, no throw', d instanceof Set && d.size === 0);

// assignedFor
t('baseline is an assignment: ui-boss with no map entry gets its role baseline', JSON.stringify(SD.assignedFor('ui-boss', {}, DATA)) === JSON.stringify(DS.baselineFor('ui-boss', DATA)) && SD.assignedFor('ui-boss', {}, DATA).length > 0, JSON.stringify(SD.assignedFor('ui-boss', {}, DATA)));
const asg = SD.assignedFor('build-boss', { 'build-boss': ['frontend-design', 'forge-debug'] }, DATA);
t('map ∪ baseline, deduplicated, map first', asg[0] === 'frontend-design' && asg.filter((s) => s === 'forge-debug').length === 1 && asg.includes('forge-testing'), JSON.stringify(asg));
t('no defaults data: the map alone', JSON.stringify(SD.assignedFor('build-boss', { 'build-boss': ['forge-debug'] }, null)) === '["forge-debug"]');

// judgeDelivery
const judge = (map, starts, stops) => SD.judgeDelivery({ map, startLines: starts, stopLines: stops, data: DATA, known: KNOWN, executorTypes: EXEC });
let sd = judge({ 'build-boss': ['forge-testing'] }, [start('build-boss', ['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail'])], [stop('build-boss', [])]);
t('judge: preload alone delivers a map skill', sd.delivered.includes('build-boss') && !sd.missing.length, JSON.stringify(sd));
sd = judge({ 'build-boss': ['forge-website'] }, [start('build-boss', ['forge-testing'])], [stop('build-boss', ['forge-debug'])]);
t('missing still fails: an assigned skill neither preloaded nor opened is missing, named', sd.missing.length === 1 && sd.missing[0].agent === 'build-boss' && sd.missing[0].skills.includes('forge-website'), JSON.stringify(sd));
sd = judge({ 'verify-boss': ['forge-verify'] }, [start('ui-boss', ['forge-conduct', 'forge-craft', 'forge-ui-polish', 'forge-website'])], [stop('ui-boss', []), stop('verify-boss', ['forge-verify'])]);
t('baseline is an assignment: a dispatched ui-boss with no map entry is not unassigned', !sd.unassigned.includes('ui-boss') && sd.delivered.includes('ui-boss'), JSON.stringify(sd));
sd = judge({ 'verify-boss': ['forge-verify'] }, [start('ui-boss', ['forge-conduct'])], [stop('ui-boss', ['forge-craft'])]);
t('a measured preload that misses baseline skills: the missing baseline skills are named', sd.missing.some((m) => m.agent === 'ui-boss' && m.skills.includes('forge-ui-polish') && !m.skills.includes('forge-craft')), JSON.stringify(sd));
sd = judge({ 'verify-boss': ['forge-verify'] }, [start('ui-boss')], [stop('ui-boss', [])]);
t('an older start hook without skills_preloaded: the baseline is not required (listed as not measured), never unassigned', !sd.unassigned.includes('ui-boss') && !sd.missing.length && sd.baseline_unmeasured.includes('ui-boss'), JSON.stringify(sd));
sd = judge({ 'verify-boss': ['forge-verify'] }, [], [stop('ui-boss', [])]);
t('no defaults for the root (data null): a dispatched executor with no map entry is still unassigned (old rule kept)', SD.judgeDelivery({ map: { 'verify-boss': ['forge-verify'] }, startLines: [], stopLines: [stop('ui-boss', [])], data: null, known: KNOWN, executorTypes: EXEC }).unassigned.includes('ui-boss'));
sd = judge({ 'build-boss': ['forge-debug'] }, [], []);
t('a map agent never dispatched is listed, not failed', sd.not_dispatched.includes('build-boss') && !sd.missing.length, JSON.stringify(sd));
sd = judge({ 'build-boss': ['forge-debug'] }, [start('build-boss', [])], [stop('build-boss', [], false)]);
t('a dispatched agent whose transcript was not scanned and whose preload does not cover the map: not scanned', sd.not_scanned.includes('build-boss') && !sd.missing.length, JSON.stringify(sd));
sd = judge({ 'build-boss': ['forge-debug'] }, [start('build-boss', ['forge-conduct', 'forge-testing', 'forge-debug', 'ponytail'])], [stop('build-boss', [], false)]);
t('... but a preload that covers everything delivers even without a scanned transcript', sd.delivered.includes('build-boss'), JSON.stringify(sd));
sd = SD.judgeDelivery({ map: { 'build-boss': ['forge-debug'] }, startLines: [start('build-boss', ['forge-testing'])], stopLines: [stop('build-boss', ['forge-debug'])], data: DATA, known: new Set(['forge-testing', 'forge-debug']), executorTypes: EXEC });
t('baseline skills that do not exist in this root are not required', !sd.missing.length, JSON.stringify(sd));
t('measured(): stop lines with transcript_scanned or start lines with skills_preloaded', SD.measured([start('x', [])], []) === true && SD.measured([], [stop('x', [])]) === true && SD.measured([start('x')], [{ agent_type: 'x' }]) === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
