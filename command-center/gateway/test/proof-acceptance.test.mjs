// /api/proof derived `finalized` from "a structurally valid
// receipt exists" and never carried reverified / archival / completion_proof. buildProof() now reads the
// AUTHORITATIVE acceptance result — the central forge-finalize.cjs `check --json` — and `finalized` is true only
// when that result says completion_proof:true. Fixture scripts stand in for the central tool (never the real
// fleet); one test runs the REAL central forge-finalize.cjs against a temp project to prove it never executes
// that project's own log-event.cjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildProof, _setFinalizeCjsForTests, _resetFinalizeAcceptanceCacheForTests,
  _setRunContractCjsForTests, _resetRunContractCacheForTests,
} from '../src/proof.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';

const tempRoots = [];
function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proof-acceptance-'));
  tempRoots.push(root);
  return root;
}
after(() => {
  _setFinalizeCjsForTests(null);
  _resetFinalizeAcceptanceCacheForTests();
  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});

// a run-contract fixture so no test here spawns the real central forge-runcontract.cjs
const contractFixture = path.join(freshRoot(), 'fake-runcontract.cjs');
fs.writeFileSync(contractFixture, "process.stdout.write(JSON.stringify({ ok: true, missing: [], satisfied: [], warnings: [], overridden: [] }));\n", 'utf8');

/** a structurally valid receipt over the run's real log bytes (passes the gateway's own receipt validator) */
function seedRunWithReceipt(root, runId) {
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-09-01T10:00:00.000Z' }, { event_type: 'run_completed', timestamp: '2026-09-01T11:00:00.000Z' }]);
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  const buf = fs.readFileSync(path.join(runDir, 'events.jsonl'));
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    schema: 2, run_id: runId, digest: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, events: 2,
    contract: 'ok', domain: null, ruleset_sha256: 'e'.repeat(64), evidence_digest: 'b'.repeat(64), code_commit: 'a'.repeat(40),
    independent_verification: { available: false, label_only: true }, finalized_at: '2026-09-01T11:05:00.000Z',
  }), 'utf8');
  return runDir;
}
/** a stand-in for the central forge-finalize.cjs: prints `body` as JSON and exits with `code` (3 = not FINALIZED) */
function finalizeFixture(body, code, markerPath) {
  const p = path.join(freshRoot(), 'fake-finalize.cjs');
  fs.writeFileSync(p, (markerPath ? "require('fs').writeFileSync(" + JSON.stringify(markerPath) + ", 'spawned');\n" : '')
    + 'process.stdout.write(' + JSON.stringify(JSON.stringify(body)) + ');\nprocess.exitCode = ' + Number(code || 0) + ';\n', 'utf8');
  return p;
}
async function proofWith(fixture, root, runId) {
  _setRunContractCjsForTests(contractFixture);
  _resetRunContractCacheForTests();
  _setFinalizeCjsForTests(fixture);
  _resetFinalizeAcceptanceCacheForTests();
  try { return await buildProof(root, runId); }
  finally { _setFinalizeCjsForTests(null); _resetFinalizeAcceptanceCacheForTests(); }
}

test('N06: an unverified-archival HISTORICAL receipt is NOT finalized, and reverified/archival/completion_proof/cause are propagated', async () => {
  const root = freshRoot();
  seedRunWithReceipt(root, 'run-archival');
  const fx = finalizeFixture({ verdict: 'HISTORICAL', cause: 'unverified-archival', reverified: false, archival: true, completion_proof: false, reason: 'pinned ruleset absent' }, 3);
  const r = await proofWith(fx, root, 'run-archival');
  assert.equal(r.ok, true);
  assert.equal(r.finalized, false, 'a receipt that is not a completion proof must never read as finalized');
  assert.ok(r.finalize_receipt, 'the receipt itself is still reported (it exists and is structurally valid)');
  assert.equal(r.finalize_acceptance.available, true);
  assert.equal(r.finalize_acceptance.verdict, 'HISTORICAL');
  assert.equal(r.finalize_acceptance.cause, 'unverified-archival');
  assert.equal(r.finalize_acceptance.reverified, false);
  assert.equal(r.finalize_acceptance.archival, true);
  assert.equal(r.finalize_acceptance.completion_proof, false);
  assert.equal(r.finalize_receipt.completion_proof, false, 'the receipt view carries the same answer');
  assert.equal(r.finalize_receipt.archival, true);
});

test('N06: FINALIZED (completion_proof true) reads finalized:true', async () => {
  const root = freshRoot();
  seedRunWithReceipt(root, 'run-finalized');
  const r = await proofWith(finalizeFixture({ verdict: 'FINALIZED', completion_proof: true, archival: false }, 0), root, 'run-finalized');
  assert.equal(r.finalized, true);
  assert.equal(r.finalize_acceptance.verdict, 'FINALIZED');
  assert.equal(r.finalize_acceptance.completion_proof, true);
});

test('N06: a re-verified HISTORICAL record is a completion proof (finalized:true, reverified:true carried)', async () => {
  const root = freshRoot();
  seedRunWithReceipt(root, 'run-reverified');
  const r = await proofWith(finalizeFixture({ verdict: 'HISTORICAL', cause: 'ruleset', reverified: true, archival: false, completion_proof: true }, 3), root, 'run-reverified');
  assert.equal(r.finalized, true);
  assert.equal(r.finalize_acceptance.reverified, true);
  assert.equal(r.finalize_acceptance.cause, 'ruleset');
});

test('N06: an older central finalize without completion_proof on HISTORICAL never reads as finalized', async () => {
  const root = freshRoot();
  seedRunWithReceipt(root, 'run-old-checker');
  const r = await proofWith(finalizeFixture({ verdict: 'HISTORICAL', cause: 'legacy-receipt', reverified: false }, 3), root, 'run-old-checker');
  assert.equal(r.finalized, false);
  assert.equal(r.finalize_acceptance.completion_proof, false);
  assert.equal(r.finalize_acceptance.archival, true);
});

test('N06: a STALE verdict is never finalized', async () => {
  const root = freshRoot();
  seedRunWithReceipt(root, 'run-stale');
  const r = await proofWith(finalizeFixture({ verdict: 'STALE', reason: 'evidence changed after finalization' }, 3), root, 'run-stale');
  assert.equal(r.finalized, false);
  assert.equal(r.finalize_acceptance.verdict, 'STALE');
});

test('N06: when the central finalize cannot run, finalized is false and the reason is said', async () => {
  const root = freshRoot();
  seedRunWithReceipt(root, 'run-no-checker');
  const r = await proofWith(path.join(root, 'does-not-exist.cjs'), root, 'run-no-checker');
  assert.equal(r.finalized, false);
  assert.equal(r.finalize_acceptance.available, false);
  assert.match(r.finalize_acceptance.note, /forge-finalize\.cjs was not found/);
});

test('N06: a structurally invalid receipt never reaches the acceptance spawn', async () => {
  const root = freshRoot();
  writeEventsFile(root, 'run-invalid', [{ event_type: 'run_started', timestamp: '2026-09-01T10:00:00.000Z' }]);
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', 'run-invalid', 'run-finalized.json'), '{}', 'utf8');
  const marker = path.join(root, 'acceptance-spawned.marker');
  const r = await proofWith(finalizeFixture({ verdict: 'FINALIZED', completion_proof: true }, 0, marker), root, 'run-invalid');
  assert.equal(r.finalized, false);
  assert.equal(r.finalize_acceptance, null);
  assert.equal(fs.existsSync(marker), false, 'no acceptance check is spawned for a receipt the validator already refused');
});

test('N06: the REAL central forge-finalize.cjs judges the receipt and never executes the selected project\'s own log-event.cjs', async () => {
  const root = freshRoot();
  seedRunWithReceipt(root, 'run-real-central');
  // a hostile project-local writer: it would leave a marker if anything require()d it
  const marker = path.join(root, 'project-writer-executed.marker');
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'executed');\nmodule.exports = { readEventsClassified: () => ({ status: 'valid', entries: [], badLines: [] }) };\n", 'utf8');
  _setRunContractCjsForTests(contractFixture);
  _resetRunContractCacheForTests();
  _setFinalizeCjsForTests(null);
  _resetFinalizeAcceptanceCacheForTests();
  const r = await buildProof(root, 'run-real-central');
  assert.equal(r.finalize_acceptance.available, true, JSON.stringify(r.finalize_acceptance));
  assert.notEqual(r.finalize_acceptance.verdict, 'FINALIZED', 'a fabricated receipt over a log that does not end on run_finalized is not current');
  assert.equal(r.finalized, false);
  assert.equal(fs.existsSync(marker), false, 'the central finalize must classify with its OWN log-event.cjs, never the judged project\'s');
});
