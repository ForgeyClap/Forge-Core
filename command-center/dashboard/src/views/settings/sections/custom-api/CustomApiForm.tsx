/**
 * CustomApiForm — "Eigen API" (ANY-MODEL-PLAN.md §2.2 E): name, API type, address, whether a
 * key is needed, the model list (fetched or typed, D6) and, under Uitgebreid, how the key travels
 * (own header name + prefix) and the context length. Saving stores only the DEFINITION through the
 * gateway; the key goes afterwards through the one key field (KeyField, desktop vault only).
 *
 * States: nieuw (empty) · fouten per veld (instant, after a field was left or Opslaan was pressed) ·
 * waarschuwing http (D1: private network, visible, not blocking) · opgeslagen (then the key field and
 * Testen appear: CustomApiConnect) · gateway refusals in their own words.
 */

import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { Button, Icon } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { createCustomProvider, CUSTOM_FORMATS, updateCustomProvider } from '@/prototype/state/adapter/providers-custom';
import type { CustomFieldError, CustomProviderEntry, CustomSaveOutcome } from '@/prototype/state/adapter/providers-custom';
import type { KeySource, VaultKeyStatus } from '@/prototype/state/adapter/providers';

import { CustomApiAdvanced } from './CustomApiAdvanced';
import { CustomApiConnect } from './CustomApiConnect';
import { classifyBaseUrl, draftFromEntry, emptyDraft, toDefinition, urlHint, validateDraft } from './custom-api-model';
import type { CustomDraft, DraftField, DraftIssue } from './custom-api-model';

import './custom-api.css';

/** Gateway error paths (§2.2 D) -> the field they belong to. */
function fieldOfPath(path: string): DraftField | null {
  if (path === 'label' || path.endsWith('.label')) return 'label';
  if (/baseurl/i.test(path)) return 'baseURL';
  if (/header/i.test(path)) return 'header';
  if (/prefix/i.test(path)) return 'prefix';
  if (/models/i.test(path)) return 'models';
  if (/context/i.test(path)) return 'contextLength';
  return null;
}

export interface CustomApiFormProps {
  /** The saved entry when editing, or null for a new one. */
  readonly entry: CustomProviderEntry | null;
  /** The list revision the save must be based on (optimistic concurrency). */
  readonly revision: number;
  /** After a save: the entry, the new revision and the router steps that name it (null = not said). Form stays open. */
  readonly onSaved: (entry: CustomProviderEntry, revision: number, routerEntries: readonly string[] | null) => void;
  /** The list changed under us (409 stale): re-read it. */
  readonly onStale: () => void;
  readonly onClose: () => void;
  /** Editing only: remove the entry (the section asks for confirmation first). */
  readonly onRemove?: () => void;
  readonly removing?: boolean;
  /** For the key field after saving. */
  readonly vaultStatus: VaultKeyStatus | null;
  readonly keySource: KeySource | null;
  readonly onKeyChanged: () => void;
  /** Heading level of the form title (h4 in Settings, h3 in onboarding). */
  readonly headingLevel?: 3 | 4;
  /** Settings shows the form in a dialog whose own title says the same: the form then draws no heading. */
  readonly titleInDialog?: boolean;
  /** Extra content under the saved state (onboarding: "use this model right away"). */
  readonly afterSaved?: (entry: CustomProviderEntry) => ReactNode;
}

type Notice = { readonly tone: 'ok' | 'bad'; readonly text: string } | null;

export function CustomApiForm(props: CustomApiFormProps) {
  const { entry, revision, onSaved, onStale, onClose, onRemove, removing = false, vaultStatus, keySource, onKeyChanged } = props;
  const { t, locale } = useLocale();
  const base = useId();
  const [draft, setDraft] = useState<CustomDraft>(() => (entry ? draftFromEntry(entry) : emptyDraft()));
  const [saved, setSaved] = useState<CustomProviderEntry | null>(entry);
  const [touched, setTouched] = useState<ReadonlySet<DraftField>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [serverErrors, setServerErrors] = useState<readonly CustomFieldError[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const issues = validateDraft(draft);
  const verdict = classifyBaseUrl(draft.baseURL);
  const hint = verdict.kind === 'https' || verdict.kind === 'local' || verdict.kind === 'lan' ? urlHint(draft.format, draft.baseURL) : null;
  const ids = {
    label: `${base}-label`,
    format: `${base}-format`,
    baseURL: `${base}-url`,
    header: `${base}-header`,
    prefix: `${base}-prefix`,
    models: `${base}-models`,
    contextLength: `${base}-ctx`,
    auth: `${base}-auth`,
  };
  const Heading = props.headingLevel === 3 ? 'h3' : 'h4';

  function update(patch: Partial<CustomDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setNotice(null);
    setServerErrors([]);
  }

  function leave(field: DraftField) {
    setTouched((current) => (current.has(field) ? current : new Set(current).add(field)));
  }

  function issueText(issue: DraftIssue): string {
    if (issue.code === 'required' && issue.field === 'models') return t('customApi.errors.modelsRequired');
    return t(`customApi.errors.${issue.code}` as MessageKey);
  }

  /** The message under one field: the gateway's own words win, else the local rule once the field was left. */
  function errorFor(field: DraftField): string | null {
    const fromServer = serverErrors.find((error) => fieldOfPath(error.path) === field);
    if (fromServer) return (locale === 'en' ? fromServer.en : fromServer.nl) || fromServer.code;
    if (!submitted && !touched.has(field)) return null;
    const issue = issues.find((item) => item.field === field);
    return issue ? issueText(issue) : null;
  }

  function outcomeNotice(outcome: Exclude<CustomSaveOutcome, { kind: 'saved' | 'invalid' }>): Notice {
    switch (outcome.kind) {
      case 'stale':
        return { tone: 'bad', text: t('customApi.outcome.stale') };
      case 'duplicate':
        return { tone: 'bad', text: t('customApi.outcome.duplicate') };
      case 'refused':
        return { tone: 'bad', text: t('customApi.outcome.refused') };
      case 'missing':
        return { tone: 'bad', text: t('customApi.missing') };
      case 'too-many':
        return { tone: 'bad', text: t('customApi.outcome.tooMany') };
      default:
        return { tone: 'bad', text: t('customApi.outcome.failed', { reason: outcome.error }) };
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setServerErrors([]);
    if (issues.length > 0) {
      setNotice({ tone: 'bad', text: t('customApi.form.fixFirst') });
      return;
    }
    setBusy(true);
    setNotice(null);
    const definition = toDefinition(draft);
    const outcome = saved ? await updateCustomProvider(saved.id, definition, revision) : await createCustomProvider(definition, revision);
    setBusy(false);
    if (outcome.kind === 'saved') {
      setSaved(outcome.entry);
      setNotice({ tone: 'ok', text: t('customApi.form.savedLine') });
      onSaved(outcome.entry, outcome.revision, outcome.routerEntries);
      return;
    }
    if (outcome.kind === 'invalid') {
      setServerErrors(outcome.errors);
      const loose = outcome.errors.find((error) => fieldOfPath(error.path) === null);
      setNotice({ tone: 'bad', text: loose ? (locale === 'en' ? loose.en : loose.nl) || loose.code : t('customApi.form.fixFirst') });
      return;
    }
    if (outcome.kind === 'stale') onStale();
    setNotice(outcomeNotice(outcome));
  }

  function fieldProps(field: DraftField) {
    const error = errorFor(field);
    const errorId = `${ids[field]}-error`;
    return {
      id: ids[field],
      'aria-invalid': error ? true : undefined,
      'aria-describedby': error ? errorId : undefined,
      onBlur: () => leave(field),
      error,
      errorId,
    };
  }

  const label = fieldProps('label');
  const url = fieldProps('baseURL');
  const header = fieldProps('header');
  const prefix = fieldProps('prefix');
  const models = fieldProps('models');
  const context = fieldProps('contextLength');

  let urlState: { tone: 'ok' | 'warn'; text: string } | null = null;
  if (!url.error) {
    if (verdict.kind === 'https') urlState = { tone: 'ok', text: t('customApi.url.https') };
    else if (verdict.kind === 'local') urlState = { tone: 'ok', text: t('customApi.url.local') };
    else if (verdict.kind === 'lan') urlState = { tone: 'warn', text: t('customApi.url.lan') };
  }
  const title = saved ? t('customApi.form.titleEdit', { name: saved.label }) : t('customApi.form.titleNew');

  return (
    <div className="fs-capi__form-wrap" data-state={saved ? 'saved' : 'new'}>
      <form className="fs-capi__form" onSubmit={(event) => void onSubmit(event)} noValidate aria-labelledby={`${base}-title`}>
        {props.titleInDialog ? (
          <span hidden id={`${base}-title`}>
            {title}
          </span>
        ) : (
          <Heading className="fs-capi__form-title" id={`${base}-title`}>
            {title}
          </Heading>
        )}

        <div className="fs-capi__grid">
          <div className="fs-capi__field">
            <label className="fs-capi__label" htmlFor={label.id}>
              {t('customApi.form.label')}
            </label>
            <input
              id={label.id}
              className="fs-capi__input"
              type="text"
              autoComplete="off"
              maxLength={60}
              value={draft.label}
              aria-invalid={label['aria-invalid']}
              aria-describedby={label.error ? label.errorId : `${label.id}-hint`}
              onBlur={label.onBlur}
              onChange={(event) => update({ label: event.target.value })}
            />
            {label.error ? (
              <p className="fs-capi__error" id={label.errorId}>
                {label.error}
              </p>
            ) : (
              <p className="fs-capi__hint" id={`${label.id}-hint`}>
                {t('customApi.form.labelHint')}
              </p>
            )}
          </div>

          <div className="fs-capi__field">
            <label className="fs-capi__label" htmlFor={ids.format}>
              {t('customApi.form.format')}
            </label>
            <select
              id={ids.format}
              className="fs-capi__select"
              value={draft.format}
              aria-describedby={`${ids.format}-hint`}
              onChange={(event) => update({ format: event.target.value as CustomDraft['format'] })}
            >
              {CUSTOM_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`customApi.formats.${format}`)}
                </option>
              ))}
            </select>
            <p className="fs-capi__hint" id={`${ids.format}-hint`}>
              {t('customApi.form.formatHint')}
            </p>
          </div>

          <div className="fs-capi__field fs-capi__field--wide">
            <label className="fs-capi__label" htmlFor={url.id}>
              {t('customApi.form.baseURL')}
            </label>
            <input
              id={url.id}
              className="fs-capi__input fs-capi__input--mono"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('customApi.form.baseURLPlaceholder')}
              value={draft.baseURL}
              aria-invalid={url['aria-invalid']}
              aria-describedby={url.error ? url.errorId : urlState ? `${url.id}-state` : undefined}
              onBlur={url.onBlur}
              onChange={(event) => update({ baseURL: event.target.value })}
            />
            {url.error ? (
              <p className="fs-capi__error" id={url.errorId}>
                {url.error}
              </p>
            ) : null}
            {urlState ? (
              <p className="fs-capi__urlstate" id={`${url.id}-state`} data-tone={urlState.tone} role={urlState.tone === 'warn' ? 'note' : undefined}>
                <Icon name={urlState.tone === 'warn' ? 'TriangleAlert' : 'Lock'} size="sm" />
                <span>{urlState.text}</span>
              </p>
            ) : null}
            {hint ? <p className="fs-capi__hint">{t(`customApi.url.${hint}`)}</p> : null}
          </div>
        </div>

        <fieldset className="fs-capi__set">
          <legend className="fs-capi__label">{t('customApi.form.key')}</legend>
          <label className="fs-capi__check">
            <input type="checkbox" checked={draft.noKey} onChange={(event) => update({ noKey: event.target.checked })} />
            <span>
              {t('customApi.form.noKey')}
              <small>{t('customApi.form.noKeyHint')}</small>
            </span>
          </label>
          {!draft.noKey && !saved ? <p className="fs-capi__aside">{t('customApi.form.keyAfterSave')}</p> : null}
        </fieldset>

        <fieldset className="fs-capi__set">
          <legend className="fs-capi__label">{t('customApi.form.models')}</legend>
          <div className="fs-capi__choice" role="radiogroup" aria-label={t('customApi.form.models')}>
            {(['endpoint', 'manual'] as const).map((mode) => (
              <label key={mode} className="fs-capi__radio" data-checked={draft.modelsMode === mode}>
                <input
                  type="radio"
                  name={`${base}-models-mode`}
                  value={mode}
                  checked={draft.modelsMode === mode}
                  onChange={() => update({ modelsMode: mode })}
                />
                <span>{mode === 'endpoint' ? t('customApi.form.modelsEndpoint') : t('customApi.form.modelsManual')}</span>
              </label>
            ))}
          </div>
          {draft.modelsMode === 'manual' ? (
            <div className="fs-capi__field">
              <label className="fs-capi__label fs-capi__label--sub" htmlFor={models.id}>
                {t('customApi.form.manualLabel')}
              </label>
              <textarea
                id={models.id}
                className="fs-capi__input fs-capi__input--mono fs-capi__textarea"
                rows={3}
                spellCheck={false}
                value={draft.manualIds}
                aria-invalid={models['aria-invalid']}
                aria-describedby={models.error ? models.errorId : `${models.id}-hint`}
                onBlur={models.onBlur}
                onChange={(event) => update({ manualIds: event.target.value })}
              />
              {models.error ? (
                <p className="fs-capi__error" id={models.errorId}>
                  {models.error}
                </p>
              ) : (
                <p className="fs-capi__hint" id={`${models.id}-hint`}>
                  {t('customApi.form.manualHint')}
                </p>
              )}
            </div>
          ) : null}
        </fieldset>

        <CustomApiAdvanced draft={draft} update={update} authId={ids.auth} header={header} prefix={prefix} context={context} />

        <div className="fs-capi__foot">
          <div className="fs-capi__foot-main">
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              {busy ? t('customApi.form.saving') : t('customApi.form.save')}
            </Button>
            <Button size="sm" variant="quiet" onClick={onClose} disabled={busy}>
              {saved ? t('customApi.form.close') : t('customApi.form.cancel')}
            </Button>
          </div>
          {saved && onRemove ? (
            <div className="fs-capi__foot-side">
              {confirmRemove ? (
                <>
                  <Button size="sm" variant="danger" onClick={onRemove} disabled={removing}>
                    {removing ? t('customApi.form.removing') : t('customApi.form.confirmRemove')}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setConfirmRemove(false)} disabled={removing}>
                    {t('customApi.form.cancel')}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="quiet" icon="Trash2" onClick={() => setConfirmRemove(true)}>
                  {t('customApi.form.remove')}
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {confirmRemove && !draft.noKey ? <p className="fs-capi__hint">{t('customApi.form.removeKeyToo')}</p> : null}
        <p className="fs-capi__notice" role="status" data-tone={notice?.tone}>
          {notice?.text ?? ''}
        </p>
      </form>

      {saved ? (
        <CustomApiConnect
          entry={saved}
          needsKey={saved.auth.type !== 'none'}
          vaultStatus={vaultStatus}
          keySource={keySource}
          onKeyChanged={onKeyChanged}
        />
      ) : null}
      {saved && props.afterSaved ? props.afterSaved(saved) : null}
    </div>
  );
}
