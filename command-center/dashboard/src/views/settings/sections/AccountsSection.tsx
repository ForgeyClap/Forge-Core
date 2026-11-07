/**
 * Accounts (WP B6, provider list WP B2 part 2; v1.0 redesign DESIGN.md §3.4 "Je accounts").
 *
 * One row per account from `GET /api/providers` (see `ProviderRow`): the sign-in accounts, Ollama and
 * every account with a key come first; the rest sit under "Meer accounts". "Account toevoegen" opens the
 * four choices of onboarding (`AddAccountChooser`). In Uitgebreid the Eigen API list is its own group: this
 * section still renders it (it shares the provider list, the key vault list and the "saved elsewhere" counter),
 * but on the Settings page it is drawn into the Eigen API group's body (`OwnApiSlotContext`, fix round XR-SET);
 * rendered on its own, it follows inline. A gateway without the provider list falls back to the checkup-based
 * rows, so nothing is guessed.
 * "Controleer of alles werkt" sits at the head of the group: in Eenvoudig it opens the pc check here, in
 * Uitgebreid it jumps to Diagnose.
 */

import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import { Icon } from '@/components/primitives';
import { CheckupPanel } from '@/components/checkup/CheckupPanel';
import type { CheckupController } from '@/components/checkup/use-checkup';
import { useLocale } from '@/i18n/use-locale';
import { isPrimary, readKeysBridge, useProviders, useVaultList } from '@/prototype/state/adapter/providers';
import type { ProviderRow as ProviderRowData, VaultKeyStatus } from '@/prototype/state/adapter/providers';
import { useGatewayClaudeCodeHealth } from '@/prototype/state/gateway-adapter';
import { useGatewayModels } from '@/prototype/state/gateway-capabilities';
import { useUiMode } from '@/state/ui-mode';

import { TOS_CHECKED_AT } from '../settings-model';
import { buildAccountCards, formatTermsDate } from './accounts-model';
import { AddAccountChooser } from './AddAccountChooser';
import { CustomApiSection } from './custom-api/CustomApiSection';
import { useOwnApiSlot } from './own-api-slot';
import { ProviderRow } from './ProviderRow';

import './accounts.css';

/* ------------------------------------------------- B6 fallback (no list) */

function FallbackRows({ checkup, failed }: { readonly checkup: CheckupController; readonly failed: boolean }) {
  const { t, locale } = useLocale();
  const health = useGatewayClaudeCodeHealth();
  const models = useGatewayModels();

  const cards = buildAccountCards({
    checkup: checkup.result,
    checkupRunning: checkup.status === 'running' || checkup.status === 'idle',
    claudeAvailable: health ? health.claudeCode.available : null,
    models: models.loading ? null : models.data,
  });

  return (
    <>
      {failed ? <p className="fs-acct__state">{t('settingsPage.accounts.loadError')}</p> : null}
      {cards.map((account) => (
        <article key={account.id} className="fs-acct" data-provider={account.id} data-status={account.status}>
          <div className="fs-acct__main">
            <span className="fs-acct__ini" aria-hidden="true">
              {account.initial}
            </span>
            <span className="fs-acct__text">
              <b className="fs-acct__name">{t(`settingsPage.accounts.${account.id}.name`)}</b>
              <span className="fs-acct__sub">
                {t(`settingsPage.accounts.${account.id}.pay`)}
                {account.modelCount !== null ? ` · ${t('settingsPage.accounts.models', { count: account.modelCount })}` : ''}
              </span>
            </span>
            <span className="fs-pill" data-tone={account.tone}>
              <span className="fs-pill__dot" aria-hidden="true" />
              {t(`settingsPage.accounts.status.${account.status}`)}
            </span>
          </div>
          {account.id === 'claude' ? (
            <span className="fs-prov__line fs-acct__tos">{t('settingsPage.accounts.tos', { date: formatTermsDate(TOS_CHECKED_AT, locale) })}</span>
          ) : null}
        </article>
      ))}
      {/* Testen, inloggen and uitloggen need the provider list; until the gateway has it, say so once, in one short line (review F7). */}
      <p className="fs-acct__state">{t('settingsPage.accounts.notYet')}</p>
    </>
  );
}

/* --------------------------------------------------------------- section */

export interface AccountsSectionProps {
  readonly checkup: CheckupController;
  /** Uitgebreid: "Controleer of alles werkt" jumps to the Diagnose group instead of opening here. */
  readonly onShowDiagnose?: () => void;
}

export function AccountsSection({ checkup, onShowDiagnose }: AccountsSectionProps) {
  const { t } = useLocale();
  const { isAdvanced } = useUiMode();
  const navigate = useNavigate();
  const titleId = useId();
  const providers = useProviders();
  const vault = useVaultList();
  const desktop = readKeysBridge() !== null;
  const [adding, setAdding] = useState(false);
  const [showCheck, setShowCheck] = useState(false);
  const [customSaves, setCustomSaves] = useState(0);
  const ownApiSlot = useOwnApiSlot();

  const vaultById = new Map<string, VaultKeyStatus>((vault.list?.keys ?? []).map((key) => [key.providerId, key]));
  const vaultIds = new Set(vaultById.keys());
  // Where each row sits is fixed for this visit, once the lists that decide it have answered: a row
  // that gains a key does not jump out of "Meer accounts" under the pointer, and its key field keeps
  // what it is showing (the apply state, "Nu opnieuw verbinden"). A next visit sorts afresh.
  const [placement, setPlacement] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  let placed = placement;
  if (providers.data.available && (!desktop || vault.list !== null)) {
    const unplaced = providers.data.rows.filter((row) => !placement.has(row.id));
    if (unplaced.length > 0) {
      const next = new Map(placement);
      for (const row of unplaced) next.set(row.id, isPrimary(row, vaultIds));
      placed = next;
      // Guarded (only when a new row appears), so React re-renders once with the stored placement.
      setPlacement(next);
    }
  }
  const primaryNow = (row: ProviderRowData): boolean => placed.get(row.id) ?? isPrimary(row, vaultIds);

  function refreshLists() {
    providers.refresh();
    vault.refresh();
  }

  function recheckAll() {
    refreshLists();
    checkup.run();
  }

  function check() {
    if (checkup.status !== 'running') checkup.run();
    if (onShowDiagnose) onShowDiagnose();
    else setShowCheck((open) => !open);
  }

  let body;
  let notes = null;
  if (!providers.data.available) {
    body = providers.loading ? (
      <p className="fs-acct__state" role="status">
        {t('settingsPage.accounts.loading')}
      </p>
    ) : (
      <FallbackRows checkup={checkup} failed={providers.error !== null} />
    );
  } else if (providers.data.rows.length === 0) {
    body = <p className="fs-acct__state">{t('settingsPage.accounts.empty')}</p>;
  } else {
    const primary = providers.data.rows.filter((row) => primaryNow(row));
    const more = providers.data.rows.filter((row) => !primaryNow(row));
    const row = (item: ProviderRowData) => (
      <ProviderRow key={item.id} row={item} vaultStatus={vaultById.get(item.id) ?? null} onChanged={refreshLists} onRecheck={recheckAll} />
    );
    body = (
      <>
        {primary.map(row)}
        {more.length > 0 ? (
          <details className="fs-prov__more">
            <summary>
              <Icon name="ChevronRight" size="sm" className="fs-prov__chev" />
              <span>{t('settingsPage.accounts.more', { count: more.length })}</span>
            </summary>
            <p className="fs-prov__more-hint">{t('settingsPage.accounts.moreHint')}</p>
            <div className="fs-prov__more-list">{more.map(row)}</div>
          </details>
        ) : null}
      </>
    );
    notes = (
      <>
        {providers.data.dropped > 0 ? <p className="fs-acct__note">{t('settingsPage.accounts.dropped', { count: providers.data.dropped })}</p> : null}
        {desktop && vault.list && !vault.list.ready ? (
          <p className="fs-acct__note" role="note">
            {vault.list.reason ?? t('accountKeys.errors.VAULT_UNAVAILABLE')}
          </p>
        ) : null}
        {desktop ? <p className="fs-acct__note">{t('accountKeys.limit')}</p> : null}
      </>
    );
  }

  // Uitgebreid: the Eigen API list. On the Settings page its group supplies the heading.
  const ownApi = isAdvanced ? (
    <CustomApiSection
      providers={providers.data.rows}
      vaultKeys={vault.list?.keys ?? []}
      onChanged={refreshLists}
      refreshToken={customSaves}
      hideHeading={ownApiSlot !== undefined}
    />
  ) : null;

  return (
    <>
      <section className="fs-set__sub fs-set__accounts" data-row="accounts" aria-labelledby={titleId}>
        <div className="fs-set__sub-head">
          <h3 className="fs-set__sub-title" id={titleId}>
            {t('rd.settings.accounts.title')}
          </h3>
          <button
            type="button"
            className="fs-set__link"
            aria-expanded={onShowDiagnose ? undefined : showCheck}
            aria-controls={onShowDiagnose || !showCheck ? undefined : 'fs-set-checkpanel'}
            onClick={check}
          >
            {t('checkup.start')}
          </button>
        </div>
        <div className="fs-acct__list">
          {body}
          <button type="button" className="fs-set__add" onClick={() => setAdding(true)}>
            <Icon name="Plus" size="sm" />
            <span>{t('rd.settings.accounts.add')}</span>
          </button>
        </div>
        {notes}
        {showCheck && !onShowDiagnose ? (
          <div className="fs-set__checkpanel" id="fs-set-checkpanel">
            <CheckupPanel controller={checkup} showPort={false} showDiagnose hideHeading onChooseFolder={() => navigate('/projects')} />
          </div>
        ) : null}
      </section>

      {ownApi && ownApiSlot === undefined ? ownApi : null}
      {ownApi && ownApiSlot ? createPortal(ownApi, ownApiSlot) : null}

      <AddAccountChooser
        open={adding}
        onClose={() => setAdding(false)}
        providers={providers.data.available ? providers.data.rows : null}
        vaultKeys={vault.list?.keys ?? []}
        checkup={checkup}
        onRecheck={recheckAll}
        onCustomSaved={() => setCustomSaves((count) => count + 1)}
      />
    </>
  );
}
