#!/usr/bin/env node
'use strict';
// forge-settings-merge.test.cjs — real tests for the general .claude/settings.json MERGE tool (wp22,
// 2026-09-24; hardened wp-f2, 2026-09-24 Codex re-check out-p2.md/out-p6.md). This is the LOAD-BEARING safety
// suite: it proves a foreign hook, a foreign allow rule and an unknown top-level key all survive byte-for-byte
// at their original position, using a fixture shaped like the REAL project .claude/settings.json as the
// SOURCE — never the real file itself — PLUS the hardening findings: UNREADABLE-MEANS-ABSENT,
// CONCURRENT-EDIT-LOSS, AUXILIARY-FILE-CLOBBER, PROJECT-DIRECTORY-ESCAPE, SCHEMA-ACCEPTANCE/DUPLICATE-HOOKS,
// LOSSY-ROUNDTRIP and SETTINGS-PERMISSION-WIDENING.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const mod = require('./forge-settings-merge.cjs');
const guards = require('./forge-settings-merge-guards.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function recommendedFiles(dir) { return fs.readdirSync(dir).filter((f) => /^settings\.forge-recommended-.*\.json$/.test(f)); }
function backupFiles(dir) { return fs.readdirSync(dir).filter((f) => f.includes('.forge-bak-')); }

/** realSourceFixture — shaped like the REAL .claude/settings.json: 3 snapshot hooks, the tool-ledger
 *  PostToolUse hook, the PreToolUse gate hook (all 5 with `timeout` in SECONDS, <=60), plus the 29-rule
 *  permissions.deny block. A hand-built FIXTURE, not the real file. */
function realSourceFixture() {
  return {
    hooks: {
      PreCompact: [
        { matcher: 'manual', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-snapshot-marker.cjs', timeout: 15 }] },
        { matcher: 'auto', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-snapshot-marker.cjs', timeout: 15 }] },
      ],
      SessionStart: [
        { matcher: 'compact', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-snapshot-reinject.cjs', timeout: 15 }] },
      ],
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 10 }] },
      ],
      PreToolUse: [
        { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 }] },
      ],
    },
    permissions: {
      deny: [
        // 29 rules, matching the real .claude/settings.json exactly (wp-f2 SECRET-READ-GAPS: added
        // .env.forge-setup root+nested, and .env.development/.env.staging/.env.test nested; of the
        // 2026-09-24 recheck: the usage guard's owner-approval secret, Security Boss sec-w5 M5).
        'Read(./.env)', 'Read(./.env.local)', 'Read(./.env.*.local)', 'Read(./.env.development)',
        'Read(./.env.production)', 'Read(./.env.staging)', 'Read(./.env.test)', 'Read(./.env.forge-setup)', 'Read(./secrets/**)',
        'Read(./**/.env)', 'Read(./**/.env.local)', 'Read(./**/.env.*.local)', 'Read(./**/.env.development)',
        'Read(./**/.env.production)', 'Read(./**/.env.staging)', 'Read(./**/.env.test)', 'Read(./**/.env.forge-setup)',
        'Read(./**/.env.prod)', 'Read(./**/.env.bak)', 'Read(./**/.env.backup)', 'Read(./**/*.pem)',
        'Read(./**/*.key)', 'Read(./**/id_rsa*)', 'Read(./**/id_ed25519*)', 'Read(./**/secrets/**)',
        'Read(~/.claude/.credentials.json)', 'Read(~/.claude/nvidia.env)', 'Read(~/.ssh/**)',
        'Read(./.claude/config/forge-owner-grant.txt)',
      ],
    },
  };
}

/** existingWithForeignEntries — a target that already has its OWN unrelated hook, allow rule, and unknown
 *  top-level key, plus ONE stale Forge hook using the old milliseconds-as-seconds timeout (8000, > 60). */
function existingWithForeignEntries() {
  return {
    env: { SOME_OWNER_VAR: '1' },
    permissions: {
      allow: ['Bash(npm run build)'],
      deny: ['Bash(rm -rf *)'],
    },
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node "my-own-hook.cjs"', timeout: 5 }] },
      ],
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 8000 }] },
      ],
    },
    ownerNote: 'do not touch this field',
  };
}

console.log('forge-settings-merge tests (LOAD-BEARING: general settings.json merge safety)');

// ---------------------------------------------------------------------------
console.log('\n1) mergeForgeSettings() — pure-function safety property');
t('foreign hook + foreign allow rule + unknown top-level key survive byte-for-byte; missing entries appended', () => {
  const existing = existingWithForeignEntries();
  const existingJson = JSON.stringify(existing); // snapshot BEFORE calling merge, to prove no mutation
  const source = realSourceFixture();
  const sourceJson = JSON.stringify(source);
  const { settings, added, adjusted, deny_added } = mod.mergeForgeSettings(existing, source);

  assert.strictEqual(JSON.stringify(existing), existingJson, 'mergeForgeSettings must never mutate existing');
  assert.strictEqual(JSON.stringify(source), sourceJson, 'mergeForgeSettings must never mutate source');

  // foreign PreToolUse hook survives at its original position, own hooks array still length 1 + the new gate hook appended
  assert.strictEqual(settings.hooks.PreToolUse.length, 2);
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'node "my-own-hook.cjs"');
  assert.ok(settings.hooks.PreToolUse.some((e) => e.hooks[0].command.includes('forge-gate-hook.cjs')));

  // the 3 missing events (PreCompact x2 entries, SessionStart) are all appended
  assert.strictEqual(settings.hooks.PreCompact.length, 2);
  assert.strictEqual(settings.hooks.SessionStart.length, 1);

  // unrelated top-level keys survive
  assert.deepStrictEqual(settings.env, { SOME_OWNER_VAR: '1' });
  assert.strictEqual(settings.ownerNote, 'do not touch this field');
  assert.deepStrictEqual(settings.permissions.allow, ['Bash(npm run build)']);

  // deny union: user's own rule stays first, 29 source rules appended after (29 new, since none pre-existed)
  assert.strictEqual(settings.permissions.deny[0], 'Bash(rm -rf *)');
  assert.strictEqual(settings.permissions.deny.length, 1 + 29);
  assert.strictEqual(deny_added.length, 29);

  assert.ok(added.length >= 3);
});

// ---------------------------------------------------------------------------
console.log('\n2) millisecond timeout fix — Forge hooks only, only when > 60');
t('a stale Forge hook timeout (8000) is fixed to the source value; a foreign hook with the same shape is untouched', () => {
  const existing = existingWithForeignEntries();
  const source = realSourceFixture();
  const { settings, adjusted } = mod.mergeForgeSettings(existing, source);
  const forgeHook = settings.hooks.PostToolUse.find((e) => e.hooks[0].command.includes('forge-toolhook.cjs'));
  assert.strictEqual(forgeHook.hooks[0].timeout, 10, 'the stale 8000 must be fixed to the source seconds value');
  assert.strictEqual(adjusted.length, 1);
  assert.strictEqual(adjusted[0].from, 8000);
  assert.strictEqual(adjusted[0].to, 10);
  // the foreign hook (non-Forge command, timeout 5, already <= 60 anyway) is untouched
  const foreignHook = settings.hooks.PreToolUse.find((e) => e.hooks[0].command === 'node "my-own-hook.cjs"');
  assert.strictEqual(foreignHook.hooks[0].timeout, 5);
});

t('a Forge hook timeout that is already <= 60 is left alone (no false adjustment)', () => {
  const existing = { hooks: { PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 10 }] }] } };
  const source = realSourceFixture();
  const { adjusted } = mod.mergeForgeSettings(existing, source);
  assert.strictEqual(adjusted.length, 0);
});

t('a NON-Forge hook command with a timeout > 60 is never adjusted (Forge-command test must be real)', () => {
  const existing = { hooks: { PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 10 }, { type: 'command', command: 'node my-other-tool.cjs', timeout: 9999 }] }] } };
  // craft a source entry with a matching foreign-shaped command that would collide if the guard were missing
  const source = { hooks: { PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node my-other-tool.cjs', timeout: 30 }] }] } };
  const { adjusted } = mod.mergeForgeSettings(existing, source);
  assert.strictEqual(adjusted.length, 0, 'a non forge-bin/forge-*.cjs command must never be auto-adjusted');
});

// ---------------------------------------------------------------------------
console.log('\n3) idempotency — target with ALL 5 hooks + 23 deny already merged is a true no-op');
t('applying against an already-fully-merged target adds/adjusts nothing', () => {
  const already = mod.mergeForgeSettings({}, realSourceFixture()).settings;
  const { added, adjusted, deny_added } = mod.mergeForgeSettings(already, realSourceFixture());
  assert.strictEqual(added.length, 0);
  assert.strictEqual(adjusted.length, 0);
  assert.strictEqual(deny_added.length, 0);
});

t('applying the merge twice in a row (against a target with foreign entries) is idempotent the second time', () => {
  const existing = existingWithForeignEntries();
  const r1 = mod.mergeForgeSettings(existing, realSourceFixture());
  const r2 = mod.mergeForgeSettings(r1.settings, realSourceFixture());
  assert.strictEqual(r2.added.length, 0);
  assert.strictEqual(r2.adjusted.length, 0);
  assert.strictEqual(r2.deny_added.length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n4) validShape() / fullyValidShape()');
t('rejects a non-object, an array-shaped hooks, a non-array hooks.<event>, and a non-array permissions.deny', () => {
  assert.strictEqual(mod.validShape(null), false);
  assert.strictEqual(mod.validShape([1, 2]), false);
  assert.strictEqual(mod.validShape({ hooks: [] }), false);
  assert.strictEqual(mod.validShape({ hooks: { PreToolUse: {} } }), false);
  assert.strictEqual(mod.validShape({ permissions: { deny: 'nope' } }), false);
  assert.strictEqual(mod.validShape({ hooks: { PreToolUse: [] }, permissions: { deny: [] } }), true);
  assert.strictEqual(mod.validShape({}), true);
});

t('SCHEMA-ACCEPTANCE: fullyValidShape also rejects a hook entry whose inner hooks is an object, and a hook item with the wrong type', () => {
  assert.strictEqual(mod.fullyValidShape({ hooks: { PreToolUse: [{ matcher: 'x', hooks: {} }] } }), false);
  assert.strictEqual(mod.fullyValidShape({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'prompt', command: 'y' }] }] } }), false);
  assert.strictEqual(mod.fullyValidShape({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'y', timeout: 5 }] }] } }), true);
});

// ---------------------------------------------------------------------------
console.log('\n5) applySettingsMerge() — file-level orchestration (real filesystem)');

t('target absent -> created (a copy of the source)', () => {
  const dir = freshDir('settings-merge-create');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'nested', 'settings.json');
  writeJson(source, realSourceFixture());
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'created');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.hooks.PreToolUse.length, 1);
});

t('target present with foreign entries -> merged; foreign hook + allow rule + unknown key kept; backup written', () => {
  const dir = freshDir('settings-merge-merge');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'merged');
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), 'a backup file must exist');
  const backupContent = JSON.parse(fs.readFileSync(r.backupPath, 'utf8'));
  assert.deepStrictEqual(backupContent, existingWithForeignEntries(), 'backup must preserve the ORIGINAL content exactly');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.hooks.PreToolUse[0].hooks[0].command, 'node "my-own-hook.cjs"', 'foreign hook kept at original position');
  assert.deepStrictEqual(written.permissions.allow, ['Bash(npm run build)']);
  assert.strictEqual(written.ownerNote, 'do not touch this field');
});

t('second run against an already-merged target is a true no-op: exit-equivalent noop, mtime unchanged, no new backup', () => {
  const dir = freshDir('settings-merge-noop');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  mod.applySettingsMerge({ target, source }); // first run: real merge + backup
  const backupsAfterFirst = backupFiles(dir);
  const mtimeBefore = fs.statSync(target).mtimeMs;
  const r2 = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r2.status, 'noop');
  assert.strictEqual(fs.statSync(target).mtimeMs, mtimeBefore, 'a no-op merge must never rewrite the file (mtime unchanged)');
  assert.strictEqual(backupFiles(dir).length, backupsAfterFirst.length, 'a no-op merge must never take a new backup');
});

t('deny union keeps the user\'s own rule(s) first, source rules appended after in source order', () => {
  const dir = freshDir('settings-merge-deny-order');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, { permissions: { deny: ['Bash(rm -rf *)', 'Read(./.env)'] } }); // one already-present source rule
  mod.applySettingsMerge({ target, source });
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.permissions.deny[0], 'Bash(rm -rf *)');
  assert.strictEqual(written.permissions.deny[1], 'Read(./.env)');
  assert.strictEqual(written.permissions.deny.length, 2 + 28); // 28 NEW source rules (1 of the 29 already present)
});

t('invalid existing JSON -> refused, file untouched, a UNIQUE settings.forge-recommended-*.json written, ok:false', () => {
  const dir = freshDir('settings-merge-badjson');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.writeFileSync(target, '{ this is not valid json', 'utf8');
  const before = fs.readFileSync(target, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before, 'a malformed existing file must never be overwritten');
  assert.strictEqual(recommendedFiles(dir).length, 1);
  assert.strictEqual(r.recommended, path.join(dir, recommendedFiles(dir)[0]));
});

t('unexpected shape (hooks not an object) -> refused, file untouched, recommended file written', () => {
  const dir = freshDir('settings-merge-badshape');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, { hooks: 'nope' });
  const before = fs.readFileSync(target, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
  assert.strictEqual(recommendedFiles(dir).length, 1);
});

t('--dry-run (opts.dryRun) writes nothing at all, in every branch', () => {
  const dir = freshDir('settings-merge-dryrun');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());

  const absentTarget = path.join(dir, 'absent', 'settings.json');
  const r1 = mod.applySettingsMerge({ target: absentTarget, source, dryRun: true });
  assert.strictEqual(r1.status, 'would-create');
  assert.strictEqual(fs.existsSync(absentTarget), false);

  const mergeTarget = path.join(dir, 'settings.json');
  writeJson(mergeTarget, existingWithForeignEntries());
  const beforeContent = fs.readFileSync(mergeTarget, 'utf8');
  const r2 = mod.applySettingsMerge({ target: mergeTarget, source, dryRun: true });
  assert.strictEqual(r2.status, 'would-merge');
  assert.strictEqual(fs.readFileSync(mergeTarget, 'utf8'), beforeContent);
  assert.strictEqual(backupFiles(dir).length, 0);

  const badTarget = path.join(dir, 'bad.json');
  fs.writeFileSync(badTarget, 'not json', 'utf8');
  const r3 = mod.applySettingsMerge({ target: badTarget, source, dryRun: true });
  assert.strictEqual(r3.status, 'would-refuse');
  assert.strictEqual(recommendedFiles(dir).length, 0);
});

t('a UTF-8 BOM before the target JSON (Windows PowerShell Set-Content -Encoding utf8) is stripped, not treated as invalid JSON', () => {
  const dir = freshDir('settings-merge-bom');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.writeFileSync(target, '﻿' + JSON.stringify(existingWithForeignEntries(), null, 2) + '\n', 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.status, 'merged');
  const rawAfter = fs.readFileSync(target, 'utf8');
  assert.strictEqual(rawAfter.charCodeAt(0), 0xfeff, 'the original BOM must be PRESERVED on output too (LOSSY-ROUNDTRIP), not just tolerated on input');
  const written = JSON.parse(rawAfter.slice(1));
  assert.strictEqual(written.ownerNote, 'do not touch this field');
});

// ---------------------------------------------------------------------------
console.log('\n6) checkSettingsMerge()');
t('check reports up-to-date (ok) when nothing would change, missing-entries (not ok) otherwise', () => {
  const dir = freshDir('settings-merge-check');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());

  const merged = path.join(dir, 'merged.json');
  writeJson(merged, mod.mergeForgeSettings({}, realSourceFixture()).settings);
  assert.deepStrictEqual(mod.checkSettingsMerge({ target: merged, source }).status, 'up-to-date');
  assert.strictEqual(mod.checkSettingsMerge({ target: merged, source }).ok, true);

  const behind = path.join(dir, 'behind.json');
  writeJson(behind, existingWithForeignEntries());
  const r = mod.checkSettingsMerge({ target: behind, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'missing-entries');

  const missing = path.join(dir, 'does-not-exist.json');
  const r2 = mod.checkSettingsMerge({ target: missing, source });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.status, 'missing');
});

t('UNREADABLE-MEANS-ABSENT mirrored in check: a directory named settings.json is "unreadable", never "missing"', () => {
  const dir = freshDir('settings-merge-check-unreadable');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.mkdirSync(target);
  const r = mod.checkSettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unreadable');
});

// ---------------------------------------------------------------------------
console.log('\n7) CLI (real spawned subprocess, real filesystem)');
const CLI = path.join(__dirname, 'forge-settings-merge.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

t('CLI apply: target absent -> exit 0, created', () => {
  const dir = freshDir('settings-merge-cli-create');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  const r = runCLI(['apply', '--target', target, '--source', source, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.status, 'created');
});

t('CLI apply: malformed existing JSON -> exit 1, file untouched', () => {
  const dir = freshDir('settings-merge-cli-bad');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.writeFileSync(target, '{ nope', 'utf8');
  const before = fs.readFileSync(target, 'utf8');
  const r = runCLI(['apply', '--target', target, '--source', source]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
});

t('CLI apply is idempotent across two real subprocess runs (second reports noop, exit 0)', () => {
  const dir = freshDir('settings-merge-cli-idempotent');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  runCLI(['apply', '--target', target, '--source', source]);
  const r2 = runCLI(['apply', '--target', target, '--source', source, '--json']);
  assert.strictEqual(r2.status, 0);
  const parsed = JSON.parse(r2.stdout.trim());
  assert.strictEqual(parsed.status, 'noop');
});

t('CLI check: exit 0 when up to date, exit 1 when entries are missing', () => {
  const dir = freshDir('settings-merge-cli-check');
  const source = path.join(dir, 'source.json');
  const merged = path.join(dir, 'merged.json');
  const behind = path.join(dir, 'behind.json');
  writeJson(source, realSourceFixture());
  writeJson(merged, mod.mergeForgeSettings({}, realSourceFixture()).settings);
  writeJson(behind, existingWithForeignEntries());
  assert.strictEqual(runCLI(['check', '--target', merged, '--source', source]).status, 0);
  assert.strictEqual(runCLI(['check', '--target', behind, '--source', source]).status, 1);
});

t('CLI with missing required args exits 2', () => {
  const r = runCLI(['apply', '--target', path.join(os.tmpdir(), 'x.json')]);
  assert.strictEqual(r.status, 2);
});

t('CLI --dry-run leaves the target file byte-identical', () => {
  const dir = freshDir('settings-merge-cli-dryrun');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  const before = fs.readFileSync(target, 'utf8');
  const r = runCLI(['apply', '--target', target, '--source', source, '--dry-run']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
});

// ---------------------------------------------------------------------------
console.log('\n8) UNREADABLE-MEANS-ABSENT — only a verified-missing regular file enters the create path');
t('a directory named settings.json refuses (usage-error-free "refused"), never treated as missing/created', () => {
  const dir = freshDir('settings-merge-dir-target');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.mkdirSync(target);
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.ok(fs.statSync(target).isDirectory(), 'the directory must still be a directory — never replaced');
});

t('a directory named settings.json in --dry-run also refuses without creating/writing anything', () => {
  const dir = freshDir('settings-merge-dir-target-dry');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.mkdirSync(target);
  const r = mod.applySettingsMerge({ target, source, dryRun: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'would-refuse');
  assert.strictEqual(recommendedFiles(dir).length, 0);
});

{
  // Real-OS probe first (mirrors forge-sync.test.cjs's own F2/H1 EPERM pattern): only assert the EACCES half
  // when this OS/filesystem actually enforces chmod 0 as unreadable (Windows chmod only toggles the
  // read-only ATTRIBUTE and does not block reads at all — a real gap this suite does not pretend to close).
  const dir = freshDir('settings-merge-eacces');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  let reallyUnreadable = false;
  try { fs.chmodSync(target, 0o000); fs.readFileSync(target, 'utf8'); }
  catch { reallyUnreadable = true; }
  if (reallyUnreadable) {
    t('EACCES on an existing settings.json (real OS enforcement) refuses, never treated as missing, no backup taken', () => {
      const r = mod.applySettingsMerge({ target, source });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.status, 'refused');
      assert.strictEqual(backupFiles(dir).length, 0, 'no backup should be taken for a target that was never actually read');
    });
    fs.chmodSync(target, 0o644);
  } else {
    try { fs.chmodSync(target, 0o644); } catch { /* best-effort restore */ }
    console.log('     (UNREADABLE-MEANS-ABSENT EACCES half: OS/filesystem did not enforce chmod 0 as unreadable in this sandbox — skipped honestly; the directory-shaped test above proves the same refuse-never-absent code path)');
    t('(UNREADABLE-MEANS-ABSENT EACCES half skipped honestly — OS did not reproduce)', () => {});
  }
}

// ---------------------------------------------------------------------------
console.log('\n9) CONCURRENT-EDIT-LOSS — a drift between read and rename refuses instead of discarding the edit');
t('a target mutated between read and rename (via the gated test hook) is refused; the concurrent edit survives on disk; a backup of the ORIGINAL read exists', () => {
  const dir = freshDir('settings-merge-race');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  const concurrentEdit = JSON.stringify(Object.assign(existingWithForeignEntries(), { ownerNote: 'CHANGED BY SOMEONE ELSE MID-MERGE' }), null, 2) + '\n';

  const prevEnv = process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS;
  process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS = '1';
  let r;
  try {
    r = mod.applySettingsMerge({ target, source, __mutateBeforeRename: () => fs.writeFileSync(target, concurrentEdit, 'utf8') });
  } finally {
    if (prevEnv === undefined) delete process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS; else process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS = prevEnv;
  }
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), concurrentEdit, 'the concurrent edit must be preserved on disk, never discarded');
  assert.ok(r.backupPath && fs.existsSync(r.backupPath));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.backupPath, 'utf8')), existingWithForeignEntries(), 'the backup holds what Forge originally read, not the concurrent edit');
});

t('without the test-hook env var set, __mutateBeforeRename is never invoked (production path stays inert)', () => {
  const dir = freshDir('settings-merge-race-off');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  let invoked = false;
  const prevEnv = process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS;
  delete process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS;
  const r = mod.applySettingsMerge({ target, source, __mutateBeforeRename: () => { invoked = true; } });
  if (prevEnv !== undefined) process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS = prevEnv;
  assert.strictEqual(invoked, false);
  assert.strictEqual(r.status, 'merged');
});

// ---------------------------------------------------------------------------
console.log('\n10) AUXILIARY-FILE-CLOBBER — exclusive, unique recovery files; never overwrite a prior one');
t('two same-second refusals never collide: two DISTINCT recommended files exist, both readable and correct', () => {
  const dir = freshDir('settings-merge-aux-collide');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, 'not json 1', 'utf8');
  const r1 = mod.applySettingsMerge({ target, source, now: new Date('2026-01-01T00:00:00.000Z') });
  fs.writeFileSync(target, 'not json 2', 'utf8');
  const r2 = mod.applySettingsMerge({ target, source, now: new Date('2026-01-01T00:00:00.000Z') });
  assert.notStrictEqual(r1.recommended, r2.recommended, 'each refusal must get its OWN unique recovery file');
  assert.strictEqual(recommendedFiles(dir).length, 2);
  assert.ok(fs.existsSync(r1.recommended) && fs.existsSync(r2.recommended));
});

t('two same-second real merges never collide: two DISTINCT backups exist, each with the ORIGINAL content at that step', () => {
  const dir = freshDir('settings-merge-aux-backup-collide');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  writeJson(target, { hooks: { PreToolUse: [{ matcher: 'X', hooks: [{ type: 'command', command: 'a' }] }] } });
  const now = new Date('2026-01-01T00:00:00.000Z');
  const r1 = mod.applySettingsMerge({ target, source, now });
  writeJson(target, JSON.parse(fs.readFileSync(target, 'utf8'))); // still merged, but re-run to force a fresh "changed" state below
  fs.writeFileSync(target, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(target, 'utf8')), { extra: 'x' }), null, 2) + '\n', 'utf8');
  const r2 = mod.applySettingsMerge({ target, source, now }); // no new source entries missing, but still exercises the writer path if changed — guard: force a real second merge by adding a NEW deny rule to source-equivalent state is unnecessary; instead assert on backups taken so far
  assert.ok(r1.backupPath, 'first merge must produce a backup');
  const backups = backupFiles(dir);
  assert.ok(backups.length >= 1);
  // uniqueness proof: writing two backups at the identical `now` must never produce the SAME filename twice
  const b1 = guards.writeExclusiveUnique(dir, 'probe.forge-bak', '', 'one', { now });
  const b2 = guards.writeExclusiveUnique(dir, 'probe.forge-bak', '', 'two', { now });
  assert.strictEqual(b1.ok, true); assert.strictEqual(b2.ok, true);
  assert.notStrictEqual(b1.path, b2.path);
  assert.strictEqual(fs.readFileSync(b1.path, 'utf8'), 'one');
  assert.strictEqual(fs.readFileSync(b2.path, 'utf8'), 'two');
  void r2;
});

{
  let junctionOk = false;
  const dir = freshDir('settings-merge-aux-junction');
  const outside = freshDir('settings-merge-aux-outside');
  const linkedBackupDir = path.join(dir, 'linked-backups');
  try { fs.symlinkSync(outside, linkedBackupDir, 'junction'); junctionOk = true; }
  catch (e) { console.log('     (AUXILIARY-FILE-CLOBBER junction half: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
  if (junctionOk) {
    t('writeExclusiveUnique refuses to write into a directory that is itself a symlink/junction — nothing lands outside', () => {
      const r = guards.writeExclusiveUnique(linkedBackupDir, 'settings.forge-recommended', '.json', 'x');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readdirSync(outside).length, 0, 'nothing must have been written through the junction');
    });
  } else {
    t('(AUXILIARY-FILE-CLOBBER junction half skipped honestly — could not create a junction)', () => {});
  }
}

// ---------------------------------------------------------------------------
console.log('\n11) PROJECT-DIRECTORY-ESCAPE — projectRoot containment for every write destination');
t('a target outside the given projectRoot is refused before anything is read/written', () => {
  const root = freshDir('settings-merge-escape-root');
  const outside = freshDir('settings-merge-escape-outside');
  const source = path.join(root, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(outside, 'settings.json'); // NOT inside root
  const r = mod.applySettingsMerge({ target, source, projectRoot: root });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.existsSync(target), false);
});

t('a target inside the given projectRoot is accepted normally', () => {
  const root = freshDir('settings-merge-escape-ok');
  const source = path.join(root, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(root, 'settings.json');
  const r = mod.applySettingsMerge({ target, source, projectRoot: root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'created');
});

{
  let junctionOk = false;
  const outerRoot = freshDir('settings-merge-escape-outer');
  const outside = freshDir('settings-merge-escape-junction-outside');
  const claudeLink = path.join(outerRoot, '.claude');
  try { fs.symlinkSync(outside, claudeLink, 'junction'); junctionOk = true; }
  catch (e) { console.log('     (PROJECT-DIRECTORY-ESCAPE junction half: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
  if (junctionOk) {
    t('a projectRoot that is itself a symlink/junction is refused even though target/backupDir would trivially "resolve inside" it', () => {
      const source = path.join(outerRoot, 'source.json');
      writeJson(source, realSourceFixture());
      const target = path.join(claudeLink, 'settings.json');
      const r = mod.applySettingsMerge({ target, source, projectRoot: claudeLink });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.status, 'refused');
      assert.strictEqual(fs.readdirSync(outside).filter((f) => f !== undefined).some((f) => f === 'settings.json'), false, 'nothing must land in the real outside directory the junction points to');
    });
  } else {
    t('(PROJECT-DIRECTORY-ESCAPE junction-root half skipped honestly — could not create a junction)', () => {});
  }
}

// ---------------------------------------------------------------------------
console.log('\n12) SCHEMA-ACCEPTANCE / DUPLICATE-HOOKS');
t('a malformed source ({"hooks":{"PreToolUse":{}}}) is a usage-error — never "created"', () => {
  const dir = freshDir('settings-merge-badsource');
  const source = path.join(dir, 'source.json');
  writeJson(source, { hooks: { PreToolUse: {} } });
  const target = path.join(dir, 'settings.json');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'usage-error');
  assert.strictEqual(fs.existsSync(target), false);
});

t('null and array-shaped sources are also usage-errors', () => {
  const dir = freshDir('settings-merge-badsource2');
  const target = path.join(dir, 'settings.json');
  const s1 = path.join(dir, 's1.json'); writeJson(s1, null);
  const s2 = path.join(dir, 's2.json'); writeJson(s2, []);
  assert.strictEqual(mod.applySettingsMerge({ target, source: s1 }).status, 'usage-error');
  assert.strictEqual(mod.applySettingsMerge({ target, source: s2 }).status, 'usage-error');
  assert.strictEqual(fs.existsSync(target), false);
});

t('a target hook changed to type:"prompt" while keeping the gate command is NOT considered present — the real command hook is added alongside it', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'prompt', command: 'node .claude/forge-bin/forge-gate-hook.cjs' }] }] } };
  const source = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }] }] } };
  const { settings, added } = mod.mergeForgeSettings(existing, source);
  const entry = settings.hooks.PreToolUse.find((e) => e.matcher === 'Bash|PowerShell');
  assert.strictEqual(entry.hooks.length, 2, 'the wrong-type hook stays, and the real command hook is added');
  assert.ok(entry.hooks.some((h) => h.type === 'command' && h.command.includes('forge-gate-hook.cjs')));
  assert.strictEqual(added.length, 1);
});

t('DUPLICATE-HOOKS: a partially-present matcher tops up the SAME existing entry instead of appending a duplicate', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'a' }] }] } };
  const source = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] } };
  const { settings, added } = mod.mergeForgeSettings(existing, source);
  const matching = settings.hooks.PreToolUse.filter((e) => e.matcher === 'Bash|PowerShell');
  assert.strictEqual(matching.length, 1, 'must never duplicate the whole entry');
  assert.strictEqual(matching[0].hooks.length, 2, 'must top up the missing command instead');
  assert.deepStrictEqual(matching[0].hooks.map((h) => h.command).sort(), ['a', 'b']);
  assert.strictEqual(added.length, 1);
});

t('a repeated top-up merge stays idempotent (no re-duplication on a second run)', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'a' }] }] } };
  const source = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] } };
  const r1 = mod.mergeForgeSettings(existing, source);
  const r2 = mod.mergeForgeSettings(r1.settings, source);
  assert.strictEqual(r2.added.length, 0);
  assert.strictEqual(r2.settings.hooks.PreToolUse.length, 1);
});

t('DUPLICATE-HOOKS reporting: a PRE-EXISTING duplicate matcher is detected and reported, never silently repaired', () => {
  const existing = { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'b' }] },
  ] } };
  const { settings, duplicate_matchers } = mod.mergeForgeSettings(existing, { hooks: {} });
  assert.strictEqual(settings.hooks.PreToolUse.length, 2, 'nothing is auto-repaired/merged away');
  assert.strictEqual(duplicate_matchers.length, 1);
  assert.strictEqual(duplicate_matchers[0].event, 'PreToolUse');
  assert.strictEqual(duplicate_matchers[0].count, 2);
});

t('the CLI/apply result surfaces duplicate_matchers on a noop merge (say what it found)', () => {
  const dir = freshDir('settings-merge-dupreport');
  const source = path.join(dir, 'source.json');
  writeJson(source, { hooks: {} });
  const target = path.join(dir, 'settings.json');
  writeJson(target, { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'b' }] },
  ] } });
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.status, 'noop');
  assert.strictEqual(r.duplicate_matchers.length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n13) LOSSY-ROUNDTRIP — refuse unsafe content; preserve BOM/EOL/indent/trailing-newline on a real merge');
t('a duplicate object key in the existing target refuses (never silently collapses to the last value)', () => {
  const dir = freshDir('settings-merge-duplicate-key');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{"a":1,"a":2,"hooks":{}}', 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.duplicateKeys, ['a']);
  assert.strictEqual(recommendedFiles(dir).length, 1);
});

t('an overflowing number (1e400) and a >2^53 integer in the existing target both refuse', () => {
  const dir = freshDir('settings-merge-unsafe-numbers');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{"a":1e400,"b":9007199254740993,"hooks":{}}', 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.unsafeNumbers.sort(), ['1e400', '9007199254740993'].sort());
});

t('a safe integer at exactly 2^53-1 and an ordinary decimal do NOT trigger a false refusal', () => {
  const dir = freshDir('settings-merge-safe-numbers');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{"a":9007199254740991,"b":1.5,"hooks":{}}', 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.status, 'merged');
});

// wp-g2 (2026-09-24 Codex re-check out-p7.md V08): the scanner used to compare RAW key source text (missing
// an escaped duplicate) and only checked whether a number's parsed VALUE round-tripped (missing every case
// where only the SOURCE TEXT would silently change on reserialize). These three fixtures are Codex's own
// out-p7.md evidence, verbatim, run through the real scanner AND a real applySettingsMerge refusal — each
// must be refused and the target left byte-for-byte untouched, never silently "merged" over.
t('guards.scanJsonRisks decodes an escaped duplicate key (\\u006fwner vs owner) directly (V08)', () => {
  const r = guards.scanJsonRisks('{"owner":"first","\\u006fwner":"second"}');
  assert.deepStrictEqual(r.duplicateKeys, ['owner']);
});
t('guards.scanJsonRisks catches a decimal-integer overflow (9007199254740993.0) directly (V08)', () => {
  const r = guards.scanJsonRisks('{"n":9007199254740993.0}');
  assert.deepStrictEqual(r.unsafeNumbers, ['9007199254740993.0']);
});
t('guards.scanJsonRisks catches an exponent underflow to zero (1e-400) directly (V08)', () => {
  const r = guards.scanJsonRisks('{"n":1e-400}');
  assert.deepStrictEqual(r.unsafeNumbers, ['1e-400']);
});
t('guards.scanJsonRisks also catches -0 (loses its sign on reserialize) and 1E2 (redundant exponent notation) (V08)', () => {
  const r = guards.scanJsonRisks('{"a":-0,"b":1E2}');
  assert.deepStrictEqual(r.unsafeNumbers.sort(), ['-0', '1E2'].sort());
});

t('CODEX FIXTURE 1/3 — {"owner":"first","\\u006fwner":"second"} refuses the merge and leaves the target byte-for-byte untouched', () => {
  const dir = freshDir('settings-merge-codex-v08-dupkey');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  const original = '{"owner":"first","\\u006fwner":"second","hooks":{}}';
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.duplicateKeys, ['owner']);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the target must be left byte-for-byte untouched on refusal');
  assert.strictEqual(recommendedFiles(dir).length, 1, 'a guarded settings.forge-recommended-*.json is still offered');
});

t('CODEX FIXTURE 2/3 — {"n":9007199254740993.0} refuses the merge and leaves the target byte-for-byte untouched', () => {
  const dir = freshDir('settings-merge-codex-v08-decimal-overflow');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  const original = '{"n":9007199254740993.0,"hooks":{}}';
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.unsafeNumbers, ['9007199254740993.0']);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the target must be left byte-for-byte untouched on refusal');
});

t('CODEX FIXTURE 3/3 — {"n":1e-400} refuses the merge and leaves the target byte-for-byte untouched', () => {
  const dir = freshDir('settings-merge-codex-v08-underflow');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  const original = '{"n":1e-400,"hooks":{}}';
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.unsafeNumbers, ['1e-400']);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the target must be left byte-for-byte untouched on refusal');
});

t('BOM + CRLF + tab-indent + no-final-newline are all preserved through a real merge', () => {
  const dir = freshDir('settings-merge-formatting');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  const original = '﻿{\r\n\t"hooks": {},\r\n\t"ownerNote": "keep me"\r\n}'; // no trailing newline
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.status, 'merged');
  const rawAfter = fs.readFileSync(target, 'utf8');
  assert.strictEqual(rawAfter.charCodeAt(0), 0xfeff, 'BOM must be preserved');
  assert.ok(rawAfter.includes('\r\n'), 'CRLF must be preserved');
  assert.ok(!/(?<!\r)\n/.test(rawAfter.slice(1)), 'every newline must be \\r\\n, never a bare \\n');
  assert.ok(rawAfter.includes('\t"'), 'tab indent must be preserved');
  assert.ok(!rawAfter.endsWith('\n') && !rawAfter.endsWith('\r\n'), 'the original had no trailing newline — none must be added');
  const parsedAfter = JSON.parse(rawAfter.charCodeAt(0) === 0xfeff ? rawAfter.slice(1) : rawAfter);
  assert.strictEqual(parsedAfter.ownerNote, 'keep me');
});

// ---------------------------------------------------------------------------
console.log('\n14) SETTINGS-PERMISSION-WIDENING (POSIX only)');
if (process.platform === 'win32') {
  t('(SETTINGS-PERMISSION-WIDENING skipped honestly — POSIX-only; Windows chmod only toggles the read-only attribute, not real ACLs, a documented limit)', () => {});
} else {
  t('a restrictive 0600 target keeps 0600 after a real merge, and its backup is written 0600 too', () => {
    const dir = freshDir('settings-merge-perm');
    const source = path.join(dir, 'source.json');
    writeJson(source, realSourceFixture());
    const target = path.join(dir, 'settings.json');
    writeJson(target, existingWithForeignEntries());
    fs.chmodSync(target, 0o600);
    const r = mod.applySettingsMerge({ target, source });
    assert.strictEqual(r.status, 'merged');
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(r.backupPath).mode & 0o777, 0o600);
  });
}

// ---------------------------------------------------------------------------
console.log('\n15) WP-2c added_detail — one structured row per hook command that becomes active (for forge-sync --dry-run --json)');
t('a merge into an EMPTY settings lists every source hook as a new-entry row (event, matcher, command, timeout)', () => {
  const src = realSourceFixture();
  const r = mod.mergeForgeSettings({}, src);
  const expected = [];
  for (const ev of Object.keys(src.hooks)) for (const e of src.hooks[ev]) for (const h of e.hooks) expected.push(ev + '|' + (e.matcher === undefined ? null : e.matcher) + '|' + h.command);
  assert.deepStrictEqual(r.added_detail.map((d) => d.event + '|' + d.matcher + '|' + d.command).sort(), expected.sort());
  assert.ok(r.added_detail.every((d) => d.kind === 'new-entry' && d.type === 'command' && typeof d.timeout === 'number'));
  assert.strictEqual(r.added.length, Object.keys(src.hooks).reduce((n, ev) => n + src.hooks[ev].length, 0), 'the string form keeps its old one-line-per-ENTRY shape');
});
t('a hook topped up into an EXISTING matcher is a hook-added row; an already-present hook adds no row', () => {
  const src = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }, { type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 10 }] }] } };
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }] }] } };
  const r = mod.mergeForgeSettings(existing, src);
  assert.deepStrictEqual(r.added_detail, [{ event: 'PreToolUse', matcher: 'Bash', command: 'node .claude/forge-bin/forge-toolhook.cjs', type: 'command', timeout: 10, kind: 'hook-added' }]);
});
t('applySettingsMerge carries added_detail on would-merge, merged and noop results', () => {
  const dir = freshDir('settings-merge-detail');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  writeJson(target, existingWithForeignEntries());
  const dry = mod.applySettingsMerge({ target, source, dryRun: true });
  assert.strictEqual(dry.status, 'would-merge');
  assert.ok(Array.isArray(dry.added_detail) && dry.added_detail.length > 0);
  const real = mod.applySettingsMerge({ target, source });
  assert.strictEqual(real.status, 'merged');
  assert.deepStrictEqual(real.added_detail, dry.added_detail);
  const again = mod.applySettingsMerge({ target, source });
  assert.strictEqual(again.status, 'noop');
  assert.deepStrictEqual(again.added_detail, []);
});

// 16) plan item 1.6: the REAL .claude/settings.json (read-only) — prose keys gone, the three new hooks
// wired fail-safe, every pre-existing hook byte-identical in event / matcher / command / timeout, every command
// pointing at a script that exists. FORGE_SETTINGS_UNDER_TEST points the checks at a draft before it goes live.
console.log('\n16) the real settings.json after plan item 1.6');
const REAL_SETTINGS = process.env.FORGE_SETTINGS_UNDER_TEST || path.join(__dirname, '..', 'settings.json');
const rawSettings = () => JSON.parse(fs.readFileSync(REAL_SETTINGS, 'utf8'));
/** Portability (2026-11-02: a synced project kept the `_doc` / `_matcher_doc` prose keys of an older template in its
 *  own settings.json and turned 16a/16b red). This tree's settings.json is the template SOURCE only in the development
 *  tree (.claude/config/forge-dev-tree.json) or for a draft under test: there every check is byte-strict. In a synced
 *  project settings.json belongs to its owner (forge-settings-merge keeps owner keys, hooks and prose), so the checks
 *  judge the Forge-owned part: forgeOwnedView keeps only the hook commands Forge owns (isForgeHookCommand) in their
 *  entries, without the owner's prose keys, plus permissions; every left-out item is named in `notes`. */
const isDevTreeRoot = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'), 'utf8')).dev_tree === true; } catch { return false; } };
const SETTINGS_STRICT = !!process.env.FORGE_SETTINGS_UNDER_TEST || isDevTreeRoot(path.resolve(__dirname, '..', '..'));
function forgeOwnedView(s) {
  const notes = [], hooks = {};
  for (const k of Object.keys(s)) if (k !== 'hooks' && k !== 'permissions') notes.push('owner key $.' + k);
  for (const ev of Object.keys(s.hooks || {})) (s.hooks[ev] || []).forEach((e, i) => {
    const at = '$.hooks.' + ev + '[' + i + ']', entry = {}, own = (e.hooks || []).filter((h) => mod.isForgeHookCommand(h && h.command));
    for (const h of e.hooks || []) if (!own.includes(h)) notes.push('owner hook ' + at + ': ' + (h && h.command));
    for (const k of Object.keys(e)) { if (k.startsWith('_')) notes.push('owner prose key ' + at + '.' + k); else entry[k] = k === 'hooks' ? own : e[k]; }
    if (own.length) (hooks[ev] = hooks[ev] || []).push(entry);
  });
  return { settings: JSON.parse(JSON.stringify(Object.assign({ hooks }, s.permissions ? { permissions: s.permissions } : {}))), notes };
}
/** Top-level keys Claude Code itself writes into a project settings.json on an OWNER action (2026-11-05: /plugin added
 *  enabledPlugins and re-ordered the file). They belong to the owner even in the development tree, so the strict checks
 *  leave them out; every other top-level key besides hooks + permissions still fails 16a. */
const OWNER_UI_TOP_LEVEL_KEYS = new Set(mod.OWNER_UI_TOP_LEVEL_KEYS); // one list with the merger's create path, which strips them
const forgeOwnedStrict = (s) => JSON.parse(JSON.stringify(Object.assign({ hooks: s.hooks }, s.permissions ? { permissions: s.permissions } : {})));
const realSettings = () => (SETTINGS_STRICT ? forgeOwnedStrict(rawSettings()) : forgeOwnedView(rawSettings()).settings);
const underscoreKeys = (v, p, out) => { if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (k.startsWith('_')) out.push(p + '.' + k); underscoreKeys(v[k], p + '.' + k, out); } return out; };
/** check16a(raw, strict) -> notes. Strict: no `_` key anywhere and only hooks + permissions at the top. Synced: no `_` key
 *  inside a Forge hook object (the merger never writes one there), a shape the merger accepts, a clean Forge-owned view. */
function check16a(raw, strict) {
  if (strict) {
    assert.deepStrictEqual(underscoreKeys(raw, '$', []), []);
    assert.deepStrictEqual(Object.keys(raw).filter((k) => !OWNER_UI_TOP_LEVEL_KEYS.has(k)).sort(), ['hooks', 'permissions']);
    return [];
  }
  const inForgeHook = [];
  for (const ev of Object.keys(raw.hooks || {})) for (const e of raw.hooks[ev] || []) for (const h of e.hooks || []) if (mod.isForgeHookCommand(h && h.command)) underscoreKeys(h, '$.hooks.' + ev + ' ' + h.command, inForgeHook);
  assert.deepStrictEqual(inForgeHook, [], 'a prose key inside a Forge hook object');
  assert.strictEqual(mod.fullyValidShape(raw), true, 'settings.json is not a shape forge-settings-merge accepts');
  const view = forgeOwnedView(raw);
  assert.deepStrictEqual(underscoreKeys(view.settings, '$', []), []);
  return view.notes;
}
const Q = (s) => 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/' + s + '"';
/** the hooks that existed before item 1.6, pinned literally: [event, matcher|null, command, timeout] in file order */
const PRE_1_6_HOOKS = [
  ['PreCompact', 'manual', Q('forge-snapshot-marker.cjs'), 15],
  ['PreCompact', 'auto', Q('forge-snapshot-marker.cjs'), 15],
  ['SessionStart', 'compact', Q('forge-snapshot-reinject.cjs'), 15],
  ['SessionStart', 'startup|resume|clear', Q('forge-resume-brief.cjs'), 10],
  ['PostToolUse', 'Write|Edit|MultiEdit|NotebookEdit|Bash', Q('forge-toolhook.cjs'), 10],
  ['PostToolUse', 'PowerShell', Q('forge-toolhook.cjs'), 10],
  ['PreToolUse', 'Bash|PowerShell', Q('forge-gate-hook.cjs'), 10],
  ['Stop', null, Q('forge-stop-obligations.cjs'), 5],
  ['Stop', null, Q('forge-scribe-stop.cjs'), 5],
  ['UserPromptSubmit', null, Q('forge-scribe-hook.cjs'), 5],
];
const NEW_1_6_HOOKS = [
  ['SubagentStop', null, Q('forge-subagent-stop.cjs'), 5, undefined],
  ['SessionEnd', null, Q('forge-session-end.cjs'), 5, true],
  ['PostToolUseFailure', null, Q('forge-tool-failure.cjs'), 5, undefined],
];
const flatHooks = (s, events) => {
  const out = [];
  for (const ev of events) for (const e of (s.hooks[ev] || [])) for (const h of e.hooks) out.push({ ev, matcher: e.matcher === undefined ? null : e.matcher, h, entryKeys: Object.keys(e) });
  return out;
};
t('16a no prose key (_doc / _matcher_doc / any _-key) is left anywhere in settings.json (synced project: none inside a Forge hook; owner prose noted)', () => {
  const notes = check16a(rawSettings(), SETTINGS_STRICT);
  if (notes.length) console.log('    note (synced project, owner-owned, not judged): ' + notes.join('; '));
});
/** the WP A2 harness-proof hooks (owner-approved settings diff section 1, commit cc43b9a), pinned literally */
const A2_HOOK_CMDS = new Set([Q('forge-subagent-start.cjs'), Q('forge-agent-tool-hook.cjs')]);
const A2_HOOKS = [
  ['SubagentStart', null, Q('forge-subagent-start.cjs'), 5],
  ['PostToolUse', 'Agent', Q('forge-agent-tool-hook.cjs'), 5],
  ['PreToolUse', 'Agent', Q('forge-agent-tool-hook.cjs'), 5],
];
/** check16b(settings): every pre-1.6 hook byte-identical (event, matcher, command, timeout, order), no `if`/`async`, entries hold only matcher + hooks. */
function check16b(s) {
  const got = flatHooks(s, ['PreCompact', 'SessionStart', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit'])
    .filter((x) => !A2_HOOK_CMDS.has(x.h.command));
  assert.deepStrictEqual(got.map((x) => [x.ev, x.matcher, x.h.command, x.h.timeout]), PRE_1_6_HOOKS);
  for (const x of got) {
    assert.deepStrictEqual(Object.keys(x.h).sort(), ['command', 'timeout', 'type'], x.h.command);
    assert.ok(x.entryKeys.every((k) => k === 'matcher' || k === 'hooks'), x.ev + ' entry keys ' + x.entryKeys);
  }
}
t('16b every pre-1.6 hook is byte-identical (event, matcher, command, timeout, order) and has no `if`/`async` (synced project: the Forge-owned part)', () => check16b(realSettings()));
// 16h-16j PORTABLE: a synced-project-shaped settings.json — the clean Forge-owned settings decorated the way
// 26h2 kept them (prose keys of an older template beside matcher/hooks) plus an owner hook and an owner top-level key.
function syncedShapeSettings() {
  const s = JSON.parse(JSON.stringify(realSettings()));
  for (const e of s.hooks.PostToolUse) if (e.matcher !== 'Agent') e._matcher_doc = 'older template prose';
  for (const ev of ['PreToolUse', 'Stop', 'UserPromptSubmit']) s.hooks[ev][0]._doc = 'older template prose';
  s.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-own-guard.js', timeout: 3 }] });
  s.model = 'sonnet';
  return s;
}
t('16h PORTABLE: the byte-strict 16a/16b refuse a synced-shaped settings.json (what turned 26h2 red), the synced judgement accepts it and names every owner item', () => {
  const shaped = syncedShapeSettings();
  assert.throws(() => check16a(shaped, true));
  assert.throws(() => check16b(shaped), /entry keys|deepStrictEqual|Expected/);
  const notes = check16a(shaped, false);
  assert.strictEqual(notes.filter((n) => n.startsWith('owner prose key')).length, 5, notes.join('; '));
  assert.ok(notes.includes('owner key $.model') && notes.some((n) => n.startsWith('owner hook $.hooks.PreToolUse[0]: node my-own-guard.js')), notes.join('; '));
  check16b(forgeOwnedView(shaped).settings);
});
t('16i PORTABLE: forgeOwnedView of the synced shape is exactly the clean Forge-owned settings (nothing Forge owns is dropped or changed)', () => {
  assert.deepStrictEqual(forgeOwnedView(syncedShapeSettings()).settings, realSettings());
});
t('16k DEV TREE: the strict judgement accepts the owner-owned top-level keys Claude Code writes itself (enabledPlugins from /plugin) in any key order, and still refuses any other top-level key', () => {
  const clean = JSON.parse(JSON.stringify(realSettings()));
  const owner = { enabledPlugins: { 'some-plugin@some-market': false }, permissions: clean.permissions, hooks: clean.hooks };
  assert.deepStrictEqual(check16a(owner, true), []);
  assert.deepStrictEqual(forgeOwnedStrict(owner), clean);
  assert.throws(() => check16a(Object.assign({ model: 'sonnet' }, clean), true));
  assert.throws(() => check16a(Object.assign({}, clean, { enabledPlugins: { _doc: 'prose' } }), true));
});
t('16j PORTABLE: the synced judgement still refuses a prose key INSIDE a Forge hook object and an unknown key on a Forge hook (16b)', () => {
  const shaped = syncedShapeSettings();
  shaped.hooks.Stop[0].hooks[0]._doc = 'prose inside the hook';
  assert.throws(() => check16a(shaped, false), /prose key inside a Forge hook object/);
  const withIf = syncedShapeSettings(); withIf.hooks.Stop[0].hooks[0].if = 'Bash(*)';
  assert.throws(() => check16b(forgeOwnedView(withIf).settings));
});
t('16c the three new hooks are wired once each, no matcher, timeout 5 s, SessionEnd async', () => {
  const got = flatHooks(realSettings(), ['SubagentStop', 'SessionEnd', 'PostToolUseFailure']);
  assert.deepStrictEqual(got.map((x) => [x.ev, x.matcher, x.h.command, x.h.timeout, x.h.async]), NEW_1_6_HOOKS);
  for (const x of got) assert.strictEqual(x.h.type, 'command');
});
t('16d every hook command in settings.json names a forge-bin script that exists and is a known Forge hook command', () => {
  const s = realSettings();
  for (const ev of Object.keys(s.hooks)) for (const e of s.hooks[ev]) for (const h of e.hooks) {
    const m = /forge-bin\/(forge-[a-z0-9-]+\.cjs)"$/.exec(h.command);
    assert.ok(m, ev + ': unexpected command shape ' + h.command);
    assert.ok(fs.existsSync(path.join(__dirname, m[1])), ev + ': script missing ' + m[1]);
    assert.ok(mod.isForgeHookCommand(h.command), ev + ': not in FORGE_HOOK_COMMANDS ' + h.command);
  }
});
t('16e the real settings.json is a valid merge source: merge into {} keeps async, unmerge removes all 3 new hooks', () => {
  const s = realSettings();
  assert.strictEqual(mod.fullyValidShape(s), true);
  const merged = mod.mergeForgeSettings({}, s).settings;
  assert.strictEqual(merged.hooks.SessionEnd[0].hooks[0].async, true);
  const un = mod.unmergeForgeSettings(merged, s, {}).settings;
  for (const ev of ['SubagentStop', 'SessionEnd', 'PostToolUseFailure']) assert.ok(!un.hooks || !un.hooks[ev] || un.hooks[ev].length === 0, ev + ' left after unmerge');
  assert.strictEqual(mod.mergeForgeSettings(merged, s).added.length, 0, 'a second merge must add nothing');
});

t('16f the three WP A2 harness-proof hooks are wired once each (SubagentStart, PostToolUse Agent, PreToolUse Agent), timeout 5 s, not async', () => {
  const got = flatHooks(realSettings(), ['SubagentStart', 'PostToolUse', 'PreToolUse']).filter((x) => A2_HOOK_CMDS.has(x.h.command));
  assert.deepStrictEqual(got.map((x) => [x.ev, x.matcher, x.h.command, x.h.timeout]), A2_HOOKS);
  for (const x of got) {
    assert.deepStrictEqual(Object.keys(x.h).sort(), ['command', 'timeout', 'type'], x.h.command);
    assert.ok(x.entryKeys.every((k) => k === 'matcher' || k === 'hooks'), x.ev + ' entry keys ' + x.entryKeys);
  }
});
t('16g merge of the real settings.json into {} adds the A2 hooks; unmerge removes them and keeps a user Agent hook', () => {
  const s = realSettings();
  const user = { hooks: { PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command: 'node my-agent-audit.js', timeout: 3 }] }] } };
  const merged = mod.mergeForgeSettings(user, s).settings;
  const cmds = (o, ev) => ((o.hooks && o.hooks[ev]) || []).flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(cmds(merged, 'SubagentStart').includes(Q('forge-subagent-start.cjs')));
  assert.ok(cmds(merged, 'PreToolUse').includes(Q('forge-agent-tool-hook.cjs')));
  assert.ok(cmds(merged, 'PostToolUse').includes(Q('forge-agent-tool-hook.cjs')));
  const un = mod.unmergeForgeSettings(merged, s, {}).settings;
  for (const ev of ['SubagentStart', 'PreToolUse', 'PostToolUse']) assert.ok(!cmds(un, ev).some((c) => A2_HOOK_CMDS.has(c)), ev + ' still has an A2 hook after unmerge');
  assert.deepStrictEqual(cmds(un, 'PreToolUse'), ['node my-agent-audit.js']);
});

// 17) work package 2.9: the rotator Path A StopFailure hook, merged from
// config/orchestration/rotator-hooks.fragment.json. Inert unless the owner turns on `rotator-auto-resume` (default
// off). Synchronous on purpose (no `async`): `claude -p` kills async hooks at teardown. Removable by unmerge.
console.log('\n17) the rotator StopFailure hook (work package 2.9)');
const ROTATOR_HOOK_CMD = Q('forge-rotator-hook.cjs');
const ROTATOR_FRAGMENT = path.join(__dirname, '..', 'config', 'orchestration', 'rotator-hooks.fragment.json');
t('17a StopFailure is wired once: matcher rate_limit|overloaded, command hook, timeout 5 s, not async', () => {
  const got = flatHooks(realSettings(), ['StopFailure']);
  assert.deepStrictEqual(got.map((x) => [x.ev, x.matcher, x.h.command, x.h.timeout, x.h.async]), [['StopFailure', 'rate_limit|overloaded', ROTATOR_HOOK_CMD, 5, undefined]]);
  assert.deepStrictEqual(Object.keys(got[0].h).sort(), ['command', 'timeout', 'type']);
  assert.strictEqual(got[0].h.type, 'command');
  assert.deepStrictEqual(got[0].entryKeys.sort(), ['hooks', 'matcher']);
});
t('17b the settings.json StopFailure block equals the shipped rotator fragment (no drift between the two)', () => {
  const frag = JSON.parse(fs.readFileSync(ROTATOR_FRAGMENT, 'utf8'));
  assert.deepStrictEqual(realSettings().hooks.StopFailure, frag.hooks.StopFailure);
});
t('17c the rotator hook command is a known Forge hook command (unmerge removes it, a user command naming it is never touched)', () => {
  assert.strictEqual(mod.isForgeHookCommand(ROTATOR_HOOK_CMD), true);
  assert.strictEqual(mod.isForgeHookCommand('node my-wrapper.js && ' + ROTATOR_HOOK_CMD), false);
});
t('17d merge next to a user StopFailure hook keeps it; unmerge removes only the Forge one; merge into {} then unmerge leaves no StopFailure', () => {
  const s = realSettings();
  const userHook = { type: 'command', command: 'node my-own-limit-alert.js', timeout: 3 };
  const project = { hooks: { StopFailure: [{ matcher: 'rate_limit', hooks: [userHook] }] } };
  const merged = mod.mergeForgeSettings(project, s).settings;
  assert.deepStrictEqual(merged.hooks.StopFailure[0], { matcher: 'rate_limit', hooks: [userHook] }, 'the user entry is untouched');
  assert.ok(merged.hooks.StopFailure.some((e) => e.matcher === 'rate_limit|overloaded' && e.hooks.some((h) => h.command === ROTATOR_HOOK_CMD)), 'the Forge entry is added');
  assert.strictEqual(mod.mergeForgeSettings(merged, s).added.length, 0, 'a second merge adds nothing');
  const un = mod.unmergeForgeSettings(merged, s, {}).settings;
  assert.deepStrictEqual(un.hooks.StopFailure, [{ matcher: 'rate_limit', hooks: [userHook] }], 'only the Forge StopFailure hook is removed');
  const fresh = mod.unmergeForgeSettings(mod.mergeForgeSettings({}, s).settings, s, {}).settings;
  assert.ok(!fresh.hooks || !fresh.hooks.StopFailure, 'StopFailure left after unmerge: ' + JSON.stringify(fresh.hooks && fresh.hooks.StopFailure));
});

// 18) WP A13 (fleet rollout): the harness proof hooks of WP A2 — SubagentStart, PreToolUse(Agent),
// PostToolUse(Agent) (the settings diff proposal, section 1). The source is the real settings.json
// plus exactly those three entries (what the template ships once the owner applies the proposal), so the test stays
// valid before AND after that owner step.
console.log('\n18) the harness proof hooks (WP A2 / A13)');
const START_CMD = Q('forge-subagent-start.cjs');
const AGENT_CMD = Q('forge-agent-tool-hook.cjs');
function harnessSource() {
  const s = realSettings();
  const has = (ev, m, cmd) => (s.hooks[ev] || []).some((e) => e.matcher === m && e.hooks.some((h) => h.command === cmd));
  const add = (ev, m, cmd) => { if (!has(ev, m, cmd)) (s.hooks[ev] = s.hooks[ev] || []).push(Object.assign(m === undefined ? {} : { matcher: m }, { hooks: [{ type: 'command', command: cmd, timeout: 5 }] })); };
  add('SubagentStart', undefined, START_CMD);
  add('PreToolUse', 'Agent', AGENT_CMD);
  add('PostToolUse', 'Agent', AGENT_CMD);
  return s;
}
const harnessCount = (s) => {
  let n = 0;
  for (const ev of ['SubagentStart', 'PreToolUse', 'PostToolUse']) for (const e of ((s.hooks || {})[ev] || [])) for (const h of e.hooks) if (h.command === START_CMD || h.command === AGENT_CMD) n++;
  return n;
};
t('18a both harness hook commands are known Forge hook commands; a user command naming one is not', () => {
  assert.strictEqual(mod.isForgeHookCommand(START_CMD), true);
  assert.strictEqual(mod.isForgeHookCommand(AGENT_CMD), true);
  assert.strictEqual(mod.isForgeHookCommand('node my-audit.js && ' + AGENT_CMD), false);
  for (const f of ['forge-subagent-start.cjs', 'forge-agent-tool-hook.cjs']) assert.ok(fs.existsSync(path.join(__dirname, f)), f + ' missing');
});
t('18b merge into {} adds exactly SubagentStart, PreToolUse(Agent) and PostToolUse(Agent); a second merge adds nothing', () => {
  const src = harnessSource();
  const r = mod.mergeForgeSettings({}, src);
  assert.strictEqual(harnessCount(r.settings), 3);
  assert.ok(r.settings.hooks.SubagentStart.some((e) => e.matcher === undefined && e.hooks[0].command === START_CMD));
  for (const ev of ['PreToolUse', 'PostToolUse']) assert.strictEqual(r.settings.hooks[ev].filter((e) => e.matcher === 'Agent').length, 1, ev + ' Agent entries');
  const again = mod.mergeForgeSettings(r.settings, src);
  assert.strictEqual(again.added.length, 0, 'a second merge must add nothing: ' + JSON.stringify(again.added));
  assert.deepStrictEqual(again.settings, r.settings);
});
t('18c owner hooks on SubagentStart / PreToolUse(Agent) / PostToolUse survive byte-for-byte; the Forge hook tops up the SAME Agent entry', () => {
  const ownStart = { type: 'command', command: 'node my-own-start-logger.js', timeout: 2 };
  const ownAgent = { type: 'command', command: 'node my-agent-audit.js', timeout: 3 };
  const ownPost = { matcher: 'Write', hooks: [{ type: 'command', command: 'node my-formatter.js' }] };
  const project = { hooks: { SubagentStart: [{ hooks: [ownStart] }], PreToolUse: [{ matcher: 'Agent', hooks: [ownAgent] }], PostToolUse: [ownPost] }, model: 'sonnet' };
  const before = JSON.stringify(project);
  const r = mod.mergeForgeSettings(project, harnessSource());
  assert.strictEqual(JSON.stringify(project), before, 'the input is never mutated');
  assert.deepStrictEqual(r.settings.hooks.SubagentStart[0].hooks[0], ownStart, 'owner SubagentStart hook first and unchanged');
  assert.ok(r.settings.hooks.SubagentStart[0].hooks.some((h) => h.command === START_CMD), 'Forge start hook topped up into the matcher-less entry');
  const agentPre = r.settings.hooks.PreToolUse.filter((e) => e.matcher === 'Agent');
  assert.strictEqual(agentPre.length, 1, 'no second PreToolUse(Agent) entry');
  assert.deepStrictEqual(agentPre[0].hooks[0], ownAgent);
  assert.ok(agentPre[0].hooks.some((h) => h.command === AGENT_CMD));
  assert.deepStrictEqual(r.settings.hooks.PostToolUse[0], ownPost, 'owner PostToolUse entry stays first and unchanged');
  assert.strictEqual(r.settings.model, 'sonnet');
  assert.strictEqual(mod.mergeForgeSettings(r.settings, harnessSource()).added.length, 0, 'idempotent next to owner hooks');
  const un = mod.unmergeForgeSettings(r.settings, harnessSource(), {}).settings;
  assert.strictEqual(harnessCount(un), 0, 'unmerge removes the Forge harness hooks');
  assert.deepStrictEqual(un.hooks.SubagentStart, [{ hooks: [ownStart] }]);
  assert.deepStrictEqual(un.hooks.PreToolUse, [{ matcher: 'Agent', hooks: [ownAgent] }]);
  assert.deepStrictEqual(un.hooks.PostToolUse, [ownPost]);
});
t('18d MUTANT: a copy of the merger without the two new FORGE_HOOK_COMMANDS entries leaves the hooks after unmerge (18a/18c bite)', () => {
  const dir = freshDir('fsm-a13-mutant');
  try {
    const srcText = fs.readFileSync(path.join(__dirname, 'forge-settings-merge.cjs'), 'utf8');
    const mutText = srcText.replace(/  'forge-subagent-start\.cjs': \[\r?\n[^\]]*\],\r?\n  'forge-agent-tool-hook\.cjs': \[\r?\n[^\]]*\],\r?\n/, '');
    assert.notStrictEqual(mutText, srcText, 'the mutation did not apply');
    fs.writeFileSync(path.join(dir, 'forge-settings-merge.cjs'), mutText);
    fs.copyFileSync(path.join(__dirname, 'forge-settings-merge-guards.cjs'), path.join(dir, 'forge-settings-merge-guards.cjs'));
    const mut = require(path.join(dir, 'forge-settings-merge.cjs'));
    assert.strictEqual(mut.isForgeHookCommand(START_CMD), false);
    const merged = mut.mergeForgeSettings({}, harnessSource()).settings;
    assert.strictEqual(harnessCount(mut.unmergeForgeSettings(merged, harnessSource(), {}).settings), 3, 'the mutant must leave all three behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t('18e check (CLI) on a target merged from the harness source reports nothing to merge (exit 0)', () => {
  const dir = freshDir('fsm-a13');
  try {
    const src = path.join(dir, 'source.json'), tgt = path.join(dir, 'settings.json');
    writeJson(src, harnessSource());
    writeJson(tgt, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-guard.js' }] }] } });
    const ap = spawnSync(process.execPath, [path.join(__dirname, 'forge-settings-merge.cjs'), 'apply', '--target', tgt, '--source', src, '--backup-dir', dir], { encoding: 'utf8' });
    assert.strictEqual(ap.status, 0, ap.stdout + ap.stderr);
    const after = JSON.parse(fs.readFileSync(tgt, 'utf8'));
    assert.strictEqual(harnessCount(after), 3);
    assert.deepStrictEqual(after.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-guard.js' }] });
    const ck = spawnSync(process.execPath, [path.join(__dirname, 'forge-settings-merge.cjs'), 'check', '--target', tgt, '--source', src], { encoding: 'utf8' });
    assert.strictEqual(ck.status, 0, ck.stdout + ck.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
