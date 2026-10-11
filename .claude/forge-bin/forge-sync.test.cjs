#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-sync.cjs (WP1 safe-sync, + owner-approved addendum). EVERY fixture
 * (fake template, fake projects, fake dedicated canary, fake central backup hub) lives under a fresh
 * os.tmpdir() directory — this file NEVER touches this repo's real .claude/, the real 12 Forge projects, or
 * runs sync-all/install against anything real. Exit 0 = all pass.
 *
 * Section map (spec item -> test section):
 *   ORIGINAL SPEC 1-10                          -> sections 1-10
 *   ADDENDUM A (byte-manifest rollback proof)   -> sections 2, 6a/6b (fullFileManifest before/after)
 *   ADDENDUM B (two-stage canary + ladder)      -> sections 3, 4, 5, 11
 *   ADDENDUM C (central backup independence)    -> section 12
 *   ADDENDUM D (3-class override classification)-> section 13
 *   ADDENDUM E (extended receipt fields)         -> section 9
 *   ADDENDUM F1-F9 (9 failure cases)            -> sections 14-22
 *   ADDENDUM G (no global sync)                 -> structural (every fixture is os.tmpdir()-only; see grep note)
 *   M-B3 mutant kill (QA gate, hardening 2026-07-14) -> section 58 (58a: readFileSync EPERM catch branch;
 *                                                       58b: non-ENOENT lstatSync catch branch)
 *   MEDIUM FIX (adversarial break-swarm repro) -> section 61: regressionCheck no longer exempts
 *   a doctor check the sync itself just introduced (absent pre-sync) when that check is red post-sync.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
// WP-TMP-HYGIENE: this suite creates ~1,400 fixture folders per run and used to leave every one of them
// in the OS temp folder (with doctor, lane and stop-gate re-runs: 325,000 folders, ~21 GB, a full C: drive). Now
// everything it creates — and everything its CLI children create, since they inherit TEMP/TMP/TMPDIR — lands in ONE
// private folder under the real temp dir, removed at exit (see the exit handler below freshDir). Only paths under the
// real temp dir are ever removed.
const TMPH_REAL_TMPDIR = os.tmpdir();
const TMPH_RUN_DIR = fs.mkdtempSync(path.join(TMPH_REAL_TMPDIR, 'forge-run-fsync-'));
process.env.TEMP = TMPH_RUN_DIR; process.env.TMP = TMPH_RUN_DIR; process.env.TMPDIR = TMPH_RUN_DIR;
process.env.FORGE_SYNC_TEST_HOOKS = '1'; // __throwAfter is gated behind this env var in production code
// a real CLI `install` now runs quiesce-check first. Every CLI child of this suite inherits a fake, empty process
// list and an empty stand-in for ~/.claude/projects, so the suite never lists this machine's processes or reads its real
// session folders (both seams are honoured ONLY under FORGE_SYNC_TEST_HOOKS=1). Section 94 overrides them per call.
process.env.FORGE_SYNC_TEST_PROCESS_LIST = '[]';
process.env.FORGE_SYNC_TEST_PROJECTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fsync-fake-claude-projects-'));
// WP-SYNC-R7: a CLI install also consults the git history of the development tree its own forge-sync.cjs lives in (THIS repo).
// Every CLI child of this suite gets an empty list instead (honoured only under FORGE_SYNC_TEST_HOOKS=1), so the suite never
// reads this repo's git history; section 143 overrides it per call with a fixture development tree.
process.env.FORGE_SYNC_TEST_DEV_DIRS = '[]';
const sync = require('./forge-sync.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const CLI = path.join(__dirname, 'forge-sync.cjs');
const ALL_FIXTURE_ROOTS = []; // addendum G proof: every fixture dir this suite ever creates, tracked for real
function freshDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); ALL_FIXTURE_ROOTS.push(d); return d; }
/** tmphUnderRealTmp(p) — true only for a path strictly inside the real OS temp folder (never the folder itself). */
function tmphUnderRealTmp(p) {
  const rel = path.relative(TMPH_REAL_TMPDIR, path.resolve(String(p || '')));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
// WP-TMP-HYGIENE: at exit remove every recorded fixture outside the private run folder (normally none), then the run
// folder itself. Errors are tolerated (a file still locked by AV must never turn the tally red).
process.on('exit', () => {
  const inRun = (d) => { const rel = path.relative(TMPH_RUN_DIR, path.resolve(d)); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  for (const d of ALL_FIXTURE_ROOTS.filter((x) => !inRun(x)).concat([TMPH_RUN_DIR])) {
    if (!tmphUnderRealTmp(d)) continue;
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* tolerated */ }
  }
});
function runCLI(argv, opts) { return spawnSync(process.execPath, [CLI, ...argv], Object.assign({ encoding: 'utf8' }, opts || {})); }
// runCLIWithTemplate — for CLI commands that read system-file content (install/sync-all), FORGE_SYNC_TEMPLATE_DIR
// MUST be overridden to a fixture dir; otherwise the CLI falls back to the REAL global/repo template and a
// "hermetic" test would silently sync real production system files into a throwaway fixture project.
function runCLIWithTemplate(argv, tpl, opts) {
  return runCLI(argv, Object.assign({}, opts || {}, { env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tpl }) }));
}

// writeDoctorStub — a fake forge-doctor.cjs that honors the REAL --json evidence CONTRACT (H4): it always
// emits a structured {ok, checks:{node_check,tests}} object on --json so runValidation()'s evidence gate
// (node_check.total>=synced-files, tests.suites>0, tests.passed>0) is satisfied by default. By DEFAULT the
// sub-checks mirror exitCode (a "failing" stub reports node_check.ok:false, simulating "the file(s) I just
// synced are themselves broken" — the unconditional hard gate), which is what every existing exitCode:1
// fixture in this suite actually means; opts lets a specific test override individual fields.
function writeDoctorStub(projectDir, exitCode, extraJs, opts) {
  opts = opts || {};
  const dir = path.join(projectDir, '.claude', 'forge-bin');
  fs.mkdirSync(dir, { recursive: true });
  const totalCjs = opts.totalCjs != null ? opts.totalCjs : 50;
  const suites = opts.suites != null ? opts.suites : 5;
  const passedTests = opts.passed != null ? opts.passed : 20;
  const nodeCheckOk = opts.nodeCheckOk != null ? opts.nodeCheckOk : (exitCode === 0);
  const testsOk = opts.testsOk != null ? opts.testsOk : (exitCode === 0);
  const jsonObj = {
    ok: exitCode === 0,
    checks: {
      node_check: { ok: nodeCheckOk, total: totalCjs, failed: nodeCheckOk ? 0 : 1 },
      tests: { ok: testsOk, suites, passed: passedTests, failed: testsOk ? 0 : 1 },
    },
  };
  const src = [
    '#!/usr/bin/env node',
    extraJs || '',
    'var __args = process.argv.slice(2);',
    'if (__args.indexOf("--json") !== -1) { console.log(' + JSON.stringify(JSON.stringify(jsonObj)) + '); }',
    'process.exit(' + exitCode + ');',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'forge-doctor.cjs'), src, 'utf8');
}
function makeProject(root, name, doctorExit) {
  const p = path.join(root, name);
  fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
  if (doctorExit != null) writeDoctorStub(p, doctorExit);
  return p;
}

// ---- section 63 (wp4 canary fix) helpers ----
// writeStubLogEvent — a MINIMAL, fully hermetic stand-in for forge-dashboard/log-event.cjs: same CLI shape
// (<run_id> <event_type> [json]) and the same "resolve forge-runs/ relative to the SCRIPT'S OWN location, not
// cwd" contract seedCanaryRun's doc comment relies on, but WITHOUT the real file's strict-mode vocabulary
// machinery — this section is testing seedCanaryRun's OWN mechanics (does it spawn the right command, does it
// report ok based on the real exit code, does the resulting events.jsonl really land under the JUST-SYNCED
// project's own forge-runs/), not re-testing log-event.cjs itself (that has its own dedicated test file).
function writeStubLogEvent(dashboardDir) {
  fs.mkdirSync(dashboardDir, { recursive: true });
  const src = [
    '#!/usr/bin/env node',
    'var fs = require("fs"), path = require("path");',
    'var CLAUDE_DIR = path.resolve(__dirname, "..");',
    'var args = process.argv.slice(2);',
    'var runId = args[0], eventType = args[1];',
    'if (!runId || !eventType) { console.error("run_id/event_type required"); process.exit(1); }',
    'var extra = {};',
    'if (args[2]) { try { extra = JSON.parse(args[2]); } catch (e) { console.error("bad json"); process.exit(1); } }',
    'var ev = Object.assign({ run_id: runId, event_type: eventType, timestamp: new Date().toISOString() }, extra);',
    'var runDir = path.join(CLAUDE_DIR, "forge-runs", runId);',
    'fs.mkdirSync(runDir, { recursive: true });',
    'fs.appendFileSync(path.join(runDir, "events.jsonl"), JSON.stringify(ev) + "\\n");',
    'process.exit(0);',
  ].join('\n');
  fs.writeFileSync(path.join(dashboardDir, 'log-event.cjs'), src, 'utf8');
}
// writeTrioStubs(tplDir) — R3 / SYNC-13: a template that ships log-event.cjs must also ship the other two
// members of the coupled completion trio (forge-verify.cjs, forge-runcontract.cjs), or forge-sync now refuses it. A
// fixture template that only needs the log-event stub gets two minimal, parse-clean companions.
function writeTrioStubs(tplDir) {
  fs.mkdirSync(path.join(tplDir, 'forge-bin'), { recursive: true });
  for (const n of ['forge-verify.cjs', 'forge-runcontract.cjs']) fs.writeFileSync(path.join(tplDir, 'forge-bin', n), '// fixture stub (coupled trio member)\nmodule.exports = {};\n', 'utf8');
}
// writeRequiresRealRunDoctor — a small, deterministic repro of the EXACT real-world defect class (2026-07-26,
// forge-capabilities-panel.test.cjs's genuine "at least one real run with events.jsonl exists" precondition):
// reports tests.ok true ONLY when <root>/.claude/forge-runs/ contains at least one directory with a real
// events.jsonl file. opts.alsoBreakNodeCheck simulates a template that is ALSO genuinely broken for an
// unrelated reason, to prove seeding a run never masks a real regression.
function writeRequiresRealRunDoctor(dir, opts) {
  opts = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  const src = [
    '#!/usr/bin/env node',
    'var fs = require("fs"), path = require("path");',
    'var args = process.argv.slice(2);',
    'var ri = args.indexOf("--root"); var root = ri !== -1 ? args[ri + 1] : process.cwd();',
    'var runsDir = path.join(root, ".claude", "forge-runs");',
    'var hasReal = false;',
    'try { var ents = fs.readdirSync(runsDir, { withFileTypes: true }); hasReal = ents.some(function (e) { return e.isDirectory() && fs.existsSync(path.join(runsDir, e.name, "events.jsonl")); }); } catch (e) {}',
    'var nodeCheckOk = ' + (opts.alsoBreakNodeCheck ? 'false' : 'true') + ';',
    'var testsOk = hasReal;',
    'var overallOk = nodeCheckOk && testsOk;',
    'if (args.indexOf("--json") !== -1) { console.log(JSON.stringify({ ok: overallOk, checks: { node_check: { ok: nodeCheckOk, total: 50, failed: nodeCheckOk ? 0 : 1 }, tests: { ok: testsOk, suites: 1, passed: hasReal ? 5 : 4, failed: testsOk ? 0 : 1 } } })); }',
    'process.exit(overallOk ? 0 : 1);',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'forge-doctor.cjs'), src, 'utf8');
}
function makeRealProjectMarker(projectDir) { // findForgeProjects() only counts a dir with .claude/forge-dashboard
  fs.mkdirSync(path.join(projectDir, '.claude', 'forge-dashboard'), { recursive: true });
}
function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { out[p] = fs.readFileSync(p).toString('hex'); } catch { /* unreadable, skip */ } }
    }
  };
  walk(dir);
  return out;
}
function fakeReceiptMatchingCurrent(projectDir, relHashPairs) { // pretend "we last wrote exactly this" for each rel
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  sync.writeReceipt(projectDir, { filesChanged: relHashPairs.map(([rel, newHash]) => ({ rel, oldHash: null, newHash })) });
}

console.log('forge-sync.cjs offline tests (hermetic — os.tmpdir() fixtures ONLY, never the real 12 projects)');

// =====================================================================================
// 1) DRY-RUN WRITES NOTHING
// =====================================================================================
console.log('\n1) dry-run writes nothing');
{
  const tpl = freshDir('t1-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  const root = freshDir('t1-root');
  const pA = makeProject(root, 'projA', 0);
  const pB = makeProject(root, 'projB', 0);
  makeRealProjectMarker(pA); makeRealProjectMarker(pB);
  const before = snapshotTree(root);
  const r = sync.runSyncAll(tpl, root, { projects: [pA, pB], dryRun: true, batchId: 'dry-b1', nowIso: '2026-01-01T00:00:00.000Z' });
  const after = snapshotTree(root);
  t('dry-run reports ok:true', r.ok === true && r.dryRun === true);
  t('dry-run dedicated-canary plan shows 1 file to change', r.dedicatedCanary.plan.toChange.length === 1);
  t('dry-run per-project plans show 1 file to change each', r.projects.every((p) => p.plan.toChange.length === 1));
  t('NOT ONE byte changed anywhere under the root (dry-run writes nothing)', JSON.stringify(before) === JSON.stringify(after));
  t('no forge-backups dir created anywhere', !Object.keys(after).some((k) => k.includes('forge-backups')));
  t('no receipt file created anywhere', !Object.keys(after).some((k) => k.includes('forge-sync-receipt.json')));
}

// =====================================================================================
// 2) BACKUP CREATED WITH CORRECT OLD HASHES BEFORE ANY OVERWRITE (+ full pre/post manifest, addendum A)
// =====================================================================================
console.log('\n2) backup created with correct old hashes before overwrite (full manifest proof)');
{
  const tpl = freshDir('t2-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2-CONTENT');
  const p = makeProject(freshDir('t2-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1-CONTENT');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]); // legitimate prior sync baseline, not an override
  const preManifest = sync.fullFileManifest(tpl, p);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b2', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeded', r.ok === true);
  t('manifest.files records the OLD hash (v1), not the new one', r.backup.manifest.files[0].oldHash === v1Hash);
  const backupBytes = fs.readFileSync(path.join(r.backup.backupDir, 'forge-bin', 'tool.cjs'), 'utf8');
  t('backup COPY on disk contains the OLD bytes (V1-CONTENT)', backupBytes === 'V1-CONTENT');
  t('project file now contains the NEW bytes (V2-CONTENT) — write happened after backup', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V2-CONTENT');
  t('preManifest (returned) shows the OLD hash for this file', r.preManifest['forge-bin/tool.cjs'].hash === v1Hash);
  t('postManifest (returned) shows the NEW hash for this file', r.postManifest['forge-bin/tool.cjs'].hash === sync.sha256(path.join(tpl, 'forge-bin', 'tool.cjs')));
  // rollback + full-manifest byte-exact proof (addendum A: compare the FULL manifest, not just exit code)
  const rb = sync.rollbackProject(p, 'b2', {});
  t('rollback reports ok:true', rb.ok === true);
  const postRollbackManifest = sync.fullFileManifest(tpl, p);
  t('FULL manifest is byte-identical pre-sync vs post-rollback (not just "rollback exited ok")', JSON.stringify(preManifest) === JSON.stringify(postRollbackManifest));
}

// =====================================================================================
// 3) TWO-STAGE CANARY ORDERING: dedicated canary runs FIRST, before any real project write
// =====================================================================================
console.log('\n3) dedicated canary syncs first; real projects untouched at that moment (addendum B)');
{
  const tpl = freshDir('t3-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-TEMPLATE-CONTENT');
  const root = freshDir('t3-root');
  const real1 = makeProject(root, 'real1', 0);
  makeRealProjectMarker(real1);
  fs.mkdirSync(path.join(real1, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(real1, '.claude', 'forge-bin', 'tool.cjs'), 'OLD-REAL-CONTENT');
  const oldHash = sync.sha256(path.join(real1, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(real1, [['forge-bin/tool.cjs', oldHash]]);
  // the dedicated canary's own doctor snapshots real1's file content AT THE MOMENT it validates
  const snapshotFile = path.join(root, 'snapshot-at-canary-validation.txt');
  const dedicated = sync.dedicatedCanaryDir(root);
  const canaryDoctorSrc = path.join(root, 'canary-doctor.cjs');
  const realFileTarget = path.join(real1, '.claude', 'forge-bin', 'tool.cjs');
  fs.writeFileSync(canaryDoctorSrc, [
    '#!/usr/bin/env node',
    'var fs = require("fs");',
    'var content; try { content = fs.readFileSync(' + JSON.stringify(realFileTarget) + ', "utf8"); } catch (e) { content = "<missing>"; }',
    'fs.writeFileSync(' + JSON.stringify(snapshotFile) + ', content);',
    'var __args = process.argv.slice(2);',
    'if (__args.indexOf("--json") !== -1) { console.log(JSON.stringify({ ok: true, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 } } })); }',
    'process.exit(0);',
  ].join('\n'));
  const r = sync.runSyncAll(tpl, root, { projects: [real1], canaryDoctorSource: canaryDoctorSrc, batchId: 'b3', nowIso: '2026-01-01T00:00:00.000Z' });
  t('overall batch ok', r.ok === true);
  t('dedicated canary directory exists and is dot-prefixed', fs.existsSync(dedicated) && path.basename(dedicated) === '.forge-canary');
  const snapshotContent = fs.readFileSync(snapshotFile, 'utf8');
  t('AT the moment the dedicated canary validated, real1 still had its OLD content (proves canary-first ordering)', snapshotContent === 'OLD-REAL-CONTENT');
  t('by the time the whole batch finished, real1 DID get synced to the new content', fs.readFileSync(realFileTarget, 'utf8') === 'NEW-TEMPLATE-CONTENT');
}

// =====================================================================================
// 4) DEDICATED CANARY VALIDATION FAILS -> canary rolled back, batch ABORTS, real projects byte-untouched
//    (this is the core proof required by both the original spec and addendum F4)
// =====================================================================================
console.log('\n4) dedicated canary fails validation -> rolled back + batch aborted + real projects untouched');
{
  const tpl = freshDir('t4-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
  const root = freshDir('t4-root');
  const real1 = makeProject(root, 'real1', 0); makeRealProjectMarker(real1);
  const real2 = makeProject(root, 'real2', 0); makeRealProjectMarker(real2);
  const doctorNeverRanMarker = path.join(root, 'real-doctor-ran.marker');
  writeDoctorStub(real1, 0, 'require("fs").writeFileSync(' + JSON.stringify(doctorNeverRanMarker) + ', "ran");');
  const beforeReal1 = snapshotTree(real1);
  const beforeReal2 = snapshotTree(real2);
  const failDoctorSrc = path.join(root, 'fail-doctor.cjs');
  fs.writeFileSync(failDoctorSrc, '#!/usr/bin/env node\nvar __a=process.argv.slice(2);if(__a.indexOf("--json")!==-1){console.log(JSON.stringify({ok:false,checks:{node_check:{ok:false,total:50,failed:1},tests:{ok:true,suites:5,passed:20,failed:0}}}));}\nprocess.exit(1);\n');
  const r = sync.runSyncAll(tpl, root, { projects: [real1, real2], canaryDoctorSource: failDoctorSrc, batchId: 'b4', nowIso: '2026-01-01T00:00:00.000Z' });
  t('batch reports ok:false', r.ok === false);
  t('batch reports aborted:true at stage dedicated-canary', r.aborted === true && r.stage === 'dedicated-canary');
  t('dedicated canary result itself is not ok (validation failed)', r.dedicatedCanary.ok === false);
  t('dedicated canary was rolled back (no leftover half-applied file)', r.dedicatedCanary.rolledBack === true);
  t('real1 is COMPLETELY byte-untouched', JSON.stringify(snapshotTree(real1)) === JSON.stringify(beforeReal1));
  t('real2 is COMPLETELY byte-untouched', JSON.stringify(snapshotTree(real2)) === JSON.stringify(beforeReal2));
  t('real1 doctor was NEVER invoked (batch aborted before reaching any real project)', !fs.existsSync(doctorNeverRanMarker));
  t('no forge-backups dir was ever created for real1 (never started)', !fs.existsSync(path.join(sync.claudeDirOf(real1), 'forge-backups')));
}

// =====================================================================================
// 5) CANARY PASSES -> staged rollout; a MID-BATCH validation failure rolls that project back and STOPS
//    the batch (later projects untouched) — original spec item + addendum F5
// =====================================================================================
console.log('\n5) canary passes; representative passes; a later project fails -> rolled back + batch stops');
{
  const tpl = freshDir('t5-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
  const root = freshDir('t5-root');
  const rep = makeProject(root, 'rep', 0); makeRealProjectMarker(rep);
  const bad = makeProject(root, 'bad', 1); makeRealProjectMarker(bad); // will FAIL validation
  const later = makeProject(root, 'later', 0); makeRealProjectMarker(later);
  const laterDoctorRanMarker = path.join(root, 'later-doctor-ran.marker');
  writeDoctorStub(later, 0, 'require("fs").writeFileSync(' + JSON.stringify(laterDoctorRanMarker) + ', "ran");');
  const beforeLater = snapshotTree(later);
  const r = sync.runSyncAll(tpl, root, { projects: [rep, bad, later], canaryName: 'rep', batchId: 'b5', nowIso: '2026-01-01T00:00:00.000Z' });
  t('batch reports ok:false, aborted:true', r.ok === false && r.aborted === true);
  t('dedicated canary + representative both succeeded', r.dedicatedCanary.ok === true && r.representative.ok === true);
  t('representative got a real FORGE_VERSION.json stamp', fs.existsSync(sync.versionFilePath(rep)));
  const badResult = r.projects.find((pr) => pr.projectDir === bad);
  t('the failing project reports ok:false', badResult && badResult.ok === false);
  t('the failing project was rolled back (file reverted, no FORGE_VERSION stamp)', badResult.rolledBack === true && !fs.existsSync(sync.versionFilePath(bad)));
  t('the failing project has no forge-sync-receipt.json (sync never counted as complete)', !fs.existsSync(sync.receiptPath(bad)));
  t('the LATER project (after the failure) is COMPLETELY byte-untouched', JSON.stringify(snapshotTree(later)) === JSON.stringify(beforeLater));
  t('the LATER project doctor was NEVER invoked (batch stopped before reaching it)', !fs.existsSync(laterDoctorRanMarker));
}

// =====================================================================================
// 6) ROLLBACK RESTORES EXACT PREVIOUS BYTES (hash-compare) + FORGE_VERSION.json restored/removed correctly
//    — via the REAL CLI command (must really work)
// =====================================================================================
console.log('\n6) rollback CLI restores exact bytes + FORGE_VERSION.json correctly (both had-version and no-version cases)');
{
  // 6a) project HAD a FORGE_VERSION.json before this sync -> rollback must restore it byte-exact
  const tpl = freshDir('t6a-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t6a-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  const priorVersionContent = JSON.stringify({ forge_version: 'PRIOR-VERSION-MARKER' }, null, 2) + '\n';
  fs.writeFileSync(sync.versionFilePath(p), priorVersionContent, 'utf8');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b6a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeded and overwrote FORGE_VERSION.json', r.ok === true && fs.readFileSync(sync.versionFilePath(p), 'utf8') !== priorVersionContent);
  const cliResult = runCLI(['rollback', p, '--batch', 'b6a']);
  t('rollback CLI exits 0', cliResult.status === 0);
  t('file content restored to exact original bytes (V1)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V1');
  t('FORGE_VERSION.json restored to the EXACT prior content (byte-for-byte)', fs.readFileSync(sync.versionFilePath(p), 'utf8') === priorVersionContent);

  // 6b) project had NO FORGE_VERSION.json before this sync -> rollback must REMOVE it entirely
  const tpl2 = freshDir('t6b-tpl');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'tool.cjs'), 'V2');
  const p2 = makeProject(freshDir('t6b-root'), 'proj', 0);
  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b6b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeded and created a FORGE_VERSION.json (project had none before)', r2.ok === true && fs.existsSync(sync.versionFilePath(p2)));
  const rb2 = sync.rollbackProject(p2, 'b6b', {});
  t('rollback ok', rb2.ok === true);
  t('FORGE_VERSION.json REMOVED entirely (it never existed pre-sync)', !fs.existsSync(sync.versionFilePath(p2)));
  t('the added file is gone too (rolled back to pre-sync non-existence)', !fs.existsSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')));
}

// =====================================================================================
// 7) ROLLBACK-BATCH restores ALL projects of that batch
// =====================================================================================
console.log('\n7) rollback-batch restores every project synced under that batchId');
{
  const tpl = freshDir('t7-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const root = freshDir('t7-root');
  const p1 = makeProject(root, 'p1', 0); makeRealProjectMarker(p1);
  const p2 = makeProject(root, 'p2', 0); makeRealProjectMarker(p2);
  sync.safeSyncProject(tpl, p1, { batchId: 'b7', nowIso: '2026-01-01T00:00:00.000Z' });
  sync.safeSyncProject(tpl, p2, { batchId: 'b7', nowIso: '2026-01-01T00:00:00.000Z' });
  t('both projects synced (added file present)', fs.existsSync(path.join(p1, '.claude', 'forge-bin', 'tool.cjs')) && fs.existsSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')));
  const cliResult = runCLI(['rollback-batch', 'b7', root]);
  t('rollback-batch CLI exits 0', cliResult.status === 0);
  t('p1 rolled back (added file removed)', !fs.existsSync(path.join(p1, '.claude', 'forge-bin', 'tool.cjs')));
  t('p2 rolled back (added file removed)', !fs.existsSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')));
  t('rollback-batch stdout mentions both projects', /p1/.test(cliResult.stdout) && /p2/.test(cliResult.stdout));
}

// =====================================================================================
// 8) LOCAL OVERRIDE (unknown_drift, no receipt yet) is NOT silently overwritten; --force-overwrite DOES
//    overwrite it, but still backs it up first
// =====================================================================================
console.log('\n8) drift/local-override not silently overwritten; --force-overwrite overwrites + still backs up');
{
  const tpl = freshDir('t8-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'TEMPLATE-V2');
  const p = makeProject(freshDir('t8-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'HAND-EDITED-LOCAL-CONTENT');
  // no receipt at all yet -> conservative default classifies this as unknown_drift, not a plain update.
  // H2: unresolved drift with nothing safe to change is BLOCKED (ok:false), not a silent "up to date" noop.
  const noForce = sync.safeSyncProject(tpl, p, { batchId: 'b8a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('no-force sync reports ok:false, blocked:true (H2 — was wrongly ok:true/noop before the fix)', noForce.ok === false && noForce.blocked === true && noForce.noop !== true);
  t('the file is classified as unknownDrift, not toChange', noForce.plan.unknownDrift.includes('forge-bin/tool.cjs') && noForce.plan.toChange.length === 0);
  t('the hand-edited file is completely UNTOUCHED', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'HAND-EDITED-LOCAL-CONTENT');
  t('no backup/receipt created for a pure noop', !fs.existsSync(sync.receiptPath(p)));

  const forced = sync.safeSyncProject(tpl, p, { batchId: 'b8b', forceOverwrite: true, nowIso: '2026-01-01T00:00:00.000Z' });
  t('--force-overwrite sync succeeds', forced.ok === true);
  t('file now has the template content (overwritten)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'TEMPLATE-V2');
  t('the forced entry is tagged overrideClass:unknown_drift for reporting', forced.plan.toChange[0].overrideClass === 'unknown_drift');
  const backupFile = path.join(forced.backup.backupDir, 'forge-bin', 'tool.cjs');
  t('the hand-edited bytes were BACKED UP before being overwritten', fs.existsSync(backupFile) && fs.readFileSync(backupFile, 'utf8') === 'HAND-EDITED-LOCAL-CONTENT');
  t('unknownDriftSkipped is empty in the resulting receipt (nothing left skipped — it was forced through)', forced.receipt.overridesPreserved.unknownDriftSkipped.length === 0);
}

// =====================================================================================
// 9) RECEIPT has the extended fields (addendum E); failed validation gets NO FORGE_VERSION stamp
// =====================================================================================
console.log('\n9) receipt has extended fields; failed validation gets no FORGE_VERSION + no receipt');
{
  const tpl = freshDir('t9-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'CONTENT');
  const pOk = makeProject(freshDir('t9-ok-root'), 'proj', 0);
  const rOk = sync.safeSyncProject(tpl, pOk, { batchId: 'b9ok', nowIso: '2026-01-01T00:00:00.000Z', runId: 'forge-2026-07-14-hardening', centralBackupRoot: freshDir('t9-hub') });
  t('success case: ok:true', rOk.ok === true);
  const receiptOnDisk = JSON.parse(fs.readFileSync(sync.receiptPath(pOk), 'utf8'));
  const requiredFields = ['projectId', 'projectPath', 'batchId', 'runId', 'templateVersionFrom', 'templateVersionTo', 'backupRef', 'preSyncManifestHash', 'postSyncManifestHash', 'filesChanged', 'overridesPreserved', 'validation', 'rollbackStatus', 'syncedAt'];
  t('receipt contains every extended field required by addendum E', requiredFields.every((k) => Object.prototype.hasOwnProperty.call(receiptOnDisk, k)));
  t('receipt validation sub-object records tool/exitCode/ok/commands', receiptOnDisk.validation.tool && typeof receiptOnDisk.validation.exitCode === 'number' && receiptOnDisk.validation.ok === true && Array.isArray(receiptOnDisk.validation.commands));
  t('receipt runId matches what was passed in', receiptOnDisk.runId === 'forge-2026-07-14-hardening');
  t('receipt backupRef.central is populated (centralBackupRoot was given)', !!receiptOnDisk.backupRef.central);

  const pFail = makeProject(freshDir('t9-fail-root'), 'proj', 1); // doctor exits 1
  const rFail = sync.safeSyncProject(tpl, pFail, { batchId: 'b9fail', nowIso: '2026-01-01T00:00:00.000Z' });
  t('failure case: ok:false', rFail.ok === false);
  t('failed validation -> NO FORGE_VERSION.json stamp', !fs.existsSync(sync.versionFilePath(pFail)));
  t('failed validation -> NO forge-sync-receipt.json written at all', !fs.existsSync(sync.receiptPath(pFail)));
  t('failed validation -> the added file was rolled back to non-existence', !fs.existsSync(path.join(pFail, '.claude', 'forge-bin', 'tool.cjs')));
}

// =====================================================================================
// 10) USAGE ERRORS -> exit 2; a dir without .claude/ is refused (never resolves to a real path by default)
// =====================================================================================
console.log('\n10) usage errors exit 2; missing .claude/ is refused; missing project path is refused');
{
  t('no subcommand args for install -> exit 2', runCLI(['install']).status === 2);
  t('rollback with no projectDir -> exit 2', runCLI(['rollback']).status === 2);
  t('rollback-batch with no batchId -> exit 2', runCLI(['rollback-batch']).status === 2);
  t('unknown command -> exit 2', runCLI(['bogus-command']).status === 2);

  const noClaudeDir = freshDir('t10-no-claude'); // exists on disk, but has no .claude/ subdir
  const cliInstall = runCLI(['install', noClaudeDir]);
  t('install against a dir with no .claude/ is refused (non-zero, not a crash)', cliInstall.status !== 0 && cliInstall.status !== null);
  t('refusal message names the missing .claude/', /\.claude missing/.test(cliInstall.stdout + cliInstall.stderr));

  const missingPath = path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now());
  const r = sync.safeSyncProject(freshDir('t10-tpl'), missingPath, { batchId: 'x' });
  t('safeSyncProject on a wholly missing project path refuses honestly (addendum F3)', r.ok === false && r.refused === true && /project path missing/.test(r.reason));
  const rb = sync.rollbackProject(missingPath, 'x', {});
  t('rollbackProject on a wholly missing project path refuses honestly, not a crash', rb.ok === false && /project path missing/.test(rb.reason));
}

// =====================================================================================
// 11) canary-init CLI command creates the dedicated canary and it is excluded from discovery
// =====================================================================================
console.log('\n11) canary-init creates the dedicated canary; findForgeProjects never counts it');
{
  const root = freshDir('t11-root');
  const real1 = makeProject(root, 'real1', 0); makeRealProjectMarker(real1);
  const r = runCLI(['canary-init', root]);
  t('canary-init CLI exits 0', r.status === 0);
  const dedicated = sync.dedicatedCanaryDir(root);
  t('dedicated canary dir was created', fs.existsSync(dedicated));
  t('dedicated canary carries a FORGE_CANARY_MARKER.json', fs.existsSync(path.join(dedicated, '.claude', 'FORGE_CANARY_MARKER.json')));
  // give the (dot-prefixed) canary the discovery marker too, to prove exclusion is structural, not incidental
  makeRealProjectMarker(dedicated);
  const discovered = sync.findForgeProjects(root);
  t('findForgeProjects finds real1 but NEVER the dedicated canary (dot-prefix exclusion)', discovered.includes(real1) && !discovered.some((d) => path.resolve(d) === path.resolve(dedicated)));
}

// =====================================================================================
// 12) CENTRAL BACKUP INDEPENDENCE (addendum C): a valid restore even when the project's OWN backup dir is
//     gone/damaged, by falling back to the central backup; corrupt/missing backup REFUSES (not fabricated)
// =====================================================================================
console.log('\n12) central backup independence + damaged-project restore + refuse-on-corrupt (addendum C, F7)');
{
  const tpl = freshDir('t12-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'g.cjs'), 'NEW-CENTRAL-TEST');
  const p = makeProject(freshDir('t12-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'g.cjs'), 'OLD-CENTRAL-TEST');
  const oldHash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'g.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/g.cjs', oldHash]]);
  const hub = freshDir('t12-hub');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b12', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub, runId: 'forge-2026-07-14-hardening' });
  t('sync ok', r.ok === true);
  t('a central backup manifest was written, distinct from the per-project one', fs.existsSync(path.join(r.backup.centralDir, 'manifest.json')) && r.backup.centralDir !== r.backup.backupDir);
  t('central manifest carries projectId/projectPath/runId/templateVersion', JSON.parse(fs.readFileSync(path.join(r.backup.centralDir, 'manifest.json'), 'utf8')).projectId === sync.projectId(p));

  // simulate the project folder being PARTIALLY DAMAGED: delete its own forge-backups AND forge-bin dir entirely
  fs.rmSync(path.join(sync.claudeDirOf(p), 'forge-backups'), { recursive: true, force: true });
  fs.rmSync(path.join(sync.claudeDirOf(p), 'forge-bin'), { recursive: true, force: true });
  t('project is now partially damaged (both dirs gone)', !fs.existsSync(path.join(sync.claudeDirOf(p), 'forge-backups')) && !fs.existsSync(path.join(sync.claudeDirOf(p), 'forge-bin')));
  const rb = sync.rollbackProject(p, 'b12', { centralBackupRoot: hub });
  t('rollback still succeeds via the CENTRAL backup despite project damage', rb.ok === true && rb.source === 'central');
  t('the restored file has the exact pre-sync bytes', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'g.cjs'), 'utf8') === 'OLD-CENTRAL-TEST');

  // corrupt BOTH project-local and central backups -> rollback must REFUSE, never fabricate "restored"
  const tpl2 = freshDir('t12b-tpl');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'h.cjs'), 'NEW2');
  const p2 = makeProject(freshDir('t12b-root'), 'proj2', 0);
  fs.mkdirSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p2, '.claude', 'forge-bin', 'h.cjs'), 'OLD2');
  const oldHash2 = sync.sha256(path.join(p2, '.claude', 'forge-bin', 'h.cjs'));
  fakeReceiptMatchingCurrent(p2, [['forge-bin/h.cjs', oldHash2]]);
  const hub2 = freshDir('t12b-hub');
  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b12b', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub2 });
  t('second sync ok', r2.ok === true);
  fs.writeFileSync(path.join(r2.backup.backupDir, 'forge-bin', 'h.cjs'), 'TAMPERED-PROJECT');
  fs.writeFileSync(path.join(r2.backup.centralDir, 'forge-bin', 'h.cjs'), 'TAMPERED-CENTRAL');
  const rbCorrupt = sync.rollbackProject(p2, 'b12b', { centralBackupRoot: hub2 });
  t('rollback REFUSES when BOTH backups are corrupt (never fabricates "restored")', rbCorrupt.ok === false && /corrupt|no valid/.test(rbCorrupt.reason));
  t('the project file is left exactly as it was (no partial/garbage restore attempted)', fs.readFileSync(path.join(p2, '.claude', 'forge-bin', 'h.cjs'), 'utf8') === 'NEW2');
}

// =====================================================================================
// 13) 3-CLASS OVERRIDE CLASSIFICATION (addendum D): expected_override / unknown_drift / conflict
// =====================================================================================
console.log('\n13) 3-class override classification: expected_override, unknown_drift, conflict');
{
  const tpl = freshDir('t13-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'conflict.cjs'), 'TEMPLATE_V2');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'drift.cjs'), 'TEMPLATE_UNCHANGED');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'override.cjs'), 'TEMPLATE_NEW');
  const p = makeProject(freshDir('t13-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(p, '.claude', 'config'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'conflict.cjs'), 'PROJECT_CHANGED');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'drift.cjs'), 'PROJECT_CHANGED_2');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'override.cjs'), 'PROJECT_OWNED_FOREVER');
  fs.writeFileSync(path.join(p, '.claude', 'config', 'forge-overrides.json'), JSON.stringify({ overrides: ['forge-bin/override.cjs'] }));
  const crypto = require('crypto');
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  sync.writeReceipt(p, { filesChanged: [
    { rel: 'forge-bin/conflict.cjs', oldHash: null, newHash: h('TEMPLATE_V1') }, // template WAS V1, now V2 (changed) + project changed -> conflict
    { rel: 'forge-bin/drift.cjs', oldHash: null, newHash: sync.sha256(path.join(tpl, 'forge-bin', 'drift.cjs')) }, // template unchanged, project changed -> drift
  ] });
  const plan = sync.buildPlan(tpl, p, {});
  t('conflict.cjs correctly classified as a CONFLICT (both sides changed)', plan.conflicts.includes('forge-bin/conflict.cjs'));
  t('drift.cjs correctly classified as UNKNOWN_DRIFT (only project changed)', plan.unknownDrift.includes('forge-bin/drift.cjs'));
  t('override.cjs correctly classified as EXPECTED_OVERRIDE (declared in allow-list)', plan.expectedOverrides.includes('forge-bin/override.cjs'));
  t('none of the 3 land in toChange without --force-overwrite', plan.toChange.length === 0);

  const forced = sync.buildPlan(tpl, p, { forceOverwrite: true });
  t('--force-overwrite forces conflict + unknown_drift through', forced.toChange.some((e) => e.rel === 'forge-bin/conflict.cjs') && forced.toChange.some((e) => e.rel === 'forge-bin/drift.cjs'));
  t('--force-overwrite NEVER touches an expected_override (allow-list is stronger than force)', forced.expectedOverrides.includes('forge-bin/override.cjs') && !forced.toChange.some((e) => e.rel === 'forge-bin/override.cjs'));

  // sync-all must STOP the whole batch when an unresolved conflict/drift is present (without --force-overwrite)
  const root2 = freshDir('t13-batch-root');
  makeRealProjectMarker(p);
  const runAll = sync.runSyncAll(tpl, root2, { projects: [p], canaryName: 'proj', batchId: 'b13', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync-all reports ok:false when the representative project has unresolved drift/conflict', runAll.ok === false);
}

// =====================================================================================
// 14) FAILURE CASE F1: write aborts halfway through a batch (simulated throw mid-copy)
// =====================================================================================
console.log('\n14) F1: write aborts halfway (simulated throw mid-copy) -> rolled back, batch stopped');
{
  const tpl = freshDir('t14-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B-NEW');
  const p = makeProject(freshDir('t14-root'), 'proj', 0);
  let copyCount = 0;
  const throwingCopy = (src, dst) => { copyCount++; if (copyCount === 2) throw new Error('SIMULATED write failure (test injection)'); return fs.copyFileSync(src, dst); };
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b14', nowIso: '2026-01-01T00:00:00.000Z', copyFileImpl: throwingCopy });
  t('sync reports ok:false', r.ok === false);
  t('the injected error message is surfaced', /SIMULATED write failure/.test(r.applyError));
  t('the project was rolled back (no leftover files from the partial apply)', r.rolledBack === true);
  t('neither file exists post-rollback (both were isNew; the one that DID apply got rolled back)', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'a.cjs')) && !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'b.cjs')));
  t('no FORGE_VERSION.json / receipt was ever written', !fs.existsSync(sync.versionFilePath(p)) && !fs.existsSync(sync.receiptPath(p)));
}

// =====================================================================================
// 15) FAILURE CASE F2: locked/unwritable file (real Windows EPERM via chmod 0o444)
// =====================================================================================
console.log('\n15) F2: locked/unwritable file (real EPERM) -> partial rollback, locked file left untouched');
{
  const tpl = freshDir('t15-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'locked.cjs'), 'LOCKED-NEW');
  const p = makeProject(freshDir('t15-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'A-OLD');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'locked.cjs'), 'LOCKED-OLD');
  fakeReceiptMatchingCurrent(p, [
    ['forge-bin/a.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs'))],
    ['forge-bin/locked.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'locked.cjs'))],
  ]);
  const lockedPath = path.join(p, '.claude', 'forge-bin', 'locked.cjs');
  // real-OS probe: confirm chmod 0o444 actually reproduces EPERM on this host before relying on it
  let realLockWorks = false;
  const probe = freshDir('t15-probe');
  const probeFile = path.join(probe, 'x.txt');
  fs.writeFileSync(probeFile, 'orig'); fs.chmodSync(probeFile, 0o444);
  // Probe the SAME mechanism the sync uses (stage a temp file, then rename it over the target — see copyNoFollow /
  // writeAtomic). A plain writeFileSync on a 0o444 file fails on every OS, but rename-over-target ignores the
  // target's mode on Linux (only the directory's permissions matter), so the old probe said "real lock" while the
  // real sync sailed through — 8 red assertions on the first Linux CI run. On Windows the read-only
  // attribute makes the rename throw EPERM, so that branch is unchanged.
  try { const probeTmp = probeFile + '.probe.tmp'; fs.writeFileSync(probeTmp, 'new'); fs.renameSync(probeTmp, probeFile); } catch { realLockWorks = true; }
  fs.chmodSync(probeFile, 0o666); fs.rmSync(probe, { recursive: true, force: true });

  let r;
  if (realLockWorks) {
    fs.chmodSync(lockedPath, 0o444);
    r = sync.safeSyncProject(tpl, p, { batchId: 'b15', nowIso: '2026-01-01T00:00:00.000Z' });
    fs.chmodSync(lockedPath, 0o666); // always release the lock before assertions/cleanup
  } else {
    // OS did not reproduce a real lock in this environment — inject the EPERM instead, per addendum F2
    const injectedCopy = (src, dst) => { if (dst === lockedPath) { const e = new Error('EPERM: operation not permitted (injected)'); e.code = 'EPERM'; throw e; } return fs.copyFileSync(src, dst); };
    r = sync.safeSyncProject(tpl, p, { batchId: 'b15', nowIso: '2026-01-01T00:00:00.000Z', copyFileImpl: injectedCopy });
  }
  console.log('     (F2 evidence source: ' + (realLockWorks ? 'REAL OS EPERM via chmod 0o444' : 'INJECTED — OS did not reproduce a real lock in this sandbox') + ')');
  t('sync reports ok:false', r.ok === false);
  t('EPERM is present in the reported error', /EPERM/.test(r.applyError || ''));
  t('rollback of the applied subset succeeded (rolledBack:true, no crash)', r.rolledBack === true);
  t('the free file (a.cjs) is restored to its OLD content', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'A-OLD');
  t('the locked file itself was NEVER actually modified (still OLD content, correctly never "restored")', fs.readFileSync(lockedPath, 'utf8') === 'LOCKED-OLD');
}

// =====================================================================================
// 16) FAILURE CASE F3: project path missing entirely
// =====================================================================================
console.log('\n16) F3: project path missing entirely -> honest refusal (covered in depth in section 10)');
{
  const tpl = freshDir('t16-tpl');
  const missing = path.join(os.tmpdir(), 'forge-sync-f3-missing-' + process.pid);
  const r = sync.safeSyncProject(tpl, missing, { batchId: 'b16' });
  t('safeSyncProject refuses a missing project path (no crash)', r.ok === false && r.refused === true);
  const rb = sync.rollbackProject(missing, 'b16', {});
  t('rollbackProject refuses a missing project path (no crash)', rb.ok === false);
  const rbBatch = sync.rollbackBatch(os.tmpdir(), 'b16', { projects: [missing] });
  t('rollbackBatch silently skips a missing project (no backup dir found there, no crash)', Array.isArray(rbBatch) && rbBatch.length === 0);
}

// =====================================================================================
// 17) FAILURE CASE F4: canary validation fails -> covered in full in section 4 (cross-reference)
// =====================================================================================
console.log('\n17) F4: canary-fail-abort-rollback -> see section 4 (full proof already executed above)');
t('F4 is proven by section 4 (dedicatedCanary rolled back, batch aborted, real projects untouched)', true);

// =====================================================================================
// 18) FAILURE CASE F5: post-sync validation fails on a LATER project -> covered in full in section 5
// =====================================================================================
console.log('\n18) F5: later-project validation failure -> see section 5 (full proof already executed above)');
t('F5 is proven by section 5 (later project rolled back, batch stopped, still-later project untouched)', true);

// =====================================================================================
// 19) FAILURE CASE F6: unknown drift present -> not overwritten -> covered in section 8 + 13
// =====================================================================================
console.log('\n19) F6: unknown drift present -> not overwritten -> see sections 8 and 13');
t('F6 is proven by sections 8 (skip+force-overwrite) and 13 (3-class classification)', true);

// =====================================================================================
// 20) FAILURE CASE F7: backup missing or corrupt -> rollback REFUSES, never fakes "restored"
//     (also proven with central fallback in section 12; here: project-only, no central, backup DIR MISSING)
// =====================================================================================
console.log('\n20) F7: backup dir entirely MISSING (no central fallback configured) -> honest refusal');
{
  const tpl = freshDir('t20-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x.cjs'), 'NEW');
  const p = makeProject(freshDir('t20-root'), 'proj', 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b20', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok', r.ok === true);
  fs.rmSync(path.join(sync.claudeDirOf(p), 'forge-backups'), { recursive: true, force: true }); // simulate the backup being wiped
  const rb = sync.rollbackProject(p, 'b20', {}); // no centralBackupRoot given -> nothing to fall back to
  t('rollback with NO backup and NO central fallback REFUSES (ok:false, honest reason)', rb.ok === false && /no valid|no backup batch/.test(rb.reason));
  t('the synced file is left exactly as it is (no fabricated partial restore)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'x.cjs'), 'utf8') === 'NEW');
}

// =====================================================================================
// 21) FAILURE CASE F8: rollback itself interrupted -> journal makes it resumable/idempotent
// =====================================================================================
console.log('\n21) F8: rollback interrupted mid-way -> resumable via journal -> end state byte-exact');
{
  const tpl = freshDir('t21-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x1.cjs'), 'X1-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x2.cjs'), 'X2-NEW');
  const p = makeProject(freshDir('t21-root'), 'proj', 0);
  const preManifest = sync.fullFileManifest(tpl, p);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b21', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok, both files added', r.ok === true && r.plan.toChange.length === 2);
  const rb1 = sync.rollbackProject(p, 'b21', { __throwAfter: 1 });
  t('first rollback call reports interrupted:true (simulated)', rb1.ok === false && rb1.interrupted === true);
  const oneRestored = !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'x1.cjs'));
  const oneStillPresent = fs.existsSync(path.join(p, '.claude', 'forge-bin', 'x2.cjs'));
  t('exactly one file was restored before the simulated interruption, the other is untouched so far', oneRestored && oneStillPresent);
  const rb2 = sync.rollbackProject(p, 'b21', {}); // resume, no throw this time
  t('second (resuming) rollback call succeeds', rb2.ok === true);
  const postManifest = sync.fullFileManifest(tpl, p);
  t('end state is BYTE-EXACT vs the original pre-sync manifest (resumable rollback proven)', JSON.stringify(preManifest) === JSON.stringify(postManifest));
  const journal = JSON.parse(fs.readFileSync(sync.journalPath(sync.backupDirFor(p, 'b21')), 'utf8'));
  t('journal ends in status:complete', journal.status === 'complete');
}

// =====================================================================================
// 22) FAILURE CASE F9: project with a deviating structure (no forge-bin dir at all; extra unrelated dirs)
// =====================================================================================
console.log('\n22) F9: deviating project structure (no forge-bin dir; extra unrelated dirs) -> handled, not crashed');
{
  const tpl = freshDir('t22-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t22-root'), 'proj', 0); // only .claude/ + doctor stub, NO forge-bin dir at all
  fs.mkdirSync(path.join(p, '.claude', 'some-totally-unrelated-dir'), { recursive: true }); // extra dir sync must ignore
  fs.writeFileSync(path.join(p, '.claude', 'some-totally-unrelated-dir', 'notes.txt'), 'do not touch me');
  fs.mkdirSync(path.join(p, 'src'), { recursive: true }); // extra dir OUTSIDE .claude entirely
  fs.writeFileSync(path.join(p, 'src', 'app.js'), 'console.log("real app code");');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b22', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync handles a project with no pre-existing forge-bin dir (creates it fresh)', r.ok === true);
  t('the new file was created correctly', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'NEW');
  t('the unrelated .claude subdir is completely untouched', fs.readFileSync(path.join(p, '.claude', 'some-totally-unrelated-dir', 'notes.txt'), 'utf8') === 'do not touch me');
  t('the unrelated top-level src/ dir is completely untouched', fs.readFileSync(path.join(p, 'src', 'app.js'), 'utf8') === 'console.log("real app code");');
}

// =====================================================================================
// 2026-07-14 FIX ROUND — sections 23-45 map 1:1 to the blockers/high/medium findings from the adversarial
// review + independent QA (mutation-tested) + 4-lens pre-mortem swarm. Every fixture stays os.tmpdir()-only.
// =====================================================================================

console.log('\n23) B1: cumulative drift baseline survives 3 consecutive template versions touching DIFFERENT files');
{
  const tpl = freshDir('t23-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A1');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B1');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'c.cjs'), 'C1');
  const p = makeProject(freshDir('t23-root'), 'proj', 0);
  const r1 = sync.safeSyncProject(tpl, p, { batchId: 'b23-1', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync 1 succeeds (all 3 files added)', r1.ok === true && r1.plan.toChange.length === 3);

  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A2'); // only a.cjs changes
  const r2 = sync.safeSyncProject(tpl, p, { batchId: 'b23-2', nowIso: '2026-01-02T00:00:00.000Z' });
  t('sync 2 succeeds (only a.cjs changed)', r2.ok === true && r2.plan.toChange.length === 1 && r2.plan.toChange[0].rel === 'forge-bin/a.cjs');
  t('sync 2: b.cjs and c.cjs are NOT unknownDrift (never touched, still same)', r2.plan.unknownDrift.length === 0 && r2.plan.conflicts.length === 0);

  // only b.cjs changes — the OLD bug erased b.cjs's baseline the moment a.cjs changed in sync 2
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B2');
  const r3 = sync.safeSyncProject(tpl, p, { batchId: 'b23-3', nowIso: '2026-01-03T00:00:00.000Z' });
  t('sync 3: b.cjs is classified as a SAFE update (toChange), NOT unknownDrift (kills B1)', r3.ok === true && r3.plan.toChange.some((e) => e.rel === 'forge-bin/b.cjs') && !r3.plan.unknownDrift.includes('forge-bin/b.cjs'));
  t('sync 3: c.cjs (never touched across all 3 versions) is still NOT drifted either', !r3.plan.unknownDrift.includes('forge-bin/c.cjs'));
  t('receipt.knownHashes carries a baseline for all 3 files after 3 cumulative syncs', ['forge-bin/a.cjs', 'forge-bin/b.cjs', 'forge-bin/c.cjs'].every((rel) => Object.prototype.hasOwnProperty.call(r3.receipt.knownHashes, rel)));
}

console.log('\n24) B2: forge-sync-receipt.json is backed up + restored on rollback (preflight sees no false drift)');
{
  const tpl = freshDir('t24-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t24-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  const receiptBeforeSync = fs.readFileSync(sync.receiptPath(p), 'utf8');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b24', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeded', r.ok === true);
  t('receipt now describes THIS sync (different from the pre-sync one)', fs.readFileSync(sync.receiptPath(p), 'utf8') !== receiptBeforeSync);
  const rb = sync.rollbackProject(p, 'b24', {});
  t('rollback ok', rb.ok === true);
  t('rollback reports receiptAction:restored', rb.receiptAction === 'restored');
  t('the receipt on disk is restored to the EXACT pre-sync bytes', fs.readFileSync(sync.receiptPath(p), 'utf8') === receiptBeforeSync);
  const pf = sync.preflight(tpl, p);
  t('preflight() after rollback shows tool.cjs as safe toChange, NOT unknownDrift (kills B2 — QA reproduced this exact false positive)', pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs') && !pf.unknownDrift.includes('forge-bin/tool.cjs'));

  // no-prior-receipt case: rollback must REMOVE the receipt entirely (none existed pre-sync)
  const tpl2 = freshDir('t24b-tpl');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'x.cjs'), 'NEW');
  const p2 = makeProject(freshDir('t24b-root'), 'proj', 0);
  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b24b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync 2 ok, receipt now exists', r2.ok === true && fs.existsSync(sync.receiptPath(p2)));
  const rb2 = sync.rollbackProject(p2, 'b24b', {});
  t('rollback 2 ok, receiptAction is removed', rb2.ok === true && rb2.receiptAction === 'removed');
  t('receipt file is gone (none existed before this sync)', !fs.existsSync(sync.receiptPath(p2)));
}

console.log('\n25) B3: an EXISTING-BUT-UNREADABLE system file refuses the whole sync (never treated as "new")');
{
  const tpl = freshDir('t25-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
  const p = makeProject(freshDir('t25-root'), 'proj', 0);
  // Portably simulate "exists but unreadable" (no chmod/OS-specific flakiness): put a DIRECTORY where the
  // system file is expected — fs.readFileSync on a directory reliably throws EISDIR on every OS.
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), { recursive: true });
  const pf = sync.preflight(tpl, p);
  t('preflight classifies it as unreadable, not missing/new', pf.unreadable.some((u) => u.rel === 'forge-bin/tool.cjs'));
  t('it never lands in toChange (never silently treated as "new")', !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b25', nowIso: '2026-01-01T00:00:00.000Z' });
  t('the WHOLE project sync REFUSES (ok:false, refused:true)', r.ok === false && r.refused === true);
  t('refusal reason names the unreadable file', /tool\.cjs/.test(r.reason) && /unreadable/.test(r.reason));
  t('no backup was ever taken (refused before backup)', !fs.existsSync(path.join(sync.claudeDirOf(p), 'forge-backups')));
  t('the directory is still there, completely untouched (never overwritten/deleted)', fs.existsSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) && fs.lstatSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')).isDirectory());
}

console.log('\n26) B4: rollback-batch reaches the CENTRAL backup when local is wiped; a failing project is not counted as rolled back');
{
  const tpl = freshDir('t26-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const root = freshDir('t26-root');
  const hub = freshDir('t26-hub');
  const pA = makeProject(root, 'pA', 0); makeRealProjectMarker(pA);
  const pB = makeProject(root, 'pB', 0); makeRealProjectMarker(pB);
  // pre-existing content (not "new") so a REAL backup copy is taken for both -> there is something to tamper with
  for (const p of [pA, pB]) {
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'OLD');
    fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'))]]);
  }
  sync.safeSyncProject(tpl, pA, { batchId: 'b26', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub });
  sync.safeSyncProject(tpl, pB, { batchId: 'b26', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub });
  t('both projects synced', fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'NEW' && fs.readFileSync(path.join(pB, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'NEW');
  fs.rmSync(path.join(sync.claudeDirOf(pA), 'forge-backups'), { recursive: true, force: true }); // pA "damaged": local wiped, central intact
  fs.writeFileSync(path.join(sync.backupDirFor(pB, 'b26'), 'forge-bin', 'tool.cjs'), 'TAMPERED'); // pB: BOTH backups corrupt
  fs.writeFileSync(path.join(sync.centralBackupDir(hub, 'b26', sync.projectId(pB)), 'forge-bin', 'tool.cjs'), 'TAMPERED-CENTRAL');

  const results = sync.rollbackBatch(root, 'b26', { centralBackupRoot: hub });
  const rA = results.find((r) => r.projectDir === pA);
  const rB = results.find((r) => r.projectDir === pB);
  t('pA (local wiped) was STILL attempted and restored via the CENTRAL backup', !!rA && rA.ok === true && rA.source === 'central');
  t('pA file content is byte-exact restored to OLD', fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'OLD');
  t('pB (both backups corrupt) correctly reports ok:false — NOT counted as a success', !!rB && rB.ok === false);
  t('exactly 1 of 2 results is ok:true (pA only)', results.filter((r) => r.ok).length === 1 && results.length === 2);
}

console.log('\n26b) B4 (CLI): rollback-batch prints "X of Y" honestly and exits 1 on partial failure');
{
  const tpl = freshDir('t26b-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const root = freshDir('t26b-root');
  const pOk = makeProject(root, 'pOk', 0); makeRealProjectMarker(pOk);
  const pBad = makeProject(root, 'pBad', 0); makeRealProjectMarker(pBad);
  for (const p of [pOk, pBad]) {
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'OLD');
    fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'))]]);
  }
  sync.safeSyncProject(tpl, pOk, { batchId: 'bcli', nowIso: '2026-01-01T00:00:00.000Z' });
  sync.safeSyncProject(tpl, pBad, { batchId: 'bcli', nowIso: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(sync.backupDirFor(pBad, 'bcli'), 'forge-bin', 'tool.cjs'), 'TAMPERED'); // corrupt, not absent — still "part of the batch"
  const cliResult = runCLI(['rollback-batch', 'bcli', root]);
  t('CLI exits 1 (not everything succeeded)', cliResult.status === 1);
  t('CLI summary says "1 of 2 project(s) rolled back" (never conflates a failure into the count)', /1 of 2 project\(s\) rolled back/.test(cliResult.stdout));
}

console.log('\n27) N10 fix (2026-09-26, external audit): a default central backup hub is used automatically when --central-backup-root is not given, and it now lives INSIDE the project (never outside it)');
{
  const tpl = freshDir('t27-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const projectsRoot = freshDir('t27-root');
  const p = makeProject(projectsRoot, 'proj', 0); makeRealProjectMarker(p);
  const cliResult = runCLIWithTemplate(['install', p, '--batch-id', 'b27'], tpl);
  t('install CLI succeeds', cliResult.status === 0);
  const oldOutsideHub = path.join(path.dirname(path.resolve(p)), '.forge-backup-hub');
  t('the OLD outside-the-project default location is never used (N10 fix)', !fs.existsSync(oldOutsideHub));
  const expectedHub = sync.defaultCentralBackupRoot(p);
  t('defaultCentralBackupRoot(p) resolves inside the project (.claude/forge-backups-central)', expectedHub === path.join(path.resolve(p), '.claude', 'forge-backups-central'));
  t('a default central backup hub was created INSIDE the project', fs.existsSync(expectedHub));
  const centralManifestPath = path.join(expectedHub, '.claude', 'forge-backups', 'b27', sync.projectId(p), 'manifest.json');
  t('the default hub actually contains this batch\'s manifest', fs.existsSync(centralManifestPath));

  const p2 = makeProject(projectsRoot, 'proj2', 0);
  const cliResult2 = runCLIWithTemplate(['install', p2, '--batch-id', 'b27b', '--no-central-backup'], tpl);
  t('install with --no-central-backup succeeds', cliResult2.status === 0);
  t('--no-central-backup did not create a central hub entry for THIS batch', !fs.existsSync(path.join(expectedHub, '.claude', 'forge-backups', 'b27b')));

  const p3 = makeProject(projectsRoot, 'proj3', 0); makeRealProjectMarker(p3);
  const cliResult3 = runCLIWithTemplate(['install', p3, '--batch-id', 'b27c'], tpl);
  t('a SECOND project also gets its OWN inside-the-project hub, not the first project\'s', cliResult3.status === 0);
  const hub3 = sync.defaultCentralBackupRoot(p3);
  t('the second project\'s hub lives under ITS OWN .claude, not the first project\'s', fs.existsSync(path.join(hub3, '.claude', 'forge-backups', 'b27c', sync.projectId(p3), 'manifest.json')));

  const rbResult = runCLIWithTemplate(['rollback', p, '--batch', 'b27'], tpl);
  t('rollback finds the same inside-the-project hub install just wrote (symmetric default)', rbResult.status === 0);
}

console.log('\n28) B6: sync-all / list / canary-init / rollback-batch refuse a missing root (no ~/Documents default)');
{
  const savedEnv = process.env.FORGE_SYNC_ROOT;
  delete process.env.FORGE_SYNC_ROOT;
  t('list with no root -> exit 2, refuses (never defaults to ~/Documents)', runCLI(['list']).status === 2);
  t('canary-init with no root -> exit 2', runCLI(['canary-init']).status === 2);
  t('sync-all with no root -> exit 2', runCLI(['sync-all']).status === 2);
  t('rollback-batch with a batchId but no root -> exit 2 (previously silently treated the batchId string AS the root)', runCLI(['rollback-batch', 'some-batch']).status === 2);
  if (savedEnv !== undefined) process.env.FORGE_SYNC_ROOT = savedEnv;

  const root = freshDir('t28-root');
  const rListEnv = runCLI(['list'], { env: Object.assign({}, process.env, { FORGE_SYNC_ROOT: root }) });
  t('list honors FORGE_SYNC_ROOT when no positional root is given', rListEnv.status === 0 && rListEnv.stdout.includes(root));
}

console.log('\n29) B7: rollback refuses to clobber content that diverged since this sync wrote it (--force-rollback-newer overrides)');
{
  const tpl = freshDir('t29-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t29-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b29', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok', r.ok === true);
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'HAND-EDITED-AFTER-SYNC'); // changed AFTER the sync wrote V2
  const rb = sync.rollbackProject(p, 'b29', {});
  t('rollback REFUSES (content diverged since this sync wrote it)', rb.ok === false && Array.isArray(rb.diverged) && rb.diverged.some((d) => d.rel === 'forge-bin/tool.cjs'));
  t('the diverged content is left completely untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'HAND-EDITED-AFTER-SYNC');
  const rbForced = sync.rollbackProject(p, 'b29', { forceRollbackNewer: true });
  t('--force-rollback-newer overrides the refusal and restores V1', rbForced.ok === true && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V1');
}

console.log('\n29b) B7: rollback refuses when a NEWER batch already touched the same file for this project');
{
  const tpl = freshDir('t29b-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t29b-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  sync.safeSyncProject(tpl, p, { batchId: 'batch-old', nowIso: '2026-01-01T00:00:00.000Z' }); // V1 -> V2
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V3');
  sync.safeSyncProject(tpl, p, { batchId: 'batch-new', nowIso: '2026-01-02T00:00:00.000Z' }); // V2 -> V3 (NEWER batch)
  t('project is now at V3', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V3');
  const rb = sync.rollbackProject(p, 'batch-old', {});
  t('rolling back the OLDER batch REFUSES (a newer batch already touched the same file)', rb.ok === false && Array.isArray(rb.newerOverlaps) && rb.newerOverlaps.length > 0);
  t('the project is left at V3, untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V3');
  const rbNewest = sync.rollbackProject(p, 'batch-new', {});
  t('rolling back the NEWEST batch first succeeds (back to V2)', rbNewest.ok === true && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V2');
}

console.log('\n29c) test pin: B7 divergence guard on an ADDED file (oldHash:null) — code was correct but UNTESTED');
{
  // an ADDED file (didn't exist pre-sync, oldHash:null) that is HAND-EDITED after the sync wrote it must
  // trip the SAME B7 "diverged since this sync wrote it" refusal as a pre-existing (oldHash non-null) file —
  // computeDivergence keys off newHash/current-content, not oldHash, but this exact combination (isNew +
  // post-sync hand-edit) had no dedicated test before this pass.
  const tpl = freshDir('t29c-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'new.cjs'), 'TEMPLATE-CONTENT');
  const p = makeProject(freshDir('t29c-root'), 'proj', 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b29c', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sanity: new.cjs was ADDED by this sync (isNew, oldHash:null)', r.ok === true && r.plan.toChange[0].isNew === true && r.plan.toChange[0].oldHash === null);
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'new.cjs'), 'HAND-EDITED-AFTER-SYNC'); // changed AFTER the sync wrote it
  const rb = sync.rollbackProject(p, 'b29c', {});
  t('B7 PIN: rollback REFUSES on an ADDED file that diverged since this sync wrote it (same guard as a pre-existing file)', rb.ok === false && Array.isArray(rb.diverged) && rb.diverged.some((d) => d.rel === 'forge-bin/new.cjs'));
  t('B7 PIN: the hand-edited content is left completely untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'new.cjs'), 'utf8') === 'HAND-EDITED-AFTER-SYNC');
  const rbForced = sync.rollbackProject(p, 'b29c', { forceRollbackNewer: true });
  t('B7 PIN: --force-rollback-newer overrides the refusal and correctly DELETES the added file (rolled back to pre-sync non-existence)', rbForced.ok === true && !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'new.cjs')));
}

console.log('\n30) H1: rollback never claims a file was "restored" without a real post-restore verification');
{
  const tpl = freshDir('t30-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'locked.cjs'), 'LOCKED-NEW');
  const p = makeProject(freshDir('t30-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'A-OLD');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'locked.cjs'), 'LOCKED-OLD');
  fakeReceiptMatchingCurrent(p, [
    ['forge-bin/a.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs'))],
    ['forge-bin/locked.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'locked.cjs'))],
  ]);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b30', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok, both files updated', r.ok === true && r.plan.toChange.length === 2);
  const lockedPath = path.join(p, '.claude', 'forge-bin', 'locked.cjs');
  let realLockWorks = false;
  const probe = freshDir('t30-probe');
  const probeFile = path.join(probe, 'x.txt');
  fs.writeFileSync(probeFile, 'orig'); fs.chmodSync(probeFile, 0o444);
  // Probe the SAME mechanism the sync uses (stage a temp file, then rename it over the target — see copyNoFollow /
  // writeAtomic). A plain writeFileSync on a 0o444 file fails on every OS, but rename-over-target ignores the
  // target's mode on Linux (only the directory's permissions matter), so the old probe said "real lock" while the
  // real sync sailed through — 8 red assertions on the first Linux CI run. On Windows the read-only
  // attribute makes the rename throw EPERM, so that branch is unchanged.
  try { const probeTmp = probeFile + '.probe.tmp'; fs.writeFileSync(probeTmp, 'new'); fs.renameSync(probeTmp, probeFile); } catch { realLockWorks = true; }
  fs.chmodSync(probeFile, 0o666); fs.rmSync(probe, { recursive: true, force: true });

  if (realLockWorks) {
    fs.chmodSync(lockedPath, 0o444);
    const rb = sync.rollbackProject(p, 'b30', {});
    fs.chmodSync(lockedPath, 0o666); // always release before assertions/cleanup
    console.log('     (H1 evidence source: REAL OS EPERM via chmod 0o444)');
    t('rollback reports ok:false, partial:true (never a bare "ok:true")', rb.ok === false && rb.partial === true);
    t('the free file (a.cjs) IS in the restored list', rb.restored.includes('forge-bin/a.cjs'));
    t('the locked file is NOT in the restored list (H1 — never claim a file was restored when it was not)', !rb.restored.includes('forge-bin/locked.cjs'));
    t('a.cjs really is back to its OLD content', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'A-OLD');
    t('reason names PARTIAL / MANUAL RECOVERY', /PARTIAL/.test(rb.reason) && /MANUAL RECOVERY/.test(rb.reason));
  } else {
    console.log('     (H1 evidence source: OS did not reproduce a real lock in this sandbox — reporting the gap honestly, no fabricated pass)');
    t('(H1 EPERM half skipped honestly)', true);
  }
}

console.log('\n31) H2: install CLI exits 1 and prints BLOCKED when drift blocks (was silently exit 0)');
{
  const tpl = freshDir('t31-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'TEMPLATE-V2');
  const p = makeProject(freshDir('t31-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'HAND-EDITED');
  const cliResult = runCLIWithTemplate(['install', p], tpl);
  t('install CLI exits 1 when blocked by unresolved drift (was wrongly exit 0)', cliResult.status === 1);
  t('stderr says BLOCKED', /BLOCKED/.test(cliResult.stderr));
  t('the hand-edited file is untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'HAND-EDITED');
}

console.log('\n32) H3: decideValidationOutcome — already-red vs genuine regression vs node_check hard gate');
{
  const clean = { ok: true, summary: { ok: true, node_check: { ok: true }, tests: { ok: true } } };
  const redBefore = { ok: false, summary: { ok: false, node_check: { ok: true }, tests: { ok: false } } };
  const redAfterSameReason = { ok: false, summary: { ok: false, node_check: { ok: true }, tests: { ok: false } } };
  const regressed = { ok: false, summary: { ok: false, node_check: { ok: true }, tests: { ok: false } } };
  const nodeCheckBroken = { ok: false, summary: { ok: false, node_check: { ok: false }, tests: { ok: true } } };

  const o1 = sync.decideValidationOutcome(clean, clean, {});
  t('clean pre + clean post -> ok:true', o1.ok === true);
  const o2 = sync.decideValidationOutcome(redBefore, redAfterSameReason, {});
  t('already-red pre (tests) + SAME red post + node_check clean -> ok:true, alreadyRedSkipped', o2.ok === true && o2.alreadyRedSkipped === true);
  const o3 = sync.decideValidationOutcome(clean, regressed, {});
  t('clean pre + red post (tests regressed from green) -> ok:false (genuine regression)', o3.ok === false);
  const o4 = sync.decideValidationOutcome(redBefore, nodeCheckBroken, {});
  t('already-red pre BUT node_check itself is broken post -> ok:false (unconditional hard gate, never bypassed by already-red)', o4.ok === false);
  const o5 = sync.decideValidationOutcome(null, { ok: false, noEvidence: true, reason: 'no evidence' }, {});
  t('no-evidence post -> ok:false regardless of pre state', o5.ok === false);
  const o6 = sync.decideValidationOutcome(null, { ok: true, degraded: true }, {});
  t('degraded pass WITHOUT --allow-degraded -> ok:false (H4)', o6.ok === false);
  const o7 = sync.decideValidationOutcome(null, { ok: true, degraded: true }, { allowDegraded: true });
  t('degraded pass WITH --allow-degraded -> ok:true, degradedAllowed', o7.ok === true && o7.degradedAllowed === true);
  const o8 = sync.decideValidationOutcome(null, { ok: false, degraded: true }, { allowDegraded: true });
  t('degraded FAILURE (real syntax error) is NEVER let through even with --allow-degraded', o8.ok === false);
  const o9 = sync.decideValidationOutcome(null, { timedOut: true, signal: 'SIGTERM' }, {});
  t('a doctor timeout is ok:false, timedOut:true (BLOCKED, not a confirmed failure)', o9.ok === false && o9.timedOut === true);
}

console.log('\n33) H4 / finding#6: the REAL forge-doctor.cjs is actually invoked (not a stub) + a 0-evidence pass is REJECTED');
{
  const realDoctorSrc = path.join(__dirname, 'forge-doctor.cjs'); // this repo's REAL, current doctor (read-only copy)
  const realStoreSrc = path.join(__dirname, 'forge-store.cjs'); // forge-doctor.cjs's one sibling dependency
  if (fs.existsSync(realDoctorSrc) && fs.existsSync(realStoreSrc)) {
    const p = makeProject(freshDir('t33-realdoctor-root'), 'proj', null); // no fake stub
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.copyFileSync(realDoctorSrc, path.join(p, '.claude', 'forge-bin', 'forge-doctor.cjs'));
    fs.copyFileSync(realStoreSrc, path.join(p, '.claude', 'forge-bin', 'forge-store.cjs'));
    const result = sync.runValidation(p, { toChange: [] });
    t('the REAL forge-doctor.cjs is actually invoked (tool:"forge-doctor", not the node-check-fallback)', result.tool === 'forge-doctor');
    t('its JSON output is parsed into a structured summary (real node_check + tests sub-objects, not a bare exit code)',
      result.summary && result.summary.node_check && typeof result.summary.node_check.total === 'number' &&
      result.summary.tests && typeof result.summary.tests.suites === 'number');
  } else {
    console.log('  (skipped: forge-doctor.cjs not found next to the test file in this environment)');
    t('(finding#6 real-doctor half skipped honestly — file not present)', true);
  }

  // the CORE H4 proof: an exit-0 doctor reporting 0 checks/0 suites must be REJECTED, not trusted
  const p2 = makeProject(freshDir('t33-zeroevidence-root'), 'proj', null);
  const zdir = path.join(p2, '.claude', 'forge-bin');
  fs.mkdirSync(zdir, { recursive: true });
  fs.writeFileSync(path.join(zdir, 'forge-doctor.cjs'),
    '#!/usr/bin/env node\nvar a=process.argv.slice(2);if(a.indexOf("--json")!==-1){console.log(JSON.stringify({ok:true,checks:{node_check:{ok:true,total:0,failed:0},tests:{ok:true,suites:0,passed:0,failed:0}}}));}\nprocess.exit(0);\n', 'utf8');
  const result2 = sync.runValidation(p2, { toChange: [] });
  t('a 0-evidence doctor PASS (exit 0, 0 checks/0 suites) is REJECTED, not trusted', result2.ok === false && result2.noEvidence === true);
}

console.log('\n34) M1: a value-taking flag followed by another flag (or nothing) refuses instead of eating it');
{
  const p = freshDir('t34-root');
  t('"install <p> --run-id --dry-run" exits 2 (refuses; does NOT silently swallow --dry-run as runId\'s value)', runCLI(['install', p, '--run-id', '--dry-run']).status === 2);
  t('a value-flag with nothing after it exits 2', runCLI(['install', p, '--batch-id']).status === 2);
  t('another value-flag case exits 2 too (generalizes beyond just --run-id)', runCLI(['install', p, '--central-backup-root', '--force-overwrite']).status === 2);
}

console.log('\n35) M2: a concurrent forge-sync run refuses while a fresh lock is held; dry-run never takes a lock');
{
  const tpl = freshDir('t35-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t35-root'), 'proj', 0);
  const claudeDir = sync.claudeDirOf(p);
  const lockPath = sync.lockPathFor(claudeDir);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const r = runCLIWithTemplate(['install', p], tpl);
  t('a concurrent install refuses while the lock is fresh (exit 1, not a crash)', r.status === 1);
  t('refusal message mentions "in progress"', /in progress/.test(r.stderr));
  t('the project was NOT touched while locked', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')));
  fs.rmSync(lockPath, { force: true });
  const r2 = runCLIWithTemplate(['install', p], tpl);
  t('after the lock is released, install succeeds normally', r2.status === 0);
  t('the lock file is cleaned up after a successful run (no leftover lock)', !fs.existsSync(lockPath));

  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const rDry = runCLIWithTemplate(['install', p, '--dry-run'], tpl);
  t('--dry-run succeeds even while a lock is held (dry-run never locks)', rDry.status === 0);
  fs.rmSync(lockPath, { force: true });

  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: '2020-01-01T00:00:00.000Z' }));
  const staleAcquire = sync.acquireLock(claudeDir, { staleMs: 1000 });
  t('a STALE lock (older than staleMs) is reclaimed rather than refused', staleAcquire.ok === true && staleAcquire.reclaimedStale === true);
  sync.releaseLock(staleAcquire);
}

console.log('\n36) M3: reusing a --batch-id for the SAME project refuses (unless --resume-batch)');
{
  const tpl = freshDir('t36-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A1');
  const p = makeProject(freshDir('t36-root'), 'proj', 0);
  const r1 = sync.safeSyncProject(tpl, p, { batchId: 'reused-batch', nowIso: '2026-01-01T00:00:00.000Z' });
  t('first sync with batchId "reused-batch" succeeds', r1.ok === true);
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B1');
  const r2 = sync.safeSyncProject(tpl, p, { batchId: 'reused-batch', nowIso: '2026-01-02T00:00:00.000Z' });
  t('reusing the SAME batchId for the SAME project refuses (would silently clobber the first manifest)', r2.ok === false && r2.refused === true);
  t('refusal names --resume-batch as the escape hatch', /--resume-batch/.test(r2.reason));
  t('b.cjs was NOT written (refused before any write)', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'b.cjs')));
  const r3 = sync.safeSyncProject(tpl, p, { batchId: 'reused-batch', nowIso: '2026-01-03T00:00:00.000Z', resumeBatch: true });
  t('--resume-batch (opts.resumeBatch) explicitly allows reusing the batch id', r3.ok === true);
  t('b.cjs now written', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'utf8') === 'B1');
}

console.log('\n37) M5: the dedicated canary is WIPED (not accumulated) on every canary-init');
{
  const root = freshDir('t37-root');
  const dedicated = sync.dedicatedCanaryDir(root);
  sync.canaryInit(freshDir('t37-tpl'), root, {});
  fs.writeFileSync(sync.versionFilePath(dedicated), JSON.stringify({ forge_version: 'stale' }));
  fs.writeFileSync(sync.receiptPath(dedicated), JSON.stringify({ stale: true }));
  fs.mkdirSync(path.join(dedicated, '.claude', 'forge-runs', 'old-run'), { recursive: true });
  t('accumulated canary state exists before re-init', fs.existsSync(sync.versionFilePath(dedicated)) && fs.existsSync(sync.receiptPath(dedicated)));
  sync.canaryInit(freshDir('t37-tpl2'), root, {});
  t('FORGE_VERSION.json is gone after re-init (wiped, not accumulated)', !fs.existsSync(sync.versionFilePath(dedicated)));
  t('the stale receipt is gone after re-init', !fs.existsSync(sync.receiptPath(dedicated)));
  t('the stale forge-runs dir is gone after re-init', !fs.existsSync(path.join(dedicated, '.claude', 'forge-runs', 'old-run')));
  t('a fresh FORGE_CANARY_MARKER.json exists', fs.existsSync(path.join(dedicated, '.claude', 'FORGE_CANARY_MARKER.json')));
}

console.log('\n38) M6: a symlinked/junctioned PARENT directory (not just the leaf) is caught by the containment guard');
{
  const tpl = freshDir('t38-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t38-root'), 'proj', 0);
  const outside = freshDir('t38-outside');
  const junctionTarget = path.join(p, '.claude', 'forge-bin');
  fs.rmSync(junctionTarget, { recursive: true, force: true }); // makeProject's doctor stub already created this dir; clear it first
  let junctionOk = false;
  try { fs.symlinkSync(outside, junctionTarget, 'junction'); junctionOk = true; }
  catch (e) { console.log('     (M6 evidence: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
  if (junctionOk) {
    const pf = sync.preflight(tpl, p);
    t('the file behind the junctioned forge-bin/ is SKIPPED (containment guard), never silently written through it', pf.skipped.some((s) => s.rel === 'forge-bin/tool.cjs'));
    t('nothing was written into the OUTSIDE (junction target) directory', !fs.existsSync(path.join(outside, 'tool.cjs')));
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b38', nowIso: '2026-01-01T00:00:00.000Z' });
    t('sync reports noop (nothing safe to change; the only file is skipped)', r.noop === true || r.plan.toChange.length === 0);
  } else {
    t('(M6 skipped honestly — junction creation unavailable in this sandbox)', true);
  }
}

console.log('\n39) M7: --unsafe still takes a real, restorable backup (never "no undo")');
{
  const tpl = freshDir('t39-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t39-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  // --unsafe now refuses a file changed WITHOUT a forge-sync baseline (unknown drift, see section
  // 86); this M7 test is about the backup, so it starts from a legitimate prior sync baseline, like test 2.
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'))]]);
  const r = sync.rawInstall(tpl, p, { batchId: 'b39', nowIso: '2026-01-01T00:00:00.000Z' });
  t('--unsafe (rawInstall) reports ok:true and a backup object', r.ok === true && !!r.backup);
  t('the file was overwritten to V2', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V2');
  t('a REAL backup file with the OLD bytes exists on disk', fs.existsSync(path.join(r.backup.backupDir, 'forge-bin', 'tool.cjs')) && fs.readFileSync(path.join(r.backup.backupDir, 'forge-bin', 'tool.cjs'), 'utf8') === 'V1');
  const rb = sync.rollbackProject(p, 'b39', {});
  t('the --unsafe sync is fully restorable via the STANDARD rollback command', rb.ok === true);
  t('rollback restores the exact pre-unsafe-install bytes (V1)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V1');

  const p2 = makeProject(freshDir('t39b-root'), 'proj2', 0);
  const before = snapshotTree(p2);
  sync.rawInstall(tpl, p2, { dryRun: true });
  t('--unsafe --dry-run still writes NOTHING', JSON.stringify(snapshotTree(p2)) === JSON.stringify(before));
}

console.log('\n40) M8: abort messaging branches on r.ok/blocked (never says a hedged "(if applicable)")');
{
  const tpl = freshDir('t40-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'TEMPLATE-V2');
  const root = freshDir('t40-root');
  const p = makeProject(root, 'proj', 0); makeRealProjectMarker(p);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'HAND-EDITED'); // fully drifted -> blocked, ok:false
  const originalError = console.error;
  let captured = '';
  console.error = (...args) => { captured += args.join(' ') + '\n'; };
  let result;
  try { result = sync.runSyncAll(tpl, root, { projects: [p], canaryName: 'proj', batchId: 'b40', nowIso: '2026-01-01T00:00:00.000Z' }); }
  finally { console.error = originalError; }
  t('batch aborts due to unresolved drift', result.ok === false && result.aborted === true);
  t('never prints the old hedge "(if applicable)"', !/\(if applicable\)/.test(captured));
  t('plainly states nothing was written (blocked, not failed)', /nothing was written/.test(captured));
}

console.log('\n40b) M8: the "own sync succeeded but still has unresolved drift" case gets an accurate message');
{
  const tpl = freshDir('t40b-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'new.cjs'), 'NEW-FILE'); // safely addable
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'drifted.cjs'), 'TEMPLATE-V2'); // will be drifted
  const root = freshDir('t40b-root');
  const p = makeProject(root, 'proj', 0); makeRealProjectMarker(p);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'HAND-EDITED');
  const originalError = console.error;
  let captured = '';
  console.error = (...args) => { captured += args.join(' ') + '\n'; };
  let result;
  try { result = sync.runSyncAll(tpl, root, { projects: [p], canaryName: 'proj', batchId: 'b40b', nowIso: '2026-01-01T00:00:00.000Z' }); }
  finally { console.error = originalError; }
  const repResult = result.projects && result.projects[0];
  t('the representative project itself DID sync successfully (new.cjs added)', repResult && repResult.ok === true && fs.existsSync(path.join(p, '.claude', 'forge-bin', 'new.cjs')));
  t('the batch still aborts (unresolved drift on drifted.cjs)', result.ok === false && result.aborted === true);
  t('message reflects the ACCURATE mixed state (own sync succeeded) — never the old hedged "(if applicable)"', !/\(if applicable\)/.test(captured) && /own sync succeeded/.test(captured));
}

console.log('\n41) M9: an EOL-only difference (CRLF vs LF, otherwise identical text) syncs instead of blocking as drift');
{
  const tpl = freshDir('t41-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'line1\nline2\nline3\n');
  const p = makeProject(freshDir('t41-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'line1\r\nline2\r\nline3\r\n'); // same TEXT, CRLF
  const pf = sync.preflight(tpl, p);
  const entry = pf.toChange.find((e) => e.rel === 'forge-bin/tool.cjs');
  t('classified as eol_only (in toChange, not unknownDrift, despite NO receipt at all)', !!entry && entry.overrideClass === 'eol_only' && !pf.unknownDrift.includes('forge-bin/tool.cjs'));
  const oldRawHash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b41', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeds (eol_only is always safe to sync)', r.ok === true);
  t('the project file now has the template\'s RAW (LF) bytes', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'line1\nline2\nline3\n');
  const backupFile = path.join(r.backup.backupDir, 'forge-bin', 'tool.cjs');
  t('the OLD raw (CRLF) bytes were backed up before the overwrite', fs.existsSync(backupFile) && sync.sha256(backupFile) === oldRawHash);
  t('receipt records the eol_only overrideClass', r.receipt.filesChanged.some((f) => f.rel === 'forge-bin/tool.cjs' && f.overrideClass === 'eol_only'));

  const p2 = makeProject(freshDir('t41b-root'), 'proj2', 0);
  fs.mkdirSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs'), 'COMPLETELY-DIFFERENT-TEXT\r\n');
  const pf2 = sync.preflight(tpl, p2);
  t('a genuine content difference (not just EOL) is still unknownDrift, never eol_only', pf2.unknownDrift.includes('forge-bin/tool.cjs') && !pf2.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
}

console.log('\n42) M10 + test#7: a project path containing a SPACE and "!" works end-to-end; validation.commands is properly quoted');
{
  const tpl = freshDir('t42-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log(1);\n');
  const spaceRoot = freshDir('t42-root space test!');
  const p = makeProject(spaceRoot, 'proj', 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b42', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeds against a path containing a space and "!"', r.ok === true);
  t('validation.commands is a properly quoted, non-empty string mentioning the doctor path', Array.isArray(r.validation.commands) && r.validation.commands.length > 0 && r.validation.commands[0].includes('forge-doctor.cjs'));
  t('the quoted command string wraps the space/!-containing path segment in quotes', r.validation.commands.some((c) => /"[^"]*!/.test(c) || /"[^"]* /.test(c)));
  const rb = sync.rollbackProject(p, 'b42', {});
  t('rollback also works fine against the space/!-containing path', rb.ok === true);
}

console.log('\n43) M11: __throwAfter is gated behind FORGE_SYNC_TEST_HOOKS=1 (inert in a normal production process)');
{
  const tpl = freshDir('t43-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x1.cjs'), 'X1');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x2.cjs'), 'X2');
  const p = makeProject(freshDir('t43-root'), 'proj', 0);
  sync.safeSyncProject(tpl, p, { batchId: 'b43', nowIso: '2026-01-01T00:00:00.000Z' });
  const scriptDir = freshDir('t43-script');
  const scriptPath = path.join(scriptDir, 'probe.cjs');
  fs.writeFileSync(scriptPath, [
    'const s = require(' + JSON.stringify(CLI) + ');',
    'const r = s.rollbackProject(' + JSON.stringify(p) + ', ' + JSON.stringify('b43') + ', { __throwAfter: 1 });',
    'console.log(JSON.stringify({ ok: r.ok, interrupted: !!r.interrupted }));',
  ].join('\n'));
  const cleanEnv = Object.assign({}, process.env);
  delete cleanEnv.FORGE_SYNC_TEST_HOOKS; // this test file sets it at module load — the CHILD must NOT inherit it
  const probeResult = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: cleanEnv });
  t('probe subprocess ran cleanly', probeResult.status === 0);
  let parsed = null; try { parsed = JSON.parse((probeResult.stdout || '').trim()); } catch { /* leave null, next assert fails honestly */ }
  t('__throwAfter is INERT without FORGE_SYNC_TEST_HOOKS=1 — rollback completes normally, not "interrupted"', !!parsed && parsed.ok === true && parsed.interrupted === false);
}

console.log('\n44) adopt: establishes a baseline receipt without writing any system file; reports differing files');
{
  const tpl = freshDir('t44-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'TEMPLATE-A');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'TEMPLATE-B');
  const p = makeProject(freshDir('t44-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'PROJECT-OWNED-A'); // differs from template
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'TEMPLATE-B'); // matches template
  // test pin (per WP): "adopt writes-nothing-else" must be proven with a snapshotTree over the WHOLE project,
  // not just spot-checking the two files adopt is expected to READ — this catches any accidental extra write
  // anywhere else in the project tree that per-file spot checks would silently miss.
  const wholeTreeBefore = snapshotTree(p);
  const r = sync.adoptProject(tpl, p, { nowIso: '2026-01-01T00:00:00.000Z' });
  t('adopt reports ok:true', r.ok === true);
  t('adopt did NOT write any system file (a.cjs/b.cjs bytes are untouched)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'PROJECT-OWNED-A' && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'utf8') === 'TEMPLATE-B');
  const wholeTreeAfter = snapshotTree(p);
  const receiptKey = Object.keys(wholeTreeAfter).find((k) => k === sync.receiptPath(p));
  const changedOrAddedKeys = Object.keys(wholeTreeAfter).filter((k) => wholeTreeAfter[k] !== wholeTreeBefore[k]);
  t('WHOLE-PROJECT snapshotTree proof: the ONLY file adopt changed/added anywhere in the project is the receipt itself', changedOrAddedKeys.length === 1 && changedOrAddedKeys[0] === receiptKey);
  t('nothing was REMOVED anywhere in the project by adopt', Object.keys(wholeTreeBefore).every((k) => Object.prototype.hasOwnProperty.call(wholeTreeAfter, k)));
  t('adopt reports a.cjs as differing from the template', r.differing.includes('forge-bin/a.cjs') && !r.differing.includes('forge-bin/b.cjs'));
  t('receipt now exists with knownHashes for both files (the CURRENT project bytes, verbatim)', fs.existsSync(sync.receiptPath(p)) && r.receipt.knownHashes['forge-bin/a.cjs'] === sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs')));
  const pf = sync.preflight(tpl, p);
  t('after adopt, preflight sees a.cjs as a SAFE update, not unknownDrift (adopt replaces a blind --force-overwrite)', pf.toChange.some((e) => e.rel === 'forge-bin/a.cjs') && !pf.unknownDrift.includes('forge-bin/a.cjs'));

  const p2 = makeProject(freshDir('t44b-root'), 'proj2', 0);
  const before2 = snapshotTree(p2);
  const rDry = sync.adoptProject(tpl, p2, { dryRun: true });
  t('adopt --dry-run reports ok:true but writes nothing', rDry.ok === true && rDry.dryRun === true && JSON.stringify(snapshotTree(p2)) === JSON.stringify(before2));
}

console.log('\n45) M4: a forge-doctor TIMEOUT is BLOCKED, not a confirmed validation failure; --doctor-timeout is a real, settable value');
{
  const tpl = freshDir('t45-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t45-root'), 'proj', null);
  const dir = path.join(p, '.claude', 'forge-bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'forge-doctor.cjs'), '#!/usr/bin/env node\nvar start = Date.now(); while (Date.now() - start < 4000) {}\nprocess.exit(0);\n', 'utf8');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b45', nowIso: '2026-01-01T00:00:00.000Z', doctorTimeoutMs: 300 });
  t('sync reports ok:false (validator did not confirm in time)', r.ok === false);
  t('validation reports timedOut:true (BLOCKED classification, not a confirmed failure)', r.validation && r.validation.timedOut === true);
  t('outcome reflects timedOut, distinct from a genuine red result', r.outcome && r.outcome.timedOut === true);
  t('tool.cjs (the added file) was rolled back to non-existence after the confirmed-blocked sync', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')));
}

// =====================================================================================
// 2026-07-14 FINAL FIX ROUND — sections 46-56 map 1:1 to Blocker 1-3 + S1-S8 from the converged
// adversarial-review + mutation-testing QA. Every fixture stays os.tmpdir()-only.
// =====================================================================================

console.log('\n46) B1: regressionCheck/decideValidationOutcome sees ALL 8 doctor checks, not just node_check+tests');
{
  const mkSummary = (over) => Object.assign({
    ok: false, node_check: { ok: true }, tests: { ok: true },
    checksOk: Object.assign({
      node_check: { ok: true }, tests: { ok: true }, strict_events: { ok: true }, dashboard_spa: { ok: true },
      leak_scan: { ok: false }, agents: { ok: true }, chain: { ok: true }, rebinding_guard: { ok: true },
    }, over),
  }, {});
  const preSummary = mkSummary({}); // leak_scan already red pre-sync
  const postSummarySameRed = mkSummary({}); // still only leak_scan red, nothing else changed
  const postSummaryRegressed = mkSummary({ dashboard_spa: { ok: false } }); // dashboard_spa newly broken

  const regressedNone = sync.regressionCheck(preSummary, postSummarySameRed);
  t('regressionCheck: identical pre/post red -> no regression detected', regressedNone.length === 0);
  const regressedHit = sync.regressionCheck(preSummary, postSummaryRegressed);
  t('regressionCheck: dashboard_spa flips green->red -> DETECTED (the old 2-check condense could never see this)', regressedHit.includes('dashboard_spa'));

  const outcomeSame = sync.decideValidationOutcome({ ok: false, summary: preSummary }, { ok: false, summary: postSummarySameRed }, {});
  t('decideValidationOutcome: pre red + post IDENTICALLY red -> ok:true, alreadyRedSkipped (not blamed on this sync)', outcomeSame.ok === true && outcomeSame.alreadyRedSkipped === true);
  const outcomeRegressed = sync.decideValidationOutcome({ ok: false, summary: preSummary }, { ok: false, summary: postSummaryRegressed }, {});
  t('decideValidationOutcome: pre red (leak_scan) + post regressed on dashboard_spa -> ok:false, NOT alreadyRedSkipped (kills B1)', outcomeRegressed.ok === false && !outcomeRegressed.alreadyRedSkipped);

  // end-to-end proof: the receipt persists the FULL per-check pre/post map (checksOk with all 8 keys)
  const tpl = freshDir('t46-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t46-root'), 'proj', null);
  const dir46 = path.join(p, '.claude', 'forge-bin');
  fs.mkdirSync(dir46, { recursive: true });
  const fullChecks = {
    node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 },
    strict_events: { ok: true }, dashboard_spa: { ok: true }, leak_scan: { ok: true }, agents: { ok: true }, chain: { ok: true }, rebinding_guard: { ok: true },
  };
  fs.writeFileSync(path.join(dir46, 'forge-doctor.cjs'),
    '#!/usr/bin/env node\nvar a=process.argv.slice(2);if(a.indexOf("--json")!==-1){console.log(' + JSON.stringify(JSON.stringify({ ok: true, checks: fullChecks })) + ');}\nprocess.exit(0);\n', 'utf8');
  const r46 = sync.safeSyncProject(tpl, p, { batchId: 'b46', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok (real 8-check doctor stub)', r46.ok === true);
  const allEightKeys = ['node_check', 'tests', 'strict_events', 'dashboard_spa', 'leak_scan', 'agents', 'chain', 'rebinding_guard'];
  t('B1: receipt.validation.summary.checksOk carries ALL 8 doctor checks, not just node_check+tests', allEightKeys.every((k) => r46.receipt.validation.summary.checksOk && Object.prototype.hasOwnProperty.call(r46.receipt.validation.summary.checksOk, k)));
}

console.log('\n47) H1: PINNED direct test — post-restore hash-verification block (previously a SURVIVING mutant, zero direct coverage)');
{
  const crypto47 = require('crypto');
  // (a) CORRUPT case: backup bytes on disk diverge from the manifest's recorded oldHash -> must be caught.
  // This is a DIRECT call to restoreFromManifest (bypassing loadTrustedManifest/verifyBackupIntegrity, which
  // would otherwise refuse earlier) so this test exercises ONLY the post-restore verification block itself.
  const pA = makeProject(freshDir('t47a-root'), 'proj', 0);
  fs.mkdirSync(path.join(pA, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pA, '.claude', 'forge-bin', 'x.cjs'), 'CURRENT-CONTENT-BEFORE-RESTORE');
  const manifestDirA = freshDir('t47a-manifest');
  fs.mkdirSync(path.join(manifestDirA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(manifestDirA, 'forge-bin', 'x.cjs'), 'CORRUPTED-BACKUP-BYTES-ON-DISK');
  const wrongOldHash = crypto47.createHash('sha256').update('THIS-IS-WHAT-THE-MANIFEST-CLAIMS-WAS-BACKED-UP').digest('hex');
  // newHash MUST match the file's CURRENT on-disk content (what "this sync" is recorded as having written) —
  // otherwise the UNRELATED B7 divergence guard refuses before ever reaching the H1 post-restore check this
  // test targets, and its refusedDivergence shape has no failed[]/partial field (a different code path).
  const currentHashA = sync.sha256(path.join(pA, '.claude', 'forge-bin', 'x.cjs'));
  const manifestA = { batchId: 'b47a', files: [{ rel: 'forge-bin/x.cjs', oldHash: wrongOldHash, newHash: currentHashA }] };
  const resultA = sync.restoreFromManifest(pA, manifestDirA, manifestA, {});
  t('H1 PIN: corrupt backup bytes vs recorded oldHash -> ok:false (never a false "restored")', resultA.ok === false);
  t('H1 PIN: rel is in failed[], NOT in restored[]', !resultA.restored.includes('forge-bin/x.cjs') && resultA.failed.some((f) => f.rel === 'forge-bin/x.cjs'));
  // the restore now verifies the backup bytes IN MEMORY against the recorded oldHash BEFORE
  // writing, so corrupt backup bytes are refused up front instead of being written into the project and then detected
  // ("hash mismatch after restore"). The pin is updated, not weakened: still ok:false, still failed[], and additionally the
  // live file must be byte-identical to what it held — the corrupt backup never reaches the project.
  t('H1 PIN: failure reason cites the backup mismatch (refused BEFORE writing; was "hash mismatch after restore" when it wrote first)', resultA.failed.some((f) => /backup copy does not hold the recorded pre-batch bytes|hash mismatch after restore/.test(f.reason)));
  t('H1 PIN (R4): the corrupt backup bytes were never written into the project', fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'x.cjs'), 'utf8') === 'CURRENT-CONTENT-BEFORE-RESTORE');
  t('H1 PIN: this is exactly the shape rollbackProject() reports as PARTIAL/MANUAL RECOVERY', resultA.partial === true);

  // (b) CONTROL case: backup bytes genuinely match the recorded oldHash -> restore succeeds normally. This
  // proves test (a) fails for the RIGHT reason (a real mismatch), not because restoreFromManifest is broken.
  const pB = makeProject(freshDir('t47b-root'), 'proj', 0);
  fs.mkdirSync(path.join(pB, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pB, '.claude', 'forge-bin', 'x.cjs'), 'CURRENT-CONTENT-BEFORE-RESTORE');
  const manifestDirB = freshDir('t47b-manifest');
  fs.mkdirSync(path.join(manifestDirB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(manifestDirB, 'forge-bin', 'x.cjs'), 'GENUINE-BACKUP-BYTES');
  const correctOldHash = sync.sha256(path.join(manifestDirB, 'forge-bin', 'x.cjs'));
  const currentHashB = sync.sha256(path.join(pB, '.claude', 'forge-bin', 'x.cjs')); // same "not diverged" reasoning as (a)
  const manifestB = { batchId: 'b47b', files: [{ rel: 'forge-bin/x.cjs', oldHash: correctOldHash, newHash: currentHashB }] };
  const resultB = sync.restoreFromManifest(pB, manifestDirB, manifestB, {});
  t('H1 CONTROL: matching backup bytes -> ok:true, rel genuinely restored', resultB.ok === true && resultB.restored.includes('forge-bin/x.cjs'));
  t('H1 CONTROL: on-disk file now holds the genuine backup bytes', fs.readFileSync(path.join(pB, '.claude', 'forge-bin', 'x.cjs'), 'utf8') === 'GENUINE-BACKUP-BYTES');
}

console.log('\n48) B3 (Blocker 3): install refuses to stamp a partial sync when unresolved drift/conflict remains');
{
  const tpl = freshDir('t48-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'new.cjs'), 'NEW-FILE-CONTENT'); // safely addable
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'drifted.cjs'), 'TEMPLATE-V2'); // will be drifted
  const p = makeProject(freshDir('t48-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'HAND-EDITED'); // no receipt -> unknownDrift
  t('sanity: no FORGE_VERSION.json exists before this install', !fs.existsSync(sync.versionFilePath(p)));
  const cliResult = runCLIWithTemplate(['install', p, '--batch-id', 'b48'], tpl);
  t('install CLI exits non-zero (BLOCKER 3 — was wrongly exit 0)', cliResult.status !== 0);
  t('stderr explicitly names the drifted file', /drifted\.cjs/.test(cliResult.stderr));
  t('stderr says BLOCKED', /BLOCKED/.test(cliResult.stderr));
  t('FORGE_VERSION.json is still NOT written (a partially-synced project must not claim the new template version)', !fs.existsSync(sync.versionFilePath(p)));
  t('the safely-addable file (new.cjs) was ALSO rolled back, not left half-applied', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'new.cjs')));
  t('no forge-sync-receipt.json was written either', !fs.existsSync(sync.receiptPath(p)));
  t('the hand-edited drifted file is completely untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'utf8') === 'HAND-EDITED');
}

console.log('\n48b) B3: --force-overwrite still fully resolves drift for install (both files land, version stamped)');
{
  const tpl = freshDir('t48b-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'new.cjs'), 'NEW-FILE-CONTENT');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'drifted.cjs'), 'TEMPLATE-V2');
  const p = makeProject(freshDir('t48b-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'HAND-EDITED');
  const cliResult = runCLIWithTemplate(['install', p, '--batch-id', 'b48b', '--force-overwrite'], tpl);
  t('install --force-overwrite exits 0 (no unresolved drift remains)', cliResult.status === 0);
  t('both files landed', fs.existsSync(path.join(p, '.claude', 'forge-bin', 'new.cjs')) && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'utf8') === 'TEMPLATE-V2');
  t('FORGE_VERSION.json IS stamped (fully resolved this time)', fs.existsSync(sync.versionFilePath(p)));
}

console.log('\n49) S1: --resume-batch never re-backs-up an already-backed-up file or recomputes its oldHash from mixed state');
{
  const crypto49 = require('crypto');
  const tpl = freshDir('t49-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B-NEW');
  const p = makeProject(freshDir('t49-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'A-OLD');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'B-OLD');
  const plan49 = { toChange: [
    { rel: 'forge-bin/a.cjs', oldHash: sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs')), newHash: sync.sha256(path.join(tpl, 'forge-bin', 'a.cjs')), isNew: false, overrideClass: null },
    { rel: 'forge-bin/b.cjs', oldHash: sync.sha256(path.join(p, '.claude', 'forge-bin', 'b.cjs')), newHash: sync.sha256(path.join(tpl, 'forge-bin', 'b.cjs')), isNew: false, overrideClass: null },
  ] };
  const backup1 = sync.takeBackup(p, 'batch-resume', plan49, 'v1', '2026-01-01T00:00:00.000Z', {});
  t('first takeBackup call succeeds and records a.cjs old hash as A-OLD', backup1.ok === true && backup1.manifest.files.find((f) => f.rel === 'forge-bin/a.cjs').oldHash === crypto49.createHash('sha256').update('A-OLD').digest('hex'));
  // simulate a CRASH mid-apply: a.cjs already got written to its NEW content, b.cjs never reached
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'A-NEW'); // mixed state on disk now
  // resume: takeBackup is called again for the SAME batch (this is what --resume-batch triggers)
  const backup2 = sync.takeBackup(p, 'batch-resume', plan49, 'v1', '2026-01-02T00:00:00.000Z', {});
  const a2 = backup2.manifest.files.find((f) => f.rel === 'forge-bin/a.cjs');
  const trueOldHashOfA = crypto49.createHash('sha256').update('A-OLD').digest('hex');
  t('S1 FIX: resumed takeBackup does NOT recompute a.cjs oldHash from the mixed (already-applied) state', a2.oldHash === trueOldHashOfA);
  const backupBytesA = fs.readFileSync(path.join(backup2.backupDir, 'forge-bin', 'a.cjs'), 'utf8');
  t('S1 FIX: the PRISTINE backup bytes for a.cjs (A-OLD) were never overwritten by the resumed takeBackup call', backupBytesA === 'A-OLD');
  // Restore only the subset ACTUALLY applied before the simulated crash (a.cjs) — b.cjs was never reached by
  // the writer, so its current bytes still legitimately equal its PRE-sync value; restoring the full plan
  // would trip the (unrelated, correct) B7 divergence guard on b.cjs, which never received any write to
  // "diverge" from. This mirrors production: safeSyncProject always restores subsetManifest(backup.manifest,
  // apply.applied) — only the rels the writer actually reached — never the whole planned set.
  const appliedSubset = sync.subsetManifest(backup2.manifest, ['forge-bin/a.cjs']);
  const rb49 = sync.restoreFromManifest(p, backup2.backupDir, appliedSubset, {});
  t('rollback from the resumed manifest restores a.cjs to the TRUE original (A-OLD), not the mid-crash mixed content', rb49.ok === true && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'A-OLD');
  t('b.cjs (never reached by the simulated crash) is untouched by this restore', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'utf8') === 'B-OLD');
}

console.log('\n50) S2: --unsafe (rawInstall) honors the override allow-list, containment/symlink guard, and unreadable-file refusal');
{
  // (a) override allow-list must be honored even in --unsafe mode
  const tplA = freshDir('t50a-tpl');
  fs.mkdirSync(path.join(tplA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplA, 'forge-bin', 'override.cjs'), 'TEMPLATE-NEW');
  const pA = makeProject(freshDir('t50a-root'), 'proj', null);
  fs.mkdirSync(path.join(pA, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(pA, '.claude', 'config'), { recursive: true });
  fs.writeFileSync(path.join(pA, '.claude', 'forge-bin', 'override.cjs'), 'PROJECT-OWNED-FOREVER');
  fs.writeFileSync(path.join(pA, '.claude', 'config', 'forge-overrides.json'), JSON.stringify({ overrides: ['forge-bin/override.cjs'] }));
  const rA = sync.rawInstall(tplA, pA, { batchId: 'b50a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('S2: rawInstall reports ok:true', rA.ok === true);
  t('S2: the override-declared file is NEVER touched, even by --unsafe', fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'override.cjs'), 'utf8') === 'PROJECT-OWNED-FOREVER');
  t('S2: rawInstall reports it as a skippedOverride', rA.skippedOverrides.includes('forge-bin/override.cjs'));

  // (b) containment/symlink guard must be honored even in --unsafe mode
  const tplB = freshDir('t50b-tpl');
  fs.mkdirSync(path.join(tplB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplB, 'forge-bin', 'tool.cjs'), 'NEW');
  const pB = makeProject(freshDir('t50b-root'), 'proj', null);
  const outsideB = freshDir('t50b-outside');
  const junctionTargetB = path.join(pB, '.claude', 'forge-bin');
  fs.rmSync(junctionTargetB, { recursive: true, force: true });
  let junctionOkB = false;
  try { fs.symlinkSync(outsideB, junctionTargetB, 'junction'); junctionOkB = true; }
  catch (e) { console.log('     (S2b evidence: could not create a junction in this environment — skipping honestly)'); }
  if (junctionOkB) {
    const rB = sync.rawInstall(tplB, pB, { batchId: 'b50b', nowIso: '2026-01-01T00:00:00.000Z' });
    t('S2: rawInstall reports ok:true (nothing safe to change; junctioned file skipped)', rB.ok === true);
    t('S2: nothing was written into the OUTSIDE (junction target) directory, even by --unsafe', !fs.existsSync(path.join(outsideB, 'tool.cjs')));
  } else {
    t('(S2b skipped honestly — junction creation unavailable in this sandbox)', true);
  }

  // (c) unreadable existing file refuses the WHOLE --unsafe install, never treated as "new"
  const tplC = freshDir('t50c-tpl');
  fs.mkdirSync(path.join(tplC, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplC, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
  const pC = makeProject(freshDir('t50c-root'), 'proj', null);
  fs.mkdirSync(path.join(pC, '.claude', 'forge-bin', 'tool.cjs'), { recursive: true }); // a DIRECTORY where a file is expected -> EISDIR
  const rC = sync.rawInstall(tplC, pC, { batchId: 'b50c', nowIso: '2026-01-01T00:00:00.000Z' });
  t('S2: rawInstall REFUSES on an unreadable existing file (ok:false), never treats it as "new"', rC.ok === false);
  t('S2: refusal reason names the unreadable file', /tool\.cjs/.test(rC.reason || ''));
  t('S2: no backup was taken (refused before backup)', !fs.existsSync(path.join(sync.claudeDirOf(pC), 'forge-backups')));
  t('S2: the directory is still there, untouched (never overwritten/deleted)', fs.existsSync(path.join(pC, '.claude', 'forge-bin', 'tool.cjs')) && fs.lstatSync(path.join(pC, '.claude', 'forge-bin', 'tool.cjs')).isDirectory());
}

console.log('\n51) S3: rollback (no --central-backup-root) finds a sync-all-recorded hub even when its OWN default guess would be WRONG for a nested project');
{
  const tpl = freshDir('t51-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const root = freshDir('t51-root');
  const nestedParent = path.join(root, 'group'); // project is NOT a direct child of root
  fs.mkdirSync(nestedParent, { recursive: true });
  const p = makeProject(nestedParent, 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'OLD');
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'))]]);
  const rootHub = path.join(root, '.forge-backup-hub'); // sync-all's OWN derivation: rootDir-based
  const rSync = sync.safeSyncProject(tpl, p, { batchId: 'b51', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: rootHub });
  t('sync ok, central backup recorded under the ROOT-derived hub', rSync.ok === true);

  // simulate a scenario where ONLY the central copy is trustworthy: corrupt the project-local backup FILE
  // bytes (not delete the dir) so loadTrustedManifest must fall through to central, while the project's own
  // manifest.json (which S3 now records centralBackupRoot into) is STILL present and readable.
  fs.writeFileSync(path.join(sync.backupDirFor(p, 'b51'), 'forge-bin', 'tool.cjs'), 'TAMPERED-LOCAL-BACKUP-BYTES');

  // rollback with a WRONG default guess (install/rollback's own dirname(project)-based default — for this
  // NESTED project that resolves to <nestedParent>/.forge-backup-hub, a DIFFERENT, EMPTY directory)
  const wrongGuessedHub = path.join(nestedParent, '.forge-backup-hub');
  t('sanity: the wrongly-guessed hub does not even exist', !fs.existsSync(wrongGuessedHub));
  const rb = sync.rollbackProject(p, 'b51', { centralBackupRoot: wrongGuessedHub }); // NOT marked explicit -> S3 fix should override it
  t('S3 FIX: rollback still succeeds via the CORRECT (recorded) central hub, ignoring the wrong default guess', rb.ok === true && rb.source === 'central');
  t('S3 FIX: the file is restored to the correct pre-sync bytes (OLD)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'OLD');

  // CONTROL: an EXPLICIT (non-default) --central-backup-root must NOT be silently overridden
  const rbExplicitWrong = sync.rollbackProject(p, 'b51', { centralBackupRoot: wrongGuessedHub, centralBackupRootExplicit: true });
  t('CONTROL: marking the guess EXPLICIT means it is honored as-is (no self-healing) -> refuses since that dir has no valid backup', rbExplicitWrong.ok === false);
}

console.log('\n52) S4: findNewerOverlappingBatches also detects a newer batch recorded ONLY in the central hub (local evidence gone)');
{
  const tpl = freshDir('t52-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t52-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  const hub = freshDir('t52-hub');
  sync.safeSyncProject(tpl, p, { batchId: 'batch-old', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub }); // V1 -> V2
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V3');
  sync.safeSyncProject(tpl, p, { batchId: 'batch-new', nowIso: '2026-01-02T00:00:00.000Z', centralBackupRoot: hub }); // V2 -> V3 (the NEWER batch)

  // simulate a central-only recovery: the project's OWN local backup dir for the NEWER batch is gone, so the
  // overlap can ONLY be discovered by scanning central.
  fs.rmSync(path.join(sync.claudeDirOf(p), 'forge-backups', 'batch-new'), { recursive: true, force: true });
  t('sanity: local evidence for the newer batch is now gone', !fs.existsSync(path.join(sync.claudeDirOf(p), 'forge-backups', 'batch-new')));
  t('sanity: central evidence for the newer batch still exists', fs.existsSync(path.join(sync.centralBackupDir(hub, 'batch-new', sync.projectId(p)), 'manifest.json')));

  const rb = sync.rollbackProject(p, 'batch-old', { centralBackupRoot: hub, centralBackupRootExplicit: true });
  t('S4 FIX: rolling back the OLDER batch REFUSES — the newer batch is found via the CENTRAL scan even though local evidence for it is gone', rb.ok === false && Array.isArray(rb.newerOverlaps) && rb.newerOverlaps.some((o) => o.batchId === 'batch-new'));
  t('the project is left at V3, untouched (refusal protected the newer content)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V3');
}

console.log('\n53) S5: adopt REFUSES to silently replace an existing baseline; --force replaces + snapshots the old receipt');
{
  const tpl = freshDir('t53-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'TEMPLATE-A');
  const p = makeProject(freshDir('t53-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'PROJECT-OWNED-A-V1');
  const r1 = sync.adoptProject(tpl, p, { nowIso: '2026-01-01T00:00:00.000Z' });
  t('first adopt succeeds (no prior baseline)', r1.ok === true && r1.priorBaselineCount === 0);
  const receiptAfterFirstAdopt = fs.readFileSync(sync.receiptPath(p), 'utf8');

  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'PROJECT-OWNED-A-V2-DIFFERENT');
  const r2 = sync.adoptProject(tpl, p, { nowIso: '2026-01-02T00:00:00.000Z' });
  t('S5 FIX: second adopt WITHOUT --force REFUSES (ok:false, refused:true)', r2.ok === false && r2.refused === true);
  t('S5 FIX: refusal names the existing baseline count', r2.existingBaseline === true && r2.priorBaselineCount === 1);
  t('S5 FIX: the receipt on disk is UNCHANGED by the refused adopt', fs.readFileSync(sync.receiptPath(p), 'utf8') === receiptAfterFirstAdopt);

  const r3 = sync.adoptProject(tpl, p, { nowIso: '2026-01-03T00:00:00.000Z', force: true });
  t('S5 FIX: --force explicitly allows replacing the baseline', r3.ok === true);
  t('S5 FIX: the NEW baseline reflects the CURRENT (V2) bytes', r3.receipt.knownHashes['forge-bin/a.cjs'] === sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs')));
  t('S5 FIX: the OLD receipt was snapshotted before being replaced (undoable)', !!r3.snapshotPath && fs.existsSync(r3.snapshotPath));
  const snapshotContent = JSON.parse(fs.readFileSync(r3.snapshotPath, 'utf8'));
  t('S5 FIX: the snapshot genuinely holds the FIRST adopt\'s receipt content (undo point)', JSON.stringify(snapshotContent.knownHashes) === JSON.stringify(JSON.parse(receiptAfterFirstAdopt).knownHashes));

  const cliNoForce = runCLIWithTemplate(['adopt', p], tpl);
  t('CLI: adopt without --force exits non-zero on an existing baseline', cliNoForce.status !== 0);
  const cliForce = runCLIWithTemplate(['adopt', p, '--force'], tpl);
  t('CLI: adopt --force exits 0', cliForce.status === 0);
  t('CLI: adopt --force prints the "replaces an existing baseline of N file(s)" warning', /replaces an existing baseline of \d+ file\(s\)/.test(cliForce.stdout));
}

console.log('\n54) S6: rollback / rollback-batch / adopt all take a lock; sync-all holds each project\'s OWN lock too (not just root)');
{
  // (a) adopt refuses while a fresh lock is held on the project
  const tplA = freshDir('t54a-tpl');
  fs.mkdirSync(path.join(tplA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplA, 'forge-bin', 'a.cjs'), 'A');
  const pA = makeProject(freshDir('t54a-root'), 'proj', 0);
  const lockPathA = sync.lockPathFor(sync.claudeDirOf(pA));
  fs.writeFileSync(lockPathA, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const cliAdopt = runCLIWithTemplate(['adopt', pA], tplA);
  t('S6: adopt refuses while a fresh lock is held (exit 1, not a crash)', cliAdopt.status === 1);
  fs.rmSync(lockPathA, { force: true });
  const cliAdopt2 = runCLIWithTemplate(['adopt', pA], tplA);
  t('S6: after the lock is released, adopt succeeds normally', cliAdopt2.status === 0);
  t('S6: adopt cleans up its own lock file (no leftover lock)', !fs.existsSync(lockPathA));

  // (b) rollback refuses while a fresh lock is held on the project
  const tplB = freshDir('t54b-tpl');
  fs.mkdirSync(path.join(tplB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplB, 'forge-bin', 'tool.cjs'), 'NEW');
  const pB = makeProject(freshDir('t54b-root'), 'proj', 0);
  const rSyncB = sync.safeSyncProject(tplB, pB, { batchId: 'b54b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sanity: sync succeeded for the rollback-lock test', rSyncB.ok === true);
  const lockPathB = sync.lockPathFor(sync.claudeDirOf(pB));
  fs.writeFileSync(lockPathB, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const cliRollback = runCLI(['rollback', pB, '--batch', 'b54b']);
  t('S6: rollback refuses while a fresh lock is held (exit 1, not a crash)', cliRollback.status === 1);
  t('S6: the file was NOT rolled back while locked', fs.existsSync(path.join(pB, '.claude', 'forge-bin', 'tool.cjs')));
  fs.rmSync(lockPathB, { force: true });
  const cliRollback2 = runCLI(['rollback', pB, '--batch', 'b54b']);
  t('S6: after the lock is released, rollback succeeds normally', cliRollback2.status === 0);

  // (c) runSyncAll holds EACH project's own lock (not just root) — a pre-existing FRESH lock on one project
  // causes THAT project's own sync to be refused.
  const tplC = freshDir('t54c-tpl');
  fs.mkdirSync(path.join(tplC, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplC, 'forge-bin', 'tool.cjs'), 'NEW');
  const rootC = freshDir('t54c-root');
  const repC = makeProject(rootC, 'rep', 0); makeRealProjectMarker(repC);
  const lockedProjC = makeProject(rootC, 'lockedProj', 0); makeRealProjectMarker(lockedProjC);
  fs.writeFileSync(sync.lockPathFor(sync.claudeDirOf(lockedProjC)), JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const resultC = sync.runSyncAll(tplC, rootC, { projects: [repC, lockedProjC], canaryName: 'rep', batchId: 'b54c', nowIso: '2026-01-01T00:00:00.000Z' });
  const lockedResult = resultC.projects.find((r) => r.projectDir === lockedProjC);
  t('S6 FIX: sync-all could not acquire the locked project\'s OWN lock -> that project\'s sync is refused', !!lockedResult && lockedResult.ok === false && /S6/.test(lockedResult.reason || ''));
  t('S6 FIX: the locked project was never actually written to (still no tool.cjs)', !fs.existsSync(path.join(lockedProjC, '.claude', 'forge-bin', 'tool.cjs')));
  fs.rmSync(sync.lockPathFor(sync.claudeDirOf(lockedProjC)), { force: true });
}

console.log('\n55) S7: EOL normalization operates on RAW BYTES, never a lossy UTF-8 string decode (two different invalid byte sequences must NOT collide)');
{
  // two GENUINELY different byte sequences that a NAIVE .toString('utf8')-based normalizer collapses to the
  // IDENTICAL decoded string (both single invalid bytes -> the SAME U+FFFD replacement char) — confirmed by
  // direct Node probe before writing this test: a.toString('utf8') === b.toString('utf8') is true, yet
  // a.equals(b) is false.
  const bufA = Buffer.concat([Buffer.from('hello '), Buffer.from([0xff]), Buffer.from(' world\n')]);
  const bufB = Buffer.concat([Buffer.from('hello '), Buffer.from([0xc0]), Buffer.from(' world\n')]);
  t('sanity: the two buffers really do have different raw bytes', !bufA.equals(bufB));
  t('sanity: a naive .toString(\'utf8\') decode of both WOULD collide (proves the bug is real, not theoretical)', bufA.toString('utf8') === bufB.toString('utf8'));

  const tpl = freshDir('t55-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), bufA);
  const p = makeProject(freshDir('t55-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), bufB);

  const normA = sync.sha256Normalized(path.join(tpl, 'forge-bin', 'tool.cjs'));
  const normB = sync.sha256Normalized(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  t('S7 FIX: byte-level normalization produces DIFFERENT hashes for genuinely different invalid-byte content (the OLD lossy decode would have made these MATCH)', normA !== normB);

  const pf = sync.preflight(tpl, p);
  t('S7 FIX: this genuine content difference is classified as unknownDrift, NEVER eol_only (never bypasses the drift gate)', pf.unknownDrift.includes('forge-bin/tool.cjs') && !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs' && e.overrideClass === 'eol_only'));

  // CONTROL: normalizeEolBuffer still correctly collapses a GENUINE CRLF-vs-LF difference
  const crlfBuf = Buffer.from('line1\r\nline2\r\n');
  const lfBuf = Buffer.from('line1\nline2\n');
  t('CONTROL: normalizeEolBuffer(CRLF) equals normalizeEolBuffer(LF) for genuinely EOL-only-differing content', sync.normalizeEolBuffer(crlfBuf).equals(sync.normalizeEolBuffer(lfBuf)));
  const crOnlyBuf = Buffer.from('line1\rline2\r');
  t('CONTROL: a lone CR (no paired LF) also normalizes to LF, matching the LF version', sync.normalizeEolBuffer(crOnlyBuf).equals(sync.normalizeEolBuffer(lfBuf)));
}

console.log('\n56) S8: numeric flag validation exits 2; rollbackStatus is a genuinely honest constant; a backup I/O failure refuses cleanly (no crash)');
{
  const p0 = freshDir('t56-flags-root');
  t('S8: --stage-size with a non-numeric value exits 2 (usage error), not a silent NaN-fallback', runCLI(['sync-all', p0, '--stage-size', 'abc']).status === 2);
  t('S8: --doctor-timeout with a non-numeric value exits 2', runCLI(['install', p0, '--doctor-timeout', 'notanumber']).status === 2);
  const validFlagsResult = runCLI(['sync-all', p0, '--stage-size', '5', '--dry-run']);
  t('S8: a VALID numeric --stage-size never triggers the usage-error path (exit code is not 2)', validFlagsResult.status !== 2);

  const tpl = freshDir('t56-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t56-root'), 'proj', 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b56', nowIso: '2026-01-01T00:00:00.000Z' });
  t('S8: rollbackStatus is a genuinely self-descriptive constant, not a bare vague "n/a"', r.receipt.rollbackStatus === 'not_rolled_back_as_of_this_write');

  const tpl2 = freshDir('t56b-tpl');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'tool.cjs'), 'NEW');
  const p2 = makeProject(freshDir('t56b-root'), 'proj', 0);
  const unwritableHubParent = freshDir('t56b-hubparent');
  const fakeHubPath = path.join(unwritableHubParent, 'not-a-directory.txt');
  fs.writeFileSync(fakeHubPath, 'this is a FILE, not a directory — mkdirSync through it must fail'); // ENOTDIR trap
  let threw = false, r2 = null;
  try { r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b56b', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: fakeHubPath }); }
  catch (e) { threw = true; }
  t('S8: an unwritable/invalid central backup hub NEVER throws an uncaught exception out of safeSyncProject', threw === false);
  t('S8: it is instead reported as a clean, honest refusal (ok:false)', !!r2 && r2.ok === false);
  t('S8: nothing was applied to the project (refused before any real write)', !fs.existsSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')));

  const backupResult = sync.takeBackup(p2, 'b56c', { toChange: [{ rel: 'forge-bin/tool.cjs', oldHash: null, newHash: 'x', isNew: true, overrideClass: null }] }, 'v1', '2026-01-01T00:00:00.000Z', { centralBackupRoot: fakeHubPath });
  t('S8: takeBackup itself returns {ok:false, error} instead of throwing', backupResult.ok === false && typeof backupResult.error === 'string');
}

console.log('\n57) test pin: --force-all — sync-all refuses --force-overwrite without the explicit co-flag (previously ZERO test references; deleting the gate left 249/249 green)');
{
  const root57 = freshDir('t57-root');
  t('sync-all --force-overwrite WITHOUT --force-all exits 2 (usage error)', runCLI(['sync-all', root57, '--force-overwrite']).status === 2);
  t('sync-all --force-overwrite WITHOUT --force-all names --force-all in the usage message', /--force-all/.test(runCLI(['sync-all', root57, '--force-overwrite']).stderr));
  t('sync-all --force-overwrite WITH --force-all does NOT exit 2 (usage gate satisfied)', runCLI(['sync-all', root57, '--force-overwrite', '--force-all', '--dry-run']).status !== 2);
  t('sync-all --force-all alone (no --force-overwrite) is not a usage error either', runCLI(['sync-all', root57, '--force-all', '--dry-run']).status !== 2);
}

// =====================================================================================
// 58) M-B3 mutant kill (QA-reported SURVIVOR): fileStatus()'s TWO catch branches must each return
//     kind:'unreadable', NEVER kind:'missing' — (a) readFileSync throws on an existing regular file
//     (lstatSync succeeds), (b) lstatSync itself throws a non-ENOENT error. Section 25 only exercises the
//     st.isDirectory() branch and never reaches either catch block, which is exactly why M-B3 survived the
//     full suite with production code that was already correct. Both sub-tests PROBE the real OS first and
//     report which evidence source they actually used (REAL vs INJECTED), same honesty pattern as F2 (section 15).
// =====================================================================================
console.log('\n58) M-B3: fileStatus() catch branches -> kind:"unreadable" (never "missing"); preflight/safeSyncProject refuse end-to-end');
{
  // ---- 58a: readFileSync throws on an EXISTING regular file while lstatSync still succeeds ----
  {
    const tpl = freshDir('t58a-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
    const p = makeProject(freshDir('t58a-root'), 'proj', 0);
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    const targetPath = path.join(p, '.claude', 'forge-bin', 'tool.cjs');
    fs.writeFileSync(targetPath, 'OLD-CONTENT');
    fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(targetPath)]]);

    // real-OS probe (own scratch fixture, never the actual target): confirm chmodSync does NOT reproduce a
    // read failure on this OS (per addendum note — do not build the test on it), then confirm icacls does.
    const probeDir = freshDir('t58a-probe');
    const probeFile = path.join(probeDir, 'probe.txt');
    fs.writeFileSync(probeFile, 'x'); fs.chmodSync(probeFile, 0o444);
    let chmodBlocks = false;
    try { fs.readFileSync(probeFile); } catch { chmodBlocks = true; }
    fs.chmodSync(probeFile, 0o666);
    t('58a sanity: chmodSync 0o444 alone does NOT block reads on this OS (documented non-repro, not relied upon)', chmodBlocks === false);

    const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + (process.env.USERNAME || '');
    let realDenyWorks = false;
    if (process.env.USERNAME) {
      fs.writeFileSync(probeFile, 'x');
      const denyProbe = spawnSync('icacls', [probeFile, '/deny', user + ':(R)']);
      if (denyProbe.status === 0) {
        try { fs.readFileSync(probeFile); } catch (e) { if (e.code === 'EPERM') realDenyWorks = true; }
        spawnSync('icacls', [probeFile, '/remove:d', user]);
      }
    }

    const usedInjection = !realDenyWorks;
    if (realDenyWorks) {
      const deny = spawnSync('icacls', [targetPath, '/deny', user + ':(R)']);
      t('58a setup: icacls deny actually applied to the fixture file', deny.status === 0);
      try {
        const status = sync.fileStatus(targetPath);
        t('58a REAL EPERM: fileStatus reports kind:"unreadable" (never "missing")', status.kind === 'unreadable');
        const pf = sync.preflight(tpl, p);
        t('58a: preflight classifies it unreadable, NEVER toChange/new', pf.unreadable.some((u) => u.rel === 'forge-bin/tool.cjs') && !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
        const r = sync.safeSyncProject(tpl, p, { batchId: 'b58a', nowIso: '2026-01-01T00:00:00.000Z' });
        t('58a: safeSyncProject REFUSES the whole project (ok:false, refused:true) instead of overwriting it unbacked', r.ok === false && r.refused === true);
      } finally {
        spawnSync('icacls', [targetPath, '/remove:d', user]); // always release the deny ACL, even if an assertion above threw
      }
    } else {
      const origRead = fs.readFileSync;
      fs.readFileSync = function (fp, opts) {
        if (path.resolve(String(fp)) === path.resolve(targetPath)) { const e = new Error('EPERM: operation not permitted (injected)'); e.code = 'EPERM'; throw e; }
        return origRead.call(fs, fp, opts);
      };
      try {
        const status = sync.fileStatus(targetPath);
        t('58a INJECTED EPERM: fileStatus reports kind:"unreadable" (never "missing")', status.kind === 'unreadable');
        const pf = sync.preflight(tpl, p);
        t('58a: preflight classifies it unreadable, NEVER toChange/new', pf.unreadable.some((u) => u.rel === 'forge-bin/tool.cjs') && !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
        const r = sync.safeSyncProject(tpl, p, { batchId: 'b58a', nowIso: '2026-01-01T00:00:00.000Z' });
        t('58a: safeSyncProject REFUSES the whole project (ok:false, refused:true) instead of overwriting it unbacked', r.ok === false && r.refused === true);
      } finally {
        fs.readFileSync = origRead; // always restore the shared fs singleton before any other section runs
      }
    }
    console.log('     (58a evidence source: ' + (usedInjection ? 'INJECTED — OS icacls deny did not reproduce a real read-EPERM in this sandbox' : 'REAL OS EPERM via icacls') + ')');
    t('58a: the fixture file itself was never overwritten/deleted (still OLD-CONTENT, no unbacked write happened)', fs.existsSync(targetPath) && fs.readFileSync(targetPath, 'utf8') === 'OLD-CONTENT');
  }

  // ---- 58b: lstatSync itself throws a non-ENOENT error ----
  {
    const tpl2 = freshDir('t58b-tpl');
    fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl2, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
    const p2 = makeProject(freshDir('t58b-root'), 'proj', 0);

    // real-OS probe (own scratch fixture): a REGULAR FILE sitting where a DIRECTORY is expected mid-path makes
    // lstatSync throw a non-ENOENT error (e.g. ENOTDIR) on some OSes. Probe directly rather than assume — on
    // this Windows/Node combination it was independently confirmed to yield ENOENT instead, so this correctly
    // falls back to injection here; the same test would use the REAL branch on an OS where it yields ENOTDIR.
    const probeDir2 = freshDir('t58b-probe');
    const fileAsParent = path.join(probeDir2, 'forge-bin');
    fs.writeFileSync(fileAsParent, 'FILE-NOT-DIR');
    let probeCode = null;
    try { fs.lstatSync(path.join(fileAsParent, 'tool.cjs')); } catch (e) { probeCode = e.code; }
    const realNonEnoentLstatWorks = probeCode !== null && probeCode !== 'ENOENT';

    let targetPath2, origLstat = null;
    const usedInjection2 = !realNonEnoentLstatWorks;
    if (realNonEnoentLstatWorks) {
      fs.mkdirSync(path.join(p2, '.claude'), { recursive: true });
      // makeProject() already created `.claude/forge-bin` as a DIRECTORY; writing a file at that path throws EISDIR.
      // Measured on the first CI run (ubuntu): this REAL branch had never executed on the author's Windows
      // machine (whose probe yields ENOENT -> injection branch), so the whole suite crashed before its tally.
      fs.rmSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true, force: true });
      fs.writeFileSync(path.join(p2, '.claude', 'forge-bin'), 'FILE-NOT-DIR'); // forge-bin is a FILE, not a dir, here
      targetPath2 = path.join(p2, '.claude', 'forge-bin', 'tool.cjs');
    } else {
      fs.mkdirSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true });
      targetPath2 = path.join(p2, '.claude', 'forge-bin', 'tool.cjs');
      fs.writeFileSync(targetPath2, 'OLD-CONTENT');
      origLstat = fs.lstatSync;
      fs.lstatSync = function (fp, opts) {
        if (path.resolve(String(fp)) === path.resolve(targetPath2)) { const e = new Error('EIO: injected non-ENOENT lstat error (test injection)'); e.code = 'EIO'; throw e; }
        return origLstat.call(fs, fp, opts);
      };
    }
    try {
      const status2 = sync.fileStatus(targetPath2);
      t('58b ' + (usedInjection2 ? 'INJECTED' : 'REAL OS') + ' non-ENOENT lstat error: fileStatus reports kind:"unreadable" (never "missing")', status2.kind === 'unreadable');
      const pf2 = sync.preflight(tpl2, p2);
      t('58b: preflight classifies it unreadable, NEVER toChange/new', pf2.unreadable.some((u) => u.rel === 'forge-bin/tool.cjs') && !pf2.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
      const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b58b', nowIso: '2026-01-01T00:00:00.000Z' });
      t('58b: safeSyncProject REFUSES the whole project (ok:false, refused:true) instead of overwriting it unbacked', r2.ok === false && r2.refused === true);
    } finally {
      if (origLstat) fs.lstatSync = origLstat; // always restore the shared fs singleton before any other section runs
    }
    console.log('     (58b evidence source: ' + (usedInjection2 ? 'INJECTED — this OS\'s file-as-parent-dir probe produced code=' + probeCode + ', not a genuine non-ENOENT error' : 'REAL OS non-ENOENT lstat error via file-as-parent-dir, code=' + probeCode) + ')');
    if (realNonEnoentLstatWorks) {
      t('58b: the "forge-bin"-as-file fixture was never overwritten/deleted', fs.existsSync(path.join(p2, '.claude', 'forge-bin')) && fs.readFileSync(path.join(p2, '.claude', 'forge-bin'), 'utf8') === 'FILE-NOT-DIR');
    } else {
      t('58b: the fixture file itself was never overwritten/deleted (still OLD-CONTENT, no unbacked write happened)', fs.existsSync(targetPath2) && fs.readFileSync(targetPath2, 'utf8') === 'OLD-CONTENT');
    }
  }
}

// =====================================================================================
// 58c) containmentSafe with a base that does NOT exist yet, reached through an 8.3 short-name alias.
// MEASURED on the GitHub windows runner: TEMP there is `C:\Users\RUNNER~1\…`. The dry-run
// dedicated-canary plan came back EMPTY because the target's existing ancestor was realpath'd (long form) while
// the not-yet-existing base fell back to path.resolve (short form) — every file "escaped" its own base.
// =====================================================================================
console.log('\n58c) containmentSafe: not-yet-existing base behind a short-name (8.3) alias');
{
  const longDir = freshDir('t58c-containment-shortname-probe');
  let shortDir = null;
  if (process.platform === 'win32') {
    // Scripting.FileSystemObject.ShortPath is the documented way to obtain the 8.3 alias (cmd's %~sI needs quoting
    // gymnastics that cmd /s mangles); a volume with 8.3 generation disabled returns the long path unchanged.
    const r = spawnSync('powershell', ['-NoProfile', '-Command', "(New-Object -ComObject Scripting.FileSystemObject).GetFolder('" + longDir.replace(/'/g, "''") + "').ShortPath"], { encoding: 'utf8', timeout: 30000 });
    const s = (r.stdout || '').trim().split(/\r?\n/).pop();
    if (r.status === 0 && s && s.toLowerCase() !== longDir.toLowerCase() && /~/.test(s)) shortDir = s;
  }
  if (!shortDir) console.log('     (58c: no 8.3 short-name alias on this host — ' + (process.platform === 'win32' ? '8.3 names disabled for this volume' : process.platform) + '; the long-path assertions still run, the alias ones are reported as skipped)');
  const baseVia = (root) => path.join(root, 'proj', '.claude'); // does NOT exist
  const targetVia = (root) => path.join(root, 'proj', '.claude', 'forge-bin', 'tool.cjs');
  t('58c long path: a not-yet-existing base contains its own not-yet-existing target', sync.containmentSafe(baseVia(longDir), targetVia(longDir)) === true);
  t('58c long path: a target outside the base is still rejected', sync.containmentSafe(baseVia(longDir), path.join(longDir, 'elsewhere', 'x.cjs')) === false);
  if (shortDir) {
    t('58c SHORT-NAME alias (8.3): containment holds — both sides resolve through the same existing ancestor', sync.containmentSafe(baseVia(shortDir), targetVia(shortDir)) === true, shortDir);
    t('58c SHORT-NAME alias: an outside target is still rejected', sync.containmentSafe(baseVia(shortDir), path.join(shortDir, 'elsewhere', 'x.cjs')) === false);
    const tpl = freshDir('t58c-tpl'); fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true }); fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'v1');
    const plan = sync.buildPlan(tpl, path.join(shortDir, 'canary-not-yet-created'), {});
    t('58c SHORT-NAME alias: a dry-run plan for a not-yet-existing project lists the file as NEW, never skipped as an escape (the CI canary regression)', plan.toChange.length === 1 && plan.skipped.length === 0, JSON.stringify({ toChange: plan.toChange.length, skipped: plan.skipped }));
  } else {
    t('58c SHORT-NAME alias assertions skipped honestly (no 8.3 alias on this host)', true);
  }
}

// =====================================================================================
// ADDENDUM G proof ("no global sync"): every fixture directory this suite EVER created (tracked live by
// freshDir(), not asserted after the fact) is actually rooted under os.tmpdir() — real, not just claimed.
// =====================================================================================
console.log('\nG) no-global-sync structural proof');
{
  const tmpRoot = path.resolve(os.tmpdir());
  t('every one of the ' + ALL_FIXTURE_ROOTS.length + ' fixture dirs created this run is under os.tmpdir()', ALL_FIXTURE_ROOTS.length > 0 && ALL_FIXTURE_ROOTS.every((d) => path.resolve(d).startsWith(tmpRoot)));
  t('the real project root (this repo) was never used as a fixture dir', !ALL_FIXTURE_ROOTS.some((d) => path.resolve(d) === path.resolve(__dirname, '..', '..')));
}

// 59) WP2 — the enforcer and the rules it enforces must ship TOGETHER. forge-doctor's agents check fails
// closed when agent-tool-policy.json is missing, and a red doctor is batch-stopping for sync. If the policy
// were left out of SYSTEM, every project would receive the checker without the rules and the first real
// rollout would wedge on its own safety gate. This pins the payload so that can never happen silently.
console.log('\n59) WP2 payload completeness (the checker never ships without its policy)');
{
  const tplDir = path.resolve(__dirname, '..');
  const files = sync.listSystemFiles(tplDir);
  t('agent-tool-policy.json is in the synced SYSTEM file list', files.includes('config/agents/agent-tool-policy.json'));
  t('the checker that reads it (forge-policy.cjs) is synced too', files.includes('forge-bin/forge-policy.cjs'));
  t('the validator that enforces it (forge-doctor.cjs) is synced too', files.includes('forge-bin/forge-doctor.cjs'));
  t('every agent .md the policy governs is synced too', files.filter((f) => f.startsWith('agents/') && f.endsWith('.md')).length >= 18);
}

// =====================================================================================
// 60) CLI sync-all --dry-run PRINTS the plan (regression: it computed the plan but printed nothing,
//     making the preview useless for authorising a real 12-project sync).
// =====================================================================================
console.log('\n60) sync-all --dry-run prints the per-project plan and writes nothing');
{
  const tpl = freshDir('t60-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  const root = freshDir('t60-root');
  const p = makeProject(root, 'projA', 0);
  makeRealProjectMarker(p);
  const before = snapshotTree(root);
  const r = runCLIWithTemplate(['sync-all', root, '--dry-run'], tpl);
  const after = snapshotTree(root);
  t('60a: sync-all --dry-run exits 0', r.status === 0);
  t('60b: it PRINTS the dry-run plan (not silent)', /DRY-RUN/.test(r.stdout || '') && /to-change/.test(r.stdout || ''));
  t('60c: it names the discovered project in the plan', (r.stdout || '').includes('projA'));
  t('60d: dry-run wrote nothing to the root tree', JSON.stringify(before) === JSON.stringify(after));
  t('60e: --json dry-run emits parseable JSON', (() => { const rj = runCLIWithTemplate(['sync-all', root, '--dry-run', '--json'], tpl); try { const o = JSON.parse(rj.stdout); return o.dryRun === true && Array.isArray(o.projects); } catch { return false; } })());
}

// =====================================================================================
// 61) MEDIUM FIX (adversarial break-swarm repro): regressionCheck used to EXEMPT any doctor
//     check the sync itself introduced (absent in the pre-sync doctor's checksOk) as "already red", because
//     `pre[k] === true && post[k] === false` can never be satisfied when pre[k] is undefined. A template
//     shipping a NEW forge-doctor.cjs with a brand-new, already-red check therefore sailed through as
//     alreadyRedSkipped even though nothing was ever green to compare it against. Fixed: `pre[k] ===
//     undefined` (a check the sync just introduced) now counts the same as a green->red flip. The legitimate
//     case — a check that existed in BOTH doctors and was ALREADY red for an unrelated, pre-existing reason —
//     remains correctly exempted (control case below).
// =====================================================================================
console.log('\n61) MEDIUM FIX: a NEW doctor-check the sync itself introduces must NOT be exempted as "already red"');
{
  const crypto61 = require('crypto');

  const oldDoctorSrc = [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:false,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:false,suites:1,passed:1,failed:1}}})); }',
    'process.exit(1);',
  ].join('\n');
  // the template's NEW doctor: same shape PLUS a brand-new, already-red check ("newcheck") — exactly the
  // repro from the adversarial break-swarm finding.
  const newDoctorSrcWithNewCheck = [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:false,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:false,suites:1,passed:1,failed:1},newcheck:{ok:false}}})); }',
    'process.exit(1);',
  ].join('\n');

  // ---- repro: NEW-and-red check introduced by this sync -> must be a real failure, never alreadyRedSkipped ----
  const tpl = freshDir('t61-tpl-repro');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'forge-doctor.cjs'), newDoctorSrcWithNewCheck, 'utf8');

  const root = freshDir('t61-root-repro');
  const p = makeProject(root, 'proj', null); // no auto-stub — this test controls the doctor content directly
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'forge-doctor.cjs'), oldDoctorSrc, 'utf8');
  const oldDoctorHash = crypto61.createHash('sha256').update(fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'forge-doctor.cjs'))).digest('hex');
  // receipt says "the OLD doctor's current bytes ARE what I last wrote here" -> classifies as a clean
  // toChange (not unknown_drift), matching the repro's "receipt's knownHashes bevat de oude doctor-hash".
  fakeReceiptMatchingCurrent(p, [['forge-bin/forge-doctor.cjs', oldDoctorHash]]);

  const r = sync.safeSyncProject(tpl, p, { batchId: 'b61-repro', nowIso: '2026-07-15T00:00:00.000Z', centralBackupRoot: null });
  t('61a: NEW-and-red check introduced by the sync -> safeSyncProject ok:false (was silently ok:true, alreadyRedSkipped, before the fix)', r.ok === false);
  t('61b: rolled back', r.rolledBack === true);
  t('61c: NOT misreported as alreadyRedSkipped', !(r.outcome && r.outcome.alreadyRedSkipped));
  t('61d: regressionCheck itself flags "newcheck" as a regression', sync.regressionCheck(r.preValidation.summary, r.validation.summary).includes('newcheck'));
  t('61e: FORGE_VERSION.json was NEVER stamped (project must never claim the new template version)', !fs.existsSync(path.join(p, '.claude', 'FORGE_VERSION.json')));
  t('61f: the project doctor file is back to the OLD content (rolled back, not left mid-synced)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'forge-doctor.cjs'), 'utf8') === oldDoctorSrc);

  // ---- control: a check that existed in BOTH doctors, already red for an unrelated reason -> still exempted ----
  const newDoctorSrcNoNewCheck = [
    '#!/usr/bin/env node',
    '// v2 bytes differ from oldDoctorSrc so this file is a real toChange, but the check SHAPE is identical',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:false,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:false,suites:1,passed:1,failed:1}}})); }',
    'process.exit(1);',
  ].join('\n');
  const tpl2 = freshDir('t61-tpl-control');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'forge-doctor.cjs'), newDoctorSrcNoNewCheck, 'utf8');

  const root2 = freshDir('t61-root-control');
  const p2 = makeProject(root2, 'proj', null);
  fs.mkdirSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p2, '.claude', 'forge-bin', 'forge-doctor.cjs'), oldDoctorSrc, 'utf8');
  const oldDoctorHash2 = crypto61.createHash('sha256').update(fs.readFileSync(path.join(p2, '.claude', 'forge-bin', 'forge-doctor.cjs'))).digest('hex');
  fakeReceiptMatchingCurrent(p2, [['forge-bin/forge-doctor.cjs', oldDoctorHash2]]);

  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b61-control', nowIso: '2026-07-15T00:00:00.000Z', centralBackupRoot: null });
  t('61g CONTROL: no new check introduced, same check already red both times -> still ok:true (NOT regressed by this fix)', r2.ok === true);
  t('61h CONTROL: correctly reported alreadyRedSkipped', !!(r2.outcome && r2.outcome.alreadyRedSkipped));
  t('61i CONTROL: FORGE_VERSION.json WAS stamped (legitimate sync completed, not blocked)', fs.existsSync(path.join(p2, '.claude', 'FORGE_VERSION.json')));
}

// =====================================================================================
// 62) MEDIUM FIX: regressionCheck (and
//     decideValidationOutcome) must ALSO flag a check that existed and was GREEN pre-sync but is entirely
//     ABSENT post-sync — round 1's fix (section 61) only ever iterated Object.keys(post), so a vanished
//     check could never be seen at all (it never appears in `post`). "A sync that removes a check passes"
//     was the exact bug: a new doctor that silently drops a previously-green check still self-reports a
//     naive ok:true (nothing IT still checks is red), so decideValidationOutcome also needed a second gate
//     on the naive-ok:true path, not just the already-red evidence-backed-fail path section 61 covers.
// =====================================================================================
console.log('\n62) MEDIUM FIX ROUND 2: regressionCheck flags a previously-green check that VANISHED post-sync');
{
  const crypto62 = require('crypto');

  // direct unit coverage exactly as specified: pre {a:true} + post {} (a verdwenen) -> regressie
  const preDirect = { ok: true, checksOk: { a: { ok: true }, node_check: { ok: true } } };
  const postDirect = { ok: true, checksOk: { node_check: { ok: true } } }; // 'a' vanished
  const regressedDirect = sync.regressionCheck(preDirect, postDirect);
  t('62a: regressionCheck flags a vanished-but-was-green check ("a")', regressedDirect.includes('a'));

  // full control matrix from the spec — all pre-existing cases stay correct
  t('62b CONTROL: pre red + post red (same key) -> NOT a regression (already-red)', sync.regressionCheck(
    { ok: false, checksOk: { a: { ok: false } } }, { ok: false, checksOk: { a: { ok: false } } },
  ).length === 0);
  t('62c CONTROL: pre absent + post red -> IS a regression (round-1 behavior preserved)', sync.regressionCheck(
    { ok: true, checksOk: {} }, { ok: false, checksOk: { a: { ok: false } } },
  ).includes('a'));
  t('62d CONTROL: pre red + post absent -> improvement, NOT a regression', sync.regressionCheck(
    { ok: false, checksOk: { a: { ok: false } } }, { ok: true, checksOk: {} },
  ).length === 0);
  t('62e CONTROL: pre red + post green -> improvement, NOT a regression', sync.regressionCheck(
    { ok: false, checksOk: { a: { ok: false } } }, { ok: true, checksOk: { a: { ok: true } } },
  ).length === 0);

  // end-to-end repro: a sync's OWN new doctor silently drops a previously-green check ("special_check") but
  // otherwise reports ok:true (nothing it still checks is red) -> must NOT be waved through as a naive pass.
  const oldDoctorSrc62 = [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:true,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:true,suites:1,passed:1,failed:0},special_check:{ok:true}}})); }',
    'process.exit(0);',
  ].join('\n');
  const newDoctorSrc62VanishedCheck = [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:true,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:true,suites:1,passed:1,failed:0}}})); }',
    'process.exit(0);',
  ].join('\n');

  const tpl62 = freshDir('t62-tpl-repro');
  fs.mkdirSync(path.join(tpl62, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl62, 'forge-bin', 'forge-doctor.cjs'), newDoctorSrc62VanishedCheck, 'utf8');

  const root62 = freshDir('t62-root-repro');
  const p62 = makeProject(root62, 'proj', null);
  fs.mkdirSync(path.join(p62, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p62, '.claude', 'forge-bin', 'forge-doctor.cjs'), oldDoctorSrc62, 'utf8');
  const oldDoctorHash62 = crypto62.createHash('sha256').update(fs.readFileSync(path.join(p62, '.claude', 'forge-bin', 'forge-doctor.cjs'))).digest('hex');
  fakeReceiptMatchingCurrent(p62, [['forge-bin/forge-doctor.cjs', oldDoctorHash62]]);

  const r62 = sync.safeSyncProject(tpl62, p62, { batchId: 'b62-repro', nowIso: '2026-07-15T00:00:00.000Z', centralBackupRoot: null });
  t('62f: a sync whose own new doctor silently drops a previously-green check -> safeSyncProject ok:false (was silently ok:true before this fix)', r62.ok === false);
  t('62g: rolled back', r62.rolledBack === true);
  t('62h: outcome reason names the vanished check', !!(r62.outcome && /special_check/.test(r62.outcome.reason || '')));
  t('62i: FORGE_VERSION.json was NEVER stamped (project must never claim the new template version)', !fs.existsSync(path.join(p62, '.claude', 'FORGE_VERSION.json')));
  t('62j: the project doctor file is back to the OLD content (rolled back, not left mid-synced)', fs.readFileSync(path.join(p62, '.claude', 'forge-bin', 'forge-doctor.cjs'), 'utf8') === oldDoctorSrc62);

  // control: identical check shape on both sides (nothing vanished) -> sync still succeeds normally, proving
  // this fix does NOT introduce a false positive on an ordinary clean sync.
  const newDoctorSrc62Identical = [
    '#!/usr/bin/env node',
    '// v2 bytes differ so this is a real toChange, but the check SHAPE is identical to oldDoctorSrc62',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:true,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:true,suites:1,passed:1,failed:0},special_check:{ok:true}}})); }',
    'process.exit(0);',
  ].join('\n');
  const tpl62b = freshDir('t62-tpl-control');
  fs.mkdirSync(path.join(tpl62b, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl62b, 'forge-bin', 'forge-doctor.cjs'), newDoctorSrc62Identical, 'utf8');

  const root62b = freshDir('t62-root-control');
  const p62b = makeProject(root62b, 'proj', null);
  fs.mkdirSync(path.join(p62b, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p62b, '.claude', 'forge-bin', 'forge-doctor.cjs'), oldDoctorSrc62, 'utf8');
  const oldDoctorHash62b = crypto62.createHash('sha256').update(fs.readFileSync(path.join(p62b, '.claude', 'forge-bin', 'forge-doctor.cjs'))).digest('hex');
  fakeReceiptMatchingCurrent(p62b, [['forge-bin/forge-doctor.cjs', oldDoctorHash62b]]);

  const r62b = sync.safeSyncProject(tpl62b, p62b, { batchId: 'b62-control', nowIso: '2026-07-15T00:00:00.000Z', centralBackupRoot: null });
  t('62k CONTROL: no check vanished (identical check shape both times) -> sync still ok:true (NOT a false positive from this fix)', r62b.ok === true);
  t('62l CONTROL: FORGE_VERSION.json WAS stamped (legitimate sync completed, not blocked)', fs.existsSync(path.join(p62b, '.claude', 'FORGE_VERSION.json')));
}

// =====================================================================================
// 63) WP4 FIX: the dedicated canary was aborting stage 0 on EVERY sync-all run, regardless of
//     template health. Real repro (see forge-sync.cjs's own 2026-07-26 header note): one genuine, non-
//     fabricated doctor test has a real precondition of "at least one real run with events.jsonl exists in
//     this project" — true for every actual Forge project, structurally impossible for a canary that is
//     wiped and recreated empty on every single canary-init/sync-all run. seedCanaryRun (canary-only, opt-in
//     via opts.seedRunForValidation) logs one honest run_started event into the canary's own just-synced
//     forge-runs/ before validation runs. This section proves: (a) the mechanism itself, (b) the exact bug
//     reproduces without the fix, (c) the fix resolves it, (d) the gate still bites a genuinely broken
//     template even with the fix active, (e) end-to-end via runSyncAll's real stage-0 flow, and (f) real
//     (non-canary) projects are completely unaffected — the same doctor requirement still fails them exactly
//     as before, since they never receive opts.seedRunForValidation.
// =====================================================================================
console.log('\n63) WP4 FIX: dedicated canary seeds one real run before validation (forge-capabilities-panel-class precondition)');
{
  // 63a: no forge-dashboard/log-event.cjs synced at all -> clean, silent no-op (never crashes, never fabricates)
  const p63a = makeProject(freshDir('t63a-root'), 'proj', null);
  const r63a = sync.seedCanaryRun(p63a, 'b63a', '2026-01-01T00:00:00.000Z');
  t('63a: ok:false, skipped:true when the project has no log-event.cjs', r63a.ok === false && r63a.skipped === true);
  t('63a: no forge-runs dir was fabricated', !fs.existsSync(path.join(p63a, '.claude', 'forge-runs')));

  // 63b: a real (stubbed but contract-faithful) log-event.cjs present -> seedCanaryRun writes ONE honest,
  // real run_started event through it (never a hand-crafted events.jsonl line bypassing the tool itself).
  const p63b = makeProject(freshDir('t63b-root'), 'proj', null);
  writeStubLogEvent(path.join(p63b, '.claude', 'forge-dashboard'));
  const r63b = sync.seedCanaryRun(p63b, 'b63b', '2026-01-01T00:00:00.000Z');
  t('63b: seedCanaryRun reports ok:true', r63b.ok === true);
  t('63b: exitCode 0 (log-event.cjs accepted the event)', r63b.exitCode === 0);
  t('63b: runId is derived from batchId and sanitized to the allowed run_id charset', /^canary-init-b63b$/.test(r63b.runId));
  const runsDir63b = path.join(p63b, '.claude', 'forge-runs');
  const realRunIds63b = fs.existsSync(runsDir63b)
    ? fs.readdirSync(runsDir63b, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(runsDir63b, e.name, 'events.jsonl'))).map((e) => e.name)
    : [];
  t('63b: a real run directory with a real events.jsonl now exists, matching the returned runId', realRunIds63b.length === 1 && realRunIds63b[0] === r63b.runId);
  const ev63b = JSON.parse(fs.readFileSync(path.join(runsDir63b, r63b.runId, 'events.jsonl'), 'utf8').trim());
  t('63b: the logged event is a real, honest run_started event (never a fabricated pass-claiming type)', ev63b.event_type === 'run_started' && ev63b.run_id === r63b.runId && ev63b.canary === true);

  // 63c: REPRO — a canary-shaped fresh project (no prior forge-runs/ at all), synced WITHOUT
  // opts.seedRunForValidation (mirrors the pre-fix code path / a real project's own syncOpts), against a
  // doctor that has forge-capabilities-panel.test.cjs's exact real precondition -> validation genuinely
  // fails, exactly matching the observed real-world "DEDICATED CANARY FAILED" symptom.
  const tpl63 = freshDir('t63-tpl');
  writeRequiresRealRunDoctor(path.join(tpl63, 'forge-bin'));
  writeStubLogEvent(path.join(tpl63, 'forge-dashboard'));
  writeTrioStubs(tpl63); // the template ships the whole coupled trio
  const root63c = freshDir('t63c-root');
  const p63c = makeProject(root63c, 'proj', null);
  const r63c = sync.safeSyncProject(tpl63, p63c, { batchId: 'b63c', nowIso: '2026-01-01T00:00:00.000Z', allowDegraded: true });
  t('63c REPRO: without seedRunForValidation, a fresh project with this real precondition doctor FAILS validation (the exact pre-fix bug)', r63c.ok === false);
  t('63c REPRO: rolled back cleanly (no half-applied canary left behind)', r63c.rolledBack === true);
  t('63c REPRO: no run was ever seeded (forge-runs stays absent — proves the failure is genuinely the missing precondition, not something else)', !fs.existsSync(path.join(p63c, '.claude', 'forge-runs')));

  // 63d: FIX — the exact SAME setup, but WITH opts.seedRunForValidation:true (mirrors canarySyncOpts) -> the
  // precondition is now honestly satisfied and validation PASSES unconditionally (not merely "exempted as
  // pre-existing" — a real, evidence-backed green).
  const root63d = freshDir('t63d-root');
  const p63d = makeProject(root63d, 'proj', null);
  const r63d = sync.safeSyncProject(tpl63, p63d, { batchId: 'b63d', nowIso: '2026-01-01T00:00:00.000Z', allowDegraded: true, seedRunForValidation: true });
  t('63d FIX: WITH seedRunForValidation, the same doctor now PASSES validation', r63d.ok === true);
  t('63d FIX: canarySeed reports ok:true', !!(r63d.canarySeed && r63d.canarySeed.ok === true));
  t('63d FIX: validation.ok is a genuine, unconditional pass (not an alreadyRedSkipped exemption)', r63d.validation.ok === true && !r63d.outcome.alreadyRedSkipped);
  t('63d FIX: FORGE_VERSION.json was stamped (the project is genuinely considered synced)', fs.existsSync(sync.versionFilePath(p63d)));

  // 63e: GATE STILL BITES — WITH seedRunForValidation:true, a template that is ALSO genuinely broken for an
  // unrelated reason (node_check hard-fails) still FAILS. Seeding a run must never become a blanket bypass.
  const tpl63e = freshDir('t63e-tpl-broken');
  writeRequiresRealRunDoctor(path.join(tpl63e, 'forge-bin'), { alsoBreakNodeCheck: true });
  writeStubLogEvent(path.join(tpl63e, 'forge-dashboard'));
  writeTrioStubs(tpl63e); // R3 / SYNC-13
  const root63e = freshDir('t63e-root');
  const p63e = makeProject(root63e, 'proj', null);
  const r63e = sync.safeSyncProject(tpl63e, p63e, { batchId: 'b63e', nowIso: '2026-01-01T00:00:00.000Z', allowDegraded: true, seedRunForValidation: true });
  t('63e GATE STILL BITES: a genuinely broken template (unrelated node_check failure) still FAILS even with the run seeded', r63e.ok === false);
  t('63e GATE STILL BITES: rolled back cleanly', r63e.rolledBack === true);
  t('63e GATE STILL BITES: the run WAS seeded (proves this is a real regression, not the precondition gap)', !!(r63e.canarySeed && r63e.canarySeed.ok === true));

  // 63f: END-TO-END via runSyncAll's REAL stage-0 (dedicated canary) flow — projects:[] so only stage 0 runs
  // (no real project touched), proving the fix works through the actual production call path, not just
  // safeSyncProject in isolation.
  const root63f = freshDir('t63f-root');
  const r63f = sync.runSyncAll(tpl63, root63f, { projects: [], batchId: 'b63f', nowIso: '2026-01-01T00:00:00.000Z' });
  t('63f END-TO-END: overall batch ok:true (stage 0 no longer aborts)', r63f.ok === true);
  t('63f END-TO-END: dedicated canary itself is ok:true', r63f.dedicatedCanary.ok === true);
  t('63f END-TO-END: dedicated canary carries a successful canarySeed', !!(r63f.dedicatedCanary.canarySeed && r63f.dedicatedCanary.canarySeed.ok === true));
  t('63f END-TO-END: dedicated canary validation.ok is true', r63f.dedicatedCanary.validation.ok === true);

  // 63g: REGRESSION SAFETY — a REAL (non-canary) project, synced through runSyncAll's own representative
  // stage (plain syncOpts, no seedRunForValidation), is completely unaffected by this fix: the exact same
  // "requires a real run" doctor still fails it exactly as it always would have, proving the seed is
  // canary-exclusive and real projects' forge-runs/ history is never touched by this tool.
  const root63g = freshDir('t63g-root');
  const rep63g = makeProject(root63g, 'rep', null);
  makeRealProjectMarker(rep63g);
  const r63g = sync.runSyncAll(tpl63, root63g, { projects: [rep63g], batchId: 'b63g', nowIso: '2026-01-01T00:00:00.000Z' });
  t('63g REGRESSION SAFETY: dedicated canary still passes (seeded)', r63g.dedicatedCanary.ok === true);
  t('63g REGRESSION SAFETY: batch aborts at the REPRESENTATIVE stage (real project never seeded, doctor genuinely fails it)', r63g.ok === false && r63g.aborted === true && r63g.stage === 'representative');
  t('63g REGRESSION SAFETY: the representative result itself is not ok', r63g.projects.length === 1 && r63g.projects[0].ok === false);
  t('63g REGRESSION SAFETY: the real project never had a run seeded into it', !fs.existsSync(path.join(rep63g, '.claude', 'forge-runs')));
}

// =====================================================================================
// 64) INSTALL-DEADLOCK FIX: scaffold seeding — .gitignore snippet + CLAUDE.md stub.
// MEASURED BUG this closes: a fresh install's post-validation doctor runs suites that require the
// project environment (CLAUDE.md present, .gitignore rules for forge-runs/forge-index) which only
// Phase 16 — an AGENT step that can never run before forge-sync finishes — would create. Result: every
// fresh-project install failed validation and rolled back 357 files (reproduced live on the
// "a trading project" target, 2×, and again in a sandbox). The installer must seed the environment
// invariants its own validation checks: append-only .gitignore seeding + create-only CLAUDE.md stub,
// both from the template home (the dir ABOVE the template's .claude content dir).
// =====================================================================================
console.log('\n64) install seeds project scaffold (.gitignore snippet + CLAUDE.md stub) before validation');
{
  const home = path.join(freshDir('t64-tplhome'), 'template');
  const tpl = path.join(home, '.claude');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v64");\n');
  fs.writeFileSync(path.join(home, 'gitignore.snippet'), '# Forge scaffold\n.claude/forge-runs/*/*\n.claude/forge-index/\n!.claude/forge-runs/*/run.json\n');
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# CLAUDE.md stub\n');

  // (a) fresh project: both created, install green
  const pA = makeProject(freshDir('t64-root'), 'projA', 0);
  const rA = sync.safeSyncProject(tpl, pA, { batchId: 'b64a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('64a install succeeds on a fresh project', rA.ok === true);
  t('64a .gitignore created carrying the snippet rules', fs.existsSync(path.join(pA, '.gitignore')) && fs.readFileSync(path.join(pA, '.gitignore'), 'utf8').includes('.claude/forge-index/'));
  t('64a CLAUDE.md stub created', fs.existsSync(path.join(pA, 'CLAUDE.md')));
  t('64a scaffold outcome reported on the result', !!rA.scaffold && rA.scaffold.gitignore === 'created' && rA.scaffold.claude_md === 'created');

  // (b) existing files: .gitignore append-only (custom lines preserved, no duplicates), CLAUDE.md NEVER touched
  const pB = makeProject(freshDir('t64-root2'), 'projB', 0);
  fs.writeFileSync(path.join(pB, '.gitignore'), '# mine\nmy-secret-dir/\n.claude/forge-index/\n');
  fs.writeFileSync(path.join(pB, 'CLAUDE.md'), '# owner content — must never change\n');
  const rB = sync.safeSyncProject(tpl, pB, { batchId: 'b64b', nowIso: '2026-01-01T00:00:00.000Z' });
  const gi64 = fs.readFileSync(path.join(pB, '.gitignore'), 'utf8');
  t('64b existing custom .gitignore lines preserved', rB.ok === true && gi64.includes('my-secret-dir/'));
  t('64b missing snippet rules appended', gi64.includes('.claude/forge-runs/*/*') && gi64.includes('!.claude/forge-runs/*/run.json'));
  t('64b an already-present rule is not duplicated', gi64.split('\n').filter((l) => l.trim() === '.claude/forge-index/').length === 1);
  t('64b existing CLAUDE.md byte-identical (create-only, never merged by the syncer)', fs.readFileSync(path.join(pB, 'CLAUDE.md'), 'utf8') === '# owner content — must never change\n');
  t('64b scaffold outcome says appended + unchanged', !!rB.scaffold && /^appended:/.test(rB.scaffold.gitignore) && rB.scaffold.claude_md === 'unchanged');

  // (c) dry-run seeds NOTHING (zero filesystem writes, as documented)
  const pC = makeProject(freshDir('t64-root3'), 'projC', 0);
  sync.safeSyncProject(tpl, pC, { dryRun: true, batchId: 'b64c' });
  t('64c dry-run seeds nothing', !fs.existsSync(path.join(pC, '.gitignore')) && !fs.existsSync(path.join(pC, 'CLAUDE.md')));

  // (d) a failed validation rolls back CREATED scaffold files too — a rolled-back install may not leave
  // a half-provisioned root behind (appended lines in a PRE-EXISTING .gitignore stay: append-only is safe)
  const pD = makeProject(freshDir('t64-root4'), 'projD', 1);
  const rD = sync.safeSyncProject(tpl, pD, { batchId: 'b64d', nowIso: '2026-01-01T00:00:00.000Z' });
  t('64d failed validation still rolls back the synced files', rD.ok === false && rD.rolledBack === true);
  t('64d created scaffold files are removed on rollback', !fs.existsSync(path.join(pD, '.gitignore')) && !fs.existsSync(path.join(pD, 'CLAUDE.md')));

  // (f) CODEX ADVERSARIAL REVIEW (gpt-5.6-sol) findings #21/#22 — the seeding used to follow
  // a symlinked .gitignore straight out of the project, and undoScaffold deleted by filename alone.
  {
    const pF = makeProject(freshDir('t64-root6'), 'projF', 0);
    const outsideDir = freshDir('t64-outside');
    const outside = path.join(outsideDir, 'victim-gitignore');
    fs.writeFileSync(outside, 'ORIGINAL OUTSIDE CONTENT\n', 'utf8');
    let linked = true;
    try { fs.symlinkSync(outside, path.join(pF, '.gitignore')); } catch { linked = false; } // needs privileges on Windows
    if (linked) {
      const rF = sync.safeSyncProject(tpl, pF, { batchId: 'b64f', nowIso: '2026-01-01T00:00:00.000Z' });
      t('64f a symlinked .gitignore is REFUSED — the installer never writes outside the project through a link',
        fs.readFileSync(outside, 'utf8') === 'ORIGINAL OUTSIDE CONTENT\n');
      t('64f the refusal is reported honestly on the result', !!rF.scaffold && (rF.scaffold.gitignore === 'refused' || (rF.scaffold.errors || []).some((e) => /symlink/.test(e))));
    } else {
      console.log('  SKIP 64f symlink case — creating a symlink needs privileges on this machine (code path still guarded by 64g)');
    }

    // undoScaffold must refuse a path outside the project and a name it never creates
    const pG = makeProject(freshDir('t64-root7'), 'projG', 0);
    const outsideVictim = path.join(freshDir('t64-outside2'), 'victim.txt');
    fs.writeFileSync(outsideVictim, 'KEEP ME\n', 'utf8');
    fs.writeFileSync(path.join(pG, 'not-ours.txt'), 'KEEP ME TOO\n', 'utf8');
    sync.undoScaffold({ created: ['../' + path.basename(path.dirname(outsideVictim)) + '/victim.txt', 'not-ours.txt', path.join('..', 'escape.txt')] }, pG);
    t('64g undoScaffold refuses a traversal path (file outside the project survives)', fs.existsSync(outsideVictim));
    t('64g undoScaffold refuses a name it never creates (unrelated project file survives)', fs.existsSync(path.join(pG, 'not-ours.txt')));
  }

  // (e) a template home without scaffold assets degrades honestly (reported, never a crash)
  const bareHome = path.join(freshDir('t64-bare'), 'template');
  const tplBare = path.join(bareHome, '.claude');
  fs.mkdirSync(path.join(tplBare, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplBare, 'forge-bin', 'tool.cjs'), 'console.log("v64e");\n');
  const pE = makeProject(freshDir('t64-root5'), 'projE', 0);
  const rE = sync.safeSyncProject(tplBare, pE, { batchId: 'b64e', nowIso: '2026-01-01T00:00:00.000Z' });
  t('64e missing scaffold assets degrade honestly to template-missing', rE.ok === true && !!rE.scaffold && rE.scaffold.gitignore === 'template-missing' && rE.scaffold.claude_md === 'template-missing');
}

// =====================================================================================
// 65) THE INSTALL'S COMMIT RECORD IS ATOMIC, AND THE VERSION STAMP IS THE COMMIT MARKER
//     (broad Codex audit #22)
// -------------------------------------------------------------------------------------
// The version file and the receipt were two separate NON-atomic in-place writes after validation,
// outside any rollback protection, with the VERSION written FIRST. Two real failure modes:
//   (1) a reader that opens either file while it is being rewritten sees a truncated/torn file;
//   (2) a crash between them stamps "synced to X" while the receipt — which carries the knownHashes
//       drift baseline AND the backupRef needed to undo this very sync — is missing. The project then
//       looks current while its audit trail and its undo pointer are gone.
// Both are now closed: writeAtomic (temp + rename) for every write, and the receipt is committed
// BEFORE the version stamp so a crash in between leaves a re-syncable project, not a false "current".
// =====================================================================================
console.log('\n65) commit record is atomic + version stamp written last (audit #22)');
{
  // (a) a concurrent reader NEVER sees a torn receipt — real overlapping writer process, both directions.
  //     The control arm proves this filesystem CAN produce a torn read, so arm (a) is real evidence and
  //     not a test that would stay green with the atomic rename reverted.
  const atomicDir = freshDir('t65-atomic');
  const syncPath = path.join(__dirname, 'forge-sync.cjs').replace(/\\/g, '/');
  const payload = 'x'.repeat(400000); // big enough that an in-place write has a visible window
  const runArm = (mode) => {
    const proj = path.join(atomicDir, mode);
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    const f = sync.receiptPath(proj);
    fs.writeFileSync(f, JSON.stringify({ seed: true }));
    const writer = path.join(atomicDir, 'writer-' + mode + '.cjs');
    fs.writeFileSync(writer, [
      "const fs=require('fs');",
      "const S=require('" + syncPath + "');",
      "const proj=" + JSON.stringify(proj) + ", f=" + JSON.stringify(f) + ", big=" + JSON.stringify(payload) + ";",
      "const end=Date.now()+1500;",
      "while(Date.now()<end){",
      mode === 'atomic'
        ? "  S.writeReceipt(proj,{templateVersionTo:'2.0.0',filler:big});S.writeReceipt(proj,{templateVersionTo:'2.0.0'});"
        : "  fs.writeFileSync(f, JSON.stringify({templateVersionTo:'2.0.0',filler:big}));fs.writeFileSync(f, JSON.stringify({templateVersionTo:'2.0.0'}));",
      "}",
    ].join('\n'), 'utf8');
    const child = spawn(process.execPath, [writer], { stdio: 'ignore' });
    let reads = 0, torn = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); reads++; } catch { torn++; }
    }
    try { child.kill(); } catch { /* already gone */ }
    return { reads, torn };
  };
  const atomicArm = runArm('atomic');
  t('65a the reader actually raced the writer (>50 successful reads, otherwise this proves nothing)', atomicArm.reads > 50);
  t('65a a concurrent reader NEVER sees a torn receipt (' + atomicArm.torn + ' torn of ' + (atomicArm.reads + atomicArm.torn) + ')', atomicArm.torn === 0);
  const naiveArm = runArm('naive');
  if (naiveArm.torn === 0) {
    console.log('  SKIP 65a control arm — this filesystem produced no torn read even with a plain in-place write, so arm (a) is not conclusive HERE; reported, not glossed over');
  } else {
    t('65a control arm: the same race WITHOUT the atomic rename IS caught mid-write (' + naiveArm.torn + ' torn) — arm (a) is real evidence', naiveArm.torn > 0);
  }

  // (b) THE ORDERING PROOF. Block the receipt path with a directory so committing the receipt cannot
  //     succeed, then sync. With the receipt written LAST (the old order) the project would already carry
  //     the NEW version stamp — "synced" with no receipt. With the receipt written FIRST, the stamp is
  //     never reached and the project still reads its OLD version, so the next /forge simply re-syncs it.
  const tplB = freshDir('t65-tpl');
  fs.mkdirSync(path.join(tplB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplB, 'forge-bin', 'tool.cjs'), 'console.log("v65");\n');
  const pB = makeProject(freshDir('t65-root'), 'projB', 0);
  fs.writeFileSync(sync.versionFilePath(pB), JSON.stringify({ forge_version: 'OLD-0.0.0' }, null, 2) + '\n', 'utf8');
  fs.mkdirSync(sync.receiptPath(pB), { recursive: true }); // a directory here: rename-onto-dir always fails
  let threw = null;
  try { sync.safeSyncProject(tplB, pB, { batchId: 'b65b', nowIso: '2026-01-01T00:00:00.000Z' }); }
  catch (e) { threw = e; }
  t('65b a receipt that cannot be committed surfaces as a real error, never a silent success', threw !== null);
  const stamped = JSON.parse(fs.readFileSync(sync.versionFilePath(pB), 'utf8'));
  t('65b the project is NOT stamped with the new version when the receipt could not be written (the version stamp is the commit marker, written LAST)', stamped.forge_version === 'OLD-0.0.0');

  // (c) a failed atomic write leaves no stray temp file behind in the project's .claude/
  const leftovers = fs.readdirSync(path.join(pB, '.claude')).filter((n) => n.endsWith('.tmp'));
  t('65c a failed atomic write cleans up its own temp file (no .tmp left in .claude/)', leftovers.length === 0);

  // (d) the happy path still writes BOTH, and they agree — so "fixing" (b) by dropping a write is caught
  const pD = makeProject(freshDir('t65-root2'), 'projD', 0);
  const rD = sync.safeSyncProject(tplB, pD, { batchId: 'b65d', nowIso: '2026-01-01T00:00:00.000Z' });
  t('65d the sync succeeded', rD.ok === true);
  const verD = JSON.parse(fs.readFileSync(sync.versionFilePath(pD), 'utf8'));
  const recD = sync.readReceipt(pD);
  t('65d both the version stamp and the receipt exist after a successful sync', !!verD.forge_version && !!recD);
  t('65d the stamped version and the receipt agree on what was installed', recD.templateVersionTo === verD.forge_version);
  t('65d no temp file survives a successful sync either', fs.readdirSync(path.join(pD, '.claude')).filter((n) => n.endsWith('.tmp')).length === 0);
}

// =====================================================================================
// 66) THE INSTALL MAY NOT BE APPROVED BY A GATE THE PROJECT ITSELF AUTHORED
//     (broad Codex audit #2)
// -------------------------------------------------------------------------------------
// Validation ran `<project>/.claude/forge-bin/forge-doctor.cjs` — a file this same sync had just
// written. Fine while that really is the TEMPLATE's doctor, but system files can legally be SKIPPED
// (a forge-overrides.json entry, unresolved unknown_drift, a conflict), and a skipped doctor is the
// project's own. A project holding a stub doctor that prints plausible JSON and exits 0 would approve
// every future sync into itself and the receipt would read "validated". Two changes close it:
//   - the doctor about to run is hashed against the template's; only a byte-identical one is trusted,
//     and a project-local doctor's pass is DEGRADED with the reason said out loud;
//   - the installer runs its own syntax gate over every .cjs it wrote, in its own process, ALWAYS —
//     the one piece of evidence no doctor can fake, and no doctor verdict can override it.
// =====================================================================================
console.log('\n66) the gate may not be authored by the thing it gates (audit #2)');
{
  const mkTpl = (name) => {
    const tpl = freshDir(name);
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v66");\n');
    return tpl;
  };
  // The template's canonical doctor. writeDoctorStub writes into <dir>/.claude/forge-bin, so give it a
  // home whose .claude IS the template dir.
  const tplHome = freshDir('t66-tplhome');
  const tplA = path.join(tplHome, '.claude');
  fs.mkdirSync(path.join(tplA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplA, 'forge-bin', 'tool.cjs'), 'console.log("v66");\n');
  writeDoctorStub(tplHome, 0);

  // (a) byte-identical to the template = the trusted gate
  const pA = makeProject(freshDir('t66-root1'), 'projA', null);
  fs.mkdirSync(path.join(pA, '.claude', 'forge-bin'), { recursive: true });
  fs.copyFileSync(path.join(tplA, 'forge-bin', 'forge-doctor.cjs'), path.join(pA, '.claude', 'forge-bin', 'forge-doctor.cjs'));
  const provA = sync.doctorProvenance(pA, tplA);
  t('66a a doctor byte-identical to the template is recognised as the canonical gate', provA.kind === 'template');
  const vA = sync.runValidation(pA, { toChange: [] }, { templateDir: tplA });
  t('66a a template doctor validates WITHOUT being degraded', vA.ok === true && !vA.degraded && vA.doctorProvenance === 'template');

  // (b) the project kept its OWN doctor: the pass is degraded and says why
  const pB = makeProject(freshDir('t66-root2'), 'projB', 0);
  writeDoctorStub(pB, 0, 'var projectLocalMarker = 1;'); // the project's OWN doctor: same verdict, different bytes
  const provB = sync.doctorProvenance(pB, tplA);
  t('66b a doctor that differs from the template is flagged project-local', provB.kind === 'project-local');
  const vB = sync.runValidation(pB, { toChange: [] }, { templateDir: tplA });
  t('66b a project-authored doctor still reports ok but is DEGRADED, never a clean pass', vB.ok === true && vB.degraded === true);
  t('66b the reason names the real problem instead of hiding it', /not the template doctor/.test(vB.reason || ''));

  // (c) the installer's own syntax gate cannot be overridden by a doctor that says everything is fine
  const pC = makeProject(freshDir('t66-root3'), 'projC', 0);
  fs.mkdirSync(path.join(pC, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pC, '.claude', 'forge-bin', 'broken.cjs'), 'function ( { syntax error <<<\n', 'utf8');
  const vC = sync.runValidation(pC, { toChange: [{ rel: 'forge-bin/broken.cjs' }] }, { templateDir: tplA });
  t('66c a just-synced .cjs that does not parse FAILS validation even though the doctor exits 0', vC.ok === false);
  t('66c the failure is attributed to the installer, not to the doctor', vC.tool === 'installer-syntax-gate' && /installer checked this itself/.test(vC.reason || ''));
  t('66c the offending file is named', (vC.syntaxGate.failures || []).includes('forge-bin/broken.cjs'));

  // (d) every validation result carries the installer-owned evidence, so a receipt can never imply a
  //     check that did not happen
  const pD = makeProject(freshDir('t66-root4'), 'projD', 0);
  fs.mkdirSync(path.join(pD, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pD, '.claude', 'forge-bin', 'ok.cjs'), 'module.exports = 1;\n', 'utf8');
  const vD = sync.runValidation(pD, { toChange: [{ rel: 'forge-bin/ok.cjs' }] }, { templateDir: tplA });
  t('66d the syntax gate result is recorded on the validation (count + zero failures)', !!vD.syntaxGate && vD.syntaxGate.checked === 1 && vD.syntaxGate.failures.length === 0);
  t('66d the doctor provenance is recorded on the validation', typeof vD.doctorProvenance === 'string' && vD.doctorProvenance.length > 0);

  // (e) end-to-end: a project whose doctor is an EXPECTED OVERRIDE (so the sync must not replace it)
  //     cannot silently self-approve its own install
  const tplE = mkTpl('t66-tpl-e');
  fs.mkdirSync(path.join(tplE, 'forge-bin'), { recursive: true });
  fs.copyFileSync(path.join(tplA, 'forge-bin', 'forge-doctor.cjs'), path.join(tplE, 'forge-bin', 'forge-doctor.cjs'));
  const pE = makeProject(freshDir('t66-root5'), 'projE', 0);
  writeDoctorStub(pE, 0, 'var projectLocalMarker = 1;'); // a genuinely DIFFERENT doctor than the template's
  fs.mkdirSync(path.join(pE, '.claude', 'config'), { recursive: true });
  fs.writeFileSync(path.join(pE, '.claude', 'config', 'forge-overrides.json'),
    JSON.stringify({ expected_overrides: ['forge-bin/forge-doctor.cjs'] }, null, 2) + '\n', 'utf8');
  const rE = sync.safeSyncProject(tplE, pE, { batchId: 'b66e', nowIso: '2026-01-01T00:00:00.000Z' });
  const doctorStillProjects = sync.doctorProvenance(pE, tplE).kind;
  if (doctorStillProjects === 'project-local') {
    t('66e a protected project-local doctor makes its own install DEGRADED, not a clean pass',
      !!rE.validation && rE.validation.degraded === true && /not the template doctor/.test(rE.validation.reason || ''));
  } else {
    console.log('  SKIP 66e — this fixture\'s override allowlist did not protect the doctor (provenance "' + doctorStillProjects
      + '"), so the end-to-end case is not set up here; the unit-level proof is 66b');
  }
}

// =====================================================================================
// 67) SYNC-TRANSACTIONALITEIT — resume verliest geen rollback-bereik, de scaffold-append
//     is omkeerbaar, en containment geldt op het SCHRIJFMOMENT (audits #19/#21/#24)
// =====================================================================================
console.log('\n67) resume-manifest-unie + omkeerbare scaffold-append + containment bij schrijven');
{
  const crypto67 = require('crypto');
  const sha = (s) => crypto67.createHash('sha256').update(s).digest('hex');

  // (a) AUDIT #19 — het echte verlies-scenario: na een crash-mid-apply hercalculeert een resume het plan
  //     tegen de GEMIXTE schijf; het al geschreven bestand valt uit het plan en viel daarmee uit het
  //     manifest — rollback herstelde het nooit meer. Het manifest is nu een UNIE met de vorige poging.
  const tplA = freshDir('t67a-tpl');
  fs.mkdirSync(path.join(tplA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplA, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tplA, 'forge-bin', 'b.cjs'), 'B-NEW');
  const pA = makeProject(freshDir('t67a-root'), 'projA', null);
  fs.mkdirSync(path.join(pA, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pA, '.claude', 'forge-bin', 'a.cjs'), 'A-OLD');
  fs.writeFileSync(path.join(pA, '.claude', 'forge-bin', 'b.cjs'), 'B-OLD');
  const planFull = { toChange: [
    { rel: 'forge-bin/a.cjs', oldHash: sha('A-OLD'), newHash: sha('A-NEW'), isNew: false, overrideClass: null },
    { rel: 'forge-bin/b.cjs', oldHash: sha('B-OLD'), newHash: sha('B-NEW'), isNew: false, overrideClass: null },
  ] };
  const b1 = sync.takeBackup(pA, 'b67a', planFull, 'v1', '2026-01-01T00:00:00.000Z', {});
  t('67a eerste poging backupt beide bestanden', b1.ok === true && b1.manifest.files.length === 2);
  // crash mid-apply: a.cjs is al geschreven, b.cjs nooit bereikt
  fs.writeFileSync(path.join(pA, '.claude', 'forge-bin', 'a.cjs'), 'A-NEW');
  // resume herberekent het plan tegen de gemixte schijf — a.cjs hasht nu gelijk aan de template
  const planResumed = { toChange: [
    { rel: 'forge-bin/b.cjs', oldHash: sha('B-OLD'), newHash: sha('B-NEW'), isNew: false, overrideClass: null },
  ] };
  const b2 = sync.takeBackup(pA, 'b67a', planResumed, 'v1', '2026-01-02T00:00:00.000Z', {});
  const aEntry = b2.manifest.files.find((f) => f.rel === 'forge-bin/a.cjs');
  t('67a UNIE: het al-toegepaste bestand blijft in het manifest van de hervatte poging, met zijn ECHTE oldHash',
    !!aEntry && aEntry.oldHash === sha('A-OLD'));
  t('67a de pristine backup-bytes van de eerste poging zijn er nog', fs.readFileSync(path.join(b2.backupDir, 'forge-bin', 'a.cjs'), 'utf8') === 'A-OLD');
  const rbA = sync.restoreFromManifest(pA, b2.backupDir, b2.manifest, {});
  t('67a rollback van de hervatte batch herstelt OOK het bestand dat uit het nieuwe plan viel',
    rbA.ok === true && fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'A-OLD');
  t('67a b.cjs is ook hersteld', fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'b.cjs'), 'utf8') === 'B-OLD');

  // (b) AUDIT #21 — de .gitignore-append is omkeerbaar: een gefaalde install laat het Forge-blok niet
  //     achter in de .gitignore van de owner. Template-doctor faalt post-sync (pre was groen) -> rollback.
  const homeB = freshDir('t67b-home');
  const tplB = path.join(homeB, '.claude');
  fs.mkdirSync(path.join(tplB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplB, 'forge-bin', 'tool.cjs'), 'console.log("v67");\n');
  fs.writeFileSync(path.join(homeB, 'gitignore.snippet'), '.claude/forge-runs/*/*\n!.claude/forge-runs/*/run.json\n');
  const pB = makeProject(freshDir('t67b-root'), 'projB', 0); // pre-sync doctor: groen
  fs.writeFileSync(path.join(pB, '.gitignore'), 'node_modules\n', 'utf8');
  // de TEMPLATE doctor is rood: post-sync validatie faalt gegarandeerd (echte regressie, geen already-red)
  fs.mkdirSync(path.join(tplB, 'forge-bin'), { recursive: true });
  writeDoctorStub(path.join(freshDir('t67b-stubhome'), 'x'), 1); // niet gebruikt; echte stub hieronder
  fs.writeFileSync(path.join(tplB, 'forge-bin', 'forge-doctor.cjs'), [
    '#!/usr/bin/env node',
    'var args=process.argv.slice(2);',
    'if(args.indexOf("--json")!==-1){console.log(JSON.stringify({ok:false,checks:{node_check:{ok:true,total:50,failed:0},tests:{ok:false,suites:5,passed:19,failed:1}}}));}',
    'process.exit(1);',
  ].join('\n'), 'utf8');
  const rB = sync.safeSyncProject(tplB, pB, { batchId: 'b67b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('67b de install faalt en rolt terug (validatie-regressie)', rB.ok === false && rB.rolledBack === true);
  t('67b de .gitignore is BYTE-GELIJK aan voor de install — het Forge-blok is teruggedraaid',
    fs.readFileSync(path.join(pB, '.gitignore'), 'utf8') === 'node_modules\n');

  // (b2) een owner-edit NA de append wordt nooit geclobberd door de revert
  const pB2 = makeProject(freshDir('t67b2-root'), 'projB2', 0);
  fs.writeFileSync(path.join(pB2, '.gitignore'), 'dist\n', 'utf8');
  const scaffolded = sync.seedProjectScaffold(tplB, pB2);
  t('67b2 de seed rapporteert de append + draagt de undo-informatie', /^appended:/.test(scaffolded.gitignore)
    && typeof scaffolded.gitignorePrior === 'string' && typeof scaffolded.gitignoreAppended === 'string');
  fs.appendFileSync(path.join(pB2, '.gitignore'), 'owner-edit-after-seed\n', 'utf8');
  sync.undoScaffold(scaffolded, pB2);
  const gi2 = fs.readFileSync(path.join(pB2, '.gitignore'), 'utf8');
  t('67b2 een bestand dat de owner intussen bewerkte blijft ONaangeraakt (nooit een edit clobberen om de onze terug te draaien)',
    gi2.includes('owner-edit-after-seed') && gi2.includes('.claude/forge-runs/*/*'));

  // (b3) de crash-case: een LATERE handmatige rollback (alleen het manifest) draait de scaffold ook terug
  const pB3 = makeProject(freshDir('t67b3-root'), 'projB3', 0);
  fs.writeFileSync(path.join(pB3, '.gitignore'), 'coverage\n', 'utf8');
  const tplC = path.join(freshDir('t67b3-home'), '.claude');
  fs.mkdirSync(path.join(tplC, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplC, 'forge-bin', 'tool.cjs'), 'console.log("v67c");\n');
  fs.writeFileSync(path.join(path.dirname(tplC), 'gitignore.snippet'), '.claude/forge-backups/\n');
  fs.writeFileSync(path.join(path.dirname(tplC), 'CLAUDE.md'), '# stub\n');
  const rB3 = sync.safeSyncProject(tplC, pB3, { batchId: 'b67b3', nowIso: '2026-01-01T00:00:00.000Z' });
  t('67b3 de sync slaagde (doctor groen)', rB3.ok === true);
  t('67b3 het manifest draagt de scaffold-undo-informatie', !!rB3.backup && (() => {
    const m = JSON.parse(fs.readFileSync(path.join(rB3.backup.backupDir, 'manifest.json'), 'utf8'));
    return m.scaffold && typeof m.scaffold.gitignorePrior === 'string' && Array.isArray(m.scaffold.created);
  })());
  const rbB3 = sync.rollbackProject(pB3, 'b67b3', {});
  t('67b3 een latere rollback (crash-pad: alleen het manifest beschikbaar) draait de append terug',
    rbB3.ok === true && fs.readFileSync(path.join(pB3, '.gitignore'), 'utf8') === 'coverage\n');
  t('67b3 en verwijdert het gecreeerde CLAUDE.md-stub weer', !fs.existsSync(path.join(pB3, 'CLAUDE.md')));

  // (c) AUDIT #24 — containment geldt op het SCHRIJFMOMENT: een map die na plan-tijd een junction naar
  //     buiten het project wordt, stopt de apply; er lekt geen byte naar buiten.
  const tplD = freshDir('t67c-tpl');
  fs.mkdirSync(path.join(tplD, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplD, 'forge-bin', 'tool.cjs'), 'PAYLOAD-67');
  const pD = makeProject(freshDir('t67c-root'), 'projD', null);
  const outside = freshDir('t67c-outside');
  const plan = { toChange: [{ rel: 'forge-bin/tool.cjs', oldHash: null, newHash: sha('PAYLOAD-67'), isNew: true, overrideClass: null }] };
  // NA plan-tijd: .claude/forge-bin wordt een junction naar buiten (junctions vergen geen admin op Windows)
  let junctionOk = true;
  try { fs.symlinkSync(outside, path.join(pD, '.claude', 'forge-bin'), 'junction'); }
  catch { junctionOk = false; }
  if (junctionOk) {
    const apply = sync.applyPlanSafely(tplD, pD, plan);
    t('67c de apply WEIGERT wanneer het pad op schrijfmoment door een junction naar buiten wijst',
      apply.ok === false && /containment guard tripped at write time/.test(apply.error || ''));
    t('67c er is GEEN byte buiten het project geschreven', !fs.existsSync(path.join(outside, 'tool.cjs')));
  } else {
    console.log('  SKIP 67c — junction aanmaken lukte niet op deze machine; de guard-code is dezelfde als de geteste refusal-tak');
  }
}

// =====================================================================================
// 68) CODEX RONDE-3B — corrupt transactielog weigeren · containment op RESTORE-moment ·
//     scaffold-undo eerlijk gerapporteerd (bevindingen #5/#7/#8 van de verse review)
// =====================================================================================
console.log('\n68) ronde-3b: corrupt manifest · restore-guards · eerlijke scaffold-undo');
{
  const crypto68 = require('crypto');
  const sha68 = (s) => crypto68.createHash('sha256').update(s).digest('hex');

  // (a) #5 — een BESTAAND maar onparseerbaar manifest is een beschadigd transactielog, geen eerste poging
  const tplA = freshDir('t68a-tpl');
  fs.mkdirSync(path.join(tplA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplA, 'forge-bin', 'a.cjs'), 'A68');
  const pA = makeProject(freshDir('t68a-root'), 'projA', null);
  const bdirA = path.join(pA, '.claude', 'forge-backups', 'b68a');
  fs.mkdirSync(bdirA, { recursive: true });
  fs.writeFileSync(path.join(bdirA, 'manifest.json'), '{ "batchId": "b68a", "files": [ TRUNCA', 'utf8'); // half geschreven
  const planA = { toChange: [{ rel: 'forge-bin/a.cjs', oldHash: null, newHash: sha68('A68'), isNew: true, overrideClass: null }] };
  const rA = sync.takeBackup(pA, 'b68a', planA, 'v1', '2026-01-01T00:00:00.000Z', {});
  t('68a een corrupt bestaand manifest wordt GEWEIGERD (ok:false), nooit stil als eerste poging behandeld',
    rA.ok === false && /corrupt|unreadable/.test(rA.error || ''));

  // (b) #8 — containment geldt ook op het RESTORE-moment
  const pB = makeProject(freshDir('t68b-root'), 'projB', null);
  fs.mkdirSync(path.join(pB, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pB, '.claude', 'forge-bin', 'x.cjs'), 'X-OLD');
  const bdirB = path.join(pB, '.claude', 'forge-backups', 'b68b');
  fs.mkdirSync(path.join(bdirB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(bdirB, 'forge-bin', 'x.cjs'), 'X-OLD');
  const manifestB = { batchId: 'b68b', files: [{ rel: 'forge-bin/x.cjs', oldHash: sha68('X-OLD'), newHash: sha68('X-NEW'), existed: true }] };
  // NA het plan: forge-bin wordt een junction naar buiten
  const outside = freshDir('t68b-outside');
  fs.rmSync(path.join(pB, '.claude', 'forge-bin'), { recursive: true, force: true });
  let junctionOk = true;
  try { fs.symlinkSync(outside, path.join(pB, '.claude', 'forge-bin'), 'junction'); } catch { junctionOk = false; }
  if (junctionOk) {
    const rB = sync.restoreFromManifest(pB, bdirB, manifestB, {});
    t('68b restore door een junction naar buiten wordt GEWEIGERD als failed entry', rB.ok === false && rB.partial === true
      && rB.failed.length === 1 && /containment guard tripped at restore time/.test(rB.failed[0].reason));
    t('68b er is GEEN byte buiten het project hersteld', !fs.existsSync(path.join(outside, 'x.cjs')));
  } else {
    console.log('  SKIP 68b — junction aanmaken lukte niet op deze machine');
  }

  // (c) #7 — de late scaffold-undo verwijdert alleen ONZE bytes en rapporteert eerlijk
  const pC = makeProject(freshDir('t68c-root'), 'projC', null);
  fs.writeFileSync(path.join(pC, 'CLAUDE.md'), 'OWNER HEEFT DIT HERSCHREVEN\n', 'utf8');
  const undone = sync.undoScaffold({
    created: ['CLAUDE.md'],
    createdHashes: { 'CLAUDE.md': sha68('# stub van forge\n') }, // wat WIJ ooit schreven — niet wat er nu staat
    errors: [],
  }, pC);
  t('68c een created bestand dat de owner herschreef wordt BEWAARD en als owner-werk gerapporteerd',
    fs.existsSync(path.join(pC, 'CLAUDE.md')) && undone.removedCreated.length === 0
    && undone.keptForeign.length === 1 && /owner work/.test(undone.keptForeign[0]));
  const pD = makeProject(freshDir('t68d-root'), 'projD', null);
  fs.writeFileSync(path.join(pD, 'CLAUDE.md'), '# stub van forge\n', 'utf8');
  const undone2 = sync.undoScaffold({
    created: ['CLAUDE.md'],
    createdHashes: { 'CLAUDE.md': sha68('# stub van forge\n') },
    errors: [],
  }, pD);
  t('68c exact ONZE bytes worden wel verwijderd, en dat staat in het resultaat',
    !fs.existsSync(path.join(pD, 'CLAUDE.md')) && undone2.removedCreated.includes('CLAUDE.md'));
}


// =====================================================================================
// 69) copyNoFollow — DE LEAF-TOCTOU IS DICHT (uitgesteld punt 3, gesloten 2026-08-06)
// -------------------------------------------------------------------------------------
// fs.copyFileSync volgt symlinks/junctions; tussen de lstat-guard en de copy zat een venster waarin
// een link op het DOEL kon verschijnen — de "gecheckte" write landde dan buiten het project. copyNoFollow
// schrijft eerst naar een verse 'wx'-tempnaam (kan per constructie nooit een bestaande link zijn) en
// vervangt daarna de eindcomponent via rename — de link wordt VERVANGEN, nooit gevolgd.
// =====================================================================================
console.log('\n69) copyNoFollow: leaf-TOCTOU dicht');
{
  const os69 = require('os');
  // (a) DE RACE, gesimuleerd op het echte apply-pad: een copyFileImpl die NA de lstat-guard eerst een
  //     link op het doel plant en dan de ECHTE default-implementatie aanroept.
  const tpl = freshDir('t69-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x.cjs'), 'PAYLOAD-69');
  const p69 = makeProject(freshDir('t69-root'), 'proj69', null);
  fs.mkdirSync(path.join(p69, '.claude', 'forge-bin'), { recursive: true });
  const outside = freshDir('t69-outside');
  const victim = path.join(outside, 'victim.cjs');
  fs.writeFileSync(victim, 'ORIGINEEL-BUITEN');
  const dst69 = path.join(p69, '.claude');
  let linkOk = true;
  const racingImpl = (src, out) => {
    // simulatie van de race: de link verschijnt NA de guard, VOOR de copy
    try { fs.symlinkSync(victim, out, 'file'); } catch { linkOk = false; }
    return sync.copyNoFollow(src, out, dst69);
  };
  // newHash is the REAL template hash now — applyPlanSafely re-hashes the source right before writing
  //and would refuse a placeholder before the racing impl is ever reached, which would make this test vacuous.
  const plan69 = { toChange: [{ rel: 'forge-bin/x.cjs', oldHash: null, newHash: sync.sha256(path.join(tpl, 'forge-bin', 'x.cjs')), isNew: true, overrideClass: null }] };
  if (linkOk !== false) {
    const apply = sync.applyPlanSafely(tpl, p69, plan69, racingImpl);
    if (!linkOk) {
      console.log('  SKIP 69a — file-symlink aanmaken vergt op deze machine privileges; junction-variant volgt in (b)');
    } else {
      t('69a de race-write laat het bestand BUITEN het project ongemoeid', fs.readFileSync(victim, 'utf8') === 'ORIGINEEL-BUITEN');
      const finalContent = (() => { try { return fs.readFileSync(path.join(p69, '.claude', 'forge-bin', 'x.cjs'), 'utf8'); } catch { return null; } })();
      t('69a het doel is OF vervangen door de echte bytes OF de apply is eerlijk gefaald — nooit door de link heen geschreven',
        apply.ok === false || finalContent === 'PAYLOAD-69');
    }
  }

  // (b) junction op een TUSSENdirectory op het RESTORE-pad: de parent-realpath-hercheck vangt hem
  const pB = makeProject(freshDir('t69b-root'), 'projB', null);
  const dstB = path.join(pB, '.claude');
  const bdir = freshDir('t69b-backup');
  fs.mkdirSync(path.join(bdir, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(bdir, 'forge-bin', 'y.cjs'), 'Y-OLD');
  const outsideB = freshDir('t69b-outside');
  let junctionOk = true;
  try { fs.symlinkSync(outsideB, path.join(dstB, 'forge-bin'), 'junction'); } catch { junctionOk = false; }
  if (junctionOk) {
    let threw = null;
    try { sync.copyNoFollow(path.join(bdir, 'forge-bin', 'y.cjs'), path.join(dstB, 'forge-bin', 'y.cjs'), dstB); }
    catch (e) { threw = e; }
    t('69b een junction op de tussendirectory wordt gevangen (containment)', threw !== null && /containment/.test(threw.message));
    // r4 #18: de check komt nu VOOR het stagen — de weigering moet het pre-check-pad zijn en er mag
    // NIETS buiten staan: geen doelbestand én geen tempbestand (de oude versie vulde eerst de temp
    // buiten het project en ruimde hem pas daarna op — een crash liet de bytes daar staan).
    t('69b de weigering valt VOOR het stagen (no bytes written)', threw !== null && /BEFORE staging|no bytes written/.test(threw.message), threw && threw.message);
    t('69b er landt geen byte buiten het project', !fs.existsSync(path.join(outsideB, 'y.cjs')));
    t('69b er landt ook geen TEMPBESTAND buiten het project', fs.readdirSync(outsideB).filter((f) => f.includes('.tmp')).length === 0, fs.readdirSync(outsideB).join(','));
  } else {
    console.log('  SKIP 69b — junction aanmaken lukte niet op deze machine');
  }

  // (c) happy path: byte-identiek + geen tempnaam-restanten
  const pC = makeProject(freshDir('t69c-root'), 'projC', null);
  const dstC = path.join(pC, '.claude');
  fs.mkdirSync(path.join(dstC, 'forge-bin'), { recursive: true });
  const srcC = path.join(freshDir('t69c-src'), 's.cjs');
  fs.writeFileSync(srcC, 'BYTES-69-éü');
  sync.copyNoFollow(srcC, path.join(dstC, 'forge-bin', 's.cjs'), dstC);
  t('69c happy path kopieert byte-identiek', fs.readFileSync(path.join(dstC, 'forge-bin', 's.cjs'), 'utf8') === 'BYTES-69-éü');
  t('69c geen .tmp-restanten', fs.readdirSync(path.join(dstC, 'forge-bin')).filter((f) => f.includes('.tmp')).length === 0);
  // en het overschrijven van een BESTAAND doel werkt (rename-replace)
  sync.copyNoFollow(srcC, path.join(dstC, 'forge-bin', 's.cjs'), dstC);
  t('69c een tweede kopie over een bestaand doel slaagt (rename vervangt)', fs.readFileSync(path.join(dstC, 'forge-bin', 's.cjs'), 'utf8') === 'BYTES-69-éü');
}

// 70) settings — the catalogue must ship with the reader that resolves it (forge-config.cjs falls back to
// nothing without its schema), while the owner's OWN values (.claude/FORGE_CONFIG.json) are user data and must
// never be planned, overwritten or pruned by a sync. Same payload-pairing discipline as section 59.
console.log('\n70) v2.7.0 settings payload (schema synced, the owner\'s FORGE_CONFIG.json never)');
{
  const tplDir = path.resolve(__dirname, '..');
  const files = sync.listSystemFiles(tplDir);
  t('70a FORGE_CONFIG_SCHEMA.json is in the synced SYSTEM file list', files.includes('config/orchestration/FORGE_CONFIG_SCHEMA.json'));
  t('70b the pinned schema really exists in this template (no dangling pin)', fs.existsSync(path.join(tplDir, 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json')));
  t('70c the reader (forge-config.cjs + its -text/-cli helpers + its once/lock sibling) is synced too', ['forge-config.cjs', 'forge-config-text.cjs', 'forge-config-cli.cjs', 'forge-config-once.cjs'].every((f) => files.includes('forge-bin/' + f)));
  t('70d the owner\'s own FORGE_CONFIG.json is NOT in the synced list', !files.includes('FORGE_CONFIG.json'));
  const src = fs.readFileSync(path.join(__dirname, 'forge-sync.cjs'), 'utf8');
  const protect = src.match(/const PROTECT = new Set\(\[([\s\S]*?)\]\);/);
  t('70e FORGE_CONFIG.json is pinned in the PROTECT set', !!protect && protect[1].includes("'FORGE_CONFIG.json'"));
  // behavioural: even a template that (wrongly) carries a FORGE_CONFIG.json never plans to touch a project's own copy
  const tpl = freshDir('t70-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'v1');
  fs.writeFileSync(path.join(tpl, 'FORGE_CONFIG.json'), '{"version":1,"settings":{"nvidia":{"value":true}}}');
  const p70 = makeProject(freshDir('t70-root'), 'projA', null);
  const own = path.join(p70, '.claude', 'FORGE_CONFIG.json');
  fs.writeFileSync(own, '{"version":1,"settings":{"nvidia":{"value":false}}}');
  const plan = sync.buildPlan(tpl, p70, {});
  t('70f the dry-run plan is real (it does plan the template tool)', plan.toChange.some((x) => x.rel === 'forge-bin/tool.cjs'));
  t('70g the plan never mentions the project\'s own FORGE_CONFIG.json', !JSON.stringify(plan).includes('FORGE_CONFIG.json'));
  t('70h the project\'s own FORGE_CONFIG.json bytes are untouched', fs.readFileSync(own, 'utf8').includes('"value":false'));
}

// 71) vendored public skills. [2026-10-09: the per-path SYSTEM pins are gone — the shipping manifest
// ships skill folders whole; this test still proves every vendored file is delivered.] Originally: skills/ had no glob,
// so each vendored file was pinned one path at a
// time; a skill whose files are not all pinned would reach a synced project half-copied (a SKILL.md pointing at a
// helper or LICENSE that never arrived). The shipped set is DERIVED from skills/VENDORED-SKILLS.md's "Meegeleverd"
// table — never a hard-coded count — so a newly vendored skill turns this red with the missing paths named. If that
// table cannot be parsed, the fallback is every skills/<dir> whose SKILL.md carries a "Pinned commit:" line, and the
// test name says so.
console.log('\n71) vendored public skills are pinned (derived from skills/VENDORED-SKILLS.md)');
{
  const tplDir = path.resolve(__dirname, '..');
  const files = new Set(sync.listSystemFiles(tplDir));
  const docPath = path.join(tplDir, 'skills', 'VENDORED-SKILLS.md');
  const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
  // scan EVERY "Meegeleverd" section, not just the first —
  // VENDORED-SKILLS.md now has two such sections. A command row (round 2's `soort` column) never matches the
  // strict `| `name` |` pattern below because its first table cell also carries a parenthetical file path
  // (e.g. `` `/commit` (`.claude/commands/commit.md`) ``), so command rows are naturally excluded with no
  // extra filtering needed.
  const shippedSections = doc.split(/\r?\n## /).filter((s) => /^Meegeleverd\b/.test(s)).map((s) => s.split(/\r?\n### /)[0]);
  let names = shippedSections.flatMap((s) => [...s.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]));
  let how = 'the "Meegeleverd" table(s) of VENDORED-SKILLS.md';
  if (!names.length) {
    how = 'FALLBACK (table unparseable): skills/<dir>/SKILL.md carrying a "Pinned commit:" line';
    const skillsDir = path.join(tplDir, 'skills');
    names = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      .filter((n) => { try { return /^Pinned commit:/m.test(fs.readFileSync(path.join(skillsDir, n, 'SKILL.md'), 'utf8')); } catch { return false; } });
  }
  const walk71 = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk71(path.join(d, e.name)) : [path.join(d, e.name)]));
  const rel71 = (f) => path.relative(tplDir, f).split(path.sep).join('/');
  const absentDirs = names.filter((n) => !fs.existsSync(path.join(tplDir, 'skills', n)));
  const shipped = names.filter((n) => !absentDirs.includes(n)).flatMap((n) => walk71(path.join(tplDir, 'skills', n)).map(rel71));
  const missing = shipped.filter((f) => !files.has(f));
  const noLicense = names.filter((n) => !files.has('skills/' + n + '/SKILL.md') || !(files.has('skills/' + n + '/LICENSE') || files.has('skills/' + n + '/LICENSE.txt')));
  const dangling = [...files].filter((f) => names.some((n) => f.startsWith('skills/' + n + '/')) && !fs.existsSync(path.join(tplDir, f)));
  t('71a VENDORED-SKILLS.md exists and is itself synced', fs.existsSync(docPath) && files.has('skills/VENDORED-SKILLS.md'));
  t('71b the shipped set was derived from ' + how + ' (' + names.length + ' skills, ' + shipped.length + ' files)', names.length > 0 && shipped.length > 0);
  t('71c every listed skill dir really exists' + (absentDirs.length ? ' — ABSENT: ' + absentDirs.join(', ') : ''), absentDirs.length === 0);
  t('71d every shipped skill ships its SKILL.md AND its upstream LICENSE' + (noLicense.length ? ' — INCOMPLETE: ' + noLicense.join(', ') : ''), noLicense.length === 0);
  t('71e every file of every shipped vendored skill is in SYSTEM' + (missing.length ? ' — MISSING: ' + missing.join(', ') : ''), missing.length === 0);
  t('71f no pinned vendored path is dangling (every pin exists in this template)' + (dangling.length ? ' — DANGLING: ' + dangling.join(', ') : ''), dangling.length === 0);
}

// 72) forge-prompt-coach (Forge-native) + the two vendored commands are pinned.
// Neither is covered by test 71: forge-prompt-coach is not third-party content in VENDORED-SKILLS.md's
// "Meegeleverd" tables, and commands/ had no glob (2026-10-09; the shipping manifest now ships
// commands/*.md), so both kept their own explicit delivery test instead of
// relying on the vendored-skill scan above.
console.log('\n72) forge-prompt-coach + vendored commands are pinned');
{
  const tplDir = path.resolve(__dirname, '..');
  const files = new Set(sync.listSystemFiles(tplDir));
  // skip `.claude-flow/` — a gitignored runtime folder that external claude-flow tooling may drop into
  // any directory (seen live: skills/forge-prompt-coach/.claude-flow/data/pending-insights.jsonl). It is never
  // shipped (the release sync blocks it too), so it must not count as an unpinned payload file.
  const walk72 = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '.claude-flow' ? [] : walk72(path.join(d, e.name))) : [path.join(d, e.name)]));
  const rel72 = (f) => path.relative(tplDir, f).split(path.sep).join('/');
  const promptCoachDir = path.join(tplDir, 'skills', 'forge-prompt-coach');
  const promptCoachFiles = fs.existsSync(promptCoachDir) ? walk72(promptCoachDir).map(rel72) : [];
  const promptCoachMissing = promptCoachFiles.filter((f) => !files.has(f));
  const commandFiles = ['commands/commit.md', 'commands/revise-claude-md.md'];
  const commandsMissingOnDisk = commandFiles.filter((f) => !fs.existsSync(path.join(tplDir, f)));
  const commandsMissingPin = commandFiles.filter((f) => !files.has(f));
  t('72a forge-prompt-coach dir exists on disk with real files', fs.existsSync(promptCoachDir) && promptCoachFiles.length > 0);
  t('72b every file of forge-prompt-coach is in SYSTEM' + (promptCoachMissing.length ? ' — MISSING: ' + promptCoachMissing.join(', ') : ''), promptCoachMissing.length === 0);
  t('72c both vendored commands exist on disk' + (commandsMissingOnDisk.length ? ' — ABSENT: ' + commandsMissingOnDisk.join(', ') : ''), commandsMissingOnDisk.length === 0);
  t('72d both vendored commands are pinned in SYSTEM' + (commandsMissingPin.length ? ' — MISSING: ' + commandsMissingPin.join(', ') : ''), commandsMissingPin.length === 0);
}

// 73) WP22 ("alles standaard aan"): forge-sync now merges the template's
// settings.json into a synced project instead of leaving it for install.sh/install.ps1's old
// "settings.forge-recommended.json — merge by hand" path. Proves the wiring end-to-end via the same
// safeSyncProject() the `install` CLI and sync-all's lockedSync() both call.
console.log('\n73) WP22 — settings.json merge wired into forge-sync install');
{
  const tpl = freshDir('t73-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(tpl, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }] }] },
    permissions: { deny: ['Read(./.env)'] },
  }, null, 2) + '\n');

  // (a) a fresh project (no settings.json yet) -> created (a copy of the template's)
  const rootA = freshDir('t73-root-a');
  const pA = makeProject(rootA, 'projA', 0);
  const r1 = sync.safeSyncProject(tpl, pA, { batchId: 't73a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('73a install into a fresh project succeeds', r1.ok === true);
  t('73a settings.json is created for a fresh project', fs.existsSync(path.join(pA, '.claude', 'settings.json')));
  const createdSettings = JSON.parse(fs.readFileSync(path.join(pA, '.claude', 'settings.json'), 'utf8'));
  t('73a created settings.json carries the gate hook', JSON.stringify(createdSettings).includes('forge-gate-hook.cjs'));
  t('73a settingsMerge result is reported on the sync result (status: created)', !!r1.settingsMerge && r1.settingsMerge.status === 'created');

  // (b) an EXISTING project with a FOREIGN hook + a foreign allow rule -> merged, foreign entries kept
  const rootB = freshDir('t73-root-b');
  const pB = makeProject(rootB, 'projB', 0);
  fs.writeFileSync(path.join(pB, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node "owner-hook.cjs"', timeout: 5 }] }] },
    permissions: { allow: ['Bash(npm test)'] },
  }, null, 2) + '\n');
  const r2 = sync.safeSyncProject(tpl, pB, { batchId: 't73b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('73b install into a project with an existing settings.json still succeeds', r2.ok === true);
  t('73b settingsMerge status is merged', !!r2.settingsMerge && r2.settingsMerge.status === 'merged');
  const mergedSettings = JSON.parse(fs.readFileSync(path.join(pB, '.claude', 'settings.json'), 'utf8'));
  t('73b the foreign hook survives', mergedSettings.hooks.PreToolUse.some((e) => e.hooks[0].command === 'node "owner-hook.cjs"'));
  t('73b the foreign allow rule survives', JSON.stringify(mergedSettings.permissions.allow) === JSON.stringify(['Bash(npm test)']));
  t('73b the template\'s gate hook was added', mergedSettings.hooks.PreToolUse.some((e) => e.hooks[0].command.includes('forge-gate-hook.cjs')));
  t('73b the template\'s deny rule was added', (mergedSettings.permissions.deny || []).includes('Read(./.env)'));
  const backupFiles = fs.readdirSync(path.join(pB, '.claude')).filter((f) => f.includes('.forge-bak-'));
  t('73b a settings.json backup was written before the merge', backupFiles.length === 1);

  // (c) a SECOND install on the same already-merged project -> no change at all
  const before = fs.readFileSync(path.join(pB, '.claude', 'settings.json'), 'utf8');
  const r3 = sync.safeSyncProject(tpl, pB, { batchId: 't73c', nowIso: '2026-01-01T00:00:01.000Z' });
  t('73c a second install reports settingsMerge status noop', !!r3.settingsMerge && r3.settingsMerge.status === 'noop');
  t('73c settings.json bytes are unchanged on the second run', fs.readFileSync(path.join(pB, '.claude', 'settings.json'), 'utf8') === before);
  const backupFilesAfter = fs.readdirSync(path.join(pB, '.claude')).filter((f) => f.includes('.forge-bak-'));
  t('73c no new backup is taken on the no-op run', backupFilesAfter.length === backupFiles.length);
}

// 74) PROJECT-DIRECTORY-ESCAPE (wp-f2): a `.claude` that is itself a junction must
// never have its settings.json merged across that boundary — in the NO-OP file-plan branch specifically,
// which is the exact shape Codex's own probe used (settings-only write, no other file activity to mask it).
console.log('\n74) PROJECT-DIRECTORY-ESCAPE — a junctioned .claude refuses the settings step (no-op branch)');
{
  const tpl = freshDir('t74-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(tpl, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }] }] } }, null, 2) + '\n');

  const root = freshDir('t74-root');
  const outside = freshDir('t74-outside');
  fs.mkdirSync(path.join(outside, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n'); // identical -> file plan is a true no-op
  const p = path.join(root, 'proj');
  fs.mkdirSync(p, { recursive: true });
  let junctionOk = false;
  try { fs.symlinkSync(outside, path.join(p, '.claude'), 'junction'); junctionOk = true; }
  catch (e) { console.log('     (section 74: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
  if (junctionOk) {
    const r = sync.safeSyncProject(tpl, p, { batchId: 't74', nowIso: '2026-01-01T00:00:00.000Z' });
    // a real sync now takes the protect manifest BEFORE its first step, and that refuses a junctioned
    // .claude outright — earlier and stricter than the old no-op-branch settings refusal (which stays covered by the
    // dry-run assertions below, where no protect manifest is taken).
    t('74a (WP-2c) the real sync refuses before ANY step: the protect manifest cannot be taken through a junctioned .claude', r.ok === false && r.refused === true && /symlink\/junction/.test(r.reason || ''));
    t('74b the OVERALL result is ok:false — this is not a plain success', r.ok === false);
    const rDry = sync.safeSyncProject(tpl, p, { batchId: 't74', nowIso: '2026-01-01T00:00:00.000Z', dryRun: true });
    t('74c the dry-run (no protect manifest) still shows the settings step refusing the containment escape, never a merge/create', rDry.plan && rDry.plan.toChange.length === 0 && !!rDry.settingsMerge && rDry.settingsMerge.ok === false && rDry.settingsMerge.skipped === 'refused-containment');
    t('74d NOTHING was written into the real outside directory (no settings.json appeared there)', !fs.existsSync(path.join(outside, 'settings.json')));
  } else {
    t('(section 74 skipped honestly — could not create a junction)', true);
  }
}

// 75) SUCCESS-WITHOUT-SETTINGS (wp-f2): a settings-merge failure must make the OVERALL safeSyncProject result
// (and the `install` CLI's exit code) not-ok — in BOTH the no-op branch and the real apply-and-validate branch.
console.log('\n75) SUCCESS-WITHOUT-SETTINGS — a settings refusal makes the overall result/exit code not-ok');
{
  const tpl = freshDir('t75-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(tpl, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }] }] } }, null, 2) + '\n');

  // (a) NO-OP file plan + a malformed existing settings.json -> overall ok:false
  const rootA = freshDir('t75-root-a');
  const pA = makeProject(rootA, 'projA', 0);
  fs.mkdirSync(path.join(pA, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pA, '.claude', 'forge-bin', 'tool.cjs'), 'console.log("v1");\n'); // matches template -> file no-op
  fs.writeFileSync(path.join(pA, '.claude', 'settings.json'), '{ not valid json', 'utf8');
  const rA = sync.safeSyncProject(tpl, pA, { batchId: 't75a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('75a file plan is a no-op', rA.noop === true);
  t('75a overall ok is false (settings refused)', rA.ok === false);
  t('75a settingsMerge reports refused', !!rA.settingsMerge && rA.settingsMerge.status === 'refused');
  t('75a the malformed settings.json was left untouched', fs.readFileSync(path.join(pA, '.claude', 'settings.json'), 'utf8') === '{ not valid json');

  // (b) a REAL apply (new file to copy) + a malformed existing settings.json -> file sync still succeeds and
  // is stamped (settings.json is deliberately independent of that commit — see syncProjectSettings's own doc
  // comment), but the OVERALL ok must still be false.
  const rootB = freshDir('t75-root-b');
  const pB = makeProject(rootB, 'projB', 0);
  fs.writeFileSync(path.join(pB, '.claude', 'settings.json'), '{ not valid json', 'utf8');
  const rB = sync.safeSyncProject(tpl, pB, { batchId: 't75b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('75b the file sync itself succeeded (receipt/version stamped)', !!rB.receipt && fs.existsSync(path.join(pB, '.claude', 'forge-bin', 'tool.cjs')));
  t('75b overall ok is false (settings refused)', rB.ok === false);
  t('75b settingsMerge reports refused', !!rB.settingsMerge && rB.settingsMerge.status === 'refused');

  // (c) the `install` CLI exits non-zero for the same no-op-but-settings-refused shape (real subprocess)
  const rootC = freshDir('t75-root-c');
  const pC = makeProject(rootC, 'projC', 0);
  fs.mkdirSync(path.join(pC, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pC, '.claude', 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(pC, '.claude', 'settings.json'), '{ not valid json', 'utf8');
  const cliResult = runCLIWithTemplate(['install', pC, '--no-central-backup'], tpl);
  t('75c CLI install exits non-zero when the file plan is a no-op but settings.json is refused', cliResult.status !== 0);
}

// 76) sync-all --unsafe now shares the settings step with single-project `install --unsafe` (wp-f2).
console.log('\n76) sync-all --unsafe installs AND reports settings.json (SUCCESS-WITHOUT-SETTINGS)');
{
  const tpl = freshDir('t76-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(tpl, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }] }] } }, null, 2) + '\n');
  const root = freshDir('t76-root');
  const p = makeProject(root, 'proj', null); // rawInstall does not run a doctor at all
  const result = sync.runSyncAll(tpl, root, { unsafe: true, projects: [p], batchId: 't76', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: null });
  t('76a --unsafe reports ok:true when the file copy AND the settings merge both succeed', result.ok === true);
  t('76b settings.json was actually created on disk (not just reported)', fs.existsSync(path.join(p, '.claude', 'settings.json')));
  t('76c the per-project result carries settingsMerge (status created)', !!result.projects[0].settingsMerge && result.projects[0].settingsMerge.status === 'created');

  // now with a malformed existing settings.json -> --unsafe must report ok:false too (SUCCESS-WITHOUT-SETTINGS)
  const root2 = freshDir('t76-root2');
  const p2 = makeProject(root2, 'proj2', null);
  fs.writeFileSync(path.join(p2, '.claude', 'settings.json'), '{ not valid json', 'utf8');
  const result2 = sync.runSyncAll(tpl, root2, { unsafe: true, projects: [p2], batchId: 't76b', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: null });
  t('76d --unsafe reports ok:false when settings.json is refused, even though the file copy itself succeeded', result2.ok === false);
}

// 77) DRY-RUN-MUTATION (wp-f2): sync-all's dry-run must show the settings.json preview too, not just the file plan.
console.log('\n77) sync-all dry-run includes the settings.json preview');
{
  const tpl = freshDir('t77-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(tpl, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }] }] } }, null, 2) + '\n');
  const root = freshDir('t77-root');
  const p = makeProject(root, 'proj', 0);
  const result = sync.runSyncAll(tpl, root, { dryRun: true, projects: [p], batchId: 't77', nowIso: '2026-01-01T00:00:00.000Z' });
  t('77a dry-run reports ok:true and writes nothing', result.ok === true && !fs.existsSync(path.join(p, '.claude', 'settings.json')));
  t('77b the settings.json preview (would-create) is present on the plan entry, not discarded', !!result.projects[0].settingsMerge && result.projects[0].settingsMerge.status === 'would-create');
}

// 78) N4 (external audit) — the new template/user split state files must NEVER be template-owned:
// not in the synced SYSTEM list, never planned, and byte-for-byte untouched by a real sync even when they
// carry real owner content. Same payload-pairing discipline as section 70's FORGE_CONFIG.json test.
console.log('\n78) N4 fix — new user-state files are never template-owned (not synced, not planned, never overwritten)');
{
  const tplDir = path.resolve(__dirname, '..');
  const files = sync.listSystemFiles(tplDir);
  const userStateFiles = [
    'config/orchestration/FORGE_STANDING_RULES.user.json',
    'config/orchestration/FORGE_SCOUT_VETTING.user.json',
    'config/forge-bench/baseline.user.json',
  ];
  for (const f of userStateFiles) {
    t('78a ' + f + ' is NOT in the synced SYSTEM file list', !files.includes(f));
  }
  // SYSTEM_GLOB is gone — config/** IS shipped whole now (the shipping manifest). What keeps these files
  // out is two independent keys: the manifest classifies config/**/*.user.json per-project, AND forge-sync's own
  // never-touch floor refuses every *.user.json even if a manifest edit ever claimed one (section 85 proves that).
  const shipcheck78 = require('./forge-shipcheck.cjs');
  const manifest78 = shipcheck78.loadManifest(path.join(tplDir, 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'));
  t('78b the shipping manifest classifies every user-state file per-project', userStateFiles.every((f) => { const r = shipcheck78.classify(manifest78.rules, '.claude/' + f); return !!r && r.class === 'per-project'; }));
  t('78b and the never-touch floor refuses every one of them regardless of any manifest', userStateFiles.every((f) => sync.isNeverTouch(f)));

  // behavioural: a project carrying real content in all three user files is never touched by a real sync,
  // even though the template itself is genuinely changing other files.
  const tpl = freshDir('t78-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'v2');
  const p78 = makeProject(freshDir('t78-root'), 'proj', null);
  const userFiles = {};
  for (const f of userStateFiles) {
    const abs = path.join(p78, '.claude', f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = JSON.stringify({ version: 1, rules: [{ id: 'owner-real-rule-' + path.basename(f) }] }, null, 2) + '\n';
    fs.writeFileSync(abs, content);
    userFiles[f] = { abs, content };
  }
  const plan78 = sync.buildPlan(tpl, p78, {});
  t('78c the dry-run plan is real (it does plan the template tool change)', plan78.toChange.some((x) => x.rel === 'forge-bin/tool.cjs'));
  t('78d the plan never mentions any of the three user-state files', !userStateFiles.some((f) => JSON.stringify(plan78).includes(f)));
  const r78 = sync.safeSyncProject(tpl, p78, { batchId: 'b78', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true, allowDegraded: true });
  t('78e the sync itself ran (ok or a reported, non-crashing outcome)', typeof r78.ok === 'boolean');
  for (const f of userStateFiles) {
    t('78f ' + f + ' bytes are byte-for-byte untouched after a real sync', fs.readFileSync(userFiles[f].abs, 'utf8') === userFiles[f].content);
  }
}

// 79) external-audit 3.4 (LOW) — a v2.7-era project's owner-remember rule baked directly INTO the SYNCED
// FORGE_STANDING_RULES.json (before the 2026-09-26 template/user split existed) must survive an upgrade:
// forge-sync moves it into the project's own FORGE_STANDING_RULES.user.json BEFORE the template file is
// ever compared/replaced — even when the drift is only resolved via --force-overwrite.
console.log('\n79) 3.4 fix — a v2.7-era owner rule baked into FORGE_STANDING_RULES.json survives an upgrade');
function standingRule(overrides) {
  return Object.assign({
    id: 'r-' + Math.random().toString(36).slice(2), text: 'rule text', scope: 'global', trigger: 'always',
    domain: null, glob: null, topic: null, source: 'CLAUDE.md (fixture)', confidence: 'high', status: 'active',
    cannot_override_core: false,
  }, overrides || {});
}
{
  const tpl79 = freshDir('t79-tpl');
  fs.mkdirSync(path.join(tpl79, 'config', 'orchestration'), { recursive: true });
  const cleanTemplateDoc = { version: 1, rules: [standingRule({ id: 'product-rule-79-new', text: 'new shipped rule' })] };
  fs.writeFileSync(path.join(tpl79, 'config', 'orchestration', 'FORGE_STANDING_RULES.json'), JSON.stringify(cleanTemplateDoc, null, 2) + '\n');

  const p79 = makeProject(freshDir('t79-root'), 'proj', null);
  const projStandingDir = path.join(p79, '.claude', 'config', 'orchestration');
  fs.mkdirSync(projStandingDir, { recursive: true });
  const v27Doc = {
    version: 1,
    rules: [
      standingRule({ id: 'product-rule-79-old', text: 'old shipped rule' }),
      standingRule({ id: 'owner-rule-v27', text: 'an owner rule baked directly into the old shipped file', source: 'owner /forge remember' }),
    ],
  };
  fs.writeFileSync(path.join(projStandingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify(v27Doc, null, 2) + '\n');
  const userPath79 = path.join(projStandingDir, 'FORGE_STANDING_RULES.user.json');
  t('79 precondition: no user file exists yet before the upgrade', !fs.existsSync(userPath79));

  const r79 = sync.safeSyncProject(tpl79, p79, { batchId: 'b79', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true, allowDegraded: true });
  t('79a the sync ran to completion (ok or a reported, non-crashing outcome)', typeof r79.ok === 'boolean');

  const templateOnDiskAfter = JSON.parse(fs.readFileSync(path.join(projStandingDir, 'FORGE_STANDING_RULES.json'), 'utf8'));
  t('79b the project template file is CLEAN after the upgrade: new shipped rule present', templateOnDiskAfter.rules.some((r) => r.id === 'product-rule-79-new'));
  t('79c the project template file is CLEAN after the upgrade: zero owner-remember rules remain in it', !templateOnDiskAfter.rules.some((r) => r.source === 'owner /forge remember'));

  t('79d the owner rule survived: FORGE_STANDING_RULES.user.json now exists', fs.existsSync(userPath79));
  const userDocAfter = fs.existsSync(userPath79) ? JSON.parse(fs.readFileSync(userPath79, 'utf8')) : { rules: [] };
  t('79e the owner rule survived byte-for-byte (same id) in the project\'s own user file', userDocAfter.rules.some((r) => r.id === 'owner-rule-v27'));

  t('79f FORGE_STANDING_RULES.user.json is never template-owned (not in the synced SYSTEM file list)', !sync.listSystemFiles(tpl79).includes('config/orchestration/FORGE_STANDING_RULES.user.json'));
}

// 79g) the same preflight migration also protects the --unsafe (rawInstall) path, which has no
// drift/conflict analysis at all and would otherwise replace the file unconditionally.
{
  const tpl79u = freshDir('t79u-tpl');
  fs.mkdirSync(path.join(tpl79u, 'config', 'orchestration'), { recursive: true });
  fs.writeFileSync(path.join(tpl79u, 'config', 'orchestration', 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: 'product-rule-79u-new' })] }, null, 2) + '\n');

  const p79u = makeProject(freshDir('t79u-root'), 'proj', null);
  const dir79u = path.join(p79u, '.claude', 'config', 'orchestration');
  fs.mkdirSync(dir79u, { recursive: true });
  fs.writeFileSync(path.join(dir79u, 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: 'owner-rule-79u', source: 'owner /forge remember' })] }, null, 2) + '\n');

  sync.rawInstall(tpl79u, p79u, { batchId: 'b79u', nowIso: '2026-01-01T00:00:00.000Z' });

  const userPath79u = path.join(dir79u, 'FORGE_STANDING_RULES.user.json');
  t('79g --unsafe (rawInstall) also preserves a v2.7-era owner rule via the same preflight migration', fs.existsSync(userPath79u) && JSON.parse(fs.readFileSync(userPath79u, 'utf8')).rules.some((r) => r.id === 'owner-rule-79u'));
}

// 79h) migrateOwnerStandingRules() unit-level: idempotent, no-op when nothing to migrate, never throws on a
// missing/malformed project file.
console.log('\n79h) migrateOwnerStandingRules() — unit-level safety net behavior');
{
  const noProjectDir = freshDir('t79h-empty');
  fs.mkdirSync(path.join(noProjectDir, '.claude'), { recursive: true });
  t('79h1 no FORGE_STANDING_RULES.json at all -> returns [] and writes nothing', (() => {
    const before = fs.readdirSync(path.join(noProjectDir, '.claude'));
    const ids = sync.migrateOwnerStandingRules(noProjectDir);
    const after = fs.readdirSync(path.join(noProjectDir, '.claude'));
    return Array.isArray(ids) && ids.length === 0 && JSON.stringify(before) === JSON.stringify(after);
  })());

  const malformedDir = freshDir('t79h-malformed');
  const malformedStandingDir = path.join(malformedDir, '.claude', 'config', 'orchestration');
  fs.mkdirSync(malformedStandingDir, { recursive: true });
  fs.writeFileSync(path.join(malformedStandingDir, 'FORGE_STANDING_RULES.json'), '{ not valid json');
  t('79h2 a malformed project FORGE_STANDING_RULES.json never throws — returns []', (() => {
    let ids;
    try { ids = sync.migrateOwnerStandingRules(malformedDir); } catch { return false; }
    return Array.isArray(ids) && ids.length === 0;
  })());

  const noOwnerDir = freshDir('t79h-noowner');
  const noOwnerStandingDir = path.join(noOwnerDir, '.claude', 'config', 'orchestration');
  fs.mkdirSync(noOwnerStandingDir, { recursive: true });
  fs.writeFileSync(path.join(noOwnerStandingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: 'shipped-only' })] }, null, 2) + '\n');
  t('79h3 a project file with zero owner-remember rules is a no-op (no user file created)', sync.migrateOwnerStandingRules(noOwnerDir).length === 0 && !fs.existsSync(path.join(noOwnerStandingDir, 'FORGE_STANDING_RULES.user.json')));

  const idempotentDir = freshDir('t79h-idem');
  const idemStandingDir = path.join(idempotentDir, '.claude', 'config', 'orchestration');
  fs.mkdirSync(idemStandingDir, { recursive: true });
  fs.writeFileSync(path.join(idemStandingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: 'owner-idem', source: 'owner /forge remember' })] }, null, 2) + '\n');
  sync.migrateOwnerStandingRules(idempotentDir);
  sync.migrateOwnerStandingRules(idempotentDir); // second call — must not duplicate
  const idemUserDoc = JSON.parse(fs.readFileSync(path.join(idemStandingDir, 'FORGE_STANDING_RULES.user.json'), 'utf8'));
  t('79h4 calling migrateOwnerStandingRules() twice never duplicates the rule in the user file', idemUserDoc.rules.filter((r) => r.id === 'owner-idem').length === 1);
}

// 79i) N8 (2026-09-26 independent review, LOW) — migrateOwnerStandingRules() must never destroy a
// MALFORMED-but-PRESENT user file: it starts from an empty doc ONLY on a confirmed ENOENT; any other
// read/parse/shape problem warns once and skips the migration, leaving the existing file byte-identical.
console.log('\n79i) N8 fix — a malformed (present) user file is never overwritten by the migration');
{
  function withOwnerTemplate(dirPrefix) {
    const dir = freshDir(dirPrefix);
    const standingDir = path.join(dir, '.claude', 'config', 'orchestration');
    fs.mkdirSync(standingDir, { recursive: true });
    fs.writeFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({
      version: 1, rules: [standingRule({ id: 'owner-rule-79i', source: 'owner /forge remember' })],
    }, null, 2) + '\n');
    return { dir, standingDir };
  }

  // 79i1: bad JSON in an EXISTING user file
  {
    const { dir, standingDir } = withOwnerTemplate('t79i-badjson');
    const userPath = path.join(standingDir, 'FORGE_STANDING_RULES.user.json');
    const before = '{ this is not valid json at all';
    fs.writeFileSync(userPath, before);
    const warnings = [];
    const origErr = console.error;
    console.error = (msg) => warnings.push(msg);
    let ids;
    try { ids = sync.migrateOwnerStandingRules(dir); } finally { console.error = origErr; }
    t('79i1 a bad-JSON user file never throws — returns []', Array.isArray(ids) && ids.length === 0);
    t('79i1 the malformed user file is left BYTE-IDENTICAL (no destructive overwrite)', fs.readFileSync(userPath, 'utf8') === before);
    t('79i1 a visible warning names the problem', warnings.some((w) => /FORGE_STANDING_RULES\.user\.json/.test(w)));
    t('79i1 no stray .tmp file was left behind', !fs.readdirSync(standingDir).some((f) => f.endsWith('.tmp')));
  }

  // 79i2: valid JSON, but no "rules" array
  {
    const { dir, standingDir } = withOwnerTemplate('t79i-norules');
    const userPath = path.join(standingDir, 'FORGE_STANDING_RULES.user.json');
    const before = JSON.stringify({ version: 1, notes: 'no rules array here' });
    fs.writeFileSync(userPath, before);
    const ids = sync.migrateOwnerStandingRules(dir);
    t('79i2 a present user file missing "rules" never throws — returns []', Array.isArray(ids) && ids.length === 0);
    t('79i2 the malformed (shape) user file is left BYTE-IDENTICAL', fs.readFileSync(userPath, 'utf8') === before);
  }

  // 79i3: valid JSON, "rules" is not an array
  {
    const { dir, standingDir } = withOwnerTemplate('t79i-rulesnotarray');
    const userPath = path.join(standingDir, 'FORGE_STANDING_RULES.user.json');
    const before = JSON.stringify({ version: 1, rules: 'not-an-array' });
    fs.writeFileSync(userPath, before);
    const ids = sync.migrateOwnerStandingRules(dir);
    t('79i3 rules:"not-an-array" never throws — returns []', Array.isArray(ids) && ids.length === 0);
    t('79i3 the malformed (rules-not-array) user file is left BYTE-IDENTICAL', fs.readFileSync(userPath, 'utf8') === before);
  }

  // 79i4: genuinely ENOENT (no user file at all) still migrates normally — the fix narrows the "start
  // empty" behavior to ENOENT only, it must not remove it for the real fresh-install case.
  {
    const { dir, standingDir } = withOwnerTemplate('t79i-enoent');
    const userPath = path.join(standingDir, 'FORGE_STANDING_RULES.user.json');
    t('79i4 precondition: no user file exists yet', !fs.existsSync(userPath));
    const ids = sync.migrateOwnerStandingRules(dir);
    t('79i4 ENOENT (genuinely fresh) still migrates normally', ids.includes('owner-rule-79i'));
    t('79i4 the user file was created with the migrated rule', fs.existsSync(userPath) && JSON.parse(fs.readFileSync(userPath, 'utf8')).rules.some((r) => r.id === 'owner-rule-79i'));
  }

  // 79i5: end-to-end through safeSyncProject — a malformed existing user file must not stop the sync
  // itself from completing, and must still come out byte-identical afterward.
  {
    const tpl = freshDir('t79i-e2e-tpl');
    fs.mkdirSync(path.join(tpl, 'config', 'orchestration'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'config', 'orchestration', 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: 'product-rule-79i-e2e' })] }, null, 2) + '\n');
    const p = makeProject(freshDir('t79i-e2e-root'), 'proj', null);
    const standingDir = path.join(p, '.claude', 'config', 'orchestration');
    fs.mkdirSync(standingDir, { recursive: true });
    fs.writeFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({
      version: 1, rules: [standingRule({ id: 'owner-rule-79i-e2e', source: 'owner /forge remember' })],
    }, null, 2) + '\n');
    const userPath = path.join(standingDir, 'FORGE_STANDING_RULES.user.json');
    const before = '{ malformed on purpose';
    fs.writeFileSync(userPath, before);

    const r = sync.safeSyncProject(tpl, p, { batchId: 'b79i-e2e', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true, allowDegraded: true });
    t('79i5 the sync still completes (does not crash / abort) despite the malformed user file', typeof r.ok === 'boolean');
    t('79i5 the malformed user file is left BYTE-IDENTICAL after a real sync run', fs.readFileSync(userPath, 'utf8') === before);
    // F4 fix (2026-09-26 independent review, LOW): before the fix, the malformed user file above meant the
    // migration was SKIPPED, and --force-overwrite then replaced FORGE_STANDING_RULES.json with the clean
    // template anyway, permanently dropping "owner-rule-79i-e2e" — this is the exact scenario F4 closes.
    const templateAfter = JSON.parse(fs.readFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), 'utf8'));
    t('F4 79i5 the owner rule SURVIVES in the project file (never dropped) when the user file is malformed under --force-overwrite', templateAfter.rules.some((r2) => r2.id === 'owner-rule-79i-e2e'));
  }
}

// 79l) F4 fix (2026-09-26 independent review, LOW) — migrateOwnerStandingRules()'s return value was
// ignored; a malformed/unreadable FORGE_STANDING_RULES.user.json under --force-overwrite (or on the
// --unsafe/rawInstall path, which has no drift/conflict analysis at all) let the sync replace
// FORGE_STANDING_RULES.json with the clean template anyway, permanently losing the never-migrated owner
// rule. Fixed: migrateOwnerStandingRules() now attaches a `.pending` flag to its returned array (contents
// unchanged, for backward compatibility — see 79h/79i/79j/79k above, all still passing unmodified); both
// call sites skip replacing FORGE_STANDING_RULES.json this pass when `.pending` is true, with a plain
// warning naming the fix (fix/remove the user file, then re-run).
console.log('\n79l) F4 fix — a pending (unmigratable) owner rule is never dropped by a template replace');
{
  function tplWithCleanRule(prefix, ruleId) {
    const tpl = freshDir(prefix);
    fs.mkdirSync(path.join(tpl, 'config', 'orchestration'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'config', 'orchestration', 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: ruleId })] }, null, 2) + '\n');
    return tpl;
  }
  function projectWithOwnerRuleAndMalformedUser(prefix, ownerId) {
    const p = makeProject(freshDir(prefix), 'proj', null);
    const standingDir = path.join(p, '.claude', 'config', 'orchestration');
    fs.mkdirSync(standingDir, { recursive: true });
    fs.writeFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: ownerId, source: 'owner /forge remember' })] }, null, 2) + '\n');
    const userPath = path.join(standingDir, 'FORGE_STANDING_RULES.user.json');
    fs.writeFileSync(userPath, '{ not valid json at all');
    return { p, standingDir, userPath };
  }

  // 79l1: migrateOwnerStandingRules() itself reports .pending on a malformed user file WITH an owner
  // rule waiting, and .pending===false once nothing is pending (nothing to migrate at all).
  {
    const { p } = projectWithOwnerRuleAndMalformedUser('t79l-unit-pending', 'owner-79l1');
    const origErr = console.error; console.error = () => {};
    let ids; try { ids = sync.migrateOwnerStandingRules(p); } finally { console.error = origErr; }
    t('79l1 .pending is true when an owner rule exists but the user file is malformed', ids.pending === true);
    t('79l1 the returned ids array contents stay [] (backward compatible with existing callers)', Array.isArray(ids) && ids.length === 0);

    const noneDir = freshDir('t79l-unit-nopending');
    const noneStandingDir = path.join(noneDir, '.claude', 'config', 'orchestration');
    fs.mkdirSync(noneStandingDir, { recursive: true });
    fs.writeFileSync(path.join(noneStandingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: 'shipped-only-79l' })] }, null, 2) + '\n');
    const ids2 = sync.migrateOwnerStandingRules(noneDir);
    t('79l1 .pending is false when there is nothing to migrate at all', ids2.pending === false);
  }

  // 79l2: safeSyncProject (--force-overwrite) — the owner rule survives, a clear warning is printed, and
  // the rest of the sync (other files) still proceeds normally.
  {
    const tpl = tplWithCleanRule('t79l-safe-tpl', 'product-79l2');
    const { p, standingDir, userPath } = projectWithOwnerRuleAndMalformedUser('t79l-safe-root', 'owner-79l2');
    const before = fs.readFileSync(userPath, 'utf8');
    const warnings = [];
    const origErr = console.error;
    console.error = (msg) => { warnings.push(msg); };
    let r;
    try { r = sync.safeSyncProject(tpl, p, { batchId: 'b79l2', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true, allowDegraded: true }); }
    finally { console.error = origErr; }
    t('79l2 the sync still completes (does not crash / abort)', typeof r.ok === 'boolean');
    const after = JSON.parse(fs.readFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), 'utf8'));
    t('79l2 the owner rule SURVIVES the force-overwrite (the exact regression this fix closes)', after.rules.some((r2) => r2.id === 'owner-79l2'));
    t('79l2 the malformed user file is left BYTE-IDENTICAL (never destructively rewritten)', fs.readFileSync(userPath, 'utf8') === before);
    t('79l2 a plain warning names the refusal to replace the file', warnings.some((w) => /refusing to replace/.test(w) && /FORGE_STANDING_RULES\.json/.test(w)));
  }

  // 79l3: rawInstall (--unsafe) — same protection on the path with no drift/conflict analysis at all.
  {
    const tpl = tplWithCleanRule('t79l-unsafe-tpl', 'product-79l3');
    const { p, standingDir, userPath } = projectWithOwnerRuleAndMalformedUser('t79l-unsafe-root', 'owner-79l3');
    const before = fs.readFileSync(userPath, 'utf8');
    const warnings = [];
    const origErr = console.error;
    console.error = (msg) => { warnings.push(msg); };
    let r;
    // --unsafe refuses unbaselined drift on its own now, so — exactly like its safe-path twin 79l2 —
    // it needs --force-overwrite to reach the replace that the pending-migration hold must still block.
    try { r = sync.rawInstall(tpl, p, { batchId: 'b79l3', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true }); }
    finally { console.error = origErr; }
    t('79l3 --unsafe install still completes', r && r.ok === true);
    const after = JSON.parse(fs.readFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), 'utf8'));
    t('79l3 the owner rule SURVIVES --unsafe install (the exact regression this fix closes on the rawInstall path)', after.rules.some((r2) => r2.id === 'owner-79l3'));
    t('79l3 the malformed user file is left BYTE-IDENTICAL', fs.readFileSync(userPath, 'utf8') === before);
    t('79l3 a plain warning names the refusal to replace the file', warnings.some((w) => /refusing to replace/.test(w) && /FORGE_STANDING_RULES\.json/.test(w)));
  }

  // 79l4: once the owner fixes the user file (removes the malformation), a LATER sync completes the
  // migration normally and the template file DOES get replaced/cleaned — the fix must not permanently
  // freeze the file, only pause the replace while genuinely pending.
  {
    const tpl = tplWithCleanRule('t79l-fixed-tpl', 'product-79l4');
    const { p, standingDir, userPath } = projectWithOwnerRuleAndMalformedUser('t79l-fixed-root', 'owner-79l4');
    fs.unlinkSync(userPath); // "the owner fixes it" == removes the malformed file (ENOENT path, safe to start empty)
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b79l4', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true, allowDegraded: true });
    t('79l4 the sync completes once the malformed file is gone', typeof r.ok === 'boolean');
    const after = JSON.parse(fs.readFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), 'utf8'));
    t('79l4 the template file is now CLEAN (migration completed, no longer pending)', !after.rules.some((r2) => r2.source === 'owner /forge remember'));
    const userDocAfter = JSON.parse(fs.readFileSync(userPath, 'utf8'));
    t('79l4 the owner rule landed safely in the user file instead', userDocAfter.rules.some((r2) => r2.id === 'owner-79l4'));
  }
}

// 79m) R6 fix (2026-09-26 independent review, LOW/NOTE) — three related fixes to the owner-standing-rules
// migration preview/labeling/advice:
//  (a) a dry-run now computes migrateOwnerStandingRules()'s .pending the SAME way a real run would, so
//      the preview never shows FORGE_STANDING_RULES.json as replaced when a real run would skip it, AND
//      dry-run stays a true zero-write operation (no mkdir, no write).
//  (b) a pending-migration skip gets its own honest "kept (...)" label in printPlanSummary(), never
//      lumped under "skipped (symlink/unsafe)" (which reads like a security refusal).
//  (c) the advice never says "remove"/"delete" that file — fixing the JSON (with a copy-first safety
//      net) is the only advice given, since the file may hold the owner's own rules.
console.log('\n79m) R6 fix — dry-run pending preview matches the real run; honest label; safe advice');
{
  function tplWithCleanRule79m(prefix, ruleId) {
    const tpl = freshDir(prefix);
    fs.mkdirSync(path.join(tpl, 'config', 'orchestration'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'config', 'orchestration', 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: ruleId })] }, null, 2) + '\n');
    return tpl;
  }
  function projectWithOwnerRuleAndMalformedUser79m(prefix, ownerId) {
    const p = makeProject(freshDir(prefix), 'proj', null);
    const standingDir = path.join(p, '.claude', 'config', 'orchestration');
    fs.mkdirSync(standingDir, { recursive: true });
    fs.writeFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({ version: 1, rules: [standingRule({ id: ownerId, source: 'owner /forge remember' })] }, null, 2) + '\n');
    const userPath = path.join(standingDir, 'FORGE_STANDING_RULES.user.json');
    fs.writeFileSync(userPath, '{ not valid json at all');
    return { p, standingDir, userPath };
  }

  // 79m1 (unit-level): migrateOwnerStandingRules(dir, {dryRun:true}) reports the SAME .pending a real
  // call would, and writes NOTHING at all (not even mkdirSync) — the malformed user file stays untouched.
  {
    const { p, userPath } = projectWithOwnerRuleAndMalformedUser79m('t79m1-unit', 'owner-79m1');
    const beforeTree = snapshotTree(p);
    const origErr = console.error; console.error = () => {};
    let dryIds; try { dryIds = sync.migrateOwnerStandingRules(p, { dryRun: true }); } finally { console.error = origErr; }
    t('79m1 dry-run .pending is true (same read-only guards as a real call)', dryIds.pending === true);
    t('79m1 dry-run writes NOTHING at all (tree byte-identical, malformed file untouched)', JSON.stringify(snapshotTree(p)) === JSON.stringify(beforeTree));
    t('79m1 the malformed user file is still present and byte-identical after the dry-run', fs.existsSync(userPath) && fs.readFileSync(userPath, 'utf8') === '{ not valid json at all');
  }

  // 79m2 (end-to-end via safeSyncProject dry-run): the DRY-RUN plan already shows the pending skip
  // and excludes FORGE_STANDING_RULES.json from toChange — matching what a REAL run on the identical
  // starting state does (proven against a separate, identical fixture copy).
  {
    const tpl = tplWithCleanRule79m('t79m2-tpl', 'product-79m2');
    const dryFixture = projectWithOwnerRuleAndMalformedUser79m('t79m2-dry-root', 'owner-79m2');
    const realFixture = projectWithOwnerRuleAndMalformedUser79m('t79m2-real-root', 'owner-79m2');
    const beforeDryTree = snapshotTree(dryFixture.p);

    // forceOverwrite:true is what would otherwise force-replace FORGE_STANDING_RULES.json (no receipt yet
    // -> plain unknownDrift is already blocked WITHOUT force; the pending-migration hold only becomes
    // visible once force-overwrite would otherwise fold it into toChange) — this is the exact scenario the
    // dry-run preview used to get wrong.
    const origErr = console.error; console.error = () => {};
    let dryResult, realResult;
    try {
      dryResult = sync.safeSyncProject(tpl, dryFixture.p, { dryRun: true, batchId: 'b79m2-dry', forceOverwrite: true });
      realResult = sync.safeSyncProject(tpl, realFixture.p, { batchId: 'b79m2-real', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true, allowDegraded: true });
    } finally { console.error = origErr; }

    t('79m2 dry-run plan EXCLUDES FORGE_STANDING_RULES.json from toChange (the exact regression this fix closes)',
      !dryResult.plan.toChange.some((e) => e.rel === sync.STANDING_RULES_REL));
    t('79m2 dry-run plan lists the pending skip', dryResult.plan.skipped.some((s) => s.rel === sync.STANDING_RULES_REL && s.reason === 'owner-rule-pending-migration'));
    t('79m2 dry-run wrote ZERO bytes (true dry-run, no mkdir/write even for the migration itself)', JSON.stringify(snapshotTree(dryFixture.p)) === JSON.stringify(beforeDryTree));

    // the REAL run, starting from the identical fixture state, also skips replacing the file — proving the
    // dry-run preview actually matched what really happens.
    const realStandingAfter = JSON.parse(fs.readFileSync(path.join(realFixture.standingDir, 'FORGE_STANDING_RULES.json'), 'utf8'));
    t('79m2 the REAL run (same starting state) ALSO kept the owner rule in place (preview matched reality)',
      realStandingAfter.rules.some((r2) => r2.id === 'owner-79m2'));
  }

  // 79m3: printPlanSummary() gives the pending-migration skip its OWN honest label, separate from
  // "skipped (symlink/unsafe)" — a genuine symlink/unsafe skip keeps the original label unchanged.
  {
    const plan = {
      toChange: [], expectedOverrides: [], unknownDrift: [], conflicts: [], unreadable: [], same: 3,
      skipped: [
        { rel: sync.STANDING_RULES_REL, reason: 'owner-rule-pending-migration' },
        { rel: 'some/other/file.json', reason: 'symlink' },
      ],
    };
    const lines = [];
    const origLog = console.log;
    console.log = (msg) => lines.push(String(msg));
    try { sync.printPlanSummary(plan); } finally { console.log = origLog; }
    const out = lines.join('\n');
    t('79m3 the pending-migration skip gets its own "kept (...)" line naming the file',
      /kept \(owner rules still waiting to move/i.test(out) && out.includes(sync.STANDING_RULES_REL));
    t('79m3 the pending-migration skip is NEVER listed under "skipped (symlink/unsafe)"',
      !lines.some((l) => /skipped \(symlink\/unsafe\)/.test(l) && l.includes(sync.STANDING_RULES_REL)));
    t('79m3 a genuine symlink/unsafe skip KEEPS the original label, unaffected',
      lines.some((l) => /skipped \(symlink\/unsafe\)/.test(l) && l.includes('some/other/file.json:symlink')));
  }

  // 79m4: the warning text at every call site advises fixing the JSON (with a copy-first safety
  // net), and NEVER suggests removing/deleting the file — it may hold the owner's own rules.
  {
    function assertSafeAdvice(label, warnings) {
      const joined = warnings.join(' ');
      t(label + ' advice never says "remove that file"', !/remove that file/i.test(joined));
      t(label + ' advice never says "or remove"', !/\bor remove\b/i.test(joined));
      t(label + ' advice says to fix the JSON', /fix that file.?s? json|fix that file/i.test(joined));
      t(label + ' advice explicitly says never to delete it', /never delete it/i.test(joined));
    }

    // safeSyncProject's own "refusing to replace" warning
    {
      const tpl = tplWithCleanRule79m('t79m4-safe-tpl', 'product-79m4a');
      const { p } = projectWithOwnerRuleAndMalformedUser79m('t79m4-safe-root', 'owner-79m4a');
      const warnings = [];
      const origErr = console.error; console.error = (m) => warnings.push(m);
      try { sync.safeSyncProject(tpl, p, { batchId: 'b79m4a', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true, allowDegraded: true }); }
      finally { console.error = origErr; }
      assertSafeAdvice('79m4 safeSyncProject', warnings.filter((w) => /refusing to replace/i.test(w)));
    }

    // rawInstall's own "refusing to replace" warning (--unsafe path)
    {
      const tpl = tplWithCleanRule79m('t79m4-unsafe-tpl', 'product-79m4b');
      const { p } = projectWithOwnerRuleAndMalformedUser79m('t79m4-unsafe-root', 'owner-79m4b');
      const warnings = [];
      const origErr = console.error; console.error = (m) => warnings.push(m);
      try { sync.rawInstall(tpl, p, { batchId: 'b79m4b', nowIso: '2026-01-01T00:00:00.000Z', forceOverwrite: true }); } // see 79l3
      finally { console.error = origErr; }
      assertSafeAdvice('79m4 rawInstall', warnings.filter((w) => /refusing to replace/i.test(w)));
    }

    // migrateOwnerStandingRules()'s own "could not read" warning (an unreadable — not malformed — user
    // file), injected the same way section 58 injects a non-ENOENT fs error.
    {
      const dir = freshDir('t79m4-unreadable');
      const standingDir = path.join(dir, '.claude', 'config', 'orchestration');
      fs.mkdirSync(standingDir, { recursive: true });
      fs.writeFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({
        version: 1, rules: [standingRule({ id: 'owner-79m4c', source: 'owner /forge remember' })],
      }, null, 2) + '\n');
      const userPath = path.join(standingDir, 'FORGE_STANDING_RULES.user.json');
      fs.writeFileSync(userPath, '{}');
      const origRead = fs.readFileSync;
      fs.readFileSync = function (fp, opts) {
        if (path.resolve(String(fp)) === path.resolve(userPath)) { const e = new Error('EACCES: permission denied (injected)'); e.code = 'EACCES'; throw e; }
        return origRead.call(fs, fp, opts);
      };
      const warnings = [];
      const origErr = console.error; console.error = (m) => warnings.push(m);
      try { sync.migrateOwnerStandingRules(dir); } finally { console.error = origErr; fs.readFileSync = origRead; }
      assertSafeAdvice('79m4 migrateOwnerStandingRules (unreadable user file)', warnings.filter((w) => /could not read/i.test(w)));
    }
  }
}

// 79j) N8 — a null/non-object rule in either rules array must never crash the migration (skipped when
// computing ids, left untouched — never silently dropped — in whatever gets written).
console.log('\n79j) N8 fix — a null rule entry never crashes the migration');
{
  const dir = freshDir('t79j-nullrule');
  const standingDir = path.join(dir, '.claude', 'config', 'orchestration');
  fs.mkdirSync(standingDir, { recursive: true });
  fs.writeFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({
    version: 1,
    rules: [null, standingRule({ id: 'owner-rule-79j', source: 'owner /forge remember' })],
  }, null, 2) + '\n');
  // pre-seed a user file that ALREADY has a null entry (e.g. from a hand-edit) — computing existingIds
  // from this must never throw on the null's missing .id.
  fs.writeFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.user.json'), JSON.stringify({ version: 1, rules: [null] }, null, 2) + '\n');

  let ids;
  t('79j a null rule in the TEMPLATE and a null rule already in the USER file never throws', (() => {
    try { ids = sync.migrateOwnerStandingRules(dir); return true; } catch { return false; }
  })());
  t('79j the real owner rule still migrated despite the null entries', Array.isArray(ids) && ids.includes('owner-rule-79j'));
  const userDocAfter = JSON.parse(fs.readFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.user.json'), 'utf8'));
  t('79j the pre-existing null entry is preserved (not silently dropped)', userDocAfter.rules.some((r) => r === null));
  t('79j the migrated rule landed alongside it', userDocAfter.rules.some((r) => r && r.id === 'owner-rule-79j'));
}

// 79k) N8 — the write goes through the same symlink/containment guards every other forge-sync write
// uses: a junctioned config/orchestration/ directory must refuse the write, never follow it outside
// .claude/. Skipped honestly when this sandbox cannot create a junction (matches the M6/38 pattern).
console.log('\n79k) N8 fix — the migration write honors the symlink/containment guard');
{
  const dir = freshDir('t79k-junction');
  const standingDir = path.join(dir, '.claude', 'config', 'orchestration');
  fs.mkdirSync(path.join(dir, '.claude', 'config'), { recursive: true });
  const outside = freshDir('t79k-outside');
  let junctionOk = false;
  try { fs.symlinkSync(outside, standingDir, 'junction'); junctionOk = true; }
  catch (e) { console.log('     (79k evidence: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
  if (junctionOk) {
    fs.writeFileSync(path.join(standingDir, 'FORGE_STANDING_RULES.json'), JSON.stringify({
      version: 1, rules: [standingRule({ id: 'owner-rule-79k', source: 'owner /forge remember' })],
    }, null, 2) + '\n');
    const warnings = [];
    const origErr = console.error;
    console.error = (msg) => warnings.push(msg);
    let ids;
    try { ids = sync.migrateOwnerStandingRules(dir); } finally { console.error = origErr; }
    t('79k a junctioned orchestration/ dir refuses the migration write (returns [])', Array.isArray(ids) && ids.length === 0);
    t('79k nothing was written into the OUTSIDE (junction target) directory', !fs.existsSync(path.join(outside, 'FORGE_STANDING_RULES.user.json')));
    t('79k a visible warning explains the refusal', warnings.some((w) => /symlink|junction|escapes/.test(w)));
  } else {
    t('(79k skipped honestly — junction creation unavailable in this sandbox)', true);
  }
}

// =====================================================================================
// 80) — retired Control Center cleanup (pruneRetiredFiles / restoreRetiredPruneLedger)
// The old server.cjs + its static UI were removed from this repo's OWN template; these tests use a
// hermetic fixture template (never the real one) and drive pruneRetiredFiles()/restoreRetiredPruneLedger()
// directly, plus safeSyncProject()/rawInstall()/rollbackProject() end-to-end, to prove the cleanup this
// work package added to forge-sync.cjs — never the real 12 Forge projects.
// =====================================================================================
console.log('\n80) v2.9.0 WP-N1 — retired Control Center cleanup');
{
  const ONE_RETIRED = sync.RETIRED_TEMPLATE_FILES[0]; // 'forge-dashboard/server.cjs'
  const ANOTHER_RETIRED = sync.RETIRED_TEMPLATE_FILES[1]; // 'forge-dashboard/index.html'

  console.log('\n80a) classification: nothing present -> empty result, never an error');
  {
    const p = makeProject(freshDir('t80a-root'), 'proj', null);
    const rp = sync.pruneRetiredFiles(p, { dryRun: true });
    t('80a removable is empty', rp.removable.length === 0);
    t('80a kept is empty', rp.kept.length === 0);
    t('80a applied stays false (dry-run/nothing to do)', rp.applied === false);
  }

  console.log('\n80b) classification: unmodified vs modified vs unverifiable');
  {
    const p = makeProject(freshDir('t80b-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'server.cjs'), '// old server.cjs\n');
    fs.writeFileSync(path.join(dashDir, 'index.html'), '<!-- old index -->\n');
    fs.writeFileSync(path.join(dashDir, 'app.js'), '// no receipt entry at all for this one\n');
    const serverHash = sync.sha256(path.join(dashDir, 'server.cjs'));
    // server.cjs: receipt says this EXACT hash was last shipped -> unmodified -> removable
    // index.html: receipt says a DIFFERENT hash was last shipped -> modified -> kept
    // app.js: no receipt entry at all -> unverifiable -> kept
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/server.cjs': serverHash, 'forge-dashboard/index.html': 'deadbeef'.repeat(8) } });
    const rp = sync.pruneRetiredFiles(p, { dryRun: true });
    t('80b server.cjs (unmodified) is removable', rp.removable.some((e) => e.rel === 'forge-dashboard/server.cjs'));
    t('80b index.html (modified) is kept, not removable', rp.kept.some((k) => k.rel === 'forge-dashboard/index.html' && /modified/.test(k.reason)) && !rp.removable.some((e) => e.rel === 'forge-dashboard/index.html'));
    t('80b app.js (no receipt entry) is kept, not removable', rp.kept.some((k) => k.rel === 'forge-dashboard/app.js' && /no last-shipped hash/.test(k.reason)) && !rp.removable.some((e) => e.rel === 'forge-dashboard/app.js'));
    t('80b classification alone never deletes anything (dry-run)', fs.existsSync(path.join(dashDir, 'server.cjs')) && fs.existsSync(path.join(dashDir, 'index.html')) && fs.existsSync(path.join(dashDir, 'app.js')));
  }

  console.log('\n80c) generated state files (PORT/DASHBOARD_STATE.json) are removable unconditionally');
  {
    const p = makeProject(freshDir('t80c-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'PORT'), '3812\n');
    fs.writeFileSync(path.join(dashDir, 'DASHBOARD_STATE.json'), '{"status":"ready"}\n');
    // deliberately NO receipt at all -- these must never need a "last shipped hash" to be removable
    const rp = sync.pruneRetiredFiles(p, { dryRun: true });
    t('80c PORT is removable with no receipt at all', rp.removable.some((e) => e.rel === 'forge-dashboard/PORT' && e.generatedState === true));
    t('80c DASHBOARD_STATE.json is removable with no receipt at all', rp.removable.some((e) => e.rel === 'forge-dashboard/DASHBOARD_STATE.json' && e.generatedState === true));
  }

  console.log('\n80d) dry-run and no-batchId both stay preview-only');
  {
    const p = makeProject(freshDir('t80d-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'server.cjs'), '// old\n');
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/server.cjs': sync.sha256(path.join(dashDir, 'server.cjs')) } });
    const rpDry = sync.pruneRetiredFiles(p, { dryRun: true, batchId: 'b80d-unused' });
    t('80d dryRun:true never removes even with a batchId given', rpDry.applied === false && fs.existsSync(path.join(dashDir, 'server.cjs')));
    const rpNoBatch = sync.pruneRetiredFiles(p, {});
    t('80d no batchId at all -> preview-only, reports why', rpNoBatch.applied === false && /batchId required/.test(rpNoBatch.error || '') && fs.existsSync(path.join(dashDir, 'server.cjs')));
  }

  console.log('\n80e) a real removal backs up bytes BEFORE deleting, writes a ledger, and only lists genuinely removed rels');
  {
    const p = makeProject(freshDir('t80e-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'server.cjs'), '// old server.cjs, byte content X\n');
    fs.writeFileSync(path.join(dashDir, 'index.html'), '<!-- old index, kept because modified -->\n');
    fs.writeFileSync(path.join(dashDir, 'PORT'), '3812\n');
    const serverHash = sync.sha256(path.join(dashDir, 'server.cjs'));
    const portHash = sync.sha256(path.join(dashDir, 'PORT'));
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/server.cjs': serverHash, 'forge-dashboard/index.html': 'not-the-real-hash' } });
    const rp = sync.pruneRetiredFiles(p, { batchId: 'b80e' });
    t('80e applied is true (something really happened)', rp.applied === true);
    t('80e server.cjs was removed', rp.removed.includes('forge-dashboard/server.cjs'));
    t('80e PORT was removed', rp.removed.includes('forge-dashboard/PORT'));
    t('80e index.html (modified) was NOT removed', !rp.removed.includes('forge-dashboard/index.html') && fs.existsSync(path.join(dashDir, 'index.html')));
    t('80e server.cjs is really gone from disk', !fs.existsSync(path.join(dashDir, 'server.cjs')));
    t('80e PORT is really gone from disk', !fs.existsSync(path.join(dashDir, 'PORT')));
    const backupPath = path.join(sync.backupDirFor(p, 'b80e'), 'retired-prune', 'forge-dashboard', 'server.cjs');
    t('80e the removed bytes were backed up BEFORE deletion, byte-identical', fs.existsSync(backupPath) && sync.sha256(backupPath) === serverHash);
    const ledger = JSON.parse(fs.readFileSync(path.join(sync.backupDirFor(p, 'b80e'), 'retired-prune-manifest.json'), 'utf8'));
    // PORT is now ALSO ledgered (no longer excluded as "generated state") — server.cjs was
    // being kept-if-modified in NO way here (it was removed), so PORT is safe to remove AND to restore.
    t('80e the ledger names the real template file AND the removed PORT state (SYNC-2)', ledger.files.length === 2
      && ledger.files.some((f) => f.rel === 'forge-dashboard/server.cjs' && f.oldHash === serverHash)
      && ledger.files.some((f) => f.rel === 'forge-dashboard/PORT' && f.oldHash === portHash));
    t('80e index.html never appears in the ledger (it was kept, never removed)', !ledger.files.some((f) => f.rel === 'forge-dashboard/index.html'));
    t('80e no failures reported', !rp.failed || rp.failed.length === 0);
  }

  console.log('\n80f) restoreRetiredPruneLedger brings a pruned file back, hash-verified');
  {
    const p = makeProject(freshDir('t80f-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'app.js'), '// content to restore later\n');
    const appHash = sync.sha256(path.join(dashDir, 'app.js'));
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/app.js': appHash } });
    sync.pruneRetiredFiles(p, { batchId: 'b80f' });
    t('80f precondition: app.js is really gone before restore', !fs.existsSync(path.join(dashDir, 'app.js')));
    const restore = sync.restoreRetiredPruneLedger(p, 'b80f');
    t('80f restore reports ok:true', restore.ok === true);
    t('80f app.js restored to disk', fs.existsSync(path.join(dashDir, 'app.js')));
    t('80f restored bytes are byte-identical (hash matches)', sync.sha256(path.join(dashDir, 'app.js')) === appHash);
  }

  console.log('\n80g) restoreRetiredPruneLedger on a batch that pruned nothing is an honest, silent no-op');
  {
    const p = makeProject(freshDir('t80g-root'), 'proj', null);
    fs.mkdirSync(path.join(p, '.claude', 'forge-backups', 'b80g-empty'), { recursive: true });
    const restore = sync.restoreRetiredPruneLedger(p, 'b80g-empty');
    t('80g ok:true (never an error just because nothing was pruned)', restore.ok === true);
    t('80g restored is empty', restore.restored.length === 0);
    const restoreNoBatchDir = sync.restoreRetiredPruneLedger(p, 'b80g-never-existed');
    t('80g a batch dir that never existed at all is ALSO an honest no-op, not a throw', restoreNoBatchDir.ok === true);
  }

  console.log('\n80h) safeSyncProject: the no-op file-plan path STILL prunes a retired file (the tricky case —');
  console.log('     preflight()/buildPlan() never see a retired file at all, since it left listSystemFiles())');
  {
    const tpl = freshDir('t80h-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'SAME-CONTENT');
    const p = makeProject(freshDir('t80h-root'), 'proj', null);
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'SAME-CONTENT'); // already up to date -> toChange.length === 0
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'server.cjs'), '// legacy, unmodified since last sync\n');
    const serverHash = sync.sha256(path.join(dashDir, 'server.cjs'));
    sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': sync.sha256(path.join(tpl, 'forge-bin', 'tool.cjs')), 'forge-dashboard/server.cjs': serverHash } });
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b80h', nowIso: '2026-01-01T00:00:00.000Z' });
    t('80h the file plan really was a no-op (proves this is the tricky path, not the normal apply path)', r.noop === true && r.plan.toChange.length === 0);
    t('80h ok:true', r.ok === true);
    t('80h retiredPrune actually ran and removed the legacy file', r.retiredPrune && r.retiredPrune.removed.includes('forge-dashboard/server.cjs'));
    t('80h server.cjs is really gone from disk', !fs.existsSync(path.join(dashDir, 'server.cjs')));
    t('80h a real backup exists for it', fs.existsSync(path.join(sync.backupDirFor(p, 'b80h'), 'retired-prune', 'forge-dashboard', 'server.cjs')));
  }

  console.log('\n80i) safeSyncProject: the normal apply path ALSO prunes, and a MODIFIED retired file is kept');
  {
    const tpl = freshDir('t80i-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2-CONTENT'); // differs from the project's V1 -> real toChange
    const p = makeProject(freshDir('t80i-root'), 'proj', 0); // doctorExit 0 -> validation can pass
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1-CONTENT');
    const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'server.cjs'), '// unmodified legacy file\n');
    fs.writeFileSync(path.join(dashDir, 'app.js'), '// this one was hand-edited by the owner\n');
    const serverHash = sync.sha256(path.join(dashDir, 'server.cjs'));
    sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': v1Hash, 'forge-dashboard/server.cjs': serverHash, 'forge-dashboard/app.js': 'some-other-hash-the-owner-edit-no-longer-matches' } });
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b80i', nowIso: '2026-01-01T00:00:00.000Z' });
    t('80i this really is the normal (non-no-op) apply path', r.plan.toChange.length === 1 && r.noop === undefined);
    t('80i sync succeeded', r.ok === true);
    t('80i unmodified server.cjs was pruned', r.retiredPrune.removed.includes('forge-dashboard/server.cjs') && !fs.existsSync(path.join(dashDir, 'server.cjs')));
    t('80i modified app.js was KEPT, not deleted (owner edit preserved)', fs.existsSync(path.join(dashDir, 'app.js')) && r.retiredPrune.kept.some((k) => k.rel === 'forge-dashboard/app.js'));
  }

  console.log('\n80j) rawInstall (--unsafe) prunes too, using the same real backup');
  {
    const tpl = freshDir('t80j-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V1-CONTENT'); // matches project -> toChange:[] on the --unsafe path too
    const p = makeProject(freshDir('t80j-root'), 'proj', null);
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1-CONTENT');
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'graph.js'), '// legacy graph.js\n');
    const graphHash = sync.sha256(path.join(dashDir, 'graph.js'));
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/graph.js': graphHash } });
    const r = sync.rawInstall(tpl, p, { batchId: 'b80j', nowIso: '2026-01-01T00:00:00.000Z' });
    t('80j --unsafe install reports ok:true', r.ok === true);
    t('80j graph.js was pruned via --unsafe too', r.retiredPrune && r.retiredPrune.removed.includes('forge-dashboard/graph.js'));
    t('80j graph.js is really gone from disk', !fs.existsSync(path.join(dashDir, 'graph.js')));
  }

  console.log('\n80k) rollback restores a pruned retired file (best-effort, on top of the normal rollback)');
  {
    const tpl = freshDir('t80k-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2-CONTENT');
    const p = makeProject(freshDir('t80k-root'), 'proj', 0);
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1-CONTENT');
    const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'lenses.js'), '// legacy lenses.js\n');
    const lensesHash = sync.sha256(path.join(dashDir, 'lenses.js'));
    sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': v1Hash, 'forge-dashboard/lenses.js': lensesHash } });
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b80k', nowIso: '2026-01-01T00:00:00.000Z' });
    t('80k precondition: sync succeeded and pruned lenses.js', r.ok === true && r.retiredPrune.removed.includes('forge-dashboard/lenses.js'));
    t('80k precondition: lenses.js is really gone', !fs.existsSync(path.join(dashDir, 'lenses.js')));
    const rb = sync.rollbackProject(p, 'b80k', {});
    t('80k rollback reports ok:true', rb.ok === true);
    t('80k rollback restored the regular file too (unaffected by the prune addition)', fs.existsSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) && sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) === v1Hash);
    t('80k retiredPruneRestore is present on the rollback result', !!rb.retiredPruneRestore);
    t('80k lenses.js came back, byte-identical', fs.existsSync(path.join(dashDir, 'lenses.js')) && sync.sha256(path.join(dashDir, 'lenses.js')) === lensesHash);
  }

  console.log('\n80l) ONE_RETIRED/ANOTHER_RETIRED sanity: the real constant list actually names the 7 removed files');
  {
    t('80l exactly 7 retired template files are named', sync.RETIRED_TEMPLATE_FILES.length === 7);
    t('80l server.cjs and index.html are both in the list', sync.RETIRED_TEMPLATE_FILES.includes(ONE_RETIRED) && sync.RETIRED_TEMPLATE_FILES.includes(ANOTHER_RETIRED));
    t('80l exactly 2 retired state files are named (PORT, DASHBOARD_STATE.json)', sync.RETIRED_STATE_FILES.length === 2 && sync.RETIRED_STATE_FILES.every((r) => /^forge-dashboard\//.test(r)));
  }
}

// =====================================================================================
// 81) — hardening pruneRetiredFiles()/restoreRetiredPruneLedger()/rollbackProject() against
// 5 findings from an independent Codex adversarial review (SYNC-1..SYNC-5). One subsection per finding;
// all fixtures are hermetic os.tmpdir() dirs, same as section 80 — never the real 12 Forge projects.
// =====================================================================================
console.log('\n81) v2.9.0 WP-Q3 — retired-prune hardening (SYNC-1..SYNC-5, independent Codex adversarial review)');
{
  console.log('\n81a) SYNC-1: a no-op-file-plan prune (no main manifest.json for this batch) can still be rolled back via its own ledger');
  {
    const tpl = freshDir('t81a-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'SAME-CONTENT');
    const p = makeProject(freshDir('t81a-root'), 'proj', null);
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'SAME-CONTENT'); // toChange.length === 0 -> the no-op path
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'server.cjs'), '// legacy, unmodified since last sync\n');
    const serverHash = sync.sha256(path.join(dashDir, 'server.cjs'));
    sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': sync.sha256(path.join(tpl, 'forge-bin', 'tool.cjs')), 'forge-dashboard/server.cjs': serverHash } });
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b81a', nowIso: '2026-01-01T00:00:00.000Z' });
    t('81a precondition: really the no-op path', r.noop === true && r.plan.toChange.length === 0);
    t('81a precondition: no main manifest.json exists for this batch (nothing else to back up)', !fs.existsSync(path.join(sync.backupDirFor(p, 'b81a'), 'manifest.json')));
    t('81a precondition: server.cjs is really gone', !fs.existsSync(path.join(dashDir, 'server.cjs')));
    const rb = sync.rollbackProject(p, 'b81a', {});
    t('81a rollback reports ok:true even with no main manifest for this batch', rb.ok === true);
    t('81a rollback source is labeled ledger-only', rb.source === 'retired-prune-ledger-only');
    t('81a server.cjs is really back, byte-identical', fs.existsSync(path.join(dashDir, 'server.cjs')) && sync.sha256(path.join(dashDir, 'server.cjs')) === serverHash);
    t('81a retiredPruneRestore names it restored', rb.retiredPruneRestore && rb.retiredPruneRestore.restored.includes('forge-dashboard/server.cjs'));
    // SYNC-3 idempotency refinement: re-running rollback on the SAME already-restored ledger-only batch
    // must not misreport the now-existing, byte-identical file as a "recreated" conflict — restoreRetiredPruneLedger
    // has no journal, so a second call re-examines every entry from scratch via fs.existsSync.
    const rb2 = sync.rollbackProject(p, 'b81a', {});
    t('81a a SECOND rollback of the same batch is still ok:true (idempotent, not a false conflict)', rb2.ok === true);
    t('81a the second rollback reports the file as restored again, never as a conflict', rb2.retiredPruneRestore.restored.includes('forge-dashboard/server.cjs') && rb2.retiredPruneRestore.conflicts.length === 0);
    t('81a the file is still byte-identical after the second rollback', sync.sha256(path.join(dashDir, 'server.cjs')) === serverHash);
  }

  console.log('\n81b) SYNC-2: a KEPT (modified) server.cjs means PORT/DASHBOARD_STATE.json are kept too, not deleted');
  {
    const p = makeProject(freshDir('t81b-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'server.cjs'), '// owner-modified server.cjs\n');
    fs.writeFileSync(path.join(dashDir, 'PORT'), '4001\n');
    fs.writeFileSync(path.join(dashDir, 'DASHBOARD_STATE.json'), '{"status":"ready"}\n');
    // receipt records a hash that does NOT match what's on disk -> server.cjs classifies as "modified" -> kept
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/server.cjs': 'not-the-real-hash-'.repeat(2) } });
    const rpPreview = sync.pruneRetiredFiles(p, { dryRun: true });
    t('81b precondition: server.cjs is kept (modified), not removable', rpPreview.kept.some((k) => k.rel === 'forge-dashboard/server.cjs') && !rpPreview.removable.some((e) => e.rel === 'forge-dashboard/server.cjs'));
    t('81b PORT is kept alongside it, not removable', rpPreview.kept.some((k) => k.rel === 'forge-dashboard/PORT') && !rpPreview.removable.some((e) => e.rel === 'forge-dashboard/PORT'));
    t('81b DASHBOARD_STATE.json is kept alongside it too', rpPreview.kept.some((k) => k.rel === 'forge-dashboard/DASHBOARD_STATE.json'));
    const rpReal = sync.pruneRetiredFiles(p, { batchId: 'b81b' });
    t('81b a real run does NOT delete PORT (nothing was removable at all)', rpReal.applied === false && fs.existsSync(path.join(dashDir, 'PORT')));
    t('81b server.cjs itself is untouched too (owner edit preserved)', fs.existsSync(path.join(dashDir, 'server.cjs')));
    t('81b DASHBOARD_STATE.json is untouched too', fs.existsSync(path.join(dashDir, 'DASHBOARD_STATE.json')));
  }

  console.log('\n81c) SYNC-2: a removed state file (PORT) is now ledgered and comes back via a full rollback');
  {
    const tpl = freshDir('t81c-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2-CONTENT');
    const p = makeProject(freshDir('t81c-root'), 'proj', 0);
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1-CONTENT');
    const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'PORT'), '4321\n');
    const portHash = sync.sha256(path.join(dashDir, 'PORT'));
    sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': v1Hash } }); // no server.cjs at all -> nothing kept -> PORT removable
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b81c', nowIso: '2026-01-01T00:00:00.000Z' });
    t('81c precondition: PORT was really pruned', r.ok === true && r.retiredPrune.removed.includes('forge-dashboard/PORT'));
    t('81c precondition: PORT is really gone', !fs.existsSync(path.join(dashDir, 'PORT')));
    const rb = sync.rollbackProject(p, 'b81c', {});
    t('81c rollback reports ok:true', rb.ok === true);
    t('81c PORT came back, byte-identical', fs.existsSync(path.join(dashDir, 'PORT')) && sync.sha256(path.join(dashDir, 'PORT')) === portHash);
  }

  console.log('\n81d) SYNC-3: a path recreated AFTER the prune is a rollback conflict — never overwritten, reported as partial');
  {
    const p = makeProject(freshDir('t81d-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'app.js'), '// old app.js\n');
    const oldHash = sync.sha256(path.join(dashDir, 'app.js'));
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/app.js': oldHash } });
    sync.pruneRetiredFiles(p, { batchId: 'b81d' });
    t('81d precondition: app.js is really gone', !fs.existsSync(path.join(dashDir, 'app.js')));
    // recreate a DIFFERENT file at the exact same path (e.g. a fresh sync re-shipped it, or the owner made a new one)
    fs.writeFileSync(path.join(dashDir, 'app.js'), '// BRAND NEW content, unrelated to the retired backup\n');
    const newHash = sync.sha256(path.join(dashDir, 'app.js'));
    const restore = sync.restoreRetiredPruneLedger(p, 'b81d');
    t('81d restore reports ok:false (a conflict is not a clean success)', restore.ok === false);
    t('81d restore reports partial:true', restore.partial === true);
    t('81d the conflict names the exact path', restore.conflicts.some((c) => c.rel === 'forge-dashboard/app.js'));
    t('81d the recreated file was NEVER overwritten', sync.sha256(path.join(dashDir, 'app.js')) === newHash);
    t('81d nothing was (falsely) reported as restored', !restore.restored.includes('forge-dashboard/app.js'));
  }

  console.log('\n81e) SYNC-4: an unsafe --batch-id (path traversal or otherwise malformed) is refused before anything is touched or written');
  {
    const p = makeProject(freshDir('t81e-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'panels.js'), '// legacy panels.js\n');
    const panelsHash = sync.sha256(path.join(dashDir, 'panels.js'));
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/panels.js': panelsHash } });
    for (const bad of ['..\\..\\..\\outside', '../../../outside', 'a/b', 'a b', '.', '..', 'x'.repeat(101)]) {
      const rBad = sync.pruneRetiredFiles(p, { batchId: bad });
      t('81e unsafe batch id ' + JSON.stringify(bad) + ' is refused, nothing applied', rBad.applied === false && /unsafe --batch-id/.test(rBad.error || ''));
    }
    t('81e the file was NEVER touched by any of the refused attempts', fs.existsSync(path.join(dashDir, 'panels.js')) && sync.sha256(path.join(dashDir, 'panels.js')) === panelsHash);
    t('81e no backup directory was ever created for any refused batch', !fs.existsSync(path.join(p, '.claude', 'forge-backups')));
  }

  console.log('\n81f) SYNC-4: a symlinked/junctioned retired-prune batch backup dir is refused, with the file still present');
  {
    const p = makeProject(freshDir('t81f-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'styles.css'), '/* legacy styles.css */\n');
    const stylesHash = sync.sha256(path.join(dashDir, 'styles.css'));
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/styles.css': stylesHash } });
    const outside = freshDir('t81f-outside');
    const bdir = path.join(p, '.claude', 'forge-backups', 'b81f');
    fs.mkdirSync(path.dirname(bdir), { recursive: true });
    let junctionOk = false;
    try { fs.symlinkSync(outside, bdir, 'junction'); junctionOk = true; }
    catch (e) { console.log('     (81f evidence: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
    if (junctionOk) {
      const rp = sync.pruneRetiredFiles(p, { batchId: 'b81f' });
      t('81f a junctioned batch backup dir is refused, never applied', rp.applied === false && /symlink\/junction/.test(rp.error || ''));
      t('81f the file was NEVER touched', fs.existsSync(path.join(dashDir, 'styles.css')) && sync.sha256(path.join(dashDir, 'styles.css')) === stylesHash);
      t('81f nothing was written into the junction target', !fs.existsSync(path.join(outside, 'retired-prune')));
    } else {
      t('(81f skipped honestly — junction creation unavailable in this sandbox)', true);
    }
  }

  console.log('\n81g) SYNC-5: a forged ledger entry naming a path outside the known retired-file list is ignored (never restored) and reported; the legit entry still restores');
  {
    const p = makeProject(freshDir('t81g-root'), 'proj', null);
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'graph.js'), '// legacy graph.js\n');
    const graphHash = sync.sha256(path.join(dashDir, 'graph.js'));
    sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/graph.js': graphHash } });
    sync.pruneRetiredFiles(p, { batchId: 'b81g' });
    t('81g precondition: graph.js is really gone', !fs.existsSync(path.join(dashDir, 'graph.js')));
    // tamper: append a forged entry naming a path that is NOT in RETIRED_TEMPLATE_FILES/RETIRED_STATE_FILES
    const ledgerPath = path.join(sync.backupDirFor(p, 'b81g'), 'retired-prune-manifest.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger.files.push({ rel: 'forge-bin/forge-sync.cjs', oldHash: 'deadbeef'.repeat(8) }); // a totally unrelated, sensitive real file
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    const restore = sync.restoreRetiredPruneLedger(p, 'b81g');
    t('81g the legit entry still restores fine', restore.restored.includes('forge-dashboard/graph.js') && fs.existsSync(path.join(dashDir, 'graph.js')) && sync.sha256(path.join(dashDir, 'graph.js')) === graphHash);
    t('81g nothing was ever written at the forged path', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'forge-sync.cjs')));
    t('81g the forged entry is reported (never silently vanished), not restored', restore.failed.some((f) => f.rel === 'forge-bin/forge-sync.cjs' && /not a known retired-file path/.test(f.reason)));
    t('81g overall ok is false (a forged entry taints the result honestly)', restore.ok === false);
  }

  console.log('\n81h) SYNC-5: a missing/corrupt backup payload for a ledgered entry makes the restore — and the whole rollback — not ok');
  {
    const tpl = freshDir('t81h-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2-CONTENT');
    const p = makeProject(freshDir('t81h-root'), 'proj', 0);
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1-CONTENT');
    const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
    const dashDir = path.join(p, '.claude', 'forge-dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'app.js'), '// legacy app.js\n');
    const appHash = sync.sha256(path.join(dashDir, 'app.js'));
    sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': v1Hash, 'forge-dashboard/app.js': appHash } });
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b81h', nowIso: '2026-01-01T00:00:00.000Z' });
    t('81h precondition: sync succeeded and pruned app.js', r.ok === true && r.retiredPrune.removed.includes('forge-dashboard/app.js'));
    // corrupt/lose the backup payload itself (simulate a lost/corrupted backup file)
    const backupPath = path.join(sync.backupDirFor(p, 'b81h'), 'retired-prune', 'forge-dashboard', 'app.js');
    fs.rmSync(backupPath, { force: true });
    const rb = sync.rollbackProject(p, 'b81h', {});
    t('81h rollback reports ok:false — the main files rolled back fine but the retired-file restore did not', rb.ok === false);
    t('81h the reason names the retired-file restore problem', /restoring retired legacy file/.test(rb.reason || ''));
    t('81h retiredPruneRestore itself is not ok', rb.retiredPruneRestore && rb.retiredPruneRestore.ok === false);
    t('81h retiredPruneRestore names app.js as failed (missing backup payload)', rb.retiredPruneRestore.failed.some((f) => f.rel === 'forge-dashboard/app.js'));
    t('81h the main (unrelated) file STILL rolled back fine (additive failure, not total)', fs.existsSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) && sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) === v1Hash);
  }
}

// =====================================================================================
// 82) WP-9B-SRC — SYNC-6 (independent Codex adversarial review, MEDIUM): the default
// rollback (`forge-sync rollback <project>`, no explicit --batch) used to skip a ledger-only batch (see
// rollbackProject's own "SYNC-1" doc comment for the full model) that is the TRUE latest, because
// latestBatchId() only ever considered a batch directory that has a main manifest.json.
// =====================================================================================
console.log('\n82) v2.9.0 WP-9B-SRC — SYNC-6: latestBatchId()/rollback (no --batch) no longer skips a ledger-only batch that is the true latest');
{
  const p = makeProject(freshDir('t82a-root'), 'proj', null);
  const dashDir = path.join(p, '.claude', 'forge-dashboard');
  fs.mkdirSync(dashDir, { recursive: true });

  // An ORDINARY, manifest-bearing OLDER batch — just the fields batchRecency()/latestBatchId() read.
  const oldBatchDir = sync.backupDirFor(p, 'zzz-manifest-older');
  fs.mkdirSync(oldBatchDir, { recursive: true });
  fs.writeFileSync(path.join(oldBatchDir, 'manifest.json'), JSON.stringify({ batchId: 'zzz-manifest-older', ts: '2020-01-01T00:00:00.000Z' }), 'utf8');
  t('82a precondition: the older manifest-bearing batch alone is (unsurprisingly) "the latest" before the newer ledger-only batch exists', sync.latestBatchId(p) === 'zzz-manifest-older');

  // A LEDGER-ONLY NEWER batch (SYNC-6's exact scenario): pruneRetiredFiles() never calls takeBackup(), so
  // this batch has NO manifest.json at all — only its own retired-prune-manifest.json.
  fs.writeFileSync(path.join(dashDir, 'app.js'), '// old app.js\n');
  const appHash = sync.sha256(path.join(dashDir, 'app.js'));
  sync.writeReceipt(p, { knownHashes: { 'forge-dashboard/app.js': appHash } });
  const rp = sync.pruneRetiredFiles(p, { batchId: 'aaa-ledger-only-newest' });
  t('82a precondition: app.js was really pruned into a ledger-only batch', rp.applied === true && rp.removed.includes('forge-dashboard/app.js'));
  const newBatchDir = sync.backupDirFor(p, 'aaa-ledger-only-newest');
  t('82a precondition: that batch really has no manifest.json (ledger-only)', !fs.existsSync(path.join(newBatchDir, 'manifest.json')));
  const future = new Date(Date.now() + 3600000);
  fs.utimesSync(path.join(newBatchDir, 'retired-prune-manifest.json'), future, future); // force it unambiguously newest by mtime

  t('82a batchRecency() reads a real epoch-millis number for BOTH shapes', typeof sync.batchRecency(path.dirname(oldBatchDir), 'zzz-manifest-older') === 'number' && typeof sync.batchRecency(path.dirname(newBatchDir), 'aaa-ledger-only-newest') === 'number');
  t('82a latestBatchId() now returns the ledger-only batch, not the older manifest-bearing one', sync.latestBatchId(p) === 'aaa-ledger-only-newest');

  const rb = sync.rollbackProject(p, undefined, {});
  t('82a rollback with no explicit --batch resolves to the ledger-only newest batch', rb.batchId === 'aaa-ledger-only-newest');
  t('82a rollback source is the ledger-only path', rb.source === 'retired-prune-ledger-only');
  t('82a app.js is really restored, byte-identical', fs.existsSync(path.join(dashDir, 'app.js')) && sync.sha256(path.join(dashDir, 'app.js')) === appHash);

  // Reverse-direction sanity: a genuinely NEWER manifest-bearing batch must still beat an OLDER
  // ledger-only one — the fix must not flip the ordering, only stop EXCLUDING ledger-only batches.
  const newerManifestDir = sync.backupDirFor(p, 'bbb-manifest-newest');
  fs.mkdirSync(newerManifestDir, { recursive: true });
  fs.writeFileSync(path.join(newerManifestDir, 'manifest.json'), JSON.stringify({ batchId: 'bbb-manifest-newest', ts: new Date(Date.now() + 7200000).toISOString() }), 'utf8');
  t('82a a genuinely newer manifest-bearing batch still wins over an older ledger-only one', sync.latestBatchId(p) === 'bbb-manifest-newest');
}

console.log('\n82b) SYNC-6: batchRecency() edge cases — no regression for the pre-existing manifest-only trust model');
{
  const tmp = freshDir('t82b-tmp');
  const bdir = path.join(tmp, '.claude', 'forge-backups');
  fs.mkdirSync(bdir, { recursive: true });

  // A ts far in the future relative to "now" (never a fixed calendar date — this suite must stay correct
  // however far "today" has already moved on from when it was written; see 82b's own mtime-based
  // ledger-only fixture below, which is genuinely stamped at real current time).
  const farFutureIso = new Date(Date.now() + 10 * 365 * 86400000).toISOString();
  fs.mkdirSync(path.join(bdir, 'ok-batch'), { recursive: true });
  fs.writeFileSync(path.join(bdir, 'ok-batch', 'manifest.json'), JSON.stringify({ ts: farFutureIso }), 'utf8');
  t('82b a normal manifest.json with a valid ts -> a finite epoch-millis number', Number.isFinite(sync.batchRecency(bdir, 'ok-batch')));

  fs.mkdirSync(path.join(bdir, 'broken-json'), { recursive: true });
  fs.writeFileSync(path.join(bdir, 'broken-json', 'manifest.json'), '{ not valid json', 'utf8');
  t('82b a present-but-UNPARSEABLE manifest.json -> null (skipped, same "do not trust" posture as before the fix)', sync.batchRecency(bdir, 'broken-json') === null);

  fs.mkdirSync(path.join(bdir, 'no-ts'), { recursive: true });
  fs.writeFileSync(path.join(bdir, 'no-ts', 'manifest.json'), JSON.stringify({ batchId: 'no-ts' }), 'utf8');
  t('82b a manifest.json with NO ts field -> a finite (very old) number, never throws', Number.isFinite(sync.batchRecency(bdir, 'no-ts')));

  fs.mkdirSync(path.join(bdir, 'ledger-only'), { recursive: true });
  fs.writeFileSync(path.join(bdir, 'ledger-only', 'retired-prune-manifest.json'), JSON.stringify({ batchId: 'ledger-only', files: [] }), 'utf8');
  t('82b a ledger-only batch (no manifest.json, has retired-prune-manifest.json) -> a finite mtime-based number', Number.isFinite(sync.batchRecency(bdir, 'ledger-only')));

  fs.mkdirSync(path.join(bdir, 'empty-dir'), { recursive: true });
  t('82b a batch directory with NEITHER file -> null (not a real batch)', sync.batchRecency(bdir, 'empty-dir') === null);

  t('82b latestBatchId() over this whole mixed set picks the real newest (ok-batch, 10 years out, beats no-ts=epoch-0 and the ledger-only batch created just now)', sync.latestBatchId(tmp) === 'ok-batch');
}

// 83) (Verify Boss F2): a shipped forge-bin tool that reads a config/orchestration/*.json
// the sync never ships fails every sync-updated project's doctor (the codex-review.json class, again with
// release-exclusions.json). Generic guard: every config/orchestration/*.json a shipped tool references is
// either a system file itself or on this explicit list of per-project / per-user / opt-in files.
console.log('\n83) every config/orchestration/*.json a shipped tool reads is shipped (or deliberately per-project)');
{
  const tplDir = path.resolve(__dirname, '..');
  const sys = new Set(sync.listSystemFiles(tplDir));
  const PER_PROJECT = new Set([
    'config/orchestration/FORGE_CONTEXT_BUDGET.json', // real per-project data (see forge-sync.cjs)
    'config/orchestration/mcp-opt-in.json',           // owner-authored opt-in, dormant when absent
    // Development-tree data (class local-only, never synced): forge-doctor's feature_registry check and the
    // registry generator judge it ONLY in the dev tree and read it soft (n/a when absent) elsewhere.
    'config/orchestration/FORGE_FEATURE_REGISTRY.json',
  ]);
  const missing = [];
  for (const rel of sys) {
    if (!/^forge-bin\/[^/]+\.cjs$/.test(rel) || /\.test\.cjs$/.test(rel)) continue;
    const src = fs.readFileSync(path.join(tplDir, rel), 'utf8');
    for (const re of [/config\/orchestration\/([A-Za-z0-9_.-]+\.json)/g, /['"]orchestration['"]\s*,\s*['"]([A-Za-z0-9_.-]+\.json)['"]/g]) {
      let m;
      while ((m = re.exec(src))) {
        const f = 'config/orchestration/' + m[1];
        if (sys.has(f) || PER_PROJECT.has(f) || /\.user\.json$/.test(f)) continue;
        missing.push(f + ' (read by ' + rel + ')');
      }
    }
  }
  t('83 no shipped tool reads an unshipped config/orchestration file' + (missing.length ? ' — missing: ' + [...new Set(missing)].join('; ') : ''), missing.length === 0);
  t('83 release-exclusions.json is a system file (forge-release-check.cjs and the doctor need it)', sys.has('config/orchestration/release-exclusions.json'));
}

// 84) --reuse-pre-baseline (owner request 2026-10-06: run the doctor once per install instead of twice).
// The pre-sync H3 baseline may be REUSED from the previous receipt's post-sync validation only when the
// system files are byte-identical (manifest hash) AND the recorded workspace fingerprint matches exactly AND
// the receipt carries a complete, fully green doctor summary. Every other case falls back to a real doctor run.
console.log('\n84) --reuse-pre-baseline: reuse the last receipt\'s validation only when proven safe');
{
  const counterRoot = freshDir('t84-count');
  const makeFixture = (name) => {
    const tpl = freshDir('t84-tpl-' + name);
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'module.exports = 2;\n');
    const p = makeProject(freshDir('t84-root-' + name), 'proj', null);
    const counter = path.join(counterRoot, name + '.count');
    writeDoctorStub(p, 0, 'if (process.argv.indexOf("--json") !== -1) require("fs").appendFileSync(' + JSON.stringify(counter) + ', "x");');
    return { tpl, p, doctorRuns: () => { try { return fs.readFileSync(counter, 'utf8').length; } catch { return 0; } } };
  };
  const bumpTemplate = (tpl, v) => fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'module.exports = ' + v + ';\n');
  const FP1 = { gitHead: 'h1', gitStatusHash: 's1' };
  const fpImpl = (fp) => () => fp;

  // 84a first sync with the flag: no receipt yet -> RUN (reason stated); the receipt records workspace + baselineSource
  const A = makeFixture('a');
  const r1 = sync.safeSyncProject(A.tpl, A.p, { batchId: 'b84-1', nowIso: '2026-01-01T00:00:00.000Z', reusePreBaseline: true, workspaceFingerprintImpl: fpImpl(FP1) });
  t('84a first sync ok', r1.ok === true);
  t('84a no receipt -> baseline RUN with a stated reason (doctor ran twice)', r1.baselineSource.mode === 'run' && /no forge-sync-receipt/.test(r1.baselineSource.fallbackReason) && A.doctorRuns() === 2);
  const rc1 = sync.readReceipt(A.p);
  t('84a receipt records baselineSource (RUN)', !!(rc1.baselineSource && rc1.baselineSource.mode === 'run' && rc1.baselineSource.reuseRequested === true));
  t('84a receipt records the workspace fingerprint (written after the last write)', !!(rc1.workspace && rc1.workspace.gitHead === 'h1' && rc1.workspace.gitStatusHash === 's1'));

  // 84b identical system files + identical workspace -> REUSED, the doctor runs only once
  bumpTemplate(A.tpl, 3);
  const r2 = sync.safeSyncProject(A.tpl, A.p, { batchId: 'b84-2', nowIso: '2026-01-02T00:00:00.000Z', reusePreBaseline: true, workspaceFingerprintImpl: fpImpl(FP1) });
  t('84b second sync ok', r2.ok === true);
  t('84b baseline REUSED from batch b84-1 (24h old; workspace proven, so no age limit)', r2.baselineSource.mode === 'reused' && r2.baselineSource.batchId === 'b84-1' && r2.baselineSource.workspaceProven === true && r2.baselineSource.ageMs === 24 * 3600 * 1000);
  t('84b the doctor ran exactly ONCE for this sync (3 total, not 4)', A.doctorRuns() === 3);
  t('84b the reused summary is the previous receipt\'s post-sync summary', JSON.stringify(r2.preValidation.summary) === JSON.stringify(rc1.validation.summary) && r2.preValidation.reused === true);
  const rc2 = sync.readReceipt(A.p);
  t('84b receipt says REUSED (baselineSource + preValidation.reused)', rc2.baselineSource.mode === 'reused' && rc2.baselineSource.batchId === 'b84-1' && rc2.preValidation.reused === true);
  t('84b the regression comparison still ran on the reused summary (outcome ok)', !!(r2.outcome && r2.outcome.ok === true));

  // 84c a system file changed since the last sync (deleted in the project) -> RUN
  fs.unlinkSync(path.join(A.p, '.claude', 'forge-bin', 'b.cjs'));
  bumpTemplate(A.tpl, 4);
  const r3 = sync.safeSyncProject(A.tpl, A.p, { batchId: 'b84-3', nowIso: '2026-01-02T00:10:00.000Z', reusePreBaseline: true, workspaceFingerprintImpl: fpImpl(FP1) });
  t('84c system file changed -> baseline RUN (manifest hash differs), doctor ran twice', r3.ok === true && r3.baselineSource.mode === 'run' && /system files changed/.test(r3.baselineSource.fallbackReason) && A.doctorRuns() === 5);

  // 84d the workspace fingerprint differs -> RUN
  bumpTemplate(A.tpl, 5);
  const r4 = sync.safeSyncProject(A.tpl, A.p, { batchId: 'b84-4', nowIso: '2026-01-02T00:20:00.000Z', reusePreBaseline: true, workspaceFingerprintImpl: fpImpl({ gitHead: 'h1', gitStatusHash: 's2' }) });
  t('84d workspace status differs -> baseline RUN, doctor ran twice', r4.ok === true && r4.baselineSource.mode === 'run' && /workspace changed/.test(r4.baselineSource.fallbackReason) && A.doctorRuns() === 7);
  bumpTemplate(A.tpl, 6);
  const r4b = sync.safeSyncProject(A.tpl, A.p, { batchId: 'b84-4b', nowIso: '2026-01-02T00:30:00.000Z', reusePreBaseline: true, workspaceFingerprintImpl: fpImpl({ gitHead: 'h2', gitStatusHash: 's2' }) });
  t('84d git HEAD differs -> baseline RUN', r4b.ok === true && r4b.baselineSource.mode === 'run' && /HEAD differs/.test(r4b.baselineSource.fallbackReason));

  // 84e without the flag nothing changes: the doctor runs twice even when reuse would be possible
  bumpTemplate(A.tpl, 7);
  const before = A.doctorRuns();
  const r5 = sync.safeSyncProject(A.tpl, A.p, { batchId: 'b84-5', nowIso: '2026-01-02T00:40:00.000Z', workspaceFingerprintImpl: fpImpl({ gitHead: 'h2', gitStatusHash: 's2' }) });
  t('84e no flag -> baseline RUN (reuseRequested false), doctor ran twice', r5.ok === true && r5.baselineSource.mode === 'run' && r5.baselineSource.reuseRequested === false && A.doctorRuns() === before + 2);

  // 84f a degraded receipt is never reused (integration: edit the receipt on disk)
  const rcDeg = sync.readReceipt(A.p); rcDeg.validation.degraded = true; sync.writeReceipt(A.p, rcDeg);
  bumpTemplate(A.tpl, 8);
  const r6 = sync.safeSyncProject(A.tpl, A.p, { batchId: 'b84-6', nowIso: '2026-01-02T00:50:00.000Z', reusePreBaseline: true, workspaceFingerprintImpl: fpImpl({ gitHead: 'h2', gitStatusHash: 's2' }) });
  t('84f degraded receipt -> baseline RUN', r6.ok === true && r6.baselineSource.mode === 'run' && /degraded/.test(r6.baselineSource.fallbackReason));

  // 84f2 a red-but-accepted receipt (alreadyRedSkipped) with an IDENTICAL manifest + workspace still runs the doctor
  const rcRed = sync.readReceipt(A.p); rcRed.validation.alreadyRedSkipped = true; rcRed.validation.summary = Object.assign({}, rcRed.validation.summary, { ok: false }); sync.writeReceipt(A.p, rcRed);
  bumpTemplate(A.tpl, 9);
  const beforeRed = A.doctorRuns();
  const r7 = sync.safeSyncProject(A.tpl, A.p, { batchId: 'b84-7', nowIso: '2026-01-02T01:00:00.000Z', reusePreBaseline: true, workspaceFingerprintImpl: fpImpl({ gitHead: 'h2', gitStatusHash: 's2' }) });
  t('84f2 red receipt + identical manifest -> baseline RUN (not green), doctor ran twice', r7.ok === true && r7.baselineSource.mode === 'run' && /not green/.test(r7.baselineSource.fallbackReason) && A.doctorRuns() === beforeRed + 2 && r7.preValidation.reused !== true);

  // 84g pure decision table (decidePreBaseline)
  const H = 'manifesthash';
  const now = Date.parse('2026-01-01T10:00:00.000Z');
  const greenSummary = { ok: true, node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 }, checksOk: { node_check: { ok: true }, tests: { ok: true }, model_routing: { ok: true } } };
  const good = { batchId: 'bx', syncedAt: '2026-01-01T09:00:00.000Z', postSyncManifestHash: H, validation: { tool: 'forge-doctor', ok: true, summary: greenSummary }, workspace: FP1 };
  const d = (rc, h, ws) => sync.decidePreBaseline(rc, h === undefined ? H : h, ws === undefined ? FP1 : ws, now);
  t('84g identical -> reuse', d(good).reuse === true && d(good).workspaceProven === true && d(good).note === null);
  t('84g receipt missing -> run', d(null).reuse === false);
  t('84g no validation summary -> run', d(Object.assign({}, good, { validation: { tool: 'forge-doctor', ok: true, summary: null } })).reuse === false);
  t('84g degraded -> run', d(Object.assign({}, good, { validation: Object.assign({}, good.validation, { degraded: true }) })).reuse === false);
  t('84g noEvidence -> run', d(Object.assign({}, good, { validation: Object.assign({}, good.validation, { noEvidence: true }) })).reuse === false);
  t('84g non-doctor tool -> run', d(Object.assign({}, good, { validation: Object.assign({}, good.validation, { tool: 'node-check-fallback' }) })).reuse === false);
  t('84g manifest hash differs -> run', d(good, 'other').reuse === false);
  const notGreen = (vPatch) => d(Object.assign({}, good, { validation: Object.assign({}, good.validation, vPatch) }));
  const isNotGreenRun = (r) => r.reuse === false && r.reason === 'the last receipt was not green — a red baseline is always re-measured';
  t('84g validation ok:false -> run (not green)', isNotGreenRun(notGreen({ ok: false })));
  t('84g summary.ok:false -> run (not green)', isNotGreenRun(notGreen({ summary: { ok: false } })));
  t('84g alreadyRedSkipped -> run (not green)', isNotGreenRun(notGreen({ alreadyRedSkipped: true })));
  t('84g degradedAllowed -> run (not green)', isNotGreenRun(notGreen({ degradedAllowed: true })));
  t('84g fingerprint recorded but none computable now -> run', d(good, H, null).reuse === false);
  // R1 (Codex rev-goat-215cee4-2): reuse requires an EXACT workspace fingerprint match — no age-based legacy path.
  const NO_FP = 'the last receipt has no workspace fingerprint — re-measured';
  const isNoFpRun = (r) => r.reuse === false && r.reason === NO_FP;
  const legacy = Object.assign({}, good); delete legacy.workspace;
  t('84g legacy receipt (no workspace) 1h old, nothing computable now -> run (no fingerprint)', isNoFpRun(d(legacy, H, null)));
  t('84g legacy receipt (no workspace) 1h old, current fingerprint present -> run (no fingerprint)', isNoFpRun(d(legacy, H, FP1)));
  t('84g legacy receipt 7h old -> run (no fingerprint)', isNoFpRun(d(Object.assign({}, legacy, { syncedAt: '2026-01-01T03:00:00.000Z' }))));
  t('84g legacy receipt without a syncedAt -> run (no fingerprint)', isNoFpRun(d(Object.assign({}, legacy, { syncedAt: undefined }))));
  t('84g legacy receipt dated in the future -> run (no fingerprint)', isNoFpRun(d(Object.assign({}, legacy, { syncedAt: '2026-01-01T11:00:00.000Z' }))));
  t('84g non-git receipt (workspace:null) inside 6h -> run (no fingerprint)', isNoFpRun(d(Object.assign({}, good, { workspace: null }), H, null)));
  t('84g receipt workspace without gitStatusHash -> run (no fingerprint)', isNoFpRun(d(Object.assign({}, good, { workspace: { gitHead: 'h1' } }))));
  t('84g current fingerprint without gitStatusHash -> run', d(good, H, { gitHead: 'h1' }).reuse === false);
  t('84g the 6-hour legacy constant is gone (no age-based reuse path left)', sync.PRE_BASELINE_MAX_AGE_MS === undefined);
  // R2 (Codex rev-goat-215cee4-2): the reused summary must be a complete, consistent, fully green doctor summary.
  const withSummary = (s) => d(Object.assign({}, good, { validation: Object.assign({}, good.validation, { summary: s }) }));
  const runWith = (r, re) => r.reuse === false && re.test(r.reason || '');
  t('84j empty summary {} -> run (summary.ok is not true)', runWith(withSummary({}), /summary\.ok is not true/));
  t('84j summary.ok missing but checksOk green -> run', runWith(withSummary({ checksOk: greenSummary.checksOk }), /summary\.ok is not true/));
  t('84j summary without checksOk -> run (no per-check map)', runWith(withSummary({ ok: true }), /no per-check map/));
  t('84j summary with an EMPTY checksOk -> run (no per-check map)', runWith(withSummary({ ok: true, checksOk: {} }), /no per-check map/));
  t('84j checksOk not an object -> run', runWith(withSummary({ ok: true, checksOk: [true] }), /no per-check map/));
  t('84j a RED checksOk entry (model_routing) -> run, names the check', runWith(withSummary(Object.assign({}, greenSummary, { checksOk: Object.assign({}, greenSummary.checksOk, { model_routing: { ok: false } }) })), /not green.*model_routing/));
  t('84j a malformed checksOk entry (no {ok}) -> run', runWith(withSummary(Object.assign({}, greenSummary, { checksOk: { node_check: { ok: true }, model_routing: true } })), /model_routing/));
  t('84j a non-empty failing_suites -> run', runWith(withSummary(Object.assign({}, greenSummary, { failing_suites: ['x.test.cjs (1 failed)'] })), /failing_suites/));
  t('84j failing_suites not an array -> run', runWith(withSummary(Object.assign({}, greenSummary, { failing_suites: 'x' })), /failing_suites/));
  t('84j node_check detail red while checksOk green (inconsistent) -> run', runWith(withSummary(Object.assign({}, greenSummary, { node_check: { ok: false } })), /inconsistent.*node_check/));
  t('84j tests detail red while checksOk green (inconsistent) -> run', runWith(withSummary(Object.assign({}, greenSummary, { tests: { ok: false } })), /inconsistent.*tests/));
  t('84j validation.tool missing -> run (must be forge-doctor)', runWith(d(Object.assign({}, good, { validation: { ok: true, summary: greenSummary } })), /forge-doctor/));
  t('84j an empty failing_suites array is fine -> reuse', withSummary(Object.assign({}, greenSummary, { failing_suites: [] })).reuse === true);
  // The exact Codex repro: a vanished check (model_routing) after a reuse must still be caught as a regression.
  const vanished = { ok: true, checksOk: { node_check: { ok: true }, tests: { ok: true } } };
  t('84j a vanished check is a regression against the (only reusable) complete green baseline', sync.regressionCheck(d(good).preValidation.summary, vanished).indexOf('model_routing') !== -1);
  t('84j the {} summary that used to hide the vanished check is no longer reusable', withSummary({}).reuse === false && withSummary(Object.assign({}, greenSummary, { checksOk: Object.assign({}, greenSummary.checksOk, { model_routing: { ok: false } }) })).reuse === false);

  // 84h parseArgs knows the flag
  t('84h parseArgs: --reuse-pre-baseline sets flags.reusePreBaseline', sync.parseArgs(['proj', '--reuse-pre-baseline']).flags.reusePreBaseline === true);

  // 84i the real git fingerprint: content-aware, ignores forge-sync bookkeeping, null outside git
  const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!gitOk) { console.log('  SKIP 84i: git not available on this machine (the injected-fingerprint tests above still ran)'); }
  else {
    const g = freshDir('t84-git');
    const gitc = (args) => spawnSync('git', ['-C', g, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'].concat(args), { encoding: 'utf8' });
    gitc(['init', '-q']);
    fs.mkdirSync(path.join(g, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(g, 'app.js'), 'v1\n');
    gitc(['add', '-A']); gitc(['commit', '-q', '-m', 'init']);
    const f0 = sync.workspaceFingerprint(g);
    t('84i a git repo gives a fingerprint with a HEAD', !!(f0 && f0.gitHead && f0.gitStatusHash));
    fs.writeFileSync(path.join(g, 'app.js'), 'v2\n');
    const f1 = sync.workspaceFingerprint(g);
    fs.writeFileSync(path.join(g, 'app.js'), 'v3\n');
    const f2 = sync.workspaceFingerprint(g);
    t('84i a dirty file edited AGAIN changes the hash (content-aware, not porcelain-only)', f1.gitStatusHash !== f0.gitStatusHash && f2.gitStatusHash !== f1.gitStatusHash);
    sync.writeReceipt(g, { x: 1 });
    fs.writeFileSync(path.join(g, '.claude', 'FORGE_VERSION.json'), '{}');
    fs.mkdirSync(path.join(g, '.claude', 'forge-backups', 'b1'), { recursive: true });
    fs.writeFileSync(path.join(g, '.claude', 'forge-backups', 'b1', 'manifest.json'), '{}');
    const f3 = sync.workspaceFingerprint(g);
    t('84i forge-sync bookkeeping (receipt, FORGE_VERSION, forge-backups) does not change the fingerprint', f3.gitStatusHash === f2.gitStatusHash && f3.gitHead === f2.gitHead);
    fs.writeFileSync(path.join(g, 'new.txt'), 'n');
    t('84i a new untracked file changes the fingerprint', sync.workspaceFingerprint(g).gitStatusHash !== f3.gitStatusHash);
    gitc(['add', '-A']); gitc(['commit', '-q', '-m', 'two']);
    t('84i a new commit changes gitHead', sync.workspaceFingerprint(g).gitHead !== f0.gitHead);
    t('84i outside a git repo -> null (best-effort, no throw)', sync.workspaceFingerprint(freshDir('t84-nogit')) === null);
  }
}

// =====================================================================================
// forge-sync reads the SHIPPING MANIFEST.
// 85 never-touch floor · 86 --unsafe refuses drift + writes a receipt · 87 seed-only · 88 missing-in-template ·
// 89 orphans (hash-gated report, opt-in move, rollback) · 90 batch-id validation · 91 Scout verdict migration ·
// 92 derived list == the old SYSTEM list except the deliberate corrections · 93 manifest resolution / fail-closed
// =====================================================================================
const SHIP_RULE = (pattern, cls, extra) => Object.assign({ pattern, class: cls, channels: (cls === 'per-project' || cls === 'local-only') ? [] : ['sync', 'release', 'template'], reason: 'fixture ' + cls }, extra || {});
function writeTplManifest(tpl, rules) {
  const f = path.join(tpl, 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schema: 'forge-ship-manifest/v1', rules, known_gaps: [] }, null, 2) + '\n');
  return f;
}
function wfx(base, rel, body) { const f = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; }
function rfx(base, rel) { try { return fs.readFileSync(path.join(base, ...rel.split('/')), 'utf8'); } catch { return null; } }
const NOW_WP2B = '2026-10-09T00:00:00.000Z';
const quiet = (fn) => { const e = console.error, l = console.log, w = []; console.error = (m) => w.push(String(m)); console.log = (m) => w.push(String(m)); try { return { r: fn(), out: w }; } finally { console.error = e; console.log = l; } };

console.log('\n85) WP-2b never-touch floor: per-project memory is untouchable, whatever a manifest says');
{
  // (a) the code floor covers EVERY per-project entry of the REAL manifest (instantiated: braces expanded, * -> x)
  const shipcheck85 = require('./forge-shipcheck.cjs');
  const real85 = shipcheck85.loadManifest(sync.OWN_SHIP_MANIFEST);
  const expand = (s) => { const m = /^([^{]*)\{([^{}]*)\}(.*)$/.exec(s); return m ? m[2].split(',').flatMap((a) => expand(m[1] + a + m[3])) : [s]; };
  const samples = [];
  for (const r of real85.rules.filter((x) => x.class === 'per-project' && x.pattern.startsWith('.claude/'))) {
    for (const p of expand(r.pattern)) {
      const rel = p.slice('.claude/'.length).replace(/\*\*/g, 'x/y').replace(/\*/g, 'x').replace(/\?/g, 'x');
      samples.push({ rel, rule: r.pattern });
    }
  }
  const uncovered = samples.filter((s) => !sync.isNeverTouch(s.rel));
  t('85a the real manifest has per-project entries to check (' + samples.length + ' sample paths)', samples.length >= 30);
  t('85a the never-touch floor covers every per-project entry of the real manifest' + (uncovered.length ? ' — UNCOVERED: ' + uncovered.map((u) => u.rel + ' (' + u.rule + ')').join(', ') : ''), uncovered.length === 0);
  t('85a .claude/forge-scribe/** is explicitly never-touch (per-project scribe ledger)', sync.isNeverTouch('forge-scribe/ledger.jsonl') && sync.isNeverTouchDir('forge-scribe') && sync.NEVER_TOUCH_DIRS.has('forge-scribe'));
  t('85a the three *.user.json overlays are never-touch (MODEL_ROUTING, SCOUT_VETTING, agent-tool-policy)', ['FORGE_MODEL_ROUTING.user.json', 'config/orchestration/FORGE_SCOUT_VETTING.user.json', 'config/agents/agent-tool-policy.user.json'].every((f) => sync.isNeverTouch(f)));
  t('85a a non-plain path (absolute, "..", empty) is never-touch (fail closed)', ['', '/etc/x', 'C:/x', '../x', 'a/../b', 'a//b'].every((f) => sync.isNeverTouch(f)));
  t('85a the fixtures vault is never-touch except its shipped README and seeded .gitignore', sync.isNeverTouch('forge-fixtures/client-a/data.csv') && !sync.isNeverTouch('forge-fixtures/README.md') && !sync.isNeverTouch('forge-fixtures/.gitignore'));

  // (b) a HOSTILE template manifest claiming memory paths as ship-sync/seed-only delivers none of them
  const tpl = freshDir('t85-tpl');
  writeTplManifest(tpl, [
    SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync'),
    SHIP_RULE('.claude/forge-scribe/**', 'ship-sync'), SHIP_RULE('.claude/agent-memory/**', 'ship-sync'),
    SHIP_RULE('.claude/FORGE_MEMORY.md', 'ship-sync'), SHIP_RULE('.claude/FORGE_MODEL_ROUTING.user.json', 'ship-sync'),
    SHIP_RULE('.claude/config/agents/agent-tool-policy.user.json', 'ship-sync'), SHIP_RULE('.claude/forge-accounts/**', 'ship-sync'),
    SHIP_RULE('.claude/forge-research/**', 'seed-only'), SHIP_RULE('.claude/settings.json', 'ship-sync'), // settings.json is absent on purpose: a never-touch literal is never "missing" either
  ]);
  const hostile = ['forge-scribe/ledger.jsonl', 'agent-memory/build-boss/MEMORY.md', 'FORGE_MEMORY.md', 'FORGE_MODEL_ROUTING.user.json', 'config/agents/agent-tool-policy.user.json', 'forge-accounts/alice.json', 'forge-research/notes.md'];
  wfx(tpl, 'forge-bin/tool.cjs', 'TEMPLATE-TOOL');
  for (const f of hostile) wfx(tpl, f, 'TEMPLATE-CONTENT ' + f);
  const sp85 = sync.shipPlan(tpl);
  t('85b the hostile manifest is the template\'s own (source: template)', sp85.manifest.source === 'template');
  t('85b only the legitimate tool is listed for delivery', JSON.stringify(sp85.system) === JSON.stringify(['forge-bin/tool.cjs']) && sp85.seed.length === 0);
  const claimed85 = sp85.neverTouchClaimed.map((n) => n.rel);
  t('85b every claimed memory path/folder is reported as neverTouchClaimed (a manifest bug made visible)', ['forge-scribe/', 'agent-memory/', 'forge-accounts/', 'forge-research/', 'FORGE_MEMORY.md', 'FORGE_MODEL_ROUTING.user.json', 'config/agents/agent-tool-policy.user.json'].every((f) => claimed85.includes(f)) && sp85.missingBlocking.length === 0);
  const p = makeProject(freshDir('t85-root'), 'proj', 0);
  const own = {};
  for (const f of hostile) { if (f === 'forge-research/notes.md') continue; own[f] = 'PROJECT-OWN ' + f; wfx(p, '.claude/' + f, own[f]); }
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b85', nowIso: NOW_WP2B, forceOverwrite: true });
  t('85b a real --force-overwrite sync succeeds and delivers the tool', r.ok === true && rfx(p, '.claude/forge-bin/tool.cjs') === 'TEMPLATE-TOOL');
  t('85b every project memory/overlay/state file is byte-identical after the sync', Object.entries(own).every(([f, body]) => rfx(p, '.claude/' + f) === body));
  t('85b a never-touch seed (forge-research/**) was NOT created', rfx(p, '.claude/forge-research/notes.md') === null);
  t('85b the receipt baselines none of them', Object.keys(r.receipt.knownHashes).every((k) => !sync.isNeverTouch(k)));
}

// shared fixture for 86/87: forge-bin tools + config ship-sync, FORGE_OWNER_PROFILE.json + skills learnings seed-only
const FX86_RULES = [
  SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync'),
  SHIP_RULE('.claude/config/**', 'ship-sync'),
  SHIP_RULE('.claude/config/**/*.user.json', 'per-project'),
  SHIP_RULE('.claude/skills/*/**', 'ship-sync'),
  SHIP_RULE('.claude/skills/**/learnings.md', 'seed-only'),
  SHIP_RULE('.claude/FORGE_OWNER_PROFILE.json', 'seed-only'),
];
function tpl86(name) {
  const tpl = freshDir(name);
  writeTplManifest(tpl, FX86_RULES);
  wfx(tpl, 'forge-bin/tool.cjs', 'TOOL-V2');
  wfx(tpl, 'FORGE_OWNER_PROFILE.json', '{"owner":"template default"}\n');
  wfx(tpl, 'skills/demo/SKILL.md', '# demo v2\n');
  wfx(tpl, 'skills/demo/learnings.md', '# template learnings\n');
  return tpl;
}

console.log('\n86) WP-2b SYNC-05: --unsafe refuses drift unless --force-overwrite, never touches seed-only, writes a receipt');
{
  const tpl = tpl86('t86-tpl');
  const p = makeProject(freshDir('t86-root'), 'proj', null);
  wfx(p, '.claude/forge-bin/tool.cjs', 'PROJECT-EDITED-NO-BASELINE');
  wfx(p, '.claude/FORGE_OWNER_PROFILE.json', '{"owner":"the real owner"}\n');
  wfx(p, '.claude/skills/demo/learnings.md', '# my own learnings\n');
  const a = quiet(() => sync.rawInstall(tpl, p, { batchId: 'b86a', nowIso: NOW_WP2B }));
  t('86a --unsafe alone REFUSES an unbaselined drifted file (ok:false, refusedDrift)', a.r.ok === false && a.r.refusedDrift === true);
  t('86a the drifted file is untouched and no backup folder was created', rfx(p, '.claude/forge-bin/tool.cjs') === 'PROJECT-EDITED-NO-BASELINE' && !fs.existsSync(path.join(p, '.claude', 'forge-backups')));
  t('86a the refusal names the way out (forge-overrides / adopt / --force-overwrite)', /--force-overwrite/.test(a.r.reason) && /adopt/.test(a.r.reason));
  const b = quiet(() => sync.rawInstall(tpl, p, { batchId: 'b86b', nowIso: NOW_WP2B, forceOverwrite: true }));
  t('86b --unsafe --force-overwrite proceeds and replaces the drifted ship-sync file (backed up first)', b.r.ok === true && rfx(p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && fs.readFileSync(path.join(b.r.backup.backupDir, 'forge-bin', 'tool.cjs'), 'utf8') === 'PROJECT-EDITED-NO-BASELINE');
  t('86b a drifted SEED-ONLY file survives --unsafe --force-overwrite byte-for-byte', rfx(p, '.claude/FORGE_OWNER_PROFILE.json') === '{"owner":"the real owner"}\n' && rfx(p, '.claude/skills/demo/learnings.md') === '# my own learnings\n');
  t('86b ...and is reported as kept, never as drift', b.r.plan.seedKept.some((s) => s.rel === 'FORGE_OWNER_PROFILE.json') && !b.r.plan.toChange.some((e) => e.rel === 'FORGE_OWNER_PROFILE.json'));
  const rc = sync.readReceipt(p);
  t('86c --unsafe now writes a RECEIPT (unsafe:true, validation tool none) with the shipped baseline', !!rc && rc.unsafe === true && rc.validation.tool === 'none' && rc.knownHashes['forge-bin/tool.cjs'] === sync.sha256(path.join(tpl, 'forge-bin', 'tool.cjs')));
  t('86c the receipt never baselines a seed-only file', !Object.prototype.hasOwnProperty.call(rc.knownHashes, 'FORGE_OWNER_PROFILE.json') && !Object.prototype.hasOwnProperty.call(rc.knownHashes, 'skills/demo/learnings.md'));
  const after = sync.preflight(tpl, p);
  t('86c so the NEXT safe sync sees no unknown drift on what --unsafe wrote', after.unknownDrift.length === 0 && after.conflicts.length === 0);
  t('86d an --unsafe receipt is never reused as a pre-sync doctor baseline', sync.decidePreBaseline(rc, rc.postSyncManifestHash, rc.workspace || null, Date.parse(NOW_WP2B)).reuse === false);
  const rb = sync.rollbackProject(p, 'b86b', {});
  t('86e the --unsafe sync rolls back with the standard command (restores the drifted bytes)', rb.ok === true && rfx(p, '.claude/forge-bin/tool.cjs') === 'PROJECT-EDITED-NO-BASELINE');
}

console.log('\n87) WP-2b seed-only class: create when absent, never overwrite (immune to --force-overwrite)');
{
  const tpl = tpl86('t87-tpl');
  t('87a listSeedFiles lists the seed-only files, listSystemFiles never does', (() => { const s = sync.listSeedFiles(tpl), y = sync.listSystemFiles(tpl); return s.includes('FORGE_OWNER_PROFILE.json') && s.includes('skills/demo/learnings.md') && !y.includes('FORGE_OWNER_PROFILE.json') && !y.includes('skills/demo/learnings.md') && y.includes('skills/demo/SKILL.md'); })());
  const fresh = makeProject(freshDir('t87-root-fresh'), 'proj', 0);
  const rf = sync.safeSyncProject(tpl, fresh, { batchId: 'b87a', nowIso: NOW_WP2B });
  t('87b a project WITHOUT the seed files gets them created from the template default', rf.ok === true && rfx(fresh, '.claude/FORGE_OWNER_PROFILE.json') === '{"owner":"template default"}\n' && rfx(fresh, '.claude/skills/demo/learnings.md') === '# template learnings\n');
  t('87b they are planned as seed creations (overrideClass seed, isNew)', rf.plan.toChange.filter((e) => e.overrideClass === 'seed').map((e) => e.rel).sort().join(',') === 'FORGE_OWNER_PROFILE.json,skills/demo/learnings.md');
  const p = makeProject(freshDir('t87-root'), 'proj', 0);
  wfx(p, '.claude/FORGE_OWNER_PROFILE.json', '{"owner":"edited by the owner"}\n');
  wfx(p, '.claude/skills/demo/learnings.md', '# lessons this project learned\n');
  // a STALE baseline from the pre-seed-only era (forge-sync used to ship FORGE_OWNER_PROFILE.json as a SYSTEM file)
  sync.writeReceipt(p, { knownHashes: { 'FORGE_OWNER_PROFILE.json': sync.sha256(path.join(tpl, 'FORGE_OWNER_PROFILE.json')) } });
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b87c', nowIso: NOW_WP2B, forceOverwrite: true });
  t('87c an owner-edited seed file survives a --force-overwrite sync byte-for-byte', r.ok === true && rfx(p, '.claude/FORGE_OWNER_PROFILE.json') === '{"owner":"edited by the owner"}\n' && rfx(p, '.claude/skills/demo/learnings.md') === '# lessons this project learned\n');
  t('87c a seed file is never drift or conflict (so no flag can force it)', !r.plan.toChange.some((e) => e.overrideClass === 'unknown_drift' || e.overrideClass === 'conflict'));
  t('87d the stale pre-seed-only baseline for the owner profile is dropped from the receipt', !Object.prototype.hasOwnProperty.call(sync.readReceipt(p).knownHashes, 'FORGE_OWNER_PROFILE.json'));
  const rb = sync.rollbackProject(fresh, 'b87a', {});
  t('87e rolling back the batch that CREATED the seeds removes them again (back to non-existence)', rb.ok === true && rfx(fresh, '.claude/FORGE_OWNER_PROFILE.json') === null);
}

console.log('\n88) WP-2b F3: a manifest entry missing from the template is LISTED, and install refuses (unless release_excluded)');
{
  const mk = (name, extraRules, files) => {
    const tpl = freshDir(name);
    writeTplManifest(tpl, [SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync')].concat(extraRules));
    wfx(tpl, 'forge-bin/tool.cjs', 'TOOL');
    for (const f of (files || [])) wfx(tpl, f, 'x');
    return tpl;
  };
  const tplA = mk('t88a-tpl', [SHIP_RULE('.claude/config/REQUIRED.json', 'ship-sync'), SHIP_RULE('.claude/skills/{alpha,beta}/**', 'ship-sync')], ['skills/alpha/SKILL.md']);
  const pA = makeProject(freshDir('t88a-root'), 'proj', 0);
  const pf = sync.preflight(tplA, pA);
  t('88a preflight LISTS the missing literal ship-sync file (no silent continue)', pf.missingInTemplate.some((m) => m.rel === 'config/REQUIRED.json' && m.kind === 'file'));
  t('88a ...and the missing literal folder of a glob entry (skills/beta/)', pf.missingInTemplate.some((m) => m.rel === 'skills/beta/' && m.kind === 'dir') && !pf.missingInTemplate.some((m) => m.rel === 'skills/alpha/'));
  t('88a both are blocking (the template carries its own manifest)', pf.missingBlocking.length === 2);
  const before = snapshotTree(pA);
  const r = sync.safeSyncProject(tplA, pA, { batchId: 'b88a', nowIso: NOW_WP2B });
  t('88b safeSyncProject REFUSES an incomplete template before writing anything', r.ok === false && r.refused === true && r.refusedMissingInTemplate === true && /INCOMPLETE/.test(r.reason) && /config\/REQUIRED\.json/.test(r.reason));
  t('88b nothing was written (byte-identical project, no backup)', JSON.stringify(snapshotTree(pA)) === JSON.stringify(before));
  const cli = runCLIWithTemplate(['install', pA, '--batch-id', 'b88cli'], tplA);
  t('88c CLI install exits NON-ZERO and names the missing file', cli.status === 1 && /config\/REQUIRED\.json/.test(cli.stderr + cli.stdout));
  const cliDry = runCLIWithTemplate(['install', pA, '--dry-run'], tplA);
  t('88c CLI install --dry-run exits non-zero too (WOULD REFUSE)', cliDry.status === 1 && /WOULD REFUSE/.test(cliDry.stderr + cliDry.stdout));
  const st = runCLIWithTemplate(['status', pA], tplA);
  t('88d status says TEMPLATE INCOMPLETE and exits 1 (never "up to date")', st.status === 1 && /TEMPLATE INCOMPLETE/.test(st.stdout) && /MISSING IN TEMPLATE/.test(st.stderr));
  const u = quiet(() => sync.rawInstall(tplA, pA, { batchId: 'b88u', nowIso: NOW_WP2B }));
  t('88e --unsafe refuses an incomplete template too', u.r.ok === false && u.r.refusedMissingInTemplate === true);
  // release_excluded entries may legitimately be absent from a public template (maand-sweep, gsap/humanizer)
  const tplB = mk('t88b-tpl', [SHIP_RULE('.claude/forge-bin/maand-sweep-prompt.txt', 'ship-sync', { channels: ['sync', 'template'], release_excluded: 'internal only' }), SHIP_RULE('.claude/skills/{gsap,humanizer}/**', 'ship-sync', { channels: ['sync', 'template'], release_excluded: 'no open licence' })]);
  const pB = makeProject(freshDir('t88b-root'), 'proj', 0);
  const rB = sync.safeSyncProject(tplB, pB, { batchId: 'b88b', nowIso: NOW_WP2B });
  t('88f release_excluded entries are listed as missing but do NOT block the install', rB.ok === true && rB.plan.missingInTemplate.length === 3 && rB.plan.missingBlocking.length === 0);
  t('88f the receipt records what the template lacked', sync.readReceipt(pB).missingInTemplate.includes('forge-bin/maand-sweep-prompt.txt'));
  // a LEGACY template (no manifest of its own): classified with forge-sync's own manifest, missing = advisory only
  const tplC = freshDir('t88c-tpl');
  wfx(tplC, 'forge-bin/tool.cjs', 'TOOL');
  const pC = makeProject(freshDir('t88c-root'), 'proj', 0);
  const rC = sync.safeSyncProject(tplC, pC, { batchId: 'b88c', nowIso: NOW_WP2B });
  t('88g a template without its own manifest uses forge-sync\'s, lists the gaps as advisory and still syncs', rC.ok === true && rC.plan.shipManifest.source === 'forge-sync' && rC.plan.missingInTemplate.length > 0 && rC.plan.missingBlocking.length === 0);
}

console.log('\n89) WP-2b SYNC-09: orphans — hash-gated report by default, opt-in --retire-orphans MOVES into the batch backup');
{
  const tpl = freshDir('t89-tpl');
  writeTplManifest(tpl, [SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync'), SHIP_RULE('.claude/FORGE_OWNER_PROFILE.json', 'seed-only')]);
  wfx(tpl, 'forge-bin/keep.cjs', 'KEEP-V2');
  wfx(tpl, 'FORGE_OWNER_PROFILE.json', '{}');
  const setup = (name) => {
    const p = makeProject(freshDir(name), 'proj', 0);
    const h = (rel, body) => sync.sha256(wfx(p, '.claude/' + rel, body));
    const known = { 'forge-bin/keep.cjs': h('forge-bin/keep.cjs', 'KEEP-V1'), 'forge-bin/old-a.cjs': h('forge-bin/old-a.cjs', 'OLD-A as shipped'), 'forge-bin/old-b.cjs': 'hash-of-what-forge-sync-shipped-before' };
    wfx(p, '.claude/forge-bin/old-b.cjs', 'OLD-B edited by the project');
    known['FORGE_MEMORY.md'] = h('FORGE_MEMORY.md', '# memory'); // a never-touch path that somehow sits in a receipt
    known['FORGE_OWNER_PROFILE.json'] = h('FORGE_OWNER_PROFILE.json', '{"mine":1}'); // a seed, not an orphan
    sync.writeReceipt(p, { knownHashes: known });
    return p;
  };
  const p = setup('t89-root');
  const rep = sync.findOrphans(p, sync.shipPlan(tpl));
  t('89a an unmodified file the template no longer ships is reported unmodified (safe to retire)', rep.unmodified.map((u) => u.rel).join(',') === 'forge-bin/old-a.cjs');
  t('89a a changed one is reported modified and will be kept', rep.modified.map((m) => m.rel).join(',') === 'forge-bin/old-b.cjs');
  t('89a never-touch and seed-only paths in the receipt are never orphans', ![].concat(rep.unmodified, rep.modified).some((x) => x.rel === 'FORGE_MEMORY.md' || x.rel === 'FORGE_OWNER_PROFILE.json'));
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b89a', nowIso: NOW_WP2B });
  t('89b by DEFAULT orphans are only reported — nothing is moved or deleted', r.ok === true && rfx(p, '.claude/forge-bin/old-a.cjs') === 'OLD-A as shipped' && rfx(p, '.claude/forge-bin/old-b.cjs') === 'OLD-B edited by the project' && r.orphans.unmodified.length === 1 && r.retiredOrphans === null);
  const p2 = setup('t89-root2');
  const r2 = sync.safeSyncProject(tpl, p2, { batchId: 'b89c', nowIso: NOW_WP2B, retireOrphans: true });
  const moved = path.join(p2, '.claude', 'forge-backups', 'b89c', sync.RETIRED_ORPHANS_SUBDIR, 'forge-bin', 'old-a.cjs');
  t('89c --retire-orphans MOVES the unmodified orphan into the batch backup (gone from the project, bytes intact there)', r2.ok === true && rfx(p2, '.claude/forge-bin/old-a.cjs') === null && fs.existsSync(moved) && fs.readFileSync(moved, 'utf8') === 'OLD-A as shipped');
  t('89c ...writes a ledger and never touches the modified orphan or the never-touch file', fs.existsSync(path.join(p2, '.claude', 'forge-backups', 'b89c', sync.RETIRED_ORPHANS_MANIFEST_NAME)) && rfx(p2, '.claude/forge-bin/old-b.cjs') === 'OLD-B edited by the project' && rfx(p2, '.claude/FORGE_MEMORY.md') === '# memory');
  const rb = sync.rollbackProject(p2, 'b89c', {});
  t('89d rollback restores the retired orphan byte-for-byte', rb.ok === true && rfx(p2, '.claude/forge-bin/old-a.cjs') === 'OLD-A as shipped' && rb.retiredOrphansRestore && rb.retiredOrphansRestore.restored.includes('forge-bin/old-a.cjs'));
  // a no-op sync (nothing else to change) with --retire-orphans leaves a ledger-only batch, which rollback also restores
  const p3 = setup('t89-root3');
  wfx(p3, '.claude/forge-bin/keep.cjs', 'KEEP-V2');
  wfx(p3, '.claude/FORGE_OWNER_PROFILE.json', '{}'); // seed present -> nothing to create
  const r3 = sync.safeSyncProject(tpl, p3, { batchId: 'b89e', nowIso: NOW_WP2B, retireOrphans: true });
  t('89e a no-op sync with --retire-orphans still moves the orphan', r3.noop === true && r3.ok === true && rfx(p3, '.claude/forge-bin/old-a.cjs') === null);
  const rb3 = sync.rollbackProject(p3, null, {});
  t('89e plain `rollback` finds that orphan-only batch and restores it', rb3.ok === true && rb3.batchId === 'b89e' && rb3.source === 'retired-orphans-ledger-only' && rfx(p3, '.claude/forge-bin/old-a.cjs') === 'OLD-A as shipped');
  const tampered = setup('t89-root4');
  sync.safeSyncProject(tpl, tampered, { batchId: 'b89f', nowIso: NOW_WP2B, retireOrphans: true });
  const ledgerF = path.join(tampered, '.claude', 'forge-backups', 'b89f', sync.RETIRED_ORPHANS_MANIFEST_NAME);
  const led = JSON.parse(fs.readFileSync(ledgerF, 'utf8'));
  led.files.push({ rel: 'FORGE_MEMORY.md', oldHash: 'x' }, { rel: '../outside.txt', oldHash: 'y' });
  fs.writeFileSync(ledgerF, JSON.stringify(led));
  const rr = sync.restoreRetiredOrphansLedger(tampered, 'b89f');
  t('89f a tampered orphan ledger naming a never-touch or traversal path is refused for those entries', rr.ok === false && rr.failed.some((f) => f.rel === 'FORGE_MEMORY.md') && rr.failed.some((f) => f.rel === '../outside.txt') && rr.restored.includes('forge-bin/old-a.cjs'));
  const st = runCLIWithTemplate(['status', setup('t89-root5')], tpl);
  t('89g status prints the orphan report', /no longer ships, unmodified/.test(st.stdout) && /changed here — kept/.test(st.stdout));
  t('89h --unsafe with --retire-orphans is a usage error (exit 2)', runCLIWithTemplate(['install', p, '--unsafe', '--retire-orphans'], tpl).status === 2);
}

console.log('\n90) WP-2b SYNC-13: a traversal-shaped batch id is refused on EVERY path that turns it into a folder');
{
  const tpl = freshDir('t90-tpl');
  wfx(tpl, 'forge-bin/tool.cjs', 'TOOL');
  const root = freshDir('t90-root');
  const p = makeProject(root, 'proj', 0);
  makeRealProjectMarker(p);
  wfx(p, '.claude/forge-bin/tool.cjs', 'OLD');
  sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) } });
  const evil = ['..', '../..', '../evil', '..\\evil', 'a/b', 'a\\b', 'C:\\x', '.', 'x'.repeat(101), ''];
  t('90a isSafeBatchId rejects every traversal/separator shape', evil.every((b) => !sync.isSafeBatchId(b)) && sync.isSafeBatchId('sync-1700000000000') && sync.isSafeBatchId('h2sync_20261006'));
  t('90b parseArgs turns an unsafe --batch-id into a usage error', !!sync.parseArgs(['proj', '--batch-id', '../evil']).argError && !!sync.parseArgs(['proj', '--batch', 'a/b']).argError && !sync.parseArgs(['proj', '--batch-id', 'ok-1']).argError);
  const outsideBefore = fs.readdirSync(root).sort().join('|');
  t('90c CLI install with a traversal batch id exits 2', runCLIWithTemplate(['install', p, '--batch-id', '../../evil'], tpl).status === 2);
  t('90d safeSyncProject refuses it', (() => { const r = sync.safeSyncProject(tpl, p, { batchId: '../evil', nowIso: NOW_WP2B }); return r.ok === false && r.refused === true && /unsafe batch id/.test(r.reason); })());
  t('90d ...and so does the dry-run', (() => { const r = sync.safeSyncProject(tpl, p, { batchId: '..', dryRun: true }); return r.ok === false && /unsafe batch id/.test(r.reason); })());
  t('90e rawInstall (--unsafe) refuses it', quiet(() => sync.rawInstall(tpl, p, { batchId: '../evil', nowIso: NOW_WP2B })).r.ok === false);
  t('90f runSyncAll refuses it before the canary is even created', (() => { const r = quiet(() => sync.runSyncAll(tpl, root, { projects: [p], batchId: '../evil', nowIso: NOW_WP2B })).r; return r.ok === false && r.refused === true && !fs.existsSync(sync.dedicatedCanaryDir(root)); })());
  t('90g rollbackProject refuses it', /unsafe batch id/.test(sync.rollbackProject(p, '../evil', {}).reason || ''));
  t('90h rollbackBatch refuses it', (() => { const r = sync.rollbackBatch(root, 'a/b', { projects: [p] }); return r.length === 1 && r[0].ok === false; })());
  t('90i CLI rollback-batch with a traversal batch id exits 2', runCLI(['rollback-batch', '../evil', root]).status === 2);
  t('90j takeBackup and loadTrustedManifest refuse it (clean result, no throw)', sync.takeBackup(p, '..', { toChange: [] }, 'v', NOW_WP2B, {}).ok === false && sync.loadTrustedManifest(p, '../x', null).ok === false);
  t('90k backupDirFor itself throws on an unsafe id (last line of defence)', (() => { try { sync.backupDirFor(p, '../x'); return false; } catch (e) { return /unsafe batch id/.test(e.message); } })());
  t('90l retireOrphans refuses it', !!sync.retireOrphans(p, { unmodified: [{ rel: 'forge-bin/x.cjs', hash: 'h' }] }, { batchId: '..' }).error);
  t('90m nothing was created where a traversal id points (beside the project, in it, or in .claude) and nothing was synced', fs.readdirSync(root).sort().join('|') === outsideBefore
    && !fs.existsSync(path.join(p, 'evil')) && !fs.existsSync(path.join(p, '.claude', 'evil')) && !fs.existsSync(path.join(p, '.claude', 'forge-backups')) && rfx(p, '.claude/forge-bin/tool.cjs') === 'OLD');
}

console.log('\n91) WP-2b SYNC-03: the project\'s own pre-split Scout verdicts move to FORGE_SCOUT_VETTING.user.json first');
{
  const V = (capability, verdict, extra) => Object.assign({ capability, verdict, reason: 'because ' + capability, source: null, ts: '2026-09-01T00:00:00.000Z' }, extra || {});
  const ledger = (entries) => JSON.stringify({ _doc: 'x', version: 1, entries }, null, 2) + '\n';
  const mk = (name) => {
    const tpl = freshDir(name + '-tpl');
    wfx(tpl, 'config/orchestration/FORGE_SCOUT_VETTING.json', ledger([V('template-skill', 'approve')]));
    const p = makeProject(freshDir(name + '-root'), 'proj', 0);
    wfx(p, '.claude/config/orchestration/FORGE_SCOUT_VETTING.json', ledger([V('template-skill', 'approve'), V('my-own-research', 'hard-pass')]));
    return { tpl, p, userF: path.join(p, '.claude', 'config', 'orchestration', 'FORGE_SCOUT_VETTING.user.json'), shipF: path.join(p, '.claude', 'config', 'orchestration', 'FORGE_SCOUT_VETTING.json') };
  };
  const a = mk('t91a');
  const r = quiet(() => sync.safeSyncProject(a.tpl, a.p, { batchId: 'b91a', nowIso: NOW_WP2B, forceOverwrite: true })).r;
  const user = JSON.parse(fs.readFileSync(a.userF, 'utf8'));
  t('91a the project\'s own verdict is moved into the user ledger (marked migrated_by) before the replace', r.ok === true && user.entries.length === 1 && user.entries[0].capability === 'my-own-research' && /forge-sync/.test(user.entries[0].migrated_by));
  t('91a the shipped ledger is then replaced by the template copy', JSON.parse(fs.readFileSync(a.shipF, 'utf8')).entries.length === 1);
  t('91a a template verdict is never copied into the user ledger', !user.entries.some((e) => e.capability === 'template-skill'));
  const again = sync.migrateScoutVerdicts(a.tpl, a.p, {});
  t('91b idempotent: nothing more to move afterwards (the copy now equals what forge-sync shipped)', again.length === 0 && again.pending === false && JSON.parse(fs.readFileSync(a.userF, 'utf8')).entries.length === 1);
  const d = mk('t91c');
  const dry = sync.migrateScoutVerdicts(d.tpl, d.p, { dryRun: true });
  t('91c dry-run reports the move but writes nothing', dry.length === 1 && dry.pending === false && !fs.existsSync(d.userF));
  const m = mk('t91d');
  fs.writeFileSync(m.userF, '{ not json');
  const shipBefore = fs.readFileSync(m.shipF, 'utf8');
  const rm = quiet(() => sync.safeSyncProject(m.tpl, m.p, { batchId: 'b91d', nowIso: NOW_WP2B, forceOverwrite: true }));
  t('91d a malformed user ledger -> pending: the shipped ledger is NOT replaced, even with --force-overwrite', fs.readFileSync(m.shipF, 'utf8') === shipBefore && fs.readFileSync(m.userF, 'utf8') === '{ not json' && rm.out.some((w) => /refusing to replace .*FORGE_SCOUT_VETTING\.json/.test(w) && /never delete it/.test(w)));
  const inv = mk('t91e');
  wfx(inv.p, '.claude/config/orchestration/FORGE_SCOUT_VETTING.json', ledger([V('template-skill', 'approve'), { capability: 'half-written', verdict: 'maybe' }]));
  const invR = quiet(() => sync.migrateScoutVerdicts(inv.tpl, inv.p, {})).r;
  t('91e an INVALID own entry cannot be moved -> pending (the file is kept so nothing is lost)', invR.pending === true && !fs.existsSync(inv.userF));
  const same = mk('t91f');
  fs.writeFileSync(same.shipF, ledger([V('template-skill', 'approve'), V('old-template-entry', 'hard-pass')]));
  sync.writeReceipt(same.p, { knownHashes: { 'config/orchestration/FORGE_SCOUT_VETTING.json': sync.sha256(same.shipF) } });
  t('91f a copy still equal to what forge-sync last shipped holds template verdicts only: nothing is moved', sync.migrateScoutVerdicts(same.tpl, same.p, {}).length === 0 && !fs.existsSync(same.userF));
}

console.log('\n92) WP-2b: the manifest-derived delivery list == the pre-WP-2b SYSTEM list, except the deliberate corrections');
{
  const REPO = path.resolve(__dirname, '..', '..');
  const PRE = '9eeaba0'; // the last commit whose forge-sync.cjs carried the hand-kept SYSTEM list
  const git = (args) => spawnSync('git', ['-C', REPO].concat(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const devTree = fs.existsSync(path.join(REPO, '.claude', 'config', 'forge-dev-tree.json'));
  const hasPre = devTree && git(['cat-file', '-e', PRE + '^{commit}']).status === 0;
  if (!hasPre) {
    console.log('  SKIP 92: needs the development tree with commit ' + PRE + ' (the last hand-kept SYSTEM list) — not available here; sections 85-91 still ran');
  } else {
    const CL = path.join(REPO, '.claude');
    const preSrc = git(['show', PRE + ':.claude/forge-bin/forge-sync.cjs']).stdout;
    const lit = preSrc.match(/\nconst SYSTEM = \[([\s\S]*?)\n\];/);
    const pins = lit ? [...lit[1].split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n').matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    const OLD_GLOB = [['forge-bin', ['.cjs', '.ps1', '.cmd', '.sh', '.md', '.bat']], ['forge-dashboard', ['.js', '.cjs', '.html', '.css', '.bat', '.md']], ['agents', ['.md']]];
    const OLD_PROTECT = new Set(['forge-dashboard/PORT', 'forge-dashboard/DASHBOARD_STATE.json', 'FORGE_CONFIG.json']);
    const old = new Set(pins);
    for (const [d, ext] of OLD_GLOB) for (const f of fs.readdirSync(path.join(CL, d))) { const rel = d + '/' + f; if (ext.includes(path.extname(f)) && !OLD_PROTECT.has(rel)) old.add(rel); }
    const oldOnDisk = new Set([...old].filter((rel) => fs.existsSync(path.join(CL, ...rel.split('/')))));
    const derived = new Set(sync.listSystemFiles(CL));
    const seeds = new Set(sync.listSeedFiles(CL));
    const existedAtPre = new Set(git(['ls-tree', '-r', '--name-only', PRE, '--', '.claude']).stdout.split(/\r?\n/).filter(Boolean).map((x) => x.replace(/^\.claude\//, '')));
    // compare only files that EXISTED at PRE — that is what "the old list delivered". A file created
    // later that the old glob would have caught ('s maintainer-only release tools) is a later, deliberate manifest
    // decision, checked separately in 92e: it may be withheld only by an explicit non-delivery rule.
    const removedAll = [...oldOnDisk].filter((rel) => !derived.has(rel)).sort();
    const removed = removedAll.filter((rel) => existedAtPre.has(rel));
    const withheldNew = removedAll.filter((rel) => !existedAtPre.has(rel));
    const addedExisting = [...derived].filter((rel) => !oldOnDisk.has(rel) && existedAtPre.has(rel)).sort();
    const KG02 = ['FORGE_OWNER_PROFILE.json', 'FORGE_PAPERCLIP_AGENTS.json', 'FORGE_PREF_CANDIDATES.json'];
    const KG01 = ['FORGE_SKILL_REGISTRY.md', 'config/orchestration/ACCEPTED_RISKS.md', 'config/orchestration/HOOKS_OPT_IN.md', 'config/orchestration/LEAN_DISPATCH.md', 'config/orchestration/forge-canon.json',
      'skills/ADAPTED-PATTERNS.md', 'skills/CUSTOM_SKILL_TEMPLATE.md', 'skills/forge-code-review/evals.json', 'skills/forge-intake/evals.json', 'skills/forge-router/PROMPT_TEMPLATE.md', 'skills/forge-router/evals.json',
      'skills/forge-skill-testing/evals.json', 'skills/forge-skill-testing/references/activation-test-template.md', 'skills/forge-snapshot/evals.json', 'skills/forge-verify/evals.json'].sort();
    t('92a the pre-WP-2b SYSTEM literal was found at ' + PRE + ' (' + pins.length + ' pins)', pins.length > 200);
    t('92b REMOVED from the sync list == exactly the 3 owner-state files (KG-02), now seed-only' + (removed.join(',') !== KG02.join(',') ? ' — got: ' + removed.join(', ') : ''), removed.join(',') === KG02.join(',') && KG02.every((f) => seeds.has(f)));
    t('92c ADDED (files that already existed at ' + PRE + ') == exactly the 15 referenced-but-undelivered files (KG-01)' + (addedExisting.join(',') !== KG01.join(',') ? ' — got: ' + addedExisting.join(', ') : ''), addedExisting.join(',') === KG01.join(','));
    t('92d no other file the old list delivered was dropped (old-at-' + PRE + ' ⊆ derived ∪ seeds)', [...oldOnDisk].filter((rel) => existedAtPre.has(rel)).every((rel) => derived.has(rel) || seeds.has(rel)));
    const sc92 = require('./forge-shipcheck.cjs');
    const rules92 = sc92.loadManifest(sync.OWN_SHIP_MANIFEST).rules;
    const notWithheldByRule = withheldNew.filter((rel) => { const r = sc92.classify(rules92, '.claude/' + rel); return !r || r.class === 'ship-sync' || r.class === 'seed-only'; });
    t('92e files created after ' + PRE + ' that the old glob would have shipped are withheld only by an explicit non-delivery manifest rule' + (withheldNew.length ? ' (' + withheldNew.join(', ') + ')' : ' (none)') + (notWithheldByRule.length ? ' — NOT by a rule: ' + notWithheldByRule.join(', ') : ''), notWithheldByRule.length === 0);
  }
}

console.log('\n93) WP-2b: which manifest decides, and fail-closed when none can be read');
{
  const tpl = freshDir('t93-tpl');
  wfx(tpl, 'forge-bin/tool.cjs', 'TOOL');
  wfx(tpl, 'config/thing.json', '{}');
  writeTplManifest(tpl, [SHIP_RULE('.claude/config/**', 'ship-sync')]);
  const sp = sync.shipPlan(tpl);
  t('93a the template\'s OWN manifest wins (it ships config/** but not the forge-bin tool)', sp.manifest.source === 'template' && sp.system.includes('config/thing.json') && !sp.system.includes('forge-bin/tool.cjs'));
  const legacy = freshDir('t93-legacy');
  wfx(legacy, 'forge-bin/tool.cjs', 'TOOL');
  t('93b without one, forge-sync\'s own manifest classifies the template', sync.shipPlan(legacy).manifest.source === 'forge-sync' && sync.listSystemFiles(legacy).includes('forge-bin/tool.cjs'));
  const bad = freshDir('t93-bad');
  wfx(bad, 'forge-bin/tool.cjs', 'TOOL');
  writeTplManifest(bad, [{ pattern: '.claude/**', class: 'ship-sync', channels: ['sync', 'release'], reason: 'catch-all' }]);
  t('93c an INVALID template manifest makes listSystemFiles THROW (never a guessed list)', (() => { try { sync.listSystemFiles(bad); return false; } catch (e) { return /invalid/.test(e.message) && /catch-all/.test(e.message); } })());
  const p = makeProject(freshDir('t93-root'), 'proj', 0);
  const before = snapshotTree(p);
  const r = sync.safeSyncProject(bad, p, { batchId: 'b93', nowIso: NOW_WP2B });
  t('93d safeSyncProject refuses cleanly on it and writes nothing', r.ok === false && r.refused === true && /invalid/.test(r.reason) && JSON.stringify(snapshotTree(p)) === JSON.stringify(before));
  t('93e status exits 1 on it (never "up to date")', runCLIWithTemplate(['status', p], bad).status === 1);
  t('93f a template folder that does not exist throws', (() => { try { sync.listSystemFiles(path.join(bad, 'nope')); return false; } catch (e) { return /does not exist/.test(e.message); } })());
  const tl = freshDir('t93-link');
  wfx(tl, 'forge-bin/real.cjs', 'R');
  let linked = false;
  try { fs.symlinkSync(path.join(tl, 'forge-bin', 'real.cjs'), path.join(tl, 'forge-bin', 'link.cjs'), 'file'); linked = true; }
  catch (e) { console.log('  SKIP 93g: cannot create a file symlink here (' + e.code + ') — nothing to prove'); }
  if (linked) t('93g a symlink inside the template is never shipped', !sync.listSystemFiles(tl).includes('forge-bin/link.cjs') && sync.listSystemFiles(tl).includes('forge-bin/real.cjs'));
}

// =====================================================================================================================
// part 1: quiesce-check, protect-manifest, settings ledger,
// install --dry-run --json, provenance + change report, coupled delivery. Every fixture is an os.tmpdir() folder; the
// process list and ~/.claude/projects are fakes (see the env seams at the top of this file).
// =====================================================================================================================
const NOW_WP2C = '2026-10-10T12:00:00.000Z';
const SHIP_MANIFEST_REL_T = sync.SHIP_MANIFEST_REL; // config/orchestration/FORGE_SHIP_MANIFEST.json
const NOW_WP2C_MS = Date.parse(NOW_WP2C);
const TPL_SETTINGS_WP2C = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 }] }], PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-toolhook.cjs"', timeout: 10 }] }] }, permissions: { deny: ['Read(./.env)', 'Read(./.env.*)'] } };
// owner bytes a parse+reserialize could never reproduce: a BOM, CRLF line endings, 4-space indent, no final newline
const OWNER_SETTINGS_BYTES = Buffer.from('\uFEFF{\r\n    "ownerKey": "keep me",\r\n    "permissions": { "allow": ["Bash(ls)"] }\r\n}', 'utf8');
const hashBuf = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
/** tplHomeWp2c — a template whose .claude sits in its OWN home folder, so gitignore.snippet / CLAUDE.md / a
 *  template-provenance.json can live next to it without leaking into os.tmpdir() for every other fixture. */
function tplHomeWp2c(name, opts) {
  opts = opts || {};
  const home = freshDir(name);
  const tpl = path.join(home, '.claude');
  writeTplManifest(tpl, FX86_RULES.concat(opts.extraRules || []));
  wfx(tpl, 'forge-bin/tool.cjs', 'TOOL-V2');
  wfx(tpl, 'FORGE_OWNER_PROFILE.json', '{"owner":"template default"}\n');
  wfx(tpl, 'skills/demo/SKILL.md', '# demo v2\n');
  wfx(tpl, 'skills/demo/learnings.md', '# template learnings\n');
  if (opts.settings !== false) wfx(tpl, 'settings.json', JSON.stringify(TPL_SETTINGS_WP2C, null, 2) + '\n');
  if (opts.snippet) wfx(home, 'gitignore.snippet', opts.snippet);
  if (opts.claudeStub) wfx(home, 'CLAUDE.md', '# stub\n');
  return { home, tpl };
}
/** projWp2c — a project already on TOOL-V1 with a matching receipt baseline (so tool.cjs is a plain update). */
function projWp2c(name, opts) {
  opts = opts || {};
  const p = makeProject(freshDir(name), 'proj', opts.doctorExit === undefined ? 0 : opts.doctorExit);
  const v1 = sync.sha256(wfx(p, '.claude/forge-bin/tool.cjs', 'TOOL-V1'));
  sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': v1 } });
  wfx(p, '.claude/agent-memory/head-chef/MEMORY.md', '# lessons the project learned\n');
  wfx(p, '.claude/FORGE_MEMORY.md', '# project memory\n');
  return p;
}
const plantingDoctorJs = (file) => 'if (process.argv.indexOf("--json") !== -1) { var __f = require("fs"); __f.mkdirSync(require("path").dirname(' + JSON.stringify(file) + '), { recursive: true }); __f.appendFileSync(' + JSON.stringify(file) + ', "planted by a doctor suite\\n"); }';
const cliEnv = (extra) => ({ env: Object.assign({}, process.env, extra || {}) });

console.log('\n94) WP-2c SYNC-02: quiesce-check — idle only when transcripts, run events, the lock and processes are all quiet');
{
  const p = makeProject(freshDir('t94-root'), 'proj', null);
  const fakeRoot = freshDir('t94-claude-projects');
  const quietOpts = (extra) => Object.assign({ nowMs: NOW_WP2C_MS, projectsRoot: fakeRoot, listProcesses: () => [], selfPid: 424242, parentPid: 424241 }, extra || {});
  const q0 = sync.quiesceCheck(p, quietOpts());
  t('94a a quiet project is IDLE (every check ok, default window ' + sync.QUIESCE_DEFAULT_IDLE_MIN + ' min)', q0.idle === true && q0.unknown === false && q0.idleMin === 10 && Object.values(q0.checks).every((c) => c.state === 'ok'));
  // (b) a fresh events.jsonl -> busy; the same file 11 minutes later (injected clock) -> idle again
  const ev = wfx(p, '.claude/forge-runs/live-run/events.jsonl', '{"event_type":"run_started"}\n');
  fs.utimesSync(ev, new Date(NOW_WP2C_MS - 2 * 60000), new Date(NOW_WP2C_MS - 2 * 60000));
  const q1 = sync.quiesceCheck(p, quietOpts());
  t('94b quiesce is RED while a run\'s events.jsonl was written within the window', q1.idle === false && q1.checks.events.state === 'busy' && /live-run/.test(q1.checks.events.detail));
  t('94b ...and the reason names it', q1.reasons.some((r) => /^events BUSY/.test(r) && /live-run/.test(r)));
  t('94c the same file is old enough once the injected clock moves 11 minutes on', sync.quiesceCheck(p, quietOpts({ nowMs: NOW_WP2C_MS + 9 * 60000 })).checks.events.state === 'ok');
  t('94c --idle-min widens the window (30 min -> busy again)', sync.quiesceCheck(p, quietOpts({ nowMs: NOW_WP2C_MS + 9 * 60000, idleMin: 30 })).checks.events.state === 'busy');
  fs.rmSync(path.join(p, '.claude', 'forge-runs'), { recursive: true, force: true });
  // (d) transcripts: the slug folder (drive-letter case varies), a SUBFOLDER session (<slug>--claude), but not a sibling
  const slug = sync.claudeProjectSlug(p);
  t('94d the slug is the path with every non-alphanumeric character replaced by "-"', slug === path.resolve(p).replace(/[^A-Za-z0-9]/g, '-') && !/[^A-Za-z0-9-]/.test(slug));
  const sib = wfx(fakeRoot, slug + 'X/s.jsonl', '{}'); // a sibling sharing the prefix WITHOUT the dash: never matched
  t('94d a sibling folder that only shares the prefix is NOT this project', sync.transcriptFoldersFor(p, fakeRoot).dirs.length === 0 && sync.quiesceCheck(p, quietOpts()).checks.transcripts.state === 'ok');
  fs.rmSync(path.dirname(sib), { recursive: true, force: true });
  const flipCase = slug.charAt(0) === slug.charAt(0).toLowerCase() ? slug.charAt(0).toUpperCase() + slug.slice(1) : slug.charAt(0).toLowerCase() + slug.slice(1);
  const tr = wfx(fakeRoot, flipCase + '/' + 'session-1.jsonl', '{}\n');
  fs.utimesSync(tr, new Date(NOW_WP2C_MS - 60000), new Date(NOW_WP2C_MS - 60000));
  const q2 = sync.quiesceCheck(p, quietOpts());
  t('94e a transcript modified within the window makes it BUSY (matched case-insensitively)', q2.idle === false && q2.checks.transcripts.state === 'busy');
  fs.utimesSync(tr, new Date(NOW_WP2C_MS - 3600000), new Date(NOW_WP2C_MS - 3600000));
  const sub = wfx(fakeRoot, slug + '--claude/abc/subagents/agent-1.jsonl', '{}\n');
  fs.utimesSync(sub, new Date(NOW_WP2C_MS - 30000), new Date(NOW_WP2C_MS - 30000));
  t('94e a session started in a SUBFOLDER of the project (<slug>--claude, nested subagent file) counts too', sync.quiesceCheck(p, quietOpts()).checks.transcripts.state === 'busy');
  fs.utimesSync(sub, new Date(NOW_WP2C_MS - 3600000), new Date(NOW_WP2C_MS - 3600000));
  t('94e once every transcript is older than the window, transcripts are ok', sync.quiesceCheck(p, quietOpts()).checks.transcripts.state === 'ok');
  // (f) the lock
  fs.writeFileSync(sync.lockPathFor(sync.claudeDirOf(p)), JSON.stringify({ pid: 999999, ts: NOW_WP2C }));
  const q3 = sync.quiesceCheck(p, quietOpts());
  t('94f a .forge-sync.lock makes it BUSY ("another forge-sync run is in progress")', q3.idle === false && q3.checks.lock.state === 'busy' && /in progress/.test(q3.checks.lock.detail));
  fs.rmSync(sync.lockPathFor(sync.claudeDirOf(p)), { force: true });
  // (g) processes: structured list, path match with a boundary, self + ancestors excluded, never the full command line
  const abs = path.resolve(p);
  const list = [
    { pid: 424240, ppid: 0, cmd: 'C:\\Windows\\explorer.exe' },
    { pid: 424241, ppid: 424240, cmd: 'bash -c "node forge-sync.cjs install ' + abs + '"' }, // the parent: excluded
    { pid: 424242, ppid: 424241, cmd: 'node forge-sync.cjs install "' + abs + '"' }, // this process: excluded
    { pid: 5001, ppid: 1, cmd: 'node "' + abs + '2\\tool.cjs" --token SECRET-SHOULD-NOT-BE-COPIED' }, // a sibling folder: not a match
    { pid: 5002, ppid: 1, cmd: null }, // no readable command line
  ];
  const q4 = sync.quiesceCheck(p, quietOpts({ listProcesses: () => list }));
  t('94g this process, its ancestors and a sibling folder do not count; a missing command line is counted, not inspected', q4.checks.processes.state === 'ok' && /1 without a readable command line/.test(q4.checks.processes.detail));
  const live = list.concat([{ pid: 6001, ppid: 1, cmd: '"C:\\Program Files\\nodejs\\node.exe" "' + abs + '\\.claude\\forge-bin\\forge-gate-hook.cjs" --token SECRET-SHOULD-NOT-BE-COPIED' }]);
  const q5 = sync.quiesceCheck(p, quietOpts({ listProcesses: () => live }));
  t('94g a live process naming the project makes it BUSY, recorded by pid and executable only', q5.idle === false && q5.checks.processes.state === 'busy' && q5.checks.processes.hits[0].pid === 6001 && q5.checks.processes.hits[0].exe === 'node.exe');
  t('94g the command line itself (which may carry secrets) is never copied into the result', !JSON.stringify(q5).includes('SECRET-SHOULD-NOT-BE-COPIED'));
  if (process.platform === 'win32') {
    const msys = '/' + abs.charAt(0).toLowerCase() + abs.slice(2).replace(/\\/g, '/');
    t('94g the Git Bash spelling (/c/users/...) of the path is recognised too', sync.quiesceCheck(p, quietOpts({ listProcesses: () => [{ pid: 7001, ppid: 1, cmd: 'bash -c "cd ' + msys + ' && ls"' }] })).checks.processes.state === 'busy');
  }
  const q6 = sync.quiesceCheck(p, quietOpts({ listProcesses: () => { throw new Error('CIM unavailable'); } }));
  t('94h a process listing that cannot be taken is UNKNOWN, and unknown is never idle', q6.idle === false && q6.unknown === true && q6.checks.processes.state === 'unknown' && /NOT idle/.test(q6.checks.processes.detail));
  // (i) CLI: quiesce-check exit codes through the test seams (never the real machine's processes or sessions)
  const fakeCliRoot = freshDir('t94-cli-projects');
  const okCli = runCLI(['quiesce-check', p, '--json'], cliEnv({ FORGE_SYNC_TEST_PROJECTS_ROOT: fakeCliRoot }));
  let okJson = null; try { okJson = JSON.parse(okCli.stdout); } catch { /* asserted below */ }
  t('94i CLI quiesce-check exits 0 on an idle project and prints parseable JSON', okCli.status === 0 && !!okJson && okJson.idle === true && okJson.schema === 'forge-sync-quiesce/v1');
  t('94i ...and it looked in the FAKE ~/.claude/projects, not the real one', !!okJson && okJson.checks.transcripts.detail.includes(fakeCliRoot));
  const busyCli = runCLI(['quiesce-check', p], cliEnv({ FORGE_SYNC_TEST_PROJECTS_ROOT: fakeCliRoot, FORGE_SYNC_TEST_PROCESS_LIST: JSON.stringify([{ pid: 6001, ppid: 1, cmd: 'node ' + abs + '\\x.cjs' }]) }));
  t('94i CLI quiesce-check exits 1 when a process names the project', busyCli.status === 1 && /BUSY/.test(busyCli.stdout));
  t('94i quiesce-check without a project is a usage error (exit 2)', runCLI(['quiesce-check']).status === 2);
  // (j) install refuses unless idle; --quiesce-override is a recorded exception
  const { tpl } = tplHomeWp2c('t94-tpl');
  const pI = projWp2c('t94-inst');
  wfx(pI, '.claude/forge-runs/live/events.jsonl', '{"event_type":"agent_started"}\n'); // written "now" -> busy
  const before = snapshotTree(pI);
  const refused = runCLIWithTemplate(['install', pI, '--batch-id', 'b94j'], tpl);
  t('94j CLI install REFUSES (exit 1) while a run event log is fresh, naming the reason', refused.status === 1 && /not proven idle/.test(refused.stderr) && /events BUSY/.test(refused.stderr));
  t('94j ...and wrote nothing (byte-identical project, no lock, no backup)', JSON.stringify(snapshotTree(pI)) === JSON.stringify(before));
  t('94j --quiesce-override with a too-short reason is a usage error (exit 2)', runCLIWithTemplate(['install', pI, '--quiesce-override', 'x'], tpl).status === 2);
  t('94j --quiesce-override on a dry-run is a usage error (exit 2)', runCLIWithTemplate(['install', pI, '--dry-run', '--quiesce-override', 'not needed'], tpl).status === 2);
  const over = runCLIWithTemplate(['install', pI, '--batch-id', 'b94o', '--quiesce-override', 'owner approved: test fixture'], tpl);
  const rcO = sync.readReceipt(pI);
  t('94k with --quiesce-override the install proceeds (exit 0) and warns', over.status === 0 && /NOT proven idle/.test(over.stderr));
  t('94k the override and the failed check are RECORDED in the receipt', !!rcO && rcO.quiesce && rcO.quiesce.override === 'owner approved: test fixture' && rcO.quiesce.idle === false && rcO.quiesce.reasons.some((r) => /events BUSY/.test(r)));
  t('94k ...and in the change report', /Quiesce override recorded:\*\* owner approved: test fixture/.test(rfx(pI, '.claude/forge-sync-report-b94o.md') || ''));
  // (l) library: requireQuiesce without an idle result refuses before ANY write
  const pL = projWp2c('t94-lib');
  const beforeL = snapshotTree(pL);
  const rL = sync.safeSyncProject(tpl, pL, { batchId: 'b94l', nowIso: NOW_WP2C, requireQuiesce: true, quiesce: q1 });
  t('94l safeSyncProject with requireQuiesce + a busy result refuses (refusedQuiesce) and writes nothing', rL.ok === false && rL.refusedQuiesce === true && JSON.stringify(snapshotTree(pL)) === JSON.stringify(beforeL));
  const rL2 = sync.safeSyncProject(tpl, pL, { batchId: 'b94m', nowIso: NOW_WP2C, requireQuiesce: true, quiesce: q0 });
  t('94l ...and proceeds with an idle result (receipt records idle:true, no override)', rL2.ok === true && !!rL2.receipt && rL2.receipt.quiesce.idle === true && rL2.receipt.quiesce.override === null);
}

console.log('\n95) WP-2c SYNC-11: protect-manifest — everything not shipped is hashed; install re-checks it and rolls back on a change');
{
  const { tpl } = tplHomeWp2c('t95-tpl');
  const p = projWp2c('t95-root');
  wfx(p, '.claude/forge-runs/run-1/events.jsonl', '{}\n');
  wfx(p, '.claude/skills/my-own/SKILL.md', '# a skill this project wrote itself\n');
  wfx(p, '.claude/node_modules/dep/index.js', 'module.exports = 1;\n');
  wfx(p, '.claude/forge-backups/old-batch/manifest.json', '{}');
  wfx(p, '.claude/config/secrets/api.key', 'KEY-MATERIAL');
  wfx(p, '.env', 'SECRET=never-read\n');
  wfx(p, 'CLAUDE.md', '# project brain\n');
  wfx(p, '.claude/FORGE_OWNER_PROFILE.json', '{"owner":"the real owner"}\n'); // an existing seed-only file
  const m = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C });
  const E = m.entries;
  t('95a a shipped file (in the template) is NOT protected — the sync owns it', E['.claude/forge-bin/tool.cjs'] === undefined && m.shippedRels.includes('forge-bin/tool.cjs'));
  t('95a agent-memory, FORGE_MEMORY.md and forge-runs are hashed', E['.claude/agent-memory/head-chef/MEMORY.md'].kind === 'file' && /^[0-9a-f]{64}$/.test(E['.claude/agent-memory/head-chef/MEMORY.md'].hash) && E['.claude/FORGE_MEMORY.md'].kind === 'file' && E['.claude/forge-runs/run-1/events.jsonl'].kind === 'file' && E['.claude/forge-runs/run-1'].kind === 'dir');
  t('95a the project\'s own skill under a shipped glob is protected (the template does not have it)', E['.claude/skills/my-own/SKILL.md'].kind === 'file');
  t('95a an existing seed-only file is protected (hashed — the sync may only ever create it, never change it)', E['.claude/FORGE_OWNER_PROFILE.json'] && E['.claude/FORGE_OWNER_PROFILE.json'].kind === 'file' && !m.shippedRels.includes('FORGE_OWNER_PROFILE.json'));
  t('95a .env and key material: size + mtime only — no content hash is ever recorded', E['.env'].kind === 'meta' && E['.env'].hash === undefined && E['.claude/config/secrets/api.key'].kind === 'meta' && E['.claude/config/secrets/api.key'].hash === undefined);
  t('95a root CLAUDE.md is hashed; a missing AGENTS.md / .gitignore is recorded as absent (a creation is visible)', E['CLAUDE.md'].kind === 'file' && E['AGENTS.md'].kind === 'absent' && E['.gitignore'].kind === 'absent');
  t('95a node_modules is recorded but not descended; forge-backups is never walked', E['.claude/node_modules'].kind === 'skipped-dir' && !Object.keys(E).some((k) => k.startsWith('.claude/node_modules/') || k.startsWith('.claude/forge-backups')));
  wfx(p, '.claude/config/forge-overrides.json', JSON.stringify({ overrides: ['forge-bin/tool.cjs'] }));
  const mO = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C });
  t('95a a shipped file declared in forge-overrides.json IS protected (a "protected override")', mO.entries['.claude/forge-bin/tool.cjs'] && mO.entries['.claude/forge-bin/tool.cjs'].kind === 'file' && !mO.shippedRels.includes('forge-bin/tool.cjs'));
  fs.rmSync(path.join(p, '.claude', 'config', 'forge-overrides.json'));
  // (b) the diff: bookkeeping is allowed, anything else is a violation
  t('95b nothing changed -> ok', sync.verifyProtect(p, m, null).ok === true);
  wfx(p, '.claude/forge-sync-receipt.json', '{"changed":true}');
  wfx(p, '.claude/FORGE_VERSION.json', '{"forge_version":"x"}');
  wfx(p, '.claude/settings.json', '{}');
  wfx(p, '.claude/settings.json.forge-bak-20261010-120000-abcd', '{}');
  wfx(p, '.claude/forge-sync-report-b1.md', '# report');
  wfx(p, '.claude/forge-backups/b1/manifest.json', '{}');
  wfx(p, '.claude/forge-bin/tool.cjs', 'SHIPPED FILE CHANGED (the sync owns it)');
  const vb = sync.verifyProtect(p, m, null);
  t('95b receipt, version, settings.json, a NEW .forge-bak, a NEW report, backups and shipped files are allowed', vb.ok === true && vb.allowed.some((a) => /forge-bak/.test(a.key)) && vb.allowed.some((a) => /forge-sync-report-b1/.test(a.key)));
  const mid = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C }); // now with the add-only files present
  fs.appendFileSync(path.join(p, '.claude', 'agent-memory', 'head-chef', 'MEMORY.md'), 'a planted line\n');
  wfx(p, '.claude/forge-runs/event-wiring-test-123/events.jsonl', '{}\n');
  fs.rmSync(path.join(p, '.claude', 'FORGE_MEMORY.md'));
  fs.appendFileSync(path.join(p, '.env'), 'MORE=1\n');
  wfx(p, '.claude/forge-sync-report-b1.md', '# an EXISTING report rewritten');
  const vc = sync.verifyProtect(p, mid, null);
  const lines = sync.protectViolationLines(vc);
  t('95c a changed agent-memory file is a violation', vc.ok === false && lines.includes('CHANGED .claude/agent-memory/head-chef/MEMORY.md'));
  t('95c a new forge-runs folder (a leaked test run) is a violation, folder and file', lines.includes('ADDED   .claude/forge-runs/event-wiring-test-123') && lines.includes('ADDED   .claude/forge-runs/event-wiring-test-123/events.jsonl'));
  t('95c a vanished memory file is a violation', lines.includes('REMOVED .claude/FORGE_MEMORY.md'));
  t('95c a changed .env is caught by size/mtime (content still never read)', lines.includes('CHANGED .env'));
  t('95c an add-only bookkeeping file that ALREADY existed and changed is a violation', lines.includes('CHANGED .claude/forge-sync-report-b1.md'));
  t('95c verifying a manifest against another project refuses', (() => { try { sync.verifyProtect(projWp2c('t95-other'), mid, null); return false; } catch (e) { return /taken for/.test(e.message); } })());
  // measured on a real doctor run: suites that create and delete <project>/.claude/forge-runs/<id> leave the
  // EMPTY parent behind in a project that had no forge-runs/. No data -> listed, not a violation; content still is.
  const pE = projWp2c('t95-empty');
  const mE = sync.buildProtectManifest(tpl, pE, { nowIso: NOW_WP2C });
  fs.mkdirSync(path.join(pE, '.claude', 'forge-runs', 'leaked-but-empty'), { recursive: true });
  const vE = sync.verifyProtect(pE, mE, null);
  t('95c2 an EMPTY new folder (even nested) is allowed but listed, never silent', vE.ok === true && vE.allowed.some((a) => a.key === '.claude/forge-runs' && /EMPTY folder/.test(a.why)) && vE.allowed.some((a) => a.key === '.claude/forge-runs/leaked-but-empty'));
  wfx(pE, '.claude/forge-runs/leaked-but-empty/events.jsonl', '{}\n');
  const vE2 = sync.verifyProtect(pE, mE, null);
  t('95c2 ...the moment it holds a file, the folder AND the file are violations', vE2.ok === false && sync.protectViolationLines(vE2).includes('ADDED   .claude/forge-runs/leaked-but-empty') && sync.protectViolationLines(vE2).includes('ADDED   .claude/forge-runs/leaked-but-empty/events.jsonl'));
}

console.log('\n95d) WP-2c: a doctor suite that writes into agent-memory during install -> automatic rollback, non-zero exit, path named');
{
  const { tpl } = tplHomeWp2c('t95d-tpl');
  const p = projWp2c('t95d-root', { doctorExit: null });
  const mem = path.join(p, '.claude', 'agent-memory', 'head-chef', 'MEMORY.md');
  writeDoctorStub(p, 0, plantingDoctorJs(mem));
  fs.writeFileSync(path.join(p, '.claude', 'settings.json'), OWNER_SETTINGS_BYTES);
  const priorReceipt = fs.readFileSync(sync.receiptPath(p));
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b95d', nowIso: NOW_WP2C });
  t('95d the install fails with protectViolation (ok:false)', r.ok === false && r.protectViolation === true);
  t('95d the offending path is named', sync.protectViolationLines(r.protect).includes('CHANGED .claude/agent-memory/head-chef/MEMORY.md') && /agent-memory\/head-chef\/MEMORY\.md/.test(r.reason));
  t('95d the whole batch was rolled back automatically: the shipped file is back on V1', r.rolledBack === true && rfx(p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  t('95d ...the seed files this batch created are gone again', rfx(p, '.claude/FORGE_OWNER_PROFILE.json') === null && rfx(p, '.claude/skills/demo/learnings.md') === null);
  t('95d ...the receipt is restored byte-for-byte and no version stamp is left', Buffer.compare(fs.readFileSync(sync.receiptPath(p)), priorReceipt) === 0 && !fs.existsSync(sync.versionFilePath(p)));
  t('95d ...and settings.json is restored BYTE-FOR-BYTE (BOM, CRLF and all)', Buffer.compare(fs.readFileSync(path.join(p, '.claude', 'settings.json')), OWNER_SETTINGS_BYTES) === 0 && /restored byte-for-byte/.test(r.rollback.settingsAction || ''));
  t('95d honest: the rollback cannot undo the protected change itself — the planted line is still there, and the result says so', /planted by a doctor suite/.test(fs.readFileSync(mem, 'utf8')) && /cannot undo the protected change itself/.test(r.reason));
  const rep = rfx(p, '.claude/forge-sync-report-b95d.md') || '';
  t('95d a change report is written that says ROLLED BACK and names the path', /ROLLED BACK — protected files changed/.test(rep) && /CHANGED .claude\/agent-memory\/head-chef\/MEMORY\.md/.test(rep));
  // the CLI: exit 1 and the path on stderr
  const p2 = projWp2c('t95d-cli', { doctorExit: null });
  writeDoctorStub(p2, 0, plantingDoctorJs(path.join(p2, '.claude', 'agent-memory', 'head-chef', 'MEMORY.md')));
  const cli = runCLIWithTemplate(['install', p2, '--batch-id', 'b95dcli'], tpl);
  t('95d CLI install exits 1, says ROLLED BACK and names the offending path', cli.status === 1 && /ROLLED BACK/.test(cli.stderr) && /agent-memory\/head-chef\/MEMORY\.md/.test(cli.stderr) && rfx(p2, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  // the --unsafe path has the same net
  const p3 = projWp2c('t95d-unsafe', { doctorExit: null });
  const u = quiet(() => sync.rawInstall(tpl, p3, { batchId: 'b95du', nowIso: NOW_WP2C }));
  t('95d --unsafe on a quiet project still succeeds and re-checks protection', u.r.ok === true && u.r.protect && u.r.protect.ok === true);
  // a clean install records the verdict + report path in the receipt
  const p4 = projWp2c('t95d-clean');
  const r4 = sync.safeSyncProject(tpl, p4, { batchId: 'b95dok', nowIso: NOW_WP2C });
  t('95e a clean install passes the re-check and records it (receipt.protect ok, the seeds it created listed as allowed)', r4.ok === true && r4.receipt.protect.ok === true && r4.protect.allowed.some((a) => a.key === '.claude/FORGE_OWNER_PROFILE.json' && a.change === 'added'));
}

console.log('\n95f) WP-2c: CLI protect-manifest + verify-protect (standalone, with and without the batch\'s own records)');
{
  const { tpl } = tplHomeWp2c('t95f-tpl', { snippet: '.claude/forge-runs/*/*\n!.claude/forge-runs/*/run.json\n' });
  const p = projWp2c('t95f-root');
  wfx(p, '.gitignore', 'node_modules/\n');
  const out = path.join(freshDir('t95f-out'), 'nested', 'protect.json');
  const mk = runCLIWithTemplate(['protect-manifest', p, '--out', out], tpl);
  let man = null; try { man = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* asserted */ }
  t('95f protect-manifest writes the --out file (creating its folder) and exits 0', mk.status === 0 && !!man && man.schema === sync.PROTECT_SCHEMA && /protected entr/.test(mk.stdout));
  t('95f protect-manifest without --out is a usage error (exit 2)', runCLIWithTemplate(['protect-manifest', p], tpl).status === 2);
  t('95f verify-protect on the untouched project exits 0', runCLIWithTemplate(['verify-protect', p, out], tpl).status === 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b95f', nowIso: NOW_WP2C });
  t('95f (a real install ran: seeds created, .gitignore appended, settings merged)', r.ok === true && /\.claude\/forge-runs/.test(rfx(p, '.gitignore')) && rfx(p, '.claude/FORGE_OWNER_PROFILE.json') !== null);
  const v1 = runCLIWithTemplate(['verify-protect', p, out, '--batch', 'b95f'], tpl);
  t('95g verify-protect --batch: the batch\'s own records explain every change (seeds, .gitignore append) -> exit 0', v1.status === 0 && /allowed\s+added .claude\/FORGE_OWNER_PROFILE\.json/.test(v1.stdout) && /appended \.gitignore/.test(v1.stdout));
  const v2 = runCLIWithTemplate(['verify-protect', p, out], tpl);
  t('95g without --batch it uses the receipt\'s latest batch -> exit 0', v2.status === 0 && /via the receipt/.test(v2.stdout));
  const v3 = runCLIWithTemplate(['verify-protect', p, out, '--batch', 'no-such-batch'], tpl);
  t('95g with no matching batch records the created seed files are violations (the records are what makes them legitimate)', v3.status === 1 && /ADDED\s+\.claude\/FORGE_OWNER_PROFILE\.json/.test(v3.stderr));
  fs.appendFileSync(path.join(p, '.gitignore'), 'my-own-later-line\n');
  const v4 = runCLIWithTemplate(['verify-protect', p, out, '--batch', 'b95f'], tpl);
  t('95g a further owner edit to .gitignore beyond the recorded append is a violation', v4.status === 1 && /CHANGED \.gitignore/.test(v4.stderr));
  const vj = runCLIWithTemplate(['verify-protect', p, out, '--batch', 'b95f', '--json'], tpl);
  let vjj = null; try { vjj = JSON.parse(vj.stdout); } catch { /* asserted */ }
  t('95g --json gives the machine-readable verdict', vj.status === 1 && !!vjj && vjj.ok === false && vjj.batch === 'b95f' && vjj.changed.some((c) => c.key === '.gitignore'));
  // a manifest written INSIDE the project's .claude is not itself a protected change
  const pIn = projWp2c('t95f-inside');
  const inside = path.join(pIn, '.claude', 'protect-before.json');
  t('95h a manifest written inside the project skips itself (verify exits 0)', runCLIWithTemplate(['protect-manifest', pIn, '--out', inside], tpl).status === 0 && runCLIWithTemplate(['verify-protect', pIn, inside], tpl).status === 0);
  t('95h verify-protect on a non-manifest file is a usage error (exit 2)', runCLIWithTemplate(['verify-protect', pIn, path.join(pIn, '.claude', 'FORGE_MEMORY.md')], tpl).status === 2);
}

console.log('\n96) WP-2c SYNC-06: settings.json — the pre-merge bytes + hash live in the batch; rollback restores them byte-for-byte');
{
  const { tpl } = tplHomeWp2c('t96-tpl');
  const p = projWp2c('t96-root');
  const sPath = path.join(p, '.claude', 'settings.json');
  fs.writeFileSync(sPath, OWNER_SETTINGS_BYTES);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b96a', nowIso: NOW_WP2C });
  const merged = fs.readFileSync(sPath);
  const bdir = path.join(p, '.claude', 'forge-backups', 'b96a');
  const ledger = JSON.parse(fs.readFileSync(path.join(bdir, sync.SETTINGS_LEDGER_NAME), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(bdir, 'manifest.json'), 'utf8'));
  t('96a the sync merged settings.json (bytes changed, hooks added)', r.ok === true && r.settingsMerge.status === 'merged' && Buffer.compare(merged, OWNER_SETTINGS_BYTES) !== 0 && /forge-gate-hook/.test(merged.toString('utf8')));
  t('96a the batch holds a byte-exact pre-merge copy and a ledger with the pre-merge hash', Buffer.compare(fs.readFileSync(path.join(bdir, 'settings-pre', 'settings.json')), OWNER_SETTINGS_BYTES) === 0 && ledger.preHash === hashBuf(OWNER_SETTINGS_BYTES) && ledger.postHash === hashBuf(merged) && ledger.existed === true);
  t('96a the batch MANIFEST names the pre-merge hash and the merge tool\'s .forge-bak', !!manifest.settings && manifest.settings.preHash === ledger.preHash && typeof manifest.settings.forgeBak === 'string' && /^settings\.json\.forge-bak-/.test(manifest.settings.forgeBak));
  t('96a the result carries the ledger summary', r.settingsMerge.ledger && r.settingsMerge.ledger.preHash === ledger.preHash);
  const rb = sync.rollbackProject(p, 'b96a', {});
  t('96b rollback restores settings.json BYTE-FOR-BYTE (BOM, CRLF, indent, no final newline)', rb.ok === true && Buffer.compare(fs.readFileSync(sPath), OWNER_SETTINGS_BYTES) === 0 && /restored byte-for-byte from the batch copy/.test(rb.settingsAction));
  t('96b ...together with the files (tool.cjs back on V1)', rfx(p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  // (c) an owner edit after the sync is never clobbered without --force-rollback-newer
  const p2 = projWp2c('t96-root2');
  const s2 = path.join(p2, '.claude', 'settings.json');
  fs.writeFileSync(s2, OWNER_SETTINGS_BYTES);
  sync.safeSyncProject(tpl, p2, { batchId: 'b96c', nowIso: NOW_WP2C });
  const ownerEdit = Buffer.from(fs.readFileSync(s2, 'utf8').replace('"keep me"', '"edited after the sync"'), 'utf8');
  fs.writeFileSync(s2, ownerEdit);
  const rb2 = sync.rollbackProject(p2, 'b96c', {});
  t('96c an owner edit since the sync is KEPT: rollback reports the settings conflict (ok:false) and leaves the file', rb2.ok === false && rb2.settingsRestore.conflict === true && Buffer.compare(fs.readFileSync(s2), ownerEdit) === 0 && /settings\.json was not restored/.test(rb2.reason));
  const rb3 = sync.rollbackProject(p2, 'b96c', { forceRollbackNewer: true });
  t('96c --force-rollback-newer restores the pre-sync bytes anyway', rb3.ok === true && Buffer.compare(fs.readFileSync(s2), OWNER_SETTINGS_BYTES) === 0);
  // (d) the batch copy is gone -> the .forge-bak (which hashes to the recorded preHash) is the fallback
  const p3 = projWp2c('t96-root3');
  const s3 = path.join(p3, '.claude', 'settings.json');
  fs.writeFileSync(s3, OWNER_SETTINGS_BYTES);
  sync.safeSyncProject(tpl, p3, { batchId: 'b96d', nowIso: NOW_WP2C });
  fs.rmSync(path.join(p3, '.claude', 'forge-backups', 'b96d', 'settings-pre'), { recursive: true, force: true });
  const rb4 = sync.rollbackProject(p3, 'b96d', {});
  t('96d without the batch copy the verified .forge-bak restores it byte-for-byte', rb4.ok === true && Buffer.compare(fs.readFileSync(s3), OWNER_SETTINGS_BYTES) === 0 && /forge-bak/.test(rb4.settingsAction));
  // (e) a settings.json the sync CREATED is removed again
  const p4 = projWp2c('t96-root4');
  const r4 = sync.safeSyncProject(tpl, p4, { batchId: 'b96e', nowIso: NOW_WP2C });
  t('96e (the sync created settings.json)', r4.ok === true && r4.settingsMerge.status === 'created' && fs.existsSync(path.join(p4, '.claude', 'settings.json')));
  const rb5 = sync.rollbackProject(p4, 'b96e', {});
  t('96e rollback removes the settings.json this sync created', rb5.ok === true && !fs.existsSync(path.join(p4, '.claude', 'settings.json')) && /removed/.test(rb5.settingsAction));
  // (f) a file-plan NO-OP that only merges settings leaves a settings-only batch, which plain `rollback` restores
  const p5 = projWp2c('t96-root5');
  wfx(p5, '.claude/forge-bin/tool.cjs', 'TOOL-V2');
  wfx(p5, '.claude/FORGE_OWNER_PROFILE.json', '{"owner":"template default"}\n');
  wfx(p5, '.claude/skills/demo/SKILL.md', '# demo v2\n');
  wfx(p5, '.claude/skills/demo/learnings.md', '# template learnings\n');
  wfx(p5, '.claude/' + SHIP_MANIFEST_REL_T, fs.readFileSync(path.join(tpl, ...SHIP_MANIFEST_REL_T.split('/')))); // config/** ships it too
  fs.writeFileSync(path.join(p5, '.claude', 'settings.json'), OWNER_SETTINGS_BYTES);
  const r5 = sync.safeSyncProject(tpl, p5, { batchId: 'b96f', nowIso: NOW_WP2C });
  t('96f (file plan is a no-op; only settings.json was merged, with its ledger)', r5.noop === true && r5.ok === true && r5.settingsMerge.status === 'merged' && fs.existsSync(path.join(p5, '.claude', 'forge-backups', 'b96f', sync.SETTINGS_LEDGER_NAME)));
  const rb6 = sync.rollbackProject(p5, null, {});
  t('96f plain `rollback` finds that settings-only batch and restores settings.json byte-for-byte', rb6.ok === true && rb6.batchId === 'b96f' && rb6.source === 'settings-ledger-only' && Buffer.compare(fs.readFileSync(path.join(p5, '.claude', 'settings.json')), OWNER_SETTINGS_BYTES) === 0);
  // (g) no undo record possible -> the merge is refused, settings.json untouched
  const p6 = projWp2c('t96-root6');
  fs.writeFileSync(path.join(p6, '.claude', 'settings.json'), OWNER_SETTINGS_BYTES);
  const g = sync.mergeSettingsForBatch(tpl, p6, '../escape', {});
  t('96g a merge that cannot record its undo (unsafe batch id) is REFUSED and settings.json is untouched', g.ok === false && g.skipped === 'no-undo-record' && Buffer.compare(fs.readFileSync(path.join(p6, '.claude', 'settings.json')), OWNER_SETTINGS_BYTES) === 0);
  const tampered = path.join(p, '.claude', 'forge-backups', 'b96a', sync.SETTINGS_LEDGER_NAME);
  const led = JSON.parse(fs.readFileSync(tampered, 'utf8')); led.projectPath = 'C:\\somewhere\\else'; fs.writeFileSync(tampered, JSON.stringify(led));
  t('96h a ledger that does not match the batch/project is never trusted', sync.restoreSettingsLedger(p, 'b96a', {}).ok === false);
}

console.log('\n97) WP-2c SYNC-07: install --dry-run --json — the full plan as JSON, nothing written');
{
  const { tpl } = tplHomeWp2c('t97-tpl', { snippet: '.claude/forge-runs/*/*\n.claude/forge-index/\n', claudeStub: true });
  wfx(tpl, 'forge-bin/new-tool.cjs', 'NEW');
  wfx(tpl, 'forge-bin/drifted.cjs', 'DRIFT-TEMPLATE');
  const p = projWp2c('t97-root');
  wfx(p, '.claude/skills/demo/SKILL.md', '# demo v2\n'); // current
  wfx(p, '.claude/skills/demo/learnings.md', '# this project\'s own learnings\n'); // seed kept
  wfx(p, '.claude/forge-bin/drifted.cjs', 'EDITED HERE, NO BASELINE'); // drift
  const oldHash = sync.sha256(wfx(p, '.claude/forge-bin/retired-tool.cjs', 'OLD TOOL'));
  const rc = sync.readReceipt(p); rc.knownHashes['forge-bin/retired-tool.cjs'] = oldHash; sync.writeReceipt(p, rc); // an orphan
  wfx(p, '.gitignore', 'node_modules/\n.claude/forge-index/\n');
  fs.writeFileSync(path.join(p, '.claude', 'settings.json'), OWNER_SETTINGS_BYTES);
  const before = snapshotTree(p);
  const cli = runCLIWithTemplate(['install', p, '--dry-run', '--json'], tpl);
  let j = null; try { j = JSON.parse(cli.stdout); } catch (e) { console.error('  (97: stdout was not JSON: ' + e.message + ')'); }
  const act = (rel) => (j && (j.files.find((f) => f.rel === rel) || {}).action) || null;
  t('97a stdout is ONE JSON document with the plan schema (exit 0)', cli.status === 0 && !!j && j.schema === 'forge-sync-install-plan/v1' && j.dryRun === true);
  t('97a NOTHING was written (byte-identical project, no lock, no backup, no report)', JSON.stringify(snapshotTree(p)) === JSON.stringify(before));
  t('97b per-file actions: update / add / current / seed-created / seed-kept / drift / orphan', act('forge-bin/tool.cjs') === 'update' && act('forge-bin/new-tool.cjs') === 'add' && act('skills/demo/SKILL.md') === 'current'
    && act('FORGE_OWNER_PROFILE.json') === 'seed-created' && act('skills/demo/learnings.md') === 'seed-kept' && act('forge-bin/drifted.cjs') === 'drift' && act('forge-bin/retired-tool.cjs') === 'orphan');
  const upd = j && j.files.find((f) => f.rel === 'forge-bin/tool.cjs');
  t('97b an update row carries old/new hash and the size delta', !!upd && /^[0-9a-f]{64}$/.test(upd.oldHash) && /^[0-9a-f]{64}$/.test(upd.newHash) && upd.oldSize === 7 && upd.newSize === 7 && upd.sizeDelta === 0);
  t('97b counts add up to the rows', !!j && Object.values(j.counts).reduce((a, b) => a + b, 0) === j.files.length);
  t('97c the scaffold preview: .gitignore would get exactly the missing rule, CLAUDE.md would be created', !!j && j.scaffold.gitignore.action === 'append' && JSON.stringify(j.scaffold.gitignore.linesToAppend) === JSON.stringify(['.claude/forge-runs/*/*']) && j.scaffold.claudeMd.action === 'create');
  const hooks = (j && j.settings.hooksAdded) || [];
  t('97d the settings delta lists every hook command that becomes active (event, matcher, command)', !!j && j.settings.status === 'would-merge' && hooks.some((h) => h.event === 'PreToolUse' && h.matcher === 'Bash|PowerShell' && /forge-gate-hook\.cjs/.test(h.command)) && hooks.some((h) => h.event === 'PostToolUse' && /forge-toolhook\.cjs/.test(h.command)));
  t('97d ...and every deny rule it adds', !!j && JSON.stringify(j.settings.denyAdded) === JSON.stringify(['Read(./.env)', 'Read(./.env.*)']));
  t('97e the orphan list and the coupled-delivery verdict are in the plan', !!j && j.orphans.unmodified.includes('forge-bin/retired-tool.cjs') && !!j.coupledDelivery && j.coupledDelivery.ok === true && j.provenance && 'devCommitTo' in j.provenance);
  t('97f --json without --dry-run is a usage error (exit 2)', runCLIWithTemplate(['install', p, '--json'], tpl).status === 2);
  t('97f --json with --unsafe is a usage error (exit 2)', runCLIWithTemplate(['install', p, '--dry-run', '--json', '--unsafe'], tpl).status === 2);
  const fresh = makeProject(freshDir('t97-fresh'), 'proj', 0);
  const d2 = sync.safeSyncProject(tpl, fresh, { dryRun: true, batchId: 'b97', nowIso: NOW_WP2C });
  const j2 = sync.installPlanJson(tpl, fresh, d2);
  t('97g a project without settings.json: the delta is the template\'s WHOLE hook + deny set (would-create)', j2.settings.status === 'would-create' && j2.settings.hooksAdded.length === 2 && j2.settings.denyAdded.length === 2);
}

console.log('\n98) WP-2c SYNC-12: provenance (devCommitFrom/To) in FORGE_VERSION.json and the per-batch change report');
{
  const { home, tpl } = tplHomeWp2c('t98-tpl');
  wfx(home, 'template-provenance.json', JSON.stringify({ devCommit: 'abc1234def', dirty: false, publishedAt: NOW_WP2C }));
  const p = projWp2c('t98-root');
  const r1 = sync.safeSyncProject(tpl, p, { batchId: 'b98a', nowIso: NOW_WP2C });
  const v1 = JSON.parse(fs.readFileSync(sync.versionFilePath(p), 'utf8'));
  t('98a FORGE_VERSION.json records devCommitTo from template-provenance.json; devCommitFrom is null on a first sync', r1.ok === true && v1.devCommitTo === 'abc1234def' && v1.devCommitFrom === null && v1.provenanceSource === 'template-provenance.json');
  t('98a the receipt carries the same provenance', sync.readReceipt(p).provenance.devCommitTo === 'abc1234def');
  wfx(home, 'template-provenance.json', JSON.stringify({ devCommit: 'fed9876abc', dirty: true }));
  wfx(tpl, 'forge-bin/tool.cjs', 'TOOL-V3');
  const r2 = sync.safeSyncProject(tpl, p, { batchId: 'b98b', nowIso: '2026-10-10T13:00:00.000Z' });
  const v2 = JSON.parse(fs.readFileSync(sync.versionFilePath(p), 'utf8'));
  t('98b the next sync moves From -> To (abc1234def -> fed9876abc) and records a dirty template tree', r2.ok === true && v2.devCommitFrom === 'abc1234def' && v2.devCommitTo === 'fed9876abc' && v2.templateDirty === true);
  const rep = rfx(p, '.claude/forge-sync-report-b98b.md') || '';
  t('98c forge-sync-report-<batch>.md is written next to the receipt and named in it', fs.existsSync(path.join(p, '.claude', 'forge-sync-report-b98b.md')) && sync.readReceipt(p).report === 'forge-sync-report-b98b.md' && r2.report.path.endsWith('forge-sync-report-b98b.md'));
  t('98c it shows the dev-commit range and the outcome', /abc1234def → fed9876abc/.test(rep) && /\*\*SYNCED\*\*/.test(rep) && /uncommitted changes/.test(rep));
  t('98c changed files are grouped by area', /## Changed files \(1\), by area/.test(rep) && /### forge-bin \(1\)/.test(rep) && /- updated `forge-bin\/tool\.cjs`/.test(rep));
  t('98c it has the settings, kept-files, orphan, coupled-delivery, doctor and protected-files sections', ['## settings.json', '## Kept as the project has them', '## Orphans', '## Coupled delivery', '## Doctor (validation)', '## Protected files'].every((h) => rep.includes(h)));
  t('98c the coupled-delivery rule is explained in plain words', /only ever delivered together/.test(rep) && /completion-trio/.test(rep));
  t('98c doctor before/after are summarised', /- Before: forge-doctor OK/.test(rep) && /- After: forge-doctor OK/.test(rep));
  t('98d the report is never shipped (never-touch floor) and is add-only bookkeeping for the protect check', sync.isNeverTouch('forge-sync-report-b98b.md') && sync.protectAllowance('.claude/forge-sync-report-b98b.md') === 'add-only');
  const legacy = freshDir('t98-legacy');
  wfx(legacy, '.claude/forge-bin/tool.cjs', 'x');
  t('98e a template with no provenance file and no own git work tree reports source "unknown" (never a guess)', sync.templateProvenance(path.join(legacy, '.claude')).source === 'unknown');
  const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!gitOk) console.log('  SKIP 98f: git is not available here — the git fallback was not exercised');
  else {
    const repo = freshDir('t98-git');
    wfx(repo, '.claude/forge-bin/tool.cjs', 'x');
    const g = (args) => spawnSync('git', ['-C', repo].concat(args), { encoding: 'utf8' });
    g(['init', '-q']); g(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '.']); g(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture']);
    const head = g(['rev-parse', 'HEAD']).stdout.trim();
    const pv = sync.templateProvenance(path.join(repo, '.claude'));
    t('98f a dev tree used as the template (its home IS the git top) reports its HEAD as devCommit', pv.source === 'git' && pv.devCommit === head && pv.dirty === false);
  }
}

console.log('\n99) WP-2c coupled delivery: log-event / forge-verify / forge-runcontract go together or not at all');
{
  const TRIO = ['forge-dashboard/log-event.cjs', 'forge-bin/forge-verify.cjs', 'forge-bin/forge-runcontract.cjs'];
  t('99a the coupled group is exactly the trio', JSON.stringify(sync.COUPLED_DELIVERY_GROUPS[0].rels) === JSON.stringify(TRIO));
  // contents must PARSE (the installer's own node --check gate runs over every synced .cjs)
  const trioTpl = (name, skip) => { const x = tplHomeWp2c(name, { settings: false, extraRules: [SHIP_RULE('.claude/forge-dashboard/*.cjs', 'ship-sync')] }); for (const rel of TRIO) if (rel !== skip) wfx(x.tpl, rel, '// NEW ' + rel + '\n'); return x.tpl; };
  const trioProj = (name, overrides) => {
    const p = projWp2c(name);
    const rc = sync.readReceipt(p);
    for (const rel of TRIO) rc.knownHashes[rel] = sync.sha256(wfx(p, '.claude/' + rel, '// OLD ' + rel + '\n'));
    sync.writeReceipt(p, rc);
    if (overrides) wfx(p, '.claude/config/forge-overrides.json', JSON.stringify({ overrides }));
    return p;
  };
  const tpl = trioTpl('t99-tpl');
  const pA = trioProj('t99-a');
  const rA = sync.safeSyncProject(tpl, pA, { batchId: 'b99a', nowIso: NOW_WP2C });
  t('99b all three updated together -> consistent, the sync succeeds', rA.ok === true && TRIO.every((rel) => rfx(pA, '.claude/' + rel) === '// NEW ' + rel + '\n') && rA.coupledDelivery.ok === true);
  const pB = trioProj('t99-b', ['forge-bin/forge-runcontract.cjs']);
  const beforeB = snapshotTree(pB);
  const rB = sync.safeSyncProject(tpl, pB, { batchId: 'b99b', nowIso: NOW_WP2C });
  t('99c only a SUBSET would change (runcontract held by forge-overrides.json) -> REFUSED before any write', rB.ok === false && rB.refused === true && rB.refusedCoupled === true && JSON.stringify(snapshotTree(pB)) === JSON.stringify(beforeB));
  t('99c the reason names the held file, why it is held, and the rule', /forge-runcontract\.cjs \(declared in forge-overrides\.json/.test(rB.reason) && /delivered together/.test(rB.reason));
  const dry = runCLIWithTemplate(['install', pB, '--dry-run', '--json'], tpl);
  let dj = null; try { dj = JSON.parse(dry.stdout); } catch { /* asserted */ }
  t('99c the dry-run says so too: exit 1, wouldRefuse set, coupledDelivery.ok false', dry.status === 1 && !!dj && /coupled delivery/.test(dj.wouldRefuse || '') && dj.coupledDelivery.ok === false);
  const uB = quiet(() => sync.rawInstall(tpl, pB, { batchId: 'b99u', nowIso: NOW_WP2C }));
  t('99c --unsafe refuses a mixed trio as well', uB.r.ok === false && uB.r.refusedCoupled === true);
  const pC = trioProj('t99-c', ['forge-bin/forge-runcontract.cjs']);
  wfx(pC, '.claude/forge-bin/forge-runcontract.cjs', '// NEW forge-bin/forge-runcontract.cjs\n'); // the override already MATCHES the template
  const rC = sync.safeSyncProject(tpl, pC, { batchId: 'b99c', nowIso: NOW_WP2C });
  t('99d ...unless the project already holds the matching version (current) -> allowed', rC.ok === true && rC.coupledDelivery.groups[0].members.find((m) => m.rel === 'forge-bin/forge-runcontract.cjs').outcome === 'current');
  const counter = path.join(freshDir('t99-counter'), 'doctor-runs');
  const pE = trioProj('t99-e');
  wfx(pE, '.claude/forge-bin/forge-verify.cjs', 'EDITED IN THE PROJECT\n');
  const rcE = sync.readReceipt(pE); delete rcE.knownHashes['forge-bin/forge-verify.cjs']; sync.writeReceipt(pE, rcE); // unknown drift
  writeDoctorStub(pE, 0, 'require("fs").appendFileSync(' + JSON.stringify(counter) + ', "x");');
  const rE = sync.safeSyncProject(tpl, pE, { batchId: 'b99e', nowIso: NOW_WP2C, refuseOnUnresolvedDrift: true });
  t('99e drift on one member while the others would update -> refused BEFORE the doctor even runs', rE.ok === false && rE.refusedCoupled === true && /unknown drift/.test(rE.reason) && !fs.existsSync(counter));
  const tplF = trioTpl('t99-f-tpl', 'forge-bin/forge-verify.cjs');
  const pF = trioProj('t99-f');
  const beforeF = snapshotTree(pF);
  const rF = sync.safeSyncProject(tplF, pF, { batchId: 'b99f', nowIso: NOW_WP2C });
  // FLIPPED 2026-10-10 (Codex review): this used to assert the WEAK behaviour — a member the template lacks was
  // "not-shipped", outside the check, and the other two were delivered alone: exactly the mixed writer/checker state the
  // coupled guard exists to prevent. A missing member now refuses the install before any write, with a plain reason.
  t('99f a member the template does NOT ship refuses the install (the guard is never switched off by a missing member)', rF.ok === false && rF.refusedCoupled === true && rF.coupledDelivery.groups[0].members.find((m) => m.rel === 'forge-bin/forge-verify.cjs').outcome === 'missing-in-template');
  t('99f ...the reason names the missing file, and nothing was written', /MISSING forge-bin\/forge-verify\.cjs/.test(rF.reason || '') && JSON.stringify(snapshotTree(pF)) === JSON.stringify(beforeF));
}

console.log('\n100) WP-2c isolation: this suite never touched the real ~/.claude, the real template or a real project');
{
  const real = path.join(os.homedir(), '.claude');
  const fake = process.env.FORGE_SYNC_TEST_PROJECTS_ROOT;
  t('100a the CLI quiesce seams point at an os.tmpdir() folder, never at ~/.claude/projects', !!fake && path.resolve(fake).startsWith(path.resolve(os.tmpdir())) && !path.resolve(fake).startsWith(path.resolve(real)));
  t('100b every WP-2c fixture is under os.tmpdir()', ALL_FIXTURE_ROOTS.every((d) => path.resolve(d).startsWith(path.resolve(os.tmpdir()))));
  t('100c no WP-2c fixture lives inside ~/.claude', !ALL_FIXTURE_ROOTS.some((d) => path.resolve(d).toLowerCase().startsWith(path.resolve(real).toLowerCase() + path.sep)));
}

// =====================================================================================================================
// publish-template --plan|--apply|--verify.
// 101 plan · 102 apply + verify green · 103 verify red after drift · 104 apply refusals · 105 backup mismatch ·
// 106 failure mid-way restores · 107 orphans moved, never deleted · 108 provenance + receipt · 109 idempotent ·
// 110 hints, never-publish floor, manifest, isolation. Every fixture is an os.tmpdir() folder: a fake development tree
// (its own git repo) and a fake template; the CLI runs get a fake home, so even the DEFAULT target is a fixture.
// =====================================================================================================================
const NOW_WP3B = '2026-10-10T15:00:00.000Z';
const PUB_FAKE_REAL = path.join(os.tmpdir(), 'fsync-wp3b-not-the-real-template', '.claude'); // never created
const PUB_TEMPLATES_USED = [];
const PUB_GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const PUB_RULES = [
  SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync'),
  SHIP_RULE('.claude/forge-bin/maint-*.cjs', 'local-only'),
  SHIP_RULE('.claude/config/**', 'ship-sync'),
  SHIP_RULE('.claude/config/**/*.user.json', 'per-project'),
  SHIP_RULE('.claude/config/forge-dev-tree.json', 'local-only'),
  SHIP_RULE('.claude/skills/*/**', 'ship-sync'),
  SHIP_RULE('.claude/skills/**/learnings.md', 'seed-only'),
  SHIP_RULE('.claude/FORGE_OWNER_PROFILE.json', 'seed-only'),
  SHIP_RULE('.claude/FORGE_SKILL_REGISTRY.md', 'ship-sync'),
  { pattern: '.claude/settings.json', class: 'ship-release-only', channels: ['release', 'template'], delivery: 'settings-merge', reason: 'fixture: merged into projects' },
  SHIP_RULE('.claude/FORGE_{MEMORY,TASK_HISTORY}.md', 'per-project'),
  SHIP_RULE('.claude/forge-runs/**', 'per-project'),
];
const PUB_DEV_FILES = {
  'forge-bin/tool.cjs': 'TOOL-V2\n', 'forge-bin/helper.cjs': 'HELPER\n', 'forge-bin/maint-release.cjs': 'MAINT\n',
  'config/a.json': '{"a":1}\n', 'config/forge-dev-tree.json': '{"dev_tree":true}\n', 'config/mine.user.json': '{"private":true}\n',
  'skills/demo/SKILL.md': '# demo v2\n', 'skills/demo/learnings.md': '# learnings\n', 'FORGE_OWNER_PROFILE.json': '{"owner":"default"}\n',
  'FORGE_SKILL_REGISTRY.md': '# registry\n', 'settings.json': '{"hooks":{}}\n', 'FORGE_MEMORY.md': '# dev memory\n', 'forge-runs/r1/events.jsonl': '{}\n',
};
const PUB_SET = ['FORGE_OWNER_PROFILE.json', 'FORGE_SKILL_REGISTRY.md', 'config/a.json', 'config/orchestration/FORGE_SHIP_MANIFEST.json', 'forge-bin/helper.cjs', 'forge-bin/tool.cjs', 'settings.json', 'skills/demo/SKILL.md', 'skills/demo/learnings.md'];
function pubGit(dir) { return (args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'].concat(args), { encoding: 'utf8' }); }
/** pubFixture — a development tree (git: v1 still has forge-bin/gone.cjs, gone2.cjs and skills/oldskill/, v2 drops them)
 *  and an OLDER template beside it. opts: stray (an orphan never in dev), edited (gone2.cjs edited in the template),
 *  oldSkill (a whole retired skill folder), copyCli (the real forge-sync + shipcheck copied in, so the fixture's OWN CLI
 *  publishes its own tree), fakeHome (the template lives at <fakeHome>/.claude/forge/template — the CLI's default), rules. */
// WP-SPD-G (speed only): the development-tree repository of a pubFixture depends only on (rules, copyCli), yet
// every fixture used to rebuild it with 6 git runs (init, add, commit, add, commit, rev-parse). It is now built ONCE per
// (rules, copyCli) into a cache folder by exactly those steps and copied (worktree + .git) into each fixture; the copy has
// the same files, the same two commits and the same HEAD as a fresh build. Each fixture still gets its own folder and its
// own `g`, so later commits/edits in one fixture never reach another. The cache lives in the private run folder (removed
// at exit) and is deliberately NOT a freshDir: the fixture count appears in assertion names and must not change.
const PUB_DEV_REPO_CACHE = new Map();
function pubDevRepoTemplate(rules, copyCli) {
  const key = JSON.stringify([rules, !!copyCli]);
  const hit = PUB_DEV_REPO_CACHE.get(key);
  if (hit) return hit;
  const devRoot = path.join(fs.mkdtempSync(path.join(TMPH_RUN_DIR, 'fsync-pubdev-cache-')), 'dev'), dev = path.join(devRoot, '.claude');
  writeTplManifest(dev, rules);
  for (const [rel, body] of Object.entries(PUB_DEV_FILES)) wfx(dev, rel, body);
  if (copyCli) for (const f of ['forge-sync.cjs', 'forge-shipcheck.cjs', 'forge-shipcheck-refs.cjs']) fs.copyFileSync(path.join(path.dirname(CLI), f), path.join(dev, 'forge-bin', f));
  const g = pubGit(devRoot);
  g(['init', '-q']);
  wfx(dev, 'forge-bin/gone.cjs', 'GONE-V1\n'); wfx(dev, 'forge-bin/gone2.cjs', 'GONE2-V1\n'); wfx(dev, 'skills/oldskill/SKILL.md', '# old skill\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'v1']);
  for (const rel of ['forge-bin/gone.cjs', 'forge-bin/gone2.cjs', 'skills/oldskill/SKILL.md']) fs.rmSync(path.join(dev, ...rel.split('/')));
  fs.rmdirSync(path.join(dev, 'skills', 'oldskill'));
  g(['add', '-A']); g(['commit', '-q', '-m', 'v2 drops gone.cjs, gone2.cjs and the old skill']);
  const built = { devRoot, head: g(['rev-parse', 'HEAD']).stdout.trim() };
  PUB_DEV_REPO_CACHE.set(key, built);
  return built;
}
function pubFixture(name, opts) {
  opts = opts || {};
  const root = freshDir(name);
  const devRoot = path.join(root, 'dev'), dev = path.join(devRoot, '.claude');
  const fakeHome = path.join(root, 'home');
  const home = opts.fakeHome ? path.join(fakeHome, '.claude', 'forge', 'template') : path.join(root, 'tpl');
  const tpl = path.join(home, '.claude');
  const cached = pubDevRepoTemplate(opts.rules || PUB_RULES, opts.copyCli);
  fs.cpSync(cached.devRoot, devRoot, { recursive: true });
  const g = pubGit(devRoot);
  const T = {
    'forge-bin/tool.cjs': 'TOOL-V1\n', 'config/a.json': '{"a":1}\n', 'skills/demo/SKILL.md': '# demo v2\n', 'FORGE_OWNER_PROFILE.json': '{"owner":"default"}\n',
    'FORGE_SKILL_REGISTRY.md': '# registry\n', 'forge-bin/gone.cjs': 'GONE-V1\n', 'FORGE_MEMORY.md': '# placeholder\n', 'FORGE_TASK_HISTORY.md': '# placeholder\n', 'forge-runs/.gitkeep': '',
  };
  if (opts.stray) T['forge-bin/stray.cjs'] = 'STRAY\n';
  if (opts.edited) T['forge-bin/gone2.cjs'] = 'GONE2-EDITED\n';
  if (opts.oldSkill) T['skills/oldskill/SKILL.md'] = '# old skill\n';
  for (const [rel, body] of Object.entries(T)) wfx(tpl, rel, body);
  wfx(home, 'CLAUDE.md', '# template home\n'); wfx(home, 'gitignore.snippet', 'node_modules/\n');
  PUB_TEMPLATES_USED.push(tpl);
  return { root, devRoot, dev, home, tpl, fakeHome, g, head: cached.head };
}
const pubOpts = (fx, extra) => Object.assign({ devDir: fx.dev, templateDir: fx.tpl, realTemplateDir: PUB_FAKE_REAL }, extra || {});
/** runPubCli — the FIXTURE's own forge-sync.cjs (so its development tree is the fixture), with a fake home: even the
 *  default target (no --template-dir) can only ever be a fixture. */
function runPubCli(fx, args, env) {
  return spawnSync(process.execPath, [path.join(fx.dev, 'forge-bin', 'forge-sync.cjs'), 'publish-template'].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { USERPROFILE: fx.fakeHome, HOME: fx.fakeHome }, env || {}) });
}
/** pubTreeState — every file (hex) AND every folder, so a folder the publish created and the restore removed is visible. */
function pubTreeState(dir) {
  const out = {};
  (function walk(d) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = path.join(d, e.name); if (e.isDirectory()) { out[p + path.sep] = 'DIR'; walk(p); } else out[p] = fs.readFileSync(p).toString('hex'); }
  })(dir);
  return out;
}
const pubBackups = (fx) => { const d = path.join(path.dirname(fx.home), 'template-backups'); try { return fs.readdirSync(d).map((n) => path.join(d, n)); } catch { return []; } };
const pubJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

if (!PUB_GIT_OK) console.log('\n101-110) SKIP: git is not available here — publish-template needs a git development tree; NOT exercised');
else {
  console.log('\n101) WP-3b publish-template --plan: exactly the expected delta, read-only');
  {
    const fx = pubFixture('t101', { stray: true, edited: true, oldSkill: true });
    const before = snapshotTree(fx.root);
    const plan = sync.planPublishTemplate(pubOpts(fx));
    t('101a add = exactly the manifest, helper.cjs, settings.json and the seed learnings.md', JSON.stringify(plan.add.map((x) => x.rel)) === JSON.stringify(['config/orchestration/FORGE_SHIP_MANIFEST.json', 'forge-bin/helper.cjs', 'settings.json', 'skills/demo/learnings.md']));
    t('101a update = exactly forge-bin/tool.cjs (TOOL-V1 -> TOOL-V2)', JSON.stringify(plan.update.map((x) => x.rel)) === JSON.stringify(['forge-bin/tool.cjs']) && plan.update[0].oldHash === sync.sha256(path.join(fx.tpl, 'forge-bin', 'tool.cjs')));
    t('101a unchanged = the four identical files', JSON.stringify(plan.unchanged) === JSON.stringify(['FORGE_OWNER_PROFILE.json', 'FORGE_SKILL_REGISTRY.md', 'config/a.json', 'skills/demo/SKILL.md']));
    const set = [...sync.publishSourceSet(fx.dev).files.keys()];
    t('101b the source set = ship-sync + seed-only + the template-channel settings.json + the manifest (9 files)', JSON.stringify(set) === JSON.stringify(PUB_SET) && plan.counts.source === 9 && plan.counts.templateOnly === 1 && plan.counts.seedOnly === 2);
    t('101b never published: the dev-tree marker, a *.user.json, a local-only tool, project memory, runs', ['config/forge-dev-tree.json', 'config/mine.user.json', 'forge-bin/maint-release.cjs', 'FORGE_MEMORY.md', 'forge-runs/r1/events.jsonl'].every((r) => !set.includes(r)));
    const orphan = (rel) => plan.orphans.find((o) => o.rel === rel) || {};
    t('101c gone.cjs is a PROVEN orphan (byte-identical to a version in the dev git history)', orphan('forge-bin/gone.cjs').retirable === true && orphan('forge-bin/gone.cjs').provenBy === 'dev-git-history' && orphan('forge-bin/gone.cjs').class === 'ship-sync');
    t('101c a whole retired skill folder file is proven too', orphan('skills/oldskill/SKILL.md').retirable === true);
    t('101c stray.cjs (never in dev) and gone2.cjs (edited in the template) are UNPROVEN -> kept', orphan('forge-bin/stray.cjs').retirable === false && /not proven/.test(orphan('forge-bin/stray.cjs').keptReason) && orphan('forge-bin/gone2.cjs').retirable === false);
    const foreign = plan.foreign.map((x) => x.rel);
    t('101d installer placeholders and runtime folders are FOREIGN (never orphans, never managed)', ['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'forge-runs/'].every((r) => foreign.includes(r)) && !plan.orphans.some((o) => /FORGE_MEMORY|forge-runs/.test(o.rel)));
    t('101e templateVersion: current = the template\'s own, after publish = the development tree\'s, and they differ', plan.templateVersion.current === sync.templateVersion(fx.tpl) && plan.templateVersion.afterPublish === sync.templateVersion(fx.dev) && plan.templateVersion.current !== plan.templateVersion.afterPublish);
    t('101e a kept ship-sync orphan makes the resulting version NOT exact (said, not hidden)', plan.templateVersion.exactAfterPublish === false);
    t('101f dev git state: HEAD recorded, nothing dirty, --apply would not refuse', plan.dev.git.head === fx.head && plan.dev.git.dirtyPaths.length === 0 && plan.applyWouldRefuse.length === 0 && plan.inSync === false);
    t('101g --plan wrote NOTHING (dev tree incl. .git, template, template home byte-identical; no backup folder)', JSON.stringify(snapshotTree(fx.root)) === JSON.stringify(before) && pubBackups(fx).length === 0);
    const fxc = pubFixture('t101cli', { copyCli: true, fakeHome: true });
    const cj = runPubCli(fxc, ['--plan', '--json']);
    const pj = pubJson(cj.stdout);
    t('101h CLI --plan --json: exit 0, machine-readable, the default target is (the fake home\'s) real template', cj.status === 0 && !!pj && pj.schema === 'forge-sync-publish-template/v1' && pj.realTemplate === true && pj.add.some((x) => x.rel === 'forge-bin/forge-sync.cjs'));
    const ch = runPubCli(fxc, ['--template-dir', fxc.tpl]);
    t('101h CLI human plan names ADD/UPDATE/ORPHAN and ends with the verdict', ch.status === 0 && /ADD \(/.test(ch.stdout) && /UPDATE \(/.test(ch.stdout) && /ORPHAN, proven ours/.test(ch.stdout) && /DIFFERS from the development tree/.test(ch.stdout));
  }

  console.log('\n102) WP-3b publish-template --apply into a temp template, then --verify is green');
  {
    const fx = pubFixture('t102');
    const homeBefore = { claude: rfx(fx.home, 'CLAUDE.md'), snip: rfx(fx.home, 'gitignore.snippet'), mem: rfx(fx.tpl, 'FORGE_MEMORY.md'), runs: rfx(fx.tpl, 'forge-runs/.gitkeep') };
    const r = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p102', nowIso: NOW_WP3B }));
    t('102a apply succeeds (exit 0) and its own post-verify is green', r.ok === true && r.exitCode === 0 && r.verify && r.verify.ok === true);
    t('102a every published file is byte-identical in the template', PUB_SET.every((rel) => sync.sha256(path.join(fx.dev, rel)) === sync.sha256(path.join(fx.tpl, rel))));
    const v = sync.verifyPublishTemplate(pubOpts(fx));
    t('102b an independent --verify: exit 0, equal templateVersion values, nothing missing for ship-sync', v.ok === true && v.exitCode === 0 && v.templateVersion.template === v.templateVersion.dev && Array.isArray(v.missingInTemplate) && v.missingInTemplate.length === 0 && v.warnings.length === 0);
    t('102c the backup is a dated folder OUTSIDE both trees, named after the batch', !!r.backupDir && path.dirname(r.backupDir) === path.join(fx.root, 'template-backups') && /template-20261010-150000-p102$/.test(r.backupDir));
    t('102c it holds the pre-publish template (old tool.cjs), its manifest, the journal and a receipt', rfx(r.backupDir, 'files/forge-bin/tool.cjs') === 'TOOL-V1\n' && fs.existsSync(path.join(r.backupDir, 'backup-manifest.json')) && fs.existsSync(path.join(r.backupDir, 'journal.jsonl')) && pubJson(rfx(r.backupDir, 'receipt.json')).outcome === 'PUBLISHED');
    t('102d foreign files and the template home are untouched', rfx(fx.home, 'CLAUDE.md') === homeBefore.claude && rfx(fx.home, 'gitignore.snippet') === homeBefore.snip && rfx(fx.tpl, 'FORGE_MEMORY.md') === homeBefore.mem && rfx(fx.tpl, 'forge-runs/.gitkeep') === homeBefore.runs);
    t('102d the lock is released (no .forge-sync.lock left in the template)', !fs.existsSync(path.join(fx.tpl, '.forge-sync.lock')));
    t('102e the template now carries its own manifest: forge-sync install sees source "template"', sync.shipPlan(fx.tpl).manifest.source === 'template' && JSON.stringify(sync.listSystemFiles(fx.tpl)) === JSON.stringify(sync.listSystemFiles(fx.dev)));
    const fxc = pubFixture('t102cli', { copyCli: true });
    const a = runPubCli(fxc, ['--apply', '--template-dir', fxc.tpl, '--batch-id', 'p102cli']);
    const vv = runPubCli(fxc, ['--verify', '--template-dir', fxc.tpl, '--json']);
    t('102f CLI --apply exits 0 (verify green) and CLI --verify --json exits 0 with ok:true', a.status === 0 && /VERIFIED/.test(a.stdout) && vv.status === 0 && pubJson(vv.stdout).ok === true);
  }

  console.log('\n103) WP-3b publish-template --verify is RED after a planted drift (exit 3)');
  {
    const fx = pubFixture('t103');
    sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p103', nowIso: NOW_WP3B }));
    t('103a green right after the publish', sync.verifyPublishTemplate(pubOpts(fx)).ok === true);
    wfx(fx.tpl, 'forge-bin/tool.cjs', 'HAND-EDITED IN THE TEMPLATE\n');
    fs.rmSync(path.join(fx.tpl, 'FORGE_SKILL_REGISTRY.md'));
    wfx(fx.tpl, 'forge-bin/planted.cjs', 'PLANTED\n');
    const v = sync.verifyPublishTemplate(pubOpts(fx));
    const kind = (k) => (v.differences.find((d) => d.kind === k) || { paths: [] });
    t('103b exit 3, not ok', v.ok === false && v.exitCode === 3);
    t('103b names the changed file, the missing file and the planted orphan', kind('different').paths.includes('forge-bin/tool.cjs') && kind('missing-in-template').paths.includes('FORGE_SKILL_REGISTRY.md') && kind('orphan').paths.includes('forge-bin/planted.cjs'));
    t('103b the template\'s own manifest reports the missing literal ship-sync entry (missingInTemplate)', kind('missing-ship-sync').paths.includes('FORGE_SKILL_REGISTRY.md') && v.missingInTemplate.some((m) => m.rel === 'FORGE_SKILL_REGISTRY.md'));
    t('103b templateVersion differs and is reported', !!v.differences.find((d) => d.kind === 'template-version') && v.templateVersion.template !== v.templateVersion.dev);
    const fxc = pubFixture('t103cli', { copyCli: true });
    const applied = runPubCli(fxc, ['--apply', '--template-dir', fxc.tpl, '--batch-id', 'p103cli']);
    wfx(fxc.tpl, 'config/a.json', '{"a":"drift"}\n');
    const c = runPubCli(fxc, ['--verify', '--template-dir', fxc.tpl]);
    t('103c CLI: after a green --apply, one drifted file makes --verify exit 3, NOT VERIFIED, naming it', applied.status === 0 && c.status === 3 && /NOT VERIFIED/.test(c.stdout) && /different \(1\): config\/a\.json/.test(c.stdout));
    const release = { pattern: '.claude/skills/{gsap,humanizer}/**', class: 'ship-sync', channels: ['sync', 'template'], release_excluded: 'no open licence', reason: 'fixture' };
    const fxr = pubFixture('t103rel', { rules: PUB_RULES.concat([release]) });
    const rr = sync.applyPublishTemplate(pubOpts(fxr, { batchId: 'p103rel', nowIso: NOW_WP3B }));
    t('103d a release_excluded entry the dev tree does not have is never "missing" (respects release_excluded)', rr.ok === true && rr.verify.ok === true && rr.verify.missingInTemplate.length === 0);
  }

  console.log('\n104) WP-3b publish-template --apply REFUSES (exit 4, nothing written): dirty tree, unsafe batch id, real template');
  {
    const fx = pubFixture('t104a');
    wfx(fx.dev, 'forge-bin/tool.cjs', 'TOOL-V3-UNCOMMITTED\n');
    wfx(fx.dev, 'forge-bin/brand-new.cjs', 'UNTRACKED\n');
    wfx(fx.devRoot, '.gitignore', '.claude/forge-bin/ignored.cjs\n'); fx.g(['add', '.gitignore']); fx.g(['commit', '-q', '-m', 'ignore one tool']);
    wfx(fx.dev, 'forge-bin/ignored.cjs', 'IGNORED BY GIT\n');
    const before = snapshotTree(fx.home);
    const r = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p104a', nowIso: NOW_WP3B }));
    t('104a a dirty development tree refuses with exit 4', r.ok === false && r.refused === true && r.exitCode === 4);
    const why = r.reasons.join(' | ');
    t('104a the reason names the modified, the untracked and the git-ignored published path', /M forge-bin\/tool\.cjs/.test(why) && /\?\? forge-bin\/brand-new\.cjs/.test(why) && /!! forge-bin\/ignored\.cjs/.test(why) && /--allow-dirty/.test(why));
    t('104a nothing written: template byte-identical, no backup folder', JSON.stringify(snapshotTree(fx.home)) === JSON.stringify(before) && pubBackups(fx).length === 0);
    const r2 = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p104b', nowIso: NOW_WP3B, allowDirty: 'owner-approved hotfix window' }));
    const pv = pubJson(rfx(fx.tpl, 'template-provenance.json')), rc = pubJson(rfx(fx.tpl, 'template-publish-receipt.json'));
    t('104b --allow-dirty "<reason>" publishes and RECORDS it (provenance dirty:true, receipt reason + paths)', r2.ok === true && pv.dirty === true && rc.allowDirtyReason === 'owner-approved hotfix window' && rc.dirtyPaths.some((p) => /tool\.cjs/.test(p)));
    t('104b --allow-dirty with a too-short reason is refused', sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p104c', nowIso: NOW_WP3B, allowDirty: 'x' })).exitCode === 4);
    const fx2 = pubFixture('t104b');
    const before2 = snapshotTree(fx2.root);
    const unsafe = ['../escape', 'a/b', 'a\\b', '', 'x'.repeat(101), 'c:evil'];
    t('104c every unsafe batch id is refused with exit 4 and writes nothing', unsafe.every((id) => { const x = sync.applyPublishTemplate(pubOpts(fx2, { batchId: id, nowIso: NOW_WP3B })); return x.refused === true && x.exitCode === 4 && /batch id/.test(x.reasons.join(' ')); }) && JSON.stringify(snapshotTree(fx2.root)) === JSON.stringify(before2));
    t('104c a missing batch id is refused too', sync.applyPublishTemplate(pubOpts(fx2, { nowIso: NOW_WP3B })).exitCode === 4);
    const realR = sync.applyPublishTemplate(Object.assign(pubOpts(fx2, { batchId: 'p104d', nowIso: NOW_WP3B }), { realTemplateDir: fx2.tpl }));
    t('104d the REAL default template without --confirm-real-template: exit 4, says so, nothing written', realR.exitCode === 4 && /--confirm-real-template/.test(realR.reasons.join(' ')) && !realR.plan && JSON.stringify(snapshotTree(fx2.root)) === JSON.stringify(before2));
    const realOk = sync.applyPublishTemplate(Object.assign(pubOpts(fx2, { batchId: 'p104e', nowIso: NOW_WP3B, confirmRealTemplate: true }), { realTemplateDir: fx2.tpl }));
    t('104d ...and with the confirm flag it publishes', realOk.ok === true && realOk.exitCode === 0);
    const fxc = pubFixture('t104cli', { copyCli: true, fakeHome: true });
    const beforeC = snapshotTree(fxc.root);
    const noConfirm = runPubCli(fxc, ['--apply']);
    t('104e CLI --apply on the DEFAULT target (the fake home\'s real template) without confirm: exit 4, nothing written', noConfirm.status === 4 && /--confirm-real-template/.test(noConfirm.stdout) && JSON.stringify(snapshotTree(fxc.root)) === JSON.stringify(beforeC));
    const badId = runPubCli(fxc, ['--apply', '--template-dir', fxc.tpl, '--batch-id', '../evil']);
    t('104e CLI --apply with a traversal batch id: exit 4, nothing written', badId.status === 4 && /unsafe batch id/.test(badId.stdout) && JSON.stringify(snapshotTree(fxc.root)) === JSON.stringify(beforeC));
    t('104e CLI --plan with a traversal batch id is a usage error (exit 2)', runPubCli(fxc, ['--plan', '--batch-id', '../evil']).status === 2);
    const named = runPubCli(fxc, ['--apply', '--template-dir', fxc.tpl, '--batch-id', 'p104named']);
    t('104e naming the real template EXPLICITLY with --template-dir still needs the confirm flag (exit 4)', named.status === 4 && /--confirm-real-template/.test(named.stdout) && JSON.stringify(snapshotTree(fxc.root)) === JSON.stringify(beforeC));
    const confirmed = runPubCli(fxc, ['--apply', '--confirm-real-template', '--batch-id', 'p104cli']);
    t('104e CLI --apply --confirm-real-template publishes into the default target (exit 0)', confirmed.status === 0 && rfx(fxc.tpl, 'forge-bin/tool.cjs') === 'TOOL-V2\n');
    t('104f usage errors exit 2: --allow-dirty without a reason, --allow-dirty with --plan, two modes, an unknown flag',
      runPubCli(fxc, ['--apply', '--allow-dirty']).status === 2 && runPubCli(fxc, ['--plan', '--allow-dirty', 'some reason']).status === 2
      && runPubCli(fxc, ['--plan', '--verify']).status === 2 && runPubCli(fxc, ['--frobnicate']).status === 2);
    const fx3 = pubFixture('t104g');
    const err = (o) => { try { sync.planPublishTemplate(o); return null; } catch (e) { return e.message; } };
    t('104g could not run: a missing template folder', /does not exist/.test(err(pubOpts(fx3, { templateDir: path.join(fx3.root, 'nope', '.claude') })) || ''));
    t('104g could not run: a template not named by its .claude folder', /\.claude folder/.test(err(pubOpts(fx3, { templateDir: fx3.home })) || ''));
    t('104g could not run: a template inside the development tree', /must not contain each other/.test(err(pubOpts(fx3, { templateDir: (fs.mkdirSync(path.join(fx3.devRoot, 'sub', '.claude'), { recursive: true }), path.join(fx3.devRoot, 'sub', '.claude')) })) || ''));
    fs.rmSync(path.join(fx3.dev, 'config', 'forge-dev-tree.json'));
    t('104g could not run: no dev-tree marker (a project or the template itself can never publish)', /not the development tree/.test(err(pubOpts(fx3)) || '') && sync.applyPublishTemplate(pubOpts(fx3, { batchId: 'p104g', nowIso: NOW_WP3B })).exitCode === 1);
    t('104g CLI: a missing template folder exits 1', runPubCli(fxc, ['--plan', '--template-dir', path.join(fxc.root, 'nope', '.claude')]).status === 1);
  }

  console.log('\n105) WP-3b a backup that does not match the template aborts BEFORE any write');
  {
    const fx = pubFixture('t105');
    const before = snapshotTree(fx.home);
    const r = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p105', nowIso: NOW_WP3B, hooks: { afterBackup: (b) => fs.writeFileSync(path.join(b, 'files', 'forge-bin', 'tool.cjs'), 'TAMPERED') } }));
    t('105a a tampered backup copy: refused (exit 4), reason names the file', r.refused === true && r.exitCode === 4 && /does not match/.test(r.reasons.join(' ')) && /forge-bin\/tool\.cjs/.test(r.reasons.join(' ')));
    t('105a the template is byte-identical (no write, no provenance, lock released)', JSON.stringify(snapshotTree(fx.home)) === JSON.stringify(before));
    const fx2 = pubFixture('t105b');
    const before2 = snapshotTree(fx2.home);
    const r2 = sync.applyPublishTemplate(pubOpts(fx2, { batchId: 'p105b', nowIso: NOW_WP3B, hooks: { afterBackup: (b) => fs.rmSync(path.join(b, 'files', 'config', 'a.json')) } }));
    t('105b a file missing from the backup: refused (exit 4), template untouched', r2.exitCode === 4 && /missing from the backup/.test(r2.reasons.join(' ')) && JSON.stringify(snapshotTree(fx2.home)) === JSON.stringify(before2));
    const fx3 = pubFixture('t105c');
    const inside = sync.applyPublishTemplate(pubOpts(fx3, { batchId: 'p105c', nowIso: NOW_WP3B, backupDir: path.join(fx3.home, 'bk') }));
    const inDev = sync.applyPublishTemplate(pubOpts(fx3, { batchId: 'p105d', nowIso: NOW_WP3B, backupDir: path.join(fx3.devRoot, 'bk') }));
    t('105c a backup folder inside the template home or the development tree is refused (exit 4)', inside.exitCode === 4 && inDev.exitCode === 4 && /outside both/.test(inside.reasons.join(' ')) && !fs.existsSync(path.join(fx3.home, 'bk')));
    const used = path.join(fx3.root, 'used-bk'); wfx(used, 'x.txt', 'occupied');
    t('105c a non-empty backup folder is refused (exit 4)', sync.applyPublishTemplate(pubOpts(fx3, { batchId: 'p105e', nowIso: NOW_WP3B, backupDir: used })).exitCode === 4);
  }

  console.log('\n106) WP-3b a failure mid-way restores every touched path from the backup and exits non-zero');
  {
    const fx = pubFixture('t106', { oldSkill: true });
    const before = pubTreeState(fx.home);
    const plan = sync.planPublishTemplate(pubOpts(fx));
    const r = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p106', nowIso: NOW_WP3B, hooks: { beforeAction: (i) => { if (i === 3) throw new Error('boom at 3'); } } }));
    t('106a fails with exit 1, restore complete', r.ok === false && r.exitCode === 1 && /boom at 3/.test(r.error) && r.restore && r.restore.ok === true && r.restore.restored.length === 3);
    t('106a the template is back EXACTLY (files AND folders — the created config/orchestration/ is gone again)', JSON.stringify(pubTreeState(fx.home)) === JSON.stringify(before));
    t('106a files this publish had created were MOVED into the backup (restore-removed), never deleted', rfx(r.backupDir, 'restore-removed/forge-bin/helper.cjs') === 'HELPER\n' && fs.existsSync(path.join(r.backupDir, 'restore-removed', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json')));
    t('106a the backup receipt records the failure and the restore', /FAILED — RESTORED/.test(pubJson(rfx(r.backupDir, 'receipt.json')).outcome));
    const last = plan.update.length + plan.add.length + plan.orphans.filter((o) => o.retirable).length + 1; // the template receipt = the last action
    const fx2 = pubFixture('t106b', { oldSkill: true });
    const before2 = pubTreeState(fx2.home);
    const r2 = sync.applyPublishTemplate(pubOpts(fx2, { batchId: 'p106b', nowIso: NOW_WP3B, hooks: { beforeAction: (i, act) => { if (i === last) { if (act.rel !== 'template-publish-receipt.json') throw new Error('unexpected order: ' + act.rel); throw new Error('boom at the receipt'); } } } }));
    t('106b failing at the very last step (the receipt) restores everything: orphans back, the moved skill folder back, provenance gone', r2.exitCode === 1 && r2.restore.ok === true && /boom at the receipt/.test(r2.error) && JSON.stringify(pubTreeState(fx2.home)) === JSON.stringify(before2) && rfx(fx2.tpl, 'forge-bin/gone.cjs') === 'GONE-V1\n' && rfx(fx2.tpl, 'skills/oldskill/SKILL.md') === '# old skill\n' && !fs.existsSync(path.join(fx2.tpl, 'template-provenance.json')));
    const fxc = pubFixture('t106cli', { copyCli: true });
    const beforeC = pubTreeState(fxc.home);
    const c = runPubCli(fxc, ['--apply', '--template-dir', fxc.tpl, '--batch-id', 'p106cli'], { FORGE_SYNC_TEST_PUBLISH_FAIL_AT: '2' });
    t('106c CLI: a failure mid-way exits 1 (non-zero), says every touched path is back, and the template is identical', c.status === 1 && /APPLY FAILED/.test(c.stdout) && /every touched path is back/.test(c.stdout) && JSON.stringify(pubTreeState(fxc.home)) === JSON.stringify(beforeC));
  }

  console.log('\n107) WP-3b orphans are MOVED into the backup (hash-gated), never deleted');
  {
    const fx = pubFixture('t107', { stray: true, edited: true, oldSkill: true });
    const r = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p107', nowIso: NOW_WP3B }));
    t('107a apply succeeds but --verify is red (exit 3): two unproven orphans stay', r.ok === true && r.exitCode === 3 && r.verify.ok === false && JSON.stringify((r.verify.differences.find((d) => d.kind === 'orphan') || {}).paths) === JSON.stringify(['forge-bin/gone2.cjs', 'forge-bin/stray.cjs']));
    t('107b the proven orphans are gone from the template...', !fs.existsSync(path.join(fx.tpl, 'forge-bin', 'gone.cjs')) && !fs.existsSync(path.join(fx.tpl, 'skills', 'oldskill', 'SKILL.md')));
    t('107b ...and sit byte-identical in <backup>/retired-orphans (a move, not a delete)', rfx(r.backupDir, 'retired-orphans/forge-bin/gone.cjs') === 'GONE-V1\n' && rfx(r.backupDir, 'retired-orphans/skills/oldskill/SKILL.md') === '# old skill\n');
    t('107b the emptied skill folder is removed (only because it was empty)', !fs.existsSync(path.join(fx.tpl, 'skills', 'oldskill')) && fs.existsSync(path.join(fx.tpl, 'skills', 'demo')));
    t('107c the unproven orphans are kept byte-identical', rfx(fx.tpl, 'forge-bin/stray.cjs') === 'STRAY\n' && rfx(fx.tpl, 'forge-bin/gone2.cjs') === 'GONE2-EDITED\n');
    const rc = pubJson(rfx(fx.tpl, 'template-publish-receipt.json'));
    t('107c the receipt lists what moved and what was kept, with the reason', JSON.stringify(rc.orphansMoved) === JSON.stringify(['forge-bin/gone.cjs', 'skills/oldskill/SKILL.md']) && rc.orphansKept.map((k) => k.rel).join(',') === 'forge-bin/gone2.cjs,forge-bin/stray.cjs' && rc.orphansKept.every((k) => /kept/.test(k.reason)));
    const abs = path.join(fx.tpl, 'forge-bin', 'stray.cjs'), h = sync.sha256(abs);
    t('107d proof by the previous publish receipt (recorded hash = current bytes)', sync.proveTemplateOrphan('forge-bin/stray.cjs', abs, h, { 'forge-bin/stray.cjs': h }, null).by === 'publish-receipt');
    t('107d a recorded-but-changed file without a git match is NOT proven', (() => { const p = sync.proveTemplateOrphan('forge-bin/stray.cjs', abs, h, { 'forge-bin/stray.cjs': 'f'.repeat(64) }, null); return p.proven === false && /changed since the last publish/.test(p.reason); })());
    fs.rmSync(path.join(fx.dev, 'forge-bin', 'helper.cjs')); fx.g(['add', '-A']); fx.g(['commit', '-q', '-m', 'drop helper']);
    const p2 = sync.planPublishTemplate(pubOpts(fx));
    const helper = p2.orphans.find((o) => o.rel === 'forge-bin/helper.cjs') || {};
    t('107e the next publish proves a file IT published via its own receipt', helper.retirable === true && helper.provenBy === 'publish-receipt');
    const fx2 = pubFixture('t107f', { stray: true, edited: true });
    const memBefore = rfx(fx2.tpl, 'FORGE_MEMORY.md');
    t('107f --retire-unproven-orphans needs a real reason (refused, exit 4)', sync.applyPublishTemplate(pubOpts(fx2, { batchId: 'p107x', nowIso: NOW_WP3B, retireUnprovenOrphans: 'x' })).exitCode === 4);
    const r2 = sync.applyPublishTemplate(pubOpts(fx2, { batchId: 'p107f', nowIso: NOW_WP3B, retireUnprovenOrphans: 'owner: junk copies from the old hand refresh' }));
    const rc2 = pubJson(rfx(fx2.tpl, 'template-publish-receipt.json'));
    t('107f with --retire-unproven-orphans "<reason>" the unproven ones are MOVED too, and --verify turns green (exit 0)', r2.ok === true && r2.exitCode === 0 && rfx(r2.backupDir, 'retired-orphans/forge-bin/stray.cjs') === 'STRAY\n' && rfx(r2.backupDir, 'retired-orphans/forge-bin/gone2.cjs') === 'GONE2-EDITED\n' && !fs.existsSync(path.join(fx2.tpl, 'forge-bin', 'stray.cjs')));
    t('107f ...recorded in the receipt with the reason; foreign files still untouched', rc2.retireUnprovenReason === 'owner: junk copies from the old hand refresh' && rc2.orphansMovedUnproven.map((x) => x.rel).join(',') === 'forge-bin/gone2.cjs,forge-bin/stray.cjs' && rfx(fx2.tpl, 'FORGE_MEMORY.md') === memBefore);
    t('107f the flag is --apply only (usage error with --plan)', sync.parsePublishTemplateArgs(['--plan', '--retire-unproven-orphans', 'some reason']).error !== null && sync.parsePublishTemplateArgs(['--apply', '--retire-unproven-orphans', 'some reason']).retireUnprovenOrphans === 'some reason');
  }

  console.log('\n108) WP-3b template-provenance.json and the receipt');
  {
    const fx = pubFixture('t108');
    const r = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p108', nowIso: NOW_WP3B }));
    const pv = pubJson(rfx(fx.tpl, 'template-provenance.json'));
    t('108a provenance has exactly {batch, devCommit, dirty, fileCount, manifestSha256, publishedAt}', !!pv && JSON.stringify(Object.keys(pv).sort()) === JSON.stringify(['batch', 'devCommit', 'dirty', 'fileCount', 'manifestSha256', 'publishedAt']));
    t('108a ...with the real values: dev HEAD, clean, 9 files, the dev manifest hash, the time, the batch', pv.devCommit === fx.head && pv.dirty === false && pv.fileCount === 9 && pv.manifestSha256 === sync.sha256(path.join(fx.dev, 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json')) && pv.publishedAt === NOW_WP3B && pv.batch === 'p108');
    const tp = sync.templateProvenance(fx.tpl);
    t('108b forge-sync\'s own provenance reader picks it up (what install records as devCommitTo)', tp.source === 'template-provenance.json' && tp.devCommit === fx.head && tp.dirty === false);
    const proj = freshDir('t108-proj'); fs.mkdirSync(path.join(proj, '.claude'));
    t('108b a project synced from this template would record devCommitTo = the published commit', sync.provenanceFor(fx.tpl, proj).devCommitTo === fx.head);
    const rc = pubJson(rfx(fx.tpl, 'template-publish-receipt.json'));
    t('108c the template receipt: schema, batch, and every published file with its hash', rc.schema === 'forge-sync-publish-template-receipt/v1' && rc.batch === 'p108' && JSON.stringify(Object.keys(rc.files).sort()) === JSON.stringify(PUB_SET) && PUB_SET.every((rel) => rc.files[rel] === sync.sha256(path.join(fx.dev, rel))));
    t('108c the backup receipt says PUBLISHED and points at its own backup', pubJson(rfx(r.backupDir, 'receipt.json')).outcome === 'PUBLISHED' && pubJson(rfx(r.backupDir, 'receipt.json')).backupDir === r.backupDir);
    t('108d the publish bookkeeping is never shipped to a project (never-touch floor; not in the template\'s system list)', sync.isNeverTouch('template-provenance.json') && sync.isNeverTouch('template-publish-receipt.json') && !sync.listSystemFiles(fx.tpl).some((f) => /^template-/.test(f)));
  }

  console.log('\n109) WP-3b a second --apply with nothing new is a no-op: zero changes');
  {
    const fx = pubFixture('t109');
    const r1 = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p109a', nowIso: NOW_WP3B }));
    const after1 = snapshotTree(fx.home);
    const r2 = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p109b', nowIso: '2026-10-10T16:00:00.000Z' }));
    t('109a the second apply: ok, noop, exit 0, zero add/update/orphan', r1.ok === true && r2.ok === true && r2.noop === true && r2.exitCode === 0 && r2.plan.add.length === 0 && r2.plan.update.length === 0 && r2.plan.orphans.length === 0);
    t('109a zero changes: the template (incl. provenance + receipt) byte-identical, no second backup', JSON.stringify(snapshotTree(fx.home)) === JSON.stringify(after1) && pubBackups(fx).length === 1);
    wfx(fx.devRoot, 'docs/notes.md', 'not published\n'); fx.g(['add', '-A']); fx.g(['commit', '-q', '-m', 'docs only']);
    const head2 = fx.g(['rev-parse', 'HEAD']).stdout.trim();
    const r3 = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p109c', nowIso: '2026-10-10T17:00:00.000Z' }));
    t('109b a new dev commit with identical files: no file changes, but the provenance moves to the new commit', r3.ok === true && !r3.noop && r3.applied.added.length === 0 && r3.applied.updated.length === 0 && pubJson(rfx(fx.tpl, 'template-provenance.json')).devCommit === head2);
    const fxc = pubFixture('t109cli', { copyCli: true });
    runPubCli(fxc, ['--apply', '--template-dir', fxc.tpl, '--batch-id', 'p109cli1']);
    const second = runPubCli(fxc, ['--apply', '--template-dir', fxc.tpl, '--batch-id', 'p109cli2']);
    t('109c CLI second apply: exit 0, "nothing to publish"', second.status === 0 && /nothing to publish/.test(second.stdout));
  }

  console.log('\n110) WP-3b hints, the never-publish floor, the manifest, isolation');
  {
    t('110a the refusal text points at publish-template --plan', /publish-template --plan/.test(sync.missingInTemplateReason({ missingBlocking: [{ rel: 'config/REQUIRED.json' }] })));
    const tpl = freshDir('t110-tpl');
    writeTplManifest(tpl, [SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync'), SHIP_RULE('.claude/config/REQUIRED.json', 'ship-sync')]);
    wfx(tpl, 'forge-bin/tool.cjs', 'TOOL');
    const p = makeProject(freshDir('t110-root'), 'proj', 0);
    const st = runCLIWithTemplate(['status', p], tpl);
    t('110b status on an incomplete template names publish-template --plan as the fix (head line + the missing list)', st.status === 1 && /TEMPLATE INCOMPLETE.*publish-template --plan/.test(st.stdout) && /publish-template --plan/.test(st.stderr));
    const dry = runCLIWithTemplate(['install', p, '--dry-run'], tpl);
    t('110b install --dry-run (the preflight view) names it too', dry.status === 1 && /publish-template --plan/.test(dry.stdout + dry.stderr));
    const hostile = PUB_RULES.filter((r) => r.pattern !== '.claude/config/forge-dev-tree.json'); // config/** now claims the marker
    const fx = pubFixture('t110-hostile', { rules: hostile });
    const src = sync.publishSourceSet(fx.dev);
    t('110c a manifest that claims the dev-tree marker ship-sync still never publishes it (reported, not shipped)', !src.files.has('config/forge-dev-tree.json') && src.claimed.some((c) => c.rel === 'config/forge-dev-tree.json'));
    const rh = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p110', nowIso: NOW_WP3B }));
    t('110c ...the published template has no dev-tree marker', rh.ok === true && !fs.existsSync(path.join(fx.tpl, 'config', 'forge-dev-tree.json')));
    const shipcheck110 = require(path.join(path.dirname(CLI), 'forge-shipcheck.cjs'));
    const real110 = shipcheck110.loadManifest(sync.OWN_SHIP_MANIFEST);
    const cls = (p) => { const r = shipcheck110.classify(real110.rules, p); return r ? r.class : null; };
    t('110d the real manifest classifies the per-batch sync report per-project (never shipped)', cls('.claude/forge-sync-report-b1.md') === 'per-project' && sync.isNeverTouch('forge-sync-report-b1.md'));
    t('110e every publish fixture template lived under os.tmpdir(), never at the real central template', PUB_TEMPLATES_USED.length > 0 && PUB_TEMPLATES_USED.every((d) => path.resolve(d).startsWith(path.resolve(os.tmpdir())) && path.resolve(d).toLowerCase() !== path.resolve(sync.defaultRealTemplateDir()).toLowerCase()));
  }
}

console.log('\n111) WP-2c part 2a: doctor timeout default, the lock body (pid + batch + started_at), lock held for the whole batch, lock-status');
{
  t('111a the default doctor timeout is at least 900 s (the real doctor needs about 7-10 minutes)', sync.DEFAULT_DOCTOR_TIMEOUT_MS >= 900000);
  const srcText = fs.readFileSync(CLI, 'utf8');
  t('111a ...and runValidation really uses it (no other hard-coded default left)', /doctorTimeoutMs : DEFAULT_DOCTOR_TIMEOUT_MS/.test(srcText) && !/doctorTimeoutMs : 180000/.test(srcText));

  const d = freshDir('t111-lock');
  const acq = sync.acquireLock(d, { batchId: 'b111' });
  const body = JSON.parse(fs.readFileSync(sync.lockPathFor(d), 'utf8'));
  t('111b the lock holds pid, batch_id and started_at (and the legacy ts)', acq.ok && body.pid === process.pid && body.batch_id === 'b111' && typeof body.started_at === 'string' && body.ts === body.started_at);
  // the lock now also carries a random ownership nonce, so only the run that took it can release
  // it. Still no secret in it: the nonce is random hex with no meaning outside this one lock file.
  t('111b the lock body carries nothing else (pid, batch, times and a random ownership nonce)', Object.keys(body).sort().join(',') === 'batch_id,nonce,pid,started_at,ts' && /^[0-9a-f]{32}$/.test(body.nonce) && body.nonce === acq.nonce);
  sync.releaseLock(acq);
  const acq2 = sync.acquireLock(d, { batchId: '../evil id' });
  t('111b an unsafe batch id is never written into the lock (null instead)', JSON.parse(fs.readFileSync(sync.lockPathFor(d), 'utf8')).batch_id === null);
  sync.releaseLock(acq2);

  // the lock exists while the batch runs (the doctor runs AFTER the files were written) and is gone afterwards
  const tpl = freshDir('t111-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const sideDir = freshDir('t111-side');
  const recordLock = (p, side) => 'try { require("fs").writeFileSync(' + JSON.stringify(side) + ', require("fs").readFileSync(' + JSON.stringify(sync.lockPathFor(sync.claudeDirOf(p))) + ', "utf8")); } catch (e) { require("fs").writeFileSync(' + JSON.stringify(side) + ', "NO-LOCK"); }';
  const pOk = makeProject(freshDir('t111-root'), 'proj', null);
  const sideOk = path.join(sideDir, 'ok.txt');
  writeDoctorStub(pOk, 0, recordLock(pOk, sideOk));
  const rOk = runCLIWithTemplate(['install', pOk, '--batch-id', 'b111ok'], tpl);
  const seenOk = fs.existsSync(sideOk) ? fs.readFileSync(sideOk, 'utf8') : 'NOT-RUN';
  let seenOkBody = null; try { seenOkBody = JSON.parse(seenOk); } catch { seenOkBody = null; }
  t('111c a real install holds the lock while it validates the written files (pid + batch id inside)', rOk.status === 0 && seenOkBody && seenOkBody.batch_id === 'b111ok' && Number.isInteger(seenOkBody.pid) && !!seenOkBody.started_at);
  t('111c ...and removes it when it is done', !fs.existsSync(sync.lockPathFor(sync.claudeDirOf(pOk))));

  const pBad = makeProject(freshDir('t111-root-bad'), 'proj', null);
  const sideBad = path.join(sideDir, 'bad.txt');
  const toolInBad = path.join(pBad, '.claude', 'forge-bin', 'tool.cjs');
  const failJson = JSON.stringify({ ok: false, checks: { node_check: { ok: false, total: 50, failed: 1 }, tests: { ok: false, suites: 5, passed: 20, failed: 1 } } });
  writeDoctorStub(pBad, 0, 'if (require("fs").existsSync(' + JSON.stringify(toolInBad) + ')) { ' + recordLock(pBad, sideBad) + ' console.log(' + JSON.stringify(failJson) + '); process.exit(1); }');
  const rBad = runCLIWithTemplate(['install', pBad, '--batch-id', 'b111bad'], tpl);
  let seenBad = null; try { seenBad = JSON.parse(fs.readFileSync(sideBad, 'utf8')); } catch { seenBad = null; }
  t('111d a failing validation rolls back (exit 1, the new file is gone) while the lock was held', rBad.status === 1 && !fs.existsSync(toolInBad) && seenBad && seenBad.batch_id === 'b111bad');
  t('111d ...and the lock is removed after the rollback too', !fs.existsSync(sync.lockPathFor(sync.claudeDirOf(pBad))));

  // lock-status: read-only
  const pS = makeProject(freshDir('t111-status'), 'proj', null);
  const lpS = sync.lockPathFor(sync.claudeDirOf(pS));
  const none = runCLI(['lock-status', pS]);
  t('111e lock-status with no lock: exit 0, says no sync is running', none.status === 0 && /no \.forge-sync\.lock/.test(none.stdout));
  fs.writeFileSync(lpS, JSON.stringify({ pid: process.pid, batch_id: 'b111s', started_at: new Date().toISOString(), ts: new Date().toISOString() }));
  const before = fs.readFileSync(lpS, 'utf8');
  const fresh = runCLI(['lock-status', pS, '--json']);
  let fj = null; try { fj = JSON.parse(fresh.stdout); } catch { fj = null; }
  t('111e a fresh lock: exit 1, fresh:true, batch + pid reported, the pid is seen as alive', fresh.status === 1 && fj && fj.fresh === true && fj.batchId === 'b111s' && fj.pid === process.pid && fj.pidAlive === true);
  t('111e lock-status never changes the lock', fs.readFileSync(lpS, 'utf8') === before);
  const plain = runCLI(['lock-status', pS]);
  t('111e plain output names maintenance mode and the batch', plain.status === 1 && /maintenance mode is on/.test(plain.stdout) && /b111s/.test(plain.stdout));
  fs.writeFileSync(lpS, JSON.stringify({ pid: 999999, ts: '2020-01-01T00:00:00.000Z' }));
  const stale = runCLI(['lock-status', pS, '--json']);
  let sj = null; try { sj = JSON.parse(stale.stdout); } catch { sj = null; }
  t('111f a lock older than 6 h: exit 0, stale:true (ignored)', stale.status === 0 && sj && sj.stale === true && sj.fresh === false);
  const st = sync.readLockStatus(sync.claudeDirOf(pS), { now: Date.parse('2020-01-01T01:00:00.000Z'), pidAlive: () => false });
  t('111f readLockStatus: one hour after started_at is fresh; a dead pid is reported, never touched', st.fresh === true && st.pidAlive === false && st.ageMs === 3600000 && fs.existsSync(lpS));
  fs.writeFileSync(lpS, 'not json');
  const cor = sync.readLockStatus(sync.claudeDirOf(pS));
  t('111f an unreadable lock body falls back to the file time (fresh, corrupt:true)', cor.present && cor.corrupt === true && cor.fresh === true && cor.startedAt === null);
  t('111g pidAlive never throws on junk input', sync.pidAlive(null) === null && sync.pidAlive(-1) === null && sync.pidAlive(process.pid) === true);
  const usage = runCLI(['lock-status']);
  t('111h lock-status without a project is a usage error (exit 2)', usage.status === 2);
}

// =====================================================================================================================
// sync safety + template publishing. One section
// per finding; each one FAILS on the code before this fix (verified by running it against the pre-fix copy).
// 112 SYNC-01 backup containment · 113 SYNC-02 rollback manifest trust · 114 SYNC-03 case-insensitive + secrets floor ·
// 115 SYNC-04 re-hash before each write · 116 SYNC-05 retire race · 117 SYNC-06 settings ownership · 118 SYNC-07 publish
// restore · 119 SYNC-08 physical template binding · 120 SYNC-09 sync-all quiesce + lock · 121 SYNC-10 lock ownership ·
// 122 SYNC-11 quiesce never skips a junction · 123 SYNC-12 unreadable + app-code guard · 124 SYNC-13 coupled delivery.
// Every fixture is an os.tmpdir() folder. Junctions: fs.symlinkSync(target, path, 'junction'); a platform that refuses
// prints a visible SKIP line for exactly the assertions it could not exercise.
// =====================================================================================================================
const NOW_R3 = '2026-10-10T18:00:00.000Z';
function r3Junction(target, linkPath, label) {
  try { fs.symlinkSync(target, linkPath, 'junction'); return true; }
  catch (e) { console.log('  SKIP ' + label + ' — this platform refused to create a junction (' + (e.code || e.message) + '); not exercised here'); return false; }
}
const r3Empty = (d) => { try { return fs.readdirSync(d).length === 0; } catch { return true; } };

console.log('\n112) R3 SYNC-01: backups are written only into REAL folders inside the project (never through a junction)');
{
  const { tpl } = tplHomeWp2c('t112-tpl', { settings: false });
  const pA = projWp2c('t112a');
  const outA = freshDir('t112a-outside');
  if (r3Junction(outA, path.join(pA, '.claude', 'forge-backups'), '112a')) {
    const r = sync.safeSyncProject(tpl, pA, { batchId: 'b112a', nowIso: NOW_R3 });
    t('112a a junctioned forge-backups/ refuses the sync (ok:false, refused) and names the junction', r.ok === false && r.refused === true && /junction|reparse/.test(r.reason || ''));
    t('112a not one byte was written outside the project, and the shipped file is still V1', r3Empty(outA) && rfx(pA, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  }
  const pB = projWp2c('t112b');
  const outB = freshDir('t112b-outside');
  fs.mkdirSync(path.join(pB, '.claude', 'forge-backups'), { recursive: true });
  if (r3Junction(outB, path.join(pB, '.claude', 'forge-backups', 'b112b'), '112b')) {
    const r = sync.safeSyncProject(tpl, pB, { batchId: 'b112b', nowIso: NOW_R3 });
    t('112b a pre-planted junction AS the batch folder refuses the sync; nothing outside, nothing applied', r.ok === false && r.refused === true && r3Empty(outB) && rfx(pB, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  }
  const pC = projWp2c('t112c');
  const outC = freshDir('t112c-outside');
  const bdirC = path.join(pC, '.claude', 'forge-backups', 'b112c');
  fs.mkdirSync(bdirC, { recursive: true });
  if (r3Junction(outC, path.join(bdirC, 'forge-bin'), '112c')) {
    const b = sync.takeBackup(pC, 'b112c', sync.buildPlan(tpl, pC, {}), 'v', NOW_R3, {});
    t('112c takeBackup refuses a junction BELOW the batch folder (clean ok:false) and writes nothing through it', b.ok === false && /junction|reparse/.test(b.error || '') && r3Empty(outC));
  }
  const pD = projWp2c('t112d');
  const outD = freshDir('t112d-outside');
  if (r3Junction(outD, path.join(pD, '.claude', 'forge-backups-central'), '112d')) {
    const r = sync.safeSyncProject(tpl, pD, { batchId: 'b112d', nowIso: NOW_R3, centralBackupRoot: sync.defaultCentralBackupRoot(pD) });
    t('112d a junctioned forge-backups-central/ (the default central root) refuses; nothing outside; nothing applied', r.ok === false && r.refused === true && /junction|reparse/.test(r.reason || '') && r3Empty(outD) && rfx(pD, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  }
  const pE = projWp2c('t112e');
  const rE = sync.safeSyncProject(tpl, pE, { batchId: 'b112e', nowIso: NOW_R3, centralBackupRoot: sync.defaultCentralBackupRoot(pE) });
  const mE = rE.backup ? JSON.parse(fs.readFileSync(path.join(rE.backup.backupDir, 'manifest.json'), 'utf8')) : null;
  t('112e a healthy install: ok, the backup holds V1, a central copy exists, and the manifest is BOUND (schema + self-hash)', rE.ok === true && rfx(rE.backup.backupDir, 'forge-bin/tool.cjs') === 'TOOL-V1'
    && !!rE.backup.centralDir && fs.existsSync(path.join(rE.backup.centralDir, 'manifest.json')) && !!mE && !!sync.BACKUP_MANIFEST_SCHEMA && mE.schema === sync.BACKUP_MANIFEST_SCHEMA && typeof sync.manifestBinding === 'function' && sync.manifestBinding(mE, pE, 'b112e').state === 'bound');
  const pF = projWp2c('t112f');
  const rF = sync.safeSyncProject(tpl, pF, { batchId: 'b112f', nowIso: NOW_R3 });
  const realB = path.join(pF, '.claude', 'forge-backups', 'b112f');
  const movedB = path.join(freshDir('t112f-moved'), 'b112f');
  fs.cpSync(realB, movedB, { recursive: true });
  fs.rmSync(realB, { recursive: true, force: true });
  if (rF.ok === true && r3Junction(movedB, realB, '112f')) {
    const rb = sync.rollbackProject(pF, 'b112f', {});
    t('112f a backup folder that is a junction is never READ for a rollback either — refused, the project stays as synced', rb.ok === false && /junction|reparse/.test(rb.reason || '') && rfx(pF, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
    fs.rmdirSync(realB);
  }
}

console.log('\n113) R3 SYNC-02: a rollback manifest is bound to its project + batch, never touches the floor, deletes only what the batch created');
{
  const { tpl } = tplHomeWp2c('t113-tpl', { settings: false });
  const bdirOf = (p, b) => path.join(p, '.claude', 'forge-backups', b);
  const readM = (p, b) => JSON.parse(fs.readFileSync(path.join(bdirOf(p, b), 'manifest.json'), 'utf8'));
  // a forger who recomputes the self-hash (on code without bound manifests: a plain rewrite, so this section still shows
  // what the PRE-fix code does with the forged entry instead of crashing on a missing helper)
  const forge = (p, b, mutate) => { const m = readM(p, b); mutate(m); if (typeof sync.writeBoundManifest === 'function') return sync.writeBoundManifest(bdirOf(p, b), m); fs.writeFileSync(path.join(bdirOf(p, b), 'manifest.json'), JSON.stringify(m)); return m; };
  const pA = projWp2c('t113a');
  const rA = sync.safeSyncProject(tpl, pA, { batchId: 'b113a', nowIso: NOW_R3 });
  const memBefore = rfx(pA, '.claude/FORGE_MEMORY.md');
  const mA = forge(pA, 'b113a', (m) => m.files.push({ rel: 'FORGE_MEMORY.md', oldHash: null, newHash: sync.sha256(path.join(pA, '.claude', 'FORGE_MEMORY.md')), existed: false }));
  const rbA = sync.rollbackProject(pA, 'b113a', {});
  t('113a a manifest naming FORGE_MEMORY.md (never-touch) is REFUSED, even with a valid self-hash: memory intact, nothing restored', rA.ok === true && rbA.ok === false && /never-touch/.test(rbA.reason || '') && rfx(pA, '.claude/FORGE_MEMORY.md') === memBefore && rfx(pA, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  const dA = sync.restoreFromManifest(pA, bdirOf(pA, 'b113a'), mA, {});
  t('113a restoreFromManifest refuses it up front too (refusedManifest), before any mutation', dA.ok === false && dA.refusedManifest === true && rfx(pA, '.claude/FORGE_MEMORY.md') === memBefore);
  t('113a case variants of the floor are refused as manifest entries as well', typeof sync.manifestEntryProblems === 'function' && sync.manifestEntryProblems({ files: [{ rel: 'forge_memory.md', oldHash: null }, { rel: 'Agent-Memory/x/MEMORY.md', oldHash: null }, { rel: '../x', oldHash: null }] }).length === 3);
  const mk = (name, old) => { const p = projWp2c(name); sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': sync.sha256(wfx(p, '.claude/forge-bin/tool.cjs', old)) } }); return p; };
  const pB1 = mk('t113b1', 'A-OLD'), pB2 = mk('t113b2', 'B-OLD');
  const r1 = sync.safeSyncProject(tpl, pB1, { batchId: 'b113b', nowIso: NOW_R3 });
  const r2 = sync.safeSyncProject(tpl, pB2, { batchId: 'b113b', nowIso: NOW_R3 });
  fs.rmSync(bdirOf(pB2, 'b113b'), { recursive: true, force: true });
  fs.cpSync(bdirOf(pB1, 'b113b'), bdirOf(pB2, 'b113b'), { recursive: true });
  const rbB = sync.rollbackProject(pB2, 'b113b', {});
  t('113b a batch folder copied from ANOTHER project is refused (bound to that project): B keeps V2, never gets A-OLD', r1.ok === true && r2.ok === true && rbB.ok === false && /belongs to project/.test(rbB.reason || '') && rfx(pB2, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  const pB3 = projWp2c('t113b3');
  sync.safeSyncProject(tpl, pB3, { batchId: 'b113x', nowIso: NOW_R3 });
  fs.renameSync(bdirOf(pB3, 'b113x'), bdirOf(pB3, 'b113y'));
  const rbB3 = sync.rollbackProject(pB3, 'b113y', {});
  t('113b a manifest filed under another batch id is refused (bound to its batch)', rbB3.ok === false && /belongs to batch/.test(rbB3.reason || '') && rfx(pB3, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  const pB4 = projWp2c('t113b4');
  sync.safeSyncProject(tpl, pB4, { batchId: 'b113t', nowIso: NOW_R3 });
  const mt = readM(pB4, 'b113t'); mt.ts = '1999-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(bdirOf(pB4, 'b113t'), 'manifest.json'), JSON.stringify(mt));
  const rbB4 = sync.rollbackProject(pB4, 'b113t', {});
  t('113b a manifest edited after it was written (self-hash mismatch) is refused', rbB4.ok === false && /self-hash/.test(rbB4.reason || '') && rfx(pB4, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  const pC = projWp2c('t113c');
  sync.safeSyncProject(tpl, pC, { batchId: 'b113c', nowIso: NOW_R3 });
  const mc = readM(pC, 'b113c'); delete mc.schema; delete mc.batch_id; delete mc.project_real; delete mc.manifest_sha256;
  fs.writeFileSync(path.join(bdirOf(pC, 'b113c'), 'manifest.json'), JSON.stringify(mc, null, 2));
  const rbC = sync.rollbackProject(pC, 'b113c', {});
  t('113c a legacy-unbound manifest (older forge-sync) is flagged and refused without --allow-legacy-manifest; nothing restored', rbC.ok === false && rbC.legacyUnbound === true && /--allow-legacy-manifest/.test(rbC.reason || '') && rfx(pC, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  const cliC = runCLI(['rollback', pC, '--batch', 'b113c', '--no-central-backup']);
  t('113c CLI rollback exits 1 on it and names the flag', cliC.status === 1 && /--allow-legacy-manifest/.test(cliC.stderr));
  const cliC2 = runCLI(['rollback', pC, '--batch', 'b113c', '--no-central-backup', '--allow-legacy-manifest']);
  t('113c with --allow-legacy-manifest it runs (exit 0, V1 back) and says the manifest was legacy-unbound', cliC2.status === 0 && rfx(pC, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && /legacy-unbound/.test(cliC2.stdout));
  const pD = projWp2c('t113d');
  const rD = sync.safeSyncProject(tpl, pD, { batchId: 'b113d', nowIso: NOW_R3 });
  const own = wfx(pD, '.claude/skills/mine/SKILL.md', '# the owner\'s own skill\n');
  forge(pD, 'b113d', (m) => m.files.push({ rel: 'skills/mine/SKILL.md', oldHash: null, newHash: sync.sha256(own), existed: false }));
  const rbD = sync.rollbackProject(pD, 'b113d', {});
  t('113d an entry for a file the batch did NOT create (no apply-journal record) is never deleted — kept and reported', rD.ok === true && rbD.ok === false && rfx(pD, '.claude/skills/mine/SKILL.md') === '# the owner\'s own skill\n' && /not proven to be created by this batch/.test(rbD.reason || ''));
  t('113d ...while the same rollback did remove what the batch DID create (journaled seeds) and restored tool.cjs', rfx(pD, '.claude/FORGE_OWNER_PROFILE.json') === null && rfx(pD, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  const jr = typeof sync.readApplyJournal === 'function' ? sync.readApplyJournal(bdirOf(pD, 'b113d')) : { present: false, created: new Set() };
  t('113d the apply journal recorded every creation of the batch', jr.present === true && jr.created.has('FORGE_OWNER_PROFILE.json') && jr.created.has('skills/demo/learnings.md'));
}

console.log('\n114) R3 SYNC-03: the never-touch floor is case-insensitive and covers env files, secrets/ and key material');
{
  const yes = ['forge_memory.md', 'Forge_Memory.MD', 'Agent-Memory/build-boss/MEMORY.md', 'FORGE-RUNS/r1/events.jsonl', 'config/FORGE-OWNER-GRANT.json',
    '.env', '.env.production', 'config/.env.local', 'secrets/token.txt', 'skills/x/Secrets/a.json', 'cert.pem', 'config/server.KEY', 'id_rsa', 'keys/id_ed25519.pub', 'store.pfx', 'client.p12', 'config/.credentials.json'];
  const no = ['.env.example', 'forge-bin/forge-secret-scrub.cjs', 'forge-bin/forge-gate-secretprint.test.cjs', 'skills/secrets-guard/SKILL.md', 'forge-bin/keymap.cjs'];
  const missed = yes.filter((r) => !sync.isNeverTouch(r)), wrong = no.filter((r) => sync.isNeverTouch(r));
  t('114a every case variant of a memory/state path and every env/secret/key name is never-touch' + (missed.length ? ' — MISSED: ' + missed.join(', ') : ''), missed.length === 0);
  t('114a ...while .env.example and tools whose names merely mention "secret"/"key" are not' + (wrong.length ? ' — WRONG: ' + wrong.join(', ') : ''), wrong.length === 0);
  t('114a a secrets/ folder is a never-touch FOLDER at any depth (the template walk never enters it)', sync.isNeverTouchDir('config/secrets') && sync.isNeverTouchDir('Secrets') && !sync.isNeverTouchDir('forge-bin'));
  const tpl = freshDir('t114-tpl');
  writeTplManifest(tpl, [SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync'), SHIP_RULE('.claude/*.md', 'ship-sync'), SHIP_RULE('.claude/config/**', 'ship-sync')]);
  wfx(tpl, 'forge-bin/tool.cjs', 'TOOL');
  wfx(tpl, 'forge_memory.md', '# TEMPLATE MEMORY (must never land)\n');
  for (const f of ['config/.env.production', 'config/secrets/token.txt', 'config/deploy.key', 'config/id_rsa']) wfx(tpl, f, 'TEMPLATE SECRET-SHAPED ' + f);
  const sp = sync.shipPlan(tpl);
  const claimed = sp.neverTouchClaimed.map((c) => c.rel);
  t('114b a hostile manifest delivers none of them (only the tool + the manifest), and reports the claims', !sp.system.some((r) => /memory|\.env|secrets|\.key$|id_rsa/i.test(r)) && sp.system.includes('forge-bin/tool.cjs') && ['forge_memory.md', 'config/.env.production', 'config/deploy.key', 'config/id_rsa'].every((r) => claimed.includes(r)));
  const p = makeProject(freshDir('t114-root'), 'proj', 0);
  wfx(p, '.claude/FORGE_MEMORY.md', '# the project\'s real memory\n');
  wfx(p, '.claude/config/.env.production', 'OWNER_SECRET=1\n');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b114', nowIso: NOW_R3, forceOverwrite: true });
  t('114b a --force-overwrite sync delivers the tool, never the case-variant memory or the secret-shaped files', r.ok === true && rfx(p, '.claude/forge-bin/tool.cjs') === 'TOOL' && rfx(p, '.claude/FORGE_MEMORY.md') === '# the project\'s real memory\n'
    && rfx(p, '.claude/config/.env.production') === 'OWNER_SECRET=1\n' && !fs.existsSync(path.join(p, '.claude', 'config', 'deploy.key')) && !fs.existsSync(path.join(p, '.claude', 'config', 'secrets')));
  t('114c caseCollisions finds two delivered paths that differ only in case', typeof sync.caseCollisions === 'function' && JSON.stringify(sync.caseCollisions(['forge-bin/a.cjs', 'forge-bin/A.cjs', 'x'])) === JSON.stringify([['forge-bin/a.cjs', 'forge-bin/A.cjs']]) && sync.caseCollisions(['a', 'b']).length === 0);
  // (d) the protect inventory compares case-insensitively too: a project file that differs from a shipped path only in case
  // IS that shipped file on Windows/macOS — it must not be inventoried as "protected" (a false violation that blocks the sync)
  const probeCase = freshDir('t114d-probe'); fs.writeFileSync(path.join(probeCase, 'a.txt'), 'x');
  if (!fs.existsSync(path.join(probeCase, 'A.TXT'))) console.log('  SKIP 114d — this file system is case-sensitive: two spellings are two files there, nothing to fold');
  else {
    const { tpl: td } = tplHomeWp2c('t114d-tpl', { settings: false });
    const pd = projWp2c('t114d');
    fs.renameSync(path.join(pd, '.claude', 'forge-bin', 'tool.cjs'), path.join(pd, '.claude', 'forge-bin', 'TOOL.cjs')); // same bytes (TOOL-V1), other spelling
    const md = sync.buildProtectManifest(td, pd, {});
    t('114d the protect inventory folds case: forge-bin/TOOL.cjs is the shipped forge-bin/tool.cjs, not a protected file', !Object.keys(md.entries).some((k) => /forge-bin\/tool\.cjs$/i.test(k)));
    t('114d ...and the bookkeeping allowance does too (.claude/Settings.json is settings.json)', sync.protectAllowance('.claude/Settings.json') === 'any' && sync.protectAllowance('.claude/forge_version.json') === 'any');
    const rd = sync.safeSyncProject(td, pd, { batchId: 'b114d', nowIso: NOW_R3 });
    t('114d end to end: the sync updates the case-variant file and passes the protect re-check (no false violation)', rd.ok === true && !!rd.protect && rd.protect.ok === true && /TOOL-V2/.test(fs.readFileSync(path.join(pd, '.claude', 'forge-bin', 'tool.cjs'), 'utf8')));
  }
  const tc = freshDir('t114c-tpl'); wfx(tc, 'forge-bin/a.cjs', 'lower'); wfx(tc, 'forge-bin/A.cjs', 'UPPER');
  if (fs.readdirSync(path.join(tc, 'forge-bin')).length < 2) console.log('  SKIP 114c (template level) — this file system ignores case, so one template folder cannot even hold both names');
  else t('114c shipPlan refuses a template holding both spellings', (() => { try { sync.shipPlan(tc); return false; } catch (e) { return /differ only in case/.test(e.message); } })());
}

console.log('\n115) R3 SYNC-04: source and destination are re-hashed right before each write — a change since planning is skipped, never overwritten');
{
  const { tpl } = tplHomeWp2c('t115-tpl', { settings: false });
  const pA = projWp2c('t115a');
  const planA = sync.buildPlan(tpl, pA, {});
  t('115a (the plan creates the seed FORGE_OWNER_PROFILE.json)', planA.toChange.some((e) => e.rel === 'FORGE_OWNER_PROFILE.json' && e.oldHash === null));
  wfx(pA, '.claude/FORGE_OWNER_PROFILE.json', '{"owner":"created by the owner meanwhile"}\n');
  const aA = sync.applyPlanSafely(tpl, pA, planA);
  t('115a a seed created between plan and write is SKIPPED (needsReview) and the owner\'s file is byte-identical', (aA.skipped || []).some((s) => s.rel === 'FORGE_OWNER_PROFILE.json') && aA.needsReview === true && rfx(pA, '.claude/FORGE_OWNER_PROFILE.json') === '{"owner":"created by the owner meanwhile"}\n');
  const pB = projWp2c('t115b');
  const planB = sync.buildPlan(tpl, pB, {});
  wfx(pB, '.claude/forge-bin/tool.cjs', 'EDITED AFTER THE PLAN');
  const aB = sync.applyPlanSafely(tpl, pB, planB);
  t('115b an update target edited between plan and write is skipped; the edit survives', (aB.skipped || []).some((s) => s.rel === 'forge-bin/tool.cjs' && /changed since the plan/.test(s.reason)) && rfx(pB, '.claude/forge-bin/tool.cjs') === 'EDITED AFTER THE PLAN');
  const t2 = tplHomeWp2c('t115c-tpl', { settings: false }).tpl;
  const pC = projWp2c('t115c');
  const planC = sync.buildPlan(t2, pC, {});
  wfx(t2, 'forge-bin/tool.cjs', 'TOOL-V3-UNPLANNED');
  const aC = sync.applyPlanSafely(t2, pC, planC);
  t('115c a template file changed since the plan stops the apply; its unplanned bytes are never written', aC.ok === false && /template changed since the plan/.test(aC.error || '') && rfx(pC, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  const pD = projWp2c('t115d', { doctorExit: null });
  const seed = path.join(pD, '.claude', 'FORGE_OWNER_PROFILE.json');
  const ownerSeed = '{"owner":"made during the pre-sync doctor"}\n';
  writeDoctorStub(pD, 0, 'if (!require("fs").existsSync(' + JSON.stringify(seed) + ')) require("fs").writeFileSync(' + JSON.stringify(seed) + ', ' + JSON.stringify(ownerSeed) + ');');
  const rD = sync.safeSyncProject(tpl, pD, { batchId: 'b115d', nowIso: NOW_R3 });
  t('115d end to end: the sync stops with NEEDS REVIEW (ok:false, refusedChangedSincePlan) naming the file', rD.ok === false && rD.needsReview === true && rD.refusedChangedSincePlan === true && (rD.skippedChangedSincePlan || []).some((s) => s.rel === 'FORGE_OWNER_PROFILE.json') && /NEEDS REVIEW/.test(rD.reason || ''));
  t('115d the owner\'s file is untouched; everything the batch wrote was rolled back (tool V1, no learnings seed)', rfx(pD, '.claude/FORGE_OWNER_PROFILE.json') === ownerSeed && rfx(pD, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && rfx(pD, '.claude/skills/demo/learnings.md') === null && rD.rolledBack === true);
  t('115d no version stamp; the change report says NEEDS REVIEW; the apply journal records the skip', !fs.existsSync(sync.versionFilePath(pD)) && /NEEDS REVIEW/.test(rfx(pD, '.claude/forge-sync-report-b115d.md') || '') && typeof sync.readApplyJournal === 'function' && sync.readApplyJournal(path.join(pD, '.claude', 'forge-backups', 'b115d')).skipped.has('FORGE_OWNER_PROFILE.json'));
  const rbD = sync.rollbackProject(pD, 'b115d', {});
  t('115d a later explicit rollback of that batch never touches the file the batch skipped', rfx(pD, '.claude/FORGE_OWNER_PROFILE.json') === ownerSeed && rbD.ok === true && (rbD.notWritten || []).includes('FORGE_OWNER_PROFILE.json'));
}

console.log('\n116) R3 SYNC-05: an orphan / retired file that changes right before its removal is kept, never deleted');
{
  const tpl = freshDir('t116-tpl');
  writeTplManifest(tpl, [SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync')]);
  wfx(tpl, 'forge-bin/keep.cjs', 'KEEP');
  const p = makeProject(freshDir('t116-root'), 'proj', 0);
  const h = (rel, body) => sync.sha256(wfx(p, '.claude/' + rel, body));
  sync.writeReceipt(p, { knownHashes: { 'forge-bin/keep.cjs': h('forge-bin/keep.cjs', 'KEEP'), 'forge-bin/old.cjs': h('forge-bin/old.cjs', 'OLD as shipped') } });
  const rep = sync.findOrphans(p, sync.shipPlan(tpl));
  const ro = sync.retireOrphans(p, rep, { batchId: 'b116', __beforeRemove: (rel, live) => fs.writeFileSync(live, 'EDITED IN THE RACE WINDOW') });
  t('116a an orphan whose bytes change after its backup was verified is KEPT (changed-since-plan), never deleted', ro.moved.length === 0 && (ro.kept || []).some((k) => k.rel === 'forge-bin/old.cjs' && /changed-since-plan/.test(k.reason)) && rfx(p, '.claude/forge-bin/old.cjs') === 'EDITED IN THE RACE WINDOW');
  const led = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'forge-backups', 'b116', sync.RETIRED_ORPHANS_MANIFEST_NAME), 'utf8'));
  t('116a ...it is taken out of the rollback ledger again, and no quarantine temp file is left', !led.files.some((f) => f.rel === 'forge-bin/old.cjs') && fs.readdirSync(path.join(p, '.claude', 'forge-bin')).every((n) => !/forge-quarantine/.test(n)));
  if (typeof sync.quarantineAndVerify !== 'function') t('116b quarantineAndVerify exists', false);
  else {
    const qd = freshDir('t116b');
    const f = path.join(qd, 'x.txt'); fs.writeFileSync(f, 'NOW');
    const q1 = sync.quarantineAndVerify(f, sync.sha256(f));
    t('116b quarantineAndVerify removes bytes that equal the verified hash', q1.removed === true && !fs.existsSync(f));
    fs.writeFileSync(f, 'NEWER');
    const q2 = sync.quarantineAndVerify(f, 'f'.repeat(64));
    t('116b ...and puts differing bytes back under the original name', q2.removed === false && q2.keptAt === f && fs.readFileSync(f, 'utf8') === 'NEWER');
  }
  if (!PUB_GIT_OK) console.log('  SKIP 116c: git is not available here — publish-template needs a git development tree');
  else {
    const fx = pubFixture('t116c');
    const before = pubTreeState(fx.home);
    const r = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p116c', nowIso: NOW_R3, hooks: { beforeOrphanRemove: (rel, live) => { if (rel === 'forge-bin/gone.cjs') fs.writeFileSync(live, 'EDITED DURING THE PUBLISH\n'); } } }));
    t('116c publish-template aborts (exit 1) instead of removing an orphan that changed in the move window', r.ok === false && r.exitCode === 1 && /changed-since-plan/.test(r.error || ''));
    t('116c the orphan keeps the newer bytes and the restore of everything else is complete', rfx(fx.tpl, 'forge-bin/gone.cjs') === 'EDITED DURING THE PUBLISH\n' && !!r.restore && r.restore.ok === true);
    const after = pubTreeState(fx.home);
    const goneKey = path.join(fx.tpl, 'forge-bin', 'gone.cjs');
    delete after[goneKey]; delete before[goneKey];
    t('116c apart from that orphan the template is back exactly as it was', JSON.stringify(after) === JSON.stringify(before));
  }
}

console.log('\n117) R3 SYNC-06: a refused settings merge never takes ownership of settings.json; rollback restores only what this sync applied');
{
  const { tpl } = tplHomeWp2c('t117-tpl');
  const ledgerOf = (p, b) => JSON.parse(fs.readFileSync(path.join(p, '.claude', 'forge-backups', b, sync.SETTINGS_LEDGER_NAME), 'utf8'));
  const pA = projWp2c('t117a');
  const sA = path.join(pA, '.claude', 'settings.json');
  fs.writeFileSync(sA, OWNER_SETTINGS_BYTES);
  const OWNER_EDIT = '{ "the owner edited this while the merge ran": true, '; // invalid JSON on purpose: the real merge must refuse
  const m = sync.mergeSettingsForBatch(tpl, pA, 'b117a', { nowIso: NOW_R3, __afterPreview: () => fs.writeFileSync(sA, OWNER_EDIT) });
  const ledA = ledgerOf(pA, 'b117a');
  t('117a the merge was refused and the owner\'s edit is left as it is', m.ok === false && m.status === 'refused' && fs.readFileSync(sA, 'utf8') === OWNER_EDIT);
  t('117a the ledger records a NO-OP with no postHash (this batch never owned settings.json)', ledA.status === 'no-op' && ledA.applied === false && ledA.postHash === null);
  const rbA = sync.restoreSettingsLedger(pA, 'b117a', { forceRollbackNewer: true });
  t('117a rollback leaves the owner\'s bytes alone — even with --force-rollback-newer', rbA.ok === true && /not applied/.test(rbA.action) && fs.readFileSync(sA, 'utf8') === OWNER_EDIT);
  const pB = projWp2c('t117b');
  const sB = path.join(pB, '.claude', 'settings.json');
  fs.writeFileSync(sB, OWNER_SETTINGS_BYTES);
  sync.mergeSettingsForBatch(tpl, pB, 'b117b', { nowIso: NOW_R3 });
  fs.writeFileSync(sB, 'OWNER BYTES AFTER A REFUSED MERGE');
  const lp = path.join(pB, '.claude', 'forge-backups', 'b117b', sync.SETTINGS_LEDGER_NAME);
  const oldLedger = JSON.parse(fs.readFileSync(lp, 'utf8')); delete oldLedger.applied; delete oldLedger.mergeStatus; oldLedger.status = 'refused'; oldLedger.postHash = sync.sha256(sB);
  fs.writeFileSync(lp, JSON.stringify(oldLedger));
  const rbB = sync.restoreSettingsLedger(pB, 'b117b', {});
  t('117b a ledger written by the PREVIOUS code for a refused merge (postHash = the owner\'s bytes) never restores over them', rbB.ok === true && fs.readFileSync(sB, 'utf8') === 'OWNER BYTES AFTER A REFUSED MERGE');
  const pC = projWp2c('t117c');
  const sC = path.join(pC, '.claude', 'settings.json');
  fs.writeFileSync(sC, OWNER_SETTINGS_BYTES);
  const rC = sync.safeSyncProject(tpl, pC, { batchId: 'b117c', nowIso: NOW_R3 });
  const ledC = ledgerOf(pC, 'b117c');
  t('117c an applied merge: status merged, applied:true, postHash = exactly the bytes it left on disk', rC.ok === true && ledC.status === 'merged' && ledC.applied === true && ledC.postHash === sync.sha256(sC));
  fs.writeFileSync(sC, fs.readFileSync(sC, 'utf8').replace('"keep me"', '"owner edit after the sync"'));
  const rbC = sync.rollbackProject(pC, 'b117c', {});
  t('117c a settings conflict refuses the rollback UP FRONT: not one file restored (tool still V2), settings kept', rbC.ok === false && /nothing was restored/.test(rbC.reason || '') && rfx(pC, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && /owner edit after the sync/.test(fs.readFileSync(sC, 'utf8')));
  const pD = projWp2c('t117d');
  const rD = sync.safeSyncProject(tpl, pD, { batchId: 'b117d', nowIso: NOW_R3 });
  const ledD = ledgerOf(pD, 'b117d');
  t('117d a settings.json this sync CREATED: postHash = the hash of exactly the text the merge tool wrote', rD.ok === true && ledD.status === 'created' && ledD.postHash === sync.sha256(path.join(pD, '.claude', 'settings.json')));
}

if (!PUB_GIT_OK) console.log('\n118-119) SKIP: git is not available here — publish-template needs a git development tree; NOT exercised');
else {
  console.log('\n118) R3 SYNC-07: a failed publish restores only files that still hold what it wrote — a newer edit is never overwritten');
  {
    const fx = pubFixture('t118');
    const plan = sync.planPublishTemplate(pubOpts(fx));
    t('118 (fixture: action 0 updates forge-bin/tool.cjs, action 1 adds ' + (plan.add[0] && plan.add[0].rel) + ')', plan.update.length === 1 && plan.update[0].rel === 'forge-bin/tool.cjs' && plan.add.length > 0);
    const r = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p118', nowIso: NOW_R3, hooks: { beforeAction: (i) => { if (i === 2) { fs.writeFileSync(path.join(fx.tpl, 'forge-bin', 'tool.cjs'), 'OWNER EDIT AFTER THE PUBLISH WROTE IT\n'); throw new Error('boom at 2'); } } } }));
    t('118a the publish fails (exit 1); the restore is NOT ok and names tool.cjs changed-since-publish', r.ok === false && r.exitCode === 1 && !!r.restore && r.restore.ok === false && r.restore.changedSincePublish.includes('forge-bin/tool.cjs'));
    t('118a the owner\'s newer edit is KEPT, never replaced by the backup copy', rfx(fx.tpl, 'forge-bin/tool.cjs') === 'OWNER EDIT AFTER THE PUBLISH WROTE IT\n');
    t('118a the other started action (a file it created and that still holds its bytes) was undone', !fs.existsSync(path.join(fx.tpl, ...plan.add[0].rel.split('/'))));
  }

  console.log('\n119) R3 SYNC-08: --confirm-real-template is bound to the PHYSICAL folder; a junction retargeted mid-publish never reaches the real template');
  {
    const fxD = pubFixture('t119-decoy'), fxR = pubFixture('t119-real');
    const realBefore = pubTreeState(fxR.home);
    const alias = path.join(fxD.root, 'alias');
    if (r3Junction(fxD.home, alias, '119a')) {
      const r = sync.applyPublishTemplate({ devDir: fxD.dev, templateDir: path.join(alias, '.claude'), realTemplateDir: fxR.tpl, batchId: 'p119a', nowIso: NOW_R3,
        hooks: { beforeAction: (i) => { if (i === 0) { fs.rmdirSync(alias); fs.symlinkSync(fxR.home, alias, 'junction'); } } } });
      t('119a the alias was retargeted at the REAL template after all checks — the real template is byte-identical', JSON.stringify(pubTreeState(fxR.home)) === JSON.stringify(realBefore));
      t('119a every write went into the pinned physical folder (the decoy), and the result says the requested path moved', r.ok === true && rfx(fxD.tpl, 'forge-bin/tool.cjs') === 'TOOL-V2\n' && r.requestedRetargeted === true && sync.foldCase(r.templateDirPhysical) === sync.foldCase(fs.realpathSync.native(fxD.tpl)));
      fs.rmdirSync(alias);
    }
    const alias2 = path.join(fxR.root, 'alias2');
    if (r3Junction(fxR.home, alias2, '119b')) {
      const before = pubTreeState(fxR.home);
      const rb = sync.applyPublishTemplate({ devDir: fxR.dev, templateDir: path.join(alias2, '.claude'), realTemplateDir: fxR.tpl, batchId: 'p119b', nowIso: NOW_R3 });
      t('119b a path that RESOLVES to the real template needs --confirm-real-template (exit 4, both paths named, nothing written)', rb.exitCode === 4 && /--confirm-real-template/.test((rb.reasons || []).join(' ')) && /resolves to/.test((rb.reasons || []).join(' ')) && JSON.stringify(pubTreeState(fxR.home)) === JSON.stringify(before));
      const rc = sync.applyPublishTemplate({ devDir: fxR.dev, templateDir: path.join(alias2, '.claude'), realTemplateDir: fxR.tpl, batchId: 'p119c', nowIso: NOW_R3, confirmRealTemplate: true });
      const rec = pubJson(rfx(fxR.tpl, 'template-publish-receipt.json'));
      t('119c with the flag it publishes, and the receipt records the requested AND the physical path', rc.ok === true && !!rec && rec.templateDirRequested === path.join(alias2, '.claude')
        && sync.foldCase(rec.templateDirPhysical) === sync.foldCase(fs.realpathSync.native(fxR.tpl)) && rec.realTemplate === true && rec.confirmRealTemplate === true);
      fs.rmdirSync(alias2);
    }
  }
}

console.log('\n120) R3 SYNC-09: sync-all proves every real project idle like install does, and its --unsafe branch runs under the project lock');
{
  const mkRoot = (name) => {
    const tpl = freshDir(name + '-tpl'); wfx(tpl, 'forge-bin/tool.cjs', 'module.exports = "NEW-120";\n');
    const root = freshDir(name + '-root');
    const p = makeProject(root, 'proj', 0); makeRealProjectMarker(p);
    sync.writeReceipt(p, { knownHashes: { 'forge-bin/tool.cjs': sync.sha256(wfx(p, '.claude/forge-bin/tool.cjs', 'module.exports = "OLD-120";\n')) } });
    return { tpl, root, p };
  };
  const toolOf = (p) => rfx(p, '.claude/forge-bin/tool.cjs');
  const A = mkRoot('t120a');
  wfx(A.p, '.claude/forge-runs/live/events.jsonl', '{"event_type":"agent_started"}\n');
  const ra = runCLIWithTemplate(['sync-all', A.root, '--batch-id', 'b120a'], A.tpl);
  t('120a sync-all refuses the busy project (exit 1, "not proven idle") and writes nothing into it', ra.status === 1 && /not proven idle/.test(ra.stderr + ra.stdout) && /OLD-120/.test(toolOf(A.p)) && !fs.existsSync(path.join(A.p, '.claude', 'forge-backups')));
  const ro = runCLIWithTemplate(['sync-all', A.root, '--batch-id', 'b120o', '--quiesce-override', 'owner approved: fixture'], A.tpl);
  const rcO = sync.readReceipt(A.p);
  t('120a --quiesce-override lets it through and is RECORDED in that project\'s receipt, exactly like install', ro.status === 0 && /NEW-120/.test(toolOf(A.p)) && !!rcO && !!rcO.quiesce && rcO.quiesce.override === 'owner approved: fixture' && rcO.quiesce.idle === false);
  t('120a --quiesce-override together with --dry-run is a usage error (exit 2)', runCLIWithTemplate(['sync-all', A.root, '--dry-run', '--quiesce-override', 'not needed'], A.tpl).status === 2);
  const B = mkRoot('t120b');
  wfx(B.p, '.claude/forge-runs/live/events.jsonl', '{}\n');
  const rbU = runCLIWithTemplate(['sync-all', B.root, '--unsafe', '--batch-id', 'b120b'], B.tpl);
  t('120b sync-all --unsafe refuses the busy project too (exit 1) and writes nothing into it', rbU.status === 1 && /not proven idle/.test(rbU.stderr) && /OLD-120/.test(toolOf(B.p)));
  const C = mkRoot('t120c');
  const lp = sync.lockPathFor(sync.claudeDirOf(C.p));
  const held = JSON.stringify({ pid: process.pid, batch_id: 'someone-else', started_at: new Date().toISOString(), ts: new Date().toISOString(), nonce: 'a'.repeat(32) });
  fs.writeFileSync(lp, held);
  const rc = quiet(() => sync.runSyncAll(C.tpl, C.root, { projects: [C.p], unsafe: true, batchId: 'b120c', nowIso: NOW_R3 })).r;
  t('120c sync-all --unsafe takes the project lock: a held lock refuses it (nothing written) and the lock is left exactly as it was', rc.ok === false && /OLD-120/.test(toolOf(C.p)) && fs.readFileSync(lp, 'utf8') === held);
  fs.rmSync(lp, { force: true });
  const rc2 = quiet(() => sync.runSyncAll(C.tpl, C.root, { projects: [C.p], unsafe: true, batchId: 'b120c2', nowIso: NOW_R3 })).r;
  t('120c ...with the lock free it runs, then releases its own lock', rc2.ok === true && /NEW-120/.test(toolOf(C.p)) && !fs.existsSync(lp));
}

console.log('\n121) R3 SYNC-10: a lock is reclaimed only when it is old AND its owner is gone; only its owner ever releases it');
{
  const d = freshDir('t121');
  const lp = sync.lockPathFor(d);
  const OLD = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, batch_id: 'x', started_at: OLD, ts: OLD }));
  const a = sync.acquireLock(d, { batchId: 'b121a' });
  t('121a an OLD lock whose pid is still running is NEVER reclaimed (held) and is left untouched', a.ok === false && a.held === true && /never reclaimed/.test(a.reason || '') && JSON.parse(fs.readFileSync(lp, 'utf8')).pid === process.pid);
  t('121a ...nor one whose liveness cannot be told', sync.acquireLock(d, { pidAlive: () => null }).held === true);
  const b = sync.acquireLock(d, { batchId: 'b121b', pidAlive: () => false });
  t('121b an old lock whose pid is gone IS reclaimed; the new lock carries this run\'s nonce; no reclaim leftovers', b.ok === true && b.reclaimedStale === true && JSON.parse(fs.readFileSync(lp, 'utf8')).nonce === b.nonce && fs.readdirSync(d).filter((n) => /\.reclaim-/.test(n)).length === 0);
  sync.releaseLock(b);
  fs.writeFileSync(lp, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  t('121c a FRESH lock with a dead pid is still held (the 6 h age comes first)', sync.acquireLock(d, { pidAlive: () => false }).held === true);
  fs.writeFileSync(lp, 'not json at all');
  const oldT = new Date(OLD); fs.utimesSync(lp, oldT, oldT);
  const c = sync.acquireLock(d, { batchId: 'b121c' });
  t('121c an old lock with no readable owner is reclaimed (age from the file time)', c.ok === true && c.reclaimedStale === true && c.reclaimedFrom.ownerReadable === false);
  const foreign = JSON.stringify({ pid: 4242, batch_id: 'someone-else', started_at: new Date().toISOString(), ts: new Date().toISOString(), nonce: 'f'.repeat(32) });
  fs.writeFileSync(lp, foreign);
  const rel = sync.releaseLock(c);
  t('121d releaseLock never removes a lock that is no longer this run\'s', !!rel && rel.released === false && fs.readFileSync(lp, 'utf8') === foreign);
  fs.rmSync(lp, { force: true });
  const e = sync.acquireLock(d, { batchId: 'b121e' });
  t('121d ...and does remove its own', (sync.releaseLock(e) || {}).released === true && !fs.existsSync(lp));
}

console.log('\n122) R3 SYNC-11: quiesce-check never counts a junction/symlink activity folder as idle — it is unknown, so busy');
{
  const p = makeProject(freshDir('t122-root'), 'proj', null);
  const fakeRoot = freshDir('t122-claude-projects');
  const qo = () => ({ nowMs: Date.now(), projectsRoot: fakeRoot, listProcesses: () => [], selfPid: 424242, parentPid: 424241 });
  t('122 (baseline: the quiet project is idle)', sync.quiesceCheck(p, qo()).idle === true);
  const slug = sync.claudeProjectSlug(p);
  const elsewhere = freshDir('t122-elsewhere');
  fs.writeFileSync(path.join(elsewhere, 'session.jsonl'), '{}\n'); // a FRESH transcript, reachable only through the link
  if (r3Junction(elsewhere, path.join(fakeRoot, slug), '122a')) {
    const q = sync.quiesceCheck(p, qo());
    t('122a a transcript folder that is a junction is UNKNOWN (never "no transcript folder" = idle)', q.idle === false && q.checks.transcripts.state === 'unknown' && /junction/.test(q.checks.transcripts.detail));
    fs.rmdirSync(path.join(fakeRoot, slug));
  }
  fs.mkdirSync(path.join(fakeRoot, slug));
  if (r3Junction(elsewhere, path.join(fakeRoot, slug, 'subagents'), '122b')) {
    const q = sync.quiesceCheck(p, qo());
    t('122b a junction INSIDE a transcript folder makes it UNKNOWN (never followed, never skipped as idle)', q.idle === false && q.checks.transcripts.state === 'unknown');
    fs.rmdirSync(path.join(fakeRoot, slug, 'subagents'));
  }
  fs.rmSync(path.join(fakeRoot, slug), { recursive: true, force: true });
  const runTarget = freshDir('t122-run'); fs.writeFileSync(path.join(runTarget, 'events.jsonl'), '{}\n');
  fs.mkdirSync(path.join(p, '.claude', 'forge-runs'), { recursive: true });
  if (r3Junction(runTarget, path.join(p, '.claude', 'forge-runs', 'linked-run'), '122c')) {
    const q = sync.quiesceCheck(p, qo());
    t('122c a run folder that is a junction makes the events check UNKNOWN', q.idle === false && q.checks.events.state === 'unknown' && /junction/.test(q.checks.events.detail));
    fs.rmdirSync(path.join(p, '.claude', 'forge-runs', 'linked-run'));
  }
  fs.rmSync(path.join(p, '.claude', 'forge-runs'), { recursive: true, force: true });
  const runsElsewhere = freshDir('t122-runs');
  if (r3Junction(runsElsewhere, path.join(p, '.claude', 'forge-runs'), '122d')) {
    const q = sync.quiesceCheck(p, qo());
    t('122d forge-runs itself as a junction is UNKNOWN', q.idle === false && q.checks.events.state === 'unknown');
    fs.rmdirSync(path.join(p, '.claude', 'forge-runs'));
  }
  t('122 (with the links removed the project is idle again)', sync.quiesceCheck(p, qo()).idle === true);
}

console.log('\n123) R3 SYNC-12: an unreadable protected entry is never "unchanged", and app code outside .claude/ is guarded through git');
{
  const base = (entries) => ({ schema: sync.PROTECT_SCHEMA, projectPath: 'x', shippedRels: [], entries });
  // WP-SYNC-R13 (third real 26H2 install): two unreadable readings are still never EQUAL, but with the same error code they are
  // "not comparable" (listed + counted, never a violation); another code, or no code at all, stays a violation (fail closed).
  // WP-SYNC-R13B: only STRICTLY inside .claude/worktrees/<name>/ and only with the failing operation known
  // in both readings — so the rule is shown on WTK; the R13 fixture ('.claude/locked.bin', a bare 'EBUSY') is a violation now.
  const WTK = '.claude/worktrees/wp-a/scratch/locked.bin';
  const d1 = sync.diffProtectManifests(base({ [WTK]: { kind: 'unreadable', error: 'EBUSY: resource busy or locked, open \'x\'' } }), { entries: { [WTK]: { kind: 'unreadable', error: 'EBUSY: resource busy or locked, open \'y\'' } } }, null);
  t('123a [R13] two "unreadable" readings with the SAME error code (and operation) are "not comparable" (listed), not a violation', d1.ok === true && (d1.notComparable || []).length === 1 && (d1.notComparable || [])[0].key === WTK && sync.protectViolationLines(d1).length === 0);
  const d1b = sync.diffProtectManifests(base({ [WTK]: { kind: 'unreadable', error: 'EBUSY: resource busy or locked, open \'x\'' } }), { entries: { [WTK]: { kind: 'unreadable', error: 'EACCES: permission denied, open \'x\'' } } }, null);
  t('123a two "unreadable" readings with DIFFERENT error codes are a VIOLATION', d1b.ok === false && sync.protectViolationLines(d1b).includes('CHANGED ' + WTK));
  const d1c = sync.diffProtectManifests(base({ [WTK]: { kind: 'unreadable', error: 'could not be read' } }), { entries: { [WTK]: { kind: 'unreadable', error: 'could not be read' } } }, null);
  t('123a two "unreadable" readings WITHOUT a known error code are still a VIOLATION (fail closed)', d1c.ok === false && sync.protectViolationLines(d1c).includes('CHANGED ' + WTK));
  const d1d = sync.diffProtectManifests(base({ '.claude/locked.bin': { kind: 'unreadable', error: 'EBUSY' } }), { entries: { '.claude/locked.bin': { kind: 'unreadable', error: 'EBUSY' } } }, null);
  t('123a [R13B] the R13 fixture itself — outside .claude/worktrees/<name>/, no operation named — is a VIOLATION now (R13: not comparable)', d1d.ok === false && sync.protectViolationLines(d1d).includes('CHANGED .claude/locked.bin') && (d1d.notComparable || []).length === 0);
  t('123a ...while absent on both sides is fine', sync.diffProtectManifests(base({ '.claude/a': { kind: 'absent' } }), { entries: {} }, null).ok === true);
  if (!PUB_GIT_OK) console.log('  SKIP 123b-d: git is not available here — the application-code guard needs git');
  else {
    const { tpl } = tplHomeWp2c('t123-tpl', { settings: false });
    const mkRepo = (name) => {
      const p = projWp2c(name, { doctorExit: null });
      wfx(p, 'src/app.js', 'console.log("app v1");\n');
      const g = pubGit(p); g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'app']);
      return { p, g };
    };
    const onPostValidation = (p, js) => 'if (require("fs").readFileSync(' + JSON.stringify(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) + ', "utf8") === "TOOL-V2") { ' + js + ' }';
    const B = mkRepo('t123b');
    writeDoctorStub(B.p, 0, onPostValidation(B.p, 'require("fs").appendFileSync(' + JSON.stringify(path.join(B.p, 'src', 'app.js')) + ', "// written by a doctor suite\\n");'));
    const rB = sync.safeSyncProject(tpl, B.p, { batchId: 'b123b', nowIso: NOW_R3 });
    t('123b a doctor suite that edits src/app.js during the install is a protect violation naming (app) src/app.js', rB.ok === false && rB.protectViolation === true && sync.protectViolationLines(rB.protect).some((l) => /\(app\) src\/app\.js/.test(l)));
    t('123b the whole batch was rolled back (tool V1); the app change itself is named, not undone', rB.rolledBack === true && rfx(B.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && /written by a doctor suite/.test(rfx(B.p, 'src/app.js') || ''));
    const C = mkRepo('t123c');
    const commitJs = 'require("child_process").spawnSync("git", ["-C", ' + JSON.stringify(C.p) + ', "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "doctor"]);';
    writeDoctorStub(C.p, 0, onPostValidation(C.p, commitJs));
    const rC = sync.safeSyncProject(tpl, C.p, { batchId: 'b123c', nowIso: NOW_R3 });
    t('123c a git HEAD that moves during the install is a violation too (and the batch is rolled back)', rC.ok === false && rC.protectViolation === true && sync.protectViolationLines(rC.protect).some((l) => /\(app\) git HEAD/.test(l)) && rfx(C.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
    const D = mkRepo('t123d');
    const out = path.join(freshDir('t123d-out'), 'protect.json');
    const mk = runCLIWithTemplate(['protect-manifest', D.p, '--out', out], tpl);
    fs.appendFileSync(path.join(D.p, 'src', 'app.js'), '// edited\n');
    const v = runCLIWithTemplate(['verify-protect', D.p, out, '--json'], tpl);
    const vj = pubJson(v.stdout);
    t('123d the standalone verify-protect (used by the adoption tool) sees app code too: exit 1, (app) src/app.js changed', mk.status === 0 && v.status === 1 && !!vj && vj.changed.some((c) => c.key === '(app) src/app.js'));
    const m0 = sync.buildProtectManifest(tpl, D.p, {});
    t('123d the manifest records the git state (HEAD + entries outside .claude/)', !!m0.git && /^[0-9a-f]{40,64}$/.test(m0.git.head || '') && m0.git.entries['src/app.js'] !== undefined && !Object.keys(m0.git.entries).some((k) => k.startsWith('.claude')));
    // (e) no false positive: app files that were ALREADY dirty/untracked before the sync, and untouched during it, pass
    const E = mkRepo('t123e');
    writeDoctorStub(E.p, 0);
    fs.appendFileSync(path.join(E.p, 'src', 'app.js'), '// an uncommitted owner edit made BEFORE the sync\n');
    wfx(E.p, 'notes/todo.md', 'an untracked owner note\n');
    const rE = sync.safeSyncProject(tpl, E.p, { batchId: 'b123e', nowIso: NOW_R3 });
    t('123e a clean install into a git project with pre-existing dirty app files passes, with the app guard active', rE.ok === true && !!rE.protect && rE.protect.ok === true && !!rE.protect.appCode && rE.protect.appCode.guarded === true && rE.protect.appCode.files >= 2);
    const rbE = sync.rollbackProject(E.p, 'b123e', {});
    t('123e ...and its rollback restores .claude/ only, leaving the owner\'s app edits alone', rbE.ok === true && rfx(E.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && /owner edit made BEFORE the sync/.test(rfx(E.p, 'src/app.js') || '') && rfx(E.p, 'notes/todo.md') === 'an untracked owner note\n');
  }
}

console.log('\n124) R3 SYNC-13: a coupled-trio member missing from the template refuses the install; a partial trio is never delivered');
{
  const TRIO = sync.COUPLED_DELIVERY_GROUPS[0].rels;
  const tplWith = (name, rels) => { const x = tplHomeWp2c(name, { settings: false, extraRules: [SHIP_RULE('.claude/forge-dashboard/*.cjs', 'ship-sync')] }); for (const rel of rels) wfx(x.tpl, rel, '// NEW ' + rel + '\n'); return x.tpl; };
  const projWith = (name, rels) => { const p = projWp2c(name); const rc = sync.readReceipt(p); for (const rel of rels) rc.knownHashes[rel] = sync.sha256(wfx(p, '.claude/' + rel, '// OLD ' + rel + '\n')); sync.writeReceipt(p, rc); return p; };
  const tA = tplWith('t124a-tpl', TRIO.filter((r) => !/runcontract/.test(r)));
  const pA = projWith('t124a', TRIO);
  const before = snapshotTree(pA);
  const rA = sync.safeSyncProject(tA, pA, { batchId: 'b124a', nowIso: NOW_R3 });
  t('124a the template lacks forge-runcontract.cjs: refused before any write, naming it', rA.ok === false && rA.refusedCoupled === true && /MISSING forge-bin\/forge-runcontract\.cjs/.test(rA.reason || '') && JSON.stringify(snapshotTree(pA)) === JSON.stringify(before));
  const uA = quiet(() => sync.rawInstall(tA, pA, { batchId: 'b124u', nowIso: NOW_R3 })).r;
  t('124a --unsafe refuses it too', uA.ok === false && uA.refusedCoupled === true);
  const dA = runCLIWithTemplate(['install', pA, '--dry-run', '--json'], tA);
  const dj = pubJson(dA.stdout);
  t('124a the dry-run says so (exit 1, coupledDelivery.ok false, the member reported missing-in-template)', dA.status === 1 && !!dj && dj.coupledDelivery.ok === false && JSON.stringify(dj.coupledDelivery).includes('missing-in-template'));
  const pB = projWp2c('t124b');
  const rB = sync.safeSyncProject(tA, pB, { batchId: 'b124b', nowIso: NOW_R3 });
  t('124b two of three in the template is refused even for a project that has none (a partial trio is never delivered)', rB.ok === false && rB.refusedCoupled === true && !fs.existsSync(path.join(pB, '.claude', 'forge-dashboard', 'log-event.cjs')));
  const tC = tplHomeWp2c('t124c-tpl', { settings: false }).tpl;
  const rC = sync.safeSyncProject(tC, projWp2c('t124c'), { batchId: 'b124c', nowIso: NOW_R3 });
  t('124c no trio member anywhere (template and project): not applicable, the sync proceeds', rC.ok === true && rC.coupledDelivery.groups[0].notApplicable === true);
  const tD = tplWith('t124d-tpl', TRIO);
  const pD = projWith('t124d', TRIO.filter((r) => !/runcontract/.test(r)));
  wfx(pD, '.claude/config/forge-overrides.json', JSON.stringify({ overrides: ['forge-bin/forge-runcontract.cjs'] }));
  const rD = sync.safeSyncProject(tD, pD, { batchId: 'b124d', nowIso: NOW_R3 });
  t('124d a member MISSING in the project that the plan does not deliver (held by an override) refuses the install', rD.ok === false && rD.refusedCoupled === true && /forge-runcontract\.cjs \(missing in the project/.test(rD.reason || ''));
}

// =====================================================================================================================
// findings F01..F13 on the R3 fixes). One
// section per finding (F03 and F05 share 127); each one FAILS on the code before this round (verified against the pre-fix
// copy). 125 F01 journal never written through a link · 126 F02 chained, batch-bound journal · 127 F03+F05 written hash from
// the buffer, re-hash before the rename · 128 F04 publish rollback re-verifies the physical identity · 129 F06 the floor by
// REAL path · 130 F07 Windows path hygiene + wider floor · 131 F08 app-code guard honesty · 132 F09 lock-first quiesce,
// suspect images, cwd · 133 F10 two-phase lock reclaim · 134 F11 live-owner-old + junctioned lock dir · 135 F12 no false
// self-rollback after the scaffold's .gitignore append · 136 F13 case-folded overrides.
// Fixtures: os.tmpdir() only. Junctions via r3Junction (visible SKIP when refused); hard links / file symlinks: tried, SKIP
// when the platform refuses. Nothing here touches ~/.claude, the real template or a real project.
// =====================================================================================================================
const r4Hash = (s) => require('crypto').createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest('hex');
const r4Bdir = (p, b) => path.join(p, '.claude', 'forge-backups', b);
const r4ReadManifest = (p, b) => JSON.parse(fs.readFileSync(path.join(r4Bdir(p, b), 'manifest.json'), 'utf8'));
const r4JournalLines = (p, b) => fs.readFileSync(path.join(r4Bdir(p, b), sync.APPLY_JOURNAL_NAME), 'utf8').split(/\r?\n/).filter(Boolean);
/** r4Rechain(p, b, mutate) — rewrite the batch's apply journal with a VALID chain after `mutate(records)` (so a test can
 *  change WHAT the journal says while keeping it well-formed) and patch the bound manifest's head to match. */
function r4Rechain(p, b, mutate) {
  const recs = r4JournalLines(p, b).map((l) => JSON.parse(l));
  mutate(recs);
  let prev = sync.JOURNAL_GENESIS; const out = [];
  recs.forEach((r, i) => { r.seq = i + 1; r.prev = prev; const line = JSON.stringify(r); out.push(line); prev = r4Hash(line); });
  fs.writeFileSync(path.join(r4Bdir(p, b), sync.APPLY_JOURNAL_NAME), out.join('\n') + '\n');
  const m = r4ReadManifest(p, b); m.apply_journal = { head: prev, seq: out.length }; sync.writeBoundManifest(r4Bdir(p, b), m);
  return out;
}
const r4HardLink = (target, linkPath, label) => { try { fs.linkSync(target, linkPath); return true; } catch (e) { console.log('  SKIP ' + label + ' — hard links refused here (' + (e.code || e.message) + '); not exercised'); return false; } };
/** r4Section(id, fn) — a section that THROWS (on the pre-fix code a missing export throws TypeError) is ONE counted FAIL line
 *  instead of a crashed process, so a run against the pre-fix copy reports every section's verdict. */
function r4Section(id, fn) { try { fn(); } catch (e) { fail++; console.error('  FAIL ' + id + ' section threw: ' + (e && e.message ? e.message : e)); } }

console.log('\n125) R4 F01: the apply journal is never written through a planted link — an alias of project memory refuses the batch');
r4Section('125', () => {
  const { tpl } = tplHomeWp2c('t125-tpl', { settings: false });
  const pA = projWp2c('t125a');
  const mem = path.join(pA, '.claude', 'FORGE_MEMORY.md');
  const memBefore = fs.readFileSync(mem, 'utf8');
  const bdirA = r4Bdir(pA, 'b125a'); fs.mkdirSync(bdirA, { recursive: true });
  if (r4HardLink(mem, path.join(bdirA, sync.APPLY_JOURNAL_NAME), '125a')) {
    const rA = sync.safeSyncProject(tpl, pA, { batchId: 'b125a', nowIso: NOW_R3 });
    t('125a a hard link to FORGE_MEMORY.md planted as the batch\'s journal: the batch is refused and the memory file is byte-identical', rA.ok === false && /journal/i.test((rA.reason || '') + (rA.applyError || '')) && fs.readFileSync(mem, 'utf8') === memBefore);
    t('125a nothing was applied (tool still V1), no version stamp', rfx(pA, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && !fs.existsSync(sync.versionFilePath(pA)));
  }
  // (b) the primitive: an existing journal with two hard links is refused by appendApplyJournal itself
  const dB = freshDir('t125b');
  const victim = path.join(dB, 'victim.md'); fs.writeFileSync(victim, 'OWNER DATA\n');
  if (r4HardLink(victim, path.join(dB, sync.APPLY_JOURNAL_NAME), '125b')) {
    let threw = null;
    try { sync.appendApplyJournal([dB], { rel: 'x', action: 'skipped' }, { batchId: 'b125b', seq: 0, head: sync.JOURNAL_GENESIS }); } catch (e) { threw = e.message; }
    t('125b appendApplyJournal refuses a journal name that has two hard links (no byte reaches the alias)', !!threw && /hard link/.test(threw) && fs.readFileSync(victim, 'utf8') === 'OWNER DATA\n');
  }
  // (c) a file symlink in place of the journal (needs symlink privileges on Windows — SKIP when refused)
  const dC = freshDir('t125c');
  const victimC = path.join(dC, 'victim.md'); fs.writeFileSync(victimC, 'OWNER DATA\n');
  let symOk = false;
  try { fs.symlinkSync(victimC, path.join(dC, sync.APPLY_JOURNAL_NAME), 'file'); symOk = true; } catch (e) { console.log('  SKIP 125c — this platform refused to create a file symlink (' + (e.code || e.message) + '); not exercised here'); }
  if (symOk) {
    let threw = null;
    try { sync.appendApplyJournal([dC], { rel: 'x', action: 'skipped' }, { batchId: 'b125c', seq: 0, head: sync.JOURNAL_GENESIS }); } catch (e) { threw = e.message; }
    t('125c a symlink in place of the journal is refused; the target is untouched', !!threw && /symlink|link/.test(threw) && fs.readFileSync(victimC, 'utf8') === 'OWNER DATA\n');
  }
  // (d) a journal dir that is a junction is refused too
  const dD = freshDir('t125d'), outside = freshDir('t125d-outside');
  if (r3Junction(outside, path.join(dD, 'batch'), '125d')) {
    let threw = null;
    try { sync.appendApplyJournal([path.join(dD, 'batch')], { rel: 'x', action: 'skipped' }, { batchId: 'b125d', seq: 0, head: sync.JOURNAL_GENESIS }); } catch (e) { threw = e.message; }
    t('125d a journal folder that is a junction is refused (nothing written outside)', !!threw && fs.readdirSync(outside).length === 0);
    fs.rmdirSync(path.join(dD, 'batch'));
  }
  // (e) the healthy case still works: a fresh journal is created exclusively and appended to
  const dE = freshDir('t125e');
  const chain = { batchId: 'b125e', seq: 0, head: sync.JOURNAL_GENESIS };
  sync.appendApplyJournal([dE], { rel: 'a', action: 'intent-create', hash: 'x' }, chain);
  sync.appendApplyJournal([dE], { rel: 'a', action: 'created', hash: 'x' }, chain);
  const jE = sync.readApplyJournal(dE, { batchId: 'b125e' });
  t('125e a healthy journal: two chained records, trusted, the chain state advanced (seq 2)', jE.present && jE.trusted && jE.created.has('a') && chain.seq === 2 && jE.head === chain.head && fs.lstatSync(path.join(dE, sync.APPLY_JOURNAL_NAME)).nlink === 1);
});

console.log('\n126) R4 F02: the apply journal is a chained, batch-bound log — a gap, truncation, reorder or unbound record makes it untrusted, and then nothing is deleted');
r4Section('126', () => {
  const { tpl } = tplHomeWp2c('t126-tpl', { settings: false });
  const pA = projWp2c('t126a');
  const rA = sync.safeSyncProject(tpl, pA, { batchId: 'b126a', nowIso: NOW_R3 });
  const recsA = r4JournalLines(pA, 'b126a').map((l) => JSON.parse(l));
  const jA = sync.readApplyJournal(r4Bdir(pA, 'b126a'), { batchId: 'b126a' });
  const mA = r4ReadManifest(pA, 'b126a');
  t('126a every record carries batch_id, a 1-based seq and prev (genesis first); the reader trusts the chain', rA.ok === true && recsA.length >= 3 && recsA.every((r, i) => r.batch_id === 'b126a' && r.seq === i + 1) && recsA[0].prev === sync.JOURNAL_GENESIS && jA.trusted === true);
  t('126a the bound manifest records the journal head (hash + seq) and still verifies as bound', !!mA.apply_journal && mA.apply_journal.seq === recsA.length && mA.apply_journal.head === jA.head && sync.manifestBinding(mA, pA, 'b126a').state === 'bound');
  const seedsOf = (p) => ['FORGE_OWNER_PROFILE.json', 'skills/demo/learnings.md'].filter((rel) => rfx(p, '.claude/' + rel) !== null);
  // (b) TRUNCATED (the last record dropped): untrusted (head mismatch) -> updates restored, nothing created is deleted
  const pB = projWp2c('t126b');
  sync.safeSyncProject(tpl, pB, { batchId: 'b126b', nowIso: NOW_R3 });
  const lB = r4JournalLines(pB, 'b126b'); fs.writeFileSync(path.join(r4Bdir(pB, 'b126b'), sync.APPLY_JOURNAL_NAME), lB.slice(0, -1).join('\n') + '\n');
  const jB = sync.readApplyJournal(r4Bdir(pB, 'b126b'), { batchId: 'b126b', expectedHead: r4ReadManifest(pB, 'b126b').apply_journal });
  const rbB = sync.rollbackProject(pB, 'b126b', {});
  t('126b a truncated journal is untrusted (it no longer ends at the recorded head)', jB.present === true && jB.trusted === false && /head|truncated/.test(jB.reason || ''));
  t('126b the rollback restores tool.cjs to V1 but deletes NONE of the created seeds, naming journal-untrusted', rbB.ok === false && rfx(pB, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && seedsOf(pB).length === 2 && /journal-untrusted/.test(rbB.reason || ''));
  // (c) REORDERED (two records swapped): untrusted
  const pC = projWp2c('t126c');
  sync.safeSyncProject(tpl, pC, { batchId: 'b126c', nowIso: NOW_R3 });
  const lC = r4JournalLines(pC, 'b126c'); const swapped = lC.slice(); swapped[0] = lC[1]; swapped[1] = lC[0];
  fs.writeFileSync(path.join(r4Bdir(pC, 'b126c'), sync.APPLY_JOURNAL_NAME), swapped.join('\n') + '\n');
  t('126c a reordered journal is untrusted (seq/prev no longer chain)', sync.readApplyJournal(r4Bdir(pC, 'b126c'), { batchId: 'b126c' }).trusted === false);
  // (d) an UNBOUND record (an R3-era line without batch_id/seq) and a record of another batch: untrusted
  const dD = freshDir('t126d');
  fs.writeFileSync(path.join(dD, sync.APPLY_JOURNAL_NAME), JSON.stringify({ ts: NOW_R3, rel: 'FORGE_OWNER_PROFILE.json', action: 'created', hash: 'a'.repeat(64) }) + '\n');
  t('126d an R3-era unbound record is untrusted', sync.readApplyJournal(dD, { batchId: 'b126d' }).trusted === false);
  const chainD = { batchId: 'other', seq: 0, head: sync.JOURNAL_GENESIS }; fs.rmSync(path.join(dD, sync.APPLY_JOURNAL_NAME));
  sync.appendApplyJournal([dD], { rel: 'x.md', action: 'created', hash: 'a'.repeat(64) }, chainD);
  t('126d a well-formed journal of ANOTHER batch is untrusted for this one', sync.readApplyJournal(dD, { batchId: 'b126d' }).trusted === false && sync.readApplyJournal(dD, { batchId: 'other' }).trusted === true);
  // (e) INTENT IS NOT PROOF: a seed with only an intent-create record (another writer may have won the exclusive create),
  // even though the live bytes equal the template's, is KEPT; the proven creation beside it is removed
  const pE = projWp2c('t126e');
  sync.safeSyncProject(tpl, pE, { batchId: 'b126e', nowIso: NOW_R3 });
  r4Rechain(pE, 'b126e', (recs) => { const i = recs.findIndex((r) => r.rel === 'FORGE_OWNER_PROFILE.json' && r.action === 'created'); if (i !== -1) recs.splice(i, 1); });
  const jE = sync.readApplyJournal(r4Bdir(pE, 'b126e'), { batchId: 'b126e', expectedHead: r4ReadManifest(pE, 'b126e').apply_journal });
  const rbE = sync.rollbackProject(pE, 'b126e', {});
  t('126e (the re-chained journal verifies: intent-only for the profile seed, created for the learnings seed)', jE.trusted === true && jE.intent.has('FORGE_OWNER_PROFILE.json') && !jE.created.has('FORGE_OWNER_PROFILE.json') && jE.created.has('skills/demo/learnings.md'));
  t('126e the intent-only seed is KEPT (not proven created), the proven seed is removed, tool.cjs restored', rfx(pE, '.claude/FORGE_OWNER_PROFILE.json') !== null && rfx(pE, '.claude/skills/demo/learnings.md') === null && rfx(pE, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && rbE.ok === false && /not proven to be created/.test(rbE.reason || ''));
  // (f) a created record whose recorded hash is not the manifest's newHash does not authorise deletion either
  const pF = projWp2c('t126f');
  sync.safeSyncProject(tpl, pF, { batchId: 'b126f', nowIso: NOW_R3 });
  r4Rechain(pF, 'b126f', (recs) => { for (const r of recs) if (r.rel === 'FORGE_OWNER_PROFILE.json' && r.action === 'created') r.hash = 'f'.repeat(64); });
  const rbF = sync.rollbackProject(pF, 'b126f', {});
  t('126f a "created" record with a foreign hash never deletes the file', rfx(pF, '.claude/FORGE_OWNER_PROFILE.json') !== null && rbF.ok === false);
  // (g) the journal MISSING although the manifest recorded a head: untrusted, nothing deleted
  const pG = projWp2c('t126g');
  sync.safeSyncProject(tpl, pG, { batchId: 'b126g', nowIso: NOW_R3 });
  fs.rmSync(path.join(r4Bdir(pG, 'b126g'), sync.APPLY_JOURNAL_NAME));
  const rbG = sync.rollbackProject(pG, 'b126g', {});
  t('126g a journal that vanished (manifest records one) is untrusted: seeds kept, tool restored, reported', seedsOf(pG).length === 2 && rfx(pG, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && rbG.ok === false && /journal-untrusted/.test(rbG.reason || ''));
  // (h) a resume continues the chain of a trusted journal; an untrusted one refuses the apply before any write
  const pH = projWp2c('t126h');
  const dH = freshDir('t126h-journal');
  const plan1 = { toChange: [{ rel: 'skills/demo/learnings.md', oldHash: null, newHash: sync.sha256(path.join(tpl, 'skills', 'demo', 'learnings.md')), isNew: true }] };
  const a1 = sync.applyPlanSafely(tpl, pH, plan1, null, { journalDirs: [dH], batchId: 'b126h' });
  const plan2 = { toChange: [{ rel: 'FORGE_OWNER_PROFILE.json', oldHash: null, newHash: sync.sha256(path.join(tpl, 'FORGE_OWNER_PROFILE.json')), isNew: true }] };
  const a2 = sync.applyPlanSafely(tpl, pH, plan2, null, { journalDirs: [dH], batchId: 'b126h' });
  const jH = sync.readApplyJournal(dH, { batchId: 'b126h' });
  t('126h a second apply on the same batch continues the chain (seq 4, both creations recorded, trusted)', a1.ok && a2.ok && a1.journal.seq === 2 && a2.journal.seq === 4 && jH.trusted && jH.created.has('skills/demo/learnings.md') && jH.created.has('FORGE_OWNER_PROFILE.json'));
  fs.appendFileSync(path.join(dH, sync.APPLY_JOURNAL_NAME), '{"garbage":true}\n');
  const pH2 = projWp2c('t126h2');
  const a3 = sync.applyPlanSafely(tpl, pH2, plan1, null, { journalDirs: [dH], batchId: 'b126h' });
  t('126h an apply refuses to append to a journal it cannot trust — nothing written', a3.ok === false && /cannot be trusted/.test(a3.error || '') && rfx(pH2, '.claude/skills/demo/learnings.md') === null);
  t('126h an apply with a journal but no batch id is refused', sync.applyPlanSafely(tpl, projWp2c('t126h3'), plan1, null, { journalDirs: [freshDir('t126h3-j')] }).ok === false);
});

console.log('\n127) R4 F03+F05: the recorded hash is the hash of the bytes THIS run wrote; the destination is re-hashed right before the rename; a mismatch is reported, never repaired');
r4Section('127', () => {
  const { tpl } = tplHomeWp2c('t127-tpl', { settings: false });
  // (a) another writer appends in the instant after our write: changed-during-write, the file is NOT written again
  const pA = projWp2c('t127a');
  const planA = sync.buildPlan(tpl, pA, {});
  const dA = freshDir('t127a-journal');
  const racer = (src, out) => { fs.copyFileSync(src, out); fs.appendFileSync(out, '\n// an owner edit in the same instant'); };
  const aA = sync.applyPlanSafely(tpl, pA, planA, racer, { journalDirs: [dA], batchId: 'b127a' });
  const toolRel = planA.toChange.find((e) => e.rel === 'forge-bin/tool.cjs');
  t('127a (the plan updates forge-bin/tool.cjs)', !!toolRel && toolRel.oldHash !== null);
  t('127a the apply stops with changed-during-write and names the file; the other writer\'s bytes are left as they are', aA.ok === false && /changed-during-write/.test(aA.error || '') && Array.isArray(aA.changedDuringWrite) && aA.changedDuringWrite.length === 1 && /an owner edit in the same instant/.test(rfx(pA, '.claude/' + aA.changedDuringWrite[0].rel) || ''));
  const jA = sync.readApplyJournal(dA, { batchId: 'b127a' });
  const recsA = fs.readFileSync(path.join(dA, sync.APPLY_JOURNAL_NAME), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const wrote = recsA.find((r) => r.rel === aA.changedDuringWrite[0].rel && (r.action === 'written' || r.action === 'created'));
  t('127a the journal records the hash of the bytes WE wrote (the template\'s), not the observed bytes', jA.trusted && !!wrote && wrote.hash === aA.changedDuringWrite[0].written && wrote.hash !== aA.changedDuringWrite[0].observed);
  // (b) F05 primitive: writeBytesNoFollow re-hashes the destination after staging, right before the rename
  const dB = freshDir('t127b');
  const f = path.join(dB, 'x.txt'); fs.writeFileSync(f, 'OLD');
  const rChanged = sync.writeBytesNoFollow(Buffer.from('NEW'), f, dB, { expectOldHash: 'f'.repeat(64) });
  t('127b a destination that no longer holds the expected bytes -> "changed", nothing replaced, no temp left', rChanged === 'changed' && fs.readFileSync(f, 'utf8') === 'OLD' && fs.readdirSync(dB).length === 1);
  t('127b ...with the right expectation it is written', sync.writeBytesNoFollow(Buffer.from('NEW'), f, dB, { expectOldHash: sync.sha256(f) }) === 'written' && fs.readFileSync(f, 'utf8') === 'NEW');
  t('127b ...and null means "must still be absent"', sync.writeBytesNoFollow(Buffer.from('X'), path.join(dB, 'y.txt'), dB, { expectOldHash: null }) === 'written' && sync.writeBytesNoFollow(Buffer.from('Y'), path.join(dB, 'y.txt'), dB, { expectOldHash: null }) === 'changed' && fs.readFileSync(path.join(dB, 'y.txt'), 'utf8') === 'X');
  // (c) settings.json: the ledger's postHash comes from the MERGE TOOL's own written bytes (writtenSha256), never a later sample
  const { tpl: tplS } = tplHomeWp2c('t127c-tpl');
  const pC = projWp2c('t127c');
  fs.writeFileSync(path.join(pC, '.claude', 'settings.json'), OWNER_SETTINGS_BYTES);
  const mC = sync.mergeSettingsForBatch(tplS, pC, 'b127c', { nowIso: NOW_R3 });
  const ledC = JSON.parse(fs.readFileSync(path.join(r4Bdir(pC, 'b127c'), sync.SETTINGS_LEDGER_NAME), 'utf8'));
  t('127c the merge tool reports writtenSha256 and the ledger takes it as postHash (source "writer"), equal to the bytes on disk', mC.ok === true && mC.status === 'merged' && /^[0-9a-f]{64}$/.test(mC.writtenSha256 || '') && ledC.postHash === mC.writtenSha256 && ledC.postHashSource === 'writer' && ledC.postHash === sync.sha256(path.join(pC, '.claude', 'settings.json')));
  const pD = projWp2c('t127d');
  const mD = sync.mergeSettingsForBatch(tplS, pD, 'b127d', { nowIso: NOW_R3 });
  const ledD = JSON.parse(fs.readFileSync(path.join(r4Bdir(pD, 'b127d'), sync.SETTINGS_LEDGER_NAME), 'utf8'));
  t('127c a created settings.json: postHash from the writer too', mD.status === 'created' && ledD.postHashSource === 'writer' && ledD.postHash === mD.writtenSha256);
});

if (!PUB_GIT_OK) console.log('\n128) SKIP: git is not available here — publish-template needs a git development tree; NOT exercised');
else r4Section('128', () => {
  console.log('\n128) R4 F04: a failed publish re-verifies the PHYSICAL identity of the template before its rollback writes — a folder swapped for a junction gets nothing');
  const fxD = pubFixture('t128-decoy'), fxR = pubFixture('t128-real');
  // the real template already holds EXACTLY the bytes the decoy publish's action 1 (the first add, sorted: the shipping
  // manifest) will create — so a restore that writes through the junction would "undo" a file of the REAL template
  fs.copyFileSync(path.join(fxD.dev, 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'), wfx(fxR.tpl, 'config/orchestration/FORGE_SHIP_MANIFEST.json', ''));
  const realBefore = pubTreeState(fxR.home);
  const planD = sync.planPublishTemplate(pubOpts(fxD));
  t('128 (fixture: action 0 updates forge-bin/tool.cjs, action 1 adds ' + (planD.add[0] && planD.add[0].rel) + ')', planD.update.length === 1 && planD.update[0].rel === 'forge-bin/tool.cjs' && planD.add.length > 0 && planD.add[0].rel === 'config/orchestration/FORGE_SHIP_MANIFEST.json');
  const moved = fxD.tpl + '-moved';
  let swapped = false;
  const r = sync.applyPublishTemplate(pubOpts(fxD, { batchId: 'p128', nowIso: NOW_R3, hooks: { beforeAction: (i) => {
    if (i !== 2) return;
    fs.renameSync(fxD.tpl, moved);
    if (!r3Junction(fxR.tpl, fxD.tpl, '128')) { fs.renameSync(moved, fxD.tpl); throw new Error('junction refused — plain failure instead'); }
    swapped = true;
    throw new Error('boom after the swap');
  } } }));
  if (swapped) {
    t('128a the publish fails; the restore refused to write (identityChanged) and lists the started actions for manual recovery', r.ok === false && !!r.restore && r.restore.ok === false && r.restore.identityChanged === true && r.restore.problems.length >= 2 && !!r.manualRecovery);
    t('128a the REAL template is byte-identical — nothing was restored through the junction', JSON.stringify(pubTreeState(fxR.home)) === JSON.stringify(realBefore));
    fs.rmdirSync(fxD.tpl); fs.renameSync(moved, fxD.tpl);
    t('128a the moved decoy still holds what the publish wrote (tool V2, the manifest it added) — left for manual recovery, as reported', rfx(fxD.tpl, 'forge-bin/tool.cjs') === 'TOOL-V2\n' && rfx(fxD.tpl, 'config/orchestration/FORGE_SHIP_MANIFEST.json') !== null);
  }
  // (b) restorePublish itself: a ctx whose templateDir does not resolve to itself writes nothing
  const fxB = pubFixture('t128b');
  const alias = path.join(fxB.root, 'alias');
  if (r3Junction(fxB.home, alias, '128b')) {
    const before = pubTreeState(fxB.home);
    const ctx = { devDir: fxB.dev, templateDir: path.join(alias, '.claude'), backupDir: freshDir('t128b-bk'), hooks: null };
    const rr = sync.restorePublish(ctx, [{ type: 'write', rel: 'forge-bin/tool.cjs', existed: true, oldHash: 'a'.repeat(64), newHash: 'b'.repeat(64), touched: true, writtenHash: sync.sha256(path.join(fxB.tpl, 'forge-bin', 'tool.cjs')) }]);
    t('128b restorePublish on a template path that is a junction: ok:false, identityChanged, nothing written', rr.ok === false && rr.identityChanged === true && JSON.stringify(pubTreeState(fxB.home)) === JSON.stringify(before));
    fs.rmdirSync(alias);
  }
});

console.log('\n129) R4 F06: the never-touch floor is judged on the REAL path — a junction into agent-memory/ never receives or loses a file');
r4Section('129', () => {
  const { tpl } = tplHomeWp2c('t129-tpl', { settings: false });
  wfx(tpl, 'skills/evil/SKILL.md', '# a shipped skill\n');
  const pA = projWp2c('t129a');
  const memDir = path.join(pA, '.claude', 'agent-memory');
  const memBefore = snapshotTree(memDir);
  fs.mkdirSync(path.join(pA, '.claude', 'skills'), { recursive: true }); // the junction's parent must exist
  if (r3Junction(memDir, path.join(pA, '.claude', 'skills', 'evil'), '129a')) {
    const planA = sync.buildPlan(tpl, pA, {});
    t('129a (the plan would create skills/evil/SKILL.md — the spelling passes every lexical check)', planA.toChange.some((e) => e.rel === 'skills/evil/SKILL.md' && e.oldHash === null));
    const aA = sync.applyPlanSafely(tpl, pA, planA);
    t('129a applyPlanSafely refuses it by REAL path; agent-memory/ is unchanged', aA.ok === false && /real path|never-touch/i.test(aA.error || '') && JSON.stringify(snapshotTree(memDir)) === JSON.stringify(memBefore));
    t('129a realTargetProblem names the resolved location', typeof sync.realTargetProblem === 'function' && /never-touch/.test(sync.realTargetProblem(path.join(pA, '.claude'), path.join(pA, '.claude', 'skills', 'evil', 'SKILL.md')) || ''));
    // rollback side: a (bound, self-hashed) manifest entry for that path is refused at restore time too
    const rA = sync.safeSyncProject(tpl, pA, { batchId: 'b129a', nowIso: NOW_R3 });
    t('129a end to end the sync fails closed (no write through the junction, memory intact)', rA.ok === false && JSON.stringify(snapshotTree(memDir)) === JSON.stringify(memBefore));
    fs.rmdirSync(path.join(pA, '.claude', 'skills', 'evil'));
  }
  // (b) a plain path resolves to itself: no problem; a path outside: a problem
  const pB = projWp2c('t129b');
  t('129b a plain path inside .claude is fine; one outside is refused', sync.realTargetProblem(path.join(pB, '.claude'), path.join(pB, '.claude', 'forge-bin', 'tool.cjs')) === null && /outside/.test(sync.realTargetProblem(path.join(pB, '.claude'), path.join(pB, 'elsewhere', 'x')) || ''));
  // (c) the retire path: an orphan whose folder is a junction into forge-runs/ is never moved
  const pC = projWp2c('t129c');
  const runsC = path.join(pC, '.claude', 'forge-runs'); fs.mkdirSync(runsC, { recursive: true });
  wfx(pC, '.claude/forge-runs/old.cjs', 'LIVE RUN DATA');
  if (r3Junction(runsC, path.join(pC, '.claude', 'legacy'), '129c')) {
    const h = sync.sha256(path.join(pC, '.claude', 'legacy', 'old.cjs'));
    const ro = sync.retireOrphans(pC, { unmodified: [{ rel: 'legacy/old.cjs', hash: h }] }, { batchId: 'b129c' });
    t('129c retireOrphans refuses the move by real path; the run data is still there', ro.moved.length === 0 && ro.failed.some((f) => /real-path floor/.test(f.reason)) && rfx(pC, '.claude/forge-runs/old.cjs') === 'LIVE RUN DATA');
    fs.rmdirSync(path.join(pC, '.claude', 'legacy'));
  }
});

console.log('\n130) R4 F07: Windows path hygiene — ADS, trailing dots/spaces, device names and 8.3 aliases are never paths a sync touches; the floor covers FORGE_MEMORY*, .env*, *.env');
r4Section('130', () => {
  const bad = ['forge-bin/tool.cjs:hidden', 'forge-bin/tool.cjs:$DATA', 'forge-bin/tool.cjs.', 'forge-bin/tool.cjs ', 'skills/x. /SKILL.md', 'NUL', 'forge-bin/con.cjs', 'forge-bin/COM1.txt', 'LPT9', 'AGENT-~1/MEMORY.md', 'FORGE_~2.md',
    'FORGE_MEMORY_backup.md', 'FORGE_DECISIONS-2026.md', 'notes/forge_task_history.old.md', 'FORGE_AGENT_LEDGER.bak', '.envrc', '.env.local', '.environment', 'config/prod.env', 'skills/x/.env.staging'];
  const good = ['forge-bin/console.cjs', 'forge-bin/nul-helper.cjs', 'forge-bin/com10.cjs', 'forge-bin/lpt.cjs', 'forge-bin/tilde~x.cjs', 'skills/x/SKILL.md', '.env.example', 'forge-bin/environment.cjs', 'forge-bin/envelope.cjs'];
  const missed = bad.filter((r) => !sync.isNeverTouch(r)), wrong = good.filter((r) => sync.isNeverTouch(r));
  t('130a every ADS / trailing-dot-or-space / device-name / 8.3 spelling and every memory-prefix / env name is never-touch' + (missed.length ? ' — MISSED: ' + missed.join(', ') : ''), missed.length === 0);
  t('130a ...while ordinary names that merely resemble them are not' + (wrong.length ? ' — WRONG: ' + wrong.join(', ') : ''), wrong.length === 0);
  t('130a isPlainRel refuses the same spellings; pathHygieneProblem explains each', typeof sync.pathHygieneProblem === 'function' && !sync.isPlainRel('a:b') && !sync.isPlainRel('x/con') && !sync.isPlainRel('a./b') && sync.isPlainRel('a/b.cjs') && /alternate data stream/.test(sync.pathHygieneProblem('a/b:c')) && /device/.test(sync.pathHygieneProblem('a/nul.txt')) && /8\.3/.test(sync.pathHygieneProblem('AGENT-~1/x')) && sync.pathHygieneProblem('ok/fine.md') === null);
  t('130b a backup manifest naming such a path is refused before any mutation', sync.manifestEntryProblems({ files: [{ rel: 'forge-bin/tool.cjs:ads', oldHash: null }, { rel: 'forge-bin/nul.cjs', oldHash: null }, { rel: 'AGENT-~1/m.md', oldHash: null }] }).length === 3);
  const dC = freshDir('t130c');
  const chainC = { batchId: 'b130c', seq: 0, head: sync.JOURNAL_GENESIS };
  sync.appendApplyJournal([dC], { rel: 'forge-bin/tool.cjs:ads', action: 'created', hash: 'a'.repeat(64) }, chainC);
  t('130c a journal record naming such a path makes the journal untrusted', sync.readApplyJournal(dC, { batchId: 'b130c' }).trusted === false);
  // (d) a template that carries such names: shipPlan never delivers them (reported as never-touch claims)
  const tplD = freshDir('t130d-tpl');
  writeTplManifest(tplD, [SHIP_RULE('.claude/forge-bin/*', 'ship-sync'), SHIP_RULE('.claude/*.md', 'ship-sync')]);
  wfx(tplD, 'forge-bin/tool.cjs', 'TOOL');
  const planted = [];
  for (const n of ['forge-bin/con.cjs', 'FORGE_MEMORY_backup.md']) { try { wfx(tplD, n, 'PLANTED ' + n); planted.push(n); } catch { /* the platform refused the name itself */ } }
  const spD = sync.shipPlan(tplD);
  t('130d shipPlan ships only the tool and reports the planted names as never-touch claims (' + planted.length + ' created here)', spD.system.length === 1 && spD.system[0] === 'forge-bin/tool.cjs' && planted.every((n) => spD.neverTouchClaimed.some((c) => c.rel === n)));
});

if (!PUB_GIT_OK) console.log('\n131) SKIP: git is not available here — the application-code guard needs git; NOT exercised');
else r4Section('131', () => {
  console.log('\n131) R4 F08: the application-code guard sees ignored files, link targets and submodules, ignores a line-ending flip, and says "partial" when a probe is unavailable');
  const { tpl } = tplHomeWp2c('t131-tpl', { settings: false });
  const mkRepo = (name, extraSetup) => {
    const p = projWp2c(name, { doctorExit: null });
    wfx(p, 'src/app.js', 'console.log("app v1");\n');
    wfx(p, '.gitignore', 'build/\n');
    if (extraSetup) extraSetup(p);
    const g = pubGit(p); g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'app']);
    return { p, g };
  };
  const onPost = (p, js) => 'if (require("fs").readFileSync(' + JSON.stringify(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) + ', "utf8") === "TOOL-V2") { ' + js + ' }';
  // (a) a doctor suite that creates an IGNORED file during the install is a violation
  const A = mkRepo('t131a');
  writeDoctorStub(A.p, 0, onPost(A.p, 'require("fs").mkdirSync(' + JSON.stringify(path.join(A.p, 'build')) + ', { recursive: true }); require("fs").writeFileSync(' + JSON.stringify(path.join(A.p, 'build', 'out.txt')) + ', "built during the install");'));
  const rA = sync.safeSyncProject(tpl, A.p, { batchId: 'b131a', nowIso: NOW_R3 });
  t('131a an ignored file created during the install is a violation ("(app) ignored files") and the batch rolls back', rA.ok === false && rA.protectViolation === true && sync.protectViolationLines(rA.protect).some((l) => /\(app\) ignored files/.test(l)) && rfx(A.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  // (b) a line-ending flip of an app file is NOT a violation; a byte change is
  const B = mkRepo('t131b');
  writeDoctorStub(B.p, 0, onPost(B.p, 'var f = ' + JSON.stringify(path.join(B.p, 'src', 'app.js')) + '; require("fs").writeFileSync(f, require("fs").readFileSync(f, "utf8").replace(/\\n/g, "\\r\\n"));'));
  const rB = sync.safeSyncProject(tpl, B.p, { batchId: 'b131b', nowIso: NOW_R3 });
  t('131b CRLF instead of LF in src/app.js during the install: no violation, the install succeeds', rB.ok === true && !!rB.protect && rB.protect.ok === true && /\r\n/.test(rfx(B.p, 'src/app.js') || ''));
  const B2 = mkRepo('t131b2');
  writeDoctorStub(B2.p, 0, onPost(B2.p, 'var f = ' + JSON.stringify(path.join(B2.p, 'src', 'app.js')) + '; require("fs").writeFileSync(f, require("fs").readFileSync(f, "utf8").replace("v1", "v2"));'));
  const rB2 = sync.safeSyncProject(tpl, B2.p, { batchId: 'b131b2', nowIso: NOW_R3 });
  t('131b ...while a one-byte change is still a violation', rB2.ok === false && rB2.protectViolation === true && sync.protectViolationLines(rB2.protect).some((l) => /\(app\) src\/app\.js/.test(l)));
  // (c) a junction at the top of the project: its TARGET is recorded; a retarget to identical content is a violation
  const C = mkRepo('t131c');
  const dirA = freshDir('t131c-A'), dirB = freshDir('t131c-B');
  fs.writeFileSync(path.join(dirA, 'f.txt'), 'SAME'); fs.writeFileSync(path.join(dirB, 'f.txt'), 'SAME');
  if (r3Junction(dirA, path.join(C.p, 'linked'), '131c')) {
    const m0 = sync.buildProtectManifest(tpl, C.p, {});
    t('131c the manifest records the junction by its target string', !!m0.git && m0.git.entries['(link) linked'] === 'link ' + dirA);
    writeDoctorStub(C.p, 0, onPost(C.p, 'var l = ' + JSON.stringify(path.join(C.p, 'linked')) + '; require("fs").rmdirSync(l); require("fs").symlinkSync(' + JSON.stringify(dirB) + ', l, "junction");'));
    const rC = sync.safeSyncProject(tpl, C.p, { batchId: 'b131c', nowIso: NOW_R3 });
    t('131c retargeting the junction (same content behind it) is a violation', rC.ok === false && rC.protectViolation === true && sync.protectViolationLines(rC.protect).some((l) => /\(app\) \(link\) linked/.test(l)));
    try { fs.rmdirSync(path.join(C.p, 'linked')); } catch { /* already gone */ }
  }
  // (d) submodule HEADs are recorded
  const D = mkRepo('t131d');
  const subRepo = freshDir('t131d-sub'); fs.writeFileSync(path.join(subRepo, 's.txt'), 'S');
  const gs = pubGit(subRepo); gs(['init', '-q']); gs(['add', '-A']); gs(['commit', '-q', '-m', 's']);
  const addSub = D.g(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRepo, 'vendor/sub']);
  if (addSub.status !== 0) console.log('  SKIP 131d — git submodule add failed here (' + addSub.stderr.trim().slice(0, 120) + ')');
  else {
    D.g(['add', '-A']); D.g(['commit', '-q', '-m', 'sub']);
    const mD = sync.buildProtectManifest(tpl, D.p, {});
    t('131d the manifest records the submodule HEAD per path, and guarded is true (every probe ran)', !!mD.git && !!mD.git.submodules && /^[0-9a-f]{7,64}$/.test(mD.git.submodules['vendor/sub'] || '') && sync.diffProtectManifests(mD, mD, null).appCode.guarded === true);
  }
  // (e) an unavailable probe -> guarded:'partial' with the reason, never true
  const E = mkRepo('t131e');
  const gE = sync.appCodeGitState(E.p, [], { __failProbe: 'ignored' });
  const beforeE = Object.assign(sync.buildProtectManifest(tpl, E.p, {}), { git: gE });
  const dE = sync.verifyProtect(E.p, beforeE, null);
  t('131e with the ignored-files probe unavailable the verdict says guarded:"partial" and why', Array.isArray(gE.partial) && gE.partial.length === 1 && dE.appCode.guarded === 'partial' && /ignored/.test(dE.appCode.reason || ''));
  t('131e the plain git project reports guarded:true with an ignored count', (() => { const m = sync.buildProtectManifest(tpl, mkRepo('t131e2').p, {}); const d = sync.diffProtectManifests(m, m, null); return d.appCode.guarded === true && typeof d.appCode.ignored === 'number'; })());
});

console.log('\n132) R4 F09: the quiesce check runs UNDER this run\'s own lock; an interpreter whose command line cannot be read is unknown; a working directory inside the project counts');
r4Section('132', () => {
  const p = makeProject(freshDir('t132-root'), 'proj', null);
  const fakeRoot = freshDir('t132-claude-projects');
  const qo = (extra) => Object.assign({ nowMs: Date.now(), projectsRoot: fakeRoot, listProcesses: () => [], selfPid: 424242, parentPid: 424241 }, extra || {});
  // (a) unreadable command line: an interpreter/tool image -> unknown; a service image -> counted, not inspected
  const q1 = sync.quiesceCheck(p, qo({ listProcesses: () => [{ pid: 7001, ppid: 1, name: 'node.exe', cmd: null }] }));
  t('132a a node.exe whose command line cannot be read makes processes UNKNOWN (never idle), named by pid + image', q1.idle === false && q1.checks.processes.state === 'unknown' && /pid 7001 \(node\.exe\)/.test(q1.checks.processes.detail));
  const q2 = sync.quiesceCheck(p, qo({ listProcesses: () => [{ pid: 7002, ppid: 1, name: 'svchost.exe', cmd: null }, { pid: 7003, ppid: 1, name: 'postgres.exe', cmd: null }] }));
  t('132a service/system images without a command line stay "counted, not inspected" (idle)', q2.idle === true && /2 without a readable command line/.test(q2.checks.processes.detail));
  t('132a isSuspectImage: interpreters, shells, dev tools and agents yes; services no', typeof sync.isSuspectImage === 'function' && ['node.exe', 'python3.12', 'pwsh.exe', 'bash', 'git.exe', 'claude', 'Code.exe', 'codex'].every(sync.isSuspectImage) && !['svchost.exe', 'postgres.exe', 'conhost.exe', 'WmiPrvSE.exe', 'System'].some(sync.isSuspectImage));
  // (b) a working directory inside the project (platform-exposed, injected here) is busy even when the command line is relative
  const abs = path.resolve(p);
  const q3 = sync.quiesceCheck(p, qo({ listProcesses: () => [{ pid: 7004, ppid: 1, name: 'node.exe', cmd: 'node worker.js' }], processCwd: (pid) => (pid === 7004 ? path.join(abs, 'src') : null) }));
  t('132b `node worker.js` with its cwd inside the project is BUSY (via cwd)', q3.idle === false && q3.checks.processes.state === 'busy' && q3.checks.processes.hits[0].via === 'cwd');
  t('132b the detail states plainly when working directories are not exposed on this platform', process.platform === 'linux' || /not exposed/.test(sync.quiesceCheck(p, qo()).checks.processes.detail));
  // (c) our own lock, recognised by nonce + pid, is ok and marks the check as run under the lock; a foreign lock is busy
  const lock = sync.acquireLock(sync.claudeDirOf(p), { batchId: 'b132c' });
  const qOwn = sync.quiesceCheck(p, qo({ ownLock: { nonce: lock.nonce, pid: lock.pid } }));
  const qForeign = sync.quiesceCheck(p, qo({ ownLock: { nonce: 'f'.repeat(32), pid: lock.pid } }));
  const qNone = sync.quiesceCheck(p, qo());
  t('132c with ownLock the lock check is ok and checkedUnderLock is true; another nonce or no ownLock is busy', qOwn.idle === true && qOwn.checkedUnderLock === true && /own/.test(qOwn.checks.lock.detail) && qForeign.checks.lock.state === 'busy' && qNone.checks.lock.state === 'busy' && qNone.checkedUnderLock === false);
  sync.releaseLock(lock);
  // (d) end to end: a real CLI install takes the lock FIRST and checks under it — the receipt says so
  const { tpl } = tplHomeWp2c('t132-tpl');
  const pD = projWp2c('t132d'); makeRealProjectMarker(pD);
  const rD = runCLIWithTemplate(['install', pD, '--batch-id', 'b132d'], tpl);
  const rcD = sync.readReceipt(pD);
  t('132d CLI install succeeded with the quiesce check run under its own lock (receipt.quiesce.checkedUnderLock)', rD.status === 0 && !!rcD && !!rcD.quiesce && rcD.quiesce.checkedUnderLock === true && rcD.quiesce.idle === true);
  // (e) F11: a STALE lock (old, dead pid) no longer blocks the install — the lock comes first and is reclaimed
  const pE = projWp2c('t132e');
  fs.writeFileSync(sync.lockPathFor(sync.claudeDirOf(pE)), JSON.stringify({ pid: 999999, batch_id: 'dead', started_at: '2020-01-01T00:00:00.000Z', ts: '2020-01-01T00:00:00.000Z', nonce: 'd'.repeat(32) }));
  const rE = runCLIWithTemplate(['install', pE, '--batch-id', 'b132e'], tpl);
  t('132e install over a stale lock left by a dead run: reclaimed (said so), installed (exit 0), lock gone afterwards', rE.status === 0 && /reclaimed a stale lock/.test(rE.stderr) && rfx(pE, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && !fs.existsSync(sync.lockPathFor(sync.claudeDirOf(pE))));
  // (f) sync-all: the same ordering per project (receipt says checkedUnderLock)
  const rootF = freshDir('t132f-root'); const pF = makeProject(rootF, 'proj', 0); makeRealProjectMarker(pF);
  const tplF = freshDir('t132f-tpl'); wfx(tplF, 'forge-bin/tool.cjs', 'module.exports = "NEW-132";\n');
  sync.writeReceipt(pF, { knownHashes: { 'forge-bin/tool.cjs': sync.sha256(wfx(pF, '.claude/forge-bin/tool.cjs', 'module.exports = "OLD-132";\n')) } });
  const rF = runCLIWithTemplate(['sync-all', rootF, '--batch-id', 'b132f'], tplF);
  const rcF = sync.readReceipt(pF);
  t('132f sync-all: every real project is checked under its own lock too', rF.status === 0 && !!rcF && !!rcF.quiesce && rcF.quiesce.checkedUnderLock === true);
});

console.log('\n133) R4 F10: a stale lock is reclaimed in two phases on an exclusive marker — a second reclaimer fails on it, and an incumbent that changed is never vacated');
r4Section('133', () => {
  const d = freshDir('t133');
  const lp = sync.lockPathFor(d);
  const OLD = '2020-01-01T00:00:00.000Z';
  const staleBody = JSON.stringify({ pid: 999999, batch_id: 'dead', started_at: OLD, ts: OLD, nonce: 's'.repeat(32) });
  // (a) a contender already holds the reclaim marker for this exact stale lock: we must fail on it, lock untouched
  fs.writeFileSync(lp, staleBody);
  const marker = lp + '.reclaim-' + r4Hash(staleBody).slice(0, 16);
  fs.writeFileSync(marker, JSON.stringify({ pid: 1, nonce: 'x' }));
  const a = sync.acquireLock(d, { batchId: 'b133a', pidAlive: () => false });
  t('133a with a fresh reclaim marker in place the second contender fails (held, reclaiming) and the stale lock is untouched', a.ok === false && a.held === true && a.reclaiming === true && fs.readFileSync(lp, 'utf8') === staleBody && fs.existsSync(marker));
  // (b) a marker older than the marker window is a crashed reclaimer's leftover: ignored, the reclaim proceeds
  const oldT = new Date(Date.now() - sync.LOCK_RECLAIM_MARKER_STALE_MS - 60000); fs.utimesSync(marker, oldT, oldT);
  const b = sync.acquireLock(d, { batchId: 'b133b', pidAlive: () => false });
  t('133b a stale marker is swept and the reclaim succeeds; no marker or .gone file is left behind', b.ok === true && b.reclaimedStale === true && JSON.parse(fs.readFileSync(lp, 'utf8')).nonce === b.nonce && fs.readdirSync(d).filter((n) => /reclaim/.test(n)).length === 0);
  sync.releaseLock(b);
  // (c) the incumbent changes between the marker and the re-read (a live run took the lock): never vacated
  fs.writeFileSync(lp, staleBody);
  const freshBody = JSON.stringify({ pid: process.pid, batch_id: 'live', started_at: new Date().toISOString(), ts: new Date().toISOString(), nonce: 'l'.repeat(32) });
  const c = sync.acquireLock(d, { batchId: 'b133c', pidAlive: (pid) => pid === process.pid, __afterReclaimMarker: () => fs.writeFileSync(lp, freshBody) });
  t('133c the fresh lock that replaced the stale one in the window is left exactly as it is; we are held; the marker is gone', c.ok === false && c.held === true && fs.readFileSync(lp, 'utf8') === freshBody && fs.readdirSync(d).filter((n) => /reclaim/.test(n)).length === 0);
  fs.rmSync(lp, { force: true });
  // (d) the stale lock vanishes in the window (its owner cleaned up): we take the free name
  fs.writeFileSync(lp, staleBody);
  const dd = sync.acquireLock(d, { batchId: 'b133d', pidAlive: () => false, __afterReclaimMarker: () => fs.rmSync(lp, { force: true }) });
  t('133d a stale lock that vanished in the window: acquired on the free name, no leftovers', dd.ok === true && JSON.parse(fs.readFileSync(lp, 'utf8')).nonce === dd.nonce && fs.readdirSync(d).filter((n) => /reclaim/.test(n)).length === 0);
  sync.releaseLock(dd);
  // (e) the pre-R4 behaviour is kept: a fresh lock is held, a live owner is never reclaimed (now with pid and age in the reason)
  fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, batch_id: 'x', started_at: OLD, ts: OLD }));
  const e = sync.acquireLock(d, { batchId: 'b133e' });
  t('133e an old lock with a LIVE owner is refused naming the pid and its age in minutes', e.ok === false && e.held === true && e.pid === process.pid && /min old/.test(e.reason) && /never reclaimed/.test(e.reason));
});

console.log('\n134) R4 F11: an old lock with a live owner is live-owner-old (not stale); a junctioned lock folder refuses to lock');
r4Section('134', () => {
  const d = freshDir('t134');
  const lp = sync.lockPathFor(d);
  const OLD = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, batch_id: 'b134', started_at: OLD, ts: OLD, nonce: 'a'.repeat(32) }));
  const live = sync.readLockStatus(d);
  t('134a readLockStatus: old + live pid -> stale:false, liveOwnerOld:true, state "live-owner-old"', live.present && live.fresh === false && live.stale === false && live.liveOwnerOld === true && live.state === 'live-owner-old');
  const dead = sync.readLockStatus(d, { pidAlive: () => false });
  t('134a ...the same lock with a dead pid is stale (state "stale"), and an unknown liveness is "unknown-owner-old"', dead.stale === true && dead.state === 'stale' && sync.readLockStatus(d, { pidAlive: () => null }).state === 'unknown-owner-old');
  const pS = makeProject(freshDir('t134-status'), 'proj', null);
  fs.writeFileSync(sync.lockPathFor(sync.claudeDirOf(pS)), JSON.stringify({ pid: process.pid, batch_id: 'b134s', started_at: OLD, ts: OLD }));
  const cli = runCLI(['lock-status', pS, '--json']);
  const cj = pubJson(cli.stdout);
  t('134b CLI lock-status on it exits 1 (a sync IS running) and reports live-owner-old', cli.status === 1 && !!cj && cj.state === 'live-owner-old' && cj.stale === false);
  t('134b the plain output says so', /live-owner-old/.test(runCLI(['lock-status', pS]).stdout));
  // (c) a lock folder that is a junction refuses to lock at all
  const outside = freshDir('t134c-outside');
  const linkDir = path.join(freshDir('t134c'), 'claude');
  if (r3Junction(outside, linkDir, '134c')) {
    const r = sync.acquireLock(linkDir, { batchId: 'b134c' });
    t('134c acquireLock on a junctioned folder: ok:false naming the junction, nothing created behind it', r.ok === false && /junction/.test(r.reason || '') && fs.readdirSync(outside).length === 0);
    fs.rmdirSync(linkDir);
  }
});

if (!PUB_GIT_OK) console.log('\n135) SKIP: git is not available here — the scaffold self-rollback case needs a git project; NOT exercised');
else r4Section('135', () => {
  console.log('\n135) R4 F12: the scaffold\'s own .gitignore append that hides an untracked file is not a violation — the install succeeds, no self-rollback');
  const { tpl } = tplHomeWp2c('t135-tpl', { settings: false, snippet: 'notes/\n' });
  const p = projWp2c('t135', { doctorExit: 0 });
  wfx(p, 'src/app.js', 'console.log("app");\n');
  wfx(p, '.gitignore', 'dist/\n');
  const g = pubGit(p); g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'app']);
  wfx(p, 'notes/todo.md', 'an untracked owner note\n'); // untracked BEFORE the install; the scaffold's block will hide it
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b135', nowIso: NOW_R3 });
  t('135a the install succeeds (ok:true, protect ok) and is NOT rolled back', r.ok === true && !!r.protect && r.protect.ok === true && r.rolledBack !== true && rfx(p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  t('135a the .gitignore got the scaffold block, the note is untouched, and the transition is listed as allowed (now-ignored)', /notes\//.test(rfx(p, '.gitignore') || '') && rfx(p, 'notes/todo.md') === 'an untracked owner note\n' && r.protect.allowed.some((a) => a.change === 'now-ignored' && /notes\/todo\.md/.test(a.key)));
  // (b) a file that vanished for another reason (deleted during the install) is still a violation
  const { tpl: tpl2 } = tplHomeWp2c('t135b-tpl', { settings: false, snippet: 'notes/\n' });
  const p2 = projWp2c('t135b', { doctorExit: null });
  wfx(p2, 'src/app.js', 'console.log("app");\n'); wfx(p2, '.gitignore', 'dist/\n');
  const g2 = pubGit(p2); g2(['init', '-q']); g2(['add', '-A']); g2(['commit', '-q', '-m', 'app']);
  wfx(p2, 'notes/todo.md', 'note\n'); wfx(p2, 'other/keep.md', 'untracked, not hidden by the scaffold\n');
  writeDoctorStub(p2, 0, 'if (require("fs").readFileSync(' + JSON.stringify(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')) + ', "utf8") === "TOOL-V2") require("fs").rmSync(' + JSON.stringify(path.join(p2, 'other', 'keep.md')) + ');');
  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b135b', nowIso: NOW_R3 });
  t('135b an untracked file DELETED during the install (not hidden by the block) is still a violation', r2.ok === false && r2.protectViolation === true && sync.protectViolationLines(r2.protect).some((l) => /\(app\) other\/keep\.md/.test(l)));
});

console.log('\n136) R4 F13: override paths are matched like the file system matches names (normKey), and an override can never lower the floor');
r4Section('136', () => {
  t('136a normKey folds separators, a leading ./ and (on Windows/macOS) case', typeof sync.normKey === 'function' && sync.normKey('./forge-bin//tool.cjs') === 'forge-bin/tool.cjs' && sync.normKey('forge-bin\\tool.cjs') === 'forge-bin/tool.cjs' && (process.platform === 'win32' || process.platform === 'darwin' ? sync.normKey('FORGE-BIN/Tool.cjs') === 'forge-bin/tool.cjs' : sync.normKey('FORGE-BIN/Tool.cjs') === 'FORGE-BIN/Tool.cjs'));
  const { tpl } = tplHomeWp2c('t136-tpl', { settings: false });
  const p = projWp2c('t136');
  const caseFolded = process.platform === 'win32' || process.platform === 'darwin';
  wfx(p, '.claude/config/forge-overrides.json', JSON.stringify({ overrides: [caseFolded ? 'FORGE-BIN\\Tool.cjs' : 'forge-bin\\tool.cjs', 'FORGE_MEMORY.md', './skills/demo/learnings.md', 'Agent-Memory/x.md'] }));
  const al = sync.readOverrideAllowlist(p);
  t('136b the allow-list holds the normalised keys and refuses the two never-touch entries (reported, not silently dropped)', al.has('forge-bin/tool.cjs') && al.has('skills/demo/learnings.md') && Array.isArray(al.refused) && al.refused.length === 2 && al.refused.every((x) => /never-touch/.test(x.reason)));
  const pf = sync.preflight(tpl, p);
  t('136b preflight treats forge-bin/tool.cjs as an EXPECTED OVERRIDE (kept), not as a file to change, and lists the refused entries', pf.expectedOverrides.includes('forge-bin/tool.cjs') && !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs') && Array.isArray(pf.overridesRefused) && pf.overridesRefused.length === 2);
  const m = sync.buildProtectManifest(tpl, p, {});
  t('136b the protect manifest inventories the overridden file as PROTECTED (it is the owner\'s now)', Object.keys(m.entries).some((k) => /\.claude\/forge-bin\/tool\.cjs$/i.test(k)));
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b136', nowIso: NOW_R3 });
  t('136c end to end: the sync keeps the overridden tool.cjs at V1, FORGE_MEMORY.md is untouched, and still succeeds', r.ok === true && rfx(p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && rfx(p, '.claude/FORGE_MEMORY.md') === '# project memory\n');
});

// =====================================================================================================================
// findings F14..F19 on the R4 fixes; the
// final fix round). One section per finding; each one FAILS on the code before this round (verified by running this file
// against the pre-fix copy of forge-sync.cjs): 137 F14 rollback re-judges the live bytes right before staging · 138 F15 the
// floor on the writer's own resolved destination · 139 F16 a resume keeps + validates the journal anchor · 140 F17 a failed
// journal-head write fails the batch (install and --unsafe) · 141 F18 ignored files of a NESTED project · 142 F19 a second
// edit inside an already-dirty submodule. Fault injection wraps ONE fs function of this process (the module shares the fs
// object) for the duration of one call and always restores it. Fixtures: os.tmpdir() only.
// =====================================================================================================================
const r6Same = (a, b) => { const x = path.resolve(String(a)), y = path.resolve(String(b)); return (process.platform === 'win32' || process.platform === 'darwin') ? x.toLowerCase() === y.toLowerCase() : x === y; };
/** r6Wrap(name, makeWrapper, fn) — fs[name] = makeWrapper(original) while fn() runs; always restored. */
function r6Wrap(name, makeWrapper, fn) {
  const orig = fs[name];
  fs[name] = makeWrapper(orig);
  try { return fn(); } finally { fs[name] = orig; }
}
const r6OnPost = (p, js) => 'if (require("fs").readFileSync(' + JSON.stringify(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) + ', "utf8") === "TOOL-V2") { ' + js + ' }';

console.log('\n137) R6 F14: a rollback re-judges each file right before staging — an owner edit made after the divergence scan is kept, never overwritten');
r4Section('137', () => {
  const { tpl } = tplHomeWp2c('t137-tpl', { settings: false });
  /** rollbackWithLateEdit(p, b, opts) — the owner edits tool.cjs AFTER the divergence scan read it and BEFORE the restore
   *  samples it again (on the restore loop's lstat of that exact file). */
  const rollbackWithLateEdit = (p, b, opts) => {
    const tool = path.join(p, '.claude', 'forge-bin', 'tool.cjs');
    const st = { scanned: false, fired: false };
    const rb = r6Wrap('readFileSync', (orig) => function (f, ...rest) { if (!st.scanned && r6Same(f, tool)) st.scanned = true; return orig.call(this, f, ...rest); }, () =>
      r6Wrap('lstatSync', (orig) => function (f, ...rest) {
        if (st.scanned && !st.fired && r6Same(f, tool)) { st.fired = true; fs.writeFileSync(tool, 'OWNER EDIT AFTER THE SCAN'); }
        return orig.call(this, f, ...rest);
      }, () => sync.rollbackProject(p, b, opts || {})));
    return { rb, st };
  };
  const pA = projWp2c('t137a');
  const sA = sync.safeSyncProject(tpl, pA, { batchId: 'b137a', nowIso: NOW_R3 });
  t('137a (the sync updated tool.cjs to V2)', sA.ok === true && rfx(pA, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  const A = rollbackWithLateEdit(pA, 'b137a');
  t('137a (the injected owner edit landed after the divergence scan and before the restore staged anything)', A.st.scanned && A.st.fired);
  t('137a the rollback does NOT overwrite it: ok:false, tool.cjs still holds the owner edit, the reason names the late change', A.rb.ok === false && rfx(pA, '.claude/forge-bin/tool.cjs') === 'OWNER EDIT AFTER THE SCAN' && /changed since the divergence check/.test(A.rb.reason || ''));
  // (b) --force-rollback-newer skips the divergence scan AND this re-judgement (the owner asked for it explicitly): an owner
  // edit is replaced by the pre-batch bytes. (The edit is made before the call — under force there is no scan to land after;
  // an edit landing inside the writer's own staging window is still caught by the pre-rename re-hash, R4 / F05.)
  const pB = projWp2c('t137b');
  sync.safeSyncProject(tpl, pB, { batchId: 'b137b', nowIso: NOW_R3 });
  fs.writeFileSync(path.join(pB, '.claude', 'forge-bin', 'tool.cjs'), 'OWNER EDIT BEFORE A FORCED ROLLBACK');
  const rbB = sync.rollbackProject(pB, 'b137b', { forceRollbackNewer: true });
  t('137b with --force-rollback-newer the owner edit is replaced by the pre-batch bytes (the owner asked for it)', rbB.ok === true && rfx(pB, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  // (c) a file that is simply ABSENT (the owner removed it after the sync) is still restored — absence is not foreign work
  const pC = projWp2c('t137c');
  sync.safeSyncProject(tpl, pC, { batchId: 'b137c', nowIso: NOW_R3 });
  fs.rmSync(path.join(pC, '.claude', 'forge-bin', 'tool.cjs'));
  const rbC = sync.rollbackProject(pC, 'b137c', {});
  t('137c an absent file is still restored to its pre-batch bytes', rbC.ok === true && rfx(pC, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
});

console.log('\n138) R6 F15: the never-touch floor is re-checked on the WRITER\'s own resolved destination — a junction swapped in after the floor check gets nothing');
r4Section('138', () => {
  const { tpl } = tplHomeWp2c('t138-tpl', { settings: false });
  wfx(tpl, 'skills/evil/SKILL.md', '# a shipped skill\n');
  // (a) apply: .claude/skills/evil is a REAL folder at the floor check; while the template file is read it becomes a junction
  // into agent-memory/ (Codex's probe: "a parent redirect during the source read")
  const pA = projWp2c('t138a');
  const memA = path.join(pA, '.claude', 'agent-memory');
  const evilA = path.join(pA, '.claude', 'skills', 'evil');
  fs.mkdirSync(evilA, { recursive: true });
  const memBeforeA = snapshotTree(memA);
  const entryA = sync.buildPlan(tpl, pA, {}).toChange.find((e) => e.rel === 'skills/evil/SKILL.md');
  t('138a (the plan creates skills/evil/SKILL.md inside a real folder)', !!entryA && entryA.oldHash === null);
  const srcA = path.join(tpl, 'skills', 'evil', 'SKILL.md');
  const stA = { swapped: false, tried: false };
  const aA = r6Wrap('readFileSync', (orig) => function (f, ...rest) {
    if (!stA.tried && r6Same(f, srcA)) {
      stA.tried = true;
      fs.rmdirSync(evilA);
      if (r3Junction(memA, evilA, '138a')) stA.swapped = true; else fs.mkdirSync(evilA);
    }
    return orig.call(this, f, ...rest);
  }, () => sync.applyPlanSafely(tpl, pA, { toChange: [entryA] }));
  if (stA.swapped) {
    t('138a the write is refused by the floor on the writer\'s resolved parent; agent-memory/ is byte-identical (no SKILL.md landed there)', aA.ok === false && /never-touch floor|floor was checked|resolves to/.test(aA.error || '') && JSON.stringify(snapshotTree(memA)) === JSON.stringify(memBeforeA) && !fs.existsSync(path.join(memA, 'SKILL.md')));
    fs.rmdirSync(evilA);
  }
  // (b) restore: the owner removed skills/demo/SKILL.md after the sync (absent = restorable); while the rollback reads the
  // backup copy, .claude/skills/demo becomes a junction into agent-memory/ — the restore must not write through it
  const pB = projWp2c('t138b');
  const v1B = sync.sha256(wfx(pB, '.claude/skills/demo/SKILL.md', '# demo v1\n'));
  const rcB = sync.readReceipt(pB); rcB.knownHashes['skills/demo/SKILL.md'] = v1B; sync.writeReceipt(pB, rcB);
  const sB = sync.safeSyncProject(tpl, pB, { batchId: 'b138b', nowIso: NOW_R3 });
  const demoB = path.join(pB, '.claude', 'skills', 'demo');
  const liveB = path.join(demoB, 'SKILL.md');
  const backupB = path.join(r4Bdir(pB, 'b138b'), 'skills', 'demo', 'SKILL.md');
  t('138b (the sync updated skills/demo/SKILL.md v1 -> v2 and backed v1 up)', sB.ok === true && rfx(pB, '.claude/skills/demo/SKILL.md') === '# demo v2\n' && fs.existsSync(backupB));
  fs.rmSync(liveB);
  const memB = path.join(pB, '.claude', 'agent-memory');
  const memBeforeB = snapshotTree(memB);
  const stB = { liveReads: 0, swapped: false, tried: false };
  const rbB = r6Wrap('readFileSync', (orig) => function (f, ...rest) {
    if (r6Same(f, liveB)) stB.liveReads++;
    if (!stB.tried && stB.liveReads >= 2 && r6Same(f, backupB)) { // after the divergence scan AND the restore's own sample
      stB.tried = true;
      fs.renameSync(demoB, demoB + '-moved');
      if (r3Junction(memB, demoB, '138b')) stB.swapped = true; else fs.renameSync(demoB + '-moved', demoB);
    }
    return orig.call(this, f, ...rest);
  }, () => sync.rollbackProject(pB, 'b138b', {}));
  if (stB.swapped) {
    t('138b the restore refuses to write through the swapped-in junction: agent-memory/ is byte-identical, the rollback is not ok', rbB.ok === false && JSON.stringify(snapshotTree(memB)) === JSON.stringify(memBeforeB) && !fs.existsSync(path.join(memB, 'SKILL.md')));
    fs.rmdirSync(demoB);
  }
  // (c) the primitive: a parent that resolves to another folder than the approved one -> refused, nothing staged
  const dC = freshDir('t138c');
  fs.mkdirSync(path.join(dC, 'a')); fs.mkdirSync(path.join(dC, 'b'));
  let threwC = null;
  try { sync.writeBytesNoFollow(Buffer.from('X'), path.join(dC, 'a', 'f.txt'), dC, { approvedRealParent: fs.realpathSync.native(path.join(dC, 'b')) }); } catch (e) { threwC = e.message; }
  t('138c writeBytesNoFollow refuses a parent other than the approved physical folder; nothing written, no temp left', !!threwC && /floor was checked/.test(threwC) && fs.readdirSync(path.join(dC, 'a')).length === 0);
  // (e) copyNoFollow — the writer of the retired-file / orphan ledger restores — takes the same guard
  const srcE = path.join(dC, 'src.txt'); fs.writeFileSync(srcE, 'S');
  let threwE = null;
  try { sync.copyNoFollow(srcE, path.join(dC, 'a', 'g.txt'), dC, { approvedRealParent: fs.realpathSync.native(path.join(dC, 'b')) }); } catch (e) { threwE = e.message; }
  t('138e copyNoFollow (the retired/orphan ledger restores) refuses a parent other than the approved physical folder; nothing written', !!threwE && /floor was checked/.test(threwE) && fs.readdirSync(path.join(dC, 'a')).length === 0);
  // (d) floor:true judges the writer's own destination: a parent that resolves into agent-memory/ is refused
  const pD = projWp2c('t138d');
  const memD = path.join(pD, '.claude', 'agent-memory');
  fs.mkdirSync(path.join(pD, '.claude', 'skills'), { recursive: true });
  const linkD = path.join(pD, '.claude', 'skills', 'x');
  if (r3Junction(memD, linkD, '138d')) {
    let threwD = null;
    try { sync.writeBytesNoFollow(Buffer.from('X'), path.join(linkD, 'f.md'), path.join(pD, '.claude'), { floor: true }); } catch (e) { threwD = e.message; }
    t('138d floor:true: a destination whose resolved parent is agent-memory/ is refused before staging', !!threwD && /never-touch/.test(threwD) && !fs.existsSync(path.join(memD, 'f.md')));
    fs.rmdirSync(linkD);
  }
});

console.log('\n139) R6 F16: a resume keeps the apply-journal anchor and checks the journal against it BEFORE rewriting the manifest or appending');
r4Section('139', () => {
  const { tpl } = tplHomeWp2c('t139-tpl', { settings: false });
  const ver = sync.templateVersion(tpl);
  /** attempt1(name, b) — the first attempt of batch b applied PART of its plan, anchored its journal, then "crashed". */
  const attempt1 = (name, b) => {
    const p = projWp2c(name);
    const plan = sync.buildPlan(tpl, p, {});
    const backup = sync.takeBackup(p, b, plan, ver, NOW_R3, {});
    const ap = sync.applyPlanSafely(tpl, p, { toChange: plan.toChange.slice(0, 2) }, null, { journalDirs: [backup.backupDir], batchId: b });
    const rec = sync.recordApplyJournalHead(backup, ap);
    return { p, b, backup, ap, rec, rest: plan.toChange.slice(2), man: path.join(backup.backupDir, 'manifest.json'), jr: path.join(backup.backupDir, sync.APPLY_JOURNAL_NAME) };
  };
  // (a) Codex's probe: the journal truncated to a VALID shorter chain (the chain alone cannot tell) -> the resume is refused
  const A = attempt1('t139a', 'b139a');
  t('139a (attempt 1 applied 2 of ' + (2 + A.rest.length) + ' entries and anchored its journal at seq ' + (A.rec.head && A.rec.head.seq) + ')', A.backup.ok && A.ap.ok && A.rec.recorded && A.rec.head.seq >= 2 && A.rest.length > 0);
  const linesA = fs.readFileSync(A.jr, 'utf8').split(/\r?\n/).filter(Boolean);
  fs.writeFileSync(A.jr, linesA[0] + '\n');
  const manA = fs.readFileSync(A.man);
  const restA = A.rest.map((e) => rfx(A.p, '.claude/' + e.rel));
  const rA = sync.safeSyncProject(tpl, A.p, { batchId: 'b139a', resumeBatch: true, nowIso: NOW_R3 });
  t('139a a journal truncated below its anchor refuses the resume, naming the recorded head', rA.ok === false && /head the manifest recorded|truncated/.test(rA.reason || ''));
  t('139a nothing was rewritten or appended: manifest.json byte-identical, the journal still one record, the rest of the plan unwritten', Buffer.compare(fs.readFileSync(A.man), manA) === 0 && fs.readFileSync(A.jr, 'utf8') === linesA[0] + '\n' && A.rest.every((e, i) => rfx(A.p, '.claude/' + e.rel) === restA[i]));
  // (b) an intact journal: the rebuilt manifest KEEPS the anchor, the resume continues the chain and re-anchors at its end
  const B = attempt1('t139b', 'b139b');
  const plan2 = sync.buildPlan(tpl, B.p, {});
  const bk2 = sync.takeBackup(B.p, 'b139b', plan2, ver, NOW_R3, {});
  const onDisk2 = JSON.parse(fs.readFileSync(B.man, 'utf8'));
  t('139b the resume\'s rebuilt manifest keeps the anchor attempt 1 recorded (in memory and on disk, still bound)', bk2.ok === true && !!bk2.manifest.apply_journal && bk2.manifest.apply_journal.head === B.rec.head.head && bk2.manifest.apply_journal.seq === B.rec.head.seq && !!onDisk2.apply_journal && onDisk2.apply_journal.seq === B.rec.head.seq && sync.manifestBinding(onDisk2, B.p, 'b139b').state === 'bound');
  const ap2 = sync.applyPlanSafely(tpl, B.p, plan2, null, { journalDirs: [bk2.backupDir], batchId: 'b139b', expectedHead: bk2.manifest.apply_journal });
  const rec2 = sync.recordApplyJournalHead(bk2, ap2);
  t('139b the resume continues the chain from the anchor and re-anchors at the new end (trusted, exact)', ap2.ok && rec2.recorded && rec2.head.seq > B.rec.head.seq && sync.readApplyJournal(bk2.backupDir, { batchId: 'b139b', expectedHead: rec2.head }).trusted === true);
  // (c) interrupted append, rule (b): an attempt appended chained records and crashed before re-anchoring -> accepted
  const C = attempt1('t139c', 'b139c');
  const apC = sync.applyPlanSafely(tpl, C.p, { toChange: C.rest.slice(0, 1) }, null, { journalDirs: [C.backup.backupDir], batchId: 'b139c' });
  const jC = sync.readApplyJournal(C.backup.backupDir, { batchId: 'b139c', expectedHead: C.rec.head, anchorPrefix: true });
  t('139c (complete chained records beyond the anchor: a prefix match, trusted, beyondAnchor > 0)', apC.ok && jC.trusted === true && jC.beyondAnchor > 0);
  const rC = sync.safeSyncProject(tpl, C.p, { batchId: 'b139c', resumeBatch: true, nowIso: NOW_R3 });
  const mC = JSON.parse(fs.readFileSync(C.man, 'utf8'));
  t('139c the resume accepts them, finishes the plan and re-anchors at the true end of the journal', rC.ok === true && rfx(C.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && !!mC.apply_journal && mC.apply_journal.seq === sync.readApplyJournal(C.backup.backupDir, { batchId: 'b139c' }).seq);
  // (d) interrupted append, rule (c): a record cut off mid-write -> the resume refuses BEFORE rewriting the manifest; the
  // stated recovery (rollback) then deletes nothing it cannot prove and restores the updates
  const D = attempt1('t139d', 'b139d');
  fs.appendFileSync(D.jr, '{"rel":"forge-bin/tool.cjs","action":"writ');
  const manD = fs.readFileSync(D.man);
  const rD = sync.safeSyncProject(tpl, D.p, { batchId: 'b139d', resumeBatch: true, nowIso: NOW_R3 });
  t('139d a record cut off mid-write refuses the resume naming the interrupted append; manifest.json byte-identical', rD.ok === false && /interrupted/.test(rD.reason || '') && Buffer.compare(fs.readFileSync(D.man), manD) === 0);
  const rbD = sync.rollbackProject(D.p, 'b139d', {});
  t('139d the stated recovery: rollback treats the journal as untrusted (keeps unproven creations) and tool.cjs ends at V1', rbD.ok === false && /journal-untrusted/.test(rbD.reason || '') && rfx(D.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  // (e) the primitive: anchor {genesis, 0} (an apply that recorded nothing) with no journal file is consistent, not untrusted
  const jE = sync.readApplyJournal(freshDir('t139e'), { batchId: 'b139e', expectedHead: { head: sync.JOURNAL_GENESIS, seq: 0 }, anchorPrefix: true });
  t('139e an empty anchor and no journal file: no reason, nothing proven', jE.present === false && jE.reason === null);
});

console.log('\n140) R6 F17: a journal head that cannot be persisted fails the batch and rolls its writes back — install AND --unsafe');
r4Section('140', () => {
  const { tpl } = tplHomeWp2c('t140-tpl', { settings: false });
  /** withFailedHeadWrite(p, b, fn) — the FIRST rename onto the batch's manifest.json after its apply journal exists throws
   *  ENOSPC: exactly recordApplyJournalHead's mandatory write (takeBackup wrote the manifest before any journal existed). */
  const withFailedHeadWrite = (p, b, fn) => {
    const man = path.join(r4Bdir(p, b), 'manifest.json'), jr = path.join(r4Bdir(p, b), sync.APPLY_JOURNAL_NAME);
    const st = { fired: false };
    const res = r6Wrap('renameSync', (orig) => function (from, to, ...rest) {
      if (!st.fired && r6Same(to, man) && fs.existsSync(jr)) { st.fired = true; const e = new Error('ENOSPC: no space left on device (injected by section 140)'); e.code = 'ENOSPC'; throw e; }
      return orig.call(this, from, to, ...rest);
    }, fn);
    return { res, fired: st.fired };
  };
  const pA = projWp2c('t140a');
  const A = withFailedHeadWrite(pA, 'b140a', () => sync.safeSyncProject(tpl, pA, { batchId: 'b140a', nowIso: NOW_R3 }));
  t('140a (the injected failure hit the journal-head write)', A.fired === true);
  t('140a install: ok:false naming the unrecorded journal head; the batch is rolled back (tool V1, the created seed gone, no version stamp)', A.res.ok === false && A.res.journalHeadFailed === true && A.res.rolledBack === true && /journal head could not be recorded/.test((A.res.reason || '') + (A.res.applyError || '')) && rfx(pA, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && rfx(pA, '.claude/FORGE_OWNER_PROFILE.json') === null && !fs.existsSync(sync.versionFilePath(pA)));
  const pB = projWp2c('t140b');
  const B = withFailedHeadWrite(pB, 'b140b', () => sync.rawInstall(tpl, pB, { batchId: 'b140b', nowIso: NOW_R3 }));
  t('140b --unsafe: ok:false, exit code 1, journalHeadFailed, rolled back (tool V1), no version stamp', B.fired === true && B.res.ok === false && B.res.exitCode === 1 && B.res.journalHeadFailed === true && B.res.rolledBack === true && rfx(pB, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && !fs.existsSync(sync.versionFilePath(pB)));
  t('140c journalHeadError: a kept journal without a recorded head is an error; a recorded head, or no journal at all, is not', typeof sync.journalHeadError === 'function' && /could not be recorded/.test(sync.journalHeadError({ journal: { head: 'x', seq: 1 } }, { recorded: false, reason: 'disk full' }) || '') && sync.journalHeadError({ journal: { head: 'x', seq: 1 } }, { recorded: true }) === null && sync.journalHeadError({ journal: null }, { recorded: false }) === null);
});

if (!PUB_GIT_OK) console.log('\n141) SKIP: git is not available here — the nested-project ignored-file inventory needs git; NOT exercised');
else r4Section('141', () => {
  console.log('\n141) R6 F18: in a project NESTED inside a larger repository the ignored-file inventory still sees ignored files');
  const { tpl } = tplHomeWp2c('t141-tpl', { settings: false });
  /** mkNested(name) — the repository is the fixture folder; the Forge project sits in it at proj/ (git prefix "proj/"). */
  const mkNested = (name) => {
    const p = projWp2c(name, { doctorExit: null });
    const repo = path.dirname(p);
    wfx(p, 'src/app.js', 'console.log("app");\n');
    wfx(p, '.gitignore', 'build/\n');
    wfx(p, 'build/old.js', 'an ignored build artefact\n');
    wfx(repo, 'README.md', '# the larger repository\n');
    const g = pubGit(repo); g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'repo']);
    return { p, repo };
  };
  const A = mkNested('t141a');
  const pfxA = String(spawnSync('git', ['-C', A.p, 'rev-parse', '--show-prefix'], { encoding: 'utf8' }).stdout || '').trim();
  const gA = sync.appCodeGitState(A.p, []);
  t('141a (the project is nested: git prefix "' + pfxA + '")', pfxA === 'proj/');
  t('141a the ignored inventory of the nested project counts build/old.js (1 file) and is not partial', !!gA && !!gA.ignored && gA.ignored.count === 1 && Array.isArray(gA.partial) && gA.partial.length === 0);
  const B = mkNested('t141b');
  writeDoctorStub(B.p, 0, r6OnPost(B.p, 'require("fs").writeFileSync(' + JSON.stringify(path.join(B.p, 'build', 'new.js')) + ', "built during the install");'));
  const rB = sync.safeSyncProject(tpl, B.p, { batchId: 'b141b', nowIso: NOW_R3 });
  t('141b an ignored file created during the install of a NESTED project is a violation ("(app) ignored files"); the batch rolls back', rB.ok === false && rB.protectViolation === true && sync.protectViolationLines(rB.protect).some((l) => /\(app\) ignored files/.test(l)) && rfx(B.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  const C = mkNested('t141c');
  const m0 = sync.buildProtectManifest(tpl, C.p, {});
  fs.rmSync(path.join(C.p, 'build', 'old.js'));
  const dC = sync.verifyProtect(C.p, m0, null);
  t('141c an ignored file of a nested project that vanishes is a violation too', dC.ok === false && dC.changed.some((c) => c.key === '(app) ignored files'));
});

if (!PUB_GIT_OK) console.log('\n142) SKIP: git is not available here — the dirty-submodule guard needs git; NOT exercised');
else r4Section('142', () => {
  console.log('\n142) R6 F19: a second edit inside an ALREADY-dirty submodule is seen (its worktree is fingerprinted); an unreadable worktree is guarded:"partial"');
  const { tpl } = tplHomeWp2c('t142-tpl', { settings: false });
  /** mkWithSub(name) — a git project with a submodule at vendor/sub that is already DIRTY (s.txt edited) before anything runs. */
  const mkWithSub = (name) => {
    const p = projWp2c(name, { doctorExit: null });
    wfx(p, 'src/app.js', 'console.log("app");\n');
    const g = pubGit(p); g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'app']);
    const sub = freshDir(name + '-sub'); fs.writeFileSync(path.join(sub, 's.txt'), 'S0\n');
    const gs = pubGit(sub); gs(['init', '-q']); gs(['add', '-A']); gs(['commit', '-q', '-m', 's']);
    const add = g(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub']);
    if (add.status !== 0) return { p, skip: String(add.stderr || '').trim().slice(0, 120) };
    // Section142-diagnosis 2026-10-10: at a very deep project path (about 200+ characters) `git submodule add` can exit 0 while git
    // itself cannot open the submodule ('$GIT_DIR' too big — git's internal PATH_MAX, not the Win32 limit core.longpaths lifts).
    // Then the guard correctly reports the submodule as unreadable (partial) and the fingerprint assertions below cannot hold:
    // skip visibly in that environment instead of failing.
    const probe = spawnSync('git', ['-C', path.join(p, 'vendor', 'sub'), 'rev-parse', '--show-prefix'], { encoding: 'utf8' });
    if (probe.status !== 0) return { p, skip: 'the submodule is unreadable at this path depth: ' + String(probe.stderr || '').trim().slice(0, 100) };
    g(['add', '-A']); g(['commit', '-q', '-m', 'sub']);
    fs.writeFileSync(path.join(p, 'vendor', 'sub', 's.txt'), 'S1: the first edit, already there before the install\n');
    return { p };
  };
  const A = mkWithSub('t142a');
  if (A.skip) console.log('  SKIP 142a-c — git submodule add failed here (' + A.skip + ')');
  else {
    const m0 = sync.buildProtectManifest(tpl, A.p, {});
    t('142a (the dirty submodule is one status line that now carries a worktree fingerprint; nothing partial)', typeof m0.git.entries['vendor/sub'] === 'string' && / dir:[0-9a-f]{64}$/.test(m0.git.entries['vendor/sub']) && m0.git.partial.length === 0);
    fs.writeFileSync(path.join(A.p, 'vendor', 'sub', 's.txt'), 'S2: a SECOND edit inside the already-dirty submodule\n');
    const dA = sync.verifyProtect(A.p, m0, null);
    t('142a a second edit inside the already-dirty submodule is a violation ("(app) vendor/sub")', dA.ok === false && dA.changed.some((c) => c.key === '(app) vendor/sub'));
    const m1 = sync.buildProtectManifest(tpl, A.p, {});
    fs.writeFileSync(path.join(A.p, 'vendor', 'sub', 'new.txt'), 'untracked, inside the submodule\n');
    t('142b a new untracked file inside the dirty submodule is a violation too', sync.verifyProtect(A.p, m1, null).changed.some((c) => c.key === '(app) vendor/sub'));
    const gC = sync.appCodeGitState(A.p, [], { __failProbe: 'submodule-worktree' });
    const dC = sync.diffProtectManifests(Object.assign({}, m1, { git: gC }), Object.assign({}, m1, { git: gC }), null);
    t('142c a submodule worktree that cannot be inventoried makes the guard "partial" and names vendor/sub — never true', Array.isArray(gC.partial) && gC.partial.some((x) => /vendor\/sub/.test(x)) && dC.appCode.guarded === 'partial' && /vendor\/sub/.test(dC.appCode.reason || ''));
  }
  const D = mkWithSub('t142d');
  if (D.skip) console.log('  SKIP 142d — git submodule add failed here (' + D.skip + ')');
  else {
    writeDoctorStub(D.p, 0, r6OnPost(D.p, 'require("fs").writeFileSync(' + JSON.stringify(path.join(D.p, 'vendor', 'sub', 's.txt')) + ', "S2 written by a doctor suite\\n");'));
    const rD = sync.safeSyncProject(tpl, D.p, { batchId: 'b142d', nowIso: NOW_R3 });
    t('142d end to end: a doctor suite editing the already-dirty submodule during the install is a violation naming (app) vendor/sub; rolled back', rD.ok === false && rD.protectViolation === true && sync.protectViolationLines(rD.protect).some((l) => /\(app\) vendor\/sub/.test(l)) && rfx(D.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  }
});

// =====================================================================================================================
// WP-SYNC-R7: the defects the 26H2 sync rehearsal exposed
// (.claude/forge-research/overhaul-2026-10-09/rehearsal-26h2/). One regression section per item; each one FAILS on the pre-fix
// forge-sync.cjs (proven with a scratch harness copy) and passes after:
// 143 template history + --accept-template · 144 per-suite regressions · 145 control characters in the process JSON ·
// 146 doctor limit + measured duration · 147 failure reason + report path · 148 development tree refused · 149 floor additions.
// Every fixture lives under os.tmpdir(); the CLI children get FORGE_SYNC_TEST_DEV_DIRS (fixture dev trees only, see the top).
// =====================================================================================================================
const NOW_R7 = '2026-10-10T20:00:00.000Z';
const R7_RULES = [SHIP_RULE('.claude/FORGE_SKILL_REGISTRY.md', 'ship-sync')]; // config/** (HOOKS_OPT_IN.md) is ship-sync in FX86_RULES
const h7 = (s) => require('crypto').createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
/** r7Template — a template (own home) shipping FORGE_SKILL_REGISTRY.md and config/orchestration/HOOKS_OPT_IN.md at V2. */
function r7Template(name, opts) {
  const { home, tpl } = tplHomeWp2c(name, Object.assign({ extraRules: R7_RULES }, opts || {}));
  wfx(tpl, 'FORGE_SKILL_REGISTRY.md', '# registry V2\n');
  wfx(tpl, 'config/orchestration/HOOKS_OPT_IN.md', '# hooks opt-in V2\n');
  return { home, tpl };
}
/** r7DevTree — a Forge DEVELOPMENT tree (marker + git): both files committed at V1, then edited to V2 WITHOUT a commit (the
 *  rehearsal's dirty development tree). opts.noMarker: the same repository without the marker (never a history source). */
function r7DevTree(name, opts) {
  const root = freshDir(name);
  const dev = path.join(root, '.claude');
  if (!(opts && opts.noMarker)) wfx(dev, 'config/forge-dev-tree.json', '{"dev_tree":true}\n');
  wfx(dev, 'FORGE_SKILL_REGISTRY.md', '# registry V1\n');
  wfx(dev, 'config/orchestration/HOOKS_OPT_IN.md', '# hooks opt-in V1\n');
  const g = pubGit(root); g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'v1']);
  wfx(dev, 'FORGE_SKILL_REGISTRY.md', '# registry V2\n');
  wfx(dev, 'config/orchestration/HOOKS_OPT_IN.md', '# hooks opt-in V2\n');
  return { root, dev };
}
/** r7Doctor(p, pre, post) — a doctor stub with a REAL per-suite list ([name, failedCount] pairs): `pre` until the sync wrote
 *  TOOL-V2 into tool.cjs, `post` after. `tests` (and the doctor) is red whenever any suite is red. */
function r7Doctor(p, preSuites, postSuites) {
  const tool = path.join(p, '.claude', 'forge-bin', 'tool.cjs');
  const per = (list) => list.map(([suite, failed]) => ({ suite, passed: 5, failed, ok: failed === 0, timedOut: false }));
  wfx(p, '.claude/forge-bin/forge-doctor.cjs', [
    '#!/usr/bin/env node',
    'var fs = require("fs");',
    'var post = false; try { post = fs.readFileSync(' + JSON.stringify(tool) + ', "utf8") === "TOOL-V2"; } catch (e) {}',
    'var per = post ? ' + JSON.stringify(per(postSuites)) + ' : ' + JSON.stringify(per(preSuites)) + ';',
    'var red = per.filter(function (s) { return !s.ok; });',
    'var ok = red.length === 0;',
    'var failed = red.reduce(function (a, s) { return a + s.failed; }, 0);',
    'var out = { ok: ok, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: ok, suites: per.length, passed: per.length * 5, failed: failed, suitesFailed: red.length, suitesBlocked: 0, perSuite: per } } };',
    'if (process.argv.indexOf("--json") !== -1) console.log(JSON.stringify(out));',
    'process.exit(ok ? 0 : 1);',
  ].join('\n'));
}
const r7Parsed = (suites) => {
  const ok = suites.every(([, f]) => f === 0);
  return { ok, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok, suites: suites.length, passed: 10, failed: suites.reduce((a, [, f]) => a + f, 0), perSuite: suites.map(([suite, failed]) => ({ suite, passed: 5, failed, ok: failed === 0, timedOut: false })) } } };
};
const r7Cli = (argv, tpl, extraEnv) => runCLI(argv, { env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tpl }, extraEnv || {}) });
const r7Read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

r4Section('143', () => {
  console.log('\n143) WP-SYNC-R7 item 1: a newly shipped file equal to an EARLIER template version is an unmodified copy, not drift; install --accept-template <rel>');
  // (a) the template's own publish history
  const A = r7Template('t143a-tpl');
  wfx(A.tpl, 'template-publish-receipt.json', JSON.stringify({ schema: sync.PUBLISH_RECEIPT_SCHEMA, batch: 'p0', files: { 'FORGE_SKILL_REGISTRY.md': h7('# registry V2\n') }, history: { 'FORGE_SKILL_REGISTRY.md': [h7('# registry V1\n'), h7('# registry V2\n')] } }, null, 2) + '\n');
  const pA = projWp2c('t143a');
  wfx(pA, '.claude/FORGE_SKILL_REGISTRY.md', '# registry V1\n'); // an earlier template version, NO baseline in the receipt
  const pfA = sync.preflight(A.tpl, pA);
  const rowA = pfA.toChange.find((e) => e.rel === 'FORGE_SKILL_REGISTRY.md');
  t('143a no baseline + bytes equal an earlier template version (publish history) -> an unmodified copy (template_history), NOT unknown drift', !!rowA && rowA.overrideClass === 'template_history' && rowA.historyMatch === 'publish-history' && !pfA.unknownDrift.includes('FORGE_SKILL_REGISTRY.md'));
  const pA2 = projWp2c('t143a2');
  wfx(pA2, '.claude/FORGE_SKILL_REGISTRY.md', '# registry, edited by the owner\n');
  const pfA2 = sync.preflight(A.tpl, pA2);
  t('143a CONTROL: bytes the template never had stay unknown drift (never overwritten silently)', pfA2.unknownDrift.includes('FORGE_SKILL_REGISTRY.md') && !pfA2.toChange.some((e) => e.rel === 'FORGE_SKILL_REGISTRY.md'));
  // (b) conflict-shaped (baseline V0, template V2, project V1 = an earlier template version) -> not a conflict either
  const pB = projWp2c('t143b');
  wfx(pB, '.claude/FORGE_SKILL_REGISTRY.md', '# registry V1\n');
  const rcB = sync.readReceipt(pB); rcB.knownHashes['FORGE_SKILL_REGISTRY.md'] = h7('# registry V0\n'); sync.writeReceipt(pB, rcB);
  const pfB = sync.preflight(A.tpl, pB);
  t('143b a conflict-shaped file whose bytes are an earlier template version is updated as an unmodified copy, not a conflict', pfB.conflicts.length === 0 && (pfB.toChange.find((e) => e.rel === 'FORGE_SKILL_REGISTRY.md') || {}).overrideClass === 'template_history');
  t('143b templateHistory:false switches the matcher off (back to drift/conflict)', sync.preflight(A.tpl, pB, { templateHistory: false }).conflicts.includes('FORGE_SKILL_REGISTRY.md'));

  if (!PUB_GIT_OK) console.log('  SKIP 143c-f: git is not available here — the development-tree / publish-history halves are NOT exercised');
  else {
    // (c) the rehearsal case: both files equal the COMMITTED version of a dirty development tree
    const D = r7DevTree('t143c-dev');
    const C = r7Template('t143c-tpl');
    const mkC = (name) => { const p = projWp2c(name); wfx(p, '.claude/FORGE_SKILL_REGISTRY.md', '# registry V1\n'); wfx(p, '.claude/config/orchestration/HOOKS_OPT_IN.md', '# hooks opt-in V1\n'); return p; };
    const pC = mkC('t143c');
    const pfC = sync.preflight(C.tpl, pC, { templateHistory: { devDirs: [D.dev] } });
    t('143c the rehearsal case: both newly shipped files equal the committed development-tree version -> matched (dev-git-history), no drift', pfC.unknownDrift.length === 0 && ['FORGE_SKILL_REGISTRY.md', 'config/orchestration/HOOKS_OPT_IN.md'].every((rel) => { const e = pfC.toChange.find((x) => x.rel === rel); return !!e && e.overrideClass === 'template_history' && e.historyMatch === 'dev-git-history'; }));
    t('143c CONTROL: with no development tree to consult (and no publish history) the same two files are unknown drift', sync.preflight(C.tpl, pC, { templateHistory: { devDirs: [] } }).unknownDrift.length === 2);
    const N = r7DevTree('t143d-nomarker', { noMarker: true });
    t('143d CONTROL: a git repository WITHOUT the development-tree marker is never consulted', sync.preflight(C.tpl, pC, { templateHistory: { devDirs: [N.dev] } }).unknownDrift.length === 2);
    // (e) end to end through the CLI, exactly like the rehearsal
    const pE = mkC('t143e');
    const blocked = r7Cli(['install', pE, '--batch-id', 'b143e0'], C.tpl);
    t('143e CONTROL (CLI): no development tree to consult -> the install is BLOCKED by the two files (exit 1), nothing stamped', blocked.status === 1 && rfx(pE, '.claude/FORGE_SKILL_REGISTRY.md') === '# registry V1\n' && rfx(pE, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
    const okRun = r7Cli(['install', pE, '--batch-id', 'b143e1'], C.tpl, { FORGE_SYNC_TEST_DEV_DIRS: JSON.stringify([D.dev]) });
    const rcE = sync.readReceipt(pE) || {};
    t('143e (CLI) with the development tree as history source the install succeeds (exit 0) and both files take the template version', okRun.status === 0 && rfx(pE, '.claude/FORGE_SKILL_REGISTRY.md') === '# registry V2\n' && rfx(pE, '.claude/config/orchestration/HOOKS_OPT_IN.md') === '# hooks opt-in V2\n');
    t('143e the receipt lists both as template-history matches, the batch backup holds the V1 copies, the report explains it',
      JSON.stringify((rcE.templateHistoryMatches || []).map((m) => m.rel + ':' + m.by)) === JSON.stringify(['FORGE_SKILL_REGISTRY.md:dev-git-history', 'config/orchestration/HOOKS_OPT_IN.md:dev-git-history'])
      && rfx(pE, '.claude/forge-backups/b143e1/FORGE_SKILL_REGISTRY.md') === '# registry V1\n' && /Earlier template copies/.test(r7Read(path.join(pE, '.claude', 'forge-sync-report-b143e1.md'))));
    // (f) publish-template keeps a cumulative per-path history, and install reads it
    const fx = pubFixture('t143f');
    const p1 = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p143f1', nowIso: NOW_R7 }));
    const rc1 = pubJson(rfx(fx.tpl, 'template-publish-receipt.json')) || {};
    t('143f publish-template records the per-path history: the bytes it replaced AND the bytes it published', p1.ok === true && !!rc1.history && JSON.stringify(rc1.history['forge-bin/tool.cjs']) === JSON.stringify([h7('TOOL-V1\n'), h7('TOOL-V2\n')]));
    wfx(fx.dev, 'forge-bin/tool.cjs', 'TOOL-V3\n'); fx.g(['add', '-A']); fx.g(['commit', '-q', '-m', 'v3']);
    const p2 = sync.applyPublishTemplate(pubOpts(fx, { batchId: 'p143f2', nowIso: NOW_R7 }));
    const rc2 = pubJson(rfx(fx.tpl, 'template-publish-receipt.json')) || {};
    t('143f a second publish keeps it cumulative (V1, V2, V3 — oldest first); the backup receipt does not duplicate it', p2.ok === true && !!rc2.history && JSON.stringify(rc2.history['forge-bin/tool.cjs']) === JSON.stringify([h7('TOOL-V1\n'), h7('TOOL-V2\n'), h7('TOOL-V3\n')]) && !('history' in (pubJson(rfx(p2.backupDir || '', 'receipt.json')) || { history: 1 })));
    const pF = makeProject(freshDir('t143f-root'), 'proj', 0);
    wfx(pF, '.claude/forge-bin/tool.cjs', 'TOOL-V1\n'); // still on the template's OLDEST version, no receipt at all
    const pfF = sync.preflight(fx.tpl, pF, { templateHistory: { git: false } });
    t('143f install reads that history: a project still on the oldest template version (no receipt) is an unmodified copy', (pfF.toChange.find((e) => e.rel === 'forge-bin/tool.cjs') || {}).historyMatch === 'publish-history' && !pfF.unknownDrift.includes('forge-bin/tool.cjs'));
  }

  // (g) --accept-template <rel>: the per-file alternative to --force-overwrite
  const G = r7Template('t143g-tpl');
  const mkG = (name) => { const p = projWp2c(name); wfx(p, '.claude/FORGE_SKILL_REGISTRY.md', '# registry, owner notes\n'); wfx(p, '.claude/config/orchestration/HOOKS_OPT_IN.md', '# hooks, owner notes\n'); return p; };
  const pa = sync.parseArgs(['proj', '--accept-template', 'FORGE_SKILL_REGISTRY.md', '--accept-template', '.claude\\config\\orchestration\\HOOKS_OPT_IN.md']);
  t('143g --accept-template is repeatable (every value collected, none becomes a positional)', !pa.argError && JSON.stringify(pa.flags.acceptTemplate) === JSON.stringify(['FORGE_SKILL_REGISTRY.md', '.claude\\config\\orchestration\\HOOKS_OPT_IN.md']) && JSON.stringify(pa.pos) === JSON.stringify(['proj']));
  t('143g --accept-template without a value is a usage error', !!sync.parseArgs(['proj', '--accept-template']).argError && !!sync.parseArgs(['proj', '--accept-template', '--dry-run']).argError);
  const g1 = mkG('t143g1');
  const rg1 = sync.safeSyncProject(G.tpl, g1, { batchId: 'b143g1', nowIso: NOW_R7, refuseOnUnresolvedDrift: true, acceptTemplate: ['FORGE_SKILL_REGISTRY.md'] });
  t('143g accepting ONE of two drifted files keeps the all-or-nothing install: refused, rolled back, the other file named', rg1.ok === false && rg1.refusedPartialDrift === true && rg1.rolledBack === true && JSON.stringify(rg1.plan.unknownDrift) === JSON.stringify(['config/orchestration/HOOKS_OPT_IN.md']) && rfx(g1, '.claude/FORGE_SKILL_REGISTRY.md') === '# registry, owner notes\n');
  const g2 = mkG('t143g2');
  const rg2 = sync.safeSyncProject(G.tpl, g2, { batchId: 'b143g2', nowIso: NOW_R7, refuseOnUnresolvedDrift: true, acceptTemplate: ['FORGE_SKILL_REGISTRY.md', '.claude/config/orchestration/HOOKS_OPT_IN.md', 'forge-bin/tool.cjs'] });
  t('143g accepting both: the sync succeeds, exactly those files take the template version, project memory untouched', rg2.ok === true && rfx(g2, '.claude/FORGE_SKILL_REGISTRY.md') === '# registry V2\n' && rfx(g2, '.claude/config/orchestration/HOOKS_OPT_IN.md') === '# hooks opt-in V2\n' && rfx(g2, '.claude/FORGE_MEMORY.md') === '# project memory\n');
  const at2 = (rg2.receipt && rg2.receipt.acceptTemplate) || { accepted: [], unused: [] };
  t('143g the receipt records what was accepted (and from which state) and what was not needed', JSON.stringify(at2.accepted) === JSON.stringify([{ rel: 'FORGE_SKILL_REGISTRY.md', was: 'unknown_drift' }, { rel: 'config/orchestration/HOOKS_OPT_IN.md', was: 'unknown_drift' }]) && at2.unused.length === 1 && at2.unused[0].rel === 'forge-bin/tool.cjs');
  const rep2 = rg2.report && rg2.report.path ? r7Read(rg2.report.path) : '';
  t('143g the change report has an --accept-template section, and the owner copies are in the batch backup', /## Accepted template versions \(--accept-template\)/.test(rep2) && /REPLACED by the template version/.test(rep2) && rfx(g2, '.claude/forge-backups/b143g2/FORGE_SKILL_REGISTRY.md') === '# registry, owner notes\n');
  const g3 = mkG('t143g3');
  const before3 = JSON.stringify(snapshotTree(g3));
  const rg3 = sync.safeSyncProject(G.tpl, g3, { batchId: 'b143g3', nowIso: NOW_R7, refuseOnUnresolvedDrift: true, acceptTemplate: ['FORGE_SKILL_REGISTRY.md', 'config/orchestration/HOOKS_OPT_IN.md', 'no/such-file.md', 'FORGE_OWNER_PROFILE.json', 'FORGE_MEMORY.md'] });
  t('143g a name it cannot accept (unknown / seed-only / never-touch) REFUSES the install before any write, each with its reason', rg3.ok === false && rg3.refused === true && rg3.refusedAcceptTemplate === true && /no\/such-file\.md/.test(rg3.reason) && /seed-only/.test(rg3.reason) && /never-touch/.test(rg3.reason) && JSON.stringify(snapshotTree(g3)) === before3);
  t('143g ...and a dry-run says it would refuse', /--accept-template/.test(sync.safeSyncProject(G.tpl, g3, { dryRun: true, acceptTemplate: ['no/such-file.md'] }).wouldRefuse || ''));
  const g4 = mkG('t143g4');
  const cli4 = r7Cli(['install', g4, '--batch-id', 'b143g4', '--accept-template', 'FORGE_SKILL_REGISTRY.md', '--accept-template', 'config/orchestration/HOOKS_OPT_IN.md'], G.tpl);
  t('143g (CLI) install --accept-template x --accept-template y succeeds (exit 0) and says what it replaced', cli4.status === 0 && rfx(g4, '.claude/FORGE_SKILL_REGISTRY.md') === '# registry V2\n' && /--accept-template: replaced by the template version/.test(cli4.stdout));
  t('143g (CLI) --accept-template is refused for sync-all (usage error, exit 2: it names files of ONE project)', r7Cli(['sync-all', freshDir('t143g-root'), '--dry-run', '--accept-template', 'FORGE_SKILL_REGISTRY.md'], G.tpl).status === 2);
});

r4Section('144', () => {
  console.log('\n144) WP-SYNC-R7 item 2: every suite is carried and compared — a suite going red while `tests` was already red is a regression');
  const twelve = [];
  for (let i = 1; i <= 12; i++) twelve.push(['s' + String(i).padStart(2, '0') + '.test.cjs', i <= 10 ? i : 0]);
  const sum12 = sync.condenseDoctorSummary(r7Parsed(twelve));
  t('144a the summary carries EVERY failing suite (10 of 12 red — the old list stopped at 8)', Array.isArray(sum12.failing_suites) && sum12.failing_suites.length === 10 && /s10\.test\.cjs \(10 failed\)/.test(sum12.failing_suites.join('|')));
  t('144a ...plus a name -> green map of all 12 suites (names only, no failure text)', !!sum12.suiteOk && Object.keys(sum12.suiteOk).length === 12 && sum12.suiteOk['s11.test.cjs'] === true && sum12.suiteOk['s01.test.cjs'] === false && Object.values(sum12.suiteOk).every((v) => typeof v === 'boolean'));
  const pre = sync.condenseDoctorSummary(r7Parsed([['a.test.cjs', 2], ['b.test.cjs', 0], ['c.test.cjs', 0]]));
  const post = sync.condenseDoctorSummary(r7Parsed([['a.test.cjs', 3], ['b.test.cjs', 1], ['c.test.cjs', 0], ['d.test.cjs', 1]]));
  const reg = sync.regressionCheck(pre, post);
  t('144b `tests` red before AND after: a suite that went green -> red (b) and one red for the first time (d) are regressions', reg.includes('suite:b.test.cjs') && reg.includes('suite:d.test.cjs'));
  t('144b ...the already-red suite (a) and the still-green one (c) are not', !reg.includes('suite:a.test.cjs') && !reg.includes('suite:c.test.cjs'));
  const out = sync.decideValidationOutcome({ ok: false, summary: pre }, { ok: false, exitCode: 1, summary: post }, {});
  t('144c decideValidationOutcome: NOT "already red, not attributed" — it fails and names each suite and how it regressed', out.ok === false && !out.alreadyRedSkipped && /b\.test\.cjs \(green->red\)/.test(out.reason) && /d\.test\.cjs \(red for the first time\)/.test(out.reason));
  const same = sync.decideValidationOutcome({ ok: false, summary: pre }, { ok: false, exitCode: 1, summary: sync.condenseDoctorSummary(r7Parsed([['a.test.cjs', 5], ['b.test.cjs', 0], ['c.test.cjs', 0]])) }, {});
  t('144c CONTROL: the same red suite (a, more failures) and nothing new -> still already-red, and it says the suites WERE compared', same.ok === true && same.alreadyRedSkipped === true && same.suitesCompared === true);
  // (d) end to end — the rehearsal: `tests` already red, the sync turns one suite red and ships a new red suite
  const p = projWp2c('t144d', { doctorExit: null });
  r7Doctor(p, [['a.test.cjs', 2], ['b.test.cjs', 0]], [['a.test.cjs', 2], ['b.test.cjs', 1], ['new.test.cjs', 1]]);
  const { tpl } = tplHomeWp2c('t144d-tpl');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b144d', nowIso: NOW_R7 });
  t('144d end to end: FAILED and rolled back, the reason names b (green->red) and new (red for the first time)', r.ok === false && r.rolledBack === true && rfx(p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && !!r.outcome && /b\.test\.cjs \(green->red\)/.test(r.outcome.reason || '') && /new\.test\.cjs \(red for the first time\)/.test(r.outcome.reason || ''));
  t('144d the change report names the regressed suites', /b\.test\.cjs \(green->red\)/.test(r.report && r.report.path ? r7Read(r.report.path) : ''));
  const rep = sync.buildSyncReport({ projectDir: p, batchId: 'b144e', outcome: 'X', plan: { toChange: [] }, validation: { tool: 'forge-doctor', ok: false, summary: sum12 } });
  t('144e the change report lists all 10 failing suites by name (it used to stop at 8)', twelve.slice(0, 10).every(([n]) => rep.includes(n)));
});

r4Section('145', () => {
  console.log('\n145) WP-SYNC-R7 item 3: a raw control character (0x1A) in one process command line no longer breaks the process listing');
  const hasSeam = typeof sync.parseWin32ProcessJson === 'function'; // never call the pre-fix listProcessesStructured: it would list THIS machine
  const procs = [{ ProcessId: 4, ParentProcessId: 0, Name: 'System', CommandLine: null }, { ProcessId: 37916, ParentProcessId: 4, Name: 'node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" xMARKy "quoted"' }];
  const raw = JSON.stringify(procs).replace('MARK', String.fromCharCode(0x1a));
  let rawFails = false; try { JSON.parse(raw); } catch (e) { rawFails = /control character/i.test(e.message); }
  t('145a (the defect) JSON.parse rejects PowerShell 5.1 output with a raw 0x1A inside a string', rawFails === true);
  const parsed = hasSeam ? sync.parseWin32ProcessJson(raw + '\r\n') : null;
  t('145a parseWin32ProcessJson escapes it first: 2 processes, the command line intact (quotes, backslashes and the 0x1A itself)', Array.isArray(parsed) && parsed.length === 2 && parsed[1].pid === 37916 && parsed[1].cmd === '"C:\\Program Files\\nodejs\\node.exe" x\u001ay "quoted"' && parsed[0].cmd === null);
  const pretty = JSON.stringify(procs, null, '\t').replace('MARK', '\u001a\u0001');
  t('145a JSON whitespace between tokens (newlines, tabs) is left alone; only characters inside strings are escaped', hasSeam && sync.parseWin32ProcessJson(pretty).length === 2 && sync.escapeJsonStringControlChars('{"a":"b"}') === '{"a":"b"}');
  const calls = [];
  const fake = (cmd) => { calls.push(cmd); return { status: 0, stdout: raw + '\r\n', stderr: '' }; };
  const list = hasSeam ? sync.listProcessesStructured({ platform: 'win32', spawnSyncImpl: fake }) : null;
  t('145b listProcessesStructured (win32) parses that listing instead of throwing (fake spawn — this machine is never listed)', Array.isArray(list) && list.length === 2 && calls.length === 1 && calls[0] === 'powershell');
  const p = makeProject(freshDir('t145c-root'), 'proj', null);
  const q = hasSeam ? sync.quiesceCheck(p, { nowMs: Date.parse(NOW_R7), projectsRoot: freshDir('t145c-projects'), listProcesses: () => sync.listProcessesStructured({ platform: 'win32', spawnSyncImpl: fake }), selfPid: 424242, parentPid: 424241 }) : null;
  t('145c quiesce-check: the processes check is ok (no longer "unknown"), so an idle project is IDLE', !!q && q.checks.processes.state === 'ok' && q.idle === true);
});

r4Section('146', () => {
  console.log('\n146) WP-SYNC-R7 item 4: the doctor limit is at least 1800 s (or 12 s per suite) and the measured duration is recorded');
  t('146a DEFAULT_DOCTOR_TIMEOUT_MS is at least 1800 s (the rehearsal measured 791-1091 s and timed out once at 900 s)', sync.DEFAULT_DOCTOR_TIMEOUT_MS >= 1800000);
  const hasFn = typeof sync.doctorTimeoutFor === 'function';
  const pMany = makeProject(freshDir('t146b'), 'proj', 0);
  for (let i = 0; i < 200; i++) wfx(pMany, '.claude/forge-bin/s' + i + '.test.cjs', '// stub suite\n');
  const lim = hasFn ? sync.doctorTimeoutFor(pMany) : null;
  t('146b with 200 suites the limit grows with the suite count (200 x 12 s = 2400 s)', !!lim && lim.timeoutMs === 2400000 && lim.source === 'suite-count');
  const pFew = makeProject(freshDir('t146b2'), 'proj', 0);
  t('146b with few suites it is the 1800 s default; an explicit --doctor-timeout always wins', hasFn && sync.doctorTimeoutFor(pFew).timeoutMs === 1800000 && sync.doctorTimeoutFor(pFew).source === 'default' && sync.doctorTimeoutFor(pMany, 5000).timeoutMs === 5000 && sync.doctorTimeoutFor(pMany, 5000).source === 'flag');
  const v = sync.runValidation(pFew, { toChange: [] });
  t('146c runValidation records the measured duration and the limit it ran under', Number.isFinite(v.durationMs) && v.durationMs >= 0 && v.timeoutMs === 1800000 && v.timeoutSource === 'default');
  const pSlow = makeProject(freshDir('t146d'), 'proj', null);
  wfx(pSlow, '.claude/forge-bin/forge-doctor.cjs', 'setTimeout(function () {}, 20000);\n');
  const vs = sync.runValidation(pSlow, { toChange: [] }, { doctorTimeoutMs: 1500 });
  const os2 = sync.decideValidationOutcome(null, vs, {});
  t('146d a timeout says after how long, under which limit, and how to raise it', vs.timedOut === true && vs.timeoutMs === 1500 && os2.timedOut === true && /after 2 s \(flag limit/.test(os2.reason) && /--doctor-timeout/.test(os2.reason));
  const rep = sync.buildSyncReport({ projectDir: pFew, batchId: 'b146e', outcome: 'SYNCED', plan: { toChange: [] },
    preValidation: { tool: 'forge-doctor', ok: true, durationMs: 512345, timeoutMs: 1800000, timeoutSource: 'default', summary: null },
    validation: { tool: 'forge-doctor', ok: true, durationMs: 812345, timeoutMs: 2400000, timeoutSource: 'suite-count', summary: null } });
  t('146e the change report states the measured doctor duration and its limit, before and after', /Before: .*took 512 s \(limit 1800 s, default\)/.test(rep) && /After: .*took 812 s \(limit 2400 s, suite-count\)/.test(rep));
  const p = projWp2c('t146f');
  const { tpl } = tplHomeWp2c('t146f-tpl');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b146f', nowIso: NOW_R7 });
  t('146f the receipt records both doctor runs\' durations and the limit', r.ok === true && Number.isFinite(r.receipt.validation.durationMs) && r.receipt.validation.timeoutMs === 1800000 && Number.isFinite(r.receipt.preValidation.durationMs));
});

r4Section('147', () => {
  console.log('\n147) WP-SYNC-R7 item 5: a failed validation prints WHY and where the change report is');
  const p = projWp2c('t147a', { doctorExit: null });
  r7Doctor(p, [['a.test.cjs', 0], ['b.test.cjs', 0]], [['a.test.cjs', 0], ['b.test.cjs', 2]]);
  const { tpl } = tplHomeWp2c('t147a-tpl');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b147a', nowIso: NOW_R7 });
  const printed = quiet(() => sync.printSafeSyncResult(p, r)).out.join('\n');
  t('147a (setup) the validation failed and was rolled back, with an outcome reason and a written report', r.ok === false && r.rolledBack === true && !!r.outcome && typeof r.outcome.reason === 'string' && !!(r.report && r.report.path) && fs.existsSync(r.report.path));
  t('147a the printed result carries the reason, naming what was red', printed.includes('reason: ' + r.outcome.reason) && /b\.test\.cjs \(2 failed\)/.test(printed));
  t('147a ...and the change report path', !!(r.report && r.report.path) && printed.includes('change report: ' + r.report.path));
  const G = r7Template('t147b-tpl');
  const pb = projWp2c('t147b');
  wfx(pb, '.claude/FORGE_SKILL_REGISTRY.md', '# registry, owner notes\n');
  const rb = sync.safeSyncProject(G.tpl, pb, { batchId: 'b147b', nowIso: NOW_R7, refuseOnUnresolvedDrift: true });
  const printedB = quiet(() => sync.printSafeSyncResult(pb, rb)).out.join('\n');
  t('147b a drift-blocked (rolled back) install names its change report too', rb.refusedPartialDrift === true && !!(rb.report && rb.report.path) && printedB.includes('change report: ' + rb.report.path));
  const pc = projWp2c('t147c', { doctorExit: null });
  r7Doctor(pc, [['a.test.cjs', 0]], [['a.test.cjs', 1]]);
  const cli = runCLIWithTemplate(['install', pc, '--batch-id', 'b147c'], tpl);
  t('147c (CLI) install exits 1 and its output names the reason and the change report', cli.status === 1 && /reason: post-sync validation failed/.test(cli.stderr) && /change report: .*forge-sync-report-b147c\.md/.test(cli.stderr));
});

r4Section('148', () => {
  console.log('\n148) WP-SYNC-R7 item 6: a Forge development tree is refused as a sync target (and skipped by sync-all)');
  const { tpl } = tplHomeWp2c('t148-tpl');
  const mkDev = (name) => { const p = projWp2c(name); wfx(p, '.claude/config/forge-dev-tree.json', '{"dev_tree":true}\n'); return p; };
  const a = mkDev('t148a');
  const beforeA = JSON.stringify(snapshotTree(a));
  const rA = sync.safeSyncProject(tpl, a, { batchId: 'b148a', nowIso: NOW_R7 });
  t('148a install into a development tree is REFUSED with a plain message, nothing written', rA.ok === false && rA.refused === true && rA.refusedDevTree === true && /DEVELOPMENT TREE/.test(rA.reason) && /--allow-dev-tree-target/.test(rA.reason) && JSON.stringify(snapshotTree(a)) === beforeA);
  const dA = sync.safeSyncProject(tpl, a, { dryRun: true });
  t('148b a dry-run says it would refuse', /DEVELOPMENT TREE/.test(dA.wouldRefuse || ''));
  const uA = quiet(() => sync.rawInstall(tpl, a, { batchId: 'b148c', nowIso: NOW_R7 })).r;
  t('148c --unsafe refuses it too, nothing written', uA.ok === false && uA.refusedDevTree === true && JSON.stringify(snapshotTree(a)) === beforeA);
  const d = mkDev('t148d');
  const rD = sync.safeSyncProject(tpl, d, { batchId: 'b148d', nowIso: NOW_R7, allowDevTreeTarget: 'owner: rehearse a self-sync on a throwaway copy' });
  t('148d with --allow-dev-tree-target "<reason>" it proceeds; the receipt and the report record the reason', rD.ok === true && rfx(d, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && !!rD.receipt.devTreeTarget && rD.receipt.devTreeTarget.override === 'owner: rehearse a self-sync on a throwaway copy' && /rehearse a self-sync/.test(rD.report && rD.report.path ? r7Read(rD.report.path) : ''));
  const cli1 = runCLIWithTemplate(['install', mkDev('t148e'), '--batch-id', 'b148e'], tpl);
  t('148e (CLI) install refuses a development tree: exit 1 with the plain message', cli1.status === 1 && /DEVELOPMENT TREE/.test(cli1.stderr));
  const e2 = mkDev('t148e2');
  const cli2 = runCLIWithTemplate(['install', e2, '--batch-id', 'b148e2', '--allow-dev-tree-target', 'owner approved for a test copy'], tpl);
  t('148e (CLI) --allow-dev-tree-target "<reason>" lets it through (exit 0)', cli2.status === 0 && rfx(e2, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  t('148e (CLI) a too-short reason is a usage error (exit 2)', runCLIWithTemplate(['install', mkDev('t148e3'), '--allow-dev-tree-target', 'x'], tpl).status === 2);
  // sync-all: a discovered development tree is skipped (named), the real project is still synced
  const root = freshDir('t148f-root');
  const devP = makeProject(root, 'devtree', 0); makeRealProjectMarker(devP); wfx(devP, '.claude/config/forge-dev-tree.json', '{"dev_tree":true}\n');
  const normP = makeProject(root, 'normal', 0); makeRealProjectMarker(normP);
  const sa = quiet(() => sync.runSyncAll(tpl, root, { dryRun: true, batchId: 'b148f', nowIso: NOW_R7 })).r;
  t('148f sync-all (dry-run) skips a development tree it discovers, names it, and still plans the real project', Array.isArray(sa.skippedDevTrees) && sa.skippedDevTrees.length === 1 && path.basename(sa.skippedDevTrees[0]) === 'devtree' && sa.projects.length === 1 && path.basename(sa.projects[0].projectDir) === 'normal');
  const devBefore = JSON.stringify(snapshotTree(devP));
  const canaryDoc = wfx(root, 'canary-doctor.cjs', 'if (process.argv.indexOf("--json") !== -1) console.log(JSON.stringify({ ok: true, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 } } }));\n');
  const real = quiet(() => sync.runSyncAll(tpl, root, { batchId: 'b148g', nowIso: NOW_R7, canaryDoctorSource: canaryDoc })).r;
  t('148g a real sync-all syncs the real project and leaves the development tree byte-identical', real.ok === true && rfx(normP, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && JSON.stringify(snapshotTree(devP)) === devBefore);
});

r4Section('149', () => {
  console.log('\n149) WP-SYNC-R7 item 7: .claude/forge-adoption/ and .claude/FORGE-SYNC-BRIEFING.md are never shipped, overwritten or retired');
  t('149a both are on the never-touch floor (any case); forge-adoption/ as a whole folder', sync.isNeverTouch('forge-adoption/adopt-record.json') && sync.isNeverTouch('forge-adoption/sub/x.md') && sync.isNeverTouchDir('forge-adoption') && sync.NEVER_TOUCH_DIRS.has('forge-adoption') && sync.isNeverTouch('FORGE-SYNC-BRIEFING.md') && sync.isNeverTouch('forge-sync-briefing.md') && sync.NEVER_TOUCH_FILES.has('FORGE-SYNC-BRIEFING.md'));
  const tpl = freshDir('t149-tpl');
  writeTplManifest(tpl, [SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync'), SHIP_RULE('.claude/forge-adoption/**', 'ship-sync'), SHIP_RULE('.claude/FORGE-SYNC-BRIEFING.md', 'ship-sync')]);
  wfx(tpl, 'forge-bin/tool.cjs', 'TEMPLATE-TOOL');
  wfx(tpl, 'forge-adoption/adopt-record.json', '{"template":"copy"}\n');
  wfx(tpl, 'FORGE-SYNC-BRIEFING.md', '# template briefing\n');
  const sp = sync.shipPlan(tpl);
  t('149b a manifest that claims them ship-sync delivers neither (reported as neverTouchClaimed)', JSON.stringify(sp.system) === JSON.stringify(['forge-bin/tool.cjs']) && sp.neverTouchClaimed.some((n) => n.rel === 'forge-adoption/') && sp.neverTouchClaimed.some((n) => n.rel === 'FORGE-SYNC-BRIEFING.md'));
  const p = makeProject(freshDir('t149-root'), 'proj', 0);
  wfx(p, '.claude/forge-adoption/adopt-record.json', '{"project":"own record"}\n');
  wfx(p, '.claude/FORGE-SYNC-BRIEFING.md', '# this project\'s own briefing\n');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b149', nowIso: NOW_R7, forceOverwrite: true });
  t('149b even a --force-overwrite sync leaves the project\'s own copies byte-identical', r.ok === true && rfx(p, '.claude/forge-adoption/adopt-record.json') === '{"project":"own record"}\n' && rfx(p, '.claude/FORGE-SYNC-BRIEFING.md') === '# this project\'s own briefing\n' && rfx(p, '.claude/forge-bin/tool.cjs') === 'TEMPLATE-TOOL');
  const tplClean = freshDir('t149c-tpl');
  writeTplManifest(tplClean, [SHIP_RULE('.claude/forge-bin/*.cjs', 'ship-sync')]);
  wfx(tplClean, 'forge-bin/tool.cjs', 'TEMPLATE-TOOL');
  const p2 = makeProject(freshDir('t149c-root'), 'proj', 0);
  const hA = sync.sha256(wfx(p2, '.claude/forge-adoption/adopt-record.json', '{"a":1}\n'));
  const hB = sync.sha256(wfx(p2, '.claude/FORGE-SYNC-BRIEFING.md', '# briefing\n'));
  sync.writeReceipt(p2, { knownHashes: { 'forge-adoption/adopt-record.json': hA, 'FORGE-SYNC-BRIEFING.md': hB } }); // a receipt that claims forge-sync shipped them
  const orph = sync.findOrphans(p2, { system: ['forge-bin/tool.cjs'], seed: [] });
  t('149c the orphan report never lists them, so --retire-orphans can never move them', !orph.unmodified.concat(orph.modified).some((o) => /forge-adoption|FORGE-SYNC-BRIEFING/.test(o.rel)));
  const r2 = sync.safeSyncProject(tplClean, p2, { batchId: 'b149c', nowIso: NOW_R7, retireOrphans: true });
  t('149c a real --retire-orphans sync leaves both in place, byte-identical', r2.ok === true && rfx(p2, '.claude/forge-adoption/adopt-record.json') === '{"a":1}\n' && rfx(p2, '.claude/FORGE-SYNC-BRIEFING.md') === '# briefing\n');
  const src = fs.readFileSync(CLI, 'utf8');
  t('149d the stale "the doctor gives each suite up to 300 s" comment is gone; it states the real limit (1500 s since WP-LIMITS)', !/gives each suite up to\s+300 s/.test(src) && !/gives each suite up to\s+600 s/.test(src) && /gives each suite up to 1500 s/.test(src));
});

// =====================================================================================================================
// WP-SYNC-R8. FOUND during the real 26H2 sync: that project's
// .claude/worktrees held 98 folders, 93 of them full git checkouts, about 3.2 million files (29.5 GB). buildProtectManifest
// walked .claude recursively and would have hashed every one of them (hours); git's ignored listing walked the folder too.
// Fixture: 40 sub-checkouts x 300 files, each with a .git file, every file named HASHME-<i>-<j> so any trace of one in a
// manifest is detectable. Bounds are asserted on fs-call COUNTS and entry counts, never on wall-clock time.
// =====================================================================================================================
const R8_WT = 40, R8_PER = 300;
const R8_INSIDE_WT = /[\\/]\.claude[\\/]worktrees[\\/]/i;
/** r8Worktrees(p, n, per) — n fake agent checkouts (a .git FILE each, like `git worktree add`) with `per` files each. */
function r8Worktrees(p, n, per) {
  for (let i = 0; i < n; i++) {
    wfx(p, '.claude/worktrees/agent-' + i + '/.git', 'gitdir: ' + path.join(p, '.git', 'worktrees', 'agent-' + i) + '\n');
    for (let j = 0; j < per; j++) wfx(p, '.claude/worktrees/agent-' + i + '/src/d' + (j % 10) + '/HASHME-' + i + '-' + j + '.txt', 'HASHME ' + i + '/' + j + '\n');
  }
}
/** r8CountFs(fn) -> {r, total, inside, readdirOfWorktrees} — counts fs reads made while fn runs (the module shares this fs). */
function r8CountFs(fn) {
  const names = ['readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'openSync', 'readlinkSync'];
  const orig = {};
  // WP-SYNC-R10: insideBeyondGit = calls inside .claude/worktrees on anything OTHER than a checkout's own .git entry
  const c = { total: 0, inside: 0, insidePaths: [], insideBeyondGit: 0, beyondGitPaths: [], readdirOfWorktrees: 0 };
  for (const n of names) {
    orig[n] = fs[n];
    fs[n] = function (p, ...rest) {
      const s = String(p);
      c.total++;
      if (R8_INSIDE_WT.test(s)) { c.inside++; if (c.insidePaths.length < 5) c.insidePaths.push(n + ' ' + s); }
      if (R8_INSIDE_WT.test(s) && !/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]\.git$/i.test(s)) { c.insideBeyondGit++; if (c.beyondGitPaths.length < 5) c.beyondGitPaths.push(n + ' ' + s); }
      if (n === 'readdirSync' && /[\\/]\.claude[\\/]worktrees$/i.test(s)) c.readdirOfWorktrees++;
      return orig[n].call(fs, p, ...rest);
    };
  }
  try { c.r = fn(); } finally { for (const n of names) fs[n] = orig[n]; }
  return c;
}

r4Section('150', () => {
  console.log('\n150) WP-SYNC-R8/R10: every agent CHECKOUT under .claude/worktrees is ONE protect entry — never descended, never hashed; memory is still hashed');
  const { tpl } = tplHomeWp2c('t150-tpl', { settings: false });
  const p = projWp2c('t150a');
  wfx(p, '.claude/forge-scribe/inbox.jsonl', '{"ask":"keep this owner instruction"}\n');
  wfx(p, '.claude/forge-runs/run-1/events.jsonl', '{}\n');
  r8Worktrees(p, R8_WT, R8_PER);
  const c = r8CountFs(() => sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C }));
  const m = c.r;
  const E = m.entries;
  const wtKeys = Object.keys(E).filter((k) => k.toLowerCase().startsWith('.claude/worktrees/')).sort();
  const expectKeys = Array.from({ length: R8_WT }, (_, i) => '.claude/worktrees/agent-' + i).sort();
  // WP-SYNC-R10: the R8 whole-folder summary became one entry PER CHECKOUT (a child holding a .git entry)
  t('150a nothing INSIDE a checkout is in the manifest: the only keys under .claude/worktrees/ are the ' + R8_WT + ' checkouts themselves', JSON.stringify(wtKeys) === JSON.stringify(expectKeys));
  t('150a ...and not one HASHME file name or path appears anywhere in it', !JSON.stringify(m).includes('HASHME'));
  t('150a each checkout is ONE skipped-dir entry carrying the hash of its .git pointer file; .claude/worktrees itself is a plain folder entry',
    wtKeys.every((k) => E[k].kind === 'skipped-dir' && E[k].summarized === true && E[k].checkout === true && /^file:[0-9a-f]{64}$/.test(E[k].git)) && E['.claude/worktrees'].kind === 'dir');
  t('150a the manifest names the checkout mode (checkoutDirs) next to notWalked; the R8 whole-folder mode is not used', JSON.stringify(m.checkoutDirs) === JSON.stringify(['.claude/worktrees/']) && JSON.stringify(m.summarizedDirs) === '[]');
  t('150b bounded: no fs call INSIDE a checkout except its own .git entry (' + R8_WT * (R8_PER + 1) + ' files there), exactly one readdir of .claude/worktrees', c.insideBeyondGit === 0 && c.readdirOfWorktrees === 1 && c.inside <= R8_WT * 4); // per checkout: 2 lstat + readFileSync (+ the openSync it makes) of its .git entry
  if (c.insideBeyondGit) console.error('    first calls beyond .git: ' + c.beyondGitPaths.join(' | '));
  t('150b bounded: the entry count grows with the number of checkouts, never with their files (' + m.counts.total + ' entries, ' + c.total + ' fs calls in all)', m.counts.total < 40 + R8_WT && c.total < 400 + 4 * R8_WT);
  t('150c memory is still hashed: agent-memory, FORGE_MEMORY.md, forge-scribe and forge-runs files carry a sha256', ['.claude/agent-memory/head-chef/MEMORY.md', '.claude/FORGE_MEMORY.md', '.claude/forge-scribe/inbox.jsonl', '.claude/forge-runs/run-1/events.jsonl'].every((k) => E[k] && E[k].kind === 'file' && /^[0-9a-f]{64}$/.test(E[k].hash)));
  t('150c the never-touch floor still names worktrees (the sync never writes there)', sync.NEVER_TOUCH_DIRS.has('worktrees') && sync.isNeverTouchDir('worktrees') && sync.isNeverTouch('worktrees/agent-0/src/x.cs'));
  // (d) verifyProtect recomputes the same way — symmetric, and just as bounded
  const cv = r8CountFs(() => sync.verifyProtect(p, m, null));
  t('150d verifyProtect on the untouched project: ok, and its recompute touched nothing inside a checkout beyond its .git entry', cv.r.ok === true && cv.insideBeyondGit === 0);
  // (e) what the checkout entries do and do not see
  wfx(p, '.claude/worktrees/agent-new/.git', 'gitdir: elsewhere/agent-new\n');
  const vNew = sync.verifyProtect(p, m, null);
  t('150e a NEW checkout appearing during a sync is a violation (ADDED .claude/worktrees/agent-new, as a checkout)', vNew.ok === false && sync.protectViolationLines(vNew).includes('ADDED   .claude/worktrees/agent-new') && vNew.added.some((x) => x.key === '.claude/worktrees/agent-new' && x.after.checkout === true));
  fs.rmSync(path.join(p, '.claude', 'worktrees', 'agent-new'), { recursive: true, force: true });
  fs.rmSync(path.join(p, '.claude', 'worktrees', 'agent-7'), { recursive: true, force: true });
  t('150e a VANISHED checkout folder is a violation', sync.verifyProtect(p, m, null).ok === false);
  wfx(p, '.claude/worktrees/agent-7', 'now a FILE with the same name');
  t('150e a checkout folder replaced by a FILE of the same name is a violation (a file entry instead of a checkout entry)', sync.verifyProtect(p, m, null).ok === false);
  fs.rmSync(path.join(p, '.claude', 'worktrees', 'agent-7'));
  r8Worktrees(p, 8, 0); // agent-0..7 again (agent-7 back as a folder with its .git file)
  fs.mkdirSync(path.join(p, '.claude', 'worktrees', 'agent-7', 'src'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'worktrees', 'agent-3', 'src', 'd1', 'HASHME-3-1.txt'), 'EDITED inside a checkout');
  t('150e STATED LIMIT, pinned: an edit INSIDE a checkout is not seen (agent scratch, not shipped, not app code)', sync.verifyProtect(p, m, null).ok === true);
  // (f) a manifest written before R8 (neither summarizedDirs nor checkoutDirs) is recomputed the old, walking way — symmetric, never a false alarm
  const mOld = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C, summarizeDirs: [], checkoutDirs: [] });
  delete mOld.summarizedDirs;
  delete mOld.checkoutDirs;
  t('150f (setup) the pre-R8 shape walks the checkouts file by file', Object.keys(mOld.entries).filter((k) => k.startsWith('.claude/worktrees/')).length > R8_WT * R8_PER);
  t('150f verifyProtect on a pre-R8 manifest recomputes the same walking way: ok, no false violation', sync.verifyProtect(p, mOld, null).ok === true);
  fs.writeFileSync(path.join(p, '.claude', 'worktrees', 'agent-3', 'src', 'd1', 'HASHME-3-1.txt'), 'EDITED again');
  t('150f ...and keeps its old per-file reach (an edit inside a checkout is a violation for that old manifest)', sync.verifyProtect(p, mOld, null).changed.some((x) => x.key === '.claude/worktrees/agent-3/src/d1/HASHME-3-1.txt'));
  // (g) the summary can never be widened to a memory folder — not by an option, not by a tampered manifest file
  const mWide = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C, summarizeDirs: ['agent-memory', '.claude/forge-runs/', 'forge-scribe', 'worktrees'] });
  t('150g summarizeDirs naming memory folders is ignored: they are still hashed file by file, only worktrees is summarized', JSON.stringify(mWide.summarizedDirs) === JSON.stringify(['.claude/worktrees/']) && mWide.entries['.claude/agent-memory/head-chef/MEMORY.md'].kind === 'file' && mWide.entries['.claude/forge-scribe/inbox.jsonl'].kind === 'file' && mWide.entries['.claude/forge-runs/run-1/events.jsonl'].kind === 'file');
  const mT = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C });
  mT.summarizedDirs = ['.claude/agent-memory/', '.claude/worktrees/'];
  fs.appendFileSync(path.join(p, '.claude', 'agent-memory', 'head-chef', 'MEMORY.md'), 'a planted line\n');
  t('150g a TAMPERED manifest listing agent-memory as summarized still catches a memory edit', sync.protectViolationLines(sync.verifyProtect(p, mT, null)).includes('CHANGED .claude/agent-memory/head-chef/MEMORY.md'));
  // (h) an EMPTY worktrees folder appearing is listed, not a violation (same rule as any empty folder); content is
  const pE = projWp2c('t150h');
  const mE = sync.buildProtectManifest(tpl, pE, { nowIso: NOW_WP2C });
  fs.mkdirSync(path.join(pE, '.claude', 'worktrees'));
  const vE = sync.verifyProtect(pE, mE, null);
  t('150h an EMPTY .claude/worktrees appearing is allowed and listed', vE.ok === true && vE.allowed.some((a) => a.key === '.claude/worktrees' && /EMPTY folder/.test(a.why)));
  wfx(pE, '.claude/worktrees/agent-x/.git', 'gitdir: elsewhere/agent-x\n'); // a real checkout (it holds a .git entry)
  t('150h ...a checkout inside it is a violation', sync.verifyProtect(pE, mE, null).ok === false);
  // (i) a junction AT .claude/worktrees is recorded by its target, never followed (and never summarized through)
  const pJ = projWp2c('t150i');
  const elsewhere = freshDir('t150i-elsewhere');
  r8Worktrees(elsewhere, 2, 3);
  if (r3Junction(path.join(elsewhere, '.claude', 'worktrees'), path.join(pJ, '.claude', 'worktrees'), '150i')) {
    const cj = r8CountFs(() => sync.buildProtectManifest(tpl, pJ, { nowIso: NOW_WP2C }));
    t('150i a junction at .claude/worktrees is a symlink entry with its target; nothing behind it is read', cj.r.entries['.claude/worktrees'].kind === 'symlink' && !Object.keys(cj.r.entries).some((k) => k.startsWith('.claude/worktrees/')) && cj.inside === 0);
    fs.rmdirSync(path.join(pJ, '.claude', 'worktrees'));
  }
  // (j) the CLI says what it summarized and how the app-code guard stands
  const out = path.join(freshDir('t150j-out'), 'pm.json');
  const pC = projWp2c('t150j');
  r8Worktrees(pC, 5, 20);
  const cli = runCLIWithTemplate(['protect-manifest', pC, '--out', out], tpl);
  const written = (() => { try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return null; } })();
  t('150j (CLI) protect-manifest exits 0, names the checkout folder and its checkout count, and states the git guard', cli.status === 0 && /\.claude\/worktrees\/: 5 checkout\(s\) \(a child holding a \.git entry\) recorded as one entry each — not descended; 0 other child entries walked and hashed/.test(cli.stdout) && /app-code git guard: /.test(cli.stdout) && /\(\d+ ms\)/.test(cli.stdout));
  t('150j (CLI) the written manifest has no entry INSIDE a checkout: exactly the 5 checkout entries under .claude/worktrees/', !!written && Object.keys(written.entries).filter((k) => k.startsWith('.claude/worktrees/')).length === 5 && Object.keys(written.entries).filter((k) => k.startsWith('.claude/worktrees/')).every((k) => written.entries[k].checkout === true));
  t('150j (CLI) verify-protect against it exits 0', runCLIWithTemplate(['verify-protect', pC, out], tpl).status === 0);
});

/** r8GitTrace(fn) -> {r, visited:[paths-visited per git read_directory], dirs:[directories-visited]} via GIT_TRACE2_PERF. */
function r8GitTrace(fn) {
  const file = path.join(freshDir('t151-trace'), 'trace.txt');
  const prev = process.env.GIT_TRACE2_PERF;
  process.env.GIT_TRACE2_PERF = file;
  let r;
  try { r = fn(); } finally { if (prev === undefined) delete process.env.GIT_TRACE2_PERF; else process.env.GIT_TRACE2_PERF = prev; }
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { txt = ''; }
  const nums = (re) => { const out = []; let mm; const g = new RegExp(re.source, 'g'); while ((mm = g.exec(txt)) !== null) out.push(Number(mm[1])); return out; };
  return { r, visited: nums(/\.\.paths-visited:(\d+)/), dirs: nums(/\.\.directories-visited:(\d+)/) };
}

if (!PUB_GIT_OK) console.log('\n151) SKIP: git is not available here — the application-code guard needs git; NOT exercised');
else r4Section('151', () => {
  console.log('\n151) WP-SYNC-R8: git is told not to enumerate .claude/ (status AND the ignored listing) — the app-code inventory outside it is unchanged');
  const SCRATCH = 400; // files in a NON-checkout folder inside .claude/worktrees (the 26H2 shape: 5 of its 98 folders had no .git)
  /** mk — a git project with 2 REAL `git worktree add` checkouts under .claude/worktrees plus one non-checkout scratch folder. */
  const mk = (name, opts) => {
    opts = opts || {};
    const outer = opts.nested ? freshDir(name + '-outer') : null;
    const p = opts.nested ? path.join(outer, 'apps', 'proj') : projWp2c(name, { doctorExit: null });
    if (opts.nested) { fs.mkdirSync(path.join(p, '.claude', 'agent-memory'), { recursive: true }); wfx(p, '.claude/agent-memory/MEMORY.md', '# memory\n'); }
    const repo = outer || p;
    wfx(p, 'src/app.js', 'console.log("app");\n');
    wfx(p, '.gitignore', 'build/\n*.log\n');
    wfx(p, 'build/out.txt', 'built');
    wfx(p, 'src/.claude/notes.log', 'an ignored file in a .claude-named folder that is NOT the project\'s .claude');
    const g = pubGit(repo);
    g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'app']);
    const rel = opts.nested ? 'apps/proj/' : '';
    for (const w of ['wt-1', 'wt-2']) g(['worktree', 'add', '-q', '-b', 'b-' + w, rel + '.claude/worktrees/' + w]);
    for (let j = 0; j < SCRATCH; j++) wfx(p, '.claude/worktrees/scratch-no-git/d' + (j % 20) + '/f' + j + '.txt', 'scratch ' + j);
    if (opts.ignoreWorktrees) fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\n**/.claude/worktrees/\n');
    return { p, g, repo };
  };
  const realCheckout = (p) => { try { return /^gitdir: /.test(fs.readFileSync(path.join(p, '.claude', 'worktrees', 'wt-1', '.git'), 'utf8')); } catch { return false; } };
  // (a) .claude/worktrees IGNORED (the 26H2 shape: .git/info/exclude **/.claude/worktrees/)
  const A = mk('t151a', { ignoreWorktrees: true });
  t('151a (setup) wt-1 is a real `git worktree add` checkout (a .git FILE)', realCheckout(A.p));
  const rawA = r8GitTrace(() => spawnSync('git', ['--no-optional-locks', '-C', A.p, 'ls-files', '--others', '--ignored', '--exclude-standard', '--full-name', '-z', '--', '.'], { encoding: 'utf8' }));
  if (!rawA.visited.length) console.log('  SKIP 151a-b — this git emits no read_directory trace2 counters; the pruning is not measurable here');
  else {
    t('151a (precondition) the pre-R8 ignored listing really walked the ignored scratch folder (paths-visited ' + Math.max(...rawA.visited) + ' >= ' + SCRATCH + ')', Math.max(...rawA.visited) >= SCRATCH);
    const gA = r8GitTrace(() => sync.appCodeGitState(A.p, []));
    t('151a appCodeGitState: no git call visits the scratch folder (max paths-visited ' + Math.max(...gA.visited) + ' < ' + SCRATCH + ')', gA.visited.length >= 2 && Math.max(...gA.visited) < SCRATCH);
    // the inventory outside .claude/ is exactly what git reports without the R8 flags
    const rawNames = rawA.r.stdout.split('\0').filter((s) => s && !/^\.claude\//i.test(s));
    t('151a the ignored inventory outside .claude/ is unchanged (' + rawNames.length + ' names, incl. src/.claude/notes.log)', gA.r.ignored && gA.r.ignored.count === rawNames.length && rawNames.includes('build/out.txt') && rawNames.includes('src/.claude/notes.log'));
    t('151a the guard says what git was told not to enumerate', JSON.stringify(gA.r.notEnumerated) === JSON.stringify(['.claude/']) && gA.r.partial.length === 0);
  }
  // (b) .claude/worktrees NOT ignored: status -uall would list the scratch folder file by file
  const B = mk('t151b', {});
  wfx(B.p, 'src/untracked.js', 'an untracked app file the guard must keep seeing');
  const rawB = r8GitTrace(() => spawnSync('git', ['--no-optional-locks', '-C', B.p, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { encoding: 'utf8' }));
  if (rawB.visited.length) {
    t('151b (precondition) the pre-R8 status walked the NON-ignored scratch folder (paths-visited ' + Math.max(...rawB.visited) + ' >= ' + SCRATCH + ')', Math.max(...rawB.visited) >= SCRATCH);
    const gB = r8GitTrace(() => sync.appCodeGitState(B.p, []));
    t('151b appCodeGitState: neither status nor the ignored listing visits it (max paths-visited ' + Math.max(...gB.visited) + ' < ' + SCRATCH + ')', Math.max(...gB.visited) < SCRATCH);
    const rawEntriesB = rawB.r.stdout.split('\0').filter((s) => s.length > 3).map((s) => s.slice(3).replace(/\/$/, '')).filter((s) => !/^\.claude(\/|$)/i.test(s) && !['CLAUDE.md', 'AGENTS.md', '.gitignore'].includes(s)).sort();
    t('151b the status entries outside .claude/ are unchanged (' + rawEntriesB.join(', ') + ')', rawEntriesB.includes('src/untracked.js') && JSON.stringify(Object.keys(gB.r.entries).sort()) === JSON.stringify(rawEntriesB));
    // workspaceFingerprint (--reuse-pre-baseline) leaves .claude/worktrees out, keeps the rest of .claude and the app
    const fp0 = sync.workspaceFingerprint(B.p);
    const fpTrace = r8GitTrace(() => sync.workspaceFingerprint(B.p));
    t('151b workspaceFingerprint does not walk (or hash) the worktrees scratch folder (max paths-visited ' + Math.max(...fpTrace.visited) + ' < ' + SCRATCH + ')', Math.max(...fpTrace.visited) < SCRATCH);
    fs.writeFileSync(path.join(B.p, '.claude', 'worktrees', 'scratch-no-git', 'd1', 'f1.txt'), 'edited by an agent');
    t('151b an edit inside .claude/worktrees does not change the workspace fingerprint', sync.workspaceFingerprint(B.p).gitStatusHash === fp0.gitStatusHash);
    wfx(B.p, '.claude/agent-memory/new-note.md', 'untracked memory note');
    const fp1 = sync.workspaceFingerprint(B.p);
    t('151b ...a new untracked file elsewhere in .claude/ still does', fp1.gitStatusHash !== fp0.gitStatusHash);
    fs.writeFileSync(path.join(B.p, 'src', 'app.js'), 'console.log("changed");\n');
    t('151b ...and so does an app-code edit', sync.workspaceFingerprint(B.p).gitStatusHash !== fp1.gitStatusHash);
  }
  // (c) a project NESTED in a larger repository: the negation is anchored at apps/proj/.claude/, nothing else moves
  const C = mk('t151c', { nested: true, ignoreWorktrees: true });
  const rawC = r8GitTrace(() => spawnSync('git', ['--no-optional-locks', '-C', C.p, 'ls-files', '--others', '--ignored', '--exclude-standard', '--full-name', '-z', '--', '.'], { encoding: 'utf8' }));
  if (rawC.visited.length) {
    const gC = r8GitTrace(() => sync.appCodeGitState(C.p, []));
    const rawNamesC = rawC.r.stdout.split('\0').filter((s) => s && !/^apps\/proj\/\.claude\//i.test(s));
    t('151c nested project: pruned too (max paths-visited ' + Math.max(...gC.visited) + ' < ' + SCRATCH + '), same ' + rawNamesC.length + ' ignored names outside its .claude/', Math.max(...gC.visited) < SCRATCH && gC.r.ignored && gC.r.ignored.count === rawNamesC.length && rawNamesC.includes('apps/proj/src/.claude/notes.log'));
  }
  // (d) the protect manifest of a real-checkout project: one summary entry; a doctor-style memory edit is still caught
  const { tpl } = tplHomeWp2c('t151d-tpl', { settings: false });
  const mD = sync.buildProtectManifest(tpl, A.p, { nowIso: NOW_WP2C });
  // WP-SYNC-R10: the two REAL checkouts are one entry each; the non-checkout scratch folder next to them is walked and hashed
  const underD = Object.keys(mD.entries).filter((k) => k.startsWith('.claude/worktrees/'));
  t('151d real checkouts: wt-1 and wt-2 are one checkout entry each (nothing inside them), guarded:true',
    ['wt-1', 'wt-2'].every((w) => mD.entries['.claude/worktrees/' + w] && mD.entries['.claude/worktrees/' + w].checkout === true && /^file:[0-9a-f]{64}$/.test(mD.entries['.claude/worktrees/' + w].git))
    && !underD.some((k) => /^\.claude\/worktrees\/wt-[12]\//.test(k)) && sync.diffProtectManifests(mD, mD, null).appCode.guarded === true);
  t('151d ...and the non-checkout scratch folder is walked: all ' + SCRATCH + ' of its files carry a sha256', underD.filter((k) => k.startsWith('.claude/worktrees/scratch-no-git/') && mD.entries[k].kind === 'file' && /^[0-9a-f]{64}$/.test(mD.entries[k].hash)).length === SCRATCH);
  fs.appendFileSync(path.join(A.p, '.claude', 'agent-memory', 'head-chef', 'MEMORY.md'), 'planted\n');
  t('151d a memory edit is still a violation', sync.protectViolationLines(sync.verifyProtect(A.p, mD, null)).includes('CHANGED .claude/agent-memory/head-chef/MEMORY.md'));
});

// =====================================================================================================================
// WP-SYNC-R9. FOUND during the REAL 26H2 install: the post-sync doctor
// reported forge-gate-hook.test + forge-gate-secretprint.test green->red and forge-stop-obligations.test red for the first time,
// forge-sync rolled back 173 files — and each of the three passed when run alone with the same files. The report kept counts
// only, so WHAT failed was lost. Sections 152-156: failing lines travel (result / report / receipt, scrubbed), and a suite-only
// regression is confirmed by ONE isolated re-run per flagged suite before the rollback. Every fixture is os.tmpdir()-only; the
// suites are tiny generated files; the marker and run-counter files live OUTSIDE the fixture project (never protect-hashed).
// =====================================================================================================================
const NOW_R9 = '2026-10-10T22:00:00.000Z';
// fake credentials assembled at run time (never a literal secret in this source file)
const R9_PW = 'hunter2' + 'Zq7' + 'Xw9';
const R9_SK = 'sk-' + 'R9t' + 'Qm4'.repeat(8);
const R9_SECRET_TEXT = 'password=' + R9_PW + ' key ' + R9_SK;
/** r9Doctor(p, opts) — a doctor stub that REALLY runs every <p>/.claude/forge-bin/*.test.cjs (cwd = the root, like forge-doctor)
 *  and builds the per-suite list from the real tallies. Its `failures` lines are deliberately NOT redacted (an older or foreign
 *  doctor) so forge-sync's own scrubbing is what the secret tests prove. opts.leakRedPost: the leak_scan CHECK turns red after
 *  the sync wrote TOOL-V2 (a red check regression next to a suite one). */
function r9Doctor(p, opts) {
  opts = opts || {};
  const tool = path.join(p, '.claude', 'forge-bin', 'tool.cjs');
  wfx(p, '.claude/forge-bin/forge-doctor.cjs', [
    '#!/usr/bin/env node',
    'var fs = require("fs"), path = require("path"), cp = require("child_process");',
    'var args = process.argv.slice(2); var ri = args.indexOf("--root"); var root = ri !== -1 ? args[ri + 1] : process.cwd();',
    'var post = false; try { post = fs.readFileSync(' + JSON.stringify(tool) + ', "utf8") === "TOOL-V2"; } catch (e) {}',
    'var bin = path.join(root, ".claude", "forge-bin");',
    'var tests = fs.readdirSync(bin).filter(function (f) { return /\\.test\\.cjs$/.test(f); }).sort();',
    'var per = tests.map(function (t) {',
    '  var r = cp.spawnSync(process.execPath, [path.join(bin, t)], { cwd: root, encoding: "utf8", timeout: 60000 });',
    '  var out = (r.stdout || "") + (r.stderr || "");',
    '  var re = /^\\s*(\\d+)\\s+passed,\\s+(\\d+)\\s+failed\\b/gm, m = null, tm; while ((tm = re.exec(out)) !== null) m = tm;',
    '  var pp = m ? Number(m[1]) : 0, ff = m ? Number(m[2]) : 0;',
    '  var ok = r.status === 0 && !!m && pp > 0 && ff === 0;',
    '  var e = { suite: t, passed: pp, failed: ff, ok: ok, timedOut: false };',
    '  if (!ok) { var fl = out.split(/\\r?\\n/).filter(function (l) { return /^\\s*(?:FAIL\\b|not ok\\b)/.test(l); }).slice(0, 5).map(function (l) { return l.trim().slice(0, 200); }); if (fl.length) e.failures = fl; }',
    '  return e;',
    '});',
    'var red = per.filter(function (s) { return !s.ok; });',
    'var leakOk = ' + (opts.leakRedPost ? '!post' : 'true') + ';',
    'var testsOk = red.length === 0 && per.length > 0;',
    'var sum = function (k) { return per.reduce(function (a, s) { return a + s[k]; }, 0); };',
    'var checks = { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: testsOk, suites: per.length, passed: sum("passed"), failed: sum("failed"), suitesFailed: red.length, suitesBlocked: 0, perSuite: per }, leak_scan: { ok: leakOk } };',
    'var ok = testsOk && leakOk;',
    'if (args.indexOf("--json") !== -1) console.log(JSON.stringify({ ok: ok, checks: checks }));',
    'process.exit(ok ? 0 : 1);',
  ].join('\n'));
}
/** r9Suite(p, name, kind, aux) — a real suite file. Every run appends one line to aux/<name>.runs (outside the project). It is
 *  green before the sync (tool.cjs != TOOL-V2). After the sync: 'steady' stays green; 'flaky' fails on its FIRST post-sync run
 *  only (a marker in aux) — the doctor run — and passes alone; 'broken' fails every post-sync run; 'empty' fails its first
 *  post-sync run and then prints a 0/0 tally with exit 0; 'silent' fails first, then exits 0 printing no tally at all; 'crash'
 *  throws (no FAIL line, no tally); 'hang' never finishes. Failing runs print a labelled secret in their FAIL line. */
function r9Suite(p, name, kind, aux) {
  const marker = path.join(aux, name + '.marker');
  const counter = path.join(aux, name + '.runs');
  wfx(p, '.claude/forge-bin/' + name, [
    '#!/usr/bin/env node',
    'var fs = require("fs"), path = require("path");',
    'fs.appendFileSync(' + JSON.stringify(counter) + ', "run\\n");',
    'var post = false; try { post = fs.readFileSync(path.join(__dirname, "tool.cjs"), "utf8") === "TOOL-V2"; } catch (e) {}',
    'var first = !fs.existsSync(' + JSON.stringify(marker) + ');',
    'function green() { console.log("  ok  steady assertion"); console.log("3 passed, 0 failed"); process.exit(0); }',
    'function red(n) { if (post) fs.writeFileSync(' + JSON.stringify(marker) + ', "x"); for (var i = 1; i <= n; i++) console.log("  FAIL ' + name + ' assertion " + i + " ' + R9_SECRET_TEXT + '"); console.log("1 passed, " + n + " failed"); process.exit(1); }',
    'var kind = ' + JSON.stringify(kind) + ';',
    'if (!post || kind === "steady") green();',
    'if (kind === "broken") red(2);',
    'if (kind === "flaky") { if (first) red(1); green(); }',
    'if (kind === "empty") { if (first) red(1); console.log("0 passed, 0 failed"); process.exit(0); }',
    'if (kind === "silent") { if (first) red(1); process.exit(0); }',
    'if (kind === "crash") { throw new Error("boom ' + R9_SECRET_TEXT + '"); }',
    'if (kind === "hang") { setTimeout(function () {}, 60000); }',
  ].join('\n'));
  return { counter, marker, runs: () => { try { return fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } } };
}
/** r9Fixture(name, kinds, opts) — a project on TOOL-V1 (receipt baseline), the R9 doctor, the suites, and a template shipping TOOL-V2. */
function r9Fixture(name, kinds, opts) {
  const p = projWp2c(name, { doctorExit: null });
  r9Doctor(p, opts);
  const aux = freshDir(name + '-aux');
  const suites = {};
  for (const [file, kind] of Object.entries(kinds)) suites[file] = r9Suite(p, file, kind, aux);
  const { tpl } = tplHomeWp2c(name + '-tpl');
  return { p, tpl, aux, suites };
}
const r9NoSecret = (s) => !String(s).includes(R9_PW) && !String(s).includes(R9_SK);

r4Section('152', () => {
  console.log('\n152) WP-SYNC-R9: a suite that fails inside the doctor run but passes when re-run ONCE alone is flaky-under-load — the install is kept');
  const F = r9Fixture('t152', { 'flaky.test.cjs': 'flaky', 'steady.test.cjs': 'steady' });
  const cap = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b152', nowIso: NOW_R9 }));
  const r = cap.r;
  const sc = r.suiteCheck || { suites: [] };
  const s0 = sc.suites[0] || {};
  t('152a the install SUCCEEDS (not rolled back): tool.cjs is TOOL-V2 and a receipt is written', r.ok === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && !!r.receipt);
  t('152a ...the flagged suite is recorded flaky-under-load, with BOTH outcomes (doctor run: 1 failed; alone: 3 passed, 0 failed)',
    sc.mode === 'rerun' && sc.kept === true && sc.suites.length === 1 && s0.suite === 'flaky.test.cjs' && s0.kind === 'green->red' && s0.classification === 'flaky-under-load'
    && s0.firstRun.failed === 1 && !!s0.isolated && s0.isolated.healthy === true && s0.isolated.exitCode === 0 && s0.isolated.passed === 3 && s0.isolated.failed === 0 && Number.isFinite(s0.isolated.durationMs));
  t('152a ...the outcome names it (flakyUnderLoad) and keeps the doctor\'s own failure reason', JSON.stringify(r.outcome.flakyUnderLoad) === JSON.stringify(['flaky.test.cjs']) && /post-sync validation failed/.test(r.outcome.firstReason || ''));
  t('152b re-run exactly ONCE, and ONLY the flagged suite: flaky ran 3 times (pre doctor, post doctor, isolated), steady 2', F.suites['flaky.test.cjs'].runs() === 3 && F.suites['steady.test.cjs'].runs() === 2);
  t('152c the failing line the doctor kept travels with it — scrubbed (no password, no key; ***REDACTED*** instead)',
    s0.firstRun.lines.length === 1 && /FAIL flaky\.test\.cjs assertion 1/.test(s0.firstRun.lines[0]) && /\*\*\*REDACTED\*\*\*/.test(s0.firstRun.lines[0]) && r9NoSecret(JSON.stringify(sc)));
  const rc = sync.readReceipt(F.p) || { validation: {} };
  t('152d the receipt records the check honestly: doctor run ok:false, flakyUnderLoad listed, the per-suite record, no raw secret',
    rc.validation.ok === false && JSON.stringify(rc.validation.flakyUnderLoad) === JSON.stringify(['flaky.test.cjs']) && !!rc.validation.suiteRegressionCheck
    && rc.validation.suiteRegressionCheck.suites[0].classification === 'flaky-under-load' && r9NoSecret(JSON.stringify(rc)));
  const dp = sync.decidePreBaseline(rc, rc.postSyncManifestHash, rc.workspace, Date.parse(NOW_R9));
  t('152d ...and such a receipt is never reused as a pre-sync baseline (it was not green)', dp.reuse === false);
  const rep = r.report && r.report.path ? r7Read(r.report.path) : '';
  t('152e the change report: a "Suite regression check" subsection under Doctor, the suite, both outcomes, the decision KEPT',
    /## Doctor \(validation\)[\s\S]*### Suite regression check \(isolated re-run\)/.test(rep) && /flaky\.test\.cjs/.test(rep) && /Inside the doctor run: 1 passed, 1 failed/.test(rep) && /Alone: exit 0, 3 passed, 0 failed/.test(rep) && /Decision: \*\*KEPT\*\*/.test(rep));
  t('152e ...says PLAINLY that it was NOT proven healthy under load, only not deterministically broken; the outcome line says so too',
    /NOT proven healthy under load/.test(rep) && /not deterministically broken/.test(rep) && /Outcome: \*\*SYNCED — 1 suite\(s\) flaky under load/.test(rep) && r9NoSecret(rep));
  const out = cap.out.join('\n');
  t('152f the console prints the decision (re-run once, FLAKY-UNDER-LOAD, kept) and no raw secret', /suite regression check: 1 flagged suite\(s\) — each re-run ONCE, alone/.test(out) && /flaky\.test\.cjs \(green->red\).*FLAKY-UNDER-LOAD/.test(out) && /decision: every flagged suite passed when re-run alone/.test(out) && r9NoSecret(out));
  const printed = quiet(() => sync.printSafeSyncResult(F.p, r)).out.join('\n');
  t('152f ...and the result line never reads as a plain OK: "accepted [doctor run RED; 1 suite(s) flaky under load ..."', /validation: forge-doctor accepted \[doctor run RED; 1 suite\(s\) flaky under load/.test(printed) && !/forge-doctor OK/.test(printed));
});

r4Section('153', () => {
  console.log('\n153) WP-SYNC-R9: a suite that fails again alone stays a regression — rolled back, and the report says WHAT failed');
  const F = r9Fixture('t153', { 'broken.test.cjs': 'broken', 'steady.test.cjs': 'steady' });
  const r = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b153', nowIso: NOW_R9 })).r;
  const s0 = ((r.suiteCheck || {}).suites || [])[0] || {};
  t('153a rolled back exactly as before: ok:false, rolledBack, tool.cjs back on TOOL-V1, no new receipt', r.ok === false && r.rolledBack === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && !(sync.readReceipt(F.p) || {}).batchId);
  t('153b classified regression: doctor run 2 failed, alone exit 1 with 2 failed; re-run once (3 runs), steady not re-run (2 runs)',
    s0.classification === 'regression' && s0.firstRun.failed === 2 && !!s0.isolated && s0.isolated.healthy === false && s0.isolated.exitCode === 1 && s0.isolated.failed === 2
    && F.suites['broken.test.cjs'].runs() === 3 && F.suites['steady.test.cjs'].runs() === 2);
  t('153c the result carries the failing lines of both runs (doctor: 2, isolated: 2), scrubbed', s0.firstRun.lines.length === 2 && s0.isolated.lines.length === 2 && /FAIL broken\.test\.cjs assertion 2/.test(s0.isolated.lines[1]) && r9NoSecret(JSON.stringify(r.suiteCheck)));
  t('153d the outcome reason keeps the original text and adds the isolated verdict', /post-sync validation failed/.test(r.outcome.reason) && /broken\.test\.cjs \(2 failed\)/.test(r.outcome.reason) && /isolated re-run: 1 of 1 flagged suite\(s\) did not pass when re-run alone/.test(r.outcome.reason));
  const rep = r.report && r.report.path ? r7Read(r.report.path) : '';
  t('153e the change report (kept after the rollback) names the suite, both outcomes and the failing lines, without secrets',
    /ROLLED BACK — validation failed/.test(rep) && /### Suite regression check/.test(rep) && /Decision: \*\*ROLLBACK\*\*/.test(rep) && /Failing lines the doctor kept/.test(rep) && /Failing lines of the isolated run/.test(rep)
    && /FAIL broken\.test\.cjs assertion 1/.test(rep) && /\*\*\*REDACTED\*\*\*/.test(rep) && r9NoSecret(rep));
  t('153e ...and no honesty note about flakiness (nothing passed alone)', !/NOT proven healthy under load/.test(rep));
  // (f) a crash with no FAIL line and no tally: the isolated run's last output lines stand in, scrubbed
  const C = r9Fixture('t153f', { 'crash.test.cjs': 'crash', 'steady.test.cjs': 'steady' }); // steady keeps the doctor's evidence (passed > 0)
  const rc = quiet(() => sync.safeSyncProject(C.tpl, C.p, { batchId: 'b153f', nowIso: NOW_R9 })).r;
  const c0 = ((rc.suiteCheck || {}).suites || [])[0] || {};
  t('153f a crashing suite (no FAIL line, no tally): regression, rolled back; its last output lines are kept instead, scrubbed',
    rc.ok === false && rc.rolledBack === true && c0.classification === 'regression' && !!c0.isolated && c0.isolated.lines.length === 0 && c0.isolated.tail.length > 0
    && c0.isolated.tail.some((l) => /boom/.test(l)) && r9NoSecret(JSON.stringify(rc.suiteCheck)) && /no parsable/.test(rc.outcome.reason));
});

r4Section('154', () => {
  console.log('\n154) WP-SYNC-R9: no evidence alone (0/0 tally, no tally, a timeout) is still a regression; --no-isolated-rerun rolls back as before');
  const E = r9Fixture('t154a', { 'empty.test.cjs': 'empty' });
  const re = quiet(() => sync.safeSyncProject(E.tpl, E.p, { batchId: 'b154a', nowIso: NOW_R9 })).r;
  const e0 = ((re.suiteCheck || {}).suites || [])[0] || {};
  t('154a alone it exits 0 with "0 passed, 0 failed": NOT healthy (no evidence) -> regression, rolled back, re-run once',
    re.ok === false && re.rolledBack === true && e0.classification === 'regression' && !!e0.isolated && e0.isolated.exitCode === 0 && e0.isolated.tallyParsed === true && e0.isolated.passed === 0 && e0.isolated.healthy === false
    && E.suites['empty.test.cjs'].runs() === 3 && /0 passed, 0 failed \(no evidence\)/.test(re.outcome.reason) && rfx(E.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  const S = r9Fixture('t154b', { 'silent.test.cjs': 'silent' });
  const rs = quiet(() => sync.safeSyncProject(S.tpl, S.p, { batchId: 'b154b', nowIso: NOW_R9 })).r;
  const s0 = ((rs.suiteCheck || {}).suites || [])[0] || {};
  t('154b alone it exits 0 printing no tally at all -> regression, rolled back', rs.ok === false && rs.rolledBack === true && s0.classification === 'regression' && s0.isolated && s0.isolated.exitCode === 0 && s0.isolated.tallyParsed === false);
  // (c) a timeout: killed at the limit (by its own PID), a regression — unit level, 1.5 s limit
  const H = r9Fixture('t154c', { 'hang.test.cjs': 'hang' });
  wfx(H.p, '.claude/forge-bin/tool.cjs', 'TOOL-V2');
  const t0 = Date.now();
  const h = sync.runIsolatedSuite(H.p, 'hang.test.cjs', { timeoutMs: 1500, forceDirect: true });
  t('154c a suite that hangs alone is stopped at the limit: timedOut, not healthy (and it did not wait the suite\'s 60 s)', h.timedOut === true && h.healthy === false && h.runner === 'direct' && Date.now() - t0 < 30000);
  // (d) --no-isolated-rerun: the flaky fixture rolls back like before, nothing re-run, the decision says so
  const D = r9Fixture('t154d', { 'flaky.test.cjs': 'flaky' });
  const capD = quiet(() => sync.safeSyncProject(D.tpl, D.p, { batchId: 'b154d', nowIso: NOW_R9, noIsolatedRerun: true }));
  const rd = capD.r;
  const d0 = ((rd.suiteCheck || {}).suites || [])[0] || {};
  t('154d --no-isolated-rerun: rolled back as before; mode disabled; the suite was NOT re-run (2 runs); its doctor lines still travel',
    rd.ok === false && rd.rolledBack === true && rd.suiteCheck.mode === 'disabled' && d0.isolated === null && d0.classification === 'regression' && D.suites['flaky.test.cjs'].runs() === 2
    && d0.firstRun.lines.length === 1 && /isolated re-run: disabled \(--no-isolated-rerun\)/.test(rd.outcome.reason));
  const repD = rd.report && rd.report.path ? r7Read(rd.report.path) : '';
  t('154d ...the report and the console say the re-run was disabled', /\*\*disabled\*\* \(--no-isolated-rerun\)/.test(repD) && /isolated re-run DISABLED \(--no-isolated-rerun\)/.test(capD.out.join('\n')));
  const pa = sync.parseArgs(['proj', '--no-isolated-rerun']);
  t('154e parseArgs: --no-isolated-rerun is a flag (no value, not a positional)', !pa.argError && pa.flags.noIsolatedRerun === true && JSON.stringify(pa.pos) === JSON.stringify(['proj']));
  // (f) CLI end to end: the same flaky fixture installs (exit 0) by default, and rolls back (exit 1) with --no-isolated-rerun
  const C1 = r9Fixture('t154f1', { 'flaky.test.cjs': 'flaky' });
  const cli1 = runCLIWithTemplate(['install', C1.p, '--batch-id', 'b154f1'], C1.tpl);
  t('154f (CLI) install: exit 0, prints FLAKY-UNDER-LOAD and the not-proven-under-load note, tool.cjs synced', cli1.status === 0 && /FLAKY-UNDER-LOAD/.test(cli1.stdout) && /NOT proven healthy under load/.test(cli1.stdout) && rfx(C1.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && r9NoSecret(cli1.stdout + cli1.stderr));
  const C2 = r9Fixture('t154f2', { 'flaky.test.cjs': 'flaky' });
  const cli2 = runCLIWithTemplate(['install', C2.p, '--batch-id', 'b154f2', '--no-isolated-rerun'], C2.tpl);
  t('154f (CLI) install --no-isolated-rerun: exit 1, rolled back, the reason says the re-run was disabled', cli2.status === 1 && /isolated re-run: disabled \(--no-isolated-rerun\)/.test(cli2.stderr) && rfx(C2.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && C2.suites['flaky.test.cjs'].runs() === 2);
  // (g) sync-all: the same rule per project, and noIsolatedRerun reaches every project's sync
  const canaryDoc = wfx(freshDir('t154g-canary'), 'canary-doctor.cjs', 'if (process.argv.indexOf("--json") !== -1) console.log(JSON.stringify({ ok: true, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 } } }));\n');
  const mkAll = (name) => { const F = r9Fixture(name, { 'flaky.test.cjs': 'flaky', 'steady.test.cjs': 'steady' }); makeRealProjectMarker(F.p); return F; };
  const G1 = mkAll('t154g1');
  const sa1 = quiet(() => sync.runSyncAll(G1.tpl, path.dirname(G1.p), { batchId: 'b154g1', nowIso: NOW_R9, canaryDoctorSource: canaryDoc })).r;
  const G2 = mkAll('t154g2');
  const sa2 = quiet(() => sync.runSyncAll(G2.tpl, path.dirname(G2.p), { batchId: 'b154g2', nowIso: NOW_R9, canaryDoctorSource: canaryDoc, noIsolatedRerun: true })).r;
  t('154g sync-all keeps the flaky project by default (flaky re-run once: 3 runs) and rolls it back with noIsolatedRerun (2 runs)',
    sa1.ok === true && rfx(G1.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && G1.suites['flaky.test.cjs'].runs() === 3
    && sa2.ok === false && rfx(G2.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && G2.suites['flaky.test.cjs'].runs() === 2);
});

r4Section('155', () => {
  console.log('\n155) WP-SYNC-R9: a regressed CHECK never re-runs; only flagged suites, at most once; scrubbing fails closed');
  // (a) leak_scan turns red next to a flaky suite: no re-run at all, rollback as before
  const L = r9Fixture('t155a', { 'flaky.test.cjs': 'flaky' }, { leakRedPost: true });
  const rl = quiet(() => sync.safeSyncProject(L.tpl, L.p, { batchId: 'b155a', nowIso: NOW_R9 })).r;
  t('155a a red CHECK (leak_scan) regressed next to the suite: not re-run (2 runs), mode not-eligible naming leak_scan, rolled back',
    rl.ok === false && rl.rolledBack === true && !!rl.suiteCheck && rl.suiteCheck.mode === 'not-eligible' && /leak_scan/.test(rl.suiteCheck.notEligibleReason) && L.suites['flaky.test.cjs'].runs() === 2 && rfx(L.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  // (b) pure plan rules
  const withCounts = (parsed) => { const red = parsed.checks.tests.perSuite.filter((s) => !s.ok).length; parsed.checks.tests.suitesFailed = red; parsed.checks.tests.suitesBlocked = 0; return parsed; };
  const preS = sync.condenseDoctorSummary(withCounts(r7Parsed([['a.test.cjs', 0], ['b.test.cjs', 0]])));
  const postS = sync.condenseDoctorSummary(withCounts(r7Parsed([['a.test.cjs', 1], ['b.test.cjs', 0]])));
  const V = (summary, extra) => Object.assign({ tool: 'forge-doctor', ok: false, exitCode: 1, summary, doctorProvenance: 'template' }, extra || {});
  const pl = sync.suiteRerunPlan({ ok: true, summary: preS }, V(postS));
  t('155b plan: one suite green->red, nothing else -> eligible, flagged = [a]', pl.eligible === true && pl.flagged.length === 1 && pl.flagged[0].suite === 'a.test.cjs');
  t('155b plan: a project-local doctor is never eligible (it may not rescue its own install)', sync.suiteRerunPlan({ ok: true, summary: preS }, V(postS, { doctorProvenance: 'project-local' })).eligible === false);
  t('155b plan: a timed-out / degraded / no-evidence validation is never eligible', ['timedOut', 'degraded', 'noEvidence'].every((k) => sync.suiteRerunPlan({ ok: true, summary: preS }, V(postS, { [k]: true })).eligible === false));
  const postInc = JSON.parse(JSON.stringify(postS)); postInc.tests.suitesFailed = 2;
  t('155b plan: the tests check counts more red suites than the list names -> not eligible (redness not explained by suites)', /not fully explained/.test(sync.suiteRerunPlan({ ok: true, summary: preS }, V(postInc)).reason || ''));
  const postNoCounts = JSON.parse(JSON.stringify(postS)); delete postNoCounts.tests.suitesFailed;
  t('155b plan: no suitesFailed/suitesBlocked counts -> not eligible', sync.suiteRerunPlan({ ok: true, summary: preS }, V(postNoCounts)).eligible === false);
  const postNc = JSON.parse(JSON.stringify(postS)); postNc.node_check.ok = false; postNc.checksOk.node_check.ok = false;
  t('155b plan: node_check red after the sync -> not eligible', sync.suiteRerunPlan({ ok: true, summary: preS }, V(postNc)).eligible === false);
  const none = sync.confirmSuiteRegressions(freshDir('t155c'), { ok: true, summary: preS }, V(preS), { ok: false, reason: 'x' }, {});
  t('155c nothing flagged -> no record, the outcome is returned unchanged, nothing runs', none.record === null && none.outcome.reason === 'x');
  t('155c no evidence-backed pre summary (degraded / first install) -> nothing is flagged', sync.suiteRerunPlan({ ok: true, degraded: true, summary: preS }, V(postS)).flagged.length === 0 && sync.suiteRerunPlan(null, V(postS)).flagged.length === 0);
  // (d) summaryWithSuitesGreen keeps every OTHER red suite red and never touches the doctor's real summary
  const pre2 = sync.condenseDoctorSummary(withCounts(r7Parsed([['old.test.cjs', 2], ['x.test.cjs', 0]])));
  const post2 = sync.condenseDoctorSummary(withCounts(r7Parsed([['old.test.cjs', 2], ['x.test.cjs', 1]])));
  const adj = sync.summaryWithSuitesGreen(post2, ['x.test.cjs']);
  t('155d summaryWithSuitesGreen: x green, the pre-existing red suite stays red, tests stays red, the input is not mutated',
    adj.suiteOk['x.test.cjs'] === true && adj.suiteOk['old.test.cjs'] === false && adj.checksOk.tests.ok === false && adj.ok === false && post2.suiteOk['x.test.cjs'] === false);
  const already = sync.decideValidationOutcome({ ok: false, summary: pre2 }, { tool: 'forge-doctor', ok: false, exitCode: 1, summary: adj }, {});
  t('155d ...re-decided through decideValidationOutcome: already red before, no new regression -> ok (alreadyRedSkipped)', already.ok === true && already.alreadyRedSkipped === true);
  // (e) a suite name from the doctor's JSON is data: traversal / non-suite names are never run
  const P = makeProject(freshDir('t155e-root'), 'proj', null);
  const ranMarker = path.join(freshDir('t155e-aux'), 'ran');
  wfx(P, '.claude/evil.test.cjs', 'require("fs").writeFileSync(' + JSON.stringify(ranMarker) + ', "x");');
  wfx(P, '.claude/forge-bin/evil.cjs', 'require("fs").writeFileSync(' + JSON.stringify(ranMarker) + ', "x");');
  const bad = ['../evil.test.cjs', '..\\evil.test.cjs', 'evil.cjs', '', 'a/b.test.cjs'].map((n) => sync.runIsolatedSuite(P, n, { timeoutMs: 5000 }));
  t('155e a traversal or non-suite name is refused before any spawn (error, runner null, nothing ran)', bad.every((x) => x.error && x.runner === null && x.healthy === false) && !fs.existsSync(ranMarker));
  // (f) scrubbing: the lines pass through forge-store redactText; without it they are WITHHELD, never shown raw
  const raw = ['  FAIL a ' + R9_SECRET_TEXT, 'x'.repeat(900)];
  const sc1 = sync.scrubFailLines(raw, sync.loadDoctorScrubber());
  t('155f scrubFailLines: secrets redacted, each line cut to 300 characters', sc1.withheld === false && sc1.lines.length === 2 && r9NoSecret(sc1.lines.join('\n')) && sc1.lines[1].length === 300);
  t('155f scrubFailLines: at most 12 lines', sync.scrubFailLines(Array.from({ length: 30 }, (_, i) => 'FAIL ' + i), (s) => s).lines.length === 12);
  t('155f scrubFailLines: no scrubber -> nothing returned, withheld (fail closed)', JSON.stringify(sync.scrubFailLines(raw, null)) === JSON.stringify({ lines: [], withheld: true }));
  const W = r9Fixture('t155g', { 'broken.test.cjs': 'broken' });
  wfx(W.p, '.claude/forge-bin/tool.cjs', 'TOOL-V2');
  const w = sync.runIsolatedSuite(W.p, 'broken.test.cjs', { timeoutMs: 30000, scrubberUnavailable: true });
  t('155g the isolated run with the scrubber unavailable: failed, lines withheld (none shown), the reason names forge-store', w.healthy === false && w.lines.length === 0 && w.tail.length === 0 && /forge-store\.cjs/.test(w.linesWithheld || ''));
  const sumW = sync.condenseDoctorSummary({ ok: false, checks: { tests: { ok: false, suites: 1, passed: 1, failed: 1, perSuite: [{ suite: 'q.test.cjs', passed: 1, failed: 1, ok: false, failures: ['  FAIL q ' + R9_SECRET_TEXT] }] } } });
  t('155h condenseDoctorSummary carries a red suite\'s counts + failing lines, re-scrubbed (a doctor that did not redact)', !!sumW.suiteFailures && sumW.suiteFailures['q.test.cjs'].failed === 1 && sumW.suiteFailures['q.test.cjs'].lines.length === 1 && /REDACTED/.test(sumW.suiteFailures['q.test.cjs'].lines[0]) && r9NoSecret(JSON.stringify(sumW)));
  t('155h ...and a green summary carries no suiteFailures (a green baseline is unchanged)', !('suiteFailures' in sync.condenseDoctorSummary(r7Parsed([['g.test.cjs', 0]]))));
});

r4Section('156', () => {
  console.log('\n156) WP-SYNC-R9: the isolated runner — the template-identical suite pool (tree kill by PID) or a direct spawn; the doctor duration hint');
  const poolSrc = path.join(__dirname, 'forge-suite-pool.cjs');
  const F = r9Fixture('t156', { 'flaky.test.cjs': 'flaky' });
  wfx(F.p, '.claude/forge-bin/tool.cjs', 'TOOL-V2');
  fs.writeFileSync(path.join(F.aux, 'flaky.test.cjs.marker'), 'x'); // past its first post-sync run: passes alone
  if (!fs.existsSync(poolSrc)) console.log('  SKIP 156a: forge-suite-pool.cjs is not next to this test file — the pool path is NOT exercised');
  else {
    const tplDir = path.join(freshDir('t156-tpl'), '.claude');
    fs.mkdirSync(path.join(tplDir, 'forge-bin'), { recursive: true });
    fs.copyFileSync(poolSrc, path.join(tplDir, 'forge-bin', 'forge-suite-pool.cjs'));
    fs.copyFileSync(poolSrc, path.join(F.p, '.claude', 'forge-bin', 'forge-suite-pool.cjs'));
    t('156a trustedSuitePool: the project pool equal to the template\'s is used', sync.trustedSuitePool(F.p, tplDir) === path.join(path.resolve(F.p), '.claude', 'forge-bin', 'forge-suite-pool.cjs'));
    const viaPool = sync.runIsolatedSuite(F.p, 'flaky.test.cjs', { timeoutMs: 30000, templateDir: tplDir });
    t('156a through the pool: runner suite-pool, exit 0, 3 passed, healthy', viaPool.runner === 'suite-pool' && viaPool.exitCode === 0 && viaPool.passed === 3 && viaPool.healthy === true);
    fs.appendFileSync(path.join(F.p, '.claude', 'forge-bin', 'forge-suite-pool.cjs'), '\n// project edit\n');
    t('156b a pool the project changed is NOT used (direct spawn instead)', sync.trustedSuitePool(F.p, tplDir) === null && sync.runIsolatedSuite(F.p, 'flaky.test.cjs', { timeoutMs: 30000, templateDir: tplDir }).runner === 'direct');
  }
  t('156c no template dir -> direct spawn', sync.trustedSuitePool(F.p, null) === null && sync.runIsolatedSuite(F.p, 'flaky.test.cjs', { timeoutMs: 30000 }).runner === 'direct');
  t('156d the limit: the doctor\'s per-suite default (1500 s, WP-LIMITS) unless FORGE_DOCTOR_SUITE_TIMEOUT_MS or the option says otherwise',
    sync.DOCTOR_SUITE_TIMEOUT_MS_MIRROR === 1500000 && sync.isolatedRerunTimeout({ isolatedRerunTimeoutMs: 1234 }).timeoutMs === 1234
    && (process.env.FORGE_DOCTOR_SUITE_TIMEOUT_MS ? true : sync.isolatedRerunTimeout({}).timeoutMs === 1500000));
  const docSrc = fs.existsSync(path.join(__dirname, 'forge-doctor.cjs')) ? fs.readFileSync(path.join(__dirname, 'forge-doctor.cjs'), 'utf8') : '';
  t('156d ...the mirror matches forge-doctor.cjs DOCTOR_SUITE_TIMEOUT_MS (read, not required)', !docSrc || /const DOCTOR_SUITE_TIMEOUT_MS = 1500000;/.test(docSrc));
  // (e) the doctor's own per-suite duration hint: used only when written during the doctor run just made
  const hintFile = path.join(freshDir('t156e'), 'durations.json');
  let rk = path.resolve(F.p); if (process.platform === 'win32') rk = rk.toLowerCase();
  const key = require('crypto').createHash('sha256').update(rk).digest('hex').slice(0, 16);
  fs.writeFileSync(hintFile, JSON.stringify({ [key]: { at: 5000, ms: { 'flaky.test.cjs': 4321 } } }));
  t('156e doctorSuiteDurationHint: the recorded ms when written inside the doctor run window', sync.doctorSuiteDurationHint(F.p, 'flaky.test.cjs', 1000, 6000, hintFile) === 4321);
  t('156e ...null when the record is older than the run (stale), or the suite/file is unknown', sync.doctorSuiteDurationHint(F.p, 'flaky.test.cjs', 9000, 20000, hintFile) === null && sync.doctorSuiteDurationHint(F.p, 'other.test.cjs', 1000, 6000, hintFile) === null && sync.doctorSuiteDurationHint(F.p, 'flaky.test.cjs', 1000, 6000, path.join(F.aux, 'none.json')) === null);
  const rep = sync.suiteCheckReportLines({ mode: 'rerun', timeoutMs: 600000, timeoutSource: 'x', kept: false, decision: 'd', flakyUnderLoad: [], suites: [{ suite: 'q.test.cjs', kind: 'green->red', classification: 'regression', reason: 'r', firstRun: { passed: 1, failed: 1, timedOut: false, lines: ['FAIL ``` breaks a naive fence'], durationMs: 4321, durationSource: 'hint' }, isolated: null }] }).join('\n');
  t('156f the report fences failing lines with a fence longer than any backtick run in them; the first-run duration is shown', /````text\nFAIL ``` breaks a naive fence\n````/.test(rep) && /duration 4\.3 s \(hint\)/.test(rep));
  t('156g suiteTally reads the LAST anchored tally line (a description mentioning "0 passed, 0 failed" mid-line does not count)', JSON.stringify(sync.suiteTally('  ok  reports 0 passed, 0 failed when empty\n7 passed, 0 failed\n')) === JSON.stringify({ parsed: true, passed: 7, failed: 0 }) && sync.suiteTally('nothing').parsed === false);
});

// =====================================================================================================================
// WP-SYNC-R10 — the FINAL fix round for the Codex verification of R9/R8
// (.claude/forge-research/overhaul-2026-10-09/codex-r7-sync-worktrees-rerun.md). Sections 157-164, one finding each; every
// assertion marked was run against a pre-fix copy of forge-sync.cjs in an os.tmpdir() harness and FAILED there.
// Fixture suites are generated files in os.tmpdir(); their run counters and markers live OUTSIDE the project unless a test
// needs a file inside it on purpose. A grandchild process started by a test is killed by its exact PID only.
// =====================================================================================================================
/** r10Suite(p, name, kind, aux) — like r9Suite: green before the sync (tool.cjs != TOOL-V2); after the sync its FIRST run (the
 *  doctor run) fails (a marker in aux), and later runs (alone) behave per kind:
 *   partial     5 passed before; 4 passed 1 failed in the doctor run; alone only "1 passed, 0 failed" (skips most of itself)
 *   contradict  alone: stdout "FAIL real assertion" + "99 passed, 1 failed", stderr "1 passed, 0 failed", exit 0
 *   twotallies  alone: stdout "1 passed, 0 failed" then "5 passed, 0 failed", exit 0
 *   failline    alone: stdout "  FAIL hidden assertion" + "3 passed, 0 failed", exit 0
 *   projcounter every run appends to <project>/r10-runs.log; alone green
 *   envleak     alone: red when FORGE_R10_LEAK is in its environment, else green
 *   sleepy      alone: sleeps 4 s, then green
 *   passalone   alone: green (used with a doctor stub that reports it TIMED OUT) */
function r10Suite(p, name, kind, aux) {
  const marker = path.join(aux, name + '.marker');
  const counter = path.join(aux, name + '.runs');
  const projLog = path.join(p, 'r10-runs.log');
  wfx(p, '.claude/forge-bin/' + name, [
    '#!/usr/bin/env node',
    'var fs = require("fs"), path = require("path");',
    'fs.appendFileSync(' + JSON.stringify(counter) + ', "run\\n");',
    'var post = false; try { post = fs.readFileSync(path.join(__dirname, "tool.cjs"), "utf8") === "TOOL-V2"; } catch (e) {}',
    'var first = !fs.existsSync(' + JSON.stringify(marker) + ');',
    'var kind = ' + JSON.stringify(kind) + ';',
    'if (kind === "projcounter") fs.appendFileSync(' + JSON.stringify(projLog) + ', "run\\n");',
    'function green(n) { console.log("  ok  steady assertion"); console.log((n || 3) + " passed, 0 failed"); process.exit(0); }',
    'function red(pp, ff) { if (post) fs.writeFileSync(' + JSON.stringify(marker) + ', "x"); for (var i = 1; i <= ff; i++) console.log("  FAIL ' + name + ' assertion " + i); console.log(pp + " passed, " + ff + " failed"); process.exit(1); }',
    'if (!post) green(kind === "partial" ? 5 : 3);',
    'if (first && post) { if (kind === "partial") red(4, 1); red(1, 1); }',
    'if (kind === "partial") { console.log("1 passed, 0 failed"); process.exit(0); }',
    'if (kind === "contradict") { console.log("  FAIL real assertion"); console.log("99 passed, 1 failed"); console.error("1 passed, 0 failed"); process.exit(0); }',
    'if (kind === "twotallies") { console.log("1 passed, 0 failed"); console.log("5 passed, 0 failed"); process.exit(0); }',
    'if (kind === "failline") { console.log("  FAIL hidden assertion"); console.log("3 passed, 0 failed"); process.exit(0); }',
    'if (kind === "envleak") { if (process.env.FORGE_R10_LEAK) { console.log("  FAIL saw FORGE_R10_LEAK"); console.log("2 passed, 1 failed"); process.exit(1); } green(); }',
    'if (kind === "sleepy") { var until = Date.now() + 4000; (function w() { if (Date.now() < until) return setTimeout(w, 50); green(); })(); }',
    'else green();',
  ].join('\n'));
  return { counter, marker, projLog, runs: () => { try { return fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } } };
}
/** r10Fixture(name, kinds, opts) — the R9 fixture (real doctor stub that runs every suite) with r10Suite suites. */
function r10Fixture(name, kinds, opts) {
  const p = projWp2c(name, { doctorExit: null });
  r9Doctor(p, opts);
  const aux = freshDir(name + '-aux');
  const suites = {};
  for (const [file, kind] of Object.entries(kinds)) suites[file] = r10Suite(p, file, kind, aux);
  const { tpl } = tplHomeWp2c(name + '-tpl');
  return { p, tpl, aux, suites };
}
/** r10OneSuite(name, kind) — a project already on TOOL-V2 whose suite is past its first post-sync run (unit-level re-runs). */
function r10OneSuite(name, kind) {
  const F = r10Fixture(name, { [name + '.test.cjs']: kind });
  wfx(F.p, '.claude/forge-bin/tool.cjs', 'TOOL-V2');
  fs.writeFileSync(F.suites[name + '.test.cjs'].marker, 'x');
  return F;
}

r4Section('157', () => {
  console.log('\n157) WP-SYNC-R10 (Codex R9-01): passing alone needs COVERAGE PARITY with the doctor run; without a first-run tally it is a stated heuristic');
  const F = r10Fixture('t157', { 'partial.test.cjs': 'partial' });
  const r = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b157', nowIso: NOW_R9 })).r;
  const s0 = ((r.suiteCheck || {}).suites || [])[0] || {};
  t('157a [R10] 4 passed + 1 failed in the doctor run, only "1 passed, 0 failed" alone: a REGRESSION (lost coverage), rolled back',
    r.ok === false && r.rolledBack === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && s0.classification === 'regression' && s0.acceptance === 'coverage-parity' && /LESS coverage/.test(s0.reason || '') && /1 passed alone < 4 passed \+ 1 failed = 5/.test(s0.reason || ''));
  t('157a ...re-run exactly once (pre doctor, post doctor, isolated = 3 runs)', F.suites['partial.test.cjs'].runs() === 3);
  t('157b [R10] isolatedAcceptance: parity met -> accepted with the rule named; first-run tally unknown -> accepted as a stated HEURISTIC',
    typeof sync.isolatedAcceptance === 'function' && sync.isolatedAcceptance({ passed: 1, failed: 1 }, { healthy: true, passed: 3 }).accept === true && sync.isolatedAcceptance({ passed: 1, failed: 1 }, { healthy: true, passed: 3 }).rule === 'coverage-parity'
    && sync.isolatedAcceptance({ passed: 99, failed: 1 }, { healthy: true, passed: 1 }).accept === false
    && sync.isolatedAcceptance({ passed: 0, failed: 0 }, { healthy: true, passed: 2 }).rule === 'heuristic' && /HEURISTIC/.test(sync.ACCEPTANCE_HEURISTIC_NOTE));
  // (c) the flaky fixture still keeps the sync (3 alone >= 1 + 1) and the record names the parity rule
  const K = r9Fixture('t157c', { 'flaky.test.cjs': 'flaky' });
  const rk = quiet(() => sync.safeSyncProject(K.tpl, K.p, { batchId: 'b157c', nowIso: NOW_R9 })).r;
  const k0 = ((rk.suiteCheck || {}).suites || [])[0] || {};
  t('157c [R10] parity met (3 passed alone >= 1 passed + 1 failed): kept, and the record says which rule accepted it', rk.ok === true && k0.classification === 'flaky-under-load' && k0.acceptance === 'coverage-parity' && /coverage parity: 3 passed alone >= 2/.test(k0.reason || ''));
});

r4Section('158', () => {
  console.log('\n158) WP-SYNC-R10 (Codex R9-02): the tally comes from STDOUT only, must be ONE distinct tally, and a FAIL line in stdout vetoes a green tally');
  t('158a [R10] suiteTally: two DIFFERENT tallies are ambiguous (nothing parsed); the same tally twice is one', sync.suiteTally('1 passed, 0 failed\n99 passed, 1 failed\n').parsed === false && sync.suiteTally('1 passed, 0 failed\n99 passed, 1 failed\n').ambiguous === true
    && JSON.stringify(sync.suiteTally('3 passed, 0 failed\n3 passed, 0 failed\n')) === JSON.stringify({ parsed: true, passed: 3, failed: 0 }));
  const C = r10OneSuite('contradict', 'contradict');
  const rc = sync.runIsolatedSuite(C.p, 'contradict.test.cjs', { timeoutMs: 30000 });
  t('158b [R10] the Codex probe — stdout "FAIL real assertion" + "99 passed, 1 failed", stderr "1 passed, 0 failed", exit 0: NOT healthy (stdout tally 99/1)', rc.exitCode === 0 && rc.healthy === false && rc.passed === 99 && rc.failed === 1);
  const T = r10OneSuite('twotallies', 'twotallies');
  const rt = sync.runIsolatedSuite(T.p, 'twotallies.test.cjs', { timeoutMs: 30000 });
  t('158c [R10] two different tallies in stdout ("1 passed" then "5 passed"), exit 0: ambiguous, NOT healthy, the verdict says so', rt.exitCode === 0 && rt.healthy === false && rt.tallyAmbiguous === true && /several DIFFERENT tallies/.test(sync.isolatedVerdict ? sync.isolatedVerdict(rt) : ''));
  const L = r10OneSuite('failline', 'failline');
  const rl = sync.runIsolatedSuite(L.p, 'failline.test.cjs', { timeoutMs: 30000 });
  t('158d [R10] "FAIL hidden assertion" next to a green "3 passed, 0 failed" in stdout, exit 0: contradictory, NOT healthy', rl.exitCode === 0 && rl.passed === 3 && rl.healthy === false && rl.stdoutFailLines === 1);
  // (e) end to end: the contradicting suite no longer keeps the sync
  const E = r10Fixture('t158e', { 'contradict.test.cjs': 'contradict' });
  const re = quiet(() => sync.safeSyncProject(E.tpl, E.p, { batchId: 'b158e', nowIso: NOW_R9 })).r;
  t('158e [R10] install: the contradicting suite is a regression and the sync is rolled back', re.ok === false && re.rolledBack === true && rfx(E.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
});

r4Section('159', () => {
  console.log('\n159) WP-SYNC-R10 (Codex R9-03): the WHOLE output is redacted before any line is picked — multi-line credential blocks never leak line by line');
  const crypto = require('crypto');
  const BEGIN = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----', END = '-----END ' + 'RSA PRIVATE' + ' KEY-----';
  const body = Array.from({ length: 4 }, () => crypto.randomBytes(48).toString('base64')); // synthetic (FAKE) key body, built at run time
  const scrub = sync.loadDoctorScrubber();
  const RSO = (txt, sc) => (typeof sync.redactSuiteOutput === 'function' ? sync.redactSuiteOutput(txt, sc) : { lines: [], blocks: 0, unterminated: false, withheld: true });
  const whole = RSO(['before', BEGIN].concat(body, [END, 'after']).join('\n'), scrub);
  t('159a [R10] redactSuiteOutput: a 6-line PEM block becomes ONE marker line; no body line survives', whole.blocks === 1 && whole.lines.includes('***REDACTED*** (credential block)') && !body.some((b) => whole.lines.join('\n').includes(b)) && whole.lines[0] === 'before' && whole.lines[whole.lines.length - 1] === 'after');
  const open = RSO(['before', BEGIN].concat(body).join('\n'), scrub);
  t('159b [R10] an UNTERMINATED block: everything from its BEGIN line to the end is withheld, and that is said', open.unterminated === true && !body.some((b) => open.lines.join('\n').includes(b)) && /unterminated/.test(open.lines[open.lines.length - 1]));
  const cross = RSO('x\npassword:\nhunter2' + 'Zq7Xw9\ny', scrub);
  t('159c [R10] a label on one line and its value on the next are redacted together', !cross.lines.join('\n').includes('hunter2' + 'Zq7Xw9') && cross.lines.length === 4);
  t('159c ...no scrubber -> nothing returned, withheld (fail closed)', typeof sync.redactSuiteOutput === 'function' && sync.redactSuiteOutput('a\nb', null).withheld === true && sync.redactSuiteOutput('a\nb', null).lines.length === 0);
  const big = Array.from({ length: 3000 }, (_, i) => 'line ' + i + ' ' + 'z'.repeat(30)).join('\n') + '\napi_key=' + 'Qx7' + 'Lm2'.repeat(6) + '\nend';
  const bigR = RSO(big, scrub);
  t('159d [R10] output larger than one redactText call (~110 KB): every line kept, in order, and the late secret is still redacted', bigR.lines.length === 3002 && bigR.lines[0].startsWith('line 0 ') && bigR.lines[3001] === 'end' && /api_key=\*\*\*REDACTED\*\*\*/.test(bigR.lines[3000]));
  // (e) the crash tail end to end: a suite that prints a PEM block to stderr and dies without a FAIL line or a tally
  const P = r10OneSuite('pemtail', 'passalone');
  wfx(P.p, '.claude/forge-bin/pemtail.test.cjs', 'var b = ' + JSON.stringify([BEGIN].concat(body, [END])) + ';\nconsole.error("setup failed:"); b.forEach(function (l) { console.error(l); });\nprocess.exit(1);\n');
  const pt = sync.runIsolatedSuite(P.p, 'pemtail.test.cjs', { timeoutMs: 30000 });
  t('159e [R10] crash tail after a PEM block on stderr: no body line in the kept lines; the block shows as one redaction marker', pt.healthy === false && pt.tail.length > 0 && !body.some((b) => JSON.stringify(pt).includes(b)) && pt.tail.some((l) => /REDACTED\*\*\* \(credential block\)/.test(l)));
  wfx(P.p, '.claude/forge-bin/pemtail.test.cjs', 'var b = ' + JSON.stringify([BEGIN].concat(body)) + ';\nb.forEach(function (l) { console.error(l); });\nprocess.exit(1);\n');
  const po = sync.runIsolatedSuite(P.p, 'pemtail.test.cjs', { timeoutMs: 30000 });
  t('159f [R10] the tail of an UNTERMINATED block is withheld (not its last 3 body lines), and the record says why', po.healthy === false && !body.some((b) => JSON.stringify(po).includes(b)) && /unterminated/.test(po.outputWithheld || ''));
});

r4Section('160', () => {
  console.log('\n160) WP-SYNC-R10 (Codex R9-04): ANY throw inside the isolated re-run step keeps the failed outcome and the rollback still runs');
  const F = r9Fixture('t160', { 'flaky.test.cjs': 'flaky' });
  const pool = path.join(path.resolve(F.p), '.claude', 'forge-bin', 'forge-suite-pool.cjs').toLowerCase();
  const origExists = fs.existsSync;
  // the injected failure: fs.existsSync throws for this project's suite-pool path, but only when called from trustedSuitePool
  // (inside the re-run step) — the message carries a fake credential so the scrubbing of the error is proven too
  fs.existsSync = function (p) {
    if (String(p).toLowerCase() === pool && /trustedSuitePool/.test(new Error().stack || '')) throw new Error('injected failure inside the re-run step ' + R9_SECRET_TEXT);
    return origExists.apply(fs, arguments);
  };
  let r = null, threw = null;
  try { r = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b160', nowIso: NOW_R9 })).r; } catch (e) { threw = e; } finally { fs.existsSync = origExists; }
  t('160a [R10] the throw does not escape safeSyncProject', threw === null, threw && threw.message);
  t('160a [R10] ...the batch is ROLLED BACK (tool.cjs back on TOOL-V1, no receipt for it), the outcome stays failed', !!r && r.ok === false && r.rolledBack === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && !(sync.readReceipt(F.p) || {}).batchId);
  t('160b [R10] the suite check records mode "error" with the message, and the outcome reason says the re-run step failed', !!r && !!r.suiteCheck && r.suiteCheck.mode === 'error' && /injected failure/.test(r.suiteCheck.error || '') && /isolated re-run step failed unexpectedly/.test(r.outcome.reason || ''));
  const rep = r && r.report && r.report.path ? r7Read(r.report.path) : '';
  t('160c [R10] (R9-07) the thrown message is scrubbed everywhere: result, outcome and the change report carry no raw secret', !!r && r9NoSecret(JSON.stringify(r.suiteCheck)) && r9NoSecret(r.outcome.reason) && /Suite regression check[\s\S]*FAILED/.test(rep) && r9NoSecret(rep));
});

r4Section('161', () => {
  console.log('\n161) WP-SYNC-R10 (Codex R9-05): a doctor-run TIMEOUT is never re-run; the whole phase has a budget; a timeout kills the suite TREE by PID');
  // (a) a doctor stub that reports passalone.test.cjs as TIMED OUT after the sync (blocked), though it passes alone
  const p = projWp2c('t161a', { doctorExit: null });
  const aux = freshDir('t161a-aux');
  const s = r10Suite(p, 'passalone.test.cjs', 'passalone', aux);
  fs.writeFileSync(s.marker, 'x'); // past its first post-sync run: it WOULD pass alone (the stub doctor never runs it)
  const tool = path.join(p, '.claude', 'forge-bin', 'tool.cjs');
  wfx(p, '.claude/forge-bin/forge-doctor.cjs', [
    'var fs = require("fs");',
    'var post = false; try { post = fs.readFileSync(' + JSON.stringify(tool) + ', "utf8") === "TOOL-V2"; } catch (e) {}',
    'var s = post ? { suite: "passalone.test.cjs", passed: 0, failed: 0, ok: false, timedOut: true, signal: "SIGTERM" } : { suite: "passalone.test.cjs", passed: 3, failed: 0, ok: true, timedOut: false };',
    'var steady = { suite: "steady.test.cjs", passed: 5, failed: 0, ok: true, timedOut: false };', // positive evidence in both runs
    'var checks = { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: !post, suites: 2, passed: s.passed + 5, failed: 0, suitesFailed: 0, suitesBlocked: post ? 1 : 0, perSuite: [s, steady] }, leak_scan: { ok: true } };',
    'if (process.argv.indexOf("--json") !== -1) console.log(JSON.stringify({ ok: !post, checks: checks }));',
    'process.exit(post ? 1 : 0);',
  ].join('\n'));
  const { tpl } = tplHomeWp2c('t161a-tpl');
  const ra = quiet(() => sync.safeSyncProject(tpl, p, { batchId: 'b161a', nowIso: NOW_R9 })).r;
  const a0 = ((ra.suiteCheck || {}).suites || [])[0] || {};
  t('161a [R10] a suite that TIMED OUT inside the doctor run is NOT re-run (0 runs) and counts as a regression: rolled back',
    ra.ok === false && ra.rolledBack === true && s.runs() === 0 && a0.isolated === null && a0.classification === 'regression' && /TIMED OUT inside the doctor run/.test(a0.reason || '') && rfx(p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  // (b) the aggregate budget: two flagged sleepy suites (4 s each alone), a 2.5 s budget for the WHOLE phase
  const B = r10Fixture('t161b', { 'sleepy-a.test.cjs': 'sleepy', 'sleepy-b.test.cjs': 'sleepy' });
  const t0 = Date.now();
  const rb = quiet(() => sync.safeSyncProject(B.tpl, B.p, { batchId: 'b161b', nowIso: NOW_R9, isolatedRerunBudgetMs: 2500 })).r;
  const bs = (rb.suiteCheck || {}).suites || [];
  const ba = bs.find((x) => x.suite === 'sleepy-a.test.cjs') || {}, bb = bs.find((x) => x.suite === 'sleepy-b.test.cjs') || {};
  t('161b [R10] budget 2.5 s: the first suite is stopped at the end of the budget (timed out), the second is NOT run — both regressions, rolled back',
    rb.ok === false && rb.rolledBack === true && !!ba.isolated && ba.isolated.timedOut === true && ba.isolated.limitedByBudget === true && bb.isolated === null && bb.budgetExhausted === true && B.suites['sleepy-b.test.cjs'].runs() === 2 && rb.suiteCheck.budgetMs === 2500);
  t('161b ...and the phase did not run the full 2 x 4 s (took ' + (Date.now() - t0) + ' ms for the whole install)', Date.now() - t0 < 60000 && Number.isFinite(rb.suiteCheck.phaseMs) && rb.suiteCheck.phaseMs < 9000);
  const pa = sync.parseArgs(['proj', '--isolated-rerun-budget', '90000']);
  const pbad = sync.parseArgs(['proj', '--isolated-rerun-budget', 'soon']);
  t('161c [R10] parseArgs: --isolated-rerun-budget <ms> (a positive number; anything else is a usage error); the default is 20 min',
    !pa.argError && pa.flags.isolatedRerunBudget === 90000 && JSON.stringify(pa.pos) === JSON.stringify(['proj']) && /--isolated-rerun-budget must be a positive number/.test(pbad.argError || '') && sync.ISOLATED_RERUN_BUDGET_DEFAULT_MS === 1200000 && sync.isolatedRerunBudget({}).budgetMs === 1200000);
  const C1 = r9Fixture('t161d', { 'flaky.test.cjs': 'flaky' });
  const cli = runCLIWithTemplate(['install', C1.p, '--batch-id', 'b161d', '--isolated-rerun-budget', '1'], C1.tpl);
  // a 1 ms budget is used up by the first change snapshot (not re-run) or ends the suite at once (timed out) — either way a regression
  t('161d [R10] (CLI) install --isolated-rerun-budget 1: the budget reaches the sync — rolled back, exit 1, the console names the budget', cli.status === 1 && C1.suites['flaky.test.cjs'].runs() <= 3 && rfx(C1.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && /aggregate re-run budget/.test(cli.stdout + cli.stderr));
  // (e) the tree kill: a suite that starts a grandchild and hangs, through forge-sync's own runner (no pool)
  const G = r10OneSuite('tree', 'passalone');
  const pidFile = path.join(G.aux, 'grandchild.pid');
  wfx(G.p, '.claude/forge-bin/tree.test.cjs', 'var cp = require("child_process"), fs = require("fs");\nvar g = cp.spawn(process.execPath, ["-e", "setInterval(function () {}, 1000)"], { stdio: "ignore" });\nfs.writeFileSync(' + JSON.stringify(pidFile) + ', String(g.pid));\nsetInterval(function () {}, 1000);\n');
  const tg = sync.runIsolatedSuite(G.p, 'tree.test.cjs', { timeoutMs: 2000, forceDirect: true });
  let gpid = null; try { gpid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { gpid = null; }
  let alive = false;
  if (gpid) { try { process.kill(gpid, 0); alive = true; } catch { alive = false; } }
  if (alive) { try { process.kill(gpid); } catch { /* exact PID of the grandchild this test started */ } }
  t('161e [R10] at the limit the suite\'s whole process TREE is killed by its PID — its grandchild (pid ' + gpid + ') is gone too', tg.timedOut === true && tg.runner === 'direct' && !!gpid && alive === false && /\/PID|process group|pid/.test(tg.killed || ''));
  t('161e ...the kill names the exact PID it used, never an image name', !/\/IM\b/i.test(tg.killed || '') && (tg.killed || '').includes(String(tg.pid)));
});

r4Section('162', () => {
  console.log('\n162) WP-SYNC-R10 (Codex R9-06): the re-run gets an allow-listed environment, and the files it changed under the project are named (not auto-rejected)');
  const prevLeak = process.env.FORGE_R10_LEAK;
  process.env.FORGE_R10_LEAK = '1';
  let r;
  const E = r10Fixture('t162a', { 'envleak.test.cjs': 'envleak' });
  try { r = quiet(() => sync.safeSyncProject(E.tpl, E.p, { batchId: 'b162a', nowIso: NOW_R9 })).r; }
  finally { if (prevLeak === undefined) delete process.env.FORGE_R10_LEAK; else process.env.FORGE_R10_LEAK = prevLeak; }
  const sc = r.suiteCheck || {};
  t('162a [R10] a variable outside the allow-list (FORGE_R10_LEAK, set in this process) never reaches the re-run: the suite passes alone, kept', r.ok === true && ((sc.suites || [])[0] || {}).classification === 'flaky-under-load' && E.suites['envleak.test.cjs'].runs() === 3);
  t('162a [R10] the record names the kept variable NAMES (never values) and the dropped count', !!sc.env && Array.isArray(sc.env.kept) && !sc.env.kept.includes('FORGE_R10_LEAK') && sc.env.dropped >= 1 && sc.env.kept.some((k) => k.toUpperCase() === 'PATH')
    && JSON.stringify(Object.keys(sc.env).sort()) === JSON.stringify(['allowList', 'dropped', 'kept']) && sc.env.kept.every((k) => /^[A-Za-z_][A-Za-z0-9_()]*$/.test(k)));
  const envR = typeof sync.isolatedRerunEnv !== 'function' ? { kept: [], dropped: -1 } : sync.isolatedRerunEnv({ Path: 'p', SystemRoot: 'r', NODE_OPTIONS: '--require x', FORGE_SYNC_TEST_HOOKS: '1', GIT_DIR: 'g', API_KEY: 'k', LC_ALL: 'C', FORGE_DOCTOR_SUITE_TIMEOUT_MS: '5' });
  t('162b [R10] isolatedRerunEnv: PATH / SystemRoot / LC_* / the doctor suite limit pass; NODE_OPTIONS, test seams, GIT_*, credentials do not',
    JSON.stringify(envR.kept) === JSON.stringify(['FORGE_DOCTOR_SUITE_TIMEOUT_MS', 'LC_ALL', 'Path', 'SystemRoot']) && envR.dropped === 4);
  // (c) a suite that writes into the project on every run: kept (not auto-rejected) but the changed file is NAMED
  const C = r10Fixture('t162c', { 'projcounter.test.cjs': 'projcounter' });
  const rc = quiet(() => sync.safeSyncProject(C.tpl, C.p, { batchId: 'b162c', nowIso: NOW_R9 })).r;
  const c0 = ((rc.suiteCheck || {}).suites || [])[0] || {};
  const pc = c0.isolated && c0.isolated.projectChanges;
  t('162c [R10] the isolated run\'s write into the project is recorded: 1 changed file, named r10-runs.log', rc.ok === true && !!pc && pc.changed === 1 && pc.created === 0 && JSON.stringify(pc.names) === JSON.stringify(['~ r10-runs.log']));
  const rep = rc.report && rc.report.path ? r7Read(rc.report.path) : '';
  t('162c [R10] ...and the change report says so, with the explicit "not rejected automatically" note', /The isolated run: files under the project changed by this run: 0 created, 1 changed, 0 removed — ~ r10-runs\.log/.test(rep) && /NOT rejected automatically/.test(rep) && /Environment of the re-runs: only an allow-list/.test(rep));
  const hasSnap = typeof sync.projectChangeSnapshot === 'function';
  const snapA = hasSnap ? sync.projectChangeSnapshot(C.p) : null;
  wfx(C.p, '.claude/worktrees/agent-1/.git', 'gitdir: x\n');
  wfx(C.p, '.claude/worktrees/agent-1/inside.txt', 'not walked');
  const snapB = hasSnap ? sync.projectChangeSnapshot(C.p) : null;
  const d = hasSnap ? sync.projectChangesBetween(snapA, snapB, sync.loadDoctorScrubber()) : { names: ['agent-1'], created: 0 };
  t('162d [R10] the change snapshot never walks an agent checkout (a child of .claude/worktrees holding a .git entry)', !d.names.some((n) => /agent-1/.test(n)) && d.created >= 1 && d.names.includes('+ .claude/worktrees/'));
});

r4Section('163', () => {
  console.log('\n163) WP-SYNC-R10 (Codex R8-01 / R8-03a): only CHECKOUTS under .claude/worktrees are summarized; a memory link into it is refused');
  const { tpl } = tplHomeWp2c('t163-tpl', { settings: false });
  const p = projWp2c('t163a');
  wfx(p, '.claude/worktrees/agent-1/.git', 'gitdir: ' + path.join(p, '.git', 'worktrees', 'agent-1') + '\n');
  wfx(p, '.claude/worktrees/agent-1/src/inside.txt', 'checkout content');
  wfx(p, '.claude/worktrees/shared-memory/MEMORY.md', '# shared memory\n');
  wfx(p, '.claude/worktrees/notes.txt', 'plain file AAAA');
  const m = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C });
  t('163a [R10] a NON-checkout folder under .claude/worktrees is walked and hashed (shared-memory/MEMORY.md has a sha256)', !!m.entries['.claude/worktrees/shared-memory/MEMORY.md'] && m.entries['.claude/worktrees/shared-memory/MEMORY.md'].kind === 'file' && /^[0-9a-f]{64}$/.test(m.entries['.claude/worktrees/shared-memory/MEMORY.md'].hash));
  t('163a ...the checkout next to it is one entry, nothing inside it', (m.entries['.claude/worktrees/agent-1'] || {}).checkout === true && !m.entries['.claude/worktrees/agent-1/src/inside.txt']);
  fs.appendFileSync(path.join(p, '.claude', 'worktrees', 'shared-memory', 'MEMORY.md'), 'a planted line\n');
  t('163b [R10] an edit inside a non-checkout folder there is a violation', sync.protectViolationLines(sync.verifyProtect(p, m, null)).includes('CHANGED .claude/worktrees/shared-memory/MEMORY.md'));
  fs.writeFileSync(path.join(p, '.claude', 'worktrees', 'shared-memory', 'MEMORY.md'), '# shared memory\n');
  fs.writeFileSync(path.join(p, '.claude', 'worktrees', 'notes.txt'), 'plain file BBBB'); // same size, other content
  t('163c [R10] (R8-03a) a plain FILE directly under .claude/worktrees is content-hashed: a same-size edit is a violation', sync.protectViolationLines(sync.verifyProtect(p, m, null)).includes('CHANGED .claude/worktrees/notes.txt'));
  fs.writeFileSync(path.join(p, '.claude', 'worktrees', 'notes.txt'), 'plain file AAAA');
  fs.writeFileSync(path.join(p, '.claude', 'worktrees', 'agent-1', '.git'), 'gitdir: ' + path.join(p, '.git', 'worktrees', 'agent-OTHER') + '\n');
  t('163d [R10] checkout A swapped for checkout B under the same name (its .git pointer changed) is a violation', sync.protectViolationLines(sync.verifyProtect(p, m, null)).includes('CHANGED .claude/worktrees/agent-1'));
  // (e) a never-touch / memory folder as a junction INTO .claude/worktrees is refused, loudly; the install refuses before writing
  const pL = makeProject(freshDir('t163e-root'), 'proj', 0);
  wfx(pL, '.claude/worktrees/shared-scribe/inbox.jsonl', '{"ask":"owner instruction"}\n');
  if (r3Junction(path.join(pL, '.claude', 'worktrees', 'shared-scribe'), path.join(pL, '.claude', 'forge-scribe'), '163e')) {
    let msg = '';
    try { sync.buildProtectManifest(tpl, pL, { nowIso: NOW_WP2C }); } catch (e) { msg = e.message; }
    t('163e [R10] .claude/forge-scribe as a junction into .claude/worktrees: buildProtectManifest REFUSES, naming the link', /refusing: \.claude\/forge-scribe is a link\/junction that resolves into \.claude\/worktrees/.test(msg));
    const v1 = sync.sha256(wfx(pL, '.claude/forge-bin/tool.cjs', 'TOOL-V1'));
    sync.writeReceipt(pL, { knownHashes: { 'forge-bin/tool.cjs': v1 } });
    const { tpl: tplS } = tplHomeWp2c('t163e-tpl');
    const rs = quiet(() => sync.safeSyncProject(tplS, pL, { batchId: 'b163e', nowIso: NOW_WP2C })).r;
    t('163e [R10] ...and an install into that project is refused before any write (tool.cjs still TOOL-V1)', rs.ok === false && /resolves into \.claude\/worktrees/.test(rs.reason || '') && rfx(pL, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
    fs.unlinkSync(path.join(pL, '.claude', 'forge-scribe'));
    const outside = freshDir('t163e-outside');
    if (r3Junction(outside, path.join(pL, '.claude', 'forge-scribe'), '163e2')) {
      let msg2 = '';
      try { sync.buildProtectManifest(tpl, pL, { nowIso: NOW_WP2C }); } catch (e) { msg2 = e.message; }
      // WP-SYNC-R14 — deliberate pin change: R10 recorded a memory junction pointing OUTSIDE the project by its target
      // (what it holds was never inventoried, so a change there was unseen); it is refused now, with its own reason
      t('163e [R14] ...a memory junction pointing OUTSIDE the project is refused too, with its own reason (R10: recorded by its target)', /refusing: \.claude\/forge-scribe is a link\/junction at or above a never-touch \/ memory path that resolves outside the project/.test(msg2) && !/resolves into \.claude\/worktrees/.test(msg2));
      fs.unlinkSync(path.join(pL, '.claude', 'forge-scribe'));
    }
  }
  // (f) a link that is itself INSIDE .claude/worktrees is not an alias of memory: recorded by its target, no refusal
  if (r3Junction(path.join(p, '.claude', 'worktrees', 'agent-1'), path.join(p, '.claude', 'worktrees', 'alias'), '163f')) {
    let mf = null; try { mf = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C }); } catch { mf = null; }
    t('163f a junction inside .claude/worktrees (to a sibling checkout) is recorded as a symlink entry, not refused', !!mf && (mf.entries['.claude/worktrees/alias'] || {}).kind === 'symlink');
    fs.unlinkSync(path.join(p, '.claude', 'worktrees', 'alias'));
  }
  t('163f linkIntoWorktrees: a path that is not a link resolves to nothing', typeof sync.linkIntoWorktrees === 'function' && sync.linkIntoWorktrees(path.join(p, '.claude', 'nope'), path.join(p, '.claude')) === null);
  // (g) case on Windows/macOS: .claude/Worktrees is the same folder — its checkouts are summarized too
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const pc = projWp2c('t163g');
    wfx(pc, '.claude/Worktrees/agent-9/.git', 'gitdir: x\n');
    wfx(pc, '.claude/Worktrees/agent-9/src/HASHME.txt', 'x');
    const mc = sync.buildProtectManifest(tpl, pc, { nowIso: NOW_WP2C });
    t('163g .claude/Worktrees (other case): its checkout is one entry, nothing inside it', !!mc.entries['.claude/Worktrees/agent-9'] && (mc.entries['.claude/Worktrees/agent-9'] || {}).checkout === true && !JSON.stringify(mc).includes('HASHME'));
  }
  // (h) an R8 manifest (whole-folder summary) is still verified the R8 way — no false alarm, symmetric
  const mR8 = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C, summarizeDirs: ['worktrees'], checkoutDirs: [] });
  delete mR8.checkoutDirs;
  t('163h an R8-written manifest (summarizedDirs, no checkoutDirs) verifies the R8 way: ok on the untouched project', JSON.stringify(mR8.summarizedDirs) === JSON.stringify(['.claude/worktrees/']) && (mR8.entries['.claude/worktrees'] || {}).summarized === true && sync.verifyProtect(p, mR8, null).ok === true);
});

if (!PUB_GIT_OK) console.log('\n164) SKIP: git is not available here — the workspace fingerprint needs git; NOT exercised');
else r4Section('164', () => {
  console.log('\n164) WP-SYNC-R10 (Codex R8-03c): the --reuse-pre-baseline fingerprint sees .claude/worktrees through two cheap stand-ins');
  const p = projWp2c('t164', { doctorExit: null });
  wfx(p, 'src/app.js', 'console.log(1);\n');
  const g = pubGit(p);
  g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
  wfx(p, '.claude/worktrees/scratch/deep/f.txt', 'scratch');
  const fp0 = sync.workspaceFingerprint(p);
  wfx(p, '.claude/worktrees/agent-2/.git', 'gitdir: x\n');
  const fp1 = sync.workspaceFingerprint(p);
  t('164a [R10] a checkout appearing under .claude/worktrees changes the fingerprint (no stale reuse)', !!fp0 && !!fp1 && fp1.gitStatusHash !== fp0.gitStatusHash);
  wfx(p, '.claude/worktrees/notes.txt', 'a');
  const fp2 = sync.workspaceFingerprint(p);
  wfx(p, '.claude/worktrees/notes.txt', 'ab');
  t('164b [R10] a plain file directly under .claude/worktrees changing changes it too', sync.workspaceFingerprint(p).gitStatusHash !== fp2.gitStatusHash);
  const fp3 = sync.workspaceFingerprint(p);
  fs.writeFileSync(path.join(p, '.claude', 'worktrees', 'scratch', 'deep', 'f.txt'), 'edited');
  t('164c STATED LIMIT, pinned: an edit to an UNTRACKED file deeper inside a non-checkout folder there does not', sync.workspaceFingerprint(p).gitStatusHash === fp3.gitStatusHash);
});

// =====================================================================================================================
// WP-SYNC-R11. FOUND by the second REAL 26H2 install: the post-sync
// doctor ran BEFORE the settings.json merge, so shipped suites that assert the project's OWN .claude/settings.json
// (forge-stop-obligations: exactly one Stop hook; forge-gate-secretprint: the forge-accounts deny rule) judged the OLD settings
// and failed — in the doctor run AND alone — and every real project crossing that boundary was rolled back. Fix: the merge (its
// undo record in the batch) runs BEFORE the doctor and the isolated re-run; in-run rollbacks restore settings.json byte-for-byte.
// Sections 165-171; every fixture is os.tmpdir()-only. Assertions marked fail on the pre-fix forge-sync.cjs.
// =====================================================================================================================
const NOW_R11 = '2026-10-10T23:00:00.000Z';
/** r11Suite(p, name, mode, aux) — a real suite file shaped like the shipped suites the real install tripped on. Before the sync
 *  (tool.cjs != TOOL-V2) it is green and asserts nothing; its NEW version (after the sync) asserts that the project's own
 *  .claude/settings.json carries the template's forge-gate-hook.cjs hook. Every run appends what it saw to aux/<name>.saw (OUTSIDE
 *  the project, never protect-hashed): 'pre:<state>' or 'post:<state>', state = hook | nohook | missing | unreadable.
 *  mode 'asserts' — as above; 'flaky-asserts' — its FIRST post-sync run (the doctor run) fails whatever it sees, later runs assert
 *  the hook; 'broken' — every post-sync run fails for another reason; 'rewrite-broken' — post-sync it rewrites settings.json, then
 *  fails (a suite writing into the file the merge owns). */
function r11Suite(p, name, mode, aux) {
  const saw = path.join(aux, name + '.saw');
  const marker = path.join(aux, name + '.marker');
  wfx(p, '.claude/forge-bin/' + name, [
    '#!/usr/bin/env node',
    'var fs = require("fs"), path = require("path");',
    'var post = false; try { post = fs.readFileSync(path.join(__dirname, "tool.cjs"), "utf8") === "TOOL-V2"; } catch (e) {}',
    'var sp = path.join(__dirname, "..", "settings.json"), st = "missing";',
    'try { st = fs.readFileSync(sp, "utf8").indexOf("forge-gate-hook.cjs") !== -1 ? "hook" : "nohook"; } catch (e) { st = fs.existsSync(sp) ? "unreadable" : "missing"; }',
    'fs.appendFileSync(' + JSON.stringify(saw) + ', (post ? "post:" : "pre:") + st + "\\n");',
    'function green() { console.log("  ok  settings.json carries the forge-gate-hook.cjs hook"); console.log("2 passed, 0 failed"); process.exit(0); }',
    'function red(why) { console.log("  FAIL settings.json carries the forge-gate-hook.cjs hook - " + why); console.log("1 passed, 1 failed"); process.exit(1); }',
    'var mode = ' + JSON.stringify(mode) + ';',
    'if (!post) green();',
    'if (mode === "broken") red("broken for another reason");',
    'if (mode === "rewrite-broken") { fs.writeFileSync(sp, "{\\"rewritten by a suite\\": true}\\n"); red("broken, and it rewrote settings.json"); }',
    'if (mode === "flaky-asserts" && !fs.existsSync(' + JSON.stringify(marker) + ')) { fs.writeFileSync(' + JSON.stringify(marker) + ', "x"); red("flaky: first run under load"); }',
    // WP-SYNC-R12 modes (sections 172-178): 'observe' — always green post-sync (only records what it saw); 'rewrite-green' — asserts the
    // hook, then rewrites settings.json and exits GREEN; 'flaky-rewrite' — its first post-sync run rewrites settings.json and fails,
    // later runs pass (no assertion); 'plant-runs' — green, but writes into the protected .claude/forge-runs/; 'dir-settings' — turns
    // settings.json into a folder and fails; 'diverge-dir' — also rewrites the synced tool.cjs (diverged since the sync wrote it).
    'if (mode === "observe") green();',
    'if (mode === "rewrite-green") { var had = st === "hook"; fs.writeFileSync(sp, "{\\"rewritten by a green suite\\": true}\\n"); if (had) green(); red("no template hook"); }',
    'if (mode === "flaky-rewrite") { if (!fs.existsSync(' + JSON.stringify(marker) + ')) { fs.writeFileSync(' + JSON.stringify(marker) + ', "x"); fs.writeFileSync(sp, "{\\"rewritten by a flaky suite\\": true}\\n"); red("flaky: first run under load, and it rewrote settings.json"); } green(); }',
    'if (mode === "plant-runs") { var pr = path.join(__dirname, "..", "forge-runs", "planted-by-a-suite"); fs.mkdirSync(pr, { recursive: true }); fs.writeFileSync(path.join(pr, "events.jsonl"), "{}\\n"); green(); }',
    'if (mode === "dir-settings" || mode === "diverge-dir") { if (mode === "diverge-dir") fs.writeFileSync(path.join(__dirname, "tool.cjs"), "TOOL-SUITE"); try { fs.rmSync(sp, { force: true }); } catch (e) {} fs.mkdirSync(sp); red("it turned settings.json into a folder"); }',
    'if (st === "hook") green();',
    'red("the project settings.json is " + st + " (no template hook)");',
  ].join('\n'));
  return { saw: () => { try { return fs.readFileSync(saw, 'utf8').split('\n').filter(Boolean); } catch { return []; } } };
}
/** r11Fixture(name, kinds, opts) — a project on TOOL-V1 (receipt baseline) with the R9 doctor (it really runs every suite) and
 *  the given suites ('steady' = the R9 steady suite, anything else = an r11Suite mode); opts.settings = the project's own
 *  settings.json bytes before the sync (omitted = none); the template ships TOOL-V2 + TPL_SETTINGS_WP2C (the gate hook). */
function r11Fixture(name, kinds, opts) {
  opts = opts || {};
  const p = projWp2c(name, { doctorExit: null });
  r9Doctor(p);
  const aux = freshDir(name + '-aux');
  const suites = {};
  for (const [file, mode] of Object.entries(kinds)) suites[file] = mode === 'steady' ? r9Suite(p, file, 'steady', aux) : r11Suite(p, file, mode, aux);
  const sPath = path.join(p, '.claude', 'settings.json');
  if (opts.settings != null) fs.writeFileSync(sPath, opts.settings);
  const { tpl } = tplHomeWp2c(name + '-tpl', opts.tplOpts);
  return { p, tpl, aux, suites, sPath };
}
const r11Ledger = (p, b) => { try { return JSON.parse(fs.readFileSync(path.join(p, '.claude', 'forge-backups', b, sync.SETTINGS_LEDGER_NAME), 'utf8')); } catch { return null; } };
const r11Hash = (f) => { try { return hashBuf(fs.readFileSync(f)); } catch { return null; } };

r4Section('165', () => {
  console.log('\n165) WP-SYNC-R11: a shipped suite asserting the project\'s own settings.json (the 26H2 shape) — the doctor judges the MERGED settings, the install succeeds');
  const F = r11Fixture('t165', { 'settings-assert.test.cjs': 'asserts', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const cap = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b165', nowIso: NOW_R11 }));
  const r = cap.r;
  const saw = F.suites['settings-assert.test.cjs'].saw();
  t('165a [R11] the install SUCCEEDS: ok:true, tool.cjs is TOOL-V2, a receipt is written, the doctor run was green', r.ok === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && !!r.receipt && r.receipt.batchId === 'b165' && !!r.validation && r.validation.ok === true);
  t('165a [R11] ...no suite regression to check at all (nothing went red), so nothing was re-run alone', r.suiteCheck === null && saw.length === 2);
  t('165b [R11] the post-sync doctor run SAW the merged settings.json (post:hook); the pre-sync baseline ran first, on the owner\'s unmerged file (pre:nohook)', JSON.stringify(saw) === JSON.stringify(['pre:nohook', 'post:hook']));
  const merged = fs.readFileSync(F.sPath, 'utf8');
  t('165c [R11] settings.json is merged on disk: the gate hook added, the owner\'s own key kept', /forge-gate-hook\.cjs/.test(merged) && /"ownerKey": "keep me"/.test(merged) && (r.settingsMerge || {}).status === 'merged');
  const led = r11Ledger(F.p, 'b165');
  t('165c [R11] the undo record is in the batch exactly as before: ledger applied, preHash = the owner bytes, postHash = the merged bytes', !!led && led.applied === true && led.status === 'merged' && led.preHash === hashBuf(OWNER_SETTINGS_BYTES) && led.postHash === r11Hash(F.sPath) && ((r.settingsMerge || {}).ledger || {}).preHash === led.preHash);
  t('165d protect: unchanged (settings.json and the new .forge-bak are the same allowed bookkeeping as before)', !!r.protect && r.protect.ok === true && sync.protectAllowance('.claude/settings.json') === 'any' && sync.protectAllowance('.claude/settings.json.forge-bak-20261010-230000-abcd') === 'add-only');
  const rep = r.report && r.report.path ? r7Read(r.report.path) : '';
  t('165e [R11] the change report: SYNCED, the settings.json section with the merge + its undo record, no Rollback section', /Outcome: \*\*SYNCED\*\*/.test(rep) && /## settings\.json[\s\S]*- Status: merged[\s\S]*undo record in the batch/.test(rep) && !/## Rollback/.test(rep));
  // (f) receipt shape unchanged: the same keys whether or not a settings merge took place
  const Q = r11Fixture('t165f', { 'steady.test.cjs': 'steady' }, { tplOpts: { settings: false } });
  const rq = quiet(() => sync.safeSyncProject(Q.tpl, Q.p, { batchId: 'b165f', nowIso: NOW_R11 })).r;
  t('165f [R11] the receipt has the same shape with or without a settings merge (identical key set)', rq.ok === true && JSON.stringify(Object.keys(r.receipt || {}).sort()) === JSON.stringify(Object.keys(rq.receipt).sort()) && rq.settingsMerge.skipped === 'no-template-settings');
  t('165f [R11] the settings delta keeps its shape (status, hooksAdded, hooksChanged, denyAdded)', (() => { const d = sync.settingsDelta(F.tpl, r.settingsMerge); return d.status === 'merged' && Array.isArray(d.hooksAdded) && d.hooksAdded.length > 0 && Array.isArray(d.hooksChanged) && Array.isArray(d.denyAdded); })());
  // (g) a project WITHOUT a settings.json: the merge creates it before the doctor
  const G = r11Fixture('t165g', { 'settings-assert.test.cjs': 'asserts' });
  const rg = quiet(() => sync.safeSyncProject(G.tpl, G.p, { batchId: 'b165g', nowIso: NOW_R11 })).r;
  t('165g [R11] no settings.json before: created before the doctor (post:missing never seen), install ok', rg.ok === true && (rg.settingsMerge || {}).status === 'created' && JSON.stringify(G.suites['settings-assert.test.cjs'].saw()) === JSON.stringify(['pre:missing', 'post:hook']));
  // (h) the CLI end to end — the path the owner ran on 26H2
  const C = r11Fixture('t165h', { 'settings-assert.test.cjs': 'asserts', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const cli = runCLIWithTemplate(['install', C.p, '--batch-id', 'b165h'], C.tpl);
  t('165h [R11] (CLI) install exits 0, says settings.json merged, tool.cjs synced, the doctor saw the merged file', cli.status === 0 && /settings\.json merged/.test(cli.stdout) && rfx(C.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && C.suites['settings-assert.test.cjs'].saw().slice(-1)[0] === 'post:hook');
  // (i) sync-all takes the same path (safeSyncProject): the representative project is kept
  const canaryDoc = wfx(freshDir('t165i-canary'), 'canary-doctor.cjs', 'if (process.argv.indexOf("--json") !== -1) console.log(JSON.stringify({ ok: true, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 } } }));\n');
  const S = r11Fixture('t165i', { 'settings-assert.test.cjs': 'asserts', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  makeRealProjectMarker(S.p);
  const sa = quiet(() => sync.runSyncAll(S.tpl, path.dirname(S.p), { batchId: 'b165i', nowIso: NOW_R11, canaryDoctorSource: canaryDoc })).r;
  t('165i [R11] sync-all: the project is synced (TOOL-V2) and its doctor run saw the merged settings', sa.ok === true && rfx(S.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && S.suites['settings-assert.test.cjs'].saw().slice(-1)[0] === 'post:hook');
});

r4Section('166', () => {
  console.log('\n166) WP-SYNC-R11: the isolated re-run (WP-SYNC-R9) runs after the merge too — it judges the same final settings.json');
  const F = r11Fixture('t166', { 'flaky-settings.test.cjs': 'flaky-asserts', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const r = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b166', nowIso: NOW_R11 })).r;
  const s0 = ((r.suiteCheck || {}).suites || [])[0] || {};
  t('166a [R11] the flagged suite failed inside the doctor run and PASSED alone because settings.json was already merged: flaky-under-load, kept',
    r.ok === true && s0.suite === 'flaky-settings.test.cjs' && s0.classification === 'flaky-under-load' && !!s0.isolated && s0.isolated.healthy === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
  t('166b [R11] what each run saw: pre-sync baseline unmerged, doctor run merged (failed for its own reason), isolated run merged', JSON.stringify(F.suites['flaky-settings.test.cjs'].saw()) === JSON.stringify(['pre:nohook', 'post:hook', 'post:hook']));
});

r4Section('167', () => {
  console.log('\n167) WP-SYNC-R11: validation fails for ANOTHER reason — the rollback restores settings.json byte-for-byte; ledger, .forge-bak and backup agree');
  const F = r11Fixture('t167', { 'broken.test.cjs': 'broken', 'settings-assert.test.cjs': 'asserts', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const cap = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b167', nowIso: NOW_R11 }));
  const r = cap.r;
  t('167a rolled back as before: ok:false, rolledBack, tool.cjs back on TOOL-V1, no new receipt; the reason names broken.test.cjs', r.ok === false && r.rolledBack === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && !(sync.readReceipt(F.p) || {}).batchId && /broken\.test\.cjs/.test(r.outcome.reason));
  t('167a [R11] the merge DID run before the doctor: the settings-asserting suite saw the merged file, stayed green and is not in the reason', !!r.settingsMerge && r.settingsMerge.status === 'merged' && JSON.stringify(F.suites['settings-assert.test.cjs'].saw()) === JSON.stringify(['pre:nohook', 'post:hook']) && !/settings-assert\.test\.cjs/.test(r.outcome.reason));
  t('167b settings.json is back BYTE-FOR-BYTE (BOM, CRLF, 4-space indent, no final newline)', Buffer.compare(fs.readFileSync(F.sPath), OWNER_SETTINGS_BYTES) === 0);
  t('167b [R11] ...and the result says how: settingsRestore restored byte-for-byte from the batch copy', !!r.settingsRestore && r.settingsRestore.ok === true && /restored byte-for-byte from the batch copy/.test(r.settingsRestore.action));
  const led = r11Ledger(F.p, 'b167') || {};
  const bdir = path.join(F.p, '.claude', 'forge-backups', 'b167');
  const bak = typeof led.forgeBak === 'string' ? path.join(F.p, '.claude', ...led.forgeBak.split('/')) : null;
  const manifest = JSON.parse(rfx(bdir, 'manifest.json') || '{}');
  t('167c [R11] ledger consistent: applied merge, preHash = the owner bytes = the restored file, postHash = what the merge wrote', led.applied === true && led.existed === true && led.preHash === hashBuf(OWNER_SETTINGS_BYTES) && led.preHash === r11Hash(F.sPath) && led.postHash === (r.settingsMerge || {}).writtenSha256 && led.postHash !== led.preHash);
  // WP-SYNC-R12: the merge's .forge-bak no longer survives a FAILED attempt — it was a third copy of the pre-sync bytes
  // (the batch keeps settings-pre/), and every failed retry used to add one more file to .claude/. It is removed by its exact recorded
  // name, and only because it still hashed to the preHash (removeOwnForgeBak refuses anything else), so "removed" proves that hash too.
  t('167c [R11] the batch copy (settings-pre/) hashes to that preHash; the batch manifest names it and the merge\'s .forge-bak', r11Hash(path.join(bdir, 'settings-pre', 'settings.json')) === led.preHash && !!bak && !!manifest.settings && manifest.settings.preHash === led.preHash && manifest.settings.forgeBak === led.forgeBak);
  t('167c [R12] (R11-05) the merge\'s own .forge-bak (it held exactly the pre-sync bytes) is removed by the in-run rollback, by its recorded name; the result says so; no .forge-bak is left in .claude/',
    !!bak && !fs.existsSync(bak) && ('removed ' + led.forgeBak + ' (this batch\'s merge backup; the batch keeps settings-pre/settings.json)') === (r.settingsRestore || {}).forgeBak && !fs.readdirSync(path.join(F.p, '.claude')).some((n) => /^settings\.json\.forge-bak-/.test(n)));
  const again = sync.restoreSettingsLedger(F.p, 'b167', {});
  t('167d [R11] a later `rollback` of the same batch finds settings.json already at its pre-sync state (an honest no-op, never a conflict)', again.ok === true && /unchanged \(already the pre-sync state\)/.test(again.action) && Buffer.compare(fs.readFileSync(F.sPath), OWNER_SETTINGS_BYTES) === 0);
  const rep = r.report && r.report.path ? r7Read(r.report.path) : '';
  t('167e [R11] the change report: ROLLED BACK, the settings.json section shows what the doctor judged, the Rollback section says settings.json was restored', /ROLLED BACK — validation failed/.test(rep) && /## settings\.json[\s\S]*- Status: merged/.test(rep) && /## Rollback[\s\S]*settings\.json: restored byte-for-byte/.test(rep));
  const printed = quiet(() => sync.printSafeSyncResult(F.p, r)).out.join('\n');
  t('167f [R11] the console failure line names the settings.json restore', /FAILED \(forge-doctor, exit 1\) -> rolled back \d+ file\(s\); settings\.json restored byte-for-byte/.test(printed));
  // (g) a settings.json this sync CREATED (none before) is removed again by the rollback
  const G = r11Fixture('t167g', { 'broken.test.cjs': 'broken', 'steady.test.cjs': 'steady' });
  const rg = quiet(() => sync.safeSyncProject(G.tpl, G.p, { batchId: 'b167g', nowIso: NOW_R11 })).r;
  t('167g [R11] created before the doctor, removed by the rollback: no settings.json left, rolledBack, the result says removed', rg.ok === false && rg.rolledBack === true && (rg.settingsMerge || {}).status === 'created' && !fs.existsSync(G.sPath) && /^removed/.test((rg.settingsRestore || {}).action || ''));
  // (h) honesty: a suite that rewrites settings.json during the doctor run. WP-SYNC-R11 kept those bytes in place (a conflict), which
  // left the rolled-back project with old files and a settings.json a TEST wrote. WP-SYNC-R12 (Codex R11-02, "roll back like any other
  // validation failure, restoring the pre-merge bytes"): the in-run rollback puts the pre-sync bytes back FIRST and MOVES the suite's
  // bytes into the batch backup — verified, never lost — and says where. (A later manual `rollback` keeps the stricter conflict rule.)
  const H = r11Fixture('t167h', { 'rewrite.test.cjs': 'rewrite-broken', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const rh = quiet(() => sync.safeSyncProject(H.tpl, H.p, { batchId: 'b167h', nowIso: NOW_R11 })).r;
  const qH = path.join(H.p, '.claude', 'forge-backups', 'b167h', 'rollback-quarantine', 'settings.json');
  const repH = r7Read((rh.report || {}).path || '');
  t('167h [R12] settings.json rewritten by a suite during the doctor run: the pre-sync bytes are back BYTE-FOR-BYTE, rolledBack', rh.ok === false && rh.rolledBack === true && !!rh.settingsRestore && rh.settingsRestore.ok === true && Buffer.compare(fs.readFileSync(H.sPath), OWNER_SETTINGS_BYTES) === 0);
  t('167h [R12] ...the suite\'s bytes are never lost: exactly those bytes sit in the batch backup (rollback-quarantine/settings.json) and the result names that path',
    fs.existsSync(qH) && fs.readFileSync(qH, 'utf8') === '{"rewritten by a suite": true}\n' && rh.settingsRestore.quarantined === qH && /restored byte-for-byte from the batch copy; the bytes it held \([0-9a-f]{12}\) were moved into the batch backup: /.test(rh.settingsRestore.action) && /changed since this sync merged it/.test(rh.settingsRestore.ledgerSaid || ''));
  t('167h [R12] ...the files were restored too (TOOL-V1); the report says ROLLED BACK and names the batch-backup copy; abortNote says rolled back',
    rfx(H.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && /ROLLED BACK — validation failed/.test(repH) && /## Rollback[\s\S]*settings\.json: restored byte-for-byte from the batch copy; the bytes it held \([0-9a-f]{12}\) were moved into the batch backup/.test(repH) && sync.abortNote(rh) === 'rolled back');
  t('167h [R12] ...the console failure line says settings.json was restored and that the suite\'s bytes went into the batch backup',
    /FAILED \(forge-doctor, exit 1\) -> rolled back \d+ file\(s\); settings\.json restored byte-for-byte from the batch copy; the bytes it held/.test(quiet(() => sync.printSafeSyncResult(H.p, rh)).out.join('\n')));
});

r4Section('168', () => {
  console.log('\n168) WP-SYNC-R11: a malformed settings.json — the merge refuses safely, never fails the file sync itself; suites that assert settings fail honestly');
  const MALFORMED = '{ "ownerKey": "keep me", not valid json';
  // (a) suites that do not look at settings.json: the file sync succeeds and is stamped; the overall result is ok:false (as section 75b)
  const A = r11Fixture('t168a', { 'steady.test.cjs': 'steady' }, { settings: MALFORMED });
  const ra = quiet(() => sync.safeSyncProject(A.tpl, A.p, { batchId: 'b168a', nowIso: NOW_R11 })).r;
  t('168a the file sync succeeded (TOOL-V2, receipt stamped, doctor green), the overall ok is false (settings refused, reported)', rfx(A.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && !!ra.receipt && ra.validation.ok === true && ra.ok === false && ra.settingsMerge.status === 'refused');
  t('168a the malformed bytes are untouched and no settings undo record was written (nothing was merged)', fs.readFileSync(A.sPath, 'utf8') === MALFORMED && r11Ledger(A.p, 'b168a') === null);
  // (b) a suite that asserts the template hook: the doctor judges the settings.json the project really keeps — red, rolled back
  const B = r11Fixture('t168b', { 'settings-assert.test.cjs': 'asserts', 'steady.test.cjs': 'steady' }, { settings: MALFORMED });
  const rb = quiet(() => sync.safeSyncProject(B.tpl, B.p, { batchId: 'b168b', nowIso: NOW_R11 })).r;
  t('168b the settings-asserting suite fails honestly (doctor run and alone) and the sync is rolled back (TOOL-V1)', rb.ok === false && rb.rolledBack === true && rfx(B.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && /settings-assert\.test\.cjs/.test(rb.outcome.reason) && JSON.stringify(B.suites['settings-assert.test.cjs'].saw()) === JSON.stringify(['pre:nohook', 'post:nohook', 'post:nohook']));
  t('168b [R11] ...the merge was refused-safe, nothing to undo (settingsRestore: no change recorded), the malformed bytes untouched', (rb.settingsMerge || {}).status === 'refused' && !!rb.settingsRestore && rb.settingsRestore.ok === true && /no settings\.json change recorded/.test(rb.settingsRestore.skipped || '') && fs.readFileSync(B.sPath, 'utf8') === MALFORMED);
});

r4Section('169', () => {
  console.log('\n169) WP-SYNC-R11: an unresolved-drift refusal (install is all-or-nothing) also restores settings.json byte-for-byte');
  const F = r11Fixture('t169', { 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  wfx(F.tpl, 'forge-bin/drifted.cjs', 'DRIFT-TEMPLATE');
  wfx(F.p, '.claude/forge-bin/drifted.cjs', 'EDITED HERE, NO BASELINE');
  const r = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b169', nowIso: NOW_R11, refuseOnUnresolvedDrift: true })).r;
  t('169a refused as before: refusedPartialDrift, tool.cjs back on TOOL-V1, the drifted file kept', r.ok === false && r.refusedPartialDrift === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && rfx(F.p, '.claude/forge-bin/drifted.cjs') === 'EDITED HERE, NO BASELINE');
  t('169b [R11] settings.json (merged before the doctor) is back byte-for-byte and the result says so', (r.settingsMerge || {}).status === 'merged' && Buffer.compare(fs.readFileSync(F.sPath), OWNER_SETTINGS_BYTES) === 0 && !!r.settingsRestore && /restored byte-for-byte/.test(r.settingsRestore.action) && r.rolledBack === true);
});

r4Section('170', () => {
  console.log('\n170) WP-SYNC-R11: the no-op path is unchanged — settings merged with its undo record, no doctor run at all');
  const F = r11Fixture('t170', { 'settings-assert.test.cjs': 'asserts' }, { settings: OWNER_SETTINGS_BYTES });
  wfx(F.p, '.claude/forge-bin/tool.cjs', 'TOOL-V2');
  wfx(F.p, '.claude/FORGE_OWNER_PROFILE.json', '{"owner":"template default"}\n');
  wfx(F.p, '.claude/skills/demo/SKILL.md', '# demo v2\n');
  wfx(F.p, '.claude/skills/demo/learnings.md', '# template learnings\n');
  wfx(F.p, '.claude/' + SHIP_MANIFEST_REL_T, fs.readFileSync(path.join(F.tpl, ...SHIP_MANIFEST_REL_T.split('/'))));
  const r = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b170', nowIso: NOW_R11 })).r;
  t('170a a file no-op: ok, settings.json merged with its ledger, no doctor run (no validation on the result, the suite never ran)', r.noop === true && r.ok === true && r.settingsMerge.status === 'merged' && r.validation === undefined && F.suites['settings-assert.test.cjs'].saw().length === 0 && !!r11Ledger(F.p, 'b170'));
});

r4Section('171', () => {
  console.log('\n171) WP-SYNC-R11: a settings step that THROWS (an unexpected merge-tool result) never escapes the sync — reported, the rollback still runs');
  // the merge tool's preview is real (would-merge, so the ledger path runs); the real call returns a result whose backupPath is
  // not a path — mergeSettingsForBatch throws while finalising its ledger. The tool wrote nothing, so the owner bytes stay.
  const mergeTool = require('./forge-settings-merge.cjs');
  const orig = mergeTool.applySettingsMerge;
  const inject = (fn) => { let r = null, threw = null; mergeTool.applySettingsMerge = (o) => (o && o.dryRun ? orig(o) : { ok: true, status: 'merged', backupPath: 171 }); try { r = quiet(fn).r; } catch (e) { threw = e; } finally { mergeTool.applySettingsMerge = orig; } return { r, threw }; };
  const A = r11Fixture('t171a', { 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const a = inject(() => sync.safeSyncProject(A.tpl, A.p, { batchId: 'b171a', nowIso: NOW_R11 }));
  t('171a [R11] a passing doctor: no uncaught throw — the file sync is stamped (TOOL-V2), the overall ok is false and names the merge error',
    a.threw === null && !!a.r && a.r.ok === false && !!a.r.receipt && rfx(A.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && a.r.settingsMerge.skipped === 'merge-error' && /settings\.json merge failed unexpectedly/.test(a.r.settingsMerge.message));
  t('171a ...settings.json still holds the owner\'s bytes, and the batch\'s pending ledger is an honest no-op for a later rollback', Buffer.compare(fs.readFileSync(A.sPath), OWNER_SETTINGS_BYTES) === 0 && (() => { const s = sync.restoreSettingsLedger(A.p, 'b171a', {}); return s.ok === true && /unchanged/.test(s.action); })());
  const B = r11Fixture('t171b', { 'broken.test.cjs': 'broken', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const b = inject(() => sync.safeSyncProject(B.tpl, B.p, { batchId: 'b171b', nowIso: NOW_R11 }));
  t('171b a failing doctor: no uncaught throw, the files are rolled back (TOOL-V1), settings.json is the owner\'s, rolledBack', b.threw === null && !!b.r && b.r.ok === false && b.r.rolledBack === true && rfx(B.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && Buffer.compare(fs.readFileSync(B.sPath), OWNER_SETTINGS_BYTES) === 0);
});

// =====================================================================================================================
// WP-SYNC-R12: the Codex r8 settings-order findings R11-01..R11-06 (see
// .claude/forge-research/overhaul-2026-10-09/codex-r8-settings-order.md). Sections 172-178; every fixture is os.tmpdir()-only, every
// injection is an in-process (or `node -r` preload) wrapper that is removed again in a finally. Assertions marked fail on the
// pre-fix forge-sync.cjs (proven with a scratch harness: pre-fix module + this test file).
// =====================================================================================================================
const mergeToolR12 = require('./forge-settings-merge.cjs');
/** r12Inject(fn, hooks) — run fn with the merge tool's real applySettingsMerge wrapped (hooks.afterWrite(result, opts) may replace the
 *  result of a REAL, non-dry-run call) and, optionally, fs.existsSync / fs.renameSync wrapped; everything is restored in a finally.
 *  -> {r, out, threw}. */
function r12Inject(fn, hooks) {
  hooks = hooks || {};
  const origApply = mergeToolR12.applySettingsMerge, origExists = fs.existsSync, origRename = fs.renameSync;
  const state = { wrote: false };
  mergeToolR12.applySettingsMerge = function (o) {
    const res = origApply.apply(this, arguments);
    if (o && o.dryRun) return res;
    state.wrote = true;
    return hooks.afterWrite ? hooks.afterWrite(res, o) : res;
  };
  if (hooks.exists) fs.existsSync = function (p) { return hooks.exists(state, String(p), () => origExists.apply(fs, arguments)); };
  if (hooks.rename) fs.renameSync = function (a, b) { return hooks.rename(state, String(a), String(b), () => origRename.apply(fs, arguments)); };
  let res = null, threw = null;
  try { res = quiet(fn); } catch (e) { threw = e; }
  finally { mergeToolR12.applySettingsMerge = origApply; fs.existsSync = origExists; fs.renameSync = origRename; }
  return { r: res ? res.r : null, out: res ? res.out : [], threw };
}
/** r12ThrowInValidation — fs.existsSync throws ONCE for the project's forge-doctor.cjs after the real merge wrote settings.json: that is
 *  the first thing runValidation's doctorProvenance looks at, so the throw happens INSIDE the post-sync validation step. */
const R12_THROW_MSG = 'R12 injected: the validation step threw';
const r12ThrowInValidation = { exists: (state, p, orig) => { if (state.wrote && !state.thrown && /forge-doctor\.cjs$/.test(p)) { state.thrown = true; throw new Error(R12_THROW_MSG); } return orig(); } };
const r12ForgeBaks = (p) => fs.readdirSync(path.join(p, '.claude')).filter((n) => /^settings\.json\.forge-bak-/.test(n));
const r12Quarantine = (p, b) => path.join(p, '.claude', 'forge-backups', b, 'rollback-quarantine', 'settings.json');

r4Section('172', () => {
  console.log('\n172) WP-SYNC-R12 (Codex R11-01): a THROW inside the post-sync validation step — a failed validation, the same rollback, a report; the CLI releases its lock');
  const F = r11Fixture('t172', { 'settings-assert.test.cjs': 'asserts', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const a = r12Inject(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b172', nowIso: NOW_R11 }), r12ThrowInValidation);
  const r = a.r || {};
  t('172a [R12] no uncaught throw: a result comes back, ok:false, outcome.validationThrew, the reason names the throw', a.threw === null && r.ok === false && !!r.outcome && r.outcome.validationThrew === true && r.outcome.reason.indexOf(R12_THROW_MSG) !== -1 && /treated as a FAILED validation/.test(r.outcome.reason));
  t('172a [R12] ...the post-sync doctor never ran (the suite saw only the pre-sync baseline) and no suite was re-run', JSON.stringify(F.suites['settings-assert.test.cjs'].saw()) === JSON.stringify(['pre:nohook']) && r.suiteCheck === null && !!r.validation && r.validation.threw === true);
  t('172b [R12] the same rollback as any failed validation: tool.cjs back on TOOL-V1, settings.json back byte-for-byte, rolledBack', r.rolledBack === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && Buffer.compare(fs.readFileSync(F.sPath), OWNER_SETTINGS_BYTES) === 0 && /^restored byte-for-byte from the batch copy/.test((r.settingsRestore || {}).action || ''));
  t('172b [R12] ...no receipt and no version stamp of this batch survive, and the batch .forge-bak is gone', (sync.readReceipt(F.p) || {}).batchId !== 'b172' && !fs.existsSync(sync.versionFilePath(F.p)) && r12ForgeBaks(F.p).length === 0);
  const rep = r7Read((r.report || {}).path || '');
  t('172c [R12] a change report is written: ROLLED BACK — the validation step threw, with the reason and the settings.json restore', /Outcome: \*\*ROLLED BACK — the validation step threw\*\*/.test(rep) && rep.indexOf(R12_THROW_MSG) !== -1 && /## Rollback[\s\S]*settings\.json: restored byte-for-byte/.test(rep));
  t('172c [R12] the console line says what happened (not a doctor exit code)', /FAILED \(the validation step threw\) -> rolled back \d+ file\(s\); settings\.json restored byte-for-byte/.test(quiet(() => sync.printSafeSyncResult(F.p, r)).out.join('\n')));
  // (d) the CLI end to end: the same throw injected through a `node -r` preload into the real install command
  const C = r11Fixture('t172d', { 'settings-assert.test.cjs': 'asserts', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const preload = wfx(C.aux, 'r12-throw-in-validation.cjs', [
    'var fs = require("fs");',
    'var mt = require(' + JSON.stringify(path.join(__dirname, 'forge-settings-merge.cjs')) + ');',
    'var orig = mt.applySettingsMerge, wrote = false, thrown = false;',
    'mt.applySettingsMerge = function (o) { var r = orig.apply(this, arguments); if (!(o && o.dryRun)) wrote = true; return r; };',
    'var ex = fs.existsSync;',
    'fs.existsSync = function (p) { if (wrote && !thrown && /forge-doctor\\.cjs$/.test(String(p))) { thrown = true; throw new Error(' + JSON.stringify(R12_THROW_MSG) + '); } return ex.apply(fs, arguments); };',
  ].join('\n'));
  const cli = spawnSync(process.execPath, ['-r', preload, CLI, 'install', C.p, '--batch-id', 'b172d'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: C.tpl }) });
  t('172d [R12] (CLI) install exits 1 with a handled failure line — no uncaught exception stack', cli.status === 1 && /FAILED \(the validation step threw\)/.test(cli.stderr) && !/^\s+at .+\(.+:\d+:\d+\)$/m.test(cli.stderr));
  t('172d [R12] (CLI) the project is rolled back (TOOL-V1, settings.json byte-for-byte) and the lock is released', rfx(C.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && Buffer.compare(fs.readFileSync(C.sPath), OWNER_SETTINGS_BYTES) === 0 && !fs.existsSync(path.join(C.p, '.claude', '.forge-sync.lock')));
});

r4Section('173', () => {
  console.log('\n173) WP-SYNC-R12 (Codex R11-02): a suite rewrites settings.json AFTER its own assertions passed — the run is green, but nothing is committed');
  const F = r11Fixture('t173', { 'rewrite-green.test.cjs': 'rewrite-green', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const r = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b173', nowIso: NOW_R11 })).r;
  const led = r11Ledger(F.p, 'b173') || {};
  t('173a [R12] the doctor run itself was GREEN, yet the sync fails: ok:false, outcome.settingsChanged, rolledBack, tool.cjs back on TOOL-V1', !!r.validation && r.validation.ok === true && r.ok === false && !!r.outcome && r.outcome.settingsChanged === true && r.rolledBack === true && rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
  t('173a ...(precondition, already true since WP-SYNC-R11) the suite asserted the MERGED settings.json (post:hook) before it rewrote it', JSON.stringify(F.suites['rewrite-green.test.cjs'].saw()) === JSON.stringify(['pre:nohook', 'post:hook']));
  t('173b [R12] settings.json holds the pre-merge (owner) bytes again; the suite\'s bytes are kept, verified, in the batch backup', Buffer.compare(fs.readFileSync(F.sPath), OWNER_SETTINGS_BYTES) === 0 && rfx(r12Quarantine(F.p, 'b173'), '') === '{"rewritten by a green suite": true}\n' && (r.settingsRestore || {}).quarantined === r12Quarantine(F.p, 'b173'));
  t('173b [R12] ...no receipt and no version stamp of this batch: the green verdict never reached a commit; the .forge-bak is gone', (sync.readReceipt(F.p) || {}).batchId !== 'b173' && !fs.existsSync(sync.versionFilePath(F.p)) && r12ForgeBaks(F.p).length === 0);
  const sd = r.settingsDrift || {};
  t('173c [R12] recorded: the judged settings.json is exactly what the merge wrote (ledger postHash), the bytes found later are the suite\'s', !!sd.judged && sd.judged.hash === led.postHash && !!sd.now && sd.now.hash === hashBuf(Buffer.from('{"rewritten by a green suite": true}\n')) && /settings\.json changed DURING validation/.test(r.outcome.reason));
  const rep = r7Read((r.report || {}).path || '');
  t('173c [R12] the change report: ROLLED BACK — settings.json changed during validation, the settings section says so, the doctor line is OK', /Outcome: \*\*ROLLED BACK — settings\.json changed during validation\*\*/.test(rep) && /## settings\.json[\s\S]*\*\*Changed during validation — not committed:\*\*/.test(rep) && /- After: forge-doctor OK/.test(rep));
  t('173c [R12] the console line names the cause and the doctor verdict', /FAILED \(settings\.json changed during validation; forge-doctor, exit 0\) -> rolled back \d+ file\(s\); settings\.json restored byte-for-byte/.test(quiet(() => sync.printSafeSyncResult(F.p, r)).out.join('\n')));
  // (d) an ACCEPTED-red run: the suite fails inside the doctor run after rewriting settings.json and passes alone (flaky-under-load)
  const D = r11Fixture('t173d', { 'flaky-rewrite.test.cjs': 'flaky-rewrite', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const rd = quiet(() => sync.safeSyncProject(D.tpl, D.p, { batchId: 'b173d', nowIso: NOW_R11 })).r;
  const acc = (rd.outcome || {}).acceptedOutcome || {};
  t('173d [R12] accepted-red (flaky under load) + settings.json rewritten during the doctor run: NOT kept — ok:false, settingsChanged, the accepted verdict recorded', rd.ok === false && !!rd.outcome && rd.outcome.settingsChanged === true && Array.isArray(acc.flakyUnderLoad) && acc.flakyUnderLoad.indexOf('flaky-rewrite.test.cjs') !== -1 && /had been accepted: 1 suite\(s\) flaky under load/.test(rd.outcome.reason));
  t('173d [R12] ...rolled back like any validation failure: TOOL-V1, the owner\'s settings.json, the suite\'s bytes in the batch backup, no receipt', rd.rolledBack === true && rfx(D.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && Buffer.compare(fs.readFileSync(D.sPath), OWNER_SETTINGS_BYTES) === 0 && rfx(r12Quarantine(D.p, 'b173d'), '') === '{"rewritten by a flaky suite": true}\n' && (sync.readReceipt(D.p) || {}).batchId !== 'b173d');
  // (e) unit: settingsDriftCheck
  const U = r11Fixture('t173e', { 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const snap = sync.settingsSnapshot(U.p, false);
  t('173e settingsDriftCheck: unchanged -> null; changed -> a reason; judged != the merge\'s postHash -> a reason', sync.settingsDriftCheck(U.p, snap, null) === null
    && /changed DURING validation/.test(((fs.writeFileSync(U.sPath, '{}\n'), sync.settingsDriftCheck(U.p, snap, null)) || {}).reason || '')
    && /did not hold what this sync merged/.test((sync.settingsDriftCheck(U.p, sync.settingsSnapshot(U.p, false), { ledger: { postHash: 'f'.repeat(64) } }) || {}).reason || ''));
});

r4Section('174', () => {
  console.log('\n174) WP-SYNC-R12 (Codex R11-02): the receipt records the settings.json its doctor judged; --reuse-pre-baseline is refused once it differs');
  const F = r11Fixture('t174', { 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const FP = { gitHead: 'h174', gitStatusHash: 's174' };
  const run = (b, v) => { wfx(F.tpl, 'forge-bin/tool.cjs', v); return quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: b, nowIso: NOW_R11, reusePreBaseline: true, workspaceFingerprintImpl: () => FP })).r; };
  const r1 = run('b174-1', 'TOOL-V2');
  const rc1 = sync.readReceipt(F.p) || {};
  t('174a [R12] a committed receipt records the judged settings.json (= the merged file on disk)', r1.ok === true && !!rc1.settingsJudged && rc1.settingsJudged.kind === 'ok' && rc1.settingsJudged.sha256 === r11Hash(F.sPath) && rc1.settingsJudged.sha256 === (r1.settingsMerge || {}).writtenSha256);
  const r2 = run('b174-2', 'TOOL-V3');
  t('174b control: settings.json unchanged since -> the baseline IS reused (the bar is not over-eager)', r2.ok === true && r2.baselineSource.mode === 'reused' && r2.baselineSource.batchId === 'b174-1');
  fs.writeFileSync(F.sPath, fs.readFileSync(F.sPath, 'utf8').replace('"ownerKey": "keep me"', '"ownerKey": "edited after the sync"'));
  const r3 = run('b174-3', 'TOOL-V4');
  t('174c [R12] settings.json changed after the receipt (git fingerprint identical) -> baseline RUN, the reason names settings.json', r3.ok === true && r3.baselineSource.mode === 'run' && /settings\.json is not the one the last receipt's doctor judged/.test(r3.baselineSource.fallbackReason || ''));
  const H = 'mh174', now = Date.parse(NOW_R11);
  const green = { ok: true, node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 }, checksOk: { node_check: { ok: true }, tests: { ok: true } } };
  const rc = { batchId: 'bx', syncedAt: NOW_R11, postSyncManifestHash: H, validation: { tool: 'forge-doctor', ok: true, summary: green }, workspace: FP, settingsJudged: { kind: 'ok', sha256: 'a'.repeat(64) } };
  const legacy = Object.assign({}, rc); delete legacy.settingsJudged;
  t('174d [R12] decidePreBaseline: same settings -> reuse; different / unreadable / not supplied -> run; a receipt without the record -> as before',
    sync.decidePreBaseline(rc, H, FP, now, { kind: 'ok', hash: 'a'.repeat(64) }).reuse === true
    && sync.decidePreBaseline(rc, H, FP, now, { kind: 'ok', hash: 'b'.repeat(64) }).reuse === false
    && sync.decidePreBaseline(rc, H, FP, now, { kind: 'unreadable', error: 'x' }).reuse === false
    && sync.decidePreBaseline(rc, H, FP, now).reuse === false
    && sync.decidePreBaseline(legacy, H, FP, now).reuse === true);
});

r4Section('175', () => {
  console.log('\n175) WP-SYNC-R12 (Codex R11-02 aggravation + R11-06): the protect-violation rollback after the early merge');
  // (a) R11-06: the plain case — a green suite writes into the protected forge-runs/ -> the whole batch rolls back, settings.json too
  const A = r11Fixture('t175a', { 'plant.test.cjs': 'plant-runs', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const ra = quiet(() => sync.safeSyncProject(A.tpl, A.p, { batchId: 'b175a', nowIso: NOW_R11 })).r;
  t('175a protect violation after the early merge: rolled back through rollbackProject — files, receipt, version AND settings.json byte-for-byte', ra.ok === false && ra.protectViolation === true && ra.rolledBack === true && rfx(A.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && (sync.readReceipt(A.p) || {}).batchId !== 'b175a' && Buffer.compare(fs.readFileSync(A.sPath), OWNER_SETTINGS_BYTES) === 0 && /restored byte-for-byte/.test(((ra.rollback || {}).settingsRestore || {}).action || ''));
  t('175a [R12] (R11-05) ...and this batch\'s .forge-bak is removed there too', r12ForgeBaks(A.p).length === 0 && /^removed settings\.json\.forge-bak-/.test((ra.rollback || {}).forgeBak || ''));
  // (b) the aggravation: settings.json the rollback cannot prove to be this sync's (a merge tool that reports no writtenSha256 -> the
  // ledger's postHash stays null) used to make rollbackProject's up-front settings check refuse the WHOLE rollback
  const B = r11Fixture('t175b', { 'plant.test.cjs': 'plant-runs', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const b = r12Inject(() => sync.safeSyncProject(B.tpl, B.p, { batchId: 'b175b', nowIso: NOW_R11 }), { afterWrite: (res) => { const c = Object.assign({}, res); delete c.writtenSha256; return c; } });
  const rb = (b.r || {}).rollback || {};
  t('175b [R12] protect violation + an unconfirmed settings merge: the files, receipt and version ARE rolled back (not refused wholesale)', b.threw === null && !!b.r && b.r.protectViolation === true && rfx(B.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && (sync.readReceipt(B.p) || {}).batchId !== 'b175b' && !fs.existsSync(sync.versionFilePath(B.p)) && Array.isArray(rb.restored) && rb.restored.length > 0);
  t('175b [R12] ...the settings.json conflict is reported separately: kept (never overwritten), rollback ok:false, the reason names settings.json', rb.ok === false && b.r.rolledBack === false && !!rb.settingsRestore && rb.settingsRestore.conflict === true && /the main rollback succeeded, but settings\.json was not restored: settings\.json changed since this sync started merging it \(the merge was never confirmed\)/.test(rb.reason || '') && /forge-gate-hook\.cjs/.test(fs.readFileSync(B.sPath, 'utf8')));
  t('175b [R12] ...abortNote says the rollback is not confirmed and why', /^ROLLBACK NOT CONFIRMED \(the main rollback succeeded, but settings\.json was not restored/.test(sync.abortNote(b.r)));
  // (c) the manual `rollback` keeps its stricter rule: the same kind of batch, rolled back by hand, still refuses a half rollback
  const mr = sync.rollbackProject(B.p, 'b175b', {});
  t('175c a manual rollback of a batch whose settings.json conflicts still refuses wholesale (unchanged R3 / SYNC-06 rule)', mr.ok === false && Array.isArray(mr.restored) && mr.restored.length === 0 && /nothing was restored, so the project is not left half rolled back/.test(mr.reason || ''));
});

r4Section('176', () => {
  console.log('\n176) WP-SYNC-R12 (Codex R11-03): abortNote says "files rolled back" only when the file restore confirmed it');
  const div = { ok: false, refusedDivergence: true, diverged: [{ rel: 'forge-bin/tool.cjs' }], restored: [] };
  const sErr = { ok: false, action: 'none', error: 'X' };
  t('176a [R12] a refused (diverged) file restore + a settings failure: both named, never "files rolled back"', /^ROLLBACK NOT CONFIRMED — the files: the file restore was REFUSED: 1 file\(s\) changed since this sync wrote them \(forge-bin\/tool\.cjs\).*; and settings\.json was not restored: X$/.test(sync.abortNote({ ok: false, rollbackError: null, restored: div, settingsRestore: sErr })));
  t('176a [R12] a partial file restore + a settings failure: both named', /^ROLLBACK NOT CONFIRMED — the files: partial restore: 2 file\(s\) failed.*; and settings\.json was not restored: X$/.test(sync.abortNote({ ok: false, restored: { ok: false, partial: true, failed: [{ rel: 'a' }, { rel: 'b' }], restored: [] }, settingsRestore: sErr })));
  t('176a [R12] a diverged file restore alone (settings fine) is named too — no more "rollback status unknown"', /^ROLLBACK NOT CONFIRMED \(the file restore was REFUSED: 1 file\(s\)/.test(sync.abortNote({ ok: false, restored: div, settingsRestore: { ok: true, action: 'unchanged' } })));
  t('176a files confirmed back + a settings failure: still "files rolled back, but ..." (the true case)', sync.abortNote({ ok: false, restored: { ok: true, restored: ['x'] }, settingsRestore: sErr }) === 'files rolled back, but settings.json was not restored: X');
  // (b) the real thing: a suite diverges a synced file AND turns settings.json into a folder (--no-isolated-rerun: one doctor run)
  const B = r11Fixture('t176b', { 'diverge.test.cjs': 'diverge-dir', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const rb = quiet(() => sync.safeSyncProject(B.tpl, B.p, { batchId: 'b176b', nowIso: NOW_R11, noIsolatedRerun: true })).r;
  const note = sync.abortNote(rb);
  t('176b [R12] diverged files + an unrestorable settings.json: rolledBack:false and abortNote names BOTH (no "files rolled back")', rb.ok === false && rb.rolledBack === false && !!rb.restored && rb.restored.refusedDivergence === true && !!rb.settingsRestore && rb.settingsRestore.ok === false
    && !/files rolled back/.test(note) && /^ROLLBACK NOT CONFIRMED — the files: the file restore was REFUSED: 1 file\(s\) changed since this sync wrote them \(forge-bin\/tool\.cjs\)/.test(note) && /; and settings\.json was not restored: settings\.json is not a readable regular file now/.test(note));
  const repB = r7Read((rb.report || {}).path || '');
  t('176b [R12] the report: VALIDATION FAILED — rollback not confirmed, the Rollback line names both reasons', /VALIDATION FAILED — rollback not confirmed/.test(repB) && /## Rollback[\s\S]*Rollback NOT complete — the file restore was REFUSED: 1 file\(s\)[\s\S]*; and settings\.json was not restored/.test(repB) && /settings\.json: NOT restored — settings\.json is not a readable regular file now/.test(repB));
  t('176b nothing was lost: the diverged file and the folder are kept as they are (never overwritten)', rfx(B.p, '.claude/forge-bin/tool.cjs') === 'TOOL-SUITE' && fs.statSync(B.sPath).isDirectory());
  // (c) files confirmed back, settings.json not: the one case that may say "files rolled back, but ..." — and the Rollback line names WHY
  const C = r11Fixture('t176c', { 'dir.test.cjs': 'dir-settings', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const rc = quiet(() => sync.safeSyncProject(C.tpl, C.p, { batchId: 'b176c', nowIso: NOW_R11, noIsolatedRerun: true })).r;
  t('176c files back (TOOL-V1), settings.json kept as a folder: abortNote "files rolled back, but settings.json was not restored: ..."', rc.ok === false && rc.rolledBack === false && rfx(C.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && /^files rolled back, but settings\.json was not restored: /.test(sync.abortNote(rc)));
  t('176c ...the report\'s Rollback line names WHY (not a bare "none") and so does the console line', /## Rollback[\s\S]*settings\.json: NOT restored — /.test(r7Read((rc.report || {}).path || '')) && /rolled back \d+ file\(s\); settings\.json was not restored: /.test(quiet(() => sync.printSafeSyncResult(C.p, rc)).out.join('\n')));
});

r4Section('177', () => {
  console.log('\n177) WP-SYNC-R12 (Codex R11-04): the merge tool WROTE settings.json and the merge step then failed — settled at once, never left pending');
  // (a) the tool really writes, then mergeSettingsForBatch throws while finalising (an unexpected result shape) -> the ledger is pending
  const A = r11Fixture('t177a', { 'observe.test.cjs': 'observe', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const a = r12Inject(() => sync.safeSyncProject(A.tpl, A.p, { batchId: 'b177a', nowIso: NOW_R11 }), { afterWrite: (res) => Object.assign({}, res, { backupPath: 177 }) });
  const ra = a.r || {};
  const ledA = r11Ledger(A.p, 'b177a') || {};
  t('177a [R12] the doctor judged the PRE-SYNC settings.json: the merged bytes were put back before it ran (post:nohook)', a.threw === null && JSON.stringify(A.suites['observe.test.cjs'].saw()) === JSON.stringify(['pre:nohook', 'post:nohook']) && Buffer.compare(fs.readFileSync(A.sPath), OWNER_SETTINGS_BYTES) === 0);
  t('177a [R12] ...what the tool wrote is kept in the batch backup (verified), and the merge is reported refused (merge-error), the file sync stamped', /forge-gate-hook\.cjs/.test(rfx(r12Quarantine(A.p, 'b177a'), '') || '') && ra.ok === false && (ra.settingsMerge || {}).skipped === 'merge-error' && /settings\.json merge failed unexpectedly/.test((ra.settingsMerge || {}).message || '') && /restored byte-for-byte from the batch copy/.test((ra.settingsMerge || {}).message || '') && rfx(A.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V2' && (sync.readReceipt(A.p) || {}).batchId === 'b177a');
  t('177a [R12] ...the ledger is no longer pending: marked reverted, applied:false, postHash null', ledA.status === 'reverted' && ledA.applied === false && ledA.postHash === null && /unchanged by this batch/.test(ledA.mergeStatus || ''));
  const laterA = sync.rollbackProject(A.p, 'b177a', {});
  t('177a [R12] a LATER rollback of that batch is not refused over settings.json: ok, TOOL-V1, settings.json untouched (not this batch\'s)', laterA.ok === true && rfx(A.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && Buffer.compare(fs.readFileSync(A.sPath), OWNER_SETTINGS_BYTES) === 0 && /^none \(the merge was not applied by this sync: reverted after an unconfirmed merge/.test(laterA.settingsAction || ''));
  // (b) the tool writes, then the ledger cannot be finalised (one injected rename failure on settings-ledger.json) -> ledgerWarning
  const B = r11Fixture('t177b', { 'observe.test.cjs': 'observe', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const ledgerPathB = path.join(B.p, '.claude', 'forge-backups', 'b177b', sync.SETTINGS_LEDGER_NAME);
  const b = r12Inject(() => sync.safeSyncProject(B.tpl, B.p, { batchId: 'b177b', nowIso: NOW_R11 }), {
    rename: (state, from, to, orig) => { if (state.wrote && !state.renameFailed && path.resolve(to) === path.resolve(ledgerPathB)) { state.renameFailed = true; const e = new Error('EPERM: injected — the settings ledger could not be finalised'); e.code = 'EPERM'; throw e; } return orig(); },
  });
  const rbB = b.r || {};
  const ledB = r11Ledger(B.p, 'b177b') || {};
  t('177b [R12] an unconfirmed ledger (ledgerWarning) is settled too: pre-sync bytes back before the doctor, the merge reported refused (ledger-unconfirmed)', b.threw === null && JSON.stringify(B.suites['observe.test.cjs'].saw()) === JSON.stringify(['pre:nohook', 'post:nohook']) && Buffer.compare(fs.readFileSync(B.sPath), OWNER_SETTINGS_BYTES) === 0 && rbB.ok === false && (rbB.settingsMerge || {}).skipped === 'ledger-unconfirmed');
  t('177b [R12] ...the ledger is marked reverted and the merge\'s .forge-bak (named only in memory) is removed', ledB.status === 'reverted' && ledB.applied === false && r12ForgeBaks(B.p).length === 0 && /^removed settings\.json\.forge-bak-/.test(((ledB.revert || {}).forgeBak) || ''));
  t('177b [R12] ...and a later rollback of the batch is not refused', sync.rollbackProject(B.p, 'b177b', {}).ok === true && rfx(B.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1');
});

r4Section('178', () => {
  console.log('\n178) WP-SYNC-R12 (Codex R11-05): an in-run rollback restores settings.json FIRST; failed retries leave no .forge-bak behind');
  const F = r11Fixture('t178', { 'broken.test.cjs': 'broken', 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const order = [];
  const a = r12Inject(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b178-1', nowIso: NOW_R11 }), { rename: (state, from, to, orig) => { order.push(path.basename(to)); return orig(); } });
  const lastS = order.lastIndexOf('settings.json'), lastT = order.lastIndexOf('tool.cjs');
  t('178a [R12] the rollback put settings.json back BEFORE the files (its last write precedes tool.cjs\'s restore)', a.threw === null && !!a.r && a.r.rolledBack === true && lastS !== -1 && lastT !== -1 && lastS < lastT);
  t('178a ...and both really are back (TOOL-V1, the owner\'s bytes)', rfx(F.p, '.claude/forge-bin/tool.cjs') === 'TOOL-V1' && Buffer.compare(fs.readFileSync(F.sPath), OWNER_SETTINGS_BYTES) === 0);
  const r2 = quiet(() => sync.safeSyncProject(F.tpl, F.p, { batchId: 'b178-2', nowIso: NOW_R11 })).r;
  t('178b [R12] two failed attempts: no settings.json.forge-bak-* accumulates in .claude/ (each batch keeps its own settings-pre/ copy)', r2.rolledBack === true && r12ForgeBaks(F.p).length === 0
    && ['b178-1', 'b178-2'].every((bt) => r11Hash(path.join(F.p, '.claude', 'forge-backups', bt, 'settings-pre', 'settings.json')) === hashBuf(OWNER_SETTINGS_BYTES)));
  // (c) the guard: a .forge-bak that no longer holds the pre-sync bytes, or that is not this batch's, is never removed
  const G = r11Fixture('t178c', { 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const foreign = wfx(G.p, '.claude/settings.json.forge-bak-19990101-000000-owner', 'an older backup the owner keeps\n');
  const rg = quiet(() => sync.safeSyncProject(G.tpl, G.p, { batchId: 'b178c', nowIso: NOW_R11 })).r;
  t('178c a successful sync keeps its own .forge-bak (only FAILED attempts clean up) and never touches an older one', rg.ok === true && r12ForgeBaks(G.p).length === 2 && fs.readFileSync(foreign, 'utf8') === 'an older backup the owner keeps\n');
  const ledG = r11Ledger(G.p, 'b178c') || {};
  fs.writeFileSync(path.join(G.p, '.claude', ledG.forgeBak), 'edited since\n');
  t('178c removeOwnForgeBak keeps a .forge-bak whose bytes changed since the merge took it', /^kept settings\.json\.forge-bak-.* \(it does not hold exactly the pre-sync bytes\)$/.test(sync.removeOwnForgeBak(G.p, 'b178c', { kind: 'ok', hash: ledG.preHash }) || '') && fs.existsSync(path.join(G.p, '.claude', ledG.forgeBak)));
});

r4Section('179', () => {
  console.log('\n179) WP-SYNC-R12: the in-run rollback target on a --resume-batch is the LEDGER\'s pre-sync state, not the snapshot of a settings.json an earlier attempt merged');
  const F = r11Fixture('t179', { 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  const m = sync.mergeSettingsForBatch(F.tpl, F.p, 'b179', { nowIso: NOW_R11 }); // "attempt 1" merged, then (say) crashed
  const mergedSnap = sync.settingsSnapshot(F.p, true); // what a resumed attempt reads at its start
  const target = sync.settingsRollbackTarget(F.p, 'b179', mergedSnap);
  t('179a the earlier attempt really merged (ledger applied) and a fresh snapshot now holds the merged bytes', m.status === 'merged' && !!m.ledger && mergedSnap.kind === 'ok' && mergedSnap.hash === m.ledger.postHash);
  t('179a settingsRollbackTarget: the ledger\'s pre-sync bytes (verified batch copy), not the merged snapshot', target.kind === 'ok' && target.hash === hashBuf(OWNER_SETTINGS_BYTES) && target.fromLedger === true && Buffer.compare(target.buf, OWNER_SETTINGS_BYTES) === 0);
  const sr = sync.restoreSettingsInRun(F.p, 'b179', target);
  t('179b restoreSettingsInRun with that target: settings.json back to the owner\'s bytes through the ledger, its .forge-bak removed', sr.ok === true && /^restored byte-for-byte from the batch copy/.test(sr.action) && Buffer.compare(fs.readFileSync(F.sPath), OWNER_SETTINGS_BYTES) === 0 && r12ForgeBaks(F.p).length === 0);
  // the same call with the naive target (the snapshot taken at the start of the resumed attempt) would have put the MERGED bytes back
  const G = r11Fixture('t179c', { 'steady.test.cjs': 'steady' }, { settings: OWNER_SETTINGS_BYTES });
  sync.mergeSettingsForBatch(G.tpl, G.p, 'b179c', { nowIso: NOW_R11 });
  const naive = sync.settingsSnapshot(G.p, true);
  sync.restoreSettingsInRun(G.p, 'b179c', naive);
  t('179c why: with the naive snapshot as target the merged bytes would win (this is what settingsRollbackTarget prevents)', /forge-gate-hook\.cjs/.test(fs.readFileSync(G.sPath, 'utf8')));
  t('179d a target for a batch with no ledger, or a ledger that does not own settings.json, is the snapshot itself', sync.settingsRollbackTarget(G.p, 'b179-none', naive) === naive);
});

// =====================================================================================
// 180) WP-SYNC-R13 (the third real 26H2 install): 567 folders under .claude/worktrees/<wp>/src/.../scratch/<guid>/ that .NET
//      tests left with a locked ACL (Node: EPERM on scandir) were unreadable BEFORE and AFTER the sync, and the install rolled back over
//      567 "CHANGED" entries nothing had changed. Evidence source, probed first and printed: REAL (an icacls deny of List-folder on a
//      scratch fixture — always removed again in `finally`, before the exit handler deletes the fixtures) or INJECTED (fs.readdirSync
//      throws EPERM/scandir for exactly that folder; the CLI child gets the same through a `node -r` preload). Assertions marked
//      fail on the pre-R13 code; the unmarked ones are regression guards that held before too (the old code flagged everything).
// =====================================================================================
r4Section('180', () => {
  console.log('\n180) WP-SYNC-R13: a path unreadable BEFORE and AFTER (same code, same operation, same time) is "not comparable" — counted, never a violation; one-sided, another code or a moved time is a change');
  const foldPath = (q) => { const r = path.resolve(String(q)); return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r; };
  const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + (process.env.USERNAME || '');
  const aclLocked = new Set();
  const aclLock = (d) => { const r = spawnSync('icacls', [d, '/deny', user + ':(RD)'], { encoding: 'utf8' }); if (r.status === 0) aclLocked.add(d); return r.status === 0; };
  const aclUnlock = (d) => { spawnSync('icacls', [d, '/remove:d', user], { encoding: 'utf8' }); aclLocked.delete(d); };
  let REAL = false;
  if (process.platform === 'win32' && process.env.USERNAME) {
    const pd = path.join(freshDir('t180-probe'), 'locked');
    fs.mkdirSync(pd);
    if (aclLock(pd)) { try { fs.readdirSync(pd); } catch (e) { REAL = e.code === 'EPERM' && e.syscall === 'scandir'; } aclUnlock(pd); }
  }
  const injected = new Map(); // folded folder path -> error code (the INJECTED source; in both modes the "another code" case)
  const origReaddir = fs.readdirSync;
  const origRead = fs.readFileSync;
  const lock = (d) => { if (REAL) { if (!aclLock(d)) throw new Error('icacls deny failed on ' + d); } else injected.set(foldPath(d), 'EPERM'); };
  const unlock = (d) => { if (REAL) aclUnlock(d); else injected.delete(foldPath(d)); };
  const nc = (v) => (v && v.notComparable) || [];
  const un = (v) => (v && v.unreadable) || {};
  const ncLine = (v) => (typeof sync.protectNotComparableLine === 'function' ? sync.protectNotComparableLine(v) : null) || '';
  fs.readdirSync = function (q, ...rest) {
    const code = injected.get(foldPath(q));
    if (code) { const e = new Error(code + ': operation not permitted (injected), scandir \'' + String(q) + '\''); e.code = code; e.syscall = 'scandir'; e.path = String(q); throw e; }
    return origReaddir.call(fs, q, ...rest);
  };
  try {
    const { tpl } = tplHomeWp2c('t180-tpl', { settings: false });
    // ---- (a) unreadable on both sides: the real 26H2 shape --------------------------------------------------------------------
    const p = projWp2c('t180a');
    const REL = '.claude/worktrees/wp-d6c/src/Faitz.Tests/bin/Release/net10.0-windows/scratch/0fc0ebc8a7ce/pd/Faitz';
    const L = path.join(p, ...REL.split('/'));
    wfx(p, REL + '/inside.txt', 'scratch left behind by a .NET test');
    const OLD = new Date('2026-10-09T04:01:44.000Z');
    fs.utimesSync(L, OLD, OLD); // a known time, so the "time moved" case below never depends on the clock tick
    lock(L);
    const m0 = sync.buildProtectManifest(tpl, p, { nowIso: NOW_WP2C });
    const e0 = m0.entries[REL] || {};
    t('180a (setup) the locked folder is ONE unreadable entry; nothing inside it is listed; counts.unreadable is 1', e0.kind === 'unreadable' && !m0.entries[REL + '/inside.txt'] && m0.counts.unreadable === 1);
    t('180a [R13] the entry records the error code, the operation and the lstat modified time (not just the message)', e0.code === 'EPERM' && e0.syscall === 'scandir' && Math.round(e0.mtimeMs) === OLD.getTime());
    const v0 = sync.verifyProtect(p, m0, null);
    t('180a [R13] unreadable on BOTH sides, same code + operation + time: verifyProtect is OK (pre-R13: VIOLATION, "CHANGED")', v0.ok === true && v0.changed.length === 0);
    t('180a [R13] ...it is listed as not comparable, with its code and a compared time', nc(v0).length === 1 && nc(v0)[0].key === REL && nc(v0)[0].code === 'EPERM' && nc(v0)[0].syscall === 'scandir' && nc(v0)[0].mtimeCompared === true);
    t('180a [R13] ...and counted: 1 unreadable before, 1 now, 1 not comparable (EPERM 1)', un(v0).before === 1 && un(v0).after === 1 && un(v0).notComparable === 1 && un(v0).mtimeCompared === 1 && (un(v0).byCode || {}).EPERM === 1);
    // (a2) a manifest written BEFORE R13 — the real 26H2 manifest: only the message, holding ANOTHER absolute path (never compared)
    const mOld = JSON.parse(JSON.stringify(m0));
    mOld.entries[REL] = { kind: 'unreadable', error: 'EPERM: operation not permitted, scandir \'C:\\elsewhere\\entirely\\pd\\Faitz\'' };
    const vOld = sync.verifyProtect(p, mOld, null);
    t('180a2 [R13] a pre-R13 "before" entry (message only, another path in it): code + operation read from the message — OK, time not compared, and said so', vOld.ok === true && nc(vOld).length === 1 && nc(vOld)[0].mtimeCompared === false && /without a recorded time/.test(ncLine(vOld)));
    // ---- (e) a normal file change still violates, right next to it ---------------------------------------------------------
    const memF = path.join(p, '.claude', 'agent-memory', 'head-chef', 'MEMORY.md');
    const memBytes = fs.readFileSync(memF);
    fs.appendFileSync(memF, 'a planted line\n');
    const vE = sync.verifyProtect(p, m0, null);
    t('180e a memory file edited next to the locked folder is a violation (CHANGED .../MEMORY.md)', vE.ok === false && sync.protectViolationLines(vE).includes('CHANGED .claude/agent-memory/head-chef/MEMORY.md'));
    t('180e [R13] ...and that edit is the ONLY violation: the locked folder stays "not comparable"', sync.protectViolationLines(vE).length === 1 && nc(vE).length === 1);
    fs.writeFileSync(memF, memBytes);
    t('180e [R13] (MEMORY.md restored byte-for-byte) the project verifies OK again', sync.verifyProtect(p, m0, null).ok === true);
    // ---- (c) unreadable both times, but with ANOTHER error code ------------------------------------------------------------
    const kL = foldPath(L);
    const prevCode = injected.get(kL);
    injected.set(kL, 'EACCES');
    let vC;
    try { vC = sync.verifyProtect(p, m0, null); } finally { if (prevCode) injected.set(kL, prevCode); else injected.delete(kL); }
    t('180c unreadable both times with ANOTHER error code (EPERM -> EACCES) is a violation (CHANGED the folder)', vC.ok === false && sync.protectViolationLines(vC).includes('CHANGED ' + REL));
    t('180c [R13] ...and the change names the reason', vC.changed.some((c) => c.key === REL && /the error changed \(EPERM -> EACCES\)/.test(c.why || '')));
    // ---- (d) a locked folder whose modified time moved ---------------------------------------------------------------------
    fs.writeFileSync(path.join(L, 'new-entry.txt'), 'created inside the locked folder'); // List is denied, create is not
    const vD = sync.verifyProtect(p, m0, null);
    t('180d an entry created inside the locked folder (its modified time moved) is a violation (CHANGED the folder)', vD.ok === false && sync.protectViolationLines(vD).includes('CHANGED ' + REL));
    t('180d [R13] ...the reason says the modified time changed, and it is not counted as "not comparable"', vD.changed.some((c) => c.key === REL && /modified time changed/.test(c.why || '')) && nc(vD).length === 0 && Array.isArray(vD.notComparable));
    unlock(L);
    // ---- (b) became unreadable / (b2) became readable ----------------------------------------------------------------------
    const pB = projWp2c('t180b');
    const RB = '.claude/worktrees/wp-ux1/scratch/9f2e/image';
    const LB = path.join(pB, ...RB.split('/'));
    wfx(pB, RB + '/frame.png', 'png bytes');
    const mB = sync.buildProtectManifest(tpl, pB, { nowIso: NOW_WP2C }); // readable now
    lock(LB);
    const vB = sync.verifyProtect(pB, mB, null);
    t('180b a folder that BECAME unreadable is a violation (CHANGED the folder; its file no longer seen: REMOVED)', vB.ok === false && sync.protectViolationLines(vB).includes('CHANGED ' + RB) && sync.protectViolationLines(vB).includes('REMOVED ' + RB + '/frame.png'));
    const mB2 = sync.buildProtectManifest(tpl, pB, { nowIso: NOW_WP2C }); // unreadable now
    unlock(LB);
    const vB2 = sync.verifyProtect(pB, mB2, null);
    t('180b2 a folder that BECAME readable again is a violation too (CHANGED the folder, ADDED what it holds)', vB2.ok === false && sync.protectViolationLines(vB2).includes('CHANGED ' + RB) && sync.protectViolationLines(vB2).includes('ADDED   ' + RB + '/frame.png'));
    // ---- (g) the worktree summary is unchanged: an agent CHECKOUT whose .git cannot be read stays fail closed ------------------
    const pG = projWp2c('t180g');
    const gitP = wfx(pG, '.claude/worktrees/agent-1/.git', 'gitdir: elsewhere/agent-1\n');
    fs.readFileSync = function (q, ...rest) {
      if (foldPath(q) === foldPath(gitP)) { const e = new Error('EPERM: operation not permitted (injected), open \'' + String(q) + '\''); e.code = 'EPERM'; e.syscall = 'open'; throw e; }
      return origRead.call(fs, q, ...rest);
    };
    let mG = null, vG = null;
    try { mG = sync.buildProtectManifest(tpl, pG, { nowIso: NOW_WP2C }); vG = sync.verifyProtect(pG, mG, null); } finally { fs.readFileSync = origRead; }
    t('180g (setup) the checkout whose .git cannot be read is one unreadable entry, nothing inside it', !!mG && (mG.entries['.claude/worktrees/agent-1'] || {}).kind === 'unreadable' && !Object.keys(mG.entries).some((k) => k.startsWith('.claude/worktrees/agent-1/')));
    t('180g an unreadable CHECKOUT entry, unreadable both times with the same code, is STILL a violation (fail closed, as before R13)', !!vG && vG.ok === false && sync.protectViolationLines(vG).includes('CHANGED .claude/worktrees/agent-1') && nc(vG).length === 0);
    // ---- (h) the rule at unit level -------------------------------------------------------------------------------------
    const base = (entries) => ({ schema: sync.PROTECT_SCHEMA, projectPath: 'x', shippedRels: [], entries });
    // WP-SYNC-R13B: "not comparable" exists only strictly inside .claude/worktrees/<name>/ — the unit key lives there
    // (the R13 key '.claude/k' is outside it and is a violation now; section 181c asserts that)
    const HK = '.claude/worktrees/wp-k/scratch/k';
    const dDiff = (b, a) => sync.diffProtectManifests(base({ [HK]: b }), { entries: { [HK]: a } }, null);
    const U = { kind: 'unreadable', error: 'EPERM: operation not permitted, scandir \'x\'', code: 'EPERM', syscall: 'scandir', mtimeMs: 1000 };
    t('180h [R13] same code + operation + time: not comparable', dDiff(U, Object.assign({}, U, { error: 'EPERM: operation not permitted, scandir \'y\'' })).ok === true);
    t('180h the same code but ANOTHER operation (scandir -> open) is a change', dDiff(U, Object.assign({}, U, { syscall: 'open' })).ok === false);
    t('180h [R13] ...with the reason "the failing operation changed"', /failing operation changed \(scandir -> open\)/.test((dDiff(U, Object.assign({}, U, { syscall: 'open' })).changed[0] || {}).why || ''));
    t('180h a time readable in one reading only (lstat failed once) is a change', dDiff(U, Object.assign({}, U, { mtimeMs: null })).ok === false);
    t('180h an unreadable FILE whose size changed (same code, same time) is a change', dDiff(Object.assign({}, U, { syscall: 'open', size: 10 }), Object.assign({}, U, { syscall: 'open', size: 11 })).ok === false);
    t('180h [R13] an unreadable FILE with the same code, time and size is not comparable', dDiff(Object.assign({}, U, { syscall: 'open', size: 10 }), Object.assign({}, U, { syscall: 'open', size: 10 })).ok === true);
    t('180h a summarized-folder entry that cannot be read (failClosed) stays a change, both times unreadable', dDiff(Object.assign({}, U, { failClosed: 'summary' }), Object.assign({}, U, { failClosed: 'summary' })).ok === false);
    t('180h unreadable -> absent and absent -> unreadable are changes (REMOVED / ADDED)', dDiff(U, { kind: 'absent' }).ok === false && dDiff({ kind: 'absent' }, U).ok === false);
    // ---- (f) the real defect end to end: an install into such a project, the install line, the change report, the CLI -------
    const pF = projWp2c('t180f');
    const RF = '.claude/worktrees/wp-pw1/src/Faitz.Tests/bin/Release/net10.0-windows/scratch/296eae37/pd/Faitz.untrusted-20261009040144-5b0eb1f9';
    const LF = path.join(pF, ...RF.split('/'));
    wfx(pF, RF + '/quarantined.bin', 'quarantined by a test');
    lock(LF);
    const { tpl: tplF } = tplHomeWp2c('t180f-tpl', { settings: false });
    const rF = sync.safeSyncProject(tplF, pF, { batchId: 'b180f', nowIso: NOW_WP2C });
    t('180f [R13] an install into a project holding a locked (unlistable) folder SUCCEEDS (pre-R13: ROLLED BACK as a protect violation)', rF.ok === true && !rF.protectViolation && rfx(pF, '.claude/forge-bin/tool.cjs') === 'TOOL-V2');
    t('180f [R13] ...its protect verdict lists that folder as not comparable', !!rF.protect && rF.protect.ok === true && nc(rF.protect).length === 1 && nc(rF.protect)[0].key === RF);
    const printedF = quiet(() => sync.printSafeSyncResult(pF, rF)).out.join('\n');
    t('180f [R13] the install line says it: "not comparable (unreadable on both sides): 1 entry — the same error each time (EPERM 1)"', /not comparable \(unreadable on both sides\): 1 entry — the same error each time \(EPERM 1\)/.test(printedF));
    const repF = rF.report && rF.report.path ? fs.readFileSync(rF.report.path, 'utf8') : '';
    t('180f [R13] the change report counts it (unreadable entries recorded: 1 before, 1 after) and names the folder', /unreadable entries recorded: 1 before, 1 after/.test(repF) && /not comparable \(unreadable on both sides\): 1 entry/.test(repF) && repF.includes(RF));
    // the CLI (a child process: REAL sees the ACL itself; INJECTED gets the same EPERM through a preload)
    const preload = path.join(freshDir('t180f-preload'), 'locked-folder.cjs');
    fs.writeFileSync(preload, [
      'var fs = require("fs"), path = require("path");',
      'var locked = path.resolve(process.env.FORGE_R13_LOCKED || "").toLowerCase();',
      'var rd = fs.readdirSync;',
      'fs.readdirSync = function (q) { if (process.env.FORGE_R13_LOCKED && path.resolve(String(q)).toLowerCase() === locked) { var e = new Error("EPERM: operation not permitted, scandir \'" + q + "\'"); e.code = "EPERM"; e.syscall = "scandir"; throw e; } return rd.apply(fs, arguments); };',
    ].join('\n'));
    const cli = (args) => spawnSync(process.execPath, (REAL ? [] : ['-r', preload]).concat([CLI], args), { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tplF }, REAL ? {} : { FORGE_R13_LOCKED: LF }) });
    const out = path.join(freshDir('t180f-out'), 'pm.json');
    const pm = cli(['protect-manifest', pF, '--out', out]);
    t('180f [R13] (CLI) protect-manifest exits 0 and prints "1 unreadable entry recorded" with its code', pm.status === 0 && /\b1 unreadable entry recorded \(not hashed: [^)]*EPERM 1; 1 with their modified time\)/.test(pm.stdout));
    const vp = cli(['verify-protect', pF, out]);
    // WP-SYNC-R13B: with an entry that could not be verified the headline no longer claims "nothing protected changed"
    // WP-SYNC-R14 — deliberate pin change: that headline is now "no violation detected within the verified scope"
    t('180f [R13][R13B][R14] (CLI) verify-protect exits 0 and prints the not-comparable line and the unreadable counts', vp.status === 0 && /OK — no violation detected within the verified scope/.test(vp.stdout) && !/nothing protected changed/.test(vp.stdout) && /unreadable entries recorded: 1 before, 1 now/.test(vp.stdout) && /not comparable \(unreadable on both sides\): 1 entry — the same error each time \(EPERM 1\); recorded, not hashed; modified time compared for 1/.test(vp.stdout));
    const vj = cli(['verify-protect', pF, out, '--json']);
    let j = null; try { j = JSON.parse(vj.stdout); } catch { j = null; }
    t('180f [R13] (CLI) verify-protect --json lists the key under notComparable and the counts under unreadable', vj.status === 0 && !!j && j.ok === true && nc(j).length === 1 && nc(j)[0].key === RF && un(j).notComparable === 1);
    unlock(LF);
  } finally {
    fs.readdirSync = origReaddir;
    fs.readFileSync = origRead;
    for (const d of [...aclLocked]) aclUnlock(d); // a deny left behind would make the fixture removal at exit fail
  }
  console.log('     (180 evidence source: ' + (REAL ? 'REAL OS EPERM on scandir via an icacls deny of List-folder' : 'INJECTED — fs.readdirSync throws EPERM/scandir for the fixture folder (an icacls deny did not reproduce it here)') + ')');
});

// =====================================================================================
// 181) WP-SYNC-R13B: the Codex adversarial review of R13 (ONE round, NEEDS FIXES; R13-01..R13-05, each confirmed by a
//      reproduction). Assertions marked [R13B] fail on the R13 code; unmarked ones are guards that held before too. The
//      locked folders and the failing .git probe are INJECTED (fs.readdirSync / fs.lstatSync throw EPERM for exactly one fixture
//      path; the CLI child gets the same through a `node -r` preload) — deterministic on every platform, no ACL is ever changed.
//   R13-01 "not comparable" only STRICTLY inside .claude/worktrees/<name>/; unreadable on both sides anywhere else (memory, the
//          never-touch floor, other .claude paths, the root files) is a VIOLATION, "unverifiable protected path" — two null times too.
//   R13-02 a .git probe failing with anything but ENOENT/ENOTDIR is a checkout that cannot be identified: fail closed.
//   R13-03 the size is compared on its own; metadata recorded in one reading only is never "the same".
//   R13-04 the failing operation must be known in BOTH readings (null/null is not a match).
//   R13-05 install line, change report, receipt and verify CLI count inventoried / verified / NOT verified separately.
// =====================================================================================
r4Section('181', () => {
  console.log('\n181) WP-SYNC-R13B: "not comparable" only inside .claude/worktrees/<name>/; a failed .git probe is fail closed; size and operation always compared; inventoried / verified / NOT verified counts');
  const foldPath = (q) => { const r = path.resolve(String(q)); return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r; };
  const lockedDirs = new Set(); // folded folder paths whose readdir throws EPERM/scandir
  const lockedLstat = new Set(); // folded paths whose lstat throws EPERM/lstat
  const origReaddir = fs.readdirSync, origLstat = fs.lstatSync;
  const injErr = (op, q) => { const e = new Error('EPERM: operation not permitted (injected), ' + op + ' \'' + String(q) + '\''); e.code = 'EPERM'; e.syscall = op; e.path = String(q); return e; };
  fs.readdirSync = function (q, ...rest) { if (lockedDirs.has(foldPath(q))) throw injErr('scandir', q); return origReaddir.call(fs, q, ...rest); };
  fs.lstatSync = function (q, ...rest) { if (lockedLstat.has(foldPath(q))) throw injErr('lstat', q); return origLstat.call(fs, q, ...rest); };
  const nc = (v) => (v && v.notComparable) || [];
  const whyOf = (v, key) => ((v && v.changed) || []).filter((c) => c.key === key).map((c) => c.why || '').join(' | ');
  const base = (entries) => ({ schema: sync.PROTECT_SCHEMA, projectPath: 'x', shippedRels: [], entries });
  const dAt = (key, b, a) => sync.diffProtectManifests(base({ [key]: b }), { entries: { [key]: a } }, null);
  const U = { kind: 'unreadable', error: 'EPERM: operation not permitted, scandir \'x\'', code: 'EPERM', syscall: 'scandir', mtimeMs: 1000 };
  const IN = '.claude/worktrees/wp-x/scratch/k'; // strictly inside a child of .claude/worktrees
  const T0 = new Date('2026-10-09T04:01:44.000Z');
  const lockPreload = (envName) => {
    const f = path.join(freshDir('t181-preload'), 'locked-folder.cjs');
    fs.writeFileSync(f, [
      'var fs = require("fs"), path = require("path");',
      'var locked = path.resolve(process.env.' + envName + ' || "").toLowerCase();',
      'var rd = fs.readdirSync;',
      'fs.readdirSync = function (q) { if (process.env.' + envName + ' && path.resolve(String(q)).toLowerCase() === locked) { var e = new Error("EPERM: operation not permitted, scandir \'" + q + "\'"); e.code = "EPERM"; e.syscall = "scandir"; throw e; } return rd.apply(fs, arguments); };',
    ].join('\n'));
    return f;
  };
  try {
    const { tpl } = tplHomeWp2c('t181-tpl', { settings: false });
    // ---- R13-01 (a): the Codex repro — a MEMORY folder that cannot be listed, and a content change below it ----------------------
    const pA = projWp2c('t181a');
    const MEM = '.claude/agent-memory/locked-agent';
    const memDir = path.join(pA, ...MEM.split('/'));
    const memFile = wfx(pA, MEM + '/MEMORY.md', '# lessons\n');
    fs.utimesSync(memDir, T0, T0);
    lockedDirs.add(foldPath(memDir));
    const mA = sync.buildProtectManifest(tpl, pA, { nowIso: NOW_WP2C });
    const eA = mA.entries[MEM] || {};
    t('181a (setup) the locked memory folder is ONE unreadable entry (EPERM scandir, time recorded); nothing below it is recorded', eA.kind === 'unreadable' && eA.code === 'EPERM' && Math.round(eA.mtimeMs) === T0.getTime() && !mA.entries[MEM + '/MEMORY.md']);
    const vA = sync.verifyProtect(pA, mA, null);
    t('181a [R13B] a MEMORY folder unreadable on both sides (same code, operation and time) is a VIOLATION, "unverifiable protected path" (R13: not comparable)', vA.ok === false && sync.protectViolationLines(vA).includes('CHANGED ' + MEM) && /unverifiable protected path/.test(whyOf(vA, MEM)) && nc(vA).length === 0);
    fs.writeFileSync(memFile, '# lessons\na line planted below the locked folder\n');
    fs.utimesSync(memDir, T0, T0); // the folder's own time stays put: no hash and no time can see this change
    const vA2 = sync.verifyProtect(pA, mA, null);
    t('181a [R13B] ...so a content change BELOW it, the folder time unchanged, can no longer pass (R13: OK — the change unseen)', vA2.ok === false && sync.protectViolationLines(vA2).includes('CHANGED ' + MEM));
    lockedDirs.delete(foldPath(memDir));
    // ---- R13-01 (b): the same lock strictly inside .claude/worktrees/<name>/ stays "not comparable" (the real 26H2 shape) ----------
    const pB = projWp2c('t181b');
    const WT = '.claude/worktrees/wp-scr/src/T/bin/scratch/ab12/pd';
    const wtDir = path.join(pB, ...WT.split('/'));
    wfx(pB, WT + '/inside.txt', 'scratch');
    fs.utimesSync(wtDir, T0, T0);
    lockedDirs.add(foldPath(wtDir));
    const mB = sync.buildProtectManifest(tpl, pB, { nowIso: NOW_WP2C });
    const vB = sync.verifyProtect(pB, mB, null);
    t('181b a folder locked strictly inside .claude/worktrees/<name>/ stays "not comparable" (agent-checkout territory), not a violation', vB.ok === true && nc(vB).length === 1 && nc(vB)[0].key === WT);
    t('181b [R13B] the verdict counts inventoried / verified / NOT verified (verified + NOT verified = inventoried = checked; the not-comparable entry is NOT verified)', vB.inventoried === vB.checked && vB.notVerified === 1 && vB.verified === vB.checked - 1);
    lockedDirs.delete(foldPath(wtDir));
    // ---- R13-01 (c): the scope rule at unit level -----------------------------------------------------------------------------
    for (const k of ['.claude/k', '.claude/agent-memory/head-chef', '.claude/forge-adoption/record.json', '.claude/FORGE_MEMORY.md', 'CLAUDE.md', '.env', '.claude/worktrees', '.claude/worktrees/wp-x', '.claude/worktrees/../agent-memory/x', '.claude/worktrees/wp-x/../../k']) {
      const d = dAt(k, U, Object.assign({}, U));
      t('181c [R13B] unreadable on both sides at ' + k + ' (not strictly inside .claude/worktrees/<name>/) is a VIOLATION, "unverifiable protected path"', d.ok === false && /unverifiable protected path/.test(whyOf(d, k)) && nc(d).length === 0);
    }
    const dIn = dAt(IN, U, Object.assign({}, U));
    t('181c ...while strictly inside .claude/worktrees/<name>/ the same pair is "not comparable"', dIn.ok === true && nc(dIn).length === 1 && nc(dIn)[0].mtimeCompared === true);
    const N0 = Object.assign({}, U, { mtimeMs: null });
    t('181c [R13B] two NULL times (lstat failed both times, no size) outside .claude/worktrees: a VIOLATION', dAt('.claude/agent-memory/x', N0, Object.assign({}, N0)).ok === false);
    const dN = dAt(IN, N0, Object.assign({}, N0));
    t('181c ...inside .claude/worktrees/<name>/ the same pair is "not comparable", its time not compared', dN.ok === true && nc(dN).length === 1 && nc(dN)[0].mtimeCompared === false);
    t('181c [R13B] protectUnreadableSame without a path is never "the same" (fail closed)', sync.protectUnreadableSame(U, Object.assign({}, U)).same === false);
    // ---- a .git probe that fails (EPERM) is a checkout that cannot be identified — fail closed -------------------------
    const pE = projWp2c('t181e');
    const gitE = wfx(pE, '.claude/worktrees/agent-2/.git', 'gitdir: elsewhere/agent-2\n');
    wfx(pE, '.claude/worktrees/agent-2/src/a.txt', 'checkout content');
    const ckDir = path.dirname(gitE);
    t('181e hasGitEntry: a readable .git FILE counts, a folder without one does not', sync.hasGitEntry(ckDir) === true && sync.hasGitEntry(path.join(ckDir, 'src')) === false);
    lockedLstat.add(foldPath(gitE));
    t('181e [R13B] hasGitEntry: a .git probe failing with EPERM is NOT "no .git" (R13: false — the checkout was walked as a plain folder)', sync.hasGitEntry(ckDir) === true);
    let mE = null, vE = null;
    try { mE = sync.buildProtectManifest(tpl, pE, { nowIso: NOW_WP2C }); vE = sync.verifyProtect(pE, mE, null); } catch (e) { console.error('  181e threw: ' + e.message); }
    const eE = (mE && mE.entries['.claude/worktrees/agent-2']) || {};
    t('181e [R13B] that child is ONE fail-closed checkout entry (unreadable, failClosed "checkout"); nothing below it is recorded', eE.kind === 'unreadable' && eE.failClosed === 'checkout' && !!mE && !Object.keys(mE.entries).some((k) => k.startsWith('.claude/worktrees/agent-2/')));
    t('181e [R13B] ...and verifying it is a VIOLATION (CHANGED .claude/worktrees/agent-2), never "not comparable" (R13: OK)', !!vE && vE.ok === false && sync.protectViolationLines(vE).includes('CHANGED .claude/worktrees/agent-2') && nc(vE).length === 0);
    const wtRoot = path.join(pE, '.claude', 'worktrees');
    const sigUnknown = sync.worktreesChildrenSignature(wtRoot);
    lockedLstat.delete(foldPath(gitE));
    fs.unlinkSync(gitE);
    const sigAbsent = sync.worktreesChildrenSignature(wtRoot);
    t('181e [R13B] worktreesChildrenSignature tells "the .git probe failed" from "no .git" (R13: both "d", the same signature)', typeof sigUnknown === 'string' && sigUnknown !== sigAbsent);
    // ---- the size is compared on its own; metadata recorded in one reading only is never "the same" ------------------
    const F = { kind: 'unreadable', error: 'EPERM: operation not permitted, open \'f\'', code: 'EPERM', syscall: 'open' };
    t('181f [R13B] no time in the "before" reading: a SIZE that changed (10 -> 11) is still a change (R13: same — the size was never compared)', dAt(IN, Object.assign({}, F, { size: 10 }), Object.assign({}, F, { mtimeMs: 1000, size: 11 })).ok === false);
    t('181f [R13B] no time in either reading: a size that changed is a change, with the reason', /size changed \(10 -> 11\)/.test(whyOf(dAt(IN, Object.assign({}, F, { size: 10 }), Object.assign({}, F, { size: 11 })), IN)));
    t('181f [R13B] a time recorded in the "before" reading only (the "after" has none) is a change (R13: same)', dAt(IN, Object.assign({}, F, { mtimeMs: 1000, size: 10 }), Object.assign({}, F, { size: 10 })).ok === false);
    t('181f [R13B] a pre-R13 "before" FILE entry (message only, no size) against a reading WITH a size is a change — the size cannot be matched (R13: same)', dAt(IN, { kind: 'unreadable', error: F.error }, Object.assign({}, F, { mtimeMs: 1000, size: 10 })).ok === false);
    t('181f [R13B] an R13 "before" reading that lost its time (code + operation recorded) against a reading WITH a time is a change, even with the same size — only a pre-R13 {kind, error} entry skips the time (R13: same)', dAt(IN, Object.assign({}, F, { size: 10 }), Object.assign({}, F, { mtimeMs: 1000, size: 10 })).ok === false);
    t('181f [R13B] two R13-format readings that BOTH lack the time field (a damaged manifest entry) are a change, with the reason (R13: same)', /neither reading carries its modified-time field/.test(whyOf(dAt(IN, Object.assign({}, F, { size: 10 }), Object.assign({}, F, { size: 10 })), IN)));
    t('181f a size in one reading only (same time) is a change', dAt(IN, Object.assign({}, F, { mtimeMs: 1000, size: 10 }), Object.assign({}, F, { mtimeMs: 1000 })).ok === false);
    const dLeg = dAt(IN, { kind: 'unreadable', error: U.error }, Object.assign({}, U));
    t('181f a pre-R13 "before" FOLDER entry against an R13 reading (the real 26H2 shape) stays "not comparable", time not compared', dLeg.ok === true && nc(dLeg).length === 1 && nc(dLeg)[0].mtimeCompared === false);
    // ---- the failing operation must be known in BOTH readings ---------------------------------------------------------
    const NoOp = Object.assign({}, U, { syscall: null, error: 'EPERM' });
    const dNoOp = dAt(IN, NoOp, Object.assign({}, NoOp));
    t('181g [R13B] no operation recorded on either side (null/null) is a change, never a match (R13: same)', dNoOp.ok === false && /operation/.test(whyOf(dNoOp, IN)));
    t('181g [R13B] pre-R13 messages that name no operation ("EBUSY" both times) are a change (R13: same)', dAt(IN, { kind: 'unreadable', error: 'EBUSY' }, { kind: 'unreadable', error: 'EBUSY' }).ok === false);
    t('181g an operation known on one side only is a change', dAt(IN, NoOp, Object.assign({}, U)).ok === false);
    // ---- install line, change report, receipt and verify CLI: inventoried / verified / NOT verified ---------------------
    const pH = projWp2c('t181h');
    const RH = '.claude/worktrees/wp-pw2/scratch/77aa/pd';
    const LH = path.join(pH, ...RH.split('/'));
    wfx(pH, RH + '/q.bin', 'quarantined');
    lockedDirs.add(foldPath(LH));
    const { tpl: tplH } = tplHomeWp2c('t181h-tpl', { settings: false });
    const rH = sync.safeSyncProject(tplH, pH, { batchId: 'b181h', nowIso: NOW_WP2C });
    t('181h (setup) the install succeeds, the locked worktree folder "not comparable"', rH.ok === true && !!rH.protect && nc(rH.protect).length === 1);
    const inv = rH.protect ? rH.protect.checked : -1;
    const printedH = quiet(() => sync.printSafeSyncResult(pH, rH)).out.join('\n');
    t('181h [R13B] the install line counts ' + inv + ' inventoried, ' + (inv - 1) + ' verified unchanged, 1 NOT verified (R13: "' + inv + ' re-checked after the last write — unchanged")', printedH.includes('protected entries: ' + inv + ' inventoried · ' + (inv - 1) + ' verified after the last write — unchanged') && /1 NOT verified \(unreadable on both sides/.test(printedH) && !/re-checked after the last write/.test(printedH));
    const repH = rH.report && rH.report.path ? fs.readFileSync(rH.report.path, 'utf8') : '';
    t('181h [R13B] the change report says the same, never "re-checked ... unchanged" for all of them', repH.includes(inv + ' protected entries inventoried · ' + (inv - 1) + ' verified after the last write: unchanged · 1 NOT verified') && !/re-checked after the last write/.test(repH));
    t('181h [R13B] the receipt records verified and notVerified next to checked', !!rH.receipt && !!rH.receipt.protect && rH.receipt.protect.checked === inv && rH.receipt.protect.verified === inv - 1 && rH.receipt.protect.notVerified === 1);
    // the verify CLI (a child process: the same lock through a preload)
    const mH = sync.buildProtectManifest(tplH, pH, { nowIso: NOW_WP2C });
    const outH = path.join(freshDir('t181h-out'), 'pm.json');
    sync.writeProtectManifest(mH, outH);
    const invH = Object.keys(mH.entries).length;
    const vpH = spawnSync(process.execPath, ['-r', lockPreload('FORGE_R13B_LOCKED'), CLI, 'verify-protect', pH, outH], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tplH, FORGE_R13B_LOCKED: LH }) });
    // WP-SYNC-R14 — deliberate pin change: the limited headline reads "no violation detected within the verified scope"
    t('181h [R13B][R14] (CLI) verify-protect exits 0 but no longer says "nothing protected changed" while an entry could not be verified', vpH.status === 0 && /OK — no violation detected within the verified scope/.test(vpH.stdout) && !/nothing protected changed/.test(vpH.stdout));
    t('181h [R13B] (CLI) ...and prints the three counts (' + invH + ' inventoried, ' + (invH - 1) + ' verified, 1 NOT verified)', vpH.stdout.includes('(' + invH + ' entries inventoried, ' + (invH - 1) + ' verified, 1 NOT verified'));
    lockedDirs.delete(foldPath(LH));
    // a project with nothing unreadable keeps the plain headline, with its counts
    const pC = projWp2c('t181h-clean');
    const mC = sync.buildProtectManifest(tplH, pC, { nowIso: NOW_WP2C });
    const outC = path.join(freshDir('t181h-out-clean'), 'pm.json');
    sync.writeProtectManifest(mC, outC);
    const invC = Object.keys(mC.entries).length;
    const vpC = spawnSync(process.execPath, [CLI, 'verify-protect', pC, outC], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tplH }) });
    // WP-SYNC-R14 — deliberate pin change: this fixture is no git work tree, so its app code is NOT guarded and the
    // headline is limited to the verified scope (section 182e shows "nothing protected changed" for a fully guarded git project)
    t('181h [R13B][R14] (CLI) nothing unreadable, no git: "OK — no violation detected within the verified scope (' + invC + ' entries inventoried, ' + invC + ' verified, 0 NOT verified", app code NOT guarded', vpC.status === 0 && vpC.stdout.includes('OK — no violation detected within the verified scope (' + invC + ' entries inventoried, ' + invC + ' verified, 0 NOT verified') && /app code: NOT guarded \(not a git work tree\)/.test(vpC.stdout));
  } finally {
    fs.readdirSync = origReaddir;
    fs.lstatSync = origLstat;
  }
});

// =====================================================================================
// 182) WP-SYNC-R14: the Codex verification review of ccbe9e7 — four more fail-OPEN gaps in the protect check, each
//      reproduced here. Assertions marked fail on the R13B code; unmarked ones are guards that held before too. Link,
//      file and lstat reads are INJECTED (fs.readlinkSync / fs.readFileSync / fs.lstatSync throw EPERM for exactly one fixture path;
//      a CLI child gets the same through a `node -r` preload); junctions are real (r3Junction, a visible SKIP where refused).
//   R14-01 a failed readlink is an unreadable entry (code + operation 'readlink'), never {symlink, target:null}; a checkout whose .git
//          link cannot be read is fail closed (a PERMANENT violation, said in the output); an app-code link is never 'link ?'.
//   R14-02 an app-code path that could not be read is a structured marker ('unreadable:<code>:<operation>'), never equal to anything:
//          unverifiable -> a violation, appCode.guarded 'partial'; an older manifest's literal 'unreadable' / 'link ?' too.
//   R14-03 a link outside .claude/worktrees that resolves INTO it is refused (also above a never-touch path, e.g. .claude/config); a
//          link at or above a never-touch / memory path that resolves OUTSIDE the project is refused.
//   R14-04 verified = content compared and equal (meta / checkout / skipped summaries and the sync's own recorded changes are not);
//          app-code coverage next to every "unchanged"; "no violation detected within the verified scope" unless all was verified.
// =====================================================================================
r4Section('182', () => {
  console.log('\n182) WP-SYNC-R14: failed link reads and unreadable app paths fail closed; links into .claude/worktrees or out of the project above memory are refused; verified = compared and equal');
  const foldPath = (q) => { const r = path.resolve(String(q)); return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r; };
  const failReadlink = new Set(), failRead = new Set(), failLstat = new Set(); // folded paths whose call throws EPERM
  const origReadlink = fs.readlinkSync, origRead = fs.readFileSync, origLstat = fs.lstatSync;
  const injErr = (op, q) => { const e = new Error('EPERM: operation not permitted (injected), ' + op + ' \'' + String(q) + '\''); e.code = 'EPERM'; e.syscall = op; e.path = String(q); return e; };
  fs.readlinkSync = function (q, ...rest) { if (typeof q === 'string' && failReadlink.has(foldPath(q))) throw injErr('readlink', q); return origReadlink.call(fs, q, ...rest); };
  fs.readFileSync = function (q, ...rest) { if (typeof q === 'string' && failRead.has(foldPath(q))) throw injErr('open', q); return origRead.call(fs, q, ...rest); };
  fs.lstatSync = function (q, ...rest) { if (typeof q === 'string' && failLstat.has(foldPath(q))) throw injErr('lstat', q); return origLstat.call(fs, q, ...rest); };
  const nc = (v) => (v && v.notComparable) || [];
  const whyOf = (v, key) => ((v && v.changed) || []).filter((c) => c.key === key).map((c) => c.why || '').join(' | ');
  const tryBuild = (tplX, p) => { try { return { m: sync.buildProtectManifest(tplX, p, { nowIso: NOW_WP2C }), msg: '' }; } catch (e) { return { m: null, msg: e.message }; } };
  const noLinkPreload = () => {
    const f = path.join(freshDir('t182-preload'), 'no-readlink.cjs');
    fs.writeFileSync(f, [
      'var fs = require("fs"), path = require("path");',
      'var locked = path.resolve(process.env.FORGE_R14_NOLINK || "").toLowerCase();',
      'var rl = fs.readlinkSync;',
      'fs.readlinkSync = function (q) { if (process.env.FORGE_R14_NOLINK && path.resolve(String(q)).toLowerCase() === locked) { var e = new Error("EPERM: operation not permitted, readlink \'" + q + "\'"); e.code = "EPERM"; e.syscall = "readlink"; throw e; } return rl.apply(fs, arguments); };',
    ].join('\n'));
    return f;
  };
  try {
    const { tpl } = tplHomeWp2c('t182-tpl', { settings: false });
    // ---- R14-01 (a): a link whose target cannot be read; then RETARGETED while it still cannot be read -----------------------------
    const pA = projWp2c('t182a');
    const LNK = '.claude/shared-docs';
    const lnkA = path.join(pA, ...LNK.split('/'));
    if (r3Junction(freshDir('t182a-target1'), lnkA, '182a')) {
      failReadlink.add(foldPath(lnkA));
      const bA = tryBuild(tpl, pA);
      const eA = (bA.m && bA.m.entries[LNK]) || {};
      t('182a [R14] a link whose target cannot be read is ONE unreadable entry with its code and operation (EPERM readlink), never {symlink, target:null} (R13B: symlink, target null)', eA.kind === 'unreadable' && eA.code === 'EPERM' && eA.syscall === 'readlink');
      fs.rmdirSync(lnkA);
      r3Junction(freshDir('t182a-target2'), lnkA, '182a2'); // the same name now points somewhere else
      let vA = null; try { vA = bA.m ? sync.verifyProtect(pA, bA.m, null) : null; } catch (e) { console.error('  182a verify threw: ' + e.message); }
      t('182a [R14] the link RETARGETED while its target could not be read either time is a VIOLATION, "unverifiable protected path" (R13B: OK — null === null)', !!vA && vA.ok === false && sync.protectViolationLines(vA).includes('CHANGED ' + LNK) && /unverifiable protected path/.test(whyOf(vA, LNK)));
      failReadlink.delete(foldPath(lnkA));
      fs.rmdirSync(lnkA);
    }
    // the same failed read strictly inside .claude/worktrees/<name>/ follows the not-comparable rule of every other unreadable entry
    const pW = projWp2c('t182a-wt');
    const WL = '.claude/worktrees/wp-l/scratch/lnk';
    fs.mkdirSync(path.join(pW, '.claude', 'worktrees', 'wp-l', 'scratch'), { recursive: true });
    const wl = path.join(pW, ...WL.split('/'));
    if (r3Junction(freshDir('t182a-wt-target'), wl, '182a3')) {
      failReadlink.add(foldPath(wl));
      const bW = tryBuild(tpl, pW);
      let vW = null; try { vW = bW.m ? sync.verifyProtect(pW, bW.m, null) : null; } catch (e) { console.error('  182a3 verify threw: ' + e.message); }
      t('182a [R14] the same failed link read strictly inside .claude/worktrees/<name>/ is "not comparable" (same code, operation and time), like any unreadable entry there (R13B: a plain link with target null)', !!vW && vW.ok === true && nc(vW).length === 1 && nc(vW)[0].key === WL && nc(vW)[0].syscall === 'readlink');
      failReadlink.delete(foldPath(wl));
      fs.rmdirSync(wl);
    }
    // ---- R14-01 (b): an agent checkout whose .git is a LINK that cannot be read -----------------------------------------------
    const pK = projWp2c('t182b');
    const ck = path.join(pK, '.claude', 'worktrees', 'agent-3');
    wfx(pK, '.claude/worktrees/agent-3/src/a.txt', 'checkout content');
    const gitLink = path.join(ck, '.git');
    if (r3Junction(freshDir('t182b-gitdir-a'), gitLink, '182b')) {
      failReadlink.add(foldPath(gitLink));
      const bK = tryBuild(tpl, pK);
      const eK = (bK.m && bK.m.entries['.claude/worktrees/agent-3']) || {};
      t('182b [R14] a checkout whose .git LINK cannot be read is ONE fail-closed checkout entry (unreadable, failClosed "checkout", EPERM readlink), never git "link:null" (R13B: link:null)', eK.kind === 'unreadable' && eK.failClosed === 'checkout' && eK.code === 'EPERM' && eK.syscall === 'readlink');
      fs.rmdirSync(gitLink);
      r3Junction(freshDir('t182b-gitdir-b'), gitLink, '182b2'); // checkout A swapped for B under one name; the link still unreadable
      let vK = null; try { vK = bK.m ? sync.verifyProtect(pK, bK.m, null) : null; } catch (e) { console.error('  182b verify threw: ' + e.message); }
      t('182b [R14] ...so the checkout swapped behind it is a VIOLATION (R13B: OK — "link:null" === "link:null")', !!vK && vK.ok === false && sync.protectViolationLines(vK).includes('CHANGED .claude/worktrees/agent-3'));
      t('182b [R14] the reason says it plainly: a .git probe failing in both readings is a PERMANENT violation (intended, fail closed)', /PERMANENT violation/.test(whyOf(vK, '.claude/worktrees/agent-3')) && /intended: fail closed/.test(whyOf(vK, '.claude/worktrees/agent-3')));
      failReadlink.delete(foldPath(gitLink));
      // the CLI says so as well: protect-manifest names the unidentifiable checkout and the permanent violation it means
      const outK = path.join(freshDir('t182b-out'), 'pm.json');
      const pmK = spawnSync(process.execPath, ['-r', noLinkPreload(), CLI, 'protect-manifest', pK, '--out', outK], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tpl, FORGE_R14_NOLINK: gitLink }) });
      t('182b [R14] (CLI) protect-manifest exits 0 and says: 1 agent checkout could not be identified (.git probe failed) — a PERMANENT violation in every verify (intended: fail closed)', pmK.status === 0 && /1 agent checkout could not be identified \(its \.git probe failed: EPERM readlink\)[^\n]*PERMANENT violation[^\n]*intended: fail closed/.test(pmK.stdout));
      const vpK = spawnSync(process.execPath, ['-r', noLinkPreload(), CLI, 'verify-protect', pK, outK], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tpl, FORGE_R14_NOLINK: gitLink }) });
      t('182b [R14] (CLI) verify-protect against it exits 1 and prints the PERMANENT-violation reason', vpK.status === 1 && /why \.claude\/worktrees\/agent-3: [^\n]*PERMANENT violation/.test(vpK.stderr));
      fs.rmdirSync(gitLink);
    }
    // ---- app-code paths that cannot be read (and app links whose target cannot be read) ------------------------------
    const gb = (entries) => ({ head: 'h0', entries, count: Object.keys(entries).length, ignored: { count: 0, listHash: 'l0' }, submodules: {}, partial: [] });
    const withGit = (entries) => ({ schema: sync.PROTECT_SCHEMA, projectPath: 'x', shippedRels: [], entries: {}, git: gb(entries) });
    const legacy = { 'src/a.js': ' M unreadable', '(link) lib': 'link ?' };
    const dLeg = sync.diffProtectManifests(withGit(legacy), withGit(Object.assign({}, legacy)), null);
    t('182c [R14] an older manifest\'s literal " M unreadable" and "link ?" on BOTH sides are a VIOLATION, never equal, the guard "partial" (R13B: OK, guarded true)', dLeg.ok === false && dLeg.changed.some((c) => c.key === '(app) src/a.js') && dLeg.changed.some((c) => c.key === '(app) (link) lib') && dLeg.appCode.guarded === 'partial');
    const dNew = sync.diffProtectManifests(withGit({ 'src/a.js': ' M unreadable:EPERM:open' }), withGit({ 'src/a.js': ' M unreadable:EPERM:open' }), null);
    t('182c [R14] two identical structured markers are never "unchanged" either: unverifiable, with the reason', dNew.ok === false && /unverifiable/.test(whyOf(dNew, '(app) src/a.js')) && /EPERM/.test(whyOf(dNew, '(app) src/a.js')));
    const dDel = sync.diffProtectManifests(withGit({ 'src/gone.js': ' D missing' }), withGit({ 'src/gone.js': ' D missing' }), null);
    t('182c a tracked file deleted before and after (" D missing" both times — a real state, not a failed read) stays unchanged', dDel.ok === true && dDel.appCode.guarded === true);
    if (!PUB_GIT_OK) console.log('  SKIP 182c (git part) — git is not available here; the application-code guard needs git');
    else {
      const pG = projWp2c('t182c', { doctorExit: null });
      wfx(pG, 'src/app.js', 'console.log("v1");\n');
      wfx(pG, 'src/gone.js', 'deleted before the sync\n');
      const g = pubGit(pG); g(['init', '-q']); g(['add', '-A']); g(['commit', '-q', '-m', 'app']);
      const appF = path.join(pG, 'src', 'app.js');
      fs.writeFileSync(appF, 'console.log("v2 — an uncommitted owner edit");\n'); // already dirty before the "sync"
      fs.rmSync(path.join(pG, 'src', 'gone.js'));
      failRead.add(foldPath(appF));
      const mG = sync.buildProtectManifest(tpl, pG, {});
      const entG = (mG.git && mG.git.entries['src/app.js']) || '';
      t('182c [R14] an app file that cannot be read is recorded with a structured marker (" M unreadable:EPERM:open"), never the bare word (R13B: " M unreadable")', / unreadable:EPERM:open$/.test(entG));
      t('182c a tracked file that is really gone stays " D missing" (ENOENT is a state, not a failed read)', (mG.git.entries['src/gone.js'] || '') === ' D missing');
      fs.writeFileSync(appF, 'console.log("v3 — edited while the guard could not read it");\n');
      const vG = sync.verifyProtect(pG, mG, null);
      t('182c [R14] the file EDITED while it could not be read in either reading is a VIOLATION "(app) src/app.js", unverifiable (R13B: OK, guarded true, changed 0)', vG.ok === false && vG.changed.some((c) => c.key === '(app) src/app.js' && /unverifiable/.test(c.why || '')));
      t('182c [R14] ...and the app-code guard says "partial", naming the path (never true)', vG.appCode.guarded === 'partial' && /src\/app\.js/.test(vG.appCode.reason || ''));
      failRead.delete(foldPath(appF));
      failLstat.add(foldPath(appF));
      const mL = sync.buildProtectManifest(tpl, pG, {});
      t('182c [R14] an app path whose lstat fails (EPERM) is " M unreadable:EPERM:lstat", never "missing" (R13B: " M missing")', / unreadable:EPERM:lstat$/.test((mL.git && mL.git.entries['src/app.js']) || ''));
      const vL = sync.verifyProtect(pG, mL, null);
      t('182c [R14] ...and verifying it is a VIOLATION, guarded "partial" (R13B: OK — "missing" === "missing")', vL.ok === false && vL.changed.some((c) => c.key === '(app) src/app.js') && vL.appCode.guarded === 'partial');
      failLstat.delete(foldPath(appF));
      // an app-level link (a junction at the project top) whose target cannot be read, then retargeted
      const linkApp = path.join(pG, 'lib');
      if (r3Junction(freshDir('t182c-lib1'), linkApp, '182c-link')) {
        failReadlink.add(foldPath(linkApp));
        const mJ = sync.buildProtectManifest(tpl, pG, {});
        t('182c [R14] a top-level app link whose target cannot be read is "unreadable:EPERM:readlink", never "link ?" (R13B: link ?)', (mJ.git.entries['(link) lib'] || '') === 'unreadable:EPERM:readlink');
        fs.rmdirSync(linkApp);
        r3Junction(freshDir('t182c-lib2'), linkApp, '182c-link2');
        const vJ = sync.verifyProtect(pG, mJ, null);
        t('182c [R14] ...retargeted while unreadable both times: a VIOLATION "(app) (link) lib" (R13B: OK)', vJ.ok === false && vJ.changed.some((c) => c.key === '(app) (link) lib'));
        failReadlink.delete(foldPath(linkApp));
        fs.rmdirSync(linkApp);
      }
    }
    // ---- links that hide never-touch paths from the inventory ---------------------------------------------------------
    const pR = projWp2c('t182d');
    wfx(pR, '.claude/worktrees/wp-c/config/forge-overrides.json', '{"overrides":[]}\n');
    if (r3Junction(path.join(pR, '.claude', 'worktrees', 'wp-c', 'config'), path.join(pR, '.claude', 'config'), '182d')) {
      const bR = tryBuild(tpl, pR);
      t('182d [R14] .claude/config (not never-touch itself, but above config/forge-overrides.json) as a junction into .claude/worktrees: REFUSED (R13B: recorded as a link, the never-touch file below it unseen)', !bR.m && /refusing: \.claude\/config is a link\/junction that resolves into \.claude\/worktrees/.test(bR.msg));
      const v1R = sync.sha256(path.join(pR, '.claude', 'forge-bin', 'tool.cjs'));
      const rsR = quiet(() => sync.safeSyncProject(tpl, pR, { batchId: 'b182d', nowIso: NOW_WP2C })).r;
      t('182d [R14] ...and an install into that project is refused before any write (tool.cjs still TOOL-V1)', rsR.ok === false && /resolves into \.claude\/worktrees/.test(rsR.reason || '') && sync.sha256(path.join(pR, '.claude', 'forge-bin', 'tool.cjs')) === v1R);
      fs.rmdirSync(path.join(pR, '.claude', 'config'));
    }
    if (r3Junction(path.join(pR, '.claude', 'worktrees', 'wp-c'), path.join(pR, '.claude', 'notes-linked'), '182d2')) {
      const bN = tryBuild(tpl, pR);
      t('182d [R14] conservative: ANY link outside .claude/worktrees that resolves into it is refused (.claude/notes-linked) (R13B: recorded)', !bN.m && /refusing: \.claude\/notes-linked is a link\/junction that resolves into \.claude\/worktrees/.test(bN.msg));
      fs.rmdirSync(path.join(pR, '.claude', 'notes-linked'));
    }
    if (r3Junction(path.join(pR, '.claude', 'worktrees', 'wp-c'), path.join(pR, '.claude', 'worktrees', 'alias'), '182d3')) {
      const bI = tryBuild(tpl, pR);
      t('182d a link INSIDE .claude/worktrees (to a sibling) is still recorded by its target, not refused', !!bI.m && (bI.m.entries['.claude/worktrees/alias'] || {}).kind === 'symlink');
      fs.rmdirSync(path.join(pR, '.claude', 'worktrees', 'alias'));
    }
    const pO = projWp2c('t182d-out');
    const outside = freshDir('t182d-outside');
    wfx(outside, 'MEMORY.md', '# memory kept outside the project\n');
    for (const rel of ['forge-scribe', 'config', 'agent-memory/linked-agent']) {
      fs.mkdirSync(path.dirname(path.join(pO, '.claude', ...rel.split('/'))), { recursive: true });
      const lp = path.join(pO, '.claude', ...rel.split('/'));
      if (!r3Junction(outside, lp, '182d-' + rel)) continue;
      const bO = tryBuild(tpl, pO);
      t('182d [R14] .claude/' + rel + ' (at or above a never-touch / memory path) as a junction OUTSIDE the project: REFUSED (R13B: recorded by its target, what it holds never inventoried)', !bO.m && new RegExp('refusing: \\.claude/' + rel.replace(/[/.]/g, (c) => '\\' + c) + ' is a link/junction at or above a never-touch / memory path that resolves outside the project').test(bO.msg));
      fs.rmdirSync(lp);
    }
    // judged by the REAL path: a memory junction whose literal target is spelled through an alias OUTSIDE the project but lands back
    // inside it (.claude/scribe-store, walked and hashed at its real place) is not refused; a dangling one pointing outside is
    const aliasHome = freshDir('t182d-alias');
    wfx(pO, '.claude/scribe-store/ledger.jsonl', '{"ask":"kept inside the project"}\n');
    if (r3Junction(pO, path.join(aliasHome, 'proj-alias'), '182d-alias')) {
      const viaAlias = path.join(aliasHome, 'proj-alias', '.claude', 'scribe-store');
      if (r3Junction(viaAlias, path.join(pO, '.claude', 'forge-scribe'), '182d-alias2')) {
        const bA2 = tryBuild(tpl, pO);
        t('182d [R14] a memory junction spelled through an alias outside the project whose REAL path is inside it is not refused (its content is inventoried where it really lives)', !!bA2.m && (bA2.m.entries['.claude/forge-scribe'] || {}).kind === 'symlink' && !!bA2.m.entries['.claude/scribe-store/ledger.jsonl']);
        fs.rmdirSync(path.join(pO, '.claude', 'forge-scribe'));
      }
      fs.rmdirSync(path.join(aliasHome, 'proj-alias'));
    }
    const gone = freshDir('t182d-gone');
    if (r3Junction(gone, path.join(pO, '.claude', 'forge-scribe'), '182d-dangling')) {
      fs.rmSync(gone, { recursive: true, force: true }); // the junction now dangles, its literal target outside the project
      const bD = tryBuild(tpl, pO);
      t('182d [R14] a DANGLING memory junction whose literal target lies outside the project is refused (judged on the literal target)', !bD.m && /resolves outside the project \(.*\(dangling\)\)/.test(bD.msg));
      fs.rmdirSync(path.join(pO, '.claude', 'forge-scribe'));
    }
    fs.rmSync(path.join(pO, '.claude', 'scribe-store'), { recursive: true, force: true });
    if (r3Junction(outside, path.join(pO, '.claude', 'shared-docs'), '182d-plain')) {
      const bP = tryBuild(tpl, pO);
      t('182d a link that is NOT at or above a never-touch path and points outside the project is recorded by its target, not refused', !!bP.m && (bP.m.entries['.claude/shared-docs'] || {}).kind === 'symlink' && typeof bP.m.entries['.claude/shared-docs'].target === 'string');
      fs.rmdirSync(path.join(pO, '.claude', 'shared-docs'));
    }
    // ---- verified = compared and equal; app-code coverage next to "unchanged"; the scope headline -----------------------
    const B4 = { schema: sync.PROTECT_SCHEMA, projectPath: 'x', shippedRels: [], entries: {
      '.claude/a.md': { kind: 'file', size: 1, hash: 'h1' },
      '.claude/d': { kind: 'dir' },
      'AGENTS.md': { kind: 'absent' },
      '.env': { kind: 'meta', size: 3, mtimeMs: 5 },
      '.claude/worktrees/agent-1': { kind: 'skipped-dir', summarized: true, checkout: true, git: 'file:abc' },
      '.claude/forge-bin/node_modules': { kind: 'skipped-dir' },
      '.claude/b.json': { kind: 'file', size: 1, hash: 'h-old' },
    } };
    const A4 = { entries: Object.assign({}, B4.entries, { '.claude/b.json': { kind: 'file', size: 1, hash: 'h-new' } }) };
    const d4 = sync.diffProtectManifests(B4, A4, { changedOk: { '.claude/b.json': 'h-new' } });
    t('182e [R14] verified counts ONLY entries whose content was compared and equal (a file, a folder, an absent root file: 3); meta / checkout / node_modules summaries (3) and the change this sync recorded (1) are not (R13B: 7 verified)', d4.ok === true && d4.inventoried === 7 && d4.verified === 3 && d4.summarized === 3 && d4.changedBySync === 1 && d4.notVerified === 0);
    t('182e [R14] ...the counts add up (verified + summarized + changed by this sync + NOT verified = inventoried) and the verdict is not "complete"', d4.verified + d4.summarized + d4.changedBySync + d4.notVerified === d4.inventoried && d4.complete === false);
    const pc4 = sync.protectCounts(d4);
    t('182e [R14] protectCounts carries the same numbers and completeness', pc4.verified === 3 && pc4.summarized === 3 && pc4.changedBySync === 1 && pc4.complete === false);
    t('182e [R14] a could-not-re-check verdict (error shape) never counts anything as verified', sync.protectCounts({ ok: false, error: 'x', changed: [], added: [], removed: [], allowed: [], checked: 5 }).verified === 0);
    const pI = projWp2c('t182e-inst');
    const { tpl: tplI } = tplHomeWp2c('t182e-tpl', { settings: false });
    const rI = sync.safeSyncProject(tplI, pI, { batchId: 'b182e', nowIso: NOW_WP2C });
    const printedI = quiet(() => sync.printSafeSyncResult(pI, rI)).out.join('\n');
    const lineI = printedI.split('\n').find((l) => /protected entries:/.test(l)) || '';
    t('182e [R14] the install line prints the app-code coverage next to "unchanged": "app code: NOT guarded (not a git work tree)" (R13B: not a word about app code)', rI.ok === true && /verified after the last write — unchanged/.test(lineI) && /app code: NOT guarded \(not a git work tree\)/.test(lineI));
    t('182e [R14] ...and says "no violation detected within the verified scope", never "nothing protected changed", while app code is not guarded', /no violation detected within the verified scope/.test(lineI) && !/nothing protected changed/.test(printedI));
    const repI = rI.report && rI.report.path ? fs.readFileSync(rI.report.path, 'utf8') : '';
    t('182e [R14] the change report prints the app-code coverage in its "unchanged" line, and the scope verdict', /verified after the last write: unchanged[^\n]*app code: NOT guarded \(not a git work tree\)/.test(repI) && /no violation detected within the verified scope/.test(repI));
    t('182e [R14] the receipt records summarized, the app-code guard and whether every entry was verified', !!rI.receipt && !!rI.receipt.protect && rI.receipt.protect.summarized === 0 && rI.receipt.protect.appCode === false && rI.receipt.protect.complete === false);
    const outI = path.join(freshDir('t182e-out'), 'pm.json');
    sync.writeProtectManifest(sync.buildProtectManifest(tplI, pI, { nowIso: NOW_WP2C }), outI);
    const vpI = spawnSync(process.execPath, [CLI, 'verify-protect', pI, outI], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tplI }) });
    t('182e [R14] (CLI) verify-protect: "OK — no violation detected within the verified scope" with the app-code coverage while app code is not guarded (R13B: "OK — nothing protected changed")', vpI.status === 0 && /OK — no violation detected within the verified scope/.test(vpI.stdout) && /app code: NOT guarded \(not a git work tree\)/.test(vpI.stdout) && !/nothing protected changed/.test(vpI.stdout));
    if (!PUB_GIT_OK) console.log('  SKIP 182e (git part) — git is not available here');
    else {
      const pF = projWp2c('t182e-git', { doctorExit: null });
      wfx(pF, 'src/app.js', 'console.log("app");\n');
      const gF = pubGit(pF); gF(['init', '-q']); gF(['add', '-A']); gF(['commit', '-q', '-m', 'app']);
      const outF = path.join(freshDir('t182e-git-out'), 'pm.json');
      sync.writeProtectManifest(sync.buildProtectManifest(tplI, pF, { nowIso: NOW_WP2C }), outF);
      const vpF = spawnSync(process.execPath, [CLI, 'verify-protect', pF, outF], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tplI }) });
      t('182e [R14] (CLI) a git project whose every entry was compared: "OK — nothing protected changed" with "app code: guarded through git ... unchanged" next to it', vpF.status === 0 && /OK — nothing protected changed/.test(vpF.stdout) && /app code: guarded through git[^;]*— unchanged/.test(vpF.stdout));
    }
  } finally {
    fs.readlinkSync = origReadlink;
    fs.readFileSync = origRead;
    fs.lstatSync = origLstat;
  }
});

// WP-TMP-HYGIENE: the private run folder is a direct forge-run-* child of the real temp dir, and every recorded
// fixture of this run lives inside it — so the exit handler's single removal leaves the real temp dir as it found it.
t('TMPH a: the run folder is a forge-run-* folder directly under the real temp dir', path.dirname(path.resolve(TMPH_RUN_DIR)).toLowerCase() === path.resolve(TMPH_REAL_TMPDIR).toLowerCase() && path.basename(TMPH_RUN_DIR).startsWith('forge-run-') && os.tmpdir() === TMPH_RUN_DIR);
t('TMPH b: all ' + ALL_FIXTURE_ROOTS.length + ' recorded fixtures are inside the private run folder', ALL_FIXTURE_ROOTS.length > 0 && ALL_FIXTURE_ROOTS.every((d) => { const rel = path.relative(TMPH_RUN_DIR, path.resolve(d)); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); }));
t('TMPH c: the cleanup guard refuses the real temp dir itself and any path outside it', !tmphUnderRealTmp(TMPH_REAL_TMPDIR) && !tmphUnderRealTmp(path.dirname(TMPH_REAL_TMPDIR)) && !tmphUnderRealTmp(path.join(TMPH_REAL_TMPDIR, '..', 'x')) && tmphUnderRealTmp(TMPH_RUN_DIR));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
