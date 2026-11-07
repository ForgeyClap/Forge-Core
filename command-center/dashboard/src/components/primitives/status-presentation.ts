/**
 * The single source of truth for how a status looks and reads.
 *
 * Status is never carried by colour alone. Every consumer gets a label, a
 * lucide icon name and a screen-reader sentence out of here (the words in the
 * app language, from the catalog); the colour and the border treatment come
 * from the .fw-status carrier in the stylesheet (v1.0 --fs-* tokens).
 *
 * Both <StatusBadge> and <StatusDot> read this map. Views that need a status
 * label without a badge should read it too rather than re-typing the strings.
 */

import { getLocale, translate } from '@/i18n';
import type { Locale } from '@/i18n';
import type { StatusKey, StatusPresentation } from '@/prototype/types/prototype-types';

/** The look of each status; the word and the sentence come from the catalog (`rd.statusWord.*`, `rd.statusInfo.*`). */
const PRESENTATION: Readonly<Record<StatusKey, Pick<StatusPresentation, 'key' | 'icon' | 'animated'>>> = {
  running: {
    key: 'running',
    icon: 'Loader',
    animated: true,
  },
  completed: {
    key: 'completed',
    icon: 'Check',
    animated: false,
  },
  waiting: {
    key: 'waiting',
    icon: 'Clock',
    animated: false,
  },
  verify: {
    key: 'verify',
    icon: 'SearchCheck',
    animated: false,
  },
  review: {
    key: 'review',
    icon: 'ClipboardCheck',
    animated: false,
  },
  failed: {
    key: 'failed',
    icon: 'TriangleAlert',
    animated: false,
  },
  /* fix-status-honesty (owner complaint "ik vind nog bugs in de ui"): unknown/idle
   * used to render as WAITING, painting every project card, every idle roster agent and every
   * loose activity line as if it were queued behind something. WAITING now means genuinely queued;
   * everything with no recorded state reads IDLE — the quietest treatment in the set (dotted,
   * transparent fill), because it is the absence of a claim, not a claim. */
  idle: {
    key: 'idle',
    icon: 'Minus',
    animated: false,
  },
  blocked: {
    key: 'blocked',
    icon: 'Lock',
    animated: false,
  },
};

/**
 * Presentation for a status key, with the word and the sentence in `locale` (the current app language
 * by default). Falls back to `waiting` for unknown input.
 */
export function statusPresentation(status: StatusKey, locale: Locale = getLocale()): StatusPresentation {
  const base = PRESENTATION[status] ?? PRESENTATION.waiting;
  return {
    ...base,
    label: translate(locale, `rd.statusWord.${base.key}`),
    description: translate(locale, `rd.statusInfo.${base.key}`),
  };
}

export type { StatusPresentation };
