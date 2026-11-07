#!/usr/bin/env node
'use strict';
// forge-watch-launch.test.cjs — node:test suite for the watch-skill Python launcher (WP SA-P1-ADAPT, PHASE2-PLAN A10 + E).
// HERMETIC: the Python probe is an injected fake and the skill folder is a fresh os.tmpdir() fixture; the real
// ~/.claude/skills/watch and the real interpreter are never used by these tests.
const { test: nodeTest, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });

const W = require('./forge-watch-launch.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-watch-test-'));
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });
const SKILL = path.join(ROOT, 'watch');
fs.mkdirSync(path.join(SKILL, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(SKILL, 'scripts', 'watch.py'), 'print(1)\n');

const ok = (exe, major) => ({ status: 0, stdout: exe + '\n' + (major || 3) + '\n', stderr: '' });

test('WL-1: candidates put FORGE_PYTHON first, then python, py -3 on Windows, python3 last', () => {
  const c = W.pythonCandidates({ env: { FORGE_PYTHON: 'C:/py/python.exe' }, platform: 'win32' });
  assert.deepStrictEqual(c.map((x) => [x.cmd, x.args]), [['C:/py/python.exe', []], ['python', []], ['py', ['-3']], ['python3', []]]);
  const posix = W.pythonCandidates({ env: {}, platform: 'linux' });
  assert.deepStrictEqual(posix.map((x) => x.cmd), ['python3', 'python']);
});

test('WL-2: resolvePython skips a stub that fails and falls back to py -3', () => {
  const tried = [];
  const run = (cmd, args) => { tried.push(cmd); return cmd === 'python' ? { status: 9009, stdout: '', stderr: 'Python was not found' } : ok('C:\\Py\\python.exe'); };
  const r = W.resolvePython({ env: {}, platform: 'win32', run });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cmd, 'py');
  assert.deepStrictEqual(r.args, ['-3']);
  assert.strictEqual(r.executable, 'C:\\Py\\python.exe');
  assert.deepStrictEqual(tried, ['python', 'py']);
});

test('WL-3: resolvePython rejects Python 2 and spawn errors, and says so when nothing works', () => {
  const run = (cmd) => { if (cmd === 'python') return ok('/usr/bin/python', 2); if (cmd === 'py') return { error: new Error('ENOENT') }; return { status: 1, stdout: '', stderr: '' }; };
  const r = W.resolvePython({ env: {}, platform: 'win32', run });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no working Python 3/);
  assert.strictEqual(r.tried.length, 3);
});

test('WL-4: resolveScript accepts a bundled script name and refuses traversal or unknown names', () => {
  assert.strictEqual(W.resolveScript(SKILL, 'watch.py'), path.join(SKILL, 'scripts', 'watch.py'));
  assert.throws(() => W.resolveScript(SKILL, '../evil.py'), /invalid script name/);
  assert.throws(() => W.resolveScript(SKILL, 'watch.sh'), /invalid script name/);
  assert.throws(() => W.resolveScript(SKILL, 'nope.py'), /not found/);
});

test('WL-5: buildInvocation puts interpreter args, script path, then the user args in order', () => {
  const inv = W.buildInvocation({ ok: true, cmd: 'py', args: ['-3'] }, path.join(SKILL, 'scripts', 'watch.py'), ['https://x', '--start', '1:00']);
  assert.strictEqual(inv.cmd, 'py');
  assert.deepStrictEqual(inv.args, ['-3', path.join(SKILL, 'scripts', 'watch.py'), 'https://x', '--start', '1:00']);
});

test('WL-6: skillDir honours WATCH_SKILL_DIR and defaults to ~/.claude/skills/watch', () => {
  assert.strictEqual(W.skillDir({ env: { WATCH_SKILL_DIR: SKILL }, home: 'H' }), SKILL);
  assert.strictEqual(W.skillDir({ env: {}, home: 'H' }), path.join('H', '.claude', 'skills', 'watch'));
});

test('WL-7: smoke runs watch.py --help through the resolved interpreter and checks the usage text', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return args.includes('--help') ? { status: 0, stdout: 'usage: watch [-h] source\n', stderr: '' } : ok('C:\\Py\\python.exe'); };
  const r = W.smoke({ env: { WATCH_SKILL_DIR: SKILL }, platform: 'win32', run });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const last = calls[calls.length - 1];
  assert.deepStrictEqual(last[1].slice(-2), [path.join(SKILL, 'scripts', 'watch.py'), '--help']);
  const bad = W.smoke({ env: { WATCH_SKILL_DIR: SKILL }, platform: 'win32', run: (c, a) => (a.includes('--help') ? { status: 1, stdout: '', stderr: 'ImportError' } : ok('x')) });
  assert.strictEqual(bad.ok, false);
});

test('HELP-1: forge-watch-launch.cjs --help and -h print usage and exit 0 without probing', () => {
  const { spawnSync } = require('child_process');
  for (const flag of ['--help', '-h']) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-watch-launch.cjs'), flag], { encoding: 'utf8', env: { ...process.env, GRAPHIFY_BIN: 'C:\no\such\graphify.exe' } });
    assert.strictEqual(r.status, 0, flag + ' exit ' + r.status + ' ' + r.stderr);
    assert.match(r.stdout, /usage:/i);
  }
});
