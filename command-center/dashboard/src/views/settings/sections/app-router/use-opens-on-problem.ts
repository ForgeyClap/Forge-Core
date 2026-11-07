/**
 * use-opens-on-problem — the open state of a router "Meer info" (MoreInfo.tsx) that opens by itself when a
 * problem appears inside it (v1.0 fix round FX-C).
 */

import { useState } from 'react';

/**
 * Open state for a MoreInfo that opens by itself the moment `forced` turns true (an error appeared inside) and
 * then stays open until the person closes it: fixing the error never collapses the panel under the pointer, and
 * the toggle keeps working while the error is still there.
 */
export function useOpensOnProblem(forced: boolean): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(forced);
  const [seen, setSeen] = useState(forced);
  if (forced !== seen) {
    // Guarded (only when `forced` changes), so React re-renders once with the new state.
    setSeen(forced);
    if (forced) setOpen(true);
  }
  return [open, setOpen];
}
