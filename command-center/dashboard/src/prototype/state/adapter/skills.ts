/**
 * Forge Command Center — "Vaardigheden & koppelingen" slice (WP B5). Read-only.
 *
 * - Vaardigheden: `GET /api/skills?project=` (gateway/src/skills.mjs) — the project's own
 *   `.claude/skills/<slug>/SKILL.md` files (name + description). The old Settings screen only
 *   listed skill NAMES referenced by the agent roster; this reads the real skill folders.
 * - Koppelingen: `GET /api/mcp?project=` through `useGatewayMcp` (gateway-capabilities.ts) — the
 *   dormant server registry plus the per-helper grant matrix. Grouped into the three tiers of plan
 *   row B5: dormant (not switched on), limited (switched on, tier 0-2: read or sandboxed) and
 *   write-gated (switched on, tier 3: always asks first, routed through the action gate). A switched
 *   on server with no tier is put in the write-gated group: unknown risk is treated as the higher one.
 */

import { useCallback, useEffect, useState } from 'react';

import { gwGet, pickArray, pickBool, pickNumber, pickString } from '@/prototype/state/gateway-client';
import type { GatewayMcp, GatewayMcpServer } from '@/prototype/state/gateway-capabilities';
import type { LoadStatus } from './mindmaps';

/* ------------------------------------------------------------------ skills */

export interface SkillRow {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly hasSkillMd: boolean;
}

export interface SkillsList {
  readonly skills: readonly SkillRow[];
  readonly count: number;
}

export const EMPTY_SKILLS_LIST: SkillsList = { skills: [], count: 0 };

export function parseSkillsList(data: Record<string, unknown>): SkillsList {
  const skills = pickArray(data, ['skills'])
    .map((row) => {
      const slug = pickString(row, ['slug']) ?? '';
      return {
        slug,
        name: pickString(row, ['name']) ?? slug,
        description: pickString(row, ['description']),
        hasSkillMd: pickBool(row, ['has_skill_md']) ?? false,
      };
    })
    .filter((row) => row.slug !== '');
  return { skills, count: pickNumber(data, ['skills_count']) ?? skills.length };
}

export function filterSkills(skills: readonly SkillRow[], query: string): readonly SkillRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return skills;
  return skills.filter((row) => `${row.slug} ${row.name} ${row.description ?? ''}`.toLowerCase().includes(q));
}

export interface SkillsState {
  readonly status: LoadStatus;
  readonly value: SkillsList;
  readonly error: string | null;
  readonly reload: () => void;
}

/** One fetch per project (skills change rarely); `reload` asks again. */
export function useProjectSkills(projectName: string): SkillsState {
  const [slot, setSlot] = useState<{ key: string; status: LoadStatus; value: SkillsList; error: string | null }>({
    key: '', status: 'loading', value: EMPTY_SKILLS_LIST, error: null,
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    void (async () => {
      const result = await gwGet(`/api/skills?project=${encodeURIComponent(projectName)}`);
      if (cancelled) return;
      setSlot(result.ok
        ? { key: projectName, status: 'ready', value: parseSkillsList(result.data), error: null }
        : { key: projectName, status: 'error', value: EMPTY_SKILLS_LIST, error: result.error });
    })();
    return () => { cancelled = true; };
  }, [projectName, nonce]);

  if (projectName === '' || slot.key !== projectName) return { status: 'loading', value: EMPTY_SKILLS_LIST, error: null, reload };
  return { status: slot.status, value: slot.value, error: slot.error, reload };
}

/* ------------------------------------------------------------------ connection tiers */

export type ConnectionTier = 'dormant' | 'limited' | 'writeGated';
/** Display order: what is switched on first (write-gated, then limited), the dormant catalogue last. */
export const CONNECTION_TIERS: readonly ConnectionTier[] = ['writeGated', 'limited', 'dormant'];

const ACTIVE_STATUSES = new Set(['installed', 'active', 'connected']);

export function isSwitchedOn(server: GatewayMcpServer): boolean {
  return server.optedIn || ACTIVE_STATUSES.has((server.status ?? '').toLowerCase());
}

export function connectionTier(server: GatewayMcpServer): ConnectionTier {
  if (!isSwitchedOn(server)) return 'dormant';
  if (server.tier !== null && server.tier >= 0 && server.tier <= 2) return 'limited';
  return 'writeGated';
}

export interface ConnectionRow {
  readonly server: GatewayMcpServer;
  readonly tier: ConnectionTier;
  /** How many helpers the grant matrix allows to use this server. */
  readonly helperCount: number;
}

export interface ConnectionGroups {
  readonly dormant: readonly ConnectionRow[];
  readonly limited: readonly ConnectionRow[];
  readonly writeGated: readonly ConnectionRow[];
  readonly total: number;
  readonly active: number;
}

export function groupConnections(mcp: GatewayMcp): ConnectionGroups {
  const rows = mcp.servers
    .filter((server) => server.id !== '')
    .map((server) => ({
      server,
      tier: connectionTier(server),
      helperCount: mcp.bossGrants.filter((grant) => grant.allowServers.includes(server.id)).length,
    }));
  return {
    dormant: rows.filter((row) => row.tier === 'dormant'),
    limited: rows.filter((row) => row.tier === 'limited'),
    writeGated: rows.filter((row) => row.tier === 'writeGated'),
    total: rows.length,
    active: rows.filter((row) => row.tier !== 'dormant').length,
  };
}
