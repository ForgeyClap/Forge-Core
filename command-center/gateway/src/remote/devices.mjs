// Remote Bridge paired devices: <remote dir>/devices.json holds id, name, sha256(token), created_at,
// last_seen_at and revoked_at. The raw token is returned once at pairing and never stored.
// The file is re-read whenever it changed on disk, so a second gateway on the same per-user state
// folder (the desktop app next to a dev gateway) sees a revoke at once.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const LAST_SEEN_WRITE_MS = 60_000; // do not rewrite the file on every request

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function publicView(d) {
  return { id: d.id, name: d.name, created_at: d.created_at, last_seen_at: d.last_seen_at, revoked_at: d.revoked_at || null };
}

function fileStamp(file) {
  const st = fs.statSync(file, { bigint: true });
  return st.ino + ':' + st.mtimeNs + ':' + st.size;
}

export function createDeviceStore(dir, { clock = Date.now } = {}) {
  const file = path.join(dir, 'devices.json');
  let devices = [];
  let stamp = null; // what was last read or written

  /** Re-reads devices.json when it changed since the last read or write. Throws when it is unreadable. */
  function load() {
    let now;
    try {
      now = fileStamp(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error('remote bridge: devices.json is unreadable (' + err.message + '); fix or remove it');
      devices = []; // a removed file means no paired devices
      stamp = null;
      return;
    }
    if (now === stamp) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      devices = parsed && Array.isArray(parsed.devices) ? parsed.devices.filter((d) => d && typeof d.token_sha256 === 'string' && typeof d.id === 'string') : [];
      stamp = now;
    } catch (err) {
      throw new Error('remote bridge: devices.json is unreadable (' + err.message + '); fix or remove it');
    }
  }
  function save() {
    writeAtomic(file, { devices });
    try { stamp = fileStamp(file); } catch { stamp = null; }
  }
  const iso = () => new Date(clock()).toISOString();
  load();

  return {
    add(name) {
      load();
      const token = 'frb_' + crypto.randomBytes(32).toString('base64url');
      const now = iso();
      const device = { id: crypto.randomBytes(8).toString('hex'), name, token_sha256: sha256Hex(token), created_at: now, last_seen_at: now, revoked_at: null };
      devices.push(device);
      save();
      return { token, device: publicView(device) };
    },
    /** The active device for `token`, or null. Compares every stored hash (no early exit). */
    authenticate(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 200) return null;
      load();
      const given = Buffer.from(sha256Hex(token), 'hex');
      let hit = null;
      for (const d of devices) {
        const stored = Buffer.from(d.token_sha256, 'hex');
        if (stored.length === given.length && crypto.timingSafeEqual(stored, given) && !d.revoked_at) hit = d;
      }
      if (!hit) return null;
      const now = clock();
      if (now - Date.parse(hit.last_seen_at || 0) > LAST_SEEN_WRITE_MS) {
        // Another gateway on the same state folder may have revoked this device since the read above:
        // read the file again right before the save, so the save never writes an old revoked_at back.
        load();
        const fresh = devices.find((d) => d.id === hit.id);
        if (!fresh || fresh.revoked_at) return null;
        fresh.last_seen_at = iso();
        try { save(); } catch { /* last_seen is informational; auth does not fail on it */ }
        return publicView(fresh);
      }
      return publicView(hit);
    },
    list() { load(); return devices.map(publicView); },
    activeCount() { load(); return devices.filter((d) => !d.revoked_at).length; },
    revoke(id) {
      load();
      const d = devices.find((x) => x.id === id);
      if (!d) return { ok: false };
      if (!d.revoked_at) {
        d.revoked_at = iso();
        try { save(); } catch (err) { d.revoked_at = null; throw err; } // memory never says revoked when the disk does not
      }
      return { ok: true, device: publicView(d) };
    },
  };
}
