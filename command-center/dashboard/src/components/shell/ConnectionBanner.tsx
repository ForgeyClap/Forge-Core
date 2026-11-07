/**
 * Forge Workspace — the connection banner.
 *
 * A quiet, honest strip that appears ONLY when the connection to the gateway is
 * not healthy. When everything is whole it renders nothing at all — a connected
 * workspace should not carry a "connected!" chrome.
 *
 * WP B3 (fix from the B8-1 Electron e2e): the strip is one compact row. It says what is wrong in plain Dutch and
 * offers one action, "Opnieuw proberen". The technical detail (the address, the next
 * automatic attempt and — in the browser build only — the developer command that
 * starts the gateway) sits behind "Technische details", and only in Uitgebreid. The
 * desktop app never shows that developer command: the app starts its own gateway.
 *
 * WP B3-ui fix round (placement): the strip docks in a slot reserved at the top of the
 * main column (`#fw-main`), just below the top bar. It is measured against `#fw-main`
 * (position and width), and while it shows, `#fw-main` gets a top padding of exactly the
 * strip's height (`--fw-conn-slot`, see connection-banner.css), so it covers neither a
 * top-bar control (search, menu, account) nor the first line of the page. Without a
 * `#fw-main` (a unit test) it falls back to the old floating position.
 *
 *   CONNECTING    reaching the gateway (first attempt, or reconnecting).
 *   DEGRADED      the socket is up but a stream has a gap being reconciled.
 *   DISCONNECTED  no gateway.
 *
 * Everything is greyscale plus a single hairline accent whose weight — never a
 * hue alone — carries the severity.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';
import { retryGatewayConnection } from '@/prototype/state/adapter/connection';
import { isDesktopApp } from '@/prototype/state/gateway-client';
import { useUiMode } from '@/state/ui-mode';

import './connection-banner.css';

interface BannerCopy {
  readonly icon: string;
  readonly spin: boolean;
  readonly titleKey: MessageKey;
}

function copyFor(status: 'CONNECTING' | 'DEGRADED' | 'DISCONNECTED'): BannerCopy {
  switch (status) {
    case 'CONNECTING':
      return { icon: 'Loader', spin: true, titleKey: 'shell.connection.connecting' };
    case 'DEGRADED':
      return { icon: 'RefreshCw', spin: true, titleKey: 'shell.connection.degraded' };
    case 'DISCONNECTED':
      return { icon: 'Unplug', spin: false, titleKey: 'shell.connection.disconnected' };
  }
}

/** Space between the top bar / the column edges and the docked strip, in px. */
const DOCK_GAP = 8;
/** The custom property `#fw-main` reads for its reserved top slot (connection-banner.css). */
const SLOT_PROPERTY = '--fw-conn-slot';

interface DockBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

function sameBox(a: DockBox | null, b: DockBox): boolean {
  return a !== null && a.top === b.top && a.left === b.left && a.width === b.width;
}

/**
 * Measures `#fw-main` while the strip shows and reserves a slot of the strip's own height at the
 * top of it. Returns null when there is no `#fw-main` (then the strip floats as before).
 */
function useMainColumnDock(active: boolean, banner: RefObject<HTMLDivElement | null>): DockBox | null {
  const [box, setBox] = useState<DockBox | null>(null);
  useLayoutEffect(() => {
    if (!active) return undefined;
    const main = document.getElementById('fw-main');
    if (main === null) return undefined;
    const root = document.documentElement;
    const measure = () => {
      const rect = main.getBoundingClientRect();
      const next: DockBox = {
        top: Math.round(rect.top + DOCK_GAP),
        left: Math.round(rect.left + DOCK_GAP),
        width: Math.max(0, Math.round(rect.width - 2 * DOCK_GAP)),
      };
      setBox((previous) => (sameBox(previous, next) ? previous : next));
      const height = banner.current?.offsetHeight ?? 0;
      if (height > 0) root.style.setProperty(SLOT_PROPERTY, `${height + 2 * DOCK_GAP}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(main);
    if (banner.current !== null) observer?.observe(banner.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      root.style.removeProperty(SLOT_PROPERTY);
      setBox(null);
    };
  }, [active, banner]);
  return box;
}

export function ConnectionBanner() {
  const connection = useConnection();
  const status = connection.status;
  const { t } = useLocale();
  const { isAdvanced } = useUiMode();
  const desktop = isDesktopApp();

  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  const dock = useMainColumnDock(status !== 'CONNECTED', bannerRef);

  const startCommand = connection.startCommand;
  const copyCommand = useCallback(() => {
    if (startCommand === null) return;
    try {
      void navigator.clipboard?.writeText(startCommand);
    } catch {
      // Clipboard access can be denied; the command is still shown to copy by hand.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }, [startCommand]);

  // A live countdown to the next reconnect attempt, written only from the interval callback.
  const attempt = connection.reconnectAttempts;
  const nextRetryInMs = connection.nextRetryInMs;
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    if (status !== 'DISCONNECTED' || nextRetryInMs === null) return undefined;
    const targetAt = Date.now() + nextRetryInMs;
    const id = window.setInterval(() => setRemainingMs(Math.max(0, targetAt - Date.now())), 500);
    return () => window.clearInterval(id);
  }, [status, nextRetryInMs, attempt]);

  const countdownMs = remainingMs ?? nextRetryInMs;
  const retryLabel =
    nextRetryInMs === null
      ? t('shell.connection.retryAuto')
      : countdownMs !== null && countdownMs <= 0
        ? t('shell.connection.reconnecting')
        : t('shell.connection.nextAttempt', { seconds: Math.ceil((countdownMs ?? 0) / 1000) });

  const reconciling = connection.reconciling;
  const reconcilingLine = useMemo(() => {
    if (reconciling.length === 0) return null;
    const first = reconciling[0];
    const more = reconciling.length - 1;
    const tail =
      more > 0 ? t(more === 1 ? 'shell.connection.moreOne' : 'shell.connection.moreMany', { count: more }) : '';
    return t('shell.connection.replaying', { from: first.from, to: first.to, stream: first.streamKey, tail });
  }, [reconciling, t]);

  // The healthy state has no chrome.
  if (status === 'CONNECTED') return null;

  const { icon, spin, titleKey } = copyFor(status);
  const disconnected = status === 'DISCONNECTED';
  const detailText = disconnected
    ? t(desktop ? 'shell.connection.disconnectedDesktop' : 'shell.connection.disconnectedShort')
    : reconcilingLine ?? t('shell.connection.working');

  const dockStyle = dock === null ? undefined : { top: dock.top, left: dock.left, width: dock.width };

  return createPortal(
    <div
      ref={bannerRef}
      className="fw-conn"
      data-status={status}
      data-open={detailsOpen ? 'true' : 'false'}
      data-docked={dock === null ? 'false' : 'true'}
      style={dockStyle}
      role="status"
      aria-live="polite"
    >
      <span className="fw-conn__accent" aria-hidden="true" />
      <div className="fw-conn__row" title={detailText}>
        <Icon name={icon} size="sm" spin={spin} className="fw-conn__icon" />
        <p className="fw-conn__title">{t(titleKey)}</p>
        <p className="fw-conn__detail">{detailText}</p>
        {disconnected ? (
          <button type="button" className="fw-conn__retry" onClick={retryGatewayConnection}>
            <Icon name="RefreshCw" size="xs" />
            {t('shell.connection.retry')}
          </button>
        ) : null}
        {disconnected && isAdvanced ? (
          <button
            type="button"
            className="fw-conn__more"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {t('shell.connection.technical')}
            <Icon name={detailsOpen ? 'ChevronUp' : 'ChevronDown'} size="xs" />
          </button>
        ) : null}
      </div>

      {disconnected && isAdvanced && detailsOpen ? (
        <div className="fw-conn__details">
          {desktop || startCommand === null ? null : (
            <div className="fw-conn__command">
              <Icon name="Cable" size="xs" className="fw-conn__command-icon" />
              <code className="fw-conn__code">{startCommand}</code>
              <button type="button" className="fw-conn__copy" onClick={copyCommand}>
                <Icon name="Copy" size="xs" />
                {copied ? t('shell.connection.copied') : t('shell.connection.copy')}
              </button>
            </div>
          )}
          <p className="fw-conn__meta">
            {desktop ? t('shell.connection.address') : t('shell.connection.runFrom')}{' '}
            <span className="fw-conn__endpoint">{connection.endpoint}</span>
            {' · '}
            {retryLabel}
          </p>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

export default ConnectionBanner;
