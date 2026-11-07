/**
 * SessionRail — the chat's list of conversations for the active project (WP B3, plan §4.4).
 *
 * Each row shows the title and the last activity. Clicking a row opens that conversation; the next
 * message continues the same Claude conversation (the gateway adds `--resume`). Per row: rename
 * (inline field) and "Aftakken" (a new conversation that remembers everything so far, gateway
 * `--fork-session`). The search box filters on the title instantly and, on Enter or after a short
 * pause, on the full text of every listed conversation (read from the gateway, bounded).
 *
 * Data comes from the same `state.data.conversations` the shell sidebar lists (fed by the gateway's
 * conversation list poll), so the rail never invents a conversation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { Button, Icon, IconButton } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import type { Conversation } from '@/prototype/types/prototype-types';

import {
  forkConversation,
  matchesAllWords,
  queryWords,
  relativeActivity,
  renameConversation,
  SEARCH_LIMIT,
  searchConversations,
} from './session-actions';
import type { FullTextSearchResult } from './session-actions';

import './sessions.css';

const SEARCH_DEBOUNCE_MS = 350;

export interface SessionRailProps {
  /** Whether the gateway-backed actions (rename, fork, full-text search) are available. */
  readonly production: boolean;
  readonly onClose?: () => void;
}

function byLatest(a: Conversation, b: Conversation): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

export function SessionRail({ production, onClose }: SessionRailProps) {
  const { state, dispatch } = usePrototype();
  const { t } = useLocale();
  const projectId = state.activeProjectId;

  const [query, setQuery] = useState('');
  const [fullText, setFullText] = useState<{ readonly query: string; readonly result: FullTextSearchResult } | null>(null);
  const [searching, setSearching] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [titleOverrides, setTitleOverrides] = useState<Readonly<Record<string, string>>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const searchSeq = useRef(0);

  // Relative times ("5 min geleden") stay honest without re-rendering on every tick.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const conversations = useMemo(
    () =>
      state.data.conversations
        .filter((conversation) => projectId !== '' && conversation.projectId === projectId)
        .map((conversation) =>
          titleOverrides[conversation.id] ? { ...conversation, title: titleOverrides[conversation.id] } : conversation,
        )
        .slice()
        .sort(byLatest),
    [state.data.conversations, projectId, titleOverrides],
  );

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  const runFullText = useCallback(
    async (text: string) => {
      if (!production || queryWords(text).length === 0) {
        setFullText(null);
        setSearching(false);
        return;
      }
      const seq = ++searchSeq.current;
      setSearching(true);
      const result = await searchConversations(conversations, text);
      if (seq !== searchSeq.current) return;
      setFullText({ query: text, result });
      setSearching(false);
    },
    [production, conversations],
  );

  useEffect(() => {
    if (queryWords(query).length === 0) return undefined;
    const id = window.setTimeout(() => void runFullText(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, runFullText]);

  const words = queryWords(query);
  const visible =
    words.length === 0
      ? conversations
      : conversations.filter(
          (conversation) =>
            matchesAllWords(conversation.title, words) ||
            (fullText !== null && fullText.query === query && fullText.result.ids.has(conversation.id)),
        );

  const openConversation = (id: string) => {
    dispatch({ type: 'conversation/activate', id });
    onClose?.();
  };

  const startRename = (conversation: Conversation) => {
    setRenamingId(conversation.id);
    setDraftTitle(conversation.title);
  };

  const failureDetail = (error: string | null): string =>
    error === 'missing-route' ? t('chat.sessions.missingRoute') : error === 'empty-title' ? t('chat.sessions.emptyTitle') : (error ?? '');

  const submitRename = async (event: FormEvent, conversation: Conversation) => {
    event.preventDefault();
    const next = draftTitle;
    setBusyId(conversation.id);
    const result = await renameConversation(conversation.id, next);
    setBusyId(null);
    if (!result.ok) {
      toast(t('chat.sessions.renameFailed'), failureDetail(result.error), 'TriangleAlert');
      return;
    }
    setTitleOverrides((current) => ({ ...current, [conversation.id]: next.replace(/\s+/g, ' ').trim() }));
    setRenamingId(null);
    toast(t('chat.sessions.renamed'), undefined, 'Pencil');
  };

  const branchFrom = async (conversation: Conversation) => {
    setBusyId(conversation.id);
    const result = await forkConversation(conversation.id);
    setBusyId(null);
    if (!result.ok || result.id === null) {
      toast(t('chat.sessions.forkFailed'), failureDetail(result.error), 'TriangleAlert');
      return;
    }
    toast(t('chat.sessions.forked'), t('chat.sessions.forkedDetail'), 'GitBranch');
    dispatch({ type: 'conversation/activate', id: result.id });
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runFullText(query);
    }
    if (event.key === 'Escape' && query !== '') {
      event.preventDefault();
      setQuery('');
      setFullText(null);
    }
  };

  const labels = {
    justNow: t('chat.sessions.justNow'),
    minutes: (n: number) => t('chat.sessions.minutesAgo', { count: n }),
    hours: (n: number) => t('chat.sessions.hoursAgo', { count: n }),
    days: (n: number) => t(n === 1 ? 'chat.sessions.dayAgo' : 'chat.sessions.daysAgo', { count: n }),
    unknown: t('chat.sessions.unknownTime'),
  };

  const result = fullText !== null && fullText.query === query ? fullText.result : null;

  return (
    <aside className="fw-sessions" aria-label={t('chat.sessions.title')}>
      <div className="fw-sessions__head">
        <h2 className="fw-sessions__title">{t('chat.sessions.title')}</h2>
        {onClose ? <IconButton icon="X" label={t('chat.sessions.hide')} size="sm" onClick={onClose} /> : null}
      </div>

      <label className="fw-sessions__search">
        <Icon name="Search" size="xs" className="fw-sessions__search-icon" />
        <span className="fw-visually-hidden">{t('chat.sessions.searchLabel')}</span>
        <input
          type="search"
          className="fw-sessions__search-field"
          value={query}
          placeholder={t('chat.sessions.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKey}
          disabled={projectId === ''}
        />
      </label>

      <p className="fw-sessions__status" role="status" aria-live="polite">
        {searching
          ? t('chat.sessions.searching')
          : result !== null && result.truncated
            ? t('chat.sessions.truncated', { count: SEARCH_LIMIT })
            : result !== null && result.unreadable > 0
              ? t('chat.sessions.unreadable', { count: result.unreadable })
              : ''}
      </p>

      {projectId === '' ? (
        <p className="fw-sessions__empty">{t('chat.sessions.noProject')}</p>
      ) : conversations.length === 0 ? (
        <p className="fw-sessions__empty">{t('chat.sessions.empty')}</p>
      ) : visible.length === 0 && !searching ? (
        <p className="fw-sessions__empty">{t('chat.sessions.noResults')}</p>
      ) : (
        <ul className="fw-sessions__list">
          {visible.map((conversation) => {
            const current = conversation.id === state.activeConversationId;
            const renaming = renamingId === conversation.id;
            const busy = busyId === conversation.id;
            return (
              <li key={conversation.id} className="fw-sessions__item" data-current={current ? 'true' : undefined}>
                {renaming ? (
                  <form className="fw-sessions__rename" onSubmit={(event) => void submitRename(event, conversation)}>
                    <input
                      className="fw-sessions__rename-field"
                      value={draftTitle}
                      aria-label={t('chat.sessions.renameField')}
                      maxLength={120}
                      autoFocus
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                    />
                    <div className="fw-sessions__rename-actions">
                      <Button type="submit" variant="primary" size="sm" disabled={busy}>
                        {t('chat.sessions.save')}
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => setRenamingId(null)}>
                        {t('chat.sessions.cancel')}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="fw-sessions__open"
                      aria-current={current ? 'page' : undefined}
                      onClick={() => openConversation(conversation.id)}
                    >
                      <span className="fw-sessions__name">{conversation.title}</span>
                      <span className="fw-sessions__meta">
                        {relativeActivity(conversation.updatedAt, now, labels)}
                        {' · '}
                        {t(conversation.messageCount === 1 ? 'chat.sessions.messageOne' : 'chat.sessions.messages', {
                          count: conversation.messageCount,
                        })}
                      </span>
                    </button>
                    {production ? (
                      <span className="fw-sessions__actions">
                        <IconButton
                          icon="Pencil"
                          size="sm"
                          label={t('chat.sessions.rename', { title: conversation.title })}
                          disabled={busy}
                          onClick={() => startRename(conversation)}
                        />
                        <IconButton
                          icon="GitBranch"
                          size="sm"
                          label={t('chat.sessions.fork', { title: conversation.title })}
                          disabled={busy}
                          onClick={() => void branchFrom(conversation)}
                        />
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

export default SessionRail;
