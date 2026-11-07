/**
 * Forge Systeem — the sidebar (redesign 1C, DESIGN.md §2).
 *
 * Top to bottom: the lockup and the collapse button, "Nieuw gesprek" with the accent struck tile, the
 * Eenvoudig entries (Start, Mijn projecten with a `+` "Nieuw project", Gesprekken), the Uitgebreid
 * screens under a hairline, Recent (the last 5 conversations), and the foot: Leer Forge with its
 * progress, Instellingen and the Forge line (is Forge on this pc reachable: a word plus a dot, never a dot alone;
 * its own words, never the account word "Verbonden").
 *
 * Every action is real: "Nieuw gesprek" drives `POST /api/conversations` (./gateway-actions), the `+`
 * opens `NewProjectDialog` (`POST /api/projects`), and a Recent row can be deleted through the confirm
 * dialog (`DELETE`). The project lists, pins and the search field left the sidebar; Mijn projecten
 * (part 2B) carries them. The nav model lives in ./nav-config.
 */

import { useCallback, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { Icon, IconButton, Mark } from '@/components/primitives';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import type { Conversation } from '@/prototype/types/prototype-types';
import { isProductionMode } from '@/config/mode';
// `tNow` reads the locale at call time: used inside memoized callbacks so they need no locale
// dependency. Render-time text uses the hook's `t`.
import { t as tNow } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { useUiMode } from '@/state/ui-mode';
// WP7b: the real gateway connection, not the intentionally-unused bridge one.
import { useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';
import type { ConnectionStatus } from '@/prototype/state/bridge-client';

import { pollProjectInstall, requestNewConversation } from './gateway-actions';
import { ConfirmDeleteConversationDialog } from './ConfirmDeleteConversationDialog';
import { NewProjectDialog } from './NewProjectDialog';
import { sidebarSectionsFor } from './nav-config';
import type { ShellNavItem } from './nav-config';
import { useLearnProgressLabel } from './learn-progress';
import './sidebar.css';

/** How many conversations Recent shows (DESIGN.md §2). */
const RECENT_LIMIT = 5;

type ConnectionWord = 'ok' | 'busy' | 'warn' | 'off' | 'example';

interface AccountState {
  readonly tone: ConnectionWord;
  readonly wordKey: MessageKey;
}

/** The Forge line's word and dot (the local gateway, not an account), from the live connection (or the honest example word). */
function accountState(production: boolean, status: ConnectionStatus): AccountState {
  if (!production) return { tone: 'example', wordKey: 'rd.states.example' };
  switch (status) {
    case 'CONNECTED':
      return { tone: 'ok', wordKey: 'rd.nav.connConnected' };
    case 'CONNECTING':
      return { tone: 'busy', wordKey: 'rd.nav.connConnecting' };
    case 'DEGRADED':
      return { tone: 'warn', wordKey: 'rd.nav.connDegraded' };
    case 'DISCONNECTED':
    default:
      return { tone: 'off', wordKey: 'rd.nav.connDisconnected' };
  }
}

/** Up/Down walk the links of one nav list; Home/End jump. Tab still works normally. */
function handleNavKeys(event: ReactKeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>('a.fw-side__link'));
  if (links.length === 0) return;
  const current = links.indexOf(document.activeElement as HTMLAnchorElement);
  let next = current;
  if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % links.length;
  if (event.key === 'ArrowUp') next = current < 0 ? links.length - 1 : (current - 1 + links.length) % links.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = links.length - 1;
  event.preventDefault();
  links[next]?.focus();
}

export default function Sidebar() {
  const { mode: uiMode } = useUiMode();
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const location = useLocation();
  // Also re-renders the nav on a locale switch: its labels are resolved at read time.
  const { t } = useLocale();
  const connection = useConnection();
  const learnProgress = useLearnProgressLabel();

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // The confirm dialog's target, and a local optimistic overlay: a real `DELETE` already succeeded by
  // the time an id lands here; this only hides the row before the next conversations poll.
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [hiddenConversationIds, setHiddenConversationIds] = useState<ReadonlySet<string>>(new Set());

  const collapsed = state.sidebarCollapsed;
  const sections = sidebarSectionsFor(uiMode);
  const account = accountState(isProductionMode(), connection.status);

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  const recent = useMemo<readonly Conversation[]>(
    () => state.data.conversations.filter((c) => !hiddenConversationIds.has(c.id)).slice(0, RECENT_LIMIT),
    [state.data.conversations, hiddenConversationIds],
  );

  // A Recent row breathes only while its conversation is really streaming (the store's live stream).
  const liveConversationId = state.stream && !state.stream.done ? state.stream.conversationId : null;

  const closeDrawer = () => dispatch({ type: 'drawer/set', open: false });

  function openConversation(conversation: Conversation) {
    dispatch({ type: 'conversation/activate', id: conversation.id });
    dispatch({ type: 'project/activate', id: conversation.projectId });
    navigate('/chat');
    closeDrawer();
  }

  /** Starts a real conversation via `POST /api/conversations` and opens it. */
  const startNewChat = useCallback(async () => {
    const result = await requestNewConversation(state.activeProjectId);
    if (!result.ok || result.id === null) {
      toast(tNow('shell.sidebar.newChatFailed'), result.error ?? tNow('shell.sidebar.newChatFailedDetail'), 'TriangleAlert');
      return;
    }
    dispatch({ type: 'conversation/activate', id: result.id });
    navigate('/chat');
    dispatch({ type: 'drawer/set', open: false });
  }, [state.activeProjectId, dispatch, navigate, toast]);

  /**
   * Opens the just-created project and toasts an honest "installing" status; `pollProjectInstall`
   * then toasts the REAL terminal outcome exactly once (build-async-install).
   */
  const handleProjectCreated = useCallback(
    (id: string) => {
      setNewProjectOpen(false);
      dispatch({ type: 'project/activate', id });
      navigate('/project');
      dispatch({ type: 'drawer/set', open: false });
      toast(tNow('shell.sidebar.projectCreated'), tNow('shell.sidebar.forgeInstalling'), 'Loader');
      pollProjectInstall(id, (result) => {
        const installed = result.state === 'installed';
        toast(
          installed ? tNow('shell.sidebar.forgeInstalled') : tNow('shell.sidebar.forgeInstallFailed'),
          installed
            ? tNow('shell.sidebar.forgeInstalledDetail', { id })
            : (result.reason ?? result.note ?? tNow('shell.sidebar.forgeInstallFailedDetail')),
          installed ? 'CircleCheck' : 'TriangleAlert',
        );
      });
    },
    [dispatch, navigate, toast, setNewProjectOpen],
  );

  function renderLink(item: ShellNavItem, trailing?: string) {
    return (
      <NavLink
        to={item.path}
        end={item.path === '/'}
        className="fw-side__link"
        title={collapsed ? item.label : item.description}
        onClick={closeDrawer}
      >
        <Icon name={item.icon} size="md" className="fw-side__icon" />
        <span className="fw-side__label fw-side__text">{item.label}</span>
        {trailing ? <span className="fw-side__label fw-side__count">{trailing}</span> : null}
      </NavLink>
    );
  }

  function renderMainItem(item: ShellNavItem) {
    if (item.path !== '/projects') return <li key={item.path}>{renderLink(item)}</li>;
    // DESIGN.md §2: "Nieuw project" is a small + beside Mijn projecten, shown on hover and focus.
    return (
      <li key={item.path} className="fw-side__with-action" data-tour="projects">
        {renderLink(item)}
        <IconButton
          className="fw-side__row-action fw-side__label"
          icon="Plus"
          label={t('shell.sidebar.newProject')}
          size="sm"
          onClick={() => setNewProjectOpen(true)}
        />
      </li>
    );
  }

  return (
    // One labelled region around the whole sidebar (axe 'region'): the brand word, Nieuw gesprek and the account
    // line sit inside a landmark too, not only the four lists. A region, not an <aside>: the Details pane is the
    // page's one complementary landmark.
    <div className="fw-side" role="region" aria-label={t('rd.nav.sidebarLabel')} data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="fw-side__top">
        <NavLink to="/" end className="fw-side__lockup" title={t('shell.sidebar.brandTitle')} onClick={closeDrawer}>
          <Mark size={26} className="fw-side__mark" />
          <span className="fw-side__label fw-side__word">
            <b>Forge</b>
            <span className="fw-side__word-sub"> Systeem</span>
          </span>
        </NavLink>
        <span className="fw-side__top-tools">
          <IconButton
            className="fw-side__collapse"
            icon="PanelLeft"
            label={collapsed ? t('shell.sidebar.expandRail') : t('shell.sidebar.collapseRail')}
            title={collapsed ? t('shell.sidebar.expandRailHint') : t('shell.sidebar.collapseRailHint')}
            size="sm"
            onClick={() => dispatch({ type: 'sidebar/toggle' })}
          />
          <IconButton
            className="fw-side__drawer-close"
            icon="X"
            label={t('shell.sidebar.closeDrawer')}
            size="sm"
            onClick={closeDrawer}
          />
        </span>
      </div>

      <button type="button" className="fw-side__new-chat" onClick={() => void startNewChat()} title={t('rd.nav.newChat')}>
        <span className="fw-side__tile" aria-hidden="true">
          <Icon name="Plus" size="sm" />
        </span>
        <span className="fw-side__label">{t('rd.nav.newChat')}</span>
      </button>

      <div className="fw-side__scroll">
        <nav className="fw-side__nav" aria-label={t('nav.primaryLabel')} onKeyDown={handleNavKeys}>
          <ul className="fw-side__list">{sections.main.map(renderMainItem)}</ul>
        </nav>

        {/* Recent sits above the Uitgebreid screens so it stays in view at 1440x900 (review F3). */}
        {recent.length > 0 ? (
          <div className="fw-side__recent fw-side__label">
            <p className="fw-side__heading" aria-hidden="true">
              {t('rd.nav.recent')}
            </p>
            <nav aria-label={t('rd.nav.recentLabel')}>
              <ul className="fw-side__list">
                {recent.map((conversation) => {
                  const live = conversation.id === liveConversationId;
                  // Current only while the chat is the page on screen, never on Start or elsewhere.
                  const active = location.pathname === '/chat' && conversation.id === state.activeConversationId;
                  return (
                    <li key={conversation.id} className="fw-side__crow">
                      <NavLink
                        to="/chat"
                        className={active ? 'fw-side__clink is-current' : 'fw-side__clink'}
                        aria-current={active ? 'page' : undefined}
                        data-live={live ? 'true' : undefined}
                        title={conversation.title}
                        onClick={() => openConversation(conversation)}
                      >
                        <span className="fw-side__ctitle">{conversation.title}</span>
                        {live ? <span className="fw-side__live" aria-hidden="true" /> : null}
                      </NavLink>
                      <IconButton
                        className="fw-side__row-action"
                        icon="Trash2"
                        label={t('shell.sidebar.deleteConversation', { title: conversation.title })}
                        size="sm"
                        onClick={() => setDeleteTarget(conversation)}
                      />
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
        ) : null}

        {sections.advanced.length > 0 ? (
          <nav className="fw-side__nav fw-side__nav--more" aria-label={t('rd.nav.advancedLabel')} onKeyDown={handleNavKeys}>
            <ul className="fw-side__list">
              {sections.advanced.map((item) => (
                <li key={item.path}>{renderLink(item)}</li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>

      <div className="fw-side__foot">
        <nav className="fw-side__nav" aria-label={t('rd.nav.footLabel')} onKeyDown={handleNavKeys}>
          <ul className="fw-side__list">
            {sections.foot.map((item) => (
              <li key={item.path}>{renderLink(item, item.path === '/learn' ? learnProgress : undefined)}</li>
            ))}
          </ul>
        </nav>
        <NavLink
          to="/settings"
          className="fw-side__who"
          title={`${t('rd.nav.gatewayName')} · ${t(account.wordKey)}. ${t('rd.nav.gatewayTitle')}`}
          onClick={closeDrawer}
        >
          <span className="fw-side__avatar" aria-hidden="true">
            <Icon name="Monitor" size="sm" />
          </span>
          <span className="fw-side__label fw-side__who-name">{t('rd.nav.gatewayName')}</span>
          <span className="fw-side__label fw-side__who-word">{t(account.wordKey)}</span>
          <span className="fw-side__dot" data-tone={account.tone} aria-hidden="true" />
        </NavLink>
      </div>

      <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreated={handleProjectCreated} />

      <ConfirmDeleteConversationDialog
        open={deleteTarget !== null}
        conversationId={deleteTarget?.id ?? ''}
        conversationTitle={deleteTarget?.title ?? ''}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(id) =>
          setHiddenConversationIds((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          })
        }
      />
    </div>
  );
}
