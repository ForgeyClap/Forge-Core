/**
 * FallbackModelPicker — the own model Forge carries on with (APP-ROUTER-DESIGN.md §1 modes b/c, §5.2.6, §6.2).
 *
 * Provider select (Ollama on this computer first, then other connected services, then Codex when its own
 * sign-in is there), model select from the models that service really lists, a status line, Testen and the
 * capability note: a model through this route can only answer. Every state is spelled out: Ollama not
 * running, no models yet, the chosen model not on this computer, a list that was never fetched.
 * v1.0 fix round FX-C: the router shows it inside a "Meer info" (`bare`: no frame; `hideHeading` where the row
 * already names it), so Eenvoudig keeps one row per item (DESIGN.md §1 rule 2, §5).
 */

import { useId, useState } from 'react';

import { Button } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { testTarget } from '@/prototype/state/adapter/app-router';
import type { ProviderModels, RouterConfig, RouterEntry, RouterEntryStatus, TestOutcome } from '@/prototype/state/adapter/app-router';
import type { ProviderRow } from '@/prototype/state/adapter/providers';

import { OLLAMA_LOCAL, SKIP_REASONS, currentFallback, entryPill, fallbackEntryId, fallbackLabel, fallbackProviders, isFallback, presetOrder } from './app-router-model';
import { unusableNote } from './test-note';
import { useNow } from './use-now';

const CODEX_OPTION = 'codex';

export interface FallbackModelPickerProps {
  readonly config: RouterConfig;
  readonly onChange: (next: RouterConfig) => void;
  readonly providers: readonly ProviderRow[] | null;
  readonly models: readonly ProviderModels[] | null;
  readonly savedIds: ReadonlySet<string>;
  readonly statusById: ReadonlyMap<string, RouterEntryStatus>;
  readonly readOnly: boolean;
  readonly onRecheck: () => void;
  readonly issueFor: (path: string) => string | null;
  /** The skip notice of a step the router skips (an own API removed, off or without cost confirmation), else null. */
  readonly skipFor?: (entryId: string) => string | null;
  /** Inside a "Meer info" (DESIGN.md §6): no own frame. */
  readonly bare?: boolean;
  /** The row around it already names it: the heading stays for screen readers only. */
  readonly hideHeading?: boolean;
}

function shortName(row: ProviderRow | undefined, id: string): string {
  if (id === OLLAMA_LOCAL) return 'Ollama';
  return (row?.label ?? id).replace(/\s*\(.*\)\s*$/, '').slice(0, 24);
}

/** Put `chosen` first among the fallbacks and switch it on, then apply the mode's preset order. */
function choose(config: RouterConfig, chosen: RouterEntry): RouterConfig {
  const others = config.entries.filter((entry) => entry.id !== chosen.id);
  const firstFallback = others.findIndex(isFallback);
  const at = firstFallback < 0 ? others.length : firstFallback;
  const entries = [...others.slice(0, at), { ...chosen, enabled: true }, ...others.slice(at)];
  return { ...config, entries: config.mode === 'off' ? entries : presetOrder(entries, config.mode) };
}

export function FallbackModelPicker(props: FallbackModelPickerProps) {
  const { config, onChange, providers, models, savedIds, statusById, readOnly, onRecheck, issueFor, skipFor, bare = false, hideHeading = false } = props;
  const { t, locale } = useLocale();
  const providerId = useId();
  const modelId = useId();
  const current = currentFallback(config);
  const options = fallbackProviders(providers);
  const codexRow = providers?.find((row) => row.id === 'codex-cli') ?? null;
  const codexOffered = codexRow?.status === 'connected' || current?.kind === 'codex-account';
  const currentProvider = current?.kind === 'codex-account' ? CODEX_OPTION : current?.provider ?? '';
  const [picked, setPicked] = useState<string | null>(null);
  const provider = picked ?? currentProvider;
  const row = options.find((option) => option.id === provider) ?? providers?.find((option) => option.id === provider);
  const listing = models?.find((item) => item.id === provider) ?? null;
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const now = useNow();

  const ollamaDown = provider === OLLAMA_LOCAL && row !== undefined && (row.status === 'unreachable' || row.status === 'missing' || row.status === 'error');
  const known = listing !== null && listing.source !== 'not-fetched';
  const modelList = listing?.models ?? [];
  const editable = current?.kind === 'provider-model' && current.provider === provider ? current : null;
  const notPulled = editable !== null && known && modelList.length > 0 && !modelList.includes(editable.model ?? '');
  const paid = row?.kind === 'key';
  const notice = row?.noticeRequired === true && row.kind !== 'local';

  function pickProvider(next: string) {
    setPicked(next);
    setTest(null);
    if (next === CODEX_OPTION) {
      const existing = config.entries.find((entry) => entry.kind === 'codex-account');
      onChange(choose(config, existing ?? { id: 'codex', kind: 'codex-account', label: 'Codex', profile: null, enabled: true }));
    }
  }

  function pickModel(model: string) {
    if (!model || provider === '' || provider === CODEX_OPTION) return;
    setTest(null);
    const label = fallbackLabel(shortName(row, provider), model);
    const existing = config.entries.find((entry) => entry.kind === 'provider-model' && entry.provider === provider);
    if (existing) {
      onChange(choose(config, { ...existing, model, label }));
      return;
    }
    const taken = new Set(config.entries.map((entry) => entry.id));
    onChange(
      choose(config, {
        id: fallbackEntryId(provider, model, taken),
        kind: 'provider-model',
        label,
        provider,
        model,
        enabled: true,
        num_ctx: provider === OLLAMA_LOCAL ? 8192 : null,
        vars: provider === OLLAMA_LOCAL ? { port: '11434' } : {},
        paid_ack: false,
        notice_ack: false,
      }),
    );
  }

  function patchCurrent(patch: Partial<RouterEntry>) {
    if (!editable) return;
    onChange({ ...config, entries: config.entries.map((entry) => (entry.id === editable.id ? ({ ...entry, ...patch } as RouterEntry) : entry)) });
  }

  async function runTest() {
    if (!current) return;
    setTesting(true);
    setTest(null);
    setTest(await testTarget(current.id));
    setTesting(false);
  }

  // Q6-UI: a step the router skips cannot be tested (the gateway answers 409 entry_unusable); say why up front.
  const skip = current !== null && skipFor ? skipFor(current.id) : null;
  // Q7: skipped by the router per its warnings or per the status row. When that changes (the re-read after a fix
  // or a 409), an earlier test answer is stale: forget it, so a 409 note never outlives the skip.
  const skippedNow = skip !== null || SKIP_REASONS.has((current && statusById.get(current.id)?.ineligibleReason) ?? '');
  const skipKey = `${current?.id ?? ''}|${skippedNow}`;
  const [seenSkipKey, setSeenSkipKey] = useState(skipKey);
  if (seenSkipKey !== skipKey) {
    setSeenSkipKey(skipKey);
    setTest(null);
  }
  const unusable = skip !== null || test?.kind === 'unusable';

  let statusLine: string | null = null;
  let statusTone: 'ok' | 'warn' | 'bad' | 'off' | 'busy' = 'off';
  if (provider === CODEX_OPTION) statusLine = t('appRouter.fallback.capabilityCodex');
  else if (ollamaDown) {
    statusLine = t('appRouter.fallback.ollamaDown');
    statusTone = 'bad';
  } else if (provider !== '' && models === null) statusLine = t('appRouter.fallback.checking');
  // An unknown list normally means "test it under Accounts", but a removed or switched-off API has nothing
  // there to test: then the blocked/409 note and the skip note carry the reason alone (no second instruction).
  else if (provider !== '' && !known) statusLine = unusable ? null : t('appRouter.fallback.listUnknown');
  else if (provider === OLLAMA_LOCAL && modelList.length === 0) {
    statusLine = t('appRouter.fallback.noModels');
    statusTone = 'warn';
  } else if (notPulled) {
    statusLine = t('appRouter.fallback.notPulled');
    statusTone = 'bad';
  } else if (current && (current.provider === provider || current.kind === 'codex-account')) {
    const pill = entryPill({ entry: current, status: statusById.get(current.id) ?? null, greyed: false, testing, test, locale, now });
    // A skipped step never reads green next to "Testen kan nu niet", even before the status row says why.
    statusLine = skippedNow && pill.tone === 'ok' ? null : t(pill.key, pill.vars);
    statusTone = pill.tone;
  }
  const testNote =
    test?.kind === 'unusable'
      ? unusableNote(test, t, locale)
      : skip !== null && test === null
        ? t('appRouter.accounts.testBlocked')
        : test?.kind === 'too-soon'
      ? t('appRouter.accounts.tooSoon', { min: Math.max(1, Math.ceil((test.retryAfterS ?? 300) / 60)) })
      : test?.kind === 'failed' || test?.kind === 'refused'
        ? t('appRouter.accounts.testFailed', { reason: test.error })
        : null;
  const canTest = current !== null && savedIds.has(current.id) && provider === currentProvider && skip === null;
  const modelIssue = editable ? issueFor(`entries[${config.entries.indexOf(editable)}].model`) : null;
  const missing = issueFor('fallback');

  return (
    <section
      className={bare ? 'fs-router__block fs-router__block--bare' : 'fs-router__block'}
      aria-labelledby="fs-router-fallback-h"
      data-block="fallback"
    >
      <h4 className={hideHeading ? 'fw-visually-hidden' : 'fs-router__block-title'} id="fs-router-fallback-h">
        {t('appRouter.fallback.heading')}
      </h4>
      <p className="fs-router__hint">{t('appRouter.fallback.recommend')}</p>
      <div className="fs-router__pick">
        <div className="fs-router__field">
          <label className="fs-router__label" htmlFor={providerId}>
            {t('appRouter.fallback.providerLabel')}
          </label>
          <select id={providerId} className="fs-set__select" value={provider} disabled={readOnly} onChange={(event) => pickProvider(event.target.value)}>
            <option value="" disabled>
              {t('appRouter.fallback.choose')}
            </option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.id === OLLAMA_LOCAL ? t('appRouter.fallback.ollamaLocal') : option.label}
              </option>
            ))}
            {options.some((option) => option.id === OLLAMA_LOCAL) ? null : <option value={OLLAMA_LOCAL}>{t('appRouter.fallback.ollamaLocal')}</option>}
            {codexOffered ? <option value={CODEX_OPTION}>{t('appRouter.fallback.codex')}</option> : null}
            {currentProvider !== '' && currentProvider !== CODEX_OPTION && currentProvider !== OLLAMA_LOCAL && !options.some((option) => option.id === currentProvider) ? (
              <option value={currentProvider}>{current?.label ?? currentProvider}</option>
            ) : null}
          </select>
        </div>
        {provider !== CODEX_OPTION ? (
          <div className="fs-router__field">
            <label className="fs-router__label" htmlFor={modelId}>
              {t('appRouter.fallback.modelLabel')}
            </label>
            <select
              id={modelId}
              className="fs-set__select"
              value={editable?.model ?? ''}
              disabled={readOnly || provider === '' || (modelList.length === 0 && !editable)}
              aria-invalid={notPulled || modelIssue !== null || undefined}
              onChange={(event) => pickModel(event.target.value)}
            >
              <option value="" disabled>
                {t('appRouter.fallback.choose')}
              </option>
              {modelList.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
              {editable && !modelList.includes(editable.model ?? '') ? <option value={editable.model}>{editable.model}</option> : null}
            </select>
          </div>
        ) : null}
        <div className="fs-router__pick-ctl">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runTest()}
            disabled={!canTest || testing}
            title={skip ?? (canTest ? t('appRouter.accounts.testHint') : t('appRouter.accounts.testSaveFirst'))}
          >
            {t('appRouter.accounts.test')}
          </Button>
        </div>
      </div>

      <p className="fs-router__status" role="status" data-tone={statusTone}>
        {statusLine ? (
          <>
            <span className="fs-pill" data-tone={statusTone}>
              <span className="fs-pill__dot" aria-hidden="true" />
              {statusLine}
            </span>
            {ollamaDown ? (
              <Button size="sm" variant="quiet" icon="RefreshCw" onClick={onRecheck}>
                {t('appRouter.fallback.checkAgain')}
              </Button>
            ) : null}
          </>
        ) : null}
        {testNote ? <span className="fs-router__fine">{testNote}</span> : null}
      </p>

      {editable && paid ? (
        <label className="fs-router__check">
          <input type="checkbox" checked={editable.paid_ack === true} disabled={readOnly} onChange={(event) => patchCurrent({ paid_ack: event.target.checked })} />
          <span>{t('appRouter.fallback.paidAck')}</span>
        </label>
      ) : null}
      {editable && notice ? (
        <label className="fs-router__check">
          <input type="checkbox" checked={editable.notice_ack === true} disabled={readOnly} onChange={(event) => patchCurrent({ notice_ack: event.target.checked })} />
          <span>{t('appRouter.fallback.noticeAck')}</span>
        </label>
      ) : null}

      {provider !== CODEX_OPTION && provider !== '' ? (
        <p className="fs-router__capability">{t('appRouter.fallback.capability')}</p>
      ) : null}
      {missing ? <p className="fs-router__error">{missing}</p> : null}
      {modelIssue ? <p className="fs-router__error">{modelIssue}</p> : null}
    </section>
  );
}
