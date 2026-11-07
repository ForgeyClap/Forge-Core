// WP B3 (error catalogue): every fixture line/text in test/fixtures/stream-json/manifest.json is
// classified into the expected contract code (_scratch/b3/contract-permissions.md section 3), and
// exec-stream-parse.mjs emits the {type:"forge_error"} record without changing anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CODES,
  classifyErrorText,
  classifyStreamLine,
  classifyExit,
  gatewayRestartedError,
  toForgeErrorEvent,
} from '../src/error-catalogue.mjs';
import { extractForgeErrorFromParsedLine } from '../src/exec-stream-parse.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-json');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
const PAYLOAD_KEYS = ['code', 'resume_at', 'model', 'attempt', 'max_attempts', 'details'].sort();

function linesOf(file) {
  return fs.readFileSync(path.join(FIXTURES, file), 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('the code list is exactly the nine contract codes', () => {
  assert.deepEqual([...ERROR_CODES], ['cli_missing', 'logged_out', 'rate_limited', 'offline', 'api_retry', 'ollama_down', 'model_not_pulled', 'gateway_restarted', 'unknown']);
});

for (const entry of manifest.files) {
  test('fixture ' + entry.file + ' (' + entry.source + ') classifies line by line', () => {
    const lines = linesOf(entry.file);
    assert.equal(lines.length, entry.expect.length, 'one expectation per line');
    lines.forEach((line, i) => {
      const got = classifyStreamLine(line);
      if (entry.expect[i] === null) {
        assert.equal(got, null, entry.file + ' line ' + (i + 1) + ' is not an error');
      } else {
        assert.equal(got.code, entry.expect[i], entry.file + ' line ' + (i + 1));
        assert.deepEqual(Object.keys(got).sort(), PAYLOAD_KEYS, 'exactly the ChatErrorPayload fields');
      }
    });
  });
}

for (const entry of manifest.texts) {
  test('text (' + entry.source + ') -> ' + entry.expect + ': ' + entry.text.slice(0, 50), () => {
    assert.equal(classifyErrorText(entry.text).code, entry.expect);
  });
}

test('api_retry carries attempt / max_attempts from the recorded line', () => {
  const [first] = linesOf('api-retry-overloaded.jsonl');
  const got = classifyStreamLine(first);
  assert.equal(got.attempt, 1);
  assert.equal(got.max_attempts, 10);
  assert.match(got.details, /529 overloaded/);
});

test('rate_limited: resume_at comes from resetsAt (epoch seconds -> ISO), never invented', () => {
  const [rejected] = linesOf('rate-limit-rejected.jsonl');
  assert.equal(classifyStreamLine(rejected).resume_at, new Date(1785286800 * 1000).toISOString());
  assert.equal(classifyErrorText('Claude AI usage limit reached|1785355200').resume_at, new Date(1785355200 * 1000).toISOString());
  assert.equal(classifyErrorText('You\'ve hit your usage limit').resume_at, null, 'no time reported = no time shown');
});

test('a recorded "allowed" line with overageStatus "rejected" is NOT a limit error (no false alarm)', () => {
  const [, overage] = linesOf('rate-limit-allowed.jsonl');
  assert.equal(overage.rate_limit_info.overageStatus, 'rejected');
  assert.equal(classifyStreamLine(overage), null);
});

test('model_not_pulled names the model', () => {
  assert.equal(classifyErrorText('Error: model "qwen3:8b" not found, try pulling it first').model, 'qwen3:8b');
});

test('details are redacted and capped; a secret never leaves the catalogue', () => {
  const secret = 'sk-ant-api03-' + 'Z'.repeat(80);
  const got = classifyErrorText('Invalid API key ' + secret + ' ' + 'x'.repeat(2000));
  assert.equal(got.code, 'logged_out');
  assert.equal(got.details.includes(secret), false);
  assert.ok(got.details.length <= 600);
});

test('classifyExit: clean exit -> null; spawn ENOENT -> cli_missing; non-zero with stderr -> classified; bare non-zero -> unknown', () => {
  assert.equal(classifyExit({ exitCode: 0, stderr: '' }), null);
  assert.equal(classifyExit({ spawnError: 'spawn claude ENOENT' }).code, 'cli_missing');
  assert.equal(classifyExit({ spawnError: 'spawn C:\\x\\y.exe ENOENT' }).code, 'cli_missing');
  assert.equal(classifyExit({ exitCode: 1, stderr: 'Error: getaddrinfo EAI_AGAIN api.anthropic.com' }).code, 'offline');
  assert.deepEqual(classifyExit({ exitCode: 3 }), { code: 'unknown', resume_at: null, model: null, attempt: null, max_attempts: null, details: 'exit code 3' });
});

test('gateway_restarted and the forge_error record shape', () => {
  const ev = toForgeErrorEvent(gatewayRestartedError('gateway drain'), 'gateway');
  assert.equal(ev.type, 'forge_error');
  assert.equal(ev.code, 'gateway_restarted');
  assert.equal(ev.source, 'gateway');
  assert.equal(toForgeErrorEvent({ code: 'not_a_code' }), null);
});

test('hostile input never throws', () => {
  for (const v of [null, undefined, 42, {}, [], { type: 'result', is_error: true, result: 7 }, { type: 'rate_limit_event', rate_limit_info: 'x' }]) {
    assert.doesNotThrow(() => classifyStreamLine(v));
    assert.doesNotThrow(() => classifyErrorText(v));
  }
});

test('exec-stream-parse: extractForgeErrorFromParsedLine emits {type:"forge_error"} for error lines only and does not mutate the line', () => {
  const [retry] = linesOf('api-retry-overloaded.jsonl');
  const before = JSON.stringify(retry);
  const ev = extractForgeErrorFromParsedLine(retry);
  assert.equal(ev.type, 'forge_error');
  assert.equal(ev.code, 'api_retry');
  assert.equal(ev.source, 'stream');
  assert.equal(JSON.stringify(retry), before, 'the raw line is untouched');
  const ok = linesOf('result-errors.jsonl').at(-1);
  assert.equal(extractForgeErrorFromParsedLine(ok), null);
  assert.equal(extractForgeErrorFromParsedLine({ type: 'assistant', message: { content: [] } }), null);
});
