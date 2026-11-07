/**
 * RouteFallback — what a lazy screen shows while its code chunk loads (WP B3-copy).
 *
 * Replaces the old English "Loading view…" line. Three honest states, in Dutch via t():
 *   - loading   "Scherm wordt geladen…" with a quiet spinner (role=status);
 *   - offline   the gateway link is DISCONNECTED (production only): said at once, never after a
 *               wait, because a screen that cannot reach Forge will not finish loading;
 *   - stuck     still loading after ROUTE_FALLBACK_TIMEOUT_MS (8 s): a plain end state instead of an
 *               endless spinner.
 * Both end states offer the same retry the connection banner uses (`retryGatewayConnection`) plus a
 * page reload, which re-requests a chunk that never arrived.
 */

import { useEffect, useState } from 'react';

import { Button, Icon } from '@/components/primitives';
import { isProductionMode } from '@/config/mode';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayConnection } from '@/prototype/state/gateway-adapter';
import { retryGatewayConnection } from '@/prototype/state/adapter/connection';

import './route-fallback.css';

/** How long a screen may load before the fallback says it is not coming. */
export const ROUTE_FALLBACK_TIMEOUT_MS = 8000;

export type RouteFallbackState = 'loading' | 'offline' | 'stuck';

export function RouteFallback({ timeoutMs = ROUTE_FALLBACK_TIMEOUT_MS }: { timeoutMs?: number }) {
  const { t } = useLocale();
  const connection = useGatewayConnection();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setTimedOut(true), timeoutMs);
    return () => window.clearTimeout(id);
  }, [timeoutMs]);

  const offline = isProductionMode() && connection.status === 'DISCONNECTED';
  const state: RouteFallbackState = offline ? 'offline' : timedOut ? 'stuck' : 'loading';

  if (state === 'loading') {
    return (
      <div className="fw-route-fallback" data-state="loading" role="status" aria-live="polite">
        <Icon name="Loader" size="sm" spin className="fw-route-fallback__spinner" />
        <span className="fw-route-fallback__text">{t('routeFallback.loading')}</span>
      </div>
    );
  }

  return (
    <div className="fw-route-fallback fw-route-fallback--end" data-state={state} role="alert">
      <span className="fw-route-fallback__glyph" aria-hidden="true">
        <Icon name={offline ? 'Unplug' : 'TriangleAlert'} size="md" />
      </span>
      <p className="fw-route-fallback__title">{offline ? t('routeFallback.offlineTitle') : t('routeFallback.stuckTitle')}</p>
      <p className="fw-route-fallback__detail">{offline ? t('routeFallback.offlineDetail') : t('routeFallback.stuckDetail')}</p>
      <div className="fw-route-fallback__actions">
        <Button variant="primary" size="sm" icon="RefreshCw" onClick={retryGatewayConnection}>
          {t('routeFallback.retry')}
        </Button>
        <Button size="sm" icon="RotateCcw" onClick={() => window.location.reload()}>
          {t('routeFallback.reload')}
        </Button>
      </div>
    </div>
  );
}

export default RouteFallback;
