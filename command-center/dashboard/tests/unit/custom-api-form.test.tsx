/**
 * the "Eigen API" section and form in Settings › Accounts (ANY-MODEL-PLAN.md §2.2 E, D1, D6),
 * against fixtures of the C1b routes. Every state the plan names: nieuw, field errors, the http
 * warning (visible, not blocking), opgeslagen without a key, the test, a gateway refusal in its own
 * words, a gateway without the routes, removal. A key never travels over HTTP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { setLocale } from '@/i18n';
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
  created_at: '2026-11-02T19:00:00.000Z',
  updated_at: '2026-11-02T19:00:00.000Z',
};

interface Route {
  readonly status?: number;
  readonly body: unknown;
}

function stub(routes: { list?: Route; create?: Route; patch?: Route; remove?: Route; test?: Route; models?: Route } = {}) {
  const calls: { url: string; method: string; body: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' });
      let route: Route = { body: {} };
      if (url.endsWith('/api/providers/custom') && method === 'GET') route = routes.list ?? { body: { ok: true, revision: 2, providers: [] } };
      else if (url.endsWith('/api/providers/custom') && method === 'POST') route = routes.create ?? { status: 201, body: { ok: true, revision: 3, provider: SAVED } };
      else if (/\/api\/providers\/custom\/[^/]+$/.test(url) && method === 'PATCH') route = routes.patch ?? { body: { ok: true, revision: 4, provider: SAVED } };
      else if (/\/api\/providers\/custom\/[^/]+$/.test(url) && method === 'DELETE') route = routes.remove ?? { body: { ok: true, revision: 5 } };
      else if (/\/test$/.test(url)) route = routes.test ?? { body: { ok: true, result: { ok: true, state: 'connected', latency_ms: 31 } } };
      else if (url.endsWith('/api/models')) route = routes.models ?? { body: { providers: { list: [{ id: 'custom-mijn-vllm', models: [{ id: 'qwen2.5-coder:32b' }], models_source: 'endpoint' }] } } };
      const status = route.status ?? 200;
      return { ok: status < 400, status, json: async () => route.body } as Response;
    }),
  );
  return calls;
}

async function settle(ms = 25) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function renderSection(onChanged = vi.fn()) {
  return render(createElement('div', { className: 'fs-set' }, createElement(CustomApiSection, { providers: [], vaultKeys: [], onChanged })));
}

function fill(label: string, value: string) {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

describe('Eigen API section (WP-C3)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocale('en');
  });

  it('empty list: the honest empty line and one button that opens the empty form', async () => {
    stub();
    renderSection();
    await settle();
    expect(screen.getByText(/Nog geen eigen API/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API toevoegen' }));
    expect(screen.getByRole('heading', { name: 'Nieuwe eigen API' })).toBeInTheDocument();
    expect((screen.getByLabelText('Naam') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Soort API')).toHaveValue('openai-chat');
    // Before saving there is no key field: the key comes after the definition, into the vault only.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByText(/Na Opslaan vul je hier de sleutel in/)).toBeInTheDocument();
  });

  it('a gateway without the routes says so instead of offering a form that cannot save', async () => {
    stub({ list: { status: 404, body: {} } });
    renderSection();
    await settle();
    expect(screen.getByText(/Deze versie van Forge kan nog geen eigen API bewaren/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eigen API toevoegen' })).toBeNull();
  });

  it('a read error offers Opnieuw proberen', async () => {
    const calls = stub({ list: { status: 500, body: { error: 'boom' } } });
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Opnieuw proberen' }));
    await settle();
    expect(calls.filter((call) => call.url.endsWith('/api/providers/custom')).length).toBe(2);
  });

  it('field errors appear after leaving a field; Opslaan with errors sends nothing', async () => {
    const calls = stub();
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API toevoegen' }));
    fill('Adres (base URL)', 'http://llm.example.org/v1');
    expect(screen.getByText('Een adres buiten je eigen netwerk moet met https:// beginnen.')).toBeInTheDocument();
    expect(screen.getByLabelText('Adres (base URL)')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(screen.getByText('Vul dit in.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('D1: http on the own network shows the visible warning and still saves', async () => {
    const calls = stub();
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API toevoegen' }));
    fill('Naam', 'Mijn vLLM');
    fill('Adres (base URL)', 'http://192.168.1.20:8000/v1');
    expect(screen.getByRole('note')).toHaveTextContent('Dit adres is niet versleuteld (http). Gebruik het alleen op je eigen computer of eigen netwerk.');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/api/providers/custom'));
    expect(JSON.parse(post?.body ?? '{}')).toEqual({
      revision: 2,
      provider: {
        label: 'Mijn vLLM',
        format: 'openai-chat',
        baseURL: 'http://192.168.1.20:8000/v1',
        auth: { type: 'bearer' },
        models: { mode: 'endpoint' },
        extraHeaders: {},
        contextLength: null,
        enabled: true,
      },
    });
    expect(screen.getByText('Opgeslagen.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mijn vLLM aanpassen' })).toBeInTheDocument();
  });

  it('after saving: in a browser the key name for the dev tree (D2), Testen, and the models the test found', async () => {
    stub();
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API toevoegen' }));
    fill('Naam', 'Mijn vLLM');
    fill('Adres (base URL)', 'http://192.168.1.20:8000/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(screen.getByText('CUSTOM_MIJN_VLLM_API_KEY')).toBeInTheDocument();
    // No key known yet: Testen is off and says why.
    const test = screen.getByRole('button', { name: 'Testen' });
    expect(test).toBeDisabled();
  });

  it('no key needed: Testen runs the existing test route and lists the models', async () => {
    const calls = stub({ create: { status: 201, body: { ok: true, revision: 3, provider: { ...SAVED, auth: { type: 'none' } } } } });
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API toevoegen' }));
    fill('Naam', 'Mijn vLLM');
    fill('Adres (base URL)', 'http://192.168.1.20:8000/v1');
    fireEvent.click(screen.getByLabelText(/Geen sleutel nodig/));
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(JSON.parse(calls.find((call) => call.method === 'POST')?.body ?? '{}').provider.auth).toEqual({ type: 'none' });
    fireEvent.click(screen.getByRole('button', { name: 'Testen' }));
    await settle();
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/providers/custom-mijn-vllm/test'))).toBe(true);
    expect(screen.getByText('Verbonden (31 ms)')).toBeInTheDocument();
    expect(screen.getByText('Gevonden modellen: qwen2.5-coder:32b')).toBeInTheDocument();
  });

  it('a 400 from the gateway is shown under the field it names, in its own words', async () => {
    stub({ create: { status: 400, body: { ok: false, errors: [{ path: 'baseURL', code: 'blocked_host', nl: 'Dit adres mag niet.', en: 'Not allowed.' }] } } });
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API toevoegen' }));
    fill('Naam', 'Mijn vLLM');
    fill('Adres (base URL)', 'https://llm.example.org/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(screen.getByText('Dit adres mag niet.')).toBeInTheDocument();
    expect(screen.queryByText('Opgeslagen.')).toBeNull();
  });

  it('manual model list (D6) and an own header under Uitgebreid', async () => {
    const calls = stub();
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API toevoegen' }));
    fill('Naam', 'Proxy');
    fill('Adres (base URL)', 'https://proxy.example.org');
    fireEvent.change(screen.getByLabelText('Soort API'), { target: { value: 'anthropic' } });
    fireEvent.click(screen.getByLabelText('Zelf invullen'));
    fill('Eén model per regel', 'claude-like-1\nclaude-like-2');
    fireEvent.change(screen.getByLabelText('Hoe gaat de sleutel mee?'), { target: { value: 'custom' } });
    fill('Naam van de kopregel', 'X-Auth-Token');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    const sent = JSON.parse(calls.find((call) => call.method === 'POST')?.body ?? '{}').provider;
    expect(sent.format).toBe('anthropic');
    expect(sent.models).toEqual({ mode: 'manual', ids: ['claude-like-1', 'claude-like-2'] });
    expect(sent.auth).toEqual({ type: 'custom', header: 'X-Auth-Token', prefix: '' });
  });

  it('existing entry: row with the http tag, Aanpassen PATCHes, Verwijderen asks first then DELETEs', async () => {
    const onChanged = vi.fn();
    const calls = stub({ list: { body: { ok: true, revision: 7, providers: [SAVED] } } });
    renderSection(onChanged);
    await settle();
    const row = screen.getByText('Mijn vLLM').closest('li') as HTMLElement;
    expect(within(row).getByText('Niet versleuteld')).toBeInTheDocument();
    expect(within(row).getByText('192.168.1.20:8000')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Aanpassen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toMatch(/\/api\/providers\/custom\/custom-mijn-vllm$/);
    expect(JSON.parse(patch?.body ?? '{}').revision).toBe(7);
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }));
    expect(screen.getByText('De bewaarde sleutel van deze API wordt ook verwijderd.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ja, verwijderen' }));
    await settle();
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/api/providers/custom/custom-mijn-vllm'))).toBe(true);
    expect(onChanged).toHaveBeenCalled();
  });

  it('a key pasted into the name never leaves the page', async () => {
    const calls = stub();
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API toevoegen' }));
    fill('Naam', 'sk-abcdefghijklmnop123456');
    fill('Adres (base URL)', 'https://llm.example.org/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(screen.getByText('Dit lijkt een sleutel. Een sleutel hoort alleen in het sleutelveld.')).toBeInTheDocument();
    expect(calls.some((call) => call.body.includes('sk-abcdefghijklmnop123456'))).toBe(false);
  });
});
