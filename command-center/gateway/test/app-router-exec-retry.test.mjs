// App router P2 — failover and the one automatic retry (design 4.1, 4.3, 4.5, 4.7; review findings 1,
// 6, 10). Real spawned mock CLI children (CC_EXEC_MOCK=1 + the router seam CC_ROUTER_MOCK=1): a profile
// folder holding `mock-limit` answers with the recorded rate-limit-rejected shape and exits 1.
//
//   - profile A limited -> attempt 1 rate_limited -> attempt 2 on B answers MOCK-PROFILE:b; exactly one
//     retry, ONE assistant record per turn_id (attempt 1 is a route_attempt_failed event);
//   - isTurnBusy stays true across the retry boundary;
//   - no retry after a tool_use, after Stop, after a timeout, or when the router is off;
//   - attempt 2 that cannot start leaves attempt 1 as the record (retried:false) + execution_not_started;
//   - nothing usable -> no spawn, route_exhausted + forge_error rate_limited with the earliest time.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversation, readConversation, appendUserTurn, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { startExecution, runningExecutionCount, _setExecTimeoutMsForTests, _resetExecBridgeForTests } from '../src/exec-lifecycle.mjs';
import { startRoutedTurn, isTurnBusy, stopTurn, failoverFor, interruptedAttemptNote, mergeReadings, conversationRouteState, exhaustedCode } from '../src/app-router/turn-router.mjs';
import { _setProviderFactoryForTests } from '../src/app-router/provider-turn.mjs';
import { readRouterConfig, writeRouterConfig, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { readReadings, recordLimitHit } from '../src/app-router/usage-readings.mjs';
import { readRouterEvents } from '../src/app-router/router-log.mjs';

const ENV_KEYS = ['CC_EXEC_MOCK', 'CC_ROUTER_MOCK', 'CC_ROUTER_MOCK_MAIN_LIMIT', 'CC_EXEC_MOCK_DELAY_MS', 'CLAUDE_CONFIG_DIR', 'FORGE_ROUTER_PROFILES_DIR'];
const saved = {};
let tmp;
let profilesRoot;
let routerDir;
let n = 0;

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-exec-retry-'));
  _setConversationsDirForTests(path.join(tmp, 'conv'));
  fs.mkdirSync(path.join(tmp, 'conv'), { recursive: true });
});

beforeEach(() => {
  n += 1;
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_ROUTER_MOCK = '1';
  delete process.env.CC_ROUTER_MOCK_MAIN_LIMIT;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  delete process.env.CLAUDE_CONFIG_DIR;
  profilesRoot = path.join(tmp, 'profiles-' + n);
  process.env.FORGE_ROUTER_PROFILES_DIR = profilesRoot;
  routerDir = path.join(tmp, 'router-' + n);
  _setRouterDirForTests(routerDir);
  _setProviderFactoryForTests(null);
  _resetExecBridgeForTests();
});

after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setRouterDirForTests(null);
  _setProviderFactoryForTests(null);
  _setConversationsDirForTests(null);
  _resetConversationsForTests();
  _resetExecBridgeForTests();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function profile(slug, markers = []) {
  const dir = path.join(profilesRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const m of markers) fs.writeFileSync(path.join(dir, m), '');
  return dir;
}
const claude = (id, extra = {}) => ({ id, kind: 'claude-account', label: id.toUpperCase(), profile: id === 'main' ? null : id, enabled: true, threshold_pct: null, ...extra });
const ollama = (extra = {}) => ({ id: 'ollama', kind: 'provider-model', label: 'Ollama · stub', provider: 'ollama-local', model: 'stub-model', enabled: true, num_ctx: 4096, vars: { port: '11434' }, paid_ack: false, notice_ack: false, ...extra });

function setConfig(partial) {
  const current = readRouterConfig().config;
  const next = { ...defaultRouterConfig(), ...partial, revision: current.revision };
  const r = writeRouterConfig(next);
  assert.equal(r.ok, true, JSON.stringify(r.errors || r));
  return r.config;
}
const multiAccount = (entries) => setConfig({ mode: 'claude-accounts', multi_account: { enabled: true, acknowledged_at: '2026-11-02T10:00:00.000Z' }, entries });

function send(convId, text) {
  const { turnId, requestId } = appendUserTurn(convId, text, {});
  const r = startRoutedTurn({ convId, turnId, requestId, text, cwd: os.tmpdir(), mode: undefined, effort: undefined, model: undefined, fork: undefined });
  return { ...r, turnId, requestId };
}

async function waitDone(convId, turnId, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conv = readConversation(convId);
    const recs = (conv.turns || []).filter((t) => t.role === 'assistant' && t.turn_id === turnId);
    if (recs.length > 0 && !isTurnBusy(convId)) return { conv, recs, events: conv.events || [] };
    if (Date.now() > deadline) throw new Error('turn ' + turnId + ' did not finish; busy=' + isTurnBusy(convId));
    await new Promise((r) => setTimeout(r, 25));
  }
}
const eventsOf = (events, turnId, kind) => events.filter((e) => e.turn_id === turnId && e.kind === kind);

test('limit on A -> exactly one retry on B; one assistant record per turn_id; attempt 1 kept as route_attempt_failed', async () => {
  profile('a', ['mock-limit']);
  profile('b');
  multiAccount([claude('main', { enabled: false }), claude('a'), claude('b')]);
  const conv = createConversation({ project: 'retry-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  assert.equal(r.route.entry.id, 'a');
  const { recs, events } = await waitDone(conv.id, r.turnId);

  assert.equal(recs.length, 1, 'exactly one assistant record for the turn (review finding 1)');
  const rec = recs[0];
  assert.equal(rec.text, 'MOCK-PROFILE:b');
  assert.equal(rec.request_id, r.requestId + '-r2');
  assert.deepEqual(
    { target: rec.route.target_id, attempt: rec.route.attempt, switched: rec.route.switched, reason: rec.route.reason, from: rec.route.from_target_id, outcome: rec.route.outcome, retried: rec.route.retried, capability: rec.route.capability },
    { target: 'b', attempt: 2, switched: true, reason: 'switch-limit', from: 'a', outcome: 'ok', retried: false, capability: 'full' },
  );
  assert.equal(rec.route.from_window, 'five_hour');
  assert.ok(Date.parse(rec.route.from_resume_at) > Date.now(), 'the free-again time of A comes from the limit line');

  const failed = eventsOf(events, r.turnId, 'route_attempt_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].request_id, r.requestId);
  assert.deepEqual({ t: failed[0].data.route.target_id, o: failed[0].data.route.outcome, rt: failed[0].data.route.retried }, { t: 'a', o: 'rate_limited', rt: true });
  const switched = eventsOf(events, r.turnId, 'route_switched');
  assert.equal(switched.length, 1);
  assert.equal(switched[0].data.target_id, 'b');
  assert.equal(switched[0].data.attempt, 2, 'route_switched carries the route record (finding 13)');
  assert.equal(eventsOf(events, r.turnId, 'route_selected').length, 2, 'one route_selected per attempt');
  // no third attempt anywhere
  assert.equal(events.filter((e) => e.turn_id === r.turnId && typeof e.request_id === 'string' && e.request_id.endsWith('-r3')).length, 0);

  const readings = readReadings();
  assert.ok(readings.a.limit_hit && Date.parse(readings.a.limit_hit.resets_at) > Date.now(), 'usage.json holds the limit hit for A');
  const log = readRouterEvents();
  assert.ok(log.some((e) => e.kind === 'router_limit_hit' && e.target_id === 'a'));
  assert.ok(log.some((e) => e.kind === 'router_switch' && e.from === 'a' && e.to === 'b' && e.reason === 'switch-limit'));
});

test('isTurnBusy stays true across the retry boundary (never false before the final record exists)', async () => {
  profile('a', ['mock-limit']);
  profile('b');
  multiAccount([claude('main', { enabled: false }), claude('a'), claude('b')]);
  process.env.CC_EXEC_MOCK_DELAY_MS = '150';
  const conv = createConversation({ project: 'busy-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  let polls = 0;
  const deadline = Date.now() + 20000;
  for (;;) {
    polls += 1;
    if (!isTurnBusy(conv.id)) {
      const recs = (readConversation(conv.id).turns || []).filter((t) => t.role === 'assistant' && t.turn_id === r.turnId);
      assert.equal(recs.length, 1, 'busy went false while no final record existed (a gap at the retry boundary)');
      assert.equal(recs[0].route.target_id, 'b');
      break;
    }
    if (Date.now() > deadline) throw new Error('never finished');
    await new Promise((res) => setImmediate(res));
  }
  assert.ok(polls > 10, 'the poll really watched the turn while it ran');
});

test('no retry after a tool_use: the limited attempt stays the record (retried:false) and no -r2 attempt exists', async () => {
  profile('a', ['mock-limit']);
  profile('b');
  multiAccount([claude('main', { enabled: false }), claude('a'), claude('b')]);
  const conv = createConversation({ project: 'tools-demo' });
  const r = send(conv.id, 'doe iets __MOCK_TOOLS__');
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  assert.deepEqual({ t: recs[0].route.target_id, o: recs[0].route.outcome, rt: recs[0].route.retried }, { t: 'a', o: 'rate_limited', rt: false });
  assert.ok(Array.isArray(recs[0].file_edits) && recs[0].file_edits.length > 0, 'the tool activity is kept on the record');
  assert.equal(events.filter((e) => e.request_id === r.requestId + '-r2').length, 0);
  assert.equal(eventsOf(events, r.turnId, 'route_attempt_failed').length, 0);
  // finding 6: the next turn (now on B, A is exhausted) is told what the interrupted attempt did
  const next = send(conv.id, 'Ga verder waar je gebleven was.');
  assert.equal(next.route.entry.id, 'b');
  const done = await waitDone(conv.id, next.turnId);
  assert.match(done.recs[0].text, /^MOCK-PROFILE:b HANDOVER_CHARS:\d+/, 'context (incl. the interrupted-attempt note) arrived on stdin');
  const handover = eventsOf(done.events, next.turnId, 'context_handover');
  assert.equal(handover.length, 1);
  assert.ok(handover[0].data.chars > 0);
});

test('no retry after Stop', async () => {
  profile('a', ['mock-limit']);
  profile('b');
  multiAccount([claude('main', { enabled: false }), claude('a'), claude('b')]);
  process.env.CC_EXEC_MOCK_DELAY_MS = '3000';
  const conv = createConversation({ project: 'stop-demo' });
  const r = send(conv.id, 'hallo');
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(stopTurn(conv.id).stopped, true);
  assert.equal(isTurnBusy(conv.id), false);
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].route.outcome, 'stopped');
  assert.equal(recs[0].route.retried, false);
  assert.equal(events.filter((e) => e.request_id === r.requestId + '-r2').length, 0);
});

test('no retry after a timeout', async () => {
  profile('a', ['mock-limit']);
  profile('b');
  multiAccount([claude('main', { enabled: false }), claude('a'), claude('b')]);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  _setExecTimeoutMsForTests(300);
  try {
    const conv = createConversation({ project: 'timeout-demo' });
    const r = send(conv.id, 'hallo');
    const { recs, events } = await waitDone(conv.id, r.turnId);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].stop_reason, 'timed_out');
    assert.equal(recs[0].route.outcome, 'error');
    assert.equal(recs[0].route.retried, false);
    assert.equal(events.filter((e) => e.request_id === r.requestId + '-r2').length, 0);
  } finally {
    _setExecTimeoutMsForTests(null);
  }
});

test('router off: startExecution with the identical arguments, no route field, no router files written', async () => {
  profile('a', ['mock-limit']);
  // no config written at all = DEFAULT = off
  const conv = createConversation({ project: 'off-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true);
  assert.equal(r.route, null);
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  assert.equal('route' in recs[0], false, 'router off writes no route field');
  assert.equal(recs[0].text, 'MOCK-PROFILE:main');
  assert.equal(events.filter((e) => String(e.kind).startsWith('route_')).length, 0);
  assert.equal(fs.existsSync(path.join(routerDir, 'usage.json')), false);
  assert.equal(fs.existsSync(path.join(routerDir, 'router-events.jsonl')), false);

  // same record keys as a direct startExecution call (the pre-router path)
  const conv2 = createConversation({ project: 'off-demo-direct' });
  const { turnId, requestId } = appendUserTurn(conv2.id, 'hallo', {});
  assert.equal(startExecution({ convId: conv2.id, turnId, requestId, text: 'hallo', cwd: os.tmpdir() }).started, true);
  const direct = await waitDone(conv2.id, turnId);
  assert.deepEqual(Object.keys(recs[0]).filter((k) => k !== 'created_at').sort(), Object.keys(direct.recs[0]).filter((k) => k !== 'created_at').sort());
});

test('finding 10: attempt 2 that cannot start leaves attempt 1 as the record (retried:false) plus execution_not_started', async () => {
  process.env.CC_ROUTER_MOCK_MAIN_LIMIT = '1';
  setConfig({ mode: 'claude-then-model', entries: [claude('main'), ollama()] });
  _setProviderFactoryForTests(() => { throw new Error('stub: provider cannot be created'); });
  const conv = createConversation({ project: 'r2-fail-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.route.entry.id, 'main');
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  assert.deepEqual({ t: recs[0].route.target_id, o: recs[0].route.outcome, rt: recs[0].route.retried }, { t: 'main', o: 'rate_limited', rt: false });
  const ns = events.filter((e) => e.kind === 'execution_not_started' && e.request_id === r.requestId + '-r2');
  assert.equal(ns.length, 1);
  assert.equal(ns[0].data.attempt, 2);
  assert.match(ns[0].data.reason, /provider could not be created/);
  assert.equal(eventsOf(events, r.turnId, 'route_attempt_failed').length, 0);
});

test('nothing usable: no spawn, route_exhausted + forge_error rate_limited with the EARLIEST free time, router_exhausted logged', async () => {
  profile('a');
  profile('b');
  multiAccount([claude('main', { enabled: false }), claude('a'), claude('b')]);
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  const later = new Date(Date.now() + 90 * 60_000).toISOString();
  recordLimitHit('a', { resets_at: later, window: 'five_hour' });
  recordLimitHit('b', { resets_at: soon, window: 'five_hour' });
  const conv = createConversation({ project: 'exhausted-demo' });
  const before = runningExecutionCount();
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, false);
  assert.equal(r.code, 'router_exhausted');
  assert.equal(r.route.kind, 'exhausted');
  assert.equal(r.route.resume_at, soon);
  assert.deepEqual(r.route.first_free, { target_id: 'b', label: 'B' });
  assert.equal(runningExecutionCount(), before, 'no child was spawned');
  const events = readConversation(conv.id).events || [];
  const ex = eventsOf(events, r.turnId, 'route_exhausted');
  assert.equal(ex.length, 1);
  assert.equal(ex[0].data.code, 'rate_limited');
  const fe = eventsOf(events, r.turnId, 'forge_error');
  assert.equal(fe.length, 1);
  assert.equal(fe[0].data.code, 'rate_limited');
  assert.equal(fe[0].data.resume_at, soon);
  assert.ok(readRouterEvents().some((e) => e.kind === 'router_exhausted' && e.resume_at === soon));
  assert.equal((readConversation(conv.id).turns || []).filter((t) => t.role === 'assistant').length, 0);
});

test('a lost login on an extra profile fails over (switch-login) and marks it needs-login; a missing folder is skipped', async () => {
  profile('b', ['mock-logged-out']);
  profile('c');
  multiAccount([claude('main', { enabled: false }), claude('gone'), claude('b'), claude('c')]);
  const conv = createConversation({ project: 'login-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  assert.equal(r.route.entry.id, 'b', 'the entry without a profile folder was skipped');
  const { recs } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  assert.deepEqual({ t: recs[0].route.target_id, reason: recs[0].route.reason, from: recs[0].route.from_target_id }, { t: 'c', reason: 'switch-login', from: 'b' });
  const readings = readReadings();
  assert.ok(readings.b.needs_login_at, 'b is marked needs-login');
  assert.ok(readings.gone.needs_login_at, 'the folder-less entry is marked needs-login');
});

test('the main account never fails over on a lost login (it keeps the existing sign-in card)', () => {
  const r = failoverFor({ id: 'main', kind: 'claude-account', profile: null }, { outcome: 'logged_out' }, 1);
  assert.equal(r, null);
  assert.equal(failoverFor({ id: 'w', kind: 'claude-account', profile: 'w' }, { outcome: 'logged_out' }, 1), 'logged_out');
  assert.equal(failoverFor({ id: 'w', kind: 'claude-account', profile: 'w' }, { outcome: 'rate_limited' }, 2), null, 'never a third attempt');
  assert.equal(failoverFor({ id: 'w', kind: 'claude-account', profile: 'w' }, { outcome: 'rate_limited', hadToolUse: true }, 1), null);
  assert.equal(failoverFor({ id: 'o', kind: 'provider-model' }, { outcome: 'down' }, 1), 'down');
  assert.equal(failoverFor({ id: 'm', kind: 'claude-account', profile: null }, { outcome: 'down' }, 1), null);
  assert.equal(failoverFor({ id: 'o', kind: 'provider-model' }, { outcome: 'error' }, 1), null);
});

test('pure helpers: route state, merged readings, the interrupted-attempt note, the exhausted card code', () => {
  const now = Date.parse('2026-11-02T12:00:00.000Z');
  const recs = [
    { type: 'turn', role: 'assistant', created_at: '2026-11-02T08:00:00.000Z', route: { target_id: 'a', switched: true, reason: 'switch-threshold' } },
    { type: 'turn', role: 'assistant', created_at: '2026-11-01T08:00:00.000Z', route: { target_id: 'b', switched: true, reason: 'return' } },
    { type: 'turn', role: 'assistant', created_at: '2026-11-02T11:00:00.000Z', route: { target_id: 'c', switched: true, reason: 'switch-limit' } },
  ];
  assert.deepEqual(conversationRouteState(recs, now), { target_id: 'c', switched_at: '2026-11-02T11:00:00.000Z', proactive_switches_24h: 1 });
  assert.equal(conversationRouteState([...recs, { type: 'turn', role: 'assistant', created_at: 'x' }], now).target_id, null, 'an unrouted record (router was off) resets the target');

  const merged = mergeReadings([
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1900000000, rateLimitType: 'five_hour' } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1900000000, rateLimitType: 'seven_day', utilization: 0.9 } },
  ]);
  assert.equal(merged.status, 'allowed_warning');
  assert.deepEqual(merged.windows.map((w) => [w.type, w.pct]), [['five_hour', null], ['seven_day', 90]]);
  assert.equal(mergeReadings([]), null);

  const prior = [{ type: 'turn', role: 'assistant', turn_id: 't1', error: 'the model reported is_error:true', text: "You've hit your limit",
    file_edits: [{ tool: 'Edit', file_path: '/p/a.txt' }, { tool: 'Write', file_path: '/p/a.txt' }],
    shell_commands: [{ command: 'npm install', is_error: false }, { command: 'npm test', is_error: true }],
    route: { target_id: 'a', label: 'Werk', outcome: 'rate_limited', retried: false } }];
  const note = interruptedAttemptNote(prior, 't2', 'b');
  assert.match(note, /interrupted on Werk/);
  assert.match(note, /Files it changed: \/p\/a\.txt$/m);
  assert.match(note, /- npm install/);
  assert.match(note, /- \(failed\) npm test/);
  assert.doesNotMatch(note, /hit your limit/, 'an error text is not presented as a partial answer');
  assert.equal(interruptedAttemptNote(prior, 't2', 'a'), null, 'same target: its own session carries it');
  assert.equal(interruptedAttemptNote([{ ...prior[0], route: { ...prior[0].route, outcome: 'ok' } }], 't2', 'b'), null);

  const cfg = { ...defaultRouterConfig(), mode: 'claude-then-model', entries: [claude('main'), ollama()] };
  assert.equal(exhaustedCode(cfg, { ollama: { down_at: new Date(now - 1000).toISOString() } }, { now }), 'ollama_down');
  assert.equal(exhaustedCode(cfg, { main: { limit_hit: { at: new Date(now).toISOString(), resets_at: new Date(now + 60_000).toISOString(), window: 'five_hour' } } }, { now }), 'rate_limited');
  assert.equal(exhaustedCode(cfg, {}, { now }), 'unknown');
});
