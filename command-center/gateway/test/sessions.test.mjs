// WP A4 — shared session module: the chat remembers across turns.
// ALWAYS mock mode (CC_EXEC_MOCK=1): no real `claude` invocation happens in this file.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  readConversation,
  deleteConversation,
  forkConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import { startExecution, _resetExecBridgeForTests, _buildRealArgsForTests } from '../src/exec-bridge.mjs';
import { buildSpawnSpec } from '../src/exec-argv.mjs';
import { extractInitSessionId } from '../src/exec-stream-parse.mjs';
import { SessionStore, normalizeSessionRecord, isValidConversationKey } from '../src/sessions/session-store.mjs';
import { sessionArgv, sessionOptionsForConversation, argvForConversation, SESSION_ID_RE } from '../src/sessions/argv-session.mjs';
import {
  gatewaySessionStore,
  gatewaySessionsFile,
  createRunSessionTracker,
  readConversationSession,
  _setGatewaySessionsFileForTests,
  GATEWAY_SESSIONS_FILE_NAME,
} from '../src/sessions/gateway-sessions.mjs';

let tempDir;
// Same rationale as exec-bridge.test.mjs: the mock child's cwd is a stable directory that is never
// removed, so a just-killed child cannot race the cleanup of the store dir.
const execCwd = os.tmpdir();

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sessions-test-'));
  _setConversationsDirForTests(tempDir);
});

after(() => {
  delete process.env.CC_EXEC_MOCK;
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _resetExecBridgeForTests();
});

async function waitUntil(predicate, { timeoutMs = 4000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function runTurn(convId, text, extra = {}) {
  const before = readConversation(convId).turns.filter((t) => t.role === 'assistant').length;
  const start = startExecution({ convId, turnId: 't-' + text.length + '-' + before, requestId: 'req-' + before, text, cwd: execCwd, ...extra });
  assert.equal(start.started, true, 'turn must start: ' + JSON.stringify(start));
  const done = await waitUntil(() => readConversation(convId).turns.filter((t) => t.role === 'assistant').length > before);
  assert.ok(done, 'mock turn must finish');
  const assistants = readConversation(convId).turns.filter((t) => t.role === 'assistant');
  return assistants[assistants.length - 1];
}

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(tempDir, 'store-')), name);
}

// ---------- SessionStore (pure) ----------

test('SessionStore: set/get/getSessionId round-trip across instances, createdAt kept, lastUsedAt moves', async () => {
  const file = tmpFile('s.json');
  const a = new SessionStore(file);
  const first = a.set('conv-1', { sessionId: 'abc12345-x', model: 'sonnet', cwd: 'C:\\p', title: 'Hallo' });
  assert.equal(first.sessionId, 'abc12345-x');
  await new Promise((r) => setTimeout(r, 5));
  const second = new SessionStore(file).set('conv-1', { sessionId: 'def67890-y' });
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.lastUsedAt, first.lastUsedAt);
  assert.equal(second.model, 'sonnet', 'a field left out keeps its stored value');
  assert.equal(second.title, 'Hallo');
  assert.equal(new SessionStore(file).getSessionId('conv-1'), 'def67890-y');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['s.json'], 'atomic write leaves no temp file');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.sessions['conv-1'].sessionId, 'def67890-y');
});

test('SessionStore: get returns a copy (mutating it never changes the store)', () => {
  const store = new SessionStore(tmpFile('s.json'));
  store.set('c', { sessionId: 'abcdefgh' });
  const rec = store.get('c');
  rec.sessionId = 'mutated';
  assert.equal(store.getSessionId('c'), 'abcdefgh');
});

test('SessionStore: reads the legacy Discord format (bare session-id strings) unchanged', () => {
  const file = tmpFile('sessions.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ sessions: { 'chan:thread': 'sess_legacy' } }));
  const store = new SessionStore(file);
  assert.equal(store.getSessionId('chan:thread'), 'sess_legacy');
  assert.equal(store.get('chan:thread').pendingFork, false);
  assert.deepEqual(normalizeSessionRecord(''), null);
  assert.deepEqual(normalizeSessionRecord({ sessionId: 42 }), null);
});

test('SessionStore: missing file is empty; a corrupt file is an explicit error, never silently empty', () => {
  assert.equal(new SessionStore(tmpFile('none.json')).get('x'), null);
  const file = tmpFile('bad.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => new SessionStore(file).get('x'), /not valid JSON/);
  assert.throws(() => new SessionStore(file).set('x', { sessionId: 'abcdefgh' }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json', 'a corrupt file is never overwritten');
});

test('SessionStore: rejects unsafe keys and empty/control-char session ids', () => {
  const store = new SessionStore(tmpFile('s.json'));
  assert.equal(store.set('__proto__', { sessionId: 'abcdefgh' }), null);
  assert.equal(store.set('', { sessionId: 'abcdefgh' }), null);
  assert.equal(store.set('ok', { sessionId: '' }), null);
  assert.equal(store.set('ok', { sessionId: 'ab\ncd' }), null);
  assert.equal(isValidConversationKey(' padded'), false);
  assert.equal(store.list().length, 0);
  assert.equal(({}).polluted, undefined);
});

test('SessionStore: list is newest first, search filters by title (case-insensitive), clear removes', async () => {
  const store = new SessionStore(tmpFile('s.json'));
  store.set('a', { sessionId: 'aaaaaaaa', title: 'Factuur maken' });
  await new Promise((r) => setTimeout(r, 5));
  store.set('b', { sessionId: 'bbbbbbbb', title: 'Website bouwen' });
  await new Promise((r) => setTimeout(r, 5));
  store.set('c', { sessionId: 'cccccccc', title: 'Nieuwe factuur' });
  assert.deepEqual(store.list().map((r) => r.conversationId), ['c', 'b', 'a']);
  assert.deepEqual(store.search('FACTUUR').map((r) => r.conversationId), ['c', 'a']);
  assert.deepEqual(store.list({ limit: 1 }).map((r) => r.conversationId), ['c']);
  assert.deepEqual(store.search('  '), []);
  assert.equal(store.clear('b'), true);
  assert.equal(store.clear('b'), false);
  assert.equal(store.get('b'), null);
});

test('SessionStore: stays bounded — the least recently used entries are evicted', async () => {
  const store = new SessionStore(tmpFile('s.json'), { maxEntries: 2 });
  store.set('old', { sessionId: 'oooooooo' });
  await new Promise((r) => setTimeout(r, 5));
  store.set('mid', { sessionId: 'mmmmmmmm' });
  await new Promise((r) => setTimeout(r, 5));
  store.set('new', { sessionId: 'nnnnnnnn' });
  assert.equal(store.get('old'), null);
  assert.deepEqual(store.list().map((r) => r.conversationId), ['new', 'mid']);
});

// ---------- argv-session (pure) ----------

test('argv: sessionArgv shapes; an unsafe id or a fork without a session adds nothing', () => {
  assert.deepEqual(sessionArgv(), []);
  assert.deepEqual(sessionArgv({ resumeSessionId: 'abc12345' }), ['--resume', 'abc12345']);
  assert.deepEqual(sessionArgv({ resumeSessionId: 'abc12345', fork: true }), ['--resume', 'abc12345', '--fork-session']);
  assert.deepEqual(sessionArgv({ resumeSessionId: '--evil-flag' }), []);
  assert.deepEqual(sessionArgv({ resumeSessionId: 'abc 12345' }), []);
  assert.deepEqual(sessionArgv({ resumeSessionId: null, fork: true }), []);
  assert.ok(SESSION_ID_RE.test('060c83ff-8ef5-4722-898a-884f5157a1c2'), 'a real CLI session id passes');
});

test('argv: a session made in another working directory starts fresh; pendingFork forks', () => {
  const rec = { sessionId: 'abc12345', cwd: path.resolve('/proj/a'), pendingFork: false };
  assert.deepEqual(argvForConversation(rec, { cwd: path.resolve('/proj/a') }), ['--resume', 'abc12345']);
  assert.deepEqual(argvForConversation(rec, { cwd: path.resolve('/proj/b') }), []);
  assert.deepEqual(argvForConversation({ ...rec, pendingFork: true }, { cwd: path.resolve('/proj/a') }), ['--resume', 'abc12345', '--fork-session']);
  assert.deepEqual(argvForConversation(rec, { cwd: path.resolve('/proj/a'), fork: true }), ['--resume', 'abc12345', '--fork-session']);
  assert.deepEqual(sessionOptionsForConversation(null), { resumeSessionId: null, fork: false });
});

test('argv: buildRealArgs keeps every existing flag in place and appends the session flags last', () => {
  const base = _buildRealArgsForTests('hello', 'plan', 'high', 'claude-opus-5-5');
  assert.deepEqual(base, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--effort', 'high', '--model', 'claude-opus-5-5']);
  assert.deepEqual(_buildRealArgsForTests('hello', 'plan', 'high', 'claude-opus-5-5', {}), base);
  assert.deepEqual(_buildRealArgsForTests('hello', 'plan', 'high', 'claude-opus-5-5', { resumeSessionId: 'abc12345' }), [...base, '--resume', 'abc12345']);
  assert.deepEqual(_buildRealArgsForTests('hello', 'execute', undefined, undefined, { resumeSessionId: 'abc12345', fork: true }),
    ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--resume', 'abc12345', '--fork-session']);
});

test('argv: mock spawn spec carries the same session argv after the prompt, and nothing without one', () => {
  assert.equal(buildSpawnSpec('hi', 'execute').args.length, 3);
  const spec = buildSpawnSpec('hi', 'execute', undefined, undefined, undefined, { resumeSessionId: 'abc12345', fork: true });
  assert.deepEqual(spec.args.slice(2), ['hi', '--resume', 'abc12345', '--fork-session']);
});

// ---------- stream parse ----------

test('parse: extractInitSessionId reads only the main system/init line', () => {
  assert.equal(extractInitSessionId({ type: 'system', subtype: 'init', session_id: 'abc12345' }), 'abc12345');
  assert.equal(extractInitSessionId({ type: 'system', subtype: 'init', session_id: 'abc12345', parent_tool_use_id: null }), 'abc12345');
  assert.equal(extractInitSessionId({ type: 'system', subtype: 'init', session_id: 'abc12345', parent_tool_use_id: 'toolu_x' }), null);
  assert.equal(extractInitSessionId({ type: 'result', session_id: 'abc12345' }), null);
  assert.equal(extractInitSessionId({ type: 'system', subtype: 'init' }), null);
  assert.equal(extractInitSessionId(null), null);
});

// ---------- end to end through startExecution (mock CLI) ----------

test('E2E: turn 1 stores the session id; turn 2 is spawned with --resume <that id> and keeps it', async () => {
  assert.equal(path.dirname(gatewaySessionsFile()), tempDir, 'the store follows the conversations test dir');
  assert.equal(path.basename(gatewaySessionsFile()), GATEWAY_SESSIONS_FILE_NAME);
  const conv = createConversation({ project: 'demo-project' });

  const t1 = await runTurn(conv.id, 'onthoud dit __MOCK_SESSION__');
  assert.match(t1.text, / SESSION_ARGS:\[\]$/, 'turn 1 runs without --resume');
  assert.match(t1.session_id, /^mock-sess-[0-9a-f]{8}$/);
  const stored = gatewaySessionStore().get(conv.id);
  assert.equal(stored.sessionId, t1.session_id, 'turn 1 stored its session id');
  assert.equal(stored.cwd, execCwd);
  assert.equal(stored.title, 'onthoud dit __MOCK_SESSION__');

  const t2 = await runTurn(conv.id, 'wat zei ik?');
  assert.ok(t2.text.endsWith(' SESSION_ARGS:[--resume ' + t1.session_id + ']'), 'turn 2 argv carries --resume <id>: ' + t2.text);
  assert.equal(t2.session_id, t1.session_id);

  const t3 = await runTurn(conv.id, 'en nog een keer');
  assert.ok(t3.text.endsWith('[--resume ' + t1.session_id + ']'), 'turn 3 resumes the same session');

  const read = readConversation(conv.id);
  assert.equal(read.session_id, t1.session_id, 'the conversation record exposes the session id');
  assert.equal(read.session.fork_pending, false);
});

test('E2E: a conversation without any session line stays fresh (pre-A4 behaviour unchanged)', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const t1 = await runTurn(conv.id, 'ping');
  assert.equal(t1.text, 'MOCK:ping');
  assert.strictEqual(t1.session_id, null);
  assert.equal(readConversation(conv.id).session, null);
  const t2 = await runTurn(conv.id, 'pong');
  assert.equal(t2.text, 'MOCK:pong', 'no --resume without a stored session');
});

test('E2E: fork request spawns --resume <id> --fork-session and stores the NEW session id', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const t1 = await runTurn(conv.id, 'basis __MOCK_SESSION__');
  const t2 = await runTurn(conv.id, 'splits af', { fork: true });
  assert.ok(t2.text.endsWith('[--resume ' + t1.session_id + ' --fork-session]'), t2.text);
  assert.match(t2.session_id, /^mock-fork-/);
  assert.equal(gatewaySessionStore().getSessionId(conv.id), t2.session_id);
});

test('E2E: forkConversation makes a new conversation that forks the source session once; the source keeps its own', async () => {
  const src = createConversation({ project: 'demo-project' });
  const s1 = await runTurn(src.id, 'bron __MOCK_SESSION__');
  const fork = forkConversation(src.id);
  assert.equal(fork.ok, true);
  assert.equal(fork.forked_from, src.id);
  assert.equal(fork.session_fork_pending, true);
  assert.equal(readConversation(fork.id).meta.forked_from, src.id);
  assert.equal(readConversation(fork.id).session.fork_pending, true);

  const f1 = await runTurn(fork.id, 'in de fork');
  assert.ok(f1.text.endsWith('[--resume ' + s1.session_id + ' --fork-session]'), f1.text);
  const f2 = await runTurn(fork.id, 'tweede beurt in de fork');
  assert.ok(f2.text.endsWith('[--resume ' + f1.session_id + ']'), 'after the first turn the fork resumes its OWN new session');
  assert.equal(gatewaySessionStore().getSessionId(src.id), s1.session_id, 'the source session is untouched');
  assert.equal(forkConversation('c-does-not-exist').ok, false);
});

test('E2E: forking a conversation without a session gives a fresh fork', () => {
  const src = createConversation({ project: 'demo-project' });
  const fork = forkConversation(src.id);
  assert.equal(fork.ok, true);
  assert.equal(fork.session_fork_pending, false);
  assert.equal(readConversation(fork.id).session, null);
});

test('deleteConversation also removes the conversation\'s stored session', async () => {
  const conv = createConversation({ project: 'demo-project' });
  await runTurn(conv.id, 'weg __MOCK_SESSION__');
  assert.ok(gatewaySessionStore().get(conv.id));
  assert.equal(deleteConversation(conv.id).ok, true);
  assert.equal(gatewaySessionStore().get(conv.id), null);
});

// ---------- run tracker failure paths ----------

test('tracker: a resumed run that exits non-zero before any init drops the stale session; a stop (exit null) keeps it', () => {
  const store = gatewaySessionStore();
  store.set('c-tracker-1', { sessionId: 'stale1234' });
  const failed = createRunSessionTracker({ convId: 'c-tracker-1', resumeSessionId: 'stale1234' });
  assert.equal(failed.finish({ exitCode: 1 }), 'cleared');
  assert.equal(store.get('c-tracker-1'), null);

  store.set('c-tracker-2', { sessionId: 'keep1234' });
  const stopped = createRunSessionTracker({ convId: 'c-tracker-2', resumeSessionId: 'keep1234' });
  assert.equal(stopped.finish({ exitCode: null }), 'unchanged');
  assert.equal(store.getSessionId('c-tracker-2'), 'keep1234');

  const ok = createRunSessionTracker({ convId: 'c-tracker-2', resumeSessionId: 'keep1234' });
  ok.observe({ type: 'system', subtype: 'init', session_id: 'keep1234' });
  assert.equal(ok.finish({ exitCode: 1 }), 'stored', 'a run whose init arrived keeps its session');
});

test('tracker: a store write failure is reported through onError, never thrown into the stream handler', () => {
  const errors = [];
  const badFile = path.join(tempDir, 'store-bad.json');
  fs.writeFileSync(badFile, '{broken');
  const real = gatewaySessionsFile();
  _setGatewaySessionsFileForTests(badFile);
  try {
    const tracker = createRunSessionTracker({ convId: 'c-x', onError: (e) => errors.push(e) });
    assert.doesNotThrow(() => tracker.observe({ type: 'system', subtype: 'init', session_id: 'abcdefgh' }));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].action, 'store');
    assert.match(errors[0].message, /not valid JSON/);
    assert.equal(readConversationSession('c-x'), null, 'a reader falls back to no session');
  } finally {
    _setGatewaySessionsFileForTests(null);
  }
  assert.equal(gatewaySessionsFile(), real);
});
