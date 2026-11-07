/**
 * use-router-usage — which router chain steps name an own API ("Eigen API") (Q5-EIGEN-API-UI).
 *
 * One read of `GET /api/app-router` (no status polling), again on `reload` and after every own-API change. The Eigen API section uses it to
 * warn BEFORE a delete or a switch-off, and to turn the ids in a `router_entries` answer into the step names
 * the person knows. An unreachable or unreadable router simply reads as "no steps known" (no warning shown),
 * never as an error in this section.
 */

import { useCallback, useEffect, useState } from 'react';

import { parseRouterGet } from '@/prototype/state/adapter/app-router';
import type { RouterEntry } from '@/prototype/state/adapter/app-router';
import { useRouterRefreshSignal } from '@/prototype/state/adapter/router-refresh';
import { gwGet } from '@/prototype/state/gateway-client';

export interface RouterUsage {
  /** The chain steps whose provider is this id, in chain order. */
  readonly stepsFor: (providerId: string) => readonly RouterEntry[];
  /** The step names for these chain entry ids (an id this read does not know stays as it is). */
  readonly namesOf: (entryIds: readonly string[]) => string;
  readonly reload: () => void;
}

export function useRouterUsage(): RouterUsage {
  const [entries, setEntries] = useState<readonly RouterEntry[]>([]);
  const [nonce, setNonce] = useState(0);
  // Read again after any own-API change too (the shared signal the router section also follows, Q6-UI).
  const refresh = useRouterRefreshSignal();
  useEffect(() => {
    let cancelled = false;
    void gwGet('/api/app-router').then((result) => {
      if (cancelled) return;
      setEntries(result.ok ? (parseRouterGet(result.data)?.config.entries ?? []) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce, refresh]);
  const stepsFor = useCallback(
    (providerId: string) => entries.filter((entry) => entry.kind === 'provider-model' && entry.provider === providerId),
    [entries],
  );
  const namesOf = useCallback(
    (entryIds: readonly string[]) => entryIds.map((id) => entries.find((entry) => entry.id === id)?.label ?? id).join(', '),
    [entries],
  );
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { stepsFor, namesOf, reload };
}
