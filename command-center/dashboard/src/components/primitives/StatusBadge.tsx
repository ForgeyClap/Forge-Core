/**
 * StatusBadge — a dot plus a word (Forge Systeem v1.0).
 *
 * Status is never colour alone: the word carries it, the dot colours it, and a
 * visually hidden sentence explains it to assistive tech. Only the "running" dot moves
 * (it breathes, and stands still under reduced motion).
 *
 * XR-COPY2: the word and the sentence come from status-presentation.ts in the app language
 * (Dutch first: "Bezig", "Wacht", "Klaar", "Staat vast"...), so every page that shows a badge
 * follows the language switch. English keeps the old labels, shown in sentence case (.fw-sentence).
 * A view can still pass a more precise `label` for one context.
 */

import { useLocale } from '@/i18n/use-locale';

import { statusPresentation } from './status-presentation';
import type { StatusKey } from '@/prototype/types/prototype-types';

export interface StatusBadgeProps {
  status: StatusKey;
  size?: 'sm' | 'md';
  /** Hide the word, keeping the dot plus an accessible name. */
  iconOnly?: boolean;
  className?: string;
  /** a more precise word for this status in one context (e.g. PLANNED for a work package
   *  that exists but has not started). The status key and colour stay the same. */
  label?: string;
  /** The accessible sentence that goes with `label`. */
  description?: string;
}

export function StatusBadge({ status, size = 'md', iconOnly = false, className, label, description }: StatusBadgeProps) {
  const { locale } = useLocale();
  const base = statusPresentation(status, locale);
  const presentation = {
    ...base,
    label: label ?? base.label,
    description: description ?? base.description,
  };
  const classes = ['fw-status', 'fw-status-badge', `fw-status-badge--${size}`];
  if (iconOnly) classes.push('fw-status-badge--icon-only');
  if (className) classes.push(className);

  return (
    <span className={classes.join(' ')} data-status={status} title={presentation.description}>
      <span
        className={presentation.animated ? 'fw-status-badge__dot is-live' : 'fw-status-badge__dot'}
        aria-hidden="true"
      />
      {iconOnly ? null : (
        <span className="fw-status-badge__label fw-sentence" aria-hidden="true">
          {presentation.label}
        </span>
      )}
      <span className="fw-visually-hidden">{presentation.description}</span>
    </span>
  );
}
