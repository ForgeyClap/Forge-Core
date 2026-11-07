#!/usr/bin/env node
'use strict';
/**
 * forge-sync-reuse-baseline.test.cjs — category tests F11. Right after a fresh install, the next update with
 * --reuse-pre-baseline said "system files changed since the last sync (manifest hash differs)" and ran the doctor twice.
 * Root cause: the manifest was hashed over the system-file list of the CURRENT template, so a file that is new (or gone)
 * in the newer template changed the hash although no file in the project changed. The receipt now records the file set
 * its hash covers (postSyncManifestRels) and the reuse check re-hashes exactly that set; a newer-template file that
 * already exists in the project still blocks reuse.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const S = require('./forge-sync.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reuse-baseline-'));
const FP = { gitHead: 'h1', gitStatusHash: 's1' };
const DOCTOR = '#!/usr/bin/env node\nif (process.argv.indexOf("--json") !== -1) console.log(JSON.stringify({ ok: true, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 } } }));\nprocess.exit(0);\n';
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
function fixture() {
  const tpl = fs.mkdtempSync(path.join(TMP, 'tpl-'));
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'forge-doctor.cjs'), DOCTOR);
  const p = fs.mkdtempSync(path.join(TMP, 'proj-'));
  fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(p, 'CLAUDE.md'), '# demo\n');
  const r = quiet(() => S.safeSyncProject(tpl, p, { batchId: 'b1', nowIso: '2026-11-07T04:41:00.000Z', workspaceFingerprintImpl: () => FP }));
  assert.strictEqual(r.ok, true, 'fixture install failed: ' + (r.reason || ''));
  return { tpl, p };
}
const decide = (tpl, p) => { const rc = S.readReceipt(p); return S.decidePreBaseline(rc, S.preBaselineManifestHash(tpl, p, rc), FP, Date.parse('2026-11-07T05:03:00.000Z'), S.settingsSnapshot(p, false)); };

t('the receipt records the file set its post-sync manifest hash covers', () => {
  const { p } = fixture();
  const rc = S.readReceipt(p);
  assert.deepStrictEqual(rc.postSyncManifestRels, ['forge-bin/a.cjs', 'forge-bin/b.cjs', 'forge-bin/forge-doctor.cjs']);
});
t('install, then decidePreBaseline on the untouched result -> reuse:true (same template)', () => {
  const { tpl, p } = fixture();
  const d = decide(tpl, p);
  assert.strictEqual(d.reuse, true, d.reason);
});
t('install, then a NEWER template that gained a file -> the untouched project still reuses (the F11 bug)', () => {
  const { tpl, p } = fixture();
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'c-new.cjs'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'module.exports = 11;\n');
  const d = decide(tpl, p);
  assert.strictEqual(d.reuse, true, d.reason);
});
t('a newer template that dropped a file -> the untouched project still reuses', () => {
  const { tpl, p } = fixture();
  fs.unlinkSync(path.join(tpl, 'forge-bin', 'b.cjs'));
  const d = decide(tpl, p);
  assert.strictEqual(d.reuse, true, d.reason);
});
t('the end-to-end update with --reuse-pre-baseline runs the doctor once (baseline REUSED)', () => {
  const { tpl, p } = fixture();
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'c-new.cjs'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'module.exports = 11;\n');
  const r = quiet(() => S.safeSyncProject(tpl, p, { batchId: 'b2', nowIso: '2026-11-07T05:03:00.000Z', reusePreBaseline: true, workspaceFingerprintImpl: () => FP }));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.baselineSource.mode, 'reused', JSON.stringify(r.baselineSource));
});
t('a system file changed in the project -> no reuse', () => {
  const { tpl, p } = fixture();
  fs.appendFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), '// edited\n');
  const d = decide(tpl, p);
  assert.strictEqual(d.reuse, false);
  assert.ok(/manifest hash differs/.test(d.reason), d.reason);
});
t('a file the newer template dropped, edited in the project after the install -> no reuse', () => {
  const { tpl, p } = fixture();
  fs.unlinkSync(path.join(tpl, 'forge-bin', 'b.cjs'));
  fs.appendFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), '// edited\n');
  assert.strictEqual(decide(tpl, p).reuse, false);
});
t('a file new in the template that already exists in the project (the doctor never saw it) -> no reuse', () => {
  const { tpl, p } = fixture();
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'c-new.cjs'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'c-new.cjs'), 'module.exports = 99;\n');
  assert.strictEqual(decide(tpl, p).reuse, false);
});
t('a receipt without postSyncManifestRels (older forge-sync) is judged over the current template list, as before', () => {
  const { tpl, p } = fixture();
  const rc = S.readReceipt(p); delete rc.postSyncManifestRels; S.writeReceipt(p, rc);
  assert.strictEqual(decide(tpl, p).reuse, true);
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'c-new.cjs'), 'module.exports = 3;\n');
  assert.strictEqual(decide(tpl, p).reuse, false);
});
t('a receipt whose recorded file set is malformed (an unsafe path) is never reused', () => {
  const { tpl, p } = fixture();
  const rc = S.readReceipt(p); rc.postSyncManifestRels = ['../outside.txt']; S.writeReceipt(p, rc);
  assert.strictEqual(decide(tpl, p).reuse, false);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
