/**
 * WP B0b — the jargon test.
 *
 * Renders the shell (sidebar + the bar with its two menus), the composer (with its model and thinking menus open) and
 * the settings navigation in Dutch, collects every visible text and every accessible name / tooltip
 * / placeholder, and fails on:
 *   1. a banned term from the glossary in `command-center/desktop/product/PRODUCT-CARD.md`
 *      (Boss, WP, receipt, triage, GOAT, hard gate, worktree, run, bypass, effort, ...), and
 *   2. hardcoded English: a list of common English words that are not also Dutch words, with an
 *      allowlist for proper nouns (Forge, Claude Code, Opus, ...).
 * The same two checks also run over every Dutch string of the extracted namespaces in `nl.json`,
 * so toasts and states the render does not reach are covered too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { getLocale, setLocale } from '@/i18n';
import nl from '@/i18n/locales/nl.json';
import Sidebar from '@/components/shell/Sidebar';
import Bar from '@/components/shell/Bar';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { Composer } from '@/views/chat/Composer';
import SettingsView from '@/views/settings/SettingsView';
import { TeamStripView } from '@/views/team/TeamStrip';
import { TeamPanel } from '@/views/team/TeamView';
import { parseTeamChat, parseTeamDispatches, roleStatuses } from '@/views/team/team-data';

/** Never in Eenvoudig (PRODUCT-CARD.md, "Woordenlijst" + "Nooit in Eenvoudig"). Whole words, any case. */
const BANNED_TERMS = [
  'Boss',
  'WP',
  'receipt',
  'triage',
  'GOAT',
  'hard gate',
  'worktree',
  'run',
  'bypass',
  'effort',
  'subagent',
  'hook',
  'MCP',
  'token',
  'stderr',
  'dispatch',
  'CLI',
  'Doctor',
  'gateway',
  'sessie',
  'thread',
  'YOLO',
  'plan mode',
  'read-only',
  'accept edits',
  'work package',
  'evidence',
] as const;

/**
 * Common English words that are not also ordinary Dutch words. Whole words, any case. Deliberately
 * absent because they are Dutch too: of, in, is, plan, model, team, start, project, status, open,
 * stop, recent, privacy, compact, context.
 */
const ENGLISH_MARKERS = [
  'the', 'and', 'with', 'your', 'you', 'this', 'that', 'for', 'from', 'to', 'on', 'by', 'or',
  'not', 'yet', 'will', 'can', 'new', 'search', 'send', 'queue', 'select', 'choose', 'add', 'remove',
  'delete', 'settings', 'conversations', 'projects', 'connected', 'connecting', 'disconnected', 'copy',
  'copied', 'default', 'appearance', 'density', 'files', 'file', 'message', 'messages', 'waiting',
  'pinned', 'more', 'attach', 'skills', 'skill', 'mode', 'execute', 'workspace', 'agents',
  'tasks', 'artifacts', 'activity', 'mission', 'control', 'overview', 'home', 'show', 'hide', 'expand',
  'collapse', 'drawer', 'primary', 'reset', 'wired', 'only', 'marked', 'sections', 'layout', 'models',
  'shortcuts', 'permissions', 'capabilities', 'preferences', 'keyboard',
] as const;

/** Proper nouns and key names that are the same in every language. */
const PROPER_NOUNS = /\b(Forge|Claude Code|Claude|Opus|Sonnet|Fable|Haiku|Discord|Codex|ChatGPT|Ollama|Ctrl|Shift|Enter)\b/g;

function wordPattern(words: readonly string[]): RegExp {
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  return new RegExp(`(?<![\\p{L}\\d_-])(${escaped.join('|')})(?![\\p{L}\\d_-])`, 'giu');
}

const BANNED = wordPattern(BANNED_TERMS);
const ENGLISH = wordPattern(ENGLISH_MARKERS);

interface Finding {
  readonly where: string;
  readonly word: string;
  readonly text: string;
}

function scan(where: string, raw: string): Finding[] {
  // `{name}` placeholders are code, not copy.
  const text = raw.replace(PROPER_NOUNS, ' ').replace(/\{\w+\}/g, ' ');
  const findings: Finding[] = [];
  for (const match of text.matchAll(BANNED)) findings.push({ where: `${where} [banned]`, word: match[1], text: raw });
  for (const match of text.matchAll(ENGLISH)) findings.push({ where: `${where} [english]`, word: match[1], text: raw });
  return findings;
}

/** Visible text (one entry per text node) plus every name a screen reader or tooltip shows. */
function collectStrings(root: ParentNode): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent?.trim();
    if (value) out.push(value);
  }
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
      const value = element.getAttribute(attribute)?.trim();
      if (value) out.push(value);
    }
  }
  return out;
}

/** Readable lines, so a failure names the screen, the word and the full string it sits in. */
function report(findings: readonly Finding[]): string[] {
  return findings.map((finding) => `${finding.where}: "${finding.word}" in "${finding.text}"`);
}

function scanRoot(where: string, root: ParentNode): Finding[] {
  return collectStrings(root).flatMap((text) => scan(where, text));
}

/**
 * WP B4: the team screens show two kinds of text that are not interface copy — what a helper wrote
 * in the channel (`data-log-text`) and, in Uitgebreid only, the English names from the logs
 * (`data-log-name`, allowed there by PRODUCT-CARD.md). Both are removed from a clone before the scan.
 */
function scanCopyOnly(where: string, root: Element): Finding[] {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('[data-log-text], [data-log-name]').forEach((node) => node.remove());
  return scanRoot(where, clone);
}

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
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
    activeProjectId: 'p1',
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
    ...overrides,
  };
}

function renderInShell(element: ReturnType<typeof createElement>) {
  const value: StoreValue = { state: buildState(), dispatch: vi.fn() };
  return render(
    createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, element)),
  );
}

describe('jargon test (WP B0b): Dutch screens carry no banned term and no hardcoded English', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
    );
    setLocale('nl');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('runs in Dutch', () => {
    expect(getLocale()).toBe('nl');
  });

  it('the detector itself catches a banned term and an English sentence', () => {
    expect(scan('probe', 'De Build Boss doet een run').map((f) => f.word)).toEqual(['Boss', 'run']);
    expect(scan('probe', 'Send the message').map((f) => f.word.toLowerCase())).toEqual(['send', 'the', 'message']);
    expect(scan('probe', 'Verbonden met Claude Code via Forge')).toEqual([]);
  });

  it('sidebar (with the main menu)', () => {
    const { container } = renderInShell(createElement(Sidebar));
    expect(screen.getByText('Gesprekken')).toBeInTheDocument();
    expect(report(scanRoot('sidebar', container))).toEqual([]);
  });

  // Redesign 1C replaced the topbar (and its account popover) with the bar: `?` (Hulp en uitleg) in
  // every mode, `...` (Meer opties) in Uitgebreid only. Both menus are opened and scanned item by item.
  it('the bar and its menus, in Eenvoudig and in Uitgebreid', async () => {
    const { setUiMode } = await import('@/state/ui-mode');
    for (const mode of ['eenvoudig', 'uitgebreid'] as const) {
      act(() => setUiMode(mode));
      try {
        const { container, unmount } = renderInShell(createElement(Bar));
        const menus = mode === 'uitgebreid' ? ['Hulp en uitleg', 'Meer opties'] : ['Hulp en uitleg'];
        if (mode === 'eenvoudig') expect(screen.queryByRole('button', { name: 'Meer opties' })).toBeNull();
        for (const name of menus) {
          fireEvent.click(screen.getByRole('button', { name }));
          const menu = screen.getByRole('menu', { name });
          expect(within(menu).getAllByRole('menuitem').length, `${mode}/${name}`).toBeGreaterThan(0);
          expect(report(scanRoot(`bar/${mode}/${name}`, container))).toEqual([]);
          fireEvent.keyDown(menu, { key: 'Escape' });
          expect(screen.queryByRole('menu')).toBeNull();
        }
        unmount();
      } finally {
        act(() => setUiMode('eenvoudig'));
      }
    }
  });

  it('composer, with the model and thinking menus open, in every send mode', async () => {
    const { container } = renderInShell(
      createElement(Composer, {
        onSend: vi.fn(() => true),
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Mijn website',
        production: true,
      }),
    );
    const findings: Finding[] = [];
    // (2A, DESIGN.md §2): the send modes, model and effort menus live in the composer's "+" tray.
    // Scan the closed composer first, then open the tray so every control in it is scanned too.
    findings.push(...scanRoot('composer:closed', container));
    fireEvent.click(screen.getByRole('button', { name: 'Toevoegen' }));
    for (const name of ['Eerst vragen', 'Alleen plannen', 'Mag aanpassen']) {
      fireEvent.click(screen.getByRole('radio', { name }));
      findings.push(...scanRoot(`composer:${name}`, container));
    }
    // WP B3: Volledige toegang does not exist in Eenvoudig; in Uitgebreid it asks once per project.
    expect(screen.queryByRole('radio', { name: 'Volledige toegang' })).toBeNull();
    const { setUiMode } = await import('@/state/ui-mode');
    act(() => setUiMode('uitgebreid'));
    try {
      fireEvent.click(screen.getByRole('radio', { name: 'Volledige toegang' }));
      findings.push(...scanRoot('composer:volledige-toegang-vraag', container));
      fireEvent.click(screen.getByRole('button', { name: 'Ja, volledige toegang' }));
      findings.push(...scanRoot('composer:Volledige toegang', container));
      // Lead decision 2026-11-02 (plan 4.2): Denkkracht and Automatisch plannen exist in Uitgebreid only.
      // The trigger's accessible name is its current choice; the menu's own name is its title.
      fireEvent.click(screen.getByTitle('Denkkracht'));
      findings.push(...scanRoot('composer:thinking-menu', container));
    } finally {
      act(() => setUiMode('eenvoudig'));
    }
    expect(screen.queryByTitle('Denkkracht')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Automatisch plannen' })).toBeNull();
    fireEvent.click(screen.getByTitle('Kies een model'));
    findings.push(...scanRoot('composer:model-menu', container));
    expect(screen.getByRole('button', { name: 'Versturen' })).toBeInTheDocument();
    expect(report(findings)).toEqual([]);
  });

  it('settings: the whole one-page screen with a silent gateway (WP B6 replaced the old header/nav case)', async () => {
    const { container } = renderInShell(createElement(SettingsView));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole('navigation', { name: 'Groepen' })).toBeInTheDocument();
    // The bar draws no title on a page with its own (DESIGN.md §2), so the page carries the one h1.
    expect(screen.getByRole('heading', { level: 1, name: 'Instellingen' })).toBeInTheDocument();
    expect(report(scanRoot('settings', container))).toEqual([]);
  });

  it('team strip (Eenvoudig), closed and open, and the Team screen (Uitgebreid)', () => {
    const run = 'r1';
    const statuses = roleStatuses(
      parseTeamDispatches({
        dispatches: [
          { run_id: run, agent: 'Head Chef', running: true },
          { run_id: run, agent: 'Build Boss', running: false, completed_at: '2026-11-01T10:00:00Z' },
          { run_id: run, agent: 'Test Boss', running: false, stalled: true },
        ],
      }),
      run,
    );
    const chat = {
      status: 'ready' as const,
      error: null,
      ...parseTeamChat({
        lines: ['decision', 'handoff', 'question', 'blocker', 'message'].map((kind, index) => ({
          ts: `2026-11-01T10:0${index}:00Z`,
          from: index === 0 ? 'lead' : 'Build Boss',
          to: 'Test Boss',
          wp_id: 'B4',
          kind,
          text: '[Build Boss -> Test Boss] the run is done | wp=B4 | run=r1',
          via: index === 4 ? 'lead' : 'direct',
        })),
        malformed: 1,
        truncated: true,
      }),
    };
    const findings: Finding[] = [];
    const strip = renderInShell(createElement(TeamStripView, { statuses, chat }));
    findings.push(...scanCopyOnly('team-strip:closed', strip.container));
    fireEvent.click(screen.getByRole('button', { name: /Overleg van het team tonen/ }));
    findings.push(...scanCopyOnly('team-strip:open', strip.container));
    cleanup();
    const panel = renderInShell(
      createElement(TeamPanel, {
        runs: [{ id: run, label: 'Website bakkerij', live: true }],
        runId: run,
        onRunChange: vi.fn(),
        statuses,
        chat,
        hasProject: true,
      }),
    );
    expect(screen.getByText('Vastgepind')).toBeInTheDocument();
    findings.push(...scanCopyOnly('team-view', panel.container));
    expect(report(findings)).toEqual([]);
  });

  it('every Dutch string of the extracted namespaces in nl.json', () => {
    const findings: Finding[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') {
        findings.push(...scan(path, node));
        return;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) walk(child, `${path}.${key}`);
    };
    // nav.theme / nav.accounts / nav.discord are internal screens that never ship in the Eenvoudig
    // build (PRODUCT-CARD.md); they are still checked, there is no exception list.
    walk(nl, 'nl');
    expect(report(findings)).toEqual([]);
  });
});

/* Redesign: the add-only `rd.*` keys (Forge Systeem redesign, DESIGN.md) are scanned on their own, */
/* so a failure names the key. Short, Dutch-first, no jargon, one line each, no exclamation marks.        */
describe('jargon test (redesign 1D): the rd.* keys', () => {
  const leaves = (node: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> => {
    if (typeof node === 'string') out.push([path, node]);
    else for (const [k, v] of Object.entries(node as Record<string, unknown>)) leaves(v, `${path}.${k}`, out);
    return out;
  };
  const rdNl = leaves((nl as unknown as { rd: unknown }).rd, 'rd');

  it('exists in Dutch and carries the new screens', () => {
    expect(rdNl.length).toBeGreaterThan(150);
    for (const group of ['start', 'tour', 'bar', 'nav', 'chat', 'projects', 'settings', 'onboarding', 'learn', 'states']) {
      expect(rdNl.some(([key]) => key.startsWith(`rd.${group}.`))).toBe(true);
    }
  });

  it('has no banned term, no hardcoded English and no exclamation mark', () => {
    const findings = rdNl.flatMap(([key, value]) => scan(key, value));
    expect(report(findings)).toEqual([]);
    expect(rdNl.filter(([, value]) => value.includes('!')).map(([key]) => key)).toEqual([]);
  });

  it('keeps every string to one short line (at most 16 words)', () => {
    const long = rdNl.filter(([, value]) => value.trim().split(/\s+/).length > 16).map(([key]) => key);
    expect(long).toEqual([]);
  });

  it('has the same rd keys in English', async () => {
    const en = (await import('@/i18n/locales/en.json')).default as unknown as { rd: unknown };
    expect(leaves(en.rd, 'rd').map(([key]) => key)).toEqual(rdNl.map(([key]) => key));
  });

  it('keeps the same {placeholders} in both languages', async () => {
    const en = (await import('@/i18n/locales/en.json')).default as unknown as { rd: unknown };
    const holders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort().join(',');
    const enMap = new Map(leaves(en.rd, 'rd'));
    const bad = rdNl.filter(([key, value]) => holders(value) !== holders(enMap.get(key) ?? '')).map(([key]) => key);
    expect(bad).toEqual([]);
  });

  // deleted the unused rd.chat.notice.* keys; the shown line that announces a switch to an own model is
  // rd.chat.usageLine.toModel, and it must still say that model can only answer.
  it('keeps the honesty suffix on every line that announces a switch to an own model', () => {
    const notices = rdNl.filter(([, value]) => /wisselt .*eigen model|overgestapt naar/i.test(value));
    expect(notices.map(([key]) => key)).toContain('rd.chat.usageLine.toModel');
    for (const [, value] of notices) expect(value).toMatch(/alleen antwoorden/);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* WP B6: Settings (both modes, with a real-shaped gateway), "Controleer of alles werkt" with   */
/* its fixes and the diagnosis dialog open, and every onboarding step for every path. Modules   */
/* are imported inside the tests so this block never touches the shared import list above.     */
/* -------------------------------------------------------------------------------------------- */

describe('jargon test (WP B6): Settings, checkup and onboarding in Dutch', () => {
  const answer = {
    ok: true,
    checked_at: '2026-11-01T21:16:59.882Z',
    duration_ms: 1840,
    timed_out: false,
    claude: { found: true, version: '2.1.316', signedIn: false },
    codex: { found: false, version: null },
    ollama: { found: true, up: false, models: [] },
    node: { version: '24.18.0' },
    git: { found: false, version: null },
    disk_free_gb: 3.2,
    port: 4100,
    writable_project_dir: false,
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        let body: unknown = {};
        if (url.includes('/api/checkup')) body = answer;
        else if (url.includes('/api/health')) body = { ok: true, gateway: { project_root: String.raw`C:\Forge`, data_dir: String.raw`C:\Forge\data` } };
        else if (url.includes('/api/models'))
          body = { ok: true, roles: { lead: { model: 'sonnet', why: 'routes the work to the right helper' } }, nvidia: { state: 'no_key' } };
        else if (url.includes('/api/discord/browse-folder'))
          body = { ok: true, path: String.raw`C:\Users\iemand\Documents`, parent: String.raw`C:\Users\iemand`, folders: ['Forge Projecten'], truncated: false };
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );
    setLocale('nl');
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    const { setUiMode } = await import('@/state/ui-mode');
    setUiMode('eenvoudig');
  });

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it.each(['eenvoudig', 'uitgebreid'] as const)('settings page in %s, every fix opened, diagnosis dialog open', async (mode) => {
    const { setUiMode } = await import('@/state/ui-mode');
    setUiMode(mode);
    const { container } = renderInShell(createElement(SettingsView));
    await settle();
    if (mode === 'eenvoudig') {
      fireEvent.click(screen.getByRole('button', { name: 'Controleer of alles werkt' }));
      await settle();
    }
    const findings: Finding[] = [...scanCopyOnly(`settings:${mode}`, container)];
    for (const fix of Array.from(container.querySelectorAll<HTMLButtonElement>('.fs-checkup__row button[aria-expanded="false"]'))) {
      fireEvent.click(fix);
    }
    container.querySelectorAll('details').forEach((details) => details.setAttribute('open', ''));
    findings.push(...scanCopyOnly(`settings:${mode}:fixes`, container));
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose kopiëren' }));
    findings.push(...scanCopyOnly(`settings:${mode}:diagnose`, screen.getByRole('dialog', { name: 'Dit wordt gekopieerd' })));
    fireEvent.click(screen.getByRole('button', { name: 'Sluiten' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alles wissen' }));
    findings.push(...scanCopyOnly(`settings:${mode}:wissen`, screen.getByRole('dialog', { name: 'Alles wissen?' })));
    // Commands under "Technische details" are commands, not copy (PRODUCT-CARD.md, plan §4.4).
    expect(report(findings.filter((finding) => !/npm|winget|ollama serve|claude auth/.test(finding.text)))).toEqual([]);
  });

  it.each(['claude', 'chatgpt', 'lokaal', 'sleutel'] as const)('onboarding, every step, path %s', async (path) => {
    const { default: OnboardingView } = await import('@/views/onboarding/OnboardingView');
    const findings: Finding[] = [];
    for (const step of ['detectie', 'pad', 'verbinden', 'projectmap', 'klaar'] as const) {
      const { container, unmount } = renderInShell(createElement(OnboardingView, { initialStep: step, initialPath: path }));
      await settle();
      container.querySelectorAll('details').forEach((details) => details.setAttribute('open', ''));
      findings.push(...scanCopyOnly(`onboarding:${path}:${step}`, container));
      unmount();
    }
    // The command boxes hold commands, not copy.
    expect(report(findings.filter((finding) => !/^(npm|winget|ollama|claude|codex) /.test(finding.text)))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* WP B3 (cards): permission cards (single + group, details open), every error card, the status */
/* chip in both modes, the plan card and the shortcut overlay. The raw command under "Technische */
/* details" (<pre>), key caps (<kbd>) and log names are not copy and are removed before the scan. */
/* -------------------------------------------------------------------------------------------- */

describe('jargon test (WP B3 cards): permission, error, status, plan and shortcut cards in Dutch', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  function scanCards(where: string, root: Element): Finding[] {
    const clone = root.cloneNode(true) as Element;
    clone.querySelectorAll('pre, kbd, [data-log-name]').forEach((node) => node.remove());
    return scanRoot(where, clone);
  }

  it('every card, every error code, both status modes and the shortcut overlay', async () => {
    const { PermissionCards } = await import('@/views/chat/permissions/PermissionCard');
    const { ErrorCard } = await import('@/views/chat/errors/ErrorCard');
    const { CHAT_ERROR_CODES } = await import('@/views/chat/errors/error-catalogue');
    const { ChatStatusChip } = await import('@/views/chat/status/ChatStatus');
    const { PROTOCOL_STATES } = await import('@/views/chat/status/status-model');
    const { PlanCard } = await import('@/views/chat/plan-card/PlanCard');
    const { ShortcutOverlay } = await import('@/views/chat/shortcuts/ShortcutOverlay');
    const at = '2026-11-02T10:00:00Z';
    const one = [{ id: 'a', tool_name: 'Bash', input: { command: 'npm install && rm -rf dist' }, agent: 'Build Boss', created_at: at }];
    const many = [
      ...one,
      { id: 'b', tool_name: 'Write', input: { file_path: 'C:\\elders\\index.html' }, agent: 'UI Boss', created_at: at },
      { id: 'c', tool_name: 'WebFetch', input: { url: 'https://example.com' }, agent: null, created_at: at },
    ];
    const findings: Finding[] = [];
    for (const [label, pending] of [['single', one], ['group', many]] as const) {
      const { container, unmount } = render(createElement(PermissionCards, { pending, projectDir: 'C:\\Projecten\\site', onAnswer: vi.fn() }));
      container.querySelectorAll('details').forEach((details) => details.setAttribute('open', ''));
      findings.push(...scanCards(`permission:${label}`, container));
      unmount();
    }
    for (const code of CHAT_ERROR_CODES) {
      const { container, unmount } = render(
        createElement(ErrorCard, { error: { code, resume_at: at, model: 'qwen3:8b', attempt: 1, max_attempts: 3, details: 'x' } }),
      );
      container.querySelectorAll('details').forEach((details) => details.setAttribute('open', ''));
      findings.push(...scanCards(`error:${code}`, container));
      unmount();
    }
    for (const mode of ['eenvoudig', 'uitgebreid'] as const) {
      for (const state of PROTOCOL_STATES) {
        const { container, unmount } = render(createElement(ChatStatusChip, { state, mode }));
        findings.push(...scanCards(`status:${mode}:${state}`, container));
        unmount();
      }
    }
    const plan = render(
      createElement(PlanCard, {
        plan: { title: 'Website bakkerij', route: 'build', steps: [{ title: 'Bouwen', role: 'Build Boss' }, { title: 'Testen', role: 'Test Boss' }] },
        onStart: vi.fn(),
        onAdjust: vi.fn(),
        onLater: vi.fn(),
      }),
    );
    findings.push(...scanCards('plan', plan.container));
    plan.unmount();
    render(createElement(ShortcutOverlay, { open: true, onClose: vi.fn() }));
    findings.push(...scanCards('shortcuts', screen.getByRole('dialog')));
    // "npm" in the first line of a download request is the plan's own wording (PRODUCT-CARD.md exception).
    expect(report(findings)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* WP B3-copy: the zijpaneel (Inspector: nothing selected, a project, an event) and every tab of */
/* the onderpaneel (Dock), in Eenvoudig, with data. Log text and log names are removed first.   */
/* -------------------------------------------------------------------------------------------- */

describe('jargon test (WP B3-copy): zijpaneel and onderpaneel in Eenvoudig', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
    setLocale('nl');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('inspector (none, project, event) and every dock tab', async () => {
    const { setUiMode } = await import('@/state/ui-mode');
    const { default: Inspector } = await import('@/components/shell/Inspector');
    const { default: Dock } = await import('@/components/shell/Dock');
    setUiMode('eenvoudig');
    const project = {
      prototype: true as const,
      id: 'p1',
      name: 'bakkerij-website',
      description: '',
      type: 'unknown' as const,
      status: 'idle' as const,
      lastActivity: '',
      path: 'C:/Projecten/bakkerij-website',
      templateVersion: 'v11',
      pinned: false,
      conversationCount: 1,
      missionCount: 1,
      taskCount: 1,
      agentCount: 1,
      skills: [],
      health: { tests: { passed: 1, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 90, testsMeasured: true },
    };
    const event = {
      prototype: true as const,
      id: 'e1',
      runId: 'forge-run-1',
      timestamp: '2026-11-02 10:00:00',
      kind: 'task' as const,
      agent: 'Build Boss',
      status: 'completed' as const,
      message: 'Pagina gebouwd',
      detail: 'De startpagina staat klaar.',
    };
    const proof = {
      prototype: true as const,
      id: 'pr1',
      timestamp: '2026-11-02 10:01:00',
      claim: 'Tests geslaagd',
      agent: 'Test Boss',
      taskId: 'T-1',
      command: 'npm test',
      artifact: null,
      verdict: 'rejected' as const,
      reason: '',
    };
    const data = { ...EMPTY_DATASET, projects: [project], events: [event], proof: [proof] };
    const findings: Finding[] = [];
    for (const selection of [{ kind: 'none' as const }, { kind: 'project' as const, id: 'p1' }, { kind: 'event' as const, id: 'e1' }]) {
      const value: StoreValue = { state: buildState({ data, inspectorOpen: true, selection }), dispatch: vi.fn() };
      const { container, unmount } = render(createElement(PrototypeContext.Provider, { value }, createElement(Inspector)));
      container.querySelectorAll('details').forEach((details) => details.setAttribute('open', ''));
      findings.push(...scanCopyOnly(`inspector:${selection.kind}`, container));
      unmount();
    }
    for (const dockTab of ['activity', 'terminal', 'tests', 'events', 'proof', 'notices'] as const) {
      const value: StoreValue = { state: buildState({ data, dockOpen: true, dockTab }), dispatch: vi.fn() };
      const { container, unmount } = render(createElement(PrototypeContext.Provider, { value }, createElement(Dock)));
      findings.push(...scanCopyOnly(`dock:${dockTab}`, container));
      unmount();
    }
    expect(report(findings)).toEqual([]);
  });
});
