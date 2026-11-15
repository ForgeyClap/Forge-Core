#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-stop-obligations.test.cjs —: the advisory Stop hook and
// the shared hook helpers (findActiveRun, obligationsFor, appendRunEvent, recordGateBlock). HERMETIC: every
// fixture is a fresh os.tmpdir() project; nothing reads or writes this repo's real .claude/forge-runs. Where a real
// event must be written, the project's own log-event.cjs is COPIED into the fixture (it resolves its run folder
// from its own location), so the append lands in the fixture only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');
const OBL = require('./forge-stop-obligations.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const REPO_CLAUDE = path.resolve(__dirname, '..');
const LOG_EVENT_SRC = path.join(REPO_CLAUDE, 'forge-dashboard', 'log-event.cjs');
const RULES_SRC = path.join(REPO_CLAUDE, 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const CLI = path.join(__dirname, 'forge-stop-obligations.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fso-test-'));
let seq = 0;
function fixture(name) {
  const root = path.join(TMP, (name || 'p') + '-' + (++seq));
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  return root;
}
const iso = (msAgo) => new Date(Date.now() - (msAgo || 0)).toISOString();
function writeRun(root, id, events, o) {
  o = o || {};
  const dir = path.join(root, '.claude', 'forge-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map((e) => (typeof e === 'string' ? e : JSON.stringify(Object.assign({ run_id: id }, e)))).join('\n') + '\n');
  if (o.finalized) fs.writeFileSync(path.join(dir, 'run-finalized.json'), '{}');
  if (o.runJson) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run_id: id }));
  if (typeof o.mtimeMsAgo === 'number') { const tm = new Date(Date.now() - o.mtimeMsAgo); fs.utimesSync(file, tm, tm); }
  return dir;
}
function withRules(root) {
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(RULES_SRC, path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
}
function withLogEvent(root) {
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(LOG_EVENT_SRC, path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
}
function startRealRun(root, id) {
  // a properly hash-chained run_started, written by the fixture's own copy of log-event.cjs
  const r = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), id, 'run_started', JSON.stringify({ agent: 'orchestrator', task: 'fixture run' })], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'fixture run_started failed: ' + r.stderr);
}
function eventsOf(root, id) {
  const raw = fs.readFileSync(path.join(root, '.claude', 'forge-runs', id, 'events.jsonl'), 'utf8');
  return raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function fakeRc(obligations, extra) {
  return { planFor: (p) => Object.assign({
    run_id: p.run_id, state: { status: 'working', phase: 'wp' }, contract: { ok: false, missing: ['a', 'b'] },
    obligations, next: { text: 'do the next thing' },
  }, extra || {}) };
}
const ob = (id, due, severity) => ({ id, due, severity: severity || 'block', how: 'how to satisfy ' + id });

console.log('forge-stop-obligations tests (WP-6 Stop hook + shared hook helpers)');

// ---------------------------------------------------------------------------
console.log('\n1) findActiveRun — which run is "active"');
t('no .claude/forge-runs folder -> no run, honest reason', () => {
  const root = path.join(TMP, 'empty-' + (++seq));
  fs.mkdirSync(root, { recursive: true });
  const r = OBL.findActiveRun(root);
  assert.strictEqual(r.run, null);
  assert.ok(/forge-runs/.test(r.reason), r.reason);
});
t('the newest open genuine run wins; finalized, closed, receipt-only and stale runs are skipped', () => {
  const root = fixture('pick');
  writeRun(root, 'old-open', [{ event_type: 'run_started', timestamp: iso(3600e3) }], { mtimeMsAgo: 3600e3 });
  writeRun(root, 'finalized', [{ event_type: 'run_started', timestamp: iso(60e3) }], { finalized: true, mtimeMsAgo: 10e3 });
  writeRun(root, 'closed', [{ event_type: 'run_started', timestamp: iso(60e3) }, { event_type: 'run_completed', timestamp: iso(50e3) }, { event_type: 'gate_evaluated', timestamp: iso(40e3) }], { mtimeMsAgo: 20e3 });
  writeRun(root, 'receipt-only', [{ event_type: 'doctor_run', timestamp: iso(5e3) }], { mtimeMsAgo: 5e3 });
  writeRun(root, 'stale', [{ event_type: 'run_started', timestamp: iso(48 * 3600e3) }], { mtimeMsAgo: 48 * 3600e3 });
  const r = OBL.findActiveRun(root);
  assert.ok(r.run, JSON.stringify(r));
  assert.strictEqual(r.run.run_id, 'old-open');
  assert.ok(r.skipped.some((s) => /^finalized: finalized/.test(s)) && r.skipped.some((s) => /^closed: closed/.test(s)) && r.skipped.some((s) => /^receipt-only:/.test(s)), JSON.stringify(r.skipped));
});
t('work logged after run_completed reopens the run (active again); a run.json alone makes a run genuine', () => {
  const root = fixture('reopen');
  writeRun(root, 'reopened', [{ event_type: 'run_started', timestamp: iso(60e3) }, { event_type: 'run_completed', timestamp: iso(50e3) }, { event_type: 'file_changed', timestamp: iso(40e3) }]);
  assert.strictEqual(OBL.findActiveRun(root).run.run_id, 'reopened');
  const root2 = fixture('runjson');
  writeRun(root2, 'legacy', [{ event_type: 'agent_note', timestamp: iso(1e3) }], { runJson: true });
  assert.strictEqual(OBL.findActiveRun(root2).run.run_id, 'legacy');
});
t('a recently touched file whose last EVENT is older than the window is not active', () => {
  const root = fixture('old-events');
  writeRun(root, 'r1', [{ event_type: 'run_started', timestamp: iso(30 * 3600e3) }]); // mtime now, events 30h old
  const r = OBL.findActiveRun(root);
  assert.strictEqual(r.run, null, JSON.stringify(r));
});
t('a corrupt log (garbage lines) is read leniently and never throws', () => {
  const root = fixture('corrupt');
  writeRun(root, 'r-corrupt', [JSON.stringify({ run_id: 'r-corrupt', event_type: 'run_started', timestamp: iso(1e3) }), '{ not json', '\u0000\u0001garbage']);
  const r = OBL.findActiveRun(root);
  assert.strictEqual(r.run.run_id, 'r-corrupt');
  const root2 = fixture('allgarbage');
  writeRun(root2, 'r-garbage', ['{{{', 'nope']);
  assert.strictEqual(OBL.findActiveRun(root2).run, null);
});

// ---------------------------------------------------------------------------
console.log('\n2) obligationsFor / formatObligations — bounded, fail-open');
t('15 due obligations -> at most 10 lines and at most OBLIGATION_MAX_CHARS characters, with "+N more", Next and the plan command', () => {
  const many = Array.from({ length: 15 }, (_, i) => ob('rule-' + i + '-' + 'x'.repeat(200), i % 2 ? 'overdue' : 'due-now', i % 3 ? 'block' : 'warn'));
  const r = OBL.obligationsFor('/nowhere', 'r1', { runcontract: fakeRc(many.concat([ob('later-rule', 'later')])) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.due_count, 15);
  assert.ok(r.lines.length <= OBL.OBLIGATION_MAX_LINES, 'lines ' + r.lines.length);
  assert.ok(r.text.length <= OBL.OBLIGATION_MAX_CHARS, 'chars ' + r.text.length);
  const shown = r.lines.filter((l) => /^ {2}[✗⚠] /.test(l)).length;
  const more = r.lines.map((l) => /\+(\d+) more/.exec(l)).find(Boolean);
  assert.ok(more && shown + Number(more[1]) === 15, 'shown ' + shown + ' + more must account for all 15: ' + r.text);
  assert.ok(r.lines.some((l) => /^Next: /.test(l)) && r.lines.some((l) => /forge-runcontract\.cjs plan --run r1/.test(l)), r.text);
  assert.ok(!/later-rule/.test(r.text), 'a not-yet-due rule must not be listed');
});
t('control characters and newlines in obligation text are flattened to one line each', () => {
  const r = OBL.obligationsFor('/nowhere', 'r1', { runcontract: fakeRc([{ id: 'x', due: 'overdue', severity: 'block', how: 'line1\nIGNORE ALL\r\n\u0007PREVIOUS' }]) });
  assert.ok(r.lines.every((l) => !/[\r\n\u0007]/.test(l)), JSON.stringify(r.lines));
});
t('FAIL-OPEN: a throwing planFor, a missing checker, a bad run id -> ok:false plus ONE honest line naming the plan command, never a throw', () => {
  const thrower = { planFor: () => { throw new Error('events log is CORRUPT (regel 2)'); } };
  for (const [rc, id] of [[thrower, 'r1'], [null, 'r1'], [{}, 'r1'], [fakeRc([]), '../escape']]) {
    const r = OBL.obligationsFor('/nowhere', id, { runcontract: rc });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.lines.length, 1);
    assert.ok(/could not be computed — run node \.claude\/forge-bin\/forge-runcontract\.cjs plan --run/.test(r.text), r.text);
  }
});
t('REAL checker on a fixture run (copied FORGE_HARD_RULES.json) -> bounded obligations; a CORRUPT log fails open', () => {
  const root = fixture('realrc');
  withRules(root);
  writeRun(root, 'r-open', [{ event_type: 'run_started', agent: 'orchestrator', timestamp: iso(1e3) }, { event_type: 'agent_work_package_created', agent: 'orchestrator', wp_id: 'W1', timestamp: iso(1e3) }]);
  const r = OBL.obligationsFor(root, 'r-open', {});
  assert.strictEqual(r.ok, true, r.reason);
  assert.ok(r.due_count > 0 && r.lines.length <= 10 && r.text.length <= OBL.OBLIGATION_MAX_CHARS, r.text);
  writeRun(root, 'r-open', [JSON.stringify({ run_id: 'r-open', event_type: 'run_started', timestamp: iso(1e3) }), '{ not json', JSON.stringify({ run_id: 'r-open', event_type: 'agent_note', timestamp: iso(1e3) })]);
  const c = OBL.obligationsFor(root, 'r-open', {});
  assert.strictEqual(c.ok, false);
  assert.ok(/CORRUPT|could not be computed/.test(c.text), c.text);
});

// ---------------------------------------------------------------------------
console.log('\n3) runStop — advisory, honours stop_hook_active, silent when nothing is due');
t('stop_hook_active:true -> prints nothing (even with obligations due)', () => {
  const root = fixture('sha');
  writeRun(root, 'r1', [{ event_type: 'run_started', timestamp: iso(1e3) }]);
  const r = OBL.runStop({ stop_hook_active: true }, { projectRoot: root, runcontract: fakeRc([ob('a', 'overdue')]) });
  assert.strictEqual(r.print, false);
  assert.ok(/stop_hook_active/.test(r.reason));
});
t('FORGE_STOP_OBLIGATIONS=off -> prints nothing', () => {
  const root = fixture('off');
  writeRun(root, 'r1', [{ event_type: 'run_started', timestamp: iso(1e3) }]);
  const r = OBL.runStop({}, { projectRoot: root, env: { FORGE_STOP_OBLIGATIONS: 'off' }, runcontract: fakeRc([ob('a', 'overdue')]) });
  assert.strictEqual(r.print, false);
});
t('no active run -> prints nothing; nothing due (only later obligations) -> prints nothing', () => {
  const root = fixture('none');
  assert.strictEqual(OBL.runStop({}, { projectRoot: root }).print, false);
  const root2 = fixture('nothing-due');
  writeRun(root2, 'r1', [{ event_type: 'run_started', timestamp: iso(1e3) }]);
  const r = OBL.runStop({}, { projectRoot: root2, runcontract: fakeRc([ob('later', 'later')]) });
  assert.strictEqual(r.print, false);
  assert.strictEqual(r.due_count, 0);
});
t('due obligations -> prints the bounded block naming the run', () => {
  const root = fixture('due');
  writeRun(root, 'r-due', [{ event_type: 'run_started', timestamp: iso(1e3) }]);
  const r = OBL.runStop({ stop_hook_active: false }, { projectRoot: root, runcontract: fakeRc([ob('memory-read', 'overdue'), ob('w', 'due-now', 'warn')]) });
  assert.strictEqual(r.print, true);
  assert.strictEqual(r.run_id, 'r-due');
  assert.ok(/run r-due/.test(r.text) && /memory-read/.test(r.text) && /\(advisory\)/.test(r.text), r.text);
});
t('FAIL-OPEN on a corrupt run with the REAL checker: one honest line, never a throw', () => {
  const root = fixture('stop-corrupt');
  withRules(root);
  writeRun(root, 'r-c', [JSON.stringify({ run_id: 'r-c', event_type: 'run_started', timestamp: iso(1e3) }), '{ not json', JSON.stringify({ run_id: 'r-c', event_type: 'agent_note', timestamp: iso(1e3) })]);
  const r = OBL.runStop({}, { projectRoot: root });
  assert.strictEqual(r.print, true);
  assert.strictEqual(r.text.split('\n').length, 1);
});
t('version skew: a checker WITHOUT planFor (older synced project) keeps the Stop hook silent; a throwing plan is surfaced', () => {
  const root = fixture('skew');
  writeRun(root, 'r1', [{ event_type: 'run_started', timestamp: iso(1e3) }]);
  const silent = OBL.runStop({}, { projectRoot: root, runcontract: { check() {} } });
  assert.strictEqual(silent.print, false);
  assert.ok(/planFor is not available/.test(silent.reason), silent.reason);
  const loud = OBL.runStop({}, { projectRoot: root, runcontract: { planFor() { throw new Error('events log is CORRUPT'); } } });
  assert.strictEqual(loud.print, true);
});
t('an internal error inside the helpers prints nothing (advisory) and never throws', () => {
  const root = fixture('boom');
  writeRun(root, 'r1', [{ event_type: 'run_started', timestamp: iso(1e3) }]);
  const r = OBL.runStop({}, { projectRoot: root, get runcontract() { throw new Error('boom'); } });
  assert.strictEqual(r.print, false);
  assert.ok(/internal: boom/.test(r.reason), r.reason);
});

// ---------------------------------------------------------------------------
console.log('\n4) CLI — real spawned Stop hook (CLAUDE_PROJECT_DIR = fixture), JSON systemMessage, latency');
function spawnStop(root, input, extraEnv) {
  const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root });
  delete env.FORGE_STOP_OBLIGATIONS;
  Object.assign(env, extraEnv || {});
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env, timeout: 15000 });
  r.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return r;
}
// ---- WP-SCRIBE-REPEAT: the owner-repeat line (the end-to-end chain is in forge-scribe-hook.test.cjs section R) ----
t('owner repeats: an unaddressed repeat is ONE line even without an active run; none / a throwing store -> silent, never a throw', () => {
  const root = fixture('repeat');
  const S = require('./forge-scribe-store.cjs');
  const p = S.paths(root);
  fs.mkdirSync(path.dirname(p.ledger), { recursive: true });
  fs.writeFileSync(p.ledger, '');
  const item = (rid, n, extra) => Object.assign({ rid, status: 'open', class: 'new', repeat_of: n > 1 ? ['R-0001'] : undefined, repeat_count: n > 1 ? n : undefined }, extra || {});
  const fake = (items) => Object.assign({}, S, { loadState: () => ({ items }) });
  const two = { 'R-0001': item('R-0001', 1), 'R-0002': item('R-0002', 2), 'R-0003': Object.assign(item('R-0003', 3), { repeat_of: ['R-0002'] }) };
  const r = OBL.runStop({ stop_hook_active: false }, { projectRoot: root, env: {}, scribeStore: fake(two) });
  assert.ok(r.print && r.repeats === 1, JSON.stringify(r));
  assert.strictEqual(r.text.split('\n').length, 1, r.text);
  assert.ok(/1 owner repeat\(s\) without a HARD RULE: R-0003 REPEAT x3 of R-0002/.test(r.text) && r.text.length <= 360, r.text);
  const linked = Object.assign({}, two, { 'R-0002': item('R-0002', 2, { repeat_rule_ref: { type: 'standing_rule', ref: 'SR-1' } }) });
  const r2 = OBL.runStop({ stop_hook_active: false }, { projectRoot: root, env: {}, scribeStore: fake(linked) });
  assert.ok(!r2.print && r2.repeats === 0, JSON.stringify(r2));
  const cancelled = { 'R-0001': item('R-0001', 1), 'R-0002': item('R-0002', 2, { status: 'cancelled' }) };
  assert.strictEqual(OBL.runStop({}, { projectRoot: root, env: {}, scribeStore: fake(cancelled) }).repeats, 0);
  const boom = Object.assign({}, S, { loadState: () => { throw new Error('corrupt'); } });
  const r3 = OBL.runStop({}, { projectRoot: root, env: {}, scribeStore: boom });
  assert.ok(!r3.print && r3.repeats === 0, JSON.stringify(r3));
  assert.ok(!OBL.runStop({ stop_hook_active: true }, { projectRoot: root, env: {}, scribeStore: fake(two) }).print, 'stop_hook_active stays silent');
  assert.ok(!OBL.runStop({}, { projectRoot: root, env: { FORGE_STOP_OBLIGATIONS: 'off' }, scribeStore: fake(two) }).print, 'opt-out stays silent');
});

const CLI_ROOT = fixture('cli');
withRules(CLI_ROOT);
writeRun(CLI_ROOT, 'r-cli', [{ event_type: 'run_started', agent: 'orchestrator', timestamp: iso(1e3) }, { event_type: 'agent_work_package_created', agent: 'orchestrator', wp_id: 'W1', timestamp: iso(1e3) }]);
t('active run with obligations due -> exit 0, stdout is ONE JSON object with a systemMessage', () => {
  const r = spawnStop(CLI_ROOT, { session_id: 's', hook_event_name: 'Stop', stop_hook_active: false });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(Object.keys(j), ['systemMessage']);
  assert.ok(/run r-cli/.test(j.systemMessage) && j.systemMessage.split('\n').length <= 10, j.systemMessage);
  assert.strictEqual(r.stderr, '');
});
t('stop_hook_active:true / malformed stdin / FORGE_STOP_OBLIGATIONS=off / no active run -> exit 0 and NO output', () => {
  for (const [root, input, env] of [
    [CLI_ROOT, { stop_hook_active: true }, null],
    [CLI_ROOT, 'not json {{{', null],
    [CLI_ROOT, {}, { FORGE_STOP_OBLIGATIONS: 'off' }],
    [fixture('cli-empty'), {}, null],
  ]) {
    const r = spawnStop(root, input, env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'unexpected stdout: ' + r.stdout);
  }
});
t('LATENCY: the spawned Stop hook (node boot + lookup + plan) — measured and reported; generous bound only', () => {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const r = spawnStop(CLI_ROOT, { stop_hook_active: false });
    assert.strictEqual(r.status, 0);
    times.push(r.ms);
  }
  times.sort((a, b) => a - b);
  const inproc = OBL.runStop({}, { projectRoot: CLI_ROOT }).ms;
  console.log('       Stop hook wall-clock ms (5 spawns, sorted): ' + times.map((x) => x.toFixed(0)).join(', ') + ' · median ' + times[2].toFixed(0) + ' · in-process runStop ' + inproc + ' ms');
  if (times[2] > 1000) console.log('    ADVISORY: median above the 1000 ms design target on this machine (not a failure)');
  assert.ok(times[0] < 5000, 'fastest spawn took ' + times[0].toFixed(0) + ' ms (generous bound 5000 ms)');
});

// ---------------------------------------------------------------------------
console.log('\n5) appendRunEvent — one append through the project\'s own log-event.cjs');
t('session_resumed is appended exactly once, hash-chained, by the fixture\'s log-event copy', () => {
  const root = fixture('append');
  withLogEvent(root);
  startRealRun(root, 'r-app');
  const res = OBL.appendRunEvent(root, 'r-app', 'session_resumed', { agent: 'system', role: 'snapshot-reinject', note: 'test' });
  assert.strictEqual(res.ok, true, res.reason);
  const evs = eventsOf(root, 'r-app');
  assert.strictEqual(evs.filter((e) => e.event_type === 'session_resumed').length, 1);
  const last = evs[evs.length - 1];
  assert.ok(last.entry_hash && last.prev_hash && last.agent === 'system', JSON.stringify(last));
});
t('refusals: a non-hook event type, a bad run id, a project without log-event.cjs -> ok:false, nothing written', () => {
  const root = fixture('append-refuse');
  withLogEvent(root);
  startRealRun(root, 'r-ref');
  const before = eventsOf(root, 'r-ref').length;
  assert.strictEqual(OBL.appendRunEvent(root, 'r-ref', 'run_completed', {}).ok, false);
  assert.strictEqual(OBL.appendRunEvent(root, '../x', 'gate_blocked', {}).ok, false);
  assert.strictEqual(OBL.appendRunEvent(fixture('no-logevent'), 'r-ref', 'gate_blocked', {}).ok, false);
  assert.strictEqual(eventsOf(root, 'r-ref').length, before);
});

// ---------------------------------------------------------------------------
console.log('\n6) recordGateBlock — the gate hook\'s run record');
const LIVE = (command) => ({ session_id: 'sess-1', transcript_path: 'C:/x/t.jsonl', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const BLOCK = { exitCode: 2, stderr: 'FORGE GATE (destructive-delete): ...', gates: ['destructive-delete'] };
t('a LIVE block with an active run -> exactly one gate_blocked {gate, command_digest}, the command text is never stored', () => {
  const root = fixture('gb');
  withLogEvent(root);
  startRealRun(root, 'r-gb');
  const cmd = 'rm -rf ./src';
  const r = OBL.recordGateBlock(JSON.stringify(LIVE(cmd)), BLOCK, { projectRoot: root, env: {} });
  assert.strictEqual(r.recorded, true, r.reason);
  const gb = eventsOf(root, 'r-gb').filter((e) => e.event_type === 'gate_blocked');
  assert.strictEqual(gb.length, 1);
  assert.strictEqual(gb[0].gate, 'destructive-delete');
  assert.strictEqual(gb[0].command_digest, 'sha256:' + crypto.createHash('sha256').update(cmd, 'utf8').digest('hex'));
  assert.ok(!JSON.stringify(gb[0]).includes(cmd), 'the raw command leaked into the event');
});
t('no record (and no write) for: not a block, no session_id/transcript_path, FORGE_GATE_RUN_EVENT=off, no active run, budget spent', () => {
  const root = fixture('gb-skip');
  withLogEvent(root);
  startRealRun(root, 'r-skip');
  const before = eventsOf(root, 'r-skip').length;
  const cases = [
    [LIVE('rm -rf x'), { exitCode: 0 }, {}, /not a block/],
    [{ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, BLOCK, {}, /not a live/],
    [LIVE('rm -rf x'), BLOCK, { env: { FORGE_GATE_RUN_EVENT: 'off' } }, /FORGE_GATE_RUN_EVENT/],
    [LIVE('rm -rf x'), BLOCK, { elapsedMs: 7900 }, /no time budget/],
  ];
  for (const [payload, res, o, re] of cases) {
    const r = OBL.recordGateBlock(payload, res, Object.assign({ projectRoot: root, env: {} }, o));
    assert.strictEqual(r.recorded, false);
    assert.ok(re.test(r.reason), r.reason);
  }
  const none = OBL.recordGateBlock(LIVE('rm -rf x'), BLOCK, { projectRoot: fixture('gb-norun'), env: {} });
  assert.ok(/no active run/.test(none.reason), none.reason);
  assert.strictEqual(eventsOf(root, 'r-skip').length, before);
});
t('malformed raw stdin or a throwing append never throws', () => {
  assert.strictEqual(OBL.recordGateBlock('{{{', BLOCK, { env: {} }).recorded, false);
  const root = fixture('gb-throw');
  writeRun(root, 'r1', [{ event_type: 'run_started', timestamp: iso(1e3) }]);
  const r = OBL.recordGateBlock(LIVE('rm -rf x'), BLOCK, { projectRoot: root, env: {}, append: () => { throw new Error('disk full'); } });
  assert.strictEqual(r.recorded, false);
  assert.ok(/disk full/.test(r.reason));
});

// ---------------------------------------------------------------------------
console.log('\n7) wiring — .claude/settings.json carries the Stop hook (added through forge-settings-merge.cjs)');
const STOP_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-stop-obligations.cjs"';
t('settings.json has exactly one Stop hook running forge-stop-obligations.cjs, timeout in seconds (1..60)', () => {
  const s = JSON.parse(fs.readFileSync(path.join(REPO_CLAUDE, 'settings.json'), 'utf8'));
  const hits = [];
  for (const e of s.hooks.Stop || []) for (const h of e.hooks || []) if (h.command === STOP_CMD) hits.push(h);
  assert.strictEqual(hits.length, 1, JSON.stringify(s.hooks.Stop));
  assert.ok(hits[0].type === 'command' && Number.isInteger(hits[0].timeout) && hits[0].timeout >= 1 && hits[0].timeout <= 60, JSON.stringify(hits[0]));
});
t('forge-settings-merge check: the real settings.json is up to date against a template holding only this Stop hook', () => {
  const merge = require('./forge-settings-merge.cjs');
  const src = path.join(TMP, 'stop-template.json');
  fs.writeFileSync(src, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: STOP_CMD, timeout: 5 }] }] } }));
  const r = merge.checkSettingsMerge({ target: path.join(REPO_CLAUDE, 'settings.json'), source: src });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
console.log('\n8) I.9 red-contract — a /forge build session may not end its turn over a red run contract (R8B-F3)');
// Fixtures replay the two round 8b category sessions in a temp project: the same run events (written by
// the fixture's own log-event copy, so the hash chain is real and the times are now), the same active-run pointer, the
// same harness subagent and tool-log line shapes. The /forge session marker is created directly (its writer,
// forge-scribe-hook.cjs, is another package): <runs>/_hooks/forge-session/<sha16(session_id)>.json.
const AR = require('./forge-active-run.cjs');
const CHINEES_SID = '0fa521d6-d441-4e7b-8199-a68bf1e01075';
const ANDROID_SID = '0edf26d1-4625-431b-b25e-e425b3f9aa07';
const CHINEES_RUN = 'forge-2026-11-08-034500';
const ANDROID_RUN = 'forge-2026-11-08-android-stackr';
const hooksOf = (root) => path.join(root, '.claude', 'forge-runs', '_hooks');
const sha16 = (sid) => crypto.createHash('sha256').update(sid, 'utf8').digest('hex').slice(0, 16);
function forgeProject(name) {
  const root = fixture(name);
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true }); // a Forge project (no runcontract copy: the sibling is used)
  withRules(root);
  withLogEvent(root);
  return root;
}
function logFixture(root, id, type, payload) {
  // setup only: the round 8b projects accepted these events; strict events off so the fixture needs no agent registry
  const r = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), id, type, JSON.stringify(payload)], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '0' }) });
  assert.strictEqual(r.status, 0, 'fixture ' + type + ' failed: ' + r.stdout + r.stderr);
}
function marker(root, sid, body) {
  const dir = path.join(hooksOf(root), 'forge-session');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sha16(sid) + '.json'), typeof body === 'string' ? body : JSON.stringify(Object.assign({ schema: 1, session_sha: sha16(sid), kind: 'forge-build', created_at: iso(15 * 60e3), prompt_rid: 'R-0001' }, body || {})));
}
function hookLine(root, file, rec) { fs.mkdirSync(hooksOf(root), { recursive: true }); fs.appendFileSync(path.join(hooksOf(root), file), JSON.stringify(rec) + '\n'); }
function toolLine(root, sid, rec) {
  const dir = path.join(root, '.claude', 'forge-runs', '_toollog');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify(Object.assign({ ts: iso(5 * 60e3), session: sid, agent_id: null, agent_type: null, target_kind: 'path', ok: true, ok_basis: 'present', ms: 5 }, rec)) + '\n');
}
/** chineesFixture — round 8b chinees-restaurant-site-v9: an open run (run_started + one agent_note), the pointer, one
 *  ui-boss subagent that started and stopped, the Lead's own tool calls (commands only) and the subagent's writes. */
function chineesFixture(withMarker, rootIn) {
  const root = rootIn || forgeProject('chinees');
  logFixture(root, CHINEES_RUN, 'run_started', { request: 'Jade Paviljoen luxe restaurantsite (menu, reserveren-formulier, locatie/openingstijden, mobile-first, geen foto s)', mode: 'build', project_type: 'website' });
  logFixture(root, CHINEES_RUN, 'agent_note', { agent: 'UI Boss', role: 'site build', runtime: 'agent-tool', status: 'running', task: 'Jade Paviljoen static site build dispatched (opus/medium)' });
  assert.strictEqual(AR.setActiveRun(root, CHINEES_RUN, {}).ok, true);
  hookLine(root, 'subagent-start.jsonl', { ts: iso(9 * 60e3), event: 'SubagentStart', session: CHINEES_SID, agent_id: 'a99237b506479d272', agent_type: 'ui-boss', run: CHINEES_RUN, run_source: 'pointer-fallback' });
  hookLine(root, 'subagent-stop.jsonl', { ts: iso(2 * 60e3), event: 'SubagentStop', session: CHINEES_SID, agent_id: 'a99237b506479d272', agent_type: 'ui-boss', run: CHINEES_RUN, run_source: 'pointer-fallback' });
  toolLine(root, CHINEES_SID, { tool: 'Bash', target: 'node', target_kind: 'command' });
  for (const f of ['site\\data.js', 'site\\index.html', 'site\\styles.css', 'site\\app.js']) toolLine(root, CHINEES_SID, { agent_id: 'a99237b506479d272', agent_type: 'ui-boss', tool: 'Write', target: f });
  if (withMarker) marker(root, CHINEES_SID);
  return root;
}
/** androidFixture — round 8b android-game-v9: the run closed "partial" (written the pre-fix way, before the writer
 *  refused it), a final report, the pointer, the Lead's own 10 Write + 1 Edit app files, one verify-boss subagent. */
function androidFixture(closePayload) {
  const root = forgeProject('android');
  logFixture(root, ANDROID_RUN, 'run_started', { goal: 'Android tap game APK (Stackr)' });
  logFixture(root, ANDROID_RUN, 'check_passed', { command: 'node build.cjs', exit_code: 0, evidence: 'RulesTest ALL PASSED 11/11; apksigner Verifies v2+v3; aapt2 badging package com.forge.stackr target 35; classes.dex in APK' });
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', ANDROID_RUN, 'final-report.md'), '# Stackr\n\nAPK built; not run on a device.\n');
  logFixture(root, ANDROID_RUN, 'run_completed', closePayload || { status: 'partial', note: 'APK built and verified by build/tests/badging; not run on a device; memory/skill-map ceremony skipped' });
  assert.strictEqual(AR.setActiveRun(root, ANDROID_RUN, {}).ok, true);
  for (const f of ['AndroidManifest.xml', 'res\\values\\styles.xml', 'res\\mipmap-anydpi-v26\\ic_launcher.xml', 'res\\drawable\\ic_fg.xml', 'src\\com\\forge\\stackr\\Rules.java', 'test\\com\\forge\\stackr\\RulesTest.java', 'src\\com\\forge\\stackr\\Sfx.java', 'src\\com\\forge\\stackr\\MainActivity.java', 'src\\com\\forge\\stackr\\GameView.java', 'build.cjs']) toolLine(root, ANDROID_SID, { tool: 'Write', target: f });
  toolLine(root, ANDROID_SID, { tool: 'Edit', target: 'build.cjs' });
  hookLine(root, 'subagent-start.jsonl', { ts: iso(6 * 60e3), event: 'SubagentStart', session: ANDROID_SID, agent_id: 'ab8be11a69d2e226a', agent_type: 'verify-boss', run: ANDROID_RUN });
  hookLine(root, 'subagent-stop.jsonl', { ts: iso(5 * 60e3), event: 'SubagentStop', session: ANDROID_SID, agent_id: 'ab8be11a69d2e226a', agent_type: 'verify-boss', run: ANDROID_RUN });
  marker(root, ANDROID_SID);
  return root;
}
const stop9 = (root, sid, payload, env) => OBL.runStop(Object.assign({ hook_event_name: 'Stop', stop_hook_active: false, session_id: sid }, payload || {}), { projectRoot: root, env: env || {} });

t('chinees-v9 (open run, marker, one subagent): BLOCK; the reason names memory-read and the exact plan command', () => {
  const root = chineesFixture(true);
  const r = stop9(root, CHINEES_SID);
  assert.strictEqual(r.block, true, JSON.stringify(r.red_contract));
  assert.strictEqual(r.red_contract.kind, 'open-red');
  const m = r.block_text;
  for (const s of ['memory-read', 'NEXT: node .claude/forge-bin/forge-runcontract.cjs plan --run ' + CHINEES_RUN, 'NOT DONE', 'EN: ', 'NL: ', 'block 1/' + OBL.RED_MAX_BLOCKS, 'FORGE_RED_CONTRACT_STOP=off']) assert.ok(m.includes(s), 'missing "' + s + '" in: ' + m);
  assert.ok(/then: memory-read: /.test(m), 'the first due item follows NEXT: ' + m);
  assert.ok(m.split('\n').every((l) => l.length <= 420), 'every line is bounded');
});
t('android-v9 (run closed "partial" over Lead-doable rules in this session): BLOCK with the open rules and the blocker route', () => {
  const root = androidFixture();
  const r = stop9(root, ANDROID_SID);
  assert.strictEqual(r.block, true, JSON.stringify(r.red_contract));
  assert.strictEqual(r.red_contract.kind, 'failure-close');
  for (const s of ['"partial"', 'memory-read', 'skill-map-recorded', 'blocker', 'NEXT: node .claude/forge-bin/forge-runcontract.cjs plan --run ' + ANDROID_RUN]) assert.ok(r.block_text.includes(s), 'missing "' + s + '" in: ' + r.block_text);
  assert.ok(!/memory-read[^\n]*evidence-satisfied|Lead can do itself[^\n]*evidence-satisfied/.test(r.block_text), 'evidence-satisfied is not listed as Lead-doable: ' + r.block_text);
  assert.ok(/^\(also open, not counted as Lead-doable: [^\n]*evidence-satisfied/m.test(r.block_text), 'the reason lists every open rule; the others on their own line: ' + r.block_text);
});
t('android-v9 closed "failed" WITH a named blocker -> no I.9 block (an honest failure with a real blocker)', () => {
  const root = androidFixture({ status: 'failed', blocker: 'hard gate: install on a device needs the owner' });
  const r = stop9(root, ANDROID_SID);
  assert.strictEqual(r.block, false, r.block_text);
  assert.ok(/blocker/.test(r.red_contract.reason), r.red_contract.reason);
});
t('cap: three blocks per session (also under stop_hook_active), the FOURTH stop does not block and is advisory only', () => {
  const root = chineesFixture(true);
  const got = [stop9(root, CHINEES_SID), stop9(root, CHINEES_SID, { stop_hook_active: true }), stop9(root, CHINEES_SID, { stop_hook_active: true })];
  assert.deepStrictEqual(got.map((r) => r.block), [true, true, true], JSON.stringify(got.map((r) => r.red_contract)));
  assert.ok(got[2].block_text.includes('block 3/3'), got[2].block_text);
  const fourth = stop9(root, CHINEES_SID, { stop_hook_active: true });
  assert.strictEqual(fourth.block, false, JSON.stringify(fourth.red_contract));
  assert.ok(fourth.print && /Advisory only/.test(fourth.text) && /memory-read/.test(fourth.text), fourth.text);
  assert.strictEqual(stop9(root, 'bbbbbbbb-2222-4222-8222-222222222222').block, false, 'another session has no marker: untouched');
});
t('no marker (or an unparsable one, or another kind) -> current behaviour unchanged (same output as with I.9 switched off)', () => {
  for (const body of [null, '{ not json', { kind: 'chat' }, { created_at: 'not a date' }, { session_sha: '0000000000000000' }]) {
    const root = chineesFixture(false);
    if (body !== null) marker(root, CHINEES_SID, body);
    const r = stop9(root, CHINEES_SID);
    assert.strictEqual(r.block, false, JSON.stringify(body) + ' -> ' + r.block_text);
    assert.ok(/no \/forge session marker/.test(r.red_contract.reason), r.red_contract.reason);
    const off = stop9(root, CHINEES_SID, null, { FORGE_RED_CONTRACT_STOP: 'off' });
    assert.deepStrictEqual({ print: r.print, text: r.text, block: r.block }, { print: off.print, text: off.text, block: off.block });
    assert.ok(r.print && /run forge-2026-11-08-034500/.test(r.text) && /\(advisory\)/.test(r.text), 'the advisory obligations still print: ' + r.text);
  }
});
t('break attempts: a SUCCESS claim over the red contract, an outcome:"failed" close, and a cleared pointer all still block', () => {
  const claim = stop9(androidFixture({ summary: 'done' }), ANDROID_SID);
  assert.ok(claim.block && claim.red_contract.kind === 'open-red' && /claims completion/.test(claim.block_text), JSON.stringify(claim.red_contract));
  const outcome = stop9(androidFixture({ outcome: 'failed', note: 'gave up' }), ANDROID_SID);
  assert.ok(outcome.block && outcome.red_contract.kind === 'failure-close' && /"failed"/.test(outcome.block_text), JSON.stringify(outcome.red_contract));
  const root = chineesFixture(true);
  assert.strictEqual(AR.clearActiveRun(root, {}).ok, true);
  const cleared = stop9(root, CHINEES_SID);
  assert.ok(cleared.block && cleared.red_contract.run_id === CHINEES_RUN, JSON.stringify(cleared.red_contract));
});
t('an open run while this session still has a running subagent -> no I.9 block (the work is in progress; I.8 owns waiting)', () => {
  const root = chineesFixture(true);
  hookLine(root, 'subagent-start.jsonl', { ts: iso(60e3), event: 'SubagentStart', session: CHINEES_SID, agent_id: 'a-still-running', agent_type: 'test-boss', run: CHINEES_RUN });
  const r = stop9(root, CHINEES_SID);
  assert.strictEqual(r.block, false, r.block_text);
  assert.ok(/still running/.test(r.red_contract.reason), r.red_contract.reason);
  hookLine(root, 'subagent-stop.jsonl', { ts: iso(10e3), event: 'SubagentStop', session: CHINEES_SID, agent_id: 'a-still-running', agent_type: 'test-boss', run: CHINEES_RUN });
  assert.strictEqual(stop9(root, CHINEES_SID).block, true, 'once it stopped, the red contract blocks again');
});
t('FORGE_RED_CONTRACT_STOP=off, a finalized-or-green run, a missing checker and a throwing plan -> no I.9 block (fail-open)', () => {
  const root = chineesFixture(true);
  assert.strictEqual(stop9(root, CHINEES_SID, null, { FORGE_RED_CONTRACT_STOP: 'off' }).block, false);
  const green = { planFor: (p) => ({ run_id: p.run_id, state: { status: 'working', phase: 'wp' }, contract: { ok: true, missing: [], warnings: [] }, obligations: [], next: { text: 'x' } }) };
  const thrower = { planFor: () => { throw new Error('events log is CORRUPT'); } };
  for (const rc of [green, null, thrower]) {
    const r = OBL.runStop({ session_id: CHINEES_SID, stop_hook_active: false }, { projectRoot: chineesFixture(true), env: {}, runcontract: rc });
    assert.strictEqual(r.block, false, JSON.stringify(r.red_contract));
  }
});
t('(iii) the Lead wrote app files in a /forge session but there is no run -> BLOCK with the run_started command; .claude/, .forge/ and _scratch/ writes do not count', () => {
  const root = forgeProject('norun');
  marker(root, ANDROID_SID);
  for (const f of ['.claude\\FORGE_MEMORY.md', '_scratch\\probe.js', '.forge\\x.json']) toolLine(root, ANDROID_SID, { tool: 'Write', target: f });
  toolLine(root, ANDROID_SID, { tool: 'Write', target: 'C:\\elsewhere\\outside.txt' });
  toolLine(root, ANDROID_SID, { agent_id: 'sub1', agent_type: 'build-boss', tool: 'Write', target: 'src\\a.js' });
  assert.strictEqual(stop9(root, ANDROID_SID).block, false, 'only non-app or subagent writes: no block');
  toolLine(root, ANDROID_SID, { tool: 'Write', target: 'AndroidManifest.xml' });
  toolLine(root, ANDROID_SID, { tool: 'Edit', target: 'src\\com\\forge\\stackr\\Rules.java' });
  const r = stop9(root, ANDROID_SID);
  assert.strictEqual(r.block, true, JSON.stringify(r.red_contract));
  assert.strictEqual(r.red_contract.kind, 'no-run');
  for (const s of ['2 app file', 'AndroidManifest.xml', 'run_started', 'forge-active-run.cjs set <run_id> --session ' + ANDROID_SID, 'NEXT: node .claude/forge-bin/forge-runcontract.cjs plan --run <run_id>']) assert.ok(r.block_text.includes(s), 'missing "' + s + '" in: ' + r.block_text);
});
t('CLI: the I.9 reason reaches the model as {"decision":"block","reason"} (exit 0)', () => {
  const root = chineesFixture(true);
  const r = spawnStop(root, { session_id: CHINEES_SID, hook_event_name: 'Stop', stop_hook_active: false }, { FORGE_RED_CONTRACT_STOP: '', FORGE_OPEN_SUBAGENTS_STOP: 'off', FORGE_RUN_REQUIRED_STOP: 'off' });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim());
  assert.strictEqual(j.decision, 'block', r.stdout);
  assert.ok(/memory-read/.test(j.reason) && /forge-runcontract\.cjs plan --run forge-2026-11-08-034500/.test(j.reason), j.reason);
});
t('the REAL marker writer (forge-scribe-hook.cjs runPrompt on a /forge build prompt) and I.9 agree on the marker path, key and shape', () => {
  const SH = require('./forge-scribe-hook.cjs');
  assert.strictEqual(SH.sessionKey(CHINEES_SID), sha16(CHINEES_SID), 'the writer keys the marker by sha256(session_id)[:16]');
  const root = forgeProject('chinees-e2e');
  fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'forge-start.cjs'), '// placeholder: the prompt hook only checks that the tool is installed\n');
  // the /forge prompt comes BEFORE the run exists (the writer skips a session that already has an active run)
  const p = SH.runPrompt({ hook_event_name: 'UserPromptSubmit', session_id: CHINEES_SID, prompt: '/forge Jade Paviljoen luxe restaurantsite, mobile-first' }, { projectRoot: root, env: {}, now: () => new Date(Date.now() - 15 * 60e3) });
  assert.ok(p.forge_start && p.forge_start.marker_written === true, 'the writer wrote no marker: ' + JSON.stringify(p.forge_start || p.reason));
  assert.ok(OBL.readSessionMarker([path.join(root, '.claude', 'forge-runs')], CHINEES_SID), 'I.9 reads the marker the writer wrote');
  chineesFixture(false, root);
  const r = stop9(root, CHINEES_SID);
  assert.strictEqual(r.block, true, JSON.stringify(r.red_contract));
  assert.strictEqual(r.red_contract.kind, 'open-red');
});
t('source hygiene: forge-stop-obligations.cjs holds no invisible format character (a raw BOM pasted into a regex literal looks like the escape but is not)', () => {
  const INVISIBLE = [0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff];
  const hits = [];
  fs.readFileSync(CLI, 'utf8').split('\n').forEach((line, i) => { for (const cp of INVISIBLE) if (line.includes(String.fromCharCode(cp))) hits.push('line ' + (i + 1) + ' U+' + cp.toString(16).toUpperCase().padStart(4, '0')); });
  assert.deepStrictEqual(hits, [], 'write these as escape sequences, never as raw characters: ' + hits.join(', '));
});

// FB-CONTRACT-1-F3: PowerShell 5.1 strips the double quotes from inline single-quoted JSON, so every
// printed log-event command with inline JSON must also name the shell-safe --file route on the same line.
t('the run-required block text names the --file route on every line with inline JSON', () => {
  const bad = OBL.runRequiredMessage(5, Date.parse('2026-11-12T10:00:00Z')).split('\n').filter((l) => l.includes("'{") && !l.includes('--file'));
  assert.deepStrictEqual(bad, []);
});
t('source: every printed inline-JSON log-event command in forge-stop-obligations.cjs names --file on the same line', () => {
  const bad = fs.readFileSync(CLI, 'utf8').split('\n').filter((l) => /log-event\.cjs/.test(l) && l.includes("\\'{") && !l.includes('--file'));
  assert.deepStrictEqual(bad, []);
});

// FB-CONTRACT-1-F5: with two sessions in one project, a gate block and the Stop advisory used "the
// newest open run in the project" and so landed in the OTHER session's run. The session's own pointer decides first.
function twoSessionProject() {
  const root = fixture('two-sess');
  writeRun(root, 'r-mine', [{ event_type: 'run_started', timestamp: iso(20 * 60e3) }], { mtimeMsAgo: 20 * 60e3 });
  writeRun(root, 'r-theirs', [{ event_type: 'run_started', timestamp: iso(60e3) }], { mtimeMsAgo: 60e3 });
  assert.strictEqual(AR.setActiveRun(root, 'r-mine', { session: 'sess-1' }).ok, true);
  assert.strictEqual(AR.setActiveRun(root, 'r-theirs', { session: 'sess-2' }).ok, true);
  return root;
}
t('a gate block is recorded in the session\'s own run (its pointer), not in the newest open run of the project', () => {
  const root = twoSessionProject();
  const seen = [];
  const r = OBL.recordGateBlock(LIVE('rm -rf x'), BLOCK, { projectRoot: root, env: {}, append: (rt, runId) => { seen.push(runId); return { ok: true }; } });
  assert.strictEqual(r.recorded, true, r.reason);
  assert.deepStrictEqual(seen, ['r-mine']);
});
t('the Stop advisory judges the session\'s own run, not the newest open run of the project', () => {
  const root = twoSessionProject();
  const r = OBL.runStop({ session_id: 'sess-1', transcript_path: 'C:/x/t.jsonl', hook_event_name: 'Stop' }, { projectRoot: root, env: {}, runcontract: null });
  assert.strictEqual(r.run_id, 'r-mine', JSON.stringify(r));
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
