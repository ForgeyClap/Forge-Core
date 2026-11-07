/**
 * Vaardigheden & koppelingen (/skills) — WP B5, plan §4.2 / §4.6 (Uitgebreid, read-only).
 *
 * Left: the project's skills from `GET /api/skills` (its own `.claude/skills/<slug>/SKILL.md`
 * files), searchable. Right: the connection registry from `GET /api/mcp`, grouped into the three
 * tiers dormant / limited / write-gated (adapter/skills.ts). Nothing can be switched here: the
 * screen says where changes happen instead of offering a control that does nothing.
 * Skill slugs and server ids are log names (`data-log-name`); the copy around them is Dutch.
 */

import '../jobs/xpage.css';
import './skills.css';

import { useState } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { CONNECTION_TIERS, filterSkills, groupConnections, useProjectSkills } from '@/prototype/state/adapter/skills';
import type { ConnectionGroups, ConnectionRow, SkillsState } from '@/prototype/state/adapter/skills';
import { useGatewayMcp } from '@/prototype/state/gateway-capabilities';
import type { GatewayMcp } from '@/prototype/state/gateway-capabilities';
import { useProjectListStatus } from '@/prototype/state/adapter/jobs';
import { usePrototype } from '@/prototype/state/prototype-store';

type Load = 'loading' | 'ready' | 'error';

export interface SkillsPanelProps {
  readonly projectName: string;
  readonly skills: SkillsState;
  readonly connections: { readonly status: Load; readonly value: GatewayMcp };
  readonly onRetryConnections: () => void;
  /** Whether the project list could be read (only consulted while no project is active). */
  readonly projectsStatus?: Load;
}

const TIER_ICON = { dormant: 'Moon', limited: 'Shield', writeGated: 'Lock' } as const;

function levelKey(tier: number | null): 'l0' | 'l1' | 'l2' | 'l3' | 'unknown' {
  if (tier === 0) return 'l0';
  if (tier === 1) return 'l1';
  if (tier === 2) return 'l2';
  if (tier === 3) return 'l3';
  return 'unknown';
}

function ConnectionItem({ row }: { readonly row: ConnectionRow }) {
  const { t } = useLocale();
  const server = row.server;
  return (
    <li className="fw-skills__conn">
      <span className="fw-skills__conn-top">
        <span className="fw-skills__conn-id" data-log-name>
          {server.id}
        </span>
        <span className="fw-skills__level" data-level={levelKey(server.tier)}>
          {t(`skillsPage.connections.level.${levelKey(server.tier)}`)}
        </span>
      </span>
      {server.purpose ? (
        <span className="fw-skills__conn-purpose" data-log-text>
          {server.purpose}
        </span>
      ) : null}
      <span className="fw-skills__conn-meta">
        <span>
          {row.helperCount === 0
            ? t('skillsPage.connections.helpersNone')
            : row.helperCount === 1
              ? t('skillsPage.connections.helpersOne')
              : t('skillsPage.connections.helpersMany', { count: row.helperCount })}
        </span>
        {server.credentialsNeeded ? (
          <span>
            <Icon name="Lock" size="xs" /> {t('skillsPage.connections.needsKey')}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function Connections({ groups, registryPresent }: { readonly groups: ConnectionGroups; readonly registryPresent: boolean | null }) {
  const { t } = useLocale();
  if (groups.total === 0) {
    return <p className="fw-skills__empty">{registryPresent === false ? t('skillsPage.connections.registryMissing') : t('skillsPage.connections.empty')}</p>;
  }
  return (
    <div className="fw-skills__tiers">
      {CONNECTION_TIERS.map((tier) => {
        const rows = groups[tier];
        return (
          <section key={tier} className="fw-skills__tier" data-tier={tier} aria-labelledby={`fw-tier-${tier}`}>
            <header className="fw-skills__tier-head">
              <Icon name={TIER_ICON[tier]} size="sm" />
              <h3 id={`fw-tier-${tier}`}>{t(`skillsPage.connections.tiers.${tier}.title`)}</h3>
              <span className="fw-skills__tier-count">{rows.length}</span>
            </header>
            <p className="fw-skills__tier-feel">{t(`skillsPage.connections.tiers.${tier}.feel`)}</p>
            {rows.length === 0 ? (
              <p className="fw-skills__empty">{t('skillsPage.connections.empty')}</p>
            ) : (
              <ul className="fw-skills__conns">
                {rows.map((row) => (
                  <ConnectionItem key={row.server.id} row={row} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function SkillsPanel({ projectName, skills, connections, onRetryConnections, projectsStatus = 'ready' }: SkillsPanelProps) {
  const { t } = useLocale();
  const [query, setQuery] = useState('');

  if (projectName === '') {
    return (
      <div className="fw-xpage fw-xpage--route">
        <header className="fw-xpage__header">
          <div className="fw-xpage__title">
            <h1>{t('skillsPage.title')}</h1>
          </div>
        </header>
        <div className="fw-xpage__body">
          {projectsStatus === 'error' ? (
            <section className="fw-xpage__state" role="alert">
              <p>{t('skillsPage.error')}</p>
            </section>
          ) : (
            <section className="fw-xpage__state" aria-labelledby="fw-skills-noproject">
              <h2 id="fw-skills-noproject">{t('skillsPage.noProject.title')}</h2>
              <p>{t('skillsPage.noProject.body')}</p>
            </section>
          )}
        </div>
      </div>
    );
  }

  const list = skills.value.skills;
  const shown = filterSkills(list, query);
  const groups = groupConnections(connections.value);

  return (
    <div className="fw-xpage fw-xpage--route">
      <header className="fw-xpage__header">
        <div className="fw-xpage__title">
          <h1>{t('skillsPage.title')}</h1>
          <p>{t('skillsPage.subtitle', { project: projectName })}</p>
        </div>
      </header>
      <div className="fw-xpage__body">
        <div className="fw-skills">
          <section className="fw-skills__col" aria-labelledby="fw-skills-title">
            <h2 id="fw-skills-title" className="fw-xpage__section-title">
              {t('skillsPage.skills.title')}
              {skills.status === 'ready' ? (
                <span className="fw-skills__count">
                  {skills.value.count === 1 ? t('skillsPage.skills.countOne') : t('skillsPage.skills.countMany', { count: skills.value.count })}
                </span>
              ) : null}
            </h2>
            {skills.status === 'loading' ? <p className="fw-xpage__note">{t('skillsPage.loading')}</p> : null}
            {skills.status === 'error' ? (
              <div className="fw-xpage__state" role="alert">
                <p>{t('skillsPage.error')}</p>
                <Button variant="ghost" size="sm" icon="RotateCcw" onClick={skills.reload}>
                  {t('skillsPage.retry')}
                </Button>
              </div>
            ) : null}
            {skills.status === 'ready' && list.length === 0 ? <p className="fw-skills__empty">{t('skillsPage.skills.empty')}</p> : null}
            {skills.status === 'ready' && list.length > 0 ? (
              <>
                <div className="fw-skills__search">
                  <Icon name="Search" size="sm" />
                  <input
                    type="search"
                    aria-label={t('skillsPage.skills.filterLabel')}
                    placeholder={t('skillsPage.skills.filterPlaceholder')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                {shown.length === 0 ? (
                  <p className="fw-skills__empty">{t('skillsPage.skills.noMatch', { query: query.trim() })}</p>
                ) : (
                  <ul className="fw-skills__list">
                    {shown.map((skill) => (
                      <li key={skill.slug} className="fw-skills__skill">
                        <span className="fw-skills__skill-name" data-log-name>
                          {skill.name}
                        </span>
                        <span className="fw-skills__skill-desc" data-log-text>
                          {skill.description ?? (skill.hasSkillMd ? t('skillsPage.skills.noDescription') : t('skillsPage.skills.missingFile'))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </section>

          <section className="fw-skills__col" aria-labelledby="fw-conn-title">
            <h2 id="fw-conn-title" className="fw-xpage__section-title">
              {t('skillsPage.connections.title')}
              {connections.status === 'ready' && groups.total > 0 ? (
                <span className="fw-skills__count">{t('skillsPage.connections.countLine', { total: groups.total, active: groups.active })}</span>
              ) : null}
            </h2>
            <p className="fw-skills__lead">{t('skillsPage.connections.lead')}</p>
            {connections.status === 'loading' ? <p className="fw-xpage__note">{t('skillsPage.loading')}</p> : null}
            {connections.status === 'error' ? (
              <div className="fw-xpage__state" role="alert">
                <p>{t('skillsPage.error')}</p>
                <Button variant="ghost" size="sm" icon="RotateCcw" onClick={onRetryConnections}>
                  {t('skillsPage.retry')}
                </Button>
              </div>
            ) : null}
            {connections.status === 'ready' ? <Connections groups={groups} registryPresent={connections.value.registryPresent} /> : null}
          </section>
        </div>
      </div>
    </div>
  );
}

export default function SkillsView() {
  const { state } = usePrototype();
  const projectName = state.activeProjectId;
  const skills = useProjectSkills(projectName);
  const mcp = useGatewayMcp(projectName);
  const projectsStatus = useProjectListStatus(projectName === '');
  // A failed poll after a good one keeps the good data; only a first failure is an error screen.
  const status: Load = mcp.loading ? 'loading' : mcp.error !== null && mcp.data.servers.length === 0 ? 'error' : 'ready';
  return <SkillsPanel projectName={projectName} skills={skills} connections={{ status, value: mcp.data }} onRetryConnections={mcp.refresh} projectsStatus={projectsStatus} />;
}
