/**
 * MessageList — the scrolling thread.
 *
 * Owns three things the view above it should not have to think about:
 *
 *   scrolling   it sticks to the bottom while a reply is revealing, and lets go
 *               the moment the reader scrolls up. A "latest" button appears in
 *               that state instead of yanking the page back down.
 *   keyboard    every turn is focusable, and Up / Down / Home / End move
 *               between turns once one of them has focus.
 *   announcing  the list is a polite log limited to additions, so a screen
 *               reader hears a new turn arrive without hearing the streaming
 *               text re-read on every tick. A separate status line says when
 *               the reply starts and when it is finished.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { usePrototype } from '@/prototype/state/prototype-store';
import { Button, ExampleTag, Eyebrow } from '@/components/primitives';
import { isProductionMode } from '@/config/mode';
import type { ChatSendOutcome } from '@/prototype/state/chat-send';
import { readChatMessageRequestedModel } from '@/prototype/state/gateway-chat';
import { useLocale } from '@/i18n/use-locale';
import { Message } from './Message';

export interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  /** Id of the message currently being revealed, or null when nothing streams. */
  readonly streamingId: string | null;
  /** Used as the accessible name of the log. */
  readonly conversationTitle: string;
  /**
   * Given a message's index in `messages`, returns the real regenerate action for
   * that turn, or null when there is none (a fixture reply, or no preceding user
   * turn to re-send). Omitted entirely on the fixture path.
   */
  readonly regenerateFor?: (index: number) => (() => Promise<ChatSendOutcome>) | null;
}

/** How close to the end still counts as "at the bottom", in pixels. */
const BOTTOM_SLACK = 48;


export function MessageList({
  messages,
  streamingId,
  conversationTitle,
  regenerateFor,
}: MessageListProps) {
  const { state } = usePrototype();
  const { t } = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);

  // Derived, not stored: the status line is a pure function of the simulator's
  // state, so there is no effect writing state back into React.
  const { stream } = state;
  const announcement = stream === null ? '' : stream.done ? t('chat.thread.streamEnd') : t('chat.thread.streamStart');

  // Follow the tail while the reader has not moved away from it. `messages` is a
  // fresh array on every reveal tick, so this runs as the reply grows.
  useEffect(() => {
    if (!stuckToBottom) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, stuckToBottom]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setStuckToBottom(distance <= BOTTOM_SLACK);
  }, []);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: state.reducedMotion ? 'auto' : 'smooth',
    });
    setStuckToBottom(true);
  }, [state.reducedMotion]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;

    const target = event.target as HTMLElement;
    // Only steer when a turn itself has focus — never while typing in a control.
    if (!target.hasAttribute('data-chat-message')) return;

    const turns = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[data-chat-message]'),
    );
    if (turns.length === 0) return;

    const current = turns.indexOf(target);
    let next = current;
    if (key === 'ArrowDown') next = Math.min(turns.length - 1, current + 1);
    else if (key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (key === 'Home') next = 0;
    else next = turns.length - 1;

    if (next !== current && next >= 0) {
      event.preventDefault();
      turns[next].focus();
    }
  }, []);

  return (
    <div className="fw-chat-thread">
      <div className="fw-chat-thread__scroll" ref={scrollRef} onScroll={handleScroll}>
        {/* role="log" sits on a plain wrapper: on the <ol> itself it strips the list role, so every turn would be a
            list item outside a list (axe listitem + aria-allowed-role, redesign wave 4 part 4D-1). */}
        <div
          className="fw-chat-thread__log"
          role="log"
          aria-label={t('chat.thread.label', { title: conversationTitle })}
          aria-live="polite"
          aria-relevant="additions"
          onKeyDown={handleKeyDown}
        >
          <ol className="fw-chat-thread__list">
            <li className="fw-chat-thread__start">
              <Eyebrow>{t('chat.thread.start')}</Eyebrow>
              {/* A real conversation names no engine here: the router may run it on Claude, Codex, Ollama or an
                  own model, and each answer's own "via …" badge says which (review F8). Only the example thread
                  needs a line, to say that nothing is real. */}
              {isProductionMode() ? null : (
                <>
                  <span className="fw-chat-thread__start-text">{t('chat.thread.example')}</span>
                  <ExampleTag />
                </>
              )}
            </li>

            {messages.map((message, index) => {
              // feat-model-picker: the model the PRECEDING user turn requested, only ever computed
              // for a real assistant reply immediately following a real user turn — mirrors
              // `ChatView.tsx`'s own `resolveRegenerate`'s "previous message must be author:'user'"
              // check, done here instead since `Message.tsx` only ever sees its own single turn.
              const previous = index > 0 ? messages[index - 1] : null;
              const requestedModel =
                message.author !== 'user' && previous !== null && previous.author === 'user'
                  ? readChatMessageRequestedModel(previous)
                  : null;
              return (
                // A user turn and its answer share the gateway `turn_id` (= message.id): the author keeps the key unique.
                <li key={`${message.author}:${message.id}`} className="fw-chat-thread__item">
                  <Message
                    message={message}
                    streaming={message.id === streamingId}
                    position={index + 1}
                    total={messages.length}
                    regenerate={regenerateFor ? regenerateFor(index) : null}
                    requestedModel={requestedModel}
                  />
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {stuckToBottom ? null : (
        <Button
          className="fw-chat-thread__jump"
          size="sm"
          icon="ArrowDown"
          onClick={jumpToLatest}
        >
          {t('chat.thread.latest')}
        </Button>
      )}

      <p className="fw-visually-hidden" role="status">
        {announcement}
      </p>
    </div>
  );
}
