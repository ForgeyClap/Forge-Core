/**
 * Mark — the Forge Systeem logo as inline SVG (BRAND.md > Logo mark).
 *
 * A plate with the struck corner, a DIN-style F and one ember. The colour version follows
 * the theme through tokens (.fw-mark-plate / -f / -ember in primitives-guided.css). Below
 * 20 px the ember is too small to read as its own colour, so `mono` (currentColor, F and
 * ember cut out) is used automatically.
 *
 * Decorative by default (the word "Forge" usually sits next to it). Pass `title` when the
 * mark stands alone and must be announced.
 */

const PLATE = 'M16 4H56A4 4 0 0 1 60 8V48A12 12 0 0 1 48 60H16A12 12 0 0 1 4 48V16A12 12 0 0 1 16 4Z';
const LETTER = 'M19 16H45L41 23H26V30H37V37H26V48H19Z';
const EMBER_CUT = 'M42.5 30H45.5A1.5 1.5 0 0 1 47 31.5V35.5A1.5 1.5 0 0 1 45.5 37H42.5A1.5 1.5 0 0 1 41 35.5V31.5A1.5 1.5 0 0 1 42.5 30Z';

import { MARK_MONO_BELOW } from './guided-constants';

export interface MarkProps {
  /** Rendered size in px (square). Default 24. Minimum useful size is 16. */
  size?: number;
  /** One colour, follows `color`. Forced on below 20 px. */
  mono?: boolean;
  /** Accessible name. Omit when the mark is decorative. */
  title?: string;
  className?: string;
}

export function Mark({ size = 24, mono = false, title, className }: MarkProps) {
  const useMono = mono || size < MARK_MONO_BELOW;
  const classes = ['fw-mark'];
  if (useMono) classes.push('fw-mark--mono');
  if (className) classes.push(className);

  const a11y = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true as const, focusable: 'false' as const };

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={classes.join(' ')}
      data-variant={useMono ? 'mono' : 'color'}
      {...a11y}
    >
      {useMono ? (
        <path fill="currentColor" fillRule="evenodd" d={`${PLATE} ${LETTER} ${EMBER_CUT}`} />
      ) : (
        <>
          <path className="fw-mark-plate" d={PLATE} />
          <path className="fw-mark-f" d={LETTER} />
          <rect className="fw-mark-ember" x="41" y="30" width="6" height="7" rx="1.5" />
        </>
      )}
    </svg>
  );
}
