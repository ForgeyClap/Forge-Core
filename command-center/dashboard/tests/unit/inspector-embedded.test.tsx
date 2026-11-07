/**
 * Redesign, part 3D (review F2): the Details pane embedded the old Inspector chrome
 * unchanged — a second close button and a drag handle inside the pane, a nested <aside> (two
 * landmarks), ALL-CAPS labels, mono for plain words and an extra footer; its close only dispatched
 * and dropped focus to <body>.
 *
 * Now the pane is the frame: one landmark, one close (SidePane `close()`, focus back to #fw-main),
 * sentence-case labels and mono only for paths and ids.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Inspector from '@/components/shell/Inspector';
import { SidePane } from '@/components/shell/SidePane';
import { setHelpView } from '@/components/shell/side-pane';
import { setLocale, translate } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { createInitialState } from '@/prototype/state/shell-effects';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ActivityEvent, Project } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';

const PROJECT: Project = {
  prototype: true,
  id: 'proj-bakkerij',
  name: 'bakkerij-website',
  description: '',
  type: 'website',
  status: 'idle',
  lastActivity: '2026-11-02 10:00',
  path: 'C:/Projecten/bakkerij-website',
  templateVersion: 'v11',
  pinned: true,
  conversationCount: 2,
  missionCount: 1,
  taskCount: 3,
  agentCount: 2,
  skills: ['frontend-design'],
  health: { tests: { passed: 4, failed: 0, skipped: 1 }, openTickets: 0, blockers: 0, score: 90, testsMeasured: true },
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

function detailsState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    ...createInitialState({ ...EMPTY_DATASET, projects: [PROJECT], events: [EVENT] }),
    activeProjectId: PROJECT.id,
    inspectorOpen: true,
    selection: { kind: 'project', id: PROJECT.id },
    ...overrides,
  };
}

function mountPane(state: PrototypeState) {
  const dispatch = vi.fn<(action: PrototypeAction) => void>();
  const value: StoreValue = { state, dispatch };
  render(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(
        PrototypeContext.Provider,
        { value },
        createElement(
          Fragment,
          null,
          createElement('main', { id: 'fw-main', tabIndex: -1 }, 'pagina'),
          createElement(SidePane),
        ),
      ),
    ),
  );
  return { dispatch };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  act(() => {
    setLocale('nl');
    setUiMode('uitgebreid');
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => {
    setHelpView('closed');
    setUiMode('eenvoudig');
    setLocale('en');
  });
});

describe('Details pane: the Inspector is embedded, the pane is the frame', () => {
  it('one landmark, one close button, no drag handle and no footer', () => {
    mountPane(detailsState());
    const pane = screen.getByRole('complementary', { name: translate('nl', 'rd.bar.detailsTitle') });
    expect(screen.getAllByRole('complementary')).toHaveLength(1);
    expect(pane.querySelector('aside aside, .fw-inspector__handle, .fw-inspector__foot')).toBeNull();

    const closes = within(pane)
      .getAllByRole('button')
      .filter((button) => /sluit|close/i.test(button.getAttribute('aria-label') ?? button.textContent ?? ''));
    expect(closes.map((button) => button.getAttribute('aria-label'))).toEqual([translate('nl', 'rd.bar.paneClose')]);
  });

  it('the inspector title sits under the pane heading (h3 under h2), with the kind in sentence case', () => {
    mountPane(detailsState());
    const pane = screen.getByRole('complementary');
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveTextContent(translate('nl', 'rd.bar.detailsTitle'));
    expect(within(pane).getByRole('heading', { level: 3, name: PROJECT.name })).toBeInTheDocument();
    const kind = pane.querySelector('.fw-inspector__kind');
    expect(kind?.querySelector('.fw-sentence')).not.toBeNull();
    expect(pane.querySelector('.fg-eyebrow')).toBeNull();
  });

  it('closing goes through the pane: dispatch inspector/set false and focus on #fw-main, never <body>', async () => {
    const user = userEvent.setup();
    const { dispatch } = mountPane(detailsState());
    await user.click(screen.getByRole('button', { name: translate('nl', 'rd.bar.paneClose') }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'inspector/set', open: false });
    expect(document.activeElement).toBe(document.getElementById('fw-main'));
  });

  it('Esc inside the embedded panel closes through the pane too (focus on #fw-main)', async () => {
    const user = userEvent.setup();
    const { dispatch } = mountPane(detailsState());
    const pane = screen.getByRole('complementary');
    const summary = pane.querySelector('summary');
    expect(summary).not.toBeNull();
    act(() => (summary as HTMLElement).focus());
    await user.keyboard('{Escape}');
    expect(dispatch).toHaveBeenCalledWith({ type: 'inspector/set', open: false });
    expect(document.activeElement).toBe(document.getElementById('fw-main'));
  });
});

describe('mono only for paths and ids', () => {
  function renderEmbedded(state: PrototypeState) {
    const value: StoreValue = { state, dispatch: vi.fn() };
    render(createElement(PrototypeContext.Provider, { value }, createElement(Inspector, { embedded: true })));
    return document.querySelector('.fw-inspector') as HTMLElement;
  }

  it('project: the path and id are mono; counts, yes/no, tests and timestamps are not', () => {
    const root = renderEmbedded(detailsState());
    // The Meter and Timestamp primitives still carry .fg-machine; inspector.css sets them in the body face.
    const mono = Array.from(root.querySelectorAll('.fg-machine:not(.fw-meter__value):not(.fw-timestamp)')).map(
      (node) => node.textContent ?? '',
    );
    expect(mono).toContain(PROJECT.path);
    expect(mono).toContain(PROJECT.id);
    for (const plain of [translate('nl', 'inspector.project.yes'), '2026-11-02 10:00', '2', '3', '90%']) {
      expect(mono, plain).not.toContain(plain);
    }
    expect(mono.some((text) => text.includes(translate('nl', 'inspector.project.notMeasured')))).toBe(false);
    expect(mono.some((text) => /geslaagd/.test(text))).toBe(false);
  });

  it('nothing selected on a fresh install: one heading and one line, no "Begin bij" label over an empty list', () => {
    const root = renderEmbedded({
      ...createInitialState(EMPTY_DATASET),
      inspectorOpen: true,
      selection: { kind: 'none' },
    });
    expect(within(root).getAllByRole('heading').map((h) => h.textContent)).toEqual([translate('nl', 'inspector.empty.title')]);
    expect(root.textContent).toContain(translate('nl', 'inspector.empty.subtitle'));
    // The old record-pane title (its key was deleted in as unused); it must not come back.
    expect(root.textContent).not.toContain('Geen item geopend');
    expect(root.textContent).not.toContain(translate('nl', 'inspector.empty.startFrom'));
  });

  it('the Details pane passes embedded explicitly: SidePane.tsx writes <Inspector embedded />', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/shell/SidePane.tsx'), 'utf8');
    expect(src).toContain('<Inspector embedded />');
  });

  it('the embedded root is a div, not a second landmark', () => {
    const root = renderEmbedded(detailsState());
    expect(root.tagName).toBe('DIV');
    expect(root).toHaveAttribute('data-embedded', 'true');
    expect(root).not.toHaveAttribute('aria-label');
  });

  it('inspector.css uses v1.0 tokens only and no caps', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/shell/inspector.css'), 'utf8');
    expect(css).not.toMatch(/--forge-/);
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/transition:\s*all/);
  });
});
