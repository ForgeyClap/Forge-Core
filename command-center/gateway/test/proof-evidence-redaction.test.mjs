// WP A8 (owner-queue item E): evidence served by GET /api/proof must never carry a raw credential.
// A gate's stdout+stderr lands in a check event's `output`/`evidence`; an agent-written artifact
// summary lands in the artifacts list. buildProof() now routes those free-text fields through the
// redactor at the evidence boundary itself. Isolated os.tmpdir() fixtures; the run-contract check is
// pointed at a path that does not exist, so no child process is spawned.
//
// Fixture credentials are assembled at run time so no complete credential shape sits in this file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProof, _setRunContractCjsForTests, _resetRunContractCacheForTests } from '../src/proof.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';

const NV_BODY = 'A8proofFAKE'.repeat(3);
const NV_TOKEN = 'nvapi-' + NV_BODY;
const GH_BODY = 'A8ghFAKE'.repeat(4);
const GH_TOKEN = 'ghp' + '_' + GH_BODY;

const roots = [];
function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proof-redact-'));
  roots.push(root);
  return root;
}
_setRunContractCjsForTests(path.join(os.tmpdir(), 'cc-a8-no-such-runcontract.cjs'));
after(() => {
  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

test('SECURITY (A8 item E): a credential in a check event\'s output/evidence/command never reaches the proof response', async () => {
  const root = freshRoot();
  const runId = 'run-a8-check-output';
  writeEventsFile(root, runId, [
    { event_type: 'run_started', timestamp: '2026-11-01T00:00:00.000Z' },
    {
      event_type: 'check_failed', check: 'gateway-tests', timestamp: '2026-11-01T00:00:01.000Z',
      command: 'node --test --token ' + GH_TOKEN, exit_code: 1, summary: 'failed near ' + NV_TOKEN,
      output: 'stderr: auth failed for key ' + NV_TOKEN + '\n',
      evidence: { stderr_tail: ['line', 'leaked ' + GH_TOKEN] },
    },
  ]);
  const result = await buildProof(root, runId);
  assert.equal(result.ok, true);
  const row = result.verdicts.find((v) => v.check === 'gateway-tests');
  assert.ok(row, 'the check row must be present');
  const served = JSON.stringify(result);
  assert.equal(served.includes(NV_BODY), false, 'NVIDIA key body reached the proof response');
  assert.equal(served.includes(GH_BODY), false, 'GitHub token body reached the proof response');
  assert.match(row.output, /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.equal(row.exit_code, 1, 'non-text fields stay exactly as they were');
  assert.equal(Array.isArray(row.evidence.stderr_tail), true, 'the evidence shape is preserved');
});

test('SECURITY (A8 item E): a credential in an artifact-store title/summary never reaches the proof response', async () => {
  const root = freshRoot();
  const runId = 'run-a8-artifact-summary';
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-11-01T00:00:00.000Z' }]);
  const store = path.join(root, '.claude', 'forge-artifacts');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'a8-art.json'), JSON.stringify({
    title: 'report with ' + GH_TOKEN, type: 'report', path: 'docs/report.md',
    summary: 'gate stderr said ' + NV_TOKEN, run_ref: runId,
  }), 'utf8');
  fs.writeFileSync(path.join(store, 'index.jsonl'), JSON.stringify({ id: 'a8-art', store: 'artifacts', ts: '2026-11-01T00:00:02.000Z' }) + '\n', 'utf8');

  const result = await buildProof(root, runId);
  const art = result.artifacts.find((a) => a.id === 'a8-art');
  assert.ok(art, 'the artifact that references this run must be listed');
  assert.equal(JSON.stringify(result).includes(NV_BODY), false, 'NVIDIA key body reached the proof response');
  assert.equal(JSON.stringify(result).includes(GH_BODY), false, 'GitHub token body reached the proof response');
  assert.match(art.summary, /^gate stderr said \[REDACTED:NVIDIA_API_KEY\]$/);
  assert.equal(art.path, 'docs/report.md', 'structural fields are left untouched');
});
