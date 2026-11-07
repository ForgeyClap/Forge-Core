// App router P3 (APP-ROUTER-DESIGN.md 6.1 / 7.2): GET + POST /api/app-router and GET /api/app-router/status
// against the REAL gateway listener (server.mjs createServer), so the method allowlist, the token check
// and the route table are exercised exactly as in production. The router folder, the profiles root and
// the conversations folder all point at fresh temp folders. No `claude` process is started in this file.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, _configureRateLimitForTests } from '../src/server.mjs';
import { EXEC_TOKEN_HEADER, issueAgentToken } from '../src/security.mjs';
import { _setRouterDirForTests, routerConfigFile } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { recordReading } from '../src/app-router/usage-readings.mjs';
import { appendRouterEvent } from '../src/app-router/router-log.mjs';
import { publicDecision, isAppRouterWriteRoute } from '../src/routes/app-router.mjs';
import { createConversation, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH_FIXTURES = path.resolve(HERE, '..', '..', 'dashboard', 'tests', 'fixtures', 'app-router');
const SECRET_LIKE = 'sk' + '-' + 'A'.repeat(24);

let tmp;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-router-routes-'));
  fs.mkdirSync(path.join(tmp, 'router'));
  fs.mkdirSync(path.join(tmp, 'profiles'));
  fs.mkdirSync(path.join(tmp, 'conv'));
  savedProfilesEnv = process.env.FORGE_ROUTER_PROFILES_DIR;
  process.env.FORGE_ROUTER_PROFILES_DIR = path.join(tmp, 'profiles');
  _setConversationsDirForTests(path.join(tmp, 'conv'));
  server = createServer();
  port = await listen(server);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _setRouterDirForTests(null);
  _resetConversationsForTests();
  _configureRateLimitForTests();
  if (savedProfilesEnv === undefined) delete process.env.FORGE_ROUTER_PROFILES_DIR;
  else process.env.FORGE_ROUTER_PROFILES_DIR = savedProfilesEnv;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

// A fresh router folder per test: no state leaks between tests.
let routerDir;
beforeEach(() => {
  routerDir = fs.mkdtempSync(path.join(tmp, 'router', 'r-'));
  _setRouterDirForTests(routerDir);
  _configureRateLimitForTests();
});

function ollama(extra = {}) {
  return {
    id: 'ollama-llama31', kind: 'provider-model', label: 'Ollama · llama3.1', provider: 'ollama-local',
    model: 'llama3.1:8b', enabled: true, num_ctx: 8192, vars: { port: '11434' }, paid_ack: false, notice_ack: false, ...extra,
  };
}
function claudeThenModel(revision = 0) {
  const c = defaultRouterConfig();
  return { ...c, revision, mode: 'claude-then-model', entries: [...c.entries, ollama()] };
}
const post = (body, opts = {}) => requestWithBody(port, '/api/app-router', { jsonBody: body, ...opts });
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DASH_FIXTURES, name), 'utf8'));
const keys = (o) => Object.keys(o).sort();

// ---- GET ------------------------------------------------------------------------------------------

test('GET with no file: provenance DEFAULT, the default config, https terms sources, ~-shortened profiles root', async () => {
  const r = await request(port, '/api/app-router');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.provenance, 'DEFAULT');
  assert.deepEqual(r.json.config, defaultRouterConfig());
  assert.equal(r.json.terms.checked_at, '2026-11-02');
  assert.equal(r.json.terms.sources.length, 3);
  for (const s of r.json.terms.sources) assert.match(s.url, /^https:\/\//);
  assert.equal(typeof r.json.profiles_root_display, 'string');
  if (path.join(tmp, 'profiles').startsWith(os.homedir())) assert.ok(!r.json.profiles_root_display.includes(os.homedir()), 'home folder is shown as ~');
  assert.ok(Number.isFinite(Date.parse(r.json.captured_at)));
});

test('GET answers with the same key set as the dashboard fixture (contract)', async () => {
  const r = await request(port, '/api/app-router');
  assert.deepEqual(keys(r.json), keys(readJson('get-default.json')));
  assert.deepEqual(keys(r.json.terms), keys(readJson('get-default.json').terms));
});

test('GET with a damaged file: provenance UNREADABLE, mode off, never a 500; the next save replaces it', async () => {
  fs.writeFileSync(routerConfigFile(), '{"version":1,"revision":4,"mode":"bogus"', 'utf8');
  const r = await request(port, '/api/app-router');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.provenance, 'UNREADABLE');
  assert.equal(r.json.config.mode, 'off');
  const saved = await post(claudeThenModel(r.json.config.revision));
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await request(port, '/api/app-router')).json.provenance, 'STORED');
});

test('GET with a file that parses but is no longer valid keeps its revision, so a save does not 409-loop', async () => {
  fs.writeFileSync(routerConfigFile(), JSON.stringify({ ...defaultRouterConfig(), revision: 9, mode: 'nope' }), 'utf8');
  const r = await request(port, '/api/app-router');
  assert.equal(r.json.provenance, 'UNREADABLE');
  assert.equal(r.json.config.revision, 9);
  assert.equal((await post(claudeThenModel(9))).statusCode, 200);
});

// ---- POST -----------------------------------------------------------------------------------------

test('POST a valid config: 200, revision + 1, updated_at set, GET then reads it back as STORED', async () => {
  const r = await post(claudeThenModel(0));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.config.revision, 1);
  assert.equal(r.json.config.mode, 'claude-then-model');
  assert.ok(Number.isFinite(Date.parse(r.json.config.updated_at)));
  const g = await request(port, '/api/app-router');
  assert.equal(g.json.provenance, 'STORED');
  assert.deepEqual(g.json.config, r.json.config);
  const log = fs.readFileSync(path.join(routerDir, 'router-events.jsonl'), 'utf8');
  assert.match(log, /"kind":"router_config_changed"/);
});

test('POST an invalid config: 400 with {path, code, nl, en} errors and nothing stored', async () => {
  const bad = claudeThenModel(0);
  bad.entries[0].threshold_pct = 120;
  const r = await post(bad);
  assert.equal(r.statusCode, 400);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.length >= 1);
  for (const e of r.json.errors) assert.deepEqual(keys(e), ['code', 'en', 'nl', 'path']);
  assert.ok(r.json.errors.some((e) => e.code === 'out_of_range'));
  assert.equal(fs.existsSync(routerConfigFile()), false);
});

test('POST a secret-shaped label: 400 secret_like_value and the value is never echoed back', async () => {
  const bad = claudeThenModel(0);
  bad.entries[0].label = SECRET_LIKE;
  const r = await post(bad);
  assert.equal(r.statusCode, 400);
  assert.ok(r.json.errors.some((e) => e.code === 'secret_like_value'));
  assert.ok(!r.body.includes(SECRET_LIKE));
});

test('POST unparseable JSON: 400 without quoting the body', async () => {
  const r = await requestWithBody(port, '/api/app-router', { rawBody: '{"label":"' + SECRET_LIKE + '"' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json.error, 'request body is not valid JSON');
  assert.ok(!r.body.includes(SECRET_LIKE));
});

test('POST with an old revision: 409 stale_revision with the current config', async () => {
  assert.equal((await post(claudeThenModel(0))).statusCode, 200);
  const r = await post({ ...claudeThenModel(0), mode: 'model-first', entries: [ollama(), defaultRouterConfig().entries[0]] });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json.error, 'stale_revision');
  assert.equal(r.json.config.revision, 1);
  assert.equal(r.json.config.mode, 'claude-then-model');
});

test('POST is refused 403 without the dashboard credential and 403 for an agent token; nothing stored', async () => {
  const none = await post(claudeThenModel(0), { omitExecToken: true });
  assert.equal(none.statusCode, 403);
  assert.equal(none.json.code, 'ui_session_required');
  const conv = createConversation({ project: 'p3-agent-token' });
  const agent = await post(claudeThenModel(0), { omitExecToken: true, headers: { [EXEC_TOKEN_HEADER]: issueAgentToken(conv.id) } });
  assert.equal(agent.statusCode, 403);
  assert.equal(agent.json.code, 'agent_token_refused');
  assert.equal(fs.existsSync(routerConfigFile()), false);
});

test('POST hits the appRouterWrite anti-runaway bucket: 429 with Retry-After', async () => {
  _configureRateLimitForTests({ capacity: 2, refillMs: 600_000 });
  assert.equal((await post(claudeThenModel(0))).statusCode, 200);
  assert.equal((await post(claudeThenModel(1))).statusCode, 200);
  const r = await post(claudeThenModel(2));
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers['retry-after']) >= 1);
});

test('only the listed methods reach the routes: PATCH/DELETE get 405, GET /status is read-only', async () => {
  // No body: the method guard answers before any body would be read.
  assert.equal((await requestWithBody(port, '/api/app-router', { method: 'PATCH' })).statusCode, 405);
  assert.equal((await requestWithBody(port, '/api/app-router', { method: 'DELETE' })).statusCode, 405);
  assert.equal((await requestWithBody(port, '/api/app-router/status', { method: 'POST' })).statusCode, 405);
  assert.equal(isAppRouterWriteRoute('/api/app-router/status'), false);
  assert.equal(isAppRouterWriteRoute('/api/app-router'), true);
  assert.equal(isAppRouterWriteRoute('/api/app-router/profiles'), true);
  assert.equal(isAppRouterWriteRoute('/api/app-router/targets/werk/test'), true);
  assert.equal(isAppRouterWriteRoute('/api/app-router/targets/Werk/test'), false);
  assert.equal(isAppRouterWriteRoute('/api/app-router/targets/../test'), false);
});

// ---- GET /status ----------------------------------------------------------------------------------

test('status with the router off: every entry excluded by mode, next null, last_switch null', async () => {
  const r = await request(port, '/api/app-router/status');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.mode, 'off');
  assert.equal(r.json.next, null);
  assert.equal(r.json.last_switch, null);
  assert.equal(r.json.entries.length, 1);
  assert.equal(r.json.entries[0].id, 'main');
  assert.equal(r.json.entries[0].eligible, false);
  assert.equal(r.json.entries[0].ineligible_reason, 'mode');
  assert.equal(r.json.entries[0].state, 'unknown');
  assert.equal(r.json.entries[0].max_pct, null);
});

test('status per entry: near-limit stays usable, a measured-null window stays null (never 0), gate reasons are named', async () => {
  const cfg = claudeThenModel(0);
  cfg.entries.splice(1, 0, { id: 'werk', kind: 'claude-account', label: 'Werk', profile: 'werk', enabled: true, threshold_pct: null });
  cfg.entries.push({ id: 'codex', kind: 'codex-account', label: 'Codex', profile: null, enabled: false });
  assert.equal((await post(cfg)).statusCode, 200);
  recordReading('main', { windows: [{ type: 'five_hour', pct: 94, resets_at: new Date(Date.now() + 3_600_000).toISOString(), status: 'allowed_warning' }], status: 'allowed_warning' });
  recordReading('ollama-llama31', { windows: [{ type: 'five_hour', pct: null, resets_at: null, status: 'allowed' }], status: 'allowed' }, { source: 'test' });

  const r = await request(port, '/api/app-router/status');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.mode, 'claude-then-model');
  const by = Object.fromEntries(r.json.entries.map((e) => [e.id, e]));
  assert.deepEqual(r.json.entries.map((e) => e.id), ['main', 'werk', 'ollama-llama31', 'codex']);
  assert.equal(by.main.state, 'near-limit');
  assert.equal(by.main.max_pct, 94);
  assert.equal(by.main.eligible, true);
  assert.equal(by.main.ineligible_reason, null);
  assert.equal(by.main.capability, 'full');
  assert.equal(by.main.source, 'turn');
  assert.equal(by.werk.eligible, false);
  assert.equal(by.werk.ineligible_reason, 'multi_account_off');
  assert.equal(by.codex.ineligible_reason, 'disabled');
  assert.equal(by.codex.capability, 'read-answer');
  assert.equal(by['ollama-llama31'].capability, 'answers-only');
  assert.equal(by['ollama-llama31'].source, 'test');
  assert.equal(by['ollama-llama31'].windows[0].pct, null);
  assert.equal(r.json.next.kind, 'target');
  assert.deepEqual(keys(r.json.next.entry), ['id', 'kind', 'label']);
});

test('status answers with the same key sets as the dashboard fixture (top level, entry, next)', async () => {
  assert.equal((await post(claudeThenModel(0))).statusCode, 200);
  const live = (await request(port, '/api/app-router/status')).json;
  const fixture = readJson('status.json');
  assert.deepEqual(keys(live), keys(fixture));
  for (const e of live.entries) assert.deepEqual(keys(e), keys(fixture.entries[0]));
  assert.deepEqual(keys(live.next), keys(fixture.next));
  assert.deepEqual(keys(live.next.entry), keys(fixture.next.entry));
});

test('status for a conversation: bad id 400, unknown 404, known 200 with that conversation\'s last switch only', async () => {
  assert.equal((await request(port, '/api/app-router/status?conversation=..%2F..%2Fx')).statusCode, 400);
  assert.equal((await request(port, '/api/app-router/status?conversation=c-does-not-exist')).statusCode, 404);
  const a = createConversation({ project: 'p3-status' });
  const b = createConversation({ project: 'p3-status' });
  appendRouterEvent('router_switch', { conv_id: a.id, turn_id: 't1', from: 'main', to: 'werk', reason: 'switch-limit' });
  appendRouterEvent('router_switch', { conv_id: b.id, turn_id: 't9', from: 'werk', to: 'ollama-llama31', reason: 'switch-limit' });
  const ra = await request(port, '/api/app-router/status?conversation=' + encodeURIComponent(a.id));
  assert.equal(ra.statusCode, 200);
  assert.equal(ra.json.last_switch.conv_id, a.id);
  assert.equal(ra.json.last_switch.to, 'werk');
  assert.ok(Number.isFinite(Date.parse(ra.json.last_switch.at)));
  const all = await request(port, '/api/app-router/status');
  assert.equal(all.json.last_switch.conv_id, b.id, 'without ?conversation the newest switch of any conversation');
});

test('status of an exhausted chain names the earliest known free time', async () => {
  const cfg = { ...defaultRouterConfig(), mode: 'claude-accounts', multi_account: { enabled: true, acknowledged_at: '2026-11-02T10:00:00.000Z' } };
  cfg.entries = [...cfg.entries, { id: 'werk', kind: 'claude-account', label: 'Werk', profile: 'werk', enabled: true, threshold_pct: null }];
  assert.equal((await post(cfg)).statusCode, 200);
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  const later = new Date(Date.now() + 90 * 60_000).toISOString();
  recordReading('main', { windows: [{ type: 'five_hour', pct: 100, resets_at: later, status: 'rejected' }], status: 'rejected' });
  recordReading('werk', { windows: [{ type: 'five_hour', pct: 100, resets_at: soon, status: 'rejected' }], status: 'rejected' });
  const r = await request(port, '/api/app-router/status');
  assert.equal(r.json.entries.every((e) => e.state === 'exhausted' && e.ineligible_reason === 'exhausted'), true);
  assert.equal(r.json.next.kind, 'exhausted');
  assert.equal(r.json.next.resume_at, soon);
  assert.equal(r.json.next.first_free.label, 'Werk');
});

test('publicDecision keeps only ids, labels and reasons (no vars or other entry fields leave the gateway)', () => {
  assert.equal(publicDecision({ kind: 'off' }), null);
  assert.equal(publicDecision(null), null);
  const t = publicDecision({ kind: 'target', entry: ollama(), reason: 'first', switched: false, proactive: false, capability: 'answers-only', state: 'ready', from: null });
  assert.deepEqual(t, { kind: 'target', entry: { id: 'ollama-llama31', label: 'Ollama · llama3.1', kind: 'provider-model' }, reason: 'first', switched: false, from: null });
  const x = publicDecision({ kind: 'exhausted', resume_at: null, first_free: null });
  assert.deepEqual(x, { kind: 'exhausted', resume_at: null, first_free: null });
});
