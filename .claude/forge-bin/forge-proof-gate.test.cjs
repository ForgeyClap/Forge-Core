#!/usr/bin/env node
'use strict';
/** forge-proof-gate.test.cjs - direct proof that forge-proof-gate.cjs loads, behaves per contract, equals the
 *  parents' inline fallback, and is really consulted by forge-verify.cjs / forge-runcontract.cjs (their own
 *  suites stay green on the fallback even if this module fails to load). */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE = path.join(__dirname, 'forge-proof-gate.cjs');
let passed = 0, failed = 0;
const t = (name, cond) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
};

// (1) loads + exports
let pg = null;
try { pg = require(GATE); } catch (e) { console.log('load error: ' + e.message); }
t('module loads', !!pg);
pg = pg || {};
t('exports isDisprovenEvent function', typeof pg.isDisprovenEvent === 'function');
t('exports reviewOutcome function', typeof pg.reviewOutcome === 'function');
t('exports REVIEW_OUTCOME_FIELDS (5 fields)', Array.isArray(pg.REVIEW_OUTCOME_FIELDS) && pg.REVIEW_OUTCOME_FIELDS.length === 5);
t('exports POSITIVE_REVIEW_VERDICTS set', pg.POSITIVE_REVIEW_VERDICTS instanceof Set && pg.POSITIVE_REVIEW_VERDICTS.has('pass'));

// (2) fixtures: [name, input, expected reviewOutcome, expected isDisproven]
const fixtures = [
  ['pass textual', { review_verdict: 'PASS' }, 'done', false],
  ['pass ok:true only', { ok: true }, 'done', false],
  ['fail textual', { verdict: 'fail' }, 'failed', false],
  ['mixed pass verdict + ok:false', { verdict: 'approved', ok: false }, 'failed', false],
  ['mixed one positive one negative field', { status: 'pass', result: 'rejected' }, 'failed', false],
  ['empty object', {}, null, false],
  ['empty verdict string', { verdict: '  ' }, 'failed', false],
  ['malformed null', null, null, false],
  ['malformed string', 'pass', null, false],
  ['malformed array-ish number', 42, null, false],
  ['unknown outcome', { outcome: 'banana' }, 'failed', false],
  ['disproven stamp beats pass', { verdict: 'pass', ok: true, _forge_verify: { proof_verified: false } }, 'failed', true],
  ['proof_verified true stays pass', { verdict: 'pass', _forge_verify: { proof_verified: true } }, 'done', false],
];
for (const [name, input, exp, disp] of fixtures) {
  t('reviewOutcome: ' + name, pg.reviewOutcome && pg.reviewOutcome(input) === exp);
  t('isDisprovenEvent: ' + name, pg.isDisprovenEvent && pg.isDisprovenEvent(input) === disp);
}

// (2b) parent inline fallback, extracted from forge-verify.cjs source, must equal the module
const src = fs.readFileSync(path.join(__dirname, 'forge-verify.cjs'), 'utf8');
const start = src.indexOf('// inline fallback');
const endMarker = "return 'done';";
const end = start === -1 ? -1 : src.indexOf(endMarker, start);
t('fallback block locatable in forge-verify.cjs', start !== -1 && end !== -1);
if (start !== -1 && end !== -1) {
  const body = src.slice(src.indexOf('\n', start), end + endMarker.length);
  const isDisprovenEvent = (e) => !!(e && typeof e === 'object' && e._forge_verify && e._forge_verify.proof_verified === false);
  let fb = null;
  try { fb = new Function('isDisprovenEvent', 'e', body); } catch (e) { fb = null; }
  t('fallback block compiles', typeof fb === 'function');
  if (fb) {
    for (const [name, input] of fixtures) {
      t('fallback equals module: ' + name, fb(isDisprovenEvent, input) === pg.reviewOutcome(input));
    }
  }
}

// (3) parents really use the module: fresh child process that never requires the gate itself
const child = `
const path = require('path');
const gate = ${JSON.stringify(GATE)};
const dir = ${JSON.stringify(__dirname)};
const v = require(path.join(dir, 'forge-verify.cjs'));
const before = Object.keys(require.cache).includes(gate);
const out = { before, verify: v.reviewOutcome({ verdict: 'pass' }) };
out.afterVerify = Object.keys(require.cache).includes(gate);
for (const k of Object.keys(require.cache)) if (k === gate) delete require.cache[k];
const rc = require(path.join(dir, 'forge-runcontract.cjs'));
out.rc = rc.eventIsDisproven({ _forge_verify: { proof_verified: false } });
out.rcHas = rc.hasEvent([{ event_type: 'x', _forge_verify: { proof_verified: false } }], 'x');
out.afterRc = Object.keys(require.cache).includes(gate);
console.log(JSON.stringify(out));
`;
const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 60000 });
let o = null;
try { o = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (e) { o = null; }
t('child process ran', r.status === 0 && !!o);
if (o) {
  t('parent verify: gate not preloaded', o.before === false);
  t('forge-verify reviewOutcome result correct', o.verify === 'done');
  t('forge-verify loaded forge-proof-gate.cjs (in require.cache)', o.afterVerify === true);
  t('forge-runcontract eventIsDisproven correct', o.rc === true && o.rcHas === false);
  t('forge-runcontract loaded forge-proof-gate.cjs (in require.cache)', o.afterRc === true);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
