#!/usr/bin/env node
'use strict';
// Tests for forge-ecc-path.cjs (W2-ECCPATH). Fixtures are a fake home and a fake project under
// os.tmpdir(); only the last case touches the real install, and it only checks that the tool runs and finds
// at least one ecc skill.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./forge-ecc-path.cjs');

const TOOL = path.join(__dirname, 'forge-ecc-path.cjs');
let pass = 0, fail = 0, skipped = 0;
// W2-H1B-SCOUT L1: a case that needs something only some machines have SKIPS visibly (counted as skipped,
// never as passed). FORGE_TEST_HOME (test-only) points the real-install case at another home, e.g. an empty one.
const skip = (name, why) => { skipped++; console.log('  skip ' + name + ' — ' + why); };
const REAL_HOME = process.env.FORGE_TEST_HOME ? path.resolve(process.env.FORGE_TEST_HOME) : os.homedir();
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + (e && e.message || e)); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ecc-path-'));
const home = path.join(tmp, 'home');
const project = path.join(tmp, 'proj');
const skill = (dir, name) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), '---\nname: ' + name + '\n---\n'); };
const gSkills = path.join(home, '.claude', 'skills');
const eccSkills = path.join(gSkills, 'ecc');
const pSkills = path.join(project, '.claude', 'skills');
const pluginInstall = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'helper', '1.0.0');

skill(eccSkills, 'skill-stocktake');
skill(eccSkills, 'skill-scout');
skill(eccSkills, 'shared');
skill(gSkills, 'shared');
skill(gSkills, 'global-only');
skill(pSkills, 'shared');
skill(path.join(gSkills, 'nested'), 'deep');         // ~/.claude/skills/nested/deep/SKILL.md, depth 3
fs.mkdirSync(path.join(gSkills, 'no-skill-md'), { recursive: true });
skill(path.join(pluginInstall, 'skills'), 'plug-skill');
skill(path.join(pluginInstall, 'skills'), 'skill-scout');
fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
  version: 2, plugins: { 'helper@mkt': [{ scope: 'user', installPath: pluginInstall }], 'broken@mkt': [{ installPath: path.join(tmp, 'gone') }] },
}));
const opts = { home, project };
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args, '--home', home, '--project', project], { encoding: 'utf8' });

try {
  t('roots come in order project, global, ecc, plugin; a plugin with a missing install path is left out', () => {
    const r = E.skillRoots(opts);
    assert.deepStrictEqual(r.map((x) => x.source), ['project', 'global', 'ecc', 'plugin']);
    assert.strictEqual(r[3].plugin, 'helper@mkt');
  });

  t('resolve finds an ECC skill under skills/ecc/<name> (the path ECC itself hard-codes wrongly)', () => {
    const hit = E.resolveSkill('skill-stocktake', opts);
    assert.ok(hit, 'not found');
    assert.strictEqual(hit.source, 'ecc');
    assert.strictEqual(hit.path, path.join(eccSkills, 'skill-stocktake'));
    assert.ok(path.isAbsolute(hit.path));
  });

  t('resolve: project shadows global shadows ecc', () => {
    assert.strictEqual(E.resolveSkill('shared', opts).source, 'project');
    assert.strictEqual(E.resolveSkill('shared', { home, project: path.join(tmp, 'elsewhere') }).source, 'global');
    assert.strictEqual(E.resolveSkill('global-only', opts).source, 'global');
  });

  t('resolve: ecc comes before a plugin skill of the same name; plugin-qualified names reach the plugin', () => {
    assert.strictEqual(E.resolveSkill('skill-scout', opts).source, 'ecc');
    const q = E.resolveSkill('helper:skill-scout', opts);
    assert.strictEqual(q.source, 'plugin');
    assert.strictEqual(q.plugin, 'helper@mkt');
    assert.strictEqual(E.resolveSkill('plug-skill', opts).source, 'plugin');
    assert.strictEqual(E.resolveSkill('other:plug-skill', opts), null);
  });

  t('resolve: a folder without SKILL.md and the ecc container itself are not skills', () => {
    assert.strictEqual(E.resolveSkill('no-skill-md', opts), null);
    assert.strictEqual(E.resolveSkill('ecc', opts), null);
    assert.strictEqual(E.resolveSkill('missing', opts), null);
  });

  t('without --project the root is the nearest folder above the cwd with .claude/skills, never the home folder', () => {
    const sub = path.join(project, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    assert.strictEqual(E.findProjectRoot(sub, home), project);
    assert.strictEqual(E.resolveSkill('shared', { home, cwd: sub }).source, 'project');
    const inHome = path.join(home, 'work');
    fs.mkdirSync(inHome, { recursive: true });
    assert.strictEqual(E.findProjectRoot(inHome, home), inHome, 'walked up into the home folder');
    assert.strictEqual(E.resolveSkill('shared', { home, cwd: inHome }).source, 'global');
  });

  t('resolve refuses path tricks', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '..', '', 'a:b:c', '/abs']) assert.throws(() => E.resolveSkill(bad, opts), /invalid skill name/, bad);
  });

  t('list (default depth 2) labels every SKILL.md, keeps ecc out of the global label, skips depth-3 files', () => {
    const items = E.listSkills(opts);
    const key = (i) => i.source + ':' + i.name;
    const keys = items.map(key).sort();
    assert.deepStrictEqual(keys, ['ecc:shared', 'ecc:skill-scout', 'ecc:skill-stocktake', 'global:global-only', 'global:shared',
      'plugin:plug-skill', 'plugin:skill-scout', 'project:shared'].sort());
    assert.ok(items.every((i) => path.isAbsolute(i.skillMd) && i.skillMd.endsWith('SKILL.md')));
  });

  t('list --depth 3 reaches nested skills, still without listing ecc twice', () => {
    const items = E.listSkills(Object.assign({ depth: 3 }, opts));
    assert.ok(items.some((i) => i.source === 'global' && i.name === 'deep'));
    assert.ok(!items.some((i) => i.source === 'global' && i.skillMd.includes(path.sep + 'ecc' + path.sep)));
    assert.throws(() => E.listSkills(Object.assign({ depth: 0 }, opts)), /depth/);
    assert.throws(() => E.listSkills(Object.assign({ depth: 'x' }, opts)), /depth/);
  });

  t('CLI resolve prints the path (exit 0), --json gives the record, a miss exits 1 with a clear message', () => {
    const r = run('resolve', 'skill-stocktake');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), path.join(eccSkills, 'skill-stocktake'));
    const j = JSON.parse(run('resolve', 'skill-stocktake', '--json').stdout);
    assert.strictEqual(j.ok, true); assert.strictEqual(j.source, 'ecc');
    const miss = run('resolve', 'nope');
    assert.strictEqual(miss.status, 1);
    assert.match(miss.stderr, /skill not found: nope \(searched /);
    const mj = run('resolve', 'nope', '--json');
    assert.strictEqual(mj.status, 1); assert.strictEqual(JSON.parse(mj.stdout).ok, false);
  });

  t('CLI list --json counts items; bad usage exits 2', () => {
    const j = JSON.parse(run('list', '--json').stdout);
    assert.strictEqual(j.ok, true); assert.strictEqual(j.count, 8); assert.strictEqual(j.items.length, 8);
    assert.strictEqual(run('list', '--depth', '0').status, 2);
    assert.strictEqual(run('bogus').status, 2);
    assert.strictEqual(run('resolve').status, 2);
    assert.strictEqual(run('resolve', '../x').status, 2);
    assert.strictEqual(run('list', '--wat').status, 2);
  });

  const SMOKE = 'smoke (real install, read-only): runs and finds at least one ecc skill';
  const realEcc = path.join(REAL_HOME, '.claude', 'skills', 'ecc');
  const hasEcc = fs.existsSync(realEcc) && fs.readdirSync(realEcc).some((d) => fs.existsSync(path.join(realEcc, d, 'SKILL.md')));
  if (!hasEcc) skip(SMOKE, 'no ECC install with a SKILL.md under ' + realEcc);
  else t(SMOKE, () => {
    const r = spawnSync(process.execPath, [TOOL, 'list', '--json', '--home', REAL_HOME], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok(j.items.some((i) => i.source === 'ecc'), 'no ecc skill found in the real install');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nforge-ecc-path tests:');
console.log(pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped');
process.exit(fail ? 1 : 0);
