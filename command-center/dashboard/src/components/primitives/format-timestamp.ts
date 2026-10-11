/**
 * one way to show a recorded moment — local date and time a person reads at a glance
 * ("9 Oct 2026, 20:35"), with the exact ISO string kept for the tooltip and `<time dateTime>`.
 *
 * Only a real ISO-8601 date-time is reformatted. Anything else ("2h ago", "—", an already
 * formatted label, an empty string) is returned unchanged with `iso: null`, so this never turns a
 * string it does not understand into a wrong date.
 */

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface FormattedTimestamp {
  /** What to show. */
  readonly text: string;
  /** The original ISO string when `text` was derived from one, else null. */
  readonly iso: string | null;
}

export function formatTimestamp(value: string | null | undefined): FormattedTimestamp {
  const raw = (value ?? '').trim();
  if (!ISO_DATE_TIME.test(raw)) return { text: raw, iso: null };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { text: raw, iso: null };
  return { text: FORMAT.format(new Date(ms)), iso: raw };
}
