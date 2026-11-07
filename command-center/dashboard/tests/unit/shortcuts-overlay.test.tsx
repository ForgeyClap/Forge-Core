/**
 * WP B3 — the shortcut overlay: Ctrl+/ (and Cmd+/) opens and closes it, the chord does not reach
 * the command palette's "/" listener, and the list is Dutch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { CHAT_SHORTCUTS, ShortcutOverlayHost, isOverlayChord } from '@/views/chat/shortcuts/ShortcutOverlay';

describe('shortcut overlay', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  it('recognises Ctrl+/ and Cmd+/ only', () => {
    expect(isOverlayChord({ key: '/', code: 'Slash', ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isOverlayChord({ key: '?', code: 'Slash', ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isOverlayChord({ key: '/', code: 'Slash', ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isOverlayChord({ key: '/', code: 'Slash', ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  });

  it('Ctrl+/ toggles the overlay and is stopped before a bubbling "/" listener sees it', () => {
    const palette = vi.fn();
    window.addEventListener('keydown', palette);
    render(<ShortcutOverlayHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { key: '/', code: 'Slash', ctrlKey: true });
    });
    const dialog = screen.getByRole('dialog', { name: 'Sneltoetsen' });
    expect(dialog).toHaveTextContent('Bericht versturen');
    expect(dialog).toHaveTextContent('Dit overzicht openen of sluiten');
    expect(palette).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(document.body, { key: '/', code: 'Slash', ctrlKey: true });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    window.removeEventListener('keydown', palette);
  });

  it('lists every shortcut once, in three groups', () => {
    expect(CHAT_SHORTCUTS.map((group) => group.title)).toEqual([
      'chatCards.shortcuts.groups.write',
      'chatCards.shortcuts.groups.conversation',
      'chatCards.shortcuts.groups.everywhere',
    ]);
    const labels = CHAT_SHORTCUTS.flatMap((group) => group.items.map((item) => item.label));
    expect(new Set(labels).size).toBe(labels.length);
  });
});
