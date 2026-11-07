/**
 * Inspector — the file panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'file'`, unchanged (comments included verbatim). See that file's
 * own header for the full refactor rationale.
 */

import { ExampleTag, Icon, Machine } from '@/components/primitives';
import { t } from '@/i18n';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { CHANGE_LABEL, Diff, Fields, KIND_LABEL, Section, findFile, Quiet } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildFileDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'file' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const file = findFile(data.files, selection.id);
  if (!file) return null;
  const children = file.children ?? [];
  return {
    eyebrow: KIND_LABEL.file,
    title: file.name,
    subtitle: <Machine muted>{file.path}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            { label: t('rd.details.field.kind'), value: file.kind === 'dir' ? t('rd.details.kindDir') : t('rd.details.kindFile') },
            {
              label: t('rd.details.field.change'),
              value: file.changed ? (
                <span className="fw-inspector__change" data-change={file.changed}>
                  <span className="fw-sentence">{CHANGE_LABEL[file.changed]}</span>
                </span>
              ) : production ? (
                // The real gateway has no git-diff concept (see
                // gateway-files.ts's header) — "unchanged" would claim a
                // check that never ran. Honest absence instead.
                <Quiet>{t('rd.details.notTracked')}</Quiet>
              ) : (
                <Quiet>{t('rd.details.unchanged')}</Quiet>
              ),
            },
            { label: t('rd.details.field.size'), value: <Quiet>{file.size ?? '—'}</Quiet> },
            { label: t('rd.details.field.updated'), value: <Quiet>{file.updatedAt ?? '—'}</Quiet> },
          ]}
        />
        {file.diff ? (
          <Section title={t('rd.details.section.exampleChange')} defaultOpen count={<ExampleTag />}>
            <Diff text={file.diff} />
            <p className="fw-inspector__hint">{t('rd.details.exampleDiffHint')}</p>
          </Section>
        ) : null}
        {children.length > 0 ? (
          <Section title={t('rd.details.section.contents')} count={children.length}>
            <div className="fw-inspector__links">
              {children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className="fw-inspector__link"
                  onClick={() => select({ kind: 'file', id: child.id })}
                >
                  <Icon
                    name={child.kind === 'dir' ? 'Folder' : 'File'}
                    size="xs"
                    className="fw-inspector__link-icon"
                  />
                  <Machine className="fw-truncate">{child.name}</Machine>
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
