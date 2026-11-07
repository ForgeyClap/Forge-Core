// WP B2 part 1: SSE and NDJSON parsers (chunk boundaries, comments, CRLF split across chunks, [DONE]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser, parseSSE, parseNDJSON } from '../src/providers/stream-parse.mjs';

async function collect(iter) {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
}

async function* chunks(list) {
  for (const c of list) yield c;
}

test('SSE: comment lines are ignored, data lines join, [DONE] is reported as data', async () => {
  const text = ': OPENROUTER PROCESSING\n\ndata: {"a":1}\n\n: keepalive\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n';
  const evs = await collect(parseSSE(chunks([text])));
  assert.deepEqual(evs.map((e) => e.data), ['{"a":1}', 'line1\nline2', '[DONE]']);
});

test('SSE: every possible chunk split gives the same events (incl. \\r\\n split between chunks)', async () => {
  const text = 'event: message_start\r\ndata: {"x":"é€"}\r\n\r\nevent: ping\r\ndata: {}\r\n\r\ndata:nospace\r\rdata: last-without-blank';
  const whole = await collect(parseSSE(chunks([text])));
  assert.deepEqual(whole.map((e) => [e.event, e.data]), [['message_start', '{"x":"é€"}'], ['ping', '{}'], ['message', 'nospace'], ['message', 'last-without-blank']]);
  for (let i = 1; i < text.length; i += 1) {
    const split = await collect(parseSSE(chunks([text.slice(0, i), text.slice(i)])));
    assert.deepEqual(split, whole, 'split at ' + i);
  }
});

test('SSE: a byte-order mark at the start is dropped and the id field is kept', () => {
  const p = new SSEParser();
  const evs = [...p.push('﻿id: 7\ndata: hi\n\n'), ...p.end()];
  assert.deepEqual(evs, [{ event: 'message', data: 'hi', id: '7' }]);
});

test('SSE: one field-less line and an empty data line follow the spec', () => {
  const p = new SSEParser();
  const evs = [...p.push('data\n\ndata:\ndata: x\n\n'), ...p.end()];
  assert.deepEqual(evs.map((e) => e.data), ['', '\nx']);
});

test('NDJSON: lines split across chunks, blank lines skipped, final line without newline parsed', async () => {
  const objs = await collect(parseNDJSON(chunks(['{"status":"pul', 'ling"}\n\n{"status":"success"', '}'])));
  assert.deepEqual(objs, [{ status: 'pulling' }, { status: 'success' }]);
});

test('NDJSON: an invalid line is a BAD_RESPONSE with a short excerpt', async () => {
  await assert.rejects(() => collect(parseNDJSON(chunks(['{"ok":1}\nnot json\n']))), (e) => e.code === 'BAD_RESPONSE' && /invalid JSON line/.test(e.message));
});
