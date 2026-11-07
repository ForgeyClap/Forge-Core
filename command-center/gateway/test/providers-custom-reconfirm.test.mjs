// ANY-MODEL-PLAN 2.2 C/D: PATCH /api/providers/custom/:id answers key_reconfirm_required. When a saved change
// moves a keyed entry to another (normalised) address while a key is stored for it, that key would now go to the
// new server, so the dashboard asks the user to confirm the key again. The route only asks the gateway key store
// whether a key is present (dev tree: the plain environment variable); the key never appears in an answer or in
// custom.json. Runs against the REAL gateway listener (server.mjs createServer); the store and router folders are
// fresh temp folders. No outbound call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, _configureRateLimitForTests } from '../src/server.mjs';
import { _setCustomProvidersDirForTests, customProvidersFile } from '../src/providers/custom-store.mjs';
import { _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';
import { _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { requestWithBody } from '../test-support/helpers.mjs';

const COLLECTION = '/api/providers/custom';
const KEY_NAME = 'CUSTOM_MIJN_VLLM_API_KEY';
const PLACEHOLDER = 'forge-test-placeholder-' + 'r'.repeat(24);

let tmp;
let server;
let port;
let savedKey;

function listen(s) {
  return new Promise((resolve, reject) => {
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}

before(async () => {
  savedKey = process.env[KEY_NAME];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-custom-reconfirm-'));
  _setCustomProvidersDirForTests(path.join(tmp, 'store'));
  _setRouterDirForTests(path.join(tmp, 'router'));
  _resetMergedRegistryCacheForTests();
  _configureRateLimitForTests();
  server = createServer();
  port = await listen(server);
});

after(async () => {
  if (savedKey === undefined) delete process.env[KEY_NAME]; else process.env[KEY_NAME] = savedKey;
  await new Promise((resolve) => server.close(resolve));
  _setCustomProvidersDirForTests(null);
  _setRouterDirForTests(null);
  _resetMergedRegistryCacheForTests();
  _configureRateLimitForTests();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function def(over = {}) {
  return {
    label: 'Mijn vLLM', format: 'openai-chat', baseURL: 'http://127.0.0.1:8000/v1', auth: { type: 'bearer' },
    models: { mode: 'endpoint' }, extraHeaders: {}, contextLength: null, enabled: true, ...over,
  };
}
const create = (body) => requestWithBody(port, COLLECTION, { jsonBody: body });
const patch = (id, body) => requestWithBody(port, COLLECTION + '/' + id, { method: 'PATCH', jsonBody: body });

test('PATCH that moves an entry with a stored key to another address answers key_reconfirm_required: true; the key never appears', async () => {
  process.env[KEY_NAME] = PLACEHOLDER; // dev tree: the plain environment variable is the stored key
  const made = await create({ revision: 0, provider: def() });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json.key_reconfirm_required, undefined, 'only PATCH answers the flag');

  const label = await patch('custom-mijn-vllm', { revision: 1, provider: def({ label: 'Mijn vLLM 2' }) });
  assert.equal(label.statusCode, 200, label.body);
  assert.equal(label.json.key_reconfirm_required, false, 'same address: nothing to re-confirm');

  const moved = await patch('custom-mijn-vllm', { revision: 2, provider: def({ baseURL: 'http://127.0.0.1:9000/v1' }) });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json.key_reconfirm_required, true, 'a new address with a stored key: the UI must ask to confirm the key');
  assert.equal(moved.body.includes(PLACEHOLDER), false, 'the key is never in the answer');

  const respelled = await patch('custom-mijn-vllm', { revision: 3, provider: def({ baseURL: 'http://127.0.0.1:9000/v1/' }) });
  assert.equal(respelled.json.key_reconfirm_required, false, 'the same address spelled with a trailing slash is not a move');

  delete process.env[KEY_NAME];
  const noKey = await patch('custom-mijn-vllm', { revision: 4, provider: def({ baseURL: 'http://127.0.0.1:9100/v1' }) });
  assert.equal(noKey.json.key_reconfirm_required, false, 'no stored key: nothing to re-confirm');

  process.env[KEY_NAME] = PLACEHOLDER;
  const keyless = await patch('custom-mijn-vllm', { revision: 5, provider: def({ auth: { type: 'none' }, baseURL: 'http://127.0.0.1:9200/v1' }) });
  assert.equal(keyless.json.key_reconfirm_required, false, 'auth none never sends the key');

  const stale = await patch('custom-mijn-vllm', { revision: 1, provider: def({ baseURL: 'http://127.0.0.1:9300/v1' }) });
  assert.equal(stale.statusCode, 409, 'a refused write answers no flag');
  assert.equal(stale.json.key_reconfirm_required, undefined);

  assert.equal(fs.readFileSync(customProvidersFile(), 'utf8').includes(PLACEHOLDER), false, 'the key is never in custom.json');
});
