// WP B4: readTeamChat() — the reader behind GET /api/runs/:id/team-chat.
// Temp project folder per test; nothing outside os.tmpdir() is touched, and every folder is removed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTeamChat, parseLimit, safeWpIdOk, TEAM_CHAT_ROUTE_RE, MAX_LIMIT, DEFAULT_LIMIT } from '../src/team-chat.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(runId, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-team-chat-'));
  made.push(root);
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  if (lines !== null) {
    const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
    fs.writeFileSync(path.join(runDir, 'team-chat.jsonl'), body, 'utf8');
  }
  return root;
}

const RUN = 'forge-2026-11-01-b4-test';

function line(ts, from, to, wp, kind, text, via = 'direct') {
  return { ts, run_id: RUN, from, to, wp_id: wp, kind, text, via };
}

test('missing file is the honest empty state, not an error', () => {
  const root = makeProject(RUN, null);
  const result = readTeamChat(root, RUN);
  assert.equal(result.ok, true);
  assert.equal(result.exists, false);
  assert.deepEqual(result.lines, []);
  assert.equal(result.total, 0);
});

test('a run folder that does not exist is also empty', () => {
  const root = makeProject(RUN, null);
  const result = readTeamChat(root, 'some-other-run');
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, []);
});

test('containment: traversal and separators in the run id are refused', () => {
  const root = makeProject(RUN, [line('2026-11-01T10:00:00Z', 'Build Boss', 'Test Boss', 'B4', 'message', 'hi')]);
  for (const bad of ['..', '../x', '..\\x', 'a/b', 'a.b', '', 'x'.repeat(129)]) {
    const result = readTeamChat(root, bad);
    assert.equal(result.ok, false, `run id ${JSON.stringify(bad)} must be refused`);
    assert.equal(result.status, 400);
  }
  // A secret file one level up from the runs folder is never reachable.
  fs.writeFileSync(path.join(root, '.claude', 'team-chat.jsonl'), JSON.stringify({ text: 'outside' }) + '\n');
  assert.equal(readTeamChat(root, '..').ok, false);
});

test('ordering: oldest first by ts, append order breaks ties, newest N kept', () => {
  const root = makeProject(RUN, [
    line('2026-11-01T10:05:00Z', 'Test Boss', 'lead', 'B4', 'message', 'third'),
    line('2026-11-01T10:00:00Z', 'Build Boss', 'Test Boss', 'B4', 'handoff', 'first'),
    line('2026-11-01T10:01:00Z', 'UI Boss', 'lead', 'B4', 'question', 'second-a'),
    line('2026-11-01T10:01:00Z', 'UI Boss', 'lead', 'B4', 'question', 'second-b'),
  ]);
  const all = readTeamChat(root, RUN);
  assert.deepEqual(all.lines.map((l) => l.text), ['first', 'second-a', 'second-b', 'third']);
  assert.equal(all.truncated, false);
  const newest = readTeamChat(root, RUN, { limit: 2 });
  assert.deepEqual(newest.lines.map((l) => l.text), ['second-b', 'third']);
  assert.equal(newest.total, 4);
  assert.equal(newest.truncated, true);
});

test('redaction: a secret in any field never leaves the reader', () => {
  const secret = 'sk-' + 'A'.repeat(32);
  const pat = 'ghp_' + 'b'.repeat(20);
  const root = makeProject(RUN, [line('2026-11-01T10:00:00Z', 'Build Boss', 'lead', 'B4', 'blocker', `key is ${secret} and ${pat}`)]);
  const result = readTeamChat(root, RUN);
  const json = JSON.stringify(result);
  assert.ok(!json.includes(secret), 'sk- key leaked');
  assert.ok(!json.includes(pat), 'GitHub token leaked');
  assert.match(result.lines[0].text, /\[REDACTED:GENERIC_SK_KEY\]/);
});

test('?wp= filters, and a bad wp id is refused', () => {
  const root = makeProject(RUN, [
    line('2026-11-01T10:00:00Z', 'Build Boss', 'Test Boss', 'B4', 'message', 'b4'),
    line('2026-11-01T10:01:00Z', 'Build Boss', 'Test Boss', 'B6', 'message', 'b6'),
  ]);
  assert.deepEqual(readTeamChat(root, RUN, { wp: 'B6' }).lines.map((l) => l.text), ['b6']);
  const bad = readTeamChat(root, RUN, { wp: '../x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(safeWpIdOk('A1.2_x-y'), true);
  assert.equal(safeWpIdOk('a/b'), false);
});

test('malformed lines are counted, not guessed; contract fields are normalised', () => {
  const root = makeProject(RUN, [
    '{not json',
    '[1,2]',
    line('2026-11-01T10:00:00Z', 'lead', 'Build Boss', 'B4', 'decision', 'go'),
    { ts: '2026-11-01T10:01:00Z', from: 'Docs Boss', to: 'lead', wp_id: 'B4', kind: 'shout', text: 'x', via: 'lead', extra: 'dropped' },
  ]);
  const result = readTeamChat(root, RUN);
  assert.equal(result.malformed, 2);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].kind, 'decision');
  assert.equal(result.lines[1].kind, 'message');
  assert.equal(result.lines[1].kind_raw, 'shout');
  assert.equal(result.lines[1].via, 'lead');
  assert.equal('extra' in result.lines[1], false);
});

test('CRLF line ends are read like LF', () => {
  const root = makeProject(RUN, null);
  const file = path.join(root, '.claude', 'forge-runs', RUN, 'team-chat.jsonl');
  fs.writeFileSync(file, JSON.stringify(line('2026-11-01T10:00:00Z', 'Build Boss', 'lead', 'B4', 'message', 'crlf')) + '\r\n');
  assert.deepEqual(readTeamChat(root, RUN).lines.map((l) => l.text), ['crlf']);
});

test('limit parsing and the route pattern', () => {
  assert.equal(parseLimit(null), DEFAULT_LIMIT);
  assert.equal(parseLimit('abc'), DEFAULT_LIMIT);
  assert.equal(parseLimit('-3'), DEFAULT_LIMIT);
  assert.equal(parseLimit('5'), 5);
  assert.equal(parseLimit('999999'), MAX_LIMIT);
  assert.equal(TEAM_CHAT_ROUTE_RE.exec('/api/runs/abc-1/team-chat')[1], 'abc-1');
  assert.equal(TEAM_CHAT_ROUTE_RE.test('/api/runs/a/b/team-chat'), false);
  assert.equal(TEAM_CHAT_ROUTE_RE.test('/api/runs'), false);
});
