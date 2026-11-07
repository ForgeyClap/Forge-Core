/**
 * One klus in detail (WP B5): status, work packages and tasks, and the opleverbewijs (checks with
 * their proof pointers, reviews, the finalize receipt). Presentational: the data arrives as props
 * from `useJobDetail` (adapter/jobs.ts). English names from the logs (role names, check commands,
 * the run id) are Uitgebreid detail and carry `data-log-name` / `data-log-text`, the same markers
 * the Team screen uses, so a copy scan can tell interface copy from log data.
 *
 * Start's step "Bekijk een opleverbewijs" ticks here (`markStartProofSeen`), and only when a real
 * proof was on screen: the klus has a finalize receipt, a recorded check or a review, and the proof section
 * entered the viewport. Empty proof lines are not a proof; without an IntersectionObserver nothing ticks.
 */

import { useEffect, useRef } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { jobStatus } from '@/prototype/state/adapter/jobs';
import type { JobCheck, JobDetail, JobReceipt, JobWorkPackage, Loaded } from '@/prototype/state/adapter/jobs';
import type { RunRow } from '@/prototype/state/adapter/rows';
import { roleFromName } from '@/views/team/team-data';

import { markStartProofSeen } from '@/views/home/start-checklist';

import { relativeWhen } from './when';

export interface JobDetailPanelProps {
  readonly row: RunRow;
  readonly detail: Loaded<JobDetail>;
  readonly onBack: () => void;
  /** Bring the opleverbewijs into view once it has loaded (the row's "Bekijk bewijs" link). */
  readonly focusProof?: boolean;
}

/** "Bouwer" for a known helper, the raw log name otherwise. */
function Who({ name }: { readonly name: string | null }) {
  const { t } = useLocale();
  if (name === null || name.trim() === '') return <>{t('jobs.someone')}</>;
  const role = roleFromName(name);
  if (role === null) return <span data-log-name>{name}</span>;
  return (
    <>
      {t(`team.roles.${role}`)} <span className="fw-jobs__logname" data-log-name>({name})</span>
    </>
  );
}

/** A proof the user can actually read: a receipt, a recorded check or a review (not just the empty lines). */
function hasRealProof(detail: JobDetail): boolean {
  return detail.receipt.present || detail.checks.length > 0 || detail.reviews.length > 0;
}

const WP_ICON: Readonly<Record<JobWorkPackage['state'], string>> = {
  busy: 'CircleDot',
  done: 'CircleCheck',
  failed: 'CircleX',
  open: 'Circle',
};

function WorkPackages({ detail }: { readonly detail: JobDetail }) {
  const { t } = useLocale();
  if (detail.workPackages.length === 0 && detail.looseTasks.length === 0) {
    return <p className="fw-jobs__empty-line">{t('jobs.tasksEmpty')}</p>;
  }
  return (
    <ol className="fw-jobs__wps">
      {detail.workPackages.map((wp) => (
        <li key={wp.key} className="fw-jobs__wp" data-state={wp.state}>
          <Icon name={WP_ICON[wp.state]} size="sm" />
          <span className="fw-jobs__wp-main">
            <span className="fw-jobs__wp-title">
              {wp.title ?? t('jobs.taskUntitled')}
              {wp.code ? (
                <span className="fw-jobs__code" data-log-name>
                  {wp.code}
                </span>
              ) : null}
            </span>
            <span className="fw-jobs__wp-meta">
              <span>{t(`jobs.taskState.${wp.state}`)}</span>
              {wp.agent ? (
                <span>
                  {t('jobs.taskBy')} <Who name={wp.agent} />
                </span>
              ) : null}
            </span>
          </span>
        </li>
      ))}
      {detail.looseTasks.map((task, index) => {
        const state = task.status === 'running' ? 'busy' : task.status === 'completed' ? 'done' : task.status === 'failed' ? 'failed' : 'open';
        return (
          <li key={`task-${task.dispatchId ?? index}`} className="fw-jobs__wp" data-state={state}>
            <Icon name={WP_ICON[state]} size="sm" />
            <span className="fw-jobs__wp-main">
              <span className="fw-jobs__wp-title" data-log-text>
                {task.summary ?? task.task ?? t('jobs.taskUntitled')}
              </span>
              <span className="fw-jobs__wp-meta">
                <span>{t(`jobs.taskState.${state}`)}</span>
                <span>
                  {t('jobs.taskBy')} <Who name={task.agent ?? task.role} />
                </span>
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CheckRow({ check }: { readonly check: JobCheck }) {
  const { t, locale } = useLocale();
  const when = relativeWhen(check.at, locale);
  return (
    <li className="fw-jobs__check" data-passed={check.passed ? 'true' : 'false'}>
      <Icon name={check.passed ? 'CircleCheck' : 'CircleX'} size="sm" />
      <span className="fw-jobs__check-main">
        <span className="fw-jobs__check-head">
          {check.kind === 'forge' ? (
            <span>{t('jobs.forgeCheck', { passed: check.forgePassed ?? '—', failed: check.forgeFailed ?? '—' })}</span>
          ) : (
            <span data-log-text>{check.name ?? check.command ?? t('jobs.checkUnnamed')}</span>
          )}
          <span className="fw-jobs__verdict">{check.passed ? t('jobs.checkPassed') : t('jobs.checkFailed')}</span>
        </span>
        <span className="fw-jobs__check-meta">
          {check.who ? (
            <span>
              <Who name={check.who} />
            </span>
          ) : null}
          {when !== '' ? <span>{when}</span> : null}
        </span>
        {check.pointer ? (
          <span className="fw-xpage__mono" data-log-text>
            {t('jobs.pointer', { pointer: check.pointer })}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function Receipt({ receipt }: { readonly receipt: JobReceipt }) {
  const { t, locale } = useLocale();
  if (!receipt.present) {
    if (receipt.invalidReason !== null) {
      return (
        <p className="fw-jobs__receipt" data-tone="warning">
          <Icon name="TriangleAlert" size="sm" />
          <span>
            {t('jobs.receipt.invalid')}{' '}
            <span data-log-text>{receipt.invalidReason}</span>
          </span>
        </p>
      );
    }
    return (
      <p className="fw-jobs__receipt" data-tone="none">
        <Icon name="CircleDashed" size="sm" />
        <span>{t('jobs.receipt.none')}</span>
      </p>
    );
  }
  const key = receipt.proofKey ?? 'checking';
  const label = {
    verified: t('jobs.receipt.verified'),
    archival: t('jobs.receipt.archival'),
    'unverified-archival': t('jobs.receipt.unverifiedArchival'),
    stale: t('jobs.receipt.stale'),
    unconfirmed: t('jobs.receipt.unconfirmed'),
    checking: t('jobs.receipt.checking'),
  }[key];
  const when = relativeWhen(receipt.finalizedAt, locale);
  return (
    <p className="fw-jobs__receipt" data-tone={key === 'verified' ? 'verified' : key === 'checking' ? 'none' : 'warning'}>
      <Icon name={key === 'verified' ? 'ShieldCheck' : key === 'archival' ? 'Archive' : key === 'checking' ? 'Loader' : 'TriangleAlert'} size="sm" />
      <span>
        {label}
        {when !== '' ? <span className="fw-jobs__receipt-when"> · {t('jobs.receipt.at', { when })}</span> : null}
      </span>
    </p>
  );
}

export function JobDetailPanel({ row, detail, onBack, focusProof = false }: JobDetailPanelProps) {
  const { t, locale } = useLocale();
  const proofRef = useRef<HTMLHeadingElement>(null);
  const proofSectionRef = useRef<HTMLElement>(null);
  const ready = detail.status === 'ready';
  const proofOnPage = ready && hasRealProof(detail.value);
  // tick Start's proof step once a real proof is in view, not when the klus merely opens.
  useEffect(() => {
    const section = proofSectionRef.current;
    if (!proofOnPage || section === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      markStartProofSeen();
      observer.disconnect();
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, [proofOnPage]);
  useEffect(() => {
    if (!focusProof || !ready) return;
    const heading = proofRef.current;
    if (heading === null) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: 'start' });
  }, [focusProof, ready]);
  const status = jobStatus(row);
  const started = relativeWhen(row.startedAt, locale);
  const last = relativeWhen(row.lastWorkAt, locale);
  const value = detail.value;

  return (
    <article className="fw-jobs__detail" aria-labelledby="fw-job-title">
      <button type="button" className="fw-xpage__crumb fw-jobs__back" onClick={onBack}>
        <Icon name="ArrowLeft" size="xs" />
        {t('jobs.back')}
      </button>
      <header className="fw-jobs__detail-head">
        <div className="fw-jobs__detail-top">
          <h2 id="fw-job-title">{row.title?.trim() ? row.title : t('jobs.untitled')}</h2>
          <span className="fw-xstatus" data-status={status.simple}>
            {t(`jobs.status.${status.simple}`)}
          </span>
        </div>
        <p className="fw-jobs__detail-line">
          <span>{t(`jobs.detail.${status.detail}`)}</span>
          {started !== '' ? <span>{t('jobs.started', { when: started })}</span> : null}
          {last !== '' ? <span>{t('jobs.lastWork', { when: last })}</span> : null}
        </p>
        <p className="fw-jobs__id">
          <span>{t('jobs.idLabel')}</span>
          <span className="fw-xpage__mono" data-log-name>
            {row.runId}
          </span>
        </p>
      </header>

      {detail.status === 'loading' ? (
        <p className="fw-xpage__note" role="status">
          <Icon name="Loader" size="sm" />
          {t('jobs.detailLoading')}
        </p>
      ) : null}
      {detail.status === 'error' ? (
        <div className="fw-xpage__state" role="alert">
          <p>{t('jobs.detailError')}</p>
          <Button variant="ghost" size="sm" icon="RotateCcw" onClick={detail.reload}>
            {t('jobs.error.retry')}
          </Button>
        </div>
      ) : null}

      {detail.status === 'ready' ? (
        <>
          <section className="fw-jobs__section" aria-labelledby="fw-job-tasks">
            <h3 id="fw-job-tasks" className="fw-xpage__section-title">
              {t('jobs.sections.tasks')}
            </h3>
            <WorkPackages detail={value} />
          </section>

          <section className="fw-jobs__section fw-jobs__proof" aria-labelledby="fw-job-proof" ref={proofSectionRef}>
            <h3 id="fw-job-proof" className="fw-xpage__section-title" ref={proofRef} tabIndex={-1}>
              <Icon name="ShieldCheck" size="xs" />
              {t('jobs.sections.proof')}
            </h3>

            <div className="fw-jobs__proof-block">
              <h4>{t('jobs.sections.receipt')}</h4>
              <Receipt receipt={value.receipt} />
            </div>

            <div className="fw-jobs__proof-block">
              <h4>{t('jobs.sections.checks')}</h4>
              {value.checks.length === 0 ? (
                <p className="fw-jobs__empty-line">{t('jobs.checksEmpty')}</p>
              ) : (
                <ul className="fw-jobs__checks">
                  {value.checks.map((check) => (
                    <CheckRow key={check.key} check={check} />
                  ))}
                </ul>
              )}
            </div>

            <div className="fw-jobs__proof-block">
              <h4>{t('jobs.sections.reviews')}</h4>
              {value.reviews.length === 0 ? (
                <p className="fw-jobs__empty-line">{t('jobs.reviewsEmpty')}</p>
              ) : (
                <ul className="fw-jobs__checks">
                  {value.reviews.map((review) => (
                    <li key={review.reviewId} className="fw-jobs__check" data-passed={review.verdict === null ? 'unknown' : /pass|approve|ok/i.test(review.verdict) ? 'true' : 'false'}>
                      <Icon name="Gavel" size="sm" />
                      <span className="fw-jobs__check-main">
                        <span className="fw-jobs__check-head">
                          <span data-log-text>{review.subject ?? t('jobs.checkUnnamed')}</span>
                          {review.verdict ? (
                            <span className="fw-jobs__verdict" data-log-name>
                              {review.verdict}
                            </span>
                          ) : (
                            <span className="fw-jobs__verdict">{t('jobs.reviewPending')}</span>
                          )}
                        </span>
                        <span className="fw-jobs__check-meta">
                          <span>
                            <Who name={review.agent} />
                          </span>
                          {review.completedAt ? <span>{relativeWhen(review.completedAt, locale)}</span> : null}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      ) : null}
    </article>
  );
}
