/**
 * RouteNotice — the notice a routed turn shows above its answer (APP-ROUTER-DESIGN.md §4.5, §5.1, §6.2 chat).
 *
 * Two layouts (redesign DESIGN.md §3.2): Eenvoudig shows ONE line between turns — the icon, the
 * headline with the model's capability words kept whole ("(alleen antwoorden)" never shortens), and
 * "Meer info", which opens the other lines in place. Actions (the settings link, "Ga verder op …") stay
 * visible. Uitgebreid keeps the full card with every line.
 *
 * Tone: information (`aria-live="polite"`), except when the attempt that should have answered did not:
 * then the card says so in one emphasised line with the way out and links to the router settings, so a
 * failed switch is never an empty bubble. Copy from `route-copy.ts`. The one button ("Ga verder op …",
 * only after a turn Forge stopped midway and did NOT retry by itself) sends "Ga verder waar je gebleven
 * was." through the existing chat send path; without a live send path (fixtures) there is no button
 * rather than a dead one. Also exports the exhausted notice, the badge and the folded failed attempt.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { Button, Disclosure, Icon } from '@/components/primitives';
import type { MessageKey, MessageVars } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { useUiMode } from '@/state/ui-mode';
import { readRouterStatus } from '@/prototype/state/adapter/app-router';
import { useChatSend } from '@/prototype/state/chat-send';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import type { ChatRouteExhausted, ChatRouteTurn } from '@/prototype/state/gateway-chat/live-activity';
import type { ChatMessageRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import { skipsOf } from '@/prototype/state/gateway-chat/route-skips';
import type { ChatRouteSkip } from '@/prototype/state/gateway-chat/route-skips';

import { exhaustedCopy, foldedTitle, routeBadge, routeBadgeShort, routeNoticeCopy } from './route-copy';
import type { CopyLine, NoticeCopy, NoticeVariant } from './route-copy';
import { RouteSkipLine } from './RouteSkipLine';

import './route-notice.css';

/** Where "Router-instellingen" opens (the settings page scrolls the router into view). */
export const ROUTER_SETTINGS_HASH = '#/settings?focus=router';

const ICON_BY_VARIANT: Partial<Record<NoticeVariant, string>> = {
  exhausted: 'Hourglass',
  'not-retried': 'Hourglass',
  failed: 'CircleAlert',
};

type Translate = (key: MessageKey, vars?: MessageVars) => string;

/**
 * Splits a "via {label} …" string into what comes before the label and the capability words after it, so
 * the label alone can shorten. Locale-proof: the template is rendered with a marker in place of `{label}`.
 */
function splitAroundLabel(t: Translate, key: MessageKey, label: string): { before: string; label: string; after: string } {
  const marker = '\u0000';
  const [before = '', after = ''] = t(key, { label: marker }).split(marker);
  return { before, label, after: after.trim() };
}

/** The capability words of a route ("(alleen antwoorden)"), from the badge copy; '' for a full account. */
function capabilitySuffix(route: ChatMessageRoute | null, t: Translate): string {
  if (route === null) return '';
  const [key] = routeBadge(route);
  return key === 'chat.route.badge' ? '' : splitAroundLabel(t, key, route.label).after;
}

interface NoticeCardProps {
  readonly copy: NoticeCopy;
  readonly route?: ChatMessageRoute | null;
  readonly children?: ReactNode;
}

/* role="note" (redesign, 4D-1): a notice belongs to one answer inside the conversation log. As a bare <aside>
   it was a complementary landmark, and two notices in one thread repeated the same landmark name (axe
   landmark-unique). A note keeps its name and its polite announcement without adding a landmark. */
function NoticeCard({ copy, route = null, children }: NoticeCardProps) {
  const { t } = useLocale();
  const { isAdvanced } = useUiMode();
  const say = (line: readonly [MessageKey, MessageVars?]) => t(line[0], line[1]);
  const icon = copy.icon ?? ICON_BY_VARIANT[copy.variant] ?? 'Waypoints';
  const settings = copy.settingsLink ? (
    <a className="fw-route-notice__link" href={ROUTER_SETTINGS_HASH}>
      {t('chat.route.settings')}
    </a>
  ) : null;

  if (!isAdvanced) {
    // One line: the news (the failure, else the title, else the first line), plus the capability words
    // unless the headline already says them (a first-turn line ends in ": dat kan alleen antwoorden").
    const headline = copy.failure ?? copy.title ?? copy.lines[0] ?? null;
    const rest = [copy.failure ? copy.title : null, ...copy.lines.filter((line) => line !== headline)].filter(
      (line): line is CopyLine => line !== null,
    );
    const suffix = copy.variant === 'first-model' || copy.failure !== null ? '' : capabilitySuffix(route, t);
    const actions = children || settings;
    return (
      <aside className="fw-route-notice" data-layout="line" data-variant={copy.variant} role="note" aria-live="polite" aria-label={t('chat.route.noticeLabel')}>
        <Icon name={icon} size="sm" className="fw-route-notice__line-icon" />
        {headline ? (
          <p className="fw-route-notice__headline">
            <span className="fw-route-notice__head-text">{say(headline)}</span>
            {suffix ? <span className="fw-route-notice__cap"> {suffix}</span> : null}
          </p>
        ) : null}
        {rest.length > 0 ? (
          <Disclosure className="fw-route-notice__more" label={t('rd.settings.moreInfo')} openLabel={t('rd.settings.lessInfo')}>
            {rest.map((line) => (
              <p key={line[0]} className="fw-route-notice__line">
                {say(line)}
              </p>
            ))}
          </Disclosure>
        ) : null}
        {actions ? (
          <div className="fw-route-notice__actions">
            {children}
            {settings}
          </div>
        ) : null}
      </aside>
    );
  }

  return (
    <aside className="fw-route-notice" data-layout="card" data-variant={copy.variant} role="note" aria-live="polite" aria-label={t('chat.route.noticeLabel')}>
      <span className="fw-route-notice__icon" aria-hidden="true">
        <Icon name={icon} size="sm" />
      </span>
      <div className="fw-route-notice__body">
        {copy.title ? <p className="fw-route-notice__title">{say(copy.title)}</p> : null}
        {copy.failure ? <p className="fw-route-notice__failure">{say(copy.failure)}</p> : null}
        {copy.lines.map((line) => (
          <p key={line[0]} className="fw-route-notice__line">
            {say(line)}
          </p>
        ))}
        {children ? <div className="fw-route-notice__actions">{children}</div> : null}
        {settings ? <div className="fw-route-notice__actions">{settings}</div> : null}
      </div>
    </aside>
  );
}

/** The `{to}` of "Ga verder op {to}": the router's own next choice for this conversation (one read). */
function useNextLabel(enabled: boolean): string | null {
  const { state } = usePrototype();
  const conversationId = state.activeConversationId;
  const [next, setNext] = useState<{ readonly key: string; readonly label: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || conversationId === '') return undefined;
    let cancelled = false;
    void readRouterStatus(conversationId).then((status) => {
      if (cancelled) return;
      const label = status?.next?.kind === 'target' ? status.next.label : null;
      setNext({ key: conversationId, label });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, conversationId]);
  return next !== null && next.key === conversationId ? next.label : null;
}

export interface RouteNoticeProps {
  readonly route: ChatMessageRoute;
  /** What the turn's own events add: a failover attempt, the exhausted reason, the classified error. */
  readonly turn?: ChatRouteTurn | null;
  /** The continue button is only offered on the newest message of the thread. */
  readonly isLast: boolean;
  /** Q7-FINISH: a failed answer with no text carries its retry here, not in a bare header; null = no retry path. */
  readonly onRetry?: (() => void) | null;
}

export function RouteNotice({ route, turn = null, isLast, onRetry = null }: RouteNoticeProps) {
  const { t, locale } = useLocale();
  const { dispatch } = usePrototype();
  const chat = useChatSend();
  const copy = routeNoticeCopy(route, { t, locale }, { failoverTried: turn?.failoverTried, exhausted: turn?.exhausted, error: turn?.error });
  const wantsContinue = copy !== null && copy.offerContinue && isLast && chat !== null;
  const nextLabel = useNextLabel(wantsContinue);
  const [sending, setSending] = useState(false);
  // Q6-UI: the steps skipped while routing this reply (an own API removed / off, costs not confirmed).
  const skipLine = <RouteSkipLine skipped={skipsOf(turn?.skipped, route.skipped)} />;
  if (copy === null) return skipLine;

  async function continueOn() {
    if (chat === null) return;
    setSending(true);
    const outcome = await chat.send(t('chat.route.continueText'));
    setSending(false);
    if (!outcome.ok && outcome.error !== null) {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title: t('chat.route.continueFailed'), detail: outcome.error, icon: 'TriangleAlert' } });
    }
  }

  return (
    <>
      <NoticeCard copy={copy} route={route}>
        {wantsContinue ? (
          <Button size="sm" variant="ghost" icon="CornerDownRight" onClick={() => void continueOn()} disabled={sending || chat.run.active}>
            {nextLabel ? t('chat.route.continueOn', { to: nextLabel }) : t('chat.route.continue')}
          </Button>
        ) : onRetry !== null ? (
          <RetryButton onRetry={onRetry} />
        ) : null}
      </NoticeCard>
      {skipLine}
    </>
  );
}

/** `turnSkipped`: every skip of the turn (all attempts, merged once), so a failover's skips are not lost. */
export function RouteExhaustedNotice({ notice, turnSkipped }: { readonly notice: ChatRouteExhausted; readonly turnSkipped?: readonly ChatRouteSkip[] }) {
  const { t, locale } = useLocale();
  return (
    <>
      <NoticeCard copy={exhaustedCopy(notice, { t, locale })} />
      <RouteSkipLine skipped={skipsOf(turnSkipped, notice.skipped)} />
    </>
  );
}

function RetryButton({ onRetry }: { readonly onRetry: () => void }) {
  const { t } = useLocale();
  return (
    <Button size="sm" variant="ghost" icon="RefreshCw" onClick={onRetry}>
      {t('chat.route.retry')}
    </Button>
  );
}

const NOT_STARTED_COPY: NoticeCopy = {
  variant: 'failed',
  title: null,
  failure: ['chat.route.notStarted'],
  lines: [],
  offerContinue: false,
  settingsLink: true,
  icon: 'CircleAlert',
};

/**
 * Q7-FINISH: a turn the gateway could not start at all (`execution_not_started`, attempt 1). One plain line that
 * says so and what to do, "Opnieuw proberen" when there is a real retry path, the router settings link, and the
 * skipped steps underneath. Never a silent skip line on its own, never a busy indicator (nothing runs).
 */
export function RouteNotStartedNotice({ skipped, onRetry = null }: { readonly skipped: readonly ChatRouteSkip[]; readonly onRetry?: (() => void) | null }) {
  return (
    <>
      <NoticeCard copy={NOT_STARTED_COPY}>{onRetry !== null ? <RetryButton onRetry={onRetry} /> : null}</NoticeCard>
      <RouteSkipLine skipped={skipped} />
    </>
  );
}

/**
 * "via Werk", "via Ollama · llama3.1 (alleen antwoorden)". Only the "via {label}" part may shorten; the
 * capability words sit in their own `flex: none` span, so they are never cut (DESIGN.md §3.2).
 * The full text also stays in the tooltip. Under a route notice (`besideNotice`) the badge says only the
 * provider ("via Ollama"): the notice right above already names the model and its capability words.
 */
export function RouteBadge({ route, besideNotice = false }: { readonly route: ChatMessageRoute; readonly besideNotice?: boolean }) {
  const { t } = useLocale();
  const [fullKey, fullVars] = routeBadge(route);
  const text = t(fullKey, fullVars);
  const [key, vars] = besideNotice ? routeBadgeShort(route) : [fullKey, fullVars];
  const parts = splitAroundLabel(t, key, String(vars?.label ?? route.label));
  return (
    <span className="fw-route-badge" data-capability={route.capability ?? undefined} title={`${t('chat.route.badgeTitle')}: ${text}`}>
      <Icon name="Waypoints" size="xs" />
      <span className="fw-route-badge__label">
        {parts.before}
        {parts.label}
      </span>
      {parts.after ? <span className="fw-route-badge__cap"> {parts.after}</span> : null}
    </span>
  );
}

/** A failed attempt 1 that was retried elsewhere: folded away, never hidden; an attempt without text says so. */
export function FoldedAttempt({ route, children = null }: { readonly route: ChatMessageRoute; readonly children?: ReactNode }) {
  const { t, locale } = useLocale();
  const [key, vars] = foldedTitle(route, { t, locale });
  return (
    <details className="fw-route-folded" data-outcome={route.outcome ?? undefined}>
      <summary className="fw-route-folded__summary">
        <Icon name="ChevronRight" size="sm" className="fw-route-folded__chevron" />
        <span>{t(key, vars)}</span>
      </summary>
      <div className="fw-route-folded__body">{children ?? <p className="fw-route-folded__empty">{t('chat.route.foldedEmpty')}</p>}</div>
    </details>
  );
}
