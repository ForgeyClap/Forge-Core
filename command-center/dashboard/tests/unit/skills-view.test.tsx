/**
 * WP B5 — Vaardigheden & koppelingen (/skills): skill list from the real `/api/skills` shape, the
 * three connection tiers from the real `/api/mcp` shape, and the screen's empty / error / filter
 * states in Dutch. Skill slugs and server ids are log names and are excluded from the copy scan.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { connectionTier, filterSkills, groupConnections, parseSkillsList } from '@/prototype/state/adapter/skills';
import type { SkillsState } from '@/prototype/state/adapter/skills';
import { EMPTY_GATEWAY_MCP, parseGatewayMcp } from '@/prototype/state/gateway-capabilities';
import { SkillsPanel } from '@/views/skills/SkillsView';

const BANNED = /(?<![\p{L}\d_-])(Boss|run|MCP|token|hook|CLI|gateway|skills?|the|and|with|your|you|this|for|to|not|only)(?![\p{L}\d_-])/giu;

function findings(root: Element): string[] {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('[data-log-text], [data-log-name]').forEach((node) => node.remove());
  const texts: string[] = [];
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.trim();
    if (value) texts.push(value);
  }
  clone.querySelectorAll('[aria-label],[placeholder]').forEach((el) => texts.push(el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? ''));
  return texts.flatMap((text) => [...text.replace(/\b(Forge)\b/g, ' ').matchAll(BANNED)].map((m) => `${m[1]} in "${text}"`));
}

const SKILLS = {
  ok: true,
  skills: [
    { slug: 'forge-website', name: 'forge-website', description: 'Websites en landingspagina’s', has_skill_md: true },
    { slug: 'forge-n8n', name: 'forge-n8n', description: null, has_skill_md: true },
    { slug: 'kapot', name: 'kapot', description: null, has_skill_md: false },
    { slug: '', name: 'zonder slug' },
  ],
  skills_count: 3,
};

const MCP = parseGatewayMcp({
  ok: true,
  servers: [
    { id: 'context7', tier: 1, status: 'not-installed', purpose: 'Documentatie lezen' },
    { id: 'github-write', tier: 3, status: 'not-installed', credentials_needed: true },
    { id: 'playwright', tier: 2, status: 'installed' },
    { id: 'n8n', tier: 3, status: 'connected', purpose: 'Workflows' },
    { id: 'mystery', tier: null, status: 'active' },
  ],
  boss_grants: { 'build-boss': { allow_servers: ['n8n', 'playwright'] } } as unknown as never,
});

function skillsState(status: SkillsState['status'], data: Record<string, unknown> = SKILLS): SkillsState {
  return { status, value: parseSkillsList(data), error: status === 'error' ? 'HTTP 502' : null, reload: vi.fn() };
}

describe('skills mapping', () => {
  it('parses the real shape and drops a row without a slug', () => {
    const list = parseSkillsList(SKILLS);
    expect(list.skills.map((s) => s.slug)).toEqual(['forge-website', 'forge-n8n', 'kapot']);
    expect(list.count).toBe(3);
    expect(filterSkills(list.skills, 'landing').map((s) => s.slug)).toEqual(['forge-website']);
    expect(filterSkills(list.skills, '  ')).toHaveLength(3);
  });

  it('groups connections into dormant / limited / write-gated; unknown tier counts as write-gated', () => {
    const grants = parseGatewayMcp({ servers: [{ id: 'n8n', tier: 3, status: 'connected' }], boss_grants: [{ slug: 'build-boss', allow_servers: ['n8n'] }] });
    expect(groupConnections(grants).writeGated[0].helperCount).toBe(1);
    const groups = groupConnections(MCP);
    expect(groups.dormant.map((r) => r.server.id)).toEqual(['context7', 'github-write']);
    expect(groups.limited.map((r) => r.server.id)).toEqual(['playwright']);
    expect(groups.writeGated.map((r) => r.server.id)).toEqual(['n8n', 'mystery']);
    expect(groups.total).toBe(5);
    expect(groups.active).toBe(3);
    expect(connectionTier({ ...MCP.servers[0], optedIn: true })).toBe('limited');
  });
});

describe('SkillsPanel (Dutch)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  it('lists skills and the three tiers with Dutch copy', () => {
    const { container } = render(
      createElement(SkillsPanel, { projectName: 'bakkerij', skills: skillsState('ready'), connections: { status: 'ready', value: MCP }, onRetryConnections: vi.fn() }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Vaardigheden & koppelingen' })).toBeInTheDocument();
    expect(screen.getByText('3 vaardigheden')).toBeInTheDocument();
    expect(screen.getByText('Zonder beschrijving')).toBeInTheDocument();
    expect(screen.getByText('Map zonder beschrijving')).toBeInTheDocument();
    expect(screen.getByText('5 bekend · 3 aangezet')).toBeInTheDocument();
    const gated = screen.getByRole('region', { name: 'Schrijven alleen na toestemming' });
    expect(within(gated).getByText('n8n')).toBeInTheDocument();
    expect(within(gated).getByText('Trede onbekend')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Beperkt' })).getByText('Werkt afgeschermd')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Slapend' })).getByText('Heeft een sleutel nodig')).toBeInTheDocument();
    expect(findings(container)).toEqual([]);
  });

  it('filter with no match says so', () => {
    render(createElement(SkillsPanel, { projectName: 'bakkerij', skills: skillsState('ready'), connections: { status: 'ready', value: MCP }, onRetryConnections: vi.fn() }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Vaardigheden doorzoeken' }), { target: { value: 'zzz' } });
    expect(screen.getByText('Geen vaardigheid gevonden met “zzz”.')).toBeInTheDocument();
  });

  it('empty project and missing registry are honest empty states', () => {
    render(
      createElement(SkillsPanel, {
        projectName: 'leeg',
        skills: skillsState('ready', { ok: true, skills: [] }),
        connections: { status: 'ready', value: { ...EMPTY_GATEWAY_MCP, ok: true, registryPresent: false } },
        onRetryConnections: vi.fn(),
      }),
    );
    expect(screen.getByText('Dit project heeft nog geen vaardigheden.')).toBeInTheDocument();
    expect(screen.getByText('Dit project heeft geen lijst met koppelingen.')).toBeInTheDocument();
  });

  it('errors offer a retry on each side', () => {
    const onRetry = vi.fn();
    const skills = skillsState('error');
    render(createElement(SkillsPanel, { projectName: 'bakkerij', skills, connections: { status: 'error', value: EMPTY_GATEWAY_MCP }, onRetryConnections: onRetry }));
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    fireEvent.click(within(alerts[0]).getByRole('button', { name: 'Opnieuw proberen' }));
    fireEvent.click(within(alerts[1]).getByRole('button', { name: 'Opnieuw proberen' }));
    expect(skills.reload).toHaveBeenCalled();
    expect(onRetry).toHaveBeenCalled();
  });

  it('no project chosen', () => {
    render(createElement(SkillsPanel, { projectName: '', skills: skillsState('loading'), connections: { status: 'loading', value: EMPTY_GATEWAY_MCP }, onRetryConnections: vi.fn() }));
    expect(screen.getByText('Nog geen project gekozen')).toBeInTheDocument();
  });
});
