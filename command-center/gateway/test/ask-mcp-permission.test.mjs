// WP B3 (plan 4.4): the permission prompt tool of ask-mcp.mjs, driven as a REAL child process over
// JSON-RPC stdio (initialize -> tools/call), exactly like the `claude` CLI does with
// --permission-prompt-tool mcp__forge-ask__permission_prompt. The gateway side is a small fake
// http.Server that answers /api/permissions/request and /api/permissions/<id>/wait the way the real
// routes/permissions.mjs does (that module is tested against the real store in
// permissions-routes.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASK_MCP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ask-mcp.mjs');

function startFakeGateway() {
  const received = [];
  let responder = () => ({ status: 404, body: { ok: false, error: 'not set' } });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = responder(req, body, received.length);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: 'http://127.0.0.1:' + server.address().port,
        received,
        reset(fn) { received.length = 0; responder = fn; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function spawnAskMcp(env) {
  const child = spawn(process.execPath, [ASK_MCP_PATH], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const queue = [];
  const waiters = [];
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (waiters.length > 0) waiters.shift()(msg); else queue.push(msg);
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  return {
    send: (msg) => child.stdin.write(JSON.stringify(msg) + '\n'),
    next(timeoutMs = 8000) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no message from ask-mcp.mjs; stderr: ' + stderr)), timeoutMs);
        waiters.push((m) => { clearTimeout(t); resolve(m); });
      });
    },
    stderr: () => stderr,
    stop() { child.stdin.end(); child.kill(); },
  };
}

async function callPermission(env, args) {
  const mcp = spawnAskMcp(env);
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.next();
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'permission_prompt', arguments: args } });
    const reply = await mcp.next(15000);
    assert.equal(reply.id, 2);
    assert.equal(reply.result.content.length, 1, 'exactly one text block (the CLI contract)');
    return { decision: JSON.parse(reply.result.content[0].text), stderr: mcp.stderr() };
  } finally {
    mcp.stop();
  }
}

const BASH_ARGS = { tool_name: 'Bash', input: { command: 'npm install' }, tool_use_id: 'toolu_01' };

let gateway;
let env;
before(async () => {
  gateway = await startFakeGateway();
  env = { CC_ASK_GATEWAY_ORIGIN: gateway.origin, CC_ASK_CONV_ID: 'c-7', CC_ASK_TURN_ID: 't-7', CC_ASK_REQUEST_ID: 'r-7', CC_ASK_AGENT_TOKEN: 'tok-perm', CC_PERMISSION_POLL_MS: '50' };
});
after(async () => { await gateway.close(); });

test('ALLOW: registers the request, keeps polling while undecided, returns {behavior:"allow", updatedInput}', async () => {
  let polls = 0;
  gateway.reset((req) => {
    if (req.url === '/api/permissions/request') return { status: 200, body: { ok: true, id: 'perm-1' } };
    if (req.url === '/api/permissions/perm-1/wait') {
      polls += 1;
      if (polls < 3) return { status: 200, body: { ok: true, decided: false } };
      return { status: 200, body: { ok: true, decided: true, behavior: 'allow', updatedInput: { command: 'npm install' } } };
    }
    return { status: 404, body: { ok: false, error: 'not found' } };
  });
  const { decision } = await callPermission(env, BASH_ARGS);
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { command: 'npm install' } });
  const reg = gateway.received[0];
  assert.equal(reg.url, '/api/permissions/request');
  assert.equal(reg.headers['x-cc-exec-token'], 'tok-perm');
  assert.deepEqual(reg.body, { conv_id: 'c-7', turn_id: 't-7', request_id: 'r-7', tool_name: 'Bash', input: { command: 'npm install' }, tool_use_id: 'toolu_01' });
  assert.equal(polls, 3, 'an undecided poll is followed by another poll, never a deny');
  assert.equal(gateway.received[1].body.wait_ms, 50);
});

// WP B3-sec-impl (Security Boss Step 1a): the server authenticates with the AGENT token only. Even
// when a CC_ASK_EXEC_TOKEN is present in its environment (an older gateway, a leaked variable), that
// value never leaves the process, on any route (register, wait, ask_owner).
test('REGRESSION (Step 1a): every call carries CC_ASK_AGENT_TOKEN and never a CC_ASK_EXEC_TOKEN value', async () => {
  gateway.reset((req) => {
    if (req.url === '/api/permissions/request') return { status: 200, body: { ok: true, id: 'perm-tok' } };
    if (req.url === '/api/ask') return { status: 200, body: { ok: true, timed_out: false, answers: [{ question: 'q', answer: 'a' }] } };
    return { status: 200, body: { ok: true, decided: true, behavior: 'allow', updatedInput: { command: 'npm install' } } };
  });
  const both = { ...env, CC_ASK_AGENT_TOKEN: 'agent-value-1', CC_ASK_EXEC_TOKEN: 'dashboard-value-1' };
  const { decision } = await callPermission(both, BASH_ARGS);
  assert.equal(decision.behavior, 'allow');
  const mcp = spawnAskMcp(both);
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.next();
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_owner', arguments: { questions: [{ question: 'q' }] } } });
    await mcp.next();
  } finally {
    mcp.stop();
  }
  assert.deepEqual(gateway.received.map((r) => r.url), ['/api/permissions/request', '/api/permissions/perm-tok/wait', '/api/ask']);
  for (const r of gateway.received) {
    assert.equal(r.headers['x-cc-exec-token'], 'agent-value-1', r.url);
    assert.equal(JSON.stringify(r.headers).includes('dashboard-value-1'), false, r.url);
  }
});

test('DENY: the user\'s "Niet doen" reaches the CLI as {behavior:"deny", message}', async () => {
  gateway.reset((req) => {
    if (req.url === '/api/permissions/request') return { status: 200, body: { ok: true, id: 'perm-2' } };
    return { status: 200, body: { ok: true, decided: true, behavior: 'deny', message: 'The user declined this action in Forge.' } };
  });
  const { decision } = await callPermission(env, BASH_ARGS);
  assert.deepEqual(decision, { behavior: 'deny', message: 'The user declined this action in Forge.' });
});

test('SESSION RULE: a decision returned at registration ("Altijd toestaan in dit gesprek") needs no poll', async () => {
  gateway.reset(() => ({ status: 200, body: { ok: true, id: 'perm-3', decision: { decided: true, behavior: 'allow', updatedInput: { command: 'npm install' } } } }));
  const { decision } = await callPermission(env, BASH_ARGS);
  assert.equal(decision.behavior, 'allow');
  assert.equal(gateway.received.length, 1);
});

test('GATEWAY RESTART: an id the gateway no longer knows (404) is registered again, then answered', async () => {
  let registrations = 0;
  gateway.reset((req) => {
    if (req.url === '/api/permissions/request') {
      registrations += 1;
      return { status: 200, body: { ok: true, id: 'perm-r' + registrations } };
    }
    if (req.url === '/api/permissions/perm-r1/wait') return { status: 404, body: { ok: false, error: 'unknown or expired permission request' } };
    return { status: 200, body: { ok: true, decided: true, behavior: 'allow', updatedInput: { command: 'npm install' } } };
  });
  const { decision, stderr } = await callPermission(env, BASH_ARGS);
  assert.equal(decision.behavior, 'allow');
  assert.equal(registrations, 2);
  assert.match(stderr, /registering it again/);
});

test('VALIDATION: a call without tool_name/input is an explicit deny and makes no HTTP call', async () => {
  gateway.reset(() => ({ status: 500, body: { ok: false, error: 'must not be called' } }));
  const { decision } = await callPermission(env, { input: { command: 'x' } });
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message, /without a tool_name/);
  assert.equal(gateway.received.length, 0);
});

test('UNREACHABLE: a gateway that cannot be reached ends in an explicit deny that says why (never silent)', async () => {
  const { decision, stderr } = await callPermission(
    { ...env, CC_ASK_GATEWAY_ORIGIN: 'http://127.0.0.1:1', CC_PERMISSION_RECONNECT_MS: '300' },
    BASH_ARGS,
  );
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message, /could not reach the user/);
  assert.match(stderr, /gateway unreachable/);
});

test('REGISTRATION REFUSED: a 4xx from the gateway is an explicit deny carrying the gateway error', async () => {
  gateway.reset(() => ({ status: 404, body: { ok: false, error: 'conversation not found' } }));
  const { decision } = await callPermission(env, BASH_ARGS);
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message, /conversation not found/);
});

test('ROUTING: a tools/call for ask_owner still goes to /api/ask, unchanged', async () => {
  gateway.reset((req) => (req.url === '/api/ask'
    ? { status: 200, body: { ok: true, timed_out: false, answers: [{ question: 'q', answer: 'a' }] } }
    : { status: 404, body: { ok: false, error: 'wrong route' } }));
  const mcp = spawnAskMcp(env);
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.next();
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_owner', arguments: { questions: [{ question: 'q' }] } } });
    const reply = await mcp.next();
    assert.deepEqual(JSON.parse(reply.result.content[0].text).answers, [{ question: 'q', answer: 'a' }]);
  } finally {
    mcp.stop();
  }
  assert.equal(gateway.received[0].url, '/api/ask');
});
