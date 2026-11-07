#!/usr/bin/env node
'use strict';
/**
 * usage-guard-status.test.cjs — SA-P1-USAGE (PHASE2-PLAN A1): `usage-guard status` reads REAL usage but used to write
 * only FORGE_USAGE_PRESSURE.json, so FORGE_USAGE_GUARD_STATE.json kept a 22-day-old failed check and the lane budget
 * said "usage onbekend". status now persists percents + lastCheckAt — but only for an ok-mode state of the SAME account,
 * never over a pause (forge-autonomy judges a stale pause by lastCheckAt) and never refreshing the watcher heartbeat.
 * Isolated: FORGE_USAGE_GUARD_HOME is a fresh temp folder set before require. Run: node --test usage-guard-status.test.cjs
 */
const { test: nodeTest, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// the "N passed, M failed" tally the doctor's test check reads (node:test alone prints none)
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ug-status-'));
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });
Object.assign(process.env, {
  FORGE_USAGE_GUARD_HOME: HOME, FORGE_USAGE_GUARD_DENY_NETWORK: '1',
  FORGE_USAGE_GUARD_IDENTITY: path.join(HOME, 'no-profile.json'), FORGE_USAGE_GUARD_ACCOUNT_MAP: path.join(HOME, 'map.json'),
});
delete process.env.FORGE_USAGE_GUARD_STATE;
const ST = require('./usage-guard-status.cjs');
const guard = require('./usage-guard.cjs');
const lb = require('./forge-lane-budget.cjs');

const NOW_ISO = '2026-11-04T21:30:00.000Z';
const U = { session: { pct: 12, resetsAt: null }, week: { pct: 60, resetsAt: null } };
const SAME = { fp: 'account-1-8fdc82', source: 'account-uuid' };
const OLD = { mode: 'ok', account: { fp: 'account-1-8fdc82' }, percents: { session: 7, week: 92 }, lastCheckAt: '2026-10-14T05:29:36.307Z', lastError: 'usage endpoint HTTP 429', heartbeatAt: '2026-10-14T05:29:36.308Z', pauseAt: 99 };

test('transform: ok-mode same account -> fresh percents + lastCheckAt, failed-check error cleared, rest kept', () => {
  const next = ST.statusPersistTransform(OLD, U, SAME, NOW_ISO, guard.detectAccountSwitch);
  assert.deepEqual(next.percents, { session: 12, week: 60 });
  assert.equal(next.lastCheckAt, NOW_ISO);
  assert.equal(next.lastError, undefined);
  assert.equal(next.pauseAt, 99);
  assert.equal(next.heartbeatAt, OLD.heartbeatAt, 'status is not the watcher: its heartbeat is not touched');
  assert.equal(OLD.lastError, 'usage endpoint HTTP 429', 'the input object is never mutated');
});

test('transform: refuses a paused / corrupt state, another account, or a reading without any number', () => {
  const sw = guard.detectAccountSwitch;
  assert.equal(ST.statusPersistTransform(Object.assign({}, OLD, { mode: 'paused' }), U, SAME, NOW_ISO, sw), null);
  assert.equal(ST.statusPersistTransform({ mode: 'corrupt' }, U, SAME, NOW_ISO, sw), null);
  assert.equal(ST.statusPersistTransform(OLD, U, { fp: 'account-2-4e461c', source: 'account-uuid' }, NOW_ISO, sw), null);
  assert.equal(ST.statusPersistTransform(OLD, { session: { pct: NaN }, week: { pct: NaN } }, SAME, NOW_ISO, sw), null);
  assert.equal(ST.statusPersistTransform(null, U, SAME, NOW_ISO, sw), null);
});

test('transform: a non-measurement lastError (a partial resume) is kept; a NaN side is stored as null', () => {
  const st = Object.assign({}, OLD, { lastError: 'resume gedeeltelijk: 1/2 agents hervat' });
  const next = ST.statusPersistTransform(st, { session: { pct: NaN }, week: { pct: 40 } }, SAME, NOW_ISO, guard.detectAccountSwitch);
  assert.equal(next.lastError, 'resume gedeeltelijk: 1/2 agents hervat');
  assert.deepEqual(next.percents, { session: null, week: 40 });
});

test('RED A1: persistStatusReading writes the real state file; the lane budget then trusts it', async () => {
  const file = path.join(HOME, 'FORGE_USAGE_GUARD_STATE.json');
  fs.writeFileSync(file, JSON.stringify(OLD));
  const r = await guard.persistStatusReading(U, SAME);
  assert.equal(r.written, true);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.percents, { session: 12, week: 60 });
  assert.equal(disk.heartbeatAt, OLD.heartbeatAt, 'a dead watcher must not look alive because status ran');
  assert.equal(disk.account.fp, 'account-1-8fdc82');
  const u = lb.readUsage({ stateFile: file, now: Date.parse(disk.lastCheckAt) + 60000 });
  assert.equal(u.stale, false);
  assert.equal(u.week.pct, 60);
});

test('persistStatusReading: a paused state on disk is left byte-identical', async () => {
  const file = path.join(HOME, 'FORGE_USAGE_GUARD_STATE.json');
  const raw = JSON.stringify(Object.assign({}, OLD, { mode: 'paused' }));
  fs.writeFileSync(file, raw);
  const r = await guard.persistStatusReading(U, SAME);
  assert.equal(r.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('writeStateTo keepHeartbeat: keeps the stored heartbeat; default still stamps a new one', () => {
  const file = path.join(HOME, 'hb.json');
  const kept = guard.writeStateTo(file, { mode: 'ok', heartbeatAt: '2020-01-01T00:00:00.000Z' }, null, { keepHeartbeat: true });
  assert.equal(kept.heartbeatAt, '2020-01-01T00:00:00.000Z');
  const stamped = guard.writeStateTo(file, { mode: 'ok', heartbeatAt: '2020-01-01T00:00:00.000Z' });
  assert.notEqual(stamped.heartbeatAt, '2020-01-01T00:00:00.000Z');
});
