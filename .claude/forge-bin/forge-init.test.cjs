#!/usr/bin/env node
'use strict';
/**
 * forge-init.test.cjs - modernization WP 3.1 (`/forge init`). Proves: plan/dry-run write nothing; apply twice gives a
 * byte-identical tree; nothing is ever written outside --root (sibling snapshot, junction below the root); the Forge
 * development tree (a fake one, and the real one when this runs there) and every other refused target are refused
 * with nothing written; existing memory, CLAUDE.md text and user settings survive (user hooks deep-equal, the user's
 * deny rules a prefix, other keys untouched), and the post-merge guard restores the original settings.json when a
 * merge loses a user hook (a faulty merge tool injected: remove the guard and those tests fail).
 * Fixtures: env FORGE_INIT_TEST_DIR, else <dev tree>/_scratch/forge-init-test/ in the development tree (gitignored),
 * else os.tmpdir(); removed at the end. Every call passes env {} so the host's FORGE_STATE_DIR / APPDATA never change
 * the result.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');
const I = require('./forge-init.cjs');
const SM = require('./forge-settings-merge.cjs');

let passed = 0, failed = 0, skipped = 0;
function t(name, fn) {
  try { const r = fn(); if (r === 'skip') { skipped++; console.log('  skip ' + name); } else { passed++; console.log('  ok   ' + name); } }
  catch (e) { failed++; console.log('  FAIL ' + name + ' - ' + (e && e.message)); }
}
const DEV = path.resolve(__dirname, '..', '..');
const IN_DEV = I.isDevTree(DEV);
const PARENT = process.env.FORGE_INIT_TEST_DIR ? path.resolve(process.env.FORGE_INIT_TEST_DIR)
  : (IN_DEV ? path.join(DEV, '_scratch', 'forge-init-test') : os.tmpdir());
fs.mkdirSync(PARENT, { recursive: true });
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(PARENT, 'run-')));
const INIT = path.join(__dirname, 'forge-init.cjs');
const NOW = new Date('2026-10-24T12:00:00Z');
const O = (root, extra) => Object.assign({ root, env: {}, home: null, now: NOW }, extra || {});
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function w(root, rel, text) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
function snap(dir) {
  const out = [];
  (function walk(d, r) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name); const rr = r ? r + '/' + e.name : e.name;
      if (e.isSymbolicLink()) out.push(rr + ' link');
      else if (e.isDirectory()) { out.push(rr + '/'); walk(p, rr); } else out.push(rr + ' ' + sha(fs.readFileSync(p)));
    }
  })(dir, '');
  return out.join('\n');
}
let seq = 0;
function project(files, opts) {
  const d = path.join(BASE, 'p' + (++seq));
  fs.mkdirSync(d, { recursive: true });
  if (!(opts && opts.noGit)) fs.mkdirSync(path.join(d, '.git'));
  for (const [rel, text] of Object.entries(files || {})) w(d, rel, text);
  return d;
}
const FRAG = I.loadFragment(I.FRAGMENT_PATH).fragment;
const HOOK_TOOLS = [...new Set(Object.values(FRAG.hooks).flat().flatMap((g) => g.hooks).map((h) => /forge-bin\/([^"]+)"/.exec(h.command)[1]))];
const withTools = (tools) => Object.fromEntries(tools.map((x) => ['.claude/forge-bin/' + x, '// stub\n']));
const step = (plan, id, file) => plan.steps.find((s) => s.id === id && (!file || path.basename(s.file) === file));
// the CLI child: no FORGE_STATE_DIR, and the app-data/temp folders pointed at an empty dummy so a fixture under the
// real os.tmpdir() (outside the development tree) is not refused as a system folder. Keys are replaced case-insensitively.
const SYS_DUMMY = path.join(BASE, 'sys-dummy');
const childEnv = (() => {
  const e = {}; const drop = /^(FORGE_STATE_DIR|APPDATA|LOCALAPPDATA|PROGRAMDATA|TEMP|TMP|TMPDIR)$/i;
  for (const k of Object.keys(process.env)) if (!drop.test(k)) e[k] = process.env[k];
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR']) e[k] = SYS_DUMMY;
  return e;
})();
const cli = (args) => spawnSync(process.execPath, [INIT, ...args, '--home', 'none'], { encoding: 'utf8', env: childEnv });
const LINKS = [];
function junction(target, link) { try { fs.symlinkSync(target, link, 'junction'); LINKS.push(link); return true; } catch { return false; } }

console.log('forge-init tests (WP 3.1)');
try {
  // ---- the shipped fragment ----
  t('the shipped fragment loads: hooks for every Forge event and the deny rules', () => {
    assert.ok(FRAG && FRAG.hooks.PreToolUse && FRAG.hooks.StopFailure && FRAG.permissions.deny.length >= 10);
    assert.ok(HOOK_TOOLS.includes('forge-gate-hook.cjs') && HOOK_TOOLS.includes('forge-rotator-hook.cjs'));
  });
  t('the fragment equals .claude/settings.json hooks + deny (development tree; fix: forge-init.cjs fragment --dev-root . --write)', () => {
    if (!IN_DEV) return 'skip';
    const want = I.fragmentText(JSON.parse(fs.readFileSync(path.join(DEV, '.claude', 'settings.json'), 'utf8')));
    assert.strictEqual(fs.readFileSync(I.FRAGMENT_PATH, 'utf8'), want, 'fragment drifted from settings.json');
  });
  t('fragmentText is independent of key order and of owner top-level keys in settings.json (an owner /plugin action reorders the file)', () => {
    const base = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node a.cjs', timeout: 5 }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node b.cjs', timeout: 10 }] }] }, permissions: { deny: ['Read(./x)'] } };
    const reordered = { enabledPlugins: { 'x@y': false }, permissions: { deny: ['Read(./x)'] }, hooks: { Stop: [{ hooks: [{ timeout: 5, command: 'node a.cjs', type: 'command' }] }], PreToolUse: [{ hooks: [{ command: 'node b.cjs', type: 'command', timeout: 10 }], matcher: 'Bash' }] } };
    assert.strictEqual(I.fragmentText(reordered), I.fragmentText(base));
    const changed = JSON.parse(JSON.stringify(base)); changed.hooks.PreToolUse[0].hooks[0].timeout = 11;
    assert.notStrictEqual(I.fragmentText(changed), I.fragmentText(base));
  });
  t('forge-init stays plugin-safe: no own-folder read except the shipped config fragment', () => {
    const src = fs.readFileSync(INIT, 'utf8');
    const lines = src.split('\n').filter((l) => /__dirname/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    assert.deepStrictEqual(lines.map((l) => l.trim()), ["const FRAGMENT_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'forge-init.fragment.json');"]);
    const deps = [...src.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(deps, ['forge-paths.cjs', 'forge-settings-merge-guards.cjs', 'forge-settings-merge.cjs']);
    if (fs.existsSync(path.join(__dirname, 'forge-plugin-build.cjs'))) {
      const B = require('./forge-plugin-build.cjs');
      const s = B.scanRootStrategy(src, (p) => p.startsWith('.claude/config/'));
      assert.deepStrictEqual(s.signals.filter((x) => B.UNSAFE_KINDS.has(x.kind)), []);
    }
  });
  t('fragment CLI refuses a folder that is not the development tree (exit 2)', () => {
    const r = spawnSync(process.execPath, [INIT, 'fragment', '--dev-root', project()], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
  });

  // ---- refused targets: nothing written ----
  const refused = (root, code, extra) => {
    const before = fs.existsSync(root) && fs.statSync(root).isDirectory() ? snap(root) : null;
    const p = I.applyInit(O(root, Object.assign({ yes: true }, extra)));
    assert.strictEqual(p.ok, false); assert.strictEqual(p.refused, code);
    if (before !== null) assert.strictEqual(snap(root), before, 'something was written');
  };
  t('refuses a missing folder and a file', () => { refused(path.join(BASE, 'nope'), 'r_missing'); refused(w(BASE, 'afile.txt', 'x'), 'r_missing'); });
  t('refuses a folder without any project marker', () => { refused(project({}, { noGit: true }), 'r_noproject'); });
  t('accepts a folder with only a package.json as a project', () => { assert.strictEqual(I.planInit(O(project({ 'package.json': '{}' }, { noGit: true }))).ok, true); });
  t('refuses a (fake) Forge development tree', () => { refused(project({ '.claude/config/forge-dev-tree.json': '{"dev_tree":true}' }), 'r_devtree'); });
  t('refuses the REAL development tree: plan, apply --yes, check, CLI exit 2, nothing changed', () => {
    if (!IN_DEV) return 'skip';
    const files = ['CLAUDE.md', '.claude/settings.json', '.claude/FORGE_MEMORY.md'];
    const before = files.map((f) => sha(fs.readFileSync(path.join(DEV, f)))).join() + fs.existsSync(path.join(DEV, '.forge'));
    for (const fn of [I.planInit, I.applyInit, I.checkInit]) assert.strictEqual(fn(O(DEV, { yes: true })).refused, 'r_devtree');
    for (const sub of [['plan'], ['apply', '--yes'], ['check']]) assert.strictEqual(cli([...sub, '--root', DEV]).status, 2);
    assert.strictEqual(files.map((f) => sha(fs.readFileSync(path.join(DEV, f)))).join() + fs.existsSync(path.join(DEV, '.forge')), before);
  });
  t('refuses the home folder and anything inside ~/.claude', () => {
    const home = project();
    refused(home, 'r_home', { home });
    const inGlobal = path.join(home, '.claude', 'x'); fs.mkdirSync(path.join(inGlobal, '.git'), { recursive: true });
    refused(inGlobal, 'r_global', { home });
  });
  t('refuses a drive root (read-only check)', () => { assert.strictEqual(I.planInit(O(path.parse(BASE).root)).refused, 'r_drive'); });
  t('refuses a folder inside APPDATA/LOCALAPPDATA and the temp folder itself', () => {
    const sys = path.join(BASE, 'sys'); const inSys = path.join(sys, 'proj'); fs.mkdirSync(path.join(inSys, '.git'), { recursive: true });
    refused(inSys, 'r_system', { env: { LOCALAPPDATA: sys } });
    refused(sys, 'r_system', { env: { TEMP: sys } });
  });
  t('refuses FORGE_STATE_DIR outside the root; accepts it inside', () => {
    const p = project();
    refused(p, 'r_statedir', { env: { FORGE_STATE_DIR: path.join(BASE, 'elsewhere') } });
    assert.strictEqual(I.planInit(O(p, { env: { FORGE_STATE_DIR: 'state' } })).layout, 'forge');
  });
  t('refuses a root that is itself a junction', () => {
    const link = path.join(BASE, 'linkroot');
    if (!junction(project(), link)) return 'skip';
    refused(link, 'r_symlink');
  });
  t('refuses --layout legacy on a project that already has .forge/', () => { refused(project({ '.forge/keep.txt': '' }), 'r_layout', { layout: 'legacy' }); });

  // ---- a fresh project, legacy layout ----
  t('plan and the apply dry run write nothing', () => {
    const p = project(); const before = snap(p);
    const plan = I.planInit(O(p));
    assert.strictEqual(plan.changes, 7);
    assert.strictEqual(I.applyInit(O(p)).dryRun, true);
    assert.strictEqual(snap(p), before);
  });
  const fresh = project();
  const iso = path.join(BASE, 'iso'); fs.mkdirSync(iso); w(iso, 'sibling.txt', 'leave me'); w(iso, 'other/keep.md', 'x');
  const notFresh = (s) => s.split('\n').filter((l) => !l.startsWith(path.basename(fresh) + '/')).join('\n');
  const isoBefore = snap(iso); const freshParentBefore = notFresh(snap(BASE));
  const first = I.applyInit(O(fresh, { yes: true }));
  t('apply --yes creates the memory files, settings.json (deny only, no plugin/tools) and the CLAUDE.md block', () => {
    assert.strictEqual(first.ok, true); assert.strictEqual(first.refusedSteps, 0); assert.strictEqual(first.changes, 7);
    for (const m of I.MEMORY_FILES) assert.ok(exists(fresh, '.claude/' + m), m);
    assert.ok(read(fresh, '.claude/FORGE_TASK_HISTORY.md').startsWith('# Forge Task History\n'));
    const s = JSON.parse(read(fresh, '.claude/settings.json'));
    assert.deepStrictEqual(s, { permissions: { deny: FRAG.permissions.deny } }, 'no hooks, no _doc');
    assert.strictEqual(first.hooks.mode, 'none');
    const md = read(fresh, 'CLAUDE.md');
    assert.ok(md.includes(I.BEGIN) && md.includes(I.END) && md.includes('`.claude/`'));
    assert.ok(!fs.readdirSync(path.join(fresh, '.claude')).some((n) => n.startsWith(I.TMP_PREFIX)), 'temp source left behind');
  });
  t('apply twice = byte-identical tree, 0 changes the second time', () => {
    const a = snap(fresh); const second = I.applyInit(O(fresh, { yes: true }));
    assert.strictEqual(second.changes, 0); assert.strictEqual(snap(fresh), a);
  });
  t('nothing was written outside --root (siblings and the fixture parent unchanged)', () => {
    assert.strictEqual(snap(iso), isoBefore);
    assert.strictEqual(notFresh(snap(BASE)), freshParentBefore);
  });
  t('check: not initialised before, initialised after (API and CLI exit codes)', () => {
    const p = project();
    assert.strictEqual(I.checkInit(O(p)).initialised, false); assert.strictEqual(cli(['check', '--root', p]).status, 1);
    I.applyInit(O(p, { yes: true }));
    assert.strictEqual(I.checkInit(O(p)).initialised, true); assert.strictEqual(cli(['check', '--root', p]).status, 0);
  });

  // ---- existing content ----
  t('an existing memory file is never overwritten', () => {
    const p = project({ '.claude/FORGE_MEMORY.md': 'my own memory\r\n' });
    I.applyInit(O(p, { yes: true }));
    assert.strictEqual(read(p, '.claude/FORGE_MEMORY.md'), 'my own memory\r\n');
  });
  t('CLAUDE.md without markers: block appended, original bytes kept as the prefix, CRLF and BOM kept, backup made', () => {
    const orig = '﻿# Mine\r\nRule one.'; const p = project({ 'CLAUDE.md': orig });
    const r = I.applyInit(O(p, { yes: true }));
    const md = read(p, 'CLAUDE.md');
    assert.ok(md.startsWith(orig + '\r\n\r\n' + I.BEGIN + '\r\n')); assert.ok(!/[^\r]\n/.test(md), 'LF without CR');
    assert.ok(step(r, 'claude_md').backup && read(p, step(r, 'claude_md').backup) === orig);
  });
  t('CLAUDE.md with an outdated block: replaced in place, text around it untouched', () => {
    const p = project({ 'CLAUDE.md': 'top\n' + I.BEGIN + '\nold text\n' + I.END + '\nbottom\n' });
    I.applyInit(O(p, { yes: true }));
    const md = read(p, 'CLAUDE.md');
    assert.ok(md.startsWith('top\n' + I.BEGIN + '\n## Forge\n') && md.endsWith(I.END + '\nbottom\n') && !md.includes('old text'));
    assert.strictEqual(I.checkInit(O(p)).initialised, true);
  });
  t('broken markers: the CLAUDE.md step is refused (file unchanged), the other steps still run, exit 1', () => {
    const bad = I.END + '\nx\n' + I.BEGIN + '\n'; const p = project({ 'CLAUDE.md': bad });
    const r = I.applyInit(O(p, { yes: true }));
    assert.strictEqual(step(r, 'claude_md').result, 'refuse'); assert.strictEqual(read(p, 'CLAUDE.md'), bad);
    assert.ok(exists(p, '.claude/FORGE_MEMORY.md'));
    assert.strictEqual(cli(['apply', '--yes', '--root', p]).status, 1);
  });
  t('a project with only .claude/CLAUDE.md gets the block there; no root CLAUDE.md is created', () => {
    const p = project({ '.claude/CLAUDE.md': '# in dot claude\n' });
    I.applyInit(O(p, { yes: true }));
    assert.ok(read(p, '.claude/CLAUDE.md').includes(I.BEGIN)); assert.ok(!exists(p, 'CLAUDE.md'));
  });

  // ---- settings.json merge ----
  const USER = {
    model: 'sonnet', env: { FOO: '1' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-guard.js', timeout: 7 }] },
        { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node my-shell-log.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
    },
    permissions: { allow: ['Bash(npm test)'], deny: ['Read(./private/**)', 'Read(./.env)'] },
  };
  const userHooks = (s) => Object.entries(USER.hooks).flatMap(([ev, gs]) => gs.flatMap((g) => g.hooks.map((h) => ({ ev, m: g.matcher, h }))))
    .every(({ ev, m, h }) => (s.hooks[ev] || []).some((g) => g.matcher === m && g.hooks.some((x) => JSON.stringify(x) === JSON.stringify(h))));
  const forgeProject = (extra) => project(Object.assign(withTools(HOOK_TOOLS), { '.claude/settings.json': JSON.stringify(USER, null, 2) + '\n' }, extra || {}));
  const sp = forgeProject(); const spOrig = read(sp, '.claude/settings.json');
  const sr = I.applyInit(O(sp, { yes: true }));
  t('project mode: every Forge hook added, every user hook deep-equal, user deny rules a prefix, allow and other keys untouched', () => {
    assert.strictEqual(sr.hooks.mode, 'project'); assert.strictEqual(step(sr, 'settings').result, 'merge');
    const s = JSON.parse(read(sp, '.claude/settings.json'));
    assert.ok(userHooks(s), 'a user hook was lost');
    assert.deepStrictEqual(s.permissions.deny.slice(0, 2), USER.permissions.deny);
    assert.strictEqual(new Set(s.permissions.deny).size, s.permissions.deny.length, 'duplicate deny rule');
    assert.deepStrictEqual(s.permissions.allow, USER.permissions.allow); assert.strictEqual(s.model, 'sonnet'); assert.deepStrictEqual(s.env, USER.env);
    const cmds = Object.values(s.hooks).flat().flatMap((g) => g.hooks).map((h) => h.command);
    for (const x of HOOK_TOOLS) assert.ok(cmds.some((c) => c.includes(x)), x);
    assert.ok(step(sr, 'settings').backup.startsWith('.claude/forge-backups/forge-init/') && read(sp, step(sr, 'settings').backup) === spOrig);
  });
  t('project mode is idempotent: second apply leaves settings.json byte-identical and makes no new backup', () => {
    const a = snap(sp); assert.strictEqual(I.applyInit(O(sp, { yes: true })).changes, 0); assert.strictEqual(snap(sp), a);
  });
  t('the plugin enabled in the project: no hooks added, and a double-hooks warning when Forge hooks are already there', () => {
    const p = forgeProject({ '.claude/settings.local.json': '{"enabledPlugins":{"forge@forge-local":true}}' });
    const r = I.applyInit(O(p, { yes: true }));
    assert.strictEqual(r.hooks.mode, 'plugin'); assert.strictEqual(step(r, 'settings').hooks_added, 0);
    assert.ok(!JSON.parse(read(p, '.claude/settings.json')).hooks.SessionEnd, 'a Forge hook was added despite the plugin');
    const q = project(Object.assign(withTools(HOOK_TOOLS), { '.claude/settings.json': read(sp, '.claude/settings.json'), '.claude/settings.local.json': '{"enabledPlugins":{"forge@x":true}}' }));
    assert.ok(I.planInit(O(q)).notes.includes('h_double'));
  });
  t('the plugin enabled at user level (home) also counts', () => {
    const home = project({ '.claude/settings.json': '{"enabledPlugins":{"forge@forge-local":true}}' });
    assert.strictEqual(I.planInit(O(forgeProject(), { home })).hooks.mode, 'plugin');
  });
  t('partial forge-bin: no hooks added, the missing scripts are named', () => {
    const p = project(withTools(HOOK_TOOLS.slice(0, 2)));
    const plan = I.planInit(O(p));
    assert.strictEqual(plan.hooks.mode, 'partial'); assert.strictEqual(plan.hooks.missing.length, HOOK_TOOLS.length - 2);
    assert.ok(!step(plan, 'settings').source.hooks);
  });
  t('--no-deny: permissions.deny stays exactly as the user had it; hooks still added', () => {
    const p = forgeProject();
    I.applyInit(O(p, { yes: true, noDeny: true }));
    const s = JSON.parse(read(p, '.claude/settings.json'));
    assert.deepStrictEqual(s.permissions.deny, USER.permissions.deny); assert.ok(s.hooks.SessionEnd);
  });
  t('an invalid settings.json: that step is refused, the file byte-identical, the rest applied', () => {
    const p = project({ '.claude/settings.json': '{ not json' });
    const r = I.applyInit(O(p, { yes: true }));
    assert.strictEqual(step(r, 'settings').result, 'refuse'); assert.strictEqual(read(p, '.claude/settings.json'), '{ not json');
    assert.ok(exists(p, 'CLAUDE.md')); assert.strictEqual(I.checkInit(O(p)).initialised, false);
  });
  // The guard tests: a merge tool that loses user data AFTER a real merge. Without the post-merge guard in
  // applySettings these fail (mutation-proven in the WP 3.1 report).
  const lossyTool = (mutate) => ({ applySettingsMerge(o) { const r = SM.applySettingsMerge(o); const j = JSON.parse(fs.readFileSync(o.target, 'utf8')); mutate(j); fs.writeFileSync(o.target, JSON.stringify(j, null, 2) + '\n'); return r; } });
  t('GUARD: a merge that drops a user hook is caught, the original settings.json is put back, the step is refused', () => {
    const p = forgeProject(); const orig = read(p, '.claude/settings.json');
    const r = I.applyInit(O(p, { yes: true, mergeTool: lossyTool((j) => { j.hooks.PreToolUse = j.hooks.PreToolUse.filter((g) => g.matcher !== 'Bash'); }) }));
    assert.strictEqual(step(r, 'settings').result, 'refuse'); assert.ok(/did not keep your own settings/.test(step(r, 'settings').detail));
    assert.strictEqual(read(p, '.claude/settings.json'), orig);
  });
  t('GUARD: a merge that removes or reorders a user deny rule, or changes another key, is caught and undone', () => {
    for (const mutate of [(j) => { j.permissions.deny = j.permissions.deny.slice(1); }, (j) => { j.permissions.deny.reverse(); }, (j) => { j.model = 'opus'; }]) {
      const p = forgeProject(); const orig = read(p, '.claude/settings.json');
      const r = I.applyInit(O(p, { yes: true, mergeTool: lossyTool(mutate) }));
      assert.strictEqual(step(r, 'settings').result, 'refuse'); assert.strictEqual(read(p, '.claude/settings.json'), orig);
    }
  });
  t('lostSettings: a Forge hook upgraded to its newer command form is NOT a loss; a user hook removal is', () => {
    const oldForm = { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs' }] }] } };
    const newForm = { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-toolhook.cjs"' }] }] } };
    assert.deepStrictEqual(I.lostSettings(oldForm, newForm), []);
    assert.strictEqual(I.lostSettings(USER, Object.assign({}, USER, { hooks: { PreToolUse: [] } })).length, 3);
  });
  t('a throwing merge tool leaves no temporary source file and no change', () => {
    const p = forgeProject(); const orig = read(p, '.claude/settings.json');
    const r = I.applyInit(O(p, { yes: true, mergeTool: { applySettingsMerge() { throw new Error('boom'); } } }));
    assert.strictEqual(step(r, 'settings').result, 'refuse'); assert.strictEqual(read(p, '.claude/settings.json'), orig);
    assert.ok(!fs.readdirSync(path.join(p, '.claude')).some((n) => n.startsWith(I.TMP_PREFIX)));
  });

  // ---- the .forge layout ----
  t('--layout forge: .forge/ and .forge/memory/ created, memory there, CLAUDE.md points there, idempotent, check detects it', () => {
    const p = project();
    const r = I.applyInit(O(p, { yes: true, layout: 'forge' }));
    assert.strictEqual(r.layout, 'forge');
    for (const m of I.MEMORY_FILES) { assert.ok(exists(p, '.forge/memory/' + m), m); assert.ok(!exists(p, '.claude/' + m), m + ' also in .claude'); }
    assert.ok(read(p, 'CLAUDE.md').includes('`.forge/memory/`'));
    const a = snap(p); assert.strictEqual(I.applyInit(O(p, { yes: true, layout: 'forge' })).changes, 0); assert.strictEqual(snap(p), a);
    assert.strictEqual(I.checkInit(O(p)).initialised, true);
  });
  t('--layout forge never shadows a legacy memory file and names the legacy state', () => {
    const p = project({ '.claude/FORGE_MEMORY.md': 'legacy memory\n', '.claude/forge-runs/r1/run.json': '{}' });
    const plan = I.planInit(O(p, { layout: 'forge' }));
    assert.strictEqual(step(plan, 'memory', 'FORGE_MEMORY.md').action, 'keep-legacy'); assert.ok(plan.notes.includes('legacy_state'));
    I.applyInit(O(p, { yes: true, layout: 'forge' }));
    assert.ok(!exists(p, '.forge/memory/FORGE_MEMORY.md')); assert.strictEqual(read(p, '.claude/FORGE_MEMORY.md'), 'legacy memory\n');
  });

  // ---- isolation guard ----
  t('a .claude junction pointing outside the root: every write below it is refused, the outside folder untouched', () => {
    const outside = project(); const before = snap(outside);
    const p = project();
    if (!junction(outside, path.join(p, '.claude'))) return 'skip';
    const r = I.applyInit(O(p, { yes: true }));
    for (const s of r.steps.filter((x) => x.id === 'memory' || x.id === 'settings')) assert.strictEqual(s.result, 'refuse', s.file);
    assert.strictEqual(snap(outside), before);
  });
  t('assertWritable refuses the root itself, its parent and a .. escape', () => {
    const p = project();
    for (const bad of [p, path.dirname(p), path.join(p, '..', 'x.txt'), path.join(p, 'a', '..', '..', 'y')]) assert.throws(() => I.assertWritable(p, bad), /outside-root/);
    assert.strictEqual(I.assertWritable(p, path.join(p, 'ok.txt')), path.join(p, 'ok.txt'));
  });

  // ---- CLI ----
  t('CLI usage errors exit 2', () => {
    for (const args of [[], ['bogus'], ['plan', '--layout', 'x'], ['plan', '--yes'], ['apply', '--write'], ['check', '--layout', 'forge'], ['plan', '--root'], ['fragment']]) {
      assert.strictEqual(spawnSync(process.execPath, [INIT, ...args], { encoding: 'utf8', env: childEnv }).status, 2, args.join(' '));
    }
  });
  t('CLI apply --yes --json: one JSON document, schema forge-init/v1, 7 changes; then 0', () => {
    const p = project();
    const j = JSON.parse(cli(['apply', '--yes', '--json', '--root', p]).stdout);
    assert.strictEqual(j.schema, I.SCHEMA); assert.strictEqual(j.changes, 7); assert.strictEqual(j.dry_run, false);
    assert.strictEqual(JSON.parse(cli(['apply', '--yes', '--json', '--root', p]).stdout).changes, 0);
    const bad = JSON.parse(cli(['plan', '--json', '--root', path.join(BASE, 'nope')]).stdout);
    assert.strictEqual(bad.refused, 'r_missing'); assert.ok(/^Refused: .* does not exist/.test(bad.message));
  });
  t('CLI speaks Dutch with --lang nl and English by default', () => {
    const p = project();
    assert.ok(/Proefrun/.test(cli(['apply', '--lang', 'nl', '--root', p]).stdout));
    assert.ok(/Dry run/.test(cli(['apply', '--root', p]).stdout));
    assert.ok(/Geweigerd/.test(cli(['plan', '--lang', 'nl', '--root', path.join(BASE, 'nope')]).stderr));
  });
} finally {
  for (const l of LINKS) { try { fs.unlinkSync(l); } catch { try { fs.rmdirSync(l); } catch { /* left */ } } } // the link only, never its target
  try { if (path.basename(BASE).startsWith('run-') && fs.realpathSync(path.dirname(BASE)) === fs.realpathSync(PARENT)) fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* left for inspection */ }
  if (PARENT !== os.tmpdir()) { try { fs.rmdirSync(PARENT); } catch { /* not empty or gone */ } }
}
console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
process.exit(failed ? 1 : 0);
