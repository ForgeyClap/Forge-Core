// App router — extra Claude accounts as official Claude Code profile folders (design 3.1-3.3, D1).
//
// One folder per extra account under <home>/.forge-router/profiles (or FORGE_ROUTER_PROFILES_DIR,
// an absolute path, for tests): outside every git working tree and outside the app data folder. The
// user signs in inside the unmodified `claude` program started with CLAUDE_CONFIG_DIR=<folder>;
// Forge only creates the EMPTY folder and later starts the CLI with that variable. This module never
// reads, lists or writes anything inside a profile folder, and never touches any login file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileSlugValid } from './chain-schema.mjs';
import { LIMITS, MAIN_ID, WINDOWS_DEVICE_NAMES } from './contract.mjs';

const ENV_ROOT = 'FORGE_ROUTER_PROFILES_DIR';
const RESERVED = new Set([MAIN_ID, ...WINDOWS_DEVICE_NAMES]);

/** The profiles root. A non-absolute seam value is ignored (a relative path could land in a repo). */
export function profilesRoot() {
  const env = process.env[ENV_ROOT];
  if (typeof env === 'string' && env.length > 0 && path.isAbsolute(env)) return path.resolve(env);
  return path.join(os.homedir(), '.forge-router', 'profiles');
}

/** True for a usable profile slug: ^[a-z0-9][a-z0-9-]{0,31}$, not `main`, not a Windows device name. */
export function profileSlugOk(slug) {
  return profileSlugValid(slug);
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when the real folder is exactly <real root>/<slug>. Windows folder names ignore letter case, so
 * a folder WERK on disk is the profile werk there (path.relative already compares the root that way).
 */
function isProfileFolder(realRoot, realDir, slug) {
  const rel = path.relative(realRoot, realDir);
  return process.platform === 'win32' ? rel.toLowerCase() === slug : rel === slug;
}

/**
 * The folder for a slug, checked. With mustExist the folder must exist as a real directory (not a
 * symlink or junction) whose real path stays inside the real root.
 * @returns {{ok: true, dir: string} | {ok: false, code: 'bad_profile'|'missing'|'symlink'|'not_dir'|'outside_root'}}
 */
export function profileDir(slug, { mustExist = false } = {}) {
  if (!profileSlugOk(slug)) return { ok: false, code: 'bad_profile' };
  const root = profilesRoot();
  const dir = path.join(root, slug);
  if (!isInside(root, dir)) return { ok: false, code: 'bad_profile' };
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return mustExist ? { ok: false, code: 'missing' } : { ok: true, dir };
  }
  if (st.isSymbolicLink()) return { ok: false, code: 'symlink' };
  if (!st.isDirectory()) return { ok: false, code: 'not_dir' };
  try {
    const realRoot = fs.realpathSync.native(root);
    const realDir = fs.realpathSync.native(dir);
    if (!isProfileFolder(realRoot, realDir, slug)) return { ok: false, code: 'outside_root' };
  } catch {
    return { ok: false, code: 'outside_root' };
  }
  return { ok: true, dir };
}

/**
 * Creates the empty profile folder (and the root) when missing. Directory only, never file content.
 * @returns {{ok: true, dir: string, created: boolean} | {ok: false, code: string}}
 */
export function ensureProfileDir(slug) {
  const before = profileDir(slug);
  if (!before.ok) return before;
  let created = false;
  if (!fs.existsSync(before.dir)) {
    try {
      fs.mkdirSync(before.dir, { recursive: true });
      created = true;
    } catch {
      return { ok: false, code: 'mkdir_failed' };
    }
  }
  const after = profileDir(slug, { mustExist: true });
  return after.ok ? { ok: true, dir: after.dir, created } : after;
}

// Characters cmd.exe expands or ends a quoted value on even inside "...": refuse rather than guess.
const CMD_UNSAFE_RE = /["%!^\r\n]/;
// PowerShell treats the curly single quotes U+2018-U+201B like ' inside a '...' string: every one of
// them is doubled, or a folder name could end the string and run the rest as a command.
const PS_QUOTE_RE = /['\u2018-\u201B]/g;
// Written as escapes so this file stays plain text.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * The commands that start the official CLI with this profile folder, for the user to paste (design 3.3).
 * @returns {null | {powershell: string, cmd: string|null, posix: string}}
 *   null for a bad slug or an unusable path; cmd null when cmd.exe cannot quote the path safely.
 */
export function loginCommands(slug) {
  const r = profileDir(slug);
  if (!r.ok || CONTROL_RE.test(r.dir)) return null;
  const ps = "'" + r.dir.replace(PS_QUOTE_RE, (q) => q + q) + "'";
  const sh = "'" + r.dir.replace(/'/g, "'\\''") + "'";
  return {
    // try/finally: the variable is removed even when claude stops with an error or Ctrl+C.
    powershell: '& { $env:CLAUDE_CONFIG_DIR = ' + ps + '; try { claude } finally { Remove-Item Env:CLAUDE_CONFIG_DIR } }',
    cmd: CMD_UNSAFE_RE.test(r.dir) ? null : 'set "CLAUDE_CONFIG_DIR=' + r.dir + '" && claude',
    posix: 'CLAUDE_CONFIG_DIR=' + sh + ' claude',
  };
}

/**
 * A deterministic slug from a display name: lower case, accents dropped, other characters to "-",
 * at most 32. Reserved results get "-account". Returns null when the label is not a usable name.
 * Uniqueness is the caller's check (an existing slug reuses that account's folder, which is the point
 * of keeping folders when an entry is removed).
 */
export function slugFromLabel(label) {
  if (typeof label !== 'string' || label.trim().length === 0) return null;
  let s = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) s = 'account';
  s = s.slice(0, LIMITS.ID_MAX).replace(/-+$/, '');
  if (RESERVED.has(s)) s = s + '-account';
  return profileSlugOk(s) ? s : null;
}

/** Shows a path with the home folder as "~" (no full user path in the UI by default). */
export function displayPath(p) {
  if (typeof p !== 'string') return '';
  const home = os.homedir();
  const rel = path.relative(home, p);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return path.join('~', rel);
  return p;
}
