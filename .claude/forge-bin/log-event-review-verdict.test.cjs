#!/usr/bin/env node
'use strict';
/**
 * log-event-review-verdict.test.cjs — category tests R3. windows-v6's Review Boss logged
 * review_completed with review_verdict "APPROVE" twice; the contract only counts pass, passed, approved, ok, akkoord,
 * goedgekeurd (a deliberately closed list), so both approvals counted for nothing and the run stayed NOT DONE. Guard:
 * the writer refuses a review_completed / codex_review_completed whose verdict READS as approval but is not on the
 * list, and names the word to use. Real approvals and every rejection (fail, changes_required, ...) pass through.
 */
const assert = require('assert');
const path = require('path');
const L = require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + ((e && e.message) || e)); } };
const ev = (o) => Object.assign({ run_id: 'r-verdict', event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-1' }, o);
const refusedVerdict = (r) => r.ok === false && /approved/.test(r.message || '') && /verdict/i.test(r.message || '');
const notRefusedForVerdict = (r) => r.ok || !/reads as an approval/.test(r.message || '');

t('the real windows-v6 event (review_verdict "APPROVE") is refused, naming "approved"', () => assert.ok(refusedVerdict(L.validateForWrite(ev({ review_verdict: 'APPROVE' })))));
for (const v of ['approve', 'LGTM', 'accepted', 'looks good']) t('"' + v + '" (approval in other words) is refused', () => assert.ok(refusedVerdict(L.validateForWrite(ev({ review_verdict: v })))));
t('the field name `verdict` is judged the same way', () => assert.ok(refusedVerdict(L.validateForWrite(ev({ verdict: 'Approve' })))));
t('codex_review_completed is judged the same way', () => assert.ok(refusedVerdict(L.validateForWrite(ev({ event_type: 'codex_review_completed', review_verdict: 'approve', codex_job_id: 'job-1', output_path: 'out.md' })))));
for (const v of ['approved', 'APPROVED', 'pass', 'passed', 'ok', 'akkoord', 'goedgekeurd']) t('"' + v + '" (on the list) is not refused for its verdict', () => assert.ok(notRefusedForVerdict(L.validateForWrite(ev({ review_verdict: v })))));
for (const v of ['CHANGES_REQUIRED', 'fail', 'rejected', 'blocked']) t('"' + v + '" (a rejection) passes the verdict guard', () => assert.ok(notRefusedForVerdict(L.validateForWrite(ev({ review_verdict: v })))));
t('a review_completed without a verdict field is not refused by this guard', () => assert.ok(notRefusedForVerdict(L.validateForWrite(ev({ summary: 'done' })))));
t('another event type with verdict "approve" is not touched', () => assert.ok(notRefusedForVerdict(L.validateForWrite(ev({ event_type: 'agent_note', note: 'x', review_verdict: 'approve' })))));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
