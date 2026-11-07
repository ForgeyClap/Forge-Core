// Fixed, computed-at-startup path constants. Nothing here is ever derived from request input —
// this file exists precisely so no other module has to compute "where is .claude" itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// WP B1a: two directories can be relocated by env, read ONCE at import (never from a
// request), so an installed app can keep its code read-only and its user data outside the install:
//   FORGE_CORE_DIR - the read-only Forge core (holds .claude/); default = the dev derivation below.
//   FORGE_DATA_DIR - every gateway write (conversations, attachments, sessions, discord state,
//                    agent-model and config edit logs, ask-MCP configs); default = command-center/.data.
// A set-but-invalid value FAILS the import with a clear error instead of silently falling back: a
// gateway that quietly writes somewhere else than the caller asked splits the user's data.
function envDirOrNull(name, { mustExist }) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  const bad = (why) => new Error('[paths] ' + name + ' is invalid: ' + why);
  // Same rules as UNC_RE / CONTROL_CHAR_RE further down, written out here because this runs at
  // import time ABOVE those const declarations (reading them here would be a TDZ ReferenceError).
  if (/^[\\/]{2}/.test(trimmed)) throw bad('a network or device path is not allowed');
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw bad('it contains control characters');
  if (!path.isAbsolute(trimmed)) throw bad('"' + trimmed + '" is not an absolute path');
  const resolved = path.resolve(trimmed);
  if (isDriveRoot(resolved)) throw bad('"' + resolved + '" is a drive root');
  let stat = null;
  try { stat = fs.statSync(resolved); } catch { stat = null; }
  if (stat && !stat.isDirectory()) throw bad('"' + resolved + '" exists but is not a directory');
  if (!stat && mustExist) throw bad('"' + resolved + '" does not exist');
  return resolved;
}

// gateway/src -> gateway -> command-center -> project root ("my project!")
export const GATEWAY_DIR = path.resolve(__dirname, '..');
export const COMMAND_CENTER_DIR = path.resolve(GATEWAY_DIR, '..');
const DERIVED_PROJECT_ROOT = path.resolve(COMMAND_CENTER_DIR, '..');
const CORE_DIR_FROM_ENV = envDirOrNull('FORGE_CORE_DIR', { mustExist: true });
export const PROJECT_ROOT = CORE_DIR_FROM_ENV || DERIVED_PROJECT_ROOT;
export const CLAUDE_DIR = path.join(PROJECT_ROOT, '.claude');
export const FORGE_RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');
export const FORGE_SYNC_CJS = path.join(CLAUDE_DIR, 'forge-bin', 'forge-sync.cjs');
// WP7a: repointed from the retired hand-built app/dist to the imported owner dashboard's own
// build output. dashboard/ is the byte-identical import of the owner's preserved prototype
// (see mission/discovery/T7-integration-plan.md); its dist/ is rebuilt fresh via `npm run build`
// inside command-center/dashboard, never carried over stale from the source.
export const APP_DIST_DIR = path.join(COMMAND_CENTER_DIR, 'dashboard', 'dist');

// Fixed scan root for the project registry (forge-sync.cjs list <root>): the PARENT of this
// project's own root, i.e. the Documents folder this whole "Forge fleet" lives under. Computed,
// never taken from a request — satisfies "no user input in args ever" for the spawned CLI.
// WP B1a: used in dev mode only. FORGE_PROJECT_ROOTS (see below) replaces it, and in installed mode
// (FORGE_CORE_DIR set) it is never used, so an installed app never scans (or creates ForgeProjects/
// in) the parent of its install folder.
const DERIVED_SYNC_SCAN_ROOT = path.dirname(PROJECT_ROOT);

// C1 fix (2026-09-26 laptop re-audit): SYNC_SCAN_ROOT alone only ever finds a project that
// happens to be a SIBLING of wherever this repo was cloned — on a fresh machine where the clone
// lives somewhere else than the user's real projects (e.g. a scratch folder, while a real project
// sits on the Desktop), that missed it entirely (: "the dashboard only finds
// projects next to the repo clone ... never the Desktop project"). SYNC_SCAN_ROOTS scans every
// well-known Forge project location plus one optional operator-set extra root, deduplicated by
// resolved path so the same folder is never scanned twice:
//   1. SYNC_SCAN_ROOT     - kept for backward compatibility (a "Forge fleet" checked out together
//                           under one folder still works exactly as before).
//   2. <home>/Documents   - Forge's own established default project root (matches
//                           forge-registry.cjs's own defaultRoot(), and most /forge docs).
//   3. <home>/Desktop     - the other common beginner location — exactly what C1 found missing.
//   4. process.env.CC_PROJECTS_EXTRA_ROOT, when set — one operator-configurable extra root for a
//      non-default location. Read once at startup from the environment, never from request input.
// A root that does not exist on this machine is never an error: forge-sync.cjs's own
// findForgeProjects() already treats a missing/unreadable root as "0 projects found" (see
// projects.mjs's computeProjectsAsync(), which scans every root here in parallel and merges the
// results). Every real project entry is still re-validated against SYNC_SCAN_ROOTS via
// anyContainmentOk() (security.mjs) before its path is ever used — but that check is only ever as
// tight as this list of roots IS: adding a root to SYNC_SCAN_ROOTS genuinely widens what
// anyContainmentOk() accepts (A3 fix,, 2026-09-26 laptop re-audit — an earlier version of
// this comment claimed the opposite, which was false: containment is "resolves under ANY of these
// roots", so one more root is one more thing containment says yes to). Because of that,
// CC_PROJECTS_EXTRA_ROOT is validated before it is ever added to the list, not merely resolved:
// only an absolute, LOCAL path (never a UNC/network share like `\\host\share\...`) to a directory
// that genuinely exists, is not a drive root (`C:\`, `/`), and is not the home folder itself, is
// accepted — a value that fails any of those checks is ignored outright (one clear log line,
// never a silent partial-accept) so this env var can only ever point at "one more ordinary
// project folder", never at the whole home directory or a network path.
const EXTRA_SCAN_ROOT_ENV_NAME = 'CC_PROJECTS_EXTRA_ROOT';

function logRejectedExtraRoot(reason) {
  console.error('[paths] ' + EXTRA_SCAN_ROOT_ENV_NAME + ' ignored: ' + reason);
}

// N5 fix (2026-09-26 laptop re-audit verification): comparing the LITERAL resolved path to
// home let three things through: a differently-cased path on win32 (`c:\users\YOU` next to the
// real `C:\Users\YOU`), a folder ABOVE home (`C:\Users` genuinely CONTAINS the home folder, so
// scanning it scans home too), and a junction/symlink whose literal path looks like an ordinary
// folder but actually resolves to home (or to one of home's ancestors) — none of those were ever
// followed to their real target before the comparison. `normalizeForCompare` makes the comparison
// case-insensitive on win32 only (NTFS/ReFS are case-preserving but not case-sensitive by default;
// other platforms keep exact-case comparison).
function normalizeForCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// exported so other modules (projects.mjs) never have to re-derive the
// win32 case-insensitivity rule themselves — a plain resolved-path identity check, deliberately
// NOT the heavier realpath/symlink resolution `validateExtraScanRoot` below applies. That extra
// rigor exists there because an operator-supplied extra scan root WIDENS a security-relevant trust
// boundary; comparing a discovered project path against the well-known template-install location
// (or one candidate path against another) is not a trust-boundary decision, so the lighter,
// proportionate check already used throughout this file is enough here too.
export function isSameResolvedPath(a, b) {
  return normalizeForCompare(path.resolve(a)) === normalizeForCompare(path.resolve(b));
}

// Resolves symlinks/junctions to their real, on-disk target. Returns null (never throws) when the
// path cannot be resolved (e.g. a broken/circular link) — treated the same as "does not exist",
// which is the safe default for a security-relevant check like this one.
// Codex run B F-12: exported — projects.mjs/installed-projects.mjs/admitted-roots.mjs
// all need this SAME real-path primitive to canonicalize a discovered or registered project path
// before it is ever admitted, so a junction that is lexically inside a scan root but resolves
// outside it (or a registered path that resolves somewhere entirely different) is judged by where
// it REALLY lives, never by its typed/linked text alone.
export function realpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// F2/Q2 fixes (2026-09-26 independent security re-review): a UNC/network path check and a
// "is this its own filesystem root" check are both needed TWICE — once on the raw typed text
// (below) and once on the RESOLVED real target (a junction/symlink can look like an ordinary local
// folder while typed, yet resolve to a drive root or a network share) — shared here so both call
// sites use the exact same rule.
const UNC_RE = /^[\\/]{2}/;

// Codex run B F-01: the same rule, exported for every place that takes a path from a
// request, a setting or the central project registry. It is a pure text check and must run BEFORE
// any filesystem call: on Windows even a stat of `\\host\share\...` (or of a device path such as
// `\\?\UNC\host\share` or `\\.\pipe\x`) can make the OS contact that host and send the user's
// NTLM credentials.
export function isNetworkOrDevicePath(p) {
  return typeof p === 'string' && UNC_RE.test(p);
}

// CR, LF, NUL and the other control characters never belong in a folder path, and in a value
// written into a line-based file (.env) they can add a line of their own (Codex run B F-03).
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
export function hasControlChars(p) {
  return typeof p === 'string' && CONTROL_CHAR_RE.test(p);
}

// Codex run B F-01: a bounded, hop-by-hop safe replacement for
// fs.realpathSync.native() -- that single native call happily follows an ENTIRE symlink/junction
// chain (including through a link that targets a network share or a Windows device path) before
// any caller ever gets a chance to inspect what it is about to touch. This walks the path one
// component at a time instead: an ordinary (non-link) component is simply appended and lstat'd to
// confirm it exists; a symlink/junction component has its RAW target text (fs.readlinkSync --
// never resolved further by the OS) checked with isNetworkOrDevicePath/hasControlChars BEFORE that
// target is ever joined in and walked into. Only once a whole pass finds zero remaining links does
// it call fs.realpathSync.native() on the now-proven-link-free path, purely to pick up the
// OS-canonical case/8.3-name form -- by that point every component has already been lstat'd
// individually, so that final call has nothing left to traverse.
//
// `inputPath` must already be absolute (callers resolve with path.resolve() first, same
// precondition fs.realpathSync.native() itself has). Returns `{ ok:true, real }` on success, or
// `{ ok:false, code, error }` on any problem -- including the ordinary "does not exist" case
// (code 'ENOENT'), which every existing caller already handled as a plain "not found", not a
// security condition. `code` is `'EUNSAFE_LINK'`/`'EUNSAFE_CHARS'` specifically when a network/
// device path or a control character was found (in the input itself, or in a link's own target),
// `'ELOOP'` for a symlink chain longer than MAX_SYMLINK_HOPS (mirrors Node's own ELOOP for a
// symlink cycle), and the real fs error code otherwise (ENOENT, EACCES, ...).
const MAX_SYMLINK_HOPS = 40;

export function safeRealpathSync(inputPath) {
  let current = inputPath;
  let hops = 0;
  for (;;) {
    if (isNetworkOrDevicePath(current)) {
      return { ok: false, code: 'EUNSAFE_LINK', error: 'that is a network or device location, which is not allowed' };
    }
    if (hasControlChars(current)) {
      return { ok: false, code: 'EUNSAFE_CHARS', error: 'that path contains characters that are not allowed' };
    }

    const root = path.parse(current).root;
    const rest = current.slice(root.length);
    const segments = rest.length > 0 ? rest.split(path.sep).filter((s) => s.length > 0) : [];
    let accum = root;
    let substituted = false;

    for (let i = 0; i < segments.length; i += 1) {
      accum = path.join(accum, segments[i]);
      let lst;
      try {
        lst = fs.lstatSync(accum);
      } catch (err) {
        return { ok: false, code: (err && err.code) || 'ENOENT', error: err && err.message ? err.message : String(err) };
      }
      if (!lst.isSymbolicLink()) continue;

      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        return { ok: false, code: 'ELOOP', error: 'too many levels of symbolic links' };
      }
      let target;
      try {
        target = fs.readlinkSync(accum);
      } catch (err) {
        return { ok: false, code: (err && err.code) || 'EIO', error: err && err.message ? err.message : String(err) };
      }
      if (isNetworkOrDevicePath(target)) {
        return { ok: false, code: 'EUNSAFE_LINK', error: `"${accum}" links to a network or device location, which is not allowed` };
      }
      if (hasControlChars(target)) {
        return { ok: false, code: 'EUNSAFE_CHARS', error: `"${accum}" links to a path with characters that are not allowed` };
      }
      const targetAbs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(accum), target);
      const remaining = segments.slice(i + 1);
      current = remaining.length > 0 ? path.join(targetAbs, ...remaining) : targetAbs;
      substituted = true;
      break;
    }

    if (!substituted) {
      try {
        return { ok: true, real: fs.realpathSync.native(accum) };
      } catch {
        // Every component above was already proven to exist and be link-free -- this can only
        // fail for a genuinely transient reason (e.g. removed between the loop and here). Fall
        // back to the already-verified `accum` rather than reporting a confusing error for a path
        // this function itself just finished confirming is real.
        return { ok: true, real: accum };
      }
    }
    // else: loop again from the top with the substituted `current` -- re-checks it (and every one
    // of ITS OWN ancestors) from scratch, so a target that is itself another unsafe link is caught
    // exactly the same way, however many hops deep.
  }
}

function isDriveRoot(p) {
  return path.parse(p).root === p;
}

// ancestry test via path.relative() instead of a raw `startsWith(sep)` string check. The
// old check compared `normHome.startsWith(normReal + path.sep)`, which silently NEVER matched when
// normReal was itself a drive root — `c:\\` plus an extra separator doubles up to `c:\\\\`, which
// normHome (a normal, single-separator path) can never start with, so a link resolving straight to
// a drive root slipped through this check even though the drive root trivially contains home.
// path.relative(container, target) already normalizes trailing separators on both sides: target is
// inside (or equal to) container exactly when the relative path is '' (equal) or does not start
// with '..' and is not itself absolute (relative() falls back to returning `target` unchanged —
// which is absolute — when the two paths share no common root at all, e.g. different drive letters
// on win32). Comparison is case-insensitive on win32 via normalizeForCompare, same as before.
function realAncestryRelation(containerReal, targetReal) {
  const rel = path.relative(normalizeForCompare(containerReal), normalizeForCompare(targetReal));
  if (rel === '') return 'equal';
  // '..' alone or '..' + separator means outside; a child folder merely NAMED '..x' is still inside
  if (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) return 'contains';
  return 'none';
}

// checkScanRoot: `{ root }` (the validated, resolved real path), `{ reason }` (why it was refused),
// or null for an empty value. Never logs and never throws; the callers below decide what a refusal
// means (CC_PROJECTS_EXTRA_ROOT: one log line and ignored; FORGE_PROJECT_ROOTS: see further down).
function checkScanRoot(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  // A UNC/network path (`\\host\share\...` or `//host/share/...`) is a fundamentally different
  // trust boundary than "another local folder on this machine" — rejected before path.resolve()
  // even normalizes it, so it can never sneak through as if it were a plain absolute path.
  if (UNC_RE.test(trimmed)) {
    return { reason: '"' + trimmed + '" looks like a network/UNC path, not a local directory.' };
  }
  if (!path.isAbsolute(trimmed)) {
    return { reason: '"' + trimmed + '" is not an absolute path.' };
  }
  const resolved = path.resolve(trimmed);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { reason: '"' + resolved + '" does not exist.' };
  }
  if (!stat.isDirectory()) {
    return { reason: '"' + resolved + '" is not a directory.' };
  }
  if (isDriveRoot(resolved)) {
    return { reason: '"' + resolved + '" is a drive root — too wide to scan.' };
  }
  // Follow symlinks/junctions to the REAL target before the home check — a link whose literal path
  // reads like an ordinary folder but actually points at (or above) home must be caught here, not
  // let through because the un-resolved path looked fine.
  const real = realpathOrNull(resolved);
  if (real === null) {
    return { reason: '"' + resolved + '" could not be resolved to its real, on-disk location.' };
  }
  // Q2 fix: the TYPED-text UNC check above only ever sees what the operator wrote — a local-
  // looking folder path that is actually a symlink/junction pointing at a network share resolves,
  // via realpathSync.native, to a `\\host\share\...` target that never went through that check at
  // all. Reject the RESOLVED target too.
  if (UNC_RE.test(real)) {
    return { reason: '"' + resolved + '" resolves to a network/UNC path ("' + real + '") — too wide a trust boundary.' };
  }
  // same reasoning as the typed-path drive-root check above, but for the REAL target — a
  // junction/symlink whose typed path looks like an ordinary folder can still resolve to a drive
  // root ("C:\\"), which is exactly as wide as typing the drive root directly.
  if (isDriveRoot(real)) {
    return { reason: '"' + resolved + '" resolves to a drive root ("' + real + '") — too wide to scan.' };
  }
  const realHome = realpathOrNull(path.resolve(os.homedir())) ?? path.resolve(os.homedir());
  const homeRelation = realAncestryRelation(real, realHome);
  if (homeRelation === 'equal') {
    return { reason: '"' + resolved + '" is the home folder itself — too wide to scan.' };
  }
  // `real` being an ANCESTOR of home (e.g. `C:\Users` above `C:\Users\YOU`, or a drive-level
  // folder above that, including a drive root that slipped past the check above for some other
  // reason) means home is CONTAINED IN the candidate, so scanning the candidate scans home too.
  // Rejected for the same reason as home itself: too wide to scan.
  if (homeRelation === 'contains') {
    return { reason: '"' + resolved + '" contains the home folder — too wide to scan.' };
  }
  // return the RESOLVED real target, not the typed/link path — a link re-pointed after
  // this validation ran must have no effect on what SYNC_SCAN_ROOTS actually scans.
  return { root: real };
}

// Returns a validated, resolved absolute path, or null (logging exactly why) when the raw env
// value fails any check. Never throws — an operator's typo in an env var must never crash the
// gateway at import time.
export function validateExtraScanRoot(raw) {
  const r = checkScanRoot(raw);
  if (r === null) return null;
  if (r.reason) { logRejectedExtraRoot(r.reason); return null; }
  return r.root;
}

// WP B1a: FORGE_PROJECT_ROOTS (a path.delimiter-separated list: ';' on Windows, ':'
// elsewhere) REPLACES the built-in roots (repo parent, ~/Documents, ~/Desktop), so the Electron app
// passes the user's own chosen folders and no user folder is hardcoded. Every entry goes through
// the same checkScanRoot() rules as CC_PROJECTS_EXTRA_ROOT (local, existing, not a drive root, not
// home or above home). A rejected entry is logged and skipped. B1a rework: when the variable is set
// but NO entry is accepted (folder renamed, OneDrive not mounted yet, USB drive unplugged) the import
// FAILS naming every rejected entry, like FORGE_DATA_DIR: silently falling back would scan, and
// create ForgeProjects/ in, a folder the user never chose.
export function parseProjectRootsEnv(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const roots = [];
  const rejected = [];
  for (const entry of raw.split(path.delimiter).map((p) => p.trim()).filter((p) => p.length > 0)) {
    const r = checkScanRoot(entry);
    if (r && r.root) roots.push(r.root); else if (r) rejected.push({ entry, reason: r.reason });
  }
  return { roots, rejected };
}
const PROJECT_ROOTS_ENV = parseProjectRootsEnv(process.env.FORGE_PROJECT_ROOTS);
if (PROJECT_ROOTS_ENV && PROJECT_ROOTS_ENV.roots.length === 0) {
  throw new Error('[paths] FORGE_PROJECT_ROOTS is invalid: no entry was accepted ('
    + (PROJECT_ROOTS_ENV.rejected.map((x) => x.reason).join(' ') || 'the list is empty') + ')');
}
for (const x of (PROJECT_ROOTS_ENV ? PROJECT_ROOTS_ENV.rejected : [])) {
  console.error('[paths] FORGE_PROJECT_ROOTS entry ignored: ' + x.reason);
}
const HAS_PROJECT_ROOTS_OVERRIDE = PROJECT_ROOTS_ENV !== null;
// Installed mode (FORGE_CORE_DIR set): dirname(PROJECT_ROOT) is the install folder's parent, never a
// user folder, so it is neither scanned nor used as the ForgeProjects host. Dev mode keeps it first.
export const IS_INSTALLED_MODE = CORE_DIR_FROM_ENV !== null;
const BUILTIN_SCAN_ROOTS = [
  ...(IS_INSTALLED_MODE ? [] : [DERIVED_SYNC_SCAN_ROOT]),
  path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Desktop'),
];
const BASE_SCAN_ROOTS = HAS_PROJECT_ROOTS_OVERRIDE ? PROJECT_ROOTS_ENV.roots : BUILTIN_SCAN_ROOTS;
export const SYNC_SCAN_ROOT = BASE_SCAN_ROOTS[0];

const EXTRA_SCAN_ROOT = validateExtraScanRoot(process.env[EXTRA_SCAN_ROOT_ENV_NAME]);
export const SYNC_SCAN_ROOTS = Array.from(new Set(
  [...BASE_SCAN_ROOTS, EXTRA_SCAN_ROOT]
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => path.resolve(p)),
));

// Codex run B F-12: a discovered/registered project's own REAL path must be checked
// for containment against the REAL (symlink/junction-resolved) form of every scan root, so a scan
// root that is itself a link, or a candidate project path resolving somewhere other than where it
// lexically appears to be, is judged against where things REALLY are on disk, never against
// typed/linked text alone (the lexical-only gap Codex's F-12 finding names). Deliberately NOT a
// precomputed constant here: SYNC_SCAN_ROOTS above is a real, mutable exported Array, and at least
// one existing test (config.test.mjs's pushScanRoot()/popScanRoot()) deliberately mutates it live to
// widen containment for one test — a snapshot taken once at import time would stop seeing that
// mutation. projects.mjs's own activeScanRootsReal() and admitted-roots.mjs's getContainmentRoots()
// each recompute the real form of the (possibly test-overridden, possibly live-mutated) scan roots
// fresh on every call instead — see either one's own header for the full reasoning.

// WP3 additions. These three are genuinely GLOBAL to *this gateway's own* install (not scoped by
// a `?project=` query) — matching the literal T3.6/T3.9 endpoint shapes, which carry no project
// param: the model-capability matrix + NVIDIA provider CLI live under THIS project's own
// .claude/, and the usage-pressure file is account-wide under the OS home dir, never per-project.
// Endpoints that DO take `?project=` (missions/agents/skills/proof) instead compute their own
// per-project `.claude/...` paths from the resolved registry entry's path at call time — see
// agents.mjs/skills.mjs/proof.mjs/missions.mjs — so they reflect the SELECTED fleet project, not
// always this one.
export const MODEL_CAPABILITY_MATRIX_FILE = path.join(CLAUDE_DIR, 'config', 'models', 'model-capability-matrix.json');
export const NVIDIA_PROVIDER_CJS = path.join(CLAUDE_DIR, 'forge-bin', 'nvidia-provider.cjs');
export const FORGE_USAGE_PRESSURE_FILE = path.join(os.homedir(), '.claude', 'FORGE_USAGE_PRESSURE.json');
// WP7c addition: the usage-guard's OWN pause/resume state — a different file than the pressure
// file above (owner's `forge-bin/usage-guard.cjs` writes both; this one carries whether agents
// are actually PAUSED right now, which the pressure file does not). Same account-wide, no
// `?project=` shape.
export const FORGE_USAGE_GUARD_STATE_FILE = path.join(os.homedir(), '.claude', 'FORGE_USAGE_GUARD_STATE.json');
// The guard's watcher writes its pid here (usage-guard.cjs PID_FILE: {pid, startedAt, script}, or a bare
// number from older builds). Read only, to tell a running watcher from a guard whose state merely says "ok".
export const FORGE_USAGE_GUARD_PID_FILE = path.join(os.homedir(), '.claude', 'forge-usage-guard.pid');

// WP4 addition: the conversation store lives ONLY under command-center/.data/ (D2 "write boundary"
// hard rule — the gateway never writes into .claude/). `.data/` is already `.gitignore`d.
// WP B1a: FORGE_DATA_DIR relocates it (the app passes %APPDATA%/Forge Systeem); every gateway
// writer derives its path from COMMAND_CENTER_DATA_DIR, so they all follow.
export const DEFAULT_COMMAND_CENTER_DATA_DIR = path.join(COMMAND_CENTER_DIR, '.data');
export const COMMAND_CENTER_DATA_DIR = envDirOrNull('FORGE_DATA_DIR', { mustExist: false }) || DEFAULT_COMMAND_CENTER_DATA_DIR;
export const CONVERSATIONS_DIR = path.join(COMMAND_CENTER_DATA_DIR, 'conversations');

// build-lastdemos addition: one directory per conversation, holding every file the composer's
// real "Attach" control has uploaded for it (attachments.mjs is the sole writer). Same write
// boundary as CONVERSATIONS_DIR above — under command-center/.data/, never under .claude/.
export const ATTACHMENTS_DIR = path.join(COMMAND_CENTER_DATA_DIR, 'attachments');

// build-newproject: root for projects created via POST /api/projects (the dashboard's real "New
// project" button). A sibling of every other Forge project directly under SYNC_SCAN_ROOT (this
// machine's Documents folder), so forge-sync.cjs's own bounded-depth scan (default maxDepth 3,
// see findForgeProjects() in forge-bin/forge-sync.cjs) discovers a freshly created project on its
// own next cache-refresh — no separate registration step is needed.
export const FORGE_PROJECTS_ROOT = path.join(SYNC_SCAN_ROOT, 'ForgeProjects');

// (feat-discord-gateway): the imported Discord<->Forge remote-control bot (source-only —
// see command-center/discord/README.md for its own history) — supervised by THIS gateway as its
// single spawn-root (discord-service.mjs), never via its own now-redundant src/bot-manager.js.
export const DISCORD_DIR = path.join(COMMAND_CENTER_DIR, 'discord');
export const DISCORD_MAIN_JS = path.join(DISCORD_DIR, 'src', 'main.js');
export const DISCORD_ENV_FILE = path.join(DISCORD_DIR, '.env');
export const DISCORD_ENV_EXAMPLE_FILE = path.join(DISCORD_DIR, '.env.example');
// Fresh, gateway-owned runtime state — deliberately NOT the imported folder's own `./state`
// (D2/write-boundary precedent: real writes stay under command-center/.data/, never inside a
// sibling project's own directory tree).
export const DISCORD_DATA_DIR = path.join(COMMAND_CENTER_DATA_DIR, 'discord');
export const DISCORD_STATE_DIR = path.join(DISCORD_DATA_DIR, 'state');
export const DISCORD_LOG_FILE = path.join(DISCORD_DATA_DIR, 'discord-bot.log');

// ("the Command Center works after a fresh install"): the installer copies
// this whole command-center/ next to a fresh ~/.claude/forge/template/.claude/ — i.e. on a
// centrally-installed machine THIS gateway's own COMMAND_CENTER_DIR/PROJECT_ROOT (computed above,
// purely from this file's own on-disk location — never from request input) IS
// FORGE_TEMPLATE_DIR. That template host is a Forge install artifact, never a real project: see
// projects.mjs's computeProjectsAsync() for where every discovery source (scan roots AND the
// installer's own recorded list below) is filtered against this exact path before a project list
// is ever built, so it can never appear in `GET /api/projects` and therefore never be chosen as a
// default project either. On a normal source/dev checkout (this repo) PROJECT_ROOT is never this
// path, so the filter is a guaranteed no-op there — existing behaviour is unchanged.
export const FORGE_HOME_DIR = path.join(os.homedir(), '.claude', 'forge');
export const FORGE_TEMPLATE_DIR = path.join(FORGE_HOME_DIR, 'template');

// the installer's own append-only record of every real project it has set up on this
// machine — `{ "schema": 1, "projects": ["<absolute path>", ...] }`. Read defensively by
// installed-projects.mjs (this constant only names WHERE; that module owns the actual read/parse/
// validate). A missing file (every dev/source checkout, and any machine whose installer predates
// this WP or has simply never recorded a project yet) is the ordinary case, not an error.
export const FORGE_INSTALLED_PROJECTS_FILE = path.join(FORGE_HOME_DIR, 'projects.json');
