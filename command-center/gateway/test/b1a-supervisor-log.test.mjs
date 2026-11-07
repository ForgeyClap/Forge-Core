// WP B1a rework: with FORGE_DATA_DIR set the supervisor's default log file moves to
// <data dir>/logs/gateway-runtime.log, so an installed app writes nothing inside its install folder.
// Unset (or unusable) it stays next to supervisor.mjs as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDefaultLogFile, GatewaySupervisor } from '../supervisor.mjs';

const GATEWAY_DIR = path.dirname(fileURLToPath(new URL('../supervisor.mjs', import.meta.url)));
const INSTALL_DEFAULT = path.join(GATEWAY_DIR, 'gateway-runtime.log');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1a-suplog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

test('resolveDefaultLogFile: FORGE_DATA_DIR -> <data>/logs/gateway-runtime.log; unset or unusable -> next to supervisor.mjs', (t) => {
  const data = tempDir(t);
  assert.equal(resolveDefaultLogFile({ FORGE_DATA_DIR: data }), path.join(data, 'logs', 'gateway-runtime.log'));
  assert.equal(resolveDefaultLogFile({}), INSTALL_DEFAULT);
  for (const bad of ['', '   ', 'relative/dir', '\\\\host\\share\\data', data + '\nx']) {
    assert.equal(resolveDefaultLogFile({ FORGE_DATA_DIR: bad }), INSTALL_DEFAULT, JSON.stringify(bad));
  }
});

test('DEFAULT_LOG_FILE follows FORGE_DATA_DIR in a real process (read once at import)', (t) => {
  const data = tempDir(t);
  const url = pathToFileURL(fileURLToPath(new URL('../supervisor.mjs', import.meta.url))).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(url)}).then((m) => process.stdout.write(m.DEFAULT_LOG_FILE))`],
  { env: { ...process.env, FORGE_DATA_DIR: data }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, path.join(data, 'logs', 'gateway-runtime.log'));
});

test('start() creates a missing logs folder and really writes the log there', async (t) => {
  const data = tempDir(t);
  const logFile = path.join(data, 'logs', 'gateway-runtime.log');
  const script = path.join(data, 'child.mjs');
  fs.writeFileSync(script, "process.stdout.write('child ran\\n');\n");
  const sup = new GatewaySupervisor({ childScript: script, logFilePath: logFile, initialBackoffMs: 10000 });
  const restartScheduled = new Promise((resolve) => sup.once('restart-scheduled', resolve));
  sup.start();
  await restartScheduled; // the child exited (unexpectedly, from the supervisor's view)
  await new Promise((resolve) => { sup.once('stopped', resolve); sup.stop(); });
  const text = fs.readFileSync(logFile, 'utf8');
  assert.match(text, /gateway child started pid=\d+ attempt=1/);
  assert.match(text, /child ran/);
});
