import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// jsdom has no matchMedia; the theme layer depends on it.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom has no ResizeObserver; the graph and inspector use it.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// (Q5-TESTS): a unit test must never reach the owner's LIVE gateway on port 4100.
// Components that read the shared connection store (folder chip, Start, banner) start a real health poll; unmocked,
// it hit 127.0.0.1:4100 and, being slow under full-suite load, swallowed the next test's first poll (two
// ConnectionBanner tests timed out). Calls to port 4100 now fail fast with a clear error; any other URL goes through
// unchanged, and a test that stubs or spies on fetch replaces this guard as before (restore brings the guard back).
export const LIVE_GATEWAY_BLOCKED = 'unit tests never call the live gateway on port 4100';
{
  const realFetch = globalThis.fetch;
  const liveGateway = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):4100(\/|$)/i;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (liveGateway.test(url)) return Promise.reject(new TypeError(LIVE_GATEWAY_BLOCKED));
    return realFetch(input, init);
  }) as typeof fetch;
}

// WP B0b: the dashboard now defaults to Dutch. The legacy suites assert the English copy; they keep
// doing so under the English locale, while the i18n tests switch to Dutch themselves.
window.localStorage.setItem('forge.locale', 'en');
