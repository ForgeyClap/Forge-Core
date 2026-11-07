/**
 * W3FX-D (gate flake): `usePendingPermissions` awaited the gateway and then set state, even when the
 * view had unmounted meanwhile. In the full vitest run the answer could land after jsdom was torn
 * down, and the state update threw "window is not defined" (vitest exit 1 in 2 of 3 runs).
 *
 * A request that lands after unmount must not touch state. The rows sit behind a getter, so reading
 * them (parsePending, which only runs to feed setPending) is the observable "state update".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { usePendingPermissions } from '@/views/chat/permissions/use-pending-permissions';

const ROW = { id: 'p1', tool_name: 'Bash', input: { command: 'npm install' }, created_at: '2026-11-03T10:00:00Z' };

/** A fetch whose answer waits for `release()`; `read` turns true when the rows are read. */
function deferredFetch() {
  const probe = { read: false, release: null as (() => void) | null };
  const fetchStub = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      probe.release = resolve;
    });
    const body = {
      ok: true,
      get pending() {
        probe.read = true;
        return [ROW];
      },
    };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  return { probe, fetchStub };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('usePendingPermissions after unmount', () => {
  it('a poll that lands after unmount causes no state update', async () => {
    const { probe, fetchStub } = deferredFetch();
    vi.stubGlobal('fetch', fetchStub);
    const { unmount } = renderHook(() => usePendingPermissions('c1', 60_000));
    await settle();
    expect(probe.release).not.toBeNull();

    unmount();
    probe.release?.();
    await settle();

    expect(probe.read).toBe(false);
  });

  it('control: the same poll while mounted does update the list', async () => {
    const { probe, fetchStub } = deferredFetch();
    vi.stubGlobal('fetch', fetchStub);
    const { result } = renderHook(() => usePendingPermissions('c1', 60_000));
    await settle();
    probe.release?.();
    await settle();

    expect(probe.read).toBe(true);
    expect(result.current.pending.map((row) => row.id)).toEqual(['p1']);
  });

  it('an answer that lands after unmount neither drops a row nor starts a new poll', async () => {
    let releasePost: (() => void) | null = null;
    const gets: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          await new Promise<void>((resolve) => {
            releasePost = resolve;
          });
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        }
        gets.push(String(url));
        return { ok: true, status: 200, json: async () => ({ ok: true, pending: [ROW] }) } as Response;
      }),
    );
    const { result, unmount } = renderHook(() => usePendingPermissions('c1', 60_000));
    await settle();
    expect(result.current.pending).toHaveLength(1);
    const getsBefore = gets.length;

    const answered = result.current.answer('p1', 'allow');
    await settle();
    unmount();
    (releasePost as (() => void) | null)?.();
    await answered;
    await settle();

    expect(gets.length).toBe(getsBefore);
  });
});
