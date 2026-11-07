#!/usr/bin/env node
'use strict';
// account-rotator-marker.test.cjs — WP SA-P1B-ROTATOR: the per-prompt lane-budget line can name the
// session's real account only through env FORGE_ROTATOR_ACCOUNT (reader: forge-usage-source.cjs, via 'marker'). Pins:
// `launch` puts the validated slot NAME (never a token) in the child env, overrides a stale inherited marker, never
// sets it in this process, and a hook subprocess of the launched session inherits it and is credited to that account.
// HERMETIC: fresh os.tmpdir() fixtures, FAKE tokens, network stubbed or denied; the real ~/.claude is never touched.
const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-marker-'));
process.env.FORGE_CONFIG_HOME = path.join(ROOT, 'cfg-home');
process.env.FORGE_PROJECT_ROOT = path.join(ROOT, 'cfg-proj');
process.env.FORGE_USAGE_GUARD_HOME = path.join(ROOT, 'guard-trap', '.claude');
process.env.FORGE_ACCOUNT_ROTATOR_HOME = path.join(ROOT, 'rot-trap', '.claude');
process.env.FORGE_USAGE_GUARD_DENY_NETWORK = '1';
process.env.FORGE_ACCOUNT_ROTATOR_DENY_NETWORK = '1';
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.FORGE_ROTATOR_ACCOUNT;
assert.notStrictEqual(path.resolve(process.env.FORGE_ACCOUNT_ROTATOR_HOME), path.join(os.homedir(), '.claude'));

const vault = require('./account-rotator-vault.cjs');
const cli = require('./account-rotator-cli.cjs');
const guard = require('./usage-guard.cjs');
const us = require('./forge-usage-source.cjs');

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const rnd = () => crypto.randomBytes(10).toString('hex');
const SECRETS = new Set();
function fixture() {
  const root = fs.mkdtempSync(path.join(ROOT, 'fx-'));
  const home = path.join(root, '.claude');
  fs.mkdirSync(home, { recursive: true });
  const env = Object.assign({}, process.env, { FORGE_ACCOUNT_ROTATOR_HOME: home, FORGE_ACCOUNT_ROTATOR_PROFILE: path.join(root, '.claude.json'), FORGE_USAGE_GUARD_HOME: home });
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CLAUDE_CODE_OAUTH_TOKEN', 'FORGE_ROTATOR_ACCOUNT']) delete env[k];
  return { root, home, env, P: vault.paths(env) };
}
function resp(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function usage(session, week) {
  const sr = iso(NOW + 2 * 3600e3); const wr = iso(NOW + 3 * 86400e3);
  return { limits: [{ kind: 'session', group: 'session', percent: session, resets_at: sr }, { kind: 'weekly_all', group: 'weekly', percent: week, resets_at: wr }], five_hour: { utilization: session, resets_at: sr }, seven_day: { utilization: week, resets_at: wr } };
}
function fetchStub(map) {
  return async (url, init) => {
    const r = map[String(init.headers.authorization || '').replace(/^Bearer /, '')];
    if (r === undefined) return resp(401, {});
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
  const r = { code, all: out.concat(err).join('\n') };
  OUT.push(r.all);
  return r;
}
async function tokenSlot(fx, name) {
  const setup = 'FAKE-SETUP-' + name + '-' + rnd(); SECRETS.add(setup);
  const r = await runCli(fx, ['enroll-token', name], { readStdin: async () => setup });
  assert.strictEqual(r.code, 0, r.all);
  return setup;
}
const envSpy = () => { const s = async (bin, args, env) => { s.calls.push({ marker: env.FORGE_ROTATOR_ACCOUNT, hasToken: !!env.CLAUDE_CODE_OAUTH_TOKEN }); return { code: 0 }; }; s.calls = []; return s; };

t('MK-1 launch --account puts the slot NAME in the child env as FORGE_ROTATOR_ACCOUNT, never in this process', async () => {
  const fx = fixture(); await tokenSlot(fx, 'oac');
  const spy = envSpy();
  const r = await runCli(fx, ['launch', '--account', 'oac', '--', 'x'], { claudeBin: 'unused', spawnClaude: spy });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(spy.calls, [{ marker: 'oac', hasToken: true }]);
  assert.strictEqual(process.env.FORGE_ROTATOR_ACCOUNT, undefined, 'never set in the parent');
  assert.strictEqual(fx.env.FORGE_ROTATOR_ACCOUNT, undefined, 'the passed env object is not mutated');
});
t('MK-2 launch --auto names the account it picked; a stale inherited marker is overridden', async () => {
  const fx = fixture(); const lo = await tokenSlot(fx, 'low1'); const hi = await tokenSlot(fx, 'high1');
  fx.env.FORGE_ROTATOR_ACCOUNT = 'high1'; // e.g. launched from inside an earlier rotator session
  const spy = envSpy();
  const r = await runCli(fx, ['launch', '--auto', '--', 'x'], { fetch: fetchStub({ [lo]: usage(5, 10), [hi]: usage(90, 95) }), claudeBin: 'unused', spawnClaude: spy });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(spy.calls.map((c) => c.marker), ['low1']);
});
t('MK-3 the marker is the name only: never a token, and the name passed the vault name check', async () => {
  const fx = fixture(); const setup = await tokenSlot(fx, 'zeeco');
  let seen = null;
  await runCli(fx, ['launch', '--account', 'zeeco', '--', 'x'], { claudeBin: 'unused', spawnClaude: async (bin, args, env) => { seen = env.FORGE_ROTATOR_ACCOUNT; return { code: 0 }; } });
  assert.strictEqual(seen, 'zeeco');
  assert.ok(!seen.includes(setup) && vault.validName(seen));
  const bad = await runCli(fx, ['launch', '--account', '../evil', '--', 'x'], { claudeBin: 'unused', spawnClaude: async () => { throw new Error('must not spawn'); } });
  assert.strictEqual(bad.code, 2, bad.all);
});
t('MK-4 end to end: a hook subprocess of the launched session inherits the marker and is credited to that account', async () => {
  const fx = fixture(); await tokenSlot(fx, 'oac');
  await vault.updateState(fx.P, (s) => { s.tokenReadings.oac = Object.assign({}, s.tokenReadings.oac || {}, { windows: [{ id: 'session', kind: 'session', label: 'session', pct: 12, resetsAt: iso(Date.now() + 3600e3) }, { id: 'weekly_all', kind: 'weekly_all', label: 'weekly_all', pct: 34, resetsAt: iso(Date.now() + 86400e3) }], measuredAt: iso(Date.now() - 60e3), source: 'live', unmeasurable: null }); });
  // fake "claude": spawns a grandchild (the hook) that reports what it sees through the env
  const probe = path.join(fx.root, 'fake-claude.cjs'); const outFile = path.join(fx.root, 'hook.json');
  fs.writeFileSync(probe, "const cp=require('child_process');cp.execFileSync(process.execPath,['-e',\"require('fs').writeFileSync(process.argv[1],JSON.stringify({m:process.env.FORGE_ROTATOR_ACCOUNT||null,t:'CLAUDE_CODE_OAUTH_TOKEN' in process.env}))\",process.argv[2]]);");
  const r = await runCli(fx, ['launch', '--account', 'oac', '--', outFile], { claudeBin: probe });
  assert.strictEqual(r.code, 0, r.all);
  const hook = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.deepStrictEqual(hook, { m: 'oac', t: true });
  const acct = us.rotatorAccount({ file: path.join(fx.home, 'forge-accounts', 'state.json'), env: { FORGE_ROTATOR_ACCOUNT: hook.m, CLAUDE_CODE_OAUTH_TOKEN: 'x' } });
  assert.deepStrictEqual([acct.name, acct.via, acct.guess, acct.usage.session.pct, acct.usage.week.pct, acct.usage.stale], ['oac', 'marker', false, 12, 34, false]);
});
t('MK-5 SECRECY: no fake token in any output, state or log of this suite', () => {
  const texts = OUT.slice();
  for (const d of fs.readdirSync(ROOT).filter((x) => x.startsWith('fx-'))) {
    for (const f of ['state.json', 'rotator.log']) { const s = vault.readRaw(path.join(ROOT, d, '.claude', 'forge-accounts', f)); if (s !== null) texts.push(s); }
  }
  const blob = texts.join('\n');
  assert.ok(texts.length > 4, 'scanned ' + texts.length);
  for (const s of SECRETS) assert.ok(!blob.includes(s), 'secret leaked');
});
// project tally the doctor and forge-test-tally.test.cjs read (node:test's own 'pass N' line counts as no evidence)
let passed = 0; let failed = 0;
function t(name, fn) { test(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });
