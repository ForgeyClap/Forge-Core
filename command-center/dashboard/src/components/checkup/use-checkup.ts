/**
 * useCheckup — runs `GET /api/checkup` on demand and remembers the last answer (WP B6).
 *
 * Shared by Settings > Diagnose and the onboarding wizard. A run that is overtaken by a newer one
 * (the user clicks Opnieuw controleren twice) never overwrites the newer answer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchCheckup } from './checkup-model';
import type { CheckupResult } from './checkup-model';

export type CheckupStatus = 'idle' | 'running' | 'done' | 'failed';

export interface CheckupController {
  readonly status: CheckupStatus;
  readonly result: CheckupResult | null;
  readonly error: string | null;
  /** Wall-clock time the last answer arrived, for "Gecontroleerd om …". */
  readonly finishedAt: Date | null;
  readonly run: () => void;
}

export function useCheckup(projectDir: string | null = null, autoRun = false): CheckupController {
  const [status, setStatus] = useState<CheckupStatus>(autoRun ? 'running' : 'idle');
  const [result, setResult] = useState<CheckupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<Date | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);

  // A new folder to check (auto-run) is "running" from the same render on, so an answer about the
  // previous folder is never shown as the answer for this one ("adjust state when a prop changes").
  const [lastDir, setLastDir] = useState(projectDir);
  if (projectDir !== lastDir) {
    setLastDir(projectDir);
    if (autoRun) setStatus('running');
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Asks the gateway; state changes only when the answer arrives. */
  const load = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    void fetchCheckup(projectDir).then((answer) => {
      if (!mounted.current || mine !== generation.current) return;
      setFinishedAt(new Date());
      if (answer.ok) {
        setResult(answer.result);
        setError(null);
        setStatus('done');
      } else {
        setError(answer.error);
        setStatus('failed');
      }
    });
  }, [projectDir]);

  const run = useCallback(() => {
    setStatus('running');
    load();
  }, [load]);

  useEffect(() => {
    if (autoRun) load();
  }, [autoRun, load]);

  return { status, result, error, finishedAt, run };
}
