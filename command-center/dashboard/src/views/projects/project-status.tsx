/**
 * The status word for a project or a klus on the list screens (DESIGN.md §3.3, rule 4): a dot plus a
 * word, never colour alone. Dutch-first words from the rd.* keys, replacing the English "Idle" and the
 * caps labels the old badge showed.
 *
 * `idle` gets no word at all: it is the absence of a claim ("nothing recorded right now"), and a
 * column of grey "Rustig" badges would only add noise. Every real state keeps its word.
 */

import type { StatusKey } from '@/prototype/types/prototype-types';
import { useLocale } from '@/i18n/use-locale';

import './project-status.css';

/** The visual tone, matching `.fw-xstatus[data-status]` in jobs/xpage.css (`stuck` lives in project-status.css). */
type StatusTone = 'busy' | 'done' | 'failed' | 'waiting' | 'stuck';

function statusTone(status: StatusKey): StatusTone | null {
  switch (status) {
    case 'running':
    case 'verify':
    case 'review':
      return 'busy';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'waiting':
      // Waits on the owner: the amber Wacht tone (DESIGN.md §3.3 "Wacht op jou").
      return 'waiting';
    case 'blocked':
      // A stalled run (and BLOCKED, CANCELLED, DEGRADED in the live store): nobody paused it, so it is a
      // visible warning with "Staat vast" (XR-COPY1 R2, rows.ts: "stalled is a VISIBLE WARNING").
      // "Gepauzeerd" stays unused until a real, deliberate pause state exists.
      return 'stuck';
    default:
      return null;
  }
}

export function ProjectStatusWord({ status }: { readonly status: StatusKey }) {
  const { t } = useLocale();
  const tone = statusTone(status);
  if (tone === null) return null;
  const word =
    tone === 'busy'
      ? t('rd.projects.status.busy')
      : tone === 'done'
        ? t('rd.projects.status.done')
        : tone === 'failed'
          ? t('rd.projects.status.failed')
          : tone === 'stuck'
            ? t('rd.projects.status.blocked')
            : t('rd.projects.status.waiting');
  return (
    <span className="fw-xstatus" data-status={tone}>
      {word}
    </span>
  );
}
