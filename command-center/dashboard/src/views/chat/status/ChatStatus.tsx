/**
 * ChatStatusChip — the conversation's status, top right of the chat (WP B3).
 *
 * Eenvoudig: one of four words (Bezig · Wacht op jou · Gepauzeerd · Mislukt); a finished turn
 * (COMPLETED) shows no chip in either mode, the answer itself says it is done. Uitgebreid adds the
 * detailed Dutch state and the protocol name from the logs (`data-log-name`, so the jargon test
 * treats it as a log name, as PRODUCT-CARD.md allows in Uitgebreid). Colour never carries the
 * meaning alone: every state has its own glyph and its word.
 */

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { useUiMode } from '@/state/ui-mode';
import type { UiMode } from '@/state/ui-mode';

import { toSimpleState } from './status-model';
import type { ProtocolState, SimpleState } from './status-model';
import './status.css';

const GLYPH: Readonly<Record<SimpleState, string>> = {
  busy: 'Loader',
  waiting: 'Hourglass',
  paused: 'CircleSlash',
  failed: 'CircleX',
};

export interface ChatStatusChipProps {
  /** null = nothing to show yet. */
  readonly state: ProtocolState | null;
  /** Defaults to the user's chosen mode. */
  readonly mode?: UiMode;
}

export function ChatStatusChip({ state, mode }: ChatStatusChipProps) {
  const { t } = useLocale();
  const { mode: chosen } = useUiMode();
  if (state === null) return null;
  const simple = toSimpleState(state);
  if (simple === null) return null;
  const advanced = (mode ?? chosen) === 'uitgebreid';
  return (
    <span className="fw-chat-status" data-simple={simple} data-state={state} role="status" aria-label={t('chatCards.status.label')}>
      <span className="fw-chat-status__glyph" aria-hidden="true">
        <Icon name={GLYPH[simple]} size="xs" />
      </span>
      <span className="fw-chat-status__word">{t(`chatCards.status.simple.${simple}`)}</span>
      {advanced ? (
        <>
          <span className="fw-chat-status__detail">{t(`chatCards.status.detail.${state}`)}</span>
          <code className="fw-chat-status__code fg-machine" data-log-name="">
            {state}
          </code>
        </>
      ) : null}
    </span>
  );
}
