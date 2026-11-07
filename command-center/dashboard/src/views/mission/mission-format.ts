/**
 * Small text helpers for the Overzicht header: a start time in the reader's own words (the counts
 * with a singular form live in MissionControlView).
 */

import type { Locale } from '@/i18n';

const DATE_TIME: Readonly<Record<Locale, Intl.DateTimeFormat>> = {
  nl: new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  en: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
};

/**
 * A recorded start time (an ISO string from the gateway, or the fixtures' "2026-07-24 08:41") as a
 * local date and time, e.g. "3 nov 05:41". Text that is not a date is returned as it is; an empty
 * value gives `null` so the caller can leave the item out instead of showing a dash.
 */
export function formatStartedAt(locale: Locale, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  return DATE_TIME[locale].format(new Date(ms));
}

