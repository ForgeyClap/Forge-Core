// HTTP-level proof that the write routes into a registered project answer 423 while that project
// has a fresh .forge-sync.lock, and that reads keep working.
//
// The lock is simulated through sync-lock.mjs's test seam for THIS project only — a real lock file in this repo would
// put its own live hooks into maintenance mode. Every write here therefore stops at the 423 before any real write;
// the after() hook proves that with byte/listing checks on the real files. Executions are mocked (CC_EXEC_MOCK=1) and
// conversations go to a temp folder, so even a regression could not spawn a real `claude`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests } from '../src/conversation-store.mjs';
import { _setSyncLockProbeForTests } from '../src/sync-lock.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

process.env.CC_EXEC_MOCK = '1';
const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const REAL_FORGE_CONFIG = path.join(PROJECT_ROOT, '.claude', 'FORGE_CONFIG.json');
const REAL_MODEL_MAP = path.join(PROJECT_ROOT, '.claude', 'config', 'agents', 'agent-model-map.json');
const REAL_AGENTS_DIR = path.join(PROJECT_ROOT, '.claude', 'agents');

function fileDigest(f) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return 'absent'; }
}
function agentsDigest() {
  const h = crypto.createHash('sha256');
  for (const n of fs.readdirSync(REAL_AGENTS_DIR).sort()) { const p = path.join(REAL_AGENTS_DIR, n); if (fs.statSync(p).isFile()) { h.update(n); h.update(fs.readFileSync(p)); } }
  return h.digest('hex');
}

let server;
let port;
let convDir;
let realBefore;
const LOCKED = { locked: true, ageMs: 180000, pid: 4242, batchId: 'sync-test', startedAt: '2026-10-10T00:00:00.000Z' };
function lockThisProject() {
  _setSyncLockProbeForTests((p) => (path.resolve(p).toLowerCase() === path.resolve(PROJECT_ROOT).toLowerCase() ? LOCKED : { locked: false, ageMs: null, pid: null, batchId: null, startedAt: null }));
}

before(async () => {
  _resetProjectsCacheForTests();
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sync-lock-conv-'));
  _setConversationsDirForTests(convDir);
  realBefore = { config: fileDigest(REAL_FORGE_CONFIG), map: fileDigest(REAL_MODEL_MAP), agents: agentsDigest() };
  server = createServer();
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});

after(async () => {
  _setSyncLockProbeForTests();
  _setConversationsDirForTests(null);
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(convDir, { recursive: true, force: true });
  assert.equal(fileDigest(REAL_FORGE_CONFIG), realBefore.config, 'the real FORGE_CONFIG.json must be unchanged');
  assert.equal(fileDigest(REAL_MODEL_MAP), realBefore.map, 'the real agent-model-map.json must be unchanged');
  assert.equal(agentsDigest(), realBefore.agents, 'the real .claude/agents files must be unchanged');
});

test('PATCH agent model -> 423 with a plain maintenance message while the project is being synced', async () => {
  lockThisProject();
  try {
    const res = await requestWithBody(port, '/api/agents/boss/model?project=' + encodeURIComponent(THIS_PROJECT_NAME), { method: 'PATCH', jsonBody: { claudeTier: 'opus' } });
    assert.equal(res.statusCode, 423);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.maintenance, true);
    assert.match(res.json.error, /being updated by forge-sync/);
    assert.equal(res.json.sync_lock.batch_id, 'sync-test');
  } finally { _setSyncLockProbeForTests(); }
});

test('POST config -> 423 while locked; GET config (a read) still answers 200', async () => {
  lockThisProject();
  try {
    const res = await requestWithBody(port, '/api/config?project=' + encodeURIComponent(THIS_PROJECT_NAME), { method: 'POST', jsonBody: { action: 'set', key: 'tool-log', value: true } });
    assert.equal(res.statusCode, 423);
    assert.equal(res.json.maintenance, true);
    const read = await request(port, '/api/config?project=' + encodeURIComponent(THIS_PROJECT_NAME));
    assert.equal(read.statusCode, 200);
  } finally { _setSyncLockProbeForTests(); }
});

test('POST a chat message -> 423 while locked, and the user turn is NOT stored', async () => {
  const created = await requestWithBody(port, '/api/conversations', { method: 'POST', jsonBody: { project: THIS_PROJECT_NAME, title: 'sync-lock test' } });
  assert.equal(created.statusCode, 201);
  const convId = created.json.conversation.id;
  const turnsBefore = (await request(port, '/api/conversations/' + convId)).json;
  lockThisProject();
  try {
    const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { method: 'POST', jsonBody: { text: 'hello', mode: 'plan' } });
    assert.equal(res.statusCode, 423);
    assert.equal(res.json.maintenance, true);
  } finally { _setSyncLockProbeForTests(); }
  const turnsAfter = (await request(port, '/api/conversations/' + convId)).json;
  assert.deepEqual(turnsAfter, turnsBefore, 'a refused message must leave the conversation unchanged');
});

test('without a lock the same PATCH is not refused with 423 (it reaches its own validation)', async () => {
  const res = await requestWithBody(port, '/api/agents/boss/model?project=' + encodeURIComponent(THIS_PROJECT_NAME), { method: 'PATCH', jsonBody: { claudeTier: 'not-a-tier' } });
  assert.notEqual(res.statusCode, 423);
  assert.equal(res.statusCode, 400);
});
