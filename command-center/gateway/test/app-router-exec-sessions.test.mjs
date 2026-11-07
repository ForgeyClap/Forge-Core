// App router P2 — sessions are bound to the account they ran under (design 4.6, review finding 15).
//
//   - a routed turn stores its session with a target binding (gateway-sessions sidecar file);
//   - the next turn on the same target resumes it, without a handover;
//   - a target change starts a fresh session (no --resume) and hands the recent messages over ONCE;
//   - a legacy session (no binding) counts as `main`; a stale binding counts as `main`;
//   - a fork carries the source's binding; clearing a session drops its binding;
//   - router off never writes a binding.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversation, readConversation, appendUserTurn, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { startExecution, _resetExecBridgeForTests } from '../src/exec-lifecycle.mjs';
import {
  resumeOptionsFor, sessionTargetFor, bindSessionTarget, markConversationForkedFrom, clearConversationSession,
  gatewaySessionStore, gatewaySessionTargetsFile, MAIN_TARGET_ID,
} from '../src/sessions/gateway-sessions.mjs';
import { sessionOptionsForConversation } from '../src/sessions/argv-session.mjs';
import { startRoutedTurn, isTurnBusy } from '../src/app-router/turn-router.mjs';
import { readRouterConfig, writeRouterConfig, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';

const ENV_KEYS = ['CC_EXEC_MOCK', 'CC_ROUTER_MOCK', 'CC_EXEC_MOCK_DELAY_MS', 'CLAUDE_CONFIG_DIR', 'FORGE_ROUTER_PROFILES_DIR'];
const saved = {};
let tmp;
let n = 0;
let profilesRoot;
const cwd = os.tmpdir();

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-exec-sessions-'));
});

beforeEach(() => {
  n += 1;
  const convDir = path.join(tmp, 'conv-' + n);
  fs.mkdirSync(convDir, { recursive: true });
  _setConversationsDirForTests(convDir); // the session store and the binding file follow this dir
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_ROUTER_MOCK = '1';
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  delete process.env.CLAUDE_CONFIG_DIR;
  profilesRoot = path.join(tmp, 'profiles-' + n);
  process.env.FORGE_ROUTER_PROFILES_DIR = profilesRoot;
  _setRouterDirForTests(path.join(tmp, 'router-' + n));
  _resetExecBridgeForTests();
});

after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setRouterDirForTests(null);
  _setConversationsDirForTests(null);
  _resetConversationsForTests();
  _resetExecBridgeForTests();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

const claude = (id, enabled = true) => ({ id, kind: 'claude-account', label: id.toUpperCase(), profile: id === 'main' ? null : id, enabled, threshold_pct: null });
function setEntries(entries) {
  const current = readRouterConfig().config;
  const r = writeRouterConfig({ ...defaultRouterConfig(), mode: 'claude-accounts', multi_account: { enabled: true, acknowledged_at: '2026-11-02T10:00:00.000Z' }, entries, revision: current.revision });
  assert.equal(r.ok, true, JSON.stringify(r.errors || r));
}
async function turn(convId, text) {
  const { turnId, requestId } = appendUserTurn(convId, text, {});
  const r = startRoutedTurn({ convId, turnId, requestId, text, cwd });
  assert.equal(r.started, true, r.reason);
  const deadline = Date.now() + 15000;
  for (;;) {
    const conv = readConversation(convId);
    const rec = (conv.turns || []).find((t) => t.role === 'assistant' && t.turn_id === turnId);
    if (rec && !isTurnBusy(convId)) return { rec, events: (conv.events || []).filter((e) => e.turn_id === turnId) };
    if (Date.now() > deadline) throw new Error('turn did not finish');
    await new Promise((res) => setTimeout(res, 20));
  }
}

test('a routed session is bound to its target; same target resumes without handover; a target change starts fresh with ONE handover', async () => {
  for (const s of ['a', 'b', 'c']) fs.mkdirSync(path.join(profilesRoot, s), { recursive: true });
  setEntries([claude('main', false), claude('a'), claude('b'), claude('c')]);
  const conv = createConversation({ project: 'sess-demo' });

  const t1 = await turn(conv.id, 'eerste vraag');
  assert.equal(t1.rec.text, 'MOCK-PROFILE:a', 'first turn: fresh session, nothing to hand over');
  const sidA = gatewaySessionStore().getSessionId(conv.id);
  assert.match(sidA, /^mock-a-/);
  assert.equal(sessionTargetFor(conv.id), 'a');

  const t2 = await turn(conv.id, 'tweede vraag');
  assert.equal(t2.rec.text, 'MOCK-PROFILE:a SESSION_ARGS:[--resume ' + sidA + ']', 'same target: its own session is resumed');
  assert.equal(t2.rec.route.handover, null);
  assert.equal(t2.events.filter((e) => e.kind === 'context_handover').length, 0);

  setEntries([claude('main', false), claude('a', false), claude('b'), claude('c')]); // a leaves the chain
  const t3 = await turn(conv.id, 'derde vraag');
  assert.match(t3.rec.text, /^MOCK-PROFILE:b HANDOVER_CHARS:\d+$/, 'target change: no --resume (another account cannot resume it), context on stdin');
  assert.equal(t3.rec.route.switched, true);
  assert.equal(t3.rec.route.from_target_id, 'a');
  assert.equal(t3.rec.route.handover.turns, 4, 'the two earlier exchanges were handed over');
  assert.equal(Number(t3.rec.text.split('HANDOVER_CHARS:')[1]), t3.rec.route.handover.chars, 'the child received exactly the recorded handover');
  assert.equal(t3.events.filter((e) => e.kind === 'context_handover').length, 1);
  const sidB = gatewaySessionStore().getSessionId(conv.id);
  assert.match(sidB, /^mock-b-/);
  assert.equal(sessionTargetFor(conv.id), 'b');

  const t4 = await turn(conv.id, 'vierde vraag');
  assert.equal(t4.rec.text, 'MOCK-PROFILE:b SESSION_ARGS:[--resume ' + sidB + ']', 'the handover went only into the first turn on the new target');
});

test('legacy session (no binding) counts as main; a stale binding counts as main; router-off resume options are unchanged', () => {
  const conv = createConversation({ project: 'sess-legacy' });
  gatewaySessionStore().set(conv.id, { sessionId: 'legacy-session-1', cwd });
  assert.equal(sessionTargetFor(conv.id), MAIN_TARGET_ID);
  const record = gatewaySessionStore().get(conv.id);
  assert.deepEqual(resumeOptionsFor(conv.id, { cwd }), sessionOptionsForConversation(record, { cwd }), 'router off: exactly the pre-router answer');
  assert.deepEqual(resumeOptionsFor(conv.id, { cwd, targetId: 'main' }), { resumeSessionId: 'legacy-session-1', fork: false });
  assert.deepEqual(resumeOptionsFor(conv.id, { cwd, targetId: 'werk' }), { resumeSessionId: null, fork: false }, 'another account never resumes a main session');

  bindSessionTarget(conv.id, 'legacy-session-1', 'werk');
  assert.equal(sessionTargetFor(conv.id), 'werk');
  gatewaySessionStore().set(conv.id, { sessionId: 'newer-session-22', cwd }); // e.g. a router-off turn made a new session
  assert.equal(sessionTargetFor(conv.id), MAIN_TARGET_ID, 'a binding for an older session id no longer counts');
});

test('finding 15: a fork carries the source binding; a main-bound source gives an unbound fork; clearing drops the binding', () => {
  const source = createConversation({ project: 'sess-fork' });
  gatewaySessionStore().set(source.id, { sessionId: 'werk-session-77', cwd });
  bindSessionTarget(source.id, 'werk-session-77', 'werk');
  const fork = createConversation({ project: 'sess-fork' });
  markConversationForkedFrom(fork.id, source.id);
  assert.equal(sessionTargetFor(fork.id), 'werk');
  assert.deepEqual(resumeOptionsFor(fork.id, { cwd, targetId: 'werk' }), { resumeSessionId: 'werk-session-77', fork: true });
  assert.deepEqual(resumeOptionsFor(fork.id, { cwd }), { resumeSessionId: null, fork: false }, 'main cannot resume the werk session of the fork');

  const plainSource = createConversation({ project: 'sess-fork' });
  gatewaySessionStore().set(plainSource.id, { sessionId: 'main-session-88', cwd });
  const plainFork = createConversation({ project: 'sess-fork' });
  markConversationForkedFrom(plainFork.id, plainSource.id);
  assert.equal(sessionTargetFor(plainFork.id), MAIN_TARGET_ID);
  const bindings = JSON.parse(fs.readFileSync(gatewaySessionTargetsFile(), 'utf8')).targets;
  assert.equal(plainFork.id in bindings, false, 'no binding is written for a main session');

  assert.equal(clearConversationSession(fork.id), true);
  assert.equal(fork.id in JSON.parse(fs.readFileSync(gatewaySessionTargetsFile(), 'utf8')).targets, false);
});

test('router off: a turn stores its session exactly as before and never writes a binding file', async () => {
  delete process.env.CC_ROUTER_MOCK;
  const conv = createConversation({ project: 'sess-off' });
  const { turnId, requestId } = appendUserTurn(conv.id, 'hallo __MOCK_SESSION__', {});
  assert.equal(startExecution({ convId: conv.id, turnId, requestId, text: 'hallo __MOCK_SESSION__', cwd }).started, true);
  const deadline = Date.now() + 15000;
  while (!(readConversation(conv.id).turns || []).some((t) => t.role === 'assistant')) {
    if (Date.now() > deadline) throw new Error('turn did not finish');
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.match(gatewaySessionStore().getSessionId(conv.id), /^mock-sess-/);
  assert.equal(fs.existsSync(gatewaySessionTargetsFile()), false);
  assert.equal(sessionTargetFor(conv.id), MAIN_TARGET_ID);
});
