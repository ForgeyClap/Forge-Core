/**
 * Redesign, part 4D-2 — the shell's last English dialogs, the sidebar landmark and the tour card budget.
 *
 *  - X2: the delete-conversation dialog speaks Dutch (title, line, Annuleren, Verwijderen, "Verwijderen…", the
 *    failure toast).
 *  - X3: the command palette speaks Dutch, uses the current route names (Klusverloop, not Mission Control; renamed from Overzicht in review F3), offers
 *    only screens the sidebar offers in the current mode, and has no commands for the old inspector and dock.
 *  - axe 'region': the sidebar brand word and the account line sit inside a landmark.
 *  - DESIGN.md §5: a tour card adds at most 14 words; Start is 32 words and the page maximum is 45, so each card
 *    is held to 13 here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Conversation } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';
import Sidebar from '@/components/shell/Sidebar';
import CommandPalette from '@/components/shell/CommandPalette';
import { ConfirmDeleteConversationDialog } from '@/components/shell/ConfirmDeleteConversationDialog';
import { TourHost } from '@/components/tour/Tour';
import { requestTourStart, TOUR_STORAGE_KEY } from '@/components/tour/tour-state';

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
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
    ...overrides,
  };
}

const CONVERSATION: Conversation = {
  prototype: true,
  id: 'c-one',
  projectId: 'proj-one',
  title: 'Eerste gesprek',
  updatedAt: '2 min ago',
  messageCount: 3,
  messages: [],
};

function withStore(element: ReactElement, state: PrototypeState, dispatch: (action: PrototypeAction) => void) {
  const value: StoreValue = { state, dispatch };
  return render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, element)));
}

/** The same word rule as DESIGN.md §5 (`tools/word-budget.mjs`), per text node (jsdom's textContent glues
 *  adjacent elements together, which would undercount). */
function words(root: Element): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent ?? '');
  return (parts.join(' ').match(/[\p{L}\d][\p{L}\d'’.:-]*/gu) ?? []).length;
}

/** English words that must never show in these Dutch surfaces. */
const ENGLISH = /\b(Delete|Deleting|Cancel|Permanently|undone|failed|Go to|View|Toggle|inspector|dock|Theme|Switch|Search|Open|forge is a dark room|Mission Control|move|run|close|gateway)\b/i;

function stubFetch(response: { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: response.ok, status: response.status, json: async () => response.body })) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  setLocale('nl');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

describe('X2 — delete-conversation dialog in Dutch', () => {
  it('title, line and both buttons are Dutch, with the conversation name kept', () => {
    withStore(
      createElement(ConfirmDeleteConversationDialog, {
        open: true,
        conversationId: CONVERSATION.id,
        conversationTitle: CONVERSATION.title,
        onClose: () => {},
        onDeleted: () => {},
      }),
      buildState(),
      vi.fn(),
    );
    const dialog = screen.getByRole('dialog', { name: 'Gesprek verwijderen' });
    expect(dialog).toHaveTextContent('Eerste gesprek');
    expect(within(dialog).getByRole('button', { name: 'Annuleren' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Verwijderen' })).toBeInTheDocument();
    expect(dialog.textContent ?? '').not.toMatch(ENGLISH);
  });

  it('shows "Verwijderen…" while busy and a Dutch failure toast', async () => {
    let release: (value: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ) as unknown as typeof fetch,
    );
    const dispatch = vi.fn();
    withStore(
      createElement(ConfirmDeleteConversationDialog, {
        open: true,
        conversationId: CONVERSATION.id,
        conversationTitle: CONVERSATION.title,
        onClose: () => {},
        onDeleted: () => {},
      }),
      buildState(),
      dispatch,
    );
    const dialog = screen.getByRole('dialog', { name: 'Gesprek verwijderen' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verwijderen' }));
    expect(await within(dialog).findByRole('button', { name: 'Verwijderen…' })).toBeDisabled();
    await act(async () => {
      release({ ok: false, status: 500, json: async () => ({}) });
    });
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'toast/push', toast: expect.objectContaining({ title: 'Verwijderen mislukt' }) }),
      ),
    );
    const toast = dispatch.mock.calls.map(([action]) => action as PrototypeAction).find((a) => a.type === 'toast/push');
    expect(JSON.stringify(toast)).not.toMatch(/Delete failed|The gateway could not/);
  });

  it('the sidebar trash button opens the same Dutch dialog', async () => {
    stubFetch({ ok: true, status: 200, body: {} });
    withStore(createElement(Sidebar), buildState({ data: { ...EMPTY_DATASET, conversations: [CONVERSATION] } }), vi.fn());
    fireEvent.click(screen.getByRole('button', { name: 'Eerste gesprek verwijderen' }));
    expect(await screen.findByRole('dialog', { name: 'Gesprek verwijderen' })).toBeInTheDocument();
  });
});

describe('X3 — command palette in Dutch with the current screens', () => {
  function openPalette(dispatch = vi.fn()) {
    stubFetch({ ok: true, status: 200, body: {} });
    withStore(createElement(CommandPalette), buildState({ paletteOpen: true }), dispatch);
    return screen.getByRole('dialog');
  }

  it('is Dutch from field to footer, and names no old panel', () => {
    setUiMode('uitgebreid');
    const dialog = openPalette();
    expect(dialog).toHaveAccessibleName('Opdrachten');
    expect(within(dialog).getByRole('combobox')).toHaveAccessibleName('Opdrachten zoeken');
    const text = dialog.textContent ?? '';
    expect(text).not.toMatch(ENGLISH);
    expect(text).not.toMatch(/Mission|agents|inspector|dock|showcase/i);
  });

  it('Uitgebreid lists the screens by their current names, without the hidden ones', () => {
    setUiMode('uitgebreid');
    const dialog = openPalette();
    const titles = within(dialog)
      .getAllByRole('option')
      .map((option) => option.querySelector('.fw-palette__option-title')?.textContent ?? '');
    for (const name of ['Start', 'Mijn projecten', 'Gesprekken', 'Klusverloop', 'Team', 'Taken', 'Leer Forge', 'Instellingen']) {
      expect(titles, name).toContain(name);
    }
    // Hidden routes (the roster, the internal design reference) are not offered.
    expect(titles.join('|')).not.toMatch(/Interne ontwerpreferentie|Eerste start|Accountwissel/);
    // The old inspector and dock toggles are gone; the one Details toggle of Uitgebreid stays.
    expect(titles).toContain('Details tonen');
  });

  it('Eenvoudig only offers what the Eenvoudig sidebar offers', () => {
    const dialog = openPalette();
    const titles = within(dialog)
      .getAllByRole('option')
      .map((option) => option.querySelector('.fw-palette__option-title')?.textContent ?? '');
    expect(titles).toContain('Mijn projecten');
    expect(titles).not.toContain('Klusverloop');
    expect(titles).not.toContain('Taken');
    expect(titles).not.toContain('Details tonen');
  });

  it('shows a project id only in Uitgebreid (Eenvoudig never shows machine text)', () => {
    stubFetch({ ok: true, status: 200, body: {} });
    const project = { ...({} as PrototypeState['data']['projects'][number]), id: 'proj-mila', name: 'Kapsalon Mila' };
    const state = buildState({ paletteOpen: true, data: { ...EMPTY_DATASET, projects: [project] } });
    const first = withStore(createElement(CommandPalette), state, vi.fn());
    expect(screen.getByRole('option', { name: /Kapsalon Mila openen/ })).not.toHaveTextContent('proj-mila');
    first.unmount();
    setUiMode('uitgebreid');
    withStore(createElement(CommandPalette), state, vi.fn());
    expect(screen.getByRole('option', { name: /Kapsalon Mila openen/ })).toHaveTextContent('proj-mila');
  });

  it('a theme command shows a Dutch toast', () => {
    const dispatch = vi.fn();
    const dialog = openPalette(dispatch);
    const option = within(dialog)
      .getAllByRole('option')
      .find((node) => node.textContent?.includes('Donker'));
    expect(option).toBeTruthy();
    fireEvent.click(option!);
    expect(dispatch).toHaveBeenCalledWith({ type: 'appearance/set', appearance: 'dark' });
    const toast = dispatch.mock.calls.map(([action]) => action as PrototypeAction).find((a) => a.type === 'toast/push');
    expect(toast && 'toast' in toast ? toast.toast.title : '').toBe('Thema: Donker');
    expect(JSON.stringify(toast)).not.toMatch(/Theme set|Stored as/);
  });
});

describe('axe region — sidebar content sits inside a landmark', () => {
  it('the brand word and the account line have a landmark ancestor', () => {
    stubFetch({ ok: true, status: 200, body: {} });
    const { container } = withStore(createElement(Sidebar), buildState(), vi.fn());
    const landmark = 'nav, main, aside, header, footer, [role="region"][aria-label], [role="navigation"], [role="complementary"]';
    for (const selector of ['.fw-side__word', '.fw-side__who-name', '.fw-side__who-word', '.fw-side__new-chat']) {
      const node = container.querySelector(selector);
      expect(node, selector).not.toBeNull();
      expect(node!.closest(landmark), `${selector} outside any landmark`).not.toBeNull();
    }
    expect(screen.getByRole('region', { name: 'Zijbalk' })).toBeInTheDocument();
  });
});

describe('tour card text budget (DESIGN.md §5)', () => {
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  beforeEach(() => {
    localStorage.removeItem(TOUR_STORAGE_KEY);
    HTMLElement.prototype.getBoundingClientRect = function rect() {
      return { top: 100, left: 300, width: 200, height: 40, right: 500, bottom: 140, x: 300, y: 100, toJSON: () => ({}) } as DOMRect;
    };
  });
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
    localStorage.removeItem(TOUR_STORAGE_KEY);
  });

  async function frames(ms = 60) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  it('each of the three cards stays at 13 words or fewer and keeps its DESIGN title', async () => {
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(TourHost),
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/',
            element: createElement(
              'div',
              null,
              createElement('textarea', { 'data-tour': 'composer', 'aria-label': 'Bericht' }),
              createElement('a', { 'data-tour': 'projects', href: '#/projects' }, 'x'),
              createElement('button', { 'data-tour': 'help', type: 'button' }, '?'),
            ),
          }),
        ),
      ),
    );
    act(() => requestTourStart());
    await frames();
    const counts: number[] = [];
    const names = ['Typ hier wat je wilt', 'Hier staat al je werk', /^Hulp nodig\?/];
    for (let stop = 0; stop < 3; stop += 1) {
      const card = screen.getByRole('dialog', { name: names[stop] });
      expect(card).toHaveTextContent(`${stop + 1} van 3`);
      counts.push(words(card));
      fireEvent.click(within(card).getByRole('button', { name: stop === 2 ? 'Klaar' : 'Volgende' }));
      await frames();
    }
    expect(counts.every((n) => n <= 13), `card words ${counts.join('/')}`).toBe(true);
  });
});
