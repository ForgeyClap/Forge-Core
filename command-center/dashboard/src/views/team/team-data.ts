/**
 * team-data — the data side of the Team strip and the Team screen (WP B4).
 *
 * Two real sources, nothing else:
 *   - `GET /api/agent-dispatches?project=` (gateway/src/agent-dispatches.mjs): one row per helper
 *     dispatch; run-log rows carry `run_id`, `agent` (registry display name), `agent_slug`,
 *     `running`, `stalled` and `completed_at`. The shared parser in gateway-agent-dispatches.ts drops
 *     `run_id`, so this module reads the same payload with the run id kept.
 *   - `GET /api/runs/:id/team-chat?project=` (gateway/src/team-chat.mjs): the run's channel.
 *
 * Status per role is derived, never invented: running -> busy, open but not running -> waiting,
 * completed -> done, no dispatch in this run -> idle.
 */

import { useEffect, useState } from 'react';

import { gwGet, pickArray, pickBool, pickNumber, pickString } from '@/prototype/state/gateway-client';
import { PROJECT_DATA_POLL_MS } from '@/prototype/state/adapter/shared';

/* ------------------------------------------------------------------ roles */

/** The helper roles in PRODUCT-CARD.md order ("Rolnamen"). `lead` and `scribe` are not cards. */
export const ROLE_SLUGS = [
  'lead',
  'head-chef',
  'build-boss',
  'ui-boss',
  'test-boss',
  'verify-boss',
  'review-boss',
  'security-boss',
  'integration-boss',
  'search-boss',
  'seo-boss',
  'docs-boss',
  'skill-boss',
  'scribe',
] as const;
export type RoleSlug = (typeof ROLE_SLUGS)[number];

/** The twelve role cards on the Team screen: every helper role except the lead and the note taker. */
export const CARD_ROLES: readonly RoleSlug[] = ROLE_SLUGS.filter((slug) => slug !== 'lead' && slug !== 'scribe');

/** Two-letter stamp per role (PRODUCT-CARD.md: "Pl, Bo, Te, Co …"). */
export const ROLE_STAMPS: Readonly<Record<RoleSlug, string>> = {
  lead: 'Pr',
  'head-chef': 'Pl',
  'build-boss': 'Bo',
  'ui-boss': 'Ow', // not "On": that reads as an English word
  'test-boss': 'Te',
  'verify-boss': 'Co',
  'review-boss': 'Ei',
  'security-boss': 'Be',
  'integration-boss': 'Ko',
  'search-boss': 'Oz',
  'seo-boss': 'Vi',
  'docs-boss': 'Sc',
  'skill-boss': 'Va',
  scribe: 'No',
};

/** The English names the logs use, for the Uitgebreid secondary label. */
export const ROLE_LOG_NAMES: Readonly<Record<RoleSlug, string>> = {
  lead: 'Lead',
  'head-chef': 'Head Chef',
  'build-boss': 'Build Boss',
  'ui-boss': 'UI Boss',
  'test-boss': 'Test Boss',
  'verify-boss': 'Verify Boss',
  'review-boss': 'Review Boss',
  'security-boss': 'Security Boss',
  'integration-boss': 'Integration Boss',
  'search-boss': 'Search Boss',
  'seo-boss': 'SEO Boss',
  'docs-boss': 'Docs Boss',
  'skill-boss': 'Skill Boss',
  scribe: 'Scribe',
};

function isRoleSlug(value: string): value is RoleSlug {
  return (ROLE_SLUGS as readonly string[]).includes(value);
}

/**
 * The role for a name as the logs write it: a display name ("Build Boss"), a slug ("build-boss"),
 * any case. `null` for a name that is not one of the known roles (shown as "Een helper").
 */
export function roleFromName(name: string | null | undefined): RoleSlug | null {
  if (typeof name !== 'string') return null;
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-');
  if (slug === '') return null;
  return isRoleSlug(slug) ? slug : null;
}

/* ------------------------------------------------------------- dispatches */

export interface TeamDispatch {
  readonly runId: string | null;
  readonly role: RoleSlug | null;
  readonly agentName: string | null;
  readonly wpId: string | null;
  readonly running: boolean;
  readonly stalled: boolean;
  readonly completed: boolean;
  readonly startedAt: string | null;
}

export function parseTeamDispatches(data: Record<string, unknown>): readonly TeamDispatch[] {
  return pickArray(data, ['dispatches']).map((row) => {
    const agentName = pickString(row, ['agent']);
    const slug = pickString(row, ['agent_slug']);
    return {
      runId: pickString(row, ['run_id']),
      role: roleFromName(slug) ?? roleFromName(agentName),
      agentName,
      wpId: pickString(row, ['wp_id']),
      running: pickBool(row, ['running']) ?? false,
      stalled: pickBool(row, ['stalled']) ?? false,
      completed: (pickString(row, ['completed_at', 'ended_at']) ?? null) !== null,
      startedAt: pickString(row, ['started_at']),
    };
  });
}

export type RoleStatus = 'busy' | 'waiting' | 'done' | 'idle';

/**
 * One status per role for one run. Busy wins over waiting wins over done: a role with one running
 * dispatch is busy even when an earlier task of the same role is already done.
 */
export function roleStatuses(dispatches: readonly TeamDispatch[], runId: string | null): ReadonlyMap<RoleSlug, RoleStatus> {
  const rank: Record<RoleStatus, number> = { idle: 0, done: 1, waiting: 2, busy: 3 };
  const out = new Map<RoleSlug, RoleStatus>();
  for (const d of dispatches) {
    if (d.role === null) continue;
    if (runId !== null && d.runId !== runId) continue;
    const status: RoleStatus = d.running ? 'busy' : d.completed ? 'done' : 'waiting';
    const prev = out.get(d.role) ?? 'idle';
    if (rank[status] > rank[prev]) out.set(d.role, status);
  }
  return out;
}

/* ---------------------------------------------------------------- channel */

export type ChannelKind = 'message' | 'handoff' | 'blocker' | 'question' | 'decision';

export interface ChannelLine {
  readonly ts: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly fromRole: RoleSlug | null;
  readonly toRole: RoleSlug | null;
  readonly wpId: string | null;
  readonly kind: ChannelKind;
  /** The message without the `[X -> Y]` prefix and the `| wp=… | run=…` tail forge-say adds. */
  readonly text: string;
  readonly viaLead: boolean;
  /** A decision, or anything the lead wrote: pinned at the top of the Team screen. */
  readonly pinned: boolean;
}

const KINDS: readonly ChannelKind[] = ['message', 'handoff', 'blocker', 'question', 'decision'];
const PREFIX_RE = /^\s*\[([^\]]{1,80}?)\s*(?:->|→)\s*([^\]]{1,80}?)\]\s*/;
const TAIL_RE = /(\s*\|\s*(?:wp|run)=[^|]*)+\s*$/i;

/** Splits the `[X -> Y] text | wp=… | run=…` line shape; plain text passes through unchanged. */
export function splitLineText(raw: string): { readonly from: string | null; readonly to: string | null; readonly text: string } {
  const prefix = PREFIX_RE.exec(raw);
  const body = prefix ? raw.slice(prefix[0].length) : raw;
  return {
    from: prefix ? prefix[1].trim() : null,
    to: prefix ? prefix[2].trim() : null,
    text: body.replace(TAIL_RE, '').trim(),
  };
}

export function parseChannelLine(row: Record<string, unknown>): ChannelLine {
  const rawKind = pickString(row, ['kind']);
  const kind: ChannelKind = KINDS.includes(rawKind as ChannelKind) ? (rawKind as ChannelKind) : 'message';
  const split = splitLineText(pickString(row, ['text']) ?? '');
  const from = pickString(row, ['from']) ?? split.from;
  const to = pickString(row, ['to']) ?? split.to;
  const fromRole = roleFromName(from);
  return {
    ts: pickString(row, ['ts']),
    from,
    to,
    fromRole,
    toRole: roleFromName(to),
    wpId: pickString(row, ['wp_id']),
    kind,
    text: split.text,
    viaLead: pickString(row, ['via']) === 'lead',
    pinned: kind === 'decision' || fromRole === 'lead',
  };
}

export interface TeamChat {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly lines: readonly ChannelLine[];
  readonly total: number;
  readonly malformed: number;
  readonly truncated: boolean;
  readonly error: string | null;
}

export function parseTeamChat(data: Record<string, unknown>): Omit<TeamChat, 'status' | 'error'> {
  const lines = pickArray(data, ['lines']).map(parseChannelLine);
  return {
    lines,
    total: pickNumber(data, ['total']) ?? lines.length,
    malformed: pickNumber(data, ['malformed']) ?? 0,
    truncated: pickBool(data, ['truncated']) ?? false,
  };
}

/* ------------------------------------------------------------------ hooks */

const EMPTY_DISPATCHES: readonly TeamDispatch[] = [];

/** Polls the project's dispatches with the run id kept. Empty project: no fetch, empty list. */
export function useTeamDispatches(projectName: string): readonly TeamDispatch[] {
  const [state, setState] = useState<{ key: string; value: readonly TeamDispatch[] }>({ key: '', value: EMPTY_DISPATCHES });
  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/agent-dispatches?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parseTeamDispatches(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);
  return state.key === projectName ? state.value : EMPTY_DISPATCHES;
}

const IDLE_CHAT: TeamChat = { status: 'idle', lines: [], total: 0, malformed: 0, truncated: false, error: null };

/** Polls one run's channel. No project or no run: the idle state, nothing fetched. */
export function useTeamChat(projectName: string, runId: string | null, limit = 200): TeamChat {
  const key = `${projectName}\u0000${runId ?? ''}\u0000${limit}`;
  const [state, setState] = useState<{ key: string; value: TeamChat }>({ key: '', value: IDLE_CHAT });
  useEffect(() => {
    if (projectName === '' || runId === null || runId === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const path = `/api/runs/${encodeURIComponent(runId ?? '')}/team-chat?project=${encodeURIComponent(projectName)}&limit=${limit}`;
      const result = await gwGet(path);
      if (cancelled) return;
      setState({
        key,
        value: result.ok
          ? { status: 'ready', error: null, ...parseTeamChat(result.data) }
          : { ...IDLE_CHAT, status: 'error', error: result.error },
      });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName, runId, limit, key]);
  if (projectName === '' || runId === null || runId === '') return IDLE_CHAT;
  return state.key === key ? state.value : { ...IDLE_CHAT, status: 'loading' };
}
