/**
 * TeamStrip — one line above the composer that says what the team is doing (WP B4, plan §4.2,
 * PRODUCT-CARD.md "Wat doet het team nu?").
 *
 * Renders only while the active project has a live klus (`GET /api/active-runs`). The sentence is
 * built from that klus's real dispatches ("Planner, Bouwer en Tester zijn bezig."); a click
 * expands the latest five channel lines. Never invented: no live klus, no strip.
 *
 * `TeamStripView` is the pure part (props in, markup out) so it can be rendered from fixtures.
 */

import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayActiveRuns } from '@/prototype/state/adapter/polling-hooks';
import { useUiMode } from '@/state/ui-mode';

import { ROLE_SLUGS, roleStatuses, useTeamChat, useTeamDispatches } from './team-data';
import type { ChannelLine, RoleSlug, RoleStatus, TeamChat, TeamDispatch } from './team-data';
import { ChannelItem, RoleStamp, joinNames, roleName } from './team-ui';

import './team.css';

const STRIP_LINES = 5;

export interface TeamStripViewProps {
  readonly statuses: ReadonlyMap<RoleSlug, RoleStatus>;
  readonly chat: TeamChat;
  readonly showTeamLink?: boolean;
  readonly defaultExpanded?: boolean;
}

/** The roles that took part, in the product card's order. */
function involved(statuses: ReadonlyMap<RoleSlug, RoleStatus>): readonly RoleSlug[] {
  return ROLE_SLUGS.filter((slug) => (statuses.get(slug) ?? 'idle') !== 'idle');
}

export function TeamStripView({ statuses, chat, showTeamLink = false, defaultExpanded = false }: TeamStripViewProps) {
  const { t } = useLocale();
  // B8-3 (review: "Pr Bo Ow Te ..." means nothing to a beginner): the two-letter stamps show only in
  // Uitgebreid, each with its full role name as a tooltip. Eenvoudig keeps the sentence, which
  // already names every role in full.
  const { isAdvanced } = useUiMode();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();

  const roles = involved(statuses);
  const namesFor = (status: RoleStatus) => roles.filter((slug) => statuses.get(slug) === status).map((slug) => roleName(t, slug));
  const busy = namesFor('busy');
  const waiting = namesFor('waiting');
  const done = namesFor('done');

  const lead = busy.length > 0 ? t(busy.length === 1 ? 'team.strip.busyOne' : 'team.strip.busyMany', { names: joinNames(t, busy) }) : null;
  const rest = [
    waiting.length > 0 ? t(waiting.length === 1 ? 'team.strip.waitingOne' : 'team.strip.waitingMany', { names: joinNames(t, waiting) }) : null,
    done.length > 0 ? t(done.length === 1 ? 'team.strip.doneOne' : 'team.strip.doneMany', { names: joinNames(t, done) }) : null,
  ].filter((part): part is string => part !== null);
  const fallback = lead === null && rest.length === 0 ? t('team.strip.working') : null;

  const latest: readonly ChannelLine[] = chat.lines.slice(-STRIP_LINES);
  const toggleLabel = expanded ? t('team.strip.collapse') : t('team.strip.expand');

  return (
    <section
      className="fw-team-strip"
      data-busy={busy.length > 0 ? 'true' : undefined}
      // FU-CHAT: Eenvoudig gets the slimmer one-line bar (team.css), so the chat transcript keeps the room.
      data-compact={isAdvanced ? undefined : 'true'}
      aria-label={t('team.strip.label')}
    >
      <button
        type="button"
        className="fw-team-strip__bar"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((open) => !open)}
      >
        {isAdvanced ? (
          <span className="fw-team-strip__stamps">
            {roles.map((slug) => (
              <RoleStamp key={slug} role={slug} status={statuses.get(slug) ?? 'idle'} title={roleName(t, slug)} />
            ))}
          </span>
        ) : null}
        <span className="fw-team-strip__what">
          {lead ? <strong>{lead}</strong> : null}
          {rest.length > 0 ? <span> {rest.join(' ')}</span> : null}
          {fallback ? <span>{fallback}</span> : null}
        </span>
        <Icon name="ChevronDown" size="sm" className="fw-team-strip__chevron" />
        <span className="fw-visually-hidden">{toggleLabel}</span>
      </button>
      {expanded ? (
        <div id={panelId} className="fw-team-strip__panel">
          <p className="fw-team-strip__latest">{t('team.strip.latest')}</p>
          {chat.status === 'error' ? (
            <p className="fw-team-strip__note" role="status">
              {t('team.strip.loadError')}
            </p>
          ) : latest.length === 0 ? (
            <p className="fw-team-strip__note">{t('team.strip.empty')}</p>
          ) : (
            <ol className="fw-team-lines fw-team-lines--compact">
              {latest.map((line, index) => (
                <ChannelItem key={`${line.ts ?? ''}-${index}`} line={line} showLogName={false} compact />
              ))}
            </ol>
          )}
          {showTeamLink ? (
            <Link to="/team" className="fw-team-strip__link">
              {t('team.view.title')}
              <Icon name="ArrowRight" size="xs" />
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The live klus of `projectName`, or null. */
function useLiveRunId(projectName: string): string | null {
  const active = useGatewayActiveRuns();
  if (projectName === '') return null;
  const row = active.rows.find((r) => r.project === projectName && r.runId !== '');
  return row ? row.runId : null;
}

export interface TeamStripProps {
  readonly projectName: string;
}

/** Container: real data in, nothing rendered while there is no live klus. */
export function TeamStrip({ projectName }: TeamStripProps) {
  const runId = useLiveRunId(projectName);
  const dispatches: readonly TeamDispatch[] = useTeamDispatches(runId === null ? '' : projectName);
  const chat = useTeamChat(runId === null ? '' : projectName, runId, 20);
  const { isAdvanced } = useUiMode();
  if (runId === null) return null;
  return <TeamStripView key={runId} statuses={roleStatuses(dispatches, runId)} chat={chat} showTeamLink={isAdvanced} />;
}

export default TeamStrip;
