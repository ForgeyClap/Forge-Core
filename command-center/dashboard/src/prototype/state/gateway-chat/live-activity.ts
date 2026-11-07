/**
 * live-activity — the still-running-turn synthetic message (feat-live-stream).
 *
 * refactor-chat-split: split out of `gateway-chat.ts` — see that
 * file's own header for the full history. Depends on `turn-parsers.ts` (the base module) for
 * `ConversationDetail` and `toGatewayMessage`; `conversations.ts` and `send-controller.ts` both
 * depend on THIS file's `parseConversationDetail` (the one place a turn/event pair becomes a real
 * `ConversationDetail`, live activity folded in). Pure structural move: no behavior changed.
 */

import type { ChatMessage } from '@/prototype/types/prototype-types';

import { pickArray, pickBool, pickNumber, pickRecord, pickString } from '@/prototype/state/gateway-client';

import type { ChatMessageRoute, ConversationDetail } from './turn-parsers';
import { parseChatRoute, toGatewayMessage } from './turn-parsers';
import { mergeRouteSkips, parseRouteSkips } from './route-skips';
import type { ChatRouteSkip } from './route-skips';

export type { ChatRouteSkip, ChatRouteSkipReason } from './route-skips';

/**
 * App router (APP-ROUTER-DESIGN.md §4.7): the gateway writes a failed attempt 1 as a `route_attempt_failed`
 * event. An older build stored it as an assistant turn with `route.retried: true`; such a record is NOT
 * a real reply and is read as that event (see `parseConversationDetail`).
 */
function isRetriedAttempt(turn: Record<string, unknown>): boolean {
  const route = pickRecord(turn, ['route']);
  return route !== null && pickBool(route, ['retried']) === true;
}

/**
 * feat-live-stream (item 1): the id of the LAST user turn that has no real follow-up yet — no
 * assistant reply with the same `turn_id`, and no `stopped_by_user`/`spawn_error` event either.
 * Mirrors `pendingTurnResolved` (`send-controller.ts`) exactly (same three real-evidence checks,
 * inverted: "find the one turn that ISN'T resolved" instead of "is THIS specific turn resolved")
 * so both places agree on what "still running" means from the very same real turn/event records.
 * `null` when there is no user turn at all, or the last one already has a real follow-up.
 */
const TERMINAL_KINDS: ReadonlySet<string> = new Set(['stopped_by_user', 'spawn_error', 'route_exhausted', 'execution_not_started']);

function findPendingTurnId(turns: readonly Record<string, unknown>[], events: readonly Record<string, unknown>[]): string | null {
  const userTurnIds = turns
    .filter((t) => pickString(t, ['role']) === 'user')
    .map((t) => pickString(t, ['turn_id']))
    .filter((turnId): turnId is string => turnId !== null);
  if (userTurnIds.length === 0) return null;
  const lastUserTurnId = userTurnIds[userTurnIds.length - 1];

  const hasAssistantReply = turns.some(
    (t) => pickString(t, ['role']) === 'assistant' && pickString(t, ['turn_id']) === lastUserTurnId && !isRetriedAttempt(t),
  );
  if (hasAssistantReply) return null;

  const hasTerminalEvent = events.some((e) => {
    const kind = pickString(e, ['kind']);
    // App router: `route_exhausted` means nothing was started for this turn (no spawn), so it is final too.
    // `execution_not_started`: the gateway refused to start this turn, so nothing will ever answer it (Q7).
    return TERMINAL_KINDS.has(kind ?? '') && pickString(e, ['turn_id']) === lastUserTurnId;
  });
  if (hasTerminalEvent) return null;

  return lastUserTurnId;
}

/**
 * feat-live-stream (item 1): folds the real live `event` records `exec-bridge.mjs` now appends
 * DURING a run (kinds `file_edit`/`todo_snapshot`/`shell_command`/`shell_result` — see that
 * file's own `rl.on('line', ...)` handler) into the exact same shapes the FINAL closed turn's own
 * `file_edits`/`todos`/`shell_commands` fields carry, so the one synthetic live message below can
 * be built with `toGatewayMessage` — the same production mapping every other message already goes
 * through, not a second hand-rolled rendering path. Only events tagged with `turnId` are folded in
 * (a conversation's `events` array can carry a PRIOR turn's events too).
 */
function buildLiveActivityFields(
  events: readonly Record<string, unknown>[],
  turnId: string,
): {
  fileEdits: readonly Record<string, unknown>[];
  todos: readonly Record<string, unknown>[] | null;
  shellCommands: readonly Record<string, unknown>[];
  route: Record<string, unknown> | null;
  text: string;
} {
  const fileEdits: Record<string, unknown>[] = [];
  // App router: the live route of the NEWEST attempt (within one attempt a switch notice wins over a plain
  // selection) and that attempt's streamed own-model answer (`provider_delta`), so the notice appears
  // before the answer (§6.2 chat) and a failed attempt 1's text never runs into attempt 2's.
  let route: Record<string, unknown> | null = null;
  let routeAttempt = 0;
  let text = '';
  let todos: readonly Record<string, unknown>[] | null = null;
  const shellById = new Map<string, Record<string, unknown>>();
  const shellOrder: string[] = [];

  for (const event of events) {
    if (pickString(event, ['turn_id']) !== turnId) continue;
    const kind = pickString(event, ['kind']);
    const data = pickRecord(event, ['data']);
    if (data === null) continue;

    if (kind === 'route_switched' || kind === 'route_selected') {
      const attempt = pickNumber(data, ['attempt']) ?? 1;
      if (attempt > routeAttempt) text = '';
      if (attempt > routeAttempt || (attempt === routeAttempt && kind === 'route_switched')) {
        route = kind === 'route_switched' ? { ...data, switched: true } : data;
        routeAttempt = attempt;
      }
    } else if (kind === 'provider_delta') {
      text += pickString(data, ['text']) ?? '';
    } else if (kind === 'file_edit') {
      fileEdits.push(data);
    } else if (kind === 'todo_snapshot') {
      todos = pickArray(data, ['todos']);
    } else if (kind === 'shell_command') {
      const shellId = pickString(data, ['id']);
      const key = shellId ?? `idx-${shellOrder.length}`;
      shellOrder.push(key);
      shellById.set(key, data);
    } else if (kind === 'shell_result') {
      const shellId = pickString(data, ['id']);
      const existing = shellId !== null ? shellById.get(shellId) : undefined;
      if (shellId === null || existing === undefined) continue;
      shellById.set(shellId, { ...existing, result: pickString(data, ['result']), is_error: pickBool(data, ['is_error']) });
    }
  }

  const shellCommands = shellOrder.map((key) => shellById.get(key)).filter((v): v is Record<string, unknown> => v !== undefined);
  return { fileEdits, todos, shellCommands, route, text };
}

/**
 * feat-live-stream (item 1, the honesty core of this WP): while a turn is genuinely still
 * running, a real ONE synthetic assistant message is appended after every real turn — built with
 * the SAME `toGatewayMessage` mapping from real, already-recorded live events, never fabricated.
 * `text` stays empty (this WP only surfaces tool activity, never a guessed/partial reply body);
 * the message is suppressed entirely when there is genuinely nothing yet to show, so an active
 * run with no tool activity at all renders no extra bubble (honest silence, not an empty shell).
 */
function buildLiveActivityMessage(
  turns: readonly Record<string, unknown>[],
  events: readonly Record<string, unknown>[],
  pendingTurnId: string | null,
): ChatMessage | null {
  if (pendingTurnId === null) return null;
  const activity = buildLiveActivityFields(events, pendingTurnId);
  const hasActivity =
    activity.fileEdits.length > 0 || activity.todos !== null || activity.shellCommands.length > 0 || activity.route !== null || activity.text !== '';
  if (!hasActivity) return null;

  const message = toGatewayMessage(
    {
      type: 'turn',
      role: 'assistant',
      // Distinct from the real (still-pending) user turn's own id — never collides with it in a
      // keyed list, and never mistaken for the eventual real assistant turn once it closes.
      turn_id: `${pendingTurnId}-live`,
      created_at: new Date().toISOString(),
      // Real streamed text of an own model only (`provider_delta`); empty for a Claude turn, as before.
      text: activity.text,
      route: activity.route,
      file_edits: activity.fileEdits,
      todos: activity.todos,
      shell_commands: activity.shellCommands,
    },
    turns.length,
  ) as unknown as Record<string, unknown> & { isLiveActivity?: boolean };
  message.isLiveActivity = true;
  return message as unknown as ChatMessage;
}

/* ========================================================================== */
/*  App router: what each turn's events add to its message (§4.5, §4.7, §5.1)  */
/* ========================================================================== */

type Rec = Record<string, unknown>;

/** Why nothing in the router could take a turn (`route_exhausted.code`); an unknown value reads as 'unknown'. */
export type ChatRouteExhaustedCode = 'rate_limited' | 'ollama_down' | 'logged_out' | 'unknown';
const EXHAUSTED_CODES: ReadonlySet<string> = new Set<ChatRouteExhaustedCode>(['rate_limited', 'ollama_down', 'logged_out', 'unknown']);

/** A router "nothing could take this turn" notice (from a `route_exhausted` event). Never a guessed time. */
export interface ChatRouteExhausted {
  readonly resumeAt: string | null;
  readonly firstFreeLabel: string | null;
  readonly firstFreeAt: string | null;
  readonly code: ChatRouteExhaustedCode;
  /** Steps the router skipped before it found nothing (C1, `route_exhausted.data.skipped`); [] when not said. */
  readonly skipped?: readonly ChatRouteSkip[];
}

/** A failed attempt 1 the router retried elsewhere (`route_attempt_failed`): folded away, never hidden. */
export interface ChatRouteFailedAttempt {
  readonly route: ChatMessageRoute;
  readonly text: string;
}

/** The classified error (`forge_error`) of a turn's own final attempt, for the failure line. */
export interface ChatTurnError {
  readonly code: string;
  readonly resumeAt: string | null;
  readonly model: string | null;
}

/** Everything a turn's events add to the message that answers it. */
export interface ChatRouteTurn {
  readonly failedAttempt: ChatRouteFailedAttempt | null;
  /** Attempt 1 failed and Forge tried another entry, but none could start (§4.5 "nothing is left"). */
  readonly failoverTried: boolean;
  readonly exhausted: ChatRouteExhausted | null;
  readonly error: ChatTurnError | null;
  /** Every step skipped while routing this turn (all attempts, each once; C1). [] when nothing was skipped. */
  readonly skipped: readonly ChatRouteSkip[];
  /** The gateway could not start this turn at all (`execution_not_started`, attempt 1; Q7-FINISH). */
  readonly notStarted?: boolean;
}

const RETRY_SUFFIX = '-r2';
/** Events whose `data.skipped` lists router steps walked past (C1; `execution_not_started` since gateway 50c37eb). */
const SKIP_KINDS: ReadonlySet<string> = new Set(['route_selected', 'route_switched', 'route_exhausted', 'execution_not_started']);
const FAILED_OUTCOMES: ReadonlySet<string> = new Set(['rate_limited', 'logged_out', 'down', 'error']);

export function parseRouteExhausted(data: Rec): ChatRouteExhausted {
  const free = pickRecord(data, ['first_free']);
  const code = pickString(data, ['code']);
  return {
    resumeAt: pickString(data, ['resume_at']),
    firstFreeLabel: free ? pickString(free, ['label']) : pickString(data, ['first_free']),
    firstFreeAt: free ? pickString(free, ['resume_at']) : null,
    code: code !== null && EXHAUSTED_CODES.has(code) ? (code as ChatRouteExhaustedCode) : 'unknown',
    skipped: parseRouteSkips(data),
  };
}

interface TurnFacts {
  readonly info: ChatRouteTurn;
  /** The raw `forge_error` data the ErrorCard reads (normalized there). */
  readonly errorRaw: Rec | null;
  readonly stopped: boolean;
}

/**
 * Reads one turn's own events in order. The error is the LATEST `forge_error` of the attempt that is
 * the turn's answer now: after any failed attempt 1, and (when the answer record names it) with the same
 * request id, so attempt 1's limit never speaks for attempt 2.
 */
function turnFacts(turnEvents: readonly Rec[], finalRecord: Rec | null): TurnFacts {
  let failedAttempt: ChatRouteFailedAttempt | null = null;
  let exhausted: ChatRouteExhausted | null = null;
  let failoverTried = false;
  let stopped = false;
  let notStarted = false;
  let afterFail = 0;
  // The request id of the newest attempt the router started. The gateway starts attempt 2 BEFORE it writes
  // attempt 1's `route_attempt_failed`, so while a turn runs this, not the event order, says whose error counts.
  let attemptRequestId: string | null = null;
  let attemptNo = 0;
  const skipLists: (readonly ChatRouteSkip[])[] = [];
  turnEvents.forEach((event, index) => {
    const kind = pickString(event, ['kind']);
    const data = pickRecord(event, ['data']) ?? {};
    if (SKIP_KINDS.has(kind ?? '')) skipLists.push(parseRouteSkips(data));
    if (kind === 'route_selected' || kind === 'route_switched') {
      const attempt = pickNumber(data, ['attempt']) ?? 1;
      if (attempt >= attemptNo) {
        attemptNo = attempt;
        attemptRequestId = pickString(event, ['request_id']) ?? attemptRequestId;
      }
    } else if (kind === 'route_attempt_failed') {
      const route = parseChatRoute(pickRecord(data, ['route']));
      if (route !== null) failedAttempt = { route, text: pickString(data, ['text']) ?? '' };
      afterFail = index + 1;
    } else if (kind === 'route_exhausted') {
      exhausted = parseRouteExhausted(data);
      if ((pickString(event, ['request_id']) ?? '').endsWith(RETRY_SUFFIX)) failoverTried = true;
    } else if (kind === 'execution_not_started') {
      if (pickNumber(data, ['attempt']) === 2) failoverTried = true;
      else notStarted = true;
    } else if (kind === 'stopped_by_user') {
      stopped = true;
    }
  });
  const answerRequestId = (finalRecord !== null ? pickString(finalRecord, ['request_id']) : null) ?? attemptRequestId;
  let errorRaw: Rec | null = null;
  for (const event of turnEvents.slice(afterFail)) {
    if (pickString(event, ['kind']) !== 'forge_error') continue;
    const requestId = pickString(event, ['request_id']);
    if (answerRequestId !== null && requestId !== null && requestId !== answerRequestId) continue;
    errorRaw = pickRecord(event, ['data']) ?? errorRaw;
  }
  const code = errorRaw !== null ? pickString(errorRaw, ['code']) : null;
  const error: ChatTurnError | null =
    errorRaw !== null && code !== null ? { code, resumeAt: pickString(errorRaw, ['resume_at']), model: pickString(errorRaw, ['model']) } : null;
  return { info: { failedAttempt, failoverTried, exhausted, error, skipped: mergeRouteSkips(skipLists), notStarted }, errorRaw, stopped };
}

/**
 * The ErrorCard's error for the LAST turn: only while that turn still runs (its newest error), or when its
 * answer really failed. A turn that ended fine or that the user stopped has none, so an older turn's error
 * can never linger once a newer turn exists (this is read off the last message only).
 */
function lastTurnError(facts: TurnFacts, finalRecord: Rec | null): Rec | null {
  if (facts.stopped || facts.errorRaw === null) return null;
  if (finalRecord === null) return facts.errorRaw;
  if (pickString(finalRecord, ['stop_reason']) === 'stopped') return null;
  const route = parseChatRoute(pickRecord(finalRecord, ['route']));
  const failedRoute = route !== null && !route.retried && route.outcome !== null && FAILED_OUTCOMES.has(route.outcome);
  return (pickString(finalRecord, ['error']) ?? '').trim() !== '' || failedRoute ? facts.errorRaw : null;
}

function withFields(message: ChatMessage, fields: Rec): ChatMessage {
  return { ...(message as unknown as Rec), ...fields } as unknown as ChatMessage;
}

function syntheticMessage(turnId: string, suffix: string, createdAt: string, index: number, fields: Rec): ChatMessage {
  const base = toGatewayMessage({ type: 'turn', role: 'assistant', turn_id: `${turnId}-${suffix}`, created_at: createdAt, text: '' }, index);
  return withFields(base, fields);
}

function hasRouteFacts(info: ChatRouteTurn): boolean {
  return info.failedAttempt !== null || info.failoverTried || info.exhausted !== null || info.error !== null || info.skipped.length > 0 || info.notStarted === true;
}

interface TurnGroup {
  readonly id: string;
  readonly messages: ChatMessage[];
  final: Rec | null;
}

/**
 * One turn = its user message, then ONE answer: the assistant record, or the live message while it runs.
 * The turn's events are folded onto that answer (`routeTurn`). A turn with no answer at all gets one
 * synthetic message: the exhausted notice, or the folded attempt alone. The LAST message carries the
 * last turn's `chatError`.
 */
function assembleMessages(turns: readonly Rec[], events: readonly Rec[], live: ChatMessage | null, pendingTurnId: string | null): ChatMessage[] {
  const eventsByTurn = new Map<string, Rec[]>();
  for (const event of events) {
    const turnId = pickString(event, ['turn_id']);
    if (turnId === null) continue;
    const list = eventsByTurn.get(turnId) ?? [];
    list.push(event);
    eventsByTurn.set(turnId, list);
  }
  const groups: TurnGroup[] = [];
  const byId = new Map<string, TurnGroup>();
  turns.forEach((turn, index) => {
    const message = toGatewayMessage(turn, index);
    let group = byId.get(message.id);
    if (group === undefined) {
      group = { id: message.id, messages: [], final: null };
      byId.set(message.id, group);
      groups.push(group);
    }
    group.messages.push(message);
    if (pickString(turn, ['role']) === 'assistant') group.final = turn;
  });
  if (live !== null && pendingTurnId !== null) byId.get(pendingTurnId)?.messages.push(live);

  const out: ChatMessage[] = [];
  groups.forEach((group, groupIndex) => {
    const turnEvents = eventsByTurn.get(group.id) ?? [];
    const facts = turnFacts(turnEvents, group.final);
    const messages = [...group.messages];
    const hostIndex = messages.reduce((found, message, index) => (message.author === 'forge' ? index : found), -1);
    if (hostIndex >= 0) {
      if (hasRouteFacts(facts.info)) messages[hostIndex] = withFields(messages[hostIndex], { routeTurn: facts.info });
    } else if (facts.info.exhausted !== null || facts.info.failedAttempt !== null || facts.info.skipped.length > 0 || facts.info.notStarted === true) {
      const event = turnEvents.find((e) => pickString(e, ['kind']) === 'route_exhausted');
      const createdAt = (event && pickString(event, ['ts', 'at', 'created_at'])) ?? '';
      const fields: Rec = facts.info.exhausted !== null ? { routeExhausted: facts.info.exhausted, routeTurn: facts.info } : { routeTurn: facts.info };
      messages.push(syntheticMessage(group.id, facts.info.exhausted !== null ? 'exhausted' : 'attempt', createdAt, turns.length, fields));
    }
    if (groupIndex === groups.length - 1) {
      const last = messages.length - 1;
      messages[last] = withFields(messages[last], { chatError: lastTurnError(facts, group.final) });
    }
    out.push(...messages);
  });
  return out;
}

/** Reads the `routeExhausted` field of the one synthetic notice message of a turn nothing could take. */
export function readChatMessageRouteExhausted(message: ChatMessage): ChatRouteExhausted | null {
  const raw = message as unknown as Partial<{ routeExhausted: ChatRouteExhausted | null }>;
  return raw.routeExhausted && typeof raw.routeExhausted === 'object' ? raw.routeExhausted : null;
}

/** Reads what a turn's router events added to its answer; null for every other message. */
export function readChatMessageRouteTurn(message: ChatMessage): ChatRouteTurn | null {
  const raw = message as unknown as Partial<{ routeTurn: ChatRouteTurn | null }>;
  return raw.routeTurn && typeof raw.routeTurn === 'object' ? raw.routeTurn : null;
}

/** The last turn's classified error for the ErrorCard (raw; `normalizeChatError` validates it). */
export function readChatMessageChatError(message: ChatMessage): Rec | null {
  const raw = message as unknown as Partial<{ chatError: Rec | null }>;
  return raw.chatError && typeof raw.chatError === 'object' ? raw.chatError : null;
}

/** Legacy shape (before review finding 1): a retried attempt stored as an assistant record. */
function legacyAttemptEvent(turn: Rec): Rec {
  return { kind: 'route_attempt_failed', turn_id: pickString(turn, ['turn_id']), request_id: pickString(turn, ['request_id']), data: turn };
}

/** refactor-chat-split: glue so `conversations.ts` and `send-controller.ts` can both call this. */
export function parseConversationDetail(id: string, data: Record<string, unknown>): ConversationDetail {
  const rawTurns = pickArray(data, ['turns']);
  const rawEvents = pickArray(data, ['events']);
  const legacy = rawTurns.filter(isRetriedAttempt);
  const turns = legacy.length > 0 ? rawTurns.filter((turn) => !isRetriedAttempt(turn)) : rawTurns;
  const events = legacy.length > 0 ? [...legacy.map(legacyAttemptEvent), ...rawEvents] : rawEvents;
  const pendingTurnId = findPendingTurnId(turns, events);
  const liveMessage = buildLiveActivityMessage(turns, events, pendingTurnId);
  return {
    id,
    messages: assembleMessages(turns, events, liveMessage, pendingTurnId),
    turns,
    events,
  };
}
