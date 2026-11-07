/**
 * Inspector — the "nothing selected" landing panel.
 *
 * refactor-inspector-split — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'none'`. See that file's own header for the full refactor rationale.
 *
 * W3FX-D: the head's title and subtitle are the one message ("Niets geselecteerd" plus one line).
 * The body no longer repeats it with a second empty heading ("Geen item geopend") or a closing
 * hint; it only offers a way in when there is one.
 */

import { Button } from '@/components/primitives';
import { t } from '@/i18n';
import { selectActiveProject } from '@/prototype/state/prototype-store';
import type { PrototypeState } from '@/prototype/state/prototype-store';
import { KIND_LABEL } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildNoneDetail(state: PrototypeState, select: SelectFn): Detail | null {
  const { data } = state;
  const project = selectActiveProject(state);
  const event = data.events[0];
  const agent = data.agents.find((candidate) => candidate.status === 'running');
  // Redesign 3D: with nothing to start from (a fresh install), the "Begin bij" label would hang over
  // an empty list. The block only shows when it has at least one way in.
  const hasStart = Boolean(project || agent || event);
  return {
    eyebrow: KIND_LABEL.none,
    title: t('inspector.empty.title'),
    subtitle: t('inspector.empty.subtitle'),
    body: hasStart ? (
      <div className="fw-inspector__block">
        <p className="fw-inspector__kind">
          <span className="fw-sentence">{t('inspector.empty.startFrom')}</span>
        </p>
        <div className="fw-inspector__starts">
          {project ? (
            <Button size="sm" icon="FolderGit2" block onClick={() => select({ kind: 'project', id: project.id })}>
              {project.name}
            </Button>
          ) : null}
          {agent ? (
            <Button size="sm" icon="Bot" block onClick={() => select({ kind: 'agent', id: agent.id })}>
              {agent.name}
            </Button>
          ) : null}
          {event ? (
            <Button size="sm" icon="Activity" block onClick={() => select({ kind: 'event', id: event.id })}>
              {t('inspector.empty.latestEvent')}
            </Button>
          ) : null}
        </div>
      </div>
    ) : null,
  };
}
