/**
 * FU fix round (review mediums/lows of), usage lane:
 *   (1) a reading marked stale ONLY because the 5-hour reset passed still has a current week value: a
 *       week of 90 % or more must raise the "bijna op" warning, and the toggle must not call that week
 *       number "verouderd" (only the 5-hour number was dropped);
 *   (2) the shell's usage signal and the chat toggle read the SAME reading (one shared helper). Redesign
 *       1C replaced the corner pill with the usage line above the composer (`UsageLine`, DESIGN.md §2):
 *       it never shows a 5-hour value the toggle hides, never rises on a stale reading, and says the
 *       limit in words (icon + sentence), not with a colour alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { setLocale } from '@/i18n';
import nl from '@/i18n/locales/nl.json';
import { parseAccountUsage } from '@/prototype/state/adapter/connection';
import { UsageLineView } from '@/components/usage/UsageLine';
import { UsageMeterView, UsageSummaryToggle } from '@/views/chat/sessions/UsageMeter';
import { nearLimitValues, readUsageMeter } from '@/views/chat/sessions/usage-reading';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const IN_95_MIN = new Date(NOW + 95 * 60_000).toISOString();
const TEN_MIN_AGO = new Date(NOW - 10 * 60_000).toISOString();

function usage(guard: Record<string, unknown>, week = 92) {
  return parseAccountUsage({ ok: true, provenance: 'REPORTED', level: 'normal', week, updated_at: new Date(NOW - 60_000).toISOString(), guard });
}

const RUNNING = { available: true, mode: 'ok', watcher: 'running', session_pct: 7, week_pct: 92 };
const RESET_PASSED = usage({ ...RUNNING, session_reset_at: TEN_MIN_AGO });
const WATCHER_DOWN = usage({ ...RUNNING, watcher: 'stale', session_reset_at: IN_95_MIN });
const FRESH = usage({ ...RUNNING, session_reset_at: IN_95_MIN });

function toggle(reading: ReturnType<typeof readUsageMeter>) {
  return render(createElement(UsageSummaryToggle, { reading, expanded: false, controls: 'p', onToggle: () => undefined }));
}

function line(u: ReturnType<typeof usage>) {
  return render(createElement(UsageLineView, { usage: u, now: NOW }));
}

beforeEach(() => setLocale('nl'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('(1) stale only because the 5-hour window reset: the week value still counts', () => {
  it('readUsageMeter names the reason of the stale state', () => {
    expect(readUsageMeter(RESET_PASSED, NOW)).toMatchObject({ state: 'stale', staleReason: 'reset-passed', session: null, week: 92 });
    expect(readUsageMeter(WATCHER_DOWN, NOW)).toMatchObject({ state: 'stale', staleReason: 'watcher', session: null, week: 92 });
  });

  it('nearLimitValues: the week counts after a reset, never while the watcher is down', () => {
    expect(nearLimitValues(readUsageMeter(RESET_PASSED, NOW))).toEqual({ session: null, week: 92 });
    expect(nearLimitValues(readUsageMeter(WATCHER_DOWN, NOW))).toEqual({ session: null, week: null });
    expect(nearLimitValues(readUsageMeter(FRESH, NOW))).toEqual({ session: null, week: 92 });
  });

  it('the chat toggle warns "bijna op" for week 92 % after the 5-hour reset, and does not call the week "verouderd"', () => {
    toggle(readUsageMeter(RESET_PASSED, NOW));
    const button = screen.getByRole('button', { name: /Je limiet/ });
    expect(button).toHaveAttribute('data-alert', 'near-limit');
    expect(button).toHaveAccessibleName(/bijna op/);
    expect(button.textContent).not.toContain(nl.chat.usage.staleShort);
    expect(screen.getByRole('status').textContent).toContain('week 92%');
  });

  it('a watcher that is down still never warns (neither number is about now) and says "verouderd"', () => {
    toggle(readUsageMeter(WATCHER_DOWN, NOW));
    const button = screen.getByRole('button', { name: /Je limiet/ });
    expect(button).not.toHaveAttribute('data-alert');
    expect(button.textContent).toContain(nl.chat.usage.staleShort);
  });

  it('the full meter explains the 5-hour window started over instead of calling the reading "verouderd"', () => {
    render(createElement(UsageMeterView, { reading: readUsageMeter(RESET_PASSED, NOW) }));
    expect(screen.getByText(nl.chat.usage.sessionRestarted)).toBeInTheDocument();
    expect(screen.queryByText(/verouderd/i)).toBeNull();
  });
});

describe('(2) the usage line uses the same reading as the chat toggle', () => {
  it('after the 5-hour reset the line ignores the old 5-hour value and names the current week 92 %', () => {
    const { container } = line(RESET_PASSED);
    const text = container.textContent ?? '';
    expect(text).not.toContain('7 %');
    expect(text).toContain('92 %');
  });

  it('near the limit the line has an icon and a sentence (not colour alone), spoken as a status', () => {
    const { container } = line(RESET_PASSED);
    expect(container.querySelector('.fw-usage-line__icon')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Je limiet is bijna op/);
  });

  it('a fresh reading names the highest current value', () => {
    line(FRESH);
    expect(screen.getByRole('status').textContent).toContain('92 %');
  });

  it('watcher down: no line at all (neither number is about now)', () => {
    const { container } = line(WATCHER_DOWN);
    expect(container.firstChild).toBeNull();
  });

  it('below 80 % no line', () => {
    const { container } = line(usage({ ...RUNNING, week_pct: 70, session_pct: 10, session_reset_at: IN_95_MIN }, 70));
    expect(container.firstChild).toBeNull();
  });

  it('the old corner pill is gone: the shell mounts no usage element of its own', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/shell/AppShell.tsx'), 'utf8');
    expect(source).not.toMatch(/import[^;]*(AccountUsagePressure|UsageLine)/);
    expect(existsSync(resolve(process.cwd(), 'src/components/usage/account-usage-pressure.css'))).toBe(false);
  });
});
