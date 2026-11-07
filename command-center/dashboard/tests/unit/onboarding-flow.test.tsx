/**
 * WP B6, redesigned in 2D (DESIGN.md §3.5) — the first-start wizard. A stubbed checkup drives the four
 * steps: Welkom → Kies → Verbinden → Klaar (the folder now lives on Klaar). Also: the end-screen table per path (plan §3.2 cell for cell),
 * the folder guardrails, the API-key step in a browser (no key field there), and when a first start redirects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { setLocale } from '@/i18n';
import nl from '@/i18n/locales/nl.json';
import { parseCheckup } from '@/components/checkup/checkup-model';
import OnboardingView from '@/views/onboarding/OnboardingView';
import type { OnboardingViewProps } from '@/views/onboarding/OnboardingView';
import {
  CAPABILITY_TABLE,
  folderRefusal,
  isOnboardingDone,
  ONBOARDING_DONE_KEY,
  ONBOARDING_FOLDER_KEY,
  shouldStartOnboarding,
  suggestPath,
} from '@/views/onboarding/onboarding-model';

const DOCS = 'C:\\Users\\someone\\Documents';

function checkupAnswer(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    checked_at: '2026-11-01T21:16:59.882Z',
    duration_ms: 900,
    timed_out: false,
    claude: { found: true, version: '2.1.316', signedIn: false },
    codex: { found: false, version: null },
    ollama: { found: true, up: true, models: ['llama3.2:latest'] },
    node: { version: '24.18.0' },
    git: { found: true, version: '2.54.0' },
    disk_free_gb: 120,
    port: 4100,
    writable_project_dir: null,
    ...overrides,
  };
}

function stubGateway(answer: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes('/api/checkup')) body = url.includes('dir=') ? { ...answer, writable_project_dir: true } : answer;
      else if (url.includes('/api/discord/browse-folder')) {
        const dir = new URL(url).searchParams.get('dir');
        body = dir
          ? { ok: true, path: dir, parent: DOCS, folders: [], truncated: false }
          : { ok: true, path: DOCS, parent: 'C:\\Users\\someone', folders: ['Forge Projecten', 'Facturen'], truncated: false };
      }
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function renderWizard(props: OnboardingViewProps = {}) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: ['/onboarding'] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/onboarding', element: createElement(OnboardingView, props) }),
        createElement(Route, { path: '/', element: createElement('p', null, 'START') }),
        createElement(Route, { path: '/chat', element: createElement('p', null, 'CHAT') }),
        createElement(Route, { path: '/settings', element: createElement('p', null, 'SETTINGS') }),
      ),
    ),
  );
}

function next() {
  const footer = document.querySelector('.fs-onb__foot') as HTMLElement;
  const buttons = within(footer).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1]);
}

describe('onboarding flow (WP B6)', () => {
  beforeEach(() => {
    setLocale('nl');
    localStorage.removeItem(ONBOARDING_DONE_KEY);
    localStorage.removeItem(ONBOARDING_FOLDER_KEY);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocale('en');
    localStorage.removeItem(ONBOARDING_DONE_KEY);
    localStorage.removeItem(ONBOARDING_FOLDER_KEY);
    localStorage.removeItem('forge.onboarding.path');
    localStorage.removeItem('forge.tour');
  });

  it('walks Welkom → Kies → Verbinden → Klaar (4 steps) with a stubbed checkup', async () => {
    stubGateway(checkupAnswer());
    renderWizard();
    // While the silent pc check runs, the step only says it is checking.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welkom bij Forge');
    await settle();
    // No real pc problem: one calm title, no rows in plain sight, no port.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Alles klaar op deze pc');
    expect(document.querySelector('.fs-checkup--bare')).toBeNull();
    expect(document.body.textContent).not.toMatch(/poort/i);
    const steps = screen.getByRole('list', { name: 'Stappen' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(4);
    expect(steps.querySelector('[aria-current="step"]')).toHaveTextContent('Welkom');
    expect(screen.getByText('Stap 1 van 4')).toBeInTheDocument();
    // The full check stays one click away, behind "Meer info".
    fireEvent.click(screen.getByRole('button', { name: 'Meer info' }));
    expect(screen.getByText('Claude Code gevonden (versie 2.1.316)')).toBeInTheDocument();

    next();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Waarmee wil je werken?');
    expect(screen.getByText('Stap 2 van 4')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    // Claude Code was found, so that path is already chosen.
    expect(screen.getByRole('radio', { name: /^Claude/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Geen Claude? Je kunt toch beginnen; bestanden laten bouwen vraagt Claude.')).toBeInTheDocument();
    // The capability table is behind "Wat kan elk pad?".
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Wat kan elk pad?' }));
    expect(screen.getByRole('table', { name: 'Wat kan elk pad?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Gratis op deze pc/ }));
    expect(screen.getByRole('radio', { name: /Gratis op deze pc/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Verder' })).toBeEnabled();

    next();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Ollama klaarzetten');
    expect(screen.getByText(/Ollama draait. Modellen op deze pc: llama3.2:latest/)).toBeInTheDocument();

    next();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Klaar om te beginnen');
    expect(screen.getByText('Stap 4 van 4')).toBeInTheDocument();
    expect(screen.getByText(/Het team dat bestanden voor je bouwt heeft een Claude-account nodig/)).toBeInTheDocument();
    // The folder lives on Klaar now: refused for Documents itself, accepted inside it.
    expect(screen.getByText('Nog geen projectmap gekozen')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Map kiezen' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Deze map gebruiken' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Heel Documenten is te groot');
    fireEvent.click(screen.getByRole('button', { name: 'Forge Projecten' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Deze map gebruiken' }));
    await settle();
    expect(screen.getByText('Je werkt in: C:\\Users\\someone\\Documents\\Forge Projecten')).toBeInTheDocument();
    expect(screen.getByText('Forge mag hier schrijven.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
    expect(screen.getByText('START')).toBeInTheDocument();
    expect(isOnboardingDone()).toBe(true);
    expect(localStorage.getItem(ONBOARDING_FOLDER_KEY)).toBe('C:\\Users\\someone\\Documents\\Forge Projecten');
    expect(localStorage.getItem('forge.tour')).toBeNull();
  });

  it('Welkom shows a real pc problem as one row with one fix, and nothing else', async () => {
    stubGateway(checkupAnswer({ disk_free_gb: 2.1 }));
    renderWizard();
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welkom bij Forge');
    const bare = document.querySelector('.fs-checkup--bare') as HTMLElement;
    expect(bare).not.toBeNull();
    const rows = bare.querySelectorAll('.fs-checkup__row');
    expect(Array.from(rows).map((row) => row.getAttribute('data-check'))).toEqual(['disk']);
    expect(within(rows[0] as HTMLElement).getAllByRole('button')).toHaveLength(1);
  });

  it('a silent gateway on Welkom says so and still lets you continue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response));
    renderWizard();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Controleren lukte niet');
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('Alles klaar');
    expect(screen.getByRole('button', { name: 'Verder' })).toBeEnabled();
  });

  it('"Laat me rondkijken" finishes onboarding and asks for the 3-stop tour', async () => {
    stubGateway(checkupAnswer());
    renderWizard({ initialStep: 'klaar', initialPath: 'claude' });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Laat me rondkijken' }));
    expect(screen.getByText('START')).toBeInTheDocument();
    expect(isOnboardingDone()).toBe(true);
    expect(localStorage.getItem('forge.tour')).toBe('pending');
  });

  it('Overslaan is offered from step 2 and finishes without choosing a path', async () => {
    stubGateway(checkupAnswer());
    renderWizard({ initialStep: 'detectie' });
    await settle();
    expect(screen.queryByRole('button', { name: 'Overslaan' })).toBeNull();
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Overslaan' }));
    expect(screen.getByText('START')).toBeInTheDocument();
    expect(isOnboardingDone()).toBe(true);
    expect(localStorage.getItem('forge.onboarding.path')).toBeNull();
  });

  it('the old "projectmap" entry opens Klaar with the folder picker open', async () => {
    stubGateway(checkupAnswer());
    renderWizard({ initialStep: 'projectmap', initialPath: 'claude' });
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Klaar om te beginnen');
    expect(await screen.findByRole('button', { name: 'Deze map gebruiken' })).toBeInTheDocument();
  });

  it('Claude path, not signed in: shows the login copy, the exact command and a re-check', async () => {
    stubGateway(checkupAnswer());
    renderWizard({ initialStep: 'verbinden', initialPath: 'claude' });
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Open Claude Code om in te loggen');
    expect(screen.getByText(/Claude Code werkt in een zwart venster/)).toBeInTheDocument();
    expect(screen.getByLabelText('Opdracht')).toHaveTextContent('claude auth login');
    const fetchSpy = vi.mocked(globalThis.fetch);
    const before = fetchSpy.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Opnieuw controleren' }));
    await settle();
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it('API-sleutel in a browser (WP B2 part 2): no key field, it says the app is needed, and you can continue', async () => {
    stubGateway(checkupAnswer());
    const { container } = renderWizard({ initialStep: 'verbinden', initialPath: 'sleutel' });
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Je API-sleutel');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('alleen in de Forge Systeem-app');
    expect(screen.getByRole('button', { name: 'Verder' })).toBeEnabled();
  });

  it.each([
    ['claude', nl.onboarding.klaar.leadClaude],
    ['chatgpt', nl.onboarding.klaar.leadChatgpt],
    ['lokaal', nl.onboarding.klaar.leadLokaal],
    ['sleutel', nl.onboarding.klaar.leadSleutel],
    ['eigen', nl.onboarding.klaar.leadEigen],
  ] as const)('end screen for %s: its honest lead and the §3.2 table (behind "Wat kan elk pad?") with that row chosen', async (path, lead) => {
    stubGateway(checkupAnswer());
    renderWizard({ initialStep: 'klaar', initialPath: path });
    await settle();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Klaar om te beginnen');
    expect(document.querySelector('.fs-onb__lead')?.textContent).toBe(lead);
    fireEvent.click(screen.getByRole('button', { name: 'Wat kan elk pad?' }));
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => Array.from(row.children).map((cell) => cell.textContent?.replace(/\s*\(jouw keuze\)/, '').trim()))).toEqual([
      ['Claude (abonnement of sleutel)', 'ja', 'ja', 'ja', 'nee'],
      // Any-model fix lane: Codex reads and answers in Forge, it does not edit files in your folder.
      ['ChatGPT/Codex', 'ja', 'nee (alleen lezen en antwoorden)', 'nee', 'nee'],
      ['Gratis & lokaal (Ollama)', 'ja', 'nee (nog niet)', 'nee', 'ja'],
      ['Andere API-sleutel', 'ja', 'nee', 'nee', 'nee'],
      ['Eigen API', 'ja', 'nee', 'nee', 'ja (server thuis)'],
    ]);
    const chosen = table.querySelector('tr.is-chosen');
    expect(chosen?.getAttribute('data-path')).toBe(path);
    // Only paths without the team offer to add a Claude account.
    expect(screen.queryByRole('button', { name: 'Claude-account toevoegen' }) !== null).toBe(path !== 'claude');
    // Final review finding 4: the lead sits right above that button, so it offers now-or-later, not only "later".
    if (path !== 'claude') {
      expect(lead.endsWith('Voeg het nu toe, of later via Instellingen.')).toBe(true);
      expect(lead).not.toMatch(/later toe via/);
    }
  });

  it('the capability data matches plan §3.2 (Codex corrected to read-and-answer, plus the Eigen API row)', () => {
    expect(CAPABILITY_TABLE.map((row) => [row.path, row.chat.yes, row.files.yes, row.team.yes, row.offline.yes])).toEqual([
      ['claude', true, true, true, false],
      ['chatgpt', true, false, false, false],
      ['lokaal', true, false, false, true],
      ['sleutel', true, false, false, false],
      ['eigen', true, false, false, true],
    ]);
  });
});

describe('onboarding rules', () => {
  it('refuses a drive root, the user folder, Documents itself and system folders', () => {
    expect(folderRefusal('C:\\', DOCS)).toBe('root');
    expect(folderRefusal('D:', DOCS)).toBe('root');
    expect(folderRefusal('C:\\Users\\someone', DOCS)).toBe('home');
    expect(folderRefusal('C:\\Users\\someone\\Documents\\', DOCS)).toBe('documents');
    expect(folderRefusal('C:\\Program Files\\App', DOCS)).toBe('system');
    expect(folderRefusal('C:\\Windows\\System32', DOCS)).toBe('system');
    expect(folderRefusal('C:\\Users\\someone\\Documents\\Forge Projecten', DOCS)).toBeNull();
  });

  it('only redirects a first start when the checkup answered and Claude Code is not ready', () => {
    const ready = parseCheckup(checkupAnswer({ claude: { found: true, version: '2', signedIn: true } }));
    const notSignedIn = parseCheckup(checkupAnswer());
    expect(shouldStartOnboarding(false, notSignedIn)).toBe(true);
    expect(shouldStartOnboarding(false, ready)).toBe(false);
    expect(shouldStartOnboarding(true, notSignedIn)).toBe(false);
    expect(shouldStartOnboarding(false, null)).toBe(false);
  });

  it('suggests the path that fits what was found', () => {
    expect(suggestPath(parseCheckup(checkupAnswer()))).toBe('claude');
    expect(suggestPath(parseCheckup(checkupAnswer({ claude: { found: false } })))).toBe('lokaal');
    expect(suggestPath(parseCheckup(checkupAnswer({ claude: { found: false }, ollama: { found: false, up: false, models: [] }, codex: { found: true } })))).toBe('chatgpt');
    expect(suggestPath(null)).toBeNull();
  });
});
