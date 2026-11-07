// WP B2 part 1: CLI adapters. claude/codex detection with injected runners (no real CLI), CLI
// resolution incl. the Windows npm shim, the probe environment, and the codex app-server client
// against test/fixtures/mock-codex-app-server.mjs (a real child process speaking the 0.156.1 wire format).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, createProvider } from '../src/providers/index.mjs';
import { MemoryKeyProvider } from '../src/providers/key-provider.mjs';
import { resolveCli, resolveNpmShim, probeEnv, runCli } from '../src/providers/cli/cli-resolve.mjs';
import { detectClaude, parseClaudeAuthStatus, parseClaudeHelp, parseClaudeVersion } from '../src/providers/cli/cli-claude.mjs';
import { detectCodex, parseCodexLoginStatus, parseCodexVersion } from '../src/providers/cli/cli-codex.mjs';
import { CodexAppServerClient } from '../src/providers/cli/codex-app-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mock-codex-app-server.mjs');
const reg = loadRegistry();
const NODE = { command: process.execPath, prefixArgs: [FIXTURE], path: FIXTURE, via: 'test' };

async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function mockClient(mode, extra = {}) {
  return new CodexAppServerClient({ command: process.execPath, prefixArgs: [FIXTURE], args: [], env: { ...probeEnv(), MOCK_CODEX_MODE: mode, ...extra }, requestTimeoutMs: 10_000 });
}

test('version / help / auth-status parsers keep only allow-listed, non-personal fields', () => {
  assert.equal(parseClaudeVersion('2.1.316 (Claude Code)'), '2.1.316');
  const caps = parseClaudeHelp('Usage: claude\n  --output-format <f>\n  --include-partial-messages\n  -r, --resume\nCommands:\n  auth  Manage authentication');
  assert.deepEqual([caps.outputFormat, caps.includePartialMessages, caps.resume, caps.forkSession, caps.authStatusCommand], [true, true, true, false, true]);
  const auth = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.invalid', orgId: 'org-1', orgName: 'Acme', subscriptionType: 'max' }));
  assert.deepEqual(auth, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' });
  assert.equal(parseClaudeAuthStatus('not json'), null);
  assert.equal(parseCodexVersion('codex-cli 0.156.1'), '0.156.1');
  assert.deepEqual(parseCodexLoginStatus(0, 'Logged in using ChatGPT\n', ''), { loggedIn: true, method: 'chatgpt' });
  assert.deepEqual(parseCodexLoginStatus(1, '', 'Not logged in\n'), { loggedIn: false, method: null });
  assert.equal(parseCodexLoginStatus(0, 'something else', ''), null);
});

function fakeRun(table) {
  return async (resolved, args) => {
    const key = args.join(' ');
    const hit = table[key];
    if (!hit) return { code: 2, stdout: '', stderr: 'unknown ' + key, timedOut: false };
    return { timedOut: false, stderr: '', ...hit };
  };
}

test('detectClaude: installed + signed in, not signed in, and not installed', async () => {
  const resolver = async () => ({ path: 'C:/fake/claude.exe', command: 'C:/fake/claude.exe', prefixArgs: [], via: 'exe' });
  const help = { code: 0, stdout: '--output-format --include-partial-messages --input-format --resume --fork-session --permission-prompt-tool\nCommands:\n  auth' };
  const signedIn = await detectClaude({ resolver, run: fakeRun({ '--version': { code: 0, stdout: '2.1.316 (Claude Code)\n' }, '--help': help, 'auth status --json': { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'x@example.invalid' }) } }) });
  assert.equal(signedIn.state, 'connected');
  assert.equal(signedIn.version, '2.1.316');
  assert.equal(signedIn.streamReady, true);
  assert.equal(JSON.stringify(signedIn).includes('example.invalid'), false, 'email is never kept');
  const out = await detectClaude({ resolver, run: fakeRun({ '--version': { code: 0, stdout: '2.1.316' }, '--help': help, 'auth status --json': { code: 1, stdout: JSON.stringify({ loggedIn: false }) } }) });
  assert.equal(out.state, 'not-connected');
  assert.match(out.detail, /sign in yourself/);
  const none = await detectClaude({ resolver: async () => null });
  assert.equal(none.state, 'not-installed');
});

test('detectCodex: stored sign-in, not signed in, and a failing --version', async () => {
  const resolver = async () => ({ path: 'C:/fake/codex.cmd', command: 'node', prefixArgs: ['codex.js'], via: 'npm-shim' });
  const signed = await detectCodex({ resolver, run: fakeRun({ '--version': { code: 0, stdout: 'codex-cli 0.156.1' }, 'login status': { code: 0, stdout: 'Logged in using ChatGPT' } }) });
  assert.deepEqual([signed.state, signed.version, signed.login.method], ['signed-in', '0.156.1', 'chatgpt']);
  const out = await detectCodex({ resolver, run: fakeRun({ '--version': { code: 0, stdout: 'codex-cli 0.156.1' }, 'login status': { code: 1, stderr: 'Not logged in' } }) });
  assert.equal(out.state, 'not-connected');
  assert.match(out.detail, /codex login/);
  const broken = await detectCodex({ resolver, run: fakeRun({ '--version': { code: 1, stderr: 'boom' } }) });
  assert.equal(broken.state, 'error');
});

test('resolveCli: Windows npm shim resolves to node + the JS entry; extensionless and cwd candidates are skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-providers-shim-'));
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-providers-cwd-'));
  try {
    const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// fake entry\n');
    const shim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n');
    assert.equal(fs.realpathSync(resolveNpmShim(shim)), fs.realpathSync(entry));
    const r = await resolveCli('codex', { platform: 'win32', env: {}, cwd: otherCwd, lookup: async () => [path.join(dir, 'codex'), shim] });
    assert.equal(r.via, 'npm-shim');
    assert.equal(fs.realpathSync(r.prefixArgs[0]), fs.realpathSync(entry));
    assert.equal(r.command, process.execPath, 'no node.exe next to the shim: the gateway node runs the entry');
    const underCwd = await resolveCli('codex', { platform: 'win32', env: {}, cwd: dir, lookup: async () => [shim] });
    assert.equal(underCwd, null, 'a candidate under the current directory is never trusted');
    const viaOverride = await resolveCli('codex', { platform: 'win32', env: { FORGE_CODEX_CLI_PATH: shim }, cwd: otherCwd, lookup: async () => [] });
    assert.equal(viaOverride.via, 'npm-shim');
    assert.equal(await resolveCli('bad name', { lookup: async () => [shim] }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherCwd, { recursive: true, force: true });
  }
});

test('probeEnv passes no API key or token to a CLI child (proven in a real child process)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-providers-env-'));
  try {
    const script = path.join(dir, 'print-env.mjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(Object.keys(process.env).map((k) => k.toUpperCase())))');
    const env = probeEnv({ ...process.env, ANTHROPIC_API_KEY: 'a'.repeat(20), ANTHROPIC_AUTH_TOKEN: 'b'.repeat(20), OPENAI_API_KEY: 'c'.repeat(20), CLAUDE_CODE_OAUTH_TOKEN: 'd'.repeat(20), CODEX_HOME: dir });
    const r = await runCli({ command: process.execPath, prefixArgs: [script] }, [], { env });
    assert.equal(r.code, 0);
    const keys = JSON.parse(r.stdout);
    for (const banned of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(keys.includes(banned), false, banned + ' reached the child');
    assert.ok(keys.includes('CODEX_HOME'));
    assert.ok(keys.includes('PATH'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude provider: chat is a documented handoff to the exec pipeline, never a spawn', async () => {
  const p = createProvider('claude-code-cli', { keyProvider: new MemoryKeyProvider(), registry: reg, detect: async () => ({ state: 'connected', detail: 'ok', version: '2.1.316', streamReady: true, capabilities: {} }) });
  const evs = await collect(p.chat({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(evs[0].code, 'NOT_IMPLEMENTED');
  assert.match(evs[0].message, /exec pipeline/);
  const h = p.handoff();
  assert.ok(h.baseArgs.includes('stream-json'));
  assert.deepEqual(h.forbiddenArgs, ['--bare']);
  assert.equal((await p.testConnection()).ok, true);
  assert.deepEqual((await p.listModels()).models.map((m) => m.id), ['sonnet', 'opus', 'fable', 'haiku']);
});

test('codex app-server client: initialize -> initialized, account/read, thread/start, streamed turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-providers-codex-'));
  const log = path.join(dir, 'requests.jsonl');
  const client = mockClient('logged-in', { MOCK_CODEX_LOG: log });
  try {
    const init = await client.start();
    assert.equal(init.platformOs, 'windows');
    assert.match(init.userAgent, /forge-systeem/, 'clientInfo.name is the truthful forge-systeem');
    const acc = await client.readAccount();
    assert.deepEqual(acc, { loggedIn: true, accountType: 'chatgpt', planType: 'plus', requiresOpenaiAuth: true });
    const { threadId } = await client.startThread({ cwd: dir });
    const evs = await collect(client.runTurn({ threadId, text: 'say hello' }));
    assert.deepEqual(evs.map((e) => e.type), ['text', 'text', 'usage', 'done']);
    assert.equal(evs[0].text + evs[1].text, 'Hello from mock', 'the other-thread delta was ignored');
    assert.equal(evs[2].totalTokens, 17);
    const sent = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(sent.map((m) => m.method), ['initialize', 'initialized', 'account/read', 'thread/start', 'turn/start']);
    assert.equal(sent.some((m) => 'jsonrpc' in m), false, 'wire format has no jsonrpc field');
    assert.deepEqual(sent[2].params, { refreshToken: false });
    assert.deepEqual(sent[4].params.input, [{ type: 'text', text: 'say hello' }]);
    assert.equal(sent.some((m) => m.method === 'account/login/start'), false, 'Forge never starts a login');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex approvals are surfaced as events and nothing is auto-approved', async () => {
  for (const [choice, expected] of [['accept', 'decision=accept'], ['decline', 'decision=decline']]) {
    const client = mockClient('approval');
    try {
      await client.start();
      const { threadId } = await client.startThread();
      let text = '';
      let approvals = 0;
      let second = null;
      for await (const ev of client.runTurn({ threadId, text: 'run tests', idleTimeoutMs: 200 })) {
        if (ev.type === 'approval') {
          approvals += 1;
          assert.equal(ev.method, 'item/commandExecution/requestApproval');
          assert.equal(ev.command, 'npm test');
          // Answer LATER while the loop keeps waiting for events: 400 ms is longer than idleTimeoutMs,
          // so the turn only survives if a pending approval really pauses the idle timer.
          setTimeout(() => {
            ev[choice]();
            try { ev.decline(); second = 'accepted twice'; } catch (err) { second = err.message; }
          }, 400);
        }
        if (ev.type === 'text') text += ev.text;
      }
      assert.equal(approvals, 1);
      assert.equal(text, expected);
      assert.match(second, /already answered/);
    } finally { await client.close(); }
  }
});

test('codex: a token-refresh request from the server is refused; a failed turn and a crash become errors', async () => {
  const tok = mockClient('token-refresh');
  try {
    await tok.start();
    const { threadId } = await tok.startThread();
    const evs = await collect(tok.runTurn({ threadId, text: 'x' }));
    assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'refresh refused');
  } finally { await tok.close(); }

  const failed = mockClient('turn-failed');
  try {
    await failed.start();
    const { threadId } = await failed.startThread();
    await assert.rejects(() => collect(failed.runTurn({ threadId, text: 'x' })), /mock model refused/);
  } finally { await failed.close(); }

  const crash = mockClient('crash');
  try {
    await crash.start();
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(() => crash.readAccount(), (e) => e.code === 'PROTOCOL');
    assert.equal(crash.stderrText().includes('mockmockmock'), false, 'stderr is redacted');
    assert.match(crash.stderrText(), /REDACTED/);
  } finally { await crash.close(); }
});

test('the mock app-server fixture exits at once when not started by a test (a plain `node --test` must not hang on it)', { timeout: 15_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const env = { ...process.env };
  delete env.MOCK_CODEX_MODE;
  const child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true }); // stdin stays open, like under the runner
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill(); resolve('hung'); }, 5000);
    child.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 0, 'fixture without MOCK_CODEX_MODE must exit 0 immediately');
});

test('codex provider: signed-in chat streams events; not signed in gives one NOT_CONNECTED error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-providers-codex-prov-'));
  try {
    const make = (mode) => createProvider('codex-cli', {
      keyProvider: new MemoryKeyProvider(), registry: reg,
      resolve: async () => NODE, childEnv: (e) => ({ ...probeEnv(e), MOCK_CODEX_MODE: mode }),
    });
    const ok = await collect(make('logged-in').chat({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hello' }], options: { cwd: dir } }));
    assert.deepEqual(ok.map((e) => e.type), ['text', 'text', 'usage', 'done']);
    const out = await collect(make('logged-out').chat({ messages: [{ role: 'user', content: 'hello' }], options: { cwd: dir } }));
    assert.equal(out.length, 1);
    assert.equal(out[0].code, 'NOT_CONNECTED');
    assert.match(out[0].message, /codex login/);
    const missing = await collect(createProvider('codex-cli', { keyProvider: new MemoryKeyProvider(), registry: reg, resolve: async () => null })
      .chat({ messages: [{ role: 'user', content: 'x' }], options: { cwd: dir } }));
    assert.equal(missing[0].code, 'NOT_INSTALLED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex provider: a chat without an absolute options.cwd is refused before any spawn; thread/start always carries cwd and an explicit sandbox (read-only by default, workspace-write only on request, danger-full-access never)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-providers-codex-sandbox-'));
  const log = path.join(dir, 'requests.jsonl');
  let spawns = 0;
  const make = () => createProvider('codex-cli', {
    keyProvider: new MemoryKeyProvider(), registry: reg,
    resolve: async () => { spawns += 1; return NODE; },
    childEnv: (e) => ({ ...probeEnv(e), MOCK_CODEX_MODE: 'logged-in', MOCK_CODEX_LOG: log }),
  });
  const sent = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  try {
    for (const options of [undefined, {}, { cwd: '' }, { cwd: 'relative/folder' }, { cwd: 42 }]) {
      const evs = await collect(make().chat({ messages: [{ role: 'user', content: 'hi' }], options }));
      assert.equal(evs.length, 1, JSON.stringify(options));
      assert.equal(evs[0].code, 'CONFIG');
      assert.match(evs[0].message, /options\.cwd/);
    }
    assert.equal(spawns, 0, 'no app-server was resolved or started for a chat without cwd');
    assert.equal(fs.existsSync(log), false);

    const bad = await collect(make().chat({ messages: [{ role: 'user', content: 'hi' }], options: { cwd: dir, sandbox: 'danger-full-access' } }));
    assert.deepEqual([bad.length, bad[0].code], [1, 'CONFIG']);
    assert.match(bad[0].message, /danger-full-access is never used/);
    assert.equal(spawns, 0);

    const ro = await collect(make().chat({ messages: [{ role: 'user', content: 'hi' }], options: { cwd: dir } }));
    assert.deepEqual(ro.map((e) => e.type), ['text', 'text', 'usage', 'done']);
    let msgs = sent();
    const threadStart = msgs.find((m) => m.method === 'thread/start');
    assert.equal(threadStart.params.cwd, dir, 'thread/start carries the caller cwd');
    assert.equal(threadStart.params.sandbox, 'read-only', 'default sandbox is explicit read-only (never inherited from ~/.codex)');
    assert.equal(threadStart.params.approvalPolicy, 'on-request');
    assert.deepEqual(msgs.find((m) => m.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly' });

    fs.writeFileSync(log, '');
    const rw = await collect(make().chat({ messages: [{ role: 'user', content: 'hi' }], options: { cwd: dir, sandbox: 'workspace-write' } }));
    assert.deepEqual(rw.map((e) => e.type), ['text', 'text', 'usage', 'done']);
    msgs = sent();
    assert.equal(msgs.find((m) => m.method === 'thread/start').params.sandbox, 'workspace-write');
    assert.deepEqual(msgs.find((m) => m.method === 'turn/start').params.sandboxPolicy, { type: 'workspaceWrite' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex app-server client: the mock (pinned to the 0.156.1 SandboxMode enum) rejects a thread/start without a valid sandbox; the client refuses danger-full-access itself', async () => {
  const client = mockClient('logged-in');
  try {
    await client.start();
    await assert.rejects(() => client.request('thread/start', { approvalPolicy: 'on-request', ephemeral: true }), /sandbox must be one of read-only\|workspace-write\|danger-full-access/);
    await assert.rejects(() => client.request('thread/start', { sandbox: 'readOnly' }), /sandbox must be one of/, 'the kebab-case enum is required, not the SandboxPolicy type spelling');
    await assert.rejects(() => client.startThread({ sandbox: 'danger-full-access' }), (e) => e.code === 'CONFIG');
    await assert.rejects(() => collect(client.runTurn({ threadId: 'thr_mock_1', text: 'x', sandbox: 'danger-full-access' })), (e) => e.code === 'CONFIG');
    const { threadId, sandbox } = await client.startThread();
    assert.deepEqual([threadId, sandbox], ['thr_mock_1', 'read-only']);
  } finally { await client.close(); }
});
