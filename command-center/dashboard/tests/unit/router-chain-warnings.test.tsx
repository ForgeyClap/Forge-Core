/**
 * Q5-EIGEN-API-UI — a router chain entry whose own API ("Eigen API") was removed or switched off.
 *
 * The gateway now reads such a chain as STORED with a `warnings` array ({path, code: 'provider_unavailable',
 * nl, en, entry_id, provider}) instead of an error, and the turn router skips that step. The dashboard:
 *   - accepts `warnings` (missing = []), and keeps them through a save only for entries that still name the
 *     same provider;
 *   - shows the warning ON the chain row it names in Uitgebreid, and as a plain note in Eenvoudig.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import getStored from '../fixtures/app-router/get-stored.json';
import getDefault from '../fixtures/app-router/get-default.json';
import statusFixture from '../fixtures/app-router/status.json';

import { setLocale } from '@/i18n';
import { parseRouterGet } from '@/prototype/state/adapter/app-router';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setUiMode } from '@/state/ui-mode';
import { AppRouterSection } from '@/views/settings/sections/app-router/AppRouterSection';

const CUSTOM_ENTRY = {
  id: 'mijn-vllm-qwen',
  kind: 'provider-model',
  label: 'Mijn vLLM · qwen',
  provider: 'custom-mijn-vllm',
  model: 'qwen2.5-coder:32b',
  enabled: true,
  num_ctx: null,
  vars: {},
  paid_ack: true,
  notice_ack: false,
};

const WARNING = {
  path: 'entries[4].provider',
  code: 'provider_unavailable',
  nl: 'Gateway-tekst NL',
  en: 'Gateway text EN',
  entry_id: 'mijn-vllm-qwen',
  provider: 'custom-mijn-vllm',
};

function withCustom(warnings: unknown): Record<string, unknown> {
  // Drop the fixture's own `warnings` so `undefined` really means "an older gateway sent no such key".
  const { warnings: _fixtureWarnings, ...base } = getStored as Record<string, unknown> & { warnings?: unknown };
  return {
    ...base,
    config: { ...getStored.config, entries: [...getStored.config.entries, CUSTOM_ENTRY] },
    ...(warnings === undefined ? {} : { warnings }),
  };
}

function stub(getBody: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes('/api/app-router/status')) body = statusFixture;
      else if (url.includes('/api/app-router')) body = getBody;
      else if (url.includes('/api/providers')) body = { ok: true, providers: [] };
      else if (url.includes('/api/models')) body = { ok: true, providers: { pending: false, list: [] } };
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
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

const SKIP_NL = 'Deze eigen API is verwijderd, uitgezet of geweigerd. De router slaat deze stap over en gaat door met de volgende.';

describe('parseRouterGet: the new warnings array', () => {
  it('contract fixtures carry the warnings key the gateway now always sends (gateway test compares key sets)', () => {
    // command-center/gateway/test/app-router-routes-config.test.mjs deep-compares the GET key set against
    // get-default.json; both GET fixtures must say `warnings: []` like a gateway with nothing to warn about.
    expect((getDefault as Record<string, unknown>).warnings).toEqual([]);
    expect((getStored as Record<string, unknown>).warnings).toEqual([]);
    expect(parseRouterGet(getDefault as Record<string, unknown>)?.warnings).toEqual([]);
    expect(parseRouterGet(getStored as Record<string, unknown>)?.warnings).toEqual([]);
  });

  it('a gateway without warnings reads as an empty list', () => {
    expect(parseRouterGet(withCustom(undefined))?.warnings).toEqual([]);
  });

  it('a provider_unavailable warning is kept with its entry id and provider; junk is ignored', () => {
    const parsed = parseRouterGet(withCustom([WARNING, 'junk', { code: 'x' }, null]));
    expect(parsed?.warnings).toEqual([
      { path: 'entries[4].provider', code: 'provider_unavailable', nl: 'Gateway-tekst NL', en: 'Gateway text EN', entryId: 'mijn-vllm-qwen', provider: 'custom-mijn-vllm' },
    ]);
    // A warning does not make the config read-only: the user can still save other settings.
    expect(parsed?.problems).toBe(0);
  });

  it('without entry_id the entry is found from the path', () => {
    const { entry_id: _drop, ...noId } = WARNING;
    expect(parseRouterGet(withCustom([noId]))?.warnings[0]?.entryId).toBe('mijn-vllm-qwen');
  });
});

describe('the chain shows the skipped step on the entry it names', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setUiMode('eenvoudig');
    setLocale('en');
  });

  it('Uitgebreid: the warning sits on that chain row, not on the others, and saving stays possible', async () => {
    setUiMode('uitgebreid');
    stub(withCustom([WARNING]));
    const { container } = renderSection();
    await settle();
    const rowOf = (id: string) => container.querySelector(`.fs-router__link-row[data-target="${id}"]`) as HTMLElement;
    expect(within(rowOf('mijn-vllm-qwen')).getByText(SKIP_NL)).toBeInTheDocument();
    expect(rowOf('mijn-vllm-qwen').getAttribute('data-unavailable')).toBe('true');
    expect(within(rowOf('main')).queryByText(SKIP_NL)).toBeNull();
    // Not the read-only "newer Forge" state.
    expect(screen.queryByText(/komt uit een nieuwere versie van Forge/)).toBeNull();
  });

  it('Eenvoudig: one plain note names the step by its label', async () => {
    stub(withCustom([WARNING]));
    renderSection();
    await settle();
    expect(screen.getByText('Mijn vLLM · qwen: deze eigen API is verwijderd, uitgezet of geweigerd. De router slaat deze stap over.')).toBeInTheDocument();
  });

  it('English copy follows the locale', async () => {
    setLocale('en');
    setUiMode('uitgebreid');
    stub(withCustom([WARNING]));
    renderSection();
    await settle();
    expect(screen.getByText('This own API was removed, switched off or refused. The router skips this step and goes on to the next one.')).toBeInTheDocument();
  });

  it('no warnings: no skip text anywhere', async () => {
    setUiMode('uitgebreid');
    stub(withCustom(undefined));
    renderSection();
    await settle();
    expect(screen.queryByText(SKIP_NL)).toBeNull();
  });
});
