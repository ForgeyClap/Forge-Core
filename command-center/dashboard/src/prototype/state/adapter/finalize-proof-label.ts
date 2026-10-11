/**
 * finalize-proof-label —: the ONE mapping from the gateway's finalize acceptance fields
 * (`verdict`, `cause`, `reverified`, `archival`, `completion_proof`, `allowlisted` — from the central
 * forge-finalize.cjs `check`, passed through by `/api/proof` and `/api/runs`) to the label a person reads.
 *
 * A receipt file existing is not the same as a run being proven complete, so the label never says "Finalized"
 * unless the central check re-confirmed it:
 *   - `Finalized (verified)` — a completion proof that was re-checked: verdict FINALIZED (re-judged against the
 *     current rules just now) or a HISTORICAL record re-verified under the rules it was finalized with.
 *   - `Archival record (not re-verified)` — the central tool still accepts it as a completion record (an
 *     allowlisted older finalize generation, or a ruleset that has since moved on), but nothing was re-run:
 *     `archival:true`, `reverified:false`. Shown as a neutral record, never as "verified".
 *   - `Unverified archival` — an intact record that does NOT prove completion (warning).
 *   - `Stale` — the log, evidence or code changed after the receipt was written (warning).
 *   - `Proof not confirmed` — the check was undetermined or could not run (warning).
 *   - `Checking proof` — the gateway has not finished the check yet (neutral).
 */

import { pickBool, pickString } from '@/prototype/state/gateway-client';

export type FinalizeProofKey = 'verified' | 'archival' | 'unverified-archival' | 'stale' | 'unconfirmed' | 'checking';
export type FinalizeProofTone = 'verified' | 'archival' | 'warning' | 'pending';

export interface FinalizeProofInput {
  /** false when the central check could not run (or has not run yet). */
  readonly available: boolean;
  /** true when the check is still in progress. */
  readonly pending?: boolean;
  readonly verdict: string | null;
  readonly cause: string | null;
  readonly reverified: boolean | null;
  readonly archival: boolean | null;
  readonly completionProof: boolean | null;
  readonly allowlisted: string | null;
}

export interface FinalizeProofLabel {
  readonly key: FinalizeProofKey;
  readonly label: string;
  readonly tone: FinalizeProofTone;
  /** One plain sentence saying what the label means for this run. */
  readonly detail: string;
  /** The lucide icon that goes with the label (the text always carries the meaning on its own). */
  readonly icon: string;
}

const WARNING_ICON = 'TriangleAlert';

export function finalizeProofLabel(input: FinalizeProofInput): FinalizeProofLabel {
  if (!input.available) {
    if (input.pending === true) {
      return { key: 'checking', label: 'Checking proof', tone: 'pending', icon: 'CircleDashed', detail: 'The receipt is being checked against the run log, its evidence and the code. This takes a moment.' };
    }
    return { key: 'unconfirmed', label: 'Proof not confirmed', tone: 'warning', icon: WARNING_ICON, detail: 'The receipt could not be checked, so this run is not shown as finalized.' };
  }
  const verdict = (input.verdict ?? '').toUpperCase();
  if (verdict === 'STALE') {
    return { key: 'stale', label: 'Stale', tone: 'warning', icon: WARNING_ICON, detail: 'The run log, its evidence or the code changed after this receipt was written, so it no longer proves the run was completed.' };
  }
  if (verdict === 'FINALIZED' && input.completionProof === true) {
    return { key: 'verified', label: 'Finalized (verified)', tone: 'verified', icon: 'ShieldCheck', detail: 'Re-checked against the current rules: the log, evidence and code commit still match the receipt.' };
  }
  if (verdict === 'HISTORICAL') {
    if (input.completionProof === true && input.reverified === true) {
      return { key: 'verified', label: 'Finalized (verified)', tone: 'verified', icon: 'ShieldCheck', detail: 'Re-checked under the rules this run was finalized with: the log, evidence and code commit still match.' };
    }
    if (input.completionProof === true) {
      const generation = input.allowlisted !== null ? ` (${input.allowlisted})` : '';
      const why = input.cause === 'legacy-receipt'
        ? `It comes from an older finalize generation${generation} that pinned the log but not the evidence.`
        : input.cause === 'ruleset'
          ? `The rules have changed since it was finalized${generation}, and the old rules were not re-run.`
          : `It is accepted as an earlier record${generation}.`;
      return { key: 'archival', label: 'Archival record (not re-verified)', tone: 'archival', icon: 'Archive', detail: `The log still matches the receipt byte for byte. ${why}` };
    }
    return { key: 'unverified-archival', label: 'Unverified archival', tone: 'warning', icon: WARNING_ICON, detail: 'The record is intact, but its rules or outputs cannot be reproduced and nothing vouches for it, so it does not prove the run was completed.' };
  }
  return { key: 'unconfirmed', label: 'Proof not confirmed', tone: 'warning', icon: WARNING_ICON, detail: 'The check could not confirm or reject this receipt, so this run is not shown as finalized.' };
}

/**
 * Reads the central finalize acceptance (`/api/proof` → `finalize_acceptance`, and the same field
 * names on `/api/runs` rows' `proof`). Missing → pending. (moved here.)
 */
export function parseFinalizeProof(acceptance: Record<string, unknown> | null): FinalizeProofInput {
  if (acceptance === null) {
    return { available: false, pending: true, verdict: null, cause: null, reverified: null, archival: null, completionProof: null, allowlisted: null };
  }
  return {
    available: pickBool(acceptance, ['available']) === true,
    pending: pickBool(acceptance, ['pending']) === true,
    verdict: pickString(acceptance, ['verdict']),
    cause: pickString(acceptance, ['cause']),
    reverified: pickBool(acceptance, ['reverified']),
    archival: pickBool(acceptance, ['archival']),
    completionProof: pickBool(acceptance, ['completion_proof']),
    allowlisted: pickString(acceptance, ['allowlisted']),
  };
}
