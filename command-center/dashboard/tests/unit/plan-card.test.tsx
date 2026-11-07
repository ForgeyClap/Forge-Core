/**
 * WP B3 — the team-job plan card: steps with Dutch role names, the estimate band (minutes always,
 * share of the limit only with history), the three buttons, and the route table kept out of copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import en from '@/i18n/locales/en.json';
import nl from '@/i18n/locales/nl.json';
import { PlanCard } from '@/views/chat/plan-card/PlanCard';
import { ROUTE_PROFILE, estimatePlan } from '@/views/chat/plan-card/plan-estimate';
import type { TeamPlan } from '@/views/chat/plan-card/plan-estimate';

const PLAN: TeamPlan = {
  title: 'Website voor bakkerij De Korenaar',
  route: 'build',
  steps: [
    { title: 'Inschatting en plan', role: 'Head Chef' },
    { title: 'Drie pagina’s bouwen', role: 'Build Boss' },
    { title: 'Ontwerp en leesbaarheid', role: 'ui-boss' },
    { title: 'Testen op telefoon en computer', role: 'Test Boss' },
  ],
};

describe('plan card', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  it('estimate: minutes from the route bands, limit share unknown without history', () => {
    const estimate = estimatePlan(PLAN);
    expect(estimate).toMatchObject({ steps: 4, helpers: 4, units: 16, minutes: [24, 60], limitPct: null });
    expect(ROUTE_PROFILE.build).toMatchObject({ model: 'opus', effort: 'medium' });
    expect(estimatePlan({ ...PLAN, history: { limitPctPerUnit: 1 } }).limitPct).toEqual([11, 21]);
    expect(estimatePlan({ ...PLAN, route: 'deep', history: { limitPctPerUnit: 10 } }).limitPct).toEqual([100, 100]);
  });

  it('renders steps, Dutch role names, the band and three buttons', () => {
    const onStart = vi.fn();
    const onAdjust = vi.fn();
    const onLater = vi.fn();
    render(<PlanCard plan={PLAN} onStart={onStart} onAdjust={onAdjust} onLater={onLater} />);
    expect(screen.getByRole('heading', { name: PLAN.title })).toBeInTheDocument();
    expect(screen.getByText('4 stappen')).toBeInTheDocument();
    expect(screen.getByText('4 helpers')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(4);
    for (const role of ['Planner', 'Bouwer', 'Ontwerper', 'Tester']) expect(screen.getByText(`door ${role}`)).toBeInTheDocument();
    expect(screen.getByText('ongeveer 24–60 minuten')).toBeInTheDocument();
    expect(screen.getByText('deel van je limiet nog onbekend')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aanpassen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Niet nu' }));
    expect([onStart, onAdjust, onLater].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('with history it shows a percentage band; starting disables the buttons', () => {
    render(<PlanCard plan={{ ...PLAN, history: { limitPctPerUnit: 1 } }} onStart={vi.fn()} onAdjust={vi.fn()} onLater={vi.fn()} starting />);
    expect(screen.getByText('ongeveer 11–21% van je limiet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('the copy never names the routing table, in any language', () => {
    expect(JSON.stringify(nl.chatCards)).not.toMatch(/GOAT|opus|sonnet|effort/i);
    expect(JSON.stringify(en.chatCards)).not.toMatch(/GOAT|opus|sonnet|effort/i);
  });
});
