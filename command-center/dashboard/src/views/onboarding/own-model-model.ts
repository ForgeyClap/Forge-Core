/**
 * own-model-model — "Geen Claude?" (ANY-MODEL-PLAN.md §7): turn the model a person picked on the
 * first start into the router stand "Meteen eigen model" (APP-ROUTER-DESIGN.md §1 mode model-first).
 * Pure, so the exact chain the wizard saves is unit-tested. The gateway validates it again (§2.4).
 *
 * Rules: the chosen entry goes FIRST and is switched on (model_first_order); an existing entry of the
 * same service (or the one codex entry) is re-used instead of adding a second; Claude accounts stay in
 * the chain after it, as the mode describes ("for example when Ollama is not running").
 */

import type { RouterConfig, RouterEntry } from '@/prototype/state/adapter/app-router';
import { fallbackEntryId, fallbackLabel, OLLAMA_LOCAL } from '@/views/settings/sections/app-router/app-router-model';

export type OwnModelTarget =
  | { readonly kind: 'codex' }
  | {
      readonly kind: 'provider';
      readonly provider: string;
      readonly providerName: string;
      readonly model: string;
      /** The service is paid per use through the user's own key (router rule paid_ack_required). */
      readonly paidAck: boolean;
      /** Messages leave this computer for a service with its own terms (router rule notice_ack_required). */
      readonly noticeAck: boolean;
    };

function codexEntry(config: RouterConfig): RouterEntry {
  const existing = config.entries.find((entry) => entry.kind === 'codex-account');
  if (existing) return { ...existing, enabled: true };
  const taken = new Set(config.entries.map((entry) => entry.id));
  const id = taken.has('codex') ? fallbackEntryId('codex', 'account', taken) : 'codex';
  return { id, kind: 'codex-account', label: 'Codex', profile: null, enabled: true };
}

function providerEntry(config: RouterConfig, target: Extract<OwnModelTarget, { kind: 'provider' }>): RouterEntry {
  const label = fallbackLabel(target.providerName, target.model);
  const existing = config.entries.find((entry) => entry.kind === 'provider-model' && entry.provider === target.provider);
  if (existing) return { ...existing, model: target.model, label, enabled: true, paid_ack: target.paidAck, notice_ack: target.noticeAck };
  const local = target.provider === OLLAMA_LOCAL;
  return {
    id: fallbackEntryId(target.provider, target.model, new Set(config.entries.map((entry) => entry.id))),
    kind: 'provider-model',
    label,
    provider: target.provider,
    model: target.model,
    enabled: true,
    num_ctx: local ? 8192 : null,
    vars: local ? { port: '11434' } : {},
    paid_ack: target.paidAck,
    notice_ack: target.noticeAck,
  };
}

/** The config to save: the chosen model first and on, mode model-first, everything else kept. */
export function applyModelFirst(config: RouterConfig, target: OwnModelTarget): RouterConfig {
  const chosen = target.kind === 'codex' ? codexEntry(config) : providerEntry(config, target);
  const others = config.entries.filter((entry) => entry.id !== chosen.id);
  return { ...config, mode: 'model-first', entries: [chosen, ...others] };
}

/** The label the done line names ("Ollama · llama3.2"), or null for Codex (the copy names it). */
export function chosenLabel(config: RouterConfig): string | null {
  const first = config.entries[0];
  return first && first.kind === 'provider-model' ? first.label : null;
}
