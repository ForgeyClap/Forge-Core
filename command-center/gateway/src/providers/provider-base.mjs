// BaseProvider: the uniform Provider interface every adapter implements.
//
//   info()                     -> public descriptor for an Accounts card (no secrets, ever)
//   health()                   -> cheap readiness. Remote providers: NO network call, only "is a key /
//                                 every template value present". Local servers and CLIs: a reachability
//                                 or detection probe. Never sends a key anywhere.
//   listModels()               -> { models: [{ id, label?, ownedBy?, contextLength? }], source, note? }
//   testConnection({ model? }) -> the cheapest authenticated call of the family (catalogue section 5)
//   chat(request)              -> async iterator of normalised events (events.mjs). Never throws: every
//                                 failure, including a missing key, becomes one { type: 'error' } event.
//
// Result states used by health()/testConnection(): connected | configured | reachable | not-configured |
// auth-failed | unreachable | needs-model | not-found | rate-limited | error | not-implemented |
// not-installed | not-connected | signed-in.

import { resolveBaseURL } from './registry.mjs';
import { isKeyProvider } from './key-provider.mjs';
import { ProviderError, ERROR_CODES, toErrorEvent, redactText } from './redact-guard.mjs';
import { validateChatRequest } from './events.mjs';
import { DEFAULTS } from './http.mjs';
import { isSafeAuthHeaderTarget, isSafeAuthPrefix } from './custom-rules.mjs';

// Auth types for which health() reports a missing key. 'custom-header' ("Eigen API", ANY-MODEL-PLAN 2.2 B)
// sends the vault key in a header the entry names, with an optional fixed prefix.
const KEY_REQUIRED_AUTH = Object.freeze(['bearer', 'bearer-or-x-api-key', 'api-key-header', 'x-goog-api-key', 'custom-header']);

export class BaseProvider {
  constructor(entry, { keyProvider, vars = {}, timeouts = {}, authHeaderMode = 'bearer', transport = {} } = {}) {
    if (!entry || typeof entry.id !== 'string') throw new TypeError('BaseProvider: registry entry required');
    if (!isKeyProvider(keyProvider)) throw new TypeError('BaseProvider: a KeyProvider is required (use EnvKeyProvider)');
    this.entry = entry;
    this.keyProvider = keyProvider;
    this.vars = { ...vars };
    this.timeouts = { ...DEFAULTS, ...timeouts };
    this.authHeaderMode = authHeaderMode; // anthropic only: 'bearer' (default) or 'x-api-key'
    this.transport = transport; // test seam: { sleep, random } for retry timing
  }

  get id() { return this.entry.id; }

  info() {
    const e = this.entry;
    let baseURL = e.baseURL;
    try { baseURL = resolveBaseURL(e, this.vars); } catch { /* keep the template so the card can show what is missing */ }
    return {
      id: e.id, label: e.label, adapter: e.adapter, apiStyle: e.apiStyle, baseURL,
      authType: e.authType, keyEnvName: e.keyEnvName, keySource: this.keyProvider.describe().kind,
      modelsMode: e.modelsMode, streaming: e.streaming, toolCalling: e.toolCalling,
      local: e.local, subscription: e.subscription, noticeRequired: e.noticeRequired,
      tosNote: e.tosNote, caveat: e.caveat || null, verification: e.verification, verifiedOn: e.verifiedOn, docsURL: e.docsURL,
    };
  }

  baseURL() {
    return resolveBaseURL(this.entry, this.vars);
  }

  // Missing template values, without throwing.
  missingVars() {
    try { this.baseURL(); return []; }
    catch (err) { return [err.message]; }
  }

  async _key({ required }) {
    const name = this.entry.keyEnvName;
    if (!name) return null;
    const key = await this.keyProvider.getKey(name);
    if (!key && required) {
      throw new ProviderError(ERROR_CODES.NOT_CONFIGURED, 'no API key: set ' + name + ' for ' + this.entry.label, { provider: this.id });
    }
    return key;
  }

  async authHeaders() {
    const e = this.entry;
    const headers = { ...e.extraHeaders };
    for (const [header, envName] of Object.entries(e.optionalHeaderEnv || {})) {
      const v = await this.keyProvider.getKey(envName);
      if (v) headers[header] = v;
    }
    switch (e.authType) {
      case 'none':
      case 'cli-managed':
        break;
      case 'bearer': headers.authorization = 'Bearer ' + await this._key({ required: true }); break;
      case 'bearer-optional': {
        const k = await this._key({ required: false });
        if (k) headers.authorization = 'Bearer ' + k;
        break;
      }
      case 'bearer-or-x-api-key': {
        const k = await this._key({ required: true });
        if (this.authHeaderMode === 'x-api-key') headers['x-api-key'] = k; else headers.authorization = 'Bearer ' + k;
        break;
      }
      case 'api-key-header': headers['api-key'] = await this._key({ required: true }); break;
      case 'x-goog-api-key': headers['x-goog-api-key'] = await this._key({ required: true }); break;
      case 'custom-header': {
        // The header name and prefix come from the entry and are checked again here (never a header the
        // transport owns, never a line break); the value is always the key from the KeyProvider.
        const spec = e.customAuth;
        if (!spec || !isSafeAuthHeaderTarget(spec.header) || !isSafeAuthPrefix(spec.prefix)) {
          throw new ProviderError(ERROR_CODES.CONFIG, 'the custom auth header of ' + e.label + ' is not valid; edit and save it again', { provider: this.id });
        }
        headers[spec.header.toLowerCase()] = spec.prefix + await this._key({ required: true });
        break;
      }
      default: throw new ProviderError(ERROR_CODES.CONFIG, 'unknown authType ' + e.authType, { provider: this.id });
    }
    return headers;
  }

  // Default health for remote HTTP providers: configuration only, no network.
  async health() {
    const missing = this.missingVars();
    const needsKey = KEY_REQUIRED_AUTH.includes(this.entry.authType);
    const key = needsKey ? await this._key({ required: false }) : null;
    const problems = [...missing];
    if (needsKey && !key) problems.push('no API key: set ' + this.entry.keyEnvName);
    return problems.length > 0
      ? { ok: false, state: 'not-configured', network: false, detail: redactText(problems.join('; ')) }
      : { ok: true, state: 'configured', network: false, detail: 'key and settings present; press Test to check them' };
  }

  async listModels() {
    const e = this.entry;
    if (e.modelsMode === 'static') return { models: (e.staticModels || []).map((id) => ({ id })), source: 'static' };
    if (e.modelsMode === 'controlplane') {
      return { models: [], source: 'controlplane', note: 'model listing needs the provider control plane, which is not implemented; enter a model id' };
    }
    throw new ProviderError(ERROR_CODES.NOT_IMPLEMENTED, 'listModels not implemented for ' + e.adapter, { provider: this.id });
  }

  async testConnection() {
    return { ok: false, state: 'not-implemented', detail: 'testConnection not implemented for ' + this.entry.adapter };
  }

  // Public chat: validates, then delegates to _chat(); converts every failure into one error event.
  chat(request) {
    const self = this;
    return (async function* chatStream() {
      let req;
      try {
        req = validateChatRequest(request, { provider: self.id, requireModel: self.requiresModel() });
      } catch (err) {
        yield toErrorEvent(err, self.id);
        return;
      }
      try {
        yield* self._chat(req);
      } catch (err) {
        yield toErrorEvent(err, self.id);
      }
    })();
  }

  requiresModel() { return true; }

  // eslint-disable-next-line require-yield
  async* _chat() {
    throw new ProviderError(ERROR_CODES.NOT_IMPLEMENTED, 'chat not implemented for ' + this.entry.adapter, { provider: this.id });
  }
}

// Maps a thrown error to a testConnection/health result.
export function resultFromError(err, started) {
  const latencyMs = started ? Date.now() - started : null;
  const code = err && err.code;
  const detail = err instanceof ProviderError ? err.message : redactText(String(err && err.message ? err.message : err));
  const status = err && err.status ? err.status : null;
  const state = {
    NOT_CONFIGURED: 'not-configured', AUTH: 'auth-failed', NOT_FOUND: 'not-found', RATE_LIMIT: 'rate-limited',
    NETWORK: 'unreachable', TIMEOUT: 'unreachable', NOT_IMPLEMENTED: 'not-implemented', NOT_INSTALLED: 'not-installed',
    NOT_CONNECTED: 'not-connected',
  }[code] || 'error';
  return { ok: false, state, httpStatus: status, latencyMs, detail };
}
