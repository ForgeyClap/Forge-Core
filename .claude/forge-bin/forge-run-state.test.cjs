#!/usr/bin/env node
'use strict';
// forge-run-state.test.cjs — tests the durable-resume projector. A completed agent is not
// resumed; an agent that started with no terminal is unfinished; a failed agent is queued for redo; a
// side-effecting last step raises an idempotency warning; a blocked gate makes the run resumable.
// Convention: prints "<N> passed, <M> failed"; exit non-zero on any failure.
const assert = require('assert');
const { projectRunState } = require('./forge-run-state.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge durable-resume projector tests');
const events = [
  { agent: 'Build Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'subagent_completed', timestamp: '2026-07-11T00:00:10Z' },
  { agent: 'Test Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:05Z' }, // no terminal -> unfinished
  { agent: 'Integration Boss', event_type: 'subagent_started', task: 'send lead email', timestamp: '2026-07-11T00:00:06Z' },
  { agent: 'Integration Boss', event_type: 'subagent_failed', task: 'send lead email', timestamp: '2026-07-11T00:00:12Z' },
];
const st = projectRunState('r1', events);

t('completed agent is NOT resumed', () => assert.ok(!st.resume.includes('Build Boss')));
t('agent started with no terminal is unfinished + resumable', () => assert.ok(st.unfinished.includes('Test Boss') && st.resume.includes('Test Boss')));
t('failed agent is queued for redo', () => assert.ok(st.failed.includes('Integration Boss') && st.resume.includes('Integration Boss')));
t('side-effecting failed step raises an idempotency warning', () => assert.ok(st.side_effect_warnings.includes('Integration Boss')));
t('run is marked resumable when work remains', () => assert.strictEqual(st.resumable, true));

const clean = projectRunState('r2', [
  { agent: 'Build Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'subagent_completed', timestamp: '2026-07-11T00:00:10Z' },
  { event_type: 'quality_gate_passed', gate: 'integration', command: 'npm test', exit_code: 0, evidence: 'x' },
]);
t('a fully-completed run with a passed gate is COMPLETE (nothing to resume)', () => assert.ok(clean.complete && !clean.resumable && clean.resume.length === 0));

const blocked = projectRunState('r3', [
  { agent: 'Build Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'subagent_completed', timestamp: '2026-07-11T00:00:10Z' },
  { event_type: 'quality_gate_blocked', gate: 'integration', note: 'tests failed' },
]);
t('a blocked gate makes an otherwise-finished run resumable', () => assert.ok(blocked.blocked_gates.includes('integration') && blocked.resumable));

// FB-CONTRACT-2-F1 / F9 / F11: a re-dispatched Boss and a cleared brake block.
const redispatch = projectRunState('r4', [
  { agent: 'Verify Boss', event_type: 'agent_started', wp_id: 'WP1', timestamp: '2026-11-12T00:00:00Z' },
  { agent: 'Verify Boss', event_type: 'agent_completed', wp_id: 'WP1', timestamp: '2026-11-12T00:00:10Z' },
  { agent: 'Verify Boss', event_type: 'agent_started', wp_id: 'WP2', timestamp: '2026-11-12T00:00:20Z' },
]);
t('started -> completed -> started again (next WP) is resumed, not COMPLETE', () => assert.ok(redispatch.resume.includes('Verify Boss') && redispatch.complete === false));
t('the resume plan names the unfinished work package', () => assert.ok(redispatch.resume_wps.includes('WP2') && !redispatch.resume_wps.includes('WP1')));
const redoFail = projectRunState('r5', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'WP1' },
  { agent: 'Build Boss', event_type: 'agent_completed', wp_id: 'WP1' },
  { agent: 'Build Boss', event_type: 'agent_failed', wp_id: 'WP2' },
]);
t('completed WP1 then failed WP2 is queued for redo', () => assert.ok(redoFail.failed.includes('Build Boss') && redoFail.resume.includes('Build Boss') && redoFail.resumable));
const sameNoWp = projectRunState('r6', [
  { agent: 'Test Boss', event_type: 'subagent_started' },
  { agent: 'Test Boss', event_type: 'subagent_completed' },
  { agent: 'Test Boss', event_type: 'subagent_started' },
]);
t('without wp_id the last start decides (re-dispatch after a completion is unfinished)', () => assert.ok(sameNoWp.unfinished.includes('Test Boss')));
const parallel = projectRunState('r7', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'WP1' },
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'WP2' },
  { agent: 'Build Boss', event_type: 'agent_completed', wp_id: 'WP1' },
]);
t('two parallel WPs of one Boss: completing one does not close the other', () => assert.ok(parallel.resume_wps.includes('WP2') && parallel.complete === false));
const wpTerminal = projectRunState('r8', [
  { agent: 'UI Boss', event_type: 'agent_started', wp_id: 'WP3' },
  { event_type: 'wp_completed', wp_id: 'WP3' },
]);
t('wp_completed is a terminal event for that work package', () => assert.ok(wpTerminal.complete && wpTerminal.resume.length === 0));
// Rework (Verify Boss FAIL): a unit is one agent on one work package, not the work package alone.
const twoOnOne = projectRunState('r11', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Test Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Test Boss', event_type: 'agent_completed', wp_id: 'W1' },
]);
t('two agents on one wp: one completing does not close the other', () => assert.deepStrictEqual([twoOnOne.resume, twoOnOne.complete], [['Build Boss'], false]));
const verifierCrash = projectRunState('r12', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Build Boss', event_type: 'agent_completed', wp_id: 'W1' },
  { agent: 'Verify Boss', event_type: 'agent_started', wp_id: 'W1' },
]);
t('a verifier that crashes on a built wp is resumed by its own name', () => assert.deepStrictEqual(verifierCrash.resume, ['Verify Boss']));
const wpCloseAll = projectRunState('r13', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Test Boss', event_type: 'agent_started', wp_id: 'W1' },
  { event_type: 'wp_completed', wp_id: 'W1' },
]);
t('an agent-less wp_completed closes every unit of that wp', () => assert.ok(wpCloseAll.complete && wpCloseAll.resume.length === 0));
const leadClose = projectRunState('r14', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Verify Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'orchestrator', event_type: 'wp_completed', wp_id: 'W1' },
]);
t('a wp_completed by an agent with no unit on that wp (the Lead) closes every unit of it', () => assert.ok(leadClose.complete && leadClose.resume.length === 0));
const wpFailAll = projectRunState('r15', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Test Boss', event_type: 'agent_started', wp_id: 'W1' },
  { event_type: 'wp_failed', wp_id: 'W1' },
]);
t('an agent-less wp_failed queues every unit of that wp for redo', () => assert.deepStrictEqual(wpFailAll.failed.slice().sort(), ['Build Boss', 'Test Boss']));
// Follow-up (Verify Boss probe B10): wp_completed / wp_failed close the whole wp whoever logs them.
const workerClose = projectRunState('r16', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Verify Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Build Boss', event_type: 'wp_completed', wp_id: 'W1' },
]);
t('a worker wp_completed while a verifier unit on that wp is open closes both', () => assert.ok(workerClose.complete && workerClose.resume.length === 0));
const phantomClose = projectRunState('r17', [
  { agent: 'Build Boss', event_type: 'wp_completed', wp_id: 'W1' },
  { agent: 'Verify Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Build Boss', event_type: 'wp_completed', wp_id: 'W1' },
]);
t('a wp_completed from an agent with only a phantom unit on that wp still closes every unit', () => assert.ok(phantomClose.complete && phantomClose.resume.length === 0));
const workerFail = projectRunState('r18', [
  { agent: 'Search Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Verify Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Search Boss', event_type: 'wp_failed', wp_id: 'W1' },
]);
t('a worker wp_failed queues every unit of that wp for redo', () => assert.deepStrictEqual(workerFail.failed.slice().sort(), ['Search Boss', 'Verify Boss']));
const agentDoneStays = projectRunState('r19', [
  { agent: 'Build Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Verify Boss', event_type: 'agent_started', wp_id: 'W1' },
  { agent: 'Build Boss', event_type: 'agent_completed', wp_id: 'W1' },
]);
t('agent_completed still closes only its own unit on a shared wp', () => assert.deepStrictEqual(agentDoneStays.resume, ['Verify Boss']));

const brake = projectRunState('r9', [
  { agent: 'Build Boss', event_type: 'subagent_started' },
  { agent: 'Build Boss', event_type: 'subagent_completed' },
  { event_type: 'quality_gate_blocked', note: 'BRAKE: verifier FAIL on WP1' },
  { event_type: 'quality_gate_passed', gate: 'final', exit_code: 0 },
]);
t('a note-only brake block is cleared by a later gate pass', () => assert.ok(brake.blocked_gates.length === 0 && brake.complete === true));
const namedStays = projectRunState('r10', [
  { event_type: 'quality_gate_blocked', gate: 'integration', note: 'tests failed' },
  { event_type: 'quality_gate_passed', gate: 'final' },
]);
t('a named blocked gate is NOT cleared by a pass of a different named gate', () => assert.ok(namedStays.blocked_gates.includes('integration')));

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
