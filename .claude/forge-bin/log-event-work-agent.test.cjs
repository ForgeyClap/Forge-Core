#!/usr/bin/env node
'use strict';
/**
 * log-event-work-agent.test.cjs — category tests L1 (end of round 7). The category-test run's Lead logged a
 * decision_logged and a wp_completed with no `agent`. The writer accepted both; at the end the run contract's rule
 * independent-verification failed for good ("er is werk gelogd ZONDER agent ... fail-closed"), and an append-only
 * ledger cannot be repaired afterwards. Guard (the writer's own validateForWrite, so no file is written): a hand-logged
 * work event (wp_completed, wp_failed, decision_logged) without a non-empty agent is refused with the shape to use;
 * the same event with an agent passes this guard; other events are not touched by it.
 */
const assert = require('assert');
const path = require('path');
const L = require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const PROOF = { command: 'node x.test.cjs', summary: 'x' };
const ev = (type, o) => Object.assign({ run_id: 'r-work-agent', event_type: type }, o);
const refusedForAgent = (r) => r.ok === false && /needs an agent/i.test(r.message || '') && /"agent"/.test(r.message || '');
const notRefusedForAgent = (r) => r.ok || !/needs an agent/i.test(r.message || '');

console.log('log-event: hand-logged work events need an agent (L1)');
const CASES = [
  ['decision_logged', { decision: 'use the real installer' }],
  ['wp_completed', Object.assign({ wp_id: 'W1' }, PROOF)],
  ['wp_failed', Object.assign({ wp_id: 'W1' }, PROOF)],
];
for (const [type, payload] of CASES) {
  t('the real round-7 shape: ' + type + ' without agent is refused, naming the agent field', () => assert.ok(refusedForAgent(L.validateForWrite(ev(type, payload)))));
  t(type + ' with a blank agent is refused too', () => assert.ok(refusedForAgent(L.validateForWrite(ev(type, Object.assign({ agent: '   ' }, payload))))));
  t(type + ' WITH an agent passes this guard', () => assert.ok(notRefusedForAgent(L.validateForWrite(ev(type, Object.assign({ agent: 'orchestrator' }, payload))))));
}
t('an event outside the hand-logged work set is not touched (agent_note without agent)', () => assert.ok(notRefusedForAgent(L.validateForWrite(ev('agent_note', { note: 'x' })))));
t('the guard is not opt-out: FORGE_STRICT_EVENTS=0 still refuses an agentless wp_completed', () => {
  const prev = process.env.FORGE_STRICT_EVENTS;
  process.env.FORGE_STRICT_EVENTS = '0';
  try { assert.ok(refusedForAgent(L.validateForWrite(ev('wp_completed', Object.assign({ wp_id: 'W1' }, PROOF))))); }
  finally { if (prev === undefined) delete process.env.FORGE_STRICT_EVENTS; else process.env.FORGE_STRICT_EVENTS = prev; }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
