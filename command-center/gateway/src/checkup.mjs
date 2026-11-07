// GET /api/checkup (WP B6) — "Controleer of alles werkt": one quick, read-only look at what this
// pc has, for the onboarding wizard and Settings > Diagnose.
//
// Answers within the 10-second budget from plan §4.6 with:
//   { ok, checked_at, duration_ms, timed_out,
//     claude: { found, version, signedIn },   signedIn: true | false | null (null = could not tell)
//     codex:  { found, version },
//     ollama: { found, up, models[] },
//     node:   { version },
//     git:    { found, version },
//     disk_free_gb, port, writable_project_dir }   writable_project_dir: true | false | null
//
// Rules this module keeps:
//   - Every probe is a fixed program with fixed arguments, run through child_process.execFile with a
//     timeout and windowsHide. Nothing from the request is ever passed to a program.
//   - Sign-in state comes ONLY from the CLI's own `claude auth status --json`, and only its
//     `loggedIn` boolean is kept (the same output also carries an e-mail address and an
//     organisation; those are dropped here and never leave this function). No credential file is
//     ever opened.
//   - Ollama is asked on loopback only (127.0.0.1:11434); nothing goes to the internet.
//   - The optional `dir` (writable_project_dir) is checked with fs.access(W_OK) after the same
//     network/device-path and control-character refusal the folder picker uses, so a UNC path can
//     never make Windows send credentials to another host.
//   - A probe that fails, times out or is missing is reported as found:false / null, never guessed.
//
// Dependencies are injectable (execFile, fetch, statfs, access, platform, env) so the unit test runs
// without spawning a single real process.
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasControlChars, isNetworkOrDevicePath } from './paths.mjs';

/** Whole-request budget; the route must answer within 10 s (plan §4.6). */
export const CHECKUP_BUDGET_MS = 9000;
const LOOKUP_TIMEOUT_MS = 2000;
const VERSION_TIMEOUT_MS = 3000;
const AUTH_TIMEOUT_MS = 3500;
const OLLAMA_TIMEOUT_MS = 2500;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_OLLAMA_MODELS = 50;
/** Characters that would change meaning inside the cmd.exe line used for .cmd/.bat shims. */
const UNSAFE_SHIM_PATH = /["&|^%<>!\r\n]/;
const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?/;

function defaultDeps() {
  return {
    execFile: nodeExecFile,
    fetch: globalThis.fetch,
    statfs: fs.promises.statfs,
    access: fs.promises.access,
    platform: process.platform,
    env: process.env,
    nodeVersion: process.versions.node,
    diskPath: os.homedir(),
  };
}

/** Runs one fixed program. Resolves `{ ok, stdout }`; never rejects. */
function run(deps, file, args, timeoutMs, extra = {}) {
  return new Promise((resolve) => {
    try {
      deps.execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, ...extra },
        (err, stdout) => resolve({ ok: !err, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') }),
      );
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

/** `where` / `which` lookup. Returns the preferred absolute path or null. */
async function locate(deps, name) {
  const lookup = deps.platform === 'win32' ? 'where' : 'which';
  const result = await run(deps, lookup, [name], LOOKUP_TIMEOUT_MS);
  if (!result.ok) return null;
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (candidates.length === 0) return null;
  if (deps.platform !== 'win32') return candidates[0];
  // On Windows a bare npm shim (no extension) cannot be executed; prefer .exe, then .cmd/.bat.
  return (
    candidates.find((c) => /\.exe$/i.test(c)) ??
    candidates.find((c) => /\.(cmd|bat)$/i.test(c)) ??
    null
  );
}

/** Runs a located program with fixed arguments; .cmd/.bat shims go through cmd.exe verbatim. */
function runLocated(deps, location, args, timeoutMs) {
  if (deps.platform === 'win32' && /\.(cmd|bat)$/i.test(location)) {
    if (UNSAFE_SHIM_PATH.test(location)) return Promise.resolve({ ok: false, stdout: '' });
    const comspec = deps.env.ComSpec || 'cmd.exe';
    const line = `""${location}" ${args.join(' ')}"`;
    return run(deps, comspec, ['/d', '/s', '/c', line], timeoutMs, { windowsVerbatimArguments: true });
  }
  return run(deps, location, args, timeoutMs);
}

function parseVersion(stdout) {
  const match = VERSION_PATTERN.exec(stdout ?? '');
  return match ? match[0] : null;
}

/** Keeps only the `loggedIn` boolean of `claude auth status --json`; everything else is dropped. */
export function parseSignedIn(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return typeof parsed?.loggedIn === 'boolean' ? parsed.loggedIn : null;
  } catch {
    return null;
  }
}

async function probeClaude(deps) {
  const location = await locate(deps, 'claude');
  if (location === null) return { found: false, version: null, signedIn: null };
  const [version, auth] = await Promise.all([
    runLocated(deps, location, ['--version'], VERSION_TIMEOUT_MS),
    runLocated(deps, location, ['auth', 'status', '--json'], AUTH_TIMEOUT_MS),
  ]);
  return {
    found: true,
    version: version.ok ? parseVersion(version.stdout) : null,
    signedIn: auth.ok ? parseSignedIn(auth.stdout) : null,
  };
}

async function probeVersioned(deps, name) {
  const location = await locate(deps, name);
  if (location === null) return { found: false, version: null };
  const version = await runLocated(deps, location, ['--version'], VERSION_TIMEOUT_MS);
  return { found: true, version: version.ok ? parseVersion(version.stdout) : null };
}

async function probeOllama(deps) {
  const [location, tags] = await Promise.all([
    locate(deps, 'ollama'),
    (async () => {
      if (typeof deps.fetch !== 'function') return null;
      try {
        const res = await deps.fetch(OLLAMA_TAGS_URL, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    })(),
  ]);
  const up = tags !== null && typeof tags === 'object';
  const models = up && Array.isArray(tags.models)
    ? tags.models
        .map((m) => (m && typeof m.name === 'string' ? m.name : null))
        .filter((name) => name !== null)
        .slice(0, MAX_OLLAMA_MODELS)
    : [];
  // A running server proves an install even when the program is not on PATH.
  return { found: location !== null || up, up, models };
}

async function probeDiskFreeGb(deps) {
  try {
    const stats = await deps.statfs(deps.diskPath);
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(bytes) ? Math.round((bytes / 1e9) * 10) / 10 : null;
  } catch {
    return null;
  }
}

/** True/false when a usable folder was given, null when none (or an unusable one) was given. */
async function probeWritable(deps, dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return null;
  const candidate = dir.trim();
  if (hasControlChars(candidate) || isNetworkOrDevicePath(candidate) || !path.isAbsolute(candidate)) return null;
  try {
    await deps.access(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function withDeadline(promise, ms, fallback) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ value: fallback, late: true }), ms);
  });
  return Promise.race([promise.then((value) => ({ value, late: false })), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Builds the checkup answer. `opts.port` is the port this gateway listens on; `opts.projectDir`
 * is the optional folder to test for write access. Every other key overrides a dependency (tests).
 */
export async function buildCheckup(opts = {}) {
  const deps = { ...defaultDeps(), ...opts };
  const started = Date.now();
  const budget = typeof opts.budgetMs === 'number' ? opts.budgetMs : CHECKUP_BUDGET_MS;

  const probes = await Promise.all([
    withDeadline(probeClaude(deps), budget, { found: false, version: null, signedIn: null }),
    withDeadline(probeVersioned(deps, 'codex'), budget, { found: false, version: null }),
    withDeadline(probeOllama(deps), budget, { found: false, up: false, models: [] }),
    withDeadline(probeVersioned(deps, 'git'), budget, { found: false, version: null }),
    withDeadline(probeDiskFreeGb(deps), budget, null),
    withDeadline(probeWritable(deps, opts.projectDir), budget, null),
  ]);
  const [claude, codex, ollama, git, disk, writable] = probes;

  return {
    ok: true,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    timed_out: probes.some((p) => p.late),
    claude: claude.value,
    codex: codex.value,
    ollama: ollama.value,
    node: { version: typeof deps.nodeVersion === 'string' ? deps.nodeVersion : null },
    git: git.value,
    disk_free_gb: disk.value,
    port: Number.isInteger(opts.port) ? opts.port : null,
    writable_project_dir: writable.value,
  };
}

// A checkup starts a handful of short processes; repeated clicks within this window share one
// answer instead of spawning again. Keyed by the folder asked about.
const CACHE_MS = 2000;
let cached = null;
let inFlight = null;

/** The route entry point: in-flight de-duplication plus a 2-second cache. */
export async function getCheckup(opts = {}) {
  const key = typeof opts.projectDir === 'string' ? opts.projectDir : '';
  const now = Date.now();
  if (cached && cached.key === key && now - cached.at < CACHE_MS) return cached.value;
  if (inFlight && inFlight.key === key) return inFlight.promise;
  const promise = buildCheckup(opts).then((value) => {
    cached = { key, at: Date.now(), value };
    return value;
  }).finally(() => {
    if (inFlight && inFlight.promise === promise) inFlight = null;
  });
  inFlight = { key, promise };
  return promise;
}

export function _resetCheckupCacheForTests() {
  cached = null;
  inFlight = null;
}
