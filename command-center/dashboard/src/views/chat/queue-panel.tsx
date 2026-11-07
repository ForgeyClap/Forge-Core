/**
 * queue-panel — the composer's queued-message list display.
 *
 * refactor-chat-split: split out of `Composer.tsx` — the queue's own
 * STATE and flush behavior stay in `Composer.tsx` (see that file's own header, plus
 * `message-queue.ts` for the full honesty rules); this file carries only the list's own JSX. Pure
 * structural move: no behavior changed, no class name changed.
 */

import { Icon, IconButton, Machine } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';

import type { QueuedMessage } from './message-queue';

export interface ComposerQueuePanelProps {
  readonly queue: readonly QueuedMessage[];
  readonly onRemove: (id: string) => void;
}

export function ComposerQueuePanel({ queue, onRemove }: ComposerQueuePanelProps) {
  const { t } = useLocale();
  if (queue.length === 0) return null;
  return (
    <ul className="fw-chat-composer__queue" aria-label={t('chat.queue.label')}>
      {queue.map((item) => (
        <li
          key={item.id}
          className={
            item.error !== null
              ? 'fw-chat-composer__queue-item fw-chat-composer__queue-item--error'
              : 'fw-chat-composer__queue-item'
          }
        >
          <Icon name="Clock" size="sm" />
          <span className="fw-chat-composer__queue-text">
            <Machine className="fw-chat-composer__queue-body fw-truncate">{item.body}</Machine>
            {item.error !== null ? <span className="fw-chat-composer__queue-error">{item.error}</span> : null}
          </span>
          <span className="fw-chat-composer__queue-status">{item.error !== null ? t('chat.queue.notSent') : t('chat.queue.waiting')}</span>
          <IconButton icon="X" label={t('chat.queue.remove')} size="sm" onClick={() => onRemove(item.id)} />
        </li>
      ))}
    </ul>
  );
}
