/**
 * AddAccountChooser — "Account toevoegen" (DESIGN.md §3.4): the same four choices as onboarding step 2
 * (Claude, ChatGPT, Gratis op deze pc, Eigen sleutel of server), then one honest next step per choice:
 *
 * - Claude / ChatGPT: the official sign-in command to copy (Forge never signs in for you). When Claude is
 *   already signed in, the next step is an extra Claude account through the router's own dialog.
 * - Gratis op deze pc: what the pc check found about Ollama, with the one command that fixes it.
 * - Eigen sleutel of server: the Eigen API form (unchanged validation and URL rules). In Eenvoudig this is
 *   the way into Eigen API.
 *
 * The choice list is the primitive from 1B (`ChoiceList`), not an import from onboarding.
 */

import { useState } from 'react';

import { Button, ChoiceList, Modal } from '@/components/primitives';
import { FIX_COMMANDS } from '@/components/checkup/checkup-model';
import type { CheckupController } from '@/components/checkup/use-checkup';
import { useLocale } from '@/i18n/use-locale';
import { toneOf } from '@/prototype/state/adapter/providers';
import type { ProviderRow, VaultKeyStatus } from '@/prototype/state/adapter/providers';
import { useCustomProviders } from '@/prototype/state/adapter/providers-custom';
import type { CustomProviderEntry } from '@/prototype/state/adapter/providers-custom';

import { canAddClaudeAccount, requestAddClaudeAccount } from './app-router/router-events';
import { CustomApiForm } from './custom-api/CustomApiForm';
import { CopyCommand, SignInPanel } from './SignInPanel';

type Choice = 'claude' | 'chatgpt' | 'free' | 'own';

const PROVIDER_OF: Readonly<Record<'claude' | 'chatgpt', string>> = { claude: 'claude-code-cli', chatgpt: 'codex-cli' };

export interface AddAccountChooserProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The live provider list, or null when the gateway has none. */
  readonly providers: readonly ProviderRow[] | null;
  readonly vaultKeys: readonly VaultKeyStatus[];
  readonly checkup: CheckupController;
  /** Re-read the account lists and the pc check. */
  readonly onRecheck: () => void;
  /** An Eigen API entry was saved here: the Eigen API group (Uitgebreid) re-reads its own list. */
  readonly onCustomSaved?: () => void;
}

function noop(): void {}

export function AddAccountChooser({ open, onClose, providers, vaultKeys, checkup, onRecheck, onCustomSaved }: AddAccountChooserProps) {
  const { t } = useLocale();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [step, setStep] = useState<'choose' | 'next'>('choose');

  function close() {
    setStep('choose');
    setChoice(null);
    onClose();
  }

  const options = [
    { value: 'claude', letter: 'C', title: t('rd.onboarding.choose.claude'), description: t('rd.onboarding.choose.claudeHint') },
    { value: 'chatgpt', letter: 'G', title: t('rd.onboarding.choose.chatgpt'), description: t('rd.onboarding.choose.chatgptHint') },
    { value: 'free', icon: 'Cpu', title: t('rd.onboarding.choose.free'), description: t('rd.onboarding.choose.freeHint') },
    { value: 'own', icon: 'KeyRound', title: t('rd.onboarding.choose.own'), description: t('rd.onboarding.choose.ownHint') },
  ];
  const chosenTitle = options.find((option) => option.value === choice)?.title ?? t('rd.settings.accounts.add');

  const footer =
    step === 'choose' ? (
      <>
        <Button variant="quiet" onClick={close}>
          {t('settingsPage.rows.wissen.cancel')}
        </Button>
        <Button variant="primary" disabled={choice === null} onClick={() => setStep('next')}>
          {t('rd.onboarding.next')}
        </Button>
      </>
    ) : (
      <>
        <Button variant="quiet" icon="ArrowLeft" onClick={() => setStep('choose')}>
          {t('rd.onboarding.back')}
        </Button>
        {/* The Eigen API form has its own Opslaan and Klaar; a second "Klaar" here would compete. */}
        {choice === 'own' ? null : (
          <Button variant="primary" onClick={close}>
            {t('rd.tour.done')}
          </Button>
        )}
      </>
    );

  return (
    <Modal
      open={open}
      onClose={close}
      title={step === 'choose' ? t('rd.settings.accounts.addTitle') : chosenTitle}
      size={step === 'next' && choice === 'own' ? 'lg' : 'md'}
      className="fs-addacct"
      footer={footer}
    >
      {step === 'choose' ? (
        <ChoiceList
          options={options}
          value={choice}
          onChange={(value) => setChoice(value as Choice)}
          label={t('rd.settings.accounts.addTitle')}
        />
      ) : null}
      {step === 'next' && (choice === 'claude' || choice === 'chatgpt') ? (
        <SignInStep choice={choice} providers={providers} checkup={checkup} onRecheck={onRecheck} onExtraClaude={() => {
          close();
          requestAddClaudeAccount();
        }} />
      ) : null}
      {step === 'next' && choice === 'free' ? <OllamaStep checkup={checkup} onRecheck={onRecheck} /> : null}
      {step === 'next' && choice === 'own' ? (
        <OwnApiStep providers={providers} vaultKeys={vaultKeys} onChanged={onRecheck} onCustomSaved={onCustomSaved ?? noop} onClose={close} />
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------- sign-in */

function SignInStep({
  choice,
  providers,
  checkup,
  onRecheck,
  onExtraClaude,
}: {
  readonly choice: 'claude' | 'chatgpt';
  readonly providers: readonly ProviderRow[] | null;
  readonly checkup: CheckupController;
  readonly onRecheck: () => void;
  readonly onExtraClaude: () => void;
}) {
  const { t } = useLocale();
  const row = providers?.find((item) => item.id === PROVIDER_OF[choice]) ?? null;
  // Without the provider list, the pc check is the only honest source (Claude only reports a sign-in).
  const signedIn = row ? row.status === 'connected' : choice === 'claude' && checkup.result?.claude.signedIn === true;
  const program = choice === 'claude' ? 'claude' : 'codex';

  if (signedIn) {
    const name = choice === 'claude' ? t('settingsPage.accounts.claude.name') : t('settingsPage.accounts.chatgpt.name');
    return (
      <div className="fs-addacct__step">
        <p className="fs-addacct__state">
          <b>{name}</b>
          <span className="fs-pill" data-tone={row ? toneOf(row.status) : 'ok'}>
            <span className="fs-pill__dot" aria-hidden="true" />
            {t('settingsPage.accounts.status.connected')}
          </span>
        </p>
        {choice === 'claude' && canAddClaudeAccount() ? (
          <Button variant="secondary" icon="Plus" onClick={onExtraClaude}>
            {t('appRouter.add.title')}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="fs-addacct__step">
      <SignInPanel program={program} signedIn={false} onRecheck={onRecheck} />
    </div>
  );
}

/* -------------------------------------------------------------- Ollama */

function OllamaStep({ checkup, onRecheck }: { readonly checkup: CheckupController; readonly onRecheck: () => void }) {
  const { t } = useLocale();
  const ollama = checkup.result?.ollama ?? null;
  let line: string;
  let help: string | null = null;
  let command: string | null = null;
  if (ollama === null) line = t('settingsPage.accounts.status.checking');
  else if (ollama.up) line = t('checkup.rows.ollama.ok', { count: ollama.models.length });
  else if (ollama.found) {
    line = t('checkup.rows.ollama.stopped');
    help = t('checkup.help.startOllama');
    command = FIX_COMMANDS.startOllama ?? null;
  } else {
    line = t('checkup.rows.ollama.fail');
    help = t('checkup.help.installOllama');
    command = FIX_COMMANDS.installOllama ?? null;
  }
  return (
    <div className="fs-addacct__step">
      <p className="fs-addacct__line" role="status">
        {line}
      </p>
      {help ? <p className="fs-addacct__help">{help}</p> : null}
      {command ? <CopyCommand command={command} /> : null}
      <div className="fs-prov__signin-foot">
        <Button size="sm" variant="quiet" icon="RefreshCw" onClick={onRecheck}>
          {t('settingsPage.accounts.signIn.recheck')}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Eigen API */

function OwnApiStep({
  providers,
  vaultKeys,
  onChanged,
  onCustomSaved,
  onClose,
}: {
  readonly providers: readonly ProviderRow[] | null;
  readonly vaultKeys: readonly VaultKeyStatus[];
  readonly onChanged: () => void;
  readonly onCustomSaved: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useLocale();
  const custom = useCustomProviders();
  const [saved, setSaved] = useState<{ readonly entry: CustomProviderEntry; readonly revision: number } | null>(null);

  if (custom.load === 'loading') {
    return (
      <p className="fs-capi__state" role="status">
        {t('customApi.loading')}
      </p>
    );
  }
  if (custom.load === 'missing') return <p className="fs-capi__state">{t('customApi.missing')}</p>;
  if (custom.load === 'error') {
    return (
      <div className="fs-capi__state fs-capi__state--problem">
        <span>{t('customApi.loadError')}</span>
        <Button size="sm" variant="quiet" icon="RefreshCw" onClick={custom.reload}>
          {t('customApi.retry')}
        </Button>
      </div>
    );
  }
  const id = saved?.entry.id ?? '';
  // Same rule as the Eigen API group: the newest of "what this save returned" and "what the list says",
  // so a 409 that re-read the list lets the next Opslaan through.
  const revision = saved !== null && saved.revision >= custom.list.revision ? saved.revision : custom.list.revision;
  return (
    <CustomApiForm
      entry={saved?.entry ?? null}
      revision={revision}
      onSaved={(entry, nextRevision) => {
        setSaved({ entry, revision: nextRevision });
        onChanged();
        onCustomSaved();
      }}
      onStale={custom.reload}
      onClose={onClose}
      vaultStatus={vaultKeys.find((key) => key.providerId === id) ?? null}
      keySource={providers?.find((row) => row.id === id)?.keySource ?? null}
      onKeyChanged={onChanged}
      titleInDialog
    />
  );
}
