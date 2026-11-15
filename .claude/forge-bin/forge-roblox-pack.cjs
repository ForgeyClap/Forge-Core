#!/usr/bin/env node
'use strict';
/**
 * forge-roblox-pack.cjs — the Roblox pack check (owner 2026-11-11: "the new Forge template must also contain the
 * Roblox agents"). Zero dependencies. Since 2026-11-13 a thin wrapper over the generic forge-pack.cjs (owner request
 * R-0239: packs for every project type): packCheck() runs forge-pack.cjs for the roblox pack with coreOnly, so its
 * result shape, messages and verdicts are the ones this check returned before (doctor check roblox_pack), pinned by
 * characterisation tests that are green on the pre-wrapper code (edge trees included: a bare rbx- router row, a pack
 * name field that differs in case).
 *
 * The pack is declared in .claude/config/packs/roblox.json (schema forge-pack/v1): the rbx-* specialist agents, the
 * skills they need, and the lane presets (roblox-all, process, gamedev-extra) that forge-lane-skills.cjs expands.
 * The agents and skills ship like every other specialist and skill (.claude/agents/*.md, .claude/skills/<name>/).
 *
 *   packCheck(root, {devTree}) -> {ok, applicable, problems[], agents, skills}
 *     red when: the pack file is missing (development tree only) or broken; a pack agent has no agent file, a name
 *     that differs, no model or effort, no default route in FORGE_MODEL_ROUTING.json (unrouted), a frontmatter
 *     model/effort that differs from that route, no specialistAgents row, or a row among the 12 permanent Bosses;
 *     a pack skill or a preset skill does not ship under .claude/skills; forge-router does not route Roblox to the pack.
 *     A missing pack file is red only in a development tree that carries the agent registry (a template); a project
 *     from before the pack, or a tree without the registry, is n/a. The newer checks (description length, playbook,
 *     an agent in two packs) run in forge-pack.cjs only.
 *
 * CLI: node forge-roblox-pack.cjs [--root <dir>] [--json]   exit 0 = ok or n/a, 1 = red, 2 = usage
 */
const fs = require('fs');
const path = require('path');
const PACKS = require('./forge-pack.cjs');

const PACK_NAME = 'roblox';
const PACK_REL = PACKS.packRel(PACK_NAME);

function loadPack(root) {
  const e = PACKS.loadPackFile(root, PACK_NAME, { coreOnly: true });
  return { pack: e.pack, error: e.error };
}

function packCheck(root, opts) {
  const o = opts || {};
  const r = PACKS.packCheck(root, { devTree: !!o.devTree, pack: PACK_NAME, coreOnly: true });
  if (!r.applicable) return { ok: true, applicable: false, problems: [], agents: 0, skills: 0, reason: r.reason };
  const p = r.packs[0];
  return { ok: p.ok, applicable: true, problems: p.problems, agents: p.agents, skills: p.skills };
}

function main(argv) {
  const i = argv.indexOf('--root');
  if (i >= 0 && !argv[i + 1]) { console.error('usage: node forge-roblox-pack.cjs [--root <dir>] [--json]'); return 2; }
  const root = path.resolve(i >= 0 ? argv[i + 1] : process.cwd());
  const devTree = fs.existsSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'));
  const r = packCheck(root, { devTree });
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (!r.applicable) console.log('roblox pack: n/a (' + r.reason + ')');
  else console.log('roblox pack: ' + (r.ok ? 'OK' : 'RED') + ' (' + r.agents + ' agents, ' + r.skills + ' skills)' + (r.problems.length ? '\n  ' + r.problems.join('\n  ') : ''));
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { PACK_REL, loadPack, packCheck, main };
