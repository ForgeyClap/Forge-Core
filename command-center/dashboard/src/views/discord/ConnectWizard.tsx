/**
 * ConnectWizard — the "Connect Discord" onboarding flow (WP-v290-B, beginner Discord onboarding).
 *
 * Renders ABOVE the classic Service/EnvKeys/Health panels in `DiscordView.tsx`, never instead of
 * them: an owner whose bot is already fully connected (`computeWizardStep(service) === 'done'`)
 * never sees this component mounted at all — see `DiscordView.tsx`'s own render for that gate.
 *
 * Five steps, ALL shown at once (a beginner can see the whole journey rather than one screen at a
 * time), each marked done/current/upcoming from real, live `DiscordService` state — never a
 * client-side "I clicked next" flag that could drift from reality:
 *   1. Make your own Discord server            — instructions + a link; nothing to poll for.
 *   2. Make the bot in the Developer Portal     — instructions + a link; nothing to poll for.
 *   3. Paste the token                          — the one real input in this whole flow.
 *   4. Get the bot into your server              — an invite-link button, OR (when the bot is
 *      already in several servers) a real picker built from `service.guilds`.
 *   5. Done                                      — the real detected server + whether an owner was
 *      auto-detected + a note about channel setup and the welcome message.
 *
 * Honest limits are shown once, always, regardless of step: why Forge cannot create the server
 * (a bot that creates a guild OWNS it), and why the bot itself must be made on Discord's own site
 * (there is no API for that step).
 */
import { Fragment, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { Button, Field, Icon, Panel } from '@/components/primitives';
import { requestDiscordConnect, requestDiscordSelectGuild } from '@/prototype/state/gateway-discord';
import type { DiscordService } from '@/prototype/state/gateway-discord';
import { computeWizardStep, findConnectedGuildName, ownerDetected } from './wizard-step';
import './connect-wizard.css';
import { useLocale } from '@/i18n/use-locale';

const MAKE_SERVER_URL = 'https://discord.com/channels/@me';
const DEV_PORTAL_URL = 'https://discord.com/developers/applications';

type StepState = 'done' | 'current' | 'upcoming';

/** Discord's own button and page names stay as Discord shows them; the copy places them via {placeholders}. */
function UiLabel({ children }: { children: ReactNode }) {
  return <strong className="fw-wizard__ui-label">{children}</strong>;
}

/** Splits `template` on its {placeholders} and puts the matching node in each slot. */
function richText(template: string, slots: Readonly<Record<string, ReactNode>>): ReactNode {
  return template.split(/(\{\w+\})/g).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const node = name !== undefined && Object.prototype.hasOwnProperty.call(slots, name) ? slots[name] : part;
    return <Fragment key={index}>{node}</Fragment>;
  });
}

function ExternalLinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="fw-control fw-button fw-button--ghost fw-button--md fw-wizard__link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="fw-button__label">{children}</span>
      <Icon name="ArrowRight" size="xs" className="fw-button__icon" />
    </a>
  );
}

function StepMarker({ state }: { state: StepState }) {
  return (
    <span className={`fw-wizard__marker fw-wizard__marker--${state}`}>
      {state === 'done' ? <Icon name="Check" size="xs" /> : null}
    </span>
  );
}

function WizardStep({
  number,
  title,
  state,
  children,
}: {
  number: number;
  title: string;
  state: StepState;
  children: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <li className={`fw-wizard__step fw-wizard__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
      <div className="fw-wizard__step-head">
        <StepMarker state={state} />
        <span className="fw-wizard__step-eyebrow">{t('rd.discord.wizard.step', { number })}</span>
        <h3 className="fw-wizard__step-title">{title}</h3>
      </div>
      <div className="fw-wizard__step-body">{children}</div>
    </li>
  );
}

export default function ConnectWizard({
  service,
  onChanged,
}: {
  service: DiscordService;
  onChanged: () => void;
}) {
  const { t } = useLocale();
  const step = computeWizardStep(service);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pickingGuildId, setPickingGuildId] = useState<string | null>(null);
  const [guildError, setGuildError] = useState<string | null>(null);

  const tokenSaved = service.envKeys.some((key) => key.name === 'DISCORD_BOT_TOKEN' && key.present);
  const setupStepState: StepState = tokenSaved ? 'done' : 'current';
  const tokenStepState: StepState = step === 'token' ? 'current' : 'done';
  // 'awaiting-setup' (Codex finding 7): the bot is alive on the real transport but we cannot verify
  // it actually finished setting up, nor which server it is in. W3FX-BC: a step is never ticked while
  // its own text still says it is waiting, so step 4 stays open ('current', waiting for the bot to
  // report its server) and step 5 keeps its honest waiting message rather than a premature "Done".
  const inviteStepState: StepState =
    step === 'invite' || step === 'guild' || step === 'awaiting-setup' ? 'current' : step === 'done' ? 'done' : 'upcoming';
  const doneStepState: StepState = step === 'done' ? 'done' : 'upcoming';
  const hintId = 'fw-discord-token-hint';

  async function handleConnect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = token.trim();
    if (trimmed.length === 0 || connecting) return;
    setConnecting(true);
    setConnectError(null);
    // Codex finding K3-9: the pasted token must never linger in React state past this one
    // submission, success OR failure — `finally` clears it unconditionally, rather than only on
    // the success path, so a rejected/failed attempt never leaves it sitting in memory (or visible
    // in the password field) any longer than the single request that just used it.
    try {
      const result = await requestDiscordConnect(trimmed);
      if (!result.ok) {
        setConnectError(result.error ?? t('rd.discord.wizard.key.saveFailed'));
        return;
      }
      onChanged();
    } finally {
      setConnecting(false);
      setToken('');
    }
  }

  async function handlePickGuild(guildId: string): Promise<void> {
    if (pickingGuildId !== null) return;
    setPickingGuildId(guildId);
    setGuildError(null);
    const result = await requestDiscordSelectGuild(guildId);
    setPickingGuildId(null);
    if (!result.ok) {
      setGuildError(result.error ?? t('rd.discord.wizard.invite.pickFailed'));
      return;
    }
    onChanged();
  }

  return (
    <Panel
      title={t('rd.discord.wizard.title')}
      subtitle={t('rd.discord.wizard.subtitle')}
      className="fw-wizard"
    >
      <ol className="fw-wizard__list">
        <WizardStep number={1} title={t('rd.discord.wizard.server.title')} state={setupStepState}>
          <p className="fw-wizard__copy">{t('rd.discord.wizard.server.copy')}</p>
          <ExternalLinkButton href={MAKE_SERVER_URL}>{t('rd.discord.wizard.server.open')}</ExternalLinkButton>
        </WizardStep>

        <WizardStep number={2} title={t('rd.discord.wizard.bot.title')} state={setupStepState}>
          <p className="fw-wizard__copy">
            {richText(t('rd.discord.wizard.bot.copy'), {
              newApp: <UiLabel>New Application</UiLabel>,
              bot: <UiLabel>Bot</UiLabel>,
              reset: <UiLabel>Reset Token</UiLabel>,
            })}{' '}
            {richText(t('rd.discord.wizard.bot.copy2'), { intent: <UiLabel>Message Content Intent</UiLabel> })}
          </p>
          <ExternalLinkButton href={DEV_PORTAL_URL}>{t('rd.discord.wizard.bot.open')}</ExternalLinkButton>
        </WizardStep>

        <WizardStep number={3} title={t('rd.discord.wizard.key.title')} state={tokenStepState}>
          <form className="fw-wizard__form" onSubmit={(event) => void handleConnect(event)}>
            <Field
              label={t('rd.discord.wizard.key.label')}
              htmlFor="fw-discord-token"
              hint={t('rd.discord.wizard.key.hint')}
              hintId={hintId}
            >
              <div className="fw-wizard__row">
                <input
                  id="fw-discord-token"
                  className="fw-control fw-wizard__input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={hintId}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={t('rd.discord.wizard.key.paste')}
                />
                <Button type="submit" variant="primary" disabled={connecting || token.trim().length === 0}>
                  {connecting ? t('rd.discord.wizard.key.connecting') : t('rd.discord.wizard.key.connect')}
                </Button>
              </div>
            </Field>
          </form>
          {connectError !== null ? (
            <p className="fw-wizard__alert" role="alert">
              <Icon name="TriangleAlert" size="sm" />
              <span>{connectError}</span>
            </p>
          ) : null}
          {service.loginError !== null && step === 'token' ? (
            <p className="fw-wizard__alert" role="alert">
              <Icon name="TriangleAlert" size="sm" />
              <span>{service.loginError}</span>
            </p>
          ) : null}
          {/* WP-P1: an honest status for the ONE-TIME automatic install of the bot's own
              software — polled independently of this step's own "Connecting…" button label, so
              it shows even while a slow first install is still running in the background. */}
          {service.depsInstallPhase === 'installing' ? (
            <p className="fw-wizard__copy fw-wizard__copy--muted">{t('rd.discord.wizard.key.installing')}</p>
          ) : null}
          {service.depsInstallPhase === 'failed' ? (
            <p className="fw-wizard__alert" role="alert">
              <Icon name="TriangleAlert" size="sm" />
              <span>{service.depsInstallError ?? t('rd.discord.wizard.key.installFailed')}</span>
            </p>
          ) : null}
        </WizardStep>

        <WizardStep number={4} title={t('rd.discord.wizard.invite.title')} state={inviteStepState}>
          {step === 'guild' ? (
            <div className="fw-wizard__guild-picker">
              <p className="fw-wizard__copy">{t('rd.discord.wizard.invite.pick', { count: service.guilds.length })}</p>
              <div className="fw-wizard__guild-options">
                {service.guilds.map((guild) => (
                  <Button
                    key={guild.id}
                    variant="ghost"
                    disabled={pickingGuildId !== null}
                    onClick={() => void handlePickGuild(guild.id)}
                  >
                    {pickingGuildId === guild.id ? t('rd.discord.wizard.key.connecting') : guild.name}
                  </Button>
                ))}
              </div>
              {guildError !== null ? (
                <p className="fw-wizard__alert" role="alert">
                  <Icon name="TriangleAlert" size="sm" />
                  <span>{guildError}</span>
                </p>
              ) : null}
            </div>
          ) : service.inviteUrl !== null ? (
            <>
              <p className="fw-wizard__copy">
                {richText(t('rd.discord.wizard.invite.copy'), { authorise: <UiLabel>Authorise</UiLabel> })}
              </p>
              <ExternalLinkButton href={service.inviteUrl}>{t('rd.discord.wizard.invite.open')}</ExternalLinkButton>
            </>
          ) : (
            <p className="fw-wizard__copy fw-wizard__copy--muted">
              {step === 'awaiting-setup' ? t('rd.discord.wizard.invite.waitServer') : t('rd.discord.wizard.invite.waitLogin')}
            </p>
          )}
        </WizardStep>

        <WizardStep number={5} title={t('rd.discord.wizard.done.title')} state={doneStepState}>
          {step === 'done' ? (
            <ul className="fw-wizard__done-list">
              <li>
                <Icon name="CircleCheck" size="xs" />
                <span>
                  {t('rd.discord.wizard.done.connected', {
                    server: findConnectedGuildName(service) ?? t('rd.discord.wizard.done.yourServer'),
                  })}
                </span>
              </li>
              <li>
                <Icon name={ownerDetected(service) ? 'CircleCheck' : 'TriangleAlert'} size="xs" />
                <span>
                  {ownerDetected(service) ? t('rd.discord.wizard.done.ownerFound') : t('rd.discord.wizard.done.ownerMissing')}
                </span>
              </li>
              <li>
                <Icon name="CircleCheck" size="xs" />
                <span>
                  {t('rd.discord.wizard.done.channels', { category: '🔨 FORGE PROJECTS', channel: '#forge-info' })}
                </span>
              </li>
            </ul>
          ) : step === 'awaiting-setup' ? (
            // Codex finding 7: an older bot that does not report `setup_state` at all is alive on
            // the real transport, but that alone never proves setup actually finished — show the
            // honest unknown instead of guessing "Done".
            <p className="fw-wizard__copy fw-wizard__copy--muted">{t('rd.discord.wizard.done.waitSetup')}</p>
          ) : (
            <p className="fw-wizard__copy fw-wizard__copy--muted">{t('rd.discord.wizard.done.finishFirst')}</p>
          )}
        </WizardStep>
      </ol>

      <div className="fw-wizard__limits">
        <p className="fw-wizard__limit">
          <Icon name="TriangleAlert" size="xs" />
          <span>{t('rd.discord.wizard.limit.server')}</span>
        </p>
        <p className="fw-wizard__limit">
          <Icon name="TriangleAlert" size="xs" />
          <span>{t('rd.discord.wizard.limit.bot')}</span>
        </p>
      </div>
    </Panel>
  );
}
