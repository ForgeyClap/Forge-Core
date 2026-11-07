// Forge Command Center gateway — exec-bridge CLI resolution + env allowlist
// (refactor-gateway-split). Split out of the single exec-bridge.mjs (had
// grown to ~754 lines, over this project's own 500-line-per-file guidance) into its own real seam:
// resolving/validating the real `claude` CLI path and the allowlisted env a spawned child actually
// receives. Every name below is re-exported from exec-bridge.mjs under its EXACT original name — see
// that file's own header for the full architecture/history/honesty rules this slice still follows;
// no other file in the codebase needed to change a single import.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { issueAgentToken, scrubGatewayTokens } from './security.mjs';

let claudePathResolved = false;
let claudePathCache = null;

// Codex F2 hardening: a resolved `claude` candidate must be an ABSOLUTE path, must survive
// `fs.realpathSync` (resolving symlinks — a symlink pointing back into cwd is caught too), and must
// NOT live under this process's own current working directory. A `where`/`which` lookup can be
// fooled by a same-named file sitting in cwd on some PATH configurations (cwd-relative or
// cwd-adjacent entries are a classic PATH-shadowing trick); such a candidate is never trusted, even
// if it is the only one found. Returns the resolved real path, or null if the candidate fails any of
// these checks (never throws).
function resolveAndValidate(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return null; // a bare relative path is never trusted
  let real;
  try { real = fs.realpathSync(candidate); }
  catch { return null; } // unreadable/nonexistent — an absent CLI stays a truthful null, never thrown
  let cwdReal;
  try { cwdReal = fs.realpathSync(process.cwd()); }
  catch { cwdReal = process.cwd(); }
  if (real === cwdReal || real.startsWith(cwdReal + path.sep)) return null; // reject anything under cwd
  return real;
}

// Resolves the real `claude` CLI path once (via `where`/`which`, per the work package), caching it
// for the process lifetime. In mock mode (CC_EXEC_MOCK=1, used by every automated test) this
// resolves to the current Node binary instead — no real `claude` invocation ever happens in a
// test run. An explicit, absolute CC_CLAUDE_CLI_PATH override always wins over PATH-based discovery
// useful when a sandboxed/CI environment's PATH cannot be trusted, or to pin one
// specific installed CLI. Every discovered/overridden candidate is passed through
// resolveAndValidate() before being trusted.
export function resolveClaudeCliPath() {
  if (claudePathResolved) return claudePathCache;
  claudePathResolved = true;
  if (process.env.CC_EXEC_MOCK === '1') {
    claudePathCache = process.execPath;
    return claudePathCache;
  }
  const override = process.env.CC_CLAUDE_CLI_PATH;
  if (override && override.trim()) {
    claudePathCache = resolveAndValidate(override.trim());
    return claudePathCache;
  }
  try {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(lookupCmd, ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    claudePathCache = candidates.map(resolveAndValidate).find((p) => p !== null) ?? null;
  } catch {
    claudePathCache = null; // absent CLI is a truthful, expected outcome — never thrown
  }
  return claudePathCache;
}

// feat-subagent-visibility: the resolved CLI's OWN `--help` text, read at most once per gateway
// process and cached for its lifetime. This is the ONLY honest way to know whether an optional
// stream flag (e.g. `--forward-subagent-text`, `--include-hook-events`) exists on the `claude`
// binary this machine actually has — an older CLI handed an unknown flag exits with a usage error
// instead of running the turn, so the gateway must never assume support it has not verified.
//
// Never throws and never blocks a real turn on a broken lookup: an unresolvable CLI, a spawn
// failure, or a timeout all degrade to `null` ("help unknown"), which every caller must read as
// "do not add the optional flag". Mock mode short-circuits entirely — the mock child is a node
// script, not the CLI, so running `node --help` would be a meaningless (and slow) subprocess in
// every test run.
const HELP_TIMEOUT_MS = 10000;
const HELP_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
let cliHelpResolved = false;
let cliHelpCache = null;
let cliHelpOverrideActive = false;
let cliHelpOverride = null;

export function claudeCliHelpText() {
  if (cliHelpOverrideActive) return cliHelpOverride;
  if (cliHelpResolved) return cliHelpCache;
  cliHelpResolved = true;
  if (process.env.CC_EXEC_MOCK === '1') {
    cliHelpCache = null;
    return cliHelpCache;
  }
  const cli = resolveClaudeCliPath();
  if (!cli) {
    cliHelpCache = null;
    return cliHelpCache;
  }
  try {
    cliHelpCache = execFileSync(cli, ['--help'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: HELP_TIMEOUT_MS,
      maxBuffer: HELP_MAX_BUFFER_BYTES,
    });
  } catch (err) {
    // A CLI that prints its help to stderr and/or exits non-zero still produced REAL help text —
    // use whatever genuinely came back rather than throwing away a usable answer.
    const captured = err && (typeof err.stdout === 'string' ? err.stdout : null);
    const capturedErr = err && (typeof err.stderr === 'string' ? err.stderr : null);
    const text = (captured && captured.length > 0 ? captured : null) || (capturedErr && capturedErr.length > 0 ? capturedErr : null);
    cliHelpCache = text;
  }
  return cliHelpCache;
}

/** True only when the resolved CLI's own `--help` genuinely documents `flag`. Unknown help text
 *  (unresolvable CLI, failed lookup, mock mode) is a truthful `false`, never an optimistic guess. */
export function claudeCliSupportsFlag(flag) {
  const help = claudeCliHelpText();
  if (typeof help !== 'string' || help.length === 0) return false;
  return help.includes(flag);
}

/** Test-only seam (mirrors `_setAskMcpConfigDirForTests`'s own convention in exec-argv.mjs): inject
 *  the exact help text a hypothetical CLI would print — including `null` for "help unreadable" —
 *  so flag detection can be proven for BOTH a supporting and an older CLI without ever invoking a
 *  real `claude` binary in a test run. */
export function _setClaudeCliHelpTextForTests(text) {
  cliHelpOverrideActive = true;
  cliHelpOverride = typeof text === 'string' ? text : null;
}

export function _resetClaudeCliHelpForTests() {
  cliHelpOverrideActive = false;
  cliHelpOverride = null;
  cliHelpResolved = false;
  cliHelpCache = null;
}

// The composer's honest capability state (D2 amendment 3 fallback path): AVAILABLE when a real
// `claude` binary was resolved (or mock mode is on), else the composer ships in observer mode.
export function executionAvailability() {
  if (process.env.CC_EXEC_MOCK === '1') {
    return { available: true, note: 'mock execution mode (CC_EXEC_MOCK=1) — no real claude CLI is invoked' };
  }
  const p = resolveClaudeCliPath();
  if (p) return { available: true, note: 'resolved claude CLI at ' + p };
  return { available: false, note: 'claude CLI not found on PATH — composer ships in observer mode (message stored, not executed)' };
}

// Codex F1 hardening: an ALLOWLIST of the env var NAMES the spawned `claude` child actually needs to
// run correctly, replacing the old `/key|token/i` denylist (a denylist can only ever block names the
// author thought of — e.g. it never covered PASSWORD/DB_URL/*_SECRET/*_DSN/cloud-credential vars,
// every one of which would previously have been forwarded verbatim to the child). Verified against
// this file's own mock-mode E2E test (a real spawned child, real stdout round-trip) — the mock spawn
// still starts and completes correctly with ONLY this allowlisted env, so the stronger allowlist is
// used instead of a merely-widened denylist.
const ALLOWED_ENV_EXACT = new Set([
  'path', 'systemroot', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata',
  'home', 'comspec', 'pathext', 'number_of_processors', 'os', 'windir',
  'homedrive', 'homepath', 'lang', 'lc_all', 'shell', 'term',
  // Dev layout (desktop/gateway-launcher.mjs runAsNode): the gateway itself is electron.exe acting as
  // node. Every child started through process.execPath (the forge-ask MCP server, the mock chat
  // child, forge-finalize) needs the same flag or it boots a full Electron window (Test Boss, B8-2,
  // 2026-11-02). A real node gateway never has the variable, so nothing is forwarded there.
  'electron_run_as_node',
]);
// Prefix matches: PROGRAMFILES/PROGRAMFILES(X86)/PROGRAMW6432, every CLAUDE_* var, and every CC_*
// var — this project's OWN configuration surface for the child (e.g. CC_EXEC_MOCK/
// CC_EXEC_MOCK_DELAY_MS, read by the mock child script in `exec-argv.mjs` and required for the
// concurrency/stop-execution tests in `test/exec-bridge.test.mjs` to behave deterministically).
const ALLOWED_ENV_PREFIXES = ['programfiles', 'claude_', 'cc_'];
// wp20 env hygiene: the `claude_` prefix also matches CLAUDE_CODE_OAUTH_TOKEN. The real
// `claude` child (exec-lifecycle.mjs) may genuinely authenticate with it, so the DEFAULT stays unchanged;
// a child that needs no credential (config.mjs's forge-config.cjs) asks for { credentialFree: true },
// which additionally drops every credential-shaped name (*_TOKEN / *_SECRET / *_KEY, any case).
const CREDENTIAL_SHAPED_NAME = /_(token|secret|key)$/i;
// Exported so a direct unit test can assert exactly which names pass through, without needing to
// spawn a real child and inspect its environment indirectly.
export function filteredEnv(opts) {
  const credentialFree = !!(opts && opts.credentialFree);
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    const lower = k.toLowerCase();
    const allowed = ALLOWED_ENV_EXACT.has(lower) || ALLOWED_ENV_PREFIXES.some((p) => lower.startsWith(p));
    if (!allowed) continue;
    if (credentialFree && CREDENTIAL_SHAPED_NAME.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// WP A8 item 3: the per-turn ask-mcp config file used to carry this boot's exec token
// in plaintext for the whole turn. Since then no token is written there: exec-argv.mjs's builder
// leaves it out, and stripExecTokenFromAskMcpConfig() below removes any token variable again
// BEFORE the child is spawned and proves the bytes are clean. The token travels in the spawned
// `claude` child's environment instead. Read from the installed claude 2.1.316 binary (not a live
// run): a stdio MCP server is started with
// `{...<inherited process env>, CLAUDE_PROJECT_DIR, CLAUDE_CODE_SESSION_ID, CLAUDECODE, ...config.env}`,
// so ask-mcp.mjs reads it from its own process.env. The one known exception:
// CLAUDE_CODE_DONT_INHERIT_ENV in the gateway's own env (forwarded by the `claude_` prefix) makes
// the CLI stop inheriting, and asks would then be refused with 403.
//
// WP B3-sec-impl (Security Boss Step 1a): the child no longer receives the DASHBOARD's
// exec token at all. Every subprocess the agent starts (Bash, hooks) can read the child's
// environment, and with the exec token it could answer its own permission cards, mark its project
// trusted or start a bypass turn. The child now gets its conversation's AGENT token
// (security.mjs issueAgentToken) in CC_ASK_AGENT_TOKEN. The gateway accepts that token only on
// POST /api/permissions/request, POST /api/permissions/:id/wait and POST /api/ask, and refuses it
// on every other write route (routes/permissions.mjs checkWriteToken). The conversation the token
// is bound to is the CC_ASK_CONV_ID the forge-ask server of this very config will claim.
export const ASK_EXEC_TOKEN_ENV = 'CC_ASK_EXEC_TOKEN';
export const ASK_AGENT_TOKEN_ENV = 'CC_ASK_AGENT_TOKEN';
const ASK_TOKEN_ENV_NAMES = new Set([ASK_EXEC_TOKEN_ENV.toLowerCase(), ASK_AGENT_TOKEN_ENV.toLowerCase()]);

/** The conversation id the forge-ask server of this mcp-config will claim (its CC_ASK_CONV_ID), or
 *  null when the file cannot be read or names none. */
function askConfigConversation(filePath) {
  try {
    const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const server = config && config.mcpServers ? config.mcpServers['forge-ask'] : null;
    const convId = server && server.env ? server.env.CC_ASK_CONV_ID : null;
    return typeof convId === 'string' && convId.length > 0 ? convId : null;
  } catch {
    return null;
  }
}

// App router P2 (design 5.2 rule 1, review finding 17): a turn on an extra Claude account runs with
// CLAUDE_CONFIG_DIR=<that account's profile folder>. An inherited sign-in variable must then never
// override the profile's own login, so every forwarded `claude_` name whose name contains one of
// these words is dropped (a generic rule: no variable name is spelled out here), and every letter-case
// variant of the config-dir name is removed before the new one is set. The words are matched
// anywhere in the name, not only as a suffix. This runs BEFORE the agent token is added, so the
// token (a `cc_` name) is never touched by it.
const PROFILE_CREDENTIAL_WORD_RE = /(token|secret|key|credential|auth)/i;
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Applies the profile folder to an already-filtered env object (mutates and returns it). */
function applyProfileEnv(env, claudeConfigDir) {
  for (const name of Object.keys(env)) {
    const lower = name.toLowerCase();
    if (!lower.startsWith('claude_')) continue;
    if (lower === CONFIG_DIR_ENV.toLowerCase() || PROFILE_CREDENTIAL_WORD_RE.test(name)) delete env[name];
  }
  env[CONFIG_DIR_ENV] = claudeConfigDir;
  return env;
}

/** True for a profile folder value execSpawnEnv accepts: a non-empty absolute path. */
export function isUsableClaudeConfigDir(dir) {
  return typeof dir === 'string' && dir.length > 0 && path.isAbsolute(dir);
}

/** A copy of an already-built child env switched to a Claude Code profile folder (applyProfileEnv).
 *  Only `claude_` names are touched, so a `cc_` agent token already in `env` stays. A dir that is not
 *  usable returns the copy unchanged; callers refuse such a dir before they get here. */
export function withClaudeProfileEnv(env, claudeConfigDir) {
  const copy = { ...env };
  return isUsableClaudeConfigDir(claudeConfigDir) ? applyProfileEnv(copy, claudeConfigDir) : copy;
}

/** The environment one `claude -p` turn is spawned with: the allowlist above, plus the
 *  conversation's agent token ONLY when this turn really carries an ask-mcp config (mock mode and
 *  config-less turns never get it). The dashboard's exec token is never added, and a stale
 *  CC_ASK_EXEC_TOKEN or CC_ASK_AGENT_TOKEN in the gateway's own environment (any letter case) is
 *  never forwarded. A config whose conversation cannot be read gets no token: its ask and
 *  permission calls are then refused (fail closed), never answered with a wider token.
 *  App router: `claudeConfigDir` (an absolute profile folder, optional) switches the child to that
 *  Claude Code profile (applyProfileEnv above). Without it the env is exactly what it was before. */
export function execSpawnEnv(opts) {
  const askMcpConfigPath = opts && opts.askMcpConfigPath;
  const claudeConfigDir = opts && isUsableClaudeConfigDir(opts.claudeConfigDir) ? opts.claudeConfigDir : null;
  const env = filteredEnv();
  for (const name of Object.keys(env)) {
    if (ASK_TOKEN_ENV_NAMES.has(name.toLowerCase())) delete env[name];
  }
  if (claudeConfigDir) applyProfileEnv(env, claudeConfigDir);
  if (askMcpConfigPath) {
    const token = issueAgentToken(askConfigConversation(askMcpConfigPath));
    if (token) env[ASK_AGENT_TOKEN_ENV] = token;
  }
  return env;
}

/** Removes CC_ASK_EXEC_TOKEN and CC_ASK_AGENT_TOKEN from every server's `env` in an already-written
 *  mcp-config file and proves that no gateway token (the exec token or any issued agent token) is
 *  left in the bytes by re-reading them. Returns `{ ok: true, removed }` (removed = the number of
 *  token variables taken out) or `{ ok: false, reason }` — never throws; the caller treats
 *  `ok: false` as "do not spawn". */
export function stripExecTokenFromAskMcpConfig(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return { ok: false, reason: 'no config path' };
  let config;
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'config unreadable: ' + (err && err.message ? err.message : String(err)) };
  }
  const servers = config && typeof config === 'object' && config.mcpServers && typeof config.mcpServers === 'object'
    ? config.mcpServers
    : null;
  if (!servers) return { ok: false, reason: 'config has no mcpServers object' };
  let removed = 0;
  for (const server of Object.values(servers)) {
    if (!server || !server.env || typeof server.env !== 'object') continue;
    for (const name of Object.keys(server.env)) {
      if (ASK_TOKEN_ENV_NAMES.has(name.toLowerCase())) {
        delete server.env[name];
        removed += 1;
      }
    }
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(config), 'utf8');
    const written = fs.readFileSync(filePath, 'utf8');
    if (scrubGatewayTokens(written) !== written) return { ok: false, reason: 'token still present after rewrite' };
  } catch (err) {
    return { ok: false, reason: 'config rewrite failed: ' + (err && err.message ? err.message : String(err)) };
  }
  return { ok: true, removed };
}

// Test-only glue (refactor-gateway-split): lets exec-lifecycle.mjs's own _resetExecBridgeForTests
// reset this module's cached CLI-resolution state across test files, without reaching into this
// module's private `claudePathResolved`/`claudePathCache` variables directly. Not part of the
// original exec-bridge.mjs public export list — a new, purely mechanical seam this split requires,
// with no behavior change of its own.
export function _resetClaudeCliResolutionForTests() {
  claudePathResolved = false;
  claudePathCache = null;
  // The cached `--help` text is derived from whichever CLI path was resolved, so it must be
  // invalidated with it — otherwise a test that swaps the CLI would keep the previous binary's
  // capability answer.
  cliHelpResolved = false;
  cliHelpCache = null;
}
