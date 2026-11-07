/**
 * Inspector — the event panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'event'`, unchanged (comments included verbatim). See that file's
 * own header for the full refactor rationale.
 */

import { Machine } from '@/components/primitives';
import { t } from '@/i18n';
import { getUiMode } from '@/state/ui-mode';
import { roleFromName } from '@/views/team/team-data';
import { senderName } from '@/views/team/team-ui';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Fields, KIND_LABEL, LinkRow, Prose, Section, Quiet } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildEventDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'event' }>,
  select: SelectFn,
): Detail | null {
  const { data } = state;
  const event = data.events.find((candidate) => candidate.id === selection.id);
  if (!event) return null;
  const run = data.runs.find((candidate) => candidate.id === event.runId);
  // WP B3-copy (plan §4.2): the raw event id/kind/run id are developer rows (Uitgebreid only).
  const advanced = getUiMode() === 'uitgebreid';
  const agent = event.agent ? data.agents.find((candidate) => candidate.name === event.agent) : undefined;
  return {
    eyebrow: KIND_LABEL.event,
    title: event.message,
    status: event.status,
    subtitle: <Machine muted>{advanced ? `${event.id} · ${event.timestamp}` : event.timestamp}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            ...(advanced ? [{ label: t('inspector.event.kind'), value: <Machine data-log-name="">{event.kind}</Machine> }] : []),
            {
              label: t('inspector.event.helper'),
              value: event.agent ? (
                advanced ? event.agent : senderName(t, roleFromName(event.agent), event.agent, advanced)
              ) : (
                <Quiet>{t('inspector.event.system')}</Quiet>
              ),
            },
            ...(advanced ? [{ label: t('inspector.event.job'), value: <Machine>{event.runId}</Machine> }] : []),
            { label: t('inspector.event.recorded'), value: <Quiet>{event.timestamp}</Quiet> },
          ]}
        />
        <Section title={t('inspector.event.detail')} defaultOpen>
          <Prose>{event.detail}</Prose>
        </Section>
        {run ? (
          <Section title={t('inspector.event.job')}>
            <Prose>{run.goal}</Prose>
            <Fields
              rows={[
                { label: t('inspector.event.started'), value: <Quiet>{run.startedAt}</Quiet> },
                { label: t('inspector.event.duration'), value: <Quiet>{run.duration}</Quiet> },
              ]}
            />
          </Section>
        ) : null}
        {agent ? (
          <Section title={t('inspector.event.reportedBy')}>
            <div className="fw-inspector__links">
              <LinkRow icon="Bot" id={advanced ? agent.name : senderName(t, roleFromName(agent.name), agent.name, advanced)} onSelect={() => select({ kind: 'agent', id: agent.id })} />
            </div>
          </Section>
        ) : null}
      </>
    ),
  };
}
