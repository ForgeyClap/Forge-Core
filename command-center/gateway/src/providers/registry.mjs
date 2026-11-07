// Registry loader. Call loadRegistry() once at gateway startup: it validates EVERY entry against
// registry.schema.json plus the semantic rules below and throws one RegistryError that lists every
// problem (fail loud), so a bad entry can never be half-loaded or silently skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './schema-validate.mjs';
import { ProviderError, ERROR_CODES } from './redact-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_FILE = path.join(HERE, 'registry.json');
export const REGISTRY_SCHEMA_FILE = path.join(HERE, 'registry.schema.json');

const AUTH_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization', 'cookie']);
const KEYED_AUTH = new Set(['bearer', 'bearer-optional', 'bearer-or-x-api-key', 'api-key-header', 'x-goog-api-key']);
const KEYLESS_AUTH = new Set(['none', 'cli-managed']);
const CLI_ADAPTERS = new Set(['cli-claude', 'cli-codex', 'cli-generic']);
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/;
const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;
// Shapes that must never appear anywhere in the registry file (keys are read at call time only).
const SECRET_SHAPE_RE = /\b(sk-[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|xai-[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{10,}|AKIA[A-Z0-9]{12,})/;

export class RegistryError extends Error {
  constructor(problems) {
    super('provider registry is invalid (' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') + '):\n  - ' + problems.join('\n  - '));
    this.name = 'RegistryError';
    this.problems = problems;
  }
}

export function placeholdersOf(baseURL) {
  if (typeof baseURL !== 'string') return [];
  return [...baseURL.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

// Semantic rules a JSON Schema cannot express. Returns problems for one entry.
export function semanticProblems(p) {
  const out = [];
  const isCli = CLI_ADAPTERS.has(p.adapter);
  if (isCli) {
    if (p.baseURL !== null) out.push('CLI adapters have baseURL null');
    if (p.authType !== 'cli-managed') out.push('CLI adapters use authType cli-managed');
    if (!p.command) out.push('CLI adapters need a command');
    if (p.testCall && p.testCall !== 'cli-version') out.push('CLI adapters use testCall cli-version');
  } else {
    if (typeof p.baseURL !== 'string') out.push('HTTP adapters need a baseURL');
    if (p.command || p.cliArgs) out.push('command/cliArgs are only for CLI adapters');
    if (p.testCall === 'cli-version') out.push('testCall cli-version is only for CLI adapters');
  }
  if (p.adapter === 'openai-compatible' && !p.apiStyle) out.push('openai-compatible needs apiStyle');
  if ((p.adapter === 'anthropic' || p.adapter === 'gemini-native' || isCli) && p.apiStyle !== null) out.push('apiStyle must be null for adapter ' + p.adapter);
  if (KEYED_AUTH.has(p.authType) && !p.keyEnvName) out.push('authType ' + p.authType + ' needs keyEnvName');
  if (KEYLESS_AUTH.has(p.authType) && p.keyEnvName !== null) out.push('authType ' + p.authType + ' must have keyEnvName null');
  if (typeof p.baseURL === 'string') {
    if (p.local && !LOOPBACK_RE.test(p.baseURL)) out.push('local providers must point at a loopback http:// address');
    if (!p.local && !p.baseURL.startsWith('https://')) out.push('remote providers must use https://');
    const used = placeholdersOf(p.baseURL);
    const declared = Object.keys(p.templateVars || {});
    for (const v of used) if (!declared.includes(v)) out.push('baseURL uses {' + v + '} but templateVars does not declare it');
    for (const v of declared) if (!used.includes(v)) out.push('templateVars declares ' + v + ' but baseURL does not use it');
    for (const [name, spec] of Object.entries(p.templateVars || {})) {
      let re;
      try { re = new RegExp(spec.pattern); } catch { out.push('templateVars.' + name + '.pattern is not a valid regex'); continue; }
      if (!spec.pattern.startsWith('^') || !spec.pattern.endsWith('$')) out.push('templateVars.' + name + '.pattern must be anchored with ^...$');
      if (spec.default !== undefined && !re.test(spec.default)) out.push('templateVars.' + name + '.default does not match its pattern');
    }
  }
  if (p.modelsMode === 'endpoint' && !p.modelsEndpoint) out.push('modelsMode endpoint needs modelsEndpoint');
  if (p.modelsMode === 'static' && !Array.isArray(p.staticModels)) out.push('modelsMode static needs staticModels (may be empty)');
  if (p.modelsMode !== 'endpoint' && p.modelsEndpoint) out.push('modelsEndpoint is only used with modelsMode endpoint');
  if (p.modelsMode !== 'endpoint' && p.testCall === 'models') out.push('testCall models needs modelsMode endpoint');
  for (const h of Object.keys(p.extraHeaders || {})) if (AUTH_HEADER_NAMES.has(h.toLowerCase())) out.push('extraHeaders must not carry the auth header ' + h);
  for (const h of Object.keys(p.optionalHeaderEnv || {})) if (AUTH_HEADER_NAMES.has(h.toLowerCase())) out.push('optionalHeaderEnv must not carry the auth header ' + h);
  if (p.subscription && !p.tosNote) out.push('subscription providers need a tosNote');
  if (p.subscription && !p.noticeRequired) out.push('subscription providers need noticeRequired true');
  if (p.adapter === 'anthropic') {
    const v = (p.extraHeaders || {})['anthropic-version'];
    if (!v) out.push('anthropic needs extraHeaders.anthropic-version');
  }
  return out;
}

// Validates a parsed registry document. Returns problems (empty = valid).
export function validateRegistryDocument(doc, schema) {
  const problems = validate(schema, doc, 'registry');
  if (problems.length > 0) return problems; // shape errors first; semantic rules assume the shape
  const seen = new Set();
  doc.providers.forEach((p, i) => {
    const at = 'providers[' + i + '] id=' + p.id + ': ';
    if (seen.has(p.id)) problems.push(at + 'duplicate id');
    seen.add(p.id);
    for (const msg of semanticProblems(p)) problems.push(at + msg);
  });
  const text = JSON.stringify(doc);
  if (SECRET_SHAPE_RE.test(text)) problems.push('registry contains a value shaped like an API key; keys belong in the KeyProvider, never in this file');
  return problems;
}

function readJSON(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) { throw new RegistryError([label + ' cannot be read (' + (err.code || 'error') + ')']); }
  try { return JSON.parse(text); }
  catch (err) { throw new RegistryError([label + ' is not valid JSON: ' + err.message]); }
}

let cached = null;

// Loads and validates. Throws RegistryError listing every problem. The result is frozen.
export function loadRegistry({ file = REGISTRY_FILE, schemaFile = REGISTRY_SCHEMA_FILE, useCache = true } = {}) {
  if (useCache && cached && cached.file === file) return cached.registry;
  const schema = readJSON(schemaFile, 'registry.schema.json');
  const doc = readJSON(file, path.basename(file));
  const problems = validateRegistryDocument(doc, schema);
  if (problems.length > 0) throw new RegistryError(problems);
  const byId = new Map(doc.providers.map((p) => [p.id, deepFreeze(structuredClone(p))]));
  const registry = Object.freeze({
    schema: doc.schema,
    providers: Object.freeze([...byId.values()]),
    get(id) { return byId.get(id) || null; },
    ids() { return [...byId.keys()]; },
  });
  if (useCache) cached = { file, registry };
  return registry;
}

export function _resetRegistryCacheForTests() {
  cached = null;
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

// Fills {var} placeholders from vars, then from the declared default. Every value must match the
// declared anchored pattern, so a value can never inject a different host or path.
export function resolveBaseURL(entry, vars = {}) {
  if (typeof entry.baseURL !== 'string') return null;
  const specs = entry.templateVars || {};
  const missing = [];
  const url = entry.baseURL.replace(PLACEHOLDER_RE, (whole, name) => {
    const spec = specs[name];
    const value = vars[name] !== undefined && vars[name] !== null && vars[name] !== '' ? String(vars[name]) : spec && spec.default;
    if (value === undefined) { missing.push(name); return whole; }
    if (!spec || !new RegExp(spec.pattern).test(value)) {
      throw new ProviderError(ERROR_CODES.CONFIG, 'value for {' + name + '} does not match ' + (spec ? spec.pattern : 'a declared pattern'), { provider: entry.id });
    }
    return value;
  });
  if (missing.length > 0) {
    throw new ProviderError(ERROR_CODES.NOT_CONFIGURED, 'set ' + missing.map((m) => '{' + m + '}').join(', ') + ' for ' + entry.label, { provider: entry.id });
  }
  return url.replace(/\/+$/, '');
}
