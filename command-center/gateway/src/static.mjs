// Serves the built dashboard/dist bundle (WP7a: repointed from the retired app/dist to the
// imported owner dashboard's own build output — see paths.mjs). Read-only, containment-guarded —
// the same shape as every other file-serving route in this gateway. No secrets ever live in
// dashboard/dist (it is a public static bundle by construction), but containment is still
// enforced so a crafted URL can never walk outside dashboard/dist regardless.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { containmentOk, consumePairingCode, uiSessionSetCookie } from './security.mjs';
import { APP_DIST_DIR } from './paths.mjs';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// WP10 should-fix-now #10 (AP-13): every static response — including the 400 "bad path" replies —
// carries these so the served SPA can never be framed (clickjacking a tricked click onto a
// same-origin Send/Stop button, which crossSiteOk legitimately allows since it IS same-origin) and
// is never MIME-sniffed into something it isn't.
//
// WP A8 (owner-queue / plan F10): the CSP now also governs SCRIPTS, the part WP10 left open. A script
// that runs in the page can drive every write route (since FU-STEP2 through the session cookie the page's
// own requests carry; before that through a token meta tag). Only scripts from this origin may run (`script-src 'self'`), with no 'unsafe-eval' and no
// 'unsafe-inline'. The built shell has ONE inline script of its own (Vite index.html: the pre-paint
// theme switch); it is allowed by its exact sha256, computed from the HTML actually served
// (inlineScriptHashes below), so a rebuilt shell keeps working while a script injected into the page at
// run time (DOM injection, an XSS payload) matches no hash and is refused. The hashes come from the
// built dist/index.html on disk, which is trusted exactly as much as the bundle files 'self' allows.
// `object-src 'none'` (plugins run code too) and `base-uri 'self'` (a planted <base> would re-point the
// shell's relative ./assets/ script URLs) close the two other script routes. Styles are deliberately
// not restricted here: this WP is about scripts, and Vite's own inline styles were never checked
// against a style policy.
const BASE_CSP_DIRECTIVES = ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"];

/** The CSP header value: `script-src 'self'` plus one `'sha256-…'` source per given inline-script hash. */
export function buildContentSecurityPolicy(inlineScriptSha256s = []) {
  const scriptSrc = ["script-src 'self'", ...inlineScriptSha256s.map((h) => "'sha256-" + h + "'")].join(' ');
  return [scriptSrc, ...BASE_CSP_DIRECTIVES].join('; ');
}

export const STATIC_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': buildContentSecurityPolicy(),
  'X-Content-Type-Options': 'nosniff',
};

// Every classic/module inline <script> (no src attribute) in the served HTML, hashed exactly as a browser
// hashes it for a CSP check: sha256 over the UTF-8 text between the tags, base64. A script with a src is
// already covered by 'self' and is skipped.
const SCRIPT_ELEMENT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const m of html.matchAll(SCRIPT_ELEMENT_RE)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    hashes.push(crypto.createHash('sha256').update(m[2], 'utf8').digest('base64'));
  }
  return hashes;
}

// FU-STEP2 (Security Boss Step 2, decision A-prime): the served HTML carries NO token any more. Until
// 2026-11-02 a `<meta name="cc-exec-token">` tag was spliced in here, and any local process could read
// it with one GET. The dashboard credential is now an out-of-band cookie (security.mjs UI_SESSION_COOKIE).
//
// The browser pairing swap: GET /?pair=<one-time code> sets that cookie once and redirects 302 to the
// clean URL `/`, so the code leaves the address bar and the history. A used, expired, unknown or
// malformed code gets the same redirect WITHOUT a cookie; the dashboard then shows its pairing card
// ("Koppel dit venster opnieuw"). This is the ONLY gateway response that ever carries Set-Cookie.
// requestListener calls it only for GET on exactly `/` with a `pair` parameter, after the Host and
// cross-site guards (a cross-site navigation never reaches it, so it cannot burn a code).
const PAIRING_HEADERS = Object.freeze({
  Location: '/',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Type': 'text/plain; charset=utf-8',
});

/** `{ status, headers, body }` for GET /?pair=<code>: 302 to `/`, with Set-Cookie only for a live code. */
export function servePairing(code) {
  const headers = { ...PAIRING_HEADERS, ...STATIC_SECURITY_HEADERS };
  if (consumePairingCode(code)) headers['Set-Cookie'] = uiSessionSetCookie();
  return { status: 302, headers, body: '' };
}

// Returns { status, headers, body } or null if the static bundle simply doesn't exist yet
// (honest "not built" case — the caller decides how to report that, this module never lies
// about a build that hasn't happened).
export function serveStatic(pathname) {
  if (!fs.existsSync(APP_DIST_DIR)) return null;

  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  // WP10 should-fix-now #9 (AP-4, HIGH): decodeURIComponent throws a URIError on a malformed
  // escape (e.g. a bare "/%" — no uncaughtException handler existed for this before this fix, so
  // an unguarded throw here killed the whole gateway process). A request that cannot even be
  // decoded is simply a bad path, not a crash.
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(cleanPath);
  } catch {
    return { status: 400, headers: { 'Content-Type': 'text/plain', ...STATIC_SECURITY_HEADERS }, body: 'bad path' };
  }
  const candidate = path.join(APP_DIST_DIR, decodedPath);
  if (!containmentOk(APP_DIST_DIR, candidate)) {
    return { status: 400, headers: { 'Content-Type': 'text/plain', ...STATIC_SECURITY_HEADERS }, body: 'bad path' };
  }

  let target = candidate;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // Single-view slice (no router yet): any unmatched path falls back to index.html rather
    // than a hard 404, so a future client-side route still loads the shell.
    target = path.join(APP_DIST_DIR, 'index.html');
    if (!containmentOk(APP_DIST_DIR, target) || !fs.existsSync(target)) return null;
  }

  const ext = path.extname(target).toLowerCase();
  const rawBody = fs.readFileSync(target);
  // FU-STEP2: every file, the HTML shell included, is served exactly as built (no token is spliced in).
  const body = ext === '.html' ? rawBody.toString('utf8') : rawBody;
  // WP A8: the HTML shell's CSP names the hashes of its own inline scripts; every other file gets the base policy.
  const csp = ext === '.html' ? buildContentSecurityPolicy(inlineScriptHashes(body)) : STATIC_SECURITY_HEADERS['Content-Security-Policy'];
  return {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', ...STATIC_SECURITY_HEADERS, 'Content-Security-Policy': csp },
    body,
  };
}
