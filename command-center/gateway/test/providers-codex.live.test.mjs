// LIVE: the real installed `codex` binary. Skipped unless FORGE_LIVE=1.
// 1. Detection: `codex --version` and `codex login status` (the CLI reports its own state).
// 2. Real app-server handshake with an EMPTY, temporary CODEX_HOME: no credential exists there, so the
//    server cannot act for anyone. Proves initialize -> initialized and account/read against the real
//    wire format, and the "not connected" path end to end. No thread or turn is ever started, so no
//    model request is sent. A real turn with the user's own sign-in stays owner-gated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProvider, loadRegistry } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';
import { detectCodex } from '../src/providers/cli/cli-codex.mjs';
import { probeEnv, resolveCli } from '../src/providers/cli/cli-resolve.mjs';
import { CodexAppServerClient } from '../src/providers/cli/codex-app-server.mjs';

const SKIP = process.env.FORGE_LIVE === '1' ? false : 'live test: set FORGE_LIVE=1 (needs codex on PATH)';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-home-'));
}

function removeHome(dir) {
  // codex writes sqlite files there; Windows may hold them for a moment after exit
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

test('live codex: detection through the CLI only', { skip: SKIP, timeout: 60_000 }, async () => {
  const d = await detectCodex();
  console.log('[live] codex detect', JSON.stringify({ ...d, path: d.path ? '<resolved>' : null }));
  if (!d.installed) { assert.equal(d.state, 'not-installed'); return; }
  assert.match(d.version || '', /^\d+\.\d+\.\d+/);
  assert.ok(['signed-in', 'not-connected', 'unknown-auth'].includes(d.state));
});

test('live codex: real app-server handshake with an empty CODEX_HOME reports not signed in', { skip: SKIP, timeout: 90_000 }, async (t) => {
  const r = await resolveCli('codex');
  if (!r) { t.skip('codex not installed'); return; }
  const home = tempHome();
  const client = new CodexAppServerClient({ command: r.command, prefixArgs: r.prefixArgs, env: { ...probeEnv(), CODEX_HOME: home }, requestTimeoutMs: 30_000 });
  try {
    const init = await client.start();
    console.log('[live] codex initialize', JSON.stringify({ platformOs: init.platformOs, userAgent: String(init.userAgent).slice(0, 60) }));
    assert.match(String(init.userAgent), /^forge-systeem\//, 'the server sees the truthful client name');
    const acc = await client.readAccount();
    console.log('[live] codex account/read (empty home)', JSON.stringify(acc));
    assert.equal(acc.loggedIn, false);
    assert.equal(acc.requiresOpenaiAuth, true);
  } finally {
    await client.close();
    console.log('[live] codex app-server exit', JSON.stringify({ exitCode: client.child && client.child.exitCode, signal: client.child && client.child.signalCode }));
    removeHome(home);
  }
});

test('live codex: provider chat with an empty CODEX_HOME stops at NOT_CONNECTED before any turn; without options.cwd it is refused before any spawn', { skip: SKIP, timeout: 90_000 }, async (t) => {
  if (!(await resolveCli('codex'))) { t.skip('codex not installed'); return; }
  const home = tempHome();
  const work = tempHome(); // the folder the (never started) thread would work in: an empty temp dir, never this repo
  try {
    const p = createProvider('codex-cli', { keyProvider: new MemoryKeyProvider(), registry: loadRegistry(), env: { ...process.env, CODEX_HOME: home } });
    const noCwd = [];
    for await (const ev of p.chat({ messages: [{ role: 'user', content: 'hello' }] })) noCwd.push(ev);
    assert.deepEqual([noCwd.length, noCwd[0].code], [1, 'CONFIG'], 'no cwd -> CONFIG, no app-server started');
    const evs = [];
    for await (const ev of p.chat({ messages: [{ role: 'user', content: 'hello' }], options: { cwd: work } })) evs.push(ev);
    console.log('[live] codex chat (empty home)', JSON.stringify(evs));
    assert.equal(evs.length, 1);
    assert.equal(evs[0].code, 'NOT_CONNECTED');
  } finally {
    removeHome(home);
    removeHome(work);
  }
});
