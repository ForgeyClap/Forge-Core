/**
 * WP B6 — Settings as one page (v1.0 redesign DESIGN.md §3.4). Renders the real SettingsView against a
 * stubbed gateway and checks, per mode, which groups and rows appear, that Eenvoudig has no port
 * anywhere, that none of the old wired:false sections survive, that the group list jumps to a group,
 * and that every row changes something real (theme, view, language, the per-project "Wat mag Forge
 * doen", alles wissen) — a test per row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { getLocale, setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { getUiMode, setUiMode } from '@/state/ui-mode';
import SettingsView from '@/views/settings/SettingsView';
import { modeStorageKey } from '@/views/chat/mode-storage';

const CHECKUP_ANSWER = {
  ok: true,
  checked_at: '2026-11-01T21:16:59.882Z',
  duration_ms: 1840,
  timed_out: false,
  claude: { found: true, version: '2.1.316', signedIn: true },
  codex: { found: false, version: null },
  ollama: { found: true, up: true, models: ['qwen2.5:0.5b'] },
  node: { version: '24.18.0' },
  git: { found: true, version: '2.54.0' },
  disk_free_gb: 202.1,
  port: 4100,
  writable_project_dir: null,
};

function stubGateway() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      let body: unknown = {};
      if (url.includes('/api/checkup')) body = CHECKUP_ANSWER;
      else if (url.includes('/api/health')) body = { ok: true, gateway: { project_root: 'C:\\Forge', data_dir: 'C:\\Forge\\data', port: 4100 } };
      else if (url.includes('/api/models')) body = { ok: true, roles: { lead: { model: 'sonnet', why: 'routes the work' } } };
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  return calls;
}

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
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
    ...overrides,
  };
}

function renderPage(dispatch = vi.fn()) {
  const value: StoreValue = { state: buildState(), dispatch };
  return render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(SettingsView))));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function groupHeadings(): string[] {
  return Array.from(document.querySelectorAll('.fs-set__group > h2')).map((heading) => heading.textContent ?? '');
}

/** "Acties voor <naam>": the `...` menu of an account row (v1.0 redesign). */
function openMenu(row: HTMLElement): HTMLElement {
  fireEvent.click(within(row).getByRole('button', { name: /^Acties voor / }));
  return within(row).getByRole('menu');
}

describe('Settings, one page (WP B6)', () => {
  beforeEach(() => {
    stubGateway();
    setLocale('nl');
    setUiMode('eenvoudig');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setUiMode('eenvoudig');
    setLocale('en');
  });

  it('Eenvoudig shows exactly Algemeen, Accounts, Veiligheid and Privacy, under one h1 and no search field', async () => {
    renderPage();
    await settle();
    expect(groupHeadings()).toEqual(['Algemeen', 'Accounts', 'Veiligheid', 'Privacy']);
    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Instellingen']);
    expect(screen.queryByRole('searchbox')).toBeNull();
    const toc = screen.getByRole('navigation', { name: 'Groepen' });
    expect(within(toc).getAllByRole('link').map((link) => link.textContent)).toEqual(['Algemeen', 'Accounts', 'Veiligheid', 'Privacy']);
  });

  it('Eenvoudig has no port field and no port anywhere, not even after a checkup', async () => {
    const { container } = renderPage();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Controleer of alles werkt' }));
    await settle();
    expect(container.textContent).not.toMatch(/poort|port\b|4100/i);
    expect(container.querySelector('input[type="number"]')).toBeNull();
    // The checkup did run and show its rows.
    expect(screen.getByText('Ingelogd bij Claude Code')).toBeInTheDocument();
  });

  it('none of the old wired:false sections (agents, skills, permissions, shortcuts) is rendered', async () => {
    const { container } = renderPage();
    await settle();
    setUiMode('uitgebreid');
    await settle();
    const text = container.textContent ?? '';
    for (const gone of ['Sneltoetsen', 'Rechten', 'Keyboard shortcuts', 'Permissions', 'ALLEEN WEERGAVE', 'Onderdelen van de instellingen']) {
      expect(text).not.toContain(gone);
    }
    expect(container.querySelector('.fw-settings')).toBeNull();
  });

  it('every visible row has a name; its "Wat merk je ervan" line sits behind "Meer info"', async () => {
    const { container } = renderPage();
    await settle();
    setUiMode('uitgebreid');
    await settle();
    const rows = Array.from(container.querySelectorAll('.fs-set__row'));
    expect(rows.length).toBeGreaterThan(10);
    // The router's "Wat doet Forge dan?" carries its one line as a visible sub-line instead.
    const explained = rows.filter((row) => row.getAttribute('data-row') !== 'router-mode');
    for (const row of explained) {
      const id = row.getAttribute('data-row') ?? '';
      expect(row.querySelector('.fs-set__name')?.textContent?.trim(), id).toBeTruthy();
      expect(row.querySelector('.fs-set__feel')?.textContent?.replace('Wat merk je ervan:', '').trim(), id).toBeTruthy();
    }
    const thema = container.querySelector('[data-row="thema"]') as HTMLElement;
    const more = within(thema).getByRole('button', { name: 'Meer info' });
    const feel = thema.querySelector('.fs-set__feel') as HTMLElement;
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(feel).not.toBeVisible();
    fireEvent.click(more);
    expect(within(thema).getByRole('button', { name: 'Minder info' })).toHaveAttribute('aria-expanded', 'true');
    expect(feel).toBeVisible();
  });

  it('Uitgebreid adds the six groups (and Eigen API as its own group after Accounts) and the port shows only there', async () => {
    renderPage();
    setUiMode('uitgebreid');
    await settle();
    expect(groupHeadings()).toEqual(['Algemeen', 'Accounts', 'Eigen API', 'Veiligheid', 'Privacy', 'Modellen', 'Gebruik', 'Koppelingen', 'Mappen', 'Diagnose', 'Over Forge']);
    expect(screen.getByText('Forge gebruikt poort 4100 op deze pc')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Minder beweging' })).toBeInTheDocument();
  });

  it('the group list scrolls to a group and marks it; Uitgebreid adds its groups under a hairline', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    renderPage();
    await settle();
    const toc = screen.getByRole('navigation', { name: 'Groepen' });
    expect(within(toc).getByRole('link', { name: 'Algemeen' })).toHaveAttribute('aria-current', 'true');
    fireEvent.click(within(toc).getByRole('link', { name: 'Privacy' }));
    expect(scrolled.mock.contexts.at(-1)).toBe(document.getElementById('fs-group-privacy'));
    expect(within(toc).getByRole('link', { name: 'Privacy' })).toHaveAttribute('aria-current', 'true');
    expect(within(toc).getByRole('link', { name: 'Algemeen' })).not.toHaveAttribute('aria-current');
    expect(toc.querySelector('hr')).toBeNull();
    act(() => setUiMode('uitgebreid'));
    await settle();
    expect(toc.querySelectorAll('hr')).toHaveLength(1);
    expect(toc.querySelector('hr + a')?.textContent).toBe('Modellen');
    scrolled.mockRestore();
  });

  it('a click in the group list keeps that group marked while the page settles; scrolling hands it back to the spy', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    renderPage();
    await settle();
    const toc = screen.getByRole('navigation', { name: 'Groepen' });
    const link = (name: string) => within(toc).getByRole('link', { name });
    const report = (ids: readonly string[]) =>
      act(() => {
        const entries = ids.map((id) => ({ target: document.getElementById(`fs-group-${id}`), isIntersecting: true }));
        callbacks.at(-1)?.(entries as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);
      });

    fireEvent.click(link('Veiligheid'));
    // Near the end of the page the tail of Accounts and the head of Veiligheid share the band.
    report(['accounts', 'veiligheid']);
    expect(link('Veiligheid')).toHaveAttribute('aria-current', 'true');

    // The person scrolls on: the spy decides again, the group at the top of the band wins.
    fireEvent.wheel(document.body);
    report(['accounts', 'veiligheid']);
    expect(link('Accounts')).toHaveAttribute('aria-current', 'true');
    scrolled.mockRestore();
  });

  it('the header switch changes the mode for the whole app, like Algemeen › Weergave', async () => {
    const { container } = renderPage();
    await settle();
    const head = container.querySelector('.fs-set__head') as HTMLElement;
    const switcher = within(head).getByRole('radiogroup', { name: 'Weergave' });
    expect(within(switcher).getByRole('radio', { name: 'Eenvoudig' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(switcher).getByRole('radio', { name: 'Uitgebreid' }));
    expect(getUiMode()).toBe('uitgebreid');
    await settle();
    // Ten groups in the list, plus Eigen API as its own group under Accounts (fix round XR-SET).
    expect(groupHeadings()).toHaveLength(11);
  });

  it('Accounts with the provider list (WP B2 part 2): Testen is enabled for a configured account, disabled with the reason otherwise', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: unknown) => {
        if (String(input).includes('/api/providers')) {
          const providers = [
            { id: 'claude-code-cli', label: 'Claude Code', subscription: true, state: 'signed-in', notice_required: true },
            { id: 'openai', label: 'OpenAI', key_env_name: 'OPENAI_API_KEY', key_source: 'env', state: 'configured' },
            { id: 'groq', label: 'Groq', key_env_name: 'GROQ_API_KEY', key_source: null, state: 'not-configured' },
          ];
          return { ok: true, status: 200, json: async () => ({ ok: true, providers }) } as Response;
        }
        return (base as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
      }),
    );
    const { container } = renderPage();
    await settle();
    const card = (id: string) => container.querySelector(`[data-provider="${id}"]`) as HTMLElement;
    expect(within(openMenu(card('openai'))).getByRole('menuitem', { name: 'Testen' })).not.toHaveAttribute('aria-disabled');
    expect(within(openMenu(card('claude-code-cli'))).getByRole('menuitem', { name: 'Testen' })).not.toHaveAttribute('aria-disabled');
    const groqTest = within(openMenu(card('groq'))).getByRole('menuitem', { name: 'Testen' });
    expect(groqTest).toHaveAttribute('aria-disabled', 'true');
    expect(document.getElementById(groqTest.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/eerst een sleutel/);
  });

  it('Accounts without the provider list: one word per account from the live checkup, no menu that cannot work, and why', async () => {
    const { container } = renderPage();
    await settle();
    const card = (id: string) => container.querySelector(`[data-provider="${id}"]`) as HTMLElement;
    expect(within(card('claude')).getByText('Verbonden')).toBeInTheDocument();
    expect(within(card('chatgpt')).getByText('Niet gevonden')).toBeInTheDocument();
    expect(within(card('ollama')).getByText('Draait')).toBeInTheDocument();
    expect(within(card('claude')).getByText(/Voorwaarden laatst gecontroleerd op 1 november 2026/)).toBeInTheDocument();
    expect(within(card('claude')).queryByRole('button', { name: /Testen|^Acties voor / })).toBeNull();
    expect(within(container.querySelector('.fs-set__accounts') as HTMLElement).getByText('Inloggen en testen doe je nog in het programma zelf.')).toBeInTheDocument();
  });

  it('Thema dispatches the real appearance change', async () => {
    const dispatch = vi.fn();
    renderPage(dispatch);
    await settle();
    fireEvent.click(screen.getByRole('radio', { name: 'Donker' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'appearance/set', appearance: 'dark' });
  });

  it('Weergave switches the app-wide view mode', async () => {
    const { container } = renderPage();
    await settle();
    const row = container.querySelector('[data-row="weergave"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('radio', { name: 'Uitgebreid' }));
    expect(getUiMode()).toBe('uitgebreid');
  });

  it('Taal switches the language of the whole app', async () => {
    renderPage();
    await settle();
    fireEvent.change(screen.getByRole('combobox', { name: 'Taal' }), { target: { value: 'en' } });
    expect(getLocale()).toBe('en');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
  });

  it('"Wat mag Forge doen" writes the composer’s own per-project choice', async () => {
    localStorage.removeItem(modeStorageKey('p1'));
    renderPage();
    await settle();
    // WP B3: an unchosen project starts at Mag aanpassen (never Volledige toegang); the row selects it.
    expect(screen.queryByText(/Nu gekozen in het invoerveld: Volledige toegang/)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Mag aanpassen' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Alleen plannen' }));
    expect(localStorage.getItem(modeStorageKey('p1'))).toBe('plan');
    fireEvent.click(screen.getByRole('radio', { name: 'Mag aanpassen' }));
    expect(localStorage.getItem(modeStorageKey('p1'))).toBe('accept-edits');
    localStorage.removeItem(modeStorageKey('p1'));
  });

  it('the safety locks never show a green tick they did not test', async () => {
    renderPage();
    await settle();
    expect(screen.getByText('Nog niet getest vanuit de app')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nu testen' })).toBeDisabled();
  });

  it('Exporteren is grey with its reason; Alles wissen asks first and then wipes forge.* only', async () => {
    renderPage();
    await settle();
    expect(screen.getByRole('button', { name: 'Alles exporteren' })).toBeDisabled();
    localStorage.setItem('forge.prototype.chatEffort', 'high');
    localStorage.setItem('not-forge', 'stay');
    fireEvent.click(screen.getByRole('button', { name: 'Alles wissen' }));
    const dialog = screen.getByRole('dialog', { name: 'Alles wissen?' });
    expect(localStorage.getItem('forge.prototype.chatEffort')).toBe('high');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ja, alles wissen' }));
    expect(localStorage.getItem('forge.prototype.chatEffort')).toBeNull();
    expect(localStorage.getItem('not-forge')).toBe('stay');
    localStorage.removeItem('not-forge');
  });

  it('Wat staat waar names the real data folder from the gateway', async () => {
    renderPage();
    await settle();
    expect(screen.getByText('Map: C:\\Forge\\data')).toBeInTheDocument();
  });

  it('desktop-only rows appear only when the app offers them', async () => {
    renderPage();
    await settle();
    expect(screen.queryByRole('switch', { name: 'Opstarten met Windows' })).toBeNull();
    cleanup();
    const set = vi.fn(async (on: boolean) => on);
    vi.stubGlobal('forge', { autostart: { get: async () => false, set }, tray: { get: async () => true, set } });
    renderPage();
    await settle();
    const autostart = screen.getByRole('switch', { name: 'Opstarten met Windows' });
    fireEvent.click(autostart);
    await settle();
    expect(set).toHaveBeenCalledWith(true);
    expect(autostart).toHaveAttribute('aria-checked', 'true');
  });
});
