#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-doctor-default-skills.test.cjs — SD-T9. Claude Code skips a preloaded skill
 * without an error when it is missing, turned off in skillOverrides or marked disable-model-invocation, and drops the
 * descriptions of skills from an overflowing listing. doctor/checks-default-skills.cjs must catch every one of these.
 * SD-T12c: fixtures are put in sync by the generator itself (planAgentEdits + applyAgentEdits + the skill map), a drift
 * line names the part that drifted, and measured delivery is read from hook lines in a temp runs root.
 * Every fixture is a fresh temp root with a temp home and a temp runs root; the real home and the real runs are never
 * read (the doctor reads them at runtime).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const SYNC = require('./forge-agent-skills-sync.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const load = (p) => { try { return require(p); } catch (e) { return { _loadError: e.message }; } };
const mod = load('./doctor/checks-default-skills.cjs');
const fn = (name) => { if (typeof mod[name] !== 'function') throw new Error(name + ' is not exported' + (mod._loadError ? ' (' + mod._loadError + ')' : '')); return mod[name]; };

const REPO = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-default-skills-'));
const put = (base, rel, text) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const skillMd = (name, desc, extra) => '---\nname: ' + name + '\ndescription: "' + (desc || 'Use when testing ' + name + '.') + '"\n' + (extra || '') + '---\n\n# ' + name + '\n';
const agentMd = (name, tools, skills) => '---\nname: ' + name + '\ndescription: test agent\ntools: ' + tools.join(', ') + '\nmodel: sonnet\n'
  + (skills.length ? 'skills:\n' + skills.map((s) => '  - ' + s).join('\n') + '\n' : '') + '---\n\nBody of ' + name + '.\n';

const DATA = {
  schema: 'forge-default-skills/v1', conduct: 'forge-conduct',
  role_baseline: { 'build-boss': ['forge-testing'], 'review-boss': ['forge-code-review'] },
  specialists: {}, specialist_extra: {}, file_less: ['general-purpose'], global_agents: ['triage', 'verifier'],
  moments: {}, limits: { max_baseline: 3, max_preload: 32, max_injection_chars: 10000, max_directive_chars: 300, conduct_max_lines: 80 },
};
const POLICY = {
  classes: {},
  agents: {
    'build-boss': { class: 'full-build', tools: ['Read', 'Bash', 'Skill'] },
    'review-boss': { class: 'read-only-audit', tools: ['Read', 'Grep', 'Glob'] },
  },
};

/** syncWithGenerator(root) -> the generator's own write: agent files and agent-skill-map.json. */
function syncWithGenerator(root) {
  const plan = SYNC.planAgentEdits(root, DATA, POLICY);
  SYNC.applyAgentEdits(root, plan);
  const sm = SYNC.planSkillMap(root, SYNC.planAgentEdits(root, DATA, POLICY));
  if (sm && sm.changed) fs.writeFileSync(sm.file, sm.nextText);
  const after = SYNC.planAgentEdits(root, DATA, POLICY);
  if (after.some((e) => e.changed) || (SYNC.planSkillMap(root, after) || {}).changed) throw new Error('fixture still drifts after the generator ran');
}

/** fixture() -> {root, home, runs, settingsFiles}: a project with two agents that the generator itself put in sync,
 *  an empty home and an empty runs root. */
function fixture() {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  const home = fs.mkdtempSync(path.join(TMP, 'h-'));
  const runs = fs.mkdtempSync(path.join(TMP, 'r-'));
  put(root, '.claude/config/orchestration/FORGE_DEFAULT_SKILLS.json', JSON.stringify(DATA, null, 2));
  put(root, '.claude/config/agents/agent-tool-policy.json', JSON.stringify(POLICY, null, 2));
  put(root, '.claude/config/agents/agent-skill-map.json', JSON.stringify({ agents: {} }, null, 4) + '\n');
  for (const s of ['forge-conduct', 'forge-testing', 'forge-code-review']) put(root, '.claude/skills/' + s + '/SKILL.md', skillMd(s));
  put(root, '.claude/agents/build-boss.md', agentMd('build-boss', ['Read', 'Bash', 'Skill'], []));
  put(root, '.claude/agents/review-boss.md', agentMd('review-boss', ['Read', 'Grep', 'Glob'], []));
  syncWithGenerator(root);
  return { root, home, runs, settingsFiles: [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')] };
}
const check = (fx, extra) => fn('defaultSkillsCheck')(fx.root, Object.assign({ home: fx.home, runsRoot: fx.runs, settingsFiles: fx.settingsFiles }, extra || {}));
const agentFile = (fx, a) => path.join(fx.root, '.claude', 'agents', a + '.md');
const edit = (file, from, to) => { const s = fs.readFileSync(file, 'utf8'); if (!s.includes(from)) throw new Error('fixture text not found: ' + from); fs.writeFileSync(file, s.replace(from, to)); };
const driftLine = (r, agent) => r.problems.find((p) => p.startsWith(agent + ': ') && p.includes('drifted'));
const shaOf = (fx) => crypto.createHash('sha256').update(fs.readFileSync(path.join(fx.root, '.claude', 'config', 'orchestration', 'FORGE_DEFAULT_SKILLS.json'))).digest('hex').slice(0, 12);
const jsonl = (rows) => rows.map((x) => JSON.stringify(x)).join('\n') + '\n';
const hooks = (fx, starts, stops) => { put(fx.runs, '_hooks/subagent-start.jsonl', jsonl(starts)); put(fx.runs, '_hooks/subagent-stop.jsonl', jsonl(stops || [])); };
const startLine = (run, id, agent, sha, pre) => ({ ts: '2026-11-08T10:00:00Z', event: 'SubagentStart', session: 's', agent_id: id, agent_type: agent, run, defaults_sha: sha, skills_preloaded: pre });
const stopLine = (run, id, agent, opened, seen) => Object.assign({ ts: '2026-11-08T10:05:00Z', event: 'SubagentStop', session: 's', agent_id: id, agent_type: agent, run, skills_opened: opened }, typeof seen === 'boolean' ? { conduct_seen: seen } : {});
const has = (r, ...words) => r.problems.some((p) => words.every((w) => p.includes(w)));
const show = (r) => JSON.stringify(r.problems);

console.log('forge-doctor-default-skills');

t('fixture in sync is green', () => {
  const r = check(fixture());
  assert.strictEqual(r.ok, true, show(r));
  assert.ok(r.checked >= 2, 'checked=' + r.checked);
});

t('real tree green', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'realhome-'));
  const runsRoot = fs.mkdtempSync(path.join(TMP, 'realruns-'));
  const files = [path.join(REPO, '.claude', 'settings.json'), path.join(REPO, '.claude', 'settings.local.json')];
  const r = fn('defaultSkillsCheck')(REPO, { home, runsRoot, settingsFiles: files });
  assert.strictEqual(r.ok, true, show(r));
  assert.ok(r.checked >= 20, 'checked=' + r.checked);
});

t('drift is red', () => {
  const fx = fixture();
  put(fx.root, '.claude/agents/build-boss.md', agentMd('build-boss', ['Read', 'Bash', 'Skill'], ['forge-conduct']));
  const r = check(fx);
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, 'build-boss', 'forge-agent-skills-sync.cjs --write'), show(r));
});

t('drift line names the skills part only when only skills drifted', () => {
  const fx = fixture();
  edit(agentFile(fx, 'build-boss'), '  - forge-testing\n', '');
  const line = driftLine(check(fx), 'build-boss') || '';
  assert.ok(line.includes('skills ["forge-conduct"], expected ["forge-conduct","forge-testing"]'), line);
  assert.ok(!line.includes('tools [') && !line.includes('body block') && !line.includes('skill map'), line);
});

t('drift line names the tools part', () => {
  const fx = fixture();
  edit(agentFile(fx, 'review-boss'), 'tools: Read, Grep, Glob', 'tools: Read, Grep, Glob, Skill');
  const line = driftLine(check(fx), 'review-boss') || '';
  assert.ok(line.includes('tools ["Read","Grep","Glob","Skill"], expected ["Read","Grep","Glob"]'), line);
  assert.ok(!line.includes('skills [') && !line.includes('body block'), line);
});

t('drift line names the generated body block', () => {
  const fx = fixture();
  edit(agentFile(fx, 'build-boss'), 'Preloaded at startup', 'Loaded at startup');
  const r = check(fx);
  const line = driftLine(r, 'build-boss') || '';
  assert.strictEqual(r.ok, false);
  assert.ok(line.includes('generated body block') && line.includes('forge-skills:begin'), line);
  assert.ok(!line.includes('skills [') && !line.includes('tools ['), line);
});

t('drift line names the skill map', () => {
  const fx = fixture();
  const map = path.join(fx.root, '.claude', 'config', 'agents', 'agent-skill-map.json');
  const j = JSON.parse(fs.readFileSync(map, 'utf8'));
  j.agents['build-boss'] = ['forge-conduct'];
  fs.writeFileSync(map, JSON.stringify(j, null, 4) + '\n');
  const r = check(fx);
  const line = driftLine(r, 'build-boss') || '';
  assert.strictEqual(r.ok, false);
  assert.ok(line.includes('skill map') && line.includes('["forge-testing"]'), line);
  assert.ok(!line.includes('skills [') && !line.includes('body block'), line);
  assert.ok(!driftLine(r, 'review-boss'), show(r));
});

// FB-CONFIG-2-F4: skills_preloaded is copied by the start hook from the agent file's own skills:
// line, so it proves nothing about delivery. Only what the agent produced counts: skills_opened and conduct_seen.
t('measured delivery counts an opened skill and a conduct_seen canary; nothing else is left unnamed', () => {
  const fx = fixture();
  const sha = shaOf(fx);
  hooks(fx, [startLine('r1', 'a1', 'build-boss', sha, ['forge-conduct', 'forge-testing']), startLine('r1', 'a2', 'forge:review-boss', sha, ['forge-conduct'])],
    [stopLine('r1', 'a1', 'build-boss', ['forge-testing'], true), stopLine('r1', 'a2', 'review-boss', ['forge-code-review'], true)]);
  const r = check(fx);
  assert.strictEqual(r.ok, true, show(r));
  assert.ok(!r.skipped.some((s) => s.includes('not measured')), JSON.stringify(r.skipped));
  assert.deepStrictEqual(r.measured, { sha, runs: 1, starts: 2 });
});

t('measured delivery: a skill seen only in the preload line (copied from the agent file) is SKIP "not measured", never green and never red', () => {
  const fx = fixture();
  const sha = shaOf(fx);
  hooks(fx, [startLine('r1', 'a1', 'build-boss', sha, ['forge-conduct', 'forge-testing']), startLine('r2', 'a3', 'build-boss', sha, ['forge-conduct', 'forge-testing'])],
    [stopLine('r1', 'a1', 'build-boss', ['forge-debug'], true), stopLine('r9', 'zz', 'build-boss', ['forge-testing'], true)]);
  const r = check(fx);
  assert.strictEqual(r.ok, true, show(r));
  const line = r.skipped.find((s) => s.startsWith('build-boss: forge-testing not measured')) || '';
  assert.ok(line.includes('2 measured starts') && line.includes('r1') && line.includes('r2'), JSON.stringify(r.skipped));
  assert.ok(!r.skipped.some((s) => s.startsWith('build-boss: forge-conduct not measured')), 'conduct_seen true is evidence: ' + JSON.stringify(r.skipped));
  assert.ok(!r.problems.some((p) => p.includes('never delivered')), show(r));
});

t('only lines of an older sha (or none) is SKIP, not red', () => {
  const fx = fixture();
  hooks(fx, [startLine('r1', 'a1', 'build-boss', '000000000000', ['forge-conduct']), Object.assign(startLine('r1', 'a2', 'review-boss', null, []), { defaults_sha: undefined })]);
  const r = check(fx);
  assert.strictEqual(r.ok, true, show(r));
  for (const a of ['build-boss', 'review-boss']) assert.ok(r.skipped.some((s) => s.startsWith(a + ':') && s.includes('not measured yet')), JSON.stringify(r.skipped));
});

t('no hook lines at all is SKIP for every agent', () => {
  const r = check(fixture());
  assert.strictEqual(r.ok, true, show(r));
  assert.ok(['build-boss', 'review-boss'].every((a) => r.skipped.some((s) => s.startsWith(a + ':') && s.includes('not measured yet'))), JSON.stringify(r.skipped));
});

t('conduct_seen false on most measured stops is an advisory, never red (the canary read misses a final StructuredOutput call)', () => {
  const fx = fixture();
  const sha = shaOf(fx);
  hooks(fx, [startLine('r1', 'a1', 'build-boss', sha, ['forge-conduct', 'forge-testing']), startLine('r1', 'a2', 'build-boss', sha, ['forge-conduct', 'forge-testing']),
    startLine('r1', 'a3', 'build-boss', sha, ['forge-conduct', 'forge-testing']), startLine('r1', 'b1', 'review-boss', sha, ['forge-conduct', 'forge-code-review']),
    startLine('r1', 'b2', 'review-boss', sha, ['forge-conduct', 'forge-code-review'])],
  [stopLine('r1', 'a1', 'build-boss', [], false), stopLine('r1', 'a2', 'build-boss', [], false), stopLine('r1', 'a3', 'build-boss', [], true),
    stopLine('r1', 'b1', 'review-boss', [], false), stopLine('r1', 'b2', 'review-boss', [], true)]);
  const r = check(fx);
  assert.strictEqual(r.ok, true, show(r));
  assert.ok(r.advisory.some((a) => a.startsWith('build-boss:') && a.includes('2 of 3') && a.includes('conduct_seen false')), JSON.stringify(r.advisory));
  assert.ok(!r.advisory.some((a) => a.startsWith('review-boss:') && a.includes('conduct_seen')), 'exactly half is not more than half: ' + JSON.stringify(r.advisory));
});

t('missing skill is red', () => {
  const fx = fixture();
  fs.rmSync(path.join(fx.root, '.claude', 'skills', 'forge-testing'), { recursive: true, force: true });
  const r = check(fx);
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, 'build-boss', 'forge-testing', 'SKILL.md'), show(r));
});

t('disable-model-invocation is red', () => {
  const fx = fixture();
  put(fx.root, '.claude/skills/forge-testing/SKILL.md', skillMd('forge-testing', null, 'disable-model-invocation: true\n'));
  const r = check(fx);
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, 'build-boss', 'forge-testing', 'disable-model-invocation'), show(r));
});

t('skillOverrides off is red', () => {
  const fx = fixture();
  const s = put(fx.root, '.claude/settings.local.json', JSON.stringify({ skillOverrides: { 'forge-testing': 'off' } }));
  const r = check(fx);
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, 'build-boss', 'forge-testing', 'skillOverrides'), show(r));
  fs.writeFileSync(s, JSON.stringify({ skillOverrides: { 'forge-testing': false } }));
  assert.strictEqual(check(fx).ok, false, 'false counts as off');
  const home = put(fx.home, '.claude/settings.json', JSON.stringify({ skillOverrides: { 'forge-code-review': 'off' } }));
  fs.writeFileSync(s, '{}');
  const r2 = fn('defaultSkillsCheck')(fx.root, { home: fx.home, settingsFiles: [home] });
  assert.ok(has(r2, 'review-boss', 'forge-code-review'), show(r2));
});

t('name-only or on is not red; name-only on a preload is an advisory', () => {
  const fx = fixture();
  put(fx.root, '.claude/settings.json', JSON.stringify({ skillOverrides: { 'forge-testing': 'name-only', 'forge-code-review': 'on' } }));
  const r = check(fx);
  assert.strictEqual(r.ok, true, show(r));
  assert.ok((r.advisory || []).some((a) => a.includes('forge-testing') && a.includes('name-only')), JSON.stringify(r.advisory));
});

t('off on a skill nobody preloads is not red', () => {
  const fx = fixture();
  put(fx.root, '.claude/skills/forge-unused/SKILL.md', skillMd('forge-unused'));
  put(fx.root, '.claude/settings.json', JSON.stringify({ skillOverrides: { 'forge-unused': 'off' } }));
  const r = check(fx);
  assert.strictEqual(r.ok, true, show(r));
});

t('junk or missing settings files never crash', () => {
  const fx = fixture();
  put(fx.root, '.claude/settings.json', '{ not json');
  put(fx.root, '.claude/settings.local.json', JSON.stringify({ skillOverrides: ['forge-testing'] }));
  const r = fn('defaultSkillsCheck')(fx.root, { home: fx.home, settingsFiles: fx.settingsFiles.concat([path.join(fx.root, 'nope.json'), 42, null]) });
  assert.strictEqual(r.ok, true, show(r));
  const junk = fn('defaultSkillsCheck')(path.join(TMP, 'no-such-root'), { home: fx.home, settingsFiles: [] });
  assert.strictEqual(junk.ok, false);
  assert.ok(Array.isArray(junk.problems) && junk.problems.length > 0);
});

t('read-only with Skill is red, exec without Skill is red', () => {
  const fx = fixture();
  put(fx.root, '.claude/agents/review-boss.md', agentMd('review-boss', ['Read', 'Grep', 'Glob', 'Skill'], ['forge-conduct', 'forge-code-review']));
  const r = check(fx);
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, 'review-boss', 'Skill'), show(r));
  const fx2 = fixture();
  put(fx2.root, '.claude/agents/build-boss.md', agentMd('build-boss', ['Read', 'Bash'], ['forge-conduct', 'forge-testing']));
  assert.ok(has(check(fx2), 'build-boss', 'Skill'));
});

t('hooks or dynamic command in a no-exec preload is red', () => {
  const fx = fixture();
  put(fx.root, '.claude/skills/forge-code-review/SKILL.md', skillMd('forge-code-review', null, 'hooks:\n  PreToolUse: x\n'));
  assert.ok(has(check(fx), 'review-boss', 'forge-code-review', 'hooks'), 'hooks');
  const fx2 = fixture();
  put(fx2.root, '.claude/skills/forge-code-review/SKILL.md', skillMd('forge-code-review') + '\nRun !`git status` first.\n');
  assert.ok(has(check(fx2), 'review-boss', 'forge-code-review', 'dynamic'), 'dynamic');
  const fx3 = fixture();
  put(fx3.root, '.claude/skills/forge-testing/SKILL.md', skillMd('forge-testing', null, 'hooks:\n  PreToolUse: x\n'));
  assert.strictEqual(check(fx3).ok, true, 'an exec-class agent may preload a skill with hooks');
});

t('more than 32 skills is red', () => {
  const fx = fixture();
  const many = ['forge-conduct', 'forge-testing'];
  for (let i = 0; i < 31; i++) { const n = 'extra-' + i; put(fx.root, '.claude/skills/' + n + '/SKILL.md', skillMd(n)); many.push(n); }
  put(fx.root, '.claude/agents/build-boss.md', agentMd('build-boss', ['Read', 'Bash', 'Skill'], many));
  assert.ok(has(check(fx), 'build-boss', '32'), show(check(fx)));
});

t('global agents absent is SKIP', () => {
  const r = check(fixture());
  assert.strictEqual(r.ok, true, show(r));
  assert.ok(r.skipped.some((s) => s.includes('triage')) && r.skipped.some((s) => s.includes('verifier')), JSON.stringify(r.skipped));
});

t('a present global agent without the conduct skill is red', () => {
  const fx = fixture();
  put(fx.home, '.claude/skills/forge-conduct/SKILL.md', skillMd('forge-conduct'));
  put(fx.home, '.claude/agents/triage.md', agentMd('triage', ['Read', 'Grep'], ['forge-conduct']));
  assert.strictEqual(check(fx).ok, true, show(check(fx)));
  put(fx.home, '.claude/agents/verifier.md', agentMd('verifier', ['Read', 'Bash'], []));
  const r = check(fx);
  assert.ok(has(r, 'verifier', 'forge-conduct', '--global'), show(r));
  assert.ok(!r.skipped.some((s) => s.includes('triage')));
});

t('listing advisory names dropped skills', () => {
  const fx = fixture();
  const desc = 'x'.repeat(180);
  for (let i = 0; i < 300; i++) { const n = 'fix-skill-' + String(i).padStart(3, '0'); put(fx.root, '.claude/skills/' + n + '/SKILL.md', skillMd(n, desc)); }
  const r = fn('listingBudgetCheck')(fx.root, { home: fx.home, settingsFiles: fx.settingsFiles });
  assert.strictEqual(r.ok, true);
  assert.ok(r.estimateChars > 40000, 'estimate=' + r.estimateChars);
  assert.strictEqual(r.budgetChars, 8000);
  assert.ok(r.advisory.some((a) => /fix-skill-\d{3}/.test(a) && a.includes('40000')), JSON.stringify(r.advisory));
  const small = fn('listingBudgetCheck')(fixture().root, { home: fx.home, settingsFiles: [] });
  assert.deepStrictEqual(small.advisory, []);
});

t('listing entry is capped at 1536 characters', () => {
  const fx = fixture();
  put(fx.root, '.claude/skills/forge-testing/SKILL.md', skillMd('forge-testing', 'y'.repeat(5000)));
  const r = fn('listingBudgetCheck')(fx.root, { home: fx.home, settingsFiles: [] });
  assert.ok(r.estimateChars < 1536 + 400, 'estimate=' + r.estimateChars);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
