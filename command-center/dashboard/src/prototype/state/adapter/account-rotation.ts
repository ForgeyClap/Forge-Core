/**
 * Forge Command Center — gateway adapter, account-rotation slice.
 *
 * Reads `GET /api/account-rotation` (gateway/src/account-rotation.mjs): the account rotator's
 * token-free notification + its 'recommend' handoff, reduced by the gateway to labels, percentages,
 * statuses and timestamps. Nothing here can carry a token — the gateway never reads one — and this
 * parser only keeps the same allowlisted fields again.
 *
 * Honesty: a percentage is the rotator's own number or null (rendered as "—", never 0), and every
 * account keeps the rotator's own status word ('live' | 'estimated' | 'unknown' | 'unmeasurable').
 */

import { useCallback, useEffect, useState } from 'react';

import { gwGet, pickArray, pickBool, pickNumber, pickRecord, pickString } from '@/prototype/state/gateway-client';

import type { LoadStatus } from './mindmaps';

export type RotatorAccountStatus = 'live' | 'estimated' | 'unknown' | 'unmeasurable';

export interface RotatorWindow {
  readonly label: string;
  readonly pct: number | null;
  readonly resetsAt: string | null;
}

export interface RotatorAccount {
  readonly name: string;
  readonly status: RotatorAccountStatus;
  readonly maxPct: number | null;
  readonly usable: boolean | null;
  readonly needsRelogin: boolean;
  readonly measuredAt: string | null;
  readonly windows: readonly RotatorWindow[];
}

export interface RotatorRecommendation {
  readonly to: string;
  readonly from: string | null;
  readonly why: string | null;
  readonly tier: string | null;
  readonly at: string | null;
  readonly trigger: readonly { readonly label: string; readonly pct: number | null }[];
  /** 'state' = the rotator's own notification, 'handoff' = forge-accounts/handoff.json phase 'recommend'. */
  readonly source: 'state' | 'handoff';
}

export interface RotatorSwitch {
  readonly from: string | null;
  readonly to: string | null;
  readonly at: string | null;
  readonly reason: string | null;
  readonly outcome: string | null;
}

export interface AccountRotation {
  /** 'REPORTED' | 'NOT SET UP' | 'UNREADABLE' */
  readonly provenance: string | null;
  readonly setUp: boolean;
  readonly note: string | null;
  readonly threshold: number;
  readonly thresholdIsDefault: boolean;
  readonly mode: string | null;
  readonly active: string | null;
  readonly updatedAt: string | null;
  readonly disabled: boolean | null;
  readonly recommendation: RotatorRecommendation | null;
  readonly lastSwitch: RotatorSwitch | null;
  readonly accounts: readonly RotatorAccount[];
}

const STATUSES: readonly RotatorAccountStatus[] = ['live', 'estimated', 'unknown', 'unmeasurable'];
export const ROTATOR_DEFAULT_THRESHOLD = 92;

export const EMPTY_ACCOUNT_ROTATION: AccountRotation = {
  provenance: null,
  setUp: false,
  note: null,
  threshold: ROTATOR_DEFAULT_THRESHOLD,
  thresholdIsDefault: true,
  mode: null,
  active: null,
  updatedAt: null,
  disabled: null,
  recommendation: null,
  lastSwitch: null,
  accounts: [],
};

function parseTrigger(rec: Record<string, unknown>): RotatorRecommendation['trigger'] {
  return pickArray(rec, ['trigger']).map((t) => ({ label: pickString(t, ['label']) ?? 'window', pct: pickNumber(t, ['pct']) }));
}

function parseRecommendation(rec: Record<string, unknown> | null, source: 'state' | 'handoff'): RotatorRecommendation | null {
  if (rec === null) return null;
  const to = pickString(rec, ['to']);
  if (to === null) return null;
  return {
    to,
    from: pickString(rec, ['from']),
    why: pickString(rec, ['why']),
    tier: pickString(rec, ['tier']),
    at: pickString(rec, ['at']),
    trigger: parseTrigger(rec),
    source,
  };
}

export function parseAccountRotation(data: Record<string, unknown>): AccountRotation {
  const provenance = pickString(data, ['provenance']);
  const threshold = pickNumber(data, ['threshold']);
  const sw = pickRecord(data, ['last_switch']);
  const accounts: RotatorAccount[] = [];
  for (const a of pickArray(data, ['accounts'])) {
    const name = pickString(a, ['name']);
    if (name === null) continue;
    const status = pickString(a, ['status']);
    accounts.push({
      name,
      status: STATUSES.includes(status as RotatorAccountStatus) ? (status as RotatorAccountStatus) : 'unknown',
      maxPct: pickNumber(a, ['max_pct']),
      usable: pickBool(a, ['usable']),
      needsRelogin: pickBool(a, ['needs_relogin']) ?? false,
      measuredAt: pickString(a, ['measured_at']),
      windows: pickArray(a, ['windows']).map((w) => ({
        label: pickString(w, ['label']) ?? 'window',
        pct: pickNumber(w, ['pct']),
        resetsAt: pickString(w, ['resets_at']),
      })),
    });
  }
  return {
    provenance,
    setUp: provenance === 'REPORTED',
    note: pickString(data, ['note']),
    threshold: threshold ?? ROTATOR_DEFAULT_THRESHOLD,
    thresholdIsDefault: threshold === null || pickString(data, ['threshold_source']) === 'default',
    mode: pickString(data, ['mode']),
    active: pickString(data, ['active']),
    updatedAt: pickString(data, ['updated_at']),
    disabled: pickBool(data, ['disabled']),
    // The rotator's own state wins; the handoff file is the fallback (it can exist before the first
    // notification write).
    recommendation:
      parseRecommendation(pickRecord(data, ['recommendation']), 'state') ??
      parseRecommendation(pickRecord(data, ['handoff_recommendation']), 'handoff'),
    lastSwitch: sw === null
      ? null
      : { from: pickString(sw, ['from']), to: pickString(sw, ['to']), at: pickString(sw, ['at']), reason: pickString(sw, ['reason']), outcome: pickString(sw, ['outcome']) },
    accounts,
  };
}

const ACCOUNT_ROTATION_POLL_MS = 30_000;

export function useAccountRotation(): { status: LoadStatus; value: AccountRotation; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ status: LoadStatus; value: AccountRotation; error: string | null }>({
    status: 'loading', value: EMPTY_ACCOUNT_ROTATION, error: null,
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet('/api/account-rotation');
      if (cancelled) return;
      if (result.ok) setState({ status: 'ready', value: parseAccountRotation(result.data), error: null });
      else setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', value: EMPTY_ACCOUNT_ROTATION, error: result.error }));
    }
    void tick();
    const id = setInterval(() => void tick(), ACCOUNT_ROTATION_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [nonce]);
  return { ...state, reload };
}
