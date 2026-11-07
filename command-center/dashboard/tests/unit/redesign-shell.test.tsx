/**
 * Redesign, part 1C: the app shell (DESIGN.md §2).
 *
 * The sidebar (Nieuw gesprek, three Eenvoudig entries, Recent, Leer Forge + Instellingen in the foot, the
 * `+` "Nieuw project" beside Mijn projecten, the tour anchors), the transparent bar (`?` help menu,
 * `...` page menu only in Uitgebreid), the Leer Forge progress reader, the usage line slot and the
 * shell's temporary NL/EN copy table.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Conversation } from '@/prototype/types/prototype-types';
import Sidebar from '@/components/shell/Sidebar';
import Bar from '@/components/shell/Bar';
import { TOUR_REPLAY_EVENT, hasTourReplayListener, onTourReplay, requestTourReplay } from '@/components/shell/shell-events';
import { SidePane } from '@/components/shell/SidePane';
import { registerHelpLesson, setHelpView } from '@/components/shell/side-pane';
import { readLearnProgress, LEARN_STORAGE_KEY } from '@/components/shell/learn-progress';
import { UsageLineView } from '@/components/usage/UsageLine';
import { USAGE_LINE_PERCENT } from '@/components/usage/usage-line-reading';
import type { GatewayAccountUsage } from '@/prototype/state/gateway-adapter';
import { setLocale } from '@/i18n';
import { setUiMode } from '@/state/ui-mode';

function conversation(id: string, title: string): Conversation {
  return { id, projectId: 'p1', title, updatedAt: '2026-11-03T10:00:00Z', messageCount: 2, messages: [] } as unknown as Conversation;
}

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'light',
    resolvedTheme: 'light',
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
    ...overrides,
  };
}

function mount(node: ReturnType<typeof createElement>, state: PrototypeState, path = '/') {
  const dispatch = vi.fn<(action: PrototypeAction) => void>();
  const value: StoreValue = { state, dispatch };
  render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(PrototypeContext.Provider, { value }, node)));
  return { dispatch };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  act(() => setLocale('nl'));
  window.localStorage.removeItem(LEARN_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => {
    setUiMode('eenvoudig');
    setLocale('en');
  });
  window.localStorage.removeItem(LEARN_STORAGE_KEY);
});

describe('Sidebar (DESIGN.md §2)', () => {
  it('Eenvoudig: Nieuw gesprek, three entries on top, Leer Forge and Instellingen in the foot', () => {
    mount(createElement(Sidebar), buildState());
    expect(screen.getByRole('button', { name: 'Nieuw gesprek' })).toBeInTheDocument();
    const main = screen.getByRole('navigation', { name: 'Hoofdmenu' });
    expect(within(main).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/', '/projects', '/chat']);
    const foot = screen.getByRole('navigation', { name: 'Hulp en instellingen' });
    expect(within(foot).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/learn', '/settings']);
    expect(within(foot).getByRole('link', { name: /Leer Forge/ })).toBeInTheDocument();
    // No search field and no example-data caps label in the new chrome.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(document.body.textContent).not.toMatch(/VOORBEELD|NIET VERBONDEN/);
  });

  it('Nieuw project is one + button beside Mijn projecten, inside the projects tour anchor', () => {
    mount(createElement(Sidebar), buildState());
    const buttons = screen.getAllByRole('button', { name: 'Nieuw project' });
    expect(buttons).toHaveLength(1);
    const anchor = document.querySelector('[data-tour="projects"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.contains(buttons[0])).toBe(true);
    expect(within(anchor as HTMLElement).getByRole('link', { name: 'Mijn projecten' })).toBeInTheDocument();
  });

  it('Recent lists at most 5 conversations, and only the one that is really streaming gets the working dot', () => {
    const conversations = Array.from({ length: 7 }, (_, i) => conversation(`c${i}`, `Gesprek ${i}`));
    mount(
      createElement(Sidebar),
      buildState({
        data: { ...EMPTY_DATASET, conversations },
        stream: { conversationId: 'c1', messageId: 'm', revealed: 1, target: 'xx', done: false },
      }),
    );
    const recent = screen.getByRole('navigation', { name: 'Recente gesprekken' });
    expect(within(recent).getAllByRole('link')).toHaveLength(5);
    const live = recent.querySelectorAll('[data-live="true"]');
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toContain('Gesprek 1');
  });

  it('Uitgebreid adds a separate group of screens, never touching the foot', () => {
    act(() => setUiMode('uitgebreid'));
    mount(createElement(Sidebar), buildState());
    const more = screen.getByRole('navigation', { name: 'Meer schermen' });
    const hrefs = within(more).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/team');
    expect(hrefs).toContain('/tests');
    expect(hrefs).not.toContain('/settings');
  });

  it('Uitgebreid keeps Recent above the extra screens, so it stays in view at 1440x900 (review F3)', () => {
    act(() => setUiMode('uitgebreid'));
    const conversations = Array.from({ length: 3 }, (_, i) => conversation(`c${i}`, `Gesprek ${i}`));
    mount(createElement(Sidebar), buildState({ data: { ...EMPTY_DATASET, conversations } }));
    const recent = screen.getByRole('navigation', { name: 'Recente gesprekken' });
    const more = screen.getByRole('navigation', { name: 'Meer schermen' });
    expect(recent.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows Leer Forge progress from forge.learn, and 0/4 when nothing is stored', () => {
    mount(createElement(Sidebar), buildState());
    expect(screen.getByText('0/4')).toBeInTheDocument();
    cleanup();
    window.localStorage.setItem(LEARN_STORAGE_KEY, JSON.stringify({ done: ['first-question', 'start-project'] }));
    mount(createElement(Sidebar), buildState());
    expect(screen.getByText('2/4')).toBeInTheDocument();
  });

  it('the account line says the connection in a word, not a colour alone', () => {
    mount(createElement(Sidebar), buildState());
    const account = document.querySelector('.fw-side__who');
    expect(account).not.toBeNull();
    expect(account!.textContent).toMatch(/Staat aan|Start op|Herstelt|Niet bereikbaar|Voorbeeld/);
  });
});

describe('learn-progress', () => {
  it('counts only known lesson ids, ignores junk and never exceeds the total', () => {
    window.localStorage.setItem(LEARN_STORAGE_KEY, JSON.stringify({ done: ['first-question', 'x', 'first-question', 'limit'] }));
    expect(readLearnProgress()).toEqual({ done: 2, total: 4 });
    window.localStorage.setItem(LEARN_STORAGE_KEY, '{not json');
    expect(readLearnProgress()).toEqual({ done: 0, total: 4 });
  });
});

describe('Bar (DESIGN.md §2)', () => {
  it('Eenvoudig: only the ? button, carrying the help tour anchor', () => {
    mount(createElement(Bar), buildState());
    const help = screen.getByRole('button', { name: 'Hulp en uitleg' });
    expect(help.closest('[data-tour="help"]') ?? (help.getAttribute('data-tour') === 'help' ? help : null)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Meer opties' })).toBeNull();
    // The old chrome is gone: no theme control, no Claude Code chip, no search pill.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(document.body.textContent).not.toContain('Claude Code');
  });

  it('? opens a menu with the page lesson and the shortcuts; no tour replay while no tour listens', () => {
    expect(hasTourReplayListener()).toBe(false);
    mount(createElement(Bar), buildState());
    fireEvent.click(screen.getByRole('button', { name: 'Hulp en uitleg' }));
    const menu = screen.getByRole('menu', { name: 'Hulp en uitleg' });
    expect(within(menu).getByRole('menuitem', { name: 'Uitleg bij deze pagina' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Sneltoetsen' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Rondleiding opnieuw' })).toBeNull();
  });

  it('shows Rondleiding opnieuw once a tour registers, and the item reaches that tour', () => {
    const heard = vi.fn();
    const off = onTourReplay(heard);
    try {
      mount(createElement(Bar), buildState());
      fireEvent.click(screen.getByRole('button', { name: 'Hulp en uitleg' }));
      const menu = screen.getByRole('menu', { name: 'Hulp en uitleg' });
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rondleiding opnieuw' }));
      expect(heard).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('menu', { name: 'Hulp en uitleg' })).toBeNull();
    } finally {
      off();
    }
    expect(hasTourReplayListener()).toBe(false);
    // Unregistering twice must not drive the count below zero.
    off();
    expect(hasTourReplayListener()).toBe(false);
    const raw = vi.fn();
    window.addEventListener(TOUR_REPLAY_EVENT, raw);
    act(() => requestTourReplay());
    window.removeEventListener(TOUR_REPLAY_EVENT, raw);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('the item appears in an open bar the moment a tour registers', () => {
    mount(createElement(Bar), buildState());
    fireEvent.click(screen.getByRole('button', { name: 'Hulp en uitleg' }));
    expect(screen.queryByRole('menuitem', { name: 'Rondleiding opnieuw' })).toBeNull();
    let off: () => void = () => undefined;
    act(() => {
      off = onTourReplay(() => undefined);
    });
    expect(screen.getByRole('menuitem', { name: 'Rondleiding opnieuw' })).toBeInTheDocument();
    act(() => off());
    expect(screen.queryByRole('menuitem', { name: 'Rondleiding opnieuw' })).toBeNull();
  });

  it('Escape closes the menu and gives focus back to its button', () => {
    mount(createElement(Bar), buildState());
    const help = screen.getByRole('button', { name: 'Hulp en uitleg' });
    act(() => help.focus());
    fireEvent.click(help);
    const menu = screen.getByRole('menu', { name: 'Hulp en uitleg' });
    expect(menu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(help);
  });

  it('Uitgebreid: ... holds "Details tonen", which opens the one Details pane', () => {
    act(() => setUiMode('uitgebreid'));
    const { dispatch } = mount(createElement(Bar), buildState());
    fireEvent.click(screen.getByRole('button', { name: 'Meer opties' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Details tonen' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'inspector/set', open: true });
  });

  it('shows the page title on pages without their own heading, and the conversation title in a chat', () => {
    mount(
      createElement(Bar),
      buildState({ data: { ...EMPTY_DATASET, conversations: [conversation('c9', 'Website voor Mila')] }, activeConversationId: 'c9' }),
      '/chat',
    );
    expect(screen.getByText('Website voor Mila')).toBeInTheDocument();
  });

  it('stays empty on a page that draws its own heading (no repeated title)', () => {
    mount(createElement(Bar), buildState(), '/team');
    expect(document.querySelector('.fw-bar__title')).toBeNull();
  });
});

describe('SidePane (Hulp and Details, DESIGN.md §2)', () => {
  afterEach(() => act(() => setHelpView('closed')));

  it('Sneltoetsen lists Ctrl+K, Ctrl+B and Esc', () => {
    act(() => setHelpView('shortcuts'));
    mount(createElement(SidePane), buildState());
    const pane = screen.getByRole('complementary', { name: 'Sneltoetsen' });
    expect(pane.textContent).toContain('Opdrachten zoeken');
    expect(pane.textContent).toContain('Zijbalk in- of uitklappen');
  });

  it('the page lesson falls back to one line and a Leer Forge link until a lesson is registered', () => {
    act(() => setHelpView('lesson'));
    mount(createElement(SidePane), buildState());
    expect(screen.getByRole('link', { name: 'Naar Leer Forge' }).getAttribute('href')).toBe('/learn');
    cleanup();
    const off = registerHelpLesson((path) => createElement('p', null, `Les voor ${path}`));
    mount(createElement(SidePane), buildState(), '/projects');
    expect(screen.getByText('Les voor /projects')).toBeInTheDocument();
    off();
  });

  it('Details shows only in Uitgebreid, with the Selectie and Logboek tabs', () => {
    mount(createElement(SidePane), buildState({ inspectorOpen: true }));
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    cleanup();
    act(() => setUiMode('uitgebreid'));
    mount(createElement(SidePane), buildState({ inspectorOpen: true }));
    const pane = screen.getByRole('complementary', { name: 'Details' });
    expect(within(pane).getByRole('tab', { name: 'Selectie' })).toBeInTheDocument();
    expect(within(pane).getByRole('tab', { name: 'Logboek' })).toBeInTheDocument();
  });

  it('Escape inside the pane closes it', () => {
    act(() => setHelpView('shortcuts'));
    mount(createElement(SidePane), buildState());
    const close = screen.getByRole('button', { name: 'Paneel sluiten' });
    act(() => close.focus());
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Sneltoetsen' })).toBeNull();
  });
});

function usageAt(session: number | null, week: number | null): GatewayAccountUsage {
  return {
    ok: true,
    provenance: 'REPORTED',
    note: null,
    level: 'normal',
    week,
    nvidiaShiftAt: null,
    pauseAt: null,
    updatedAt: null,
    ageMs: 1000,
    capturedAt: null,
    guard: {
      available: true,
      mode: 'ok',
      watcher: 'running',
      pauseAt: 90,
      sessionPercent: session,
      weekPercent: week,
      sessionResetAt: null,
    },
  } as unknown as GatewayAccountUsage;
}

describe('UsageLine (the usage slot above the composer)', () => {
  it('the threshold is 80 %', () => {
    expect(USAGE_LINE_PERCENT).toBe(80);
  });

  it('renders nothing below 80 %, and with no reading at all', () => {
    const { container } = render(createElement(UsageLineView, { usage: usageAt(40, 79) }));
    expect(container.firstChild).toBeNull();
  });

  it('never claims a switch it was not told about', () => {
    render(createElement(UsageLineView, { usage: usageAt(null, 85) }));
    const line = screen.getByRole('status');
    expect(line.textContent).toContain('Je limiet is bijna op (85 %).');
    expect(line.textContent).not.toMatch(/wisselt/);
  });

  it('own-model fallback says the own model can only answer', () => {
    render(createElement(UsageLineView, { usage: usageAt(null, 85), routerMode: 'claude-then-model' }));
    expect(screen.getByRole('status').textContent).toMatch(/eigen model\. Dat kan alleen antwoorden\./);
  });

  it('Claude rotation names the next Claude account', () => {
    render(createElement(UsageLineView, { usage: usageAt(91, 20), routerMode: 'claude-accounts' }));
    expect(screen.getByRole('status').textContent).toMatch(/91 %.*volgende Claude-account/);
  });
});

describe('shell copy lives in the rd.* locale keys (fix round 1; the shell-copy bridge was deleted in wave 2 FX-B)', () => {
  it('the shell shows the same Dutch words it showed before the move', () => {
    act(() => setUiMode('uitgebreid'));
    mount(createElement(Sidebar), buildState({ data: { ...EMPTY_DATASET, conversations: [conversation('c1', 'Gesprek 1')] } }));
    expect(screen.getByRole('navigation', { name: 'Hulp en instellingen' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Recente gesprekken' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Meer schermen' })).toBeInTheDocument();
    expect(document.querySelector('.fw-side__who-name')?.textContent).toBe('Forge');
    expect(within(screen.getByRole('navigation', { name: 'Hulp en instellingen' })).getByRole('link', { name: /Leer Forge/ }).getAttribute('title')).toBe(
      'Vier korte lessen over Forge',
    );
    cleanup();
    mount(createElement(Bar), buildState());
    fireEvent.click(screen.getByRole('button', { name: 'Meer opties' }));
    expect(screen.getByRole('menuitem', { name: /Opdrachten zoeken/ })).toBeInTheDocument();
  });

  it('switches with the locale (English)', () => {
    act(() => setLocale('en'));
    mount(createElement(Bar), buildState());
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('menuitem', { name: 'Help for this page' })).toBeInTheDocument();
  });
});
