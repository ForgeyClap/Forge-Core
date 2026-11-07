// Permission prompt routes (WP B3, plan 4.4). One module per route family, in the A11 shape:
// `MODULE`, the path regexes, and handlers taking `(req, res, ctx)`. Registered in server.mjs by
// the Lead from _scratch/b3/patches-gw.md (this lane never edits server.mjs); REGISTERED_ROUTES
// below is the exact list the patch registers.
//
//   POST /api/permissions/request           ask-mcp.mjs registers one request   (AGENT token only)
//   POST /api/permissions/:id/wait          ask-mcp.mjs long-polls the decision (AGENT token only)
//   GET  /api/permissions/pending           the dashboard lists open requests (+ groups)
//   POST /api/permissions/:id/answer        the dashboard answers: allow | allow_session | deny
//                                           (DASHBOARD token only)
//
// NOT registered in this release (Security Boss decision, docs/forge-systeem/B3-permissions-
// security-decision.md, Step 2 waits for the owner): GET/POST /api/permissions/trust. Their handlers
// (trustGet / trustPost) stay here, tested on their own, for that later step.
//
// WP B3-sec-impl (Security Boss Step 1a): two kinds of token travel in the same x-cc-exec-token
// header. The DASHBOARD token (security.mjs getExecToken) and the AGENT token (security.mjs
// issueAgentToken, one per conversation, only in the `claude` child's environment for the forge-ask
// MCP server). FU-STEP2 (Step 2): the dashboard itself now authenticates with the out-of-band UI
// session cookie (security.mjs uiSessionOk); the header dashboard token is no longer in the served
// HTML and is held only by the gateway's in-process tests. checkWriteToken() is the once-per-request check
// requestListener runs for every non-GET request; it decides by route which kind is accepted, so a
// process the agent starts can register and wait for its own cards but never answer them. request
// and wait also check the token themselves and take the conversation from it.
//
// Live updates need no separate stream: every request/answer is also a conversation event
// (permission_requested / permission_answered / ...), so GET /api/conversations/:id/stream carries
// them to the dashboard already.
import { safeIdOk, safeConvIdOk, execTokenOk, agentTokenConversation, uiSessionOk, cookieSiteOk, EXEC_TOKEN_HEADER } from '../security.mjs';
import { validateSchema } from '../body.mjs';
import { conversationExists } from '../conversations.mjs';
import {
  createPermissionRequest,
  waitForDecision,
  answerPermission,
  listPendingPermissions,
  groupPendingPermissions,
} from '../permissions/store.mjs';
import { isProjectTrusted, setProjectTrusted, TRUST_FILE_INSIDE_PROJECT } from '../permissions/trust.mjs';
import { sendJson, readBodyOrRespond, projectOrRespond } from './http.mjs';
import { ASK_RE } from './ask.mjs';

export const MODULE = 'permissions';

export const PERMISSION_REQUEST_PATH = '/api/permissions/request';
export const PERMISSION_PENDING_PATH = '/api/permissions/pending';
export const PERMISSION_TRUST_PATH = '/api/permissions/trust';
export const PERMISSION_WAIT_RE = /^\/api\/permissions\/([^/]+)\/wait$/;
export const PERMISSION_ANSWER_RE = /^\/api\/permissions\/([^/]+)\/answer$/;

/** The rows the server registers, in this order: [method, path, handler]. The trust handlers are
 *  deliberately absent (see the header). _scratch/b3/patches-gw.md mirrors exactly this list. */
export const REGISTERED_ROUTES = Object.freeze([
  Object.freeze(['POST', PERMISSION_REQUEST_PATH, 'request']),
  Object.freeze(['GET', PERMISSION_PENDING_PATH, 'pending']),
  Object.freeze(['POST', PERMISSION_WAIT_RE, 'wait']),
  Object.freeze(['POST', PERMISSION_ANSWER_RE, 'answer']),
]);

/** The registered POST paths of this family, for requestListener's write-route allowlist. The trust
 *  path is not one of them in this release. */
export function isPermissionWriteRoute(pathname) {
  return pathname === PERMISSION_REQUEST_PATH
    || PERMISSION_WAIT_RE.test(pathname)
    || PERMISSION_ANSWER_RE.test(pathname);
}

// Error codes of a refused token (403).
// FU-STEP2 (Security Boss Step 2): a dashboard route with no valid credential now answers with its own
// code, `ui_session_required`, so the dashboard can show its pairing card ("Koppel dit venster
// opnieuw"); until then this body had no code. A cookie request that fails cookieSiteOk() (same-site,
// no allowed Origin) gets `cross_site_cookie_refused`.
export const TOKEN_ERROR_CODES = Object.freeze({
  AGENT_TOKEN_REFUSED: 'agent_token_refused',
  DASHBOARD_TOKEN_REFUSED: 'dashboard_token_refused',
  AGENT_TOKEN_REQUIRED: 'agent_token_required',
  CONVERSATION_MISMATCH: 'agent_token_conversation_mismatch',
  UI_SESSION_REQUIRED: 'ui_session_required',
  CROSS_SITE_COOKIE_REFUSED: 'cross_site_cookie_refused',
});
const UI_SESSION_REQUIRED_ERROR = 'missing or invalid session cookie or execution token (' + EXEC_TOKEN_HEADER
  + ' header): this window is not paired with Forge; open a new pairing link from the launcher';

/**
 * Which token a non-GET request to `pathname` must carry:
 *   'agent'              POST /api/permissions/request and /:id/wait (the forge-ask MCP server);
 *   'agent_or_dashboard' POST /api/ask: the forge-ask server's ask_owner tool uses the same token
 *                        mechanism, so it accepts the agent token; the dashboard token stays
 *                        accepted there for now (existing callers and tests), see patches-gw.md;
 *   'dashboard'          every other write route.
 */
export function writeTokenAudience(pathname) {
  if (pathname === PERMISSION_REQUEST_PATH || PERMISSION_WAIT_RE.test(pathname)) return 'agent';
  if (ASK_RE.test(pathname)) return 'agent_or_dashboard';
  return 'dashboard';
}

function refusal(code, error) {
  return { status: 403, body: { ok: false, error, code } };
}

/** null when the request carries an agent token, otherwise the 403 to send. */
function agentTokenRefusal(req) {
  if (agentTokenConversation(req)) return null;
  if (execTokenOk(req)) return refusal(TOKEN_ERROR_CODES.DASHBOARD_TOKEN_REFUSED, 'this route only accepts the forge-ask agent token, never the dashboard token');
  return refusal(TOKEN_ERROR_CODES.AGENT_TOKEN_REQUIRED, 'missing or invalid agent token (' + EXEC_TOKEN_HEADER + ' header)');
}

/** null when the request carries a dashboard credential (or, with allowAgent, an agent token),
 *  otherwise the 403 to send.
 *  Dashboard credentials (FU-STEP2): the UI session cookie (security.mjs uiSessionOk, delivered out of
 *  band by the desktop app or a one-time pairing link), or the in-process header token (only the
 *  gateway's own route tests hold it; it is no longer in the served HTML). */
function dashboardTokenRefusal(req, { allowAgent = false } = {}) {
  if (execTokenOk(req)) return null;
  if (uiSessionOk(req)) {
    if (cookieSiteOk(req)) return null;
    return refusal(TOKEN_ERROR_CODES.CROSS_SITE_COOKIE_REFUSED, 'a same-site request with the session cookie must come from an allowed Origin');
  }
  const agentConv = agentTokenConversation(req);
  if (agentConv && allowAgent) return null;
  if (agentConv) return refusal(TOKEN_ERROR_CODES.AGENT_TOKEN_REFUSED, 'this route only accepts the dashboard token; the agent token is refused');
  return refusal(TOKEN_ERROR_CODES.UI_SESSION_REQUIRED, UI_SESSION_REQUIRED_ERROR);
}

/**
 * The once-per-request token check for every non-GET request (requestListener calls it in place of
 * the old `!execTokenOk(req)`). Returns null when the request may go on, or `{ status, body }` to
 * send. A dashboard route with no or a wrong token gets the old body unchanged.
 */
export function checkWriteToken(req, pathname) {
  const audience = writeTokenAudience(pathname);
  if (audience === 'agent') return agentTokenRefusal(req);
  return dashboardTokenRefusal(req, { allowAgent: audience === 'agent_or_dashboard' });
}

/** The conversation of the request's agent token, or null after answering 403 (defence in depth:
 *  request and wait never rely on the server-level check alone). */
function agentConversationOrRespond(req, res) {
  const refused = agentTokenRefusal(req);
  if (!refused) return agentTokenConversation(req);
  sendJson(res, refused.status, refused.body);
  return null;
}

const MAX_WAIT_MS = 30000;
const DEFAULT_WAIT_MS = 25000;
const MAX_TOOL_USE_ID = 200;

function idFromMatch(match) {
  try {
    const id = decodeURIComponent(match[1]);
    return safeIdOk(id) ? id : null;
  } catch {
    return null;
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function request(req, res) {
  const tokenConv = agentConversationOrRespond(req, res);
  if (!tokenConv) return undefined;
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['conv_id', 'turn_id', 'request_id', 'tool_name', 'input', 'tool_use_id'], ['conv_id', 'tool_name', 'input']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (body.conv_id !== tokenConv) {
    return sendJson(res, 403, { ok: false, error: 'this agent token belongs to another conversation', code: TOKEN_ERROR_CODES.CONVERSATION_MISMATCH });
  }
  if (typeof body.conv_id !== 'string' || !safeConvIdOk(body.conv_id) || !conversationExists(body.conv_id)) {
    return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  }
  if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) {
    return sendJson(res, 400, { ok: false, error: 'input must be a JSON object' });
  }
  const toolUseId = optionalString(body.tool_use_id);
  if (toolUseId && toolUseId.length > MAX_TOOL_USE_ID) return sendJson(res, 400, { ok: false, error: 'tool_use_id is too long' });
  const created = createPermissionRequest({
    convId: body.conv_id,
    turnId: optionalString(body.turn_id),
    requestId: optionalString(body.request_id),
    toolName: body.tool_name,
    input: body.input,
    toolUseId,
  });
  if (!created.ok) return sendJson(res, 400, { ok: false, error: created.error });
  return sendJson(res, 200, created.decision ? { ok: true, id: created.id, decision: created.decision } : { ok: true, id: created.id });
}

// Long-poll: answers within `wait_ms` (max 30 s) with `{ decided:false }` when nobody answered yet;
// the MCP client then simply asks again. There is no answer timeout anywhere. A request of another
// conversation than the token's is answered exactly like an unknown id (404).
export async function wait(req, res, { match }) {
  const tokenConv = agentConversationOrRespond(req, res);
  if (!tokenConv) return undefined;
  const id = idFromMatch(match);
  if (!id) return sendJson(res, 400, { ok: false, error: 'invalid permission id' });
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['wait_ms'], []);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  const asked = Number(body.wait_ms);
  const waitMs = Number.isFinite(asked) && asked >= 0 ? Math.min(asked, MAX_WAIT_MS) : DEFAULT_WAIT_MS;
  const decision = await waitForDecision(id, waitMs, { convId: tokenConv });
  if (res.destroyed) return undefined; // the MCP client went away mid-poll; nothing to answer
  if (decision.unknown) return sendJson(res, 404, { ok: false, error: 'unknown or expired permission request' });
  return sendJson(res, 200, { ok: true, ...decision });
}

export async function pending(req, res, { searchParams }) {
  const conversation = searchParams.get('conversation');
  if (conversation !== null && !safeConvIdOk(conversation)) return sendJson(res, 400, { ok: false, error: 'invalid conversation id' });
  const list = listPendingPermissions({ convId: conversation || undefined });
  return sendJson(res, 200, { ok: true, pending: list, groups: groupPendingPermissions(list) });
}

export async function answer(req, res, { match }) {
  const refused = dashboardTokenRefusal(req);
  if (refused) return sendJson(res, refused.status, refused.body);
  const id = idFromMatch(match);
  if (!id) return sendJson(res, 400, { ok: false, error: 'invalid permission id' });
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['behavior'], ['behavior']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  const result = answerPermission(id, body.behavior);
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  return sendJson(res, 200, { ok: true, id, behavior: result.behavior, remembered: result.remembered });
}

// NOT registered in this release (see the header). Kept for Security Boss Step 2.
export async function trustGet(req, res, { searchParams }) {
  const entry = await projectOrRespond(res, searchParams.get('project') || '');
  if (!entry) return undefined;
  return sendJson(res, 200, { ok: true, project: entry.name, trusted: isProjectTrusted(entry.path) });
}

// NOT registered in this release (see the header). Kept for Security Boss Step 2.
export async function trustPost(req, res) {
  const refused = dashboardTokenRefusal(req);
  if (refused) return sendJson(res, refused.status, refused.body);
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['project', 'trusted'], ['project', 'trusted']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (typeof body.trusted !== 'boolean') return sendJson(res, 400, { ok: false, error: 'trusted must be true or false' });
  if (typeof body.project !== 'string') return sendJson(res, 400, { ok: false, error: 'project must be a string' });
  const entry = await projectOrRespond(res, body.project);
  if (!entry) return undefined;
  try {
    setProjectTrusted(entry.path, body.trusted, { source: 'dashboard' });
  } catch (err) {
    if (err && err.code === TRUST_FILE_INSIDE_PROJECT) {
      return sendJson(res, 409, { ok: false, error: err.message, code: err.code });
    }
    return sendJson(res, 500, { ok: false, error: 'could not save the trust setting: ' + (err && err.message ? err.message : String(err)) });
  }
  return sendJson(res, 200, { ok: true, project: entry.name, trusted: isProjectTrusted(entry.path) });
}
