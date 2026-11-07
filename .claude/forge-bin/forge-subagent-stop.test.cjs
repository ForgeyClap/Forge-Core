#!/usr/bin/env node
'use strict';
/**
 * forge-subagent-stop.test.cjs — the SubagentStop hook (plan item 1.6). Throwaway roots only. Covers: payload
 * parsing into { ts, event, session, agent_id, agent_type, run? }, that NO message content (last_assistant_message,
 * transcript paths) ever reaches disk, secret scrubbing on disk, fail-open on garbage stdin through the real CLI
 * (exit 0, empty stdout — a SubagentStop hook must never block a subagent), opt-out, salvage of a cut payload,
 * rotation, and a runtime well under 5 s. E (WP A2): the run comes from the forge-active-run.cjs pointer
 * (own session only, never stale), env still wins, and salvage reads ids written with whitespace. Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SS = require('./forge-subagent-stop.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const roots = [];
const mkRoot = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ss-')); fs.mkdirSync(path.join(r, '.claude')); roots.push(r); return r; };
const SCRIPT = path.join(__dirname, 'forge-subagent-stop.cjs');
const cli = (root, input, extraEnv) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', timeout: 10000,
  env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root, FORGE_SUBAGENT_STOP_HOOK: '', FORGE_RUN_ID: '' }, extraEnv || {}) });
const logOf = (root) => path.join(root, '.claude', 'forge-runs', '_hooks', 'subagent-stop.jsonl');
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const SK = 'sk' + '-' + 'canarySUBSTOP0123456789abcdef';
const MSG = 'FINAL REPORT canaryMESSAGEBODY do not log me';

const payload = {
  session_id: 'sess-ss-1', transcript_path: 'C:/Users/x/.claude/projects/p/s.jsonl', cwd: 'C:/proj', permission_mode: 'default',
  hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a0b1c2d3', agent_type: 'build-boss',
  agent_transcript_path: 'C:/Users/x/.claude/projects/p/sub/agent-a0b1c2d3.jsonl', last_assistant_message: MSG + ' ' + SK,
};

try {
  console.log('\nA) record shape (library)');
  const root = mkRoot();
  const r = SS.run(JSON.stringify(payload), { root, env: {} });
  const L = readLines(logOf(root));
  t('A1 one line written', r.ok && r.wrote && L.length === 1, JSON.stringify(r));
  t('A2 exactly the token-free fields (+ SK1 skills_opened / transcript_scanned)', JSON.stringify(Object.keys(L[0]).sort()) === JSON.stringify(['agent_id', 'agent_type', 'event', 'session', 'skills_opened', 'transcript_scanned', 'ts']), JSON.stringify(L[0]));
  t('A2b the sample transcript path does not exist -> transcript_scanned:false, skills_opened []', L[0].transcript_scanned === false && Array.isArray(L[0].skills_opened) && L[0].skills_opened.length === 0);
  t('A3 values carried through', L[0].event === 'SubagentStop' && L[0].session === 'sess-ss-1' && L[0].agent_id === 'a0b1c2d3' && L[0].agent_type === 'build-boss');
  t('A4 run id stamped only from opts/env FORGE_RUN_ID', SS.buildRecord(payload, { runId: 'forge-2026-10-24-x' }).run === 'forge-2026-10-24-x' && SS.buildRecord(payload, { env: {} }).run === undefined);
  t('A5b a null agent_type says why (absent / unlabelled) and never stores the value',
    SS.buildRecord({ agent_id: 'a1' }).agent_type_shape === 'absent'
    && SS.buildRecord({ agent_id: 'a1', agent_type: 'Build Boss part one' }).agent_type_shape === 'unlabelled'
    && !JSON.stringify(SS.buildRecord({ agent_type: 'Build Boss part one' })).includes('part one')
    && SS.buildRecord({ agent_type: 'build-boss' }).agent_type_shape === undefined);
  t('A5 free text is never a label', SS.label('build boss') === null && SS.label('a\nb') === null && SS.label('general-purpose') === 'general-purpose');

  console.log('\nB) no content, no secrets — hunted on disk');
  const disk = fs.readFileSync(logOf(root), 'utf8');
  t('B1 last_assistant_message never reaches disk', !disk.includes('canaryMESSAGEBODY') && !disk.includes('FINAL REPORT'));
  t('B2 transcript paths never reach disk', !disk.includes('transcript_path') && !disk.includes('agent-a0b1c2d3.jsonl') && !disk.includes('.claude/projects'));
  const r2 = SS.run(JSON.stringify(Object.assign({}, payload, { session_id: SK, agent_type: SK })), { root, env: {} });
  const disk2 = fs.readFileSync(logOf(root), 'utf8');
  t('B3 a secret-shaped session id / agent_type is not written raw', r2.wrote && !disk2.includes('canarySUBSTOP'), disk2.slice(-300));

  console.log('\nC) fail-open + opt-out');
  for (const [name, input] of [['garbage', '{{{not json'], ['empty', ''], ['array', '[]'], ['number', '42']]) {
    const c = cli(mkRoot(), input);
    t('C1 CLI on ' + name + ' stdin: exit 0, empty stdout', c.status === 0 && c.stdout === '', JSON.stringify({ s: c.status, o: c.stdout, e: c.stderr }));
  }
  const off = mkRoot();
  t('C2 FORGE_SUBAGENT_STOP_HOOK=off writes nothing', SS.run(JSON.stringify(payload), { root: off, env: { FORGE_SUBAGENT_STOP_HOOK: 'off' } }).wrote === false && !fs.existsSync(logOf(off)));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ss-bare-')); roots.push(bare);
  t('C3 no .claude/ -> nothing created', SS.run(JSON.stringify(payload), { root: bare, env: {} }).wrote === false && !fs.existsSync(path.join(bare, '.claude')));
  const lock = mkRoot();
  fs.writeFileSync(path.join(lock, '.claude', '.forge-sync.lock'), JSON.stringify({ started_at: new Date().toISOString() }));
  t('C4 a fresh forge-sync lock -> nothing written', SS.run(JSON.stringify(payload), { root: lock, env: {} }).wrote === false && !fs.existsSync(logOf(lock)));
  t('C5 appendHookLine refuses a bad file name', SS.appendHookLine(mkRoot(), '../evil.jsonl', {}).reason === 'bad-file-name');

  console.log('\nD) CLI end to end, cut payload, rotation, timing');
  const cr = mkRoot();
  const t0 = Date.now();
  const c = cli(cr, JSON.stringify(payload), { FORGE_RUN_ID: 'run-x1' });
  const ms = Date.now() - t0;
  const cl = readLines(logOf(cr));
  t('D1 CLI writes the line (run stamped from FORGE_RUN_ID), exit 0, empty stdout', c.status === 0 && c.stdout === '' && cl.length === 1 && cl[0].run === 'run-x1', JSON.stringify({ s: c.status, o: c.stdout, cl }));
  t('D2 runtime under 5 s (measured ' + ms + ' ms)', ms < 5000);
  const big = '{"session_id":"sess-big","agent_id":"a9","agent_type":"test-boss","last_assistant_message":"' + 'M'.repeat(400000) + '"}';
  const cb = cli(cr, big);
  const bl = readLines(logOf(cr));
  t('D3 cut payload: ids salvaged, truncated:true, no message bytes', cb.status === 0 && cb.stdout === '' && bl.length === 2 && bl[1].agent_id === 'a9' && bl[1].truncated === true && !fs.readFileSync(logOf(cr), 'utf8').includes('MMMM'), JSON.stringify(bl[1]));
  const rot = mkRoot();
  for (let i = 0; i < 5; i++) SS.run(JSON.stringify(payload), { root: rot, env: {}, maxLogBytes: 300 });
  t('D4 rotation keeps one previous generation', fs.existsSync(logOf(rot).replace(/\.jsonl$/, '.1.jsonl')) && fs.statSync(logOf(rot)).size <= 300);

  console.log('\nE) WP A2: run attribution from the run pointer, salvage with whitespace');
  const AR = require('./forge-active-run.cjs');
  const pr = mkRoot();
  AR.setActiveRun(pr, 'run-ptr-1', { session: 'sess-ss-1', allowMissing: true });
  const e1 = SS.run(JSON.stringify(payload), { root: pr, env: {} });
  const el = readLines(logOf(pr));
  t('E1 the pointer of this session stamps the run (run_source pointer-session)', e1.wrote && el[0].run === 'run-ptr-1' && el[0].run_source === 'pointer-session', JSON.stringify(el[0]));
  t('E2 env FORGE_RUN_ID still wins over the pointer', SS.buildRecord(payload, { root: pr, env: { FORGE_RUN_ID: 'run-env-1' } }).run === 'run-env-1' && SS.buildRecord(payload, { root: pr, env: { FORGE_RUN_ID: 'run-env-1' } }).run_source === 'env');
  t('E3 buildRecord without a root never reads a pointer (library callers unchanged)', SS.buildRecord(payload, { env: {} }).run === undefined);
  const other = mkRoot();
  AR.setActiveRun(other, 'run-other', { session: 'sess-someone-else', allowMissing: true });
  t('E4 the fallback pointer of ANOTHER session is not used', SS.buildRecord(payload, { root: other, env: {} }).run === undefined);
  const stale = mkRoot();
  AR.setActiveRun(stale, 'run-stale', { allowMissing: true, now: Date.now() - 25 * 3600 * 1000 });
  t('E5 a pointer older than 24 h is ignored', SS.buildRecord(payload, { root: stale, env: {} }).run === undefined);
  const spaced = '{"session_id": "s1", "agent_id": "a9b8c7", "agent_type": "test-boss", "last_assistant_message": "' + 'M'.repeat(50);
  const sv = SS.salvageIds(spaced);
  t('E6 salvage reads ids written with a space after the colon (regression: a bare \\s in the string literal was "s")', !!sv && sv.agent_id === 'a9b8c7' && sv.agent_type === 'test-boss' && sv.session_id === 's1', JSON.stringify(sv));
  t('E7 runHook skip(): a skipped payload writes nothing', SS.runHook(JSON.stringify(payload), { root: mkRoot(), env: {} }, { envFlag: 'X_OFF', fileName: 'subagent-stop.jsonl', build: SS.buildRecord, skip: () => 'not mine' }).wrote === false);
} catch (e) {
  fail++; console.error('  FAIL threw: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}
console.log('\nforge-subagent-stop tests');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
