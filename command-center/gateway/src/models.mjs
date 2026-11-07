// GET /api/models source: THIS gateway's own installation (no `?project=` — the literal WP3
// endpoint shape carries none, unlike missions/agents/skills/proof) — .claude/config/models/
// model-capability-matrix.json plus a live NVIDIA health probe. The probe spawns the existing,
// already-reviewed `nvidia-provider.cjs health` CLI (async execFile, 5s timeout) rather than
// re-implementing NVIDIA connectivity here, and caches the result 60s — a truthful DISCONNECTED
// or UNKNOWN state is reported on failure/timeout; NEVER a fabricated "live" state.
// WP B2 part 2 adds a `providers` block (every configured provider from the provider registry, its
// status from the shared provider hub, its models, who pays, price band, limits) and owns the gateway
// key store (vault capture + scrub). All existing fields keep their shape.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MODEL_CAPABILITY_MATRIX_FILE, NVIDIA_PROVIDER_CJS } from './paths.mjs';
import { redact } from './redact.mjs';
import { filteredEnv } from './exec-cli.mjs';
import { GatewayKeyStore } from './providers/key-provider.mjs';
import { createProviderHub } from './providers/provider-hub.mjs';
import { loadMergedRegistry, verifyCustomTarget } from './providers/custom-registry.mjs';

const execFileAsync = promisify(execFile);

// WP B2 part 2: the desktop vault hands API keys over as FORGE_KEY_<NAME> env variables at spawn
// (contract _scratch/b2/contract-keys.md). This module is imported by server.mjs (via routes/system.mjs)
// before the gateway listens, so the keys are captured into memory and REMOVED from process.env here,
// before any route can spawn a child that inherits the environment. Plain names (OPENAI_API_KEY) stay
// readable as the lower-priority source. test/models-vault-scrub.test.mjs proves no child inherits them.
const gatewayKeyStore = new GatewayKeyStore({ env: process.env, scrub: true });
export function getGatewayKeyStore() { return gatewayKeyStore; }

// WP A8 (plan F10): the probe child used to inherit the gateway's WHOLE environment — every credential
// the gateway process happened to hold (a Claude OAuth token, cloud keys, other providers' keys) went to
// a child that needs exactly one. It now gets the credential-free allowlist every other gateway child
// gets (exec-cli.mjs filteredEnv), plus exactly ONE credential, NVIDIA_API_KEY, plus the provider's own
// documented non-secret settings. Those settings are not optional extras: FORGE_PROJECT_ROOT and
// FORGE_CONFIG_HOME decide WHICH owner config the provider reads for the nvidia on/off switch (dropping
// them would let a relocated "nvidia off" be ignored, test/models.test.mjs proves it), and
// NVIDIA_SKIP_ENV_FILES keeps tests hermetic. A name that is unset stays unset (never forwarded as '').
const NVIDIA_PROBE_CREDENTIAL_ENV = 'NVIDIA_API_KEY';
const NVIDIA_PROBE_SETTING_ENV = [
  'NVIDIA_BASE_URL', 'NVIDIA_ALLOW_CUSTOM_BASE_URL', 'NVIDIA_TIMEOUT_MS', 'NVIDIA_SKIP_ENV_FILES',
  'FORGE_PROJECT_ROOT', 'FORGE_CONFIG_HOME',
];
export function nvidiaProbeEnv() {
  const env = filteredEnv({ credentialFree: true });
  for (const name of [NVIDIA_PROBE_CREDENTIAL_ENV, ...NVIDIA_PROBE_SETTING_ENV]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // WP B2 part 2: a key stored in the desktop vault wins over the plain environment (same order as
  // every other provider). Still exactly ONE credential reaches this child.
  const fromVault = gatewayKeyStore.vault.peek(NVIDIA_PROBE_CREDENTIAL_ENV);
  if (fromVault) env[NVIDIA_PROBE_CREDENTIAL_ENV] = fromVault;
  return env;
}
const NVIDIA_HEALTH_TIMEOUT_MS = 5000;
const NVIDIA_HEALTH_CACHE_TTL_MS = 60_000;
let nvidiaHealthCache = null; // { result, capturedAtMs }

// Test-only override seam (mirrors conversations.mjs's _setConversationsDirForTests pattern): lets
// a unit test point the health probe at a fixture script instead of the real nvidia-provider.cjs,
// so a spawn-failure/credential-in-stderr path can be proven without depending on live NVIDIA
// connectivity or a real key. Production code never calls the setter.
let nvidiaProviderCjsOverride = null;
function activeNvidiaProviderCjs() {
  return nvidiaProviderCjsOverride || NVIDIA_PROVIDER_CJS;
}
export function _setNvidiaProviderCjsForTests(p) { nvidiaProviderCjsOverride = p; }

// The CLI's `health` subcommand prints one plain-text line (verified live, no --json flag
// exists on it today) — see nvidia-provider.cjs's own `cmd === 'health'` branch:
//   "NVIDIA OK (live) — <n> models · <ms>ms · <baseUrl>"           (real, connected)
//   "NVIDIA MOCK MODE (no key — NOT live-ready) — <reason>"         (no NVIDIA_API_KEY configured)
//   "NVIDIA FAIL — <reason>"                                        (key present, live call failed)
//   "NVIDIA OFF — <reason> — no NVIDIA request made (...)"          (exit 3: the owner's `nvidia` setting is off
//                                                                    or unreadable — wp20 M4: NO request was sent)
// State vocabulary: CONNECTED | NOT CONFIGURED | DISCONNECTED | OFF | UNKNOWN.
function parseNvidiaHealthOutput(stdout) {
  const line = String(stdout || '').trim();
  const okMatch = line.match(/^NVIDIA OK \(live\) — (\d+) models · (\d+)ms · (.+)$/);
  // NVIDIA-URL-LEAK: nvidia-provider.cjs's own checkBaseUrl() now refuses userinfo/query/
  // fragment before a base URL is ever accepted, so this parsed value should already be credential-free
  // — redact() here is a second, independent layer against a future validation regression on the
  // producing side (defense-in-depth, not the primary control).
  if (okMatch) return { state: 'CONNECTED', models: Number(okMatch[1]), ms: Number(okMatch[2]), base_url: redact(okMatch[3]) };
  if (/^NVIDIA OFF\b/.test(line)) return { state: 'OFF', note: redact(line).slice(0, 300) };
  if (/^NVIDIA MOCK MODE/i.test(line)) return { state: 'NOT CONFIGURED', note: line };
  if (/^NVIDIA FAIL/i.test(line)) return { state: 'DISCONNECTED', note: line };
  // WP8-13 gap-closing round (nvidia-provider.cjs is the one gateway child that holds a real
  // NVIDIA_API_KEY — since WP A8 through nvidiaProbeEnv() above, no longer through the whole inherited
  // environment — so its own stdout is the most likely place a real key surfaces). redact() runs on the FULL
  // line before truncation so a credential isn't half-cut by the 200-char slice first.
  return { state: 'UNKNOWN', note: 'unrecognized nvidia-provider health output: ' + redact(line).slice(0, 200) };
}

async function probeNvidiaHealthLive() {
  try {
    const { stdout } = await execFileAsync(process.execPath, [activeNvidiaProviderCjs(), 'health'], {
      timeout: NVIDIA_HEALTH_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', env: nvidiaProbeEnv(),
    });
    return parseNvidiaHealthOutput(stdout);
  } catch (err) {
    if (err && err.killed) return { state: 'UNKNOWN', note: 'nvidia-provider health probe timed out after ' + NVIDIA_HEALTH_TIMEOUT_MS + 'ms' };
    // the owner switched NVIDIA off (or the setting is unreadable) — the CLI made no request, printed one
    // "NVIDIA OFF — ..." line and exited 3. That is a deliberate state, not a failed connection.
    if (err && err.code === 3) {
      const off = parseNvidiaHealthOutput(err.stdout);
      if (off.state === 'OFF') return off;
    }
    // wp-l4 (loop iteration 4): MOCK MODE (no NVIDIA_API_KEY, or NVIDIA_SKIP_ENV_FILES with an
    // empty key) is a genuine non-zero exit too — nvidia-provider.cjs's own CLI exits 1 whenever health()
    // is not ok, mock mode included, unless --allow-mock is passed (this gateway never passes it), and exit
    // 1 is shared with a REAL "NVIDIA FAIL" (key present, live call failed). Exit code alone cannot tell
    // them apart, so this reads the CLI's own stdout marker line — the same discriminator
    // parseNvidiaHealthOutput() already uses on the success path — and reports "no key configured" as NOT
    // CONFIGURED, never DISCONNECTED (that state stays reserved for a real network/HTTP failure against a
    // configured key). Checked before the generic fallback below so a mock-mode line is never swallowed
    // into an opaque "probe failed" message.
    if (err && err.stdout && /^NVIDIA MOCK MODE/im.test(String(err.stdout))) {
      const mock = parseNvidiaHealthOutput(err.stdout);
      if (mock.state === 'NOT CONFIGURED') return mock;
    }
    // WP8-13 gap-closing round: a non-zero exit's err.message can embed the child's own stderr
    // verbatim (Node's child_process error formatting) — exactly where an unallowlisted
    // NVIDIA_API_KEY-bearing child is most likely to leak a real credential on failure.
    const rawMessage = err && err.message ? err.message : String(err);
    return { state: 'DISCONNECTED', note: 'nvidia-provider health probe failed: ' + redact(rawMessage) };
  }
}

// WP B2 part 2: /api/models and the provider hub (nvidia-nim card) share this ONE probe and its cache, so
// NVIDIA is never probed twice at once (an in-flight probe is joined). `fresh` is the Test button.
let nvidiaHealthInflight = null;
async function probeNvidiaHealthCached({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && nvidiaHealthCache && (now - nvidiaHealthCache.capturedAtMs) < NVIDIA_HEALTH_CACHE_TTL_MS) {
    return { ...nvidiaHealthCache.result, age_ms: now - nvidiaHealthCache.capturedAtMs };
  }
  if (!nvidiaHealthInflight) {
    nvidiaHealthInflight = probeNvidiaHealthLive()
      .then((result) => { nvidiaHealthCache = { result, capturedAtMs: Date.now() }; return result; })
      .finally(() => { nvidiaHealthInflight = null; });
  }
  const result = await nvidiaHealthInflight;
  return { ...result, age_ms: 0 };
}

// ---- provider hub (WP B2 part 2) ----------------------------------------------------------------
// One hub per gateway process, shared by GET /api/models and routes/providers.mjs. Under the Node test
// runner (NODE_TEST_CONTEXT, same rule as discord-service.mjs) the default hub does not spawn real CLIs
// or touch local servers unless FORGE_LIVE=1; tests that need probes inject their own hub.
const PROVIDERS_BLOCK_BUDGET_MS = 2500;
let providerHub = null;

function matrixModelsForNvidia() {
  const m = readMatrix();
  if (!m.ok || !Array.isArray(m.data.catalog)) return null;
  return m.data.catalog.filter((c) => c && typeof c.id === 'string').map((c) => ({ id: c.id, contextLength: Number.isFinite(c.ctx) ? c.ctx : null }));
}

export function getProviderHub() {
  if (!providerHub) {
    const liveProbes = !(process.env.NODE_TEST_CONTEXT && process.env.FORGE_LIVE !== '1');
    providerHub = createProviderHub({
      // "Eigen API" (ANY-MODEL-PLAN 2.2 A): the bundled catalogue plus the user's own entries from
      // <data dir>/providers/custom.json, re-read when that file changes; the saved address of a custom
      // entry is checked again right before its outbound Test. The keys stay in the vault (CUSTOM_*_API_KEY).
      loadRegistryFn: () => loadMergedRegistry(),
      dynamicRegistry: true,
      verifyTarget: verifyCustomTarget,
      keyStore: gatewayKeyStore,
      // Under the test runner the hub's background refresh must never start the real NVIDIA CLI after a
      // test restored the owner's env; nvidia-nim then falls back to the registry's config-only health.
      nvidiaProbe: liveProbes ? probeNvidiaHealthCached : null,
      extraModels: (id) => (id === 'nvidia-nim' ? matrixModelsForNvidia() : null),
      probeCliAndLocal: liveProbes,
    });
  }
  return providerHub;
}

// Test-only seam (same pattern as _setNvidiaProviderCjsForTests). null restores the default hub.
export function _setProviderHubForTests(hub) { providerHub = hub; }

// The /api/models `providers` block. A cold status cache may need a few seconds (claude detection is
// three CLI calls); /api/models waits at most PROVIDERS_BLOCK_BUDGET_MS and otherwise answers
// `pending: true` while the probes finish in the background (the next call is served from the cache).
async function buildProvidersBlock() {
  const capturedAt = () => new Date().toISOString();
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), PROVIDERS_BLOCK_BUDGET_MS);
    if (timer.unref) timer.unref();
  });
  try {
    const work = getProviderHub().modelsBlock();
    work.catch(() => { /* a late failure after the budget is reported by the next call */ });
    const block = await Promise.race([work, budget]);
    if (!block) return { available: true, pending: true, error: null, list: [], captured_at: capturedAt() };
    return { ...block, pending: false, captured_at: capturedAt() };
  } catch (err) {
    return { available: false, pending: false, error: 'provider status failed: ' + redact(err && err.message ? err.message : String(err)), list: [], captured_at: capturedAt() };
  } finally {
    clearTimeout(timer);
  }
}

function readMatrix() {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(MODEL_CAPABILITY_MATRIX_FILE, 'utf8')) }; }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
}

export async function buildModelsView() {
  const matrix = readMatrix();
  const [nvidia, providers] = await Promise.all([probeNvidiaHealthCached(), buildProvidersBlock()]);
  const now = new Date();
  if (!matrix.ok) {
    return { ok: true, matrix_available: false, matrix_error: matrix.error, roles: {}, catalog: [], nvidia, providers, captured_at: now.toISOString(), age_ms: 0, provenance: 'DERIVED' };
  }
  const roles = matrix.data.roles || {};
  const catalog = matrix.data.catalog || [];
  const notAvailableOrBroken = matrix.data.notAvailableOrBroken || {};
  const verifiedDates = catalog
    .map((c) => { const m = String(c.verified || '').match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; })
    .filter(Boolean)
    .sort();
  return {
    ok: true,
    matrix_available: true,
    roles,
    catalog,
    broken_count: Object.keys(notAvailableOrBroken).length,
    latest_verified_date: verifiedDates.length ? verifiedDates[verifiedDates.length - 1] : null,
    nvidia,
    providers,
    captured_at: now.toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}

export function _resetNvidiaHealthCacheForTests() { nvidiaHealthCache = null; }
// Test-only export so a unit test can drive the unrecognized-output redaction path directly,
// without spawning a real (or fixture) child process.
export function _parseNvidiaHealthOutputForTests(stdout) { return parseNvidiaHealthOutput(stdout); }
