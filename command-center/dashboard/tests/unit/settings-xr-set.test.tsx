/**
 * Fix round XR-SET (owner-approved extra round): Instellingen › Accounts.
 *   - R1 (HIGH): the multi-account consent could be ticked without the risk ever being on
 *     screen, because the warning sat inside "Meer info". Now one plain risk line stays visible ABOVE the
 *     checkbox; it names the risk (Anthropic can stop your access) and the accounts it covers. The long
 *     warning, the three clause links and the date stay behind "Meer info" (APP-ROUTER-DESIGN D6, §5.3).
 *   - The consent row appears only when Claude-account rotation is the chosen mode (DESIGN.md §3.4). The one
 *     exception: switching is already on in another mode, so the row stays to show the risk and to switch it off.
 *   - Text budget (DESIGN.md §5): the whole Accounts group (account list + router) <= 50 words in Eenvoudig and
 *     <= 90 in Uitgebreid in the gate's world (the stored fixture: Claude first, then the own model, two Claude
 *     accounts). Eigen API is its own group in Uitgebreid (DESIGN.md §3.4), outside the Accounts group, and
 *     still refreshes after a save through "Account toevoegen".
 * The new copy keys go through the locale patch; the tests compare with `translate('nl', key)` so they hold
 * before and after the merge (before it, the key path renders).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import getStored from '../fixtures/app-router/get-stored.json';
import statusFixture from '../fixtures/app-router/status.json';

import { setLocale, translate } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setUiMode } from '@/state/ui-mode';
import SettingsView from '@/views/settings/SettingsView';

const nl = (key: string, vars?: Record<string, string | number>) => translate('nl', key as MessageKey, vars);

const PROVIDERS = [
  { id: 'claude-code-cli', label: 'Claude Code', kind: 'subscription', status_code: 'connected', state: 'signed-in', tos: { required: true, checked_on: '2026-11-01' } },
  { id: 'codex-cli', label: 'Codex', kind: 'subscription', status_code: 'connected', state: 'signed-in', tos: { required: true, checked_on: '2026-11-01' } },
  { id: 'ollama-local', label: 'Ollama (this PC)', kind: 'local', local: true, status_code: 'not-connected', state: 'unreachable' },
];
const CUSTOM = {
  id: 'custom-mijn-vllm',
  label: 'Mijn vLLM-server',
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
const CHECKUP = {
  ok: true,
  checked_at: '2026-11-03T09:00:00.000Z',
  duration_ms: 1840,
  timed_out: false,
  claude: { found: true, version: '2.1.316', signedIn: true },
  codex: { found: true, version: '0.80.0' },
  ollama: { found: true, up: false, models: [] },
  node: { version: '24.18.0' },
  git: { found: true, version: '2.54.0' },
  disk_free_gb: 202.1,
  port: 4100,
  writable_project_dir: null,
};

interface World {
  mode?: string;
  multiOn?: boolean;
  custom: unknown[];
}

function stubGateway(world: Partial<World> = {}): World {
  const w: World = { custom: [CUSTOM], ...world };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let status = 200;
      let body: unknown = { ok: true };
      if (url.includes('/api/app-router/status')) body = statusFixture;
      else if (url.includes('/api/app-router')) {
        const stored = structuredClone(getStored) as { config: { mode: string; multi_account: unknown } };
        if (w.mode) stored.config.mode = w.mode;
        if (w.multiOn) stored.config.multi_account = { enabled: true, acknowledged_at: '2026-11-02T10:00:00.000Z' };
        body = stored;
      } else if (url.endsWith('/api/providers/custom') && method === 'POST') {
        const sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { provider?: { label?: string; baseURL?: string } };
        const saved = { ...CUSTOM, id: 'custom-tweede', label: sent.provider?.label ?? '?', baseURL: sent.provider?.baseURL ?? CUSTOM.baseURL };
        w.custom = [...w.custom, saved];
        status = 201;
        body = { ok: true, revision: 3, provider: saved };
      } else if (url.endsWith('/api/providers/custom')) body = { ok: true, revision: 2, providers: w.custom };
      else if (url.includes('/api/providers')) body = { ok: true, providers: PROVIDERS };
      else if (url.includes('/api/checkup')) body = CHECKUP;
      else if (url.includes('/api/health')) body = { ok: true, gateway: { project_root: 'C:\\Forge', data_dir: 'C:\\Forge\\data', port: 4100 } };
      else if (url.includes('/api/models')) body = { ok: true, roles: { lead: { model: 'sonnet', why: 'routes the work' } }, providers: { pending: false, list: [] } };
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
  return w;
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

function renderPage() {
  const value: StoreValue = { state: state(), dispatch: vi.fn() };
  return render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(SettingsView))));
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Visible words by the gate's rule: no [hidden] region, no option text, nothing aria-hidden or visually hidden. */
function visibleWords(root: Element): number {
  const parts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (!parent || parent.closest('[hidden], option, script, style, [aria-hidden="true"], .fw-visually-hidden')) continue;
    parts.push(walker.currentNode.textContent ?? '');
  }
  return (parts.join(' ').match(/[\p{L}\d][\p{L}\d'’.:-]*/gu) ?? []).length;
}

const group = (container: HTMLElement, id: string) => container.querySelector(`section.fs-set__group[data-group="${id}"]`) as HTMLElement | null;
const consentRow = (container: HTMLElement) => container.querySelector('[data-row="router-multi"]') as HTMLElement | null;
const ackName = () => nl('appRouter.multi.ack');

/** The visible risk line of the consent row: not inside a closed region and not inside "Meer info". */
function riskLine(consent: HTMLElement): HTMLElement {
  const line = within(consent).getByText((_, node) => node !== null && node.classList.contains('fs-router__consent-risk'));
  expect(line.closest('[hidden]')).toBeNull();
  expect(line.closest('.fw-disclosure__panel')).toBeNull();
  return line;
}

beforeEach(() => {
  setLocale('nl');
  setUiMode('eenvoudig');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  setUiMode('eenvoudig');
  setLocale('en');
});

/* ------------------------------------------------------------------- R1 */

describe('R1: the consent shows its risk before the box can be ticked', () => {
  for (const uiMode of ['eenvoudig', 'uitgebreid'] as const) {
    it(`${uiMode}: one visible risk line above the checkbox names the risk and both accounts; the long text waits behind "Meer info"`, async () => {
      setUiMode(uiMode);
      stubGateway({ mode: 'claude-accounts' });
      const { container } = renderPage();
      await settle();
      const consent = consentRow(container) as HTMLElement;
      expect(consent).toBeTruthy();
      const line = riskLine(consent);
      expect(line.textContent).toContain(nl('rd.settings.router.risk'));
      expect(line.textContent).toContain(nl('rd.settings.router.covers'));
      expect(line.textContent).toContain('Hoofdaccount en Werk');
      const box = within(consent).getByRole('checkbox', { name: ackName() });
      // The line comes first in reading order, so it is read (and seen) before the box.
      expect(line.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(box.closest('.fw-disclosure__panel')).toBeNull();
      // The full warning and the links stay one click away.
      expect(within(consent).queryByText(nl('appRouter.multi.warning'))).toBeNull();
      fireEvent.click(within(consent).getByRole('button', { name: nl('rd.settings.moreInfo') }));
      expect(within(consent).getByText(nl('appRouter.multi.warning'))).toBeInTheDocument();
      expect(within(consent).getByRole('link', { name: 'Gebruiksbeleid' })).toHaveAttribute('rel', 'noopener noreferrer');
      // The risk line stays on screen while "Meer info" is open.
      expect(riskLine(consent)).toBe(line);
    });
  }

  it('the risk line is the description of the consent group, for screen readers too', async () => {
    stubGateway({ mode: 'claude-accounts' });
    const { container } = renderPage();
    await settle();
    const consent = consentRow(container) as HTMLElement;
    const line = riskLine(consent);
    expect(consent).toHaveAttribute('role', 'group');
    expect(consent.getAttribute('aria-describedby')).toBe(line.id);
    expect(consent).toHaveAccessibleName(nl('appRouter.multi.title'));
  });
});

/* ---------------------------------------------------- consent placement */

describe('the consent row appears only when Claude-account rotation is chosen (DESIGN.md §3.4)', () => {
  for (const uiMode of ['eenvoudig', 'uitgebreid'] as const) {
    it(`${uiMode}: not in "Claude eerst, dan mijn eigen model" with two Claude accounts and switching off`, async () => {
      setUiMode(uiMode);
      stubGateway();
      const { container } = renderPage();
      await settle();
      expect(container.querySelector('section.fs-router')).toBeTruthy();
      expect(consentRow(container)).toBeNull();
      expect(screen.queryByRole('checkbox', { name: ackName() })).toBeNull();
    });
  }

  it('Eenvoudig: choosing "Wisselen tussen mijn Claude-accounts" brings it in, choosing another mode takes it away', async () => {
    stubGateway();
    const { container } = renderPage();
    await settle();
    const select = screen.getByRole('combobox', { name: nl('rd.settings.router.ask') });
    fireEvent.change(select, { target: { value: 'claude-accounts' } });
    expect(riskLine(consentRow(container) as HTMLElement)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'model-first' } });
    expect(consentRow(container)).toBeNull();
  });

  it('switching already on in another mode: the row stays, ticked, so the risk is shown and it can be switched off', async () => {
    stubGateway({ multiOn: true });
    const { container } = renderPage();
    await settle();
    const consent = consentRow(container) as HTMLElement;
    expect(consent).toBeTruthy();
    riskLine(consent);
    const box = within(consent).getByRole('checkbox', { name: ackName() });
    expect(box).toBeChecked();
    fireEvent.click(box);
    // The row does not vanish under the pointer: it stays (unticked, can be ticked again) until the change is saved.
    const after = consentRow(container) as HTMLElement;
    expect(after).toBeTruthy();
    expect(within(after).getByRole('checkbox', { name: ackName() })).not.toBeChecked();
    expect(screen.getByRole('button', { name: nl('appRouter.save.save') })).toBeEnabled();
  });
});

/* ------------------------------------------------- Eigen API, own group */

describe('Eigen API is its own group in Uitgebreid (DESIGN.md §3.4)', () => {
  it('Uitgebreid: outside the Accounts group, right after it, with its own heading; the section list stays as it was', async () => {
    setUiMode('uitgebreid');
    stubGateway();
    const { container } = renderPage();
    await settle();
    const accounts = group(container, 'accounts') as HTMLElement;
    const own = group(container, 'eigenapi') as HTMLElement;
    expect(own).toBeTruthy();
    expect(within(accounts).queryByText('Mijn vLLM-server')).toBeNull();
    expect(within(accounts).queryByRole('button', { name: nl('customApi.add') })).toBeNull();
    expect(within(own).getByRole('heading', { level: 2, name: nl('rd.settings.ownApi.title') })).toBeInTheDocument();
    expect(within(own).getAllByRole('heading', { name: nl('rd.settings.ownApi.title') })).toHaveLength(1);
    expect(within(own).getByText('Mijn vLLM-server')).toBeInTheDocument();
    expect(within(own).getByRole('button', { name: nl('customApi.add') })).toBeInTheDocument();
    expect(accounts.nextElementSibling).toBe(own);
    const toc = screen.getByRole('navigation', { name: nl('settingsPage.groupsLabel') });
    expect(within(toc).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Algemeen',
      'Accounts',
      'Veiligheid',
      'Privacy',
      'Modellen',
      'Gebruik',
      'Koppelingen',
      'Mappen',
      'Diagnose',
      'Over Forge',
    ]);
    // Every listed group has its section; Eigen API is the one extra (the merge note for no-prototype-copy uses this).
    expect(container.querySelectorAll('section.fs-set__group:not([data-group="eigenapi"])')).toHaveLength(10);
    expect(container.querySelectorAll('section.fs-set__group[data-group="eigenapi"]')).toHaveLength(1);
  });

  it('Eenvoudig: no Eigen API group (the way in is "Account toevoegen")', async () => {
    stubGateway();
    const { container } = renderPage();
    await settle();
    expect(group(container, 'eigenapi')).toBeNull();
    expect(screen.queryByText('Mijn vLLM-server')).toBeNull();
  });

  it('while Eigen API is in view, the section list marks Accounts', async () => {
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
    setUiMode('uitgebreid');
    stubGateway();
    renderPage();
    await settle();
    act(() => {
      const entries = [{ target: document.getElementById('fs-group-eigenapi'), isIntersecting: true }];
      callbacks.at(-1)?.(entries as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);
    });
    const toc = screen.getByRole('navigation', { name: nl('settingsPage.groupsLabel') });
    expect(within(toc).getByRole('link', { name: 'Accounts' })).toHaveAttribute('aria-current', 'true');
  });

  it('an entry saved through "Account toevoegen" shows up in the Eigen API group without a reload', async () => {
    setUiMode('uitgebreid');
    stubGateway();
    const { container } = renderPage();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: nl('rd.settings.accounts.add') }));
    const chooser = screen.getByRole('dialog', { name: nl('rd.settings.accounts.addTitle') });
    fireEvent.click(within(chooser).getByRole('radio', { name: /Eigen sleutel of server/ }));
    fireEvent.click(within(chooser).getByRole('button', { name: 'Verder' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Eigen sleutel of server' });
    for (const [label, value] of [
      ['Naam', 'Tweede server'],
      ['Adres (base URL)', 'http://192.168.1.30:8000/v1'],
    ] as const) {
      const field = within(dialog).getByLabelText(label);
      fireEvent.change(field, { target: { value } });
      fireEvent.blur(field);
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(within(group(container, 'eigenapi') as HTMLElement).getByText('Tweede server')).toBeInTheDocument();
  });
});

/* ---------------------------------------------------------- text budget */

describe('text budget of the whole Accounts group (DESIGN.md §5), in the gate world', () => {
  it('Eenvoudig: at most 50 words (account list + router)', async () => {
    stubGateway();
    const { container } = renderPage();
    await settle();
    expect(visibleWords(group(container, 'accounts') as HTMLElement)).toBeLessThanOrEqual(50);
  });

  // Recorded deviation (D6 outranks the budget): with rotation chosen and the box ticked, the consent row (risk line,
  // box, "Meer info": 27 words with the new copy) puts the group over. Pinned at the measured size so it cannot grow.
  it('rotation, ticked (D6 deviation): Eenvoudig at most 69 and Uitgebreid at most 95 words, the consent row included', async () => {
    stubGateway({ mode: 'claude-accounts', multiOn: true });
    const simple = renderPage();
    await settle();
    const simpleWords = visibleWords(group(simple.container, 'accounts') as HTMLElement);
    cleanup();
    setUiMode('uitgebreid');
    const advanced = renderPage();
    await settle();
    const advancedWords = visibleWords(group(advanced.container, 'accounts') as HTMLElement);
    // Before the locale merge the new keys render as one-word key paths, so the counts are lower then.
    expect(simpleWords).toBeLessThanOrEqual(69);
    expect(advancedWords).toBeLessThanOrEqual(95);
  });

  it('Uitgebreid: at most 90 words (account list + router; Eigen API is its own group)', async () => {
    setUiMode('uitgebreid');
    stubGateway();
    const { container } = renderPage();
    await settle();
    expect(visibleWords(group(container, 'accounts') as HTMLElement)).toBeLessThanOrEqual(90);
  });
});
