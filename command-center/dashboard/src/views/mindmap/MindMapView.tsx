/**
 * MindMapView — the active project's mind maps.
 *
 * The Command Center replacement for the old Control Center "MIND MAP" lens,
 * commit 1b6bb9d). Data: the gateway's read-only `GET /api/mindmaps` (`gateway/src/mindmaps.mjs`),
 * which reads `<project>/.claude/forge-mindmaps/*.json` as written by `forge-mindmap.cjs`.
 *
 * Every state is explicit and honest: no project picked, loading, the gateway could not be reached,
 * no map generated yet (they are created for L3/L4 runs), the folder refused, and one map's own
 * loading/error state. Nothing is drawn that the map file did not contain.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, EmptyState, Eyebrow, IconButton, Machine } from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useMindMap, useMindMapList } from '@/prototype/state/adapter/mindmaps';
import type { MindMapSummary } from '@/prototype/state/adapter/mindmaps';

import { MindMapCanvas } from './MindMapCanvas';
import { groupForBranch, layoutMindMap, pathToRoot } from './mindmap-layout';
import type { MindMapLayout } from './mindmap-layout';

import './mindmap.css';

export const EMPTY_TITLE = 'No mind map generated yet';
export const EMPTY_DETAIL =
  'It is created for L3/L4 runs. When a run writes one to .claude/forge-mindmaps/, it shows up here.';

function formatWhen(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/* ------------------------------------------------------------------ map list */

function MapList({ maps, selectedId, onSelect }: { maps: readonly MindMapSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <nav className="fw-mm-list" aria-label="Mind maps">
      <Eyebrow className="fw-mm-list__label">Maps · {maps.length}</Eyebrow>
      <ul className="fw-mm-list__items">
        {maps.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="fw-mm-list__item"
              aria-current={m.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(m.id)}
            >
              <span className="fw-mm-list__title fw-truncate">{m.title}</span>
              <span className="fw-mm-list__meta">
                <Machine muted>{m.nodeCount} nodes</Machine>
                {formatWhen(m.generatedAt) ? <span>{formatWhen(m.generatedAt)}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* --------------------------------------------------------------- node detail */

function NodeDetail({ layout, selectedId, onSelect, onClose }: { layout: MindMapLayout; selectedId: string | null; onSelect: (id: string) => void; onClose: () => void }) {
  const node = selectedId ? layout.nodes.find((n) => n.id === selectedId) : undefined;
  if (!node) return null;
  const path = pathToRoot(layout, node.id);
  const kids = node.childIds.map((id) => layout.nodes.find((n) => n.id === id)).filter((n): n is NonNullable<typeof n> => !!n);
  return (
    <section className="fw-mm-detail" aria-label="Selected node" data-group={groupForBranch(node.branch)}>
      <div className="fw-mm-detail__top">
        <Eyebrow>Selected node · {node.kind}</Eyebrow>
        <IconButton icon="X" label="Close the node details" size="sm" onClick={onClose} />
      </div>
      <h3 className="fw-mm-detail__title">{node.label}</h3>
      {node.orphan ? <p className="fw-mm-detail__hint">Not connected to the root in this map file.</p> : null}
      {path.length > 1 ? (
        <ol className="fw-mm-detail__path" aria-label="Path from the root">
          {path.slice(0, -1).map((p) => (
            <li key={p.id}>
              <button type="button" className="fw-mm-chip" data-group={groupForBranch(p.branch)} onClick={() => onSelect(p.id)}>
                {p.label}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <Eyebrow>{kids.length ? `Children · ${kids.length}` : 'No children'}</Eyebrow>
      {kids.length ? (
        <ul className="fw-mm-detail__kids">
          {kids.map((k) => (
            <li key={k.id}>
              <button type="button" className="fw-mm-chip" data-group={groupForBranch(k.branch)} onClick={() => onSelect(k.id)}>
                {k.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ workspace */

/** Mirrors the narrow breakpoint in mindmap.css, where the stage is taller than it is wide. */
const PORTRAIT_QUERY = '(max-width: 700px)';

function subscribePortrait(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(PORTRAIT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function readPortrait(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PORTRAIT_QUERY).matches;
}

/**
 * on a phone the stage is portrait, so the rings are laid out as an UPRIGHT ellipse
 * (stretchX < 1) and a tighter ring gap — the fitted first view is then readable instead of a
 * landscape map shrunk into a narrow column.
 */
function useNarrowStage(): boolean {
  return useSyncExternalStore(subscribePortrait, readPortrait, () => false);
}

export function MindMapWorkspace({ projectName }: { projectName: string }) {
  const list = useMindMapList(projectName);
  const [pickedMap, setPickedMap] = useState<string | null>(null);
  const maps = list.value.maps;
  const mapId = pickedMap !== null && maps.some((m) => m.id === pickedMap) ? pickedMap : (maps[0]?.id ?? null);
  const map = useMindMap(projectName, mapId);
  const [selected, setSelected] = useState<{ map: string | null; node: string | null }>({ map: null, node: null });
  const selectedNode = selected.map === mapId ? selected.node : null;

  const narrow = useNarrowStage();
  const layout = useMemo(
    () => (map.value ? layoutMindMap(map.value.nodes, map.value.edges, narrow ? { stretchX: 0.62, ringGap: 120, leafArc: 52 } : {}) : null),
    [map.value, narrow],
  );
  const current = maps.find((m) => m.id === mapId) ?? null;

  let body: React.ReactNode;
  if (list.status === 'loading') {
    body = <EmptyState icon="Loader" title="Loading mind maps…" />;
  } else if (list.status === 'error') {
    body = (
      <EmptyState
        icon="CircleAlert"
        title="Could not load the mind maps"
        detail={`The Command Center gateway answered: ${list.error ?? 'no reason given'}. Check that it is running, then try again.`}
        action={<Button size="sm" icon="RefreshCw" onClick={list.reload}>Try again</Button>}
      />
    );
  } else if (list.value.provenance === 'REFUSED') {
    body = <EmptyState icon="Lock" title="This project's mind-map folder is not read" detail={list.value.note ?? 'The folder is a link or not a folder.'} />;
  } else if (maps.length === 0) {
    body = <EmptyState icon="Map" title={EMPTY_TITLE} detail={EMPTY_DETAIL} />;
  } else {
    let stage: React.ReactNode;
    if (map.status === 'loading') stage = <EmptyState icon="Loader" title="Loading the map…" compact />;
    else if (map.status === 'error' || !layout) {
      stage = (
        <EmptyState
          icon="CircleAlert"
          title="This map could not be opened"
          detail={map.error ?? 'The file has no usable nodes.'}
          action={<Button size="sm" icon="RefreshCw" onClick={map.reload}>Try again</Button>}
          compact
        />
      );
    } else if (layout.nodes.length === 0) stage = <EmptyState icon="Map" title="This map has no nodes" compact />;
    else stage = (
      <MindMapCanvas
        layout={layout}
        selectedId={selectedNode}
        onSelect={(id) => setSelected({ map: mapId, node: id })}
        label={`Mind map: ${map.value?.title ?? ''}`}
      />
    );
    body = (
      <div className="fw-mm__body">
        <div className="fw-mm__bar">
          <MapList maps={maps} selectedId={mapId} onSelect={(id) => setPickedMap(id)} />
          {layout && layout.nodes.length && map.status === 'ready' ? (
            <p className="fw-mm__stats">
              <Machine>{layout.nodes.length}</Machine> nodes · <Machine>{layout.branchCount}</Machine> branches · <Machine>{layout.rings.length}</Machine> levels
            </p>
          ) : null}
        </div>
        {list.value.unreadable > 0 ? (
          <p className="fw-mm__note">{list.value.unreadable} map file(s) could not be read and are not listed.</p>
        ) : null}
        <div className="fw-mm__work">
          <div className="fw-mm__stage">{stage}</div>
          {layout && layout.nodes.length && map.status === 'ready' ? (
            <NodeDetail
              layout={layout}
              selectedId={selectedNode}
              onSelect={(id) => setSelected({ map: mapId, node: id })}
              onClose={() => setSelected({ map: mapId, node: null })}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="fw-mm">
      <header className="fw-mm__head">
        <div className="fw-mm__heading">
          <Eyebrow>{projectName}</Eyebrow>
          <h1 className="fw-mm__title">{current ? current.title : 'Mind map'}</h1>
          <p className="fw-mm__subtitle">
            The plan of a run as a map: the mission in the middle, each branch a direction it took. Read-only.
            {current && formatWhen(current.generatedAt) ? ` Generated ${formatWhen(current.generatedAt)}.` : ''}
          </p>
        </div>
      </header>
      {body}
    </div>
  );
}

/* ----------------------------------------------------------------------- route */

export default function MindMapView() {
  const { state } = usePrototype();
  const navigate = useNavigate();
  const projectName = state.activeProjectId;
  if (!projectName) {
    return (
      <div className="fw-mm">
        <EmptyState
          icon="FolderSearch"
          title="No project is active."
          detail="Pick a project first; its mind maps open here."
          action={<Button variant="primary" size="sm" icon="ArrowRight" onClick={() => navigate('/projects')}>Open the project browser</Button>}
        />
      </div>
    );
  }
  return <MindMapWorkspace key={projectName} projectName={projectName} />;
}
