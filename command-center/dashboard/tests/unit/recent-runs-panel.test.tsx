/**
 * (defect 2, high): Tests & proof only ever showed the newest run, so the archival /
 * stale proof labels on older runs (correct in `/api/runs`) could never be seen. These tests pin
 * the Recent runs table: one row per run with the shared proof label, newest first with a sort
 * toggle, a "with receipt only" filter, an empty-state sentence, and a row choice that reports the
 * run id upward (TestsView loads it into Run health). Also the `/api/runs` row → `proof` parsing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { parseRunRows } from '@/prototype/state/adapter/rows';
import { RecentRunsPanel } from '@/views/tests/RecentRunsPanel';
import { filterRunsWithReceipt, runProofSummary, sortRunsByStart, workPackageProgress } from '@/views/tests/run-proof-summary';
import type { Run } from '@/prototype/types/prototype-types';

const ARCHIVAL_PROOF = { available: true, pending: false, verdict: 'HISTORICAL', cause: 'ruleset', reverified: false, archival: true, completionProof: true, allowlisted: 'pre-pinned-ruleset' };
const VERIFIED_PROOF = { available: true, pending: false, verdict: 'FINALIZED', cause: null, reverified: true, archival: false, completionProof: true, allowlisted: null };
const STALE_PROOF = { available: true, pending: false, verdict: 'STALE', cause: null, reverified: null, archival: null, completionProof: false, allowlisted: null };

function run(id: string, startedAt: string, extra: Partial<Run> = {}): Run {
  return {
    id,
    projectId: 'p',
    goal: '',
    status: 'completed',
    startedAt,
    duration: '',
    workPackageIds: [],
    agentIds: [],
    prototype: false,
    finalized: false,
    proof: null,
    finalizeInvalidReason: null,
    ...extra,
  } as unknown as Run;
}

const RUNS: Run[] = [
  run('run-old-archival', '2026-09-01T10:00:00.000Z', { finalized: true, proof: ARCHIVAL_PROOF }),
  run('run-new-live', '2026-10-09T20:35:52.124Z', { status: 'running' }),
  run('run-mid-verified', '2026-10-01T08:00:00.000Z', { finalized: true, proof: VERIFIED_PROOF, workPackageIds: ['WP-1', 'WP-2'] }),
  run('run-stale', '2026-09-20T08:00:00.000Z', { finalized: true, proof: STALE_PROOF }),
];

afterEach(() => cleanup());

describe('runProofSummary — the shared label, never "finalized" just because a file exists', () => {
  it('maps an archival receipt to "Archival record (not re-verified)"', () => {
    const s = runProofSummary(RUNS[0]);
    expect(s.label).toBe('Archival record (not re-verified)');
    expect(s.short).toBe('archival, not re-verified');
    expect(s.hasReceipt).toBe(true);
  });

  it('maps verified, stale, invalid and no-receipt runs', () => {
    expect(runProofSummary(RUNS[2]).label).toBe('Finalized (verified)');
    expect(runProofSummary(RUNS[3]).label).toBe('Stale');
    expect(runProofSummary(run('x', '', { finalizeInvalidReason: 'the log changed after it was finalized' })).label).toBe('Receipt no longer counts');
    const none = runProofSummary(RUNS[1]);
    expect(none.label).toBe('Not finalized');
    expect(none.hasReceipt).toBe(false);
  });

  it('a finalized run whose proof was not reported is "Proof not confirmed", not verified', () => {
    expect(runProofSummary(run('x', '', { finalized: true, proof: null })).label).toBe('Proof not confirmed');
  });
});

describe('sort, filter and work-package progress', () => {
  it('sorts newest first, and oldest first on request; unreadable dates last', () => {
    const withBad = [...RUNS, run('run-no-date', 'not a date')];
    expect(sortRunsByStart(withBad, 'desc').map((r) => r.id)).toEqual(['run-new-live', 'run-mid-verified', 'run-stale', 'run-old-archival', 'run-no-date']);
    expect(sortRunsByStart(withBad, 'asc').map((r) => r.id)).toEqual(['run-old-archival', 'run-stale', 'run-mid-verified', 'run-new-live', 'run-no-date']);
  });

  it('"with receipt only" drops runs without a receipt', () => {
    expect(filterRunsWithReceipt(RUNS, true).map((r) => r.id)).not.toContain('run-new-live');
    expect(filterRunsWithReceipt(RUNS, false)).toHaveLength(4);
  });

  it('counts a work package done only when all its tasks are completed; null without a list', () => {
    const tasks = [
      { workPackageId: 'WP-1', status: 'completed' as const },
      { workPackageId: 'WP-1', status: 'completed' as const },
      { workPackageId: 'WP-2', status: 'running' as const },
    ];
    expect(workPackageProgress(RUNS[2], tasks)).toEqual({ done: 1, total: 2 });
    expect(workPackageProgress(RUNS[1], tasks)).toBeNull();
  });
});

describe('RecentRunsPanel (rendered)', () => {
  it('renders one row per run, newest first, with the archival label visible', () => {
    render(<RecentRunsPanel runs={RUNS} tasks={[]} selectedRunId={null} onSelect={() => undefined} />);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1); // minus the header row
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText('run-new-live')).toBeTruthy();
    expect(screen.getByText('Archival record (not re-verified)')).toBeTruthy();
    expect(screen.getByText('Stale')).toBeTruthy();
  });

  it('choosing a run id reports it (keyboard-reachable button) and marks the row selected', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<RecentRunsPanel runs={RUNS} tasks={[]} selectedRunId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show run health for run-old-archival' }));
    expect(onSelect).toHaveBeenCalledWith('run-old-archival');
    rerender(<RecentRunsPanel runs={RUNS} tasks={[]} selectedRunId="run-old-archival" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: 'Show run health for run-old-archival' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the sort button flips the order and aria-sort follows', () => {
    render(<RecentRunsPanel runs={RUNS} tasks={[]} selectedRunId={null} onSelect={() => undefined} />);
    const header = screen.getByRole('columnheader', { name: /Started/ });
    expect(header.getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(screen.getByRole('button', { name: /Sort oldest first/ }));
    expect(screen.getByRole('columnheader', { name: /Started/ }).getAttribute('aria-sort')).toBe('ascending');
    const first = within(screen.getByRole('table')).getAllByRole('row')[1];
    expect(within(first).getByText('run-old-archival')).toBeTruthy();
  });

  it('the receipt filter hides runs without a receipt', () => {
    render(<RecentRunsPanel runs={RUNS} tasks={[]} selectedRunId={null} onSelect={() => undefined} />);
    fireEvent.click(screen.getByRole('switch', { name: 'With receipt only' }));
    expect(screen.queryByText('run-new-live')).toBeNull();
    expect(screen.getByText('run-old-archival')).toBeTruthy();
  });

  it('says so in a sentence when there are no runs', () => {
    render(<RecentRunsPanel runs={[]} tasks={[]} selectedRunId={null} onSelect={() => undefined} />);
    expect(screen.getByText('No runs recorded for this project yet')).toBeTruthy();
  });
});

describe('parseRunRows reads the /api/runs proof fields', () => {
  it('keeps the acceptance object and the invalid reason', () => {
    const rows = parseRunRows({
      runs: [
        { run_id: 'a', proof: { available: true, pending: false, verdict: 'HISTORICAL', cause: 'ruleset', reverified: false, archival: true, completion_proof: true, allowlisted: 'pre-pinned-ruleset' } },
        { run_id: 'b', proof: null, finalize_invalid_reason: 'the log changed after it was finalized' },
      ],
    });
    expect(rows[0].proof).toEqual(ARCHIVAL_PROOF);
    expect(rows[1].proof).toBeNull();
    expect(rows[1].finalizeInvalidReason).toBe('the log changed after it was finalized');
  });
});
