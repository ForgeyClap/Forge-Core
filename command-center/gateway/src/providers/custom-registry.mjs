// "Eigen API" merged registry (ANY-MODEL-PLAN 2.2 A): the bundled catalogue (registry.json, loaded and
// validated by registry.mjs, fail loud, untouched) plus the user's own entries from custom.json.
//
//   compileCustomEntry(def)   one stored definition -> a normal registry entry the existing adapters run
//   loadMergedRegistry()      bundled + compiled overlay; the same frozen object until the store changes
//   verifyCustomTarget(entry) re-reads the saved definition right before an outbound call: the address in
//                             memory must still equal the saved, re-validated address
//
// Rules: ids custom-* (and key names CUSTOM_*_API_KEY) are reserved for the overlay; a bundled entry in
// that namespace fails loud like any other bundled problem. A broken or refused overlay never takes the
// bundled providers down: its problems are reported in `custom`, and only valid, enabled entries join.
// The compiled entry passes registry.mjs semanticProblems(), except the shipped catalogue's own address
// policy ("local = 127.0.0.1/localhost/[::1] over http, remote = https"): for a custom entry that policy is
// replaced by the 2.4 table in custom-rules.mjs (Lead decision D1: LAN http allowed with a warning).

import { loadRegistry, semanticProblems, RegistryError } from './registry.mjs';
import {
  checkCustomURL, customKeyEnvName, customMessage, validateCustomProvider, isCustomId, CUSTOM_ID_PREFIX,
} from './custom-rules.mjs';
import { readCustomProviders, customStoreStamp } from './custom-store.mjs';

const RESERVED_KEY_RE = /^CUSTOM_.*_API_KEY$/;
const ADDRESS_POLICY_PROBLEMS = new Set([
  'local providers must point at a loopback http:// address',
  'remote providers must use https://',
]);
const FALLBACK_ANTHROPIC_VERSION = '2023-06-01';
const SECRET_SHAPE_RE = /\b(sk-[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|xai-[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{10,}|AKIA[A-Z0-9]{12,})/;

const FORMAT_MAP = Object.freeze({
  'openai-chat': { adapter: 'openai-compatible', apiStyle: 'chat-completions', modelsEndpoint: '/models' },
  'openai-responses': { adapter: 'openai-compatible', apiStyle: 'responses', modelsEndpoint: '/models' },
  anthropic: { adapter: 'anthropic', apiStyle: null, modelsEndpoint: '/v1/models' },
});

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export function isCustomEntry(entry) {
  return !!entry && entry.source === 'custom' && isCustomId(entry.id);
}

// How the key is sent, per format. x-api-key on an OpenAI-style server is a custom header named x-api-key;
// on the anthropic adapter it is that adapter's own authHeaderMode.
function authFields(def) {
  const type = def.auth.type;
  const keyEnvName = type === 'none' ? null : customKeyEnvName(def.id);
  if (type === 'none') return { authType: 'none', keyEnvName };
  if (def.format === 'anthropic' && (type === 'bearer' || type === 'x-api-key')) {
    return { authType: 'bearer-or-x-api-key', keyEnvName, authHeaderMode: type };
  }
  if (type === 'bearer') return { authType: 'bearer', keyEnvName };
  if (type === 'api-key-header') return { authType: 'api-key-header', keyEnvName };
  if (type === 'x-api-key') return { authType: 'custom-header', keyEnvName, customAuth: { header: 'x-api-key', prefix: '' } };
  return { authType: 'custom-header', keyEnvName, customAuth: { header: def.auth.header, prefix: def.auth.prefix || '' } };
}

/**
 * Compiles one stored definition into a registry entry for the existing adapters.
 * @param {object} def        a stored overlay entry
 * @param {{bundled?: object}} [opts] the bundled registry (for the anthropic-version header)
 * @returns {{entry: object|null, problems: Array<{path,code,nl,en}>}} entry is frozen; null when refused
 */
export function compileCustomEntry(def, { bundled = null } = {}) {
  const v = validateCustomProvider(def);
  if (v.errors.length > 0) return { entry: null, problems: v.errors };
  const url = checkCustomURL(def.baseURL);
  const fmt = FORMAT_MAP[def.format];
  const manual = def.models.mode === 'manual';
  const extraHeaders = { ...(def.extraHeaders || {}) };
  if (def.format === 'anthropic' && !Object.keys(extraHeaders).some((h) => h.toLowerCase() === 'anthropic-version')) {
    const shipped = bundled && bundled.get('anthropic');
    extraHeaders['anthropic-version'] = (shipped && shipped.extraHeaders && shipped.extraHeaders['anthropic-version']) || FALLBACK_ANTHROPIC_VERSION;
  }
  const entry = {
    id: def.id, label: def.label, adapter: fmt.adapter, apiStyle: fmt.apiStyle, baseURL: url.url,
    ...authFields(def), extraHeaders,
    modelsMode: manual ? 'static' : 'endpoint', modelsEndpoint: manual ? null : fmt.modelsEndpoint,
    ...(manual ? { staticModels: [...def.models.ids] } : {}),
    testCall: manual ? 'chat-1-token' : 'models',
    streaming: 'unverified', toolCalling: 'unverified', local: url.local, subscription: false, noticeRequired: false,
    tosNote: null, caveat: null, docsURL: null, verifiedOn: null, verification: 'user',
    source: 'custom', urlClass: url.urlClass, warnings: [...url.warnings], contextLength: def.contextLength ?? null,
  };
  const problems = semanticProblems(entry).filter((m) => !ADDRESS_POLICY_PROBLEMS.has(m));
  if (SECRET_SHAPE_RE.test(JSON.stringify(entry))) problems.push('the entry contains a value shaped like an API key');
  if (problems.length > 0) {
    return { entry: null, problems: problems.map((m) => ({ ...customMessage('', 'bad_shape'), en: 'The entry cannot be used: ' + m })) };
  }
  return { entry: deepFreeze(entry), problems: [] };
}

function reservedProblems(bundled) {
  const out = [];
  for (const p of bundled.providers) {
    if (typeof p.id === 'string' && p.id.startsWith(CUSTOM_ID_PREFIX)) out.push('bundled provider id ' + p.id + ' uses the custom- prefix, which is reserved for the user overlay');
    if (typeof p.keyEnvName === 'string' && RESERVED_KEY_RE.test(p.keyEnvName)) out.push('bundled provider ' + p.id + ' uses key name ' + p.keyEnvName + ', which is reserved for the user overlay (CUSTOM_*_API_KEY)');
  }
  return out;
}

function buildMerged(bundled, overlay) {
  const byId = new Map(bundled.providers.map((p) => [p.id, p]));
  const ids = [];
  const disabled = [];
  const warnings = {};
  const problems = overlay.errors.map((e) => ({ id: null, ...e }));
  for (const def of overlay.doc.providers) {
    if (def.enabled !== true) { disabled.push(def.id); continue; }
    const { entry, problems: p } = compileCustomEntry(def, { bundled });
    if (!entry) { for (const e of p) problems.push({ id: def.id, ...e }); continue; }
    byId.set(entry.id, entry);
    ids.push(entry.id);
    warnings[entry.id] = [...entry.warnings];
  }
  const providers = [...byId.values()];
  return deepFreeze({
    schema: bundled.schema,
    providers,
    get(id) { return byId.get(id) || null; },
    ids() { return [...byId.keys()]; },
    bundled,
    custom: { provenance: overlay.provenance, revision: overlay.doc.revision, ids, disabled, warnings, problems },
  });
}

let cache = null; // { bundled, stamp, merged }

/**
 * The bundled registry plus the enabled, valid overlay entries. Throws RegistryError only for a bundled
 * problem (fail loud, as loadRegistry does). Cached until the store stamp or the bundled object changes.
 * @param {{loadBundled?: Function, readOverlay?: Function, stamp?: Function, useCache?: boolean}} [opts]
 */
export function loadMergedRegistry({ loadBundled = loadRegistry, readOverlay = readCustomProviders, stamp = customStoreStamp, useCache = true } = {}) {
  const bundled = loadBundled();
  const reserved = reservedProblems(bundled);
  if (reserved.length > 0) throw new RegistryError(reserved);
  const s = stamp();
  if (useCache && cache && cache.bundled === bundled && cache.stamp === s) return cache.merged;
  const merged = buildMerged(bundled, readOverlay());
  if (useCache) cache = { bundled, stamp: s, merged };
  return merged;
}

export function _resetMergedRegistryCacheForTests() {
  cache = null;
}

const TARGET_MESSAGES = Object.freeze({
  target_missing: ['Deze eigen API bestaat niet meer.', 'This own API no longer exists.'],
  target_disabled: ['Deze eigen API staat uit.', 'This own API is turned off.'],
  target_changed: ['Het adres van deze eigen API is gewijzigd. Sla hem opnieuw op en test opnieuw.', 'The address of this own API changed. Save it again and test again.'],
});

/**
 * Right before an outbound call for a custom entry: the saved definition is read again and its address,
 * re-judged by the 2.4 table, must equal the address the entry in memory will call. Bundled entries pass.
 * @returns {{ok: true} | {ok: false, code: 'target_missing'|'target_disabled'|'target_changed', nl: string, en: string}}
 */
export function verifyCustomTarget(entry, { readOverlay = readCustomProviders } = {}) {
  if (!entry || !isCustomId(entry.id)) return { ok: true };
  const refuse = (code) => ({ ok: false, code, nl: TARGET_MESSAGES[code][0], en: TARGET_MESSAGES[code][1] });
  const def = readOverlay().doc.providers.find((p) => p.id === entry.id);
  if (!def) return refuse('target_missing');
  if (def.enabled !== true) return refuse('target_disabled');
  const url = checkCustomURL(def.baseURL);
  if (!url.ok || url.url !== entry.baseURL) return refuse('target_changed');
  return { ok: true };
}
