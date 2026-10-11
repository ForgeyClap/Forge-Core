// sync-lock.mjs — the read-only maintenance-mode probe. Every fixture is a temp folder; nothing
// here ever writes a lock into a real project.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSyncLock, syncLockedBody, SYNC_LOCK_STALE_MS } from '../src/sync-lock.mjs';

const dirs = [];
function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sync-lock-'));
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
  dirs.push(d);
  return d;
}
const lockOf = (p) => path.join(p, '.claude', '.forge-sync.lock');
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('no lock -> not locked', () => {
  assert.equal(readSyncLock(project()).locked, false);
});

test('a fresh lock -> locked, with pid, batch id and start time', () => {
  const p = project();
  const now = Date.now();
  fs.writeFileSync(lockOf(p), JSON.stringify({ pid: 4242, batch_id: 'sync-1', started_at: new Date(now - 60000).toISOString() }));
  const l = readSyncLock(p, now);
  assert.equal(l.locked, true);
  assert.equal(l.pid, 4242);
  assert.equal(l.batchId, 'sync-1');
  assert.equal(l.ageMs, 60000);
});

test('a lock older than 6 h is ignored (fail-open)', () => {
  const p = project();
  fs.writeFileSync(lockOf(p), JSON.stringify({ pid: 1, ts: '2020-01-01T00:00:00.000Z' }));
  assert.equal(readSyncLock(p).locked, false);
  const started = Date.parse('2020-01-01T00:00:00.000Z');
  assert.equal(readSyncLock(p, started + SYNC_LOCK_STALE_MS - 1).locked, true);
  assert.equal(readSyncLock(p, started + SYNC_LOCK_STALE_MS).locked, false);
});

test('an unreadable lock body is judged by its file time; an unsafe batch id is dropped', () => {
  const p = project();
  fs.writeFileSync(lockOf(p), 'garbage');
  const l = readSyncLock(p);
  assert.equal(l.locked, true);
  assert.equal(l.startedAt, null);
  fs.writeFileSync(lockOf(p), JSON.stringify({ started_at: new Date().toISOString(), batch_id: '../x y' }));
  assert.equal(readSyncLock(p).batchId, null);
});

test('never throws on a junk path and never changes the lock', () => {
  assert.equal(readSyncLock(path.join(os.tmpdir(), 'does-not-exist-' + process.pid)).locked, false);
  assert.equal(readSyncLock(null).locked, false);
  const p = project();
  const body = JSON.stringify({ pid: 7, started_at: new Date().toISOString() });
  fs.writeFileSync(lockOf(p), body);
  readSyncLock(p);
  assert.equal(fs.readFileSync(lockOf(p), 'utf8'), body);
});

test('the 423 body is plain and token-free', () => {
  const b = syncLockedBody('demo', { ageMs: 120000, startedAt: '2026-10-10T00:00:00.000Z', batchId: 'sync-1', pid: 5 });
  assert.equal(b.ok, false);
  assert.equal(b.maintenance, true);
  assert.match(b.error, /being updated by forge-sync/);
  assert.match(b.error, /2 min ago/);
  assert.deepEqual(Object.keys(b.sync_lock).sort(), ['age_ms', 'batch_id', 'started_at']);
});
