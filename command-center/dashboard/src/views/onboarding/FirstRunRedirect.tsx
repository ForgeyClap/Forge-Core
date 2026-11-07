/**
 * FirstRunRedirect — sends a first-time user to /onboarding (WP B6, plan §4.7). Renders no visible UI of its own.
 *
 * Mounted once inside the router by WP B4 (see _scratch/b6/patches.md). It only redirects when
 * there is no "onboarding done" flag AND the checkup answered AND Claude Code is not yet found and
 * signed in (`shouldStartOnboarding`). An existing, working install is marked done silently, so it
 * is never pushed into the wizard; a gateway that does not answer never triggers a redirect.
 *
 * It also mounts the tour host and the `?` lesson registration (redesign 2D), see the return below.
 */

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { fetchCheckup } from '@/components/checkup/checkup-model';
import { TourHost } from '@/components/tour/Tour';
import { HelpLessons } from '@/views/learn/HelpLessons';

import { isOnboardingDone, markOnboardingDone, shouldStartOnboarding } from './onboarding-model';

export function FirstRunRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current || isOnboardingDone() || location.pathname === '/onboarding') return;
    asked.current = true;
    let cancelled = false;
    void fetchCheckup().then((answer) => {
      if (cancelled || !answer.ok) return;
      if (shouldStartOnboarding(isOnboardingDone(), answer.result)) navigate('/onboarding');
      else if (answer.result.claude.found && answer.result.claude.signedIn === true) markOnboardingDone(null, null);
    });
    return () => {
      cancelled = true;
    };
  }, [location.pathname, navigate]);

  // App.tsx always renders this component inside the router, so it also hosts the two app-wide guides
  // of redesign 2D: the 3-stop tour (which registers "Rondleiding opnieuw" with the shell) and the
  // per-page lesson in the `?` side pane. Both render nothing until they are asked for.
  return (
    <>
      <TourHost />
      <HelpLessons />
    </>
  );
}
