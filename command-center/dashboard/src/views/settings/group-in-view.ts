/**
 * group-in-view — the Settings scroll-spy (moved out of SettingsView.tsx; Q7-SETTINGS item 4).
 *
 * The group list marks the group the person is reading. The old rule ("the topmost group in the reading band")
 * marked Algemeen while only its last few pixels were left at the top and Accounts ("Je accounts", "Als je limiet
 * op is") filled the view (frames at 768 and 1280). Now the group that crosses the reading line wins: a line
 * about a third down the scroll area. At the very end of the page the last group that shows is marked, since a
 * short last group never reaches that line. Without layout (jsdom: every box is 0 high) the old band rule stays.
 */

import { useEffect } from 'react';

import type { GroupId } from './settings-model';

export interface GroupBox {
  readonly id: string;
  /** Reported in the band by the IntersectionObserver (the only signal without layout). */
  readonly inBand: boolean;
  /** Viewport coordinates of the group's box. */
  readonly top: number;
  readonly bottom: number;
}

export interface ViewBox {
  /** Viewport top and height of the scroll area. */
  readonly top: number;
  readonly height: number;
  /** The scroll area is scrolled to its end. */
  readonly atEnd: boolean;
}

/** Below the sticky page head; at least this far down the scroll area. */
const LINE_MIN_PX = 64;
const LINE_SHARE = 0.3;

/** The id of the group to mark, or null when none qualifies. Pure: the hook below feeds it measured boxes. */
export function pickGroupInView(groups: readonly GroupBox[], view: ViewBox): string | null {
  const laidOut = view.height > 0 && groups.some((group) => group.bottom > group.top);
  if (!laidOut) return groups.find((group) => group.inBand)?.id ?? null;
  const viewBottom = view.top + view.height;
  if (view.atEnd) {
    const shown = groups.filter((group) => group.bottom > group.top && group.top < viewBottom && group.bottom > view.top);
    if (shown.length > 0) return shown[shown.length - 1].id;
  }
  const line = view.top + Math.max(LINE_MIN_PX, view.height * LINE_SHARE);
  // The last group that has started above the line: the one crossing it, or (in the gap between two) the one just read.
  const started = groups.filter((group) => group.bottom > group.top && group.top <= line);
  if (started.length > 0) return started[started.length - 1].id;
  return groups.find((group) => group.bottom > group.top)?.id ?? null;
}

/** Keys that scroll the page; pressing one hands the mark back to the scroll-spy. */
const SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']);

function measure(inBand: ReadonlyMap<Element, boolean>, root: HTMLElement | null): string | null {
  const nodes = Array.from(document.querySelectorAll('.fs-set__group'));
  const groups: GroupBox[] = nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { id: node.getAttribute('data-group') ?? '', inBand: inBand.get(node) === true, top: box.top, bottom: box.bottom };
  });
  const rootBox = root ? root.getBoundingClientRect() : { top: 0, height: window.innerHeight };
  // The shell scrolls #fw-main; a page without that shell scrolls the document.
  const scroller = root && root.scrollHeight > root.clientHeight ? root : document.scrollingElement;
  // jsdom has no scrollingElement (undefined), so test for any value.
  const atEnd = Boolean(scroller) && scroller !== null && scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  return pickGroupInView(groups, { top: rootBox.top, height: rootBox.height, atEnd });
}

/**
 * Scroll-spy: the list marks the group on the reading line (see `pickGroupInView`). A group chosen in the list
 * stays marked (`pinned`) until the person scrolls themselves. Releasing the pin rebuilds the observer, whose
 * first report marks the group in view again. Skipped where IntersectionObserver does not exist (jsdom).
 */
export function useGroupInView(
  groupKey: string,
  setActive: (id: GroupId) => void,
  pinned: GroupId | null,
  setPinned: (id: GroupId | null) => void,
): void {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const root = document.getElementById('fw-main');
    // The observer reports only what changed: keep the whole picture.
    const inBand = new Map<Element, boolean>();
    const update = () => {
      if (pinned !== null) return;
      const id = measure(inBand, root);
      if (id) setActive(id as GroupId);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) inBand.set(entry.target, entry.isIntersecting);
        update();
      },
      { root, rootMargin: '-64px 0px -60% 0px' },
    );
    document.querySelectorAll('.fs-set__group').forEach((node) => observer.observe(node));
    // The band only reports crossings; the reading line moves with every scroll.
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    // Scroll does not bubble: listen in the capture phase so whichever element scrolls is heard.
    const scrollOptions = { capture: true, passive: true } as const;
    document.addEventListener('scroll', onScroll, scrollOptions);
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      document.removeEventListener('scroll', onScroll, scrollOptions);
      window.removeEventListener('resize', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [groupKey, setActive, pinned]);

  useEffect(() => {
    if (pinned === null) return undefined;
    const release = () => setPinned(null);
    const releaseOnKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) release();
    };
    // pointerdown also covers dragging the scroll bar; a click in the list pins again right after it.
    const options = { capture: true, passive: true } as const;
    document.addEventListener('wheel', release, options);
    document.addEventListener('touchmove', release, options);
    document.addEventListener('pointerdown', release, options);
    document.addEventListener('keydown', releaseOnKey, options);
    return () => {
      document.removeEventListener('wheel', release, options);
      document.removeEventListener('touchmove', release, options);
      document.removeEventListener('pointerdown', release, options);
      document.removeEventListener('keydown', releaseOnKey, options);
    };
  }, [pinned, setPinned]);
}
