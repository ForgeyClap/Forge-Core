/**
 * Inspector — the project panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'project'`, unchanged (comments included verbatim). See that
 * file's own header for the full refactor rationale.
 */

import type { ReactNode } from 'react';
import { Icon, Machine, Meter } from '@/components/primitives';
import { t } from '@/i18n';
import { getUiMode } from '@/state/ui-mode';
import { hasMeasuredProjectDetail } from '@/prototype/state/gateway-adapter';
import { selectProject } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Chips, Fields, KIND_LABEL, MarkdownProse, Prose, Section, Quiet } from './inspector-shared';
import type { Detail, FieldRow, SelectFn } from './inspector-shared';

/**
 * B8-3 (review: the MAP value broke inside a folder name, "...\Documents\6" / "8 agents works!"):
 * a break opportunity after every path separator, so a long path wraps between folders first. The
 * full path stays in the title; `overflow-wrap: anywhere` on the field remains the last resort for a
 * single folder name wider than the panel.
 */
function pathValue(path: string): ReactNode {
  const parts = path.split(/(?<=[\\/])/);
  return (
    <Machine title={path}>
      {parts.map((part, index) => (
        // The index is a stable key: a path's segments never reorder.
        <span key={index}>
          {part}
          {index < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </Machine>
  );
}

export function buildProjectDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'project' }>,
  select: SelectFn,
): Detail | null {
  const { data } = state;
  const project = selectProject(state, selection.id);
  if (!project) return null;
  const run = data.runs.find((candidate) => candidate.projectId === project.id);
  const conversations = data.conversations.filter((c) => c.projectId === project.id);
  const { tests } = project.health;
  // fix-cert-rest follow-up (Lead): the same gate ProjectsView uses. `taskCount` and
  // `health.score` are typed `number | null` and already render '—' on their own, but the
  // remaining counters below are plain `number`s that the adapter fills with a placeholder 0
  // for every project this workspace is not currently focused on. Rendered bare, "0 missions ·
  // 0 agents · 0 passed · 0 failed" reads as a measured, empty project — a worse lie than a
  // blank, because it looks like a finding. Everything that is not measured says so.
  const measured = hasMeasuredProjectDetail(project, state.activeProjectId);
  // fix-ui-clutter (item 6): `measured` alone only answers "is this the active project (or
  // a fixture)" — it says nothing about whether a doctor verdict actually exists for it.
  // Without this second gate, a freshly created active project with no doctor run yet
  // rendered "0 passed · 0 failed · 0 skipped" as though that were a real, empty
  // measurement (the exact F3-class bug this item closes). `undefined` (fixtures/bridge
  // records) means "trust it" — only an explicit `false` counts as unmeasured.
  const testsMeasured = measured && project.health.testsMeasured !== false;
  const notMeasured = t('inspector.project.notMeasured');
  const orDash = (value: number): string | number => (measured ? value : notMeasured);
  // WP B3-copy (plan §4.2): Eenvoudig hides the developer-only rows — an unknown project type, the
  // template version, the raw id under the title, the raw counts and the run id. Uitgebreid keeps all.
  const advanced = getUiMode() === 'uitgebreid';
  const typeKnown = project.type !== 'unknown';
  const fieldRows: FieldRow[] = [
    ...(advanced || typeKnown ? [{ label: t('inspector.project.type'), value: <Machine>{project.type}</Machine> }] : []),
    { label: t('inspector.project.path'), value: pathValue(project.path) },
    ...(advanced
      ? [
          {
            label: t('inspector.project.template'),
            // fix: no Forge version known yet renders a word, never a blank value.
            value: project.templateVersion !== '' ? <Machine>{project.templateVersion}</Machine> : <Quiet>{t('inspector.project.notSet')}</Quiet>,
          },
        ]
      : []),
    { label: t('inspector.project.lastActivity'), value: <Quiet>{project.lastActivity !== '' ? project.lastActivity : t('relativeTime.unknown')}</Quiet> },
    {
      label: t('inspector.project.pinned'),
      value: project.pinned ? t('inspector.project.yes') : t('inspector.project.no'),
    },
  ];
  return {
    eyebrow: KIND_LABEL.project,
    title: project.name,
    status: project.status,
    subtitle: advanced ? <Machine muted>{project.id}</Machine> : undefined,
    body: (
      <>
        <MarkdownProse text={project.description} idPrefix={`insp-project-${project.id}`} />
        <Fields rows={fieldRows} />
        {/* fix-cert-rest (item 3): health.score is now `number | null` (prototype-types.ts) —
            a genuine absence (this project has never been measured) renders '—', never a
            fabricated "null%"/a `Meter` fed a non-numeric value. */}
        <Section title={t('inspector.project.health')} defaultOpen count={project.health.score !== null ? `${project.health.score}%` : undefined}>
          {/* Neutral on purpose: the ember is rationed to running progress,
              and a health score is a measurement, not a run. */}
          {project.health.score !== null ? (
            <Meter value={project.health.score} label={t('inspector.project.score')} showValue />
          ) : (
            <Quiet>{notMeasured}</Quiet>
          )}
          <Fields
            rows={[
              {
                label: t('inspector.project.tests'),
                value: (
                  <>
                    {testsMeasured
                      ? t('inspector.project.testsValue', { passed: tests.passed, failed: tests.failed, skipped: tests.skipped })
                      : t('inspector.project.noTestsYet')}
                  </>
                ),
              },
              {
                // WP-CCD (item 8): `openTickets` is real for EVERY project row now (not gated by
                // `measured`/active-project — see `ProjectHealth.openTickets`'s own doc comment),
                // so it is read directly rather than through the active-project-only `orDash` gate.
                label: t('inspector.project.openItems'),
                value: project.health.openTickets ?? t('inspector.project.noOpenItemsKnown'),
              },
              { label: t('inspector.project.blockers'), value: orDash(project.health.blockers) },
            ]}
          />
        </Section>
        {/* fix-cert-rest (item 3): taskCount is now `number | null` — '—' when unmeasured. */}
        {advanced ? (
          <Section title={t('inspector.project.counts')} count={project.taskCount ?? undefined}>
            <Fields
              rows={[
                { label: t('inspector.project.conversations'), value: project.conversationCount },
                { label: t('inspector.project.jobs'), value: orDash(project.missionCount) },
                { label: t('inspector.project.tasks'), value: project.taskCount ?? notMeasured },
                { label: t('inspector.project.helpers'), value: orDash(project.agentCount) },
              ]}
            />
          </Section>
        ) : null}
        <Section title={t('inspector.project.skills')} count={project.skills.length}>
          <Chips items={project.skills} label={t('inspector.project.skillsLabel')} />
        </Section>
        {run ? (
          <Section title={t('inspector.project.latestJob')} count={advanced ? run.workPackageIds.length : undefined}>
            <Prose>{run.goal}</Prose>
            <Fields
              rows={[
                ...(advanced ? [{ label: t('inspector.project.job'), value: <Machine>{run.id}</Machine> }] : []),
                {
                  label: t('inspector.project.started'),
                  value: <Quiet>{run.startedAt !== '' ? run.startedAt : t('relativeTime.unknown')}</Quiet>,
                },
                {
                  label: t('inspector.project.duration'),
                  value: <Quiet>{run.duration !== '' ? run.duration : t('relativeTime.unknown')}</Quiet>,
                },
                { label: t('inspector.project.helpers'), value: run.agentIds.length },
              ]}
            />
          </Section>
        ) : null}
        {conversations.length > 0 ? (
          <Section title={t('inspector.project.conversations')} count={conversations.length}>
            <div className="fw-inspector__links">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  className="fw-inspector__link"
                  onClick={() => select({ kind: 'conversation', id: conversation.id })}
                >
                  <Icon name="MessageSquare" size="xs" className="fw-inspector__link-icon" />
                  <span className="fw-truncate">{conversation.title}</span>
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
