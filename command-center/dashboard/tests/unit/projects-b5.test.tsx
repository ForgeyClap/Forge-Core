/**
 * WP B5 — Mijn projecten, extended: Dutch copy (the screen is in Eenvoudig), the "Project
 * toevoegen" panel (new project with the real install-status poll; existing folder with the plan
 * §3.2 guardrails and an honest "nog niet gekoppeld" plus the exact command under Technische
 * details), and the project's Forge version next to the app version.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import { setUiMode } from '@/state/ui-mode';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Project } from '@/prototype/types/prototype-types';
import ProjectsView from '@/views/projects/ProjectsView';
import { installCommand, isListedFolder, parseProjectForgeVersion } from '@/views/projects/project-extras';

const BANNED = /(?<![\p{L}\d_-])(Boss|run|MCP|token|hook|CLI|gateway|projects|search|add|new|the|and|with|your|you|this|for|to|not|only|of\s+\d)(?![\p{L}\d_-])/giu;

function findings(root: Element): string[] {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('[data-log-text], [data-log-name], .fw-projects__name, .fs-folder__path, .fs-folder__item').forEach((node) => node.remove());
  const texts: string[] = [];
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.trim();
    if (value) texts.push(value);
  }
  clone.querySelectorAll('[aria-label],[title],[placeholder]').forEach((el) =>
    texts.push(el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '', el.getAttribute('placeholder') ?? ''),
  );
  return texts.flatMap((text) => [...text.replace(/\b(Forge|Windows)\b/g, ' ').matchAll(BANNED)].map((m) => `${m[1]} in "${text}"`));
}

const PROJECT = {
  ...(EMPTY_DATASET.projects[0] ?? {}),
  id: 'bakkerij',
  name: 'bakkerij',
  description: 'Website voor de bakker',
  type: 'website',
  status: 'idle',
  lastActivity: '4 min ago',
  path: 'C:\\Users\\iemand\\Documents\\bakkerij',
  templateVersion: '',
  pinned: false,
  conversationCount: 2,
  missionCount: 1,
  taskCount: null,
  agentCount: 3,
  skills: [],
  health: { score: null },
} as unknown as Project;

function buildState(projects: readonly Project[], active = 'bakkerij'): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, projects },
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
    activeProjectId: active,
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
  } as PrototypeState;
}

function renderView(projects: readonly Project[], active = 'bakkerij', dispatch = vi.fn()) {
  const value: StoreValue = { state: buildState(projects, active), dispatch };
  return render(createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(ProjectsView))));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

let installState = 'installing';
let pendingAsks: unknown[] = [];

beforeEach(() => {
  setLocale('nl');
  installState = 'installing';
  pendingAsks = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      let status = 200;
      let body: unknown = { ok: true };
      if (url.includes('/profile')) body = { ok: true, canon_version: 'v11', forge_version: 'abcdef123456', synced_at: '2026-11-01T10:00:00Z' };
      else if (url.includes('/api/pending-asks')) body = { ok: true, pending_asks: pendingAsks };
      else if (url.includes('/api/health')) body = { ok: true, gateway: { project_root: 'C:\\Forge' } };
      else if (url.includes('/api/discord/browse-folder')) {
        const dir = new URL(url).searchParams.get('dir');
        body = dir && !dir.endsWith('Documents')
          ?{ ok: true, path: dir, parent: 'C:\\Users\\iemand\\Documents', folders: [], truncated: false }
          : { ok: true, path: 'C:\\Users\\iemand\\Documents', parent: 'C:\\Users\\iemand', folders: ['bakkerij', 'nieuw'], truncated: false };
      }
      else if (url.includes('/api/projects/install-status')) body = { ok: true, state: installState, reason: installState === 'failed' ? 'schijf vol' : null };
      else if (url.includes('/api/projects') && init?.method === 'POST') {
        const name = JSON.parse(init.body ?? '{}').name as string;
        if (name === 'bestaat') {
          status = 409;
          body = { ok: false, error: 'a project with that name already exists' };
        } else body = { ok: true, project: { name } };
      }
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUiMode('eenvoudig');
});

describe('project-extras', () => {
  it('builds the exact install command with the right separator', () => {
    expect(installCommand('C:\\Forge', 'D:\\Werk\\site')).toBe('node "C:\\Forge\\.claude\\forge-bin\\forge-sync.cjs" install "D:\\Werk\\site"');
    expect(installCommand('/opt/forge/', '/home/a/site')).toBe('node "/opt/forge/.claude/forge-bin/forge-sync.cjs" install "/home/a/site"');
  });

  it('matches a folder against discovered paths regardless of case and slashes', () => {
    expect(isListedFolder('c:/users/iemand/documents/bakkerij/', ['C:\\Users\\iemand\\Documents\\bakkerij'])).toBe(true);
    expect(isListedFolder('C:\\elders', ['C:\\Users\\iemand\\Documents\\bakkerij'])).toBe(false);
  });

  it('prefers the canon version, falls back to a short sync commit, else null', () => {
    expect(parseProjectForgeVersion('p', { canon_version: 'v11', forge_version: 'abc' }).version).toBe('v11');
    expect(parseProjectForgeVersion('p', { forge_version: 'abcdef123456' }).version).toBe('abcdef1');
    expect(parseProjectForgeVersion('p', {}).version).toBeNull();
  });
});

describe('Mijn projecten (Dutch)', () => {
  it('Eenvoudig: one title, one primary action, the list rows; no English status word, no counts, no versions', async () => {
    const { container } = renderView([PROJECT]);
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Mijn projecten' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nieuw project' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Alle projecten' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^bakkerij Website voor de bakker/ })).toBeInTheDocument();
    // An idle project carries no status word at all (no "Idle", no "IDLE", no caps label).
    expect(container.textContent).not.toMatch(/idle|niet bepaald/i);
    expect(container.querySelector('.fw-projects__counts')).toBeNull();
    expect(screen.queryByText('App: ontwikkelversie')).toBeNull();
    // Search shows only above 8 projects.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(findings(container)).toEqual([]);
  });

  it('Uitgebreid: the measured counts per row and the versions line', async () => {
    setUiMode('uitgebreid');
    const { container } = renderView([PROJECT]);
    await settle();
    expect(screen.getByText('App: ontwikkelversie')).toBeInTheDocument();
    expect(screen.getByText('Forge v11 in bakkerij')).toBeInTheDocument();
    const row = container.querySelector('.fw-projects__item[data-active="true"]');
    expect(row?.querySelector('[title="Gesprekken"] .fg-machine')?.textContent).toBe('2');
    // taskCount and health were never measured: an honest dash, never a fabricated 0.
    expect(row?.querySelector('[title="Taken"] .fg-machine')?.textContent).toBe('—');
    const health = row?.querySelector('.fw-projects__health')?.textContent ?? '';
    expect(health).toContain('—');
    expect(health).not.toMatch(/\d|%/);
    expect(findings(container)).toEqual([]);
  });

  it('a busy project says "Bezig"; the row menu opens and pins through the store', async () => {
    const dispatch = vi.fn();
    renderView([{ ...PROJECT, status: 'running' } as Project], 'bakkerij', dispatch);
    await settle();
    expect(screen.getByText('Bezig')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Meer voor bakkerij' }));
    expect(screen.getByRole('menuitem', { name: 'Openen' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Vastpinnen' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'project/pin-toggle', id: 'bakkerij' });
  });

  it('search appears only with more than 8 projects', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...PROJECT, id: `p${i}`, name: `project ${i}` }) as Project);
    renderView(many, 'p0');
    await settle();
    expect(screen.getByRole('searchbox', { name: 'Zoek een project' })).toBeInTheDocument();
  });

  it('"Wacht op jou" shows the active project only while a question really waits', async () => {
    pendingAsks = [{ id: 'a1', conversation_id: 'c1', question_count: 1 }];
    const dispatch = vi.fn();
    renderView([PROJECT], 'bakkerij', dispatch);
    await settle();
    expect(screen.getByRole('heading', { level: 2, name: 'Wacht op jou' })).toBeInTheDocument();
    expect(screen.getByText('1 vraag voor jou')).toBeInTheDocument();
    // It moves out of "Alle projecten" instead of showing twice.
    expect(screen.queryByRole('heading', { level: 2, name: 'Alle projecten' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^bakkerij Website voor de bakker/ }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: 'c1' });
  });

  it('no projects at all: one line and one action', async () => {
    renderView([], '');
    await settle();
    expect(screen.getByText('Nog geen projecten. Begin met een vraag.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nieuw gesprek' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Wacht op jou' })).toBeNull();
  });

  it('new project: creates through the real route and follows the install until it is known', async () => {
    renderView([PROJECT]);
    fireEvent.click(screen.getByRole('button', { name: 'Nieuw project' }));
    fireEvent.change(screen.getByLabelText(/Naam van het project/), { target: { value: 'website-bakkerij' } });
    fireEvent.click(screen.getByRole('button', { name: 'Maken' }));
    await settle();
    expect(screen.getByText('Forge wordt geïnstalleerd in website-bakkerij. Dit kan een paar minuten duren.')).toBeInTheDocument();
    const posts = (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string }?][] } }).mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(posts).toHaveLength(1);
  });

  it('new project: a refused name shows the reason', async () => {
    renderView([PROJECT]);
    fireEvent.click(screen.getByRole('button', { name: 'Nieuw project' }));
    fireEvent.change(screen.getByLabelText(/Naam van het project/), { target: { value: 'bestaat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Maken' }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Het project kon niet worden gemaakt:');
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
  });

  it('existing folder: Documents itself is refused, a listed folder is recognised, another folder gets the honest command', async () => {
    const { container } = renderView([PROJECT]);
    fireEvent.click(screen.getByRole('button', { name: 'Nieuw project' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Bestaande map' }));
    await settle();
    // The listing opens in Documents: choosing it is refused (plan §3.2).
    fireEvent.click(screen.getByRole('button', { name: 'Deze map gebruiken' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Into "bakkerij" (already a project).
    fireEvent.click(screen.getByRole('button', { name: 'bakkerij' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Deze map gebruiken' }));
    await settle();
    expect(screen.getByText('Deze map staat al in je lijst.')).toBeInTheDocument();
    // Up again, into "nieuw" (not a project): honest "nog niet gekoppeld" and the exact command.
    fireEvent.click(screen.getByRole('button', { name: 'Map hoger' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'nieuw' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Deze map gebruiken' }));
    await settle();
    expect(screen.getByText(/nog niet vanuit de app \(nog niet gekoppeld\)/)).toBeInTheDocument();
    expect(screen.getByText('Technische details')).toBeInTheDocument();
    expect(
      screen.getByText('node "C:\\Forge\\.claude\\forge-bin\\forge-sync.cjs" install "C:\\Users\\iemand\\Documents\\nieuw"'),
    ).toBeInTheDocument();
    expect(findings(container)).toEqual([]);
  });
});
