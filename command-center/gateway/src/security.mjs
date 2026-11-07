// Security primitives for the Forge Compatibility Gateway.
// Zero-dependency (node:* only). Adapted from the proven pattern that ran in the retired
// per-project Control Center (DNS-rebinding guard + path containment, —
// reused here rather than re-invented, per this project's "follow existing
// conventions" rule.
import path from 'node:path';
import crypto from 'node:crypto';
import { getGatewayPort } from './runtime-state.mjs';

// A malicious web page whose domain re-resolves to 127.0.0.1 (DNS-rebinding) could still fetch
// this gateway's /api/* routes if only the bind address were checked. Two independent checks:
// (1) Host header must name a localhost host; (2) cross-site browser fetches are rejected via
// Sec-Fetch-Site / Origin. Same two-check shape as the retired per-project Control Center server.
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Origins allowed to call the gateway's API: the gateway's own served origin and, ONLY in dev mode,
// the Vite dev server origin (5173) used during `npm run dev`.
// WP B1a: the gateway's own origin follows the port it REALLY listens on
// (runtime-state.mjs getGatewayPort(): 4100 by default, an env-pinned port, or the free loopback
// port bin.mjs fell back to). Only the current port is allowed — after a fallback, 4100 belongs to
// some other process, so its origin must not be trusted.
// FU-STEP2 security fix round (Security Boss FAIL, HIGH): the :5173 origins used to be allowed on EVERY
// gateway. With the cookie and credentialed CORS that let a script on any Vite project page (5173 is the
// default port of every Vite app, first come first served) read transcripts and, in a paired browser,
// write as the dashboard. They are now trusted only when the gateway was started with the explicit dev
// switch FORGE_DEV_ORIGINS=1, read once at start (like the UI secret below). The desktop app strips the
// switch from the gateway's environment (desktop gateway-launcher BLOCKED_ENV_KEYS); forge-cc-launch passes
// one the developer set and prints a warning when it is on.
export const DEV_ORIGINS = Object.freeze(['http://localhost:5173', 'http://127.0.0.1:5173']);
export const DEV_ORIGINS_ENV = 'FORGE_DEV_ORIGINS';

/** Pure: true only when `env` sets the dev switch to exactly `1` (surrounding spaces ignored). */
export function devOriginsEnabled(env) {
  const raw = env ? env[DEV_ORIGINS_ENV] : undefined;
  return typeof raw === 'string' && raw.trim() === '1';
}

const DEV_ORIGINS_AT_START = devOriginsEnabled(process.env);
let devOriginsOn = DEV_ORIGINS_AT_START;

/** Whether this gateway trusts the Vite dev origins (the dev switch it was started with). */
export function devOriginsActive() {
  return devOriginsOn;
}

/** Test-only: force dev mode on/off; null restores what the environment said at start. */
export function _setDevOriginsForTests(on) {
  devOriginsOn = on === null || on === undefined ? DEV_ORIGINS_AT_START : Boolean(on);
}

export function allowedOrigins() {
  const port = getGatewayPort();
  const own = ['http://localhost:' + port, 'http://127.0.0.1:' + port];
  return new Set(devOriginsOn ? [...own, ...DEV_ORIGINS] : own);
}

export function hostName(req) {
  const h = String((req.headers && req.headers.host) || '');
  if (!h) return '';
  try { return new URL('http://' + h).hostname.toLowerCase(); } catch { return h.toLowerCase(); }
}

export function hostOk(req) {
  const h = hostName(req);
  return h === '' || LOCAL_HOSTS.has(h);
}

export function crossSiteOk(req) {
  const sfs = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'same-site' && sfs !== 'none') return false;
  const origin = req.headers && req.headers.origin;
  if (origin && !allowedOrigins().has(origin)) return false;
  return true;
}

// Belt-and-suspenders path containment: resolved must be exactly baseDir, or a real descendant
// of it (string-prefix check on the OS-native separator, not a naive substring check — this is
// the same shape as server.cjs's own containment guard).
export function containmentOk(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(targetPath);
  return resolved === base || resolved.startsWith(base + path.sep);
}

// C1 fix: project discovery now scans several well-known roots at once (paths.mjs's
// SYNC_SCAN_ROOTS), not just one — this is the matching defense-in-depth containment check: true
// when targetPath is a real descendant of (or equal to) ANY of the given base directories, never
// a looser check than containmentOk() run once per candidate root.
export function anyContainmentOk(baseDirs, targetPath) {
  return baseDirs.some((baseDir) => containmentOk(baseDir, targetPath));
}

// Allowlist regex for anything that becomes part of a filesystem path derived from request
// input (run ids). No '.', no '/', no '\\' — traversal sequences cannot match this pattern.
export const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function safeIdOk(id) {
  return typeof id === 'string' && id.length > 0 && SAFE_ID_RE.test(id);
}

// WP4: conversation id allowlist — the literal work-package spec is `^[A-Za-z0-9-]+$` (no
// underscore), distinct from SAFE_ID_RE above (run ids allow underscore). Bounded length so a
// pathological id can never build an absurdly long filesystem path.
export const SAFE_CONV_ID_RE = /^[A-Za-z0-9-]+$/;

export function safeConvIdOk(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_CONV_ID_RE.test(id);
}

// fix-sec-round #1 (HIGH, owner-requested 2026-07-29): a per-boot random execution token.
//
// THE GAP: crossSiteOk() above legitimately allows a request with NO Origin/Sec-Fetch-Site
// headers at all — a real, same-origin browser navigation sends exactly that shape (or
// `Sec-Fetch-Site: none`), so the check cannot reject it without also breaking real browsing.
// But a non-browser HTTP client (curl, a background script, a second unrelated local process on
// this machine) sends that SAME headerless shape and was, before this fix, indistinguishable from
// the real dashboard — reaching a real write route (POST /messages) with no auth layer at all.
//
// THE FIX: one random token, generated ONCE when this module is first loaded — in production that
// is once per real gateway process boot; this project's own test convention already runs each
// test FILE in its own child process (`node --test` isolates by file), so "per boot" and "per test
// file" coincide here with no extra reset hook needed.
//
// FU-STEP2: the token is NO LONGER put into the served HTML (static.mjs injected it as
// `<meta name="cc-exec-token">` until then; the paragraphs below describe why that was weak). The
// dashboard now authenticates with the out-of-band UI session cookie (see UI_SESSION_COOKIE below);
// this header token never leaves the gateway process and is presented only by its in-process tests.
//
// A1 CORRECTION (2026-09-26 laptop re-audit): an earlier version of this comment claimed a
// "genuinely different local process never had that page load, so it never has the token" — that
// is FALSE and is corrected here. static.mjs's injectExecToken() puts the token into `index.html`
// for ANY plain GET request that passes the Host/Origin checks above, and a real, same-origin
// browser navigation is not the only shape that passes them: crossSiteOk() explicitly allows a
// request with no Origin/Sec-Fetch-Site header at all (see its own comment), which is exactly what
// a same-user local script (`curl http://127.0.0.1:4100/`, a scheduled task, another CLI tool the
// owner runs) sends too — that other program can read the token straight out of the served HTML
// and then pass execTokenOk(), same as the real dashboard. This is NOT, and was never meant to be,
// a boundary between two different local programs run by the SAME user on the SAME machine — on a
// single-user machine any other program already running as that user can reach equivalent
// capabilities directly (the filesystem, the `claude` CLI, this project's own files), so a token
// cannot meaningfully raise that bar. What the token DOES stop is the one shape a Host/Origin check
// alone cannot: a malicious WEB PAGE open in the owner's browser (a different tab, a compromised
// site) whose script tries a cross-site fetch/XHR against this loopback gateway — a real browser
// attaches Sec-Fetch-Site: cross-site (or a foreign Origin) to that request, which crossSiteOk()
// rejects, and even in the rare case that check is bypassed the page never had a same-origin load
// of this gateway's own HTML, so it never obtained the token either. In short: this is a CSRF-style
// gate against a hostile page in the browser, not a multi-user or multi-process auth system, and it
// assumes — exactly like exec-bridge.mjs's own SECURITY FRAME comment for 'bypass' mode — a
// single-user machine where every other LOCAL process already implicitly trusted.
export const EXEC_TOKEN_HEADER = 'x-cc-exec-token';
const EXEC_TOKEN = crypto.randomBytes(24).toString('hex');

/** The current boot's real token — also what static.mjs injects into the served SPA. */
export function getExecToken() {
  return EXEC_TOKEN;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True only when the request carries the exact current-boot token — constant-time compare so a
 *  wrong guess cannot be timed byte-by-byte. */
export function execTokenOk(req) {
  const header = req.headers && req.headers[EXEC_TOKEN_HEADER];
  return typeof header === 'string' && header.length > 0 && timingSafeEqualStr(header, EXEC_TOKEN);
}

// WP B3-sec-impl (Security Boss Step 1a, docs/forge-systeem/B3-permissions-security-decision.md):
// the AGENT token. The exec token above is the DASHBOARD's token; the forge-ask MCP server that runs
// inside a `claude` turn gets a different one, so a process the agent starts can no longer answer
// its own permission cards, mark a project trusted, change config or start a conversation.
//
// - One random token per CONVERSATION, issued when a turn of that conversation is spawned with an
//   ask-mcp config (exec-cli.mjs execSpawnEnv) and reused by its later turns. It lives in memory
//   only, so a gateway restart forgets it (the per-boot exec token behaves the same way).
// - It is bound to its conversation: routes/permissions.mjs takes the conversation from the token,
//   never from the request body alone.
// - It travels in the same `x-cc-exec-token` header; the ROUTE decides which kind it must be
//   (routes/permissions.mjs checkWriteToken). It is never put in served HTML (static.mjs injects
//   getExecToken() only), never written to the mcp-config file, and scrubGatewayTokens() below
//   removes it from anything the permission store shows or logs.
// - Lookup is by the SHA-256 of the presented header, so the map lookup leaks nothing usable about
//   the token bytes through timing.
const agentTokenHashToConv = new Map(); // sha256(token) -> convId
const agentTokenByConv = new Map(); // convId -> token

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The agent token for `convId` (created on first use, then stable for this gateway process), or
 *  null for an id that is not a valid conversation id. */
export function issueAgentToken(convId) {
  if (!safeConvIdOk(convId)) return null;
  const existing = agentTokenByConv.get(convId);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  agentTokenByConv.set(convId, token);
  agentTokenHashToConv.set(sha256Hex(token), convId);
  return token;
}

/** The conversation id whose agent token this request carries, or null (no token, the dashboard
 *  token, or an unknown value). */
export function agentTokenConversation(req) {
  const header = req && req.headers && req.headers[EXEC_TOKEN_HEADER];
  if (typeof header !== 'string' || header.length === 0) return null;
  return agentTokenHashToConv.get(sha256Hex(header)) || null;
}

const REDACTED_AGENT_TOKEN = '[REDACTED:FORGE_AGENT_TOKEN]';
const REDACTED_EXEC_TOKEN = '[REDACTED:FORGE_EXEC_TOKEN]';
const REDACTED_UI_SECRET = '[REDACTED:FORGE_UI_SESSION]';

function scrubString(text) {
  let out = text.split(EXEC_TOKEN).join(REDACTED_EXEC_TOKEN);
  if (out.includes(UI_SESSION_SECRET)) out = out.split(UI_SESSION_SECRET).join(REDACTED_UI_SECRET);
  for (const token of agentTokenByConv.values()) {
    if (out.includes(token)) out = out.split(token).join(REDACTED_AGENT_TOKEN);
  }
  return out;
}

/** Deep copy of `value` with every live gateway token (the exec token and every issued agent
 *  token) replaced by a marker. For anything shown on a card or written to a conversation log. */
export function scrubGatewayTokens(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => scrubGatewayTokens(item));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = scrubGatewayTokens(v);
    return out;
  }
  return value;
}

/** Test-only: forget every issued agent token. */
export function _resetAgentTokensForTests() {
  agentTokenHashToConv.clear();
  agentTokenByConv.clear();
}

// FU-STEP2 (Security Boss Step 2, decision A-prime, docs/forge-systeem/B3-permissions-security-decision.md
// sections 4-7): the DASHBOARD credential is an HttpOnly, SameSite=Strict, Path=/ cookie that is delivered
// OUT OF BAND, never by a plain page load. Before this, the exec token sat in the served HTML, so any
// process the agent starts could `curl /` and then answer its own permission cards (residual risk O3).
//
// - The cookie value is the UI SESSION SECRET. A parent hands it over in FORGE_UI_SESSION_SECRET (the
//   desktop main process; the forge-cc-launch launcher), so it survives a gateway restart by that parent.
//   Without one the gateway makes its own per boot. The name does not start with `cc_`/`claude_`, so
//   exec-cli's prefix allowlist never forwards it; it is also deleted from process.env right here, at
//   module load, before server.mjs can spawn anything (bin.mjs imports server.mjs, which imports this).
// - Desktop: Electron's main process sets the cookie for the gateway origin before loadURL.
// - Browser/dev: the launcher passes a one-time PAIRING CODE in FORGE_UI_PAIRING_CODE (`<code>.<expiry
//   ms>`), prints `http://127.0.0.1:<port>/?pair=<code>`, and GET /?pair=<code> (static.mjs
//   servePairing) swaps it once, within 120 s, for the cookie plus a 302 to the clean URL. No HTTP route
//   can mint a code: every local process could call it, which is exactly what this closes.
// - The Host/Origin/Sec-Fetch guards in server.mjs stay in front and are the CSRF defence for an ambient
//   cookie; cookieSiteOk() below adds one rule for cookie requests (same-site must name an allowed Origin).
// - The header token above stays accepted, but it no longer leaves this process: only the gateway's own
//   in-process route tests present it (test-support/helpers.mjs).
//
// Honest limits (residual risks, also in the owner queue):
// - A cookie is scoped by host, not port. In a desktop BROWSER that was paired, any other server on
//   127.0.0.1 that this browser visits (for example a preview the agent started) receives the Cookie header,
//   so that server sees the secret. The desktop app is not affected: it keeps its cookie in its own Electron
//   session, which never navigates off the gateway origin.
// - The secret travels in the ENVIRONMENT (the decided channel). Deleting it from process.env below keeps it
//   from the gateway's own children, but not from the OS copy: on Linux /proc/<pid>/environ and `ps eww`,
//   on macOS `ps -E`, still show the start-up environment to the same user; on Windows reading another
//   process's environment needs code (tier T2). The launcher's supervisor keeps both values in its own
//   environment for its lifetime and passes them on at every restart.
// - A process that can run the launcher can pair itself. Code that reads browser cookies or process memory
//   (decision tier T2/P5) is out of reach of any gateway check.
export const UI_SESSION_COOKIE = 'forge_ui';
export const UI_SESSION_SECRET_ENV = 'FORGE_UI_SESSION_SECRET';
export const UI_PAIRING_ENV = 'FORGE_UI_PAIRING_CODE';
export const PAIRING_TTL_MS = 120000;
// Cookie-safe token characters only (hex or base64url), long enough to be unguessable.
const UI_SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
const PAIRING_CODE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_PAIRING_CODES = 32;

/**
 * Reads the secret and a launcher pairing code from an environment object. Pure: no side effects.
 * `FORGE_UI_PAIRING_CODE` is `<code>` or `<code>.<expiresAtMs>`; an expiry is clamped to at most
 * PAIRING_TTL_MS from `now`, a past or unreadable one drops the code.
 * @returns {{ secret: string|null, pairing: { code: string, expiresAt: number }|null }}
 */
export function parseUiSessionEnv(env, now = Date.now()) {
  const rawSecret = typeof env[UI_SESSION_SECRET_ENV] === 'string' ? env[UI_SESSION_SECRET_ENV].trim() : '';
  const secret = UI_SECRET_RE.test(rawSecret) ? rawSecret : null;
  const rawPairing = typeof env[UI_PAIRING_ENV] === 'string' ? env[UI_PAIRING_ENV].trim() : '';
  const [code, expiryText, ...rest] = rawPairing.split('.');
  let pairing = null;
  if (rest.length === 0 && PAIRING_CODE_RE.test(code || '')) {
    const latest = now + PAIRING_TTL_MS;
    const expiry = expiryText === undefined ? latest : (/^\d{1,16}$/.test(expiryText) ? Number(expiryText) : NaN);
    if (Number.isFinite(expiry) && expiry > now) pairing = { code, expiresAt: Math.min(expiry, latest) };
  }
  return { secret, pairing };
}

let uiClock = () => Date.now();
const pairingCodes = new Map(); // sha256(code) -> expiresAt (ms)

const uiBoot = parseUiSessionEnv(process.env);
delete process.env[UI_SESSION_SECRET_ENV];
delete process.env[UI_PAIRING_ENV];
const UI_SESSION_SECRET = uiBoot.secret || crypto.randomBytes(32).toString('hex');
if (uiBoot.pairing) pairingCodes.set(sha256Hex(uiBoot.pairing.code), uiBoot.pairing.expiresAt);

function prunePairingCodes(now) {
  for (const [hash, expiresAt] of pairingCodes) if (expiresAt <= now) pairingCodes.delete(hash);
}

/** In-process only (tests; never reachable over HTTP): a fresh one-time code, valid PAIRING_TTL_MS. */
export function issuePairingCode() {
  const now = uiClock();
  prunePairingCodes(now);
  while (pairingCodes.size >= MAX_PAIRING_CODES) pairingCodes.delete(pairingCodes.keys().next().value);
  const code = crypto.randomBytes(24).toString('hex');
  pairingCodes.set(sha256Hex(code), now + PAIRING_TTL_MS);
  return code;
}

/** True once for a live code (it is removed in the same step); false for an unknown, used or expired one. */
export function consumePairingCode(code) {
  if (typeof code !== 'string' || !PAIRING_CODE_RE.test(code)) return false;
  const now = uiClock();
  prunePairingCodes(now);
  const hash = sha256Hex(code);
  const expiresAt = pairingCodes.get(hash);
  if (expiresAt === undefined) return false;
  pairingCodes.delete(hash);
  return expiresAt > now;
}

/** The Set-Cookie value the pairing swap sends: a host-only session cookie (no Domain, no expiry). */
export function uiSessionSetCookie() {
  return UI_SESSION_COOKIE + '=' + UI_SESSION_SECRET + '; HttpOnly; SameSite=Strict; Path=/';
}

/** Every value the Cookie header carries under the session cookie's name (a junk copy tossed in by another
 *  loopback server must not hide the real one). */
function uiSessionCookieValues(req) {
  const header = req && req.headers && req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return [];
  const values = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== UI_SESSION_COOKIE) continue;
    values.push(part.slice(eq + 1).trim());
  }
  return values;
}

/** True when the request carries the current UI session cookie (constant-time compare). */
export function uiSessionOk(req) {
  return uiSessionCookieValues(req).some((value) => value.length > 0 && timingSafeEqualStr(value, UI_SESSION_SECRET));
}

/**
 * The extra CSRF rule for a request that authenticates with the cookie (crossSiteOk already refused
 * cross-site and every foreign Origin): a SAME-SITE request (another port on this loopback host) must
 * name an allowed Origin; without one it is refused.
 */
export function cookieSiteOk(req) {
  const sfs = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (sfs !== 'same-site') return true;
  const origin = req.headers && req.headers.origin;
  return typeof origin === 'string' && allowedOrigins().has(origin);
}

/** The Origin to echo in CORS answers: only an allowed one (the gateway's own; the Vite dev server only
 *  in dev mode, see devOriginsEnabled). */
export function corsOrigin(req) {
  const origin = req && req.headers && req.headers.origin;
  return typeof origin === 'string' && allowedOrigins().has(origin) ? origin : null;
}

/** Test-only: replace the clock the pairing codes use (null restores Date.now). */
export function _setUiSessionClockForTests(clock) {
  uiClock = typeof clock === 'function' ? clock : () => Date.now();
}
