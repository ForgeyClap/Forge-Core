/**
 * CustomApiAdvanced — the "Uitgebreid" part of the Eigen API form (split out of `CustomApiForm.tsx`, Q6-UI):
 * how the key travels (auth type, own header name + prefix), the context length and the on/off switch. It
 * opens by itself when one of them is set or has an error. The form keeps the draft, the validation and the
 * field bindings; this block only draws them.
 */

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';

import { usesCustomHeader } from './custom-api-model';
import type { CustomDraft, DraftAuth } from './custom-api-model';

const AUTH_CHOICES: readonly DraftAuth[] = ['auto', 'bearer', 'x-api-key', 'api-key-header', 'custom'];

/** One field's wiring as the form computes it (`fieldProps`). */
export interface FieldBinding {
  readonly id: string;
  readonly 'aria-invalid': boolean | undefined;
  readonly 'aria-describedby': string | undefined;
  readonly onBlur: () => void;
  readonly error: string | null;
  readonly errorId: string;
}

export interface CustomApiAdvancedProps {
  readonly draft: CustomDraft;
  readonly update: (patch: Partial<CustomDraft>) => void;
  readonly authId: string;
  readonly header: FieldBinding;
  readonly prefix: FieldBinding;
  readonly context: FieldBinding;
}

export function CustomApiAdvanced({ draft, update, authId, header, prefix, context }: CustomApiAdvancedProps) {
  const { t } = useLocale();
  const ids = { auth: authId };
  const advancedSet = draft.authType !== 'auto' || draft.contextLength !== '' || !draft.enabled;
  return (
    <details className="fs-capi__more" open={advancedSet || header.error !== null || context.error !== null || undefined}>
      <summary>
        <Icon name="ChevronRight" size="sm" className="fs-capi__chev" />
        <span>{t('customApi.form.advanced')}</span>
      </summary>
      <div className="fs-capi__grid">
        {!draft.noKey ? (
          <div className="fs-capi__field">
            <label className="fs-capi__label" htmlFor={ids.auth}>
              {t('customApi.form.authLabel')}
            </label>
            <select id={ids.auth} className="fs-capi__select" value={draft.authType} onChange={(event) => update({ authType: event.target.value as DraftAuth })}>
              {AUTH_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {t(`customApi.form.auth.${choice}`)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="fs-capi__field">
          <label className="fs-capi__label" htmlFor={context.id}>
            {t('customApi.form.contextLength')}
          </label>
          <input
            id={context.id}
            className="fs-capi__input fs-capi__input--mono"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={draft.contextLength}
            aria-invalid={context['aria-invalid']}
            aria-describedby={context.error ? context.errorId : `${context.id}-hint`}
            onBlur={context.onBlur}
            onChange={(event) => update({ contextLength: event.target.value })}
          />
          {context.error ? (
            <p className="fs-capi__error" id={context.errorId}>
              {context.error}
            </p>
          ) : (
            <p className="fs-capi__hint" id={`${context.id}-hint`}>
              {t('customApi.form.contextHint')}
            </p>
          )}
        </div>
        {usesCustomHeader(draft) ? (
          <>
            <div className="fs-capi__field">
              <label className="fs-capi__label" htmlFor={header.id}>
                {t('customApi.form.header')}
              </label>
              <input
                id={header.id}
                className="fs-capi__input fs-capi__input--mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="X-Auth-Token"
                value={draft.header}
                aria-invalid={header['aria-invalid']}
                aria-describedby={header.error ? header.errorId : undefined}
                onBlur={header.onBlur}
                onChange={(event) => update({ header: event.target.value })}
              />
              {header.error ? (
                <p className="fs-capi__error" id={header.errorId}>
                  {header.error}
                </p>
              ) : null}
            </div>
            <div className="fs-capi__field">
              <label className="fs-capi__label" htmlFor={prefix.id}>
                {t('customApi.form.prefix')}
              </label>
              <input
                id={prefix.id}
                className="fs-capi__input fs-capi__input--mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={draft.prefix}
                aria-invalid={prefix['aria-invalid']}
                aria-describedby={prefix.error ? prefix.errorId : `${prefix.id}-hint`}
                onBlur={prefix.onBlur}
                onChange={(event) => update({ prefix: event.target.value })}
              />
              {prefix.error ? (
                <p className="fs-capi__error" id={prefix.errorId}>
                  {prefix.error}
                </p>
              ) : (
                <p className="fs-capi__hint" id={`${prefix.id}-hint`}>
                  {t('customApi.form.prefixHint')}
                </p>
              )}
            </div>
          </>
        ) : null}
        <label className="fs-capi__check fs-capi__field--wide">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
          <span>{t('customApi.form.enabled')}</span>
        </label>
      </div>
    </details>
  );
}
