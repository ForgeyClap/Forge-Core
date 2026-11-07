/**
 * FU (review medium, step2): the "not connected" and "pair again" copy must not hand a
 * beginner a developer command.
 *   - Desktop app (any mode): the pairing card says "Start Forge Systeem opnieuw" in plain Dutch and
 *     shows no command at all (a command cannot pair the desktop window; the app sets its own cookie).
 *   - Browser: the launcher command stays (it is the only way to get a new pairing link), with the
 *     review's fixed wording: stop Forge first (Ctrl+C), running chats stop.
 *   - The top-bar Claude Code chip (shown in Eenvoudig too): in Eenvoudig its disconnected detail is a
 *     Dutch beginner sentence without `node command-center/gateway/bin.mjs`; Uitgebreid keeps the
 *     developer command.
 *   - Copy honesty (review low): the copy button only says "Gekopieerd" after the clipboard accepted it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { setLocale } from '@/i18n';
import nl from '@/i18n/locales/nl.json';
import { PAIRING_LAUNCH_COMMAND } from '@/lib/ui-session';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setUiMode } from '@/state/ui-mode';
import { ClaudeCodeChip } from '@/views/chat/ClaudeCodeChip';
import { PairingCard } from '@/views/chat/errors/PairingCard';

function buildState(): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: '',
    activeConversationId: '',
    selection: { kind: 'none' },
    pinnedProjectIds: [],
    projectQuery: '',
    agentFilter: 'all',
    agentLayout: 'grouped',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
  };
}

beforeEach(() => {
  setLocale('nl');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

describe('PairingCard copy', () => {
  it('desktop: a plain "Start Forge Systeem opnieuw" instruction and no command', () => {
    render(createElement(PairingCard, { desktop: true }));
    const card = screen.getByRole('alert');
    expect(card.textContent).toContain('Start Forge Systeem opnieuw');
    expect(card.textContent).not.toContain(PAIRING_LAUNCH_COMMAND);
    expect(card.querySelector('code')).toBeNull();
  });

  it('desktop in Uitgebreid: still no command (it cannot pair the desktop window)', () => {
    setUiMode('uitgebreid');
    render(createElement(PairingCard, { desktop: true }));
    expect(screen.getByRole('alert').querySelector('code')).toBeNull();
  });

  it('browser: the launcher command stays, and the text says to stop Forge first', () => {
    render(createElement(PairingCard, { desktop: false }));
    expect(screen.getByText(PAIRING_LAUNCH_COMMAND).tagName).toBe('CODE');
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('Ctrl+C');
    expect(text).toContain(nl.chatCards.pairing.bodyBrowser);
  });

  it('copy honesty: without a clipboard the button never says "Gekopieerd"', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(createElement(PairingCard, { desktop: false }));
    fireEvent.click(screen.getByRole('button', { name: nl.chatCards.pairing.copy }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: nl.chatCards.pairing.copied })).toBeNull();
    expect(screen.getByRole('button', { name: nl.chatCards.pairing.copy })).toBeInTheDocument();
  });

  it('copy honesty: a refused clipboard write keeps the copy label', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(createElement(PairingCard, { desktop: false }));
    fireEvent.click(screen.getByRole('button', { name: nl.chatCards.pairing.copy }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(PAIRING_LAUNCH_COMMAND);
    expect(screen.queryByRole('button', { name: nl.chatCards.pairing.copied })).toBeNull();
  });

  it('copy honesty: an accepted write says "Gekopieerd"', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(createElement(PairingCard, { desktop: false }));
    fireEvent.click(screen.getByRole('button', { name: nl.chatCards.pairing.copy }));
    expect(await screen.findByRole('button', { name: nl.chatCards.pairing.copied })).toBeInTheDocument();
  });
});

describe('PairingNotice placement', () => {
  // FU fix round: the floating overlay covered the conversation; the notice now has its own named shell
  // grid row (`notice`), so it is never auto-placed as an extra column and never floats over content.
  // The full contract is in pairing-banner.test.tsx.
  it('takes the named shell grid area, so the grid never auto-places it as an extra column', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/views/chat/errors/errors.css'), 'utf8');
    const rule = /\.fw-pairing-notice\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'missing .fw-pairing-notice rule').not.toBeNull();
    expect(rule?.[1]).toMatch(/grid-area:\s*notice/);
  });
});

describe('ClaudeCodeChip disconnected in the browser', () => {
  async function openDisconnectedChip(): Promise<string> {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const value: StoreValue = { state: buildState(), dispatch: vi.fn() };
    render(createElement(PrototypeContext.Provider, { value }, createElement(ClaudeCodeChip)));
    const chip = document.querySelector<HTMLButtonElement>('.fw-chat-cc__chip');
    expect(chip).not.toBeNull();
    await waitFor(() => expect(document.body.textContent).toMatch(/disconnected|not connected|niet verbonden/i), {
      timeout: 3000,
    });
    act(() => {
      fireEvent.click(chip as HTMLButtonElement);
    });
    return document.body.textContent ?? '';
  }

  it('Eenvoudig: a Dutch beginner sentence, no developer command', async () => {
    setUiMode('eenvoudig');
    const text = await openDisconnectedChip();
    expect(text).not.toContain('bin.mjs');
    expect(text).toContain(nl.shell.connection.disconnectedSimple);
  });

  it('Uitgebreid: the developer command is still there', async () => {
    setUiMode('uitgebreid');
    const text = await openDisconnectedChip();
    expect(text).toContain('node command-center/gateway/bin.mjs');
  });
});
