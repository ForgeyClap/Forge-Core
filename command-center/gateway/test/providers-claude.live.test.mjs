// LIVE: detection of the real installed `claude` binary. Skipped unless FORGE_LIVE=1.
// Runs only `claude --version`, `claude --help` and `claude auth status --json` (no chat, no tokens
// read: the CLI reports its own sign-in state, and only non-personal fields are kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, loadRegistry } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';
import { detectClaude } from '../src/providers/cli/cli-claude.mjs';

const SKIP = process.env.FORGE_LIVE === '1' ? false : 'live test: set FORGE_LIVE=1 (needs claude on PATH)';

test('live claude: installed, version, stream capabilities and sign-in state through the CLI only', { skip: SKIP, timeout: 90_000 }, async () => {
  const d = await detectClaude();
  console.log('[live] claude detect', JSON.stringify({ ...d, path: d.path ? '<resolved>' : null }));
  assert.equal(d.installed, true);
  assert.match(d.version, /^\d+\.\d+\.\d+/);
  assert.equal(d.streamReady, true, 'stream-json flags present');
  assert.ok(['connected', 'not-connected', 'unknown-auth'].includes(d.state));
  const blob = JSON.stringify(d);
  assert.equal(/@|orgId|orgName|email/i.test(blob.replace(/"path":"[^"]*"/, '')), false, 'no personal fields kept');
});

test('live claude: provider testConnection mirrors detection; chat stays a handoff', { skip: SKIP, timeout: 90_000 }, async () => {
  const p = createProvider('claude-code-cli', { keyProvider: new MemoryKeyProvider(), registry: loadRegistry() });
  const t = await p.testConnection();
  console.log('[live] claude testConnection', JSON.stringify({ ok: t.ok, state: t.state, version: t.version, latencyMs: t.latencyMs }));
  assert.ok(t.version);
  const evs = [];
  for await (const ev of p.chat({ messages: [{ role: 'user', content: 'hi' }] })) evs.push(ev);
  assert.equal(evs[0].code, 'NOT_IMPLEMENTED');
});
