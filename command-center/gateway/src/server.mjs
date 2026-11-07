// Forge Compatibility Gateway — request handler + server factory (the composition root).
// Zero-dependency (node:http only). Binds 127.0.0.1 only; enforces the DNS-rebinding + cross-site
// guard on every request before any route logic runs, the same way the retired per-project
// Control Center did before it was.
//
// WP A11 part 1: the ~50 inline route branches moved into src/routes/<family>.mjs. This file keeps
// the request parsing, the security middleware (host guard, cross-site guard, method allowlist,
// exec token) in the same order, the ORDERED route table below (first match wins, exactly the order
// the old if-chain had) and the final 404. test/routes-table.test.mjs snapshots the table, so a
// lost, duplicated or reordered route fails a test.
import http from 'node:http';
import { hostOk, crossSiteOk, corsOrigin, uiSessionOk, EXEC_TOKEN_HEADER } from './security.mjs';
import { serveStatic, servePairing, STATIC_SECURITY_HEADERS } from './static.mjs';
import { sendJson } from './routes/http.mjs';
import { loadOptionalModule } from './routes/optional-module.mjs';
import * as system from './routes/system.mjs';
import * as discord from './routes/discord.mjs';
import * as projects from './routes/projects.mjs';
import * as registry from './routes/registry.mjs';
import * as runViews from './routes/run-views.mjs';
import * as files from './routes/files.mjs';
import * as conversations from './routes/conversations.mjs';
import * as ask from './routes/ask.mjs';
import * as permissions from './routes/permissions.mjs';
import * as jobs from './routes/jobs.mjs';
import * as forgeOps from './routes/forge-ops.mjs';
import * as providers from './routes/providers.mjs';
import * as providersCustom from './routes/providers-custom.mjs';
import * as appRouter from './routes/app-router.mjs';

// The two test-only rate-limit seams keep their old import path ('../src/server.mjs').
export { _setRateLimitClockForTests, _configureRateLimitForTests } from './routes/rate-limit.mjs';

const { CONV_ITEM_RE, CONV_MESSAGES_RE, CONV_STOP_RE, CONV_STREAM_RE, CONV_ATTACHMENTS_RE, CONV_FORK_RE } = conversations;
const { ASK_RE, ASK_ANSWER_RE } = ask;
const { AGENT_MODEL_RE } = registry;

// account-rotation.mjs is loaded on demand in the /api/account-rotation branch: the distributed app
// excludes it from the package (WP B7a), so a static import would crash the gateway at start.
// WP A11 review follow-up: only an ABSENT module file answers 404 not_found; a present module whose
// own imports are broken is logged and answers 500 (loadOptionalModule re-throws).
const ACCOUNT_ROTATION_URL = new URL('./account-rotation.mjs', import.meta.url);
const optional = {
  MODULE: 'server',
  // the account rotator's recommendation, account-wide and read-only (token-free files only —
  // see account-rotation.mjs's header for exactly which two files are read and which are never opened).
  async accountRotation(req, res) {
    const accountRotation = await loadOptionalModule(ACCOUNT_ROTATION_URL);
    if (!accountRotation) return sendJson(res, 404, { ok: false, error: 'not_found' });
    return sendJson(res, 200, accountRotation.buildAccountRotation());
  },
};

// FU-STEP2: whether THIS window holds the UI session cookie (security.mjs uiSessionOk). The dashboard
// asks once at start and shows its pairing card when the answer is false. Only a boolean about the
// caller's own cookie goes back; the secret never appears in a response.
const uiSession = {
  MODULE: 'server',
  async status(req, res) {
    return sendJson(res, 200, { ok: true, paired: uiSessionOk(req) });
  },
};

// FU-STEP2: in dev mode (the gateway was started with FORGE_DEV_ORIGINS=1, security.mjs devOriginsEnabled)
// the Vite dev server is an allowed origin and calls this gateway cross-origin with `credentials:
// 'include'`, so an /api answer to an ALLOWED Origin names that origin and allows credentials. Any other
// Origin never gets here (crossSiteOk refused it) and no answer without an Origin carries CORS headers.
// Without the dev switch only the gateway's own origin is allowed, and a same-origin page needs no CORS,
// so a normal (desktop / launcher) gateway in practice never answers with CORS headers at all. A JSON POST
// from :5173 is preflighted (OPTIONS); the preflight is answered here for allowed origins only, before the
// method guard.
const CORS_PREFLIGHT_HEADERS = Object.freeze({
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
  'Access-Control-Allow-Headers': 'content-type, ' + EXEC_TOKEN_HEADER,
  'Access-Control-Max-Age': '600',
});

function applyCors(req, res) {
  const origin = corsOrigin(req);
  if (!origin) return null;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  return origin;
}

/** One route: method ('*' = any method that passed the method guard), path (exact string or RegExp), handler. */
function route(method, path, mod, handlerName) {
  const handle = mod[handlerName];
  if (typeof handle !== 'function') throw new Error('route table: ' + mod.MODULE + '.' + handlerName + ' is not a function');
  return Object.freeze({ method, path, module: mod.MODULE, handler: handlerName, handle });
}

// The ordered API route table. First match on (method, path) wins — the same order as the old
// inline if-chain, so behaviour for overlapping paths is unchanged. A path that matches but whose
// method does not falls through to the next entry and finally to the 404.
const API_ROUTES = Object.freeze([
  route('*', '/api/health', system, 'health'),
  route('GET', '/api/ui-session', uiSession, 'status'),
  route('GET', '/api/discord/status', discord, 'status'),
  route('POST', '/api/discord/start', discord, 'start'),
  route('POST', '/api/discord/stop', discord, 'stop'),
  route('POST', '/api/discord/connect', discord, 'connect'),
  route('POST', '/api/discord/guild', discord, 'guild'),
  route('GET', '/api/discord/projects-dir', discord, 'projectsDirGet'),
  route('POST', '/api/discord/projects-dir', discord, 'projectsDirPost'),
  route('GET', '/api/discord/browse-folder', discord, 'browse'),
  route('GET', '/api/discord/activity', discord, 'activity'),
  route('POST', '/api/projects', projects, 'create'),
  route('*', '/api/projects', projects, 'list'),
  route('*', '/api/projects/install-status', projects, 'installStatus'),
  route('*', '/api/runs', projects, 'runs'),
  route('GET', projects.TEAM_CHAT_ROUTE_RE, projects, 'teamChat'),
  route('*', '/api/events', projects, 'events'),
  route('*', '/api/missions', projects, 'missions'),
  route('*', '/api/agents', registry, 'agents'),
  route('PATCH', AGENT_MODEL_RE, registry, 'agentModel'),
  route('*', projects.PROJECT_PROFILE_RE, projects, 'profile'),
  route('GET', '/api/mindmaps', files, 'mindmaps'),
  route('GET', '/api/account-rotation', optional, 'accountRotation'),
  route('*', '/api/skills', registry, 'skills'),
  route('*', '/api/models', system, 'models'),
  route('GET', '/api/providers', providers, 'list'),
  route('GET', '/api/providers/keys', providers, 'keys'),
  route('POST', providers.KEYS_RELOAD_PATH, providers, 'keysReload'),
  route('POST', providers.PROVIDER_TEST_RE, providers, 'test'),
  route('GET', providers.PROVIDER_LOGIN_HINT_RE, providers, 'loginHint'),
  route('GET', providersCustom.CUSTOM_COLLECTION_PATH, providersCustom, 'list'),
  route('POST', providersCustom.CUSTOM_COLLECTION_PATH, providersCustom, 'create'),
  route('PATCH', providersCustom.CUSTOM_ITEM_RE, providersCustom, 'update'),
  route('DELETE', providersCustom.CUSTOM_ITEM_RE, providersCustom, 'remove'),
  route('*', '/api/checkup', system, 'checkup'),
  route('*', '/api/proof', runViews, 'proof'),
  route('*', '/api/chat-runs', runViews, 'chatRuns'),
  route('*', '/api/pending-asks', runViews, 'pendingAsks'),
  route('*', '/api/agent-dispatches', runViews, 'agentDispatches'),
  route('*', '/api/active-runs', system, 'activeRuns'),
  route('*', '/api/usage', system, 'usage'),
  route('*', files.ARTIFACT_CONTENT_RE, files, 'artifactContent'),
  route('*', '/api/tools', registry, 'tools'),
  route('*', '/api/mcp', registry, 'mcp'),
  route('*', '/api/capabilities', registry, 'capabilities'),
  route('GET', '/api/config', registry, 'configGet'),
  route('POST', '/api/config', registry, 'configPost'),
  route('GET', appRouter.APP_ROUTER_PATH, appRouter, 'get'),
  route('POST', appRouter.APP_ROUTER_PATH, appRouter, 'save'),
  route('GET', appRouter.APP_ROUTER_STATUS_PATH, appRouter, 'status'),
  route('POST', appRouter.APP_ROUTER_PROFILES_PATH, appRouter, 'createProfile'),
  route('POST', appRouter.APP_ROUTER_TEST_RE, appRouter, 'testTarget'),
  route('*', '/api/files', files, 'list'),
  route('*', '/api/files/read', files, 'read'),
  route('*', '/api/recovery', runViews, 'recovery'),
  route('*', '/api/checkpoints', runViews, 'checkpoints'),
  route('*', '/api/approvals', runViews, 'approvals'),
  route('GET', '/api/jobs', jobs, 'jobsList'),
  route('GET', '/api/jobs/detail', jobs, 'jobDetail'),
  route('GET', '/api/forge-ops/killswitch/status', forgeOps, 'killswitchStatus'),
  route('GET', '/api/forge-ops/rollback/list', forgeOps, 'rollbackList'),
  route('GET', '/api/forge-ops/rollback/plan', forgeOps, 'rollbackPlan'),
  route('GET', '/api/conversations', conversations, 'list'),
  route('POST', '/api/conversations', conversations, 'create'),
  route('GET', CONV_ITEM_RE, conversations, 'read'),
  route('DELETE', CONV_ITEM_RE, conversations, 'remove'),
  route('PATCH', CONV_ITEM_RE, conversations, 'rename'),
  route('POST', CONV_MESSAGES_RE, conversations, 'sendMessage'),
  route('POST', CONV_ATTACHMENTS_RE, conversations, 'attach'),
  route('POST', CONV_STOP_RE, conversations, 'stop'),
  route('POST', CONV_FORK_RE, conversations, 'fork'),
  route('POST', ASK_RE, ask, 'ask'),
  route('POST', ASK_ANSWER_RE, ask, 'answer'),
  route('POST', permissions.PERMISSION_REQUEST_PATH, permissions, 'request'),
  route('GET', permissions.PERMISSION_PENDING_PATH, permissions, 'pending'),
  route('POST', permissions.PERMISSION_WAIT_RE, permissions, 'wait'),
  route('POST', permissions.PERMISSION_ANSWER_RE, permissions, 'answer'),
]);

// The two long-lived SSE routes. They are matched BEFORE the API table (as before the split) and
// take over `res` themselves instead of going through a single JSON response.
const STREAM_ROUTES = Object.freeze([
  route('*', '/api/events/stream', projects, 'eventsStream'),
  route('GET', CONV_STREAM_RE, conversations, 'stream'),
]);

function findRoute(table, method, pathname) {
  for (const r of table) {
    if (r.method !== '*' && r.method !== method) continue;
    if (typeof r.path === 'string') {
      if (r.path === pathname) return { route: r, match: null };
    } else {
      const match = pathname.match(r.path);
      if (match) return { route: r, match };
    }
  }
  return null;
}

/** The route table as plain data (for the contract test and the README): method, path, module, handler, kind. */
export function describeRoutes() {
  const row = (kind) => (r) => ({
    kind,
    method: r.method,
    path: typeof r.path === 'string' ? r.path : r.path.source,
    module: r.module,
    handler: r.handler,
  });
  return [...STREAM_ROUTES.map(row('stream')), ...API_ROUTES.map(row('api'))];
}

async function handleApi(req, res, pathname, searchParams) {
  const found = findRoute(API_ROUTES, req.method, pathname);
  if (found) return found.route.handle(req, res, { pathname, searchParams, match: found.match });
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

export function requestListener(req, res) {
  let parsed;
  try { parsed = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('bad request'); }
  const pathname = parsed.pathname;

  if (!hostOk(req)) {
    return sendJson(res, 403, { error: 'forbidden host — gateway is localhost-only (DNS-rebinding blocked)' });
  }
  // WP10 should-fix-now #11 (root-cause fix for AP-4/AP-13): this guard used to apply ONLY to
  // /api/* paths, leaving the static surface reachable from a cross-site <img>/<iframe> with no
  // guard at all — that gap is what made AP-4's decodeURIComponent crash and AP-13's frameable
  // clickjacking target reachable cross-origin in the first place. A normal top-level navigation
  // sends Sec-Fetch-Site: none (or omits the header entirely on older clients) and every
  // same-origin asset load sends same-origin — both already pass crossSiteOk() unchanged — so
  // extending it to every path blocks only genuinely cross-site requests, never real browsing.
  // Verified against a real headless-Chrome load of the built dashboard (see this WP's report).
  if (!crossSiteOk(req)) {
    if (pathname.startsWith('/api/')) return sendJson(res, 403, { error: 'cross-site request blocked' });
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...STATIC_SECURITY_HEADERS });
    return res.end('cross-site request blocked');
  }

  if (pathname.startsWith('/api/')) {
    const allowedCorsOrigin = applyCors(req, res);
    if (allowedCorsOrigin && req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, CORS_PREFLIGHT_HEADERS);
      return res.end();
    }
  }

  // WP4: exactly 3 conversation routes accept POST (create / send message / stop); every other
  // route on this gateway remains read-only, unchanged from WP1-WP3. build-newproject adds one
  // more: POST /api/projects (the real "New project" button). build-lastdemos T3 adds a 4th
  // conversation write route: POST /api/conversations/:id/attachments (the real "Attach" upload).
  // feat-delete-conversation adds the one DELETE route this gateway accepts at all: DELETE
  // /api/conversations/:id — scoped to CONV_ITEM_RE specifically, never the bare
  // '/api/conversations' collection path (a DELETE there stays a real 405, unchanged).
  const isConversationWriteRoute =
    pathname === '/api/conversations' ||
    CONV_MESSAGES_RE.test(pathname) ||
    CONV_STOP_RE.test(pathname) ||
    CONV_ATTACHMENTS_RE.test(pathname) ||
    CONV_FORK_RE.test(pathname);
  // feat-ask-owner: two more real POST write routes — ASK_RE (the ask-mcp.mjs subprocess
  // registering a question) and ASK_ANSWER_RE (the dashboard's own real answer submission).
  const isAskWriteRoute = ASK_RE.test(pathname) || ASK_ANSWER_RE.test(pathname);
  // WP B3: the permission prompt routes (ask-mcp.mjs registers + long-polls with the agent token;
  // the dashboard answers). GET /api/permissions/pending stays read-only. The trust path is NOT a
  // write route in this release.
  const isPermissionWriteRoute = permissions.isPermissionWriteRoute(pathname);
  // the real Discord-bot write routes (see discord.DISCORD_WRITE_PATHS
  // for why '/api/discord/projects-dir' is listed although it also answers GET).
  const isDiscordWriteRoute = discord.DISCORD_WRITE_PATHS.includes(pathname);
  // the dashboard's real config-write route — GET /api/config stays read-only and
  // unlisted here, exactly like every other GET route on this gateway.
  const isConfigWriteRoute = pathname === '/api/config';
  // WP B2 part 2: POST /api/providers/:id/test (the Test button, the only outbound provider call) and
  // POST /api/providers/keys/reload (re-scan only, never accepts a key; also refuses a non-loopback peer).
  const isProvidersWriteRoute = providers.isProvidersWriteRoute(pathname);
  // App router (APP-ROUTER-DESIGN.md 6.1): POST /api/app-router (save the chain), POST
  // /api/app-router/profiles (add an extra account) and POST /api/app-router/targets/:id/test (one
  // user-clicked probe). GET /api/app-router and /status stay read-only and unlisted. All three accept
  // only the dashboard credential (checkWriteToken's default audience): an agent token gets 403.
  const isAppRouterWriteRoute = appRouter.isAppRouterWriteRoute(pathname);
  // Eigen API (ANY-MODEL-PLAN 2.2 D): POST /api/providers/custom adds an entry; PATCH and DELETE are scoped to
  // the item path only (providersCustom.CUSTOM_ITEM_RE). Dashboard credential only, loopback peer only.
  const isCustomProviderWriteRoute = providersCustom.isCustomWriteRoute(pathname);
  const isCustomProviderItemRoute = providersCustom.isCustomItemRoute(pathname);
  const isWriteRoute = isConversationWriteRoute || isAskWriteRoute || isPermissionWriteRoute || isDiscordWriteRoute || isConfigWriteRoute || pathname === '/api/projects' || isProvidersWriteRoute || isAppRouterWriteRoute || isCustomProviderWriteRoute;
  const isConversationDeleteRoute = CONV_ITEM_RE.test(pathname);
  // feat-agent-model-edit: the one PATCH route this gateway accepts at all, scoped exactly to
  // AGENT_MODEL_RE (same "one specific route, never the whole method" shape as the DELETE guard
  // above for conversations).
  const isAgentModelPatchRoute = AGENT_MODEL_RE.test(pathname);
  // WP B3-conv: rename a conversation - PATCH scoped to CONV_ITEM_RE only.
  const isConversationRenameRoute = CONV_ITEM_RE.test(pathname);
  if (
    req.method !== 'GET' &&
    !(req.method === 'POST' && isWriteRoute) &&
    !(req.method === 'DELETE' && (isConversationDeleteRoute || isCustomProviderItemRoute)) &&
    !(req.method === 'PATCH' && (isAgentModelPatchRoute || isConversationRenameRoute || isCustomProviderItemRoute))
  ) {
    if (pathname.startsWith('/api/')) return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    res.writeHead(405, STATIC_SECURITY_HEADERS); return res.end('method not allowed');
  }

  // N6 fix (2026-09-26 laptop re-audit): the exec token is checked EXACTLY ONCE, here, for
  // every non-GET request, before any route-specific logic runs (body parsing, project lookup,
  // conversation-existence checks). This replaced the old per-route execTokenOk() calls — four
  // write routes (POST /api/conversations, POST /api/projects, POST .../stop, POST .../attachments)
  // never got one. It also removed the previous 'plan'-mode exemption on
  // POST .../messages: every non-GET request persists something. GET (including the two SSE-stream
  // GET routes) is unaffected — reads never required the token and still don't.
  // WP B3-sec-impl (Security Boss Step 1a): still checked EXACTLY ONCE for every non-GET request,
  // but by audience. POST /api/permissions/request and /:id/wait accept ONLY a conversation's agent
  // token; POST /api/ask accepts the agent token or the dashboard token; every other write route
  // accepts ONLY the dashboard token. The wrong KIND of token gets a 403 with its own `code`.
  // FU-STEP2 (Step 2): the dashboard credential is the out-of-band UI session cookie (or the
  // in-process header token, held only by the gateway's own tests); no credential on a dashboard
  // route gets 403 `ui_session_required`.
  if (req.method !== 'GET') {
    const refused = permissions.checkWriteToken(req, pathname);
    if (refused) return sendJson(res, refused.status, refused.body);
  }

  const stream = findRoute(STREAM_ROUTES, req.method, pathname);
  if (stream) {
    stream.route.handle(req, res, { pathname, searchParams: parsed.searchParams, match: stream.match }).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error: ' + (err && err.message ? err.message : String(err)) });
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.searchParams).catch((err) => {
      sendJson(res, 500, { ok: false, error: 'internal error: ' + (err && err.message ? err.message : String(err)) });
    });
    return;
  }

  // FU-STEP2: the browser pairing link (forge-cc-launch prints it). GET on exactly `/` only.
  if (req.method === 'GET' && pathname === '/' && parsed.searchParams.has('pair')) {
    const pairing = servePairing(parsed.searchParams.get('pair'));
    res.writeHead(pairing.status, pairing.headers);
    return res.end(pairing.body);
  }

  const staticResult = serveStatic(pathname);
  if (!staticResult) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...STATIC_SECURITY_HEADERS });
    return res.end('Forge Command Center gateway is running, but dashboard/dist has not been built yet.\nRun: npm run build (inside command-center/dashboard)\n');
  }
  res.writeHead(staticResult.status, staticResult.headers);
  res.end(staticResult.body);
}

export function createServer() {
  return http.createServer(requestListener);
}
