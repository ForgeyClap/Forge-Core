#!/usr/bin/env node
'use strict';
// account-rotator-verify.test.cjs — escalation-round regression tests for: one test
// (or more) per Codex VERIFICATION finding AR-V01..AR-V11, named by ID, with crash / interleaving injection where the
// finding describes a probe, plus the token-mode default and the launch/env argument hardening. HERMETIC: temp dirs,
// FAKE logins, network stubbed or denied; the real ~/.claude, ~/.claude.json and api.anthropic.com are never touched.
const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-rot-verify-'));
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
const handoff = require('./account-rotator-handoff.cjs');
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
    expiresAt: opts && opts.expired ? NOW - 3600e3 : NOW + 6 * 3600e3, setup: 'FAKE-SETUP-' + n + '-' + rnd(),
    // per-account reset times: reset times are per-account facts, so every fake account gets its own
    sr: iso(NOW + (1 + (opts && opts.offsetMin ? opts.offsetMin : 0)) * 3600e3 + 60e3 * (n.length)), wr: iso(NOW + 3 * 86400e3 + 3600e3 * (n.charCodeAt(n.length - 1) % 24)) };
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
function enrollToken(fx, a) { vault.writeSlot(fx.P, { name: a.name, token: a.setup, tokenBinding: { status: 'standalone', at: iso(NOW) }, tokenEnrolledAt: iso(NOW) }); }
function setup(accts, activeName) { const fx = fixture(); for (const a of accts) enroll(fx, a); login(fx, accts.find((a) => a.name === activeName)); return fx; }
function resp(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
/** usage(a, session, week) — the usage endpoint's shape with account `a`'s OWN reset times. */
function usage(a, session, week) {
  return { limits: [{ kind: 'session', group: 'session', percent: session, resets_at: a.sr }, { kind: 'weekly_all', group: 'weekly', percent: week, resets_at: a.wr }] };
}
function fetchStub(map) {
  return async (url, init) => {
    assert.strictEqual(String(url), 'https://api.anthropic.com/api/oauth/usage');
    const tokn = String(init.headers.authorization).replace(/^Bearer /, '');
    const r = typeof map === 'function' ? map(tokn) : map[tokn];
    if (r === undefined) return resp(401, {});
    if (r instanceof Error) throw r;
    if (r && r.throwOnStatus) return { get status() { throw new Error('boom while reading the response'); }, ok: true, json: async () => ({}) };
    return r && r.status ? resp(r.status, {}) : resp(200, r);
  };
}
function fakeGuard(fx, o) {
  const opts = o || {};
  const stateFile = path.join(fx.home, 'FORGE_USAGE_GUARD_STATE.json');
  const calls = []; const journal = [];
  const g = {
    calls, journal, stateFile, failLock: false,
    allAgents: async () => (opts.agents ? opts.agents() : []).map((a) => Object.assign({}, a)),
    pc: async (method, p) => { calls.push(method + ' ' + p); return opts.pc ? opts.pc(method, p) : { status: 200, json: {} }; },
    journalAppend: (r) => journal.push(r), compactJournalIfNeeded() {},
    unresolvedPausedAgents: () => journal.filter((r) => r.resolved === false && !journal.some((x) => x.agentId === r.agentId && x.pauseId === r.pauseId && x.resolved === true)),
    readAccountIdentity: () => ({ fp: null }), resolveGuardLanguage: () => 'en',
    withStateLock: async (fn) => (g.failLock ? { ok: false, reason: 'lock-timeout' } : { ok: true, value: await fn(() => true) }),
    readState: () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { mode: 'ok' }; } },
    stateLockPath: () => stateFile + '.lock',
    readPidRecordFrom: guard.readPidRecordFrom, claimWatcherSlot: guard.claimWatcherSlot, releaseWatcherSlot: guard.releaseWatcherSlot,
    awaitChildClaim: guard.awaitChildClaim, ownsPid: guard.ownsPid,
  };
  return g;
}
const FILE = () => R.resolveSettings(['--mode', 'file'], {});
const TOKEN = () => R.resolveSettings([], {});
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
const slotRT = (fx, n) => vault.readSlot(fx.P, n).credentials.claudeAiOauth.refreshToken;
const reading = (a, s, w, at, via) => R.liveReading({ windows: core.cleanWindows(guard.normalizeWindows(usage(a, s, w))) }, at, { viaSlotToken: via !== false });
/** crashAfterCredsWithRefresh(fx, target, newAt, newRt) — a REAL process: preflight + swap; right after the credentials
 *  rename it rewrites the login file with a NEW token pair (Claude Code refreshing the target) and exits 137. */
function crashAfterCredsWithRefresh(fx, target, newAt, newRt) {
  const script = path.join(fx.root, 'crash-refresh.cjs');
  fs.writeFileSync(script, 'const fs = require("fs"); const txn = require(' + JSON.stringify(path.join(__dirname, 'account-rotator-txn.cjs')) + ');\n'
    + 'const P = require(' + JSON.stringify(path.join(__dirname, 'account-rotator-vault.cjs')) + ').paths(process.env);\n'
    + '(async () => { const pf = await txn.preflight(P, process.argv[2], { settleMs: 0 }); if (!pf.ok) { console.log("PF " + pf.reason); process.exit(2); }\n'
    + '  txn.swapLogin(P, pf, { hooks: { afterCredsWrite: () => { const c = JSON.parse(fs.readFileSync(P.creds, "utf8")); c.claudeAiOauth = { accessToken: process.argv[3], refreshToken: process.argv[4], expiresAt: ' + (NOW + 8 * 3600e3) + ' }; fs.writeFileSync(P.creds, JSON.stringify(c)); process.exit(137); } } }); process.exit(0); })();\n');
  return spawnSync(process.execPath, [script, target, newAt, newRt], { env: fx.env, encoding: 'utf8', timeout: 30000 });
}

// ---- AR-V01 unknown tokens are never classified from the profile uuid --------------------------------------------
t('AR-V01 probe (real crash): the TARGET\'s credentials refreshed between the two renames -> NOT "recovered to origin", NOT captured into the origin slot; ownership established from usage readings puts the token in the TARGET slot and restores the origin', async () => {
  const a = fakeAccount('v1a'); const b = fakeAccount('v1b'); const fx = setup([a, b], 'v1a');
  const newAt = 'FAKE-AT-v1b-ref-' + rnd(); const newRt = 'FAKE-RT-v1b-ref-' + rnd(); SECRETS.add(newAt); SECRETS.add(newRt);
  const r = crashAfterCredsWithRefresh(fx, 'v1b', newAt, newRt);
  assert.strictEqual(r.status, 137, r.stdout + r.stderr);
  assert.deepStrictEqual([credsRT(fx), profUuid(fx)], [newRt, a.uuid], 'the probe state: an unknown token in the login file, the profile still naming the origin');
  const rec = txn.reconcile(fx.P);
  assert.deepStrictEqual([rec.action, rec.cls], ['unresolved', 'unknown'], JSON.stringify(rec));
  assert.strictEqual(credsRT(fx), newRt, 'nothing replaced');
  assert.strictEqual(slotRT(fx, 'v1a'), a.rt, 'the origin slot did NOT capture the target\'s token');
  // both slots have their own recent readings (taken with their own stored tokens); the new token measures like b
  await vault.updateState(fx.P, (s) => { s.readings.v1a = reading(a, 95, 10, NOW - 60e3); s.readings.v1b = reading(b, 5, 5, NOW - 60e3); });
  // the origin now measures BELOW the threshold so this tick only repairs (a tick that then switches again is legitimate but would blur the assertion)
  const f = fetchStub((tk) => (tk === newAt ? usage(b, 6, 5) : tk === a.at ? usage(a, 50, 10) : undefined));
  const r2 = await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f }) });
  assert.deepStrictEqual([r2.action, r2.reason], ['none', 'below-threshold'], JSON.stringify(r2));
  assert.deepStrictEqual([slotRT(fx, 'v1b'), slotRT(fx, 'v1a')], [newRt, a.rt], 'captured into the TARGET slot only: ' + JSON.stringify(r2));
  assert.strictEqual(readJson(path.join(fx.P.vault, 'v1b.prev.json')).credentials.claudeAiOauth.refreshToken, b.rt, 'previous generation kept');
  assert.deepStrictEqual([credsRT(fx), profUuid(fx)], [a.rt, a.uuid], 'the half-done swap was rolled back to the origin login');
  assert.strictEqual(readJson(fx.P.txn).outcome, 'recovered-back');
  assert.ok(/REPAIR — the unknown login was established as v1b \(usage-readings\)/.test(vault.readRaw(fx.P.log)));
  assert.ok(readJson(fx.P.txn).fp && !JSON.stringify(readJson(fx.P.txn)).includes(b.rt) && !JSON.stringify(readJson(fx.P.txn)).includes(newRt), 'txn.json holds fingerprints, never a token');
});
t('AR-V01: a failed or missing identification never authorises a capture; a usage-reading match with BOTH slots is inconclusive', async () => {
  const a = fakeAccount('v2a'); const b = fakeAccount('v2b'); const fx = setup([a, b], 'v2a');
  const rotated = 'FAKE-RT-v2a-rot-' + rnd(); SECRETS.add(rotated);
  const c = readJson(fx.P.creds); c.claudeAiOauth.refreshToken = rotated; fs.writeFileSync(fx.P.creds, JSON.stringify(c));
  const slot = vault.readSlot(fx.P, 'v2a');
  for (const identify of [undefined, async () => null, async () => { throw new Error('endpoint down'); }]) {
    const r = await txn.corroboratedCapture(fx.P, slot, { settleMs: 0, identify });
    assert.strictEqual(r.captured, false, String(identify));
    assert.ok(/no independent proof/.test(r.reason), r.reason);
  }
  assert.strictEqual(slotRT(fx, 'v2a'), a.rt);
  // the new token's readings match the readings of BOTH enrolled accounts (same reset times) -> nothing is concluded
  const same = { windows: core.cleanWindows(guard.normalizeWindows(usage(a, 10, 10))) };
  const both = { v2a: R.liveReading(same, NOW - 60e3, { viaSlotToken: true }), v2b: R.liveReading(same, NOW - 60e3, { viaSlotToken: true }) };
  const live = vault.readLive(fx.P);
  const p1 = await txn.ownershipProof(fx.P, slot, live.creds.claudeAiOauth, { now: NOW, readings: both, measure: async () => ({ ok: true, windows: same.windows }) });
  assert.strictEqual(p1.ok, true, 'one slot in isolation matches');
  fs.writeFileSync(fx.P.txn, JSON.stringify({ version: 2, id: 'x', phase: 'unresolved', from: 'v2a', to: 'v2b', fp: {} }));
  const rp = await txn.repairUnresolved(fx.P, { now: NOW, readings: both, measure: async () => ({ ok: true, windows: same.windows }) });
  assert.strictEqual(rp.action, 'unresolved');
  assert.ok(/BOTH accounts/.test(rp.reason), rp.reason);
  assert.deepStrictEqual([slotRT(fx, 'v2a'), slotRT(fx, 'v2b')], [a.rt, b.rt], 'nothing captured');
  // a reading NOT taken with the slot's own token can never vouch
  const p2 = await txn.ownershipProof(fx.P, slot, live.creds.claudeAiOauth, { now: NOW, readings: { v2a: R.liveReading(same, NOW - 60e3, { viaSlotToken: false }) }, measure: async () => ({ ok: true, windows: same.windows }) });
  assert.strictEqual(p2.ok, false);
});

// ---- AR-V02 the profile is validated against the transaction before every write ------------------------------------
t('AR-V02 probe: a third account\'s login inserted into the profile after the credentials rename is never overwritten -> unresolved, origin login restored', async () => {
  const a = fakeAccount('v3a'); const b = fakeAccount('v3b'); const fx = setup([a, b], 'v3a');
  const pf = await txn.preflight(fx.P, 'v3b', { settleMs: 0 });
  const r = txn.swapLogin(fx.P, pf, { hooks: { afterCredsWrite: () => {
    const p = readJson(fx.P.profile); p.oauthAccount = { accountUuid: 'third-' + rnd(), emailAddress: 'third@example.com' }; fs.writeFileSync(fx.P.profile, JSON.stringify(p, null, 2) + '\n');
  } } });
  assert.deepStrictEqual([r.ok, r.unresolved, r.cls], [false, true, 'foreign'], JSON.stringify(r));
  assert.ok(/names another account/.test(r.reason), r.reason);
  assert.ok(/^third-/.test(profUuid(fx)), 'the third account\'s profile entry survives untouched');
  assert.strictEqual(credsRT(fx), a.rt, 'our own credentials write was rolled back (it still held exactly what we wrote)');
  assert.strictEqual(readJson(fx.P.txn).phase, 'unresolved');
  assert.strictEqual(txn.reconcile(fx.P).action, 'unresolved', 'reconcile does nothing destructive either');
});

// ---- AR-V03 best-effort rename: detected and repaired, honestly described ------------------------------------------
t('AR-V03 interleaving: foreign content landing right after our rename is detected by the post-write re-read — the swap stops before the profile is touched, the newer login is kept', async () => {
  const a = fakeAccount('v4a'); const b = fakeAccount('v4b'); const fx = setup([a, b], 'v4a');
  const newer = 'FAKE-RT-v4-newer-' + rnd(); SECRETS.add(newer);
  const profileBefore = fs.readFileSync(fx.P.profile, 'utf8');
  const pf = await txn.preflight(fx.P, 'v4b', { settleMs: 0 });
  let renames = 0;
  const r = txn.swapLogin(fx.P, pf, { hooks: { renameImpl: (tmp, file) => {
    fs.renameSync(tmp, file);
    if (++renames === 1) { const c = readJson(file); c.claudeAiOauth = { accessToken: 'FAKE-AT-v4-newer', refreshToken: newer, expiresAt: NOW + 8 * 3600e3 }; fs.writeFileSync(file, JSON.stringify(c)); }
  } } });
  assert.deepStrictEqual([r.ok, r.unresolved, r.cls], [false, true, 'unknown'], JSON.stringify(r));
  assert.ok(/changed right after our write/.test(r.reason), r.reason);
  assert.strictEqual(credsRT(fx), newer, 'the newer login is never overwritten with stale bytes');
  assert.strictEqual(fs.readFileSync(fx.P.profile, 'utf8'), profileBefore, 'the profile was never written');
});
t('AR-V03 wording: nowhere is the file swap called atomic compare-and-swap; it is described as best-effort, detected and repaired', () => {
  const srcFiles = ['account-rotator.cjs', 'account-rotator-cli.cjs', 'account-rotator-core.cjs', 'account-rotator-vault.cjs', 'account-rotator-handoff.cjs', 'account-rotator-txn.cjs', 'account-rotator-measure.cjs', 'account-rotator-token.cjs', 'account-rotator-recommend.cjs'];
  for (const f of srcFiles) assert.ok(!/compare-and-swap|atomic compare/i.test(fs.readFileSync(path.join(__dirname, f), 'utf8')), f);
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Account rotator'), readme.indexOf('## Notes'));
  assert.ok(section.length > 500 && !/compare-and-swap|atomic/i.test(section), 'README section does not claim atomicity');
  assert.ok(/best-effort/.test(section) && /experiment/.test(section), 'README says best-effort + experimental');
  const schema = readJson(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'));
  assert.ok(/ONLY in the experimental file mode/.test(schema.settings['account-rotator'].disclosure.en));
  assert.ok(/best-effort/.test(schema.settings['account-rotator.mode'].desc.en));
  assert.ok(/best-effort/i.test(fs.readFileSync(path.join(__dirname, 'account-rotator-txn.cjs'), 'utf8')));
});

// ---- AR-V04 enrolment and removal under the lock -------------------------------------------------------------------
t('AR-V04: enroll-token measures outside the lock but re-reads + re-validates + writes INSIDE it; a slot that changed meanwhile is refused; a held lock refuses; remove re-checks eligibility inside the lock', async () => {
  const a = fakeAccount('v5a'); const fx = setup([a], 'v5a');
  const other = 'FAKE-RT-v5a-other-' + rnd(); SECRETS.add(other);
  let measured = 0;
  const f = async (url, init) => {
    if (++measured === 1) { const s = vault.readSlot(fx.P, 'v5a'); s.credentials.claudeAiOauth.refreshToken = other; vault.writeSlot(fx.P, s); } // the slot changes during the network call
    return resp(200, usage(a, 10, 10));
  };
  const r1 = await runCli(fx, ['enroll-token', 'v5a'], { readStdin: async () => a.setup, fetch: f });
  assert.strictEqual(r1.code, 3, r1.all);
  assert.ok(/changed during enrolment/.test(r1.err), r1.err);
  assert.strictEqual(vault.readSlot(fx.P, 'v5a').token, null, 'nothing written');
  let release; const held = new Promise((r) => { release = r; });
  const holder = vault.withTxnLock(fx.P, () => held, { timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 50));
  const r2 = await runCli(fx, ['enroll-token', 'v5a'], { readStdin: async () => a.setup, fetch: fetchStub({ [a.setup]: usage(a, 10, 10), [a.at]: usage(a, 10, 10) }), enrollLockMs: 300 });
  assert.strictEqual(r2.code, 1, r2.all);
  assert.ok(/busy/.test(r2.err));
  release(); await holder;
  assert.strictEqual(vault.readSlot(fx.P, 'v5a').token, null);
  const r3 = await runCli(fx, ['remove', 'v5a']);
  assert.strictEqual(r3.code, 3, 'the active account is refused inside the lock');
  assert.ok(vault.readSlot(fx.P, 'v5a'));
  assert.strictEqual((await runCli(fx, ['remove', 'v5a', '--force'])).code, 0);
  assert.strictEqual(vault.readSlot(fx.P, 'v5a'), null);
});

// ---- AR-V05 per-hop outcome, exceptions derived from the durable transaction ---------------------------------------
t('AR-V05 probe: commit B (exhausted) -> commit C -> exception during C\'s measurement => ok:false, outcome unmeasurable-fallback, committed C, active null, pending verification for C', async () => {
  const a = fakeAccount('v6a'); const b = fakeAccount('v6b', { expired: true }); const c = fakeAccount('v6c', { expired: true }); const fx = setup([a, b, c], 'v6a');
  await vault.updateState(fx.P, (s) => { s.readings.v6b = reading(b, 10, 10, NOW - 3600e3); s.readings.v6c = reading(c, 20, 20, NOW - 3600e3); });
  const f = fetchStub((tk) => (tk === a.at ? usage(a, 95, 10) : tk === b.at ? usage(b, 96, 10) : tk === c.at ? { throwOnStatus: true } : undefined));
  const r = await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f }) });
  assert.deepStrictEqual([r.ok, r.outcome, r.committedTo, r.to, r.action], [false, 'unmeasurable-fallback', 'v6c', null, 'switched-unverified'], JSON.stringify(r));
  assert.strictEqual(r.hops.length, 2);
  const st = vault.readState(fx.P);
  assert.notStrictEqual(st.active, 'v6c');
  assert.strictEqual(st.pendingVerify.to, 'v6c');
  assert.strictEqual(st.swaps.length, 2, 'both physical commits recorded');
  assert.ok(!(deps(fx).guard.readState().resumeNotice), 'no CONTINUE');
});
t('AR-V05: a handoff-file write failure right after the swap commits is NOT reported verified — derived from the durable transaction as committed-but-unverified', async () => {
  const a = fakeAccount('v7a'); const b = fakeAccount('v7b'); const fx = setup([a, b], 'v7a');
  const f = fetchStub({ [a.at]: usage(a, 95, 10), [b.at]: usage(b, 5, 5) });
  const r = await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f, swapHooks: { afterProfileWrite: () => { try { fs.unlinkSync(fx.P.handoff); } catch { /* none */ } fs.mkdirSync(fx.P.handoff); } } }) });
  assert.deepStrictEqual([r.ok, r.outcome, r.committedTo, r.to], [false, 'unmeasurable-fallback', 'v7b', null], JSON.stringify(r));
  assert.strictEqual(credsRT(fx), b.rt, 'the swap really committed');
  assert.strictEqual(vault.readState(fx.P).pendingVerify.to, 'v7b');
  assert.notStrictEqual(vault.readState(fx.P).active, 'v7b');
  fs.rmdirSync(fx.P.handoff);
});

// ---- AR-V06 deferred verification obeys the threshold rules and reports the notice write honestly ------------------
t('AR-V06: a deferred verification that measures OVER the threshold is "verified but exhausted" — active set, NO CONTINUE; a failed CONTINUE write is reported as not written', async () => {
  const a = fakeAccount('v8a'); const b = fakeAccount('v8b'); const fx = setup([a, b], 'v8b');
  await vault.updateState(fx.P, (s) => { s.pendingVerify = { to: 'v8b', from: 'v8a', at: iso(NOW - 60e3), auto: true, failures: 0, credsGen: vault.generation(fx.P.creds), trigger: [] }; });
  const d = deps(fx, { fetch: fetchStub({ [b.at]: usage(b, 97, 10) }) });
  const r = await R.tick({ P: fx.P, S: FILE(), deps: d });
  assert.deepStrictEqual([r.action, r.exhausted, r.continueWritten], ['verified', true, false], JSON.stringify(r));
  assert.strictEqual(vault.readState(fx.P).active, 'v8b');
  assert.ok(!d.guard.readState().resumeNotice, 'no CONTINUE while over the threshold');
  assert.ok(/EXHAUSTED/.test(vault.readRaw(fx.P.log)));
  const fx2 = setup([a, b], 'v8b');
  await vault.updateState(fx2.P, (s) => { s.pendingVerify = { to: 'v8b', from: 'v8a', at: iso(NOW - 60e3), auto: true, failures: 0, credsGen: vault.generation(fx2.P.creds), trigger: [] }; });
  const d2 = deps(fx2, { fetch: fetchStub({ [b.at]: usage(b, 5, 5) }) });
  d2.guard.failLock = true;
  const r2 = await R.tick({ P: fx2.P, S: FILE(), deps: d2 });
  assert.deepStrictEqual([r2.action, r2.continueWritten], ['verified', false], JSON.stringify(r2));
  assert.ok(/CONTINUE NIET geschreven \/ NOT written \(lock-timeout\)/.test(vault.readRaw(fx2.P.log)), 'the log never claims a CONTINUE that was not written');
});

// ---- AR-V07 owner precedence, bounded pending states, superseding ---------------------------------------------------
t('AR-V07: an owner-requested switch takes precedence over a pending verification (also to a healthy saved account with --force)', async () => {
  const a = fakeAccount('v9a'); const b = fakeAccount('v9b'); const c = fakeAccount('v9c'); const fx = setup([a, b, c], 'v9b');
  await vault.updateState(fx.P, (s) => { s.pendingVerify = { to: 'v9b', from: 'v9a', at: iso(NOW - 60e3), auto: true, failures: 1, credsGen: vault.generation(fx.P.creds), trigger: [] }; s.slotFlags.v9c = { needsRelogin: true, at: iso(NOW) }; });
  const f = fetchStub({ [b.at]: { status: 401 }, [c.at]: usage(c, 5, 5) });
  const r = await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f }), manual: { target: 'v9c' }, force: true });
  assert.deepStrictEqual([r.action, r.to], ['switched', 'v9c'], JSON.stringify(r));
  assert.strictEqual(credsRT(fx), c.rt);
  assert.strictEqual(vault.readState(fx.P).pendingVerify, null);
});
t('AR-V07: a login that stays unauthorized is bounded — after PENDING_VERIFY_MAX_MS "awaiting first use" turns into rollback + needs-relogin (automatic) or needs-relogin + owner notice (manual)', async () => {
  const a = fakeAccount('v10a'); const b = fakeAccount('v10b', { expired: true }); const fx = setup([a, b], 'v10b');
  await vault.updateState(fx.P, (s) => { s.pendingVerify = { to: 'v10b', from: 'v10a', at: iso(NOW - core.PENDING_VERIFY_MAX_MS - 60e3), auto: true, failures: 0, credsGen: vault.generation(fx.P.creds), trigger: [] }; });
  const f = fetchStub({ [a.at]: usage(a, 10, 10) });
  const r = await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f }) });
  assert.strictEqual(r.action, 'rolled-back-needs-relogin', JSON.stringify(r));
  assert.deepStrictEqual([credsRT(fx), profUuid(fx)], [a.rt, a.uuid]);
  assert.strictEqual(vault.readState(fx.P).slotFlags.v10b.needsRelogin, true);
  const fx2 = setup([a, b], 'v10b');
  await vault.updateState(fx2.P, (s) => { s.pendingVerify = { to: 'v10b', from: 'v10a', at: iso(NOW - core.PENDING_VERIFY_MAX_MS - 60e3), auto: false, failures: 0, credsGen: vault.generation(fx2.P.creds), trigger: [] }; });
  const r2 = await R.tick({ P: fx2.P, S: FILE(), deps: deps(fx2, { fetch: f }) });
  assert.deepStrictEqual([r2.action, r2.reason, r2.needsRelogin], ['none', 'unverified-timeout', 'v10b'], JSON.stringify(r2));
  assert.strictEqual(credsRT(fx2), b.rt, 'a manual switch is never rolled back automatically');
  assert.strictEqual(vault.readState(fx2.P).pendingVerify, null, 'no longer pending forever');
});
t('AR-V07: enrolling a (third) account while logged in supersedes an unresolved transaction; --force on a consistent login does too; neither works on an unknown token', async () => {
  const a = fakeAccount('v11a'); const b = fakeAccount('v11b'); const c = fakeAccount('v11c'); const fx = setup([a, b], 'v11a');
  fs.writeFileSync(fx.P.txn, JSON.stringify({ version: 2, id: 'old-' + rnd(), phase: 'unresolved', from: 'v11a', to: 'v11b', reason: 'probe', fp: {} }));
  login(fx, c);
  const r = await runCli(fx, ['enroll', 'v11c']);
  assert.strictEqual(r.code, 0, r.all);
  assert.ok(/unresolved swap closed/.test(r.out), r.out);
  assert.deepStrictEqual([readJson(fx.P.txn).phase, readJson(fx.P.txn).outcome], ['done', 'superseded']);
  // a transaction that only knows a and b, while the owner is logged in to a THIRD enrolled account c (consistent with slot c):
  // reconcile cannot close it (foreign to the transaction) — the owner's --force does, because the login is provably slot c's
  const fx2 = setup([a, b, c], 'v11c');
  fs.writeFileSync(fx2.P.txn, JSON.stringify({ version: 2, id: 'old-' + rnd(), phase: 'unresolved', from: 'v11a', to: 'v11b', reason: 'probe', fp: {} }));
  const f = fetchStub({ [a.at]: usage(a, 10, 10), [b.at]: usage(b, 5, 5), [c.at]: usage(c, 10, 10) });
  const r0 = await R.tick({ P: fx2.P, S: FILE(), deps: deps(fx2, { fetch: f }), manual: { target: 'v11a' } });
  assert.deepStrictEqual([r0.action, r0.reason], ['refused', 'unresolved-transaction'], 'without --force the transaction stands: ' + JSON.stringify(r0));
  const r1 = await R.tick({ P: fx2.P, S: FILE(), deps: deps(fx2, { fetch: f }), manual: { target: 'v11a' }, force: true });
  assert.deepStrictEqual([r1.action, r1.to], ['switched', 'v11a'], JSON.stringify(r1));
  assert.ok(/UNRESOLVED SWAP CLOSED/.test(vault.readRaw(fx2.P.log)));
  const fx3 = setup([a, b], 'v11a');
  fs.writeFileSync(fx3.P.txn, JSON.stringify({ version: 2, id: 'old-' + rnd(), phase: 'unresolved', from: 'v11a', to: 'v11b', reason: 'probe', fp: {} }));
  const cc = readJson(fx3.P.creds); cc.claudeAiOauth.refreshToken = 'FAKE-RT-unknown-' + rnd(); SECRETS.add(cc.claudeAiOauth.refreshToken); fs.writeFileSync(fx3.P.creds, JSON.stringify(cc));
  const r2 = await R.tick({ P: fx3.P, S: FILE(), deps: deps(fx3, { fetch: f }), manual: { target: 'v11b' }, force: true });
  assert.strictEqual(r2.reason, 'unresolved-transaction', '--force never overrides an unknown token: ' + JSON.stringify(r2));
  assert.strictEqual(readJson(fx3.P.txn).phase, 'unresolved');
});

// ---- AR-V08 ambiguous pause outcomes and persisted cleanup obligations ----------------------------------------------
t('AR-V08: an ambiguous pause response (network error / timeout) is journaled pause-unknown and reconciled against the agent\'s ACTUAL state — resumed when paused, resolved not-paused when running', async () => {
  const a = fakeAccount('v12a'); const b = fakeAccount('v12b'); const fx = setup([a, b], 'v12a');
  const agents = [{ id: 'ag1', name: 'x', company: 'c', status: 'running' }, { id: 'ag2', name: 'y', company: 'c', status: 'running' }];
  const g = fakeGuard(fx, { agents: () => agents, pc: (method, p) => {
    if (/pause$/.test(p)) { if (p.includes('ag1')) { agents[0].status = 'paused'; return { status: 0, err: 'timeout' }; } return { status: 0, err: 'ECONNRESET' }; } // ag1 applied+timed out, ag2 never applied
    if (/resume$/.test(p)) { const ag = agents.find((x) => p.includes(x.id)); ag.status = 'running'; return { status: 200 }; }
    return { status: 200 };
  } });
  const r = await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { guard: g, fetch: fetchStub({ [a.at]: usage(a, 95, 10), [b.at]: usage(b, 5, 5) }) }) });
  assert.strictEqual(r.action, 'switched', JSON.stringify(r));
  assert.deepStrictEqual(g.journal.filter((x) => x.agentId === 'ag1').map((x) => x.action), ['pause-intent', 'pause-unknown', 'resumed']);
  assert.deepStrictEqual(g.journal.filter((x) => x.agentId === 'ag2').map((x) => x.action), ['pause-intent', 'pause-unknown', 'not-paused']);
  assert.ok(g.calls.includes('POST /api/agents/ag1/resume') && !g.calls.includes('POST /api/agents/ag2/resume'));
  assert.deepStrictEqual(agents.map((x) => x.status), ['running', 'running']);
  assert.deepStrictEqual(g.unresolvedPausedAgents(), []);
});
t('AR-V08: a failed guard-notice restoration after a FAILED swap is persisted as an obligation and retried by the next reconcile', async () => {
  const a = fakeAccount('v13a'); const b = fakeAccount('v13b'); const fx = setup([a, b], 'v13a');
  const g = fakeGuard(fx);
  fs.writeFileSync(g.stateFile, JSON.stringify({ mode: 'ok', account: { fp: 'label-a' } }));
  const swapImpl = () => { g.failLock = true; return { ok: false, rolledBack: true, outcome: 'rolled-back', reason: 'simulated failure' }; };
  const r = await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { guard: g, swapImpl, fetch: fetchStub({ [a.at]: usage(a, 95, 10), [b.at]: usage(b, 5, 5) }) }) });
  assert.strictEqual(r.action, 'switch-failed');
  const h = vault.readHandoffFile(fx.P);
  assert.strictEqual(h.phase, 'rolled-back');
  assert.ok(h.obligations && h.obligations.guardRestore, 'obligation persisted: ' + JSON.stringify(h.obligations));
  assert.strictEqual(g.readState().mode, 'paused', 'the pause notice is still standing (restoration failed)');
  g.failLock = false;
  await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { guard: g, fetch: fetchStub({ [a.at]: usage(a, 10, 10) }), now: () => NOW + 600e3 }) });
  const st = g.readState();
  assert.deepStrictEqual([st.mode, st.rotatorHandoff, st.account], ['ok', undefined, { fp: 'label-a' }], 'restored by reconcile: ' + JSON.stringify(st));
  assert.ok(!vault.readHandoffFile(fx.P).obligations, 'obligation cleared');
});

// ---- AR-V09 binding needs two windows with non-null reset times --------------------------------------------------------
t('AR-V09: sameAccountReading needs >= 2 matching windows with non-null, future reset times; null resets never compare equal; a differing reset -> false; expired windows are skipped', () => {
  const w = (id, pct, resetsAt) => ({ id, kind: id, label: id, pct, resetsAt });
  const A = { windows: [w('session', 10, iso(NOW + 3600e3)), w('weekly_all', 20, iso(NOW + 86400e3))] };
  assert.strictEqual(core.sameAccountReading(A, A, { now: NOW }), true);
  assert.strictEqual(core.sameAccountReading({ windows: [A.windows[0]] }, A, { now: NOW }), null, 'one window is not enough');
  assert.strictEqual(core.sameAccountReading({ windows: [w('session', 10, null), w('weekly_all', 20, null)] }, { windows: [w('session', 10, null), w('weekly_all', 20, null)] }, { now: NOW }), null, 'null resets never compare equal');
  assert.strictEqual(core.sameAccountReading(A, { windows: [w('session', 10, iso(NOW + 7200e3)), A.windows[1]] }, { now: NOW }), false, 'a different reset time is a different account');
  assert.strictEqual(core.sameAccountReading(A, { windows: [w('session', 40, iso(NOW + 3600e3)), A.windows[1]] }, { now: NOW }), null, 'a percentage drift is inconclusive, not proof');
  const expired = { windows: [w('session', 0, iso(NOW - 60e3)), A.windows[1]] };
  assert.strictEqual(core.sameAccountReading(expired, A, { now: NOW }), null, 'an expired window is not comparable (and never "different")');
  assert.strictEqual(core.sameAccountReading(A, A, { now: NOW, pctTol: 0 }), true);
});
t('AR-V09: enroll-token binds "verified" only on two matching windows; one overlapping window needs --confirm-same-account (unverified)', async () => {
  const a = fakeAccount('v14a'); const fx = setup([a], 'v14a');
  const one = { limits: [{ kind: 'session', group: 'session', percent: 10, resets_at: a.sr }] };
  const r1 = await runCli(fx, ['enroll-token', 'v14a'], { readStdin: async () => a.setup, fetch: fetchStub({ [a.setup]: one, [a.at]: one }) });
  assert.strictEqual(r1.code, 3, r1.all);
  assert.ok(/--confirm-same-account/.test(r1.err));
  const r2 = await runCli(fx, ['enroll-token', 'v14a'], { readStdin: async () => a.setup, fetch: fetchStub({ [a.setup]: usage(a, 10, 10), [a.at]: usage(a, 11, 10) }) });
  assert.strictEqual(r2.code, 0, r2.all);
  assert.strictEqual(vault.readSlot(fx.P, 'v14a').tokenBinding.status, 'verified');
});

// ---- AR-V10 accounting keyed by transaction id with a durable obligation ---------------------------------------------
t('AR-V10: a crash between the commit and the state write leaves the obligation in txn.json; the next tick records the swap exactly once (idempotent by transaction id)', async () => {
  const a = fakeAccount('v15a'); const b = fakeAccount('v15b'); const fx = setup([a, b], 'v15a');
  const f = fetchStub({ [a.at]: usage(a, 95, 10), [b.at]: usage(b, 5, 5) });
  const r = await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f }) });
  assert.strictEqual(r.action, 'switched');
  const t0 = readJson(fx.P.txn);
  assert.strictEqual(t0.accounted, true, 'accounted once the state file took it');
  // simulate the crash: the commit is durable, the state write never happened
  await vault.updateState(fx.P, (s) => { s.swaps = []; });
  fs.writeFileSync(fx.P.txn, JSON.stringify(Object.assign({}, t0, { accounted: false })));
  await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f, now: () => NOW + 60e3 }) });
  let st = vault.readState(fx.P);
  assert.deepStrictEqual(st.swaps.map((s) => s.txnId), [t0.id], 'recovered from the obligation');
  assert.strictEqual(readJson(fx.P.txn).accounted, true);
  await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f, now: () => NOW + 120e3 }) });
  st = vault.readState(fx.P);
  assert.strictEqual(st.swaps.length, 1, 'never twice');
  // a second obligation for the SAME id while the entry already exists only marks, never duplicates
  fs.writeFileSync(fx.P.txn, JSON.stringify(Object.assign({}, t0, { accounted: false })));
  await R.tick({ P: fx.P, S: FILE(), deps: deps(fx, { fetch: f, now: () => NOW + 180e3 }) });
  assert.strictEqual(vault.readState(fx.P).swaps.length, 1);
  assert.strictEqual(readJson(fx.P.txn).accounted, true);
});

// ---- AR-V11 stop requests bound to pid + claim nonce -------------------------------------------------------------------
t('AR-V11: a stop request names the exact watcher record; a request for another pid/nonce is ignored by a real watcher; after the stop only the matching pid file is removed — a successor\'s record survives', async () => {
  const a = fakeAccount('v16a'); const b = fakeAccount('v16b'); const fx = setup([a, b], 'v16a');
  SPAWNED.push(fx.P.pid);
  const node = (args) => spawnSync(process.execPath, [path.join(__dirname, 'account-rotator.cjs'), ...args, '--mode', 'file'], { env: fx.env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(node(['start']).status, 0);
  const rec = guard.readPidRecordFrom(fx.P.pid);
  assert.ok(rec.pid && rec.nonce);
  fs.writeFileSync(fx.P.stop, JSON.stringify({ requestedAt: iso(NOW), by: 1, targetPid: rec.pid, nonce: 'not-this-watcher' }) + '\n');
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(vault.pidAlive(rec.pid), 'a stop request with another nonce is ignored');
  assert.ok(/stop request addressed to another watcher ignored/.test(vault.readRaw(fx.P.log) || ''));
  const out = [];
  const code = await cli.main(['stop'], { env: fx.env, P: fx.P, out: (s) => out.push(s), err: (s) => out.push(s), stopTimeoutMs: 20000 });
  assert.strictEqual(code, 0, out.join('\n'));
  assert.ok(!vault.pidAlive(rec.pid) && !fs.existsSync(fx.P.pid) && !fs.existsSync(fx.P.stop));
  const req = cli.readStopRequest; assert.strictEqual(typeof req, 'function');
  assert.strictEqual(cli.matchesStop({ targetPid: 5, nonce: 'n' }, { nonce: 'n' }, 5), true);
  assert.strictEqual(cli.matchesStop({ targetPid: 5, nonce: 'other' }, { nonce: 'n' }, 5), false);
  assert.strictEqual(cli.matchesStop({ targetPid: 5, nonce: null }, { nonce: 'n' }, 5), false, 'a nonce-less request never matches a nonced watcher');
  assert.strictEqual(cli.matchesStop({ targetPid: 6 }, { nonce: null }, 5), false);
  // successor probe: the stopped watcher's pid file is replaced by a NEW claim while stop is still waiting -> kept
  const fx2 = fixture();
  vault.ensureVault(fx2.P);
  const dead = 999999;
  fs.writeFileSync(fx2.P.pid, JSON.stringify({ pid: dead, startedAt: iso(NOW), script: cli.SCRIPT, nonce: 'n1' }) + '\n');
  const realAlive = vault.pidAlive; let calls = 0;
  vault.pidAlive = (pid) => (pid === dead ? ++calls < 3 : realAlive(pid));
  setTimeout(() => fs.writeFileSync(fx2.P.pid, JSON.stringify({ pid: 999998, startedAt: iso(NOW + 1000), script: cli.SCRIPT, nonce: 'n2' }) + '\n'), 100);
  try {
    const c2 = await cli.main(['stop'], { env: fx2.env, P: fx2.P, out: () => {}, err: () => {}, stopTimeoutMs: 5000, ownsPid: () => ({ ok: true }) });
    assert.strictEqual(c2, 0);
  } finally { vault.pidAlive = realAlive; }
  assert.strictEqual(guard.readPidRecordFrom(fx2.P.pid).nonce, 'n2', 'the successor\'s pid file was not deleted');
  assert.ok(!fs.existsSync(fx2.P.stop), 'our own stop request was cleaned up');
});

// ---- token mode is the default; the file swap is explicit ----------------------------------------------------------
t('TOKEN MODE (default): the watcher never touches the login files — it measures, records the recommended account, writes handoff/notification, and `switch` is refused', async () => {
  const a = fakeAccount('v17a'); const b = fakeAccount('v17b'); const c = fakeAccount('v17c'); const fx = setup([a, b], 'v17a');
  enrollToken(fx, b); enrollToken(fx, c);
  const before = [fs.readFileSync(fx.P.creds, 'utf8'), fs.readFileSync(fx.P.profile, 'utf8')];
  const f = fetchStub({ [a.at]: usage(a, 95, 10), [b.setup]: usage(b, 60, 10), [c.setup]: usage(c, 5, 5) });
  const dry = await R.tick({ P: fx.P, S: TOKEN(), dryRun: true, deps: deps(fx, { fetch: f }) });
  assert.deepStrictEqual([dry.action, dry.to], ['would-recommend', 'v17c'], JSON.stringify(dry));
  const r = await R.tick({ P: fx.P, S: TOKEN(), deps: deps(fx, { fetch: f }) });
  assert.deepStrictEqual([r.action, r.from, r.to, r.mode], ['recommend', 'v17a', 'v17c', 'token'], JSON.stringify(r));
  assert.deepStrictEqual([fs.readFileSync(fx.P.creds, 'utf8'), fs.readFileSync(fx.P.profile, 'utf8')], before, 'login files untouched');
  const st = vault.readState(fx.P);
  assert.strictEqual(st.recommendation.name, 'v17c');
  assert.ok(st.tokenReadings.v17c && st.tokenReadings.v17b, 'token accounts measured with their own tokens');
  assert.strictEqual(vault.readHandoffFile(fx.P).phase, 'recommend');
  const n = readJson(fx.P.notify);
  assert.strictEqual(n.mode, 'token');
  assert.ok(/launch --auto/.test(n.notice) && /v17c/.test(n.notice), n.notice);
  assert.ok(!fs.existsSync(fx.P.txn), 'no transaction was ever opened');
  const status = await runCli(fx, ['status'], { fetch: f, ownsPid: () => ({ ok: false, code: 'dead', reason: 'x' }) });
  assert.ok(/mode token/.test(status.out) && /recommendation: .*v17c/.test(status.out), status.out);
  const sw = await runCli(fx, ['switch', 'v17b'], { fetch: f });
  assert.strictEqual(sw.code, 3);
  assert.ok(/launch --auto/.test(sw.err));
  assert.deepStrictEqual([fs.readFileSync(fx.P.creds, 'utf8'), fs.readFileSync(fx.P.profile, 'utf8')], before);
  const low = await R.tick({ P: fx.P, S: TOKEN(), deps: deps(fx, { fetch: fetchStub({ [a.at]: usage(a, 10, 10), [b.setup]: usage(b, 60, 10), [c.setup]: usage(c, 5, 5) }), now: () => NOW + 60e3 }) });
  assert.deepStrictEqual([low.action, low.reason], ['none', 'below-threshold']);
  assert.strictEqual(vault.readState(fx.P).recommendation, null, 'a recommendation is withdrawn once the current account is fine again');
});

// ---- launch / env argument handling ------------------------------------------------------------------------------------
t('launch/env: --account without a name or combined with --auto is a usage error; a .ps1 launcher and a shim path with % are refused; the cmd wrapper quotes every word', async () => {
  const a = fakeAccount('v18'); const fx = fixture();
  enrollToken(fx, a);
  for (const argv of [['launch', '--account', '--', 'x'], ['launch', '--account'], ['launch', '--account', '../x', '--', 'x'], ['launch', '--account', 'v18', '--auto', '--', 'x']]) {
    const r = await runCli(fx, argv, { claudeBin: 'unused', spawnClaude: async () => { throw new Error('must not spawn'); } });
    assert.strictEqual(r.code, 2, argv.join(' ') + ' -> ' + r.all);
  }
  const ps1 = await runCli(fx, ['launch', '--account', 'v18', '--', 'x'], { claudeBin: 'C:\\tools\\claude.ps1' });
  assert.strictEqual(ps1.code, 3, ps1.all);
  assert.ok(/ps1/.test(ps1.err));
  assert.ok(tok.cmdWrapperArgv('C:\\100%\\claude.cmd', ['--print']).refused, 'a shim path with % is refused too');
  const w = tok.cmdWrapperArgv('C:\\x\\claude.cmd', ['--print', 'hi there', '']);
  assert.deepStrictEqual(w.argv, ['/d', '/v:off', '/s', '/c', '""C:\\x\\claude.cmd" "--print" "hi there" """']);
  assert.ok(tok.binUnsafe('x\ny') && !tok.binUnsafe('C:\\x\\claude.exe'));
  const env = await runCli(fx, ['env', 'v18', '--shell'], { isTTY: true });
  assert.strictEqual(env.code, 2, 'a missing --shell value is a usage error');
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
