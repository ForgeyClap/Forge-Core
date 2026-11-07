// KeyProvider interface: the ONLY way an adapter obtains an API key or another credential-like value.
//
//   interface KeyProvider {
//     getKey(name: string): Promise<string | null>   // name = registry keyEnvName / optionalHeaderEnv value
//     describe(): { kind: string, persistent: boolean }  // for the Accounts card; never contains a value
//   }
//
// Rules every implementation follows:
//   - a value is returned to the caller and registered with the shared Redactor, nothing else; it is
//     never logged, never written to disk by this module and never put in an error message;
//   - an absent or blank value is null (the provider then reports NOT_CONFIGURED);
//   - names are validated (A-Z, 0-9, _), so a registry typo cannot read an arbitrary variable such as
//     a path list.
//
// The gateway uses GatewayKeyStore (bottom of this file): VaultEnvKeyProvider (FORGE_KEY_<NAME>, handed
// over by the desktop app at spawn, contract-keys.md) chained before EnvKeyProvider (the plain name).
// Adapters do not change for that, they only see this interface.

import { createHash } from 'node:crypto';
import { sharedRedactor } from './redact-guard.mjs';

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new TypeError('KeyProvider: invalid key name (expected UPPER_SNAKE_CASE)');
  }
}

export class EnvKeyProvider {
  // env defaults to process.env; tests pass a plain object so no real variable is ever read.
  constructor(env = process.env, { redactor = sharedRedactor } = {}) {
    this._env = env;
    this._redactor = redactor;
  }

  async getKey(name) {
    assertName(name);
    const raw = this._env[name];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const value = raw.trim();
    this._redactor.rememberSecret(value, name);
    return value;
  }

  describe() {
    return { kind: 'env', persistent: false };
  }
}

// In-memory implementation: for tests and for a value the user pastes into a Test form before saving.
export class MemoryKeyProvider {
  constructor(entries = {}, { redactor = sharedRedactor } = {}) {
    this._map = new Map();
    this._redactor = redactor;
    for (const [k, v] of Object.entries(entries)) this.set(k, v);
  }

  set(name, value) {
    assertName(name);
    if (typeof value !== 'string' || value.trim() === '') { this._map.delete(name); return; }
    this._map.set(name, value.trim());
    this._redactor.rememberSecret(value.trim(), name);
  }

  async getKey(name) {
    assertName(name);
    return this._map.has(name) ? this._map.get(name) : null;
  }

  describe() {
    return { kind: 'memory', persistent: false };
  }
}

// Asks a list of providers in order (for example: app-stored key first, then the environment).
export class ChainKeyProvider {
  constructor(providers) {
    this._providers = providers.filter(Boolean);
  }

  async getKey(name) {
    assertName(name);
    for (const p of this._providers) {
      const v = await p.getKey(name);
      if (v) return v;
    }
    return null;
  }

  describe() {
    return { kind: 'chain:' + this._providers.map((p) => p.describe().kind).join('>'), persistent: this._providers.some((p) => p.describe().persistent) };
  }
}

export function isKeyProvider(value) {
  return !!value && typeof value.getKey === 'function' && typeof value.describe === 'function';
}

// ---------------------------------------------------------------------------------------------------
// WP B2 part 2: the desktop vault hand-off (contract _scratch/b2/contract-keys.md section 3).
//
// The Electron main process decrypts the stored keys and passes each one to the gateway child at spawn
// as FORGE_KEY_<keyEnvName> (e.g. FORGE_KEY_OPENAI_API_KEY), plus the marker FORGE_KEYS_FROM_VAULT=1.
// A key change restarts the gateway; no key ever travels over HTTP.
//
// VaultEnvKeyProvider captures those values into memory and DELETES them from the env object it was
// given (process.env in the gateway), so no child process the gateway starts later can inherit them:
// several gateway helpers spawn Forge tools with the full inherited environment. The plain name
// (OPENAI_API_KEY) is a separate, lower-priority source (EnvKeyProvider) and is never scrubbed.

export const VAULT_ENV_PREFIX = 'FORGE_KEY_';
export const VAULT_MARKER_ENV = 'FORGE_KEYS_FROM_VAULT';
const VAULT_PREFIX_RE = /^FORGE_KEY_/i;
// last4 is shown only for keys long enough that four characters reveal little of them.
const MIN_LAST4_LENGTH = 16;

export class VaultEnvKeyProvider {
  constructor({ env = process.env, scrub = true, redactor = sharedRedactor } = {}) {
    this._env = env;
    this._scrub = scrub;
    this._redactor = redactor;
    this._map = new Map();
    this._fromApp = false;
    this.capture();
  }

  // Reads every FORGE_KEY_* entry (case-insensitive: Windows env names are), keeps valid non-blank
  // values, registers them with the redactor and removes ALL FORGE_KEY_* entries from the env.
  // Returns counts only, never a value or a name list that could be mistaken for data.
  capture() {
    let added = 0;
    if (String(this._env[VAULT_MARKER_ENV] || '').trim() === '1') this._fromApp = true;
    for (const rawName of Object.keys(this._env)) {
      if (!VAULT_PREFIX_RE.test(rawName)) continue;
      const raw = this._env[rawName];
      if (this._scrub) delete this._env[rawName];
      const name = rawName.slice(VAULT_ENV_PREFIX.length).toUpperCase();
      if (!NAME_RE.test(name) || typeof raw !== 'string' || raw.trim() === '') continue;
      const value = raw.trim();
      if (this._map.get(name) !== value) added += 1;
      this._map.set(name, value);
      this._redactor.rememberSecret(value, name);
    }
    return { added, captured: this._map.size };
  }

  async getKey(name) {
    assertName(name);
    return this._map.has(name) ? this._map.get(name) : null;
  }

  // Synchronous read for building ONE child's env (models.mjs NVIDIA probe). Never log the result.
  peek(name) {
    assertName(name);
    return this._map.has(name) ? this._map.get(name) : null;
  }

  get fromApp() { return this._fromApp; }
  get size() { return this._map.size; }

  describe() {
    return { kind: 'vault', persistent: true };
  }
}

export function keyLast4(value) {
  return typeof value === 'string' && value.length >= MIN_LAST4_LENGTH ? value.slice(-4) : null;
}

// The gateway's key source: vault first, then the plain environment. Adapters only ever see
// keyProvider(); the routes see status() (present, source, last4) and never a value.
export class GatewayKeyStore {
  constructor({ env = process.env, scrub = true, redactor = sharedRedactor } = {}) {
    this.vault = new VaultEnvKeyProvider({ env, scrub, redactor });
    this.ambient = new EnvKeyProvider(env, { redactor });
    this._chain = new ChainKeyProvider([this.vault, this.ambient]);
  }

  keyProvider() { return this._chain; }

  // { name, present, source: 'vault'|'env'|null, last4 }
  async status(name) {
    assertName(name);
    const fromVault = await this.vault.getKey(name);
    if (fromVault) return { name, present: true, source: 'vault', last4: keyLast4(fromVault) };
    const fromEnv = await this.ambient.getKey(name);
    if (fromEnv) return { name, present: true, source: 'env', last4: keyLast4(fromEnv) };
    return { name, present: false, source: null, last4: null };
  }

  // Short one-way fingerprint of the CURRENT value, so a cached Test result is only reused for the
  // same key. Stays in memory; never returned by a route.
  async fingerprint(name) {
    if (!name) return null;
    const v = await this._chain.getKey(name);
    return v ? createHash('sha256').update(v).digest('hex').slice(0, 16) : null;
  }

  reload() { return this.vault.capture(); }

  info() {
    return { from_app: this.vault.fromApp, captured: this.vault.size, source_order: ['vault', 'env'] };
  }
}
