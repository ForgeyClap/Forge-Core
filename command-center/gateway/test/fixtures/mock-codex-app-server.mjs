// Mock `codex app-server` for providers-cli tests. Speaks the same stdio wire format as codex-cli
// 0.156.1 (JSON-RPC 2.0 without the "jsonrpc" field, one JSON object per line). Behaviour is chosen by
// env MOCK_CODEX_MODE:
//   logged-in   initialize, account/read -> chatgpt account, thread/start, turn/start streams
//               "Hello" + " from mock" deltas, token usage, turn/completed
//   logged-out  account/read -> { account: null, requiresOpenaiAuth: true }
//   approval    turn/start sends item/commandExecution/requestApproval and waits for the answer, then
//               streams "decision=<decision>" and completes
//   turn-failed turn/completed with status failed
//   token-refresh  sends account/chatgptAuthTokens/refresh and expects an error answer
//   crash       exits with code 3 right after initialize
// It also writes one line to stderr containing a fake key-shaped string, so the client's stderr
// redaction can be checked. Every request it receives is appended to MOCK_CODEX_LOG (if set) as JSON.
//
// GUARD: Node 24's default `node --test` globs include every .mjs under a test/ directory, so a plain
// `node --test` (the gateway's npm test) also executes THIS file as if it were a test. Without the
// guard it would wait on stdin forever and hang the whole suite (observed 2026-11-01). It therefore
// only acts as a server when a test started it with MOCK_CODEX_MODE set; otherwise it exits 0 at once.
if (!process.env.MOCK_CODEX_MODE) process.exit(0);

import fs from 'node:fs';

const mode = process.env.MOCK_CODEX_MODE;
const log = process.env.MOCK_CODEX_LOG || null;
let initialized = false;
let buf = '';
const waiting = new Map(); // server request id -> callback

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function record(obj) { if (log) fs.appendFileSync(log, JSON.stringify(obj) + '\n'); }

// A key-shaped string assembled at run time (never a real credential).
process.stderr.write('mock app-server starting with sk-' + 'mockmockmockmockmockmock1234' + '\n');

const THREAD = 'thr_mock_1';
const TURN = 'turn_mock_1';
// codex-cli 0.156.1: ThreadStartParams.sandbox (SandboxMode) and SandboxPolicy.type spellings.
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const SANDBOX_POLICY_TYPE = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };

function streamTurn(text, status = 'completed') {
  send({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, items: [], status: 'inProgress' } } });
  send({ method: 'item/started', params: { threadId: THREAD, turnId: TURN, startedAtMs: Date.now(), item: { type: 'agentMessage', id: 'item_1', text: '' } } });
  if (text) {
    const half = Math.ceil(text.length / 2);
    send({ method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'item_1', delta: text.slice(0, half) } });
    send({ method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'item_1', delta: text.slice(half) } });
  }
  // a delta for another thread must be ignored by the client
  send({ method: 'item/agentMessage/delta', params: { threadId: 'thr_other', turnId: 'x', itemId: 'y', delta: 'IGNORED' } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: THREAD, turnId: TURN, tokenUsage: { last: { inputTokens: 12, outputTokens: 5, totalTokens: 17, cachedInputTokens: 0, reasoningOutputTokens: 0 }, total: { inputTokens: 12, outputTokens: 5, totalTokens: 17, cachedInputTokens: 0, reasoningOutputTokens: 0 } } } });
  const turn = { id: TURN, items: [], status };
  if (status === 'failed') turn.error = { message: 'mock model refused' };
  send({ method: 'turn/completed', params: { threadId: THREAD, turn } });
}

function handle(msg) {
  record(msg);
  if (msg.method && msg.id === undefined) return; // notification (initialized)
  if (msg.method === undefined && msg.id !== undefined) { // answer to one of our server requests
    const cb = waiting.get(msg.id);
    if (cb) { waiting.delete(msg.id); cb(msg); }
    return;
  }
  if (msg.method !== 'initialize' && !initialized) { send({ id: msg.id, error: { code: -32002, message: 'Not initialized' } }); return; }
  switch (msg.method) {
    case 'initialize':
      initialized = true;
      send({ id: msg.id, result: { codexHome: 'C:\\mock\\.codex', platformFamily: 'windows', platformOs: 'windows', userAgent: 'mock-codex/0.156.1 (' + (msg.params && msg.params.clientInfo && msg.params.clientInfo.name) + ')' } });
      if (mode === 'crash') setTimeout(() => process.exit(3), 20);
      break;
    case 'account/read':
      if (mode === 'logged-out') send({ id: msg.id, result: { account: null, requiresOpenaiAuth: true } });
      else send({ id: msg.id, result: { account: { type: 'chatgpt', email: 'person@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true } });
      break;
    case 'thread/start': {
      // Pinned to the 0.156.1 schema: ThreadStartParams.sandbox is the SandboxMode enum. The real
      // server would also accept a missing value (then the user's config decides); this mock REQUIRES
      // it so a client that forgets the explicit sandbox fails the test.
      const p = msg.params || {};
      if (!SANDBOX_MODES.includes(p.sandbox)) { send({ id: msg.id, error: { code: -32602, message: 'thread/start: sandbox must be one of ' + SANDBOX_MODES.join('|') + ' (got ' + String(p.sandbox) + ')' } }); break; }
      send({ id: msg.id, result: { thread: { id: THREAD }, model: 'gpt-mock', modelProvider: 'openai', cwd: p.cwd || 'C:\\mock', approvalPolicy: p.approvalPolicy || 'on-request', approvalsReviewer: 'user', sandbox: { type: SANDBOX_POLICY_TYPE[p.sandbox] } } });
      send({ method: 'thread/started', params: { thread: { id: THREAD } } });
      break;
    }
    case 'turn/start': {
      // TurnStartParams.sandboxPolicy is optional in the schema; when present its `type` must be valid.
      const sp = msg.params && msg.params.sandboxPolicy;
      if (sp && !Object.values(SANDBOX_POLICY_TYPE).includes(sp.type)) { send({ id: msg.id, error: { code: -32602, message: 'turn/start: bad sandboxPolicy.type ' + String(sp.type) } }); break; }
      send({ id: msg.id, result: { turn: { id: TURN, items: [], status: 'inProgress' } } });
      if (mode === 'approval') {
        const reqId = 'srv_1';
        waiting.set(reqId, (answer) => {
          const decision = answer.result ? answer.result.decision : 'error';
          streamTurn('decision=' + decision);
        });
        send({ id: reqId, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: 'cmd_1', command: 'npm test', startedAtMs: Date.now() } });
      } else if (mode === 'token-refresh') {
        const reqId = 'srv_tok';
        waiting.set(reqId, (answer) => streamTurn(answer.error ? 'refresh refused' : 'refresh ACCEPTED'));
        send({ id: reqId, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' } });
      } else if (mode === 'turn-failed') {
        streamTurn('', 'failed');
      } else {
        streamTurn('Hello from mock');
      }
      break;
    }
    case 'turn/interrupt':
      send({ id: msg.id, result: {} });
      break;
    default:
      send({ id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
