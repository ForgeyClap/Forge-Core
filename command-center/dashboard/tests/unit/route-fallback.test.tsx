/**
 * WP B3-copy — the lazy-screen fallback (RouteFallback): Dutch loading line, an honest end state
 * after 8 s (fake timers), and the offline end state at once when the gateway is DISCONNECTED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const connection = { status: 'CONNECTED' as string };
const retry = vi.fn();

vi.mock('@/prototype/state/gateway-adapter', () => ({
  useGatewayConnection: () => ({ status: connection.status, endpoint: 'http://127.0.0.1:4100', startCommand: null }),
}));
vi.mock('@/prototype/state/adapter/connection', () => ({ retryGatewayConnection: () => retry() }));
vi.mock('@/config/mode', () => ({ isProductionMode: () => true }));

import { setLocale } from '@/i18n';
import { ROUTE_FALLBACK_TIMEOUT_MS, RouteFallback } from '@/components/shell/RouteFallback';

describe('RouteFallback (WP B3-copy)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLocale('nl');
    connection.status = 'CONNECTED';
    retry.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setLocale('en');
  });

  it('shows the Dutch loading line first, never the old English one', () => {
    render(createElement(RouteFallback));
    expect(screen.getByRole('status')).toHaveTextContent('Scherm wordt geladen…');
    expect(document.body.textContent).not.toContain('Loading view');
  });

  it('turns into an honest end state after 8 s instead of spinning forever', () => {
    render(createElement(RouteFallback));
    act(() => {
      vi.advanceTimersByTime(ROUTE_FALLBACK_TIMEOUT_MS - 1);
    });
    expect(screen.queryByText('Dit scherm laadt niet.')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('alert')).toHaveAttribute('data-state', 'stuck');
    expect(screen.getByText('Dit scherm laadt niet.')).toBeInTheDocument();
    expect(screen.getByText(/Controleer de verbinding met Forge/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Opnieuw verbinden' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Pagina opnieuw laden' })).toBeInTheDocument();
  });

  it('says at once that Forge is unreachable when the gateway is DISCONNECTED', () => {
    connection.status = 'DISCONNECTED';
    render(createElement(RouteFallback));
    expect(screen.getByRole('alert')).toHaveAttribute('data-state', 'offline');
    expect(screen.getByText('Geen verbinding met Forge')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Opnieuw verbinden' })).toBeInTheDocument();
  });

  it('clears its timer on unmount (no state update after the screen arrived)', () => {
    const before = vi.getTimerCount();
    const { unmount } = render(createElement(RouteFallback));
    expect(vi.getTimerCount()).toBe(before + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(before);
  });
});
