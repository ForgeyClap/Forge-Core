/**
 * BotActivitySection — "Bot activity" (Command Center audit finding 31): what the Discord
 * bot has actually done on this machine, its jobs and the cost Claude Code recorded for them. Before
 * this panel, 31 bot jobs and $121.45 of recorded cost appeared in no Command Center view at all.
 *
 * Reads `GET /api/discord/activity` through `useGatewayDiscordActivity()` — read-only, polled, never
 * message text or Discord ids (the gateway does not send them). Every number shown is a real figure
 * from the bot's own queue and usage log; a missing log is shown as "no activity yet", never as a
 * fabricated zero, and anything the gateway could not read is listed as a plain note.
 */

import type { ReactNode } from 'react';

import { EmptyState, Icon, Panel, StatusDot } from '@/components/primitives';
import type { Locale, Translate } from '@/i18n';
import { formatDurationMs, formatRelativeTime } from '@/prototype/state/adapter/rows';
import { useGatewayDiscordActivity } from '@/prototype/state/gateway-discord-activity';
import type { DiscordActivity, DiscordJob } from '@/prototype/state/gateway-discord-activity';
import { formatCompact, formatCount, formatUsd, jobStateLabel, jobsLabel, statusKeyForJobState } from './bot-activity-format';
import './bot-activity.css';
import { useLocale } from '@/i18n/use-locale';

type C = Translate;

/* ------------------------------------------------------------------ atoms */

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="fw-discord__row">
      <div className="fw-discord__row-text">
        <span className="fw-discord__row-label">{label}</span>
        {hint ? <span className="fw-discord__row-hint">{hint}</span> : null}
      </div>
      <div className="fw-discord__row-control">{children}</div>
    </div>
  );
}

function projectLabel(name: string | null, id: string | null, t: C): string {
  return name ?? id ?? t('rd.discord.bot.unknownProject');
}

function tokensHint(cost: DiscordActivity['cost'], t: C, locale: Locale): string {
  const parts = [t('rd.discord.bot.tokensAcross')];
  if (cost.cacheReadTokens > 0) parts.push(t('rd.discord.bot.tokensCache', { amount: formatCompact(cost.cacheReadTokens, locale) }));
  if (cost.runsWithoutCost > 0) parts.push(t('rd.discord.bot.noCost', { jobs: jobsLabel(cost.runsWithoutCost, locale) }));
  return parts.join(' ');
}

function openHint(open: number, t: C, locale: Locale): string {
  if (open === 0) return t('rd.discord.bot.openNone');
  return t(open === 1 ? 'rd.discord.bot.openOne' : 'rd.discord.bot.openMany', { count: formatCount(open, locale) });
}

/* -------------------------------------------------------------- sections */

function StateList({ byState, t, locale }: { byState: DiscordActivity['jobs']['byState']; t: C; locale: Locale }) {
  const entries = Object.entries(byState).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <ul className="fw-botact__states" aria-label={t('rd.discord.bot.byState')}>
      {entries.map(([state, count]) => (
        <li key={state} className="fw-botact__state">
          <span aria-hidden="true">
            <StatusDot status={statusKeyForJobState(state)} />
          </span>
          <span className="fw-botact__state-label">{jobStateLabel(state, locale)}</span>
          <span className="fw-botact__state-count fw-discord-num">{formatCount(count, locale)}</span>
        </li>
      ))}
    </ul>
  );
}

function ProjectCosts({ cost, t, locale }: { cost: DiscordActivity['cost']; t: C; locale: Locale }) {
  if (cost.byProject.length === 0) return null;
  return (
    <section className="fw-botact__section" aria-label={t('rd.discord.bot.costPerProject')}>
      <span className="fw-discord-label">{t('rd.discord.bot.perProject')}</span>
      <ul className="fw-botact__list">
        {cost.byProject.map((p) => (
          <li key={p.projectId ?? '(none)'} className="fw-botact__item">
            <span className="fw-botact__item-name fw-truncate">{projectLabel(p.projectName, p.projectId, t)}</span>
            <span className="fw-botact__item-meta">{jobsLabel(p.runs, locale)}</span>
            <span className="fw-botact__item-value fw-discord-num">{formatUsd(p.costUsd, locale)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function jobWhen(job: DiscordJob, locale: Locale): string {
  return formatRelativeTime(job.completedAt ?? job.startedAt ?? job.receivedAt, locale);
}

function RecentJobs({ jobs, t, locale }: { jobs: readonly DiscordJob[]; t: C; locale: Locale }) {
  if (jobs.length === 0) return null;
  return (
    <section className="fw-botact__section" aria-label={t('rd.discord.bot.recent')}>
      <span className="fw-discord-label">{t('rd.discord.bot.recent')}</span>
      <ul className="fw-botact__list">
        {jobs.map((job, index) => {
          const meta = [jobStateLabel(job.state, locale), jobWhen(job, locale), formatDurationMs(job.durationMs)].filter((part) => part !== '');
          return (
            <li key={job.id ?? `job-${index}`} className="fw-botact__job">
              <span aria-hidden="true" className="fw-botact__job-dot">
                <StatusDot status={statusKeyForJobState(job.state)} />
              </span>
              <span className="fw-botact__job-main">
                <span className="fw-botact__item-name fw-truncate">{projectLabel(job.projectName, job.projectId, t)}</span>
                <span className="fw-botact__item-meta">{meta.join(' · ')}</span>
                {job.error !== null ? <span className="fw-botact__job-error">{job.error}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------- view */

export default function BotActivitySection() {
  const { data, error, loading } = useGatewayDiscordActivity();
  const { t, locale } = useLocale();

  return (
    <Panel title={t('rd.discord.bot.title')} subtitle={t('rd.discord.bot.subtitle')}>
      {error !== null ? (
        <p className="fw-discord__transport-error" role="alert">
          <Icon name="Unplug" size="sm" />
          <span>{t('rd.discord.unreachable', { error })}</span>
        </p>
      ) : null}

      {loading ? (
        <EmptyState compact icon="Loader" title={t('rd.discord.bot.loading')} />
      ) : !data.available ? (
        <EmptyState
          compact
          icon="Inbox"
          title={t('rd.discord.bot.empty')}
          detail={t('rd.discord.bot.emptyDetail')}
        />
      ) : (
        <div className="fw-botact">
          <div className="fw-discord__rows">
            <Row label={t('rd.discord.bot.jobs')} hint={openHint(data.jobs.open, t, locale)}>
              <span className="fw-discord-num">{formatCount(data.jobs.total, locale)}</span>
            </Row>
            <Row label={t('rd.discord.bot.cost')} hint={t('rd.discord.bot.costHint')}>
              <span className="fw-discord-num">{formatUsd(data.cost.totalUsd, locale)}</span>
            </Row>
            <Row label={t('rd.discord.bot.last7')}>
              <span className="fw-discord-quiet fw-discord-num">{formatUsd(data.cost.last7dUsd, locale)}</span>
            </Row>
            <Row label={t('rd.discord.bot.last24')}>
              <span className="fw-discord-quiet fw-discord-num">{formatUsd(data.cost.last24hUsd, locale)}</span>
            </Row>
            <Row label={t('rd.discord.bot.tokens')} hint={tokensHint(data.cost, t, locale)}>
              <span className="fw-discord-quiet fw-discord-num">
                {t('rd.discord.bot.tokensValue', {
                  in: formatCompact(data.cost.inputTokens + data.cost.cacheReadTokens, locale),
                  out: formatCompact(data.cost.outputTokens, locale),
                })}
              </span>
            </Row>
          </div>

          <StateList byState={data.jobs.byState} t={t} locale={locale} />
          <ProjectCosts cost={data.cost} t={t} locale={locale} />
          <RecentJobs jobs={data.jobs.recent} t={t} locale={locale} />

          {data.notes.length > 0 ? (
            <ul className="fw-botact__notes" aria-label={t('rd.discord.bot.notes')}>
              {data.notes.map((note) => (
                <li key={note} className="fw-botact__note">
                  <Icon name="Info" size="xs" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
