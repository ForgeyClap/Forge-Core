/**
 * Inspector — the artifact panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'artifact'`, unchanged (comments included verbatim). See that
 * file's own header for the full refactor rationale.
 */

import { ExampleTag, Machine } from '@/components/primitives';
import { t } from '@/i18n';
import { readChatRunArtifactDiff } from '@/prototype/state/gateway-adapter';
import type { ChatRunArtifactDiff } from '@/prototype/state/gateway-adapter';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Console, Diff, Excerpt, Fields, KIND_LABEL, LinkRow, Section, Quiet } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

/**
 * feat-chatrun-diff — the section that closes "a reviewer has to take the agent's word for it".
 *
 * A chat-run file change (`toGatewayChatRunArtifacts`) now carries the before/after text the
 * gateway had recorded all along; every other artifact carries none and renders exactly as before
 * (`readChatRunArtifactDiff` returns null and this is never called).
 *
 * All three branches are honest statements, and the two non-diff ones exist precisely so that a
 * missing diff can never be mistaken for an empty one:
 *   present        — the real recorded text, in the EXISTING `Diff` component.
 *   none           — no before/after text was ever recorded (typically a run from before the
 *                    gateway captured diffs). Said in words; NO diff element is rendered at all.
 *   omitted_budget — text exists but this response's diff budget was spent. Said in words, with
 *                    the real budget number the gateway itself reported.
 *
 * A JSX-returning helper, not a component — the same shape `buildArtifactDetail` itself uses, so
 * this file keeps exporting exactly one thing and stays a builder module.
 */
function chatRunDiffSection(diff: ChatRunArtifactDiff, fileName: string) {
  if (diff.state === 'present' && diff.text !== null) {
    return (
      <Section title={t('rd.details.section.change')} defaultOpen>
        <Diff text={diff.text} label={t('rd.details.recordedChange', { name: fileName })} />
        <p className="fw-inspector__hint">{t('rd.details.changeHint')}</p>
      </Section>
    );
  }

  if (diff.state === 'omitted_budget') {
    return (
      <Section title={t('rd.details.section.change')} defaultOpen>
        <p className="fw-inspector__none">
          {diff.budgetChars === null
            ? t('rd.details.changeOmitted')
            : t('rd.details.changeOmittedChars', { chars: diff.budgetChars })}
        </p>
      </Section>
    );
  }

  return (
    <Section title={t('rd.details.section.change')} defaultOpen>
      <p className="fw-inspector__none">{t('rd.details.changeNone')}</p>
    </Section>
  );
}

export function buildArtifactDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'artifact' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const artifact = data.artifacts.find((candidate) => candidate.id === selection.id);
  if (!artifact) return null;
  const machineFace = artifact.kind === 'log' || artifact.kind === 'receipt' || artifact.kind === 'proof';
  const chatRunDiff = readChatRunArtifactDiff(artifact);
  return {
    eyebrow: KIND_LABEL.artifact,
    title: artifact.name,
    subtitle: <Machine muted>{artifact.id}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            { label: t('rd.details.field.kind'), value: artifact.kind },
            { label: t('rd.details.field.producedBy'), value: artifact.producedBy },
            { label: t('rd.details.field.created'), value: <Quiet>{artifact.createdAt}</Quiet> },
            { label: t('rd.details.field.size'), value: <Quiet>{artifact.size}</Quiet> },
          ]}
        />
        <Section title={t('rd.details.section.preview')} defaultOpen count={<ExampleTag />}>
          {machineFace ? <Console text={artifact.preview} /> : <Excerpt text={artifact.preview} />}
          <p className="fw-inspector__hint">
            {production ? t('rd.details.previewLive') : t('rd.details.previewExample')}
          </p>
        </Section>
        {chatRunDiff !== null ? chatRunDiffSection(chatRunDiff, artifact.name) : null}
        {artifact.taskId ? (
          <Section title={t('rd.details.section.producedFor')}>
            <div className="fw-inspector__links">
              <LinkRow
                icon="ListChecks"
                id={artifact.taskId}
                onSelect={() => select({ kind: 'task', id: artifact.taskId as string })}
              />
            </div>
          </Section>
        ) : null}
      </>
    ),
  };
}
