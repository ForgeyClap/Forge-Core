// Provider hub (WP B2 part 2): the one place the gateway asks "which providers work on this PC?".
// Used by routes/providers.mjs and models.mjs. Contract: _scratch/b2/contract-providers.md.
//
// What runs where (no surprises in the outbound log, plan 7.2):
//   status (GET)  CLI detection through the CLI itself, loopback local servers, the existing NVIDIA probe.
//                 Remote API-key providers: configuration only, NO network call.
//   test (POST)   the ONLY place a remote provider is called: list models, or a one-token chat when the
//                 provider has no models route and the user gave a model id. Bounded and deduplicated.
// Every result is cached (status 60 s, in-flight shared), every text passes the shared redactor, and no
// function here logs anything.
//
// "Eigen API" (ANY-MODEL-PLAN 2.2 A): with dynamicRegistry the hub asks loadRegistryFn() on every lookup
// (models.mjs passes the merged registry, which is one cached object until custom.json changes). When an
// entry object changes or disappears, everything cached for that id (adapter instance, status, test result,
// model list) is dropped, so a result never outlives the address it was measured on. verifyTarget(entry)
// re-checks a custom entry's saved address right before the outbound Test.

import { loadRegistry } from './registry.mjs';
import { createProvider } from './index.mjs';
import { resultFromError } from './provider-base.mjs';
import { ERROR_CODES, sharedRedactor } from './redact-guard.mjs';
import { resolveCli } from './cli/cli-resolve.mjs';
import {
  statusFromState, nvidiaProbeToState, providerKind, whoPays, priceBand, limitsInfo, loginHint, needsKey,
} from './provider-status.mjs';

// Same bounds the adapters use for their own health probes (connect 3 s, total 5 s).
export const PROBE_TIMEOUTS = Object.freeze({ connectTimeoutMs: 3000, firstByteTimeoutMs: 5000, totalTimeoutMs: 5000, idleTimeoutMs: 5000 });
// A Test click: connect 5 s, first byte 15 s, everything 30 s (a one-token chat answers well within that).
export const TEST_TIMEOUTS = Object.freeze({ connectTimeoutMs: 5000, firstByteTimeoutMs: 15000, totalTimeoutMs: 30000, idleTimeoutMs: 15000 });
const STATUS_TTL_MS = 60_000;
const PROBE_CAP_MS = 25_000; // claude detection is three CLI calls with their own 15-20 s limits
const TEST_CAP_MS = 45_000;
const MAX_MODELS = 500;
const MAX_DETAIL = 300;
const NVIDIA_ID = 'nvidia-nim';
const OLLAMA_LOCAL_ID = 'ollama-local';

export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function capped(promise, ms, what) {
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, state: 'error', detail: what + ' timed out after ' + Math.round(ms / 1000) + ' s', timedOut: true }), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

function shortText(text, redactor) {
  if (text === null || text === undefined) return null;
  const s = redactor.redact(String(text));
  return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + '...' : s;
}

function normModel(m) {
  return {
    id: m.id,
    context_length: Number.isFinite(m.contextLength) ? m.contextLength : (Number.isFinite(m.context_length) ? m.context_length : null),
    size_bytes: Number.isFinite(m.sizeBytes) ? m.sizeBytes : null,
  };
}

async function defaultOllamaInstalled() {
  try { return !!(await resolveCli('ollama')); } catch { return false; }
}

// provider-status.mjs classifies keys by authType and does not know 'custom-header' (an "Eigen API" entry
// that sends its vault key in a header the user named). For who-pays, price band, key check and sign-in hint
// such an entry behaves exactly like a bearer-key entry, so it is classified through this view.
function statusView(entry) {
  return entry && entry.authType === 'custom-header' ? { ...entry, authType: 'bearer' } : entry;
}

function nvidiaDetail(p) {
  if (!p) return 'NVIDIA probe gave no answer';
  if (p.state === 'CONNECTED') return 'NVIDIA answered (' + p.models + ' models, ' + p.ms + ' ms)';
  return p.note || ('NVIDIA probe state ' + p.state);
}

export function createProviderHub({
  registry = null, loadRegistryFn = () => loadRegistry(), keyStore, providerFactory = createProvider,
  nvidiaProbe = null, extraModels = null, isOllamaInstalled = defaultOllamaInstalled, vars = {}, probeCliAndLocal = true,
  statusTtlMs = STATUS_TTL_MS, probeCapMs = PROBE_CAP_MS, testCapMs = TEST_CAP_MS,
  probeTimeouts = PROBE_TIMEOUTS, testTimeouts = TEST_TIMEOUTS, now = Date.now, redactor = sharedRedactor,
  dynamicRegistry = false, verifyTarget = null,
} = {}) {
  if (!keyStore || typeof keyStore.keyProvider !== 'function') throw new TypeError('createProviderHub: a GatewayKeyStore is required');
  let reg = registry;
  let regError = null;
  const instances = new Map();
  const statusCache = new Map(); // id -> { at, probe }
  const statusInflight = new Map();
  const testCache = new Map(); // id -> { at, keyFp, result }
  const testInflight = new Map();
  const modelCache = new Map(); // id -> { at, models, source }

  function getRegistry() {
    if (regError || (reg && (!dynamicRegistry || registry))) return reg;
    let next;
    try { next = loadRegistryFn(); } catch (err) { if (!reg) regError = err; return reg; }
    if (next !== reg) {
      if (reg) forgetChanged(reg, next);
      reg = next;
    }
    return reg;
  }

  // Drops every cache of an id whose entry object changed or disappeared between two registry versions.
  function forgetChanged(prev, next) {
    for (const id of prev.ids()) if (next.get(id) !== prev.get(id)) forget(id);
  }

  // A probe or test still running for the old entry finishes on its own, but is no longer joined by new
  // callers and never writes into the caches of the new entry (isCurrent below).
  function forget(id) {
    for (const k of [...instances.keys()]) if (k.startsWith(id + '|')) instances.delete(k);
    statusCache.delete(id);
    testCache.delete(id);
    modelCache.delete(id);
    statusInflight.delete(id);
    testInflight.delete(id);
  }

  // True while `entry` is still the registry's current object for its id. A fixed registry never changes.
  function isCurrent(entry) {
    if (!dynamicRegistry || registry) return true;
    const r = getRegistry();
    return !!r && r.get(entry.id) === entry;
  }

  function registryState() {
    getRegistry();
    const custom = reg && reg.custom ? { provenance: reg.custom.provenance, problems: reg.custom.problems.map((p) => redactor.redactDeep(p)) } : null;
    if (reg) return { ok: true, problems: [], ...(custom ? { custom } : {}) };
    const problems = regError && Array.isArray(regError.problems) ? regError.problems : [regError ? String(regError.message || regError) : 'registry unavailable'];
    return { ok: false, problems: problems.map((p) => shortText(p, redactor)) };
  }

  function entryById(id) {
    const r = getRegistry();
    return r ? r.get(id) : null;
  }

  function instance(entry, purpose) {
    const isCli = entry.adapter.startsWith('cli-');
    const cacheKey = entry.id + '|' + (isCli ? 'cli' : purpose);
    if (!instances.has(cacheKey)) {
      instances.set(cacheKey, providerFactory(entry, {
        keyProvider: keyStore.keyProvider(), vars: vars[entry.id] || {}, timeouts: purpose === 'test' ? testTimeouts : probeTimeouts,
        registry: getRegistry(),
      }));
    }
    return instances.get(cacheKey);
  }

  async function keyCheck(entry) {
    if (!needsKey(statusView(entry))) return { needed: false, present: false };
    const s = await keyStore.status(entry.keyEnvName);
    return { needed: true, present: s.present };
  }

  function noKeyResult(entry) {
    return { ok: false, state: 'not-configured', keyMissing: true, latencyMs: null, detail: 'no API key: add one in Settings > Accounts (' + entry.keyEnvName + ')' };
  }

  // ---- status probes -------------------------------------------------------------------------------
  async function probeLocal(entry) {
    const p = instance(entry, 'probe');
    const h = await p.health();
    if (h.ok) {
      let modelsNote = null;
      try {
        const l = await p.listModels();
        modelCache.set(entry.id, { at: now(), models: l.models.slice(0, MAX_MODELS), source: 'endpoint' });
      } catch (err) { modelsNote = resultFromError(err).detail; }
      return { state: 'connected', detail: modelsNote ? 'server answered; model list failed: ' + modelsNote : 'server answered', version: h.version || null, tested: true, live: true };
    }
    modelCache.delete(entry.id);
    if (entry.id === OLLAMA_LOCAL_ID && h.state === 'unreachable' && !(await isOllamaInstalled())) {
      return { state: 'not-installed', detail: 'Ollama is not running and the ollama program was not found on PATH', tested: true, live: true };
    }
    return { state: h.state, detail: h.detail, tested: true, live: true };
  }

  async function probeEntry(entry) {
    if (entry.id === NVIDIA_ID && nvidiaProbe) {
      const p = await nvidiaProbe({ fresh: false });
      const m = nvidiaProbeToState(p);
      return { state: m.state, keyMissing: m.keyMissing, detail: nvidiaDetail(p), tested: m.tested, live: m.tested, nvidiaState: p && p.state };
    }
    const kind = providerKind(entry);
    const isCli = kind === 'subscription' || kind === 'cli-detect-only';
    if (!probeCliAndLocal && (isCli || entry.local)) {
      return { state: 'not-connected', detail: 'not probed: CLI and local-server probes are off in this process (Node test runner; FORGE_LIVE=1 turns them on)', tested: false, live: false };
    }
    if (isCli) {
      const h = await instance(entry, 'probe').health();
      return { state: h.state, detail: h.detail, version: h.version || null, tested: true, live: true };
    }
    const k = await keyCheck(entry);
    if (k.needed && !k.present) return { ...noKeyResult(entry), tested: false, live: false };
    if (entry.local) return probeLocal(entry);
    if (k.needed) {
      const fp = await keyStore.fingerprint(entry.keyEnvName);
      const t = testCache.get(entry.id);
      if (t && t.keyFp === fp) return { state: t.result.state, detail: t.result.detail, tested: true, live: true, testedAt: t.at };
    }
    const h = await instance(entry, 'probe').health(); // configuration only, no network
    const untested = k.needed ? 'key found; not tested yet (press Test)' : 'not tested yet (press Test)';
    return { state: h.state, detail: h.state === 'configured' ? untested : h.detail, tested: false, live: false };
  }

  // Stale-while-revalidate: a cached answer is returned at once; when it is older than the TTL ONE
  // background refresh starts. Only an empty cache (or fresh=true) waits for the probe.
  function cachedProbe(entry, { fresh = false } = {}) {
    const hit = statusCache.get(entry.id);
    if (!fresh && hit) {
      if (now() - hit.at >= statusTtlMs && !statusInflight.has(entry.id)) startProbe(entry);
      return Promise.resolve(hit);
    }
    if (statusInflight.has(entry.id)) return statusInflight.get(entry.id);
    return startProbe(entry);
  }

  function startProbe(entry) {
    const run = (async () => {
      let probe;
      try { probe = await capped(probeEntry(entry), probeCapMs, 'status check'); }
      catch (err) { const r = resultFromError(err); probe = { state: r.state, detail: r.detail, tested: false, live: false }; }
      const rec = { at: now(), probe };
      if (isCurrent(entry)) statusCache.set(entry.id, rec);
      return rec;
    })().finally(() => { if (statusInflight.get(entry.id) === run) statusInflight.delete(entry.id); });
    statusInflight.set(entry.id, run);
    return run;
  }

  async function buildRow(entry, rec) {
    const probe = rec.probe;
    let key = entry.keyEnvName ? await keyStore.status(entry.keyEnvName) : null;
    // The NVIDIA tool also reads the owner's own NVIDIA env/config; a probe that reached NVIDIA with a key
    // proves a key exists even when this gateway's env has none.
    if (entry.id === NVIDIA_ID && key && !key.present && (probe.nvidiaState === 'CONNECTED' || probe.nvidiaState === 'DISCONNECTED')) {
      key = { ...key, present: true, source: 'env' };
    }
    const words = statusFromState(probe.state, { keyMissing: !!probe.keyMissing });
    const view = statusView(entry);
    return redactor.redactDeep({
      id: entry.id, label: entry.label, adapter: entry.adapter, kind: providerKind(entry),
      status: words.status, status_code: words.status_code, state: probe.state, detail: shortText(probe.detail, redactor),
      tested: !!probe.tested, live: !!probe.live,
      who_pays: whoPays(view), price_band: priceBand(view), limits: limitsInfo(view),
      tos: { required: !!entry.noticeRequired, note: entry.tosNote || null, checked_on: entry.verifiedOn },
      key_name: entry.keyEnvName || null, key_present: key ? key.present : false, key_source: key ? key.source : null,
      login: { kind: loginHint(view).kind },
      version: probe.version || null, local: !!entry.local, models_mode: entry.modelsMode,
      streaming: entry.streaming, tool_calling: entry.toolCalling, verification: entry.verification,
      verified_on: entry.verifiedOn, docs_url: entry.docsURL || null, caveat: entry.caveat || null,
      source: entry.source === 'custom' ? 'custom' : 'bundled', warnings: Array.isArray(entry.warnings) ? [...entry.warnings] : [],
      checked_at: new Date(rec.at).toISOString(), age_ms: Math.max(0, now() - rec.at),
    });
  }

  async function listProviders({ fresh = false } = {}) {
    const r = getRegistry();
    if (!r) return { ok: false, registry: registryState() };
    const recs = await Promise.all(r.providers.map((e) => cachedProbe(e, { fresh })));
    const providers = await Promise.all(r.providers.map((e, i) => buildRow(e, recs[i])));
    const counts = { total: providers.length, connected: 0, not_connected: 0, no_key: 0, not_installed: 0, error: 0 };
    for (const p of providers) counts[p.status_code.replace(/-/g, '_')] += 1;
    return { ok: true, providers, counts, vault: keyStore.info() };
  }

  async function providerRow(id, { fresh = false } = {}) {
    const entry = entryById(id);
    if (!entry) return null;
    return buildRow(entry, await cachedProbe(entry, { fresh }));
  }

  // ---- test (outbound, on click) --------------------------------------------------------------------
  async function runTest(entry, model) {
    if (entry.id === NVIDIA_ID && nvidiaProbe) {
      const p = await nvidiaProbe({ fresh: true });
      const m = nvidiaProbeToState(p);
      return { ok: m.state === 'connected', state: m.state, keyMissing: m.keyMissing, latencyMs: Number.isFinite(p && p.ms) ? p.ms : null, detail: nvidiaDetail(p), modelsCount: Number.isFinite(p && p.models) ? p.models : null };
    }
    if (entry.source === 'custom' && typeof verifyTarget === 'function') {
      const v = verifyTarget(entry);
      if (!v || v.ok !== true) return { ok: false, state: 'error', latencyMs: null, detail: (v && v.en) || 'the saved address could not be checked' };
    }
    const k = await keyCheck(entry);
    if (k.needed && !k.present) return noKeyResult(entry);
    const kind = providerKind(entry);
    const p = instance(entry, 'test');
    const isHttp = kind === 'api-key' || kind === 'local';
    if (isHttp && entry.modelsMode === 'endpoint' && entry.testCall !== 'chat-1-token') {
      const started = now();
      try {
        const l = await p.listModels();
        modelCache.set(entry.id, { at: now(), models: l.models.slice(0, MAX_MODELS), source: entry.local ? 'endpoint' : 'test-cache' });
        return { ok: true, state: 'connected', latencyMs: now() - started, modelsCount: l.models.length, detail: l.models.length === 0 ? 'answered, but lists no models yet' : 'models route answered' };
      } catch (err) {
        if (!(err && err.code === ERROR_CODES.NOT_FOUND && model)) return resultFromError(err, started);
        // no models route: the adapter's testConnection falls back to a one-token chat with this model
      }
    }
    const t = await p.testConnection(model ? { model } : {});
    if (t.ok && entry.modelsMode === 'static') {
      modelCache.set(entry.id, { at: now(), models: (entry.staticModels || []).map((id) => ({ id })), source: 'static' });
    }
    return t;
  }

  function testProvider(id, { model = null } = {}) {
    const entry = entryById(id);
    if (!entry) return Promise.resolve(null);
    if (testInflight.has(id)) return testInflight.get(id);
    const run = (async () => {
      const started = now();
      let t;
      try { t = await capped(runTest(entry, model), testCapMs, 'test'); }
      catch (err) { t = resultFromError(err, started); }
      const words = statusFromState(t.state, { keyMissing: !!t.keyMissing });
      const result = redactor.redactDeep({
        ok: !!t.ok, status: words.status, status_code: words.status_code, state: t.state,
        latency_ms: Number.isFinite(t.latencyMs) ? t.latencyMs : null, http_status: Number.isFinite(t.httpStatus) ? t.httpStatus : null,
        detail: shortText(t.detail, redactor), models_count: Number.isFinite(t.modelsCount) ? t.modelsCount : null,
        version: t.version || null,
      });
      const at = now();
      const keyFp = needsKey(statusView(entry)) ? await keyStore.fingerprint(entry.keyEnvName) : null;
      if (isCurrent(entry)) {
        testCache.set(id, { at, keyFp, result: { state: t.state, detail: result.detail } });
        statusCache.delete(id);
      }
      const row = await providerRow(id);
      return { provider: id, result, row, tested_at: new Date(at).toISOString(), live: true };
    })().finally(() => { if (testInflight.get(id) === run) testInflight.delete(id); });
    testInflight.set(id, run);
    return run;
  }

  // ---- keys ---------------------------------------------------------------------------------------
  async function keyStatuses() {
    const r = getRegistry();
    if (!r) return { ok: false, registry: registryState() };
    const keys = [];
    for (const e of r.providers) {
      if (!e.keyEnvName) continue;
      const s = await keyStore.status(e.keyEnvName);
      const extra = [];
      for (const name of Object.values(e.optionalHeaderEnv || {})) {
        const x = await keyStore.status(name);
        extra.push({ name, present: x.present, source: x.source });
      }
      keys.push({ provider_id: e.id, key_env_name: e.keyEnvName, present: s.present, source: s.source, last4: s.last4, extra });
    }
    return { ok: true, keys, vault: keyStore.info() };
  }

  function reloadKeys() {
    const r = keyStore.reload();
    testCache.clear();
    statusCache.clear();
    for (const [id, m] of modelCache) if (m.source === 'test-cache') modelCache.delete(id);
    return { vault_captured: r.captured, vault_new: r.added };
  }

  function loginHintFor(id) {
    const entry = entryById(id);
    return entry ? loginHint(statusView(entry)) : null;
  }

  // The overlay's own state (provenance, revision, ids, disabled, warnings, problems), or null.
  function customState() {
    const r = getRegistry();
    return r && r.custom ? redactor.redactDeep(r.custom) : null;
  }

  // ---- /api/models block --------------------------------------------------------------------------
  function modelsFor(entry) {
    const extra = typeof extraModels === 'function' ? extraModels(entry.id) : null;
    if (Array.isArray(extra)) return { models: extra.map(normModel), models_source: 'matrix', models_note: null };
    const cached = modelCache.get(entry.id);
    if (cached) return { models: cached.models.map(normModel), models_source: cached.source, models_note: null };
    if (entry.modelsMode === 'static') {
      const list = entry.staticModels || [];
      return { models: list.map((id) => normModel({ id })), models_source: 'static', models_note: list.length === 0 ? 'no fixed model list; the program chooses its own models' : null };
    }
    return { models: [], models_source: 'not-fetched', models_note: 'press Test in Settings > Accounts to fetch the model list' };
  }

  async function modelsBlock() {
    const list = await listProviders();
    if (!list.ok) return { available: false, error: 'provider registry invalid', problems: list.registry.problems, list: [] };
    const out = [];
    for (const row of list.providers) {
      const include = row.status_code === 'connected' || (row.kind === 'api-key' && row.key_present);
      if (!include) continue;
      const entry = entryById(row.id);
      out.push({
        id: row.id, label: row.label, status: row.status, status_code: row.status_code, live: row.live,
        who_pays: row.who_pays, price_band: row.price_band, limits: row.limits, ...modelsFor(entry),
      });
    }
    return { available: true, error: null, list: out };
  }

  return {
    registryState, listProviders, providerRow, testProvider, keyStatuses, reloadKeys, loginHintFor, modelsBlock,
    customState, hasProvider: (id) => !!entryById(id),
  };
}
