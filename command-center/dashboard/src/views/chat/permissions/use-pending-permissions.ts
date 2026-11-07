/**
 * usePendingPermissions — the data side of the permission cards (WP B3).
 *
 * Polls the gateway for the requests that wait in one conversation and answers them. Paths follow
 * `_scratch/b3/contract-permissions.md`; they live in `PERMISSION_ROUTES` so the one place to change
 * them is here if the gateway lane (B3-gw / A11-gw) registers them differently.
 *
 * Never throws: a failed poll keeps the last known list (an unanswered request stays "Wacht op
 * jou", never failed); a failed answer rejects, which the card shows as "Je antwoord kwam niet aan".
 *
 * Switching conversations clears the list at once, and a poll that was still on its way for the
 * previous conversation is dropped when it lands: one conversation's request never shows under
 * another (it could be answered there by mistake).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { EXEC_TOKEN_HEADER, gwGet, gwPost, readExecToken } from '@/prototype/state/gateway-client';

import type { PendingPermission, PermissionBehavior } from './permission-types';

export const PERMISSION_ROUTES = {
  pending: (conversationId: string) => `/api/permissions/pending?conversation=${encodeURIComponent(conversationId)}`,
  answer: (id: string) => `/api/permissions/${encodeURIComponent(id)}/answer`,
} as const;

export const PERMISSION_POLL_MS = 1500;

/** Marks the hook as unmounted in the "which conversation is shown" ref. */
const UNMOUNTED = Symbol('unmounted');

/** Keeps only well-formed rows; anything else from the wire is dropped, not guessed at. */
export function parsePending(data: Record<string, unknown>): PendingPermission[] {
  const rows = Array.isArray(data.pending) ? data.pending : [];
  const out: PendingPermission[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.tool_name !== 'string') continue;
    const input = r.input !== null && typeof r.input === 'object' && !Array.isArray(r.input) ? (r.input as Record<string, unknown>) : {};
    const categories = Array.isArray(r.categories) ? r.categories.filter((c): c is string => typeof c === 'string') : undefined;
    out.push({
      id: r.id,
      tool_name: r.tool_name,
      input,
      agent: typeof r.agent === 'string' ? r.agent : null,
      created_at: typeof r.created_at === 'string' ? r.created_at : new Date(0).toISOString(),
      ...(categories ? { categories } : {}),
      ...(typeof r.rememberable === 'boolean' ? { rememberable: r.rememberable } : {}),
    });
  }
  return out;
}

export interface PendingPermissionsApi {
  readonly pending: readonly PendingPermission[];
  readonly answer: (id: string, behavior: PermissionBehavior) => Promise<void>;
}

export function usePendingPermissions(conversationId: string | null | undefined, pollMs = PERMISSION_POLL_MS): PendingPermissionsApi {
  const [pending, setPending] = useState<readonly PendingPermission[]>([]);
  // The conversation the view shows right now; a response for any other one is dropped.
  // After unmount it holds UNMOUNTED, so an answer that lands then (in tests: after jsdom teardown)
  // never touches state. Written in a layout effect, in the same commit as the switch.
  const current = useRef<string | null | undefined | typeof UNMOUNTED>(conversationId);
  useLayoutEffect(() => {
    current.current = conversationId;
    return () => {
      current.current = UNMOUNTED;
    };
  }, [conversationId]);

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setPending([]);
      return;
    }
    const asked = conversationId;
    const result = await gwGet(PERMISSION_ROUTES.pending(asked));
    if (current.current !== asked) return;
    if (result.ok) setPending(parsePending(result.data));
  }, [conversationId]);

  // A new conversation starts with an empty list, before its first poll has answered.
  const [shownFor, setShownFor] = useState(conversationId);
  if (shownFor !== conversationId) {
    setShownFor(conversationId);
    setPending([]);
  }

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void refresh();
    };
    tick();
    if (!conversationId) return () => {
      alive = false;
    };
    const timer = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [conversationId, pollMs, refresh]);

  const answer = useCallback(
    async (id: string, behavior: PermissionBehavior) => {
      const token = readExecToken();
      const result = await gwPost(PERMISSION_ROUTES.answer(id), { behavior }, token ? { [EXEC_TOKEN_HEADER]: token } : {});
      if (!result.ok) throw new Error(result.error);
      if (current.current === UNMOUNTED) return;
      setPending((rows) => rows.filter((row) => row.id !== id));
      void refresh();
    },
    [refresh],
  );

  return { pending, answer };
}
