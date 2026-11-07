#!/usr/bin/env node
'use strict';
/**
 * forge-doctor-nodecheck-scope.test.cjs — category tests F5c. forge-sync install trusts a doctor verdict
 * only when node_check.total >= the number of .cjs files the sync wrote (forge-sync.cjs evidenceOk). The doctor listed
 * only the TOP level of forge-bin/, while 17 doctor modules live in forge-bin/doctor/ since the 2026-11-02 split. A
 * normal update writes fewer files and passed; every fresh install writes all 461 and was rolled back as "no positive
 * evidence" although all 17232 tests passed. Guard: node_check covers every .cjs and dashboard script that
 * publish-template ships, in any sub-folder. Harness: this project's own t() wrapper and the "N passed, M failed" tally.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const D = require('./forge-doctor.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nc-scope-'));
const wf = (base, rel, body) => { const p = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };

t('a .cjs in a forge-bin sub-folder is checked, and a broken one there turns node_check red', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  wf(root, '.claude/forge-bin/top.cjs', 'module.exports = 1;\n');
  wf(root, '.claude/forge-bin/doctor/mod.cjs', 'module.exports = 2;\n');
  wf(root, '.claude/forge-dashboard/log-event.cjs', 'module.exports = 3;\n');
  assert.strictEqual(D.nodeCheckAll(root).total, 3);
  wf(root, '.claude/forge-bin/doctor/broken.cjs', 'module.exports = (;\n');
  const r = D.nodeCheckAll(root);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => /broken\.cjs/.test(String(f.file || f))), JSON.stringify(r.failures));
});
t('node_modules below forge-bin is never walked', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'p-'));
  wf(root, '.claude/forge-bin/top.cjs', 'module.exports = 1;\n');
  wf(root, '.claude/forge-bin/node_modules/x/index.cjs', 'module.exports = (;\n');
  const r = D.nodeCheckAll(root);
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.ok, true);
});
t('SHIPPED tree: node_check covers every .cjs that publish-template ships (what a fresh install writes)', () => {
  const root = path.resolve(__dirname, '..', '..');
  if (!fs.existsSync(path.join(root, '.claude', 'config', 'forge-dev-tree.json'))) return; // installed project: n/a
  const S = require('./forge-sync.cjs');
  const shipped = [...S.publishSourceSet(path.join(root, '.claude')).files.keys()].filter((rel) => rel.endsWith('.cjs'));
  const fresh = fs.mkdtempSync(path.join(TMP, 'shipped-'));
  for (const rel of shipped) {
    const to = path.join(fresh, '.claude', ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, '.claude', ...rel.split('/')), to);
  }
  const r = D.nodeCheckAll(fresh);
  assert.ok(r.total >= shipped.length, 'node_check.total ' + r.total + ' < shipped .cjs ' + shipped.length);
});

t('F5d: the refusal names the real gap (node_check 444 < 461 written), not only "missing/unparsable/0-count"', () => {
  const S = require('./forge-sync.cjs');
  const parsed = { ok: true, checks: { node_check: { ok: true, total: 444 }, tests: { ok: true, suites: 229, passed: 17232 } } };
  const gap = S.evidenceGap(parsed, 461);
  assert.ok(/444/.test(gap) && /461/.test(gap), gap);
  assert.strictEqual(S.evidenceGap(parsed, 444), null);
  assert.ok(/no --json/.test(S.evidenceGap(null, 1)));
  assert.ok(/suite/.test(S.evidenceGap({ checks: { node_check: { total: 5 }, tests: { suites: 0, passed: 0 } } }, 1)));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
