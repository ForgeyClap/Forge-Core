/**
 * useGatewayPaths — the two folders the gateway's own health report names: where Forge itself
 * lives (`gateway.project_root`) and where it keeps conversations and jobs (`gateway.data_dir`).
 * Read once per mount from `GET /api/health`; `null` when the gateway did not say (WP B6).
 */

import { useEffect, useState } from 'react';

import { gwGet, pickRecord, pickString } from '@/prototype/state/gateway-client';

export interface GatewayPaths {
  readonly projectRoot: string | null;
  readonly dataDir: string | null;
}

const NONE: GatewayPaths = { projectRoot: null, dataDir: null };

export function useGatewayPaths(): GatewayPaths {
  const [paths, setPaths] = useState<GatewayPaths>(NONE);
  useEffect(() => {
    let cancelled = false;
    void gwGet('/api/health').then((result) => {
      if (cancelled || !result.ok) return;
      const gateway = pickRecord(result.data, ['gateway']);
      setPaths({
        projectRoot: gateway ? pickString(gateway, ['project_root']) : null,
        dataDir: gateway ? pickString(gateway, ['data_dir']) : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return paths;
}
