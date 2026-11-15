'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-skill-use.test.cjs - SD-T11: skill use measured from the SubagentStart/SubagentStop hook lines.
// Hermetic: every case builds its own temp root; nothing reads or writes the real runs folder.
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
function eq(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function w(root, rel, text) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function jsonl(rows) { return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'; }

let U = null;
try { U = require('./forge-skill-use.cjs'); } catch (e) { console.log('FAIL load forge-skill-use.cjs: ' + e.message); }
const G = require('./forge-registry-gen.cjs');
const HOOKS = '.claude/forge-runs/_hooks/';
const temps = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skilluse-')); temps.push(d); return d; }

// two fixture runs: r1 preloads conduct + tdd for two agents and opens tdd once; r2 preloads conduct and opens debug twice
function twoRuns() {
  const root = tmp();
  w(root, HOOKS + 'subagent-start.jsonl', jsonl([
    { ts: '2026-11-01T10:00:00Z', event: 'SubagentStart', agent_type: 'build-boss', run: 'r1', skills_preloaded: ['forge-conduct', 'tdd-skill'] },
    { ts: '2026-11-01T10:01:00Z', event: 'SubagentStart', agent_type: 'test-boss', run: 'r1', skills_preloaded: ['forge-conduct', 'tdd-skill'] },
    { ts: '2026-11-02T10:00:00Z', event: 'SubagentStart', agent_type: 'verify-boss', run: 'r2', skills_preloaded: ['forge-conduct'] },
    { ts: '2026-11-02T10:00:30Z', event: 'SubagentStart', agent_type: 'build-boss' },
  ]) + '{ not json\n');
  w(root, HOOKS + 'subagent-stop.jsonl', jsonl([
    { ts: '2026-11-01T10:05:00Z', event: 'SubagentStop', run: 'r1', skills_opened: ['tdd-skill'], conduct_seen: true },
    { ts: '2026-11-02T10:05:00Z', event: 'SubagentStop', run: 'r2', skills_opened: ['debug-skill', 'debug-skill'] },
    { ts: '2026-11-02T10:06:00Z', event: 'SubagentStop', run: 'r2', skills_opened: ['debug-skill'] },
  ]));
  return root;
}

t('module loads and exports skillUse', () => ok(U && typeof U.skillUse === 'function', 'skillUse missing'));

t('counts from hook lines: 2 fixture runs give the right counts', () => {
  const m = U.skillUse(twoRuns(), { lastRuns: 10 });
  ok(m instanceof Map, 'not a Map');
  eq(m.get('forge-conduct'), { preloaded: 3, opened: 0, runs: 2 });
  eq(m.get('tdd-skill'), { preloaded: 2, opened: 1, runs: 1 });
  // a skill named twice in one stop line counts once for that line
  eq(m.get('debug-skill'), { preloaded: 0, opened: 2, runs: 1 });
});

t('the window keeps only the last N runs, by their latest line', () => {
  const root = tmp();
  const starts = [];
  for (let i = 1; i <= 12; i++) starts.push({ ts: '2026-10-' + String(i).padStart(2, '0') + 'T00:00:00Z', run: 'run' + i, skills_preloaded: ['s' + i] });
  w(root, HOOKS + 'subagent-start.jsonl', jsonl(starts));
  const r = U.skillUseReport(root, { lastRuns: 10 });
  eq(r.runs.length, 10);
  ok(!r.map.has('s1') && !r.map.has('s2') && r.map.has('s3') && r.map.has('s12'), JSON.stringify([...r.map.keys()]));
});

t('hookWindow: the raw start and stop lines of the last N runs, with the run list (SD-T12c)', () => {
  ok(typeof U.hookWindow === 'function', 'hookWindow missing');
  const root = twoRuns();
  const all = U.hookWindow(root, { lastRuns: 10 });
  eq(all.runs, ['r2', 'r1']);
  eq(all.starts.map((l) => l.agent_type), ['build-boss', 'test-boss', 'verify-boss']); // the run-less line is dropped
  eq(all.stops.length, 3);
  const one = U.hookWindow(root, { lastRuns: 1 });
  eq(one.runs, ['r2']);
  eq(one.starts.map((l) => l.agent_type), ['verify-boss']);
  eq(one.stops.length, 2);
  const viaDir = U.hookWindow('/nowhere', { hooksDir: path.join(root, HOOKS) });
  eq(viaDir.starts.length, 3);
  eq(U.hookWindow(tmp(), {}), { runs: [], starts: [], stops: [] });
});

t('unused-in-runs: a skill in no line', () => {
  const r = U.skillUseReport(twoRuns(), { lastRuns: 10 });
  const u = U.useFor('never-named', r);
  eq(u.status, 'unused-in-runs');
  eq([u.preloaded, u.opened, u.runs], [0, 0, 0]);
  eq(U.useFor('tdd-skill', r).status, 'used');
});

t('not-measured: no hook files', () => {
  const root = tmp();
  const r = U.skillUseReport(root, { lastRuns: 10 });
  eq(r.measured, false);
  eq(U.useFor('anything', r).status, 'not-measured');
  eq(U.skillUse(root).size, 0);
});

t('old start lines without skills_preloaded mark preloads as not measured', () => {
  const root = tmp();
  w(root, HOOKS + 'subagent-start.jsonl', jsonl([{ ts: '2026-11-01T00:00:00Z', run: 'old', agent_type: 'build-boss' }]));
  w(root, HOOKS + 'subagent-stop.jsonl', jsonl([{ ts: '2026-11-01T00:01:00Z', run: 'old', skills_opened: ['x'] }]));
  const r = U.skillUseReport(root, { lastRuns: 10 });
  eq([r.measured, r.preload_measured], [true, false]);
  eq(U.useFor('x', r).preload_measured, false);
  eq(U.useFor('x', r).status, 'used');
});

t('registry row carries use: feature-registry on a temp root shows the use field', () => {
  const root = twoRuns();
  w(root, '.claude/skills/tdd-skill/SKILL.md', '---\nname: tdd-skill\ndescription: Use when testing.\n---\n');
  w(root, '.claude/skills/quiet-skill/SKILL.md', '---\nname: quiet-skill\ndescription: Use when quiet.\n---\n');
  w(root, '.claude/forge-bin/some-tool.cjs', '// tool\n');
  const data = G.genFeatureRegistry(root, null, { today: '2026-11-08' }).data;
  const tdd = data.features.find((f) => f.kind === 'skill' && f.id === 'tdd-skill');
  const quiet = data.features.find((f) => f.kind === 'skill' && f.id === 'quiet-skill');
  eq(tdd.use, { preloaded: 2, opened: 1, runs: 1, status: 'used', preload_measured: true });
  eq(quiet.use.status, 'unused-in-runs');
  ok(['wired', 'on-request', 'dormant'].includes(tdd.status), 'the existing status field changed: ' + tdd.status);
  ok(!('use' in data.features.find((f) => f.kind === 'tool')), 'a tool row got a use field');
  eq(G.validateFeatureRegistry(data), []);
  // and through the CLI (--json, dry run, nothing written)
  let out = '';
  const orig = process.stdout.write; process.stdout.write = (s) => { out += s; return true; };
  try { eq(G.main(['feature-registry', '--json', '--root', root]), 0); } finally { process.stdout.write = orig; }
  ok(JSON.parse(out).features.find((f) => f.id === 'tdd-skill').use.status === 'used', 'CLI row has no use');
  ok(!fs.existsSync(path.join(root, G.FEATURE_REGISTRY_REL)), 'dry run wrote the registry');
});

t('registry rows are not-measured on a root with no hook lines', () => {
  const root = tmp();
  w(root, '.claude/skills/lonely/SKILL.md', '---\nname: lonely\ndescription: Use when alone.\n---\n');
  const row = G.genFeatureRegistry(root, null, { today: '2026-11-08' }).data.features.find((f) => f.id === 'lonely');
  eq(row.use.status, 'not-measured');
});

t('validate: a bad use status is a problem', () => {
  const p = G.validateFeatureRegistry({ schema: G.FEATURE_SCHEMA, features: [{ id: 'a', kind: 'skill', status: 'on-request', invoked_by: [], use: { status: 'busy' } }] });
  ok(p.some((x) => /use\.status/.test(x)), JSON.stringify(p));
});

t('FB-SKILLTOOLS-F9: in the .forge layout the hook lines are read from the runs folder the hooks write to', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  const runs = require('./forge-paths.cjs').stateDir(root, 'runs');
  ok(!runs.startsWith(path.join(root, '.claude')), 'fixture is not in the forge layout: ' + runs);
  w(runs, '_hooks/subagent-start.jsonl', jsonl([{ ts: '2026-11-01T10:00:00Z', run: 'rf', skills_preloaded: ['forge-conduct'] }]));
  eq(U.skillUseReport(root, { lastRuns: 10 }).runs, ['rf']);
});

for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
