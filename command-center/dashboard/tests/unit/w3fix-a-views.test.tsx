/**
 * Redesign fix round, part A (UI Boss): Helpers, Overzicht and Team.
 *
 * One test per gate finding (Review Boss a46696526ee5b61ae, UI Boss aeacb8654d5d2c2ab):
 * blank minimap, two effort values on one card, the empty roster's no-op button, "Leiding" twice,
 * repeated band name and empty lines in Per groep, plural-only counts, the raw UTC start time,
 * the bare approvals dash, the Overzicht title size and missing description, the Team header
 * offset, Team squeezing Overleg next to the Details pane, Team's two empty pickers, and the
 * permission word for `elevated`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { EMPTY_GATEWAY_APPROVALS } from '@/prototype/state/gateway-recovery';
import type { Agent, AgentGroup, GraphEdge, GraphLane, GraphNode, MissionGraph, Run } from '@/prototype/types/prototype-types';
import AgentsView from '@/views/agents/AgentsView';
import { ApprovalsMeta } from '@/views/mission/ApprovalsMeta';
import { Minimap } from '@/views/mission/Minimap';
import MissionControlView from '@/views/mission/MissionControlView';
import { TeamPanel } from '@/views/team/TeamView';
import type { TeamChat } from '@/views/team/team-data';

const SRC = join(__dirname, '..', '..', 'src');
const css = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first rule whose selector list is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  return match ? match[2] : '';
}

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, agents: [] },
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
    activeProjectId: 'demo-project',
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

function renderWith(state: PrototypeState, view: Parameters<typeof createElement>[0]) {
  const value: StoreValue = { state, dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(view)));
}

function realAgent(group: AgentGroup, overrides: Partial<Agent> = {}): Agent {
  const record = {
    id: 'boss',
    name: 'Boss',
    role: 'Owns the mission.',
    group,
    permission: 'standard',
    status: 'waiting',
    progress: 0,
    currentTask: null,
    runtimeModel: 'opus',
    toolModel: '',
    effort: 'medium',
    skills: [],
    lastActivity: '',
    verification: null,
    summary: '',
    ...overrides,
  };
  // Production records carry no `prototype` flag (mappers.ts `toGatewayAgent`).
  delete (record as { prototype?: unknown }).prototype;
  return record as unknown as Agent;
}

function exampleAgent(group: AgentGroup, overrides: Partial<Agent> = {}): Agent {
  return { ...realAgent(group, overrides), prototype: true } as Agent;
}

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubGateway(agentsPayload: unknown, extra: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/agent-dispatches')) return json({ ok: true, dispatches: [] });
      if (u.includes('/api/agents')) return json(agentsPayload);
      for (const [needle, body] of Object.entries(extra)) if (u.includes(needle)) return json(body);
      return json({ ok: true });
    }),
  );
}

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale('en');
});

/* ------------------------------------------------------------------ minimap */

describe('Overzicht minimap', () => {
  const lane = { id: 'lane-1', label: 'Build Boss', group: 'execution' } as unknown as GraphLane;
  const node = (id: string, col: number) =>
    ({ id, label: id, kind: 'step', status: 'running', col, row: 0, laneId: 'lane-1', agent: 'build-boss' }) as unknown as GraphNode;

  it('draws the viewport rectangle under the nodes, so it can never hide them', () => {
    const layout = {
      width: 400,
      height: 200,
      bands: [{ lane, x: 0, y: 0, w: 400, h: 200 }],
      boxes: [{ node: node('a', 0), x: 10, y: 10, w: 100, h: 40 }],
    };
    const { container } = render(
      <Minimap
        layout={layout as never}
        viewport={{ x: 0, y: 0, k: 1 }}
        size={{ width: 400, height: 200 }}
        selectedId={null}
        onNavigate={() => undefined}
      />,
    );
    const view = container.querySelector('.fw-graph__minimap-view')!;
    const firstNode = container.querySelector('.fw-graph__minimap-node')!;
    expect(view).toBeTruthy();
    expect(firstNode).toBeTruthy();
    // DOCUMENT_POSITION_FOLLOWING: the node is painted after (on top of) the viewport rect.
    expect(view.compareDocumentPosition(firstNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('gives the viewport rectangle a see-through fill', () => {
    const body = rule(css('views/mission/mission.css'), '.fw-graph__minimap-view');
    expect(body).not.toBe('');
    const fillNone = /fill:\s*none/.test(body);
    const opacity = /fill-opacity:\s*([\d.]+)/.exec(body);
    expect(fillNone || (opacity !== null && Number(opacity[1]) <= 0.3)).toBe(true);
  });
});

/* ------------------------------------------------------------------ helpers */

describe('Helpers card: one effort value, never an invented one', () => {
  const payload = {
    ok: true,
    agents: [
      { slug: 'boss', name: 'Boss', model_tier: 'opus', claude_effort: 'xhigh', role: 'Owns the mission.' },
      { slug: 'docs-boss', name: 'Docs Boss', model_tier: 'sonnet', claude_effort: null, role: 'Writes docs.' },
    ],
  };

  it('shows the raw effort from disk and no second, mapped effort mark', async () => {
    stubGateway(payload);
    const agents = [realAgent('control'), realAgent('memory', { id: 'docs-boss', name: 'Docs Boss' })];
    const { container } = renderWith(buildState({ data: { ...EMPTY_DATASET, agents } }), AgentsView);
    const boss = container.querySelector<HTMLElement>('[data-agent-id="boss"]')!;
    const effort = await within(boss).findByRole('button', { name: 'Change Effort' });
    expect(effort.textContent).toContain('xhigh');
    expect(boss.querySelector('.fw-agents-effort')).toBeNull();
    expect(boss.textContent).not.toContain('Medium');
  });

  it('says "niet ingesteld" for an agent without an effort, never a made-up Middel', async () => {
    setLocale('nl');
    stubGateway(payload);
    const agents = [realAgent('control'), realAgent('memory', { id: 'docs-boss', name: 'Docs Boss' })];
    const { container } = renderWith(buildState({ data: { ...EMPTY_DATASET, agents } }), AgentsView);
    await within(container.querySelector<HTMLElement>('[data-agent-id="boss"]')!).findByRole('button', { name: 'Denkniveau wijzigen' });
    const docs = container.querySelector<HTMLElement>('[data-agent-id="docs-boss"]')!;
    expect(docs.textContent).toContain('niet ingesteld');
    expect(docs.querySelector('.fw-agents-effort')).toBeNull();
    expect(docs.textContent).not.toContain('Middel');
  });

  it('a real agent shows no mapped effort while its raw value is still unknown', () => {
    stubGateway({ ok: false });
    const { container } = renderWith(buildState({ data: { ...EMPTY_DATASET, agents: [realAgent('control')] } }), AgentsView);
    expect(container.querySelector('.fw-agents-effort')).toBeNull();
  });

  it('example data keeps its own effort mark', () => {
    stubGateway({ ok: false });
    const { container } = renderWith(
      buildState({ data: { ...EMPTY_DATASET, agents: [exampleAgent('control', { effort: 'high' })] } }),
      AgentsView,
    );
    expect(container.querySelector('.fw-agents-effort')?.textContent).toContain('High');
  });
});

describe('Helpers with an empty roster', () => {
  it('shows one honest line and no button that does nothing', async () => {
    stubGateway({ ok: true, agents: [] });
    const { container } = renderWith(buildState(), AgentsView);
    await screen.findAllByText('No Forge agent registry found for this project.');
    expect(screen.queryByText('No agents in this state')).toBeNull();
    expect(screen.queryByRole('button', { name: /Show all agents/ })).toBeNull();
    expect(container.querySelector('.fw-agents__filters')).toBeNull();
    expect(screen.getAllByText('No Forge agent registry found for this project.')).toHaveLength(1);
  });
});

describe('Helpers cards', () => {
  it('the Boss card does not say Leiding twice', () => {
    setLocale('nl');
    stubGateway({ ok: false });
    const agents = [exampleAgent('control', { permission: 'lead' })];
    const { container } = renderWith(buildState({ agentLayout: 'grid', data: { ...EMPTY_DATASET, agents } }), AgentsView);
    const card = container.querySelector<HTMLElement>('[data-agent-id="boss"]')!;
    const words = (card.textContent ?? '').match(/Leiding/g) ?? [];
    expect(words.length).toBeLessThanOrEqual(1);
  });

  it('the permission chip calls elevated "Verhoogd", not the mode word Uitgebreid', () => {
    setLocale('nl');
    stubGateway({ ok: false });
    const agents = [exampleAgent('execution', { permission: 'elevated' })];
    const { container } = renderWith(buildState({ agentLayout: 'grid', data: { ...EMPTY_DATASET, agents } }), AgentsView);
    const chip = container.querySelector('[data-permission="elevated"]');
    expect(chip?.textContent).toContain('Verhoogd');
    expect(chip?.textContent).not.toContain('Uitgebreid');
  });

  it('Per groep cards do not repeat the band name and drop the empty task and skills lines', () => {
    stubGateway({ ok: false });
    const agents = [exampleAgent('execution', { id: 'build-boss', name: 'Build Boss', currentTask: null, skills: [] })];
    const { container } = renderWith(buildState({ agentLayout: 'grouped', data: { ...EMPTY_DATASET, agents } }), AgentsView);
    const band = container.querySelector<HTMLElement>('.fw-agents__band[data-group="execution"]')!;
    const card = band.querySelector<HTMLElement>('[data-agent-id="build-boss"]')!;
    expect(card.querySelector('.fw-agents-card__group-name')).toBeNull();
    expect(card.textContent).not.toContain('No task assigned right now.');
    expect(card.textContent).not.toContain('No skills attached to this agent.');
  });
});

/* ------------------------------------------------------------------ overzicht */

function missionState(): PrototypeState {
  const lane = { id: 'lane-1', label: 'Build Boss', group: 'execution' } as unknown as GraphLane;
  const nodes = ['n1', 'n2'].map(
    (id, col) => ({ id, label: id, kind: 'step', status: 'running', col, row: 0, laneId: 'lane-1', agent: 'build-boss' }) as unknown as GraphNode,
  );
  const edges = [{ id: 'e1', from: 'n1', to: 'n2', kind: 'flow' } as unknown as GraphEdge];
  const graph = { id: 'run-1::graph', runId: 'run-1', lanes: [lane], nodes, edges } as unknown as MissionGraph;
  const run = {
    id: 'run-1',
    projectId: 'demo-project',
    goal: 'Ship the booking page',
    status: 'running',
    startedAt: '2026-11-03T04:41:04.151Z',
    duration: '12 min',
    workPackageIds: [],
    agentIds: [],
  } as unknown as Run;
  return buildState({ data: { ...EMPTY_DATASET, runs: [run], graph } });
}

describe('Overzicht header', () => {
  it('uses singular words for a count of one', () => {
    setLocale('nl');
    stubGateway({ ok: true, agents: [] }, { '/api/approvals': { ok: true, evaluations: [], evaluations_provenance: 'LIVE' } });
    renderWith(missionState(), MissionControlView);
    expect(screen.getByText('2 stappen · 1 baan · 1 lijn')).toBeTruthy();
  });

  it('shows the start time as a local date in body text, not a raw UTC ISO string in mono', () => {
    setLocale('nl');
    stubGateway({ ok: true, agents: [] });
    const { container } = renderWith(missionState(), MissionControlView);
    expect(container.textContent).not.toContain('2026-11-03T04:41:04.151Z');
    const when = container.querySelector('time[datetime="2026-11-03T04:41:04.151Z"]');
    expect(when).toBeTruthy();
    expect(when?.closest('.fg-machine')).toBeNull();
    expect(when?.textContent).toMatch(/3 nov/);
  });

  it('the title has the same size as every other Uitgebreid page title', () => {
    const mission = rule(css('views/mission/mission.css'), '.fw-mission__title');
    const agents = rule(css('views/agents/agents.css'), '.fw-agents__title');
    const size = (body: string) => /font-size:\s*([^;]+);/.exec(body)?.[1].trim();
    expect(size(mission)).toBe(size(agents));
  });

  it('with no mission running, the page still has its description line', async () => {
    stubGateway({ ok: true, agents: [] }, { '/chat-runs': { ok: true, runs: [] } });
    const { container } = renderWith(buildState(), MissionControlView);
    await waitFor(() => expect(container.querySelector('.fw-mission__subtitle')?.textContent).toBeTruthy());
  });
});

describe('Overzicht approvals', () => {
  it('approvals that are not loaded yet say so in words, never a bare dash', () => {
    const { container } = render(<ApprovalsMeta approvals={EMPTY_GATEWAY_APPROVALS} />);
    expect(container.textContent).not.toContain('—');
    expect(container.textContent).toContain('not known yet');
  });
});

/* ------------------------------------------------------------------ team */

const EMPTY_CHAT: TeamChat = { status: 'ready', error: null, lines: [], total: 0, malformed: 0, truncated: false };

describe('Team page', () => {
  it('uses the same page gutter as the other Uitgebreid routes', () => {
    const team = css('views/team/team.css');
    expect(rule(team, '.fw-team__header')).toMatch(/padding:[^;]*var\(--fw-gutter\)/);
    expect(rule(team, '.fw-team__header')).not.toMatch(/--fs-space-7/);
  });

  it('drops Rollen under Overleg when its own width is narrow (Details pane open)', () => {
    const team = css('views/team/team.css');
    expect(rule(team, '.fw-team')).toMatch(/container-type:\s*inline-size/);
    expect(team).toMatch(/@container[^{]*\{\s*\.fw-team__body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('a project without klussen shows one line and one action, no empty pickers', () => {
    setLocale('nl');
    render(
      <MemoryRouter>
        <TeamPanel runs={[]} runId={null} onRunChange={vi.fn()} statuses={new Map()} chat={EMPTY_CHAT} hasProject />
      </MemoryRouter>,
    );
    expect(screen.getByText('Nog geen klussen in dit project.')).toBeTruthy();
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Nieuw gesprek' })).toBeTruthy();
  });

  it('no project chosen shows one line and one action, no empty pickers', () => {
    setLocale('nl');
    render(
      <MemoryRouter>
        <TeamPanel runs={[]} runId={null} onRunChange={vi.fn()} statuses={new Map()} chat={EMPTY_CHAT} hasProject={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Kies eerst een project.')).toBeTruthy();
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
