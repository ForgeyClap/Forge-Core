#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-graphify.test.cjs — node:test suite for the graphify adapter (WP SA-P1-ADAPT, PHASE2-PLAN A9 + section E).
// HERMETIC: the home folder, PATH and the graphify process are fakes in a fresh os.tmpdir() folder; the real
// ~/.claude/skills/graphify and the real graphify binary are never touched by these tests.
const { test: nodeTest, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });

const G = require('./forge-graphify.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-graphify-test-'));
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const SKILL_OLD = '---\nname: graphify-windows\ndescription: "any input to graph"\ntrigger: /graphify\n---\n\n# /graphify\n\nname: graphify-windows stays in the body\n';

function mkSkill(dir, text, version) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  if (version !== undefined) fs.writeFileSync(path.join(dir, '.graphify_version'), version);
  return dir;
}

test('GR-1: parseVersion reads "graphify 0.8.50" and ignores the stale-skill warning lines', () => {
  const out = "  warning: skill is from graphify 0.8.28, package is 0.8.50. Run 'graphify install' to update.\ngraphify 0.8.50\n";
  assert.strictEqual(G.parseVersion(out), '0.8.50');
  assert.strictEqual(G.parseVersion('nothing here'), null);
});

test('GR-2: candidates order = GRAPHIFY_BIN, PATH, ~/.local/bin, then the uv tool python with -m graphify', () => {
  const home = path.join(ROOT, 'home-c');
  const env = { GRAPHIFY_BIN: 'C:/x/graphify.exe', PATH: ['C:/p1', 'C:/p2'].join(';'), APPDATA: path.join(home, 'AppData', 'Roaming') };
  const c = G.candidates({ env, home, platform: 'win32' });
  assert.strictEqual(c[0].cmd, 'C:/x/graphify.exe');
  assert.strictEqual(c[0].source, 'env:GRAPHIFY_BIN');
  assert.ok(c.some((x) => x.cmd === path.join('C:/p1', 'graphify.exe') && x.source === 'path'));
  const local = c.findIndex((x) => x.cmd === path.join(home, '.local', 'bin', 'graphify.exe'));
  const uv = c.findIndex((x) => x.source === 'uv-tool-python');
  assert.ok(local > 0 && uv > local, 'local bin before uv python');
  assert.deepStrictEqual(c[uv].args, ['-m', 'graphify']);
  assert.strictEqual(c[uv].cmd, path.join(env.APPDATA, 'uv', 'tools', 'graphifyy', 'Scripts', 'python.exe'));
});

test('GR-3: locate skips missing and failing candidates and returns the first one whose --version answers', () => {
  const home = path.join(ROOT, 'home-l');
  const env = { PATH: '', APPDATA: path.join(home, 'AppData', 'Roaming') };
  const localExe = path.join(home, '.local', 'bin', 'graphify.exe');
  const uvPy = path.join(env.APPDATA, 'uv', 'tools', 'graphifyy', 'Scripts', 'python.exe');
  const calls = [];
  const exists = (p) => p === localExe || p === uvPy;
  const run = (cmd, args) => { calls.push([cmd, args]); return cmd === localExe ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0, stdout: 'graphify 0.8.50\n', stderr: '' }; };
  const r = G.locate({ env, home, platform: 'win32', exists, run });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cmd, uvPy);
  assert.deepStrictEqual(r.args, ['-m', 'graphify']);
  assert.strictEqual(r.version, '0.8.50');
  assert.strictEqual(calls[0][0], localExe, 'the failing local exe was really probed');
});

test('GR-4: locate reports not-found honestly with every candidate it tried', () => {
  const r = G.locate({ env: { PATH: '' }, home: path.join(ROOT, 'none'), platform: 'win32', exists: () => false, run: () => { throw new Error('must not run'); } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.tried.length >= 2);
  assert.match(r.reason, /not found/i);
});

test('GR-5: normalizeSkillText renames graphify-windows to graphify and drops trigger, frontmatter only', () => {
  const r = G.normalizeSkillText(SKILL_OLD);
  assert.match(r.text, /^---\nname: graphify\n/);
  assert.ok(!/^trigger:/m.test(r.text.split('\n---\n')[0]), 'no trigger key in frontmatter');
  assert.ok(r.text.includes('name: graphify-windows stays in the body'), 'body untouched');
  assert.strictEqual(r.changes.length, 2);
  const again = G.normalizeSkillText(r.text);
  assert.strictEqual(again.changes.length, 0, 'idempotent');
  assert.strictEqual(again.text, r.text);
});

test('GR-6: normalizeSkillText refuses a file without frontmatter', () => {
  assert.throws(() => G.normalizeSkillText('# no frontmatter\n'), /frontmatter/);
});

test('GR-7: checkSkill flags wrong name, trigger key and a stale version marker', () => {
  const dir = mkSkill(path.join(ROOT, 'sk-bad'), SKILL_OLD, '0.8.28');
  const r = G.checkSkill(dir, '0.8.50');
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => /name/.test(p)));
  assert.ok(r.problems.some((p) => /trigger/.test(p)));
  assert.ok(r.problems.some((p) => /0\.8\.28/.test(p) && /0\.8\.50/.test(p)));
});

test('GR-8: checkSkill passes a normalized skill with a current marker', () => {
  const dir = mkSkill(path.join(ROOT, 'sk-good'), G.normalizeSkillText(SKILL_OLD).text, '0.8.50\n');
  const r = G.checkSkill(dir, '0.8.50');
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.ok, true);
});

test('GR-9: fixSkill backs up once, rewrites the frontmatter and is a no-op the second time', () => {
  const dir = mkSkill(path.join(ROOT, 'sk-fix'), SKILL_OLD, '0.8.50');
  const r1 = G.fixSkill(dir, { date: '2026-11-04' });
  assert.strictEqual(r1.changed, true);
  const bak = path.join(dir, 'SKILL.md.bak-2026-11-04');
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), SKILL_OLD, 'backup holds the original');
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /^---\nname: graphify\n/);
  const r2 = G.fixSkill(dir, { date: '2026-11-04' });
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), SKILL_OLD, 'backup not overwritten');
});

test('GR-10: smoke runs --help, builds a graph on a temp folder, reads graph.json and removes the folder', () => {
  const seen = [];
  const run = (cmd, args) => {
    seen.push(args.slice());
    if (args.includes('--help')) return { status: 0, stdout: 'Usage: graphify <command>\n', stderr: '' };
    const target = args[args.indexOf('update') + 1];
    assert.ok(fs.readdirSync(target).length >= 2, 'temp corpus has files');
    fs.mkdirSync(path.join(target, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(target, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{}, {}, {}], links: [{}] }));
    return { status: 0, stdout: 'Rebuilt: 3 nodes', stderr: '' };
  };
  const r = G.smoke({ found: { ok: true, cmd: 'g', args: [], version: '0.8.50' }, run, tmpRoot: ROOT });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.nodes, 3);
  assert.strictEqual(r.links, 1);
  assert.ok(seen[0].includes('--help') && seen[1].includes('update'));
  assert.strictEqual(fs.existsSync(r.tmpDir), false, 'temp folder deleted');
});

test('GR-11: smoke fails closed when the graph has no nodes or graphify exits non-zero', () => {
  const empty = G.smoke({ found: { ok: true, cmd: 'g', args: [] }, tmpRoot: ROOT, run: (c, a) => {
    if (a.includes('--help')) return { status: 0, stdout: 'Usage', stderr: '' };
    const t = a[a.indexOf('update') + 1];
    fs.mkdirSync(path.join(t, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(t, 'graphify-out', 'graph.json'), '{"nodes":[],"links":[]}');
    return { status: 0, stdout: '', stderr: '' };
  } });
  assert.strictEqual(empty.ok, false);
  const crash = G.smoke({ found: { ok: true, cmd: 'g', args: [] }, tmpRoot: ROOT, run: () => ({ status: 2, stdout: '', stderr: 'x' }) });
  assert.strictEqual(crash.ok, false);
  assert.strictEqual(fs.existsSync(crash.tmpDir || path.join(ROOT, 'never')), false);
  const missing = G.smoke({ found: { ok: false, reason: 'graphify not found' }, tmpRoot: ROOT, run: () => { throw new Error('no'); } });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.reason, /not found/);
});

// ---- ensure(): keep graphify-out/graph.json fresh for a project root (all fakes, no real graphify process) ----
const FOUND = { ok: true, cmd: 'g.exe', args: ['-m', 'graphify'], source: 'fake', version: '0.8.50' };
let projN = 0;
function mkProj(files, opts) {
  const dir = path.join(ROOT, 'proj-' + (++projN));
  if (!(opts && opts.noMarker)) fs.mkdirSync(path.join(dir, '.claude'), { recursive: true }); // the project marker ensure() wants
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  if (opts && opts.graphAt !== undefined) {
    fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
    const gj = path.join(dir, 'graphify-out', 'graph.json');
    fs.writeFileSync(gj, '{"nodes":[{}],"links":[]}');
    fs.utimesSync(gj, opts.graphAt, opts.graphAt);
  }
  return dir;
}
function setMtime(p, sec) { fs.utimesSync(p, sec, sec); }
const CODE3 = { 'a.js': 'module.exports = 1;\n', 'src/b.py': 'x = 1\n', 'src/c.ts': 'export const c = 1;\n' };
function noSpawn() { throw new Error('spawn must not be called'); }
function noRun() { throw new Error('run must not be called'); }

test('EN-1: fresh when graph.json is newer than every code file; ignored dirs do not count; no probe, no spawn', () => {
  const dir = mkProj(Object.assign({}, CODE3, { 'node_modules/x/i.js': '1', '_scratch/s.js': '1', '.claude/forge-runs/r/x.js': '1' }));
  for (const f of ['a.js', 'src/b.py', 'src/c.ts']) setMtime(path.join(dir, f), 1000);
  for (const f of ['node_modules/x/i.js', '_scratch/s.js', '.claude/forge-runs/r/x.js']) setMtime(path.join(dir, f), 9000);
  fs.mkdirSync(path.join(dir, 'graphify-out'));
  fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), '{}');
  fs.writeFileSync(path.join(dir, 'graphify-out', 'GRAPH_REPORT.md'), '# r\n');
  setMtime(path.join(dir, 'graphify-out', 'graph.json'), 2000);
  const r = G.ensure({ root: dir, env: {}, run: noRun, spawn: noSpawn, locate: () => { throw new Error('no locate when fresh'); } });
  assert.strictEqual(r.status, 'fresh', JSON.stringify(r));
  assert.strictEqual(r.out_dir, path.join(dir, 'graphify-out'));
  assert.strictEqual(r.graph, path.join(dir, 'graphify-out', 'graph.json'));
  assert.strictEqual(r.report, path.join(dir, 'graphify-out', 'GRAPH_REPORT.md'));
});

test('EN-2: stale -> building: one detached, hidden, unref\'d node wrapper (`ensure --root <root> --wait`), no shell; a second call does not spawn again', () => {
  const dir = mkProj(CODE3, { graphAt: 1000 });
  setMtime(path.join(dir, 'src/c.ts'), 5000);
  const spawns = []; const children = [];
  // pid = this test process, so the lock's pid is really alive
  const spawn = (cmd, args, o) => { spawns.push({ cmd, args, o }); const c = { pid: process.pid, unrefd: false, unref() { this.unrefd = true; } }; children.push(c); return c; };
  const r = G.ensure({ root: dir, env: {}, found: FOUND, spawn, now: 10000 * 1000 });
  assert.strictEqual(r.status, 'building', JSON.stringify(r));
  assert.strictEqual(r.report, null, 'no GRAPH_REPORT.md yet');
  assert.strictEqual(spawns.length, 1);
  assert.strictEqual(spawns[0].cmd, process.execPath, 'the background build is a node wrapper, not graphify itself');
  assert.deepStrictEqual(spawns[0].args.slice(0, 5), [path.join(__dirname, 'forge-graphify.cjs'), 'ensure', '--root', dir, '--wait']);
  assert.deepStrictEqual(spawns[0].args.slice(5, 6), ['--found']);
  assert.deepStrictEqual(JSON.parse(spawns[0].args[6]), { cmd: 'g.exe', args: ['-m', 'graphify'] }, 'the wrapper reuses the located graphify, no second probe');
  assert.strictEqual(spawns[0].args.length, 7);
  assert.strictEqual(spawns[0].o.detached, true);
  assert.strictEqual(spawns[0].o.shell, false);
  assert.strictEqual(spawns[0].o.stdio, 'ignore');
  assert.strictEqual(spawns[0].o.windowsHide, true, 'no console window pops up');
  assert.strictEqual(spawns[0].o.cwd, dir);
  assert.strictEqual(children[0].unrefd, true, 'the caller never waits on the wrapper');
  const r2 = G.ensure({ root: dir, env: {}, found: FOUND, spawn, now: 10000 * 1000 + 60000 });
  assert.strictEqual(r2.status, 'building');
  assert.strictEqual(spawns.length, 1, 'a running build is not started twice');
  const r3 = G.ensure({ root: dir, env: {}, found: FOUND, spawn, now: 10000 * 1000 + 3600 * 1000 });
  assert.strictEqual(r3.status, 'building');
  assert.strictEqual(spawns.length, 2, 'an expired build lock allows a new build');
});

test('EN-3: wait=true builds synchronously with `update .` in cwd root -> built; a failed build is reported, never thrown', () => {
  const dir = mkProj(CODE3);
  const calls = [];
  const run = (cmd, args, o) => {
    calls.push({ cmd, args, o });
    fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), '{"nodes":[{}]}');
    fs.writeFileSync(path.join(dir, 'graphify-out', 'GRAPH_REPORT.md'), '# r\n');
    return { status: 0, stdout: 'Rebuilt', stderr: '' };
  };
  const r = G.ensure({ root: dir, env: {}, found: FOUND, run, spawn: noSpawn, wait: true });
  assert.strictEqual(r.status, 'built', JSON.stringify(r));
  assert.deepStrictEqual(calls[0].args, ['-m', 'graphify', 'update', '.'], "'.' with cwd = root, never the absolute root");
  assert.strictEqual(calls[0].o.cwd, dir);
  assert.strictEqual(typeof calls[0].o.timeout, 'number', 'the build has a timeout (spawnSync kills only its own child)');
  assert.ok(calls[0].o.timeout > 0 && calls[0].o.timeout <= 10 * 60 * 1000);
  assert.strictEqual(calls[0].o.stdio, 'ignore', 'graphify output is not buffered (no maxBuffer kill)');
  assert.strictEqual(r.report, path.join(dir, 'graphify-out', 'GRAPH_REPORT.md'));
  const dir2 = mkProj(CODE3);
  const bad = G.ensure({ root: dir2, env: {}, found: FOUND, run: () => ({ status: 3, stdout: '', stderr: 'x' }), spawn: noSpawn, wait: true });
  assert.strictEqual(bad.status, 'unavailable');
  assert.match(bad.reason, /exit 3/);
});

test('EN-4: skipped for fewer than 3 code files, FORGE_GRAPHIFY=off, the home folder and a drive root', () => {
  const two = mkProj({ 'a.js': '1', 'b.py': '2', 'README.md': '# x', 'notes.txt': 'y' });
  const r1 = G.ensure({ root: two, env: {}, found: FOUND, run: noRun, spawn: noSpawn });
  assert.strictEqual(r1.status, 'skipped');
  assert.match(r1.reason, /2 code files/);
  const r2 = G.ensure({ root: mkProj(CODE3), env: { FORGE_GRAPHIFY: 'off' }, found: FOUND, run: noRun, spawn: noSpawn });
  assert.strictEqual(r2.status, 'skipped');
  assert.match(r2.reason, /FORGE_GRAPHIFY=off/);
  const home = mkProj(CODE3);
  const r3 = G.ensure({ root: home, home, env: {}, found: FOUND, run: noRun, spawn: noSpawn });
  assert.strictEqual(r3.status, 'skipped');
  assert.match(r3.reason, /home/);
  const drive = path.parse(ROOT).root;
  const r4 = G.ensure({ root: drive, env: {}, found: FOUND, run: noRun, spawn: noSpawn });
  assert.strictEqual(r4.status, 'skipped');
  assert.match(r4.reason, /drive root/);
});

test('EN-5: unavailable when graphify cannot be located (the real locate with fake env/home/exists)', () => {
  const dir = mkProj(CODE3);
  const r = G.ensure({ root: dir, env: { PATH: '' }, home: path.join(ROOT, 'nohome'), exists: () => false, run: noRun, spawn: noSpawn });
  assert.strictEqual(r.status, 'unavailable', JSON.stringify(r));
  assert.match(r.reason, /not found/);
  assert.strictEqual(r.graph, path.join(dir, 'graphify-out', 'graph.json'));
});

test('EN-6: a damaged graphify-out (graph.json is a folder, or graphify-out is a file) never throws', () => {
  const dir = mkProj(CODE3);
  fs.mkdirSync(path.join(dir, 'graphify-out', 'graph.json'), { recursive: true });
  const spawn = () => ({ pid: 1, unref() {} });
  const r = G.ensure({ root: dir, env: {}, found: FOUND, spawn, now: 5000 });
  assert.strictEqual(r.status, 'building', JSON.stringify(r));
  const dir2 = mkProj(Object.assign({}, CODE3, { 'graphify-out': 'not a folder' }));
  const r2 = G.ensure({ root: dir2, env: {}, found: FOUND, spawn, now: 5000 });
  assert.ok(['building', 'unavailable'].includes(r2.status), JSON.stringify(r2));
  const r3 = G.ensure({ root: path.join(ROOT, 'does-not-exist'), env: {}, found: FOUND, run: noRun, spawn: noSpawn });
  assert.strictEqual(r3.status, 'skipped');
  const r4 = G.ensure({ root: mkProj(CODE3), env: {}, found: FOUND, spawn: () => { throw new Error('EACCES'); }, now: 5000 });
  assert.strictEqual(r4.status, 'unavailable');
  assert.match(r4.reason, /EACCES/);
});

test('EN-7: CLI ensure exits 0 for a status (--json prints the contract) and 2 for bad usage', () => {
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, 'forge-graphify.cjs');
  const env = { ...process.env, FORGE_GRAPHIFY: 'off' };
  const dir = mkProj(CODE3);
  const ok = spawnSync(process.execPath, [cli, 'ensure', '--root', dir, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(ok.status, 0, ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.strictEqual(j.status, 'skipped');
  assert.deepStrictEqual(Object.keys(j).sort(), ['graph', 'out_dir', 'reason', 'report', 'status']);
  const plain = spawnSync(process.execPath, [cli, 'ensure', '--root', dir], { encoding: 'utf8', env });
  assert.strictEqual(plain.status, 0);
  assert.match(plain.stdout, /skipped/);
  for (const bad of [['ensure', '--root'], ['ensure', '--bogus'], ['ensure', '--found', 'not json'], ['ensure', '--found', '{"cmd":1,"args":[]}'], ['ensure', '--found']]) {
    const b = spawnSync(process.execPath, [cli].concat(bad), { encoding: 'utf8', env });
    assert.strictEqual(b.status, 2, bad.join(' ') + ' -> ' + b.status);
  }
  // no project marker (no .claude, no .git) and no code: the CLI says why, exit 0, no graphify is looked for
  const bare = mkProj({ 'notes.txt': 'x' }, { noMarker: true });
  const envOn = { ...process.env }; delete envOn.FORGE_GRAPHIFY;
  const nm = spawnSync(process.execPath, [cli, 'ensure', '--root', bare, '--json'], { encoding: 'utf8', env: envOn });
  assert.strictEqual(nm.status, 0, nm.stderr);
  const nj = JSON.parse(nm.stdout);
  assert.strictEqual(nj.status, 'skipped');
  assert.match(nj.reason, /no project marker/);
  assert.strictEqual(fs.existsSync(path.join(bare, 'graphify-out')), false);
});

// ---- rework round (review of the uncommitted graphify wiring): F1-F7 ----
const STAMP = '.forge-graph-stamp';
const LOCK = '.forge-build.lock';
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); } return cond(); };

test('EN-8 (F1): an update that exits 0 but leaves graph.json untouched writes a stamp -> the next call is fresh and spawns nothing; a later code edit is stale again', () => {
  const dir = mkProj(CODE3, { graphAt: 1000 });
  for (const f of ['a.js', 'src/b.py']) setMtime(path.join(dir, f), 900);
  setMtime(path.join(dir, 'src/c.ts'), 5000);
  const run = () => ({ status: 0, stdout: 'No code-graph topology changes detected; outputs left untouched.', stderr: '' });
  const r1 = G.ensure({ root: dir, env: {}, found: FOUND, run, spawn: noSpawn, wait: true });
  assert.strictEqual(r1.status, 'built', JSON.stringify(r1));
  assert.strictEqual(fs.statSync(path.join(dir, 'graphify-out', 'graph.json')).mtimeMs, 1000 * 1000, 'graph.json really untouched');
  const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'graphify-out', STAMP), 'utf8'));
  assert.strictEqual(stamp.newest, 5000 * 1000, 'the stamp holds the newest code mtime scanned BEFORE the build');
  const r2 = G.ensure({ root: dir, env: {}, spawn: noSpawn, run: noRun, locate: () => { throw new Error('no locate when fresh'); } });
  assert.strictEqual(r2.status, 'fresh', JSON.stringify(r2));
  setMtime(path.join(dir, 'a.js'), 7000);
  const spawns = [];
  const r3 = G.ensure({ root: dir, env: {}, found: FOUND, spawn: (c, a, o) => { spawns.push(a); return { pid: process.pid, unref() {} }; }, now: 7000 * 1000 });
  assert.strictEqual(r3.status, 'building', 'a code edit after the stamp is stale again');
  assert.strictEqual(spawns.length, 1);
});

test('EN-9 (F1+F5): a live lock answers building BEFORE locate(); a lock whose pid is dead is a crashed build and is replaced', () => {
  const dir = mkProj(CODE3);
  fs.mkdirSync(path.join(dir, 'graphify-out'));
  fs.writeFileSync(path.join(dir, 'graphify-out', LOCK), JSON.stringify({ pid: 777, started: 5000 }));
  const locateThrows = () => { throw new Error('locate must not run while a live build holds the lock'); };
  const live = G.ensure({ root: dir, env: {}, locate: locateThrows, spawn: noSpawn, now: 6000, isAlive: (p) => p === 777 });
  assert.strictEqual(live.status, 'building', JSON.stringify(live));
  assert.match(live.reason, /already running/);
  const spawns = [];
  const dead = G.ensure({ root: dir, env: {}, found: FOUND, spawn: (c, a) => { spawns.push(a); return { pid: 888, unref() {} }; }, now: 6000, isAlive: () => false });
  assert.strictEqual(dead.status, 'building');
  assert.strictEqual(spawns.length, 1, 'a dead lock pid does not block a new build for 15 minutes');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'graphify-out', LOCK), 'utf8')).pid, 888, 'the new lock holds the new wrapper pid');
});

test('EN-10 (F5): the probe timeout is short (5 s) when the caller does not wait, the full one with --wait', () => {
  const seen = [];
  const loc = (deps) => { seen.push(deps.probeTimeout); return { ok: false, reason: 'graphify not found (fake)' }; };
  G.ensure({ root: mkProj(CODE3), env: {}, locate: loc, spawn: noSpawn, run: noRun });
  G.ensure({ root: mkProj(CODE3), env: {}, locate: loc, spawn: noSpawn, run: noRun, wait: true });
  assert.deepStrictEqual(seen, [5000, 30000]);
});

test('EN-11 (F4): when ensure() creates graphify-out/ it writes graphify-out/.gitignore with `*`; an existing graphify-out is left alone', () => {
  const dir = mkProj(CODE3);
  G.ensure({ root: dir, env: {}, found: FOUND, spawn: () => ({ pid: process.pid, unref() {} }), now: 5000 });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'graphify-out', '.gitignore'), 'utf8').trim(), '*');
  const dir2 = mkProj(CODE3);
  G.ensure({ root: dir2, env: {}, found: FOUND, spawn: noSpawn, wait: true, run: () => ({ status: 0 }) });
  assert.strictEqual(fs.readFileSync(path.join(dir2, 'graphify-out', '.gitignore'), 'utf8').trim(), '*', 'the --wait path creates it too');
  const dir3 = mkProj(CODE3, { graphAt: 1 });
  G.ensure({ root: dir3, env: {}, found: FOUND, spawn: () => ({ pid: process.pid, unref() {} }), now: 5000 });
  assert.strictEqual(fs.existsSync(path.join(dir3, 'graphify-out', '.gitignore')), false, 'a graphify-out made by graphify is not touched');
});

test('EN-12 (F5): no project marker (no .claude folder, no .git) -> skipped; a .git FILE (a worktree) counts as a marker', () => {
  const bare = mkProj(CODE3, { noMarker: true });
  const r = G.ensure({ root: bare, env: {}, found: FOUND, spawn: noSpawn, run: noRun });
  assert.strictEqual(r.status, 'skipped', JSON.stringify(r));
  assert.match(r.reason, /no project marker/);
  assert.strictEqual(fs.existsSync(path.join(bare, 'graphify-out')), false);
  const wt = mkProj(Object.assign({}, CODE3, { '.git': 'gitdir: ../x/.git/worktrees/w\n' }), { noMarker: true });
  const r2 = G.ensure({ root: wt, env: {}, found: FOUND, spawn: () => ({ pid: process.pid, unref() {} }), now: 5000 });
  assert.strictEqual(r2.status, 'building', JSON.stringify(r2));
});

test('EN-13 (F1): code in gitignored folders (root .gitignore) and in venv/target/out/coverage does not make the graph stale', () => {
  const files = Object.assign({}, CODE3, {
    '.gitignore': '# comment\nnode_modules/\n.claude/forge-backups/\nresearch-quarantine/\n/command-center/\n.claude/forge-research/**\n!.claude/forge-research/*.md\n*.log\n',
    '.claude/forge-backups/b/x.js': '1', 'research-quarantine/q.py': '1', 'command-center/srv.mjs': '1', '.claude/forge-research/r/y.js': '1',
    'venv/lib/v.py': '1', 'target/t.rs': '1', 'out/o.js': '1', 'coverage/c.js': '1', 'pkg/out/deep.js': '1',
  });
  const dir = mkProj(files, { graphAt: 2000 });
  for (const f of ['a.js', 'src/b.py', 'src/c.ts']) setMtime(path.join(dir, f), 1000);
  for (const f of Object.keys(files).filter((k) => k.includes('/') && !k.startsWith('src/'))) setMtime(path.join(dir, f), 9000);
  const r = G.ensure({ root: dir, env: {}, spawn: noSpawn, run: noRun, locate: () => { throw new Error('no locate when fresh'); } });
  assert.strictEqual(r.status, 'fresh', JSON.stringify(r));
  setMtime(path.join(dir, 'src/b.py'), 9500);
  const r2 = G.ensure({ root: dir, env: {}, found: FOUND, spawn: () => ({ pid: process.pid, unref() {} }), now: 9600 * 1000 });
  assert.strictEqual(r2.status, 'building', 'a real code file still counts');
});

test('EN-14 (F3): a spawn error emitted after ensure() returned is swallowed by the error listener, never thrown', () => {
  const { EventEmitter } = require('events');
  const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
  const r = G.ensure({ root: mkProj(CODE3), env: {}, found: FOUND, spawn: () => child, now: 5000 });
  assert.strictEqual(r.status, 'building');
  assert.strictEqual(child.listenerCount('error'), 1, 'one error listener is attached');
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
});

test('EN-15 (F1): the --wait build reports a timeout honestly and always removes its own lock (finally), also when run throws', () => {
  const dir = mkProj(CODE3);
  const lock = path.join(dir, 'graphify-out', LOCK);
  let lockDuringRun = null;
  const t = G.ensure({ root: dir, env: {}, found: FOUND, spawn: noSpawn, wait: true, run: () => { lockDuringRun = fs.existsSync(lock); return { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }; } });
  assert.strictEqual(lockDuringRun, true, 'the --wait builder holds the lock while it builds');
  assert.strictEqual(t.status, 'unavailable');
  assert.match(t.reason, /ETIMEDOUT/);
  assert.strictEqual(fs.existsSync(lock), false, 'lock removed after a timeout');
  assert.strictEqual(fs.existsSync(path.join(dir, 'graphify-out', STAMP)), false, 'no stamp after a failed build');
  const t2 = G.ensure({ root: dir, env: {}, found: FOUND, spawn: noSpawn, wait: true, run: () => { throw new Error('kaboom'); } });
  assert.strictEqual(t2.status, 'unavailable');
  assert.strictEqual(fs.existsSync(lock), false, 'lock removed after a throw');
});

test('EN-16 (F3): a real caller process exits within seconds while the detached wrapper keeps building; cleanup by recorded pids only', async () => {
  const { spawnSync } = require('child_process');
  // The wrapper only accepts a --found that is one of candidates(): GRAPHIFY_BIN = node makes `node update .` the build,
  // and update.js in the project root is the fake graphify (no test-only seam in the tool).
  const dir = mkProj(Object.assign({}, CODE3, { 'update.js': "require('fs').writeFileSync('grandchild.pid', String(process.pid)); setTimeout(() => {}, 20000);\n" }));
  const pidFile = path.join(dir, 'grandchild.pid');
  const fake = { ok: true, cmd: process.execPath, args: [] };
  const code = 'const G = require(' + JSON.stringify(path.join(__dirname, 'forge-graphify.cjs')) + ');'
    + 'process.stdout.write(JSON.stringify(G.ensure({ root: ' + JSON.stringify(dir) + ', env: {}, found: ' + JSON.stringify(fake) + ' })));';
  const env = { ...process.env, GRAPHIFY_BIN: process.execPath }; delete env.FORGE_GRAPHIFY;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env, timeout: 15000, windowsHide: true });
  const elapsed = Date.now() - t0;
  let wrapperPid = null; let grandPid = null;
  try {
    assert.strictEqual(r.status, 0, 'caller exit ' + r.status + ' ' + r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).status, 'building');
    assert.ok(elapsed < 4000, 'the caller did not wait for the build (' + elapsed + ' ms)');
    wrapperPid = JSON.parse(fs.readFileSync(path.join(dir, 'graphify-out', LOCK), 'utf8')).pid;
    assert.strictEqual(typeof wrapperPid, 'number');
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 15000), 'the wrapper started the build');
    grandPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.strictEqual(isAlive(wrapperPid), true, 'the wrapper outlived its caller');
  } finally {
    if (grandPid && isAlive(grandPid)) process.kill(grandPid);
    if (wrapperPid && !(await until(() => !isAlive(wrapperPid), 10000))) process.kill(wrapperPid);
  }
  assert.ok(await until(() => !fs.existsSync(path.join(dir, 'graphify-out', LOCK)), 5000), 'the wrapper removed its lock when its build ended');
});

// ---- second rework round: F-A (failed builds loop), F-B (worktrees), F-E (real stdio/timeout, lock pid), F-C (--found) ----
const LAST = '.forge-build.last';
const SIX_HOURS = 6 * 3600 * 1000;
const noLocate = () => { throw new Error('locate must not run while a recorded failure holds'); };

test('EN-17 (F-A): a failed --wait build (exit 3, ETIMEDOUT, exit 0 without graph.json) is recorded; the next call is unavailable with that reason and spawns nothing', () => {
  const cases = [
    [() => ({ status: 3, stdout: '', stderr: 'x' }), /exit 3/],
    [() => ({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }), /ETIMEDOUT/],
    [() => ({ status: 0, stdout: '', stderr: '' }), /no graph\.json/],
  ];
  for (const [run, why] of cases) {
    const dir = mkProj(CODE3);
    const t0 = Date.now();
    const b = G.ensure({ root: dir, env: {}, found: FOUND, spawn: noSpawn, wait: true, run, now: t0 });
    assert.strictEqual(b.status, 'unavailable', JSON.stringify(b));
    assert.match(b.reason, why);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'graphify-out', LAST), 'utf8'));
    assert.strictEqual(rec.failed, true);
    assert.strictEqual(rec.at, t0);
    assert.strictEqual(rec.newest, Math.max(...['a.js', 'src/b.py', 'src/c.ts'].map((f) => fs.statSync(path.join(dir, f)).mtimeMs)), 'newest code mtime of the failed build');
    assert.match(rec.reason, why);
    const next = G.ensure({ root: dir, env: {}, spawn: noSpawn, run: noRun, locate: noLocate, now: t0 + 60000 });
    assert.strictEqual(next.status, 'unavailable', JSON.stringify(next));
    assert.match(next.reason, /last graph build failed/);
    assert.match(next.reason, why);
  }
});

test('EN-18 (F-A): after a recorded failure a code edit, or 6 hours, allows one new build; a good build clears the record', () => {
  const dir = mkProj(CODE3);
  const t0 = Date.now();
  G.ensure({ root: dir, env: {}, found: FOUND, spawn: noSpawn, wait: true, run: () => ({ status: 3 }), now: t0 });
  const spawns = [];
  const spawn = (c, a) => { spawns.push(a); return { pid: process.pid, unref() {} }; };
  const before = G.ensure({ root: dir, env: {}, found: FOUND, spawn, now: t0 + SIX_HOURS - 1 });
  assert.strictEqual(before.status, 'unavailable', 'still inside the 6 hours: ' + JSON.stringify(before));
  const later = G.ensure({ root: dir, env: {}, found: FOUND, spawn, now: t0 + SIX_HOURS });
  assert.strictEqual(later.status, 'building', 'after 6 hours a retry starts: ' + JSON.stringify(later));
  assert.strictEqual(spawns.length, 1);
  const dir2 = mkProj(CODE3);
  G.ensure({ root: dir2, env: {}, found: FOUND, spawn: noSpawn, wait: true, run: () => ({ status: 3 }), now: t0 });
  setMtime(path.join(dir2, 'src/b.py'), Math.ceil(t0 / 1000) + 100);
  const edited = G.ensure({ root: dir2, env: {}, found: FOUND, spawn, now: t0 + 1000 });
  assert.strictEqual(edited.status, 'building', 'a code edit after the failure starts a retry: ' + JSON.stringify(edited));
  assert.strictEqual(spawns.length, 2);
  const good = G.ensure({ root: dir2, env: {}, found: FOUND, spawn: noSpawn, wait: true, now: t0 + 2000, run: () => {
    fs.writeFileSync(path.join(dir2, 'graphify-out', 'graph.json'), '{"nodes":[{}]}');
    return { status: 0 };
  } });
  assert.strictEqual(good.status, 'built', JSON.stringify(good));
  assert.strictEqual(fs.existsSync(path.join(dir2, 'graphify-out', LAST)), false, 'a good build removes the failure record');
});

test('EN-19 (F-A): a lock without a pid (a failed async spawn) is dead: the next call starts a build instead of answering building', () => {
  const dir = mkProj(CODE3);
  fs.mkdirSync(path.join(dir, 'graphify-out'));
  fs.writeFileSync(path.join(dir, 'graphify-out', LOCK), JSON.stringify({ started: 5000 }));
  const spawns = [];
  const r = G.ensure({ root: dir, env: {}, found: FOUND, spawn: (c, a) => { spawns.push(a); return { pid: 4321, unref() {} }; }, now: 6000 });
  assert.strictEqual(r.status, 'building', JSON.stringify(r));
  assert.match(r.reason, /started/);
  assert.strictEqual(spawns.length, 1, 'a pid-less lock does not hold for 15 minutes');
});

test('EN-20 (F-B): code under .claude/worktrees, .worktrees and graphify\'s own skip folders does not make the graph stale', () => {
  const noise = ['.claude/worktrees/w1/x.js', '.worktrees/w/y.js', 'env/e.py', '.env/e.py', '.cache/c.js', 'snapshots/s.js',
    'src/__snapshots__/s.js', 'py/site-packages/p.py', 'lib64/l.py', '.idea/i.js', '.nuxt/n.js', '.svelte-kit/k.js', '.angular/a.js',
    'storybook-static/s.js', '.tox/t.py', '.eggs/e.py', 'my_venv/v.py', 'conda_env/c.py', 'pkg.egg-info/e.py', '.pytest_cache/p.py',
    'lcov-report/l.js', '.parcel-cache/p.js', '.graphify/g.js'];
  const files = Object.assign({}, CODE3);
  for (const f of noise) files[f] = '1';
  const dir = mkProj(files, { graphAt: 2000 });
  for (const f of ['a.js', 'src/b.py', 'src/c.ts']) setMtime(path.join(dir, f), 1000);
  for (const f of noise) setMtime(path.join(dir, f), 9000);
  const r = G.ensure({ root: dir, env: {}, spawn: noSpawn, run: noRun, locate: () => { throw new Error('no locate when fresh'); } });
  assert.strictEqual(r.status, 'fresh', JSON.stringify(r));
  setMtime(path.join(dir, 'src/c.ts'), 9500);
  const r2 = G.ensure({ root: dir, env: {}, found: FOUND, spawn: () => ({ pid: process.pid, unref() {} }), now: 9600 * 1000 });
  assert.strictEqual(r2.status, 'building', 'a real code file still counts');
});

test('EN-21 (F-E): the real default runner ignores graphify output: a fake that prints 2 MB before writing graph.json still ends built', () => {
  const dir = mkProj(CODE3);
  const script = "const fs = require('fs'); process.stdout.write('x'.repeat(2 * 1024 * 1024), () => { fs.mkdirSync('graphify-out', { recursive: true }); fs.writeFileSync('graphify-out/graph.json', '{}'); });";
  const r = G.ensure({ root: dir, env: {}, found: { ok: true, cmd: process.execPath, args: ['-e', script] }, spawn: noSpawn, wait: true });
  assert.strictEqual(r.status, 'built', JSON.stringify(r));
});

test('EN-22 (F-E): the real default runner applies the build timeout: a hanging fake is stopped (its own pid only) and reported', async () => {
  const dir = mkProj(CODE3);
  const pidFile = path.join(dir, 'slow.pid');
  const script = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000);";
  const t0 = Date.now();
  let pid = null;
  try {
    const r = G.ensure({ root: dir, env: {}, found: { ok: true, cmd: process.execPath, args: ['-e', script, pidFile] }, spawn: noSpawn, wait: true, buildTimeout: 1500 });
    const elapsed = Date.now() - t0;
    if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.strictEqual(r.status, 'unavailable', JSON.stringify(r));
    assert.match(r.reason, /ETIMEDOUT/);
    assert.ok(elapsed < 10000, 'the 1.5 s build timeout was used (' + elapsed + ' ms)');
    assert.ok(pid, 'the fake build really started');
    assert.ok(await until(() => !isAlive(pid), 5000), 'the timed-out build process is gone');
  } finally {
    if (pid && isAlive(pid)) process.kill(pid);
  }
});

test('EN-23 (F-E): a --wait build leaves a lock that another pid took over alone', () => {
  const dir = mkProj(CODE3);
  const lock = path.join(dir, 'graphify-out', LOCK);
  const other = process.pid + 100000;
  const r = G.ensure({ root: dir, env: {}, found: FOUND, spawn: noSpawn, wait: true, run: () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: other, started: 1 }));
    fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), '{}');
    return { status: 0 };
  } });
  assert.strictEqual(r.status, 'built', JSON.stringify(r));
  assert.strictEqual(fs.existsSync(lock), true, 'the other builder\'s lock is not removed');
  assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, other);
});

test('EN-24 (F-C): CLI --found is accepted only when it is one of candidates() (args [] or -m graphify), else exit 2', () => {
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, 'forge-graphify.cjs');
  const env = { ...process.env, FORGE_GRAPHIFY: 'off', GRAPHIFY_BIN: process.execPath };
  const uv = G.candidates({ env, home: os.homedir(), platform: process.platform }).find((c) => c.source === 'uv-tool-python');
  const call = (found, e) => spawnSync(process.execPath, [cli, 'ensure', '--root', ROOT, '--found', JSON.stringify(found)], { encoding: 'utf8', env: e || env }).status;
  assert.strictEqual(call({ cmd: process.execPath, args: [] }), 0, 'GRAPHIFY_BIN with no args');
  assert.strictEqual(call({ cmd: uv.cmd, args: ['-m', 'graphify'] }), 0, 'the uv tool python with -m graphify');
  assert.strictEqual(call({ cmd: path.join(ROOT, 'evil', 'graphify.exe'), args: [] }), 2, 'not a candidate path');
  assert.strictEqual(call({ cmd: process.execPath, args: ['-e', '1'] }), 2, 'a candidate path with other args');
  assert.strictEqual(call({ cmd: process.execPath, args: ['-m', 'graphify'] }), 2, 'GRAPHIFY_BIN takes no args');
  assert.strictEqual(call({ cmd: uv.cmd, args: [] }), 2, 'the uv python needs -m graphify');
  const noBin = { ...env }; delete noBin.GRAPHIFY_BIN;
  assert.strictEqual(call({ cmd: process.execPath, args: [] }, noBin), 2, 'without GRAPHIFY_BIN node is no candidate');
});

test('HELP-1: forge-graphify.cjs --help and -h print usage and exit 0 without probing', () => {
  const { spawnSync } = require('child_process');
  for (const flag of ['--help', '-h']) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-graphify.cjs'), flag], { encoding: 'utf8', env: { ...process.env, GRAPHIFY_BIN: 'C:\no\such\graphify.exe' } });
    assert.strictEqual(r.status, 0, flag + ' exit ' + r.status + ' ' + r.stderr);
    assert.match(r.stdout, /usage:/i);
  }
});
