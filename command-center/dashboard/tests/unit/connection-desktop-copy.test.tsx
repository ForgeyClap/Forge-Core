/**
 * WP B3-ui fix round: the desktop app (window.forge present) never shows the developer command that
 * starts the gateway, and its "not connected" copy never promises an automatic recovery the desktop
 * shell does not have (desktop main.mjs only logs a gateway exit; there is no restart policy yet).
 *
 * Every gateway call is a rejected fetch, so the shared connection store goes DISCONNECTED.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import nl from '@/i18n/locales/nl.json';
import en from '@/i18n/locales/en.json';
import { setLocale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { useGatewayConnection } from '@/prototype/state/adapter/connection';
import { liveChipState } from '@/components/shell/claude-code-chip';
import { ClaudeCodeChip } from '@/views/chat/ClaudeCodeChip';

/** Words that would promise a recovery the desktop app does not perform. */
const AUTO_RECOVERY = /vanzelf|automatisch|automatically|restarts|restarting|on its own/i;

const DESKTOP_ORIGIN = 'http://127.0.0.1:49519';

function installDesktop(): void {
  (globalThis as { forge?: unknown }).forge = { gatewayOrigin: () => DESKTOP_ORIGIN };
}

function offline(): void {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
}

function buildState(): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: '',
    activeConversationId: '',
    selection: { kind: 'none' },
    pinnedProjectIds: [],
    projectQuery: '',
    agentFilter: 'all',
    agentLayout: 'grouped',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as { forge?: unknown }).forge;
  setLocale('en');
});

describe('desktop disconnected copy never claims automatic recovery', () => {
  it('nl and en shell.connection.disconnectedDesktop say what to do, not that it fixes itself', () => {
    const nlText = nl.shell.connection.disconnectedDesktop;
    const enText = en.shell.connection.disconnectedDesktop;
    expect(nlText).not.toMatch(AUTO_RECOVERY);
    expect(enText).not.toMatch(AUTO_RECOVERY);
    expect(nlText).toContain('Forge Systeem');
    expect(enText).toContain('Forge Systeem');
  });

  it('the topbar chip in the desktop app: no "start Forge" instruction, no automatic-recovery promise', () => {
    installDesktop();
    setLocale('nl');
    const chip = liveChipState('DISCONNECTED', null);
    expect(`${chip.state} ${chip.title}`).not.toMatch(AUTO_RECOVERY);
    expect(chip.state).not.toMatch(/start Forge/i);
  });
});

describe('the developer command never reaches the desktop app', () => {
  function Probe() {
    const connection = useGatewayConnection();
    return createElement(
      'output',
      { 'data-testid': 'probe', 'data-status': connection.status },
      `${connection.startCommand ?? 'NO-COMMAND'} | ${connection.detail ?? ''}`,
    );
  }

  it('useGatewayConnection: startCommand is null and the detail is the Dutch desktop sentence', async () => {
    installDesktop();
    setLocale('nl');
    offline();
    render(createElement(Probe));
    const probe = screen.getByTestId('probe');
    await waitFor(() => expect(probe).toHaveAttribute('data-status', 'DISCONNECTED'), { timeout: 3000 });
    expect(probe.textContent).toContain('NO-COMMAND');
    expect(probe.textContent).not.toContain('bin.mjs');
    expect(probe.textContent).toContain(nl.shell.connection.disconnectedDesktop);
  });

  it('the browser build still gets the real start command', async () => {
    offline();
    render(createElement(Probe));
    const probe = screen.getByTestId('probe');
    await waitFor(() => expect(probe).toHaveAttribute('data-status', 'DISCONNECTED'), { timeout: 3000 });
    expect(probe.textContent).toContain('node command-center/gateway/bin.mjs');
  });

  it('ClaudeCodeChip disconnected inside the desktop app: no bin.mjs, no automatic-recovery promise', async () => {
    installDesktop();
    offline();
    const value: StoreValue = { state: buildState(), dispatch: vi.fn() };
    render(createElement(PrototypeContext.Provider, { value }, createElement(ClaudeCodeChip)));
    const chip = document.querySelector<HTMLButtonElement>('.fw-chat-cc__chip');
    expect(chip).not.toBeNull();
    // Wait until the shared store reports the real DISCONNECTED state, then open the popover.
    await waitFor(() => expect(document.body.textContent).toMatch(/disconnected|not connected|niet verbonden/i), {
      timeout: 3000,
    });
    act(() => {
      fireEvent.click(chip as HTMLButtonElement);
    });
    expect(screen.getByRole('dialog', { name: 'Claude Code link' })).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).toContain('DISCONNECTED');
    expect(text).not.toContain('bin.mjs');
    expect(text).not.toMatch(AUTO_RECOVERY);
  });
});
