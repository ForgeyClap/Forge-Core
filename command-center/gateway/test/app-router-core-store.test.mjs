// App router P1 (design sections 2.1 and 4.7): the router.json store and the router-events.jsonl
// log. Atomic write, revision 409, corrupt file -> defaults + UNREADABLE, audit line written,
// concurrent writes serialized, log kinds/keys filtered and the 2 MB cap with one .1 rotation.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRouterConfig, writeRouterConfig, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { appendRouterEvent, readRouterEvents, routerDataDir, _setRouterLogCapForTests } from '../src/app-router/router-log.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import { scanBuffer } from '../../desktop/scripts/distribution-check.mjs';

const NOW = Date.parse('2026-11-02T14:00:00.000Z');
let tempDir;
let dir;

before(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-approuter-store-')); });
after(() => {
  _setRouterDirForTests(null);
  _setRouterLogCapForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(tempDir, 'case-')), 'app-router');
  _setRouterDirForTests(dir);
  _setRouterLogCapForTests(null);
});

const ollama = { id: 'ollama', kind: 'provider-model', label: 'Ollama', provider: 'ollama-local', model: 'qwen2.5:0.5b', enabled: true, num_ctx: 8192, vars: { port: '11434' }, paid_ack: false, notice_ack: false };
const valid = (revision = 0) => ({ ...defaultRouterConfig(), revision, mode: 'claude-then-model', entries: [...defaultRouterConfig().entries, ollama] });
const events = () => fs.readFileSync(path.join(dir, 'router-events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the default folder is <data dir>/app-router', () => {
  _setRouterDirForTests(null);
  assert.equal(routerDataDir(), path.join(COMMAND_CENTER_DATA_DIR, 'app-router'));
  _setRouterDirForTests(dir);
  assert.equal(routerDataDir(), dir);
});

test('no file: defaults with provenance DEFAULT, nothing written by a read', () => {
  const r = readRouterConfig();
  assert.equal(r.provenance, 'DEFAULT');
  assert.deepEqual(r.config, defaultRouterConfig());
  assert.deepEqual(r.errors, []);
  assert.equal(fs.existsSync(dir), false);
});

test('write: atomic, revision bumped, updated_at set, read back as STORED', () => {
  const w = writeRouterConfig(valid(0), { expectRevision: 0, now: NOW });
  assert.equal(w.ok, true);
  assert.equal(w.config.revision, 1);
  assert.equal(w.config.updated_at, new Date(NOW).toISOString());
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED');
  assert.deepEqual(r.config, w.config);
});

test('expectRevision defaults to the revision inside the body', () => {
  assert.equal(writeRouterConfig(valid(0), { now: NOW }).ok, true);
  assert.equal(writeRouterConfig(valid(0), { now: NOW }).error, 'stale_revision');
  assert.equal(writeRouterConfig(valid(1), { now: NOW }).ok, true);
});

test('a stale revision is refused (409) and returns the current config', () => {
  writeRouterConfig(valid(0), { expectRevision: 0, now: NOW });
  const stale = writeRouterConfig({ ...valid(0), mode: 'model-first', entries: [ollama, ...defaultRouterConfig().entries] }, { expectRevision: 0, now: NOW });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale_revision');
  assert.equal(stale.config.revision, 1);
  assert.equal(stale.config.mode, 'claude-then-model');
  assert.equal(readRouterConfig().config.mode, 'claude-then-model');
});

test('an invalid config is refused with the validation errors and nothing is written', () => {
  const w = writeRouterConfig({ ...valid(0), mode: 'turbo' }, { expectRevision: 0, now: NOW });
  assert.equal(w.ok, false);
  assert.equal(w.error, 'invalid');
  assert.ok(w.errors.some((e) => e.code === 'bad_mode'));
  assert.equal(fs.existsSync(path.join(dir, 'router.json')), false);
});

test('a corrupt file reads as defaults with provenance UNREADABLE and can be overwritten', () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'router.json'), '{"version":1, broken', 'utf8');
  const r = readRouterConfig();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.deepEqual(r.config, defaultRouterConfig());
  assert.ok(r.errors.length >= 1);
  const w = writeRouterConfig(valid(r.config.revision), { expectRevision: r.config.revision, now: NOW });
  assert.equal(w.ok, true);
  assert.equal(readRouterConfig().provenance, 'STORED');
});

test('a stored file that no longer validates is UNREADABLE (router off), keeping its revision for the overwrite', () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'router.json'), JSON.stringify({ ...valid(5), mode: 'turbo' }), 'utf8');
  const r = readRouterConfig();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.equal(r.config.mode, 'off');
  assert.equal(r.config.revision, 5);
  assert.ok(r.errors.some((e) => e.code === 'bad_mode'));
  assert.equal(writeRouterConfig(valid(5), { now: NOW }).ok, true);
});

test('every successful write appends one router_config_changed audit line (ids and kinds only)', () => {
  writeRouterConfig(valid(0), { now: NOW });
  const lines = events();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'router_config_changed');
  assert.equal(lines[0].revision, 1);
  assert.equal(lines[0].mode, 'claude-then-model');
  assert.deepEqual(lines[0].entries, [{ id: 'main', kind: 'claude-account', enabled: true }, { id: 'ollama', kind: 'provider-model', enabled: true }]);
  assert.ok(!JSON.stringify(lines[0]).includes('qwen'), 'no model ids or labels beyond the allowed keys');
  writeRouterConfig({ ...valid(0), mode: 'turbo' }, { now: NOW });
  assert.equal(events().length, 1, 'a refused write is not logged as a change');
});

test('concurrent writes are serialized: exactly one of two same-revision writes wins', async () => {
  const results = await Promise.all([
    Promise.resolve().then(() => writeRouterConfig(valid(0), { now: NOW })),
    Promise.resolve().then(() => writeRouterConfig({ ...valid(0), mode: 'model-first', entries: [ollama, ...defaultRouterConfig().entries] }, { now: NOW })),
  ]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(results.find((r) => !r.ok).error, 'stale_revision');
  assert.equal(readRouterConfig().config.revision, 1);
});

test('the stored file carries no never-ship needle and no absolute path', () => {
  writeRouterConfig(valid(0), { now: NOW });
  const bytes = fs.readFileSync(path.join(dir, 'router.json'));
  assert.deepEqual(scanBuffer(bytes), []);
  assert.ok(!bytes.toString('utf8').includes(os.homedir()));
});

// ---- router-events.jsonl ----------------------------------------------------------------------------

test('appendRouterEvent: the five kinds, allowed keys only, unknown kinds refused', () => {
  assert.equal(appendRouterEvent('router_switch', { conv_id: 'c-1', turn_id: 't-1', from: 'main', to: 'werk', reason: 'switch-limit', text: 'secret message text' }, { now: NOW }), true);
  assert.equal(appendRouterEvent('router_limit_hit', { target_id: 'main', window: 'five_hour', resume_at: null }, { now: NOW }), true);
  assert.equal(appendRouterEvent('router_test', { target_id: 'werk', outcome: 'ok' }, { now: NOW }), true);
  assert.equal(appendRouterEvent('router_exhausted', { conv_id: 'c-1', resume_at: '2026-11-02T16:40:00.000Z' }, { now: NOW }), true);
  assert.equal(appendRouterEvent('something_else', { a: 1 }, { now: NOW }), false);
  const lines = events();
  assert.deepEqual(lines.map((l) => l.kind), ['router_switch', 'router_limit_hit', 'router_test', 'router_exhausted']);
  assert.equal(lines[0].at, new Date(NOW).toISOString());
  assert.equal('text' in lines[0], false, 'message text never reaches the log');
  assert.deepEqual(readRouterEvents().map((l) => l.kind), ['router_switch', 'router_limit_hit', 'router_test', 'router_exhausted']);
});

test('log strings are redacted and capped', () => {
  appendRouterEvent('router_test', { target_id: 'werk', outcome: 'sk' + '-' + 'W'.repeat(30) }, { now: NOW });
  appendRouterEvent('router_test', { target_id: 'x'.repeat(500), outcome: 'ok' }, { now: NOW });
  const [a, b] = events();
  assert.ok(a.outcome.startsWith('[REDACTED:'));
  assert.ok(b.target_id.length <= 64);
});

test('the log rotates once at the cap: one .1 file, the live file starts fresh', () => {
  _setRouterLogCapForTests(600);
  for (let i = 0; i < 20; i += 1) appendRouterEvent('router_test', { target_id: 'werk', outcome: 'ok' }, { now: NOW });
  const live = path.join(dir, 'router-events.jsonl');
  assert.ok(fs.existsSync(live + '.1'));
  assert.ok(fs.statSync(live).size <= 600);
  assert.ok(fs.statSync(live + '.1').size <= 600);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('router-events')).sort(), ['router-events.jsonl', 'router-events.jsonl.1']);
});

test('readRouterEvents on a missing log is an empty list', () => {
  assert.deepEqual(readRouterEvents(), []);
});
