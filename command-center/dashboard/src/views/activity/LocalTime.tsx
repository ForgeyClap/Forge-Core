/**
 * LocalTime: the shared Timestamp primitive, but in the app locale (XR-COPY1). Dutch screens show
 * "3 nov. 2026, 14:05" instead of the English "3 Nov 2026, 14:05". Same classes, same `<time dateTime>`
 * and ISO title, so it looks and reads exactly like Timestamp. English output is identical to Timestamp.
 */

import { formatTimestamp } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { formatLocalDateTime } from '@/i18n/format';


export interface LocalTimeProps {
  readonly value: string | null | undefined;
  readonly muted?: boolean;
  readonly className?: string;
  /** Shown when there is no value at all. */
  readonly fallback?: string;
}

export function LocalTime({ value, muted = true, className, fallback = '—' }: LocalTimeProps) {
  const { locale } = useLocale();
  const { text, iso } = formatTimestamp(value);
  const classes = ['fg-machine', 'fw-machine', 'fw-timestamp'];
  if (muted) classes.push('fw-machine--muted');
  if (className) classes.push(className);
  if (iso === null) {
    return <span className={classes.join(' ')}>{text !== '' ? text : fallback}</span>;
  }
  return (
    <time className={classes.join(' ')} dateTime={iso} title={iso}>
      {formatLocalDateTime(iso, locale) ?? text}
    </time>
  );
}
