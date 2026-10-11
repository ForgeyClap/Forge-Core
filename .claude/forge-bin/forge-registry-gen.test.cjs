'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('./forge-registry-gen.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
function eq(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function w(root, rel, text) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-'));
w(root, '.claude/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha does A.\n---\nbody\n');
w(root, '.claude/skills/beta/SKILL.md', '---\nname: beta\ndescription: Beta does B.\n---\n');
w(root, '.claude/FORGE_SKILL_REGISTRY.md',
  '| Skill | Path | Source | Created by run | Last used run | Related subagents | Purpose | Status | Safety notes | Evidence req. |\n' +
  '|---|---|---|---|---|---|---|---|---|---|\n' +
  '| alpha | p | forge | r1 | - | x | old purpose | scaffold | careful | ev |\n' +
  '| ghost | p | forge | r | - | - | gone | active | - | - |\n');
w(root, '.claude/forge-bin/tool-a.cjs', '// a\n');
w(root, '.claude/forge-bin/tool-a.test.cjs', '// t\n');
w(root, '.claude/forge-bin/tool-b.cjs', '// b\n');
w(root, '.claude/forge-bin/README.md', '| Tool | Purpose |\n|---|---|\n| `tool-a.cjs` | does a |\n| `tool-gone.cjs` | stale |\n');
w(root, '.claude/config/orchestration/forge-canon.json', JSON.stringify({ version: { forge: 'v10' } }));
w(root, 'CLAUDE.md', 'This is Forge V2 and Forge V10 shipped v2.9.0 and v2.7.0\n');
w(root, '.claude/FORGE_VERSION.json', JSON.stringify({ forge_version: 'abc' }));

const r = g.buildReport(root);

t('skills counted', () => eq(r.skills.on_disk, 2));
t('skill missing from registry', () => eq(r.skills.missing_from_registry, ['beta']));
t('skill extra in registry', () => eq(r.skills.extra_in_registry, ['ghost']));
t('tools counted (non-test)', () => eq(r.tools.on_disk, 2));
t('tool missing from README', () => eq(r.tools.missing_from_readme, ['tool-b.cjs']));
t('tool extra in README', () => eq(r.tools.extra_in_readme, ['tool-gone.cjs']));
t('tool without test', () => eq(r.tools.without_test, ['tool-b.cjs']));
t('version contradiction vs canon', () => {
  if (!r.versions.contradictions.some((c) => c.kind === 'major-vs-canon' && c.found === 'v2')) throw new Error('no v2 contradiction');
});
t('semver spread reported', () => {
  if (!r.versions.contradictions.some((c) => c.kind === 'semver-spread' && c.highest === '2.9.0')) throw new Error('missing');
});
t('oversize detects >800 lines', () => {
  w(root, '.claude/forge-bin/big.cjs', 'x\n'.repeat(850));
  if (!g.buildReport(root).oversize.files.some((f) => f.file.endsWith('big.cjs') && f.lines > 800)) throw new Error('not flagged');
});
t('generate skill-registry carries status by name', () => {
  const o = g.genSkillRegistry(root);
  if (!/\| alpha \| .*\| scaffold \| careful \|/.test(o.text)) throw new Error('status not carried');
  if (!/\| beta \| .*\| unreviewed \|/.test(o.text)) throw new Error('new skill not unreviewed');
  eq([o.stats.carried, o.stats.fresh, o.stats.orphans], [1, 1, 1]);
});
t('generate tool-table carries purpose', () => {
  const o = g.genToolTable(root);
  if (!/`tool-a.cjs` \| yes \| does a/.test(o.text)) throw new Error('purpose not carried');
  if (!/`tool-b.cjs` \| NO \| TODO/.test(o.text)) throw new Error('undocumented not marked');
});
t('generate writes --out and refuses hand-kept files', () => {
  const regFile = path.join(root, '.claude/FORGE_SKILL_REGISTRY.md');
  const before = fs.readFileSync(regFile, 'utf8');
  const out = path.join(root, 'o', 'x.md');
  eq(g.main(['generate', '--target', 'skill-registry', '--out', out, '--root', root]), 0);
  if (!fs.existsSync(out)) throw new Error('no output');
  eq(g.main(['generate', '--target', 'skill-registry', '--out', regFile, '--root', root]), 2);
  eq(fs.readFileSync(regFile, 'utf8'), before);
});
t('default out lands under overhaul generated dir', () => {
  eq(g.main(['generate', '--target', 'tool-table', '--root', root]), 0);
  if (!fs.existsSync(path.join(root, '.claude/forge-research/overhaul-2026-10-09/generated/forge-bin-tool-table.generated.md'))) throw new Error('missing');
});
t('bad usage exits 2', () => eq(g.main(['generate', '--target', 'nope', '--root', root]), 2));

// ===================================================================================================
// feature registry — the static caller scan, status propagation, note carry-over, CLI.
// ===================================================================================================
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const TOOLS = { set: new Set(['a.cjs', 'b.cjs', 'c.cjs', 'w.cjs']) };
t('codeCalls: require of ./x and ./x.cjs are calls', () => {
  const m = g.codeCalls("const A = require('./a');\nconst B = require('./b.cjs');\n", TOOLS.set);
  eq([m.get('a.cjs'), m.get('b.cjs')], ['require', 'require']);
});
t('codeCalls: a spawn with path.join on the line (or the line before) is a call', () => {
  const m = g.codeCalls("spawnSync(process.execPath, [\n  path.join(__dirname, 'c.cjs'), '--x']);\nnew Worker(path.join(__dirname, 'w.cjs'));\n", TOOLS.set);
  eq([m.get('c.cjs'), m.get('w.cjs')], ['spawn', 'spawn']);
});
t('codeCalls: a name only in a comment or in a printed message is NOT a call', () => {
  const m = g.codeCalls("// require('./a')\n/* spawnSync b.cjs */\nconsole.log('run node .claude/forge-bin/c.cjs to fix it');\n", TOOLS.set);
  eq(m.size, 0);
});
t('stripJsComments keeps strings that contain // (URLs) intact', () => {
  ok(g.stripJsComments("const u = 'http://x/a.cjs'; // gone\n").includes("'http://x/a.cjs'"));
  ok(!g.stripJsComments("const u = 1; // gone b.cjs\n").includes('b.cjs'));
});
t('skillMentions: forge-* by bare name, never as x.cjs, a forge-x-y name or a .claude/forge-x/ folder', () => {
  const names = new Map([['forge-mm', 'forge-mm']]);
  eq([...g.skillMentions('load forge-mm now', names)], ['forge-mm']);
  eq([...g.skillMentions('run forge-mm.cjs', names)], []);
  eq([...g.skillMentions('see forge-mm-lens', names)], []);
  eq([...g.skillMentions('store .claude/forge-mm/x', names)], []);
});
t('skillMentions: other skills only in backticks, as /name or a skills/<name>/ path (ordinary words never count)', () => {
  const names = new Map([['teach', 'teach'], ['gsap-core', 'gsap/gsap-core']]);
  eq([...g.skillMentions('we teach the user', names)], []);
  eq([...g.skillMentions('use `teach` here', names)], ['teach']);
  eq([...g.skillMentions('type /teach to start', names)], ['teach']);
  eq([...g.skillMentions('load `.claude/skills/gsap/<skill-name>/SKILL.md`', names)], ['gsap/gsap-core']);
});

const fr = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-feat-'));
const B = '.claude/forge-bin/';
w(fr, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/hooked.cjs"' }] }] } }));
w(fr, B + 'hooked.cjs', "'use strict';\nrequire('./lib-a');\n");
w(fr, B + 'lib-a.cjs', "'use strict';\n");
w(fr, B + 'flowtool.cjs', "'use strict';\n");
w(fr, B + 'subcmd.cjs', "'use strict';\n");
w(fr, B + 'orphan.cjs', "'use strict';\nrequire('./lib-b.cjs');\n");
w(fr, B + 'lib-b.cjs', "'use strict';\n");
w(fr, B + 'spawner.cjs', "'use strict';\nconst { spawnSync } = require('child_process');\n// msg-only: commented.cjs\nspawnSync(process.execPath, [path.join(__dirname, 'spawned.cjs')]);\nconsole.log('try msgonly.cjs');\n");
w(fr, B + 'spawned.cjs', "'use strict';\n");
w(fr, B + 'msgonly.cjs', "'use strict';\n");
w(fr, B + 'commented.cjs', "'use strict';\n");
w(fr, B + 'checked.cjs', "'use strict';\n");
w(fr, B + 'forge-doctor.cjs', "'use strict';\nrequire('./checked');\n");
w(fr, B + 'forge-testrun.cjs', "'use strict';\nrequire('./checked.cjs');\n");
w(fr, B + 'readmecmd.cjs', "'use strict';\n");
w(fr, B + 'readmetable.cjs', "'use strict';\n");
w(fr, B + 'skilltool.cjs', "'use strict';\n");
w(fr, B + 'wiredskilltool.cjs', "'use strict';\n");
w(fr, B + 'gw.cjs', "'use strict';\n");
w(fr, B + 'rc.cjs', "'use strict';\n");
w(fr, B + 'orphan.test.cjs', "require('./orphan.cjs'); require('./lib-b');\n");
w(fr, B + 'README.md', '| Tool | Purpose |\n|---|---|\n| `readmetable.cjs` | x |\n\n```\nnode .claude/forge-bin/readmecmd.cjs --x\n```\n');
w(fr, '.claude/commands/forge.md', 'Run `node .claude/forge-bin/flowtool.cjs`, then load forge-beta.\n');
w(fr, 'CLAUDE.md', 'Start with spawner.cjs.\n');
w(fr, '.claude/docs/forge-reference/forge-cmd-subcommands.md', '`/forge sub` runs subcmd.cjs\n');
w(fr, '.claude/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha does A.\n---\nRun skilltool.cjs.\n');
w(fr, '.claude/skills/forge-beta/SKILL.md', '---\nname: forge-beta\ndescription: Beta.\n---\nRun wiredskilltool.cjs.\n');
w(fr, '.claude/skills/gamma/SKILL.md', '---\nname: gamma\n---\nno description\n');
w(fr, '.claude/skills/forge-delta/SKILL.md', '---\nname: forge-delta\n---\nplaybook\n');
w(fr, '.claude/skills/bundle/nested-one/SKILL.md', '---\nname: nested-one\ndescription: N.\n---\n');
w(fr, '.claude/config/orchestration/domain-catalog.json', JSON.stringify({ domains: { web: { playbook: 'forge-delta' } }, non_domain_skills: ['forge-beta'] }));
w(fr, '.claude/config/orchestration/FORGE_HARD_RULES.json', JSON.stringify({ completion_sequence: [{ step: 1, command: 'node .claude/forge-bin/rc.cjs --run <run_id>' }] }));
w(fr, '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json', JSON.stringify({ rules: [
  { pattern: '.claude/forge-dashboard/{old.cjs,ui.css}', class: 'retired', replacement: 'the new thing', reason: 'gone' },
  { pattern: '.claude/forge-bin/x.test.cjs', class: 'retired', replacement: 'n/a', reason: 'a test' },
  { pattern: '.claude/forge-dashboard/STATE.json', class: 'retired', replacement: 'none', reason: 'state' }] }));
w(fr, 'command-center/gateway/src/x.mjs', "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [path.join(bin, 'gw.cjs')]);\n");
w(fr, 'command-center/gateway/test/y.test.mjs', "spawnSync(process.execPath, [path.join(bin, 'orphan.cjs')]);\n");

const st = (c, key) => (c.nodes.get(key) || {}).status;
t('classify: a hook makes a tool wired, and what it requires is wired too', () => {
  const c = g.classifyFeatures(fr);
  eq([st(c, 'tool:hooked.cjs'), st(c, 'tool:lib-a.cjs')], ['wired', 'wired']);
});
t('classify: forge.md / CLAUDE.md / the run contract / the gateway make a tool wired; a spawned child follows its parent', () => {
  const c = g.classifyFeatures(fr);
  eq([st(c, 'tool:flowtool.cjs'), st(c, 'tool:spawner.cjs'), st(c, 'tool:spawned.cjs'), st(c, 'tool:rc.cjs'), st(c, 'tool:gw.cjs')], ['wired', 'wired', 'wired', 'wired', 'wired']);
  ok(c.gatewayScanned === true);
});
t('classify: the sub-command doc and a README `node` line give on-request; a README table row alone gives nothing', () => {
  const c = g.classifyFeatures(fr);
  eq([st(c, 'tool:subcmd.cjs'), st(c, 'tool:readmecmd.cjs'), st(c, 'tool:readmetable.cjs')], ['on-request', 'on-request', 'dormant']);
});
t('classify: a tool reached only through a dormant tool stays dormant (no fake chain)', () => {
  const c = g.classifyFeatures(fr);
  eq([st(c, 'tool:orphan.cjs'), st(c, 'tool:lib-b.cjs')], ['dormant', 'dormant']);
  ok(c.nodes.get('tool:lib-b.cjs').callers.some((x) => x.from === '.claude/forge-bin/orphan.cjs'), 'the dormant caller is still recorded');
});
t('classify: the doctor, the test runner and *.test.* files are never callers; comments and messages are not calls', () => {
  const c = g.classifyFeatures(fr);
  eq([st(c, 'tool:checked.cjs'), st(c, 'tool:msgonly.cjs'), st(c, 'tool:commented.cjs')], ['dormant', 'dormant', 'dormant']);
  eq(c.nodes.get('tool:checked.cjs').callers.length, 0);
});
t('classify: a skill doc passes on its own status (on-request skill -> on-request tool; wired skill -> wired tool)', () => {
  const c = g.classifyFeatures(fr);
  eq([st(c, 'skill:alpha'), st(c, 'tool:skilltool.cjs'), st(c, 'skill:forge-beta'), st(c, 'tool:wiredskilltool.cjs')], ['on-request', 'on-request', 'wired', 'wired']);
});
t('classify: no description = dormant; a catalog playbook = wired; a nested skill folder needs a caller', () => {
  const c = g.classifyFeatures(fr);
  eq([st(c, 'skill:gamma'), st(c, 'skill:forge-delta'), st(c, 'skill:bundle/nested-one')], ['dormant', 'wired', 'dormant']);
  w(fr, '.claude/skills/forge-beta/SKILL.md', '---\nname: forge-beta\ndescription: Beta.\n---\nRun wiredskilltool.cjs. Load `.claude/skills/bundle/<name>/SKILL.md` on demand.\n');
  eq(st(g.classifyFeatures(fr), 'skill:bundle/nested-one'), 'wired');
});

t('generate: entries for every tool and skill, retired code entries from the manifest only, dormant notes, deterministic', () => {
  const a = g.genFeatureRegistry(fr, null, { today: '2026-10-10' });
  const b = g.genFeatureRegistry(fr, null, { today: '2026-10-10' });
  eq(JSON.stringify(a.data), JSON.stringify(b.data));
  const ids = a.data.features.map((f) => f.kind + ':' + f.id);
  ok(ids.includes('tool:hooked.cjs') && ids.includes('skill:bundle/nested-one') && !ids.includes('tool:orphan.test.cjs'), ids.join(','));
  const ret = a.data.features.filter((f) => f.status === 'retired');
  eq(ret.map((f) => f.id), ['.claude/forge-dashboard/{old.cjs,ui.css}']);
  eq(ret[0].replacement, 'the new thing');
  ok(a.data.features.filter((f) => f.status === 'dormant').every((f) => typeof f.note === 'string' && f.note.length > 10));
  eq(g.validateFeatureRegistry(a.data), []);
  ok(a.data.features.find((f) => f.id === 'hooked.cjs').invoked_by[0] === '.claude/settings.json (hook:Stop)');
  ok(a.data.features.find((f) => f.id === 'checked.cjs').note.includes('the doctor reads it'));
});
t('generate: a hand note survives while the status is unchanged, and is dropped when the status changes; since is kept', () => {
  const first = g.genFeatureRegistry(fr, null, { today: '2026-01-01' }).data;
  first.features.find((f) => f.id === 'orphan.cjs').note = 'HAND: keep until the owner decides';
  first.features.find((f) => f.id === 'readmetable.cjs').note = 'HAND: about to be documented';
  w(fr, B + 'README.md', '| Tool | Purpose |\n|---|---|\n| `readmetable.cjs` | x |\n\nnode .claude/forge-bin/readmecmd.cjs --x\nnode .claude/forge-bin/readmetable.cjs\n');
  const next = g.genFeatureRegistry(fr, first, { today: '2026-12-31' }).data;
  eq(next.features.find((f) => f.id === 'orphan.cjs').note, 'HAND: keep until the owner decides');
  const rt = next.features.find((f) => f.id === 'readmetable.cjs');
  eq([rt.status, rt.note], ['on-request', undefined]);
  eq(next.features.find((f) => f.id === 'hooked.cjs').since, '2026-01-01');
});
t('generate: the size allowlist is seeded once and then only carried over', () => {
  w(fr, B + 'big.cjs', 'x\n'.repeat(820));
  const seeded = g.genFeatureRegistry(fr, null).data;
  ok(seeded.structure.size_allowlist.includes('.claude/forge-bin/big.cjs'));
  w(fr, B + 'big2.cjs', 'x\n'.repeat(820));
  const carried = g.genFeatureRegistry(fr, seeded).data;
  ok(!carried.structure.size_allowlist.includes('.claude/forge-bin/big2.cjs'), 'a NEW big file must not be allowlisted silently');
  fs.rmSync(path.join(fr, B + 'big.cjs')); fs.rmSync(path.join(fr, B + 'big2.cjs'));
});
t('validate: bad kind/status, duplicate, retired without replacement, non-array invoked_by', () => {
  const p = g.validateFeatureRegistry({ schema: g.FEATURE_SCHEMA, features: [
    { id: 'a', kind: 'tool', status: 'wired', invoked_by: [] }, { id: 'a', kind: 'tool', status: 'wired', invoked_by: [] },
    { id: 'b', kind: 'thing', status: 'live', invoked_by: 'x' }, { id: 'c', kind: 'tool', status: 'retired', invoked_by: [] }] });
  ok(p.some((x) => /duplicate/.test(x)) && p.some((x) => /kind/.test(x)) && p.some((x) => /status/.test(x)) && p.some((x) => /replacement/.test(x)) && p.some((x) => /invoked_by/.test(x)), JSON.stringify(p));
});
t('CLI: dry run writes nothing; --write writes the registry; a malformed registry is refused untouched (exit 2)', () => {
  const reg = path.join(fr, g.FEATURE_REGISTRY_REL);
  const orig = process.stdout.write; const origErr = process.stderr.write;
  process.stdout.write = () => true; process.stderr.write = () => true;
  try {
    eq(g.main(['feature-registry', '--root', fr]), 0);
    ok(!fs.existsSync(reg), 'dry run wrote a file');
    eq(g.main(['feature-registry', '--write', '--root', fr]), 0);
    ok(fs.existsSync(reg) && JSON.parse(fs.readFileSync(reg, 'utf8')).schema === g.FEATURE_SCHEMA);
    fs.writeFileSync(reg, '{ broken');
    eq(g.main(['feature-registry', '--write', '--root', fr]), 2);
    eq(fs.readFileSync(reg, 'utf8'), '{ broken');
  } finally { process.stdout.write = orig; process.stderr.write = origErr; }
});
t('the doctor, the test runner and this generator are the only non-callers', () => eq([...g.NOT_A_CALLER].sort(), ['forge-doctor.cjs', 'forge-registry-gen.cjs', 'forge-testrun.cjs']));
fs.rmSync(fr, { recursive: true, force: true });

fs.rmSync(root, { recursive: true, force: true });
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
