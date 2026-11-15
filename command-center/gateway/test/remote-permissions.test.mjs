// WP-AUTONOMY-GW: permission cards on the phone (contract section 6).
//   GET  /remote/v1/permissions        -> { ok, items: [...], autonomy: { <project>: bool } }
//   POST /remote/v1/permissions/:id    { behavior: 'allow'|'deny', confirm: true } -> 200 { answered: true }
// No allow_session from the phone; confirm:true is required; every answer is audited without the
// command text. Real bridge listener on 127.0.0.1, the gateway's own permission store, temp folders.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { PROJECT_ROOT } from '../src/paths.mjs';
import * as bridge from '../src/remote/bridge-server.mjs';
import { createPairing } from '../src/remote/pairing.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation } from '../src/conversations.mjs';
import {
  createPermissionRequest, listPendingPermissions, registerPermissionRun, waitForDecision, _resetPermissionStoreForTests,
} from '../src/permissions/store.mjs';
import { _setAutonomyDirForTests, setAutonomy } from '../src/permissions/autonomy.mjs';

const PROJECT = path.basename(PROJECT_ROOT);
const AUTH = { authorization: 'Bearer frb_good' };
let convDir; let autoDir; let srv; let port;
const audit = [];

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

function card(command) {
  const convId = createConversation({ project: PROJECT }).id;
  registerPermissionRun(convId, { cwd: PROJECT_ROOT });
  const r = createPermissionRequest({ convId, turnId: 't1', requestId: 'r1', toolName: 'Bash', input: { command } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.decision, undefined, 'no autonomy is wired in this process: every card waits');
  return { id: r.id, convId };
}

before(async () => {
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-perms-conv-'));
  autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-perms-auto-'));
  _setConversationsDirForTests(convDir);
  _setAutonomyDirForTests(autoDir);
  _resetPermissionStoreForTests();
  port = await freePort();
  srv = bridge.createBridgeServer({
    address: '127.0.0.1', port, mode: 'tailscale',
    devices: { authenticate: (t) => (t === 'frb_good' ? { id: 'd1', name: 'Phone' } : null) },
    pairing: createPairing(),
    audit: { write: (e) => audit.push(e) },
    limits: bridge.createLimits({ scribeCacheMs: 0 }),
    scribeRunner: async () => ({ available: false, items: [] }),
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
});

afterEach(() => {
  _resetPermissionStoreForTests();
  audit.length = 0;
});

after(async () => {
  await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  _setAutonomyDirForTests(null);
  _resetConversationsForTests();
  fs.rmSync(convDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(autoDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test('GET /remote/v1/permissions lists the pending cards in the contract shape, with the autonomy per project', async () => {
  const push = card('git push origin main');
  const longCmd = 'node "' + path.join(PROJECT_ROOT, 'tools', 'x.cjs') + '" ' + 'b'.repeat(400);
  const long = card(longCmd);
  setAutonomy(PROJECT, false);
  const r = await call('GET', '/remote/v1/permissions');
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.items.length, 2);
  const byId = new Map(r.json.items.map((i) => [i.id, i]));
  const p = byId.get(push.id);
  assert.deepEqual(Object.keys(p).sort(), ['command_preview', 'conversation_id', 'created_at', 'gate', 'id', 'project', 'summary_nl', 'tool_name']);
  assert.equal(p.project, PROJECT);
  assert.equal(p.conversation_id, push.convId);
  assert.equal(p.tool_name, 'Bash');
  assert.equal(p.command_preview, 'git push origin main');
  assert.match(p.gate, /git push/);
  const l = byId.get(long.id);
  assert.ok(l.command_preview.length <= 200);
  assert.ok(!l.command_preview.includes(PROJECT_ROOT), 'paths are shortened');
  assert.equal(r.json.autonomy[PROJECT], false);
});

test('POST without confirm:true, or with allow_session, is refused with 400 and changes nothing', async () => {
  const { id } = card('git push origin main');
  for (const body of [{ behavior: 'allow' }, { behavior: 'allow', confirm: false }, { behavior: 'allow', confirm: 'yes' }]) {
    const r = await call('POST', '/remote/v1/permissions/' + id, body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.json.code, 'confirm_required');
  }
  const session = await call('POST', '/remote/v1/permissions/' + id, { behavior: 'allow_session', confirm: true });
  assert.equal(session.statusCode, 400);
  assert.equal(session.json.code, 'invalid_request');
  assert.equal(listPendingPermissions().length, 1, 'the card still waits');
});

test('POST allow with confirm answers the card, the waiting run gets allow, a second answer is 409, and it is audited', async () => {
  const { id, convId } = card('git push origin main');
  const waiting = waitForDecision(id, 5000, { convId });
  const r = await call('POST', '/remote/v1/permissions/' + id, { behavior: 'allow', confirm: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  assert.equal(r.json.answered, true);
  assert.equal((await waiting).behavior, 'allow');
  assert.equal(listPendingPermissions().length, 0);

  const again = await call('POST', '/remote/v1/permissions/' + id, { behavior: 'deny', confirm: true });
  assert.equal(again.statusCode, 409);

  const entry = audit.find((e) => e.action === 'permission_answered');
  assert.ok(entry, JSON.stringify(audit));
  assert.equal(entry.device_id, 'd1');
  assert.deepEqual(entry.detail, { permission_id: id, behavior: 'allow', tool_name: 'Bash', project: PROJECT, ok: true });
  assert.ok(!JSON.stringify(audit).includes('origin main'), 'the command text is never audited');
});

test('POST deny with confirm gives the run a deny; an unknown id is 404', async () => {
  const { id, convId } = card('npm publish');
  const waiting = waitForDecision(id, 5000, { convId });
  const r = await call('POST', '/remote/v1/permissions/' + id, { behavior: 'deny', confirm: true });
  assert.equal(r.statusCode, 200);
  assert.equal((await waiting).behavior, 'deny');
  const unknown = await call('POST', '/remote/v1/permissions/perm-nope-00000000', { behavior: 'allow', confirm: true });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json.code, 'not_found');
});

// F8 / L3 (security review rv-autonomy-sec): LAN mode is cleartext, so a sniffed device token must not
// approve a hard gate. On a LAN bridge (even with LAN writes on) a hard-gate card answers 403
// dashboard_only, and its command preview is not sent; a card that is not a hard gate can still be answered.
test('LAN bridge: a hard-gate card is dashboard-only (403, no preview); a routine card can be answered', async (t) => {
  const lanPort = await freePort();
  const lan = bridge.createBridgeServer({
    address: '127.0.0.1', port: lanPort, mode: 'lan', allowLanWrites: true,
    devices: { authenticate: (tok) => (tok === 'frb_good' ? { id: 'd1', name: 'Phone' } : null) },
    pairing: createPairing(),
    audit: { write: (e) => audit.push(e) },
    limits: bridge.createLimits({ scribeCacheMs: 0 }),
    scribeRunner: async () => ({ available: false, items: [] }),
  });
  await new Promise((r) => lan.listen(lanPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => { lan.close(() => r()); lan.closeAllConnections(); }));
  const saved = port;
  port = lanPort;
  t.after(() => { port = saved; });

  const push = card('git push origin main');
  const routine = card('git status');
  const list = await call('GET', '/remote/v1/permissions');
  assert.equal(list.statusCode, 200, JSON.stringify(list.json));
  const byId = new Map(list.json.items.map((i) => [i.id, i]));
  assert.equal(byId.get(push.id).command_preview, null, 'no hard-gate command text over cleartext');
  assert.match(byId.get(push.id).gate, /git push/);
  assert.equal(byId.get(routine.id).command_preview, 'git status');

  const refused = await call('POST', '/remote/v1/permissions/' + push.id, { behavior: 'allow', confirm: true });
  assert.equal(refused.statusCode, 403, JSON.stringify(refused.json));
  assert.equal(refused.json.code, 'dashboard_only');
  assert.equal(listPendingPermissions().filter((c) => c.id === push.id).length, 1, 'the hard-gate card still waits for the PC');
  assert.ok(audit.some((e) => e.action === 'permission_answer_refused' && e.detail.reason === 'dashboard_only'));

  const ok = await call('POST', '/remote/v1/permissions/' + routine.id, { behavior: 'allow', confirm: true });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.json));
});
