/**
 * Q6-SHOTS low notes 2 and 3 — the shared router refresh signal (router-refresh.ts) never costs the person what
 * they see, and every change that can move the router's skip warnings fires it.
 *
 *   Note 2: a re-read triggered by the refresh signal that FAILS keeps the loaded router (and an unsaved draft);
 *           only a failed first load or an explicit reload shows the error state.
 *   Note 3: a successful router save and a 409 entry_unusable from Testen call signalRouterChanged, so the Eigen
 *           API section's "in use by the router" state is fresh on the same page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import post200 from '../fixtures/app-router/post-200.json';
import test409 from '../fixtures/app-router/test-409-unusable.json';
import statusFixture from '../fixtures/app-router/status.json';

import { setLocale } from '@/i18n';
import { testTarget, useAppRouter } from '@/prototype/state/adapter/app-router';
import { signalRouterChanged, useRouterRefreshSignal } from '@/prototype/state/adapter/router-refresh';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setUiMode } from '@/state/ui-mode';
import { AppRouterSection } from '@/views/settings/sections/app-router/AppRouterSection';

type Rec = Record<string, unknown>;

const CONFIG = (post200 as Rec).config as Rec;
const GET_BODY: Rec = { ok: true, provenance: 'STORED', config: CONFIG, warnings: [], terms: { checked_at: null, sources: [] }, profiles_root_display: null };

interface Stub {
  /** null: GET /api/app-router fails (500). */
  get: Rec | null;
  test: { status: number; body: unknown };
  readonly gets: () => number;
}

function stub(): Stub {
  const calls: { method: string; url: string }[] = [];
  const s: Stub = {
    get: GET_BODY,
    test: { status: 409, body: test409 },
    gets: () => calls.filter((call) => call.method === 'GET' && /\/api\/app-router$/.test(call.url)).length,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input).split('?')[0];
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      let status = 200;
      let body: unknown = {};
      if (url.includes('/api/app-router/status')) body = statusFixture;
      else if (url.includes('/test')) ({ status, body } = s.test);
      else if (url.endsWith('/api/app-router') && method === 'POST') body = post200;
      else if (url.endsWith('/api/app-router')) {
        if (s.get === null) {
          status = 500;
          body = { ok: false, error: 'router file could not be read' };
        } else body = s.get;
      } else if (url.includes('/api/providers')) body = { ok: true, providers: [] };
      else if (url.includes('/api/models')) body = { ok: true, providers: { pending: false, list: [] } };
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
  return s;
}

function state(): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'system',
    resolvedTheme: 'light',
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

function renderSection() {
  const value: StoreValue = { state: state(), dispatch: vi.fn() };
  return render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(AppRouterSection))));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const MODE_NAME = 'Wat doet Forge dan?';

/** Picks another selectable mode in the "Wat doet Forge dan?" select; returns its value. */
function pickOtherMode(): string {
  const mode = screen.getByRole('combobox', { name: MODE_NAME }) as HTMLSelectElement;
  const other = Array.from(mode.options).find((option) => option.value !== mode.value && !option.disabled);
  if (!other) throw new Error('no other mode to pick');
  fireEvent.change(mode, { target: { value: other.value } });
  return other.value;
}

beforeEach(() => setLocale('nl'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

describe('note 2: a failed refresh re-read keeps what is shown', () => {
  it('the hook keeps the loaded router when the signal-triggered read fails', async () => {
    const s = stub();
    const { result } = renderHook(() => useAppRouter());
    await settle();
    expect(result.current.load).toBe('ready');
    const before = s.gets();
    s.get = null;
    act(() => signalRouterChanged());
    await settle();
    expect(s.gets()).toBe(before + 1);
    expect(result.current.load).toBe('ready');
    expect(result.current.data?.config.revision).toBe(8);
    expect(result.current.error).toBeNull();
  });

  it('the section keeps an unsaved draft when the signal-triggered read fails', async () => {
    const s = stub();
    renderSection();
    await settle();
    const picked = pickOtherMode();
    s.get = null;
    act(() => signalRouterChanged());
    await settle();
    expect((screen.getByRole('combobox', { name: MODE_NAME }) as HTMLSelectElement).value).toBe(picked);
  });

  it('a failed first load still shows the error state', async () => {
    const s = stub();
    s.get = null;
    const { result } = renderHook(() => useAppRouter());
    await settle();
    expect(result.current.load).toBe('error');
    expect(result.current.data).toBeNull();
  });

  it('an explicit reload that fails still shows the error state', async () => {
    const s = stub();
    const { result } = renderHook(() => useAppRouter());
    await settle();
    s.get = null;
    act(() => result.current.reload());
    await settle();
    expect(result.current.load).toBe('error');
  });
});

describe('note 3: a save and a 409 entry_unusable fire the refresh signal', () => {
  it('a successful router save moves the signal', async () => {
    stub();
    const signal = renderHook(() => useRouterRefreshSignal());
    renderSection();
    await settle();
    pickOtherMode();
    const before = signal.result.current;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    });
    await settle();
    expect(signal.result.current).toBeGreaterThan(before);
  });

  it('a 409 entry_unusable on Testen moves the signal; a normal answer does not', async () => {
    const s = stub();
    const signal = renderHook(() => useRouterRefreshSignal());
    const before = signal.result.current;
    await act(async () => {
      await testTarget('mijn-vllm-qwen');
    });
    expect(signal.result.current).toBe(before + 1);
    s.test = { status: 200, body: { ok: true, state: 'ok', reading: { windows: [] }, detail: null } };
    await act(async () => {
      await testTarget('mijn-vllm-qwen');
    });
    expect(signal.result.current).toBe(before + 1);
  });
});
