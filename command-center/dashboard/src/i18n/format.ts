/**
 * Numbers and moments in the app language. Pure helpers next to the string layer (`./index.ts`):
 * they take the locale as an argument, so plain functions and components can both use them.
 */

import type { Locale } from './index';

/** BCP-47 tag for dates and numbers in the app language (Dutch first). */
export function localeTag(locale: Locale): string {
  return locale === 'en' ? 'en-GB' : 'nl-NL';
}

/** Numbers in the app locale (Dutch: 1.234; English: 1,234). */
export function formatNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale)).format(Number.isFinite(n) ? n : 0);
}

/** "1 punt" / "4 punten": picks the One or the Many key for a count. */
export function countKey<K extends string>(count: number, one: K, many: K): K {
  return count === 1 ? one : many;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * A recorded moment in the app locale: "3 nov. 2026, 14:05" in Dutch, "3 Nov 2026, 14:05" in English.
 * Anything that is not an ISO date-time is returned as it came in (null when there is nothing).
 */
export function formatLocalDateTime(value: string | number | null | undefined, locale: Locale): string | null {
  if (value === null || value === undefined) return null;
  let ms: number;
  if (typeof value === 'number') {
    ms = value;
  } else {
    const raw = value.trim();
    if (raw === '') return null;
    if (!ISO_DATE_TIME.test(raw)) return raw;
    ms = Date.parse(raw);
  }
  if (!Number.isFinite(ms)) return typeof value === 'string' ? value : null;
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}
