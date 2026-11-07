/**
 * Redesign fix round, part FX-A: Start (HomeView). Each test locks one review finding.
 *
 *   F1  "Account verbonden" comes from a real account signal (a connected provider row, or the checkup:
 *       Claude signed in, Codex found, Ollama up with models), never from the gateway connection.
 *   F5  "Bekijk een opleverbewijs" opens the one proof destination (/jobs, as Leer Forge lesson 3) and does
 *       not tick itself; only a proof that was actually shown (`markStartProofSeen`) ticks it.
 *   F7  With no active project, Start says so in one short Dutch line, and Send never sends (so the English
 *       controller error never reaches a toast). "Nieuw project" shows once: the composer's project chip
 *       (fix round XR-START, text budget §5); the line itself has no second button.
 *   L1  The usage line sits above the Start composer too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useReducer } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { setLocale, t } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { parseProviders } from '@/prototype/state/adapter/providers';
import { parseCheckup } from '@/components/checkup/checkup-model';
import HomeView from '@/views/home/HomeView';
import { START_STORAGE_KEY, accountReadyFrom, markStartProofSeen } from '@/views/home/start-checklist';

// The gateway itself is up in every test here: F1 is about that NOT being enough for "Account verbonden".
vi.mock('@/prototype/state/gateway-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/prototype/state/gateway-adapter')>();
  return { ...actual, useGatewayConnection: () => ({ status: 'CONNECTED' }) };
});

// L1: a marker in place of the real usage line, so its position can be checked without a usage reading.
vi.mock('@/components/usage/UsageLine', () => {
  const Marker = () => createElement('p', { 'data-testid': 'usage-line' });
  return { UsageLine: Marker, default: Marker };
});

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

function stubChat(send: ChatSendController['send'], disabledReason: string | null = null): ChatSendController {
  return {
    run: { runId: null, status: null, active: false },
    canSend: disabledReason === null,
    disabledReason,
    sending: false,
    stopping: false,
    send,
    stop: async () => ({ ok: true, error: null }),
  };
}

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

function renderStart(chat: ChatSendController | null = null) {
  const log: PrototypeAction[] = [];
  const utils = render(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(
        Harness,
        { initial: buildState(), chat, log },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/', element: createElement(HomeView) }),
          createElement(Route, { path: '/jobs', element: createElement('p', null, 'JOBS OPEN') }),
          createElement(Route, { path: '/artifacts', element: createElement('p', null, 'ARTIFACTS OPEN') }),
          createElement(Route, { path: '/chat', element: createElement('p', null, 'CHAT OPEN') }),
        ),
      ),
    ),
  );
  return { ...utils, log };
}

const NO_ACCOUNT_CHECKUP = {
  ok: true,
  claude: { found: false, version: null, signedIn: null },
  codex: { found: false, version: null },
  ollama: { found: true, up: false, models: [] },
};

function stubGateway({ providers = [] as unknown[], checkup = NO_ACCOUNT_CHECKUP as Record<string, unknown> } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      let body: unknown = { ok: true };
      if (url.includes('/api/providers')) body = { ok: true, providers };
      else if (url.includes('/api/checkup')) body = checkup;
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('forge.locale', 'en');
  setLocale('en');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  setLocale('en');
});

describe('F1: "Account connected" needs a real account, not just the gateway', () => {
  it('gateway connected but no account anywhere: the step is NOT done', async () => {
    stubGateway();
    renderStart();
    await settle();
    const card = screen.getByRole('region', { name: 'Start here' });
    expect(screen.getByRole('button', { name: /Account connected/ })).toBeInTheDocument();
    expect(card.textContent).toContain('0 of 3');
  });

  it('a connected provider row ticks it', async () => {
    stubGateway({ providers: [{ id: 'claude-code-cli', label: 'Claude Code', kind: 'subscription', status_code: 'connected', state: 'signed-in' }] });
    renderStart();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Account connected/ })).toBeNull());
    expect(screen.getByRole('region', { name: 'Start here' }).textContent).toContain('1 of 3');
  });

  it('the checkup ticks it when Claude is signed in (no provider row needed)', async () => {
    stubGateway({ checkup: { ...NO_ACCOUNT_CHECKUP, claude: { found: true, version: '2.1', signedIn: true } } });
    renderStart();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Account connected/ })).toBeNull());
  });

  it('accountReadyFrom: only real signals count', () => {
    const none = parseProviders({ providers: [] });
    const check = (over: Record<string, unknown>) => parseCheckup({ ...NO_ACCOUNT_CHECKUP, ...over });
    expect(accountReadyFrom(none, null)).toBe(false);
    expect(accountReadyFrom(none, check({}))).toBe(false);
    expect(accountReadyFrom(none, check({ claude: { found: true, signedIn: null } }))).toBe(false);
    expect(accountReadyFrom(none, check({ claude: { found: true, signedIn: true } }))).toBe(true);
    expect(accountReadyFrom(none, check({ codex: { found: true } }))).toBe(true);
    expect(accountReadyFrom(none, check({ ollama: { found: true, up: true, models: [] } }))).toBe(false);
    expect(accountReadyFrom(none, check({ ollama: { found: true, up: true, models: ['llama3.2'] } }))).toBe(true);
    const signedOut = parseProviders({ providers: [{ id: 'claude-code-cli', label: 'Claude', kind: 'subscription', status_code: 'signed-out', state: 'signed-out' }] });
    expect(accountReadyFrom(signedOut, null)).toBe(false);
  });
});

describe('F5: the proof step opens the proof list and only ticks after a proof was shown', () => {
  it('opens /jobs (the same place as Leer Forge lesson 3) and does not tick itself', async () => {
    stubGateway();
    renderStart();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /See a delivery proof/ }));
    expect(screen.getByText('JOBS OPEN')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(START_STORAGE_KEY) ?? '{}').proofSeen).not.toBe(true);
  });

  it('markStartProofSeen (called where a proof is really shown) ticks it', async () => {
    stubGateway();
    markStartProofSeen();
    renderStart();
    await settle();
    expect(screen.queryByRole('button', { name: /See a delivery proof/ })).toBeNull();
    expect(screen.getByText('See a delivery proof')).toBeInTheDocument();
  });
});

describe('F7: no active project on Start', () => {
  // The line's own key arrives with the XR-START locale patch; until the merge it reads as the key itself.
  const NO_PROJECT_KEY = 'rd.start.noProject' as MessageKey;

  it('one short Dutch line above the composer; Send does not send and shows no English error', async () => {
    stubGateway();
    setLocale('nl');
    const send = vi.fn(async () => ({ ok: false, error: 'Select or create a project before sending a message.' }));
    const { log } = renderStart(stubChat(send, 'Select or create a project before sending a message.'));
    await settle();
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent(t(NO_PROJECT_KEY));
    expect(note.textContent).not.toMatch(/Select or create|No project/);
    const composer = document.querySelector('[data-tour="composer"]') as HTMLElement;
    expect(note.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Maak een site' } });
    fireEvent.click(screen.getByRole('button', { name: 'Versturen' }));
    await settle();
    expect(send).not.toHaveBeenCalled();
    const toasts = log.filter((action) => action.type === 'toast/push');
    expect(JSON.stringify(toasts)).not.toContain('Select or create a project');
  });

  it('"Nieuw project" shows once: the line has no button, the composer chip opens the new-project dialog', async () => {
    stubGateway();
    setLocale('nl');
    renderStart(stubChat(vi.fn(async () => ({ ok: false, error: null })), 'Select or create a project before sending a message.'));
    await settle();
    const note = screen.getByRole('status');
    expect(note.querySelector('button')).toBeNull();
    const start = document.querySelector('.fw-start') as HTMLElement;
    expect(start.textContent?.match(/Nieuw project/g) ?? []).toHaveLength(1);
    const chip = screen.getByRole('button', { name: /Nieuw project/ });
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Nieuw project/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('with a project the line is not there', async () => {
    stubGateway();
    setLocale('nl');
    renderStart(stubChat(vi.fn(async () => ({ ok: true, error: null }))));
    await settle();
    expect(screen.queryByText(t(NO_PROJECT_KEY))).toBeNull();
  });
});

describe('L1: the usage line on Start', () => {
  it('is mounted above the Start composer', async () => {
    stubGateway();
    renderStart();
    await settle();
    const line = screen.getByTestId('usage-line');
    const composer = document.querySelector('[data-tour="composer"]') as HTMLElement;
    expect(composer).not.toBeNull();
    expect(line.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
