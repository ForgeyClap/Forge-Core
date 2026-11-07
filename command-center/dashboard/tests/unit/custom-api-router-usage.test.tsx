/**
 * Q5-EIGEN-API-UI — removing or switching off an own API ("Eigen API") that the router chain still names.
 *   - Before: the edit dialog says which router steps use this entry and that they will be skipped.
 *   - After DELETE with router_entries: a notice (the dialog is closed) names those steps.
 *   - After a PATCH that switches it off with router_entries: a notice in the dialog.
 *   - The adapter passes router_entries on (null when the answer has none).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { deleteCustomProvider, updateCustomProvider } from '@/prototype/state/adapter/providers-custom';
import type { CustomDefinition } from '@/prototype/state/adapter/providers-custom';
import { CustomApiSection } from '@/views/settings/sections/custom-api/CustomApiSection';

const SAVED = {
  id: 'custom-mijn-vllm',
  label: 'Mijn vLLM',
  format: 'openai-chat',
  baseURL: 'http://192.168.1.20:8000/v1',
  auth: { type: 'bearer' },
  models: { mode: 'endpoint' },
  extraHeaders: {},
  contextLength: null,
  enabled: true,
};

const ROUTER = {
  ok: true,
  provenance: 'STORED',
  config: {
    version: 1,
    revision: 3,
    mode: 'claude-then-model',
    multi_account: { enabled: false, acknowledged_at: null },
    defaults: { threshold_pct: 92, cooldown_min: 10, strategy: 'in-order', return: 'new-conversation', handover_turns: 12 },
    entries: [
      { id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true },
      { id: 'vllm-qwen', kind: 'provider-model', label: 'Mijn vLLM · qwen', provider: 'custom-mijn-vllm', model: 'qwen', enabled: true },
    ],
    updated_at: null,
  },
  warnings: [],
};

interface Route {
  readonly status?: number;
  readonly body: unknown;
}

function stub(routes: { patch?: Route; remove?: Route; router?: Route } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let route: Route = { body: {} };
      if (url.endsWith('/api/providers/custom') && method === 'GET') route = { body: { ok: true, revision: 2, providers: [SAVED] } };
      else if (/\/api\/providers\/custom\/[^/]+$/.test(url) && method === 'PATCH') route = routes.patch ?? { body: { ok: true, revision: 4, provider: SAVED } };
      else if (/\/api\/providers\/custom\/[^/]+$/.test(url) && method === 'DELETE') route = routes.remove ?? { body: { ok: true, revision: 5 } };
      else if (url.endsWith('/api/app-router')) route = routes.router ?? { body: ROUTER };
      const status = route.status ?? 200;
      return { ok: status < 400, status, json: async () => route.body } as Response;
    }),
  );
}

async function settle(ms = 25) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function renderSection() {
  return render(createElement('div', { className: 'fs-set' }, createElement(CustomApiSection, { providers: [], vaultKeys: [], onChanged: vi.fn() })));
}

const DEF: CustomDefinition = {
  label: 'Mijn vLLM',
  format: 'openai-chat',
  baseURL: 'http://192.168.1.20:8000/v1',
  auth: { type: 'bearer' },
  models: { mode: 'endpoint' },
  extraHeaders: {},
  contextLength: null,
  enabled: false,
};

describe('adapter: router_entries on delete and update', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('DELETE passes router_entries on; an answer without them reads as null', async () => {
    stub({ remove: { body: { ok: true, revision: 5, router_entries: ['vllm-qwen', 7, 'bad id!'] } } });
    expect(await deleteCustomProvider('custom-mijn-vllm')).toEqual({ kind: 'deleted', revision: 5, routerEntries: ['vllm-qwen'] });
    stub();
    expect(await deleteCustomProvider('custom-mijn-vllm')).toEqual({ kind: 'deleted', revision: 5, routerEntries: null });
  });

  it('PATCH passes router_entries on', async () => {
    stub({ patch: { body: { ok: true, revision: 4, provider: { ...SAVED, enabled: false }, router_entries: ['vllm-qwen'] } } });
    const outcome = await updateCustomProvider('custom-mijn-vllm', DEF, 2);
    expect(outcome.kind === 'saved' ? outcome.routerEntries : 'not saved').toEqual(['vllm-qwen']);
  });
});

describe('Eigen API section: the router chain that still names an entry', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocale('en');
  });

  it('warns BEFORE deleting: the edit dialog names the router step that uses this entry', async () => {
    stub();
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Aanpassen' }));
    expect(
      screen.getByText('De router gebruikt deze eigen API in: Mijn vLLM · qwen. Verwijder je hem of zet je hem uit, dan slaat de router die stap over.'),
    ).toBeInTheDocument();
  });

  it('no router step uses it: no such warning', async () => {
    stub({ router: { body: { ...ROUTER, config: { ...ROUTER.config, entries: [ROUTER.config.entries[0]] } } } });
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Aanpassen' }));
    expect(screen.queryByText(/De router gebruikt deze eigen API/)).toBeNull();
  });

  it('after DELETE with router_entries: a notice names the steps the router now skips', async () => {
    stub({ remove: { body: { ok: true, revision: 5, router_entries: ['vllm-qwen'] } } });
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Aanpassen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ja, verwijderen' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByText('Mijn vLLM is verwijderd. De router noemt hem nog in: Mijn vLLM · qwen. De router slaat die stap over; haal hem weg bij “Als je limiet op is”.'),
    ).toBeInTheDocument();
  });

  it('after switching it off with router_entries: a notice in the dialog', async () => {
    stub({ patch: { body: { ok: true, revision: 4, provider: { ...SAVED, enabled: false }, router_entries: ['vllm-qwen'] } } });
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Aanpassen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(
      screen.getByText('Mijn vLLM staat uit. De router noemt hem nog in: Mijn vLLM · qwen. Zolang hij uit staat, slaat de router die stap over.'),
    ).toBeInTheDocument();
  });
});
