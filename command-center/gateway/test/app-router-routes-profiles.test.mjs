// App router P3 (APP-ROUTER-DESIGN.md 3.3, 6.1 / 7.2): POST /api/app-router/profiles and
// POST /api/app-router/targets/:id/test against the REAL gateway listener. The probe is replaced through
// the route's test seam, so no `claude` process, no Ollama and no network is used here. Profile folders
// go to a temp FORGE_ROUTER_PROFILES_DIR whose path has a space and an apostrophe (shell quoting).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, _configureRateLimitForTests } from '../src/server.mjs';
import { EXEC_TOKEN_HEADER, issueAgentToken } from '../src/security.mjs';
import { _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { readReadings } from '../src/app-router/usage-readings.mjs';
import { readRouterEvents } from '../src/app-router/router-log.mjs';
import { _setProbeForTests, normalizeProbeResult } from '../src/routes/app-router.mjs';
import { _setProbeSpawnSpecForTests } from '../src/app-router/probe.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const SECRET_LIKE = 'sk' + '-' + 'A'.repeat(24);

let tmp;
let profilesRoot;
let server;
let port;
let savedProfilesEnv;

function listen(s) {
  return new Promise((resolve, reject) => {
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-router-profiles-'));
  profilesRoot = path.join(tmp, "Jan de Vries's", 'profiles');
  savedProfilesEnv = process.env.FORGE_ROUTER_PROFILES_DIR;
  process.env.FORGE_ROUTER_PROFILES_DIR = profilesRoot;
  server = createServer();
  port = await listen(server);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _setRouterDirForTests(null);
  _setProbeForTests(null);
  _configureRateLimitForTests();
  if (savedProfilesEnv === undefined) delete process.env.FORGE_ROUTER_PROFILES_DIR;
  else process.env.FORGE_ROUTER_PROFILES_DIR = savedProfilesEnv;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

let routerDir;
beforeEach(() => {
  routerDir = fs.mkdtempSync(path.join(tmp, 'router-'));
  _setRouterDirForTests(routerDir);
  _setProbeForTests(null);
  _configureRateLimitForTests();
});

const addAccount = (label, opts = {}) => requestWithBody(port, '/api/app-router/profiles', { jsonBody: { label }, ...opts });
const runTest = (id, body = {}, opts = {}) => requestWithBody(port, '/api/app-router/targets/' + id + '/test', { jsonBody: body, ...opts });

function ollama(extra = {}) {
  return {
    id: 'ollama-llama31', kind: 'provider-model', label: 'Ollama · llama3.1', provider: 'ollama-local',
    model: 'llama3.1:8b', enabled: true, num_ctx: 8192, vars: { port: '11434' }, paid_ack: false, notice_ack: false, ...extra,
  };
}
async function saveConfig(cfg) {
  const r = await requestWithBody(port, '/api/app-router', { jsonBody: cfg });
  assert.equal(r.statusCode, 200, r.body);
  return r.json.config;
}

// ---- profiles -------------------------------------------------------------------------------------

test('add an account: 201, an EMPTY folder, a claude-account entry, quoted sign-in commands, ~ display', async () => {
  const r = await addAccount('Werk');
  assert.equal(r.statusCode, 201, r.body);
  assert.deepEqual(r.json.entry, { id: 'werk', kind: 'claude-account', label: 'Werk', profile: 'werk', enabled: true, threshold_pct: null });
  assert.equal(r.json.config.revision, 1);
  assert.deepEqual(r.json.config.entries.map((e) => e.id), ['main', 'werk']);
  const dir = path.join(profilesRoot, 'werk');
  assert.equal(fs.statSync(dir).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(dir), [], 'the gateway writes nothing inside a profile folder');
  // PowerShell: single quotes, an apostrophe doubled; the variable is removed afterwards.
  assert.ok(r.json.login.powershell.includes("'" + dir.replace(/'/g, "''") + "'"), r.json.login.powershell);
  assert.match(r.json.login.powershell, /Remove-Item Env:CLAUDE_CONFIG_DIR/);
  assert.ok(r.json.login.posix.startsWith('CLAUDE_CONFIG_DIR=\''));
  assert.ok('cmd' in r.json.login);
  if (dir.startsWith(os.homedir())) assert.ok(r.json.dir_display.startsWith('~'), r.json.dir_display);
  const g = await request(port, '/api/app-router');
  assert.deepEqual(g.json.config, r.json.config);
});

test('add the same name again (or a name with the same folder): 409, no second entry', async () => {
  assert.equal((await addAccount('Prive')).statusCode, 201);
  const again = await addAccount('Prive');
  assert.equal(again.statusCode, 409);
  const sameSlug = await addAccount('prive!');
  assert.equal(sameSlug.statusCode, 409);
  const g = await request(port, '/api/app-router');
  assert.deepEqual(g.json.config.entries.map((e) => e.id), ['main', 'prive']);
});

test('a removed account\'s folder is reused when it is added again (the sign-in stays)', async () => {
  const first = await addAccount('Thuis');
  assert.equal(first.statusCode, 201);
  const cfg = first.json.config;
  await saveConfig({ ...cfg, entries: cfg.entries.filter((e) => e.id !== 'thuis') });
  assert.equal(fs.existsSync(path.join(profilesRoot, 'thuis')), true, 'removing the entry keeps the folder');
  const again = await addAccount('Thuis');
  assert.equal(again.statusCode, 201);
});

test('bad labels: 400 and no folder is made (empty, wrong type, secret-shaped, unknown field)', async () => {
  const before = fs.existsSync(profilesRoot) ? fs.readdirSync(profilesRoot) : [];
  assert.equal((await addAccount('   ')).statusCode, 400);
  assert.equal((await requestWithBody(port, '/api/app-router/profiles', { jsonBody: { label: 42 } })).statusCode, 400);
  assert.equal((await requestWithBody(port, '/api/app-router/profiles', { jsonBody: { label: 'Werk', profile: 'x' } })).statusCode, 400);
  const secret = await addAccount(SECRET_LIKE);
  assert.equal(secret.statusCode, 400);
  assert.ok(secret.json.errors.some((e) => e.code === 'secret_like_value'));
  assert.ok(!secret.body.includes(SECRET_LIKE));
  const after = fs.existsSync(profilesRoot) ? fs.readdirSync(profilesRoot) : [];
  assert.deepEqual(after, before);
});

test('the 8-account cap: the 8th Claude account is accepted, a 9th answers 409 too_many_claude', async () => {
  for (let i = 1; i <= 7; i++) assert.equal((await addAccount('Extra ' + i)).statusCode, 201, 'account ' + i);
  const ninth = await addAccount('Extra 8');
  assert.equal(ninth.statusCode, 409);
  assert.equal(ninth.json.code, 'too_many_claude');
});

test('add an account when router.json is damaged: 503 and nothing is overwritten', async () => {
  fs.writeFileSync(path.join(routerDir, 'router.json'), 'not json', 'utf8');
  const r = await addAccount('Nieuw');
  assert.equal(r.statusCode, 503);
  assert.equal(fs.readFileSync(path.join(routerDir, 'router.json'), 'utf8'), 'not json');
  assert.equal(fs.existsSync(path.join(profilesRoot, 'nieuw')), false);
});

test('profiles: 403 without the dashboard credential and for an agent token', async () => {
  assert.equal((await addAccount('Werk', { omitExecToken: true })).statusCode, 403);
  const agent = await addAccount('Werk', { omitExecToken: true, headers: { [EXEC_TOKEN_HEADER]: issueAgentToken('c-p3-agent') } });
  assert.equal(agent.statusCode, 403);
  assert.equal(fs.readdirSync(routerDir).includes('router.json'), false, 'nothing stored');
});

// ---- test endpoint --------------------------------------------------------------------------------

test('Test ok: 200 state ready, the reading is stored as source "test", a router_test line is logged', async () => {
  await addAccount('Werk');
  let seen = null;
  _setProbeForTests(async (entry) => {
    seen = entry;
    return { outcome: 'ok', reading: { windows: [{ type: 'five_hour', pct: null, resets_at: '2026-11-02T18:00:00.000Z', status: 'allowed' }], status: 'allowed' }, detail: 'MOCK-PROFILE:werk' };
  });
  const r = await runTest('werk');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json, {
    ok: true, state: 'ready',
    reading: { windows: [{ type: 'five_hour', pct: null, resets_at: '2026-11-02T18:00:00.000Z', status: 'allowed' }], status: 'allowed' },
    detail: 'MOCK-PROFILE:werk',
  });
  assert.equal(seen.id, 'werk');
  assert.equal(seen.profile, 'werk');
  const rec = readReadings().werk;
  assert.equal(rec.source, 'test');
  assert.equal(rec.windows[0].pct, null, 'a missing percentage stays null');
  const ev = readRouterEvents().filter((e) => e.kind === 'router_test');
  assert.deepEqual(ev.map((e) => [e.target_id, e.outcome]), [['werk', 'ok']]);
});

test('one click with the REAL probe writes ONE reading and ONE router_test line (one writer per fact)', async () => {
  const resetsEpoch = Math.floor(Date.now() / 1000) + 3600;
  const lines = [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: resetsEpoch, rateLimitType: 'five_hour' } },
    { type: 'result', is_error: false, result: 'ok' },
  ];
  const script = lines.map((l) => 'console.log(' + JSON.stringify(JSON.stringify(l)) + ');').join('');
  _setProbeSpawnSpecForTests(() => ({ cmd: process.execPath, args: ['-e', script] }));
  const realRename = fs.renameSync;
  const usageWrites = [];
  fs.renameSync = function countUsageWrites(from, to) {
    if (path.basename(String(to)) === 'usage.json') usageWrites.push(String(to));
    return realRename.apply(this, arguments);
  };
  let r;
  try {
    r = await runTest('main');
  } finally {
    fs.renameSync = realRename;
    _setProbeSpawnSpecForTests(null);
  }
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.state, 'ready');
  assert.equal(r.json.reading.windows[0].type, 'five_hour');
  assert.equal(usageWrites.length, 1, 'the probe stores the reading; the route does not store it a second time');
  const rec = readReadings().main;
  assert.deepEqual([rec.source, rec.windows[0].type, rec.windows[0].resets_at], ['test', 'five_hour', new Date(resetsEpoch * 1000).toISOString()]);
  const ev = readRouterEvents().filter((e) => e.kind === 'router_test');
  assert.deepEqual(ev.map((e) => [e.target_id, e.outcome]), [['main', 'ok']], 'exactly one router_test line per click');
});

test('Test twice within 5 minutes after a quota-using probe: 429 with retry_after_s, the probe runs once', async () => {
  let calls = 0;
  _setProbeForTests(async () => { calls += 1; return { outcome: 'ok', reading: null, detail: null }; });
  assert.equal((await runTest('main')).statusCode, 200);
  const second = await runTest('main');
  assert.equal(second.statusCode, 429);
  assert.equal(second.json.error, 'rate_limited');
  assert.ok(second.json.retry_after_s > 200 && second.json.retry_after_s <= 300, String(second.json.retry_after_s));
  assert.ok(Number(second.headers['retry-after']) >= 1);
  assert.equal(calls, 1);
});

test('Test logged out: 200 state logged_out, needs-login is marked, and a re-test right after signing in is allowed', async () => {
  await addAccount('Werk');
  let signedIn = false;
  _setProbeForTests(async () => (signedIn
    ? { outcome: 'ok', reading: { windows: [], status: 'allowed' }, detail: 'MOCK-PROFILE:werk' }
    : { outcome: 'logged_out', reading: null, detail: 'Not logged in' }));
  const r = await runTest('werk');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.state, 'logged_out');
  assert.equal(r.json.reading, null);
  assert.ok(readReadings().werk.needs_login_at);
  const status = await request(port, '/api/app-router/status');
  assert.equal(status.json.entries.find((e) => e.id === 'werk').state, 'needs-login');
  // The user signs in and clicks Test again at once: a logged-out probe cost nothing, so no 5-minute wait.
  signedIn = true;
  const again = await runTest('werk');
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json.state, 'ready');
  assert.equal(readReadings().werk.needs_login_at, null, 'a working probe clears needs-login');
  // ...but that probe used quota, so a third click within 5 minutes is refused.
  assert.equal((await runTest('werk')).statusCode, 429);
});

test('Test of a provider that is down: the specific code comes back as the state and the entry is marked down', async () => {
  await saveConfig({ ...defaultRouterConfig(), mode: 'claude-then-model', entries: [...defaultRouterConfig().entries, ollama()] });
  _setProbeForTests(async () => ({ outcome: 'down', code: 'ollama_down', reading: null, detail: 'connect ECONNREFUSED 127.0.0.1:11434' }));
  const r = await runTest('ollama-llama31');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.state, 'ollama_down');
  assert.ok(readReadings()['ollama-llama31'].down_at);
  const st = await request(port, '/api/app-router/status');
  assert.equal(st.json.entries.find((e) => e.id === 'ollama-llama31').state, 'down');
});

test('Test that hits a limit: state rate_limited and a limit hit with the rejected window\'s reset time', async () => {
  const resets = new Date(Date.now() + 3_600_000).toISOString();
  _setProbeForTests(async () => ({ outcome: 'rate_limited', reading: { windows: [{ type: 'five_hour', pct: 100, resets_at: resets, status: 'rejected' }], status: 'rejected' }, detail: null }));
  const r = await runTest('main');
  assert.equal(r.json.state, 'rate_limited');
  assert.deepEqual([readReadings().main.limit_hit.window, readReadings().main.limit_hit.resets_at], ['five_hour', resets]);
});

test('a probe that throws or answers nonsense reads as an honest error, never as a pass', async () => {
  _setProbeForTests(async () => { throw new Error('spawn failed ' + SECRET_LIKE); });
  const r = await runTest('main');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.state, 'error');
  assert.ok(!r.body.includes(SECRET_LIKE));
  _setProbeForTests(async () => 'yes');
  assert.equal((await runTest('main')).json.state, 'error');
});

test('the probe\'s detail is redacted and capped', async () => {
  _setProbeForTests(async () => ({ outcome: 'error', reading: null, detail: 'boom ' + SECRET_LIKE + ' ' + 'x'.repeat(500) }));
  const r = await runTest('main');
  assert.ok(!r.body.includes(SECRET_LIKE));
  assert.ok(r.json.detail.length <= 200);
});

test('a second Test while one runs for the same target: 409, the probe is not started twice', async () => {
  let release;
  let calls = 0;
  _setProbeForTests(() => { calls += 1; return new Promise((resolve) => { release = () => resolve({ outcome: 'logged_out', reading: null, detail: null }); }); });
  const first = runTest('main');
  for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
  const second = await runTest('main');
  assert.equal(second.statusCode, 409);
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal(calls, 1);
});

test('Test input checks: unknown target 404, a non-empty body 400, a bad id never reaches a route (405), no credential 403', async () => {
  let calls = 0;
  _setProbeForTests(async () => { calls += 1; return { outcome: 'ok' }; });
  assert.equal((await runTest('nobody')).statusCode, 404);
  assert.equal((await runTest('main', { model: 'haiku' })).statusCode, 400);
  assert.equal((await runTest('Main')).statusCode, 405);
  assert.equal((await runTest('main', {}, { omitExecToken: true })).statusCode, 403);
  assert.equal(calls, 0);
});

test('normalizeProbeResult: accepts outcome or state, maps down codes, refuses unknown words', () => {
  assert.equal(normalizeProbeResult({ state: 'ready' }).outcome, 'ok');
  assert.deepEqual([normalizeProbeResult({ outcome: 'model_not_pulled' }).outcome, normalizeProbeResult({ outcome: 'model_not_pulled' }).code], ['down', 'model_not_pulled']);
  assert.equal(normalizeProbeResult({ outcome: 'stopped' }).outcome, 'error');
  assert.equal(normalizeProbeResult({ outcome: 'great' }).outcome, 'error');
  assert.equal(normalizeProbeResult(undefined).outcome, 'error');
  assert.equal(normalizeProbeResult({ outcome: 'ok', recorded: true }).recorded, true);
});
