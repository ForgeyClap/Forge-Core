/**
 * TeamView — the Team screen (route /team, nav entry only in Uitgebreid) (WP B4, plan §4.2, §4.5;
 * channel contract docs/forge-systeem/TEAM-CHAT.md).
 *
 * Left: the channel of one klus — decisions and the lead's lines pinned on top, handoffs as narrow
 * system lines, every other line as a message with its kind (bericht / overdracht / blokkade /
 * vraag / besluit) and "via Lead" where the lead relayed it. Right: the twelve roles with their
 * live status in that klus (bezig / wacht / klaar / niet ingezet), derived from real dispatches.
 *
 * Honesty: only what is in the klus's team-chat.jsonl is shown; an empty or missing file is the
 * empty state, never made-up activity. `TeamPanel` is the pure part for fixtures and tests.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { EmptyState, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayActiveRuns } from '@/prototype/state/adapter/polling-hooks';
import { usePrototype } from '@/prototype/state/prototype-store';

import { CARD_ROLES, roleStatuses, useTeamChat, useTeamDispatches } from './team-data';
import type { RoleSlug, RoleStatus, TeamChat } from './team-data';
import { ChannelItem, LogName, RoleStamp, roleName } from './team-ui';

import './team.css';

export interface RunOption {
  readonly id: string;
  readonly label: string;
  readonly live: boolean;
}

export interface TeamPanelProps {
  readonly runs: readonly RunOption[];
  readonly runId: string | null;
  readonly onRunChange: (runId: string) => void;
  readonly statuses: ReadonlyMap<RoleSlug, RoleStatus>;
  readonly chat: TeamChat;
  readonly hasProject: boolean;
}

function RoleCard({ role, status }: { role: RoleSlug; status: RoleStatus }) {
  const { t } = useLocale();
  return (
    <li className="fw-team-role" data-status={status}>
      <RoleStamp role={role} status={status} />
      <span className="fw-team-role__body">
        <span className="fw-team-role__name">
          {roleName(t, role)}
          <LogName role={role} raw={null} />
        </span>
        <span className="fw-team-role__does">{t(`team.roleDoes.${role}`)}</span>
      </span>
      <span className="fw-team-role__status" data-status={status} title={t(`team.statusHint.${status}`)}>
        <span className="fw-team-role__dot" aria-hidden="true" />
        {t(`team.status.${status}`)}
      </span>
    </li>
  );
}

/** One line and one action (DESIGN section 4), for a page with no project or no klus yet. */
function TeamEmptyPage({ hasProject }: { hasProject: boolean }) {
  const { t } = useLocale();
  return (
    <section className="fw-team" aria-labelledby="fw-team-title">
      <header className="fw-team__header">
        <div className="fw-team__title">
          <h1 id="fw-team-title">{t('team.view.title')}</h1>
          <p>{t('team.view.subtitle')}</p>
        </div>
      </header>
      <EmptyState
        icon={hasProject ? 'Inbox' : 'FolderOpen'}
        title={hasProject ? t('team.view.noRuns') : t('team.view.noProject')}
        action={
          <Link to={hasProject ? '/' : '/projects'} className="fw-control fw-button fw-button--ghost fw-button--sm">
            <Icon name={hasProject ? 'Plus' : 'FolderOpen'} size="xs" className="fw-button__icon" />
            <span className="fw-button__label">{hasProject ? t('rd.team.noRunsAction') : t('rd.team.noProjectAction')}</span>
          </Link>
        }
      />
    </section>
  );
}

export function TeamPanel({ runs, runId, onRunChange, statuses, chat, hasProject }: TeamPanelProps) {
  if (!hasProject || runs.length === 0 || runId === null) return <TeamEmptyPage hasProject={hasProject} />;
  return <TeamChannelPage runs={runs} runId={runId} onRunChange={onRunChange} statuses={statuses} chat={chat} />;
}

function TeamChannelPage({ runs, runId, onRunChange, statuses, chat }: Omit<TeamPanelProps, 'hasProject' | 'runId'> & { readonly runId: string }) {
  const { t } = useLocale();
  const [wp, setWp] = useState('');

  const wpIds = useMemo(
    () => Array.from(new Set(chat.lines.map((line) => line.wpId).filter((id): id is string => id !== null))).sort(),
    [chat.lines],
  );
  const activeWp = wp !== '' && wpIds.includes(wp) ? wp : '';
  const visible = activeWp === '' ? chat.lines : chat.lines.filter((line) => line.wpId === activeWp);
  const pinned = visible.filter((line) => line.pinned && line.kind !== 'handoff');
  const flow = visible.filter((line) => !(line.pinned && line.kind !== 'handoff'));
  const busyCount = CARD_ROLES.filter((role) => statuses.get(role) === 'busy').length;

  let channel;
  if (chat.status === 'error') {
    channel = <EmptyState icon="CircleAlert" title={t('team.view.loadError', { error: chat.error ?? '' })} compact />;
  } else if (visible.length === 0) {
    channel = <EmptyState icon="MessageSquareDashed" title={t('team.view.empty')} detail={t('team.view.emptyDetail')} compact />;
  } else {
    channel = (
      <>
        {pinned.length > 0 ? (
          <div className="fw-team-pinned">
            <p className="fw-team-pinned__label">
              <Icon name="Pin" size="xs" />
              {t('team.pinned')}
            </p>
            <ol className="fw-team-lines">
              {pinned.map((line, index) => (
                <ChannelItem key={`p-${line.ts ?? ''}-${index}`} line={line} showLogName />
              ))}
            </ol>
          </div>
        ) : null}
        <ol className="fw-team-lines">
          {flow.map((line, index) => (
            <ChannelItem key={`${line.ts ?? ''}-${index}`} line={line} showLogName />
          ))}
        </ol>
        {chat.truncated ? <p className="fw-team-note">{t('team.view.truncated', { n: chat.lines.length })}</p> : null}
        {chat.malformed > 0 ? <p className="fw-team-note">{t('team.view.malformed', { n: chat.malformed })}</p> : null}
      </>
    );
  }

  return (
    <section className="fw-team" aria-labelledby="fw-team-title">
      <header className="fw-team__header">
        <div className="fw-team__title">
          <h1 id="fw-team-title">{t('team.view.title')}</h1>
          <p>{t('team.view.subtitle')}</p>
        </div>
        <div className="fw-team__controls">
          <label className="fw-team-select">
            <span>{t('team.view.runLabel')}</span>
            <select value={runId} onChange={(event) => onRunChange(event.target.value)}>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.live ? '● ' : ''}
                  {run.label}
                </option>
              ))}
            </select>
          </label>
          <label className="fw-team-select">
            <span>{t('team.view.taskLabel')}</span>
            <select value={activeWp} onChange={(event) => setWp(event.target.value)} disabled={wpIds.length === 0}>
              <option value="">{t('team.view.allTasks')}</option>
              {wpIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <p className="fw-team__honesty">
        <Icon name="Info" size="xs" />
        <span>{t('team.view.honesty')}</span>
      </p>

      <div className="fw-team__body">
        <div className="fw-team__channel" aria-label={t('team.view.channelHeading')} role="region">
          <h2 className="fw-team__heading">{t('team.view.channelHeading')}</h2>
          {channel}
        </div>
        <aside className="fw-team__roles" aria-labelledby="fw-team-roles">
          <h2 id="fw-team-roles" className="fw-team__heading">
            {t('team.view.rolesHeading')}
            {busyCount > 0 ? <span className="fw-team__busy">{t('team.view.busyCount', { n: busyCount })}</span> : null}
          </h2>
          <ul className="fw-team-roles">
            {CARD_ROLES.map((role) => (
              <RoleCard key={role} role={role} status={statuses.get(role) ?? 'idle'} />
            ))}
          </ul>
          <Link to="/agents" className="fw-team__manage">
            <Icon name="SlidersHorizontal" size="xs" />
            {t('team.view.manageModels')}
          </Link>
        </aside>
      </div>
    </section>
  );
}

export default function TeamView() {
  const { state } = usePrototype();
  const projectName = state.activeProjectId;
  const active = useGatewayActiveRuns();
  const [picked, setPicked] = useState<{ project: string; runId: string } | null>(null);

  const liveIds = useMemo(
    () => new Set(active.rows.filter((row) => row.project === projectName).map((row) => row.runId)),
    [active.rows, projectName],
  );
  const runs: readonly RunOption[] = useMemo(() => {
    const own = state.data.runs
      .filter((run) => run.projectId === projectName)
      .slice()
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    const options = own.map((run) => ({ id: run.id, label: run.goal && run.goal !== run.id ? `${run.goal} · ${run.id}` : run.id, live: liveIds.has(run.id) }));
    // A live klus the run list has not caught up with yet still gets an entry.
    for (const id of liveIds) if (!options.some((o) => o.id === id)) options.unshift({ id, label: id, live: true });
    return options;
  }, [state.data.runs, projectName, liveIds]);

  const pickedId = picked !== null && picked.project === projectName && runs.some((r) => r.id === picked.runId) ? picked.runId : null;
  const runId = pickedId ?? runs.find((r) => r.live)?.id ?? runs[0]?.id ?? null;

  const dispatches = useTeamDispatches(projectName);
  const chat = useTeamChat(projectName, runId);

  return (
    <TeamPanel
      runs={runs}
      runId={runId}
      onRunChange={(id) => setPicked({ project: projectName, runId: id })}
      statuses={roleStatuses(dispatches, runId)}
      chat={chat}
      hasProject={projectName !== ''}
    />
  );
}
