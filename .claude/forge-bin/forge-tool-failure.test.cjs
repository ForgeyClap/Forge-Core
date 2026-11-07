#!/usr/bin/env node
'use strict';
/**
 * forge-tool-failure.test.cjs — the PostToolUseFailure hook (plan item 1.6). Throwaway project roots only
 * (os.mkdtemp, removed at the end); the real project is never written. Covers: payload parsing into the
 * forge-toolhook line shape (ok:false), error classification, secret scrubbing found ON DISK (not just in the
 * return value), fail-open on garbage stdin through the real CLI (exit 0, empty stdout), opt-outs, oversized
 * payload salvage, and a runtime well under the 5 s settings timeout. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TF = require('./forge-tool-failure.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const roots = [];
const mkRoot = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tf-')); fs.mkdirSync(path.join(r, '.claude')); roots.push(r); return r; };
const SCRIPT = path.join(__dirname, 'forge-tool-failure.cjs');
const cli = (root, input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', timeout: 10000,
  env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, FORGE_PROJECT_ROOT: root, FORGE_TOOL_FAILURE_HOOK: '' }) });
const logOf = (root, session) => path.join(root, '.claude', 'forge-runs', '_toollog', session + '.jsonl');
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// Secret-shaped canaries are assembled at run time so no literal key sits in the source.
const SK = 'sk' + '-' + 'canaryTOOLFAIL0123456789abcdef';
const GH = 'gh' + 'p_' + 'A'.repeat(24) + 'canary';

try {
  console.log('\nA) classification + line shape (library)');
  t('A1 classifyError: interrupt wins', TF.classifyError('anything', true) === 'interrupted');
  t('A2 classifyError: exit code', TF.classifyError('Command failed: Exit code 1') === 'exit-code');
  t('A3 classifyError: not-found', TF.classifyError('ENOENT: no such file or directory') === 'not-found');
  t('A4 classifyError: permission', TF.classifyError('Permission denied by hook') === 'permission');
  t('A5 classifyError: timeout', TF.classifyError('Command timed out after 120000ms') === 'timeout');
  t('A6 classifyError: empty -> none, odd -> other', TF.classifyError('') === 'none' && TF.classifyError('weird thing') === 'other');
  t('A7 every class is a known constant', ['x', 'Exit code 2', 'EACCES', 'ECONNRESET', 'invalid input'].every((s) => TF.ERROR_CLASSES.includes(TF.classifyError(s))));
  t('A8 flattenError: control chars flattened, object.message accepted', TF.flattenError('a\nb\tc') === 'a b c' && TF.flattenError({ message: 'm' }) === 'm' && TF.flattenError(42) === null);

  const root = mkRoot();
  const payload = {
    session_id: 'sess-tf-1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_01',
    tool_input: { command: 'npm test -- --token ' + SK }, error: 'Exit code 1\nauth failed for ' + GH + ' (' + SK + ')',
    agent_id: 'a1', agent_type: 'build-boss', is_interrupt: false,
  };
  const r = TF.run(JSON.stringify(payload), { root, configModule: null, env: {} });
  t('A9 run writes one line', r.ok && r.wrote === true, JSON.stringify(r));
  const lines = readLines(logOf(root, 'sess-tf-1'));
  const L = lines[0] || {};
  t('A10 line is the forge-toolhook shape with ok:false', lines.length === 1 && L.ok === false && L.ok_basis === 'is_error' && L.tool === 'Bash' && L.target === 'npm' && L.target_kind === 'command' && L.session === 'sess-tf-1' && L.agent_type === 'build-boss' && L.tool_use_id === 'toolu_01', JSON.stringify(L));
  t('A11 failure fields present: failure, hook, error_class', L.failure === true && L.hook === 'PostToolUseFailure' && L.error_class === 'exit-code', JSON.stringify(L));
  t('A12 error is single-line and capped at 200 chars', typeof L.error === 'string' && !/\n/.test(L.error) && L.error.length <= 200, L.error);

  console.log('\nB) secret scrubbing — canaries hunted on disk');
  const disk = fs.readFileSync(logOf(root, 'sess-tf-1'), 'utf8');
  t('B1 neither canary reached disk', !disk.includes('canaryTOOLFAIL') && !disk.includes('canary') , disk.slice(0, 400));
  t('B2 the command arguments never reach disk', !disk.includes('--token'), disk.slice(0, 400));
  const r2 = TF.run(JSON.stringify({ session_id: SK, tool_name: 'Read', error: 'x' }), { root, configModule: null, env: {} });
  t('B3 a secret-shaped session id becomes unknown-session (not a filename)', r2.wrote && fs.existsSync(logOf(root, 'unknown-session')) && !fs.readdirSync(path.dirname(logOf(root, 'x'))).some((n) => n.includes('canary')));
  const long = 'x'.repeat(180) + ' ' + SK + ' tail';
  TF.run(JSON.stringify({ session_id: 'sess-tf-2', tool_name: 'Bash', error: long }), { root, configModule: null, env: {} });
  t('B4 a secret straddling the 200-char cap is redacted before the cut', !fs.readFileSync(logOf(root, 'sess-tf-2'), 'utf8').includes('sk-canary'));

  console.log('\nC) fail-open + opt-outs');
  for (const [name, input] of [['garbage', 'not json {{{'], ['empty', ''], ['array', '[1,2]'], ['no tool_name', '{"session_id":"s"}'], ['binary', '\u0000\u0001ÿ']]) {
    const c = cli(mkRoot(), input);
    t('C1 CLI on ' + name + ' stdin: exit 0, empty stdout', c.status === 0 && c.stdout === '', JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  }
  t('C2 library never throws on undefined / null', TF.run(undefined, { root: mkRoot() }).ok === true && TF.run(null, { root: mkRoot() }).ok === true);
  const offRoot = mkRoot();
  t('C3 FORGE_TOOL_FAILURE_HOOK=off writes nothing', TF.run(JSON.stringify(payload), { root: offRoot, env: { FORGE_TOOL_FAILURE_HOOK: 'off' } }).wrote === false && !fs.existsSync(path.join(offRoot, '.claude', 'forge-runs')));
  const cfgOff = { safeGet: () => ({ value: false, source: 'test', degraded: false, reason: null }) };
  t('C4 owner config tool-log=off writes nothing', TF.run(JSON.stringify(payload), { root: offRoot, configModule: cfgOff, env: {} }).reason === 'owner config tool-log=off');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tf-bare-')); roots.push(bare);
  t('C5 a folder without .claude/ gets no stray tree', TF.run(JSON.stringify(payload), { root: bare, env: {} }).wrote === false && !fs.existsSync(path.join(bare, '.claude')));

  console.log('\nD) CLI end to end + oversized payload + timing');
  const cr = mkRoot();
  const t0 = Date.now();
  const c = cli(cr, JSON.stringify(payload));
  const ms = Date.now() - t0;
  t('D1 CLI writes the line, exit 0, empty stdout', c.status === 0 && c.stdout === '' && readLines(logOf(cr, 'sess-tf-1')).length === 1, JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  t('D2 runtime under 5 s (measured ' + ms + ' ms)', ms < 5000);
  const big = JSON.stringify({ session_id: 'sess-big', tool_name: 'Bash', tool_use_id: 'toolu_big', error: 'E'.repeat(400000) + SK });
  const cb = cli(cr, big);
  const bl = readLines(logOf(cr, 'sess-big'));
  t('D3 oversized payload is salvaged: one truncated line, error_class unknown, no error text', cb.status === 0 && cb.stdout === '' && bl.length === 1 && bl[0].truncated === true && bl[0].error_class === 'unknown' && bl[0].error === undefined, JSON.stringify(bl));
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-tool-failure tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
