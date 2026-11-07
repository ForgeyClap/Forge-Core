/**
 * Shortcut overlay, opened with Ctrl+/ (Cmd+/ on a Mac) (WP B3, plan §5 row B3).
 *
 * Lists the shortcuts the chat really has (Composer: Enter, Shift+Enter, Esc, "/" and "@";
 * MessageList: arrows, Home/End on a focused message; AppShell: Ctrl+K, Ctrl+B). The listener runs
 * in the capture phase and stops Ctrl+/ there, because the command palette opens on a bare "/"
 * outside a text field and does not check for Ctrl.
 */

import { useEffect, useState } from 'react';

import { KeyHint, Modal } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';

import './shortcuts.css';

export interface ChatShortcut {
  readonly keys: readonly string[];
  readonly label: MessageKey;
  /** The keys are alternatives ("↑ of ↓"), not one chord ("Shift + Enter"). */
  readonly either?: boolean;
}

export interface ShortcutGroup {
  readonly title: MessageKey;
  readonly items: readonly ChatShortcut[];
}

export const CHAT_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'chatCards.shortcuts.groups.write',
    items: [
      { keys: ['Enter'], label: 'chatCards.shortcuts.items.sendMessage' },
      { keys: ['Shift', 'Enter'], label: 'chatCards.shortcuts.items.newLine' },
      { keys: ['/'], label: 'chatCards.shortcuts.items.slash' },
      { keys: ['@'], label: 'chatCards.shortcuts.items.mention' },
      { keys: ['Esc'], label: 'chatCards.shortcuts.items.closeSuggestions' },
    ],
  },
  {
    title: 'chatCards.shortcuts.groups.conversation',
    items: [
      { keys: ['↑', '↓'], label: 'chatCards.shortcuts.items.stepMessages', either: true },
      { keys: ['Home', 'End'], label: 'chatCards.shortcuts.items.firstLast', either: true },
    ],
  },
  {
    title: 'chatCards.shortcuts.groups.everywhere',
    items: [
      { keys: ['Ctrl', 'K'], label: 'chatCards.shortcuts.items.palette' },
      { keys: ['Ctrl', 'B'], label: 'chatCards.shortcuts.items.sidebar' },
      { keys: ['Ctrl', '/'], label: 'chatCards.shortcuts.items.overlay' },
    ],
  },
];

/** True for Ctrl+/ or Cmd+/ on any keyboard layout that reports the slash key. */
export function isOverlayChord(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  return event.key === '/' || event.code === 'Slash';
}

export interface ShortcutOverlayProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ShortcutOverlay({ open, onClose }: ShortcutOverlayProps) {
  const { t } = useLocale();
  return (
    <Modal open={open} onClose={onClose} title={t('chatCards.shortcuts.title')} description={t('chatCards.shortcuts.lead')} size="md" className="fw-shortcuts">
      <div className="fw-shortcuts__groups">
        {CHAT_SHORTCUTS.map((group) => (
          <section key={group.title} className="fw-shortcuts__group">
            <h3 className="fw-shortcuts__title">{t(group.title)}</h3>
            <dl className="fw-shortcuts__list">
              {group.items.map((item) => (
                <div key={item.label} className="fw-shortcuts__row">
                  <dt className="fw-shortcuts__keys">
                    {item.either ? (
                      item.keys.map((key, index) => (
                        <span key={key} className="fw-shortcuts__alt">
                          {index > 0 ? <span className="fw-shortcuts__or">{t('chatCards.shortcuts.or')}</span> : null}
                          <KeyHint keys={[key]} size="md" />
                        </span>
                      ))
                    ) : (
                      <KeyHint keys={item.keys} size="md" />
                    )}
                  </dt>
                  <dd className="fw-shortcuts__label">{t(item.label)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** Mount once in the chat: owns the Ctrl+/ chord and the overlay's open state. */
export function ShortcutOverlayHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isOverlayChord(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen((value) => !value);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  return <ShortcutOverlay open={open} onClose={() => setOpen(false)} />;
}
