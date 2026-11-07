/**
 * WP B3-copy — the zijpaneel (Inspector) speaks Dutch via t(), and Eenvoudig hides the
 * developer-only rows (unknown type, template, raw id, raw counts, event kind, run id) per plan §4.2;
 * Uitgebreid keeps them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, within } from '@testing-library/react';

import { setLocale } from '@/i18n';
import Inspector from '@/components/shell/Inspector';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ActivityEvent, Project } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';

const PROJECT: Project = {
  prototype: true,
  id: 'proj-bakkerij',
  name: 'bakkerij-website',
  description: '',
  type: 'unknown',
  status: 'idle',
  lastActivity: '',
  path: 'C:/Projecten/bakkerij-website',
  templateVersion: 'v11',
  pinned: false,
  conversationCount: 2,
  missionCount: 1,
  taskCount: 3,
  agentCount: 2,
  skills: [],
  health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: null, testsMeasured: false },
};

const EVENT: ActivityEvent = {
  prototype: true,
  id: 'evt-1',
  runId: 'forge-2026-11-02-x',
  timestamp: '2026-11-02 10:00:00',
  kind: 'task',
  agent: 'Build Boss',
  status: 'completed',
  message: 'Pagina gebouwd',
  detail: 'De startpagina staat in site/.',
};

/** Words that must never reach an Eenvoudig Dutch screen (English copy or banned jargon). */
const ENGLISH = /\b(the|and|nothing|selected|record|open|type|path|health|counts|skills|live record|gateway|run|idle|kind|agent)\b/i;

function stateWith(overrides: Partial<PrototypeState>): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, projects: [PROJECT], events: [EVENT] },
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: true,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: PROJECT.id,
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

/** Redesign 3D: the shell mounts the embedded panel (a div inside the Details pane); `standalone` is the default mount (its own landmark). */
function renderInspector(overrides: Partial<PrototypeState>, standalone = false) {
  const value: StoreValue = { state: stateWith(overrides), dispatch: vi.fn() };
  render(
    createElement(PrototypeContext.Provider, { value }, createElement(Inspector, { embedded: !standalone })),
  );
  return document.querySelector('.fw-inspector') as HTMLElement;
}

/** Visible copy plus accessible names, without log data. */
function copyOf(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-log-name], [data-log-text]').forEach((node) => node.remove());
  const names = Array.from(clone.querySelectorAll('[aria-label], [title]')).map(
    (el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`,
  );
  return `${clone.textContent ?? ''} ${names.join(' ')}`;
}

describe('Inspector copy (WP B3-copy)', () => {
  beforeEach(() => {
    setLocale('nl');
    setUiMode('eenvoudig');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setUiMode('eenvoudig');
    setLocale('en');
  });

  it('nothing selected: one Dutch heading and one line, no second empty heading (standalone mount)', () => {
    const aside = renderInspector({ selection: { kind: 'none' } }, true);
    const panel = within(aside);
    expect(aside.tagName).toBe('ASIDE');
    expect(aside).toHaveAttribute('aria-label', 'Zijpaneel');
    expect(panel.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Niets geselecteerd']);
    expect(panel.getByText('Kies iets in je werkplek; de details verschijnen hier.')).toBeInTheDocument();
    expect(panel.queryByText('Geen item geopend')).toBeNull();
    expect(copyOf(aside)).not.toMatch(ENGLISH);
  });

  it('the standalone mount has no drag handle, close button or footer of its own', () => {
    const aside = renderInspector({ selection: { kind: 'project', id: PROJECT.id } }, true);
    expect(aside.querySelector('.fw-inspector__handle, .fw-inspector__foot')).toBeNull();
    expect(within(aside).queryByRole('button', { name: 'Zijpaneel sluiten' })).toBeNull();
    expect(aside.textContent).not.toContain('Live gegevens van Forge op deze pc');
  });

  it('project in Eenvoudig: Dutch labels, no unknown type, template, raw id or raw counts', () => {
    const aside = renderInspector({ selection: { kind: 'project', id: PROJECT.id } });
    const text = copyOf(aside);
    expect(text).toContain('Map');
    expect(text).toContain('Gezondheid');
    expect(text).toContain('Vaardigheden');
    expect(text).toContain('Rustig');
    expect(text).not.toContain('Soort');
    expect(text).not.toContain('Sjabloon');
    expect(text).not.toContain('Aantallen');
    expect(text).not.toContain(PROJECT.id);
    expect(text).not.toMatch(ENGLISH);
  });

  it('project in Uitgebreid keeps the developer rows', () => {
    setUiMode('uitgebreid');
    const aside = renderInspector({ selection: { kind: 'project', id: PROJECT.id } });
    const text = copyOf(aside);
    expect(text).toContain('Soort');
    expect(text).toContain('unknown');
    expect(text).toContain('Sjabloon');
    expect(text).toContain('Aantallen');
    expect(text).toContain(PROJECT.id);
  });

  it('project in Uitgebreid: an empty template reads "Niet ingesteld", never a blank value', () => {
    setUiMode('uitgebreid');
    const aside = renderInspector({
      data: { ...EMPTY_DATASET, projects: [{ ...PROJECT, templateVersion: '' }], events: [EVENT] },
      selection: { kind: 'project', id: PROJECT.id },
    });
    const field = Array.from(aside.querySelectorAll('.fw-inspector__field')).find(
      (row) => row.querySelector('.fw-inspector__field-label')?.textContent === 'Sjabloon',
    );
    expect(field).toBeDefined();
    expect(field!.querySelector('.fw-inspector__field-value')!.textContent!.trim()).toBe('Niet ingesteld');
    const values = Array.from(aside.querySelectorAll('.fw-inspector__field-value')).map((v) => v.textContent!.trim());
    expect(values).not.toContain('');
  });

  it('event in Eenvoudig shows the Dutch role name, not the log name, kind or run id', () => {
    const aside = renderInspector({ selection: { kind: 'event', id: EVENT.id } });
    const text = copyOf(aside);
    expect(text).toContain('GEBEURTENIS');
    expect(text).toContain('Bouwer');
    expect(text).not.toMatch(/\bBoss\b/);
    expect(text).not.toContain(EVENT.runId);
    expect(text).not.toContain('Soort');
    setUiMode('uitgebreid');
    cleanup();
    const advanced = copyOf(renderInspector({ selection: { kind: 'event', id: EVENT.id } }));
    expect(advanced).toContain(EVENT.runId);
  });

  it('English locale still reads the original English copy', () => {
    setLocale('en');
    const aside = renderInspector({ selection: { kind: 'none' } }, true);
    expect(within(aside).getByText('Nothing selected')).toBeInTheDocument();
    expect(within(aside).getByText('Select anything in the workspace and its record opens here.')).toBeInTheDocument();
  });
});
