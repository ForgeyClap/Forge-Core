/**
 * (defects 5 and 9): every mind-map edge is drawn from its own parent to its own child, and
 * no edge passes over (or behind) a third node's box. The fixture is the live "Mission Control" map
 * (mm-mc-phase2) the verification screenshots showed, laid out with the desktop and the phone
 * options. Also: a label like "Mind Map" gets a box wide enough not to be cut.
 */
import { describe, expect, it } from 'vitest';

import { boxExit, layoutMindMap, nodeSize, pointInBox, routeEdges, type LaidOutNode } from '@/views/mindmap/mindmap-layout';

const MISSION_CONTROL = {
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
    { from: 'mission-control-0', to: 'visibility-1' },
    { from: 'visibility-1', to: 'task-graph-2' },
    { from: 'visibility-1', to: 'mind-map-3' },
    { from: 'mission-control-0', to: 'capabilities-4' },
    { from: 'capabilities-4', to: 'prd-5' },
    { from: 'capabilities-4', to: 'deep-learn-6' },
    { from: 'mission-control-0', to: 'safety-7' },
    { from: 'safety-7', to: 'doctor-8' },
    { from: 'safety-7', to: 'leak-scan-9' },
  ],
};

/** A wider, deeper fixture: one branch with many leaves, so leaves crowd each other. */
const CROWDED = (() => {
  const nodes = [{ id: 'r', label: 'Root of a crowded map', kind: 'root', parent: null as string | null }];
  for (let b = 0; b < 4; b++) {
    nodes.push({ id: `b${b}`, label: `Branch ${b}`, kind: 'branch', parent: 'r' });
    for (let l = 0; l < (b === 0 ? 7 : 2); l++) nodes.push({ id: `b${b}-l${l}`, label: `Leaf ${b}.${l} with a label`, kind: 'leaf', parent: `b${b}` });
  }
  return { nodes, edges: [] as { from: string; to: string }[] };
})();

const VARIANTS = [
  { name: 'desktop', opts: {} },
  { name: 'phone (portrait stage)', opts: { stretchX: 0.62, ringGap: 120, leafArc: 52 } },
];

function onBoxEdge(p: { x: number; y: number }, n: LaidOutNode): boolean {
  // On the box outline (within half a pixel), not inside it and not away from it.
  const dx = Math.abs(p.x - n.x) - n.w / 2;
  const dy = Math.abs(p.y - n.y) - n.h / 2;
  return (Math.abs(dx) <= 0.6 && dy <= 0.6) || (Math.abs(dy) <= 0.6 && dx <= 0.6);
}

for (const fixture of [{ name: 'Mission Control', map: MISSION_CONTROL }, { name: 'crowded', map: CROWDED }]) {
  for (const v of VARIANTS) {
    describe(`mind-map edges — ${fixture.name}, ${v.name}`, () => {
      const layout = layoutMindMap(fixture.map.nodes, fixture.map.edges, v.opts);
      const byId = new Map(layout.nodes.map((n) => [n.id, n]));
      const routes = routeEdges(layout);

      it('draws exactly one route per edge, joining that edge\'s own parent and child', () => {
        expect(routes).toHaveLength(layout.edges.length);
        for (const r of routes) {
          const edge = layout.edges.find((e) => e.id === r.id)!;
          expect([r.from, r.to]).toEqual([edge.from, edge.to]);
          const child = byId.get(r.to)!;
          // A tree edge always runs from the child's own parent.
          if (edge.tree) expect(child.parentId).toBe(r.from);
          const first = r.samples[0];
          const last = r.samples[r.samples.length - 1];
          expect(onBoxEdge(first, byId.get(r.from)!)).toBe(true);
          expect(onBoxEdge(last, child)).toBe(true);
        }
      });

      it('no edge passes over a third node\'s box', () => {
        for (const r of routes) {
          for (const n of layout.nodes) {
            if (n.id === r.from || n.id === r.to) continue;
            const hit = r.samples.find((p) => pointInBox(p, n, 0));
            expect(hit, `${r.id} crosses ${n.id}`).toBeUndefined();
          }
        }
      });

      it('no two nodes overlap', () => {
        const ns = layout.nodes;
        for (let i = 0; i < ns.length; i++) {
          for (let j = i + 1; j < ns.length; j++) {
            const a = ns[i];
            const b = ns[j];
            const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
            expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
          }
        }
      });
    });
  }
}

describe('boxExit', () => {
  it('leaves a box on its outline in the direction of the target', () => {
    const box = { x: 0, y: 0, w: 100, h: 40 };
    expect(boxExit(box, { x: 200, y: 0 })).toEqual({ x: 50, y: 0 });
    expect(boxExit(box, { x: 0, y: -200 })).toEqual({ x: 0, y: -20 });
  });
});

describe('node size (defect 9)', () => {
  it('gives "Mind Map" room for its text: about 7.6px a character plus dot and padding', () => {
    const { w } = nodeSize('Mind Map', false);
    // 8 characters of text-xs medium ≈ 61px rendered, + 8px dot + 8px gap + 2 × 12px padding = 101px.
    expect(w).toBeGreaterThanOrEqual(101);
  });
});
