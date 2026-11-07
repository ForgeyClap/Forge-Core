/**
 * StatusDot — the compact form of StatusBadge, for dense rows and graph nodes.
 *
 * An 8 px dot with a soft halo, coloured by status. It is never the only carrier of
 * meaning: it always has an accessible name and a tooltip. The running dot breathes.
 */

import { statusPresentation } from './status-presentation';
import type { StatusKey } from '@/prototype/types/prototype-types';

export interface StatusDotProps {
  status: StatusKey;
  className?: string;
}

export function StatusDot({ status, className }: StatusDotProps) {
  const presentation = statusPresentation(status);
  const classes = ['fw-status', 'fw-status-dot'];
  if (presentation.animated) classes.push('is-live');
  if (className) classes.push(className);

  return (
    <span
      className={classes.join(' ')}
      data-status={status}
      role="img"
      aria-label={presentation.description}
      title={presentation.description}
    />
  );
}
