/**
 * Settings v1.0 redesign (part 2C, DESIGN.md §3.4): what the new screen adds on top of the B6 page.
 *   - "Account toevoegen" opens the four onboarding choices and gives one honest next step per choice;
 *   - "Rondleiding opnieuw bekijken" shows only while a tour listens, and restarts it;
 *   - Eigen API is its own group in Uitgebreid only;
 *   - the Settings style sheets use the v1.0 tokens only: no raw hex, no old --forge-* names, no ALL CAPS,
 *     and motion on transform/opacity only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { setLocale } from '@/i18n';
import type { CheckupController } from '@/components/checkup/use-checkup';
import { onTourReplay } from '@/components/shell/shell-events';
import { setUiMode } from '@/state/ui-mode';
import { AccountsSection } from '@/views/settings/sections/AccountsSection';
import { TourRow } from '@/views/settings/sections/GeneralRows';
import { onAddClaudeAccount } from '@/views/settings/sections/app-router/router-events';

const ROWS = [
  { id: 'claude-code-cli', label: 'Claude Code', kind: 'subscription', status_code: 'connected', state: 'signed-in', tos: { required: true, checked_on: '2026-11-01' } },
  { id: 'codex-cli', label: 'Codex', kind: 'subscription', status_code: 'not-connected', state: 'not-connected', tos: { required: true, checked_on: '2026-11-01' } },
  { id: 'ollama-local', label: 'Ollama (this PC)', kind: 'local', local: true, status_code: 'not-connected', state: 'unreachable' },
];

function stubGateway(providers: unknown = { ok: true, providers: ROWS }) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      let body: unknown = {};
      if (url.endsWith('/api/providers/custom')) body = { ok: true, revision: 1, providers: [] };
      else if (url.includes('/api/providers')) body = providers;
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  return calls;
}

function checkupStub(ollama = { found: true, up: false, models: [] as string[] }): CheckupController {
  const result = {
    claude: { found: true, version: '2.1.316', signedIn: true },
    codex: { found: false, version: null },
    ollama,
    node: { version: '24.18.0' },
    git: { found: true, version: '2.54.0' },
    diskFreeGb: 200,
    port: 4100,
    writableProjectDir: null,
    checkedAt: null,
    durationMs: 10,
    timedOut: false,
  };
  return { status: 'done', result, error: null, finishedAt: null, run: vi.fn() } as unknown as CheckupController;
}

function renderAccounts(checkup = checkupStub()) {
  return render(createElement(MemoryRouter, null, createElement(AccountsSection, { checkup })));
}

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function openChooser(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Account toevoegen' }));
  return screen.getByRole('dialog', { name: 'Welk account wil je toevoegen?' });
}

function choose(dialog: HTMLElement, name: RegExp): void {
  fireEvent.click(within(dialog).getByRole('radio', { name }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Verder' }));
}

describe('Settings › Accounts › "Account toevoegen" (v1.0 redesign)', () => {
  beforeEach(() => {
    setLocale('nl');
    setUiMode('eenvoudig');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setUiMode('eenvoudig');
    setLocale('en');
  });

  it('offers the same four choices as onboarding; Verder waits for a choice', async () => {
    stubGateway();
    renderAccounts();
    await settle();
    const dialog = openChooser();
    expect(within(dialog).getAllByRole('radio').map((radio) => radio.querySelector('.fw-choice__name')?.textContent)).toEqual([
      'Claude',
      'ChatGPT',
      'Gratis op deze pc',
      'Eigen sleutel of server',
    ]);
    expect(within(dialog).getByRole('button', { name: 'Verder' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: /ChatGPT/ }));
    expect(within(dialog).getByRole('button', { name: 'Verder' })).toBeEnabled();
  });

  it('Eigen sleutel of server opens the Eigen API form in the dialog (no key field before saving); Terug goes back', async () => {
    stubGateway();
    renderAccounts();
    await settle();
    choose(openChooser(), /Eigen sleutel of server/);
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Eigen sleutel of server' });
    expect(within(dialog).getByLabelText('Naam')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Adres (base URL)')).toBeInTheDocument();
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
    // The form has its own Opslaan and Klaar; the dialog footer only offers Terug.
    expect(within(dialog).queryByRole('button', { name: 'Klaar' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terug' }));
    expect(screen.getByRole('dialog', { name: 'Welk account wil je toevoegen?' })).toBeInTheDocument();
  });

  it('ChatGPT when not signed in: only the official command to copy, nothing is run', async () => {
    const calls = stubGateway();
    renderAccounts();
    await settle();
    const before = calls.length;
    choose(openChooser(), /ChatGPT/);
    const dialog = screen.getByRole('dialog', { name: 'ChatGPT' });
    expect(within(dialog).getByText('codex login')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Opdracht kopiëren' })).toBeInTheDocument();
    expect(calls.length).toBe(before);
  });

  it('Claude when already signed in: says so, and offers an extra Claude account only while the router listens', async () => {
    stubGateway();
    renderAccounts();
    await settle();
    choose(openChooser(), /^Claude/);
    let dialog = screen.getByRole('dialog', { name: 'Claude' });
    expect(within(dialog).getByText('Verbonden')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Claude-account toevoegen' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    const listener = vi.fn();
    const stop = onAddClaudeAccount(listener);
    try {
      choose(openChooser(), /^Claude/);
      dialog = screen.getByRole('dialog', { name: 'Claude' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Claude-account toevoegen' }));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      stop();
    }
  });

  it('Gratis op deze pc: what the pc check found about Ollama, with the one command that fixes it', async () => {
    stubGateway();
    const checkup = checkupStub({ found: true, up: false, models: [] });
    renderAccounts(checkup);
    await settle();
    choose(openChooser(), /Gratis op deze pc/);
    const dialog = screen.getByRole('dialog', { name: 'Gratis op deze pc' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Ollama staat op deze pc, maar is uit');
    expect(within(dialog).getByText('ollama serve')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Opnieuw controleren' }));
    expect(checkup.run).toHaveBeenCalled();
  });

  it('Eigen API is its own group in Uitgebreid only', async () => {
    stubGateway();
    renderAccounts();
    await settle();
    expect(screen.queryByRole('heading', { name: 'Eigen API' })).toBeNull();
    cleanup();
    setUiMode('uitgebreid');
    renderAccounts();
    await settle();
    expect(screen.getByRole('heading', { name: 'Eigen API' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Eigen API toevoegen' })).toBeInTheDocument();
  });
});

const SAVED_API = {
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

/** A gateway whose Eigen API list grows after a POST, and whose PATCH answers 409 until the list was re-read. */
function stubOwnApiGateway() {
  const calls: { url: string; method: string; body: string }[] = [];
  let stored: unknown[] = [];
  let listRevision = 2;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' });
      let status = 200;
      let body: unknown = {};
      if (url.endsWith('/api/providers/custom') && method === 'GET') body = { ok: true, revision: listRevision, providers: stored };
      else if (url.endsWith('/api/providers/custom') && method === 'POST') {
        stored = [SAVED_API];
        // Someone else changes the list right after this save: the next save must use the re-read revision.
        listRevision = 7;
        status = 201;
        body = { ok: true, revision: 3, provider: SAVED_API };
      } else if (/\/api\/providers\/custom\/[^/]+$/.test(url) && method === 'PATCH') {
        const sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { revision?: number };
        if (sent.revision === listRevision) body = { ok: true, revision: listRevision + 1, provider: SAVED_API };
        else {
          status = 409;
          body = { ok: false, error: 'stale_revision', revision: listRevision };
        }
      } else if (url.includes('/api/providers')) body = { ok: true, providers: ROWS };
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
  return calls;
}

function fillField(scope: HTMLElement, label: string, value: string) {
  const field = within(scope).getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

describe('Settings › Accounts › Eigen API through "Account toevoegen"', () => {
  beforeEach(() => {
    setLocale('nl');
    setUiMode('uitgebreid');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setUiMode('eenvoudig');
    setLocale('en');
  });

  it('Uitgebreid: an entry saved in the dialog shows up in the Eigen API list without a reload', async () => {
    stubOwnApiGateway();
    renderAccounts();
    await settle();
    const group = screen.getByRole('heading', { name: 'Eigen API' }).closest('section') as HTMLElement;
    expect(within(group).queryByText('Mijn vLLM')).toBeNull();
    choose(openChooser(), /Eigen sleutel of server/);
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Eigen sleutel of server' });
    fillField(dialog, 'Naam', 'Mijn vLLM');
    fillField(dialog, 'Adres (base URL)', 'http://192.168.1.20:8000/v1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(within(group).getByText('Mijn vLLM')).toBeInTheDocument();
  });

  it('after a save, a 409 re-reads the list and the next Opslaan uses the new revision', async () => {
    const calls = stubOwnApiGateway();
    renderAccounts();
    await settle();
    choose(openChooser(), /Eigen sleutel of server/);
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Eigen sleutel of server' });
    fillField(dialog, 'Naam', 'Mijn vLLM');
    fillField(dialog, 'Adres (base URL)', 'http://192.168.1.20:8000/v1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Opslaan' }));
    await settle();
    // The list changed elsewhere (revision 7): the first edit is refused as stale, the form re-reads the list ...
    fillField(dialog, 'Naam', 'Mijn vLLM 2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Opslaan' }));
    await settle();
    const patches = () => calls.filter((call) => call.method === 'PATCH').map((call) => (JSON.parse(call.body) as { revision: number }).revision);
    expect(patches()).toEqual([3]);
    // ... and the retry is based on what it read, so it goes through.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(patches()).toEqual([3, 7]);
  });
});

describe('Settings › Algemeen › Rondleiding opnieuw bekijken', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('shows only while a tour listens, and restarts it', () => {
    const { container } = render(createElement(TourRow));
    expect(container.textContent).toBe('');
    cleanup();
    const replay = vi.fn();
    const stop = onTourReplay(replay);
    try {
      render(createElement(TourRow));
      fireEvent.click(screen.getByRole('button', { name: 'Rondleiding opnieuw bekijken' }));
      expect(replay).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});

describe('Settings style sheets use the v1.0 tokens only', () => {
  const root = join(__dirname, '..', '..', 'src', 'views');
  const sheets = [
    'settings/settings-page.css',
    'settings/settings.css',
    'settings/sections/accounts.css',
    'settings/sections/custom-api/custom-api.css',
    'settings/sections/app-router/app-router.css',
    'accounts/accounts.css',
  ];
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

  it.each(sheets)('%s: no raw hex, no --forge-* name, no ALL CAPS, motion on transform/opacity only', (sheet) => {
    const css = strip(readFileSync(join(root, sheet), 'utf8'));
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/--forge-/);
    expect(css).not.toMatch(/--fs-temper/);
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/transition-property|transition:\s*all/);
    for (const match of css.matchAll(/transition:\s*([^;]+);/g)) {
      if (match[1].trim() === 'none') continue;
      for (const part of match[1].split(',')) expect(part.trim().split(/\s+/)[0], `${sheet}: ${match[0]}`).toMatch(/^(transform|opacity)$/);
    }
  });
});
