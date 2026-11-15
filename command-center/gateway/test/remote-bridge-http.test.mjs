// Remote Bridge HTTP tests: real sockets against the main gateway (loopback admin routes) and a real
// bridge listener on 127.0.0.1 (test override FORGE_REMOTE_BRIDGE_TEST_LOOPBACK=1). Mock execution only
// (CC_EXEC_MOCK=1): no real `claude` process is started. Contract: command-center/docs/REMOTE-BRIDGE-CONTRACT.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import {
  _resetProjectsCacheForTests, _setForgeSyncCjsForTests, _resetForgeSyncCjsForTests, _setScanRootsForTests, _resetScanRootsForTests,
} from '../src/projects.mjs';
import { _setInstalledProjectsFileForTests, _resetInstalledProjectsFileForTests } from '../src/installed-projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, readConversation, appendUserTurn } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { createAskRequest, getAskMeta, _resetAskStoreForTests } from '../src/ask-store.mjs';
import {
  _setRemoteDataDirForTests, _setScribeRunnerForTests, _configureRemoteLimitsForTests, _resetRemoteForTests,
} from '../src/remote/manager.mjs';
import { _setMobileDirForTests } from '../src/remote/apk.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';
import { createPermissionRequest, registerPermissionRun, answerPermission } from '../src/permissions/store.mjs';

const PROJECT = path.basename(PROJECT_ROOT);

let server; let port; let convDir; let dataDir; let bridgePort; let token; let deviceId; let pairCode;
let scribeItems = [];
let scribeCalls = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** One real request to the bridge. */
function bridge(method, urlPath, { body, headers = {}, auth = true, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (auth && token && !('authorization' in h)) h.authorization = 'Bearer ' + token;
    let payload = null;
    if (rawBody != null) payload = rawBody;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (payload != null) h['content-type'] = h['content-type'] || 'application/json';
    const req = http.request({ host: '127.0.0.1', port: bridgePort, path: urlPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, json, body: data });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK = '1';
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-conv-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-data-'));
  _setConversationsDirForTests(convDir);
  _setRemoteDataDirForTests(dataDir);
  _setScribeRunnerForTests(async (project) => (scribeCalls++, project.name === PROJECT
    ? { available: true, items: scribeItems }
    : { available: false, items: [] }));
  _configureRemoteLimitsForTests({ scribeCacheMs: 0 });
  _resetProjectsCacheForTests();
  _resetExecBridgeForTests();
  _resetAskStoreForTests();
  server = createServer();
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  bridgePort = await freePort();
});

after(async () => {
  await _resetRemoteForTests();
  delete process.env.CC_EXEC_MOCK;
  delete process.env.FORGE_REMOTE_BRIDGE_TEST_LOOPBACK;
  _resetExecBridgeForTests();
  _resetAskStoreForTests();
  _resetConversationsForTests();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(convDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

// ---------------------------------------------------------------- loopback admin API

test('admin: GET /api/remote reports the bridge off by default', async () => {
  const r = await request(port, '/api/remote');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(r.json.running, false);
  assert.equal(r.json.bridge_url, null);
});

test('admin: GET /api/remote says where the phone app (.apk) is, as an absolute path with its size', async () => {
  const mobile = path.join(dataDir, 'fake-mobile');
  const file = path.join(mobile, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(4096));
  _setMobileDirForTests(mobile);
  try {
    const built = await request(port, '/api/remote');
    assert.equal(built.statusCode, 200);
    assert.deepEqual(built.json.apk, { path: file, exists: true, size_bytes: 4096 });
    fs.rmSync(file);
    const gone = await request(port, '/api/remote');
    assert.deepEqual(gone.json.apk, { path: file, exists: false, size_bytes: null });
    _setMobileDirForTests(path.join(dataDir, 'no-mobile-here'));
    const packaged = await request(port, '/api/remote');
    assert.deepEqual(packaged.json.apk, { path: null, exists: false, size_bytes: null });
  } finally {
    _setMobileDirForTests(null);
  }
});

test('admin: a write without the dashboard credential is refused', async () => {
  const r = await requestWithBody(port, '/api/remote/enable', { jsonBody: { mode: 'lan', address: '127.0.0.1', port: bridgePort }, omitExecToken: true });
  assert.equal(r.statusCode, 403);
});

test('admin: enable refuses 0.0.0.0 and :: with bind_refused, and a bad mode with invalid_request', async () => {
  for (const address of ['0.0.0.0', '::']) {
    const r = await requestWithBody(port, '/api/remote/enable', { jsonBody: { mode: 'lan', address, port: bridgePort } });
    assert.equal(r.statusCode, 400, address);
    assert.equal(r.json.code, 'bind_refused');
  }
  const bad = await requestWithBody(port, '/api/remote/enable', { jsonBody: { mode: 'public' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json.code, 'invalid_request');
  const st = await request(port, '/api/remote');
  assert.equal(st.json.running, false, 'a refused enable starts nothing');
});

test('admin: pairing before the bridge runs answers 409 bridge_not_running', async () => {
  const r = await requestWithBody(port, '/api/remote/pairing', { jsonBody: {} });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json.code, 'bridge_not_running');
});

test('admin: enable on 127.0.0.1 (test override) starts the bridge and persists the setting; LAN writes are off by default', async () => {
  const r = await requestWithBody(port, '/api/remote/enable', { jsonBody: { mode: 'lan', address: '127.0.0.1', port: bridgePort } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  assert.equal(r.json.running, true);
  assert.equal(r.json.bridge_url, 'http://127.0.0.1:' + bridgePort);
  assert.equal(r.json.allow_lan_writes, false);
  assert.match(r.json.cleartext_warning, /cleartext/i);
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'remote', 'settings.json'), 'utf8'));
  assert.equal(settings.enabled, true);
  assert.equal(settings.address, '127.0.0.1');
  assert.equal(settings.allow_lan_writes, false);
  const bad = await requestWithBody(port, '/api/remote/enable', { jsonBody: { mode: 'lan', address: '127.0.0.1', port: bridgePort, allow_lan_writes: 'yes' } });
  assert.equal(bad.statusCode, 400);
});

test('pairing: the admin code pairs once, returns a token, and the QR text carries url + code', async () => {
  const p = await requestWithBody(port, '/api/remote/pairing', { jsonBody: {} });
  assert.equal(p.statusCode, 200);
  pairCode = p.json.code;
  assert.match(pairCode, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.deepEqual(JSON.parse(p.json.qr_text), { v: 1, bridge_url: 'http://127.0.0.1:' + bridgePort, code: pairCode });
  const ok = await bridge('POST', '/remote/v1/pair', { body: { code: pairCode, device_name: 'Pixel 8' }, auth: false });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.json));
  token = ok.json.token;
  deviceId = ok.json.device.id;
  assert.match(token, /^frb_/);
  const again = await bridge('POST', '/remote/v1/pair', { body: { code: pairCode, device_name: 'Thief' }, auth: false });
  assert.equal(again.statusCode, 401);
  assert.equal(again.json.code, 'pairing_failed');
});

test('LAN read-only: reads work, writes answer 403 lan_read_only until the owner enables LAN writes', async () => {
  const st = await bridge('GET', '/remote/v1/status');
  assert.equal(st.statusCode, 200);
  assert.equal(st.json.bridge_mode, 'lan');
  assert.equal(st.json.writes_allowed, false, 'the phone can grey out its write buttons');
  const prompt = await bridge('POST', '/remote/v1/prompt', { body: { project: PROJECT, text: 'refused over cleartext' } });
  assert.equal(prompt.statusCode, 403, JSON.stringify(prompt.json));
  assert.equal(prompt.json.code, 'lan_read_only');
  const on = await requestWithBody(port, '/api/remote/enable', { jsonBody: { mode: 'lan', address: '127.0.0.1', port: bridgePort, allow_lan_writes: true } });
  assert.equal(on.statusCode, 200, JSON.stringify(on.json));
  assert.equal(on.json.allow_lan_writes, true);
  assert.match(on.json.cleartext_warning, /cleartext/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'remote', 'settings.json'), 'utf8')).allow_lan_writes, true);
  const st2 = await request(port, '/api/remote');
  assert.equal(st2.json.allow_lan_writes, true);
  const st3 = await bridge('GET', '/remote/v1/status');
  assert.equal(st3.json.bridge_mode, 'lan');
  assert.equal(st3.json.writes_allowed, true);
});

test('auth: no token -> 401 auth_required, wrong token -> 401 auth_invalid, right token -> 200', async () => {
  const none = await bridge('GET', '/remote/v1/status', { auth: false });
  assert.equal(none.statusCode, 401);
  assert.equal(none.json.code, 'auth_required');
  const wrong = await bridge('GET', '/remote/v1/status', { headers: { authorization: 'Bearer frb_' + 'x'.repeat(43) } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json.code, 'auth_invalid');
  const good = await bridge('GET', '/remote/v1/status');
  assert.equal(good.statusCode, 200);
  assert.equal(good.json.device.id, deviceId);
  assert.ok(Array.isArray(good.json.projects));
  assert.ok(good.json.projects.some((p) => p.name === PROJECT));
  assert.ok(!JSON.stringify(good.json.projects).includes(PROJECT_ROOT.replace(/\\/g, '\\\\')), 'no file paths to the phone');
  assert.equal('apk' in good.json, false, 'the apk path is admin-only, never on the phone bridge');
  assert.ok(!good.body.includes('app-debug.apk'), 'no apk path anywhere in the phone status');
  assert.equal(typeof good.json.gateway.uptime_s, 'number');
  assert.ok('set-cookie' in good.headers === false, 'no cookies');
});

test('CORS: a foreign Origin is refused; a Capacitor origin is echoed without credentials; preflight works', async () => {
  const evil = await bridge('GET', '/remote/v1/status', { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.json.code, 'origin_refused');
  const cap = await bridge('GET', '/remote/v1/status', { headers: { origin: 'capacitor://localhost' } });
  assert.equal(cap.statusCode, 200);
  assert.equal(cap.headers['access-control-allow-origin'], 'capacitor://localhost');
  assert.equal(cap.headers['access-control-allow-credentials'], undefined);
  const pre = await bridge('OPTIONS', '/remote/v1/prompt', { auth: false, headers: { origin: 'https://localhost', 'access-control-request-method': 'POST' } });
  assert.equal(pre.statusCode, 204);
  assert.match(pre.headers['access-control-allow-headers'], /authorization/);
  const preEvil = await bridge('OPTIONS', '/remote/v1/prompt', { auth: false, headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(preEvil.statusCode, 403);
});

test('host guard: a request with a foreign Host header is refused with 421', async () => {
  const r = await bridge('GET', '/remote/v1/status', { headers: { host: 'evil.example:' + bridgePort } });
  assert.equal(r.statusCode, 421);
  assert.equal(r.json.code, 'wrong_host');
});

test('body limits: a body over 16 KB is 413, a non-JSON content type is 415, unknown fields are 400', async () => {
  const big = await bridge('POST', '/remote/v1/prompt', { rawBody: JSON.stringify({ project: PROJECT, text: 'x'.repeat(17 * 1024) }) });
  assert.equal(big.statusCode, 413);
  const form = await bridge('POST', '/remote/v1/prompt', { rawBody: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.statusCode, 415);
  const unknown = await bridge('POST', '/remote/v1/prompt', { body: { project: PROJECT, text: 'hi', admin: true } });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json.code, 'invalid_request');
});

test('inbox: pending asks (with their questions and project) and scribe items with actions', async () => {
  const conv = await requestWithBody(port, '/api/conversations', { jsonBody: { project: PROJECT } });
  const convId = conv.json.conversation.id;
  const { turnId } = appendUserTurn(convId, 'pick a color for the button', { mode: 'execute' });
  const ask = createAskRequest({ convId, turnId, questions: [{ question: 'Which color?', options: ['red', 'blue'] }] });
  assert.equal(ask.ok, true);
  scribeItems = [
    { rid: 'R-0018', status: 'done', class: 'new', title: 'T', quote: 'Q', created: 'c', updated: 'u', pid: 'P-1', evidence: null },
    { rid: 'R-0019', status: 'open', class: 'question', title: 'T2', quote: 'Q2', created: 'c', updated: 'u' },
    { rid: 'R-0020', status: 'planned', class: 'new', title: 'T3', quote: 'Q3', created: 'c', updated: 'u' },
  ];
  const r = await bridge('GET', '/remote/v1/inbox');
  assert.equal(r.statusCode, 200);
  const row = r.json.asks.find((a) => a.id === ask.id);
  assert.ok(row, 'the pending ask is listed');
  assert.equal(row.project, PROJECT);
  assert.equal(row.conversation_id, convId);
  assert.equal(row.questions[0].question, 'Which color?');
  assert.deepEqual(row.questions[0].options, ['red', 'blue']);
  assert.equal(row.dashboard_only, false);
  assert.equal(row.dashboard_only_reason, null);
  const sc = r.json.scribe.find((s) => s.project === PROJECT);
  assert.equal(sc.available, true);
  assert.deepEqual(sc.items.map((i) => [i.rid, i.actions]), [['R-0018', ['ack']], ['R-0019', ['answer']], ['R-0020', []]]);
  assert.equal(sc.items[0].pid, undefined, 'only the documented fields go to the phone');
  assert.equal(sc.items[0].done_evidence, null, 'contract 4.4: present, null without evidence');
  assert.equal(sc.items[1].defer_reason, null);
  const st = await bridge('GET', '/remote/v1/status');
  assert.equal(st.json.inbox_count, 1 + 2, '1 ask + 2 scribe items that need the owner (planned does not)');

  // ask-answer reuse: the same handler as the dashboard; the blocked agent gets the real answer
  const ans = await bridge('POST', '/remote/v1/asks/' + ask.id + '/answer', { body: { answers: [{ answer: 'blue' }] } });
  assert.equal(ans.statusCode, 200, JSON.stringify(ans.json));
  assert.deepEqual(ans.json, { ok: true, answered: true, id: ask.id });
  const outcome = await ask.promise;
  assert.deepEqual(outcome, { timed_out: false, answers: [{ question: 'Which color?', answer: 'blue' }] });
  const events = readConversation(convId).events.filter((e) => e.kind === 'ask_answered');
  assert.equal(events.length, 1, 'the dashboard handler appended its ask_answered event');
  const twice = await bridge('POST', '/remote/v1/asks/' + ask.id + '/answer', { body: { answers: [{ answer: 'red' }] } });
  assert.equal(twice.statusCode, 409);
});

test('dashboard-only asks: a bypass-mode turn or a hard-gate question is shown read-only and refused with 403 dashboard_only', async () => {
  const conv = await requestWithBody(port, '/api/conversations', { jsonBody: { project: PROJECT } });
  const convId = conv.json.conversation.id;
  const bypassTurn = appendUserTurn(convId, 'clean up the repo', { mode: 'bypass' }).turnId;
  const bypassAsk = createAskRequest({ convId, turnId: bypassTurn, questions: [{ question: 'Which color?', options: ['red', 'blue'] }] });
  const execTurn = appendUserTurn(convId, 'finish the release', { mode: 'execute' }).turnId;
  const gateAsk = createAskRequest({ convId, turnId: execTurn, questions: [{ question: 'Shall I push to origin main?', options: ['yes', 'no'] }] });
  const inbox = await bridge('GET', '/remote/v1/inbox');
  const rowB = inbox.json.asks.find((a) => a.id === bypassAsk.id);
  const rowG = inbox.json.asks.find((a) => a.id === gateAsk.id);
  assert.equal(rowB.dashboard_only, true);
  assert.equal(rowB.dashboard_only_reason, 'bypass_turn');
  assert.equal(rowG.dashboard_only, true);
  assert.equal(rowG.dashboard_only_reason, 'hard_gate');
  for (const a of [bypassAsk, gateAsk]) {
    const r = await bridge('POST', '/remote/v1/asks/' + a.id + '/answer', { body: { answers: [{ answer: 'yes' }] } });
    assert.equal(r.statusCode, 403, JSON.stringify(r.json));
    assert.equal(r.json.code, 'dashboard_only');
    assert.equal(getAskMeta(a.id).status, 'pending', 'the ask still waits for the dashboard');
  }
  // the dashboard itself can still answer it
  const dash = await requestWithBody(port, '/api/ask/' + gateAsk.id + '/answer', { jsonBody: { answers: [{ answer: 'no' }] } });
  assert.equal(dash.statusCode, 200, JSON.stringify(dash.json));
  const dash2 = await requestWithBody(port, '/api/ask/' + bypassAsk.id + '/answer', { jsonBody: { answers: [{ answer: 'red' }] } });
  assert.equal(dash2.statusCode, 200);
});

test('prompt: starts a turn in a new conversation through the dashboard send path; bypass mode is refused', async () => {
  const r = await bridge('POST', '/remote/v1/prompt', { body: { project: PROJECT, text: 'hello from the phone' } });
  assert.equal(r.statusCode, 202, JSON.stringify(r.json));
  assert.equal(r.json.conversation_created, true);
  assert.ok(r.json.turn_id);
  const conv = readConversation(r.json.conversation_id);
  assert.equal(conv.meta.project, PROJECT);
  assert.equal(conv.turns.find((t) => t.role === 'user').text, 'hello from the phone');
  const read = await bridge('GET', '/remote/v1/conversations/' + r.json.conversation_id);
  assert.equal(read.statusCode, 200);
  assert.equal(read.json.id, r.json.conversation_id);
  assert.equal(typeof read.json.running, 'boolean');
  const list = await bridge('GET', '/remote/v1/conversations?project=' + encodeURIComponent(PROJECT));
  assert.equal(list.statusCode, 200);
  assert.ok(list.json.conversations.some((c) => c.id === r.json.conversation_id));
  const bypass = await bridge('POST', '/remote/v1/prompt', { body: { project: PROJECT, text: 'x', mode: 'bypass' } });
  assert.equal(bypass.statusCode, 400);
  const dash = await bridge('POST', '/remote/v1/prompt', { body: { project: PROJECT, text: '-p evil' } });
  assert.equal(dash.statusCode, 400);
  const unknown = await bridge('POST', '/remote/v1/prompt', { body: { project: 'no-such-project-xyz', text: 'x' } });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json.code, 'unknown_project');
});

test('conversation read: running is true while a turn of that conversation executes, false after', async () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '800';
  try {
    const r = await bridge('POST', '/remote/v1/prompt', { body: { project: PROJECT, text: 'a slow mock turn' } });
    assert.equal(r.statusCode, 202, JSON.stringify(r.json));
    assert.equal(r.json.execution_started, true, JSON.stringify(r.json));
    const busy = await bridge('GET', '/remote/v1/conversations/' + r.json.conversation_id);
    assert.equal(busy.json.running, true);
    let done = null;
    for (let i = 0; i < 100; i++) {
      done = await bridge('GET', '/remote/v1/conversations/' + r.json.conversation_id);
      if (done.json.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(done.json.running, false, 'running clears when the turn ends');
  } finally { delete process.env.CC_EXEC_MOCK_DELAY_MS; }
});

// F8 (security review rv-autonomy-sec): over LAN (cleartext) a sniffed token must not turn into code that
// runs on the PC without a card. A turn sent from a phone on a LAN bridge gets no autonomy: even a routine
// card waits. The next turn sent from the dashboard in that conversation gets autonomy again.
test('LAN phone turn: no autonomy for its permission cards; the next dashboard turn has it again', async () => {
  const st = await bridge('GET', '/remote/v1/status');
  assert.equal(st.json.bridge_mode, 'lan');
  assert.equal(st.json.writes_allowed, true);
  const waitIdle = async (convId) => {
    for (let i = 0; i < 100; i++) {
      const c = await bridge('GET', '/remote/v1/conversations/' + convId);
      if (c.json.running === false) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('the mock turn did not end');
  };
  const r = await bridge('POST', '/remote/v1/prompt', { body: { project: PROJECT, text: 'run the tests from the phone' } });
  assert.equal(r.statusCode, 202, JSON.stringify(r.json));
  const convId = r.json.conversation_id;
  registerPermissionRun(convId, { cwd: PROJECT_ROOT });
  const fromPhone = createPermissionRequest({ convId, turnId: r.json.turn_id, toolName: 'Bash', input: { command: 'git status' } });
  assert.equal(fromPhone.ok, true, JSON.stringify(fromPhone));
  assert.equal(fromPhone.decision, undefined, 'a routine card of a LAN phone turn waits for the owner');
  answerPermission(fromPhone.id, 'deny');
  await waitIdle(convId);

  const dash = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'and now from the PC' } });
  assert.equal(dash.statusCode, 202, JSON.stringify(dash.json));
  registerPermissionRun(convId, { cwd: PROJECT_ROOT });
  const fromPc = createPermissionRequest({ convId, turnId: dash.json.turn_id, toolName: 'Bash', input: { command: 'git status' } });
  assert.equal(fromPc.ok, true, JSON.stringify(fromPc));
  assert.equal(fromPc.decision && fromPc.decision.behavior, 'allow', 'a dashboard turn keeps autonomy');
  await waitIdle(convId);
});

// M1 (security review rv-autonomy-sec-2): an ask answered from a phone over LAN feeds free text into the
// running turn. That conversation loses autonomy, so a sniffed device token cannot steer a turn into code
// that runs without a card.
test('LAN phone ask answer: the conversation loses autonomy for its next permission cards', async () => {
  const conv = await requestWithBody(port, '/api/conversations', { jsonBody: { project: PROJECT } });
  const convId = conv.json.conversation.id;
  const { turnId } = appendUserTurn(convId, 'pick a color for the button', { mode: 'execute' });
  registerPermissionRun(convId, { cwd: PROJECT_ROOT });
  const first = createPermissionRequest({ convId, turnId, toolName: 'Bash', input: { command: 'git status' } });
  assert.equal(first.decision && first.decision.behavior, 'allow', 'a turn started on the PC has autonomy');
  const ask = createAskRequest({ convId, turnId, questions: [{ question: 'Which color?', options: ['red', 'blue'] }] });
  const ans = await bridge('POST', '/remote/v1/asks/' + ask.id + '/answer', { body: { answers: [{ answer: 'blue' }] } });
  assert.equal(ans.statusCode, 200, JSON.stringify(ans.json));
  const second = createPermissionRequest({ convId, turnId, toolName: 'Bash', input: { command: 'git status' } });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.decision, undefined, 'after a LAN phone answer a routine card waits for the owner');
  answerPermission(second.id, 'deny');
});

test('scribe: ack is sent as a prompt "akkoord R-n" (never written to scribe state); wrong status 409, unknown 404', async () => {
  scribeItems = [
    { rid: 'R-0018', status: 'done', class: 'new', title: 'T', quote: 'Q', created: 'c', updated: 'u' },
    { rid: 'R-0019', status: 'open', class: 'question', title: 'T2', quote: 'Q2', created: 'c', updated: 'u' },
  ];
  const base = '/remote/v1/scribe/' + encodeURIComponent(PROJECT);
  const ack = await bridge('POST', base + '/R-0018/ack', { body: { note: 'looks good' } });
  assert.equal(ack.statusCode, 202, JSON.stringify(ack.json));
  assert.equal(ack.json.queued_as_prompt, true);
  assert.equal(ack.json.scribe_applied, false);
  const conv = readConversation(ack.json.conversation_id);
  assert.equal(conv.turns.find((t) => t.role === 'user').text, 'akkoord R-0018\nlooks good', 'contract 4.6; the real scribe judges it in remote-scribe-owner-text.test.mjs');
  assert.equal(conv.meta.title, 'Telefoon: akkoord R-0018 · ' + PROJECT, 'a phone ack is recognisable in Gesprekken');
  assert.equal(ack.json.conversation_created, true);
  const wrong = await bridge('POST', base + '/R-0019/ack', { body: {} });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json.code, 'wrong_status');
  const answer = await bridge('POST', base + '/R-0019/answer', { body: { text: 'blue' } });
  assert.equal(answer.statusCode, 202);
  const answerConv = readConversation(answer.json.conversation_id);
  assert.equal(answerConv.turns.find((t) => t.role === 'user').text, 'answer R-0019: blue');
  assert.equal(answerConv.meta.title, 'Telefoon: antwoord R-0019 · ' + PROJECT);
  const unknown = await bridge('POST', base + '/R-0099/ack', { body: {} });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json.code, 'unknown_item');
  const badRid = await bridge('POST', base + '/R-18x/ack', { body: {} });
  assert.equal(badRid.statusCode, 400);
});

test('inbox: only projects with a scribe are listed, and the scribe list is cached between polls', async () => {
  _configureRemoteLimitsForTests({ scribeCacheMs: 60_000 });
  try {
    const first = await bridge('GET', '/remote/v1/inbox');
    assert.ok(first.json.scribe.every((e) => e.available === true), 'projects without a scribe are left out');
    assert.equal(first.json.scribe_truncated, false);
    const before = scribeCalls;
    await bridge('GET', '/remote/v1/inbox');
    await bridge('GET', '/remote/v1/status');
    assert.equal(scribeCalls, before, 'no new scribe process within the cache window');
  } finally { _configureRemoteLimitsForTests({ scribeCacheMs: 0 }); }
});

test('registry failure: the phone gets one generic message, never the gateway\'s own registry text', async () => {
  const failing = path.join(dataDir, 'failing-forge-sync.cjs');
  fs.writeFileSync(failing, "process.stderr.write('C:\\\\Users\\\\someone\\\\secret-path boom'); process.exit(3);\n", 'utf8');
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-noroot-'));
  _setForgeSyncCjsForTests(failing);
  _setScanRootsForTests([emptyRoot]);
  _setInstalledProjectsFileForTests(path.join(emptyRoot, 'no-projects.json'));
  _resetProjectsCacheForTests();
  try {
    const r = await bridge('GET', '/remote/v1/conversations?project=' + encodeURIComponent(PROJECT));
    assert.equal(r.statusCode, 502, JSON.stringify(r.json));
    assert.equal(r.json.code, 'registry_error');
    assert.equal(r.json.error, 'the project list on the PC could not be read; try again in a moment');
    assert.ok(!/forge-sync|secret-path|scan root|log/i.test(r.json.error));
  } finally {
    _resetForgeSyncCjsForTests();
    _resetScanRootsForTests();
    _resetInstalledProjectsFileForTests();
    _resetProjectsCacheForTests();
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('rate limit: the per-device bucket answers 429 with Retry-After', async () => {
  _configureRemoteLimitsForTests({ deviceCapacity: 2, scribeCacheMs: 0 });
  try {
    await bridge('GET', '/remote/v1/status');
    await bridge('GET', '/remote/v1/status');
    const r = await bridge('GET', '/remote/v1/status');
    assert.equal(r.statusCode, 429);
    assert.equal(r.json.code, 'rate_limited');
    assert.ok(Number(r.headers['retry-after']) >= 1);
  } finally { _configureRemoteLimitsForTests({ scribeCacheMs: 0 }); }
});

test('revoke: a revoked device token gets 401 at once and is listed with revoked_at', async () => {
  const devs = await request(port, '/api/remote/devices');
  assert.equal(devs.statusCode, 200);
  assert.ok(devs.json.devices.some((d) => d.id === deviceId));
  assert.ok(!JSON.stringify(devs.json).includes('sha256'));
  const rv = await requestWithBody(port, '/api/remote/devices/' + deviceId + '/revoke', { jsonBody: {} });
  assert.equal(rv.statusCode, 200);
  const r = await bridge('GET', '/remote/v1/status');
  assert.equal(r.statusCode, 401);
  assert.equal(r.json.code, 'auth_invalid');
  const after = await request(port, '/api/remote/devices');
  assert.ok(after.json.devices.find((d) => d.id === deviceId).revoked_at);
});

test('lockout: 10 failed tokens from one IP lock it out, also for a valid token', async () => {
  _configureRemoteLimitsForTests({ scribeCacheMs: 0 });
  const p = await requestWithBody(port, '/api/remote/pairing', { jsonBody: {} });
  const paired = await bridge('POST', '/remote/v1/pair', { body: { code: p.json.code, device_name: 'Second' }, auth: false });
  assert.equal(paired.statusCode, 201);
  const good = paired.json.token;
  for (let i = 0; i < 10; i++) await bridge('GET', '/remote/v1/status', { headers: { authorization: 'Bearer nope' + i } });
  const r = await bridge('GET', '/remote/v1/status', { headers: { authorization: 'Bearer ' + good } });
  assert.equal(r.statusCode, 429);
  assert.equal(r.json.code, 'locked_out');
});

test('audit log: records pairing, auth failures, answers and prompts, without tokens, codes or prompt text', async () => {
  const text = fs.readFileSync(path.join(dataDir, 'remote', 'audit.jsonl'), 'utf8');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  const actions = new Set(lines.map((l) => l.action));
  for (const a of ['bridge_enabled', 'pairing_code_created', 'pair_ok', 'pair_failed', 'auth_failed', 'origin_refused', 'ask_answered', 'prompt_sent', 'scribe_ack_queued', 'device_revoked', 'rate_limited', 'locked_out', 'write_refused', 'ask_answer_refused']) {
    assert.ok(actions.has(a), 'missing audit action ' + a);
  }
  assert.ok(!text.includes(token), 'token leaked into the audit log');
  assert.ok(!text.includes(token.slice(4)), 'token body leaked');
  assert.ok(!text.includes(pairCode), 'pairing code leaked into the audit log');
  assert.ok(!text.includes('hello from the phone'), 'prompt text leaked into the audit log');
  assert.ok(!text.includes('Shall I push'), 'question text leaked into the audit log');
});

test('admin: disable stops the listener and keeps the devices', async () => {
  const r = await requestWithBody(port, '/api/remote/disable', { jsonBody: {} });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.running, false);
  await assert.rejects(bridge('GET', '/remote/v1/status'), /ECONNREFUSED/);
  const devs = await request(port, '/api/remote/devices');
  assert.ok(devs.json.devices.length >= 1);
});
