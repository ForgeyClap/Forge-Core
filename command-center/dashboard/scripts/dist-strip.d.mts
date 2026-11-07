// Types for dist-strip.mjs (WP B5 part BUILD).
import type { Plugin } from 'vite';

export declare const FORBIDDEN_NEEDLES: readonly string[];
export declare function isStubbedView(id: string): boolean;
export declare function isNeverShipModule(id: string): boolean;
export declare function findForbidden(text: string): string[];
export interface BundleLeak { file: string; reason: string }
export declare function auditBundle(bundle: Record<string, unknown>): BundleLeak[];
export declare function forgeDistStrip(opts: { enabled: boolean; stubPath: string }): Plugin;
