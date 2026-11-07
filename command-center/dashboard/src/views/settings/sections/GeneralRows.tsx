/**
 * Algemeen (WP B6, v1.0 redesign DESIGN.md §3.4): thema, taal, weergave, rondleiding opnieuw bekijken,
 * "Start hier" opnieuw tonen (only after it was closed) and — only when the desktop app offers them —
 * opstarten met Windows and in systeemvak blijven.
 * Uitgebreid adds dichtheid and minder beweging. Thema and dichtheid moved here from the old top bar.
 * Every control here changes something you can see at once; nothing is stored without effect.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon, SegmentedControl, Switch } from '@/components/primitives';
import { requestTourReplay, useTourReplayAvailable } from '@/components/shell/shell-events';
import { isLocale } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { Appearance, Density } from '@/prototype/types/prototype-types';
import { useUiMode } from '@/state/ui-mode';
import { START_STORAGE_KEY, readStartStored, useStartChecklist } from '@/views/home/start-checklist';

import { SettingRow } from '../SettingRow';
import type { DesktopBridge, RowId } from '../settings-model';

export function LanguageRow() {
  const { t, locale, setLocale } = useLocale();
  return (
    <SettingRow rowId="taal" title={t('settingsPage.rows.taal.title')} feel={t('settingsPage.rows.taal.feel')}>
      {({ titleId }) => (
        <select
          className="fs-set__select"
          aria-labelledby={titleId}
          value={locale}
          onChange={(event) => {
            if (isLocale(event.target.value)) setLocale(event.target.value);
          }}
        >
          <option value="nl" lang="nl">
            {t('settingsPage.rows.taal.nl')}
          </option>
          <option value="en" lang="en">
            {t('settingsPage.rows.taal.en')}
          </option>
        </select>
      )}
    </SettingRow>
  );
}

export function ThemeRow() {
  const { t } = useLocale();
  const { state, dispatch } = usePrototype();
  return (
    <SettingRow
      rowId="thema"
      title={t('settingsPage.rows.thema.title')}
      feel={t('settingsPage.rows.thema.feel')}
      control={
        <SegmentedControl
          label={t('settingsPage.rows.thema.title')}
          size="sm"
          value={state.appearance}
          onChange={(next) => dispatch({ type: 'appearance/set', appearance: next as Appearance })}
          options={[
            { value: 'light', label: t('settingsPage.rows.thema.light') },
            { value: 'dark', label: t('settingsPage.rows.thema.dark') },
            { value: 'system', label: t('settingsPage.rows.thema.system') },
          ]}
        />
      }
    />
  );
}

export function ViewModeRow() {
  const { t } = useLocale();
  const { mode, setUiMode } = useUiMode();
  return (
    <SettingRow
      rowId="weergave"
      title={t('settingsPage.rows.weergave.title')}
      feel={t('settingsPage.rows.weergave.feel')}
      control={
        <SegmentedControl
          label={t('settingsPage.rows.weergave.title')}
          size="sm"
          value={mode}
          onChange={(next) => setUiMode(next === 'uitgebreid' ? 'uitgebreid' : 'eenvoudig')}
          options={[
            { value: 'eenvoudig', label: t('settingsPage.rows.weergave.simple') },
            { value: 'uitgebreid', label: t('settingsPage.rows.weergave.advanced') },
          ]}
        />
      }
    />
  );
}

/**
 * "Rondleiding opnieuw bekijken": an action row that restarts the 3-stop tour. It only shows while a
 * tour is mounted and listening (part 2D), so it never sits on the page doing nothing.
 */
export function TourRow() {
  const { t } = useLocale();
  const available = useTourReplayAvailable();
  if (!available) return null;
  return (
    <button type="button" className="fs-set__action" data-row="rondleiding" onClick={requestTourReplay}>
      <Icon name="Play" size="sm" className="fs-set__action-icon" />
      <span>{t('rd.settings.general.tour')}</span>
    </button>
  );
}

/**
 * "Start hier opnieuw tonen" (DESIGN.md §3.1 says a closed card can come back): shows only
 * while the card is closed, so it never sits on the page doing nothing. It clears only the `closed` fact of
 * `forge.start` (the proof step stays as it was) and goes to Start, where the card is read afresh.
 */
export function StartCardRow() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const { closed } = useStartChecklist();
  if (!closed) return null;

  function reopen() {
    try {
      globalThis.localStorage?.setItem(START_STORAGE_KEY, JSON.stringify({ ...readStartStored(), closed: false }));
    } catch {
      // Storage blocked: the card was never stored as closed either, so Start shows it anyway.
    }
    navigate('/');
  }

  return (
    <button type="button" className="fs-set__action" data-row="startkaart" onClick={reopen}>
      <Icon name="RotateCcw" size="sm" className="fs-set__action-icon" />
      <span>{t('rd.settings.general.startAgain')}</span>
    </button>
  );
}

/** A switch backed by the desktop app (autostart, tray). Shows nothing until the app answers. */
export function DesktopToggleRow({ id, bridge }: { readonly id: Extract<RowId, 'opstarten' | 'systeemvak'>; readonly bridge: DesktopBridge }) {
  const { t } = useLocale();
  const toggle = id === 'opstarten' ? bridge.autostart : bridge.tray;
  const [checked, setChecked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void toggle
      ?.get()
      .then((value) => {
        if (!cancelled) setChecked(Boolean(value));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [toggle]);

  if (!toggle || checked === null) return null;
  const title = t(`settingsPage.rows.${id}.title`);
  return (
    <SettingRow
      rowId={id}
      title={title}
      feel={t(`settingsPage.rows.${id}.feel`)}
      control={
        <Switch
          label={title}
          labelHidden
          checked={checked}
          disabled={busy}
          onChange={(next) => {
            setBusy(true);
            // Show what the app reports after the change, never the wish.
            void toggle
              .set(next)
              .then((applied) => setChecked(Boolean(applied)))
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        />
      }
    />
  );
}

export function DensityRow() {
  const { t } = useLocale();
  const { state, dispatch } = usePrototype();
  return (
    <SettingRow
      rowId="dichtheid"
      title={t('settingsPage.rows.dichtheid.title')}
      feel={t('settingsPage.rows.dichtheid.feel')}
      control={
        <SegmentedControl
          label={t('settingsPage.rows.dichtheid.title')}
          size="sm"
          value={state.density}
          onChange={(next) => dispatch({ type: 'density/set', density: next as Density })}
          options={[
            { value: 'comfortable', label: t('settingsPage.rows.dichtheid.comfortable') },
            { value: 'compact', label: t('settingsPage.rows.dichtheid.compact') },
          ]}
        />
      }
    />
  );
}

export function MotionRow() {
  const { t } = useLocale();
  const { state, dispatch } = usePrototype();
  const title = t('settingsPage.rows.beweging.title');
  return (
    <SettingRow
      rowId="beweging"
      title={title}
      feel={t('settingsPage.rows.beweging.feel')}
      control={
        <Switch
          label={title}
          labelHidden
          checked={state.reducedMotion}
          onChange={(next) => dispatch({ type: 'motion/set', reduced: next })}
        />
      }
    />
  );
}
