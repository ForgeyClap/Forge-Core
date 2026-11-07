/**
 * Fix round XR-COPY2 — the second click is Dutch too.
 *
 * The review found English one interaction past each first screen: the Plankaart node panel and
 * map-level states, the Bestanden preview states, the Details pane labels and raw values, and every
 * StatusBadge word. These tests render each of those in Dutch and fail on the English that was there; they
 * also check that the English locale still reads the old English, and that the pending copy tables follow
 * the merge rules (same keys and placeholders, short plain Dutch, no key that is both a text and a group).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import nlCatalog from '@/i18n/locales/nl.json';
import { StatusBadge } from '@/components/primitives';
import { statusPresentation } from '@/components/primitives/status-presentation';
import Inspector from '@/components/shell/Inspector';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { FIXTURE_DATASET } from '@/prototype/fixtures';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { FilesActionsContext } from '@/prototype/state/gateway-files';
import type { FilesController, GatewayFilePreview } from '@/prototype/state/gateway-files';
import type { FileNode, Project, StatusKey } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';
import FilesView from '@/views/files/FilesView';
import { MindMapWorkspace } from '@/views/mindmap/MindMapView';
import { catalogTable } from './catalog-table';

function baseState(overrides: Partial<PrototypeState> = {}, data: Partial<PrototypeState['data']> = {}): PrototypeState {
  return {
    data: { ...FIXTURE_DATASET, ...data },
    appearance: 'light',
    resolvedTheme: 'light',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: true,
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
    ...overrides,
  } as PrototypeState;
}

function renderWith(state: PrototypeState, ui: ReturnType<typeof createElement>, files?: FilesController) {
  const value: StoreValue = { state, dispatch: () => undefined };
  let tree: ReactElement = createElement(PrototypeContext.Provider, { value }, ui);
  if (files) tree = createElement(FilesActionsContext.Provider, { value: files }, tree);
  return render(createElement(MemoryRouter, null, tree));
}

/** Visible text plus accessible names and tooltips. */
function copyOf(root: HTMLElement): string {
  const names = Array.from(root.querySelectorAll('[aria-label], [title]')).map(
    (el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`,
  );
  return `${root.textContent ?? ''} ${names.join(' ')}`;
}

beforeEach(() => setLocale('nl'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
  setLocale('en');
});

/* ----------------------------------------------------------------------------- StatusBadge */

const DUTCH_WORDS: Readonly<Record<StatusKey, string>> = {
  running: 'Bezig',
  completed: 'Klaar',
  waiting: 'Wacht',
  verify: 'Controle',
  review: 'Keuring',
  failed: 'Mislukt',
  idle: 'Rustig',
  blocked: 'Staat vast',
};

describe('StatusBadge speaks Dutch through the shared primitive', () => {
  it('shows a Dutch word and a Dutch sentence for every status', () => {
    for (const [status, word] of Object.entries(DUTCH_WORDS) as [StatusKey, string][]) {
      const { container, unmount } = render(createElement(StatusBadge, { status }));
      const badge = container.querySelector('.fw-status-badge') as HTMLElement;
      expect(badge.querySelector('.fw-status-badge__label')?.textContent, status).toBe(word);
      expect(badge.getAttribute('title'), status).toMatch(new RegExp(`^${word}: `));
      expect(badge.textContent, status).not.toMatch(/running|waiting|completed|idle|blocked|failed|review|verify/i);
      unmount();
    }
  });

  it('follows a language switch and keeps the English locale English', () => {
    const { container } = render(createElement(StatusBadge, { status: 'running' }));
    expect(container.textContent).toContain('Bezig');
    setLocale('en');
    expect(statusPresentation('running').label).toBe('RUNNING');
    expect(statusPresentation('waiting', 'en').description).toMatch(/queued behind an earlier step/);
  });

  it('a context label still wins', () => {
    render(createElement(StatusBadge, { status: 'idle', label: 'Gepland', description: 'Gepland: nog niet begonnen.' }));
    expect(screen.getByText('Gepland')).toBeInTheDocument();
  });
});

/* ----------------------------------------------------------------------------- Details pane */

const ENGLISH_LABELS =
  /\b(Owner|Package|Phase|Column|Created|Updated|Repairs|Dependencies|Proof|Work package|Summary|Tasks|Progress|Group|Permission|Effort|Runtime|Verification|Last activity|Current task|Skills|min ago|hr ago|backlog|build|Nothing blocks)\b/;

describe('Details pane: labels, raw values and times in Dutch', () => {
  it('a queued task: Dutch labels, Dutch phase and column, and the same status word as its card', () => {
    const { container } = renderWith(baseState({ selection: { kind: 'task', id: 'task-09' } }), createElement(Inspector, { embedded: true }));
    const pane = container.querySelector('.fw-inspector') as HTMLElement;
    const text = copyOf(pane);
    for (const label of ['Eigenaar', 'Pakket', 'Fase', 'Kolom', 'Gemaakt', 'Bijgewerkt', 'Herstelpogingen', 'Hangt af van', 'Bewijs', 'Werkpakket']) {
      expect(text, label).toContain(label);
    }
    expect(within(pane).getAllByText('Bouwen').length).toBeGreaterThan(0);
    expect(within(pane).getByText('Nog te doen')).toBeInTheDocument();
    expect(pane.querySelector('.fw-inspector__head .fw-status-badge__label')?.textContent).toBe('Wacht');
    expect(text).not.toMatch(/Wacht op jou|WACHT OP JOU|wacht op jouw antwoord/i);
    expect(pane.textContent).not.toMatch(ENGLISH_LABELS);
  });

  it('a helper: Dutch labels and values, relative time in Dutch', () => {
    const agent = FIXTURE_DATASET.agents.find((a) => a.id === 'agent-ui-boss');
    expect(agent).toBeDefined();
    const { container } = renderWith(baseState({ selection: { kind: 'agent', id: 'agent-ui-boss' } }), createElement(Inspector, { embedded: true }));
    const pane = container.querySelector('.fw-inspector') as HTMLElement;
    for (const label of ['Groep', 'Rechten', 'Denkniveau', 'Controle', 'Laatst actief', 'Samenvatting', 'Vaardigheden']) {
      expect(pane.textContent, label).toContain(label);
    }
    expect(pane.textContent).toContain('Uitvoering');
    expect(pane.textContent).toContain('Hoog');
    expect(pane.textContent).toMatch(/\d+ min geleden/);
    expect(pane.textContent).not.toMatch(ENGLISH_LABELS);
  });

  it('a project with "4 min ago" in the example data shows "4 min geleden"', () => {
    const project = { ...FIXTURE_DATASET.projects[0], lastActivity: '4 min ago' } as Project;
    const { container } = renderWith(
      baseState({ selection: { kind: 'project', id: project.id } }, { projects: [project, ...FIXTURE_DATASET.projects.slice(1)] }),
      createElement(Inspector, { embedded: true }),
    );
    expect(container.textContent).toContain('4 min geleden');
    expect(container.textContent).not.toContain('min ago');
  });

  it('English keeps the English labels', () => {
    setLocale('en');
    const { container } = renderWith(baseState({ selection: { kind: 'task', id: 'task-09' } }), createElement(Inspector, { embedded: true }));
    expect(container.textContent).toContain('Owner');
    expect(container.textContent).toContain('Dependencies');
  });
});

/* ----------------------------------------------------------------------------- Plankaart */

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number, body: unknown): Response => ({ ok: false, status, json: async () => body }) as Response;

const GENERATED = '2026-11-03T08:15:00.000Z';
const ONE_BRANCH_LIST = {
  ok: true, available: true, provenance: 'LIVE', unreadable: 1, truncated: false,
  maps: [{ id: 'mm', title: 'Plan', node_count: 3, edge_count: 2, generated_at: GENERATED }],
};
const ONE_BRANCH_MAP = {
  ok: true,
  map: {
    map_id: 'mm', title: 'Plan', generated_at: GENERATED,
    nodes: [
      { id: 'r', label: 'Plan', kind: 'root', parent: null },
      { id: 'a', label: 'Bouwen', kind: 'branch', parent: 'r' },
      { id: 'a1', label: 'Hero maken', kind: 'leaf', parent: 'a' },
    ],
    edges: [{ from: 'r', to: 'a' }, { from: 'a', to: 'a1' }],
  },
};

function routeMaps(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => handler(String(url))));
}

const ENGLISH_MAP =
  /Selected node|Children ·|No children|Close the node details|Loading the map|could not be opened|Try again|not read|has no nodes|map file\(s\)|Zoom in|Zoom out|Fit the whole map|Arrow keys|Path from the root|\b(root|branch|leaf)\b/;

describe('Plankaart: the node panel, the map states and the counts in Dutch', () => {
  it('node panel, zoom labels and the one-branch counts', async () => {
    routeMaps((url) => (url.includes('&id=') ? ok(ONE_BRANCH_MAP) : ok(ONE_BRANCH_LIST)));
    const { container } = render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    const branch = await screen.findByRole('button', { name: 'Bouwen' });
    fireEvent.click(branch);
    const detail = screen.getByRole('region', { name: 'Gekozen punt' });
    expect(within(detail).getByText('Gekozen punt · tak')).toBeInTheDocument();
    expect(within(detail).getByText('Onder dit punt · 1')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Details van dit punt sluiten' })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Hero maken' }));
    expect(await screen.findByText('Niets onder dit punt')).toBeInTheDocument();

    const zoom = screen.getByRole('toolbar', { name: 'Zoomen' });
    for (const name of ['Uitzoomen', 'Inzoomen', 'Hele kaart tonen']) expect(within(zoom).getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /^Plankaart: Plan\. Pijltjes schuiven/ })).toBeInTheDocument();

    const stats = container.querySelector('.fw-mm__stats') as HTMLElement;
    expect(stats.textContent).toMatch(/^1 tak · \d+ (niveau|niveaus)$/);
    expect(stats.textContent).not.toMatch(/1 takken|1 niveaus|punten/);
    expect(screen.getByText('1 kaartbestand kon niet worden gelezen en staat er niet bij.')).toBeInTheDocument();
    expect(copyOf(container)).not.toMatch(ENGLISH_MAP);
  });

  it('the header shows the date and the point count once each', async () => {
    routeMaps((url) => (url.includes('&id=') ? ok(ONE_BRANCH_MAP) : ok(ONE_BRANCH_LIST)));
    const { container } = render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    await screen.findByRole('button', { name: 'Bouwen' });
    const when = new Date(GENERATED).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
    const text = container.textContent ?? '';
    expect(text.split(when).length - 1).toBe(1);
    expect(text.split('3 punten').length - 1).toBe(1);
    expect(container.querySelector('.fw-mm__subtitle')?.textContent).not.toContain(when);
  });

  it('a single point reads "1 punt"', async () => {
    routeMaps((url) => (url.includes('&id=') ? new Promise<Response>(() => undefined) : ok({ ...ONE_BRANCH_LIST, unreadable: 0, maps: [{ ...ONE_BRANCH_LIST.maps[0], node_count: 1 }] })));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    expect(await screen.findByText('1 punt')).toBeInTheDocument();
    expect(screen.getByText('Kaart laden…')).toBeInTheDocument();
  });

  it('a map that cannot be opened: Dutch title, the reason, and a Dutch retry', async () => {
    routeMaps((url) => (url.includes('&id=') ? fail(422, { ok: false, error: 'mind map file is not valid JSON' }) : ok({ ...ONE_BRANCH_LIST, unreadable: 0 })));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    expect(await screen.findByText('Deze kaart kon niet worden geopend')).toBeInTheDocument();
    expect(screen.getByText(/Forge gaf als antwoord: mind map file is not valid JSON/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Opnieuw proberen' })).toBeInTheDocument();
  });

  it('a refused folder: Dutch title and detail', async () => {
    routeMaps(() => ok({ ok: true, available: false, provenance: 'REFUSED', note: 'forge-mindmaps is a symlink', maps: [], unreadable: 0, truncated: false }));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    expect(await screen.findByText('De map met plankaarten wordt niet gelezen')).toBeInTheDocument();
    expect(screen.getByText('Die map is een snelkoppeling of geen echte map.')).toBeInTheDocument();
    expect(screen.queryByText(/symlink/)).toBeNull();
  });

  it('a map without points: Dutch empty stage', async () => {
    const empty = { ok: true, map: { ...ONE_BRANCH_MAP.map, nodes: [], edges: [] } };
    routeMaps((url) => (url.includes('&id=') ? ok(empty) : ok({ ...ONE_BRANCH_LIST, unreadable: 0 })));
    const { container } = render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    await screen.findByText(/Deze kaart (heeft geen punten|kon niet worden geopend)/);
    expect(copyOf(container)).not.toMatch(ENGLISH_MAP);
  });
});

/* ----------------------------------------------------------------------------- Bestanden */

const FILE: FileNode = { id: 'src/app.ts', name: 'app.ts', path: 'src/app.ts', kind: 'file', size: '1 kB', updatedAt: '2026-11-03 09:00' } as FileNode;

function preview(over: Partial<GatewayFilePreview>): GatewayFilePreview {
  return { path: FILE.path, status: 'text', reason: null, size: 10, truncated: false, content: 'one', error: null, ...over };
}

function renderFiles(p: GatewayFilePreview | null) {
  const controller: FilesController = { tree: [FILE], ensureLoaded: () => undefined, preview: p };
  return renderWith(
    baseState({ inspectorOpen: false, selection: { kind: 'file', id: FILE.id } }, { files: [FILE] }),
    createElement(FilesView),
    controller,
  );
}

const ENGLISH_FILES =
  /Reading the file|Fetching|Preview (failed|blocked)|Binary file|No diff recorded|File preview|File tree|Project files|Clear the selection|\b(Path|Size|Updated|Change|Not tracked|Unchanged|lines|line|Truncated)\b|gateway/;

describe('Bestanden: the preview states in Dutch', () => {
  it('reading', () => {
    const { container } = renderFiles(null);
    expect(screen.getByText('Bestand lezen…')).toBeInTheDocument();
    for (const label of ['Pad', 'Grootte', 'Bijgewerkt', 'Wijziging', 'Niet bijgehouden']) expect(container.textContent, label).toContain(label);
    expect(screen.getByRole('button', { name: 'Selectie wissen' })).toBeInTheDocument();
    expect(copyOf(container.querySelector('.fw-files__panes') as HTMLElement)).not.toMatch(ENGLISH_FILES);
  });

  it('binary', () => {
    renderFiles(preview({ status: 'binary', content: null }));
    expect(screen.getByText('Geen tekstbestand')).toBeInTheDocument();
  });

  it('failed, with and without a reason', () => {
    const { unmount } = renderFiles(preview({ status: 'error', content: null, error: 'HTTP 500' }));
    expect(screen.getByText('Tonen mislukt')).toBeInTheDocument();
    expect(screen.getByText('Forge gaf als antwoord: HTTP 500.')).toBeInTheDocument();
    unmount();
    renderFiles(preview({ status: 'error', content: null, error: null }));
    expect(screen.getByText('Forge kon dit bestand niet lezen.')).toBeInTheDocument();
  });

  it('blocked, with the reason in Dutch', () => {
    renderFiles(preview({ status: 'blocked', reason: 'env-file', content: null }));
    expect(screen.getByText('Niet getoond')).toBeInTheDocument();
    expect(screen.getByText(/het lijkt op een bestand met instellingen \(\.env\)/)).toBeInTheDocument();
  });

  it('text: a One/Many line count', () => {
    const { unmount } = renderFiles(preview({ content: 'one' }));
    expect(screen.getByText('1 regel')).toBeInTheDocument();
    unmount();
    renderFiles(preview({ content: 'one\ntwo' }));
    expect(screen.getByText('2 regels')).toBeInTheDocument();
  });

  it('a live ISO mtime reads as a Dutch date, in the file details and in the Details pane', () => {
    const iso = '2026-11-03T07:14:30.743Z';
    const live = { ...FILE, updatedAt: iso } as FileNode;
    const when = new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
    const controller: FilesController = { tree: [live], ensureLoaded: () => undefined, preview: null };
    const { container } = renderWith(
      baseState({ inspectorOpen: true, selection: { kind: 'file', id: live.id } }, { files: [live] }),
      createElement('div', null, createElement(FilesView), createElement(Inspector, { embedded: true })),
      controller,
    );
    expect(container.textContent).not.toContain(iso);
    expect(screen.getAllByText(when).length).toBe(2);
  });

  it('an example record without a diff', () => {
    const plain = { ...FILE, id: 'f-plain' } as FileNode;
    renderWith(baseState({ inspectorOpen: false, selection: { kind: 'file', id: plain.id } }, { ...EMPTY_DATASET, files: [plain] }), createElement(FilesView));
    expect(screen.getByText('Geen wijziging vastgelegd')).toBeInTheDocument();
    expect(screen.getByText('Ongewijzigd')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------- the catalog copy of these screens */

const TABLES: Readonly<Record<string, { nl: Readonly<Record<string, string>>; en: Readonly<Record<string, string>> }>> = {
  map: catalogTable('rd.map'),
  files: catalogTable('rd.files'),
  details: catalogTable('rd.details'),
  status: catalogTable('rd.statusWord', 'rd.statusInfo'),
};

function flatKeys(tree: unknown, prefix = ''): string[] {
  if (typeof tree === 'string') return [prefix];
  return Object.entries(tree as Record<string, unknown>).flatMap(([k, v]) => flatKeys(v, prefix ? `${prefix}.${k}` : k));
}

describe('the XR-COPY2 catalog copy', () => {
  const holders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort().join(',');
  const banned =
    /(?<![\p{L}\d_-])(Boss|WP|run|token|evidence|gateway|effort|work package|the|and|with|your|you|this|for|to|not|yet|waiting|files|file|tasks|expand|collapse|show|layout|node|nodes|children|selected|preview|binary|diff)(?![\p{L}\d_-])/giu;

  for (const [name, table] of Object.entries(TABLES)) {
    it(`${name}: the same keys and placeholders in Dutch and English`, () => {
      expect(Object.keys(table.en).sort()).toEqual(Object.keys(table.nl).sort());
      expect(Object.keys(table.nl).filter((k) => holders(table.nl[k]) !== holders(table.en[k]))).toEqual([]);
    });

    it(`${name}: Dutch is short, plain and without an exclamation mark`, () => {
      const entries = Object.entries(table.nl);
      expect(entries.filter(([, v]) => v.trim().split(/\s+/).length > 16).map(([k]) => k)).toEqual([]);
      expect(entries.filter(([, v]) => v.includes('!')).map(([k]) => k)).toEqual([]);
      const found = entries.flatMap(([k, v]) => [...v.replace(/\{\w+\}/g, ' ').matchAll(banned)].map((m) => `${k}: ${m[1]}`));
      expect(found).toEqual([]);
    });
  }

  it('no key is both a text and a group, in the tables or against the catalog', () => {
    const mine = Object.values(TABLES).flatMap((table) => Object.keys(table.nl));
    const all = [...new Set([...mine, ...flatKeys(nlCatalog)])];
    const clash = mine.filter((key) => all.some((other) => other.startsWith(`${key}.`)) || all.some((other) => key.startsWith(`${other}.`)));
    expect(clash).toEqual([]);
    expect(mine.length).toBe(new Set(mine).size);
  });

  it('every One/Many pair is complete', () => {
    const mine = Object.values(TABLES).flatMap((table) => Object.keys(table.nl));
    const ones = mine.filter((k) => k.endsWith('One')).map((k) => k.slice(0, -3));
    const manys = mine.filter((k) => k.endsWith('Many')).map((k) => k.slice(0, -4));
    expect(ones.sort()).toEqual(manys.sort());
  });
});
