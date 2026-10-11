#!/usr/bin/env node
'use strict';
/** forge-shipcheck.test.cjs — hermetic tests for forge-shipcheck.cjs + forge-shipcheck-refs.cjs.
 *  Every failure class gets its own temp-dir fixture (os.mkdtemp, never the real project); the only real-tree
 *  assertions run in the development tree alone (the .claude/config/forge-dev-tree.json marker) and are
 *  visibly skipped anywhere else. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const S = require('./forge-shipcheck.cjs');
const R = require('./forge-shipcheck-refs.cjs');

let pass = 0, fail = 0, skipped = 0;
const t = (name, cond, detail) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); } };
const tFn = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + (e && e.message || e)); } };
const skip = (name, reason) => { skipped++; console.log('  SKIP ' + name + ' — ' + reason); };

const tmpRoots = [];
function mkProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shipcheck-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}
function listFiles(root) {
  const out = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(r); else out.push(r);
    }
  })('');
  return out.sort();
}
const MANIFEST_REL = '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json';
const SYNC = ['sync', 'release', 'template'];
function baseManifest() {
  return {
    schema: 'forge-ship-manifest/v1',
    plugin: { root: 'plugins/forge', external: { skills: ['forge-core'], agents: [], commands: [] } },
    rules: [
      { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: SYNC, reason: 'toolkit' },
      { pattern: '.claude/config/**', class: 'ship-sync', channels: SYNC, reason: 'config' },
      { pattern: '.claude/config/local-thing.json', class: 'local-only', channels: [], reason: 'dev only' },
      { pattern: '.claude/skills/*/**', class: 'ship-sync', channels: SYNC, reason: 'whole skill folders' },
      { pattern: '.claude/skills/demo/**', class: 'ship-sync', channels: SYNC.concat('plugin'), reason: 'plugin skill' },
      { pattern: '.claude/skills/**/learnings.md', class: 'seed-only', channels: SYNC, reason: 'seed' },
      { pattern: '.claude/agents/*.md', class: 'ship-sync', channels: SYNC.concat('plugin'), reason: 'bosses' },
      { pattern: '.claude/forge-runs/**', class: 'per-project', channels: [], reason: 'runs' },
      { pattern: '.claude/FORGE_MEMORY.md', class: 'per-project', channels: [], release_placeholder: true, reason: 'memory' },
      { pattern: '.claude/old/gone.cjs', class: 'retired', channels: [], replacement: 'see the new tool', reason: 'old tool' },
      { pattern: 'plugins/**', class: 'ship-release-only', channels: ['release', 'plugin'], origin: 'release-tree', reason: 'plugin package' },
      // a consistent manifest keeps the protected config paths out of every channel (as the real one does)
      { pattern: '.claude/config/{forge-owner-grant*,forge-usage-guard-override-grant.json}', class: 'per-project', channels: [], reason: 'owner secrets' },
      { pattern: '.claude/config/**/*.user.json', class: 'per-project', channels: [], reason: 'per-installation user state' },
    ],
    known_gaps: [],
    ref_ignore: [],
  };
}
const BASE_FILES = {
  '.claude/forge-bin/tool.cjs': "const p = path.join(root, '.claude', 'config', 'orchestration', 'settings.json');\n",
  '.claude/config/orchestration/settings.json': '{}\n',
  '.claude/skills/demo/SKILL.md': '# demo\nSee PROMPT_TEMPLATE.md and `references/guide.md`.\n',
  '.claude/skills/demo/PROMPT_TEMPLATE.md': 'template\n',
  '.claude/skills/demo/references/guide.md': 'guide\n',
  '.claude/skills/demo/learnings.md': 'notes\n',
  '.claude/agents/boss.md': '---\nname: boss\n---\n',
  '.claude/forge-runs/r1/run.json': '{}\n',
  '.claude/FORGE_MEMORY.md': '# memory\n',
};
const BASE_DELIVERED = ['forge-bin/tool.cjs', 'config/orchestration/settings.json', 'config/orchestration/FORGE_SHIP_MANIFEST.json',
  'skills/demo/SKILL.md', 'skills/demo/PROMPT_TEMPLATE.md', 'skills/demo/references/guide.md', 'agents/boss.md'];
function fixture(mutate) {
  const m = baseManifest();
  const files = Object.assign({}, BASE_FILES);
  const opts = { delivered: BASE_DELIVERED.slice(), seedDelivered: ['skills/demo/learnings.md'] };
  if (mutate) mutate(m, files, opts);
  files[MANIFEST_REL] = JSON.stringify(m, null, 2);
  const root = mkProject(files);
  return { root, run: (extra) => S.runShipcheck(root, Object.assign({ files: listFiles(root) }, opts, extra || {})) };
}
const kinds = (rep) => rep.failures.map((f) => f.kind);
const has = (rep, kind, p) => rep.failures.some((f) => f.kind === kind && (!p || f.path === p));

console.log('globs + classification');
tFn('`**/` matches zero or more folders; `*` never crosses `/`; {a,b} alternatives; dot-files match *', () => {
  assert.ok(S.globToRegExp('.claude/skills/**/learnings.md').test('.claude/skills/x/learnings.md'));
  assert.ok(S.globToRegExp('.claude/skills/**/learnings.md').test('.claude/skills/x/y/learnings.md'));
  assert.ok(S.globToRegExp('a/**/b.md').test('a/b.md'));
  assert.ok(!S.globToRegExp('.claude/forge-bin/*.cjs').test('.claude/forge-bin/sub/x.cjs'));
  assert.ok(S.globToRegExp('.claude/x/{a,b*}.md').test('.claude/x/bcd.md') && !S.globToRegExp('.claude/x/{a,b*}.md').test('.claude/x/c.md'));
  assert.ok(S.globToRegExp('.claude/forge-fixtures/*').test('.claude/forge-fixtures/.gitignore'));
  assert.ok(S.globToRegExp('.claude/a.b').test('.claude/a.b') && !S.globToRegExp('.claude/a.b').test('.claude/aXb'));
});
tFn('classify: the LAST matching rule wins (broad glob first, override after)', () => {
  const m = S.loadManifest(writeTemp(baseManifest()));
  assert.strictEqual(S.classify(m.rules, '.claude/config/local-thing.json').class, 'local-only');
  assert.strictEqual(S.classify(m.rules, '.claude/config/other.json').class, 'ship-sync');
  assert.strictEqual(S.classify(m.rules, '.claude/skills/demo/learnings.md').class, 'seed-only');
  assert.strictEqual(S.classify(m.rules, '.claude/nowhere.txt'), null);
});
function writeTemp(obj) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shipcheck-m-')); tmpRoots.push(d); const f = path.join(d, 'm.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; }

console.log('manifest validation (manifest_invalid / retired_without_replacement)');
const invalid = (mut) => { const m = baseManifest(); mut(m); return S.loadManifest(writeTemp(m)).errors; };
t('unreadable JSON -> manifest_invalid', S.loadManifest(writeTemp('{ nope')).errors.some((e) => e.kind === 'manifest_invalid'));
t('wrong schema -> manifest_invalid', invalid((m) => { m.schema = 'x/v0'; }).some((e) => /schema/.test(e.detail)));
t('a catch-all rule is refused', invalid((m) => { m.rules.push({ pattern: '.claude/**', class: 'per-project', channels: [], reason: 'x' }); }).some((e) => /catch-all/.test(e.detail)));
t('an unknown class is refused', invalid((m) => { m.rules[0].class = 'ship-maybe'; }).some((e) => /unknown class/.test(e.detail)));
t('ship-sync without the sync channel is refused', invalid((m) => { m.rules[0].channels = ['release']; }).some((e) => /must include sync/.test(e.detail)));
t('per-project with a channel is refused', invalid((m) => { m.rules[7].channels = ['sync']; }).some((e) => /channels \[\]/.test(e.detail)));
t('a rule without a reason is refused', invalid((m) => { delete m.rules[0].reason; }).some((e) => /reason/.test(e.detail)));
t('a duplicate pattern is refused', invalid((m) => { m.rules.push(Object.assign({}, m.rules[0])); }).some((e) => /duplicate/.test(e.detail)));
t('retired without a replacement -> retired_without_replacement', invalid((m) => { delete m.rules[9].replacement; }).some((e) => e.kind === 'retired_without_replacement' && e.path === '.claude/old/gone.cjs'));
t('ship-sync without the release channel needs release_excluded', invalid((m) => { m.rules[0].channels = ['sync', 'template']; }).some((e) => /release_excluded/.test(e.detail)));
t('origin release-tree on a sync entry is refused', invalid((m) => { m.rules[0].origin = 'release-tree'; }).some((e) => /origin/.test(e.detail)));
t('a known gap may not cover a never-gappable kind', invalid((m) => { m.known_gaps.push({ id: 'KG-X', kinds: ['manifest_invalid'], paths: ['**'], owner_wp: 'WP-0', reason: 'x' }); }).some((e) => /gappable/.test(e.detail)));
t('a known gap needs owner_wp and reason', invalid((m) => { m.known_gaps.push({ id: 'KG-X', kinds: ['unclassified'], paths: ['a'] }); }).some((e) => /owner_wp/.test(e.detail)));
t('the base fixture manifest itself is valid', S.loadManifest(writeTemp(baseManifest())).errors.length === 0);
{
  const f = fixture((m) => { delete m.rules[9].replacement; });
  const rep = f.run();
  t('runShipcheck: an invalid manifest fails the whole check and is never gappable', rep.ok === false && has(rep, 'retired_without_replacement'), JSON.stringify(rep.failures));
}

console.log('green fixture');
{
  const rep = fixture().run();
  t('consistent fixture -> ok, zero failures', rep.ok === true && rep.failures.length === 0, JSON.stringify(rep.failures));
  t('classes are counted', rep.by_class['ship-sync'] === 7 && rep.by_class['per-project'] === 2 && rep.by_class['seed-only'] === 1, JSON.stringify(rep.by_class));
  t('the sibling + join references were seen and are all shipped', rep.refs.checked >= 3, JSON.stringify(rep.refs));
}

console.log('failure classes');
{
  const rep = fixture((m, files) => { files['.claude/stray.txt'] = 'x'; }).run();
  t('unclassified: a path no rule matches fails', has(rep, 'unclassified', '.claude/stray.txt'), JSON.stringify(kinds(rep)));
}
{
  const rep = fixture((m) => { m.rules.push({ pattern: '.claude/config/orchestration/HOOKS.md', class: 'ship-sync', channels: SYNC, reason: 'pinned doc' }); }).run();
  t('ship_missing_in_source: a literal ship-sync entry absent from source fails', has(rep, 'ship_missing_in_source', '.claude/config/orchestration/HOOKS.md'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m) => { m.rules.push({ pattern: '.claude/{A,B}.md', class: 'ship-sync', channels: SYNC, reason: 'two pins' }); }, ).run();
  t('ship_missing_in_source: a wildcard-free {a,b} pattern is checked file by file', has(rep, 'ship_missing_in_source', '.claude/A.md') && has(rep, 'ship_missing_in_source', '.claude/B.md'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m) => { m.rules.push({ pattern: 'install.ps1', class: 'installer-only', channels: ['release'], origin: 'release-tree', reason: 'installer' }); }).run();
  t('origin release-tree entries are exempt from the source-existence check', rep.ok === true, JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files, o) => { o.delivered.push('forge-bin/pinned-but-gone.cjs'); }).run();
  t('ship_missing_in_source: forge-sync pins a file the source lacks', has(rep, 'ship_missing_in_source', '.claude/forge-bin/pinned-but-gone.cjs'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files) => { files['.claude/old/gone.cjs'] = '// back again\n'; }).run();
  t('retired_present: a retired path that still exists fails', has(rep, 'retired_present', '.claude/old/gone.cjs'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files, o) => { o.delivered = o.delivered.filter((d) => d !== 'skills/demo/PROMPT_TEMPLATE.md'); }).run();
  t('sync_not_delivered: manifest ship-sync, forge-sync does not deliver it (the PROMPT_TEMPLATE.md class)', has(rep, 'sync_not_delivered', '.claude/skills/demo/PROMPT_TEMPLATE.md'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files, o) => { o.delivered.push('forge-runs/r1/run.json', 'skills/demo/learnings.md'); }).run();
  t('sync_delivers_non_ship_sync: forge-sync delivering per-project data fails', has(rep, 'sync_delivers_non_ship_sync', '.claude/forge-runs/r1/run.json'));
  t('sync_delivers_non_ship_sync: forge-sync overwriting a seed-only file fails (SYNC-03)', has(rep, 'sync_delivers_non_ship_sync', '.claude/skills/demo/learnings.md'));
}
{
  const rep = fixture((m, files, o) => { o.seedDelivered = undefined; }).run({ syncTool: { listSystemFiles: () => BASE_DELIVERED } });
  t('seed_not_delivered: without a seed mechanism every seed-only path is reported', has(rep, 'seed_not_delivered', '.claude/skills/demo/learnings.md'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files, o) => { o.delivered = undefined; }).run({ syncTool: null });
  t('sync_delivery_unavailable: no forge-sync module and no injected list fails (drift cannot be checked)', has(rep, 'sync_delivery_unavailable'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files, o) => { o.delivered = undefined; }).run({ syncTool: { listSystemFiles: () => BASE_DELIVERED, listSeedFiles: () => ['skills/demo/learnings.md'] } });
  t('an injected forge-sync with listSystemFiles + listSeedFiles is used for both drift directions', rep.ok === true, JSON.stringify(rep.failures));
}

console.log('reference closure (F5 / SYNC-08 class)');
{
  const rep = fixture((m) => { m.rules.push({ pattern: '.claude/skills/demo/PROMPT_TEMPLATE.md', class: 'local-only', channels: [], reason: 'not shipped' }); },
  ).run({ delivered: BASE_DELIVERED.filter((d) => d !== 'skills/demo/PROMPT_TEMPLATE.md') });
  t('ref_not_shipped: "See PROMPT_TEMPLATE.md" in a shipped SKILL.md, target not shipped (sibling)', rep.failures.some((f) => f.kind === 'ref_not_shipped' && f.path === '.claude/skills/demo/PROMPT_TEMPLATE.md' && f.from === '.claude/skills/demo/SKILL.md'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files) => {
    files['.claude/config/local-thing.json'] = '{}';
    files['.claude/forge-bin/reader.cjs'] = "const f = path.join(cd, 'config', 'local-thing.json');\n";
  }).run({ delivered: BASE_DELIVERED.concat('forge-bin/reader.cjs') });
  t('ref_not_shipped: a shipped tool reading a local-only config via path.join fails (the test-83 class)', rep.failures.some((f) => f.kind === 'ref_not_shipped' && f.path === '.claude/config/local-thing.json' && f.from === '.claude/forge-bin/reader.cjs'), JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files) => {
    files['.claude/config/local-thing.json'] = '{}';
    files['.claude/agents/boss.md'] = 'read `.claude/config/local-thing.json` first\n';
    m.rules[2].ref_ok = 'probed only, absence is normal';
  }).run();
  t('ref_ok on the target rule allows the reference', rep.ok === true, JSON.stringify(rep.failures));
}
{
  const rep = fixture((m, files) => {
    files['.claude/config/local-thing.json'] = '{}';
    files['.claude/agents/boss.md'] = 'read `.claude/config/local-thing.json` first\n';
    m.ref_ignore.push({ from: '.claude/agents/boss.md', ref: '.claude/config/local-thing.json', reason: 'documented exception' });
  }).run();
  t('ref_ignore silences exactly that from->ref pair (and counts it)', rep.ok === true && rep.refs.ignored_by_manifest === 1, JSON.stringify(rep.refs));
}
{
  const rep = fixture((m, files) => { files['.claude/agents/boss.md'] = 'the old `.claude/old/gone.cjs` is retired\n'; }).run();
  t('a reference to a RETIRED path is advisory (retired_refs), never a failure', rep.ok === true && rep.refs.retired_refs.some((x) => x.ref === '.claude/old/gone.cjs'), JSON.stringify(rep.refs));
}
{
  const rep = fixture((m, files) => { files['.claude/agents/boss.md'] = 'see `.claude/never/existed.md`\n'; }).run();
  t('an unclassified, nonexistent target is advisory (unresolved), never a failure', rep.ok === true && rep.refs.unresolved.some((x) => x.ref === '.claude/never/existed.md'), JSON.stringify(rep.refs));
}
{
  // test-83 parity, generalised: a shipped NON-test file naming a config path nothing ships
  const mk = (extraRules) => fixture((m, files) => {
    files['.claude/forge-bin/reads.cjs'] = "const f = path.join(cd, 'config', 'orchestration', 'ghost.json');\n";
    files['.claude/forge-bin/reads.test.cjs'] = "const g = path.join(cd, 'config', 'orchestration', 'fixture-only.json');\n";
    (extraRules || []).forEach((r) => m.rules.push(r));
  }).run({ delivered: BASE_DELIVERED.concat('forge-bin/reads.cjs', 'forge-bin/reads.test.cjs') });
  const rep = mk();
  t('ref_not_shipped: a shipped tool reads a config file that does not exist and nothing classifies as per-project', rep.failures.some((f) => f.kind === 'ref_not_shipped' && f.path === '.claude/config/orchestration/ghost.json' && f.from === '.claude/forge-bin/reads.cjs'), JSON.stringify(rep.failures));
  t('a TEST file naming a nonexistent fixture config is not a failure (fixtures are named by the hundred)', !rep.failures.some((f) => f.path === '.claude/config/orchestration/fixture-only.json'));
  const fixed = mk([{ pattern: '.claude/config/orchestration/ghost.json', class: 'per-project', channels: [], reason: 'runtime state written by the tool' }]);
  t('classifying that runtime config per-project resolves it', fixed.ok === true, JSON.stringify(fixed.failures));
}

console.log('reference extractor rules');
{
  const src = new Set(['.claude/skills/demo/SKILL.md', '.claude/skills/demo/PROMPT_TEMPLATE.md', '.claude/FORGE_SKILL_REGISTRY.md', '.claude/config/orchestration/FORGE_HARD_RULES.json', 'docs/ROOT.md']);
  const refsOf = (text, from) => R.extractRefs(text, from, { sourceSet: src }).map((x) => x.target);
  t('~/.claude/... (home) is not a project reference', refsOf('see ~/.claude/settings.json', '.claude/agents/a.md').length === 0);
  t('an absolute C:/Users/x/.claude path is not a project reference', refsOf('C:/Users/x/.claude/forge-bin/a.cjs', '.claude/agents/a.md').length === 0);
  t('$CLAUDE_PROJECT_DIR/.claude/... is a project reference', refsOf('node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/hook.cjs"', '.claude/settings.json').includes('.claude/forge-bin/hook.cjs'));
  t('a placeholder path (<run_id>) is skipped', refsOf('`.claude/forge-runs/<run_id>/events.jsonl`', '.claude/agents/a.md').length === 0);
  t('a folder reference is skipped', refsOf('under `.claude/forge-runs/` only', '.claude/agents/a.md').length === 0);
  t('a URL path is never read as a .claude path', refsOf('https://github.com/x/y/skills/foo/SKILL.md', '.claude/agents/a.md').length === 0);
  t('a Windows path (backslashes) is read like its POSIX spelling', refsOf('run .\\.claude\\forge-bin\\x.ps1 now', '.claude/agents/a.md').includes('.claude/forge-bin/x.ps1'));
  t('a trailing sentence dot is trimmed', refsOf('see .claude/forge-bin/x.cjs.', '.claude/agents/a.md').includes('.claude/forge-bin/x.cjs'));
  t('path.join literal chain in code -> a reference', refsOf("path.join(root, '.claude', 'config', 'orchestration', 'X.json')", '.claude/forge-bin/a.cjs').includes('.claude/config/orchestration/X.json'));
  t("'orchestration', 'Y.json' reads as config/orchestration (test-83 convention)", refsOf("path.join(cd, 'orchestration', 'Y.json')", '.claude/forge-bin/a.cjs').includes('.claude/config/orchestration/Y.json'));
  t('the join extractor runs on code only, not on markdown', !refsOf("'config', 'orchestration', 'Z.json'", '.claude/agents/a.md').includes('.claude/config/orchestration/Z.json'));
  t('sibling: "See PROMPT_TEMPLATE.md" inside a skill folder', refsOf('See PROMPT_TEMPLATE.md for the format', '.claude/skills/demo/SKILL.md').includes('.claude/skills/demo/PROMPT_TEMPLATE.md'));
  t('bare FORGE_X.md at the .claude root resolves there', refsOf('update FORGE_SKILL_REGISTRY.md', '.claude/agents/a.md').includes('.claude/FORGE_SKILL_REGISTRY.md'));
  t('bare FORGE_X.json resolves to its single source location elsewhere', refsOf('read FORGE_HARD_RULES.json', '.claude/agents/a.md').includes('.claude/config/orchestration/FORGE_HARD_RULES.json'));
  t('an unknown bare FORGE_ name (runtime file) is never guessed', refsOf('FORGE_NOT_A_FILE.json', '.claude/agents/a.md').length === 0);
  t('relative docs/x.md resolves to the project root only when only that exists', refsOf('see `docs/ROOT.md`', '.claude/agents/a.md').includes('docs/ROOT.md'));
}

console.log('known gaps');
{
  const gap = { id: 'KG-T1', kinds: ['sync_not_delivered'], paths: ['.claude/skills/demo/PROMPT_TEMPLATE.md'], owner_wp: 'WP-2b', reason: 'forge-sync does not read the manifest yet' };
  const f = fixture((m, files, o) => { m.known_gaps.push(gap); o.delivered = o.delivered.filter((d) => d !== 'skills/demo/PROMPT_TEMPLATE.md'); });
  const rep = f.run();
  t('a violation matching a known gap is a WARNING with its owner WP, and the check passes', rep.ok === true && rep.warnings.length === 1 && rep.warnings[0].known_gap === 'KG-T1' && rep.warnings[0].owner_wp === 'WP-2b', JSON.stringify(rep));
  const strict = f.run({ ignoreKnownGaps: true });
  t('--no-known-gaps turns the same violation back into a FAILURE (the "before" red list)', strict.ok === false && has(strict, 'sync_not_delivered', '.claude/skills/demo/PROMPT_TEMPLATE.md'));
  const rep2 = fixture((m, files, o) => { m.known_gaps.push(gap); o.delivered = o.delivered.filter((d) => d !== 'skills/demo/references/guide.md' && d !== 'skills/demo/PROMPT_TEMPLATE.md'); }).run();
  t('a violation NOT covered by the gap still fails (only listed gaps are warnings)', rep2.ok === false && has(rep2, 'sync_not_delivered', '.claude/skills/demo/references/guide.md') && rep2.warnings.length === 1, JSON.stringify(rep2.failures));
  const rep3 = fixture((m) => { m.known_gaps.push(gap); }).run();
  t('a known gap nothing matches any more is reported stale (never silently kept)', rep3.ok === true && rep3.stale_known_gaps.includes('KG-T1'), JSON.stringify(rep3.stale_known_gaps));
  const rep4 = fixture((m) => { m.known_gaps.push({ id: 'KG-R', kinds: ['plugin_missing'], paths: ['**/x.md'], owner_wp: 'WP-3', reason: 'release only' }); }).run();
  t('a release-only gap is not called stale when no release tree was checked', !rep4.stale_known_gaps.includes('KG-R'));
}

console.log('release tree (--release-tree): orphans, unexpected, missing, plugin membership');
{
  const f = fixture();
  const green = ['.claude/forge-bin/tool.cjs', '.claude/config/orchestration/settings.json', '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json',
    '.claude/skills/demo/SKILL.md', '.claude/skills/demo/PROMPT_TEMPLATE.md', '.claude/skills/demo/references/guide.md', '.claude/skills/demo/learnings.md',
    '.claude/agents/boss.md', '.claude/FORGE_MEMORY.md', 'plugins/forge/skills/demo/SKILL.md', 'plugins/forge/skills/forge-core/SKILL.md', 'plugins/forge/agents/boss.md'];
  const ok = f.run({ releaseFiles: green });
  t('a consistent release tree (placeholder memory, external forge-core) passes', ok.ok === true, JSON.stringify(ok.failures));
  const bad = f.run({ releaseFiles: green.filter((x) => x !== 'plugins/forge/agents/boss.md' && x !== '.claude/agents/boss.md').concat(
    '.claude/FORGE_FAILURE_PATTERNS.md', '.claude/old/gone.cjs', '.claude/forge-runs/r1/run.json', '.claude/forge-bin/deleted.cjs', 'plugins/forge/skills/extra/SKILL.md') });
  t('release_orphan: tracked but matching no rule', has(bad, 'release_orphan', '.claude/FORGE_FAILURE_PATTERNS.md'), JSON.stringify(kinds(bad)));
  t('release_orphan: a retired path still tracked', has(bad, 'release_orphan', '.claude/old/gone.cjs'));
  t('release_orphan: a shipped-class path no longer in source', has(bad, 'release_orphan', '.claude/forge-bin/deleted.cjs'));
  t('release_unexpected: per-project data tracked in the release tree', has(bad, 'release_unexpected', '.claude/forge-runs/r1/run.json'));
  t('release_missing: a release-channel source file the tree lacks', has(bad, 'release_missing', '.claude/agents/boss.md'));
  t('plugin_missing: a plugin-channel Boss absent from the plugin (the verify-boss class)', has(bad, 'plugin_missing', '.claude/agents/boss.md'));
  t('plugin_unlisted: the plugin carries a skill no entry marks for it', has(bad, 'plugin_unlisted', 'plugins/forge/skills/extra'));
  const excl = fixture((m) => { m.rules.push({ pattern: '.claude/skills/vendored/**', class: 'ship-sync', channels: ['sync', 'template'], release_excluded: 'no open licence', reason: 'internal' }); });
  const exRep = excl.run({ releaseFiles: green.concat('.claude/skills/vendored/SKILL.md') });
  t('release_unexpected: a release_excluded entry tracked in the release tree (the gsap/humanizer class)', has(exRep, 'release_unexpected', '.claude/skills/vendored/SKILL.md'), JSON.stringify(exRep.failures));
}

console.log('enumeration');
{
  const root = mkProject({ 'a.txt': 'a', '.claude/x.md': 'x', 'ignored/z.log': 'z' });
  const walked = S.enumerateSource(root);
  t('a folder git confirms is not a repository is walked', walked.method === 'walk' && walked.files.includes('.claude/x.md'), JSON.stringify(walked));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  const init = g('init', '-q');
  if (init.error || init.status !== 0) skip('git enumeration', 'git init failed here: ' + (init.error ? init.error.message : init.stderr));
  else {
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
    g('add', 'a.txt', '.gitignore');
    const en = S.enumerateSource(root);
    t('git: tracked AND untracked-not-ignored files are listed', en.method === 'git' && en.files.includes('a.txt') && en.files.includes('.claude/x.md'), JSON.stringify(en));
    t('git: an ignored file is not a source path', !en.files.includes('ignored/z.log'));
    fs.unlinkSync(path.join(root, 'a.txt')); // tracked in the index, deleted from disk (not committed)
    t('git: a tracked file deleted from disk is no longer a source path', !S.enumerateSource(root).files.includes('a.txt'));
  }
  t('injected files win', S.enumerateSource(root, { files: ['q\\r.md'] }).files[0] === 'q/r.md');
}

console.log('CLI');
{
  const f = fixture();
  const cli = (args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-shipcheck.cjs')].concat(args), { encoding: 'utf8' });
  // the CLI uses the real forge-sync + git, so point it at a fixture whose own delivery list is irrelevant: --json shape + exit code
  // the fixture is not a development tree (no marker): the CLI needs --force-dev to run the real check on it
  const na = cli(['--root', f.root]);
  t('no dev-tree marker: one plain "not applicable" line and exit 0', na.status === 0 && na.stdout.trim() === 'shipcheck: not applicable outside the development tree (no config/forge-dev-tree.json)', na.status + ' ' + na.stdout.slice(0, 200));
  const withMarker = mkProject({ '.claude/config/forge-dev-tree.json': '{"dev_tree": true}' });
  const mk = cli(['--root', withMarker]);
  t('marker present: runs the real check (no "not applicable" line)', !/not applicable outside/.test(mk.stdout) && /shipcheck|OK|FAILED/i.test(mk.stdout + mk.stderr), mk.status + ' ' + mk.stdout.slice(0, 200));
  const r = cli(['--root', f.root, '--json', '--force-dev']);
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  t('--json prints a parseable report', !!parsed && typeof parsed.ok === 'boolean' && Array.isArray(parsed.failures), (r.stderr || '').slice(0, 300));
  t('exit code mirrors the verdict (0 ok / 3 failures)', parsed && r.status === (parsed.ok ? 0 : 3), 'status ' + r.status);
  const bad = cli(['--bogus']);
  t('an unknown argument exits 1 with usage', bad.status === 1 && /Usage/.test(bad.stderr));
}

console.log('real development tree (dev-tree only)');
const REAL_ROOT = path.resolve(__dirname, '..', '..');
let devTree = false;
try { devTree = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, '.claude', 'config', 'forge-dev-tree.json'), 'utf8')).dev_tree === true; } catch { devTree = false; }
if (!devTree) {
  skip('real-tree shipcheck', 'not the development tree (.claude/config/forge-dev-tree.json absent) — the full shipcheck is a dev-tree check');
} else {
  const loaded = S.loadManifest(path.join(REAL_ROOT, S.MANIFEST_REL));
  t('the shipped FORGE_SHIP_MANIFEST.json is valid', loaded.errors.length === 0, JSON.stringify(loaded.errors.slice(0, 5)));
  const rep = S.runShipcheck(REAL_ROOT);
  t('the real-tree shipcheck enumerates via git and finishes in under 5 s', rep.enumeration && rep.enumeration.method === 'git' && rep.ms < 5000, 'ms=' + rep.ms);
  const strict = S.runShipcheck(REAL_ROOT, { ignoreKnownGaps: true });
  t('--no-known-gaps turns exactly the known-gap warnings into failures', strict.failures.length === rep.failures.length + rep.warnings.length, strict.failures.length + ' vs ' + rep.failures.length + '+' + rep.warnings.length);
  t('every known-gap warning names an owner work package', rep.warnings.every((w) => /^WP-/.test(w.owner_wp || '')));
}

for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ } }
console.log(pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exitCode = fail ? 1 : 0;
