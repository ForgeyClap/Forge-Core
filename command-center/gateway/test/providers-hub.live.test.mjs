// WP B2 part 2 LIVE test (skipped unless FORGE_LIVE=1): the provider hub against what really exists on
// the owner's PC. Ollama must be running on 127.0.0.1:11434 with at least one model; claude is probed only
// through the CLI itself (claude --version / --help / auth status --json), never through a credential file.
// No key is used (empty key store): every API-key provider must stay "geen sleutel" without a network call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHub } from '../src/providers/provider-hub.mjs';
import { GatewayKeyStore } from '../src/providers/key-provider.mjs';
import { Redactor } from '../src/providers/redact-guard.mjs';

const LIVE = process.env.FORGE_LIVE === '1';
const skip = LIVE ? false : 'live test: set FORGE_LIVE=1 (needs Ollama running and the claude CLI)';

test('live hub: Ollama test-connection, claude status via the CLI, API-key providers untouched', { skip }, async () => {
  const hub = createProviderHub({ keyStore: new GatewayKeyStore({ env: {}, redactor: new Redactor() }), probeCliAndLocal: true });
  const ollama = await hub.testProvider('ollama-local');
  assert.equal(ollama.result.ok, true, JSON.stringify(ollama.result));
  assert.equal(ollama.result.status, 'verbonden');
  assert.ok(ollama.result.models_count >= 1);
  const claude = await hub.providerRow('claude-code-cli', { fresh: true });
  assert.ok(['verbonden', 'niet verbonden', 'niet geinstalleerd', 'fout'].includes(claude.status));
  assert.equal(claude.live, true);
  const list = await hub.listProviders();
  for (const p of list.providers.filter((r) => r.kind === 'api-key')) assert.equal(p.status, 'geen sleutel', p.id);
  const block = await hub.modelsBlock();
  assert.ok(block.list.find((p) => p.id === 'ollama-local').models.length >= 1);
  // Recorded (redacted) for the work-package evidence.
  console.log('LIVE ollama-local test:', JSON.stringify(ollama.result));
  console.log('LIVE claude-code-cli row:', JSON.stringify({ status: claude.status, state: claude.state, version: claude.version, detail: claude.detail }));
});
