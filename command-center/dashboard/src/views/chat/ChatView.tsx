/**
 * ChatView — the chat workspace.
 *
 * Layout (redesign, DESIGN.md §3.2), top to bottom: in Uitgebreid only, a
 * slim tools row (conversations rail toggle, status chip, export, details, new,
 * delete); the thread in a reading-width column; then the dock pinned to the
 * bottom at composer width: any question / permission cards, the work strip
 * (Eenvoudig) or team strip (Uitgebreid), the lines above the composer (status
 * chip in Eenvoudig, the project-mismatch note, the usage line at 80 % or more)
 * and the composer. The conversation title is shown by the shell's bar; this
 * view keeps one visually hidden h1. The conversations rail is Uitgebreid only.
 * The view renders its own content area only — the sidebar, bar and side pane
 * belong to the shell.
 *
 * TWO SEND PATHS, chosen by whether the production chat controller is mounted:
 *
 *   PRODUCTION (`useChatSend()` is non-null) — Send drives a REAL Claude Code run
 *       through the bridge (`sendMessage`, creating the conversation first when
 *       there is none), Stop cancels the real run, and the run status shown comes
 *       from the live store. No local reply is ever appended: the assistant text
 *       arrives as real streamed events and renders through the adapter. A refused
 *       send surfaces the real reason and keeps the draft.
 *
 *   FIXTURES (`useChatSend()` is null) — the original local reveal, untouched:
 *       `chat/send` appends the user message and a canned reply the provider
 *       reveals on a timer, and Stop halts that reveal. This is the path the theme
 *       showcase and the unit tests exercise.
 *
 * PROJECT-MISMATCH DISCLOSURE (fix-chat-mismatch): in
 * production, a conversation stays reachable (via the sidebar/breadcrumb) after
 * the active project switches to something else — the sidebar switch clears
 * neither the selection nor the conversation history. Sending in that state is
 * ALREADY safe (`gateway-chat.ts`'s cross-project guard, fix-crossproject,
 * treats a project-mismatched conversation as unknown and starts a brand-new
 * one in the active project instead of posting into this one) — but nothing on
 * screen said so before this fix, which read as a silent contradiction between
 * the topbar's active project and this view's own breadcrumb/composer copy. The
 * extra subtitle line below states the real outcome plainly whenever that
 * mismatch is showing, naming both real projects from `state` — never a new
 * component, never a guess.
 */

import './chat.css';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocale } from '@/i18n/use-locale';
import { useUiMode } from '@/state/ui-mode';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import {
  nextToastId,
  selectConversation,
  selectMessages,
  selectProject,
  usePrototype,
} from '@/prototype/state/prototype-store';
import { useChatSend } from '@/prototype/state/chat-send';
import type { ChatSendEffort, ChatSendMode, ChatSendModel, ChatSendOutcome } from '@/prototype/state/chat-send';
import { requestNewConversation } from '@/components/shell/gateway-actions';
import { readChatMessageIsLive } from '@/prototype/state/gateway-chat';
import { useGatewayAskQuestions } from '@/prototype/state/gateway-chat/ask-questions';
import { readChatMessageChatError } from '@/prototype/state/gateway-chat/live-activity';
import { ConfirmDeleteConversationDialog } from '@/components/shell/ConfirmDeleteConversationDialog';
import { AskQuestionsDialog } from './AskQuestionsDialog';
import { TeamStrip } from '@/views/team/TeamStrip';
import { ChatWorkStrip } from './work-strip/ChatWorkStrip';
import {
  Button,
  EmptyState,
  ExampleTag,
  Icon,
  IconButton,
  Spacer,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { UsageLine } from '@/components/usage/UsageLine';
import { Composer } from './Composer';
import type { ComposerSendResult } from './Composer';
import { MessageList } from './MessageList';
import { MenuButton } from './menu-button';
import { migrateStoredBypass } from './mode-storage';
import { SessionRail } from './sessions/SessionRail';
// WP B3 cards (patch from B3-cards, _scratch/b3/patches-ui.md): permission cards, error card,
// status chip, team plan card and the Ctrl+/ shortcut overlay.
import { PermissionCards } from './permissions/PermissionCard';
import { usePendingPermissions } from './permissions/use-pending-permissions';
import { ErrorCard } from './errors/ErrorCard';
import { normalizeChatError } from './errors/error-catalogue';
import type { ChatErrorAction, ChatErrorPayload } from './errors/error-catalogue';
import { ChatStatusChip } from './status/ChatStatus';
import { deriveProtocolState } from './status/status-model';
import { PlanCard } from './plan-card/PlanCard';
import type { TeamPlan } from './plan-card/plan-estimate';
import { ShortcutOverlayHost } from './shortcuts/ShortcutOverlay';
import { ROUTER_SETTINGS_HASH } from './route-notice/RouteNotice';
import {
  conversationToJson,
  conversationToMarkdown,
  downloadText,
  exportFileName,
} from './sessions/session-actions';
import './sessions/sessions.css';

/** The chat area is wide enough for a docked conversation rail (matches sessions.css). */
const WIDE_RAIL_QUERY = '(min-width: 1101px)';

function railStartsOpen(): boolean {
  try {
    return window.matchMedia(WIDE_RAIL_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * B8-3 (review: chat cramped at the default 1280x840 window): below this width the conversation
 * rail and the docked inspector do not both fit beside a readable transcript (the chat column fell
 * to ~370 px and the transcript to ~90 px). There, an open inspector hides the rail; opening the
 * rail again closes the inspector. At 1400 px and wider both stay, as before. Mirrors
 * `ROOMY_QUERY` in `prototype/state/shell-effects.ts`.
 */
const ROOMY_QUERY = '(min-width: 1400px)';

function roomyForRailAndInspector(): boolean {
  try {
    return window.matchMedia(ROOMY_QUERY).matches;
  } catch {
    return true;
  }
}

const NO_MESSAGES: readonly ChatMessage[] = [];

export default function ChatView() {
  const { state, dispatch } = usePrototype();
  const { t } = useLocale();
  const titleId = useId();
  const { isAdvanced } = useUiMode();
  // WP B3: one-time reset of a stored "Volledige toegang" (bypass), run during the first render so
  // the Composer below already reads the migrated value. The toast says what happened.
  const [bypassReset] = useState(() => migrateStoredBypass());
  // WP B3: the conversation rail — docked on a wide chat area, a drawer on a narrow one.
  const [railOpen, setRailOpen] = useState(railStartsOpen);
  // Non-null only on the connected production path; null in fixtures/tests, which
  // is the signal to keep the local reveal below.
  const chat = useChatSend();
  const production = chat !== null;
  // feat-delete-conversation: the header's real "Delete conversation" confirm dialog.
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const conversation = selectConversation(state, state.activeConversationId);
  const conversationId = conversation?.id ?? '';
  // feat-ask-owner: the real "Forge is asking" question box, watched only for a genuine production
  // conversation — fixtures/no-active-conversation pass '' so the hook's own internal guard never
  // polls a real gateway route for a non-real id.
  const ask = useGatewayAskQuestions(production ? conversationId : '');
  // WP B3 cards: permission requests that wait for the user (contract: _scratch/b3/contract-permissions.md).
  const permissions = usePendingPermissions(production ? conversationId : '');
  // WP B3 cards: a team-job proposal waiting for Start / Aanpassen / Niet nu. null until the planner
  // sends one; never a fabricated plan.
  const teamPlan: TeamPlan | null = null;
  const project = conversation
    ? selectProject(state, conversation.projectId)
    : selectProject(state, state.activeProjectId);
  const messages = conversation ? selectMessages(state, conversation.id) : NO_MESSAGES;
  // WP B3 cards + app router review (HIGH #2): the last chat error as a catalogue code — the newest
  // `forge_error` of the LAST turn, only while it runs or when its answer failed (live-activity.ts puts it
  // on the last message only, so an older turn's error never lingers). Production only; never a fake one.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastTurnError = production && lastMessage !== null ? readChatMessageChatError(lastMessage) : null;
  const chatError: ChatErrorPayload | null = useMemo(() => (lastTurnError !== null ? normalizeChatError(lastTurnError) : null), [lastTurnError]);

  // fix-chat-mismatch: true only when THIS
  // conversation's own project tag differs from the ACTIVE project shown in
  // the topbar/sidebar. This is exactly the condition
  // `useGatewayChatSendController` (`gateway-chat.ts`, its own header rule 4 /
  // `knownConversation`) treats as "unknown": a real Send here never posts
  // into this conversation — it creates a BRAND-NEW conversation in the
  // active project and activates that one instead. Gated to `production`
  // (real `chat` mounted): the fixture reveal has no per-project send guard
  // at all, so the note would misdescribe what a fixture Send actually does.
  const projectMismatch =
    production &&
    conversation !== undefined &&
    conversation.projectId !== '' &&
    state.activeProjectId !== '' &&
    conversation.projectId !== state.activeProjectId;
  const activeProject = projectMismatch ? selectProject(state, state.activeProjectId) : undefined;

  const { stream } = state;
  const streamingId =
    stream !== null && !stream.done && stream.conversationId === conversationId
      ? stream.messageId
      : null;

  // In production the composer's Stop/Send toggle reflects a REAL active run; in
  // fixtures it reflects the local reveal.
  const streaming = production && chat !== null ? chat.run.active : streamingId !== null;

  const protocolState = production
    ? deriveProtocolState({
        pendingPermissions: permissions.pending.length,
        pendingQuestion: ask.pending !== null,
        error: chatError,
        runStatus: chat?.run.status ?? null,
        streaming,
      })
    : null;

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  // Exactly one toast per migration, also under StrictMode (which runs every effect twice on mount
  // in development, see main.tsx): the ref survives that re-run, so the second pass is a no-op.
  const bypassToastShown = useRef(false);
  useEffect(() => {
    if (bypassReset === 0 || bypassToastShown.current) return;
    bypassToastShown.current = true;
    toast(t('chat.view.bypassResetTitle'), t('chat.view.bypassResetDetail'), 'ShieldCheck');
    // Shown once per migration; `t` and `toast` are stable for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bypassReset]);

  // WP B3: export of the open conversation as Markdown or JSON — a local download, nothing is sent.
  const exportOptions = useMemo(
    () => [
      { id: 'md', icon: 'FileText', label: t('chat.view.exportMd'), detail: t('chat.view.exportMdDetail') },
      { id: 'json', icon: 'FileJson', label: t('chat.view.exportJson'), detail: t('chat.view.exportJsonDetail') },
    ],
    [t],
  );
  const handleExport = useCallback(
    (format: string) => {
      if (!conversation) return;
      const rows = messages.map((message) => ({ author: message.author, body: message.body, timestamp: message.timestamp }));
      const now = new Date();
      if (format === 'json') {
        downloadText(exportFileName(conversation.title, 'json'), conversationToJson(conversation, rows, now), 'application/json');
      } else {
        const labels = { you: t('chat.view.exportYou'), forge: 'Forge', exportedOn: t('chat.view.exportedOn') };
        downloadText(exportFileName(conversation.title, 'md'), conversationToMarkdown(conversation.title, rows, labels, now), 'text/markdown');
      }
      toast(t('chat.view.exported'), t('chat.view.exportedDetail'), 'Download');
    },
    [conversation, messages, t, toast],
  );

  // B8-3: derived, not stored — the rail steps aside while the inspector is open on a narrow window
  // and comes back by itself when the inspector closes.
  const railShown = railOpen && (!state.inspectorOpen || roomyForRailAndInspector());

  const railToggle = (
    <IconButton
      icon="PanelLeft"
      label={railShown ? t('chat.sessions.hide') : t('chat.sessions.show')}
      size="sm"
      active={railShown}
      className="fw-chat__rail-toggle"
      onClick={() => {
        if (railShown) {
          setRailOpen(false);
          return;
        }
        setRailOpen(true);
        if (state.inspectorOpen && !roomyForRailAndInspector()) dispatch({ type: 'inspector/set', open: false });
      }}
    />
  );

  // Redesign (DESIGN.md §2): the usage pill and the chat's own limit meter are gone; one quiet line above
  // the composer (`UsageLine`) appears only at 80 % of a current limit or more. Uitgebreid keeps the
  // detailed numbers in Instellingen > Gebruik. The conversations rail is Uitgebreid only (the sidebar's
  // Recent and Gesprekken already list conversations in Eenvoudig).
  const frame = (chatSection: ReactNode) => (
    <div className="fw-chat-frame" data-ui-mode={isAdvanced ? 'uitgebreid' : 'eenvoudig'}>
      {isAdvanced && railShown ? (
        <>
          <button
            type="button"
            className="fw-chat-frame__scrim"
            aria-label={t('chat.sessions.hide')}
            tabIndex={-1}
            onClick={() => setRailOpen(false)}
          />
          <div className="fw-chat-frame__rail">
            <SessionRail
              production={production}
              onClose={() => {
                if (!railStartsOpen()) setRailOpen(false);
              }}
            />
          </div>
        </>
      ) : null}
      {chatSection}
    </div>
  );

  const handleSend = useCallback(
    // composer-modes-ui: `effort` forwards straight through to `chat.send`, mirroring how `mode`
    // already does — this view is unaware of either choice's meaning, it just relays what the
    // Composer decided. feat-model-picker: `model` forwards the same way, one parameter over.
    (body: string, mode?: ChatSendMode, effort?: ChatSendEffort, model?: ChatSendModel): boolean | Promise<ComposerSendResult> => {
      if (production && chat !== null) {
        // Drive a real run. The message is never echoed locally — the streamed
        // events render the reply. A refusal keeps the draft and says why.
        // feat-composer-power: the FULL outcome (not just `.ok`) is returned — the composer's
        // message queue needs the real refusal reason on a failed flush attempt.
        return chat.send(body, mode, effort, model).then((outcome) => {
          if (!outcome.ok && outcome.error !== null) {
            toast(t('chat.view.notSent'), outcome.error, 'TriangleAlert');
          }
          return outcome;
        });
      }
      if (conversationId === '') return false;
      dispatch({ type: 'chat/send', conversationId, body });
      return true;
    },
    [production, chat, conversationId, dispatch, toast, t],
  );

  // fix-ui-clutter (item 4): drives the SAME real `POST /api/conversations` flow the sidebar's
  // "New chat" button already uses (`requestNewConversation`, `gateway-actions.ts`) instead of
  // merely clearing the active conversation and leaving an empty composer behind with nothing
  // new created — no page reload, no local-only reset standing in for a real action.
  const handleNewChat = useCallback(async () => {
    const result = await requestNewConversation(state.activeProjectId);
    if (!result.ok || result.id === null) {
      toast(t('chat.view.newFailed'), result.error ?? t('chat.view.newFailedDetail'), 'TriangleAlert');
      return;
    }
    dispatch({ type: 'conversation/activate', id: result.id });
  }, [state.activeProjectId, dispatch, toast, t]);

  // feat-composer-power: the SAME real-vs-fixture branch the toolbar's own "New"/"Delete" buttons
  // already used inline — extracted so the composer's `/new`/`/delete` slash commands (see
  // `slash-commands.ts`) drive the exact same real actions, not a second parallel implementation.
  const handleNewChatClick = useCallback(() => {
    if (production) {
      void handleNewChat();
      return;
    }
    toast(t('chat.view.newConversation'), t('chat.view.newPlaceholder'), 'Plus');
  }, [production, handleNewChat, toast, t]);

  const handleDeleteClick = useCallback(() => {
    if (production) {
      setDeleteDialogOpen(true);
      return;
    }
    toast(t('chat.view.delete'), t('chat.view.deletePlaceholder'), 'Trash2');
  }, [production, toast, t]);

  // Regenerate re-POSTs the preceding user turn through the SAME send path Send
  // already uses — no second fetch layer. Only offered on a real assistant
  // message with a real preceding user turn to re-send; every other case (a
  // fixture reply, or a message with nothing before it) returns null and the
  // caller shows the honest "nothing to regenerate" fallback.
  const resolveRegenerate = useCallback(
    (index: number): (() => Promise<ChatSendOutcome>) | null => {
      if (!production || chat === null) return null;
      // feat-live-stream: the one synthetic still-running placeholder (`gateway-chat.ts`'s
      // `buildLiveActivityMessage`) has nothing finished to regenerate — it renders live tool
      // activity for a turn that has not produced a real reply yet.
      const current = messages[index];
      if (current && readChatMessageIsLive(current)) return null;
      const previous = messages[index - 1];
      if (!previous || previous.author !== 'user') return null;
      return () => chat.send(previous.body);
    },
    [production, chat, messages],
  );

  const handleStop = useCallback(() => {
    if (production && chat !== null) {
      void chat.stop().then((outcome) => {
        if (!outcome.ok && outcome.error !== null) {
          toast(t('chat.view.stopFailed'), outcome.error, 'TriangleAlert');
        }
      });
      return;
    }
    dispatch({ type: 'chat/stream-stop' });
    toast(t('chat.view.revealStopped'), t('chat.view.revealStoppedDetail'), 'Square');
  }, [production, chat, dispatch, toast, t]);

  // WP B3 cards: the one button of an error card.
  const handleErrorAction = useCallback(
    (action: ChatErrorAction) => {
      switch (action) {
        case 'stop':
          handleStop();
          return;
        case 'retry':
        case 'resend': {
          const lastUser = [...messages].reverse().find((message) => message.author === 'user');
          if (production && chat !== null && lastUser) void chat.send(lastUser.body);
          return;
        }
        case 'auto_resume':
          // APP-ROUTER-DESIGN.md Q7: nothing in the run layer schedules a resend, so this button must not
          // pretend to switch something on. It opens the Forge router settings instead, where carrying on
          // automatically really is chosen (another own account, or an own model). Deliberately NOT a
          // one-click config write: multi-account needs its acknowledgement and a fallback needs a model.
          window.location.hash = ROUTER_SETTINGS_HASH;
          return;
        case 'sign_in':
        case 'install_claude':
        case 'start_ollama':
        case 'pull_model':
          // Eenvoudig never shows a terminal command: these go to Instellingen (Accounts / checkup).
          // The app routes by hash (no router hook here, so the view also renders outside a router).
          window.location.hash = '#/settings';
          return;
      }
    },
    [handleStop, messages, production, chat],
  );

  const cards = production ? (
    <div className="fw-chat__cards">
      {teamPlan ? (
        <PlanCard plan={teamPlan} onStart={() => undefined} onAdjust={() => undefined} onLater={() => undefined} />
      ) : null}
      <PermissionCards pending={permissions.pending} projectDir={project?.path ?? null} onAnswer={permissions.answer} />
      {chatError ? <ErrorCard key={chatError.code} error={chatError} onAction={handleErrorAction} /> : null}
    </div>
  ) : null;

  // Uitgebreid only: one quiet tools row (conversations rail, status, export, details, new, delete). In
  // Eenvoudig the bar already names the conversation and its project, the sidebar starts and deletes
  // conversations, and the status shows above the composer, so the chat draws no header at all.
  const tools = (withConversation: boolean) =>
    isAdvanced ? (
      <div className="fw-chat__tools">
        <Toolbar label={t('chat.view.actions')} className="fw-chat__toolbar">
          {railToggle}
          <ChatStatusChip state={protocolState} />
          <Spacer />
          {withConversation && conversation ? (
            <ToolbarGroup>
              <MenuButton
                icon="Download"
                label={t('chat.view.export')}
                title={t('chat.view.exportTitle')}
                options={exportOptions}
                footer={t('chat.view.exportFooter')}
                onPick={(option) => handleExport(option.id)}
              />
              <IconButton
                icon="PanelRight"
                label={t('chat.view.details')}
                size="sm"
                onClick={() => dispatch({ type: 'select', selection: { kind: 'conversation', id: conversation.id } })}
              />
              <Button variant="quiet" size="sm" icon="Plus" onClick={handleNewChatClick}>
                {t('chat.view.new')}
              </Button>
              <IconButton icon="Trash2" label={t('chat.view.delete')} size="sm" onClick={handleDeleteClick} />
            </ToolbarGroup>
          ) : null}
        </Toolbar>
      </div>
    ) : null;

  // The lines right above the composer: status (Eenvoudig), the project-mismatch note and the usage line.
  const aboveComposer = (
    <>
      {isAdvanced ? null : <ChatStatusChip state={protocolState} />}
      {/*
        a11y-new: `role="status"` because this line changes where the very next Send lands; a
        screen-reader user already in the composer must hear it. `polite`, not `assertive`.
      */}
      {projectMismatch ? (
        <p className="fw-chat__note" role="status" aria-live="polite">
          <Icon name="Info" size="sm" className="fw-chat__note-icon" />
          <span>
            {t('chat.view.mismatchBefore')} <strong>{project?.name ?? t('chat.view.unknownProject')}</strong>{' '}
            {t('chat.view.mismatchMiddle')} <strong>{activeProject?.name ?? t('chat.view.unknownProject')}</strong>{' '}
            {t('chat.view.mismatchAfter')}
          </span>
        </p>
      ) : null}
      <UsageLine />
    </>
  );

  if (!conversation) {
    // PRODUCTION: with a project resolvable, still show the composer so a first
    // message can start a conversation (created on send). With no project, show an
    // honest disabled state rather than a composer that would drop the message.
    if (production && chat !== null) {
      if (chat.disabledReason === null) {
        return frame(
          <section className="fw-chat" aria-labelledby={titleId}>
            <h1 id={titleId} className="fw-visually-hidden">
              {t('chat.view.newConversation')}
            </h1>
            {tools(false)}

            <div className="fw-chat__body">
              <MessageList
                messages={NO_MESSAGES}
                streamingId={null}
                conversationTitle={t('chat.view.newConversation')}
              />
            </div>

            <div className="fw-chat__dock">
              {isAdvanced ? <TeamStrip projectName={state.activeProjectId} /> : <ChatWorkStrip projectName={state.activeProjectId} />}
              {aboveComposer}
              <Composer
                onSend={handleSend}
                onStop={handleStop}
                streaming={false}
                conversationTitle={t('chat.view.newConversation')}
                production
              />
            </div>
          </section>,
        );
      }

      return frame(
        <section className="fw-chat" aria-label={t('chat.view.label')}>
          <EmptyState
            icon="MessagesSquare"
            title={t('chat.view.noProject')}
            detail={isAdvanced ? chat.disabledReason : t('chat.view.noProjectDetail')}
          />
        </section>,
      );
    }

    // FIXTURES: the original empty state.
    return (
      <section className="fw-chat" aria-label={t('chat.view.label')}>
        <EmptyState
          icon="MessagesSquare"
          title={t('chat.view.noConversation')}
          detail={t('chat.view.noConversationDetail')}
        />
      </section>
    );
  }

  return frame(
    <section className="fw-chat" aria-labelledby={titleId}>
      {/* Exactly one h1: the bar shows the title visually, so this one is for screen readers and the
          document outline only. The raw id stays a hover tooltip (fix-ui-clutter item 3). */}
      <h1 id={titleId} className="fw-visually-hidden" title={conversation.id}>
        {conversation.title}
      </h1>
      {tools(true)}
      {production ? null : (
        <p className="fw-chat__example">
          <ExampleTag />
          <span>{t('chat.view.exampleThread')}</span>
        </p>
      )}

      <div className="fw-chat__body">
        <MessageList
          messages={messages}
          streamingId={streamingId}
          conversationTitle={conversation.title}
          regenerateFor={resolveRegenerate}
        />
      </div>

      <div className="fw-chat__dock">
        {cards}
        {/* The work strip (Eenvoudig) or the team strip (Uitgebreid): both render only while this project
            has a live klus, from its real helper dispatches. */}
        {isAdvanced ? <TeamStrip projectName={state.activeProjectId} /> : <ChatWorkStrip projectName={state.activeProjectId} />}
        {aboveComposer}
        <Composer
          onSend={handleSend}
          onStop={handleStop}
          streaming={streaming}
          conversationTitle={conversation.title}
          production={production}
          onNewChat={handleNewChatClick}
          onRequestDelete={handleDeleteClick}
        />
      </div>

      <ConfirmDeleteConversationDialog
        open={deleteDialogOpen}
        conversationId={conversation.id}
        conversationTitle={conversation.title}
        onClose={() => setDeleteDialogOpen(false)}
        onDeleted={() => setDeleteDialogOpen(false)}
      />

      <AskQuestionsDialog
        pending={ask.pending}
        submitting={ask.submitting}
        onSubmit={ask.submit}
        abandoned={ask.abandoned}
        onDismissAbandoned={ask.dismissAbandoned}
      />

      <ShortcutOverlayHost />
    </section>,
  );
}
