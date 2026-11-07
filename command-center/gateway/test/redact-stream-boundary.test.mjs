// WP A8 (owner-queue item D): a secret that arrives split over two
// stream chunks must never come out readable. createStreamRedactor() (redact.mjs, used for the Discord
// bot log) held back only 256 chars, which is shorter than a private key: measured before the fix, a PEM
// written in two halves came out with its armour line and body intact. createCappedRedactedCapture() is
// the bounded capture exec-lifecycle.mjs now uses for a child's stderr instead of an unbounded raw buffer.
//
// Fixtures are assembled at run time (prefix + filler) so no complete credential shape sits in this file
// for a leak scanner to report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamRedactor, createCappedRedactedCapture } from '../src/redact.mjs';

const PEM_TAIL = 'PRIVATE KEY-----';
const PEM_HEAD_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_BODY_CHUNK = 'MIIEow';
function fakePem(bodyRepeats = 600) {
  return '-----BEGIN RSA ' + PEM_TAIL + '\n' + PEM_BODY_CHUNK.repeat(bodyRepeats) + '\n-----END RSA ' + PEM_TAIL;
}
const NV_TOKEN = 'nvapi-' + 'A8splitFAKE'.repeat(4);
const GH_TOKEN = 'ghp' + '_' + 'A8splitFAKE'.repeat(3);

function runStream(chunks, { abort = false } = {}) {
  let out = '';
  const redactor = createStreamRedactor((text) => { out += text; });
  for (const c of chunks) redactor.write(c);
  if (abort) redactor.abort(); else redactor.end();
  return out;
}

function splitAt(text, ...cuts) {
  const parts = [];
  let prev = 0;
  for (const c of cuts) { parts.push(text.slice(prev, c)); prev = c; }
  parts.push(text.slice(prev));
  return parts;
}

test('SECURITY (item D): a private key split across two write() calls never comes out readable', () => {
  const whole = 'boot line\n' + fakePem() + '\nafter the key\n';
  for (const cut of [20, 500, 2000, whole.length - 40]) {
    const out = runStream(splitAt(whole, cut));
    assert.doesNotMatch(out, PEM_HEAD_RE, 'armour line leaked at cut ' + cut);
    assert.equal(out.includes(PEM_BODY_CHUNK), false, 'key body leaked at cut ' + cut);
    assert.match(out, /\[REDACTED:PEM_PRIVATE_KEY\]/);
    assert.match(out, /^boot line\n/);
    assert.match(out, /after the key\n$/, 'text after the key must still arrive');
  }
});

test('SECURITY (item D): a private key fed in many small chunks never comes out readable', () => {
  const whole = 'x'.repeat(300) + fakePem() + 'tail';
  const chunks = [];
  for (let i = 0; i < whole.length; i += 97) chunks.push(whole.slice(i, i + 97));
  const out = runStream(chunks);
  assert.doesNotMatch(out, PEM_HEAD_RE);
  assert.equal(out.includes(PEM_BODY_CHUNK), false);
  assert.match(out, /\[REDACTED:PEM_PRIVATE_KEY\]tail$/);
});

test('a single-line token split across two write() calls is redacted whole (nvapi and ghp shapes)', () => {
  for (const token of [NV_TOKEN, GH_TOKEN]) {
    for (const offset of [3, 8, 15, token.length - 2]) {
      const out = runStream(['x'.repeat(1000) + ' ' + token.slice(0, offset), token.slice(offset) + ' done\n']);
      assert.equal(out.includes('A8splitFAKE'), false, 'token body leaked at offset ' + offset);
      assert.match(out, /\[REDACTED:/);
      assert.match(out, / done\n$/);
    }
  }
});

test('the open-key hold is bounded: a BEGIN marker whose body runs past the pattern bound is released (memory never grows unbounded)', () => {
  let emitted = '';
  const redactor = createStreamRedactor((text) => { emitted += text; });
  redactor.write('-----BEGIN RSA ' + PEM_TAIL + '\n');
  for (let i = 0; i < 40; i++) redactor.write('Z'.repeat(1000)); // 40,000 chars, no END ever arrives
  // The pattern can never match a body longer than 8192 chars, so holding it longer protects nothing:
  // most of the text must already have been released before end().
  assert.ok(emitted.length > 30000, 'held back ' + (40000 - emitted.length) + ' chars; expected the hold to be released');
});

test('abort(): a stream CUT inside a private key drops the open key instead of emitting its head', () => {
  const pem = fakePem();
  const out = runStream(['clean prefix\n', pem.slice(0, 1500)], { abort: true });
  assert.doesNotMatch(out, PEM_HEAD_RE);
  assert.equal(out.includes(PEM_BODY_CHUNK), false);
  assert.match(out, /^clean prefix\n/);
});

test('abort(): a stream CUT inside a short token head drops the fragment (end() would have emitted it)', () => {
  const head = 'nvapi-' + 'A8cut'; // fewer than ten chars after the prefix: no pattern matches it on its own
  assert.equal(runStream(['line\n' + head]).includes('A8cut'), true, 'baseline: end() emits an unmatched fragment as-is');
  const out = runStream(['line\n' + head], { abort: true });
  assert.equal(out.includes('A8cut'), false);
  assert.match(out, /^line\n/);
});

test('capture: keeps only the first maxChars redacted chars and reports a split token redacted', () => {
  const capture = createCappedRedactedCapture({ maxChars: 120, maxInputChars: 100000 });
  capture.write('err: ' + NV_TOKEN.slice(0, 10));
  capture.write(NV_TOKEN.slice(10) + '\n' + 'y'.repeat(5000));
  const out = capture.finish();
  assert.equal(out.length, 120);
  assert.equal(out.includes('A8splitFAKE'), false);
  assert.match(out, /^err: \[REDACTED:NVIDIA_API_KEY\]\ny+$/);
  assert.equal(capture.finish(), out, 'finish() is stable when asked twice');
});

test('capture: input past maxInputChars is not read, and a key cut by that limit is dropped, not leaked', () => {
  const capture = createCappedRedactedCapture({ maxChars: 4000, maxInputChars: 2000 });
  capture.write('ok\n' + fakePem()); // the limit falls inside the key body
  capture.write('this arrives after the limit\n');
  const out = capture.finish();
  assert.doesNotMatch(out, PEM_HEAD_RE);
  assert.equal(out.includes(PEM_BODY_CHUNK), false);
  assert.equal(out.includes('after the limit'), false, 'nothing past the input limit is kept');
  assert.match(out, /^ok\n/);
});

test('capture: a token held across the input limit is still redacted (the held tail never comes out raw)', () => {
  const capture = createCappedRedactedCapture({ maxChars: 4000, maxInputChars: 3000 });
  capture.write('start ' + 'sk-' + 'A8giant'.repeat(1000)); // one token far longer than the input limit
  const out = capture.finish();
  assert.equal(out.includes('A8giant'), false);
  assert.match(out, /^start /);
});

test('capture: empty input gives an empty string (same as the old unbounded path for a silent child)', () => {
  const capture = createCappedRedactedCapture({ maxChars: 4000, maxInputChars: 1000 });
  assert.equal(capture.finish(), '');
});
