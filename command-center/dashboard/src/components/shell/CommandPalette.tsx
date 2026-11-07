/**
 * CommandPalette — Ctrl+K / Cmd+K.
 *
 * Most commands move you somewhere in the workspace or dispatch a local store
 * action. "New conversation" is the one command that reaches the network: it
 * drives a real `POST /api/conversations` (see ./gateway-actions), the same
 * route Sidebar's "New chat" uses.
 *
 * Keyboard contract:
 *   Ctrl+K / Cmd+K  open            Escape  close
 *   /               open and focus  ↑ ↓     move        Enter  run
 *   Tab             held inside the dialog (focus stays on the search field)
 *
 * The global shortcut listener lives on the outer component and is removed on
 * unmount. The dialog itself only exists while the palette is open, so its
 * query and its cursor start clean every time it is raised.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Icon, KeyHint, Machine, Spacer } from '@/components/primitives';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import type { Appearance } from '@/prototype/types/prototype-types';
import { useLocale } from '@/i18n/use-locale';
import type { MessageKey } from '@/i18n';
import { useUiMode } from '@/state/ui-mode';
import { requestNewConversation } from './gateway-actions';
import { sidebarSectionsFor } from './nav-config';
import { setHelpView } from './side-pane';
import './command-palette.css';

/* ----------------------------------------------------------------- fuzzy */

/** Subsequence match with bonuses for word starts and consecutive hits. */
function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;

  let score = 0;
  let cursor = 0;
  let streak = 0;

  for (const char of q) {
    if (char === ' ') {
      streak = 0;
      continue;
    }
    const found = t.indexOf(char, cursor);
    if (found === -1) return -1;

    const previous = found > 0 ? t[found - 1] : ' ';
    const wordStart = found === 0 || previous === ' ' || previous === '-' || previous === '·';

    score += 10;
    if (wordStart) score += 8;
    if (found === cursor) {
      streak += 1;
      score += 4 + streak;
    } else {
      streak = 0;
      score -= Math.min(found - cursor, 6);
    }
    cursor = found + 1;
  }

  return score;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/* --------------------------------------------------------------- commands */

interface Command {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly detail?: string;
  readonly icon: string;
  /** Rendered as a KeyHint when the command has a real global shortcut. */
  readonly keys?: readonly string[];
  /** Detail is machine-recorded (an id), not prose. */
  readonly machineDetail?: boolean;
  readonly run: () => void;
}

interface Group {
  readonly name: string;
  readonly commands: readonly Command[];
}

/** Groups a ranked list, keeping the order the ranking produced. */
function groupCommands(commands: readonly Command[]): readonly Group[] {
  const order: string[] = [];
  const buckets = new Map<string, Command[]>();
  for (const command of commands) {
    const bucket = buckets.get(command.group);
    if (bucket) {
      bucket.push(command);
    } else {
      order.push(command.group);
      buckets.set(command.group, [command]);
    }
  }
  return order.map((name) => ({ name, commands: buckets.get(name) ?? [] }));
}

/** The theme words Instellingen uses, so the palette never names a theme differently. */
const APPEARANCE_WORD: Readonly<Record<Appearance, MessageKey>> = {
  light: 'rd.settings.general.light',
  dark: 'rd.settings.general.dark',
  system: 'rd.settings.general.system',
};

const APPEARANCE_ICON: Readonly<Record<Appearance, string>> = { light: 'Sun', dark: 'Moon', system: 'Monitor' };

/* ----------------------------------------------------------------- dialog */

function PaletteDialog() {
  const { state, dispatch } = usePrototype();
  const { t } = useLocale();
  const { mode, isAdvanced } = useUiMode();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const close = useCallback(() => dispatch({ type: 'palette/set', open: false }), [dispatch]);

  /** Local navigation only — HashRouter, same document, no request. */
  const go = useCallback((path: string) => navigate(path), [navigate]);

  const toast = useCallback(
    (title: string, detail: string, icon: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  const setAppearance = useCallback(
    (appearance: Appearance) => {
      dispatch({ type: 'appearance/set', appearance });
      toast(
        t('rd.palette.theme', { name: t(APPEARANCE_WORD[appearance]) }),
        t('rd.palette.themeSaved'),
        APPEARANCE_ICON[appearance],
      );
    },
    [dispatch, toast, t],
  );

  const projects = state.data.projects;
  const activeProjectId = state.activeProjectId;
  const inspectorOpen = state.inspectorOpen;

  const commands = useMemo<readonly Command[]>(() => {
    const list: Command[] = [];
    const groupProjects = t('rd.palette.groupProjects');
    const groupGo = t('rd.palette.groupGo');

    for (const project of projects) {
      list.push({
        id: `open-project-${project.id}`,
        group: groupProjects,
        title: t('rd.palette.openProject', { name: project.name }),
        // The project id is machine text: Uitgebreid only (Eenvoudig shows no machine text).
        ...(isAdvanced ? { detail: project.id, machineDetail: true } : {}),
        icon: 'FolderGit2',
        run: () => {
          dispatch({ type: 'project/activate', id: project.id });
          go('/project');
        },
      });
    }

    list.push({
      id: 'search-projects',
      group: groupProjects,
      title: t('shell.sidebar.searchProjects'),
      detail: t('rd.palette.searchProjectsDetail'),
      icon: 'Search',
      run: () => {
        dispatch({ type: 'project/query', query: '' });
        go('/projects');
      },
    });

    list.push({
      id: 'new-conversation',
      group: groupGo,
      title: t('rd.nav.newChat'),
      detail: t('rd.palette.newChatDetail'),
      icon: 'MessageSquarePlus',
      run: () => {
        void (async () => {
          const result = await requestNewConversation(activeProjectId);
          if (!result.ok || result.id === null) {
            toast(
              t('shell.sidebar.newChatFailed'),
              result.error ?? t('shell.sidebar.newChatFailedDetail'),
              'TriangleAlert',
            );
            return;
          }
          dispatch({ type: 'conversation/activate', id: result.id });
          go('/chat');
        })();
      },
    });

    // The screens themselves: exactly the ones the sidebar offers in this mode, by their current names.
    const sections = sidebarSectionsFor(mode);
    for (const item of [...sections.main, ...sections.advanced, ...sections.foot]) {
      list.push({
        id: `go-${item.path}`,
        group: groupGo,
        title: item.label,
        detail: item.description,
        icon: item.icon,
        run: () => go(item.path),
      });
    }

    for (const appearance of ['light', 'dark', 'system'] as const) {
      list.push({
        id: `theme-${appearance}`,
        group: t('rd.palette.groupAppearance'),
        title: t('rd.palette.theme', { name: t(APPEARANCE_WORD[appearance]) }),
        icon: APPEARANCE_ICON[appearance],
        run: () => setAppearance(appearance),
      });
    }

    list.push({
      id: 'toggle-sidebar',
      group: t('rd.palette.groupLayout'),
      title: t('rd.bar.shortcutSidebar'),
      icon: 'PanelLeft',
      keys: ['Ctrl', 'B'],
      run: () => dispatch({ type: 'sidebar/toggle' }),
    });

    // Uitgebreid's one side panel (the Details pane, which holds the old inspector and dock tabs), with the
    // same words and the same action as the bar's "Meer opties" menu.
    if (isAdvanced) {
      list.push({
        id: 'toggle-details',
        group: t('rd.palette.groupLayout'),
        title: inspectorOpen ? t('rd.bar.hideDetails') : t('rd.bar.showDetails'),
        icon: 'PanelRight',
        run: () => {
          setHelpView('closed');
          dispatch({ type: 'inspector/set', open: !inspectorOpen });
        },
      });
    }

    return list;
  }, [projects, activeProjectId, inspectorOpen, mode, isAdvanced, dispatch, go, toast, setAppearance, t]);

  const results = useMemo(() => {
    if (query.trim() === '') return commands;
    const scored = commands
      .map((command, index) => ({
        command,
        index,
        score: fuzzyScore(query, `${command.title} ${command.detail ?? ''} ${command.group}`),
      }))
      .filter((entry) => entry.score >= 0);
    scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
    return scored.map((entry) => entry.command);
  }, [commands, query]);

  const groups = useMemo(() => groupCommands(results), [results]);

  const runAt = useCallback(
    (index: number) => {
      const command = results[index];
      if (!command) return;
      close();
      command.run();
    },
    [results, close],
  );

  /* Escape closes from anywhere, even if focus slipped out of the dialog. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  /* Focus enters the field on open and returns to the opener on close. */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      opener?.focus();
    };
  }, []);

  /* Keep the active option in view while arrowing through a long list. */
  useEffect(() => {
    const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    options?.[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, results.length]);

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      // A single-field dialog: Tab must not walk out of it.
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, results.length - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runAt(active);
    }
  }

  const listId = `${baseId}-list`;
  const activeId = results.length > 0 ? `${baseId}-option-${active}` : undefined;
  let cursor = -1;

  return (
    <div className="fw-palette">
      <div className="fw-palette__scrim" onClick={close} aria-hidden="true" />

      <div
        className="fw-palette__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('rd.palette.label')}
        onKeyDown={onDialogKeyDown}
      >
        <div className="fw-palette__field">
          <Icon name="Command" size="sm" className="fw-palette__field-icon" />
          <input
            ref={inputRef}
            className="fw-palette__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={t('rd.bar.searchCommands')}
            placeholder={t('rd.palette.placeholder')}
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <KeyHint keys={['Esc']} />
        </div>

        <div className="fw-palette__list fw-scroll" id={listId} role="listbox" aria-label={t('rd.palette.list')} ref={listRef}>
          {results.length === 0 ? (
            <p className="fw-palette__empty">
              {t('rd.palette.empty')} <Machine>{query}</Machine>
            </p>
          ) : (
            groups.map((group) => {
              const headingId = `${baseId}-group-${group.name.replace(/\s+/g, '-').toLowerCase()}`;
              return (
                <div className="fw-palette__group" role="group" aria-labelledby={headingId} key={group.name}>
                  <div className="fw-palette__group-name fg-eyebrow" id={headingId}>
                    {group.name}
                  </div>
                  {group.commands.map((command) => {
                    cursor += 1;
                    const index = cursor;
                    const selected = index === active;
                    return (
                      <div
                        key={command.id}
                        id={`${baseId}-option-${index}`}
                        role="option"
                        aria-selected={selected}
                        className={selected ? 'fw-palette__option is-active' : 'fw-palette__option'}
                        onMouseMove={() => {
                          if (index !== active) setActive(index);
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => runAt(index)}
                      >
                        <Icon name={command.icon} size="sm" className="fw-palette__option-icon" />
                        <span className="fw-palette__option-title fw-truncate">{command.title}</span>
                        {command.detail ? (
                          command.machineDetail ? (
                            <Machine muted className="fw-palette__option-detail fw-truncate">
                              {command.detail}
                            </Machine>
                          ) : (
                            <span className="fw-palette__option-detail fw-truncate">{command.detail}</span>
                          )
                        ) : null}
                        {command.keys ? <KeyHint keys={command.keys} /> : null}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <footer className="fw-palette__foot">
          <span className="fw-palette__hint">
            <KeyHint keys={['↑', '↓']} /> {t('rd.palette.hintMove')}
          </span>
          <span className="fw-palette__hint">
            <KeyHint keys={['Enter']} /> {t('rd.palette.hintRun')}
          </span>
          <span className="fw-palette__hint">
            <KeyHint keys={['Esc']} /> {t('rd.palette.hintClose')}
          </span>
          <Spacer />
          <span className="fw-palette__honesty">{t('rd.palette.honesty')}</span>
        </footer>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- component */

export function CommandPalette() {
  const { state, dispatch } = usePrototype();
  const open = state.paletteOpen;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        // 'set open', never 'toggle': the shell listens for the same chord, and
        // two handlers agreeing on "open" is harmless where two toggles cancel.
        dispatch({ type: 'palette/set', open: true });
        return;
      }
      // '/' only reaches here when focus is not already in a text field, so it
      // still types normally inside the palette's own search input.
      if (event.key === '/' && !isEditable(event.target)) {
        event.preventDefault();
        dispatch({ type: 'palette/set', open: true });
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch]);

  if (!open) return null;

  return createPortal(<PaletteDialog />, document.body);
}

export default CommandPalette;
