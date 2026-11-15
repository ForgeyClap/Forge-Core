// Remote Bridge phone routes (/remote/v1/*). Narrow on purpose: status, inbox, answer a pending ask,
// owner acts on scribe items (sent as prompts), start a turn, read conversations, list and answer
// the permission cards that wait (WP-AUTONOMY-GW: allow or deny once, only with confirm). Writes go through
// the dashboard's own handlers (ask answer, conversation send) so the phone never gets a second path.
// Every handler returns { status, body, headers?, audit? }; bridge-server.mjs writes the response.
import { Readable } from 'node:stream';
import { safeConvIdOk, safeIdOk } from '../security.mjs';
import { buildHealth } from '../health.mjs';
import { buildActiveRuns } from '../active-runs.mjs';
import { listProjects } from '../projects.mjs';
import { listPendingAskSummaries, getAskMeta } from '../ask-store.mjs';
import { listConversations, readConversation, createConversation, conversationExists, deleteConversation } from '../conversations.mjs';
import { readSyncLock } from '../sync-lock.mjs';
import { resolveProjectByName } from '../routes/http.mjs';
import * as askRoutes from '../routes/ask.mjs';
import * as conversationRoutes from '../routes/conversations.mjs';
import { publicScribeItem, hasScribe, STORE_OUTSIDE_PROJECT } from './scribe.mjs';
import { askDashboardOnly } from './ask-gate.mjs';
import { isTurnBusy } from '../app-router/turn-router.mjs';
import { listPendingPermissions, answerPermission, setTurnFromLanPhone } from '../permissions/store.mjs';
import { effectiveAutonomy } from '../permissions/autonomy.mjs';

export const MAX_TEXT = 8000;
const MAX_NOTE = 2000;
const PHONE_MODES = ['execute', 'plan']; // never bypass/accept-edits from the phone
const RID_RE = /^R-\d{1,6}$/;
const MAX_SCRIBE_PROJECTS = 60;
const SCRIBE_WORKERS = 4; // per request; scribe.mjs also caps processes at 4 across all requests
// The phone never gets the gateway's own registry text (it can name folders or tools).
const REGISTRY_ERROR_TEXT = 'the project list on the PC could not be read; try again in a moment';

/** Phone writes: Tailscale (WireGuard-encrypted) always; LAN (cleartext) only when the owner allowed it. */
export function writesAllowed(ctx) {
  return ctx.mode === 'tailscale' || (ctx.mode === 'lan' && ctx.allowLanWrites === true);
}

const err = (status, code, error, extra) => ({ status, body: { ok: false, code, error, ...(extra || {}) } });

const CODE_BY_STATUS = { 400: 'invalid_request', 404: 'not_found', 409: 'conflict', 413: 'body_too_large', 423: 'sync_locked', 429: 'rate_limited', 500: 'internal_error', 502: 'registry_error' };

/**
 * Runs one of the gateway's own route handlers with an in-memory request carrying `body` and a
 * response that records what the handler wrote. The handler does all its own checks.
 */
async function invokeHandler(handler, body, routeCtx) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.headers = { 'content-type': 'application/json' };
  req.method = 'POST';
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const res = {
    statusCode: 200, headers: {}, headersSent: false, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); this.headersSent = true; return this; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); finish(); },
  };
  await handler(req, res, routeCtx);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* every gateway handler answers JSON */ }
  const retryAfter = res.headers['Retry-After'] || res.headers['retry-after'];
  return { status: res.statusCode, json: json || {}, retryAfter };
}

/**
 * A gateway handler's answer with a machine `code` added. Gateway-internal detail never reaches the
 * phone: a 502 gets the one generic registry sentence, and `matches` (the absolute paths of projects
 * that share a name) is dropped.
 */
export function passThrough(r, codeOverride) {
  let body = r.json;
  if (r.json.ok === false) {
    body = { ...r.json, code: r.json.code || codeOverride || CODE_BY_STATUS[r.status] || 'error' };
    delete body.matches;
    if (r.status === 502) body.error = REGISTRY_ERROR_TEXT;
  }
  return { status: r.status, body, headers: r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : undefined };
}

async function projectOrError(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 300) return { error: err(400, 'invalid_request', 'project must be a non-empty string') };
  const r = await resolveProjectByName(name);
  if (r.registryError) return { error: err(502, 'registry_error', REGISTRY_ERROR_TEXT) };
  if (r.ambiguous) return { error: err(409, 'ambiguous_project', 'two or more projects have this name', { matches: r.matches.map((m) => m.name) }) };
  if (!r.entry) return { error: err(404, 'unknown_project', 'unknown project') };
  return { entry: r.entry };
}

function textError(text, max = MAX_TEXT) {
  if (typeof text !== 'string' || text.trim().length === 0) return 'text must be a non-empty string';
  if ([...text].length > max) return 'text is longer than ' + max + ' characters';
  if (text.startsWith('-')) return 'text cannot start with "-"';
  return null;
}

/**
 * Start a turn in `conversationId` (or a new conversation of `entry`) through the dashboard's own
 * POST /api/conversations/:id/messages handler. `title` names a new conversation (else it comes from
 * the first message). Returns a handler result.
 */
async function startTurn(entry, conversationId, text, mode, title, ctx) {
  let convId = conversationId;
  let created = false;
  if (convId !== undefined && convId !== null) {
    if (typeof convId !== 'string' || !safeConvIdOk(convId) || !conversationExists(convId)) return err(404, 'conversation_not_found', 'conversation not found');
    const conv = readConversation(convId);
    if (!conv.ok || !conv.meta || conv.meta.project !== entry.name) return err(404, 'conversation_not_found', 'conversation not found in this project');
  } else {
    // refuse before creating anything, so a refused send leaves no empty conversation behind
    if (readSyncLock(entry.path).locked) return err(423, 'sync_locked', 'Forge is being updated in this project; try again in a minute');
    convId = createConversation({ project: entry.name, title }).id;
    created = true;
  }
  const sendBody = mode ? { text, mode } : { text };
  // F8: over a LAN bridge (cleartext) the turn gets no autonomy: every permission card waits for the owner
  const r = await invokeHandler(conversationRoutes.sendMessage, sendBody, { match: [null, convId], fromLanPhone: Boolean(ctx && ctx.mode === 'lan') });
  if (r.status !== 202) {
    if (created) deleteConversation(convId);
    return passThrough(r, r.status === 409 ? 'busy' : undefined);
  }
  return {
    status: 202,
    body: {
      ok: true, conversation_id: convId, conversation_created: created, turn_id: r.json.turn_id, request_id: r.json.request_id,
      execution_started: r.json.execution_started, ...(r.json.execution_started ? {} : { reason: r.json.reason, code: r.json.code }),
    },
  };
}

// ---------------------------------------------------------------- inbox

function pendingAsks() {
  const out = [];
  for (const a of listPendingAskSummaries()) {
    const meta = getAskMeta(a.id);
    if (!meta || meta.status !== 'pending') continue;
    const conv = readConversation(a.convId);
    const firstUser = conv.ok ? conv.turns.find((t) => t.role === 'user' && typeof t.text === 'string' && t.text.length > 0) : null;
    const gate = askDashboardOnly({ convId: a.convId, turnId: a.turnId, questions: meta.questions });
    out.push({
      id: a.id,
      project: conv.ok && conv.meta ? conv.meta.project : null,
      conversation_id: a.convId,
      conversation_first_message: firstUser ? firstUser.text.slice(0, 300) : null,
      turn_id: a.turnId,
      questions: meta.questions,
      dashboard_only: gate.dashboardOnly,
      dashboard_only_reason: gate.reason,
    });
  }
  return out;
}

/**
 * One project's scribe list, shared: a run still in flight is joined (never a second process for the
 * same project), and a finished one is reused for scribeCacheMs, so status + inbox polling does not
 * spawn one process per project per call.
 */
export function cachedScribe(ctx, project) {
  const hit = ctx.scribeCache.get(project.path);
  if (hit && (hit.pending || Date.now() - hit.at < ctx.limits.scribeCacheMs())) return hit.promise;
  const slot = { at: Date.now(), pending: true, promise: null };
  slot.promise = Promise.resolve()
    .then(() => ctx.scribeRunner(project))
    .catch(() => ({ available: true, items: [], error: 'scribe list failed' }))
    .then((result) => { slot.pending = false; slot.at = Date.now(); return result; });
  ctx.scribeCache.set(project.path, slot);
  return slot.promise;
}

/** Scribe items of every registered project that has a scribe: { entries, truncated }. */
async function scribeInbox(ctx) {
  const registry = await listProjects();
  if (!registry.ok) return { entries: [], truncated: false };
  const all = registry.projects.filter((p) => hasScribe(p.path));
  const projects = all.slice(0, MAX_SCRIBE_PROJECTS);
  const entries = new Array(projects.length);
  let next = 0;
  async function worker() {
    while (next < projects.length) {
      const i = next++;
      const p = projects[i];
      const r = await cachedScribe(ctx, { name: p.name, path: p.path });
      entries[i] = { project: p.name, available: r.available === true, error: r.error || null, items: (r.items || []).map(publicScribeItem) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCRIBE_WORKERS, projects.length) }, worker));
  return { entries: entries.filter((e) => e.available), truncated: all.length > projects.length };
}

function inboxCount(asks, scribe) {
  return asks.length + scribe.entries.reduce((n, s) => n + s.items.filter((i) => i.actions.length > 0).length, 0);
}

/**
 * Read-only view of the tool-permission requests the gateway holds (the dashboard answers them; the
 * phone never can): pending requests per project name, and the running conversations with whether
 * their turn waits on one. A request of a conversation the store does not know counts for no project.
 */
function permissionWaits() {
  const convs = listConversations();
  const projectOf = new Map(convs.map((c) => [c.id, c.project]));
  const perConv = new Map();
  for (const r of listPendingPermissions()) perConv.set(r.conversation_id, (perConv.get(r.conversation_id) || 0) + 1);
  const perProject = new Map();
  for (const [convId, n] of perConv) {
    const project = projectOf.get(convId);
    if (project) perProject.set(project, (perProject.get(project) || 0) + n);
  }
  const running = convs.filter((c) => isTurnBusy(c.id))
    .map((c) => ({ conversation_id: c.id, project: c.project, waiting_permission: perConv.has(c.id) }));
  return { perProject, running };
}

// ---------------------------------------------------------------- handlers

function pairLockedOut(r) {
  return { ...err(429, 'locked_out', 'too many wrong codes; try again later'), headers: { 'Retry-After': String(r.retryAfterS) }, audit: { action: 'locked_out', detail: { path: '/remote/v1/pair' } } };
}

/** A malformed pair body counts as a wrong code (lockout) and is audited as a refused request. */
function pairInvalid(ctx, ip, message) {
  const r = ctx.pairing.refuse(ip);
  if (r.code === 'locked_out') return pairLockedOut(r);
  return { ...err(400, 'invalid_request', message), audit: { action: 'pair_invalid' } };
}

async function pair({ body, ip, ctx }) {
  const name = typeof body.device_name === 'string' ? body.device_name.trim() : '';
  if (name.length === 0 || [...name].length > 60 || /[\u0000-\u001f\u007f]/.test(name)) return pairInvalid(ctx, ip, 'device_name must be 1-60 printable characters');
  if (typeof body.code !== 'string' || body.code.length > 40) return pairInvalid(ctx, ip, 'code must be a string');
  const r = ctx.pairing.consume(body.code, ip);
  if (!r.ok && r.code === 'locked_out') return pairLockedOut(r);
  if (!r.ok) return { ...err(401, 'pairing_failed', 'wrong, used or expired pairing code'), audit: { action: 'pair_failed' } };
  const { token, device } = ctx.devices.add(name);
  return { status: 201, body: { ok: true, token, device: { id: device.id, name: device.name, created_at: device.created_at } }, audit: { action: 'pair_ok', device_id: device.id, device_name: device.name } };
}

/** Only the PC's Tailscale address and how many tailnet devices are online: no account, no peer names. */
async function phoneTailscale(ctx) {
  if (typeof ctx.tailscaleHealth !== 'function') return { pc_ip: null, peers_online: null };
  try {
    const h = await ctx.tailscaleHealth();
    return { pc_ip: h && typeof h.pc_ip === 'string' ? h.pc_ip : null, peers_online: h && Number.isInteger(h.peers_online) ? h.peers_online : null };
  } catch { return { pc_ip: null, peers_online: null }; }
}

async function status({ device, ctx }) {
  const [health, runs, registry, scribe, tailscale] = await Promise.all([
    buildHealth(Date.now() - Math.round(process.uptime() * 1000)),
    buildActiveRuns(),
    listProjects(),
    scribeInbox(ctx),
    phoneTailscale(ctx),
  ]);
  const waits = permissionWaits();
  return {
    status: 200,
    body: {
      ok: true,
      device: { id: device.id, name: device.name },
      bridge_mode: ctx.mode,
      writes_allowed: writesAllowed(ctx),
      tailscale,
      gateway: {
        ok: health.ok, version: health.gateway.version, uptime_s: health.gateway.uptime_s,
        runtime_state: health.runtime ? health.runtime.state : null, turns_running: health.turns_running,
        execution_available: !!(health.execution && health.execution.available),
      },
      projects: registry.ok ? registry.projects.map((p) => ({ name: p.name, waiting_permission: waits.perProject.get(p.name) || 0 })) : [],
      running: waits.running,
      active_runs: (runs.active_runs || []).map((r) => ({ project: r.project, run_id: r.run_id, title: r.title, started_at: r.started_at, last_work_at: r.last_work_at, open_dispatches: r.open_dispatches })),
      inbox_count: inboxCount(pendingAsks(), scribe),
      captured_at: new Date().toISOString(),
    },
  };
}

async function inbox({ ctx }) {
  const asks = pendingAsks();
  const scribe = await scribeInbox(ctx);
  return { status: 200, body: { ok: true, asks, scribe: scribe.entries, scribe_truncated: scribe.truncated, captured_at: new Date().toISOString() } };
}

async function answerAsk({ body, match, ctx }) {
  let id;
  try { id = decodeURIComponent(match[1]); } catch { return err(400, 'invalid_request', 'invalid ask id'); }
  if (!safeIdOk(id)) return err(400, 'invalid_request', 'invalid ask id');
  const meta = getAskMeta(id);
  if (meta && meta.status === 'pending') {
    const gate = askDashboardOnly(meta);
    if (gate.dashboardOnly) {
      return {
        ...err(403, 'dashboard_only', 'this question can only be answered in the dashboard on the PC', { reason: gate.reason }),
        audit: { action: 'ask_answer_refused', detail: { ask_id: id, reason: gate.reason } },
      };
    }
    // M1 (rv-autonomy-sec-2): a LAN answer is free text from a cleartext link that the running turn acts
    // on, so that conversation loses autonomy (marked before the answer reaches the turn)
    if (ctx && ctx.mode === 'lan' && typeof meta.convId === 'string') setTurnFromLanPhone(meta.convId, true);
  }
  const r = await invokeHandler(askRoutes.answer, body, { match: [null, id] });
  const result = passThrough(r);
  result.audit = { action: 'ask_answered', detail: { ask_id: id, answers: Array.isArray(body.answers) ? body.answers.length : 0, ok: r.status === 200 } };
  return result;
}

async function prompt({ body, ctx }) {
  const textErr = textError(body.text);
  if (textErr) return err(400, 'invalid_request', textErr);
  if (body.mode !== undefined && !PHONE_MODES.includes(body.mode)) return err(400, 'invalid_request', 'mode must be one of: ' + PHONE_MODES.join(', '));
  const p = await projectOrError(body.project);
  if (p.error) return p.error;
  const result = await startTurn(p.entry, body.conversation_id, body.text, body.mode, undefined, ctx);
  result.audit = { action: 'prompt_sent', detail: { project: p.entry.name, chars: [...body.text].length, ok: result.status === 202, conversation_id: result.body.conversation_id || null } };
  return result;
}

function scribeAct(kind) {
  return async ({ body, match, ctx }) => {
    let projectName; let rid;
    try { projectName = decodeURIComponent(match[1]); rid = decodeURIComponent(match[2]); } catch { return err(400, 'invalid_request', 'bad path'); }
    if (!RID_RE.test(rid)) return err(400, 'invalid_request', 'rid must look like R-0018');
    let text;
    if (kind === 'ack') {
      if (body.note !== undefined && (typeof body.note !== 'string' || [...body.note].length > MAX_NOTE)) return err(400, 'invalid_request', 'note must be a string of at most ' + MAX_NOTE + ' characters');
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      // "akkoord" is what the scribe classifier reads as an ack; "ack R-n" was refused (WP-ACK-PROOF).
      // The note stays on its own line: it only blocks the ack when it names the item itself.
      text = 'akkoord ' + rid + (note ? '\n' + note : '');
    } else {
      // no owner-authority "answer" act exists in the scribe: this framing never acks or cancels the item
      // (test/remote-scribe-owner-text.test.mjs runs it through the real scribe)
      const textErr = textError(body.text);
      if (textErr) return err(400, 'invalid_request', textErr);
      text = 'answer ' + rid + ': ' + body.text.trim();
    }
    const p = await projectOrError(projectName);
    if (p.error) return p.error;
    const list = await ctx.scribeRunner({ name: p.entry.name, path: p.entry.path });
    if (!list.available) {
      return err(409, 'scribe_unavailable', list.reason === STORE_OUTSIDE_PROJECT
        ? 'the scribe folder of this project points outside the project; open it on the PC'
        : 'this project has no Forge scribe');
    }
    if (list.error) return err(409, 'scribe_unavailable', list.error);
    const item = (list.items || []).find((i) => i.rid === rid);
    if (!item) return err(404, 'unknown_item', 'no open scribe item ' + rid + ' in this project');
    const allowed = kind === 'ack' ? ['done', 'defer-proposed'] : ['unclassified', 'open'];
    if (!allowed.includes(item.status)) return err(409, 'wrong_status', rid + ' is ' + item.status + '; ' + kind + ' needs ' + allowed.join(' or '));
    // a clear title so the owner finds a phone act in Gesprekken (Dutch: the owner's UI language)
    const title = ('Telefoon: ' + (kind === 'ack' ? 'akkoord ' : 'antwoord ') + rid + ' · ' + p.entry.name).slice(0, 120);
    const result = await startTurn(p.entry, body.conversation_id, text, undefined, title, ctx);
    ctx.scribeCache.delete(p.entry.path);
    if (result.status === 202) Object.assign(result.body, { queued_as_prompt: true, scribe_applied: false, project: p.entry.name, rid });
    result.audit = { action: kind === 'ack' ? 'scribe_ack_queued' : 'scribe_answer_queued', detail: { project: p.entry.name, rid, ok: result.status === 202 } };
    return result;
  };
}

// ---------------------------------------------------------------- permission cards (contract section 6)

// a card proved safe (code 'routine') waits only when autonomy is off for its project, or when its
// conversation was fed from a phone over LAN (F8, M1)
const NOT_HARD_GATE_NL = 'Veilige routinestap. Hij wacht omdat zelfstandig werken uit staat voor dit project, of omdat het gesprek via LAN vanaf de telefoon kwam';

async function permissionsList({ ctx }) {
  const registry = await listProjects();
  const lan = ctx.mode === 'lan';
  const items = listPendingPermissions().map((r) => ({
    id: r.id,
    project: r.project || null,
    conversation_id: r.conversation_id,
    tool_name: r.tool_name,
    summary_nl: r.summary_nl,
    // L3: over LAN (cleartext) the command text of a hard-gate card is not sent; it is answered on the PC only
    command_preview: lan && r.gate && r.gate.hard ? null : r.command_preview,
    gate: r.gate && r.gate.hard ? r.gate.reason_nl : NOT_HARD_GATE_NL,
    created_at: r.created_at,
  }));
  const names = registry.ok ? registry.projects.map((p) => p.name) : [];
  return { status: 200, body: { ok: true, items, autonomy: effectiveAutonomy(names) } };
}

/** Allow or deny one card, once. confirm:true is required; allow_session never comes from the phone.
 *  F8: over a LAN bridge (cleartext, a token can be sniffed) a hard-gate card is dashboard-only (403). */
async function permissionAnswer({ body, match, ctx }) {
  let id;
  try { id = decodeURIComponent(match[1]); } catch { return err(400, 'invalid_request', 'invalid permission id'); }
  if (!safeIdOk(id)) return err(400, 'invalid_request', 'invalid permission id');
  const refuse = (status, code, error) => ({ ...err(status, code, error), audit: { action: 'permission_answer_refused', detail: { permission_id: id, reason: code } } });
  if (body.behavior !== 'allow' && body.behavior !== 'deny') return refuse(400, 'invalid_request', 'behavior must be allow or deny; a rule is never remembered from the phone');
  if (body.confirm !== true) return refuse(400, 'confirm_required', 'send confirm: true once the owner confirmed this action on the phone');
  const card = listPendingPermissions().find((r) => r.id === id);
  if (card && ctx.mode === 'lan' && card.gate && card.gate.hard) {
    return refuse(403, 'dashboard_only', 'over a LAN bridge a hard-gate card can only be answered in the dashboard on the PC; use Tailscale to answer it on the phone');
  }
  const r = answerPermission(id, body.behavior);
  if (!r.ok) return refuse(r.status, r.status === 404 ? 'not_found' : r.status === 409 ? 'already_decided' : 'invalid_request', r.error);
  return {
    status: 200,
    body: { ok: true, answered: true, id, behavior: r.behavior },
    audit: { action: 'permission_answered', detail: { permission_id: id, behavior: r.behavior, tool_name: card ? card.tool_name : null, project: card ? card.project || null : null, ok: true } },
  };
}

async function conversationsList({ searchParams }) {
  const p = await projectOrError(searchParams.get('project') || '');
  if (p.error) return p.error;
  return { status: 200, body: { ok: true, conversations: listConversations().filter((c) => c.project === p.entry.name) } };
}

async function conversationRead({ match }) {
  const id = match[1];
  if (!safeConvIdOk(id)) return err(404, 'conversation_not_found', 'conversation not found');
  const conv = readConversation(id);
  if (!conv.ok) return err(404, 'conversation_not_found', 'conversation not found');
  return { status: 200, body: { ...conv, running: isTurnBusy(id) } };
}

export const PHONE_ROUTES = Object.freeze([
  { method: 'POST', path: '/remote/v1/pair', public: true, fields: ['code', 'device_name'], required: ['code', 'device_name'], handle: pair },
  { method: 'GET', path: '/remote/v1/status', handle: status },
  { method: 'GET', path: '/remote/v1/inbox', handle: inbox },
  { method: 'POST', path: /^\/remote\/v1\/asks\/([^/]+)\/answer$/, fields: ['answers'], required: ['answers'], handle: answerAsk },
  { method: 'POST', path: /^\/remote\/v1\/scribe\/([^/]+)\/([^/]+)\/ack$/, fields: ['note', 'conversation_id'], handle: scribeAct('ack') },
  { method: 'POST', path: /^\/remote\/v1\/scribe\/([^/]+)\/([^/]+)\/answer$/, fields: ['text', 'conversation_id'], required: ['text'], handle: scribeAct('answer') },
  { method: 'POST', path: '/remote/v1/prompt', fields: ['project', 'conversation_id', 'text', 'mode'], required: ['project', 'text'], handle: prompt },
  { method: 'GET', path: '/remote/v1/permissions', handle: permissionsList },
  { method: 'POST', path: /^\/remote\/v1\/permissions\/([^/]+)$/, fields: ['behavior', 'confirm'], required: ['behavior'], handle: permissionAnswer },
  { method: 'GET', path: '/remote/v1/conversations', handle: conversationsList },
  { method: 'GET', path: /^\/remote\/v1\/conversations\/([^/]+)$/, handle: conversationRead },
]);
