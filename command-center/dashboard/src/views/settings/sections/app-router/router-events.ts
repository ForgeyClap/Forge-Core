/**
 * router-events — lets "Account toevoegen › Claude" (Settings › Accounts) open the router's own
 * "Claude-account toevoegen" dialog, which owns the profile creation and the merge with unsaved choices.
 * The router section registers only while its config is loaded and may be saved (not while loading, after a
 * load error, or in read-only: there an added account would reset read-only and the next save would drop the
 * entries this dashboard cannot read). `canAddClaudeAccount()` says whether one listens, so the button is never
 * shown doing nothing.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** The router section listens here while it is loaded and writable. Returns an unregister function. */
export function onAddClaudeAccount(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function canAddClaudeAccount(): boolean {
  return listeners.size > 0;
}

/** Asks the mounted router section to open its add-account dialog. */
export function requestAddClaudeAccount(): void {
  for (const listener of Array.from(listeners)) listener();
}
