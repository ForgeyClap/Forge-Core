// Remote Bridge status: the read-only "waiting on a PC permission card" signal (run
// WP-ACK-FIX). GET /remote/v1/status gains waiting_permission per project
// (pending tool-permission requests the gateway holds for that project's conversations) and a
// `running` list of executing conversations, each with waiting_permission true|false. Since
// WP-AUTONOMY-GW the phone can answer a card once, with confirm (remote-permissions.test.mjs; contract
// section 6). Real bridge listener on 127.0.0.1, the gateway's
// own permission store and running map; conversations in a temp folder.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { PROJECT_ROOT } from '../src/paths.mjs';
import * as bridge from '../src/remote/bridge-server.mjs';
import { PHONE_ROUTES } from '../src/remote/phone-routes.mjs';
import { createPairing } from '../src/remote/pairing.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation } from '../src/conversations.mjs';
import { registerProviderRun, releaseProviderRun } from '../src/exec-lifecycle.mjs';
import {
  createPermissionRequest, answerPermission, listPendingPermissions, _resetPermissionStoreForTests,
} from '../src/permissions/store.mjs';

const PROJECT = path.basename(PROJECT_ROOT);
const AUTH = { authorization: 'Bearer frb_good' };
let convDir; let srv; let port;
const runs = []; // [convId, entry] of the fake running turns, released after each test

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...AUTH };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ statusCode: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function status() {
  const r = await call('GET', '/remote/v1/status');
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  return r.json;
}
const waitingOf = (st, name) => st.projects.find((p) => p.name === name).waiting_permission;
const runningOf = (st, convId) => st.running.find((r) => r.conversation_id === convId);

/** A conversation of PROJECT whose turn is running (the gateway's own running map, no child process). */
function runningConversation() {
  const convId = createConversation({ project: PROJECT }).id;
  const reg = registerProviderRun(convId, { turnId: 't-' + convId, requestId: 'r-' + convId, abort: () => {} });
  assert.equal(reg.ok, true, JSON.stringify(reg));
  runs.push([convId, reg.entry]);
  return convId;
}

function ask(convId) {
  const r = createPermissionRequest({ convId, turnId: 't-' + convId, requestId: 'r-' + convId, toolName: 'Bash', input: { command: 'node .claude/forge-bin/forge-scribe.cjs list' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.decision, undefined, 'a shell command is never pre-allowed');
  return r.id;
}

before(async () => {
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-perm-conv-'));
  _setConversationsDirForTests(convDir);
  _resetPermissionStoreForTests();
  port = await freePort();
  srv = bridge.createBridgeServer({
    address: '127.0.0.1', port, mode: 'tailscale',
    devices: { authenticate: (t) => (t === 'frb_good' ? { id: 'd1', name: 'Phone' } : null) },
    pairing: createPairing(),
    audit: { write: () => {} },
    limits: bridge.createLimits({ scribeCacheMs: 0 }),
    scribeRunner: async () => ({ available: false, items: [] }),
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
});

afterEach(() => {
  for (const [convId, entry] of runs.splice(0)) releaseProviderRun(convId, entry);
  _resetPermissionStoreForTests();
});

after(async () => {
  await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  _resetConversationsForTests();
  fs.rmSync(convDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test('status: every project has waiting_permission 0 and the running list says false while nothing waits', async () => {
  const a = runningConversation();
  const st = await status();
  assert.ok(st.projects.length > 0);
  for (const p of st.projects) assert.ok(Number.isInteger(p.waiting_permission) && p.waiting_permission >= 0, JSON.stringify(p));
  assert.equal(waitingOf(st, PROJECT), 0);
  assert.ok(Array.isArray(st.running));
  assert.deepEqual(runningOf(st, a), { conversation_id: a, project: PROJECT, waiting_permission: false });
});

test('status: pending permission requests are counted per project; each running conversation says whether its turn waits', async () => {
  const a = runningConversation();
  const b = runningConversation();
  const ids = [ask(a), ask(a)];
  let st = await status();
  assert.equal(waitingOf(st, PROJECT), 2, 'two requests wait in one conversation');
  assert.equal(runningOf(st, a).waiting_permission, true);
  assert.equal(runningOf(st, b).waiting_permission, false);
  ids.push(ask(b));
  st = await status();
  assert.equal(waitingOf(st, PROJECT), 3);
  assert.equal(runningOf(st, b).waiting_permission, true);
  for (const id of ids) assert.equal(answerPermission(id, 'allow').ok, true);
  st = await status();
  assert.equal(waitingOf(st, PROJECT), 0, 'answered on the PC: nothing waits');
  assert.equal(runningOf(st, a).waiting_permission, false);
  assert.equal(runningOf(st, b).waiting_permission, false);
});

test('status: a conversation whose turn ended leaves the running list; a request of an unknown conversation counts for no project', async () => {
  const a = runningConversation();
  const [convId, entry] = runs.pop();
  releaseProviderRun(convId, entry);
  ask('c-not-a-stored-conversation');
  const st = await status();
  assert.equal(runningOf(st, a), undefined);
  assert.equal(st.projects.reduce((n, p) => n + p.waiting_permission, 0), 0, 'absent or unknown counts as 0');
});

// WP-AUTONOMY-GW (owner decision R-0203) replaced "the phone can never answer": the bridge now has
// exactly two permission routes (list, answer once with confirm). Every other path stays unknown, and
// an answer without confirm leaves the card and the waiting turn as they were.
test('the bridge has exactly the two permission routes; other paths are 404 and an unconfirmed answer changes nothing', async () => {
  const permissionRoutes = PHONE_ROUTES.filter((r) => /permission/i.test(String(r.path))).map((r) => r.method + ' ' + String(r.path));
  assert.deepEqual(permissionRoutes, ['GET /remote/v1/permissions', 'POST /^\\/remote\\/v1\\/permissions\\/([^/]+)$/']);
  const a = runningConversation();
  const id = ask(a);
  for (const p of ['/remote/v1/permissions/' + id + '/answer', '/api/permissions/' + id + '/answer']) {
    const r = await call('POST', p, { behavior: 'allow' });
    assert.equal(r.statusCode, 404, p + ' ' + JSON.stringify(r.json));
  }
  const unconfirmed = await call('POST', '/remote/v1/permissions/' + id, { behavior: 'allow' });
  assert.equal(unconfirmed.statusCode, 400);
  assert.deepEqual(listPendingPermissions().map((x) => x.id), [id]);
  assert.equal(runningOf(await status(), a).waiting_permission, true);
});
