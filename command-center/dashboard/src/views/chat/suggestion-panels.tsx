/**
 * suggestion-panels — the composer's `@`-mention and `/`-slash-command popovers.
 *
 * refactor-chat-split: split out of `Composer.tsx` — the DETECTION/
 * filtering logic already lived in `mention-files.ts`/`slash-commands.ts` (feat-composer-power);
 * this file carries only the two popovers' own JSX, which had stayed inline in `Composer.tsx`
 * until now. Each panel gates its own visibility (`null` when there is nothing to show) so the
 * caller renders both unconditionally. Pure structural move: no behavior changed, no class name
 * changed.
 */

import { Icon, Machine } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';

import type { ActiveMentionToken, MentionFileEntry, MentionIndexState } from './mention-files';
import type { SlashCommand } from './slash-commands';

export interface MentionSuggestionsProps {
  readonly token: ActiveMentionToken | null;
  readonly status: MentionIndexState['status'];
  readonly results: readonly MentionFileEntry[];
  readonly hasActiveProject: boolean;
  readonly onChoose: (entry: MentionFileEntry) => void;
}

export function MentionSuggestions({ token, status, results, hasActiveProject, onChoose }: MentionSuggestionsProps) {
  const { t } = useLocale();
  if (token === null) return null;
  return (
    <div className="fw-chat-menu__panel fw-chat-composer__suggest-panel" role="listbox" aria-label={t('chat.suggest.mentionTitle')}>
      <p className="fg-eyebrow fw-chat-menu__title">{t('chat.suggest.mentionTitle')}</p>
      {status === 'loading' && results.length === 0 ? (
        <p className="fw-chat-menu__note">{t('chat.suggest.loadingFiles')}</p>
      ) : !hasActiveProject ? (
        <p className="fw-chat-menu__note">{t('chat.suggest.selectProject')}</p>
      ) : results.length === 0 ? (
        <p className="fw-chat-menu__note">
          {token.query === '' ? t('chat.suggest.typeToSearch') : t('chat.suggest.noFileMatch', { query: token.query })}
        </p>
      ) : (
        results.map((entry) => (
          <button
            key={entry.path}
            type="button"
            role="option"
            className="fw-chat-menu__item"
            onClick={() => onChoose(entry)}
          >
            <Icon name="FileText" size="sm" />
            <span className="fw-chat-menu__item-text">
              <Machine className="fw-chat-menu__item-label">{entry.name}</Machine>
              <span className="fw-chat-menu__item-detail fw-truncate">{entry.path}</span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

export interface SlashCommandSuggestionsProps {
  readonly query: string | null;
  readonly results: readonly SlashCommand[];
  readonly onChoose: (command: SlashCommand) => void;
}

export function SlashCommandSuggestions({ query, results, onChoose }: SlashCommandSuggestionsProps) {
  const { t } = useLocale();
  if (query === null) return null;
  return (
    <div className="fw-chat-menu__panel fw-chat-composer__suggest-panel" role="listbox" aria-label={t('chat.suggest.commandsLabel')}>
      <p className="fg-eyebrow fw-chat-menu__title">{t('chat.suggest.commandsTitle')}</p>
      {results.length === 0 ? (
        <p className="fw-chat-menu__note">{t('chat.suggest.noCommand')}</p>
      ) : (
        results.map((command) => (
          <button
            key={command.id}
            type="button"
            role="option"
            className="fw-chat-menu__item"
            onClick={() => onChoose(command)}
          >
            <Icon name={command.icon} size="sm" />
            <span className="fw-chat-menu__item-text">
              <Machine className="fw-chat-menu__item-label">{command.label}</Machine>
              <span className="fw-chat-menu__item-detail">{command.detail}</span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
