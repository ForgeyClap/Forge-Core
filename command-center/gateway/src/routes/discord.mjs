// Discord bot routes (moved verbatim out of server.mjs, WP A11 part 1). Registered in server.mjs's
// ordered route table; every write route here is token-checked once in server.mjs's
// requestListener before any handler runs.
import { validateSchema } from '../body.mjs';
import {
  getDiscordStatus, startDiscordService, stopDiscordService, connectDiscordService, selectDiscordGuild,
  getProjectsDirStatus, setProjectsDirSetting,
  getDiscordStateDir,
} from '../discord-service.mjs';
import { browseFolder } from '../folder-browse.mjs';
import { readDiscordActivity } from '../discord-activity.mjs';
import { getAutostartInfo, recordDesiredState, saveWarningFor } from '../discord-autostart.mjs';
import { runDiscordOperation } from '../discord-ops.mjs';
import { sendJson, readBodyOrRespond } from './http.mjs';

export const MODULE = 'discord';

// the paths that accept a token-checked POST (requestListener's
// isDiscordWriteRoute). '/api/discord/projects-dir' also answers GET; the exec-token check is gated
// on `req.method !== 'GET'`, so a GET there is unaffected. '/api/discord/status',
// '/api/discord/browse-folder' and '/api/discord/activity' are GET-only and deliberately absent.
export const DISCORD_WRITE_PATHS = Object.freeze([
  '/api/discord/start',
  '/api/discord/stop',
  '/api/discord/connect',
  '/api/discord/guild',
  '/api/discord/projects-dir',
]);

// WP-DA: the owner's own on/off choice for the Discord bot, remembered so the bot comes back by
// itself after a restart (discord-autostart.mjs), or stays off when the owner switched it off. A failed
// save does not undo the start/stop itself (the bot really did start/stop), but it is never hidden
// (Codex stop-review DA-2): the route answers remembered:false plus a plain warning, and the status
// block carries save_error, so the caller and the dashboard both say the choice was not saved.
function rememberDiscordChoice(desired, by) {
  const saved = recordDesiredState(desired, by);
  if (!saved) {
    console.error('Forge Command Center gateway: could not save the Discord "' + desired + '" choice; the next restart uses the previous one');
  }
  return saved ? { remembered: true } : { remembered: false, warning: saveWarningFor(desired) };
}

// (feat-discord-gateway): read-only, no exec token — same shape as every other GET route.
// WP-DA: `autostart` says whether the bot comes back by itself when the Command Center starts.
export async function status(req, res) {
  const service = await getDiscordStatus();
  const autostart = await getAutostartInfo({ status: service });
  return sendJson(res, 200, { ok: true, service: { ...service, autostart } });
}

// a real write (spawns a child process). WP-DA: a successful start is the owner's own "on",
// remembered for the next restart. Codex run B F-08: start, stop, connect and the server pick each
// run as one queued Discord operation (discord-ops.mjs), together with the choice they remember, so
// two clicks (or a click and the boot autostart) can never interleave: no second bot, and the last
// click always wins.
export async function start(req, res) {
  const { result, choice } = await runDiscordOperation(async () => {
    const r = await startDiscordService();
    return { result: r, choice: r.ok ? rememberDiscordChoice('running', 'dashboard') : null };
  });
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  return sendJson(res, result.status, { ok: true, pid: result.pid, ...choice });
}

// stop is idempotent (never an error when nothing is tracked) but is still a real write.
// WP-DA: the owner's own "off" is remembered, so the bot is NOT started again on the next restart.
// (bin.mjs's crash drain calls stopDiscordService() directly and never records a choice.)
export async function stop(req, res) {
  const { result, choice } = await runDiscordOperation(async () => {
    const r = await stopDiscordService();
    return { result: r, choice: rememberDiscordChoice('stopped', 'dashboard') };
  });
  return sendJson(res, 200, { ok: true, stopped: result.stopped, ...choice });
}

// WP-v290-B (beginner onboarding, B1): the ONE beginner-facing "log in" write route — a real
// write (persists the token to discord/.env, then spawns a child).
export async function connect(req, res) {
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['token', 'guildId'], ['token']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (typeof body.token !== 'string') return sendJson(res, 400, { ok: false, error: 'token must be a string' });
  const { result, choice } = await runDiscordOperation(async () => {
    const r = await connectDiscordService({ token: body.token, guildId: body.guildId });
    return { result: r, choice: r.ok ? rememberDiscordChoice('running', 'connect') : null };
  });
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  return sendJson(res, result.status, { ok: true, pid: result.pid, ...choice });
}

// WP-v290-B (beginner onboarding, B2): the owner's explicit guild pick when the bot is in
// several servers — a real write (persists to .env, then restarts the child).
export async function guild(req, res) {
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['guildId'], ['guildId']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (typeof body.guildId !== 'string') return sendJson(res, 400, { ok: false, error: 'guildId must be a string' });
  const { result, choice } = await runDiscordOperation(async () => {
    const r = await selectDiscordGuild({ guildId: body.guildId });
    return { result: r, choice: r.ok ? rememberDiscordChoice('running', 'guild') : null };
  });
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  return sendJson(res, result.status, { ok: true, pid: result.pid, ...choice });
}

// "the user must be able to set the [Discord] project folder
// too, via the Command Center". GET is read-only (no exec token).
export async function projectsDirGet(req, res) {
  const s = getProjectsDirStatus();
  return sendJson(res, 200, {
    ok: true,
    dir: s.dir,
    source: s.source,
    exists: s.exists,
    project_count: s.projectCount,
    // Codex run B F-04: an ADDITIVE field — when true, project_count is a LOWER
    // BOUND (the scan stopped at its budget before finishing the directory), never a silently
    // wrong exact number.
    project_count_truncated: s.projectCountTruncated,
  });
}

// POST is a real write (persists to discord/.env, may restart the bot).
export async function projectsDirPost(req, res) {
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return undefined;
  const body = read.body;
  const schemaErr = validateSchema(body, ['dir', 'create'], ['dir']);
  if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
  if (typeof body.dir !== 'string') return sendJson(res, 400, { ok: false, error: 'dir must be a string' });
  if ('create' in body && typeof body.create !== 'boolean') {
    return sendJson(res, 400, { ok: false, error: 'create must be a boolean' });
  }
  // Codex run B F-08: saving the folder may stop and start the bot, so it waits its turn in the same
  // Discord operation queue as start/stop; a stop clicked meanwhile can no longer be undone by it.
  const result = await runDiscordOperation(() => setProjectsDirSetting({ dir: body.dir, create: body.create === true }));
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  return sendJson(res, result.status, {
    ok: true,
    dir: result.dir,
    restarted: result.restarted,
    restart_error: result.restartError,
    pid: result.pid,
  });
}

// the read-only folder picker behind "Change folder" — never file content, see
// folder-browse.mjs's own header for the full containment/safety reasoning. GET, no exec token.
export async function browse(req, res, { searchParams }) {
  const result = browseFolder(searchParams.get('dir'));
  return sendJson(res, result.ok ? 200 : 400, result);
}

// (Command Center audit finding 31): what the Discord bot has done, its jobs and the cost
// Claude Code recorded for them. Read-only and no exec token, same as /api/discord/status; see
// discord-activity.mjs for exactly which fields are returned and which never are.
export async function activity(req, res) {
  return sendJson(res, 200, { ok: true, activity: readDiscordActivity({ stateDir: getDiscordStateDir() }) });
}
