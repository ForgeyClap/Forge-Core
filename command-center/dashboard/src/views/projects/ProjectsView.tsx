/**
 * Mijn projecten (DESIGN.md §3.3) — the project list.
 *
 * One title and one primary action ("Nieuw project"), then two quiet lists:
 * - "Wacht op jou", only while a conversation really waits on the owner. The signal is the gateway's
 *   own pending-ask list, which covers the ACTIVE project only (gateway-pending-asks.ts), so that is the
 *   only project this group can ever show. It never guesses a wait for another project.
 * - "Alle projecten": letter tile, name, a status word, a relative time and a chevron. Pinned projects
 *   come first; pinning and opening live in each row's `...` menu (the sidebar no longer has them).
 *
 * Search appears only above 8 projects (or while a query from elsewhere is still active, so it can be
 * cleared). Uitgebreid adds the measured counts per row and the app/Forge versions under the list.
 *
 * `state.data.projects` is real in production (read from this project's own gateway) and
 * fixture-labelled example data otherwise; the view itself cannot tell which.
 */

import '../jobs/xpage.css';
import './projects.css';

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Icon, IconButton, Machine, Meter } from '@/components/primitives';
import { ShellMenu } from '@/components/shell/ShellMenu';
import type { Locale } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { hasMeasuredProjectDetail } from '@/prototype/state/gateway-adapter';
import { useGatewayPendingAsks } from '@/prototype/state/gateway-pending-asks';
import { selectFilteredProjects, selectIsPinned, usePrototype } from '@/prototype/state/prototype-store';
import type { Project } from '@/prototype/types/prototype-types';
import { useUiMode } from '@/state/ui-mode';
import { relativeWhen } from '@/views/jobs/when';

import { AddProjectPanel } from './AddProjectPanel';
import { appVersion, useProjectForgeVersion } from './project-extras';
import { ProjectStatusWord } from './project-status';

/** DESIGN.md §3.3: search shows only with more than this many projects. */
const SEARCH_THRESHOLD = 8;

/* ------------------------------------------------------------ local helpers */

const AGO_UNITS: Readonly<Record<string, number>> = {
  sec: 1 / 60,
  secs: 1 / 60,
  second: 1 / 60,
  seconds: 1 / 60,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  day: 1440,
  days: 1440,
  week: 10080,
  weeks: 10080,
  // B8-3: the adapter's relative label is localised; Dutch unit words sort like their twins.
  uur: 60,
  dag: 1440,
  dagen: 1440,
  weken: 10080,
};

/**
 * Minutes since `label`, for ordering only. The adapter emits a relative "<number> <unit word>" label
 * (gateway-events-honesty.test.ts pins that contract); a raw ISO timestamp still parses too.
 * An empty or unknown label sorts as "now" (0), never as the oldest possible time.
 */
function agoMinutes(label: string): number {
  const parsed = Date.parse(label);
  if (!Number.isNaN(parsed)) return Math.max(0, (Date.now() - parsed) / 60000);
  const match = /^(\d+)\s+([a-z]+)/.exec(label.trim().toLowerCase());
  if (!match) return 0;
  return Number(match[1]) * (AGO_UNITS[match[2]] ?? 1);
}

/**
 * Minutes since the project last saw activity, for ordering. The adapter's own label wins; a project
 * with no label falls back to its folder's real modification time (`dirMtimeMs`, read by the gateway);
 * with neither it sorts last, never as "just now".
 */
function recencyMinutes(project: Project, now: number = Date.now()): number {
  if (project.lastActivity.trim() !== '') return agoMinutes(project.lastActivity);
  if (typeof project.dirMtimeMs === 'number') return Math.max(0, (now - project.dirMtimeMs) / 60000);
  return Number.POSITIVE_INFINITY;
}

/** The time shown in a row: the adapter's label, else the folder's last change, else nothing. */
function whenLabel(project: Project, locale: Locale): { readonly text: string; readonly fromFolder: boolean } {
  if (project.lastActivity.trim() !== '') return { text: project.lastActivity, fromFolder: false };
  if (typeof project.dirMtimeMs === 'number') {
    return { text: relativeWhen(new Date(project.dirMtimeMs).toISOString(), locale), fromFolder: true };
  }
  return { text: '', fromFolder: false };
}

/** The first letter of a project name for its tile; '#' when the name has no letter or digit. */
function tileLetter(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? match[0].toLocaleUpperCase() : '#';
}

/* -------------------------------------------------------------------- rows */

interface ProjectRowProps {
  readonly project: Project;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly advanced: boolean;
  readonly detailKnown: boolean;
  /** Replaces the status word, e.g. "1 vraag voor jou" in the "Wacht op jou" group. */
  readonly waitLabel?: string;
  readonly onOpen: () => void;
  readonly onPinToggle: () => void;
}

function ProjectRow({ project, pinned, active, advanced, detailKnown, waitLabel, onOpen, onPinToggle }: ProjectRowProps) {
  const { t, locale } = useLocale();
  const description = project.description.trim();
  const when = whenLabel(project, locale);

  return (
    <li className="fw-projects__item" data-active={active ? 'true' : undefined} data-pinned={pinned ? 'true' : undefined}>
      <div className="fw-xrow fw-projects__row">
        {/* Named by what it shows (axe label-content-name-mismatch, wave 4 part 4D-1): no aria-label replacing the
            visible name and goal, and the letter tile is drawn by CSS (data-letter) so it adds no word to the visible
            text. The pinned word is read after the goal so the visible words stay one run inside the name. */}
        <button
          type="button"
          className="fw-xrow__main fw-projects__open"
          aria-current={active ? 'true' : undefined}
          onClick={onOpen}
        >
          <span className="fw-xtile fw-projects__tile" aria-hidden="true" data-letter={tileLetter(project.name)} />
          <span className="fw-xrow__text">
            <span className="fw-xrow__name">
              <span className="fw-xrow__name-text fw-projects__name">{project.name}</span>
              {pinned ? (
                <span className="fw-projects__pin" title={t('rd.projects.pinned')} aria-hidden="true">
                  <Icon name="Pin" size="xs" />
                </span>
              ) : null}
            </span>
            {/* Only a real goal gets a line. An absent goal leaves no blank line, no "—" row of
                dashes and never leaked scaffold text (project-profile-placeholder.test.tsx). */}
            {/* The space keeps name and goal two words in the accessible name; a flex column never renders it. */}
            {description !== '' ? ' ' : null}
            {description !== '' ? <span className="fw-xrow__sub fw-projects__description">{description}</span> : null}
          </span>
          {pinned ? <span className="fw-visually-hidden">{t('rd.projects.pinned')}</span> : null}
        </button>

        {advanced ? <ProjectCounts project={project} detailKnown={detailKnown} /> : null}

        {waitLabel !== undefined ? (
          <span className="fw-xstatus" data-status="waiting">
            {waitLabel}
          </span>
        ) : (
          <ProjectStatusWord status={project.status} />
        )}
        <span className="fw-xrow__when" title={when.fromFolder ? t('rd.projects.folderChanged') : undefined}>
          {when.text}
        </span>

        <span className="fw-xrow__aside">
          <ShellMenu
            label={t('rd.projects.rowMenu', { name: project.name })}
            icon="Ellipsis"
            items={[
              { id: 'open', label: t('rd.projects.openItem'), icon: 'ArrowRight', onSelect: onOpen },
              {
                id: 'pin',
                label: pinned ? t('rd.projects.unpin') : t('rd.projects.pin'),
                icon: pinned ? 'PinOff' : 'Pin',
                onSelect: onPinToggle,
              },
            ]}
          />
        </span>
        <Icon name="ChevronRight" size="sm" className="fw-xrow__chev" />
      </div>
    </li>
  );
}

/**
 * Uitgebreid only: the measured numbers per project. Every unmeasured value reads "—", never a
 * fabricated 0 (fix-cert-fabrication F3, fix-cert-rest items 1 and 3; asserted by no-prototype-copy).
 */
function ProjectCounts({ project, detailKnown }: { readonly project: Project; readonly detailKnown: boolean }) {
  const { t } = useLocale();
  return (
    <span className="fw-projects__meta">
      <span className="fw-projects__counts">
        <span className="fw-projects__count" title={t('projectsPage.counts.conversations')}>
          <Icon name="MessageSquare" size="xs" />
          <span className="fw-visually-hidden">{t('projectsPage.counts.conversations')}: </span>
          <Machine muted>{project.conversationCount}</Machine>
        </span>
        <span className="fw-projects__count" title={t('projectsPage.counts.missions')}>
          <Icon name="Flag" size="xs" />
          <span className="fw-visually-hidden">{t('projectsPage.counts.missions')}: </span>
          <Machine muted>{detailKnown ? project.missionCount : '—'}</Machine>
        </span>
        <span className="fw-projects__count" title={t('projectsPage.counts.tasks')}>
          <Icon name="ListChecks" size="xs" />
          <span className="fw-visually-hidden">{t('projectsPage.counts.tasks')}: </span>
          <Machine muted>{project.taskCount ?? '—'}</Machine>
        </span>
        <span className="fw-projects__count" title={t('projectsPage.counts.helpers')}>
          <Icon name="Users" size="xs" />
          <span className="fw-visually-hidden">{t('projectsPage.counts.helpers')}: </span>
          <Machine muted>{detailKnown ? project.agentCount : '—'}</Machine>
        </span>
      </span>
      <span className="fw-projects__health" title={t('projectsPage.health')}>
        {project.health.score !== null ? (
          <Meter value={project.health.score} label={t('projectsPage.health')} showValue />
        ) : (
          <>
            <span className="fw-visually-hidden">{t('projectsPage.healthUnknown')}</span>
            <Machine muted aria-hidden="true">
              —
            </Machine>
          </>
        )}
      </span>
    </span>
  );
}

/* --------------------------------------------------------------------- view */

export default function ProjectsView() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const { t } = useLocale();
  const { isAdvanced } = useUiMode();
  const [adding, setAdding] = useState(false);

  const total = state.data.projects.length;
  const activeName = state.activeProjectId;
  // The versions line is Uitgebreid only, so Eenvoudig never asks the gateway for it.
  const forgeVersion = useProjectForgeVersion(isAdvanced ? activeName : '');
  const app = appVersion();
  const pendingAsks = useGatewayPendingAsks(activeName);

  const query = state.projectQuery.trim();
  const showSearch = total > SEARCH_THRESHOLD || query !== '';
  const filtered = showSearch ? selectFilteredProjects(state) : state.data.projects;

  const ordered = [...filtered].sort((a, b) => {
    const pinned = Number(selectIsPinned(state, b.id)) - Number(selectIsPinned(state, a.id));
    if (pinned !== 0) return pinned;
    const byRecency = recencyMinutes(a) - recencyMinutes(b);
    if (Number.isNaN(byRecency)) return a.name.localeCompare(b.name);
    return byRecency !== 0 ? byRecency : a.name.localeCompare(b.name);
  });

  const activeProject = state.data.projects.find((project) => project.id === activeName) ?? null;
  const waiting = activeProject !== null && pendingAsks.length > 0 ? activeProject : null;
  const waitingAsks = pendingAsks.reduce((sum, ask) => sum + Math.max(1, ask.questionCount), 0);
  const rest = waiting !== null ? ordered.filter((project) => project.id !== waiting.id) : ordered;

  function openProject(project: Project): void {
    dispatch({ type: 'project/activate', id: project.id });
    dispatch({ type: 'select', selection: { kind: 'project', id: project.id } });
    navigate('/project');
  }

  function openWaiting(): void {
    const first = pendingAsks[0];
    if (first === undefined) return;
    dispatch({ type: 'conversation/activate', id: first.conversationId });
    navigate('/chat');
  }

  function row(project: Project, waitLabel?: string, onOpen?: () => void) {
    return (
      <ProjectRow
        key={project.id}
        project={project}
        pinned={selectIsPinned(state, project.id)}
        active={project.id === activeName}
        advanced={isAdvanced}
        detailKnown={hasMeasuredProjectDetail(project, activeName)}
        waitLabel={waitLabel}
        onOpen={onOpen ?? (() => openProject(project))}
        onPinToggle={() => dispatch({ type: 'project/pin-toggle', id: project.id })}
      />
    );
  }

  return (
    <div className="fw-xpage fw-projects">
      <header className="fw-xpage__header">
        <div className="fw-xpage__title">
          <h1>{t('rd.projects.title')}</h1>
        </div>
        <Button variant="primary" icon="Plus" aria-expanded={adding} onClick={() => setAdding((open) => !open)}>
          {t('rd.projects.new')}
        </Button>
      </header>

      <div className="fw-xpage__body">
        {adding ? (
          <AddProjectPanel projectPaths={state.data.projects.map((project) => project.path)} onClose={() => setAdding(false)} />
        ) : null}

        {total === 0 ? (
          <div className="fw-xpage__empty">
            <p>{t('rd.projects.empty')}</p>
            <Button variant="secondary" icon="MessageSquarePlus" onClick={() => navigate('/')}>
              {t('rd.projects.emptyAction')}
            </Button>
          </div>
        ) : (
          <>
            {showSearch ? (
              <div className="fw-projects__search">
                <Icon name="Search" size="sm" className="fw-projects__search-icon" />
                <input
                  className="fw-projects__search-input"
                  type="search"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('rd.projects.search')}
                  placeholder={t('rd.projects.search')}
                  value={state.projectQuery}
                  onChange={(event) => dispatch({ type: 'project/query', query: event.target.value })}
                />
                {query ? (
                  <IconButton
                    icon="X"
                    label={t('projectsPage.clearFilter')}
                    size="sm"
                    onClick={() => dispatch({ type: 'project/query', query: '' })}
                  />
                ) : null}
              </div>
            ) : null}

            {waiting !== null ? (
              <section className="fw-xgroup" aria-labelledby="fw-projects-waiting">
                <h2 id="fw-projects-waiting" className="fw-xpage__section-title">
                  {t('rd.projects.waiting')}
                </h2>
                <ul className="fw-xlist">
                  {row(
                    waiting,
                    waitingAsks === 1 ? t('rd.projects.askOne') : t('rd.projects.askMany', { count: waitingAsks }),
                    openWaiting,
                  )}
                </ul>
              </section>
            ) : null}

            {ordered.length === 0 ? (
              <div className="fw-xpage__empty">
                <p>{t('projectsPage.noMatch.detail', { query })}</p>
                <Button variant="quiet" icon="RotateCcw" onClick={() => dispatch({ type: 'project/query', query: '' })}>
                  {t('projectsPage.clearFilter')}
                </Button>
              </div>
            ) : rest.length > 0 ? (
              <section className="fw-xgroup" aria-labelledby="fw-projects-all">
                <h2 id="fw-projects-all" className="fw-xpage__section-title">
                  {t('rd.projects.all')}
                </h2>
                <ul className="fw-xlist fw-projects__list">{rest.map((project) => row(project))}</ul>
              </section>
            ) : null}
          </>
        )}

        {isAdvanced ? (
          <p className="fw-xpage__note fw-projects__versions" aria-label={t('projectsPage.versions.label')}>
            <span>{app !== null ? t('projectsPage.versions.app', { version: app }) : t('projectsPage.versions.appDev')}</span>
            <span aria-hidden="true">·</span>
            <span>
              {activeName === ''
                ? t('projectsPage.versions.noProject')
                : forgeVersion === null
                  ? '—'
                  : forgeVersion.version !== null
                    ? t('projectsPage.versions.project', { version: forgeVersion.version, name: activeName })
                    : t('projectsPage.versions.projectNone', { name: activeName })}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
