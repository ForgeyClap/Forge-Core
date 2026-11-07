#!/usr/bin/env node
'use strict';
/**
 * forge-sync-status-direction.test.cjs — WP A0.
 *
 * Regression: `forge-sync status` on the Forge DEVELOPMENT TREE (the source the template is published FROM) compared
 * the tree as if it were an installed project: it reported "DRIFT (N files behind) — run: forge-sync install", while
 * install itself refuses a development tree and the drift was almost entirely the template lagging behind the tree.
 * The fixed status names the real direction: files the template merely lags on (its bytes are an older version in the
 * tree's git history) versus files the template is AHEAD on (bytes that never existed in the tree — edited in the
 * template itself, which a publish would overwrite).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test: ntTest, after } = require('node:test');
const assert = require('node:assert');

const CLI = path.join(__dirname, 'forge-sync.cjs');
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sync-dir-'));
process.on('exit', () => { try { fs.rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* tolerated */ } });
// The trailing "N passed, M failed" line is the tally forge-doctor's suite runner reads (doctor/checks-core.cjs TALLY_RE);
// node:test's own "ℹ pass N" summary is not parsed there, so without this line the doctor reports the suite as having no tally.
let passed = 0; let failed = 0;
function test(name, fn) { ntTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });

const RULES = [
  { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture' },
  { pattern: '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture' },
  { pattern: '.claude/config/forge-dev-tree.json', class: 'local-only', channels: [], reason: 'fixture' },
];
function w(base, rel, body) { const f = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
function manifest(claudeDir) { w(claudeDir, 'config/orchestration/FORGE_SHIP_MANIFEST.json', JSON.stringify({ schema: 'forge-ship-manifest/v1', rules: RULES, known_gaps: [] }, null, 2) + '\n'); }
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false'].concat(args), { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout;
}
/** fixture(name, opts) — a git development tree (marker + manifest) whose history has lag.cjs v1 then v2, and a template
 *  published at v1. opts.templateEdit adds a template-only edit (edited.cjs bytes never in the tree's history) and a
 *  template-only file (extra.cjs); opts.marker=false makes it a plain installed project instead. */
function fixture(name, opts) {
  const root = path.join(RUN_DIR, name);
  const dev = path.join(root, 'dev', '.claude');
  const tpl = path.join(root, 'tpl', '.claude');
  manifest(dev); manifest(tpl);
  if (opts.marker !== false) w(dev, 'config/forge-dev-tree.json', JSON.stringify({ dev_tree: true }) + '\n');
  w(dev, 'forge-bin/lag.cjs', 'LAG-V1\n'); w(dev, 'forge-bin/edited.cjs', 'EDITED-V1\n'); w(dev, 'forge-bin/same.cjs', 'SAME\n');
  git(path.join(root, 'dev'), ['init', '-q']); git(path.join(root, 'dev'), ['add', '-A']); git(path.join(root, 'dev'), ['commit', '-q', '-m', 'v1']);
  w(dev, 'forge-bin/lag.cjs', 'LAG-V2\n'); w(dev, 'forge-bin/new.cjs', 'NEW\n');
  git(path.join(root, 'dev'), ['add', '-A']); git(path.join(root, 'dev'), ['commit', '-q', '-m', 'v2']);
  w(tpl, 'forge-bin/lag.cjs', 'LAG-V1\n'); w(tpl, 'forge-bin/same.cjs', 'SAME\n');
  w(tpl, 'forge-bin/edited.cjs', opts.templateEdit ? 'EDITED-IN-TEMPLATE\n' : 'EDITED-V1\n');
  if (opts.templateEdit) w(tpl, 'forge-bin/extra.cjs', 'ONLY-IN-TEMPLATE\n');
  return { devRoot: path.join(root, 'dev'), tpl };
}
function status(fx, verbose) {
  const args = [CLI, 'status', fx.devRoot].concat(verbose ? ['--verbose'] : []);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: fx.tpl }) });
  return { code: r.status, out: String(r.stdout) + String(r.stderr) };
}

test('dev tree whose template only lags: no "run: forge-sync install", points at publish-template, exit 0', () => {
  const r = status(fixture('lag-only', {}), true);
  assert.doesNotMatch(r.out, /run: forge-sync install/, r.out);
  assert.match(r.out, /DEVELOPMENT TREE/, r.out);
  assert.match(r.out, /publish-template --plan/, r.out);
  assert.match(r.out, /template is 2 file\(s\) behind this tree \(1 changed, 1 not published yet\)/, r.out);
  assert.doesNotMatch(r.out, /TEMPLATE AHEAD/, r.out);
  assert.strictEqual(r.code, 0, r.out);
});

test('dev tree with template-only edits: names them as TEMPLATE AHEAD and exits 1', () => {
  const r = status(fixture('tpl-ahead', { templateEdit: true }), true);
  assert.doesNotMatch(r.out, /run: forge-sync install/, r.out);
  assert.match(r.out, /TEMPLATE AHEAD: 2 file\(s\)/, r.out);
  assert.match(r.out, /forge-bin\/edited\.cjs/, r.out);
  assert.match(r.out, /forge-bin\/extra\.cjs/, r.out);
  assert.match(r.out, /behind this tree \(1 changed, 1 not published yet\)/, r.out);
  assert.strictEqual(r.code, 1, r.out);
});

test('an installed project (no dev-tree marker) keeps the old "files behind — run: forge-sync install" report', () => {
  const r = status(fixture('installed', { marker: false }), false);
  assert.match(r.out, /DRIFT \(1 files behind\) — run: forge-sync install/, r.out);
  assert.doesNotMatch(r.out, /DEVELOPMENT TREE/, r.out);
  assert.strictEqual(r.code, 1, r.out);
});
