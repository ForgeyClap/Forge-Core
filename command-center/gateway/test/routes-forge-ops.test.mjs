// WP A6-3: routes/forge-ops.mjs, the read-only gateway routes for forge-killswitch.cjs and
// forge-rollback.cjs. A fake tool script (fixture) stands in for both real tools; its behaviour is
// chosen with CC_FORGE_OPS_FIXTURE_MODE (a CC_* name, so the credential-free env allowlist forwards
// it). Temp folders under os.tmpdir(); every folder is removed afterwards.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as forgeOps from '../src/routes/forge-ops.mjs';

const {
  buildKillswitchStatus, buildRollbackList, buildRollbackPlan, killswitchStatus, rollbackList, rollbackPlan,
  _setForgeOpsBinDirForTests, _setForgeOpsTimeoutForTests, _resetForgeOpsForTests,
  ROUTES, KILLSWITCH_STATUS_ARGS, ROLLBACK_LIST_ARGS, ROLLBACK_PLAN_ARGS, TOOL_TIMEOUT_MS,
} = forgeOps;

const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => {
  _resetForgeOpsForTests();
  delete process.env.CC_FORGE_OPS_FIXTURE_MODE;
  delete process.env.CC_FORGE_OPS_FAKE_TOKEN;
});

// Built by concatenation so the repo's own leak scans never see a token-shaped literal.
const PLANTED = 'sk-' + 'ant-api03-' + 'B'.repeat(30);

const FIXTURE = `
const mode = process.env.CC_FORGE_OPS_FIXTURE_MODE || 'ok';
const argv = process.argv.slice(2);
if (mode === 'sleep') { setTimeout(() => {}, 60000); }
else if (mode === 'refuse') { process.stderr.write('no checkpoint for run x, key ${PLANTED}\\n'); process.exitCode = 1; }
else if (mode === 'garbage') { process.stdout.write('this is not json'); }
else if (mode === 'unsupported') { process.stdout.write(JSON.stringify({ ok: false, supported: false, platform: 'linux', reason: 'Windows-only' })); process.exitCode = 2; }
else { process.stdout.write(JSON.stringify({ argv, env_keys: Object.keys(process.env), leaked: 'value ' + '${PLANTED}', cwd: process.cwd() })); }
`;

function makeBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-forge-ops-bin-'));
  made.push(dir);
  for (const name of ['forge-killswitch.cjs', 'forge-rollback.cjs']) fs.writeFileSync(path.join(dir, name), FIXTURE, 'utf8');
  return dir;
}

function makeProject({ tools = ['forge-killswitch.cjs', 'forge-rollback.cjs'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-forge-ops-proj-'));
  made.push(root);
  const bin = path.join(root, '.claude', 'forge-bin');
  fs.mkdirSync(bin, { recursive: true });
  // The project's own copy is a marker only: it must never be executed (settings, never code).
  for (const t of tools) fs.writeFileSync(path.join(bin, t), 'process.stdout.write("{\\"project_copy_ran\\":true}")', 'utf8');
  return root;
}

const DESTRUCTIVE = ['stop', 'restore', 'apply', 'undo', 'checkpoint', '--confirm', '--yes', '--force-dirty', '--allow-diverged'];

test('killswitch status runs the central tool with the fixed read-only argv and --root, redacted', async () => {
  _setForgeOpsBinDirForTests(makeBinDir());
  const project = makeProject();
  const r = await buildKillswitchStatus(project);
  assert.equal(r.state, 'OK');
  assert.equal(r.available, true);
  assert.equal(r.exit_code, 0);
  assert.equal(r.tool, 'forge-killswitch.cjs');
  assert.equal(r.command, 'status');
  assert.deepEqual(r.result.argv, ['status', '--json', '--root', project]);
  assert.equal(r.result.project_copy_ran, undefined, 'the selected project\'s own tool copy must never run');
  assert.ok(!JSON.stringify(r).includes(PLANTED), 'tool output must be redacted');
});

test('the child gets the credential-free env: no *_TOKEN name reaches it', async () => {
  _setForgeOpsBinDirForTests(makeBinDir());
  process.env.CC_FORGE_OPS_FAKE_TOKEN = 'not-a-real-token';
  const r = await buildKillswitchStatus(makeProject());
  assert.equal(r.state, 'OK');
  assert.ok(!r.result.env_keys.includes('CC_FORGE_OPS_FAKE_TOKEN'));
  assert.ok(r.result.env_keys.some((k) => k.toLowerCase() === 'path'), 'PATH is still forwarded');
});

test('rollback list and plan run list --json / plan --json --run <id> --root <project>', async () => {
  _setForgeOpsBinDirForTests(makeBinDir());
  const project = makeProject();
  const list = await buildRollbackList(project);
  assert.equal(list.state, 'OK');
  assert.deepEqual(list.result.argv, ['list', '--json', '--root', project]);
  const plan = await buildRollbackPlan(project, 'forge-2026-11-01-run_1');
  assert.equal(plan.state, 'OK');
  assert.equal(plan.command, 'plan');
  assert.deepEqual(plan.result.argv, ['plan', '--json', '--run', 'forge-2026-11-01-run_1', '--root', project]);
});

test('plan refuses a bad run id without spawning anything', async () => {
  _setForgeOpsBinDirForTests(makeBinDir());
  const project = makeProject();
  for (const bad of ['', '../x', '-rf', 'a b', '--yes', 'x'.repeat(200)]) {
    assert.equal(await buildRollbackPlan(project, bad), null, 'refused: ' + JSON.stringify(bad));
  }
});

test('a tool refusal (non-zero exit) is REFUSED with the redacted stderr reason', async () => {
  _setForgeOpsBinDirForTests(makeBinDir());
  process.env.CC_FORGE_OPS_FIXTURE_MODE = 'refuse';
  const r = await buildRollbackPlan(makeProject(), 'run1');
  assert.equal(r.state, 'REFUSED');
  assert.equal(r.available, true);
  assert.equal(r.exit_code, 1);
  assert.match(r.note, /no checkpoint for run x/);
  assert.ok(!r.note.includes(PLANTED));
});

test('a timeout is TIMEOUT, never a fake status', async () => {
  _setForgeOpsBinDirForTests(makeBinDir());
  _setForgeOpsTimeoutForTests(300);
  process.env.CC_FORGE_OPS_FIXTURE_MODE = 'sleep';
  const r = await buildKillswitchStatus(makeProject());
  assert.equal(r.state, 'TIMEOUT');
  assert.equal(r.available, false);
  assert.equal(r.result, null);
  assert.match(r.note, /timed out after 300ms/);
  assert.equal(TOOL_TIMEOUT_MS, 10_000, 'the production timeout is 10 s');
});

test('output that is not JSON is FAILED; the killswitch on another OS is UNSUPPORTED', async () => {
  _setForgeOpsBinDirForTests(makeBinDir());
  process.env.CC_FORGE_OPS_FIXTURE_MODE = 'garbage';
  const g = await buildRollbackList(makeProject());
  assert.equal(g.state, 'FAILED');
  assert.equal(g.available, false);
  process.env.CC_FORGE_OPS_FIXTURE_MODE = 'unsupported';
  const u = await buildKillswitchStatus(makeProject());
  assert.equal(u.state, 'UNSUPPORTED');
  assert.equal(u.exit_code, 2);
  assert.equal(u.note, 'Windows-only');
});

test('tool not found: the project has no such tool, or the gateway has no own copy', async () => {
  _setForgeOpsBinDirForTests(makeBinDir());
  const bare = makeProject({ tools: [] });
  const k = await buildKillswitchStatus(bare);
  assert.equal(k.state, 'TOOL_NOT_FOUND');
  assert.equal(k.available, false);
  assert.match(k.note, /tool not found: this project has no \.claude\/forge-bin\/forge-killswitch\.cjs/);
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-forge-ops-empty-'));
  made.push(emptyBin);
  _setForgeOpsBinDirForTests(emptyBin);
  const r = await buildRollbackList(makeProject());
  assert.equal(r.state, 'TOOL_NOT_FOUND');
  assert.match(r.note, /gateway has no own copy of forge-rollback\.cjs/);
});

test('no route in the module accepts a write method, and no argv can reach a destructive command', async () => {
  assert.equal(ROUTES.length, 3);
  for (const r of ROUTES) {
    assert.equal(r.method, 'GET', r.path);
    assert.equal(typeof forgeOps[r.handler], 'function', r.handler);
  }
  for (const args of [KILLSWITCH_STATUS_ARGS, ROLLBACK_LIST_ARGS, ROLLBACK_PLAN_ARGS]) {
    assert.ok(Object.isFrozen(args));
    for (const word of DESTRUCTIVE) assert.ok(!args.includes(word), word + ' in ' + args.join(' '));
  }
  // Every exported handler refuses every write method with 405 before doing anything else.
  for (const r of ROUTES) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = fakeRes();
      await forgeOps[r.handler]({ method }, res, { searchParams: new URLSearchParams('project=x&run=a') });
      assert.equal(res.status, 405, r.path + ' ' + method);
      assert.equal(res.headers.Allow, 'GET');
    }
  }
  // And the module source itself never names a destructive sub-command as an argv string.
  const src = fs.readFileSync(new URL('../src/routes/forge-ops.mjs', import.meta.url), 'utf8');
  for (const word of ['--confirm', '--yes']) assert.ok(!new RegExp(`'${word}'`).test(src), word + ' appears as a string literal');
  for (const word of ['stop', 'restore', 'apply', 'undo', 'checkpoint']) assert.ok(!new RegExp(`\\['${word}'`).test(src), word + ' starts an argv array');
});

function fakeRes() {
  const res = { status: null, headers: null, body: null };
  res.writeHead = (s, h) => { res.status = s; res.headers = h; };
  res.end = (b) => { res.body = b ? JSON.parse(b) : null; };
  return res;
}

test('handlers: a bad run id is 400 before any project lookup', async () => {
  const bad = fakeRes();
  await rollbackPlan({ method: 'GET' }, bad, { searchParams: new URLSearchParams('project=x&run=../etc') });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
  const missing = fakeRes();
  await rollbackPlan({ method: 'GET' }, missing, { searchParams: new URLSearchParams('project=x') });
  assert.equal(missing.status, 400);
  assert.equal(typeof killswitchStatus, 'function');
  assert.equal(typeof rollbackList, 'function');
});
