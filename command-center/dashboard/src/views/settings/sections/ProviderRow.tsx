/**
 * ProviderRow — one account row of Settings › Accounts (WP B2 part 2; v1.0 redesign DESIGN.md §3.4).
 *
 * A letter tile, the name, one short sub-line (who pays, in two or three words), the status as a dot and
 * a word, and a `...` menu: Testen (the gateway's cheapest real call, result redacted), Inloggen or
 * Uitloggen for the sign-in accounts (which only SHOW the official program's command; Forge never signs
 * in for you and never reads a sign-in) and "Over dit account" (who pays in full, and the terms notice
 * with its date). A key account keeps its one key field under the row (`KeyField`, desktop app only).
 */

import { useId, useState } from 'react';

import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { payerOf, signInProgram, testProvider, toneOf } from '@/prototype/state/adapter/providers';
import type { ProviderPayer, ProviderRow as ProviderRowData, ProviderTestResult, VaultKeyStatus } from '@/prototype/state/adapter/providers';
import { KeyField } from '@/views/onboarding/KeyField';

import { TOS_CHECKED_AT } from '../settings-model';
import { formatTermsDate } from './accounts-model';
import { RowMenu } from './RowMenu';
import type { RowMenuItem } from './RowMenu';
import { SignInPanel } from './SignInPanel';

/** Dutch names for the accounts whose registry label is English or carries jargon. */
const NAME_KEYS: Readonly<Record<string, MessageKey>> = {
  'claude-code-cli': 'settingsPage.accounts.claude.name',
  'codex-cli': 'settingsPage.accounts.chatgpt.name',
  // The sub-line already says "Gratis op deze pc" (mockup 04: "Ollama" / "Gratis, op deze pc").
  'ollama-local': 'settingsPage.accounts.ollama.name',
  'gemini-cli': 'settingsPage.accounts.names.geminiCli',
  'grok-build-cli': 'settingsPage.accounts.names.grokCli',
};

/** The B6 initials, so ChatGPT keeps its G next to the C of Claude. */
const INITIALS: Readonly<Record<string, string>> = { 'claude-code-cli': 'C', 'codex-cli': 'G', 'ollama-local': 'O' };

/** Who pays, in two or three words (the full sentence sits under "Over dit account"). */
const SHORT_PAYER: Readonly<Record<ProviderPayer, MessageKey>> = {
  claudeSub: 'rd.settings.accounts.yours',
  chatgptSub: 'rd.settings.accounts.viaCodex',
  ownSub: 'rd.settings.accounts.yours',
  free: 'rd.onboarding.choose.free',
  key: 'onboarding.pad.options.sleutel.label',
};

export interface ProviderRowProps {
  readonly row: ProviderRowData;
  readonly vaultStatus: VaultKeyStatus | null;
  readonly onChanged: () => void;
  /** Re-read everything, including the pc checkup (after signing in or out in the official program). */
  readonly onRecheck: () => void;
}

export function ProviderRow({ row: listRow, vaultStatus, onChanged, onRecheck }: ProviderRowProps) {
  const { t, locale } = useLocale();
  const panelId = useId();
  const aboutId = useId();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // The row the gateway sent back with the last test (contract-providers.md §4). It wins over the
  // list until the list itself reports something other than what it said before the test, so the
  // status word never contradicts the test result a moment after it.
  const [tested, setTested] = useState<{ readonly before: ProviderRowData; readonly row: ProviderRowData } | null>(null);
  const listUnchanged = tested !== null && listRow.status === tested.before.status && listRow.state === tested.before.state;
  const testedRow = tested !== null && listUnchanged ? tested.row : listRow;
  // A key stored in the app reaches the gateway with its restart; until then the gateway says
  // "no key". The word says the key is set, so it never contradicts "Sleutel opgeslagen: •••• 1234".
  const row: ProviderRowData =
    testedRow.status === 'noKey' && vaultStatus?.configured === true ? { ...testedRow, status: 'keySaved' } : testedRow;

  const nameKey = NAME_KEYS[row.id];
  const name = nameKey ? t(nameKey) : row.label;
  const program = signInProgram(row.id);
  const signedIn = row.status === 'connected';
  const hasKey = row.keySource !== null || vaultStatus?.configured === true;
  const canTest = row.kind !== 'key' || hasKey;
  const payer = payerOf(row);

  async function runTest() {
    const before = listRow;
    setTesting(true);
    setResult(null);
    const outcome = await testProvider(before.id);
    setResult(outcome);
    setTesting(false);
    setTested(outcome.row !== null && outcome.row.id === before.id ? { before, row: outcome.row } : null);
    // Read the list again too, so the other rows and the next poll agree with the test.
    onChanged();
  }

  function keyChanged() {
    setTested(null);
    onChanged();
  }

  let testLine: string | null = null;
  if (testing) testLine = t('settingsPage.accounts.testing');
  else if (result?.ok) {
    testLine = result.latencyMs !== null ? t('settingsPage.accounts.testOk', { ms: result.latencyMs }) : t('settingsPage.accounts.testOkNoTime');
  } else if (result) {
    testLine = t('settingsPage.accounts.testFail', { status: t(`settingsPage.accounts.status.${result.status}`) });
  }

  let tos: string | null = null;
  if (row.noticeRequired || program !== null) {
    const date = formatTermsDate(row.verifiedOn ?? TOS_CHECKED_AT, locale);
    if (program === 'claude') tos = t('settingsPage.accounts.tos', { date });
    else if (program === 'codex') tos = t('settingsPage.accounts.tosCodex', { date });
    else tos = t('settingsPage.accounts.tosOther', { date });
  }

  let sub: string | null = null;
  if (row.live === false) sub = t('settingsPage.accounts.notLive');
  else if (row.kind !== 'key' || row.takesKey) sub = t(SHORT_PAYER[payer]);

  const items: RowMenuItem[] = [
    {
      id: 'test',
      label: t('settingsPage.accounts.test'),
      icon: 'Play',
      disabledReason: canTest ? undefined : t('settingsPage.accounts.testNeedsKey'),
      onSelect: () => void runTest(),
    },
  ];
  if (program !== null) {
    items.push({
      id: 'signin',
      label: signedIn ? t('settingsPage.accounts.logout') : t('settingsPage.accounts.login'),
      icon: signedIn ? 'ArrowRightFromLine' : 'ArrowRightToLine',
      expanded: signInOpen,
      onSelect: () => setSignInOpen((open) => !open),
    });
  }
  items.push({ id: 'about', label: t('rd.settings.accounts.about'), icon: 'Info', expanded: aboutOpen, onSelect: () => setAboutOpen((open) => !open) });

  return (
    <article className="fs-acct fs-prov" data-provider={row.id} data-status={row.status} data-kind={row.kind}>
      <div className="fs-acct__main">
        <span className="fs-acct__ini" aria-hidden="true">
          {INITIALS[row.id] ?? name.charAt(0).toUpperCase()}
        </span>
        <span className="fs-acct__text">
          <b className="fs-acct__name">{name}</b>
          {sub ? <span className="fs-acct__sub">{sub}</span> : null}
        </span>
        <span className="fs-pill" data-tone={toneOf(row.status)}>
          <span className="fs-pill__dot" aria-hidden="true" />
          {t(`settingsPage.accounts.status.${row.status}`)}
        </span>
        <RowMenu label={t('shell.sidebar.actionsFor', { name })} items={items} />
      </div>

      <span className="fs-prov__line fs-prov__result" role="status" data-ok={result ? String(result.ok) : undefined}>
        {testLine}
        {result && result.live === false ? ` ${t('settingsPage.accounts.testNotLive')}` : ''}
      </span>
      {result?.detail ? (
        <details className="fs-prov__line fs-prov__detail">
          <summary>{t('settingsPage.accounts.technical')}</summary>
          <code data-log-text="">{result.detail}</code>
        </details>
      ) : null}

      {program !== null && signInOpen ? (
        <div className="fs-prov__line">
          <SignInPanel program={program} signedIn={signedIn} onRecheck={onRecheck} panelId={panelId} />
        </div>
      ) : null}

      {row.takesKey ? (
        <div className="fs-prov__line fs-prov__key">
          <KeyField providerId={row.id} providerName={name} vaultStatus={vaultStatus} keySource={row.keySource} onChanged={keyChanged} />
        </div>
      ) : null}

      <div className="fs-prov__line fs-acct__about" id={aboutId} hidden={!aboutOpen}>
        <span className="fs-acct__pay">{t(`settingsPage.accounts.payer.${payer}`)}</span>
        {tos ? <span className="fs-acct__tos">{tos}</span> : null}
      </div>
    </article>
  );
}
