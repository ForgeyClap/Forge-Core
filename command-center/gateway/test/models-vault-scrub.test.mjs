// WP B2 part 2 regression: the desktop vault hands API keys to the gateway as FORGE_KEY_<NAME> env
// variables (contract-keys.md section 3). Many gateway helpers spawn children that inherit the WHOLE
// process.env (forge tools, the Discord bot). Before this WP nothing removed FORGE_KEY_* from the
// gateway's own environment, so every such child got every API key. Loading models.mjs (which
// server.mjs imports before it listens) must capture the vault keys into memory and delete them from
// process.env, so a child spawned afterwards with the default inherited env sees none of them.
// Shown RED on the pre-B2 models.mjs (log: _scratch/b2/gw/red-vault-scrub.log), GREEN after.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLANTED = 'sk-forge-scrub-PLANTED-0123456789abcdef';
const PLANTED_NV = 'nvapi-forge-scrub-PLANTED-VAULTNV';
let models;
let saved;

before(async () => {
  saved = { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY, NVIDIA_SKIP_ENV_FILES: process.env.NVIDIA_SKIP_ENV_FILES };
  process.env.FORGE_KEY_OPENAI_API_KEY = PLANTED;
  process.env.FORGE_KEY_NVIDIA_API_KEY = PLANTED_NV;
  process.env.FORGE_KEYS_FROM_VAULT = '1';
  process.env.NVIDIA_API_KEY = 'nvapi-ambient-should-lose-0000';
  process.env.NVIDIA_SKIP_ENV_FILES = '1';
  models = await import('../src/models.mjs');
});

after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.FORGE_KEYS_FROM_VAULT;
});

test('loading models.mjs removes FORGE_KEY_* from process.env, so an inheriting child never sees a vault key', async () => {
  assert.equal(process.env.FORGE_KEY_OPENAI_API_KEY, undefined, 'the vault key is still in the gateway env');
  assert.equal(process.env.FORGE_KEY_NVIDIA_API_KEY, undefined);
  // A real child with the default (inherited) environment, the way config-write/proof/discord spawn.
  const seen = execFileSync(process.execPath, ['-e', "process.stdout.write(Object.keys(process.env).filter((k) => /^FORGE_KEY_/i.test(k)).join(','))"], { encoding: 'utf8' });
  assert.equal(seen, '', 'a child inherited ' + seen);
  // The marker is not a key and stays (the vault reports it as from_app).
  assert.equal(process.env.FORGE_KEYS_FROM_VAULT, '1');
  assert.deepEqual(models.getGatewayKeyStore().info(), { from_app: true, captured: 2, source_order: ['vault', 'env'] });
});

test('the NVIDIA probe child gets the VAULT key (vault wins over the plain env) and no FORGE_KEY_* variable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-models-vaultnv-'));
  try {
    const fixture = path.join(dir, 'fake-nvidia-provider.cjs');
    // Reports yes/no only, never a value.
    writeFileSync(fixture, [
      "const k = process.env.NVIDIA_API_KEY || '';",
      "const fk = Object.keys(process.env).filter((n) => /^FORGE_KEY_/i.test(n)).length;",
      "console.log('NVIDIA FAIL — vault=' + (k.endsWith('VAULTNV') ? 1 : 0) + ' forgekeys=' + fk);",
    ].join('\n'), 'utf8');
    models._setNvidiaProviderCjsForTests(fixture);
    models._resetNvidiaHealthCacheForTests();
    const view = await models.buildModelsView();
    assert.equal(view.nvidia.state, 'DISCONNECTED');
    assert.match(view.nvidia.note, /vault=1 forgekeys=0/);
  } finally {
    models._setNvidiaProviderCjsForTests(null);
    models._resetNvidiaHealthCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
