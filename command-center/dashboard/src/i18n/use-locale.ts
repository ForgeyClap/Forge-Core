/**
 * useLocale — the React side of the i18n store (`./index.ts`).
 *
 * Subscribes through `useSyncExternalStore`, so a component that calls it re-renders when the
 * locale changes. The returned `t` and `n` are bound to the locale of that render.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { getLocale, setLocale, subscribeLocale, translate, translateCount } from './index';
import type { Locale, MessageKey, MessageVars, Translate } from './index';

export interface LocaleApi {
  readonly locale: Locale;
  readonly setLocale: (next: Locale) => void;
  readonly t: Translate;
  /** The One or the Many key for a count; the count is passed as `{count}` in the locale number format. */
  readonly n: (count: number, one: MessageKey, many: MessageKey, vars?: MessageVars) => string;
}

export function useLocale(): LocaleApi {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const t = useCallback((key: MessageKey, vars?: MessageVars) => translate(locale, key, vars), [locale]);
  const n = useCallback(
    (count: number, one: MessageKey, many: MessageKey, vars?: MessageVars) => translateCount(locale, count, one, many, vars),
    [locale],
  );
  return { locale, setLocale, t, n };
}
