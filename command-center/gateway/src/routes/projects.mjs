// Project registry + per-run routes (moved verbatim out of server.mjs, WP A11 part 1): the project
// list / create / install status, the project profile, a project's runs, a run's events (JSON and
// the SSE stream), its mission view and its team channel.
import { safeIdOk } from '../security.mjs';
import { listProjects } from '../projects.mjs';
import { createProject, validateProjectName, projectNameContainmentOk, getInstallStatus } from '../projects-create.mjs';
import { listRunsWithProof } from '../runs.mjs';
import { readEvents, attachEventsStream } from '../events.mjs';
import { buildMission } from '../missions.mjs';
import { buildProjectProfile } from '../project-profile.mjs';
import { readTeamChat, parseLimit, TEAM_CHAT_ROUTE_RE } from '../team-chat.mjs';
import { validateSchema } from '../body.mjs';
import { sendJson, readBodyOrRespond, projectOrRespond } from './http.mjs';

export const MODULE = 'projects';

export { TEAM_CHAT_ROUTE_RE };
// cc-fix-adapter T6d: the project name is a URL PATH segment here (not a `?project=` query like
// every other route) — still re-validated against the same trusted registry via
// resolveProjectByName() before touching the filesystem, exactly like every other route.
export const PROJECT_PROFILE_RE = /^\/api\/projects\/([^/]+)\/profile$/;

// this real write (scaffolds a directory and starts a detached installer) had
// NO exec-token check at all before this fix — the exec token is now checked once in
// requestListener, before any route handler is reached, for every non-GET request.
export async function create(req, res) {
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['name'], ['name']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (typeof body.name !== 'string') return sendJson(res, 400, { ok: false, error: 'name must be a string' });
  const result = await createProject({ name: body.name });
  return sendJson(res, result.status, result.body);
}

export async function list(req, res) {
  const result = await listProjects();
  const { _capturedAtMs, ...safe } = result;
  return sendJson(res, result.ok ? 200 : 502, safe);
}

// build-async-install: the dashboard polls this after a 201 from POST /api/projects (which never
// waits for the real installer — see projects-create.mjs's own header) to learn the installer's
// real, honest outcome once it's known. Guarded exactly like the POST route: same name allowlist,
// same belt-and-suspenders containment check (projectNameContainmentOk mirrors createProject's own).
export async function installStatus(req, res, { searchParams }) {
  const name = searchParams.get('name') || '';
  const nameError = validateProjectName(name);
  if (nameError) return sendJson(res, 400, { ok: false, error: nameError });
  if (!projectNameContainmentOk(name)) {
    return sendJson(res, 400, { ok: false, error: 'name resolves outside the projects root' });
  }
  const s = getInstallStatus(name);
  if (!s) {
    // Honest, not a guess: this gateway process never recorded an install for this name — either
    // it never ran here, or (far more likely for a name that really was just created) this
    // process restarted since. Never reported as a fabricated 'installed' or 'failed'.
    return sendJson(res, 200, {
      ok: true,
      state: 'unknown',
      reason: null,
      note: 'no install status recorded for this project name in this gateway process (it may have restarted since the project was created)',
    });
  }
  return sendJson(res, 200, { ok: true, ...s });
}

export async function runs(req, res, { searchParams }) {
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  // `finalized` + `proof` per run come from the central finalize acceptance (bounded wait, cached).
  const result = await listRunsWithProof(entry.path);
  return sendJson(res, result.ok ? 200 : 400, result);
}

// WP B4: the run's team channel (team-chat.jsonl, written by forge-say.cjs). GET, no exec token;
// run id allowlist + containment + redaction live in team-chat.mjs.
export async function teamChat(req, res, { searchParams, match }) {
  let runId;
  try { runId = decodeURIComponent(match[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid run id' }); }
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = readTeamChat(entry.path, runId, { wp: searchParams.get('wp'), limit: parseLimit(searchParams.get('limit')) });
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  return sendJson(res, 200, result);
}

export async function events(req, res, { searchParams }) {
  const projectName = searchParams.get('project') || '';
  const runId = searchParams.get('run') || '';
  const afterRaw = searchParams.get('after');
  const after = afterRaw != null ? Number.parseInt(afterRaw, 10) : 0;
  if (!safeIdOk(runId)) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id>' });
  const entry = await projectOrRespond(res, projectName);
  if (!entry) return undefined;
  const result = readEvents(entry.path, runId, Number.isFinite(after) && after >= 0 ? after : 0);
  return sendJson(res, result.ok ? 200 : 400, result);
}

// Handles the one streaming route separately: it must take over `res` for a long-lived
// text/event-stream response, never funnel through sendJson()'s single JSON-object shape. Still
// runs through the EXACT same allowlist/containment checks as every other route.
export async function eventsStream(req, res, { searchParams }) {
  const projectName = searchParams.get('project') || '';
  const runId = searchParams.get('run') || '';
  if (!safeIdOk(runId)) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id>' });
  const entry = await projectOrRespond(res, projectName);
  if (!entry) return undefined;
  attachEventsStream({ req, res, projectPath: entry.path, runId });
  return undefined;
}

export async function missions(req, res, { searchParams }) {
  const projectName = searchParams.get('project') || '';
  const runId = searchParams.get('run') || '';
  if (!safeIdOk(runId)) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id>' });
  const entry = await projectOrRespond(res, projectName);
  if (!entry) return undefined;
  const result = buildMission(entry.path, runId);
  return sendJson(res, result.ok ? 200 : 400, result);
}

export async function profile(req, res, { match }) {
  let projectName;
  try { projectName = decodeURIComponent(match[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid project name' }); }
  const entry = await projectOrRespond(res, projectName);
  if (!entry) return undefined;
  const result = buildProjectProfile(entry.path);
  return sendJson(res, result.ok ? 200 : 400, result);
}
