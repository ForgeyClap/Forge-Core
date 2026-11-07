#!/usr/bin/env node
'use strict';
/**
 * log-event-owner-override-shape.test.cjs — category tests O24. In windows-game-v2 the Lead logged its own
 * integrator fixes as `owner_override` (agent "Lead", no `rule`, no `by`). The contract never counts such an event, but
 * the ledger then reads as if the owner approved something the owner never saw. Guard: the writer refuses an
 * owner_override that does not name the rule and the owner (`by`); the Lead's own choices go in decision_logged.
 */
const assert = require('assert');
const path = require('path');
const L = require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const ev = (o) => Object.assign({ run_id: 'r-ovr', event_type: 'owner_override' }, o);

t('an owner_override without rule and by (the Lead logging its own fixes) is refused', () => {
  const r = L.validateForWrite(ev({ agent: 'Lead', runtime: 'internal', summary: 'Lead integrator fixes' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/decision_logged/.test(r.message), r.message);
});
t('an owner_override that names a rule but no owner is refused', () => {
  assert.strictEqual(L.validateForWrite(ev({ rule: 'research-done', reason: 'owner said skip research for this one-line fix' })).ok, false);
});
t('a well-formed owner_override (rule + reason + by) passes the shape check', () => {
  const r = L.validateForWrite(ev({ agent: 'orchestrator', rule: 'research-done', reason: 'owner said skip research for this one-line fix', by: 'owner' }));
  assert.ok(r.ok || !/owner_override needs/.test(r.message || ''), r.message);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
