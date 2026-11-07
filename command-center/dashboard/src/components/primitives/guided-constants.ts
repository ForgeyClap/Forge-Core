/**
 * Constants and types shared by the guided primitives (kept out of the .tsx files so React
 * fast refresh keeps working: a component file should export components only).
 */

export type WorkStepState = 'done' | 'now' | 'todo' | 'waiting' | 'failed';

/** Every state a WorkStrip step can be in (DESIGN.md §3.2). */
export const WORK_STEP_STATES: readonly WorkStepState[] = ['done', 'now', 'todo', 'waiting', 'failed'];

/** BRAND/DESIGN: a proof card shows at most 3 check lines. */
export const PROOF_MAX_CHECKS = 3;

/** BRAND.md: below 20 px, use the mono mark (the ember is too small to read as a colour). */
export const MARK_MONO_BELOW = 20;
