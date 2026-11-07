/**
 * Q7-SETTINGS — the Q6 final Review Boss low notes on the router section, plus the Settings scroll-spy.
 *
 *   1. The status pill follows the status row's ineligible_reason: a step the router skips (paid_ack_required,
 *      provider_unavailable) never reads "Klaar voor gebruik" next to "Testen kan nu niet".
 *   2. The provider list and the model lists of the router section follow the refresh signal (router-refresh.ts),
 *      not only their 20 s poll, so the cost-confirm checkbox appears at once. The status re-reads on it too.
 *   3. A stored test outcome (the 409 note) is cleared when the step's skip state changes.
 *   4. The scroll-spy marks the group that fills the reading line, not a group whose tail is still in view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import post200 from '../fixtures/app-router/post-200.json';
import test409 from '../fixtures/app-router/test-409-unusable.json';

import { setLocale } from '@/i18n';
import { parseRouterGet, useProviderModels } from '@/prototype/state/adapter/app-router';
import type { RouterConfig, RouterEntryStatus } from '@/prototype/state/adapter/app-router';
import { parseProviderRow } from '@/prototype/state/adapter/providers';
import type { ProviderRow } from '@/prototype/state/adapter/providers';
import { signalRouterChanged } from '@/prototype/state/adapter/router-refresh';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setUiMode } from '@/state/ui-mode';
import { pickGroupInView } from '@/views/settings/group-in-view';
import { AppRouterSection } from '@/views/settings/sections/app-router/AppRouterSection';
import { entryPill } from '@/views/settings/sections/app-router/app-router-model';
import { FallbackModelPicker } from '@/views/settings/sections/app-router/FallbackModelPicker';

type Rec = Record<string, unknown>;

const RAW_CONFIG = (post200 as Rec).config as Rec;
const GET_BODY: Rec = { ok: true, provenance: 'STORED', config: RAW_CONFIG, warnings: [], terms: { checked_at: null, sources: [] }, profiles_root_display: null };
const CONFIG = (parseRouterGet(GET_BODY) as { config: RouterConfig }).config;
const STEP = CONFIG.entries[1];
const NOW = Date.parse('2026-11-04T14:00:00.000Z');

function status(reason: string | null): RouterEntryStatus {
  return {
    id: STEP.id,
    label: STEP.label,
    enabled: true,
    eligible: reason === null,
    ineligibleReason: reason,
    state: 'ready',
    maxPct: null,
    windows: [],
    measuredAt: new Date(NOW - 60_000).toISOString(),
    source: 'test',
    resumeAt: null,
    capability: 'read-answer',
  };
}

const PAID_ROW = parseProviderRow({ id: 'custom-mijn-vllm', label: 'Mijn vLLM', kind: 'key', key_source: 'vault', state: 'connected' }) as ProviderRow;
const MODELS = [{ id: 'custom-mijn-vllm', label: 'Mijn vLLM', statusCode: 'ok', models: ['qwen2.5-coder:32b'], source: 'live' }];

interface Calls {
  readonly count: (re: RegExp) => number;
}

function stubFetch(): Calls {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input).split('?')[0];
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      let status = 200;
      let body: unknown = {};
      if (url.includes('/api/app-router/status')) body = { ok: true, mode: 'claude-then-model', entries: [], next: null };
      else if (url.includes('/test')) {
        status = 409;
        body = test409;
      } else if (url.endsWith('/api/app-router')) body = GET_BODY;
      else if (url.includes('/api/providers')) body = { ok: true, providers: [] };
      else if (url.includes('/api/models')) body = { ok: true, providers: { pending: false, list: [] } };
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
  return { count: (re) => calls.filter((call) => re.test(call)).length };
}

function protoState(): PrototypeState {
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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => setLocale('nl'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

describe('1: the pill follows ineligible_reason', () => {
  const base = { entry: STEP, greyed: false, testing: false, test: null, locale: 'nl', now: NOW };

  it('a step skipped for a missing cost confirmation is not "ready"', () => {
    const pill = entryPill({ ...base, status: status('paid_ack_required') });
    expect(pill.tone).not.toBe('ok');
    expect(pill.key).toBe('appRouter.issues.paidAck');
  });

  it('a step whose own API is gone says it is not available (short pill; Q7-FINISH)', () => {
    const pill = entryPill({ ...base, status: status('provider_unavailable') });
    expect(pill.tone).not.toBe('ok');
    expect(pill.key).toBe('appRouter.state.unavailable');
  });

  it('an eligible ready step still reads ready', () => {
    expect(entryPill({ ...base, status: status(null) }).key).toBe('appRouter.state.ready');
  });

  it('the fallback picker shows no green "Klaar" next to "Testen kan nu niet"', () => {
    render(
      createElement(FallbackModelPicker, {
        config: CONFIG,
        onChange: () => undefined,
        providers: [PAID_ROW],
        models: MODELS,
        savedIds: new Set(CONFIG.entries.map((entry) => entry.id)),
        statusById: new Map([[STEP.id, status('paid_ack_required')]]),
        readOnly: false,
        onRecheck: () => undefined,
        issueFor: () => null,
        skipFor: (id: string) => (id === STEP.id ? 'skipped' : null),
      }),
    );
    expect(screen.queryByText('Klaar voor gebruik')).toBeNull();
    expect(screen.getByText('Bevestig dat dit model per gebruik kost.')).toBeInTheDocument();
    expect(screen.getByText('Testen kan nu niet: de router slaat deze stap over.')).toBeInTheDocument();
  });
});

describe('2: the router section follows the refresh signal', () => {
  it('useProviderModels reads /api/models again when the signal moves', async () => {
    const calls = stubFetch();
    renderHook(() => useProviderModels());
    await settle();
    const before = calls.count(/GET .*\/api\/models$/);
    act(() => signalRouterChanged());
    await settle();
    expect(calls.count(/GET .*\/api\/models$/)).toBe(before + 1);
  });

  it('the section reads the providers and the status again when the signal moves', async () => {
    const calls = stubFetch();
    const value: StoreValue = { state: protoState(), dispatch: vi.fn() };
    render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(AppRouterSection))));
    await settle();
    const providers = calls.count(/GET .*\/api\/providers$/);
    const statuses = calls.count(/GET .*\/api\/app-router\/status$/);
    act(() => signalRouterChanged());
    await settle();
    expect(calls.count(/GET .*\/api\/providers$/)).toBeGreaterThan(providers);
    expect(calls.count(/GET .*\/api\/app-router\/status$/)).toBeGreaterThan(statuses);
  });
});

describe('3: the stored test outcome clears when the skip state changes', () => {
  it('a 409 note is gone once the step is usable again', async () => {
    stubFetch();
    const props = (skip: string | null) => ({
      config: CONFIG,
      onChange: () => undefined,
      providers: [PAID_ROW],
      models: MODELS,
      savedIds: new Set(CONFIG.entries.map((entry) => entry.id)),
      statusById: new Map<string, RouterEntryStatus>(),
      readOnly: false,
      onRecheck: () => undefined,
      issueFor: () => null,
      skipFor: (id: string) => (id === STEP.id ? skip : null),
    });
    const view = render(createElement(FallbackModelPicker, props(null)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Testen' }));
    });
    await settle();
    const words = String((test409 as Rec).nl);
    expect(screen.getByText(words)).toBeInTheDocument();
    // The re-read shows the step as skipped, then (the cost confirmed elsewhere) usable again.
    view.rerender(createElement(FallbackModelPicker, props('skipped')));
    expect(screen.queryByText(words)).toBeNull();
    expect(screen.getByText('Testen kan nu niet: de router slaat deze stap over.')).toBeInTheDocument();
    view.rerender(createElement(FallbackModelPicker, props(null)));
    expect(screen.queryByText(words)).toBeNull();
    expect(screen.queryByText('Testen kan nu niet: de router slaat deze stap over.')).toBeNull();
  });
});

describe('4: the scroll-spy picks the group on the reading line', () => {
  const groups = [
    { id: 'algemeen', inBand: true, top: -600, bottom: 150 },
    { id: 'accounts', inBand: true, top: 170, bottom: 1400 },
    { id: 'veiligheid', inBand: false, top: 1450, bottom: 1900 },
  ];

  it('the tail of Algemeen above the line does not win over Accounts filling the view', () => {
    expect(pickGroupInView(groups, { top: 0, height: 800, atEnd: false })).toBe('accounts');
  });

  it('a group that starts below the line is not marked yet', () => {
    const lower = groups.map((group) => ({ ...group, top: group.top + 200, bottom: group.bottom + 200 }));
    expect(pickGroupInView(lower, { top: 0, height: 800, atEnd: false })).toBe('algemeen');
  });

  it('at the end of the page the last group that shows is marked', () => {
    const end = [
      { id: 'veiligheid', inBand: true, top: -200, bottom: 500 },
      { id: 'privacy', inBand: false, top: 540, bottom: 760 },
    ];
    expect(pickGroupInView(end, { top: 0, height: 800, atEnd: true })).toBe('privacy');
  });

  it('without layout (jsdom) it keeps the old rule: the topmost group in the band', () => {
    const flat = [
      { id: 'algemeen', inBand: false, top: 0, bottom: 0 },
      { id: 'accounts', inBand: true, top: 0, bottom: 0 },
      { id: 'veiligheid', inBand: true, top: 0, bottom: 0 },
    ];
    expect(pickGroupInView(flat, { top: 0, height: 0, atEnd: true })).toBe('accounts');
  });
});
