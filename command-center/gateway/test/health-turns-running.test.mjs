// WP B2 part 2 (Lead integration of _scratch/b2/patches-health.md): GET /api/health reports how many
// `claude` executions are running right now, so the Electron shell can restart the gateway for a key
// change or an update ONLY when nothing runs (desktop/src/main/update-state.mjs turnStateFromHealth).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealth } from '../src/health.mjs';

test('health carries turns_running as a non-negative integer (0 when idle)', async () => {
  const health = await buildHealth(Date.now() - 1000);
  assert.equal(typeof health.turns_running, 'number');
  assert.ok(Number.isInteger(health.turns_running) && health.turns_running >= 0, String(health.turns_running));
  assert.equal(health.turns_running, 0, 'no execution runs inside this test process');
});
