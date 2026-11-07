/**
 * FU fix round (review medium): the pairing card was a fixed overlay that could not be closed and
 * covered the first message (1264x801) and most of the screen (390x844). Now:
 *   - a close button with a Dutch label, a real <button> (keyboard: Tab + Enter/Space);
 *   - the dismissal is remembered for this browser session (sessionStorage), so a re-mount stays closed;
 *   - the notice is a slim banner in its own shell grid row under the top bar: it pushes the content
 *     down instead of floating over the conversation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { setLocale } from '@/i18n';
import nl from '@/i18n/locales/nl.json';
import { _resetPairingStateForTests, setPairingState } from '@/lib/ui-session';
import { PairingNotice } from '@/views/chat/errors/PairingCard';
import { PAIRING_DISMISS_KEY } from '@/views/chat/errors/pairing-copy';

const css = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

beforeEach(() => {
  setLocale('nl');
  sessionStorage.clear();
  _resetPairingStateForTests();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline in this test'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  setLocale('en');
});

describe('PairingNotice can be closed', () => {
  it('has a close button with a Dutch label; closing hides the notice and remembers it for the session', () => {
    const first = render(<PairingNotice />);
    act(() => setPairingState('required'));
    const close = screen.getByRole('button', { name: nl.chatCards.pairing.dismiss });
    expect(close.tagName).toBe('BUTTON');
    expect(close).toHaveAttribute('type', 'button');
    fireEvent.click(close);
    expect(first.container).toBeEmptyDOMElement();
    expect(sessionStorage.getItem(PAIRING_DISMISS_KEY)).toBe('1');

    first.unmount();
    const second = render(<PairingNotice />);
    act(() => setPairingState('required'));
    expect(second.container).toBeEmptyDOMElement();
  });

  it('without a dismissal it shows again on the next mount', () => {
    render(<PairingNotice />);
    act(() => setPairingState('required'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('PairingNotice on a phone: the explanation can be shortened', () => {
  it('a "Lees verder" button toggles the full text (aria-expanded), and the phone CSS clamps the short state', () => {
    render(<PairingNotice />);
    act(() => setPairingState('required'));
    const more = screen.getByRole('button', { name: nl.chatCards.pairing.more });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.fw-pairing')).toHaveAttribute('data-text', 'short');
    fireEvent.click(more);
    expect(screen.getByRole('button', { name: nl.chatCards.pairing.less })).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.fw-pairing')).toHaveAttribute('data-text', 'full');
    const sheet = css('src/views/chat/errors/errors.css');
    expect(sheet).toMatch(/\.fw-pairing\[data-text='short'\] \.fw-chat-error__text\s*\{[^}]*line-clamp:\s*2/);
  });
});

describe('PairingNotice placement: a banner row under the top bar, not an overlay', () => {
  it('the notice takes the shell grid area "notice" and is not position: fixed', () => {
    const rule = /\.fw-pairing-notice\s*\{([^}]*)\}/.exec(css('src/views/chat/errors/errors.css'));
    expect(rule, 'missing .fw-pairing-notice rule').not.toBeNull();
    expect(rule?.[1]).toMatch(/grid-area:\s*notice/);
    expect(rule?.[1]).not.toMatch(/position:\s*fixed/);
  });

  it('every shell grid template has a notice row between the top bar and main', () => {
    const sheet = css('src/components/shell/app-shell.css');
    const templates = [...sheet.matchAll(/grid-template-areas:([^;]*);/g)].map((m) => m[1].replace(/\s+/g, ' '));
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const areas of templates) {
      expect(areas).toMatch(/topbar[^']*'\s*'[^']*notice[^']*'\s*'[^']*main/);
    }
  });
});
