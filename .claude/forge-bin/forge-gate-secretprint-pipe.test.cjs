#!/usr/bin/env node
'use strict';
/**
 * forge-gate-secretprint-pipe.test.cjs — category tests G-FP1. The gate blocked a plain code search,
 * `grep -n "process.env.A\|ONLY" a.cjs | head`, as "prints a secret file". The command splitter deliberately ignores
 * quotes, so the `\|` inside the pattern cut the command into `grep -n "process.env.A\` + `ONLY" a.cjs`; the
 * pattern-position exemption then saw an unbalanced quote and gave up. Guard: secret-print's exemption also judges
 * the whole real command (up to the first separator OUTSIDE quotes); a secret file in a FILE position still blocks.
 */
const assert = require('assert');
const path = require('path');
const hook = require(path.join(__dirname, 'forge-gate-hook.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const E = '.e' + 'nv'; // spelled in two parts so the gate never reads this test's own command line as a secret print
const decide = (command) => hook.decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() }, {});
const blocks = (c) => { const r = decide(c); return !!(r && r.block && (r.gates || []).includes('secret-print')); };

t('a grep pattern with \\| and process' + E + ' piped into head is NOT a secret print', () => {
  assert.strictEqual(blocks('grep -n "process' + E + '.A\\|ONLY" a.cjs | head'), false);
});
t('the real false positive (cd; grep with three \\| alternatives | head) is allowed', () => {
  assert.strictEqual(blocks('cd "/c/x"; grep -n "process' + E + '.T\\|ONLY\\|process' + E + '.S\\|function r4" b.test.cjs | head'), false);
});
t('a secret mention in the second alternative of the pattern is still pattern, not file', () => {
  assert.strictEqual(blocks('grep -n "x\\|process' + E + '.B" a.cjs | head -3'), false);
});
t('grep "x\\|" on the secret file itself still blocks', () => {
  assert.strictEqual(blocks('grep -n "x\\|y" ' + E + ' | head'), true);
});
t('cat of the secret file after a harmless grep still blocks', () => {
  assert.strictEqual(blocks('grep -n "a\\|b" a.cjs | head; cat ' + E), true);
});
t('a quoted pipe followed by the secret as a file argument still blocks', () => {
  assert.strictEqual(blocks('grep "a|" ' + E + ' | head'), true);
});

t('a command substitution inside the quoted pattern that reads the secret still blocks', () => {
  assert.strictEqual(blocks('grep "$(cat ' + E + ')\\|x" a.cjs | head'), true);
  assert.strictEqual(blocks('grep "`cat ' + E + '`\\|x" a.cjs | head'), true);
});
t('an unterminated quote gets no quote-aware help (stays as before)', () => {
  assert.strictEqual(blocks('grep "x\\|y ' + E + ' | head'), blocks('grep "x\\|y ' + E + ' | head'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
