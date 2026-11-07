/**
 * start-checklist — the "Start hier" card on Start (DESIGN.md §3.1): three first steps for a beginner.
 *
 * Storage (`localStorage forge.start`): `{ "closed": true, "proofSeen": true }`. Only these two facts are
 * stored; the other two steps are read from real state, never remembered:
 *   - "Account verbonden" from a real account signal (`accountReadyFrom`): a provider row the gateway
 *     reports as connected, or the checkup (Claude signed in, Codex found, Ollama up with a model). The
 *     gateway connection alone is NOT an account.
 *   - "Stel je eerste vraag" from whether a conversation exists.
 * "Bekijk een opleverbewijs" is stored only when a proof was actually shown: the screen that shows one
 * calls `markStartProofSeen()`; opening the list does not. Unreadable storage reads as
 * "nothing stored", never as a guess.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { fetchCheckup } from '@/components/checkup/checkup-model';
import type { CheckupResult } from '@/components/checkup/checkup-model';
import { parseProviders } from '@/prototype/state/adapter/providers';
import type { ProvidersPayload } from '@/prototype/state/adapter/providers';
import { gwGet } from '@/prototype/state/gateway-client';

export const START_STORAGE_KEY = 'forge.start';

interface StartStored {
  readonly closed: boolean;
  readonly proofSeen: boolean;
}

const EMPTY: StartStored = { closed: false, proofSeen: false };
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedValue: StartStored = EMPTY;

function readRaw(): string | null {
  try {
    return globalThis.localStorage?.getItem(START_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function readStartStored(): StartStored {
  const raw = readRaw();
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  if (raw === null) {
    cachedValue = EMPTY;
    return cachedValue;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    cachedValue = { closed: record.closed === true, proofSeen: record.proofSeen === true };
  } catch {
    cachedValue = EMPTY;
  }
  return cachedValue;
}

function writeStartStored(next: StartStored): void {
  try {
    globalThis.localStorage?.setItem(START_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the card simply comes back next time; nothing else depends on it.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface StartChecklistApi {
  readonly closed: boolean;
  readonly proofSeen: boolean;
  readonly close: () => void;
  readonly markProofSeen: () => void;
}

/**
 * For the screen that actually shows an opleverbewijs (Klussen & bewijs, a klus's proof section): ticks
 * "Bekijk een opleverbewijs". Not a hook, so any view can call it once the proof is on screen.
 */
export function markStartProofSeen(): void {
  if (readStartStored().proofSeen) return;
  writeStartStored({ ...readStartStored(), proofSeen: true });
}

export function useStartChecklist(): StartChecklistApi {
  const stored = useSyncExternalStore(subscribe, readStartStored, () => EMPTY);
  const close = useCallback(() => writeStartStored({ ...readStartStored(), closed: true }), []);
  return { closed: stored.closed, proofSeen: stored.proofSeen, close, markProofSeen: markStartProofSeen };
}

/* ------------------------------------------------------------------ "Account verbonden" */

/** True only on a real account signal; an unknown answer (null) is never a yes. */
export function accountReadyFrom(providers: ProvidersPayload | null, checkup: CheckupResult | null): boolean {
  if (providers !== null && providers.rows.some((row) => row.status === 'connected')) return true;
  if (checkup === null) return false;
  if (checkup.claude.found && checkup.claude.signedIn === true) return true;
  if (checkup.codex.found) return true;
  return checkup.ollama.up && checkup.ollama.models.length > 0;
}

/**
 * Reads the account signal once per mount while `enabled` (the card is showing): the provider list first,
 * and only when no row is connected, the pc checkup. No polling: coming back to Start reads it again.
 */
export function useAccountReady(enabled: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void (async () => {
      const list = await gwGet('/api/providers');
      const providers = list.ok ? parseProviders(list.data) : null;
      if (cancelled) return;
      if (accountReadyFrom(providers, null)) {
        setReady(true);
        return;
      }
      const checkup = await fetchCheckup();
      if (!cancelled) setReady(accountReadyFrom(providers, checkup.ok ? checkup.result : null));
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled && ready;
}
