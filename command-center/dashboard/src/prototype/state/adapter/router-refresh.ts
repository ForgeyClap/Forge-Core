/**
 * router-refresh — one shared "the router chain may read differently now" signal (Q6-UI, Review Boss medium).
 *
 * An own API ("Eigen API") that is created, changed, switched off or deleted changes what `GET /api/app-router`
 * says in its `warnings` (a step the router now skips), without the router config itself changing. Every
 * successful custom-API mutation (`providers-custom.ts`) bumps this counter; the router section
 * (`useAppRouter`) and the Eigen API section (`useRouterUsage`) both re-read the router when it moves, so the
 * Settings page never shows a stale skip warning.
 *
 * No dependency: a module-level counter with listeners, read through `useSyncExternalStore`.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

let generation = 0;
const listeners = new Set<() => void>();

/** Call after a successful custom-API create / update / delete. */
export function signalRouterChanged(): void {
  generation += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  return generation;
}

/** The current generation; a component that reads it re-renders (and can re-fetch) when it moves. */
export function useRouterRefreshSignal(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Calls `onChange` each time the signal moves after mount (not on mount itself). For a hook that polls on its own
 * (`useProviders`, every 20 s) and must read again at once, e.g. so the cost-confirm checkbox shows (Q7-SETTINGS).
 * `onChange` should be stable (a `useCallback`).
 */
export function useOnRouterRefresh(onChange: () => void): void {
  const generationNow = useRouterRefreshSignal();
  const seen = useRef(generationNow);
  useEffect(() => {
    if (seen.current === generationNow) return;
    seen.current = generationNow;
    onChange();
  }, [generationNow, onChange]);
}
