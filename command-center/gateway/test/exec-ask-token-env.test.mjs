// WP A8 item 3: no token sits in the per-turn ask-mcp config file; it travels in the
// spawned `claude` child's environment instead (exec-cli.mjs execSpawnEnv +
// stripExecTokenFromAskMcpConfig, wired in exec-lifecycle.mjs startExecution). Since WP
// B3-sec-impl that token is the conversation's AGENT token (CC_ASK_AGENT_TOKEN), never the
// dashboard's exec token.
//
// Layers proven here, each against the REAL function (no claude CLI is ever invoked):
//   1. execSpawnEnv: the agent token is present exactly when a turn carries a readable ask-mcp
//      config, it is bound to that config's conversation, the base is the filteredEnv allowlist, and
//      a stale CC_ASK_EXEC_TOKEN / CC_ASK_AGENT_TOKEN in the gateway's own env is dropped.
//   2. stripExecTokenFromAskMcpConfig: on a fixture carrying the token (deterministic RED/GREEN,
//      independent of what exec-argv.mjs's builder writes today), on the file buildSpawnSpec really
//      writes, and on unreadable / malformed input (fail-closed, never throws).
//   3. startExecution end to end on the REAL (non-mock) branch with Node's own binary standing in
//      for `claude`: the config file on disk is token-free the moment startExecution returns, and
//      is removed again when the child closes.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  filteredEnv,
  execSpawnEnv,
  stripExecTokenFromAskMcpConfig,
  ASK_EXEC_TOKEN_ENV,
  ASK_AGENT_TOKEN_ENV,
} from '../src/exec-cli.mjs';
import { buildSpawnSpec, _setAskMcpConfigDirForTests } from '../src/exec-argv.mjs';
import { getExecToken, execTokenOk, issueAgentToken, agentTokenConversation, EXEC_TOKEN_HEADER } from '../src/security.mjs';
import { createConversation, readConversation, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { startExecution, _resetExecBridgeForTests } from '../src/exec-bridge.mjs';

let configDir;
let convDir;
let savedMock;
let savedCliPath;
let savedStaleToken;

before(() => {
  savedMock = process.env.CC_EXEC_MOCK;
  savedCliPath = process.env.CC_CLAUDE_CLI_PATH;
  savedStaleToken = process.env[ASK_EXEC_TOKEN_ENV];
  delete process.env.CC_EXEC_MOCK; // the REAL (non-mock) branch is the one that writes a config file
  // Node's own binary is an absolute, existing path outside this cwd, so resolveClaudeCliPath()'s
  // cwd-shadow guard accepts it; handed the claude argv it exits at once with a usage error, which is
  // all the end-to-end test needs (a real spawn, a real close, no real claude run).
  process.env.CC_CLAUDE_CLI_PATH = process.execPath;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ask-token-env-cfg-'));
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ask-token-env-conv-'));
  _setAskMcpConfigDirForTests(configDir);
  _setConversationsDirForTests(convDir);
});

after(() => {
  if (savedMock !== undefined) process.env.CC_EXEC_MOCK = savedMock; else delete process.env.CC_EXEC_MOCK;
  if (savedCliPath !== undefined) process.env.CC_CLAUDE_CLI_PATH = savedCliPath; else delete process.env.CC_CLAUDE_CLI_PATH;
  if (savedStaleToken !== undefined) process.env[ASK_EXEC_TOKEN_ENV] = savedStaleToken; else delete process.env[ASK_EXEC_TOKEN_ENV];
  _setAskMcpConfigDirForTests(null);
  _resetConversationsForTests();
  fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(convDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _resetExecBridgeForTests();
  for (const f of fs.readdirSync(configDir)) fs.rmSync(path.join(configDir, f));
});

function configFixtureWithToken() {
  return {
    mcpServers: {
      'forge-ask': {
        command: process.execPath,
        args: ['ask-mcp.mjs'],
        env: {
          CC_ASK_GATEWAY_ORIGIN: 'http://127.0.0.1:4100',
          CC_ASK_CONV_ID: 'c-1',
          CC_ASK_TURN_ID: 't-1',
          CC_ASK_REQUEST_ID: 'req-1',
          [ASK_EXEC_TOKEN_ENV]: getExecToken(),
        },
      },
    },
  };
}

// ── 1. execSpawnEnv ──────────────────────────────────────────────────────────────────────────────
// WP B3-sec-impl (Security Boss Step 1a): the child gets its conversation's AGENT token in
// CC_ASK_AGENT_TOKEN, never the dashboard's exec token.

/** A token-free per-turn config naming `convId`, written to the test config dir. */
function writeConfigFor(convId, name = 'cfg-' + convId + '.json') {
  const file = path.join(configDir, name);
  const cfg = configFixtureWithToken();
  delete cfg.mcpServers['forge-ask'].env[ASK_EXEC_TOKEN_ENV];
  cfg.mcpServers['forge-ask'].env.CC_ASK_CONV_ID = convId;
  fs.writeFileSync(file, JSON.stringify(cfg), 'utf8');
  return file;
}

test('execSpawnEnv: a turn WITH an ask-mcp config gets exactly its conversation\'s agent token on top of the filteredEnv allowlist', () => {
  const env = execSpawnEnv({ askMcpConfigPath: writeConfigFor('c-env-1') });
  assert.equal(env[ASK_AGENT_TOKEN_ENV], issueAgentToken('c-env-1'));
  assert.equal(ASK_EXEC_TOKEN_ENV in env, false, 'the dashboard token is never in the child environment');
  const rest = { ...env };
  delete rest[ASK_AGENT_TOKEN_ENV];
  const base = filteredEnv();
  delete base[ASK_EXEC_TOKEN_ENV];
  delete base[ASK_AGENT_TOKEN_ENV];
  assert.deepEqual(rest, base, 'nothing but the agent token may be added to the allowlisted environment');
});

test('REGRESSION (Step 1a): the token a turn\'s child receives is not the dashboard token and only works as its own conversation\'s agent token', () => {
  const env = execSpawnEnv({ askMcpConfigPath: writeConfigFor('c-env-2') });
  const childToken = env[ASK_AGENT_TOKEN_ENV] || env[ASK_EXEC_TOKEN_ENV];
  assert.ok(childToken, 'a turn with an ask-mcp config carries a token');
  const req = { headers: { [EXEC_TOKEN_HEADER]: childToken } };
  assert.equal(execTokenOk(req), false, 'the child token must never pass the dashboard check');
  assert.equal(agentTokenConversation(req), 'c-env-2');
  assert.notEqual(childToken, issueAgentToken('c-env-3'), 'another conversation gets another token');
});

test('execSpawnEnv: a turn WITHOUT an ask-mcp config (mock mode, config-less) never carries a token', () => {
  for (const env of [execSpawnEnv({}), execSpawnEnv(), execSpawnEnv({ askMcpConfigPath: undefined })]) {
    assert.equal(ASK_EXEC_TOKEN_ENV in env, false);
    assert.equal(ASK_AGENT_TOKEN_ENV in env, false);
  }
});

test('execSpawnEnv: a config that cannot be read or names no valid conversation gets NO token (fail closed, never a wider one)', () => {
  const noConv = path.join(configDir, 'no-conv.json');
  fs.writeFileSync(noConv, JSON.stringify({ mcpServers: { 'forge-ask': { env: {} } } }), 'utf8');
  const badConv = writeConfigFor('../escape', 'bad-conv.json');
  for (const p of [path.join(configDir, 'missing.json'), noConv, badConv]) {
    const env = execSpawnEnv({ askMcpConfigPath: p });
    assert.equal(ASK_AGENT_TOKEN_ENV in env, false, p);
    assert.equal(ASK_EXEC_TOKEN_ENV in env, false, p);
  }
});

test('execSpawnEnv: stale CC_ASK_EXEC_TOKEN / CC_ASK_AGENT_TOKEN in the gateway\'s own environment are never forwarded, and non-allowlisted names stay out', () => {
  process.env[ASK_EXEC_TOKEN_ENV] = 'stale-token-from-a-previous-boot';
  process.env[ASK_AGENT_TOKEN_ENV] = 'stale-agent-token';
  process.env.CC_A8_TEST_MY_SECRET_DSN = 'x'; // cc_ prefix: allowlisted, must pass through unchanged
  process.env.A8_TEST_DB_PASSWORD = 'hunter2'; // not allowlisted: must never pass
  try {
    const without = execSpawnEnv({});
    assert.equal(ASK_EXEC_TOKEN_ENV in without, false, 'config-less turn must not inherit a stale token');
    assert.equal(ASK_AGENT_TOKEN_ENV in without, false, 'config-less turn must not inherit a stale agent token');
    const withCfg = execSpawnEnv({ askMcpConfigPath: writeConfigFor('c-env-4') });
    assert.equal(withCfg[ASK_AGENT_TOKEN_ENV], issueAgentToken('c-env-4'), 'the stale value must be replaced by the issued agent token');
    assert.equal(ASK_EXEC_TOKEN_ENV in withCfg, false);
    assert.equal(withCfg.CC_A8_TEST_MY_SECRET_DSN, 'x');
    assert.equal('A8_TEST_DB_PASSWORD' in withCfg, false);
  } finally {
    delete process.env[ASK_EXEC_TOKEN_ENV];
    delete process.env[ASK_AGENT_TOKEN_ENV];
    delete process.env.CC_A8_TEST_MY_SECRET_DSN;
    delete process.env.A8_TEST_DB_PASSWORD;
  }
});

// ── 2. stripExecTokenFromAskMcpConfig ───────────────────────────────────────────────────────────

test('strip: a config carrying the token is rewritten without it; every other ask env value survives byte for byte', () => {
  const file = path.join(configDir, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify(configFixtureWithToken()), 'utf8');
  assert.ok(fs.readFileSync(file, 'utf8').includes(getExecToken()), 'fixture precondition: the token is in the file');

  const result = stripExecTokenFromAskMcpConfig(file);
  assert.deepEqual(result, { ok: true, removed: 1 });

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(getExecToken()), false, 'the token string must be gone from the bytes on disk');
  const env = JSON.parse(raw).mcpServers['forge-ask'].env;
  assert.equal(ASK_EXEC_TOKEN_ENV in env, false);
  assert.deepEqual(env, {
    CC_ASK_GATEWAY_ORIGIN: 'http://127.0.0.1:4100',
    CC_ASK_CONV_ID: 'c-1',
    CC_ASK_TURN_ID: 't-1',
    CC_ASK_REQUEST_ID: 'req-1',
  });
});

test('strip: an already token-free config is left valid (removed: 0) — idempotent, so a builder that stops writing the token needs no change here', () => {
  const file = path.join(configDir, 'clean.json');
  const clean = configFixtureWithToken();
  delete clean.mcpServers['forge-ask'].env[ASK_EXEC_TOKEN_ENV];
  fs.writeFileSync(file, JSON.stringify(clean), 'utf8');
  assert.deepEqual(stripExecTokenFromAskMcpConfig(file), { ok: true, removed: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), clean);
});

test('strip: the file buildSpawnSpec REALLY writes is token-free afterwards and still carries this turn\'s ids', () => {
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined, { convId: 'c-real', turnId: 't-real', requestId: 'req-real' });
  assert.ok(spec.askMcpConfigPath && fs.existsSync(spec.askMcpConfigPath));
  const result = stripExecTokenFromAskMcpConfig(spec.askMcpConfigPath);
  assert.equal(result.ok, true);
  const raw = fs.readFileSync(spec.askMcpConfigPath, 'utf8');
  assert.equal(raw.includes(getExecToken()), false);
  const env = JSON.parse(raw).mcpServers['forge-ask'].env;
  assert.equal(env.CC_ASK_CONV_ID, 'c-real');
  assert.equal(env.CC_ASK_TURN_ID, 't-real');
  assert.equal(env.CC_ASK_REQUEST_ID, 'req-real');
  assert.match(env.CC_ASK_GATEWAY_ORIGIN, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('strip: an agent token variable (any letter case) is removed too, and an agent token anywhere in the bytes fails the proof', () => {
  const token = issueAgentToken('c-strip-1');
  const file = path.join(configDir, 'agent-token.json');
  const cfg = configFixtureWithToken();
  cfg.mcpServers['forge-ask'].env[ASK_AGENT_TOKEN_ENV] = token;
  cfg.mcpServers['forge-ask'].env.cc_ask_agent_token = token;
  fs.writeFileSync(file, JSON.stringify(cfg), 'utf8');
  assert.deepEqual(stripExecTokenFromAskMcpConfig(file), { ok: true, removed: 3 });
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes(getExecToken()), false);

  const inArgs = path.join(configDir, 'agent-token-in-args.json');
  const cfg2 = configFixtureWithToken();
  delete cfg2.mcpServers['forge-ask'].env[ASK_EXEC_TOKEN_ENV];
  cfg2.mcpServers['forge-ask'].args.push('--token=' + token);
  fs.writeFileSync(inArgs, JSON.stringify(cfg2), 'utf8');
  const result = stripExecTokenFromAskMcpConfig(inArgs);
  assert.equal(result.ok, false);
  assert.match(result.reason, /still present/);
});

test('strip: the byte proof catches a token that sits OUTSIDE env (e.g. in args) — ok:false, so such a file is never handed to a child', () => {
  const file = path.join(configDir, 'token-in-args.json');
  const cfg = configFixtureWithToken();
  delete cfg.mcpServers['forge-ask'].env[ASK_EXEC_TOKEN_ENV];
  cfg.mcpServers['forge-ask'].args.push('--token=' + getExecToken());
  fs.writeFileSync(file, JSON.stringify(cfg), 'utf8');
  const result = stripExecTokenFromAskMcpConfig(file);
  assert.equal(result.ok, false);
  assert.match(result.reason, /still present/);
});

test('strip: fail-closed on a missing file, malformed JSON, or a config without mcpServers — ok:false with a reason, never a throw', () => {
  assert.equal(stripExecTokenFromAskMcpConfig(path.join(configDir, 'does-not-exist.json')).ok, false);
  assert.equal(stripExecTokenFromAskMcpConfig('').ok, false);
  assert.equal(stripExecTokenFromAskMcpConfig(undefined).ok, false);

  const broken = path.join(configDir, 'broken.json');
  fs.writeFileSync(broken, '{ not json', 'utf8');
  const r1 = stripExecTokenFromAskMcpConfig(broken);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /unreadable/);

  const noServers = path.join(configDir, 'no-servers.json');
  fs.writeFileSync(noServers, JSON.stringify({ hello: 'world' }), 'utf8');
  const r2 = stripExecTokenFromAskMcpConfig(noServers);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /mcpServers/);
});

// ── 3. startExecution end to end (real branch, Node standing in for claude) ─────────────────────

// Wiring guard (source-level, deliberately narrow): the child's environment cannot be observed in a
// test without a controllable stand-in executable, so this pins the one spawn site to execSpawnEnv
// and forbids a silent fallback to the bare allowlist. Everything behavioural is in the tests around it.
test('WIRING GUARD: exec-lifecycle spawns the child with execSpawnEnv({ askMcpConfigPath }) and never with a bare filteredEnv()', () => {
  const src = fs.readFileSync(new URL('../src/exec-lifecycle.mjs', import.meta.url), 'utf8');
  assert.match(src, /env:\s*execSpawnEnv\(\{\s*askMcpConfigPath\s*\}\)/);
  assert.doesNotMatch(src, /filteredEnv\(/, 'the lifecycle must not build the child env itself');
});

test('END TO END: the ask-mcp config on disk is token-free the moment startExecution returns, and is removed when the child closes', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const started = startExecution({ convId: conv.id, turnId: 't-e2e', requestId: 'req-e2e', text: 'hello', cwd: os.tmpdir() });
  assert.equal(started.started, true, 'the real-branch spawn must have happened: ' + (started.reason || ''));

  // Synchronous read right after return: the child's 'close' cannot have fired yet (no event-loop
  // turn has passed), so this is the file exactly as it exists WHILE the turn runs.
  const files = fs.readdirSync(configDir);
  assert.equal(files.length, 1, 'exactly one per-turn config file must exist during the turn');
  const raw = fs.readFileSync(path.join(configDir, files[0]), 'utf8');
  assert.equal(raw.includes(getExecToken()), false, 'the exec token must not be on disk during the turn');
  assert.equal(raw.includes(issueAgentToken(conv.id)), false, 'the conversation\'s agent token must not be on disk during the turn');
  const env = JSON.parse(raw).mcpServers['forge-ask'].env;
  assert.equal(env.CC_ASK_CONV_ID, conv.id);
  assert.equal(env.CC_ASK_TURN_ID, 't-e2e');
  assert.equal(ASK_EXEC_TOKEN_ENV in env, false);
  assert.equal(ASK_AGENT_TOKEN_ENV in env, false);

  const deadline = Date.now() + 8000;
  let turn = null;
  while (Date.now() < deadline) {
    const full = readConversation(conv.id);
    turn = (full.turns || []).find((t) => t.role === 'assistant' && t.turn_id === 't-e2e') || null;
    if (turn) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(turn, 'the stand-in child never closed — nothing to assert on');
  assert.equal(fs.readdirSync(configDir).length, 0, 'the single-use config file must be removed once the turn closes');
});
