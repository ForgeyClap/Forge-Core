'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-system-skill.test.cjs — node:test for forge-system-skill.cjs (the generated single-entry `forge-system` skill).
// Every test builds its own throwaway fixture project under os.tmpdir() and removes it file by file afterwards.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SYS = require('./forge-system-skill.cjs');

// Count results so the doctor's tally check sees a '<n> passed, <m> failed' line (node:test's own summary reads as 0/0).
let pass = 0; let fail = 0;
function T(name, fn) { test(name, (ctx) => { try { const r = fn(ctx); pass++; return r; } catch (e) { fail++; throw e; } }); }
process.on('exit', () => { console.log(pass + ' passed, ' + fail + ' failed (forge-system-skill)'); });

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlZmFrZTEyMzQ1Njc4OTA';
const SKILL_DIR = '.claude/skills/forge-system';
const REFS = ['agents', 'skills', 'commands', 'hooks', 'gates', 'config', 'routes', 'tools', 'workflows', 'limits'];

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}
function read(root, rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function rmTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmTree(p); else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsys-'));
  write(root, '.claude/agents/security-boss.md', '---\nname: security-boss\ndescription: "Read-only security audit."\nmodel: opus\neffort: xhigh\nskills:\n  - forge-conduct\n  - forge-security-review\n---\nBody\n');
  write(root, '.claude/agents/scribe.md', '---\nname: scribe\ndescription: Records owner asks.\nmodel: sonnet\neffort: low\n---\nBody\n');
  write(root, '.claude/config/agents/agent-registry.json', {
    agents: { 'security-boss': { name: 'Security Boss', role: 'Security & secrets', responsibilities: 'Keys, auth, injection.' } },
    specialistAgents: { _doc: 'x', scribe: { name: 'Scribe', role: 'Notulist' } },
  });
  write(root, '.claude/FORGE_MODEL_ROUTING.json', {
    routes: { _doc: 'x', deep: { model: 'opus', effort: 'xhigh', when: 'security and auth' }, quick: { model: 'sonnet', effort: 'low', when: 'small' } },
    agentDefaults: { _note: 'x', 'security-boss': 'deep', scribe: 'quick' },
    escalation: { _doc: 'One retry, one step up.' },
  });
  write(root, '.claude/skills/forge-conduct/SKILL.md', '---\nname: forge-conduct\ndescription: "Use when doing any Forge work: house rules."\n---\n# x\n');
  write(root, '.claude/skills/forge-website/SKILL.md', '---\nname: forge-website\ndescription: "Playbook for websites: responsive, SEO ' + FAKE_JWT + '"\n---\n# x\n');
  write(root, '.claude/skills/test-driven-development/SKILL.md', '---\nname: test-driven-development\ndescription: >\n  Use when building a feature,\n  before code.\n---\n# x\n');
  write(root, '.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json', { settings: { 'usage-guard': { type: 'bool', default: true, group: 'core', desc: { en: 'Pauses Forge near the usage limit.' } } } });
  write(root, '.claude/config/orchestration/hard-gates.json', { gates: [
    { id: 'git-push', class: 'irreversible', reason: 'Pushing commits to a remote is irreversible without owner approval.', match: { kind: 'regex', pattern: 'git\\s+push' } },
    { id: 'kill-by-name', class: 'irreversible', reason: 'Killing processes by image name.', match: { kind: 'command' } },
    { id: 'write-outside-root', class: 'isolation', reason: 'Writing outside the project.', match: { kind: 'path-escape' } },
  ] });
  write(root, '.claude/config/orchestration/run-checklist.json', { steps: [{ id: 'read-memory', label: 'Read project memory first', required: true }, { id: 'route', label: 'Route the work', required: true }] });
  write(root, '.claude/settings.json', { hooks: {
    PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"' }] }],
    SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-resume-brief.cjs"' }] }],
  } });
  write(root, '.claude/forge-bin/forge-gate-hook.cjs', "#!/usr/bin/env node\n'use strict';\n/**\n * forge-gate-hook.cjs — PreToolUse hook: the command hard gates become a real stop.\n * More text.\n */\n");
  write(root, '.claude/forge-bin/forge-resume-brief.cjs', "'use strict';\n// forge-resume-brief.cjs - SessionStart hook that injects the resume facts.\n");
  write(root, '.claude/forge-bin/forge-swarm-resume.cjs', "'use strict';\n/** forge-swarm-resume.cjs — reconcile a killed run from events.jsonl and list the unfinished work packages. */\n");
  write(root, '.claude/forge-bin/forge-swarm-resume.test.cjs', "'use strict';\n// test file, never listed\n");
  write(root, '.claude/commands/forge.md', '---\ndescription: "Forge orchestrator."\nargument-hint: "[task | resume <run_id> | status]"\n---\n# /forge\n\n## B. Sub-commands\n- `resume <run_id>` — read the resume reference first.\n- `status` — run info.\n\n## C. Build flow\n1. First command: start.\n2. Do the NEXT line; see `.claude/nope/missing.cjs`.\n');
  write(root, '.claude/commands/commit.md', '---\ndescription: Create a git commit\ndisable-model-invocation: true\n---\nBody\n');
  write(root, '.claude/workflows/forge-build.js', "export const meta = {\n  name: 'forge-build',\n  description: 'GOAT pipeline as a workflow',\n  phases: [\n    { title: 'Triage', detail: 'head-chef' },\n    { title: 'Verify', detail: 'verify-boss' },\n  ],\n}\n");
  return root;
}

T('generate writes SKILL.md and every reference file from the real sources', () => {
  const root = fixture();
  try {
    const r = SYS.generate({ root });
    assert.ok(r.written.length >= 11, 'wrote ' + r.written.length);
    const skill = read(root, SKILL_DIR + '/SKILL.md');
    const fm = SYS.parseFrontmatter(skill);
    assert.strictEqual(fm.name, 'forge-system');
    assert.match(fm.description, /^Use when /);
    assert.ok(fm.description.length <= 90, 'description is short: ' + fm.description.length);
    for (const n of REFS) {
      assert.ok(fs.existsSync(path.join(root, SKILL_DIR, 'references', n + '.md')), n + '.md exists');
      assert.ok(skill.includes('`references/' + n + '.md`'), 'SKILL.md points at ' + n);
    }
    const agents = read(root, SKILL_DIR + '/references/agents.md');
    assert.match(agents, /Security Boss/);
    assert.match(agents, /security-boss/);
    assert.match(agents, /Security & secrets/);
    assert.match(agents, /deep/); // route from agentDefaults
    assert.match(agents, /forge-security-review/); // preloaded skill
    assert.match(agents, /Scribe/);
    const skills = read(root, SKILL_DIR + '/references/skills.md');
    assert.match(skills, /forge-conduct/);
    assert.match(skills, /Use when building a feature, before code\./); // block-scalar description joined
    assert.match(skills, /forge-website/);
    const gates = read(root, SKILL_DIR + '/references/gates.md');
    assert.match(gates, /git-push/);
    assert.match(gates, /kill-by-name/);
    assert.ok(gates.indexOf('kill-by-name') < gates.indexOf('git-push'), 'command gates are listed first, in their own section');
    assert.doesNotMatch(gates, /git\\\\s\+push/, 'raw match patterns are not dumped');
    assert.match(read(root, SKILL_DIR + '/references/config.md'), /usage-guard/);
    const routes = read(root, SKILL_DIR + '/references/routes.md');
    assert.match(routes, /deep/); assert.match(routes, /xhigh/); assert.doesNotMatch(routes, /\| _doc/);
    const tools = read(root, SKILL_DIR + '/references/tools.md');
    assert.match(tools, /forge-gate-hook\.cjs.*the command hard gates become a real stop/);
    assert.match(tools, /forge-resume-brief\.cjs.*SessionStart hook that injects the resume facts/);
    assert.doesNotMatch(tools, /forge-swarm-resume\.test\.cjs/);
    const hooks = read(root, SKILL_DIR + '/references/hooks.md');
    assert.match(hooks, /PreToolUse/); assert.match(hooks, /forge-gate-hook\.cjs/); assert.match(hooks, /SessionStart/);
    const cmds = read(root, SKILL_DIR + '/references/commands.md');
    assert.match(cmds, /\/forge/); assert.match(cmds, /resume <run_id>/); assert.match(cmds, /\/commit/);
    const wf = read(root, SKILL_DIR + '/references/workflows.md');
    assert.match(wf, /read-memory/); assert.match(wf, /forge-build/); assert.match(wf, /Triage/);
    assert.match(read(root, SKILL_DIR + '/references/limits.md'), /cannot enforce/i);
    assert.match(skill, /cannot enforce/i, 'SKILL.md itself says plainly what a skill cannot do');
  } finally { rmTree(root); }
});

T('generate is idempotent: the second run writes nothing and bytes stay identical', () => {
  const root = fixture();
  try {
    SYS.generate({ root });
    const before = REFS.map((n) => read(root, SKILL_DIR + '/references/' + n + '.md')).join('\n') + read(root, SKILL_DIR + '/SKILL.md');
    const r2 = SYS.generate({ root });
    assert.deepStrictEqual(r2.written, []);
    assert.deepStrictEqual(r2.removed, []);
    const after = REFS.map((n) => read(root, SKILL_DIR + '/references/' + n + '.md')).join('\n') + read(root, SKILL_DIR + '/SKILL.md');
    assert.strictEqual(after, before);
  } finally { rmTree(root); }
});

T('check is green when fresh and names the stale file after a source or output change', () => {
  const root = fixture();
  try {
    SYS.generate({ root });
    assert.strictEqual(SYS.check({ root }).ok, true);
    write(root, '.claude/skills/forge-new/SKILL.md', '---\nname: forge-new\ndescription: "Use when testing staleness."\n---\n');
    const c1 = SYS.check({ root });
    assert.strictEqual(c1.ok, false);
    // skills.md lists the new skill; SKILL.md's map carries the skill count, so it is stale too.
    assert.deepStrictEqual(c1.stale.sort(), ['SKILL.md', 'references/skills.md']);
    SYS.generate({ root });
    assert.strictEqual(SYS.check({ root }).ok, true);
    fs.appendFileSync(path.join(root, SKILL_DIR, 'references/gates.md'), '\nhand edit\n');
    assert.deepStrictEqual(SYS.check({ root }).stale, ['references/gates.md']);
  } finally { rmTree(root); }
});

T('secrets in a source are redacted, and check catches a planted secret in the output', () => {
  const root = fixture();
  try {
    SYS.generate({ root });
    const skills = read(root, SKILL_DIR + '/references/skills.md');
    assert.ok(!skills.includes(FAKE_JWT), 'JWT from a description is not copied');
    assert.match(skills, /\[REDACTED\]/);
    assert.deepStrictEqual(SYS.check({ root }).secrets, []);
    fs.appendFileSync(path.join(root, SKILL_DIR, 'references/limits.md'), '\n' + FAKE_JWT + '\n');
    const c = SYS.check({ root });
    assert.strictEqual(c.ok, false);
    assert.ok(c.secrets.some((s) => s.file === 'references/limits.md'), JSON.stringify(c.secrets));
    assert.ok(!JSON.stringify(c).includes(FAKE_JWT), 'check never prints the secret itself');
  } finally { rmTree(root); }
});

T('dead path references from sources are not emitted as links; check catches a planted dead ref', () => {
  const root = fixture();
  try {
    SYS.generate({ root });
    const wf = read(root, SKILL_DIR + '/references/workflows.md');
    assert.ok(!wf.includes('`.claude/nope/missing.cjs`'), 'dead path is not a backticked ref');
    assert.ok(wf.includes('.claude/nope/missing.cjs'), 'the text itself is kept, plain');
    assert.deepStrictEqual(SYS.check({ root }).deadRefs, []);
    fs.appendFileSync(path.join(root, SKILL_DIR, 'references/tools.md'), '\nsee `.claude/forge-bin/does-not-exist.cjs`\n');
    const c = SYS.check({ root });
    assert.ok(c.deadRefs.some((d) => d.ref === '.claude/forge-bin/does-not-exist.cjs' && d.file === 'references/tools.md'), JSON.stringify(c.deadRefs));
  } finally { rmTree(root); }
});

T('a stale generated reference is removed by a single-file unlink; a hand file is kept', () => {
  const root = fixture();
  try {
    SYS.generate({ root });
    write(root, SKILL_DIR + '/references/old.md', '<!-- ' + SYS.GEN_MARK + ' -->\nold\n');
    write(root, SKILL_DIR + '/references/hand.md', 'my own notes\n');
    write(root, SKILL_DIR + '/evals.json', '{}');
    const r = SYS.generate({ root });
    assert.deepStrictEqual(r.removed, ['references/old.md']);
    assert.ok(!fs.existsSync(path.join(root, SKILL_DIR, 'references/old.md')));
    assert.ok(fs.existsSync(path.join(root, SKILL_DIR, 'references/hand.md')));
    assert.ok(fs.existsSync(path.join(root, SKILL_DIR, 'evals.json')));
    assert.ok(SYS.check({ root }).stale.includes('references/hand.md') === false);
  } finally { rmTree(root); }
});

T('export writes a portable copy (SKILL.md + references only), idempotent, refuses the source folder', () => {
  const root = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fsys-out-'));
  try {
    SYS.generate({ root });
    write(root, SKILL_DIR + '/evals.json', '{}');
    const dest = path.join(out, 'forge-system');
    const r = SYS.exportTo({ root, out: dest });
    assert.strictEqual(r.written.length, 1 + REFS.length);
    const files = fs.readdirSync(dest).sort();
    assert.deepStrictEqual(files, ['SKILL.md', 'references']);
    assert.deepStrictEqual(fs.readdirSync(path.join(dest, 'references')).sort(), REFS.map((n) => n + '.md').sort());
    assert.strictEqual(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), read(root, SKILL_DIR + '/SKILL.md'));
    assert.deepStrictEqual(SYS.exportTo({ root, out: dest }).written, []);
    assert.throws(() => SYS.exportTo({ root, out: path.join(root, SKILL_DIR) }), /source skill folder/);
  } finally { rmTree(root); rmTree(out); }
});

T('CLI: check exits 0 fresh, 1 stale, 2 on a usage error', () => {
  const root = fixture();
  const cli = path.join(__dirname, 'forge-system-skill.cjs');
  try {
    let p = spawnSync(process.execPath, [cli, 'generate', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    p = spawnSync(process.execPath, [cli, 'check', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stdout + p.stderr);
    write(root, '.claude/skills/forge-new/SKILL.md', '---\nname: forge-new\ndescription: "Use when x."\n---\n');
    p = spawnSync(process.execPath, [cli, 'check', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(p.status, 1);
    assert.match(p.stdout, /references\/skills\.md/);
    p = spawnSync(process.execPath, [cli, 'bogus'], { encoding: 'utf8' });
    assert.strictEqual(p.status, 2);
    p = spawnSync(process.execPath, [cli, 'export', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(p.status, 2, 'export without --out is a usage error');
  } finally { rmTree(root); }
});

T('real tree (read-only build): security-boss, git-push gate, resume command and the gate hook are present', () => {
  const real = path.resolve(__dirname, '..', '..');
  const files = SYS.build(real);
  assert.match(files.get('references/agents.md'), /Security Boss/);
  assert.match(files.get('references/gates.md'), /git-push/);
  assert.match(files.get('references/commands.md'), /resume <run_id>/);
  assert.match(files.get('references/hooks.md'), /forge-gate-hook\.cjs/);
  assert.ok(files.get('SKILL.md').split(/\r?\n/).length < 500, 'SKILL.md stays under 500 lines');
});
