/**
 * WP B5 — locale-aware "when" text for the Uitgebreid screens. Uses the platform's Intl formatters
 * so Dutch reads "3 minuten geleden" without a second string table. An absent or unparsable
 * timestamp is '' (never a made-up "just now").
 */

import type { Locale } from '@/i18n';

export function relativeWhen(iso: string | null | undefined, locale: Locale, now: number = Date.now()): string {
  if (iso === null || iso === undefined || iso.trim() === '') return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, (now - then) / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 1) return rtf.format(0, 'minute');
  if (minutes < 60) return rtf.format(-Math.round(minutes), 'minute');
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), 'hour');
  if (minutes < 60 * 24 * 7) return rtf.format(-Math.round(minutes / 1440), 'day');
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(then));
}
