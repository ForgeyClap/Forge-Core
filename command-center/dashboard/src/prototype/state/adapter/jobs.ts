/**
 * Forge Command Center — "Klussen & bewijs" slice (WP B5).
 *
 * A klus is a Forge run. This slice reads the same three gateway routes the Activity, Mission and
 * Tests views already read, and reuses their parsers instead of re-deriving anything:
 *   - `GET /api/runs?project=`            → the list (`parseRunRows`, rows.ts)
 *   - `GET /api/missions?project=&run=`   → the work packages and tasks (`parseMissionPayload`)
 *   - `GET /api/proof?project=&run=`      → checks, reviews and the finalize receipt
 *                                           (`parseGatewayReviews`, `parseFinalizeReceipt`)
 *   - `GET /api/pending-asks?project=`    → questions that wait for the owner (a conversation
 *                                           fact, not a run fact: shown as a banner, never pinned
 *                                           to a run it cannot be joined to)
 *
 * Unlike the older polling hooks, every hook here reports `status` ('loading' | 'ready' | 'error')
 * so the screen can show a real error state when the gateway is down, instead of an empty list
 * that reads like "no jobs". A failed poll keeps the last good value (same rule as mindmaps.ts).
 */

import { useCallback, useEffect, useState } from 'react';

import { gwGet, pickArray, pickNumber, pickString } from '@/prototype/state/gateway-client';
import { parseFinalizeReceipt, parseGatewayReviews } from './graph-and-proof';
import type { GatewayFinalizeReceipt, GatewayReview } from './graph-and-proof';
import { finalizeProofLabel } from './finalize-proof-label';
import type { FinalizeProofKey } from './finalize-proof-label';
import type { LoadStatus } from './mindmaps';
import { parseMissionPayload, parseRunRows, parseRunsTruncated, workPackageJoinId } from './rows';
import type { MissionPayload, MissionTaskRow, RunRow } from './rows';

export type { LoadStatus };

const JOBS_POLL_MS = 5000;

/* ------------------------------------------------------------------ status words */

/** The four Eenvoudig words (plan §4.2, PRODUCT-CARD.md): Bezig · Wacht op jou · Klaar · Gepauzeerd. */
export type JobSimpleStatus = 'busy' | 'waiting' | 'done' | 'paused';

/** The Uitgebreid detail behind the simple word, one per run status the gateway reports. */
export type JobDetailStatus =
  | 'live'
  | 'waiting'
  | 'stalled'
  | 'endedUnknown'
  | 'failed'
  | 'finalized'
  | 'completed'
  | 'reportOnly'
  | 'unknown';

export interface JobStatus {
  readonly simple: JobSimpleStatus;
  readonly detail: JobDetailStatus;
}

/**
 * Maps the gateway's run status (`runs.mjs::deriveStatus`, see `toRunStatusKey` in rows.ts for the
 * seven buckets) to the four simple words plus a detail. A failed or stalled run reads
 * "Gepauzeerd" in the simple word on purpose, exactly like the chat status (status-model.ts): the
 * detail next to it says what happened. `waiting*` is not in today's run vocabulary; it is mapped so
 * a future gateway value is shown honestly rather than as "unknown".
 */
export function jobStatus(row: Pick<RunRow, 'status' | 'finalized' | 'hasFinalReport'>): JobStatus {
  const raw = (row.status ?? '').trim().toLowerCase();
  if (raw === 'live' || raw === 'running') return { simple: 'busy', detail: 'live' };
  if (raw.startsWith('waiting')) return { simple: 'waiting', detail: 'waiting' };
  if (raw === 'finalized' || row.finalized === true) return { simple: 'done', detail: 'finalized' };
  if (raw === 'completed') return { simple: 'done', detail: 'completed' };
  if (raw === 'report-only') return { simple: 'done', detail: 'reportOnly' };
  if (raw === 'stalled') return { simple: 'paused', detail: 'stalled' };
  if (raw === 'ended_unknown') return { simple: 'paused', detail: 'endedUnknown' };
  if (raw === 'failed') return { simple: 'paused', detail: 'failed' };
  if (raw === '' && row.hasFinalReport) return { simple: 'done', detail: 'reportOnly' };
  return { simple: 'paused', detail: 'unknown' };
}

/** The newest work first: last work, then start, then the folder's mtime. */
function jobSortKey(row: RunRow): number {
  for (const value of [row.lastWorkAt, row.startedAt, row.mtime]) {
    const ms = value ? Date.parse(value) : Number.NaN;
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

export function sortJobs(rows: readonly RunRow[]): readonly RunRow[] {
  return [...rows].filter((row) => row.runId !== '' && row.synthetic !== true).sort((a, b) => jobSortKey(b) - jobSortKey(a));
}

/* ------------------------------------------------------------------ list */

export interface JobsList {
  readonly rows: readonly RunRow[];
  readonly truncated: boolean;
}

export const EMPTY_JOBS_LIST: JobsList = { rows: [], truncated: false };

export function parseJobsList(data: Record<string, unknown>): JobsList {
  return { rows: sortJobs(parseRunRows(data)), truncated: parseRunsTruncated(data) };
}

export interface Loaded<T> {
  readonly status: LoadStatus;
  readonly value: T;
  readonly error: string | null;
  readonly reload: () => void;
}

interface Slot<T> {
  readonly key: string;
  readonly status: LoadStatus;
  readonly value: T;
  readonly error: string | null;
}

/**
 * One keyed poll with a real status. `load` returns the parsed value or an error string; a failed
 * poll after a good one keeps the good value on screen.
 */
function useKeyedPoll<T>(
  key: string | null,
  load: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
  empty: T,
  pollMs: number,
): Loaded<T> {
  const [slot, setSlot] = useState<Slot<T>>({ key: '', status: 'loading', value: empty, error: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (key === null) return undefined;
    const activeKey = key;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await load();
      if (cancelled) return;
      if (result.ok) setSlot({ key: activeKey, status: 'ready', value: result.value, error: null });
      else
        setSlot((prev) =>
          prev.key === activeKey && prev.status === 'ready'
            ? prev
            : { key: activeKey, status: 'error', value: empty, error: result.error },
        );
    }
    void tick();
    const id = pollMs > 0 ? setInterval(() => void tick(), pollMs) : null;
    return () => {
      cancelled = true;
      if (id !== null) clearInterval(id);
    };
    // `load` is rebuilt every render from the same key; the key is what identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, pollMs]);

  if (key === null || slot.key !== key) return { status: 'loading', value: empty, error: null, reload };
  return { status: slot.status, value: slot.value, error: slot.error, reload };
}

/** The active project's klussen, newest first. `projectName === ''` stays 'loading' (nothing to ask). */
export function useJobsList(projectName: string): Loaded<JobsList> {
  return useKeyedPoll(
    projectName === '' ? null : projectName,
    async () => {
      const result = await gwGet(`/api/runs?project=${encodeURIComponent(projectName)}`);
      return result.ok ? { ok: true, value: parseJobsList(result.data) } : { ok: false, error: result.error };
    },
    EMPTY_JOBS_LIST,
    JOBS_POLL_MS,
  );
}

/** How many owner questions wait in this project's conversations (`/api/pending-asks`). */
export function parsePendingAskCount(data: Record<string, unknown>): number {
  const explicit = pickNumber(data, ['count']);
  return explicit ?? pickArray(data, ['pending_asks', 'asks']).length;
}

export function usePendingAskCount(projectName: string): number {
  const loaded = useKeyedPoll(
    projectName === '' ? null : projectName,
    async () => {
      const result = await gwGet(`/api/pending-asks?project=${encodeURIComponent(projectName)}`);
      return result.ok ? { ok: true, value: parsePendingAskCount(result.data) } : { ok: false, error: result.error };
    },
    0,
    JOBS_POLL_MS,
  );
  return loaded.status === 'ready' ? loaded.value : 0;
}

/* ------------------------------------------------------------------ detail */

export type WorkPackageState = 'busy' | 'done' | 'failed' | 'open';

export interface JobWorkPackage {
  readonly key: string;
  /** The display code as the logs write it, or null. */
  readonly code: string | null;
  readonly title: string | null;
  readonly agent: string | null;
  readonly state: WorkPackageState;
  readonly taskCount: number;
}

export interface JobCheck {
  readonly key: string;
  /** 'forge' = the doctor tally of Forge itself; 'check' = one recorded check event. */
  readonly kind: 'forge' | 'check';
  readonly name: string | null;
  readonly passed: boolean;
  readonly who: string | null;
  readonly command: string | null;
  /** A path or note that points at the proof, when the check recorded one as text. */
  readonly pointer: string | null;
  readonly at: string | null;
  readonly forgePassed: number | null;
  readonly forgeFailed: number | null;
}

export interface JobReceipt {
  readonly present: boolean;
  readonly finalizedAt: string | null;
  readonly invalidReason: string | null;
  /** The central acceptance verdict, as a key the screen translates; null without a receipt. */
  readonly proofKey: FinalizeProofKey | null;
}

export interface JobDetail {
  readonly workPackages: readonly JobWorkPackage[];
  /** Tasks that belong to no recorded work package (an older run, or a loose dispatch). */
  readonly looseTasks: readonly MissionTaskRow[];
  readonly checks: readonly JobCheck[];
  readonly reviews: readonly GatewayReview[];
  readonly receipt: JobReceipt;
}

export const EMPTY_JOB_DETAIL: JobDetail = {
  workPackages: [],
  looseTasks: [],
  checks: [],
  reviews: [],
  receipt: { present: false, finalizedAt: null, invalidReason: null, proofKey: null },
};

function taskWpKey(task: MissionTaskRow): string {
  return task.wpId ?? task.wpGuess ?? '';
}

function workPackageState(tasks: readonly MissionTaskRow[]): WorkPackageState {
  if (tasks.some((task) => task.status === 'running')) return 'busy';
  if (tasks.some((task) => task.status === 'failed')) return 'failed';
  if (tasks.length > 0 && tasks.every((task) => task.status === 'completed')) return 'done';
  return 'open';
}

export function buildWorkPackages(mission: MissionPayload): { readonly wps: readonly JobWorkPackage[]; readonly loose: readonly MissionTaskRow[] } {
  const claimed = new Set<MissionTaskRow>();
  const seen = new Set<string>();
  const wps: JobWorkPackage[] = [];
  mission.wps.forEach((wp, index) => {
    const join = workPackageJoinId(wp);
    const key = join !== '' ? join : `wp-${index}`;
    // The mission log can record the same work package more than once (a re-plan); show it once.
    if (seen.has(key)) return;
    seen.add(key);
    const joinLower = join.toLowerCase();
    const codeLower = (wp.id ?? '').toLowerCase();
    const tasks = mission.tasks.filter((task) => {
      const tk = taskWpKey(task).toLowerCase();
      return tk !== '' && (tk === joinLower || tk === codeLower);
    });
    tasks.forEach((task) => claimed.add(task));
    wps.push({
      key,
      code: wp.id ?? wp.wpId ?? null,
      title: wp.note ?? wp.summary ?? null,
      agent: wp.agent,
      state: workPackageState(tasks),
      taskCount: tasks.length,
    });
  });
  return { wps, loose: mission.tasks.filter((task) => !claimed.has(task)) };
}

function pointerText(row: Record<string, unknown>): string | null {
  const evidence = row.evidence;
  if (typeof evidence === 'string' && evidence.trim() !== '') return evidence.trim();
  if (Array.isArray(evidence)) {
    const strings = evidence.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    if (strings.length > 0) return strings.join(', ');
  }
  return null;
}

export function parseJobChecks(proof: Record<string, unknown>): readonly JobCheck[] {
  return pickArray(proof, ['verdicts']).map((row, index) => {
    const source = pickString(row, ['source']);
    if (source === 'doctor') {
      const failed = pickNumber(row, ['failed']);
      return {
        key: `forge-${index}`,
        kind: 'forge' as const,
        name: null,
        passed: row.ok === true || failed === 0,
        who: null,
        command: null,
        pointer: null,
        at: pickString(row, ['captured_at', 'timestamp']),
        forgePassed: pickNumber(row, ['passed']),
        forgeFailed: failed,
      };
    }
    return {
      key: `check-${index}`,
      kind: 'check' as const,
      name: pickString(row, ['check']) ?? pickString(row, ['summary']),
      passed: pickString(row, ['event_type']) === 'check_passed',
      who: pickString(row, ['agent']) ?? pickString(row, ['role']),
      command: pickString(row, ['command']),
      pointer: pointerText(row),
      at: pickString(row, ['timestamp']),
      forgePassed: null,
      forgeFailed: null,
    };
  });
}

export function toJobReceipt(receipt: GatewayFinalizeReceipt): JobReceipt {
  return {
    present: receipt.present,
    finalizedAt: receipt.finalizedAt,
    invalidReason: receipt.invalidReason,
    proofKey: receipt.present && receipt.proof !== null ? finalizeProofLabel(receipt.proof).key : null,
  };
}

export function buildJobDetail(runId: string, missionData: Record<string, unknown>, proofData: Record<string, unknown>): JobDetail {
  const { wps, loose } = buildWorkPackages(parseMissionPayload(runId, missionData));
  return {
    workPackages: wps,
    looseTasks: loose,
    checks: parseJobChecks(proofData),
    reviews: parseGatewayReviews(proofData),
    receipt: toJobReceipt(parseFinalizeReceipt(proofData)),
  };
}

/** One klus in detail. Missions and proof are fetched together; either failing is an error. */
export function useJobDetail(projectName: string, runId: string | null): Loaded<JobDetail> {
  const key = projectName === '' || runId === null ? null : `${projectName}\u0000${runId}`;
  return useKeyedPoll(
    key,
    async () => {
      const rid = runId ?? '';
      const query = `project=${encodeURIComponent(projectName)}&run=${encodeURIComponent(rid)}`;
      const [mission, proof] = await Promise.all([gwGet(`/api/missions?${query}`), gwGet(`/api/proof?${query}`)]);
      if (!mission.ok) return { ok: false, error: mission.error };
      if (!proof.ok) return { ok: false, error: proof.error };
      return { ok: true, value: buildJobDetail(rid, mission.data, proof.data) };
    },
    EMPTY_JOB_DETAIL,
    JOBS_POLL_MS * 2,
  );
}

/**
 * Whether the project list itself can be read. Used only while no project is active: without it,
 * a gateway that is down would read as "no project chosen yet", which is not true.
 */
export function useProjectListStatus(enabled: boolean): LoadStatus {
  const loaded = useKeyedPoll(
    enabled ? 'projects' : null,
    async () => {
      const result = await gwGet('/api/projects');
      return result.ok ? { ok: true, value: true } : { ok: false, error: result.error };
    },
    false,
    JOBS_POLL_MS,
  );
  return enabled ? loaded.status : 'ready';
}
