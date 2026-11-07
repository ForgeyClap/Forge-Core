// Folder guard for the project picker (WP B3b): refuses folders where a writing turn could do real
// damage or where a snapshot would sweep up a whole disk — drive roots, the user's home folder and
// the folder that holds it, Desktop / Documents / Downloads themselves, Program Files, Windows,
// ProgramData and AppData. Every refusal carries a Dutch reason for the UI plus the suggestion to
// make a project folder under Documenten\Forge Projecten\<naam>.
//
// Pure path logic: nothing is created or changed. When the folder exists on this machine its real
// path (after symlinks and junctions) is checked as well, so a link to C:\Windows is refused too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FORGE_PROJECTS_FOLDER_NAME = 'Forge Projecten';

const REASONS_NL = Object.freeze({
  INVALID: 'Dit is geen geldige map. Kies een volledige map op deze computer.',
  NETWORK_PATH: 'Dit is een netwerkmap. Forge werkt alleen met mappen op deze computer.',
  DRIVE_ROOT: 'Dit is de hoofdmap van een schijf. Daar staat alles van die schijf in, dus Forge werkt daar niet.',
  WINDOWS: 'Dit is de Windows-systeemmap. Daar mag Forge niets aanpassen.',
  PROGRAM_FILES: "Dit is de map met geïnstalleerde programma's (Program Files). Daar hoort geen projectwerk.",
  PROGRAM_DATA: "Dit is ProgramData, waar programma's gedeelde gegevens bewaren. Daar hoort geen projectwerk.",
  APPDATA: "Dit is AppData, waar programma's hun instellingen en gegevens bewaren. Daar hoort geen projectwerk.",
  SYSTEM: 'Dit is een systeemmap. Daar mag Forge niets aanpassen.',
  USERS_ROOT: 'Deze map bevat de gebruikersmappen van deze computer. Kies een eigen projectmap.',
  HOME: 'Dit is je gebruikersmap. Daar staan al je persoonlijke bestanden en instellingen, dus Forge werkt daar niet direct in.',
  DESKTOP: 'Dit is je bureaublad zelf. Kies of maak een aparte map voor je project.',
  DOCUMENTS_ROOT: 'Dit is de map Documenten zelf. Kies of maak een aparte map voor je project.',
  DOWNLOADS_ROOT: 'Dit is de map Downloads zelf. Kies of maak een aparte map voor je project.',
});

export const FOLDER_GUARD_REASONS_NL = REASONS_NL;

function envGet(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asList(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v !== '');
  return typeof value === 'string' && value !== '' ? [value] : [];
}

function setup(opts) {
  const platform = opts.platform || process.platform;
  const isWin = platform === 'win32';
  const P = isWin ? path.win32 : path.posix;
  const env = opts.env || process.env;
  const home = P.resolve(opts.homeDir || os.homedir());
  const key = (p) => (isWin ? p.toLowerCase() : p);
  const known = opts.knownFolders || {};
  const oneDrives = isWin ? ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map((n) => envGet(env, n)).filter(Boolean) : [];
  const inHomes = (names) => [home, ...oneDrives].flatMap((base) => names.map((n) => P.join(base, n)));
  const folders = {
    desktop: [...asList(known.desktop), ...inHomes(['Desktop', 'Bureaublad'])],
    documents: [...asList(known.documents), ...inHomes(['Documents', 'Documenten'])],
    downloads: [...asList(known.downloads), ...inHomes(['Downloads'])],
  };
  return { platform, isWin, P, env, home, key, folders };
}

/** Folders whose whole subtree is refused: [{ code, dir }]. */
function protectedTrees(s) {
  const { P, env, home } = s;
  if (!s.isWin) {
    const system = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/usr', '/var', '/System', '/Library', '/Applications', '/private'];
    const appData = ['Library', '.config', '.local', '.cache'].map((n) => P.join(home, n));
    return [...system.map((dir) => ({ code: 'SYSTEM', dir })), ...appData.map((dir) => ({ code: 'APPDATA', dir }))];
  }
  const drive = envGet(env, 'SystemDrive') || 'C:';
  const list = (code, values) => values.filter(Boolean).map((dir) => ({ code, dir: P.resolve(dir) }));
  return [
    ...list('WINDOWS', [envGet(env, 'SystemRoot'), envGet(env, 'windir'), `${drive}\\Windows`]),
    ...list('PROGRAM_FILES', [envGet(env, 'ProgramFiles'), envGet(env, 'ProgramFiles(x86)'), envGet(env, 'ProgramW6432'), `${drive}\\Program Files`, `${drive}\\Program Files (x86)`]),
    ...list('PROGRAM_DATA', [envGet(env, 'ProgramData'), `${drive}\\ProgramData`]),
    ...list('APPDATA', [envGet(env, 'APPDATA'), envGet(env, 'LOCALAPPDATA'), P.join(home, 'AppData')]),
  ];
}

function isWithin(s, base, target) {
  const rel = s.P.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + s.P.sep) && !s.P.isAbsolute(rel));
}

/** First rule the resolved absolute path breaks, or null. */
function ruleFor(s, resolved) {
  const k = s.key(resolved);
  if (s.P.parse(resolved).root === resolved) return 'DRIVE_ROOT';
  const tree = protectedTrees(s).find(({ dir }) => isWithin(s, dir, resolved));
  if (tree) return tree.code;
  if (k === s.key(s.home)) return 'HOME';
  if (isWithin(s, resolved, s.home)) return 'USERS_ROOT';
  if (s.folders.desktop.some((d) => s.key(s.P.resolve(d)) === k)) return 'DESKTOP';
  if (s.folders.documents.some((d) => s.key(s.P.resolve(d)) === k)) return 'DOCUMENTS_ROOT';
  if (s.folders.downloads.some((d) => s.key(s.P.resolve(d)) === k)) return 'DOWNLOADS_ROOT';
  return null;
}

/** Absolute parent folder for new projects: <Documents>\Forge Projecten. */
export function forgeProjectsRoot(opts = {}) {
  const s = setup(opts);
  return s.P.join(s.folders.documents[0], FORGE_PROJECTS_FOLDER_NAME);
}

function refusal(s, code) {
  const sep = s.isWin ? '\\' : '/';
  return {
    ok: false,
    code,
    reason: REASONS_NL[code],
    suggestion: `Maak liever een nieuwe projectmap aan in Documenten${sep}${FORGE_PROJECTS_FOLDER_NAME}${sep}<naam>.`,
    suggestedParent: forgeProjectsRoot({ ...s.opts }),
  };
}

/**
 * isAllowedProjectFolder(p, opts?) -> { ok: true, path } | { ok: false, code, reason, suggestion, suggestedParent }
 * opts (all optional, for tests and for the desktop app): platform, homeDir, env,
 * knownFolders { desktop, documents, downloads } (string or string[], e.g. Electron app.getPath()).
 */
export function isAllowedProjectFolder(p, opts = {}) {
  const s = { ...setup(opts), opts };
  if (typeof p !== 'string' || p.trim() === '' || /[\u0000-\u001f\u007f]/.test(p)) return refusal(s, 'INVALID');
  const raw = p.trim();
  if (s.isWin && /^[\\/]{2}/.test(raw)) return refusal(s, 'NETWORK_PATH');
  if (!s.P.isAbsolute(raw) || (s.isWin && !/^[A-Za-z]:[\\/]/.test(raw))) return refusal(s, 'INVALID');
  const resolved = s.P.resolve(raw);
  const direct = ruleFor(s, resolved);
  if (direct) return refusal(s, direct);
  if (s.platform === process.platform) {
    let real = null;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      real = null; // the folder does not exist yet (a new project folder): the path itself was checked
    }
    if (real && real !== resolved) {
      if (s.isWin && /^[\\/]{2}/.test(real)) return refusal(s, 'NETWORK_PATH');
      const viaLink = ruleFor(s, real);
      if (viaLink) return refusal(s, viaLink);
    }
  }
  return { ok: true, path: resolved };
}
