// Remote Bridge: the phone's scribe ack and answer texts, judged by the REAL scribe (run
// WP-ACK-FIX). Regression for WP-ACK-PROOF: the bridge sent "ack R-0003",
// the scribe classifier refused it ("not an affirmative ack (classifier reads it as unclassified)"),
// the item stayed done and a stray unclassified item was created.
// The text under test is what a real bridge request stored as the conversation's user turn (the exact
// prompt the turn's Claude session gets). The judge is the gateway's own central scribe in
// <PROJECT_ROOT>/.claude/forge-bin, not a copy: the UserPromptSubmit hook's runPrompt (capture), then
// transition ... --prompt P-n (owner check: hook origin, transcript match, affirmative act through
// forge-scribe-classify.cjs authorizes(), freshness). It runs against a throwaway project with a temp
// transcript folder (the scribe's library seam claudeProjectsRoot). Mock execution only (CC_EXEC_MOCK=1).
// Nothing is written into a real project, its scribe store or ~/.claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../src/paths.mjs';
import * as bridge from '../src/remote/bridge-server.mjs';
import { createPairing } from '../src/remote/pairing.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, readConversation } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { isTurnBusy } from '../src/app-router/turn-router.mjs';

const require = createRequire(import.meta.url);
const BIN = path.join(PROJECT_ROOT, '.claude', 'forge-bin');
const SC = require(path.join(BIN, 'forge-scribe.cjs'));
const S = require(path.join(BIN, 'forge-scribe-store.cjs'));
const C = require(path.join(BIN, 'forge-scribe-classify.cjs'));
const H = require(path.join(BIN, 'forge-scribe-hook.cjs'));
const PROJECT = path.basename(PROJECT_ROOT);
const AUTH = { authorization: 'Bearer frb_good' };
const LISTED = 'unclassified,open,planned,done,defer-proposed'; // what the gateway's scribe runner lists

let tmp; let convDir; let srv; let port;
let current = null; // the throwaway project the bridge's scribe runner reads

const slugOf = (d) => path.resolve(d).replace(/[^A-Za-z0-9]/g, '-'); // ~/.claude/projects/<slug>, as Claude Code names it

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ statusCode: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** A throwaway project with an empty .claude and its own temp "~/.claude/projects/<slug>/" transcript folder.
 *  These tests pin the OWNER path (the phone ack is the owner's act), so the project switches the scribe-acker's
 *  autoack off (config scribe-autoack, owner R-0233): otherwise the real hook in say() would accept a clean item
 *  before the owner's phone ack runs. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'scribe-autoack': { value: false, set_by: 'test: pins the owner ack path' } } }) + '\n', 'utf8');
  const projects = path.join(tmp, 'home-' + path.basename(root), '.claude', 'projects');
  fs.mkdirSync(path.join(projects, slugOf(root)), { recursive: true });
  return { root, projects, owner: { root, claudeProjectsRoot: projects } };
}

/** The owner's prompt reaches the project's Claude session: written to the session transcript, then
 *  captured by the real UserPromptSubmit hook. -> the capture result ({rid, pid, class, ...}). */
function say(proj, text) {
  const session = 'phone-turn';
  const tp = path.join(proj.projects, slugOf(proj.root), session + '.jsonl');
  const promptId = 'p-' + crypto.randomBytes(5).toString('hex');
  fs.appendFileSync(tp, JSON.stringify({ type: 'user', uuid: 'u-' + promptId, promptId, sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n');
  const r = H.runPrompt(
    { session_id: session, transcript_path: tp, cwd: proj.root, prompt_id: promptId, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: text },
    { projectRoot: proj.root, env: {}, scribe: { SC, S, C }, activeRun: null },
  );
  assert.ok(r.captured && r.captured.pid && r.captured.rid, 'the real hook captured the prompt as an owner item: ' + JSON.stringify({ reason: r.reason, skipped: r.skipped }));
  return r.captured;
}

const item = (proj, rid) => S.loadState(S.paths(proj.root)).items[rid];

/** An owner request worked to `done` with real evidence (a check_passed event of a run). -> its rid. */
function doneItem(proj, text) {
  const { rid } = say(proj, text);
  const lib = { root: proj.root };
  SC.transition(rid, 'link', { wp_ids: ['WP-1'] }, lib);
  SC.transition(rid, 'start', {}, lib);
  const runDir = path.join(proj.root, '.claude', 'forge-runs', 'run-ack');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify({ event_type: 'check_passed', event_id: 'ev-1' }) + '\n', 'utf8');
  SC.transition(rid, 'done', { evidence: { type: 'check_passed', ref: 'ev-1' }, run_id: 'run-ack' }, lib);
  assert.equal(item(proj, rid).status, 'done');
  return rid;
}

/** One phone act through the real bridge; -> the prompt text the turn's Claude session gets. */
async function phoneAct(rid, kind, body) {
  const r = await post('/remote/v1/scribe/' + encodeURIComponent(PROJECT) + '/' + rid + '/' + kind, body);
  assert.equal(r.statusCode, 202, JSON.stringify(r.json));
  for (let i = 0; i < 100 && isTurnBusy(r.json.conversation_id); i++) await new Promise((res) => setTimeout(res, 50));
  const turn = readConversation(r.json.conversation_id).turns.find((t) => t.role === 'user');
  assert.ok(turn && typeof turn.text === 'string', 'the phone act became a user turn');
  return turn.text;
}

/** transition() through the real owner check; a refusal fails the test with the scribe's own reason. */
function ownerAct(proj, rid, op, args) {
  try { return SC.transition(rid, op, args, proj.owner); } catch (e) {
    return assert.fail('the real scribe refused the phone ' + op + ' of ' + rid + ': ' + (e && e.message));
  }
}

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-owner-text-'));
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-owner-conv-'));
  _setConversationsDirForTests(convDir);
  _resetExecBridgeForTests();
  port = await freePort();
  srv = bridge.createBridgeServer({
    address: '127.0.0.1', port, mode: 'tailscale',
    devices: { authenticate: (t) => (t === 'frb_good' ? { id: 'd1', name: 'Phone' } : null) },
    pairing: createPairing(),
    audit: { write: () => {} },
    limits: bridge.createLimits({ scribeCacheMs: 0 }),
    scribeRunner: async (p) => (p.name === PROJECT && current
      ? { available: true, items: SC.list({ root: current.root, status: LISTED }) }
      : { available: false, items: [] }),
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
});

after(async () => {
  await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  delete process.env.CC_EXEC_MOCK;
  _resetExecBridgeForTests();
  _resetConversationsForTests();
  fs.rmSync(convDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test('ack: the phone Akkoord on a done item is an owner ack the real scribe applies, and the phone prompt leaves no stray item', async () => {
  current = makeProject();
  const rid = doneItem(current, 'Voeg een contactformulier toe aan de site');
  const text = await phoneAct(rid, 'ack', {});
  const prompt = say(current, text);
  assert.equal(prompt.class, 'ack', 'the hook files the phone prompt as an ack (so applying it closes that prompt item too)');
  const after = ownerAct(current, rid, 'ack', { pid: prompt.pid });
  assert.equal(after.status, 'acked');
  assert.equal(item(current, rid).acked_by_pid, prompt.pid);
  assert.equal(item(current, prompt.rid).status, 'answered', 'no stray unclassified item stays behind (WP-ACK-PROOF found R-0004)');
});

test('ack: on a defer-proposed item, with a note, the real scribe confirms the carry-over', async () => {
  current = makeProject();
  const { rid } = say(current, 'Voeg een export naar Excel toe');
  SC.transition(rid, 'defer', { reason: 'needs the export template from the owner' }, { root: current.root });
  assert.equal(item(current, rid).status, 'defer-proposed');
  const text = await phoneAct(rid, 'ack', { note: 'looks good' });
  assert.ok(text.includes('looks good'), 'the note travels with the act');
  const prompt = say(current, text);
  assert.equal(ownerAct(current, rid, 'ack', { pid: prompt.pid }).status, 'deferred');
});

test('ack: a note line that names the item with a negation still blocks the ack (the owner\'s own words win)', async () => {
  current = makeProject();
  const rid = doneItem(current, 'Verander de knoppen naar groen');
  const text = await phoneAct(rid, 'ack', { note: rid + ' nog niet' });
  const prompt = say(current, text);
  assert.throws(() => SC.transition(rid, 'ack', { pid: prompt.pid }, current.owner), /does not authorise ack/);
  assert.equal(item(current, rid).status, 'done');
});

test('answer: the phone answer is owner text that never acts on the item; the Lead closes a question item without an owner prompt', async () => {
  current = makeProject();
  const { rid } = say(current, 'Welke kleur krijgt de knop op de homepage?');
  assert.equal(item(current, rid).class, 'question');
  assert.equal(item(current, rid).status, 'open');
  // the scribe has no owner "answer" act (transition answer takes no --prompt), so no wording is
  // "accepted" as one; what matters is that the bridge's framing never turns an answer into an ack,
  // a cancel or an owner-gated reclassification, whatever the owner typed
  for (const owner of ['blauw', 'akkoord', 'laat maar zitten']) {
    const text = await phoneAct(rid, 'answer', { text: owner });
    const prompt = say(current, text);
    assert.ok(item(current, prompt.rid).quote.includes(owner), 'the owner\'s answer is kept word for word as an owner item');
    assert.throws(() => SC.transition(rid, 'cancel', { pid: prompt.pid }, current.owner), /does not authorise cancel/, owner);
    assert.throws(() => SC.transition(rid, 'classify', { class: 'ack', pid: prompt.pid }, current.owner), /does not authorise classify/, owner);
    assert.equal(item(current, rid).status, 'open', owner);
  }
  assert.equal(SC.transition(rid, 'answer', { reason: 'the owner answered from the phone' }, { root: current.root }).status, 'answered');
});
