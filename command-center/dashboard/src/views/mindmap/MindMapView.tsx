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

import { Button, EmptyState, IconButton } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import type { Locale } from '@/i18n';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useMindMap, useMindMapList } from '@/prototype/state/adapter/mindmaps';
import type { MindMapSummary } from '@/prototype/state/adapter/mindmaps';

import { MindMapCanvas } from './MindMapCanvas';
import { groupForBranch, layoutMindMap, pathToRoot } from './mindmap-layout';
import type { MindMapLayout } from './mindmap-layout';

import './mindmap.css';
import { countKey, localeTag } from '@/i18n/format';

export const EMPTY_TITLE = 'No mind map generated yet';
export const EMPTY_DETAIL =
  'It is created for L3/L4 runs. When a run writes one to .claude/forge-mindmaps/, it shows up here.';

/** A moment in the app language (Dutch first), never in the browser's default language. */
function formatWhen(iso: string | null, locale: Locale): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(localeTag(locale), { dateStyle: 'medium', timeStyle: 'short' });
}

/** The page title and lead, the same header as the other Uitgebreid routes, in every state. */
function MindMapHead({ title, lead }: { title: string; lead: string }) {
  return (
    <header className="fw-mm__head">
      <div className="fw-mm__heading">
        <h1 className="fw-mm__title">{title}</h1>
        <p className="fw-mm__subtitle">{lead}</p>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ map list */

function MapList({ maps, selectedId, onSelect }: { maps: readonly MindMapSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const { t, locale } = useLocale();
  return (
    <nav className="fw-mm-list" aria-label={t('rd.map.mapsLabel')}>
      <span className="fw-mm-list__label fw-mm-label">{t('rd.map.maps', { count: maps.length })}</span>
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
                <span className="fw-mm-quiet">{t(countKey(m.nodeCount, 'rd.map.nodesOne', 'rd.map.nodesMany'), { count: m.nodeCount })}</span>
                {formatWhen(m.generatedAt, locale) ? <span>{formatWhen(m.generatedAt, locale)}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* --------------------------------------------------------------- node detail */

const KIND_KEY = { root: 'rd.map.node.kindRoot', branch: 'rd.map.node.kindBranch', leaf: 'rd.map.node.kindLeaf' } as const;

function NodeDetail({ layout, selectedId, onSelect, onClose }: { layout: MindMapLayout; selectedId: string | null; onSelect: (id: string) => void; onClose: () => void }) {
  const { t } = useLocale();
  const node = selectedId ? layout.nodes.find((n) => n.id === selectedId) : undefined;
  if (!node) return null;
  const path = pathToRoot(layout, node.id);
  const kids = node.childIds.map((id) => layout.nodes.find((n) => n.id === id)).filter((n): n is NonNullable<typeof n> => !!n);
  return (
    <section className="fw-mm-detail" aria-label={t('rd.map.node.region')} data-group={groupForBranch(node.branch)}>
      <div className="fw-mm-detail__top">
        <span className="fw-mm-label">{t('rd.map.node.heading', { kind: t(KIND_KEY[node.kind]) })}</span>
        <IconButton icon="X" label={t('rd.map.node.close')} size="sm" onClick={onClose} />
      </div>
      <h2 className="fw-mm-detail__title">{node.label}</h2>
      {node.orphan ? <p className="fw-mm-detail__hint">{t('rd.map.node.orphan')}</p> : null}
      {path.length > 1 ? (
        <ol className="fw-mm-detail__path" aria-label={t('rd.map.node.path')}>
          {path.slice(0, -1).map((p) => (
            <li key={p.id}>
              <button type="button" className="fw-mm-chip" data-group={groupForBranch(p.branch)} onClick={() => onSelect(p.id)}>
                {p.label}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <span className="fw-mm-label">
        {kids.length ? t('rd.map.node.children', { count: kids.length }) : t('rd.map.node.noChildren')}
      </span>
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
  const { t, locale } = useLocale();
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
    body = <EmptyState icon="Loader" title={t('rd.map.loading')} />;
  } else if (list.status === 'error') {
    body = (
      <EmptyState
        icon="CircleAlert"
        title={t('rd.map.error.title')}
        detail={t('rd.map.error.detail', { reason: list.error ?? '—' })}
        action={<Button size="sm" icon="RefreshCw" onClick={list.reload}>{t('rd.map.retry')}</Button>}
      />
    );
  } else if (list.value.provenance === 'REFUSED') {
    // The gateway's own note is English server text: shown as is in English, replaced by the Dutch line in Dutch.
    const note = locale === 'en' ? list.value.note : null;
    body = <EmptyState icon="Lock" title={t('rd.map.refused.title')} detail={note ?? t('rd.map.refused.detail')} />;
  } else if (maps.length === 0) {
    body = <EmptyState icon="Map" title={t('rd.map.empty.title')} detail={t('rd.map.empty.detail')} />;
  } else {
    let stage: React.ReactNode;
    if (map.status === 'loading') stage = <EmptyState icon="Loader" title={t('rd.map.open.loading')} compact />;
    else if (map.status === 'error' || !layout) {
      stage = (
        <EmptyState
          icon="CircleAlert"
          title={t('rd.map.open.error')}
          detail={map.error ? t('rd.map.open.errorDetail', { reason: map.error }) : t('rd.map.open.noUsable')}
          action={<Button size="sm" icon="RefreshCw" onClick={map.reload}>{t('rd.map.retry')}</Button>}
          compact
        />
      );
    } else if (layout.nodes.length === 0) stage = <EmptyState icon="Map" title={t('rd.map.open.noNodes')} compact />;
    else stage = (
      <MindMapCanvas
        layout={layout}
        selectedId={selectedNode}
        onSelect={(id) => setSelected({ map: mapId, node: id })}
        label={t('rd.map.canvas', { title: map.value?.title ?? '' })}
      />
    );
    body = (
      <div className="fw-mm__body">
        <div className="fw-mm__bar">
          <MapList maps={maps} selectedId={mapId} onSelect={(id) => setPickedMap(id)} />
          {layout && layout.nodes.length && map.status === 'ready' ? (
            <p className="fw-mm__stats">
              {`${t(countKey(layout.branchCount, 'rd.map.branchesOne', 'rd.map.branchesMany'), { count: layout.branchCount })} · ${t(
                countKey(layout.rings.length, 'rd.map.levelsOne', 'rd.map.levelsMany'),
                { count: layout.rings.length },
              )}`}
            </p>
          ) : null}
        </div>
        {list.value.unreadable > 0 ? (
          <p className="fw-mm__note">
            {t(countKey(list.value.unreadable, 'rd.map.unreadableOne', 'rd.map.unreadableMany'), { count: list.value.unreadable })}
          </p>
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
      {/* The point count and the date sit on the map's chip in the list; the lead and the stats line do not repeat them. */}
      <MindMapHead title={current ? current.title : t('nav.mindmap.label')} lead={t('nav.mindmap.description')} />
      {body}
    </div>
  );
}

/* ----------------------------------------------------------------------- route */

export default function MindMapView() {
  const { state } = usePrototype();
  const navigate = useNavigate();
  const { t } = useLocale();
  const projectName = state.activeProjectId;
  if (!projectName) {
    return (
      <div className="fw-mm">
        <MindMapHead title={t('nav.mindmap.label')} lead={t('nav.mindmap.description')} />
        <EmptyState
          icon="FolderSearch"
          title={t('rd.map.noProject.title')}
          detail={t('rd.map.noProject.detail')}
          action={
            <Button variant="primary" size="sm" icon="ArrowRight" onClick={() => navigate('/projects')}>
              {t('rd.map.noProject.action')}
            </Button>
          }
        />
      </div>
    );
  }
  return <MindMapWorkspace key={projectName} projectName={projectName} />;
}
