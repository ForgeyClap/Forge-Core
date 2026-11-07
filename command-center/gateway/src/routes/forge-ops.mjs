// Read-only routes for two Forge safety tools (WP A6-3,; A6 decision
// table rows 12 and 21, after A11).
//
//   GET /api/forge-ops/killswitch/status?project=<name>        forge-killswitch.cjs status --json
//   GET /api/forge-ops/rollback/list?project=<name>            forge-rollback.cjs list --json
//   GET /api/forge-ops/rollback/plan?project=<name>&run=<id>   forge-rollback.cjs plan --run <id> --json
//
// READ-ONLY BY CONSTRUCTION. The argv of every child is one of the three frozen arrays below plus
// `--root <registered project path>` (and the validated run id for `plan`). Nothing from the request
// is ever turned into a sub-command or a flag. The destructive commands - killswitch `stop --confirm`
// and `restore --confirm`, rollback `apply --yes`, `undo --yes` and `checkpoint` (it writes a record and
// a tag) - are NOT reachable over HTTP at all: they stay terminal-only and owner-triggered
// (.claude/docs/forge-reference/forge-cmd-subcommands.md). The killswitch could not stop the gateway
// from here anyway: the gateway would be its own ancestor and is skipped (the tool's own header).
//
// SETTINGS, NEVER CODE (the wp20 L9 rule config.mjs follows): the gateway only ever executes its OWN
// copy of each tool (PROJECT_ROOT/.claude/forge-bin), pointed at the selected project with `--root`.
// It never runs the selected project's own forge-bin code. The project's own copy is only checked for
// presence: a project whose Forge has no such tool gets an honest TOOL_NOT_FOUND, never a guess.
//
// Child process: cwd = PROJECT_ROOT, the credential-free env allowlist (filteredEnv({ credentialFree:
// true }) - no *_TOKEN / *_SECRET / *_KEY, so also no FORGE_ROLLBACK_GIT override), a 10 s timeout,
// windowsHide, a bounded output buffer. Every answer (stdout JSON, stderr reason) is redacted before
// it leaves. Security conventions shared with the other GET routes: the request listener already
// refused non-loopback / cross-site requests; `?project=` resolves only through the trusted registry
// (projectOrRespond); a run id is checked against the tool's own pattern before any project lookup.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { redact, redactDeep } from '../redact.mjs';
import { filteredEnv } from '../exec-cli.mjs';
import { PROJECT_ROOT } from '../paths.mjs';
import { sendJson, projectOrRespond } from './http.mjs';

export const MODULE = 'forge-ops';

export const TOOL_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_NOTE = 500;
// The same pattern forge-rollback.cjs enforces (RUN_ID_RE); checked here first so a bad id never spawns.
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const KILLSWITCH_TOOL = 'forge-killswitch.cjs';
export const ROLLBACK_TOOL = 'forge-rollback.cjs';

// The ONLY sub-commands this module can ever run. Frozen; a test asserts none of them is destructive.
export const KILLSWITCH_STATUS_ARGS = Object.freeze(['status', '--json']);
export const ROLLBACK_LIST_ARGS = Object.freeze(['list', '--json']);
export const ROLLBACK_PLAN_ARGS = Object.freeze(['plan', '--json']);

/** The routes of this module, for the Lead's route table and for the "GET only" test. */
export const ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/api/forge-ops/killswitch/status', handler: 'killswitchStatus' }),
  Object.freeze({ method: 'GET', path: '/api/forge-ops/rollback/list', handler: 'rollbackList' }),
  Object.freeze({ method: 'GET', path: '/api/forge-ops/rollback/plan', handler: 'rollbackPlan' }),
]);

const CENTRAL_BIN_DIR = path.join(PROJECT_ROOT, '.claude', 'forge-bin');

// Test-only seams (same shape as config.mjs's _setForgeConfigCjsForTests). Production never calls them.
let binDirOverride = null;
let timeoutOverride = null;
export function _setForgeOpsBinDirForTests(dir) { binDirOverride = dir; }
export function _setForgeOpsTimeoutForTests(ms) { timeoutOverride = ms; }
export function _resetForgeOpsForTests() { binDirOverride = null; timeoutOverride = null; }

const centralToolPath = (tool) => path.join(binDirOverride || CENTRAL_BIN_DIR, tool);
const note = (text) => redact(String(text || '').trim().slice(0, MAX_NOTE * 4)).slice(0, MAX_NOTE);

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function unavailable(tool, command, state, reason) {
  return { tool, command, available: false, state, exit_code: null, result: null, note: note(reason) };
}

function parseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, value: null }; }
}

function spawnTool(scriptPath, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], {
      cwd: PROJECT_ROOT, env: filteredEnv({ credentialFree: true }), timeout: timeoutOverride || TOOL_TIMEOUT_MS,
      windowsHide: true, encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES,
    }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// Maps one finished child to the answer. Exit 0 + JSON = OK. A non-zero exit is the tool's own
// refusal (e.g. "no checkpoint for run X"): REFUSED with its redacted reason. The killswitch on a
// non-Windows OS prints { ok:false, supported:false } and exits 2: UNSUPPORTED.
function mapResult(tool, command, { err, stdout, stderr }) {
  const timeoutMs = timeoutOverride || TOOL_TIMEOUT_MS;
  if (err && err.killed) return unavailable(tool, command, 'TIMEOUT', tool + ' ' + command + ' timed out after ' + timeoutMs + 'ms');
  if (err && typeof err.code !== 'number') return unavailable(tool, command, 'FAILED', tool + ' could not be started: ' + (err.code || err.message));
  const exitCode = err ? err.code : 0;
  const parsed = stdout.trim() === '' ? { ok: false, value: null } : parseJson(stdout);
  if (parsed.ok && parsed.value && parsed.value.supported === false) {
    return { tool, command, available: false, state: 'UNSUPPORTED', exit_code: exitCode, result: redactDeep(parsed.value), note: note(parsed.value.reason) };
  }
  if (exitCode !== 0) {
    return { tool, command, available: true, state: 'REFUSED', exit_code: exitCode, result: parsed.ok ? redactDeep(parsed.value) : null,
      note: note(stderr || (parsed.ok ? '' : stdout) || tool + ' exited with code ' + exitCode) };
  }
  if (!parsed.ok) return unavailable(tool, command, 'FAILED', tool + ' ' + command + ' returned output that is not JSON');
  return { tool, command, available: true, state: 'OK', exit_code: 0, result: redactDeep(parsed.value), note: null };
}

/**
 * Runs one read-only sub-command of a tool for a registered project. Never throws.
 * @param {string} projectPath registered project path (from the trusted registry)
 */
export async function runReadOnlyTool(projectPath, tool, args, extraArgs = []) {
  const command = args[0];
  if (!isFile(path.join(projectPath, '.claude', 'forge-bin', tool))) {
    return unavailable(tool, command, 'TOOL_NOT_FOUND', 'tool not found: this project has no .claude/forge-bin/' + tool);
  }
  const scriptPath = centralToolPath(tool);
  if (!isFile(scriptPath)) return unavailable(tool, command, 'TOOL_NOT_FOUND', 'tool not found: the gateway has no own copy of ' + tool);
  try {
    return mapResult(tool, command, await spawnTool(scriptPath, [...args, ...extraArgs, '--root', projectPath]));
  } catch (err) {
    return unavailable(tool, command, 'FAILED', tool + ' failed: ' + (err && err.message ? err.message : String(err)));
  }
}

export const buildKillswitchStatus = (projectPath) => runReadOnlyTool(projectPath, KILLSWITCH_TOOL, KILLSWITCH_STATUS_ARGS);
export const buildRollbackList = (projectPath) => runReadOnlyTool(projectPath, ROLLBACK_TOOL, ROLLBACK_LIST_ARGS);
export function buildRollbackPlan(projectPath, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return Promise.resolve(null);
  return runReadOnlyTool(projectPath, ROLLBACK_TOOL, ROLLBACK_PLAN_ARGS, ['--run', runId]);
}

function refuseNonGet(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  sendJson(res, 405, { ok: false, error: 'method not allowed (GET only)' }, { Allow: 'GET' });
  return true;
}

function answer(res, result) {
  return sendJson(res, 200, redactDeep({ ok: true, ...result, captured_at: new Date().toISOString(), provenance: 'DERIVED' }));
}

/** GET /api/forge-ops/killswitch/status?project=<name> */
export async function killswitchStatus(req, res, { searchParams }) {
  if (refuseNonGet(req, res)) return undefined;
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  return answer(res, await buildKillswitchStatus(entry.path));
}

/** GET /api/forge-ops/rollback/list?project=<name> */
export async function rollbackList(req, res, { searchParams }) {
  if (refuseNonGet(req, res)) return undefined;
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  return answer(res, await buildRollbackList(entry.path));
}

/** GET /api/forge-ops/rollback/plan?project=<name>&run=<id> */
export async function rollbackPlan(req, res, { searchParams }) {
  if (refuseNonGet(req, res)) return undefined;
  const runId = searchParams.get('run') || '';
  // Like /api/jobs/detail: an invalid id is refused before any project lookup or spawn.
  if (!RUN_ID_RE.test(runId)) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id> (letters, digits, - and _ only)' });
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  return answer(res, await buildRollbackPlan(entry.path, runId));
}
