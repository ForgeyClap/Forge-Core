#!/usr/bin/env node
'use strict';
/**
 * log-event-skillmap-shape.test.cjs — category tests round 5. windows-game-v5's Lead logged its skill map
 * keyed by work package with free text and no agent type ({" ":"forge-game (playbook) + docs/CONTRACT.md", ...}).
 * Nothing can tell which agent should open which skill, so no agent got its skills and the contract can only fail at the
 * very end. Guard: the writer refuses a skill_map_created whose map assigns no real skill to any agent type, and says the
 * shape to log, so the Lead fixes it BEFORE it dispatches. A good map (agent type -> real skill folders) passes.
 */
const assert = require('assert');
const path = require('path');
const L = require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const ev = (o) => Object.assign({ run_id: 'r-skillmap', event_type: 'skill_map_created', agent: 'orchestrator' }, o);
const refusedForShape = (r) => r.ok === false && /skill_map_created/.test(r.message || '') && /<agent-type>/.test(r.message || '');

t('the real windows-v5 map (WP keys, free text, no agent type) is refused with the shape to log', () => {
  const r = L.validateForWrite(ev({ map: { 'WP-A': 'forge-game (playbook) + docs/CONTRACT.md', 'WP-B': 'forge-game audio lane + WebAudio method', 'WP-C': 'forge-electron method (safe IPC, contextIsolation, sandbox) - Lead' } }));
  assert.ok(refusedForShape(r), JSON.stringify(r));
});
t('a map naming only skills that do not exist is refused', () => {
  assert.ok(refusedForShape(L.validateForWrite(ev({ map: { 'ui-boss': ['no-such-skill-xyz'] } }))));
});
t('the restaurant map (agent type -> real skill folders) passes the shape check', () => {
  const r = L.validateForWrite(ev({ map: { 'ui-boss': ['frontend-design', 'forge-website'], 'test-boss': ['forge-testing'] } }));
  assert.ok(r.ok || !/<agent-type>/.test(r.message || ''), JSON.stringify(r));
});
t('the windows-v4 style ("build-boss: forge-game ...") still passes (agent type before the colon)', () => {
  const r = L.validateForWrite(ev({ map: { WP2: 'build-boss: forge-game domain gates + GAME_SPEC s2-3' } }));
  assert.ok(r.ok || !/<agent-type>/.test(r.message || ''), JSON.stringify(r));
});
// SK5: restaurant-v6's Lead put the whole map in `summary`, android-v6's in `message`; with no map field the
// first guard let it through, no agent got its skills, and android re-dispatched its builders after the fact.
t('SK5: the real restaurant-v6 event (map only as free text in summary) is refused with the shape', () => {
  assert.ok(refusedForShape(L.validateForWrite(ev({ summary: 'WP-1 ui-boss: frontend-design (global) + forge-website card; WP-2 build-boss: forge-website + node:test; WP-3 Lead: serve.mjs; verify: verify-boss' }))));
});
t('SK5: the real android-v6 event (map only as free text in message) is refused with the shape', () => {
  assert.ok(refusedForShape(L.validateForWrite(ev({ message: 'Skills: forge-game (loaded), forge-mobile, frontend-design guidance in UI brief. WP1 build-boss deep, WP3 ui-boss build' }))));
});
t('SK5: a map given as a JSON string is refused too (the map must be an object)', () => {
  assert.ok(refusedForShape(L.validateForWrite(ev({ map: '{"ui-boss":["frontend-design"]}' }))));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
