#!/usr/bin/env node
'use strict';
// account-rotator-orgblock.test.cjs — WP SA-ROTATOR-ORGBLOCK (incident 2026-11-04): `launch --account bussins` started
// Claude Code, which answered "Your organization has disabled Claude subscription access for Claude Code", while
// `status` had shown bussins as "estimated · bruikbaar/usable" (weekly 0 %, reset passed — an estimate, never a live
// reading). Pins: (1) an orgBlocked slot flag excluded from eligibility, recommendation and launch --auto, refused by
// launch --account unless --force; (2) mark-blocked / unblock touch state only; (3) the status label; (4) an estimate
// whose reset passed (or whose token was refused since) is "niet getest / untested", never usable, never chosen;
// (5) launch inherits stdio, so it can only HINT after an early failed exit — it never sets the flag by guessing.
// HERMETIC: fresh os.tmpdir() fixtures, FAKE tokens, network stubbed or denied; the real ~/.claude is never touched.
const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-orgblk-'));
process.env.FORGE_CONFIG_HOME = path.join(ROOT, 'cfg-home');
process.env.FORGE_PROJECT_ROOT = path.join(ROOT, 'cfg-proj');
process.env.FORGE_USAGE_GUARD_HOME = path.join(ROOT, 'guard-trap', '.claude');
process.env.FORGE_ACCOUNT_ROTATOR_HOME = path.join(ROOT, 'rot-trap', '.claude');
process.env.FORGE_USAGE_GUARD_DENY_NETWORK = '1';
process.env.FORGE_ACCOUNT_ROTATOR_DENY_NETWORK = '1';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
assert.notStrictEqual(path.resolve(process.env.FORGE_ACCOUNT_ROTATOR_HOME), path.join(os.homedir(), '.claude'));

const core = require('./account-rotator-core.cjs');
const vault = require('./account-rotator-vault.cjs');
const txn = require('./account-rotator-txn.cjs');
const R = require('./account-rotator.cjs');
const cli = require('./account-rotator-cli.cjs');
const guard = require('./usage-guard.cjs');

let passed = 0; let failed = 0;
function t(name, fn) { test(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const NOW = Date.parse('2026-11-04T21:45:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const rnd = () => crypto.randomBytes(10).toString('hex');
const SECRETS = new Set();
function fakeAccount(n) {
  const a = { name: n, uuid: 'uuid-' + n + '-' + rnd(), email: n + '.owner@example.com', at: 'FAKE-AT-' + n + '-' + rnd(), rt: 'FAKE-RT-' + n + '-' + rnd(), expiresAt: NOW + 6 * 3600e3, setup: 'FAKE-SETUP-' + n + '-' + rnd() };
  SECRETS.add(a.at); SECRETS.add(a.rt); SECRETS.add(a.setup);
  return a;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(ROOT, 'fx-'));
  const home = path.join(root, '.claude');
  fs.mkdirSync(home, { recursive: true });
  const env = Object.assign({}, process.env, { FORGE_ACCOUNT_ROTATOR_HOME: home, FORGE_ACCOUNT_ROTATOR_PROFILE: path.join(root, '.claude.json'), FORGE_USAGE_GUARD_HOME: home });
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  return { root, home, env, P: vault.paths(env) };
}
function login(fx, a) {
  fs.writeFileSync(fx.P.creds, JSON.stringify({ claudeAiOauth: { accessToken: a.at, refreshToken: a.rt, expiresAt: a.expiresAt, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }));
  fs.writeFileSync(fx.P.profile, JSON.stringify({ oauthAccount: { accountUuid: a.uuid, emailAddress: a.email, organizationUuid: 'org-' + a.name } }, null, 2) + '\n');
}
function resp(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function usage(session, week) {
  const sr = iso(NOW + 2 * 3600e3); const wr = iso(NOW + 3 * 86400e3);
  return { limits: [{ kind: 'session', group: 'session', percent: session, resets_at: sr }, { kind: 'weekly_all', group: 'weekly', percent: week, resets_at: wr }], five_hour: { utilization: session, resets_at: sr }, seven_day: { utilization: week, resets_at: wr } };
}
function fetchStub(map) {
  return async (url, init) => {
    const tok = String(init.headers.authorization || '').replace(/^Bearer /, '');
    const r = map[tok];
    if (r === undefined) return resp(401, {});
    if (r && r.status) return resp(r.status, r.body || {});
    return resp(200, r);
  };
}
function fakeGuard(fx) {
  const stateFile = path.join(fx.home, 'FORGE_USAGE_GUARD_STATE.json');
  return {
    unresolvedPausedAgents: () => [], allAgents: async () => [], pc: async () => ({ status: 200, json: {} }), journalAppend() {}, compactJournalIfNeeded() {},
    readAccountIdentity: () => ({ fp: null }), resolveGuardLanguage: () => 'en', withStateLock: async (fn) => ({ ok: true, value: await fn(() => true) }),
    readState: () => ({ mode: 'ok' }), stateLockPath: () => stateFile + '.lock',
    readPidRecordFrom: guard.readPidRecordFrom, claimWatcherSlot: guard.claimWatcherSlot, releaseWatcherSlot: guard.releaseWatcherSlot, awaitChildClaim: guard.awaitChildClaim, ownsPid: guard.ownsPid,
  };
}
const OUT = [];
async function runCli(fx, argv, extra) {
  const out = []; const err = [];
  const code = await cli.main(argv, Object.assign({ env: fx.env, P: fx.P, now: () => NOW, out: (s) => out.push(vault.scrub(s)), err: (s) => err.push(vault.scrub(s)),
    guard: fakeGuard(fx), userEnvHas: () => false, quiet: true, readStdin: async () => '', settleMs: 0, ownsPid: () => ({ ok: false, code: 'dead', reason: 'x' }) }, extra || {}));
  const r = { code, out: out.join('\n'), err: err.join('\n'), all: out.concat(err).join('\n') };
  OUT.push(r.all);
  return r;
}
async function tokenSlot(fx, name) { const a = fakeAccount(name); const r = await runCli(fx, ['enroll-token', name], { readStdin: async () => a.setup }); assert.strictEqual(r.code, 0, r.all); return a; }
const liveTr = (pct) => ({ windows: [{ id: 'weekly_all', kind: 'weekly_all', label: 'weekly_all', pct, resetsAt: iso(NOW + 2 * 86400e3) }], measuredAt: iso(NOW - 60e3), source: 'live', unmeasurable: null });
// the bussins shape from the incident: last live reading weeks ago, every reset passed since, the setup token now refused (403)
const staleTr = () => ({ windows: [{ id: 'session', kind: 'session', label: 'session', pct: 0, resetsAt: iso(NOW - 10 * 86400e3) }, { id: 'weekly_all', kind: 'weekly_all', label: 'weekly_all', pct: 7, resetsAt: iso(NOW - 7 * 86400e3) }],
  measuredAt: iso(NOW - 11 * 86400e3), source: 'live', unmeasurable: { at: iso(NOW - 7 * 3600e3), status: 403 } });
const shaOf = (s) => crypto.createHash('sha256').update(s).digest('hex');
const spawnSpy = () => { const s = async (bin, args, env) => { s.calls.push(shaOf(env.CLAUDE_CODE_OAUTH_TOKEN || '')); return { code: 0 }; }; s.calls = []; return s; };

// ---- 4) an estimate is never "usable" -------------------------------------------------------------------------
t('ORG-1 core: a reading whose reset passed is "untested" (usable null), also when the token was refused since; a fresh live reading stays usable', () => {
  const adj = core.effectiveReading({ windows: [{ id: 'w', kind: 'weekly_all', label: 'weekly_all', pct: 40, resetsAt: iso(NOW - 60e3) }], measuredAt: iso(NOW - 3 * 86400e3), source: 'live' }, NOW);
  assert.strictEqual(adj.status, 'estimated');
  const j = core.judge(adj, 92);
  assert.deepStrictEqual([j.usable, j.untested], [null, true], JSON.stringify(j));
  const refused = core.effectiveReading({ windows: [{ id: 'w', kind: 'weekly_all', label: 'weekly_all', pct: 10, resetsAt: iso(NOW + 86400e3) }], measuredAt: iso(NOW - 3600e3), source: 'live', unmeasurable: { at: iso(NOW - 60e3), status: 403 } }, NOW);
  assert.deepStrictEqual([core.judge(refused, 92).usable, core.judge(refused, 92).untested], [null, true]);
  const live = core.effectiveReading(liveTr(30), NOW);
  assert.deepStrictEqual([live.status, core.judge(live, 92).usable, !!core.judge(live, 92).untested], ['live', true, false]);
});
t('ORG-2 core: with skipUntested (token mode) selectTarget never picks an untested account, not even as the last resort; file mode still ranks it (it verifies live)', () => {
  const untested = { name: 'u', eligible: true, reading: core.effectiveReading(staleTr(), NOW) };
  const s = core.selectTarget({ accounts: [untested], activeName: null, threshold: 92, now: NOW, skipUntested: true });
  assert.strictEqual(s.target, null, JSON.stringify(s));
  assert.ok(s.skipped.some((x) => x.name === 'u' && x.why === 'untested'), JSON.stringify(s.skipped));
  const s2 = core.selectTarget({ accounts: [untested, { name: 'l', eligible: true, reading: core.effectiveReading(liveTr(50), NOW) }], activeName: null, threshold: 92, now: NOW, skipUntested: true });
  assert.strictEqual(s2.target, 'l');
  const file = core.selectTarget({ accounts: [untested], activeName: null, threshold: 92, now: NOW });
  assert.deepStrictEqual([file.target, file.tier], ['u', 'clear'], 'file mode: the documented reset-then-verify-live switch is unchanged');
});
t('ORG-3 status/list: the incident shape shows "niet getest / untested", never "bruikbaar/usable"', async () => {
  const fx = fixture(); await tokenSlot(fx, 'bussins');
  await vault.updateState(fx.P, (s) => { s.tokenReadings.bussins = staleTr(); });
  const l = await runCli(fx, ['list']);
  const line = l.out.split('\n').find((x) => /bussins/.test(x));
  assert.ok(/niet getest \/ untested/.test(line), line);
  assert.ok(!/bruikbaar\/usable/.test(line), line);
});
t('ORG-4 launch --auto never picks an untested account; alone it refuses (exit 3, no session started)', async () => {
  const fx = fixture(); const b = await tokenSlot(fx, 'bussins'); const o = await tokenSlot(fx, 'oac');
  await vault.updateState(fx.P, (s) => { s.tokenReadings.bussins = staleTr(); s.tokenReadings.oac = liveTr(59); });
  const spy = spawnSpy();
  const r = await runCli(fx, ['launch', '--auto', '--', 'x'], { fetch: fetchStub({ [b.setup]: { status: 403 }, [o.setup]: usage(10, 59) }), claudeBin: 'unused', spawnClaude: spy });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(spy.calls, [shaOf(o.setup)], 'the live account, not the estimate');
  const fx2 = fixture(); const b2 = await tokenSlot(fx2, 'bussins');
  await vault.updateState(fx2.P, (s) => { s.tokenReadings.bussins = staleTr(); });
  const spy2 = spawnSpy();
  const r2 = await runCli(fx2, ['launch', '--auto', '--', 'x'], { fetch: fetchStub({ [b2.setup]: { status: 403 } }), claudeBin: 'unused', spawnClaude: spy2 });
  assert.strictEqual(r2.code, 3, r2.all);
  assert.strictEqual(spy2.calls.length, 0);
  assert.ok(/niet getest|untested/.test(r2.err), r2.err);
});

// ---- 1-3) the orgBlocked flag -----------------------------------------------------------------------------------
t('ORG-5 mark-blocked: validates name and reason, writes ONLY state.slotFlags[name].orgBlocked {at, reason}; the slot file is byte-identical', async () => {
  const fx = fixture(); await tokenSlot(fx, 'bussins');
  const before = fs.readFileSync(vault.slotPath(fx.P, 'bussins'));
  assert.strictEqual((await runCli(fx, ['mark-blocked', 'nobody', '--reason', 'x'])).code, 2);
  assert.strictEqual((await runCli(fx, ['mark-blocked', 'bussins'])).code, 2, 'a reason is required');
  const r = await runCli(fx, ['mark-blocked', 'bussins', '--reason', 'organization disabled Claude subscription access']);
  assert.strictEqual(r.code, 0, r.all);
  const f = vault.readState(fx.P).slotFlags.bussins;
  assert.deepStrictEqual([f.orgBlocked.reason, f.orgBlocked.at], ['organization disabled Claude subscription access', iso(NOW)]);
  assert.ok(fs.readFileSync(vault.slotPath(fx.P, 'bussins')).equals(before), 'tokens/credentials untouched');
  const st = await runCli(fx, ['status']);
  assert.ok(/bussins.*GEBLOKKEERD DOOR ORGANISATIE \/ BLOCKED BY ORGANIZATION/.test(st.out), st.out);
});
t('ORG-6 launch: --account on an orgBlocked slot refuses (NL/EN, exit 3) unless --force; --auto never picks it', async () => {
  const fx = fixture(); const b = await tokenSlot(fx, 'bussins'); const o = await tokenSlot(fx, 'oac');
  await vault.updateState(fx.P, (s) => { s.tokenReadings.bussins = liveTr(1); s.tokenReadings.oac = liveTr(59); });
  await runCli(fx, ['mark-blocked', 'bussins', '--reason', 'org disabled']);
  const f = fetchStub({ [b.setup]: usage(1, 1), [o.setup]: usage(10, 59) });
  const spy = spawnSpy();
  const r = await runCli(fx, ['launch', '--account', 'bussins', '--', 'x'], { fetch: f, claudeBin: 'unused', spawnClaude: spy });
  assert.strictEqual(r.code, 3, r.all);
  assert.ok(/GEBLOKKEERD DOOR ORGANISATIE/.test(r.err) && /BLOCKED BY ORGANIZATION/.test(r.err) && /--force/.test(r.err), r.err);
  assert.strictEqual(spy.calls.length, 0);
  const auto = await runCli(fx, ['launch', '--auto', '--', 'x'], { fetch: f, claudeBin: 'unused', spawnClaude: spy });
  assert.strictEqual(auto.code, 0, auto.all);
  assert.deepStrictEqual(spy.calls, [shaOf(o.setup)], 'the lower-usage but blocked account is never chosen');
  const forced = await runCli(fx, ['launch', '--account', 'bussins', '--force', '--', 'x'], { fetch: f, claudeBin: 'unused', spawnClaude: spy });
  assert.strictEqual(forced.code, 0, forced.all);
  assert.strictEqual(spy.calls[1], shaOf(b.setup));
});
t('ORG-7 recommend (token-mode tick): an orgBlocked account is never recommended, and a blocked LAST launch is not the "current" session', async () => {
  const fx = fixture(); const b = await tokenSlot(fx, 'bussins'); const o = await tokenSlot(fx, 'oac'); const z = await tokenSlot(fx, 'zeeco');
  await vault.updateState(fx.P, (s) => { s.tokenReadings.bussins = Object.assign(liveTr(1), { lastUsedAt: iso(NOW - 30e3) }); s.tokenReadings.oac = liveTr(40); s.tokenReadings.zeeco = Object.assign(liveTr(96), { lastUsedAt: iso(NOW - 60e3) }); });
  await runCli(fx, ['mark-blocked', 'bussins', '--reason', 'org disabled']);
  const S = R.resolveSettings([], {});
  const r = await R.tick({ P: fx.P, S, dryRun: true, deps: { now: () => NOW, quiet: true, guard: fakeGuard(fx), settleMs: 0, fetch: fetchStub({ [b.setup]: usage(1, 1), [o.setup]: usage(10, 40), [z.setup]: usage(10, 96) }) } });
  assert.deepStrictEqual([r.action, r.to], ['would-recommend', 'oac'], JSON.stringify(r));
});
t('ORG-8 file mode: an orgBlocked slot is not eligible for an automatic switch and preflight refuses it without force', async () => {
  const fx = fixture(); const a = fakeAccount('fa'); const b = fakeAccount('fb');
  for (const x of [b, a]) { login(fx, x); assert.strictEqual((await runCli(fx, ['enroll', x.name])).code, 0); }
  await runCli(fx, ['mark-blocked', 'fb', '--reason', 'org disabled']);
  const S = R.resolveSettings(['--mode', 'file'], {});
  const d = { now: () => NOW, quiet: true, guard: fakeGuard(fx), settleMs: 0, userEnvHas: () => false, fetch: fetchStub({ [a.at]: usage(99, 1), [b.at]: usage(1, 1) }) };
  const r = await R.tick({ P: fx.P, S, dryRun: true, deps: d });
  assert.notStrictEqual(r.to, 'fb', JSON.stringify(r));
  assert.strictEqual(r.action, 'wait', JSON.stringify(r));
  const pf = await txn.preflight(fx.P, 'fb', { settleMs: 0, slotFlags: vault.readState(fx.P).slotFlags });
  assert.strictEqual(pf.ok, false);
  assert.ok(/organi[sz]ation/i.test(pf.reason), pf.reason);
});
t('ORG-9 unblock removes only orgBlocked (other flags stay); enroll of the same account keeps orgBlocked', async () => {
  const fx = fixture(); const a = fakeAccount('ua');
  login(fx, a); await runCli(fx, ['enroll', 'ua']);
  await runCli(fx, ['mark-blocked', 'ua', '--reason', 'org disabled']);
  assert.strictEqual((await runCli(fx, ['enroll', 'ua', '--force'])).code, 0);
  assert.ok(vault.readState(fx.P).slotFlags.ua && vault.readState(fx.P).slotFlags.ua.orgBlocked, 're-enrolling the same account does not lift an organization policy');
  await vault.updateState(fx.P, (s) => { s.slotFlags.ua.needsRelogin = true; });
  assert.strictEqual((await runCli(fx, ['unblock', 'nobody'])).code, 2);
  const r = await runCli(fx, ['unblock', 'ua']);
  assert.strictEqual(r.code, 0, r.all);
  const fl = vault.readState(fx.P).slotFlags.ua;
  assert.deepStrictEqual([!!fl.orgBlocked, fl.needsRelogin], [false, true]);
});

// ---- 5) launch cannot read the child's output (stdio inherited): a hint, never a guessed flag ---------------------
t('ORG-10 launch: an early failed exit prints a mark-blocked hint but does NOT set orgBlocked by itself', async () => {
  const fx = fixture(); await tokenSlot(fx, 'bussins');
  await vault.updateState(fx.P, (s) => { s.tokenReadings.bussins = liveTr(1); });
  const r = await runCli(fx, ['launch', '--account', 'bussins', '--', 'x'], { claudeBin: 'unused', spawnClaude: async () => ({ code: 1 }) });
  assert.strictEqual(r.code, 1, r.all);
  assert.ok(/mark-blocked bussins --reason/.test(r.err), r.err);
  const fl = vault.readState(fx.P).slotFlags.bussins;
  assert.ok(!(fl && fl.orgBlocked), 'never set from a guess');
});
t('ORG-11 SECRECY: no fake token or refresh token in any output, state or log of this suite', () => {
  const texts = OUT.slice();
  for (const d of fs.readdirSync(ROOT).filter((x) => x.startsWith('fx-'))) {
    for (const f of ['state.json', 'rotator.log', 'handoff.json']) { const s = vault.readRaw(path.join(ROOT, d, '.claude', 'forge-accounts', f)); if (s !== null) texts.push(s); }
  }
  assert.ok(texts.length > 10, 'scanned ' + texts.length);
  const blob = texts.join('\n');
  for (const s of SECRETS) assert.ok(!blob.includes(s), 'secret leaked');
});
