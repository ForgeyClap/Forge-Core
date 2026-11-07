// Gateway-wide read routes (moved verbatim out of server.mjs, WP A11 part 1): health, models,
// checkup, fleet-wide active runs and usage. None of them takes `?project=`.
import { buildHealth } from '../health.mjs';
import { buildModelsView } from '../models.mjs';
import { getCheckup } from '../checkup.mjs';
import { buildActiveRuns } from '../active-runs.mjs';
import { buildUsage } from '../usage.mjs';
import { buildForgeConfig } from '../config.mjs';
import { PROJECT_ROOT } from '../paths.mjs';
import { sendJson } from './http.mjs';

export const MODULE = 'system';

// Same moment as before the split: this module is loaded by server.mjs's static import, so the
// gateway's start time is still taken when the server module graph loads.
const startedAtMs = Date.now();

export async function health(req, res) {
  const result = await buildHealth(startedAtMs);
  return sendJson(res, 200, result);
}

export async function models(req, res) {
  const result = await buildModelsView();
  return sendJson(res, result.ok ? 200 : 502, result);
}

// WP B6: "Controleer of alles werkt" — read-only, answers within 10 s, no exec token (same rule
// as every other GET). `dir` is optional and only ever tested with fs.access(W_OK) after the
// network/device-path refusal in checkup.mjs; nothing from the request reaches a program.
export async function checkup(req, res, { searchParams }) {
  const result = await getCheckup({ port: req.socket.localPort, projectDir: searchParams.get('dir') });
  return sendJson(res, 200, result);
}

// WP-CC1 (item 3): fleet-wide, no `?project=` (deliberately global — see active-runs.mjs's own
// header for why this is not scoped to the selected project).
export async function activeRuns(req, res) {
  const result = await buildActiveRuns();
  return sendJson(res, result.ok ? 200 : 502, result);
}

export async function usage(req, res) {
  // The owner's check interval decides when a silent watcher counts as "stale" (usage.mjs). Read
  // through config.mjs's cached `forge-config list`; unreadable means the guard's own default.
  let intervalSec;
  try {
    const cfg = await buildForgeConfig(PROJECT_ROOT);
    const row = cfg && cfg.available === true ? (cfg.settings || []).find((s) => s && s.key === 'usage-guard.interval') : null;
    if (row && typeof row.value === 'number') intervalSec = row.value;
  } catch { /* the default applies */ }
  const result = buildUsage({ intervalSec });
  return sendJson(res, 200, result);
}
