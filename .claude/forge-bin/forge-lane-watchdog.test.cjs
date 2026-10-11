#!/usr/bin/env node
'use strict';
/**
 * forge-lane-watchdog.test.cjs — tests for forge-lane-watchdog.cjs with synthetic Agent-tool transcripts written
 * to a fresh folder in the OS temp directory (removed at exit). Zero dependencies; run: node forge-lane-watchdog.test.cjs
 * The last line is the tally '<n> passed, <m> failed'; exit 1 when anything failed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const TOOL = path.join(__dirname, 'forge-lane-watchdog.cjs');
const wd = require(TOOL);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lanewd-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });
const SESSION = path.join(ROOT, 'session', 'subagents');
fs.mkdirSync(SESSION, { recursive: true });

let passed = 0, failed = 0;
const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
async function t(name, fn) {
  try { await fn(); passed++; results.push('  ok   ' + name); } catch (e) { failed++; results.push('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

// ---- fixture builders -------------------------------------------------------------------------------------------
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
let seq = 0;
const asst = (min, content, stop) => ({ type: 'assistant', timestamp: ago(min), message: { role: 'assistant', content, stop_reason: stop === undefined ? 'tool_use' : stop } });
const user = (min, content) => ({ type: 'user', timestamp: ago(min), message: { role: 'user', content } });
const use = (name, input) => ({ type: 'tool_use', id: 'tu_' + (++seq), name, input });
function pair(min, name, input, result) {
  const u = use(name, input);
  return [asst(min, [u]), user(min, [Object.assign({ type: 'tool_result', tool_use_id: u.id, content: 'ok' }, result || {})])];
}
function writeLane(id, entries, mtimeAgoMin, dir) {
  const f = path.join(dir || SESSION, 'agent-' + id + '.jsonl');
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (mtimeAgoMin) { const when = new Date(Date.now() - mtimeAgoMin * 60000); fs.utimesSync(f, when, when); }
  return f;
}
const QUIET = ['--disk-min-gb', '0', '--tmp-max', '1000000000'];
function cli(args, opts) {
  const r = spawnSync(process.execPath, [TOOL, ...args], Object.assign({ encoding: 'utf8', timeout: 30000 }, opts || {}));
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const once = (ids, extra) => cli(['--ids', ids, '--session', SESSION, '--once', ...QUIET, ...(extra || [])]);

// ---- fixtures ---------------------------------------------------------------------------------------------------
writeLane('healthy1', [...pair(3, 'Read', { file_path: 'a.js' }), ...pair(2, 'Bash', { command: 'node x' })]);
writeLane('stalled1', [...pair(25, 'Read', { file_path: 'b.js' })], 20);
writeLane('hung1', [asst(30, [use('Bash', { command: 'npm test --watch' })])]);
writeLane('nowork1', [user(10, 'do the task'), asst(9, [{ type: 'text', text: 'thinking about it' }], null)]);
writeLane('loop1', Array.from({ length: 6 }, () => pair(1, 'Grep', { pattern: 'foo', path: 'src' })).flat());
writeLane('loop5', Array.from({ length: 5 }, () => pair(1, 'Grep', { pattern: 'foo', path: 'src' })).flat());
writeLane('errs1', [...pair(1, 'Bash', { command: 'a' }, { is_error: true }), ...pair(1, 'Bash', { command: 'b' }, { content: 'Error: ENOSPC: no space left on device' }),
  ...pair(1, 'Bash', { command: 'c' }, { is_error: true }), ...pair(1, 'Bash', { command: 'd' }, { content: 'Traceback (most recent call last)' }),
  ...pair(1, 'Bash', { command: 'e' }, { content: 'Exit code 1' })]);
writeLane('errs4', [...pair(1, 'Bash', { command: 'a' }, { is_error: true }), ...pair(1, 'Bash', { command: 'b' }, { is_error: true }),
  ...pair(1, 'Bash', { command: 'c' }, { is_error: true }), ...pair(1, 'Bash', { command: 'd' }, { is_error: true }), ...pair(1, 'Bash', { command: 'e' })]);
writeLane('done1', [...pair(70, 'Edit', { file_path: 'c.js' }), asst(65, [{ type: 'text', text: 'All done.' }], 'end_turn'),
  { type: 'system', timestamp: ago(64), subtype: 'note' }, { type: 'attachment', timestamp: ago(64) }], 60);
writeLane('notdone1', [...pair(70, 'Edit', { file_path: 'c.js' }), asst(65, [{ type: 'text', text: 'Next I will...' }], null)], 60);

(async () => {
  console.log('forge-lane-watchdog tests');

  await t('healthy lane: --once exit 0, ok line, all healthy', () => {
    const r = once('healthy1');
    assert(r.code === 0, 'exit ' + r.code + '\n' + r.out);
    assert(/^ok {3}healthy1 {2}lines 4 {2}idle 0m {2}tools 2 {2}pending 0 {2}errStreak 0/m.test(r.out), r.out);
    assert(/\[WATCHDOG\] all 1 lane\(s\) healthy at /.test(r.out), r.out);
  });

  await t('stalled lane (old mtime): STALLED flag, --once exit 1', () => {
    const r = once('stalled1');
    assert(r.code === 1, 'exit ' + r.code);
    assert(/\[WATCHDOG\] STALLED stalled1 \(no transcript write for 20 min\)/.test(r.out), r.out);
    assert(/^FLAG stalled1/m.test(r.out), r.out);
  });

  await t('hung tool call (tool_use without result, old timestamp): HUNG-TOOL, not STALLED', () => {
    const r = once('hung1');
    assert(r.code === 1, 'exit ' + r.code);
    assert(/HUNG-TOOL hung1 Bash open 30 min: Bash \{"command":"npm test --watch"\}/.test(r.out), r.out);
    assert(!/STALLED/.test(r.out), 'fresh mtime must not be STALLED: ' + r.out);
  });

  await t('no-work lane: NO-WORK flag with 0 tool calls', () => {
    const r = once('nowork1');
    assert(r.code === 1, 'exit ' + r.code);
    assert(/NO-WORK nowork1 \(10 min old, 0 tool calls\)/.test(r.out), r.out);
  });

  await t('loop of 6 identical calls: LOOP flag; 5 identical calls: no flag', () => {
    const r = once('loop1');
    assert(r.code === 1 && /LOOP loop1 \(same tool call repeated >= 6 times in a row: Grep \{"pattern":"foo","path":"src"\}\)/.test(r.out), r.out);
    const r5 = once('loop5');
    assert(r5.code === 0 && !/LOOP/.test(r5.out), r5.out);
  });

  await t('error streak of 5 (is_error, ENOSPC, Traceback, exit code): ERROR-STREAK; a success resets it', () => {
    const r = once('errs1');
    assert(r.code === 1 && /ERROR-STREAK errs1 \(5 failing tool results in a row\)/.test(r.out), r.out);
    const r4 = once('errs4');
    assert(r4.code === 0 && !/ERROR-STREAK/.test(r4.out), r4.out);
  });

  await t('finished lane (end_turn, no pending, trailing system/attachment) is "done", never STALLED', () => {
    const r = once('done1');
    assert(r.code === 0, 'exit ' + r.code + '\n' + r.out);
    assert(/^done done1/m.test(r.out) && !/STALLED/.test(r.out), r.out);
    const r2 = once('notdone1');
    assert(r2.code === 1 && /STALLED notdone1/.test(r2.out), 'same age without end_turn must stall: ' + r2.out);
  });

  await t('--once with several lanes reports each and exits 1 when any one is flagged', () => {
    const r = once('healthy1,done1,stalled1');
    assert(r.code === 1, 'exit ' + r.code);
    assert(/^ok {3}healthy1/m.test(r.out) && /^done done1/m.test(r.out) && /^FLAG stalled1/m.test(r.out), r.out);
  });

  await t('unknown lane: NO-TRANSCRIPT flag, exit 1', () => {
    const r = once('ghost9');
    assert(r.code === 1 && /NO-TRANSCRIPT ghost9/.test(r.out), r.out);
  });

  await t('--ids missing or empty: exit 2 with a usage message', () => {
    const r = cli(['--session', SESSION, '--once']);
    assert(r.code === 2 && /--ids <agentId,\.\.\.> is required/.test(r.out), r.code + ' ' + r.out);
    const r2 = cli(['--ids', ' , ', '--session', SESSION]);
    assert(r2.code === 2, 'empty ids exit ' + r2.code);
  });

  await t('no session folder found: exit 2 (CLAUDE_CONFIG_DIR points at an empty folder)', () => {
    const empty = path.join(ROOT, 'empty-config');
    fs.mkdirSync(empty, { recursive: true });
    const r = cli(['--ids', 'x', '--once'], { env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: empty }) });
    assert(r.code === 2 && /no session subagents folder found/.test(r.out), r.code + ' ' + r.out);
  });

  await t('default session: newest session of the cwd slug under $CLAUDE_CONFIG_DIR/projects', () => {
    const cfgDir = path.join(ROOT, 'cfg');
    const work = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'My Proj! ')));
    const slugDir = path.join(cfgDir, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    const oldSub = path.join(slugDir, 'sess-old', 'subagents');
    const newSub = path.join(slugDir, 'sess-new', 'subagents');
    fs.mkdirSync(oldSub, { recursive: true });
    fs.mkdirSync(newSub, { recursive: true });
    writeLane('lane7', [...pair(1, 'Read', { file_path: 'x' })], 0, newSub);
    const old = new Date(Date.now() - 3600000);
    fs.utimesSync(oldSub, old, old);
    const r = cli(['--ids', 'lane7', '--once', ...QUIET], { cwd: work, env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfgDir }) });
    assert(r.code === 0 && /^ok {3}lane7/m.test(r.out), r.code + ' ' + r.out);
    assert(wd.projectsDir({ CLAUDE_CONFIG_DIR: cfgDir }) === path.join(cfgDir, 'projects'), 'projectsDir honours CLAUDE_CONFIG_DIR');
    assert(wd.projectsDir({}) === path.join(os.homedir(), '.claude', 'projects'), 'projectsDir falls back to the home folder');
  });

  await t('global flags: TMP-FLOOD with --tmp-max 0; DISK-LOW with a huge --disk-min-gb', () => {
    const r = cli(['--ids', 'healthy1', '--session', SESSION, '--once', '--disk-min-gb', '0', '--tmp-max', '0']);
    assert(r.code === 1 && /\[WATCHDOG\] TMP-FLOOD \d+ top-level entries in /.test(r.out), r.out);
    if (typeof fs.statfsSync === 'function') {
      const r2 = cli(['--ids', 'healthy1', '--session', SESSION, '--once', '--tmp-max', '1000000000', '--disk-min-gb', '1000000000']);
      assert(r2.code === 1 && /\[WATCHDOG\] DISK-LOW .* GB < 1000000000 GB/.test(r2.out), r2.out);
    }
  });

  await t('flag keys normalise numbers (a changing count is the same key) but keep digits inside an agent id', () => {
    const a = wd.keyOf('STALLED a1b2c3 (no transcript write for 13 min)');
    const b = wd.keyOf('STALLED a1b2c3 (no transcript write for 14 min)');
    assert(a === b, a + ' vs ' + b);
    assert(a.includes('a1b2c3'), 'id kept: ' + a);
    assert(wd.keyOf('DISK-LOW C:\\ free 3.2 GB < 5 GB') === wd.keyOf('DISK-LOW C:\\ free 2.9 GB < 5 GB'), 'decimals normalised');
    assert(wd.keyOf('STALLED a1 (x)') !== wd.keyOf('STALLED a2 (x)'), 'different lanes stay different');
  });

  await t('analyse() direct: thresholds come from the config object', () => {
    const cfg = Object.assign({}, wd.parseArgs(['--ids', 'x', '--stall-min', '30']));
    const r = wd.analyse('stalled1', SESSION, cfg, Date.now());
    assert(r.flags.length === 0, 'stall-min 30 must not flag a 20-minute idle lane: ' + r.flags.join('; '));
    assert(wd.longestRun(['a', 'a', 'b', 'b', 'b']) === 3 && wd.longestRun([]) === 0, 'longestRun');
  });

  await t('watch mode: one line per NEW flag, no churn on later polls, a cleared line when it goes away', async () => {
    writeLane('watch1', [...pair(1, 'Read', { file_path: 'w.js' })]);
    const child = spawn(process.execPath, [TOOL, '--ids', 'watch1', '--session', SESSION, '--watch', '2', ...QUIET], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const waitFor = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(out)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
    try {
      assert(await waitFor(/\[WATCHDOG\] armed for 1 lane\(s\), poll 2s/, 10000), 'not armed: ' + out);
      writeLane('watch1', Array.from({ length: 6 }, () => pair(1, 'Glob', { pattern: '**/*.js' })).flat());
      assert(await waitFor(/\[WATCHDOG\] LOOP watch1/, 10000), 'no LOOP line: ' + out);
      await new Promise((r) => setTimeout(r, 5000)); // at least two more polls
      const loops = (out.match(/\[WATCHDOG\] LOOP watch1/g) || []).length;
      assert(loops === 1, 'LOOP emitted ' + loops + ' times:\n' + out);
      writeLane('watch1', [...pair(0, 'Read', { file_path: 'w.js' })]);
      assert(await waitFor(/\[WATCHDOG\] cleared: LOOP watch1/, 10000), 'no cleared line: ' + out);
      assert(out.trim().split('\n').length === 3, 'expected exactly armed + LOOP + cleared:\n' + out);
    } finally {
      try { process.kill(child.pid); } catch { /* already gone */ }
    }
  });

  await t('--help prints the plain English header and exits 0', () => {
    const r = cli(['--help']);
    assert(r.code === 0 && /read-only watchdog for parallel background Agent-tool lanes/.test(r.out) && /STALLED/.test(r.out), r.out);
  });

  for (const line of results) console.log(line);
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
