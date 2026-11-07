/**
 * The Uitgebreid groups (WP B6): Modellen & taakverdeling, Gebruik & budget, Vaardigheden &
 * koppelingen, Paden, Diagnose and Over & updates. Every value is read from a real gateway route
 * (`/api/models`, `/api/usage`, `/api/tools`, `/api/mcp`, `/api/capabilities`, `/api/health`,
 * `/api/checkup`) or from the desktop app; what is unknown says so.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/primitives';
import { CheckupPanel } from '@/components/checkup/CheckupPanel';
import type { CheckupController } from '@/components/checkup/use-checkup';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayAccountUsage } from '@/prototype/state/gateway-adapter';
import {
  useGatewayCapabilities,
  useGatewayMcp,
  useGatewayModels,
  useGatewayTools,
} from '@/prototype/state/gateway-capabilities';
import { selectActiveProject, usePrototype } from '@/prototype/state/prototype-store';
import { useUiMode } from '@/state/ui-mode';
import { isReadingOutdated, readUsageMeter } from '@/views/chat/sessions/usage-reading';

import { SettingRow } from '../SettingRow';
import type { DesktopBridge } from '../settings-model';
import type { GatewayPaths } from '../use-gateway-paths';

export function RolesRow() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const models = useGatewayModels();
  const roles = models.data.roles;

  let body;
  if (models.loading) body = <p className="fs-set__muted">{t('settingsPage.rows.rollen.loading')}</p>;
  else if (roles.length === 0) body = <p className="fs-set__muted">{t('settingsPage.rows.rollen.empty')}</p>;
  else
    body = (
      <table className="fs-set__table">
        <thead>
          <tr>
            <th scope="col">{t('settingsPage.rows.rollen.colRole')}</th>
            <th scope="col">{t('settingsPage.rows.rollen.colModel')}</th>
            <th scope="col">{t('settingsPage.rows.rollen.colWhy')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.role}>
              {/* Role names and model ids are the English names from the logs (allowed in
                  Uitgebreid); the reason is the gateway's own text, shown as it is. */}
              <th scope="row" data-log-name="">{role.role}</th>
              <td className="fs-set__mono" data-log-name="">{role.model ?? '—'}</td>
              <td data-log-text="">{role.why ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <>
      <SettingRow
        rowId="rollen"
        title={t('settingsPage.rows.rollen.title')}
        feel={t('settingsPage.rows.rollen.feel')}
        note={t('settingsPage.rows.rollen.editFeel')}
        control={
          <Button size="sm" variant="ghost" onClick={() => navigate('/agents')}>
            {t('settingsPage.rows.rollen.edit')}
          </Button>
        }
      />
      <div className="fs-set__block">{body}</div>
    </>
  );
}

function formatReset(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Limiet (Gebruik): the 5-hour and the week percentage, read through `readUsageMeter` like every other usage
 * reading: a 5-hour value is only shown as now while the watcher runs and its window has not
 * reset yet. Watcher down: neither number is about now, the 5-hour one goes and the row says "Verouderd".
 * Window reset: the 5-hour value goes with a line saying so; the week value stays current.
 */
export function LimitRow() {
  const { t, locale } = useLocale();
  const usage = useGatewayAccountUsage();
  const reading = readUsageMeter(usage);
  const outdated = isReadingOutdated(reading);
  const restarted = reading.state === 'stale' && reading.staleReason === 'reset-passed';
  // Reset times only for values that are about now.
  const weekReset = reading.state === 'measured' || restarted ? formatReset(usage.guard.weekResetAt, locale) : null;
  const meters: { key: string; label: string; pct: number | null; reset: string | null }[] = [
    { key: 'five', label: t('settingsPage.rows.limiet.five'), pct: reading.session, reset: formatReset(reading.sessionResetAt, locale) },
    { key: 'week', label: t('settingsPage.rows.limiet.week'), pct: reading.week, reset: weekReset },
  ];
  let stateNote: string | null = null;
  if (outdated) stateNote = t('chat.usage.stale');
  else if (restarted) stateNote = t('chat.usage.sessionRestarted');
  return (
    <SettingRow
      rowId="limiet"
      state={reading.state}
      title={t('settingsPage.rows.limiet.title')}
      feel={t('settingsPage.rows.limiet.feel')}
      note={
        <span className="fs-set__meters">
          {meters.map((meter) => (
            <span key={meter.key} className="fs-meter" data-meter={meter.key}>
              <span className="fs-meter__label">
                <span>{meter.label}</span>
                <span>{meter.pct === null ? t('settingsPage.rows.limiet.unknown') : t('settingsPage.rows.limiet.percent', { pct: meter.pct })}</span>
              </span>
              {/* A meter always needs a value (axe aria-required-attr). An unknown value is only the plain text
                  above ("Nog niet gemeten"); its empty track is decoration. */}
              {meter.pct === null ? (
                <span className="fs-meter__track" aria-hidden="true">
                  <i style={{ transform: 'scaleX(0)' }} />
                </span>
              ) : (
                <span
                  className="fs-meter__track"
                  role="meter"
                  aria-label={meter.label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={meter.pct}
                >
                  <i style={{ transform: `scaleX(${meter.pct / 100})` }} />
                </span>
              )}
              {meter.reset ? <span className="fs-meter__reset">{t('settingsPage.rows.limiet.resets', { time: meter.reset })}</span> : null}
            </span>
          ))}
          {stateNote ? (
            <span className="fs-meter__reset fs-set__limit-state" role="status">
              {stateNote}
            </span>
          ) : null}
        </span>
      }
    />
  );
}

export function SkillsRow() {
  const { t } = useLocale();
  const { state } = usePrototype();
  const project = state.activeProjectId;
  const tools = useGatewayTools(project);
  const mcp = useGatewayMcp(project);
  const capabilities = useGatewayCapabilities(project);

  let note: string;
  if (project === '') note = t('settingsPage.rows.vaardigheden.noProject');
  else {
    const skillCount = capabilities.data.available ? capabilities.data.capabilities.length : tools.data.toolsCount;
    const parts = [
      skillCount === null || skillCount === undefined
        ? t('settingsPage.rows.vaardigheden.unknown')
        : t('settingsPage.rows.vaardigheden.skills', { count: skillCount }),
      mcp.data.serversCount === null
        ? t('settingsPage.rows.vaardigheden.unknown')
        : t('settingsPage.rows.vaardigheden.koppelingen', { count: mcp.data.serversCount, on: mcp.data.optedInCount ?? 0 }),
    ];
    note = parts.join(' · ');
  }
  return (
    <SettingRow
      rowId="vaardigheden"
      title={t('settingsPage.rows.vaardigheden.title')}
      feel={t('settingsPage.rows.vaardigheden.feel')}
      note={note}
    />
  );
}

function CopyButton({ text }: { readonly text: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="quiet"
      icon="Copy"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? t('settingsPage.rows.paden.copied') : t('settingsPage.rows.paden.copy')}
    </Button>
  );
}

export function PathsRow({ paths }: { readonly paths: GatewayPaths }) {
  const { t } = useLocale();
  const { state } = usePrototype();
  const project = selectActiveProject(state);
  const entries = [
    { key: 'project', label: t('settingsPage.rows.paden.project'), value: paths.projectRoot },
    { key: 'data', label: t('settingsPage.rows.paden.data'), value: paths.dataDir },
    { key: 'active', label: t('settingsPage.rows.paden.active'), value: project?.path ?? null },
  ];
  return (
    <>
      <SettingRow rowId="paden" title={t('settingsPage.rows.paden.title')} feel={t('settingsPage.rows.paden.feel')} />
      <dl className="fs-set__paths">
        {entries.map((entry) => (
          <div key={entry.key} className="fs-set__path-row">
            <dt>{entry.label}</dt>
            <dd>
              <span className="fs-set__path">{entry.value ?? t('settingsPage.rows.paden.unknown')}</span>
              {entry.value ? <CopyButton text={entry.value} /> : null}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function DiagnoseRow({ checkup, bridge }: { readonly checkup: CheckupController; readonly bridge: DesktopBridge | null }) {
  const { t } = useLocale();
  const { mode } = useUiMode();
  const navigate = useNavigate();
  return (
    <div className="fs-set__block fs-set__block--diagnose" data-row="diagnose">
      <p className="fs-set__feel fs-set__feel--group">
        <span className="fw-visually-hidden">{t('settingsPage.feelPrefix')}</span>
        {t('settingsPage.rows.diagnose.feel')}
      </p>
      <CheckupPanel
        controller={checkup}
        showPort
        showDiagnose
        hideHeading
        onChooseFolder={() => navigate('/projects')}
        diagnoseContext={{ versie: bridge?.version || t('settingsPage.rows.versie.dev'), weergave: mode }}
      />
    </div>
  );
}

export function VersionRow({ bridge }: { readonly bridge: DesktopBridge | null }) {
  const { t } = useLocale();
  const version = bridge?.version ? bridge.version : null;
  return (
    <SettingRow
      rowId="versie"
      title={t('settingsPage.rows.versie.title')}
      feel={t('settingsPage.rows.versie.feel')}
      control={version ? <span className="fs-set__mono">{version}</span> : <span className="fs-set__muted">{t('settingsPage.rows.versie.dev')}</span>}
    />
  );
}

export function UpdatesRow({ bridge }: { readonly bridge: DesktopBridge | null }) {
  const { t } = useLocale();
  return (
    <SettingRow
      rowId="updates"
      title={t('settingsPage.rows.updates.title')}
      feel={t('settingsPage.rows.updates.feel')}
      note={bridge?.version ? null : t('settingsPage.rows.updates.notInstalled')}
    />
  );
}

export function SmartScreenRow() {
  const { t } = useLocale();
  return <SettingRow rowId="smartscreen" title={t('settingsPage.rows.smartscreen.title')} feel={t('settingsPage.rows.smartscreen.feel')} />;
}
