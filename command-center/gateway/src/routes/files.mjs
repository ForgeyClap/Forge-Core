// Read-only file routes (moved verbatim out of server.mjs, WP A11 part 1): the project-scoped file
// browser, the file preview, the artifact download and the mind map view. Containment, denylist and
// id allowlists live in the domain modules; these handlers only resolve the project and answer.
import { listDirectory, readFilePreview } from '../files.mjs';
import { buildArtifactContentResponse } from '../artifact-content.mjs';
import { listMindmaps, readMindmap, safeMapIdOk } from '../mindmaps.mjs';
import { sendJson, sendFile, projectOrRespond } from './http.mjs';

export const MODULE = 'files';

// build-lastdemos T2: the real artifact-download route (id shape checked again, more permissively
// than run/conv ids, by artifact-content.mjs's own safeArtifactIdOk — this pattern only excludes
// literal path separators).
export const ARTIFACT_CONTENT_RE = /^\/api\/artifacts\/([^/]+)\/content$/;

// ── WP8: secure project-scoped file browser (read-only, containment + denylist hardened) ──
export async function list(req, res, { searchParams }) {
  const relPath = searchParams.get('path') || '';
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = listDirectory(entry.path, relPath);
  return sendJson(res, result.ok ? 200 : 400, result);
}

export async function read(req, res, { searchParams }) {
  const relPath = searchParams.get('path') || '';
  if (!relPath) return sendJson(res, 400, { ok: false, error: 'missing ?path=' });
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = readFilePreview(entry.path, relPath);
  return sendJson(res, result.ok ? 200 : 400, result);
}

// build-lastdemos T2: real artifact download — the frontend's `Artifact.id` is exactly one of
// proof.mjs's two real sources (see artifact-content.mjs's header for the full reasoning).
export async function artifactContent(req, res, { searchParams, match }) {
  let artifactId;
  try { artifactId = decodeURIComponent(match[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid artifact id' }); }
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  const result = buildArtifactContentResponse(entry.path, artifactId);
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  return sendFile(res, result.status, result.buffer, result.fileName, result.mime);
}

// the Command Center's Mind map view — the list of a
// project's stored mind maps, or one map with `&id=<map_id>`. Read-only; see mindmaps.mjs's header
// for the id allowlist, link refusal and size caps. Same registry-name scoping as every route here.
export async function mindmaps(req, res, { searchParams }) {
  const mapId = searchParams.get('id');
  // Validate the id before any project lookup, like /api/proof does with its run id.
  if (mapId !== null && !safeMapIdOk(mapId)) return sendJson(res, 400, { ok: false, error: 'invalid mind map id (allowed: A-Z a-z 0-9 _ -)' });
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  if (mapId === null) return sendJson(res, 200, listMindmaps(entry.path));
  const result = readMindmap(entry.path, mapId);
  return sendJson(res, result.status, result.body);
}
