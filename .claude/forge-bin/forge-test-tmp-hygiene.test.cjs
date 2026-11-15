#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: the OS temp folder held 74,265 entries, most of them fixtures our own test files made with
// fs.mkdtempSync(os.tmpdir()) and never removed. This guard runs the worst leakers as child processes with TMP, TEMP and
// TMPDIR pointed at a fresh empty folder, and fails, naming the leftovers, when that folder is not empty afterwards.
// A suite that does not exit 0 fails too: an early crash leaves nothing behind and would pass for the wrong reason.
const nodeTest = require('node:test');
let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
nodeTest.after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// The suites behind the biggest name prefixes measured on 2026-11-15 (prefix in the comment).
const SUITES = [
  'forge-config.test.cjs', // forge-config-*
  'forge-standing.test.cjs', // forge-standing-fixture-*
  'forge-certify.test.cjs', // forge-certify-test-*
  'forge-ownergrant.test.cjs', // ownergrant-*
  'forge-toolhook.test.cjs', // forge-toolhook-*
  'forge-snapshot-reinject.test.cjs', // reinj-*
  'forge-snapshot.test.cjs', // snap-*
  'forge-actiongate.test.cjs', // actiongate-*
  'forge-skill-harvest-flow.test.cjs', // skharv-*
  'forge-skill-harvest-fast.test.cjs', // skharv-fast-*
  'forge-config-once.test.cjs', // forge-config-once(-store)-*
  'forge-evidence.test.cjs', // forge-evidence-cfg-*
  'forge-runcontract.test.cjs', // forge-runcontract-artifact-*
  'forge-export.test.cjs', // forge-export-*
  'forge-global-drift.test.cjs', // fgd-*
  'forge-release-sync.test.cjs', // frs-*
  'usage-guard-override.test.cjs', // guard-override-*
  'forge-settings-merge.test.cjs', // settings-merge-codex-v08-*
  'forge-echo.test.cjs', // echo-config-*
  'forge-prefs.test.cjs', // prefs-bad-*
  'forge-usage-report.test.cjs', // usage-home-*
];
const ONLY = process.env.FORGE_TMP_HYGIENE_ONLY ? process.env.FORGE_TMP_HYGIENE_ONLY.split(',') : null;
const PARALLEL = 4;
const SUITE_TIMEOUT_MS = 900000;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tmp-hygiene-'));
nodeTest.after(() => { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); });

function runSuite(file) {
  const tmp = fs.mkdtempSync(path.join(base, path.basename(file, '.test.cjs') + '-'));
  const env = { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT; // under `node --test` the child would report to us instead of exiting on its own tally
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], { env, cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    const keep = (b) => { tail = (tail + b.toString()).slice(-2000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill(); }, SUITE_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ file, tmp, code: -1, tail: 'spawn failed: ' + e.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ file, tmp, code: signal ? signal : code, tail }); });
  });
}

const results = new Map();
nodeTest.before(async () => {
  const queue = SUITES.filter((f) => !ONLY || ONLY.includes(f));
  const workers = Array.from({ length: PARALLEL }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) results.set(f, await runSuite(f));
  });
  await Promise.all(workers);
});

for (const file of SUITES) {
  if (ONLY && !ONLY.includes(file)) continue;
  test(file + ' leaves its temp folder empty', () => {
    const r = results.get(file);
    assert.ok(r, file + ' did not run');
    assert.strictEqual(r.code, 0, file + ' exited ' + r.code + ' with TMP pointed at ' + r.tmp + ':\n' + r.tail);
    const left = fs.readdirSync(r.tmp);
    assert.deepStrictEqual(left, [], file + ' left ' + left.length + ' temp entr(y/ies): ' + left.slice(0, 15).join(', ') + (left.length > 15 ? ', +' + (left.length - 15) : ''));
  });
}
