/**
 * UsageMeter — the chat's Dutch limit meter (WP B3, plan §4.4: "Usage-meter uit statusline
 * rate_limits.five_hour/seven_day").
 *
 * Reads the real `GET /api/usage` answer through `useGatewayAccountUsage()`: the 5-hour and the week
 * percentage the usage watcher measured. When the gateway has no measurement (no file, no guard, an
 * older gateway), the meter says so plainly — it never shows a made-up number. When the reading is
 * no longer current (watcher not running or stale, or the 5-hour window already reset), the 5-hour
 * bar and the reset note go and the meter says "Verouderd" (see `usage-reading.ts`).
 */

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayAccountUsage } from '@/prototype/state/gateway-adapter';

import { NEAR_LIMIT_PERCENT, isReadingOutdated, nearLimitValues, readUsageMeter } from './usage-reading';
import type { UsageMeterReading } from './usage-reading';

function Bar({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <span className="fw-usage-meter__bar" data-level={value >= 80 ? 'high' : undefined}>
      <span>{label}</span>
      <span
        className="fw-usage-meter__track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <span className="fw-usage-meter__fill" style={{ transform: `scaleX(${value / 100})` }} />
      </span>
      <span className="fw-usage-meter__value">{value}%</span>
    </span>
  );
}

export function UsageMeterView({ reading, id }: { readonly reading: UsageMeterReading; readonly id?: string }) {
  const { t } = useLocale();
  const measured = reading.state !== 'unmeasured' && (reading.session !== null || reading.week !== null);
  const reset = reading.sessionResetAt !== null ? Date.parse(reading.sessionResetAt) : Number.NaN;
  return (
    <div id={id} className="fw-usage-meter" data-testid="usage-meter" data-state={reading.state}>
      <span className="fw-usage-meter__label">
        <Icon name="Gauge" size="xs" />
        {t('chat.usage.label')}
      </span>
      {measured ? (
        <>
          {reading.session !== null ? <Bar label={t('chat.usage.fiveHours')} value={reading.session} /> : null}
          {reading.week !== null ? <Bar label={t('chat.usage.week')} value={reading.week} /> : null}
          {isReadingOutdated(reading) ? <span className="fw-usage-meter__note">{t('chat.usage.stale')}</span> : null}
          {reading.state === 'stale' && reading.staleReason === 'reset-passed' ? (
            <span className="fw-usage-meter__note">{t('chat.usage.sessionRestarted')}</span>
          ) : null}
          {reading.state === 'measured' && Number.isFinite(reset) ? (
            <span className="fw-usage-meter__note">
              {t('chat.usage.resetsAt', {
                time: new Date(reset).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }),
              })}
            </span>
          ) : null}
        </>
      ) : (
        <span className="fw-usage-meter__note">{t('chat.usage.unavailable')}</span>
      )}
    </div>
  );
}

export function UsageMeter({ id }: { readonly id?: string } = {}) {
  const usage = useGatewayAccountUsage();
  return <UsageMeterView id={id} reading={readUsageMeter(usage)} />;
}

/** At or above this percentage (5 hours or week) the collapsed toggle says the limit is almost used up. */
export { NEAR_LIMIT_PERCENT };

export interface UsageSummaryToggleProps {
  readonly reading: UsageMeterReading;
  readonly expanded: boolean;
  /** The id of the full meter strip this toggle shows and hides. */
  readonly controls: string;
  readonly onToggle: () => void;
}

/**
 * FU-CHAT (owner "kies de beste", Lead option A): in Eenvoudig the limit meter starts collapsed to this one
 * compact toggle in the chat header, so the transcript gets the room. The numbers stay readable as text
 * ("5 uur 42% · week 92%"); a value of 80 % or more is set semibold.
 *
 * FU (review medium): the token set is monochrome, so the failed status colour was the same black or
 * white as normal text: colour alone never warned. From NEAR_LIMIT_PERCENT (5 hours or week, current
 * readings only) the toggle shows a warning icon, the visible words "bijna op" and a heavier border, and a
 * polite live region says it once to screen readers. A reading from a watcher that is down never raises it;
 * after a passed 5-hour reset the (still current) week value does (`nearLimitValues`, FU fix round).
 */
export function UsageSummaryToggle({ reading, expanded, controls, onToggle }: UsageSummaryToggleProps) {
  const { t } = useLocale();
  const measured = reading.state !== 'unmeasured' && (reading.session !== null || reading.week !== null);
  const fiveHours = t('chat.usage.fiveHours');
  const week = t('chat.usage.weekShort');
  const near = nearLimitValues(reading);
  const nearParts: string[] = [];
  if (near.session !== null) nearParts.push(`${fiveHours} ${near.session}%`);
  if (near.week !== null) nearParts.push(`${week} ${near.week}%`);
  const nearLimit = nearParts.length > 0;
  const announcement = nearLimit ? t('chat.usage.nearLimitAnnounce', { value: nearParts.join(', ') }) : '';
  const value = (label: string, pct: number) => (
    <span className="fw-usage-toggle__pair" data-level={pct >= 80 ? 'high' : undefined}>
      {label} <span className="fw-usage-toggle__value">{pct}%</span>
    </span>
  );
  return (
    <>
      <button
        type="button"
        className="fw-usage-toggle"
        data-state={reading.state}
        data-alert={nearLimit ? 'near-limit' : undefined}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onToggle}
      >
        <Icon
          name={nearLimit ? 'TriangleAlert' : 'Gauge'}
          size="xs"
          className={nearLimit ? 'fw-usage-toggle__alert-icon' : undefined}
        />
        <span className="fw-usage-toggle__label">{t('chat.usage.label')}</span>
        {nearLimit ? <span className="fw-usage-toggle__alert">{t('chat.usage.nearLimitShort')}</span> : null}
        {measured ? (
          <>
            {reading.session !== null ? value(fiveHours, reading.session) : null}
            {reading.week !== null ? value(week, reading.week) : null}
            {isReadingOutdated(reading) ? <span className="fw-usage-toggle__note">{t('chat.usage.staleShort')}</span> : null}
          </>
        ) : (
          <span className="fw-usage-toggle__note">{t('chat.usage.unknownShort')}</span>
        )}
        <Icon name="ChevronDown" size="xs" className="fw-usage-toggle__chevron" />
        <span className="fw-visually-hidden">{expanded ? t('chat.usage.hideDetails') : t('chat.usage.showDetails')}</span>
      </button>
      <span className="fw-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

/** Container: the real `GET /api/usage` reading behind the compact toggle. */
export function UsageSummary(props: Omit<UsageSummaryToggleProps, 'reading'>) {
  const usage = useGatewayAccountUsage();
  return <UsageSummaryToggle reading={readUsageMeter(usage)} {...props} />;
}

export default UsageMeter;
