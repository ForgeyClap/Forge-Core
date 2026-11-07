/**
 * route-copy — which notice a routed turn shows, and with which words (APP-ROUTER-DESIGN.md §4.5, §5.1).
 *
 * Pure: a `route` record (plus what the turn's events add) in, message keys + variables out, so the test
 * can walk every variant. The rules the copy keeps:
 *   - never a silent downgrade: a turn on an own model always says what it cannot do;
 *   - never an empty answer: an attempt that ended down / not signed in / at a limit / in an error says so
 *     in one line, with the way out, and links to the router settings;
 *   - never an invented clock time ("onbekend"), and a missing percentage is never 0.
 */

import type { MessageKey, MessageVars } from '@/i18n';
import type { ChatRouteExhausted, ChatTurnError } from '@/prototype/state/gateway-chat/live-activity';
import type { ChatMessageRoute } from '@/prototype/state/gateway-chat/turn-parsers';

export type CopyLine = readonly [MessageKey, MessageVars?];

export type NoticeVariant =
  | 'proactive'
  | 'limit'
  | 'to-model'
  | 'back'
  | 'login'
  | 'down'
  | 'switched'
  | 'not-retried'
  | 'first-model'
  | 'failed'
  | 'exhausted';

export interface NoticeCopy {
  readonly variant: NoticeVariant;
  readonly title: CopyLine | null;
  /** The one line that says this attempt did not answer, and what to do (shown right under the title). */
  readonly failure: CopyLine | null;
  readonly lines: readonly CopyLine[];
  /** Only for `not-retried`: offer "Ga verder op …". */
  readonly offerContinue: boolean;
  /** Link to the router settings (every failure and every exhausted notice). */
  readonly settingsLink: boolean;
  /** An icon that names the cause (Ollama off, not signed in); null = the variant's own icon. */
  readonly icon?: string | null;
}

const EXHAUSTED_ICON: Readonly<Record<ChatRouteExhausted['code'], string>> = {
  rate_limited: 'Hourglass',
  ollama_down: 'Cpu',
  logged_out: 'Lock',
  unknown: 'CircleAlert',
};

/** What the turn's own events add to its route record (see `live-activity.ts`). */
export interface RouteExtras {
  readonly failoverTried?: boolean;
  readonly exhausted?: ChatRouteExhausted | null;
  readonly error?: ChatTurnError | null;
}

const WINDOW_KEYS: Readonly<Record<string, MessageKey>> = {
  five_hour: 'appRouter.window.five_hour',
  seven_day: 'appRouter.window.seven_day',
  seven_day_opus: 'appRouter.window.seven_day_opus',
  seven_day_sonnet: 'appRouter.window.seven_day_sonnet',
};

const FAILED_OUTCOMES: ReadonlySet<string> = new Set(['rate_limited', 'logged_out', 'down', 'error']);

export interface CopyContext {
  /** Translate a key (window names are nested copy). */
  readonly t: (key: MessageKey, vars?: MessageVars) => string;
  readonly locale: string;
}

export function clockOrUnknown(iso: string | null, { t, locale }: CopyContext): string {
  if (iso) {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return date.toLocaleTimeString(locale === 'nl' ? 'nl-NL' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return t('chat.route.unknownTime');
}

function windowName(type: string | null, ctx: CopyContext): string {
  return ctx.t((type && WINDOW_KEYS[type]) || 'appRouter.window.other');
}

function capabilityLine(route: ChatMessageRoute): CopyLine | null {
  if (route.capability === 'answers-only') return ['chat.route.answersOnly'];
  if (route.capability === 'read-answer') return ['chat.route.readAnswer'];
  return null;
}

function isModelTarget(route: ChatMessageRoute): boolean {
  return route.kind === 'provider-model' || route.kind === 'codex-account' || (route.capability !== null && route.capability !== 'full');
}

/** Render rule (review): switched, OR the first turn of a conversation that runs on something less than a full Claude account. */
function isFirstOnModel(route: ChatMessageRoute): boolean {
  if (route.switched || route.reason !== 'first' || route.capability === 'full') return false;
  return route.capability !== null || route.kind !== 'claude-account';
}

/** The attempt that is this turn's answer ended without one (not a retried attempt, not a Stop). */
export function routeFailed(route: ChatMessageRoute): boolean {
  return !route.retried && route.outcome !== null && FAILED_OUTCOMES.has(route.outcome);
}

function isOllama(route: ChatMessageRoute): boolean {
  return route.kind === 'provider-model' && /ollama/i.test(`${route.targetId} ${route.label}`);
}

/** "Ollama draait niet op deze computer — start Ollama of kies een ander model." and its siblings. */
export function failureLine(route: ChatMessageRoute, error: ChatTurnError | null, ctx: CopyContext): CopyLine {
  const to = route.label;
  const code = error?.code ?? null;
  if (code === 'ollama_down' || (code === null && route.outcome === 'down' && isOllama(route))) return ['chat.route.failed.ollamaDown'];
  if (code === 'model_not_pulled') return ['chat.route.failed.notPulled', { model: error?.model ?? route.model ?? to }];
  if (code === 'rate_limited' || route.outcome === 'rate_limited') return ['chat.route.failed.limit', { to, time: clockOrUnknown(error?.resumeAt ?? null, ctx) }];
  if (code === 'logged_out' || route.outcome === 'logged_out') return ['chat.route.failed.loggedOut', { to }];
  if (code === 'offline' || route.outcome === 'down') return ['chat.route.failed.down', { to }];
  return ['chat.route.failed.error', { to }];
}

/** The parts of a notice before the outcome is known: its variant, title and the one "why" line. */
interface NoticeParts {
  readonly variant: NoticeVariant;
  readonly title: CopyLine | null;
  readonly reason: CopyLine | null;
}

function switchParts(route: ChatMessageRoute, ctx: CopyContext): NoticeParts | null {
  if (!route.switched) {
    if (!isFirstOnModel(route)) return null;
    const key: MessageKey = route.capability === 'read-answer' ? 'chat.route.firstOnCodex' : 'chat.route.firstOnModel';
    return { variant: 'first-model', title: null, reason: [key, { model: route.label }] };
  }
  const to = route.label;
  const from = route.fromLabel ?? route.fromTargetId ?? '';
  if (route.reason === 'return') return { variant: 'back', title: ['chat.route.backTitle', { to }], reason: [isModelTarget(route) ? 'chat.route.backModel' : 'chat.route.back'] };
  const title: CopyLine = ['chat.route.switched', { to }];
  const time = clockOrUnknown(route.fromResumeAt, ctx);
  if (isModelTarget(route) && (route.reason === 'switch-limit' || route.reason === 'switch-threshold' || route.reason === 'switch-login')) {
    return { variant: 'to-model', title, reason: ['chat.route.toModel', { time }] };
  }
  if (route.reason === 'switch-threshold') {
    const window = windowName(route.fromWindow, ctx);
    const reason: CopyLine =
      route.fromPct !== null ? ['chat.route.proactive', { from, pct: Math.round(route.fromPct), window }] : ['chat.route.proactiveNoPct', { from, window }];
    return { variant: 'proactive', title, reason };
  }
  if (route.reason === 'switch-limit') {
    return { variant: 'limit', title, reason: route.attempt >= 2 ? ['chat.route.limitRetried', { from, time }] : ['chat.route.limitBefore', { from, time }] };
  }
  if (route.reason === 'switch-login') return { variant: 'login', title, reason: ['chat.route.login', { from }] };
  if (route.reason === 'switch-down') return { variant: 'down', title, reason: ['chat.route.down', { from }] };
  return { variant: 'switched', title, reason: null };
}

function present(lines: readonly (CopyLine | null)[]): readonly CopyLine[] {
  return lines.filter((line): line is CopyLine => line !== null);
}

/** The notice for one routed turn, or null when the turn needs none (a plain sticky turn that answered). */
export function routeNoticeCopy(route: ChatMessageRoute, ctx: CopyContext, extras: RouteExtras = {}): NoticeCopy | null {
  const parts = switchParts(route, ctx);
  if (!routeFailed(route)) {
    if (parts === null) return null;
    const handover: CopyLine | null =
      route.handover !== null && route.handover.turns > 0 ? ['chat.route.handover', { to: route.label, n: route.handover.turns }] : null;
    // The first-turn line already says what the model cannot do; every other notice adds it.
    const capability = parts.variant === 'first-model' ? null : capabilityLine(route);
    return { ...parts, failure: null, lines: present([parts.reason, capability, handover]), offerContinue: false, settingsLink: false };
  }

  // The answer failed. Forge stopped by itself midway (no failover tried): the existing "not retried" line.
  if (parts === null && !extras.failoverTried && route.outcome !== 'error') {
    const key: MessageKey = route.outcome === 'rate_limited' ? 'chat.route.notRetried' : 'chat.route.notRetriedOther';
    return { variant: 'not-retried', title: null, failure: null, lines: [[key, { from: route.label }]], offerContinue: true, settingsLink: false };
  }

  // A failure line instead of an empty answer; a model that never answered keeps no capability/handover line.
  const lines: (CopyLine | null)[] = [parts?.reason ?? null];
  if (extras.failoverTried) {
    lines.push(['chat.route.failoverNothingLeft']);
    // A to-model / limit switch already named the limit and its time; do not say it twice.
    const exhausted = extras.exhausted ?? null;
    const repeatsLimit = exhausted?.code === 'rate_limited' && parts !== null && parts.reason !== null;
    if (exhausted !== null && !repeatsLimit) lines.push(...exhaustedLines(exhausted, ctx));
  }
  return {
    variant: 'failed',
    title: parts?.title ?? null,
    failure: failureLine(route, extras.error ?? null, ctx),
    lines: present(lines),
    offerContinue: false,
    settingsLink: true,
  };
}

/** The words for "nothing in the router could take this turn", picked by the gateway's `code` (§4.5). */
function exhaustedLines(notice: ChatRouteExhausted, ctx: CopyContext): readonly CopyLine[] {
  switch (notice.code) {
    case 'ollama_down':
      return [['chat.route.exhaustedOllama'], ['chat.route.exhaustedOllamaHint']];
    case 'logged_out':
      return [['chat.route.exhaustedLogin'], ['chat.route.loginStep1'], ['chat.route.loginStep2'], ['chat.route.loginStep3']];
    case 'rate_limited': {
      const at = notice.firstFreeAt ?? notice.resumeAt;
      return [
        notice.firstFreeLabel !== null && at !== null
          ? ['chat.route.exhausted', { label: notice.firstFreeLabel, time: clockOrUnknown(at, ctx) }]
          : ['chat.route.exhaustedUnknown'],
      ];
    }
    default:
      return [['chat.route.exhaustedOther'], ['chat.route.exhaustedOtherHint']];
  }
}

/** The notice of a turn nothing in the router could take: what happened (emphasised), then the way out. */
export function exhaustedCopy(notice: ChatRouteExhausted, ctx: CopyContext): NoticeCopy {
  const [headline, ...rest] = exhaustedLines(notice, ctx);
  return {
    variant: 'exhausted',
    title: null,
    failure: headline ?? null,
    lines: rest,
    offerContinue: false,
    settingsLink: true,
    icon: EXHAUSTED_ICON[notice.code],
  };
}

/** The small "via …" badge on every routed answer; an own model always carries what it cannot do. */
export function routeBadge(route: ChatMessageRoute): CopyLine {
  if (route.capability === 'answers-only') return ['chat.route.badgeAnswers', { label: route.label }];
  if (route.capability === 'read-answer') return ['chat.route.badgeRead', { label: route.label }];
  return ['chat.route.badge', { label: route.label }];
}

/**
 * Whether this turn shows a route notice above its answer (the same rule `routeNoticeCopy` returns non-null
 * by, without the turn extras, which only change a notice, never whether there is one).
 */
export function hasRouteNotice(route: ChatMessageRoute): boolean {
  return route.switched || isFirstOnModel(route) || routeFailed(route);
}

/** "Ollama" out of "Ollama · llama3.1": the provider part of a model label; any other label stays whole. */
export function routeProvider(route: ChatMessageRoute): string {
  if (route.kind !== 'provider-model') return route.label;
  const [provider = ''] = route.label.split(' · ');
  return provider.trim() || route.label;
}

/**
 * The badge under a notice (final review finding 3, DESIGN.md §3.2): the notice right above already names the
 * model and what it cannot do, so the badge says only "via Ollama".
 */
export function routeBadgeShort(route: ChatMessageRoute): CopyLine {
  return ['chat.route.badge', { label: routeProvider(route) }];
}

/** "Onderbroken antwoord van {from} ({why})" for a failed attempt 1 that was retried elsewhere. */
export function foldedTitle(route: ChatMessageRoute, ctx: CopyContext): CopyLine {
  const outcome = route.outcome === null || route.outcome === 'ok' ? 'error' : route.outcome;
  return ['chat.route.folded', { from: route.label, why: ctx.t(`chat.route.why.${outcome}` as MessageKey) }];
}
