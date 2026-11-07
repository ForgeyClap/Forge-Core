// Q6-GW C1: the conversation itself says which chain entries were skipped while choosing a route, and why, so the
// dashboard can show it next to the answer instead of only in the router log. Contract: route_selected and
// route_switched carry data.skipped (ALWAYS an array, [] when nothing was skipped) of {target_id, label, provider,
// reason}, reason provider_unavailable | paid_ack_required, listing the entries skipped while choosing THAT route
// (attempt 2 lists its own). When the chain is exhausted after skips, the route_exhausted event (the one the
// dashboard reads) carries the same array.
// Real mock CLI children (CC_EXEC_MOCK=1, CC_ROUTER_MOCK=1) and an in-process OpenAI-compatible stub on 127.0.0.1.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, sseData } from '../src/providers/testing/mock-http-server.mjs';
import { createConversation, readConversation, appendUserTurn, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-lifecycle.mjs';
import { startRoutedTurn, isTurnBusy } from '../src/app-router/turn-router.mjs';
import { _setDeltaGapMsForTests, _setProviderFactoryForTests } from '../src/app-router/provider-turn.mjs';
import { readRouterConfig, writeRouterConfig, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { createCustomProvider, updateCustomProvider, deleteCustomProvider, readCustomProviders, _setCustomProvidersDirForTests } from '../src/providers/custom-store.mjs';
import { _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';

const ENV_KEYS = ['CC_EXEC_MOCK', 'CC_ROUTER_MOCK', 'CC_ROUTER_MOCK_MAIN_LIMIT', 'CC_EXEC_MOCK_DELAY_MS', 'CLAUDE_CONFIG_DIR', 'FORGE_ROUTER_PROFILES_DIR'];
const ANSWER = ['Hallo ', 'van je ', 'eigen server.'];
const saved = {};
const servers = [];
let tmp;
let n = 0;

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skipped-turn-'));
  fs.mkdirSync(path.join(tmp, 'conv'), { recursive: true });
  _setConversationsDirForTests(path.join(tmp, 'conv'));
  _setDeltaGapMsForTests(0);
});

beforeEach(() => {
  n += 1;
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_ROUTER_MOCK = '1';
  delete process.env.CC_ROUTER_MOCK_MAIN_LIMIT;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.FORGE_ROUTER_PROFILES_DIR = path.join(tmp, 'profiles-' + n);
  _setRouterDirForTests(path.join(tmp, 'router-' + n));
  _setCustomProvidersDirForTests(path.join(tmp, 'custom-' + n));
  _resetMergedRegistryCacheForTests();
  _resetExecBridgeForTests();
  _setProviderFactoryForTests(null);
});

afterEach(async () => {
  _resetExecBridgeForTests();
  while (servers.length) await servers.pop().close();
});

after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setDeltaGapMsForTests(null);
  _setRouterDirForTests(null);
  _setCustomProvidersDirForTests(null);
  _resetMergedRegistryCacheForTests();
  _setConversationsDirForTests(null);
  _resetConversationsForTests();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

async function openAiStub() {
  const s = await startMockServer(async (req, h) => {
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      await h.sse([
        ...ANSWER.map((t, i) => sseData({ model: 'stub-model', choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: t } : { content: t } }] })),
        sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ]);
      return;
    }
    h.json(404, { error: 'not here' });
  });
  servers.push(s);
  return s;
}

const rev = () => readCustomProviders().doc.revision;
const def = (label, baseURL, over = {}) => ({ label, format: 'openai-chat', baseURL, auth: { type: 'none' }, models: { mode: 'manual', ids: ['stub-model'] }, ...over });
function addCustom(label, baseURL = 'http://127.0.0.1:8000/v1') {
  const r = createCustomProvider(def(label, baseURL), { expectRevision: rev() });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.provider.id;
}
function remove(id) { assert.equal(deleteCustomProvider(id, { expectRevision: rev() }).ok, true); }
function addKey(id, label, baseURL) { assert.equal(updateCustomProvider(id, def(label, baseURL, { auth: { type: 'bearer' } }), { expectRevision: rev() }).ok, true); }

const custom = (id, providerId) => ({ id, kind: 'provider-model', label: 'Eigen API · ' + id, provider: providerId, model: 'stub-model', enabled: true, paid_ack: false, notice_ack: false });
const main = (enabled = true) => ({ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled, threshold_pct: null });
function storeChain(entries, mode = 'model-first') {
  const w = writeRouterConfig({ ...defaultRouterConfig(), mode, entries, revision: readRouterConfig().config.revision });
  assert.equal(w.ok, true, JSON.stringify(w.errors || w));
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
    if (recs.length > 0 && !isTurnBusy(convId)) return { recs, events: (conv.events || []).filter((e) => e.turn_id === turnId) };
    if (Date.now() > deadline) throw new Error('turn did not finish');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const turnEvents = (convId, turnId) => (readConversation(convId).events || []).filter((e) => e.turn_id === turnId);
const ofKind = (events, kind, requestId) => events.filter((e) => e.kind === kind && (requestId === undefined || e.request_id === requestId));
const skip = (targetId, provider, reason) => ({ target_id: targetId, label: 'Eigen API · ' + targetId, provider, reason });

test('route_selected lists the entry skipped while choosing it (deleted Eigen API: provider_unavailable)', async () => {
  const id = addCustom('Weg API');
  storeChain([custom('eigen', id), main()]);
  remove(id);
  const conv = createConversation({ project: 'skipped-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  const { events } = await waitDone(conv.id, r.turnId);
  const sel = ofKind(events, 'route_selected');
  assert.equal(sel.length, 1);
  assert.deepEqual(sel[0].data.skipped, [skip('eigen', id, 'provider_unavailable')]);
});

test('route_selected lists a keyed Eigen API without cost confirmation as paid_ack_required', async () => {
  const id = addCustom('Sleutel API');
  storeChain([custom('eigen', id), main()]);
  addKey(id, 'Sleutel API', 'http://127.0.0.1:8000/v1');
  const conv = createConversation({ project: 'skipped-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  const { events } = await waitDone(conv.id, r.turnId);
  assert.deepEqual(ofKind(events, 'route_selected')[0].data.skipped, [skip('eigen', id, 'paid_ack_required')]);
});

test('route_selected carries skipped: [] when nothing was skipped', async () => {
  const id = addCustom('Goed API');
  storeChain([main(), custom('eigen', id)], 'claude-then-model');
  const conv = createConversation({ project: 'skipped-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  const { events } = await waitDone(conv.id, r.turnId);
  const sel = ofKind(events, 'route_selected');
  assert.equal(sel.length, 1);
  assert.deepEqual(sel[0].data.skipped, [], 'always present, empty when nothing was skipped');
});

test('route_switched lists the skip when a conversation moves off its deleted Eigen API', async () => {
  const stub = await openAiStub();
  const id = addCustom('Stub', stub.url + '/v1');
  storeChain([custom('eigen', id), main()]);
  const conv = createConversation({ project: 'skipped-demo' });
  const first = send(conv.id, 'eerste');
  assert.equal(first.started, true, first.reason);
  const done1 = await waitDone(conv.id, first.turnId);
  assert.deepEqual(ofKind(done1.events, 'route_selected')[0].data.skipped, []);
  remove(id);
  const second = send(conv.id, 'tweede');
  assert.equal(second.started, true, second.reason);
  const { events } = await waitDone(conv.id, second.turnId);
  const sw = ofKind(events, 'route_switched');
  assert.equal(sw.length, 1);
  assert.equal(sw[0].data.from_target_id, 'eigen', 'the rest of the route record is unchanged');
  assert.deepEqual(sw[0].data.skipped, [skip('eigen', id, 'provider_unavailable')]);
  assert.deepEqual(ofKind(events, 'route_selected')[0].data.skipped, [skip('eigen', id, 'provider_unavailable')]);
});

test('at a failover that skips, attempt 2 lists its own skip on route_selected and route_switched; attempt 1 lists none', async () => {
  const stub = await openAiStub();
  const gone = addCustom('Weg API');
  const ok = addCustom('Stub', stub.url + '/v1');
  storeChain([main(), custom('eigen-weg', gone), custom('eigen-ok', ok)], 'claude-then-model');
  remove(gone);
  process.env.CC_ROUTER_MOCK_MAIN_LIMIT = '1';
  const conv = createConversation({ project: 'skipped-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(recs[0].route.target_id, 'eigen-ok');
  const r2 = r.requestId + '-r2';
  assert.deepEqual(ofKind(events, 'route_selected', r.requestId)[0].data.skipped, [], 'attempt 1 skipped nothing');
  const want = [skip('eigen-weg', gone, 'provider_unavailable')];
  assert.deepEqual(ofKind(events, 'route_selected', r2)[0].data.skipped, want);
  const sw = ofKind(events, 'route_switched', r2);
  assert.equal(sw.length, 1, JSON.stringify(events.map((e) => [e.kind, e.request_id])));
  assert.deepEqual(sw[0].data.skipped, want);
});

test('chain exhausted after a skip: route_exhausted carries the skipped entries', () => {
  const id = addCustom('Weg API');
  storeChain([custom('eigen', id), main(false)]);
  remove(id);
  const conv = createConversation({ project: 'skipped-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.code, 'router_exhausted');
  const ex = ofKind(turnEvents(conv.id, r.turnId), 'route_exhausted');
  assert.equal(ex.length, 1);
  assert.deepEqual(ex[0].data.skipped, [skip('eigen', id, 'provider_unavailable')]);
});

test('attempt 2 exhausted after its skip: the attempt-2 route_exhausted carries that skip', async () => {
  const gone = addCustom('Weg API');
  storeChain([main(), custom('eigen-weg', gone)], 'claude-then-model');
  remove(gone);
  process.env.CC_ROUTER_MOCK_MAIN_LIMIT = '1';
  const conv = createConversation({ project: 'skipped-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  const { events } = await waitDone(conv.id, r.turnId);
  const ex = ofKind(events, 'route_exhausted', r.requestId + '-r2');
  assert.equal(ex.length, 1, JSON.stringify(events.map((e) => [e.kind, e.request_id])));
  assert.deepEqual(ex[0].data.skipped, [skip('eigen-weg', gone, 'provider_unavailable')]);
});

test('Q6 not_started: attempt 1 hands the skipped list on (the route writes it onto execution_not_started)', () => {
  const gone = addCustom('Weg API');
  const ok = addCustom('Stub', 'http://127.0.0.1:8000/v1');
  storeChain([custom('eigen-weg', gone), custom('eigen-ok', ok), main(false)]);
  remove(gone);
  _setProviderFactoryForTests(() => { throw new Error('stub: provider cannot be created'); });
  const conv = createConversation({ project: 'skipped-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, false);
  assert.equal(r.code, 'not_started');
  assert.deepEqual(r.skipped, [skip('eigen-weg', gone, 'provider_unavailable')]);
});

test('Q6 not_started: attempt 2 execution_not_started carries data.skipped (always an array)', async () => {
  const gone = addCustom('Weg API');
  const ok = addCustom('Stub', 'http://127.0.0.1:8000/v1');
  storeChain([main(), custom('eigen-weg', gone), custom('eigen-ok', ok)], 'claude-then-model');
  remove(gone);
  _setProviderFactoryForTests(() => { throw new Error('stub: provider cannot be created'); });
  process.env.CC_ROUTER_MOCK_MAIN_LIMIT = '1';
  const conv = createConversation({ project: 'skipped-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  const { events } = await waitDone(conv.id, r.turnId);
  const ns = ofKind(events, 'execution_not_started', r.requestId + '-r2');
  assert.equal(ns.length, 1);
  assert.equal(ns[0].data.attempt, 2);
  assert.deepEqual(ns[0].data.skipped, [skip('eigen-weg', gone, 'provider_unavailable')]);
});
