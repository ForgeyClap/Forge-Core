/**
 * Redesign fix round XR-COPY1 (UI Boss): Activiteit, Controles, Discord and Theme speak Dutch, and the
 * Activiteit empty state is honest.
 *
 * - Activiteit with no events and no filter says one plain line and offers no "clear filters" button.
 * - The visible body text of each route is Dutch in the nl locale: rendered text is scanned with the
 *   same English-marker and banned-term lists as i18n-jargon.test.tsx (data values such as ids are
 *   kept free of those words in the fixtures).
 * - Every XR-COPY1 table text passes the rd.* rules (no jargon or English, at most 16 words, no "!",
 *   same placeholders in nl and en), so the locale patch can be merged without touching the guards.
 * - Dates show in the Dutch local format.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { getLocale, setLocale } from '@/i18n';
import type { Locale } from '@/i18n';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ActivityEvent, Run } from '@/prototype/types/prototype-types';

import ActivityView from '@/views/activity/ActivityView';
import { RecentRunsPanel } from '@/views/tests/RecentRunsPanel';
import { RunHealthPanel } from '@/views/tests/RunHealthPanel';
import DiscordView from '@/views/discord/DiscordView';
import BotActivitySection from '@/views/discord/BotActivitySection';
import ProjectsDirSection from '@/views/discord/ProjectsDirSection';
import ThemeShowcaseView from '@/views/theme/ThemeShowcaseView';
import { catalogTable } from './catalog-table';
import { EMPTY_FINALIZE_RECEIPT, EMPTY_GATE_EVIDENCE, EMPTY_RUN_CONTRACT } from '@/prototype/state/adapter/graph-and-proof';

/* ------------------------------------------------------------ word lists */

const JARGON_SRC = readFileSync(resolve(__dirname, 'i18n-jargon.test.tsx'), 'utf8');
function grab(name: string): string[] {
  const from = JARGON_SRC.slice(JARGON_SRC.indexOf(`const ${name} = [`));
  return [...from.slice(0, from.indexOf('] as const')).matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}
const WORDS = [...grab('BANNED_TERMS'), ...grab('ENGLISH_MARKERS')];
const WORD_RE = new RegExp(
  `(?<![\\p{L}\\d_-])(${WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\d_-])`,
  'giu',
);
const PROPER = /\b(Forge|Claude Code|Claude|Opus|Sonnet|Fable|Haiku|Discord|Codex|ChatGPT|Ollama|Ctrl|Shift|Enter|Command Center)\b/g;

/** English or jargon words found in a piece of Dutch text (placeholders and proper nouns removed). */
export function englishIn(text: string): string[] {
  const plain = text.replace(PROPER, ' ').replace(/\{\w+\}/g, ' ');
  return [...plain.matchAll(WORD_RE)].map((m) => (m[1] ?? '').toLowerCase());
}

function visibleText(root: HTMLElement): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    // Machine text (ids, paths) is data. The status badge is a shared primitive with its own owner
    // (StatusBadge.tsx, "views pass Dutch labels one wave at a time"); it is checked there, not here.
    if (parent && (parent.closest('code') || parent.closest('.fw-machine') || parent.closest('.fw-status-badge'))) continue;
    parts.push(node.textContent ?? '');
  }
  root.querySelectorAll('[aria-label]').forEach((el) => parts.push(el.getAttribute('aria-label') ?? ''));
  root.querySelectorAll('input[placeholder]').forEach((el) => parts.push(el.getAttribute('placeholder') ?? ''));
  return parts.join(' ');
}

/** Every text of a copy table passes the rd.* rules of i18n-jargon.test.tsx. */
export function tableFindings(table: { readonly nl: Readonly<Record<string, string>>; readonly en: Readonly<Record<string, string>> }): string[] {
  const bad: string[] = [];
  const holders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  for (const [key, value] of Object.entries(table.nl)) {
    for (const word of englishIn(value)) bad.push(`${key}: ${word}`);
    if (value.trim().split(/\s+/).length > 16) bad.push(`${key}: more than 16 words`);
    if (value.includes('!')) bad.push(`${key}: !`);
    if (holders(value) !== holders(table.en[key] ?? '')) bad.push(`${key}: placeholders differ`);
  }
  for (const key of Object.keys(table.en)) if (!(key in table.nl)) bad.push(`${key}: missing in nl`);
  const keys = Object.keys(table.nl);
  for (const key of keys) if (keys.some((other) => other.startsWith(`${key}.`))) bad.push(`${key}: text and group`);
  return bad;
}

/* --------------------------------------------------------------- harness */

let startLocale: Locale;
beforeEach(() => {
  startLocale = getLocale();
  act(() => setLocale('nl'));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => setLocale(startLocale));
});

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubGateway(routes: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      for (const [part, body] of Object.entries(routes)) if (url.includes(part)) return json(body);
      if (url.includes('/api/events')) return json({ events: [], truncated: false, malformed_lines: 0, next_after: 0 });
      return json({});
    }),
  );
}

function run(id: string, startedAt = '2026-11-03T13:05:00.000Z'): Run {
  return { id, projectId: 'bakkerij', goal: 'Bakkerij-site bouwen', status: 'completed', startedAt, duration: '4m', workPackageIds: [], agentIds: [] } as unknown as Run;
}

function event(id: string, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id,
    runId: 'klus-1',
    timestamp: '2026-11-03T13:06:00.000Z',
    agent: 'bouwer',
    kind: 'task',
    status: 'completed',
    message: 'Pagina gemaakt',
    detail: 'De pagina staat klaar.',
    ...over,
  } as ActivityEvent;
}

function stateFor(runs: readonly Run[], events: readonly ActivityEvent[]): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, runs: [...runs], events: [...events] },
    appearance: 'light', resolvedTheme: 'light', density: 'comfortable', reducedMotion: false,
    sidebarCollapsed: false, mobileDrawerOpen: false, inspectorOpen: false, dockOpen: false, dockTab: 'activity',
    paletteOpen: false, activeProjectId: 'bakkerij', activeConversationId: '', selection: { kind: 'none' },
    pinnedProjectIds: [], projectQuery: '', agentFilter: 'all', agentLayout: 'grouped', taskLayout: 'kanban',
    taskColumnOverrides: {}, extraMessages: {}, stream: null, claudeCodeState: 'not-connected', toasts: [],
  };
}

function withStore(state: PrototypeState, child: ReturnType<typeof createElement>) {
  const value: StoreValue = { state, dispatch: () => undefined };
  return createElement(PrototypeContext.Provider, { value }, child);
}

/* ------------------------------------------------------------- Activiteit */

describe('Activiteit: an honest empty state', () => {
  it('with no events and no filter says one plain line and shows no clear-filters button', () => {
    stubGateway();
    const { container } = render(withStore(stateFor([], []), createElement(ActivityView)));
    expect(screen.getByText('Nog geen stappen vastgelegd.')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/No events match|Geen stappen bij deze filters/);
    expect(screen.queryByRole('button', { name: /filters wissen|Clear all filters/i })).toBeNull();
  });

  it('keeps the scrolling body reachable by keyboard when the empty state has no button (axe scrollable-region-focusable)', () => {
    stubGateway();
    const { container } = render(withStore(stateFor([], []), createElement(ActivityView)));
    const body = container.querySelector('.fw-activity__body');
    expect(body?.getAttribute('tabindex')).toBe('0');
    expect(body?.getAttribute('aria-label')).toBe('Stappen van de klus');
  });

  it('with events hidden by a filter names the filter problem and offers to clear it', () => {
    stubGateway();
    render(withStore(stateFor([run('klus-1')], [event('e1')]), createElement(ActivityView)));
    fireEvent.change(screen.getByLabelText('Zoeken'), { target: { value: 'zzz' } });
    expect(screen.getByText('Geen stappen bij deze filters')).toBeInTheDocument();
    expect(screen.getByText('Er is 1 stap vastgelegd. Maak een filter ruimer of wis de zoektekst.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Alle filters wissen' }));
    expect(screen.getByText('Pagina gemaakt')).toBeInTheDocument();
  });

  it('with no events but a filter set still says the plain line, and offers the clear button', () => {
    stubGateway();
    render(withStore(stateFor([], []), createElement(ActivityView)));
    fireEvent.change(screen.getByLabelText('Zoeken'), { target: { value: 'zzz' } });
    expect(screen.getByText('Nog geen stappen vastgelegd.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alle filters wissen' })).toBeInTheDocument();
  });
});

describe('Activiteit: Dutch copy', () => {
  it('labels the filters, the switch and the count in Dutch', () => {
    stubGateway();
    render(withStore(stateFor([run('klus-1')], [event('e1'), event('e2')]), createElement(ActivityView)));
    for (const label of ['Klus', 'Zoeken', 'Helper', 'Status', 'Soort']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Per klus groeperen' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Weergave van de activiteit' }).textContent).toContain('2/2 stappen');
    expect(screen.getByRole('option', { name: 'Alle soorten' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Staat vast' })).toBeInTheDocument();
  });

  it('shows no English or jargon in the visible body text, the recovery panel included', async () => {
    stubGateway({
      '/api/recovery': {
        ok: true,
        recovery_attempts: [],
        recovery_provenance: 'LIVE',
        docdrift: { findings: [], findings_count: 3, drifted_count: 0, provenance: 'LIVE', last_check: '2026-11-03T12:00:00.000Z' },
      },
      '/api/checkpoints': { ok: true, resume_state: { available: false }, runs_with_manifest: [], provenance: 'LIVE' },
    });
    const { container } = render(withStore(stateFor([run('klus-1')], [event('e1')]), createElement(ActivityView)));
    await waitFor(() => expect(container.textContent).toContain('Herstel en controlepunten'));
    expect(englishIn(visibleText(container))).toEqual([]);
  });

  it('the recovery line reads as separate Dutch parts, not "— · —Checkpoints"', async () => {
    stubGateway();
    const { container } = render(withStore(stateFor([], []), createElement(ActivityView)));
    await waitFor(() => expect(container.textContent).toContain('Controlepunten'));
    expect(container.textContent).not.toMatch(/—\s*·\s*—/);
    expect(container.textContent).not.toMatch(/—Checkpoints|—Controlepunten/);
  });

  it('a klus without a recorded duration shows no empty "· ·" segment in its header', () => {
    stubGateway();
    const noDuration = { ...run('klus-1'), duration: '' } as Run;
    const { container } = render(withStore(stateFor([noDuration], [event('e1')]), createElement(ActivityView)));
    const meta = container.querySelector('.fw-run__head .fw-run__meta')?.textContent ?? '';
    expect(meta).not.toMatch(/·\s*·/);
    expect(meta).toContain('1 stap');
  });

  it('zero drifted rules read "geen afwijkingen", not "0 wijken af"', async () => {
    stubGateway({
      '/api/recovery': { ok: true, recovery_attempts: [], recovery_provenance: 'LIVE', docdrift: { findings: [], findings_count: 4, drifted_count: 0, provenance: 'LIVE' } },
    });
    const { container } = render(withStore(stateFor([], []), createElement(ActivityView)));
    await waitFor(() => expect(container.textContent).toContain('4 regels gecontroleerd'));
    expect(container.textContent).toContain('geen afwijkingen');
    expect(container.textContent).not.toContain('0 wijken af');
  });

  it('shows the start of a klus in the Dutch date format', () => {
    stubGateway();
    const { container } = render(withStore(stateFor([run('klus-1')], [event('e1')]), createElement(ActivityView)));
    const stamp = container.querySelector('time[datetime="2026-11-03T13:05:00.000Z"]');
    expect(stamp?.textContent).toMatch(/^3 nov\.? 2026/);
  });
});

/* ---------------------------------------------------------------- Controles */

const VERIFIED_PROOF = { available: true, pending: false, verdict: 'FINALIZED', cause: null, reverified: true, archival: false, completionProof: true, allowlisted: null };

function proofRun(id: string, startedAt: string, extra: Partial<Run> = {}): Run {
  return {
    id, projectId: 'bakkerij', goal: '', status: 'completed', startedAt, duration: '', workPackageIds: [], agentIds: [],
    prototype: false, finalized: false, proof: null, finalizeInvalidReason: null, ...extra,
  } as unknown as Run;
}

describe('Controles: Recente klussen and Gezondheid van de klus in Dutch', () => {
  it('the recent klussen table speaks Dutch, with Dutch dates and One/Many counts', () => {
    const runs = [
      proofRun('klus-a', '2026-11-03T13:05:00.000Z', { finalized: true, proof: VERIFIED_PROOF, workPackageIds: ['p1', 'p2'] }),
      proofRun('klus-b', '2026-11-02T09:00:00.000Z'),
    ];
    const { container } = render(createElement(RecentRunsPanel, { runs, tasks: [], selectedRunId: null, onSelect: () => undefined }));
    expect(screen.getByText('Recente klussen')).toBeInTheDocument();
    expect(container.textContent).toContain('2 klussen, 1 met een afrondbon.');
    expect(screen.getByRole('columnheader', { name: 'Begonnen' })).toBeInTheDocument();
    expect(screen.getByText('Afgerond (gecontroleerd)')).toBeInTheDocument();
    expect(container.textContent).toContain('0 van 2 klaar');
    expect(container.querySelector('time[datetime="2026-11-03T13:05:00.000Z"]')?.textContent).toMatch(/^3 nov\.? 2026/);
    expect(englishIn(visibleText(container))).toEqual([]);
  });

  it('one klus reads in the singular', () => {
    const { container } = render(
      createElement(RecentRunsPanel, { runs: [proofRun('klus-a', '2026-11-03T13:05:00.000Z')], tasks: [], selectedRunId: null, onSelect: () => undefined }),
    );
    expect(container.textContent).toContain('1 klus, 0 met een afrondbon.');
  });

  it('the empty table is Dutch', () => {
    const { container } = render(createElement(RecentRunsPanel, { runs: [], tasks: [], selectedRunId: null, onSelect: () => undefined }));
    expect(screen.getByText('Nog geen klussen in dit project')).toBeInTheDocument();
    expect(englishIn(visibleText(container))).toEqual([]);
  });

  it('the health panel is Dutch when nothing is recorded yet', () => {
    const { container } = render(
      createElement(RunHealthPanel, {
        runId: 'klus-a',
        extras: { reviews: [], gateEvidence: EMPTY_GATE_EVIDENCE, finalize: EMPTY_FINALIZE_RECEIPT, contract: EMPTY_RUN_CONTRACT },
      }),
    );
    expect(screen.getByText('Gezondheid van de klus')).toBeInTheDocument();
    expect(screen.getByText('Voor deze klus is nog geen beoordeling vastgelegd.')).toBeInTheDocument();
    expect(englishIn(visibleText(container))).toEqual([]);
  });

  it('the health panel is Dutch with real gates, a receipt, missing steps and a review', () => {
    const { container } = render(
      createElement(RunHealthPanel, {
        runId: 'klus-a',
        extras: {
          gateEvidence: {
            ...EMPTY_GATE_EVIDENCE, present: true, gatesTotal: 3, gatesFailed: 1, allGreen: false, generatedAt: '2026-11-03T13:10:00.000Z',
            gates: [{ name: 'typecheck', exitCode: 0, durationMs: 1200, timedOut: false }, { name: null, exitCode: 1, durationMs: 9, timedOut: true }],
          },
          finalize: { ...EMPTY_FINALIZE_RECEIPT, present: true, finalizedAt: '2026-11-03T13:20:00.000Z', digest: 'abc123', proof: VERIFIED_PROOF },
          contract: { present: true, status: 'red', missingRules: ['R-12'], note: null },
          reviews: [{ reviewId: 'r1', verdict: 'PASS_WITH_NOTES', subject: 'Pagina', agent: null, commitSha: null, completedAt: '2026-11-03T13:30:00.000Z' }],
        } as never,
      }),
    );
    expect(screen.getByText('Afgerond (gecontroleerd)')).toBeInTheDocument();
    expect(screen.getByText('Ontbrekende stap (1):')).toBeInTheDocument();
    expect(screen.getByText('Goedgekeurd met opmerkingen')).toBeInTheDocument();
    expect(screen.getByText('Niet in orde')).toBeInTheDocument();
    expect(englishIn(visibleText(container))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ Discord */

const DISCORD_SERVICE = {
  installed: true,
  running: true,
  pid: 4242,
  started_at: '2026-11-03T09:00:00.000Z',
  transport: 'discord',
  ports: { bot: 4501, manager: null },
  health: { connected: true, uptimeSec: 812, guildId: '123', projects: ['bakkerij', 'kapper'], queueDepth: { COMPLETED: 3 } },
  conflict: null,
  env_keys: [{ name: 'DISCORD_BOT_TOKEN', present: true }, { name: 'DISCORD_GUILD_ID', present: false }],
  state_dir: '.claude/forge-discord/state',
  log_file: '.claude/forge-discord/discord.log',
  setup_state: 'ready',
  guilds: [{ id: '123', name: 'Bakkerij-server' }],
};

const DISCORD_ACTIVITY = {
  ok: true,
  activity: {
    available: true,
    jobs: {
      total: 3,
      open: 1,
      by_state: { COMPLETED: 2, WAITING_FOR_CONFIRMATION: 1 },
      recent: [
        { id: 'j1', project_id: 'bakkerij', project_name: 'Bakkerij', state: 'COMPLETED', received_at: null, started_at: null, completed_at: '2026-11-03T08:00:00.000Z', duration_ms: 65000, attempts: 1, run_id: null, error: null },
      ],
    },
    cost: {
      recorded_runs: 3, runs_without_cost: 1, total_usd: 1234.5, last_7d_usd: 2.5, last_24h_usd: 0.25,
      input_tokens: 614, output_tokens: 2888, cache_read_tokens: 62478568, first_at: null, last_at: null,
      by_project: [{ project_id: 'bakkerij', project_name: 'Bakkerij', runs: 1, cost_usd: 2.5 }],
    },
    notes: [],
  },
};

const PROJECTS_DIR = { ok: true, dir: 'C:\\Users\\me\\ForgeProjects', source: 'setting', exists: true, project_count: 1 };

describe('Discord: service, bot activity and projects folder in Dutch', () => {
  it('shows the service, activity, folder, environment and health panels without English', async () => {
    stubGateway({
      '/api/discord/status': { ok: true, service: DISCORD_SERVICE },
      '/api/discord/activity': DISCORD_ACTIVITY,
      '/api/discord/projects-dir': PROJECTS_DIR,
    });
    const { container } = render(createElement(DiscordView));
    await screen.findByText('Dienst');
    await screen.findByText('Wat de bot deed');
    await waitFor(() => expect(container.textContent).toContain('1 projectmap gevonden.'));
    await waitFor(() => expect(container.textContent).toContain('1 taak'));
    expect(screen.getByText('Draait')).toBeInTheDocument();
    expect(screen.getByText('Andere map kiezen')).toBeInTheDocument();
    expect(screen.getByText('Aanwezig')).toBeInTheDocument();
    expect(screen.getByText('Verbonden met Discord')).toBeInTheDocument();
    expect(screen.getByText('Wacht op bevestiging')).toBeInTheDocument();
    expect(container.textContent).toMatch(/US\$\s1\.234,50/);
    expect(container.querySelector('time[datetime="2026-11-03T09:00:00.000Z"]')?.textContent).toMatch(/^3 nov\.? 2026/);
    expect(englishIn(visibleText(container))).toEqual([]);
  });

  it('the not-installed state is Dutch', async () => {
    stubGateway({ '/api/discord/status': { ok: true } });
    const { container } = render(createElement(DiscordView));
    await screen.findByText('De Discord-dienst is niet geïnstalleerd in dit project');
    expect(englishIn(visibleText(container))).toEqual([]);
  });

  it('a bot without activity says so in Dutch', async () => {
    stubGateway({ '/api/discord/activity': { ok: true, activity: { available: false } } });
    render(createElement(BotActivitySection));
    expect(await screen.findByText('De bot heeft nog niets gedaan')).toBeInTheDocument();
  });

  it('the folder picker is Dutch', async () => {
    stubGateway({
      '/api/discord/projects-dir': PROJECTS_DIR,
      '/api/discord/browse-folder': { ok: true, path: 'C:\\Users\\me', parent: 'C:\\Users', folders: ['ForgeProjects'], truncated: false },
    });
    render(createElement(ProjectsDirSection));
    fireEvent.click(await screen.findByRole('button', { name: 'Andere map kiezen' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('Deze map gebruiken'));
    expect(dialog.textContent).toContain('(een map omhoog)');
    expect(englishIn(visibleText(dialog))).toEqual([]);
  });
});

/* -------------------------------------------------------------------- Theme */

describe('Theme: the design reference in Dutch', () => {
  it('names every section and every use in Dutch', () => {
    const { container } = render(withStore(stateFor([], []), createElement(ThemeShowcaseView)));
    for (const name of ['Merkteken', 'Kleur', 'Letters', 'Ruimte, rondingen en diepte', 'Knoppen en status', 'Beweging']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { level: 1, name: 'Thema' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Donker' })).toBeInTheDocument();
    expect(screen.getByText('Achtergrond')).toBeInTheDocument();
    expect(englishIn(visibleText(container))).toEqual([]);
  });
});

describe('the XR-COPY1 catalog copy passes the rd.* rules', () => {
  it('Theme', () => {
    expect(tableFindings(catalogTable('rd.theme'))).toEqual([]);
  });
  it('Discord', () => {
    expect(tableFindings(catalogTable('rd.discord'))).toEqual([]);
  });
  it('Activiteit', () => {
    expect(tableFindings(catalogTable('rd.activity'))).toEqual([]);
  });
  it('Controles', () => {
    expect(tableFindings(catalogTable('rd.tests'))).toEqual([]);
  });
});
