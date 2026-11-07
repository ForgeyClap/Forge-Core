/**
 * bot-activity-format — small pure helpers for the Discord view's "Bot activity" panel
 * (Command Center audit finding 31). Kept apart from the component so each rule is
 * unit-tested on its own.
 */

import type { Locale, MessageKey } from '@/i18n';
import type { StatusKey } from '@/prototype/types/prototype-types';
import { translate } from '@/i18n';



/**
 * The bot's own queue state -> the dashboard's status treatment (icon and border). The real state
 * name is always shown next to it as text (see jobStateLabel), so a cancelled or expired job reads
 * "Cancelled" even though it borrows the quiet "idle" treatment: it finished without a result, it
 * did not fail and it is not queued.
 */
export function statusKeyForJobState(state: string): StatusKey {
  switch (state) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
    case 'DEAD_LETTER':
      return 'failed';
    case 'RUNNING':
    case 'STARTING':
      return 'running';
    case 'RECEIVED':
    case 'VALIDATED':
    case 'QUEUED':
    case 'WAITING_FOR_PROJECT':
    case 'WAITING_FOR_CONFIRMATION':
      return 'waiting';
    default:
      return 'idle';
  }
}

/** The bot's own queue states this view names; any other state is shown in sentence case. */
const JOB_STATE: Readonly<Record<string, MessageKey>> = {
  COMPLETED: 'rd.discord.job.completed',
  FAILED: 'rd.discord.job.failed',
  DEAD_LETTER: 'rd.discord.job.deadLetter',
  RUNNING: 'rd.discord.job.running',
  STARTING: 'rd.discord.job.starting',
  RECEIVED: 'rd.discord.job.received',
  VALIDATED: 'rd.discord.job.validated',
  QUEUED: 'rd.discord.job.queued',
  WAITING_FOR_PROJECT: 'rd.discord.job.waitingForProject',
  WAITING_FOR_CONFIRMATION: 'rd.discord.job.waitingForConfirmation',
  CANCELLED: 'rd.discord.job.cancelled',
  EXPIRED: 'rd.discord.job.expired',
  UNKNOWN: 'rd.discord.job.unknown',
  '': 'rd.discord.job.unknown',
};

/** "WAITING_FOR_CONFIRMATION" -> "Waiting for confirmation" (Dutch: "Wacht op bevestiging"); DEAD_LETTER gets its plain meaning. */
export function jobStateLabel(state: string, locale: Locale = 'en'): string {
  const key = JOB_STATE[state];
  if (key !== undefined) return translate(locale, key);
  const words = state.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function numberLocale(locale: Locale): string {
  return locale === 'en' ? 'en-US' : 'nl-NL';
}

export function formatUsd(amount: number, locale: Locale = 'en'): string {
  return new Intl.NumberFormat(numberLocale(locale), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number.isFinite(amount) ? amount : 0,
  );
}

export function formatCount(n: number, locale: Locale = 'en'): string {
  return new Intl.NumberFormat(numberLocale(locale)).format(Number.isFinite(n) ? n : 0);
}

/** 62478568 -> "62.5M", 7890 -> "7.9K", 614 -> "614" (Dutch: "62,5 mln.", "7,9K"). */
export function formatCompact(n: number, locale: Locale = 'en'): string {
  return new Intl.NumberFormat(numberLocale(locale), { notation: 'compact', maximumFractionDigits: 1 }).format(Number.isFinite(n) ? n : 0);
}

/** "12 jobs", "1 job" (Dutch: "12 taken", "1 taak"). */
export function jobsLabel(n: number, locale: Locale = 'en'): string {
  return translate(locale, n === 1 ? 'rd.discord.bot.jobsOne' : 'rd.discord.bot.jobsMany', { count: formatCount(n, locale) });
}
