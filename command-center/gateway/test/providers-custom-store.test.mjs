// "Eigen API" (ANY-MODEL-PLAN 2.2 A): the user overlay store <data dir>/providers/custom.json.
// Gateway is the only writer, atomic temp+rename, revision (optimistic concurrency), audit line, no
// secrets, no absolute paths, unknown keys refused. Every test runs in its own temp folder.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCustomProviders, createCustomProvider, updateCustomProvider, deleteCustomProvider, writeCustomProviders,
  customProvidersFile, customProvidersDir, customStoreStamp, _setCustomProvidersDirForTests, CUSTOM_EVENT_KINDS,
} from '../src/providers/custom-store.mjs';
import { emptyCustomDocument } from '../src/providers/custom-rules.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'providers-custom');
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-custom-store-'));
  _setCustomProvidersDirForTests(dir);
});
afterEach(() => {
  _setCustomProvidersDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function input(over = {}) {
  return { label: 'Mijn vLLM-server', format: 'openai-chat', baseURL: 'http://192.168.1.20:8000/v1/', auth: { type: 'bearer' }, models: { mode: 'endpoint' }, ...over };
}
function events() {
  const f = path.join(dir, 'custom-events.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

test('the store lives in <data dir>/providers/custom.json (test seam points the folder)', () => {
  assert.equal(customProvidersDir(), dir);
  assert.equal(customProvidersFile(), path.join(dir, 'custom.json'));
});

test('no file reads as an empty DEFAULT document (revision 0), never a crash', () => {
  const r = readCustomProviders();
  assert.equal(r.provenance, 'DEFAULT');
  assert.deepEqual(r.doc, emptyCustomDocument());
  assert.deepEqual(r.errors, []);
});

test('create: id from the name, normalised url, defaults filled, revision 0 -> 1, file written atomically', () => {
  const r = createCustomProvider(input(), { expectRevision: 0, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.provider.id, 'custom-mijn-vllm-server');
  assert.equal(r.provider.baseURL, 'http://192.168.1.20:8000/v1');
  assert.deepEqual(r.provider.extraHeaders, {});
  assert.equal(r.provider.contextLength, null);
  assert.equal(r.provider.enabled, true);
  assert.equal(r.provider.created_at, '2026-11-02T12:00:00.000Z');
  assert.equal(r.doc.revision, 1);
  assert.deepEqual(r.warnings.map((w) => w.code), ['http_lan']);
  assert.equal(r.keyEnvName, 'CUSTOM_MIJN_VLLM_SERVER_API_KEY');
  const onDisk = JSON.parse(fs.readFileSync(customProvidersFile(), 'utf8'));
  assert.deepEqual(onDisk, r.doc);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  const back = readCustomProviders();
  assert.equal(back.provenance, 'STORED');
  assert.deepEqual(back.doc, r.doc);
});

test('the write is a rename of a temp file in the same folder over custom.json (atomic), once per write', () => {
  const real = fs.renameSync;
  const calls = [];
  fs.renameSync = (from, to) => { calls.push([from, to]); return real(from, to); };
  try {
    createCustomProvider(input(), { expectRevision: 0, now: NOW });
  } finally {
    fs.renameSync = real;
  }
  assert.equal(calls.length, 1);
  const [from, to] = calls[0];
  assert.equal(to, customProvidersFile());
  assert.equal(path.dirname(from), dir);
  assert.match(path.basename(from), /^custom\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
});

test('a second provider with the same name gets the next free id', () => {
  createCustomProvider(input(), { expectRevision: 0, now: NOW });
  const r = createCustomProvider(input(), { expectRevision: 1, now: NOW });
  assert.equal(r.provider.id, 'custom-mijn-vllm-server-2');
});

test('a stale or missing revision is refused (409 shape) and nothing is written', () => {
  createCustomProvider(input(), { expectRevision: 0, now: NOW });
  const before = fs.readFileSync(customProvidersFile(), 'utf8');
  const stale = createCustomProvider(input({ label: 'Twee' }), { expectRevision: 0, now: NOW });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale_revision');
  assert.equal(stale.doc.revision, 1);
  const missing = createCustomProvider(input({ label: 'Drie' }), { now: NOW });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'invalid');
  assert.equal(missing.errors[0].code, 'bad_revision');
  assert.equal(fs.readFileSync(customProvidersFile(), 'utf8'), before);
});

test('invalid input is refused with {path, code, nl, en} errors: unknown key, secret-like value, public http', () => {
  const unknown = createCustomProvider(input({ apiKey: 'whatever' }), { expectRevision: 0, now: NOW });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'invalid');
  assert.ok(unknown.errors.some((e) => e.code === 'unknown_key' && e.path === 'apiKey'));
  const secret = createCustomProvider(input({ label: 'x sk-' + 'A'.repeat(24) }), { expectRevision: 0, now: NOW });
  assert.ok(secret.errors.some((e) => e.code === 'secret_like_value' && e.path === 'label'));
  assert.equal(JSON.stringify(secret).includes('A'.repeat(24)), false, 'the refused value is never echoed back');
  const pub = createCustomProvider(input({ baseURL: 'http://api.example.com/v1' }), { expectRevision: 0, now: NOW });
  assert.ok(pub.errors.some((e) => e.code === 'https_required' && typeof e.nl === 'string' && typeof e.en === 'string'));
  assert.equal(fs.existsSync(customProvidersFile()), false);
});

test('an explicit id is honoured when valid and free; a bundled-looking or taken id is refused', () => {
  const r = createCustomProvider(input({ id: 'custom-thuis' }), { expectRevision: 0, now: NOW });
  assert.equal(r.provider.id, 'custom-thuis');
  assert.ok(createCustomProvider(input({ id: 'openai' }), { expectRevision: 1, now: NOW }).errors.some((e) => e.code === 'bad_id'));
  assert.ok(createCustomProvider(input({ id: 'custom-thuis' }), { expectRevision: 1, now: NOW }).errors.some((e) => e.code === 'duplicate_id'));
});

test('update replaces the definition, keeps id and created_at, bumps revision; unknown id is not_found', () => {
  const c = createCustomProvider(input(), { expectRevision: 0, now: NOW });
  const later = NOW + 60_000;
  const u = updateCustomProvider(c.provider.id, input({ label: 'Nieuwe naam', baseURL: 'https://llm.example.com/v1', enabled: false, contextLength: 32768 }), { expectRevision: 1, now: later });
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(u.provider.id, c.provider.id);
  assert.equal(u.provider.created_at, c.provider.created_at);
  assert.equal(u.provider.updated_at, new Date(later).toISOString());
  assert.equal(u.provider.enabled, false);
  assert.equal(u.doc.revision, 2);
  assert.deepEqual(u.warnings, []);
  const nf = updateCustomProvider('custom-nope', input(), { expectRevision: 2, now: later });
  assert.equal(nf.ok, false);
  assert.equal(nf.error, 'not_found');
  const idChange = updateCustomProvider(c.provider.id, input({ id: 'custom-other' }), { expectRevision: 2, now: later });
  assert.ok(idChange.errors.some((e) => e.code === 'bad_id'));
});

test('delete removes the entry and returns the derived key name so the desktop can drop the vault key', () => {
  const c = createCustomProvider(input(), { expectRevision: 0, now: NOW });
  const d = deleteCustomProvider(c.provider.id, { expectRevision: 1, now: NOW });
  assert.equal(d.ok, true);
  assert.deepEqual(d.removed, { id: 'custom-mijn-vllm-server', keyEnvName: 'CUSTOM_MIJN_VLLM_SERVER_API_KEY' });
  assert.deepEqual(d.doc.providers, []);
  assert.equal(d.doc.revision, 2);
  assert.equal(deleteCustomProvider(c.provider.id, { expectRevision: 2, now: NOW }).error, 'not_found');
});

test('every write appends one token-free audit line (ids and codes only, never the address or a header value)', () => {
  const c = createCustomProvider(input({ extraHeaders: { 'X-Team': 'blauw-team' } }), { expectRevision: 0, now: NOW });
  updateCustomProvider(c.provider.id, input({ label: 'B' }), { expectRevision: 1, now: NOW });
  deleteCustomProvider(c.provider.id, { expectRevision: 2, now: NOW });
  const ev = events();
  assert.deepEqual(ev.map((e) => e.kind), ['custom_provider_created', 'custom_provider_updated', 'custom_provider_deleted']);
  assert.deepEqual(CUSTOM_EVENT_KINDS.slice().sort(), ['custom_provider_created', 'custom_provider_deleted', 'custom_provider_updated', 'custom_providers_replaced']);
  assert.deepEqual(Object.keys(ev[0]).sort(), ['at', 'auth_type', 'enabled', 'format', 'id', 'kind', 'models_mode', 'revision', 'url_class']);
  const text = fs.readFileSync(path.join(dir, 'custom-events.jsonl'), 'utf8');
  for (const leak of ['192.168', 'blauw-team', 'Mijn vLLM']) assert.equal(text.includes(leak), false, leak);
});

test('a damaged file reads as UNREADABLE (no providers, revision kept); entry writes are refused until replaced', () => {
  fs.copyFileSync(path.join(FIXTURES, 'damaged.json'), customProvidersFile());
  const r = readCustomProviders();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.deepEqual(r.doc.providers, []);
  assert.ok(r.errors.length > 0);
  const c = createCustomProvider(input(), { expectRevision: 0, now: NOW });
  assert.equal(c.ok, false);
  assert.equal(c.error, 'unreadable');
});

test('a structurally valid file with a refused value is UNREADABLE too, and the revision survives for the next save', () => {
  fs.copyFileSync(path.join(FIXTURES, 'public-http.json'), customProvidersFile());
  const r = readCustomProviders();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.equal(r.doc.revision, 4);
  assert.ok(r.errors.some((e) => e.code === 'https_required'));
  // A full replacement repairs it; the broken original is kept beside it, not silently lost.
  const w = writeCustomProviders({ ...emptyCustomDocument(), revision: 4 }, { expectRevision: 4, now: NOW });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.doc.revision, 5);
  assert.equal(readCustomProviders().provenance, 'STORED');
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('custom.json.unreadable-'));
  assert.equal(aside.length, 1);
  assert.equal(events().at(-1).kind, 'custom_providers_replaced');
});

test('the valid fixture loads as STORED with all three formats', () => {
  fs.copyFileSync(path.join(FIXTURES, 'valid.json'), customProvidersFile());
  const r = readCustomProviders();
  assert.equal(r.provenance, 'STORED', JSON.stringify(r.errors));
  assert.deepEqual(r.doc.providers.map((p) => p.format).sort(), ['anthropic', 'openai-chat', 'openai-responses']);
});

test('the stored document holds no absolute path and no key-shaped value', () => {
  createCustomProvider(input(), { expectRevision: 0, now: NOW });
  const text = fs.readFileSync(customProvidersFile(), 'utf8');
  assert.equal(text.includes(dir), false);
  assert.equal(/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(text), false);
});

test('the stamp changes on every write (in-process generation) and on an outside edit', () => {
  const s0 = customStoreStamp();
  createCustomProvider(input(), { expectRevision: 0, now: NOW });
  const s1 = customStoreStamp();
  assert.notEqual(s1, s0);
  assert.equal(customStoreStamp(), s1, 'stable while nothing changes');
  const doc = JSON.parse(fs.readFileSync(customProvidersFile(), 'utf8'));
  doc.providers[0].label = 'Met de hand aangepast en langer';
  fs.writeFileSync(customProvidersFile(), JSON.stringify(doc));
  assert.notEqual(customStoreStamp(), s1);
});

test('two writes in a row are serialised: the second sees the first (no lost update)', () => {
  const a = createCustomProvider(input({ label: 'Een' }), { expectRevision: 0, now: NOW });
  const b = createCustomProvider(input({ label: 'Twee' }), { expectRevision: a.doc.revision, now: NOW });
  assert.equal(b.ok, true);
  assert.deepEqual(readCustomProviders().doc.providers.map((p) => p.label), ['Een', 'Twee']);
});
