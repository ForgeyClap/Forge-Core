// Q5-EIGEN-API: the turn router and an "Eigen API" (custom-*) chain entry that is no longer usable (deleted or
// turned off in the custom store). Before the fix router.json read as UNREADABLE, the router fell back to off and
// the turn silently ran on the main Claude account. Now:
//
//   - the unavailable entry is SKIPPED with a router event (router_entry_skipped, reason provider_unavailable)
//     and the turn continues on the next chain entry; the router stays on (the turn is routed, route != null);
//   - a conversation that was ON that entry moves on visibly (switched, from the old entry);
//   - attempt 2 after a failover skips it the same way;
//   - nothing usable left -> exactly the "chain exhausted" path (no start, route_exhausted), never a silent
//     run on the main account;
//   - routerPreview never names an unavailable entry.
// Real mock CLI children (CC_EXEC_MOCK=1, CC_ROUTER_MOCK=1) and an in-process OpenAI-compatible stub on 127.0.0.1.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, sseData } from '../src/providers/testing/mock-http-server.mjs';
import { createConversation, readConversation, appendUserTurn, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-lifecycle.mjs';
import { startRoutedTurn, isTurnBusy, routerPreview } from '../src/app-router/turn-router.mjs';
import { _setDeltaGapMsForTests } from '../src/app-router/provider-turn.mjs';
import { readRouterConfig, writeRouterConfig, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { readRouterEvents } from '../src/app-router/router-log.mjs';
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-unavail-turn-'));
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
function turnOff(id, label, baseURL) { assert.equal(updateCustomProvider(id, def(label, baseURL, { enabled: false }), { expectRevision: rev() }).ok, true); }

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
const skipped = () => readRouterEvents().filter((e) => e.kind === 'router_entry_skipped');

test('a deleted Eigen API entry first in the chain is skipped with a router event; the turn runs on the next entry, routed', async () => {
  const id = addCustom('Weg API');
  storeChain([custom('eigen', id), main()]);
  remove(id);
  const conv = createConversation({ project: 'unavail-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  assert.ok(r.route, 'the router stayed on (a route decision, not the router-off null)');
  assert.equal(r.route.entry.id, 'main');
  const ev = skipped();
  assert.equal(ev.length, 1, JSON.stringify(readRouterEvents()));
  assert.deepEqual({ conv: ev[0].conv_id, turn: ev[0].turn_id, target: ev[0].target_id, provider: ev[0].provider, reason: ev[0].reason },
    { conv: conv.id, turn: r.turnId, target: 'eigen', provider: id, reason: 'provider_unavailable' });
  const { recs } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].route.target_id, 'main', 'the answer is a routed record on the next entry');
});

test('a turned-off Eigen API entry is skipped the same way', async () => {
  const id = addCustom('Uit API');
  storeChain([custom('eigen', id), main()]);
  turnOff(id, 'Uit API', 'http://127.0.0.1:8000/v1');
  const conv = createConversation({ project: 'unavail-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  assert.equal(r.route && r.route.entry.id, 'main');
  assert.equal(skipped().length, 1);
  await waitDone(conv.id, r.turnId);
});

test('a conversation that was ON the Eigen API moves on visibly once it is deleted (switched, from the old entry)', async () => {
  const stub = await openAiStub();
  const id = addCustom('Stub', stub.url + '/v1');
  storeChain([custom('eigen', id), main()]);
  const conv = createConversation({ project: 'unavail-demo' });
  const first = send(conv.id, 'eerste');
  assert.equal(first.started, true, first.reason);
  assert.equal(first.route.entry.id, 'eigen');
  const done1 = await waitDone(conv.id, first.turnId);
  assert.equal(done1.recs[0].text, ANSWER.join(''));

  remove(id);
  const second = send(conv.id, 'tweede');
  assert.equal(second.started, true, second.reason);
  assert.equal(second.route.entry.id, 'main');
  assert.equal(second.route.switched, true, 'the move is visible');
  assert.equal(second.route.from && second.route.from.target_id, 'eigen');
  const { events } = await waitDone(conv.id, second.turnId);
  const sw = events.find((e) => e.kind === 'route_switched');
  assert.ok(sw, 'a route_switched event in the conversation');
  assert.equal(sw.data.from_target_id, 'eigen');
  assert.equal(sw.data.from_label, 'Eigen API · eigen', 'the old entry keeps its own name');
  assert.equal(stub.requests.length, 1, 'the deleted Eigen API got no second request');
  assert.equal(skipped().length, 1);
});

test('attempt 2 after a failover skips an unavailable entry too and lands on the next usable one', async () => {
  const stub = await openAiStub();
  const gone = addCustom('Weg API');
  const ok = addCustom('Stub', stub.url + '/v1');
  storeChain([main(), custom('eigen-weg', gone), custom('eigen-ok', ok)], 'claude-then-model');
  remove(gone);
  process.env.CC_ROUTER_MOCK_MAIN_LIMIT = '1';
  const conv = createConversation({ project: 'unavail-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, true, r.reason);
  assert.equal(r.route.entry.id, 'main');
  const { recs } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].route.target_id, 'eigen-ok');
  assert.equal(recs[0].route.attempt, 2);
  assert.equal(recs[0].text, ANSWER.join(''));
  const ev = skipped();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].target_id, 'eigen-weg');
});

test('nothing usable left after the skip: exactly the chain-exhausted path, never a silent run on the main account', async () => {
  const id = addCustom('Weg API');
  storeChain([custom('eigen', id), main(false)]);
  remove(id);
  const conv = createConversation({ project: 'unavail-demo' });
  const r = send(conv.id, 'hallo');
  assert.equal(r.started, false, 'no turn starts');
  assert.equal(r.code, 'router_exhausted');
  assert.equal(isTurnBusy(conv.id), false);
  const events = (readConversation(conv.id).events || []).filter((e) => e.turn_id === r.turnId);
  assert.ok(events.some((e) => e.kind === 'route_exhausted'));
  assert.ok(events.some((e) => e.kind === 'forge_error'));
  const kinds = readRouterEvents().map((e) => e.kind);
  assert.ok(kinds.includes('router_entry_skipped'));
  assert.ok(kinds.includes('router_exhausted'));
  const turns = (readConversation(conv.id).turns || []).filter((t) => t.role === 'assistant');
  assert.equal(turns.length, 0, 'the main account did not answer');
});

test('routerPreview never names an unavailable entry and writes no skip event', () => {
  const id = addCustom('Weg API');
  storeChain([custom('eigen', id), main()]);
  remove(id);
  const p = routerPreview();
  assert.ok(p, 'router on: a preview');
  assert.equal(p.kind, 'target');
  assert.equal(p.entry.id, 'main');
  assert.equal(skipped().length, 0, 'a preview is read-only');
});
