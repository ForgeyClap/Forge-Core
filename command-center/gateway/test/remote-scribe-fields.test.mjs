// Remote Bridge inbox fields defer_reason and done_evidence (
// WP-BRIDGE-CONTEXT F3). Expected strings are hand-written from contract 4.4, not recomputed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicScribeItem, SCRIBE_TEXT_MAX } from '../src/remote/scribe.mjs';

const RUN = 'forge-2026-11-09-063358';
const base = { rid: 'R-0018', class: 'new', title: 'T', quote: 'Q', created: 'c', updated: 'u' };

test('done_evidence: a short summary of each evidence type, run id included when recorded', () => {
  assert.equal(publicScribeItem({ ...base, status: 'done', evidence: { type: 'wp_completed', ref: 'WP-X', run_id: RUN, event_id: 'e-1' } }).done_evidence,
    'wp_completed WP-X (run forge-2026-11-09-063358)');
  assert.equal(publicScribeItem({ ...base, status: 'done', evidence: { type: 'commit', ref: 'abc1234' } }).done_evidence, 'commit abc1234');
  assert.equal(publicScribeItem({ ...base, status: 'done', evidence: { type: 'check_passed', ref: 'chk-7', run_id: RUN } }).done_evidence,
    'check_passed chk-7 (run forge-2026-11-09-063358)');
  assert.equal(publicScribeItem({ ...base, status: 'done', evidence: { type: 'standing_rule', ref: 'SR-3' } }).done_evidence, 'standing_rule SR-3');
});

test('done_evidence: null without evidence, on a non-done item, or for a malformed evidence value', () => {
  assert.equal(publicScribeItem({ ...base, status: 'done', evidence: null }).done_evidence, null);
  assert.equal(publicScribeItem({ ...base, status: 'done' }).done_evidence, null);
  assert.equal(publicScribeItem({ ...base, status: 'done', evidence: 'commit abc' }).done_evidence, null);
  assert.equal(publicScribeItem({ ...base, status: 'done', evidence: { type: 'commit' } }).done_evidence, null);
  assert.equal(publicScribeItem({ ...base, status: 'open', evidence: { type: 'commit', ref: 'abc1234' } }).done_evidence, null);
});

test('done_evidence: no absolute path leaves the PC and the summary is capped at 160 characters', () => {
  const win = publicScribeItem({ ...base, status: 'done', evidence: { type: 'check_passed', ref: 'C:\\Users\\YOU\\secret\\report.json' } }).done_evidence;
  assert.equal(win, 'check_passed report.json');
  const nix = publicScribeItem({ ...base, status: 'done', evidence: { type: 'check_passed', ref: '/home/owner/x/out.log' } }).done_evidence;
  assert.equal(nix, 'check_passed out.log');
  const long = publicScribeItem({ ...base, status: 'done', evidence: { type: 'check_passed', ref: 'x'.repeat(400) } }).done_evidence;
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
});

test('defer_reason: the recorded reason for defer-proposed and deferred items only', () => {
  assert.equal(publicScribeItem({ ...base, status: 'defer-proposed', reason: 'needs the Stripe key from the owner' }).defer_reason,
    'needs the Stripe key from the owner');
  assert.equal(publicScribeItem({ ...base, status: 'deferred', reason: 'next sprint' }).defer_reason, 'next sprint');
  assert.equal(publicScribeItem({ ...base, status: 'open', reason: 'reopened: test was red' }).defer_reason, null);
  assert.equal(publicScribeItem({ ...base, status: 'defer-proposed' }).defer_reason, null);
  assert.equal(publicScribeItem({ ...base, status: 'defer-proposed', reason: { text: 'x' } }).defer_reason, null);
  assert.equal(publicScribeItem({ ...base, status: 'defer-proposed', reason: '   ' }).defer_reason, null);
});

test('defer_reason: absolute paths are cut to their file name and the text is capped', () => {
  assert.equal(publicScribeItem({ ...base, status: 'defer-proposed', reason: 'blocked by C:\\Users\\YOU\\proj\\build.log failing' }).defer_reason,
    'blocked by build.log failing');
  const long = publicScribeItem({ ...base, status: 'defer-proposed', reason: 'y'.repeat(900) }).defer_reason;
  assert.equal(long.length, SCRIBE_TEXT_MAX);
  assert.ok(long.endsWith('…'));
});

test('defer_reason: a URL or a word with a colon is not mistaken for a drive path', () => {
  assert.equal(publicScribeItem({ ...base, status: 'defer-proposed', reason: 'see https://example.com/a/b for it' }).defer_reason,
    'see https://example.com/a/b for it');
  assert.equal(publicScribeItem({ ...base, status: 'defer-proposed', reason: 'note:/tmp is fine, D:\\x\\y.txt is not' }).defer_reason,
    'note:/tmp is fine, y.txt is not');
});

test('the phone still gets only the documented fields', () => {
  const out = publicScribeItem({ ...base, status: 'done', pid: 'P-1', wp_ids: ['WP-X'], evidence: { type: 'commit', ref: 'abc1234' }, reason: 'r' });
  assert.deepEqual(Object.keys(out).sort(),
    ['actions', 'class', 'created', 'defer_reason', 'done_evidence', 'quote', 'rid', 'status', 'title', 'updated'].sort());
});
