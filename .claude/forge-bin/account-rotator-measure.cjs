#!/usr/bin/env node
'use strict';
/**
 * account-rotator-measure.cjs — settings resolution and usage measurement for the account rotator
 *. Split out of account-rotator.cjs for size; no other behaviour.
 *
 * SETTINGS: flag > /forge config (account-rotator, account-rotator.threshold, account-rotator.cooldown-min,
 * account-rotator.interval, account-rotator.mode) > default — same resolution and bounds discipline as usage-guard's
 * resolveGuardSettings. An unreadable config is never a silent "on" (start/watch treat it as off). MODE (owner
 * direction 2026-10-09): 'token' (default) — the watcher measures and RECOMMENDS; a new session is started with
 * `launch --auto`; the Claude login files are never written. 'file' (experimental, explicit opt-in) — the watcher swaps
 * the login files of running sessions itself (account-rotator-txn.cjs); a Codex review showed that swap cannot be made
 * race-free against Claude Code's own token refresher, so it is best-effort, detected and repaired.
 * MEASUREMENT: the official endpoint usage-guard uses, then — only after a 401/403/429 there — the official client as a
 * fallback (CLIENT PROBE below); the token stays in memory; a failure is never "fine" and never "full". Inactive accounts
 * are never refreshed — their stored access token is used only while it is still valid.
 * FORGE_ACCOUNT_ROTATOR_DENY_NETWORK=1 is a deny-by-default fetch seam for spawned test processes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./account-rotator-core.cjs');
const vault = require('./account-rotator-vault.cjs');
const guardRedact = require('./usage-guard-redact.cjs');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 30000;
const INACTIVE_REFRESH_MS = 10 * 60 * 1000;
const DEFAULTS = { threshold: 92, 'cooldown-min': 10, interval: 120 };
const BOUNDS_FALLBACK = { threshold: { min: 50, max: 99 }, 'cooldown-min': { min: 1, max: 240 }, interval: { min: 30, max: 900 } };
const ENUMS = { mode: { allowed: ['token', 'file'], default: 'token' } };
const SWITCH_KEY = 'account-rotator';
const SCHEMA_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json');
const SRC = { flag: 'vlag', config: 'instelling', dflt: 'standaard' };
const DISCLOSURE_FALLBACK = {
  nl: 'account-rotator leest je Claude-login-bestanden (~/.claude/.credentials.json en de oauthAccount-sleutel in ~/.claude.json) en schrijft ze ALLEEN in de experimentele bestandsmodus (account-rotator.mode = file; standaard is de token-modus, die alleen meet en aanbeveelt en waarbij je een nieuwe sessie start met `launch --auto`); bewaart een kopie van elke ingeschreven login en eventuele setup-token in ~/.claude/forge-accounts op deze computer; stuurt tokens alleen naar api.anthropic.com om het gebruik te meten; pauzeert en hervat in de bestandsmodus tijdens een wissel je Paperclip-agents en blokkeert dan tool-aanroepen in lopende sessies (hooguit 5 minuten); draait als achtergrondproces op deze computer, ook na het sluiten van de sessie. `env` laadt een setup-token in je hele shell; `launch` geeft het aan de nieuwe sessie en al haar subprocessen.',
  en: 'account-rotator reads your Claude login files (~/.claude/.credentials.json and the oauthAccount key in ~/.claude.json) and writes them ONLY in the experimental file mode (account-rotator.mode = file; the default token mode only measures and recommends, and you start a new session with `launch --auto`); keeps a vault copy of each enrolled login and any setup token under ~/.claude/forge-accounts on this machine; sends tokens only to api.anthropic.com to measure usage; in file mode pauses and resumes your Paperclip agents during a switch and then blocks tool calls in running sessions (at most 5 minutes); runs as a background process on this machine, also after the session closes. `env` loads a setup token into your whole shell; `launch` hands it to the new session and all of its child processes.',
};

function flagValue(list, name) { const i = list.indexOf('--' + name); return i >= 0 && list[i + 1] !== undefined ? list[i + 1] : undefined; }
function bounds(schemaPath) {
  let schema = null;
  try { let raw = fs.readFileSync(schemaPath || SCHEMA_PATH, 'utf8'); if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); schema = JSON.parse(raw); } catch { schema = null; }
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const s = schema && schema.settings && schema.settings[SWITCH_KEY + '.' + k];
    out[k] = s && Number.isFinite(s.min) && Number.isFinite(s.max) ? { min: s.min, max: s.max } : BOUNDS_FALLBACK[k];
  }
  return out;
}
/** resolveSettings(argvList, cfg, opts) -> {threshold, 'cooldown-min', interval, enabled, warnings}. Pure. */
function resolveSettings(argvList, cfg, opts) {
  const list = Array.isArray(argvList) ? argvList : [];
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const b = (opts && opts.bounds) || bounds(opts && opts.schemaPath);
  const out = { warnings: [] };
  for (const k of Object.keys(DEFAULTS)) {
    const ok = (n) => Number.isInteger(n) && n >= b[k].min && n <= b[k].max;
    const range = ' (' + b[k].min + '-' + b[k].max + ')';
    const raw = flagValue(list, k);
    if (raw !== undefined) {
      const n = String(raw).trim() === '' ? NaN : Number(raw);
      if (ok(n)) { out[k] = { value: n, source: SRC.flag }; continue; }
      out.warnings.push('--' + k + ' ' + raw + ' is ongeldig' + range + ' en wordt genegeerd / is invalid' + range + ' and is ignored');
    }
    const e = c[SWITCH_KEY + '.' + k];
    const v = e && typeof e === 'object' ? e.value : e;
    if (typeof v === 'number') {
      if (ok(v)) { out[k] = { value: v, source: e && e.source === 'default' ? SRC.dflt : SRC.config }; continue; }
      out.warnings.push('instelling ' + SWITCH_KEY + '.' + k + '=' + v + ' is ongeldig' + range + ' — standaard gebruikt / setting is invalid — using the default');
    }
    out[k] = { value: DEFAULTS[k], source: SRC.dflt };
  }
  for (const k of Object.keys(ENUMS)) {
    const allowed = ENUMS[k].allowed;
    const raw = flagValue(list, k);
    if (raw !== undefined) {
      const v = String(raw).trim().toLowerCase();
      if (allowed.includes(v)) { out[k] = { value: v, source: SRC.flag }; continue; }
      out.warnings.push('--' + k + ' ' + raw + ' is ongeldig (' + allowed.join('|') + ') en wordt genegeerd / is invalid and is ignored');
    }
    const e = c[SWITCH_KEY + '.' + k];
    const v = e && typeof e === 'object' ? e.value : e;
    if (typeof v === 'string' && allowed.includes(v)) { out[k] = { value: v, source: e && e.source === 'default' ? SRC.dflt : SRC.config }; continue; }
    if (v !== undefined) out.warnings.push('instelling ' + SWITCH_KEY + '.' + k + '=' + v + ' is ongeldig (' + allowed.join('|') + ') — standaard gebruikt / setting is invalid — using the default');
    out[k] = { value: ENUMS[k].default, source: SRC.dflt };
  }
  const sw = c[SWITCH_KEY];
  const swv = sw && typeof sw === 'object' ? sw.value : sw;
  out.enabled = typeof swv === 'boolean' ? { value: swv, source: sw && sw.source === 'default' ? SRC.dflt : SRC.config } : { value: true, source: SRC.dflt };
  return out;
}
/** loadConfig(opts) -> {cfg, disclosure, unreadable, note}. Never throws. */
function loadConfig(opts) {
  const o = opts || {};
  let mod = o.configModule;
  if (mod === undefined) { try { mod = require('./forge-config.cjs'); } catch { mod = null; } }
  const keys = [SWITCH_KEY, ...Object.keys(DEFAULTS).concat(Object.keys(ENUMS)).map((k) => SWITCH_KEY + '.' + k)];
  if (mod) {
    try {
      const r = mod.resolve(o.configOpts || {});
      const cfg = {};
      for (const k of keys) if (r.settings[k]) cfg[k] = { value: r.settings[k].value, source: r.settings[k].source };
      const spec = mod.SCHEMA.settings[SWITCH_KEY];
      return { cfg, disclosure: spec && spec.disclosure ? spec.disclosure : null, unreadable: !r.settings[SWITCH_KEY], note: r.settings[SWITCH_KEY] ? null : 'account-rotator ontbreekt in het instellingenschema / missing from the settings schema' };
    } catch (e) {
      return { cfg: {}, disclosure: null, unreadable: true, note: 'instellingen onleesbaar (' + String((e && e.message) || e).split('\n')[0] + ') — veilige standaard: uit / settings unreadable — safe default: off' };
    }
  }
  return { cfg: {}, disclosure: null, unreadable: true, note: 'forge-config.cjs ontbreekt — veilige standaard: uit / forge-config.cjs is missing — safe default: off' };
}
function settingsLine(S) {
  return 'modus/mode ' + S.mode.value + (S.mode.value === 'file' ? ' (experimenteel/experimental)' : '') + ' (bron: ' + S.mode.source + ') · drempel/threshold ' + S.threshold.value + '% (bron: ' + S.threshold.source
    + ') · cooldown ' + S['cooldown-min'].value + ' min (bron: ' + S['cooldown-min'].source + ') · interval ' + S.interval.value + 's (bron: ' + S.interval.source
    + ') · account-rotator ' + (S.enabled.value ? 'aan/on' : 'uit/off') + ' (bron: ' + S.enabled.source + ')';
}

function fetchImpl(deps) {
  if (deps && deps.fetch) return deps.fetch;
  if (process.env.FORGE_ACCOUNT_ROTATOR_DENY_NETWORK === '1') {
    return async () => { const e = new Error('network denied by the FORGE_ACCOUNT_ROTATOR_DENY_NETWORK test seam'); e.name = 'FetchDeniedByTestSeamError'; throw e; };
  }
  return globalThis.fetch;
}
let _normalize = null;
function normalizeWindows(j) { if (!_normalize) _normalize = require('./usage-guard.cjs').normalizeWindows; return _normalize(j); }
// CLIENT PROBE (owner 2026-10-12: "de usage niet meetbaar ... fix het compleet"). A `claude setup-token` token has only the
// user:inference scope, so /api/oauth/usage answers 401/403 (claude-code issues #22450, #81015). The official client reports the
// account's windows itself: `claude -p` with --output-format stream-json emits a rate_limit_event whose rate_limit_info.unifiedWindows
// carries five_hour and seven_day {utilization 0..1, resetsAt epoch seconds} (verified live 2026-10-12 with the current login).
// The probe is a FALLBACK, not a replacement: measureToken always calls the usage endpoint above first (USAGE_URL, bearer token) and
// asks the client only after that answered 401/403/429. The probe itself makes no direct API call: the token reaches the child only
// through CLAUDE_CODE_OAUTH_TOKEN (never argv, never logged), one Haiku turn of ".". A missing event is "unmeasurable", never 0 and
// never full. A success is cached per token for PROBE_CACHE_MS so the 120 s watcher does not spend quota every cycle.
// HARDENING (Security Boss review 2026-11-02):
//  M1  a fresh private folder per probe (removed afterwards, also on error and timeout) instead of the shared temp root; an ABSOLUTE
//      launcher (resolveClaudeBin over absolute PATH entries only, or FORGE_ROTATOR_CLAUDE_BIN); no shell (a .cmd shim only through
//      System32 cmd.exe + cmdWrapperArgv); NoDefaultCurrentDirectoryInExePath=1; an empty MCP config with --strict-mcp-config and
//      --no-session-persistence (both listed by `claude --help` of the installed CLI 2.1.316, checked 2026-11-02 without a real call).
//  M2  an allow-list child env (PROBE_ENV_ALLOW + the token): routing, model and provider switches, proxies and NODE_OPTIONS stay out.
//  M3  a timeout kills the whole tree by exact PID (System32 taskkill /PID <pid> /T /F; POSIX: the process group) and only one probe
//      per token runs at a time (concurrent callers share it).
//  L1  'probe-failed' and 'empty' are cached for PROBE_NEG_CACHE_MS; the reason line names the time of the next attempt.
const PROBE_CACHE_MS = 5 * 60 * 1000;
const PROBE_NEG_CACHE_MS = 20 * 60 * 1000;
const PROBE_TIMEOUT_MS = 90 * 1000;
const PROBE_KILL_GRACE_MS = 10 * 1000;
const PROBE_DIR_PREFIX = 'forge-probe-';
const PROBE_MCP_FILE = 'mcp.json';
const PROBE_MCP_EMPTY = '{"mcpServers":{}}';
const PROBE_ARGS = ['-p', '.', '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--no-session-persistence'];
// What the child may see: locations and OS identity only. None of these routes a request or carries a credential, so
// ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, model and Bedrock/Vertex/Foundry switches, proxies and NODE_OPTIONS never reach it.
// CLAUDE_CODE_GIT_BASH_PATH: Claude Code on Windows may need it to start when Git is not on PATH.
const PROBE_ENV_ALLOW = ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'SystemDrive', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'CLAUDE_CODE_GIT_BASH_PATH', 'USER', 'LOGNAME', 'LANG'];
const probeCache = new Map();
const probeInflight = new Map();
function windowsFromRateLimitEvent(info) {
  const uw = info && info.unifiedWindows;
  if (!uw || typeof uw !== 'object') return [];
  const iso = (s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);
  const one = (w) => (w && Number.isFinite(Number(w.utilization)) ? { utilization: Math.round(Number(w.utilization) * 1000) / 10, resets_at: iso(w.resetsAt) } : null);
  return core.cleanWindows(normalizeWindows({ five_hour: one(uw.five_hour), seven_day: one(uw.seven_day) }));
}
function parseRateLimitEvent(stdout) {
  let found = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.indexOf('rate_limit_event') < 0) continue;
    try { const j = JSON.parse(line); if (j && j.type === 'rate_limit_event' && j.rate_limit_info) found = j.rate_limit_info; } catch { /* partial line */ }
  }
  return found;
}
/** envGet(env, name, win) — Windows variable names are case-insensitive (Path, PATH); a copied env object is not. */
function envGet(env, name, win) {
  if (!env) return undefined;
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (!win) return undefined;
  const up = name.toUpperCase();
  const k = Object.keys(env).find((x) => x.toUpperCase() === up);
  return k === undefined ? undefined : env[k];
}
const absoluteEntries = (v) => String(v || '').split(path.delimiter).filter((x) => x && path.isAbsolute(x));
/** systemExe(src, name) — an absolute %SystemRoot%\System32 path, never a bare name looked up in a folder. */
function systemExe(src, name) {
  const root = envGet(src, 'SystemRoot', true) || envGet(src, 'windir', true);
  return path.join(root && path.isAbsolute(root) ? root : 'C:\\Windows', 'System32', name);
}
function tokenHelpers() { return require('./account-rotator-token.cjs'); } // lazy: account-rotator-token.cjs loads this module at its top
/** probeChildEnv(token, src, win) — a NEW env with only PROBE_ENV_ALLOW (relative PATH entries dropped) plus the token. */
function probeChildEnv(token, src, win) {
  const out = {};
  for (const k of PROBE_ENV_ALLOW) { const v = envGet(src, k, win); if (typeof v === 'string' && v !== '') out[k] = v; }
  if (out.PATH !== undefined) { const p = absoluteEntries(out.PATH).join(path.delimiter); if (p) out.PATH = p; else delete out.PATH; }
  if (win) out.NoDefaultCurrentDirectoryInExePath = '1';
  out.CLAUDE_CODE_OAUTH_TOKEN = token;
  return out;
}
/** buildProbeSpawn(token, deps) -> {cmd, args, opts, mcpFile} | {refused}. Describes the probe's process start without starting it;
 *  no I/O beyond the launcher lookup on PATH. deps: {dir (the private probe folder), platform?, env? (source env), claudeBin?, execPath?}. */
function buildProbeSpawn(token, deps) {
  const d = deps || {};
  const win = (d.platform || process.platform) === 'win32';
  const src = d.env || process.env;
  const dir = d.dir;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !path.basename(dir).startsWith(PROBE_DIR_PREFIX)) return { refused: 'no private probe folder' };
  const pinned = envGet(src, 'FORGE_ROTATOR_CLAUDE_BIN', win);
  const lookupEnv = Object.assign({ PATH: absoluteEntries(envGet(src, 'PATH', win)).join(path.delimiter) }, pinned ? { FORGE_ROTATOR_CLAUDE_BIN: pinned } : {});
  const tok = tokenHelpers();
  const bin = tok.resolveClaudeBin({ claudeBin: d.claudeBin, env: lookupEnv });
  if (!bin) return { refused: 'claude was not found on PATH (set FORGE_ROTATOR_CLAUDE_BIN to its full path)' };
  const bad = tok.binUnsafe(bin);
  if (bad) return { refused: bad };
  if (!path.isAbsolute(bin)) return { refused: 'the claude launcher path is not absolute (set FORGE_ROTATOR_CLAUDE_BIN to its full path)' };
  const mcpFile = path.join(dir, PROBE_MCP_FILE);
  const args = PROBE_ARGS.concat(['--mcp-config', mcpFile, '--strict-mcp-config']); // --mcp-config takes several values: a flag must follow
  const opts = { cwd: dir, env: probeChildEnv(token, src, win), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  if (!win) opts.detached = true; // its own process group, so a timeout can end the whole tree
  if (/\.(c|m)?js$/i.test(bin)) return { cmd: d.execPath || process.execPath, args: [bin].concat(args), opts, mcpFile };
  if (win && /\.(cmd|bat)$/i.test(bin)) {
    const w = tok.cmdWrapperArgv(bin, args);
    if (w.refused) return { refused: w.refused };
    return { cmd: systemExe(src, 'cmd.exe'), args: w.argv, opts: Object.assign({}, opts, { windowsVerbatimArguments: true }), mcpFile };
  }
  return { cmd: bin, args, opts, mcpFile };
}
/** removeProbeDir(dir, base) — removes only a folder this probe made (<base>/forge-probe-XXXXXX). Windows can hold a folder for a
 *  moment after a killed process, so one later retry; what could stay behind is the empty MCP config, never the token. */
function removeProbeDir(dir, base) {
  if (typeof dir !== 'string' || path.dirname(dir) !== path.resolve(base) || !path.basename(dir).startsWith(PROBE_DIR_PREFIX)) return false;
  const rm = () => { fs.rmSync(dir, { recursive: true, force: true }); return true; };
  try { return rm(); } catch {
    const t = setTimeout(() => { try { rm(); } catch { /* left behind: the empty MCP config only, no token */ } }, 2000);
    if (t.unref) t.unref();
    return false;
  }
}
/** killProbeTree(child, win, d, src) — ends the probe and everything it started, by its exact PID only (never by image name). */
function killProbeTree(child, win, d, src) {
  const plainKill = () => { try { child.kill(win ? undefined : 'SIGKILL'); } catch { /* already gone */ } };
  const pid = child && child.pid;
  if (!Number.isInteger(pid) || pid <= 0) { plainKill(); return; }
  if (win) {
    try {
      const k = (d.spawn || spawn)(systemExe(src, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (k && typeof k.on === 'function') k.on('error', plainKill);
    } catch { plainKill(); }
    return;
  }
  try { if (d.processKill) d.processKill(-pid, 'SIGKILL'); else process.kill(-pid, 'SIGKILL'); } catch { plainKill(); }
}
/** runClientProbe(token, deps) -> {ok:true, stdout} | {ok:false, timeout?, refused?}. Resolves after the private folder is removed.
 *  Seams: deps.runClient (replaces the whole run), deps.spawn, deps.processKill, deps.platform, deps.env, deps.tmpBase. */
function runClientProbe(token, deps) {
  if (deps && deps.runClient) return deps.runClient(token);
  const d = deps || {};
  if (process.env.FORGE_ACCOUNT_ROTATOR_DENY_NETWORK === '1' && !d.spawn) return Promise.resolve({ ok: false, refused: 'client probe denied by the test seam' });
  const win = (d.platform || process.platform) === 'win32';
  const src = d.env || process.env;
  const base = d.tmpBase || os.tmpdir();
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(base, PROBE_DIR_PREFIX));
    fs.writeFileSync(path.join(dir, PROBE_MCP_FILE), PROBE_MCP_EMPTY, { mode: 0o600 });
  } catch {
    removeProbeDir(dir, base);
    return Promise.resolve({ ok: false, refused: 'could not prepare a private probe folder' });
  }
  const spec = buildProbeSpawn(token, Object.assign({}, d, { dir }));
  if (spec.refused) { removeProbeDir(dir, base); return Promise.resolve({ ok: false, refused: spec.refused }); }
  return new Promise((resolve) => {
    let out = ''; let result = null; let settled = false; let timer = null; let grace = null; let child = null;
    const settle = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace);
      removeProbeDir(dir, base);
      resolve(result || { ok: false });
    };
    try { child = (d.spawn || spawn)(spec.cmd, spec.args, spec.opts); } catch { result = { ok: false }; settle(); return; }
    timer = setTimeout(() => {
      if (result) return;
      result = { ok: false, timeout: true };
      killProbeTree(child, win, d, src);
      grace = setTimeout(settle, PROBE_KILL_GRACE_MS); // a killed tree may never report 'close': never hold the caller longer than this
    }, d.probeTimeoutMs || PROBE_TIMEOUT_MS);
    if (child.stdout) child.stdout.on('data', (c) => { out += c; if (out.length > 2000000) out = out.slice(-1000000); });
    child.on('error', () => { if (!result) result = { ok: false }; settle(); });
    child.on('close', () => { if (!result) result = { ok: true, stdout: out }; settle(); });
  });
}
const clockOf = (d) => (typeof d.now === 'function' ? d.now() : Date.now());
async function probeOnce(token, key, deps) {
  const d = deps || {};
  const useCache = !d.noProbeCache;
  const hit = useCache ? probeCache.get(key) : null;
  if (hit && clockOf(d) < hit.until) return hit.result;
  let r;
  try { r = await runClientProbe(token, deps); } catch { r = { ok: false }; } // an injected runner that throws counts as a failed probe
  let result;
  if (!r || !r.ok) result = { ok: false, kind: 'probe-failed', error: r && r.timeout ? 'client probe timed out' : 'client probe could not run' + (r && r.refused ? ' (' + r.refused + ')' : '') };
  else {
    const windows = windowsFromRateLimitEvent(parseRateLimitEvent(r.stdout));
    result = windows.length ? { ok: true, windows, maxPct: core.maxPct(windows), via: 'client-probe' } : { ok: false, kind: 'empty', error: 'client reported no usage windows' };
  }
  const now = clockOf(d);
  if (!result.ok) {
    const retryAt = new Date(now + PROBE_NEG_CACHE_MS).toISOString();
    result = Object.assign({}, result, { retryAt, error: result.error + ' — next client probe after ' + retryAt + ' (backoff ' + PROBE_NEG_CACHE_MS / 60000 + ' min)' });
  }
  if (useCache) probeCache.set(key, { until: now + (result.ok ? PROBE_CACHE_MS : PROBE_NEG_CACHE_MS), result });
  return result;
}
/** probeViaClient(token, deps) -> {ok:true, windows, maxPct, via:'client-probe'} | {ok:false, kind:'probe-failed'|'denied'|'empty', error, retryAt?}.
 *  Single flight: concurrent callers for one token share one probe. deps.noProbeCache turns both caches off (tests). */
function probeViaClient(token, deps) {
  if (process.env.FORGE_ACCOUNT_ROTATOR_DENY_NETWORK === '1' && !(deps && deps.runClient)) return Promise.resolve({ ok: false, kind: 'denied', error: 'client probe denied by the test seam' });
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const pending = probeInflight.get(key);
  if (pending) return pending;
  const p = probeOnce(token, key, deps).finally(() => probeInflight.delete(key));
  probeInflight.set(key, p);
  return p;
}

/** measureToken(token, deps) -> {ok:true, windows, maxPct} | {ok:false, kind, status?, error, probe?}. kind 'unauthorized' (401/403).
 *  On 401/403 (setup token without user:profile) or 429 the official client is asked as a fallback (probeViaClient). */
async function measureToken(token, deps) {
  const direct = await measureTokenEndpoint(token, deps);
  if (direct.ok || (direct.kind !== 'unauthorized' && !(direct.kind === 'http' && direct.status === 429))) return direct;
  const probe = await probeViaClient(token, deps);
  if (probe.ok) return probe;
  if (probe.kind === 'denied') return direct;
  // the honest original reason stays the kind; the probe outcome and its backoff ride along so the reason line says when it retries
  return Object.assign({}, direct, { probe: { kind: probe.kind, retryAt: probe.retryAt || null }, error: direct.error + ' · ' + probe.error });
}
async function measureTokenEndpoint(token, deps) {
  if (!guardRedact.validateTokenShape(token)) return { ok: false, kind: 'bad-token', error: 'token has an unexpected shape (rejected before use)' };
  vault.registerSecret(token);
  const f = fetchImpl(deps);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), (deps && deps.timeoutMs) || FETCH_TIMEOUT_MS);
  try {
    let r;
    try {
      r = await f(USAGE_URL, { headers: { authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' }, signal: ac.signal });
    } catch (e) {
      return { ok: false, kind: ac.signal.aborted ? 'timeout' : 'transport', error: ac.signal.aborted ? 'usage endpoint timed out (no action)' : 'usage endpoint request failed (' + guardRedact.transportErrorCode(e) + ')' };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, kind: 'unauthorized', status: r.status, error: 'usage endpoint HTTP ' + r.status };
    if (!r.ok) return { ok: false, kind: 'http', status: r.status, error: 'usage endpoint HTTP ' + r.status };
    let j;
    try { j = await r.json(); } catch (e) { return { ok: false, kind: 'parse', error: 'usage endpoint returned unparsable data (' + guardRedact.transportErrorCode(e) + ')' }; }
    const windows = core.cleanWindows(normalizeWindows(j));
    if (!windows.length) return { ok: false, kind: 'empty', error: 'usage endpoint reported no usable window' };
    return { ok: true, windows, maxPct: core.maxPct(windows) };
  } finally { clearTimeout(timer); }
}
function expiresMs(oauth) {
  const e = oauth && oauth.expiresAt;
  const ms = typeof e === 'number' ? e : typeof e === 'string' ? (Number.isFinite(Number(e)) ? Number(e) : Date.parse(e)) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}
/** liveReading(m, now, o) — o.viaSlotToken = true when the measurement used the slot's OWN stored token (the only
 *  readings that may later vouch for a new token's ownership — AR-V01). */
function liveReading(m, now, o) { return { windows: m.windows, measuredAt: new Date(now).toISOString(), source: 'live', unmeasurable: null, viaSlotToken: !!(o && o.viaSlotToken) }; }
/** refreshInactive(slots, activeName, readings, deps, now, o) — measures inactive LOGINS whose stored access token is
 *  still valid (never refreshed). Mutates `readings` (account readings; setup-token readings live elsewhere). */
async function refreshInactive(slots, activeName, readings, deps, now, o) {
  for (const s of slots) {
    if (!s || s.broken || s.name === activeName) continue;
    const prev = readings[s.name] || {};
    if (Date.parse(prev.measuredAt) > now - INACTIVE_REFRESH_MS && !(o && o.force)) continue;
    const oauth = s.credentials && s.credentials.claudeAiOauth;
    if (oauth && expiresMs(oauth) > now + 60000) {
      const m = await measureToken(oauth.accessToken, deps);
      if (m.ok) readings[s.name] = Object.assign({}, prev, liveReading(m, now, { viaSlotToken: true }));
    }
  }
}
function view(slots, readings, now, eligible) {
  return slots.filter((s) => s && !s.broken).map((s) => ({ name: s.name, eligible: eligible(s), reading: core.effectiveReading(readings[s.name], now), lastUsedAt: (readings[s.name] || {}).lastUsedAt || null }));
}
const fileEligible = (s) => !!(s && s.credentials && s.credentials.claudeAiOauth && s.oauthAccount && s.oauthAccount.accountUuid);

module.exports = {
  USAGE_URL, DEFAULTS, BOUNDS_FALLBACK, ENUMS, SWITCH_KEY, DISCLOSURE_FALLBACK, INACTIVE_REFRESH_MS, PROBE_ENV_ALLOW, PROBE_NEG_CACHE_MS,
  resolveSettings, loadConfig, settingsLine, bounds, measureToken, probeViaClient, buildProbeSpawn, runClientProbe, windowsFromRateLimitEvent, parseRateLimitEvent, expiresMs, liveReading, refreshInactive, view, fileEligible,
};
