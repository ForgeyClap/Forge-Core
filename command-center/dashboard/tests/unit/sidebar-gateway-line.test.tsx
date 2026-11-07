/**
 * Final review finding 1 (MEDIUM): the sidebar foot line shows whether Forge on this pc (the local
 * gateway) is reachable. It used to read "Deze pc · Verbonden", which sat next to an unticked
 * "Account verbonden" on Start and read as an account state. The line now names Forge and uses its own
 * words ("Staat aan", "Niet bereikbaar"), never the account word "Verbonden".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const connection = vi.hoisted(() => ({ status: 'CONNECTED' as string }));

vi.mock('@/config/mode', () => ({ isProductionMode: () => true }));
vi.mock('@/prototype/state/gateway-adapter', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useGatewayConnection: () => ({ status: connection.status, endpoint: 'http://gateway.test', startCommand: null }),
  };
});

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import Sidebar from '@/components/shell/Sidebar';
import { setLocale } from '@/i18n';

function state(): PrototypeState {
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
  };
}

function gatewayLine(): HTMLElement {
  const dispatch = vi.fn<(action: PrototypeAction) => void>();
  const value: StoreValue = { state: state(), dispatch };
  render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(Sidebar))));
  const line = document.querySelector<HTMLElement>('.fw-side__who');
  expect(line).not.toBeNull();
  return line!;
}

beforeEach(() => {
  // No real network: any request (and certainly the owner's live gateway) fails the test.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      if (String(url).includes('4100')) throw new Error('blocked: live gateway');
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
  act(() => setLocale('nl'));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => setLocale('en'));
});

describe('sidebar gateway line (final review finding 1)', () => {
  it('names Forge with its own word, not the account word "Verbonden"', () => {
    connection.status = 'CONNECTED';
    const line = gatewayLine();
    expect(line.querySelector('.fw-side__who-name')!.textContent).toBe('Forge');
    expect(line.querySelector('.fw-side__who-word')!.textContent).toBe('Staat aan');
    expect(line.textContent).not.toMatch(/Verbonden|Deze pc/);
    expect(line.getAttribute('title')).toMatch(/los van je accounts/);
  });

  it('says plainly when Forge on this pc cannot be reached', () => {
    connection.status = 'DISCONNECTED';
    const line = gatewayLine();
    expect(line.querySelector('.fw-side__who-word')!.textContent).toBe('Niet bereikbaar');
    expect(line.querySelector('.fw-side__dot')!.getAttribute('data-tone')).toBe('off');
  });

  it('English uses the same split: Forge, Running', () => {
    connection.status = 'CONNECTED';
    act(() => setLocale('en'));
    const line = gatewayLine();
    expect(line.querySelector('.fw-side__who-name')!.textContent).toBe('Forge');
    expect(line.querySelector('.fw-side__who-word')!.textContent).toBe('Running');
    expect(line.textContent).not.toMatch(/Connected|This pc/);
  });
});
