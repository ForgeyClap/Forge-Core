#!/usr/bin/env node
'use strict';
// account-rotator-txn.test.cjs — rework round 1 regression tests for: one test (or
// more) per review finding (Codex AR-01..AR-09, security H1 / M1..M6 / L-items), named by ID. Includes REAL crash
// injection (a child process exits between the two renames), a concurrent-switch test, a Claude-Code-refresh-during-
// swap test and the tri-state outcome tests. HERMETIC: temp dirs, FAKE logins, network stubbed or denied.
const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-rot-txn-'));
process.env.FORGE_CONFIG_HOME = path.join(ROOT, 'cfg-home');
process.env.FORGE_PROJECT_ROOT = path.join(ROOT, 'cfg-proj');
process.env.FORGE_USAGE_GUARD_HOME = path.join(ROOT, 'guard-trap', '.claude');
process.env.FORGE_ACCOUNT_ROTATOR_HOME = path.join(ROOT, 'rot-trap', '.claude');
process.env.FORGE_USAGE_GUARD_DENY_NETWORK = '1';
process.env.FORGE_ACCOUNT_ROTATOR_DENY_NETWORK = '1';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const core = require('./account-rotator-core.cjs');
const vault = require('./account-rotator-vault.cjs');
const txn = require('./account-rotator-txn.cjs');
const R = require('./account-rotator.cjs');
const cli = require('./account-rotator-cli.cjs');
const tok = require('./account-rotator-token.cjs');
const guard = require('./usage-guard.cjs');

let passed = 0; let failed = 0;
function t(name, fn) { test(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
const SPAWNED = [];
after(() => {
  for (const pidFile of SPAWNED) { try { const rec = guard.readPidRecordFrom(pidFile); if (rec.pid) { try { process.kill(rec.pid); } catch { /* gone */ } } } catch { /* none */ } }
  console.log(passed + ' passed, ' + failed + ' failed');
});

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const rnd = () => crypto.randomBytes(10).toString('hex');
const SECRETS = new Set();
function fakeAccount(n, opts) {
  const a = { name: n, uuid: 'uuid-' + n + '-' + rnd(), email: n + '@example.com', at: 'FAKE-AT-' + n + '-' + rnd(), rt: 'FAKE-RT-' + n + '-' + rnd(),
    expiresAt: opts && opts.expired ? NOW - 3600e3 : NOW + 6 * 3600e3, setup: 'FAKE-SETUP-' + n + '-' + rnd() };
  for (const s of [a.at, a.rt, a.setup]) SECRETS.add(s);
  return a;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(ROOT, 'fx-'));
  const home = path.join(root, '.claude');
  fs.mkdirSync(home, { recursive: true });
  const env = Object.assign({}, process.env, { FORGE_ACCOUNT_ROTATOR_HOME: home, FORGE_ACCOUNT_ROTATOR_PROFILE: path.join(root, '.claude.json'), FORGE_USAGE_GUARD_HOME: home });
  for (const k of tok.AGENT_MARKERS) delete env[k];
  return { root, home, env, P: vault.paths(env) };
}
function login(fx, a) {
  fs.writeFileSync(fx.P.creds, JSON.stringify({ claudeAiOauth: { accessToken: a.at, refreshToken: a.rt, expiresAt: a.expiresAt }, mcpOAuth: { srv: { accessToken: 'FAKE-MCP-' + a.name } } }));
  fs.writeFileSync(fx.P.profile, JSON.stringify({ numStartups: 2, oauthAccount: { accountUuid: a.uuid, emailAddress: a.email, organizationUuid: 'org-' + a.name } }, null, 2) + '\n');
}
function enroll(fx, a) {
  vault.writeSlot(fx.P, { name: a.name, credentials: { claudeAiOauth: { accessToken: a.at, refreshToken: a.rt, expiresAt: a.expiresAt } },
    oauthAccount: { accountUuid: a.uuid, emailAddress: a.email, organizationUuid: 'org-' + a.name }, enrolledAt: iso(NOW) });
}
function setup(accts, activeName) { const fx = fixture(); for (const a of accts) enroll(fx, a); login(fx, accts.find((a) => a.name === activeName)); return fx; }
function resp(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function usage(session, week) {
  const sr = iso(NOW + 2 * 3600e3); const wr = iso(NOW + 3 * 86400e3);
  return { limits: [{ kind: 'session', group: 'session', percent: session, resets_at: sr }, { kind: 'weekly_all', group: 'weekly', percent: week, resets_at: wr }] };
}
function fetchStub(map) {
  return async (url, init) => {
    assert.strictEqual(String(url), 'https://api.anthropic.com/api/oauth/usage');
    const tokn = String(init.headers.authorization).replace(/^Bearer /, '');
    const r = typeof map === 'function' ? map(tokn) : map[tokn];
    if (r === undefined) return resp(401, {});
    if (r instanceof Error) throw r;
    return r && r.status ? resp(r.status, {}) : resp(200, r);
  };
}
function fakeGuard(fx, o) {
  const opts = o || {};
  const stateFile = path.join(fx.home, 'FORGE_USAGE_GUARD_STATE.json');
  const calls = []; const journal = [];
  return {
    calls, journal, stateFile,
    allAgents: async () => (opts.agents || []).map((a) => Object.assign({}, a)),
    pc: async (method, p) => { calls.push(method + ' ' + p); return opts.pcFail && opts.pcFail(method, p) ? { status: 500 } : { status: 200, json: {} }; },
    journalAppend: (r) => journal.push(r), compactJournalIfNeeded() {},
    unresolvedPausedAgents: () => (opts.unresolved ? opts.unresolved(journal) : []),
    readAccountIdentity: () => ({ fp: null }), resolveGuardLanguage: () => 'en',
    withStateLock: async (fn) => ({ ok: true, value: await fn(() => true) }),
    readState: () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { mode: 'ok' }; } },
    stateLockPath: () => stateFile + '.lock',
    readPidRecordFrom: guard.readPidRecordFrom, claimWatcherSlot: guard.claimWatcherSlot, releaseWatcherSlot: guard.releaseWatcherSlot,
    awaitChildClaim: guard.awaitChildClaim, ownsPid: guard.ownsPid,
  };
}
function S() { return R.resolveSettings(['--mode', 'file'], {}); } // this suite tests the FILE mode (experimental, explicit opt-in)
function deps(fx, extra) { return Object.assign({ now: () => NOW, quiet: true, guard: fakeGuard(fx), userEnvHas: () => false, settleMs: 0 }, extra || {}); }
async function runCli(fx, argv, extra) {
  const out = []; const err = [];
  const code = await cli.main(argv, Object.assign({ env: fx.env, P: fx.P, now: () => NOW, out: (s) => out.push(vault.scrub(s)), err: (s) => err.push(vault.scrub(s)),
    guard: fakeGuard(fx), userEnvHas: () => false, quiet: true, readStdin: async () => '', settleMs: 0 }, extra || {}));
  return { code, out: out.join('\n'), err: err.join('\n'), all: out.concat(err).join('\n') };
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\ufeff/, ''));
const credsRT = (fx) => readJson(fx.P.creds).claudeAiOauth.refreshToken;
const profUuid = (fx) => readJson(fx.P.profile).oauthAccount.accountUuid;
/** crashChild(fx, target, hook) — a REAL process that runs preflight + swap and exits (137) inside the named hook. */
function crashChild(fx, target, hook) {
  const script = path.join(fx.root, 'crash.cjs');
  fs.writeFileSync(script, 'const txn = require(' + JSON.stringify(path.join(__dirname, 'account-rotator-txn.cjs')) + ');\n'
    + 'const P = require(' + JSON.stringify(path.join(__dirname, 'account-rotator-vault.cjs')) + ').paths(process.env);\n'
    + '(async () => { const pf = await txn.preflight(P, process.argv[2], { settleMs: 0 }); if (!pf.ok) { console.log("PF " + pf.reason); process.exit(2); }\n'
    + '  txn.swapLogin(P, pf, { hooks: { [process.argv[3]]: () => process.exit(137) } }); process.exit(0); })();\n');
  return spawnSync(process.execPath, [script, target, hook], { env: fx.env, encoding: 'utf8', timeout: 30000 });
}

// ---- AR-01 transaction record + reconcile (real crashes) -------------------------------------------------------
t('AR-01: txn.json is written BEFORE the first rename and is token-free', async () => {
  const a = fakeAccount('t1a'); const b = fakeAccount('t1b'); const fx = setup([a, b], 't1a');
  let seen = null;
  const pf = await txn.preflight(fx.P, 't1b', { settleMs: 0 });
  const r = txn.swapLogin(fx.P, pf, { hooks: { beforeCredsWrite: () => { seen = vault.readRaw(fx.P.txn); } } });
  assert.ok(r.ok, r.reason);
  const t0 = JSON.parse(seen);
  assert.deepStrictEqual([t0.phase, t0.from, t0.to], ['prepared', 't1a', 't1b']);
  assert.ok(t0.gen.credsBefore && t0.gen.profileBefore, 'file generations recorded');
  for (const s of SECRETS) assert.ok(!seen.includes(s) && !vault.readRaw(fx.P.txn).includes(s));
});
t('AR-01 crash injection: killed BETWEEN the two renames -> reconcile rolls the login back to the origin', () => {
  const a = fakeAccount('c1a'); const b = fakeAccount('c1b'); const fx = setup([a, b], 'c1a');
  const r = crashChild(fx, 'c1b', 'afterCredsWrite');
  assert.strictEqual(r.status, 137, r.stdout + r.stderr);
  assert.deepStrictEqual([credsRT(fx), profUuid(fx)], [b.rt, a.uuid], 'the crash really left the two files disagreeing');
  assert.strictEqual(readJson(fx.P.txn).phase, 'creds-written');
  const rec = txn.reconcile(fx.P);
  assert.deepStrictEqual([rec.action, rec.rolledBack], ['back', true]);
  assert.deepStrictEqual([credsRT(fx), profUuid(fx)], [a.rt, a.uuid]);
  assert.strictEqual(readJson(fx.P.creds).mcpOAuth.srv.accessToken, 'FAKE-MCP-c1a', 'other login-file keys survive');
  assert.deepStrictEqual([readJson(fx.P.txn).phase, readJson(fx.P.txn).outcome], ['done', 'recovered-back']);
});
t('AR-01 crash injection: killed after BOTH renames -> reconcile rolls forward; the next tick counts the swap and leaves it pending verification', async () => {
  const a = fakeAccount('c2a'); const b = fakeAccount('c2b'); const fx = setup([a, b], 'c2a');
  assert.strictEqual(crashChild(fx, 'c2b', 'afterProfileWrite').status, 137);
  assert.deepStrictEqual([credsRT(fx), profUuid(fx)], [b.rt, b.uuid]);
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: fetchStub({}) }) });
  assert.strictEqual(readJson(fx.P.txn).outcome, 'recovered-forward');
  const st = vault.readState(fx.P);
  assert.strictEqual(st.swaps.length, 1);
  assert.strictEqual(st.swaps[0].kind, 'recovered');
  assert.strictEqual(st.pendingVerify.to, 'c2b');
  assert.notStrictEqual(st.active, 'c2b', 'not claimed active before a live verification');
  assert.ok(r.action === 'none', JSON.stringify(r));
});
t('AR-01 / D14 crash injection: killed INSIDE the first rename -> the temp file of the dead pid is swept and the txn closes unchanged', () => {
  const a = fakeAccount('c3a'); const b = fakeAccount('c3b'); const fx = setup([a, b], 'c3a');
  assert.strictEqual(crashChild(fx, 'c3b', 'renameImpl').status, 137);
  const temps = fs.readdirSync(fx.home).filter((f) => vault.TMP_RE.test(f));
  assert.strictEqual(temps.length, 1, 'the crash left a temp file: ' + fs.readdirSync(fx.home).join(','));
  const rec = txn.reconcile(fx.P);
  assert.strictEqual(rec.action, 'back');
  assert.ok(rec.removed.includes(temps[0]));
  assert.deepStrictEqual(fs.readdirSync(fx.home).filter((f) => vault.TMP_RE.test(f)), []);
  assert.strictEqual(credsRT(fx), a.rt);
});

// ---- AR-02 one lock around every account-changing transaction --------------------------------------------------
t('AR-02: two concurrent automatic ticks -> exactly ONE switch (the second re-reads under the lock and sees the new account)', async () => {
  const a = fakeAccount('l1a'); const b = fakeAccount('l1b'); const c = fakeAccount('l1c'); const fx = setup([a, b, c], 'l1a');
  const f = fetchStub({ [a.at]: usage(95, 10), [b.at]: usage(10, 10), [c.at]: usage(12, 10) });
  const [r1, r2] = await Promise.all([R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f }) }), R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f }) })]);
  const acts = [r1.action, r2.action].sort();
  assert.deepStrictEqual(acts, ['none', 'switched'], JSON.stringify([r1, r2]));
  assert.strictEqual(vault.readState(fx.P).swaps.length, 1);
  assert.strictEqual(credsRT(fx), b.rt);
});
t('AR-02: a tick never runs while another transaction holds the lock (reports busy)', async () => {
  const a = fakeAccount('l2a'); const b = fakeAccount('l2b'); const fx = setup([a, b], 'l2a');
  let release; const held = new Promise((r) => { release = r; });
  const holder = vault.withTxnLock(fx.P, () => held, { timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 50));
  const r = await R.tick({ P: fx.P, S: S(), lockTimeoutMs: 300, deps: deps(fx, { fetch: fetchStub({ [a.at]: usage(99, 1), [b.at]: usage(1, 1) }) }) });
  assert.deepStrictEqual([r.action, r.reason], ['none', 'busy']);
  release(); await holder;
  assert.strictEqual(credsRT(fx), a.rt);
});
t('AR-02: manual `switch` honours the kill-switch unless --force', async () => {
  const a = fakeAccount('l3a'); const b = fakeAccount('l3b'); const fx = setup([a, b], 'l3a');
  const f = fetchStub({ [a.at]: usage(10, 10), [b.at]: usage(10, 10) });
  assert.strictEqual((await runCli(fx, ['disable'])).code, 0);
  const r0 = await runCli(fx, ['switch', 'l3b', '--force'], { fetch: f });
  assert.strictEqual(r0.code, 3, 'token mode (default): the file swap is refused even with --force');
  assert.ok(/launch --auto/.test(r0.err) && /mode/.test(r0.err), r0.err);
  const r1 = await runCli(fx, ['switch', 'l3b', '--mode', 'file'], { fetch: f });
  assert.strictEqual(r1.code, 3, r1.all);
  assert.ok(/disabled/.test(r1.out));
  assert.strictEqual(credsRT(fx), a.rt);
  const r2 = await runCli(fx, ['switch', 'l3b', '--force', '--mode', 'file'], { fetch: f });
  assert.strictEqual(r2.code, 0, r2.all);
  assert.strictEqual(credsRT(fx), b.rt);
});

// ---- AR-03 "unchanged" re-check before every rename attempt (best-effort, see AR-V03), key-level rollback -------------
t('AR-03: renameWithRetry re-checks "unchanged" before EVERY attempt — a retry after a lock never overwrites a newer file', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'cas-'));
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, 'ORIGINAL');
  let attempts = 0;
  assert.throws(() => vault.atomicWrite(file, 'OURS', {
    beforeRename: () => fs.readFileSync(file, 'utf8') === 'ORIGINAL',
    renameImpl: (a, b) => { attempts++; if (attempts === 1) { fs.writeFileSync(file, 'NEWER'); throw Object.assign(new Error('locked'), { code: 'EPERM' }); } fs.renameSync(a, b); },
  }), (e) => e.code === 'ECHANGED');
  assert.strictEqual(attempts, 1, 'no second rename once the file changed');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'NEWER');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'temp cleaned');
});
t('AR-03 / AR-V01: Claude Code refreshing the TARGET mid-swap — the unknown token is never overwritten and never attributed on the uuid alone: UNRESOLVED until usage readings prove the owner, then captured and recovered', async () => {
  const a = fakeAccount('r1a'); const b = fakeAccount('r1b'); const fx = setup([a, b], 'r1a');
  const newAt = 'FAKE-AT-r1b-refreshed-' + rnd(); const newRt = 'FAKE-RT-r1b-refreshed-' + rnd(); SECRETS.add(newAt); SECRETS.add(newRt);
  const pf = await txn.preflight(fx.P, 'r1b', { settleMs: 0 });
  const r = txn.swapLogin(fx.P, pf, { hooks: { afterCredsWrite: () => {
    const c = readJson(fx.P.creds); c.claudeAiOauth = { accessToken: newAt, refreshToken: newRt, expiresAt: NOW + 8 * 3600e3 }; fs.writeFileSync(fx.P.creds, JSON.stringify(c));
  } } });
  assert.deepStrictEqual([r.ok, r.unresolved, r.cls], [false, true, 'unknown'], JSON.stringify(r));
  assert.strictEqual(credsRT(fx), newRt, 'the newer login was not overwritten with stale bytes');
  assert.strictEqual(vault.readSlot(fx.P, 'r1b').credentials.claudeAiOauth.refreshToken, b.rt, 'nothing captured on the uuid alone');
  // no reading can vouch for the new token yet -> the next tick keeps it unresolved and measures nothing for a slot
  const r1 = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: fetchStub({ [newAt]: usage(5, 5) }) }) });
  assert.strictEqual(r1.reason, 'unresolved-transaction', JSON.stringify(r1));
  assert.strictEqual(vault.readSlot(fx.P, 'r1b').credentials.claudeAiOauth.refreshToken, b.rt);
  // r1b's OWN earlier reading (measured with its stored token) matches the new token's readings on two windows -> proof
  await vault.updateState(fx.P, (s) => { s.readings.r1b = R.liveReading({ windows: core.cleanWindows(guard.normalizeWindows(usage(5, 5))) }, NOW - 120e3, { viaSlotToken: true }); });
  const r2 = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: fetchStub({ [newAt]: usage(5, 5) }) }) });
  assert.strictEqual(vault.readSlot(fx.P, 'r1b').credentials.claudeAiOauth.refreshToken, newRt, 'captured into the right slot: ' + JSON.stringify(r2));
  assert.strictEqual(readJson(path.join(fx.P.vault, 'r1b.prev.json')).credentials.claudeAiOauth.refreshToken, b.rt);
  assert.strictEqual(vault.readSlot(fx.P, 'r1a').credentials.claudeAiOauth.refreshToken, a.rt, 'the origin slot still holds its own login');
  assert.strictEqual(readJson(fx.P.txn).outcome, 'recovered-forward');
  assert.ok(/REPAIR — the unknown login was established as r1b \(usage-readings\)/.test(vault.readRaw(fx.P.log)));
});

// ---- AR-04 identity-safe capture ----------------------------------------------------------------------------------
t('AR-04: a login that changes between the two corroboration reads is NOT captured (slot and .prev untouched)', async () => {
  const a = fakeAccount('i1a'); const fx = setup([a], 'i1a');
  const c = readJson(fx.P.creds); c.claudeAiOauth.refreshToken = 'FAKE-RT-i1a-x-' + rnd(); SECRETS.add(c.claudeAiOauth.refreshToken); fs.writeFileSync(fx.P.creds, JSON.stringify(c));
  setTimeout(() => { const d = readJson(fx.P.creds); d.claudeAiOauth.refreshToken = 'FAKE-RT-i1a-y-' + rnd(); SECRETS.add(d.claudeAiOauth.refreshToken); fs.writeFileSync(fx.P.creds, JSON.stringify(d)); }, 20);
  const r = await txn.corroboratedCapture(fx.P, vault.readSlot(fx.P, 'i1a'), { settleMs: 120 });
  assert.strictEqual(r.captured, false);
  assert.ok(/changed|settled/.test(r.reason), r.reason);
  assert.strictEqual(vault.readSlot(fx.P, 'i1a').credentials.claudeAiOauth.refreshToken, a.rt);
  assert.ok(!fs.existsSync(path.join(fx.P.vault, 'i1a.prev.json')));
});
t('AR-04: a login failing the token shape check, or one an identity check attributes elsewhere, is never captured', async () => {
  const a = fakeAccount('i2a'); const fx = setup([a], 'i2a');
  const c = readJson(fx.P.creds); c.claudeAiOauth.refreshToken = 'bad token with spaces'; fs.writeFileSync(fx.P.creds, JSON.stringify(c));
  assert.strictEqual((await txn.corroboratedCapture(fx.P, vault.readSlot(fx.P, 'i2a'), { settleMs: 0 })).captured, false);
  c.claudeAiOauth.refreshToken = 'FAKE-RT-i2a-z-' + rnd(); SECRETS.add(c.claudeAiOauth.refreshToken); fs.writeFileSync(fx.P.creds, JSON.stringify(c));
  const r = await txn.corroboratedCapture(fx.P, vault.readSlot(fx.P, 'i2a'), { settleMs: 0, identify: async () => ({ accountUuid: 'somebody-else' }) });
  assert.strictEqual(r.captured, false);
  assert.ok(/different account/.test(r.reason));
  assert.strictEqual(vault.readSlot(fx.P, 'i2a').credentials.claudeAiOauth.refreshToken, a.rt);
});

// ---- AR-05 / M6 tri-state outcome, deferred verification, auto rollback after two genuine 401s ---------------------
t('AR-05: a post-switch 401 is "unmeasurable-fallback": no CONTINUE, not ok, not active, pause notice removed — verified later => CONTINUE', async () => {
  const a = fakeAccount('v1a'); const b = fakeAccount('v1b', { expired: true }); const fx = setup([a, b], 'v1a');
  await vault.updateState(fx.P, (s) => { s.readings.v1b = { windows: [{ id: 'session', kind: 'session', label: 'session', pct: 10, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' }; });
  let worksYet = false;
  const f = fetchStub((tk) => (tk === a.at ? usage(95, 10) : tk === b.at && worksYet ? usage(5, 5) : undefined));
  const d = deps(fx, { fetch: f });
  const r = await R.tick({ P: fx.P, S: S(), deps: d });
  assert.deepStrictEqual([r.action, r.outcome, r.ok], ['switched-unverified', 'unmeasurable-fallback', false]);
  let st = vault.readState(fx.P);
  assert.notStrictEqual(st.active, 'v1b');
  assert.strictEqual(st.pendingVerify.to, 'v1b');
  const g1 = d.guard.readState();
  assert.ok(!g1.resumeNotice && !g1.pendingCheckup && g1.mode !== 'paused', 'no CONTINUE and no pause left: ' + JSON.stringify(g1));
  assert.ok(fs.existsSync(fx.P.backup), 'backup kept until verified');
  worksYet = true; // Claude Code used the new login; the stored token now works
  const r2 = await R.tick({ P: fx.P, S: S(), deps: Object.assign({}, d, { now: () => NOW + 120e3 }) });
  assert.deepStrictEqual([r2.action, r2.reason], ['verified', 'deferred-verification']);
  st = vault.readState(fx.P);
  assert.deepStrictEqual([st.active, st.pendingVerify], ['v1b', null]);
  assert.ok(/CONTINUE/.test(d.guard.readState().resumeNotice));
  assert.ok(!fs.existsSync(fx.P.backup), 'L1: backup deleted after the verified swap');
});
t('AR-05 refinement: an EXPIRED stored token nobody has refreshed yet is "awaiting first use" — never counted toward rollback', async () => {
  const a = fakeAccount('v2a'); const b = fakeAccount('v2b', { expired: true }); const fx = setup([a, b], 'v2a');
  await vault.updateState(fx.P, (s) => { s.readings.v2b = { windows: [{ id: 'session', kind: 'session', label: 'session', pct: 10, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' }; });
  const f = fetchStub({ [a.at]: usage(95, 10) });
  await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f }) });
  for (let i = 1; i <= 3; i++) {
    const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, now: () => NOW + i * 120e3 }) });
    assert.strictEqual(r.reason, 'awaiting-refresh');
  }
  assert.strictEqual(vault.readState(fx.P).pendingVerify.failures, 0);
  assert.strictEqual(credsRT(fx), b.rt);
});
t('M6 / AR-05: an automatic switch whose VALID token keeps returning 401 is rolled back after 2 ticks; the slot is marked needs-relogin and excluded', async () => {
  const a = fakeAccount('v3a'); const b = fakeAccount('v3b'); const fx = setup([a, b], 'v3a');
  const f = fetchStub({ [a.at]: usage(95, 10) }); // b's token is valid by expiry but rejected (revoked)
  const r0 = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f }) });
  assert.strictEqual(r0.outcome, 'unmeasurable-fallback', JSON.stringify(r0));
  const r1 = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, now: () => NOW + 120e3 }) });
  assert.deepStrictEqual([r1.reason, r1.failures], ['unverified', 1]);
  const r2 = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, now: () => NOW + 240e3 }) });
  assert.strictEqual(r2.action, 'rolled-back-needs-relogin', JSON.stringify(r2));
  assert.deepStrictEqual([credsRT(fx), profUuid(fx)], [a.rt, a.uuid], 'back on the previous, known-good login');
  const st = vault.readState(fx.P);
  assert.strictEqual(st.slotFlags.v3b.needsRelogin, true);
  assert.ok(/needs a new login/.test(readJson(fx.P.notify).notice));
  const again = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, now: () => NOW + 3 * 3600e3 }) });
  assert.notStrictEqual(again.to, 'v3b', 'a needs-relogin slot is never chosen again');
});

// ---- AR-06 failed onward hop ----------------------------------------------------------------------------------------
t('AR-06: an onward hop that could NOT be rolled back is unresolved — the target is never claimed active and the text says so', async () => {
  const a = fakeAccount('h1a'); const b = fakeAccount('h1b', { expired: true }); const c = fakeAccount('h1c', { expired: true }); const fx = setup([a, b, c], 'h1a');
  const f = fetchStub({ [a.at]: usage(95, 10), [b.at]: usage(96, 10), [c.at]: usage(5, 5) });
  let n = 0;
  const swapImpl = (P, pf, o) => (++n === 1 ? txn.swapLogin(P, pf, o) : { ok: false, rolledBack: false, unresolved: true, outcome: 'unresolved', reason: 'simulated: NOT rolled back' });
  await vault.updateState(fx.P, (s) => { s.readings.h1b = { windows: [{ id: 'session', kind: 'session', label: 'session', pct: 10, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' }; s.readings.h1c = { windows: [{ id: 'session', kind: 'session', label: 'session', pct: 20, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' }; });
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, swapImpl }) });
  assert.deepStrictEqual([r.action, r.unresolved, r.to, r.committedTo], ['switch-failed', true, null, null], JSON.stringify(r));
  assert.notStrictEqual(vault.readState(fx.P).active, 'h1c');
  const logText = vault.readRaw(fx.P.log);
  assert.ok(/NOT rolled back, unresolved/.test(logText) && !/SWITCH FAILED[^\n]*— teruggezet \/ rolled back/.test(logText), logText.slice(-600));
});

// ---- AR-07 exception cleanup, startup reconcile, exhausted ------------------------------------------------------------
t('AR-07: an exception mid-handoff still removes the pause notice and resumes every agent the rotator paused', async () => {
  const a = fakeAccount('e1a'); const b = fakeAccount('e1b'); const fx = setup([a, b], 'e1a');
  const g = fakeGuard(fx, { agents: [{ id: 'ag1', name: 'x', company: 'c', status: 'running' }] });
  const swapImpl = () => { throw new Error('boom'); };
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { guard: g, swapImpl, fetch: fetchStub({ [a.at]: usage(95, 10), [b.at]: usage(5, 5) }) }) });
  assert.strictEqual(r.action, 'switch-failed');
  assert.ok(g.calls.includes('POST /api/agents/ag1/pause') && g.calls.includes('POST /api/agents/ag1/resume'), g.calls.join(','));
  const st = g.readState();
  assert.ok(st.mode !== 'paused' && !st.rotatorHandoff, JSON.stringify(st));
});
t('AR-07: startup reconcile resumes journal records marked by account-rotator and restores a guard state still carrying a rotatorHandoff marker', async () => {
  const a = fakeAccount('e2a'); const b = fakeAccount('e2b'); const fx = setup([a, b], 'e2a');
  const id = 'dead-' + rnd();
  fs.writeFileSync(path.join(fx.home, 'FORGE_USAGE_GUARD_STATE.json'), JSON.stringify({ mode: 'paused', notice: 'ACCOUNT ROTATOR — switching', rotatorHandoff: { id, phase: 'switching' } }));
  vault.writeHandoffFile(fx.P, { id, phase: 'switching', from: 'e2a', to: 'e2b', guardState: { touched: true, snapshot: { mode: 'ok' } } });
  const g = fakeGuard(fx, { unresolved: (j) => (j.some((x) => x.action === 'resumed') ? [] : [{ agentId: 'ag7', pauseId: 'p7', by: 'account-rotator' }, { agentId: 'guardOwn', pauseId: 'p8' }]) });
  await R.tick({ P: fx.P, S: S(), deps: deps(fx, { guard: g, fetch: fetchStub({ [a.at]: usage(10, 10) }) }) });
  assert.ok(g.calls.includes('POST /api/agents/ag7/resume'));
  assert.ok(!g.calls.includes('POST /api/agents/guardOwn/resume'), 'records not marked by the rotator are left to usage-guard');
  assert.ok(g.journal.some((x) => x.agentId === 'ag7' && x.action === 'resumed' && x.resolved && x.pauseId === 'p7'));
  const st = g.readState();
  assert.deepStrictEqual([st.mode, st.rotatorHandoff, st.notice], ['ok', undefined, undefined]);
  assert.strictEqual(vault.readHandoffFile(fx.P).phase, 'recovered');
});
t('AR-07: an "exhausted" result (the new account is still over the threshold) never clears a real usage-guard pause and writes no CONTINUE', async () => {
  const a = fakeAccount('e3a'); const b = fakeAccount('e3b', { expired: true }); const fx = setup([a, b], 'e3a');
  const realPause = { mode: 'paused', trigger: [{ id: 's', name: 'session', pct: 99 }], notice: 'USAGE GUARD — PAUSED', account: { fp: 'account-1-abc' } };
  fs.writeFileSync(path.join(fx.home, 'FORGE_USAGE_GUARD_STATE.json'), JSON.stringify(realPause));
  await vault.updateState(fx.P, (s) => { s.readings.e3b = { windows: [{ id: 'session', kind: 'session', label: 'session', pct: 10, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' }; });
  const g = fakeGuard(fx);
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { guard: g, fetch: fetchStub((tk) => (tk === a.at ? usage(99, 10) : tk === b.at ? usage(97, 10) : undefined)) }) });
  assert.strictEqual(r.exhausted, true, JSON.stringify(r));
  assert.deepStrictEqual(g.readState(), realPause, 'the real guard pause is untouched');
});

// ---- AR-08 setup-token binding ----------------------------------------------------------------------------------------
t('AR-08: a token whose readings differ from the slot\'s login is refused; unmeasurable needs --confirm-same-account (unverified); re-enroll drops old readings', async () => {
  const a = fakeAccount('k1a'); const fx = setup([a], 'k1a');
  const other = fakeAccount('k1other');
  const diff = await runCli(fx, ['enroll-token', 'k1a'], { readStdin: async () => other.setup, fetch: fetchStub({ [other.setup]: usage(70, 80), [a.at]: { limits: [{ kind: 'session', group: 'session', percent: 3, resets_at: iso(NOW + 9e5) }] } }) });
  assert.strictEqual(diff.code, 3, diff.all);
  assert.ok(/DIFFERENT account/.test(diff.err));
  const unm = await runCli(fx, ['enroll-token', 'k1a'], { readStdin: async () => a.setup, fetch: fetchStub({ [a.setup]: { status: 401 }, [a.at]: usage(5, 5) }) });
  assert.strictEqual(unm.code, 3);
  assert.ok(/--confirm-same-account/.test(unm.err));
  await vault.updateState(fx.P, (s) => { s.tokenReadings.k1a = { windows: [{ id: 'x', kind: 'session', label: 'session', pct: 50 }], measuredAt: iso(NOW), source: 'live' }; });
  const ok = await runCli(fx, ['enroll-token', 'k1a', '--confirm-same-account'], { readStdin: async () => a.setup, fetch: fetchStub({ [a.setup]: { status: 401 } }) });
  assert.strictEqual(ok.code, 0, ok.all);
  assert.strictEqual(vault.readSlot(fx.P, 'k1a').tokenBinding.status, 'unverified');
  assert.strictEqual(vault.readState(fx.P).tokenReadings.k1a, undefined, 're-enrolling invalidates old token readings');
});
t('AR-08: an UNVERIFIED binding never borrows the account login\'s reading for its token', () => {
  const slot = { name: 'k2', token: 'x', tokenBinding: { status: 'unverified' } };
  const tr = { k2: { unmeasurable: { status: 401 } } };
  const ar = { k2: { windows: [{ id: 's', kind: 'session', label: 'session', pct: 5 }], measuredAt: iso(NOW), source: 'live' } };
  assert.strictEqual(tok.tokenReading(slot, tr, ar), tr.k2);
  assert.ok(tok.tokenReading(Object.assign({}, slot, { tokenBinding: { status: 'verified' } }), tr, ar).windows, 'a verified binding may');
});

// ---- AR-09 flap accounting per hop ------------------------------------------------------------------------------------
t('AR-09: every committed hop is a durable swap, and an onward hop needs daily allowance left', async () => {
  const a = fakeAccount('f1a'); const b = fakeAccount('f1b', { expired: true }); const c = fakeAccount('f1c', { expired: true }); const fx = setup([a, b, c], 'f1a');
  const est = (pct) => ({ windows: [{ id: 'session', kind: 'session', label: 'session', pct, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' });
  const f = fetchStub((tk) => (tk === a.at ? usage(95, 10) : tk === b.at ? usage(96, 10) : tk === c.at ? usage(5, 5) : undefined));
  const noRefresh = (s) => { s.readings.f1b = est(10); s.readings.f1c = est(20); };
  await vault.updateState(fx.P, noRefresh);
  const d = deps(fx, { fetch: f });
  const r = await R.tick({ P: fx.P, S: S(), deps: d });
  assert.deepStrictEqual([r.committedTo, r.hops.length], ['f1c', 2], JSON.stringify(r));
  assert.strictEqual(vault.readState(fx.P).swaps.length, 2, 'two committed swaps for two hops');
  assert.deepStrictEqual(vault.readState(fx.P).swaps.map((s) => s.to), ['f1b', 'f1c']);
});
t('AR-09: with 5 swaps already today the event gets exactly ONE swap — no onward hop beyond the 6/day budget', async () => {
  const a = fakeAccount('g1a'); const b = fakeAccount('g1b', { expired: true }); const c = fakeAccount('g1c', { expired: true }); const fx = setup([a, b, c], 'g1a');
  await vault.updateState(fx.P, (s) => {
    s.swaps = Array.from({ length: 5 }, (_, i) => ({ at: iso(NOW - (i + 2) * 3600e3), kind: 'auto' }));
    s.readings.g1b = { windows: [{ id: 'session', kind: 'session', label: 'session', pct: 10, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' };
    s.readings.g1c = { windows: [{ id: 'session', kind: 'session', label: 'session', pct: 20, resetsAt: iso(NOW + 3600e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' };
  });
  const f = fetchStub((tk) => (tk === a.at ? usage(95, 10) : tk === b.at ? usage(96, 10) : tk === c.at ? usage(5, 5) : undefined));
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f }) });
  assert.deepStrictEqual([r.committedTo, r.hops.length, r.exhausted], ['g1b', 1, true], JSON.stringify(r));
  assert.strictEqual(vault.readState(fx.P).swaps.length, 6);
});

// ---- M1 / M2 / M3 / M4 / M5 / M6 --------------------------------------------------------------------------------------
t('M1: status runs reconcile under the same lock — while a transaction holds it, status reports busy and changes nothing', async () => {
  const a = fakeAccount('m1a'); const b = fakeAccount('m1b'); const fx = setup([a, b], 'm1a');
  let release; const held = new Promise((r) => { release = r; });
  const holder = vault.withTxnLock(fx.P, () => held, { timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 50));
  const s = await runCli(fx, ['status'], { statusLockMs: 300, fetch: fetchStub({ [a.at]: usage(10, 10) }), ownsPid: () => ({ ok: false, code: 'dead', reason: 'x' }) });
  assert.ok(/busy/.test(s.out), s.out);
  const l = await runCli(fx, ['launch', '--auto', '--', 'x'], { claudeBin: 'unused', launchLockMs: 300 });
  release(); await holder;
  assert.ok(l.code !== 0);
});
t('M2: a failing precondition (target login shape, backup not writable) pauses NO agent and writes NO pause notice', async () => {
  for (const variant of ['bad-target', 'backup']) {
    const a = fakeAccount('p' + variant.length + 'a'); const b = fakeAccount('p' + variant.length + 'b'); const fx = setup([a, b], a.name);
    if (variant === 'bad-target') { const s = vault.readSlot(fx.P, b.name); s.credentials.claudeAiOauth.refreshToken = 'not a token'; vault.writeSlot(fx.P, s); }
    const g = fakeGuard(fx, { agents: [{ id: 'ag', name: 'x', company: 'c', status: 'running' }] });
    const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { guard: g, swapHooks: variant === 'backup' ? { backupUnwritable: true } : {}, fetch: fetchStub({ [a.at]: usage(95, 10), [b.at]: usage(5, 5) }) }) });
    assert.ok(r.action === 'none' || r.action === 'wait', variant + ' ' + JSON.stringify(r));
    assert.deepStrictEqual(g.calls.filter((c) => /pause|resume/.test(c)), [], variant + ': no agent touched');
    assert.ok(!fs.existsSync(g.stateFile), variant + ': no pause notice');
    assert.strictEqual(credsRT(fx), a.rt);
  }
});
t('M3: env / token-for-shell refuse inside an agent environment; a token passed as --token= is refused with a revoke warning', async () => {
  const a = fakeAccount('n1'); const fx = fixture();
  await runCli(fx, ['enroll-token', 'n1'], { readStdin: async () => a.setup });
  const agentEnv = Object.assign({}, fx.env, { CLAUDECODE: '1' });
  for (const argv of [['env', 'n1', '--i-know'], ['token-for-shell', 'n1', '--i-know']]) {
    const r = await runCli(fx, argv, { env: agentEnv, isTTY: false, rawOut: () => { throw new Error('token written'); } });
    assert.strictEqual(r.code, 3, argv.join(' '));
    assert.ok(/CLAUDECODE/.test(r.err));
  }
  for (const argv of [['enroll-token', 'n2', '--token=' + a.setup], ['enroll-token', 'n2', '--token', a.setup]]) {
    const r = await runCli(fx, argv, { readStdin: async () => a.setup });
    assert.strictEqual(r.code, 2);
    assert.ok(/revoke/.test(r.err) && !r.all.includes(a.setup));
    assert.strictEqual(vault.readSlot(fx.P, 'n2'), null);
  }
});
t('M4: stop asks the watcher to stop via the stop file; it refuses while a switch is in progress unless --force', async () => {
  const a = fakeAccount('s1a'); const b = fakeAccount('s1b'); const fx = setup([a, b], 's1a');
  SPAWNED.push(fx.P.pid);
  const node = (args) => spawnSync(process.execPath, [path.join(__dirname, 'account-rotator.cjs'), ...args, '--mode', 'file'], { env: fx.env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(node(['start']).status, 0);
  const rec = guard.readPidRecordFrom(fx.P.pid);
  vault.writeHandoffFile(fx.P, { id: 'x', phase: 'switching', from: 's1a', to: 's1b', at: new Date().toISOString() });
  const busy = await cli.main(['stop'], { env: fx.env, P: fx.P, out: () => {}, err: () => {}, stopBusyWaitMs: 300 });
  assert.strictEqual(busy, 3, 'refused while switching');
  assert.ok(vault.pidAlive(rec.pid));
  vault.writeHandoffFile(fx.P, { id: 'x', phase: 'continued', from: 's1a', to: 's1b' });
  const out = [];
  const code = await cli.main(['stop'], { env: fx.env, P: fx.P, out: (s) => out.push(s), err: (s) => out.push(s), stopTimeoutMs: 20000 });
  assert.strictEqual(code, 0, out.join('\n'));
  assert.ok(!vault.pidAlive(rec.pid) && !fs.existsSync(fx.P.pid) && !fs.existsSync(fx.P.stop));
  assert.ok(/stop requested/.test(vault.readRaw(fx.P.log)), 'the watcher stopped through the stop file, not a kill');
  assert.strictEqual(node(['start']).status, 0);
  const rec2 = guard.readPidRecordFrom(fx.P.pid);
  vault.writeHandoffFile(fx.P, { id: 'y', phase: 'switching', from: 's1a', to: 's1b', at: new Date().toISOString() });
  const forced = await cli.main(['stop', '--force'], { env: fx.env, P: fx.P, out: () => {}, err: () => {} });
  assert.strictEqual(forced, 0);
  assert.ok(!vault.pidAlive(rec2.pid));
});
t('M5 / L1: the pre-switch backup holds only claudeAiOauth (no MCP tokens) and is deleted after a verified swap', async () => {
  const a = fakeAccount('b1a'); const b = fakeAccount('b1b'); const fx = setup([a, b], 'b1a');
  let seen = null;
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { swapHooks: { beforeCredsWrite: () => { seen = vault.readRaw(fx.P.backup); } }, fetch: fetchStub({ [a.at]: usage(95, 10), [b.at]: usage(5, 5) }) }) });
  assert.strictEqual(r.action, 'switched');
  assert.ok(seen && /claudeAiOauth/.test(seen) && !/FAKE-MCP/.test(seen), seen);
  assert.ok(!fs.existsSync(fx.P.backup));
});
t('M6: a failed attempt backs off (2 min, then 4 ...) and after 6 failed attempts in 24 h the rotator stops with ONE notice', async () => {
  const a = fakeAccount('x1a'); const b = fakeAccount('x1b'); const fx = setup([a, b], 'x1a');
  const f = fetchStub({ [a.at]: usage(95, 10), [b.at]: usage(5, 5) });
  const failing = () => ({ ok: false, rolledBack: true, outcome: 'rolled-back', reason: 'simulated failure' });
  const r1 = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, swapImpl: failing }) });
  assert.strictEqual(r1.action, 'switch-failed');
  assert.strictEqual(vault.readState(fx.P).consecutiveFailures, 1);
  const r2 = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, swapImpl: failing, now: () => NOW + 60e3 }) });
  assert.strictEqual(r2.reason, 'backoff');
  const r3 = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, swapImpl: failing, now: () => NOW + 3 * 60e3 }) });
  assert.strictEqual(r3.action, 'switch-failed', 'retried once the 2-minute backoff passed');
  await vault.updateState(fx.P, (s) => { s.failures = Array.from({ length: 6 }, (_, i) => ({ at: iso(NOW - i * 60e3), reason: 'x' })); s.consecutiveFailures = 0; });
  const before = (vault.readRaw(fx.P.log) || '').split('\n').filter((l) => /STOPPED/.test(l)).length;
  for (let i = 1; i <= 3; i++) assert.strictEqual((await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f, now: () => NOW + i * 600e3 }) })).reason, 'fail-cap');
  const after = (vault.readRaw(fx.P.log) || '').split('\n').filter((l) => /STOPPED/.test(l)).length;
  assert.strictEqual(after - before, 1, 'one notice, not one per tick');
});

// ---- L hardening -----------------------------------------------------------------------------------------------------
t('L: PowerShell/POSIX quoting escapes quotes; the cmd wrapper uses /v:off and refuses % ! " newline and a trailing backslash', () => {
  assert.strictEqual(tok.psQuote("C:\\it's"), "'C:\\it''s'");
  assert.strictEqual(tok.posixQuote("a'b"), "'a'\\''b'");
  const w = tok.cmdWrapperArgv('C:\\x\\claude.cmd', ['--print', 'hi there']);
  assert.deepStrictEqual(w.argv.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  for (const bad of [['50%'], ['hi!'], ['a"b'], ['x\ny'], ['C:\\dir\\']]) assert.ok(tok.cmdWrapperArgv('c.cmd', bad).refused, JSON.stringify(bad));
});
t('L: the watcher\'s stderr is scrubbed before it reaches rotator.log', () => {
  const script = path.join(ROOT, 'stderr-probe.cjs');
  const secret = 'FAKE-SECRET-STDERR-' + rnd();
  fs.writeFileSync(script, 'const v = require(' + JSON.stringify(path.join(__dirname, 'account-rotator-vault.cjs')) + '); const c = require(' + JSON.stringify(path.join(__dirname, 'account-rotator-cli.cjs')) + ');\n'
    + 'v.registerSecret(process.argv[2]); c.scrubStderr(); process.stderr.write("leak? " + process.argv[2] + "\\n");\n');
  const r = spawnSync(process.execPath, [script, secret], { encoding: 'utf8', env: Object.assign({}, process.env) });
  assert.ok(!r.stderr.includes(secret) && /\[redacted\]/.test(r.stderr), r.stderr);
});
t('L: the disclosure (schema + fallback) names Paperclip pausing, tool-call blocking (max 5 min), setup tokens and the shell-wide scope of env', () => {
  const schema = readJson(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'));
  for (const text of [schema.settings['account-rotator'].disclosure.en, R.DISCLOSURE_FALLBACK.en]) {
    for (const re of [/Paperclip/, /tool calls/, /5 minutes/, /setup token/, /whole shell/]) assert.ok(re.test(text), re + ' in ' + text);
  }
});
t('SECRECY: no fake token in any txn record, state, handoff, log or notification of this suite', () => {
  const texts = [];
  for (const d of fs.readdirSync(ROOT).filter((x) => x.startsWith('fx-'))) {
    const home = path.join(ROOT, d, '.claude');
    for (const f of ['FORGE_ACCOUNT_ROTATION.json', 'FORGE_USAGE_GUARD_STATE.json', path.join('forge-accounts', 'txn.json'), path.join('forge-accounts', 'state.json'),
      path.join('forge-accounts', 'handoff.json'), path.join('forge-accounts', 'rotator.log')]) { const s = vault.readRaw(path.join(home, f)); if (s !== null) texts.push(s); }
  }
  assert.ok(texts.length > 30, 'scanned ' + texts.length);
  const blob = texts.join('\n');
  for (const s of SECRETS) assert.ok(!blob.includes(s), 'secret leaked');
});
