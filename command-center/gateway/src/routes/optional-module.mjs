// Loader for a gateway module that a distributed build may leave out on purpose (WP A11 part 1,
// review follow-up). Before this, the route that loads such a module mapped ANY
// ERR_MODULE_NOT_FOUND to "absent", so a broken import INSIDE a present module (a typo, a missing
// dependency) was silently reported as a 404 instead of a real error. Now only the module file
// itself being absent counts as "not shipped"; every other failure is logged and propagates.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Imports the module at `moduleUrl` (a file: URL). Resolves to the module namespace, or to null
 * when the module FILE does not exist. Any other failure (including ERR_MODULE_NOT_FOUND for a
 * module that the present file imports) is logged and re-thrown.
 *
 * `deps` is a test seam: `importer(url)` and `exists(path)` default to the real dynamic import and
 * fs.existsSync.
 */
export async function loadOptionalModule(moduleUrl, deps = {}) {
  const importer = deps.importer || ((url) => import(url.href));
  const exists = deps.exists || fs.existsSync;
  try {
    return await importer(moduleUrl);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && !exists(fileURLToPath(moduleUrl))) return null;
    console.error('Forge Command Center gateway: optional module ' + fileURLToPath(moduleUrl)
      + ' is present but failed to load: ' + (err && err.message ? err.message : String(err)));
    throw err;
  }
}
