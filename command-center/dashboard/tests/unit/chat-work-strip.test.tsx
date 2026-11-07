/**
 * ChatWorkStrip (redesign 2A, DESIGN.md §3.2): the four steps are read from the live klus's REAL helper
 * statuses only. Pins the honesty rules: a running helper makes its step "now", only finished helpers
 * make it "done", an untouched or merely queued step stays an empty "todo" (never "Wacht op jou"), and
 * the "N helpers bezig" count is the real number of running helpers.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import type { RoleSlug, RoleStatus } from '@/views/team/team-data';
import { ChatWorkStripView, PHASE_ROLES, busyCount, phaseState } from '@/views/chat/work-strip/ChatWorkStrip';

function statuses(entries: readonly [RoleSlug, RoleStatus][]): ReadonlyMap<RoleSlug, RoleStatus> {
  return new Map(entries);
}

describe('ChatWorkStrip — steps from real helper statuses', () => {
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('a running helper makes its step "now"; only finished helpers make it "done"', () => {
    const s = statuses([
      ['head-chef', 'done'],
      ['build-boss', 'done'],
      ['ui-boss', 'busy'],
    ]);
    expect(phaseState(s, PHASE_ROLES.plan)).toBe('done');
    expect(phaseState(s, PHASE_ROLES.build)).toBe('now');
    expect(phaseState(s, PHASE_ROLES.check)).toBe('todo');
  });

  it('a queued (dispatched, not running) helper never reads as "waiting on you"', () => {
    const s = statuses([['test-boss', 'waiting']]);
    expect(phaseState(s, PHASE_ROLES.check)).toBe('todo');
  });

  it('counts only running helpers', () => {
    expect(busyCount(statuses([['ui-boss', 'busy'], ['test-boss', 'busy'], ['docs-boss', 'done']]))).toBe(2);
    expect(busyCount(statuses([]))).toBe(0);
  });

  it('renders the four Dutch step names and the helper count, with a hidden state word per step', () => {
    setLocale('nl');
    render(
      createElement(ChatWorkStripView, {
        statuses: statuses([
          ['head-chef', 'done'],
          ['build-boss', 'done'],
          ['verify-boss', 'busy'],
          ['test-boss', 'busy'],
        ]),
      }),
    );
    const strip = screen.getByRole('list');
    expect(strip.textContent).toContain('Plannen');
    expect(strip.textContent).toContain('Bouwen');
    expect(strip.textContent).toContain('Controleren');
    expect(strip.textContent).toContain('Opleveren');
    expect(screen.getByText('2 helpers bezig')).toBeInTheDocument();
    expect(screen.queryByText(/Wacht op jou/)).toBeNull();
  });

  it('every helper role belongs to exactly one step', () => {
    const all = Object.values(PHASE_ROLES).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
