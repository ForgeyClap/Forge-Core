#!/usr/bin/env node
'use strict';
// account-rotator.test.cjs — node:test suite for the account rotator.
// HERMETIC: every fixture lives in a fresh os.tmpdir() directory with FAKE logins; the network is a stub (deps.fetch)
// or denied (FORGE_*_DENY_NETWORK); the real ~/.claude, ~/.claude.json and api.anthropic.com are never touched.
// The trailing "N passed, M failed" line is the tally forge-doctor's suite runner reads.
const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-rot-'));
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
/** doSwap(fx, name, opts) — preflight (corroboration without the settle wait) + the transactional swap. */
async function doSwap(fx, name, opts) {
  const pf = await txn.preflight(fx.P, name, Object.assign({ settleMs: 0 }, opts || {}));
  if (!pf.ok) return Object.assign({ ok: false, preflight: true }, pf);
  return txn.swapLogin(fx.P, pf, opts || {});
}

let passed = 0; let failed = 0;
function t(name, fn) { test(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });

// ---- fixtures ---------------------------------------------------------------------------------------------
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const rnd = () => crypto.randomBytes(10).toString('hex');
const ALL_SECRETS = new Set();
function fakeAccount(n, opts) {
  const a = { name: n, uuid: 'uuid-' + n + '-' + rnd(), email: n + '.owner@example.com', at: 'FAKE-AT-' + n + '-' + rnd(), rt: 'FAKE-RT-' + n + '-' + rnd(),
    expiresAt: (opts && opts.expired) ? NOW - 3600e3 : NOW + 6 * 3600e3, setup: 'FAKE-SETUP-' + n + '-' + rnd() };
  ALL_SECRETS.add(a.at); ALL_SECRETS.add(a.rt); ALL_SECRETS.add(a.setup);
  return a;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(ROOT, 'fx-'));
  const home = path.join(root, '.claude');
  fs.mkdirSync(home, { recursive: true });
  const env = Object.assign({}, process.env, { FORGE_ACCOUNT_ROTATOR_HOME: home, FORGE_ACCOUNT_ROTATOR_PROFILE: path.join(root, '.claude.json'), FORGE_USAGE_GUARD_HOME: home });
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k]; // this suite may itself run inside an agent
  return { root, home, env, P: vault.paths(env), mcp: 'FAKE-MCP-' + rnd() };
}
function login(fx, a, style) {
  const s = style || {};
  const creds = { claudeAiOauth: { accessToken: a.at, refreshToken: a.rt, expiresAt: a.expiresAt, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' }, mcpOAuth: { srv: { accessToken: fx.mcp } } };
  fs.writeFileSync(fx.P.creds, JSON.stringify(creds));
  const profile = { numStartups: 7, theme: 'dark', oauthAccount: { accountUuid: a.uuid, emailAddress: a.email, organizationUuid: 'org-' + a.name }, projects: { 'C:/x': { allowedTools: [] } } };
  let text = JSON.stringify(profile, null, 2);
  if (s.crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(fx.P.profile, (s.bom ? '\ufeff' : '') + text + (s.crlf ? '\r\n' : '\n'));
}
function resp(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function usage(session, week, scoped, opts) {
  const o = opts || {};
  const sr = o.sessionReset || iso(NOW + 2 * 3600e3); const wr = o.weekReset || iso(NOW + 3 * 86400e3);
  // the live endpoint's shape (as pinned in usage-guard.test.cjs): typed limits carry a `group`
  const limits = [{ kind: 'session', group: 'session', percent: session, resets_at: sr }, { kind: 'weekly_all', group: 'weekly', percent: week, resets_at: wr }];
  if (scoped !== undefined && scoped !== null) limits.push({ kind: 'weekly_scoped', group: 'weekly', percent: scoped, resets_at: wr, scope: { model: { display_name: 'Opus' } } });
  return { limits, five_hour: { utilization: session, resets_at: sr }, seven_day: { utilization: week, resets_at: wr } };
}
/** fetchStub({token: body | {status, body} | Error}) — every call recorded by URL + token hash only. */
function fetchStub(map) {
  const calls = [];
  const f = async (url, init) => {
    const tok = String(init.headers.authorization || '').replace(/^Bearer /, '');
    calls.push({ url: String(url), tok: crypto.createHash('sha256').update(tok).digest('hex').slice(0, 8), beta: init.headers['anthropic-beta'] });
    const r = map[tok];
    if (r === undefined) return resp(401, {});
    if (r instanceof Error) throw r;
    if (r && r.status) return resp(r.status, r.body || {});
    return resp(200, r);
  };
  f.calls = calls;
  return f;
}
function fakeGuard(fx) {
  const journal = [];
  const stateFile = path.join(fx.home, 'FORGE_USAGE_GUARD_STATE.json');
  return {
    journal, stateFile,
    unresolvedPausedAgents: () => [],
    allAgents: async () => [], pc: async () => ({ status: 200, json: {} }),
    journalAppend: (r) => journal.push(r), compactJournalIfNeeded() {},
    readAccountIdentity: () => { try { const p = JSON.parse(fs.readFileSync(fx.P.profile, 'utf8').replace(/^\ufeff/, '')); return { fp: 'label-' + p.oauthAccount.accountUuid.slice(0, 12) }; } catch { return { fp: null }; } },
    resolveGuardLanguage: () => 'en',
    withStateLock: async (fn) => ({ ok: true, value: await fn(() => true) }),
    readState: () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { mode: 'ok' }; } },
    stateLockPath: () => stateFile + '.lock',
    readPidRecordFrom: guard.readPidRecordFrom, claimWatcherSlot: guard.claimWatcherSlot, releaseWatcherSlot: guard.releaseWatcherSlot,
    awaitChildClaim: guard.awaitChildClaim, ownsPid: guard.ownsPid,
  };
}
// this suite exercises the FILE mode (experimental, explicit opt-in) unless a test overrides `mode`; token mode is the default
function S(over) { const s = R.resolveSettings(['--mode', 'file'], {}); for (const [k, v] of Object.entries(over || {})) s[k] = { value: v, source: 'vlag' }; return s; }
function deps(fx, extra) { return Object.assign({ now: () => NOW, quiet: true, guard: fakeGuard(fx), userEnvHas: () => false, settleMs: 0 }, extra || {}); }
async function runCli(fx, argv, extra) {
  const out = []; const err = [];
  const code = await cli.main(argv, Object.assign({ env: fx.env, P: fx.P, now: () => NOW, out: (s) => out.push(vault.scrub(s)), err: (s) => err.push(vault.scrub(s)),
    guard: fakeGuard(fx), userEnvHas: () => false, quiet: true, readStdin: async () => '', settleMs: 0 }, extra || {}));
  return { code, out: out.join('\n'), err: err.join('\n'), all: out.concat(err).join('\n') };
}
const ALL_OUTPUT = [];
function remember(r) { ALL_OUTPUT.push(r.all); return r; }
async function enrolled(fx, accts, style) {
  for (const a of accts) { login(fx, a, style); remember(await runCli(fx, ['enroll', a.name])); }
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\ufeff/, '')); }
function creds(fx) { return readJson(fx.P.creds); }
function profile(fx) { return readJson(fx.P.profile); }

// ---- 1) core: threshold detection on every window kind --------------------------------------------------------
t('threshold: session window at 92% is detected', () => {
  const ws = core.cleanWindows(guard.normalizeWindows(usage(92, 10)));
  assert.deepStrictEqual(core.crossed(ws, 92).map((w) => w.kind), ['session']);
});
t('threshold: weekly window at 93% is detected', () => {
  const ws = core.cleanWindows(guard.normalizeWindows(usage(5, 93)));
  assert.deepStrictEqual(core.crossed(ws, 92).map((w) => w.kind), ['weekly_all']);
});
t('threshold: a SCOPED weekly window at 95% counts for the account (session/week low)', () => {
  const ws = core.cleanWindows(guard.normalizeWindows(usage(5, 10, 95)));
  const c = core.crossed(ws, 92);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'weekly_scoped');
  assert.ok(/Opus/.test(c[0].label));
  assert.strictEqual(core.judge({ windows: ws, maxPct: core.maxPct(ws) }, 92).usable, false);
});
t('threshold: 91.9% everywhere is below 92%', () => {
  const ws = core.cleanWindows(guard.normalizeWindows(usage(91.9, 91.9, 91.9)));
  assert.strictEqual(core.crossed(ws, 92).length, 0);
});

// ---- 2) core: estimated vs live, selection, hysteresis, anti-flap ---------------------------------------------
t('estimated: a window whose resetsAt passed counts as 0% and is marked estimated; never-measured is unknown (no %)', () => {
  const rec = { windows: [{ id: 's', kind: 'session', label: 'session', pct: 97, resetsAt: iso(NOW - 60e3) }, { id: 'w', kind: 'weekly_all', label: 'weekly_all', pct: 40, resetsAt: iso(NOW + 86400e3) }], measuredAt: iso(NOW - 3600e3), source: 'live' };
  const r = core.effectiveReading(rec, NOW);
  assert.strictEqual(r.status, 'estimated');
  assert.strictEqual(r.maxPct, 40);
  assert.ok(r.windows[0].resetPassed);
  const u = core.effectiveReading(undefined, NOW);
  assert.deepStrictEqual([u.status, u.maxPct], ['unknown', null]);
  assert.strictEqual(core.judge(u, 92).usable, null);
  const live = core.effectiveReading(Object.assign({}, rec, { windows: [rec.windows[1]], measuredAt: iso(NOW - 60e3) }), NOW);
  assert.strictEqual(live.status, 'live');
});
function acct(name, pct, status) {
  if (pct === null) return { name, eligible: true, reading: { status: status || 'unknown', windows: [], maxPct: null } };
  return { name, eligible: true, reading: { status: status || 'live', windows: [{ id: 'x', kind: 'session', label: 'session', pct, resetsAt: iso(NOW + 3600e3) }], maxPct: pct, measuredAt: iso(NOW) } };
}
t('selection: picks the lowest clear account; never the active one; full ones skipped', () => {
  const s = core.selectTarget({ accounts: [acct('a', 95), acct('b', 40), acct('c', 10), acct('d', 99)], activeName: 'a', threshold: 92, now: NOW });
  assert.strictEqual(s.target, 'c');
  assert.strictEqual(s.tier, 'clear');
  assert.ok(s.skipped.some((x) => x.name === 'd' && x.why === 'full'));
});
t('hysteresis: a target at 88-91% (>= threshold-5) is only taken when nothing below 87% exists', () => {
  const s1 = core.selectTarget({ accounts: [acct('a', 95), acct('b', 89), acct('c', 50)], activeName: 'a', threshold: 92, now: NOW });
  assert.strictEqual(s1.target, 'c');
  const s2 = core.selectTarget({ accounts: [acct('a', 95), acct('b', 89)], activeName: 'a', threshold: 92, now: NOW });
  assert.deepStrictEqual([s2.target, s2.tier], ['b', 'near']);
});
t('selection: live beats estimated beats unknown; unknown is last resort only', () => {
  const s = core.selectTarget({ accounts: [acct('a', 95), acct('u', null), acct('e', 30, 'estimated'), acct('l', 30, 'live')], activeName: 'a', threshold: 92, now: NOW });
  assert.strictEqual(s.target, 'l');
  const only = core.selectTarget({ accounts: [acct('a', 95), acct('u', null)], activeName: 'a', threshold: 92, now: NOW });
  assert.deepStrictEqual([only.target, only.tier, only.reason], ['u', 'unknown', 'last-resort-unmeasured']);
});
t('selection: never back to the account just left until its window reset', () => {
  const lastLeft = { name: 'b', at: iso(NOW - 600e3), resetsAt: iso(NOW + 3600e3) };
  const s = core.selectTarget({ accounts: [acct('a', 95), acct('b', 10, 'estimated')], activeName: 'a', threshold: 92, now: NOW, lastLeft });
  assert.strictEqual(s.target, null);
  assert.ok(s.skipped.some((x) => x.why === 'just-left'));
  const later = core.selectTarget({ accounts: [acct('a', 95), acct('b', 10, 'estimated')], activeName: 'a', threshold: 92, now: NOW + 2 * 3600e3, lastLeft });
  assert.strictEqual(later.target, 'b');
});
t('anti-flap: cooldown runs from the last COMMITTED swap; max 6 committed swaps per 24 h (every hop counts)', () => {
  const s1 = [{ at: iso(NOW - 5 * 60e3), kind: 'auto' }];
  const a1 = core.antiFlap({ swaps: s1, now: NOW, cooldownMin: 10 });
  assert.deepStrictEqual([a1.ok, a1.reason], [false, 'cooldown']);
  assert.ok(core.antiFlap({ swaps: s1, now: NOW, cooldownMin: 4 }).ok);
  const six = Array.from({ length: 6 }, (_, i) => ({ at: iso(NOW - (i + 1) * 3600e3), kind: i % 2 ? 'manual' : 'auto' }));
  assert.deepStrictEqual([core.antiFlap({ swaps: six, now: NOW, cooldownMin: 10 }).reason], ['max-per-day']);
  assert.strictEqual(core.allowanceLeft(six.slice(0, 4), NOW), 2);
  assert.ok(core.antiFlap({ swaps: six.map((s) => ({ at: iso(Date.parse(s.at) - 86400e3) })), now: NOW, cooldownMin: 10 }).ok, 'older than 24 h no longer counts');
});
t('round-robin (unmeasurable fallback): a rested account (>5 h) first, else least recently used; no percentage', () => {
  const r1 = core.roundRobin([{ name: 'x', lastUsedAt: iso(NOW - 3600e3) }, { name: 'y', lastUsedAt: iso(NOW - 6 * 3600e3) }], NOW);
  assert.strictEqual(r1.name, 'y');
  const r2 = core.roundRobin([{ name: 'x', lastUsedAt: iso(NOW - 3600e3) }, { name: 'y', lastUsedAt: iso(NOW - 2 * 3600e3) }], NOW);
  assert.ok(r2.name === 'y' && /least recently used/.test(r2.why));
  assert.ok(!/%/.test(r1.why + r2.why));
});

// ---- 3) settings resolution order -----------------------------------------------------------------------------
t('settings: flag > /forge config > default, with bounds; invalid values fall through with a warning', () => {
  const cfg = { 'account-rotator.threshold': { value: 90, source: 'global' }, 'account-rotator': { value: true, source: 'global' } };
  const a = R.resolveSettings(['--threshold', '95'], cfg);
  assert.deepStrictEqual([a.threshold.value, a.threshold.source], [95, 'vlag']);
  const b = R.resolveSettings([], cfg);
  assert.deepStrictEqual([b.threshold.value, b.threshold.source], [90, 'instelling']);
  const c = R.resolveSettings(['--threshold', '120'], cfg);
  assert.deepStrictEqual([c.threshold.value, c.warnings.length], [90, 1]);
  const d = R.resolveSettings(['--threshold', '93.5'], {});
  assert.deepStrictEqual([d.threshold.value, d.threshold.source], [92, 'standaard']);
  assert.deepStrictEqual([d['cooldown-min'].value, d.interval.value, d.enabled.value], [10, 120, true]);
});
t('settings: the schema defaults/bounds equal the code defaults (drift pin), the switch is a flagged key', () => {
  const schema = readJson(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'));
  for (const k of Object.keys(R.DEFAULTS)) {
    const spec = schema.settings['account-rotator.' + k];
    assert.strictEqual(spec.default, R.DEFAULTS[k], k);
    assert.deepStrictEqual({ min: spec.min, max: spec.max }, R.BOUNDS_FALLBACK[k], k);
  }
  const mode = schema.settings['account-rotator.mode'];
  assert.deepStrictEqual([mode.type, mode.allowed, mode.default], ['enum', R.ENUMS.mode.allowed, R.ENUMS.mode.default], 'mode: token by default, file explicit');
  assert.strictEqual(R.resolveSettings([], {}).mode.value, 'token');
  assert.strictEqual(R.resolveSettings(['--mode', 'file'], {}).mode.value, 'file');
  assert.strictEqual(R.resolveSettings(['--mode', 'bogus'], {}).mode.value, 'token', 'an invalid mode falls back to token with a warning');
  const sw = schema.settings['account-rotator'];
  assert.strictEqual(sw.default, true);
  assert.ok(sw.flags.includes('C') && sw.flags.includes('N') && sw.flags.includes('U'));
  assert.ok(/~\/\.claude\/forge-accounts/.test(sw.disclosure.en) && /api\.anthropic\.com/.test(sw.disclosure.en) && /\.credentials\.json/.test(sw.disclosure.en));
  assert.strictEqual(require('./forge-config.cjs').FAILSAFE_FLAGGED['account-rotator'], false);
});
t('settings: an unreadable config is never a silent "on" (start refuses with exit 3)', async () => {
  const fx = fixture();
  const broken = { resolve: () => { throw new Error('damaged'); }, SCHEMA: { settings: {} } };
  const r = await runCli(fx, ['start'], { configModule: broken });
  assert.strictEqual(r.code, 3);
  assert.ok(/onleesbaar|unreadable/.test(r.all), r.all);
});

// ---- 4) measurement: fail-safe ----------------------------------------------------------------------------------
t('measure: sends the token only to the official endpoint with the oauth beta header', async () => {
  const a = fakeAccount('m1');
  const f = fetchStub({ [a.at]: usage(10, 20) });
  const m = await R.measureToken(a.at, { fetch: f });
  assert.ok(m.ok);
  assert.deepStrictEqual(f.calls.map((c) => [c.url, c.beta]), [['https://api.anthropic.com/api/oauth/usage', 'oauth-2025-04-20']]);
});
t('measure: transport error, HTTP 500, unparsable body and 401 are all failures — never "fine", never "full"', async () => {
  const a = fakeAccount('m2');
  for (const r of [new Error('boom ' + a.at), { status: 500 }, { status: 401 }]) {
    const m = await R.measureToken(a.at, { fetch: fetchStub({ [a.at]: r }) });
    assert.strictEqual(m.ok, false);
    assert.ok(!m.error.includes(a.at), 'error text never echoes the token');
  }
  const bad = await R.measureToken(a.at, { fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x ' + a.at); } }) });
  assert.strictEqual(bad.ok, false);
  assert.ok(!bad.error.includes(a.at));
  assert.strictEqual((await R.measureToken('bad token\nwith newline', { fetch: fetchStub({}) })).kind, 'bad-token');
});
t('tick: a fetch error on the active account => no action, nothing swapped, error recorded', async () => {
  const fx = fixture(); const a = fakeAccount('fa'); const b = fakeAccount('fb');
  await enrolled(fx, [b, a]);
  const before = fs.readFileSync(fx.P.creds, 'utf8');
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: fetchStub({ [a.at]: new Error('ECONNRESET') }) }) });
  assert.deepStrictEqual([r.action, r.reason], ['none', 'check-failed']);
  assert.strictEqual(fs.readFileSync(fx.P.creds, 'utf8'), before);
  assert.ok(vault.readState(fx.P).readings.fa.lastError);
});

// ---- 5) enroll / vault ----------------------------------------------------------------------------------------
t('enroll: snapshots only claudeAiOauth + oauthAccount; refuses a duplicate account under another name; refuses overwrite without --force', async () => {
  const fx = fixture(); const a = fakeAccount('e1');
  login(fx, a);
  const r1 = remember(await runCli(fx, ['enroll', 'work']));
  assert.strictEqual(r1.code, 0, r1.all);
  const slot = readJson(vault.slotPath(fx.P, 'work'));
  assert.strictEqual(slot.credentials.claudeAiOauth.refreshToken, a.rt);
  assert.ok(!JSON.stringify(slot).includes(fx.mcp), 'MCP OAuth tokens are never copied into the vault');
  const r2 = remember(await runCli(fx, ['enroll', 'other']));
  assert.strictEqual(r2.code, 3);
  assert.ok(/already enrolled as "work"/.test(r2.err), r2.err);
  const r3 = remember(await runCli(fx, ['enroll', 'work']));
  assert.strictEqual(r3.code, 3);
  assert.strictEqual(remember(await runCli(fx, ['enroll', 'work', '--force'])).code, 0);
  assert.strictEqual(remember(await runCli(fx, ['enroll', 'state'])).code, 2, 'reserved name refused');
  assert.ok(!r1.all.includes(a.at) && !r1.all.includes(a.rt));
});
t('vault: slot files are created with mode 0600 on POSIX (Windows relies on the profile ACL)', async () => {
  const fx = fixture(); const a = fakeAccount('pm');
  login(fx, a);
  await runCli(fx, ['enroll', 'pm']);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(vault.slotPath(fx.P, 'pm')).mode & 0o777, 0o600);
  else assert.ok(fs.existsSync(vault.slotPath(fx.P, 'pm')));
});

// ---- 6) the swap (preflight + transaction) ---------------------------------------------------------------------
t('swap: happy path — only claudeAiOauth and oauthAccount change; BOM + CRLF + other keys preserved; backup holds ONLY claudeAiOauth', async () => {
  const fx = fixture(); const a = fakeAccount('sa'); const b = fakeAccount('sb');
  await enrolled(fx, [b, a], { bom: true, crlf: true });
  const beforeProfile = profile(fx);
  const r = await doSwap(fx, 'sb');
  assert.ok(r.ok, r.reason);
  const c = creds(fx);
  assert.strictEqual(c.claudeAiOauth.refreshToken, b.rt);
  assert.strictEqual(c.mcpOAuth.srv.accessToken, fx.mcp, 'machine-level keys untouched');
  const raw = fs.readFileSync(fx.P.profile, 'utf8');
  assert.strictEqual(raw.charCodeAt(0), 0xfeff, 'BOM preserved');
  assert.ok(raw.includes('\r\n') && !/[^\r]\n/.test(raw), 'CRLF preserved');
  const p = profile(fx);
  assert.strictEqual(p.oauthAccount.accountUuid, b.uuid);
  for (const k of Object.keys(beforeProfile)) if (k !== 'oauthAccount') assert.deepStrictEqual(p[k], beforeProfile[k], k);
  const bk = readJson(fx.P.backup);
  assert.strictEqual(bk.claudeAiOauth.refreshToken, a.rt);
  assert.ok(!JSON.stringify(bk).includes(fx.mcp), 'L1: the backup never holds MCP tokens');
  assert.strictEqual(readJson(fx.P.txn).phase, 'done');
});
t('swap (AR-04 / AR-V01): a rotated refresh token is captured only with an INDEPENDENT ownership proof (matching usage readings), with the previous generation kept', async () => {
  const fx = fixture(); const a = fakeAccount('ca'); const b = fakeAccount('cb');
  await enrolled(fx, [b, a]);
  const rotated = 'FAKE-RT-rotated-' + rnd(); ALL_SECRETS.add(rotated);
  const c = creds(fx); c.claudeAiOauth.refreshToken = rotated; fs.writeFileSync(fx.P.creds, JSON.stringify(c));
  const r0 = await doSwap(fx, 'cb'); // no proof at all: the profile uuid alone never authorises a capture
  assert.strictEqual(r0.ok, false);
  assert.ok(/could not be corroborated/.test(r0.reason), r0.reason);
  assert.strictEqual(readJson(vault.slotPath(fx.P, 'ca')).credentials.claudeAiOauth.refreshToken, a.rt, 'slot untouched');
  const prior = R.liveReading({ windows: core.cleanWindows(guard.normalizeWindows(usage(30, 40))) }, NOW - 60e3, { viaSlotToken: true });
  const f = fetchStub({ [a.at]: usage(30, 40) });
  const r1 = await doSwap(fx, 'cb', { measure: (t) => R.measureToken(t, { fetch: f }), readings: { ca: prior }, now: NOW });
  assert.ok(r1.ok, r1.reason);
  assert.strictEqual(readJson(vault.slotPath(fx.P, 'ca')).credentials.claudeAiOauth.refreshToken, rotated);
  assert.strictEqual(readJson(path.join(fx.P.vault, 'ca.prev.json')).credentials.claudeAiOauth.refreshToken, a.rt, 'previous generation kept (0600)');
});
t('swap (M2): refuses an un-enrolled active login in preflight and changes nothing', async () => {
  const fx = fixture(); const a = fakeAccount('ua'); const b = fakeAccount('ub'); const x = fakeAccount('ux');
  await enrolled(fx, [a, b]);
  login(fx, x);
  const before = [fs.readFileSync(fx.P.creds, 'utf8'), fs.readFileSync(fx.P.profile, 'utf8')];
  const r = await doSwap(fx, 'ua');
  assert.strictEqual(r.ok, false);
  assert.ok(/not enrolled/.test(r.reason));
  assert.deepStrictEqual([fs.readFileSync(fx.P.creds, 'utf8'), fs.readFileSync(fx.P.profile, 'utf8')], before);
  assert.ok(!fs.existsSync(fx.P.txn), 'no transaction was even opened');
});
t('swap: refuses when the login file and the profile disagree about the account', async () => {
  const fx = fixture(); const a = fakeAccount('ia'); const b = fakeAccount('ib');
  await enrolled(fx, [a, b]);
  const c = creds(fx); c.claudeAiOauth = { accessToken: a.at, refreshToken: a.rt, expiresAt: a.expiresAt }; fs.writeFileSync(fx.P.creds, JSON.stringify(c));
  const r = await doSwap(fx, 'ia');
  assert.strictEqual(r.ok, false);
  assert.ok(/disagree/.test(r.reason), r.reason);
});
t('swap (AR-03): Claude Code refreshing the login just before our rename aborts it untouched — its new refresh token is never overwritten', async () => {
  const fx = fixture(); const a = fakeAccount('za'); const b = fakeAccount('zb');
  await enrolled(fx, [b, a]);
  const refreshed = 'FAKE-RT-refreshed-' + rnd(); ALL_SECRETS.add(refreshed);
  const profileBefore = fs.readFileSync(fx.P.profile, 'utf8');
  const r = await doSwap(fx, 'zb', { hooks: { beforeCredsWrite: () => {
    const c = creds(fx); c.claudeAiOauth.refreshToken = refreshed; fs.writeFileSync(fx.P.creds, JSON.stringify(c));
  } } });
  assert.deepStrictEqual([r.ok, r.rolledBack, r.outcome], [false, true, 'aborted-unchanged']);
  assert.ok(/changed before the swap/.test(r.reason), r.reason);
  assert.strictEqual(creds(fx).claudeAiOauth.refreshToken, refreshed);
  assert.strictEqual(fs.readFileSync(fx.P.profile, 'utf8'), profileBefore);
});
t('swap (AR-03): a failed verification rolls back key-level — a concurrent write to OTHER profile keys survives', async () => {
  const fx = fixture(); const a = fakeAccount('ra'); const b = fakeAccount('rb');
  await enrolled(fx, [b, a], { bom: true });
  const before = profile(fx);
  const r = await doSwap(fx, 'rb', { hooks: { afterProfileWrite: () => {
    // someone rewrites the profile WITHOUT its BOM (verification fails) but leaves our oauthAccount in place
    const p = profile(fx); p.numStartups = 8; fs.writeFileSync(fx.P.profile, JSON.stringify(p, null, 2) + '\n');
  } } });
  assert.deepStrictEqual([r.ok, r.rolledBack, r.outcome], [false, true, 'rolled-back']);
  assert.strictEqual(creds(fx).claudeAiOauth.refreshToken, a.rt);
  const p = profile(fx);
  assert.deepStrictEqual(p.oauthAccount, before.oauthAccount);
  assert.strictEqual(p.numStartups, 8, 'the concurrent write to another key survives the key-only rollback');
});
t('swap (H1): a third account appearing mid-swap is never overwritten — recorded unresolved, reported, not claimed rolled back', async () => {
  const fx = fixture(); const a = fakeAccount('ha'); const b = fakeAccount('hb');
  await enrolled(fx, [b, a]);
  const r = await doSwap(fx, 'hb', { hooks: { afterProfileWrite: () => {
    const p = profile(fx); p.oauthAccount = { accountUuid: 'someone-else' }; fs.writeFileSync(fx.P.profile, JSON.stringify(p, null, 2) + '\n');
  } } });
  assert.deepStrictEqual([r.ok, r.rolledBack, r.unresolved], [false, false, true]);
  assert.ok(/NOT rolled back/.test(r.reason), r.reason);
  assert.strictEqual(profile(fx).oauthAccount.accountUuid, 'someone-else', 'a foreign value is never overwritten');
  assert.strictEqual(readJson(fx.P.txn).phase, 'unresolved');
  const rec = txn.reconcile(fx.P);
  assert.strictEqual(rec.action, 'unresolved', 'reconcile does nothing destructive either');
});

// ---- 7) tick: decide + handoff (fake guard) ------------------------------------------------------------------
t('tick: below the threshold => no action; at 92% session => switch to the best account; history + lastLeft recorded', async () => {
  const fx = fixture(); const a = fakeAccount('ta'); const b = fakeAccount('tb'); const c = fakeAccount('tc');
  await enrolled(fx, [b, c, a]);
  const low = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: fetchStub({ [a.at]: usage(50, 50) }) }) });
  assert.strictEqual(low.action, 'none');
  const f = fetchStub({ [a.at]: usage(92, 10), [b.at]: usage(80, 85), [c.at]: usage(20, 30) });
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f }) });
  assert.deepStrictEqual([r.action, r.to], ['switched', 'tc']);
  assert.strictEqual(creds(fx).claudeAiOauth.refreshToken, c.rt);
  const st = vault.readState(fx.P);
  assert.strictEqual(st.lastLeft.name, 'ta');
  assert.strictEqual(st.history.slice(-1)[0].outcome, 'verified');
  assert.strictEqual(st.swaps.length, 1, 'one committed swap recorded durably');
  assert.strictEqual(st.active, 'tc');
  const n = readJson(fx.P.notify);
  assert.strictEqual(n.active, 'tc');
});
t('tick: weekly trigger and scoped trigger both switch', async () => {
  for (const [sess, week, scoped] of [[10, 95, null], [10, 10, 96]]) {
    const fx = fixture(); const a = fakeAccount('wa'); const b = fakeAccount('wb');
    await enrolled(fx, [b, a]);
    const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: fetchStub({ [a.at]: usage(sess, week, scoped), [b.at]: usage(5, 5) }) }) });
    assert.deepStrictEqual([r.action, r.to], ['switched', 'wb'], JSON.stringify([sess, week, scoped]));
  }
});
t('tick: cooldown and the per-day cap block an auto switch (no files touched)', async () => {
  const fx = fixture(); const a = fakeAccount('ka'); const b = fakeAccount('kb');
  await enrolled(fx, [b, a]);
  await vault.updateState(fx.P, (s) => { s.swaps = [{ at: iso(NOW - 120e3), kind: 'auto' }]; });
  const before = fs.readFileSync(fx.P.creds, 'utf8');
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: fetchStub({ [a.at]: usage(99, 99), [b.at]: usage(5, 5) }) }) });
  assert.deepStrictEqual([r.action, r.reason], ['none', 'cooldown']);
  assert.strictEqual(fs.readFileSync(fx.P.creds, 'utf8'), before);
});
t('tick: an inactive account with an EXPIRED stored token is never measured — its last-known reading counts (estimated)', async () => {
  const fx = fixture(); const a = fakeAccount('xa'); const b = fakeAccount('xb', { expired: true });
  await enrolled(fx, [b, a]);
  await vault.updateState(fx.P, (s) => { s.readings.xb = { windows: [{ id: 'w', kind: 'weekly_all', label: 'weekly_all', pct: 97, resetsAt: iso(NOW + 86400e3) }], measuredAt: iso(NOW - 3 * 3600e3), source: 'live' }; });
  const f = fetchStub({ [a.at]: usage(95, 10), [b.at]: usage(1, 1) });
  const r = await R.tick({ P: fx.P, S: S(), deps: deps(fx, { fetch: f }) });
  assert.deepStrictEqual([r.action, r.reason], ['wait', 'no-usable-account']);
  const bHash = crypto.createHash('sha256').update(b.at).digest('hex').slice(0, 8);
  assert.ok(!f.calls.some((c) => c.tok === bHash), 'an expired inactive token is never sent');
  assert.strictEqual(readJson(fx.P.handoff).phase, 'waiting');
  assert.ok(readJson(fx.P.handoff).soonestResetAt);
  assert.ok(/NO USABLE ACCOUNT/.test(readJson(fx.P.notify).notice), 'a clear notice in the notification file');
});
t('tick: a dry run (check) decides but changes nothing', async () => {
  const fx = fixture(); const a = fakeAccount('da'); const b = fakeAccount('db');
  await enrolled(fx, [b, a]);
  const before = fs.readFileSync(fx.P.creds, 'utf8');
  const r = await R.tick({ P: fx.P, S: S(), dryRun: true, deps: deps(fx, { fetch: fetchStub({ [a.at]: usage(99, 1), [b.at]: usage(1, 1) }) }) });
  assert.deepStrictEqual([r.action, r.to], ['would-switch', 'db']);
  assert.strictEqual(fs.readFileSync(fx.P.creds, 'utf8'), before);
  assert.ok(!fs.existsSync(fx.P.handoff));
});

// ---- 8) token mode ------------------------------------------------------------------------------------------------
t('enroll-token: from stdin or FORGE_ROTATOR_ENROLL_TOKEN; refused as an argument; shape-validated; never printed', async () => {
  const fx = fixture(); const a = fakeAccount('tk');
  const arg = remember(await runCli(fx, ['enroll-token', 'tk', a.setup]));
  assert.strictEqual(arg.code, 2);
  assert.ok(!fs.existsSync(vault.slotPath(fx.P, 'tk')));
  const viaStdin = remember(await runCli(fx, ['enroll-token', 'tk'], { readStdin: async () => a.setup + '\n' }));
  assert.strictEqual(viaStdin.code, 0, viaStdin.all);
  assert.strictEqual(readJson(vault.slotPath(fx.P, 'tk')).token, a.setup);
  const b = fakeAccount('tk2');
  const viaEnv = remember(await runCli(fx, ['enroll-token', 'tk2'], { env: Object.assign({}, fx.env, { FORGE_ROTATOR_ENROLL_TOKEN: b.setup }) }));
  assert.strictEqual(viaEnv.code, 0, viaEnv.all);
  assert.strictEqual(remember(await runCli(fx, ['enroll-token', 'tk3'], { readStdin: async () => 'bad token with spaces' })).code, 3);
  assert.strictEqual(remember(await runCli(fx, ['enroll-token', 'tk3'], { readStdin: async () => b.setup })).code, 3, 'duplicate token refused');
  for (const r of [viaStdin, viaEnv]) assert.ok(!r.all.includes(a.setup) && !r.all.includes(b.setup));
});
t('enroll-token: a slot can hold full credentials AND a token (mode both), bound when the readings match', async () => {
  const fx = fixture(); const a = fakeAccount('both');
  login(fx, a);
  await runCli(fx, ['enroll', 'both']);
  const r = remember(await runCli(fx, ['enroll-token', 'both'], { readStdin: async () => a.setup, fetch: fetchStub({ [a.setup]: usage(30, 40), [a.at]: usage(30, 40) }) }));
  assert.strictEqual(r.code, 0, r.all);
  const slot = vault.readSlot(fx.P, 'both');
  assert.strictEqual(core.slotMode(slot), 'both');
  assert.strictEqual(slot.tokenBinding.status, 'verified');
});
t('launch: CLAUDE_CODE_OAUTH_TOKEN is set in the CHILD env only, never in this process', async () => {
  const fx = fixture(); const a = fakeAccount('la');
  await runCli(fx, ['enroll-token', 'la'], { readStdin: async () => a.setup });
  const probe = path.join(fx.root, 'fake-claude.cjs'); const outFile = path.join(fx.root, 'child.json');
  fs.writeFileSync(probe, "const c=require('crypto');require('fs').writeFileSync(process.argv[2],JSON.stringify({has:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,h:c.createHash('sha256').update(process.env.CLAUDE_CODE_OAUTH_TOKEN||'').digest('hex'),argv:process.argv.slice(3)}));");
  const r = remember(await runCli(fx, ['launch', '--account', 'la', '--', outFile, '--print', 'hi'], { claudeBin: probe, fetch: fetchStub({ [a.setup]: usage(10, 10) }) }));
  assert.strictEqual(r.code, 0, r.all);
  const child = readJson(outFile);
  assert.strictEqual(child.has, true);
  assert.strictEqual(child.h, crypto.createHash('sha256').update(a.setup).digest('hex'));
  assert.deepStrictEqual(child.argv, ['--print', 'hi']);
  assert.strictEqual(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'never set in the parent');
  assert.ok(!r.all.includes(a.setup));
  assert.ok(vault.readState(fx.P).tokenReadings.la.lastUsedAt);
});
t('launch --auto: 401/403 => usage:unmeasurable; a VERIFIED binding falls back to the account login, then last-known, then round-robin; never invents a %', async () => {
  const fx = fixture(); const x = fakeAccount('ux1'); const y = fakeAccount('uy1');
  login(fx, x); await runCli(fx, ['enroll', 'ux1']);
  await runCli(fx, ['enroll-token', 'ux1'], { readStdin: async () => x.setup, fetch: fetchStub({ [x.setup]: usage(30, 40), [x.at]: usage(30, 40) }) });
  assert.strictEqual(vault.readSlot(fx.P, 'ux1').tokenBinding.status, 'verified');
  await runCli(fx, ['enroll-token', 'uy1'], { readStdin: async () => y.setup });
  const f = fetchStub({ [x.setup]: { status: 401 }, [y.setup]: { status: 403 }, [x.at]: usage(30, 40) });
  let picked = null;
  const r = remember(await runCli(fx, ['launch', '--auto', '--', 'x'], { fetch: f, claudeBin: 'unused', spawnClaude: async (bin, args, env) => { picked = crypto.createHash('sha256').update(env.CLAUDE_CODE_OAUTH_TOKEN).digest('hex'); return { code: 0 }; } }));
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(picked, crypto.createHash('sha256').update(x.setup).digest('hex'), 'measured via the bound account login -> clear tier');
  const st = vault.readState(fx.P);
  assert.ok(st.tokenReadings.ux1.unmeasurable && st.tokenReadings.uy1.unmeasurable);
  assert.strictEqual((st.tokenReadings.uy1.windows || []).length, 0, 'no percentage invented for the unmeasurable account');
  const fx2 = fixture(); const p = fakeAccount('rr1'); const q = fakeAccount('rr2');
  await runCli(fx2, ['enroll-token', 'rr1'], { readStdin: async () => p.setup });
  await runCli(fx2, ['enroll-token', 'rr2'], { readStdin: async () => q.setup });
  await vault.updateState(fx2.P, (s) => { s.tokenReadings.rr1 = { lastUsedAt: iso(NOW - 3600e3) }; });
  let picked2 = null;
  const r2 = remember(await runCli(fx2, ['launch', '--', 'x'], { fetch: fetchStub({ [p.setup]: { status: 401 }, [q.setup]: { status: 403 } }), claudeBin: 'unused',
    spawnClaude: async (bin, args, env) => { picked2 = env.CLAUDE_CODE_OAUTH_TOKEN === q.setup ? 'rr2' : 'rr1'; return { code: 0 }; } }));
  assert.strictEqual(r2.code, 0, r2.all);
  assert.strictEqual(picked2, 'rr2', 'round-robin: the account not used in the last 5 h');
  assert.ok(/round-robin/.test(r2.out));
  const lst = remember(await runCli(fx2, ['list']));
  assert.ok(/niet meetbaar|unmeasurable/.test(lst.out), lst.out);
});
t('env: one single-quoted shell line that loads the token via token-for-shell --i-know (no token in it); token-for-shell refuses a terminal and an unflagged pipe', async () => {
  const fx = fixture(); const a = fakeAccount('ev');
  await runCli(fx, ['enroll-token', 'ev'], { readStdin: async () => a.setup });
  const ps = remember(await runCli(fx, ['env', 'ev', '--shell', 'powershell'], { isTTY: true }));
  assert.ok(/^\$env:CLAUDE_CODE_OAUTH_TOKEN = \(& '.*' '.*account-rotator\.cjs' token-for-shell ev --i-know\)$/.test(ps.out), ps.out);
  assert.ok(/WHOLE shell/.test(ps.err), 'the shell-wide scope is stated');
  const px = remember(await runCli(fx, ['env', 'ev', '--shell', 'posix'], { isTTY: true }));
  assert.ok(/^export CLAUDE_CODE_OAUTH_TOKEN=\$\('.*' '.*account-rotator\.cjs' token-for-shell ev --i-know\)$/.test(px.out), px.out);
  const trav = remember(await runCli(fx, ['env', '../ev'], { isTTY: true }));
  assert.strictEqual(trav.code, 2, 'a slot name outside the vault is refused');
  assert.ok(!ps.all.includes(a.setup) && !px.all.includes(a.setup));
  assert.strictEqual(remember(await runCli(fx, ['token-for-shell', 'ev', '--i-know'], { isTTY: true })).code, 3, 'never onto a terminal');
  assert.strictEqual(remember(await runCli(fx, ['token-for-shell', 'ev'], { isTTY: false })).code, 3, 'a pipe needs --i-know');
  let raw = '';
  const pipe = await runCli(fx, ['token-for-shell', 'ev', '--i-know'], { isTTY: false, rawOut: (s) => { raw += s; } });
  assert.strictEqual(pipe.code, 0);
  assert.strictEqual(raw, a.setup, 'only a captured, explicitly acknowledged pipe receives the token');
  assert.ok(!pipe.all.includes(a.setup));
});
t('status: warns when CLAUDE_CODE_OAUTH_TOKEN is set (it overrides the file swap) and shows each account\'s mode', async () => {
  const fx = fixture(); const a = fakeAccount('sw1'); const b = fakeAccount('sw2');
  await enrolled(fx, [b, a]);
  const et = remember(await runCli(fx, ['enroll-token', 'sw2', '--confirm-same-account'], { readStdin: async () => b.setup }));
  assert.strictEqual(et.code, 0, et.all);
  assert.strictEqual(vault.readSlot(fx.P, 'sw2').tokenBinding.status, 'unverified', 'network denied -> nothing comparable -> unverified binding');
  const r = remember(await runCli(fx, ['status'], { env: Object.assign({}, fx.env, { CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-ENV-' + rnd() }), fetch: fetchStub({ [a.at]: usage(10, 10) }),
    ownsPid: () => ({ ok: false, code: 'dead', reason: 'process not running' }) }));
  assert.ok(/CLAUDE_CODE_OAUTH_TOKEN/.test(r.out) && /ignores the file swap/.test(r.out), r.out);
  assert.ok(/\* sw1 +\[credentials\]/.test(r.out) && /sw2 +\[both\]/.test(r.out), r.out);
  const r2 = remember(await runCli(fx, ['status'], { userEnvHas: (k) => k === 'CLAUDE_CODE_OAUTH_TOKEN', fetch: fetchStub({ [a.at]: usage(10, 10) }), ownsPid: () => ({ ok: false, code: 'dead', reason: 'x' }) }));
  assert.ok(/Windows/.test(r2.out) || /user environment/.test(r2.out), r2.out);
});

// ---- 9) watcher: single instance via the pid file (real processes, network denied) --------------------------------
const SPAWNED = [];
after(() => {
  for (const pidFile of SPAWNED) {
    try { const rec = guard.readPidRecordFrom(pidFile); if (rec.pid) { try { process.kill(rec.pid); } catch { /* already gone */ } } } catch { /* nothing */ }
  }
});
function node(fx, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'account-rotator.cjs'), ...args], { env: fx.env, encoding: 'utf8', timeout: 60000 });
  const all = (r.stdout || '') + (r.stderr || '');
  ALL_OUTPUT.push(all);
  return { code: r.status, all };
}
t('watcher: start claims the pid slot, a second start/watch refuses, stop kills ONLY the recorded pid and removes the file', async () => {
  const fx = fixture(); const a = fakeAccount('pa'); const b = fakeAccount('pb');
  await enrolled(fx, [b, a]);
  SPAWNED.push(fx.P.pid);
  const s1 = node(fx, ['start', '--mode', 'file']);
  assert.strictEqual(s1.code, 0, s1.all);
  assert.ok(/started|gestart/.test(s1.all), s1.all);
  assert.ok(/forge-accounts/.test(s1.all), 'disclosure printed on a real start');
  assert.ok(/experiment/.test(s1.all), 'file mode is announced as experimental');
  const rec = guard.readPidRecordFrom(fx.P.pid);
  assert.ok(rec.pid > 0 && rec.nonce, 'the watcher record carries the start nonce');
  const s2 = node(fx, ['start', '--mode', 'file']);
  assert.ok(s2.code === 0 && /already running|draait al/.test(s2.all), s2.all);
  const w2 = node(fx, ['watch', '--mode', 'file']);
  assert.strictEqual(w2.code, 1, w2.all);
  const deadline = Date.now() + 15000;
  let logText = '';
  while (Date.now() < deadline) { logText = vault.readRaw(fx.P.log) || ''; if (/CHECK FAILED/.test(logText)) break; await new Promise((r) => setTimeout(r, 200)); }
  assert.ok(/CHECK FAILED/.test(logText) && /FetchDeniedByTestSeamError/.test(logText), 'the watcher ticked and the network was denied: ' + logText.slice(-400));
  const st = node(fx, ['stop']);
  assert.strictEqual(st.code, 0, st.all);
  assert.ok(!fs.existsSync(fx.P.pid));
  let alive = true; try { process.kill(rec.pid, 0); } catch { alive = false; }
  assert.strictEqual(alive, false);
});
t('start refuses with fewer than two enrolled logins (file mode) / two setup tokens (token mode), and when switched off', async () => {
  const fx = fixture(); const a = fakeAccount('one');
  await enrolled(fx, [a]);
  const r = await runCli(fx, ['start', '--mode', 'file']);
  assert.strictEqual(r.code, 3);
  assert.ok(/twee|two/.test(r.out), r.out);
  const rt = await runCli(fx, ['start']);
  assert.strictEqual(rt.code, 3);
  assert.ok(/setup/.test(rt.out) && /enroll-token/.test(rt.out), rt.out);
  const off = { resolve: () => ({ settings: { 'account-rotator': { value: false, source: 'global' } } }), SCHEMA: { settings: { 'account-rotator': {} } } };
  assert.strictEqual((await runCli(fx, ['start'], { configModule: off })).code, 3);
});

// ---- 10) shipping + secrecy -------------------------------------------------------------------------------------
t('forge-sync pins every account-rotator file next to usage-guard', () => {
  const files = require('./forge-sync.cjs').listSystemFiles(path.resolve(__dirname, '..'));
  for (const f of ['account-rotator.cjs', 'account-rotator-cli.cjs', 'account-rotator-core.cjs', 'account-rotator-vault.cjs', 'account-rotator-handoff.cjs',
    'account-rotator-txn.cjs', 'account-rotator-measure.cjs', 'account-rotator-token.cjs',
    'account-rotator.test.cjs', 'account-rotator-handoff.test.cjs', 'account-rotator-txn.test.cjs']) {
    assert.ok(files.includes('forge-bin/' + f), f);
    assert.ok(fs.existsSync(path.join(__dirname, f)), f + ' exists');
  }
  // forge-sync's hand-kept SYSTEM pin list is gone — delivery is DERIVED from the shipping manifest.
  // The property this pinned ("never shipped by accident of a broad sweep") now means: EVERY account-rotator file on
  // disk is delivered, and the manifest rule that ships it is an explicit, non-catch-all ship-sync rule.
  const shipcheck = require('./forge-shipcheck.cjs');
  const manifest = shipcheck.loadManifest(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'));
  assert.strictEqual(manifest.errors.length, 0, JSON.stringify(manifest.errors.slice(0, 3)));
  const onDisk = fs.readdirSync(__dirname).filter((f) => /^account-rotator.*\.cjs$/.test(f));
  assert.ok(onDisk.length >= 11, 'account-rotator files on disk: ' + onDisk.length);
  for (const f of onDisk) {
    assert.ok(files.includes('forge-bin/' + f), f + ' is delivered by forge-sync');
    const rule = shipcheck.classify(manifest.rules, '.claude/forge-bin/' + f);
    assert.ok(rule && rule.class === 'ship-sync' && !shipcheck.CATCH_ALL.has(rule.pattern), f + ' is shipped by an explicit ship-sync manifest rule (got ' + (rule ? rule.class + ' ' + rule.pattern : 'none') + ')');
  }
});
t('SECRECY: no fake token, refresh token or token fingerprint in any output, log, state, handoff, notification or guard file', () => {
  const texts = ALL_OUTPUT.slice();
  for (const dir of fs.readdirSync(ROOT).filter((d) => d.startsWith('fx-')).map((d) => path.join(ROOT, d))) {
    const home = path.join(dir, '.claude');
    const files = [path.join(home, 'FORGE_ACCOUNT_ROTATION.json'), path.join(home, 'FORGE_USAGE_GUARD_STATE.json')];
    const v = path.join(home, 'forge-accounts');
    for (const f of ['state.json', 'handoff.json', 'rotator.log']) files.push(path.join(v, f));
    for (const f of files) { const s = vault.readRaw(f); if (s !== null) texts.push(s); }
  }
  assert.ok(texts.length > 20, 'scanned a real body of output (' + texts.length + ')');
  const blob = texts.join('\n');
  for (const s of ALL_SECRETS) {
    assert.ok(!blob.includes(s), 'secret leaked');
    for (const prefix of ['rt:', 'at:', '']) assert.ok(!blob.includes(crypto.createHash('sha256').update(prefix + s).digest('hex').slice(0, 12)), 'fingerprint leaked');
  }
});
