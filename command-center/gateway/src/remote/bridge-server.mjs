// Remote Bridge listener: host guard, CORS allow-list, pairing, bearer-token auth with per-IP lockout,
// per-device rate limit, the LAN write gate, JSON-only bodies (16 KB), then the narrow phone route
// table (phone-routes.mjs). It shares nothing with the main gateway's request listener: no cookies,
// no exec token, no /api/*.
import http from 'node:http';
import { readJsonBody, BodyTooLargeError, validateSchema } from '../body.mjs';
import { PHONE_ROUTES, writesAllowed } from './phone-routes.mjs';
import { pruneMap, MAX_TRACKED_IPS } from './bounded-map.mjs';

export const MAX_BODY_BYTES = 16 * 1024;
// Capacitor 6 serves the Android app from https://localhost and the iOS app from capacitor://localhost.
const CAPACITOR_ORIGINS = ['https://localhost', 'capacitor://localhost'];
const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000;
const AUTH_FAIL_LIMIT = 10;
const AUTH_LOCK_MS = 15 * 60 * 1000;

/** Per-device token buckets and per-IP auth-failure lockout. `configure` is the test seam. */
export function createLimits(cfg = {}) {
  let capacity = cfg.deviceCapacity || 60;
  let scribeCacheMs = cfg.scribeCacheMs ?? 20_000;
  const maxTrackedIps = cfg.maxTrackedIps || MAX_TRACKED_IPS;
  const refillMs = 60_000;
  let buckets = new Map();
  const authFails = new Map(); // ip -> { times, lockedUntil }
  return {
    configure(c = {}) { capacity = c.deviceCapacity || 60; scribeCacheMs = c.scribeCacheMs ?? 20_000; buckets = new Map(); },
    /** How long one project's scribe list is reused (status and inbox polling). */
    scribeCacheMs() { return scribeCacheMs; },
    /** 0 when allowed, else seconds to wait. */
    takeDevice(deviceId, now = Date.now()) {
      const b = buckets.get(deviceId) || { tokens: capacity, at: now };
      b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / refillMs) * capacity);
      b.at = now;
      buckets.set(deviceId, b);
      if (b.tokens >= 1) { b.tokens -= 1; return 0; }
      return Math.max(1, Math.ceil(((1 - b.tokens) / capacity) * refillMs / 1000));
    },
    lockedFor(ip, now = Date.now()) {
      const e = authFails.get(ip);
      return e && e.lockedUntil > now ? Math.ceil((e.lockedUntil - now) / 1000) : 0;
    },
    authFailed(ip, now = Date.now()) {
      const e = authFails.get(ip) || { times: [], lockedUntil: 0 };
      e.times = e.times.filter((t) => now - t < AUTH_FAIL_WINDOW_MS).concat(now);
      if (e.times.length >= AUTH_FAIL_LIMIT) { e.lockedUntil = now + AUTH_LOCK_MS; e.times = []; }
      authFails.delete(ip); // re-insert: the newest offender is the last one pruned
      authFails.set(ip, e);
      pruneMap(authFails, (v) => v.lockedUntil > now || v.times.some((t) => now - t < AUTH_FAIL_WINDOW_MS), maxTrackedIps);
    },
    _sizesForTests() { return { authFails: authFails.size, buckets: buckets.size }; },
  };
}

function send(res, status, obj, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(obj));
}

const errorBody = (code, error) => ({ ok: false, code, error });

function clientIp(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

function findRoute(method, pathname) {
  let pathMatched = false;
  for (const r of PHONE_ROUTES) {
    const match = typeof r.path === 'string' ? (r.path === pathname ? [pathname] : null) : pathname.match(r.path);
    if (!match) continue;
    pathMatched = true;
    if (r.method === method) return { route: r, match };
  }
  return { route: null, pathMatched };
}

function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(h.trim());
  return m ? m[1] : '';
}

/**
 * ctx: { address, port, mode: 'tailscale'|'lan', allowLanWrites, devices, pairing, audit, limits, scribeRunner, tailscaleHealth }.
 */
export function createBridgeServer(ctx) {
  const ownOrigin = 'http://' + ctx.address + ':' + ctx.port;
  const allowedOrigins = new Set([...CAPACITOR_ORIGINS, ownOrigin]);
  const allowedHosts = new Set([ctx.address + ':' + ctx.port, ctx.address]);
  ctx = { ...ctx, scribeCache: new Map() };

  async function handle(req, res) {
    const ip = clientIp(req);
    const log = (entry) => ctx.audit.write({ ip, ...entry });
    let url;
    try { url = new URL(req.url, 'http://bridge.invalid'); } catch { return send(res, 400, errorBody('invalid_request', 'bad request line')); }
    const pathname = url.pathname;

    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
      return send(res, 421, errorBody('wrong_host', 'use the bridge address from the pairing QR code'));
    }
    const origin = req.headers.origin;
    const cors = {};
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin)) {
        log({ action: 'origin_refused', status: 403, detail: { origin: String(origin).slice(0, 100), path: pathname } });
        return send(res, 403, errorBody('origin_refused', 'this origin may not call the bridge'));
      }
      cors['Access-Control-Allow-Origin'] = origin;
      cors.Vary = 'Origin';
    }
    if (req.method === 'OPTIONS') {
      if (origin === undefined || !req.headers['access-control-request-method']) return send(res, 405, errorBody('method_not_allowed', 'method not allowed'), cors);
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }

    const found = findRoute(req.method, pathname);
    if (!found.route) {
      return found.pathMatched
        ? send(res, 405, errorBody('method_not_allowed', 'method not allowed'), cors)
        : send(res, 404, errorBody('not_found', 'not found'), cors);
    }
    const route = found.route;

    const lockedS = ctx.limits.lockedFor(ip);
    if (lockedS > 0) {
      log({ action: 'locked_out', status: 429, detail: { path: pathname } });
      return send(res, 429, errorBody('locked_out', 'too many failed attempts from this address; try again later'), { ...cors, 'Retry-After': String(lockedS) });
    }

    let device = null;
    if (!route.public) {
      const token = bearer(req);
      if (!token) {
        ctx.limits.authFailed(ip);
        log({ action: 'auth_failed', status: 401, detail: { reason: 'missing token', path: pathname } });
        return send(res, 401, errorBody('auth_required', 'send Authorization: Bearer <device token>'), cors);
      }
      device = ctx.devices.authenticate(token);
      if (!device) {
        ctx.limits.authFailed(ip);
        log({ action: 'auth_failed', status: 401, detail: { reason: 'invalid or revoked token', path: pathname } });
        return send(res, 401, errorBody('auth_invalid', 'unknown or revoked device token; pair again'), cors);
      }
      const waitS = ctx.limits.takeDevice(device.id);
      if (waitS > 0) {
        log({ action: 'rate_limited', status: 429, device_id: device.id, device_name: device.name, detail: { path: pathname } });
        return send(res, 429, errorBody('rate_limited', 'too many requests from this device'), { ...cors, 'Retry-After': String(waitS) });
      }
      if (req.method === 'POST' && !writesAllowed(ctx)) {
        req.resume();
        log({ action: 'write_refused', status: 403, device_id: device.id, device_name: device.name, detail: { reason: 'lan_read_only', path: pathname } });
        return send(res, 403, errorBody('lan_read_only', 'the bridge runs in LAN mode, which is read-only because the token travels in cleartext; use Tailscale, or allow LAN writes in the dashboard'), cors);
      }
    }

    let body;
    if (req.method === 'POST') {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') {
        req.resume();
        return send(res, 415, errorBody('unsupported_media_type', 'send Content-Type: application/json'), cors);
      }
      try {
        body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
      } catch (err) {
        if (err instanceof BodyTooLargeError) return send(res, 413, errorBody('body_too_large', 'request body is larger than ' + MAX_BODY_BYTES + ' bytes'), cors);
        return send(res, 400, errorBody('invalid_request', 'invalid JSON body'), cors);
      }
      const schemaErr = validateSchema(body, route.fields || [], route.required || []);
      if (schemaErr) return send(res, 400, errorBody('invalid_request', schemaErr), cors);
    }

    const result = await route.handle({ body, match: found.match, searchParams: url.searchParams, device, ip, ctx });
    const auditEntry = result.audit || { action: 'request', detail: { method: req.method, path: pathname } };
    log({ ...auditEntry, status: result.status, device_id: device ? device.id : (auditEntry.device_id ?? null), device_name: device ? device.name : (auditEntry.device_name ?? null) });
    return send(res, result.status, result.body, { ...cors, ...(result.headers || {}) });
  }

  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
    handle(req, res).catch((err) => {
      console.error('remote bridge: request failed: ' + (err && err.stack ? err.stack : err));
      send(res, 500, errorBody('internal_error', 'internal error'));
    });
  });
  server.maxConnections = 64;
  return server;
}
