#!/usr/bin/env node
'use strict';
/**
 * forge-active-run-session-shape.test.cjs — category tests round 4. In two of three v4 runs no SubagentStart
 * hook line carried the run, so no agent got its skills injected. The Lead had pointed the run with a session id from
 * CLAUDE_SESSION_ID ("session-1794034522131"), but hooks receive Claude Code's session UUID ("70bba3da-..."); the reader
 * took the pointer for "another session's" and ignored it. Guard: an id that is not a Claude Code session UUID cannot be
 * compared, so it does not bind the pointer (set records no session for it; the reader treats it as unbound). Two real
 * UUID sessions stay isolated.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const AR = require('./forge-active-run.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-active-run-shape-'));
const RUN = 'forge-2026-11-07-075540';
const HOOK_SESSION = '70bba3da-f5d6-43c6-9fed-4b445e5102e1';
const OTHER_UUID = 'ee26b01a-a533-456f-96aa-9fb6d0a941d9';
function project() {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', RUN), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', RUN, 'events.jsonl'), '');
  return root;
}

t('a pointer set with a non-Claude session id ("session-<ms>") is read by the hook session', () => {
  const root = project();
  const s = AR.setActiveRun(root, RUN, { session: 'session-1794034522131' });
  assert.ok(s.ok, JSON.stringify(s));
  const r = AR.readActiveRun(root, HOOK_SESSION);
  assert.strictEqual(r.run, RUN, JSON.stringify(r));
});
t('an existing fallback file that names a non-UUID session is treated as unbound', () => {
  const root = project();
  const dir = path.join(root, '.claude', 'forge-runs', '_hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-run.json'), JSON.stringify({ schema: 'forge-active-run/1', run: RUN, session: 'session-1794034522131', set_at: new Date().toISOString() }));
  assert.strictEqual(AR.readActiveRun(root, HOOK_SESSION).run, RUN);
});
t('two real Claude session UUIDs stay isolated: another session\'s fallback is still ignored', () => {
  const root = project();
  AR.setActiveRun(root, RUN, { session: OTHER_UUID });
  const r = AR.readActiveRun(root, HOOK_SESSION);
  assert.strictEqual(r.run, null, JSON.stringify(r));
});
t('the same UUID session still reads its own pointer', () => {
  const root = project();
  AR.setActiveRun(root, RUN, { session: HOOK_SESSION });
  assert.strictEqual(AR.readActiveRun(root, HOOK_SESSION).run, RUN);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
