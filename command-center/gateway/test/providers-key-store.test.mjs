// WP B2 part 2: the gateway key store (key-provider.mjs VaultEnvKeyProvider + GatewayKeyStore).
// Every test uses a PLAIN OBJECT as the environment, so no real variable is read or changed, plus its
// own Redactor. A planted key string must never appear in any status, description or log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VaultEnvKeyProvider, GatewayKeyStore, keyLast4, VAULT_ENV_PREFIX, VAULT_MARKER_ENV,
} from '../src/providers/key-provider.mjs';
import { Redactor } from '../src/providers/redact-guard.mjs';

const PLANTED = 'sk-forge-PLANTED-key-0123456789abcdefXYZ9';
const PLANTED_ENV = 'sk-forge-ENVONLY-key-0123456789abcdefQRS7';

// Captures everything written through console.* and process.stdout/stderr while fn runs.
async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return origOut(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return origErr(chunk, ...rest); };
  try { return { result: await fn(), lines }; }
  finally {
    Object.assign(console, orig);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test('the vault prefix and marker names match contract-keys.md', () => {
  assert.equal(VAULT_ENV_PREFIX, 'FORGE_KEY_');
  assert.equal(VAULT_MARKER_ENV, 'FORGE_KEYS_FROM_VAULT');
});

test('vault present: FORGE_KEY_<NAME> is returned for <NAME> and removed from the env object', async () => {
  const env = { FORGE_KEY_OPENAI_API_KEY: PLANTED, FORGE_KEYS_FROM_VAULT: '1', PATH: 'x' };
  const store = new GatewayKeyStore({ env, redactor: new Redactor() });
  assert.equal(await store.keyProvider().getKey('OPENAI_API_KEY'), PLANTED);
  assert.equal(env.FORGE_KEY_OPENAI_API_KEY, undefined, 'scrubbed from the env');
  assert.equal(env.FORGE_KEYS_FROM_VAULT, '1', 'the marker is not a key and stays');
  assert.equal(env.PATH, 'x');
  assert.deepEqual(store.info(), { from_app: true, captured: 1, source_order: ['vault', 'env'] });
});

test('env present, vault absent: the plain name is the fallback source and is NOT scrubbed', async () => {
  const env = { GROQ_API_KEY: PLANTED_ENV };
  const store = new GatewayKeyStore({ env, redactor: new Redactor() });
  assert.equal(await store.keyProvider().getKey('GROQ_API_KEY'), PLANTED_ENV);
  assert.equal(env.GROQ_API_KEY, PLANTED_ENV);
  const s = await store.status('GROQ_API_KEY');
  assert.deepEqual(s, { name: 'GROQ_API_KEY', present: true, source: 'env', last4: 'QRS7' });
});

test('both present: the vault wins over the plain environment', async () => {
  const env = { FORGE_KEY_GROQ_API_KEY: PLANTED, GROQ_API_KEY: PLANTED_ENV };
  const store = new GatewayKeyStore({ env, redactor: new Redactor() });
  assert.equal(await store.keyProvider().getKey('GROQ_API_KEY'), PLANTED);
  assert.equal((await store.status('GROQ_API_KEY')).source, 'vault');
});

test('absent everywhere (or blank): a clear "no key" state, null from getKey', async () => {
  const env = { FORGE_KEY_XAI_API_KEY: '   ', MISTRAL_API_KEY: '' };
  const store = new GatewayKeyStore({ env, redactor: new Redactor() });
  for (const name of ['XAI_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY']) {
    assert.equal(await store.keyProvider().getKey(name), null);
    assert.deepEqual(await store.status(name), { name, present: false, source: null, last4: null });
  }
  assert.equal(env.FORGE_KEY_XAI_API_KEY, undefined, 'a blank vault entry is still scrubbed');
  assert.equal(store.info().from_app, false);
});

test('case-insensitive prefix (Windows env names) and invalid names: scrubbed, never captured', async () => {
  const env = { forge_key_openai_api_key: PLANTED, 'FORGE_KEY_bad-name': PLANTED_ENV, FORGE_KEY_: PLANTED_ENV };
  const vault = new VaultEnvKeyProvider({ env, redactor: new Redactor() });
  assert.equal(await vault.getKey('OPENAI_API_KEY'), PLANTED);
  assert.equal(vault.size, 1);
  assert.deepEqual(Object.keys(env), [], 'every FORGE_KEY_* entry left the env');
});

test('last4 only for keys of at least 16 characters', () => {
  assert.equal(keyLast4('abcdefghijklmnop'), 'mnop');
  assert.equal(keyLast4('short-key-123'), null);
  assert.equal(keyLast4(null), null);
});

test('reload() captures a FORGE_KEY_* added later and keeps earlier ones', async () => {
  const env = { FORGE_KEY_OPENAI_API_KEY: PLANTED };
  const store = new GatewayKeyStore({ env, redactor: new Redactor() });
  env.FORGE_KEY_HF_TOKEN = PLANTED_ENV;
  assert.deepEqual(store.reload(), { added: 1, captured: 2 });
  assert.equal(await store.keyProvider().getKey('HF_TOKEN'), PLANTED_ENV);
  assert.equal(await store.keyProvider().getKey('OPENAI_API_KEY'), PLANTED);
  assert.equal(env.FORGE_KEY_HF_TOKEN, undefined);
});

test('fingerprint is stable per value, differs per value, and never contains the key', async () => {
  const env = { FORGE_KEY_OPENAI_API_KEY: PLANTED };
  const store = new GatewayKeyStore({ env, redactor: new Redactor() });
  const a = await store.fingerprint('OPENAI_API_KEY');
  assert.equal(a, await store.fingerprint('OPENAI_API_KEY'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!PLANTED.includes(a));
  const other = new GatewayKeyStore({ env: { FORGE_KEY_OPENAI_API_KEY: PLANTED_ENV }, redactor: new Redactor() });
  assert.notEqual(await other.fingerprint('OPENAI_API_KEY'), a);
  assert.equal(await store.fingerprint('GROQ_API_KEY'), null);
});

test('NEVER-LOG GUARD: the planted key appears in no status, description, info or log line, and the redactor removes it', async () => {
  const redactor = new Redactor();
  const { result, lines } = await captureLogs(async () => {
    const env = { FORGE_KEY_OPENAI_API_KEY: PLANTED, FORGE_KEYS_FROM_VAULT: '1' };
    const store = new GatewayKeyStore({ env, redactor });
    const out = [];
    out.push(await store.status('OPENAI_API_KEY'));
    out.push(store.info());
    out.push(store.keyProvider().describe());
    out.push(store.reload());
    out.push(await store.fingerprint('OPENAI_API_KEY'));
    await store.keyProvider().getKey('OPENAI_API_KEY');
    return out;
  });
  const text = JSON.stringify(result) + '\n' + lines.join('\n');
  assert.ok(!text.includes(PLANTED), 'planted key leaked');
  assert.equal(lines.length, 0, 'the key store writes no log line at all');
  assert.equal(redactor.redact('error: ' + PLANTED + ' rejected'), 'error: [REDACTED:OPENAI_API_KEY] rejected');
});

// Escalation round of WP B2 part 2: the full-suite verify failed in other lanes' files
// (exec-ask-token-env, ask-mcp, permissions-*) and the verifier could not rule out that this scrub had
// removed one of THEIR variables (CC_ASK_EXEC_TOKEN and friends) from the gateway env. It had not — the
// failing tests do not even import this module — but nothing proved that. This test does: the scrub
// removes exactly the FORGE_KEY_* names and nothing else, byte for byte.
test('ISOLATION GUARD: the scrub removes exactly the FORGE_KEY_* names; every other variable survives byte for byte', () => {
  const others = {
    CC_ASK_EXEC_TOKEN: 'tok-exec-planted-0123456789abcdef',
    CC_ASK_AGENT_TOKEN: 'tok-agent-planted-0123456789abcdef',
    NVIDIA_API_KEY: 'nvapi-PLANTED-plain-env-0123456789abcdef',
    OPENAI_API_KEY: PLANTED_ENV,
    FORGE_KEYS_FROM_VAULT: '1',
    FORGE_KEYSTORE_UNRELATED: 'kept: FORGE_KEYS... is not the FORGE_KEY_ prefix',
    FORGE_CORE_DIR: 'C:\somewhere',
    PATH: 'x',
    Path: 'y',
  };
  const env = { ...others, FORGE_KEY_OPENAI_API_KEY: PLANTED, forge_key_xai_api_key: '  ', 'FORGE_KEY_9bad-name': PLANTED };
  const store = new GatewayKeyStore({ env, redactor: new Redactor() });
  assert.deepEqual(env, others, 'only the FORGE_KEY_* names are gone; nothing else changed');
  assert.deepEqual(Object.keys(env).filter((k) => /^forge_key_/i.test(k)), [], 'no FORGE_KEY_* name is left behind');
  assert.equal(store.vault.size, 1, 'the one valid vault key was captured');
});
