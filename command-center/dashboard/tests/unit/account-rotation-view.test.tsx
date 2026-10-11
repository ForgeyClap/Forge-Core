/**
 * AccountRotationView — parser + stubbed-fetch view tests. The gateway side (temp-home fixtures,
 * the "never opens a vault file" spy) is covered by gateway/test/account-rotation.test.mjs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';

import { parseAccountRotation } from '@/prototype/state/adapter/account-rotation';
import AccountRotationView, { NOT_SET_UP_TITLE } from '@/views/accounts/AccountRotationView';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;

const REPORTED = {
  ok: true, provenance: 'REPORTED', note: null, threshold: 92, threshold_source: 'rotator', mode: 'token', active: 'work',
  updated_at: '2026-10-09T20:00:00.000Z', disabled: false,
  recommendation: { to: 'personal', from: 'work', tier: 'clear', why: 'clear 31%', at: '2026-10-09T20:00:00.000Z', trigger: [{ label: 'session', pct: 94 }] },
  handoff_recommendation: null,
  last_switch: { from: 'personal', to: 'work', at: '2026-10-08T09:00:00.000Z', reason: 'threshold', outcome: 'verified' },
  accounts: [
    { name: 'work', status: 'live', max_pct: 94, usable: false, needs_relogin: false, measured_at: '2026-10-09T19:59:00.000Z',
      windows: [{ label: 'session', pct: 94, resets_at: null }, { label: 'weekly (all)', pct: 61, resets_at: null }] },
    { name: 'personal', status: 'estimated', max_pct: 31, usable: true, needs_relogin: false, measured_at: null,
      windows: [{ label: 'session', pct: 12, resets_at: null }, { label: 'weekly (all)', pct: 31, resets_at: null }] },
    { name: 'spare', status: 'unmeasurable', max_pct: null, usable: null, needs_relogin: true, measured_at: null, windows: [] },
  ],
};

describe('parseAccountRotation', () => {
  it('keeps the rotator’s own numbers and statuses, null stays null', () => {
    const r = parseAccountRotation(REPORTED);
    expect(r.setUp).toBe(true);
    expect(r.threshold).toBe(92);
    expect(r.thresholdIsDefault).toBe(false);
    expect(r.recommendation?.to).toBe('personal');
    expect(r.recommendation?.source).toBe('state');
    expect(r.accounts.map((a) => a.status)).toEqual(['live', 'estimated', 'unmeasurable']);
    expect(r.accounts[2].maxPct).toBeNull();
  });

  it('falls back to the handoff recommendation and to 92% when nothing else is known', () => {
    const r = parseAccountRotation({ ok: true, provenance: 'NOT SET UP', threshold: 92, threshold_source: 'default', accounts: [], handoff_recommendation: { to: 'b', from: 'a' } });
    expect(r.setUp).toBe(false);
    expect(r.thresholdIsDefault).toBe(true);
    expect(r.recommendation).toMatchObject({ to: 'b', from: 'a', source: 'handoff' });
  });

  it('maps an unknown status word to "unknown"', () => {
    expect(parseAccountRotation({ accounts: [{ name: 'x', status: 'awesome' }] }).accounts[0].status).toBe('unknown');
  });
});

describe('AccountRotationView', () => {
  it('says "Rotator not set up" when the rotator files are absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ok: true, provenance: 'NOT SET UP', note: 'rotator not set up', threshold: 92, threshold_source: 'default', accounts: [] })));
    render(createElement(AccountRotationView));
    expect(await screen.findByText(NOT_SET_UP_TITLE)).toBeInTheDocument();
    expect(NOT_SET_UP_TITLE).toBe('Rotator not set up');
  });

  it('shows active, recommended, per-window % with the 92% marker, last switch and honest tags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(REPORTED)));
    render(createElement(AccountRotationView));

    const hero = await screen.findByRole('region', { name: 'Recommendation' });
    expect(within(hero).getByText('personal')).toBeInTheDocument();
    expect(within(hero).getByText('work')).toBeInTheDocument();
    expect(within(hero).getByText(/reached session 94%/)).toBeInTheDocument();

    expect(screen.getByText('Active account').nextElementSibling?.textContent).toBe('work');
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText(/personal → work · threshold/)).toBeInTheDocument();

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.getByText('Estimated')).toBeInTheDocument();
    expect(screen.getByText('Unmeasurable')).toBeInTheDocument();
    expect(screen.getByText('Needs a new login')).toBeInTheDocument();

    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(4);
    expect(meters[0]).toHaveAttribute('aria-valuetext', '94%, switch threshold 92%');
    expect(meters[0].querySelector('.fw-rot-window__threshold')).toHaveStyle({ insetInlineStart: '92%' });
    expect(meters[0].closest('.fw-rot-window')).toHaveAttribute('data-over', 'true');
    expect(meters[1].closest('.fw-rot-window')).toHaveAttribute('data-over', 'false');
  });

  it('never renders a token even if one slipped into the response', async () => {
    const leak = 'sk-ant-oat01-' + 'Q'.repeat(50);
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...REPORTED, token: leak, accounts: [{ ...REPORTED.accounts[0], accessToken: leak }] })));
    const { container } = render(createElement(AccountRotationView));
    await screen.findByRole('region', { name: 'Recommendation' });
    expect(container.innerHTML).not.toContain(leak);
  });
});
