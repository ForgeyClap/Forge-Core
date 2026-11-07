// Locating and running a CLI (claude, codex, gemini, grok) safely.
//
//   - Lookup: an absolute override path (env FORGE_<NAME>_CLI_PATH, or CC_CLAUDE_CLI_PATH for claude,
//     matching exec-cli.mjs), else `where` (Windows) / `which`. Same hardening as exec-cli.mjs: the
//     candidate must be absolute, must survive realpath, and must not live under the current working
//     directory (PATH-shadowing guard).
//   - Windows: only .exe, .cmd and .bat are spawnable. Node refuses to spawn .cmd/.bat without a shell
//     (CVE-2024-27980 hardening), so an npm shim (codex.cmd) is resolved to the JavaScript entry it
//     launches and run as `node <entry.js>`: the same unmodified program the shim would start, without
//     a shell. A shim that cannot be resolved is reported as not runnable rather than run through cmd.
//   - Running: execFile, never a shell, explicit timeout, capped output, a minimal environment WITHOUT
//     API keys or auth tokens (so a probe reports the user's own CLI sign-in, and no key reaches a
//     child that does not need it). Never throws.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LOOKUP_TIMEOUT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROBE_ENV_EXACT = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata',
  'home', 'homedrive', 'homepath', 'lang', 'lc_all', 'os', 'number_of_processors', 'codex_home', 'claude_config_dir',
]);
const PROBE_ENV_PREFIXES = ['programfiles', 'programw6432'];

export function probeEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const lower = k.toLowerCase();
    if (PROBE_ENV_EXACT.has(lower) || PROBE_ENV_PREFIXES.some((p) => lower.startsWith(p))) out[k] = v;
  }
  out.NO_COLOR = '1';
  return out;
}

function validateCandidate(candidate, cwd) {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  let real;
  try { real = fs.realpathSync(candidate); } catch { return null; }
  let cwdReal;
  try { cwdReal = fs.realpathSync(cwd); } catch { cwdReal = cwd; }
  if (real === cwdReal || real.startsWith(cwdReal + path.sep)) return null;
  return real;
}

// Reads an npm cmd-shim and returns the absolute .js entry it launches, or null.
export function resolveNpmShim(shimPath) {
  let text;
  try {
    const stat = fs.statSync(shimPath);
    if (stat.size > 16 * 1024) return null; // a shim is tiny; anything else is not one
    text = fs.readFileSync(shimPath, 'utf8');
  } catch { return null; }
  const m = /"%(?:~)?dp0%?\\?([^"%]+?\.(?:c|m)?js)"/i.exec(text);
  if (!m) return null;
  const entry = path.resolve(path.dirname(shimPath), m[1].replace(/^\\+/, ''));
  return fs.existsSync(entry) ? entry : null;
}

function whereLookup(name, platform) {
  return new Promise((resolve) => {
    const cmd = platform === 'win32' ? 'where' : 'which';
    execFile(cmd, [name], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err && !stdout) { resolve([]); return; }
      resolve(String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

function overrideEnvName(name) {
  return name === 'claude' ? 'CC_CLAUDE_CLI_PATH' : 'FORGE_' + name.toUpperCase() + '_CLI_PATH';
}

// Returns { path, command, prefixArgs, via } or null when not installed / not runnable.
export async function resolveCli(name, { env = process.env, platform = process.platform, cwd = process.cwd(), lookup = whereLookup } = {}) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return null;
  const override = env[overrideEnvName(name)];
  const candidates = override && override.trim() ? [override.trim()] : await lookup(name, platform);
  for (const c of candidates) {
    const real = validateCandidate(c, cwd);
    if (!real) continue;
    const ext = path.extname(real).toLowerCase();
    if (platform === 'win32') {
      if (ext === '.exe') return { path: real, command: real, prefixArgs: [], via: 'exe' };
      if (ext === '.cmd' || ext === '.bat') {
        const entry = resolveNpmShim(real);
        if (!entry) continue;
        const localNode = path.join(path.dirname(real), 'node.exe');
        return { path: real, command: fs.existsSync(localNode) ? localNode : process.execPath, prefixArgs: [entry], via: 'npm-shim' };
      }
      continue; // extensionless sh scripts and .ps1 are not spawnable without a shell
    }
    return { path: real, command: real, prefixArgs: [], via: 'binary' };
  }
  return null;
}

// Runs the resolved CLI. Resolves { code, stdout, stderr, timedOut, error } and never rejects.
export function runCli(resolved, args, { timeoutMs = DEFAULT_RUN_TIMEOUT_MS, env, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(resolved.command, [...resolved.prefixArgs, ...args], {
      timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, env: env || probeEnv(), cwd,
    }, (err, stdout, stderr) => {
      const timedOut = !!(err && err.killed && err.signal);
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : null;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut, error: err && typeof err.code === 'string' ? err.code : null });
    });
  });
}

export function firstLine(text, max = 200) {
  const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  return line.length > max ? line.slice(0, max) : line;
}
