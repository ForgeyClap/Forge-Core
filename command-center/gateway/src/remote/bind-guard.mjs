// Remote Bridge bind-address guard. The bridge binds to ONE explicit IPv4 address of this PC: a
// Tailscale address (100.64.0.0/10) or a private LAN address (10/8, 172.16/12, 192.168/16). Never
// 0.0.0.0, never ::, never IPv6, public, link-local or multicast. Loopback only with the test override.
import os from 'node:os';
import net from 'node:net';

function ipv4ToInt(addr) {
  return addr.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function inCidr(addr, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(addr) & mask) === (ipv4ToInt(base) & mask);
}

export function isTailscaleAddress(addr) {
  return net.isIPv4(addr) && inCidr(addr, '100.64.0.0', 10);
}

export function isPrivateLanAddress(addr) {
  return net.isIPv4(addr) && (inCidr(addr, '10.0.0.0', 8) || inCidr(addr, '172.16.0.0', 12) || inCidr(addr, '192.168.0.0', 16));
}

function localIpv4(interfaces) {
  const out = [];
  for (const list of Object.values(interfaces || {})) {
    for (const i of list || []) {
      if (i && (i.family === 'IPv4' || i.family === 4) && typeof i.address === 'string') out.push(i.address);
    }
  }
  return out;
}

const TAILSCALE_ADAPTER_RE = /tailscale/i;

/**
 * The PC's Tailscale address: `{ address, code: null, error: null }`, or `{ address: null, code, error }`.
 * Only an adapter whose name says Tailscale counts. Carrier-grade NAT and other VPNs use 100.64.0.0/10
 * too, so a 100.64/10 address on any other adapter is refused (tailscale_adapter_unknown), never guessed.
 */
export function detectTailscale(interfaces = os.networkInterfaces()) {
  let elsewhere = null;
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const i of list || []) {
      if (!i || !(i.family === 'IPv4' || i.family === 4) || !isTailscaleAddress(i.address)) continue;
      if (TAILSCALE_ADAPTER_RE.test(name)) return { address: i.address, code: null, error: null };
      if (!elsewhere) elsewhere = { name, address: i.address };
    }
  }
  if (elsewhere) {
    return {
      address: null, code: 'tailscale_adapter_unknown',
      error: 'the 100.64.0.0/10 address ' + elsewhere.address + ' is on adapter "' + String(elsewhere.name).slice(0, 80) + '", not on an adapter named Tailscale; carrier-grade NAT and other VPNs use that range too, so the bridge does not pick it',
    };
  }
  return { address: null, code: 'no_tailscale_address', error: 'no Tailscale address (100.64.0.0/10) on this PC; is Tailscale installed, logged in and connected?' };
}

/** The Tailscale adapter's address, or null (see detectTailscale). */
export function detectTailscaleAddress(interfaces = os.networkInterfaces()) {
  return detectTailscale(interfaces).address;
}

/** Private LAN IPv4 addresses of this PC (Tailscale excluded). */
export function lanCandidates(interfaces = os.networkInterfaces()) {
  return localIpv4(interfaces).filter(isPrivateLanAddress);
}

// Adapters a phone can never reach: VM host-only networks, Hyper-V/WSL/Docker switches and loopback.
const VIRTUAL_ADAPTER_RE = /virtualbox|vbox|vmware|vmnet|hyper-v|vethernet|wsl|docker|loopback/i;

/** True for an adapter only this PC (or a VM on it) can reach. 192.168.56.0/24 is VirtualBox's host-only default. */
export function isVirtualAdapter(name, address) {
  if (typeof address === 'string' && net.isIPv4(address) && (inCidr(address, '192.168.56.0', 24) || inCidr(address, '127.0.0.0', 8))) return true;
  return VIRTUAL_ADAPTER_RE.test(String(name || ''));
}

/** The adapter name that carries `address` on this PC, or null. */
export function adapterOf(address, interfaces = os.networkInterfaces()) {
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const i of list || []) if (i && i.address === address) return name;
  }
  return null;
}

/** Private LAN candidates as `{ address, interface, virtual }`, in adapter order. */
export function lanCandidateDetails(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const i of list || []) {
      if (!i || !(i.family === 'IPv4' || i.family === 4) || !isPrivateLanAddress(i.address)) continue;
      out.push({ address: i.address, interface: name, virtual: isVirtualAdapter(name, i.address) });
    }
  }
  return out;
}

/**
 * `{ ok: true }` when `addr` may be bound, else `{ ok: false, error }`.
 * `allowLoopback` is the test-only override (127.0.0.1 only).
 */
export function checkBindAddress(addr, { interfaces = os.networkInterfaces(), allowLoopback = false } = {}) {
  if (typeof addr !== 'string' || addr.trim() === '') return { ok: false, error: 'no bind address given; pick the Tailscale address or one LAN address' };
  const a = addr.trim();
  if (net.isIPv6(a)) return { ok: false, error: 'IPv6 addresses (including ::) are not allowed; use the IPv4 Tailscale or LAN address' };
  if (!net.isIPv4(a)) return { ok: false, error: 'not an IPv4 address: ' + a.slice(0, 64) };
  if (a === '0.0.0.0') return { ok: false, error: '0.0.0.0 would listen on every network; pick one address' };
  if (a === '127.0.0.1' && allowLoopback) return { ok: true };
  if (inCidr(a, '127.0.0.0', 8)) return { ok: false, error: 'loopback is the main gateway\'s own address; the bridge needs a Tailscale or LAN address' };
  if (!isTailscaleAddress(a) && !isPrivateLanAddress(a)) {
    return { ok: false, error: a + ' is not a Tailscale (100.64.0.0/10) or private LAN (10/8, 172.16/12, 192.168/16) address' };
  }
  if (!localIpv4(interfaces).includes(a)) return { ok: false, error: a + ' is not an address of a network interface on this PC' };
  return { ok: true };
}
