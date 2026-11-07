/**
 * Pure reading of the `/api/usage` answer for the chat's usage meter (WP B3).
 *
 * WP B3-ui fix round: a percentage is only shown as "now" when it is current. The guard's numbers
 * come from a watcher that writes them on an interval:
 *   - guard not available            -> 'unmeasured' (no numbers at all, the honest not-measured state);
 *   - watcher 'not-running'/'stale'  -> 'stale': the 5-hour value and its reset time are dropped, the
 *                                       week value stays and the meter says "verouderd";
 *   - 5-hour reset time in the past  -> 'stale' as well: that window already started over, so the
 *                                       stored 5-hour percentage no longer describes it.
 *
 * FU fix round: `staleReason` says WHY. After a passed reset only the 5-hour value is old; the week value
 * is still current, so it keeps driving the near-limit warning (`nearLimitValues`). While the watcher is
 * down neither number is about now and nothing warns. The chat toggle, the full meter and the sidebar pill
 * (AccountUsagePressure.tsx) all read through this one module, so one screen never shows two readings.
 */

import type { GatewayAccountUsage } from '@/prototype/state/gateway-adapter';
import { isGuardWatcherDown } from '@/prototype/state/guard-label';

export type UsageMeterState = 'measured' | 'stale' | 'unmeasured';

/** Why a reading is stale: the watcher is not checking ('watcher'), or the 5-hour window started over. */
export type UsageStaleReason = 'watcher' | 'reset-passed';

/** At or above this percentage (5 hours or week, current values only) the UI says the limit is almost used up. */
export const NEAR_LIMIT_PERCENT = 90;

export interface UsageMeterReading {
  readonly state: UsageMeterState;
  readonly session: number | null;
  readonly week: number | null;
  readonly sessionResetAt: string | null;
  /** Only on a 'stale' reading. */
  readonly staleReason?: UsageStaleReason;
}

const UNMEASURED: UsageMeterReading = { state: 'unmeasured', session: null, week: null, sessionResetAt: null };

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** The percentages the meter may show at `now`, or the honest not-measured / stale state. */
export function readUsageMeter(usage: GatewayAccountUsage, now: number = Date.now()): UsageMeterReading {
  const guard = usage.guard;
  if (!guard.available) return UNMEASURED;
  const week = clampPercent(guard.weekPercent ?? usage.week);
  const session = clampPercent(guard.sessionPercent);
  const resetMs = guard.sessionResetAt !== null ? Date.parse(guard.sessionResetAt) : Number.NaN;
  const resetPassed = Number.isFinite(resetMs) && resetMs <= now;
  const watcherDown = isGuardWatcherDown(guard);
  if (watcherDown || resetPassed) {
    if (week === null && session === null) return UNMEASURED;
    return { state: 'stale', session: null, week, sessionResetAt: null, staleReason: watcherDown ? 'watcher' : 'reset-passed' };
  }
  if (session === null && week === null) return UNMEASURED;
  return { state: 'measured', session, week, sessionResetAt: Number.isFinite(resetMs) ? guard.sessionResetAt : null };
}

/** The values that are current AND at or above NEAR_LIMIT_PERCENT; null for every other value. */
export function nearLimitValues(reading: UsageMeterReading): { readonly session: number | null; readonly week: number | null } {
  const near = (value: number | null): number | null => (value !== null && value >= NEAR_LIMIT_PERCENT ? value : null);
  if (reading.state === 'measured') return { session: near(reading.session), week: near(reading.week) };
  if (reading.state === 'stale' && reading.staleReason === 'reset-passed') return { session: null, week: near(reading.week) };
  return { session: null, week: null };
}

/** True when the reading may only be shown with an "out of date" mark (both numbers are old). */
export function isReadingOutdated(reading: UsageMeterReading): boolean {
  return reading.state === 'stale' && reading.staleReason !== 'reset-passed';
}
