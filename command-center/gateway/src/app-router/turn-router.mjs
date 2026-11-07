// App router P2 — the per-turn routing facade P3 calls (design 4.1, 4.3, 4.6, 4.7, 6.1).
//
//   startRoutedTurn({ convId, turnId, requestId, text, cwd, mode, effort, model, fork })
//     -> { started: true, turnId, requestId, route: RouteDecision|null }
//      | { started: false, reason, code?: 'router_exhausted'|'busy'|'draining'|'not_started', route }
//   isTurnBusy(convId)        a CLI child OR a provider turn (one shared running map)
//   stopTurn(convId)          -> { stopped } (kills the child or aborts the provider stream)
//   routerPreview({ convId }) -> the `next` object of GET /api/app-router/status (read-only)
//
// Router off (mode 'off', also a missing or unreadable router.json): startExecution() with the
// identical arguments, route null; nothing else runs, nothing is written (design D8).
//
// Router on: pick a target (select.mjs), start it (a Claude account through startExecution with its
// profile folder; a provider or codex through provider-turn.mjs), then write route_selected /
// route_switched / context_handover. When the attempt ends, onSettled() records the usage reading and
// any limit, lost login or down server, and, when allowed (a limit, a lost login on an extra account
// or codex, a down provider; no tool call, no Stop, no timeout, attempt 1), starts attempt 2 on the
// next eligible entry in the SAME synchronous callback, so the conversation is never "not busy" in
// between. Attempt 2 keeps the turn_id and uses request_id + '-r2'. Never a third attempt.
//
// Handover (design 4.6 + review finding 5): a Claude account gets the recent messages on stdin only
// when it cannot resume its own session; a provider or codex gets them on EVERY turn (no session).
// Review finding 6: after an interrupted turn that moved to another target, the next turn also gets a
// short note of what the interrupted attempt already did (files, commands, partial answer).
//
// Q5-EIGEN-API: an entry whose "Eigen API" (custom-*) was deleted, turned off or refused, or now needs a
// key while the entry never confirmed the cost, is skipped (router event router_entry_skipped, reason
// provider_unavailable / paid_ack_required) and the turn goes on with the next entry, as if that entry
// were turned off; nothing usable left -> the normal "chain exhausted" path. The router is never turned
// off for it, and an unconfirmed Eigen API never gets a request. Q6 C1: route_selected, route_switched and
// route_exhausted carry data.skipped ([] when none): {target_id, label, provider, reason} per entry walked past.
import { startExecution, isConversationBusy, stopExecution, isDraining } from '../exec-lifecycle.mjs';
import { resumeOptionsFor } from '../sessions/gateway-sessions.mjs';
import { appendConversationEvent } from '../conversations.mjs';
import { resolveSafe, readAllRecords } from '../conversation-store.mjs';
import { toForgeErrorEvent } from '../error-catalogue.mjs';
import { redact } from '../redact.mjs';
import { readRouterConfig } from './chain-store.mjs';
import { effectiveChain, providerRegistry, unavailableEntryIds, unusableCustomEntryReason, withEntriesOff } from './chain-schema.mjs';
import { selectTarget } from './select.mjs';
import { readingFromStreamLine, recordReading, recordLimitHit, markNeedsLogin, markDown, markUsed, readReadings, targetState } from './usage-readings.mjs';
import { buildHandover } from './replay.mjs';
import { profileDir } from './profiles.mjs';
import { appendRouterEvent } from './router-log.mjs';
import { CAPABILITY_BY_KIND, LIMITS } from './contract.mjs';
import { startProviderTurn } from './provider-turn.mjs';

const DAY_MS = 24 * 60 * 60_000;
const NOTE_CAP_CHARS = 4000;
const RETRY_SUFFIX = '-r2';
const STATUS_RANK = Object.freeze({ allowed: 1, allowed_warning: 2, rejected: 3 });
const SEP = '\n\n';

const joinText = (...parts) => parts.filter((p) => typeof p === 'string' && p.length > 0).join(SEP);

function safeAppend(convId, record) {
  try {
    appendConversationEvent(convId, record);
    return true;
  } catch {
    return false; // best-effort, like every other event write around a running turn
  }
}

function readRecords(convId) {
  const p = resolveSafe(convId);
  return p ? readAllRecords(p) : [];
}

// ---- pure helpers (exported for tests) -------------------------------------------------------------

/**
 * The conversation's routing state from its stored assistant records: the target of the last routed
 * record (an unrouted record, written while the router was off, resets it), the time of the last
 * switch, and the proactive switches plus switches back in the last 24 h (both count toward the
 * 6-per-24 h cap, review finding 4).
 */
export function conversationRouteState(records, now = Date.now()) {
  let targetId = null;
  let switchedAt = null;
  let counted = 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.type !== 'turn' || r.role !== 'assistant') continue;
    const rt = r.route && typeof r.route === 'object' ? r.route : null;
    if (!rt) { targetId = null; continue; }
    if (typeof rt.target_id === 'string') targetId = rt.target_id;
    if (rt.switched !== true) continue;
    if (typeof r.created_at === 'string') switchedAt = r.created_at;
    const at = Date.parse(r.created_at);
    if ((rt.reason === 'switch-threshold' || rt.reason === 'return') && Number.isFinite(at) && now - at < DAY_MS) counted += 1;
  }
  return { target_id: targetId, switched_at: switchedAt, proactive_switches_24h: counted };
}

/** One reading from a turn's rate_limit_event lines: windows merged per type (last wins), worst status. */
export function mergeReadings(lines) {
  const byType = new Map();
  let status = null;
  for (const line of Array.isArray(lines) ? lines : []) {
    const r = readingFromStreamLine(line);
    if (!r) continue;
    for (const w of r.windows) byType.set(w.type, w);
    if (r.status && (STATUS_RANK[r.status] || 0) >= (STATUS_RANK[status] || 0)) status = r.status;
  }
  if (byType.size === 0 && status === null) return null;
  return { status, windows: [...byType.values()] };
}

/** Whether a finished attempt may be retried on another entry, and with which failover reason. */
export function failoverFor(entry, result, attempt) {
  if (attempt !== 1 || !entry || !result || result.hadToolUse || result.stoppedByUser || result.timedOut) return null;
  if (result.outcome === 'rate_limited') return 'rate_limited';
  if (result.outcome === 'logged_out') {
    const extraProfile = entry.kind === 'claude-account' && typeof entry.profile === 'string';
    return extraProfile || entry.kind === 'codex-account' ? 'logged_out' : null; // main keeps its sign-in card
  }
  if (result.outcome === 'down') return entry.kind !== 'claude-account' ? 'down' : null;
  return null;
}

/**
 * Review finding 6: what an interrupted earlier attempt (on another target) already did, so the next
 * target does not blindly repeat file edits or commands. Null when there is nothing to say.
 */
export function interruptedAttemptNote(records, currentTurnId, targetId) {
  let prev = null;
  for (const r of Array.isArray(records) ? records : []) {
    if (r && r.type === 'turn' && r.role === 'assistant' && r.turn_id !== currentTurnId) prev = r;
  }
  const rt = prev && prev.route && typeof prev.route === 'object' ? prev.route : null;
  if (!rt || rt.outcome === 'ok' || rt.retried === true || rt.target_id === targetId) return null;
  const edits = Array.isArray(prev.file_edits)
    ? [...new Set(prev.file_edits.map((e) => e && e.file_path).filter((p) => typeof p === 'string' && p))]
    : [];
  const cmds = Array.isArray(prev.shell_commands)
    ? prev.shell_commands.filter((c) => c && typeof c.command === 'string' && c.command).map((c) => (c.is_error === true ? '(failed) ' : '') + c.command)
    : [];
  const partial = !prev.error && typeof prev.text === 'string' ? prev.text.trim() : '';
  if (edits.length === 0 && cmds.length === 0 && !partial) return null;
  const lines = ['Note: the previous answer in this conversation was interrupted on ' + (rt.label || rt.target_id || 'another account') + ' before it finished. It had already done the following. Check the current state before you repeat any of it.'];
  if (edits.length) lines.push('Files it changed: ' + edits.join(', '));
  if (cmds.length) lines.push('Commands it ran:\n' + cmds.map((c) => '- ' + c).join('\n'));
  if (partial) lines.push('Its partial answer: ' + partial);
  const note = redact(lines.join('\n'));
  return note.length > NOTE_CAP_CHARS ? note.slice(0, NOTE_CAP_CHARS - 2) + ' …' : note;
}

/** The error-catalogue code that best explains "nothing usable is left" (the card the user sees). */
export function exhaustedCode(config, readings, { now = Date.now(), requestedModel = null } = {}) {
  const defaultThresholdPct = (config && config.defaults && config.defaults.threshold_pct) || LIMITS.THRESHOLD_DEFAULT;
  const states = effectiveChain(config).map((e) => ({ e, s: targetState(e, (readings || {})[e.id] || null, { now, defaultThresholdPct, requestedModel }).state }));
  if (states.some((x) => x.s === 'exhausted')) return 'rate_limited';
  if (states.some((x) => x.s === 'down' && x.e.kind === 'provider-model' && x.e.provider === 'ollama-local')) return 'ollama_down';
  if (states.some((x) => x.s === 'needs-login')) return 'logged_out';
  return 'unknown';
}

/** The public shape of a decision (no vars, no internals): what P3 returns and /status shows. */
export function publicDecision(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.kind === 'target' && d.entry) {
    return {
      kind: 'target',
      entry: { id: d.entry.id, label: d.entry.label, kind: d.entry.kind },
      reason: d.reason,
      switched: d.switched === true,
      proactive: d.proactive === true,
      capability: d.capability || CAPABILITY_BY_KIND[d.entry.kind] || null,
      state: d.state || null,
      from: d.from || null,
    };
  }
  if (d.kind === 'exhausted') return { kind: 'exhausted', resume_at: d.resume_at ?? null, first_free: d.first_free ?? null };
  return null;
}

/** The `route` record of design 4.7 for one attempt (outcome/retried are set when it ends). */
function routeRecord(decision, attempt) {
  const e = decision.entry;
  const f = decision.from || null;
  return {
    target_id: e.id,
    kind: e.kind,
    label: e.label,
    model: e.kind === 'provider-model' ? e.model || null : null,
    capability: decision.capability || CAPABILITY_BY_KIND[e.kind] || 'answers-only',
    reason: decision.reason,
    switched: decision.switched === true,
    from_target_id: f ? f.target_id : null,
    from_label: f ? f.label : null,
    from_window: f ? f.window ?? null : null,
    from_pct: f ? f.pct ?? null : null,
    from_resume_at: f ? f.resume_at ?? null : null,
    attempt,
    retried: false,
    outcome: null,
    handover: null,
  };
}

// ---- handover --------------------------------------------------------------------------------------

function handoverFor(ctx, entry, { needed }) {
  const defaults = ctx.config.defaults || {};
  let h = null;
  if (needed) {
    h = buildHandover(ctx.records, {
      maxTurns: defaults.handover_turns ?? LIMITS.HANDOVER_TURNS_DEFAULT,
      kind: entry.kind,
      numCtx: entry.kind === 'provider-model' && Number.isInteger(entry.num_ctx) ? entry.num_ctx : null,
      excludeTurnId: ctx.turnId,
    });
    if (h.turns === 0) h = null;
  }
  const note = interruptedAttemptNote(ctx.records, ctx.turnId, entry.id);
  if (!h && !note) return null;
  return { ...(h || { turns: 0, chars: 0, truncated: false, history: [], text: '' }), note: note || null };
}

// ---- start -----------------------------------------------------------------------------------------

function startOnTarget(ctx, decision, attempt, claudeConfigDir, skipped = []) {
  const entry = decision.entry;
  const requestId = attempt === 1 ? ctx.requestId : ctx.requestId + RETRY_SUFFIX;
  const route = routeRecord(decision, attempt);
  const onSettled = (result) => settleAttempt(ctx, { entry, attempt }, result);
  let started;
  if (entry.kind === 'claude-account') {
    const resumable = !!resumeOptionsFor(ctx.convId, { cwd: ctx.cwd, fork: ctx.fork === true, targetId: entry.id }).resumeSessionId;
    const h = handoverFor(ctx, entry, { needed: !resumable });
    const stdinText = h ? joinText(h.text, h.note) : '';
    route.handover = h ? { turns: h.turns, chars: stdinText.length, truncated: h.truncated === true } : null;
    started = startExecution({
      convId: ctx.convId, turnId: ctx.turnId, requestId, text: ctx.text, cwd: ctx.cwd, mode: ctx.mode, effort: ctx.effort,
      model: ctx.model, fork: ctx.fork, route, claudeConfigDir, handover: stdinText ? { text: stdinText } : null, onSettled,
    });
  } else {
    const h = handoverFor(ctx, entry, { needed: true });
    route.handover = h ? { turns: h.turns, chars: (h.chars || 0) + (h.note ? h.note.length : 0), truncated: h.truncated === true } : null;
    started = startProviderTurn({ convId: ctx.convId, turnId: ctx.turnId, requestId, text: ctx.text, cwd: ctx.cwd, route, entry, handover: h, onSettled });
  }
  if (!started || !started.started) return { started: false, reason: (started && started.reason) || 'the turn could not start' };

  // Written right after the synchronous start: no stream line of the attempt can be stored yet, so
  // the notice always comes before the answer in the conversation file. Q6 C1: `skipped` lists the entries walked
  // past while choosing THIS route ([] when none), so the conversation itself can say why.
  const base = { turn_id: ctx.turnId, request_id: requestId };
  safeAppend(ctx.convId, { ...base, kind: 'route_selected', data: { target_id: route.target_id, label: route.label, kind: route.kind, capability: route.capability, reason: route.reason, attempt, skipped: [...skipped] } });
  if (route.switched) {
    // review finding 13: exactly the route record, plus the Q6 C1 skip list
    safeAppend(ctx.convId, { ...base, kind: 'route_switched', data: { ...route, skipped: [...skipped] } });
    appendRouterEvent('router_switch', { conv_id: ctx.convId, turn_id: ctx.turnId, from: route.from_target_id, to: route.target_id, reason: route.reason });
  }
  if (route.handover) safeAppend(ctx.convId, { ...base, kind: 'context_handover', data: route.handover });
  markUsed(entry.id);
  return { started: true, route };
}

// The entry's Eigen API is gone or unconfirmed: from now on this turn (attempt 2 included) treats the entry as turned
// off, so a conversation that was on it moves on visibly ("left the chain"), and the reason is logged. Returns the
// conversation-side skip item (Q6 C1).
function skipUnusable(ctx, entry, reason) {
  ctx.config = withEntriesOff(ctx.config, new Set([entry.id]));
  appendRouterEvent('router_entry_skipped', { conv_id: ctx.convId, turn_id: ctx.turnId, target_id: entry.id, provider: entry.provider, reason });
  return { target_id: entry.id, label: entry.label, provider: entry.provider, reason };
}

function selectAndStart(ctx, { attempt, conv, exclude, failover }) {
  const skip = new Set(exclude);
  const registry = providerRegistry();
  const skipped = []; // the entries walked past while choosing this attempt's route (Q6 C1)
  let decision = null;
  for (let guard = 0; guard <= LIMITS.MAX_ENTRIES; guard += 1) {
    decision = selectTarget({ config: ctx.config, readings: readReadings(), conv, now: Date.now(), requestedModel: ctx.model || null, exclude: [...skip], failover });
    if (decision.kind !== 'target') return { kind: 'exhausted', decision, skipped };
    const entry = decision.entry;
    const unusable = unusableCustomEntryReason(entry, registry);
    if (unusable) {
      skipped.push(skipUnusable(ctx, entry, unusable));
      continue;
    }
    let claudeConfigDir = null;
    if (entry.kind === 'claude-account' && typeof entry.profile === 'string') {
      const pd = profileDir(entry.profile, { mustExist: true });
      if (!pd.ok) { // no usable folder (missing, symlink, outside the root): treat as not signed in
        markNeedsLogin(entry.id);
        skip.add(entry.id);
        continue;
      }
      claudeConfigDir = pd.dir;
    }
    const started = startOnTarget(ctx, decision, attempt, claudeConfigDir, skipped);
    return started.started ? { kind: 'started', decision, route: started.route } : { kind: 'not_started', decision, reason: started.reason, skipped };
  }
  return { kind: 'exhausted', decision: { kind: 'exhausted', resume_at: null, first_free: null }, skipped };
}

// Q6 C1: route_exhausted (the event the dashboard reads for "nothing could take this turn") lists the skipped entries.
function reportExhausted(ctx, decision, requestId, { forgeError, skipped = [] }) {
  const d = decision && decision.kind === 'exhausted' ? decision : { resume_at: null, first_free: null };
  const code = exhaustedCode(ctx.config, readReadings(), { requestedModel: ctx.model || null });
  const base = { turn_id: ctx.turnId, request_id: requestId };
  safeAppend(ctx.convId, { ...base, kind: 'route_exhausted', data: { resume_at: d.resume_at ?? null, first_free: d.first_free ?? null, code, skipped: [...skipped] } });
  if (forgeError) {
    const payload = { code, resume_at: code === 'rate_limited' ? d.resume_at ?? null : null, model: null, attempt: null, max_attempts: null, details: 'router: no account or model in the chain can take this turn' };
    const event = toForgeErrorEvent(payload, 'router');
    if (event) safeAppend(ctx.convId, { ...base, kind: 'forge_error', data: event });
  }
  appendRouterEvent('router_exhausted', { conv_id: ctx.convId, resume_at: d.resume_at ?? null });
}

function limitHitFrom(result, reading) {
  const windows = reading && Array.isArray(reading.windows) ? reading.windows : [];
  const rejected = windows.find((w) => w.status === 'rejected') || null;
  return {
    resets_at: result.resumeAt || (rejected && rejected.resets_at) || null,
    window: (rejected && rejected.type) || (windows[0] && windows[0].type) || null,
  };
}

// Runs once per attempt, synchronously, before the attempt's record is written.
function settleAttempt(ctx, { entry, attempt }, result) {
  const now = Date.now();
  const reading = entry.kind === 'claude-account' ? mergeReadings(result.rateLimitEvents) : null;
  if (reading) recordReading(entry.id, reading, { source: 'turn', now });
  if (result.outcome === 'rate_limited') {
    const hit = limitHitFrom(result, reading);
    recordLimitHit(entry.id, { resets_at: hit.resets_at, window: hit.window, now });
    appendRouterEvent('router_limit_hit', { target_id: entry.id, window: hit.window, resume_at: hit.resets_at });
  } else if (result.outcome === 'logged_out') {
    if (entry.kind === 'claude-account' && typeof entry.profile === 'string') markNeedsLogin(entry.id, { now });
    else if (entry.kind === 'codex-account') markDown(entry.id, { now }); // codex has no needs-login state: skip it a while
  } else if (result.outcome === 'down') {
    markDown(entry.id, { now });
  }
  const failover = failoverFor(entry, result, attempt);
  if (!failover) return { retried: false };
  const conv = { target_id: entry.id, switched_at: ctx.conv.switched_at, proactive_switches_24h: ctx.conv.proactive_switches_24h };
  const next = selectAndStart(ctx, { attempt: 2, conv, exclude: [entry.id], failover });
  if (next.kind === 'started') return { retried: true };
  // Review finding 10: attempt 2 did not start, so attempt 1 stays the turn's record (retried false)
  // and the reason is visible as its own event.
  const r2 = ctx.requestId + RETRY_SUFFIX;
  if (next.kind === 'exhausted') reportExhausted(ctx, next.decision, r2, { forgeError: false, skipped: next.skipped });
  safeAppend(ctx.convId, { turn_id: ctx.turnId, request_id: r2, kind: 'execution_not_started', data: { reason: next.kind === 'exhausted' ? 'router_exhausted' : next.reason, attempt: 2, skipped: [...(next.skipped || [])] } });
  return { retried: false };
}

// ---- facade ----------------------------------------------------------------------------------------

/** Starts one chat turn, routed when the router is on. Never throws. See the header for the result. */
export function startRoutedTurn({ convId, turnId, requestId, text, cwd, mode, effort, model, fork }) {
  const { config } = readRouterConfig();
  if (!config || config.mode === 'off') {
    const started = startExecution({ convId, turnId, requestId, text, cwd, mode, effort, model, fork });
    return { ...started, route: null };
  }
  if (isDraining()) return { started: false, reason: 'gateway is draining — no new executions; the supervisor will start a fresh gateway', code: 'draining', route: null };
  if (isConversationBusy(convId)) return { started: false, reason: 'conversation already has a pending execution', code: 'busy', route: null };
  const records = readRecords(convId);
  const ctx = { convId, turnId, requestId, text, cwd, mode, effort, model, fork, config, records, conv: conversationRouteState(records, Date.now()) };
  const res = selectAndStart(ctx, { attempt: 1, conv: ctx.conv, exclude: [], failover: null });
  if (res.kind === 'started') return { started: true, turnId, requestId, route: publicDecision(res.decision) };
  if (res.kind === 'exhausted') {
    reportExhausted(ctx, res.decision, requestId, { forgeError: true, skipped: res.skipped });
    return { started: false, reason: 'router_exhausted', code: 'router_exhausted', route: publicDecision(res.decision) };
  }
  return { started: false, reason: res.reason, code: 'not_started', route: publicDecision(res.decision), skipped: [...(res.skipped || [])] };
}

/** A CLI child or a provider turn is running for this conversation. */
export function isTurnBusy(convId) {
  return isConversationBusy(convId);
}

/** Stops the running turn of this conversation (kills the child or aborts the provider stream). */
export function stopTurn(convId) {
  const r = stopExecution(convId);
  return { stopped: !!(r && r.stopped) };
}

/** What the router would pick for this conversation's next turn (null when the router is off). Read-only. */
export function routerPreview({ convId = null } = {}) {
  const { config } = readRouterConfig();
  if (!config || config.mode === 'off') return null;
  const now = Date.now();
  const conv = convId ? conversationRouteState(readRecords(convId), now) : null;
  // The same walk-past as a real turn (a gone or unconfirmed Eigen API is never the preview), without the skip event.
  const usable = withEntriesOff(config, unavailableEntryIds(config));
  return publicDecision(selectTarget({ config: usable, readings: readReadings(), conv, now }));
}
