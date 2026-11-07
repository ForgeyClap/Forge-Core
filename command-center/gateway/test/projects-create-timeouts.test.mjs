// Category tests F4: the "New project" button passed `--doctor-timeout 300000` (5 min) to
// forge-sync install. A fresh install's doctor runs the whole test suite (17 232 tests, 229 suites) and
// took 9-11 minutes here; `--allow-degraded` does NOT let a doctor TIMEOUT pass (it is treated as BLOCKED),
// so every fresh install from the dashboard timed out and rolled back. forge-sync's own default limit is
// DEFAULT_DOCTOR_TIMEOUT_MS (30 min); the gateway must never cut it shorter, and its own last-resort kill
// timer must stay above the doctor limit so forge-sync's graceful rollback is what fires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { INSTALL_TIMEOUT_MS, INSTALL_DOCTOR_TIMEOUT_MS, installArgs } from '../src/projects-create.mjs';
import { FORGE_SYNC_CJS } from '../src/paths.mjs';

const require = createRequire(import.meta.url);
const { DEFAULT_DOCTOR_TIMEOUT_MS } = require(FORGE_SYNC_CJS);

test('the doctor limit the gateway passes is never shorter than forge-sync\'s own default', () => {
  assert.ok(Number.isFinite(DEFAULT_DOCTOR_TIMEOUT_MS) && DEFAULT_DOCTOR_TIMEOUT_MS > 0);
  assert.ok(INSTALL_DOCTOR_TIMEOUT_MS >= DEFAULT_DOCTOR_TIMEOUT_MS,
    `gateway doctor limit ${INSTALL_DOCTOR_TIMEOUT_MS} ms < forge-sync default ${DEFAULT_DOCTOR_TIMEOUT_MS} ms`);
});

test('the gateway kill timer stays at least 2 minutes above the doctor limit', () => {
  assert.ok(INSTALL_TIMEOUT_MS >= INSTALL_DOCTOR_TIMEOUT_MS + 2 * 60_000);
});

test('installArgs passes exactly that doctor limit and --allow-degraded, nothing from the request', () => {
  const args = installArgs('C:/x/demo');
  assert.deepEqual(args, [FORGE_SYNC_CJS, 'install', 'C:/x/demo', '--doctor-timeout', String(INSTALL_DOCTOR_TIMEOUT_MS), '--allow-degraded']);
});
