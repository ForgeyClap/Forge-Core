#!/usr/bin/env node
'use strict';
// Tests for forge-owner-queue-check.cjs. The red case is the owner queue of the skills-audit report as it
// stood at commit 87bc0c2: three items handed the owner a choice and the owner had to say "maak de beste keuzes" again.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('./forge-owner-queue-check.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + (e && e.message || e)); } };

// the owner queue of final-report.md at 87bc0c2, items 1-9 shortened but with their own words
const OLD = [
  '# Report', '', '## Owner queue (each with what it unblocks)',
  '1. **Acknowledge the finished requests** R-0139, R-0140 and R-0141. This unblocks the scribe\'s final gate.',
  '2. **claude-mem (R-0135 to R-0137):** open a fresh session and check that a new observation appears. Its "work view" agent is set to Codex. You choose whether to switch it to Claude, which costs usage.',
  '3. **Global duplicate removals** (outside this project, so they are yours to do). Removing them shortens the listing:',
  '   - github-release-management;', '   - skill-builder.',
  '4. **Hook fixes that need your settings change** (PHASE2-PLAN):', '   - the claude-flow route hook;',
  '5. **Push** both repos once a git remote exists (there is none today).',
  '6. **hyperframes / rtk-ai** (both owner-named): say so if you still want either installed despite the verdicts in q1.',
  '7. **Plugin allowlist (SA-PLUGIN-ALLOWLIST):** an owner-only list of plugins Forge may install and enable. The gate blocks every agent route to plugin settings.',
  '8. **Your uncommitted `.claude/settings.json` change** stays uncommitted on purpose. Commit or keep it as you prefer.',
  '',
  '9. **Gate worktrees to remove after close:** removing them discards copies of your local files, which the gate leaves to you: `git worktree remove --force _scratch/<name>`.',
  '', '## Next', 'Wave 2 runs as a new run. Decide whether you want it.',
].join('\n');

t('RED: the 87bc0c2 owner queue fails on exactly items 2, 6 and 8 (the three open choices)', () => {
  const r = Q.checkText(OLD);
  // 9 top-level items + 3 nested sub-bullets (L2, 2026-11-06: each sub-bullet is judged as its own item)
  assert.strictEqual(r.section, true); assert.strictEqual(r.items, 12);
  assert.deepStrictEqual(r.findings.filter((f) => f.item !== 'next').map((f) => f.item), [2, 6, 8], JSON.stringify(r.findings));
  assert.ok(r.findings.every((f) => /open choice/.test(f.reason)));
});
t('RED (review M3): a choice in the closing "## Next" section is a finding too ("Decide whether you want it")', () => {
  const f = Q.checkText(OLD).findings.filter((x) => x.item === 'next');
  assert.strictEqual(f.length, 1, JSON.stringify(f)); assert.match(f[0].text, /Wave 2/);
});
t('RED (review M3): the guard cannot be passed by renaming the heading, using a table, a "Next step" section or a level-1 heading', () => {
  const renamed = Q.checkText('## Owner-gated items\n1. You choose whether to rebuild.\n');
  const forYou = Q.checkText('# Voor jou\n- Wil je wave 2 nu?\n');
  const table = Q.checkText('## Owner decisions\n| # | Item |\n|---|---|\n| 1 | Shall I start wave 2? |\n| 2 | Push once a remote exists |\n');
  const nextStep = Q.checkText('## 14. Next step\nLet me know if you want wave 2.\n');
  const lastSec = Q.checkText('## Verdict\nPARTIAL. Do you want the extra round?\n');
  assert.deepStrictEqual([renamed, forYou, table, nextStep, lastSec].map((r) => r.findings.length), [1, 1, 1, 1, 1],
    JSON.stringify([renamed, forYou, table, nextStep, lastSec].map((r) => r.findings)));
  assert.strictEqual(table.findings[0].item, 1);
});
t('L1: agent work with a gate-ish word is still a finding; an ack item with choice wording or without R-ids is a finding', () => {
  const r = Q.checkText('## Owner queue\n1. Re-run the integration gate.\n2. Check the token budget.\n3. Review the account rotator.\n4. Bevestig of je wave 2 wilt.\n5. Acknowledge the work.\n');
  assert.deepStrictEqual(r.findings.map((f) => f.item), [1, 2, 3, 4, 5], JSON.stringify(r.findings));
});
t('a Self-review that ends the report is not judged as a closing section (it quotes owner questions on purpose)', () => {
  assert.deepStrictEqual(Q.checkText('## Next\nWave 2 runs next.\n\n## Self-review\n- q10 What would the owner ask next? "Do you want wave 2?"\n').findings, []);
});
t('an item that names no hard gate is a finding ("rebuild the installer" is agent work)', () => {
  const r = Q.checkText('## Owner queue\n1. Rebuild the installer.\n2. Restart the gateway to see the router.\n');
  assert.deepStrictEqual(r.findings.map((f) => f.item), [1, 2]);
  assert.ok(r.findings.every((f) => /names no hard gate/.test(f.reason)));
});
t('hard-gated items pass: push, credentials/sign-in, settings write, --force discard, outside the project, an owner ack', () => {
  const r = Q.checkText([
    '## What I need from you',
    '1. Push the branch once a git remote exists.',
    '2. Sign in a second Claude account for a live switch test.',
    '3. Apply the settings change in `.claude/settings.json` (agents may not write settings files).',
    '4. Remove the worktree with `git worktree remove --force _scratch/wt-x` (it discards ignored copies).',
    '5. Acknowledge R-0139 to R-0147 (scribe final gate).',
    '6. Retire the global duplicate skills outside this project.',
  ].join('\n'));
  assert.deepStrictEqual(r.findings, [], JSON.stringify(r.findings));
});
t('Dutch headings and wording are read too', () => {
  const r = Q.checkText('## Owner-acties\n1. Kies zelf of je wave 2 wilt.\n2. Push naar de remote zodra die er is.\n');
  assert.deepStrictEqual(r.findings.map((f) => f.item), [1]);
});
t('a report without an owner queue: only its closing sections are judged (clean Next passes, a choice there fails)', () => {
  const clean = Q.checkText('# Report\n\n## Next\nWave 2 runs as a new run.\n');
  assert.strictEqual(clean.section, false); assert.deepStrictEqual(clean.findings, []);
  assert.strictEqual(Q.checkText('# Report\n\n## Next\nYou choose.\n').findings.length, 1);
});
t('RED (round-5 N3): plain (non-list) lines in an owner-queue section are judged: a choice or a no-gate paragraph is a finding', () => {
  const choice = Q.checkText('## Owner queue\nYou choose whether to run wave 2.\n\n1. Push once a remote exists.\n');
  assert.deepStrictEqual(choice.findings.map((f) => [f.line, /open choice/.test(f.reason)]), [[2, true]], JSON.stringify(choice.findings));
  // a paragraph after a blank line is its own item, never glued onto the gated item above it
  const glued = Q.checkText('## Owner queue\n1. Push once a remote exists.\n\nRebuild the installer before close.\n');
  assert.deepStrictEqual(glued.findings.map((f) => [f.line, /names no hard gate/.test(f.reason)]), [[4, true]], JSON.stringify(glued.findings));
  // an indented continuation still belongs to its item; a lead-in line ending in ":" is checked for choice wording only
  const ok = Q.checkText('## Owner queue\nThese need you:\n\n1. Push once a remote exists.\n   It unblocks the release.\n');
  assert.deepStrictEqual(ok.findings, [], JSON.stringify(ok.findings));
  assert.strictEqual(Q.checkText('## Owner queue\nSay so if you want these:\n1. Push once a remote exists.\n').findings.length, 1);
});
t('RED (round-5 N3): items under a deeper subheading inside an owner-queue section are judged; a same-level heading ends the queue', () => {
  const r = Q.checkText('## Owner queue\n### Group A\n1. You choose whether to rebuild.\n#### Later\n- Rebuild the installer.\n### Group B\n- Push once a remote exists.\n## Notes\n- Rebuild the docs.\n');
  assert.deepStrictEqual(r.findings.map((f) => [f.line, f.where]), [[3, 'Group A'], [5, 'Later']], JSON.stringify(r.findings));
  assert.strictEqual(r.items, 3);
});
t('RED (round-5 N4): the loose gate words "gated", "only you", bare "secret" and bare "production" no longer pass non-gate prose', () => {
  const r = Q.checkText('## Owner queue\n1. Review the gated rollout notes.\n2. Read the summary; only you will see the dashboard.\n3. Read the secret to a good intake.\n4. Compare the production numbers in the report.\n5. Productie cijfers nalezen.\n');
  assert.deepStrictEqual(r.findings.map((f) => f.item), [1, 2, 3, 4, 5], JSON.stringify(r.findings));
  assert.ok(r.findings.every((f) => /names no hard gate/.test(f.reason)));
});
t('round-5 N4: the same words in a real gate context still pass', () => {
  const r = Q.checkText([
    '## Owner queue',
    '1. Owner-gated: rotate the webhook signing value.',
    '2. Paste the secret key into your vault.',
    '3. Provide the client secret for the OAuth app.',
    '4. Switch the production database to the new schema.',
    '5. Run the migration on production.',
    '6. A value only you have: the store id.',
    '7. Alleen jij kunt de winkel-id invullen.',
    '8. Zet de wijziging live in productie.',
    '9. This step is hard-gated (the gate refuses agents).',
  ].join('\n'));
  assert.deepStrictEqual(r.findings, [], JSON.stringify(r.findings));
});
// W2-LOWS verify: '\w' inside a single-quoted pattern string became a bare 'w', and /^s/ was meant as /^\s/
t('round-5 N4 verify: word-stem gate patterns really match (production changes / environment, productie-deployment)', () => {
  const r = Q.checkText([
    '## Owner queue',
    '1. Approve the production changes.',
    '2. Set the production environment variables.',
    '3. Keur de productie-deployment goed.',
  ].join('\n'));
  assert.deepStrictEqual(r.findings, [], JSON.stringify(r.findings));
});
t('round-5 N3 verify: a plain line that starts with "s" is its own item, not glued to the gated item above', () => {
  const r = Q.checkText([
    '## Owner queue',
    '1. Push both repos once a git remote exists.',
    '',
    'say which one you prefer.',
  ].join('\n'));
  assert.ok(r.findings.some((f) => /say which one/.test(f.text || JSON.stringify(f))), JSON.stringify(r));
});
// W2-H1B-SCOUT L2: an indented sub-bullet was glued onto its gated parent, and a bare lead-in passed
t('RED (L2): a nested sub-bullet is its own item; a no-gate or choice sub-bullet under a gated item is a finding', () => {
  const r = Q.checkText('## Owner queue\n1. Push once a git remote exists.\n   - Rebuild the installer.\n   - You choose the tag name.\n2. Push the docs repo.\n');
  assert.deepStrictEqual(r.findings.map((f) => [String(f.item), f.line]), [['1.1', 3], ['1.2', 4]], JSON.stringify(r.findings));
  assert.match(r.findings[0].reason, /names no hard gate/); assert.match(r.findings[1].reason, /open choice/);
  assert.strictEqual(r.items, 4);
  // deeper nesting hangs under the nearest shallower item
  const deep = Q.checkText('## Owner queue\n- Push once a remote exists.\n  - Push the tags.\n    - Rebuild the docs.\n');
  assert.deepStrictEqual(deep.findings.map((f) => String(f.item)), ['1.1.1'], JSON.stringify(deep.findings));
});
t('L2: sub-bullets under a gated lead-in item ("…outside this project:") list its objects and inherit its gate', () => {
  const r = Q.checkText('## Owner queue\n1. Retire these global skills (outside this project):\n   - github-release-management;\n   - skill-builder.\n2. Do this:\n   - Rebuild the installer.\n');
  assert.deepStrictEqual(r.findings.map((f) => String(f.item)), ['2', '2.1'], JSON.stringify(r.findings));
});
t('RED (L2): a bare lead-in line with no item under it is a finding; with an item under it it passes', () => {
  const bare = Q.checkText('## Owner queue\n1. Push once a remote exists.\n\nThese need you:\n\n## Notes\nok\n');
  assert.deepStrictEqual(bare.findings.map((f) => [f.line, /lead-in/.test(f.reason)]), [[4, true]], JSON.stringify(bare.findings));
  const twoLeads = Q.checkText('## Owner queue\nFirst group:\n\nSecond group:\n- Push once a remote exists.\n');
  assert.deepStrictEqual(twoLeads.findings.map((f) => f.line), [2], JSON.stringify(twoLeads.findings));
  assert.deepStrictEqual(Q.checkText('## Owner queue\nThese need you:\n\n1. Push once a remote exists.\n').findings, []);
});
t('CLI: exit 1 with findings, 0 when clean, 2 without --file', () => {
  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-'));
  const bad = path.join(dir, 'bad.md'), good = path.join(dir, 'good.md');
  fs.writeFileSync(bad, OLD); fs.writeFileSync(good, '## Owner queue\n1. Push once a remote exists.\n');
  const run = (args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-owner-queue-check.cjs'), ...args], { encoding: 'utf8' }).status;
  try { assert.strictEqual(run(['--file', bad]), 1); assert.strictEqual(run(['--file', good]), 0); assert.strictEqual(run([]), 2); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t('wired: forge-endreview record refuses while the owner queue holds a finding', () => {
  const E = require('./forge-endreview.cjs');
  assert.strictEqual(typeof E.queueProblems, 'function', 'forge-endreview.cjs exports queueProblems');
  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-run-'));
  try {
    fs.writeFileSync(path.join(dir, 'final-report.md'), OLD);
    const p = E.queueProblems(dir);
    assert.strictEqual(p.length, 4, JSON.stringify(p)); assert.ok(p.every((x) => /final-report\.md (item [268]|closing section)/.test(x)), JSON.stringify(p));
    fs.writeFileSync(path.join(dir, 'final-report.md'), '## Owner queue\n1. Push once a remote exists.\n');
    assert.deepStrictEqual(E.queueProblems(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('wired (review M3): forge-endreview check re-judges the report as it is now, so an edit after record fails check', () => {
  const E = require('./forge-endreview.cjs');
  const fs = require('fs'), os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-check-'));
  try {
    fs.mkdirSync(path.join(root, '.claude', 'config', 'quality'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'config', 'quality', 'self-review-questions.json'), path.join(root, '.claude', 'config', 'quality', 'self-review-questions.json'));
    const dir = path.join(root, '.claude', 'forge-runs', 'r1'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'final-report.md'), '# R\n\n## Owner queue\n1. Push once a remote exists.\n\n## Self-review\nok\n');
    const Qs = E.loadQuestions(root).questions;
    const answers = {}; for (const q of Qs) answers[q.id] = { answer: 'answered for the test', evidence: 'fixture evidence' };
    const rec = E.recordSelfReview({ root, runId: 'r1', form: { reviewer: 'fixture reviewer', answers }, log: false });
    assert.strictEqual(rec.code, 0, JSON.stringify(rec));
    assert.strictEqual(E.checkRecorded({ root, runId: 'r1' }).ok, true);
    fs.writeFileSync(path.join(dir, 'final-report.md'), '# R\n\n## Owner queue\n1. Push once a remote exists.\n2. You choose whether to run wave 2.\n\n## Self-review\nok\n');
    const c = E.checkRecorded({ root, runId: 'r1' });
    assert.strictEqual(c.ok, false); assert.ok(c.problems.some((p) => /item 2 .*open choice/.test(p)), JSON.stringify(c.problems));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log('\nforge-owner-queue-check tests:');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
