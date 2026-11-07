/**
 * Inspector — the task panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'task'`, unchanged (comments included verbatim). See that file's
 * own header for the full refactor rationale.
 */

import { Icon, Machine, Meter, StatusBadge } from '@/components/primitives';
import { t } from '@/i18n';
import { selectAgent, selectTask } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Fields, KIND_LABEL, LinkRow, Prose, Section, VERDICT_STATUS, Quiet } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';
import { catalogWord } from './inspector-format';

export function buildTaskDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'task' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const task = selectTask(state, selection.id);
  if (!task) return null;
  const agent = selectAgent(state, task.agentId);
  const workPackage = data.workPackages.find((wp) => wp.id === task.workPackageId);
  const proof = data.proof.filter((entry) => entry.taskId === task.id);
  return {
    eyebrow: KIND_LABEL.task,
    title: task.title,
    status: task.status,
    subtitle: <Machine muted>{task.id}</Machine>,
    body: (
      <>
        {task.status === 'running' ? (
          <div className="fw-inspector__block">
            <Meter value={task.progress} label={t('rd.details.progress')} tone="accent" showValue />
          </div>
        ) : null}
        <Fields
          rows={[
            { label: t('rd.details.field.owner'), value: agent ? agent.name : <Machine>{task.agentId}</Machine> },
            { label: t('rd.details.field.package'), value: <Machine>{task.workPackageId}</Machine> },
            { label: t('rd.details.field.phase'), value: catalogWord('rd.tasks.phase', task.phase) },
            { label: t('rd.details.field.column'), value: catalogWord('rd.tasks.column', task.column) },
            { label: t('rd.details.field.created'), value: <Quiet>{task.createdAt}</Quiet> },
            { label: t('rd.details.field.updated'), value: <Quiet>{task.updatedAt}</Quiet> },
            { label: t('rd.details.field.repairs'), value: task.repairAttempts },
          ]}
        />
        <Section title={t('rd.details.section.detail')} defaultOpen>
          <Prose>{task.detail}</Prose>
        </Section>
        <Section title={t('rd.details.section.dependencies')} count={task.dependencies.length}>
          {task.dependencies.length === 0 ? (
            <p className="fw-inspector__none">{t('rd.details.noDependencies')}</p>
          ) : (
            <div className="fw-inspector__links">
              {task.dependencies.map((id) => (
                <LinkRow key={id} icon="GitCommitHorizontal" id={id} onSelect={() => select({ kind: 'task', id })} />
              ))}
            </div>
          )}
        </Section>
        <Section title={t('rd.details.section.proof')} count={task.proofCount}>
          {proof.length === 0 ? (
            <p className="fw-inspector__none">
              {production
                ? t('rd.details.noProof')
                : t('rd.details.proofNotInExample', { count: task.proofCount })}
            </p>
          ) : (
            <div className="fw-inspector__links">
              {proof.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="fw-inspector__link"
                  onClick={() => select({ kind: 'proof', id: entry.id })}
                >
                  <StatusBadge status={VERDICT_STATUS[entry.verdict]} size="sm" iconOnly />
                  <span className="fw-truncate">{entry.claim}</span>
                  <Icon name="ChevronRight" size="xs" className="fw-inspector__link-chevron" />
                </button>
              ))}
            </div>
          )}
        </Section>
        {workPackage ? (
          <Section title={t('rd.details.section.workPackage')} count={workPackage.taskIds.length}>
            <Prose>{workPackage.goal}</Prose>
            <Fields
              rows={[
                { label: t('rd.details.field.package'), value: <Machine>{workPackage.id}</Machine> },
                { label: t('rd.details.field.title'), value: workPackage.title },
                { label: t('rd.details.field.phase'), value: catalogWord('rd.tasks.phase', workPackage.phase) },
              ]}
            />
            <ul className="fw-inspector__list">
              {workPackage.acceptance.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Section>
        ) : null}
      </>
    ),
  };
}
