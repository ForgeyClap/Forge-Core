/**
 * test-note — what a router step's "Testen" says when the router skips that step (Q6-UI).
 *
 * Shared by the account list, the fallback model picker and the add-account dialog so a 409 `entry_unusable`
 * (C2: nothing was probed) reads the same everywhere: the gateway's own words in the shown language, else a
 * plain fallback. No React, no network.
 */

import type { MessageKey, MessageVars } from '@/i18n';
import type { TestOutcome } from '@/prototype/state/adapter/app-router';

type Translate = (key: MessageKey, vars?: MessageVars) => string;

/** The note for a 409 entry_unusable answer; null for every other outcome (each caller keeps its own lines). */
export function unusableNote(test: TestOutcome | null, t: Translate, locale: string): string | null {
  if (test?.kind !== 'unusable') return null;
  return (locale === 'nl' ? test.nl || test.en : test.en || test.nl) || t('appRouter.accounts.testUnusable');
}
