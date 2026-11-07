#!/usr/bin/env node
'use strict';
// forge-stop-open-subagents.test.cjs — I.8 OPEN-SUBAGENTS (category finding H1): the Stop hook blocks
// while THIS session has subagents that started (harness SubagentStart line, within 2 hours) and never stopped (no
// SubagentStop line with the same agent_id), because a headless session that ends its turn gets them killed. Capped at
// OPEN_SUB_MAX_BLOCKS blocks per session, then advisory only. HERMETIC: every fixture is a fresh os.tmpdir() project.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const OBL = require('./forge-stop-obligations.cjs');

delete process.env.FORGE_STATE_DIR;
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
}

const CLI = path.join(__dirname, 'forge-stop-obligations.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fso-open-'));
const SID = '9ed27d95-0000-4000-8000-0000000open1';
const OTHER = 'aaaaaaaa-1111-4111-8111-111111111111';
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;

function proj(name) {
  const root = path.join(TMP, name + '-' + (++seq));
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', '_hooks'), { recursive: true });
  return root;
}
const hooks = (root) => path.join(root, '.claude', 'forge-runs', '_hooks');
function line(root, file, rec) { fs.appendFileSync(path.join(hooks(root), file), JSON.stringify(rec) + '\n'); }
function start(root, sid, id, type, ms) { line(root, 'subagent-start.jsonl', { ts: iso(ms || NOW - 5 * 60e3), event: 'SubagentStart', session: sid, agent_id: id, agent_type: type || 'build-boss' }); }
function stopLine(root, sid, id) { line(root, 'subagent-stop.jsonl', { ts: iso(NOW - 60e3), event: 'SubagentStop', session: sid, agent_id: id, agent_type: 'build-boss' }); }
function stop(root, payload, opts) {
  return OBL.runStop(Object.assign({ hook_event_name: 'Stop', stop_hook_active: false, session_id: SID }, payload || {}),
    Object.assign({ projectRoot: root, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, runcontract: null, scribeStore: null, now: NOW }, opts || {}));
}
function spawnStop(root, input) {
  const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }); // headless, as `claude -p` sets it
  for (const k of ['FORGE_STOP_OBLIGATIONS', 'FORGE_RUN_REQUIRED_STOP', 'FORGE_OPEN_SUBAGENTS_STOP', 'FORGE_RUN_ID', 'FORGE_STATE_DIR']) delete env[k];
  return spawnSync(process.execPath, [CLI], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env, timeout: 15000 });
}

console.log('forge-stop-obligations I.8 open-subagents tests');

t('blocks while this session has an open subagent; the reason names count, types, NL + EN and the exact wait command', () => {
  const root = proj('open');
  start(root, SID, 'a1', 'build-boss');
  start(root, SID, 'a2', 'test-boss');
  stopLine(root, SID, 'a2');
  const r = stop(root);
  assert.strictEqual(r.block, true, JSON.stringify(r));
  assert.strictEqual(r.open_subagents.count, 1);
  const m = r.block_text;
  for (const s of ['1 subagent', 'build-boss', 'EN: ', 'NL: ', 'headless', 'node .claude/forge-bin/forge-wait.cjs --session ' + SID, 'FORGE_OPEN_SUBAGENTS_STOP=off']) {
    assert.ok(m.includes(s), 'missing "' + s + '" in:\n' + m);
  }
  assert.ok(!m.includes('test-boss'), 'a stopped agent is not listed');
});
t('nothing open (all stopped, none started, other session only, older than 2 h): no block, nothing printed', () => {
  const root = proj('closed');
  start(root, SID, 'c1');
  stopLine(root, SID, 'c1');
  start(root, OTHER, 'o1');
  start(root, SID, 'old', 'x', NOW - 2 * 3600e3 - 60e3);
  const r = stop(root);
  assert.strictEqual(r.block, false, JSON.stringify(r));
  assert.strictEqual(r.print, false);
  assert.strictEqual(fs.existsSync(path.join(hooks(root), OBL.OPEN_SUB_STATE_DIR)), false, 'no state written when nothing is open');
  assert.strictEqual(stop(root, { session_id: OTHER }).block, true, 'the other session does have one open');
});
t('cap: at most OPEN_SUB_MAX_BLOCKS blocks per session, then advisory only (systemMessage), never a trap', () => {
  const root = proj('cap');
  start(root, SID, 'hung', 'build-boss');
  assert.strictEqual(OBL.OPEN_SUB_MAX_BLOCKS, 6);
  for (let i = 1; i <= 6; i++) assert.strictEqual(stop(root, { stop_hook_active: i > 1 }).block, true, 'block ' + i);
  const r = stop(root, { stop_hook_active: true });
  assert.strictEqual(r.block, false, 'the 7th stop is not blocked');
  assert.strictEqual(r.print, true);
  assert.ok(/still running/.test(r.text) && r.text.includes('forge-wait.cjs --session ' + SID), r.text);
  assert.strictEqual(stop(root, { session_id: OTHER }).block, false, 'other session has nothing open');
  start(root, OTHER, 'o2');
  assert.strictEqual(stop(root, { session_id: OTHER }).block, true, 'the cap is per session');
});
t('stop_hook_active: I.8 still blocks (bounded by its cap: a wait that timed out must not end the turn), while the I.7 and advisory parts stay silent as before', () => {
  const root = proj('sha');
  start(root, SID, 'a1');
  const r = stop(root, { stop_hook_active: true });
  assert.strictEqual(r.block, true);
  assert.strictEqual(r.norun, null, 'I.7 is not evaluated under stop_hook_active');
  assert.ok(/stop_hook_active/.test(r.reason), r.reason);
});
t('I.7 and I.8 both firing give ONE block whose reason carries both messages', () => {
  const root = proj('both');
  for (const id of ['s1', 's2', 's3']) { start(root, SID, id); stopLine(root, SID, id); }
  start(root, SID, 'open1', 'ui-boss');
  const r = stop(root);
  assert.strictEqual(r.block, true);
  assert.ok(r.block_text.includes('No mission run') && r.block_text.includes('forge-wait.cjs'), r.block_text);
});
t('env FORGE_OPEN_SUBAGENTS_STOP=off and an unusable session_id never block', () => {
  const root = proj('off');
  start(root, SID, 'a1');
  assert.strictEqual(stop(root, {}, { env: { FORGE_OPEN_SUBAGENTS_STOP: 'off' } }).block, false);
  for (const bad of ['', '../x', 'unknown-session', 42, null]) assert.strictEqual(stop(root, { session_id: bad }).block, false, JSON.stringify(bad));
});
t('an interactive session (CLAUDE_CODE_ENTRYPOINT=cli, or unset) is never blocked; FORGE_OPEN_SUBAGENTS_STOP=on forces it', () => {
  const root = proj('interactive');
  start(root, SID, 'i1');
  assert.strictEqual(stop(root, {}, { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }).block, false);
  assert.strictEqual(stop(root, {}, { env: {} }).block, false);
  assert.strictEqual(stop(root, {}, { env: { CLAUDE_CODE_ENTRYPOINT: 'cli', FORGE_OPEN_SUBAGENTS_STOP: 'on' } }).block, true);
});
t('CLI: an open subagent prints {"decision":"block"} and exit 0; nothing open prints nothing', () => {
  const root = proj('cli');
  start(root, SID, 'a1', 'test-boss');
  const r = spawnStop(root, { hook_event_name: 'Stop', session_id: SID, stop_hook_active: false });
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.decision, 'block');
  assert.ok(o.reason.includes('forge-wait.cjs --session ' + SID));
  const quiet = spawnStop(proj('cli-quiet'), { hook_event_name: 'Stop', session_id: SID, stop_hook_active: false });
  assert.strictEqual(quiet.status, 0);
  assert.strictEqual(quiet.stdout, '');
});
t('CLI: garbage stdin -> exit 0, no output', () => {
  const root = proj('garbage');
  start(root, SID, 'a1');
  for (const input of ['{not json', '', '[]', 'null']) {
    const r = spawnStop(root, input);
    assert.strictEqual(r.status, 0, JSON.stringify(input));
    assert.strictEqual(r.stdout, '', JSON.stringify(input));
  }
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
