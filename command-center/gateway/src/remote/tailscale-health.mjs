// Read-only Tailscale health for the Remote Bridge: runs `tailscale status --json` (execFile, args
// array, no shell, 3 s timeout), caches the answer for 10 s and never throws. It answers the owner's
// real question: Tailscale is on on this PC, but is the phone in the same tailnet? The admin route
// gets the full block (account, peer names); the phone route gets only pc_ip and peers_online.
// Contract: command-center/docs/REMOTE-BRIDGE-CONTRACT.md §3.
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTailscaleAddress, isTailscaleAddress } from './bind-guard.mjs';

export const TAILSCALE_CACHE_MS = 10_000;
export const TAILSCALE_TIMEOUT_MS = 3_000;
const MAX_PEERS = 100;
const MAX_TEXT = 80;
const MAX_STDOUT = 4 * 1024 * 1024;

let runnerOverride = null;
let cache = null; // { at, value }
let inflight = null;

/**
 * Why this process must not run the real CLI, or null. Test processes (the Node test runner, the
 * gateway's fault-injection hook) and FORGE_TAILSCALE_CLI=off never spawn it; an injected runner wins.
 */
export function tailscaleCliSkipReason(env) {
  const e = env || {};
  if (String(e.FORGE_TAILSCALE_CLI || '').toLowerCase() === 'off') return 'FORGE_TAILSCALE_CLI=off';
  if (e.NODE_TEST_CONTEXT) return 'a process under the Node test runner';
  if (e.CC_TEST_THROW_AFTER_MS) return 'a fault-injection test gateway';
  return null;
}

/** A runner: `async () => ({ stdout } | { error: { code, message, killed } })`. */
export function createCliRunner({ execFile = nodeExecFile, platform = process.platform, exists = fs.existsSync, programFiles = process.env.ProgramFiles || 'C:\\Program Files' } = {}) {
  return () => new Promise((resolve) => {
    const winExe = path.join(programFiles, 'Tailscale', 'tailscale.exe');
    const file = platform === 'win32' && exists(winExe) ? winExe : 'tailscale';
    try {
      execFile(file, ['status', '--json'], { timeout: TAILSCALE_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_STDOUT }, (err, stdout) => {
        if (err) resolve({ error: { code: err.code ?? null, killed: err.killed === true, message: String(err.message || err) } });
        else resolve({ stdout: String(stdout) });
      });
    } catch (err) {
      resolve({ error: { code: err && err.code ? err.code : null, killed: false, message: String(err && err.message ? err.message : err) } });
    }
  });
}

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, MAX_TEXT) : null);

function peerName(p) {
  return text(p.HostName) || text(String(p.DNSName || '').split('.')[0]) || 'unknown';
}

function empty(extra) {
  return { installed: false, checked: true, running: false, pc_ip: null, account: null, peers_total: null, peers_online: null, peers: [], error: null, ...extra };
}

/** `tailscale status --json` -> the admin block. Pure; tolerant of missing fields. */
export function parseTailscaleStatus(json, fallbackIp = null) {
  if (!json || typeof json !== 'object') return empty({ installed: true, pc_ip: fallbackIp, error: 'tailscale status gave no JSON object' });
  const self = json.Self && typeof json.Self === 'object' ? json.Self : {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : Array.isArray(json.TailscaleIPs) ? json.TailscaleIPs : [];
  const running = json.BackendState === 'Running';
  const users = json.User && typeof json.User === 'object' ? json.User : {};
  const user = self.UserID !== undefined ? users[String(self.UserID)] : null;
  const peers = running
    ? Object.values(json.Peer && typeof json.Peer === 'object' ? json.Peer : {})
      .filter((p) => p && typeof p === 'object')
      .slice(0, MAX_PEERS)
      .map((p) => ({ name: peerName(p), os: text(p.OS) || 'unknown', online: p.Online === true }))
    : [];
  return {
    installed: true,
    checked: true,
    running,
    pc_ip: ips.find((ip) => typeof ip === 'string' && isTailscaleAddress(ip)) || (running ? fallbackIp : null),
    account: user && typeof user === 'object' ? text(user.LoginName) : null,
    peers_total: running ? peers.length : null,
    peers_online: running ? peers.filter((p) => p.online).length : null,
    peers,
    error: null,
  };
}

function fromRunnerResult(r, fallbackIp) {
  if (r && r.error) {
    if (r.error.code === 'ENOENT') return empty({ pc_ip: fallbackIp });
    const timedOut = r.error.killed || r.error.code === 'ETIMEDOUT';
    return empty({ installed: true, pc_ip: fallbackIp, error: timedOut ? 'tailscale status did not answer within 3 s (timed out)' : 'tailscale status failed: ' + String(r.error.message).slice(0, 200) });
  }
  let json;
  try { json = JSON.parse(r && typeof r.stdout === 'string' ? r.stdout : ''); } catch {
    return empty({ installed: true, pc_ip: fallbackIp, error: 'tailscale status did not print JSON' });
  }
  return parseTailscaleStatus(json, fallbackIp);
}

/**
 * The health block, cached for TAILSCALE_CACHE_MS. Never throws. `interfaces` only feeds the
 * fallback address (the Tailscale adapter) when the CLI cannot say it.
 */
export async function readTailscaleHealth({ now = Date.now(), interfaces = os.networkInterfaces(), env = process.env } = {}) {
  let fallbackIp = null;
  try { fallbackIp = detectTailscaleAddress(interfaces); } catch { /* no adapter info */ }
  const skip = runnerOverride ? null : tailscaleCliSkipReason(env);
  if (skip) return { ...empty({ pc_ip: fallbackIp, error: 'not checked: ' + skip }), installed: null, checked: false, running: null };
  if (cache && now - cache.at < TAILSCALE_CACHE_MS) return cache.value;
  if (!inflight) {
    const runner = runnerOverride || createCliRunner();
    inflight = (async () => {
      let value;
      try { value = fromRunnerResult(await runner(), fallbackIp); } catch (err) {
        value = empty({ installed: true, pc_ip: fallbackIp, error: 'tailscale status failed: ' + String(err && err.message ? err.message : err).slice(0, 200) });
      }
      cache = { at: now, value };
      return value;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

export function _setTailscaleRunnerForTests(fn) { runnerOverride = fn; }
export function _resetTailscaleHealthForTests() { cache = null; inflight = null; }
