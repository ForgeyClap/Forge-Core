/**
 * Start — the new-chat empty state (DESIGN.md §3.1, mockups/01-start*.png).
 *
 * One question ("Wat wil je maken?"), the composer, three suggestions, and below that either the
 * "Start hier" card (a beginner's three first steps) or, for a returning user, one quiet "Verder met"
 * row. Never shown here: stat cards, project counts or example-data banners — those live on their own
 * pages (Mijn projecten, Overzicht).
 *
 * Sending is real: in production the first message starts a NEW conversation in the active project
 * (the same `useChatSend()` controller the chat uses; an active conversation is cleared first so the
 * message never lands in an older one), then the chat opens. A suggestion only fills the composer; it
 * never sends. Without the production controller (fixtures) Send says honestly that nothing is sent.
 * With no active project (`chat.disabledReason`), one short Dutch line sits above the composer and Send keeps
 * the draft instead of raising the controller's English error. "Nieuw project" shows once: the
 * composer's project chip already reads "Nieuw project…" and opens the dialog, so the line has no second
 * button (text budget, DESIGN.md §5: Start stays within 35 words).
 *
 * Above the composer also: the quiet usage line (`UsageLine`, only at 80 % of a current limit or more).
 * The "Start hier" steps read real signals only (see `start-checklist.ts`): an account, not the gateway
 * connection; the proof step opens Klussen & bewijs (/jobs, as Leer Forge lesson 3) and ticks only
 * once a real proof was on screen in a klus (JobDetail.tsx).
 */

import './home.css';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon, IconButton } from '@/components/primitives';
import { UsageLine } from '@/components/usage/UsageLine';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { useChatSend } from '@/prototype/state/chat-send';
import { useGatewayConnection } from '@/prototype/state/gateway-adapter';
import type { ChatSendEffort, ChatSendMode, ChatSendModel, ChatSendOutcome } from '@/prototype/state/chat-send';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import { Composer } from '@/views/chat/Composer';
import type { ComposerSendResult } from '@/views/chat/Composer';

import { useAccountReady, useStartChecklist } from './start-checklist';

interface Suggestion {
  readonly id: string;
  readonly icon: string;
  readonly labelKey: MessageKey;
  readonly exampleKey: MessageKey;
}

const SUGGESTIONS: readonly Suggestion[] = [
  { id: 'site', icon: 'Globe', labelKey: 'rd.start.suggestions.site', exampleKey: 'rd.start.siteExample' },
  { id: 'mail', icon: 'Mail', labelKey: 'rd.start.suggestions.mail', exampleKey: 'rd.start.mailExample' },
  { id: 'research', icon: 'Search', labelKey: 'rd.start.suggestions.research', exampleKey: 'rd.start.researchExample' },
];

type SendArgs = readonly [string, ChatSendMode?, ChatSendEffort?, ChatSendModel?];

interface PendingStart {
  readonly args: SendArgs;
  readonly resolve: (outcome: ChatSendOutcome) => void;
}

/** Minutes-free ordering for "Verder met": the newest real `updatedAt` wins; unparseable sorts last. */
function newestFirst(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta);
}

export default function HomeView() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const { t } = useLocale();
  const chat = useChatSend();
  const checklist = useStartChecklist();
  const accountReady = useAccountReady(!checklist.closed);
  // while the gateway is still connecting nothing is known yet, so
  // Start must not say "Geen project gekozen." or "0 van 3" as if there were no data (DESIGN.md §4).
  const connection = useGatewayConnection();
  const connecting = chat !== null && connection.status === 'CONNECTING';
  // No active project: Start says so itself (one Dutch line), never the controller's English reason.
  const noProject = chat !== null && chat.disabledReason !== null && !connecting;

  // A suggestion fills the composer through a seed: the composer owns its draft, so the seed carries a
  // counter (picking the same suggestion twice still refills it).
  const [seed, setSeed] = useState<{ readonly text: string; readonly n: number } | null>(null);

  const { conversations } = state.data;
  const resume = [...conversations].sort((a, b) => newestFirst(a.updatedAt, b.updatedAt))[0];

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) =>
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } }),
    [dispatch],
  );

  /* ------------------------------------------------------------------ send: always a new conversation */

  const pending = useRef<PendingStart | null>(null);

  const finish = useCallback(
    (outcome: ChatSendOutcome) => {
      if (outcome.ok) navigate('/chat');
      else if (outcome.error !== null) toast(t('chat.view.notSent'), outcome.error, 'TriangleAlert');
      return outcome;
    },
    [navigate, toast, t],
  );

  // The deferred send: once the cleared conversation id has reached the controller, the first message
  // creates a brand-new conversation (the controller does that for an empty id).
  useEffect(() => {
    const job = pending.current;
    if (job === null || chat === null || state.activeConversationId !== '') return;
    pending.current = null;
    void chat.send(...job.args).then((outcome) => job.resolve(finish(outcome)));
  }, [chat, state.activeConversationId, finish]);

  const handleSend = useCallback(
    (body: string, mode?: ChatSendMode, effort?: ChatSendEffort, model?: ChatSendModel): boolean | Promise<ComposerSendResult> => {
      if (chat === null) {
        toast(t('chat.view.newConversation'), t('chat.view.newPlaceholder'), 'Plus');
        return false;
      }
      // The line above the composer already says why; the draft stays while a project is picked or made.
      if (chat.disabledReason !== null) return false;
      const args: SendArgs = [body, mode, effort, model];
      if (state.activeConversationId === '') return chat.send(...args).then(finish);
      return new Promise<ChatSendOutcome>((resolve) => {
        pending.current = { args, resolve };
        dispatch({ type: 'conversation/activate', id: '' });
      });
    },
    [chat, state.activeConversationId, dispatch, finish, toast, t],
  );

  /* ------------------------------------------------------------------ "Start hier" */

  const steps: readonly { readonly id: string; readonly labelKey: MessageKey; readonly done: boolean }[] = [
    { id: 'account', labelKey: 'rd.start.checklist.account', done: accountReady },
    { id: 'ask', labelKey: 'rd.start.checklist.ask', done: conversations.length > 0 },
    { id: 'proof', labelKey: 'rd.start.checklist.proof', done: checklist.proofSeen },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const beginner = !checklist.closed && doneCount < steps.length;

  function openStep(id: string): void {
    if (id === 'account') {
      navigate('/settings');
      return;
    }
    if (id === 'ask') {
      document.querySelector<HTMLTextAreaElement>('.fw-start .fw-chat-composer__field')?.focus();
      return;
    }
    // The one proof destination (Leer Forge lesson 3 too). Ticked there, once a proof is really shown.
    navigate('/jobs');
  }

  function openResume(id: string, projectId: string): void {
    dispatch({ type: 'conversation/activate', id });
    if (projectId !== '') dispatch({ type: 'project/activate', id: projectId });
    navigate('/chat');
  }

  return (
    <div className="fw-start">
      <div className="fw-start__inner">
        <h1 className="fw-start__question">{t('rd.start.title')}</h1>

        <div className="fw-start__compose">
          {noProject ? (
            <div className="fw-start__note" role="status">
              <Icon name="Info" size="sm" className="fw-start__note-icon" />
              {/* Key from the XR-START locale patch; the cast goes once the patch is merged. */}
              <span className="fw-start__note-text">{t('rd.start.noProject')}</span>
            </div>
          ) : null}
          <UsageLine />

          <Composer
            variant="start"
            onSend={handleSend}
            onStop={() => undefined}
            streaming={false}
            conversationTitle={t('rd.start.title')}
            fieldLabel={t('rd.chat.composer.messageLabel')}
            placeholder={t('rd.start.placeholder')}
            production={chat !== null}
            seed={seed}
          />
        </div>

        <ul className="fw-start__suggestions">
          {SUGGESTIONS.map((suggestion) => (
            <li key={suggestion.id}>
              <button
                type="button"
                className="fw-start__suggestion"
                onClick={() => setSeed((current) => ({ text: t(suggestion.exampleKey), n: (current?.n ?? 0) + 1 }))}
              >
                <Icon name={suggestion.icon} size="sm" className="fw-start__suggestion-icon" />
                <span>{t(suggestion.labelKey)}</span>
              </button>
            </li>
          ))}
        </ul>

        {beginner ? (
          <section className="fw-start__card" aria-labelledby="fw-start-here" aria-busy={connecting || undefined}>
            <header className="fw-start__card-head">
              <h2 id="fw-start-here" className="fw-start__card-title">
                {t('rd.start.checklist.title')}
              </h2>
              {/* While connecting the count is hidden, but the meta span stays as the spacer that keeps the close button right-aligned. */}
              <span className="fw-start__card-meta" aria-hidden={connecting || undefined}>
                {connecting ? null : t('rd.start.checklist.progress', { done: doneCount, total: steps.length })}
              </span>
              <IconButton icon="X" label={t('rd.start.checklist.close')} size="sm" onClick={checklist.close} />
            </header>
            <span className="fw-start__meter" aria-hidden="true">
              <span
                className="fw-start__meter-fill"
                style={{ transform: `scaleX(${connecting ? 0 : doneCount / steps.length})` }}
              />
            </span>
            <ul className="fw-start__steps">
              {steps.map((step) => (
                <li key={step.id}>
                  {connecting ? (
                    // Quiet placeholder row: the label at its real row height, no tick and no action
                    // until the real state is known (static, no shimmer, DESIGN.md §4).
                    <span className="fw-start__step is-pending" data-step-pending="">
                      <span className="fw-start__tick is-pending" aria-hidden="true" />
                      <span>{t(step.labelKey)}</span>
                    </span>
                  ) : step.done ? (
                    <span className="fw-start__step is-done">
                      <span className="fw-start__tick is-done" aria-hidden="true">
                        <Icon name="Check" size="xs" strokeWidth={3} />
                      </span>
                      <span>{t(step.labelKey)}</span>
                      <span className="fw-visually-hidden">{t('rd.chat.strip.done')}</span>
                    </span>
                  ) : (
                    <button type="button" className="fw-start__step" onClick={() => openStep(step.id)}>
                      <span className="fw-start__tick" aria-hidden="true" />
                      <span>{t(step.labelKey)}</span>
                      <Icon name="ChevronRight" size="sm" className="fw-start__chev" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : resume ? (
          <button type="button" className="fw-start__resume" onClick={() => openResume(resume.id, resume.projectId)}>
            <Icon name="MessageSquare" size="sm" className="fw-start__resume-icon" />
            <span className="fw-start__resume-text fw-truncate">{t('rd.start.resume', { name: resume.title })}</span>
            <Icon name="ChevronRight" size="sm" className="fw-start__chev" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
