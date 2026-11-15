#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-pack.test.cjs — the generic agent-pack check (owner request R-0239: "maak ook agents for website en andere
 * projecten"). Covers: a valid two-pack tree is green; every red condition is red with its message (agent file missing,
 * name differs, no model or effort, unrouted, a route that is not a GOAT route, frontmatter that differs from its route,
 * not a specialist, listed as a Boss, a pack or preset skill that does not ship, a missing <name>-all or process
 * preset, no router row, a description over 160 characters, a playbook that does not ship, an agent in two packs);
 * the n/a cases; the --pack filter; the CLI exit codes; and the real tree loads every pack file. Throwaway roots only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const PACKS = require('./forge-pack.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); }
};
const repoRoot = path.resolve(__dirname, '..', '..');
const roots = [];
const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pack-')); roots.push(r); return r; };
const w = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const edit = (root, rel, fn) => { const f = path.join(root, ...rel.split('/')); fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))); };
const editJson = (root, rel, fn) => edit(root, rel, (s) => { const j = JSON.parse(s); fn(j); return JSON.stringify(j); });
const packOf = (r, name) => (r.packs || []).find((p) => p.name === name) || { problems: [] };
const has = (p, needle) => (p.problems || []).some((x) => x.includes(needle));

const agentMd = (name, model, effort, desc) => '---\nname: ' + name + '\ndescription: "' + (desc || 'Use for ' + name + '.') + '"\nmodel: ' + model + '\neffort: ' + effort + '\n---\n# ' + name + '\n';

// Two complete packs: alpha (al-a build, al-b verifier) and beta (be-a build).
function fixture() {
  const root = tmp();
  w(root, '.claude/config/packs/alpha.json', JSON.stringify({
    schema: 'forge-pack/v1', name: 'alpha', signals: ['alpha site', 'landing'], playbook: 'forge-alpha',
    agents: ['al-a', 'al-b'], skills: ['alpha-x'],
    presets: { 'alpha-all': ['alpha-x', 'forge-alpha'], process: ['forge-conduct'] },
  }, null, 2));
  w(root, '.claude/config/packs/beta.json', JSON.stringify({
    schema: 'forge-pack/v1', name: 'beta', signals: ['beta app'], playbook: 'forge-beta',
    agents: ['be-a'], skills: ['beta-x'],
    presets: { 'beta-all': ['beta-x'], process: ['forge-conduct'] },
  }, null, 2));
  for (const s of ['alpha-x', 'beta-x', 'forge-alpha', 'forge-beta', 'forge-conduct']) w(root, '.claude/skills/' + s + '/SKILL.md', '---\nname: ' + s + '\ndescription: "Use when x."\n---\n# ' + s + '\n');
  w(root, '.claude/skills/forge-router/SKILL.md', '---\nname: forge-router\ndescription: "Use first."\n---\n'
    + '| website, landing | Alpha site | `forge-alpha` + the alpha pack (`al-*` specialists) |\n'
    + '| beta app, CRUD | Beta app | `forge-beta` + `be-a` |\n');
  w(root, '.claude/agents/al-a.md', agentMd('al-a', 'opus', 'medium'));
  w(root, '.claude/agents/al-b.md', agentMd('al-b', 'sonnet', 'medium'));
  w(root, '.claude/agents/be-a.md', agentMd('be-a', 'opus', 'medium'));
  w(root, '.claude/FORGE_MODEL_ROUTING.json', JSON.stringify({
    routes: { build: { model: 'opus', effort: 'medium' }, verifier: { model: 'sonnet', effort: 'medium' } },
    agentDefaults: { 'al-a': 'build', 'al-b': 'verifier', 'be-a': 'build' },
  }));
  w(root, '.claude/config/agents/agent-registry.json', JSON.stringify({
    agents: { boss: { agentFile: '.claude/agents/boss.md' } },
    specialistAgents: { 'al-a': {}, 'al-b': {}, 'be-a': {} },
  }));
  return root;
}
const check = (root, o) => PACKS.packCheck(root, Object.assign({ devTree: true }, o || {}));
const red = (name, mutate, packName, needles) => {
  const r = fixture(); mutate(r);
  const res = check(r);
  const p = packOf(res, packName);
  t('mutant: ' + name, res.ok === false && p.ok === false && needles.every((n) => has(p, n)) && res.problems.some((x) => x.startsWith('pack ' + packName + ': ')), JSON.stringify(res.problems));
};

try {
  // 1. A valid two-pack tree is green.
  const ok = check(fixture());
  t('fixture: two valid packs are green', ok.ok === true && ok.applicable === true && ok.problems.length === 0, JSON.stringify(ok));
  t('fixture: both packs reported with counts', ok.packs.length === 2 && packOf(ok, 'alpha').agents === 2 && packOf(ok, 'alpha').skills === 1 && packOf(ok, 'beta').agents === 1 && packOf(ok, 'beta').ok === true, JSON.stringify(ok.packs));
  t('loadPacks lists every pack file', PACKS.loadPacks(fixture()).map((p) => p.name).sort().join(',') === 'alpha,beta');

  // 2. Every red condition, with its message.
  red('missing agent file is red', (r) => fs.unlinkSync(path.join(r, '.claude', 'agents', 'al-b.md')), 'alpha', ['agent al-b: agent file missing']);
  red('frontmatter name that differs is red', (r) => edit(r, '.claude/agents/al-a.md', (s) => s.replace('name: al-a', 'name: al-z')), 'alpha', ['agent al-a: frontmatter name is "al-z"']);
  red('agent without an effort line is red', (r) => edit(r, '.claude/agents/be-a.md', (s) => s.replace('effort: medium\n', '')), 'beta', ['agent be-a: frontmatter needs both model and effort']);
  red('unrouted agent is red', (r) => editJson(r, '.claude/FORGE_MODEL_ROUTING.json', (j) => { delete j.agentDefaults['al-a']; }), 'alpha', ['agent al-a: unrouted']);
  red('a default route that is not a GOAT route is red', (r) => editJson(r, '.claude/FORGE_MODEL_ROUTING.json', (j) => { j.agentDefaults['be-a'] = 'turbo'; }), 'beta', ['agent be-a: default route "turbo" is not a GOAT route']);
  red('frontmatter that differs from its route is red', (r) => edit(r, '.claude/agents/al-a.md', (s) => s.replace('effort: medium', 'effort: high')), 'alpha', ['agent al-a: frontmatter opus/high differs from its default route build']);
  red('agent not a registered specialist is red', (r) => editJson(r, '.claude/config/agents/agent-registry.json', (j) => { delete j.specialistAgents['be-a']; }), 'beta', ['agent be-a: not a specialist']);
  red('pack agent listed as a Boss is red', (r) => editJson(r, '.claude/config/agents/agent-registry.json', (j) => { j.agents['al-b'] = {}; }), 'alpha', ['agent al-b: listed as a permanent Boss']);
  red('missing pack skill is red', (r) => fs.rmSync(path.join(r, '.claude', 'skills', 'beta-x'), { recursive: true, force: true }), 'beta', ['skill beta-x: missing']);
  red('preset naming an unshipped skill is red', (r) => editJson(r, '.claude/config/packs/alpha.json', (j) => { j.presets['alpha-all'].push('alpha-ghost'); }), 'alpha', ['preset alpha-all: alpha-ghost is not a shipped skill']);
  red('a pack without its <name>-all preset is red', (r) => editJson(r, '.claude/config/packs/beta.json', (j) => { delete j.presets['beta-all']; }), 'beta', ['presets must hold the beta-all and process lists']);
  red('a pack without the process preset is red', (r) => editJson(r, '.claude/config/packs/alpha.json', (j) => { delete j.presets.process; }), 'alpha', ['presets must hold the alpha-all and process lists']);
  red('a router without a row for the pack is red', (r) => edit(r, '.claude/skills/forge-router/SKILL.md', (s) => s.replace(/\| beta app[^\n]*\n/, '')), 'beta', ['router: forge-router has no intent-map row that sends Beta work to the pack']);
  red('a router row naming the pack but none of its agents is red', (r) => edit(r, '.claude/skills/forge-router/SKILL.md', (s) => s.replace('`al-*` specialists', 'specialists')), 'alpha', ['router: forge-router has no intent-map row that sends Alpha work to the pack (al-* agents)']);
  red('a description over 160 characters is red', (r) => edit(r, '.claude/agents/al-a.md', (s) => s.replace(/description: "[^"]*"/, 'description: "' + 'x'.repeat(161) + '"')), 'alpha', ['agent al-a: description is 161 characters (at most 160)']);
  red('a playbook that does not ship is red', (r) => editJson(r, '.claude/config/packs/beta.json', (j) => { j.playbook = 'forge-ghost'; }), 'beta', ['playbook forge-ghost: not a shipped skill']);
  red('a pack name that differs from its file name is red', (r) => editJson(r, '.claude/config/packs/beta.json', (j) => { j.name = 'gamma'; }), 'beta', ['name must equal the file name']);
  red('a broken pack file is red', (r) => edit(r, '.claude/config/packs/beta.json', () => '{ not json'), 'beta', ['pack file .claude/config/packs/beta.json unreadable']);

  // 3. An agent in two packs is red in both.
  let r = fixture(); editJson(r, '.claude/config/packs/beta.json', (j) => { j.agents.push('al-a'); });
  let res = check(r);
  t('duplicate: an agent in two packs is red in both packs', res.ok === false && has(packOf(res, 'alpha'), 'agent al-a: also in pack beta') && has(packOf(res, 'beta'), 'agent al-a: also in pack alpha'), JSON.stringify(res.problems));
  t('duplicate: the --pack filter still sees the other pack', has(packOf(check(r, { pack: 'beta' }), 'beta'), 'also in pack alpha'));

  // 4. coreOnly (the Roblox wrapper) runs only the checks that existed before packs were generic.
  r = fixture(); edit(r, '.claude/agents/al-a.md', (s) => s.replace(/description: "[^"]*"/, 'description: "' + 'x'.repeat(200) + '"'));
  editJson(r, '.claude/config/packs/alpha.json', (j) => { j.playbook = 'forge-ghost'; });
  editJson(r, '.claude/config/packs/beta.json', (j) => { j.agents.push('al-a'); });
  res = check(r, { pack: 'alpha', coreOnly: true });
  t('coreOnly: description, playbook and duplicate checks are skipped', res.ok === true && packOf(res, 'alpha').ok === true, JSON.stringify(res.problems));

  // 5. The --pack filter and the n/a cases.
  res = check(fixture(), { pack: 'beta' });
  t('--pack: only the named pack is reported', res.ok === true && res.packs.length === 1 && res.packs[0].name === 'beta', JSON.stringify(res.packs));
  r = fixture(); fs.unlinkSync(path.join(r, '.claude', 'config', 'packs', 'beta.json'));
  res = check(r, { pack: 'beta' });
  t('--pack: a missing named pack file in the development tree is red', res.ok === false && has(packOf(res, 'beta'), 'pack file .claude/config/packs/beta.json missing'), JSON.stringify(res));
  res = check(r, { pack: 'beta', devTree: false });
  t('--pack: a missing named pack file in an older project is n/a', res.ok === true && res.applicable === false && /before the Beta pack/.test(res.reason), JSON.stringify(res));

  r = fixture(); fs.rmSync(path.join(r, '.claude', 'config', 'packs'), { recursive: true, force: true });
  res = check(r, { devTree: false });
  t('no packs folder in an older project is n/a, never red', res.ok === true && res.applicable === false && res.packs.length === 0, JSON.stringify(res));
  res = check(r);
  t('no packs folder in the development tree is red', res.ok === false && res.applicable === true && res.problems.some((x) => x.includes('no pack files')), JSON.stringify(res));
  fs.unlinkSync(path.join(r, '.claude', 'config', 'agents', 'agent-registry.json'));
  res = check(r);
  t('a development tree that is no template (no agent registry) without packs is n/a', res.ok === true && res.applicable === false, JSON.stringify(res));

  // 6. CLI: exit 0 ok, 1 red, 2 usage; --json prints the result.
  const cli = (args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-pack.cjs'), ...args], { encoding: 'utf8' });
  let c = cli(['--root', fixture(), '--json']);
  let parsed = null; try { parsed = JSON.parse(c.stdout); } catch { /* reported below */ }
  t('cli: green tree exits 0 with JSON', c.status === 0 && parsed && parsed.ok === true && parsed.packs.length === 2, c.status + ' ' + c.stdout + c.stderr);
  r = fixture(); fs.unlinkSync(path.join(r, '.claude', 'agents', 'be-a.md'));
  c = cli(['--root', r]);
  t('cli: red tree exits 1 and names the problem', c.status === 1 && /beta: RED/.test(c.stdout) && /agent be-a: agent file missing/.test(c.stdout), c.status + ' ' + c.stdout);
  c = cli(['--root', r, '--pack', 'alpha']);
  t('cli: --pack alpha on that tree exits 0', c.status === 0 && /alpha: OK/.test(c.stdout), c.status + ' ' + c.stdout);
  t('cli: --root without a value is usage (2)', cli(['--root']).status === 2);
  t('cli: --pack with a bad name is usage (2)', cli(['--root', r, '--pack', '../x']).status === 2);
  t('cli: an unknown flag is usage (2)', cli(['--bogus']).status === 2);

  // 7. The real tree: every pack file loads, and the Roblox pack passes the core checks.
  const real = PACKS.loadPacks(repoRoot);
  t('real repo: every pack file loads', real.length >= 1 && real.every((p) => p.pack && !p.error), JSON.stringify(real.map((p) => [p.name, p.error])));
  const core = check(repoRoot, { pack: 'roblox', coreOnly: true });
  t('real repo: the Roblox pack passes the core checks', core.ok === true && packOf(core, 'roblox').agents === 12, JSON.stringify(core.problems));
} finally {
  for (const x of roots) { try { fs.rmSync(x, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed (forge-pack)');
process.exit(fail ? 1 : 0);
