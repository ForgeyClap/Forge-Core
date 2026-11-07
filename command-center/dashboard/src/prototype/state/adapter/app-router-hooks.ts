/**
 * app-router-hooks — the React side of the app router slice (split out of `app-router.ts`, Q6-UI): the router
 * config + polled status (`useAppRouter`) and the provider model lists (`useProviderModels`). Import from
 * `./app-router`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { gwGet, pickArray, pickBool, pickRecord, pickString } from '@/prototype/state/gateway-client';

import { readRouterStatus } from './app-router-calls';
import { parseRouterGet } from './app-router-parse';
import type { RouterConfig, RouterGet, RouterStatus } from './app-router-parse';
import { keepWarnings } from './app-router-warnings';
import type { RouterWarning } from './app-router-warnings';
import { useRouterRefreshSignal } from './router-refresh';

/* ---------------------------------------------------------- provider models */

export interface ProviderModels {
  readonly id: string;
  readonly label: string;
  readonly statusCode: string | null;
  readonly models: readonly string[];
  /** 'endpoint' | 'static' | 'matrix' | 'test-cache' | 'not-fetched' (the list is unknown, not empty). */
  readonly source: string | null;
}

/** The `providers.list` block of `GET /api/models` (connected providers and their model ids). */
export function parseProviderModels(data: Record<string, unknown>): { readonly pending: boolean; readonly list: readonly ProviderModels[] } {
  const block = pickRecord(data, ['providers']);
  if (block === null) return { pending: false, list: [] };
  return {
    pending: pickBool(block, ['pending']) ?? false,
    list: pickArray(block, ['list']).flatMap((row) => {
      const id = pickString(row, ['id']);
      if (id === null) return [];
      const models = pickArray(row, ['models'])
        .map((model) => pickString(model, ['id']))
        .filter((model): model is string => model !== null);
      return [{ id, label: pickString(row, ['label']) ?? id, statusCode: pickString(row, ['status_code']), models, source: pickString(row, ['models_source']) }];
    }),
  };
}

/* ------------------------------------------------------------------- hooks */

export type RouterLoad = 'loading' | 'ready' | 'error';

export interface AppRouterState {
  readonly load: RouterLoad;
  readonly data: RouterGet | null;
  readonly error: string | null;
  readonly status: RouterStatus | null;
  readonly reload: () => void;
  readonly refreshStatus: () => void;
  /**
   * Replace the shown config after a save, a 409 or a new profile (the server's copy wins). `warnings`: the
   * save answer's own (C3) replace the shown ones; `null` (a save answer from an older gateway without them)
   * reads the router again; left out (a 409, a new profile) keeps the shown ones that still fit, as before.
   */
  readonly adopt: (config: RouterConfig, warnings?: readonly RouterWarning[] | null) => void;
}

export const ROUTER_STATUS_POLL_MS = 15_000;

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * A re-read that finds the same stored config keeps the shown config OBJECT, so an unsaved draft in the router
 * section (keyed on that object) survives a refresh that only brought new warnings.
 */
function sameStored(a: RouterConfig, b: RouterConfig): boolean {
  return a.revision === b.revision && a.updated_at === b.updated_at && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The router config (read once per reload, and again whenever an own API changed: `router-refresh.ts`) and its
 * status (polled every 15 s while the page is visible).
 */
export function useAppRouter(): AppRouterState {
  const [state, setState] = useState<{ load: RouterLoad; data: RouterGet | null; error: string | null }>({ load: 'loading', data: null, error: null });
  const [status, setStatus] = useState<RouterStatus | null>(null);
  const [nonce, setNonce] = useState(0);
  const [statusNonce, setStatusNonce] = useState(0);
  const alive = useRef(true);
  /** Set by `reload()`: the next read is one the person asked for, so its failure is shown. */
  const explicitRead = useRef(false);
  const refresh = useRouterRefreshSignal();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Q6-SHOTS note 2: only the first load and an explicit reload may replace what is shown with an error. A
    // background re-read (the refresh signal, a save answer without warnings) that fails keeps the loaded
    // router and with it any unsaved draft keyed on that config.
    const explicit = explicitRead.current;
    explicitRead.current = false;
    const fail = (error: string) =>
      setState((prev) => (prev.data !== null && !explicit ? { ...prev, load: 'ready' } : { load: 'error', data: null, error }));
    void gwGet('/api/app-router').then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        fail(result.error);
        return;
      }
      const parsed = parseRouterGet(result.data);
      if (parsed === null) {
        fail('no router settings in the answer');
        return;
      }
      setState((prev) => {
        const keep = prev.data !== null && sameStored(prev.data.config, parsed.config);
        return { load: 'ready', data: keep && prev.data ? { ...parsed, config: prev.data.config } : parsed, error: null };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [nonce, refresh]);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      if (!pageVisible()) return;
      const next = await readRouterStatus();
      if (!cancelled && next !== null) setStatus(next);
    }
    void tick();
    const id = setInterval(() => void tick(), ROUTER_STATUS_POLL_MS);
    const onVisible = () => {
      if (pageVisible()) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    // Q7: the refresh signal re-reads the status too, so a step that is skipped (or usable again) shows at once.
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [statusNonce, refresh]);

  const reload = useCallback(() => {
    explicitRead.current = true;
    setState((prev) => ({ ...prev, load: prev.data === null ? 'loading' : prev.load }));
    setNonce((n) => n + 1);
    setStatusNonce((n) => n + 1);
  }, []);
  const refreshStatus = useCallback(() => setStatusNonce((n) => n + 1), []);
  const adopt = useCallback((config: RouterConfig, warnings?: readonly RouterWarning[] | null) => {
    if (!alive.current) return;
    setState((prev) =>
      prev.data ? { ...prev, data: { ...prev.data, config, problems: 0, warnings: warnings ?? keepWarnings(prev.data.warnings, config.entries) } } : prev,
    );
    // A save answer without warnings: until the re-read lands, only the ones that still fit are kept (above).
    if (warnings === null) setNonce((n) => n + 1);
    setStatusNonce((n) => n + 1);
  }, []);

  return { ...state, status, reload, refreshStatus, adopt };
}

/** The provider model lists from `GET /api/models` (read on mount, on `refresh` and when the router refresh signal moves). */
export function useProviderModels(): { readonly list: readonly ProviderModels[] | null; readonly refresh: () => void } {
  const [list, setList] = useState<readonly ProviderModels[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const signal = useRouterRefreshSignal();
  useEffect(() => {
    let cancelled = false;
    void gwGet('/api/models').then((result) => {
      if (!cancelled) setList(result.ok ? parseProviderModels(result.data).list : []);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce, signal]);
  return { list, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}
