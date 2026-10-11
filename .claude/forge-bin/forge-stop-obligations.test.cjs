#!/usr/bin/env node
'use strict';
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

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
