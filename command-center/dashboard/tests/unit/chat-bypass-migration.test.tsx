/**
 * WP B3-ui fix round: a stored "Volledige toegang" (bypass) from before WP B3 is reset once, and the
 * chat says so with exactly ONE toast — also under React StrictMode (which the app's main.tsx uses
 * and which mounts every effect twice in development).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import nl from '@/i18n/locales/nl.json';
import { setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import ChatView from '@/views/chat/ChatView';
import { BYPASS_MIGRATION_KEY, modeStorageKey, readStoredMode } from '@/views/chat/mode-storage';

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
    activeProjectId: 'p1',
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

function bypassToasts(dispatch: ReturnType<typeof vi.fn>): number {
  return dispatch.mock.calls.filter(([action]) => {
    const a = action as { type?: string; toast?: { title?: string } };
    return a.type === 'toast/push' && a.toast?.title === nl.chat.view.bypassResetTitle;
  }).length;
}

function renderChat(dispatch: ReturnType<typeof vi.fn>) {
  const value: StoreValue = { state: buildState(), dispatch };
  return render(
    createElement(
      StrictMode,
      null,
      createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(ChatView))),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  setLocale('nl');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  setLocale('en');
});

describe('ChatView: one-time bypass reset', () => {
  it('a pre-seeded stored bypass is reset and the "Volledige toegang is uitgezet" toast is dispatched exactly once', () => {
    localStorage.setItem(modeStorageKey('p1'), 'bypass');
    const dispatch = vi.fn();
    renderChat(dispatch);
    expect(bypassToasts(dispatch)).toBe(1);
    expect(localStorage.getItem(modeStorageKey('p1'))).toBeNull();
    expect(localStorage.getItem(BYPASS_MIGRATION_KEY)).toBe('1');
    expect(readStoredMode('p1')).toBe('accept-edits');
  });

  it('no stored bypass: no toast', () => {
    const dispatch = vi.fn();
    renderChat(dispatch);
    expect(bypassToasts(dispatch)).toBe(0);
  });

  it('a second mount after the migration shows no toast again', () => {
    localStorage.setItem(modeStorageKey('p1'), 'bypass');
    const first = vi.fn();
    renderChat(first);
    cleanup();
    const second = vi.fn();
    renderChat(second);
    expect(bypassToasts(first)).toBe(1);
    expect(bypassToasts(second)).toBe(0);
  });
});
