/**
 * TourHost — the 3-stop guided tour (DESIGN.md §3.1, redesign 2D).
 *
 * Mounted once inside the router (by `FirstRunRedirect`, which App.tsx always renders). On mount it
 * registers its replay handler with the shell (`onTourReplay`), which is what makes "Rondleiding
 * opnieuw" appear under `?` (the shell counts registrations). It shows the tour:
 *   - when onboarding left a 'pending' request ("Laat me rondkijken"), or
 *   - when a replay is requested (`?` > Rondleiding opnieuw, Instellingen > Algemeen).
 * It never shows itself otherwise. Finishing or skipping (Overslaan, Escape) stores 'seen'.
 *
 * Each stop is one `CoachMark` (focus moves into the card, Tab stays inside, Esc = Overslaan). The
 * anchors are `[data-tour="composer|projects|help"]`; when one is missing or not visible (a collapsed
 * drawer on a narrow window) the card is centred instead of pointing at nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { CoachMark } from '@/components/primitives';
import { onTourReplay } from '@/components/shell/shell-events';
import { useLocale } from '@/i18n/use-locale';

import { markTourSeen, readTourMemory, TOUR_STOPS } from './tour-state';

/** How long a stop waits for its anchor to appear (a lazy route, a sidebar that slides in). */
const ANCHOR_WAIT_FRAMES = 90;

function findAnchor(name: string): HTMLElement | null {
  const node = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? node : null;
}

export function TourHost() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  // A 'pending' request from onboarding ("Laat me rondkijken") opens the tour on mount.
  const [step, setStep] = useState<number | null>(() => (readTourMemory() === 'pending' ? 0 : null));
  // The anchor found for a stop; it belongs to that stop only, so a new stop waits for its own.
  const [found, setFound] = useState<{ readonly step: number; readonly anchor: HTMLElement | null } | null>(null);
  const pathRef = useRef(location.pathname);

  useEffect(() => {
    pathRef.current = location.pathname;
  }, [location.pathname]);

  // The first stop is the composer on Start: an open tour on another page goes there first.
  const opened = step !== null;
  useEffect(() => {
    if (opened && pathRef.current !== '/') navigate('/');
  }, [opened, navigate]);

  // Register with the shell; the count of registrations is what shows "Rondleiding opnieuw".
  useEffect(() => onTourReplay(() => setStep(0)), []);

  // Resolve the anchor of the current stop, waiting a few frames for it to mount.
  useEffect(() => {
    if (step === null) return undefined;
    const name = TOUR_STOPS[step].anchor;
    let frames = 0;
    let handle = 0;
    let cancelled = false;
    const look = () => {
      if (cancelled) return;
      const node = findAnchor(name);
      if (node || frames >= ANCHOR_WAIT_FRAMES || typeof window.requestAnimationFrame !== 'function') {
        setFound({ step, anchor: node });
        return;
      }
      frames += 1;
      handle = window.requestAnimationFrame(look);
    };
    // The first look waits one tick, so the route the tour just opened has rendered.
    const timer = window.setTimeout(look, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.cancelAnimationFrame?.(handle);
    };
  }, [step]);

  const close = useCallback(() => {
    markTourSeen();
    setStep(null);
    setFound(null);
  }, []);

  const next = useCallback(() => {
    setStep((current) => {
      if (current === null) return null;
      if (current >= TOUR_STOPS.length - 1) {
        markTourSeen();
        setFound(null);
        return null;
      }
      return current + 1;
    });
  }, []);

  const ready = step !== null && found?.step === step;
  const anchor = ready ? found.anchor : null;

  if (step === null || !ready) return null;
  const stop = TOUR_STOPS[step];
  const last = step === TOUR_STOPS.length - 1;

  return (
    <CoachMark
      key={step}
      open
      anchor={anchor}
      step={step}
      total={TOUR_STOPS.length}
      stepLabel={t('rd.tour.card.step', { n: step + 1, total: TOUR_STOPS.length })}
      title={'catalog' in stop.title ? t(stop.title.catalog) : t(stop.title.shell)}
      body={t(stop.body)}
      nextLabel={last ? t('rd.tour.done') : t('rd.tour.next')}
      skipLabel={t('rd.tour.skip')}
      onNext={next}
      onSkip={close}
      className="fw-tour"
    />
  );
}

export default TourHost;
