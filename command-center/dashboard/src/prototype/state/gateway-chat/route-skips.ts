/**
 * route-skips — the router steps skipped while choosing a turn's route (Q6-UI, contract C1).
 *
 * The gateway writes `data.skipped` on `route_selected`, `route_switched`, (chain exhausted after skips)
 * `route_exhausted` and `execution_not_started`: an array of {target_id, label, provider, reason}, reason 'provider_unavailable' (the own
 * API was deleted, switched off or refused) | 'paid_ack_required' (keyed, costs not confirmed). Missing = [].
 * Read defensively: an item without a target id is dropped, an unknown reason is kept as 'unknown' so the line
 * still names the step, and labels are cut to a readable length.
 */

import { pickArray, pickString } from '@/prototype/state/gateway-client';

export type ChatRouteSkipReason = 'provider_unavailable' | 'paid_ack_required' | 'unknown';

export interface ChatRouteSkip {
  readonly targetId: string;
  readonly label: string;
  readonly provider: string | null;
  readonly reason: ChatRouteSkipReason;
}

const REASONS: ReadonlySet<string> = new Set(['provider_unavailable', 'paid_ack_required']);
const MAX_LABEL = 80;

/** The `skipped` array of one event's data (or route record); [] when missing or not an array. */
export function parseRouteSkips(data: Record<string, unknown> | null): readonly ChatRouteSkip[] {
  if (data === null) return [];
  return pickArray(data, ['skipped']).flatMap((raw) => {
    const targetId = pickString(raw, ['target_id']);
    if (targetId === null) return [];
    const reason = pickString(raw, ['reason']);
    return [
      {
        targetId,
        label: (pickString(raw, ['label']) ?? targetId).slice(0, MAX_LABEL),
        provider: pickString(raw, ['provider']),
        reason: reason !== null && REASONS.has(reason) ? (reason as ChatRouteSkipReason) : 'unknown',
      },
    ];
  });
}

/** Several attempts' lists as one, each step once (first mention wins), in the order they were met. */
export function mergeRouteSkips(lists: readonly (readonly ChatRouteSkip[])[]): readonly ChatRouteSkip[] {
  const seen = new Set<string>();
  const out: ChatRouteSkip[] = [];
  for (const list of lists) {
    for (const skip of list) {
      if (seen.has(skip.targetId)) continue;
      seen.add(skip.targetId);
      out.push(skip);
    }
  }
  return out;
}

/** The skips to show: the first non-empty list (the turn's own events, else the route record's live event). */
export function skipsOf(...lists: readonly (readonly ChatRouteSkip[] | null | undefined)[]): readonly ChatRouteSkip[] {
  for (const list of lists) if (Array.isArray(list) && list.length > 0) return list;
  return [];
}
