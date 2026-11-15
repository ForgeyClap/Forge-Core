// Remote Bridge manager: owns the bridge's settings, the paired devices, the pairing code, the audit
// log and the one listener. The loopback admin routes (admin-routes.mjs) and bin.mjs (restore on
// boot, stop on shutdown) are its only callers. Contract: command-center/docs/REMOTE-BRIDGE-CONTRACT.md.
//
// State folder (settings.json, devices.json, audit.jsonl): a per-user folder, ~/.forge/remote, never
// the gateway data dir. In the dev layout that data dir (command-center/.data) sits inside this
// repository, where an agent in accept-edits mode may write files without a permission card, so a
// planted devices.json or settings.json would survive a restart. Same rule as permissions/trust.mjs:
// when the state folder resolves inside a project folder the gateway knows (its own project root or
// any containment root), nothing is loaded, nothing is written there and the bridge does not start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR, realpathOrNull, isSameResolvedPath } from '../paths.mjs';
import { getContainmentRoots } from '../admitted-roots.mjs';
import { anyContainmentOk } from '../security.mjs';
import { getGatewayPort } from '../runtime-state.mjs';
import { adapterOf, checkBindAddress, detectTailscale, detectTailscaleAddress, isVirtualAdapter, lanCandidateDetails } from './bind-guard.mjs';
import { readTailscaleHealth } from './tailscale-health.mjs';
import { createPairing } from './pairing.mjs';
import { createDeviceStore } from './devices.mjs';
import { createAuditLog } from './audit.mjs';
import { createBridgeServer, createLimits } from './bridge-server.mjs';
import { runScribeList } from './scribe.mjs';
import { realLocation } from './real-location.mjs';

export const DEFAULT_BRIDGE_PORT = 4110;
export const TEST_LOOPBACK_ENV = 'FORGE_REMOTE_BRIDGE_TEST_LOOPBACK';
export const STATE_INSIDE_PROJECT = 'remote_state_inside_project';
export const AUTOSTART_ENV_OPT_OUT = 'FORGE_REMOTE_BRIDGE_AUTOSTART';
const PER_USER_STATE_DIR = path.join(os.homedir(), '.forge', 'remote');
export const CLEARTEXT_WARNING = 'LAN mode is plain HTTP: the device token, your questions and the answers cross this network in cleartext. '
  + 'Anyone on the same Wi-Fi can read them and replay the token. Phone writes stay off unless you allow LAN writes. '
  + 'Even with LAN writes on, a turn sent from the phone gets no autonomy (every permission card waits) and hard-gate cards can only be answered on the PC. Prefer Tailscale (encrypted).';
const LAN_NOT_RESTORED = 'LAN mode is not started again after a gateway restart (cleartext on the local network); turn it on again in the dashboard, or use Tailscale';
const NOT_OWNER = 'the bridge was turned on by another gateway (another install or data folder); only that gateway starts it again. Turn it on in this dashboard to move it here';

let dataDirOverride = null;
let interfacesOverride = null;
let scribeRunnerOverride = null;
let limitsConfig = {};

let state = freshState();

function freshState() {
  return { server: null, address: null, port: null, mode: null, allowLanWrites: false, lastError: null, pairing: createPairing(), devices: null, audit: null, limits: createLimits(limitsConfig) };
}

/** The folder that holds settings.json, devices.json and audit.jsonl. */
export function remoteStateDir() { return dataDirOverride ? path.join(dataDirOverride, 'remote') : PER_USER_STATE_DIR; }
function settingsFile() { return path.join(remoteStateDir(), 'settings.json'); }
function interfaces() { return interfacesOverride || os.networkInterfaces(); }
function loopbackAllowed() { return process.env[TEST_LOOPBACK_ENV] === '1'; }

/** Which gateway this is: recorded in settings.json on enable, required on restore. */
function gatewayIdentity() { return { project_root: PROJECT_ROOT, data_dir: COMMAND_CENTER_DATA_DIR }; }

function isThisGateway(enabledBy) {
  if (!enabledBy || typeof enabledBy !== 'object') return false;
  const me = gatewayIdentity();
  return typeof enabledBy.project_root === 'string' && typeof enabledBy.data_dir === 'string'
    && isSameResolvedPath(enabledBy.project_root, me.project_root) && isSameResolvedPath(enabledBy.data_dir, me.data_dir);
}

/** Why this gateway process must never restore the bridge by itself, or null. Same rule as the Discord
 *  autostart: the explicit opt-out that temp/test gateways set, plus any process that is recognisably a
 *  test (the gateway's fault-injection hook, or the Node test runner). */
export function autostartOptOutReason(env) {
  const e = env || {};
  if (String(e[AUTOSTART_ENV_OPT_OUT] || '').toLowerCase() === 'off') return AUTOSTART_ENV_OPT_OUT + '=off for this gateway process';
  if (e.CC_TEST_THROW_AFTER_MS) return 'a fault-injection test gateway (CC_TEST_THROW_AFTER_MS)';
  if (e.NODE_TEST_CONTEXT) return 'a gateway under the Node test runner (NODE_TEST_CONTEXT)';
  return null;
}

/** null, or `{ code, error }` when the state folder resolves inside a project folder. Fail closed. */
function stateProblem() {
  try {
    const folders = [PROJECT_ROOT, ...getContainmentRoots()].map((f) => realpathOrNull(f) || path.resolve(f));
    const loc = realLocation(remoteStateDir());
    if (loc !== null && !anyContainmentOk(folders, loc)) return null;
  } catch { /* cannot judge: refuse */ }
  return {
    code: STATE_INSIDE_PROJECT,
    error: 'the remote bridge state folder ' + remoteStateDir() + ' is inside a project folder, where an agent may write files without asking; '
      + 'the bridge does not load or write it and stays off',
  };
}

function devices() {
  if (!state.devices) state.devices = createDeviceStore(remoteStateDir());
  return state.devices;
}
function audit() {
  if (!state.audit) state.audit = createAuditLog(path.join(remoteStateDir(), 'audit.jsonl'));
  return state.audit;
}

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function writeSettings(s) {
  fs.mkdirSync(remoteStateDir(), { recursive: true });
  const tmp = settingsFile() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, settingsFile());
}

function bridgeUrl() {
  return state.server ? 'http://' + state.address + ':' + state.port : null;
}

function activeDevices() {
  try { return devices().activeCount(); } catch { return null; }
}

/**
 * A hint for the dashboard about the RUNNING bridge, or null: `bound_to_virtual_adapter` when it
 * listens on an adapter no phone can reach (VirtualBox host-only, Hyper-V/WSL, loopback), and
 * `tailscale_available` when it runs on LAN while a Tailscale address exists. Never an error.
 */
export function bridgeHint({ running, mode, address, interfaces: ifaces }) {
  if (!running || mode !== 'lan' || typeof address !== 'string') return null;
  const adapter = adapterOf(address, ifaces);
  if (isVirtualAdapter(adapter, address)) {
    return {
      code: 'bound_to_virtual_adapter',
      text: 'the bridge listens on ' + address + (adapter ? ' (adapter "' + String(adapter).slice(0, 80) + '")' : '')
        + ', a virtual network adapter no phone can reach; switch to Tailscale or pick the Wi-Fi/Ethernet address',
    };
  }
  if (detectTailscaleAddress(ifaces)) return { code: 'tailscale_available', text: 'the bridge runs on LAN (cleartext) while Tailscale is available on this PC; Tailscale is encrypted and works away from home' };
  return null;
}

function candidates(ifaces) {
  const tailscale = detectTailscaleAddress(ifaces);
  const lan = lanCandidateDetails(ifaces);
  const real = lan.find((l) => !l.virtual);
  return {
    tailscale,
    lan,
    lan_addresses: lan.map((l) => l.address),
    recommended_mode: tailscale ? 'tailscale' : real ? 'lan' : null,
    recommended_lan: real ? real.address : null,
  };
}

/** getRemoteStatus plus the read-only Tailscale health block (admin GET /api/remote and the enable/disable answers). */
export async function getRemoteStatusWithTailscale() {
  const tailscale = await readTailscaleHealth({ interfaces: interfaces() });
  return { ...getRemoteStatus(), tailscale };
}

export function getRemoteStatus() {
  const problem = stateProblem();
  const s = problem ? {} : readSettings();
  const mode = state.mode || s.mode || null;
  const allowLanWrites = state.server ? state.allowLanWrites : s.allow_lan_writes === true;
  return {
    ok: true,
    enabled: s.enabled === true,
    running: state.server !== null,
    mode,
    address: state.address,
    port: state.port || (Number.isInteger(s.port) ? s.port : DEFAULT_BRIDGE_PORT),
    bridge_url: bridgeUrl(),
    allow_lan_writes: mode === 'lan' && allowLanWrites === true,
    cleartext_warning: mode === 'lan' ? CLEARTEXT_WARNING : null,
    last_error: problem ? problem.error : state.lastError,
    state_problem: problem ? problem.code : null,
    candidates: candidates(interfaces()),
    hint: bridgeHint({ running: state.server !== null, mode, address: state.address, interfaces: interfaces() }),
    devices_active: problem ? 0 : activeDevices(),
    pairing_active: state.pairing.active(),
  };
}

function fail(status, code, error) { return { status, body: { ok: false, code, error } }; }

/** Validates an enable request. `{ ok: true, mode, address, port }` or `{ ok: false, result }`. */
function resolveTarget(settings) {
  const mode = settings.mode;
  if (mode !== 'tailscale' && mode !== 'lan') return { ok: false, result: fail(400, 'invalid_request', 'mode must be "tailscale" or "lan"') };
  const port = settings.port === undefined || settings.port === null ? DEFAULT_BRIDGE_PORT : settings.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, result: fail(400, 'invalid_request', 'port must be an integer from 1024 to 65535') };
  if (port === getGatewayPort()) return { ok: false, result: fail(400, 'invalid_request', 'port is the main gateway\'s own port') };
  let address;
  if (mode === 'tailscale') {
    if (settings.address !== undefined && settings.address !== null) return { ok: false, result: fail(400, 'invalid_request', 'mode "tailscale" detects the address itself; do not send one') };
    const ts = detectTailscale(interfaces());
    if (!ts.address) return { ok: false, result: fail(409, ts.code, ts.error) };
    address = ts.address;
  } else {
    address = typeof settings.address === 'string' ? settings.address.trim() : settings.address;
  }
  const guard = checkBindAddress(address, { interfaces: interfaces(), allowLoopback: loopbackAllowed() });
  if (!guard.ok) return { ok: false, result: fail(400, 'bind_refused', guard.error) };
  return { ok: true, mode, address, port };
}

async function closeServer() {
  const srv = state.server;
  state.server = null;
  state.address = null;
  state.port = null;
  state.mode = null;
  state.allowLanWrites = false;
  if (state.audit) state.audit.flush();
  if (!srv) return;
  await new Promise((resolve) => {
    srv.close(() => resolve());
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
  });
}

async function startServer(target) {
  await closeServer();
  const srv = createBridgeServer({
    address: target.address,
    port: target.port,
    mode: target.mode,
    allowLanWrites: target.allowLanWrites === true,
    devices: devices(),
    pairing: state.pairing,
    audit: audit(),
    limits: state.limits,
    scribeRunner: (project) => (scribeRunnerOverride || runScribeList)(project),
    tailscaleHealth: () => readTailscaleHealth({ interfaces: interfaces() }),
  });
  await new Promise((resolve, reject) => {
    const onError = (err) => { srv.off('listening', onListening); reject(err); };
    const onListening = () => { srv.off('error', onError); resolve(); };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(target.port, target.address);
  });
  srv.on('error', (err) => { state.lastError = 'bridge server error: ' + (err && err.message ? err.message : String(err)); });
  state.server = srv;
  state.address = target.address;
  state.port = target.port;
  state.mode = target.mode;
  state.allowLanWrites = target.allowLanWrites === true;
  state.lastError = null;
}

function listenError(err) {
  if (err && err.code === 'EADDRINUSE') return fail(409, 'port_in_use', 'that port is already in use on this address');
  if (err && err.code === 'EADDRNOTAVAIL') return fail(400, 'bind_refused', 'that address is not available on this PC');
  return fail(500, 'internal_error', 'the bridge could not start: ' + (err && err.message ? err.message : String(err)));
}

/** POST /api/remote/enable. `body` was already schema-checked by the route. */
export async function enableRemote(body) {
  const problem = stateProblem();
  if (problem) return fail(409, problem.code, problem.error);
  if (body.allow_lan_writes !== undefined && typeof body.allow_lan_writes !== 'boolean') return fail(400, 'invalid_request', 'allow_lan_writes must be true or false');
  const target = resolveTarget(body);
  if (!target.ok) return target.result;
  target.allowLanWrites = target.mode === 'lan' && body.allow_lan_writes === true;
  try {
    await startServer(target);
  } catch (err) {
    state.lastError = listenError(err).body.error;
    audit().write({ action: 'bridge_start_failed', status: 'error', detail: { mode: target.mode, address: target.address, port: target.port, error: state.lastError } });
    return listenError(err);
  }
  writeSettings({ enabled: true, mode: target.mode, address: target.mode === 'lan' ? target.address : null, port: target.port, allow_lan_writes: target.allowLanWrites, enabled_by: gatewayIdentity() });
  audit().write({ action: 'bridge_enabled', status: 200, detail: { mode: target.mode, address: target.address, port: target.port, allow_lan_writes: target.allowLanWrites } });
  return { status: 200, body: await getRemoteStatusWithTailscale() };
}

export async function disableRemote() {
  await closeServer();
  if (!stateProblem()) {
    writeSettings({ ...readSettings(), enabled: false });
    audit().write({ action: 'bridge_disabled', status: 200 });
  }
  return { status: 200, body: await getRemoteStatusWithTailscale() };
}

export function createPairingCode() {
  const problem = stateProblem();
  if (problem) return fail(409, problem.code, problem.error);
  if (!state.server) return fail(409, 'bridge_not_running', 'turn the remote bridge on first');
  const { code, expiresAt } = state.pairing.createCode();
  const payload = { v: 1, bridge_url: bridgeUrl(), code };
  audit().write({ action: 'pairing_code_created', status: 200, detail: { expires_at: new Date(expiresAt).toISOString() } });
  return { status: 200, body: { ok: true, code, expires_at: new Date(expiresAt).toISOString(), bridge_url: payload.bridge_url, payload, qr_text: JSON.stringify(payload) } };
}

export function listDevices() {
  const problem = stateProblem();
  if (problem) return fail(409, problem.code, problem.error);
  return { status: 200, body: { ok: true, devices: devices().list() } };
}

export function revokeDevice(id) {
  const problem = stateProblem();
  if (problem) return fail(409, problem.code, problem.error);
  const r = devices().revoke(id);
  if (!r.ok) return fail(404, 'unknown_device', 'no paired device with that id');
  audit().write({ action: 'device_revoked', status: 200, device_id: r.device.id, device_name: r.device.name });
  return { status: 200, body: { ok: true, revoked: true, id } };
}

/**
 * bin.mjs, after the main gateway listens: start the bridge again when it was enabled in Tailscale
 * mode by THIS gateway (same project root and data dir, `enabled_by` in settings.json). The state
 * folder is per user, so without that check any other gateway on the PC (a dev or temp gateway, a
 * test) would bind the owner's Tailscale address and serve the phone. Never in a gateway with
 * FORGE_REMOTE_BRIDGE_AUTOSTART=off or under the test runner. LAN mode (cleartext) needs an explicit
 * enable after every gateway start. Never throws.
 */
export async function restoreRemoteBridgeOnBoot({ env = process.env } = {}) {
  try {
    const optOut = autostartOptOutReason(env);
    if (optOut) {
      // Say why on the dashboard, but only for a bridge that is turned on (and never touch disk).
      if (!stateProblem() && readSettings().enabled === true) state.lastError = 'not started at gateway start: ' + optOut;
      return { outcome: 'autostart_off', detail: optOut };
    }
    const problem = stateProblem();
    if (problem) {
      state.lastError = problem.error;
      return { outcome: 'refused', detail: problem.error };
    }
    const s = readSettings();
    if (s.enabled !== true) return { outcome: 'off' };
    if (!isThisGateway(s.enabled_by)) {
      state.lastError = NOT_OWNER;
      return { outcome: 'not_owner', detail: NOT_OWNER };
    }
    if (s.mode !== 'tailscale') {
      state.lastError = LAN_NOT_RESTORED;
      audit().write({ action: 'bridge_not_restored', status: 'off', detail: { mode: s.mode ?? null, reason: 'lan_needs_enable' } });
      return { outcome: 'lan_not_restored', detail: LAN_NOT_RESTORED };
    }
    const target = resolveTarget(s);
    if (!target.ok) {
      state.lastError = target.result.body.error;
      audit().write({ action: 'bridge_start_failed', status: 'error', detail: { error: state.lastError } });
      return { outcome: 'failed', detail: state.lastError };
    }
    await startServer(target);
    audit().write({ action: 'bridge_enabled', status: 200, detail: { mode: target.mode, address: target.address, port: target.port, restored: true } });
    return { outcome: 'started', detail: bridgeUrl() };
  } catch (err) {
    state.lastError = listenError(err).body.error;
    try { audit().write({ action: 'bridge_start_failed', status: 'error', detail: { error: state.lastError } }); } catch { /* the gateway stays up */ }
    return { outcome: 'failed', detail: state.lastError };
  }
}

/** bin.mjs shutdown: close the listener, keep the settings. Never throws. */
export async function stopRemoteBridge() {
  try { await closeServer(); } catch { /* shutting down anyway */ }
}

export function _setRemoteDataDirForTests(dir) { dataDirOverride = dir; state.devices = null; state.audit = null; }
export function _setInterfacesForTests(ifaces) { interfacesOverride = ifaces; }
export function _setScribeRunnerForTests(fn) { scribeRunnerOverride = fn; }
export function _configureRemoteLimitsForTests(cfg) { limitsConfig = cfg || {}; state.limits.configure(limitsConfig); }
export async function _resetRemoteForTests() {
  await closeServer();
  limitsConfig = {};
  interfacesOverride = null;
  scribeRunnerOverride = null;
  state = freshState();
}
