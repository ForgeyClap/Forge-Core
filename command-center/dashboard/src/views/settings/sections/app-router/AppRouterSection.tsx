/**
 * AppRouterSection — Instellingen › Accounts › "Als je limiet op is" (APP-ROUTER-DESIGN.md §1, §6.2; part P4;
 * v1.0 redesign DESIGN.md §3.4).
 *
 * Container: the config comes from `useAppRouter()` (read once, status polled every 15 s while visible).
 * Changes are a local draft until "Opslaan" sends the FULL config with its revision; the server copy wins
 * after a save, a 409 ("changed elsewhere") or a new account. Every state has its own copy: loading,
 * unreachable, unreadable file, a config from a newer Forge (shown, never saved).
 *
 * v1.0 fix round FX-C (DESIGN.md §1 rule 2, §5 text budget, §6 "Meer info"):
 * - Eenvoudig: one surface of rows. "Wat doet Forge dan?" with the four modes in a select; then, only where
 *   the mode needs it, the consent row (topic, the accounts it covers by name, the checkbox; the terms and the
 *   account list behind "Meer info") and "Je eigen model" (the current choice; the picker behind "Meer info").
 * - Uitgebreid: the modes as options (only the chosen one shows its line), the same consent row, and
 *   "Volgorde"; thresholds, general values, the account list and the own model sit behind its "Meer info".
 * - A panel with an error inside opens by itself.
 * Fix round XR-SET (DESIGN.md §3.4): the consent row appears only when "Wisselen tussen mijn
 * Claude-accounts" is the chosen mode, or while switching is already on in another mode (so its risk stays on
 * screen and it can be switched off). One plain risk line stays visible above its checkbox. In Uitgebreid the
 * chosen rotation option no longer repeats "you confirm first": the consent row right under it does that.
 * "Account toevoegen › Claude" (Je accounts) reaches this section's dialog only while the config is loaded
 * and writable (security review 2C): in read-only an added account would reset the read-only state and
 * the next save would drop the entries this dashboard cannot read.
 */

import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Button, ChoiceList } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import { ROUTER_MODES, saveRouterConfig, useAppRouter, useProviderModels } from '@/prototype/state/adapter/app-router';
import type { RouterConfig, RouterEntryStatus, RouterFieldError, RouterMode } from '@/prototype/state/adapter/app-router';
import { toneOf, useProviders } from '@/prototype/state/adapter/providers';
import { signalRouterChanged, useOnRouterRefresh } from '@/prototype/state/adapter/router-refresh';
import { useUiMode } from '@/state/ui-mode';

import { AccountList } from './AccountList';
import { AddAccountDialog } from './AddAccountDialog';
import { ChainEditor } from './ChainEditor';
import { FallbackModelPicker } from './FallbackModelPicker';
import { MultiAccountNotice } from './MultiAccountNotice';
import { OwnModelRow } from './OwnModelRow';
import { currentFallback, isClaude, normalizePath, validateDraft, withMode } from './app-router-model';
import type { ProviderFacts } from './app-router-model';
import { onAddClaudeAccount } from './router-events';

import './app-router.css';
import './router-skip.css';

export const ROUTER_SECTION_ID = 'fs-router';

/** Leer Forge lesson 4, "Als je limiet op is" (DESIGN.md §3.6). */
export const ROUTER_LESSON_PATH = '/learn?lesson=limit';

/** The short names of the four modes (DESIGN.md §3.4). */
const MODE_SHORT: Readonly<Record<RouterMode, MessageKey>> = {
  off: 'rd.settings.router.none',
  'claude-accounts': 'rd.settings.router.rotate',
  'claude-then-model': 'rd.settings.router.claudeThenOwn',
  'model-first': 'rd.settings.router.ownNow',
};

/** The one line under the chosen option in Uitgebreid. Rotation drops "you confirm first" (the consent row
 *  follows right under it; key added in fix round XR-SET, the cast goes once the locale patch is merged). */
const MODE_TEXT: Readonly<Record<RouterMode, MessageKey>> = {
  off: 'appRouter.modes.off.text',
  'claude-accounts': 'rd.settings.router.rotateText',
  'claude-then-model': 'appRouter.modes.claudeThenModel.text',
  'model-first': 'appRouter.modes.modelFirst.text',
};

function sameConfig(a: RouterConfig, b: RouterConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function AppRouterSection() {
  const { t, locale } = useLocale();
  const { isAdvanced } = useUiMode();
  const { dispatch } = usePrototype();
  const router = useAppRouter();
  const providers = useProviders();
  const models = useProviderModels();
  // Q7: an own API that changed (now paid, switched off) shows here at once, not after the 20 s poll.
  useOnRouterRefresh(providers.refresh);
  const [draft, setDraft] = useState<{ readonly base: RouterConfig; readonly value: RouterConfig } | null>(null);
  const [serverErrors, setServerErrors] = useState<readonly RouterFieldError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const selectId = useId();

  // "Account toevoegen › Claude" in Je accounts opens this section's own dialog, but only while the config is
  // loaded and may be saved (not while loading, after a load error, or in read-only).
  const writable = router.data !== null && router.data.problems === 0;
  useEffect(() => {
    if (!writable) return undefined;
    return onAddClaudeAccount(() => setAdding(true));
  }, [writable]);

  const toast = (title: string, detail?: string, icon?: string) =>
    dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });

  const head = (
    <div className="fs-set__sub-head">
      <h3 className="fs-set__sub-title" id="fs-router-title">
        {t('rd.settings.router.title')}
      </h3>
      <Link className="fs-set__link" to={ROUTER_LESSON_PATH}>
        {t('rd.settings.router.how')}
      </Link>
    </div>
  );

  if (router.load === 'loading') {
    return (
      <section className="fs-set__sub fs-router" id={ROUTER_SECTION_ID} aria-labelledby="fs-router-title" aria-busy="true" data-row="router">
        {head}
        <div className="fs-router__skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="fs-router__fine" role="status">
          {t('appRouter.loading')}
        </p>
      </section>
    );
  }

  if (router.data === null) {
    return (
      <section className="fs-set__sub fs-router" id={ROUTER_SECTION_ID} aria-labelledby="fs-router-title" data-row="router" data-state="error">
        {head}
        <div className="fs-router__problem" role="alert">
          <p>{t('appRouter.loadError')}</p>
          <Button size="sm" variant="secondary" icon="RefreshCw" onClick={router.reload}>
            {t('appRouter.retry')}
          </Button>
        </div>
      </section>
    );
  }

  const saved = router.data.config;
  const config = draft !== null && draft.base === saved ? draft.value : saved;
  const dirty = !sameConfig(config, saved);
  const readOnly = router.data.problems > 0;
  const savedIds = new Set(saved.entries.map((entry) => entry.id));
  const statusById = new Map<string, RouterEntryStatus>((router.status?.entries ?? []).map((entry) => [entry.id, entry]));
  const providerRows = providers.data.available ? providers.data.rows : null;
  const facts = (provider: string): ProviderFacts => {
    const row = providerRows?.find((item) => item.id === provider);
    return { paid: row?.kind === 'key', notice: row?.noticeRequired === true && row.kind !== 'local' };
  };
  const issues = validateDraft(config, facts);
  const serverByPath = new Map(serverErrors.map((error) => [normalizePath(error.path), locale === 'nl' ? error.nl || error.en : error.en || error.nl]));
  const issueFor = (path: string): string | null => {
    const fromServer = serverByPath.get(path);
    if (fromServer) return fromServer;
    const local = issues.find((issue) => issue.path === path);
    return local ? t(local.key, local.vars) : null;
  };
  // Q5-EIGEN-API-UI: a step whose own API was removed or switched off is skipped by the router, not an error.
  const skips = router.data.warnings.filter((warning) => config.entries.some((entry) => entry.id === warning.entryId));
  const skipText = (warning: (typeof skips)[number], label: string | null): string => {
    if (warning.code !== 'provider_unavailable') return (locale === 'nl' ? warning.nl || warning.en : warning.en || warning.nl) || warning.code;
    return label === null ? t('appRouter.chain.unavailable') : t('appRouter.chain.unavailableIn', { label });
  };
  const skipFor = (entryId: string): string | null => {
    const warning = skips.find((item) => item.entryId === entryId);
    return warning ? skipText(warning, null) : null;
  };

  /** A created account comes back as the gateway's SAVED config (the new entry appended). Unsaved choices the
   *  user made first (mode, defaults, entry edits) are carried over onto it instead of being thrown away, so
   *  "choose a mode, then add the account it needs" works (owner bug 2026-11-02). */
  function adoptCreated(next: RouterConfig) {
    const pending = dirty ? config : null;
    router.adopt(next);
    if (!pending) return;
    const known = new Set(pending.entries.map((entry) => entry.id));
    const added = next.entries.filter((entry) => !known.has(entry.id));
    setDraft({ base: next, value: { ...pending, revision: next.revision, updated_at: next.updated_at, entries: [...pending.entries, ...added] } });
  }

  function edit(next: RouterConfig) {
    setDraft({ base: saved, value: next });
    setServerErrors([]);
    setNotice(null);
  }

  function chooseMode(mode: RouterMode) {
    edit(withMode(config, mode));
  }

  function acknowledge(on: boolean) {
    edit({ ...config, multi_account: { enabled: on, acknowledged_at: on ? new Date().toISOString() : null } });
  }

  async function save() {
    if (issues.length > 0 || readOnly) return;
    setSaving(true);
    const outcome = await saveRouterConfig(config);
    setSaving(false);
    if (outcome.kind === 'saved') {
      setDraft(null);
      setServerErrors([]);
      // C3: the save answer carries the warnings of the stored config (null from an older gateway: read again).
      router.adopt(outcome.config, outcome.warnings);
      // Q6-SHOTS note 3: the chain changed, so the Eigen API section's "in use by the router" state reads again.
      signalRouterChanged();
      toast(t('appRouter.save.saved'), t('appRouter.save.savedDetail'), 'Check');
      return;
    }
    if (outcome.kind === 'invalid') {
      setServerErrors(outcome.errors);
      const first = outcome.errors[0];
      const reason = first ? (locale === 'nl' ? first.nl || first.en : first.en || first.nl) : '';
      toast(t('appRouter.save.notSaved', { reason }), undefined, 'TriangleAlert');
      return;
    }
    if (outcome.kind === 'stale') {
      setDraft(null);
      setServerErrors([]);
      if (outcome.config) router.adopt(outcome.config);
      else router.reload();
      setNotice(t('appRouter.save.stale'));
      return;
    }
    const reason =
      outcome.kind === 'refused' ? t('appRouter.accounts.refused') : outcome.kind === 'too-many' ? t('appRouter.save.tooMany') : outcome.error;
    setNotice(t('appRouter.save.notSaved', { reason }));
    toast(t('appRouter.save.notSaved', { reason }), undefined, 'TriangleAlert');
  }

  const mode = config.mode;
  const claudeNames = config.entries.filter(isClaude).map((entry) => entry.label);
  // The consent belongs to rotation (DESIGN.md §3.4). It also stays while switching is on elsewhere (saved or in
  // the draft), so the risk is never in force out of sight, and unticking it does not make the row vanish.
  const multiOn = config.multi_account.enabled || saved.multi_account.enabled;
  const showMulti = mode === 'claude-accounts' || (mode !== 'off' && multiOn && claudeNames.length >= 2);
  const showFallback = mode === 'claude-then-model' || mode === 'model-first';
  // Issues that have no field of their own on screen are listed at the save bar.
  const placed = new Set(['fallback', 'multi_account']);
  const loose = issues.filter((issue) => !placed.has(issue.path) && !(isAdvanced && /^(entries\[\d+\]|defaults)\./.test(issue.path)));
  const looseServer = serverErrors.filter((error) => !(isAdvanced && /^(entries\[\d+\]|defaults)\./.test(normalizePath(error.path))));
  // The own model the router uses now, and whether a check on it fails (then its panel opens by itself).
  const own = currentFallback(config);
  const ownAt = own ? config.entries.indexOf(own) : -1;
  const ownFields = ['model', 'paid_ack', 'notice_ack'];
  const ownProblem = showFallback && (issueFor('fallback') !== null || (ownAt >= 0 && ownFields.some((field) => issueFor(`entries[${ownAt}].${field}`) !== null)));
  // The service the own model runs on, in the same word as Je accounts, but only when it is not fine.
  const ownService = own ? providerRows?.find((row) => row.id === (own.kind === 'codex-account' ? 'codex-cli' : own.provider)) : undefined;
  const ownTone = ownService ? toneOf(ownService.status) : 'ok';
  const ownStatus =
    ownService && ownTone !== 'ok' ? { tone: ownTone, word: t(`settingsPage.accounts.status.${ownService.status}` as MessageKey) } : null;

  const accounts = (
    <AccountList
      config={config}
      savedIds={savedIds}
      statusById={statusById}
      profilesRoot={router.data.profilesRootDisplay}
      dirty={dirty}
      readOnly={readOnly}
      onAdd={() => setAdding(true)}
      onRemove={(id) => edit({ ...config, entries: config.entries.filter((entry) => entry.id !== id) })}
      onTested={router.refreshStatus}
      skipFor={skipFor}
      bare
    />
  );
  const picker = showFallback ? (
    <FallbackModelPicker
      config={config}
      onChange={edit}
      providers={providerRows}
      models={models.list}
      savedIds={savedIds}
      statusById={statusById}
      readOnly={readOnly}
      onRecheck={() => {
        providers.refresh();
        models.refresh();
      }}
      issueFor={issueFor}
      skipFor={skipFor}
      bare
      hideHeading={!isAdvanced}
    />
  ) : null;
  const terms = { sources: router.data.termsSources, checkedAt: router.data.termsCheckedAt };
  const consent = (extra: ReactNode) => (
    <MultiAccountNotice
      acknowledged={config.multi_account.enabled}
      onChange={acknowledge}
      sources={terms.sources}
      checkedAt={terms.checkedAt}
      names={claudeNames}
      disabled={readOnly}
    >
      {extra}
    </MultiAccountNotice>
  );
  const multiIssue = showMulti ? issueFor('multi_account') : null;

  return (
    <section
      className="fs-set__sub fs-router"
      id={ROUTER_SECTION_ID}
      aria-labelledby="fs-router-title"
      data-row="router"
      data-mode={mode}
      data-dirty={dirty || undefined}
    >
      {head}

      {router.data.provenance === 'UNREADABLE' ? <p className="fs-router__note">{t('appRouter.unreadable')}</p> : null}
      {readOnly ? (
        <p className="fs-router__note" role="note">
          {t('appRouter.problems')}
        </p>
      ) : null}

      {isAdvanced ? (
        <>
          <ChoiceList
            className="fs-router__modes"
            label={t('appRouter.modeLabel')}
            describe="selected"
            value={mode}
            onChange={(next) => chooseMode(next as RouterMode)}
            options={ROUTER_MODES.map((item) => ({
              value: item,
              title: t(MODE_SHORT[item]),
              description: t(MODE_TEXT[item]),
              disabled: readOnly,
            }))}
          />
          {showMulti ? <div className="fs-set__rows fs-router__rows">{consent(null)}</div> : null}
          {multiIssue ? <p className="fs-router__error">{multiIssue}</p> : null}
          {mode !== 'off' ? (
            <ChainEditor config={config} onChange={edit} readOnly={readOnly} issueFor={issueFor} problemInside={ownProblem} skipFor={skipFor}>
              {accounts}
              {picker}
            </ChainEditor>
          ) : null}
        </>
      ) : (
        <>
          <div className="fs-set__rows fs-router__rows">
            <div className="fs-set__row" data-row="router-mode">
              <div className="fs-set__text">
                <label className="fs-set__name" htmlFor={selectId}>
                  {t('rd.settings.router.ask')}
                </label>
                <span className="fs-set__note">{t('rd.settings.router.tellsYou')}</span>
              </div>
              <div className="fs-set__ctl">
                <select
                  id={selectId}
                  className="fs-set__select"
                  value={mode}
                  disabled={readOnly}
                  onChange={(event) => chooseMode(event.target.value as RouterMode)}
                >
                  {ROUTER_MODES.map((item) => (
                    <option key={item} value={item}>
                      {t(MODE_SHORT[item])}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {/* Eenvoudig has no "Volgorde": the account list sits behind the consent's "Meer info". */}
            {showMulti ? consent(accounts) : null}
            {showFallback ? (
              <OwnModelRow current={own?.label ?? null} problem={ownProblem} status={ownStatus}>
                {picker}
              </OwnModelRow>
            ) : null}
          </div>
          {multiIssue ? <p className="fs-router__error">{multiIssue}</p> : null}
          {mode !== 'off'
            ? skips.map((warning) => (
                <p key={`skip-${warning.entryId}`} className="fs-router-skip" role="note">
                  {skipText(warning, config.entries.find((entry) => entry.id === warning.entryId)?.label ?? warning.entryId)}
                </p>
              ))
            : null}
        </>
      )}

      {notice ? (
        <p className="fs-router__notice" role="status">
          {notice}
        </p>
      ) : null}

      {dirty || serverErrors.length > 0 ? (
        <div className="fs-router__savebar" role="group" aria-label={t('appRouter.save.save')}>
          <div className="fs-router__savebar-text">
            <p className="fs-router__dirty">{t('appRouter.save.dirty')}</p>
            {loose.length > 0 || looseServer.length > 0 ? (
              <div className="fs-router__issues" role="alert">
                <p>{t('appRouter.save.issues')}</p>
                <ul>
                  {loose.map((issue) => (
                    <li key={`c-${issue.path}-${issue.key}`}>{t(issue.key, issue.vars)}</li>
                  ))}
                  {looseServer.map((error) => (
                    <li key={`s-${error.path}-${error.code}`}>{locale === 'nl' ? error.nl || error.en : error.en || error.nl}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="fs-router__savebar-ctl">
            <Button variant="quiet" size="sm" onClick={() => edit(saved)} disabled={saving || !dirty}>
              {t('appRouter.save.discard')}
            </Button>
            <Button variant="primary" size="sm" icon="Check" onClick={() => void save()} disabled={saving || issues.length > 0 || readOnly || !dirty}>
              {saving ? t('appRouter.save.saving') : t('appRouter.save.save')}
            </Button>
          </div>
        </div>
      ) : null}

      <AddAccountDialog open={adding} onClose={() => setAdding(false)} onCreated={adoptCreated} />
    </section>
  );
}
