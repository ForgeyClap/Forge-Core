/**
 * KeyStep — the onboarding "API-sleutel" path (WP B2 part 2, plan §4.7): choose which service the
 * key is from, then store it through the one key field (desktop vault only). The list comes from
 * `GET /api/providers` (accounts that take a key); without that list a short list of well-known
 * services is offered, whose ids the desktop vault resolves against the same registry.
 * Skipping is always allowed: the key can be added later in Instellingen › Accounts.
 *
 * The own-API form ("Eigen API") is the other half of this step. The wizard passes `ownApi` +
 * `onOwnApiChange` so the path follows what the person really sets up (title and end screen say
 * "eigen API" or "API-sleutel"); without those props the step keeps the choice itself.
 */

import { useId, useState } from 'react';

import { Button } from '@/components/primitives';

import { useLocale } from '@/i18n/use-locale';
import { useProviders, useVaultList } from '@/prototype/state/adapter/providers';

import { CustomApiOnboarding } from './CustomApiOnboarding';
import { KeyField } from './KeyField';
import { ListedModelSetup } from './OwnModelSetup';

/** Used only when the gateway has no provider list. Ids match gateway/src/providers/registry.json. */
const FALLBACK_SERVICES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'anthropic', label: 'Anthropic API' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini-openai', label: 'Google Gemini' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'groq', label: 'Groq' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'nvidia-nim', label: 'NVIDIA NIM' },
];

export interface KeyStepProps {
  /** Show the own-API form instead of the list of known services (controlled by the wizard). */
  readonly ownApi?: boolean;
  readonly onOwnApiChange?: (open: boolean) => void;
  /** The own-API form has a saved entry (the wizard's "Verder" waits for it). */
  readonly onOwnApiReady?: (ready: boolean) => void;
}

export function KeyStep({ ownApi: ownApiProp, onOwnApiChange, onOwnApiReady }: KeyStepProps = {}) {
  const { t } = useLocale();
  const selectId = useId();
  const providers = useProviders();
  const vault = useVaultList();

  const services = providers.data.available
    ? providers.data.rows.filter((row) => row.takesKey).map((row) => ({ id: row.id, label: row.label, keySource: row.keySource }))
    : FALLBACK_SERVICES.map((service) => ({ ...service, keySource: null }));
  const [chosen, setChosen] = useState<string>('anthropic');
  const [ownApiState, setOwnApiState] = useState(false);
  const ownApi = ownApiProp ?? ownApiState;
  function setOwnApi(open: boolean) {
    if (onOwnApiChange) onOwnApiChange(open);
    else setOwnApiState(open);
  }
  const service = services.find((entry) => entry.id === chosen) ?? services[0] ?? null;
  const vaultStatus = service ? (vault.list?.keys.find((key) => key.providerId === service.id) ?? null) : null;
  const hasKey = vaultStatus?.configured === true || (service?.keySource ?? null) !== null;
  const row = service ? providers.data.rows.find((entry) => entry.id === service.id) : undefined;

  function refreshLists() {
    vault.refresh();
    providers.refresh();
  }

  // "Andere dienst of een eigen server?" (or the Eigen API path) opens the own-API form.
  if (ownApi) {
    return (
      <div className="fs-onb__connect fs-onb__keystep">
        <p>{t('onboarding.verbinden.eigenLead')}</p>
        <CustomApiOnboarding providers={providers.data.rows} vaultKeys={vault.list?.keys ?? []} onChanged={refreshLists} onBack={() => setOwnApi(false)} onReadyChange={onOwnApiReady} />
      </div>
    );
  }

  return (
    <div className="fs-onb__connect fs-onb__keystep">
      <p>{t('onboarding.verbinden.sleutelLead')}</p>
      {services.length > 0 && service ? (
        <>
          <div className="fs-onb__service">
            <label htmlFor={selectId}>{t('onboarding.verbinden.sleutelService')}</label>
            <select id={selectId} value={service.id} onChange={(event) => setChosen(event.currentTarget.value)}>
              {services.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          <KeyField
            key={service.id}
            providerId={service.id}
            providerName={service.label}
            vaultStatus={vaultStatus}
            keySource={service.keySource}
            startOpen
            onChanged={refreshLists}
          />
          {hasKey ? (
            <ListedModelSetup
              key={service.id}
              providerId={service.id}
              providerName={service.label}
              local={row?.kind === 'local'}
              paid
              notice={row?.noticeRequired === true && row.kind !== 'local'}
            />
          ) : null}
        </>
      ) : (
        <p className="fs-onb__hint">{t('onboarding.verbinden.sleutelNone')}</p>
      )}
      <p className="fs-onb__hint">{t('onboarding.verbinden.sleutelSkip')}</p>
      <div className="fs-own__alt">
        <span>{t('onboarding.ownModel.customOpen')}</span>
        <Button size="sm" variant="ghost" icon="Network" onClick={() => setOwnApi(true)}>
          {t('onboarding.ownModel.customButton')}
        </Button>
      </div>
    </div>
  );
}
