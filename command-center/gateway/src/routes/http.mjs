// Shared HTTP helpers for the route modules (WP A11 part 1). Moved verbatim out of server.mjs: the
// JSON / file writers, the trusted project lookup by `?project=<name>`, the shared 409 for an
// ambiguous name and the 423 maintenance-mode refusal. Every route module uses these, so the
// response shapes stay identical across the gateway.
import { anyContainmentOk } from '../security.mjs';
import { listProjects } from '../projects.mjs';
import { isSameResolvedPath } from '../paths.mjs';
// Codex run B F-12: the DYNAMIC admitted-roots boundary (fixed scan roots PLUS whatever the
// registry currently, honestly admits) — replaces the old, fixed-only SYNC_SCAN_ROOTS in
// resolveProjectByName()'s own defense-in-depth check below, so a project the installer registered
// outside the scan roots (the normal case for a beginner's fresh install) is reachable by name/path
// here too, not just listed by GET /api/projects. See admitted-roots.mjs's own header.
import { getContainmentRoots } from '../admitted-roots.mjs';
import { readSyncLock, syncLockedBody } from '../sync-lock.mjs';
import { readJsonBody, BodyTooLargeError } from '../body.mjs';

export function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}

// build-lastdemos T2: a real, single-shot binary response — GET /api/artifacts/:id/content is
// the one route on this gateway that serves file bytes rather than JSON, so it needs its own
// small writer instead of sendJson()'s fixed JSON content type.
export function sendFile(res, status, buffer, fileName, mime) {
  res.writeHead(status, {
    'Content-Type': mime,
    'Content-Disposition': 'attachment; filename="' + fileName + '"',
    'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

/**
 * Reads the JSON request body. On a read/parse failure it answers 413 (too large) or 400 itself and
 * returns `{ answered: true }`; otherwise `{ answered: false, body }`. Same status codes and error
 * text as the inline try/catch every write route used before the split.
 */
export async function readBodyOrRespond(req, res) {
  try {
    return { answered: false, body: await readJsonBody(req) };
  } catch (err) {
    sendJson(res, err instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: err.message });
    return { answered: true };
  }
}

// Resolves a `?project=<name>` query value against the trusted, cached project registry.
// This is the allowlist: a name that doesn't match any real discovered project resolves to
// null, regardless of what the caller typed (so `../../` or any traversal payload as the
// *name* simply never matches an entry and is rejected — it never reaches a filesystem call).
//
// A2 fix (2026-09-26 laptop re-audit): multi-root discovery means two DIFFERENT
// real projects can share the same folder NAME (e.g. a Desktop `my-site` next to a Documents
// `my-site`) — the old `.find()` here silently returned whichever one happened to sort first,
// which meant chat execution (including bypass mode), agent-model edits, file browsing and run
// listings for one project could silently operate on the OTHER project's directory, and their
// conversations (filtered by name only) got mixed. Minimum-acceptable fix for this release: when
// a name matches more than one discovered project, this returns `ambiguous: true` with every
// matching path instead of ever picking one — every call site turns that into a 409, never
// a guess. A clean unique-id scheme (e.g. a short hash of the resolved path) was considered but
// rejected for this release: `?project=<name>` is the URL/query contract used by ~25 routes
// AND by the dashboard's own client code (out of this gateway package's write scope to redesign
// wholesale) — swapping the identifier shape is a real API-contract change, not a minimal fix, so
// it is left as a follow-up rather than bundled into this security fix.
export async function resolveProjectByName(name) {
  const registry = await listProjects();
  if (!registry.ok) return { entry: null, registryError: registry.error };
  // WP-CC1 (item 12): two real, DIFFERENT projects can share one folder name (the A2 fix above) —
  // before this, `?project=test` 409ed for EITHER of them forever, with no way to reach either one
  // by name: "every endpoint fails for that project". The 409 below already hands back each
  // colliding project's own real, unique `path` in `matches` — so a caller may retry the SAME
  // `?project=` param with that exact path instead of the bare name, and always reach the ONE
  // project it means. Checked FIRST and only ever against a path this discovery pass already found
  // real (never an arbitrary caller-supplied filesystem path) — this can never widen access beyond
  // what `/api/projects` already lists, and a name that is not also a real path falls through to
  // the unchanged name-lookup below exactly as before.
  // Lead fix after the real-location suite: only an ABSOLUTE path without any `..`
  // segment is ever tried here. A relative value such as `../../` used to be resolved against the
  // gateway's own working folder and could land on a registered project, so the SECURITY tests
  // ("path traversal via ?project= is rejected") answered 200. The 409's `matches` always carry
  // absolute paths, so item 12 is unaffected.
  const looksLikeAbsolutePath = typeof name === 'string'
    && (/^[A-Za-z]:[\\/]/.test(name) || name.startsWith('/'))
    && !name.split(/[\\/]+/).includes('..');
  const byPath = looksLikeAbsolutePath ? registry.projects.find((p) => isSameResolvedPath(p.path, name)) : null;
  if (byPath) {
    if (!anyContainmentOk(getContainmentRoots(), byPath.path)) return { entry: null }; // defense in depth
    return { entry: byPath };
  }
  const matches = registry.projects.filter((p) => p.name === name);
  if (matches.length > 1) {
    return { entry: null, ambiguous: true, matches: matches.map((p) => ({ name: p.name, path: p.path })) };
  }
  const entry = matches[0];
  if (!entry) return { entry: null };
  if (!anyContainmentOk(getContainmentRoots(), entry.path)) return { entry: null }; // defense in depth
  return { entry };
}

// Shared 409 response for every resolveProjectByName() call site — one place to keep the
// shape consistent rather than repeating the same object literal 25 times.
// N7 fix (2026-09-26 laptop re-audit verification): the old text told the user to "use the
// dashboard's path-qualified selection", a feature that does not exist — nothing in dashboard/src
// lets a user pick a project by path. The message now states the real cause (two folders share the
// same name — both real paths are always in `matches`) and the two real fixes a beginner can do
// today: rename one of the two folders, or open the wanted one directly from its own folder instead
// of picking it by name from the list.
export function sendAmbiguousProject(res, matches) {
  return sendJson(res, 409, {
    ok: false,
    error: 'ambiguous project name: two or more folders are named the same (see "matches" below for their real paths) — to fix this, either rename one of the two folders so the names differ, or open the one you mean directly from its own folder instead of picking it by name',
    matches,
  });
}

export const UNKNOWN_PROJECT_ERROR = 'unknown project (must match /api/projects)';

/**
 * The four-line lookup every `?project=` route ran inline before the split: 502 on a registry
 * failure, 409 on an ambiguous name, 404 on an unknown name (with `notFoundError`, default the
 * shared "unknown project" text). Returns the registry entry, or null when it has answered.
 */
export async function projectOrRespond(res, projectName, notFoundError = UNKNOWN_PROJECT_ERROR) {
  const { entry, registryError, ambiguous, matches } = await resolveProjectByName(projectName);
  if (registryError) { sendJson(res, 502, { ok: false, error: registryError }); return null; }
  if (ambiguous) { sendAmbiguousProject(res, matches); return null; }
  if (!entry) { sendJson(res, 404, { ok: false, error: notFoundError }); return null; }
  return entry;
}

// maintenance mode. A write route that would write into a registered project's .claude/ (or start a
// `claude` process inside it) answers 423 Locked while forge-sync holds a fresh .forge-sync.lock there. Reads are never
// gated. Returns true when it has answered. See sync-lock.mjs.
export function refuseIfSyncLocked(res, entry) {
  const lock = readSyncLock(entry.path);
  if (!lock.locked) return false;
  sendJson(res, 423, syncLockedBody(entry.name, lock));
  return true;
}
