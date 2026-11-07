// App router P1 (design section 4.6): the context handover built from a conversation's own stored
// turns when the target changes. Turn cap, char cap, truncation marker, failed attempts left out,
// role alternation, the codex fold and num_ctx sizing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHandover,
  handoverCharCap,
  toProviderMessages,
  toCodexPrompt,
  toPromptPrefix,
  OLDER_OMITTED_MARKER,
} from '../src/app-router/replay.mjs';

const user = (n, text = 'vraag ' + n) => ({ type: 'turn', role: 'user', turn_id: 't' + n, request_id: 'r' + n, text });
const reply = (n, text = 'antwoord ' + n, extra = {}) => ({ type: 'turn', role: 'assistant', turn_id: 't' + n, request_id: 'r' + n, text, error: null, ...extra });
function pairs(count) {
  const out = [{ type: 'meta', id: 'c-1' }];
  for (let i = 1; i <= count; i += 1) out.push(user(i), reply(i));
  return out;
}

test('marker text is the design literal', () => {
  assert.equal(OLDER_OMITTED_MARKER, '(oudere berichten weggelaten)');
});

test('empty conversation: nothing to hand over', () => {
  const h = buildHandover([], {});
  assert.deepEqual(h, { turns: 0, chars: 0, truncated: false, history: [], text: '' });
  assert.equal(buildHandover(null).turns, 0);
});

test('keeps user and final assistant texts in order; non-turn records are ignored', () => {
  const h = buildHandover([...pairs(2), { type: 'event', kind: 'x', data: {} }], { maxTurns: 12 });
  assert.equal(h.turns, 4);
  assert.equal(h.truncated, false);
  assert.deepEqual(h.history, [
    { role: 'user', content: 'vraag 1' },
    { role: 'assistant', content: 'antwoord 1' },
    { role: 'user', content: 'vraag 2' },
    { role: 'assistant', content: 'antwoord 2' },
  ]);
  assert.ok(h.text.includes('vraag 1') && h.text.includes('antwoord 2'));
  assert.equal(h.chars, h.text.length);
  assert.ok(!h.text.includes(OLDER_OMITTED_MARKER));
});

test('turn cap keeps the newest messages and adds the marker', () => {
  const h = buildHandover(pairs(15), { maxTurns: 12 });
  assert.equal(h.turns, 12);
  assert.equal(h.truncated, true);
  assert.equal(h.history[0].content, 'vraag 10');
  assert.equal(h.history[11].content, 'antwoord 15');
  assert.ok(h.text.includes(OLDER_OMITTED_MARKER));
});

test('the current turn (excludeTurnId) is not part of the history', () => {
  const recs = [...pairs(2), user(3, 'de nieuwe vraag')];
  const h = buildHandover(recs, { excludeTurnId: 't3' });
  assert.equal(h.history.at(-1).content, 'antwoord 2');
  assert.ok(!h.text.includes('de nieuwe vraag'));
});

test('char cap: text stays within maxChars, newest kept, marker shown', () => {
  const big = [];
  for (let i = 1; i <= 10; i += 1) big.push(user(i, 'u' + i + ' ' + 'x'.repeat(900)), reply(i, 'a' + i + ' ' + 'y'.repeat(900)));
  const h = buildHandover(big, { maxTurns: 40, maxChars: 5000 });
  assert.ok(h.text.length <= 5000, 'text ' + h.text.length);
  assert.equal(h.chars, h.text.length);
  assert.equal(h.truncated, true);
  assert.ok(h.history.at(-1).content.startsWith('a10 '));
  assert.ok(h.text.includes(OLDER_OMITTED_MARKER));
});

test('a single newest message larger than the cap is cut, never dropped whole', () => {
  const h = buildHandover([user(1, 'z'.repeat(20000))], { maxChars: 3000 });
  assert.equal(h.turns, 1);
  assert.ok(h.text.length <= 3000);
  assert.equal(h.truncated, true);
  assert.ok(h.history[0].content.startsWith('zzz'));
});

test('failed and superseded attempts are left out', () => {
  const recs = [
    user(1),
    reply(1, 'kapot', { error: 'the model reported is_error:true' }),
    user(2),
    reply(2, 'half antwoord', { route: { target_id: 'main', outcome: 'rate_limited', retried: true } }),
    reply(2, 'goed antwoord', { route: { target_id: 'werk', outcome: 'ok', retried: false } }),
    user(6),
    reply(6, 'enige poging, opnieuw verstuurd', { route: { target_id: 'main', retried: true } }),
    user(5),
    reply(5, 'vervangen poging', { route: { target_id: 'main', retried: true } }),
    reply(5, 'tweede poging'),
    user(3),
    reply(3, 'gestopt', { route: { target_id: 'werk', outcome: 'stopped', retried: false } }),
    user(4),
    reply(4, ''),
  ];
  const h = buildHandover(recs, {});
  const all = h.history.map((m) => m.content).join('|');
  assert.ok(!all.includes('kapot'));
  assert.ok(!all.includes('half antwoord'));
  assert.ok(!all.includes('gestopt'));
  assert.ok(all.includes('goed antwoord'));
  assert.ok(!all.includes('vervangen poging'), 'a superseded attempt (retried) is left out even without an outcome');
  assert.ok(all.includes('tweede poging'));
  assert.ok(!all.includes('enige poging'), 'a retried attempt with no stored second attempt is still left out');
});

test('role alternation: user messages without a kept reply are merged', () => {
  const recs = [user(1), reply(1, 'x', { error: 'boom' }), user(2), reply(2)];
  const h = buildHandover(recs, {});
  assert.deepEqual(h.history.map((m) => m.role), ['user', 'assistant']);
  assert.equal(h.history[0].content, 'vraag 1\n\nvraag 2');
});

test('stored text is redacted again on the way out (defence in depth)', () => {
  const secret = 'sk' + '-' + 'Q'.repeat(30);
  const h = buildHandover([user(1, 'mijn sleutel ' + secret)], {});
  assert.ok(!h.text.includes(secret));
  assert.ok(h.text.includes('[REDACTED:'));
});

test('num_ctx sizing: about 3 chars per token at a 60 % share; CLI targets get 24,000', () => {
  assert.equal(handoverCharCap({ kind: 'claude-account' }), 24000);
  assert.equal(handoverCharCap({ kind: 'codex-account' }), 24000);
  assert.equal(handoverCharCap({ kind: 'provider-model', numCtx: 8192 }), Math.floor(8192 * 3 * 0.6));
  assert.equal(handoverCharCap({ kind: 'provider-model', numCtx: 131072 }), 24000, 'never above the CLI cap');
  assert.equal(handoverCharCap({ kind: 'provider-model', numCtx: null }), Math.floor(8192 * 3 * 0.6), 'unset uses the 8192 default');
  const big = [];
  for (let i = 1; i <= 40; i += 1) big.push(user(i, 'x'.repeat(1000)), reply(i, 'y'.repeat(1000)));
  const h = buildHandover(big, { maxTurns: 40, kind: 'provider-model', numCtx: 2048 });
  assert.ok(h.text.length <= Math.floor(2048 * 3 * 0.6));
});

test('provider messages: system note, alternating history, the new user message last', () => {
  const h = buildHandover(pairs(2), {});
  const msgs = toProviderMessages(h, 'nieuwe vraag');
  assert.equal(msgs[0].role, 'system');
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(msgs.at(-1).content, 'nieuwe vraag');
  for (let i = 2; i < msgs.length; i += 1) assert.notEqual(msgs[i].role, msgs[i - 1].role);
});

test('provider messages: a history that ends on a user message merges with the new one', () => {
  const h = buildHandover([user(1), reply(1, 'x', { error: 'boom' })], {});
  const msgs = toProviderMessages(h, 'nieuw');
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ['user']);
  assert.equal(msgs.at(-1).content, 'vraag 1\n\nnieuw');
});

test('provider messages without a handover: system note + the user message', () => {
  const msgs = toProviderMessages(null, 'hallo');
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user']);
});

test('codex fold: one single message with the history first and the new text last', () => {
  const h = buildHandover(pairs(1), {});
  const p = toCodexPrompt(h, 'nieuwe vraag');
  assert.equal(typeof p, 'string');
  assert.ok(p.indexOf('vraag 1') < p.indexOf('nieuwe vraag'));
  assert.ok(p.endsWith('nieuwe vraag'));
  assert.equal(toCodexPrompt(null, 'alleen dit'), 'alleen dit');
});

test('prompt prefix fallback is capped at 6,000 chars of context', () => {
  const big = [];
  for (let i = 1; i <= 20; i += 1) big.push(user(i, 'x'.repeat(1000)), reply(i, 'y'.repeat(1000)));
  const h = buildHandover(big, { maxTurns: 40 });
  const p = toPromptPrefix(h, 'de vraag');
  assert.ok(p.endsWith('de vraag'));
  assert.ok(p.length <= 6000 + 'de vraag'.length + 4, 'length ' + p.length);
  assert.equal(toPromptPrefix(null, 'kaal'), 'kaal');
});
