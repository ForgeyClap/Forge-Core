// Forge gateway — effective permission mode for one turn (WP B3, plan 4.4 + finding F17).
//
// The HTTP route keeps accepting the four request modes ('execute' | 'plan' | 'accept-edits' |
// 'bypass') and stores what was asked. This pure resolver decides what a turn is actually SPAWNED
// with:
//   - no mode / 'execute'  -> 'accept-edits' (the new default: edits inside the project folder go
//                             through, every other tool asks the user through the permission card);
//   - 'plan'               -> 'plan';
//   - 'accept-edits'       -> 'accept-edits';
//   - 'bypass'             -> 'bypass' ONLY when the project folder is marked trusted
//                             (permissions/trust.mjs); otherwise 'accept-edits', reported as
//                             downgraded so the caller can log it visibly.
// Anything else falls back to 'accept-edits' (the route allowlist is the real gate; this never
// widens a mode).

export const DEFAULT_EFFECTIVE_MODE = 'accept-edits';

/**
 * @param {string|undefined|null} requestedMode
 * @param {{ trusted?: boolean }} [opts]
 * @returns {{ mode: 'plan'|'accept-edits'|'bypass', requested: string|null, downgraded: boolean, reason: string|null }}
 */
export function resolveEffectiveMode(requestedMode, { trusted = false } = {}) {
  const requested = typeof requestedMode === 'string' && requestedMode.length > 0 ? requestedMode : null;
  if (requested === 'plan') return { mode: 'plan', requested, downgraded: false, reason: null };
  if (requested === 'accept-edits') return { mode: 'accept-edits', requested, downgraded: false, reason: null };
  if (requested === 'bypass') {
    if (trusted === true) return { mode: 'bypass', requested, downgraded: false, reason: null };
    return { mode: DEFAULT_EFFECTIVE_MODE, requested, downgraded: true, reason: 'project_not_trusted' };
  }
  return { mode: DEFAULT_EFFECTIVE_MODE, requested, downgraded: false, reason: null };
}
