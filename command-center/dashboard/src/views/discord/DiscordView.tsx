/**
 * Discord — the dedicated tab for the Discord↔Forge remote-control bot (
 *).
 *
 * Everything here reads `GET /api/discord/status` through `useGatewayDiscordStatus`
 * (`gateway-discord.ts`) and writes through `requestDiscordStart`/`requestDiscordStop` — the
 * fixed contract this WP was built against, not the gateway's implementation (a parallel Build
 * Boss owns that side; this view never reads `gateway/` source).
 *
 * Three honest states, never collapsed into one generic empty box:
 *   1. `!service.installed` — a distinct empty state ("not installed"), never confused with
 *      "installed but stopped".
 *   2. installed, real service panels — status, environment keys (names/presence only, never a
 *      value), and the bot's own health passthrough rendered defensively (only the fields that
 *      actually exist).
 *   3. a transport error from the status poll itself — shown alongside whatever data is still
 *      known, never wiping it.
 *
 * The on/off switch is never optimistic: it always reflects `service.running` from the last
 * real poll. Clicking it fires the real start/stop request, shows a pending line while the
 * request is in flight, and shows the gateway's own error text verbatim (409 conflict included)
 * on failure — the switch only ever visibly flips once the next status poll confirms it.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import { EmptyState, Icon, Machine, Panel, Switch } from '@/components/primitives';
import type { Locale, Translate } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { LocalTime } from '@/views/activity/LocalTime';
import {
  requestDiscordStart,
  requestDiscordStop,
  useGatewayDiscordStatus,
} from '@/prototype/state/gateway-discord';
import type { DiscordService } from '@/prototype/state/gateway-discord';
import BotActivitySection from './BotActivitySection';
import ConnectWizard from './ConnectWizard';
import ProjectsDirSection from './ProjectsDirSection';
import { formatHealthValue, healthKeyLabel } from './health-format';
import { computeWizardStep } from './wizard-step';
import './discord.css';

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

type C = Translate;

function transportHint(transport: string | null, t: C): string {
  if (transport === 'mock') return t('rd.discord.transport.mock');
  if (transport === 'discord') return t('rd.discord.transport.live');
  return t('rd.discord.notReported');
}

/** WP-DA: "will the bot come back by itself when the Command Center starts?", in plain words.
 *  Codex DA-1: "YES" only when the gateway says it will really try (`effective`: setting on, not switched
 *  off, installed AND connected) and the last automatic start did not fail; every other case names the
 *  reason. Codex DA-2: a failed save of the owner's choice comes first, because it makes the rest unsure. */
function autostartText(autostart: DiscordService['autostart'], t: C): { value: string; hint: string } {
  if (autostart === null) return { value: '—', hint: t('rd.discord.notReported') };
  const last =
    autostart.lastOutcome !== null && autostart.lastDetail !== null ? t('rd.discord.auto.last', { detail: autostart.lastDetail }) : '';
  const withLast = (main: string) => (last === '' ? main : `${main} ${last}`);
  if (autostart.saveError !== null) {
    return { value: t('rd.discord.auto.unsure'), hint: withLast(t('rd.discord.auto.saveError', { error: autostart.saveError })) };
  }
  if (autostart.setting === false) return { value: t('rd.discord.auto.no'), hint: withLast(t('rd.discord.auto.settingOff')) };
  if (autostart.desired === 'stopped') return { value: t('rd.discord.auto.no'), hint: withLast(t('rd.discord.auto.desiredStopped')) };
  if (autostart.setting === null) return { value: t('rd.discord.auto.no'), hint: withLast(t('rd.discord.auto.settingUnknown')) };
  if (autostart.envOptOut) return { value: t('rd.discord.auto.no'), hint: withLast(t('rd.discord.auto.envOptOut')) };
  if (autostart.desiredInvalid) {
    const note = autostart.desiredNote !== null ? ` (${autostart.desiredNote})` : '';
    return { value: t('rd.discord.auto.no'), hint: withLast(t('rd.discord.auto.desiredInvalid', { note })) };
  }
  if (!autostart.ready) {
    return {
      value: t('rd.discord.auto.notYet'),
      hint: t('rd.discord.auto.notReady', { reason: autostart.readyReason ?? t('rd.discord.auto.notReadyReason') }),
    };
  }
  if (autostart.conflict !== null) {
    return { value: t('rd.discord.auto.blocked'), hint: t('rd.discord.auto.conflict', { conflict: autostart.conflict }) };
  }
  if (!autostart.effective) return { value: t('rd.discord.auto.no'), hint: withLast(t('rd.discord.auto.notEffective')) };
  if (autostart.lastOutcome === 'failed') {
    return {
      value: t('rd.discord.auto.failed'),
      hint: t('rd.discord.auto.lastFailed', { detail: autostart.lastDetail ?? t('rd.discord.auto.noReason') }),
    };
  }
  return { value: t('rd.discord.auto.yes'), hint: withLast(t('rd.discord.auto.on')) };
}

/* ------------------------------------------------------------------ panels */

function ServicePanel({
  service,
  pending,
  actionError,
  actionWarning,
  onToggle,
}: {
  service: DiscordService;
  pending: 'start' | 'stop' | null;
  actionError: string | null;
  /** WP-DA (Codex DA-2): the switch worked, but the gateway could not save the choice — shown verbatim. */
  actionWarning: string | null;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useLocale();
  const autostart = autostartText(service.autostart, t);
  return (
    <Panel
      title={t('rd.discord.service.title')}
      subtitle={t('rd.discord.service.subtitle')}
      actions={
        <Switch
          checked={service.running}
          onChange={onToggle}
          disabled={pending !== null}
          label={service.running ? t('rd.discord.service.switchOn') : t('rd.discord.service.switchOff')}
        />
      }
    >
      {pending !== null ? (
        <p className="fw-discord__pending" role="status">
          <Icon name="Loader" size="xs" spin />
          <span>{pending === 'start' ? t('rd.discord.service.starting') : t('rd.discord.service.stopping')}</span>
        </p>
      ) : null}

      {actionError !== null ? (
        <p className="fw-discord__alert" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          <span>{actionError}</span>
        </p>
      ) : null}

      {actionWarning !== null ? (
        <p className="fw-discord__alert" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          <span>{actionWarning}</span>
        </p>
      ) : null}

      {service.conflict !== null ? (
        <p className="fw-discord__alert" role="alert">
          <Icon name="TriangleAlert" size="sm" />
          <span>{service.conflict}</span>
        </p>
      ) : null}

      <div className="fw-discord__rows">
        <Row label={t('rd.discord.service.status')} hint={t('rd.discord.service.statusHint')}>
          <span>{service.running ? t('rd.discord.service.running') : t('rd.discord.service.stopped')}</span>
        </Row>
        <Row label={t('rd.discord.service.autostart')} hint={autostart.hint}>
          <span className="fw-discord-quiet">{autostart.value}</span>
        </Row>
        <Row label={t('rd.discord.service.pid')}>
          <Machine muted>{service.pid ?? '—'}</Machine>
        </Row>
        <Row label={t('rd.discord.service.startedAt')}>
          <LocalTime value={service.startedAt} muted={false} className="fw-discord-quiet fw-discord-num" />
        </Row>
        <Row label={t('rd.discord.service.transport')} hint={transportHint(service.transport, t)}>
          <Machine muted>{service.transport ?? '—'}</Machine>
        </Row>
        <Row label={t('rd.discord.service.botPort')}>
          <Machine muted>{service.ports.bot ?? '—'}</Machine>
        </Row>
        <Row label={t('rd.discord.service.stateDir')}>
          <Machine muted className="fw-discord__row-path">
            {service.stateDir || '—'}
          </Machine>
        </Row>
        <Row label={t('rd.discord.service.logFile')}>
          <Machine muted className="fw-discord__row-path">
            {service.logFile || '—'}
          </Machine>
        </Row>
      </div>
    </Panel>
  );
}

function EnvKeysPanel({ envKeys }: { envKeys: DiscordService['envKeys'] }) {
  const { t } = useLocale();
  return (
    <Panel title={t('rd.discord.env.title')} subtitle={t('rd.discord.env.subtitle')}>
      {envKeys.length === 0 ? (
        <EmptyState compact icon="Cable" title={t('rd.discord.env.empty')} />
      ) : (
        <ul className="fw-discord__env-list">
          {envKeys.map((key) => (
            <li key={key.name} className="fw-discord__env-item">
              <Machine className="fw-discord__env-name fw-truncate">{key.name}</Machine>
              <span
                className={
                  key.present ? 'fw-discord__env-chip is-present' : 'fw-discord__env-chip is-missing'
                }
              >
                <Icon name={key.present ? 'Check' : 'X'} size="xs" />
                <span>{key.present ? t('rd.discord.env.present') : t('rd.discord.env.missing')}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function HealthPanel({ health, locale }: { health: DiscordService['health']; locale: Locale }) {
  const { t } = useLocale();
  return (
    <Panel title={t('rd.discord.health.title')} subtitle={t('rd.discord.health.subtitle')}>
      {health === null ? (
        <p className="fw-discord__health-empty">{t('rd.discord.health.unreachable')}</p>
      ) : Object.keys(health).length === 0 ? (
        <p className="fw-discord__health-empty">{t('rd.discord.health.emptyReport')}</p>
      ) : (
        <ul className="fw-discord__health-list">
          {Object.entries(health).map(([key, value]) => (
            <li key={key} className="fw-discord__health-item">
              <span className="fw-discord__health-key" title={key}>
                {healthKeyLabel(key, locale)}
              </span>
              <span className="fw-discord__health-value">{formatHealthValue(key, value, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------- view */

export default function DiscordView() {
  const status = useGatewayDiscordStatus();
  const { t, locale } = useLocale();
  const [pending, setPending] = useState<'start' | 'stop' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);

  async function handleToggle(next: boolean): Promise<void> {
    if (pending !== null) return;
    setActionError(null);
    setActionWarning(null);
    setPending(next ? 'start' : 'stop');
    const result = next ? await requestDiscordStart() : await requestDiscordStop();
    setPending(null);
    if (!result.ok) {
      setActionError(result.error ?? t('rd.discord.actionFailed'));
      return;
    }
    // WP-DA (Codex DA-2): the switch worked, but the choice was not saved — never a silent success.
    if (result.warning !== null) setActionWarning(result.warning);
  }

  const service = status.data;

  return (
    <div className="fw-discord">
      <header className="fw-discord__head">
        <div className="fw-discord__heading">
          <h1 className="fw-discord__title">{t('nav.discord.label')}</h1>
          <p className="fw-discord__subtitle">{t('nav.discord.description')}</p>
        </div>
      </header>

      <div className="fw-discord__body fw-scroll">
        <div className="fw-discord__panels">
          {status.error !== null ? (
            <p className="fw-discord__transport-error" role="alert">
              <Icon name="Unplug" size="sm" />
              <span>{t('rd.discord.unreachable', { error: status.error })}</span>
            </p>
          ) : null}

          {status.loading ? (
            <EmptyState icon="Loader" title={t('rd.discord.loading')} compact />
          ) : !service.installed ? (
            <EmptyState
              icon="PackageOpen"
              title={t('rd.discord.notInstalled')}
              detail={t('rd.discord.notInstalledDetail')}
            />
          ) : (
            <>
              {/* WP-v290-B: purely ADDITIVE — shown only while setup genuinely is not done yet
                  (no token, awaiting invite/guild pick, or a failed login). An already-connected
                  owner never sees this; the classic panels below are completely unchanged. */}
              {computeWizardStep(service) !== 'done' ? (
                <ConnectWizard service={service} onChanged={() => {}} />
              ) : null}
              <ServicePanel
                service={service}
                pending={pending}
                actionError={actionError}
                actionWarning={actionWarning}
                onToggle={(next) => void handleToggle(next)}
              />
              {/* v2.9.0 (audit finding 31): the bot's own jobs and recorded cost, which no view showed before. */}
              <BotActivitySection />
              {/* WP-S1: shown regardless of wizard step — before connecting, the folder choice is
                  simply stored and picked up the next time the bot starts. */}
              <ProjectsDirSection />
              <EnvKeysPanel envKeys={service.envKeys} />
              <HealthPanel health={service.health} locale={locale} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
