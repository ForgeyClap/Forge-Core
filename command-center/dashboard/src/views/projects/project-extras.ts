/**
 * WP B5 — data for the extended Mijn projecten screen: the active project's Forge version (from
 * `GET /api/projects/:name/profile`, `canon_version` with the sync commit as fallback), the app
 * version (the desktop bridge; absent in a browser dev build), and the exact install command for a
 * folder the app cannot add by itself yet (built from `GET /api/health` → `gateway.project_root`).
 */

import { useEffect, useState } from 'react';

import { gwGet, pickRecord, pickString } from '@/prototype/state/gateway-client';
import { readDesktopBridge } from '@/views/settings/settings-model';

export interface ProjectForgeVersion {
  readonly name: string;
  /** e.g. "v11"; a short commit when only the sync commit is known; null when nothing is installed. */
  readonly version: string | null;
  readonly syncedAt: string | null;
}

export function parseProjectForgeVersion(name: string, data: Record<string, unknown>): ProjectForgeVersion {
  const canon = pickString(data, ['canon_version']);
  const commit = pickString(data, ['forge_version']);
  const version = canon ?? (commit !== null ? commit.slice(0, 7) : null);
  return { name, version, syncedAt: pickString(data, ['synced_at']) };
}

export function useProjectForgeVersion(projectName: string): ProjectForgeVersion | null {
  const [state, setState] = useState<ProjectForgeVersion | null>(null);
  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    void gwGet(`/api/projects/${encodeURIComponent(projectName)}/profile`).then((result) => {
      if (cancelled) return;
      setState(result.ok ? parseProjectForgeVersion(projectName, result.data) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectName]);
  return state !== null && state.name === projectName ? state : null;
}

export function appVersion(): string | null {
  const version = readDesktopBridge()?.version;
  return typeof version === 'string' && version.trim() !== '' ? version : null;
}

/** The folder Forge itself runs from, or null when the gateway cannot be reached. */
export function useForgeRoot(): string | null {
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void gwGet('/api/health').then((result) => {
      if (cancelled || !result.ok) return;
      const gateway = pickRecord(result.data, ['gateway']);
      setRoot(gateway !== null ? pickString(gateway, ['project_root']) : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return root;
}

/** The exact command that installs Forge into `folder` with the core Forge runs from. */
export function installCommand(forgeRoot: string, folder: string): string {
  const sep = forgeRoot.includes('\\') ? '\\' : '/';
  const base = forgeRoot.endsWith(sep) ? forgeRoot.slice(0, -1) : forgeRoot;
  return `node "${base}${sep}.claude${sep}forge-bin${sep}forge-sync.cjs" install "${folder}"`;
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

/** True when `folder` is already one of the discovered project paths. */
export function isListedFolder(folder: string, projectPaths: readonly string[]): boolean {
  const target = normalizePath(folder);
  return projectPaths.some((path) => normalizePath(path) === target);
}
