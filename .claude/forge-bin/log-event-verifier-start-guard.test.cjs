#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// log-event-verifier-start-guard.test.cjs — SD-LEDGER.
//
// REPEATED MISTAKE: a verifier-class agent start was logged UNKEYED (no wp_id) and NOT in the review-dispatch shape
// (forge-runcontract.cjs isReviewDispatch). First, then again in run
// (agent "verify-boss", task "verify publish guard", really a cross-reference to an agent of
// another run). The contract then reports "unresolved attribution" for EVERY later verdict of that agent in the run.
// The old guard only warned. Under STRICT (the default) the writer now REFUSES that shape (exit 2, nothing written);
// FORGE_STRICT_EVENTS=0 keeps the warning. A KEYED verifier start keeps the warning (it affects one package only).
// Hermetic: the CLI cases run a sandbox copy of the writer in a temp project root; the in-process cases only call
// validateForWrite(), which writes nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function withStrict(value, fn) {
  const before = process.env.FORGE_STRICT_EVENTS;
  if (value === undefined) delete process.env.FORGE_STRICT_EVENTS; else process.env.FORGE_STRICT_EVENTS = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.FORGE_STRICT_EVENTS; else process.env.FORGE_STRICT_EVENTS = before; }
}

const LE = require('../forge-dashboard/log-event.cjs');

// The literal shape of the repeat (the verify-boss agent_started line).
function repeatShape(extra) {
  return Object.assign({ run_id: 'sd-ledger-unit-test-not-a-real-run', event_type: 'agent_started', agent: 'verify-boss',
    dispatch_id: 'toolu_sdledger', task: 'verify publish guard', workflow: 'wf_test', note: 'logged late; running' }, extra);
}
const REVIEW_SHAPE = { role: 'verify', task: 'independent verification of the work package', verifies_wp: 'SD-X' };

function assertNamesThreeShapes(msg) {
  assert.ok(/wp_id/.test(msg), 'shape (a) wp_id missing: ' + msg);
  assert.ok(/role:"verify"/.test(msg) && /verifies_wp/.test(msg), 'shape (b) review shape missing: ' + msg);
  assert.ok(/agent_note/.test(msg), 'shape (c) agent_note missing: ' + msg);
  assert.ok(/unprovabl|not provabl/i.test(msg), 'the why (unprovable independence) missing: ' + msg);
  assert.ok(/onbewijsbaar|niet te bewijzen/i.test(msg), 'the Dutch half missing: ' + msg);
}

console.log('log-event verifier-start guard tests (SD-LEDGER)');

console.log('\n1) in-process validateForWrite()');
t('the repeat shape is REFUSED under strict (default), exit 2', () => withStrict(undefined, () => {
  const val = LE.validateForWrite(repeatShape());
  assert.strictEqual(val.ok, false, JSON.stringify(val));
  assert.strictEqual(val.exitCode, 2);
  assert.ok(/REFUSED agent_started/.test(val.message), val.message);
}));
t('the refusal text names all three correct shapes, the why, EN and NL', () => withStrict(undefined, () => {
  const val = LE.validateForWrite(repeatShape());
  assert.strictEqual(val.ok, false);
  assertNamesThreeShapes(val.message);
}));
t('the repeat shape is ACCEPTED with the warning under FORGE_STRICT_EVENTS=0', () => withStrict('0', () => {
  const val = LE.validateForWrite(repeatShape());
  assert.strictEqual(val.ok, true, JSON.stringify(val));
  assert.strictEqual(val.verify && val.verify.verifier_dispatch_counts_as_work, true, JSON.stringify(val.verify));
}));
t('the review shape (no wp_id, role verify, review-only task, verifies_wp) is accepted with no warning', () => withStrict(undefined, () => {
  const val = LE.validateForWrite(repeatShape(REVIEW_SHAPE));
  assert.strictEqual(val.ok, true, JSON.stringify(val));
  assert.ok(!val.verify || !val.verify.verifier_dispatch_counts_as_work, JSON.stringify(val.verify));
}));
t('a KEYED verify-boss start is accepted with the warning (one package only, can be legitimate work)', () => withStrict(undefined, () => {
  const val = LE.validateForWrite(repeatShape({ wp_id: 'SD-X' }));
  assert.strictEqual(val.ok, true, JSON.stringify(val));
  assert.strictEqual(val.verify && val.verify.verifier_dispatch_counts_as_work, true, JSON.stringify(val.verify));
}));
t('an unkeyed build-boss start is accepted (not a verifier)', () => withStrict(undefined, () => {
  const val = LE.validateForWrite(repeatShape({ agent: 'build-boss', task: 'implement the publish guard' }));
  assert.strictEqual(val.ok, true, JSON.stringify(val));
  assert.ok(!val.verify || !val.verify.verifier_dispatch_counts_as_work, JSON.stringify(val.verify));
}));
t('an unkeyed non-review review-boss start is refused', () => withStrict(undefined, () => {
  const val = LE.validateForWrite(repeatShape({ agent: 'review-boss', task: 'audit the publish guard' }));
  assert.strictEqual(val.ok, false, JSON.stringify(val));
  assert.strictEqual(val.exitCode, 2);
  assertNamesThreeShapes(val.message);
}));

// LEAD-E1: Verify Boss or Review Boss as the dispatched WORKER of a read-only audit
// package is legitimate; a package that declares role "auditor" or route "research" no longer warns. A keyed start
// with role "verify" or "reviewer" still warns: that is the shape of a verifier closing a build package it works on.
for (const extra of [{ role: 'auditor' }, { role: 'Audit' }, { route: 'research' }]) {
  t('a keyed verifier-class start of an audit package (' + JSON.stringify(extra) + ') does not warn', () => withStrict(undefined, () => {
    const val = LE.validateForWrite(repeatShape(Object.assign({ wp_id: 'AUD-1', agent: 'review-boss', task: 'read-only audit of the event writer' }, extra)));
    assert.strictEqual(val.ok, true, JSON.stringify(val));
    assert.ok(!val.verify || !val.verify.verifier_dispatch_counts_as_work, JSON.stringify(val.verify));
  }));
}
for (const role of ['verify', 'reviewer']) {
  t('a keyed verifier-class start with role "' + role + '" still warns (self-close of a build package)', () => withStrict(undefined, () => {
    const val = LE.validateForWrite(repeatShape({ wp_id: 'SD-X', role }));
    assert.strictEqual(val.ok, true, JSON.stringify(val));
    assert.strictEqual(val.verify && val.verify.verifier_dispatch_counts_as_work, true, JSON.stringify(val.verify));
  }));
}
t('an UNKEYED non-review start with role "auditor" is still refused under strict', () => withStrict(undefined, () => {
  const val = LE.validateForWrite(repeatShape({ role: 'auditor' }));
  assert.strictEqual(val.ok, false, JSON.stringify(val));
}));

console.log('\n2) end to end through a sandbox CLI (temp project root, never the real repo runs)');
{
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'logev-verifguard-'));
  try {
    for (const d of ['forge-dashboard', 'forge-bin', 'agents', path.join('config', 'agents')]) fs.mkdirSync(path.join(SB, '.claude', d), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(SB, '.claude', 'forge-dashboard', 'log-event.cjs'));
    fs.copyFileSync(path.join(__dirname, 'forge-runcontract.cjs'), path.join(SB, '.claude', 'forge-bin', 'forge-runcontract.cjs'));
    fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(SB, '.claude', 'config', 'agents', 'agent-registry.json'));
    for (const a of ['verify-boss.md', 'review-boss.md']) {
      const src = path.join(__dirname, '..', 'agents', a);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB, '.claude', 'agents', a));
    }
    const LOGEVT = path.join(SB, '.claude', 'forge-dashboard', 'log-event.cjs');
    const RUN_ID = 'sd-ledger-cli-test';
    const eventsFile = path.join(SB, '.claude', 'forge-runs', RUN_ID, 'events.jsonl');
    const env = (strict) => { const e = Object.assign({}, process.env, { FORGE_AUTO_ACTIVE_RUN: 'off' }); if (strict === undefined) delete e.FORGE_STRICT_EVENTS; else e.FORGE_STRICT_EVENTS = strict; return e; };
    const run = (payload, strict) => spawnSync(process.execPath, [LOGEVT, RUN_ID, 'agent_started', JSON.stringify(payload)], { encoding: 'utf8', cwd: SB, env: env(strict) });
    const snapshot = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : null);
    const base = { agent: 'verify-boss', dispatch_id: 'toolu_sdcli', task: 'verify publish guard', workflow: 'wf_test', note: 'logged late; running' };

    // seed one ordinary line so "unchanged" is a real comparison, not "file never existed"
    const seed = run({ agent: 'build-boss', dispatch_id: 'toolu_seed', task: 'implement the publish guard' });
    t('CLI seed line (unkeyed build-boss) is written, exit 0', () => assert.strictEqual(seed.status, 0, seed.stdout + seed.stderr));

    t('CLI strict: the repeat shape exits 2 and the events file is unchanged', () => {
      const before = snapshot();
      const r = run(base);
      assert.strictEqual(r.status, 2, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
      assert.strictEqual(snapshot(), before, 'the events file changed on a refusal');
      assertNamesThreeShapes(r.stderr + r.stdout);
    });
    t('CLI FORGE_STRICT_EVENTS=0: the repeat shape exits 0 with the WARNING and the stamp lands', () => {
      const r = run(base, '0');
      assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
      assert.ok(/WARNING/.test(r.stderr), r.stderr);
      const lines = snapshot().split(/\r?\n/).filter((s) => s.trim());
      const last = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(last._forge_verify && last._forge_verify.verifier_dispatch_counts_as_work, true, JSON.stringify(last._forge_verify));
    });
    t('CLI strict: the review shape exits 0 with no WARNING', () => {
      const r = run(Object.assign({}, base, REVIEW_SHAPE, { dispatch_id: 'toolu_sdcli2' }));
      assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
      assert.ok(!/WARNING — this agent_started starts a verifier-class/.test(r.stderr), r.stderr);
    });
    t('CLI strict: a keyed verify-boss start exits 0 with the WARNING', () => {
      const r = run(Object.assign({}, base, { wp_id: 'SD-X', dispatch_id: 'toolu_sdcli3' }));
      assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
      assert.ok(/WARNING — this agent_started starts a verifier-class/.test(r.stderr), r.stderr);
    });
    t('CLI strict batch: a batch holding the repeat shape is refused as a whole, nothing written', () => {
      const before = snapshot();
      const batch = [
        { run_id: RUN_ID, event_type: 'agent_progress', agent: 'build-boss', note: 'fine' },
        Object.assign({ run_id: RUN_ID, event_type: 'agent_started' }, base, { dispatch_id: 'toolu_sdbatch' }),
      ].map((e) => JSON.stringify(e)).join('\n') + '\n';
      const r = spawnSync(process.execPath, [LOGEVT, '--batch', RUN_ID], { encoding: 'utf8', cwd: SB, env: env(undefined), input: batch });
      assert.notStrictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
      assert.strictEqual(snapshot(), before, 'the events file changed on a refused batch');
    });
  } finally {
    fs.rmSync(SB, { recursive: true, force: true });
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
