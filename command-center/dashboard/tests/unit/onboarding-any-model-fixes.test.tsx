/**
 * Any-model phase 1, dashboard fix lane (ANY-MODEL-PLAN.md §2 and §7):
 *  1. The ChatGPT/Codex path says ONE honest thing about what Codex can do in Forge now (read and answer,
 *     no file edits, no commands): the same sentence as the chat notice, everywhere in the onboarding.
 *  2. "Eigen API (adres + sleutel)" is a choice of its own on the "Geen Claude?" start screen, next to
 *     ChatGPT, Gratis & lokaal and API-sleutel, and it opens the own-API form directly. The API-sleutel
 *     path keeps working, and switching between the two keeps the title and the end screen right.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import en from '@/i18n/locales/en.json';
import nl from '@/i18n/locales/nl.json';
import OnboardingView from '@/views/onboarding/OnboardingView';
import type { OnboardingViewProps } from '@/views/onboarding/OnboardingView';
import { CAPABILITY_TABLE, PATHS } from '@/views/onboarding/onboarding-model';

function checkup() {
  return {
    ok: true,
    checked_at: '2026-11-02T08:00:00.000Z',
    duration_ms: 900,
    timed_out: false,
    claude: { found: false, version: null, signedIn: null },
    codex: { found: true, version: '0.156.1' },
    ollama: { found: false, up: false, models: [] },
    node: { version: '24.18.0' },
    git: { found: true, version: '2.54.0' },
    disk_free_gb: 120,
    port: 4100,
    writable_project_dir: null,
  };
}

function stubGateway() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let body: unknown = {};
      if (url.includes('/api/checkup')) body = checkup();
      else if (url.endsWith('/api/providers/custom') && method === 'GET') body = { ok: true, revision: 0, providers: [] };
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function renderWizard(props: OnboardingViewProps) {
  return render(createElement(MemoryRouter, null, createElement(OnboardingView, props)));
}

/** Every onboarding string, flattened, per locale. */
function onboardingStrings(tree: unknown, prefix = 'onboarding'): [string, string][] {
  if (typeof tree === 'string') return [[prefix, tree]];
  if (tree === null || typeof tree !== 'object') return [];
  return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) => onboardingStrings(value, `${prefix}.${key}`));
}

describe('ChatGPT/Codex: one honest sentence about what Codex can do in Forge now', () => {
  it('the onboarding sentence is the chat notice sentence, word for word, in Dutch and English', () => {
    expect(nl.onboarding.codexCan).toBe(nl.chat.route.readAnswer);
    expect(en.onboarding.codexCan).toBe(en.chat.route.readAnswer);
    expect(nl.onboarding.klaar.leadChatgpt.startsWith(nl.onboarding.codexCan)).toBe(true);
    expect(en.onboarding.klaar.leadChatgpt.startsWith(en.onboarding.codexCan)).toBe(true);
  });

  it('no onboarding text says Codex edits files (its "own way of working" is not what Forge does today)', () => {
    const claims = /past bestanden aan|bestanden aanpassen op zijn|eigen werkwijze van Codex|edits files|own way of working/i;
    for (const [key, text] of [...onboardingStrings(nl.onboarding), ...onboardingStrings(en.onboarding)]) {
      if (/codex/i.test(text) || key.includes('chatgpt')) expect([key, claims.test(text)]).toEqual([key, false]);
    }
  });

  it('the capability table says Codex does not edit files in your folder, with the reason in the cell', () => {
    const row = CAPABILITY_TABLE.find((entry) => entry.path === 'chatgpt');
    expect(row?.files).toEqual({ yes: false, remark: 'readOnly' });
  });

  describe('rendered', () => {
    beforeEach(() => setLocale('nl'));
    afterEach(() => {
      cleanup();
      vi.unstubAllGlobals();
      setLocale('en');
    });

    it('the connect step names what Codex can do, not the generic "only answer" line', async () => {
      stubGateway();
      renderWizard({ initialStep: 'verbinden', initialPath: 'chatgpt' });
      await settle();
      expect(screen.getByText(nl.onboarding.codexCan)).toBeInTheDocument();
      expect(screen.queryByText(/kan in Forge nu alleen antwoorden/)).toBeNull();
    });

    it('the end screen and its table agree with that sentence', async () => {
      stubGateway();
      renderWizard({ initialStep: 'klaar', initialPath: 'chatgpt' });
      await settle();
      expect(screen.getByText(/^Codex kan lezen en antwoorden, maar geen bestanden bewerken of opdrachten uitvoeren\./)).toBeInTheDocument();
      // Redesign 2D: the table sits behind "Wat kan elk pad?".
      fireEvent.click(screen.getByRole('button', { name: 'Wat kan elk pad?' }));
      const row = within(screen.getByRole('table')).getByRole('row', { name: /ChatGPT\/Codex/ });
      expect(Array.from(row.children).map((cell) => cell.textContent?.replace(/\s*\(jouw keuze\)/, '').trim())).toEqual([
        'ChatGPT/Codex',
        'ja',
        'nee (alleen lezen en antwoorden)',
        'nee',
        'nee',
      ]);
    });
  });
});

describe('"Eigen API (adres + sleutel)" on the "Geen Claude?" start screen', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocale('en');
  });

  it('is a fifth path, right after the three other paths without Claude', () => {
    expect(PATHS).toEqual(['claude', 'chatgpt', 'lokaal', 'sleutel', 'eigen']);
  });

  it('"Eigen sleutel of server" is one of the four choices; picking it opens the key path, and the table names Eigen API', async () => {
    // Redesign 2D (DESIGN.md §3.5): four choices. The own choice covers both the API-sleutel path and
    // the own-API path; the connect step switches between the two (tests below).
    stubGateway();
    renderWizard({ initialStep: 'pad', initialPath: null });
    await settle();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    const own = screen.getByRole('radio', { name: /Eigen sleutel of server/ });
    expect(screen.getByText('Geen Claude? Je kunt toch beginnen; bestanden laten bouwen vraagt Claude.')).toBeInTheDocument();
    fireEvent.click(own);
    expect(own).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Verder' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Wat kan elk pad?' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('row', { name: /Andere API-sleutel/ }).getAttribute('class')).toBe('is-chosen');
    expect(within(table).getByRole('row', { name: /^Eigen API/ })).toBeInTheDocument();
  });

  it('a person who was already on the own-API path keeps it when the own choice is shown', async () => {
    stubGateway();
    renderWizard({ initialStep: 'pad', initialPath: 'eigen' });
    await settle();
    expect(screen.getByRole('radio', { name: /Eigen sleutel of server/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Wat kan elk pad?' }));
    expect(within(screen.getByRole('table')).getByRole('row', { name: /^Eigen API/ }).getAttribute('class')).toBe('is-chosen');
  });

  it('opens the own-API form directly; "Toch een dienst uit de lijst" turns it into the API-sleutel path', async () => {
    stubGateway();
    renderWizard({ initialStep: 'verbinden', initialPath: 'eigen' });
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Je eigen API');
    expect(screen.getByRole('heading', { name: 'Nieuwe eigen API' })).toBeInTheDocument();
    expect(screen.getByLabelText('Adres (base URL)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Toch een dienst uit de lijst' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Je API-sleutel');
    expect(screen.getByLabelText('Van welke dienst is je sleutel?')).toBeInTheDocument();
  });

  it('the API-sleutel path still works, and "Eigen API invullen" there makes the title follow', async () => {
    stubGateway();
    renderWizard({ initialStep: 'verbinden', initialPath: 'sleutel' });
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Je API-sleutel');
    expect(screen.getByLabelText('Van welke dienst is je sleutel?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Eigen API invullen' }));
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Je eigen API');
    expect(screen.getByRole('heading', { name: 'Nieuwe eigen API' })).toBeInTheDocument();
  });

  it('the end screen for this path is honest about what it can do', async () => {
    stubGateway();
    renderWizard({ initialStep: 'klaar', initialPath: 'eigen' });
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Klaar om te beginnen');
    expect(screen.getByText(/Met je eigen API kun je chatten, maar nog geen bestanden aanpassen/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude-account toevoegen' })).toBeInTheDocument();
  });
});
