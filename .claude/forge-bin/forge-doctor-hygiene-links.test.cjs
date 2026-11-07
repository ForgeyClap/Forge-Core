#!/usr/bin/env node
'use strict';
/**
 * forge-doctor-hygiene-links.test.cjs — W2-LOWS: two gaps in skill_hygiene's link check
 * (doctor/checks-hygiene.cjs skillHygiene), named in the skills-audit final report:
 *   gap 1: the generated-name exemption also covered local-only links, so a link to one specific run's
 *          .claude/forge-runs/<run>/events.jsonl passed because "events.jsonl" is a name our code writes;
 *   gap 2: a skill's learnings.md was not read, and three skills kept links into .claude/forge-research/ there.
 * Every fixture lives in its own os.tmpdir() folder, removed at the end. Harness: this project's own t() wrapper and
 * the trailing "N passed, M failed" tally (forge-doctor runTests reads that line).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const H = require('./doctor/checks-hygiene.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hyg-links-'));
const wf = (base, rel, body) => { const p = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
const skill = (root, id, body) => wf(root, '.claude/skills/' + id + '/SKILL.md', '---\nname: ' + id + '\ndescription: Use when testing the hygiene link check.\n---\n\n' + body + '\n');

/** A project whose own forge-bin code writes events.jsonl into a run folder and a state file straight into forge-research. */
function fixture() {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  wf(root, '.claude/forge-bin/writer.cjs', [
    "const fs = require('fs'), path = require('path');",
    "function log(runDir, x) { fs.appendFileSync(path.join(runDir, 'events.jsonl'), x); }",
    "function save(root, x) { fs.writeFileSync(path.join(root, '.claude', 'forge-research', 'state-x.json'), x); }",
    'module.exports = { log, save };',
  ].join('\n'));
  wf(root, '.claude/forge-runs/forge-2026-11-04-x/events.jsonl', '{}\n');
  wf(root, '.claude/forge-research/NOTES-2026.md', '# notes\n');
  return root;
}
const entry = (r, id) => r.skills.find((s) => s.skill === id);

console.log('forge-doctor skill_hygiene link gaps (W2-LOWS)');
t('RED gap 1: a link to one specific run\'s events.jsonl is flagged although the name is generated (and the file exists here)', () => {
  const root = fixture();
  skill(root, 'run-linker', 'See `.claude/forge-runs/forge-2026-11-04-x/events.jsonl` for the proof.');
  const e = entry(H.skillHygiene(root), 'run-linker');
  assert.strictEqual(e.ok, false, JSON.stringify(e));
  assert.match(e.issues.join(' '), /forge-runs\/forge-2026-11-04-x\/events\.jsonl \[local-only folder, not shipped\]/);
  assert.strictEqual(e.generated_refs, undefined, JSON.stringify(e));
});
t('gap 1: a runtime file our own code writes straight into a local-only folder stays a generated ref, not a finding', () => {
  const root = fixture();
  skill(root, 'state-doc', 'State lives in `.claude/forge-research/state-x.json` (written on the first run).');
  const e = entry(H.skillHygiene(root), 'state-doc');
  assert.strictEqual(e.ok, true, JSON.stringify(e));
  assert.deepStrictEqual(e.generated_refs, ['.claude/forge-research/state-x.json']);
});
t('RED gap 2: a link in the skill\'s learnings.md into forge-research is flagged and names learnings.md', () => {
  const root = fixture();
  skill(root, 'learner', 'A clean skill body.');
  wf(root, '.claude/skills/learner/learnings.md', '- 2026-07-31: source `.claude/forge-research/NOTES-2026.md` item 4.\n');
  const e = entry(H.skillHygiene(root), 'learner');
  assert.strictEqual(e.ok, false, JSON.stringify(e));
  assert.match(e.issues.join(' '), /\.claude\/forge-research\/NOTES-2026\.md \(in learnings\.md\) \[local-only folder, not shipped\]/);
});
t('RED gap 2: a dangling skill-relative link in learnings.md is flagged; a learnings.md with resolving links is clean', () => {
  const root = fixture();
  skill(root, 'learner2', 'Body.');
  wf(root, '.claude/skills/learner2/learnings.md', '- see `references/gone.md`\n');
  const bad = entry(H.skillHygiene(root), 'learner2');
  assert.strictEqual(bad.ok, false, JSON.stringify(bad)); assert.match(bad.issues.join(' '), /references\/gone\.md \(in learnings\.md\)/);
  wf(root, '.claude/skills/learner2/references/gone.md', '# here\n');
  assert.strictEqual(entry(H.skillHygiene(root), 'learner2').ok, true);
});
t('REAL tree: no skill learnings.md links into a local-only folder, and skill_hygiene is green', () => {
  const root = path.resolve(__dirname, '..', '..');
  const r = H.skillHygiene(root);
  const local = r.skills.filter((s) => /\(in learnings\.md\)/.test(s.issues.join(' ')));
  assert.deepStrictEqual(local.map((s) => s.skill + ': ' + s.issues.join(' | ')), []);
  assert.strictEqual(r.ok, true, JSON.stringify(r.skills.filter((s) => !s.ok)));
});
t('F5b: a link to an absent project memory file is optional, a misspelt one stays dangling', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'mem-'));
  wf(root, '.claude/skills/memuser/SKILL.md', '---\nname: memuser\ndescription: x\n---\nRead `.claude/FORGE_MEMORY.md` and `.claude/FORGE_PROJECT_PROFILE.md` first.\n');
  const ok = entry(H.skillHygiene(root), 'memuser');
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.deepStrictEqual(ok.optional_refs, ['.claude/FORGE_MEMORY.md', '.claude/FORGE_PROJECT_PROFILE.md']);
  wf(root, '.claude/skills/memtypo/SKILL.md', '---\nname: memtypo\ndescription: x\n---\nRead `.claude/FORGE_MEMROY.md` first.\n');
  assert.strictEqual(entry(H.skillHygiene(root), 'memtypo').ok, false);
});
// 2026-11-07 (category tests): the REAL-tree case above passes in the development checkout because local
// files such as .claude/agent-memory/head-chef/MEMORY.md exist there, while every fresh install from the published
// template failed its doctor on the same skill link and rolled back. Judge the SHIPPED set (exactly what
// publish-template copies) in an empty project, the way a fresh install sees it. Runs only in the dev tree: in an
// installed project the case above already judges the shipped files.
t('SHIPPED tree: skill_hygiene is green on only the files publish-template ships (a fresh install)', () => {
  const root = path.resolve(__dirname, '..', '..');
  if (!fs.existsSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'))) return;
  const S = require('./forge-sync.cjs');
  const src = S.publishSourceSet(path.join(root, '.claude'));
  const fresh = fs.mkdtempSync(path.join(TMP, 'shipped-'));
  for (const rel of src.files.keys()) {
    const to = path.join(fresh, '.claude', ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, '.claude', ...rel.split('/')), to);
  }
  // No stubs: forge-sync install creates none of the project memory files (FORGE_MEMORY.md and the rest are written
  // by the Lead's first scan). An earlier version of this case stubbed them and so hid the second cause.
  const r = H.skillHygiene(fresh);
  assert.strictEqual(r.ok, true, JSON.stringify(r.skills.filter((s) => !s.ok)));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
