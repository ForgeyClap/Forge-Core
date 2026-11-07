// ANY-MODEL-PLAN 2.2 F / 2.4: a routed chat turn on the user's own "Eigen API" entry (custom-*), end to end:
// the definition is saved in the overlay store, a router chain names it, startRoutedTurn picks it and the answer
// streams from a stub OpenAI-compatible server on 127.0.0.1 (providers/testing/mock-http-server.mjs).
//
//   - the turn runs on the MERGED registry (bundled + custom), so a custom-* entry starts at all;
//   - a keyed entry sends the key from the gateway key store (dev tree: the plain environment variable);
//   - the saved address is re-checked (verifyCustomTarget) right before the outbound call: when the saved file
//     no longer allows the address the router still has in memory (a blocked address, or another address
//     written outside the gateway with the same size and time stamp), the turn is refused BEFORE any request,
//     with a visible error (the assistant record's error and a forge_error event, Dutch first);
//   - a custom id that is not in the registry any more ends with a visible refusal instead of a silent no-start;
//   - the router probe path (createRouterProvider) uses the merged registry and refuses the same way.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, sseData } from '../src/providers/testing/mock-http-server.mjs';
import { createConversation, readConversation, appendUserTurn, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-lifecycle.mjs';
import { startRoutedTurn, isTurnBusy } from '../src/app-router/turn-router.mjs';
import { startProviderTurn, createRouterProvider, _setDeltaGapMsForTests } from '../src/app-router/provider-turn.mjs';
import { readRouterConfig, writeRouterConfig, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { createCustomProvider, customProvidersFile, readCustomProviders, _setCustomProvidersDirForTests } from '../src/providers/custom-store.mjs';
import { loadMergedRegistry, _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';

const ENV_KEYS = ['CC_EXEC_MOCK', 'CC_ROUTER_MOCK', 'CC_EXEC_MOCK_DELAY_MS', 'CLAUDE_CONFIG_DIR', 'FORGE_ROUTER_PROFILES_DIR', 'CUSTOM_SLEUTEL_STUB_API_KEY'];
// A fixed, whole-millisecond file time: an outside rewrite that keeps size and time leaves the registry cache stamp unchanged.
const PINNED = new Date('2026-11-01T10:00:00.000Z');
const ANSWER = ['Hallo ', 'van je ', 'eigen server.'];
const TEST_KEY = 'forge-test-placeholder-' + 'q'.repeat(24);
const saved = {};
let tmp;
let n = 0;
const servers = [];

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-custom-turn-'));
  fs.mkdirSync(path.join(tmp, 'conv'), { recursive: true });
  _setConversationsDirForTests(path.join(tmp, 'conv'));
  _setDeltaGapMsForTests(0);
});

beforeEach(() => {
  n += 1;
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_ROUTER_MOCK = '1';
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CUSTOM_SLEUTEL_STUB_API_KEY;
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

/** A stub OpenAI-compatible server: POST /v1/chat/completions streams ANSWER as chat-completion chunks. */
async function openAiStub() {
  const s = await startMockServer(async (req, h) => {
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      await h.sse([
        ...ANSWER.map((t, i) => sseData({ model: 'stub-model', choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: t } : { content: t } }] })),
        sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        sseData({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }),
        'data: [DONE]\n\n',
      ]);
      return;
    }
    h.json(404, { error: 'not here' });
  });
  servers.push(s);
  return s;
}

function saveCustom(over = {}) {
  const r = createCustomProvider({
    label: 'Stub', format: 'openai-chat', auth: { type: 'none' }, models: { mode: 'manual', ids: ['stub-model'] }, ...over,
  }, { expectRevision: readCustomProviders().doc.revision });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.provider;
}

const customEntry = (providerId, extra = {}) => ({ id: 'eigen', kind: 'provider-model', label: 'Eigen API · stub', provider: providerId, model: 'stub-model', enabled: true, paid_ack: false, notice_ack: false, ...extra });
const mainEntry = () => ({ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: false, threshold_pct: null });

function chainOn(entry) {
  const current = readRouterConfig().config;
  const r = writeRouterConfig({ ...defaultRouterConfig(), mode: 'model-first', entries: [entry, mainEntry()], revision: current.revision });
  assert.equal(r.ok, true, JSON.stringify(r.errors || r));
}
function send(convId, text) {
  const { turnId, requestId } = appendUserTurn(convId, text, {});
  return { ...startRoutedTurn({ convId, turnId, requestId, text, cwd: os.tmpdir() }), turnId, requestId };
}
async function waitDone(convId, turnId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conv = readConversation(convId);
    const recs = (conv.turns || []).filter((t) => t.role === 'assistant' && t.turn_id === turnId);
    if (recs.length > 0 && !isTurnBusy(convId)) return { recs, events: (conv.events || []).filter((e) => e.turn_id === turnId) };
    if (Date.now() > deadline) throw new Error('turn did not finish');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Rewrites custom.json the way a program outside the gateway could: same byte size, same (pinned) file time, so
 * the merged registry's cache stamp does not change and the router keeps the address it already has in memory.
 */
function rewriteOutsideSameStamp(mutate) {
  const file = customProvidersFile();
  const size = fs.statSync(file).size;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(doc);
  const compact = JSON.stringify(doc);
  assert.ok(Buffer.byteLength(compact) < size, 'the compact rewrite fits in the original size');
  fs.writeFileSync(file, compact + ' '.repeat(size - Buffer.byteLength(compact) - 1) + '\n', 'utf8');
  fs.utimesSync(file, PINNED, PINNED);
  assert.equal(fs.statSync(file).size, size);
}
function pinFileTime() {
  fs.utimesSync(customProvidersFile(), PINNED, PINNED);
}

test('HIGH: a routed turn on a saved Eigen API entry starts and streams the stub answer (merged registry, answers-only)', async () => {
  const stub = await openAiStub();
  const p = saveCustom({ baseURL: stub.url + '/v1' });
  assert.equal(p.id, 'custom-stub');
  chainOn(customEntry('custom-stub'));
  const conv = createConversation({ project: 'eigen-api-demo' });
  const r = send(conv.id, 'Zeg hallo');
  assert.equal(r.started, true, r.reason);
  assert.equal(r.route.entry.id, 'eigen');
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(recs.length, 1);
  const rec = recs[0];
  assert.equal(rec.text, ANSWER.join(''));
  assert.equal(rec.error, null);
  assert.deepEqual({ kind: rec.route.kind, cap: rec.route.capability, outcome: rec.route.outcome, model: rec.model, inT: rec.input_tokens, outT: rec.output_tokens },
    { kind: 'provider-model', cap: 'answers-only', outcome: 'ok', model: 'stub-model', inT: 12, outT: 6 });
  const live = events.filter((e) => e.kind === 'provider_delta').map((e) => e.data.text).join('');
  assert.equal(live, ANSWER.join(''), 'the answer streamed as provider_delta events');
  assert.ok(events.some((e) => e.kind === 'route_selected' && e.data.target_id === 'eigen'));
  assert.equal(stub.requests.length, 1, 'exactly one outbound call');
  const call = stub.requests[0];
  assert.deepEqual({ method: call.method, path: call.path, model: call.body.model, stream: call.body.stream }, { method: 'POST', path: '/v1/chat/completions', model: 'stub-model', stream: true });
  assert.equal(call.body.messages.at(-1).content, 'Zeg hallo');
  assert.equal(call.headers.authorization, undefined, 'auth none sends no Authorization header');
  assert.equal(call.body.tools, undefined, 'answers-only: no tools are offered');
});

test('a keyed Eigen API entry sends the key from the gateway key store (dev tree: the plain environment variable); the key is never stored', async () => {
  const stub = await openAiStub();
  saveCustom({ label: 'Sleutel stub', baseURL: stub.url + '/v1', auth: { type: 'bearer' } });
  process.env.CUSTOM_SLEUTEL_STUB_API_KEY = TEST_KEY;
  chainOn(customEntry('custom-sleutel-stub', { paid_ack: true }));
  const conv = createConversation({ project: 'eigen-api-demo' });
  const r = send(conv.id, 'Met sleutel');
  assert.equal(r.started, true, r.reason);
  const { recs } = await waitDone(conv.id, r.turnId);
  assert.equal(recs[0].text, ANSWER.join(''));
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].headers.authorization, 'Bearer ' + TEST_KEY);
  const convDir = path.join(tmp, 'conv');
  for (const f of fs.readdirSync(convDir, { recursive: true })) {
    const full = path.join(convDir, String(f));
    if (fs.statSync(full).isFile()) assert.equal(fs.readFileSync(full, 'utf8').includes(TEST_KEY), false, 'no key in ' + f);
  }
  assert.equal(fs.readFileSync(customProvidersFile(), 'utf8').includes(TEST_KEY), false, 'no key in custom.json');
});

test('a saved address rewritten outside the gateway to a blocked (cloud metadata) address is refused before any request, visibly', async () => {
  const stub = await openAiStub();
  saveCustom({ baseURL: stub.url + '/v1' });
  pinFileTime();
  chainOn(customEntry('custom-stub')); // validates against the merged registry: the cache now holds the stub address
  assert.equal(loadMergedRegistry().get('custom-stub').baseURL, stub.url + '/v1');
  rewriteOutsideSameStamp((doc) => { doc.providers[0].baseURL = 'http://169.254.169.254/v1'; });
  assert.equal(loadMergedRegistry().get('custom-stub').baseURL, stub.url + '/v1', 'precondition: the registry in memory still has the old address');
  const conv = createConversation({ project: 'eigen-api-demo' });
  const r = send(conv.id, 'Mag niet');
  assert.equal(r.started, true, r.reason);
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(stub.requests.length, 0, 'no request left the gateway');
  const rec = recs[0];
  assert.equal(rec.route.outcome, 'error');
  assert.equal(rec.text, '');
  assert.match(rec.error, /^Deze eigen API bestaat niet meer\./, 'Dutch first');
  assert.match(rec.error, /This own API no longer exists\./);
  const fe = events.find((e) => e.kind === 'forge_error');
  assert.ok(fe, 'a forge_error event makes the refusal visible in the chat');
  assert.equal(fe.data.code, 'unknown');
  assert.match(fe.data.details, /eigen API/);
});

test('a saved address changed outside the gateway to another allowed address is refused (target_changed); neither server gets a request', async () => {
  const stub = await openAiStub();
  const other = await openAiStub();
  saveCustom({ baseURL: stub.url + '/v1' });
  pinFileTime();
  chainOn(customEntry('custom-stub'));
  rewriteOutsideSameStamp((doc) => { doc.providers[0].baseURL = 'http://127.0.0.2:' + other.port + '/v1'; });
  assert.equal(loadMergedRegistry().get('custom-stub').baseURL, stub.url + '/v1', 'precondition: stale address in memory');
  const conv = createConversation({ project: 'eigen-api-demo' });
  const r = send(conv.id, 'Ander adres');
  assert.equal(r.started, true, r.reason);
  const { recs, events } = await waitDone(conv.id, r.turnId);
  assert.equal(stub.requests.length + other.requests.length, 0, 'no request to the old or the new address');
  assert.match(recs[0].error, /^Het adres van deze eigen API is gewijzigd\./);
  assert.ok(events.some((e) => e.kind === 'forge_error' && /gewijzigd/.test(e.data.details)));
});

test('a custom id that is not in the registry any more ends with a visible refusal, not a silent no-start', async () => {
  const conv = createConversation({ project: 'eigen-api-demo' });
  const { turnId, requestId } = appendUserTurn(conv.id, 'Weg', {});
  const route = { target_id: 'eigen', kind: 'provider-model', label: 'Eigen API · weg', model: 'stub-model', capability: 'answers-only', reason: 'first', switched: false, attempt: 1, retried: false, outcome: null, handover: null };
  const r = startProviderTurn({ convId: conv.id, turnId, requestId, text: 'Weg', cwd: os.tmpdir(), route, entry: customEntry('custom-weg'), handover: null, onSettled: () => ({ retried: false }) });
  assert.equal(r.started, true, r.reason);
  const { recs, events } = await waitDone(conv.id, turnId);
  assert.match(recs[0].error, /^Deze eigen API bestaat niet meer\./);
  assert.ok(events.some((e) => e.kind === 'forge_error'));
});

test('the router probe path (createRouterProvider) uses the merged registry and refuses a target the saved file no longer allows', async () => {
  const stub = await openAiStub();
  saveCustom({ baseURL: stub.url + '/v1' });
  pinFileTime();
  const provider = createRouterProvider(customEntry('custom-stub'));
  assert.equal(provider.id, 'custom-stub');
  assert.equal(provider.baseURL(), stub.url + '/v1');
  rewriteOutsideSameStamp((doc) => { doc.providers[0].baseURL = 'http://169.254.169.254/v1'; });
  assert.throws(() => createRouterProvider(customEntry('custom-stub')), /no longer exists/);
  assert.equal(stub.requests.length, 0);
});
