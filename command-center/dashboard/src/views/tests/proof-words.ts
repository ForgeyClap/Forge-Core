/**
 * The words for a klus's proof label in the app language. English keeps the shared `finalizeProofLabel()`
 * mapping's own text (its detail sentences carry run-specific reasons); Dutch reads `rd.tests.proof.*`.
 */

import { translate } from '@/i18n';
import type { Locale, MessageKey } from '@/i18n';

import type { RunProofSummary } from './run-proof-summary';

type ProofGroup = 'verified' | 'archival' | 'unverifiedArchival' | 'stale' | 'unconfirmed' | 'checking' | 'invalid' | 'none';

const PROOF_GROUP: Readonly<Record<string, ProofGroup>> = {
  verified: 'verified',
  archival: 'archival',
  'unverified-archival': 'unverifiedArchival',
  stale: 'stale',
  unconfirmed: 'unconfirmed',
  checking: 'checking',
  invalid: 'invalid',
  none: 'none',
};

export interface ProofWords {
  readonly label: string;
  readonly short: string;
  readonly detail: string;
}

/** The label, short form and sentence for a proof key; an unknown key keeps the English mapping. */
export function proofWords(
  locale: Locale,
  summary: Pick<RunProofSummary, 'key' | 'label' | 'short' | 'detail' | 'reason'>,
): ProofWords {
  const group = PROOF_GROUP[summary.key];
  if (locale === 'en' || group === undefined) return { label: summary.label, short: summary.short, detail: summary.detail };
  const at = (part: 'label' | 'short' | 'detail') =>
    translate(locale, `rd.tests.proof.${group}.${part}` satisfies MessageKey, { reason: summary.reason ?? '' });
  return { label: at('label'), short: at('short'), detail: at('detail') };
}
