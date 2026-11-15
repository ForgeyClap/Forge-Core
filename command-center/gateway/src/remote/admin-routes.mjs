// Loopback admin routes for the Remote Bridge, mounted in the main gateway's route table (server.mjs).
// They inherit every main-gateway guard: loopback Host, the cross-site guard and, for POST, the
// dashboard credential (checkWriteToken). Contract section 3.
import { validateSchema } from '../body.mjs';
import { safeIdOk } from '../security.mjs';
import { sendJson, readBodyOrRespond } from '../routes/http.mjs';
import { apkInfo } from './apk.mjs';
import { getRemoteStatusWithTailscale, enableRemote, disableRemote, createPairingCode, listDevices, revokeDevice } from './manager.mjs';

export const MODULE = 'remote-admin';

export const REMOTE_STATUS_PATH = '/api/remote';
export const REMOTE_ENABLE_PATH = '/api/remote/enable';
export const REMOTE_DISABLE_PATH = '/api/remote/disable';
export const REMOTE_PAIRING_PATH = '/api/remote/pairing';
export const REMOTE_DEVICES_PATH = '/api/remote/devices';
export const REMOTE_REVOKE_RE = /^\/api\/remote\/devices\/([^/]+)\/revoke$/;

/** The POST routes of this module (server.mjs's method guard lists them as write routes). */
export function isRemoteAdminWriteRoute(pathname) {
  return pathname === REMOTE_ENABLE_PATH || pathname === REMOTE_DISABLE_PATH || pathname === REMOTE_PAIRING_PATH || REMOTE_REVOKE_RE.test(pathname);
}

async function bodyOrRespond(req, res, allowed) {
  const read = await readBodyOrRespond(req, res);
  if (read.answered) return null;
  const schemaErr = validateSchema(read.body, allowed);
  if (schemaErr) { sendJson(res, 400, { ok: false, code: 'invalid_request', error: schemaErr }); return null; }
  return read.body;
}

const reply = (res, r) => sendJson(res, r.status, r.body);

export async function status(req, res) {
  // `apk` (where the phone app is on this PC) is admin-only: the phone bridge status never carries it.
  return sendJson(res, 200, { ...(await getRemoteStatusWithTailscale()), apk: apkInfo() });
}

export async function enable(req, res) {
  const body = await bodyOrRespond(req, res, ['mode', 'address', 'port', 'allow_lan_writes']);
  if (!body) return undefined;
  return reply(res, await enableRemote(body));
}

export async function disable(req, res) {
  if (!(await bodyOrRespond(req, res, []))) return undefined;
  return reply(res, await disableRemote());
}

export async function pairing(req, res) {
  if (!(await bodyOrRespond(req, res, []))) return undefined;
  return reply(res, createPairingCode());
}

export async function devices(req, res) {
  return reply(res, listDevices());
}

export async function revoke(req, res, { match }) {
  const id = match[1];
  if (!safeIdOk(id)) return sendJson(res, 400, { ok: false, code: 'invalid_request', error: 'invalid device id' });
  if (!(await bodyOrRespond(req, res, []))) return undefined;
  return reply(res, revokeDevice(id));
}
