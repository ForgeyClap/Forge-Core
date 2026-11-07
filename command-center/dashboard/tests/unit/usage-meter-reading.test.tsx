/**
 * WP B3-ui fix round: the chat's limit meter only shows the 5-hour bar when the number is current.
 * A watcher that is not running or stale, a missing guard, or a 5-hour reset time that already
 * passed means the stored percentage no longer describes "now": the 5-hour bar and the reset note
 * go, and the meter says so in Dutch ("verouderd") or shows the honest not-measured state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { parseAccountUsage } from '@/prototype/state/adapter/connection';
import { readUsageMeter } from '@/views/chat/sessions/usage-reading';
import { UsageMeterView } from '@/views/chat/sessions/UsageMeter';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const IN_95_MIN = new Date(NOW + 95 * 60_000).toISOString();
const TEN_MIN_AGO = new Date(NOW - 10 * 60_000).toISOString();

function usage(guard: Record<string, unknown>) {
  return parseAccountUsage({ ok: true, provenance: 'REPORTED', week: 18, guard });
}

const FRESH_GUARD = { available: true, mode: 'ok', watcher: 'running', session_pct: 42, week_pct: 18, session_reset_at: IN_95_MIN };

beforeEach(() => setLocale('nl'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('readUsageMeter', () => {
  it('a running watcher with a future reset: both bars and the reset time', () => {
    const reading = readUsageMeter(usage(FRESH_GUARD), NOW);
    expect(reading).toEqual({ state: 'measured', session: 42, week: 18, sessionResetAt: IN_95_MIN });
  });

  it.each(['stale', 'not-running'])('watcher "%s": the 5-hour value and its reset are dropped and marked stale', (watcher) => {
    const reading = readUsageMeter(usage({ ...FRESH_GUARD, watcher }), NOW);
    expect(reading.state).toBe('stale');
    expect(reading.session).toBeNull();
    expect(reading.sessionResetAt).toBeNull();
  });

  it('a 5-hour reset time in the past: the old percentage is not shown as current', () => {
    const reading = readUsageMeter(usage({ ...FRESH_GUARD, session_reset_at: TEN_MIN_AGO }), NOW);
    expect(reading.state).toBe('stale');
    expect(reading.session).toBeNull();
    expect(reading.sessionResetAt).toBeNull();
    expect(reading.week).toBe(18);
  });

  it('guard not available: the honest not-measured state, no numbers at all', () => {
    const reading = readUsageMeter(usage({ available: false, session_pct: 42, week_pct: 18 }), NOW);
    expect(reading).toEqual({ state: 'unmeasured', session: null, week: null, sessionResetAt: null });
  });
});

describe('UsageMeterView', () => {
  it('stale watcher: Dutch "verouderd" label, no 5-hour meter, no reset note', () => {
    render(createElement(UsageMeterView, { reading: readUsageMeter(usage({ ...FRESH_GUARD, watcher: 'stale' }), NOW) }));
    expect(screen.getByText(/verouderd/i)).toBeInTheDocument();
    expect(screen.queryByRole('meter', { name: '5 uur' })).toBeNull();
    expect(screen.queryByText(/weer vol om/)).toBeNull();
  });

  it('a past reset time: no 5-hour meter, no "weer vol om" note, and it says the 5-hour window started over', () => {
    render(
      createElement(UsageMeterView, {
        reading: readUsageMeter(usage({ ...FRESH_GUARD, session_reset_at: TEN_MIN_AGO }), NOW),
      }),
    );
    expect(screen.queryByRole('meter', { name: '5 uur' })).toBeNull();
    expect(screen.queryByText(/weer vol om/)).toBeNull();
    // FU fix round (review low): only the 5-hour value is old here, so "verouderd" (which would also
    // brand the still-current week value) is replaced by what actually happened.
    expect(screen.getByText(/5 uur: net opnieuw begonnen/)).toBeInTheDocument();
    expect(screen.queryByText(/verouderd/i)).toBeNull();
  });

  it('guard not available: says it was not measured, shows no meter', () => {
    render(createElement(UsageMeterView, { reading: readUsageMeter(usage({ available: false }), NOW) }));
    expect(screen.getByText('Nog niet bekend: Forge heeft je limiet nog niet gemeten.')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
  });
});
