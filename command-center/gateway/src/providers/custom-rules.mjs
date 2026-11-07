// "Eigen API" rules (ANY-MODEL-PLAN 2.2 A/B and 2.4, Lead decision D1). Pure: no file access, no network.
//
//   checkCustomURL(raw)            the SSRF / network table: which base URL a user's own provider may use
//   validateCustomProvider(def)    one overlay entry -> { errors, warnings } in the { path, code, nl, en } shape
//   validateCustomDocument(doc)    the whole custom.json document
//   isCustomId / customKeyEnvName / slugFromLabel / uniqueCustomId   ids and the derived vault key name
//   customAuthHeaderProblem / isSafeAuthHeaderTarget                 header names for custom auth
//
// The address table (2.4): https to any host; http only to this PC (loopback, marked local) or to a
// private/LAN address (allowed with the visible warning http_lan, D1); http to a public host is refused;
// cloud metadata hosts and a few non-HTTP ports are refused always. Hosts are judged AFTER the WHATWG URL
// parser has normalised them, so 0x7f.1 or 2130706433 are judged as 127.0.0.1. A host NAME is judged by its
// spelling only: the gateway does not pin resolved addresses, so DNS rebinding of a name is a stated limit.
// For that reason only the bare name localhost counts as this PC; a name under .localhost gets http_lan.
//
// No value is ever stored that looks like a key: every string passes both redaction filters unchanged
// (the gateway's redact() and the provider layer's redactText()). Messages are Dutch first, then English.

import { redact } from '../redact.mjs';
import { redactText } from './redact-guard.mjs';

export const CUSTOM_ID_PREFIX = 'custom-';
export const CUSTOM_VERSION = 1;
export const CUSTOM_LIMITS = Object.freeze({
  MAX_PROVIDERS: 20, SLUG_MAX: 32, LABEL_MAX: 40, URL_MAX: 300, MAX_MODELS: 50, MAX_EXTRA_HEADERS: 8,
  HEADER_NAME_MAX: 64, HEADER_VALUE_MAX: 200, PREFIX_MAX: 32, CONTEXT_MIN: 1024, CONTEXT_MAX: 2_000_000,
});
export const CUSTOM_FORMATS = Object.freeze(['openai-chat', 'openai-responses', 'anthropic']);
export const CUSTOM_AUTH_TYPES = Object.freeze(['none', 'bearer', 'x-api-key', 'api-key-header', 'custom']);
export const CUSTOM_MODEL_MODES = Object.freeze(['endpoint', 'manual']);
export const CUSTOM_ENTRY_KEYS = Object.freeze(['id', 'label', 'format', 'baseURL', 'auth', 'models', 'extraHeaders', 'contextLength', 'enabled', 'created_at', 'updated_at']);
export const BLOCKED_PORTS = new Set([0, 7, 9, 19, 25, 110, 143, 465, 587]);
export const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal']);

const DOC_KEYS = new Set(['version', 'revision', 'providers', 'updated_at']);
const ENTRY_KEY_SET = new Set(CUSTOM_ENTRY_KEYS);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;
// The app router's MODEL_RE (app-router/contract.mjs) and the dashboard form use this same rule, so a stored
// manual model id is always selectable in the router and shown by the form (no @ or +).
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Control characters (C0, DEL, C1), written as escapes so this file stays plain text.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const URL_FORBIDDEN_RE = /[\s{}@#?\\]/;
const HOST_CHARS_RE = /^[a-z0-9._-]+$/;
// Headers that carry credentials: a user may not name one for custom auth or put one in extraHeaders
// (the first set mirrors registry.mjs AUTH_HEADER_NAMES).
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization', 'cookie']);
// Headers the transport owns: never settable by an entry, not even by a compiled mapping.
const FRAMING_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect', 'proxy-connection', 'accept', 'accept-encoding', 'user-agent']);

/** Dutch first, then English. Keys are the error and warning codes. */
export const CUSTOM_MESSAGES = Object.freeze({
  bad_shape: ['De gegevens hebben niet de juiste vorm.', 'The data does not have the right shape.'],
  bad_version: ['Onbekende versie van het bestand met eigen API\'s.', 'Unknown version of the own-API file.'],
  bad_revision: ['Het versienummer klopt niet. Laad de pagina opnieuw.', 'The revision number is not valid. Reload the page.'],
  unknown_key: ['Dit veld is onbekend en wordt niet bewaard.', 'This field is unknown and is not saved.'],
  bad_type: ['Deze waarde heeft het verkeerde type.', 'This value has the wrong type.'],
  bad_id: ['De naam-code moet beginnen met "custom-" en mag alleen kleine letters, cijfers en losse streepjes hebben.', 'The id must start with "custom-" and may only use lower-case letters, digits and single dashes.'],
  duplicate_id: ['Deze naam-code bestaat al.', 'This id already exists.'],
  too_many_providers: ['Maximaal 20 eigen API\'s.', 'At most 20 own APIs.'],
  bad_label: ['Geef een naam van 1 tot 40 tekens, zonder speciale stuurtekens.', 'Give a name of 1 to 40 characters, without control characters.'],
  secret_like_value: ['Dit lijkt op een geheime sleutel. Vul de sleutel alleen in het sleutelveld in.', 'This looks like a secret key. Only enter the key in the key field.'],
  bad_format: ['Kies een van de drie soorten API.', 'Choose one of the three API formats.'],
  bad_url: ['Vul een volledig adres in dat begint met http:// of https://, zonder gebruikersnaam, # of ?.', 'Enter a full address starting with http:// or https://, without a user name, # or ?.'],
  https_required: ['Een adres op internet moet met https:// beginnen. http:// mag alleen op je eigen computer of eigen netwerk.', 'An internet address must start with https://. http:// is only allowed on your own computer or network.'],
  blocked_host: ['Dit adres is niet toegestaan. Gebruik voor je eigen computer 127.0.0.1 of localhost.', 'This address is not allowed. For your own computer use 127.0.0.1 or localhost.'],
  blocked_port: ['Deze poort is voor iets anders dan een API bedoeld en is niet toegestaan.', 'This port is meant for something other than an API and is not allowed.'],
  bad_auth: ['Kies hoe de sleutel wordt meegestuurd.', 'Choose how the key is sent.'],
  bad_header: ['De naam van de kopregel mag alleen letters, cijfers en streepjes hebben en geen standaard aanmeld- of verbindingskopregel zijn.', 'The header name may only use letters, digits and dashes and may not be a standard sign-in or connection header.'],
  bad_prefix: ['Het voorvoegsel mag maximaal 32 gewone tekens hebben.', 'The prefix may have at most 32 plain characters.'],
  duplicate_header: ['Deze kopregel staat er twee keer in.', 'This header is listed twice.'],
  too_many_headers: ['Maximaal 8 extra kopregels.', 'At most 8 extra headers.'],
  bad_header_value: ['De waarde van de kopregel mag maximaal 200 gewone tekens hebben, op een regel.', 'The header value may have at most 200 plain characters, on one line.'],
  bad_models: ['Kies "automatisch ophalen" of vul minstens een model in.', 'Choose "fetch automatically" or enter at least one model.'],
  bad_model: ['Deze modelnaam is niet geldig.', 'This model name is not valid.'],
  duplicate_model: ['Dit model staat er twee keer in.', 'This model is listed twice.'],
  too_many_models: ['Maximaal 50 modellen.', 'At most 50 models.'],
  out_of_range: ['Deze waarde valt buiten het toegestane bereik.', 'This value is outside the allowed range.'],
  http_lan: ['Dit adres is niet versleuteld (http). Gebruik het alleen op je eigen computer of eigen netwerk.', 'This address is not encrypted (http). Only use it on your own computer or your own network.'],
  anthropic_base_v1: ['Laat /v1 aan het eind weg: Forge voegt /v1/messages zelf toe.', 'Leave out /v1 at the end: Forge adds /v1/messages itself.'],
});

export function customMessage(path, code) {
  const [nl, en] = CUSTOM_MESSAGES[code] || CUSTOM_MESSAGES.bad_shape;
  return { path, code, nl, en };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const join = (base, key) => (base ? base + '.' + key : key);
export const isIsoTimestamp = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));

export function emptyCustomDocument() {
  return { version: CUSTOM_VERSION, revision: 0, providers: [], updated_at: null };
}

// ---- ids and the derived key name --------------------------------------------------------------------
export function isCustomId(id) {
  if (typeof id !== 'string' || !id.startsWith(CUSTOM_ID_PREFIX)) return false;
  const slug = id.slice(CUSTOM_ID_PREFIX.length);
  return slug.length > 0 && slug.length <= CUSTOM_LIMITS.SLUG_MAX && SLUG_RE.test(slug);
}

/** custom-mijn-vllm -> CUSTOM_MIJN_VLLM_API_KEY (the desktop vault derives the same name), else null. */
export function customKeyEnvName(id) {
  if (!isCustomId(id)) return null;
  return 'CUSTOM_' + id.slice(CUSTOM_ID_PREFIX.length).toUpperCase().replace(/-/g, '_') + '_API_KEY';
}

/** A valid slug from any display name (accents dropped, other characters become dashes); 'api' when empty. */
export function slugFromLabel(label) {
  const base = String(label == null ? '' : label).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = base.slice(0, CUSTOM_LIMITS.SLUG_MAX).replace(/-+$/g, '');
  return cut || 'api';
}

/** custom-<slug of label>, with -2, -3 ... when taken; always a valid custom id. */
export function uniqueCustomId(label, takenIds = []) {
  const taken = new Set(takenIds);
  const slug = slugFromLabel(label);
  if (!taken.has(CUSTOM_ID_PREFIX + slug)) return CUSTOM_ID_PREFIX + slug;
  for (let n = 2; n < 1000; n += 1) {
    const tail = '-' + n;
    const id = CUSTOM_ID_PREFIX + slug.slice(0, CUSTOM_LIMITS.SLUG_MAX - tail.length).replace(/-+$/g, '') + tail;
    if (!taken.has(id)) return id;
  }
  return null;
}

// ---- header names ------------------------------------------------------------------------------------
/** The rule for a header NAME a user types (custom auth or an extra header): 'bad_header' or null. */
export function customAuthHeaderProblem(name) {
  if (typeof name !== 'string' || !HEADER_NAME_RE.test(name)) return 'bad_header';
  const lower = name.toLowerCase();
  return AUTH_HEADERS.has(lower) || FRAMING_HEADERS.has(lower) ? 'bad_header' : null;
}

/** Runtime guard for where a key may be put: a plain name that the transport does not own. */
export function isSafeAuthHeaderTarget(name) {
  return typeof name === 'string' && HEADER_NAME_RE.test(name) && !FRAMING_HEADERS.has(name.toLowerCase());
}

/** Runtime guard for a custom auth prefix: plain printable characters only, at most PREFIX_MAX. */
export function isSafeAuthPrefix(prefix) {
  return typeof prefix === 'string' && prefix.length <= CUSTOM_LIMITS.PREFIX_MAX && HEADER_VALUE_RE.test(prefix);
}

// ---- the address table (2.4) -------------------------------------------------------------------------
function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function parseIPv6(host) {
  if (!host.startsWith('[') || !host.endsWith(']')) return null;
  const body = host.slice(1, -1);
  if (!/^[0-9a-f:]+$/.test(body)) return null; // the URL parser already rewrote any dotted tail to hex
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const read = (s) => (s === '' ? [] : s.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const words = [...head, ...Array(Math.max(0, fill)).fill(0), ...tail];
  return words.length === 8 && words.every((w) => Number.isInteger(w)) ? words : null;
}

function classifyIPv4([a, b, c, d]) {
  if (a === 0 || a >= 224) return 'blocked'; // "this network", multicast, reserved, broadcast
  if (a === 169 && b === 254) return 'blocked'; // link-local: home of the cloud metadata services
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'blocked';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
  return 'public';
}

function classifyIPv6(w) {
  const zeros = (from, to) => w.slice(from, to).every((x) => x === 0);
  const v4 = () => [w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255];
  if (zeros(0, 8)) return 'blocked';
  if (zeros(0, 7) && w[7] === 1) return 'loopback';
  if (zeros(0, 5) && w[5] === 0xffff) return classifyIPv4(v4()); // IPv4-mapped
  if (zeros(0, 6)) return classifyIPv4(v4()); // IPv4-compatible (deprecated): judged as the IPv4 inside
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return classifyIPv4(v4()); // NAT64 well-known prefix
  if (w[0] === 0xfd00 && w[1] === 0x0ec2 && zeros(2, 7) && w[7] === 0x254) return 'blocked'; // AWS IMDS over IPv6
  if ((w[0] & 0xff00) === 0xff00) return 'blocked'; // multicast
  if ((w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80) return 'lan'; // unique local, link-local
  return 'public';
}

// Only the bare name localhost is this PC (the operating system answers it itself). A name UNDER .localhost
// (ollama.localhost) goes to whatever a resolver or the hosts file says, and the gateway does not resolve or pin
// names, so it is judged like a home-network name: http allowed with the http_lan warning, never marked local.
function classifyName(host) {
  if (BLOCKED_HOSTS.has(host)) return 'blocked';
  if (host === 'localhost') return 'loopback';
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.localhost')) return 'lan';
  return 'public';
}

function classifyHost(host) {
  const v4 = parseIPv4(host);
  if (v4) return classifyIPv4(v4);
  if (host.startsWith('[')) {
    const v6 = parseIPv6(host);
    return v6 ? classifyIPv6(v6) : 'invalid';
  }
  if (!HOST_CHARS_RE.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return 'invalid';
  return classifyName(host);
}

/**
 * Judges a base URL against the 2.4 table.
 * @returns {{ok: true, url: string, urlClass: 'https'|'loopback'|'lan', local: boolean, warnings: string[]}
 *   | {ok: false, code: 'bad_url'|'https_required'|'blocked_host'|'blocked_port'}}
 *   url is the normalised form that is stored and used (lower-case host, no default port, no trailing slash).
 */
export function checkCustomURL(raw) {
  const bad = (code) => ({ ok: false, code });
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CUSTOM_LIMITS.URL_MAX) return bad('bad_url');
  if (URL_FORBIDDEN_RE.test(raw) || CONTROL_RE.test(raw) || !/^https?:\/\/[^/]/i.test(raw)) return bad('bad_url');
  let u;
  try { u = new URL(raw); } catch { return bad('bad_url'); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return bad('bad_url');
  const host = u.hostname;
  const kind = classifyHost(host);
  if (kind === 'invalid') return bad('bad_url');
  if (kind === 'blocked') return bad('blocked_host');
  const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
  if (BLOCKED_PORTS.has(port)) return bad('blocked_port');
  const url = u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '');
  if (u.protocol === 'https:') return { ok: true, url, urlClass: 'https', local: false, warnings: [] };
  if (kind === 'loopback') return { ok: true, url, urlClass: 'loopback', local: true, warnings: [] };
  if (kind === 'lan') return { ok: true, url, urlClass: 'lan', local: false, warnings: ['http_lan'] };
  return bad('https_required');
}

// ---- entry and document validation -------------------------------------------------------------------
function looksSecret(value) {
  return redact(value) !== value || redactText(value) !== value;
}

// Every string must pass both redaction filters unchanged. The base URL's host is exempt from the broad
// gateway filter only: its three-dotted-part shape would read a long host name such as
// inference-server01.homelab-network.internalzone as a bot token. The path is scanned by both.
function secretScan(value, path, errors) {
  if (typeof value === 'string') {
    if (looksSecret(value)) errors.push(customMessage(path, 'secret_like_value'));
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => secretScan(v, path + '[' + i + ']', errors)); return; }
  if (isObj(value)) for (const [k, v] of Object.entries(value)) secretScan(v, join(path, k), errors);
}

function scanBaseURL(raw, path, errors) {
  if (typeof raw !== 'string') return;
  let pathname = '';
  try { pathname = new URL(raw).pathname; } catch { pathname = raw; }
  if (redactText(raw) !== raw || redact(pathname) !== pathname) errors.push(customMessage(path, 'secret_like_value'));
}

function checkLabel(label, path, errors) {
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > CUSTOM_LIMITS.LABEL_MAX || CONTROL_RE.test(label)) {
    errors.push(customMessage(path, 'bad_label'));
  }
}

function checkAuth(auth, path, errors) {
  if (!isObj(auth) || !CUSTOM_AUTH_TYPES.includes(auth.type)) { errors.push(customMessage(join(path, 'type'), 'bad_auth')); return null; }
  const allowed = auth.type === 'custom' ? new Set(['type', 'header', 'prefix']) : new Set(['type']);
  for (const k of Object.keys(auth)) if (!allowed.has(k)) errors.push(customMessage(join(path, k), 'unknown_key'));
  if (auth.type !== 'custom') return null;
  if (customAuthHeaderProblem(auth.header)) errors.push(customMessage(join(path, 'header'), 'bad_header'));
  if (auth.prefix !== undefined && !isSafeAuthPrefix(auth.prefix)) errors.push(customMessage(join(path, 'prefix'), 'bad_prefix'));
  return typeof auth.header === 'string' ? auth.header.toLowerCase() : null;
}

function checkModels(models, path, errors) {
  if (!isObj(models) || !CUSTOM_MODEL_MODES.includes(models.mode)) { errors.push(customMessage(path, 'bad_models')); return; }
  const allowed = models.mode === 'manual' ? new Set(['mode', 'ids']) : new Set(['mode']);
  for (const k of Object.keys(models)) if (!allowed.has(k)) errors.push(customMessage(join(path, k), 'unknown_key'));
  if (models.mode !== 'manual') return;
  if (!Array.isArray(models.ids) || models.ids.length === 0) { errors.push(customMessage(join(path, 'ids'), 'bad_models')); return; }
  if (models.ids.length > CUSTOM_LIMITS.MAX_MODELS) errors.push(customMessage(join(path, 'ids'), 'too_many_models'));
  const seen = new Set();
  models.ids.forEach((id, i) => {
    const at = join(path, 'ids') + '[' + i + ']';
    if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) errors.push(customMessage(at, 'bad_model'));
    else if (seen.has(id)) errors.push(customMessage(at, 'duplicate_model'));
    seen.add(id);
  });
}

function checkExtraHeaders(headers, path, authHeader, errors) {
  if (!isObj(headers)) { errors.push(customMessage(path, 'bad_type')); return; }
  const names = Object.keys(headers);
  if (names.length > CUSTOM_LIMITS.MAX_EXTRA_HEADERS) errors.push(customMessage(path, 'too_many_headers'));
  const seen = new Set(authHeader ? [authHeader] : []);
  for (const name of names) {
    const at = join(path, name);
    if (customAuthHeaderProblem(name)) { errors.push(customMessage(at, 'bad_header')); continue; }
    if (seen.has(name.toLowerCase())) errors.push(customMessage(at, 'duplicate_header'));
    seen.add(name.toLowerCase());
    const v = headers[name];
    if (typeof v !== 'string' || v.length > CUSTOM_LIMITS.HEADER_VALUE_MAX || !HEADER_VALUE_RE.test(v)) errors.push(customMessage(at, 'bad_header_value'));
  }
}

/**
 * Validates one overlay entry. Never throws.
 * @param {unknown} def
 * @param {{path?: string}} [opts] path prefix for the error paths (e.g. 'providers[2]')
 * @returns {{errors: Array<{path,code,nl,en}>, warnings: Array<{path,code,nl,en}>}}
 */
export function validateCustomProvider(def, { path = '' } = {}) {
  const errors = [];
  const warnings = [];
  if (!isObj(def)) return { errors: [customMessage(path, 'bad_shape')], warnings };
  for (const k of Object.keys(def)) if (!ENTRY_KEY_SET.has(k)) errors.push(customMessage(join(path, k), 'unknown_key'));
  if (!isCustomId(def.id)) errors.push(customMessage(join(path, 'id'), 'bad_id'));
  checkLabel(def.label, join(path, 'label'), errors);
  if (!CUSTOM_FORMATS.includes(def.format)) errors.push(customMessage(join(path, 'format'), 'bad_format'));
  const url = checkCustomURL(def.baseURL);
  if (!url.ok) errors.push(customMessage(join(path, 'baseURL'), url.code));
  else {
    for (const w of url.warnings) warnings.push(customMessage(join(path, 'baseURL'), w));
    if (def.format === 'anthropic' && /\/v1$/i.test(url.url)) warnings.push(customMessage(join(path, 'baseURL'), 'anthropic_base_v1'));
  }
  scanBaseURL(def.baseURL, join(path, 'baseURL'), errors);
  const authHeader = checkAuth(def.auth, join(path, 'auth'), errors);
  checkModels(def.models, join(path, 'models'), errors);
  checkExtraHeaders(def.extraHeaders === undefined ? {} : def.extraHeaders, join(path, 'extraHeaders'), authHeader, errors);
  const ctx = def.contextLength;
  if (ctx !== undefined && ctx !== null && !(Number.isInteger(ctx) && ctx >= CUSTOM_LIMITS.CONTEXT_MIN && ctx <= CUSTOM_LIMITS.CONTEXT_MAX)) {
    errors.push(customMessage(join(path, 'contextLength'), 'out_of_range'));
  }
  if (typeof def.enabled !== 'boolean') errors.push(customMessage(join(path, 'enabled'), 'bad_type'));
  for (const k of ['created_at', 'updated_at']) {
    if (def[k] !== undefined && def[k] !== null && !isIsoTimestamp(def[k])) errors.push(customMessage(join(path, k), 'bad_type'));
  }
  const { baseURL, ...rest } = def;
  secretScan(rest, path, errors);
  return { errors, warnings };
}

/**
 * Validates a whole custom.json document. Never throws.
 * @returns {{ok: boolean, errors: Array<{path,code,nl,en}>, warnings: Array<{path,code,nl,en}>}}
 */
export function validateCustomDocument(doc) {
  const errors = [];
  const warnings = [];
  if (!isObj(doc)) return { ok: false, errors: [customMessage('', 'bad_shape')], warnings };
  for (const k of Object.keys(doc)) if (!DOC_KEYS.has(k)) errors.push(customMessage(k, 'unknown_key'));
  if (doc.version !== CUSTOM_VERSION) errors.push(customMessage('version', 'bad_version'));
  if (!Number.isInteger(doc.revision) || doc.revision < 0) errors.push(customMessage('revision', 'bad_revision'));
  if (doc.updated_at !== undefined && doc.updated_at !== null && !isIsoTimestamp(doc.updated_at)) errors.push(customMessage('updated_at', 'bad_type'));
  if (!Array.isArray(doc.providers)) {
    errors.push(customMessage('providers', 'bad_shape'));
    return { ok: false, errors, warnings };
  }
  if (doc.providers.length > CUSTOM_LIMITS.MAX_PROVIDERS) errors.push(customMessage('providers', 'too_many_providers'));
  const ids = new Set();
  doc.providers.forEach((p, i) => {
    const at = 'providers[' + i + ']';
    const r = validateCustomProvider(p, { path: at });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (isObj(p) && typeof p.id === 'string') {
      if (ids.has(p.id)) errors.push(customMessage(at + '.id', 'duplicate_id'));
      ids.add(p.id);
    }
  });
  return { ok: errors.length === 0, errors, warnings };
}
