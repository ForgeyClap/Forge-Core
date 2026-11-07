// App router P2 — the child environment of a turn on an extra Claude account (design 5.2 rule 1,
// review findings 16 and 17), and the explicit router mock seam.
//
//   - a profile turn gets CLAUDE_CONFIG_DIR=<profile folder>; every forwarded claude_ name that contains
//     token/secret/key/credential/auth (anywhere, any case) is dropped, and every letter-case variant of
//     the config-dir name is removed before the new one is set;
//   - the conversation's agent token (a cc_ name) survives on a profile turn;
//   - without a profile the env is exactly what execSpawnEnv gave before (deepEqual);
//   - the router mock behaviour runs only with CC_ROUTER_MOCK=1; without it the default mock reply is
//     unchanged even under a profile folder.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSpawnEnv, withClaudeProfileEnv, isUsableClaudeConfigDir, filteredEnv } from '../src/exec-cli.mjs';
import { _setAskMcpConfigDirForTests, _buildAskMcpConfigObjectForTests } from '../src/exec-argv.mjs';
import { createConversation, readConversation, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { startExecution, isConversationBusy, _resetExecBridgeForTests } from '../src/exec-lifecycle.mjs';

const PLANTED = {
  // Fake values only. Names are built from parts so no real credential variable name is spelled here.
  ['CLAUDE_FAKE_' + 'TOKEN']: 'planted-1',
  ['claude_fake_' + 'auth_header']: 'planted-2',
  ['Claude_Fake_' + 'Credential_File']: 'planted-3',
  ['CLAUDE_FAKE_' + 'SECRET_THING']: 'planted-4',
  ['CLAUDE_FAKE_API_' + 'KEY']: 'planted-5',
  CLAUDE_FAKE_PLAIN_SETTING: 'keep-me',
  claude_config_dir: 'C:\\inherited\\lower',
  Claude_Config_Dir: 'C:\\inherited\\mixed',
};
const saved = {};
let tmp;
let configDir;
let convDir;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-exec-env-'));
  configDir = path.join(tmp, 'ask');
  convDir = path.join(tmp, 'conv');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(convDir, { recursive: true });
  _setAskMcpConfigDirForTests(configDir);
  _setConversationsDirForTests(convDir);
  for (const k of [...Object.keys(PLANTED), 'CLAUDE_CONFIG_DIR', 'CC_EXEC_MOCK', 'CC_ROUTER_MOCK', 'CC_EXEC_MOCK_DELAY_MS']) saved[k] = process.env[k];
});

beforeEach(() => {
  for (const [k, v] of Object.entries(PLANTED)) process.env[k] = v;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CC_ROUTER_MOCK;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  _resetExecBridgeForTests();
});

after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setAskMcpConfigDirForTests(null);
  _setConversationsDirForTests(null);
  _resetConversationsForTests();
  _resetExecBridgeForTests();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function writeAskConfig(convId) {
  const file = path.join(configDir, 'ask-' + convId + '.json');
  fs.writeFileSync(file, JSON.stringify(_buildAskMcpConfigObjectForTests({ convId, turnId: 't', requestId: 'r' })));
  return file;
}
const keysLower = (env) => Object.keys(env).map((k) => k.toLowerCase());

test('profile env: sets the folder, drops credential-shaped claude_ names (anywhere in the name, any case), keeps plain ones', () => {
  const dir = path.join(tmp, 'profiles', 'werk');
  const env = execSpawnEnv({ claudeConfigDir: dir });
  assert.equal(env.CLAUDE_CONFIG_DIR, dir);
  for (const k of ['CLAUDE_FAKE_' + 'TOKEN', 'claude_fake_' + 'auth_header', 'Claude_Fake_' + 'Credential_File', 'CLAUDE_FAKE_' + 'SECRET_THING', 'CLAUDE_FAKE_API_' + 'KEY']) {
    assert.equal(k in env, false, k + ' must be dropped on a profile turn');
  }
  assert.equal(env.CLAUDE_FAKE_PLAIN_SETTING, 'keep-me');
  assert.equal(keysLower(env).filter((k) => k === 'claude_config_dir').length, 1, 'exactly one config-dir key, the new one');
});

test('profile env on a plain object: every letter-case variant of the config-dir name goes (Windows env objects can hold several)', () => {
  const dir = path.join(tmp, 'profiles', 'case');
  const input = {
    PATH: 'x',
    claude_config_dir: 'C:\\a',
    Claude_Config_Dir: 'C:\\b',
    CLAUDE_CONFIG_DIR: 'C:\\c',
    ['CLAUDE_X_' + 'AUTHORIZATION']: 'planted',
    ['cc_ask_agent_' + 'token']: 'agent-token-stays',
    CLAUDE_PLAIN: 'p',
  };
  const out = withClaudeProfileEnv(input, dir);
  assert.deepEqual(Object.keys(out).filter((k) => k.toLowerCase() === 'claude_config_dir'), ['CLAUDE_CONFIG_DIR']);
  assert.equal(out.CLAUDE_CONFIG_DIR, dir);
  assert.equal(('CLAUDE_X_' + 'AUTHORIZATION') in out, false);
  assert.equal(out['cc_ask_agent_' + 'token'], 'agent-token-stays', 'a cc_ name is never touched by the profile filter');
  assert.equal(out.CLAUDE_PLAIN, 'p');
  assert.equal(out.PATH, 'x');
  assert.equal(input.claude_config_dir, 'C:\\a', 'the input object is not changed');
});

test('profile env: the conversation agent token survives (the filter runs on claude_ names only)', () => {
  const conv = createConversation({ project: 'env-demo' });
  const cfg = writeAskConfig(conv.id);
  const plain = execSpawnEnv({ askMcpConfigPath: cfg });
  const viaOption = execSpawnEnv({ askMcpConfigPath: cfg, claudeConfigDir: path.join(tmp, 'p', 'a') });
  const viaWrapper = withClaudeProfileEnv(plain, path.join(tmp, 'p', 'a'));
  assert.ok(plain.CC_ASK_AGENT_TOKEN, 'precondition: the plain env carries the agent token');
  assert.equal(viaOption.CC_ASK_AGENT_TOKEN, plain.CC_ASK_AGENT_TOKEN);
  assert.equal(viaWrapper.CC_ASK_AGENT_TOKEN, plain.CC_ASK_AGENT_TOKEN);
  assert.deepEqual(viaWrapper, viaOption, 'both entry points build the same profile env');
  assert.notEqual(viaWrapper, plain, 'withClaudeProfileEnv returns a copy');
  assert.equal(plain.CLAUDE_CONFIG_DIR, undefined, 'the input env is not changed');
});

test('no profile: the env is exactly what execSpawnEnv gave before (credential-shaped names untouched, no folder set)', () => {
  const conv = createConversation({ project: 'env-demo-2' });
  const cfg = writeAskConfig(conv.id);
  const before = execSpawnEnv({ askMcpConfigPath: cfg });
  for (const v of [null, undefined, '', 'relative\\folder']) {
    assert.deepEqual(execSpawnEnv({ askMcpConfigPath: cfg, claudeConfigDir: v }), before, 'claudeConfigDir=' + JSON.stringify(v));
  }
  assert.equal(before['CLAUDE_FAKE_' + 'TOKEN'], 'planted-1', 'the main login path keeps today\'s allowlist behaviour');
  assert.deepEqual(withClaudeProfileEnv(before, 'not/absolute'), before);
  assert.equal(isUsableClaudeConfigDir('not/absolute'), false);
  assert.equal(isUsableClaudeConfigDir(path.join(tmp, 'x')), true);
  // filteredEnv itself is unchanged by the router (it never sets a folder)
  assert.equal(filteredEnv().CLAUDE_CONFIG_DIR, undefined);
});

test('startExecution refuses a profile folder that is not an absolute path (never runs it on the main login instead)', () => {
  process.env.CC_EXEC_MOCK = '1';
  const conv = createConversation({ project: 'env-demo-3' });
  const r = startExecution({ convId: conv.id, turnId: 't-rel', requestId: 'req-rel', text: 'hi', cwd: os.tmpdir(), claudeConfigDir: 'relative\\werk', route: { target_id: 'werk' } });
  assert.equal(r.started, false);
  assert.match(r.reason, /absolute/);
  assert.equal(isConversationBusy(conv.id), false);
});

async function runToEnd(convId, args) {
  const r = startExecution({ convId, cwd: os.tmpdir(), ...args });
  assert.equal(r.started, true, r.reason);
  const deadline = Date.now() + 15000;
  for (;;) {
    const rec = (readConversation(convId).turns || []).find((t) => t.role === 'assistant' && t.turn_id === args.turnId);
    if (rec && !isConversationBusy(convId)) return rec;
    if (Date.now() > deadline) throw new Error('turn did not finish');
    await new Promise((res) => setTimeout(res, 25));
  }
}

test('mock seam (finding 16): without CC_ROUTER_MOCK the default mock reply is unchanged, even under a profile folder', async () => {
  process.env.CC_EXEC_MOCK = '1';
  const profile = path.join(tmp, 'profiles', 'werk');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'mock-limit'), '');
  const conv = createConversation({ project: 'env-demo-4' });
  const rec = await runToEnd(conv.id, { turnId: 't-seam', requestId: 'req-seam', text: 'hello seam', claudeConfigDir: profile });
  assert.equal(rec.text, 'MOCK:hello seam', 'the default mock path must not see the profile at all');
  assert.equal(rec.error, null);
  assert.equal('route' in rec, false, 'no route given = no route field written');
});

test('mock seam: with CC_ROUTER_MOCK=1 the child really runs under the profile folder (MOCK-PROFILE:<folder>) and stdin is closed', async () => {
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_ROUTER_MOCK = '1';
  const profile = path.join(tmp, 'profiles', 'prive');
  fs.mkdirSync(profile, { recursive: true });
  const conv = createConversation({ project: 'env-demo-5' });
  const route = { target_id: 'prive', kind: 'claude-account', label: 'Prive', model: null, capability: 'full', reason: 'first', switched: false, attempt: 1, retried: false, outcome: null, handover: null };
  const rec = await runToEnd(conv.id, { turnId: 't-prof', requestId: 'req-prof', text: 'hi __MOCK_STDIN_STATE__', claudeConfigDir: profile, route });
  assert.equal(rec.text, 'MOCK-PROFILE:prive STDIN:end', 'a routed turn closes stdin (spike S2: no 3 s wait in the real CLI)');
  assert.equal(rec.route.target_id, 'prive');
  assert.equal(rec.route.outcome, 'ok');
  assert.equal(rec.route.retried, false);
  const main = await runToEnd(createConversation({ project: 'env-demo-6' }).id, { turnId: 't-main', requestId: 'req-main', text: 'hi', route: { ...route, target_id: 'main' } });
  assert.equal(main.text, 'MOCK-PROFILE:main', 'no folder = the main login');
  const off = await runToEnd(createConversation({ project: 'env-demo-7' }).id, { turnId: 't-off', requestId: 'req-off', text: 'hi __MOCK_STDIN_STATE__' });
  assert.equal(off.text, 'MOCK-PROFILE:main STDIN:timeout', 'router off: stdin is left open exactly as before');
});

test('the exec-cli P3 needle count stays 1 (no new spelled credential variable)', () => {
  const src = fs.readFileSync(new URL('../src/exec-cli.mjs', import.meta.url), 'utf8');
  const needle = 'CLAUDE_CODE_' + 'OAUTH_TOKEN';
  assert.equal(src.split(needle).length - 1, 1);
});
