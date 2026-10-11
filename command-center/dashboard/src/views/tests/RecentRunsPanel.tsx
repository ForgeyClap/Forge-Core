/**
 * RecentRunsPanel —: every run of the active project in one table, each with its proof label
 * (the same `finalizeProofLabel()` words the Run health panel uses), so an archival or stale
 * receipt is visible without opening runs one by one.
 *
 * Choosing a row loads that run into the Run health panel below it. Keyboard: every row's run id is
 * a real button (Tab reaches it, Enter/Space chooses it); the sort button sits next to the filter
 * (visible on every viewport) and the Started column reports the order through `aria-sort`. Sort and filter are plain array passes over
 * `state.data.runs` — no new gateway endpoint.
 */

import { useMemo, useState } from 'react';
import { Button, EmptyState, Icon, Machine, Panel, StatusBadge, Switch, Timestamp } from '@/components/primitives';
import type { Run, Task } from '@/prototype/types/prototype-types';
import { filterRunsWithReceipt, runProofSummary, sortRunsByStart, workPackageProgress, type SortDirection } from './run-proof-summary';
import './recent-runs-panel.css';

export interface RecentRunsPanelProps {
  readonly runs: readonly Run[];
  readonly tasks: readonly Pick<Task, 'workPackageId' | 'status'>[];
  readonly selectedRunId: string | null;
  readonly onSelect: (runId: string) => void;
}

export function RecentRunsPanel({ runs, tasks, selectedRunId, onSelect }: RecentRunsPanelProps) {
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [receiptOnly, setReceiptOnly] = useState(false);

  const rows = useMemo(() => sortRunsByStart(filterRunsWithReceipt(runs, receiptOnly), direction), [runs, receiptOnly, direction]);
  const receiptCount = useMemo(() => runs.filter((run) => runProofSummary(run).hasReceipt).length, [runs]);

  const subtitle = `${runs.length} run${runs.length === 1 ? '' : 's'}, ${receiptCount} with a finalize receipt. Choose a run to read its health below.`;

  return (
    <Panel title="Recent runs" subtitle={subtitle} padded={false} className="fw-tests__panel">
      <div className="fw-runs">
        <div className="fw-runs__filters">
          <div className="fw-runs__controls">
            <Switch size="sm" checked={receiptOnly} onChange={setReceiptOnly} label="With receipt only" />
            <Button
              size="sm"
              variant="quiet"
              icon={direction === 'desc' ? 'ArrowDown' : 'ArrowUp'}
              aria-label={direction === 'desc' ? 'Sorted newest first. Sort oldest first' : 'Sorted oldest first. Sort newest first'}
              onClick={() => setDirection((d) => (d === 'desc' ? 'asc' : 'desc'))}
            >
              {direction === 'desc' ? 'Newest first' : 'Oldest first'}
            </Button>
          </div>
          <p className="fw-runs__count">
            <Machine muted>
              {rows.length}/{runs.length}
            </Machine>{' '}
            shown
          </p>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon="SearchX"
            compact
            title={runs.length === 0 ? 'No runs recorded for this project yet' : 'No run has a finalize receipt yet'}
            detail={
              runs.length === 0
                ? 'A run appears here as soon as Forge writes its first event.'
                : 'Turn off "With receipt only" to see every run.'
            }
          />
        ) : (
          <div className="fw-runs__scroll">
            <table className="fw-runs__table">
              <caption className="fw-visually-hidden">
                Runs of this project with their status and finalize proof. Choose a run id to load it into Run health.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col" aria-sort={direction === 'desc' ? 'descending' : 'ascending'}>
                    Started
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Proof</th>
                  <th scope="col">Work packages</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((run) => {
                  const proof = runProofSummary(run);
                  const wp = workPackageProgress(run, tasks);
                  const selected = run.id === selectedRunId;
                  return (
                    <tr key={run.id} className="fw-runs__row" data-selected={selected ? 'true' : undefined} aria-selected={selected}>
                      <td className="fw-runs__cell fw-runs__cell--id" data-label="Run">
                        <button
                          type="button"
                          className="fw-runs__pick"
                          aria-pressed={selected}
                          aria-label={`Show run health for ${run.id}`}
                          onClick={() => onSelect(run.id)}
                        >
                          <Machine className="fw-runs__id">{run.id}</Machine>
                        </button>
                      </td>
                      <td className="fw-runs__cell" data-label="Started">
                        <Timestamp value={run.startedAt} />
                      </td>
                      <td className="fw-runs__cell" data-label="Status">
                        <StatusBadge status={run.status} size="sm" />
                      </td>
                      <td className="fw-runs__cell" data-label="Proof">
                        <span className="fw-runs__proof" data-tone={proof.tone} data-proof={proof.key} title={proof.detail}>
                          <Icon name={proof.icon} size="xs" />
                          <span>{proof.label}</span>
                        </span>
                      </td>
                      <td className="fw-runs__cell" data-label="Work packages">
                        {wp === null ? (
                          <span className="fw-runs__none">
                            <span aria-hidden="true">—</span>
                            <span className="fw-visually-hidden">not recorded</span>
                          </span>
                        ) : (
                          <Machine muted>
                            {wp.done}/{wp.total} done
                          </Machine>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default RecentRunsPanel;
