/**
 * Port of the retired `.claude/forge-bin/forge-mindmap-lens.test.cjs` (deleted with the Control Center
 * in, commit 1b6bb9d) onto the Command Center's replacement layout, `layoutMindMap()`.
 *
 * The old test proved, against the shipped lens: a root + 3 children map gives 4 nodes and 3 edges,
 * a positive world size, the root at the world centre, distinct child positions (no stacking), no child
 * on top of the root, and an honest empty model (never a crash) for no maps / missing input. Every one of
 * those intents is kept below; the lens-registry checks (LENS_ORDER etc.) become route + nav checks,
 * since the Command Center has routes, not lenses.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALL_NAV } from '@/components/shell/nav-config';
import { layoutMindMap, pathToRoot } from '@/views/mindmap/mindmap-layout';

const ROOT_PLUS_THREE = {
  nodes: [
    { id: 'root', label: 'R', kind: 'root' },
    { id: 'a', label: 'A', kind: null },
    { id: 'b', label: 'B', kind: null },
    { id: 'c', label: 'C', kind: null },
  ],
  edges: [{ from: 'root', to: 'a' }, { from: 'root', to: 'b' }, { from: 'root', to: 'c' }],
};

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
}

describe('mind-map view is registered (was: lens registered in LENS_ORDER)', () => {
  it('has a /mindmap route and a nav entry', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).toMatch(/path="\/mindmap"/);
    expect(ALL_NAV.some((n) => n.path === '/mindmap')).toBe(true);
  });
});

describe('layoutMindMap — the old lens test intents', () => {
  const model = layoutMindMap(ROOT_PLUS_THREE.nodes, ROOT_PLUS_THREE.edges);

  it('returns 4 nodes and 3 edges for a root + 3 children map', () => {
    expect(model.nodes).toHaveLength(4);
    expect(model.edges).toHaveLength(3);
  });

  it('has a positive world size', () => {
    expect(model.world.w).toBeGreaterThan(0);
    expect(model.world.h).toBeGreaterThan(0);
  });

  it('puts the root at the world centre', () => {
    const root = model.nodes.find((n) => n.id === 'root')!;
    expect(root.kind).toBe('root');
    expect(Math.abs(root.x - model.world.w / 2)).toBeLessThan(1);
    expect(Math.abs(root.y - model.world.h / 2)).toBeLessThan(1);
  });

  it('gives the 3 children distinct positions and none sits on the root', () => {
    const kids = model.nodes.filter((n) => n.id !== 'root');
    const keys = new Set(kids.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
    expect(keys.size).toBe(3);
    const root = model.nodes.find((n) => n.id === 'root')!;
    for (const k of kids) expect(Math.hypot(k.x - root.x, k.y - root.y)).toBeGreaterThan(1);
  });

  it('returns an honest empty model for no nodes, and never throws on missing input', () => {
    const empty = layoutMindMap([], []);
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(() => layoutMindMap(undefined, undefined)).not.toThrow();
    expect(layoutMindMap(null, null).nodes).toEqual([]);
  });
});

describe('layoutMindMap — the radial improvements', () => {
  // The real map stored in this repo (.claude/forge-mindmaps/mm-mc-phase2.json), inlined.
  const REAL = {
    nodes: [
      { id: 'mission-control-0', label: 'Mission Control', kind: 'root', parent: null },
      { id: 'visibility-1', label: 'Visibility', kind: 'branch', parent: 'mission-control-0' },
      { id: 'task-graph-2', label: 'Task Graph', kind: 'leaf', parent: 'visibility-1' },
      { id: 'mind-map-3', label: 'Mind Map', kind: 'leaf', parent: 'visibility-1' },
      { id: 'capabilities-4', label: 'Capabilities', kind: 'branch', parent: 'mission-control-0' },
      { id: 'prd-5', label: 'PRD', kind: 'leaf', parent: 'capabilities-4' },
      { id: 'deep-learn-6', label: 'Deep Learn', kind: 'leaf', parent: 'capabilities-4' },
      { id: 'safety-7', label: 'Safety', kind: 'branch', parent: 'mission-control-0' },
      { id: 'doctor-8', label: 'Doctor', kind: 'leaf', parent: 'safety-7' },
      { id: 'leak-scan-9', label: 'Leak Scan', kind: 'leaf', parent: 'safety-7' },
    ],
    edges: [
      ['mission-control-0', 'visibility-1'], ['visibility-1', 'task-graph-2'], ['visibility-1', 'mind-map-3'],
      ['mission-control-0', 'capabilities-4'], ['capabilities-4', 'prd-5'], ['capabilities-4', 'deep-learn-6'],
      ['mission-control-0', 'safety-7'], ['safety-7', 'doctor-8'], ['safety-7', 'leak-scan-9'],
    ].map(([from, to]) => ({ from, to })),
  };
  const m = layoutMindMap(REAL.nodes, REAL.edges);

  it('no two node boxes overlap', () => {
    for (let i = 0; i < m.nodes.length; i++) {
      for (let j = i + 1; j < m.nodes.length; j++) expect(overlaps(m.nodes[i], m.nodes[j]), `${m.nodes[i].id} vs ${m.nodes[j].id}`).toBe(false);
    }
  });

  it('a subtree keeps its top-level branch index and depth grows by ring', () => {
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    expect(m.branchCount).toBe(3);
    expect(byId.get('prd-5')!.branch).toBe(byId.get('capabilities-4')!.branch);
    expect(byId.get('prd-5')!.depth).toBe(2);
    expect(m.rings).toHaveLength(2);
  });

  it('children sit nearer their own parent than the other branches do', () => {
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    const d = (a: string, b: string): number => Math.hypot(byId.get(a)!.x - byId.get(b)!.x, byId.get(a)!.y - byId.get(b)!.y);
    expect(d('prd-5', 'capabilities-4')).toBeLessThan(d('prd-5', 'safety-7'));
    expect(d('prd-5', 'capabilities-4')).toBeLessThan(d('prd-5', 'visibility-1'));
  });

  it('falls back to the nodes’ own parent fields when there is no edge list', () => {
    const viaParents = layoutMindMap(REAL.nodes, []);
    expect(viaParents.edges).toHaveLength(9);
    expect(viaParents.rings).toHaveLength(2);
  });

  it('places an unreachable node on an extra outer ring instead of dropping it', () => {
    const withOrphan = layoutMindMap([...ROOT_PLUS_THREE.nodes, { id: 'lost', label: 'Lost', kind: null }], ROOT_PLUS_THREE.edges);
    const lost = withOrphan.nodes.find((n) => n.id === 'lost')!;
    expect(lost.orphan).toBe(true);
    expect(lost.depth).toBe(2);
    expect(withOrphan.rings).toHaveLength(2);
  });

  it('ignores dangling, self and duplicate edges and duplicate node ids', () => {
    const r = layoutMindMap(
      [{ id: 'r', label: 'R', kind: 'root' }, { id: 'a', label: 'A', kind: null }, { id: 'a', label: 'dup', kind: null }],
      [{ from: 'r', to: 'a' }, { from: 'r', to: 'a' }, { from: 'a', to: 'a' }, { from: 'r', to: 'ghost' }],
    );
    expect(r.nodes).toHaveLength(2);
    expect(r.edges).toHaveLength(1);
  });

  it('pathToRoot walks from a leaf back to the root', () => {
    expect(pathToRoot(m, 'doctor-8').map((n) => n.id)).toEqual(['mission-control-0', 'safety-7', 'doctor-8']);
  });
});
