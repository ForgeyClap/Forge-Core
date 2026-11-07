// App router P3, (APP-ROUTER-DESIGN.md 7.4): end to end through the REAL gateway listener.
//
// Setup (design 7.4):
//   - FORGE_DATA_DIR points at a fresh temp folder BEFORE the gateway modules load, so the conversation
//     store, the session records and the router folder of the whole gateway live there; each test gets
//     its own router folder on top (chain-store seam) so no router state leaks between scenarios;
//   - FORGE_ROUTER_PROFILES_DIR is a temp folder; extra accounts are created through the real
//     POST /api/app-router/profiles route (which makes the empty folder), never by hand;
//   - CC_EXEC_MOCK=1 + CC_ROUTER_MOCK=1: the gateway's own mock CLI (exec-argv.mjs). A profile folder
//     holding `mock-limit` answers with the recorded rate-limit-rejected line + a 429 result;
//   - one scenario swaps in a FAKE `claude` program (a small script written to the temp folder) through
//     the spawn seam: it streams some text, then a rate_limit_event warning, then the limit, mid-turn;
//   - the Ollama stand-in is providers/testing/mock-http-server.mjs on an ephemeral port, referenced by
//     the chain entry's own `vars.port`;
//   - every write uses the dashboard credential that test-support/helpers.mjs attaches.
// No real `claude`, no real Ollama, no network beyond 127.0.0.1, no file outside the temp folders.
//
// Scenarios:
//   1. mode claude-accounts (ack set): A hits its limit -> exactly one retry on B with a visible notice
//      (route_switched streamed BEFORE the answer), router_limit_hit logged, usage.json holds A's hit;
//   1b. the same with the fake CLI that hits the limit MID-turn after streaming text and a warning;
//   2. mode claude-then-model, only `main` limited -> the stub answers, answers-only notice;
//   3. mode model-first -> straight to the stub; no CLI child spawned at all;
//   4. stub stopped + everything limited -> one try per entry, then no spawn, route_exhausted and the
//      rate_limited card data with the earliest time (no loop);
//   5. usage unknown is handled honestly (null, never 0; unknown stays usable, no needless switch);
//   6. router off -> records without `route`, the exact key sets of the pre-router gateway, no router files.
// Contract: the live /status, turn `route` and event shapes have the key sets of the dashboard fixtures
// (read-only on P4's files).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH_FIXTURES = path.resolve(HERE, '..', '..', 'dashboard', 'tests', 'fixtures', 'app-router');

// ---- environment first, gateway modules second -----------------------------------------------------
// paths.mjs reads FORGE_DATA_DIR once at load, so it must be set before ANY gateway module is imported.
const ENV_KEYS = ['FORGE_DATA_DIR', 'FORGE_ROUTER_PROFILES_DIR', 'CC_EXEC_MOCK', 'CC_ROUTER_MOCK', 'CC_ROUTER_MOCK_MAIN_LIMIT', 'CC_EXEC_MOCK_DELAY_MS', 'CC_E2E_FAKE_MAIN', 'CLAUDE_CONFIG_DIR'];
const savedEnv = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-router-e2e-'));
const DATA_DIR = path.join(TMP, 'data');
const PROFILES_DIR = path.join(TMP, 'profiles');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });
process.env.FORGE_DATA_DIR = DATA_DIR;
process.env.FORGE_ROUTER_PROFILES_DIR = PROFILES_DIR;
process.env.CC_EXEC_MOCK = '1';
process.env.CC_ROUTER_MOCK = '1';
delete process.env.CLAUDE_CONFIG_DIR;

const { createServer, _configureRateLimitForTests } = await import('../src/server.mjs');
const { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } = await import('../src/paths.mjs');
const { _setRouterDirForTests } = await import('../src/app-router/chain-store.mjs');
const { recordReading } = await import('../src/app-router/usage-readings.mjs');
const { _setSpawnSpecOverrideForTests, _resetExecBridgeForTests } = await import('../src/exec-lifecycle.mjs');
const { buildSpawnSpec } = await import('../src/exec-argv.mjs');
const { isTurnBusy } = await import('../src/app-router/turn-router.mjs');
const { startMockServer } = await import('../src/providers/testing/mock-http-server.mjs');
const { request, requestWithBody } = await import('../test-support/helpers.mjs');

const PROJECT = path.basename(PROJECT_ROOT);

// The pre-router baseline (router off). Captured from the gateway at command-center HEAD 9ca4478 (before
// any app-router change) by exporting that tree with `git archive` and running one mock turn through its
// startExecution — the only thing the old send route called. Re-capture only on a deliberate record change.
const BASELINE = Object.freeze({
  user: ['created_at', 'effort', 'mode', 'model', 'request_id', 'role', 'text', 'turn_id', 'type'],
  assistant: ['agent_type', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'context_window', 'cost_usd', 'created_at',
    'duration_ms', 'error', 'exit_code', 'file_edits', 'input_tokens', 'model', 'output_tokens', 'request_id', 'role', 'session_id',
    'shell_commands', 'stderr', 'stop_reason', 'text', 'todos', 'turn_id', 'type'],
  events: ['assistant', 'result', 'system'],
  sendAnswer: ['execution_started', 'ok', 'request_id', 'turn_id'],
});

// ---- the fake `claude` program (scenario 1b and 5) ------------------------------------------------
// Behaves like `claude -p --output-format stream-json` under a profile: the profile is the
// CLAUDE_CONFIG_DIR folder name ('main' without one). A folder holding `fake-midturn-limit` (or
// CC_E2E_FAKE_MAIN=limit for main) streams text, a warning-level rate_limit_event (shape B of spike S3),
// then the rejected event and a 429 result, and exits 1. A folder holding `fake-429-only` sends only the
// 429 result, with no rate_limit_event at all (so no free-again time is known). Otherwise it sends the normal-turn shape A
// (status "allowed", NO utilization) and answers 'FAKE-CLI:<name>'. It reads stdin until it ends.
const FAKE_CLI = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const cfg = process.env.CLAUDE_CONFIG_DIR || '';",
  "const name = cfg ? path.basename(cfg) : 'main';",
  "const limited = cfg ? fs.existsSync(path.join(cfg, 'fake-midturn-limit')) : process.env.CC_E2E_FAKE_MAIN === 'limit';",
  "const sid = 'fake-' + name.replace(/[^A-Za-z0-9]/g, '') + '-' + process.pid;",
  "const w = (o) => process.stdout.write(JSON.stringify(o) + String.fromCharCode(10));",
  "const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;",
  "const only429 = cfg ? fs.existsSync(path.join(cfg, 'fake-429-only')) : false;",
  "function answer() {",
  "  w({ type: 'system', subtype: 'init', session_id: sid });",
  "  if (only429) {",
  "    w({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429 rate limit', session_id: sid, total_cost_usd: 0, duration_ms: 5, num_turns: 1, stop_reason: null });",
  "    process.exitCode = 1;",
  "    return;",
  "  }",
  "  if (limited) {",
  "    w({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'Ik begin met de knop op de' }] } });",
  "    w({ type: 'rate_limit_event', session_id: sid, uuid: '00000000-0000-4000-8000-0000000000e1', rate_limit_info: { status: 'allowed_warning', resetsAt, rateLimitType: 'five_hour', utilization: 0.97, surpassedThreshold: 0.75, isUsingOverage: false } });",
  "    w({ type: 'rate_limit_event', session_id: sid, uuid: '00000000-0000-4000-8000-0000000000e2', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false } });",
  "    w({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: \"You've hit your limit\", session_id: sid, total_cost_usd: 0, duration_ms: 5, num_turns: 1, stop_reason: null });",
  "    process.exitCode = 1;",
  "    return;",
  "  }",
  "  w({ type: 'rate_limit_event', session_id: sid, uuid: '00000000-0000-4000-8000-0000000000e3', rate_limit_info: { status: 'allowed', resetsAt, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false } });",
  "  const reply = 'FAKE-CLI:' + name;",
  "  w({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: reply }] } });",
  "  w({ type: 'result', is_error: false, result: reply, session_id: sid, total_cost_usd: 0.0002, duration_ms: 5, num_turns: 1, stop_reason: 'end_turn' });",
  "}",
  "let done = false;",
  "function go() { if (done) return; done = true; clearTimeout(timer); process.stdin.removeAllListeners('data'); process.stdin.destroy(); answer(); }",
  "const timer = setTimeout(go, 1500);",
  "process.stdin.on('data', () => {});",
  "process.stdin.on('end', go);",
  "process.stdin.on('error', go);",
].join('\n');
const FAKE_CLI_PATH = path.join(TMP, 'fake-claude.cjs');
fs.writeFileSync(FAKE_CLI_PATH, FAKE_CLI, 'utf8');

// ---- server + per-test state -----------------------------------------------------------------------
let server;
let port;
let routerDir;
let n = 0;
let spawns = [];
const stubs = [];

before(async () => {
  server = createServer();
  port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
});

after(async () => {
  _resetExecBridgeForTests();
  while (stubs.length) await stubs.pop().close();
  await new Promise((resolve) => server.close(resolve));
  _setRouterDirForTests(null);
  _configureRateLimitForTests();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

/** Counts every CLI child the gateway starts; `fake` swaps the mock for the fake program above. */
function countSpawns({ fake = false } = {}) {
  _setSpawnSpecOverrideForTests((text, ...rest) => {
    const spec = fake ? { cmd: process.execPath, args: [FAKE_CLI_PATH, text] } : buildSpawnSpec(text, ...rest);
    spawns.push({ text, fake });
    return spec;
  });
}

beforeEach(async () => {
  n += 1;
  _resetExecBridgeForTests(); // also clears the spawn seam
  _configureRateLimitForTests();
  while (stubs.length) await stubs.pop().close();
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_ROUTER_MOCK = '1';
  delete process.env.CC_ROUTER_MOCK_MAIN_LIMIT;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  delete process.env.CC_E2E_FAKE_MAIN;
  routerDir = path.join(DATA_DIR, 'app-router-' + n);
  _setRouterDirForTests(routerDir);
  spawns = [];
  countSpawns();
});

// ---- helpers ---------------------------------------------------------------------------------------
const keys = (o) => Object.keys(o).sort();
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(DASH_FIXTURES, name), 'utf8'));
const later = (ms) => new Promise((r) => setTimeout(r, ms));

async function stub({ answer = 'Antwoord van het eigen model.' } = {}) {
  const s = await startMockServer(async (req, h) => {
    if (req.path === '/api/chat') {
      await h.ndjson([
        { model: 'stub-model', message: { role: 'assistant', content: answer.slice(0, 10) }, done: false },
        { model: 'stub-model', message: { role: 'assistant', content: answer.slice(10) }, done: false },
        { model: 'stub-model', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 7 },
      ]);
      return;
    }
    if (req.path === '/api/tags') return h.json(200, { models: [{ name: 'stub-model' }] });
    if (req.path === '/api/version') return h.json(200, { version: '0.0.0-stub' });
    return h.json(404, { error: 'not here' });
  });
  stubs.push(s);
  return s;
}
/** A port where nothing listens (bound, read, closed). */
async function deadPort() {
  const s = await startMockServer((req, h) => h.json(500, {}));
  const p = s.port;
  await s.close();
  return p;
}

const ollamaEntry = (p) => ({
  id: 'ollama-stub', kind: 'provider-model', label: 'Ollama · stub', provider: 'ollama-local', model: 'stub-model',
  enabled: true, num_ctx: 4096, vars: { port: String(p) }, paid_ack: false, notice_ack: false,
});
const MAIN = { id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null };
const ACK = { enabled: true, acknowledged_at: '2026-11-02T10:00:00.000Z' };

async function getConfig() {
  const r = await request(port, '/api/app-router');
  assert.equal(r.statusCode, 200, r.body);
  return r.json.config;
}
/** Saves through the real POST route (validation, revision, atomic write, audit line). */
async function saveConfig(patch) {
  const current = await getConfig();
  const r = await requestWithBody(port, '/api/app-router', { jsonBody: { ...current, ...patch, revision: current.revision } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json.config;
}
/** Adds an extra account the way the dashboard does; returns its chain entry (folder created by the gateway). */
async function addAccount(label) {
  const r = await requestWithBody(port, '/api/app-router/profiles', { jsonBody: { label } });
  assert.equal(r.statusCode, 201, r.body);
  const dir = path.join(PROFILES_DIR, r.json.entry.profile);
  assert.equal(fs.statSync(dir).isDirectory(), true, 'the gateway made the empty profile folder');
  assert.deepEqual(fs.readdirSync(dir), [], 'and wrote nothing inside it');
  return { entry: r.json.entry, dir };
}

async function newConversation() {
  const r = await requestWithBody(port, '/api/conversations', { jsonBody: { project: PROJECT, title: 'router e2e ' + n } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json.conversation.id;
}
async function send(convId, text) {
  const r = await requestWithBody(port, '/api/conversations/' + encodeURIComponent(convId) + '/messages', { jsonBody: { text } });
  assert.equal(r.statusCode, 202, r.body);
  return r.json;
}
async function readConv(convId) {
  const r = await request(port, '/api/conversations/' + encodeURIComponent(convId));
  assert.equal(r.statusCode, 200, r.body);
  return r.json;
}
/** Waits for the turn's assistant record and for the conversation to be idle (in-process: same module as the server). */
async function waitDone(convId, turnId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conv = await readConv(convId);
    const recs = conv.turns.filter((t) => t.role === 'assistant' && t.turn_id === turnId);
    if (recs.length > 0 && !isTurnBusy(convId)) return { conv, recs, events: conv.events || [] };
    if (Date.now() > deadline) throw new Error('turn ' + turnId + ' did not finish in time; busy=' + isTurnBusy(convId));
    await later(30);
  }
}
const eventsOf = (events, turnId, kind) => events.filter((e) => e.turn_id === turnId && e.kind === kind);

/** Opens the live SSE tail and collects the parsed frames (the dashboard's own channel). */
function openStream(convId) {
  const frames = [];
  const req = http.request({ host: '127.0.0.1', port, path: '/api/conversations/' + encodeURIComponent(convId) + '/stream', method: 'GET' }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) { try { frames.push(JSON.parse(line.slice(6))); } catch { /* not ours */ } }
        }
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end();
  return { frames, close: () => req.destroy() };
}
const routerFile = (name) => path.join(routerDir, name);
const routerLog = () => (fs.existsSync(routerFile('router-events.jsonl'))
  ? fs.readFileSync(routerFile('router-events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);
const usageJson = () => JSON.parse(fs.readFileSync(routerFile('usage.json'), 'utf8'));
const usageOf = (u, id) => (u && u.targets && u.targets[id]) || (u && u[id]) || null;

// ---- sanity of the setup itself --------------------------------------------------------------------

test('setup: the gateway writes into the temp data folder, never the dev tree', () => {
  assert.equal(path.resolve(COMMAND_CENTER_DATA_DIR), path.resolve(DATA_DIR));
});

// ---- 1. two own Claude accounts: limit on A, one retry on B -------------------------------------------

test('1. claude-accounts: A hits its limit -> exactly one retry on B, notice streamed before the answer, limit logged', async () => {
  const a = await addAccount('A');
  const b = await addAccount('B');
  fs.writeFileSync(path.join(a.dir, 'mock-limit'), ''); // the test plays "A is signed in but used up"
  const cfg = await getConfig();
  await saveConfig({ mode: 'claude-accounts', multi_account: ACK, entries: cfg.entries.map((e) => (e.id === 'main' ? { ...e, enabled: false } : e)) });

  const convId = await newConversation();
  const live = openStream(convId);
  await later(150);
  const sent = await send(convId, 'Maak de knop groter.');
  assert.equal(sent.execution_started, true, JSON.stringify(sent));
  const { recs, events } = await waitDone(convId, sent.turn_id);
  await later(300); // let the tail flush the last lines
  live.close();

  assert.equal(recs.length, 1, 'one assistant record per turn');
  const rec = recs[0];
  assert.equal(rec.text, 'MOCK-PROFILE:' + b.entry.profile);
  assert.equal(rec.request_id, sent.request_id + '-r2');
  assert.deepEqual(
    { t: rec.route.target_id, a: rec.route.attempt, s: rec.route.switched, r: rec.route.reason, f: rec.route.from_target_id, o: rec.route.outcome, c: rec.route.capability },
    { t: b.entry.id, a: 2, s: true, r: 'switch-limit', f: a.entry.id, o: 'ok', c: 'full' },
  );
  assert.equal(rec.route.from_label, 'A');
  assert.equal(rec.route.from_window, 'five_hour');
  assert.ok(Date.parse(rec.route.from_resume_at) > Date.now(), 'the free-again time comes from the limit line');
  assert.notEqual(rec.route.from_pct, 0, 'an unmeasured percentage is never shown as 0');

  // exactly one retry: two route_selected, one route_switched, one failed attempt, nothing with -r3
  assert.equal(eventsOf(events, sent.turn_id, 'route_selected').length, 2);
  assert.equal(eventsOf(events, sent.turn_id, 'route_switched').length, 1);
  const failed = eventsOf(events, sent.turn_id, 'route_attempt_failed');
  assert.equal(failed.length, 1);
  assert.deepEqual({ t: failed[0].data.route.target_id, o: failed[0].data.route.outcome, r: failed[0].data.route.retried }, { t: a.entry.id, o: 'rate_limited', r: true });
  assert.equal(events.some((e) => typeof e.request_id === 'string' && e.request_id.endsWith('-r3')), false);
  assert.equal(spawns.length, 2, 'two CLI children: A once, B once');

  // the visible notice reaches the live channel BEFORE the answer (design 5.1 + 6.2 live-activity)
  const iSwitch = live.frames.findIndex((f) => f.kind === 'route_switched' && f.turn_id === sent.turn_id);
  const iAnswer = live.frames.findIndex((f) => f.role === 'assistant' && f.turn_id === sent.turn_id);
  assert.ok(iSwitch !== -1, 'route_switched was streamed');
  assert.ok(iAnswer !== -1, 'the answer was streamed');
  assert.ok(iSwitch < iAnswer, 'the notice comes before the answer');
  assert.equal(live.frames[iSwitch].data.label, 'B');
  assert.equal(live.frames[iSwitch].data.from_label, 'A');

  // the router's own records
  const log = routerLog();
  assert.ok(log.some((e) => e.kind === 'router_limit_hit' && e.target_id === a.entry.id && e.window === 'five_hour'));
  assert.ok(log.some((e) => e.kind === 'router_switch' && e.from === a.entry.id && e.to === b.entry.id && e.conv_id === convId));
  const hit = usageOf(usageJson(), a.entry.id).limit_hit;
  assert.ok(hit && Date.parse(hit.resets_at) > Date.now(), 'usage.json holds the limit hit for A');

  // the status now shows A exhausted with its free time, and the conversation's last switch
  const st = await request(port, '/api/app-router/status?conversation=' + encodeURIComponent(convId));
  const rowA = st.json.entries.find((e) => e.id === a.entry.id);
  assert.deepEqual({ s: rowA.state, e: rowA.eligible, r: rowA.ineligible_reason }, { s: 'exhausted', e: false, r: 'exhausted' });
  assert.equal(rowA.resume_at, hit.resets_at);
  assert.deepEqual({ f: st.json.last_switch.from, t: st.json.last_switch.to }, { f: a.entry.id, t: b.entry.id });
  assert.equal(st.json.next.entry.id, b.entry.id, 'the next turn stays on B');

  // the next turn stays on B (sticky) and is no switch
  const again = await send(convId, 'En de tekst ook.');
  const second = await waitDone(convId, again.turn_id);
  assert.deepEqual({ t: second.recs[0].route.target_id, s: second.recs[0].route.switched, a: second.recs[0].route.attempt }, { t: b.entry.id, s: false, a: 1 });
  assert.equal(spawns.length, 3, 'A was not tried again while it is used up');
});

test('1b. a fake claude program hits the limit MID-turn (after text and a warning) -> one retry, no invented percentage', async () => {
  countSpawns({ fake: true });
  const a = await addAccount('Werk');
  const b = await addAccount('Prive');
  fs.writeFileSync(path.join(a.dir, 'fake-midturn-limit'), '');
  const cfg = await getConfig();
  await saveConfig({ mode: 'claude-accounts', multi_account: ACK, entries: cfg.entries.map((e) => (e.id === 'main' ? { ...e, enabled: false } : e)) });

  const convId = await newConversation();
  const sent = await send(convId, 'Zet de openingstijden op de contactpagina.');
  assert.equal(sent.execution_started, true);
  const { recs, events } = await waitDone(convId, sent.turn_id);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].text, 'FAKE-CLI:' + b.entry.profile);
  assert.deepEqual({ t: recs[0].route.target_id, a: recs[0].route.attempt, r: recs[0].route.reason, f: recs[0].route.from_target_id }, { t: b.entry.id, a: 2, r: 'switch-limit', f: a.entry.id });
  assert.equal(spawns.length, 2);
  assert.ok(spawns.every((s) => s.fake), 'only the fake program ran');
  const failed = eventsOf(events, sent.turn_id, 'route_attempt_failed');
  assert.equal(failed.length, 1, 'the interrupted first answer is kept, not hidden');
  assert.equal(failed[0].data.route.outcome, 'rate_limited');
  // the rejected line (no utilization) is the last word for the window: status rejected, pct never 0.
  // Observed: the earlier 97 % warning of the same window is not kept (mergeReadings: last line wins).
  const u = usageOf(usageJson(), a.entry.id);
  const fiveHour = (u.windows || []).find((w) => w.type === 'five_hour');
  assert.ok(fiveHour, 'A has a five_hour reading');
  assert.notEqual(fiveHour.pct, 0, 'never an invented 0');
  assert.equal(fiveHour.status, 'rejected');
  assert.notEqual(recs[0].route.from_pct, 0);
  assert.ok(u.limit_hit && u.limit_hit.window === 'five_hour');
  // B's normal turn sent shape A (allowed, no utilization): its percentage stays null, never 0
  const ub = usageOf(usageJson(), b.entry.id);
  assert.ok(ub && Array.isArray(ub.windows) && ub.windows.length > 0, 'B got a reading from its own turn');
  assert.equal(ub.windows[0].pct, null);
});

test('1c. a 429 without any rate_limit_event: the limit is still recorded, its free time stays unknown (null), one retry', async () => {
  countSpawns({ fake: true });
  const a = await addAccount('Een');
  const b = await addAccount('Twee');
  fs.writeFileSync(path.join(a.dir, 'fake-429-only'), '');
  const cfg = await getConfig();
  await saveConfig({ mode: 'claude-accounts', multi_account: ACK, entries: cfg.entries.map((e) => (e.id === 'main' ? { ...e, enabled: false } : e)) });
  const convId = await newConversation();
  const sent = await send(convId, 'Vraag');
  const { recs } = await waitDone(convId, sent.turn_id);
  assert.equal(recs[0].text, 'FAKE-CLI:' + b.entry.profile);
  assert.deepEqual({ t: recs[0].route.target_id, r: recs[0].route.reason, a: recs[0].route.attempt }, { t: b.entry.id, r: 'switch-limit', a: 2 });
  assert.equal(recs[0].route.from_resume_at, null, 'no free-again time is invented');
  const hit = usageOf(usageJson(), a.entry.id).limit_hit;
  assert.ok(hit, 'the limit hit is recorded even without a rate_limit_event');
  assert.equal(hit.resets_at, null);
  assert.ok(routerLog().some((e) => e.kind === 'router_limit_hit' && e.target_id === a.entry.id && e.resume_at === null));
  const row = (await request(port, '/api/app-router/status')).json.entries.find((e) => e.id === a.entry.id);
  assert.deepEqual({ s: row.state, e: row.eligible, r: row.resume_at }, { s: 'exhausted', e: false, r: null }, 'held for the unknown-reset window, time shown as unknown');
});

test('1d. never a second automatic retry: A and B limited, C free -> the turn ends on B; C is only used by the NEXT turn', async () => {
  const a = await addAccount('Alfa');
  const b = await addAccount('Bravo');
  const c = await addAccount('Charlie');
  fs.writeFileSync(path.join(a.dir, 'mock-limit'), '');
  fs.writeFileSync(path.join(b.dir, 'mock-limit'), '');
  const cfg = await getConfig();
  await saveConfig({ mode: 'claude-accounts', multi_account: ACK, entries: cfg.entries.map((e) => (e.id === 'main' ? { ...e, enabled: false } : e)) });
  const convId = await newConversation();
  const sent = await send(convId, 'Vraag');
  const { recs, events } = await waitDone(convId, sent.turn_id);
  assert.equal(spawns.length, 2, 'A and B only');
  assert.equal(recs.length, 1);
  assert.deepEqual({ t: recs[0].route.target_id, a: recs[0].route.attempt, o: recs[0].route.outcome, r: recs[0].route.retried }, { t: b.entry.id, a: 2, o: 'rate_limited', r: false });
  assert.equal(events.some((e) => typeof e.request_id === 'string' && e.request_id.endsWith('-r3')), false);
  assert.equal(eventsOf(events, sent.turn_id, 'route_selected').length, 2);
  assert.equal(eventsOf(events, sent.turn_id, 'route_selected').some((e) => e.data.target_id === c.entry.id), false, 'C was not tried in this turn');
  const next = await send(convId, 'Nog een keer');
  const t2 = await waitDone(convId, next.turn_id);
  assert.ok(t2.recs[0].route.handover && t2.recs[0].route.handover.chars > 0, 'C gets the conversation so far');
  assert.equal(t2.recs[0].text, 'MOCK-PROFILE:' + c.entry.profile + ' HANDOVER_CHARS:' + t2.recs[0].route.handover.chars, 'piped on stdin, exactly the announced size');
  assert.deepEqual({ t: t2.recs[0].route.target_id, a: t2.recs[0].route.attempt, s: t2.recs[0].route.switched }, { t: c.entry.id, a: 1, s: true });
  assert.equal(spawns.length, 3);
});

// ---- 2. one subscription + own model: main limited -> the stub answers ------------------------------

test('2. claude-then-model: only main limited -> the Ollama stub answers, answers-only notice, num_ctx sent', async () => {
  process.env.CC_ROUTER_MOCK_MAIN_LIMIT = '1';
  const s = await stub({ answer: 'Een kortere tekst kan: Bestel nu.' });
  await saveConfig({ mode: 'claude-then-model', entries: [MAIN, ollamaEntry(s.port)] });

  const convId = await newConversation();
  const sent = await send(convId, 'Kun je de tekst op de knop korter maken?');
  assert.equal(sent.execution_started, true);
  const { recs, events } = await waitDone(convId, sent.turn_id);
  assert.equal(recs.length, 1);
  const rec = recs[0];
  assert.equal(rec.text, 'Een kortere tekst kan: Bestel nu.');
  assert.deepEqual(
    { t: rec.route.target_id, k: rec.route.kind, c: rec.route.capability, s: rec.route.switched, r: rec.route.reason, f: rec.route.from_target_id, a: rec.route.attempt, m: rec.route.model },
    { t: 'ollama-stub', k: 'provider-model', c: 'answers-only', s: true, r: 'switch-limit', f: 'main', a: 2, m: 'stub-model' },
  );
  const sw = eventsOf(events, sent.turn_id, 'route_switched');
  assert.equal(sw.length, 1);
  assert.equal(sw[0].data.capability, 'answers-only', 'the notice says the model can only answer');
  assert.equal(spawns.length, 1, 'one CLI child (main), the fallback ran without a CLI');
  const chats = s.requests.filter((r) => r.path === '/api/chat');
  assert.equal(chats.length, 1, 'one request to the stub');
  assert.equal(chats[0].body.options.num_ctx, 4096, 'num_ctx is always sent');
  const last = chats[0].body.messages[chats[0].body.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content, /korter maken/);
  assert.ok(routerLog().some((e) => e.kind === 'router_limit_hit' && e.target_id === 'main'));
});

// ---- 3. own model right away --------------------------------------------------------------------------

test('3. model-first: straight to the stub; no CLI child is spawned; first-turn answers-only label', async () => {
  const s = await stub({ answer: 'Hallo vanaf het eigen model.' });
  await saveConfig({ mode: 'model-first', entries: [ollamaEntry(s.port), MAIN] });

  const convId = await newConversation();
  const sent = await send(convId, 'Hallo');
  assert.equal(sent.execution_started, true);
  const { recs, events } = await waitDone(convId, sent.turn_id);
  assert.equal(recs[0].text, 'Hallo vanaf het eigen model.');
  assert.deepEqual(
    { t: recs[0].route.target_id, c: recs[0].route.capability, s: recs[0].route.switched, r: recs[0].route.reason, a: recs[0].route.attempt },
    { t: 'ollama-stub', c: 'answers-only', s: false, r: 'first', a: 1 },
  );
  const sel = eventsOf(events, sent.turn_id, 'route_selected');
  assert.equal(sel.length, 1);
  assert.equal(sel[0].data.capability, 'answers-only');
  assert.equal(eventsOf(events, sent.turn_id, 'route_switched').length, 0);
  assert.ok(eventsOf(events, sent.turn_id, 'provider_delta').length >= 1, 'the answer streamed live');
  assert.equal(spawns.length, 0, 'no CLI child spawned');
  assert.equal(s.requests.filter((r) => r.path === '/api/chat').length, 1);
});

// ---- 4. everything used up and the stub stopped --------------------------------------------------------

test('4. stub stopped + all limited: one try each, then no spawn, route_exhausted + rate_limited card with the earliest time', async () => {
  process.env.CC_ROUTER_MOCK_MAIN_LIMIT = '1';
  const dead = await deadPort();
  await saveConfig({ mode: 'claude-then-model', entries: [MAIN, ollamaEntry(dead)] });
  const convId = await newConversation();

  // turn 1: main hits its limit, the one retry goes to the stopped model and fails; no third attempt
  const first = await send(convId, 'Eerste vraag');
  assert.equal(first.execution_started, true);
  const t1 = await waitDone(convId, first.turn_id);
  assert.equal(t1.recs.length, 1);
  assert.deepEqual({ t: t1.recs[0].route.target_id, a: t1.recs[0].route.attempt, o: t1.recs[0].route.outcome }, { t: 'ollama-stub', a: 2, o: 'down' });
  assert.equal(eventsOf(t1.events, first.turn_id, 'route_selected').length, 2);
  assert.equal(t1.events.some((e) => typeof e.request_id === 'string' && e.request_id.endsWith('-r3')), false);
  assert.equal(spawns.length, 1);

  // turn 2: nothing usable -> no spawn at all, the start is refused with the router code
  const second = await send(convId, 'Tweede vraag');
  assert.equal(second.execution_started, false);
  assert.equal(second.code, 'router_exhausted');
  const conv = await readConv(convId);
  const evs = conv.events || [];
  assert.equal(spawns.length, 1, 'no CLI child for the exhausted turn');
  assert.equal(eventsOf(evs, second.turn_id, 'route_selected').length, 0);
  const ex = eventsOf(evs, second.turn_id, 'route_exhausted');
  assert.equal(ex.length, 1);
  const mainHit = usageOf(usageJson(), 'main').limit_hit;
  assert.ok(mainHit && Date.parse(mainHit.resets_at) > Date.now());
  assert.equal(ex[0].data.resume_at, mainHit.resets_at, 'the earliest known free time');
  assert.equal(ex[0].data.first_free.target_id, 'main');
  assert.equal(ex[0].data.code, 'rate_limited');
  const card = eventsOf(evs, second.turn_id, 'forge_error');
  assert.equal(card.length, 1, 'the existing rate_limited card');
  const cardData = card[0].data;
  assert.equal(cardData.code, 'rate_limited');
  assert.equal(cardData.resume_at, mainHit.resets_at);
  const notStarted = eventsOf(evs, second.turn_id, 'execution_not_started');
  assert.equal(notStarted.length, 1);
  assert.equal(notStarted[0].data.code, 'router_exhausted');
  assert.equal(conv.turns.filter((t) => t.role === 'assistant' && t.turn_id === second.turn_id).length, 0, 'no fake answer');
  assert.equal(conv.turns.filter((t) => t.role === 'user' && t.turn_id === second.turn_id).length, 1, 'the user message is kept');
  assert.ok(routerLog().some((e) => e.kind === 'router_exhausted' && e.conv_id === convId && e.resume_at === mainHit.resets_at));

  // the status says the same, with the dashboard's exhausted key sets
  const st = await request(port, '/api/app-router/status?conversation=' + encodeURIComponent(convId));
  assert.equal(st.json.next.kind, 'exhausted');
  assert.equal(st.json.next.resume_at, mainHit.resets_at);
  const fx = fixture('status-exhausted.json');
  assert.deepEqual(keys(st.json.next), keys(fx.next));
  assert.deepEqual(keys(st.json.next.first_free), keys(fx.next.first_free));
  assert.deepEqual(keys(st.json.last_switch), keys(fx.last_switch));
  const rowOllama = st.json.entries.find((e) => e.id === 'ollama-stub');
  assert.deepEqual({ s: rowOllama.state, e: rowOllama.eligible }, { s: 'down', e: false });
});

// ---- 5. usage unknown is handled honestly ---------------------------------------------------------------

test('5. unknown usage: null never becomes 0, unknown stays usable, a normal turn does not switch; stale -> unknown', async () => {
  countSpawns({ fake: true });
  const s = await stub();
  await saveConfig({ mode: 'claude-then-model', entries: [MAIN, ollamaEntry(s.port)] });

  // before any turn: no reading at all
  let st = (await request(port, '/api/app-router/status')).json;
  let main = st.entries.find((e) => e.id === 'main');
  assert.deepEqual({ s: main.state, e: main.eligible, p: main.max_pct, m: main.measured_at, w: main.windows }, { s: 'unknown', e: true, p: null, m: null, w: [] });
  assert.equal(st.next.entry.id, 'main', 'unknown is usable: the router does not skip to the model');

  // a normal turn sends status "allowed" without a percentage (the 42-of-52 shape of spike S3)
  const convId = await newConversation();
  const sent = await send(convId, 'Hoi');
  const t = await waitDone(convId, sent.turn_id);
  assert.equal(t.recs[0].text, 'FAKE-CLI:main');
  assert.deepEqual({ tg: t.recs[0].route.target_id, s: t.recs[0].route.switched }, { tg: 'main', s: false });
  const raw = fs.readFileSync(routerFile('usage.json'), 'utf8');
  const um = usageOf(JSON.parse(raw), 'main');
  assert.equal(um.windows[0].pct, null, 'stored as null');
  assert.equal(um.windows[0].status, 'allowed');
  assert.doesNotMatch(raw, /"pct":0[,}]/, 'no invented 0 anywhere in usage.json');
  st = (await request(port, '/api/app-router/status')).json;
  main = st.entries.find((e) => e.id === 'main');
  assert.equal(main.max_pct, null);
  assert.equal(main.windows[0].pct, null);
  assert.equal(main.eligible, true);
  assert.equal(main.source, 'turn');
  assert.equal(s.requests.length, 0, 'the model was never asked');

  // a reading older than 15 minutes is "unknown" again (and still usable)
  recordReading('main', { windows: [{ type: 'five_hour', pct: 40, resets_at: new Date(Date.now() + 3_600_000).toISOString(), status: 'allowed_warning' }], status: 'allowed_warning' }, { source: 'turn', now: Date.now() - 20 * 60_000 });
  st = (await request(port, '/api/app-router/status')).json;
  main = st.entries.find((e) => e.id === 'main');
  assert.deepEqual({ s: main.state, e: main.eligible, p: main.max_pct }, { s: 'unknown', e: true, p: null });
});

// ---- 6. router off: nothing changes -----------------------------------------------------------------------

test('6. router off (default): records without route, the exact pre-router key sets, no router files', async () => {
  delete process.env.CC_ROUTER_MOCK; // the plain mock, exactly as the pre-router baseline ran
  const g = await request(port, '/api/app-router');
  assert.equal(g.json.provenance, 'DEFAULT');
  assert.equal(g.json.config.mode, 'off');

  const convId = await newConversation();
  const sent = await send(convId, 'hallo');
  assert.deepEqual(keys(sent), BASELINE.sendAnswer);
  const { conv, recs } = await waitDone(convId, sent.turn_id);
  const user = conv.turns.find((x) => x.role === 'user' && x.turn_id === sent.turn_id);
  assert.deepEqual(keys(user), BASELINE.user);
  assert.equal(recs.length, 1);
  assert.deepEqual(keys(recs[0]), BASELINE.assistant, 'no route field, nothing else new');
  assert.equal(recs[0].request_id, sent.request_id, 'no -r2 suffix');
  assert.deepEqual([...new Set(conv.events.map((e) => e.kind))].sort(), BASELINE.events, 'no route_* events');
  assert.equal(spawns.length, 1);
  assert.equal(fs.existsSync(routerDir), false, 'the router folder is not even created');
  const st = (await request(port, '/api/app-router/status?conversation=' + encodeURIComponent(convId))).json;
  assert.deepEqual({ m: st.mode, n: st.next, l: st.last_switch }, { m: 'off', n: null, l: null });
});

// ---- contract: live shapes == the dashboard fixtures (read-only on P4's files) -----------------------------

test('contract: live /status, the turn route record and the route events have the dashboard fixtures\' key sets', async () => {
  const s = await stub();
  await saveConfig({ mode: 'claude-then-model', entries: [MAIN, ollamaEntry(s.port)] });
  const convId = await newConversation();
  // turn 1 on main, so the switch in turn 2 carries a real handover summary
  const warm = await send(convId, 'Eerste vraag');
  await waitDone(convId, warm.turn_id);
  process.env.CC_ROUTER_MOCK_MAIN_LIMIT = '1';
  const sent = await send(convId, 'Contract');
  const { recs, events } = await waitDone(convId, sent.turn_id);

  const fx = fixture('status.json');
  const live = (await request(port, '/api/app-router/status?conversation=' + encodeURIComponent(convId))).json;
  assert.deepEqual(keys(live), keys(fx), 'status top level');
  for (const e of live.entries) assert.deepEqual(keys(e), keys(fx.entries[0]), 'status entry ' + e.id);
  for (const e of live.entries) for (const w of e.windows) assert.deepEqual(keys(w), keys(fx.entries[0].windows[0]), 'status window of ' + e.id);
  assert.equal(live.next.kind, 'target');
  assert.deepEqual(keys(live.next), keys(fx.next));
  assert.deepEqual(keys(live.next.entry), keys(fx.next.entry));
  assert.deepEqual(keys(live.last_switch), keys(fixture('status-exhausted.json').last_switch));

  const conv = fixture('conversation-routed.json');
  const fxRoute = conv.turns.find((t) => t.route && t.route.handover).route;
  assert.deepEqual(keys(recs[0].route), keys(fxRoute), 'turn route record');
  assert.deepEqual(keys(recs[0].route.handover), keys(fxRoute.handover), 'handover summary');
  const sw = eventsOf(events, sent.turn_id, 'route_switched')[0];
  // Q6 C1: the route record plus `skipped` (the turn's route record itself is unchanged)
  assert.deepEqual(keys(sw.data), [...keys(fxRoute), 'skipped'].sort(), 'route_switched carries the route record + skipped');
  assert.ok(Array.isArray(sw.data.skipped), 'route_switched.skipped is always an array');
  const sel = eventsOf(events, sent.turn_id, 'route_selected')[0];
  assert.deepEqual(keys(sel.data), keys(conv.events.find((e) => e.kind === 'route_selected').data), 'route_selected data');
});
