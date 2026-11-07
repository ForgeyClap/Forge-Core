/**
 * Bar — the transparent 56 px bar above every page (DESIGN.md §2). It replaces the old Topbar.
 *
 * Left: the drawer button (narrow windows only), then the conversation title and its project chip in a
 * chat. Every other page draws its own heading, so the bar stays empty there.
 * Right: "Wacht op jou" when something waits, `...` (Uitgebreid only: Details tonen, Opdrachten zoeken)
 * and `?` (the lesson for this page, Rondleiding opnieuw, Sneltoetsen).
 *
 * What left the bar, and where it went (DESIGN.md "Removed from the always-visible chrome"): the search
 * pill (Ctrl+K still opens the palette and is listed under Sneltoetsen), the theme control and density
 * (Instellingen > Algemeen, part 2C), the dock and inspector toggles (`...` > Details tonen) and the
 * Claude Code chip (the account line in the sidebar foot).
 */

import { NavLink, useLocation } from 'react-router-dom';

import { Icon, IconButton } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { selectActiveProject, usePrototype } from '@/prototype/state/prototype-store';
import { useUiMode } from '@/state/ui-mode';

import { requestTourReplay, useTourReplayAvailable } from './shell-events';
import { setHelpView } from './side-pane';
import { ShellMenu } from './ShellMenu';
import type { ShellMenuItem } from './ShellMenu';
import { WaitingChip } from './WaitingChip';
import './bar.css';

function BarIdentity() {
  const { state } = usePrototype();
  const location = useLocation();
  const path = location.pathname;

  if (path === '/chat') {
    const conversation = state.data.conversations.find((c) => c.id === state.activeConversationId);
    const project = selectActiveProject(state);
    if (!conversation && !project) return null;
    return (
      <div className="fw-bar__identity">
        {conversation ? <p className="fw-bar__title">{conversation.title}</p> : null}
        {project ? (
          <NavLink to="/project" className="fw-bar__chip" title={project.name}>
            <Icon name="Folder" size="sm" className="fw-bar__chip-icon" />
            <span className="fw-bar__chip-text">{project.name}</span>
          </NavLink>
        ) : null}
      </div>
    );
  }

  // Every other page draws its own heading (DESIGN.md §2: "nothing on pages that have their own
  // title"), so the bar stays empty there instead of repeating it.
  return null;
}

export default function Bar() {
  const { state, dispatch } = usePrototype();
  const { isAdvanced } = useUiMode();
  // Re-renders on a locale switch: the shell copy and nav labels are read at render time.
  const { t } = useLocale();
  // "Rondleiding opnieuw" only shows while a tour listens for it (part 2D mounts the tour).
  const canReplayTour = useTourReplayAvailable();

  const tourItems: readonly ShellMenuItem[] = canReplayTour
    ? [{ id: 'tour', label: t('rd.tour.replay'), icon: 'RotateCcw', onSelect: requestTourReplay }]
    : [];

  const helpItems: readonly ShellMenuItem[] = [
    {
      id: 'lesson',
      label: t('rd.bar.helpLesson'),
      icon: 'BookOpen',
      onSelect: () => {
        dispatch({ type: 'inspector/set', open: false });
        setHelpView('lesson');
      },
    },
    ...tourItems,
    {
      id: 'shortcuts',
      label: t('rd.bar.shortcuts'),
      icon: 'Keyboard',
      onSelect: () => {
        dispatch({ type: 'inspector/set', open: false });
        setHelpView('shortcuts');
      },
    },
  ];

  const pageItems: readonly ShellMenuItem[] = [
    {
      id: 'details',
      label: state.inspectorOpen ? t('rd.bar.hideDetails') : t('rd.bar.showDetails'),
      icon: 'PanelRight',
      onSelect: () => {
        setHelpView('closed');
        dispatch({ type: 'inspector/set', open: !state.inspectorOpen });
      },
    },
    {
      id: 'palette',
      label: t('rd.bar.searchCommands'),
      icon: 'Search',
      hint: 'Ctrl K',
      onSelect: () => dispatch({ type: 'palette/set', open: true }),
    },
  ];

  return (
    <header className="fw-bar">
      <IconButton
        className="fw-bar__drawer"
        icon="PanelLeft"
        label={t('shell.topbar.openNav')}
        size="sm"
        onClick={() => dispatch({ type: 'drawer/set', open: true })}
      />

      <BarIdentity />

      <div className="fw-bar__end">
        <WaitingChip />
        {isAdvanced ? <ShellMenu label={t('rd.bar.more')} icon="Ellipsis" items={pageItems} /> : null}
        <ShellMenu label={t('rd.bar.helpButton')} icon="CircleHelp" items={helpItems} tourAnchor="help" />
      </div>
    </header>
  );
}
