/**
 * RecentRunsPanel —: every run of the active project in one table, each with its proof label
 * (the same `finalizeProofLabel()` words the Run health panel uses), so an archival or stale
 * receipt is visible without opening runs one by one.
 *
 * Choosing a row loads that run into the Run health panel below it. Keyboard: every row's run id is
 * a real button (Tab reaches it, Enter/Space chooses it); the sort button sits next to the filter
 * (visible on every viewport) and the Started column reports the order through `aria-sort`. Sort and filter are plain array passes over
 * `state.data.runs` — no new gateway endpoint.
 *
 * XR-COPY1: the words come from `xr-copy.ts` (Dutch first, English unchanged) and dates use the app locale.
 */

import { useMemo, useState } from 'react';
import { Button, EmptyState, Icon, Machine, Panel, StatusBadge, Switch } from '@/components/primitives';
import type { Run, Task } from '@/prototype/types/prototype-types';
import { LocalTime } from '@/views/activity/LocalTime';
import { filterRunsWithReceipt, runProofSummary, sortRunsByStart, workPackageProgress, type SortDirection } from './run-proof-summary';
import './recent-runs-panel.css';
import { useLocale } from '@/i18n/use-locale';
import { formatNumber } from '@/i18n/format';
import { proofWords } from '@/views/tests/proof-words';

export interface RecentRunsPanelProps {
  readonly runs: readonly Run[];
  readonly tasks: readonly Pick<Task, 'workPackageId' | 'status'>[];
  readonly selectedRunId: string | null;
  readonly onSelect: (runId: string) => void;
}

export function RecentRunsPanel({ runs, tasks, selectedRunId, onSelect }: RecentRunsPanelProps) {
  const { t, n, locale } = useLocale();
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [receiptOnly, setReceiptOnly] = useState(false);

  const rows = useMemo(() => sortRunsByStart(filterRunsWithReceipt(runs, receiptOnly), direction), [runs, receiptOnly, direction]);
  const receiptCount = useMemo(() => runs.filter((run) => runProofSummary(run).hasReceipt).length, [runs]);

  const subtitle = n(runs.length, 'rd.tests.runs.subtitleOne', 'rd.tests.runs.subtitleMany', {
    receipts: formatNumber(receiptCount, locale),
  });
  const columns = {
    run: t('rd.tests.runs.th.run'),
    started: t('rd.tests.runs.th.started'),
    status: t('rd.tests.runs.th.status'),
    proof: t('rd.tests.runs.th.proof'),
    packages: t('rd.tests.runs.th.packages'),
  };

  return (
    <Panel title={t('rd.tests.runs.title')} subtitle={subtitle} padded={false} className="fw-tests__panel">
      <div className="fw-runs">
        <div className="fw-runs__filters">
          <div className="fw-runs__controls">
            <Switch size="sm" checked={receiptOnly} onChange={setReceiptOnly} label={t('rd.tests.runs.receiptOnly')} />
            <Button
              size="sm"
              variant="quiet"
              icon={direction === 'desc' ? 'ArrowDown' : 'ArrowUp'}
              aria-label={direction === 'desc' ? t('rd.tests.runs.sortedDesc') : t('rd.tests.runs.sortedAsc')}
              onClick={() => setDirection((d) => (d === 'desc' ? 'asc' : 'desc'))}
            >
              {direction === 'desc' ? t('rd.tests.runs.newest') : t('rd.tests.runs.oldest')}
            </Button>
          </div>
          <p className="fw-runs__count">
            <span className="fw-runs__num">
              {rows.length}/{runs.length}
            </span>{' '}
            {t('rd.tests.runs.shown')}
          </p>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon="SearchX"
            compact
            title={runs.length === 0 ? t('rd.tests.runs.emptyNone') : t('rd.tests.runs.emptyNoReceipt')}
            detail={runs.length === 0 ? t('rd.tests.runs.emptyNoneDetail') : t('rd.tests.runs.emptyNoReceiptDetail')}
          />
        ) : (
          <div className="fw-runs__scroll">
            <table className="fw-runs__table">
              <caption className="fw-visually-hidden">{t('rd.tests.runs.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{columns.run}</th>
                  <th scope="col" aria-sort={direction === 'desc' ? 'descending' : 'ascending'}>
                    {columns.started}
                  </th>
                  <th scope="col">{columns.status}</th>
                  <th scope="col">{columns.proof}</th>
                  <th scope="col">{columns.packages}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((run) => {
                  const proof = runProofSummary(run);
                  const words = proofWords(locale, proof);
                  const wp = workPackageProgress(run, tasks);
                  const selected = run.id === selectedRunId;
                  return (
                    <tr key={run.id} className="fw-runs__row" data-selected={selected ? 'true' : undefined} aria-selected={selected}>
                      <td className="fw-runs__cell fw-runs__cell--id" data-label={columns.run}>
                        <button
                          type="button"
                          className="fw-runs__pick"
                          aria-pressed={selected}
                          aria-label={t('rd.tests.runs.pick', { id: run.id })}
                          onClick={() => onSelect(run.id)}
                        >
                          <Machine className="fw-runs__id">{run.id}</Machine>
                        </button>
                      </td>
                      <td className="fw-runs__cell" data-label={columns.started}>
                        <LocalTime value={run.startedAt} />
                      </td>
                      <td className="fw-runs__cell" data-label={columns.status}>
                        <StatusBadge status={run.status} size="sm" />
                      </td>
                      <td className="fw-runs__cell" data-label={columns.proof}>
                        <span className="fw-runs__proof" data-tone={proof.tone} data-proof={proof.key} title={words.detail}>
                          <Icon name={proof.icon} size="xs" />
                          <span>{words.label}</span>
                        </span>
                      </td>
                      <td className="fw-runs__cell" data-label={columns.packages}>
                        {wp === null ? (
                          <span className="fw-runs__none">
                            <span aria-hidden="true">—</span>
                            <span className="fw-visually-hidden">{t('rd.tests.runs.notRecorded')}</span>
                          </span>
                        ) : (
                          <span className="fw-runs__num">
                            {t('rd.tests.runs.packagesDone', { done: formatNumber(wp.done, locale), total: formatNumber(wp.total, locale) })}
                          </span>
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
