#!/usr/bin/env node
'use strict';
// forge-stop-obligations-norun.test.cjs — I.7 (Forge modernization, Phase I): the Stop-time check that
// blocks ONCE per session when a multi-agent session (>= 3 finished subagents in the harness-written
// <runs>/_hooks/subagent-stop.jsonl) never started or updated a mission run. HERMETIC: every fixture is a fresh
// os.tmpdir() project; nothing reads or writes this repo's real .claude/forge-runs. Mutants are written to the temp
// folder (with a copy of forge-paths.cjs) and must each flip a guarded outcome.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const OBL = require('./forge-stop-obligations.cjs');

delete process.env.FORGE_STATE_DIR; // a developer's override must not flip the fixture layout
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
}

const CLI = path.join(__dirname, 'forge-stop-obligations.cjs');
const SRC = fs.readFileSync(CLI, 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fso-norun-'));
const SID = '9ed27d95-0000-4000-8000-00000000test';
const OTHER = 'aaaaaaaa-1111-4111-8111-111111111111';
const BASE = Date.now() - 30 * 60e3;   // the first subagent stop of a fixture session: 30 minutes ago
const MIN = 60e3, HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;

/** proj(name, layout) — 'legacy' (.claude/forge-bin + .claude/forge-runs), 'forge' (.forge/runs only),
 *  'plain' (.claude/forge-runs but NO forge-bin and NO .forge: not a Forge project). */
function proj(name, layout) {
  const root = path.join(TMP, name + '-' + (++seq));
  if (layout === 'forge') fs.mkdirSync(path.join(root, '.forge', 'runs'), { recursive: true });
  else {
    fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
    if (layout !== 'plain') fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  }
  return root;
}
const legacyRuns = (root) => path.join(root, '.claude', 'forge-runs');
const runsOf = (root) => (fs.existsSync(path.join(root, '.forge')) ? path.join(root, '.forge', 'runs') : legacyRuns(root));
/** addStops(root, sid, n, o) — n real-shaped SubagentStop lines (distinct agent_ids), one minute apart from o.start. */
function addStops(root, sid, n, o) {
  o = o || {};
  const dir = path.join(o.runsDir || runsOf(root), '_hooks');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i++) {
    const rec = { ts: iso((o.start || BASE) + (i + (o.offset || 0)) * MIN), event: 'SubagentStop', session: sid, agent_id: o.sameId ? 'a-same' : (o.prefix || 'a') + (i + (o.offset || 0)), agent_type: o.type === undefined ? null : o.type };
    if (o.noId) rec.agent_id = null;
    if (o.run) rec.run = o.run;
    lines.push(JSON.stringify(rec));
  }
  fs.appendFileSync(path.join(dir, o.file || 'subagent-stop.jsonl'), lines.join('\n') + '\n');
}
/** addRun(root, id, events, o) — events [{type, ms, ...}] into <runs>/<id>/events.jsonl. */
function addRun(root, id, events, o) {
  o = o || {};
  const dir = path.join(o.runsDir || runsOf(root), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(Object.assign({ run_id: id, event_type: e.type, timestamp: iso(e.ms), agent: 'lead' }, e.extra || {}))).join('\n') + '\n');
  if (o.runJson) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run_id: id }));
  if (o.finalized) fs.writeFileSync(path.join(dir, 'run-finalized.json'), '{}');
  return dir;
}
function addToolLog(root, sid, ms) {
  const dir = path.join(runsOf(root), '_toollog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ ts: iso(ms), session: sid, tool: 'Bash', target: 'node', ok: true }) + '\n');
}
const markerDir = (root) => path.join(runsOf(root), '_hooks', OBL.NORUN_STATE_DIR);
const markers = (root) => { try { return fs.readdirSync(markerDir(root)); } catch { return []; } };
/** stop(root, payload, opts, mod) — runStop with no checker / no scribe store (the obligations and repeat parts stay
 *  quiet), env {} unless given. */
function stop(root, payload, opts, mod) {
  return (mod || OBL).runStop(Object.assign({ hook_event_name: 'Stop', stop_hook_active: false, session_id: SID }, payload || {}),
    Object.assign({ projectRoot: root, env: {}, runcontract: null, scribeStore: null, now: Date.parse('2026-10-24T12:00:00.000Z') }, opts || {}));
}
function spawnStop(root, input, extraEnv) {
  const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root });
  for (const k of ['FORGE_STOP_OBLIGATIONS', 'FORGE_RUN_REQUIRED_STOP', 'FORGE_RUN_ID', 'FORGE_STATE_DIR']) delete env[k];
  Object.assign(env, extraEnv || {});
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env, timeout: 15000 });
  r.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return r;
}

console.log('forge-stop-obligations I.7 run-required tests');

// ---------------------------------------------------------------------------
console.log('\n1) threshold and counting');
t('fires at 3 distinct subagents without a run; the message names the count and the EXACT next commands (NL + EN)', () => {
  const root = proj('fire');
  addStops(root, SID, 3);
  const r = stop(root);
  assert.strictEqual(r.block, true, JSON.stringify(r));
  assert.strictEqual(r.print, false, 'no obligations / repeats in this fixture');
  assert.strictEqual(r.norun.subagents, 3);
  const m = r.block_text;
  for (const s of [
    '3 subagents finished in this session',
    "node .claude/forge-dashboard/log-event.cjs <run_id> run_started '{\"agent\":\"lead\"",
    "node .claude/forge-dashboard/log-event.cjs <run_id> agent_work_package_created '{\"agent\":\"<boss>\",\"wp_id\":\"WP-1\"",
    'node .claude/forge-bin/forge-runcontract.cjs plan --run <run_id>',
    '"retro":true', 'never back-date', 'nooit terugdateren', 'run-finalized.json', 'Mission ledger',
    'EN: ', 'NL: ', 'forge-2026-10-24-<short-name>', 'once per session', 'FORGE_RUN_REQUIRED_STOP=off',
  ]) assert.ok(m.includes(s), 'missing "' + s + '" in:\n' + m);
  assert.ok(m.split('\n').length <= 8 && m.length <= 1400, 'short: ' + m.split('\n').length + ' lines, ' + m.length + ' chars');
});
t('does not fire at 2; the reason names the threshold', () => {
  const root = proj('two');
  addStops(root, SID, 2);
  const r = stop(root);
  assert.strictEqual(r.block, false);
  assert.ok(/2 counted subagent\(s\).*threshold 3/.test(r.norun.reason), r.norun.reason);
  assert.deepStrictEqual(markers(root), []);
});
t('the same agent_id three times counts once; lines without an agent_id are not counted', () => {
  const root = proj('dupes');
  addStops(root, SID, 3, { sameId: true });
  addStops(root, SID, 4, { noId: true, offset: 10 });
  assert.strictEqual(stop(root).block, false);
});
t('only THIS session counts: other sessions and the "unknown-session" bucket never add up', () => {
  const root = proj('sessions');
  addStops(root, SID, 2);
  addStops(root, OTHER, 5, { prefix: 'o' });
  addStops(root, 'unknown-session', 5, { prefix: 'u' });
  assert.strictEqual(stop(root).block, false, 'SID has 2');
  assert.strictEqual(stop(root, { session_id: OTHER }).block, true, 'OTHER has 5');
  assert.strictEqual(stop(root, { session_id: 'unknown-session' }).block, false, 'the shared bucket never fires');
  for (const bad of ['', '../x', 'a b', 'x'.repeat(65), 42, null]) assert.strictEqual(stop(root, { session_id: bad }).block, false, JSON.stringify(bad));
});
t('pure research types (Explore, Plan, claude-code-guide) are excluded; general-purpose and unlabelled (Workflow) agents count', () => {
  const root = proj('types');
  addStops(root, SID, 3, { type: 'Explore', prefix: 'e' });
  addStops(root, SID, 3, { type: 'Plan', prefix: 'p', offset: 3 });
  addStops(root, SID, 3, { type: 'claude-code-guide', prefix: 'g', offset: 6 });
  addStops(root, SID, 2, { type: 'deep', prefix: 'd', offset: 9 });
  assert.strictEqual(stop(root).block, false, 'only 2 counted');
  assert.deepStrictEqual(Array.from(OBL.NORUN_EXCLUDED_TYPES).sort(), ['Explore', 'Plan', 'claude-code-guide']);
  const gp = proj('types-gp');
  addStops(gp, SID, 3, { type: 'general-purpose' });
  assert.strictEqual(stop(gp).block, true, 'general-purpose research is NOT excluded');
  const wf = proj('types-null');
  addStops(wf, SID, 3); // agent_type null, like Workflow agents in the real log
  assert.strictEqual(stop(wf).block, true);
});
t('both log generations are read (subagent-stop.1.jsonl holds the older half after a rotation)', () => {
  const root = proj('rotated');
  addStops(root, SID, 2, { file: 'subagent-stop.1.jsonl' });
  addStops(root, SID, 1, { offset: 5 });
  assert.strictEqual(stop(root).block, true);
});

// ---------------------------------------------------------------------------
console.log('\n2) what counts as "a run of this session"');
t('a run_started after the first subagent stop silences it (reason names the run)', () => {
  const root = proj('started');
  addStops(root, SID, 5);
  addRun(root, 'forge-2026-10-24-x', [{ type: 'run_started', ms: BASE + 2 * MIN }]);
  const r = stop(root);
  assert.strictEqual(r.block, false);
  assert.ok(/forge-2026-10-24-x/.test(r.norun.reason), r.norun.reason);
});
t('an older genuine run that gets ANY event during the session counts (it was touched)', () => {
  const root = proj('touched');
  addStops(root, SID, 5);
  addRun(root, 'old-run', [{ type: 'run_started', ms: BASE - 30 * HOUR }, { type: 'agent_note', ms: BASE + 4 * MIN }]);
  assert.strictEqual(stop(root).block, false);
});
t('a run whose every event is from before the session window does not count -> fires', () => {
  const root = proj('stale');
  addStops(root, SID, 5);
  addRun(root, 'stale-run', [{ type: 'run_started', ms: BASE - 20 * HOUR }, { type: 'wp_completed', ms: BASE - 19 * HOUR }]);
  assert.strictEqual(stop(root).block, true);
});
t('a receipt-only folder (no run_started, no run.json) touched now does not count; run.json alone makes a run genuine', () => {
  const root = proj('receipt');
  addStops(root, SID, 5);
  addRun(root, 'doctor-receipt', [{ type: 'doctor_run', ms: BASE + MIN }]);
  assert.strictEqual(stop(root).block, true, 'a doctor receipt is not a mission run');
  const root2 = proj('runjson');
  addStops(root2, SID, 5);
  addRun(root2, 'legacy-run', [{ type: 'agent_note', ms: BASE + MIN }], { runJson: true });
  assert.strictEqual(stop(root2).block, false);
});
t('a run finalized during the session still counts (the session did keep a ledger)', () => {
  const root = proj('finalized');
  addStops(root, SID, 5);
  addRun(root, 'done-run', [{ type: 'run_started', ms: BASE - 10 * MIN }, { type: 'run_completed', ms: BASE + 3 * MIN }], { finalized: true });
  assert.strictEqual(stop(root).block, false);
});
t('PLAN FIRST (the rule itself): run_started + work packages 30 min BEFORE the first stop, nothing after -> silent', () => {
  const root = proj('planfirst');
  addStops(root, SID, 5);
  addRun(root, 'planned', [{ type: 'run_started', ms: BASE - 30 * MIN }, { type: 'agent_work_package_created', ms: BASE - 29 * MIN, extra: { wp_id: 'WP-1' } }]);
  assert.strictEqual(stop(root).block, false);
  assert.ok(OBL.NORUN_LOOKBACK_MS >= 30 * MIN);
});
t('a run minted 3 h before the first stop is covered through the session\'s own tool-log start; without that log it fires (pinned limit)', () => {
  const root = proj('toollog');
  addStops(root, SID, 5);
  addRun(root, 'long-first-agent', [{ type: 'run_started', ms: BASE - 3 * HOUR }]);
  addToolLog(root, SID, BASE - 3 * HOUR - 10 * MIN);
  assert.strictEqual(stop(root).block, false, 'session start known from the tool log');
  const root2 = proj('toollog-none');
  addStops(root2, SID, 5);
  addRun(root2, 'long-first-agent', [{ type: 'run_started', ms: BASE - 3 * HOUR }]);
  assert.strictEqual(stop(root2).block, true, 'no tool log: window = first stop - 1 h (documented limit)');
  const root3 = proj('toollog-other');
  addStops(root3, SID, 5);
  addRun(root3, 'long-first-agent', [{ type: 'run_started', ms: BASE - 3 * HOUR }]);
  addToolLog(root3, OTHER, BASE - 4 * HOUR);
  assert.strictEqual(stop(root3).block, true, 'another session\'s tool log is never used');
});
t('FORGE_RUN_ID naming an existing run folder silences it; a missing folder or a non-run name does not', () => {
  const root = proj('envrun');
  addStops(root, SID, 5);
  fs.mkdirSync(path.join(legacyRuns(root), 'forge-env-run'));
  assert.strictEqual(stop(root, {}, { env: { FORGE_RUN_ID: 'forge-env-run' } }).block, false);
  assert.strictEqual(stop(root, {}, { env: { FORGE_RUN_ID: 'forge-missing' } }).block, true);
  const root2 = proj('envrun-hooks');
  addStops(root2, SID, 5);
  assert.strictEqual(stop(root2, {}, { env: { FORGE_RUN_ID: '_hooks' } }).block, true, '_hooks is not a run');
});
t('a stop line carrying `run` (FORGE_RUN_ID at subagent time) whose folder exists silences it', () => {
  const root = proj('linerun');
  fs.mkdirSync(path.join(legacyRuns(root), 'forge-line-run'));
  addStops(root, SID, 5, { run: 'forge-line-run' });
  assert.strictEqual(stop(root).block, false);
});

// ---------------------------------------------------------------------------
console.log('\n3) once per session, stop_hook_active, opt-outs, non-Forge projects');
t('ONCE per session: the second stop is silent; the marker is a hashed file name that never holds the session id', () => {
  const root = proj('once');
  addStops(root, SID, 4);
  assert.strictEqual(stop(root).block, true);
  const r2 = stop(root);
  assert.strictEqual(r2.block, false);
  assert.ok(/already reminded once/.test(r2.norun.reason), r2.norun.reason);
  const m = markers(root);
  assert.strictEqual(m.length, 1);
  assert.ok(/^[0-9a-f]{24}\.json$/.test(m[0]), m[0]);
  assert.ok(!fs.readFileSync(path.join(markerDir(root), m[0]), 'utf8').includes(SID), 'the session id is not stored');
  addStops(root, OTHER, 3, { prefix: 'o' });
  assert.strictEqual(stop(root, { session_id: OTHER }).block, true, 'another session gets its own one reminder');
});
t('stop_hook_active:true -> silent and NOTHING recorded (the one reminder is not used up)', () => {
  const root = proj('sha');
  addStops(root, SID, 4);
  const r = stop(root, { stop_hook_active: true });
  assert.strictEqual(r.block, false);
  assert.deepStrictEqual(markers(root), []);
  assert.strictEqual(stop(root).block, true, 'the next normal stop still reminds');
});
t('opt-outs: FORGE_RUN_REQUIRED_STOP=off|false|0 and FORGE_STOP_OBLIGATIONS=off -> silent, nothing recorded', () => {
  const root = proj('optout');
  addStops(root, SID, 4);
  for (const env of [{ FORGE_RUN_REQUIRED_STOP: 'off' }, { FORGE_RUN_REQUIRED_STOP: 'false' }, { FORGE_RUN_REQUIRED_STOP: '0' }, { FORGE_STOP_OBLIGATIONS: 'off' }]) {
    assert.strictEqual(stop(root, {}, { env }).block, false, JSON.stringify(env));
  }
  assert.deepStrictEqual(markers(root), []);
});
t('not a Forge project (.claude without forge-bin, no .forge) -> silent even with many subagents', () => {
  const root = proj('plain', 'plain');
  addStops(root, SID, 6);
  const r = stop(root);
  assert.strictEqual(r.block, false);
  assert.ok(/not a Forge project/.test(r.norun.reason), r.norun.reason);
  assert.ok(!fs.existsSync(path.join(legacyRuns(root), '_hooks', OBL.NORUN_STATE_DIR)));
});
t('.forge layout: the log in .forge/runs/_hooks fires, the marker lands in .forge/runs, no .claude tree is created; a run there silences', () => {
  const root = proj('flayout', 'forge');
  addStops(root, SID, 3);
  assert.strictEqual(stop(root).block, true);
  assert.strictEqual(markers(root).length, 1);
  assert.ok(markerDir(root).startsWith(path.join(root, '.forge', 'runs')) && !fs.existsSync(path.join(root, '.claude')));
  const root2 = proj('flayout-run', 'forge');
  addStops(root2, SID, 3);
  addRun(root2, 'forge-run', [{ type: 'run_started', ms: BASE + MIN }]);
  assert.strictEqual(stop(root2).block, false);
});
t('partial migration: stops in the legacy log + a run in .forge/runs -> silent; stops in legacy only, no run -> fires', () => {
  const root = proj('mixed', 'forge');
  addStops(root, SID, 3, { runsDir: legacyRuns(root) });
  addRun(root, 'new-layout-run', [{ type: 'run_started', ms: BASE + MIN }]);
  assert.strictEqual(stop(root).block, false);
  const root2 = proj('mixed-norun', 'forge');
  addStops(root2, SID, 3, { runsDir: legacyRuns(root2) });
  assert.strictEqual(stop(root2).block, true);
});

// ---------------------------------------------------------------------------
console.log('\n4) fail-open');
t('missing / unreadable / garbage inputs never block and never throw', () => {
  assert.strictEqual(stop(proj('nohooks')).block, false, 'no _hooks folder');
  const dirlog = proj('dirlog');
  fs.mkdirSync(path.join(legacyRuns(dirlog), '_hooks', 'subagent-stop.jsonl'), { recursive: true });
  assert.strictEqual(stop(dirlog).block, false, 'the log path is a folder');
  for (const p of [null, [], 'text', 7]) {
    const r = OBL.runStop(p, { projectRoot: dirlog, env: {}, runcontract: null, scribeStore: null });
    assert.strictEqual(r.block, false, JSON.stringify(p));
  }
  assert.strictEqual(OBL.evaluateRunRequired({ session_id: SID }, null, { env: {} }).fire, false, 'no root');
  const garbage = proj('garbage');
  addStops(garbage, SID, 3);
  fs.appendFileSync(path.join(legacyRuns(garbage), '_hooks', 'subagent-stop.jsonl'), '{ not json ' + SID + '\n\u0000\u0001\n[1,2]\n{"session":"' + SID + '","ts":"never","agent_id":"zz"}\n');
  assert.strictEqual(stop(garbage).block, true, 'garbage lines are skipped, the 3 good ones still count');
});
t('the once-marker cannot be written (a FILE where its folder should be) -> no block, honest reason', () => {
  const root = proj('nomarker');
  addStops(root, SID, 4);
  fs.writeFileSync(path.join(legacyRuns(root), '_hooks', OBL.NORUN_STATE_DIR), 'not a folder');
  const r = stop(root);
  assert.strictEqual(r.block, false);
  assert.ok(/once-marker not written/.test(r.norun.reason), r.norun.reason);
});
t('an active run from ANOTHER session (outside the window) with obligations due: block AND systemMessage in one result', () => {
  const root = proj('combined');
  addStops(root, SID, 3);
  addRun(root, 'other-session-run', [{ type: 'run_started', ms: BASE - 5 * HOUR }]);
  const fakeRc = { planFor: (p) => ({ run_id: p.run_id, state: { status: 'working', phase: 'wp' }, contract: { ok: false, missing: ['x'] }, obligations: [{ id: 'memory-read', due: 'overdue', severity: 'block', how: 'read memory' }], next: { text: 'next' } }) };
  const r = stop(root, {}, { runcontract: fakeRc });
  assert.ok(r.block && r.print && /other-session-run/.test(r.text) && /No mission run/.test(r.block_text), JSON.stringify(r));
});

// ---------------------------------------------------------------------------
console.log('\n5) never reads transcripts, prompts or message text');
t('a payload carrying transcript_path / last_assistant_message / prompt: no fs call touches the transcript, no canary in the output', () => {
  const root = proj('privacy');
  addStops(root, SID, 3);
  const canary = 'CANARY-' + Math.random().toString(36).slice(2);
  const transcript = path.join(TMP, 'transcript-' + seq + '.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ message: canary }) + '\n');
  const names = ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'accessSync', 'createReadStream', 'readFile', 'open', 'stat'];
  const orig = {}; const seen = [];
  for (const n of names) { orig[n] = fs[n]; fs[n] = function spy(p) { seen.push(String(p)); return orig[n].apply(fs, arguments); }; }
  let r;
  try { r = stop(root, { transcript_path: transcript, last_assistant_message: canary, prompt: canary }); }
  finally { for (const n of names) fs[n] = orig[n]; }
  assert.strictEqual(r.block, true);
  assert.ok(seen.length > 0, 'the spy saw the hook\'s own reads');
  assert.ok(!seen.some((p) => path.resolve(p) === path.resolve(transcript) || p.includes('transcript-')), 'transcript touched: ' + seen.filter((p) => p.includes('transcript')).join(', '));
  assert.ok(!JSON.stringify(r).includes(canary), 'canary leaked into the result');
  assert.ok(!fs.readdirSync(markerDir(root)).some((f) => fs.readFileSync(path.join(markerDir(root), f), 'utf8').includes(canary)));
});
const I7 = (() => { const a = SRC.indexOf('// ---- I.7 run-required'); const b = SRC.indexOf('// ---- end I.7 run-required'); return a >= 0 && b > a ? SRC.slice(a, b) : ''; })();
t('static: the I.7 section never names transcript / last_assistant_message / prompt and adds no own-folder (__dirname) root signal', () => {
  assert.ok(I7.length > 2000, 'section markers found');
  const code = I7.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // whole-line comments may explain the rule
  assert.ok(!/transcript|last_assistant_message|prompt/i.test(code), 'forbidden token in the I.7 code');
  assert.ok(!/__dirname/.test(I7), 'no __dirname in the I.7 section (plugin path scan, migration-C E3)');
});

// ---------------------------------------------------------------------------
console.log('\n6) CLI (spawned Stop hook, CLAUDE_PROJECT_DIR = fixture)');
t('blocking case -> exit 0, ONE JSON object {decision:"block", reason}; the next spawn of the same session prints nothing', () => {
  const root = proj('cli');
  addStops(root, SID, 3);
  const r = spawnStop(root, { session_id: SID, hook_event_name: 'Stop', stop_hook_active: false });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(Object.keys(j), ['decision', 'reason']);
  assert.ok(j.decision === 'block' && /forge-runcontract\.cjs plan --run <run_id>/.test(j.reason), r.stdout);
  assert.strictEqual(r.stderr, '');
  const again = spawnStop(root, { session_id: SID, hook_event_name: 'Stop', stop_hook_active: false });
  assert.strictEqual(again.status, 0);
  assert.strictEqual(again.stdout, '', 'once per session: ' + again.stdout);
});
t('garbage stdin / stop_hook_active / opt-out / non-Forge project -> exit 0 and NO output', () => {
  const root = proj('cli-quiet');
  addStops(root, SID, 3);
  const plain = proj('cli-plain', 'plain');
  addStops(plain, SID, 3);
  for (const [r0, input, env] of [
    [root, 'not json {{{', null], [root, '', null], [root, { session_id: SID, stop_hook_active: true }, null],
    [root, { session_id: SID }, { FORGE_RUN_REQUIRED_STOP: 'off' }], [plain, { session_id: SID }, null],
  ]) {
    const r = spawnStop(r0, input, env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'unexpected stdout: ' + r.stdout);
  }
  assert.deepStrictEqual(markers(root), [], 'nothing recorded by the quiet calls');
});
t('LATENCY: 1000-line log + 20 run folders, spawned (node boot included) — measured; generous bound only', () => {
  const root = proj('latency');
  addStops(root, SID, 600);
  addStops(root, OTHER, 400, { prefix: 'o' });
  for (let i = 0; i < 20; i++) addRun(root, 'old-' + i, [{ type: 'run_started', ms: BASE - (30 + i) * HOUR }]);
  // closed (run_completed), so the obligations part stays quiet; it still counts as touched in this session
  addRun(root, 'live', [{ type: 'run_started', ms: BASE + MIN }, { type: 'run_completed', ms: BASE + 2 * MIN }]);
  const times = [];
  for (let i = 0; i < 3; i++) { const r = spawnStop(root, { session_id: SID }); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); times.push(r.ms); }
  times.sort((a, b) => a - b);
  const t0 = Date.now(); OBL.evaluateRunRequired({ session_id: SID }, root, { env: {} }); const inproc = Date.now() - t0;
  console.log('       spawned ms (sorted): ' + times.map((x) => x.toFixed(0)).join(', ') + ' · in-process evaluate ' + inproc + ' ms');
  assert.ok(times[0] < 5000 && inproc < 900, 'fastest ' + times[0].toFixed(0) + ' ms, in-process ' + inproc + ' ms');
});

// ---------------------------------------------------------------------------
console.log('\n7) mutants (each must flip a guarded outcome)');
function mutant(name, marker) {
  const lines = SRC.split('\n');
  const hits = lines.filter((l) => l.includes(marker)).length;
  const dir = path.join(TMP, 'mut-' + name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'forge-stop-obligations.cjs'), lines.filter((l) => !l.includes(marker)).join('\n'));
  fs.copyFileSync(path.join(__dirname, 'forge-paths.cjs'), path.join(dir, 'forge-paths.cjs'));
  return { hits, mod: require(path.join(dir, 'forge-stop-obligations.cjs')) };
}
t('m1 threshold removed -> the "does not fire at 2" guard is violated (mutant killed)', () => {
  const m = mutant('no-threshold', '// NORUN-THRESHOLD');
  assert.strictEqual(m.hits, 1, 'the marker sits on exactly one line');
  const root = proj('m1');
  addStops(root, SID, 2);
  assert.strictEqual(stop(root).block, false, 'real code: silent at 2');
  assert.strictEqual(stop(proj('m1b'), {}, {}, m.mod).block, false, 'sanity: no log, no block');
  const root2 = proj('m1c');
  addStops(root2, SID, 2);
  assert.strictEqual(stop(root2, {}, {}, m.mod).block, true, 'mutant fires at 2');
});
t('m2 one-shot marker removed -> the second stop blocks again (mutant killed)', () => {
  const m = mutant('no-oneshot', '// NORUN-ONESHOT');
  assert.strictEqual(m.hits, 1, 'the marker sits on exactly one line');
  const root = proj('m2');
  addStops(root, SID, 3);
  assert.strictEqual(stop(root, {}, {}, m.mod).block, true);
  assert.strictEqual(stop(root, {}, {}, m.mod).block, true, 'mutant blocks twice');
  const real = proj('m2-real');
  addStops(real, SID, 3);
  assert.ok(stop(real).block && !stop(real).block, 'real code: once');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
