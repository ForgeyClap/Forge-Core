/**
 * WP B3 (fix from the B8-1 Electron e2e): the dashboard must talk to the gateway the desktop app
 * actually started (a free loopback port when 4100 is taken), read from `window.forge.gatewayOrigin()`,
 * and fall back to the browser build's 4100 literal only when that bridge is absent or unusable.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GATEWAY_ORIGIN,
  gatewayOrigin,
  gatewayUrl,
  gwGet,
  isDesktopApp,
  isLoopbackOrigin,
} from '@/prototype/state/gateway-client';

type ForgeGlobal = { forge?: unknown };

function setForge(value: unknown): void {
  (globalThis as ForgeGlobal).forge = value;
}

afterEach(() => {
  delete (globalThis as ForgeGlobal).forge;
  vi.restoreAllMocks();
});

describe('gateway origin resolver', () => {
  it('keeps the 4100 literal as the exported fallback constant', () => {
    expect(GATEWAY_ORIGIN).toBe('http://127.0.0.1:4100');
  });

  it('uses the fallback in a plain browser (no window.forge)', () => {
    expect(isDesktopApp()).toBe(false);
    expect(gatewayOrigin()).toBe(GATEWAY_ORIGIN);
    expect(gatewayUrl('/api/health')).toBe('http://127.0.0.1:4100/api/health');
  });

  it('uses the desktop app port from window.forge.gatewayOrigin()', () => {
    setForge({ gatewayOrigin: () => 'http://127.0.0.1:49519', version: '0.1.0', platform: 'win32' });
    expect(isDesktopApp()).toBe(true);
    expect(gatewayOrigin()).toBe('http://127.0.0.1:49519');
    expect(gatewayUrl('/api/projects')).toBe('http://127.0.0.1:49519/api/projects');
  });

  it('accepts localhost with a port', () => {
    setForge({ gatewayOrigin: () => 'http://localhost:5123' });
    expect(gatewayOrigin()).toBe('http://localhost:5123');
  });

  it.each([
    ['empty (preload rejected the argument)', ''],
    ['a remote host', 'http://evil.example:4100'],
    ['https', 'https://127.0.0.1:4100'],
    ['no port', 'http://127.0.0.1'],
    ['a path', 'http://127.0.0.1:4100/api'],
    ['credentials', 'http://user@127.0.0.1:4100'],
    ['port 0', 'http://127.0.0.1:0'],
    ['port above 65535', 'http://127.0.0.1:70000'],
    ['a non-string', 4100],
  ])('falls back to 4100 when the bridge returns %s', (_label, value) => {
    setForge({ gatewayOrigin: () => value });
    expect(gatewayOrigin()).toBe(GATEWAY_ORIGIN);
  });

  it('falls back when the bridge throws or has no gatewayOrigin function', () => {
    setForge({
      gatewayOrigin: () => {
        throw new Error('boom');
      },
    });
    expect(gatewayOrigin()).toBe(GATEWAY_ORIGIN);
    setForge({ gatewayOrigin: 'http://127.0.0.1:49519' });
    expect(isDesktopApp()).toBe(false);
    expect(gatewayOrigin()).toBe(GATEWAY_ORIGIN);
  });

  it('isLoopbackOrigin validates shape and port range', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:1')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:65535')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.2:4100')).toBe(false);
  });

  it('every gateway request goes to the resolved desktop origin, never to 4100', async () => {
    setForge({ gatewayOrigin: () => 'http://127.0.0.1:49519' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await gwGet('/api/health');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://127.0.0.1:49519/api/health');
  });
});
