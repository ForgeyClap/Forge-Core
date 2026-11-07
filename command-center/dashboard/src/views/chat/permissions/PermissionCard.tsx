/**
 * Permission cards (WP B3, plan §4.4).
 *
 * `PermissionCards` is the one component a chat mounts: one pending request renders a single
 * `PermissionCard`, two or more render one `PermissionGroupCard` ("Het team wil 4 dingen doen")
 * with an answer per line and one "Alles toestaan". The first line of every request comes from the
 * fixed rule table in `permission-rules.ts`; the raw command sits folded away under "Technische
 * details". A request that nobody answers keeps the work paused (Gepauzeerd), never failed: the
 * card says so in its own footer.
 */

import { useCallback, useId, useState } from 'react';

import { Button, Icon } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { ROLE_STAMPS, roleFromName } from '@/views/team/team-data';

import { formatClock } from '../errors/error-catalogue';
import { describePermission } from './permission-rules';
import type { PermissionBadge, PermissionDescription } from './permission-rules';
import type { AnswerPermission, PendingPermission, PermissionBehavior } from './permission-types';
import '../errors/errors.css';
import './permissions.css';

type AnswerState = 'idle' | 'sending' | 'failed';

const BADGE_ICON: Readonly<Record<PermissionBadge, string>> = {
  internet: 'Globe',
  deletes: 'Trash2',
  outside: 'FolderOpen',
};

/** Per-request answer state, so a slow or failed answer is visible on the right line. */
function useAnswers(onAnswer: AnswerPermission) {
  const [states, setStates] = useState<Readonly<Record<string, AnswerState>>>({});
  const answer = useCallback(
    async (id: string, behavior: PermissionBehavior) => {
      setStates((prev) => ({ ...prev, [id]: 'sending' }));
      try {
        await onAnswer(id, behavior);
        setStates((prev) => ({ ...prev, [id]: 'idle' }));
      } catch {
        setStates((prev) => ({ ...prev, [id]: 'failed' }));
      }
    },
    [onAnswer],
  );
  return { states, answer };
}

function useSummary() {
  const { t } = useLocale();
  return useCallback(
    (description: PermissionDescription) => t(`chatCards.permissions.summary.${description.kind}` as MessageKey, description.vars),
    [t],
  );
}

function RoleStamp({ agent }: { agent: string | null | undefined }) {
  const { t } = useLocale();
  const role = roleFromName(agent);
  const name = role === null ? t('chatCards.permissions.assistant') : t(`team.roles.${role}`);
  const stamp = role === null ? 'Fo' : ROLE_STAMPS[role];
  return (
    <span className="fw-perm__who">
      <span className="fw-perm__stamp" aria-hidden="true">
        {stamp}
      </span>
      <span className="fw-perm__who-name">{name}</span>
    </span>
  );
}

function Badges({ badges }: { badges: readonly PermissionBadge[] }) {
  const { t } = useLocale();
  if (badges.length === 0) return null;
  return (
    <ul className="fw-perm__badges" aria-label={t('chatCards.permissions.badgesLabel')}>
      {badges.map((badge) => (
        <li key={badge} className="fw-perm__badge" data-badge={badge}>
          <Icon name={BADGE_ICON[badge]} size="xs" />
          <span>{t(`chatCards.permissions.badge.${badge}`)}</span>
        </li>
      ))}
    </ul>
  );
}

function Technical({ text }: { text: string }) {
  const { t } = useLocale();
  return (
    <details className="fw-cards-tech fw-perm__tech">
      <summary>{t('chatCards.permissions.technical')}</summary>
      <pre className="fw-cards-pre fg-machine" data-log-text="">
        {text}
      </pre>
    </details>
  );
}

function MoreLine({ count }: { count: number }) {
  const { t } = useLocale();
  if (count <= 0) return null;
  return (
    <p className="fw-perm__more">
      {count === 1 ? t('chatCards.permissions.moreOne') : t('chatCards.permissions.moreMany', { count })}
    </p>
  );
}

/**
 * "Altijd toestaan in dit gesprek" is offered only for ONE command: a rule learned from a chained
 * line (`npm install && rm -rf dist`) could later let through a part the user never looked at.
 */
function canAllowSession(description: PermissionDescription, request: PendingPermission): boolean {
  // Contract addition 2026-11-02: the gateway says whether it would remember this request at all
  // (shell commands never are). Absent = older gateway, keep the old rule.
  return description.moreCommands === 0 && request.rememberable !== false;
}

function SessionNote({ description }: { description: PermissionDescription }) {
  const { t } = useLocale();
  // Two honest reasons: a chained line (UI rule) or a request the gateway would never remember (contract flag).
  const key = description.moreCommands > 0 ? 'chatCards.permissions.sessionNotForChain' : 'chatCards.permissions.sessionNotRememberable';
  return <p className="fw-perm__session-note">{t(key)}</p>;
}

function AnswerNote({ state }: { state: AnswerState | undefined }) {
  const { t } = useLocale();
  return (
    <p className="fw-perm__note" role="status" data-state={state ?? 'idle'}>
      {state === 'sending'
        ? t('chatCards.permissions.sending')
        : state === 'failed'
          ? t('chatCards.permissions.failed')
          : t('chatCards.permissions.pausedNote')}
    </p>
  );
}

/* ------------------------------------------------------------------ single */

export interface PermissionCardProps {
  readonly request: PendingPermission;
  /** The conversation's project folder, for the "buiten deze map" badge. */
  readonly projectDir?: string | null;
  readonly onAnswer: AnswerPermission;
}

export function PermissionCard({ request, projectDir, onAnswer }: PermissionCardProps) {
  const { t, locale } = useLocale();
  const summaryOf = useSummary();
  const { states, answer } = useAnswers(onAnswer);
  const titleId = useId();
  const description = describePermission(request, projectDir);
  const state = states[request.id];
  const busy = state === 'sending';
  const since = formatClock(request.created_at, locale);
  const role = roleFromName(request.agent);
  const askedBy =
    request.agent && role !== null
      ? t('chatCards.permissions.askedBy', { role: t(`team.roles.${role}`) })
      : t('chatCards.permissions.askedByAssistant');

  return (
    <article className="fw-perm" aria-labelledby={titleId} data-permission-id={request.id}>
      <header className="fw-perm__head">
        <span className="fw-perm__eyebrow">
          <span className="fw-perm__pulse" aria-hidden="true" />
          {t('chatCards.permissions.eyebrow')}
        </span>
        <span className="fw-perm__meta">
          {askedBy}
          {since ? ` · ${t('chatCards.permissions.since', { time: since })}` : ''}
        </span>
      </header>
      <h3 className="fw-perm__summary" id={titleId} data-log-text="">
        {summaryOf(description)}
      </h3>
      <MoreLine count={description.moreCommands} />
      <Badges badges={description.badges} />
      <Technical text={description.technical} />
      <div className="fw-perm__actions">
        <Button variant="primary" disabled={busy} onClick={() => void answer(request.id, 'allow')}>
          {t('chatCards.permissions.allow')}
        </Button>
        {canAllowSession(description, request) ? (
          <Button variant="ghost" disabled={busy} onClick={() => void answer(request.id, 'allow_session')}>
            {t('chatCards.permissions.allowSession')}
          </Button>
        ) : null}
        <Button variant="quiet" disabled={busy} onClick={() => void answer(request.id, 'deny')}>
          {t('chatCards.permissions.deny')}
        </Button>
      </div>
      {canAllowSession(description, request) ? null : <SessionNote description={description} />}
      <AnswerNote state={state} />
    </article>
  );
}

/* ------------------------------------------------------------------ group */

export interface PermissionGroupCardProps {
  readonly requests: readonly PendingPermission[];
  readonly projectDir?: string | null;
  readonly onAnswer: AnswerPermission;
}

export function PermissionGroupCard({ requests, projectDir, onAnswer }: PermissionGroupCardProps) {
  const { t } = useLocale();
  const summaryOf = useSummary();
  const { states, answer } = useAnswers(onAnswer);
  const titleId = useId();
  const anyBusy = requests.some((request) => states[request.id] === 'sending');
  const anyFailed = requests.some((request) => states[request.id] === 'failed');

  const allowAll = () => {
    for (const request of requests) void answer(request.id, 'allow');
  };

  return (
    <article className="fw-perm fw-perm--group" aria-labelledby={titleId}>
      <header className="fw-perm__head">
        <span className="fw-perm__eyebrow">
          <span className="fw-perm__pulse" aria-hidden="true" />
          {t('chatCards.permissions.eyebrow')}
        </span>
      </header>
      <h3 className="fw-perm__group-title" id={titleId}>
        {t('chatCards.permissions.groupTitle', { count: requests.length })}
      </h3>
      <p className="fw-perm__lead">{t('chatCards.permissions.groupLead')}</p>
      <ol className="fw-perm__list" aria-label={t('chatCards.permissions.listLabel')}>
        {requests.map((request) => {
          const description = describePermission(request, projectDir);
          const busy = states[request.id] === 'sending';
          return (
            <li key={request.id} className="fw-perm__item" data-permission-id={request.id} data-state={states[request.id] ?? 'idle'}>
              <div className="fw-perm__item-main">
                <RoleStamp agent={request.agent} />
                <p className="fw-perm__item-summary" data-log-text="">
                  {summaryOf(description)}
                </p>
                <MoreLine count={description.moreCommands} />
                <Badges badges={description.badges} />
                {canAllowSession(description, request) ? null : <SessionNote description={description} />}
                <Technical text={description.technical} />
              </div>
              <div className="fw-perm__item-actions">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void answer(request.id, 'allow')}>
                  {t('chatCards.permissions.allow')}
                </Button>
                {canAllowSession(description, request) ? (
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={busy}
                    title={t('chatCards.permissions.allowSession')}
                    onClick={() => void answer(request.id, 'allow_session')}
                  >
                    {t('chatCards.permissions.allowSessionShort')}
                  </Button>
                ) : null}
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => void answer(request.id, 'deny')}>
                  {t('chatCards.permissions.deny')}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="fw-perm__actions">
        <Button variant="primary" disabled={anyBusy} onClick={allowAll}>
          {t('chatCards.permissions.allowAll')}
        </Button>
      </div>
      <AnswerNote state={anyBusy ? 'sending' : anyFailed ? 'failed' : 'idle'} />
    </article>
  );
}

/* ------------------------------------------------------------------ entry */

export interface PermissionCardsProps {
  readonly pending: readonly PendingPermission[];
  readonly projectDir?: string | null;
  readonly onAnswer: AnswerPermission;
}

/** What a chat mounts: nothing, one card, or one group card. Oldest request first. */
export function PermissionCards({ pending, projectDir, onAnswer }: PermissionCardsProps) {
  if (pending.length === 0) return null;
  const ordered = [...pending].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (ordered.length === 1) return <PermissionCard request={ordered[0]} projectDir={projectDir} onAnswer={onAnswer} />;
  return <PermissionGroupCard requests={ordered} projectDir={projectDir} onAnswer={onAnswer} />;
}
