/**
 * Klussen & bewijs (/jobs) — Uitgebreid (DESIGN.md §3.3, §3.7).
 *
 * The active project's klussen (runs), newest first, as list rows with the same pattern as Mijn
 * projecten: the title, one line of detail, the status word, when it last worked, and a proof link.
 * Picking a row (or its "Bekijk bewijs" link) shows that klus in place, with a way back: its work
 * packages and tasks and its opleverbewijs (the recorded checks with their proof pointers, the reviews,
 * and the finalize receipt as the central acceptance judged it). Every value comes from the gateway
 * (adapter/jobs.ts); nothing is invented, and a down gateway is an error state, never an empty list.
 *
 * The project page embeds the same panel as its Klussen & bewijs tab (`embedded`: no page title).
 */

import './xpage.css';
import './jobs.css';

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { usePendingAskCount, useJobsList, useJobDetail, useProjectListStatus, jobStatus } from '@/prototype/state/adapter/jobs';
import type { JobsList, Loaded, LoadStatus } from '@/prototype/state/adapter/jobs';
import type { RunRow } from '@/prototype/state/adapter/rows';
import { usePrototype } from '@/prototype/state/prototype-store';

import { JobDetailPanel } from './JobDetail';
import { relativeWhen } from './when';

/** What a pick should bring into view: the klus from the top, or its opleverbewijs. */
export type JobFocus = 'proof';

export interface JobsPanelProps {
  readonly projectName: string;
  readonly list: Loaded<JobsList>;
  readonly pendingAsks: number;
  readonly selectedId: string | null;
  readonly onSelect: (runId: string | null, focus?: JobFocus) => void;
  readonly onOpenChat: () => void;
  /** Whether the project list could be read (only consulted while no project is active). */
  readonly projectsStatus?: LoadStatus;
  /** Scroll to the proof of the selected klus once it is shown. */
  readonly focus?: JobFocus | null;
  /** Inside the project page: no page title of its own. */
  readonly embedded?: boolean;
}

/** The presentational screen; `JobsView` below wires it to the store and the gateway. */
export function JobsPanel({
  projectName,
  list,
  pendingAsks,
  selectedId,
  onSelect,
  onOpenChat,
  projectsStatus = 'ready',
  focus = null,
  embedded = false,
}: JobsPanelProps) {
  const { t } = useLocale();
  const rows = list.value.rows;
  const selected = rows.find((row) => row.runId === selectedId) ?? null;

  const header = embedded ? null : (
    <header className="fw-xpage__header">
      <div className="fw-xpage__title">
        <h1>{t('jobs.title')}</h1>
        {projectName !== '' ? <p>{t('jobs.subtitle', { project: projectName })}</p> : null}
      </div>
    </header>
  );

  if (projectName === '' && projectsStatus === 'error') {
    return (
      <div className="fw-xpage">
        {header}
        <div className="fw-xpage__body">
          <section className="fw-xpage__state" role="alert" aria-labelledby="fw-jobs-down">
            <h2 id="fw-jobs-down">{t('jobs.error.title')}</h2>
            <p>{t('jobs.error.body')}</p>
          </section>
        </div>
      </div>
    );
  }

  if (projectName === '') {
    return (
      <div className="fw-xpage">
        {header}
        <div className="fw-xpage__body">
          <section className="fw-xpage__state" aria-labelledby="fw-jobs-noproject">
            <h2 id="fw-jobs-noproject">{t('jobs.noProject.title')}</h2>
            <p>{t('jobs.noProject.body')}</p>
          </section>
        </div>
      </div>
    );
  }

  let content;
  if (list.status === 'loading') {
    content = (
      <p className="fw-xpage__note" role="status">
        <Icon name="Loader" size="sm" />
        {t('jobs.loading')}
      </p>
    );
  } else if (list.status === 'error') {
    content = (
      <section className="fw-xpage__state" role="alert" aria-labelledby="fw-jobs-error">
        <h2 id="fw-jobs-error">{t('jobs.error.title')}</h2>
        <p>{t('jobs.error.body')}</p>
        <Button variant="primary" size="sm" icon="RotateCcw" onClick={list.reload}>
          {t('jobs.error.retry')}
        </Button>
        {list.error ? (
          <details>
            <summary>{t('jobs.error.details')}</summary>
            <span className="fw-xpage__mono" data-log-text>
              {list.error}
            </span>
          </details>
        ) : null}
      </section>
    );
  } else if (rows.length === 0) {
    content = (
      <div className="fw-xpage__empty" aria-labelledby="fw-jobs-empty">
        <p id="fw-jobs-empty">{t('jobs.empty.title')}</p>
        <Button variant="secondary" icon="MessagesSquare" onClick={onOpenChat}>
          {t('jobs.empty.action')}
        </Button>
      </div>
    );
  } else if (selected !== null) {
    content = <SelectedJob projectName={projectName} row={selected} focus={focus} onBack={() => onSelect(null)} />;
  } else {
    content = (
      <>
        <ul className="fw-xlist fw-jobs__list" aria-label={t('jobs.listLabel')}>
          {rows.map((row) => (
            <JobListItem
              key={row.runId}
              row={row}
              onSelect={() => onSelect(row.runId)}
              onProof={() => onSelect(row.runId, 'proof')}
            />
          ))}
        </ul>
        {list.value.truncated ? (
          <p className="fw-xpage__note">
            <Icon name="Info" size="sm" />
            {t('jobs.truncated')}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="fw-xpage">
      {header}
      <div className="fw-xpage__body">
        {pendingAsks > 0 ? (
          <div className="fw-jobs__asks" role="status">
            <span className="fw-xstatus" data-status="waiting">
              {t('jobs.status.waiting')}
            </span>
            <span className="fw-jobs__asks-text">
              {pendingAsks === 1 ? t('jobs.pendingAsksOne') : t('jobs.pendingAsksMany', { count: pendingAsks })}
            </span>
            <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={onOpenChat}>
              {t('jobs.openAsks')}
            </Button>
          </div>
        ) : null}
        {content}
      </div>
    </div>
  );
}

function JobListItem({ row, onSelect, onProof }: { readonly row: RunRow; readonly onSelect: () => void; readonly onProof: () => void }) {
  const { t, locale } = useLocale();
  const status = jobStatus(row);
  const when = relativeWhen(row.lastWorkAt ?? row.startedAt ?? row.mtime, locale);
  return (
    <li>
      <div className="fw-xrow fw-jobs__item">
        <button type="button" className="fw-xrow__main" onClick={onSelect}>
          <span className="fw-xrow__text">
            <span className="fw-xrow__name">
              <span className="fw-xrow__name-text fw-jobs__item-title">{row.title?.trim() ? row.title : t('jobs.untitled')}</span>
            </span>
            <span className="fw-xrow__sub">{t(`jobs.detail.${status.detail}`)}</span>
          </span>
        </button>
        <span className="fw-xstatus" data-status={status.simple}>
          {t(`jobs.status.${status.simple}`)}
        </span>
        <span className="fw-xrow__when">{when}</span>
        <span className="fw-xrow__aside">
          <button type="button" className="fw-xrow__link" onClick={onProof}>
            <Icon name="ShieldCheck" size="xs" />
            {t('rd.projects.proofLink')}
          </button>
        </span>
        <Icon name="ChevronRight" size="sm" className="fw-xrow__chev" />
      </div>
    </li>
  );
}

function SelectedJob({
  projectName,
  row,
  focus,
  onBack,
}: {
  readonly projectName: string;
  readonly row: RunRow;
  readonly focus: JobFocus | null;
  readonly onBack: () => void;
}) {
  const detail = useJobDetail(projectName, row.runId);
  return <JobDetailPanel row={row} detail={detail} onBack={onBack} focusProof={focus === 'proof'} />;
}

export function JobsView({ embedded = false }: { readonly embedded?: boolean }) {
  const { state } = usePrototype();
  const navigate = useNavigate();
  const projectName = state.activeProjectId;
  const list = useJobsList(projectName);
  const pendingAsks = usePendingAskCount(projectName);
  const projectsStatus = useProjectListStatus(projectName === '');
  const [picked, setPicked] = useState<{ readonly project: string; readonly runId: string | null; readonly focus: JobFocus | null } | null>(
    null,
  );
  // The list comes first; a picked klus replaces it until the owner goes back.
  const current = picked !== null && picked.project === projectName ? picked : null;

  return (
    <JobsPanel
      projectName={projectName}
      list={list}
      pendingAsks={pendingAsks}
      selectedId={current?.runId ?? null}
      focus={current?.focus ?? null}
      onSelect={(runId, focus) => setPicked({ project: projectName, runId, focus: focus ?? null })}
      onOpenChat={() => navigate('/chat')}
      projectsStatus={projectsStatus}
      embedded={embedded}
    />
  );
}

export default JobsView;
