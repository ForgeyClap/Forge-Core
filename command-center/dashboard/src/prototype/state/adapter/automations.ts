/**
 * Forge Command Center — "Automatiseringen" slice (WP B5).
 *
 * No new gateway route: the screen reads what already exists and says plainly what does not.
 *   - Discord: `GET /api/discord/status` through `useGatewayDiscordStatus` (gateway-discord.ts).
 *   - Nachtdienst: the project's `nightshift` setting from `GET /api/config` through
 *     `useGatewayForgeConfig` (gateway-capabilities.ts). Status only; this screen never writes it.
 *   - Geplande klussen: the gateway has no schedule route. The screen shows that honestly, with the
 *     switch rendered disabled ("nog niet gekoppeld"), never as a working toggle.
 * This file holds the pure mappings so they can be unit tested without a render.
 */

import type { DiscordService } from '@/prototype/state/gateway-discord';
import type { GatewayForgeConfig } from '@/prototype/state/gateway-capabilities';

export type DiscordStateKey = 'running' | 'installed' | 'notInstalled';

export interface DiscordSummary {
  readonly state: DiscordStateKey;
  /** Whether the bot starts by itself with Forge; null when the gateway did not say. */
  readonly autostart: boolean | null;
  readonly username: string | null;
}

export function summarizeDiscord(service: DiscordService): DiscordSummary {
  const state: DiscordStateKey = service.running ? 'running' : service.installed ? 'installed' : 'notInstalled';
  return {
    state,
    autostart: service.autostart === null ? null : service.autostart.effective,
    username: service.username,
  };
}

export type NightshiftState = 'on' | 'off' | 'unknown';

/** The real `nightshift` value of the project, read from the config the gateway reports. */
export function nightshiftState(config: GatewayForgeConfig): NightshiftState {
  if (!config.available) return 'unknown';
  const setting = config.settings.find((row) => row.key === 'nightshift');
  if (setting === undefined) return 'unknown';
  if (setting.status === 'on' || setting.status === 'off') return setting.status;
  const value = setting.value ?? setting.defaultValue;
  if (value === true || value === 'on' || value === 'true') return 'on';
  if (value === false || value === 'off' || value === 'false') return 'off';
  return 'unknown';
}

/** The gateway exposes no schedule route (yet), so the honest list is always empty. */
export const SCHEDULES_WIRED = false;
