/**
 * Inspector — the right-hand detail panel.
 *
 * It describes exactly one thing: `state.selection`. Every selection kind gets
 * its own body, built from the example dataset through the store selectors.
 *
 * Three rules run through this file:
 *   1. Progressive disclosure. A header, then the identifying fields, then
 *      collapsible sections for the long material (output, proof, diffs).
 *      Nothing is dumped flat.
 *   2. Provenance. Ids, paths, models, timestamps, commands and console output
 *      wear <Machine>; prose written by a person stays in the sans face.
 *   3. Honesty. Outside production every record here is example data. A tag in the
 *      head says so, and simulated evidence carries an <ExampleTag/> next to it.
 *
 * Nothing in this panel reads a file, runs a command or contacts anything.
 *
 * refactor-inspector-split UPDATE — this file was 1077 lines, over
 * the project's own 500-line-per-file guidance, mixing the shared presentational atoms
 * (`Fields`/`Section`/`Chips`/`Prose`/`Excerpt`/`Console`/`LinkRow`/`Diff`), eleven per-selection-
 * kind detail builders, and the actual `<Inspector/>` component (drag-to-dismiss, header, body,
 * footer) together. Pure structural split, ZERO behavior change: the shared atoms/types now live
 * in `./inspector-shared.tsx`, and each `Selection['kind']` gets its own builder in its own
 * sibling file — `inspector-empty-panel.tsx` (`none`), `inspector-project-panel.tsx`,
 * `inspector-conversation-panel.tsx`, `inspector-agent-panel.tsx`, `inspector-task-panel.tsx`,
 * `inspector-graph-panel.tsx` (`graph-node`), `inspector-artifact-panel.tsx`,
 * `inspector-quality-panel.tsx` (`gate` + `proof` together — the same pairing `TestsView.tsx`'s
 * own header already uses: "the quality-gate board and the proof ledger"), `inspector-file-panel.tsx`,
 * `inspector-event-panel.tsx`. Every builder keeps its exact original body, comments included
 * verbatim; the only change a module split forces is mechanical: what used to be a closure read
 * (`state`, the switch-narrowed `selection`, `select`, `production`) is now an explicit parameter,
 * and only where each builder actually reads it (see each sibling's own header for a per-file
 * note; not every builder needs `select` or `production`). `buildDetail` below is now a thin
 * dispatch switch over those eleven builders; this file itself keeps being the composer — the
 * `<Inspector/>` component and its header/body render stay here (the drag-to-dismiss sheet
 * chrome was removed in W3FX-D, see below).
 *
 * Redesign (part 3D, review F2): the shell mounts it as `<Inspector embedded />`, the
 * "Selectie" tab of the Uitgebreid Details pane (SidePane.tsx). The pane is the frame and the only
 * landmark, so the embedded panel is a plain <div> under the pane's h2. The pane's own close
 * (SidePane `close()`, focus back to #fw-main) is the one way out. Labels are sentence case, mono
 * stays on paths and ids, and the example-data note is a tag in the head (shown only outside
 * production).
 *
 * W3FX-D: `embedded` defaults to false, like Dock. A mount without it (tests, a future host) gets
 * the same panel as its own <aside> landmark with an h2. The old sheet chrome (drag handle, close
 * button, footer) had no caller left and is gone. Every name this file exported before
 * (`Inspector`, the default export) is unchanged.
 */

import { useCallback } from 'react';
import { Button, EmptyState, ExampleTag, StatusBadge } from '@/components/primitives';
import type { ReactNode } from 'react';
import { isProductionMode } from '@/config/mode';
import { useLocale } from '@/i18n/use-locale';
import { useUiMode } from '@/state/ui-mode';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { KIND_LABEL } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';
import { buildNoneDetail } from './inspector-empty-panel';
import { buildProjectDetail } from './inspector-project-panel';
import { buildConversationDetail } from './inspector-conversation-panel';
import { buildAgentDetail } from './inspector-agent-panel';
import { buildTaskDetail } from './inspector-task-panel';
import { buildGraphNodeDetail } from './inspector-graph-panel';
import { buildArtifactDetail } from './inspector-artifact-panel';
import { buildGateDetail, buildProofDetail } from './inspector-quality-panel';
import { buildFileDetail } from './inspector-file-panel';
import { buildEventDetail } from './inspector-event-panel';
import './inspector.css';

/**
 * Builds the panel body for the current selection.
 * Returns null when the selection points at an id the example dataset does not
 * contain — which the caller renders as a plain "not in this dataset" state.
 */
function buildDetail(state: PrototypeState, select: SelectFn): Detail | null {
  const { selection } = state;
  // In production every record here is real (folded from the bridge); in fixtures
  // it is example data. The copy that names its provenance follows this flag.
  const production = isProductionMode();

  switch (selection.kind) {
    case 'none':
      return buildNoneDetail(state, select);
    case 'project':
      return buildProjectDetail(state, selection, select);
    case 'conversation':
      return buildConversationDetail(state, selection, production);
    case 'agent':
      return buildAgentDetail(state, selection, select, production);
    case 'task':
      return buildTaskDetail(state, selection, select, production);
    case 'graph-node':
      return buildGraphNodeDetail(state, selection, select);
    case 'artifact':
      return buildArtifactDetail(state, selection, select, production);
    case 'gate':
      return buildGateDetail(state, selection);
    case 'proof':
      return buildProofDetail(state, selection, select, production);
    case 'file':
      return buildFileDetail(state, selection, select, production);
    case 'event':
      return buildEventDetail(state, selection, select);
    default:
      return null;
  }
}

/* -------------------------------------------------------------- component */

export interface InspectorProps {
  /**
   * Inside the Uitgebreid Details pane (how the shell mounts it). A plain <div> under the pane's h2.
   * Without it (the default, like Dock) the panel is its own <aside> landmark with an h2.
   */
  readonly embedded?: boolean;
}

export function Inspector({ embedded = false }: InspectorProps) {
  const { state, dispatch } = usePrototype();
  // WP B3-copy: subscribing here re-renders the builders (which read `t()` and `getUiMode()`)
  // when the locale or Eenvoudig/Uitgebreid changes.
  const { t } = useLocale();
  useUiMode();

  const select = useCallback(
    (selection: Selection) => dispatch({ type: 'select', selection }),
    [dispatch],
  );

  if (!state.inspectorOpen) return null;

  const detail = buildDetail(state, select);
  const production = isProductionMode();
  const kind = state.selection.kind;
  /*
   * Keying the body on the selection remounts the collapsible sections, so a
   * section left open on one record does not decide how the next one opens.
   */
  const selectionKey = state.selection.kind === 'none' ? 'none' : `${kind}:${state.selection.id}`;

  /* XR-COPY2: the badge speaks the shared status words (StatusBadge follows the locale), the same word
   * the card on the board shows. The old Dutch override used `inspector.status.*`, where `waiting` reads
   * "WACHT OP JOU": a queued task then claimed the owner had to act. */
  const status = detail?.status ? <StatusBadge status={detail.status} size="sm" /> : null;

  const body: ReactNode = detail ? (
    detail.body
  ) : (
    <EmptyState
      icon="SearchX"
      title={t('inspector.notInDataTitle')}
      detail={production ? t('inspector.notInLive') : t('inspector.notInExample')}
      compact
      action={
        <Button size="sm" icon="X" onClick={() => select({ kind: 'none' })}>
          {t('inspector.clearSelection')}
        </Button>
      }
    />
  );

  const Root = embedded ? 'div' : 'aside';
  const Title = embedded ? 'h3' : 'h2';

  return (
    <Root
      className="fw-inspector"
      data-embedded={embedded ? 'true' : undefined}
      data-kind={kind}
      aria-label={embedded ? undefined : t('inspector.region')}
    >
      <header className="fw-inspector__head">
        <div className="fw-inspector__heading">
          {/* The kind and the status share one quiet line, so the title gets the full width.
              "Details" is already the pane title, so the empty selection shows no kind label. */}
          {kind !== 'none' || status || !production ? (
            <div className="fw-inspector__kind-row">
              {kind !== 'none' ? (
                <p className="fw-inspector__kind">
                  <span className="fw-sentence">{KIND_LABEL[kind]}</span>
                </p>
              ) : null}
              <span className="fw-inspector__head-actions">
                {status}
                <ExampleTag detail={t('inspector.exampleNote')} />
              </span>
            </div>
          ) : null}
          <Title className="fw-inspector__title" title={detail?.titleTooltip}>
            {detail ? detail.title : t('inspector.notFoundTitle')}
          </Title>
          {detail?.subtitle ? <div className="fw-inspector__subtitle">{detail.subtitle}</div> : null}
        </div>
      </header>
      <div className="fw-inspector__body" key={selectionKey}>
        {body}
      </div>
    </Root>
  );
}

export default Inspector;
