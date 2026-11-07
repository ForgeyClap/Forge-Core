/**
 * Inspector — the conversation panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'conversation'`, unchanged (comments included verbatim). See that
 * file's own header for the full refactor rationale.
 */

import { Machine } from '@/components/primitives';
import { t } from '@/i18n';
import { selectConversation, selectProject } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { renderMarkdown } from '@/views/chat/markdown';
import { Chips, Fields, KIND_LABEL, Section, Quiet } from './inspector-shared';
import type { Detail } from './inspector-shared';

export function buildConversationDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'conversation' }>,
  production: boolean,
): Detail | null {
  const conversation = selectConversation(state, selection.id);
  if (!conversation) return null;
  const project = selectProject(state, conversation.projectId);
  const messages = conversation.messages;
  const last = messages[messages.length - 1];
  const models = Array.from(
    new Set(messages.map((message) => message.model).filter((model): model is string => Boolean(model))),
  );
  const author = last?.author === 'user' ? t('inspector.conversation.you') : t('inspector.conversation.forge');
  return {
    eyebrow: KIND_LABEL.conversation,
    title: conversation.title,
    // fix-ui-clutter (item 3): the raw conversation id (`c-ms6e73oh-…`) used to render as
    // visible subtitle text next to a title that could ALSO be that same raw id (see
    // `gateway-chat.ts`'s title-fallback fix) — now the id is a hover tooltip only.
    titleTooltip: conversation.id,
    body: (
      <>
        <Fields
          rows={[
            { label: t('inspector.conversation.project'), value: project ? project.name : <Machine>{conversation.projectId}</Machine> },
            { label: t('inspector.conversation.messages'), value: conversation.messageCount },
            { label: t('inspector.conversation.updated'), value: <Quiet>{conversation.updatedAt}</Quiet> },
          ]}
        />
        {last ? (
          <Section title={t('inspector.conversation.lastMessage')} defaultOpen count={author}>
            <div className="fw-inspector__meta">
              <Quiet>{author}</Quiet>
              <span className="fw-inspector__dot" aria-hidden="true" />
              <Quiet>{last.timestamp}</Quiet>
            </div>
            {/* WP-8d: the message is Markdown — render it with the chat's own safe renderer
                (real React elements, no HTML injection, links get rel="noreferrer noopener")
                instead of showing the raw `**` and backticks. */}
            <div className="fw-inspector__excerpt fw-inspector__md fw-chat-md fw-scroll">
              {renderMarkdown(last.body, { idPrefix: `insp-${conversation.id}` })}
            </div>
          </Section>
        ) : null}
        {models.length > 0 ? (
          <Section title={t('inspector.conversation.models')} count={models.length}>
            <Chips items={models} label={t('inspector.conversation.modelsLabel')} />
            <p className="fw-inspector__hint">
              {production ? t('inspector.conversation.modelsLive') : t('inspector.conversation.modelsExample')}
            </p>
          </Section>
        ) : null}
        <Section title={t('inspector.conversation.history')} count={messages.length}>
          <div className="fw-inspector__links">
            {messages.slice(-6).map((message) => (
              <div key={message.id} className="fw-inspector__row">
                <Quiet>{message.timestamp}</Quiet>
                <span className="fw-truncate fw-inspector__row-text">
                  {message.body.replace(/[#*`>|-]/g, ' ').trim().slice(0, 64) || '—'}
                </span>
              </div>
            ))}
          </div>
        </Section>
      </>
    ),
  };
}
