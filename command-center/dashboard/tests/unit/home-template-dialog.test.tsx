/**
 * Start (HomeView) — redesign, part 2A (DESIGN.md §3.1).
 *
 * The old "Start something" template cards were replaced by three suggestions that only FILL the
 * composer (they never send), a "Start hier" card for beginners and one quiet "Verder met" row for a
 * returning user. Locks in:
 *   - one h1, the question, and no stat cards or project counts;
 *   - a suggestion fills the composer and sends nothing;
 *   - Send on Start always starts a NEW conversation (an active one is cleared first) through the real
 *     `useChatSend()` controller, and only then opens the chat;
 *   - the checklist reads real state (connection, conversations), closes for good, and gives way to
 *     the "Verder met" row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useReducer } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Conversation } from '@/prototype/types/prototype-types';
import HomeView from '@/views/home/HomeView';
import { START_STORAGE_KEY } from '@/views/home/start-checklist';

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
  id: 'c-old',
  projectId: 'p1',
  title: 'Website voor de bakker',
  updatedAt: '2026-11-01T10:00:00.000Z',
  messageCount: 2,
  messages: [],
};

function stubChat(send: ChatSendController['send']): ChatSendController {
  return {
    run: { runId: null, status: null, active: false },
    canSend: true,
    disabledReason: null,
    sending: false,
    stopping: false,
    send,
    stop: async () => ({ ok: true, error: null }),
  };
}

/** A tiny real reducer for the two actions Start dispatches, so a cleared conversation re-renders. */
function reducer(state: PrototypeState, action: PrototypeAction): PrototypeState {
  if (action.type === 'conversation/activate') return { ...state, activeConversationId: action.id };
  return state;
}

function Harness({ initial, chat, log, children }: { initial: PrototypeState; chat: ChatSendController | null; log: PrototypeAction[]; children?: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initial);
  const value: StoreValue = {
    state,
    dispatch: (action) => {
      log.push(action);
      rawDispatch(action);
    },
  };
  const tree = createElement(PrototypeContext.Provider, { value }, children);
  return chat ? createElement(ChatSendContext.Provider, { value: chat }, tree) : tree;
}

function renderStart(initial: PrototypeState = buildState(), chat: ChatSendController | null = null) {
  const log: PrototypeAction[] = [];
  const utils = render(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(
        Harness,
        { initial, chat, log },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/', element: createElement(HomeView) }),
          createElement(Route, { path: '/chat', element: createElement('p', null, 'CHAT OPEN') }),
        ),
      ),
    ),
  );
  return { ...utils, log };
}

describe('Start (redesign 2A)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows one question, the composer and three suggestions — no stat cards, no template grid', () => {
    const { container } = renderStart();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What do you want to make?');
    expect(container.querySelector('[data-tour="composer"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Make a website' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Automate emails' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Look something up' })).toBeInTheDocument();
    expect(container.querySelector('.fw-home__system, .fw-home__templates')).toBeNull();
  });

  it('a suggestion fills the composer and sends nothing', () => {
    const send = vi.fn(async () => ({ ok: true, error: null }));
    renderStart(buildState(), stubChat(send));
    fireEvent.click(screen.getByRole('button', { name: 'Make a website' }));
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value.length).toBeGreaterThan(10);
    expect(send).not.toHaveBeenCalled();
  });

  it('Send with no active conversation starts a new one through the real controller, then opens the chat', async () => {
    const send = vi.fn(async () => ({ ok: true, error: null }));
    renderStart(buildState(), stubChat(send));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Maak een menukaart' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0] as unknown[])[0]).toBe('Maak een menukaart');
    expect(await screen.findByText('CHAT OPEN')).toBeInTheDocument();
  });

  it('Send while an older conversation is active clears it first, so the message never lands in it', async () => {
    const send = vi.fn(async () => ({ ok: true, error: null }));
    const { log } = renderStart(
      buildState({ data: { ...EMPTY_DATASET, conversations: [CONVERSATION] }, activeConversationId: 'c-old' }),
      stubChat(send),
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Iets nieuws' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(log).toContainEqual({ type: 'conversation/activate', id: '' });
    expect(await screen.findByText('CHAT OPEN')).toBeInTheDocument();
  });

  it('a refused send keeps the user on Start (the controller says why in a toast)', async () => {
    const send = vi.fn(async () => ({ ok: false, error: 'Geen project gekozen' }));
    const { log } = renderStart(buildState(), stubChat(send));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hallo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(log.some((action) => action.type === 'toast/push')).toBe(true));
    expect(screen.queryByText('CHAT OPEN')).toBeNull();
  });

  it('without the production controller, Send says honestly that nothing was sent', () => {
    const { log } = renderStart();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hallo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(log.some((action) => action.type === 'toast/push')).toBe(true);
    expect(screen.queryByText('CHAT OPEN')).toBeNull();
  });

  it('the "Start here" card counts real progress, and closing it hides it for good', () => {
    renderStart(buildState({ data: { ...EMPTY_DATASET, conversations: [CONVERSATION] } }));
    const card = screen.getByRole('region', { name: 'Start here' });
    // A conversation exists, so "ask your first question" is done (no longer a button); the proof step is not.
    expect(card.textContent).toMatch(/\d of 3/);
    expect(screen.queryByRole('button', { name: /Ask your first question/ })).toBeNull();
    expect(screen.getByRole('button', { name: /See a delivery proof/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Start here' })).toBeNull();
    expect(JSON.parse(localStorage.getItem(START_STORAGE_KEY) ?? '{}')).toMatchObject({ closed: true });
  });

  it('a returning user gets one quiet "Continue with" row instead of the card', () => {
    localStorage.setItem(START_STORAGE_KEY, JSON.stringify({ closed: true }));
    renderStart(buildState({ data: { ...EMPTY_DATASET, conversations: [CONVERSATION] } }));
    expect(screen.queryByRole('region', { name: 'Start here' })).toBeNull();
    const row = screen.getByRole('button', { name: /Website voor de bakker/ });
    fireEvent.click(row);
    expect(screen.getByText('CHAT OPEN')).toBeInTheDocument();
  });
});
