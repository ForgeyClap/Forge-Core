// Distributed-build stripping (WP B5 part BUILD).
//
// The account-rotation screen is development-only (A12 credential inventory row 15, B7a
// distribution check patterns F5, F6, F11 and P8). This module holds the one list of what must never
// reach a distributed dashboard build, the Vite plugin that keeps it out, and the output scan that
// scripts/check-dist-clean.mjs runs over dist/. Plain ESM with a .d.mts beside it, so vite.config.ts,
// the node script and the vitest unit test all share it.
/* global Buffer */
import path from 'node:path';

/** Never-ship text: matched case-sensitively against emitted file names and file contents. */
export const FORBIDDEN_NEEDLES = Object.freeze(['AccountRotation', 'account-rotation']);

const normalize = (id) => String(id).replace(/\\/g, '/');

/** The rotator view (any module in views/accounts/ except the stand-in) is redirected to the stand-in. */
export function isStubbedView(id) {
  const p = normalize(id).split('?')[0];
  return /\/src\/views\/accounts\//.test(p) && !/\/dist-unavailable\.tsx$/.test(p);
}

/** A source module that must never be part of a distributed chunk. */
export function isNeverShipModule(id) {
  const p = normalize(id).split('?')[0];
  return isStubbedView(p) || /\/src\/prototype\/state\/adapter\/account-rotation(\.[a-z]+)?$/.test(p);
}

/** Returns the forbidden needles found in a name or a text, in list order. */
export function findForbidden(text) {
  const s = String(text);
  return FORBIDDEN_NEEDLES.filter((n) => s.includes(n));
}

/**
 * Audits a Rollup output bundle ({fileName: chunk|asset}). Returns [{file, reason}] for every
 * forbidden file name, never-ship module id or forbidden text in code/source.
 */
export function auditBundle(bundle) {
  const leaks = [];
  for (const [fileName, out] of Object.entries(bundle)) {
    for (const n of findForbidden(fileName)) leaks.push({ file: fileName, reason: 'file name contains ' + n });
    const ids = out.type === 'chunk' ? out.moduleIds || Object.keys(out.modules || {}) : [];
    for (const id of ids) if (isNeverShipModule(id)) leaks.push({ file: fileName, reason: 'bundles never-ship module ' + path.basename(normalize(id)) });
    const body = out.type === 'chunk' ? out.code : out.source;
    const text = typeof body === 'string' ? body : body ? Buffer.from(body).toString('utf8') : '';
    for (const n of findForbidden(text)) leaks.push({ file: fileName, reason: 'content contains ' + n });
  }
  return leaks;
}

/**
 * Vite plugin. When `enabled` (distributed build only) it resolves every import of the rotator view
 * to `stubPath` and fails the build (fail closed) if anything forbidden still reaches the output.
 */
export function forgeDistStrip({ enabled, stubPath }) {
  return {
    name: 'forge-dist-strip',
    enforce: 'pre',
    apply: 'build',
    async resolveId(source, importer, options) {
      if (!enabled || !/accounts|AccountRotation/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && isStubbedView(resolved.id) ? stubPath : null;
    },
    generateBundle(_options, bundle) {
      if (!enabled) return;
      const leaks = auditBundle(bundle);
      if (leaks.length) {
        this.error('forge-dist-strip: development-only code reached the distributed build:\n' +
          leaks.map((l) => '  ' + l.file + ': ' + l.reason).join('\n'));
      }
    },
  };
}
