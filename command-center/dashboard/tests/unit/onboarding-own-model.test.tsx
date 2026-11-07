/**
 * "Geen Claude?" onboarding (ANY-MODEL-PLAN.md §7, new order item 1): on the first start a
 * person without Claude picks ChatGPT/Codex, an own API key (OpenAI, OpenRouter, Groq, Mistral, or an
 * own API) or free and local (Ollama); the app tests it and turns on the router stand
 * "Meteen eigen model" (APP-ROUTER-DESIGN.md §1 mode model-first), with honest copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import type { RouterConfig } from '@/prototype/state/adapter/app-router';
import OnboardingView from '@/views/onboarding/OnboardingView';
import { headingSkips } from './heading-order';
import { applyModelFirst } from '@/views/onboarding/own-model-model';

const DEFAULT_CONFIG: RouterConfig = {
  version: 1,
  revision: 0,
  mode: 'off',
  multi_account: { enabled: false, acknowledged_at: null },
  defaults: { threshold_pct: 92, cooldown_min: 10, strategy: 'in-order', return: 'new-conversation', handover_turns: 12 },
  entries: [{ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null }],
  updated_at: null,
};

describe('applyModelFirst (pure)', () => {
  it('Ollama: adds the model entry first, with the local defaults, and sets model-first', () => {
    const next = applyModelFirst(DEFAULT_CONFIG, { kind: 'provider', provider: 'ollama-local', providerName: 'Ollama', model: 'llama3.2:latest', paidAck: false, noticeAck: false });
    expect(next.mode).toBe('model-first');
    expect(next.revision).toBe(0);
    expect(next.entries[0]).toEqual({
      id: 'ollama-local-llama3-2-latest',
      kind: 'provider-model',
      label: 'Ollama · llama3.2:latest',
      provider: 'ollama-local',
      model: 'llama3.2:latest',
      enabled: true,
      num_ctx: 8192,
      vars: { port: '11434' },
      paid_ack: false,
      notice_ack: false,
    });
    expect(next.entries[1].id).toBe('main');
  });

  it('a key service carries the paid acknowledgement and no local defaults', () => {
    const next = applyModelFirst(DEFAULT_CONFIG, { kind: 'provider', provider: 'openrouter', providerName: 'OpenRouter', model: 'meta/llama-3.1-8b', paidAck: true, noticeAck: false });
    expect(next.entries[0]).toMatchObject({ provider: 'openrouter', num_ctx: null, vars: {}, paid_ack: true });
  });

  it('re-uses an existing entry of the same service (new model, switched on) instead of adding a second', () => {
    const before: RouterConfig = {
      ...DEFAULT_CONFIG,
      mode: 'claude-then-model',
      entries: [
        ...DEFAULT_CONFIG.entries,
        { id: 'ollama-old', kind: 'provider-model', label: 'Ollama · qwen', provider: 'ollama-local', model: 'qwen', enabled: false, num_ctx: 4096, vars: { port: '11434' }, paid_ack: false, notice_ack: false },
      ],
    };
    const next = applyModelFirst(before, { kind: 'provider', provider: 'ollama-local', providerName: 'Ollama', model: 'llama3.2:latest', paidAck: false, noticeAck: false });
    expect(next.entries.map((entry) => entry.id)).toEqual(['ollama-old', 'main']);
    expect(next.entries[0]).toMatchObject({ model: 'llama3.2:latest', enabled: true, num_ctx: 4096, label: 'Ollama · llama3.2:latest' });
  });

  it('Codex: one codex entry, first and on; an existing one is re-used', () => {
    const next = applyModelFirst(DEFAULT_CONFIG, { kind: 'codex' });
    expect(next.entries[0]).toEqual({ id: 'codex', kind: 'codex-account', label: 'Codex', profile: null, enabled: true });
    const again = applyModelFirst({ ...next, entries: [next.entries[1], { ...next.entries[0], enabled: false }] }, { kind: 'codex' });
    expect(again.entries.filter((entry) => entry.kind === 'codex-account')).toHaveLength(1);
    expect(again.entries[0]).toMatchObject({ kind: 'codex-account', enabled: true });
  });
});

/* ------------------------------------------------------------------ the wizard */

function checkup(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    checked_at: '2026-11-02T08:00:00.000Z',
    duration_ms: 900,
    timed_out: false,
    claude: { found: false, version: null, signedIn: null },
    codex: { found: true, version: '0.156.1' },
    ollama: { found: true, up: true, models: ['llama3.2:latest', 'qwen2.5:7b'] },
    node: { version: '24.18.0' },
    git: { found: true, version: '2.54.0' },
    disk_free_gb: 120,
    port: 4100,
    writable_project_dir: null,
    ...over,
  };
}

interface Stub {
  readonly calls: { url: string; method: string; body: string }[];
}

function stubGateway(options: { test?: unknown; save?: { status: number; body: unknown } } = {}): Stub {
  const calls: Stub['calls'] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' });
      let status = 200;
      let body: unknown = {};
      if (url.includes('/api/checkup')) body = checkup();
      else if (url.endsWith('/api/providers/custom') && method === 'GET') body = { ok: true, revision: 0, providers: [] };
      else if (/\/api\/providers\/[^/]+\/test$/.test(url)) body = options.test ?? { ok: true, result: { ok: true, state: 'connected', latency_ms: 42 } };
      else if (url.endsWith('/api/app-router') && method === 'GET') body = { ok: true, provenance: 'DEFAULT', config: DEFAULT_CONFIG, terms: { checked_at: '2026-11-02', sources: [] } };
      else if (url.endsWith('/api/app-router') && method === 'POST') {
        status = options.save?.status ?? 200;
        body = options.save?.body ?? { ok: true, config: { ...JSON.parse(String(init?.body)), revision: 1 } };
      }
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
  return { calls };
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function renderWizard(path: 'chatgpt' | 'lokaal' | 'sleutel' | 'claude', step: 'pad' | 'verbinden' = 'verbinden') {
  return render(createElement(MemoryRouter, null, createElement(OnboardingView, { initialStep: step, initialPath: path })));
}

describe('onboarding "Geen Claude?" (WP-O1)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocale('en');
  });

  it('the path step tells a person without Claude that it is fine', async () => {
    stubGateway();
    renderWizard('lokaal', 'pad');
    await settle();
    // Redesign 2D: one short line under the four choices (DESIGN.md §3.5).
    expect(screen.getByText('Geen Claude? Je kunt toch beginnen; bestanden laten bouwen vraagt Claude.')).toBeInTheDocument();
  });

  it('Ollama: pick a model, test, and the router is saved in the stand Meteen eigen model', async () => {
    const stub = stubGateway();
    renderWizard('lokaal');
    await settle();
    expect(screen.getByText(/Kleine modellen op je eigen pc antwoorden trager en minder goed dan Claude/)).toBeInTheDocument();
    expect(screen.getByText(/kan in Forge nu alleen antwoorden/)).toBeInTheDocument();
    // fix (axe heading-order): the setup block sits right under the step's h1, so it is an h2.
    expect(screen.getByRole('heading', { name: 'Meteen je eigen model gebruiken', level: 2 })).toBeInTheDocument();
    expect(headingSkips(document.body)).toEqual([]);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'qwen2.5:7b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Testen en meteen gebruiken' }));
    await settle();
    expect(stub.calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/providers/ollama-local/test'))).toBe(true);
    const save = stub.calls.find((call) => call.method === 'POST' && call.url.endsWith('/api/app-router'));
    expect(save).toBeTruthy();
    const sent = JSON.parse(save?.body ?? '{}') as RouterConfig;
    expect(sent.mode).toBe('model-first');
    expect(sent.entries[0]).toMatchObject({ kind: 'provider-model', provider: 'ollama-local', model: 'qwen2.5:7b', enabled: true });
    expect(screen.getByText('Ingesteld. Nieuwe gesprekken lopen nu op Ollama · qwen2.5:7b.')).toBeInTheDocument();
  });

  it('a failed test never changes the router', async () => {
    const stub = stubGateway({ test: { ok: true, result: { ok: false, state: 'unreachable' } } });
    renderWizard('lokaal');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Testen en meteen gebruiken' }));
    await settle();
    expect(screen.getByText(/De test lukte niet/)).toBeInTheDocument();
    expect(stub.calls.some((call) => call.url.endsWith('/api/app-router'))).toBe(false);
  });

  it('ChatGPT/Codex: tests Codex and puts the codex entry first', async () => {
    const stub = stubGateway({ test: { ok: true, result: { ok: true, state: 'installed' } } });
    renderWizard('chatgpt');
    await settle();
    expect(screen.getByText(/Forge ziet alleen dat Codex op deze pc staat/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Testen en meteen gebruiken' }));
    await settle();
    expect(stub.calls.some((call) => call.url.endsWith('/api/providers/codex-cli/test'))).toBe(true);
    const sent = JSON.parse(stub.calls.find((call) => call.method === 'POST' && call.url.endsWith('/api/app-router'))?.body ?? '{}') as RouterConfig;
    expect(sent.mode).toBe('model-first');
    expect(sent.entries[0]).toMatchObject({ kind: 'codex-account', enabled: true });
  });

  it('a refusal from the router is shown in its own words, not as success', async () => {
    stubGateway({ save: { status: 400, body: { ok: false, errors: [{ path: 'entries[0]', code: 'too_many_entries', nl: 'Te veel items in de keten.', en: 'Too many entries.' }] } } });
    renderWizard('lokaal');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Testen en meteen gebruiken' }));
    await settle();
    expect(screen.getByText(/Te veel items in de keten\./)).toBeInTheDocument();
    expect(screen.queryByText(/Ingesteld\./)).toBeNull();
  });

  it('the Claude path shows no own-model setup', async () => {
    stubGateway();
    renderWizard('claude');
    await settle();
    expect(screen.queryByRole('button', { name: 'Testen en meteen gebruiken' })).toBeNull();
  });

  it('API-sleutel path: "Eigen API invullen" opens the own-API form, and back to the list', async () => {
    stubGateway();
    renderWizard('sleutel');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API invullen' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Nieuwe eigen API' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Van welke dienst is je sleutel?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toch een dienst uit de lijst' }));
    expect(screen.getByLabelText('Van welke dienst is je sleutel?')).toBeInTheDocument();
  });
});
