// Where the phone app's debug build (.apk) is on this PC, for the dashboard's Telefoon section. Admin
// status route only (admin-routes.mjs), never on the phone bridge: it is a local file path.
// The mobile folder is next to the gateway in the dev layout (command-center/mobile). The packaged
// desktop app does not bundle it, so there the honest answer is { path: null, exists: false }.
import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_CENTER_DIR } from '../paths.mjs';

/** The Capacitor/Gradle debug output under the mobile folder (mobile/scripts/apk-path.mjs). */
export const APK_SEGMENTS = Object.freeze(['android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk']);

let mobileDirOverride = null;

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** `{ path, exists, size_bytes }`: an absolute path (or null without a mobile folder), and the size when built. */
export function apkInfo(mobileDir = mobileDirOverride || path.join(COMMAND_CENTER_DIR, 'mobile')) {
  if (typeof mobileDir !== 'string' || !path.isAbsolute(mobileDir) || !isDir(mobileDir)) return { path: null, exists: false, size_bytes: null };
  const file = path.join(mobileDir, ...APK_SEGMENTS);
  let stat = null;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (stat && stat.isFile()) return { path: file, exists: true, size_bytes: stat.size };
  return { path: file, exists: false, size_bytes: null };
}

export function _setMobileDirForTests(dir) { mobileDirOverride = dir || null; }
