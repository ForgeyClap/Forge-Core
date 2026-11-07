// Conversation routes (moved verbatim out of server.mjs, WP A11 part 1): list / create, read /
// delete one conversation, send a message (starts an execution), upload an attachment, stop an
// execution and the conversation SSE stream. The gateway is the sole writer, only under .data/.
import { safeConvIdOk } from '../security.mjs';
import { validateSchema } from '../body.mjs';
import {
  listConversations,
  readConversation,
  createConversation,
  conversationExists,
  appendUserTurn,
  appendConversationEvent,
  attachConversationStream,
  deleteConversation,
} from '../conversations.mjs';
import { cleanConversationTitle, appendTitlePatch, CONVERSATION_TITLE_MAX } from '../conversation-store.mjs';
import { readConversationSession, markConversationForkedFrom } from '../sessions/gateway-sessions.mjs';
import { executionAvailability, isUnsafeExecPromptText } from '../exec-bridge.mjs';
// App router (APP-ROUTER-DESIGN.md 6.1): every turn start, busy check and stop goes through the router
// facade. With the router off (the default) startRoutedTurn calls startExecution with the identical
// arguments and returns route null, so behaviour is unchanged. isTurnBusy/stopTurn also cover a
// provider (answers-only) turn, which has no CLI child.
import { startRoutedTurn, isTurnBusy, stopTurn } from '../app-router/turn-router.mjs';
import { readRawBody, parseMultipart, storeAttachment, AttachmentTooLargeError } from '../attachments.mjs';
import { EXEC_MODE_VALUES, EXEC_EFFORT_VALUES, EXEC_MODEL_VALUES } from './exec-options.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { sendJson, readBodyOrRespond, projectOrRespond, refuseIfSyncLocked } from './http.mjs';

export const MODULE = 'conversations';

// WP4: path patterns for the conversation routes. `[^/]+` is intentionally looser than
// safeConvIdOk() — every match is re-validated against the real conv-id allowlist before it ever
// touches the filesystem (see conversations.mjs's own resolveSafe()), so a route that merely
// "looks like" a conversation path but fails the allowlist still reaches an honest 400/404, not a
// silent 404-from-no-match that could be confused with "route doesn't exist".
export const CONV_ITEM_RE = /^\/api\/conversations\/([^/]+)$/;
export const CONV_MESSAGES_RE = /^\/api\/conversations\/([^/]+)\/messages$/;
export const CONV_STOP_RE = /^\/api\/conversations\/([^/]+)\/stop$/;
export const CONV_STREAM_RE = /^\/api\/conversations\/([^/]+)\/stream$/;
// build-lastdemos T3: the composer's real "Attach" upload route.
export const CONV_ATTACHMENTS_RE = /^\/api\/conversations\/([^/]+)\/attachments$/;
// WP B3-conv: fork a conversation into a new one that continues its Claude session.
export const CONV_FORK_RE = /^\/api\/conversations\/([^/]+)\/fork$/;

// fix-conv-filter: `?project=<name>` used to be read by NO code at all — every caller got
// every conversation across every project (measured live: three different ?project= values
// returned byte-identical rows). Filtered HERE, over listConversations()'s already-built
// summary rows, rather than adding a project parameter down into listConversations()/
// summarizeConversationFileCached(): SUMMARY_CACHE (conversations.mjs) keys purely on
// absolute file path + mtimeMs/size and already computes `project` as one of its three
// cached scalars, so post-filtering the returned array adds zero extra reads and can never
// invalidate or bypass that cache. An empty/absent `?project=` keeps the pre-fix "return
// everything" behavior byte-for-byte (dashboard-wide views are unaffected); a present value is
// validated against the same registry allowlist + error shape every other `?project=` route uses
// (502 on registry failure, 409 on an ambiguous name, 404 on an unknown name).
export async function list(req, res, { searchParams }) {
  const projectName = searchParams.get('project') || '';
  let conversations = listConversations();
  if (projectName) {
    const entry = await projectOrRespond(res, projectName);
    if (!entry) return undefined;
    conversations = conversations.filter((c) => c.project === projectName);
  }
  return sendJson(res, 200, {
    ok: true,
    conversations,
    execution: executionAvailability(),
    captured_at: new Date().toISOString(),
    age_ms: 0,
    provenance: 'LIVE',
  });
}

export async function create(req, res) {
  if (!checkRateLimit('conversationCreate', res)) return undefined;
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['project', 'title'], ['project']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (typeof body.project !== 'string' || body.project.length === 0) {
    return sendJson(res, 400, { ok: false, error: 'project must be a non-empty string' });
  }
  // `title` is optional. `null` means "no title supplied" exactly like an omitted field —
  // createConversation() already normalises both to a stored `title: null` (see
  // conversations.mjs). Only a genuinely wrong type is a real validation error.
  if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'title must be a string' });
  }
  const entry = await projectOrRespond(res, body.project);
  if (!entry) return undefined;
  const conversation = createConversation({ project: body.project, title: body.title ?? undefined });
  return sendJson(res, 201, { ok: true, conversation });
}

export async function read(req, res, { match }) {
  const convId = match[1];
  if (!safeConvIdOk(convId)) return sendJson(res, 400, { ok: false, error: 'invalid conversation id' });
  const result = readConversation(convId);
  return sendJson(res, result.ok ? 200 : 404, result);
}

// feat-delete-conversation: DELETE /api/conversations/:id — a real, irreversible write. Order:
// id shape (400) -> real existence (404) -> a currently-running execution for this conversation
// (409 — never pull a file out from under a live child process/append) -> the actual delete.
// conversations.mjs's own deleteConversation() re-validates id+containment again internally
// (defense in depth); this route never builds a path itself.
export async function remove(req, res, { match }) {
  const convId = match[1];
  if (!safeConvIdOk(convId)) return sendJson(res, 400, { ok: false, error: 'invalid conversation id' });
  if (!conversationExists(convId)) return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  if (isTurnBusy(convId)) {
    return sendJson(res, 409, { ok: false, error: 'conversation has a pending execution — stop it before deleting' });
  }
  const result = deleteConversation(convId);
  if (!result.ok) return sendJson(res, result.error === 'conversation not found' ? 404 : 400, result);
  return sendJson(res, 200, { ok: true, deleted: true, id: convId });
}

/** Validates the optional mode/effort/model fields; answers 400 itself and returns null on a bad one. */
function execOptionsOrRespond(res, body) {
  // cc-fix-chat-identity / fix-exec-modes: strict allowlist — an omitted `mode` defaults to
  // 'execute', anything outside the allowlist is a real 400, never silently coerced.
  if (body.mode !== undefined && !EXEC_MODE_VALUES.includes(body.mode)) {
    sendJson(res, 400, { ok: false, error: 'mode must be one of: ' + EXEC_MODE_VALUES.join(', ') });
    return null;
  }
  const mode = EXEC_MODE_VALUES.includes(body.mode) ? body.mode : 'execute';
  // fix-exec-modes: omitted `effort` means no --effort flag is ever added (never defaulted/guessed).
  if (body.effort !== undefined && !EXEC_EFFORT_VALUES.includes(body.effort)) {
    sendJson(res, 400, { ok: false, error: 'effort must be one of: ' + EXEC_EFFORT_VALUES.join(', ') });
    return null;
  }
  const effort = EXEC_EFFORT_VALUES.includes(body.effort) ? body.effort : undefined;
  // feat-model-picker: omitted `model` means no --model flag (the CLI's own default), never guessed.
  if (body.model !== undefined && !EXEC_MODEL_VALUES.includes(body.model)) {
    sendJson(res, 400, { ok: false, error: 'model must be one of: ' + EXEC_MODEL_VALUES.join(', ') });
    return null;
  }
  const model = EXEC_MODEL_VALUES.includes(body.model) ? body.model : undefined;
  return { mode, effort, model };
}

export async function sendMessage(req, res, { match }) {
  if (!checkRateLimit('conversationMessage', res)) return undefined;
  const convId = match[1];
  if (!safeConvIdOk(convId) || !conversationExists(convId)) {
    return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  }
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['text', 'mode', 'effort', 'model'], ['text']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return sendJson(res, 400, { ok: false, error: 'text must be a non-empty string' });
  }
  // fix-sec-round #4 (LOW): body.text becomes the CLI's positional [prompt] argument right after
  // the boolean -p/--print flag (exec-bridge.mjs's buildRealArgs) — reject a leading '-' outright
  // rather than risk it being parsed as another flag.
  if (isUnsafeExecPromptText(body.text)) {
    return sendJson(res, 400, { ok: false, error: 'text cannot start with "-" (would be parsed as a CLI flag by the spawned claude process)' });
  }
  const opts = execOptionsOrRespond(res, body);
  if (!opts) return undefined;
  const { mode, effort, model } = opts;
  // every mode, including 'plan', requires the per-boot exec token — checked once
  // in requestListener. The user's turn is ALWAYS persisted to the conversation store first
  // (appendUserTurn, below) regardless of mode — itself a real write.
  // Duplicate-send protection: reject BEFORE touching the store — a second send while one
  // turn is still pending is genuinely invalid input, not a message worth persisting.
  if (isTurnBusy(convId)) {
    return sendJson(res, 409, { ok: false, error: 'conversation already has a pending execution' });
  }

  const conv = readConversation(convId);
  const projectName = conv.ok && conv.meta ? conv.meta.project : null;
  const entry = await projectOrRespond(res, projectName || '', 'conversation project no longer in the registry: ' + projectName);
  if (!entry) return undefined;
  // an execution runs `claude` inside the project (hooks, runs, edits) — refused BEFORE the user turn is stored,
  // so a 423 leaves nothing behind.
  if (refuseIfSyncLocked(res, entry)) return undefined;

  // The user's message is ALWAYS persisted first — even if execution cannot start (gateway-wide
  // capacity, missing CLI), a real user turn is never silently dropped (D2 amendment 3: "a
  // degraded but truthful product beats a fake send button").
  const { turnId, requestId } = appendUserTurn(convId, body.text, { mode, effort, model });
  // `fork` is not a send option: a pending fork lives in the session record (sessions/argv-session.mjs).
  const startResult = await startRoutedTurn({ convId, turnId, requestId, text: body.text, cwd: entry.path, mode, effort, model });
  if (!startResult.started) {
    // `code` (for example 'router_exhausted') is added only when the router gave one, so a router-off
    // refusal writes exactly the event it always wrote.
    const data = startResult.code ? { reason: startResult.reason, code: startResult.code } : { reason: startResult.reason };
    if (startResult.code === 'not_started') data.skipped = Array.isArray(startResult.skipped) ? startResult.skipped : []; // Q6: why entries were walked past
    appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'execution_not_started', data });
  }
  return sendJson(res, 202, {
    ok: true,
    turn_id: turnId,
    request_id: requestId,
    execution_started: startResult.started,
    reason: startResult.started ? undefined : startResult.reason,
    code: startResult.started ? undefined : startResult.code,
  });
}

// build-lastdemos T3: real attachment upload — a single multipart "file" field, stored under
// .data/attachments/<convId>/ (attachments.mjs). Never touches .claude/.
export async function attach(req, res, { match }) {
  const convId = match[1];
  if (!safeConvIdOk(convId) || !conversationExists(convId)) {
    return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  }
  const contentType = req.headers['content-type'] || '';
  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    return sendJson(res, err instanceof AttachmentTooLargeError ? 413 : 400, { ok: false, error: err.message });
  }
  const parsed = parseMultipart(raw, contentType);
  if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });
  const filePart = parsed.fields.find((f) => f.name === 'file' && f.fileName);
  if (!filePart) return sendJson(res, 400, { ok: false, error: 'missing multipart field "file" with a filename' });
  let stored;
  try {
    stored = storeAttachment({ convId, fileName: filePart.fileName, data: filePart.data });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: 'could not store the attachment: ' + (err && err.message ? err.message : String(err)) });
  }
  return sendJson(res, 201, {
    ok: true,
    attachment: {
      id: stored.id,
      fileName: stored.fileName,
      size: stored.size,
      isText: stored.isText,
      textPreview: stored.textPreview,
      textTruncated: stored.textTruncated,
      storedPath: stored.storedPath,
    },
  });
}

export async function stop(req, res, { match }) {
  const convId = match[1];
  if (!safeConvIdOk(convId) || !conversationExists(convId)) {
    return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  }
  const result = await stopTurn(convId);
  return sendJson(res, 200, { ok: true, stopped: result.stopped === true });
}

// GET /api/conversations/:id/stream — takes over `res` for a long-lived SSE response after the
// same access-control checks every other route gets.
export async function stream(req, res, { match }) {
  const convId = match[1];
  if (!safeConvIdOk(convId) || !conversationExists(convId)) {
    return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  }
  attachConversationStream({ req, res, convId });
  return undefined;
}

// WP B3-conv: PATCH /api/conversations/:id {title} — rename. Order: id shape (400) -> existence
// (404) -> body + title validation (400) -> one appended meta_patch line. The transcript is never
// rewritten; list/read merge the newest title (last-writer-wins), and the listing cache keys on the
// file's mtime/size, so the next list call sees the new title.
export async function rename(req, res, { match }) {
  const convId = match[1];
  if (!safeConvIdOk(convId)) return sendJson(res, 400, { ok: false, error: 'invalid conversation id' });
  if (!conversationExists(convId)) return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const schemaErr = validateSchema(read.body, ['title'], ['title']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  const cleaned = cleanConversationTitle(read.body.title);
  if (!cleaned.ok) return sendJson(res, 400, { ok: false, error: cleaned.error });
  appendTitlePatch(convId, cleaned.title);
  const conv = readConversation(convId);
  return sendJson(res, 200, { ok: true, conversation: { id: convId, project: conv.meta ? conv.meta.project : null, title: cleaned.title } });
}

const FORK_SUFFIX = ' (kopie)';

/** "<source title> (kopie)", the source part shortened so the whole stays within the title limit;
 *  null when the source has no title yet (the fork then derives one from its own first turn). */
function forkTitleFrom(sourceTitle) {
  if (typeof sourceTitle !== 'string' || sourceTitle.trim().length === 0) return null;
  const room = CONVERSATION_TITLE_MAX - [...FORK_SUFFIX].length;
  const base = [...sourceTitle.trim()].slice(0, room).join('').trim();
  return base + FORK_SUFFIX;
}

// WP B3-conv: POST /api/conversations/:id/fork [{title}] — a NEW conversation in the same project
// whose session record carries the source's sessionId with pendingFork = true, so its first turn runs
// `--resume <sessionId> --fork-session` (sessions/argv-session.mjs). The transcript bytes are never
// copied: the CLI forks the session itself. 409 `no_session` when the source never ran a turn.
export async function fork(req, res, { match }) {
  if (!checkRateLimit('conversationCreate', res)) return undefined;
  const sourceId = match[1];
  if (!safeConvIdOk(sourceId)) return sendJson(res, 400, { ok: false, error: 'invalid conversation id' });
  if (!conversationExists(sourceId)) return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const schemaErr = validateSchema(read.body, ['title']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  let bodyTitle = null;
  if (read.body.title !== undefined && read.body.title !== null) {
    const cleaned = cleanConversationTitle(read.body.title);
    if (!cleaned.ok) return sendJson(res, 400, { ok: false, error: cleaned.error });
    bodyTitle = cleaned.title;
  }
  const source = readConversation(sourceId);
  if (!source.ok || !source.meta) return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  const noSession = { ok: false, error: 'no_session', message: 'this conversation has no Claude session yet, so there is nothing to fork' };
  const sourceSession = readConversationSession(sourceId);
  if (!sourceSession || !sourceSession.sessionId) return sendJson(res, 409, noSession);

  const title = bodyTitle ?? forkTitleFrom(source.meta.title);
  const created = createConversation({ project: source.meta.project, title: title ?? undefined, forkedFrom: sourceId });
  let session;
  try {
    session = markConversationForkedFrom(created.id, sourceId, { title });
  } catch (err) {
    deleteConversation(created.id);
    return sendJson(res, 500, { ok: false, error: 'fork session could not be stored: ' + (err && err.message ? err.message : String(err)) });
  }
  // The source's session vanished between the check above and the write (cleared after a failed
  // resume): undo the empty new conversation rather than leave a fork that silently starts fresh.
  if (!session) {
    deleteConversation(created.id);
    return sendJson(res, 409, noSession);
  }
  return sendJson(res, 201, {
    ok: true,
    conversation: {
      ...created,
      forked_from: sourceId,
      session_id: session.sessionId,
      fork_pending: session.pendingFork === true,
    },
  });
}
