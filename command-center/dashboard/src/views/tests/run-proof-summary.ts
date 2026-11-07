/**
 * run-proof-summary —: the proof label of ONE run in a list, plus the sort/filter rules of
 * the Recent runs table. Pure, no React.
 *
 * The label always comes from the shared `finalizeProofLabel()` mapping (the same words the Run
 * health panel uses), so a list row can never say more than the receipt check did. Two cases that
 * mapping does not cover get their own honest wording: a receipt that no longer counts, and a run
 * with no receipt at all.
 */

import { finalizeProofLabel, type FinalizeProofTone } from '@/prototype/state/adapter/finalize-proof-label';
import type { Run, Task } from '@/prototype/types/prototype-types';

export type RunProofTone = FinalizeProofTone | 'none';

export interface RunProofSummary {
  readonly key: string;
  readonly label: string;
  /** A short form for tight places such as a <select> option. */
  readonly short: string;
  readonly tone: RunProofTone;
  readonly icon: string;
  readonly detail: string;
  /** A receipt file exists for this run (whether or not it still counts). */
  readonly hasReceipt: boolean;
  /** Why a receipt no longer counts (key 'invalid' only), so other locales can name it too. */
  readonly reason?: string;
}

const SHORT: Readonly<Record<string, string>> = {
  verified: 'verified',
  archival: 'archival, not re-verified',
  'unverified-archival': 'unverified archival',
  stale: 'stale',
  unconfirmed: 'proof not confirmed',
  checking: 'checking proof',
};

export function runProofSummary(run: Pick<Run, 'proof' | 'finalized' | 'finalizeInvalidReason'>): RunProofSummary {
  if (run.proof) {
    const label = finalizeProofLabel(run.proof);
    return { key: label.key, label: label.label, short: SHORT[label.key] ?? label.label, tone: label.tone, icon: label.icon, detail: label.detail, hasReceipt: true };
  }
  if (typeof run.finalizeInvalidReason === 'string' && run.finalizeInvalidReason !== '') {
    return {
      key: 'invalid',
      label: 'Receipt no longer counts',
      short: 'receipt no longer counts',
      tone: 'warning',
      icon: 'TriangleAlert',
      detail: `A finalize receipt exists but no longer counts: ${run.finalizeInvalidReason}.`,
      hasReceipt: true,
      reason: run.finalizeInvalidReason,
    };
  }
  if (run.finalized === true) {
    const label = finalizeProofLabel({ available: false, pending: false, verdict: null, cause: null, reverified: null, archival: null, completionProof: null, allowlisted: null });
    return { key: label.key, label: label.label, short: SHORT[label.key] ?? label.label, tone: label.tone, icon: label.icon, detail: label.detail, hasReceipt: true };
  }
  return {
    key: 'none',
    label: 'Not finalized',
    short: 'not finalized',
    tone: 'none',
    icon: 'CircleDashed',
    detail: 'No finalize receipt exists for this run.',
    hasReceipt: false,
  };
}

export type SortDirection = 'desc' | 'asc';

function startedMs(run: Pick<Run, 'startedAt'>): number {
  const ms = Date.parse(run.startedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** Newest first by default; a run without a readable start time always sorts last. */
export function sortRunsByStart<T extends Pick<Run, 'startedAt' | 'id'>>(runs: readonly T[], direction: SortDirection): T[] {
  return [...runs].sort((a, b) => {
    const am = startedMs(a);
    const bm = startedMs(b);
    if (am === bm) return a.id.localeCompare(b.id);
    if (!Number.isFinite(am)) return 1;
    if (!Number.isFinite(bm)) return -1;
    return direction === 'desc' ? bm - am : am - bm;
  });
}

export function filterRunsWithReceipt<T extends Pick<Run, 'proof' | 'finalized' | 'finalizeInvalidReason'>>(runs: readonly T[], receiptOnly: boolean): T[] {
  return receiptOnly ? runs.filter((run) => runProofSummary(run).hasReceipt) : [...runs];
}

/**
 * Work packages done / total for a run, when the dataset knows them: a package counts as done when
 * it has at least one task and every one of its tasks is completed. `null` when the run carries no
 * work-package list (older runs), so the table shows a dash instead of an invented "0/0".
 */
export function workPackageProgress(run: Pick<Run, 'workPackageIds'>, tasks: readonly Pick<Task, 'workPackageId' | 'status'>[]): { done: number; total: number } | null {
  const total = run.workPackageIds.length;
  if (total === 0) return null;
  let done = 0;
  for (const wp of run.workPackageIds) {
    const own = tasks.filter((task) => task.workPackageId === wp);
    if (own.length > 0 && own.every((task) => task.status === 'completed')) done += 1;
  }
  return { done, total };
}
