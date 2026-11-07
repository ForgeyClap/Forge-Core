/**
 * Inspector — the quality-gate + proof-ledger panels.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'gate'` and `case 'proof'`, unchanged (comments included
 * verbatim). Paired in one file because `TestsView.tsx`'s own header already treats them as one
 * surface ("Tests & proof — the quality-gate board and the proof ledger"); this file mirrors
 * that existing real grouping rather than inventing a new one. See `Inspector.tsx`'s own header
 * for the full refactor rationale.
 */

import { ExampleTag, Machine } from '@/components/primitives';
import { t } from '@/i18n';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Console, Fields, KIND_LABEL, LinkRow, Prose, Section, VERDICT_STATUS, Quiet } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildGateDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'gate' }>,
): Detail | null {
  const { data } = state;
  const gate = data.gates.find((candidate) => candidate.id === selection.id);
  if (!gate) return null;
  return {
    eyebrow: KIND_LABEL.gate,
    title: gate.name,
    status: gate.status,
    subtitle: <Machine muted>{gate.id}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            { label: t('rd.details.field.duration'), value: <Quiet>{gate.duration}</Quiet> },
            { label: t('rd.details.field.lastRun'), value: <Quiet>{gate.lastRun}</Quiet> },
            { label: t('rd.details.field.evidence'), value: gate.evidenceCount },
          ]}
        />
        <Section title={t('rd.details.section.output')} defaultOpen count={<ExampleTag />}>
          <Console text={gate.output} />
        </Section>
      </>
    ),
  };
}

export function buildProofDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'proof' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const entry = data.proof.find((candidate) => candidate.id === selection.id);
  if (!entry) return null;
  const artifact = entry.artifact
    ? data.artifacts.find((candidate) => candidate.name === entry.artifact)
    : undefined;
  return {
    eyebrow: KIND_LABEL.proof,
    title: entry.claim,
    status: VERDICT_STATUS[entry.verdict],
    subtitle: (
      <Machine muted>
        {entry.id} · {t(`rd.tests.verdict.${entry.verdict}`)}
      </Machine>
    ),
    body: (
      <>
        <Fields
          rows={[
            { label: t('rd.details.field.agent'), value: entry.agent },
            { label: t('rd.details.field.task'), value: <Machine>{entry.taskId}</Machine> },
            { label: t('rd.details.field.recorded'), value: <Quiet>{entry.timestamp}</Quiet> },
            { label: t('rd.details.field.artifact'), value: <Machine>{entry.artifact ?? t('rd.details.none')}</Machine> },
          ]}
        />
        <Section title={t('rd.details.section.reason')} defaultOpen>
          <Prose>{entry.reason}</Prose>
        </Section>
        <Section title={t('rd.details.section.command')} count={<ExampleTag />}>
          <Console text={`$ ${entry.command}`} />
          <p className="fw-inspector__hint">
            {production ? t('rd.details.commandLive') : t('rd.details.commandExample')}
          </p>
        </Section>
        <Section title={t('rd.details.section.linked')}>
          <div className="fw-inspector__links">
            <LinkRow
              icon="ListChecks"
              id={entry.taskId}
              onSelect={() => select({ kind: 'task', id: entry.taskId })}
            />
            {artifact ? (
              <LinkRow
                icon="Paperclip"
                id={artifact.name}
                onSelect={() => select({ kind: 'artifact', id: artifact.id })}
              />
            ) : null}
          </div>
        </Section>
      </>
    ),
  };
}
