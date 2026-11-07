/**
 * Sidebar x ui-mode (WP B4, plan §4.2 visibility table): the rendered sidebar — not only the
 * nav-config helpers — shows the beginner destinations in Eenvoudig and adds the advanced ones in
 * Uitgebreid. Design reference (/theme), account rotation (/accounts) and the old roster (/agents)
 * never get a sidebar entry in either mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import Sidebar from '@/components/shell/Sidebar';
import { setUiMode } from '@/state/ui-mode';

function buildState(): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
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
  };
}

function renderedNavPaths(): Set<string> {
  const value: StoreValue = { state: buildState(), dispatch: () => undefined };
  const { container } = render(
    createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(Sidebar))),
  );
  return new Set(Array.from(container.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? ''));
}

const BEGINNER = ['/', '/chat', '/projects', '/settings'];
const ADVANCED_ONLY = ['/team', '/tasks', '/mission', '/activity'];
const NEVER = ['/theme', '/accounts', '/agents', '/onboarding'];

describe('Sidebar follows the Eenvoudig / Uitgebreid visibility table', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    act(() => setUiMode('eenvoudig'));
  });

  it('Eenvoudig shows only Start, Chat, Mijn projecten and Instellingen', () => {
    act(() => setUiMode('eenvoudig'));
    const paths = renderedNavPaths();
    for (const path of BEGINNER) expect(paths.has(path), path).toBe(true);
    for (const path of [...ADVANCED_ONLY, ...NEVER]) expect(paths.has(path), path).toBe(false);
  });

  it('Uitgebreid adds Team, Taken, Overzicht and Activiteit, still never the internal screens', () => {
    act(() => setUiMode('uitgebreid'));
    const paths = renderedNavPaths();
    for (const path of [...BEGINNER, ...ADVANCED_ONLY]) expect(paths.has(path), path).toBe(true);
    for (const path of NEVER) expect(paths.has(path), path).toBe(false);
  });
});
