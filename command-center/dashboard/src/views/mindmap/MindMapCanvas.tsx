/**
 * MindMapCanvas — the pannable, zoomable radial drawing of one mind map.
 *
 * One transformed layer holds both the SVG (depth rings + curved edges) and the node buttons, so pan
 * and zoom are a single CSS `transform` on that layer — nothing else ever animates. Nodes are real
 * <button>s: Tab reaches them, Enter/Space selects, and a node that receives focus while it is outside
 * the visible area is panned into view.
 *
 * Canvas keys (the canvas itself is focusable): arrow keys pan, + / - zoom, 0 fits the whole map.
 * Pointer: drag the background to pan, scroll/pinch-wheel to zoom around the pointer.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { IconButton } from '@/components/primitives';

import { groupForBranch, routeEdges } from './mindmap-layout';
import type { LaidOutNode, MindMapLayout } from './mindmap-layout';
import { useLocale } from '@/i18n/use-locale';

interface View {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

const MIN_K = 0.15;
const MAX_K = 2.5;
const PAN_STEP = 64;
const ZOOM_STEP = 1.2;
const FIT_PAD = 24;

const clampK = (k: number): number => Math.max(MIN_K, Math.min(MAX_K, k));

export interface MindMapCanvasProps {
  readonly layout: MindMapLayout;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly label: string;
}

export function MindMapCanvas({ layout, selectedId, onSelect, label }: MindMapCanvasProps) {
  const { t } = useLocale();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // The view the person panned/zoomed to, remembered only for the map + viewport size it was made
  // on; any other combination shows the fitted view (derived during render, no effect needed).
  const [userView, setUserView] = useState<{ key: string; v: View } | null>(null);
  const [animate, setAnimate] = useState(false);
  const drag = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  // each edge is routed parent → child, box edge to box edge, around any third node.
  const routes = useMemo(() => routeEdges(layout), [layout]);

  // Track the viewport size (ResizeObserver where available; jsdom has none).
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitView = useMemo((): View => {
    const vw = size.w || 800;
    const vh = size.h || 600;
    const k = clampK(Math.min((vw - FIT_PAD * 2) / layout.world.w, (vh - FIT_PAD * 2) / layout.world.h, 1.1));
    return { k, x: (vw - layout.world.w * k) / 2, y: (vh - layout.world.h * k) / 2 };
  }, [layout, size.w, size.h]);
  // the first view is ALWAYS the fitted one, on every viewport — the map never opens with
  // nodes off the canvas. (It used to open at a fixed "legible" zoom centred on the root, which on a
  // phone pushed the outer nodes out of view.) Zoom in from there with + or a pinch.
  const startView = fitView;
  const fitKey = `${layout.world.w}x${layout.world.h}@${size.w}x${size.h}#${layout.rootId ?? ''}`;
  const view = userView !== null && userView.key === fitKey ? userView.v : startView;
  const setView = useCallback((fn: (v: View) => View) => {
    setUserView((prev) => ({ key: fitKey, v: fn(prev !== null && prev.key === fitKey ? prev.v : startView) }));
  }, [fitKey, startView]);

  const zoomAt = useCallback((factor: number, px?: number, py?: number, smooth = false) => {
    setAnimate(smooth);
    setView((v) => {
      const k = clampK(v.k * factor);
      const ax = px ?? (size.w || 800) / 2;
      const ay = py ?? (size.h || 600) / 2;
      return { k, x: ax - (ax - v.x) * (k / v.k), y: ay - (ay - v.y) * (k / v.k) };
    });
  }, [size.w, size.h, setView]);

  const panBy = useCallback((dx: number, dy: number) => {
    setAnimate(true);
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }, [setView]);

  const fit = useCallback(() => { setAnimate(true); setUserView({ key: fitKey, v: fitView }); }, [fitKey, fitView]);

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setAnimate(false);
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) }));
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget && !(e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0')) return;
    const map: Record<string, () => void> = {
      ArrowLeft: () => panBy(PAN_STEP, 0),
      ArrowRight: () => panBy(-PAN_STEP, 0),
      ArrowUp: () => panBy(0, PAN_STEP),
      ArrowDown: () => panBy(0, -PAN_STEP),
      '+': () => zoomAt(ZOOM_STEP, undefined, undefined, true),
      '=': () => zoomAt(ZOOM_STEP, undefined, undefined, true),
      '-': () => zoomAt(1 / ZOOM_STEP, undefined, undefined, true),
      '0': fit,
    };
    const fn = map[e.key];
    if (fn) { e.preventDefault(); fn(); }
  };

  /** Pan a focused node into view when it sits (partly) outside the viewport. */
  const revealNode = (n: LaidOutNode): void => {
    if (!size.w || !size.h) return;
    const sx = view.x + n.x * view.k;
    const sy = view.y + n.y * view.k;
    const mx = (n.w / 2) * view.k + 16;
    const my = (n.h / 2) * view.k + 16;
    if (sx - mx >= 0 && sx + mx <= size.w && sy - my >= 0 && sy + my <= size.h) return;
    setAnimate(true);
    setView((v) => ({ ...v, x: size.w / 2 - n.x * v.k, y: size.h / 2 - n.y * v.k }));
  };

  const selectedPath = useMemo(() => {
    const ids = new Set<string>();
    let cur = selectedId ? byId.get(selectedId) : undefined;
    while (cur && !ids.has(cur.id)) { ids.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return ids;
  }, [selectedId, byId]);

  return (
    <div className="fw-mm-canvas">
      <div
        ref={viewportRef}
        className="fw-mm-canvas__viewport"
        data-dragging={dragging ? 'true' : 'false'}
        tabIndex={0}
        role="group"
        aria-label={t('rd.map.canvasHelp', { label })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div
          className="fw-mm-canvas__layer"
          data-animate={animate ? 'true' : 'false'}
          style={{ width: layout.world.w, height: layout.world.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          <svg className="fw-mm-canvas__svg" width={layout.world.w} height={layout.world.h} aria-hidden="true" focusable="false">
            {layout.rings.map((r) => (
              <circle key={r} className="fw-mm-ring" cx={layout.center.x} cy={layout.center.y} r={r} />
            ))}
            {routes.map((r) => {
              const to = byId.get(r.to);
              const edge = layout.edges.find((e) => e.id === r.id);
              if (!to || !edge) return null;
              const onPath = selectedPath.has(r.from) && selectedPath.has(r.to);
              return (
                <path
                  key={r.id}
                  className="fw-mm-edge"
                  data-edge={r.id}
                  data-from={r.from}
                  data-to={r.to}
                  data-group={groupForBranch(to.branch)}
                  data-tree={edge.tree ? 'true' : 'false'}
                  data-on-path={onPath ? 'true' : 'false'}
                  d={r.d}
                />
              );
            })}
          </svg>
          {layout.nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              className="fw-mm-node"
              data-kind={n.kind}
              data-group={groupForBranch(n.branch)}
              data-orphan={n.orphan ? 'true' : 'false'}
              data-on-path={selectedPath.has(n.id) && n.id !== selectedId ? 'true' : 'false'}
              aria-pressed={n.id === selectedId}
              title={n.label}
              style={{ left: n.x - n.w / 2, top: n.y - n.h / 2, width: n.w, height: n.h }}
              onClick={() => onSelect(n.id)}
              onFocus={() => revealNode(n)}
            >
              <span className="fw-mm-node__dot" aria-hidden="true" />
              <span className="fw-mm-node__label">{n.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="fw-mm-canvas__controls" role="toolbar" aria-label={t('rd.map.zoom')}>
        <IconButton icon="Minus" label={t('rd.map.zoomOut')} size="sm" onClick={() => zoomAt(1 / ZOOM_STEP, undefined, undefined, true)} />
        <span className="fw-mm-canvas__zoom" aria-live="polite">{Math.round(view.k * 100)}%</span>
        <IconButton icon="Plus" label={t('rd.map.zoomIn')} size="sm" onClick={() => zoomAt(ZOOM_STEP, undefined, undefined, true)} />
        <IconButton icon="Maximize" label={t('rd.map.zoomFit')} size="sm" onClick={fit} />
      </div>
    </div>
  );
}

export default MindMapCanvas;
