// WP B3-conv: PATCH /api/conversations/:id (rename) and POST /api/conversations/:id/fork.
// The handlers are mounted on a real ephemeral-port http server the same way server.mjs dispatches
// them (A11 module shape: handler(req, res, { pathname, searchParams, match })). The token test runs
// against the REAL gateway listener: until the Lead registers the two routes there, a token-less
// PATCH stops at the method guard (405); once registered it must stop at the token check (403).
// Either way the handler never runs and the title stays unchanged.
// No `claude` process is ever started in this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as conversations from '../src/routes/conversations.mjs';
import { createServer, describeRoutes } from '../src/server.mjs';
import {
  createConversation,
  readConversation,
  listConversations,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import { appendUserTurn } from '../src/conversation-turns.mjs';
import { gatewaySessionStore, readConversationSession } from '../src/sessions/gateway-sessions.mjs';
import { sessionOptionsForConversation, sessionArgv } from '../src/sessions/argv-session.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const { CONV_ITEM_RE, CONV_FORK_RE } = conversations;
const PROJECT = 'b3-conv-project';
const SOURCE_SESSION = 'a1b2c3d4-e5f6-4711-9abc-def012345678';
const PROJECT_CWD = path.join(os.tmpdir(), 'b3-conv-project-cwd');

// Mounted exactly like the route table would: first match on (method, path) wins.
const MOUNTED = [
  ['GET', CONV_ITEM_RE, 'read'],
  ['PATCH', CONV_ITEM_RE, 'rename'],
  ['POST', CONV_FORK_RE, 'fork'],
];

let tempDir;
let mounted;
let mountedPort;
let real;
let realPort;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-b3-conv-test-'));
  _setConversationsDirForTests(tempDir);
  mounted = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    for (const [method, re, handler] of MOUNTED) {
      const match = req.method === method ? pathname.match(re) : null;
      if (match) {
        conversations[handler](req, res, { pathname, searchParams: new URLSearchParams(), match }).catch((err) => {
          res.writeHead(500); res.end(String(err && err.message));
        });
        return;
      }
    }
    res.writeHead(404); res.end('{}');
  });
  mountedPort = await listen(mounted);
  real = createServer();
  realPort = await listen(real);
});

after(async () => {
  await new Promise((resolve) => mounted.close(resolve));
  await new Promise((resolve) => real.close(resolve));
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function newConversation(title = 'Plan de site') {
  return createConversation({ project: PROJECT, title });
}

function giveSession(convId) {
  return gatewaySessionStore().set(convId, { sessionId: SOURCE_SESSION, model: 'sonnet', cwd: PROJECT_CWD, title: 'Plan de site' });
}

function patchTitle(convId, jsonBody, opts = {}) {
  return requestWithBody(mountedPort, '/api/conversations/' + convId, { method: 'PATCH', jsonBody, ...opts });
}

function postFork(convId, jsonBody) {
  return requestWithBody(mountedPort, '/api/conversations/' + convId + '/fork', { method: 'POST', jsonBody });
}

// ---------- rename ----------

test('rename: a trimmed title is stored, read and list return it, and the transcript keeps its history', async () => {
  const conv = newConversation('Oude naam');
  const file = path.join(tempDir, conv.id + '.jsonl');
  const linesBefore = fs.readFileSync(file, 'utf8').trim().split('\n');

  const res = await patchTitle(conv.id, { title: '  Nieuwe naam  ' });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json, { ok: true, conversation: { id: conv.id, project: PROJECT, title: 'Nieuwe naam' } });

  assert.equal(readConversation(conv.id).meta.title, 'Nieuwe naam');
  assert.equal(listConversations().find((c) => c.id === conv.id).title, 'Nieuwe naam');
  const viaHttp = await request(mountedPort, '/api/conversations/' + conv.id);
  assert.equal(viaHttp.json.meta.title, 'Nieuwe naam');

  const linesAfter = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(linesAfter.slice(0, linesBefore.length), linesBefore, 'earlier lines are never rewritten');
  const patch = JSON.parse(linesAfter[linesAfter.length - 1]);
  assert.equal(patch.type, 'meta_patch');
  assert.equal(patch.title, 'Nieuwe naam');
  assert.equal(JSON.parse(linesAfter[0]).title, 'Oude naam', 'the original meta line keeps the old title');
});

test('rename: a pasted secret in the title is redacted before it is stored', async () => {
  const conv = newConversation();
  const secret = 'sk-' + 'ant-api03-' + 'B'.repeat(40);
  const res = await patchTitle(conv.id, { title: 'key ' + secret });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!res.json.conversation.title.includes(secret));
  assert.ok(!fs.readFileSync(path.join(tempDir, conv.id + '.jsonl'), 'utf8').includes(secret));
});

test('rename: bad titles answer 400 and leave the title unchanged', async () => {
  const conv = newConversation('Blijft zo');
  const bad = [
    {},
    { title: '' },
    { title: '   ' },
    { title: 42 },
    { title: null },
    { title: 'a'.repeat(121) },
    { title: 'regel een\nregel twee' },
    { title: 'tab\there' },
    { title: 'ok', extra: true },
  ];
  for (const body of bad) {
    const res = await patchTitle(conv.id, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body) + ' -> ' + res.body);
    assert.equal(res.json.ok, false);
  }
  const notJson = await requestWithBody(mountedPort, '/api/conversations/' + conv.id, { method: 'PATCH', rawBody: '{nope' });
  assert.equal(notJson.statusCode, 400);
  assert.equal(readConversation(conv.id).meta.title, 'Blijft zo');

  const exactMax = await patchTitle(conv.id, { title: 'é'.repeat(120) });
  assert.equal(exactMax.statusCode, 200, '120 characters is the inclusive limit');
});

test('rename: an unknown id answers 404, a malformed id 400', async () => {
  const unknown = await patchTitle('c-doesnotexist-0000', { title: 'x' });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json.error, 'conversation not found');
  const malformed = await patchTitle('bad%20id', { title: 'x' });
  assert.equal(malformed.statusCode, 400);
});

test('rename on the real gateway without the exec token never reaches the handler (403 once registered)', async () => {
  const conv = newConversation('Zonder token');
  const registered = describeRoutes().some((r) => r.method === 'PATCH' && r.path === CONV_ITEM_RE.source);
  const res = await requestWithBody(realPort, '/api/conversations/' + conv.id, { method: 'PATCH', jsonBody: { title: 'Gekaapt' }, omitExecToken: true });
  assert.equal(res.statusCode, registered ? 403 : 405, res.body);
  assert.equal(readConversation(conv.id).meta.title, 'Zonder token');
});

// ---------- fork ----------

test('fork: a new conversation in the same project, "(kopie)" title, pendingFork with the source session', async () => {
  const source = newConversation('Plan de site');
  giveSession(source.id);
  // Review note (B3-conv): the source must HAVE a transcript, otherwise "never copied" proves nothing.
  appendUserTurn(source.id, 'eerste vraag');
  assert.equal(readConversation(source.id).turns.length, 1, 'precondition: the source has one turn');
  const sourceFile = path.join(tempDir, source.id + '.jsonl');
  const sourceBytes = fs.readFileSync(sourceFile, 'utf8');

  const res = await postFork(source.id);
  assert.equal(res.statusCode, 201, res.body);
  const fork = res.json.conversation;
  assert.equal(res.json.ok, true);
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.project, PROJECT);
  assert.equal(fork.title, 'Plan de site (kopie)');
  assert.equal(fork.forked_from, source.id);
  assert.equal(fork.session_id, SOURCE_SESSION);
  assert.equal(fork.fork_pending, true);

  const record = readConversationSession(fork.id);
  assert.equal(record.sessionId, SOURCE_SESSION);
  assert.equal(record.pendingFork, true);
  assert.equal(readConversationSession(source.id).pendingFork, false, 'the source session is untouched');

  const stored = readConversation(fork.id);
  assert.equal(stored.meta.forked_from, source.id);
  assert.equal(stored.turns.length, 0, 'the transcript is never copied');
  const forkLines = fs.readFileSync(path.join(tempDir, fork.id + '.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(forkLines.length, 1, 'the fork file holds exactly the meta line, no copied turns or events');
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), sourceBytes, 'the source file is not written');
});

test('fork: the first turn of the fork runs --resume <sessionId> --fork-session', async () => {
  const source = newConversation('Argv check');
  giveSession(source.id);
  const res = await postFork(source.id);
  assert.equal(res.statusCode, 201, res.body);
  const record = readConversationSession(res.json.conversation.id);
  const opts = sessionOptionsForConversation(record, { cwd: PROJECT_CWD });
  assert.deepEqual(opts, { resumeSessionId: SOURCE_SESSION, fork: true });
  const argv = sessionArgv(opts);
  assert.deepEqual(argv, ['--resume', SOURCE_SESSION, '--fork-session']);
});

test('fork: a body title wins, and a long source title is shortened so "(kopie)" still fits', async () => {
  const source = newConversation('x'.repeat(120));
  giveSession(source.id);
  const auto = await postFork(source.id);
  assert.equal(auto.statusCode, 201, auto.body);
  assert.equal([...auto.json.conversation.title].length, 120);
  assert.ok(auto.json.conversation.title.endsWith(' (kopie)'));

  const named = await postFork(source.id, { title: '  Eigen naam ' });
  assert.equal(named.statusCode, 201, named.body);
  assert.equal(named.json.conversation.title, 'Eigen naam');

  const badTitle = await postFork(source.id, { title: 'a\u0000b' });
  assert.equal(badTitle.statusCode, 400);
});

test('fork without a session answers 409 no_session and creates nothing', async () => {
  const source = newConversation('Nog nooit gedraaid');
  const before = listConversations().length;
  const res = await postFork(source.id);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error, 'no_session');
  assert.equal(listConversations().length, before);
});

test('fork of an unknown id answers 404', async () => {
  const res = await postFork('c-doesnotexist-0000');
  assert.equal(res.statusCode, 404);
});
