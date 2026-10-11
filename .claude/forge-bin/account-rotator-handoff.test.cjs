#!/usr/bin/env node
'use strict';
// account-rotator-handoff.test.cjs — the SAVE -> SWITCH -> CONTINUE handoff against the REAL usage-guard.cjs
// (a fresh module instance per fixture, every FORGE_USAGE_GUARD_* path in a temp dir), with Paperclip stubbed through
// global.fetch and the usage endpoint stubbed per token (deps.fetch).
// FAKE logins only; the real ~/.claude, ~/.claude.json, Paperclip and api.anthropic.com are never touched:
// global.fetch is DEFAULT-DENY from the very first line below (before any module loads), PAPERCLIP_URL points at a
// non-routable .invalid host, and the per-test Paperclip stub answers that host only — anything else throws.
const REAL_FETCH = global.fetch;
const DENIED = [];
global.fetch = async (url) => { DENIED.push(String(url)); throw new Error('network denied by account-rotator-handoff.test.cjs (default-deny): ' + String(url)); };
const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-rot-handoff-'));
process.env.FORGE_CONFIG_HOME = path.join(ROOT, 'cfg-home');
process.env.FORGE_PROJECT_ROOT = path.join(ROOT, 'cfg-proj');
process.env.FORGE_USAGE_GUARD_HOME = path.join(ROOT, 'guard-trap', '.claude');
process.env.FORGE_ACCOUNT_ROTATOR_HOME = path.join(ROOT, 'rot-trap', '.claude');
const PC_HOST = 'paperclip.invalid';
process.env.PAPERCLIP_URL = 'http://' + PC_HOST + ':3100';
delete process.env.FORGE_USAGE_GUARD_DENY_NETWORK;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const vault = require('./account-rotator-vault.cjs');
const R = require('./account-rotator.cjs');
const GUARD_PATH = require.resolve('./usage-guard.cjs');

let passed = 0; let failed = 0;
function t(name, fn) { test(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { global.fetch = REAL_FETCH; console.log(passed + ' passed, ' + failed + ' failed'); });

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const rnd = () => crypto.randomBytes(10).toString('hex');
const SECRETS = new Set();
function fakeAccount(n, opts) {
  const a = { name: n, uuid: 'uuid-' + n + '-' + rnd(), email: n + '@example.com', at: 'FAKE-AT-' + n + '-' + rnd(), rt: 'FAKE-RT-' + n + '-' + rnd(),
    expiresAt: opts && opts.expired ? NOW - 3600e3 : NOW + 6 * 3600e3 };
  SECRETS.add(a.at); SECRETS.add(a.rt);
  return a;
}
function resp(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function fixture() {
  const root = fs.mkdtempSync(path.join(ROOT, 'fx-'));
  const home = path.join(root, '.claude');
  fs.mkdirSync(home, { recursive: true });
  const env = Object.assign({}, process.env, { FORGE_ACCOUNT_ROTATOR_HOME: home, FORGE_ACCOUNT_ROTATOR_PROFILE: path.join(root, '.claude.json'), FORGE_USAGE_GUARD_HOME: home });
  return { root, home, env, P: vault.paths(env), stateFile: path.join(home, 'FORGE_USAGE_GUARD_STATE.json'), journal: path.join(home, 'forge-usage-guard-paused.jsonl') };
}
/** freshGuard(fx) — a NEW usage-guard.cjs module instance whose every path derives from this fixture's temp HOME. */
function freshGuard(fx) {
  for (const k of ['FORGE_USAGE_GUARD_STATE', 'FORGE_USAGE_PRESSURE_FILE', 'FORGE_USAGE_GUARD_PID', 'FORGE_USAGE_GUARD_LOG', 'FORGE_USAGE_GUARD_JOURNAL',
    'FORGE_USAGE_GUARD_ACCOUNT_MAP', 'FORGE_USAGE_GUARD_IDENTITY']) delete process.env[k];
  process.env.FORGE_USAGE_GUARD_HOME = fx.home;
  delete require.cache[GUARD_PATH];
  const g = require(GUARD_PATH);
  g.__setOwnerGrantRootForTests(fx.root);
  return g;
}
function login(fx, a) {
  fs.writeFileSync(fx.P.creds, JSON.stringify({ claudeAiOauth: { accessToken: a.at, refreshToken: a.rt, expiresAt: a.expiresAt, scopes: ['user:inference', 'user:profile'] } }));
  fs.writeFileSync(fx.P.profile, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: a.uuid, emailAddress: a.email, organizationUuid: 'org-' + a.name } }, null, 2) + '\n');
}
function enroll(fx, a) {
  login(fx, a);
  vault.writeSlot(fx.P, { name: a.name, credentials: { claudeAiOauth: { accessToken: a.at, refreshToken: a.rt, expiresAt: a.expiresAt, scopes: ['user:inference', 'user:profile'] } },
    oauthAccount: { accountUuid: a.uuid, emailAddress: a.email, organizationUuid: 'org-' + a.name }, enrolledAt: iso(NOW) });
}
function usage(session, week) {
  const sr = iso(NOW + 2 * 3600e3); const wr = iso(NOW + 3 * 86400e3);
  return { limits: [{ kind: 'session', group: 'session', percent: session, resets_at: sr }, { kind: 'weekly_all', group: 'weekly', percent: week, resets_at: wr }], five_hour: { utilization: session, resets_at: sr }, seven_day: { utilization: week, resets_at: wr } };
}
function usageFetch(map) { return async (url, init) => { const tok = String(init.headers.authorization).replace(/^Bearer /, ''); const b = map[tok]; return b ? resp(200, b) : resp(401, {}); }; }
/** paperclip(opts) — loopback Paperclip stub on global.fetch: a1/a3 running, a2 paused by a HUMAN. */
function paperclip(opts) {
  const o = opts || {};
  const agents = new Map([['a1', { id: 'a1', name: 'agent-1', status: 'running' }], ['a2', { id: 'a2', name: 'human-paused', status: 'paused' }], ['a3', { id: 'a3', name: 'agent-3', status: 'running' }]]);
  const calls = [];
  global.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname !== PC_HOST || u.port !== '3100') throw new Error('unexpected network target in a hermetic test: ' + u.hostname);
    const method = (init && init.method) || 'GET';
    calls.push(method + ' ' + u.pathname);
    if (u.pathname === '/api/companies') return resp(200, [{ id: 'c1', name: 'co' }]);
    if (u.pathname === '/api/companies/c1/agents') return resp(200, [...agents.values()].map((a) => Object.assign({}, a)));
    const m = /^\/api\/agents\/([^/]+)\/(pause|resume)$/.exec(u.pathname);
    if (m) {
      if (o.fail && o.fail(m[1], m[2])) return resp(500, {});
      const a = agents.get(m[1]);
      if (!a) return resp(404, {});
      a.status = m[2] === 'pause' ? 'paused' : 'running';
      return resp(200, {});
    }
    return resp(404, {});
  };
  return { agents, calls };
}
function journal(fx) { try { return fs.readFileSync(fx.journal, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
function gstate(fx) { return JSON.parse(fs.readFileSync(fx.stateFile, 'utf8')); }
function S() { return R.resolveSettings(['--mode', 'file'], {}); } // the handoff exists only in FILE mode (experimental, explicit opt-in)
const LOGS = [];
function deps(g, fetch, extra) { return Object.assign({ now: () => NOW, quiet: true, guard: g, fetch, settleMs: 0 }, extra || {}); }
function guardTickDeps(g, u, glog) {
  return { fetchUsage: async () => ({ session: { pct: u.five_hour.utilization, resetsAt: u.five_hour.resets_at }, week: { pct: u.seven_day.utilization, resetsAt: u.seven_day.resets_at },
    windows: g.normalizeWindows(u), credits: { present: false }, credentialFp: null }),
  readCredentialSnapshot: () => ({ generation: null, credentialFp: null }), writePressureFile: () => {}, log: (m) => glog.push(m) };
}

t('L: this suite is network-tight — default-deny fetch before any stub, PAPERCLIP_URL neutralised to a .invalid host', async () => {
  await assert.rejects(() => global.fetch('https://api.anthropic.com/api/oauth/usage'), /default-deny/);
  await assert.rejects(() => global.fetch('http://127.0.0.1:3100/api/companies'), /default-deny/);
  assert.strictEqual(DENIED.length, 2, 'only the two probes above were ever attempted before a stub: ' + DENIED.join(', '));
  assert.ok(/\.invalid:3100$/.test(process.env.PAPERCLIP_URL));
});
t('SAVE: handoff.json + pause notice + paused agents are on disk BEFORE the swap writes anything', async () => {
  const fx = fixture(); const a = fakeAccount('ha'); const b = fakeAccount('hb');
  enroll(fx, b); enroll(fx, a);
  const g = freshGuard(fx);
  const pc = paperclip();
  fs.writeFileSync(fx.stateFile, JSON.stringify({ mode: 'ok', account: { fp: g.readAccountIdentity().fp } }));
  let seen = null;
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(g, usageFetch({ [a.at]: usage(93, 20), [b.at]: usage(10, 10) }), { swapHooks: { afterCredsWrite: () => {
    seen = { handoff: JSON.parse(fs.readFileSync(fx.P.handoff, 'utf8')), state: gstate(fx), agents: [...pc.agents.values()].map((x) => x.id + ':' + x.status) };
  } } }) });
  assert.strictEqual(r.action, 'switched', JSON.stringify(r));
  assert.ok(seen, 'the swap ran');
  assert.strictEqual(seen.handoff.phase, 'switching');
  assert.deepStrictEqual([seen.handoff.from, seen.handoff.to], ['ha', 'hb']);
  assert.ok(seen.handoff.trigger[0].label === 'session' && seen.handoff.trigger[0].pct === 93);
  assert.ok(Date.parse(seen.handoff.resumeAt) > Date.parse(seen.handoff.at));
  assert.ok(seen.handoff.pauseId && seen.handoff.pausedAgents.length === 2);
  assert.strictEqual(seen.state.mode, 'paused');
  assert.ok(/ACCOUNT ROTATOR/.test(seen.state.notice) && /ha -> hb/.test(seen.state.notice));
  assert.strictEqual(seen.state.account, undefined, 'unstamped: the current session hook delivers it');
  assert.ok(Number.isFinite(seen.state.resumeAtEpoch), 'self-heal epoch set in case the rotator dies mid-swap');
  assert.deepStrictEqual(seen.agents.sort(), ['a1:paused', 'a2:paused', 'a3:paused']);
});
t('journal: rotator pauses use the guard\'s record format (pause-intent -> paused, one pauseId) and resolve on resume; a human-paused agent is never touched', async () => {
  const fx = fixture(); const a = fakeAccount('ja'); const b = fakeAccount('jb');
  enroll(fx, b); enroll(fx, a);
  const g = freshGuard(fx);
  const pc = paperclip();
  await R.tick({ P: fx.P, S: S(), deps: deps(g, usageFetch({ [a.at]: usage(95, 20), [b.at]: usage(10, 10) })) });
  const j = journal(fx);
  const ids = new Set(j.map((x) => x.pauseId).filter(Boolean));
  assert.strictEqual(ids.size, 1);
  for (const id of ['a1', 'a3']) {
    assert.deepStrictEqual(j.filter((x) => x.agentId === id).map((x) => x.action), ['pause-intent', 'paused', 'resumed']);
  }
  assert.ok(!j.some((x) => x.agentId === 'a2'), 'human-paused agent never journaled');
  assert.deepStrictEqual(g.unresolvedPausedAgents(), []);
  assert.deepStrictEqual([...pc.agents.values()].map((x) => x.status), ['running', 'paused', 'running']);
  assert.ok(!pc.calls.includes('POST /api/agents/a2/resume') && !pc.calls.includes('POST /api/agents/a2/pause'));
});
t('CONTINUE: after a verified swap the guard state carries the CONTINUE notice and none of the previous account\'s facts', async () => {
  const fx = fixture(); const a = fakeAccount('ca'); const b = fakeAccount('cb');
  enroll(fx, b); enroll(fx, a);
  const g = freshGuard(fx);
  paperclip();
  fs.writeFileSync(fx.stateFile, JSON.stringify({ mode: 'ok', account: { fp: g.readAccountIdentity().fp }, ownerOverride: { active: true }, credits: { used: 1 }, percents: { session: 93, week: 20 }, pauseAt: 98 }));
  const labelA = g.readAccountIdentity().fp;
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(g, usageFetch({ [a.at]: usage(93, 20), [b.at]: usage(10, 10) })) });
  assert.strictEqual(r.action, 'switched');
  const st = gstate(fx);
  assert.strictEqual(st.mode, 'ok');
  assert.strictEqual(st.pendingCheckup, true);
  assert.ok(Date.parse(st.lastResumeAt) > 0);
  assert.ok(/account switched ca -> cb/.test(st.resumeNotice) && /CONTINUE/.test(st.resumeNotice) && /MANDATORY CHECKUP/.test(st.resumeNotice), st.resumeNotice);
  for (const k of ['account', 'ownerOverride', 'credits', 'notice', 'resumeAtEpoch', 'pausedAgents', 'trigger']) assert.strictEqual(st[k], undefined, k + ' must not carry over');
  assert.strictEqual(st.previousAccount.fp, labelA);
  assert.strictEqual(st.pauseAt, 98, 'guard thresholds carried');
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.P.handoff, 'utf8')).phase, 'continued');
});
t('ROLLBACK: a failed + rolled-back swap leaves NO notice stuck in pause, restores the stamp, resumes the agents', async () => {
  const fx = fixture(); const a = fakeAccount('ra'); const b = fakeAccount('rb');
  enroll(fx, b); enroll(fx, a);
  const g = freshGuard(fx);
  const pc = paperclip();
  const labelA = g.readAccountIdentity().fp;
  fs.writeFileSync(fx.stateFile, JSON.stringify({ mode: 'ok', account: { fp: labelA }, pauseAt: 98 }));
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(g, usageFetch({ [a.at]: usage(96, 20), [b.at]: usage(10, 10) }), { swapHooks: { afterProfileWrite: () => {
    // a concurrent rewrite that adds a BOM: our oauthAccount is still in place, so the verification fails and the
    // key-level rollback may (and does) restore it — a FOREIGN account value would be left unresolved instead (H1)
    fs.writeFileSync(fx.P.profile, '﻿' + fs.readFileSync(fx.P.profile, 'utf8'));
  } } }) });
  assert.deepStrictEqual([r.action, r.outcome], ['switch-failed', 'failed']);
  const st = gstate(fx);
  assert.strictEqual(st.mode, 'ok', 'not stuck in pause');
  assert.strictEqual(st.notice, undefined);
  assert.strictEqual(st.rotatorHandoff, undefined);
  assert.deepStrictEqual(st.account, { fp: labelA }, 'stamp restored');
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.P.creds, 'utf8')).claudeAiOauth.refreshToken, a.rt);
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.P.profile, 'utf8').replace(/^﻿/, '')).oauthAccount.accountUuid, a.uuid);
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.P.handoff, 'utf8')).phase, 'rolled-back');
  assert.deepStrictEqual([...pc.agents.values()].map((x) => x.status), ['running', 'paused', 'running']);
  assert.deepStrictEqual(g.unresolvedPausedAgents(), []);
  const st2 = vault.readState(fx.P);
  assert.deepStrictEqual([st2.history.slice(-1)[0].outcome, st2.failures.length, st2.consecutiveFailures, st2.swaps.length], ['failed', 1, 1, 0], 'counted as a failed attempt, not as a swap');
});
t('ALL FULL: no swap, handoff "waiting" with the soonest reset; once that window resets the rotator switches and continues', async () => {
  const fx = fixture(); const a = fakeAccount('fa'); const b = fakeAccount('fb', { expired: true });
  enroll(fx, b); enroll(fx, a);
  const g = freshGuard(fx);
  paperclip();
  const bReset = iso(NOW + 30 * 60e3);
  await vault.updateState(fx.P, (s) => { s.readings.fb = { windows: [{ id: 'w', kind: 'weekly_all', label: 'weekly_all', pct: 97, resetsAt: bReset }], measuredAt: iso(NOW - 3600e3), source: 'live' }; });
  const f = usageFetch({ [a.at]: usage(95, 30), [b.at]: usage(3, 4) });
  const w = await R.tick({ P: fx.P, S: S(), deps: deps(g, f) });
  assert.deepStrictEqual([w.action, w.reason], ['wait', 'no-usable-account']);
  const h = JSON.parse(fs.readFileSync(fx.P.handoff, 'utf8'));
  assert.strictEqual(h.phase, 'waiting');
  assert.ok(h.soonestResetAt && Date.parse(h.soonestResetAt) <= Date.parse(bReset), h.soonestResetAt);
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.P.creds, 'utf8')).claudeAiOauth.refreshToken, a.rt, 'no swap');
  assert.ok(!fs.existsSync(fx.stateFile) || gstate(fx).mode !== 'paused', 'the rotator itself never pauses when it cannot switch');
  const later = NOW + 31 * 60e3;
  const s = await R.tick({ P: fx.P, S: S(), deps: deps(g, f, { now: () => later }) });
  assert.deepStrictEqual([s.action, s.to], ['switched', 'fb'], JSON.stringify(s));
  assert.strictEqual(gstate(fx).mode, 'ok');
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.P.handoff, 'utf8')).phase, 'continued');
});
t('HOPS: a target that turns out full on the live check is left for the next one (bounded)', async () => {
  const fx = fixture(); const a = fakeAccount('pa'); const b = fakeAccount('pb', { expired: true }); const c = fakeAccount('pc', { expired: true });
  enroll(fx, b); enroll(fx, c); enroll(fx, a);
  const g = freshGuard(fx);
  paperclip();
  await vault.updateState(fx.P, (s) => {
    s.readings.pb = { windows: [{ id: 's', kind: 'session', label: 'session', pct: 10, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' };
    s.readings.pc = { windows: [{ id: 's', kind: 'session', label: 'session', pct: 20, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' };
  });
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(g, usageFetch({ [a.at]: usage(95, 30), [b.at]: usage(96, 30), [c.at]: usage(15, 15) })) });
  assert.deepStrictEqual([r.action, r.to, r.hops.length], ['switched', 'pc', 2], JSON.stringify(r));
  assert.ok(r.hops[0].full);
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.P.creds, 'utf8')).claudeAiOauth.refreshToken, c.rt);
});
t('GUARD COHERENCE: rotator switch then a real guard tick — adoption (no reset), CONTINUE kept, no stale pause, journal clean', async () => {
  const fx = fixture(); const a = fakeAccount('ga'); const b = fakeAccount('gb');
  enroll(fx, b); enroll(fx, a);
  const g = freshGuard(fx);
  const pc = paperclip();
  fs.writeFileSync(fx.stateFile, JSON.stringify({ mode: 'ok', account: { fp: g.readAccountIdentity().fp } }));
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(g, usageFetch({ [a.at]: usage(94, 20), [b.at]: usage(10, 10) })) });
  assert.strictEqual(r.action, 'switched');
  const labelB = g.readAccountIdentity().fp;
  const glog = [];
  await g.tick(guardTickDeps(g, usage(10, 10), glog));
  const st = gstate(fx);
  assert.strictEqual(st.mode, 'ok');
  assert.deepStrictEqual(st.account && st.account.fp, labelB, 'the guard adopted the new account');
  assert.ok(!glog.some((l) => /ACCOUNT SWITCH —/.test(l)), 'not mistaken for a hostile switch: ' + glog.join(' | '));
  assert.ok(/CONTINUE/.test(st.resumeNotice) && st.pendingCheckup === true, 'the CONTINUE notice survives the guard tick');
  assert.deepStrictEqual(g.unresolvedPausedAgents(), []);
  assert.deepStrictEqual([...pc.agents.values()].map((x) => x.status), ['running', 'paused', 'running']);
});
t('GUARD COHERENCE: a real 98% guard pause on the old account is cleared by the switch and its agents are resumed by the guard\'s own journal reconciliation', async () => {
  const fx = fixture(); const a = fakeAccount('za'); const b = fakeAccount('zb', { expired: true });
  enroll(fx, b); enroll(fx, a);
  const g = freshGuard(fx);
  const pc = paperclip();
  const uA = usage(99, 50);
  const glog0 = [];
  await g.tick(guardTickDeps(g, uA, glog0)); // the guard pauses for real at >= 98
  assert.strictEqual(gstate(fx).mode, 'paused', glog0.join(' | '));
  assert.strictEqual(g.unresolvedPausedAgents().length, 2);
  await vault.updateState(fx.P, (s) => { s.readings.zb = { windows: [{ id: 'w', kind: 'weekly_all', label: 'weekly_all', pct: 99, resetsAt: iso(NOW + 60e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' }; });
  const later = NOW + 5 * 60e3; // zb's weekly window has reset by now
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(g, usageFetch({ [a.at]: uA, [b.at]: usage(2, 2) }), { now: () => later }) });
  assert.deepStrictEqual([r.action, r.to], ['switched', 'zb'], JSON.stringify(r));
  assert.strictEqual(gstate(fx).mode, 'ok', 'the old account\'s pause does not stick to the new account');
  assert.deepStrictEqual([pc.agents.get('a1').status, pc.agents.get('a3').status], ['paused', 'paused'], 'guard-paused agents wait for the guard\'s own reconciliation');
  const glog = [];
  await g.tick(guardTickDeps(g, usage(2, 2), glog));
  assert.strictEqual(gstate(fx).mode, 'ok');
  assert.deepStrictEqual(g.unresolvedPausedAgents(), [], 'the paused-agent list was not lost: ' + glog.join(' | '));
  assert.deepStrictEqual([...pc.agents.values()].map((x) => x.status), ['running', 'paused', 'running']);
});
t('GUARD COHERENCE: an agent the rotator could not resume stays in the journal and the guard\'s next tick resumes it', async () => {
  const fx = fixture(); const a = fakeAccount('qa'); const b = fakeAccount('qb');
  enroll(fx, b); enroll(fx, a);
  const g = freshGuard(fx);
  let failResume = true;
  const pc = paperclip({ fail: (id, op) => failResume && op === 'resume' && id === 'a3' });
  await R.tick({ P: fx.P, S: S(), deps: deps(g, usageFetch({ [a.at]: usage(94, 20), [b.at]: usage(10, 10) })) });
  assert.strictEqual(pc.agents.get('a3').status, 'paused');
  assert.deepStrictEqual(g.unresolvedPausedAgents().map((x) => x.agentId), ['a3']);
  failResume = false;
  await g.tick(guardTickDeps(g, usage(10, 10), []));
  assert.strictEqual(pc.agents.get('a3').status, 'running');
  assert.deepStrictEqual(g.unresolvedPausedAgents(), []);
});
t('SECRECY: no fake token or fingerprint in the guard state, journal, handoff, rotator state/log or notification', () => {
  const texts = [];
  for (const d of fs.readdirSync(ROOT).filter((x) => x.startsWith('fx-'))) {
    const home = path.join(ROOT, d, '.claude');
    for (const f of ['FORGE_USAGE_GUARD_STATE.json', 'forge-usage-guard-paused.jsonl', 'FORGE_ACCOUNT_ROTATION.json', 'forge-usage-guard.log',
      path.join('forge-accounts', 'state.json'), path.join('forge-accounts', 'handoff.json'), path.join('forge-accounts', 'rotator.log')]) {
      const s = vault.readRaw(path.join(home, f));
      if (s !== null) texts.push(s);
    }
  }
  assert.ok(texts.length >= 20, 'scanned ' + texts.length + ' files');
  const blob = texts.join('\n') + LOGS.join('\n');
  for (const s of SECRETS) {
    assert.ok(!blob.includes(s), 'secret leaked');
    assert.ok(!blob.includes(crypto.createHash('sha256').update('rt:' + s).digest('hex').slice(0, 12)), 'fingerprint leaked');
  }
});
