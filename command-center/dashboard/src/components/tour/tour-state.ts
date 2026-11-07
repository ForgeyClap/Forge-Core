/**
 * tour-state — whether the 3-stop tour should show (DESIGN.md §3.1 "Guided tour", redesign 2D).
 *
 * The tour is never forced. It is offered once, at the end of onboarding ("Laat me rondkijken"), and
 * can always be replayed from `?` > Rondleiding opnieuw or Instellingen > Algemeen.
 *
 * Storage (`localStorage forge.tour`):
 *   'pending'  onboarding asked for it; the tour host shows it on its next mount or request
 *   'seen'     the person finished or skipped it; it never shows again on its own
 * Anything else (or no storage) means: do not show it on its own.
 */

import { requestTourReplay } from '@/components/shell/shell-events';
import type { MessageKey } from '@/i18n';

export const TOUR_STORAGE_KEY = 'forge.tour';

export type TourMemory = 'pending' | 'seen' | null;

export function readTourMemory(): TourMemory {
  try {
    const value = globalThis.localStorage?.getItem(TOUR_STORAGE_KEY) ?? null;
    return value === 'pending' || value === 'seen' ? value : null;
  } catch {
    return null;
  }
}

function writeTourMemory(value: Exclude<TourMemory, null>): void {
  try {
    globalThis.localStorage?.setItem(TOUR_STORAGE_KEY, value);
  } catch {
    /* Without storage the tour simply is not remembered; it is still never forced. */
  }
}

/** The tour was finished or skipped: never show it again unless it is replayed. */
export function markTourSeen(): void {
  writeTourMemory('seen');
}

/**
 * Onboarding's "Laat me rondkijken": remember the request (so a tour host that mounts later still
 * shows it) and ask a mounted host to start right away.
 */
export function requestTourStart(): void {
  writeTourMemory('pending');
  requestTourReplay();
}

/**
 * The tour's stops, in order. `anchor` is the `data-tour` value the shell and composer carry.
 *
 * DESIGN.md §5: a card adds at most 14 words to Start (step label, title, one line, Overslaan, Volgende), and
 * Start itself is 32, so every card here is 13 words: "1 van 3", a title of at most 5 words, a line of at
 * most 4. `title` is a catalog key; `body` (and the third title) are the shorter lines in shell-w4-copy.ts.
 */
export const TOUR_STOPS = [
  { anchor: 'composer', title: { catalog: 'rd.tour.composerTitle' }, body: 'rd.tour.card.composerBody' },
  { anchor: 'projects', title: { catalog: 'rd.tour.projectsTitle' }, body: 'rd.tour.card.projectsBody' },
  { anchor: 'help', title: { shell: 'rd.tour.card.helpTitle' }, body: 'rd.tour.card.helpBody' },
] as const satisfies readonly {
  readonly anchor: string;
  readonly title: { readonly catalog: MessageKey } | { readonly shell: MessageKey };
  readonly body: MessageKey;
}[];
