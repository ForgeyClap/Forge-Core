// tests for GET /api/account-rotation (account-rotation.mjs). Every test points the rotator's own
// env seam FORGE_ACCOUNT_ROTATOR_HOME at a fresh temp folder, so the real ~/.claude is never read. The
// fixtures deliberately include token-shaped decoys (a vault slot file, extra fields in the notification)
// to prove that only the allowlisted, token-free fields ever reach the response and that no slot or
// credentials file is ever opened.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAccountRotation, ROTATOR_HOME_ENV, DEFAULT_THRESHOLD } from '../src/account-rotation.mjs';
import { createServer } from '../src/server.mjs';
import { request } from '../test-support/helpers.mjs';

const DECOY_TOKEN = 'sk-ant-oat01-' + 'Z'.repeat(60);
const temps = [];
let home;
let server;
let port;
const prevEnv = process.env[ROTATOR_HOME_ENV];

function writeJson(rel, obj) {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

const NOTIFY = {
  version: 1, updatedAt: '2026-10-09T20:00:00.000Z', mode: 'token', active: 'work', threshold: 92,
  notice: 'RECOMMENDATION — work reached the threshold; start a new session with personal',
  lastResult: { action: 'recommend', reason: null, at: '2026-10-09T20:00:00.000Z' },
  recommendation: { name: 'personal', why: 'clear 31%', tier: 'clear', from: 'work', at: '2026-10-09T20:00:00.000Z', trigger: [{ label: 'session', pct: 94 }], launch: 'node ...' },
  lastSwitch: { from: 'personal', to: 'work', at: '2026-10-08T09:00:00.000Z', reason: 'threshold', outcome: 'verified' },
  disabled: false, pendingVerify: null,
  accounts: [
    { name: 'work', mode: 'token', status: 'live', maxPct: 94, usable: false, needsRelogin: false, measuredAt: '2026-10-09T19:59:00.000Z',
      windows: [{ label: 'session', pct: 94, resetsAt: '2026-10-09T23:00:00.000Z' }, { label: 'weekly (all)', pct: 61, resetsAt: '2026-10-13T00:00:00.000Z' }],
      accessToken: DECOY_TOKEN },
    { name: 'personal', mode: 'token', status: 'estimated', maxPct: 31, usable: true, measuredAt: '2026-10-09T15:00:00.000Z',
      windows: [{ label: 'session', pct: 12 }, { label: 'weekly (all)', pct: 31 }] },
    { name: 'spare', mode: 'token', status: 'unmeasurable', maxPct: null, usable: null, windows: [] },
  ],
  token: DECOY_TOKEN,
};

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rotator-home-'));
  temps.push(home);
  process.env[ROTATOR_HOME_ENV] = home;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (prevEnv === undefined) delete process.env[ROTATOR_HOME_ENV]; else process.env[ROTATOR_HOME_ENV] = prevEnv;
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

test('no rotator files -> "rotator not set up", never a fabricated account or percentage', () => {
  const r = buildAccountRotation();
  assert.equal(r.ok, true);
  assert.equal(r.provenance, 'NOT SET UP');
  assert.equal(r.note, 'rotator not set up');
  assert.deepEqual(r.accounts, []);
  assert.equal(r.active, null);
  assert.equal(r.recommendation, null);
  assert.equal(r.threshold, DEFAULT_THRESHOLD);
  assert.equal(r.threshold_source, 'default');
});

test('reads labels, percentages, statuses, recommendation and last switch from the notification', () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', NOTIFY);
  const r = buildAccountRotation();
  assert.equal(r.provenance, 'REPORTED');
  assert.equal(r.active, 'work');
  assert.equal(r.threshold, 92);
  assert.equal(r.threshold_source, 'rotator');
  assert.deepEqual(r.accounts.map((a) => [a.name, a.status, a.max_pct]), [['work', 'live', 94], ['personal', 'estimated', 31], ['spare', 'unmeasurable', null]]);
  assert.deepEqual(r.accounts[0].windows[0], { label: 'session', pct: 94, resets_at: '2026-10-09T23:00:00.000Z' });
  assert.equal(r.recommendation.to, 'personal');
  assert.equal(r.recommendation.from, 'work');
  assert.deepEqual(r.recommendation.trigger, [{ label: 'session', pct: 94 }]);
  assert.equal(r.last_switch.reason, 'threshold');
  assert.equal(r.last_switch.at, '2026-10-08T09:00:00.000Z');
});

test('SECURITY: token-shaped fields in the notification are never forwarded (allowlist)', () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', NOTIFY);
  const out = JSON.stringify(buildAccountRotation());
  assert.ok(!out.includes(DECOY_TOKEN), 'a token must never reach the response');
  assert.ok(!out.includes('accessToken'));
  assert.ok(!out.includes('"launch"'));
});

test('SECURITY: only the two token-free files are opened — never a vault slot, state, txn or credentials file', () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', NOTIFY);
  writeJson('forge-accounts/handoff.json', { version: 2, phase: 'recommend', from: 'work', to: 'personal', reason: 'threshold', kind: 'token', at: '2026-10-09T20:00:00.000Z', trigger: [{ label: 'session', pct: 94 }] });
  writeJson('forge-accounts/work.json', { credentials: { claudeAiOauth: { accessToken: DECOY_TOKEN } } });
  writeJson('forge-accounts/state.json', { secret: DECOY_TOKEN });
  writeJson('.credentials.json', { claudeAiOauth: { accessToken: DECOY_TOKEN } });
  const opened = [];
  const realRead = fs.readFileSync;
  fs.readFileSync = function spy(file, ...rest) { opened.push(path.resolve(String(file))); return realRead.call(fs, file, ...rest); };
  let r;
  try { r = buildAccountRotation(); } finally { fs.readFileSync = realRead; }
  assert.deepEqual(opened.sort(), [path.join(home, 'FORGE_ACCOUNT_ROTATION.json'), path.join(home, 'forge-accounts', 'handoff.json')].sort());
  assert.ok(!JSON.stringify(r).includes(DECOY_TOKEN));
  // the notification file is authoritative: the handoff is read but never revives a recommendation
  assert.equal(r.handoff_recommendation, null);
});

test('handoff.json is only used in phase "recommend"', () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', NOTIFY);
  writeJson('forge-accounts/handoff.json', { phase: 'switching', from: 'work', to: 'personal' });
  assert.equal(buildAccountRotation().handoff_recommendation, null);
});

test('a recommendation the rotator has CLEARED is not revived from a stale handoff.json', () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', { ...NOTIFY, recommendation: null });
  writeJson('forge-accounts/handoff.json', { phase: 'recommend', from: 'work', to: 'personal', at: '2026-10-09T20:00:00.000Z' });
  const r = buildAccountRotation();
  assert.equal(r.recommendation, null);
  assert.equal(r.handoff_recommendation, null);
});

test('an UNREADABLE notification file does not let a leftover handoff stand in for it', () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', '{ broken');
  writeJson('forge-accounts/handoff.json', { phase: 'recommend', from: 'work', to: 'personal', at: '2026-10-09T20:00:00.000Z' });
  const r = buildAccountRotation();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.equal(r.handoff_recommendation, null);
});

test('a handoff recommendation is shown even before the notification file exists', () => {
  writeJson('forge-accounts/handoff.json', { phase: 'recommend', from: 'work', to: 'personal', at: '2026-10-09T20:00:00.000Z' });
  const r = buildAccountRotation();
  assert.equal(r.provenance, 'NOT SET UP');
  assert.equal(r.handoff_recommendation.to, 'personal');
});

test('an unreadable notification file is UNREADABLE, never a crash', () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', '{ broken');
  const r = buildAccountRotation();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.deepEqual(r.accounts, []);
});

test('unknown statuses fall back to "unknown" and non-numeric percentages stay null (never 0)', () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', { accounts: [{ name: 'x', status: 'great', maxPct: '50', windows: [{ label: 'session', pct: 'n/a' }] }] });
  const r = buildAccountRotation();
  assert.equal(r.accounts[0].status, 'unknown');
  assert.equal(r.accounts[0].max_pct, null);
  assert.equal(r.accounts[0].windows[0].pct, null);
  assert.equal(r.threshold_source, 'default');
});

test('HTTP: GET /api/account-rotation serves the same view', async () => {
  writeJson('FORGE_ACCOUNT_ROTATION.json', NOTIFY);
  const res = await request(port, '/api/account-rotation');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.active, 'work');
  assert.equal(res.json.recommendation.to, 'personal');
  assert.ok(!res.body.includes(DECOY_TOKEN));
});
