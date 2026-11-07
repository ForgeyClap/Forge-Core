// App router P2 — the user-clicked Test (design 3.3 step 3, 6.1; review finding 12).
//
//   - claude-account: one probe child under the profile folder (mock CLI): ok / logged out / limited;
//     a missing folder is "not signed in"; a hung child is killed by its exact PID after the cap;
//   - provider-model: testConnection + "is the model listed", on the ENTRY's own port;
//   - the fixed probe argv (no session file, no MCP server, haiku, one turn).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';
import { runTargetProbe, probeOutcome, _setProbeSpawnSpecForTests } from '../src/app-router/probe.mjs';
import { PROBE_ARGS } from '../src/exec-argv.mjs';
import { _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { readReadings, markNeedsLogin } from '../src/app-router/usage-readings.mjs';
import { readRouterEvents } from '../src/app-router/router-log.mjs';

const ENV_KEYS = ['CC_EXEC_MOCK', 'CC_ROUTER_MOCK', 'CC_EXEC_MOCK_DELAY_MS', 'CLAUDE_CONFIG_DIR', 'FORGE_ROUTER_PROFILES_DIR'];
const saved = {};
let tmp;
let n = 0;
let profilesRoot;

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-exec-probe-'));
});
beforeEach(() => {
  n += 1;
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_ROUTER_MOCK = '1';
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  delete process.env.CLAUDE_CONFIG_DIR;
  profilesRoot = path.join(tmp, 'profiles-' + n);
  process.env.FORGE_ROUTER_PROFILES_DIR = profilesRoot;
  _setRouterDirForTests(path.join(tmp, 'router-' + n));
  _setProbeSpawnSpecForTests(null);
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _setRouterDirForTests(null);
  _setProbeSpawnSpecForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

const claude = (id) => ({ id, kind: 'claude-account', label: id, profile: id === 'main' ? null : id, enabled: true, threshold_pct: null });
function profile(slug, markers = []) {
  const dir = path.join(profilesRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const m of markers) fs.writeFileSync(path.join(dir, m), '');
}
const probeTemps = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('forge-router-probe-'));

test('claude probe: a signed-in profile answers -> ok, a lost-login mark is cleared, recorded:true (the route logs router_test), temp folder removed', async () => {
  profile('werk');
  markNeedsLogin('werk');
  const tempsBefore = new Set(probeTemps());
  const r = await runTargetProbe(claude('werk'));
  assert.deepEqual({ ok: r.ok, outcome: r.outcome, detail: r.detail }, { ok: true, outcome: 'ok', detail: 'ok' });
  assert.equal(r.state, 'unknown', 'no usage number was reported, so usage stays unknown (never 0)');
  assert.equal(readReadings().werk.needs_login_at, null);
  assert.equal(readReadings().werk.source, 'test');
  assert.equal(r.recorded, true, 'the probe stored what it proved, so the route must not store it again');
  assert.deepEqual(readRouterEvents().filter((e) => e.kind === 'router_test'), [], 'one writer per fact: the route writes the router_test line, not the probe');
  assert.deepEqual(probeTemps().filter((d) => !tempsBefore.has(d)), [], 'the private probe folder is removed');
});

test('claude probe: not signed in -> needs-login; limited -> exhausted with the reading; missing folder -> not signed in', async () => {
  profile('leeg', ['mock-logged-out']);
  const out = await runTargetProbe(claude('leeg'));
  assert.deepEqual({ ok: out.ok, outcome: out.outcome, state: out.state }, { ok: false, outcome: 'logged_out', state: 'needs-login' });

  profile('vol', ['mock-limit']);
  const lim = await runTargetProbe(claude('vol'));
  assert.deepEqual({ ok: lim.ok, outcome: lim.outcome, state: lim.state }, { ok: false, outcome: 'rate_limited', state: 'exhausted' });
  assert.equal(lim.reading.windows[0].status, 'rejected');
  assert.ok(Date.parse(readReadings().vol.limit_hit.resets_at) > Date.now());

  const gone = await runTargetProbe(claude('nergens'));
  assert.deepEqual({ outcome: gone.outcome, detail: gone.detail, state: gone.state }, { outcome: 'logged_out', detail: 'profile_missing', state: 'needs-login' });
});

test('claude probe: a hung child is killed after the cap (exact PID) and reported as timeout', async () => {
  profile('hang');
  const pidFile = path.join(tmp, 'hang-pid-' + n);
  _setProbeSpawnSpecForTests(() => ({ cmd: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);', pidFile] }));
  const started = Date.now();
  // 4 s: long enough for a loaded machine to start the stub and write its pid (a 400 ms cap could kill
  // it before that, which proves the kill but leaves no pid to check).
  const r = await runTargetProbe(claude('hang'), { timeoutMs: 4000 });
  assert.deepEqual({ outcome: r.outcome, detail: r.detail }, { outcome: 'error', detail: 'timeout' });
  assert.ok(Date.now() - started < 15000);
  assert.ok(fs.existsSync(pidFile), 'the stub started and wrote its pid before the cap');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const deadline = Date.now() + 8000;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (alive() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(), false, 'the probe child must be gone');
});

test('provider probe (finding 12): uses the entry\'s own port; model listed -> ok, not listed -> model_not_pulled, refused -> ollama_down', async () => {
  const s = await startMockServer(async (req, h) => {
    if (req.path === '/api/tags') return h.json(200, { models: [{ name: 'stub-model:latest' }] });
    return h.json(404, {});
  });
  try {
    const entry = { id: 'ollama', kind: 'provider-model', label: 'Ollama', provider: 'ollama-local', model: 'stub-model', enabled: true, num_ctx: null, vars: { port: String(s.port) }, paid_ack: false, notice_ack: false };
    const ok = await runTargetProbe(entry);
    assert.deepEqual({ ok: ok.ok, detail: ok.detail, state: ok.state }, { ok: true, detail: 'ok', state: 'ready' });
    assert.ok(s.requests.some((q) => q.path === '/api/tags'), 'the stub on the entry port was asked');
    const missing = await runTargetProbe({ ...entry, model: 'other-model' });
    assert.deepEqual({ outcome: missing.outcome, detail: missing.detail, state: missing.state }, { outcome: 'down', detail: 'model_not_pulled', state: 'down' });
  } finally {
    await s.close();
  }
  const closed = await startMockServer(() => {});
  const port = closed.port;
  await closed.close();
  const down = await runTargetProbe({ id: 'ollama2', kind: 'provider-model', label: 'Ollama', provider: 'ollama-local', model: 'm', enabled: true, num_ctx: null, vars: { port: String(port) }, paid_ack: false, notice_ack: false });
  assert.deepEqual({ outcome: down.outcome, detail: down.detail }, { outcome: 'down', detail: 'ollama_down' });
});

test('every probe result says recorded:true and a down provider carries the error-card code (one writer per fact)', async () => {
  const s = await startMockServer(async (req, h) => (req.path === '/api/tags' ? h.json(200, { models: [{ name: 'stub-model:latest' }] }) : h.json(404, {})));
  const entry = { id: 'ollama', kind: 'provider-model', label: 'Ollama', provider: 'ollama-local', model: 'other-model', enabled: true, num_ctx: null, vars: { port: String(s.port) }, paid_ack: false, notice_ack: false };
  let missing;
  try {
    missing = await runTargetProbe(entry);
  } finally {
    await s.close();
  }
  assert.deepEqual({ outcome: missing.outcome, code: missing.code, recorded: missing.recorded }, { outcome: 'down', code: 'model_not_pulled', recorded: true });
  const closed = await startMockServer(() => {});
  const port = closed.port;
  await closed.close();
  const down = await runTargetProbe({ ...entry, id: 'ollama2', vars: { port: String(port) } });
  assert.deepEqual({ outcome: down.outcome, code: down.code, recorded: down.recorded }, { outcome: 'down', code: 'ollama_down', recorded: true });
  profile('leeg', ['mock-logged-out']);
  const out = await runTargetProbe(claude('leeg'));
  assert.deepEqual({ outcome: out.outcome, recorded: out.recorded }, { outcome: 'logged_out', recorded: true });
  assert.equal((await runTargetProbe({ id: 'x', kind: 'nope' })).recorded, true, 'nothing to record is also "recorded": the route adds nothing');
  assert.deepEqual(readRouterEvents().filter((e) => e.kind === 'router_test'), [], 'the probe never writes router_test');
});

test('probe argv and outcome table (pure)', async () => {
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--output-format', '--verbose']) assert.ok(PROBE_ARGS.includes(flag), flag);
  assert.deepEqual(PROBE_ARGS.slice(0, 6), ['-p', '.', '--model', 'haiku', '--max-turns', '1']);
  assert.equal(PROBE_ARGS[PROBE_ARGS.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(probeOutcome({ timedOut: true, lines: [] }).detail, 'timeout');
  assert.equal(probeOutcome({ exitCode: 0, lines: [{ type: 'result', is_error: false }] }).outcome, 'ok');
  assert.equal(probeOutcome({ exitCode: 1, lines: [], unparsed: 'Not logged in · Please run /login\n', stderr: '' }).outcome, 'logged_out');
  assert.equal(probeOutcome({ exitCode: 1, lines: [], unparsed: '', stderr: 'Not logged in' }).outcome, 'logged_out');
  assert.equal(probeOutcome({ exitCode: 1, lines: [{ type: 'result', is_error: true, api_error_status: 429, result: 'limit' }], unparsed: '', stderr: '' }).outcome, 'rate_limited');
  assert.equal(probeOutcome({ exitCode: 1, lines: [], unparsed: '', stderr: '' }).outcome, 'error');
  const bad = await runTargetProbe({ id: 'x', kind: 'nope' });
  assert.equal(bad.detail, 'bad_entry');
});
