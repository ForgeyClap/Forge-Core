#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-sync-publish-guard.test.cjs — category tests round 8: two failures reached the published template
 * and made fresh installs roll back.
 *   P1: a published test required a local-only module, so every installed project's doctor failed with "Cannot find
 *       module". Guard: publish-template --apply scans every published test's relative require()/import targets and
 *       refuses (exit 4) when one resolves to a development-tree file the template does not get.
 *   P2: a command file grew past its byte budget and was published, because only two suites ran, never the full doctor.
 *       Guard: --apply needs a GREEN full-doctor receipt (forge-doctor.cjs --receipt) whose fingerprint matches the
 *       published bytes now; the only way around it is --skip-doctor-receipt "<reason>", warned and recorded.
 * Every publish runs the fixture's OWN forge-sync.cjs CLI (copied from this folder) in a private temp folder, with a fake
 * home, so even the default target can only be a fixture. Harness: this project's t() wrapper and the tally line.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0, skip = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const skipped = (name, why) => { skip++; console.log('  skip ' + name + ' — ' + why); };
// a block whose set-up throws is one FAIL with its name, never a crash that loses the tally
const block = (name, fn) => { try { fn(); } catch (e) { fail++; console.error('  FAIL [' + name + '] set-up crashed — ' + ((e && e.message) || e)); } };

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pubguard-'));
process.on('exit', () => { try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* an AV lock must never turn the tally red */ } });
const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const GUARD_FILE = path.join(__dirname, 'forge-sync-publish-guard.cjs');
const loadGuard = () => require(GUARD_FILE);
const COPY = ['forge-sync.cjs', 'forge-sync-publish-guard.cjs', 'forge-shipcheck.cjs', 'forge-shipcheck-refs.cjs'];
const RULE = (pattern, cls) => ({ pattern, class: cls, channels: cls === 'local-only' ? [] : ['sync', 'release', 'template'], reason: 'fixture ' + cls });
const RULES = [RULE('.claude/forge-bin/*.cjs', 'ship-sync'), RULE('.claude/forge-bin/local-*.cjs', 'local-only'), RULE('.claude/config/**', 'ship-sync'), RULE('.claude/config/forge-dev-tree.json', 'local-only')];
const manifestText = (rules) => JSON.stringify({ schema: 'forge-ship-manifest/v1', rules, known_gaps: [] }, null, 2) + '\n';

// A stand-in doctor with the REAL --receipt contract: the verdict comes from FIXTURE_DOCTOR_OK, the receipt is written by
// the same guard functions forge-doctor.cjs calls.
const STUB_DOCTOR = [
  '#!/usr/bin/env node', "'use strict';", "const path = require('path');",
  'if (require.main === module) {',
  "  const ok = process.env.FIXTURE_DOCTOR_OK === '1';",
  "  const root = path.resolve(__dirname, '..', '..');",
  "  const G = process.argv.includes('--receipt') ? require('./forge-sync-publish-guard.cjs') : null;",
  '  const start = G ? G.beginDoctorReceipt(root) : null;',
  "  if (process.env.FIXTURE_DOCTOR_TOUCH) require('fs').appendFileSync(path.join(__dirname, process.env.FIXTURE_DOCTOR_TOUCH), '// edited during the run\\n');",
  '  const rep = { ok, root, checks: { tests: { ok, suites: 1, suitesFailed: ok ? 0 : 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1 } } };',
  '  if (G) G.finishDoctorReceipt(start, rep);',
  '  process.exitCode = ok ? 0 : 1;',
  '}', '',
].join('\n');
// A published test that only needs published modules; local-mod.cjs is named only in a comment and in string data.
const TOOL_TEST = [
  "'use strict';", "const path = require('path');", "const tool = require('./tool.cjs');",
  "const again = require(path.join(__dirname, 'tool.cjs'));",
  "// require('./local-mod.cjs') is how the old version loaded it",
  "const fixtureSource = \"const x = require('./local-mod.cjs');\";",
  "const tpl = `require('./local-mod.cjs')`;", 'const re = /require\\(\'\\.\\/local-mod\\.cjs\'\\)/;',
  "console.log(tool.answer === again.answer && fixtureSource && tpl && re ? '1 passed, 0 failed' : '0 passed, 1 failed');", '',
].join('\n');

function write(base, rel, body) { const f = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; }
function read(base, rel) { try { return fs.readFileSync(path.join(base, ...rel.split('/')), 'utf8'); } catch { return null; } }
function gitIn(dir) { return (args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'].concat(args), { encoding: 'utf8' }); }

let BASE = null;
/** baseRepo — one committed development tree (git), copied (with .git) into every fixture. */
function baseRepo() {
  if (BASE) return BASE;
  const devRoot = path.join(RUN_DIR, 'base', 'dev'), dev = path.join(devRoot, '.claude');
  write(dev, 'config/forge-dev-tree.json', '{"dev_tree":true}\n');
  write(dev, 'config/orchestration/FORGE_SHIP_MANIFEST.json', manifestText(RULES));
  fs.mkdirSync(path.join(dev, 'forge-bin'), { recursive: true });
  for (const f of COPY) if (fs.existsSync(path.join(__dirname, f))) fs.copyFileSync(path.join(__dirname, f), path.join(dev, 'forge-bin', f));
  write(dev, 'forge-bin/forge-doctor.cjs', STUB_DOCTOR);
  write(dev, 'forge-bin/tool.cjs', "'use strict';\nmodule.exports = { answer: 42 };\n");
  write(dev, 'forge-bin/tool.test.cjs', TOOL_TEST);
  write(dev, 'forge-bin/local-mod.cjs', "module.exports = 'local only';\n");
  const g = gitIn(devRoot);
  g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
  BASE = devRoot;
  return BASE;
}
function fixture(name) {
  const root = path.join(RUN_DIR, name);
  const devRoot = path.join(root, 'dev'), dev = path.join(devRoot, '.claude'), tpl = path.join(root, 'tpl', '.claude'), home = path.join(root, 'home');
  fs.cpSync(baseRepo(), devRoot, { recursive: true });
  write(tpl, 'forge-bin/tool.cjs', 'OLD TEMPLATE COPY\n');
  fs.mkdirSync(home, { recursive: true });
  const g = gitIn(devRoot);
  return { root, devRoot, dev, tpl, home, g, commit: (msg) => { g(['add', '-A']); g(['commit', '-q', '-m', msg]); } };
}
const env = (fx, extra) => Object.assign({}, process.env, { USERPROFILE: fx.home, HOME: fx.home }, extra || {});
const pub = (fx, args) => spawnSync(process.execPath, [path.join(fx.dev, 'forge-bin', 'forge-sync.cjs'), 'publish-template'].concat(args), { encoding: 'utf8', env: env(fx) });
const apply = (fx, batch, extra) => pub(fx, ['--apply', '--template-dir', fx.tpl, '--batch-id', batch].concat(extra || []));
const doctor = (fx, ok) => spawnSync(process.execPath, [path.join(fx.dev, 'forge-bin', 'forge-doctor.cjs'), '--receipt'], { encoding: 'utf8', env: env(fx, { FIXTURE_DOCTOR_OK: ok ? '1' : '0' }) });
const receiptFile = (fx) => path.join(fx.devRoot, '_scratch', 'forge-doctor-receipt.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const tplReceipt = (fx) => readJson(path.join(fx.tpl, 'template-publish-receipt.json'));
const untouched = (fx) => read(fx.tpl, 'forge-bin/tool.cjs') === 'OLD TEMPLATE COPY\n' && !fs.existsSync(path.join(fx.tpl, 'forge-bin', 'tool.test.cjs'));
const out = (r) => (r.stdout || '') + (r.stderr || '');

console.log('forge-sync-publish-guard: publish-template --apply blockers (category tests round 8)');
t('the guard module ships beside forge-sync.cjs', () => assert.ok(fs.existsSync(GUARD_FILE), GUARD_FILE + ' is missing'));

// ---- the static require() scanner (library) ----
t('requireRefs: literal require, __dirname join, ESM import/from/import(); comments, strings, templates, methods and variables are not loads', () => {
  const G = loadGuard();
  const src = [
    "const a = require('./a.cjs');", "const b = require(path.join(__dirname, '..', 'sub', 'b.cjs'));",
    "// require('./c.cjs')", "/* require('./c2.cjs') */", "const s = \"require('./d.cjs')\";", "const tp = `require('./d2.cjs')`;",
    // an odd quote inside a regex literal: read as a string start, it would swallow the require() after it
    "const re = /[\"']x/; const e = require('./e.cjs');", "const q = n / 2; const f = require('./f.cjs');",
    "import g from './g.mjs';", "const h = import('./h.mjs');", "export * from './i.mjs';",
    "obj.require('./j.cjs'); const k = require(name); const l = require('fs');", "const m = require(`./m.cjs`);",
  ].join('\n');
  const got = G.requireRefs(src).map((r) => (r.kind === 'dirname' ? 'dirname:' + r.segs.join('/') : r.spec) + '@' + r.line);
  assert.deepStrictEqual(got, ['./a.cjs@1', 'dirname:../sub/b.cjs@2', './e.cjs@7', './f.cjs@8', './g.mjs@9', './h.mjs@10', './i.mjs@11', 'fs@12', './m.cjs@13']);
});
t('requireRefs guards: an existsSync() naming the SAME file guards its block, a braceless if and a ternary — nothing else', () => {
  const G = loadGuard();
  const src = [
    "if (fs.existsSync(path.join(__dirname, 'forge-plugin-build.cjs'))) {", "  const B = require('./forge-plugin-build.cjs');", '}',
    "require('./forge-plugin-build.cjs');",
    "if (fs.existsSync(path.join(__dirname, 'b.cjs'))) require('./b.cjs');", "require('./b.cjs');",
    "const c = fs.existsSync(path.join(__dirname, 'c.cjs')) ? require('./c.cjs') : null;",
    "if (fs.existsSync(path.join(__dirname, 'other.cjs'))) { require('./d.cjs'); }",
    "if (ok) { if (fs.existsSync(path.join(__dirname, 'e.cjs'))) { t(() => { require('./e.cjs'); }); } require('./e.cjs'); }",
  ].join('\n');
  const got = G.requireRefs(src).map((r) => r.spec + '@' + r.line + (r.guards.length ? ' guarded by ' + r.guards.join('+') : ''));
  assert.deepStrictEqual(got, [
    './forge-plugin-build.cjs@2 guarded by forge-plugin-build.cjs', './forge-plugin-build.cjs@4',
    './b.cjs@5 guarded by b.cjs', './b.cjs@6', './c.cjs@7 guarded by c.cjs', './d.cjs@8 guarded by other.cjs',
    './e.cjs@9 guarded by e.cjs', './e.cjs@9',
  ]);
  const devRoot = path.join(RUN_DIR, 'lib-guard'), dev = path.join(devRoot, '.claude');
  write(dev, 'forge-bin/d.cjs', '1\n'); write(dev, 'forge-bin/other.cjs', '2\n');
  write(dev, 'forge-bin/g.test.cjs', "if (fs.existsSync(path.join(__dirname, 'other.cjs'))) { require('./d.cjs'); require('./other.cjs'); }\n");
  const r = G.unpublishedTestRequires(dev, ['forge-bin/g.test.cjs']);
  assert.deepStrictEqual([r.findings.map((f) => f.target), r.guarded.map((f) => f.target)], [['forge-bin/d.cjs'], ['forge-bin/other.cjs']]);
});
t('unpublishedTestRequires: names the test, the line, the spec and the unpublished target; published and missing targets pass', () => {
  const G = loadGuard();
  const devRoot = path.join(RUN_DIR, 'lib-scan'), dev = path.join(devRoot, '.claude');
  write(dev, 'forge-bin/pub.cjs', '1\n'); write(dev, 'forge-bin/local.cjs', '2\n'); write(devRoot, 'scripts/outside.cjs', '3\n');
  write(dev, 'forge-bin/a.test.cjs', "require('./pub.cjs');\nrequire('./local.cjs');\nrequire('./never-existed.cjs');\nrequire('../../scripts/outside.cjs');\n");
  write(dev, 'forge-bin/not-a-test.cjs', "require('./local.cjs');\n");
  const r = G.unpublishedTestRequires(dev, ['forge-bin/pub.cjs', 'forge-bin/a.test.cjs', 'forge-bin/not-a-test.cjs']);
  assert.strictEqual(r.scanned, 1);
  assert.deepStrictEqual(r.findings.map((f) => [f.test, f.line, f.spec, f.target, f.where]), [
    ['forge-bin/a.test.cjs', 2, './local.cjs', 'forge-bin/local.cjs', 'unpublished'],
    ['forge-bin/a.test.cjs', 4, '../../scripts/outside.cjs', 'scripts/outside.cjs', 'outside-claude'],
  ]);
});

if (!GIT_OK) skipped('publish-template CLI cases (P1/P2 shapes, receipt, escape)', 'git is not available here — publish-template needs a git development tree');
else {
  // ---- P2: the full-doctor receipt ----
  block('green receipt', () => {
    const fx = fixture('green');
    const d = doctor(fx, true);
    const rc = readJson(receiptFile(fx));
    t('green: the doctor --receipt writes ok:true with the published fingerprint and file list', () => {
      assert.strictEqual(d.status, 0, out(d));
      assert.ok(rc && rc.ok === true && rc.doctor_ok === true && rc.fingerprint_stable === true, JSON.stringify(rc));
      assert.ok(/^[0-9a-f]{64}$/.test(rc.published_fingerprint) && rc.published_files['forge-bin/tool.test.cjs'], JSON.stringify(rc).slice(0, 400));
      assert.ok(!('forge-bin/local-mod.cjs' in rc.published_files) && !('config/forge-dev-tree.json' in rc.published_files));
    });
    const a = apply(fx, 'g1');
    t('green + a published test that requires only published modules: --apply publishes (exit 0)', () => {
      assert.strictEqual(a.status, 0, out(a));
      assert.strictEqual(read(fx.tpl, 'forge-bin/tool.test.cjs'), read(fx.dev, 'forge-bin/tool.test.cjs'));
    });
    t('green: the template publish receipt records the doctor receipt it relied on', () => {
      const pr = tplReceipt(fx);
      assert.ok(pr && pr.doctorReceipt, JSON.stringify(pr && Object.keys(pr)));
      assert.strictEqual(pr.doctorReceipt.state, 'green');
      assert.strictEqual(pr.doctorReceipt.published_fingerprint, rc.published_fingerprint);
      assert.strictEqual(pr.doctorReceipt.skipped, null);
    });
  });
  block('no receipt', () => {
    const fx = fixture('noreceipt');
    const a = apply(fx, 'n1');
    t('no receipt: --apply refuses (exit 4), says how to make one, writes nothing', () => {
      assert.strictEqual(a.status, 4, out(a));
      assert.ok(/full-doctor receipt: none/.test(a.stdout) && /forge-doctor\.cjs --receipt/.test(a.stdout) && /--skip-doctor-receipt/.test(a.stdout), a.stdout);
      assert.ok(untouched(fx));
    });
    const p = pub(fx, ['--plan', '--template-dir', fx.tpl]);
    t('no receipt: --plan already lists it under "--apply would REFUSE"', () => assert.ok(p.status === 0 && /--apply would REFUSE[\s\S]*full-doctor receipt: none/.test(p.stdout), p.stdout));
  });
  block('red receipt', () => {
    const fx = fixture('red');
    const d = doctor(fx, false);
    const a = apply(fx, 'r1');
    t('a receipt from a RED doctor: --apply refuses (exit 4), nothing written', () => {
      assert.strictEqual(d.status, 1);
      assert.strictEqual(readJson(receiptFile(fx)).ok, false);
      assert.strictEqual(a.status, 4, out(a));
      assert.ok(/full-doctor receipt: .*RED/.test(a.stdout), a.stdout);
      assert.ok(untouched(fx));
    });
  });
  block('file edited during the doctor run', () => {
    const fx = fixture('unstable');
    const d = spawnSync(process.execPath, [path.join(fx.dev, 'forge-bin', 'forge-doctor.cjs'), '--receipt'], { encoding: 'utf8', env: env(fx, { FIXTURE_DOCTOR_OK: '1', FIXTURE_DOCTOR_TOUCH: 'tool.cjs' }) });
    const rc = readJson(receiptFile(fx));
    fx.commit('commit the edit, so only the receipt can refuse');
    const a = apply(fx, 'u1');
    t('a published file edited WHILE a green doctor ran: the receipt says ok:false and --apply refuses (exit 4)', () => {
      assert.strictEqual(d.status, 0, out(d));
      assert.ok(rc && rc.doctor_ok === true && rc.fingerprint_stable === false && rc.ok === false, JSON.stringify(rc && { ok: rc.ok, stable: rc.fingerprint_stable }));
      assert.strictEqual(a.status, 4, out(a));
      assert.ok(/full-doctor receipt: published files changed WHILE the doctor ran/.test(a.stdout), a.stdout);
      assert.ok(untouched(fx));
    });
  });
  block('stale receipt', () => {
    const fx = fixture('stale');
    doctor(fx, true);
    write(fx.dev, 'forge-bin/tool.cjs', "'use strict';\nmodule.exports = { answer: 43 };\n");
    write(fx.dev, 'forge-bin/brand-new.cjs', "module.exports = 'new';\n");
    fx.commit('changed after the doctor');
    const a = apply(fx, 's1');
    t('a published file changed (and one added) after the green doctor: --apply refuses (exit 4) and names both', () => {
      assert.strictEqual(a.status, 4, out(a));
      assert.ok(/full-doctor receipt: published files changed after/.test(a.stdout), a.stdout);
      assert.ok(/changed forge-bin\/tool\.cjs/.test(a.stdout) && /added forge-bin\/brand-new\.cjs/.test(a.stdout), a.stdout);
      assert.ok(untouched(fx));
    });
    doctor(fx, true);
    t('...and a fresh green doctor on those bytes lets it publish', () => assert.strictEqual(apply(fx, 's2').status, 0));
  });
  block('foreign, future, forged receipts', () => {
    const G = GUARD_LOADABLE();
    const src = fixture('green-src');
    doctor(src, true);
    const fx = fixture('foreign');
    write(fx.devRoot, '_scratch/forge-doctor-receipt.json', fs.readFileSync(receiptFile(src), 'utf8'));
    const a = apply(fx, 'f1');
    t('a green receipt of ANOTHER tree with identical bytes: refused (exit 4) — the receipt is bound to its tree', () => {
      assert.strictEqual(a.status, 4, out(a));
      assert.ok(/full-doctor receipt: .*another tree/.test(a.stdout), a.stdout);
    });
    const own = readJson(receiptFile(src));
    const future = Object.assign({}, own, { root: fs.realpathSync.native(fx.devRoot), finished_at: '2999-01-01T00:00:00.000Z' });
    write(fx.devRoot, '_scratch/forge-doctor-receipt.json', JSON.stringify(future));
    const af = apply(fx, 'f2');
    t('a receipt dated in the future: refused (exit 4)', () => { assert.strictEqual(af.status, 4, out(af)); assert.ok(/full-doctor receipt: .*future/.test(af.stdout), af.stdout); });
    const forged = Object.assign({}, own, { root: fs.realpathSync.native(fx.devRoot), published_files: {} });
    write(fx.devRoot, '_scratch/forge-doctor-receipt.json', JSON.stringify(forged));
    const ag = apply(fx, 'f3');
    t('a receipt whose fingerprint does not match its own file list (hand-edited): refused (exit 4)', () => { assert.strictEqual(ag.status, 4, out(ag)); assert.ok(/full-doctor receipt: not valid/.test(ag.stdout), ag.stdout); });
    write(fx.devRoot, '_scratch/forge-doctor-receipt.json', '{"schema":"forge-doctor-receipt/v1","ok":tru');
    const ah = apply(fx, 'f4');
    t('a truncated receipt: refused (exit 4)', () => { assert.strictEqual(ah.status, 4, out(ah)); assert.ok(/full-doctor receipt: not valid/.test(ah.stdout), ah.stdout); });
    // FB-SYNC-D-F1: ok:true that its own fields contradict (doctor red, bytes moved, a failing check) is not green
    const fxi = fixture('inconsistent');
    doctor(fxi, true);
    const okRc = readJson(receiptFile(fxi));
    for (const [label, patch] of [['doctor_ok:false', { doctor_ok: false }], ['fingerprint_stable:false', { fingerprint_stable: false }], ['a failing check', { failing_checks: ['tests'] }]]) {
      write(fxi.devRoot, '_scratch/forge-doctor-receipt.json', JSON.stringify(Object.assign({}, okRc, patch)));
      const ai = apply(fxi, 'inc-' + label.replace(/[^a-z]/gi, ''));
      t('FB-SYNC-D-F1: ok:true with ' + label + ' is an inconsistent receipt: refused (exit 4), never green', () => {
        assert.strictEqual(ai.status, 4, out(ai));
        assert.ok(/full-doctor receipt: not valid/.test(ai.stdout), ai.stdout);
        assert.ok(untouched(fxi));
      });
    }
    t('the fingerprint is a pure function of the published file hashes', () => {
      assert.ok(G, 'guard not loadable');
      const hashes = G.publishedHashes(fx.dev);
      assert.strictEqual(G.fingerprintOf(hashes), own.published_fingerprint);
      assert.notStrictEqual(G.fingerprintOf(Object.assign({}, hashes, { 'forge-bin/tool.cjs': '0'.repeat(64) })), own.published_fingerprint);
    });
  });
  // ---- P1: a published test that requires a local-only module ----
  block('P1 shape', () => {
    const fx = fixture('p1');
    write(fx.dev, 'forge-bin/theme-edit.test.cjs', "'use strict';\nconst assert = require('assert');\nconst F = require('./local-mod.cjs');\nassert.ok(F);\n");
    write(fx.dev, 'forge-bin/theme-join.test.cjs', "'use strict';\nconst path = require('path');\nconst F = require(path.join(__dirname, 'local-mod.cjs'));\nconsole.log(F);\n");
    fx.commit('the P1 shape: two published tests need a local-only module');
    doctor(fx, true); // a green doctor in the dev tree, where the module exists: exactly how P1 slipped through
    const a = apply(fx, 'p1a');
    t('P1 shape: --apply refuses (exit 4) even with a green doctor, naming each test, its target and the fix', () => {
      assert.strictEqual(a.status, 4, out(a));
      assert.ok(/forge-bin\/theme-edit\.test\.cjs:3 requires '\.\/local-mod\.cjs' -> forge-bin\/local-mod\.cjs \(not published\)/.test(a.stdout), a.stdout);
      assert.ok(/forge-bin\/theme-join\.test\.cjs:3 requires path\.join\(__dirname, 'local-mod\.cjs'\) -> forge-bin\/local-mod\.cjs/.test(a.stdout), a.stdout);
      assert.ok(/Cannot find module/.test(a.stdout) && /mark .*local-only/.test(a.stdout) && /publish the module/.test(a.stdout), a.stdout);
      assert.ok(!/full-doctor receipt:/.test(a.stdout), 'the receipt was green and current: only the require finding may block');
      assert.ok(untouched(fx));
    });
    const s = apply(fx, 'p1b', ['--skip-doctor-receipt', 'owner: hotfix window']);
    t('P1 shape: --skip-doctor-receipt does NOT bypass the require check', () => assert.ok(s.status === 4 && /theme-edit\.test\.cjs/.test(s.stdout), out(s)));
    write(fx.dev, 'config/orchestration/FORGE_SHIP_MANIFEST.json', manifestText(RULES.concat([RULE('.claude/forge-bin/theme-{edit,join}.test.cjs', 'local-only')])));
    fx.commit('the fix: the tests are local-only like their module');
    doctor(fx, true);
    const ok = apply(fx, 'p1c');
    t('P1 fixed the advised way (tests marked local-only): --apply publishes, the tests stay out of the template', () => {
      assert.strictEqual(ok.status, 0, out(ok));
      assert.ok(!fs.existsSync(path.join(fx.tpl, 'forge-bin', 'theme-edit.test.cjs')) && fs.existsSync(path.join(fx.tpl, 'forge-bin', 'tool.test.cjs')));
    });
  });
  // ---- the escape ----
  block('escape', () => {
    const fx = fixture('skip');
    const reason = 'owner: emergency hotfix, full doctor runs right after';
    const a = apply(fx, 'k1', ['--skip-doctor-receipt', reason]);
    t('--skip-doctor-receipt "<reason>": publishes without a receipt, with a loud warning', () => {
      assert.strictEqual(a.status, 0, out(a));
      assert.ok(/WARNING/.test(a.stderr) && /--skip-doctor-receipt/.test(a.stderr) && a.stderr.includes(reason), a.stderr);
      assert.ok(/doctor receipt: SKIPPED/.test(a.stdout), a.stdout);
    });
    t('--skip-doctor-receipt: the reason and the receipt state are recorded in the template publish receipt', () => {
      const pr = tplReceipt(fx);
      assert.ok(pr && pr.doctorReceipt, JSON.stringify(pr && Object.keys(pr)));
      assert.strictEqual(pr.doctorReceipt.skipped, reason);
      assert.strictEqual(pr.doctorReceipt.state, 'missing');
    });
    t('--skip-doctor-receipt needs a real reason, and only with --apply (usage error, exit 2)', () => {
      assert.strictEqual(apply(fx, 'k2', ['--skip-doctor-receipt', 'x']).status, 2);
      assert.strictEqual(pub(fx, ['--plan', '--template-dir', fx.tpl, '--skip-doctor-receipt', 'owner: some reason']).status, 2);
    });
  });
  // ---- fail closed when the guard itself is missing ----
  block('guard missing', () => {
    const fx = fixture('noguard');
    doctor(fx, true);
    fs.unlinkSync(path.join(fx.dev, 'forge-bin', 'forge-sync-publish-guard.cjs'));
    fx.commit('the guard is gone');
    const a = apply(fx, 'm1');
    t('the guard module missing: --apply refuses (exit 4), never a silent pass', () => {
      assert.strictEqual(a.status, 4, out(a));
      assert.ok(/forge-sync-publish-guard\.cjs/.test(a.stdout), a.stdout);
      assert.ok(untouched(fx));
    });
  });
}

// ---- the REAL forge-doctor.cjs --receipt wiring (a tiny development tree: the doctor is red there, honestly) ----
block('real forge-doctor.cjs --receipt', () => {
  const DOCTOR = path.join(__dirname, 'forge-doctor.cjs');
  const tiny = path.join(RUN_DIR, 'tiny'), tdev = path.join(tiny, '.claude');
  write(tdev, 'config/forge-dev-tree.json', '{"dev_tree":true}\n');
  write(tdev, 'config/orchestration/FORGE_SHIP_MANIFEST.json', manifestText([RULE('.claude/forge-bin/*.cjs', 'ship-sync'), RULE('.claude/config/**', 'ship-sync'), RULE('.claude/config/forge-dev-tree.json', 'local-only')]));
  write(tdev, 'forge-bin/x.cjs', 'module.exports = 1;\n');
  write(tdev, 'forge-bin/x.test.cjs', "console.log('1 passed, 0 failed');\n");
  const r = spawnSync(process.execPath, [DOCTOR, '--root', tiny, '--receipt', '--json'], { encoding: 'utf8', timeout: 600000 });
  let rep = null; try { rep = JSON.parse(r.stdout); } catch { rep = null; }
  const rc = readJson(path.join(tiny, '_scratch', 'forge-doctor-receipt.json'));
  t('real doctor --receipt --json: stdout is still exactly one JSON object, the exit code still follows ok', () => {
    assert.ok(rep && typeof rep.ok === 'boolean', 'stdout: ' + String(r.stdout).slice(0, 300) + ' stderr: ' + String(r.stderr).slice(0, 300));
    assert.strictEqual(r.status, rep.ok ? 0 : 1);
  });
  t('real doctor --receipt: the receipt carries the doctor verdict, the tree and the published fingerprint', () => {
    assert.ok(rc, 'no receipt written; stderr: ' + String(r.stderr).slice(0, 300));
    assert.strictEqual(rc.doctor_ok, rep.ok);
    assert.strictEqual(rc.ok, rep.ok && rc.fingerprint_stable === true);
    assert.strictEqual(rc.root.toLowerCase(), fs.realpathSync.native(tiny).toLowerCase());
    const G = loadGuard();
    assert.strictEqual(rc.published_fingerprint, G.fingerprintOf(G.publishedHashes(tdev)));
    assert.ok(Date.parse(rc.finished_at) >= Date.parse(rc.started_at));
  });
  // an installed project: it HAS the shipping manifest (ship-sync), only the development-tree marker is absent
  const plain = path.join(RUN_DIR, 'plain-project');
  write(plain, '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json', manifestText([RULE('.claude/forge-bin/*.cjs', 'ship-sync')]));
  write(plain, '.claude/forge-bin/y.test.cjs', "console.log('1 passed, 0 failed');\n");
  const n = spawnSync(process.execPath, [DOCTOR, '--root', plain, '--receipt'], { encoding: 'utf8', timeout: 120000 });
  t('real doctor --receipt in an installed project (manifest, no dev-tree marker): refused at once (exit 2), no receipt, no self-test', () => {
    assert.strictEqual(n.status, 2, String(n.stdout) + String(n.stderr));
    assert.ok(/only for the Forge development tree/.test(n.stderr) && /dev_tree:true/.test(n.stderr), n.stderr);
    assert.ok(!fs.existsSync(path.join(plain, '_scratch')) && !/Forge Doctor —/.test(n.stdout));
  });
  const h = spawnSync(process.execPath, [DOCTOR, '--help'], { encoding: 'utf8', timeout: 60000 });
  t('real doctor --help names --receipt', () => assert.ok(h.status === 0 && /--receipt/.test(h.stdout), h.stdout));
});

// ---- FIX-SYNC D-F2: only an exact, non-negated existence check of the SAME file guards a load ----
t('FIX-SYNC D-F2: a negated check, a comma declaration, a missing semicolon and a same-named file in another folder guard nothing', () => {
  const G = loadGuard();
  const devRoot = path.join(RUN_DIR, 'lib-guard-strict'), dev = path.join(devRoot, '.claude');
  write(dev, 'forge-bin/local.cjs', '1\n'); write(dev, 'forge-bin/sub/local.cjs', '2\n');
  const loose = {
    'forge-bin/neg.test.cjs': "if (!fs.existsSync(path.join(__dirname, 'local.cjs'))) { require('./local.cjs'); }\n",
    'forge-bin/comma.test.cjs': "const has = fs.existsSync(path.join(__dirname, 'local.cjs')), L = require('./local.cjs');\n",
    'forge-bin/nosemi.test.cjs': "assert.ok(fs.existsSync(path.join(__dirname, 'local.cjs')))\nrequire('./local.cjs')\n",
    'forge-bin/elsewhere.test.cjs': "if (fs.existsSync(path.join(__dirname, 'sub', 'local.cjs'))) { require('./local.cjs'); }\n",
    'forge-bin/elsebranch.test.cjs': "const x = fs.existsSync(path.join(__dirname, 'local.cjs')) ? null : require('./local.cjs');\n",
  };
  const exact = {
    'forge-bin/block.test.cjs': "if (fs.existsSync(path.join(__dirname, 'local.cjs'))) { require('./local.cjs'); }\n",
    'forge-bin/and.test.cjs': "const L = fs.existsSync(path.join(__dirname, 'sub', 'local.cjs')) && require('./sub/local.cjs');\n",
  };
  for (const [rel, src] of Object.entries(Object.assign({}, loose, exact))) write(dev, rel, src);
  const r = G.unpublishedTestRequires(dev, Object.keys(loose).concat(Object.keys(exact)));
  assert.deepStrictEqual(r.findings.map((f) => f.test).sort(), Object.keys(loose).sort(), JSON.stringify(r.findings));
  assert.deepStrictEqual(r.guarded.map((f) => f.test).sort(), Object.keys(exact).sort(), JSON.stringify(r.guarded));
});

if (GIT_OK) {
  block('guarded loads in the plan', () => {
    const fx = fixture('guarded-plan');
    write(fx.dev, 'forge-bin/opt.test.cjs', "'use strict';\nconst fs = require('fs'), path = require('path');\nif (fs.existsSync(path.join(__dirname, 'local-mod.cjs'))) { require('./local-mod.cjs'); }\nconsole.log('1 passed, 0 failed');\n");
    fx.commit('a published test that loads a local-only module behind an existence check');
    const p = pub(fx, ['--plan', '--template-dir', fx.tpl]);
    t('FIX-SYNC D-F2: --plan lists a published test\'s guarded load of a local-only module (never passed silently)', () => {
      assert.strictEqual(p.status, 0, out(p));
      assert.ok(/test load\(s\) behind an existence check[^\n]*\(1\)\n\s+forge-bin\/opt\.test\.cjs:3 -> forge-bin\/local-mod\.cjs/.test(p.stdout), p.stdout);
    });
  });
  // ---- FIX-SYNC C-F8: a receipt red ONLY on run_contract (the tree's own run records) does not block the publish ----
  block('receipt red only on run_contract', () => {
    const fx = fixture('runcontract-only');
    doctor(fx, true);
    const rc = readJson(receiptFile(fx));
    const redOn = (checks) => write(fx.devRoot, '_scratch/forge-doctor-receipt.json', JSON.stringify(Object.assign({}, rc, { ok: false, doctor_ok: false, failing_checks: checks })));
    redOn(['run_contract']);
    const a = apply(fx, 'rc1');
    t('FIX-SYNC C-F8: a receipt red only on run_contract publishes (exit 0) and the output warns, naming the check', () => {
      assert.strictEqual(a.status, 0, out(a));
      assert.ok(/doctor receipt: green[^\n]*WARNING: the doctor was red only on run_contract/.test(a.stdout), a.stdout);
      assert.strictEqual((tplReceipt(fx) || {}).doctorReceipt.state, 'green');
      assert.ok(/run_contract/.test((tplReceipt(fx) || {}).doctorReceipt.warning || ''));
    });
    const fx2 = fixture('runcontract-and-tests');
    doctor(fx2, true);
    const rc2 = readJson(receiptFile(fx2));
    write(fx2.devRoot, '_scratch/forge-doctor-receipt.json', JSON.stringify(Object.assign({}, rc2, { ok: false, doctor_ok: false, failing_checks: ['run_contract', 'tests'] })));
    const a2 = apply(fx2, 'rc2');
    t('FIX-SYNC C-F8: ...but red on tests as well still refuses (exit 4)', () => { assert.strictEqual(a2.status, 4, out(a2)); assert.ok(/full-doctor receipt: .*RED/.test(a2.stdout), a2.stdout); assert.ok(untouched(fx2)); });
  });
}

// ---- this tree's own published set: no published test needs a module the template lacks ----
block('own published set', () => {
  let G = null, hashes = null, why = null;
  try { G = loadGuard(); hashes = G.publishedHashes(path.resolve(__dirname, '..')); } catch (e) { why = e.message; }
  if (!hashes) skipped('this tree\'s published tests resolve only published modules', 'the published set cannot be listed here (' + why + ')');
  else {
    t('this tree\'s published tests resolve only published modules (the P1 class is absent now)', () => {
      const r = G.unpublishedTestRequires(path.resolve(__dirname, '..'), Object.keys(hashes));
      assert.ok(r.scanned > 0, 'no published test scanned');
      assert.deepStrictEqual(r.findings, []);
      assert.deepStrictEqual(r.unreadable, []);
    });
  }
});

function GUARD_LOADABLE() { try { return loadGuard(); } catch { return null; } }

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exitCode = fail ? 1 : 0;
