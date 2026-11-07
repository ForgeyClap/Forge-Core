#!/usr/bin/env node
'use strict';
/**
 * forge-gate-scratch-confirm.test.cjs — category tests G-FP3. Clearing my own fixture folder in
 * the OS temp folder with `Remove-Item -LiteralPath "<tmp>\x" -Recurse -Force -Confirm:$false` was blocked as a
 * destructive delete ("no pass-through: unprovable-characters"), although the temp folder is an allowed area and the
 * block message itself says so. The `$` of `-Confirm:$false` was read as a variable; `$true`/`$false` are PowerShell
 * constants (they cannot be reassigned), and `-Confirm:$false` is what the harness tells agents to add. Guard: a
 * PowerShell switch bound to `$true`/`$false` is a provable literal; every other `$` stays unprovable.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hook = require('./forge-gate-hook.cjs');
const gate = require('./forge-actiongate.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-confirm-'));
fs.mkdirSync(path.join(DIR, 'x'), { recursive: true });
const PROJECT = hook.PROJECT_ROOT;
const ctx = () => ({ gate, shell: 'PowerShell', cwd: PROJECT, root: PROJECT, protectedRoots: [PROJECT], tmp: os.tmpdir(), platform: process.platform });
const target = path.join(DIR, 'x');

console.log('forge-gate scratch pass-through: -Confirm:$false (G-FP3)');
t('the real round-6 command (-LiteralPath ... -Recurse -Force -Confirm:$false) on a temp folder passes through', () => {
  const r = hook.scratchPassThrough('Remove-Item -LiteralPath "' + target + '" -Recurse -Force -Confirm:$false', ctx());
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
t('-Confirm:$true and -Force:$true are literals too', () => {
  assert.strictEqual(hook.scratchPassThrough('Remove-Item -Recurse -Force:$true -Confirm:$true "' + target + '"', ctx()).ok, true);
});
t('the same switch on a path OUTSIDE every allowed area is still blocked (only the $ reading changed)', () => {
  const r = hook.scratchPassThrough('Remove-Item -LiteralPath "' + path.join(PROJECT, 'src') + '" -Recurse -Force -Confirm:$false', ctx());
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});
t('a real variable stays unprovable: -Path $target', () => {
  assert.deepStrictEqual(hook.scratchPassThrough('Remove-Item -Recurse -Force -Path $target', ctx()), { ok: false, why: 'unprovable-characters' });
});
t('a look-alike stays unprovable: -Confirm:$falsey and -Confirm:$env:X', () => {
  assert.strictEqual(hook.scratchPassThrough('Remove-Item -Recurse -Force -Confirm:$falsey "' + target + '"', ctx()).ok, false);
  assert.strictEqual(hook.scratchPassThrough('Remove-Item -Recurse -Force -Confirm:$env:X "' + target + '"', ctx()).ok, false);
});
t('$false used as a PATH, not bound to a switch, stays unprovable', () => {
  assert.strictEqual(hook.scratchPassThrough('Remove-Item -Recurse -Force $false', ctx()).ok, false);
});
t('via decide(): the round-6 command is allowed with the pass-through notice', () => {
  const d = hook.decide({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'Remove-Item -LiteralPath "' + target + '" -Recurse -Force -Confirm:$false' }, cwd: PROJECT }, { config: null, projectRoot: PROJECT, tmpdir: os.tmpdir() });
  assert.strictEqual(d.block, false, JSON.stringify(d).slice(0, 300));
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
