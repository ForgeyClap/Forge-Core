#!/usr/bin/env node
'use strict';
// account-rotator-probe.test.cjs — a setup token (user:inference only) is 401/403 on /api/oauth/usage; the rotator must still read
// its windows through the official client's rate_limit_event. HERMETIC: the client and the network are injected;
// the real api.anthropic.com, the real claude binary and the vault are never touched.
const { test: nodeTest, after } = require('node:test');
const assert = require('assert');

// Tally line (ported back from the template): forge-doctor counts a suite only by its "<n> passed, <m> failed"
// line, so without it this suite read as "no evidence" (red) in every project's doctor even when all its tests passed.
// Same harness as the sibling rotator suites (account-rotator-handoff.test.cjs).
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });

process.env.FORGE_ACCOUNT_ROTATOR_DENY_NETWORK = '1';
const M = require('./account-rotator-measure.cjs');

const TOKEN = 'sk-ant-oat01-' + 'A'.repeat(60);
const EVENT = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
  five_hour: { utilization: 0.31, resetsAt: 1791788400 }, seven_day: { utilization: 0.88, resetsAt: 1792191600 } } } });
const status = (code) => async () => ({ status: code, ok: code >= 200 && code < 300, json: async () => ({}) });

test('PROBE-1: 401 on the usage endpoint falls back to the client rate_limit_event and returns percent windows', async () => {
  let calls = 0;
  const r = await M.measureToken(TOKEN, { fetch: status(401), noProbeCache: true, runClient: async (t) => { calls++; assert.strictEqual(t, TOKEN); return { ok: true, stdout: 'noise\n' + EVENT + '\n' }; } });
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.via, 'client-probe');
  assert.strictEqual(r.maxPct, 88);
  const kinds = r.windows.map((w) => w.kind).sort();
  assert.deepStrictEqual(kinds, ['session', 'weekly_all']);
  assert.strictEqual(r.windows.find((w) => w.kind === 'session').pct, 31);
});

test('PROBE-2: 429 also falls back; 500 does not (no quota spent on a server fault)', async () => {
  let calls = 0;
  const run = async () => { calls++; return { ok: true, stdout: EVENT }; };
  const a = await M.measureToken(TOKEN, { fetch: status(429), noProbeCache: true, runClient: run });
  assert.strictEqual(a.ok, true);
  const b = await M.measureToken(TOKEN, { fetch: status(500), noProbeCache: true, runClient: run });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(calls, 1);
});

test('PROBE-3: no event, a failed client or a timeout stays unmeasurable with the ORIGINAL reason, never 0 and never full', async () => {
  for (const out of [{ ok: true, stdout: '{"type":"result"}\n' }, { ok: false }, { ok: false, timeout: true }]) {
    const r = await M.measureToken(TOKEN, { fetch: status(403), noProbeCache: true, runClient: async () => out });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'unauthorized');
    assert.strictEqual(r.maxPct, undefined);
  }
});

test('PROBE-4: a partial window (only five_hour) is kept, a missing utilization is dropped, not turned into 0', async () => {
  const ev = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1791788400 }, seven_day: {} } } });
  const r = await M.measureToken(TOKEN, { fetch: status(401), noProbeCache: true, runClient: async () => ({ ok: true, stdout: ev }) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.windows.map((w) => w.kind), ['session']);
});

test('PROBE-5: the probe result is cached per token, so the 120 s watcher does not spend quota every cycle', async () => {
  let calls = 0;
  const t2 = 'sk-ant-oat01-' + 'B'.repeat(60);
  const deps = { fetch: status(401), runClient: async () => { calls++; return { ok: true, stdout: EVENT }; } };
  await M.measureToken(t2, deps);
  await M.measureToken(t2, deps);
  assert.strictEqual(calls, 1);
});

test('PROBE-6: a malformed token is rejected before any probe', async () => {
  let calls = 0;
  const r = await M.measureToken('not a token\nx', { fetch: status(401), noProbeCache: true, runClient: async () => { calls++; return { ok: true, stdout: EVENT }; } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'bad-token');
  assert.strictEqual(calls, 0);
});

test('PROBE-7: the deny seam blocks the real client when no runner is injected', async () => {
  const r = await M.probeViaClient('sk-ant-oat01-' + 'C'.repeat(60), { noProbeCache: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'denied');
});

// ---- Security Boss review 2026-11-02: the real spawn path of the probe -------------------
// M1 private folder + absolute launcher + no shell, M2 allow-list env, M3 tree kill by exact PID + single flight, L1 negative cache.
// Still HERMETIC: spawn and kill are injected fakes; the launcher paths below do not exist and are never started.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const SYSROOT = process.platform === 'win32' ? 'C:\\Windows' : '/fake/Windows';
const FAKE_BIN = path.join(os.tmpdir(), 'forge-probe-test-no-such-dir', 'claude.exe');
const UNIT_DIR = path.join(os.tmpdir(), 'forge-probe-unit-not-created');
const ROUTING = {
  ANTHROPIC_BASE_URL: 'https://proxy.invalid', ANTHROPIC_CUSTOM_HEADERS: 'x-a: b', ANTHROPIC_MODEL: 'm', ANTHROPIC_SMALL_FAST_MODEL: 'm',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
  ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'k', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'x', NODE_OPTIONS: '--require x',
  HTTPS_PROXY: 'http://p.invalid', HTTP_PROXY: 'http://p.invalid', NODE_EXTRA_CA_CERTS: 'x', NODE_TLS_REJECT_UNAUTHORIZED: '0',
  FORGE_ROTATOR_CLAUDE_BIN: FAKE_BIN,
};
function srcEnv(extra) {
  const p = path.join(os.tmpdir(), 'abs-bin') + path.delimiter + '.';
  return Object.assign({ Path: p, PATHEXT: '.EXE;.CMD', SystemRoot: SYSROOT, USERPROFILE: os.homedir(), HOME: os.homedir(), TEMP: os.tmpdir(), TMP: os.tmpdir(),
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-' + 'O'.repeat(60) }, ROUTING, extra || {});
}
function fakeChild(pid) { const c = new EventEmitter(); c.pid = pid; c.stdout = new EventEmitter(); c.kills = 0; c.kill = () => { c.kills++; }; return c; }
const hasKey = (env, k) => Object.keys(env).some((x) => x.toUpperCase() === k.toUpperCase());
const isPrivateDir = (d) => path.basename(d).startsWith('forge-probe-') && path.dirname(d) === path.resolve(os.tmpdir()) && path.resolve(d) !== path.resolve(os.tmpdir());

test('PROBE-8 (M1/M2): buildProbeSpawn keeps the token out of cmd/args, passes only allow-listed env, runs in the private folder with an absolute launcher and no shell', () => {
  for (const platform of ['win32', 'linux']) {
    const s = M.buildProbeSpawn(TOKEN, { dir: UNIT_DIR, platform, env: srcEnv(platform === 'win32' ? {} : { PATH: path.join(os.tmpdir(), 'abs-bin') }), claudeBin: FAKE_BIN });
    assert.ok(!s.refused, platform + ': ' + s.refused);
    assert.ok(path.isAbsolute(s.cmd), platform + ' launcher is absolute: ' + s.cmd);
    assert.strictEqual(s.cmd, FAKE_BIN);
    assert.ok(!JSON.stringify([s.cmd, s.args, Object.assign({}, s.opts, { env: null })]).includes(TOKEN), 'token never in cmd, args or options');
    assert.strictEqual(s.opts.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN, 'the token travels in the child env only');
    for (const k of Object.keys(ROUTING)) assert.ok(!hasKey(s.opts.env, k), platform + ': ' + k + ' must not reach the child');
    const allowed = new Set(M.PROBE_ENV_ALLOW.concat(['CLAUDE_CODE_OAUTH_TOKEN', 'NoDefaultCurrentDirectoryInExePath']));
    for (const k of Object.keys(s.opts.env)) assert.ok(allowed.has(k), platform + ': unexpected env key ' + k);
    assert.strictEqual(s.opts.cwd, UNIT_DIR);
    assert.notStrictEqual(path.resolve(s.opts.cwd), path.resolve(os.tmpdir()), 'never the shared temp root');
    assert.notStrictEqual(s.opts.shell, true, 'no shell');
    assert.deepStrictEqual(s.args.slice(0, 2), ['-p', '.']);
    const mi = s.args.indexOf('--mcp-config');
    assert.ok(mi > 0 && s.args[mi + 1] === path.join(UNIT_DIR, 'mcp.json'), 'empty MCP config from the private folder');
    assert.ok(s.args.indexOf('--strict-mcp-config') > mi + 1, '--strict-mcp-config after the config file (the option takes several values)');
    assert.ok(typeof s.opts.env.PATH === 'string' && s.opts.env.PATH.length > 0, platform + ': PATH reaches the child');
    assert.ok(s.opts.env.PATH.split(path.delimiter).every((d) => path.isAbsolute(d)), 'no relative PATH entry reaches the child');
    if (platform === 'win32') assert.strictEqual(s.opts.env.NoDefaultCurrentDirectoryInExePath, '1');
    else assert.strictEqual(s.opts.detached, true, 'POSIX: own process group so the whole tree can be killed');
  }
});

test('PROBE-9 (M1): FORGE_ROTATOR_CLAUDE_BIN is honoured, a relative, PowerShell or shared-temp launcher/folder is refused', () => {
  const viaEnv = M.buildProbeSpawn(TOKEN, { dir: UNIT_DIR, platform: 'win32', env: srcEnv() });
  assert.ok(!viaEnv.refused, viaEnv.refused);
  assert.strictEqual(viaEnv.cmd, FAKE_BIN);
  assert.ok(!hasKey(viaEnv.opts.env, 'FORGE_ROTATOR_CLAUDE_BIN'));
  for (const bad of ['claude', 'unused', path.join(os.tmpdir(), 'x', 'claude.ps1')]) {
    const s = M.buildProbeSpawn(TOKEN, { dir: UNIT_DIR, platform: 'win32', env: srcEnv(), claudeBin: bad });
    assert.ok(s.refused, bad + ' must be refused');
  }
  for (const dir of [os.tmpdir(), 'forge-probe-relative', path.join(os.tmpdir(), 'other-name')]) {
    assert.ok(M.buildProbeSpawn(TOKEN, { dir, platform: 'win32', env: srcEnv(), claudeBin: FAKE_BIN }).refused, dir + ' is not a private probe folder');
  }
});

test('PROBE-10 (M1): the PATH walk skips relative entries, so a claude in the current folder is never chosen', () => {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const rel = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-probe-test-rel-'));
  const abs = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-probe-test-abs-'));
  try {
    fs.writeFileSync(path.join(rel, exe), 'not a program');
    fs.writeFileSync(path.join(abs, exe), 'not a program');
    const relEntry = path.relative(process.cwd(), rel);
    assert.ok(!path.isAbsolute(relEntry), 'fixture: a relative PATH entry that really resolves from the current folder');
    const env = { PATH: [relEntry, abs].join(path.delimiter), SystemRoot: SYSROOT };
    const s = M.buildProbeSpawn(TOKEN, { dir: UNIT_DIR, platform: process.platform, env });
    assert.ok(!s.refused, s.refused);
    assert.strictEqual(s.cmd, path.join(abs, exe));
  } finally { fs.rmSync(rel, { recursive: true, force: true }); fs.rmSync(abs, { recursive: true, force: true }); }
});

test('PROBE-11 (M1/L2): a .cmd shim runs through System32 cmd.exe with every word quoted (no shell:true, no raw join); unsafe text is refused', () => {
  const shim = path.join(os.tmpdir(), 'npm & dir', 'claude.cmd');
  const s = M.buildProbeSpawn(TOKEN, { dir: UNIT_DIR, platform: 'win32', env: srcEnv({ ComSpec: 'evil.exe' }), claudeBin: shim });
  assert.ok(!s.refused, s.refused);
  assert.strictEqual(s.cmd, path.join(SYSROOT, 'System32', 'cmd.exe'), 'never the inherited ComSpec or a bare name');
  assert.deepStrictEqual(s.args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  assert.ok(s.args[4].startsWith('""' + shim + '" "-p" "."'), s.args[4]);
  assert.strictEqual(s.opts.windowsVerbatimArguments, true);
  assert.notStrictEqual(s.opts.shell, true);
  assert.ok(!s.args.join(' ').includes(TOKEN));
  assert.ok(M.buildProbeSpawn(TOKEN, { dir: UNIT_DIR, platform: 'win32', env: srcEnv(), claudeBin: path.join(os.tmpdir(), '100%x', 'claude.cmd') }).refused);
  const src = fs.readFileSync(path.join(__dirname, 'account-rotator-measure.cjs'), 'utf8');
  assert.ok(!/shell:\s*true/.test(src), 'the probe never starts a shell');
});

test('PROBE-12 (M1/M3, win32): on timeout the whole tree is killed by exact PID through System32 taskkill, and the private folder is removed', async () => {
  const calls = []; let probe = null;
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts, mcp: calls.length ? null : fs.readFileSync(path.join(opts.cwd, 'mcp.json'), 'utf8') });
    if (!probe) { probe = fakeChild(4242); return probe; }
    const k = fakeChild(5151); setImmediate(() => { probe.emit('close', 1); k.emit('close', 0); }); return k;
  };
  const r = await M.runClientProbe(TOKEN, { platform: 'win32', spawn, claudeBin: FAKE_BIN, env: { SystemRoot: SYSROOT, PATH: '' }, probeTimeoutMs: 30 });
  assert.deepStrictEqual(r, { ok: false, timeout: true });
  assert.strictEqual(calls.length, 2, 'probe + one taskkill');
  assert.strictEqual(calls[1].cmd, path.join(SYSROOT, 'System32', 'taskkill.exe'));
  assert.deepStrictEqual(calls[1].args, ['/PID', '4242', '/T', '/F']);
  assert.ok(!calls.some((c) => c.args.some((a) => /^\/IM$/i.test(a))), 'never by image name');
  assert.ok(isPrivateDir(calls[0].opts.cwd), 'private folder: ' + calls[0].opts.cwd);
  assert.strictEqual(calls[0].mcp, '{"mcpServers":{}}');
  assert.ok(!fs.existsSync(calls[0].opts.cwd), 'private folder removed after the timeout');
});

test('PROBE-13 (M3, POSIX): on timeout the process group is killed (detached + process.kill(-pid))', async () => {
  const calls = []; const kills = []; let probe = null;
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); probe = fakeChild(4343); return probe; };
  const processKill = (pid, sig) => { kills.push([pid, sig]); setImmediate(() => probe.emit('close', null)); };
  const r = await M.runClientProbe(TOKEN, { platform: 'linux', spawn, processKill, claudeBin: FAKE_BIN, env: { PATH: '' }, probeTimeoutMs: 30 });
  assert.deepStrictEqual(r, { ok: false, timeout: true });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.detached, true);
  assert.deepStrictEqual(kills, [[-4343, 'SIGKILL']]);
  assert.ok(!fs.existsSync(calls[0].opts.cwd), 'private folder removed');
});

test('PROBE-14 (M1): a normal run, a spawn that throws and a child "error" all remove the private folder; a refused launcher never spawns', async () => {
  const seen = [];
  const base = { platform: process.platform, claudeBin: FAKE_BIN, env: { SystemRoot: SYSROOT, PATH: '' } };
  const ok = await M.runClientProbe(TOKEN, Object.assign({}, base, {
    spawn: (cmd, args, opts) => { seen.push(opts.cwd); const c = fakeChild(1); setImmediate(() => { c.stdout.emit('data', EVENT + '\n'); c.emit('close', 0); }); return c; } }));
  assert.strictEqual(ok.ok, true);
  assert.ok(/rate_limit_event/.test(ok.stdout));
  const thrown = await M.runClientProbe(TOKEN, Object.assign({}, base, { spawn: (cmd, args, opts) => { seen.push(opts.cwd); throw new Error('spawn EACCES'); } }));
  assert.strictEqual(thrown.ok, false);
  const errored = await M.runClientProbe(TOKEN, Object.assign({}, base, {
    spawn: (cmd, args, opts) => { seen.push(opts.cwd); const c = fakeChild(undefined); setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; } }));
  assert.strictEqual(errored.ok, false);
  assert.strictEqual(seen.length, 3);
  for (const d of seen) { assert.ok(isPrivateDir(d), d); assert.ok(!fs.existsSync(d), 'removed: ' + d); }
  assert.strictEqual(new Set(seen).size, 3, 'a fresh folder per probe');
  const refused = await M.runClientProbe(TOKEN, { platform: 'win32', claudeBin: 'claude', env: { PATH: '' }, spawn: () => { throw new Error('must not spawn'); } });
  assert.strictEqual(refused.ok, false);
  assert.ok(/absolute/.test(refused.refused), refused.refused);
});

test('PROBE-15 (M3): single flight — concurrent measurements of one token start ONE probe; another token gets its own', async () => {
  let calls = 0; let release; const gate = new Promise((r) => { release = r; });
  const deps = { noProbeCache: true, runClient: async () => { calls++; await gate; return { ok: true, stdout: EVENT }; } };
  const tD = 'sk-ant-oat01-' + 'D'.repeat(60); const tE = 'sk-ant-oat01-' + 'E'.repeat(60);
  const ps = [M.probeViaClient(tD, deps), M.probeViaClient(tD, deps), M.probeViaClient(tE, deps)];
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls, 2, 'one probe for D, one for E');
  release();
  const rs = await Promise.all(ps);
  assert.ok(rs.every((x) => x.ok));
  await M.probeViaClient(tD, deps);
  assert.strictEqual(calls, 3, 'the finished flight does not stick');
});

test('PROBE-16 (L1): "probe-failed" and "empty" are cached for a short backoff, shown in the reason line, then retried', async () => {
  assert.ok(M.PROBE_NEG_CACHE_MS >= 15 * 60e3 && M.PROBE_NEG_CACHE_MS <= 30 * 60e3, 'backoff 15-30 min');
  for (const [letter, out, kind] of [['F', { ok: false, timeout: true }, 'probe-failed'], ['G', { ok: true, stdout: '{"type":"result"}\n' }, 'empty']]) {
    const tok = 'sk-ant-oat01-' + letter.repeat(60);
    let calls = 0; let now = Date.parse('2026-11-02T12:00:00.000Z');
    const deps = { fetch: status(401), now: () => now, runClient: async () => { calls++; return out; } };
    const r1 = await M.measureToken(tok, deps);
    assert.strictEqual(calls, 1);
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.kind, 'unauthorized', 'the original reason stays the kind');
    assert.ok(r1.probe, 'the probe outcome travels with the result');
    assert.strictEqual(r1.probe.kind, kind);
    assert.strictEqual(r1.probe.retryAt, new Date(Date.parse('2026-11-02T12:00:00.000Z') + M.PROBE_NEG_CACHE_MS).toISOString());
    assert.ok(/usage endpoint HTTP 401/.test(r1.error) && r1.error.includes(r1.probe.retryAt), r1.error);
    const fp = require('crypto').createHash('sha256').update(tok).digest('hex').slice(0, 12);
    assert.ok(!r1.error.includes(tok) && !r1.error.includes(fp), 'no token or fingerprint in the reason');
    now += M.PROBE_NEG_CACHE_MS - 60e3;
    const r2 = await M.measureToken(tok, deps);
    assert.strictEqual(calls, 1, 'still backing off');
    assert.strictEqual(r2.probe.retryAt, r1.probe.retryAt);
    now += 2 * 60e3;
    await M.measureToken(tok, deps);
    assert.strictEqual(calls, 2, 'retried after the backoff');
  }
});
