/**
 * ChainEditor — Uitgebreid only: "Volgorde", the full try order (APP-ROUTER-DESIGN.md §1; DESIGN.md §3.4).
 *
 * Reorder with Omhoog / Omlaag buttons (keyboard-operable, never drag-only; focus follows the moved row) and
 * an on/off switch per entry. Behind "Meer info" (v1.0 fix round FX-C, DESIGN.md §5, §6): per entry the
 * threshold ("Wissel bij … %", empty = the general value), per own model the context size and, for Ollama,
 * its port; then the general cooldown, strategy, return rule and the number of messages passed on at a
 * switch, and whatever the router adds (`children`: the Claude accounts and the own model). Inline errors
 * come from the same path the server uses; when one of them is set, "Meer info" opens by itself.
 */

import { useId, useRef } from 'react';
import type { ReactNode } from 'react';

import { IconButton, Switch } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import type { RouterConfig, RouterDefaults, RouterEntry } from '@/prototype/state/adapter/app-router';

import { COOLDOWN_RANGE, HANDOVER_RANGE, NUM_CTX_RANGE, THRESHOLD_MAX, THRESHOLD_MIN, greyedByGate, moveEntry } from './app-router-model';
import { MoreInfo } from './MoreInfo';
import { useOpensOnProblem } from './use-opens-on-problem';

import './router-skip.css';

export interface ChainEditorProps {
  readonly config: RouterConfig;
  readonly onChange: (next: RouterConfig) => void;
  readonly readOnly: boolean;
  readonly issueFor: (path: string) => string | null;
  /** True when something behind "Meer info" outside the chain fields has an error (for example the own model). */
  readonly problemInside?: boolean;
  /** Extra blocks behind "Meer info", after the general values. */
  readonly children?: ReactNode;
  /** The skip notice for a chain entry whose own API was removed or switched off (Q5-EIGEN-API-UI), else null. */
  readonly skipFor?: (entryId: string) => string | null;
}

const KIND_KEY: Readonly<Record<RouterEntry['kind'], MessageKey>> = {
  'claude-account': 'appRouter.chain.kindClaude',
  'codex-account': 'appRouter.chain.kindCodex',
  'provider-model': 'appRouter.chain.kindModel',
};

/** '' -> null, otherwise an integer (a non-number stays NaN, which the validation then reports). */
function intOrNull(raw: string): number | null {
  if (raw.trim() === '') return null;
  return Number(raw);
}

/** The field paths this editor shows behind "Meer info". */
function chainPaths(config: RouterConfig): readonly string[] {
  const perEntry = config.entries.flatMap((_, index) => [`entries[${index}].threshold_pct`, `entries[${index}].num_ctx`, `entries[${index}].vars`]);
  return [...perEntry, 'defaults.cooldown_min', 'defaults.handover_turns'];
}

export function ChainEditor({ config, onChange, readOnly, issueFor, problemInside = false, children, skipFor }: ChainEditorProps) {
  const { t } = useLocale();
  const base = useId();
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const problem = problemInside || chainPaths(config).some((path) => issueFor(path) !== null);
  const [details, setDetails] = useOpensOnProblem(problem);

  function patch(id: string, change: Partial<RouterEntry>) {
    onChange({ ...config, entries: config.entries.map((entry) => (entry.id === id ? ({ ...entry, ...change } as RouterEntry) : entry)) });
  }

  function patchDefaults(change: Partial<RouterDefaults>) {
    onChange({ ...config, defaults: { ...config.defaults, ...change } });
  }

  function move(index: number, delta: -1 | 1, id: string) {
    onChange({ ...config, entries: moveEntry(config.entries, index, delta) });
    // Keep the keyboard where it was: on the same button of the moved row, or its sibling at the edge.
    window.requestAnimationFrame(() => {
      const row = rowRefs.current.get(id);
      const preferred = row?.querySelector<HTMLButtonElement>(`[data-move="${delta}"]:not([disabled])`);
      (preferred ?? row?.querySelector<HTMLButtonElement>('[data-move]:not([disabled])'))?.focus();
    });
  }

  const defaults = config.defaults;
  const cooldownIssue = issueFor('defaults.cooldown_min');
  const handoverIssue = issueFor('defaults.handover_turns');

  return (
    <section className="fs-router__block fs-router__chain" aria-labelledby={`${base}-h`}>
      <h4 className="fs-router__block-title" id={`${base}-h`}>
        {t('rd.settings.router.order')}
      </h4>
      <ol className="fs-router__chain-list">
        {config.entries.map((entry, index) => {
          const at = `entries[${index}]`;
          const thresholdId = `${base}-th-${entry.id}`;
          const greyed = greyedByGate(config, entry);
          const thresholdIssue = issueFor(`${at}.threshold_pct`);
          const ctxIssue = issueFor(`${at}.num_ctx`);
          const portIssue = issueFor(`${at}.vars`);
          const skip = skipFor ? skipFor(entry.id) : null;
          return (
            <li
              key={entry.id}
              ref={(node) => {
                if (node) rowRefs.current.set(entry.id, node);
                else rowRefs.current.delete(entry.id);
              }}
              className="fs-router__link-row"
              data-target={entry.id}
              data-enabled={entry.enabled}
              data-greyed={greyed || undefined}
              data-unavailable={skip !== null || undefined}
            >
              <span className="fs-router__pos" aria-hidden="true">
                {index + 1}
              </span>
              <span className="fs-router__link-main">
                <span className="fs-router__link-name">
                  <b>{entry.label}</b>
                  <span className="fs-router__kind">{t(KIND_KEY[entry.kind])}</span>
                </span>
                {greyed ? <span className="fs-router__fine">{t('appRouter.state.gated')}</span> : null}
                {skip !== null ? (
                  <span className="fs-router-skip" role="note">
                    {skip}
                  </span>
                ) : null}
                {details ? (
                  <span className="fs-router__link-fields">
                    {/* An own model reports no usage percentage, so a switch point would never fire there. */}
                    {entry.kind !== 'provider-model' ? (
                      <span className="fs-router__inline">
                        <label htmlFor={thresholdId}>{t('appRouter.chain.threshold')}</label>
                        <input
                          id={thresholdId}
                          className="fs-router__input fs-router__input--num"
                          type="number"
                          inputMode="numeric"
                          min={THRESHOLD_MIN}
                          max={THRESHOLD_MAX}
                          placeholder={String(defaults.threshold_pct)}
                          value={entry.threshold_pct ?? ''}
                          disabled={readOnly}
                          aria-label={t('appRouter.chain.thresholdLabel', { label: entry.label })}
                          aria-invalid={thresholdIssue !== null || undefined}
                          onChange={(event) => patch(entry.id, { threshold_pct: intOrNull(event.target.value) })}
                        />
                        <span className="fs-router__unit">{t('appRouter.chain.thresholdHint', { pct: defaults.threshold_pct })}</span>
                      </span>
                    ) : null}
                    {entry.kind === 'provider-model' ? (
                      <span className="fs-router__inline">
                        <label htmlFor={`${thresholdId}-ctx`}>{t('appRouter.chain.numCtx')}</label>
                        <input
                          id={`${thresholdId}-ctx`}
                          className="fs-router__input fs-router__input--num fs-router__input--wide-num"
                          type="number"
                          inputMode="numeric"
                          min={NUM_CTX_RANGE[0]}
                          max={NUM_CTX_RANGE[1]}
                          step={1024}
                          value={entry.num_ctx ?? ''}
                          disabled={readOnly}
                          aria-invalid={ctxIssue !== null || undefined}
                          onChange={(event) => patch(entry.id, { num_ctx: intOrNull(event.target.value) })}
                        />
                      </span>
                    ) : null}
                    {entry.kind === 'provider-model' && entry.vars && 'port' in entry.vars ? (
                      <span className="fs-router__inline">
                        <label htmlFor={`${thresholdId}-port`}>{t('appRouter.chain.port')}</label>
                        <input
                          id={`${thresholdId}-port`}
                          className="fs-router__input fs-router__input--num"
                          inputMode="numeric"
                          value={entry.vars.port ?? ''}
                          disabled={readOnly}
                          aria-invalid={portIssue !== null || undefined}
                          onChange={(event) => patch(entry.id, { vars: { ...entry.vars, port: event.target.value.trim() } })}
                        />
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {details
                  ? [thresholdIssue, ctxIssue, portIssue].filter(Boolean).map((issue) => (
                      <span key={issue} className="fs-router__error">
                        {issue}
                      </span>
                    ))
                  : null}
              </span>
              <span className="fs-router__link-ctl">
                <Switch
                  size="sm"
                  checked={entry.enabled}
                  disabled={readOnly}
                  labelHidden
                  label={t('appRouter.chain.use', { label: entry.label })}
                  onChange={(on) => patch(entry.id, { enabled: on })}
                />
                <span className="fs-router__move">
                  <IconButton
                    icon="ArrowUp"
                    size="sm"
                    label={t('appRouter.chain.up', { label: entry.label })}
                    disabled={readOnly || index === 0}
                    data-move="-1"
                    onClick={() => move(index, -1, entry.id)}
                  />
                  <IconButton
                    icon="ArrowDown"
                    size="sm"
                    label={t('appRouter.chain.down', { label: entry.label })}
                    disabled={readOnly || index === config.entries.length - 1}
                    data-move="1"
                    onClick={() => move(index, 1, entry.id)}
                  />
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      <MoreInfo className="fs-router__chain-more" open={details} onToggle={setDetails}>
        <p className="fs-router__hint">{t('appRouter.chain.hint')}</p>
        <h5 className="fs-router__sub">{t('appRouter.chain.general')}</h5>
        <div className="fs-router__globals">
          <label className="fs-router__global">
            <span>{t('appRouter.chain.cooldown')}</span>
            <input
              className="fs-router__input fs-router__input--num"
              type="number"
              inputMode="numeric"
              min={COOLDOWN_RANGE[0]}
              max={COOLDOWN_RANGE[1]}
              value={Number.isFinite(defaults.cooldown_min) ? defaults.cooldown_min : ''}
              disabled={readOnly}
              aria-invalid={cooldownIssue !== null || undefined}
              onChange={(event) => patchDefaults({ cooldown_min: Number(event.target.value) })}
            />
            {cooldownIssue ? <span className="fs-router__error">{cooldownIssue}</span> : null}
          </label>
          <label className="fs-router__global">
            <span>{t('appRouter.chain.strategy')}</span>
            <select
              className="fs-set__select"
              value={defaults.strategy}
              disabled={readOnly}
              onChange={(event) => patchDefaults({ strategy: event.target.value === 'spread' ? 'spread' : 'in-order' })}
            >
              <option value="in-order">{t('appRouter.chain.strategyInOrder')}</option>
              <option value="spread">{t('appRouter.chain.strategySpread')}</option>
            </select>
          </label>
          <label className="fs-router__global">
            <span>{t('appRouter.chain.returnLabel')}</span>
            <select
              className="fs-set__select"
              value={defaults.return}
              disabled={readOnly}
              onChange={(event) => patchDefaults({ return: event.target.value === 'asap' ? 'asap' : 'new-conversation' })}
            >
              <option value="new-conversation">{t('appRouter.chain.returnNew')}</option>
              <option value="asap">{t('appRouter.chain.returnAsap')}</option>
            </select>
          </label>
          <label className="fs-router__global">
            <span>{t('appRouter.chain.handover')}</span>
            <input
              className="fs-router__input fs-router__input--num"
              type="number"
              inputMode="numeric"
              min={HANDOVER_RANGE[0]}
              max={HANDOVER_RANGE[1]}
              value={Number.isFinite(defaults.handover_turns) ? defaults.handover_turns : ''}
              disabled={readOnly}
              aria-invalid={handoverIssue !== null || undefined}
              onChange={(event) => patchDefaults({ handover_turns: Number(event.target.value) })}
            />
            {handoverIssue ? <span className="fs-router__error">{handoverIssue}</span> : null}
          </label>
        </div>
        {children}
      </MoreInfo>
    </section>
  );
}
