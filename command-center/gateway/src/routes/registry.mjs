// Per-project registry and config routes (moved verbatim out of server.mjs, WP A11 part 1): agents
// (+ the one PATCH route that edits an agent's model), skills, tools, MCP, capabilities and the
// project's Forge config (read + write). Every route resolves `?project=` through the trusted
// registry first.
import { safeIdOk } from '../security.mjs';
import { buildAgentsRegistry } from '../agents.mjs';
import { patchAgentModel } from '../agents-write.mjs';
import { buildSkillsRegistry } from '../skills.mjs';
import { buildToolsInventory } from '../tools.mjs';
import { buildMcpView } from '../mcp.mjs';
import { buildCapabilities } from '../capabilities.mjs';
import { buildForgeConfig } from '../config.mjs';
import { writeForgeConfig } from '../config-write.mjs';
import { validateSchema } from '../body.mjs';
import { sendJson, readBodyOrRespond, projectOrRespond, refuseIfSyncLocked } from './http.mjs';

export const MODULE = 'registry';

// feat-agent-model-edit: PATCH /api/agents/:slug/model?project=<name> — the one route that ever
// changes something inside `.claude/config/agents/agent-model-map.json` (see agents-write.mjs's
// own header for the full write-boundary exception this is). The slug is a URL path segment (same
// shape as PROJECT_PROFILE_RE); re-validated against safeIdOk() before it is ever used, same
// "never trust a single check point" discipline as every other route here.
export const AGENT_MODEL_RE = /^\/api\/agents\/([^/]+)\/model$/;

export async function agents(req, res, { searchParams }) {
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  // WP-CC1 (item 6): projectName merges the real run-log live-status view (item 5) into each
  // agent row — optional param, so this stays the exact same call shape any earlier reviewer saw.
  const result = buildAgentsRegistry(entry.path, entry.name);
  return sendJson(res, result.ok ? 200 : 400, result);
}

// Order: slug shape (400) -> body read/schema (400/413) -> project resolution (502/404) -> the
// actual patch (agents-write.mjs owns every remaining 400/404/500/200 outcome). The exec token
// itself is checked once in requestListener, before any handler is reached.
export async function agentModel(req, res, { searchParams, match }) {
  let slug;
  try { slug = decodeURIComponent(match[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid agent slug' }); }
  if (!safeIdOk(slug)) return sendJson(res, 400, { ok: false, error: 'invalid agent slug' });
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['claudeTier', 'claudeEffort'], []);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (Object.keys(body).length === 0) {
    return sendJson(res, 400, { ok: false, error: 'at least one of claudeTier/claudeEffort must be provided' });
  }
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  if (refuseIfSyncLocked(res, entry)) return undefined; // writes .claude/agents/*.md
  const result = patchAgentModel({ projectPath: entry.path, projectName: entry.name, slug, patch: body });
  return sendJson(res, result.status, result.body);
}

export async function skills(req, res, { searchParams }) {
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = buildSkillsRegistry(entry.path);
  return sendJson(res, result.ok ? 200 : 400, result);
}

// ── WP6 T6.1-T6.7: agents/skills/tools/MCP/models/capability health map additions ──────────
export async function tools(req, res, { searchParams }) {
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = buildToolsInventory(entry.path);
  return sendJson(res, result.ok ? 200 : 400, result);
}

export async function mcp(req, res, { searchParams }) {
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = buildMcpView(entry.path);
  return sendJson(res, result.ok ? 200 : 400, result);
}

export async function capabilities(req, res, { searchParams }) {
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = await buildCapabilities(entry.path);
  const { _capturedAtMs, ...safe } = result;
  return sendJson(res, safe.ok ? 200 : 502, safe);
}

// READ-ONLY view of the selected project's own Forge settings
// (its `forge-config.cjs list --json --all`, see config.mjs).
export async function configGet(req, res, { searchParams }) {
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = await buildForgeConfig(entry.path);
  const { _capturedAtMs, ...safe } = result;
  return sendJson(res, safe.ok ? 200 : 502, safe);
}

// POST /api/config?project=<name> — the dashboard's real config-write route, body
// { action:'set'|'unset', key, value? }. Shape only here; every semantic check (action/key/value
// validity, the gate-hook-off refusal, exit-code mapping) lives in config-write.mjs
// (writeForgeConfig) — same "routes stay thin" split as agents-write.mjs's patchAgentModel.
export async function configPost(req, res, { searchParams }) {
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['action', 'key', 'value'], ['action', 'key']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  if (refuseIfSyncLocked(res, entry)) return undefined; // writes the project's .claude config
  const result = await writeForgeConfig({
    projectPath: entry.path, projectName: entry.name, action: body.action, key: body.key,
    value: Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : undefined,
  });
  return sendJson(res, result.status, result.body);
}
