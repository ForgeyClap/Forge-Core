#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-roblox-pack.test.cjs — the Roblox pack check (owner 2026-11-11: "the new Forge template must also contain the
 * Roblox agents"). Covers: the real repo is complete (12 pack agents, each a routed specialist, every pack and preset
 * skill shipped, the router names the pack); and every way the pack can break turns the check red: a missing agent
 * file, an unrouted agent, a frontmatter route that differs from its default route, an agent that is not a registered
 * specialist, a pack agent among the 12 permanent Bosses, a missing skill, an unknown preset skill, a router without
 * the Roblox line, and a missing pack file in the development tree. Throwaway roots only; never reads ~/.claude.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const PACK = require('./forge-roblox-pack.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); }
};
const repoRoot = path.resolve(__dirname, '..', '..');
const roots = [];
const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rbxpack-')); roots.push(r); return r; };
const w = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const has = (r, needle) => (r.problems || []).some((p) => p.includes(needle));

// A small but complete pack in a throwaway root: two agents, two skills, one preset.
function fixture() {
  const root = tmp();
  w(root, '.claude/config/packs/roblox.json', JSON.stringify({
    schema: 'forge-pack/v1', name: 'roblox', agents: ['rbx-a', 'rbx-b'], skills: ['roblox-x', 'roblox-y'],
    presets: { 'roblox-all': ['roblox-x', 'roblox-y', 'forge-conduct'], process: ['forge-conduct'] },
  }, null, 2));
  for (const s of ['roblox-x', 'roblox-y', 'forge-conduct']) w(root, '.claude/skills/' + s + '/SKILL.md', '---\nname: ' + s + '\ndescription: "Use when x."\n---\n# ' + s + '\n');
  w(root, '.claude/skills/forge-router/SKILL.md', '---\nname: forge-router\ndescription: "Use first."\n---\n| roblox, Luau, Studio | Roblox game | `forge-game` + Roblox pack (`rbx-*` agents) |\n');
  w(root, '.claude/agents/rbx-a.md', '---\nname: rbx-a\ndescription: "A."\nmodel: opus\neffort: medium\n---\n# A\n');
  w(root, '.claude/agents/rbx-b.md', '---\nname: rbx-b\ndescription: "B."\nmodel: sonnet\neffort: medium\n---\n# B\n');
  w(root, '.claude/FORGE_MODEL_ROUTING.json', JSON.stringify({
    routes: { build: { model: 'opus', effort: 'medium' }, verifier: { model: 'sonnet', effort: 'medium' } },
    agentDefaults: { 'rbx-a': 'build', 'rbx-b': 'verifier' },
  }));
  w(root, '.claude/config/agents/agent-registry.json', JSON.stringify({
    agents: { boss: { agentFile: '.claude/agents/boss.md' } },
    specialistAgents: { 'rbx-a': { agentFile: '.claude/agents/rbx-a.md' }, 'rbx-b': { agentFile: '.claude/agents/rbx-b.md' } },
  }));
  return root;
}
const edit = (root, rel, fn) => { const f = path.join(root, ...rel.split('/')); fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))); };
const editJson = (root, rel, fn) => edit(root, rel, (s) => { const j = JSON.parse(s); fn(j); return JSON.stringify(j); });

try {
  // 1. The real repo carries the complete pack.
  const real = PACK.packCheck(repoRoot, { devTree: true });
  t('real repo: pack check is green', real.ok === true && real.applicable === true, JSON.stringify(real.problems));
  t('real repo: 12 pack agents', real.agents === 12, real.agents);
  t('real repo: at least 20 pack skills', real.skills >= 20, real.skills);
  let pack = { agents: [], presets: {} };
  try { pack = JSON.parse(fs.readFileSync(path.join(repoRoot, PACK.PACK_REL), 'utf8')); } catch (e) { t('real repo: pack file readable', false, e.message); }
  t('real repo: every pack agent is rbx-*', pack.agents.every((a) => /^rbx-[a-z-]+$/.test(a)), pack.agents.join(','));
  t('real repo: roblox-all and process presets exist', Array.isArray(pack.presets['roblox-all']) && Array.isArray(pack.presets.process) && pack.presets['roblox-all'].length >= 10, Object.keys(pack.presets));
  const reg = JSON.parse(fs.readFileSync(path.join(repoRoot, '.claude', 'config', 'agents', 'agent-registry.json'), 'utf8'));
  t('real repo: the 12 permanent Bosses are untouched', Object.keys(reg.agents).length === 12 && !Object.keys(reg.agents).some((a) => a.startsWith('rbx-')), Object.keys(reg.agents).join(','));
  const projectWords = /Driftbook|PLAZA_DESIGN|STYLE_BIBLE|fwjelaa|RULES_V2/i;
  const leaks = pack.agents.filter((a) => projectWords.test(fs.readFileSync(path.join(repoRoot, '.claude', 'agents', a + '.md'), 'utf8')));
  t('real repo: no pack agent carries project-specific text of the source project', leaks.length === 0, leaks.join(','));

  // 2. A complete fixture is green.
  const ok = PACK.packCheck(fixture(), { devTree: true });
  t('fixture: complete pack is green', ok.ok === true && ok.agents === 2 && ok.skills === 2, JSON.stringify(ok));

  // 3. Mutants: every break turns it red, with a named problem.
  let r = fixture(); fs.unlinkSync(path.join(r, '.claude', 'agents', 'rbx-b.md'));
  let res = PACK.packCheck(r, { devTree: true });
  t('mutant: missing agent file is red', res.ok === false && has(res, 'rbx-b') && has(res, 'agent file missing'), JSON.stringify(res.problems));

  r = fixture(); editJson(r, '.claude/FORGE_MODEL_ROUTING.json', (j) => { delete j.agentDefaults['rbx-a']; });
  res = PACK.packCheck(r, { devTree: true });
  t('mutant: unrouted agent is red', res.ok === false && has(res, 'rbx-a') && has(res, 'unrouted'), JSON.stringify(res.problems));

  r = fixture(); edit(r, '.claude/agents/rbx-a.md', (s) => s.replace('effort: medium', 'effort: high'));
  res = PACK.packCheck(r, { devTree: true });
  t('mutant: frontmatter route differs from the default route is red', res.ok === false && has(res, 'rbx-a') && has(res, 'route'), JSON.stringify(res.problems));

  r = fixture(); edit(r, '.claude/agents/rbx-a.md', (s) => s.replace('effort: medium\n', ''));
  res = PACK.packCheck(r, { devTree: true });
  t('mutant: agent without an effort line is red', res.ok === false && has(res, 'rbx-a'), JSON.stringify(res.problems));

  r = fixture(); editJson(r, '.claude/config/agents/agent-registry.json', (j) => { delete j.specialistAgents['rbx-b']; });
  res = PACK.packCheck(r, { devTree: true });
  t('mutant: agent not a registered specialist is red', res.ok === false && has(res, 'rbx-b') && has(res, 'specialist'), JSON.stringify(res.problems));

  r = fixture(); editJson(r, '.claude/config/agents/agent-registry.json', (j) => { j.agents['rbx-a'] = { agentFile: '.claude/agents/rbx-a.md' }; });
  res = PACK.packCheck(r, { devTree: true });
  t('mutant: pack agent among the permanent Bosses is red', res.ok === false && has(res, 'permanent Boss'), JSON.stringify(res.problems));

  r = fixture(); fs.rmSync(path.join(r, '.claude', 'skills', 'roblox-y'), { recursive: true, force: true });
  res = PACK.packCheck(r, { devTree: true });
  t('mutant: missing pack skill is red', res.ok === false && has(res, 'roblox-y'), JSON.stringify(res.problems));

  r = fixture(); editJson(r, '.claude/config/packs/roblox.json', (j) => { j.presets['roblox-all'].push('roblox-ghost'); });
  res = PACK.packCheck(r, { devTree: true });
  t('mutant: preset naming an unshipped skill is red', res.ok === false && has(res, 'roblox-ghost'), JSON.stringify(res.problems));

  r = fixture(); edit(r, '.claude/skills/forge-router/SKILL.md', (s) => s.replace(/\| roblox[^\n]*\n/, ''));
  res = PACK.packCheck(r, { devTree: true });
  t('mutant: router without the Roblox pack line is red', res.ok === false && has(res, 'router'), JSON.stringify(res.problems));

  r = fixture(); fs.unlinkSync(path.join(r, ...PACK.PACK_REL.split('/')));
  res = PACK.packCheck(r, { devTree: true });
  t('no pack file in the development tree is red', res.ok === false && has(res, 'pack file'), JSON.stringify(res));
  res = PACK.packCheck(r, { devTree: false });
  t('no pack file in an older project is n/a, never red', res.ok === true && res.applicable === false, JSON.stringify(res));

  fs.unlinkSync(path.join(r, '.claude', 'config', 'agents', 'agent-registry.json'));
  res = PACK.packCheck(r, { devTree: true });
  t('a development tree that is no template (no agent registry) without a pack file is n/a', res.ok === true && res.applicable === false, JSON.stringify(res));

  r = fixture(); edit(r, PACK.PACK_REL, () => '{ not json');
  res = PACK.packCheck(r, { devTree: false });
  t('a broken pack file is red everywhere', res.ok === false && has(res, 'pack file'), JSON.stringify(res));

  // 3b. Exact shape and messages are pinned (forge-roblox-pack.cjs is a thin wrapper over forge-pack.cjs since
  // 2026-11-13; the doctor and older readers rely on these strings and keys).
  const exact = (name, mutate, expected) => {
    const x = fixture(); mutate(x);
    const got = PACK.packCheck(x, { devTree: true });
    t('exact: ' + name, JSON.stringify(got) === JSON.stringify({ ok: false, applicable: true, problems: expected, agents: 2, skills: 2 }), JSON.stringify(got));
  };
  t('exact: a green fixture has exactly the old keys', JSON.stringify(PACK.packCheck(fixture(), { devTree: true })) === JSON.stringify({ ok: true, applicable: true, problems: [], agents: 2, skills: 2 }));
  exact('missing agent file', (x) => fs.unlinkSync(path.join(x, '.claude', 'agents', 'rbx-b.md')), ['agent rbx-b: agent file missing (.claude/agents/rbx-b.md)']);
  exact('unrouted', (x) => editJson(x, '.claude/FORGE_MODEL_ROUTING.json', (j) => { delete j.agentDefaults['rbx-a']; }), ['agent rbx-a: unrouted (no agentDefaults entry in FORGE_MODEL_ROUTING.json)']);
  exact('route differs', (x) => edit(x, '.claude/agents/rbx-a.md', (s) => s.replace('effort: medium', 'effort: high')), ['agent rbx-a: frontmatter opus/high differs from its default route build (opus/medium)']);
  exact('no effort', (x) => edit(x, '.claude/agents/rbx-a.md', (s) => s.replace('effort: medium\n', '')), ['agent rbx-a: frontmatter needs both model and effort (GOAT)']);
  exact('not a specialist', (x) => editJson(x, '.claude/config/agents/agent-registry.json', (j) => { delete j.specialistAgents['rbx-b']; }), ['agent rbx-b: not a specialist in agent-registry.json specialistAgents']);
  exact('listed as a Boss', (x) => editJson(x, '.claude/config/agents/agent-registry.json', (j) => { j.agents['rbx-a'] = {}; }), ['agent rbx-a: listed as a permanent Boss; pack agents are specialists only']);
  exact('missing skill', (x) => fs.rmSync(path.join(x, '.claude', 'skills', 'roblox-y'), { recursive: true, force: true }), ['skill roblox-y: missing (.claude/skills/roblox-y/SKILL.md)', 'preset roblox-all: roblox-y is not a shipped skill']);
  exact('router line', (x) => edit(x, '.claude/skills/forge-router/SKILL.md', (s) => s.replace(/\| roblox[^\n]*\n/, '')), ['router: forge-router has no intent-map row that sends Roblox work to the pack (rbx-* agents)']);
  r = fixture(); edit(r, '.claude/agents/rbx-a.md', (s) => s.replace('description: "A."', 'description: "' + 'x'.repeat(200) + '"'));
  t('exact: a long description does not change the Roblox result (that check lives in forge-pack.cjs)', PACK.packCheck(r, { devTree: true }).ok === true);
  r = fixture(); fs.unlinkSync(path.join(r, ...PACK.PACK_REL.split('/')));
  t('exact: missing pack file in the template', JSON.stringify(PACK.packCheck(r, { devTree: true })) === JSON.stringify({ ok: false, applicable: true, problems: ['pack file .claude/config/packs/roblox.json missing'], agents: 0, skills: 0 }), JSON.stringify(PACK.packCheck(r, { devTree: true })));
  t('exact: missing pack file in an older project', JSON.stringify(PACK.packCheck(r, { devTree: false })) === JSON.stringify({ ok: true, applicable: false, problems: [], agents: 0, skills: 0, reason: 'no .claude/config/packs/roblox.json (an install from before the Roblox pack)' }), JSON.stringify(PACK.packCheck(r, { devTree: false })));
  r = fixture(); editJson(r, PACK.PACK_REL, (j) => { delete j.presets.process; });
  t('exact: invalid pack file', JSON.stringify(PACK.packCheck(r, { devTree: false }).problems) === JSON.stringify(['pack file .claude/config/packs/roblox.json invalid: presets must hold the roblox-all and process lists']), JSON.stringify(PACK.packCheck(r, { devTree: false })));
  t('exact: loadPack returns {pack, error}', PACK.loadPack(fixture()).error === null && PACK.loadPack(fixture()).pack.name === 'roblox' && PACK.loadPack(r).pack === null);

  // 3c. Edge trees keep the pre-wrapper verdicts (characterisation pins, green on the code before forge-pack.cjs).
  const routerAs = (row, packEdit) => {
    const x = fixture();
    edit(x, '.claude/skills/forge-router/SKILL.md', (s) => s.replace(/\| roblox[^\n]*\n/, row + '\n'));
    if (packEdit) editJson(x, PACK.PACK_REL, packEdit);
    return PACK.packCheck(x, { devTree: true });
  };
  const ROUTER_MSG = 'router: forge-router has no intent-map row that sends Roblox work to the pack (rbx-* agents)';
  res = routerAs('| roblox | Roblox game | the rbx- specialists |');
  t('legacy: a router row with a bare rbx- is green', res.ok === true, JSON.stringify(res.problems));
  res = routerAs('| `rbx-*` | Roblox game |');
  t('legacy: a router row with the agent before roblox is red', res.ok === false && JSON.stringify(res.problems) === JSON.stringify([ROUTER_MSG]), JSON.stringify(res.problems));
  res = routerAs('| luau | Luau scripts | `rbx-*` |', (j) => { j.signals = ['luau']; });
  t('legacy: a signal-only router row (no roblox word) is red', res.ok === false && JSON.stringify(res.problems) === JSON.stringify([ROUTER_MSG]), JSON.stringify(res.problems));
  r = fixture(); editJson(r, PACK.PACK_REL, (j) => { j.name = 'Roblox'; });
  res = PACK.packCheck(r, { devTree: true });
  t('legacy: a pack name field "Roblox" is green', res.ok === true && res.applicable === true, JSON.stringify(res));
  t('legacy: loadPack accepts a pack name field "Roblox"', PACK.loadPack(r).error === null, JSON.stringify(PACK.loadPack(r).error));

  // 4. The doctor runs it as an enforced check.
  const DOC = require('./forge-doctor.cjs');
  t('doctor: roblox_pack is in the check order', DOC.DOCTOR_CHECK_ORDER && Array.isArray(DOC.DOCTOR_CHECK_ORDER.checks) && DOC.DOCTOR_CHECK_ORDER.checks.includes('roblox_pack'), JSON.stringify(DOC.DOCTOR_CHECK_ORDER));
  t('doctor: robloxPackDoctor is exported and green on the real repo', typeof DOC.robloxPackDoctor === 'function' && DOC.robloxPackDoctor(repoRoot).ok === true, typeof DOC.robloxPackDoctor);
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed (forge-roblox-pack)');
process.exit(fail ? 1 : 0);
