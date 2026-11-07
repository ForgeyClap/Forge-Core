// Forge gateway — per-project "full access" trust (WP B3, plan 4.4 + F17).
//
// bypassPermissions is only ever spawned when the request explicitly asks for `bypass` AND the
// project folder is marked trusted here. Nothing marks a project trusted on its own. In this
// release the HTTP routes that would set the mark (GET/POST /api/permissions/trust) are NOT
// registered (Security Boss decision, Step 2 waits for the owner), so the mark can only come from a
// trust file placed by hand; the handlers stay in routes/permissions.mjs for that later step.
//
// Stored as a small JSON file under the gateway data dir: { "trusted": ["<real path>", ...] }.
// A missing or unreadable file means "nothing is trusted" (fail closed).
//
// WP B3-sec-impl (Security Boss Step 1c): an agent may write files inside the project folder it
// works in without a card (acceptEdits). In the dev layout the data dir (command-center/.data) sits
// inside this repository, so the agent could mark its own project trusted by writing the file.
// Therefore: when the trust file resolves inside a project folder the gateway knows, NOTHING is
// trusted and a change is refused. "A project folder the gateway knows" is, fail-closed, any of:
// the folder being asked about, every folder the trust file itself names, the gateway's own project
// root, every admitted containment root (the scan roots, under which every discovered project
// lives, plus each registered project folder, admitted-roots.mjs). Each ignored read, refused change and real change is appended as one JSON
// line to trust-events.jsonl next to the trust file (permission_trust_ignored /
// permission_trust_changed), with time, source and reason.
import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_CENTER_DATA_DIR, PROJECT_ROOT, realpathOrNull } from '../paths.mjs';
import { getContainmentRoots } from '../admitted-roots.mjs';
import { anyContainmentOk } from '../security.mjs';

export const TRUST_FILE_INSIDE_PROJECT = 'trust_file_inside_project';

let fileOverride = null;
function trustFile() {
  return fileOverride || path.join(COMMAND_CENTER_DATA_DIR, 'permissions', 'trusted-projects.json');
}

function norm(p) {
  const real = realpathOrNull(p) || path.resolve(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** Where the trust file really is: its real path, or (not written yet) its real folder + name. */
function realTrustFileLocation() {
  const file = trustFile();
  const real = realpathOrNull(file);
  if (real) return real;
  const dir = realpathOrNull(path.dirname(file));
  return dir ? path.join(dir, path.basename(file)) : path.resolve(file);
}

function realOrResolved(p) {
  return realpathOrNull(p) || path.resolve(p);
}

/** TRUST_FILE_INSIDE_PROJECT when the trust file sits inside a project folder (see the header),
 *  otherwise null. The folders the file itself names as trusted count as project folders too, so a
 *  file that trusts the folder it sits in is never honoured. Never throws: a check that cannot run
 *  counts as "inside" (fail closed). */
function trustFileProblem(projectPath, listed) {
  try {
    const folders = [...getContainmentRoots(), realOrResolved(PROJECT_ROOT), ...listed.map(realOrResolved)];
    if (typeof projectPath === 'string' && projectPath.length > 0) folders.push(realOrResolved(projectPath));
    return anyContainmentOk(folders, realTrustFileLocation()) ? TRUST_FILE_INSIDE_PROJECT : null;
  } catch {
    return TRUST_FILE_INSIDE_PROJECT;
  }
}

function eventsFile() {
  return path.join(path.dirname(trustFile()), 'trust-events.jsonl');
}

/** Appends one trust event. Best-effort: a log failure never changes the trust answer. */
function logTrustEvent(kind, data) {
  try {
    const file = eventsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + '\n', 'utf8');
  } catch {
    /* best-effort: the answer (fail closed) does not depend on the log */
  }
}

function readTrusted() {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustFile(), 'utf8'));
    return Array.isArray(parsed.trusted) ? parsed.trusted.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** The trusted folders, or [] when the trust file sits inside a project folder (nothing trusted). */
export function listTrustedProjects() {
  const listed = readTrusted();
  return trustFileProblem(null, listed) ? [] : listed;
}

export function isProjectTrusted(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.length === 0) return false;
  const want = norm(projectPath);
  const listed = readTrusted();
  if (!listed.some((p) => norm(p) === want)) return false;
  const problem = trustFileProblem(projectPath, listed);
  if (problem) {
    logTrustEvent('permission_trust_ignored', { source: 'read', project: projectPath, trust_file: trustFile(), reason: problem });
    return false;
  }
  return true;
}

/**
 * Marks or unmarks one project folder. The caller validates that it is a registered project.
 * Refused (throws, with `code` TRUST_FILE_INSIDE_PROJECT) when the trust file sits inside a project
 * folder. `source` names who asked (logged with the change).
 */
export function setProjectTrusted(projectPath, trusted, { source = 'unknown' } = {}) {
  const problem = trustFileProblem(projectPath, readTrusted());
  if (problem) {
    logTrustEvent('permission_trust_ignored', { source, action: 'set', project: projectPath, trusted: Boolean(trusted), trust_file: trustFile(), reason: problem });
    const err = new Error('the trust file sits inside a project folder, so trust cannot be stored there');
    err.code = problem;
    throw err;
  }
  const want = norm(projectPath);
  const next = readTrusted().filter((p) => norm(p) !== want);
  if (trusted) next.push(realpathOrNull(projectPath) || path.resolve(projectPath));
  const file = trustFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ trusted: next }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  logTrustEvent('permission_trust_changed', { source, project: projectPath, trusted: Boolean(trusted) });
  return next;
}

export function _setTrustFileForTests(file) {
  fileOverride = file || null;
}
