/**
 * CustomApiOnboarding — +: the "Eigen API" choice inside the onboarding key step. The same
 * form as Settings › Accounts (CustomApiForm), then, once saved (and tested), "Meteen eigen model" for
 * that entry. Honest states for a gateway without these routes or a list that cannot be read.
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import type { ProviderRow, VaultKeyStatus } from '@/prototype/state/adapter/providers';
import { useCustomProviders } from '@/prototype/state/adapter/providers-custom';
import { CustomApiForm } from '@/views/settings/sections/custom-api/CustomApiForm';
import { classifyBaseUrl } from '@/views/settings/sections/custom-api/custom-api-model';

import { ListedModelSetup } from './OwnModelSetup';

export interface CustomApiOnboardingProps {
  readonly providers: readonly ProviderRow[];
  readonly vaultKeys: readonly VaultKeyStatus[];
  readonly onChanged: () => void;
  /** Back to the list of known services. */
  readonly onBack: () => void;
  /** True once an own API is saved here (or one that is on was saved before): the wizard may go on. */
  readonly onReadyChange?: (ready: boolean) => void;
}

export function CustomApiOnboarding({ providers, vaultKeys, onChanged, onBack, onReadyChange }: CustomApiOnboardingProps) {
  const { t } = useLocale();
  const custom = useCustomProviders();
  const [savedId, setSavedId] = useState<string | null>(null);
  // Review Boss (Q5-EIGEN-API-UI): "Verder" only once an entry was really saved, never on an empty form.
  const ready = savedId !== null || (custom.load === 'ready' && custom.list.entries.some((entry) => entry.enabled));
  useEffect(() => {
    onReadyChange?.(ready);
  }, [ready, onReadyChange]);
  useEffect(() => () => onReadyChange?.(false), [onReadyChange]);

  const back = (
    <div>
      <Button size="sm" variant="quiet" icon="ArrowLeft" onClick={onBack}>
        {t('onboarding.ownModel.customClose')}
      </Button>
    </div>
  );

  if (custom.load === 'loading') {
    return (
      <>
        <p className="fs-onb__hint" role="status">
          {t('customApi.loading')}
        </p>
        {back}
      </>
    );
  }
  if (custom.load === 'missing' || custom.load === 'error') {
    return (
      <>
        <p className="fs-onb__hint">{custom.load === 'missing' ? t('customApi.missing') : t('customApi.loadError')}</p>
        {back}
      </>
    );
  }

  return (
    <>
      <CustomApiForm
        entry={null}
        revision={custom.list.revision}
        headingLevel={3}
        onSaved={(entry) => {
          setSavedId(entry.id);
          custom.reload();
          onChanged();
        }}
        onStale={custom.reload}
        onClose={onBack}
        {...keyFactsFor(savedId ?? '', providers, vaultKeys)}
        onKeyChanged={onChanged}
        afterSaved={(entry) => {
          const verdict = classifyBaseUrl(entry.baseURL);
          return (
            <ListedModelSetup
              providerId={entry.id}
              providerName={entry.label}
              fixedModels={entry.models.mode === 'manual' ? entry.models.ids : undefined}
              local={verdict.kind === 'local' || verdict.kind === 'lan'}
              paid={entry.auth.type !== 'none'}
              notice={false}
            />
          );
        }}
      />
      {ready ? null : <p className="fs-onb__hint">{t('onboarding.ownModel.saveFirst')}</p>}
      {back}
    </>
  );
}

/** Where a key for this id was found, from the onboarding's own lists. */
function keyFactsFor(id: string, providers: readonly ProviderRow[], vaultKeys: readonly VaultKeyStatus[]) {
  return {
    vaultStatus: vaultKeys.find((key) => key.providerId === id) ?? null,
    keySource: providers.find((row) => row.id === id)?.keySource ?? null,
  };
}
