/**
 * Forge Command Center — gateway adapter, mind-map slice.
 *
 * Reads the gateway's read-only `GET /api/mindmaps?project=<name>` (the list) and
 * `GET /api/mindmaps?project=<name>&id=<map_id>` (one map) — see `gateway/src/mindmaps.mjs` for the
 * id allowlist, link refusal and caps. These are the maps `.claude/forge-bin/forge-mindmap.cjs` writes
 * to `<project>/.claude/forge-mindmaps/`; the old Control Center lens that showed them was removed in
 * and this is its replacement.
 *
 * Honesty rules (same as every other slice): a field is real, derived from a real response, or
 * explicitly absent. Each hook exposes its own `status` ('loading' | 'ready' | 'error') so a view can
 * show a real loading and error state instead of an empty one that looks like "no data".
 */

import { useCallback, useEffect, useState } from 'react';

import { gwGet, pickArray, pickBool, pickNumber, pickRecord, pickString } from '@/prototype/state/gateway-client';

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface MindMapSummary {
  readonly id: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly generatedAt: string | null;
}

export interface MindMapList {
  readonly available: boolean;
  /** 'LIVE' | 'NOT GENERATED' | 'REFUSED' | 'UNREADABLE' — the gateway's own word. */
  readonly provenance: string | null;
  readonly note: string | null;
  readonly maps: readonly MindMapSummary[];
  readonly unreadable: number;
  readonly truncated: boolean;
}

export interface MindMapNodeData {
  readonly id: string;
  readonly label: string;
  readonly kind: string | null;
  readonly parent: string | null;
}

export interface MindMapEdgeData {
  readonly from: string;
  readonly to: string;
}

export interface MindMapData {
  readonly id: string;
  readonly title: string;
  readonly nodes: readonly MindMapNodeData[];
  readonly edges: readonly MindMapEdgeData[];
  readonly generatedAt: string | null;
}

export const EMPTY_MINDMAP_LIST: MindMapList = {
  available: false,
  provenance: null,
  note: null,
  maps: [],
  unreadable: 0,
  truncated: false,
};

export function parseMindMapList(data: Record<string, unknown>): MindMapList {
  const maps: MindMapSummary[] = [];
  for (const row of pickArray(data, ['maps'])) {
    const id = pickString(row, ['id']);
    if (id === null) continue;
    maps.push({
      id,
      title: pickString(row, ['title']) ?? id,
      nodeCount: pickNumber(row, ['node_count']) ?? 0,
      edgeCount: pickNumber(row, ['edge_count']) ?? 0,
      generatedAt: pickString(row, ['generated_at']),
    });
  }
  return {
    available: pickBool(data, ['available']) ?? false,
    provenance: pickString(data, ['provenance']),
    note: pickString(data, ['note']),
    maps,
    unreadable: pickNumber(data, ['unreadable']) ?? 0,
    truncated: pickBool(data, ['truncated']) ?? false,
  };
}

/** Parses one map. Returns null when the response carries no usable map at all. */
export function parseMindMap(data: Record<string, unknown>): MindMapData | null {
  const map = pickRecord(data, ['map']);
  if (map === null) return null;
  const id = pickString(map, ['map_id']);
  if (id === null) return null;
  const nodes: MindMapNodeData[] = [];
  for (const n of pickArray(map, ['nodes'])) {
    const nid = pickString(n, ['id']);
    if (nid === null) continue;
    nodes.push({ id: nid, label: pickString(n, ['label']) ?? nid, kind: pickString(n, ['kind']), parent: pickString(n, ['parent']) });
  }
  const edges: MindMapEdgeData[] = [];
  for (const e of pickArray(map, ['edges'])) {
    const from = pickString(e, ['from']);
    const to = pickString(e, ['to']);
    if (from !== null && to !== null) edges.push({ from, to });
  }
  return { id, title: pickString(map, ['title']) ?? id, nodes, edges, generatedAt: pickString(map, ['generated_at']) };
}

const MINDMAP_LIST_POLL_MS = 30_000;

export interface Loaded<T> {
  readonly status: LoadStatus;
  readonly value: T;
  readonly error: string | null;
  readonly reload: () => void;
}

/** The active project's mind-map list. Polls slowly: maps are written once per L3/L4 run. */
export function useMindMapList(projectName: string): Loaded<MindMapList> {
  const [state, setState] = useState<{ key: string; status: LoadStatus; value: MindMapList; error: string | null }>({
    key: '', status: 'loading', value: EMPTY_MINDMAP_LIST, error: null,
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/mindmaps?project=${encodeURIComponent(projectName)}`);
      if (cancelled) return;
      if (result.ok) setState({ key: projectName, status: 'ready', value: parseMindMapList(result.data), error: null });
      // A failed poll keeps the last good list on screen; only a first load shows the error.
      else setState((prev) => (prev.key === projectName && prev.status === 'ready' ? prev : { key: projectName, status: 'error', value: EMPTY_MINDMAP_LIST, error: result.error }));
    }
    void tick();
    const id = setInterval(() => void tick(), MINDMAP_LIST_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [projectName, nonce]);

  if (state.key !== projectName) return { status: 'loading', value: EMPTY_MINDMAP_LIST, error: null, reload };
  return { status: state.status, value: state.value, error: state.error, reload };
}

/** One map, fetched when the selection changes (and on reload). `mapId` null = nothing selected. */
export function useMindMap(projectName: string, mapId: string | null): Loaded<MindMapData | null> {
  const key = `${projectName}\u0000${mapId ?? ''}`;
  const [state, setState] = useState<{ key: string; status: LoadStatus; value: MindMapData | null; error: string | null }>({
    key: '', status: 'loading', value: null, error: null,
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (projectName === '' || mapId === null) return undefined;
    let cancelled = false;
    void (async () => {
      const result = await gwGet(`/api/mindmaps?project=${encodeURIComponent(projectName)}&id=${encodeURIComponent(mapId)}`);
      if (cancelled) return;
      if (!result.ok) { setState({ key, status: 'error', value: null, error: result.error }); return; }
      const parsed = parseMindMap(result.data);
      setState(parsed === null
        ? { key, status: 'error', value: null, error: 'the gateway answered without a usable map' }
        : { key, status: 'ready', value: parsed, error: null });
    })();
    return () => { cancelled = true; };
  }, [projectName, mapId, key, nonce]);

  if (state.key !== key) return { status: 'loading', value: null, error: null, reload };
  return { status: state.status, value: state.value, error: state.error, reload };
}
