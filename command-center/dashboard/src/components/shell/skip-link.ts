/**
 * "Skip to content" without touching the route.
 *
 * A plain `href="#fw-main"` changes `location.hash`, which the HashRouter reads as the path
 * `fw-main` and redirects to Home. This handler stops that navigation and moves focus (and the
 * scroll position) to the main landmark instead. Enter on a focused link fires `click`, so one
 * handler covers mouse and keyboard.
 */

export const MAIN_ID = 'fw-main';

export function skipToMain(event: { preventDefault: () => void }): void {
  event.preventDefault();
  const main = document.getElementById(MAIN_ID);
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus();
  if (typeof main.scrollIntoView === 'function') main.scrollIntoView({ block: 'start' });
}
