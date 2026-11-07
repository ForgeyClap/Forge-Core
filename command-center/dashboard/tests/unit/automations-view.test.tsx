/**
 * WP B5 — Automatiseringen (/automations): real state only, every control that is not wired yet is
 * disabled and says "nog niet gekoppeld", Discord is off unless the gateway says it runs, and the
 * error state never shows a guessed state. Dutch copy, no banned term.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { nightshiftState, summarizeDiscord, SCHEDULES_WIRED } from '@/prototype/state/adapter/automations';
import { EMPTY_GATEWAY_FORGE_CONFIG } from '@/prototype/state/gateway-capabilities';
import type { GatewayForgeConfig, GatewayForgeSetting } from '@/prototype/state/gateway-capabilities';
import { EMPTY_DISCORD_SERVICE } from '@/prototype/state/gateway-discord';
import { AutomationsPanel } from '@/views/automations/AutomationsView';

const BANNED = /(?<![\p{L}\d_-])(Boss|run|MCP|token|hook|CLI|gateway|the|and|with|your|you|this|for|to|not|only|on)(?![\p{L}\d_-])/giu;

function findings(root: Element): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.trim();
    if (value) texts.push(value);
  }
  root.querySelectorAll('[aria-label],[title]').forEach((el) => texts.push(el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''));
  return texts.flatMap((text) => [...text.replace(/\b(Forge|Discord)\b/g, ' ').matchAll(BANNED)].map((m) => `${m[1]} in "${text}"`));
}

function config(setting: Partial<GatewayForgeSetting> | null, available = true): GatewayForgeConfig {
  const base: GatewayForgeSetting = {
    ...({} as GatewayForgeSetting),
    key: 'nightshift',
    value: null,
    defaultValue: null,
    status: null,
  };
  return { ...EMPTY_GATEWAY_FORGE_CONFIG, available, settings: setting === null ? [] : [{ ...base, ...setting }] };
}

describe('automations mapping', () => {
  it('Discord is off unless the gateway reports it running', () => {
    expect(summarizeDiscord(EMPTY_DISCORD_SERVICE).state).toBe('notInstalled');
    expect(summarizeDiscord({ ...EMPTY_DISCORD_SERVICE, installed: true }).state).toBe('installed');
    expect(summarizeDiscord({ ...EMPTY_DISCORD_SERVICE, installed: true, running: true }).state).toBe('running');
    expect(summarizeDiscord(EMPTY_DISCORD_SERVICE).autostart).toBeNull();
  });

  it('nightshift reads the real setting and never guesses', () => {
    expect(nightshiftState(config({ status: 'on', value: true }))).toBe('on');
    expect(nightshiftState(config({ value: false }))).toBe('off');
    expect(nightshiftState(config({ value: null, defaultValue: true }))).toBe('on');
    expect(nightshiftState(config(null))).toBe('unknown');
    expect(nightshiftState(config({ value: true }, false))).toBe('unknown');
  });

  it('schedules are not wired to any gateway route', () => {
    expect(SCHEDULES_WIRED).toBe(false);
  });
});

describe('AutomationsPanel (Dutch)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  const ready = {
    projectName: 'bakkerij',
    discord: { status: 'ready' as const, value: summarizeDiscord({ ...EMPTY_DISCORD_SERVICE, installed: true }) },
    nightshift: { status: 'ready' as const, value: 'on' as const },
    onOpenDiscord: vi.fn(),
    onRetry: vi.fn(),
  };

  it('shows the real states; switches that do nothing are disabled and labelled', () => {
    const { container } = render(createElement(AutomationsPanel, ready));
    expect(screen.getByRole('heading', { level: 1, name: 'Automatiseringen' })).toBeInTheDocument();
    expect(screen.getByText('Er zijn geen geplande klussen. Forge plant nooit zelf iets in.')).toBeInTheDocument();
    expect(screen.getByText('Ingesteld, maar uit')).toBeInTheDocument();
    expect(screen.getByText('Aan in bakkerij')).toBeInTheDocument();
    const schedule = screen.getByRole('switch', { name: 'Geplande klussen aan' });
    const night = screen.getByRole('switch', { name: 'Nachtdienst aan' });
    expect(schedule).toBeDisabled();
    expect(schedule).toHaveAttribute('aria-checked', 'false');
    expect(night).toBeDisabled();
    expect(night).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByText('nog niet gekoppeld')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Discord-scherm openen' }));
    expect(ready.onOpenDiscord).toHaveBeenCalled();
    expect(findings(container)).toEqual([]);
  });

  it('error: no state is shown as current, with a retry', () => {
    const props = { ...ready, discord: { status: 'error' as const, value: null }, nightshift: { status: 'error' as const, value: 'unknown' as const } };
    render(createElement(AutomationsPanel, props));
    expect(screen.getByRole('alert')).toHaveTextContent('Forge is nu niet bereikbaar');
    expect(screen.queryByText('Ingesteld, maar uit')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Nachtdienst aan' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Opnieuw proberen' }));
    expect(props.onRetry).toHaveBeenCalled();
  });

  it('without a project the night shift asks for one', () => {
    render(createElement(AutomationsPanel, { ...ready, projectName: '', nightshift: { status: 'loading', value: 'unknown' } }));
    expect(screen.getByText('Kies eerst een project om de stand te zien.')).toBeInTheDocument();
  });
});
