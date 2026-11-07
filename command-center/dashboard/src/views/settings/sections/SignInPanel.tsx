/**
 * Sign-in help for the accounts that log in through their own program (Claude Code, Codex): the official
 * command in a copy box, one plain explanation, and "Opnieuw controleren". Forge never signs in for you
 * and never reads a sign-in; it only shows the command (WP B2 part 2).
 */

import { useState } from 'react';

import { Button } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { SIGN_IN_COMMANDS } from '@/prototype/state/adapter/providers';
import type { SignInProgram } from '@/prototype/state/adapter/providers';

const COPIED_MS = 2000;

export function CopyCommand({ command }: { readonly command: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="fs-prov__cmd">
      <code aria-label={t('checkup.command')}>{command}</code>
      <Button
        size="sm"
        variant="quiet"
        icon="Copy"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), COPIED_MS);
            })
            .catch(() => undefined);
        }}
      >
        {copied ? t('checkup.copied') : t('checkup.copyCommand')}
      </Button>
    </div>
  );
}

export interface SignInPanelProps {
  readonly program: SignInProgram;
  readonly signedIn: boolean;
  readonly onRecheck: () => void;
  readonly panelId?: string;
}

export function SignInPanel({ program, signedIn, onRecheck, panelId }: SignInPanelProps) {
  const { t } = useLocale();
  const command = signedIn ? SIGN_IN_COMMANDS[program].logout : SIGN_IN_COMMANDS[program].login;
  let explain: MessageKey;
  if (signedIn) explain = 'settingsPage.accounts.signIn.logoutExplain';
  else explain = program === 'claude' ? 'settingsPage.accounts.signIn.explainClaude' : 'settingsPage.accounts.signIn.explainCodex';
  return (
    <div className="fs-prov__signin" id={panelId}>
      <p>{t(explain)}</p>
      <CopyCommand command={command} />
      <div className="fs-prov__signin-foot">
        <span>{t('settingsPage.accounts.signIn.after')}</span>
        <Button size="sm" variant="quiet" icon="RefreshCw" onClick={onRecheck}>
          {t('settingsPage.accounts.signIn.recheck')}
        </Button>
      </div>
    </div>
  );
}
