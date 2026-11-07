'use strict';
// forge-paths-migration-C.test.cjs — WP 2.1.C layout matrix for the infrastructure tools (group C).
// Every case runs in temp projects WITH and WITHOUT .forge/ (opt-in per project): without it every path must be the
// legacy .claude/forge-* one; with it state lands in .forge/<key> and the legacy folder stays untouched. Covers
// forge-sync (install/status/rollback never touch .forge/, report it protected), release-check, shipcheck,
// fresh-repo, the gate hook in a plugin-like layout, the plugin build output, and the doctor/config/hook tools.
// HERMETIC: temp folders only, explicit roots everywhere, CLAUDE_PROJECT_DIR / FORGE_STATE_DIR stripped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

delete process.env.FORGE_STATE_DIR; // this process judges layouts by the .forge folder alone
let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message)); } }
const BIN = __dirname;
const ROOT = path.resolve(__dirname, '..', '..');
const CANON = path.join(BIN, '..', 'config', 'orchestration', 'forge-canon.json');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mig-c-')));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME);
const cleanEnv = (extra) => { const e = Object.assign({}, process.env); for (const k of ['CLAUDE_PROJECT_DIR', 'FORGE_STATE_DIR', 'FORGE_PROJECT_ROOT', 'FORGE_SWEEP_ROOT']) delete e[k]; return Object.assign(e, { FORGE_CONFIG_HOME: HOME }, extra || {}); };
const w = (root, rel, text) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const has = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
function snapshot(dir) {
  const out = [];
  (function walk(d, rel) {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const r = rel ? rel + '/' + e.name : e.name; const p = path.join(d, e.name); if (e.isDirectory()) { out.push(r + '/'); walk(p, r); } else out.push(r + ' ' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')); }
  })(dir, '');
  return out.sort().join('\n');
}
let n = 0;
function project(forge) {
  const p = path.join(TMP, 'p' + (++n) + (forge ? '-forge' : '-legacy'));
  w(p, '.claude/config/orchestration/forge-canon.json', fs.readFileSync(CANON, 'utf8'));
  if (forge) fs.mkdirSync(path.join(p, '.forge'));
  return p;
}
function seedForge(p) {
  w(p, '.forge/runs/r1/events.jsonl', '{"event_type":"run_started"}\n');
  w(p, '.forge/memory/FORGE_MEMORY.md', '# memory\n');
  w(p, '.forge/scribe/inbox.jsonl', '{"prompt":"verbatim owner words"}\n');
  w(p, '.forge/backups/b0/x.cjs', 'old');
  w(p, '.forge/research/notes.md', 'notes');
}
/** The development-tree probe every portable suite uses: .claude/config/forge-dev-tree.json with dev_tree: true. */
const isDevTreeRoot = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'), 'utf8')).dev_tree === true; } catch { return false; } };
const DEV_TREE = isDevTreeRoot(ROOT);
/** maintainerTool(binDir, devTree, classify, file) -> {mod} | {absent} (2026-11-02, portability: this suite crashed with
 *  "Cannot find module './forge-fresh-repo.cjs'" in a synced project). forge-fresh-repo and forge-plugin-build are
 *  maintainer tools the ship manifest marks local-only, so a synced project never has them. In the development tree a
 *  missing one throws; elsewhere a missing tool is accepted only when the shipped manifest classifies it local-only
 *  (classify = rel -> manifest rule); anything else missing is a broken install and throws. */
function maintainerTool(binDir, devTree, classify, file) {
  const p = path.join(binDir, file);
  if (fs.existsSync(p)) return { mod: require(p) };
  if (devTree) throw new Error(file + ' is missing from the development tree');
  const rule = classify('.claude/forge-bin/' + file);
  if (!rule || rule.class !== 'local-only') throw new Error(file + ' is missing, but the ship manifest classifies it ' + (rule ? rule.class : 'nowhere') + ': a broken install, not a by-design absence');
  return { absent: file + ' is a local-only maintainer tool in FORGE_SHIP_MANIFEST.json, so a synced project does not have it' };
}
const quiet = (fn) => { const l = console.log, e = console.error, out = []; console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push(a.join(' ')); try { return { r: fn(), out: out.join('\n') }; } finally { console.log = l; console.error = e; } };

try {
  // ======================== A) forge-sync: the floor, install, status, rollback =========================
  const sync = require('./forge-sync.cjs');
  t('A1 floor: .forge is a never-touch root dir; .claude/.forge and ../.forge are never-touch; a shipped tool is not', () => {
    assert.ok(sync.NEVER_TOUCH_ROOT_DIRS.has('.forge'));
    assert.ok(sync.NEVER_TOUCH_DIRS.has('.forge') && sync.isNeverTouchDir('.forge') && sync.isNeverTouch('.forge/runs/r1/events.jsonl'));
    assert.ok(sync.isNeverTouch('../.forge/scribe/inbox.jsonl'));
    assert.ok(!sync.isNeverTouch('forge-bin/tool.cjs'));
  });
  const shipcheck = require('./forge-shipcheck.cjs');
  const realManifest = shipcheck.loadManifest(path.join(BIN, '..', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'));
  t('A2 the real ship manifest classifies .forge/** per-project with no channel (never shipped) and loads clean', () => {
    assert.deepStrictEqual(realManifest.errors, []);
    for (const rel of ['.forge/runs/r1/events.jsonl', '.forge/scribe/inbox.jsonl', '.forge/memory/FORGE_MEMORY.md', '.forge/backups/b/x.cjs']) {
      const r = shipcheck.classify(realManifest.rules, rel);
      assert.ok(r && r.class === 'per-project' && r.channels.length === 0, rel + ' -> ' + JSON.stringify(r && r.class));
    }
    // the mirror of forge-sync.test 85a for the root state folder: every per-project .forge rule names the folder on the floor
    const forgeRules = realManifest.rules.filter((r) => r.pattern.startsWith('.forge/'));
    assert.ok(forgeRules.length >= 1 && forgeRules.every((r) => r.class === 'per-project' && sync.NEVER_TOUCH_ROOT_DIRS.has(r.pattern.split('/')[0])));
  });
  const tpl = path.join(TMP, 'tpl'); w(tpl, 'forge-bin/tool.cjs', 'TEMPLATE-TOOL');
  const doctorStub = (p) => w(p, '.claude/forge-bin/forge-doctor.cjs', '#!/usr/bin/env node\nif (process.argv.includes("--json")) console.log(' + JSON.stringify(JSON.stringify({ ok: true, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 } } })) + ');\nprocess.exit(0);\n');
  const pf = project(true); seedForge(pf); doctorStub(pf);
  const before = snapshot(path.join(pf, '.forge'));
  const inst = quiet(() => sync.safeSyncProject(tpl, pf, { batchId: 'bmigc1', nowIso: '2026-10-24T00:00:00.000Z' })).r;
  t('A3 install into a .forge project succeeds and delivers the tool', () => {
    assert.strictEqual(inst.ok, true, JSON.stringify(inst.error || inst.reason || inst.protect || '').slice(0, 300));
    assert.strictEqual(fs.readFileSync(path.join(pf, '.claude', 'forge-bin', 'tool.cjs'), 'utf8'), 'TEMPLATE-TOOL');
  });
  t('A3 install never touched .forge/ (every file byte-identical, nothing added or removed)', () => assert.strictEqual(snapshot(path.join(pf, '.forge')), before));
  t('A3 the protect manifest inventories .forge/ (stateRoot, entries, backups not walked) and a change there is a VIOLATION', () => {
    const m1 = sync.buildProtectManifest(tpl, pf, { git: false });
    assert.strictEqual(m1.stateRoot, '.forge');
    assert.ok(m1.notWalked.includes('.forge/backups/'));
    for (const k of ['.forge/runs/r1/events.jsonl', '.forge/memory/FORGE_MEMORY.md', '.forge/scribe/inbox.jsonl', '.forge/research/notes.md']) assert.ok(m1.entries[k] && m1.entries[k].kind === 'file', k);
    assert.ok(!Object.keys(m1.entries).some((k) => k.startsWith('.forge/backups')), 'backups are not walked');
    fs.appendFileSync(path.join(pf, '.forge', 'memory', 'FORGE_MEMORY.md'), 'tampered\n');
    const d = sync.diffProtectManifests(m1, sync.buildProtectManifest(tpl, pf, { git: false }), {});
    assert.strictEqual(d.ok, false);
    assert.deepStrictEqual(d.changed.map((c) => c.key), ['.forge/memory/FORGE_MEMORY.md']);
    fs.writeFileSync(path.join(pf, '.forge', 'memory', 'FORGE_MEMORY.md'), '# memory\n');
  });
  t('A4 status names .forge/ as protected; a legacy project prints no .forge line', () => {
    const s = quiet(() => sync.status(tpl, pf, false));
    assert.ok(/\.forge\/ \(per-project state root[^\n]*protected/.test(s.out), s.out);
    const pl = project(false);
    assert.ok(!/\.forge/.test(quiet(() => sync.status(tpl, pl, false)).out));
  });
  t('A5 rollback restores .claude/ and leaves .forge/ byte-identical', () => {
    const rb = quiet(() => sync.rollbackProject(pf, 'bmigc1', {})).r;
    assert.strictEqual(rb.ok, true, JSON.stringify(rb).slice(0, 300));
    assert.ok(!has(pf, '.claude/forge-bin/tool.cjs'), 'the delivered tool is rolled back');
    assert.strictEqual(snapshot(path.join(pf, '.forge')), before);
  });
  t('A6 a legacy project: install creates no .forge/, the protect manifest has no stateRoot and no .forge keys', () => {
    const pl = project(false); doctorStub(pl);
    const r = quiet(() => sync.safeSyncProject(tpl, pl, { batchId: 'bmigc2', nowIso: '2026-10-24T00:00:00.000Z' })).r;
    assert.strictEqual(r.ok, true);
    assert.ok(!has(pl, '.forge'));
    const m = sync.buildProtectManifest(tpl, pl, { git: false });
    assert.ok(m.stateRoot === undefined && !Object.keys(m.entries).some((k) => k.startsWith('.forge')));
  });

  // ======================== B) release-check: a tracked .forge/ file is forbidden =========================
  const rc = require('./forge-release-check.cjs');
  const dist = path.join(TMP, 'dist');
  for (const rel of ['.forge/runs/r1/events.jsonl', 'plugins/forge/.forge/scribe/inbox.jsonl', '.claude/forge-bin/tool.cjs', '.claude/.forge-canary/x.json']) w(dist, rel, 'x');
  const git = (args) => spawnSync('git', ['-c', 'core.autocrlf=false'].concat(args), { cwd: dist, encoding: 'utf8' });
  const gitOk = git(['init', '-q']).status === 0 && git(['add', '-A']).status === 0;
  t('B1 release-check flags tracked .forge/ files (root and nested), not a shipped tool or a .forge-* marker', () => {
    if (!gitOk) { console.log('  SKIP B1: git is not available here (release-check lists TRACKED files)'); return; }
    const r = rc.checkDist(dist, rc.loadExclusions());
    const bad = r.violations.map((v) => v.path).sort();
    assert.deepStrictEqual(bad, ['.forge/runs/r1/events.jsonl', 'plugins/forge/.forge/scribe/inbox.jsonl']);
  });
  t('B2 COUNTERFACTUAL: without the (^|/)\\.forge/ entries the same tree passes (the new pattern is what catches it)', () => {
    const cfg = JSON.parse(fs.readFileSync(rc.defaultConfigPath(), 'utf8'));
    cfg.dist_forbidden = cfg.dist_forbidden.filter((p) => p !== '(^|/)\\.forge/');
    const f = w(TMP, 'excl-no-forge.json', JSON.stringify(cfg));
    assert.deepStrictEqual(rc.checkDist(dist, rc.loadExclusions(f)).violations, []);
  });
  t('B3 never_sync: .forge/ below .claude is never synced; the legacy ^\\.forge marker rule still holds', () => {
    const ex = rc.loadExclusions();
    assert.ok(rc.isNeverSync('.forge/runs/r1/events.jsonl', ex) && rc.isNeverSync('.forge-sync.lock', ex) && !rc.isNeverSync('forge-bin/tool.cjs', ex));
  });

  // ======================== C) shipcheck + fresh-repo exclude .forge/ =========================
  t('C1 shipcheck: .forge/** is a protected path; a hostile manifest shipping it fails as protected_path_shipped', () => {
    assert.ok(shipcheck.PROTECTED_PATHS.some((p) => p.glob === '.forge/**') && shipcheck.protectedSpecOf('.forge/scribe/inbox.jsonl'));
    const fx = path.join(TMP, 'sc');
    const m = w(fx, 'm.json', JSON.stringify({ schema: 'forge-ship-manifest/v1', rules: [
      { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture' },
      { pattern: '.forge/**', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'HOSTILE fixture' }], known_gaps: [] }));
    const rep = shipcheck.runShipcheck(fx, { manifestPath: m, files: ['.claude/forge-bin/a.cjs', '.forge/runs/r1/events.jsonl'] });
    assert.ok(rep.failures.some((f) => f.kind === 'protected_path_shipped' && f.path.startsWith('.forge/')), JSON.stringify(rep.failures).slice(0, 400));
  });
  // C0 the maintainer tools load portably: the development tree must have them, a synced project lacks them
  // by design (proven by the shipped manifest), and a missing SHIPPED tool is never excused.
  const byManifest = (rel) => shipcheck.classify(realManifest.rules, rel);
  t('C0 maintainerTool: a synced-project-shaped forge-bin (no dev marker) without the two local-only tools reports them absent by design', () => {
    const syncedBin = path.join(project(false), '.claude', 'forge-bin'); fs.mkdirSync(syncedBin, { recursive: true });
    assert.strictEqual(isDevTreeRoot(path.dirname(path.dirname(syncedBin))), false);
    for (const f of ['forge-fresh-repo.cjs', 'forge-plugin-build.cjs']) assert.ok(/local-only maintainer tool/.test(maintainerTool(syncedBin, false, byManifest, f).absent || ''), f);
    assert.throws(() => maintainerTool(syncedBin, false, byManifest, 'forge-sync.cjs'), /broken install/, 'a missing shipped tool is a failure');
  });
  t('C0 maintainerTool: in a development-tree-shaped root a missing maintainer tool fails, a present one loads', () => {
    const devRoot = project(false); w(devRoot, '.claude/config/forge-dev-tree.json', '{"dev_tree": true}\n');
    const devBin = path.join(devRoot, '.claude', 'forge-bin'); fs.mkdirSync(devBin, { recursive: true });
    assert.strictEqual(isDevTreeRoot(devRoot), true);
    assert.throws(() => maintainerTool(devBin, true, byManifest, 'forge-fresh-repo.cjs'), /missing from the development tree/);
    w(devRoot, '.claude/forge-bin/forge-fresh-repo.cjs', 'module.exports = { fixture: true };\n');
    assert.deepStrictEqual(maintainerTool(devBin, true, byManifest, 'forge-fresh-repo.cjs').mod, { fixture: true });
  });
  const frTool = maintainerTool(BIN, DEV_TREE, byManifest, 'forge-fresh-repo.cjs'), fr = frTool.mod;
  if (!fr) console.log('  SKIP C2-C3: ' + frTool.absent + ' (C0 proved the absence is by design)');
  if (fr) {
  t('C2 fresh-repo drops .forge/ content like the legacy process data, keeps ordinary source', () => {
    const drop = (rel) => (fr.DROP_RULES.find((r) => r.re.test(rel)) || {}).id || null;
    assert.strictEqual(drop('.forge/runs/r1/events.jsonl'), 'process-data');
    assert.strictEqual(drop('.forge/scribe/inbox.jsonl'), 'process-data');
    assert.strictEqual(drop('.claude/forge-runs/r1/events.jsonl'), 'process-data');
    assert.strictEqual(drop('src/app.js'), null);
  });
  t('C3 fresh-repo devRunIds reads both runs folders in a .forge project, only the legacy one otherwise', () => {
    const p = project(true); w(p, '.forge/runs/forge-2026-10-01-new/events.jsonl', 'x'); w(p, '.claude/forge-runs/forge-2026-09-01-old/events.jsonl', 'x');
    assert.deepStrictEqual(fr.devRunIds(p).sort(), ['forge-2026-09-01-old', 'forge-2026-10-01-new']);
    const l = project(false); w(l, '.claude/forge-runs/forge-2026-09-02-l/events.jsonl', 'x');
    assert.deepStrictEqual(fr.devRunIds(l), ['forge-2026-09-02-l']);
  });
  } // fr

  // ======================== D) gate hook: plugin-like layout + the .forge scratch areas =========================
  const GATE_FILES = ['forge-gate-hook.cjs', 'forge-actiongate.cjs', 'forge-actiongate-position.cjs', 'forge-gate-quotes.cjs', 'forge-gate-data.cjs', 'forge-gate-scratch.cjs', 'forge-gate-messages.cjs', 'forge-gate-selfdisable.cjs', 'forge-gate-inspect.cjs', 'forge-gate-watchdog.cjs', 'forge-gate-classify-worker.cjs'];
  function plugin(name, withPaths) {
    const pr = path.join(TMP, 'plug-' + name, 'cache', 'mkt', 'forge', '1.0.0');
    for (const f of GATE_FILES.concat(withPaths ? ['forge-paths.cjs'] : [])) w(pr, 'scripts/' + f, fs.readFileSync(path.join(BIN, f)));
    w(pr, 'config/orchestration/hard-gates.json', fs.readFileSync(path.join(BIN, '..', 'config', 'orchestration', 'hard-gates.json')));
    fs.mkdirSync(path.join(pr, '.claude-plugin'), { recursive: true });
    return pr;
  }
  const work = project(false); fs.mkdirSync(path.join(work, 'src'));
  const gate = (pr, command, cwd, env) => spawnSync(process.execPath, [path.join(pr, 'scripts', 'forge-gate-hook.cjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }), cwd, env, encoding: 'utf8', timeout: 20000 });
  const plug = plugin('new', true);
  t('D1 plugin layout: the hook takes the project from CLAUDE_PROJECT_DIR — a provable node_modules delete passes as in a synced install', () => {
    const r = gate(plug, 'rm -rf ./packages/app/node_modules', work, cleanEnv({ CLAUDE_PROJECT_DIR: work }));
    assert.strictEqual(r.status, 0, r.status + ' ' + r.stderr);
    assert.ok(r.stderr.startsWith('FORGE GATE: destructive delete allowed'), r.stderr);
    const c = gate(plug, 'rm -rf ./packages/app/node_modules', work, cleanEnv());
    assert.strictEqual(c.status, 0, 'cwd walk-up alone (no CLAUDE_PROJECT_DIR) finds the project too: ' + c.stderr);
  });
  t('D2 plugin layout: classification unchanged — a real source delete and git reset are still blocked', () => {
    assert.strictEqual(gate(plug, 'rm -rf src', work, cleanEnv({ CLAUDE_PROJECT_DIR: work })).status, 2);
    assert.strictEqual(gate(plug, 'git reset --hard', work, cleanEnv({ CLAUDE_PROJECT_DIR: work })).status, 2);
  });
  t('D3 COUNTERFACTUAL: the same plugin copy WITHOUT forge-paths.cjs (old own-folder root) blocks that delete', () => {
    const old = plugin('old', false);
    assert.strictEqual(gate(old, 'rm -rf ./packages/app/node_modules', work, cleanEnv({ CLAUDE_PROJECT_DIR: work })).status, 2);
  });
  t('D4 plugin layout, cwd inside the plugin: the plugin folder is never the project; no project -> fail closed; nothing written', () => {
    // Machine-aware on purpose: discovery walks up from the cwd, and a stray marker in an ancestor of the temp folder (this
    // machine has %LOCALAPPDATA%\.claude) makes that ancestor "the project". What must hold everywhere: never the plugin.
    const snap0 = snapshot(plug);
    const cwd = path.join(plug, 'scripts');
    const q = spawnSync(process.execPath, [path.join(plug, 'scripts', 'forge-paths.cjs'), 'root', '--json'], { cwd, env: cleanEnv(), encoding: 'utf8' });
    const found = q.status === 0 ? JSON.parse(q.stdout).root : null;
    const r = gate(plug, 'rm -rf ./packages/app/node_modules', cwd, cleanEnv());
    if (found === null) assert.strictEqual(r.status, 2, 'no project root anywhere: the pass-through must fail closed: ' + r.stderr);
    else {
      const rel = path.relative(plug, found);
      assert.ok(rel.startsWith('..') || path.isAbsolute(rel), 'discovered root ' + found + ' lies inside the plugin');
      console.log('  note D4: discovery from inside the temp folder found an ancestor project on this machine (' + found + ')');
    }
    assert.strictEqual(snapshot(plug), snap0);
  });
  const hook = require('./forge-gate-hook.cjs');
  t('D5 .forge scratch areas: inside a backups batch / a gate-output folder pass; the folders themselves and runs stay blocked', () => {
    const pfg = project(true);
    const at = (command) => hook.decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: pfg, tool_input: { command } }, { config: null, projectRoot: pfg, env: {} }).block;
    assert.deepStrictEqual(['rm -rf .forge/backups/2026-10-01', 'rm -rf .forge/runs/r1/gate-output'].map(at), [false, false]);
    assert.deepStrictEqual(['rm -rf .forge/backups', 'rm -rf .forge/runs/r1', 'rm -rf .forge', 'rm -rf .forge/memory'].map(at), [true, true, true, true]);
    assert.deepStrictEqual(['rm -rf .claude/forge-backups/2026-10-01', 'rm -rf .claude/forge-backups'].map(at), [false, true], 'the legacy areas are unchanged');
  });

  // ======================== E) plugin build: no state in the output, state of plugin-run tools lands in the project ===
  const pbTool = maintainerTool(BIN, DEV_TREE, byManifest, 'forge-plugin-build.cjs'), B = pbTool.mod;
  if (!B) console.log('  SKIP E1-E7: ' + pbTool.absent + ' (C0 proved the absence is by design)');
  if (B) t('E1 scanner: a marked fallback guarded by a forge-paths require is safe; unmarked or without the require it is not', () => {
    const guarded = "const fp = require('./forge-paths.cjs');\nconst r = fp ? fp.scriptRoot(__dirname) : path.resolve(__dirname, '..', '..'); // forge-paths fallback\n";
    const s = B.toolSafety(new Map([
      ['g.cjs', B.scanRootStrategy(guarded, () => false)],
      ['u.cjs', B.scanRootStrategy(guarded.replace(' // forge-paths fallback', ''), () => false)],
      ['n.cjs', B.scanRootStrategy(guarded.replace("require('./forge-paths.cjs')", 'null'), () => false)],
      ['forge-paths.cjs', B.scanRootStrategy("'use strict';\n", () => false)]]));
    assert.deepStrictEqual([s.get('g.cjs').cli_safe, s.get('u.cjs').cli_safe, s.get('n.cjs').cli_safe], [true, false, false]);
    assert.strictEqual(s.get('n.cjs').direct[0].kind, 'unguarded_fallback');
  });
  // E2-E7 need the development tree (plugin-template/); a synced project only runs the scanner unit test above
  const isDevTree = !!B && fs.existsSync(path.join(ROOT, B.TEMPLATE_REL, '.claude-plugin', 'plugin.json'));
  if (B && !isDevTree) console.log('  SKIP E2-E7: not the development tree (no ' + B.TEMPLATE_REL + '/), the plugin cannot be built here');
  const plan = isDevTree ? B.planBuild({ root: ROOT }) : null;
  const out = path.join(TMP, 'pb', 'forge-plugin');
  if (plan) B.writeBuild(plan, out);
  const outFiles = plan ? plan.files.map((f) => f.path) : [];
  if (plan) {
  t('E2 the built plugin carries no runtime state and ships forge-paths.cjs beside the tools', () => {
    // plugin top level: skills/ agents/ commands/ scripts/ config/ hooks/ install/ — a state folder would be top-level or .claude/
    const state = /(^|\/)\.forge\/|^(\.claude\/)?forge-(runs|scribe|research|backups|tickets|vault|index|audit|artifacts|mindmaps|prd)\/|(^|\/)\.claude\/forge-(runs|scribe|research|backups)\/|^(\.claude\/)?FORGE_(MEMORY|TASK_HISTORY|AGENT_LEDGER|DECISIONS|SNAPSHOT)\.md$/;
    assert.deepStrictEqual(outFiles.filter((p) => state.test(p)), []);
    assert.ok(outFiles.includes('scripts/forge-paths.cjs'));
  });
  t('E3 the migrated group-C tools carry no own-folder root signal in the plugin scan any more', () => {
    const C_TOOLS = ['forge-gate-hook.cjs', 'forge-toolhook.cjs', 'forge-stop-obligations.cjs', 'forge-recovery.cjs', 'forge-docdrift.cjs', 'forge-sweep-core.cjs', 'forge-gate-evidence.cjs', 'forge-configdrift.cjs', 'forge-shipcheck.cjs', 'forge-config.cjs', 'forge-setup.cjs', 'nvidia-provider.cjs', 'forge-policy.cjs', 'forge-cc-launch.cjs', 'forge-doctor.cjs'];
    const rows = plan.report.path_assumptions.tools.filter((x) => C_TOOLS.includes(x.tool));
    assert.strictEqual(rows.length, C_TOOLS.length);
    for (const r of rows) assert.deepStrictEqual(r.own, [], r.tool + ' ' + r.own.join(' | '));
  });
  const pfp = project(true); const plp = project(false);
  const runHook = (tool, payload, proj) => spawnSync(process.execPath, [path.join(out, 'scripts', tool)], { input: JSON.stringify(Object.assign({ session_id: 'migc', cwd: proj }, payload)), cwd: proj, env: cleanEnv({ CLAUDE_PROJECT_DIR: proj }), encoding: 'utf8', timeout: 20000 });
  const HOOKS = [
    ['forge-toolhook.cjs', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'x.txt', content: 'x' }, tool_response: {} }, 'runs/_toollog/migc.jsonl'],
    ['forge-tool-failure.cjs', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1' }, 'runs/_toollog/migc.jsonl'],
    ['forge-subagent-stop.cjs', { hook_event_name: 'SubagentStop', agent_type: 'verify-boss' }, 'runs/_hooks/subagent-stop.jsonl'],
    ['forge-session-end.cjs', { hook_event_name: 'SessionEnd', reason: 'other' }, 'runs/_hooks/session-end.jsonl'],
  ];
  for (const [tool, payload, rel] of HOOKS) {
    t('E4 plugin copy of ' + tool + ': .forge project -> .forge/' + rel + ', legacy project -> .claude/forge-' + rel, () => {
      assert.strictEqual(runHook(tool, payload, pfp).status, 0);
      assert.ok(has(pfp, '.forge/' + rel) && !has(pfp, '.claude/forge-runs'), tool);
      assert.strictEqual(runHook(tool, payload, plp).status, 0);
      assert.ok(has(plp, '.claude/forge-' + rel) && !has(plp, '.forge'), tool);
    });
  }
  const viaPlugin = (code, cwd, env) => spawnSync(process.execPath, ['-e', code, path.join(out, 'scripts')], { cwd, env: env || cleanEnv(), encoding: 'utf8', timeout: 30000 });
  t('E5 plugin copy of forge-recovery (cwd in the project, no CLAUDE_PROJECT_DIR): the ledger is the project\'s active research folder', () => {
    const code = "const r = require(require('path').join(process.argv[1], 'forge-recovery.cjs')); r.recordAttempt({ itemId: 'migc', finalStatus: 'FOUND_DIRECT' }); console.log(r.LEDGER_PATH);";
    const a = viaPlugin(code, pfp); const b = viaPlugin(code, plp);
    assert.strictEqual(a.stdout.trim(), path.join(pfp, '.forge', 'research', 'recovery-attempts.jsonl'), a.stderr);
    assert.strictEqual(b.stdout.trim(), path.join(plp, '.claude', 'forge-research', 'recovery-attempts.jsonl'), b.stderr);
    assert.ok(has(pfp, '.forge/research/recovery-attempts.jsonl') && has(plp, '.claude/forge-research/recovery-attempts.jsonl'));
    // inside the plugin: only READ where the ledger would go (never write: an ancestor of the temp folder may hold a
    // stray marker on this machine) — it must never be a path inside the plugin, and null means recordAttempt refuses
    const where = viaPlugin("const r = require(require('path').join(process.argv[1], 'forge-recovery.cjs')); console.log(JSON.stringify(r.LEDGER_PATH)); if (!r.LEDGER_PATH) { try { r.recordAttempt({ itemId: 'migc' }); } catch (e) { console.log(e.message); } }", path.join(out, 'scripts'));
    const lp = JSON.parse(where.stdout.split('\n')[0]);
    if (lp === null) assert.ok(/no project root found/.test(where.stdout), where.stdout);
    else { const rel = path.relative(path.dirname(out), lp); assert.ok(rel.startsWith('..') || path.isAbsolute(rel), 'ledger inside the plugin: ' + lp); }
  });
  t('E6 plugin copy of forge-gate-evidence (no --root): the evidence lands in the project\'s active runs folder', () => {
    const gates = w(TMP, 'gates.json', JSON.stringify([{ name: 'noop', cmd: process.execPath, args: ['-e', '0'] }]));
    const r = spawnSync(process.execPath, [path.join(out, 'scripts', 'forge-gate-evidence.cjs'), '--run', 'r-migc', '--gates', gates], { cwd: pfp, env: cleanEnv(), encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(has(pfp, '.forge/runs/r-migc/gate-evidence.json') && !has(pfp, '.claude/forge-runs'));
  });
  t('E7 nothing was written into the plugin folder or next to it', () => {
    assert.strictEqual(B.checkBuild(plan, out).ok, true);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(out)), ['forge-plugin']);
  });
  } // isDevTree

  // ======================== F) doctor / config / CLIs find state in either layout =========================
  const doctor = require('./forge-doctor.cjs');
  t('F1 doctor memory check: legacy .claude/, .forge/memory/, and the legacy fallback in a .forge project', () => {
    const l = project(false); w(l, '.claude/FORGE_MEMORY.md', '# real memory\n');
    const f = project(true); w(f, '.forge/memory/FORGE_MEMORY.md', '# real memory\n');
    const fb = project(true); w(fb, '.claude/FORGE_MEMORY.md', '# real memory\n');
    assert.deepStrictEqual([l, f, fb].map((p) => doctor.memoryDiscipline(p).present), [true, true, true]);
    const e = project(true);
    assert.ok(/expected at \.forge\/memory\/FORGE_MEMORY\.md/.test(doctor.memoryDiscipline(e).reason));
    assert.ok(/expected at \.claude\/FORGE_MEMORY\.md/.test(doctor.memoryDiscipline(project(false)).reason), 'legacy wording unchanged');
  });
  t('F2 doctor chain check reads .forge/runs once it exists, .claude/forge-runs otherwise', () => {
    const f = project(true); w(f, '.forge/runs/a/events.jsonl', '{"event_type":"x"}\n'); w(f, '.forge/runs/b/events.jsonl', '{"event_type":"x"}\n');
    const l = project(false); w(l, '.claude/forge-runs/a/events.jsonl', '{"event_type":"x"}\n');
    assert.deepStrictEqual([doctor.chainCheck(f).checked, doctor.chainCheck(l).checked], [2, 1]);
  });
  t('F3 doctor scribe check asks git about the store the scribe WRITES to (R7)', () => {
    const asked = [];
    const spy = (cmd, args) => { asked.push(args[args.length - 1]); return { status: 0 }; };
    for (const p of [project(false), project(true)]) { w(p, '.claude/forge-bin/forge-scribe.cjs', '// stub'); doctor.scribeWiring(p, { spawnSyncImpl: spy }); }
    assert.deepStrictEqual(asked, ['.claude/forge-scribe/inbox.jsonl', '.forge/scribe/inbox.jsonl']);
  });
  const cfg = require('./forge-config.cjs');
  t('F4 forge-config markSeen: .claude/FORGE_SESSION_STATE.json (legacy) vs .forge/memory/ (merging the legacy file once)', () => {
    const l = project(false); const f = project(true);
    w(f, '.claude/FORGE_SESSION_STATE.json', JSON.stringify({ other_tool_field: 7 }));
    for (const p of [l, f]) cfg.markSeen({ projectRoot: p, configHome: HOME });
    assert.ok(has(l, '.claude/FORGE_SESSION_STATE.json') && !has(l, '.forge'));
    const s = JSON.parse(fs.readFileSync(path.join(f, '.forge', 'memory', 'FORGE_SESSION_STATE.json'), 'utf8'));
    assert.ok(s.config_seen && s.other_tool_field === 7, 'read from the legacy file, written to the new one');
    assert.strictEqual(fs.readFileSync(path.join(f, '.claude', 'FORGE_SESSION_STATE.json'), 'utf8'), JSON.stringify({ other_tool_field: 7 }), 'legacy file untouched');
  });
  t('F5 docdrift / stop-obligations / gate-evidence / configdrift / setup / sweep: legacy paths byte-identical, .forge paths in a .forge project', () => {
    const dd = require('./forge-docdrift.cjs'); const so = require('./forge-stop-obligations.cjs'); const ge = require('./forge-gate-evidence.cjs');
    const cd = require('./forge-configdrift.cjs'); const su = require('./forge-setup.cjs'); const sw = require('./forge-sweep-core.cjs');
    const l = project(false); const f = project(true);
    assert.strictEqual(dd.defaultStatePath(l), path.join(l, '.claude', 'forge-research', 'docdrift-state.json'));
    assert.strictEqual(dd.defaultLedgerPath(f), path.join(f, '.forge', 'research', 'docdrift-ledger.jsonl'));
    w(f, '.claude/forge-research/docdrift-state.json', '{}');
    assert.strictEqual(dd.readStatePath(f), path.join(f, '.claude', 'forge-research', 'docdrift-state.json'), 'read fallback until the new file exists');
    w(f, '.forge/runs/r-live/events.jsonl', '{"event_type":"run_started"}\n');
    assert.strictEqual(so.findActiveRun(f).run.run_id, 'r-live');
    assert.strictEqual(so.findActiveRun(l).reason, 'no .claude/forge-runs folder', 'legacy message unchanged');
    ge.record('r-ev', [{ name: 'noop', cmd: process.execPath, args: ['-e', '0'] }], { root: f });
    assert.ok(has(f, '.forge/runs/r-ev/gate-evidence.json') && !has(f, '.claude/forge-runs/r-ev'));
    assert.ok(cd.writeBaseline(f, 'r-cd').path.startsWith(path.join(f, '.forge', 'runs', 'r-cd')));
    quiet(() => su.selfHeal(f)); quiet(() => su.selfHeal(l));
    assert.ok(has(f, '.forge/runs') && !has(f, '.claude/forge-runs') && has(l, '.claude/forge-runs') && !has(l, '.forge'));
    process.env.FORGE_SWEEP_ROOT = f;
    try { assert.ok(sw.resolveSweepDir().startsWith(path.join(f, '.forge', 'research', 'beginner-sweep-'))); } finally { delete process.env.FORGE_SWEEP_ROOT; }
  });
  t('F6 adopt-post-sync in a .forge project skips the two memory-writing steps with a reason and walks no .forge/backups', () => {
    const ad = require('./forge-adopt-post-sync.cjs');
    const f = project(true); seedForge(f); w(f, '.claude/FORGE_MEMORY.md', '# memory\n'); w(f, '.claude/FORGE_TASK_HISTORY.md', '- [ ] open thing to carry over\n');
    const plan = ad.adoptPlan({ project: f, now: '2026-10-24T00:00:00.000Z' });
    const why = (step) => (plan.skipped.find((s) => s.step === step) || {}).reason || '';
    assert.ok(/\.forge\/ state root/.test(why('scribe')) && /\.forge\/ state root/.test(why('memory')), JSON.stringify(plan.skipped));
    assert.ok(!plan.actions.some((a) => a.step === 'memory' || a.step === 'scribe'));
    const fm = ad.fileMap(f).files;
    assert.ok(fm['.forge/runs/r1/events.jsonl'] && !Object.keys(fm).some((k) => k.startsWith('.forge/backups')));
    assert.ok(ad.isMemoryRel('.forge/memory/FORGE_MEMORY.md'));
  });
} catch (e) {
  // a crash outside t() still counts and still ends in the "<n> passed, <m> failed" tally the doctor reads
  failed++; console.log('FAIL the suite stopped early: ' + ((e && e.stack) || e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
