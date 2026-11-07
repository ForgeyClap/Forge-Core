/**
 * Automatiseringen (/automations) — WP B5, plan §4.2 (Uitgebreid).
 *
 * Three things Forge can do by itself, each with its real state:
 *   - Geplande klussen: no gateway route exists yet. Shown as an honest empty list with the switch
 *     rendered disabled and labelled "nog niet gekoppeld" — never a toggle that does nothing.
 *   - Discord: opt-in, off by default. State from `GET /api/discord/status`; the on/off control
 *     lives on the existing Discord screen, which this links to.
 *   - Nachtdienst: the project's `nightshift` setting from `GET /api/config`. Status only; the
 *     switch mirrors the real value but is disabled ("nog niet gekoppeld") on this screen.
 * A down gateway shows an error with a retry; the last known state is never shown as current.
 */

import '../jobs/xpage.css';
import './automations.css';

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Icon, Switch } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { nightshiftState, summarizeDiscord } from '@/prototype/state/adapter/automations';
import type { DiscordSummary, NightshiftState } from '@/prototype/state/adapter/automations';
import { useGatewayForgeConfig } from '@/prototype/state/gateway-capabilities';
import { useGatewayDiscordStatus } from '@/prototype/state/gateway-discord';
import { usePrototype } from '@/prototype/state/prototype-store';

type Load = 'loading' | 'ready' | 'error';

export interface AutomationsPanelProps {
  readonly projectName: string;
  readonly discord: { readonly status: Load; readonly value: DiscordSummary | null };
  readonly nightshift: { readonly status: Load; readonly value: NightshiftState };
  readonly onOpenDiscord: () => void;
  readonly onRetry: () => void;
}

function Row({
  icon,
  title,
  feel,
  state,
  control,
  children,
}: {
  readonly icon: string;
  readonly title: string;
  readonly feel: string;
  readonly state: ReactNode;
  readonly control: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section className="fw-auto__row" aria-label={title}>
      <span className="fw-auto__glyph" aria-hidden="true">
        <Icon name={icon} size="md" />
      </span>
      <div className="fw-auto__main">
        <h2 className="fw-auto__title">{title}</h2>
        <p className="fw-auto__feel">{feel}</p>
        <div className="fw-auto__state">{state}</div>
        {children}
      </div>
      <div className="fw-auto__control">{control}</div>
    </section>
  );
}

function NotWired() {
  const { t } = useLocale();
  return (
    <span className="fw-auto__notwired" title={t('automations.notWiredWhy')}>
      <Icon name="Unplug" size="xs" />
      {t('automations.notWired')}
    </span>
  );
}

export function AutomationsPanel({ projectName, discord, nightshift, onOpenDiscord, onRetry }: AutomationsPanelProps) {
  const { t } = useLocale();
  const anyError = discord.status === 'error' || nightshift.status === 'error';

  const discordState = (() => {
    if (discord.status === 'loading') return <span className="fw-auto__muted">{t('automations.loading')}</span>;
    if (discord.status === 'error' || discord.value === null) return <span className="fw-auto__muted">{t('automations.error')}</span>;
    const d = discord.value;
    return (
      <>
        <span className="fw-auto__pill" data-on={d.state === 'running' ? 'true' : 'false'}>
          {t(`automations.discord.state.${d.state}`)}
        </span>
        {d.autostart !== null ? (
          <span className="fw-auto__muted">{d.autostart ? t('automations.discord.autostartOn') : t('automations.discord.autostartOff')}</span>
        ) : null}
      </>
    );
  })();

  const nightState = (() => {
    if (projectName === '') return <span className="fw-auto__muted">{t('automations.nightshift.noProject')}</span>;
    if (nightshift.status === 'loading') return <span className="fw-auto__muted">{t('automations.loading')}</span>;
    if (nightshift.status === 'error') return <span className="fw-auto__muted">{t('automations.error')}</span>;
    return (
      <span className="fw-auto__pill" data-on={nightshift.value === 'on' ? 'true' : 'false'}>
        {t(`automations.nightshift.${nightshift.value}`, { project: projectName })}
      </span>
    );
  })();

  return (
    <div className="fw-xpage fw-xpage--route">
      <header className="fw-xpage__header">
        <div className="fw-xpage__title">
          <h1>{t('automations.title')}</h1>
          <p>{t('automations.subtitle')}</p>
        </div>
      </header>
      <div className="fw-xpage__body">
        {anyError ? (
          <div className="fw-auto__alert" role="alert">
            <Icon name="TriangleAlert" size="sm" />
            <span>{t('automations.error')}</span>
            <Button variant="ghost" size="sm" icon="RotateCcw" onClick={onRetry}>
              {t('automations.retry')}
            </Button>
          </div>
        ) : null}

        <div className="fw-auto__list">
          <Row
            icon="CalendarClock"
            title={t('automations.schedules.title')}
            feel={t('automations.schedules.feel')}
            state={<span className="fw-auto__muted">{t('automations.schedules.empty')}</span>}
            control={
              <div className="fw-auto__control-stack">
                <Switch checked={false} onChange={() => undefined} label={t('automations.schedules.switch')} labelHidden disabled />
                <NotWired />
              </div>
            }
          />

          <Row
            icon="PlugZap"
            title={t('automations.discord.title')}
            feel={t('automations.discord.feel')}
            state={discordState}
            control={
              <Button variant="ghost" size="sm" iconRight="ArrowRight" onClick={onOpenDiscord}>
                {t('automations.discord.open')}
              </Button>
            }
          />

          <Row
            icon="Moon"
            title={t('automations.nightshift.title')}
            feel={t('automations.nightshift.feel')}
            state={nightState}
            control={
              <div className="fw-auto__control-stack">
                <Switch
                  checked={nightshift.status === 'ready' && nightshift.value === 'on'}
                  onChange={() => undefined}
                  label={t('automations.nightshift.switch')}
                  labelHidden
                  disabled
                />
                <NotWired />
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

export default function AutomationsView() {
  const { state } = usePrototype();
  const navigate = useNavigate();
  const projectName = state.activeProjectId;
  const discord = useGatewayDiscordStatus();
  const config = useGatewayForgeConfig(projectName);

  const discordLoad: Load = discord.loading ? 'loading' : discord.error !== null ? 'error' : 'ready';
  const configLoad: Load = config.loading ? 'loading' : config.error !== null ? 'error' : 'ready';

  return (
    <AutomationsPanel
      projectName={projectName}
      discord={{ status: discordLoad, value: discordLoad === 'ready' ? summarizeDiscord(discord.data) : null }}
      nightshift={{ status: configLoad, value: configLoad === 'ready' ? nightshiftState(config.data) : 'unknown' }}
      onOpenDiscord={() => navigate('/discord')}
      onRetry={() => config.refresh()}
    />
  );
}
