/**
 * Mind-map layout — pure, no React, no DOM.
 *
 * The successor of the retired Control Center lens's `radial()` (forge-dashboard/lenses.js, removed in
 * the root sits at the exact world centre and every other node sits on a ring by its depth
 * from the root. One improvement over the old version: instead of spreading each ring evenly (which
 * put a child far away from its own parent), every subtree gets an angular WEDGE sized by its number
 * of leaves, and a child sits in the middle of its own wedge — so branches stay together and edges
 * never cross between siblings' subtrees.
 *
 * Rules carried over from the old lens (and its test): never throws on malformed input, an empty map
 * is an honest 0-node layout, no two nodes share a position, and a node the root cannot reach is put
 * on one extra outer ring instead of being dropped.
 */

export interface LayoutInputNode {
  readonly id: string;
  readonly label: string;
  readonly kind: string | null;
  readonly parent?: string | null;
}

export interface LayoutInputEdge {
  readonly from: string;
  readonly to: string;
}

export interface LaidOutNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'root' | 'branch' | 'leaf';
  readonly depth: number;
  /** Index of the top-level branch this node belongs to (0..n-1); -1 for the root and for orphans. */
  readonly branch: number;
  readonly orphan: boolean;
  /** Centre position in world coordinates. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
}

export interface LaidOutEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** false for an edge outside the spanning tree (drawn dashed). */
  readonly tree: boolean;
}

export interface MindMapLayout {
  readonly nodes: readonly LaidOutNode[];
  readonly edges: readonly LaidOutEdge[];
  readonly world: { readonly w: number; readonly h: number };
  readonly center: { readonly x: number; readonly y: number };
  /** Radius of every depth ring (index 0 = ring 1), for the background guide circles. */
  readonly rings: readonly number[];
  readonly rootId: string | null;
  readonly branchCount: number;
}

export interface LayoutOptions {
  readonly ringGap?: number;
  readonly margin?: number;
  /** Minimum arc length between two neighbouring leaves on the outer ring. */
  readonly leafArc?: number;
  /** Horizontal stretch of the rings (labels are wide, so an ellipse packs them better). */
  readonly stretchX?: number;
}

const NODE_H = 36;
const ROOT_H = 48;
// measured on the real node font (Inter-like, text-xs medium): ~7.6px per character, plus
// the dot, the gap and both paddings (~46px). The old 7.2/32 left "Mind Map" 7px short and cut it.
const CHAR_W = 7.6;
const MIN_W = 96;
const MAX_W = 240;
const START_ANGLE = -Math.PI / 2; // first branch points up
/** Minimum free space between two node boxes. */
const NODE_GAP = 10;

export function nodeSize(label: string, isRoot: boolean): { w: number; h: number } {
  const chars = Math.min(label.length, 40);
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(chars * CHAR_W + (isRoot ? 52 : 46))));
  return { w, h: isRoot ? ROOT_H : NODE_H };
}

export function emptyLayout(): MindMapLayout {
  return { nodes: [], edges: [], world: { w: 600, h: 400 }, center: { x: 300, y: 200 }, rings: [], rootId: null, branchCount: 0 };
}

export function layoutMindMap(
  inputNodes: readonly LayoutInputNode[] | null | undefined,
  inputEdges: readonly LayoutInputEdge[] | null | undefined,
  opts: LayoutOptions = {},
): MindMapLayout {
  const ringGapMin = opts.ringGap ?? 150;
  const margin = opts.margin ?? 40;
  const stretchX = opts.stretchX ?? 1.3;
  const leafArc = opts.leafArc ?? 64;

  const src = (Array.isArray(inputNodes) ? inputNodes : []).filter(
    (n): n is LayoutInputNode => !!n && typeof n.id === 'string' && n.id.length > 0,
  );
  const ids = new Set<string>();
  const nodesIn: LayoutInputNode[] = [];
  for (const n of src) {
    if (ids.has(n.id)) continue;
    ids.add(n.id);
    nodesIn.push(n);
  }
  if (nodesIn.length === 0) return emptyLayout();

  // Edges: the explicit list, else the nodes' own `parent` fields.
  const rawEdges: LayoutInputEdge[] = Array.isArray(inputEdges) && inputEdges.length > 0
    ? inputEdges.filter((e): e is LayoutInputEdge => !!e && typeof e.from === 'string' && typeof e.to === 'string')
    : nodesIn.filter((n) => typeof n.parent === 'string').map((n) => ({ from: n.parent as string, to: n.id }));
  const seenEdge = new Set<string>();
  const edgesIn = rawEdges.filter((e) => {
    const k = `${e.from}\u0000${e.to}`;
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to || seenEdge.has(k)) return false;
    seenEdge.add(k);
    return true;
  });

  const indeg = new Map<string, number>(nodesIn.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodesIn.map((n) => [n.id, []]));
  for (const e of edgesIn) {
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const root = nodesIn.find((n) => n.kind === 'root') ?? nodesIn.find((n) => indeg.get(n.id) === 0) ?? nodesIn[0];

  // BFS spanning tree from the root (first discovery wins).
  const parentOf = new Map<string, string | null>([[root.id, null]]);
  const depthOf = new Map<string, number>([[root.id, 0]]);
  const children = new Map<string, string[]>(nodesIn.map((n) => [n.id, []]));
  const treeEdge = new Set<string>();
  const queue = [root.id];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of out.get(u) ?? []) {
      if (depthOf.has(v)) continue;
      depthOf.set(v, (depthOf.get(u) ?? 0) + 1);
      parentOf.set(v, u);
      children.get(u)!.push(v);
      treeEdge.add(`${u}\u0000${v}`);
      queue.push(v);
    }
  }

  // Leaf weights (post-order over the tree).
  const weight = new Map<string, number>();
  const order: string[] = [];
  (function collect(id: string): void {
    const stack: string[] = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      order.push(cur);
      for (const c of children.get(cur) ?? []) stack.push(c);
    }
  })(root.id);
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const cs = children.get(id) ?? [];
    weight.set(id, cs.length ? cs.reduce((s, c) => s + (weight.get(c) ?? 1), 0) : 1);
  }

  const orphans = nodesIn.filter((n) => !depthOf.has(n.id));
  let maxDepth = 0;
  depthOf.forEach((d) => { if (d > maxDepth) maxDepth = d; });
  const outerDepth = orphans.length ? maxDepth + 1 : maxDepth;

  // Ring gap: wide enough that the outer ring fits every leaf with `leafArc` between neighbours.
  const leaves = Math.max(weight.get(root.id) ?? 1, orphans.length);
  const neededGap = outerDepth > 0 ? (leaves * leafArc) / (2 * Math.PI * Math.max(1, maxDepth || 1)) : 0;
  let ringGap = Math.max(ringGapMin, Math.ceil(neededGap));

  // Angular wedges.
  const angleOf = new Map<string, number>([[root.id, START_ANGLE]]);
  const branchOf = new Map<string, number>([[root.id, -1]]);
  const topLevel = children.get(root.id) ?? [];
  (function assign(id: string, a0: number, a1: number): void {
    const stack: [string, number, number][] = [[id, a0, a1]];
    while (stack.length) {
      const [cur, s, e] = stack.pop()!;
      const cs = children.get(cur) ?? [];
      const w = weight.get(cur) ?? 1;
      let at = s;
      for (const c of cs) {
        const span = ((e - s) * (weight.get(c) ?? 1)) / w;
        angleOf.set(c, at + span / 2);
        if (cur === root.id) branchOf.set(c, topLevel.indexOf(c));
        else branchOf.set(c, branchOf.get(cur) ?? -1);
        stack.push([c, at, at + span]);
        at += span;
      }
    }
  })(root.id, START_ANGLE, START_ANGLE + 2 * Math.PI);
  orphans.forEach((n, i) => {
    angleOf.set(n.id, START_ANGLE + (i * 2 * Math.PI) / orphans.length + Math.PI / Math.max(2, orphans.length));
    branchOf.set(n.id, -1);
  });

  // Positions relative to the centre, then a symmetric world so the root is exactly centred.
  const rel = new Map<string, { x: number; y: number; w: number; h: number }>();
  const radius = new Map<string, number>();
  for (const n of nodesIn) {
    const isRoot = n.id === root.id;
    const d = isRoot ? 0 : depthOf.has(n.id) ? depthOf.get(n.id)! : outerDepth;
    radius.set(n.id, d * ringGap);
    rel.set(n.id, { x: 0, y: 0, ...nodeSize(n.label ?? n.id, isRoot) });
  }
  const place = (id: string): void => {
    const p = rel.get(id)!;
    const r = radius.get(id) ?? 0;
    const a = angleOf.get(id) ?? 0;
    rel.set(id, { ...p, x: id === root.id ? 0 : r * stretchX * Math.cos(a), y: id === root.id ? 0 : r * Math.sin(a) });
  };
  nodesIn.forEach((n) => place(n.id));

  // first widen the rings until no two boxes touch (siblings on one ring separate as the
  // ring grows), so nodes stay on their own ring and edges keep a clear straight run. Only what is
  // still touching after that is pushed outward below.
  const anyTouching = (): boolean => {
    const boxes = [...rel.values()];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + NODE_GAP && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + NODE_GAP) return true;
      }
    }
    return false;
  };
  for (let grow = 0; grow < 12 && anyTouching(); grow++) {
    ringGap = Math.ceil(ringGap * 1.15);
    for (const n of nodesIn) {
      const d = n.id === root.id ? 0 : depthOf.has(n.id) ? depthOf.get(n.id)! : outerDepth;
      radius.set(n.id, d * ringGap);
      place(n.id);
    }
  }

  // wide labels on a tight ring can still touch. Push the deeper (else the later) node of any
  // touching pair outward along its own angle until every pair clears by NODE_GAP — bounded, so a
  // pathological map still returns a layout.
  const depthIdx = (id: string): number => (id === root.id ? 0 : depthOf.get(id) ?? outerDepth);
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < nodesIn.length; i++) {
      for (let j = i + 1; j < nodesIn.length; j++) {
        const a = rel.get(nodesIn[i].id)!;
        const b = rel.get(nodesIn[j].id)!;
        const ox = (a.w + b.w) / 2 + NODE_GAP - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + NODE_GAP - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        const mover = depthIdx(nodesIn[j].id) >= depthIdx(nodesIn[i].id) ? nodesIn[j].id : nodesIn[i].id;
        if (mover === root.id) continue;
        radius.set(mover, (radius.get(mover) ?? 0) + Math.max(8, Math.min(ox, oy)));
        place(mover);
        moved = true;
      }
    }
    if (!moved) break;
  }

  let halfW = 0;
  let halfH = 0;
  for (const p of rel.values()) {
    halfW = Math.max(halfW, Math.abs(p.x) + p.w / 2);
    halfH = Math.max(halfH, Math.abs(p.y) + p.h / 2);
  }
  const cx = halfW + margin;
  const cy = halfH + margin;

  const nodes: LaidOutNode[] = nodesIn.map((n) => {
    const p = rel.get(n.id)!;
    const isRoot = n.id === root.id;
    const cs = children.get(n.id) ?? [];
    return {
      id: n.id,
      label: n.label || n.id,
      kind: isRoot ? 'root' : cs.length ? 'branch' : 'leaf',
      depth: isRoot ? 0 : depthOf.get(n.id) ?? outerDepth,
      branch: branchOf.get(n.id) ?? -1,
      orphan: !depthOf.has(n.id),
      x: cx + p.x,
      y: cy + p.y,
      w: p.w,
      h: p.h,
      parentId: parentOf.get(n.id) ?? null,
      childIds: cs,
    };
  });

  const edges: LaidOutEdge[] = edgesIn.map((e) => ({
    id: `${e.from}->${e.to}`,
    from: e.from,
    to: e.to,
    tree: treeEdge.has(`${e.from}\u0000${e.to}`),
  }));

  const rings: number[] = [];
  for (let d = 1; d <= outerDepth; d++) rings.push(d * ringGap);

  return {
    nodes,
    edges,
    world: { w: cx * 2, h: cy * 2 },
    center: { x: cx, y: cy },
    rings,
    rootId: root.id,
    branchCount: topLevel.length,
  };
}

/** The node path from the root to `id` (inclusive), following the spanning tree. */
export function pathToRoot(layout: MindMapLayout, id: string): readonly LaidOutNode[] {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const out: LaidOutNode[] = [];
  let cur = byId.get(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** The seven design-system group hues, assigned to top-level branches in order. */
export const BRANCH_GROUPS = ['planning', 'execution', 'review', 'memory', 'domain', 'context', 'control'] as const;

export function groupForBranch(branch: number): string {
  return branch < 0 ? 'root' : BRANCH_GROUPS[branch % BRANCH_GROUPS.length];
}

/* ------------------------------------------------------------------ edges */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface EdgeRoute {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** SVG path data, starting on the parent's box edge and ending on the child's box edge. */
  readonly d: string;
  /** Points along the drawn path (start and end included), for hit tests and layout checks. */
  readonly samples: readonly Point[];
  readonly shape: 'straight' | 'curve';
}

type Box = Pick<LaidOutNode, 'x' | 'y' | 'w' | 'h'>;

/** Where the ray from a box's centre towards `toward` leaves the box. */
export function boxExit(box: Box, toward: Point): Point {
  const dx = toward.x - box.x;
  const dy = toward.y - box.y;
  if (dx === 0 && dy === 0) return { x: box.x, y: box.y };
  const tx = dx !== 0 ? box.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = dy !== 0 ? box.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(tx, ty, 1);
  return { x: box.x + dx * t, y: box.y + dy * t };
}

/** True when `p` lies inside `box` grown by `pad` on every side. */
export function pointInBox(p: Point, box: Box, pad = 0): boolean {
  return Math.abs(p.x - box.x) <= box.w / 2 + pad && Math.abs(p.y - box.y) <= box.h / 2 + pad;
}

const SAMPLES = 32;
const CLEARANCE = 6;

function quadPoint(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function sampleQuad(a: Point, c: Point, b: Point): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= SAMPLES; i++) out.push(quadPoint(a, c, b, i / SAMPLES));
  return out;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * every edge is drawn from ITS parent to ITS child, box edge to box edge. The straight line
 * comes first; if it would pass over (or behind) a third node, a curve bending to one side or the
 * other is tried, with growing bend, and the first one that clears every other node wins. If none
 * clears, the straight line is kept (honest fallback: it still joins the right two nodes).
 */
export function routeEdges(layout: MindMapLayout): readonly EdgeRoute[] {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const routes: EdgeRoute[] = [];
  for (const e of layout.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const others = layout.nodes.filter((n) => n.id !== from.id && n.id !== to.id);
    const clears = (pts: readonly Point[]): boolean => pts.every((p) => others.every((o) => !pointInBox(p, o, CLEARANCE)));

    const a = boxExit(from, to);
    const b = boxExit(to, from);
    const straight = sampleQuad(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b);
    let chosen: EdgeRoute = { id: e.id, from: e.from, to: e.to, d: `M ${r1(a.x)} ${r1(a.y)} L ${r1(b.x)} ${r1(b.y)}`, samples: straight, shape: 'straight' };

    if (!clears(straight)) {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      search: for (const bend of [0.2, 0.35, 0.5, 0.75, 1, 1.4, 2]) {
        for (const side of [1, -1]) {
          // Start and end leave the boxes towards the control point, so the curve never starts
          // inside its own parent and bends around, not through, a neighbour.
          const c = { x: mid.x + nx * len * bend * side, y: mid.y + ny * len * bend * side };
          const ca = boxExit(from, c);
          const cb = boxExit(to, c);
          const pts = sampleQuad(ca, c, cb);
          if (clears(pts)) {
            chosen = {
              id: e.id,
              from: e.from,
              to: e.to,
              d: `M ${r1(ca.x)} ${r1(ca.y)} Q ${r1(c.x)} ${r1(c.y)} ${r1(cb.x)} ${r1(cb.y)}`,
              samples: pts,
              shape: 'curve',
            };
            break search;
          }
        }
      }
    }
    routes.push(chosen);
  }
  return routes;
}
