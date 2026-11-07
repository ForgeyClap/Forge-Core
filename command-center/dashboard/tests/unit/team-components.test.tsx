/**
 * WP B4 — Team strip and Team screen, rendered from fixture dispatches and channel lines.
 *
 * Fixtures use the real gateway shapes: /api/agent-dispatches run-log rows and
 * /api/runs/:id/team-chat lines (gateway/src/team-chat.mjs).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import { TeamStripView } from '@/views/team/TeamStrip';
import { TeamPanel } from '@/views/team/TeamView';
import {
  CARD_ROLES,
  parseTeamChat,
  parseTeamDispatches,
  roleFromName,
  roleStatuses,
  splitLineText,
} from '@/views/team/team-data';
import type { TeamChat } from '@/views/team/team-data';

const RUN = 'forge-2026-11-01-forge-systeem';

export const DISPATCH_FIXTURE = {
  dispatches: [
    { source: 'run-log', run_id: RUN, agent: 'Head Chef', agent_slug: 'head-chef', wp_id: 'B4', running: true, stalled: false, completed_at: null },
    { source: 'run-log', run_id: RUN, agent: 'Build Boss', agent_slug: 'build-boss', wp_id: 'B4', running: true, stalled: false, completed_at: null },
    { source: 'run-log', run_id: RUN, agent: 'Test Boss', agent_slug: 'test-boss', wp_id: 'B4', running: true, stalled: false, completed_at: null },
    { source: 'run-log', run_id: RUN, agent: 'UI Boss', agent_slug: 'ui-boss', wp_id: 'B4', running: false, stalled: false, completed_at: '2026-11-01T10:00:00Z' },
    { source: 'run-log', run_id: RUN, agent: 'Verify Boss', agent_slug: null, wp_id: 'B4', running: false, stalled: true, completed_at: null },
    // Another klus: must never leak into this one.
    { source: 'run-log', run_id: 'other-run', agent: 'Docs Boss', agent_slug: 'docs-boss', running: true, stalled: false, completed_at: null },
  ],
};

export const CHAT_FIXTURE = {
  ok: true,
  lines: [
    { ts: '2026-11-01T09:00:00Z', from: 'lead', to: 'Build Boss', wp_id: 'B4', kind: 'decision', text: 'GO: Bouwer start met de strook', via: 'direct' },
    { ts: '2026-11-01T09:10:00Z', from: 'Build Boss', to: 'Test Boss', wp_id: 'B4', kind: 'handoff', text: '[Build Boss -> Test Boss] strook staat klaar | wp=B4 | run=' + RUN, via: 'direct' },
    { ts: '2026-11-01T09:12:00Z', from: 'Test Boss', to: 'lead', wp_id: 'B4', kind: 'question', text: 'Welke breedte telt voor tablet?', via: 'direct' },
    { ts: '2026-11-01T09:15:00Z', from: 'Docs Boss', to: 'lead', wp_id: 'B6', kind: 'message', text: 'Handleiding bijgewerkt', via: 'lead' },
    { ts: '2026-11-01T09:20:00Z', from: 'Test Boss', to: 'Build Boss', wp_id: 'B4', kind: 'blocker', text: 'Knop valt buiten beeld op telefoon', via: 'direct' },
  ],
  total: 5,
  malformed: 0,
  truncated: false,
};

function chatFrom(data: Record<string, unknown>): TeamChat {
  return { status: 'ready', error: null, ...parseTeamChat(data) };
}

const EMPTY_CHAT: TeamChat = { status: 'ready', error: null, lines: [], total: 0, malformed: 0, truncated: false };

beforeEach(() => setLocale('nl'));
afterEach(() => cleanup());

describe('team-data', () => {
  it('maps log names and slugs to roles, any case', () => {
    expect(roleFromName('Build Boss')).toBe('build-boss');
    expect(roleFromName('head-chef')).toBe('head-chef');
    expect(roleFromName('LEAD')).toBe('lead');
    expect(roleFromName('Explore')).toBeNull();
    expect(roleFromName(null)).toBeNull();
  });

  it('derives one status per role for one klus only', () => {
    const statuses = roleStatuses(parseTeamDispatches(DISPATCH_FIXTURE), RUN);
    expect(statuses.get('head-chef')).toBe('busy');
    expect(statuses.get('ui-boss')).toBe('done');
    expect(statuses.get('verify-boss')).toBe('waiting');
    expect(statuses.has('docs-boss')).toBe(false);
  });

  it('busy wins over done for the same role', () => {
    const rows = parseTeamDispatches({
      dispatches: [
        { run_id: RUN, agent: 'Build Boss', running: false, completed_at: '2026-11-01T08:00:00Z' },
        { run_id: RUN, agent: 'Build Boss', running: true, completed_at: null },
      ],
    });
    expect(roleStatuses(rows, RUN).get('build-boss')).toBe('busy');
  });

  it('splits the [X -> Y] prefix and the wp/run tail', () => {
    expect(splitLineText('[Build Boss -> Test Boss] klaar | wp=B4 | run=r1')).toEqual({ from: 'Build Boss', to: 'Test Boss', text: 'klaar' });
    expect(splitLineText('gewoon tekst')).toEqual({ from: null, to: null, text: 'gewoon tekst' });
  });

  it('pins decisions and anything the lead wrote; marks via Lead', () => {
    const chat = chatFrom(CHAT_FIXTURE);
    expect(chat.lines.map((l) => l.pinned)).toEqual([true, false, false, false, false]);
    expect(chat.lines[3].viaLead).toBe(true);
    expect(chat.lines[1].text).toBe('strook staat klaar');
  });

  it('there are twelve role cards: every helper except the lead and the note taker', () => {
    expect(CARD_ROLES).toHaveLength(12);
    expect(CARD_ROLES).not.toContain('lead');
    expect(CARD_ROLES).not.toContain('scribe');
  });
});

describe('TeamStripView', () => {
  it('says who is busy, who waits and who is done, in Dutch role names', () => {
    const statuses = roleStatuses(parseTeamDispatches(DISPATCH_FIXTURE), RUN);
    render(
      <MemoryRouter>
        <TeamStripView statuses={statuses} chat={chatFrom(CHAT_FIXTURE)} />
      </MemoryRouter>,
    );
    const bar = screen.getByRole('button', { name: /Overleg van het team tonen/ });
    expect(bar).toHaveTextContent('Planner, Bouwer en Tester zijn bezig.');
    expect(bar).toHaveTextContent('Controleur wacht.');
    expect(bar).toHaveTextContent('Ontwerper is klaar.');
    expect(bar).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands to the latest five channel lines on click', () => {
    const statuses = roleStatuses(parseTeamDispatches(DISPATCH_FIXTURE), RUN);
    render(
      <MemoryRouter>
        <TeamStripView statuses={statuses} chat={chatFrom(CHAT_FIXTURE)} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Overleg van het team tonen/ }));
    expect(screen.getByRole('button', { name: /Overleg van het team verbergen/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Bouwer draagt over aan Tester')).toBeInTheDocument();
    expect(screen.getByText('via Lead')).toBeInTheDocument();
  });

  it('shows the honest empty state when the channel is empty', () => {
    render(
      <MemoryRouter>
        <TeamStripView statuses={new Map()} chat={EMPTY_CHAT} defaultExpanded />
      </MemoryRouter>,
    );
    expect(screen.getByText('Het team werkt aan deze klus.')).toBeInTheDocument();
    expect(screen.getByText('Nog geen teamberichten in deze klus.')).toBeInTheDocument();
  });
});

describe('TeamPanel', () => {
  const runs = [{ id: RUN, label: 'Forge Systeem', live: true }];

  function renderPanel(chat: TeamChat) {
    const statuses = roleStatuses(parseTeamDispatches(DISPATCH_FIXTURE), RUN);
    return render(
      <MemoryRouter>
        <TeamPanel runs={runs} runId={RUN} onRunChange={vi.fn()} statuses={statuses} chat={chat} hasProject />
      </MemoryRouter>,
    );
  }

  it('renders twelve role cards with live status words', () => {
    const { container } = renderPanel(chatFrom(CHAT_FIXTURE));
    const cards = container.querySelectorAll('.fw-team-role');
    expect(cards).toHaveLength(12);
    const planner = Array.from(cards).find((card) => card.textContent?.includes('Planner'));
    expect(planner).toHaveTextContent('Bezig');
    const ontwerper = Array.from(cards).find((card) => card.textContent?.includes('Ontwerper'));
    expect(ontwerper).toHaveTextContent('Klaar');
    const schrijver = Array.from(cards).find((card) => card.textContent?.includes('Schrijver'));
    expect(schrijver).toHaveTextContent('Niet ingezet');
  });

  it('pins the decision at the top, renders kinds, the handoff system line and via Lead', () => {
    const { container } = renderPanel(chatFrom(CHAT_FIXTURE));
    const pinned = container.querySelector('.fw-team-pinned') as HTMLElement;
    expect(pinned).not.toBeNull();
    expect(within(pinned).getByText('Vastgepind')).toBeInTheDocument();
    expect(within(pinned).getByText('GO: Bouwer start met de strook')).toBeInTheDocument();
    expect(within(pinned).getByText('Besluit')).toBeInTheDocument();

    expect(screen.getByText('Bouwer draagt B4 over aan Tester')).toBeInTheDocument();
    expect(screen.getByText('Vraag')).toBeInTheDocument();
    expect(screen.getByText('Blokkade')).toBeInTheDocument();
    const via = screen.getByText('via Lead');
    expect(via).toHaveAttribute('title', 'De Projectleider gaf dit bericht door; de helper schreef het niet zelf.');
    // The decision is not repeated in the flow below.
    expect(screen.getAllByText('GO: Bouwer start met de strook')).toHaveLength(1);
  });

  it('filters the channel per taak', () => {
    renderPanel(chatFrom(CHAT_FIXTURE));
    fireEvent.change(screen.getByLabelText('Taak'), { target: { value: 'B6' } });
    expect(screen.getByText('Handleiding bijgewerkt')).toBeInTheDocument();
    expect(screen.queryByText('Knop valt buiten beeld op telefoon')).toBeNull();
  });

  it('a missing or empty channel shows the empty state, never made-up activity', () => {
    renderPanel(EMPTY_CHAT);
    expect(screen.getByText('Nog geen teamberichten in deze klus.')).toBeInTheDocument();
    expect(screen.getByText('Hier verschijnt alleen wat het team echt heeft geschreven.')).toBeInTheDocument();
  });

  it('a project without klussen says so', () => {
    render(
      <MemoryRouter>
        <TeamPanel runs={[]} runId={null} onRunChange={vi.fn()} statuses={new Map()} chat={EMPTY_CHAT} hasProject />
      </MemoryRouter>,
    );
    expect(screen.getByText('Nog geen klussen in dit project.')).toBeInTheDocument();
  });
});
