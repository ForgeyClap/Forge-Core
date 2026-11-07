// App router P2 — answers-only provider turns (design D4, 4.1, 4.6, 6.1; review findings 5, 9, 11, 12).
// A real HTTP Ollama stub (providers/testing/mock-http-server.mjs) speaks the native /api/chat NDJSON.
//
//   - streamed answer, batched provider_delta (<= 4 KB, >= 250 ms apart), final record answers-only;
//   - num_ctx always sent; the entry's own port is used; no CLI child is spawned;
//   - the history is rebuilt on EVERY provider turn (finding 5): turn 3 carries turns 1 and 2;
//   - 404 -> model_not_pulled; refused -> ollama_down (and the router fails over to Claude);
//   - Stop aborts; the wall-clock timeout ends it; at most 3 provider turns; a drain interrupts it;
//   - the full provider error map (finding 11) and the codex fold.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';
import { createConversation, readConversation, appendUserTurn, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { startExecution, stopExecution, enterDrainMode, interruptAllExecutions, providerRunCount, maxConcurrentProviderTurns, _setExecTimeoutMsForTests, _resetExecBridgeForTests } from '../src/exec-lifecycle.mjs';
import { startRoutedTurn, isTurnBusy, stopTurn } from '../src/app-router/turn-router.mjs';
import { startProviderTurn, mapProviderError, buildProviderRequest, _createDeltaBatcherForTests, DELTA_MAX_CHARS } from '../src/app-router/provider-turn.mjs';
import { readRouterConfig, writeRouterConfig, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { readReadings } from '../src/app-router/usage-readings.mjs';

const ENV_KEYS = ['CC_EXEC_MOCK', 'CC_ROUTER_MOCK', 'CC_EXEC_MOCK_DELAY_MS', 'CLAUDE_CONFIG_DIR', 'FORGE_ROUTER_PROFILES_DIR'];
const saved = {};
let tmp;
let n = 0;
const servers = [];

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-exec-provider-'));
  fs.mkdirSync(path.join(tmp, 'conv'), { recursive: true });
  _setConversationsDirForTests(path.join(tmp, 'conv'));
});

beforeEach(async () => {
  n += 1;
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_ROUTER_MOCK = '1';
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.FORGE_ROUTER_PROFILES_DIR = path.join(tmp, 'profiles-' + n);
  _setRouterDirForTests(path.join(tmp, 'router-' + n));
  _resetExecBridgeForTests();
  while (servers.length) await servers.pop().close();
});

after(async () => {
  _resetExecBridgeForTests();
  while (servers.length) await servers.pop().close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setRouterDirForTests(null);
  _setConversationsDirForTests(null);
  _resetConversationsForTests();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

async function stub(handler) {
  const s = await startMockServer(handler);
  servers.push(s);
  return s;
}
const ndjsonAnswer = (parts, { delayMs = 0 } = {}) => async (req, h) => {
  if (req.path === '/api/chat') {
    await h.ndjson([...parts.map((p) => ({ model: 'stub-model', message: { role: 'assistant', content: p }, done: false })),
      { model: 'stub-model', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 20 }], { delayMs });
    return;
  }
  h.json(404, { error: 'not here' });
};
const ollamaEntry = (port, extra = {}) => ({ id: 'ollama', kind: 'provider-model', label: 'Ollama · stub', provider: 'ollama-local', model: 'stub-model', enabled: true, num_ctx: 4096, vars: { port: String(port) }, paid_ack: false, notice_ack: false, ...extra });
const mainEntry = (enabled) => ({ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled, threshold_pct: null });

function modelFirst(port, { mainEnabled = false } = {}) {
  const current = readRouterConfig().config;
  const r = writeRouterConfig({ ...defaultRouterConfig(), mode: 'model-first', entries: [ollamaEntry(port), mainEntry(mainEnabled)], revision: current.revision });
  assert.equal(r.ok, true, JSON.stringify(r.errors || r));
}
function send(convId, text) {
  const { turnId, requestId } = appendUserTurn(convId, text, {});
  return { ...startRoutedTurn({ convId, turnId, requestId, text, cwd: os.tmpdir() }), turnId, requestId };
}
async function waitDone(convId, turnId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conv = readConversation(convId);
    const recs = (conv.turns || []).filter((t) => t.role === 'assistant' && t.turn_id === turnId);
    if (recs.length > 0 && !isTurnBusy(convId)) return { recs, events: conv.events || [] };
    if (Date.now() > deadline) throw new Error('turn did not finish');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function waitFor(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const route = (extra = {}) => ({ target_id: 'ollama', kind: 'provider-model', label: 'Ollama · stub', model: 'stub-model', capability: 'answers-only', reason: 'first', switched: false, attempt: 1, retried: false, outcome: null, handover: null, ...extra });
function direct(convId, port, text = 'vraag', extra = {}) {
  const { turnId, requestId } = appendUserTurn(convId, text, {});
  const r = startProviderTurn({ convId, turnId, requestId, text, cwd: os.tmpdir(), route: route(), entry: ollamaEntry(port), handover: null, onSettled: () => ({ retried: false }), ...extra });
  return { ...r, turnId, requestId };
}

test('streamed answer: batched provider_delta (<= 4 KB, >= 250 ms apart), answers-only record, num_ctx sent, no CLI child', async () => {
  const parts = Array.from({ length: 12 }, (_, i) => 'deel' + i + ' ');
  const s = await stub(ndjsonAnswer(parts, { delayMs: 60 }));
  modelFirst(s.port);
  const conv = createConversation({ project: 'prov-demo' });
  const r = send(conv.id, 'vraag 1');
  assert.equal(r.started, true, r.reason);
  assert.deepEqual({ id: r.route.entry.id, cap: r.route.capability, reason: r.route.reason }, { id: 'ollama', cap: 'answers-only', reason: 'first' });
  assert.equal(isTurnBusy(conv.id), true, 'a provider turn makes the conversation busy');
  const { recs, events } = await waitDone(conv.id, r.turnId);
  const rec = recs[0];
  assert.equal(rec.text, parts.join(''));
  assert.deepEqual({ kind: rec.route.kind, cap: rec.route.capability, outcome: rec.route.outcome, model: rec.model, inT: rec.input_tokens, outT: rec.output_tokens, stop: rec.stop_reason },
    { kind: 'provider-model', cap: 'answers-only', outcome: 'ok', model: 'stub-model', inT: 10, outT: 20, stop: 'stop' });

  const deltas = events.filter((e) => e.turn_id === r.turnId && e.kind === 'provider_delta');
  assert.equal(deltas.map((d) => d.data.text).join(''), rec.text, 'the live deltas add up to the answer');
  assert.ok(deltas.length >= 2 && deltas.length < parts.length, 'batched: ' + deltas.length + ' events for ' + parts.length + ' chunks');
  for (const d of deltas) assert.ok(d.data.text.length <= DELTA_MAX_CHARS);
  const times = deltas.map((d) => Date.parse(d.created_at));
  for (let i = 1; i < times.length - 1; i += 1) assert.ok(times[i] - times[i - 1] >= 245, 'gap ' + (times[i] - times[i - 1]) + ' ms between delta ' + (i - 1) + ' and ' + i);

  const req = s.requests.find((q) => q.path === '/api/chat');
  assert.equal(req.body.options.num_ctx, 4096, 'num_ctx is always sent');
  assert.equal(req.body.messages[0].role, 'system');
  assert.deepEqual(req.body.messages.at(-1), { role: 'user', content: 'vraag 1' });
  assert.equal(req.body.tools, undefined, 'answers only: no tools are offered');
  assert.equal(events.filter((e) => e.turn_id === r.turnId && (e.kind === 'system' || e.kind === 'result')).length, 0, 'no CLI child ran');
});

test('finding 5: the history is rebuilt on EVERY provider turn (turn 3 carries turns 1 and 2)', async () => {
  let count = 0;
  const s = await stub(async (req, h) => {
    if (req.path !== '/api/chat') return h.json(404, {});
    count += 1;
    await h.ndjson([{ message: { role: 'assistant', content: 'A' + count }, done: false }, { message: { content: '' }, done: true, done_reason: 'stop' }]);
  });
  modelFirst(s.port);
  const conv = createConversation({ project: 'prov-history' });
  for (const q of ['vraag 1', 'vraag 2', 'vraag 3']) {
    const r = send(conv.id, q);
    assert.equal(r.started, true, r.reason);
    await waitDone(conv.id, r.turnId);
  }
  const chats = s.requests.filter((q) => q.path === '/api/chat');
  assert.equal(chats.length, 3);
  const flat = (q) => q.body.messages.filter((m) => m.role !== 'system').map((m) => m.role + ':' + m.content);
  assert.deepEqual(flat(chats[0]), ['user:vraag 1']);
  assert.deepEqual(flat(chats[1]), ['user:vraag 1', 'assistant:A1', 'user:vraag 2']);
  assert.deepEqual(flat(chats[2]), ['user:vraag 1', 'assistant:A1', 'user:vraag 2', 'assistant:A2', 'user:vraag 3']);
});

test('404 -> model_not_pulled card (outcome down); refused -> ollama_down card', async () => {
  const s = await stub(async (req, h) => h.json(404, { error: 'model "stub-model" not found, try pulling it first' }));
  const conv = createConversation({ project: 'prov-404' });
  const r = direct(conv.id, s.port);
  assert.equal(r.started, true, r.reason);
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(recs[0].route.outcome, 'down');
  const fe = events.filter((e) => e.turn_id === r.turnId && e.kind === 'forge_error');
  assert.equal(fe.length, 1);
  assert.deepEqual({ code: fe[0].data.code, model: fe[0].data.model }, { code: 'model_not_pulled', model: 'stub-model' });

  const closed = await startMockServer(() => {});
  const port = closed.port;
  await closed.close();
  const conv2 = createConversation({ project: 'prov-refused' });
  const r2 = direct(conv2.id, port);
  const done2 = await waitDone(conv2.id, r2.turnId);
  assert.equal(done2.recs[0].route.outcome, 'down');
  assert.equal(done2.events.filter((e) => e.turn_id === r2.turnId && e.kind === 'forge_error')[0].data.code, 'ollama_down');
});

test('Ollama down in model-first with Claude enabled: fails over to Claude (switch-down), the provider is marked down', async () => {
  const closed = await startMockServer(() => {});
  const port = closed.port;
  await closed.close();
  modelFirst(port, { mainEnabled: true });
  const conv = createConversation({ project: 'prov-failover' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.route.entry.id, 'ollama');
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  assert.deepEqual({ t: recs[0].route.target_id, reason: recs[0].route.reason, from: recs[0].route.from_target_id, text: recs[0].text },
    { t: 'main', reason: 'switch-down', from: 'ollama', text: 'MOCK-PROFILE:main' });
  const failed = events.filter((e) => e.turn_id === r.turnId && e.kind === 'route_attempt_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.route.outcome, 'down');
  assert.equal(events.filter((e) => e.turn_id === r.turnId && e.kind === 'forge_error' && e.request_id === r.requestId).length, 0, 'a retried provider attempt shows no error card of its own');
  assert.ok(readReadings().ollama.down_at, 'usage.json marks the provider down');
});

test('Stop aborts a provider turn: outcome stopped, no error, conversation free at once', async () => {
  const s = await stub(ndjsonAnswer(Array.from({ length: 80 }, () => 'x'), { delayMs: 100 }));
  const conv = createConversation({ project: 'prov-stop' });
  const r = direct(conv.id, s.port);
  await waitFor(() => (readConversation(conv.id).events || []).some((e) => e.turn_id === r.turnId && e.kind === 'provider_delta'));
  assert.equal(stopTurn(conv.id).stopped, true);
  assert.equal(isTurnBusy(conv.id), false);
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.deepEqual({ o: recs[0].route.outcome, e: recs[0].error, s: recs[0].stop_reason }, { o: 'stopped', e: null, s: 'stopped' });
  assert.equal(events.filter((e) => e.turn_id === r.turnId && e.kind === 'stopped_by_user').length, 1);
  assert.equal(events.filter((e) => e.turn_id === r.turnId && e.kind === 'forge_error').length, 0);
});

test('the wall-clock timeout ends a provider turn', async () => {
  const s = await stub(ndjsonAnswer(Array.from({ length: 80 }, () => 'x'), { delayMs: 100 }));
  _setExecTimeoutMsForTests(300);
  try {
    const conv = createConversation({ project: 'prov-timeout' });
    const r = direct(conv.id, s.port);
    const { recs, events } = await waitDone(conv.id, r.turnId);
    assert.equal(recs[0].route.outcome, 'error');
    assert.equal(recs[0].stop_reason, 'timed_out');
    assert.match(recs[0].error, /300ms wall-clock timeout/);
    assert.equal(events.filter((e) => e.turn_id === r.turnId && e.kind === 'timed_out').length, 1);
  } finally {
    _setExecTimeoutMsForTests(null);
  }
});

test('finding 9: provider turns have their own cap of 3; the CLI cap is separate; a drain interrupts a provider turn', async () => {
  const s = await stub(ndjsonAnswer(Array.from({ length: 80 }, () => 'x'), { delayMs: 100 }));
  const convs = [1, 2, 3, 4].map((i) => createConversation({ project: 'prov-cap-' + i }));
  for (const c of convs.slice(0, 3)) assert.equal(direct(c.id, s.port).started, true);
  assert.equal(providerRunCount(), maxConcurrentProviderTurns());
  const fourth = direct(convs[3].id, s.port);
  assert.equal(fourth.started, false);
  assert.match(fourth.reason, /provider turn limit reached \(3 running\)/);
  const cli = createConversation({ project: 'prov-cap-cli' });
  process.env.CC_EXEC_MOCK_DELAY_MS = '2000';
  assert.equal(startExecution({ convId: cli.id, turnId: 't-cli', requestId: 'req-cli', text: 'hi', cwd: os.tmpdir() }).started, true, 'a CLI turn still starts');
  stopExecution(cli.id);

  enterDrainMode('test drain');
  const interrupted = interruptAllExecutions('test drain');
  assert.equal(interrupted.filter((i) => i.kind === 'provider' && i.pid === null).length, 3);
  for (const c of convs.slice(0, 3)) assert.equal(isTurnBusy(c.id), false);
  await new Promise((r) => setTimeout(r, 400));
  for (const c of convs.slice(0, 3)) {
    const conv = readConversation(c.id);
    assert.equal((conv.events || []).filter((e) => e.kind === 'interrupted').length, 1);
    assert.equal((conv.events || []).filter((e) => e.kind === 'forge_error' && e.data.code === 'gateway_restarted').length, 1);
    assert.equal((conv.turns || []).filter((t) => t.role === 'assistant').length, 0, 'interrupted is terminal: no turn record after the drain');
  }
  assert.equal(direct(convs[3].id, s.port).started, false, 'no new provider turn while draining');
});

test('finding 11: every provider error code maps to an outcome and an existing card code', () => {
  const local = { adapter: 'ollama', local: true, model: 'm' };
  const remote = { adapter: 'openai-compatible', local: false };
  const otherLocal = { adapter: 'openai-compatible', local: true };
  const rows = [
    ['NETWORK', local, 'down', 'ollama_down'],
    ['TIMEOUT', local, 'down', 'ollama_down'],
    ['NETWORK', remote, 'down', 'offline'],
    ['NETWORK', otherLocal, 'down', 'unknown'],
    ['NOT_FOUND', local, 'down', 'model_not_pulled'],
    ['NOT_FOUND', remote, 'error', 'unknown'],
    ['RATE_LIMIT', remote, 'rate_limited', 'rate_limited'],
    ['AUTH', remote, 'error', 'unknown'],
    ['NOT_CONFIGURED', remote, 'error', 'unknown'],
    ['NOT_CONNECTED', { adapter: 'cli-codex', local: false }, 'logged_out', 'unknown'],
    ['NOT_INSTALLED', { adapter: 'cli-codex', local: false }, 'down', 'unknown'],
    ['HTTP', remote, 'error', 'unknown'],
    ['BAD_RESPONSE', local, 'error', 'unknown'],
    ['CONFIG', local, 'error', 'unknown'],
    ['PROTOCOL', remote, 'error', 'unknown'],
    ['NOT_IMPLEMENTED', remote, 'error', 'unknown'],
    ['ABORTED', remote, 'error', 'unknown'],
  ];
  for (const [code, ctx, outcome, card] of rows) {
    const m = mapProviderError({ code, message: 'msg ' + code }, ctx);
    assert.deepEqual([m.outcome, m.code], [outcome, card], code + ' ' + JSON.stringify(ctx));
  }
  assert.notEqual(mapProviderError({ code: 'AUTH' }, remote).code, 'logged_out', 'a wrong API key never shows the Claude sign-in card');
  assert.equal(mapProviderError({ code: 'NOT_FOUND' }, local).model, 'm');
});

test('codex fold + provider request shape (pure)', () => {
  const handover = { text: 'Context: earlier', history: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }], truncated: false, note: 'Note: interrupted' };
  const codex = buildProviderRequest({ id: 'codex', kind: 'codex-account', label: 'Codex', profile: null, enabled: true }, 'new question', handover, { cwd: 'C:\\proj' });
  assert.equal(codex.messages.length, 1);
  assert.equal(codex.messages[0].role, 'user');
  assert.match(codex.messages[0].content, /^Context: earlier\n\nNote: interrupted\n\nnew question$/);
  assert.deepEqual({ sandbox: codex.options.sandbox, cwd: codex.options.cwd }, { sandbox: 'read-only', cwd: 'C:\\proj' });
  assert.equal(codex.model, undefined);

  const prov = buildProviderRequest(ollamaEntry(11434, { num_ctx: null }), 'q', handover, { adapter: 'ollama' });
  assert.equal(prov.options.numCtx, 8192, 'num_ctx default when the entry leaves it empty');
  assert.match(prov.messages[0].content, /Note: interrupted$/, 'the interrupted-attempt note goes into the system message');
  assert.deepEqual(prov.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  const remote = buildProviderRequest({ ...ollamaEntry(1), provider: 'openai' }, 'q', null, { adapter: 'openai-compatible' });
  assert.equal(remote.options.numCtx, undefined, 'num_ctx only for Ollama');
});

test('delta batcher: chunks never exceed 4 KB and a flush emits the rest', () => {
  const out = [];
  const b = _createDeltaBatcherForTests((c) => out.push(c), { gapMs: 1000 });
  b.push('y'.repeat(10000));
  b.flush();
  assert.equal(out.join('').length, 10000);
  assert.ok(out.every((c) => c.length <= DELTA_MAX_CHARS));
  const cancelled = [];
  const b2 = _createDeltaBatcherForTests((c) => cancelled.push(c));
  b2.push('z');
  b2.cancel();
  b2.flush();
  assert.deepEqual(cancelled, []);
});
