/**
 * ui-mode — Eenvoudig (simple, the default) or Uitgebreid (advanced) (WP B4, plan §4.2).
 *
 * Same shape as the i18n store (`@/i18n`): a module-level value with listeners, persisted in
 * localStorage under `forge.uiMode`, read by React through `useUiMode()`. No dependency.
 *
 * What each mode shows is decided where the screen is built (nav visibility lives in
 * `components/shell/nav-config.ts`); this module only holds the choice.
 */

import { useSyncExternalStore } from 'react';

export const UI_MODES = ['eenvoudig', 'uitgebreid'] as const;
export type UiMode = (typeof UI_MODES)[number];

export const DEFAULT_UI_MODE: UiMode = 'eenvoudig';
export const UI_MODE_STORAGE_KEY = 'forge.uiMode';

export function isUiMode(value: unknown): value is UiMode {
  return typeof value === 'string' && (UI_MODES as readonly string[]).includes(value);
}

function readStoredMode(): UiMode {
  try {
    const stored = globalThis.localStorage?.getItem(UI_MODE_STORAGE_KEY);
    return isUiMode(stored) ? stored : DEFAULT_UI_MODE;
  } catch {
    // Storage can be unavailable (private mode, a sandboxed frame): fall back to the default.
    return DEFAULT_UI_MODE;
  }
}

let current: UiMode = readStoredMode();
const listeners = new Set<() => void>();

export function getUiMode(): UiMode {
  return current;
}

/** Switches the mode, remembers it in this browser and re-renders every `useUiMode()` reader. */
export function setUiMode(next: UiMode): void {
  if (!isUiMode(next)) throw new Error(`Unknown UI mode: ${String(next)}`);
  if (next === current) return;
  current = next;
  try {
    globalThis.localStorage?.setItem(UI_MODE_STORAGE_KEY, next);
  } catch {
    // Not persisted when storage is unavailable; the switch still applies to this tab.
  }
  listeners.forEach((listener) => listener());
}

export function subscribeUiMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface UiModeApi {
  readonly mode: UiMode;
  readonly isAdvanced: boolean;
  readonly setUiMode: (next: UiMode) => void;
}

/** The current mode; the component re-renders when it changes. */
export function useUiMode(): UiModeApi {
  const mode = useSyncExternalStore(subscribeUiMode, getUiMode, getUiMode);
  return { mode, isAdvanced: mode === 'uitgebreid', setUiMode };
}
