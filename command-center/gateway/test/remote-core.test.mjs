// Remote Bridge unit tests: bind-address guard, pairing codes (expiry, single use, lockout), device
// tokens (hash-only storage, revoke) and the audit log (redaction). Contract:
// command-center/docs/REMOTE-BRIDGE-CONTRACT.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkBindAddress, detectTailscaleAddress, lanCandidates } from '../src/remote/bind-guard.mjs';
import { createPairing, PAIRING_ALPHABET, PAIRING_TTL_MS } from '../src/remote/pairing.mjs';
import { createDeviceStore } from '../src/remote/devices.mjs';
import { createAuditLog } from '../src/remote/audit.mjs';

const IFACES = {
  Ethernet: [
    { address: '192.168.1.20', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
  Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
  Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  Public: [{ address: '8.8.4.4', family: 'IPv4', internal: false }],
  LinkLocal: [{ address: '169.254.10.10', family: 'IPv4', internal: false }],
};

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-core-')); }

// ---------------------------------------------------------------- bind guard

test('bind guard refuses 0.0.0.0, ::, an empty value and a missing value', () => {
  for (const addr of ['0.0.0.0', '::', '', undefined, null, '::0']) {
    const r = checkBindAddress(addr, { interfaces: IFACES });
    assert.equal(r.ok, false, 'must refuse ' + String(addr));
  }
});

test('bind guard refuses public, link-local, IPv6, multicast and a host name', () => {
  for (const addr of ['8.8.4.4', '169.254.10.10', 'fe80::1', '224.0.0.1', 'example.com', '192.168.1.300']) {
    assert.equal(checkBindAddress(addr, { interfaces: IFACES }).ok, false, 'must refuse ' + addr);
  }
});

test('bind guard refuses loopback unless the test override is passed', () => {
  assert.equal(checkBindAddress('127.0.0.1', { interfaces: IFACES }).ok, false);
  assert.equal(checkBindAddress('127.0.0.1', { interfaces: IFACES, allowLoopback: true }).ok, true);
});

test('bind guard accepts a Tailscale or private LAN address that is on a local interface, and only then', () => {
  assert.equal(checkBindAddress('100.101.102.103', { interfaces: IFACES }).ok, true);
  assert.equal(checkBindAddress('192.168.1.20', { interfaces: IFACES }).ok, true);
  const notLocal = checkBindAddress('192.168.1.99', { interfaces: IFACES });
  assert.equal(notLocal.ok, false);
  assert.match(notLocal.error, /not .*this PC|interface/i);
});

test('Tailscale detection picks the 100.64.0.0/10 address; LAN candidates list only private IPv4', () => {
  assert.equal(detectTailscaleAddress(IFACES), '100.101.102.103');
  assert.equal(detectTailscaleAddress({ eth: [{ address: '100.200.0.1', family: 'IPv4', internal: false }] }), null, '100.200 is outside /10');
  assert.deepEqual(lanCandidates(IFACES), ['192.168.1.20']);
});

// ---------------------------------------------------------------- pairing

test('a pairing code is 10 chars from the unambiguous alphabet and pairs exactly once', () => {
  const p = createPairing({ clock: () => 1000 });
  const { code } = p.createCode();
  assert.equal(code.length, 10);
  for (const ch of code) assert.ok(PAIRING_ALPHABET.includes(ch), 'unexpected char ' + ch);
  assert.ok(!/[01OIL]/.test(code));
  const first = p.consume(code.toLowerCase().slice(0, 4) + '-' + code.slice(4), '10.0.0.5');
  assert.equal(first.ok, true, 'case and dashes are ignored');
  const second = p.consume(code, '10.0.0.5');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'pairing_failed');
});

test('a pairing code expires after 5 minutes', () => {
  let now = 1000;
  const p = createPairing({ clock: () => now });
  const { code, expiresAt } = p.createCode();
  assert.equal(expiresAt, 1000 + PAIRING_TTL_MS);
  assert.equal(PAIRING_TTL_MS, 5 * 60 * 1000);
  now = 1000 + PAIRING_TTL_MS + 1;
  const r = p.consume(code, '10.0.0.5');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'pairing_failed');
});

test('a new code replaces the old one', () => {
  const p = createPairing({ clock: () => 1000 });
  const a = p.createCode().code;
  const b = p.createCode().code;
  assert.equal(p.consume(a, '10.0.0.5').ok, false);
  assert.equal(p.consume(b, '10.0.0.5').ok, true);
});

test('5 wrong codes lock the IP out for 15 minutes, even for the right code; other IPs still pair', () => {
  let now = 1000;
  const p = createPairing({ clock: () => now });
  const { code } = p.createCode();
  for (let i = 0; i < 5; i++) assert.equal(p.consume('WRONGWRONG', '10.0.0.7').code, 'pairing_failed');
  const locked = p.consume(code, '10.0.0.7');
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 'locked_out');
  assert.ok(locked.retryAfterS > 0 && locked.retryAfterS <= 15 * 60);
  assert.equal(p.consume(code, '10.0.0.8').ok, true, 'a different IP is not locked');
  now += 15 * 60 * 1000 + 1;
  const fresh = p.createCode().code;
  assert.equal(p.consume(fresh, '10.0.0.7').ok, true, 'the lock ends after 15 minutes');
});

test('20 wrong codes across many IPs lock pairing for everyone and drop the current code', () => {
  const p = createPairing({ clock: () => 1000 });
  const { code } = p.createCode();
  for (let i = 0; i < 20; i++) p.consume('WRONGWRONG', '10.0.1.' + i);
  const r = p.consume(code, '10.0.2.1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'locked_out');
  assert.equal(p.active(), false, 'the code is dropped');
});

test('the pairing store keeps only a hash of the code', () => {
  const p = createPairing({ clock: () => 1000 });
  const { code } = p.createCode();
  assert.ok(!JSON.stringify(p._stateForTests()).includes(code));
});

// ---------------------------------------------------------------- devices

test('a device token is frb_ + 43 base64url chars and only its sha256 lands on disk', () => {
  const dir = tmpDir();
  try {
    const store = createDeviceStore(dir, { clock: () => Date.parse('2026-11-09T08:00:00Z') });
    const { token, device } = store.add('Pixel 8');
    assert.match(token, /^frb_[A-Za-z0-9_-]{43}$/);
    const onDisk = fs.readFileSync(path.join(dir, 'devices.json'), 'utf8');
    assert.ok(!onDisk.includes(token), 'raw token must not be stored');
    assert.ok(!onDisk.includes(token.slice(4)), 'raw token body must not be stored');
    assert.ok(onDisk.includes(crypto.createHash('sha256').update(token).digest('hex')));
    assert.equal(store.authenticate(token).id, device.id);
    assert.equal(store.authenticate(token + 'x'), null);
    assert.equal(store.authenticate(''), null);
    assert.equal(store.authenticate(undefined), null);
    // listing never carries the hash
    assert.ok(!JSON.stringify(store.list()).includes('sha256'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a revoked device token stops working, also after a reload from disk', () => {
  const dir = tmpDir();
  try {
    const store = createDeviceStore(dir);
    const { token, device } = store.add('Phone');
    assert.equal(store.revoke(device.id).ok, true);
    assert.equal(store.authenticate(token), null);
    assert.equal(createDeviceStore(dir).authenticate(token), null);
    assert.equal(store.revoke('nope').ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- audit

test('the audit log appends JSON lines and redacts secrets that slip into detail', () => {
  const dir = tmpDir();
  try {
    const audit = createAuditLog(path.join(dir, 'audit.jsonl'));
    audit.write({ action: 'pair_ok', status: 201, ip: '10.0.0.5', device_id: 'd1', detail: { note: 'key sk-ant-api03-' + 'A'.repeat(40) } });
    audit.write({ action: 'request', status: 200, ip: '10.0.0.5', detail: { path: '/remote/v1/status' } });
    const lines = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].action, 'pair_ok');
    assert.ok(typeof lines[0].ts === 'string');
    assert.ok(!JSON.stringify(lines[0]).includes('A'.repeat(40)), 'secret must be redacted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
