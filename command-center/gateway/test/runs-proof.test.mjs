// GET /api/runs (runs.mjs) used to call a run `finalized` from the receipt's STRUCTURE alone,
// while /api/proof already asked the central forge-finalize.cjs. Both now share finalize-acceptance.mjs: `finalized`
// is true only when the central acceptance says completion_proof:true, and every run with a structurally valid
// receipt carries `proof: { verdict, cause, reverified, archival, completion_proof, ... }`.
// Fixture scripts stand in for the central tool (never the real fleet). Fixtures live under COMMAND_CENTER_DATA_DIR
// because runs.mjs only admits project roots under the real scan roots.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listRuns, listRunsWithProof } from '../src/runs.mjs';
import {
  _setFinalizeCjsForTests, _resetFinalizeAcceptanceCacheForTests, _getFinalizeAcceptanceSpawnCountForTests,
  _resetCentralCheckSlotsForTests, DEFAULT_THREAT_MODEL,
} from '../src/finalize-acceptance.mjs';
import { _resetToolLogCacheForTests } from '../src/toollog.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import { removeDataDirIfCreatedByTests } from './.data-dir-guard.mjs';

// fixture checks spawn a real child; under a loaded full-suite run that can exceed the 1.2 s production budget
const WAIT = 20000;
const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-runs-proof');
function freshDir(prefix) {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  return fs.mkdtempSync(path.join(FIXTURE_PARENT, prefix));
}
beforeEach(() => {
  _resetToolLogCacheForTests();
  _resetFinalizeAcceptanceCacheForTests();
  _resetCentralCheckSlotsForTests();
});
after(() => {
  _setFinalizeCjsForTests(null);
  _resetFinalizeAcceptanceCacheForTests();
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  removeDataDirIfCreatedByTests();
});

/** a run with a structurally valid receipt over its real log bytes */
function seedFinalizedRun(root, runId) {
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), [
    { event_type: 'run_started', timestamp: '2026-09-01T10:00:00.000Z' },
    { event_type: 'check_passed', timestamp: '2026-09-01T10:30:00.000Z' },
    { event_type: 'run_completed', timestamp: '2026-09-01T11:00:00.000Z' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  writeReceipt(runDir, runId, '2026-09-01T11:05:00.000Z');
  return runDir;
}
function writeReceipt(runDir, runId, finalizedAt) {
  const buf = fs.readFileSync(path.join(runDir, 'events.jsonl'));
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    schema: 2, run_id: runId, digest: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, events: 3,
    contract: 'ok', finalized_at: finalizedAt,
  }), 'utf8');
}
/** a stand-in for the central forge-finalize.cjs: prints `body` (exit 3 unless FINALIZED); optional delay/marker */
function centralFixture(body, { delayMs = 0, marker = null } = {}) {
  const p = path.join(freshDir('central-'), 'fake-finalize.cjs');
  const out = 'process.stdout.write(' + JSON.stringify(JSON.stringify(body)) + ');process.exitCode=' + (body.verdict === 'FINALIZED' ? 0 : 3) + ';';
  fs.writeFileSync(p, (marker ? "require('fs').appendFileSync(" + JSON.stringify(marker) + ", 'x');\n" : '')
    + (delayMs ? 'setTimeout(()=>{' + out + '},' + delayMs + ');\n' : out + '\n'), 'utf8');
  return p;
}
async function rowWith(body, runId) {
  const root = freshDir('proj-');
  seedFinalizedRun(root, runId);
  _setFinalizeCjsForTests(centralFixture(body));
  const r = await listRunsWithProof(root, Date.now(), { budgetMs: WAIT });
  assert.equal(r.ok, true);
  return r.runs.find((x) => x.run_id === runId);
}

test('FINALIZED: finalized:true, status finalized, proof fields carried', async () => {
  const row = await rowWith({ verdict: 'FINALIZED', completion_proof: true, archival: false }, 'run-fin');
  assert.equal(row.finalized, true);
  assert.equal(row.status, 'finalized');
  assert.equal(row.proof.verdict, 'FINALIZED');
  assert.equal(row.proof.completion_proof, true);
  assert.equal(row.proof.archival, false);
  assert.equal(row.proof.threat_model, DEFAULT_THREAT_MODEL, 'the threat-model note is always carried');
  assert.match(row.proof.threat_model, /^Tamper-evident, not tamper-proof/);
});

test('HISTORICAL re-verified under its own rules: a completion proof (reverified:true)', async () => {
  const row = await rowWith({ verdict: 'HISTORICAL', cause: 'ruleset', reverified: true, archival: false, completion_proof: true }, 'run-rev');
  assert.equal(row.finalized, true);
  assert.equal(row.proof.reverified, true);
  assert.equal(row.proof.cause, 'ruleset');
});

test('HISTORICAL allowlisted legacy: completion proof, but archival and NOT re-verified — both facts carried', async () => {
  const row = await rowWith({ verdict: 'HISTORICAL', cause: 'legacy-receipt', reverified: false, archival: true, completion_proof: true, allowlisted: 'pre-evidence' }, 'run-legacy');
  assert.equal(row.finalized, true);
  assert.equal(row.proof.reverified, false);
  assert.equal(row.proof.archival, true);
  assert.equal(row.proof.allowlisted, 'pre-evidence');
});

test('HISTORICAL unverified-archival: never finalized, status finalize_unconfirmed (closed, not live)', async () => {
  const row = await rowWith({ verdict: 'HISTORICAL', cause: 'unverified-archival', reverified: false, archival: true, completion_proof: false }, 'run-unv');
  assert.equal(row.finalized, false);
  assert.equal(row.status, 'finalize_unconfirmed');
  assert.equal(row.proof.cause, 'unverified-archival');
  assert.equal(row.proof.completion_proof, false);
  assert.ok(row.finalize_digest, 'the structurally valid receipt is still reported');
});

test('STALE and UNDETERMINED: never finalized', async () => {
  const stale = await rowWith({ verdict: 'STALE', reason: 'evidence changed after finalization' }, 'run-stale');
  assert.equal(stale.finalized, false);
  assert.equal(stale.proof.verdict, 'STALE');
  assert.equal(stale.proof.note, 'evidence changed after finalization');
  _resetFinalizeAcceptanceCacheForTests();
  const und = await rowWith({ verdict: 'UNDETERMINED', reason: 'could not judge' }, 'run-und');
  assert.equal(und.finalized, false);
  assert.equal(und.proof.verdict, 'UNDETERMINED');
});

test('central tool missing: finalized is null (unknown), proof says why — never true', async () => {
  const root = freshDir('proj-');
  seedFinalizedRun(root, 'run-nocentral');
  _setFinalizeCjsForTests(path.join(root, 'does-not-exist.cjs'));
  const row = (await listRunsWithProof(root, Date.now(), { budgetMs: WAIT })).runs[0];
  assert.equal(row.finalized, null);
  assert.equal(row.proof.available, false);
  assert.match(row.proof.note, /forge-finalize\.cjs was not found/);
  assert.notEqual(row.status, 'finalized');
});

test('a run without a receipt has proof:null and finalized:false — and no central check is spawned', async () => {
  const root = freshDir('proj-');
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-plain');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify({ event_type: 'run_started', timestamp: '2026-09-01T10:00:00.000Z' }) + '\n', 'utf8');
  const marker = path.join(root, 'spawned.marker');
  _setFinalizeCjsForTests(centralFixture({ verdict: 'FINALIZED', completion_proof: true }, { marker }));
  const row = (await listRunsWithProof(root, Date.now(), { budgetMs: WAIT })).runs[0];
  assert.equal(row.proof, null);
  assert.equal(row.finalized, false);
  assert.equal(fs.existsSync(marker), false);
});

test('sync listRuns() never spawns: an unchecked receipt reads proof.pending, finalized null', async () => {
  const root = freshDir('proj-');
  seedFinalizedRun(root, 'run-sync');
  const marker = path.join(root, 'spawned.marker');
  _setFinalizeCjsForTests(centralFixture({ verdict: 'FINALIZED', completion_proof: true }, { marker }));
  const row = listRuns(root).runs[0];
  assert.equal(row.proof.pending, true);
  assert.equal(row.finalized, null);
  assert.equal(row.status, 'finalize_unconfirmed');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(fs.existsSync(marker), false, 'listRuns() must never start a central check');
  // once /api/runs has checked it, the sync path serves the cached answer too
  await listRunsWithProof(root, Date.now(), { budgetMs: WAIT });
  assert.equal(listRuns(root).runs[0].finalized, true);
});

test('cache: a second list does not re-spawn; a changed receipt (new mtime/size) is re-checked', async () => {
  const root = freshDir('proj-');
  const runDir = seedFinalizedRun(root, 'run-cache');
  _setFinalizeCjsForTests(centralFixture({ verdict: 'FINALIZED', completion_proof: true }));
  const s0 = _getFinalizeAcceptanceSpawnCountForTests();
  assert.equal((await listRunsWithProof(root, Date.now(), { budgetMs: WAIT })).runs[0].finalized, true);
  assert.equal(_getFinalizeAcceptanceSpawnCountForTests() - s0, 1);
  await listRunsWithProof(root, Date.now(), { budgetMs: WAIT });
  await listRunsWithProof(root, Date.now(), { budgetMs: WAIT });
  assert.equal(_getFinalizeAcceptanceSpawnCountForTests() - s0, 1, 'an unchanged receipt is served from cache');

  // the receipt is rewritten (a re-finalize): different bytes + mtime -> a fresh judgement
  _setFinalizeCjsForTests(centralFixture({ verdict: 'STALE', reason: 'changed' }));
  writeReceipt(runDir, 'run-cache', '2026-09-02T09:00:00.000Z');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(runDir, 'run-finalized.json'), later, later);
  const row = (await listRunsWithProof(root, Date.now(), { budgetMs: WAIT })).runs[0];
  assert.equal(_getFinalizeAcceptanceSpawnCountForTests() - s0, 2, 'a changed receipt is re-checked');
  assert.equal(row.finalized, false);
  assert.equal(row.proof.verdict, 'STALE');
});

test('budget: a slow central check never holds the list; the answer arrives on a later call', async () => {
  const root = freshDir('proj-');
  seedFinalizedRun(root, 'run-slow');
  _setFinalizeCjsForTests(centralFixture({ verdict: 'FINALIZED', completion_proof: true }, { delayMs: 700 }));
  const t0 = Date.now();
  const first = await listRunsWithProof(root, Date.now(), { budgetMs: 50 });
  assert.ok(Date.now() - t0 < 600, 'the list returned within its budget, not after the check');
  assert.equal(first.runs[0].proof.pending, true);
  assert.equal(first.runs[0].finalized, null);
  await new Promise((r) => setTimeout(r, 1500));
  const second = await listRunsWithProof(root, Date.now(), { budgetMs: WAIT });
  assert.equal(second.runs[0].finalized, true);
});

test('a junction run folder is never listed or judged', async (t) => {
  const root = freshDir('proj-');
  const outside = freshDir('outside-');
  seedFinalizedRun(outside, 'real-run');
  const runsDir = path.join(root, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  try {
    fs.symlinkSync(path.join(outside, '.claude', 'forge-runs', 'real-run'), path.join(runsDir, 'linked-run'), 'junction');
  } catch (err) {
    t.skip('cannot create a junction here: ' + err.code);
    return;
  }
  const marker = path.join(root, 'spawned.marker');
  _setFinalizeCjsForTests(centralFixture({ verdict: 'FINALIZED', completion_proof: true }, { marker }));
  const r = await listRunsWithProof(root, Date.now(), { budgetMs: WAIT });
  const row = r.runs.find((x) => x.run_id === 'linked-run');
  assert.ok(!row || (row.finalized !== true && row.proof === null), 'a junctioned run is never reported finalized');
  assert.equal(fs.existsSync(marker), false, 'no central check is spawned for a junctioned run');
});

test('a receipt path that is a junction is refused before it is read (works without Developer Mode)', async (t) => {
  const root = freshDir('proj-');
  const runDir = seedFinalizedRun(root, 'run-junction-receipt');
  const receipt = path.join(runDir, 'run-finalized.json');
  fs.rmSync(receipt);
  const target = freshDir('outside-');
  try {
    fs.symlinkSync(target, receipt, 'junction');
  } catch (err) {
    t.skip('cannot create a junction here: ' + err.code);
    return;
  }
  const marker = path.join(root, 'spawned.marker');
  _setFinalizeCjsForTests(centralFixture({ verdict: 'FINALIZED', completion_proof: true }, { marker }));
  const row = (await listRunsWithProof(root, Date.now(), { budgetMs: WAIT })).runs[0];
  assert.equal(row.finalized, false);
  assert.equal(row.proof, null);
  assert.match(row.finalize_invalid_reason, /link or junction/);
  assert.equal(fs.existsSync(marker), false);
});

test('a symbolic-link receipt is refused before it is read', async (t) => {
  const root = freshDir('proj-');
  const runDir = seedFinalizedRun(root, 'run-linked-receipt');
  const receipt = path.join(runDir, 'run-finalized.json');
  const realCopy = path.join(freshDir('outside-'), 'receipt.json');
  fs.renameSync(receipt, realCopy);
  try {
    fs.symlinkSync(realCopy, receipt, 'file');
  } catch (err) {
    t.skip('cannot create a file symlink here (Windows needs Developer Mode or admin): ' + err.code);
    return;
  }
  const marker = path.join(root, 'spawned.marker');
  _setFinalizeCjsForTests(centralFixture({ verdict: 'FINALIZED', completion_proof: true }, { marker }));
  const row = (await listRunsWithProof(root, Date.now(), { budgetMs: WAIT })).runs[0];
  assert.equal(row.finalized, false);
  assert.equal(row.proof, null);
  assert.match(row.finalize_invalid_reason, /link or junction/);
  assert.equal(fs.existsSync(marker), false);
});
