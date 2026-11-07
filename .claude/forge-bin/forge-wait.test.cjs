#!/usr/bin/env node
'use strict';
// forge-wait.test.cjs — category finding H1: forge-wait.cjs blocks in the foreground until every subagent
// of a session that has a SubagentStart line but no SubagentStop line (by agent_id) has stopped. HERMETIC: every
// fixture is a fresh os.tmpdir() project; nothing reads or writes this repo's real .claude/forge-runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const W = require('./forge-wait.cjs');

delete process.env.FORGE_STATE_DIR;
let passed = 0, failed = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

const CLI = path.join(__dirname, 'forge-wait.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fwait-'));
const SID = '9ed27d95-0000-4000-8000-00000000wait';
const OTHER = 'aaaaaaaa-1111-4111-8111-111111111111';
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;

function proj(name) {
  const root = path.join(TMP, name + '-' + (++seq));
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', '_hooks'), { recursive: true });
  return root;
}
const hooks = (root) => path.join(root, '.claude', 'forge-runs', '_hooks');
function line(root, file, rec) { fs.appendFileSync(path.join(hooks(root), file), JSON.stringify(rec) + '\n'); }
function start(root, sid, id, type, ms) { line(root, 'subagent-start.jsonl', { ts: iso(ms || Date.now() - 60e3), event: 'SubagentStart', session: sid, agent_id: id, agent_type: type || 'build-boss' }); }
function stopLine(root, sid, id, type) { line(root, 'subagent-stop.jsonl', { ts: iso(Date.now()), event: 'SubagentStop', session: sid, agent_id: id, agent_type: type || 'build-boss' }); }
function dirs(root) { return W.runsDirsFor(root); }
function cliEnv(root) { const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }); delete env.FORGE_STATE_DIR; return env; }
function runCli(root, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI].concat(args), { env: cliEnv(root), windowsHide: true });
    let out = '';
    const t0 = Date.now();
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

console.log('forge-wait tests');

t('open vs closed: a start without a stop is open, a start with a stop (same agent_id) is closed', () => {
  const root = proj('open');
  start(root, SID, 'a1', 'build-boss');
  start(root, SID, 'a2', 'test-boss');
  stopLine(root, SID, 'a1');
  const open = W.openAgents(dirs(root), { session: SID });
  assert.deepStrictEqual(open.map((a) => a.agent_id), ['a2']);
  assert.strictEqual(open[0].agent_type, 'test-boss');
});
t('other sessions are ignored; the stop may carry another session scheme (matched by agent_id only)', () => {
  const root = proj('sessions');
  start(root, OTHER, 'o1');
  start(root, SID, 'a1');
  stopLine(root, 'session-123', 'a1');
  assert.deepStrictEqual(W.openAgents(dirs(root), { session: SID }), []);
  assert.deepStrictEqual(W.openAgents(dirs(root), { session: OTHER }).map((a) => a.agent_id), ['o1']);
});
t('start lines older than 2 hours, without an agent_id, or garbage do not count', () => {
  const root = proj('old');
  start(root, SID, 'old1', 'x', Date.now() - W.OPEN_MAX_AGE_MS - 60e3);
  line(root, 'subagent-start.jsonl', { ts: iso(Date.now()), event: 'SubagentStart', session: SID, agent_id: null });
  fs.appendFileSync(path.join(hooks(root), 'subagent-start.jsonl'), '{not json\n');
  assert.deepStrictEqual(W.openAgents(dirs(root), { session: SID }), []);
});
t('the rotated generation (.1.jsonl) is read too', () => {
  const root = proj('rot');
  line(root, 'subagent-start.1.jsonl', { ts: iso(Date.now() - 5e3), event: 'SubagentStart', session: SID, agent_id: 'r1', agent_type: 'ui-boss' });
  assert.strictEqual(W.openAgents(dirs(root), { session: SID }).length, 1);
  stopLine(root, SID, 'r1');
  assert.strictEqual(W.openAgents(dirs(root), { session: SID }).length, 0);
});
t('session default: the most recent session that has an open subagent', () => {
  const root = proj('latest');
  start(root, OTHER, 'o1', 'x', Date.now() - 10 * 60e3);
  start(root, SID, 's1', 'x', Date.now() - 60e3);
  start(root, 'closed-session', 'c1', 'x', Date.now() - 10e3);
  stopLine(root, 'closed-session', 'c1');
  assert.strictEqual(W.latestOpenSession(dirs(root)), SID);
});
t('no runs folder / missing logs: empty, never throws', () => {
  assert.deepStrictEqual(W.openAgents(dirs(path.join(TMP, 'nope')), { session: SID }), []);
  assert.deepStrictEqual(W.openAgents(['\u0000bad'], {}), []);
});
t('argument parsing: bad session / value / unknown flag are errors; --max-sec is capped under 10 minutes', () => {
  assert.ok(W.parseArgs(['--session', '../x']).error);
  assert.ok(W.parseArgs(['--max-sec', 'abc']).error);
  assert.ok(W.parseArgs(['--bogus']).error);
  assert.ok(W.parseArgs(['--session']).error);
  assert.strictEqual(W.parseArgs([]).maxSec, 540);
  assert.ok(W.parseArgs(['--max-sec', '9999']).maxSec < 600);
});
t('CLI: nothing open -> exit 0 "all done" at once', async () => {
  const root = proj('cli-none');
  const r = await runCli(root, ['--session', SID]);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/all done/.test(r.out), r.out);
});
t('CLI: bad argument -> exit 2', async () => {
  const r = await runCli(proj('cli-bad'), ['--session', 'a b']);
  assert.strictEqual(r.code, 2, r.out);
});
t('CLI: returns 0 when the stop line appears DURING the wait (written from a timer)', async () => {
  const root = proj('cli-during');
  start(root, SID, 'w1', 'build-boss');
  start(root, OTHER, 'ignored', 'x');
  const timer = setTimeout(() => stopLine(root, SID, 'w1'), 900);
  const r = await runCli(root, ['--session', SID, '--max-sec', '20', '--poll-sec', '0.2']);
  clearTimeout(timer);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/1 open: build-boss/.test(r.out), 'printed the open line: ' + r.out);
  assert.ok(/all done/.test(r.out), r.out);
  assert.ok(r.ms >= 800 && r.ms < 15000, 'waited for the stop: ' + r.ms + ' ms');
});
t('CLI: default session (no --session) waits for the most recent open session', async () => {
  const root = proj('cli-default');
  start(root, SID, 'd1', 'test-boss');
  const timer = setTimeout(() => stopLine(root, SID, 'd1'), 600);
  const r = await runCli(root, ['--max-sec', '20', '--poll-sec', '0.2']);
  clearTimeout(timer);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(SID), r.out);
});
t('CLI: still open at --max-sec -> exit 3 naming the count and the types; the count line changes once', async () => {
  const root = proj('cli-timeout');
  start(root, SID, 'h1', 'build-boss');
  start(root, SID, 'h2', 'build-boss');
  start(root, SID, 'h3', 'test-boss');
  const timer = setTimeout(() => stopLine(root, SID, 'h3'), 500);
  const r = await runCli(root, ['--session', SID, '--max-sec', '1.5', '--poll-sec', '0.2']);
  clearTimeout(timer);
  assert.strictEqual(r.code, 3, r.out);
  assert.ok(/3 open: build-boss x2, test-boss/.test(r.out), r.out);
  assert.ok(/2 open: build-boss x2/.test(r.out), r.out);
  assert.ok(/still 2 open after \d+ s: build-boss x2/.test(r.out), r.out);
  assert.ok(r.ms >= 1400, 'waited the full max: ' + r.ms);
});
t('CLI file is LF and has no dependencies beyond node builtins and forge-toolhook', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.ok(!src.includes('\r\n'));
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  for (const r of reqs) assert.ok(['fs', 'path', './forge-toolhook.cjs'].includes(r), r);
  assert.strictEqual(spawnSync(process.execPath, ['--check', CLI]).status, 0);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
