/**
 * Inspector — the mission graph node panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'graph-node'`, unchanged (comments included verbatim). See that
 * file's own header for the full refactor rationale.
 */

import { Machine } from '@/components/primitives';
import { t } from '@/i18n';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Chips, Fields, KIND_LABEL, LinkRow, Prose, Section, Quiet } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildGraphNodeDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'graph-node' }>,
  select: SelectFn,
): Detail | null {
  const { data } = state;
  const node = data.graph.nodes.find((candidate) => candidate.id === selection.id);
  if (!node) return null;
  const lane = data.graph.lanes.find((candidate) => candidate.id === node.laneId);
  const edgesIn = data.graph.edges.filter((edge) => edge.to === node.id);
  const edgesOut = data.graph.edges.filter((edge) => edge.from === node.id);
  return {
    eyebrow: KIND_LABEL['graph-node'],
    title: node.label,
    status: node.status,
    subtitle: <Machine muted>{node.id}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            { label: t('rd.details.field.kind'), value: node.kind },
            { label: t('rd.details.field.lane'), value: lane ? lane.label : <Quiet>{t('rd.details.spine')}</Quiet> },
            { label: t('rd.details.field.agent'), value: node.agent ?? <Quiet>—</Quiet> },
            { label: t('rd.details.field.duration'), value: <Quiet>{node.duration ?? '—'}</Quiet> },
            { label: t('rd.details.field.model'), value: <Machine>{node.model ?? '—'}</Machine> },
            {
              label: t('rd.details.field.position'),
              value: <Quiet>{t('rd.details.position', { col: node.col, row: node.row })}</Quiet>,
            },
          ]}
        />
        {node.detail ? (
          <Section title={t('rd.details.section.whatHappened')} defaultOpen>
            <Prose>{node.detail}</Prose>
          </Section>
        ) : null}
        {node.skills && node.skills.length > 0 ? (
          <Section title={t('rd.details.section.skills')} count={node.skills.length}>
            <Chips items={node.skills} label={t('rd.details.nodeSkills')} />
          </Section>
        ) : null}
        <Section title={t('rd.details.section.edges')} count={edgesIn.length + edgesOut.length}>
          <div className="fw-inspector__links">
            {edgesIn.map((edge) => (
              <LinkRow
                key={edge.id}
                icon="ArrowRightToLine"
                id={edge.from}
                onSelect={() => select({ kind: 'graph-node', id: edge.from })}
              />
            ))}
            {edgesOut.map((edge) => (
              <LinkRow
                key={edge.id}
                icon="ArrowRightFromLine"
                id={edge.to}
                onSelect={() => select({ kind: 'graph-node', id: edge.to })}
              />
            ))}
          </div>
        </Section>
      </>
    ),
  };
}
