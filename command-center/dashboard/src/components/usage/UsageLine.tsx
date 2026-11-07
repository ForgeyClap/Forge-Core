/**
 * UsageLine — the quiet usage line above the composer (DESIGN.md §2, "Usage pill in the corner" row).
 * It replaces the always-on corner pill: nothing shows until a current reading is at 80 % or more.
 *
 * Slot API for part 2A: mount `<UsageLine routerMode={…} />` directly above the composer. `routerMode`
 * is the Forge router's mode when the chat knows it; without it the line only says the limit is near
 * and never claims a switch. Honesty rules (owner, any-model): an own model only answers, so the line
 * says so whenever it names one; a stale or unmeasured reading never raises the line (the same reading
 * the chat meter uses, `readUsageMeter`).
 */

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import type { RouterMode } from '@/prototype/state/adapter/app-router';
import { useGatewayAccountUsage } from '@/prototype/state/gateway-adapter';
import type { GatewayAccountUsage } from '@/prototype/state/gateway-adapter';

import { usageLinePercent } from './usage-line-reading';

import './usage-line.css';

export interface UsageLineViewProps {
  readonly usage: GatewayAccountUsage;
  readonly routerMode?: RouterMode | null;
  /** The clock the reading is judged against (tests pass a fixed one). */
  readonly now?: number;
}

export function UsageLineView({ usage, routerMode = null, now }: UsageLineViewProps) {
  const { t } = useLocale();
  const percent = usageLinePercent(usage, now);
  if (percent === null) return null;

  const next =
    routerMode === 'claude-accounts'
      ? t('rd.chat.usageLine.toAccount')
      : routerMode === 'claude-then-model'
        ? t('rd.chat.usageLine.toModel')
        : null;

  return (
    <p className="fw-usage-line" role="status" aria-label={t('rd.chat.usageLine.region')}>
      <Icon name="Gauge" size="sm" className="fw-usage-line__icon" />
      <span>
        {t('rd.chat.usageLine.near', { percent })}
        {next ? ` ${next}` : null}
      </span>
    </p>
  );
}

/** Container: the real `GET /api/usage` reading. */
export function UsageLine({ routerMode = null }: { readonly routerMode?: RouterMode | null }) {
  const usage = useGatewayAccountUsage();
  return <UsageLineView usage={usage} routerMode={routerMode} />;
}

export default UsageLine;
