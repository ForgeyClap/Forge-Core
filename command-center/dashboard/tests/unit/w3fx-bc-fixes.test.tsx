/**
 * Redesign, fix round W3FX-BC (UI Boss). One test per gate finding on the Uitgebreid screens Taken,
 * Controles, Bestanden, Automatiseringen, Vaardigheden & koppelingen, Discord and Plankaart:
 *
 *   1. Taken: a kanban card title never sits in a button wider than its card (was min-inline-size 16rem).
 *   2. Bestanden: the Recent chip row clips its own content (visually hidden spans included) and fades.
 *   3. Discord step 3: the token field has a visible border and the Connect button sits on the field's row.
 *   4. Discord step 4: no step is ticked done while its own text says it is still waiting.
 *   5. Page header: Automatiseringen and Vaardigheden use the same left-aligned header as the other
 *      Uitgebreid routes; Plankaart with no project still has its page title.
 *   6. Dutch first: the body copy of these screens reads Dutch under the Dutch locale.
 *
 * Layout cannot be measured in jsdom, so the CSS findings are pinned on the rule text; the screenshot loop
 * (`_scratch/redesign/w3fix/W3FX-BC/shots`) is the visual proof.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { EMPTY_DISCORD_SERVICE } from '@/prototype/state/gateway-discord';
import type { DiscordService } from '@/prototype/state/gateway-discord';
import type { Agent, FileNode, QualityGate, Task } from '@/prototype/types/prototype-types';
import { catalogTable } from './catalog-table';
import TasksView from '@/views/tasks/TasksView';
import TestsView from '@/views/tests/TestsView';
import FilesView from '@/views/files/FilesView';
import ConnectWizard from '@/views/discord/ConnectWizard';
import MindMapView, { MindMapWorkspace } from '@/views/mindmap/MindMapView';
import { AutomationsPanel } from '@/views/automations/AutomationsView';
import { SkillsPanel } from '@/views/skills/SkillsView';

const SRC = path.resolve(__dirname, '../../src');
const css = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration value of `prop` in rules whose selector list holds exactly `selector`, in file order. */
function declarations(sheet: string, selector: string, prop: string): string[] {
  const out: string[] = [];
  for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of match[2].split(';')) {
      const [name, ...rest] = decl.split(':');
      if (name?.trim() === prop) out.push(rest.join(':').trim());
    }
  }
  return out;
}

function baseState(overrides: Partial<PrototypeState['data']> = {}, extra: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, ...overrides },
    appearance: 'light',
    resolvedTheme: 'light',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: '',
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
    ...extra,
  } as PrototypeState;
}

function renderIn(state: PrototypeState, ui: ReturnType<typeof createElement>) {
  const value: StoreValue = { state, dispatch: () => undefined };
  return render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, ui)));
}

const TASK = {
  id: 'task-1',
  title: 'Build the hero and service menu section with a very long title',
  agentId: 'agent-1',
  workPackageId: 'wp-1',
  phase: 'build',
  column: 'running',
  status: 'running',
  progress: 40,
  dependencies: [],
  proofCount: 1,
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
  repairAttempts: 0,
  detail: 'detail',
} as unknown as Task;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale('en');
});

/* ------------------------------------------------------------------------------------- 1. Taken card */

describe('Taken: the card title button fits inside its card', () => {
  it('the card hit button has no fixed minimum width, wraps, and is capped at the card width', () => {
    const sheet = css('views/tasks/tasks.css');
    const min = declarations(sheet, '.fw-tasks-card__hit', 'min-inline-size');
    expect(min.at(-1)).toBe('0');
    expect(declarations(sheet, '.fw-tasks-card__hit', 'max-inline-size').at(-1)).toBe('100%');
    expect(declarations(sheet, '.fw-tasks-card__hit', 'overflow-wrap').at(-1)).toBe('anywhere');
  });
});

/* -------------------------------------------------------------------------------- 2. Bestanden chips */

describe('Bestanden: the Recent chip row never widens the page', () => {
  it('the scrolling list is the containing block for the visually hidden spans and fades at the end', () => {
    const sheet = css('views/files/files.css');
    expect(declarations(sheet, '.fw-files__recent-list', 'position').at(-1)).toBe('relative');
    expect(declarations(sheet, '.fw-files__recent-list', 'mask-image').at(-1) ?? '').toMatch(/linear-gradient/);
  });
});

describe('Controles: the proof table never widens the page at 960 px', () => {
  it('the table scroller is the containing block for the visually hidden caption and labels', () => {
    expect(declarations(css('views/tests/tests.css'), '.fw-proof__scroll', 'position').at(-1)).toBe('relative');
  });
});

/* ------------------------------------------------------------------------------------ 3/4. Discord */

const svc = (overrides: Partial<DiscordService>): DiscordService => ({ ...EMPTY_DISCORD_SERVICE, ...overrides });
const TOKEN = [{ name: 'DISCORD_BOT_TOKEN', present: true }];

describe('Discord step 3: a real input field with the button on its row', () => {
  it('the token input has a visible border', () => {
    const sheet = css('views/discord/connect-wizard.css');
    const border = declarations(sheet, '.fw-wizard__input', 'border').at(-1) ?? '';
    expect(border).toMatch(/1px solid var\(--fs-line-strong\)/);
  });

  it('the Connect button shares the input row, and the hint is announced for the input', () => {
    render(createElement(ConnectWizard, { service: svc({ envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: false }] }), onChanged: () => {} }));
    const input = document.querySelector('#fw-discord-token') as HTMLInputElement;
    const button = screen.getByRole('button', { name: 'Connect' });
    expect(button.parentElement).toBe(input.parentElement);
    const hintId = input.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId as string)?.textContent).toMatch(/never shown again/);
  });
});

describe('Discord step 4: a ticked step never says it is still waiting', () => {
  const cases: Array<[string, DiscordService]> = [
    ['older bot without setup_state', svc({ envKeys: TOKEN, running: true, transport: 'discord', setupState: null })],
    ['awaiting invite, no link yet', svc({ envKeys: TOKEN, setupState: 'awaiting-invite' })],
    ['no token', svc({ envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: false }] })],
  ];
  for (const [name, service] of cases) {
    it(name, () => {
      render(createElement(ConnectWizard, { service, onChanged: () => {} }));
      const done = Array.from(document.querySelectorAll('.fw-wizard__step--done'));
      expect(done.filter((step) => /waiting|wachten/i.test(step.textContent ?? '')).map((s) => s.textContent)).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------------------------ 5. Page header */

describe('Page header: the same left-aligned title as the other Uitgebreid routes', () => {
  beforeEach(() => setLocale('nl'));

  it('Automatiseringen and Vaardigheden mark their page as a full-width route page', () => {
    const { container: auto } = render(
      createElement(AutomationsPanel, {
        projectName: 'bakkerij',
        discord: { status: 'loading' },
        nightshift: { status: 'loading' },
        onOpenDiscord: () => {},
        onRetry: () => {},
      } as unknown as Parameters<typeof AutomationsPanel>[0]),
    );
    expect(auto.querySelector('.fw-xpage')).toHaveClass('fw-xpage--route');
    cleanup();
    const { container: skills } = render(
      createElement(SkillsPanel, {
        projectName: '',
        skills: { status: 'loading' },
        connections: { status: 'loading' },
        onRetryConnections: () => {},
      } as unknown as Parameters<typeof SkillsPanel>[0]),
    );
    expect(skills.querySelector('.fw-xpage')).toHaveClass('fw-xpage--route');
    // Both page branches of SkillsPanel (no project, and a project) carry the modifier.
    const source = fs.readFileSync(path.join(SRC, 'views/skills/SkillsView.tsx'), 'utf8');
    expect(source.match(/className="fw-xpage"/g)).toBeNull();
  });

  it('the route page header and body are not a centred column', () => {
    for (const file of ['views/automations/automations.css', 'views/skills/skills.css']) {
      const sheet = css(file);
      expect(declarations(sheet, '.fw-xpage--route .fw-xpage__header', 'margin-inline').at(-1), file).toBe('0');
      expect(declarations(sheet, '.fw-xpage--route .fw-xpage__body', 'margin-inline').at(-1), file).toBe('0');
    }
  });

  it('Plankaart with no active project still shows its page title', () => {
    renderIn(baseState(), createElement(MindMapView));
    expect(screen.getByRole('heading', { level: 1, name: 'Plankaart' })).toBeInTheDocument();
    expect(screen.getByText('Er is geen project actief.')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------------------- 6. Dutch */

describe('Dutch first: the body copy of the Uitgebreid screens', () => {
  beforeEach(() => setLocale('nl'));

  it('Taken: empty state, layout switch and board note', () => {
    const { unmount } = renderIn(baseState(), createElement(TasksView));
    expect(screen.getByText('Nog geen taken')).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).toBeNull();
    for (const label of ['Kanban', 'Tabel', 'Werkpakketten', 'Fasen']) expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    unmount();
    renderIn(baseState({ agents: [{ id: 'agent-1', name: 'Build Boss' } as unknown as Agent], tasks: [TASK] }), createElement(TasksView));
    expect(screen.getByText(/Dit bord toont de echte stand/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Bezig' })).toBeInTheDocument();
    expect(screen.queryByText(/This board mirrors/)).toBeNull();
  });

  it('Controles: toolbar, panel title, summary and column heads', () => {
    const gates = [
      { id: 'g1', name: 'Typecheck', status: 'completed', duration: '1s', lastRun: '2026-11-03T00:00:00.000Z', evidenceCount: 2, output: 'ok' },
      { id: 'g2', name: 'Lint', status: 'failed', duration: '1s', lastRun: '2026-11-03T00:00:00.000Z', evidenceCount: 1, output: 'x' },
    ] as unknown as QualityGate[];
    renderIn(baseState({ gates }), createElement(TestsView));
    expect(screen.getByRole('button', { name: 'Uitvoer openen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alles sluiten' })).toBeInTheDocument();
    expect(screen.getByText('Kwaliteitscontroles')).toBeInTheDocument();
    expect(screen.getByText('1 van 2 geslaagd · 1 mislukt · 3 bewijsstukken')).toBeInTheDocument();
    const heads = Array.from(document.querySelectorAll('.fw-gates__legend .fw-tests-label')).map((el) => el.textContent);
    expect(heads).toEqual(['Status', 'Controle', 'Duur', 'Laatst gedaan', 'Bewijs']);
    expect(screen.queryByText('Quality gates')).toBeNull();
  });

  it('Bestanden: change words and the no-selection state', () => {
    const files = [
      { id: 'f1', name: 'slots.ts', path: 'slots.ts', kind: 'file', changed: 'modified', updatedAt: '2026-11-03T00:00:00.000Z' },
      { id: 'f2', name: 'hero.css', path: 'hero.css', kind: 'file', changed: 'added', updatedAt: '2026-11-02T00:00:00.000Z' },
    ] as unknown as FileNode[];
    renderIn(baseState({ files }), createElement(FilesView));
    expect(screen.getByText('Geen bestand gekozen')).toBeInTheDocument();
    expect(screen.getAllByText('Gewijzigd').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nieuw').length).toBeGreaterThan(0);
    expect(screen.queryByText('No file selected')).toBeNull();
    expect(screen.queryByText('Modified')).toBeNull();
  });

  it('Discord: the wizard steps', () => {
    render(createElement(ConnectWizard, { service: svc({ envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: false }] }), onChanged: () => {} }));
    expect(screen.getByText('Discord koppelen')).toBeInTheDocument();
    expect(screen.getByText('Stap 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plak de sleutel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Koppelen' })).toBeInTheDocument();
    expect(screen.getByText('New Application')).toBeInTheDocument();
    expect(screen.queryByText(/Make the bot/)).toBeNull();
  });

  it('Plankaart: Dutch date and node count', async () => {
    const list = {
      ok: true, available: true, provenance: 'LIVE', unreadable: 0, truncated: false,
      maps: [{ id: 'mm', title: 'Plan', node_count: 8, edge_count: 7, generated_at: '2026-11-03T00:32:00.000Z' }],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).includes('&id=') ? { ok: false } : list) }) as Response));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    const nav = await screen.findByRole('navigation', { name: 'Plankaarten' });
    expect(within(nav).getByText('8 punten')).toBeInTheDocument();
    const when = new Date('2026-11-03T00:32:00.000Z').toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
    expect(within(nav).getByText(when)).toBeInTheDocument();
    expect(within(nav).queryByText(/Nov|AM|PM/)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------ the catalog copy itself */

describe('the catalog copy of the wave-3 Uitgebreid screens', () => {
  const { nl, en } = catalogTable('rd.files', 'rd.map', 'rd.tasks', 'rd.tests', 'rd.discord.wizard');
  const holders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort().join(',');

  it('has the same keys and placeholders in Dutch and English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(nl).sort());
    const bad = Object.keys(nl).filter((key) => holders(nl[key as keyof typeof nl]) !== holders(en[key as keyof typeof en]));
    expect(bad).toEqual([]);
  });

  it('keeps every Dutch string short, plain and without an exclamation mark', () => {
    const entries = Object.entries(nl);
    expect(entries.filter(([, v]) => v.trim().split(/\s+/).length > 16).map(([k]) => k)).toEqual([]);
    expect(entries.filter(([, v]) => v.includes('!')).map(([k]) => k)).toEqual([]);
    const banned = /(?<![\p{L}\d_-])(Boss|WP|run|token|evidence|gateway|effort|work package|the|and|with|your|you|this|for|to|not|yet|waiting|files|file|tasks|expand|collapse|show|layout)(?![\p{L}\d_-])/giu;
    const found = entries.flatMap(([k, v]) => [...v.replace(/\{\w+\}/g, ' ').matchAll(banned)].map((m) => `${k}: ${m[1]}`));
    expect(found).toEqual([]);
  });

  it('never makes a key both a text and a group', () => {
    const keys = Object.keys(nl);
    expect(keys.filter((key) => keys.some((other) => other.startsWith(`${key}.`)))).toEqual([]);
  });
});
