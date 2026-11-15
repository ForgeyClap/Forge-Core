// Forge gateway: per-project autonomy for permission cards (WP-AUTONOMY-GW, owner decision R-0203,
// "ja automatisch willen we!"). With autonomy on for a turn's project, a card that is not a hard gate
// (permissions/hard-gate.mjs) is allowed at once; hard-gate cards still wait for the owner.
//
// Default ON (the owner's explicit choice). The owner can switch one project off (and on again) in the
// dashboard: PUT /api/permissions/autonomy. Stored as { "projects": { "<project name>": true|false } }.
//
// Where: a per-user folder, ~/.forge/permissions/autonomy.json, never the gateway data dir. In the dev
// layout that data dir (command-center/.data) sits inside this repository, where an agent in
// accept-edits mode may write files without a card, so it could switch a project the owner turned off
// back on. Same rule as remote/manager.mjs and permissions/trust.mjs: when the file resolves inside a
// project folder the gateway knows, nothing is read or written and autonomy is OFF everywhere (fail
// closed). A file that exists but cannot be read is also OFF everywhere, and is not overwritten.
// Under the Node test runner without a test folder, the real per-user file is never read or written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT, realpathOrNull } from '../paths.mjs';
import { getContainmentRoots } from '../admitted-roots.mjs';
import { anyContainmentOk } from '../security.mjs';
import { realLocation } from '../remote/real-location.mjs';

export const AUTONOMY_DEFAULT = true;
export const AUTONOMY_STATE_INSIDE_PROJECT = 'autonomy_state_inside_project';
export const AUTONOMY_STATE_UNREADABLE = 'autonomy_state_unreadable';
export const AUTONOMY_TEST_WITHOUT_DIR = 'autonomy_test_without_dir';

const PER_USER_DIR = path.join(os.homedir(), '.forge', 'permissions');
let dirOverride = null;

function isTestWithoutDir() {
  return dirOverride === null && Boolean(process.env.NODE_TEST_CONTEXT);
}

export function autonomyFile() {
  return path.join(dirOverride || PER_USER_DIR, 'autonomy.json');
}

/** null, or the problem code when the file sits inside a project folder. Fail closed. */
function locationProblem() {
  try {
    const folders = [PROJECT_ROOT, ...getContainmentRoots()].map((f) => realpathOrNull(f) || path.resolve(f));
    const loc = realLocation(autonomyFile());
    if (loc !== null && !anyContainmentOk(folders, loc)) return null;
  } catch { /* cannot judge: refuse */ }
  return AUTONOMY_STATE_INSIDE_PROJECT;
}

/** { ok: true, projects } or { ok: false, code }. A missing file is an empty one. */
function readStored() {
  if (isTestWithoutDir()) return { ok: true, projects: {} };
  const problem = locationProblem();
  if (problem) return { ok: false, code: problem };
  let raw;
  try {
    // round 11 (L2): a symbolic link, or a hard link to another file, is never read (as in code-marks.mjs)
    const st = fs.lstatSync(autonomyFile());
    if (!st.isFile() || st.nlink > 1) return { ok: false, code: AUTONOMY_STATE_UNREADABLE };
    raw = fs.readFileSync(autonomyFile(), 'utf8');
  } catch (err) {
    return err && err.code === 'ENOENT' ? { ok: true, projects: {} } : { ok: false, code: AUTONOMY_STATE_UNREADABLE };
  }
  try {
    const parsed = JSON.parse(raw);
    const stored = parsed && typeof parsed.projects === 'object' && parsed.projects !== null && !Array.isArray(parsed.projects) ? parsed.projects : null;
    if (!stored) return { ok: false, code: AUTONOMY_STATE_UNREADABLE };
    return { ok: true, projects: Object.fromEntries(Object.entries(stored).filter(([, v]) => typeof v === 'boolean')) };
  } catch {
    return { ok: false, code: AUTONOMY_STATE_UNREADABLE };
  }
}

/** `{ default, projects, problem }`. With a problem, default is false and nothing is auto-allowed. */
export function readAutonomy() {
  const stored = readStored();
  if (!stored.ok) return { default: false, projects: {}, problem: stored.code };
  return { default: AUTONOMY_DEFAULT, projects: stored.projects, problem: null };
}

/** True when cards of `project` that are not hard gates may be allowed at once. */
export function isAutonomyOn(project) {
  if (typeof project !== 'string' || project.length === 0) return false;
  const a = readAutonomy();
  if (a.problem) return false;
  return Object.hasOwn(a.projects, project) ? a.projects[project] : a.default;
}

/** The effective value for each name (plus every stored one). */
export function effectiveAutonomy(projectNames) {
  const a = readAutonomy(); // with a problem: no stored values and default false, so every project is off
  const out = {};
  for (const name of [...Object.keys(a.projects), ...projectNames]) out[name] = Object.hasOwn(a.projects, name) ? a.projects[name] : a.default;
  return out;
}

/** Stores one project's choice. `{ ok: true }` or `{ ok: false, code, error }`. The caller checks the name. */
export function setAutonomy(project, enabled, { source = 'unknown' } = {}) {
  if (typeof project !== 'string' || project.length === 0 || typeof enabled !== 'boolean') {
    return { ok: false, code: 'invalid_request', error: 'project must be a name and enabled true or false' };
  }
  if (isTestWithoutDir()) return { ok: false, code: AUTONOMY_TEST_WITHOUT_DIR, error: 'tests must set a temp folder for the autonomy setting' };
  const stored = readStored();
  if (!stored.ok) {
    const error = stored.code === AUTONOMY_STATE_INSIDE_PROJECT
      ? 'the autonomy setting file ' + autonomyFile() + ' is inside a project folder, where an agent may write files without asking; it is not written there'
      : 'the autonomy setting file ' + autonomyFile() + ' cannot be read; fix or remove it first (nothing is auto-allowed until then)';
    return { ok: false, code: stored.code, error };
  }
  const file = autonomyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ projects: { ...stored.projects, [project]: enabled } }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  try {
    fs.appendFileSync(path.join(path.dirname(file), 'autonomy-events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), kind: 'permission_autonomy_changed', project, enabled, source }) + '\n', 'utf8');
  } catch { /* best-effort: the setting itself is written */ }
  return { ok: true };
}

export function _setAutonomyDirForTests(dir) {
  dirOverride = dir || null;
}
