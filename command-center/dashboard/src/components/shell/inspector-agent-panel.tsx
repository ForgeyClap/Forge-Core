/**
 * Inspector — the agent panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'agent'`, unchanged (comments included verbatim). See that file's
 * own header for the full refactor rationale.
 */

import { Icon, Machine, Meter } from '@/components/primitives';
import { t } from '@/i18n';
import { selectAgent } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Chips, Fields, KIND_LABEL, Prose, Section, Quiet } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';
import { catalogWord } from './inspector-format';

export function buildAgentDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'agent' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const agent = selectAgent(state, selection.id);
  if (!agent) return null;
  const tasks = data.tasks.filter((task) => task.agentId === agent.id);
  return {
    eyebrow: KIND_LABEL.agent,
    title: agent.name,
    status: agent.status,
    subtitle: <Machine muted>{agent.id}</Machine>,
    body: (
      <>
        <Prose>{agent.role}</Prose>
        {agent.status === 'running' ? (
          <div className="fw-inspector__block">
            <Meter value={agent.progress} label={t('rd.details.progress')} tone="accent" showValue />
          </div>
        ) : null}
        <Fields
          rows={[
            { label: t('rd.details.field.group'), value: catalogWord('rd.agents.group', agent.group) },
            { label: t('rd.details.field.permission'), value: catalogWord('rd.agents.permission', agent.permission) },
            { label: t('rd.details.field.effort'), value: catalogWord('rd.agents.effort', agent.effort) },
            { label: t('rd.details.field.runtime'), value: <Machine>{agent.runtimeModel}</Machine> },
            { label: t('rd.details.field.toolModel'), value: <Machine>{agent.toolModel}</Machine> },
            // fix-cert-rest (item 2): verification is now `null` (an honest absence of
            // evidence) rather than a fabricated 'not-required' — '—' when so.
            { label: t('rd.details.field.verification'), value: catalogWord('rd.agents.verification', agent.verification) },
            { label: t('rd.details.field.lastActivity'), value: <Quiet>{agent.lastActivity}</Quiet> },
          ]}
        />
        <Section title={t('rd.details.section.currentTask')} defaultOpen>
          {agent.currentTask ? (
            <Prose>{agent.currentTask}</Prose>
          ) : (
            <p className="fw-inspector__none">
              {production ? t('rd.details.noTask') : t('rd.details.noTaskExample')}
            </p>
          )}
        </Section>
        <Section title={t('rd.details.section.summary')}>
          <Prose>{agent.summary}</Prose>
        </Section>
        <Section title={t('rd.details.section.skills')} count={agent.skills.length}>
          <Chips items={agent.skills} label={t('rd.details.agentSkills')} />
        </Section>
        {tasks.length > 0 ? (
          <Section title={t('rd.details.section.tasks')} count={tasks.length}>
            <div className="fw-inspector__links">
              {tasks.slice(0, 8).map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="fw-inspector__link"
                  onClick={() => select({ kind: 'task', id: task.id })}
                >
                  <Machine muted className="fw-inspector__link-id">
                    {task.id}
                  </Machine>
                  <span className="fw-truncate">{task.title}</span>
                  <Icon name="ChevronRight" size="xs" className="fw-inspector__link-chevron" />
                </button>
              ))}
            </div>
          </Section>
        ) : null}
      </>
    ),
  };
}
