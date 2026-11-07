/**
 * work package POL-B. Each test locks one Review Boss note on the redesign.
 *
 *   F4  Uitgebreid composer: one short scope line (the same `chat.composer.scopeShort` Eenvoudig uses),
 *       the full path only in the chip's tooltip and the screen-reader text, and no always-on
 *       Enter/Shift+Enter hint: that hint shows once, the first time a draft has two lines (DESIGN.md §2).
 *   F5  While the gateway is still connecting, Start does not claim "no data": no "Geen project gekozen."
 *       note, no "0 van 3" progress and no ticks or step actions (quiet placeholder rows instead), and the
 *       composer's project chip shows a placeholder, not "Nieuw project…" (DESIGN.md §4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale, t } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Project } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';
import { Composer } from '@/views/chat/Composer';
import HomeView from '@/views/home/HomeView';

const gateway = vi.hoisted(() => ({ status: 'CONNECTED' as 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' }));

vi.mock('@/prototype/state/gateway-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/prototype/state/gateway-adapter')>();
  return { ...actual, useGatewayConnection: () => ({ status: gateway.status }) };
});

vi.mock('@/components/usage/UsageLine', () => {
  const Marker = () => null;
  return { UsageLine: Marker, default: Marker };
});

const PROJECT: Project = {
  prototype: true,
  id: 'proj-bakkerij',
  name: 'Bakkerij',
  description: 'Fixture row for the scope line.',
  type: 'unknown',
  status: 'waiting',
  lastActivity: '2026-11-04T00:00:00.000Z',
  path: 'C:\\Users\\YOU\\Documents\\Forge\\Bakkerij',
  templateVersion: 'v1',
  pinned: false,
  conversationCount: 0,
  missionCount: 0,
  taskCount: 0,
  agentCount: 0,
  skills: [],
  health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
};

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

function stubChat(disabledReason: string | null): ChatSendController {
  return {
    run: { runId: null, status: null, active: false },
    canSend: disabledReason === null,
    disabledReason,
    sending: false,
    stopping: false,
    send: async () => ({ ok: true, error: null }),
    stop: async () => ({ ok: true, error: null }),
  } as ChatSendController;
}

function withStore(ui: ReturnType<typeof createElement>, state: PrototypeState, chat: ChatSendController | null = null) {
  const value: StoreValue = { state, dispatch: () => undefined };
  const tree = createElement(PrototypeContext.Provider, { value }, ui);
  const wrapped = chat ? createElement(ChatSendContext.Provider, { value: chat }, tree) : tree;
  return render(createElement(MemoryRouter, null, wrapped));
}

/** Text a sighted user sees: everything except the visually-hidden spans. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('.fw-visually-hidden').forEach((node) => node.remove());
  return clone.textContent ?? '';
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('forge.locale', 'en');
  setLocale('en');
  gateway.status = 'CONNECTED';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, providers: [] }) }) as Response),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  setLocale('en');
});

describe('F4: Uitgebreid composer shows the short scope line and the key hint only once', () => {
  function renderAdvanced() {
    setUiMode('uitgebreid');
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT] }, activeProjectId: PROJECT.id });
    return withStore(
      createElement(Composer, {
        onSend: () => true,
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test',
        production: true,
      }),
      state,
    );
  }

  it('the visible line under the field is the short scope line, with no path and no key hints', () => {
    const { container } = renderAdvanced();
    const field = container.querySelector('textarea') as HTMLTextAreaElement;
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const scope = document.getElementById(describedBy as string) as HTMLElement;

    expect(visibleText(scope).trim()).toBe(t('chat.composer.scopeShort', { folder: 'Bakkerij' }));
    expect(visibleText(scope)).not.toContain(PROJECT.path);
    // Screen readers still hear the full path with the field.
    expect(scope.textContent).toContain(PROJECT.path);
    // No always-on Enter / Shift+Enter hint.
    expect(container.querySelectorAll('kbd')).toHaveLength(0);
    expect(container.textContent).not.toContain(t('chat.composer.hintNewLine'));
    expect(container.textContent).not.toContain(t('rd.start.multilineHint'));
  });

  it('the full path is in the project chip tooltip', () => {
    const { container } = renderAdvanced();
    const chip = container.querySelector('.fw-chat-composer__chip') as HTMLElement;
    expect(chip.getAttribute('title')).toContain(PROJECT.path);
  });

  it('the key hint appears once, the first time the draft has two lines', () => {
    const { container } = renderAdvanced();
    const field = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(field, { target: { value: 'eerste regel\ntweede regel' } });
    });
    expect(screen.getByText(t('rd.start.multilineHint'))).toBeInTheDocument();
  });
});

describe('F5: while the gateway connects, Start shows no "no data" claims', () => {
  function renderStart() {
    return withStore(createElement(HomeView), buildState(), stubChat('No active project.'));
  }

  it('connecting: no no-project note, no progress count, placeholder rows and a placeholder chip', () => {
    gateway.status = 'CONNECTING';
    const { container } = renderStart();

    expect(container.textContent).not.toContain(t('rd.start.noProject'));
    const card = screen.getByRole('region', { name: t('rd.start.checklist.title') });
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(card.textContent).not.toContain(t('rd.start.checklist.progress', { done: 0, total: 3 }));
    expect(card.querySelectorAll('[data-step-pending]')).toHaveLength(3);
    expect(card.querySelectorAll('button.fw-start__step')).toHaveLength(0);
    // The empty meta span is the spacer that keeps the close button at the right edge (POL-C screenshot found it jumping left).
    const head = card.querySelector('.fw-start__card-head') as HTMLElement;
    const close = screen.getByRole('button', { name: t('rd.start.checklist.close') });
    expect(close.previousElementSibling?.classList.contains('fw-start__card-meta')).toBe(true);
    expect(head.contains(close)).toBe(true);

    const chip = container.querySelector('.fw-chat-composer__chip') as HTMLElement;
    expect(chip.textContent).not.toContain(t('rd.chat.composer.newProject'));
    expect(chip.getAttribute('title')).toBe(t('shell.connection.connecting'));
  });

  it('connected: the real state shows again (note, 0 of 3, step actions, "New project…")', () => {
    const { container } = renderStart();

    expect(container.textContent).toContain(t('rd.start.noProject'));
    const card = screen.getByRole('region', { name: t('rd.start.checklist.title') });
    expect(card.getAttribute('aria-busy')).toBeNull();
    expect(card.textContent).toContain(t('rd.start.checklist.progress', { done: 0, total: 3 }));
    expect(card.querySelectorAll('[data-step-pending]')).toHaveLength(0);
    expect(card.querySelectorAll('button.fw-start__step').length).toBeGreaterThan(0);
    const chip = container.querySelector('.fw-chat-composer__chip') as HTMLElement;
    expect(chip.textContent).toContain(t('rd.chat.composer.newProject'));
  });
});
