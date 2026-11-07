/**
 * WP B2 part 2 — onboarding "API-sleutel" path and the Claude sign-in step.
 * Key path: choose the service (from GET /api/providers, or the short fallback list), store the key
 * through window.forge.keys.set only, see last4; in a browser no field and the app message.
 * Claude path: the official command is shown and Forge checks again on its own every 15 s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import OnboardingView from '@/views/onboarding/OnboardingView';
import type { OnboardingViewProps } from '@/views/onboarding/OnboardingView';

const FAKE_KEY = 'sk-ant-' + 'TESTONLY-0123456789abcdefghij-Kq3m';

function checkupAnswer(signedIn: boolean | null) {
  return {
    ok: true,
    checked_at: '2026-11-02T08:00:00.000Z',
    duration_ms: 900,
    timed_out: false,
    claude: { found: true, version: '2.1.316', signedIn },
    codex: { found: false, version: null },
    ollama: { found: false, up: false, models: [] },
    node: { version: '24.18.0' },
    git: { found: true, version: '2.54.0' },
    disk_free_gb: 120,
    port: 4100,
    writable_project_dir: null,
  };
}

function stubGateway(options: { providers?: unknown; signedIn?: () => boolean | null } = {}) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      let body: unknown = {};
      if (url.includes('/api/checkup')) body = checkupAnswer(options.signedIn ? options.signedIn() : false);
      else if (url.includes('/api/providers')) body = options.providers ?? {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  return calls;
}

function renderWizard(props: OnboardingViewProps) {
  return render(createElement(MemoryRouter, null, createElement(OnboardingView, props)));
}

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('onboarding: API-sleutel path (WP B2 part 2)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLocale('en');
  });

  it('browser: the service choice from the fallback list, no key field, the app message, and Verder stays open', async () => {
    stubGateway();
    const { container } = renderWizard({ initialStep: 'verbinden', initialPath: 'sleutel' });
    await settle();
    const select = screen.getByLabelText('Van welke dienst is je sleutel?') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'anthropic',
      'openai',
      'gemini-openai',
      'openrouter',
      'groq',
      'mistral',
      'nvidia-nim',
    ]);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('alleen in de Forge Systeem-app');
    expect(screen.getByText(/later toevoegen via Instellingen › Accounts/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verder' })).toBeEnabled();
  });

  it('uses the gateway list (key accounts only) when there is one', async () => {
    stubGateway({
      providers: {
        ok: true,
        providers: [
          { id: 'claude-code-cli', label: 'Claude Code', kind: 'subscription' },
          { id: 'anthropic', label: 'Anthropic API', kind: 'api-key', key_name: 'ANTHROPIC_API_KEY' },
          { id: 'cerebras', label: 'Cerebras', kind: 'api-key', key_name: 'CEREBRAS_API_KEY' },
          { id: 'ollama-local', label: 'Ollama', kind: 'local' },
        ],
      },
    });
    renderWizard({ initialStep: 'verbinden', initialPath: 'sleutel' });
    await settle();
    const select = screen.getByLabelText('Van welke dienst is je sleutel?') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['anthropic', 'cerebras']);
  });

  it('desktop: stores the chosen service key through window.forge.keys.set only and shows last4', async () => {
    const set = vi.fn(async (providerId: string, secret: string) => ({
      ok: true,
      status: { provider_id: providerId, configured: true, last4: secret.slice(-4), updated_at: '2026-11-02T08:00:00Z' },
      apply: { state: 'applied', detail: null },
    }));
    vi.stubGlobal('forge', {
      gatewayOrigin: () => 'http://127.0.0.1:4100',
      keys: { set, list: vi.fn(async () => ({ ok: true, vault: { state: 'ready' }, keys: [] })) },
    });
    const calls = stubGateway();
    const { container } = renderWizard({ initialStep: 'verbinden', initialPath: 'sleutel' });
    await settle();
    fireEvent.change(screen.getByLabelText('Van welke dienst is je sleutel?'), { target: { value: 'openai' } });
    const input = screen.getByLabelText('API-sleutel voor OpenAI') as HTMLInputElement;
    fireEvent.input(input, { target: { value: FAKE_KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(set).toHaveBeenCalledWith('openai', FAKE_KEY);
    expect(screen.getByText(/Sleutel opgeslagen: •••• Kq3m/)).toBeInTheDocument();
    expect(screen.getByText('Actief')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(FAKE_KEY);
    expect(calls.some((call) => call.url.includes(FAKE_KEY) || call.body.includes(FAKE_KEY))).toBe(false);
  });

  it('the end screen of the key path says exactly what it can do (plan §3.2)', async () => {
    stubGateway();
    renderWizard({ initialStep: 'klaar', initialPath: 'sleutel' });
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Klaar om te beginnen');
    expect(screen.getByText(/Met een andere API-sleutel kun je chatten, maar nog geen bestanden aanpassen/)).toBeInTheDocument();
    const row = document.querySelector('tr[data-path="sleutel"]') as HTMLElement;
    expect(row.className).toBe('is-chosen');
    expect(Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['ja', 'nee', 'nee', 'nee']);
  });
});

describe('onboarding: "Ik heb Claude" sign-in step', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLocale('en');
  });

  it('shows the official command, never runs it, and re-checks on its own until signed in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let signedIn: boolean | null = false;
    const calls = stubGateway({ signedIn: () => signedIn });
    renderWizard({ initialStep: 'verbinden', initialPath: 'claude' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByText('claude auth login')).toBeInTheDocument();
    expect(screen.getByText(/Forge kijkt ook vanzelf elke 15 seconden/)).toBeInTheDocument();
    const checkupCalls = () => calls.filter((call) => call.url.includes('/api/checkup')).length;
    const first = checkupCalls();

    signedIn = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(checkupCalls()).toBeGreaterThan(first);
    expect(screen.getByText('Je bent al ingelogd bij Claude Code. Je kunt verder.')).toBeInTheDocument();

    const afterSignIn = checkupCalls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(checkupCalls()).toBe(afterSignIn);
    expect(calls.some((call) => /auth login|\/login/.test(call.url + call.body))).toBe(false);
  });
});
