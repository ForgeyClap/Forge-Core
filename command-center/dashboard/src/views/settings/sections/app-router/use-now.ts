/**
 * useNow — "now" for staleness and pill rules, refreshed every 30 s. Read once per tick instead of
 * `Date.now()` during render (react-hooks/purity), so a re-render never flips a state word on its own.
 */

import { useEffect, useState } from 'react';

export const NOW_TICK_MS = 30_000;

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}
