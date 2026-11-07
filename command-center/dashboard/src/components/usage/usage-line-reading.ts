/**
 * usage-line-reading — when the usage line above the composer appears (DESIGN.md §2): at 80 % or more of
 * a CURRENT value. It reads the same `readUsageMeter` as the chat meter, so a stale 5-hour value never
 * raises the line and a down watcher never does either.
 */

import type { GatewayAccountUsage } from '@/prototype/state/gateway-adapter';
import { readUsageMeter } from '@/views/chat/sessions/usage-reading';

/** At or above this percentage (5 hours or week, current values only) the line appears. */
export const USAGE_LINE_PERCENT = 80;

/** The highest current percentage at or above the threshold, or null. */
export function usageLinePercent(usage: GatewayAccountUsage, now?: number): number | null {
  const reading = readUsageMeter(usage, now);
  const values =
    reading.state === 'measured'
      ? [reading.session, reading.week]
      : reading.state === 'stale' && reading.staleReason === 'reset-passed'
        ? [reading.week]
        : [];
  const near = values.filter((value): value is number => value !== null && value >= USAGE_LINE_PERCENT);
  return near.length > 0 ? Math.max(...near) : null;
}

