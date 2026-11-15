// NEW-1 with the REAL gateway process: bin.mjs restores an enabled Tailscale bridge on boot only when
// FORGE_REMOTE_BRIDGE_AUTOSTART is not "off" (and not under the Node test runner). Every spawned
// gateway gets a temp home (USERPROFILE/HOME, so ~/.forge/remote is a temp folder), a temp
// FORGE_DATA_DIR and a free port, and is stopped by its own PID afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../src/paths.mjs';

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const REMOTE_LINE_RE = /^\[remote-bridge\] (\S+):/m;
const TIMEOUT_MS = 30000;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** A temp home with an enabled Tailscale bridge that names this gateway (same root + data dir). */
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(home, '.forge', 'remote'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(home, '.forge', 'remote', 'settings.json'), JSON.stringify({
    enabled: true, mode: 'tailscale', address: null, port: await freePort(),
    enabled_by: { project_root: PROJECT_ROOT, data_dir: data },
  }));
  return { home, data };
}

async function bootAndReadRemoteLine(t, fx, extraEnv) {
  const env = {
    ...process.env, USERPROFILE: fx.home, HOME: fx.home, FORGE_DATA_DIR: fx.data,
    CC_PORT: String(await freePort()), CC_DISCORD_AUTOSTART: 'off', ...extraEnv,
  };
  for (const k of ['NODE_TEST_CONTEXT', 'FORGE_GATEWAY_PORT', 'CC_TEST_PREFERRED_PORT', 'FORGE_REMOTE_BRIDGE_AUTOSTART']) if (!(k in extraEnv)) delete env[k];
  const child = spawn(process.execPath, [BIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { out.stderr += c.toString('utf8'); });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(); // own PID only
    await exited;
  });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = out.stdout.match(REMOTE_LINE_RE);
      if (m) { clearInterval(timer); resolve({ outcome: m[1], out }); return; }
      if (child.exitCode !== null || Date.now() - started > TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error('no [remote-bridge] line; exit=' + child.exitCode + ' stdout=' + out.stdout.slice(-1500) + ' stderr=' + out.stderr.slice(-1500)));
      }
    }, 50);
  });
}

test('NEW-1 (real process): FORGE_REMOTE_BRIDGE_AUTOSTART=off skips the restore of an enabled bridge', async (t) => {
  const fx = await fixture(t);
  const r = await bootAndReadRemoteLine(t, fx, { FORGE_REMOTE_BRIDGE_AUTOSTART: 'off' });
  assert.equal(r.outcome, 'autostart_off', r.out.stdout);
  assert.equal(fs.existsSync(path.join(fx.home, '.forge', 'remote', 'audit.jsonl')), false, 'an opted-out gateway writes nothing');
});

test('NEW-1 (real process): without the opt-out the enabling gateway does try to restore (control)', async (t) => {
  const fx = await fixture(t);
  const r = await bootAndReadRemoteLine(t, fx, {});
  // "failed" on a PC without a Tailscale adapter, "started" on one with it: either way it tried
  assert.ok(['failed', 'started'].includes(r.outcome), r.out.stdout);
});
