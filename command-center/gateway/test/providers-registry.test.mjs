// WP B2 part 1: registry validation. Proves the shipped registry loads (35 catalogue providers), that
// every bad-entry class the loader promises to catch is caught loudly (one RegistryError listing all
// problems), and that template values cannot inject a different host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRegistry, validateRegistryDocument, resolveBaseURL, RegistryError, REGISTRY_FILE, REGISTRY_SCHEMA_FILE,
  _resetRegistryCacheForTests,
} from '../src/providers/registry.mjs';
import { validate } from '../src/providers/schema-validate.mjs';
import { createProvider, adapterNames } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';

const schema = JSON.parse(fs.readFileSync(REGISTRY_SCHEMA_FILE, 'utf8'));
const shipped = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
const CATALOGUE_IDS = [
  'openai', 'anthropic', 'gemini-native', 'gemini-openai', 'xai', 'mistral', 'deepseek', 'groq', 'together', 'fireworks',
  'perplexity', 'cohere', 'openrouter', 'nvidia-nim', 'azure-openai', 'bedrock', 'huggingface', 'cerebras', 'sambanova',
  'moonshot', 'zhipu-zai', 'qwen-dashscope', 'ollama-local', 'ollama-cloud', 'lmstudio', 'llamacpp', 'vllm', 'jan',
  'cloudflare-workers-ai', 'vercel-ai-gateway', 'litellm-proxy', 'claude-code-cli', 'codex-cli', 'gemini-cli', 'grok-build-cli',
];

function withEntry(mutate) {
  const doc = structuredClone(shipped);
  mutate(doc);
  return validateRegistryDocument(doc, schema);
}

test('the shipped registry loads and holds exactly the 35 catalogue providers', () => {
  _resetRegistryCacheForTests();
  const reg = loadRegistry();
  assert.deepEqual([...reg.ids()].sort(), [...CATALOGUE_IDS].sort());
  assert.equal(reg.providers.length, 35);
  assert.ok(Object.isFrozen(reg.get('openai')), 'entries are frozen');
});

test('every registry entry maps to an implemented adapter, can be constructed, and info() never shows a key', () => {
  const reg = loadRegistry();
  const keys = {};
  for (const p of reg.providers) if (p.keyEnvName) keys[p.keyEnvName] = 'fakekey-' + p.keyEnvName.toLowerCase() + '-0123456789';
  for (const p of reg.providers) {
    assert.ok(adapterNames().includes(p.adapter), p.id + ' adapter ' + p.adapter);
    const prov = createProvider(p.id, { keyProvider: new MemoryKeyProvider(keys), registry: reg });
    assert.equal(prov.id, p.id);
    const info = JSON.stringify(prov.info());
    for (const v of Object.values(keys)) assert.equal(info.includes(v), false, p.id + ' info() leaked a key');
    assert.equal(prov.info().keyEnvName, p.keyEnvName, 'the card shows the variable NAME only');
  }
});

test('GitHub Models (retired 2026-07-30) is not in the registry', () => {
  assert.equal(loadRegistry().get('github-models'), null);
});

test('anthropic entry pins anthropic-version 2026-10-21; subscription CLIs require a terms notice', () => {
  const reg = loadRegistry();
  assert.equal(reg.get('anthropic').extraHeaders['anthropic-version'], '2026-10-21');
  for (const id of ['claude-code-cli', 'codex-cli', 'gemini-cli', 'grok-build-cli']) {
    const p = reg.get(id);
    assert.equal(p.subscription, true);
    assert.equal(p.noticeRequired, true);
    assert.ok(p.tosNote && p.tosNote.length > 10);
  }
  assert.deepEqual(reg.get('claude-code-cli').forbiddenArgs, ['--bare']);
});

test('schema errors are reported: missing field, unknown field, bad enum, bad URL with userinfo', () => {
  const problems = withEntry((d) => {
    delete d.providers[0].label;
    d.providers[1].surprise = true;
    d.providers[2].adapter = 'telepathy';
    d.providers[3].baseURL = 'https://user:pass@example.com/v1';
  });
  const text = problems.join('\n');
  assert.match(text, /missing required field "label"/);
  assert.match(text, /unknown field "surprise"/);
  assert.match(text, /"telepathy" is not one of/);
  assert.match(text, /does not match/);
});

test('semantic errors are reported: duplicate id, keyed auth without key name, http remote, undeclared template var', () => {
  const problems = withEntry((d) => {
    d.providers[1].id = d.providers[0].id;
    d.providers[2].keyEnvName = null; // gemini-native uses x-goog-api-key
    d.providers[4].baseURL = 'http://api.x.ai/v1';
    d.providers[5].baseURL = 'https://{tenant}.mistral.ai/v1';
  });
  const text = problems.join('\n');
  assert.match(text, /duplicate id/);
  assert.match(text, /needs keyEnvName/);
  assert.match(text, /remote providers must use https/);
  assert.match(text, /\{tenant\} but templateVars does not declare it/);
});

test('an auth header in extraHeaders and a key-shaped value anywhere are refused', () => {
  const fakeKey = 'sk-' + 'x'.repeat(30); // built at run time, not a real key
  const problems = withEntry((d) => {
    d.providers[0].extraHeaders = { Authorization: 'Bearer something' };
    d.providers[1].notes = 'example ' + fakeKey;
  });
  const text = problems.join('\n');
  assert.match(text, /must not carry the auth header Authorization/);
  assert.match(text, /shaped like an API key/);
});

test('a local provider must point at loopback; CLI adapters must not have a baseURL', () => {
  const problems = withEntry((d) => {
    const ol = d.providers.find((p) => p.id === 'lmstudio');
    ol.baseURL = 'http://192.168.1.5:{port}/v1';
    const cli = d.providers.find((p) => p.id === 'codex-cli');
    cli.baseURL = 'https://example.com';
  });
  const text = problems.join('\n');
  assert.match(text, /loopback/);
  assert.match(text, /CLI adapters have baseURL null/);
});

test('loadRegistry fails loud with a RegistryError listing every problem of a bad file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-providers-reg-'));
  try {
    const bad = structuredClone(shipped);
    bad.providers[0].verifiedOn = 'yesterday';
    bad.providers[1].streaming = 'sometimes';
    const file = path.join(dir, 'registry.json');
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadRegistry({ file, useCache: false }), (err) => {
      assert.ok(err instanceof RegistryError);
      assert.ok(err.problems.length >= 2, 'all problems are listed, not just the first');
      assert.match(err.message, /verifiedOn/);
      assert.match(err.message, /streaming/);
      return true;
    });
    // semantic rules run once the shape is valid, and also list every problem
    const bad2 = structuredClone(shipped);
    bad2.providers[0].modelsMode = 'static';
    bad2.providers[1].keyEnvName = null;
    fs.writeFileSync(file, JSON.stringify(bad2));
    assert.throws(() => loadRegistry({ file, useCache: false }), (err) => err.problems.length >= 3);
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => loadRegistry({ file, useCache: false }), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBaseURL fills defaults, requires missing values, and refuses host injection', () => {
  const reg = loadRegistry();
  assert.equal(resolveBaseURL(reg.get('ollama-local')), 'http://127.0.0.1:11434');
  assert.equal(resolveBaseURL(reg.get('bedrock'), { region: 'eu-west-1' }), 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1');
  assert.throws(() => resolveBaseURL(reg.get('azure-openai')), (e) => e.code === 'NOT_CONFIGURED' && /\{resource\}/.test(e.message));
  assert.throws(() => resolveBaseURL(reg.get('azure-openai'), { resource: 'evil.com/x#' }), (e) => e.code === 'CONFIG');
  assert.throws(() => resolveBaseURL(reg.get('ollama-local'), { port: '1@evil' }), (e) => e.code === 'CONFIG');
  assert.equal(resolveBaseURL(reg.get('qwen-dashscope'), { workspace: 'ws-1' }), 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
});

test('schema-validate refuses a schema keyword it does not implement', () => {
  assert.throws(() => validate({ type: 'object', oneOf: [] }, {}), /unsupported keyword "oneOf"/);
});
