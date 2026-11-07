#!/usr/bin/env node
'use strict';
// forge-settings-merge-ownerkeys.test.cjs — SA-P1B-DOCTOR rework. The development tree's settings.json is
// the template SOURCE, and Claude Code itself writes the owner's plugin state into it (/plugin -> enabledPlugins,
// extraKnownMarketplaces). The strict dev-tree check accepts those keys, so the create path (a project without a
// settings.json) and the recommended-copy path must never copy them into another project: a later `true` there
// would switch a plugin on, or add a marketplace, in someone else's project. Fixtures live in os.tmpdir() only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const mod = require('./forge-settings-merge.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
const roots = [];
function freshDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-ownerkeys-')); roots.push(d); return d; }

const HOOKS = { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 }] }] };
const PERMS = { deny: ['Read(./.env)'] };
function source(dir, extra) {
  const p = path.join(dir, 'template-settings.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ permissions: PERMS, hooks: HOOKS }, extra), null, 2) + '\n', 'utf8');
  return p;
}
const OWNER = { enabledPlugins: { 'some-plugin@market': true }, extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'x/y' } } } };

t('OK-1 the module exports the owner-only key list (one source for the merger and the strict dev-tree check)', () => {
  assert.ok(Array.isArray(mod.OWNER_UI_TOP_LEVEL_KEYS), 'OWNER_UI_TOP_LEVEL_KEYS is not exported');
  assert.deepStrictEqual(mod.OWNER_UI_TOP_LEVEL_KEYS.slice().sort(), ['enabledPlugins', 'extraKnownMarketplaces']);
  assert.ok(Object.isFrozen(mod.OWNER_UI_TOP_LEVEL_KEYS));
});

t('OK-2 create path: a template with owner plugin keys creates a settings.json WITHOUT them; Forge keys and other keys stay', () => {
  const dir = freshDir();
  const target = path.join(dir, 'proj', '.claude', 'settings.json');
  const r = mod.applySettingsMerge({ target, source: source(dir, Object.assign({ statusLine: { type: 'command', command: 'x' } }, OWNER)) });
  assert.strictEqual(r.status, 'created');
  const raw = fs.readFileSync(target, 'utf8');
  const got = JSON.parse(raw);
  assert.deepStrictEqual(Object.keys(got), ['permissions', 'hooks', 'statusLine']);
  assert.deepStrictEqual(got.hooks, HOOKS);
  assert.deepStrictEqual(got.permissions, PERMS);
  assert.strictEqual(r.writtenSha256, crypto.createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'), 'writtenSha256 must hash the bytes on disk');
});

t('OK-3 create path: a template WITHOUT owner keys is still copied byte for byte (no reformatting)', () => {
  const dir = freshDir();
  const src = path.join(dir, 'template-settings.json');
  const bytes = '{\n    "hooks": ' + JSON.stringify(HOOKS) + ',\n    "permissions": {"deny": ["Read(./.env)"]}\n}\n';
  fs.writeFileSync(src, bytes, 'utf8');
  const target = path.join(dir, 'proj', 'settings.json');
  assert.strictEqual(mod.applySettingsMerge({ target, source: src }).status, 'created');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), bytes);
});

t('OK-4 refused merge: the settings.forge-recommended copy carries no owner plugin keys either', () => {
  const dir = freshDir();
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{ not json', 'utf8');
  const r = mod.applySettingsMerge({ target, source: source(dir, OWNER) });
  assert.strictEqual(r.status, 'refused');
  assert.ok(r.recommended, 'a recommended copy was written');
  const rec = JSON.parse(fs.readFileSync(r.recommended, 'utf8'));
  assert.deepStrictEqual(Object.keys(rec).sort(), ['hooks', 'permissions']);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{ not json', 'the unreadable target stays untouched');
});

t('OK-5 merge into an existing settings.json keeps the PROJECT\'s own enabledPlugins and adds none from the template', () => {
  const dir = freshDir();
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, JSON.stringify({ enabledPlugins: { 'mine@m': false } }, null, 2) + '\n', 'utf8');
  const r = mod.applySettingsMerge({ target, source: source(dir, OWNER) });
  assert.strictEqual(r.status, 'merged');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')).enabledPlugins, { 'mine@m': false });
});

t('OK-6 the REAL development-tree settings.json, used as a template, never puts the owner\'s plugin state in a new project', () => {
  const real = path.join(__dirname, '..', 'settings.json');
  if (!fs.existsSync(real)) { console.log('  (no project settings.json here — checked on fixtures only)'); return; }
  const dir = freshDir();
  const target = path.join(dir, 'proj', 'settings.json');
  assert.strictEqual(mod.applySettingsMerge({ target, source: real }).status, 'created');
  const got = JSON.parse(fs.readFileSync(target, 'utf8'));
  for (const k of ['enabledPlugins', 'extraKnownMarketplaces']) assert.ok(!(k in got), k + ' leaked into the new project');
  assert.deepStrictEqual(got.hooks, JSON.parse(fs.readFileSync(real, 'utf8')).hooks);
});

for (const d of roots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort temp cleanup */ } }
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
