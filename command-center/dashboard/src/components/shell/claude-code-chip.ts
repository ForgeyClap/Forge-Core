/**
 * Forge Workspace — the live Claude Code / gateway chip presentation.
 *
 * A plain function, not a component, in its own module — same reason
 * `nav-config.ts` is separate from `Sidebar.tsx`: a module that exports both a
 * component and a constant/function cannot be hot-reloaded by React Fast
 * Refresh, and the linter says so.
 *
 * `Topbar.tsx`'s chip and `SettingsView.tsx`'s "Claude Code connection"
 * section both call this — one presentation, reused rather than reinvented
 * (P0-3).
 */

import { t } from '@/i18n';
import type { ConnectionStatus } from '@/prototype/state/bridge-client';
import { isDesktopApp } from '@/prototype/state/gateway-client';
import type { ClaudeCodeStatus } from '@/shared/protocol';

export interface ChipState {
  readonly state: string;
  readonly title: string;
}

/**
 * The REAL connection + Claude Code health, projected onto the chip's middle
 * label. Nothing is invented: every branch reflects a value the gateway
 * actually reported, and an as-yet-unknown Claude status resolves to the plain
 * connection label rather than a guess.
 */
export function liveChipState(
  status: ConnectionStatus,
  claude: ClaudeCodeStatus | null,
  desktop: boolean = isDesktopApp(),
): ChipState {
  // WP B3-ui: the desktop app starts its own gateway and has no restart policy yet, so "start Forge"
  // and "reconnects by itself" are both untrue there; the title says what the user can do.
  if (desktop && status === 'DISCONNECTED') {
    return { state: t('shell.chip.disconnectedDesktop'), title: t('shell.chip.disconnectedDesktopTitle') };
  }
  switch (status) {
    case 'CONNECTING':
      return { state: t('shell.chip.connecting'), title: t('shell.chip.connectingTitle') };
    case 'DEGRADED':
      return {
        state: t('shell.chip.reconnecting'),
        title: t('shell.chip.reconnectingTitle'),
      };
    case 'DISCONNECTED':
      return {
        state: t('shell.chip.disconnected'),
        title: t('shell.chip.disconnectedTitle'),
      };
    case 'CONNECTED':
      if (claude === null) {
        return { state: t('shell.chip.connected'), title: t('shell.chip.connectedTitle') };
      }
      if (!claude.available) {
        return {
          state: t('shell.chip.notDetected'),
          title: claude.note ?? t('shell.chip.notDetectedTitle'),
        };
      }
      if (!claude.authenticated) {
        return {
          state: t('shell.chip.notSignedIn'),
          title: t('shell.chip.notSignedInTitle'),
        };
      }
      return {
        state: t('shell.chip.connected'),
        title: claude.version
          ? t('shell.chip.readyTitleVersion', { version: claude.version })
          : t('shell.chip.readyTitle'),
      };
  }
}
