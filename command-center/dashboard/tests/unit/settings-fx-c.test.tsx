/**
 * Instellingen fix round FX-C (redesign; DESIGN.md §1 rule 2, §3.4, §5, §6):
 *   - F10 / text budget: Eenvoudig shows the router as one select row; the multi-account terms and the own-model
 *     panel sit behind "Meer info", with a one-line summary that names the accounts and the consent box kept
 *     visible. Uitgebreid shows the options and "Volgorde"; thresholds and defaults sit behind "Meer info"
 *     (and open by themselves when one of them has an error).
 *     Fix round XR-SET: the consent row shows only for rotation and keeps one visible risk line that
 *     names the risk and the accounts above its box (more cases in settings-xr-set.test.tsx).
 *   - Instellingen › Gebruik reads the usage through `readUsageMeter`: a stale 5-hour value is never shown
 *     as current.
 *   - Security F1 (+ note 2): "Account toevoegen › Claude" only reaches the router while it is loaded and
 *     writable.
 *   - Security note 3: closing the Eigen API dialog during a save keeps it closed.
 *   - a closed "Start hier" card can be brought back from Algemeen.
 * Every visible-word count below uses the gate's rule (text nodes outside [hidden], option, aria-hidden and
 * visually hidden), so the budget is guarded in the unit suite too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import getStored from '../fixtures/app-router/get-stored.json';
import statusFixture from '../fixtures/app-router/status.json';
import post400 from '../fixtures/app-router/post-400.json';

import { setLocale, translate } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { setUiMode } from '@/state/ui-mode';
import { START_STORAGE_KEY } from '@/views/home/start-checklist';
import { LimitRow } from '@/views/settings/sections/AdvancedRows';
import { StartCardRow } from '@/views/settings/sections/GeneralRows';
import { AppRouterSection } from '@/views/settings/sections/app-router/AppRouterSection';
import { canAddClaudeAccount } from '@/views/settings/sections/app-router/router-events';
import { CustomApiSection } from '@/views/settings/sections/custom-api/CustomApiSection';

const nl = (key: string, vars?: Record<string, string | number>) => translate('nl', key as MessageKey, vars);

const OLLAMA_UP = { id: 'ollama-local', label: 'Ollama (this PC)', kind: 'local', local: true, status_code: 'connected', state: 'reachable' };
const MODELS_OK = [{ id: 'ollama-local', label: 'Ollama', status_code: 'connected', models: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5:0.5b' }], models_source: 'endpoint' }];

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

interface RouterGateway {
  get: Answer | 'down' | 'never';
  post: Answer;
}

function stubRouterGateway(): RouterGateway {
  const g: RouterGateway = { get: { status: 200, body: getStored }, post: { status: 200, body: { ok: true, config: { ...getStored.config, revision: 8 } } } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let answer: Answer = { status: 200, body: {} };
      if (url.includes('/api/app-router/status')) answer = { status: 200, body: statusFixture };
      else if (url.includes('/api/app-router')) {
        if (method === 'POST') answer = g.post;
        else if (g.get === 'down') throw new Error('connection refused');
        else if (g.get === 'never') return new Promise<Response>(() => undefined);
        else answer = g.get;
      } else if (url.includes('/api/providers')) answer = { status: 200, body: { ok: true, providers: [OLLAMA_UP] } };
      else if (url.includes('/api/models')) answer = { status: 200, body: { ok: true, providers: { pending: false, list: MODELS_OK } } };
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

function renderRouter() {
  const value: StoreValue = { state: state(), dispatch: vi.fn() };
  return render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(AppRouterSection))));
}

async function settle(ms = 20) {
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

const routerSection = (container: HTMLElement) => container.querySelector('section.fs-router') as HTMLElement;
const visible = (node: Element | null) => node !== null && node.closest('[hidden]') === null;
const moreInfoIn = (scope: HTMLElement) => within(scope).getByRole('button', { name: nl('rd.settings.moreInfo') });

beforeEach(() => {
  setLocale('nl');
  setUiMode('eenvoudig');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  setUiMode('eenvoudig');
  setLocale('en');
});

/* ------------------------------------------------------------------ F10 */

describe('F10 Eenvoudig: one select row; the terms and the own model behind "Meer info"', () => {
  it('rotation with two Claude accounts: the risk line naming them and the consent box stay visible; the 75-word notice does not', async () => {
    stubRouterGateway();
    const { container } = renderRouter();
    await settle();
    // Fix round XR-SET: the consent row belongs to rotation (DESIGN.md §3.4); the stored mode has none.
    expect(container.querySelector('[data-row="router-multi"]')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: nl('rd.settings.router.ask') }), { target: { value: 'claude-accounts' } });
    const section = routerSection(container);
    expect(within(section).queryByText(nl('appRouter.multi.warning'))).toBeNull();
    const consent = section.querySelector('[data-row="router-multi"]') as HTMLElement;
    expect(consent).toBeTruthy();
    // the risk is on screen before the box, not only behind "Meer info".
    const risk = consent.querySelector('.fs-router__consent-risk') as HTMLElement;
    expect(visible(risk)).toBe(true);
    expect(risk.textContent).toContain(nl('rd.settings.router.risk'));
    expect(risk.textContent).toContain('Hoofdaccount en Werk');
    expect(within(consent).getByRole('checkbox', { name: nl('appRouter.multi.ack') })).toBeInTheDocument();
    fireEvent.click(moreInfoIn(consent));
    expect(within(consent).getByText(nl('appRouter.multi.warning'))).toBeInTheDocument();
    expect(within(consent).getByRole('link', { name: 'Gebruiksbeleid' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('the account list behind the consent does not send you "below": the checkbox sits above it', async () => {
    stubRouterGateway();
    const { container } = renderRouter();
    await settle();
    fireEvent.change(screen.getByRole('combobox', { name: nl('rd.settings.router.ask') }), { target: { value: 'claude-accounts' } });
    const consent = routerSection(container).querySelector('[data-row="router-multi"]') as HTMLElement;
    fireEvent.click(moreInfoIn(consent));
    const werk = consent.querySelector('.fs-router__acct[data-target="werk"]') as HTMLElement;
    expect(within(werk).getByText(nl('appRouter.state.gated'))).toBeInTheDocument();
    // The old per-row reason (its key was deleted in as unused); the row shows only the state word.
    expect(within(werk).queryByText(/Forge gebruikt nu alleen het eerste Claude-account/)).toBeNull();
  });

  it('the own model is one row with the current choice; its panel opens behind "Meer info"', async () => {
    stubRouterGateway();
    const { container } = renderRouter();
    await settle();
    const section = routerSection(container);
    expect(within(section).queryByText(nl('appRouter.fallback.providerLabel'))).toBeNull();
    expect(within(section).queryByText(nl('appRouter.fallback.capability'))).toBeNull();
    const own = section.querySelector('[data-row="router-own"]') as HTMLElement;
    expect(within(own).getByText(nl('appRouter.fallback.heading'))).toBeInTheDocument();
    expect(within(own).getByText('Ollama · llama3.1')).toBeInTheDocument();
    fireEvent.click(moreInfoIn(own));
    expect(within(own).getByLabelText(nl('appRouter.fallback.providerLabel'))).toBeInTheDocument();
    expect(within(own).getByText(nl('appRouter.fallback.capability'))).toBeInTheDocument();
  });

  it('the own-model row says in one word when the service it runs on is not reachable, and nothing when it is', async () => {
    stubRouterGateway();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        let body: unknown = {};
        if (url.includes('/api/app-router/status')) body = statusFixture;
        else if (url.includes('/api/app-router')) body = getStored;
        else if (url.includes('/api/providers')) body = { ok: true, providers: [{ ...OLLAMA_UP, status_code: 'unreachable', state: 'unreachable' }] };
        else if (url.includes('/api/models')) body = { ok: true, providers: { pending: false, list: MODELS_OK } };
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );
    const { container } = renderRouter();
    await settle();
    const own = routerSection(container).querySelector('[data-row="router-own"]') as HTMLElement;
    expect(within(own).getByText(nl('settingsPage.accounts.status.unreachable'))).toBeInTheDocument();
    cleanup();
    stubRouterGateway();
    const second = renderRouter();
    await settle();
    const ownOk = routerSection(second.container).querySelector('[data-row="router-own"]') as HTMLElement;
    expect(within(ownOk).queryByText(nl('settingsPage.accounts.status.connected'))).toBeNull();
    expect(ownOk.querySelector('.fs-pill')).toBeNull();
  });

  it('stays within the 50-word section budget (DESIGN.md §5) with two Claude accounts and an own model', async () => {
    stubRouterGateway();
    const { container } = renderRouter();
    await settle();
    expect(visibleWords(routerSection(container))).toBeLessThanOrEqual(50);
  });

  it('a missing own model opens its panel by itself, so the choice that fixes it is on screen', async () => {
    const body = structuredClone(getStored) as { config: { entries: { id: string }[] } };
    body.config.entries = body.config.entries.filter((entry) => entry.id !== 'ollama-llama31');
    stubRouterGateway().get = { status: 200, body };
    const { container } = renderRouter();
    await settle();
    const own = routerSection(container).querySelector('[data-row="router-own"]') as HTMLElement;
    expect(visible(within(own).getByLabelText(nl('appRouter.fallback.providerLabel')))).toBe(true);
  });
});

describe('F10 Uitgebreid: the options and "Volgorde"; thresholds and defaults behind "Meer info"', () => {
  beforeEach(() => setUiMode('uitgebreid'));

  it('shows the four options and the order of the chain, not the threshold fields or the general values', async () => {
    stubRouterGateway();
    const { container } = renderRouter();
    await settle();
    const section = routerSection(container);
    expect(within(section).getAllByRole('radio')).toHaveLength(4);
    const order = Array.from(section.querySelectorAll('.fs-router__link-row')).map((row) => row.getAttribute('data-target'));
    expect(order).toEqual(['main', 'werk', 'codex', 'ollama-llama31']);
    expect(within(section).getByRole('button', { name: 'Werk omhoog' })).toBeInTheDocument();
    expect(within(section).queryByLabelText('Wisselpunt voor Werk in procent')).toBeNull();
    expect(within(section).queryByText(nl('appRouter.chain.cooldown'))).toBeNull();
    const chain = section.querySelector('.fs-router__chain') as HTMLElement;
    fireEvent.click(moreInfoIn(chain));
    expect(within(section).getByLabelText('Wisselpunt voor Werk in procent')).toBeInTheDocument();
    expect(within(section).getByText(nl('appRouter.chain.cooldown'))).toBeInTheDocument();
  });

  it('stays within the 90-word section budget with one Claude account', async () => {
    const body = structuredClone(getStored) as { config: { entries: { id: string }[] } };
    body.config.entries = body.config.entries.filter((entry) => entry.id !== 'werk');
    stubRouterGateway().get = { status: 200, body };
    const { container } = renderRouter();
    await settle();
    expect(visibleWords(routerSection(container))).toBeLessThanOrEqual(90);
  });

  it('a 400 on a threshold opens "Meer info" by itself, so the field with the error is on screen', async () => {
    const g = stubRouterGateway();
    g.post = { status: 400, body: post400 };
    const { container } = renderRouter();
    await settle();
    fireEvent.click(screen.getByRole('radio', { name: /Meteen mijn eigen model/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    const section = routerSection(container);
    const errorPath = (post400 as { errors: { path: string }[] }).errors.map((error) => error.path).find((path) => /threshold_pct/.test(path));
    expect(errorPath).toBeTruthy();
    const field = section.querySelector('.fs-router__chain input[type="number"]');
    expect(visible(field)).toBe(true);
  });
});

/* ------------------------------------------------------------------- F9 */

function stubUsage(guard: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('/api/usage') ? { ok: true, provenance: 'guard', guard: { available: true, mode: 'ok', ...guard } } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe('F9 Instellingen › Gebruik reads the limit through readUsageMeter', () => {
  it('a current reading shows both percentages', async () => {
    stubUsage({ watcher: 'running', session_pct: 80, week_pct: 40, session_reset_at: inHours(2), week_reset_at: inHours(48) });
    const { container } = render(createElement(LimitRow));
    await settle();
    const five = container.querySelector('[data-meter="five"]') as HTMLElement;
    expect(within(five).getByText(nl('settingsPage.rows.limiet.percent', { pct: 80 }))).toBeInTheDocument();
    expect(container.querySelector('[data-row="limiet"]')).toHaveAttribute('data-state', 'measured');
  });

  it('watcher down: the old 5-hour value is not shown as now, and the row says the reading is out of date', async () => {
    stubUsage({ watcher: 'not-running', session_pct: 80, week_pct: 40, session_reset_at: inHours(2), week_reset_at: inHours(48) });
    const { container } = render(createElement(LimitRow));
    await settle();
    const five = container.querySelector('[data-meter="five"]') as HTMLElement;
    expect(within(five).queryByText(nl('settingsPage.rows.limiet.percent', { pct: 80 }))).toBeNull();
    expect(within(five).queryByRole('meter')).toBeNull();
    expect(container.querySelector('[data-row="limiet"]')).toHaveAttribute('data-state', 'stale');
    expect(screen.getByText(nl('chat.usage.stale'))).toBeInTheDocument();
  });

  it('5-hour reset time passed: the old 5-hour value goes, the week value stays current', async () => {
    stubUsage({ watcher: 'running', session_pct: 80, week_pct: 40, session_reset_at: inHours(-1), week_reset_at: inHours(48) });
    const { container } = render(createElement(LimitRow));
    await settle();
    const five = container.querySelector('[data-meter="five"]') as HTMLElement;
    const week = container.querySelector('[data-meter="week"]') as HTMLElement;
    expect(within(five).queryByText(nl('settingsPage.rows.limiet.percent', { pct: 80 }))).toBeNull();
    expect(within(week).getByText(nl('settingsPage.rows.limiet.percent', { pct: 40 }))).toBeInTheDocument();
    expect(screen.getByText(nl('chat.usage.sessionRestarted'))).toBeInTheDocument();
    expect(screen.queryByText(nl('chat.usage.stale'))).toBeNull();
  });
});

/* ------------------------------------------------- Security F1 + note 2 */

describe('Security F1: "Account toevoegen › Claude" reaches the router only while it is loaded and writable', () => {
  it('not while the router is still loading', async () => {
    stubRouterGateway().get = 'never';
    renderRouter();
    await settle();
    expect(screen.getByText(nl('appRouter.loading'))).toBeInTheDocument();
    expect(canAddClaudeAccount()).toBe(false);
  });

  it('not while the router shows its load error', async () => {
    stubRouterGateway().get = 'down';
    renderRouter();
    await settle();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(canAddClaudeAccount()).toBe(false);
  });

  it('not while the saved file has entries this dashboard cannot read (read-only)', async () => {
    const body = structuredClone(getStored) as { config: { entries: unknown[] } };
    body.config.entries.push({ id: 'later', kind: 'future-kind', label: 'Later', enabled: true });
    stubRouterGateway().get = { status: 200, body };
    renderRouter();
    await settle();
    expect(screen.getByRole('note')).toHaveTextContent('nieuwere versie van Forge');
    expect(canAddClaudeAccount()).toBe(false);
  });

  it('yes once loaded and writable, and no longer after unmount', async () => {
    stubRouterGateway();
    renderRouter();
    await settle();
    expect(canAddClaudeAccount()).toBe(true);
    cleanup();
    expect(canAddClaudeAccount()).toBe(false);
  });
});

/* ---------------------------------------------------- Security note 3 */

describe('Security note 3: the Eigen API dialog closed during a save stays closed', () => {
  it('Escape while saving, then the save answers: no dialog comes back', async () => {
    let answerPost: (() => void) | null = null;
    const saved = {
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
    let stored: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/providers/custom') && method === 'POST') {
          return new Promise<Response>((resolve) => {
            answerPost = () => {
              stored = [saved];
              resolve({ ok: true, status: 201, json: async () => ({ ok: true, revision: 3, provider: saved }) } as Response);
            };
          });
        }
        const body = url.endsWith('/api/providers/custom') ? { ok: true, revision: 2, providers: stored } : {};
        return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
      }),
    );
    const onChanged = vi.fn();
    render(createElement(CustomApiSection, { providers: [], vaultKeys: [], onChanged }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: nl('customApi.add') }));
    const dialog = screen.getByRole('dialog', { name: nl('customApi.form.titleNew') });
    for (const [label, value] of [['Naam', 'Mijn vLLM'], ['Adres (base URL)', 'http://192.168.1.20:8000/v1']]) {
      const field = within(dialog).getByLabelText(label);
      fireEvent.change(field, { target: { value } });
      fireEvent.blur(field);
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(answerPost).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      answerPost?.();
    });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The save itself still counts: the list is read again and shows the new entry.
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText('Mijn vLLM')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------- F6 */

describe('F6 Algemeen: "Start hier opnieuw tonen" brings a closed card back', () => {
  function renderStartRow() {
    return render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/settings'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/settings', element: createElement(StartCardRow) }),
          createElement(Route, { path: '/', element: createElement('p', null, 'START-PAGE') }),
        ),
      ),
    );
  }

  it('shows nothing while the card is open (it would do nothing)', () => {
    const { container } = renderStartRow();
    expect(container.textContent).toBe('');
  });

  it('after the card was closed: one action that opens it again, keeps the proof step and goes to Start', () => {
    localStorage.setItem(START_STORAGE_KEY, JSON.stringify({ closed: true, proofSeen: true }));
    renderStartRow();
    fireEvent.click(screen.getByRole('button', { name: nl('rd.settings.general.startAgain') }));
    expect(JSON.parse(localStorage.getItem(START_STORAGE_KEY) ?? '{}')).toEqual({ closed: false, proofSeen: true });
    expect(screen.getByText('START-PAGE')).toBeInTheDocument();
  });
});
