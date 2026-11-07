/**
 * shell-events — the window events the shell sends to parts it does not own (redesign 1C).
 *
 * The 3-stop tour lives in `components/tour` (part 2D). The shell only offers "Rondleiding opnieuw" under
 * `?`; it does not import the tour. The tour registers with `onTourReplay(handler)` when it mounts, and
 * the shell shows the menu item only while one is registered (`useTourReplayAvailable`), so the item
 * never sits in the menu doing nothing. A window listener cannot be counted, which is why the tour must
 * register here instead of calling `addEventListener` itself.
 */

import { useSyncExternalStore } from 'react';

export const TOUR_REPLAY_EVENT = 'forge:tour-replay';

let tourListeners = 0;
const availability = new Set<() => void>();

function emitAvailability(): void {
  availability.forEach((listener) => listener());
}

/** Asks the tour (if one is mounted) to start again from stop 1. */
export function requestTourReplay(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TOUR_REPLAY_EVENT));
}

/** The tour registers its replay handler here. Returns an unregister function (safe to call twice). */
export function onTourReplay(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = () => handler();
  window.addEventListener(TOUR_REPLAY_EVENT, listener);
  tourListeners += 1;
  emitAvailability();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    window.removeEventListener(TOUR_REPLAY_EVENT, listener);
    tourListeners -= 1;
    emitAvailability();
  };
}

/** True while at least one tour replay handler is registered. */
export function hasTourReplayListener(): boolean {
  return tourListeners > 0;
}

function subscribe(listener: () => void): () => void {
  availability.add(listener);
  return () => {
    availability.delete(listener);
  };
}

/** React: re-renders when a tour registers or leaves, so "Rondleiding opnieuw" shows only when it works. */
export function useTourReplayAvailable(): boolean {
  return useSyncExternalStore(subscribe, hasTourReplayListener, hasTourReplayListener);
}
