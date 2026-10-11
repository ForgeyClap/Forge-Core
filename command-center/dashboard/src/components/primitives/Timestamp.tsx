/**
 * Timestamp — a recorded moment in the machine face.
 *
 * Shows local date + time ("9 Oct 2026, 20:35") and keeps the exact ISO string in `title` and
 * `<time dateTime>`. The text never breaks inside a token (`white-space: nowrap` on the element),
 * which is what made raw ISO strings wrap mid-number in narrow columns.
 */

import { formatTimestamp } from './format-timestamp';

export interface TimestampProps {
  readonly value: string | null | undefined;
  readonly muted?: boolean;
  readonly className?: string;
  /** Shown when there is no value at all. */
  readonly fallback?: string;
}

export function Timestamp({ value, muted = true, className, fallback = '—' }: TimestampProps) {
  const { text, iso } = formatTimestamp(value);
  const classes = ['fg-machine', 'fw-machine', 'fw-timestamp'];
  if (muted) classes.push('fw-machine--muted');
  if (className) classes.push(className);
  if (iso === null) {
    return <span className={classes.join(' ')}>{text !== '' ? text : fallback}</span>;
  }
  return (
    <time className={classes.join(' ')} dateTime={iso} title={iso}>
      {text}
    </time>
  );
}
