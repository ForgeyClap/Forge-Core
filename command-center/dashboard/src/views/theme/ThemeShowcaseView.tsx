/**
 * Theme showcase: the v1.0 design reference (docs/forge-systeem/redesign/BRAND.md, DESIGN.md §1).
 *
 * A hidden, internal route (/theme). Every specimen is drawn with the v1.0 token itself and named by
 * the token, and the value beside it is read from the live stylesheet at runtime, so this page cannot
 * drift from brand/forge-tokens.css and holds no raw colour of its own.
 *
 * Calm on purpose: plain sections under a hairline, one accent (Pauw), sentence-case labels, and mono
 * only for machine text (token names, values, a path).
 */

import { useMemo, useSyncExternalStore } from 'react';

import {
  Button,
  IconButton,
  KeyHint,
  Mark,
  SegmentedControl,
  StatusBadge,
  Switch,
} from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { STATUS_KEYS } from '@/prototype/types/prototype-types';
import type { Appearance, Density } from '@/prototype/types/prototype-types';

import './theme-showcase.css';
import { useLocale } from '@/i18n/use-locale';
import type { MessageKey } from '@/i18n';

/* ------------------------------------------------------------- specimens */

interface Swatch {
  readonly token: string;
  /** The brand colour name (Dutch already), or a copy key when the name carries a word. */
  readonly name: string | { readonly key: MessageKey };
  readonly use: MessageKey;
}

interface ColourGroup {
  readonly title: MessageKey;
  readonly swatches: readonly Swatch[];
}

const COLOURS: readonly ColourGroup[] = [
  {
    title: 'rd.theme.group.surfaces',
    swatches: [
      { token: '--fs-bg', name: 'Mist', use: 'rd.theme.use.bg' },
      { token: '--fs-bg-side', name: 'Leisteen', use: 'rd.theme.use.bgSide' },
      { token: '--fs-surface', name: 'Blank', use: 'rd.theme.use.surface' },
      { token: '--fs-surface-2', name: 'Blank-2', use: 'rd.theme.use.surface2' },
      { token: '--fs-sunken', name: 'Inleg', use: 'rd.theme.use.sunken' },
      { token: '--fs-line', name: 'Naad', use: 'rd.theme.use.line' },
      { token: '--fs-line-strong', name: 'Rand', use: 'rd.theme.use.lineStrong' },
    ],
  },
  {
    title: 'rd.theme.group.ink',
    swatches: [
      { token: '--fs-ink', name: 'Smeedzwart', use: 'rd.theme.use.ink' },
      { token: '--fs-ink-2', name: 'Asgrijs', use: 'rd.theme.use.ink2' },
      { token: '--fs-ink-3', name: 'Slak', use: 'rd.theme.use.ink3' },
    ],
  },
  {
    title: 'rd.theme.group.accent',
    swatches: [
      { token: '--fs-accent', name: 'Pauw', use: 'rd.theme.use.accent' },
      { token: '--fs-accent-hover', name: { key: 'rd.theme.name.accentHover' }, use: 'rd.theme.use.accentHover' },
      { token: '--fs-accent-text', name: 'Pauw-tekst', use: 'rd.theme.use.accentText' },
      { token: '--fs-accent-soft', name: 'Pauwnevel', use: 'rd.theme.use.accentSoft' },
    ],
  },
  {
    title: 'rd.theme.group.status',
    swatches: [
      { token: '--fs-ok', name: 'Gehard', use: 'rd.theme.use.ok' },
      { token: '--fs-warn', name: 'Wacht', use: 'rd.theme.use.warn' },
      { token: '--fs-danger', name: 'Gloei', use: 'rd.theme.use.danger' },
      { token: '--fs-info', name: 'Staalblauw', use: 'rd.theme.use.info' },
    ],
  },
];

const TYPE_ROLES: readonly { readonly role: string; readonly token: string; readonly sample: string }[] = [
  { role: 'display', token: '--fs-text-30', sample: 'Wat wil je vandaag maken?' },
  { role: 'title', token: '--fs-text-22', sample: 'Mijn projecten' },
  { role: 'body', token: '--fs-text-15', sample: 'Forge vraagt eerst wat je bedoelt en laat dan zien wat het doet.' },
  { role: 'label', token: '--fs-text-13', sample: 'Laatst actief' },
  { role: 'caption', token: '--fs-text-12', sample: '2 minuten geleden' },
];

const SPACES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as const;
const RADII = ['xs', 'sm', 'md', 'lg', 'pill', 'struck'] as const;
const SHADOWS: readonly { readonly token: string; readonly use: MessageKey }[] = [
  { token: '--fs-shadow-1', use: 'rd.theme.shadow.raised' },
  { token: '--fs-shadow-2', use: 'rd.theme.shadow.floating' },
  { token: '--fs-shadow-3', use: 'rd.theme.shadow.dialogs' },
];
const MOTION = ['--fs-dur-1', '--fs-dur-2', '--fs-dur-3', '--fs-ease'] as const;

/** The theme attributes on <html> (set by the shell after a switch), watched as an external store. */
function subscribeRootTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-density'] });
  return () => observer.disconnect();
}

function rootThemeKey(): string {
  const root = document.documentElement;
  return `${root.getAttribute('data-theme') ?? ''}|${root.getAttribute('data-density') ?? ''}`;
}

/** Reads the live value of each token from the root stylesheet; re-reads when the theme on <html> flips. */
function useTokenValues(tokens: readonly string[]): Readonly<Record<string, string>> {
  const themeKey = useSyncExternalStore(subscribeRootTheme, rootThemeKey, rootThemeKey);
  return useMemo(() => {
    // themeKey is the trigger: the computed values below change when it does.
    void themeKey;
    const style = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    for (const token of tokens) next[token] = style.getPropertyValue(token).trim();
    return next;
  }, [tokens, themeKey]);
}

const ALL_TOKENS: readonly string[] = [
  ...COLOURS.flatMap((group) => group.swatches.map((swatch) => swatch.token)),
  ...MOTION,
];

function Value({ value, notSet }: { readonly value: string | undefined; readonly notSet: string }) {
  return <code className="fs-theme__value">{value && value !== '' ? value : notSet}</code>;
}

/* ------------------------------------------------------------------ view */

export default function ThemeShowcaseView() {
  const { state, dispatch } = usePrototype();
  const values = useTokenValues(ALL_TOKENS);
  const { t } = useLocale();
  const notSet = t('rd.theme.notSet');

  return (
    <div className="fs-theme">
      <header className="fs-theme__head">
        <div className="fs-theme__heading">
          <h1 className="fs-theme__title">{t('rd.theme.title')}</h1>
          <p className="fs-theme__lede">{t('rd.theme.lede')}</p>
        </div>
        <div className="fs-theme__controls">
          <SegmentedControl
            label={t('rd.theme.themeLabel')}
            size="sm"
            value={state.appearance}
            onChange={(next) => dispatch({ type: 'appearance/set', appearance: next as Appearance })}
            options={[
              { value: 'light', label: t('rd.theme.light'), icon: 'Sun' },
              { value: 'dark', label: t('rd.theme.dark'), icon: 'Moon' },
              { value: 'system', label: t('rd.theme.system'), icon: 'Monitor' },
            ]}
          />
          <SegmentedControl
            label={t('rd.theme.densityLabel')}
            size="sm"
            value={state.density}
            onChange={(next) => dispatch({ type: 'density/set', density: next as Density })}
            options={[
              { value: 'comfortable', label: t('rd.theme.comfortable') },
              { value: 'compact', label: t('rd.theme.compact') },
            ]}
          />
        </div>
      </header>

      {/* ----------------------------------------------------------- mark */}
      <section className="fs-theme__section" aria-labelledby="fs-theme-mark">
        <h2 id="fs-theme-mark" className="fs-theme__h2">
          {t('rd.theme.mark')}
        </h2>
        <div className="fs-theme__marks">
          <span className="fs-theme__lockup">
            <Mark size={40} title="Forge Systeem" />
            <span className="fs-theme__wordmark">
              <b>Forge</b> <span>Systeem</span>
            </span>
          </span>
          <span className="fs-theme__mark-sizes">
            <Mark size={32} />
            <Mark size={24} />
            <Mark size={16} />
          </span>
          <p className="fs-theme__note">{t('rd.theme.markNote')}</p>
        </div>
      </section>

      {/* --------------------------------------------------------- colour */}
      <section className="fs-theme__section" aria-labelledby="fs-theme-colour">
        <h2 id="fs-theme-colour" className="fs-theme__h2">
          {t('rd.theme.colour')}
        </h2>
        <p className="fs-theme__note">
          {t('rd.theme.colourNote')} {t('rd.theme.statusNote')}
        </p>
        <div className="fs-theme__groups">
          {COLOURS.map((group) => (
            <div key={group.title} className="fs-theme__group">
              <h3 className="fs-theme__h3">{t(group.title)}</h3>
              <ul className="fs-theme__swatches">
                {group.swatches.map((swatch) => (
                  <li key={swatch.token} className="fs-theme__swatch">
                    <span className="fs-theme__chip" style={{ background: `var(${swatch.token})` }} />
                    <span className="fs-theme__swatch-text">
                      <span className="fs-theme__swatch-name">
                        {typeof swatch.name === 'string' ? swatch.name : t(swatch.name.key)}
                      </span>
                      <span className="fs-theme__swatch-use">{t(swatch.use)}</span>
                    </span>
                    <span className="fs-theme__swatch-code">
                      <code className="fs-theme__token">{swatch.token}</code>
                      <Value value={values[swatch.token]} notSet={notSet} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- type */}
      <section className="fs-theme__section" aria-labelledby="fs-theme-type">
        <h2 id="fs-theme-type" className="fs-theme__h2">
          {t('rd.theme.type')}
        </h2>
        <p className="fs-theme__note">{t('rd.theme.typeNote')}</p>
        <ul className="fs-theme__type">
          {TYPE_ROLES.map((row) => (
            <li key={row.role} className="fs-theme__type-row" data-role={row.role}>
              <span className="fs-theme__type-sample">{row.sample}</span>
              <code className="fs-theme__token">{row.token}</code>
            </li>
          ))}
          <li className="fs-theme__type-row" data-role="mono">
            <code className="fs-theme__type-sample">C:\Projecten\bakkerij-website\index.html</code>
            <code className="fs-theme__token">--fs-font-mono</code>
          </li>
        </ul>
      </section>

      {/* -------------------------------------------- space, radius, depth */}
      <section className="fs-theme__section" aria-labelledby="fs-theme-shape">
        <h2 id="fs-theme-shape" className="fs-theme__h2">
          {t('rd.theme.shape')}
        </h2>
        <div className="fs-theme__shape">
          <div>
            <h3 className="fs-theme__h3">{t('rd.theme.space')}</h3>
            <ul className="fs-theme__spaces">
              {SPACES.map((step) => (
                <li key={step} className="fs-theme__space">
                  <span className="fs-theme__space-bar" style={{ inlineSize: `var(--fs-space-${step})` }} />
                  <code className="fs-theme__token">{`--fs-space-${step}`}</code>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="fs-theme__h3">{t('rd.theme.radius')}</h3>
            <ul className="fs-theme__radii">
              {RADII.map((radius) => (
                <li key={radius} className="fs-theme__radius">
                  <span className="fs-theme__radius-box" style={{ borderRadius: `var(--fs-radius-${radius})` }} />
                  <code className="fs-theme__token">{`--fs-radius-${radius}`}</code>
                </li>
              ))}
            </ul>
            <p className="fs-theme__note">{t('rd.theme.struckNote')}</p>
          </div>
          <div>
            <h3 className="fs-theme__h3">{t('rd.theme.depth')}</h3>
            <ul className="fs-theme__shadows">
              {SHADOWS.map((shadow) => (
                <li key={shadow.token} className="fs-theme__shadow">
                  <span className="fs-theme__shadow-box" style={{ boxShadow: `var(${shadow.token})` }} />
                  <span className="fs-theme__swatch-use">{t(shadow.use)}</span>
                  <code className="fs-theme__token">{shadow.token}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- controls */}
      <section className="fs-theme__section" aria-labelledby="fs-theme-controls">
        <h2 id="fs-theme-controls" className="fs-theme__h2">
          {t('rd.theme.controls')}
        </h2>
        <div className="fs-theme__row">
          <Button variant="primary" icon="ArrowUp">
            Versturen
          </Button>
          <Button variant="secondary">Annuleren</Button>
          <Button variant="quiet" icon="ChevronDown">
            Meer info
          </Button>
          <Button variant="danger" icon="Trash2">
            Verwijderen
          </Button>
          <IconButton icon="Settings" label="Instellingen" />
          <Switch checked onChange={() => undefined} label="Aan" />
          <Switch checked={false} onChange={() => undefined} label="Uit" />
        </div>
        <ul className="fs-theme__statuses">
          {STATUS_KEYS.map((status) => (
            <li key={status}>
              <StatusBadge status={status} />
            </li>
          ))}
        </ul>
        <p className="fs-theme__note">
          {t('rd.theme.tabBefore')} <KeyHint keys={['Tab']} /> {t('rd.theme.tabAfter')}
        </p>
      </section>

      {/* --------------------------------------------------------- motion */}
      <section className="fs-theme__section" aria-labelledby="fs-theme-motion">
        <h2 id="fs-theme-motion" className="fs-theme__h2">
          {t('rd.theme.motion')}
        </h2>
        <p className="fs-theme__note">{t('rd.theme.motionNote')}</p>
        <ul className="fs-theme__motion">
          {MOTION.map((token) => (
            <li key={token} className="fs-theme__motion-row">
              <code className="fs-theme__token">{token}</code>
              <Value value={values[token]} notSet={notSet} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
