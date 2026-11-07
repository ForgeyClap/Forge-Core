/**
 * CoachMark — one stop of the guided tour (DESIGN.md §3.1 "Guided tour").
 *
 * A scrim covers the screen except the spot, which gets a 2 px Pauw ring. The card has a
 * step label, a title, one line, dots, Overslaan and Volgende.
 *
 * Contract (tested in tests/unit/redesign-coachmark.test.tsx):
 *   role="dialog", aria-modal, labelled by its title and described by its line
 *   focus moves to the card on open and returns to the opener when it closes
 *   Tab and Shift+Tab stay inside the card
 *   Escape = Overslaan (onSkip)
 *
 * Whether the tour is shown at all (once, never forced, replay from ? and Instellingen)
 * belongs to the tour controller (part 2D); this primitive only renders one stop.
 * All words arrive as props (rd.tour.* keys). Motion: the card fades and rises (opacity +
 * transform), nothing under reduced motion.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
/** Space between the spot and the card, and the ring inset around the anchor. */
const GAP = 14;
const RING = 6;
const CARD_WIDTH = 300;
const EDGE = 12;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface CoachMarkProps {
  open: boolean;
  /** The element the stop points at. Without one, the card is centred and nothing is lit. */
  anchor?: HTMLElement | null;
  /** e.g. "Rondleiding 1 van 3". */
  stepLabel: string;
  /** 0-based index of this stop, for the dots. */
  step: number;
  total: number;
  title: ReactNode;
  body: ReactNode;
  /** e.g. "Volgende", or "Klaar" on the last stop. */
  nextLabel: string;
  /** e.g. "Overslaan". */
  skipLabel: string;
  onNext: () => void;
  /** Overslaan, Escape. */
  onSkip: () => void;
  className?: string;
}

function measure(anchor: HTMLElement | null | undefined): Box | null {
  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export function CoachMark({
  open,
  anchor,
  stepLabel,
  step,
  total,
  title,
  body,
  nextLabel,
  skipLabel,
  onNext,
  onSkip,
  className,
}: CoachMarkProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef(onSkip);
  const titleId = useId();
  const bodyId = useId();
  const [box, setBox] = useState<Box | null>(() => measure(anchor));
  const [cardHeight, setCardHeight] = useState(180);

  useEffect(() => {
    skipRef.current = onSkip;
  }, [onSkip]);

  // Follow the anchor through resizes and scrolls.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => {
      setBox(measure(anchor));
      if (cardRef.current) setCardHeight(cardRef.current.offsetHeight || 180);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchor, step]);

  // Focus in, trap, Escape, focus back out.
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      const card = cardRef.current;
      if (!card) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        skipRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement;
      if (!card.contains(active) || active === card) {
        event.preventDefault();
        (event.shiftKey ? tail : head).focus();
      } else if (event.shiftKey && active === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && active === tail) {
        event.preventDefault();
        head.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;

  const viewportW = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight;

  let cardTop = viewportH / 2 - cardHeight / 2;
  let cardLeft = viewportW / 2 - CARD_WIDTH / 2;
  let side: 'below' | 'above' | 'none' = 'none';
  let arrowLeft = 32;

  if (box) {
    const below = box.top + box.height + RING + GAP;
    side = below + cardHeight <= viewportH - EDGE ? 'below' : 'above';
    cardTop = side === 'below' ? below : box.top - RING - GAP - cardHeight;
    cardLeft = Math.min(Math.max(box.left, EDGE), viewportW - CARD_WIDTH - EDGE);
    // Point the arrow at the anchor's left part (or its centre when it is narrow).
    const target = box.width < 120 ? box.left + box.width / 2 : box.left + 40;
    arrowLeft = Math.min(Math.max(target - cardLeft - 7, 16), CARD_WIDTH - 30);
  }

  const classes = ['fw-coach'];
  if (className) classes.push(className);

  return createPortal(
    <div className="fw-coach-layer">
      {box ? (
        <div
          className="fw-coach-spot"
          aria-hidden="true"
          style={{
            top: box.top - RING,
            left: box.left - RING,
            width: box.width + RING * 2,
            height: box.height + RING * 2,
          }}
        />
      ) : (
        <div className="fw-coach-scrim" aria-hidden="true" />
      )}
      <div
        ref={cardRef}
        className={classes.join(' ')}
        data-side={side}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        style={{ top: cardTop, left: cardLeft, width: CARD_WIDTH, ['--fw-coach-arrow' as string]: `${arrowLeft}px` }}
      >
        <p className="fw-coach__step">{stepLabel}</p>
        <h2 id={titleId} className="fw-coach__title">
          {title}
        </h2>
        <p id={bodyId} className="fw-coach__body">
          {body}
        </p>
        <div className="fw-coach__row">
          <span className="fw-coach__dots" aria-hidden="true">
            {Array.from({ length: total }, (_, index) => (
              <i key={index} className={index === step ? 'is-on' : undefined} />
            ))}
          </span>
          <Button variant="quiet" size="sm" onClick={() => skipRef.current()}>
            {skipLabel}
          </Button>
          <Button variant="primary" size="sm" onClick={onNext}>
            {nextLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
