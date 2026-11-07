/**
 * Build flags (WP B5 part BUILD).
 *
 * `__FORGE_DIST__` is a compile-time constant that vite.config.ts always defines: `true` for the
 * distributed build (`npm run build:dist`, i.e. `vite build --mode dist`, or FORGE_DIST=1), `false`
 * for every other build, the dev server and vitest. Because it is a literal after the define,
 * Rollup folds a branch such as `IS_DIST_BUILD ? null : lazy(() => import(...))` and the dead
 * dynamic import never becomes a chunk.
 *
 * Distributed builds leave out development-only features that must never ship (A12 credential
 * inventory, B7a distribution check): today only the account-rotation screen. The owner's own
 * development build keeps every feature.
 */

declare const __FORGE_DIST__: boolean;

/** True only in the distributed (packaged) build. */
export const IS_DIST_BUILD: boolean = __FORGE_DIST__;

/** Features that exist only in the development build and are stripped from the distributed one. */
export type DevOnlyFeature = 'account-rotation';

const DEV_ONLY_FEATURES: ReadonlySet<DevOnlyFeature> = new Set<DevOnlyFeature>(['account-rotation']);

/**
 * Whether a feature is part of this build. Development-only features answer false in the
 * distributed build; `dist` is injectable so tests can check both flavours.
 */
export function isFeatureShipped(feature: DevOnlyFeature, dist: boolean = IS_DIST_BUILD): boolean {
  return !(dist && DEV_ONLY_FEATURES.has(feature));
}
