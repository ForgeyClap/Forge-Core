/**
 * WP B2 part 2 — Settings › Accounts provider cards, rendered for real against a stubbed gateway
 * (contract-providers.md v1 shapes) and a stubbed desktop vault (contract-keys.md v1):
 * one card per status word, who pays, Testen with the redacted result, the sign-in panel that only
 * shows the official command, the browser-build message, and the key flow through the vault —
 * where the key is never in the DOM, never in a request and never in a log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import type { CheckupController } from '@/components/checkup/use-checkup';
import { AccountsSection } from '@/views/settings/sections/AccountsSection';

const FAKE_KEY = 'sk-proj-TESTONLY-abcdefghijklmnopqrstuvwxyz-9Wx9z';

function row(id: string, label: string, extra: Record<string, unknown>) {
  return { id, label, kind: 'api-key', key_name: null, key_source: null, tos: { required: false, checked_on: '2026-11-01' }, ...extra };
}

const ROWS = [
  row('claude-code-cli', 'Claude Code (your own sign-in)', { kind: 'subscription', status_code: 'connected', state: 'signed-in', tos: { required: true, checked_on: '2026-11-01' } }),
  row('codex-cli', 'Codex (your own sign-in)', { kind: 'subscription', status_code: 'not-connected', state: 'not-connected', tos: { required: true, checked_on: '2026-11-01' } }),
  row('ollama-local', 'Ollama (this PC)', { kind: 'local', local: true, status_code: 'connected', state: 'reachable' }),
  row('openai', 'OpenAI', { key_name: 'OPENAI_API_KEY', key_source: 'env', status_code: 'connected', state: 'connected' }),
  row('anthropic', 'Anthropic API', { key_name: 'ANTHROPIC_API_KEY', key_source: 'vault', status_code: 'not-connected', state: 'configured' }),
  row('groq', 'Groq', { key_name: 'GROQ_API_KEY', status_code: 'no-key', state: 'not-configured' }),
  row('mistral', 'Mistral', { key_name: 'MISTRAL_API_KEY', key_source: 'env', status_code: 'error', state: 'auth-failed' }),
  row('deepseek', 'DeepSeek', { key_name: 'DEEPSEEK_API_KEY', key_source: 'env', status_code: 'error', state: 'rate-limited' }),
  row('lmstudio', 'LM Studio', { kind: 'local', local: true, status_code: 'not-connected', state: 'unreachable' }),
  row('gemini-cli', 'Gemini CLI (not recommended)', { kind: 'cli-detect-only', status_code: 'not-installed', state: 'not-installed', tos: { required: true, checked_on: '2026-11-01' } }),
  row('together', 'Together AI', { key_name: 'TOGETHER_API_KEY', key_source: 'env', status_code: 'error', state: 'error', mock: true }),
  { id: 'BROKEN ROW' },
];

interface StubOptions {
  readonly providers?: unknown;
  readonly providersStatus?: number;
  readonly testAnswer?: unknown;
}

function stubGateway({ providers = { ok: true, providers: ROWS }, providersStatus = 200, testAnswer }: StubOptions = {}) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      let body: unknown = {};
      let status = 200;
      if (url.endsWith('/test')) body = testAnswer ?? { ok: true, result: { ok: true, status_code: 'connected', state: 'connected', latency_ms: 142 }, live: true };
      else if (url.includes('/api/providers')) {
        body = providers;
        status = providersStatus;
      } else if (url.includes('/api/models')) body = { ok: true, roles: {} };
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
  return calls;
}

function checkupStub(): CheckupController {
  return { status: 'done', result: null, run: vi.fn() } as unknown as CheckupController;
}

function renderSection(checkup = checkupStub()) {
  return render(createElement(MemoryRouter, null, createElement('div', { className: 'fs-set' }, createElement(AccountsSection, { checkup }))));
}

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const card = (container: HTMLElement, id: string) => {
  const found = container.querySelector<HTMLElement>(`[data-provider="${id}"]`);
  if (!found) throw new Error(`no card for ${id}`);
  return found;
};

/** v1.0 redesign: Testen, Inloggen/Uitloggen and "Over dit account" sit in the row's `...` menu. */
function menuItem(row: HTMLElement, name: string): HTMLElement {
  fireEvent.click(within(row).getByRole('button', { name: /^Acties voor / }));
  return within(row).getByRole('menuitem', { name });
}

describe('Settings › Accounts provider cards (WP B2 part 2)', () => {
  beforeEach(() => {
    setLocale('nl');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLocale('en');
  });

  it.each([
    ['claude-code-cli', 'Verbonden'],
    ['codex-cli', 'Uitgelogd'],
    ['ollama-local', 'Verbonden'],
    ['openai', 'Verbonden'],
    ['anthropic', 'Niet verbonden'],
    ['groq', 'Geen sleutel'],
    ['mistral', 'Geweigerd'],
    ['deepseek', 'Limiet bereikt'],
    ['lmstudio', 'Onbereikbaar'],
    ['gemini-cli', 'Niet gevonden'],
    ['together', 'Fout'],
  ])('%s shows the one status word "%s"', async (id, word) => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    expect(within(card(container, id)).getByText(word, { selector: '.fs-pill' })).toBeInTheDocument();
  });

  it('drops the malformed row and says so; Dutch names replace English registry labels', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    expect(container.querySelectorAll('[data-provider]')).toHaveLength(11);
    expect(screen.getByText(/Van 1 accounts kwam onleesbare informatie/)).toBeInTheDocument();
    expect(within(card(container, 'claude-code-cli')).getByText('Claude')).toBeInTheDocument();
    // The row name is "Ollama"; its sub-line says "Gratis op deze pc" (mockup 04).
    expect(within(card(container, 'ollama-local')).getByText('Ollama')).toBeInTheDocument();
    expect(within(card(container, 'ollama-local')).getByText('Gratis op deze pc')).toBeInTheDocument();
    expect(within(card(container, 'gemini-cli')).getByText('Gemini (eigen programma)')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/your own sign-in|not recommended|this PC/);
  });

  it('who pays, per kind: two words on the row, the full sentence under "Over dit account"', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    expect(within(card(container, 'claude-code-cli')).getByText('Jouw abonnement')).toBeInTheDocument();
    expect(within(card(container, 'codex-cli')).getByText('Via Codex')).toBeInTheDocument();
    expect(within(card(container, 'openai')).getByText('API-sleutel')).toBeInTheDocument();
    const about = card(container, 'claude-code-cli').querySelector('.fs-acct__about') as HTMLElement;
    expect(about).not.toBeVisible();
    fireEvent.click(menuItem(card(container, 'claude-code-cli'), 'Over dit account'));
    expect(about).toBeVisible();
    expect(within(card(container, 'claude-code-cli')).getByText('Wie betaalt: jouw Claude-abonnement')).toBeInTheDocument();
    expect(within(card(container, 'codex-cli')).getByText('Wie betaalt: jouw ChatGPT-abonnement, via Codex')).toBeInTheDocument();
    expect(within(card(container, 'ollama-local')).getByText('Wie betaalt: niemand, gratis en lokaal')).toBeInTheDocument();
    expect(within(card(container, 'openai')).getByText('Wie betaalt: jouw API-sleutel, per gebruik')).toBeInTheDocument();
  });

  it('sign-in accounts, Ollama and accounts with a key come first; the rest sit under "Meer accounts"', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    const more = container.querySelector('details.fs-prov__more') as HTMLElement;
    expect(more.querySelector('summary')?.textContent).toBe('Meer accounts (3)');
    expect(more.querySelector('[data-provider="gemini-cli"]')).not.toBeNull();
    expect(more.querySelector('[data-provider="groq"]')).not.toBeNull();
    expect(more.querySelector('[data-provider="lmstudio"]')).not.toBeNull();
    expect(more.querySelector('[data-provider="openai"]')).toBeNull();
    expect(more.querySelector('[data-provider="claude-code-cli"]')).toBeNull();
  });

  it('the terms notice with its date on the sign-in accounts only', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    expect(within(card(container, 'claude-code-cli')).getByText(/Je logt in bij Claude Code zelf.*1 november 2026/)).toBeInTheDocument();
    expect(within(card(container, 'codex-cli')).getByText(/Je logt in bij Codex zelf.*1 november 2026/)).toBeInTheDocument();
    expect(card(container, 'openai').querySelector('.fs-acct__tos')).toBeNull();
  });

  it('a mocked row carries the NOT-live label', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    expect(within(card(container, 'together')).getByText('Proefweergave, niet echt verbonden')).toBeInTheDocument();
    expect(within(card(container, 'openai')).queryByText('Proefweergave, niet echt verbonden')).toBeNull();
  });

  it('Testen posts to the route and shows the result in Dutch; technical detail stays folded and scrubbed', async () => {
    const calls = stubGateway({
      testAnswer: { ok: true, result: { ok: false, status_code: 'error', state: 'auth-failed', latency_ms: 300, detail: `HTTP 401 for Bearer ${FAKE_KEY}` }, live: true },
    });
    const { container } = renderSection();
    await settle();
    fireEvent.click(menuItem(card(container, 'mistral'), 'Testen'));
    await settle();
    expect(calls.some((call) => call.url.endsWith('/api/providers/mistral/test'))).toBe(true);
    expect(within(card(container, 'mistral')).getByRole('status')).toHaveTextContent('Test niet gelukt: Geweigerd.');
    expect(container.innerHTML).not.toContain(FAKE_KEY);
    expect(within(card(container, 'mistral')).getByText('Technische details')).toBeInTheDocument();
  });

  it('Testen success shows the time', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    fireEvent.click(menuItem(card(container, 'openai'), 'Testen'));
    await settle();
    expect(within(card(container, 'openai')).getByRole('status')).toHaveTextContent('Test gelukt in 142 ms.');
  });

  it('after a successful Testen the status word follows the test (refreshed row), never contradicting it', async () => {
    const calls = stubGateway({
      testAnswer: {
        ok: true,
        provider: 'anthropic',
        result: { ok: true, status_code: 'connected', state: 'connected', latency_ms: 88 },
        row: { id: 'anthropic', label: 'Anthropic API', kind: 'api-key', key_name: 'ANTHROPIC_API_KEY', key_source: 'vault', status_code: 'connected', state: 'connected' },
        live: true,
      },
    });
    const { container } = renderSection();
    await settle();
    expect(within(card(container, 'anthropic')).getByText('Niet verbonden', { selector: '.fs-pill' })).toBeInTheDocument();
    const listReadsBefore = calls.filter((call) => call.url.endsWith('/api/providers')).length;
    fireEvent.click(menuItem(card(container, 'anthropic'), 'Testen'));
    await settle();
    expect(within(card(container, 'anthropic')).getByRole('status')).toHaveTextContent('Test gelukt in 88 ms.');
    expect(within(card(container, 'anthropic')).getByText('Verbonden', { selector: '.fs-pill' })).toBeInTheDocument();
    expect(within(card(container, 'anthropic')).queryByText('Niet verbonden', { selector: '.fs-pill' })).toBeNull();
    // The list is read again too, so the other cards and the next poll agree with the test.
    expect(calls.filter((call) => call.url.endsWith('/api/providers')).length).toBeGreaterThan(listReadsBefore);
  });

  it('Testen is grey with the reason for a key account without a key, and does nothing', async () => {
    const calls = stubGateway();
    const { container } = renderSection();
    await settle();
    const item = menuItem(card(container, 'groq'), 'Testen');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(document.getElementById(item.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Voeg eerst een sleutel toe; daarna kun je testen.',
    );
    fireEvent.click(item);
    await settle();
    expect(calls.some((call) => call.url.endsWith('/api/providers/groq/test'))).toBe(false);
  });

  it('Inloggen only SHOWS the official command, with the plain explanation and a copy button; nothing is run', async () => {
    const calls = stubGateway();
    const { container } = renderSection();
    await settle();
    const codex = card(container, 'codex-cli');
    const login = menuItem(codex, 'Inloggen');
    expect(login).toHaveAttribute('aria-expanded', 'false');
    const before = calls.length;
    fireEvent.click(login);
    expect(menuItem(codex, 'Inloggen')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(within(codex).getByRole('menu'), { key: 'Escape' });
    expect(within(codex).getByText('codex login')).toBeInTheDocument();
    expect(within(codex).getByText(/zwart venster van Codex zelf/)).toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Opdracht kopiëren' })).toBeInTheDocument();
    expect(calls.length).toBe(before);
  });

  it('Uitloggen on a signed-in account shows the official sign-out command; Opnieuw controleren re-reads', async () => {
    const calls = stubGateway();
    const checkup = checkupStub();
    const { container } = renderSection(checkup);
    await settle();
    const claude = card(container, 'claude-code-cli');
    fireEvent.click(menuItem(claude, 'Uitloggen'));
    expect(within(claude).getByText('claude auth logout')).toBeInTheDocument();
    const before = calls.filter((call) => call.url.includes('/api/providers')).length;
    fireEvent.click(within(claude).getByRole('button', { name: 'Opnieuw controleren' }));
    await settle();
    expect(calls.filter((call) => call.url.includes('/api/providers')).length).toBeGreaterThan(before);
    expect(checkup.run).toHaveBeenCalled();
  });

  it('browser build: no key field anywhere, each key account says the app is needed', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(within(card(container, 'groq')).getByRole('note')).toHaveTextContent('alleen in de Forge Systeem-app');
    expect(within(card(container, 'openai')).getByText('Forge gebruikt de sleutel die al op deze pc is ingesteld.')).toBeInTheDocument();
  });

  it('falls back to the checkup rows when the gateway has no provider list, with no menu that cannot work', async () => {
    stubGateway({ providers: {} });
    const { container } = renderSection();
    await settle();
    expect(container.querySelector('[data-provider="claude"]')).not.toBeNull();
    expect(screen.getByText('Inloggen en testen doe je nog in het programma zelf.')).toBeInTheDocument();
    expect(screen.queryByText(/volgende versie/)).toBeNull();
    expect(within(card(container, 'claude')).queryByRole('button', { name: /^Acties voor / })).toBeNull();
  });

  it('the row menu: Escape closes it and gives focus back to its button; a click outside closes it', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    const claude = card(container, 'claude-code-cli');
    const trigger = within(claude).getByRole('button', { name: 'Acties voor Claude' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = within(claude).getByRole('menu', { name: 'Acties voor Claude' });
    expect(within(menu).getAllByRole('menuitem').map((node) => node.textContent)).toEqual(['Testen', 'Uitloggen', 'Over dit account']);
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Testen' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Uitloggen' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(within(claude).queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(within(claude).queryByRole('menu')).toBeNull();
  });

  it('says so when the provider list cannot be fetched, and still shows the checkup cards', async () => {
    stubGateway({ providers: { ok: false, error: 'provider registry invalid' }, providersStatus: 503 });
    const { container } = renderSection();
    await settle();
    expect(screen.getByText(/Forge kon de accounts nu niet ophalen/)).toBeInTheDocument();
    expect(container.querySelector('[data-provider="claude"]')).not.toBeNull();
  });

  it('an empty list is said plainly', async () => {
    stubGateway({ providers: { ok: true, providers: [] } });
    renderSection();
    await settle();
    expect(screen.getByText(/Forge vond nog geen accounts/)).toBeInTheDocument();
  });
});

describe('Settings › Accounts key field in the desktop app (contract-keys.md)', () => {
  let setSpy: ReturnType<typeof vi.fn>;
  let deleteSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLocale('nl');
    setSpy = vi.fn(async (providerId: string, secret: string) => ({
      ok: true,
      status: { provider_id: providerId, key_env_name: 'GROQ_API_KEY', configured: true, last4: secret.slice(-4), updated_at: '2026-11-02T08:00:00Z' },
      apply: { state: 'waiting-for-idle', detail: null },
    }));
    deleteSpy = vi.fn(async (providerId: string) => ({
      ok: true,
      status: { provider_id: providerId, configured: false, last4: null, updated_at: null },
      apply: { state: 'restarting', detail: null },
    }));
    vi.stubGlobal('forge', {
      gatewayOrigin: () => 'http://127.0.0.1:4100',
      keys: {
        set: setSpy,
        delete: deleteSpy,
        status: vi.fn(),
        list: vi.fn(async () => ({
          ok: true,
          vault: { state: 'ready', reason: null, persistent: true },
          keys: [{ provider_id: 'anthropic', key_env_name: 'ANTHROPIC_API_KEY', configured: true, last4: 'Q7rT', updated_at: '2026-11-01T10:00:00Z' }],
          apply: { state: 'applied', detail: null },
        })),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLocale('en');
  });

  it('stores the key only through window.forge.keys.set, clears the field, shows only last4, never logs or sends it', async () => {
    const calls = stubGateway();
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'debug')];
    const { container } = renderSection();
    await settle();
    const groq = card(container, 'groq');
    fireEvent.click(within(groq).getByRole('button', { name: 'Sleutel toevoegen' }));
    const input = within(groq).getByLabelText('API-sleutel voor Groq') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    const save = within(groq).getByRole('button', { name: 'Opslaan' });
    expect(save).toBeDisabled();

    fireEvent.input(input, { target: { value: FAKE_KEY } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await settle();

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith('groq', FAKE_KEY);
    expect(within(groq).getByText(/Sleutel opgeslagen: •••• Wx9z/)).toBeInTheDocument();
    expect(within(groq).getByText('Wordt actief zodra de lopende klus klaar is')).toBeInTheDocument();
    // The key is nowhere: not in the DOM (including input values), not in any request, not in a log.
    expect(container.innerHTML).not.toContain(FAKE_KEY);
    for (const field of Array.from(container.querySelectorAll('input'))) expect(field.value).not.toContain(FAKE_KEY);
    expect(calls.some((call) => call.url.includes(FAKE_KEY) || call.body.includes(FAKE_KEY))).toBe(false);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(FAKE_KEY);
    for (let index = 0; index < globalThis.localStorage.length; index += 1) {
      const name = globalThis.localStorage.key(index) ?? '';
      expect(globalThis.localStorage.getItem(name) ?? '').not.toContain(FAKE_KEY);
    }
  });

  it('in Settings an empty key account shows "Sleutel toevoegen", not an open field', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = card(container, 'groq');
    expect(within(groq).queryByLabelText('API-sleutel voor Groq')).toBeNull();
    fireEvent.click(within(groq).getByRole('button', { name: 'Sleutel toevoegen' }));
    expect(within(groq).getByLabelText('API-sleutel voor Groq')).toBeInTheDocument();
    fireEvent.click(within(groq).getByRole('button', { name: 'Annuleren' }));
    expect(within(groq).getByRole('button', { name: 'Sleutel toevoegen' })).toBeInTheDocument();
  });

  it('a key that is too short is refused before the vault, and the field is cleared', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = card(container, 'groq');
    fireEvent.click(within(groq).getByRole('button', { name: 'Sleutel toevoegen' }));
    const input = within(groq).getByLabelText('API-sleutel voor Groq') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'abc' } });
    fireEvent.click(within(groq).getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(setSpy).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(within(groq).getByText(/Dit lijkt geen geldige sleutel/)).toBeInTheDocument();
  });

  it('a vault refusal shows its Dutch message and keeps nothing', async () => {
    setSpy.mockResolvedValueOnce({ ok: false, code: 'VAULT_UNAVAILABLE', message: 'Versleuteld opslaan werkt niet op deze pc.' });
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = card(container, 'groq');
    fireEvent.click(within(groq).getByRole('button', { name: 'Sleutel toevoegen' }));
    const input = within(groq).getByLabelText('API-sleutel voor Groq') as HTMLInputElement;
    fireEvent.input(input, { target: { value: FAKE_KEY } });
    fireEvent.click(within(groq).getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(input.value).toBe('');
    expect(within(groq).getByText('Versleuteld opslaan werkt niet op deze pc.')).toBeInTheDocument();
  });

  it('a stored key from the vault list shows •••• last4 with Vervangen and a two-step Verwijderen', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    const anthropic = card(container, 'anthropic');
    expect(within(anthropic).getByText(/Sleutel opgeslagen: •••• Q7rT/)).toBeInTheDocument();
    expect(within(anthropic).queryByLabelText('API-sleutel voor Anthropic API')).toBeNull();
    fireEvent.click(within(anthropic).getByRole('button', { name: 'Verwijderen' }));
    expect(deleteSpy).not.toHaveBeenCalled();
    fireEvent.click(within(anthropic).getByRole('button', { name: 'Ja, verwijderen' }));
    await settle();
    expect(deleteSpy).toHaveBeenCalledWith('anthropic');
    expect(within(anthropic).getByText('Sleutel verwijderd.')).toBeInTheDocument();
    expect(within(anthropic).getByRole('button', { name: 'Sleutel toevoegen' })).toBeInTheDocument();
  });

  it('a key the gateway finds in the pc settings is used as is; an own key is offered behind a button', async () => {
    stubGateway();
    const { container } = renderSection();
    await settle();
    const openai = card(container, 'openai');
    expect(within(openai).getByText('Forge gebruikt de sleutel die al op deze pc is ingesteld.')).toBeInTheDocument();
    expect(within(openai).queryByLabelText('API-sleutel voor OpenAI')).toBeNull();
    fireEvent.click(within(openai).getByRole('button', { name: 'Eigen sleutel opslaan' }));
    expect(within(openai).getByLabelText('API-sleutel voor OpenAI')).toBeInTheDocument();
    fireEvent.click(within(openai).getByRole('button', { name: 'Annuleren' }));
    expect(within(openai).queryByLabelText('API-sleutel voor OpenAI')).toBeNull();
  });

  it('shows the honest limit of the encryption once', async () => {
    stubGateway();
    renderSection();
    await settle();
    expect(screen.getAllByText(/Programma's die onder jouw eigen Windows-account draaien/)).toHaveLength(1);
  });
});

describe('Settings › Accounts apply state after saving (KEY-VAULT-CONTRACT.md v1.2 §5)', () => {
  const WAIT_UNKNOWN = 'Sleutel wordt toegepast zodra de huidige klus klaar is';
  const TURN_RUNNING = 'Er loopt nu een klus. De sleutel wordt actief zodra die klaar is.';

  function stubVault(apply: unknown, reconnectNow?: ReturnType<typeof vi.fn>) {
    const set = vi.fn(async (providerId: string, secret: string) => ({
      ok: true,
      status: { provider_id: providerId, configured: true, last4: secret.slice(-4), updated_at: '2026-11-02T08:00:00Z' },
      ...(apply === undefined ? {} : { apply }),
    }));
    vi.stubGlobal('forge', {
      gatewayOrigin: () => 'http://127.0.0.1:4100',
      keys: {
        set,
        delete: vi.fn(),
        list: vi.fn(async () => ({ ok: true, vault: { state: 'ready', reason: null, persistent: true }, keys: [] })),
        ...(reconnectNow ? { reconnectNow } : {}),
      },
    });
    return set;
  }

  async function saveGroqKey(container: HTMLElement) {
    const groq = card(container, 'groq');
    fireEvent.click(within(groq).getByRole('button', { name: 'Sleutel toevoegen' }));
    fireEvent.input(within(groq).getByLabelText('API-sleutel voor Groq'), { target: { value: FAKE_KEY } });
    fireEvent.click(within(groq).getByRole('button', { name: 'Opslaan' }));
    await settle();
    return groq;
  }

  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLocale('en');
  });

  it('shows apply.detail from main for waiting-for-idle, not a fixed text', async () => {
    stubVault({ state: 'waiting-for-idle', detail: 'Wordt actief zodra de lopende klus klaar is.', action: null });
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = await saveGroqKey(container);
    expect(within(groq).getByText('Wordt actief zodra de lopende klus klaar is.')).toBeInTheDocument();
    expect(within(groq).queryByRole('button', { name: 'Nu opnieuw verbinden' })).toBeNull();
    expect(within(groq).queryByText('Actief')).toBeNull();
  });

  it('unknown turn state: the reconnect-now action is a button with the label from main that calls reconnectNow()', async () => {
    const reconnectNow = vi.fn(async () => ({ ok: true, apply: { state: 'restarting', detail: 'Even opnieuw verbinden...', action: null } }));
    stubVault({ state: 'waiting-for-idle', detail: WAIT_UNKNOWN, action: { id: 'reconnect-now', label: 'Nu opnieuw verbinden' } }, reconnectNow);
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = await saveGroqKey(container);
    expect(within(groq).getByText(WAIT_UNKNOWN)).toBeInTheDocument();
    fireEvent.click(within(groq).getByRole('button', { name: 'Nu opnieuw verbinden' }));
    await settle();
    expect(reconnectNow).toHaveBeenCalledTimes(1);
    expect(reconnectNow).toHaveBeenCalledWith();
    expect(within(groq).getByText('Even opnieuw verbinden...')).toBeInTheDocument();
    expect(within(groq).queryByRole('button', { name: 'Nu opnieuw verbinden' })).toBeNull();
  });

  it('reconnect refused while a klus runs: the Dutch message from main is shown and the change keeps waiting', async () => {
    const reconnectNow = vi.fn(async () => ({ ok: false, code: 'TURN_RUNNING', message: TURN_RUNNING }));
    stubVault({ state: 'waiting-for-idle', detail: WAIT_UNKNOWN, action: { id: 'reconnect-now', label: 'Nu opnieuw verbinden' } }, reconnectNow);
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = await saveGroqKey(container);
    fireEvent.click(within(groq).getByRole('button', { name: 'Nu opnieuw verbinden' }));
    await settle();
    expect(within(groq).getByText(TURN_RUNNING)).toBeInTheDocument();
    expect(within(groq).getByText(WAIT_UNKNOWN)).toBeInTheDocument();
  });

  it('reconnect refused without a message falls back to the Dutch text for its code', async () => {
    const reconnectNow = vi.fn(async () => ({ ok: false, code: 'NOTHING_PENDING', message: '' }));
    stubVault({ state: 'waiting-for-idle', detail: WAIT_UNKNOWN, action: { id: 'reconnect-now', label: 'Nu opnieuw verbinden' } }, reconnectNow);
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = await saveGroqKey(container);
    fireEvent.click(within(groq).getByRole('button', { name: 'Nu opnieuw verbinden' }));
    await settle();
    expect(within(groq).getByText('Er is geen sleutelwijziging om toe te passen.')).toBeInTheDocument();
  });

  it('while the change waits, status(id) is read about every 2 s and the line follows it to Actief', async () => {
    stubVault({ state: 'waiting-for-idle', detail: 'Wordt actief zodra de lopende klus klaar is.', action: null });
    const forge = (globalThis as unknown as { forge: { keys: Record<string, unknown> } }).forge;
    const status = vi.fn(async (providerId: string) => ({
      ok: true,
      status: { provider_id: providerId, configured: true, last4: 'Wx9z', updated_at: '2026-11-02T08:00:00Z' },
      apply: { state: 'applied', detail: null, action: null },
    }));
    forge.keys.status = status;
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = await saveGroqKey(container);
    expect(within(groq).getByText('Wordt actief zodra de lopende klus klaar is.')).toBeInTheDocument();
    expect(status).not.toHaveBeenCalled();
    await settle(2_200);
    expect(status).toHaveBeenCalledWith('groq');
    expect(within(groq).getByText('Actief')).toBeInTheDocument();
    const calls = status.mock.calls.length;
    await settle(2_200);
    // Applied: the poll stops.
    expect(status.mock.calls.length).toBe(calls);
  });

  it('a card under "Meer accounts" stays in place after a save, so its apply line and action survive the list refresh', async () => {
    const reconnectNow = vi.fn(async () => ({ ok: false, code: 'TURN_RUNNING', message: TURN_RUNNING }));
    stubVault({ state: 'waiting-for-idle', detail: WAIT_UNKNOWN, action: { id: 'reconnect-now', label: 'Nu opnieuw verbinden' } }, reconnectNow);
    // The vault list now reports the new key, which makes the account "primary" for a fresh visit.
    const forge = (globalThis as unknown as { forge: { keys: Record<string, unknown> } }).forge;
    let stored = false;
    const set = forge.keys.set as (id: string, secret: string) => Promise<unknown>;
    forge.keys.set = async (id: string, secret: string) => {
      stored = true;
      return set(id, secret);
    };
    forge.keys.list = async () => ({
      ok: true,
      vault: { state: 'ready', reason: null, persistent: true },
      keys: stored ? [{ provider_id: 'groq', configured: true, last4: 'Wx9z', updated_at: '2026-11-02T08:00:00Z' }] : [],
    });
    stubGateway();
    const { container } = renderSection();
    await settle();
    expect(card(container, 'groq').closest('details.fs-prov__more')).not.toBeNull();
    await saveGroqKey(container);
    await settle();
    const groq = card(container, 'groq');
    expect(groq.closest('details.fs-prov__more')).not.toBeNull();
    expect(within(groq).getByText(WAIT_UNKNOWN)).toBeInTheDocument();
    expect(within(groq).getByRole('button', { name: 'Nu opnieuw verbinden' })).toBeInTheDocument();
    // The gateway has not got the key yet (it arrives with the restart); the word says Ingesteld, not "Geen sleutel".
    expect(within(groq).getByText('Ingesteld', { selector: '.fs-pill' })).toBeInTheDocument();
  });

  it.each([
    ['missing', undefined],
    ['unknown', { state: 'half-done', detail: null }],
  ])('apply.state %s is NOT shown as Actief: a neutral "status unknown" line instead', async (_name, apply) => {
    stubVault(apply);
    stubGateway();
    const { container } = renderSection();
    await settle();
    const groq = await saveGroqKey(container);
    expect(within(groq).getByText(/Sleutel opgeslagen: •••• Wx9z/)).toBeInTheDocument();
    expect(within(groq).queryByText('Actief')).toBeNull();
    expect(within(groq).getByText('Status onbekend, controleer straks opnieuw.')).toBeInTheDocument();
  });
});
