#!/usr/bin/env node
'use strict';
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

test('HELP-1: forge-graphify.cjs --help and -h print usage and exit 0 without probing', () => {
  const { spawnSync } = require('child_process');
  for (const flag of ['--help', '-h']) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-graphify.cjs'), flag], { encoding: 'utf8', env: { ...process.env, GRAPHIFY_BIN: 'C:\no\such\graphify.exe' } });
    assert.strictEqual(r.status, 0, flag + ' exit ' + r.status + ' ' + r.stderr);
    assert.match(r.stdout, /usage:/i);
  }
});
