/**
 * Message — one turn in the thread.
 *
 * User and Forge turns are told apart the redesign way (DESIGN.md §3.2):
 *   you      a sunken bubble on the right (radius 16 16 4 16), no visible header;
 *            the author stays for screen readers, time and actions show on hover/focus
 *   Forge    no bubble: plain text across the column, like a document, under a
 *            small mark and the word "Forge"
 *   routed   a Forge turn the router ran elsewhere carries its "via …" badge in the
 *            header and, when something changed, the route notice above it
 *
 * Copy writes to the clipboard of this tab and nothing else. Regenerate re-sends
 * the preceding user turn through the real send path when `regenerate` is
 * provided (a real assistant reply with a real preceding user turn); otherwise
 * it raises an honest "nothing to regenerate" toast. Edit and the feedback
 * thumbs recorded nothing and had no real route, so they were removed rather
 * than kept as controls that lied about recording something.
 */

import { useCallback } from 'react';
import { useLocale } from '@/i18n/use-locale';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import type { ChatSendOutcome } from '@/prototype/state/chat-send';
import {
  readChatMessageEffort,
  readChatMessageFileEdits,
  readChatMessageIsLive,
  readChatMessageMode,
  readChatMessageShellCommands,
  readChatMessageUsage,
} from '@/prototype/state/gateway-chat';
import type { ChatShellCommand } from '@/prototype/state/gateway-chat';
import { readChatMessageRouteExhausted, readChatMessageRouteTurn } from '@/prototype/state/gateway-chat/live-activity';
import { readChatMessageRoute } from '@/prototype/state/gateway-chat/turn-parsers';
import {
  ExampleTag,
  Icon,
  IconButton,
  Machine,
  Mark,
  Spacer,
  StatusBadge,
} from '@/components/primitives';
import { isFixtureMode } from '@/config/mode';
import { renderMarkdown } from './markdown';
import { FoldedAttempt, RouteBadge, RouteExhaustedNotice, RouteNotStartedNotice, RouteNotice } from './route-notice/RouteNotice';
import { hasRouteNotice, routeFailed } from './route-notice/route-copy';
import { RouteSkipLine } from './route-notice/RouteSkipLine';
import {
  ATTACHMENT_ICON,
  EFFORT_CHIP_TEXT,
  FOOTER_DETAIL,
  MODE_CHIP_TEXT,
  MODE_CHIP_TITLE,
  buildEditDiffText,
  displayTime,
  stripContextWindowSuffix,
} from './message-parts';

export interface MessageProps {
  readonly message: ChatMessage;
  /** True while the local simulator is still revealing this message. */
  readonly streaming?: boolean;
  /** 1-based position in the thread, announced to assistive tech. */
  readonly position: number;
  readonly total: number;
  /**
   * The real regenerate action for this turn, or null/undefined when there is
   * none. Provided only for a real assistant message with a real preceding
   * user turn — see `MessageList`'s `regenerateFor`.
   */
  readonly regenerate?: (() => Promise<ChatSendOutcome>) | null;
  /**
   * feat-model-picker: the model the PRECEDING user turn requested, for a real assistant reply to
   * one — read by `MessageList.tsx` off that preceding turn's own record
   * (`readChatMessageRequestedModel`), since this component only ever sees its own single turn.
   * `null`/omitted for a user message, a fixture message, a reply whose preceding turn requested
   * nothing ("Default"), or a reply with no real preceding user turn at all.
   */
  readonly requestedModel?: string | null;
}

export function Message({
  message,
  streaming = false,
  position,
  total,
  regenerate = null,
  requestedModel = null,
}: MessageProps) {
  const { dispatch } = usePrototype();
  const { t, locale } = useLocale();
  const isUser = message.author === 'user';
  const author = isUser ? t('chat.message.you') : 'Forge';
  const time = displayTime(message.timestamp, locale);

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  const handleRegenerate = useCallback(() => {
    if (!regenerate) {
      toast(t('chat.message.nothingToRegenerate'), t('chat.message.nothingToRegenerateDetail'), 'RefreshCw');
      return;
    }
    void regenerate().then((outcome) => {
      if (outcome.ok) {
        toast(t('chat.message.regenerating'), t('chat.message.regeneratingDetail'), 'RefreshCw');
      } else if (outcome.error !== null) {
        toast(t('chat.message.regenerateFailed'), outcome.error, 'TriangleAlert');
      }
    });
  }, [regenerate, toast, t]);

  const copy = useCallback(
    (text: string, what: string) => {
      try {
        navigator.clipboard?.writeText(text).catch(() => undefined);
      } catch {
        /* No clipboard in this context — the toast still tells the truth below. */
      }
      toast(t('chat.message.copied', { what }), t('chat.message.copiedDetail'), 'Copy');
    },
    [toast, t],
  );

  // App router (APP-ROUTER-DESIGN.md §5.1): which account or own model answered, the notice of a switch,
  // and what the turn's events add (a folded failed attempt 1, a failover that found nothing, the error).
  const route = isUser ? null : readChatMessageRoute(message);
  const exhausted = isUser ? null : readChatMessageRouteExhausted(message);
  const routeTurn = isUser ? null : readChatMessageRouteTurn(message);
  const failedAttempt = routeTurn?.failedAttempt ?? null;

  const steps = message.steps ?? [];
  const attachments = message.attachments ?? [];
  const skills = message.skills ?? [];
  const completed = steps.filter((step) => step.status === 'completed').length;
  // fix-stream-insights (checkup #6): real per-turn file edits, empty for a fixture/example
  // message or a turn that called neither Edit nor Write — see `readChatMessageFileEdits`'s own
  // doc comment.
  const fileEdits = readChatMessageFileEdits(message);
  // feat-live-stream: real per-turn Bash commands (empty for a fixture/example message or a turn
  // that never called Bash — see `readChatMessageShellCommands`'s own doc comment), and whether
  // this specific message is the one synthetic still-running placeholder.
  const shellCommands = readChatMessageShellCommands(message);
  const isLive = readChatMessageIsLive(message);
  // fix-sec-round #3 (MEDIUM): `mode`/`effort` are written onto the USER turn's own record
  // (`conversations.mjs`'s `appendUserTurn` — the assistant/forge turn never carries either
  // field), so the chip must be read from the user's own turn, not the reply that follows it. Real
  // only when this turn's own gateway-carried meta says so — never guessed from the composer's
  // current selection (which only describes the NEXT send, not a past one). 'execute' (the
  // default) has no chip text and therefore renders none.
  const turnMode = isUser ? readChatMessageMode(message) : null;
  const modeChipKey = turnMode !== null ? (MODE_CHIP_TEXT[turnMode] ?? null) : null;
  const modeChipTitleKey = turnMode !== null ? (MODE_CHIP_TITLE[turnMode] ?? null) : null;
  const modeChipText = modeChipKey !== null ? t(modeChipKey) : null;
  const modeChipTitle = modeChipTitleKey !== null ? t(modeChipTitleKey) : null;
  const turnEffort = isUser ? readChatMessageEffort(message) : null;
  const effortChipText = turnEffort !== null ? t(EFFORT_CHIP_TEXT[turnEffort]) : null;

  // The per-message footer differs by mode. In fixtures it is the showcase
  // footer verbatim — the theme showcase and screenshots depend on it. In the
  // connected production build a field is shown only when it carries a REAL
  // value; a field with no real source is OMITTED, never filled with a
  // placeholder like "example-runtime · local", "no skill recorded" or
  // "mode · standard".
  //
  // feat-model-picker: `usageModel` (`readChatMessageUsage`, role-gated to `assistant` turns —
  // see that reader's own doc comment) is the model the run's OWN `result.modelUsage` actually
  // reported, never the requested choice. It is the source of truth here: when it is null (a
  // fixture message, mock mode, a spawn error, or a pre-existing turn recorded before this field
  // existed), NOTHING is shown for the requested choice either — per this WP's own "never show a
  // requested model as though it were the truth" rule, a mismatch chip only ever renders once the
  // real run outcome is known. `isMismatch` compares NORMALIZED forms (`stripContextWindowSuffix`)
  // so a context-window annotation on the request (e.g. "claude-opus-5[1m]") never reads as a
  // mismatch against the canonical "claude-opus-5" the run reports — only a GENUINE difference in
  // which model ran shows the split chip; the displayed text still uses the raw `requestedModel`.
  const usageModel = readChatMessageUsage(message).usageModel;
  const isMismatch =
    usageModel !== null &&
    requestedModel !== null &&
    stripContextWindowSuffix(requestedModel) !== stripContextWindowSuffix(usageModel);
  const modelText =
    usageModel !== null
      ? isMismatch
        ? t('chat.message.modelMismatch', { requested: requestedModel ?? '', used: usageModel })
        : usageModel
      : message.model && message.model.trim().length > 0
        ? message.model
        : null;
  const modelTitle = isMismatch ? t('chat.message.modelMismatchTitle') : t('chat.message.modelTitle');
  const skillText = skills.length > 0 ? skills.join(' · ') : null;

  const forgeFooter = isFixtureMode() ? (
    <footer className="fw-chat-msg__foot">
      <span className="fw-chat-meta" title="Example runtime label. Display only.">
        <Icon name="Cpu" size="xs" />
        <Machine muted>{message.model ?? 'example-runtime · local'}</Machine>
      </span>
      <span className="fw-chat-meta" title="Skills the example response was written against.">
        <Icon name="Sparkles" size="xs" />
        <Machine muted>{skills.length > 0 ? skills.join(' · ') : 'no skill recorded'}</Machine>
      </span>
      <span className="fw-chat-meta" title="Mode and persona are a placeholder in this prototype.">
        <Icon name="SlidersHorizontal" size="xs" />
        <Machine muted>mode · standard</Machine>
      </span>
      <Spacer />
      <ExampleTag detail={FOOTER_DETAIL} />
    </footer>
  ) : modelText !== null || skillText !== null ? (
    <footer className="fw-chat-msg__foot">
      {modelText !== null ? (
        <span className="fw-chat-meta" title={modelTitle}>
          <Icon name="Cpu" size="xs" />
          <Machine muted>{modelText}</Machine>
        </span>
      ) : null}
      {skillText !== null ? (
        <span className="fw-chat-meta" title={t('chat.message.skillsTitle')}>
          <Icon name="Sparkles" size="xs" />
          <Machine muted>{skillText}</Machine>
        </span>
      ) : null}
    </footer>
  ) : null;

  const label = t('chat.message.label', { position, total, author, time });

  // The router could not start this turn at all: the thread shows why, nothing else.
  if (exhausted !== null) {
    return (
      <article className="fw-chat-msg fw-chat-msg--forge fw-chat-msg--notice" data-chat-message="" tabIndex={0} aria-label={label}>
        <RouteExhaustedNotice notice={exhausted} turnSkipped={routeTurn?.skipped} />
      </article>
    );
  }

  // A failed attempt 1 the router retried elsewhere (`route_attempt_failed`): folded away under its reason,
  // never hidden. It sits above the answer of the attempt that took over.
  const folded =
    failedAttempt !== null ? (
      <FoldedAttempt route={failedAttempt.route}>
        {failedAttempt.text.trim() !== '' ? (
          <div className="fw-chat-md">
            {renderMarkdown(failedAttempt.text, { idPrefix: `${message.id}-attempt`, caret: false, onCopy: (code, lang) => copy(code, t('chat.message.codeBlock', { lang })) })}
          </div>
        ) : null}
      </FoldedAttempt>
    ) : null;

  // A turn whose only record is that folded attempt (attempt 2 left nothing), or only the steps the router
  // skipped, or a turn the gateway could not start at all (Q7-FINISH: it says so, with the way out): never an
  // empty Forge bubble.
  const skippedOnly = routeTurn !== null && routeTurn.skipped.length > 0;
  const notStarted = routeTurn?.notStarted === true;
  const retry = regenerate ? handleRegenerate : null;
  if (route === null && (folded !== null || skippedOnly || notStarted) && message.body.trim() === '' && !isLive) {
    return (
      <article className="fw-chat-msg fw-chat-msg--forge fw-chat-msg--folded" data-chat-message="" tabIndex={0} aria-label={label}>
        {folded}
        {notStarted ? <RouteNotStartedNotice skipped={routeTurn?.skipped ?? []} onRetry={retry} /> : <RouteSkipLine skipped={routeTurn?.skipped ?? []} />}
      </article>
    );
  }

  // An answer that failed says so in its notice; an empty body under it would only be an empty bubble, and its
  // header (name, time, copy of nothing) a blank reply. The retry moves into the notice (Q7-FINISH).
  const hideEmptyBody = route !== null && routeFailed(route) && message.body.trim() === '';

  return (
    <article
      className={`fw-chat-msg fw-chat-msg--${isUser ? 'user' : 'forge'}`}
      data-chat-message=""
      tabIndex={0}
      aria-label={label}
      aria-busy={streaming || isLive || undefined}
    >
      {folded}
      {route !== null ? <RouteNotice route={route} turn={routeTurn} isLast={position === total} onRetry={hideEmptyBody ? retry : null} /> : null}
      {hideEmptyBody ? null : <header className="fw-chat-msg__head">
        {isUser ? (
          <span className="fw-chat-msg__author fw-visually-hidden">{author}</span>
        ) : (
          <span className="fw-chat-msg__who fw-chat-msg__author">
            <Mark size={18} />
            <span>{author}</span>
          </span>
        )}
        {message.edited ? (
          <Machine muted className="fw-chat-msg__edited">
            {t('chat.message.edited')}
          </Machine>
        ) : null}
        {isLive ? (
          <StatusBadge status="running" size="sm" className="fw-chat-msg__live-badge" />
        ) : null}
        {route !== null ? <RouteBadge route={route} besideNotice={hasRouteNotice(route)} /> : null}
        {modeChipText !== null ? (
          <span className="fw-chat-msg__mode-chip" title={modeChipTitle ?? undefined}>
            {modeChipText}
          </span>
        ) : null}
        {effortChipText !== null ? (
          <span className="fw-chat-msg__mode-chip" title={t('chat.message.effortTitle')}>
            {effortChipText}
          </span>
        ) : null}
        <Spacer />
        {/* The hover time sits at the end (final review finding 2): at opacity 0 it still keeps its width, so
            between the name and the "via …" badge it left a wide empty gap. */}
        <Machine muted className="fw-chat-msg__time">
          {time}
        </Machine>
        <div className="fw-chat-msg__actions">
          <IconButton
            icon="Copy"
            label={t('chat.message.copy')}
            size="sm"
            onClick={() => copy(message.body, t('chat.message.copyWhat'))}
          />
          {isUser ? null : (
            <IconButton
              icon="RefreshCw"
              label={t('chat.message.regenerate')}
              size="sm"
              onClick={handleRegenerate}
            />
          )}
        </div>
      </header>}

      {hideEmptyBody ? null : (
        <div className="fw-chat-msg__body fw-chat-md">
          {renderMarkdown(message.body, {
            idPrefix: message.id,
            caret: streaming,
            onCopy: (code, lang) => copy(code, t('chat.message.codeBlock', { lang })),
          })}
        </div>
      )}

      {steps.length > 0 ? (
        <details className="fw-chat-steps">
          <summary className="fw-chat-steps__summary">
            <Icon name="ChevronRight" size="sm" className="fw-chat-steps__chevron" />
            <Machine className="fw-chat-steps__count">
              {t('chat.message.steps', { count: steps.length, completed })}
            </Machine>
            <Spacer />
            <span className="fw-chat-steps__hint">{t('chat.message.progress')}</span>
          </summary>
          <ol className="fw-chat-steps__list">
            {steps.map((step) => (
              <li key={step.id} className="fw-chat-step fw-status" data-status={step.status}>
                <StatusBadge status={step.status} size="sm" className="fw-chat-step__badge" />
                <div className="fw-chat-step__text">
                  <span className="fw-chat-step__label">{step.label}</span>
                  <span className="fw-chat-step__detail">{step.detail}</span>
                </div>
                {step.agent ? (
                  <Machine muted className="fw-chat-step__agent">
                    {step.agent}
                  </Machine>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {fileEdits.length > 0 ? (
        <details className="fw-chat-steps">
          <summary className="fw-chat-steps__summary">
            <Icon name="ChevronRight" size="sm" className="fw-chat-steps__chevron" />
            <Machine className="fw-chat-steps__count">
              {t(fileEdits.length === 1 ? 'chat.message.filesOne' : 'chat.message.filesMany', { count: fileEdits.length })}
            </Machine>
            <Spacer />
            <span className="fw-chat-steps__hint">{t('chat.message.diff')}</span>
          </summary>
          <ul className="fw-chat-steps__list">
            {fileEdits.map((edit, index) => {
              const diffText = buildEditDiffText(edit);
              return (
                <li key={`${message.id}-file-${index}`} className="fw-chat-file">
                  <div className="fw-chat-file__head">
                    <Icon name="FileCode" size="xs" />
                    <Machine className="fw-chat-file__path">{edit.filePath}</Machine>
                    <Machine muted className="fw-chat-file__tool">
                      {edit.tool}
                    </Machine>
                  </div>
                  {diffText !== null ? (
                    <pre className="fw-chat-file__diff">
                      <code className="fg-machine">{diffText}</code>
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {shellCommands.length > 0 ? (
        <details className="fw-chat-steps">
          <summary className="fw-chat-steps__summary">
            <Icon name="ChevronRight" size="sm" className="fw-chat-steps__chevron" />
            <Machine className="fw-chat-steps__count">
              {t(shellCommands.length === 1 ? 'chat.message.commandsOne' : 'chat.message.commandsMany', { count: shellCommands.length })}
            </Machine>
            <Spacer />
            <span className="fw-chat-steps__hint">{t('chat.message.shell')}</span>
          </summary>
          <ul className="fw-chat-steps__list">
            {shellCommands.map((cmd: ChatShellCommand, index) => (
              <li key={`${message.id}-shell-${index}`} className="fw-chat-shell">
                <div className="fw-chat-shell__head">
                  <Icon name="Terminal" size="xs" />
                  {cmd.description !== null ? (
                    <Machine className="fw-chat-shell__description">{cmd.description}</Machine>
                  ) : null}
                  {cmd.isError === null ? null : (
                    <Machine muted className="fw-chat-shell__status" title={cmd.isError ? t('chat.message.commandErrorTitle') : t('chat.message.commandOkTitle')}>
                      {cmd.isError ? t('chat.message.commandError') : t('chat.message.commandOk')}
                    </Machine>
                  )}
                </div>
                <pre className="fw-chat-shell__command">
                  <code className="fg-machine">{cmd.command}</code>
                </pre>
                {cmd.result !== null ? (
                  <pre className="fw-chat-shell__result">
                    <code className="fg-machine">{cmd.result}</code>
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="fw-chat-atts" aria-label={t('chat.message.attachments')}>
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <button
                type="button"
                className="fw-chat-att"
                onClick={() =>
                  toast(
                    'Preview not available',
                    `${attachment.name} is an example record. There is no file behind it.`,
                    'Paperclip',
                  )
                }
              >
                <Icon name={ATTACHMENT_ICON[attachment.kind]} size="sm" />
                <Machine className="fw-chat-att__name">{attachment.name}</Machine>
                <Machine muted className="fw-chat-att__size">
                  {attachment.size}
                </Machine>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {isUser ? null : forgeFooter}
    </article>
  );
}
