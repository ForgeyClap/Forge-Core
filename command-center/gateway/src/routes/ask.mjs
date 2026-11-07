// Ask-the-owner routes (moved verbatim out of server.mjs, WP A11 part 1). POST /api/ask is called by
// the ask-mcp.mjs MCP subprocess (never the browser) to register a real question and BLOCK until the
// owner answers or the ask times out. POST /api/ask/:id/answer is the dashboard's own real answer
// submission. Both are token-checked once in requestListener.
import { safeIdOk, safeConvIdOk } from '../security.mjs';
import { validateSchema } from '../body.mjs';
import { conversationExists, appendConversationEvent } from '../conversations.mjs';
import { pauseExecTimeoutForAsk, resumeExecTimeoutAfterAsk } from '../exec-bridge.mjs';
import { createAskRequest, answerAskRequest } from '../ask-store.mjs';
import { sendJson, readBodyOrRespond } from './http.mjs';

export const MODULE = 'ask';

export const ASK_RE = /^\/api\/ask$/;
export const ASK_ANSWER_RE = /^\/api\/ask\/([^/]+)\/answer$/;

// feat-ask-owner: this handler simply does not respond until the owner answers via POST
// /api/ask/:id/answer, or the ask-store's own timeout fires. Only a process that was actually
// handed this boot's token (the mcp-config's own env, exec-argv.mjs) may open a new ask.
export async function ask(req, res) {
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['conv_id', 'turn_id', 'request_id', 'questions'], ['conv_id', 'questions']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (typeof body.conv_id !== 'string' || !safeConvIdOk(body.conv_id) || !conversationExists(body.conv_id)) {
    return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  }
  const turnId = typeof body.turn_id === 'string' && body.turn_id.length > 0 ? body.turn_id : null;
  const requestId = typeof body.request_id === 'string' && body.request_id.length > 0 ? body.request_id : null;
  const created = createAskRequest({ convId: body.conv_id, turnId, requestId, questions: body.questions });
  if (!created.ok) return sendJson(res, 400, { ok: false, error: created.error });

  appendConversationEvent(body.conv_id, {
    turn_id: created.turnId,
    request_id: created.requestId,
    kind: 'ask_questions',
    data: { id: created.id, questions: created.questions, timeout_ms: created.timeoutMs },
  });

  // fix-ghost-asks item 4: this conv's own exec-timeout reaper is not "wedged" logic while it is
  // genuinely waiting on an answer WE just asked the owner for — pause it for exactly the ask's
  // own real timeout window (never longer; see pauseExecTimeoutForAsk's own header for the full
  // bounded-cap rationale). A no-op when this convId has no running execution right now.
  pauseExecTimeoutForAsk(body.conv_id, created.timeoutMs);

  const outcome = await created.promise; // the real block — resolves on a real answer, the honest timeout, or an abandonment below
  // Resumes the paused reaper regardless of outcome — a no-op when the execution already ended
  // (the common case for `outcome.abandoned`, since that is exactly what ended it).
  resumeExecTimeoutAfterAsk(body.conv_id);

  if (outcome.timed_out) {
    appendConversationEvent(body.conv_id, { turn_id: created.turnId, request_id: created.requestId, kind: 'ask_timed_out', data: { id: created.id } });
    return sendJson(res, 200, {
      ok: true,
      timed_out: true,
      note: 'the owner did not answer within the time limit (' + created.timeoutMs + 'ms) — no answer was fabricated',
    });
  }
  if (outcome.abandoned) {
    // fix-ghost-asks item 1: the execution that opened this ask already ended (stopped, closed,
    // errored, or reaped) — exec-lifecycle.mjs already appended the real `ask_abandoned`
    // conversation event, so this handler's only remaining job is to let the blocked HTTP call
    // settle instead of hanging until the ask's own real timeout. The underlying ask-mcp.mjs client
    // is very likely ALREADY dead too — writing the response here is best-effort only.
    try {
      return sendJson(res, 200, {
        ok: true,
        abandoned: true,
        reason: outcome.reason,
        note: 'the execution ended before the owner answered — no answer was fabricated',
      });
    } catch {
      return undefined;
    }
  }
  return sendJson(res, 200, { ok: true, timed_out: false, answers: outcome.answers });
}

// feat-ask-owner: ask-store.mjs owns every remaining 400/404/409/200 outcome (strict shape check,
// unknown/already-resolved id).
export async function answer(req, res, { match }) {
  let askId;
  try { askId = decodeURIComponent(match[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid ask id' }); }
  if (!safeIdOk(askId)) return sendJson(res, 400, { ok: false, error: 'invalid ask id' });
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['answers'], ['answers']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  const result = answerAskRequest(askId, body.answers);
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  appendConversationEvent(result.convId, { turn_id: result.turnId, request_id: result.requestId, kind: 'ask_answered', data: { id: askId, answers: result.answers } });
  return sendJson(res, 200, { ok: true, answered: true, id: askId });
}
