/**
 * CustomApiSection — the "Eigen API" group of Settings › Accounts in Uitgebreid (ANY-MODEL-PLAN.md
 * §2.2 E; v1.0 redesign DESIGN.md §3.4).
 *
 * One row per own API entry: the name, the address in mono, a visible "Niet versleuteld" badge for http
 * on a private network (D1), and [Aanpassen]. "Eigen API toevoegen" and Aanpassen open the unchanged
 * CustomApi form inside a dialog (its validation and URL-class rules stay as they are). Every state is
 * spelled out: loading, a gateway without these routes ("werk Forge bij"), a read error with
 * [Opnieuw proberen], the empty list, and rows the parser could not read. Once saved, an entry also
 * appears as a normal account row above (the gateway merges it).
 * Q5-EIGEN-API-UI: when the router chain names an entry, its dialog says so BEFORE a delete or a switch-off,
 * and after one (from `router_entries`) a notice names the steps the router now skips.
 */

import { useEffect, useId, useState } from 'react';

import { Button, Icon, Modal } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { callVault, readKeysBridge } from '@/prototype/state/adapter/providers';
import type { ProviderRow, VaultKeyStatus } from '@/prototype/state/adapter/providers';
import { deleteCustomProvider, useCustomProviders } from '@/prototype/state/adapter/providers-custom';
import type { CustomProviderEntry } from '@/prototype/state/adapter/providers-custom';

import { CustomApiForm } from './CustomApiForm';
import { classifyBaseUrl, hostOf } from './custom-api-model';
import { useRouterUsage } from './use-router-usage';

import './custom-api.css';
import '../app-router/router-skip.css';

export interface CustomApiSectionProps {
  /** The provider list of the Accounts section (for where a key was found). */
  readonly providers: readonly ProviderRow[];
  /** The desktop vault's keys (empty in a browser). */
  readonly vaultKeys: readonly VaultKeyStatus[];
  /** Re-read the account lists after a save, a key change or a removal. */
  readonly onChanged: () => void;
  /** Goes up when an entry was saved elsewhere ("Account toevoegen"): the list is read again. */
  readonly refreshToken?: number;
  /** The Settings page's own Eigen API group draws the heading: leave out this block's own title. */
  readonly hideHeading?: boolean;
}

/** `session` keeps one form instance alive from "new" through its first save (no remount, no lost state). */
type Open = { readonly kind: 'new'; readonly session: number } | { readonly kind: 'edit'; readonly id: string; readonly session: number } | null;

function Row({ entry, onEdit, editing }: { readonly entry: CustomProviderEntry; readonly onEdit: () => void; readonly editing: boolean }) {
  const { t } = useLocale();
  const verdict = classifyBaseUrl(entry.baseURL);
  return (
    <li className="fs-capi__row" data-provider={entry.id} data-enabled={entry.enabled}>
      <span className="fs-capi__tile" aria-hidden="true">
        <Icon name="Database" size="sm" />
      </span>
      <span className="fs-capi__row-main">
        <b className="fs-capi__row-name">{entry.label}</b>
        <code className="fs-capi__row-host">{hostOf(entry.baseURL)}</code>
      </span>
      <span className="fs-capi__tags">
        {verdict.kind === 'lan' ? (
          <span className="fs-pill" data-tone="warn">
            <span className="fs-pill__dot" aria-hidden="true" />
            {t('customApi.plain')}
          </span>
        ) : null}
        {verdict.kind === 'local' ? <span className="fs-pill" data-tone="off">{t('customApi.local')}</span> : null}
        {!entry.enabled ? (
          <span className="fs-pill" data-tone="off">
            <span className="fs-pill__dot" aria-hidden="true" />
            {t('customApi.off')}
          </span>
        ) : null}
      </span>
      <Button size="sm" variant="secondary" onClick={onEdit} aria-expanded={editing}>
        {t('customApi.edit')}
      </Button>
    </li>
  );
}

export function CustomApiSection({ providers, vaultKeys, onChanged, refreshToken = 0, hideHeading = false }: CustomApiSectionProps) {
  const { t } = useLocale();
  const titleId = useId();
  const custom = useCustomProviders();
  const [open, setOpen] = useState<Open>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  const [lastSaved, setLastSaved] = useState<CustomProviderEntry | null>(null);
  const usage = useRouterUsage();
  /** After a delete (section) or a switch-off (dialog): the router steps that still name the entry. */
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  const [offNote, setOffNote] = useState<string | null>(null);

  const { reload } = custom;
  // An entry saved through "Account toevoegen" lives in another copy of the list: read this one again.
  useEffect(() => {
    if (refreshToken > 0) reload();
  }, [refreshToken, reload]);

  const currentRevision = revision !== null && revision >= custom.list.revision ? revision : custom.list.revision;
  const editing =
    open?.kind === 'edit'
      ? (custom.list.entries.find((entry) => entry.id === open.id) ?? (lastSaved?.id === open.id ? lastSaved : null))
      : null;

  function openForm(next: { readonly kind: 'new' } | { readonly kind: 'edit'; readonly id: string }) {
    setSession((n) => n + 1);
    setOpen({ ...next, session: session + 1 });
    setRemoveError(null);
    setRemovedNote(null);
    setOffNote(null);
  }

  /** The router steps named in an answer, or (an older gateway) the ones read before. */
  function stepIds(id: string, fromAnswer: readonly string[] | null): readonly string[] {
    return fromAnswer ?? usage.stepsFor(id).map((step) => step.id);
  }

  function keyFacts(id: string) {
    return {
      vaultStatus: vaultKeys.find((key) => key.providerId === id) ?? null,
      keySource: providers.find((row) => row.id === id)?.keySource ?? null,
    };
  }

  function close() {
    setOpen(null);
    setRemoveError(null);
    setOffNote(null);
  }

  async function remove(entry: CustomProviderEntry) {
    setRemoving(true);
    setRemoveError(null);
    const outcome = await deleteCustomProvider(entry.id);
    setRemoving(false);
    if (outcome.kind !== 'deleted') {
      if (outcome.kind === 'stale') custom.reload();
      setRemoveError(t('customApi.outcome.removeFailed', { reason: outcome.kind === 'failed' || outcome.kind === 'refused' ? outcome.error : outcome.kind }));
      return;
    }
    // Plan §2.2 D: the stored key goes with the entry. Main may also drop it; a second delete is harmless.
    const bridge = readKeysBridge();
    const dropKey = bridge?.delete;
    if (entry.auth.type !== 'none' && typeof dropKey === 'function') await callVault(() => dropKey(entry.id), entry.id);
    if (outcome.revision !== null) setRevision(outcome.revision);
    const steps = stepIds(entry.id, outcome.routerEntries);
    close();
    setRemovedNote(steps.length > 0 ? t('customApi.router.removed', { name: entry.label, names: usage.namesOf(steps) }) : null);
    custom.reload();
    usage.reload();
    onChanged();
  }

  let body;
  if (custom.load === 'loading') {
    body = (
      <p className="fs-capi__state" role="status">
        {t('customApi.loading')}
      </p>
    );
  } else if (custom.load === 'missing') {
    body = <p className="fs-capi__state">{t('customApi.missing')}</p>;
  } else if (custom.load === 'error') {
    body = (
      <div className="fs-capi__state fs-capi__state--problem">
        <span>{t('customApi.loadError')}</span>
        <Button size="sm" variant="quiet" icon="RefreshCw" onClick={custom.reload}>
          {t('customApi.retry')}
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {custom.list.entries.length === 0 ? <p className="fs-capi__state">{t('customApi.empty')}</p> : null}
        {custom.list.entries.length > 0 ? (
          <ul className="fs-capi__list">
            {custom.list.entries.map((entry) => (
              <Row key={entry.id} entry={entry} editing={open?.kind === 'edit' && open.id === entry.id} onEdit={() => openForm({ kind: 'edit', id: entry.id })} />
            ))}
          </ul>
        ) : null}
        {custom.list.dropped > 0 ? <p className="fs-capi__state">{t('customApi.dropped', { count: custom.list.dropped })}</p> : null}
      </>
    );
  }

  const canAdd = custom.load === 'ready';
  const inUse = editing && editing.enabled && offNote === null ? usage.stepsFor(editing.id) : [];
  const formOpen = open !== null && (open.kind === 'new' || editing !== null);
  const formTitle = editing ? t('customApi.form.titleEdit', { name: editing.label }) : t('customApi.form.titleNew');

  // Inside its own Settings group the group's h2 is the title; on its own this block brings an h3.
  const Block = hideHeading ? 'div' : 'section';

  return (
    <Block className="fs-set__sub fs-capi" aria-labelledby={hideHeading ? undefined : titleId} data-row="custom-api">
      {hideHeading ? null : (
        <div className="fs-set__sub-head">
          <h3 className="fs-set__sub-title" id={titleId}>
            {t('rd.settings.ownApi.title')}
          </h3>
        </div>
      )}

      <div className="fs-capi__box">
        {body}
        {canAdd ? (
          <button type="button" className="fs-set__add" onClick={() => openForm({ kind: 'new' })}>
            <Icon name="Plus" size="sm" />
            <span>{t('customApi.add')}</span>
          </button>
        ) : null}
        {removedNote ? (
          <p className="fs-router-skip" role="status">
            {removedNote}
          </p>
        ) : null}
      </div>
      <Modal open={formOpen} onClose={close} title={formTitle} description={editing ? undefined : t('customApi.feel')} size="lg" className="fs-capi__dialog">
        {/* Read first in the dialog, before the form and its Verwijderen / switch (not under the key block). */}
        {inUse.length > 0 ? (
          <p className="fs-router-skip fs-capi__router" role="note">
            {t('customApi.router.inUse', { names: inUse.map((step) => step.label).join(', ') })}
          </p>
        ) : null}
        {offNote ? (
          <p className="fs-router-skip fs-capi__router" role="status">
            {offNote}
          </p>
        ) : null}
        {formOpen && open !== null ? (
          <CustomApiForm
            key={open.session}
            entry={editing}
            revision={currentRevision}
            titleInDialog
            onSaved={(entry, nextRevision, routerEntries) => {
              setRevision(nextRevision);
              setLastSaved(entry);
              const steps = entry.enabled ? [] : stepIds(entry.id, routerEntries);
              setOffNote(steps.length > 0 ? t('customApi.router.disabled', { name: entry.label, names: usage.namesOf(steps) }) : null);
              // The form stays open on the saved entry, unless the dialog was closed while the save ran
              // (security review 2C, note 3): then it stays closed.
              const session = open.session;
              setOpen((current) => (current !== null && current.session === session ? { kind: 'edit', id: entry.id, session } : current));
              custom.reload();
              onChanged();
            }}
            onStale={custom.reload}
            onClose={close}
            onRemove={editing ? () => void remove(editing) : undefined}
            removing={removing}
            {...keyFacts(open.kind === 'edit' ? open.id : '')}
            onKeyChanged={onChanged}
          />
        ) : null}
        {removeError ? (
          <p className="fs-capi__error" role="alert">
            {removeError}
          </p>
        ) : null}
      </Modal>
    </Block>
  );
}
