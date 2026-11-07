import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../src/session-store.js';
import { SessionStore as SharedSessionStore } from '../../gateway/src/sessions/session-store.mjs';
import { tmpStateDir } from './helpers.js';

// WP A4: the bot's SessionStore is a thin adapter over the shared gateway session module.

test('session-store (A4): een bestaand sessions.json met kale session-id strings blijft werken', () => {
  const dir = tmpStateDir();
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ sessions: { conv_oud: 'sess_oud_123' } }, null, 2));
  const store = new SessionStore(dir);
  assert.equal(store.get('conv_oud'), 'sess_oud_123');
  assert.equal(store.get('onbekend'), null);
});

test('session-store (A4): de bot schrijft het gedeelde formaat, leesbaar voor de gateway-module', () => {
  const dir = tmpStateDir();
  new SessionStore(dir).set('conv_1', '060c83ff-8ef5-4722-898a-884f5157a1c2');
  const shared = new SharedSessionStore(path.join(dir, 'sessions.json'));
  const record = shared.get('conv_1');
  assert.equal(record.sessionId, '060c83ff-8ef5-4722-898a-884f5157a1c2');
  assert.equal(typeof record.createdAt, 'string');
  assert.equal(record.pendingFork, false);
});

test('session-store (A4): set zonder id of sessie doet niets, get geeft nooit een record-object terug', () => {
  const dir = tmpStateDir();
  const store = new SessionStore(dir);
  store.set('', 'sess_x');
  store.set('conv_2', null);
  assert.equal(fs.existsSync(path.join(dir, 'sessions.json')), false);
  store.set('conv_3', 'sess_abc');
  assert.equal(typeof store.get('conv_3'), 'string');
});
