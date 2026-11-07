// Fail-closed resolver for FORGE_DIST_OUT_DIR (Lead integration of WP B5 part BUILD).
//
// `vite build --mode dist` honours FORGE_DIST_OUT_DIR together with `emptyOutDir: true`, which means Vite empties
// that folder before writing. A mistyped value (for example `..` from dashboard/) would therefore wipe an unrelated
// folder. This module accepts a target only when emptying it cannot destroy anything that is not a build output:
//   (a) it lies inside a scratch area: <project>/_scratch, <command-center>/_scratch or the OS temp folder;
//   (b) it does not exist yet; or
//   (c) it already holds only a previous Vite build (index.html plus assets/ and Vite's own .vite/ metadata).
// Anything else throws with a plain message, so the build stops before Vite touches the folder.
//
// Pure apart from the injectable `fs`, so the refusal paths are unit-tested without touching the real disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
/** dashboard/scripts -> dashboard -> command-center -> project root. */
export const DEFAULT_PROJECT_ROOT = path.resolve(here, '..', '..', '..');
export const DEFAULT_COMMAND_CENTER_ROOT = path.resolve(here, '..', '..');

/** Entries a previous Vite build may leave behind; anything else makes the folder "not ours". */
const PREVIOUS_BUILD_ENTRIES = new Set(['index.html', 'assets', '.vite']);

function isInside(parent, target) {
  const rel = path.relative(parent, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {string | undefined | null} raw the FORGE_DIST_OUT_DIR value as given
 * @param {{ projectRoot?: string, commandCenterRoot?: string, tmpDir?: string, cwd?: string,
 *           fs?: Pick<typeof fs, 'existsSync' | 'statSync' | 'readdirSync'> }} [opts]
 * @returns {string | null} the absolute folder to build into, or null when raw is empty (Vite default applies)
 */
export function resolveDistOutDir(raw, opts = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const fsx = opts.fs || fs;
  const cwd = opts.cwd || process.cwd();
  const target = path.resolve(cwd, String(raw).trim());
  const scratchRoots = [
    path.join(opts.projectRoot || DEFAULT_PROJECT_ROOT, '_scratch'),
    path.join(opts.commandCenterRoot || DEFAULT_COMMAND_CENTER_ROOT, '_scratch'),
    opts.tmpDir || os.tmpdir(),
  ];
  if (scratchRoots.some((root) => isInside(root, target))) return target;
  if (!fsx.existsSync(target)) return target;
  const st = fsx.statSync(target);
  if (!st.isDirectory()) {
    throw new Error('FORGE_DIST_OUT_DIR refused: ' + target + ' exists and is not a folder');
  }
  const entries = fsx.readdirSync(target);
  if (entries.length === 0) return target;
  const foreign = entries.filter((name) => !PREVIOUS_BUILD_ENTRIES.has(name));
  if (foreign.length === 0 && entries.includes('index.html')) return target;
  throw new Error(
    'FORGE_DIST_OUT_DIR refused: ' + target + ' is not a scratch folder and does not look like a previous Vite build ' +
      '(found: ' + (foreign.length ? foreign.slice(0, 5).join(', ') : entries.join(', ')) + '). ' +
      'The distributed build empties its output folder; point FORGE_DIST_OUT_DIR at a folder under _scratch/, ' +
      'the temp folder, a new folder, or a previous dist output.',
  );
}
