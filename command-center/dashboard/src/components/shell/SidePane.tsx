/**
 * SidePane — the shell's one 340 px side pane (DESIGN.md §2, §3.2).
 *
 *   - Hulp (any mode): the lesson for this page (registered by part 2D through `registerHelpLesson`),
 *     or the shortcut list. With no lesson registered it says one line and links to Leer Forge.
 *   - Details (Uitgebreid only): today's Inspector ("Selectie") and Dock ("Logboek") as two tabs in one
 *     pane, so every old tab stays reachable while the always-visible chrome is gone.
 *
 * Help wins when both are asked for; the bar closes the other one when it opens one. Opening it from a
 * bar menu moves focus to its heading; Esc closes the pane and gives focus back to <main>.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { IconButton, KeyHint, TabPanel, Tabs } from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useUiMode } from '@/state/ui-mode';
import { useLocale } from '@/i18n/use-locale';

import { Dock } from './Dock';
import { Inspector } from './Inspector';
import { setHelpView, useHelpLessonRenderer, useHelpView } from './side-pane';
import './side-pane.css';

type DetailsTab = 'selection' | 'log';
type PaneKind = 'closed' | 'lesson' | 'shortcuts' | 'details';

const MAIN_ID = 'fw-main';

/** Focus is "loose" when nothing real holds it: <body>, the document itself, or <main> after a close. */
function focusIsLoose(active: Element | null): boolean {
  return !active || active === document.body || active === document.documentElement || active.id === MAIN_ID;
}

function HelpBody({ view }: { readonly view: 'lesson' | 'shortcuts' }) {
  const { t } = useLocale();
  const location = useLocation();
  const render = useHelpLessonRenderer();
  if (view === 'shortcuts') {
    const rows: readonly { keys: readonly string[]; label: string }[] = [
      { keys: ['Ctrl', 'K'], label: t('rd.bar.searchCommands') },
      { keys: ['Ctrl', 'B'], label: t('rd.bar.shortcutSidebar') },
      { keys: ['Esc'], label: t('rd.bar.shortcutClose') },
    ];
    return (
      <dl className="fw-pane__keys">
        {rows.map((row) => (
          <div key={row.label} className="fw-pane__key-row">
            <dt>
              <KeyHint keys={row.keys} />
            </dt>
            <dd>{row.label}</dd>
          </div>
        ))}
      </dl>
    );
  }
  const lesson = render ? render(location.pathname) : null;
  if (lesson) return <>{lesson}</>;
  return (
    <div className="fw-pane__fallback">
      <p>{t('rd.bar.helpFallback')}</p>
      <NavLink to="/learn" className="fw-pane__link" onClick={() => setHelpView('closed')}>
        {t('rd.bar.helpOpenLearn')}
      </NavLink>
    </div>
  );
}

export function SidePane() {
  const { state, dispatch } = usePrototype();
  const { isAdvanced } = useUiMode();
  const helpView = useHelpView();
  // Re-render on a locale switch: the shell copy is read at render time.
  const { t } = useLocale();
  const [tab, setTab] = useState<DetailsTab>('selection');
  const paneRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const showHelp = helpView !== 'closed';
  const showDetails = !showHelp && isAdvanced && state.inspectorOpen;
  const open = showHelp || showDetails;
  // What the pane shows; a change (closed -> Hulp, Hulp -> Sneltoetsen, closed -> Details) is an "open".
  const paneKind: PaneKind = showHelp ? helpView : showDetails ? 'details' : 'closed';

  const close = useCallback(() => {
    if (helpView !== 'closed') setHelpView('closed');
    else dispatch({ type: 'inspector/set', open: false });
    document.getElementById(MAIN_ID)?.focus();
  }, [helpView, dispatch]);

  // Opening the pane from a bar menu unmounts the menu item that had focus, so focus would fall to
  // <body>. The pane's heading takes it instead (DESIGN.md §7). Focus that sits somewhere real (a row
  // picked in a view, which also opens Details) is never pulled away.
  useEffect(() => {
    if (paneKind === 'closed') return;
    if (focusIsLoose(document.activeElement)) titleRef.current?.focus();
  }, [paneKind]);

  // Esc closes the pane (DESIGN.md §7) when focus is in it or nowhere in particular, unless a menu or
  // dialog handled the key first. Focus goes back to <main>.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = document.activeElement;
      if (!paneRef.current?.contains(active) && !focusIsLoose(active)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  if (!open) return null;

  const title = showHelp
    ? helpView === 'shortcuts'
      ? t('rd.bar.shortcuts')
      : t('rd.bar.help')
    : t('rd.bar.detailsTitle');

  return (
    <aside ref={paneRef} className="fw-pane" aria-label={title} data-kind={showHelp ? 'help' : 'details'}>
      <header className="fw-pane__head">
        <h2 ref={titleRef} className="fw-pane__title" tabIndex={-1}>
          {title}
        </h2>
        <IconButton icon="X" label={t('rd.bar.paneClose')} size="sm" onClick={close} />
      </header>

      {showHelp ? (
        <div className="fw-pane__body">
          <HelpBody view={helpView === 'shortcuts' ? 'shortcuts' : 'lesson'} />
        </div>
      ) : (
        <>
          <div className="fw-pane__tabs">
            <Tabs
              items={[
                { value: 'selection', label: t('rd.bar.detailsSelection') },
                { value: 'log', label: t('rd.bar.detailsLog') },
              ]}
              value={tab}
              onChange={(value) => setTab(value === 'log' ? 'log' : 'selection')}
              ariaLabel={t('rd.bar.detailsTitle')}
              idPrefix="fw-pane"
              size="sm"
            />
          </div>
          <TabPanel idPrefix="fw-pane" value={tab} active className="fw-pane__panel">
            {tab === 'selection' ? <Inspector embedded /> : <Dock embedded moreLabel={t('rd.bar.detailsMore')} />}
          </TabPanel>
        </>
      )}
    </aside>
  );
}

export default SidePane;
