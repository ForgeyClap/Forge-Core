/**
 * Small formatters for the Details pane (Inspector) builders. They are plain functions (not components)
 * and read the current locale through `getLocale()`; <Inspector/> subscribes to the locale, so a language
 * switch re-renders them.
 */

import { getLocale, translate } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { localeTag } from '@/i18n/format';

/** A catalog word for a raw value (`rd.tasks.phase.build` → "Bouwen"), or the raw value when none exists. */
export function catalogWord(prefix: string, raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return '—';
  const key = `${prefix}.${raw}`;
  const word = translate(getLocale(), key as MessageKey);
  return word === key ? raw : word;
}

const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const RELATIVE = /^(\d+)\s+(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|h|hour|hours|day|days|week|weeks)\s+ago$/i;

/**
 * A relative time the example data carries in English ("4 min ago") in the app language ("4 min geleden").
 * Anything else (a date, a duration, a string the live adapter already wrote in the right language) is
 * returned unchanged.
 */
export function localRelative(value: string): string {
  const raw = value.trim();
  if (ISO_MOMENT.test(raw)) {
    // A live ISO moment (a file's mtime) in the app language: "3 nov 2026, 09:54", never the raw string.
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) {
      return new Date(ms).toLocaleString(localeTag(getLocale()), { dateStyle: 'medium', timeStyle: 'short' });
    }
  }
  if (/^just now$/i.test(raw)) return translate(getLocale(), 'relativeTime.justNow');
  const match = RELATIVE.exec(raw);
  if (!match) return value;
  const count = Number(match[1]);
  const unit = match[2].toLowerCase();
  const locale = getLocale();
  if (unit.startsWith('s')) return translate(locale, 'relativeTime.justNow');
  if (unit.startsWith('m')) return translate(locale, 'relativeTime.minutesAgo', { count });
  if (unit.startsWith('h')) return translate(locale, 'relativeTime.hoursAgo', { count });
  if (unit.startsWith('d')) return count === 1 ? translate(locale, 'relativeTime.dayAgo') : translate(locale, 'relativeTime.daysAgo', { count });
  return count === 1 ? translate(locale, 'relativeTime.weekAgo') : translate(locale, 'relativeTime.weeksAgo', { count });
}
