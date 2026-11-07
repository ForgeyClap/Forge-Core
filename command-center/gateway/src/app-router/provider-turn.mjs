// App router P2 — one answers-only turn on a provider model or the user's own Codex (design D4, 4.1,
// 4.6, 6.1; review findings 5, 9, 10, 11, 12).
//
// The turn runs through the existing provider layer (createProvider(...).chat(), which never throws)
// with NO tools: the model can only answer. It lives in the same `running` map as a CLI child
// (exec-lifecycle.mjs registerProviderRun), so the conversation is busy while it runs, Stop aborts it
// and a gateway drain interrupts it. Bounds: the CLI's 30-minute wall-clock cap, the provider's own
// idle timeout, at most 3 provider turns at once (exec-lifecycle), a 512 KB answer cap.
//
// Context: a provider has no session, so the router hands the conversation's recent history over on
// EVERY turn (finding 5): provider-model as a messages array, codex folded into its one user message.
//
// Live: the answer streams as `provider_delta` events, at most 4 KB each and at least 250 ms apart
// (the final flush right before the record may follow at once). At the end, onSettled() decides on
// a retry BEFORE the record is written (finding 10); a retried attempt is stored as a
// `route_attempt_failed` event, so a turn_id keeps exactly one assistant record (finding 1).
//
// Errors map to the existing error-catalogue codes (finding 11, mapProviderError below). The vars
// (for example the Ollama port) are the router entry's own (finding 12): the turn talks to exactly the
// server the entry names.
//
// "Eigen API" (ANY-MODEL-PLAN 2.2 F, 2.4): providers are looked up in the MERGED registry (bundled catalogue
// plus the user's own custom-* entries), so a router entry may run on a custom provider. Right before the
// outbound call of a custom entry the saved definition is read again (verifyCustomTarget): when the saved
// file no longer allows the address the registry in memory still has, the turn ends with a visible refusal
// (the record's error and a forge_error event, Dutch first) and no request is sent. createRouterProvider
// (also used by the router probe) refuses the same way by throwing.
import { createProvider, ProviderError, ERROR_CODES } from '../providers/index.mjs';
import { loadMergedRegistry, verifyCustomTarget } from '../providers/custom-registry.mjs';
import { isCustomId } from '../providers/custom-rules.mjs';
import { getGatewayKeyStore } from '../models.mjs';
import { appendAssistantTurn, appendConversationEvent } from '../conversations.mjs';
import { toForgeErrorEvent } from '../error-catalogue.mjs';
import { redact } from '../redact.mjs';
import { registerProviderRun, releaseProviderRun, resolveExecTimeoutMs } from '../exec-lifecycle.mjs';
import { toProviderMessages, toCodexPrompt } from './replay.mjs';
import { LIMITS } from './contract.mjs';

export const CODEX_PROVIDER_ID = 'codex-cli';
export const DELTA_MAX_CHARS = 4096;
export const DELTA_MIN_GAP_MS = 250;
const LIVE_DELTA_CAP_CHARS = 256 * 1024;
const TEXT_CAP_CHARS = 512 * 1024;
const DETAILS_CAP = 600;
const SEP = '\n\n';

let providerFactory = null;
let deltaGapOverride = null;
/** Test seam: fn(providerId, entry) -> a Provider (anything with chat()); null restores createProvider. */
export function _setProviderFactoryForTests(fn) { providerFactory = typeof fn === 'function' ? fn : null; }
/** Test seam: the minimum gap between two live deltas; null restores 250 ms. */
export function _setDeltaGapMsForTests(ms) { deltaGapOverride = Number.isInteger(ms) && ms >= 0 ? ms : null; }

/** The provider registry id a router entry runs on. */
export function providerIdFor(entry) {
  return entry && entry.kind === 'codex-account' ? CODEX_PROVIDER_ID : entry && entry.provider;
}

/** The merged registry, or null when the bundled catalogue itself is broken (createProvider then fails loud). */
function mergedRegistry() {
  try {
    return loadMergedRegistry();
  } catch {
    return null;
  }
}

function registryEntry(id, registry = mergedRegistry()) {
  return registry && typeof id === 'string' ? registry.get(id) : null;
}

const TARGET_UNCHECKED = Object.freeze({
  code: 'target_unchecked',
  nl: 'Het opgeslagen adres van deze eigen API kon niet gecontroleerd worden.',
  en: 'The saved address of this own API could not be checked.',
});

/**
 * The address re-check of a custom-* provider (ANY-MODEL-PLAN 2.4): null when the saved definition still allows
 * exactly the address `regEntry` will call, else { code, nl, en }. Bundled providers always pass. A custom id that
 * is not in the merged registry (deleted, disabled, refused) is checked against no address, so it is refused.
 */
export function customTargetRefusal(providerId, regEntry) {
  if (!isCustomId(providerId)) return null;
  let v;
  try {
    v = verifyCustomTarget(regEntry || { id: providerId, baseURL: null });
  } catch {
    v = null;
  }
  if (v && v.ok === true && regEntry) return null;
  if (v && v.ok === false && typeof v.nl === 'string' && typeof v.en === 'string') return { code: v.code, nl: v.nl, en: v.en };
  return { ...TARGET_UNCHECKED };
}

const refusalText = (refusal) => refusal.nl + ' (' + refusal.en + ')';

function buildRouterProvider(entry, id, registry) {
  if (providerFactory) return providerFactory(id, entry);
  const vars = entry.kind === 'provider-model' && entry.vars && typeof entry.vars === 'object' ? { ...entry.vars } : {};
  return createProvider(id, { keyProvider: getGatewayKeyStore().keyProvider(), vars, ...(registry ? { registry } : {}) });
}

/**
 * The Provider a router entry runs on (the entry's own vars, the gateway key store, the merged registry).
 * Throws on an unknown id, and for a custom-* provider whose saved address no longer matches (the router probe
 * calls this right before its outbound Test).
 */
export function createRouterProvider(entry) {
  const id = providerIdFor(entry);
  const registry = mergedRegistry();
  const refusal = customTargetRefusal(id, registryEntry(id, registry));
  if (refusal) throw new ProviderError(ERROR_CODES.CONFIG, refusalText(refusal), { provider: id });
  return buildRouterProvider(entry, id, registry);
}

const joinText = (...parts) => parts.filter((p) => typeof p === 'string' && p.length > 0).join(SEP);

/**
 * The chat request for one turn. Pure; exported for tests.
 * handover: { text?, history?, truncated?, note? } from turn-router (note = the interrupted-attempt block).
 */
export function buildProviderRequest(entry, userText, handover, { cwd = null, signal = null, adapter = null } = {}) {
  const h = handover && typeof handover === 'object' ? handover : null;
  if (entry.kind === 'codex-account') {
    const context = joinText(h && h.text, h && h.note);
    const content = toCodexPrompt(context ? { text: context } : null, userText);
    return { messages: [{ role: 'user', content }], stream: true, options: { cwd, sandbox: 'read-only', signal } };
  }
  const messages = toProviderMessages(h, userText);
  if (h && typeof h.note === 'string' && h.note) messages[0] = { role: 'system', content: messages[0].content + SEP + h.note };
  const options = { signal };
  if (adapter === 'ollama') options.numCtx = Number.isInteger(entry.num_ctx) ? entry.num_ctx : LIMITS.NUM_CTX_DEFAULT;
  return { model: entry.model, messages, stream: true, options };
}

/**
 * Maps a provider error event to a route outcome and an error-catalogue code (review finding 11).
 * Pure; exported for the table test.
 *   NETWORK/TIMEOUT  -> down; ollama_down for the local Ollama, offline for a remote provider, unknown
 *                       (with the provider's own message) for another local server, whose card would
 *                       otherwise say "Start Ollama" or "no internet";
 *   NOT_FOUND        -> down + model_not_pulled for the local Ollama; any other provider: error;
 *   RATE_LIMIT       -> rate_limited;
 *   NOT_CONNECTED    -> logged_out (codex not signed in), card code unknown: never the Claude sign-in card;
 *   NOT_INSTALLED    -> down (codex missing), card code unknown;
 *   AUTH, NOT_CONFIGURED and everything else -> error, no automatic retry; never the Claude sign-in
 *                       card for a missing or refused provider key.
 * @returns {{outcome: string, code: string, details: string|null, model: string|null}}
 */
export function mapProviderError(ev, { adapter = null, local = false, model = null } = {}) {
  const code = ev && typeof ev.code === 'string' ? ev.code : null;
  const details = ev && typeof ev.message === 'string' && ev.message ? redact(ev.message).slice(0, DETAILS_CAP) : null;
  const localOllama = adapter === 'ollama' && local === true;
  const out = (outcome, card, m = null) => ({ outcome, code: card, details, model: m });
  if (code === 'NETWORK' || code === 'TIMEOUT') return out('down', localOllama ? 'ollama_down' : local ? 'unknown' : 'offline');
  if (code === 'NOT_FOUND') return localOllama ? out('down', 'model_not_pulled', model) : out('error', 'unknown');
  if (code === 'RATE_LIMIT') return out('rate_limited', 'rate_limited');
  if (code === 'NOT_CONNECTED') return out('logged_out', 'unknown');
  if (code === 'NOT_INSTALLED') return out('down', 'unknown');
  return out('error', 'unknown');
}

/** Live delta batching (exported for tests). emit(chunk) is called with at most maxChars per call. */
export function _createDeltaBatcherForTests(emit, opts) { return createDeltaBatcher(emit, opts); }
function createDeltaBatcher(emit, { maxChars = DELTA_MAX_CHARS, gapMs = DELTA_MIN_GAP_MS, liveCap = LIVE_DELTA_CAP_CHARS } = {}) {
  let buf = '';
  let sent = 0;
  let lastEmit = 0;
  let timer = null;
  let cancelled = false;
  function emitOne() {
    const chunk = buf.slice(0, maxChars);
    buf = buf.slice(chunk.length);
    sent += chunk.length;
    lastEmit = Date.now();
    emit(chunk);
  }
  function schedule() {
    if (timer || cancelled || !buf) return;
    timer = setTimeout(() => {
      timer = null;
      if (cancelled || !buf) return;
      emitOne();
      schedule();
    }, Math.max(0, lastEmit + gapMs - Date.now()));
    if (typeof timer.unref === 'function') timer.unref();
  }
  return {
    push(text) {
      if (cancelled || typeof text !== 'string' || !text) return;
      const room = liveCap - sent - buf.length;
      if (room <= 0) return; // the record carries the full answer; the live tail stops here
      buf += text.slice(0, room);
      schedule();
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      while (buf && !cancelled) emitOne();
    },
    cancel() {
      cancelled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      buf = '';
    },
  };
}

function appendEvent(t, kind, data) {
  try {
    appendConversationEvent(t.convId, { turn_id: t.turnId, request_id: t.requestId, kind, ...(data === undefined ? {} : { data }) });
    return true;
  } catch {
    return false; // best-effort, like every other event write of a running turn
  }
}

/**
 * Starts one provider or codex turn. Returns { started: true, turnId, requestId } or
 * { started: false, reason }. Never throws; the turn itself runs asynchronously.
 * @param {object} a
 * @param {object} a.route     the route record (design 4.7) stamped on the stored turn
 * @param {object} a.entry     the router entry (provider-model or codex-account)
 * @param {object|null} [a.handover]  { text, history, truncated, turns, chars, note? }
 * @param {Function|null} [a.onSettled]  (result) -> { retried }, called once before the record is written
 */
export function startProviderTurn({ convId, turnId, requestId, text, cwd, route, entry, handover = null, onSettled = null }) {
  if (!entry || (entry.kind !== 'provider-model' && entry.kind !== 'codex-account')) return { started: false, reason: 'not a provider or codex target' };
  if (typeof text !== 'string' || text.trim().length === 0) return { started: false, reason: 'empty message' };
  const providerId = providerIdFor(entry);
  const registry = mergedRegistry();
  const regEntry = registryEntry(providerId, registry);
  // A custom-* id the registry no longer has cannot be built; its turn still starts so the refusal below
  // (runTurn) is visible in the chat instead of a silent no-start.
  const refusedUpFront = isCustomId(providerId) && !regEntry && !providerFactory;
  let provider = null;
  if (!refusedUpFront) {
    try {
      provider = buildRouterProvider(entry, providerId, registry);
    } catch (err) {
      return { started: false, reason: 'provider could not be created: ' + redact(err && err.message ? err.message : String(err)).slice(0, DETAILS_CAP) };
    }
    if (!provider || typeof provider.chat !== 'function') return { started: false, reason: 'provider has no chat' };
  }
  const controller = new AbortController();
  const reg = registerProviderRun(convId, { turnId, requestId, abort: (why) => controller.abort(why) });
  if (!reg.ok) return { started: false, reason: reg.reason };
  const t = {
    convId, turnId, requestId, text, cwd, route, entry, handover, onSettled, provider, controller,
    run: reg.entry,
    providerId,
    regEntry,
    adapter: regEntry ? regEntry.adapter : null,
    local: !!(regEntry && regEntry.local === true),
  };
  runTurn(t).catch((err) => crashFinish(t, err));
  return { started: true, turnId, requestId };
}

async function readAnswer(t, r) {
  const request = buildProviderRequest(t.entry, t.text, t.handover, { cwd: t.cwd, signal: t.controller.signal, adapter: t.adapter });
  for await (const ev of t.provider.chat(request)) {
    if (t.run.finished) break; // a gateway drain closed this turn: stop reading
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'text' && typeof ev.text === 'string') {
      if (r.text.length < TEXT_CAP_CHARS) r.text += ev.text.slice(0, TEXT_CAP_CHARS - r.text.length);
      r.deltas.push(ev.text);
    } else if (ev.type === 'usage') r.usage = ev;
    else if (ev.type === 'done') r.done = ev;
    else if (ev.type === 'error') r.errorEvent = ev;
  }
}

async function runTurn(t) {
  const startedAt = Date.now();
  const deltas = createDeltaBatcher((chunk) => appendEvent(t, 'provider_delta', { text: chunk }), { gapMs: deltaGapOverride ?? DELTA_MIN_GAP_MS });
  const r = { startedAt, deltas, text: '', usage: null, done: null, errorEvent: null, timedOut: false, timeoutMs: resolveExecTimeoutMs() };
  const timer = setTimeout(() => { r.timedOut = true; t.controller.abort('timeout'); }, r.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    // The address re-check runs right before the one outbound call of this attempt (nothing awaits in between).
    const refusal = customTargetRefusal(t.providerId, t.regEntry);
    if (refusal) r.errorEvent = { type: 'error', code: ERROR_CODES.CONFIG, message: refusalText(refusal) };
    else await readAnswer(t, r);
  } catch (err) {
    r.errorEvent = { type: 'error', code: 'HTTP', message: err && err.message ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
  finish(t, r);
}

// A bug in this module must still end the turn visibly instead of leaving it busy forever.
function crashFinish(t, err) {
  const r = { startedAt: Date.now(), deltas: createDeltaBatcher(() => {}), text: '', usage: null, done: null, timedOut: false, timeoutMs: 0, errorEvent: { type: 'error', code: 'HTTP', message: 'router provider turn failed: ' + (err && err.message ? err.message : String(err)) } };
  finish(t, r);
}

function outcomeOf(t, r, mapped) {
  if (t.run.stoppedByUser === true) return 'stopped';
  if (r.timedOut) return 'error';
  if (r.errorEvent) return mapped.outcome;
  return r.done ? 'ok' : 'error';
}

function finish(t, r) {
  if (!t.run.markFinished()) { r.deltas.cancel(); return; } // a drain already wrote this turn's terminal event
  releaseProviderRun(t.convId, t.run);
  r.deltas.flush();
  const stopped = t.run.stoppedByUser === true;
  const mapped = r.errorEvent ? mapProviderError(r.errorEvent, { adapter: t.adapter, local: t.local, model: t.entry.model || null }) : null;
  const noAnswer = !r.errorEvent && !r.done ? { outcome: 'error', code: 'unknown', details: 'the model stream ended without a complete answer', model: null } : null;
  const failure = mapped || noAnswer;
  const outcome = outcomeOf(t, r, mapped || { outcome: 'error' });
  if (r.timedOut) appendEvent(t, 'timed_out', { timeout_ms: r.timeoutMs });

  let retried = false;
  if (typeof t.onSettled === 'function') {
    try {
      const res = t.onSettled({
        outcome,
        errorCode: failure && outcome !== 'ok' && outcome !== 'stopped' ? failure.code : null,
        resumeAt: null,
        hadToolUse: false,
        stoppedByUser: stopped,
        timedOut: r.timedOut,
        exitCode: null,
        rateLimitEvents: [],
      });
      retried = !!(res && res.retried === true);
    } catch (err) {
      appendEvent(t, 'route_settle_error', { message: err && err.message ? err.message : String(err) });
    }
  }

  const error = outcome === 'ok' || outcome === 'stopped'
    ? null
    : r.timedOut
      ? 'execution exceeded the ' + r.timeoutMs + 'ms wall-clock timeout and was terminated'
      : (failure && failure.details) || 'the model did not answer';
  const fields = {
    turn_id: t.turnId,
    request_id: t.requestId,
    text: r.text,
    cost_usd: null,
    duration_ms: Date.now() - r.startedAt,
    stop_reason: r.done ? (r.done.stopReason ?? null) : stopped ? 'stopped' : r.timedOut ? 'timed_out' : null,
    exit_code: null,
    error,
    input_tokens: r.usage ? r.usage.inputTokens ?? null : null,
    output_tokens: r.usage ? r.usage.outputTokens ?? null : null,
    model: (r.done && typeof r.done.model === 'string' && r.done.model) || t.entry.model || null,
    session_id: null,
    agent_type: null,
    file_edits: null,
    todos: null,
    shell_commands: null,
  };
  const route = { ...t.route, outcome, retried };
  try {
    if (retried) {
      appendConversationEvent(t.convId, { turn_id: t.turnId, request_id: t.requestId, kind: 'route_attempt_failed', data: { ...fields, route } });
      return;
    }
    appendAssistantTurn(t.convId, { ...fields, route });
  } catch {
    return; // best-effort: the store vanished (same rationale as the CLI close path)
  }
  if (failure && !stopped && !r.timedOut && outcome !== 'ok') {
    const payload = { code: failure.code, resume_at: null, model: failure.model, attempt: null, max_attempts: null, details: failure.details };
    const event = toForgeErrorEvent(payload, 'provider');
    if (event) appendEvent(t, 'forge_error', event);
  }
}
