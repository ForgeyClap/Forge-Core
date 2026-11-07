/**
 * CustomApiConnect — what an "Eigen API" entry needs after it is saved (§2.2 C + E): the key
 * (the one KeyField, desktop vault only; without the app the env name of D2 is shown), Testen through
 * the existing provider test route, and the model list the test made known (endpoint mode) or the
 * user's own list (manual mode, D6).
 */

import { useId, useState } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { useProviderModels } from '@/prototype/state/adapter/app-router';
import { readKeysBridge, testProvider, toneOf } from '@/prototype/state/adapter/providers';
import type { KeySource, ProviderTestResult, VaultKeyStatus } from '@/prototype/state/adapter/providers';
import type { CustomProviderEntry } from '@/prototype/state/adapter/providers-custom';
import { KeyField } from '@/views/onboarding/KeyField';

import { envNameFor } from './custom-api-model';

const SHOW_MODELS = 8;

export interface CustomApiConnectProps {
  readonly entry: CustomProviderEntry;
  readonly needsKey: boolean;
  readonly vaultStatus: VaultKeyStatus | null;
  readonly keySource: KeySource | null;
  readonly onKeyChanged: () => void;
  /** Called after every finished test (onboarding uses it to read the model list again). */
  readonly onTested?: (result: ProviderTestResult) => void;
}

function listText(models: readonly string[]): string {
  const shown = models.slice(0, SHOW_MODELS).join(', ');
  return models.length > SHOW_MODELS ? `${shown} +${models.length - SHOW_MODELS}` : shown;
}

export function CustomApiConnect({ entry, needsKey, vaultStatus, keySource, onKeyChanged, onTested }: CustomApiConnectProps) {
  const { t } = useLocale();
  const reasonId = useId();
  const models = useProviderModels();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const desktop = readKeysBridge() !== null;
  const hasKey = !needsKey || vaultStatus?.configured === true || keySource !== null;
  const envName = envNameFor(entry.id);
  // The env name sits inside the sentence as code: split the translation at its {name} slot.
  const [envBefore = '', envAfter = ''] = t('customApi.form.keyEnv', { name: '\u0001' }).split('\u0001');
  const envSentence = [envBefore, envAfter] as const;

  async function runTest() {
    setTesting(true);
    setResult(null);
    const outcome = await testProvider(entry.id);
    setResult(outcome);
    setTesting(false);
    models.refresh();
    onTested?.(outcome);
  }

  let testLine: string | null = null;
  let tone: 'ok' | 'bad' | 'busy' | undefined;
  if (testing) {
    testLine = t('customApi.form.testing');
    tone = 'busy';
  } else if (result?.ok) {
    testLine = result.latencyMs !== null ? t('customApi.form.testOk', { ms: result.latencyMs }) : t('customApi.form.testOkNoTime');
    tone = 'ok';
  } else if (result) {
    testLine = t('customApi.form.testFail', { status: t(`settingsPage.accounts.status.${result.status}`) });
    tone = toneOf(result.status) === 'ok' ? 'ok' : 'bad';
  }

  const listing = models.list?.find((item) => item.id === entry.id) ?? null;
  let modelLine: string;
  if (entry.models.mode === 'manual') modelLine = t('customApi.form.manualModels', { models: listText(entry.models.ids) });
  else if (listing && listing.models.length > 0) modelLine = t('customApi.form.foundModels', { models: listText(listing.models) });
  else modelLine = t('customApi.form.noModelsYet');

  return (
    <section className="fs-capi__connect" aria-label={t('customApi.form.keyStore')}>
      {needsKey ? (
        <div className="fs-capi__keyblock">
          <p className="fs-capi__label">{t('customApi.form.keyStore')}</p>
          <KeyField
            providerId={entry.id}
            providerName={entry.label}
            vaultStatus={vaultStatus}
            keySource={keySource}
            startOpen
            onChanged={onKeyChanged}
          />
          {!desktop && envName && keySource === null ? (
            <p className="fs-capi__hint">
              {envSentence[0]}
              <code className="fs-capi__code">{envName}</code>
              {envSentence[1]}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="fs-capi__testrow">
        <Button size="sm" variant="ghost" icon="Activity" onClick={() => void runTest()} disabled={!hasKey || testing} aria-describedby={hasKey ? undefined : reasonId}>
          {t('customApi.form.test')}
        </Button>
        <p className="fs-capi__testline" role="status" data-tone={tone}>
          {tone === 'ok' ? <Icon name="CircleCheck" size="sm" /> : tone === 'bad' ? <Icon name="CircleX" size="sm" /> : null}
          <span>{testLine ?? ''}</span>
        </p>
      </div>
      {!hasKey ? (
        <p className="fs-capi__hint" id={reasonId}>
          {t('settingsPage.accounts.testNeedsKey')}
        </p>
      ) : null}
      {result?.detail ? (
        <details className="fs-capi__detail">
          <summary>{t('customApi.form.technical')}</summary>
          <code data-log-text="">{result.detail}</code>
        </details>
      ) : null}
      <p className="fs-capi__models">{modelLine}</p>
    </section>
  );
}
