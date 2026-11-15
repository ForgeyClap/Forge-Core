#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-lane-skills.test.cjs — the lane skill check (owner rules R-0070 / R-0093, made generic for the Forge
 * template): a lane or Workflow agent must open every skill its prompt requires before its result is accepted.
 * Covers: preset expansion from the Roblox pack file, a Skill tool call, a Read of the SKILL.md and the preloaded
 * body text all count as opened, a plugin-namespaced name counts, a missing skill gives SKILLS-NOT-USED and exit 1,
 * a clean run exits 0, a lane log (stream-json) works, and bad usage exits 2. Throwaway roots only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const LS = require('./forge-lane-skills.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 600) : '')); }
};
const repoRoot = path.resolve(__dirname, '..', '..');
const roots = [];
const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-laneskills-')); roots.push(r); return r; };
const jl = (rows) => rows.map((o) => JSON.stringify(o)).join('\n') + '\n';
const skillCall = (name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } });
const readCall = (p) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: p } }] } });
const run = (args) => cp.spawnSync(process.execPath, [path.join(__dirname, 'forge-lane-skills.cjs'), ...args], { encoding: 'utf8' });

try {
  // presets
  const presets = { 'roblox-all': ['roblox-luau', 'roblox-security'], process: ['forge-conduct'] };
  t('expand: preset names expand, plain names stay', JSON.stringify(LS.expandRequired(['roblox-all', 'process', 'extra'], presets)) === JSON.stringify(['roblox-luau', 'roblox-security', 'forge-conduct', 'extra']));
  t('expand: duplicates are dropped', LS.expandRequired(['roblox-all', 'roblox-luau'], presets).length === 2);
  const real = LS.loadPresets(repoRoot);
  t('real presets: roblox-all and process come from the pack file', Array.isArray(real['roblox-all']) && real['roblox-all'].length >= 10 && Array.isArray(real.process), JSON.stringify(Object.keys(real)));

  // a skills dir with probe text
  const root = tmp();
  const skillsDir = path.join(root, '.claude', 'skills');
  for (const s of ['roblox-luau', 'roblox-security', 'forge-conduct']) {
    fs.mkdirSync(path.join(skillsDir, s), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, s, 'SKILL.md'), '---\nname: ' + s + '\ndescription: "x"\n---\n\nThe unique first body line of the ' + s + ' skill for probing.\n');
  }
  const wf = path.join(root, 'wf');
  fs.mkdirSync(wf);
  fs.writeFileSync(path.join(wf, 'agent-good.jsonl'), jl([skillCall('roblox-luau'), skillCall('plugin:roblox-security'), readCall('C:/p/.claude/skills/forge-conduct/SKILL.md')]));
  fs.writeFileSync(path.join(wf, 'agent-preload.jsonl'), jl([skillCall('roblox-luau'), skillCall('roblox-security'), { type: 'user', message: { content: [{ type: 'text', text: 'The unique first body line of the forge-conduct skill for probing.' }] } }]));
  fs.writeFileSync(path.join(wf, 'agent-bad.jsonl'), jl([skillCall('roblox-luau')]));

  const req = ['roblox-all', 'process'];
  const res = LS.checkWorkflow(wf, LS.expandRequired(req, presets), { skillsDir });
  t('workflow: 3 agents read', res.agents === 3, JSON.stringify(res));
  const bad = res.bad.map((b) => b.file);
  t('workflow: Skill call, namespaced name and SKILL.md Read all count', !bad.includes('agent-good.jsonl'), JSON.stringify(res.bad));
  t('workflow: preloaded body text counts', !bad.includes('agent-preload.jsonl'), JSON.stringify(res.bad));
  const b = res.bad.find((x) => x.file === 'agent-bad.jsonl');
  t('workflow: a skipped skill is named', b && b.missing.includes('roblox-security') && b.missing.includes('forge-conduct'), JSON.stringify(res.bad));

  // FB-LANES-F2: a body line shared by several skills is no proof that one of them was opened
  const shared = 'Source: https://github.com/obra/superpowers (shared by many vendored skills)';
  for (const s of ['shared-a', 'shared-b']) {
    fs.mkdirSync(path.join(skillsDir, s), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, s, 'SKILL.md'), '---\nname: ' + s + '\n---\n\n' + shared + '\n\nThe only line that belongs to ' + s + ' and nothing else.\n');
  }
  const wf2 = path.join(root, 'wf2');
  fs.mkdirSync(wf2);
  const bodyOf = (s) => ({ type: 'user', message: { content: [{ type: 'text', text: fs.readFileSync(path.join(skillsDir, s, 'SKILL.md'), 'utf8') }] } });
  fs.writeFileSync(path.join(wf2, 'agent-one.jsonl'), jl([skillCall('shared-a'), bodyOf('shared-a')]));
  fs.writeFileSync(path.join(wf2, 'agent-preload-b.jsonl'), jl([bodyOf('shared-b')]));
  const res2 = LS.checkWorkflow(wf2, ['shared-a', 'shared-b'], { skillsDir });
  const one = res2.bad.find((x) => x.file === 'agent-one.jsonl');
  t('FB-LANES-F2: a shared first body line does not mark another skill as opened', one && one.missing.includes('shared-b') && !one.missing.includes('shared-a'), JSON.stringify(res2.bad));
  const pre = res2.bad.find((x) => x.file === 'agent-preload-b.jsonl');
  t('FB-LANES-F2: a preloaded body still counts through its unique line', pre && pre.missing.includes('shared-a') && !pre.missing.includes('shared-b'), JSON.stringify(res2.bad));

  // CLI
  const presetFile = path.join(root, 'presets.json');
  fs.writeFileSync(presetFile, JSON.stringify({ presets }));
  let p = run(['--workflow', wf, '--require', 'roblox-all,process', '--presets', presetFile, '--skills-dir', skillsDir]);
  t('cli: a skipped skill exits 1 with SKILLS-NOT-USED', p.status === 1 && /SKILLS-NOT-USED agent-bad\.jsonl/.test(p.stdout), p.status + ' ' + p.stdout + p.stderr);
  fs.unlinkSync(path.join(wf, 'agent-bad.jsonl'));
  p = run(['--workflow', wf, '--require', 'roblox-all,process', '--presets', presetFile, '--skills-dir', skillsDir]);
  t('cli: all skills opened exits 0', p.status === 0 && /0 missing required skills/.test(p.stdout), p.status + ' ' + p.stdout + p.stderr);
  p = run([]);
  t('cli: no arguments exits 2', p.status === 2, p.status + ' ' + p.stderr);
  p = run(['--workflow', path.join(root, 'nope'), '--require', 'x']);
  t('cli: a missing folder exits 2', p.status === 2, p.status + ' ' + p.stderr);

  // lane log (claude -p --output-format stream-json)
  const lanes = path.join(root, 'lanes');
  fs.mkdirSync(lanes);
  fs.writeFileSync(path.join(lanes, 'wp1.log'), 'not json\n' + jl([{ type: 'system', subtype: 'init', skills: ['a', 'b'] }, skillCall('roblox-luau')]));
  p = run([lanes, '--check', 'wp1', '--require', 'roblox-luau,roblox-security']);
  t('cli lane: a lane that skipped a skill exits 1', p.status === 1 && /SKILLS-NOT-USED roblox-security/.test(p.stdout), p.status + ' ' + p.stdout + p.stderr);
  p = run([lanes, '--check', 'wp1', '--require', 'roblox-luau']);
  t('cli lane: a lane that opened every skill exits 0', p.status === 0 && /OK/.test(p.stdout), p.status + ' ' + p.stdout + p.stderr);
  p = run([lanes, '--check', 'wp9', '--require', 'roblox-luau']);
  t('cli lane: a missing lane log exits 1', p.status === 1, p.status + ' ' + p.stdout);
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed (forge-lane-skills)');
process.exit(fail ? 1 : 0);
