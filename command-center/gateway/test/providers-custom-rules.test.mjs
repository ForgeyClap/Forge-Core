// "Eigen API" (ANY-MODEL-PLAN 2.2 A/B, 2.4, Lead decision D1): the pure rules for a user's own
// provider entry. Every row of the SSRF/network table is proven in both directions, plus ids, the derived
// key name, header names and the entry validator. No file access, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCustomURL, isCustomId, customKeyEnvName, slugFromLabel, uniqueCustomId, customAuthHeaderProblem,
  isSafeAuthHeaderTarget, validateCustomProvider, validateCustomDocument, CUSTOM_MESSAGES, CUSTOM_LIMITS,
  BLOCKED_PORTS, emptyCustomDocument,
} from '../src/providers/custom-rules.mjs';

function okURL(raw) {
  const r = checkCustomURL(raw);
  assert.equal(r.ok, true, raw + ' should be allowed, got ' + JSON.stringify(r));
  return r;
}
function badURL(raw, code) {
  const r = checkCustomURL(raw);
  assert.equal(r.ok, false, raw + ' should be refused');
  assert.equal(r.code, code, raw + ': expected ' + code + ', got ' + r.code);
}

function def(over = {}) {
  return {
    id: 'custom-mijn-vllm', label: 'Mijn vLLM-server', format: 'openai-chat', baseURL: 'http://192.168.1.20:8000/v1',
    auth: { type: 'bearer' }, models: { mode: 'endpoint' }, extraHeaders: {}, contextLength: null, enabled: true,
    ...over,
  };
}
const codes = (r) => r.errors.map((e) => e.code);

// ---- 2.4 table, row by row -------------------------------------------------------------------------
test('row 1: only http/https, no userinfo, no fragment (also no query, placeholder, backslash or space)', () => {
  for (const raw of ['ftp://example.com', 'file:///c:/x', 'javascript:alert(1)', 'ws://example.com', 'example.com/v1', 'http:example.com', 'http:/example.com']) badURL(raw, 'bad_url');
  badURL('https://user:pass@example.com/v1', 'bad_url');
  badURL('https://user@example.com/v1', 'bad_url');
  badURL('https://example.com/v1#frag', 'bad_url');
  badURL('https://example.com/v1?key=abc', 'bad_url');
  badURL('https://example.com/{port}/v1', 'bad_url');
  badURL('https://example.com\\v1', 'bad_url');
  badURL(' https://example.com/v1', 'bad_url');
  badURL('https://exa mple.com/v1', 'bad_url');
  badURL('', 'bad_url');
  badURL(42, 'bad_url');
  badURL('https://' + 'a'.repeat(CUSTOM_LIMITS.URL_MAX) + '.com', 'bad_url');
  badURL('https://metadata.google.internal./v1', 'bad_url'); // a trailing dot is a blocklist bypass shape
});

test('row 2: https to any host is allowed, without a warning, never "local"', () => {
  const r = okURL('https://api.example.com/v1');
  assert.deepEqual(r, { ok: true, url: 'https://api.example.com/v1', urlClass: 'https', local: false, warnings: [] });
  assert.equal(okURL('https://192.168.1.20:8443/v1').urlClass, 'https');
  assert.equal(okURL('https://127.0.0.1:8443').local, false);
  assert.equal(okURL('https://my-box/v1').warnings.length, 0);
});

test('row 3: http loopback (127.0.0.0/8, localhost, [::1]) is allowed and marked local', () => {
  for (const raw of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:8000/v1', 'http://127.0.0.2:9000', 'http://LOCALHOST:8080/v1']) {
    const r = okURL(raw);
    assert.equal(r.urlClass, 'loopback', raw);
    assert.equal(r.local, true, raw);
    assert.deepEqual(r.warnings, [], raw);
  }
  // numeric IPv4 spellings are normalised by the URL parser before they are judged
  assert.equal(okURL('http://2130706433:8000/v1').url, 'http://127.0.0.1:8000/v1');
  assert.equal(okURL('http://0x7f.1:8000').url, 'http://127.0.0.1:8000');
});

test('row 4: http to a private/LAN address is allowed WITH the http_lan warning (D1)', () => {
  for (const raw of ['http://10.0.0.5:8000/v1', 'http://172.16.0.9/v1', 'http://172.31.255.1/v1', 'http://192.168.1.20:8000/v1',
    'http://[fd12:3456::1]:8000/v1', 'http://nas.local:8000/v1', 'http://box.lan/v1', 'http://mybox:8000/v1', 'http://[fe80::1]:8000']) {
    const r = okURL(raw);
    assert.equal(r.urlClass, 'lan', raw);
    assert.equal(r.local, false, raw);
    assert.deepEqual(r.warnings, ['http_lan'], raw);
  }
  // 172.15/172.32 are outside 172.16/12: public over http
  badURL('http://172.15.0.1/v1', 'https_required');
  badURL('http://172.32.0.1/v1', 'https_required');
});

test('a *.localhost NAME is not trusted as this PC: http is allowed only with the http_lan warning, never marked local', () => {
  // The gateway does not resolve or pin a host name, and a resolver (or a hosts file) may send a name under
  // .localhost anywhere, so only the bare name localhost (which the operating system answers itself) is loopback.
  for (const raw of ['http://ollama.localhost:11434/v1', 'http://a.b.localhost/v1', 'http://LLM.LOCALHOST:8000/v1']) {
    const r = okURL(raw);
    assert.equal(r.urlClass, 'lan', raw);
    assert.equal(r.local, false, raw);
    assert.deepEqual(r.warnings, ['http_lan'], raw);
  }
  assert.equal(okURL('https://ollama.localhost/v1').urlClass, 'https');
  const v = validateCustomProvider(def({ baseURL: 'http://ollama.localhost:11434/v1' }));
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.map((w) => [w.path, w.code]), [['baseURL', 'http_lan']]);
});

test('row 5: http to a public host is refused (https_required)', () => {
  for (const raw of ['http://api.example.com/v1', 'http://8.8.8.8/v1', 'http://[2001:db8::1]/v1', 'http://100.64.0.1/v1', 'http://box.localdomain.example/v1']) badURL(raw, 'https_required');
});

test('row 6: cloud metadata hosts are refused always, also over https and in disguise', () => {
  for (const scheme of ['http', 'https']) {
    badURL(scheme + '://169.254.169.254/latest', 'blocked_host');
    badURL(scheme + '://[fd00:ec2::254]/latest', 'blocked_host');
    badURL(scheme + '://metadata.google.internal/computeMetadata', 'blocked_host');
    badURL(scheme + '://100.100.100.200/latest', 'blocked_host');
    badURL(scheme + '://metadata/computeMetadata', 'blocked_host');
    badURL(scheme + '://METADATA.GOOGLE.INTERNAL/x', 'blocked_host');
  }
  badURL('http://169.254.170.2/v2', 'blocked_host'); // the whole IPv4 link-local block (ECS task metadata)
  badURL('http://0xa9fea9fe/latest', 'blocked_host'); // 169.254.169.254 as one hex number
  badURL('http://[::ffff:169.254.169.254]/latest', 'blocked_host'); // IPv4-mapped IPv6
  badURL('http://[64:ff9b::a9fe:a9fe]/latest', 'blocked_host'); // NAT64 well-known prefix
  badURL('http://0.0.0.0:11434', 'blocked_host');
  badURL('http://[::]:8000', 'blocked_host');
  badURL('http://224.0.0.1/v1', 'blocked_host');
});

test('row 7: well-known non-HTTP ports are refused (blocked_port), on any host', () => {
  assert.deepEqual([...BLOCKED_PORTS].sort((a, b) => a - b), [0, 7, 9, 19, 25, 110, 143, 465, 587]);
  for (const p of BLOCKED_PORTS) {
    badURL('http://127.0.0.1:' + p + '/v1', 'blocked_port');
    badURL('https://api.example.com:' + p + '/v1', 'blocked_port');
  }
  assert.equal(okURL('http://127.0.0.1:8080/v1').ok, true);
});

test('the normalised url drops trailing slashes and default ports, keeps the path', () => {
  assert.equal(okURL('https://api.example.com:443/v1/').url, 'https://api.example.com/v1');
  assert.equal(okURL('http://localhost:80/').url, 'http://localhost');
  assert.equal(okURL('https://Api.Example.com/V1').url, 'https://api.example.com/V1');
});

// ---- ids, derived key name ---------------------------------------------------------------------------
test('custom ids: custom-<slug>, slug lowercase groups joined by single dashes, at most 32 chars', () => {
  assert.equal(isCustomId('custom-mijn-vllm'), true);
  assert.equal(isCustomId('custom-a'), true);
  assert.equal(isCustomId('custom-' + 'a'.repeat(32)), true);
  for (const bad of ['custom-', 'custom--a', 'custom-a-', 'custom-A', 'custom-a_b', 'openai', 'custom-' + 'a'.repeat(33), 'xcustom-a', null]) assert.equal(isCustomId(bad), false, String(bad));
});

test('derived key name: custom-mijn-vllm -> CUSTOM_MIJN_VLLM_API_KEY; invalid ids give null', () => {
  assert.equal(customKeyEnvName('custom-mijn-vllm'), 'CUSTOM_MIJN_VLLM_API_KEY');
  assert.equal(customKeyEnvName('custom-a1'), 'CUSTOM_A1_API_KEY');
  assert.equal(customKeyEnvName('openai'), null);
  assert.match(customKeyEnvName('custom-' + 'a'.repeat(32)), /^[A-Z][A-Z0-9_]{1,63}$/);
});

test('slugFromLabel and uniqueCustomId make a valid, unused id from any name', () => {
  assert.equal(slugFromLabel('Mijn vLLM-server'), 'mijn-vllm-server');
  assert.equal(slugFromLabel('  Café   Ölmaß!! '), 'cafe-olma');
  assert.equal(slugFromLabel('***'), 'api');
  assert.equal(slugFromLabel('x'.repeat(80)).length, CUSTOM_LIMITS.SLUG_MAX);
  assert.equal(uniqueCustomId('Mijn vLLM', []), 'custom-mijn-vllm');
  assert.equal(uniqueCustomId('Mijn vLLM', ['custom-mijn-vllm', 'custom-mijn-vllm-2']), 'custom-mijn-vllm-3');
  const long = uniqueCustomId('y'.repeat(80), ['custom-' + 'y'.repeat(32)]);
  assert.equal(isCustomId(long), true);
  assert.notEqual(long, 'custom-' + 'y'.repeat(32));
});

// ---- headers --------------------------------------------------------------------------------------------
test('custom auth header name: a plain token name, never an auth-looking or framing header', () => {
  assert.equal(customAuthHeaderProblem('X-Auth-Token'), null);
  for (const n of ['Authorization', 'x-api-key', 'API-KEY', 'cookie', 'proxy-authorization', 'x-goog-api-key', 'Host', 'content-length', 'transfer-encoding', 'connection']) {
    assert.equal(customAuthHeaderProblem(n), 'bad_header', n);
  }
  for (const n of ['', '1abc', 'x auth', 'x:auth', 'a'.repeat(65), 'x\r\ny', null]) assert.equal(customAuthHeaderProblem(n), 'bad_header', String(n));
  // runtime guard: auth names are fine as a target (the compiled x-api-key mapping), framing names never
  assert.equal(isSafeAuthHeaderTarget('x-api-key'), true);
  assert.equal(isSafeAuthHeaderTarget('X-Auth-Token'), true);
  assert.equal(isSafeAuthHeaderTarget('host'), false);
  assert.equal(isSafeAuthHeaderTarget('Content-Length'), false);
  assert.equal(isSafeAuthHeaderTarget('x\ny'), false);
});

// ---- entry validation ------------------------------------------------------------------------------------
test('a full valid entry passes for all three formats and every auth type', () => {
  for (const format of ['openai-chat', 'openai-responses', 'anthropic']) {
    for (const auth of [{ type: 'none' }, { type: 'bearer' }, { type: 'x-api-key' }, { type: 'api-key-header' }, { type: 'custom', header: 'X-Auth-Token', prefix: 'Token ' }]) {
      const r = validateCustomProvider(def({ format, auth, baseURL: 'https://api.example.com' }));
      assert.deepEqual(r.errors, [], format + ' ' + auth.type + ': ' + JSON.stringify(r.errors));
    }
  }
  const lan = validateCustomProvider(def());
  assert.deepEqual(lan.errors, []);
  assert.deepEqual(lan.warnings.map((w) => w.code), ['http_lan']);
  assert.equal(lan.warnings[0].path, 'baseURL');
});

test('unknown keys are refused at every level', () => {
  assert.ok(codes(validateCustomProvider(def({ apiKey: 'x' }))).includes('unknown_key'));
  assert.ok(codes(validateCustomProvider(def({ auth: { type: 'bearer', key: 'x' } }))).includes('unknown_key'));
  assert.ok(codes(validateCustomProvider(def({ models: { mode: 'endpoint', ids: [] } }))).includes('unknown_key'));
  const docErr = validateCustomDocument({ ...emptyCustomDocument(), extra: 1 });
  assert.ok(docErr.errors.some((e) => e.code === 'unknown_key' && e.path === 'extra'));
});

test('a value shaped like a key is refused anywhere (label, header value, prefix, model id, url path)', () => {
  const key = 'sk-' + 'Q'.repeat(30);
  for (const over of [
    { label: 'mijn ' + key },
    { extraHeaders: { 'X-Team': key } },
    { auth: { type: 'custom', header: 'X-Auth', prefix: key.slice(0, 30) } },
    { models: { mode: 'manual', ids: ['model-' + 'nvapi-' + 'x'.repeat(20)] } },
    { baseURL: 'https://api.example.com/' + key },
  ]) {
    const r = validateCustomProvider(def(over));
    assert.ok(codes(r).includes('secret_like_value'), JSON.stringify(Object.keys(over)) + ' -> ' + JSON.stringify(codes(r)));
  }
});

test('a long dotted host name is NOT mistaken for a secret (only the path is scanned by the broad filter)', () => {
  const r = validateCustomProvider(def({ baseURL: 'https://inference-server01.homelab-network.internalzone/v1' }));
  assert.deepEqual(r.errors, []);
});

test('label, format, auth, models, extra headers, context length and enabled are checked', () => {
  assert.ok(codes(validateCustomProvider(def({ label: '' }))).includes('bad_label'));
  assert.ok(codes(validateCustomProvider(def({ label: 'x'.repeat(41) }))).includes('bad_label'));
  assert.ok(codes(validateCustomProvider(def({ label: 'a\u0007b' }))).includes('bad_label'));
  assert.ok(codes(validateCustomProvider(def({ label: '   ' }))).includes('bad_label'));
  assert.ok(codes(validateCustomProvider(def({ format: 'ollama' }))).includes('bad_format'));
  assert.ok(codes(validateCustomProvider(def({ auth: { type: 'oauth' } }))).includes('bad_auth'));
  assert.ok(codes(validateCustomProvider(def({ auth: { type: 'custom', header: 'Authorization' } }))).includes('bad_header'));
  assert.ok(codes(validateCustomProvider(def({ auth: { type: 'custom', header: 'X-A', prefix: 'a\nb' } }))).includes('bad_prefix'));
  assert.ok(codes(validateCustomProvider(def({ auth: { type: 'custom', header: 'X-A', prefix: 'p'.repeat(33) } }))).includes('bad_prefix'));
  assert.ok(codes(validateCustomProvider(def({ models: { mode: 'manual', ids: [] } }))).includes('bad_models'));
  assert.ok(codes(validateCustomProvider(def({ models: { mode: 'manual', ids: ['ok-1', 'bad id'] } }))).includes('bad_model'));
  assert.ok(codes(validateCustomProvider(def({ models: { mode: 'manual', ids: ['a', 'a'] } }))).includes('duplicate_model'));
  assert.ok(codes(validateCustomProvider(def({ models: { mode: 'manual', ids: Array.from({ length: CUSTOM_LIMITS.MAX_MODELS + 1 }, (_, i) => 'm' + i) } }))).includes('too_many_models'));
  assert.ok(codes(validateCustomProvider(def({ models: { mode: 'list' } }))).includes('bad_models'));
  // the same model-id rule as the app router (MODEL_RE) and the dashboard form: no @ or +, at most 50 ids
  assert.equal(CUSTOM_LIMITS.MAX_MODELS, 50);
  assert.ok(codes(validateCustomProvider(def({ models: { mode: 'manual', ids: ['vertex-model@2024'] } }))).includes('bad_model'));
  assert.ok(codes(validateCustomProvider(def({ models: { mode: 'manual', ids: ['a+b'] } }))).includes('bad_model'));
  assert.deepEqual(validateCustomProvider(def({ models: { mode: 'manual', ids: ['org/model-1.5:q4_K_M'] } })).errors, []);
  assert.ok(codes(validateCustomProvider(def({ extraHeaders: { Authorization: 'x' } }))).includes('bad_header'));
  assert.ok(codes(validateCustomProvider(def({ extraHeaders: { 'X-A': 'a\r\nInjected: 1' } }))).includes('bad_header_value'));
  assert.ok(codes(validateCustomProvider(def({ extraHeaders: { 'X-A': 'v'.repeat(201) } }))).includes('bad_header_value'));
  const many = Object.fromEntries(Array.from({ length: CUSTOM_LIMITS.MAX_EXTRA_HEADERS + 1 }, (_, i) => ['X-H' + i, 'v']));
  assert.ok(codes(validateCustomProvider(def({ extraHeaders: many }))).includes('too_many_headers'));
  assert.ok(codes(validateCustomProvider(def({ auth: { type: 'custom', header: 'X-Team' }, extraHeaders: { 'x-team': 'a' } }))).includes('duplicate_header'));
  assert.ok(codes(validateCustomProvider(def({ contextLength: 100 }))).includes('out_of_range'));
  assert.ok(codes(validateCustomProvider(def({ contextLength: 1.5 }))).includes('out_of_range'));
  assert.deepEqual(validateCustomProvider(def({ contextLength: 32768 })).errors, []);
  assert.ok(codes(validateCustomProvider(def({ enabled: 'yes' }))).includes('bad_type'));
  assert.ok(codes(validateCustomProvider(def({ id: 'openai' }))).includes('bad_id'));
  assert.ok(codes(validateCustomProvider(def({ created_at: 'gisteren' }))).includes('bad_type'));
});

test('anthropic format: a base url ending in /v1 gets a warning (the adapter adds /v1/messages itself)', () => {
  const r = validateCustomProvider(def({ format: 'anthropic', baseURL: 'https://proxy.example.com/anthropic/v1' }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map((w) => w.code), ['anthropic_base_v1']);
});

test('the document: version, revision, unique ids, at most MAX_PROVIDERS, warnings carry the entry path', () => {
  const doc = { version: 1, revision: 2, providers: [def(), def({ id: 'custom-two', baseURL: 'https://api.example.com/v1' })], updated_at: null };
  const ok = validateCustomDocument(doc);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.warnings.map((w) => w.path), ['providers[0].baseURL']);
  assert.ok(validateCustomDocument({ ...doc, version: 2 }).errors.some((e) => e.code === 'bad_version'));
  assert.ok(validateCustomDocument({ ...doc, revision: -1 }).errors.some((e) => e.code === 'bad_revision'));
  assert.ok(validateCustomDocument({ ...doc, providers: [def(), def()] }).errors.some((e) => e.code === 'duplicate_id'));
  const lots = Array.from({ length: CUSTOM_LIMITS.MAX_PROVIDERS + 1 }, (_, i) => def({ id: 'custom-p' + i }));
  assert.ok(validateCustomDocument({ ...doc, providers: lots }).errors.some((e) => e.code === 'too_many_providers'));
  assert.ok(validateCustomDocument(null).errors.some((e) => e.code === 'bad_shape'));
  assert.ok(validateCustomDocument({ ...doc, providers: 'x' }).errors.some((e) => e.code === 'bad_shape'));
});

test('every error and warning code has a Dutch and an English message, and errors carry them', () => {
  for (const [code, pair] of Object.entries(CUSTOM_MESSAGES)) {
    assert.equal(Array.isArray(pair) && pair.length, 2, code);
    assert.ok(pair[0].length > 5 && pair[1].length > 5, code);
  }
  const r = validateCustomProvider(def({ baseURL: 'http://api.example.com' }));
  assert.deepEqual(r.errors.map((e) => Object.keys(e).sort()), [['code', 'en', 'nl', 'path']]);
  assert.equal(r.errors[0].path, 'baseURL');
  assert.equal(r.errors[0].code, 'https_required');
  assert.equal(CUSTOM_MESSAGES.http_lan[0], 'Dit adres is niet versleuteld (http). Gebruik het alleen op je eigen computer of eigen netwerk.');
});
