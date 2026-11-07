/**
 * FU (review medium, chat lane): in Eenvoudig the limit meter starts collapsed to one toggle,
 * so a beginner mostly sees only that toggle. When the limit is almost used up (5 hours OR week at
 * 90 % or more) the toggle must say so in a way that does not depend on colour alone: in this
 * old monochrome token set the failed status colour was plain black / white, which is what the toggle text
 * already is. Pinned here:
 *   - a warning icon and the visible words "bijna op" inside the toggle (so they are also part of the
 *     button's accessible name);
 *   - a polite live region that announces "Let op: je limiet is bijna op (...)" and stays empty below
 *     the threshold;
 *   - a CSS rule for the alert state that draws a heavier border (a shape cue, not a hue).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { setLocale } from '@/i18n';
import nl from '@/i18n/locales/nl.json';
import { NEAR_LIMIT_PERCENT, UsageSummaryToggle } from '@/views/chat/sessions/UsageMeter';
import type { UsageMeterReading } from '@/views/chat/sessions/usage-reading';

function renderToggle(reading: UsageMeterReading) {
  return render(
    createElement(UsageSummaryToggle, { reading, expanded: false, controls: 'usage-panel', onToggle: () => undefined }),
  );
}

const measured = (session: number | null, week: number | null): UsageMeterReading => ({
  state: 'measured',
  session,
  week,
  sessionResetAt: null,
});

beforeEach(() => {
  setLocale('nl');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('UsageSummaryToggle near the limit (Eenvoudig, collapsed)', () => {
  it('the threshold is 90 %', () => {
    expect(NEAR_LIMIT_PERCENT).toBe(90);
  });

  it('week at 92 %: warning icon, visible "bijna op" text in the accessible name, and a spoken alert', () => {
    renderToggle(measured(42, 92));
    const button = screen.getByRole('button', { name: /Je limiet/ });
    expect(button).toHaveAttribute('data-alert', 'near-limit');
    expect(button.querySelector('.fw-usage-toggle__alert-icon')).not.toBeNull();
    const words = button.querySelector('.fw-usage-toggle__alert');
    expect(words).not.toBeNull();
    expect(words?.textContent).toBe(nl.chat.usage.nearLimitShort);
    // Visible text, not only a screen-reader hint.
    expect(words?.closest('.fw-visually-hidden')).toBeNull();
    expect(button).toHaveAccessibleName(/bijna op/);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.textContent).toContain('Let op: je limiet is bijna op');
    expect(status.textContent).toContain('week 92%');
  });

  it('5 hours at exactly 90 % also counts, and the spoken alert names the 5-hour value', () => {
    renderToggle(measured(90, 40));
    const button = screen.getByRole('button', { name: /Je limiet/ });
    expect(button).toHaveAttribute('data-alert', 'near-limit');
    expect(screen.getByRole('status').textContent).toContain('5 uur 90%');
  });

  it('both high: the spoken alert names both values', () => {
    renderToggle(measured(95, 91));
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('5 uur 95%');
    expect(text).toContain('week 91%');
  });

  it('89 % (high, not near the limit): no alert icon, no "bijna op", an empty live region', () => {
    renderToggle(measured(89, 85));
    const button = screen.getByRole('button', { name: /Je limiet/ });
    expect(button).not.toHaveAttribute('data-alert');
    expect(button.querySelector('.fw-usage-toggle__alert-icon')).toBeNull();
    expect(button.textContent).not.toContain(nl.chat.usage.nearLimitShort);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('a stale reading from a watcher that is down never raises the alert (the number is not about now)', () => {
    renderToggle({ state: 'stale', session: null, week: 95, sessionResetAt: null, staleReason: 'watcher' });
    expect(screen.getByRole('button', { name: /Je limiet/ })).not.toHaveAttribute('data-alert');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('not measured: no alert', () => {
    renderToggle({ state: 'unmeasured', session: null, week: null, sessionResetAt: null });
    expect(screen.getByRole('button', { name: /Je limiet/ })).not.toHaveAttribute('data-alert');
  });

  it('chat.css draws the alert state with a heavier border, not with a hue alone', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/views/chat/chat.css'), 'utf8');
    const rule = /\.fw-usage-toggle\[data-alert='near-limit'\]\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'missing .fw-usage-toggle[data-alert=near-limit] rule').not.toBeNull();
    // Redesign 2A: chat.css moved from the old alias names to the v1.0 tokens they resolved to.
    expect(rule?.[1]).toMatch(/border-width:\s*2px/);
    expect(rule?.[1]).toMatch(/border-color:[^;]*var\(--fs-danger\)/);
  });
});
