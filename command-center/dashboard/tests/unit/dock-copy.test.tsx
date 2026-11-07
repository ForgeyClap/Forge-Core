/**
 * WP B3-copy — the onderpaneel (Dock): Dutch tab labels and panel copy via t(), a Dutch empty state
 * per panel, and English log names (event kind, events.jsonl, proof command, "Build Boss") only in
 * Uitgebreid.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import Dock from '@/components/shell/Dock';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { DockTab, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ActivityEvent, ProofEntry } from '@/prototype/types/prototype-types';
import { setUiMode } from '@/state/ui-mode';

const EVENT: ActivityEvent = {
  prototype: true,
  id: 'evt-1',
  runId: 'forge-run-1',
  timestamp: '2026-11-02 10:00:00',
  kind: 'work-package',
  agent: 'Build Boss',
  status: 'completed',
  message: 'Pagina gebouwd',
  detail: '',
};

const PROOF: ProofEntry = {
  prototype: true,
  id: 'proof-1',
  timestamp: '2026-11-02 10:01:00',
  claim: 'Tests geslaagd',
  agent: 'Test Boss',
  taskId: 'T-1',
  command: 'npm test',
  artifact: null,
  verdict: 'accepted',
  reason: '',
};

const ENGLISH = /\b(the|and|events|activity|proof|notices|evidence|newest|select|gateway|run|ledger|claim[s]? were|Boss)\b/i;

function renderDock(tab: DockTab, withData: boolean) {
  const state: PrototypeState = {
    data: withData ? { ...EMPTY_DATASET, events: [EVENT], proof: [PROOF] } : EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: true,
    dockTab: tab,
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
  const value: StoreValue = { state, dispatch: vi.fn() };
  render(createElement(PrototypeContext.Provider, { value }, createElement(Dock)));
  return document.querySelector('section.fw-dock') as HTMLElement;
}

/** Interface copy only: log data and log names are removed first, accessible names kept. */
function copyOf(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-log-name], [data-log-text], pre').forEach((node) => node.remove());
  const names = Array.from(clone.querySelectorAll('[aria-label], [title]')).map(
    (el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`,
  );
  return `${clone.textContent ?? ''} ${names.join(' ')}`;
}

describe('Dock copy (WP B3-copy)', () => {
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

  it('tabs are Dutch glossary words', () => {
    renderDock('activity', false);
    const labels = screen.getAllByRole('tab').map((tab) => (tab.textContent ?? '').replace(/\d+/g, '').trim());
    expect(labels).toEqual(['Activiteit', 'Terminal', 'Tests', 'Gebeurtenissen', 'Opleverbewijs', 'Meldingen']);
    expect(screen.getByRole('tablist')).toHaveAccessibleName('Onderdelen van het onderpaneel');
  });

  it.each([
    ['activity', 'Nog geen activiteit'],
    ['terminal', 'Nog geen uitvoer'],
    ['tests', 'Nog geen controles'],
    ['events', 'Nog geen gebeurtenissen'],
    ['proof', 'Nog geen opleverbewijs'],
  ] as const)('the %s panel has a Dutch empty state', (tab, title) => {
    const dock = renderDock(tab, false);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(copyOf(dock)).not.toMatch(ENGLISH);
  });

  it('every panel with data reads Dutch in Eenvoudig, with role names instead of log names', () => {
    for (const tab of ['activity', 'tests', 'events', 'proof', 'notices'] as const) {
      const dock = renderDock(tab, true);
      expect(copyOf(dock), `tab ${tab}`).not.toMatch(ENGLISH);
      expect(dock.textContent ?? '').not.toContain('events.jsonl');
      expect(dock.textContent ?? '').not.toContain('npm test');
      cleanup();
    }
    const dock = renderDock('activity', true);
    expect(dock.textContent).toContain('Bouwer');
  });

  it('Uitgebreid keeps the English log names inside data-log-name boxes', () => {
    setUiMode('uitgebreid');
    const events = renderDock('events', true);
    expect(events.querySelector('[data-log-name]')?.textContent).toContain('events.jsonl');
    expect(events.textContent).toContain('work-package');
    cleanup();
    const proof = renderDock('proof', true);
    expect(proof.textContent).toContain('npm test');
    expect(proof.textContent).toContain('Test Boss');
  });
});
