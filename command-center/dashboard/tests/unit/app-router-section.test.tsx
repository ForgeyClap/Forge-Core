/**
 * App router settings (APP-ROUTER-DESIGN.md §6.2, §7.3; part P4; v1.0 redesign DESIGN.md §3.4): the real
 * AppRouterSection against a stubbed gateway that answers with the contract's example responses. Covers
 * the Eenvoudig mode select and the Uitgebreid option keyboard, mode a blocked without the
 * acknowledgement, the add-account dialog's quoted command, the Test states, the own-model picker states,
 * the Uitgebreid chain editor reorder and threshold check, 400 and 409.
 * Fix round FX-C: the terms, the account list, the own-model picker and the chain fields sit behind
 * "Meer info" (DESIGN.md §6), so these cases open it first (`openMore`); settings-fx-c.test.tsx covers
 * what stays visible and the text budget.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import getStored from '../fixtures/app-router/get-stored.json';
import getDefault from '../fixtures/app-router/get-default.json';
import statusFixture from '../fixtures/app-router/status.json';
import statusExhausted from '../fixtures/app-router/status-exhausted.json';
import post400 from '../fixtures/app-router/post-400.json';
import profiles201 from '../fixtures/app-router/profiles-201.json';
import testResults from '../fixtures/app-router/test-results.json';

import { setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setUiMode } from '@/state/ui-mode';
import { AppRouterSection } from '@/views/settings/sections/app-router/AppRouterSection';
import { headingSkips } from './heading-order';

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

interface Gateway {
  get: Answer | 'down';
  status: Answer;
  providers: unknown[];
  models: unknown[];
  post: Answer;
  profiles: Answer;
  test: Answer;
  readonly calls: { url: string; method: string; body: unknown }[];
}

const OLLAMA_UP = { id: 'ollama-local', label: 'Ollama (this PC)', kind: 'local', local: true, status_code: 'connected', state: 'reachable' };
const MODELS_OK = [{ id: 'ollama-local', label: 'Ollama', status_code: 'connected', models: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5:0.5b' }], models_source: 'endpoint' }];

let gw: Gateway;

function stub(): Gateway {
  const g: Gateway = {
    get: { status: 200, body: getStored },
    status: { status: 200, body: statusFixture },
    providers: [OLLAMA_UP],
    models: MODELS_OK,
    post: { status: 200, body: { ok: true, config: { ...getStored.config, revision: 8 } } },
    profiles: { status: 201, body: profiles201 },
    test: { status: 200, body: testResults.ok },
    calls: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      g.calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      let answer: Answer = { status: 200, body: {} };
      if (url.includes('/api/app-router/status')) answer = g.status;
      else if (url.includes('/api/app-router/profiles')) answer = g.profiles;
      else if (url.includes('/api/app-router/targets/')) answer = g.test;
      else if (url.includes('/api/app-router')) {
        if (method === 'POST') answer = g.post;
        else if (g.get === 'down') throw new Error('connection refused');
        else answer = g.get;
      } else if (url.includes('/api/providers')) answer = { status: 200, body: { ok: true, providers: g.providers } };
      else if (url.includes('/api/models')) answer = { status: 200, body: { ok: true, providers: { pending: false, list: g.models } } };
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body } as Response;
    }),
  );
  return g;
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

function renderSection(dispatch = vi.fn()) {
  const value: StoreValue = { state: state(), dispatch };
  const utils = render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(AppRouterSection))));
  return { ...utils, dispatch };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const radio = (name: string | RegExp) => screen.getByRole('radio', { name });
/** Eenvoudig: the four modes are one select, "Wat doet Forge dan?" (DESIGN.md §3.4). */
const modeSelect = () => screen.getByRole('combobox', { name: 'Wat doet Forge dan?' }) as HTMLSelectElement;
const chooseMode = (mode: string) => fireEvent.change(modeSelect(), { target: { value: mode } });
const row = (container: HTMLElement, id: string) => container.querySelector(`.fs-router__acct[data-target="${id}"]`) as HTMLElement;
const posts = () => gw.calls.filter((call) => call.method === 'POST' && /\/api\/app-router$/.test(call.url));
/** Opens "Meer info" in the consent row ('multi'), the own-model row ('own') or under "Volgorde" ('order'). */
function openMore(container: HTMLElement, where: 'multi' | 'own' | 'order') {
  const scope = (where === 'order' ? container.querySelector('.fs-router__chain') : container.querySelector(`[data-row="router-${where}"]`)) as HTMLElement;
  fireEvent.click(within(scope).getByRole('button', { name: 'Meer info' }));
}

beforeEach(() => {
  gw = stub();
  setLocale('nl');
  setUiMode('eenvoudig');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

describe('Forge-router settings (P4)', () => {
  it('shows the loading state first, then the stored mode in the one select of Eenvoudig', async () => {
    renderSection();
    expect(screen.getByText('Router laden…')).toBeInTheDocument();
    await settle();
    expect(screen.getByRole('heading', { name: 'Als je limiet op is' })).toBeInTheDocument();
    expect(modeSelect().value).toBe('claude-then-model');
    expect(Array.from(modeSelect().options).map((option) => option.textContent)).toEqual([
      'Niets doen',
      'Wisselen tussen mijn Claude-accounts',
      'Claude eerst, dan mijn eigen model',
      'Meteen mijn eigen model',
    ]);
    expect(screen.getByText('Forge meldt het altijd in het gesprek.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByRole('link', { name: 'Hoe werkt dit?' })).toHaveAttribute('href', '/learn?lesson=limit');
  });

  it('heading levels never skip a level (axe heading-order): Eenvoudig with the accounts open, Uitgebreid with Volgorde open', async () => {
    const simple = renderSection();
    await settle();
    chooseMode('claude-accounts');
    openMore(simple.container, 'multi');
    expect(simple.container.querySelector('#fs-router-accounts-h')).toBeTruthy();
    expect(headingSkips(simple.container)).toEqual([]);
    cleanup();
    setUiMode('uitgebreid');
    const advanced = renderSection();
    await settle();
    openMore(advanced.container, 'order');
    expect(advanced.container.querySelector('.fs-router__chain .fs-router__sub')).toBeTruthy();
    expect(headingSkips(advanced.container)).toEqual([]);
  });

  it('Uitgebreid: the modes are one radiogroup, arrow keys move and choose, only the chosen option shows its line', async () => {
    setUiMode('uitgebreid');
    renderSection();
    await settle();
    const group = screen.getByRole('radiogroup', { name: 'Wat doet Forge als je limiet bijna op is?' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1]);
    expect(within(radios[2]).getByText(/Eerst je Claude-account/)).toBeInTheDocument();
    expect(within(radios[0]).queryByText(/Geen wisselen/)).toBeNull();
    fireEvent.keyDown(radios[2], { key: 'ArrowDown' });
    expect(radio(/Meteen mijn eigen model/)).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(radio(/Meteen mijn eigen model/));
    fireEvent.keyDown(radio(/Meteen mijn eigen model/), { key: 'ArrowDown' });
    expect(radio(/Niets doen/)).toHaveAttribute('aria-checked', 'true');
    expect(within(radio(/Niets doen/)).getByText(/Geen wisselen/)).toBeInTheDocument();
  });

  it('gateway unreachable: says so and "Opnieuw proberen" reads again', async () => {
    gw.get = 'down';
    renderSection();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Forge kan de router-instellingen nu niet lezen.');
    gw.get = { status: 200, body: getDefault };
    fireEvent.click(screen.getByRole('button', { name: 'Opnieuw proberen' }));
    await settle();
    expect(modeSelect().value).toBe('off');
  });

  it('mode a cannot be saved without the acknowledgement; ticking it saves the full config with its revision', async () => {
    const { container } = renderSection();
    await settle();
    chooseMode('claude-accounts');
    const save = screen.getByRole('button', { name: 'Opslaan' });
    expect(save).toBeDisabled();
    expect(screen.getAllByText('Vink eerst aan dat alle accounts van jou zijn.').length).toBeGreaterThan(0);
    // The warning behind "Meer info" names the clause sources (opened in the browser, never in-app).
    openMore(container, 'multi');
    const link = screen.getByRole('link', { name: 'Gebruiksbeleid' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Deze accounts zijn allemaal van mij en ik heb de voorwaarden gelezen.' }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await settle();
    expect(posts()).toHaveLength(1);
    const body = posts()[0].body as { mode: string; revision: number; multi_account: { enabled: boolean; acknowledged_at: string }; entries: { id: string }[] };
    expect(body.mode).toBe('claude-accounts');
    expect(body.revision).toBe(7);
    expect(body.multi_account.enabled).toBe(true);
    expect(Number.isNaN(Date.parse(body.multi_account.acknowledged_at))).toBe(false);
    expect(body.entries.map((e) => e.id)).toEqual(['main', 'werk', 'codex', 'ollama-llama31']);
  });

  it('Eenvoudig keeps the Claude accounts behind the consent row\'s "Meer info", and has no consent row when the router is off', async () => {
    const { container } = renderSection();
    await settle();
    expect(row(container, 'main')).toBeNull();
    chooseMode('claude-accounts');
    expect(row(container, 'main')).toBeNull();
    openMore(container, 'multi');
    expect(row(container, 'main')).toBeTruthy();
    expect(row(container, 'werk')).toBeTruthy();
    chooseMode('off');
    expect(container.querySelector('[data-row="router-multi"]')).toBeNull();
    expect(row(container, 'main')).toBeNull();
  });

  it('switching between accounts off: the second Claude account is grey with the reason', async () => {
    setUiMode('uitgebreid');
    const { container } = renderSection();
    await settle();
    openMore(container, 'order');
    expect(within(row(container, 'werk')).getByText('Wisselen tussen accounts staat uit')).toBeInTheDocument();
    expect(within(row(container, 'main')).getByText('Bijna op: 94%')).toBeInTheDocument();
    expect(within(row(container, 'main')).getByRole('progressbar', { name: '94% van de 5-uurslimiet' })).toBeInTheDocument();
  });

  it('add account: name → the quoted PowerShell command → Testen', async () => {
    setUiMode('uitgebreid');
    const { container } = renderSection();
    await settle();
    openMore(container, 'order');
    fireEvent.click(screen.getByRole('button', { name: 'Claude-account toevoegen' }));
    const dialog = screen.getByRole('dialog', { name: 'Claude-account toevoegen' });
    fireEvent.change(within(dialog).getByLabelText('Naam van het account'), { target: { value: 'Privé' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volgende' }));
    await settle();
    expect(within(dialog).getByText(profiles201.login.powershell)).toBeInTheDocument();
    expect(within(dialog).getByText('2. Plak deze regel en druk op Enter.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Persoonlijke instellingen uit je gewone Claude/)).toBeInTheDocument();
    gw.test = { status: 200, body: testResults.logged_out };
    fireEvent.click(within(dialog).getByRole('button', { name: 'Testen' }));
    await settle();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Niet ingelogd: volg de stappen opnieuw');
    const call = gw.calls.find((c) => c.url.includes('/api/app-router/profiles'));
    expect(call?.body).toEqual({ label: 'Privé' });
  });

  // owner bug 2026-11-02: choosing "Alleen Claude-accounts" first made the draft dirty, which disabled
  // "Account toevoegen", while saving needed a second account -> deadlock. Adding now works with unsaved changes
  // and the pending choice survives the new account.
  it('adding works with unsaved changes and keeps the pending choice (no deadlock)', async () => {
    setUiMode('uitgebreid');
    const { container } = renderSection();
    await settle();
    fireEvent.click(radio(/Meteen mijn eigen model/));
    openMore(container, 'order');
    const add = screen.getByRole('button', { name: 'Claude-account toevoegen' });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    const dialog = screen.getByRole('dialog', { name: 'Claude-account toevoegen' });
    fireEvent.change(within(dialog).getByLabelText('Naam van het account'), { target: { value: 'Privé' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volgende' }));
    await settle();
    expect(radio(/Meteen mijn eigen model/)).toBeChecked();
    expect(row(container, 'prive')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Opslaan/ })).toBeEnabled();
  });

  it('Test states: signed in, too soon (429), and the wait in minutes', async () => {
    setUiMode('uitgebreid');
    const { container } = renderSection();
    await settle();
    openMore(container, 'order');
    const werk = row(container, 'werk');
    fireEvent.click(within(werk).getByRole('button', { name: 'Werk testen' }));
    expect(within(werk).getByText('Bezig met testen…')).toBeInTheDocument();
    await settle();
    expect(within(werk).getByText(/^Ingelogd \(getest \d\d:\d\d\)$/)).toBeInTheDocument();
    gw.test = { status: 429, body: testResults.too_soon };
    fireEvent.click(within(werk).getByRole('button', { name: 'Werk testen' }));
    await settle();
    expect(within(werk).getByText('Testen kan weer over 4 min.')).toBeInTheDocument();
  });

  it('limit and login states from the status read', async () => {
    gw.status = { status: 200, body: statusExhausted };
    setUiMode('uitgebreid');
    const { container } = renderSection();
    await settle();
    openMore(container, 'order');
    expect(within(row(container, 'main')).getByText(/^Limiet bereikt, weer vrij om \d\d:\d\d$/)).toBeInTheDocument();
  });

  it('own model: Ollama down / no models / model not on this computer', async () => {
    gw.providers = [{ ...OLLAMA_UP, status_code: 'unreachable', state: 'unreachable' }];
    let view = renderSection();
    await settle();
    openMore(view.container, 'own');
    expect(screen.getByText('Ollama draait niet op deze computer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Opnieuw kijken' })).toBeInTheDocument();
    cleanup();

    gw.providers = [OLLAMA_UP];
    gw.models = [{ ...MODELS_OK[0], models: [] }];
    view = renderSection();
    await settle();
    openMore(view.container, 'own');
    expect(screen.getByText('Ollama heeft nog geen modellen. Download er eerst een in Ollama zelf.')).toBeInTheDocument();
    cleanup();

    gw.models = [{ ...MODELS_OK[0], models: [{ id: 'qwen2.5:0.5b' }] }];
    view = renderSection();
    await settle();
    openMore(view.container, 'own');
    expect(screen.getByText('Dit model staat nog niet op deze computer')).toBeInTheDocument();
    expect(screen.getByText('Dit model kan alleen antwoorden: geen bestanden bewerken of opdrachten uitvoeren.')).toBeInTheDocument();
  });

  it('choosing another model replaces the own-model entry and is saved with the rest', async () => {
    const { container } = renderSection();
    await settle();
    openMore(container, 'own');
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'qwen2.5:0.5b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    const body = posts()[0].body as { entries: { id: string; model?: string; label: string }[] };
    const own = body.entries.find((e) => e.id === 'ollama-llama31');
    expect(own).toMatchObject({ model: 'qwen2.5:0.5b', label: 'Ollama · qwen2.5:0.5b' });
  });

  it('Uitgebreid: the chain editor reorders with buttons and checks the threshold', async () => {
    setUiMode('uitgebreid');
    const { container } = renderSection();
    await settle();
    const order = () => Array.from(container.querySelectorAll('.fs-router__link-row')).map((node) => node.getAttribute('data-target'));
    expect(order()).toEqual(['main', 'werk', 'codex', 'ollama-llama31']);
    fireEvent.click(screen.getByRole('button', { name: 'Werk omhoog' }));
    expect(order()).toEqual(['werk', 'main', 'codex', 'ollama-llama31']);
    expect(screen.getByRole('button', { name: 'Werk omhoog' })).toBeDisabled();
    openMore(container, 'order');
    fireEvent.change(screen.getByLabelText('Wisselpunt voor Werk in procent'), { target: { value: '120' } });
    expect(screen.getByText('Kies een getal van 50 tot en met 99, of laat het leeg.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Opslaan' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Wisselpunt voor Werk in procent'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Opslaan' })).toBeEnabled();
  });

  it('Eenvoudig shows no chain editor, no number field and no port', async () => {
    const { container } = renderSection();
    await settle();
    expect(container.querySelector('.fs-router__chain')).toBeNull();
    expect(container.querySelector('input[type="number"]')).toBeNull();
    expect(container.textContent).not.toMatch(/poort|port\b/i);
  });

  it('400: the server errors are listed and a toast says it was not saved', async () => {
    gw.post = { status: 400, body: post400 };
    const { dispatch } = renderSection();
    await settle();
    chooseMode('model-first');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(screen.getByText('Zet eerst het wisselen tussen accounts aan.')).toBeInTheDocument();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'toast/push', toast: expect.objectContaining({ title: 'Niet opgeslagen: Kies een getal van 50 tot en met 99.' }) }),
    );
  });

  it('409: the newest version is loaded and the user is told', async () => {
    gw.post = { status: 409, body: { ok: false, error: 'stale_revision', config: { ...getDefault.config, revision: 9 } } };
    renderSection();
    await settle();
    chooseMode('model-first');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(screen.getByText('Dit is net ergens anders gewijzigd; de nieuwste versie is geladen.')).toBeInTheDocument();
    expect(modeSelect().value).toBe('off');
  });

  it('a config from a newer Forge is shown but never saved', async () => {
    const body = structuredClone(getStored) as { config: { entries: unknown[] } };
    body.config.entries.push({ id: 'later', kind: 'future-kind', label: 'Later', enabled: true });
    gw.get = { status: 200, body };
    renderSection();
    await settle();
    expect(screen.getByRole('note')).toHaveTextContent('nieuwere versie van Forge');
    expect(modeSelect()).toBeDisabled();
    cleanup();
    setUiMode('uitgebreid');
    renderSection();
    await settle();
    expect(radio(/Meteen mijn eigen model/)).toBeDisabled();
  });

  it('removing an extra account asks first and names the folder that stays', async () => {
    setUiMode('uitgebreid');
    const { container } = renderSection();
    await settle();
    openMore(container, 'order');
    fireEvent.click(within(row(container, 'werk')).getByRole('button', { name: 'Werk verwijderen' }));
    const dialog = screen.getByRole('dialog', { name: 'Werk verwijderen?' });
    expect(within(dialog).getByText(/De map ~\\\.forge-router\\profiles\\werk blijft staan/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verwijderen' }));
    expect(row(container, 'werk')).toBeNull();
    expect(screen.getByText('Je wijzigingen zijn nog niet opgeslagen.')).toBeInTheDocument();
  });
});

describe('Forge-router: "Account toevoegen › Claude" opens this dialog (router-events)', () => {
  it('a request from Je accounts opens the router\'s own add-account dialog while the section is mounted', async () => {
    const { canAddClaudeAccount, requestAddClaudeAccount } = await import('@/views/settings/sections/app-router/router-events');
    expect(canAddClaudeAccount()).toBe(false);
    renderSection();
    await settle();
    expect(canAddClaudeAccount()).toBe(true);
    act(() => requestAddClaudeAccount());
    expect(screen.getByRole('dialog', { name: 'Claude-account toevoegen' })).toBeInTheDocument();
    cleanup();
    expect(canAddClaudeAccount()).toBe(false);
  });
});
