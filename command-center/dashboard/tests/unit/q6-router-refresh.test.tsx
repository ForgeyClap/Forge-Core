/**
 * Q6-UI tasks 1 and 3 — the router's skip warnings never go stale on the Settings page, and "Testen" on a
 * step the router skips says why instead of probing.
 *
 *   C3: POST /api/app-router answers {ok, config, warnings}; the section adopts those warnings. An answer
 *       without the key (an older gateway) means "read GET again".
 *   Shared signal: any successful own-API ("Eigen API") create / update / delete makes the router re-read.
 *   C2: POST /api/app-router/targets/:id/test answers 409 {error:'entry_unusable', reason, nl, en}.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import post200 from '../fixtures/app-router/post-200.json';
import test409 from '../fixtures/app-router/test-409-unusable.json';
import statusFixture from '../fixtures/app-router/status.json';

import { setLocale } from '@/i18n';
import { parseRouterConfig, saveRouterConfig, testTarget, useAppRouter } from '@/prototype/state/adapter/app-router';
import { deleteCustomProvider } from '@/prototype/state/adapter/providers-custom';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setUiMode } from '@/state/ui-mode';
import { AppRouterSection } from '@/views/settings/sections/app-router/AppRouterSection';

type Rec = Record<string, unknown>;

const CONFIG = (post200 as Rec).config as Rec;
const WARNING = ((post200 as Rec).warnings as Rec[])[0];
const GONE_WARNING = { ...WARNING, code: 'provider_unavailable', nl: 'Weg-tekst NL', en: 'Gone text EN' };
const UNAVAILABLE_NL = 'Mijn vLLM · qwen: deze eigen API is verwijderd, uitgezet of geweigerd. De router slaat deze stap over.';
/** appRouter.fallback.listUnknown (nl): "go to Accounts and press Testen" — wrong advice for a skipped step. */
const LIST_UNKNOWN_NL = 'De lijst met modellen is nog niet opgehaald. Klik bij Accounts op Testen voor deze dienst.';

/** The GET answer for the post-200 config, with these warnings (undefined = an older gateway, no key). */
function getBody(warnings: readonly unknown[] | undefined): Rec {
  return { ok: true, provenance: 'STORED', config: CONFIG, terms: { checked_at: null, sources: [] }, profiles_root_display: null, ...(warnings ? { warnings } : {}) };
}

interface Stub {
  get: Rec;
  post: { status: number; body: unknown };
  test: { status: number; body: unknown };
  readonly gets: () => number;
  readonly tests: () => number;
}

function stub(initial: Rec): Stub {
  const calls: { method: string; url: string }[] = [];
  const s: Stub = {
    get: initial,
    post: { status: 200, body: post200 },
    test: { status: 409, body: test409 },
    gets: () => calls.filter((call) => call.method === 'GET' && /\/api\/app-router$/.test(call.url)).length,
    tests: () => calls.filter((call) => call.url.includes('/test')).length,
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
      else if (url.endsWith('/api/app-router') && method === 'POST') ({ status, body } = s.post);
      else if (url.endsWith('/api/app-router')) body = s.get;
      else if (url.includes('/api/providers/custom') && method === 'DELETE') body = { ok: true, revision: 3, router_entries: ['mijn-vllm-qwen'] };
      else if (url.includes('/api/providers')) body = { ok: true, providers: [] };
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

describe('C3 and C2 in the adapter', () => {
  it('a save answer carries the fresh warnings; without the key they read as null (read GET again)', async () => {
    const s = stub(getBody([]));
    const config = parseRouterConfig(CONFIG)?.config;
    if (!config) throw new Error('fixture config did not parse');
    const saved = await saveRouterConfig(config);
    expect(saved.kind === 'saved' ? saved.warnings?.map((w) => [w.entryId, w.code]) : saved.kind).toEqual([['mijn-vllm-qwen', 'paid_ack_required']]);
    const { warnings: _drop, ...older } = post200 as Rec;
    s.post = { status: 200, body: older };
    const old = await saveRouterConfig(config);
    expect(old.kind === 'saved' ? old.warnings : old.kind).toBeNull();
  });

  it('409 entry_unusable on Testen is its own outcome with the gateway words, not a generic failure', async () => {
    stub(getBody([]));
    expect(await testTarget('mijn-vllm-qwen')).toEqual({
      kind: 'unusable',
      reason: 'provider_unavailable',
      nl: test409.nl,
      en: test409.en,
    });
  });
});

describe('task 1: the router warnings follow every change', () => {
  beforeEach(() => setLocale('nl'));

  it('adopt() takes the warnings of the save answer; a save answer without them (null) reads the router again', async () => {
    const s = stub(getBody([]));
    const { result } = renderHook(() => useAppRouter());
    await settle();
    const config = result.current.data?.config;
    if (!config) throw new Error('router did not load');
    const before = s.gets();
    const fresh = [{ path: 'entries[1].paid_ack', code: 'paid_ack_required', nl: 'n', en: 'e', entryId: 'mijn-vllm-qwen', provider: 'custom-mijn-vllm' }];
    act(() => result.current.adopt(config, fresh));
    await settle();
    expect(result.current.data?.warnings).toEqual(fresh);
    expect(s.gets()).toBe(before);

    // Left out (a 409, a new profile): no extra read, so an unsaved draft is never replaced by it.
    act(() => result.current.adopt(config));
    await settle();
    expect(s.gets()).toBe(before);

    s.get = getBody([GONE_WARNING]);
    act(() => result.current.adopt(config, null));
    await settle();
    expect(s.gets()).toBe(before + 1);
    expect(result.current.data?.warnings.map((w) => w.code)).toEqual(['provider_unavailable']);
  });

  it('deleting an Eigen API re-reads the router: the skip note appears without a reload', async () => {
    const s = stub(getBody([]));
    renderSection();
    await settle();
    expect(screen.queryByText(UNAVAILABLE_NL)).toBeNull();
    s.get = getBody([GONE_WARNING]);
    await act(async () => {
      await deleteCustomProvider('custom-mijn-vllm');
    });
    await settle();
    expect(screen.getByText(UNAVAILABLE_NL)).toBeInTheDocument();
  });

  it('a refresh that only brings new warnings keeps an unsaved router draft', async () => {
    const s = stub(getBody([]));
    renderSection();
    await settle();
    const mode = screen.getByRole('combobox', { name: 'Wat doet Forge dan?' }) as HTMLSelectElement;
    const other = Array.from(mode.options).find((option) => option.value !== mode.value && !option.disabled);
    if (!other) throw new Error('no other mode to pick');
    fireEvent.change(mode, { target: { value: other.value } });
    s.get = getBody([GONE_WARNING]);
    await act(async () => {
      await deleteCustomProvider('custom-mijn-vllm');
    });
    await settle();
    expect((screen.getByRole('combobox', { name: 'Wat doet Forge dan?' }) as HTMLSelectElement).value).toBe(other.value);
  });
});

describe('task 3: Testen on a skipped step', () => {
  beforeEach(() => setLocale('nl'));

  /** The own-model row keeps the model picker behind its "Meer info" (DESIGN.md §6). */
  function pickerTest(container: HTMLElement): HTMLButtonElement {
    const own = container.querySelector('[data-row="router-own"]') as HTMLElement;
    fireEvent.click(within(own).getByRole('button', { name: 'Meer info' }));
    const button = container.querySelector('.fs-router__pick-ctl button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no Testen in the model picker');
    return button;
  }

  it('a step with a warning: Testen is off and says why; nothing is probed', async () => {
    const s = stub(getBody([WARNING]));
    const { container } = renderSection();
    await settle();
    const button = pickerTest(container);
    expect(button).toBeDisabled();
    expect(button.title).not.toBe('Sla eerst op; daarna kun je dit testen.');
    expect(screen.getByText('Testen kan nu niet: de router slaat deze stap over.')).toBeInTheDocument();
    expect(s.tests()).toBe(0);
  });

  it('a skipped step does not also tell the user to go and press Testen under Accounts', async () => {
    stub(getBody([WARNING]));
    const { container } = renderSection();
    await settle();
    pickerTest(container);
    expect(screen.getByText('Testen kan nu niet: de router slaat deze stap over.')).toBeInTheDocument();
    expect(screen.queryByText(LIST_UNKNOWN_NL)).toBeNull();
  });

  it('a 409 entry_unusable answer shows the gateway words on that step', async () => {
    stub(getBody([]));
    const { container } = renderSection();
    await settle();
    const button = pickerTest(container);
    expect(button).toBeEnabled();
    await act(async () => {
      fireEvent.click(button);
    });
    await settle();
    expect(screen.getByText(test409.nl)).toBeInTheDocument();
    // The unknown-list advice (go and test it under Accounts) cannot help a removed or switched-off API.
    expect(screen.queryByText(LIST_UNKNOWN_NL)).toBeNull();
  });
});
