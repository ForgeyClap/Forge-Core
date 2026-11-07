#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-doctor.cjs pure functions (leak scan, label, SPA check). Uses os.mkdtemp
 *  fixtures; the full runDoctor (which spawns node/git across a real project) is proven by a real run,
 *  not here. Never touches the real project. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
// WP-TMP-HYGIENE: this file makes ~130 mkdtemp fixtures and runs real suites; everything it and its
// children create lands in ONE private folder under the real temp dir (TEMP/TMP/TMPDIR redirected before the doctor
// is loaded), removed at exit. Only a forge-run-* folder directly under the real temp dir is ever removed.
const TMPH_REAL_TMPDIR = os.tmpdir();
const TMPH_RUN_DIR = fs.mkdtempSync(path.join(TMPH_REAL_TMPDIR, 'forge-run-fdoctor-'));
process.env.TEMP = TMPH_RUN_DIR; process.env.TMP = TMPH_RUN_DIR; process.env.TMPDIR = TMPH_RUN_DIR;
process.on('exit', () => {
  const okDir = path.dirname(path.resolve(TMPH_RUN_DIR)).toLowerCase() === path.resolve(TMPH_REAL_TMPDIR).toLowerCase() && path.basename(TMPH_RUN_DIR).startsWith('forge-run-');
  if (okDir) { try { fs.rmSync(TMPH_RUN_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* tolerated */ } }
});
const D = require('./forge-doctor.cjs');
// WP A11 part 2: the doctor is forge-doctor.cjs (composition root) + doctor/*.cjs (the checks).
// DOCTOR_ALL_SRC is every module in load order followed by the root, for the static source assertions below;
// copyDoctorInto() copies the root and its doctor/ folder, for the isolated-copy fixtures.
const DOCTOR_ALL_SRC = D.DOCTOR_MODULES.map((rel) => fs.readFileSync(path.join(__dirname, ...rel.split('/')), 'utf8')).concat(fs.readFileSync(path.join(__dirname, 'forge-doctor.cjs'), 'utf8')).join('\n');
function copyDoctorInto(destBin) {
  fs.copyFileSync(path.join(__dirname, 'forge-doctor.cjs'), path.join(destBin, 'forge-doctor.cjs'));
  fs.cpSync(path.join(__dirname, 'doctor'), path.join(destBin, 'doctor'), { recursive: true });
}
// since WP A11 part 2 a check-table row reads `key: ({ root, ... }) => call(...)`
const ROW = String.raw`\s*(?:\([^)]*\)\s*=>\s*)?`;

let pass = 0, fail = 0, skipped = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };
/** tFn(name, fn) — for assertion-style tests whose body calls assert.* directly (a thrown AssertionError is
 *  the failure, not a boolean return). Kept as a SEPARATE helper from the boolean t(name, cond) this file
 *  uses everywhere else, on purpose: every existing `t('...', someBooleanExpression)` call site keeps
 *  meaning exactly what it says, and a reader can tell at the call site which contract a given test follows.
 *  found 12 gateWatchdogHealth/printSummary tests below written as `t(name, () => {...})`
 *  — an un-invoked arrow function is always truthy, so t()'s own boolean check passed unconditionally and
 *  every assert.* inside those bodies had never actually run. tFn() actually calls fn() and only counts a
 *  pass when it returns without throwing. */
const tFn = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + (e && e.message || e)); } };
/** skip(name, reason) — a test that could not be run HERE, stated out loud with why. It is counted into the
 *  trailing tally ("N passed, M failed, K skipped") so a reader of the summary line alone can see that
 *  something was not checked. The one thing a skip must never be is silently green: an assertion that
 *  quietly stops running is worse than one that fails, because nothing in the output changes. */
const skip = (name, reason) => { skipped++; console.log('  SKIP ' + name + ' — ' + reason); };
/** synthKey(seed, n) — WP-SEC2: a deterministic, high-entropy-LOOKING value built at runtime from
 *  a hash, so the leak-scan tests below still see a "real-looking" secret (no placeholder word, no filler run)
 *  while this file itself holds no contiguous secret-shaped literal. Synthetic only — never a real credential. */
const synthKey = (seed, n) => {
  let out = '';
  for (let i = 0; out.length < n; i++) out += crypto.createHash('sha256').update(seed + ':' + i).digest('base64url');
  out = out.slice(0, n);
  if (D.STRONG_PLACEHOLDER_RE.test(out) || /X{4,}|(.)\1{6,}/i.test(out)) throw new Error('synthKey(' + seed + ') is placeholder-shaped; pick another seed');
  return out;
};
/** pinned(name, fn) — an assertion whose expected value is a property of THIS installation, not of the code
 *  under test (e.g. "this project has exactly 57 skills"). It is a genuine drift guard in the development
 *  tree and meaningless anywhere else: the published distribution deliberately omits the 9 vendored
 *  third-party skills, so the same assertion fails there for a reason that is not a defect. It runs strictly
 *  when the tree is the development tree and is visibly skipped, with the detector's own reason, when it is
 *  not. Deliberately NOT solved with a tolerance or a list of acceptable counts — a count that accepts two
 *  answers has stopped guarding drift. See D.installationProfile() — since wp17 it keys on the
 *  .claude/config/forge-dev-tree.json marker, because the distribution now ships vendored skills too. */
const makePinned = (profile) => (name, fn) => {
  if (profile.profile === 'development') { fn(); return true; }
  skip(name, 'installation-dependent assertion · ' + profile.reason);
  return false;
};
const DEV_TREE = D.installationProfile(path.resolve(__dirname, '..', '..'));
const pinned = makePinned(DEV_TREE);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-'));
const cd = path.join(ROOT, '.claude');
fs.mkdirSync(path.join(cd, 'forge-dashboard'), { recursive: true });

// --- leakScan: a REAL-looking secret is caught; fakes/placeholders/test-files are NOT (precision) ---
const REAL = 'nvapi-9x7Kq2mZ4bTvA1cReW8pLdN6sGhY3jFuIoP0aQzX5wErTyUjHkLmNbVcXsz'; // long, no FAKE, no repeats
const FAKE = 'nvapi-FAKEFAKEFAKEFAKE1234567890'; // placeholder — must NOT be flagged
fs.writeFileSync(path.join(cd, 'notes.md'), 'config note\napi key = ' + REAL + '\n');
fs.writeFileSync(path.join(cd, 'placeholder.md'), 'sample = ' + FAKE + '\n');        // placeholder -> ignored
fs.writeFileSync(path.join(cd, '.env.example'), 'NVIDIA_API_KEY=' + REAL + '\n');     // .env.example -> skipped
fs.writeFileSync(path.join(cd, 'demo.test.cjs'), 'const k="' + REAL + '";\n');        // test fixture -> skipped
fs.writeFileSync(path.join(ROOT, 'clean.txt'), 'nothing secret here\n');
const leak = D.leakScan(ROOT); // no git in temp dir -> falls back to bounded walk
t('leakScan flags a REAL-looking secret in notes.md', leak.hits.some((h) => h.file.endsWith('notes.md')));
t('leakScan hit is labeled nvidia-nvapi-key', leak.hits.some((h) => h.pattern === 'nvidia-nvapi-key'));
t('leakScan NEVER echoes the raw secret', !JSON.stringify(leak).includes(REAL) && !JSON.stringify(leak).includes(FAKE));
t('leakScan IGNORES a FAKE/placeholder secret', !leak.hits.some((h) => h.file.endsWith('placeholder.md')));
t('leakScan skips .env.example (placeholder)', !leak.hits.some((h) => h.file.endsWith('.env.example')));
t('leakScan skips *.test.cjs (test fixtures)', !leak.hits.some((h) => h.file.endsWith('demo.test.cjs')));
t('leakScan ok=false when a real hit exists', leak.ok === false);
t('leakScan used the walk fallback (no git in temp)', leak.source === 'walk');

// a fully clean fixture -> ok:true, 0 hits
const CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-clean-'));
fs.writeFileSync(path.join(CLEAN, 'readme.md'), '# hello\njust docs, no secrets\n');
const leak2 = D.leakScan(CLEAN);
t('clean fixture: leakScan ok=true', leak2.ok === true);
t('clean fixture: zero hits', leak2.hits.length === 0);

// --- VENV/VENDOR CONTAINMENT (gemeten op "aiTraining"): the WALK fallback (no git) crawled
// a Python virtualenv (12.728 files) and produced 16 false hits — all third-party library docstrings with
// `user:pass@host` URL examples (fsspec/httpx/pandas/pyarrow/urllib3) plus a hash in a torch RECORD file.
// A venv is dependency territory exactly like the already-skipped node_modules: third-party code we do not
// own and must not "leak-scan" as project source. Detection is by the definitive marker file pyvenv.cfg
// (catches ANY dir name — .venv, venv, .venv-train, …) plus the common Python cache/vendor dir names.
// Real secrets OUTSIDE the venv must still be caught — both directions proven below. ---
const VENVROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-venv-'));
const VENVSECRET = 'nvapi-' + synthKey('venv', 58); // synthetic test value (FAKE), built at runtime
fs.mkdirSync(path.join(VENVROOT, '.venv-train', 'Lib', 'site-packages', 'somelib'), { recursive: true });
fs.writeFileSync(path.join(VENVROOT, '.venv-train', 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.12\n');
fs.writeFileSync(path.join(VENVROOT, '.venv-train', 'Lib', 'site-packages', 'somelib', 'util.py'), '# docs: ftp://user:password@host/path\napi = "' + VENVSECRET + '"\n');
fs.mkdirSync(path.join(VENVROOT, '__pycache__'), { recursive: true });
fs.writeFileSync(path.join(VENVROOT, '__pycache__', 'x.py'), 'k = "' + VENVSECRET + '"\n');
fs.mkdirSync(path.join(VENVROOT, 'src'), { recursive: true });
fs.writeFileSync(path.join(VENVROOT, 'src', 'config.py'), 'key = "' + VENVSECRET + '"\n');
const leakVenv = D.leakScan(VENVROOT);
t('venv containment: a pyvenv.cfg-marked dir (any name) is NOT walked — no hits from inside the venv', !leakVenv.hits.some((h) => h.file.includes('.venv-train')));
t('venv containment: __pycache__ is NOT walked', !leakVenv.hits.some((h) => h.file.includes('__pycache__')));
t('venv containment: the SAME real-looking secret OUTSIDE the venv IS still caught (precision kept)', leakVenv.hits.some((h) => h.file.endsWith('src/config.py')) && leakVenv.ok === false);

// --- secretLabel maps sources to friendly names ---
t('secretLabel nvapi', D.secretLabel('nvapi-[A-Za-z0-9_-]+') === 'nvidia-nvapi-key');
t('secretLabel jwt', D.secretLabel('eyJ[A-Za-z0-9_-]{10,}\\.') === 'jwt');
t('secretLabel url creds', D.secretLabel('[a-z]+://[^@]+:[^@]+@') === 'url-embedded-credentials');
t('secretLabel aws', D.secretLabel('AKIA[0-9A-Z]{16}') === 'aws-access-key');

// --- spaPresent —: the retired per-project Control Center's SPA files were REMOVED. ABSENT is
// now the healthy state (ok:true); PRESENT is advisory only (an older install forge-sync hasn't cleaned
// up yet) — `ok` must stay true either way, this can never fail a doctor run. ---
const spaAbsent = D.spaPresent(ROOT); // forge-dashboard dir exists but is empty of legacy files
t('spaPresent ok=true when legacy SPA files are absent (the healthy post-2.9.0 state)', spaAbsent.ok === true && spaAbsent.present.length === 0 && spaAbsent.stale === false);
for (const f of ['server.cjs', 'index.html', 'app.js', 'lenses.js', 'graph.js', 'panels.js', 'styles.css']) fs.writeFileSync(path.join(cd, 'forge-dashboard', f), '// ' + f);
const spaStale = D.spaPresent(ROOT);
t('spaPresent ok=true even when legacy files are present (advisory, never a failure)', spaStale.ok === true);
t('spaPresent lists every legacy file still present, for the advisory message', spaStale.present.length === 7 && spaStale.present.includes('app.js') && spaStale.stale === true);

// --- rebindingGuard —: the guard moved from the retired per-project server.cjs to the Command
// Center gateway (command-center/gateway/src/security.mjs), which is its OWN separate git repo — absent
// from a plain project checkout, and that must never fail this project's doctor. ---
//
// (Codex adversarial-review finding DOCTOR-1, MEDIUM): the PRE-fix version scanned the
// WHOLE security.mjs file for marker WORDS wherever they appeared, including inside a comment — the OLD
// RG_GOOD fixture just below (kept here, renamed, as RG_MARKER_ONLY) proves the bug: hostOk/crossSiteOk
// that unconditionally `return true` still passed doctor's check, purely because a comment above them
// named the right words. The fix requires real, wired-in code — see forge-doctor.cjs's own rebindingGuard
// header comment for the exact 5-step rule. Fixture helper: writes BOTH security.mjs and server.mjs (the
// new check reads both) under a fresh temp command-center/gateway/src/.
function writeRgFixture(prefix, secContent, srvContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'command-center', 'gateway', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'command-center', 'gateway', 'src', 'security.mjs'), secContent);
  if (srvContent !== null) fs.writeFileSync(path.join(dir, 'command-center', 'gateway', 'src', 'server.mjs'), srvContent);
  return dir;
}
// A faithful mini-mirror of the REAL command-center/gateway/src/security.mjs shape: hostOk(req)'s own
// body directly references both a header-reading helper call (hostName(req)) and the LOCAL_HOSTS set;
// crossSiteOk(req) reads headers directly with no indirection. Real code, not comment prose.
const RG_REAL_SHAPE_SECURITY =
  "export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);\n" +
  "function hostName(req) {\n" +
  "  return String((req.headers && req.headers.host) || '').toLowerCase();\n" +
  "}\n" +
  "export function hostOk(req) {\n" +
  "  const h = hostName(req);\n" +
  "  return h === '' || LOCAL_HOSTS.has(h);\n" +
  "}\n" +
  "export function crossSiteOk(req) {\n" +
  "  const sfs = String((req.headers && req.headers['sec-fetch-site']) || '');\n" +
  "  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;\n" +
  "  const origin = req.headers && req.headers.origin;\n" +
  "  return !origin || origin === 'http://localhost:4100';\n" +
  "}\n";
// A faithful mini-mirror of the REAL server.mjs: imports both real names, calls both near the top of the
// function it hands to http.createServer(...), before any pathname-based routing.
const RG_REAL_SHAPE_SERVER =
  "import { hostOk, crossSiteOk } from './security.mjs';\n" +
  "export function requestListener(req, res) {\n" +
  "  const parsed = new URL(req.url, 'http://localhost');\n" +
  "  const pathname = parsed.pathname;\n" +
  "  if (!hostOk(req)) { res.writeHead(403); return res.end(); }\n" +
  "  if (!crossSiteOk(req)) { res.writeHead(403); return res.end(); }\n" +
  "  if (pathname === '/api/health') { res.writeHead(200); return res.end(); }\n" +
  "}\n" +
  "export function createServer() { return require('http').createServer(requestListener); }\n";

const RG_NO_CC = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rebind-nocc-'));
const rgNoCc = D.rebindingGuard(RG_NO_CC);
t('rebindingGuard: no command-center/ at all -> ok:true, applicable:false (never a doctor failure)', rgNoCc.ok === true && rgNoCc.applicable === false);

const RG_NO_SECURITY = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rebind-nosecurity-'));
fs.mkdirSync(path.join(RG_NO_SECURITY, 'command-center', 'gateway', 'src'), { recursive: true });
const rgNoSecurity = D.rebindingGuard(RG_NO_SECURITY);
t('rebindingGuard: command-center/ exists but security.mjs is missing -> ok:false, applicable:true (a real gap, not a false pass)', rgNoSecurity.ok === false && rgNoSecurity.applicable === true);

// DOCTOR-1's exact reported bug, kept as its own regression fixture: marker WORDS only inside comments,
// with guard functions that unconditionally `return true` — must now FAIL, not pass.
const RG_MARKER_ONLY = writeRgFixture('forge-doctor-rebind-markeronly-',
  "// DNS-rebinding guard: reject a Host header that is not localhost or 127.0.0.1\n" +
  "export function hostOk(req) { return true; }\n" +
  "// cross-site guard: check Origin / Sec-Fetch-Site before serving /api/*\n" +
  "export function crossSiteOk(req) { return true; }\n",
  "import { hostOk, crossSiteOk } from './security.mjs';\n" +
  "export function requestListener(req, res) {\n" +
  "  if (!hostOk(req)) { return; }\n" +
  "  if (!crossSiteOk(req)) { return; }\n" +
  "}\n" +
  "export function createServer() { return require('http').createServer(requestListener); }\n");
const rgMarkerOnly = D.rebindingGuard(RG_MARKER_ONLY);
t('rebindingGuard: DOCTOR-1 regression — marker WORDS only in a comment, no real header check -> ok:false (comments are stripped before matching)', rgMarkerOnly.ok === false && rgMarkerOnly.applicable === true);

const RG_GOOD = writeRgFixture('forge-doctor-rebind-good-', RG_REAL_SHAPE_SECURITY, RG_REAL_SHAPE_SERVER);
const rgGood = D.rebindingGuard(RG_GOOD);
t('rebindingGuard: the real gateway shape (real header checks, imported and called before routing) -> ok:true', rgGood.ok === true && rgGood.applicable === true && rgGood.reason === '');

// The guard functions are real and exported, but server.mjs never calls either -- imported-but-unused
// must fail, not pass (this is the second half of DOCTOR-1: "exists" must not be confused with "wired in").
const RG_NEVER_CALLED = writeRgFixture('forge-doctor-rebind-nevercalled-', RG_REAL_SHAPE_SECURITY,
  "import { hostOk, crossSiteOk } from './security.mjs';\n" +
  "export function requestListener(req, res) {\n" +
  "  const parsed = new URL(req.url, 'http://localhost');\n" +
  "  const pathname = parsed.pathname;\n" +
  "  if (pathname === '/api/health') { res.writeHead(200); return res.end(); }\n" +
  "}\n" +
  "export function createServer() { return require('http').createServer(requestListener); }\n");
const rgNeverCalled = D.rebindingGuard(RG_NEVER_CALLED);
t('rebindingGuard: real guard functions exist but server.mjs never calls either -> ok:false ("imported ... but never called")', rgNeverCalled.ok === false && rgNeverCalled.applicable === true && /never called/.test(rgNeverCalled.reason));

// Guard calls exist but only AFTER routing has already started -- still not a real "before routing" guard.
const RG_AFTER_ROUTING = writeRgFixture('forge-doctor-rebind-afterrouting-', RG_REAL_SHAPE_SECURITY,
  "import { hostOk, crossSiteOk } from './security.mjs';\n" +
  "export function requestListener(req, res) {\n" +
  "  const parsed = new URL(req.url, 'http://localhost');\n" +
  "  const pathname = parsed.pathname;\n" +
  "  if (pathname === '/api/health') { res.writeHead(200); return res.end(); }\n" +
  "  if (!hostOk(req)) { res.writeHead(403); return res.end(); }\n" +
  "  if (!crossSiteOk(req)) { res.writeHead(403); return res.end(); }\n" +
  "}\n" +
  "export function createServer() { return require('http').createServer(requestListener); }\n");
const rgAfterRouting = D.rebindingGuard(RG_AFTER_ROUTING);
t('rebindingGuard: guard is called only after routing has already begun -> ok:false', rgAfterRouting.ok === false && /after routing/.test(rgAfterRouting.reason));

const RG_BAD = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rebind-bad-'));
fs.mkdirSync(path.join(RG_BAD, 'command-center', 'gateway', 'src'), { recursive: true });
fs.writeFileSync(path.join(RG_BAD, 'command-center', 'gateway', 'src', 'security.mjs'), '// no guard here at all\nmodule.exports = {};\n');
const rgBad = D.rebindingGuard(RG_BAD);
t('rebindingGuard: a security.mjs with no real guard function at all -> ok:false, names what is missing', rgBad.ok === false && /host-vs-localhost guard NOT found/.test(rgBad.reason) && /cross-site\/origin guard NOT found/.test(rgBad.reason));

// ---------------------------------------------------------------------------------------------------------
// DOCTOR-1, round 2 (Codex adversarial-review, MEDIUM, WP-9B-SRC): round 1 (RG_MARKER_ONLY above) only
// stripped COMMENTS — a guard that unconditionally `return`s true, with the marker text hidden in a
// STRING or a REGEX LITERAL instead of a comment, still satisfied every RG_*_TOKEN_RE check. Comments
// AND string/template/regex literal content are now masked before the property-access markers
// (.headers/.origin) are checked (see rgStripForStructuralScan/rgLooksLikeHostGuardBody's own doc
// comments) — these three fixtures reproduce the finding's own reported examples almost verbatim.
// ---------------------------------------------------------------------------------------------------------
const RG_STRING_MARKER = writeRgFixture('forge-doctor-rebind-stringmarker-',
  'export function hostOk(req) { var marker = "req.headers 127.0.0.1 localhost"; return true; }\n' +
  'export function crossSiteOk(req) { var marker2 = "req.headers sec-fetch-site"; return true; }\n',
  "import { hostOk, crossSiteOk } from './security.mjs';\n" +
  "export function requestListener(req, res) {\n" +
  "  if (!hostOk(req)) { return; }\n" +
  "  if (!crossSiteOk(req)) { return; }\n" +
  "}\n" +
  "export function createServer() { return require('http').createServer(requestListener); }\n");
const rgStringMarker = D.rebindingGuard(RG_STRING_MARKER);
t('rebindingGuard: DOCTOR-1 round 2 — marker text hidden in a STRING (not a comment), guards unconditionally return true -> ok:false', rgStringMarker.ok === false && rgStringMarker.applicable === true);

const RG_REGEX_MARKER = writeRgFixture('forge-doctor-rebind-regexmarker-',
  'export function hostOk(req) { var marker = /req\\.headers 127\\.0\\.0\\.1 localhost/; return true; }\n' +
  'export function crossSiteOk(req) { var marker2 = /req\\.headers sec-fetch-site/; return true; }\n',
  "import { hostOk, crossSiteOk } from './security.mjs';\n" +
  "export function requestListener(req, res) {\n" +
  "  if (!hostOk(req)) { return; }\n" +
  "  if (!crossSiteOk(req)) { return; }\n" +
  "}\n" +
  "export function createServer() { return require('http').createServer(requestListener); }\n");
const rgRegexMarker = D.rebindingGuard(RG_REGEX_MARKER);
t('rebindingGuard: DOCTOR-1 round 2 — marker text hidden in a REGEX LITERAL, guards unconditionally return true -> ok:false', rgRegexMarker.ok === false && rgRegexMarker.applicable === true);

// The finding's third shape: "hostOk(req); crossSiteOk(req); pathname ===" as a decoy STRING sitting
// inside the real listener (server.mjs), never actually executed — security.mjs is the REAL, legitimate
// shape here, so this isolates the LISTENER-wiring half of the fix (rgFirstCallIndex/RG_ROUTING_MARKER_RE
// must never be fooled by call-shaped TEXT inside a string).
const RG_LISTENER_STRING_MARKER = writeRgFixture('forge-doctor-rebind-listenerstringmarker-', RG_REAL_SHAPE_SECURITY,
  "import { hostOk, crossSiteOk } from './security.mjs';\n" +
  "export function requestListener(req, res) {\n" +
  '  var decoy = "hostOk(req); crossSiteOk(req); pathname ===";\n' +
  "  const parsed = new URL(req.url, 'http://localhost');\n" +
  "  const pathname = parsed.pathname;\n" +
  "  if (pathname === '/api/health') { res.writeHead(200); return res.end(); }\n" +
  "}\n" +
  "export function createServer() { return require('http').createServer(requestListener); }\n");
const rgListenerStringMarker = D.rebindingGuard(RG_LISTENER_STRING_MARKER);
t('rebindingGuard: DOCTOR-1 round 2 — "hostOk(req); crossSiteOk(req); pathname ===" hidden in a STRING in the listener -> ok:false (never really called)', rgListenerStringMarker.ok === false && rgListenerStringMarker.applicable === true && /never called/.test(rgListenerStringMarker.reason));

// Precision check: the REAL gateway shape (RG_GOOD) legitimately expresses its 127.0.0.1/localhost/
// sec-fetch-site VALUES as string literals compared against real header values — round 2's fix must not
// regress this back to a false failure (this is the exact case round 1 of THIS fix accidentally broke,
// caught before shipping — see git history for the intermediate failing state).
t('rebindingGuard: round 2 fix does not regress the real gateway shape — value tokens legitimately inside strings still pass', D.rebindingGuard(RG_GOOD).ok === true);

// ---------------------------------------------------------------------------------------------------------
// rebindingGuardBehavioral (DOCTOR-1 fix, bullet 2; Lead review round 2, 2026-09-28: "judged NOT CLOSED
// twice" until wired into the real doctor report) — the BEHAVIOURAL companion: dynamically imports the
// REAL security.mjs (in a SEPARATE spawned Node process — forge-rebindguard-runner.cjs — so this stays a
// plain SYNCHRONOUS function callable directly from runDoctor()) and calls the discovered guards with
// requests that MUST be rejected/accepted.
// ---------------------------------------------------------------------------------------------------------
tFn('rebindingGuardBehavioral: not applicable when there is no command-center/ folder', () => {
  const r = D.rebindingGuardBehavioral(RG_NO_CC);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applicable, false);
});
tFn('rebindingGuardBehavioral: the REAL gateway shape — evil.example rejected, 127.0.0.1 accepted, cross-site rejected, same-site accepted -> ok:true', () => {
  const r = D.rebindingGuardBehavioral(RG_GOOD);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.applicable, true);
});

// Lead review round 2's exact requirement: a fixture whose guards always return true, with EVERY
// structural marker written as REAL, genuinely executed code (not a decoy string) — a realistic logic
// bug (the `return ok;` that should decide the outcome is dead code; a stray `return true;` always wins)
// rather than an obviously-fake guard. This must pass rebindingGuard() (the structural scan) cleanly and
// only be caught by actually calling the guard.
const RG_REALCODE_ALWAYS_TRUE_SECURITY =
  "export function hostOk(req) {\n" +
  "  var h = String((req.headers && req.headers.host) || '').toLowerCase();\n" +
  "  var ok = (h === '127.0.0.1' || h === 'localhost');\n" +
  "  return true;\n" + // BUG: should be `return ok;`
  "}\n" +
  "export function crossSiteOk(req) {\n" +
  "  var sfs = String((req.headers && req.headers['sec-fetch-site']) || '');\n" +
  "  var ok = (!sfs || sfs === 'same-origin' || sfs === 'none');\n" +
  "  return true;\n" + // BUG: should be `return ok;`
  "}\n";
const RG_REALCODE_ALWAYS_TRUE = writeRgFixture('forge-doctor-rebind-realcodealwaystrue-', RG_REALCODE_ALWAYS_TRUE_SECURITY, RG_REAL_SHAPE_SERVER);
tFn('rebindingGuardBehavioral precondition: the always-true guard with REAL-CODE structural markers (not a decoy string) PASSES the structural check', () => {
  const structural = D.rebindingGuard(RG_REALCODE_ALWAYS_TRUE);
  assert.strictEqual(structural.ok, true, JSON.stringify(structural));
});
tFn('rebindingGuardBehavioral: the always-true guard with REAL-CODE structural markers FAILS the behavioural check', () => {
  const r = D.rebindingGuardBehavioral(RG_REALCODE_ALWAYS_TRUE);
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.applicable, true);
  assert.ok(/evil\.example/.test(r.reason), r.reason);
});

// THE residual gap a decoy STRING (not real code) can also create — kept as a second, complementary
// fixture shape alongside the real-code one above.
const RG_BEHAVIORAL_GAP_SECURITY =
  "export function hostOk(req) {\n" +
  "  var touch = req.headers;\n" +
  "  var decoy = 'accepts only 127.0.0.1 or localhost';\n" +
  "  return true;\n" +
  "}\n" +
  "export function crossSiteOk(req) {\n" +
  "  var touch2 = req.headers;\n" +
  "  var decoy2 = 'rejects cross-site via sec-fetch-site';\n" +
  "  return true;\n" +
  "}\n";
const RG_BEHAVIORAL_GAP = writeRgFixture('forge-doctor-rebind-behavioralgap-', RG_BEHAVIORAL_GAP_SECURITY, RG_REAL_SHAPE_SERVER);
tFn('rebindingGuardBehavioral precondition: the always-true-with-decoy-value-string guard PASSES the structural check (proves this is a genuine residual gap, not a duplicate of an already-caught case)', () => {
  const structural = D.rebindingGuard(RG_BEHAVIORAL_GAP);
  assert.strictEqual(structural.ok, true, JSON.stringify(structural));
});
tFn('rebindingGuardBehavioral: the always-true-with-decoy-value-string guard FAILS the behavioural check (Host: evil.example is wrongly accepted)', () => {
  const r = D.rebindingGuardBehavioral(RG_BEHAVIORAL_GAP);
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.applicable, true);
  assert.ok(/evil\.example/.test(r.reason), r.reason);
});

// --- runner-failure modes: a timeout, a non-zero exit, and garbage/unparsable output must ALL be a FAIL
// with a plain reason — never a silent pass. opts.runnerFile/opts.timeoutMs are test-only overrides. ---
function writeThrowawayScript(prefix, lines) {
  const p = path.join(os.tmpdir(), prefix + '-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.cjs');
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}
tFn('rebindingGuardBehavioral: a runner that never exits is a TIMEOUT FAIL with a reason naming the timeout, never a silent pass', () => {
  const hangScript = writeThrowawayScript('forge-doctor-rgrunner-hang', [
    '// deliberately keeps the event loop alive without ever printing a verdict or exiting',
    'setInterval(() => {}, 1000);',
  ]);
  try {
    const r = D.rebindingGuardBehavioral(RG_GOOD, { runnerFile: hangScript, timeoutMs: 300 });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.applicable, true);
    assert.ok(/timeout/i.test(r.reason), r.reason);
  } finally { try { fs.unlinkSync(hangScript); } catch { /* best-effort */ } }
});
tFn('rebindingGuardBehavioral: a runner that prints garbage (not JSON) is an UNPARSABLE-OUTPUT FAIL with a reason, never a silent pass', () => {
  const garbageScript = writeThrowawayScript('forge-doctor-rgrunner-garbage', [
    "console.log('this is not json at all');",
    'process.exit(0);',
  ]);
  try {
    const r = D.rebindingGuardBehavioral(RG_GOOD, { runnerFile: garbageScript });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.applicable, true);
    assert.ok(/unparsable/i.test(r.reason), r.reason);
  } finally { try { fs.unlinkSync(garbageScript); } catch { /* best-effort */ } }
});
tFn('rebindingGuardBehavioral: a runner that exits non-zero with no verdict is a FAIL with a reason naming the exit code, never a silent pass', () => {
  const crashScript = writeThrowawayScript('forge-doctor-rgrunner-crash', [
    'process.exit(7);',
  ]);
  try {
    const r = D.rebindingGuardBehavioral(RG_GOOD, { runnerFile: crashScript });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.applicable, true);
    assert.ok(/exited 7/.test(r.reason), r.reason);
  } finally { try { fs.unlinkSync(crashScript); } catch { /* best-effort */ } }
});

// ---------------------------------------------------------------------------------------------------------
// rebindingGuardCombined (Lead review round 2) — the ONE verdict runDoctor() now reports under
// checks.rebinding_guard: ok requires BOTH the structural AND the behavioural check to pass (when
// applicable); a structural failure short-circuits (behavioral stays null, never computed twice).
// ---------------------------------------------------------------------------------------------------------
tFn('rebindingGuardCombined: not applicable (no command-center/) passes straight through, behavioral never computed', () => {
  const r = D.rebindingGuardCombined(RG_NO_CC);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applicable, false);
  assert.strictEqual(r.behavioral, null);
});
tFn('rebindingGuardCombined: a structural failure short-circuits — ok:false, behavioral stays null, reason is the structural reason', () => {
  const r = D.rebindingGuardCombined(RG_STRING_MARKER);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.applicable, true);
  assert.strictEqual(r.behavioral, null);
  assert.strictEqual(r.reason, r.structural.reason);
});
tFn('rebindingGuardCombined: the REAL gateway shape passes BOTH layers -> ok:true, with both sub-verdicts present', () => {
  const r = D.rebindingGuardCombined(RG_GOOD);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.structural.ok, true);
  assert.strictEqual(r.behavioral.ok, true);
});
tFn('rebindingGuardCombined: structural passes but behavioural fails -> overall ok:false, reason is the behavioural reason', () => {
  const r = D.rebindingGuardCombined(RG_REALCODE_ALWAYS_TRUE);
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.structural.ok, true);
  assert.strictEqual(r.behavioral.ok, false);
  assert.ok(/evil\.example/.test(r.reason), r.reason);
});

// ---------------------------------------------------------------------------------------------------------
// runDoctor() wiring (Lead review round 2): checks.rebinding_guard must be the COMBINED verdict, and a
// behavioural failure must genuinely fail the real doctor report (rep.ok), not merely the standalone
// function — proving the fix is actually load-bearing, not just present-but-uncalled again.
// ---------------------------------------------------------------------------------------------------------
tFn('runDoctor() static wiring: checks.rebinding_guard is built from rebindingGuardCombined(), not the bare structural rebindingGuard()', () => {
  const src = DOCTOR_ALL_SRC;
  assert.ok(new RegExp('rebinding_guard:' + ROW + String.raw`rebindingGuardCombined\(root\)`).test(src), 'expected runDoctor() to assign checks.rebinding_guard from rebindingGuardCombined(root)');
});
tFn('runDoctor(): the real gateway shape -> checks.rebinding_guard.ok:true, carrying both structural and behavioral sub-verdicts', () => {
  const rep = D.runDoctor(RG_GOOD);
  assert.strictEqual(rep.checks.rebinding_guard.ok, true, JSON.stringify(rep.checks.rebinding_guard));
  assert.strictEqual(rep.checks.rebinding_guard.applicable, true);
  assert.ok(rep.checks.rebinding_guard.structural && rep.checks.rebinding_guard.behavioral, 'expected both sub-verdicts on the report');
});
tFn('runDoctor(): the always-true-with-real-code-markers guard genuinely fails checks.rebinding_guard (and therefore the overall report), not just the standalone function', () => {
  const rep = D.runDoctor(RG_REALCODE_ALWAYS_TRUE);
  assert.strictEqual(rep.checks.rebinding_guard.ok, false, JSON.stringify(rep.checks.rebinding_guard));
  assert.strictEqual(rep.ok, false, 'a failing rebinding_guard must drag the overall doctor verdict down, exactly like every other checks.* entry');
  assert.ok(/evil\.example/.test(rep.checks.rebinding_guard.reason), rep.checks.rebinding_guard.reason);
});

// --- commandCenterLocation — purely informational, ok:true in every branch. opts.homeDir
// is a test-only override so these never touch the real, live home directory. ---
const CCL_NONE_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ccl-none-project-'));
const CCL_NONE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ccl-none-home-'));
const cclNone = D.commandCenterLocation(CCL_NONE_PROJECT, { homeDir: CCL_NONE_HOME });
t('commandCenterLocation: neither project-local nor central -> ok:true, location:not-installed (the ordinary case)', cclNone.ok === true && cclNone.location === 'not-installed' && cclNone.path === null);

const CCL_LOCAL_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ccl-local-project-'));
fs.mkdirSync(path.join(CCL_LOCAL_PROJECT, 'command-center', 'gateway'), { recursive: true });
fs.writeFileSync(path.join(CCL_LOCAL_PROJECT, 'command-center', 'gateway', 'bin.mjs'), '// fixture');
const cclLocal = D.commandCenterLocation(CCL_LOCAL_PROJECT, { homeDir: CCL_NONE_HOME });
t('commandCenterLocation: a project-local command-center/gateway/bin.mjs -> ok:true, location:project-local', cclLocal.ok === true && cclLocal.location === 'project-local' && cclLocal.path === path.join(CCL_LOCAL_PROJECT, 'command-center'));

const CCL_CENTRAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ccl-central-home-'));
fs.mkdirSync(path.join(CCL_CENTRAL_HOME, '.claude', 'forge', 'template', 'command-center', 'gateway'), { recursive: true });
fs.writeFileSync(path.join(CCL_CENTRAL_HOME, '.claude', 'forge', 'template', 'command-center', 'gateway', 'bin.mjs'), '// fixture');
const cclCentral = D.commandCenterLocation(CCL_NONE_PROJECT, { homeDir: CCL_CENTRAL_HOME });
t('commandCenterLocation: no project-local one, but a central template copy exists -> ok:true, location:central', cclCentral.ok === true && cclCentral.location === 'central');

const cclBoth = D.commandCenterLocation(CCL_LOCAL_PROJECT, { homeDir: CCL_CENTRAL_HOME });
t('commandCenterLocation: project-local takes priority when BOTH exist', cclBoth.location === 'project-local');

// =====================================================================================================
// 2026-07-14 honesty-hardening fixes: (1) a suite with 0 real assertions is REJECTED, (2) a forge-bin
// dir with 0 scripts/suites is REJECTED ("no evidence"), (3) --json emits exactly one parseable JSON
// object matching the fixed contract keys, (4) a timed-out suite is labeled blocked, not failed.
// =====================================================================================================

// --- FIX 1 + FIX 2: nodeCheckAll must reject zero-evidence instead of silently passing ---
const NC_MISSING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nc-missing-')); // no .claude at all
const ncMissing = D.nodeCheckAll(NC_MISSING);
t('nodeCheckAll: both dirs missing -> ok=false', ncMissing.ok === false && ncMissing.total === 0);
t('nodeCheckAll: both dirs missing -> reason names it', /both missing/.test(ncMissing.reason));

const NC_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nc-empty-'));
fs.mkdirSync(path.join(NC_EMPTY, '.claude', 'forge-bin'), { recursive: true });
fs.mkdirSync(path.join(NC_EMPTY, '.claude', 'forge-dashboard'), { recursive: true });
const ncEmpty = D.nodeCheckAll(NC_EMPTY);
t('nodeCheckAll: dirs present but 0 files -> ok=false ("no evidence", not a silent pass)', ncEmpty.ok === false && ncEmpty.total === 0);
t('nodeCheckAll: 0-file reason distinguishes "present but empty" from "both missing"', /present but empty/.test(ncEmpty.reason));

const NC_REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nc-real-'));
fs.mkdirSync(path.join(NC_REAL, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(NC_REAL, '.claude', 'forge-bin', 'good.cjs'), "'use strict';\nmodule.exports = {};\n");
const ncReal = D.nodeCheckAll(NC_REAL);
t('nodeCheckAll: a real parseable file -> ok=true, total=1, failed=0', ncReal.ok === true && ncReal.total === 1 && ncReal.failed === 0);
fs.writeFileSync(path.join(NC_REAL, '.claude', 'forge-bin', 'bad.cjs'), "function( {\n"); // invalid syntax
const ncBad = D.nodeCheckAll(NC_REAL);
t('nodeCheckAll: a syntax error is still caught (existing behavior preserved)', ncBad.ok === false && ncBad.failed === 1 && ncBad.total === 2);

// --- WP-SPD-B: .cjs files parse in-process; only a file the in-process parse rejects is spawned, and
//     the reported failure is the REAL `node --check` result with its exact error text. Parity is proven both on a
//     set of tricky shapes and over the whole real tree. ---
{
  const { spawnSync: spawnSyncB } = require('child_process');
  const spawnCheck = (f) => spawnSyncB(process.execPath, ['--check', f], { encoding: 'utf8' });
  t('WP-SPD-B: a file that parses costs no spawn (spawned=0)', ncReal.spawned === 0, JSON.stringify(ncReal));
  t('WP-SPD-B: a file the in-process parse rejects is re-checked by a real spawn (spawned=1)', ncBad.spawned === 1, JSON.stringify(ncBad));
  const badFile = path.join(NC_REAL, '.claude', 'forge-bin', 'bad.cjs');
  const spawnedBad = spawnCheck(badFile);
  t('WP-SPD-B: the reported error text is exactly the first stderr line of `node --check` (unchanged reporting)',
    ncBad.failures.length === 1 && ncBad.failures[0].file === path.join('.claude', 'forge-bin', 'bad.cjs') && ncBad.failures[0].error === (spawnedBad.stderr || '').split('\n')[0] && spawnedBad.status !== 0,
    JSON.stringify(ncBad.failures));
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-spdb-parity-'));
  const shapes = {
    plain: "'use strict';\nmodule.exports = {};\n",
    shebang: '#!/usr/bin/env node\n\'use strict\';\nmodule.exports = 1;\n',
    bom: '﻿\'use strict\';\nmodule.exports = 1;\n',
    bomThenShebang: '﻿#!/usr/bin/env node\nmodule.exports = 1;\n',
    lateShebang: '\n#!/usr/bin/env node\n',
    topLevelReturn: 'if (true) return;\nmodule.exports = 1;\n',
    wrapperEscape: '}); (function () {\n',
    syntaxError: 'function( {\n',
    importStatement: "import fs from 'fs';\n",
    exportStatement: 'export default 1;\n',
    topLevelAwait: 'await Promise.resolve(1);\n',
    importMeta: 'console.log(import.meta.url);\n',
    dynamicImport: "import('fs').then(() => {});\n",
    unterminatedString: "const s = 'abc;\n",
    htmlComment: '<!-- hi\nmodule.exports = 1;\n',
    newTarget: 'const x = new.target;\n',
    argumentsAtTop: 'console.log(arguments.length);\n',
    strictDuplicateLet: "'use strict';\nlet a = 1; let a = 2;\n",
    strictOctal: "'use strict';\nconst n = 010;\n",
    strictWith: "'use strict';\nwith (Math) {}\n",
    innerFunctionError: 'function f () { return 1 +; }\n',
    nestedRedeclare: 'function f () { function g () { let a; let a; } }\n',
    badRegex: 'const r = /(/;\n',
    superAtTop: 'super.x();\n',
    awaitAsIdentifier: 'var await = 1;\n',
  };
  const shapeDiffs = [];
  for (const [name, src] of Object.entries(shapes)) {
    const f = path.join(SB, name + '.cjs');
    fs.writeFileSync(f, src);
    const inProc = D.syntaxCheckInProcess(f).ok;
    const real = spawnCheck(f).status === 0;
    if (inProc !== real) shapeDiffs.push(name + ' inProcess=' + inProc + ' nodeCheck=' + real);
  }
  t('WP-SPD-B parity: the in-process parse agrees with `node --check` on ' + Object.keys(shapes).length + ' tricky shapes (BOM, #!, wrapper escape, ESM syntax, strict-mode errors, lazy inner errors)', shapeDiffs.length === 0, shapeDiffs.join('; '));
  t('WP-SPD-B parity: a wrapper-escape file (closing the module wrapper early) is NOT accepted in-process', D.syntaxCheckInProcess(path.join(SB, 'wrapperEscape.cjs')).ok === false);
  // Whole-tree parity: every file nodeCheckAll covers in THIS project, checked by both routes. The real spawns run
  // 8 at a time in one throwaway child so this stays a few seconds, not one spawn after another.
  const REAL_TREE = path.resolve(__dirname, '..', '..');
  const treeFiles = [
    // nodeCheckAll walks forge-bin's sub-folders too (never node_modules), so this list does as well.
    ...fs.readdirSync(path.join(REAL_TREE, '.claude', 'forge-bin'), { recursive: true }).map(String)
      .filter((n) => n.endsWith('.cjs') && !n.split(/[\\/]/).includes('node_modules')).map((n) => path.join(REAL_TREE, '.claude', 'forge-bin', n)),
    ...(fs.existsSync(path.join(REAL_TREE, '.claude', 'forge-dashboard')) ? fs.readdirSync(path.join(REAL_TREE, '.claude', 'forge-dashboard')).filter((n) => n.endsWith('.cjs')).map((n) => path.join(REAL_TREE, '.claude', 'forge-dashboard', n)) : []),
  ];
  const parityRunner = path.join(SB, 'parity-runner.cjs');
  fs.writeFileSync(parityRunner, [
    "const { spawn } = require('child_process');",
    "const files = JSON.parse(require('fs').readFileSync(0, 'utf8'));",
    'const out = {}; let next = 0, running = 0, done = 0;',
    'const go = () => { while (running < 8 && next < files.length) { const f = files[next++]; running++;',
    "  const c = spawn(process.execPath, ['--check', f], { stdio: 'ignore', windowsHide: true });",
    "  c.on('close', (code) => { out[f] = code; running--; done++; if (done === files.length) process.stdout.write(JSON.stringify(out)); else go(); }); } };",
    'go();',
  ].join('\n'));
  const pr = spawnSyncB(process.execPath, [parityRunner], { input: JSON.stringify(treeFiles), encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  let spawnVerdicts = null; try { spawnVerdicts = JSON.parse(pr.stdout); } catch { spawnVerdicts = null; }
  const treeDiffs = [];
  if (spawnVerdicts) {
    for (const f of treeFiles) {
      const inProc = D.syntaxCheckInProcess(f).ok;
      const real = spawnVerdicts[f] === 0;
      if (inProc !== real) treeDiffs.push(path.basename(f) + ' inProcess=' + inProc + ' nodeCheck=' + real);
    }
  }
  t('WP-SPD-B parity: whole real tree (' + treeFiles.length + ' .cjs files) — in-process verdict equals `node --check` for every file',
    !!spawnVerdicts && treeFiles.length > 100 && Object.keys(spawnVerdicts).length === treeFiles.length && treeDiffs.length === 0,
    spawnVerdicts ? treeDiffs.join('; ') : ('parity runner gave no verdicts: status ' + pr.status + ' ' + String(pr.stderr || '').slice(0, 300)));
  const realNc = D.nodeCheckAll(REAL_TREE);
  const dashJs = fs.existsSync(path.join(REAL_TREE, '.claude', 'forge-dashboard')) ? fs.readdirSync(path.join(REAL_TREE, '.claude', 'forge-dashboard')).filter((n) => n.endsWith('.js')).length : 0;
  const notInProc = treeFiles.filter((f) => !D.syntaxCheckInProcess(f).ok).length;
  t('WP-SPD-B: nodeCheckAll on the real tree checks every file and spawns only for .js files and .cjs files the in-process parse did not accept',
    realNc.total === treeFiles.length + dashJs && realNc.spawned === notInProc + dashJs,
    JSON.stringify({ total: realNc.total, spawned: realNc.spawned, failed: realNc.failed, cjs: treeFiles.length, dashJs }));
}

// --- FIX 1 + FIX 2 + FIX 4: runTests must reject a vacuous "0 passed, 0 failed" suite, reject 0 suites
//     found, and label a timed-out suite as blocked (not failed) ---
const RT_VACUOUS = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-vacuous-'));
fs.mkdirSync(path.join(RT_VACUOUS, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_VACUOUS, '.claude', 'forge-bin', 'vacuous.test.cjs'), "console.log('0 passed, 0 failed');\nprocess.exit(0);\n");
const rtVacuous = D.runTests(RT_VACUOUS);
t('runTests: a suite reporting a ZERO/ZERO tally is REJECTED (suiteOk=false)', rtVacuous.perSuite[0].ok === false);
t('runTests: vacuous suite counts as a real suite failure, not a pass', rtVacuous.suitesFailed === 1 && rtVacuous.ok === false);
t('runTests: vacuous suite is not mistaken for a timeout', rtVacuous.perSuite[0].timedOut === false);

const RT_REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-real-'));
fs.mkdirSync(path.join(RT_REAL, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_REAL, '.claude', 'forge-bin', 'real.test.cjs'), "console.log('3 passed, 0 failed');\nprocess.exit(0);\n");
const rtReal = D.runTests(RT_REAL);
t('runTests: a suite with p>0 f=0 exit0 is ACCEPTED', rtReal.perSuite[0].ok === true && rtReal.ok === true && rtReal.passed === 3);

// (found by the Test Boss on the published): each suite runs with the ROOT being checked as its
// working folder, so `--root <dir>` from another folder gives the same result as running inside the project.
const RT_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-cwd-'));
fs.mkdirSync(path.join(RT_CWD, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_CWD, '.claude', 'forge-bin', 'cwd.test.cjs'),
  "const fs = require('fs'); const path = require('path');\n" +
  "const want = fs.realpathSync(path.join(__dirname, '..', '..')); const got = fs.realpathSync(process.cwd());\n" +
  "if (want.toLowerCase() === got.toLowerCase()) { console.log('1 passed, 0 failed'); process.exit(0); }\n" +
  "console.log('  FAIL cwd is ' + got + ', not the root ' + want); console.log('0 passed, 1 failed'); process.exit(1);\n");
t('runTests (WP-F2 fixture): this test process runs from a different folder than the root it checks', fs.realpathSync(process.cwd()).toLowerCase() !== fs.realpathSync(RT_CWD).toLowerCase());
const rtCwd = D.runTests(RT_CWD);
t('runTests: each suite runs with the checked root as its working folder (WP-F2)', rtCwd.ok === true && rtCwd.passed === 1, JSON.stringify(rtCwd.perSuite));

const RT_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-empty-'));
fs.mkdirSync(path.join(RT_EMPTY, '.claude', 'forge-bin'), { recursive: true }); // dir exists, 0 *.test.cjs files
const rtEmpty = D.runTests(RT_EMPTY);
t('runTests: 0 suites found (dir present, empty) -> ok=false ("no evidence")', rtEmpty.ok === false && rtEmpty.suites === 0);
t('runTests: 0-suite reason distinguishes "present but empty"', /present but empty/.test(rtEmpty.reason));

const RT_MISSING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-missing-')); // no forge-bin at all
const rtMissing = D.runTests(RT_MISSING);
t('runTests: forge-bin/ dir missing entirely -> ok=false, distinct reason', rtMissing.ok === false && /dir missing/.test(rtMissing.reason));

// FIX 4: a REAL spawnSync timeout (not a mocked shape) — a busy-loop suite is killed after timeoutMs and
// must be labeled timedOut/blocked, never counted as a plain failure.
const RT_TIMEOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-timeout-'));
fs.mkdirSync(path.join(RT_TIMEOUT, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_TIMEOUT, '.claude', 'forge-bin', 'busyloop.test.cjs'), 'for (;;) {}\n');
const rtTimeout = D.runTests(RT_TIMEOUT, { timeoutMs: 500 });
t('runTests: a real spawnSync timeout is labeled timedOut=true', rtTimeout.perSuite[0].timedOut === true);
t('runTests: a timed-out suite is "blocked", not counted in suitesFailed', rtTimeout.suitesBlocked === 1 && rtTimeout.suitesFailed === 0);
t('runTests: overall ok=false when a suite is blocked (honestly not green)', rtTimeout.ok === false);
t('runTests: timed-out suite entry carries the kill signal', rtTimeout.perSuite[0].signal === 'SIGTERM');
// (fresh-laptop simulation): the heaviest real suite takes ~95 s on the maintainer's PC, so a 120 s
// per-suite limit turned a slower laptop's doctor red with nothing broken. Default >= 300 s, env-overridable.
t('runTests: the default per-suite limit leaves room for the heaviest suite on a slow laptop (>= 300 s)', D.DOCTOR_SUITE_TIMEOUT_MS >= 300000, String(D.DOCTOR_SUITE_TIMEOUT_MS));
// WP-SPD-A: forge-sync.test measured 319 s and 438 s on a loaded PC — the default is 600 s now.
// WP-LIMITS: forge-sync.test grew to ~1550 assertions (isolated TEMP) and needs ~750 s alone, so the
// 600 s default left ~43 s headroom under load — the pinned default is 1500 s now (still a finite limit: a hung
// suite is timedOut/blocked, never a pass; the env override below still wins).
t('runTests: WP-LIMITS default per-suite limit is 1500 s (about 2x the ~750 s forge-sync.test measurement)', D.DOCTOR_SUITE_TIMEOUT_MS === 1500000, String(D.DOCTOR_SUITE_TIMEOUT_MS));
{
  const saved = process.env.FORGE_DOCTOR_SUITE_TIMEOUT_MS;
  process.env.FORGE_DOCTOR_SUITE_TIMEOUT_MS = '500';
  try {
    const rtEnv = D.runTests(RT_TIMEOUT); // no opts.timeoutMs: the env override must apply
    t('runTests: FORGE_DOCTOR_SUITE_TIMEOUT_MS overrides the default (busy-loop suite blocked after 500 ms)', rtEnv.suitesBlocked === 1 && rtEnv.perSuite[0].timedOut === true);
  } finally {
    if (saved === undefined) delete process.env.FORGE_DOCTOR_SUITE_TIMEOUT_MS; else process.env.FORGE_DOCTOR_SUITE_TIMEOUT_MS = saved;
  }
}

// =====================================================================================================
// WP-SPD-C: the suites run in a bounded pool (forge-suite-pool.cjs, default 4 at a time, longest-first,
// a suite over its limit killed by its own PID). The verdict code is unchanged, so the pool must give EXACTLY the
// sequential result on every suite shape the tally rules care about.
// =====================================================================================================
{
  const { spawn: spawnC, spawnSync: spawnSyncC } = require('child_process');
  const mkRoot = (tag) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-spdc-' + tag + '-')); fs.mkdirSync(path.join(r, '.claude', 'forge-bin'), { recursive: true }); return r; };
  const put = (r, name, src) => fs.writeFileSync(path.join(r, '.claude', 'forge-bin', name), src);
  const durFile = (r) => path.join(r, 'durations.json'); // test-local ordering hints, never the shared OS-temp file
  const withoutRunner = (x) => { const c = Object.assign({}, x); delete c.runner; delete c.jobs; return c; };

  const MIX = mkRoot('mix');
  put(MIX, 'a-ok.test.cjs', "console.log('  ok  fine');\nconsole.log('3 passed, 0 failed');\n");
  put(MIX, 'b-fail.test.cjs', "console.log('  FAIL the broken case');\nconsole.log('1 passed, 1 failed');\nprocess.exit(1);\n");
  put(MIX, 'c-vacuous.test.cjs', "console.log('0 passed, 0 failed');\n");
  put(MIX, 'd-busy.test.cjs', 'for (;;) {}\n');
  put(MIX, 'e-throws.test.cjs', "throw new Error('boom before the tally');\n");
  put(MIX, 'f-suffix.test.cjs', "console.log('  ok  a 0 passed, 0 failed description');\nconsole.log('43 passed, 0 failed, 1 skipped');\n");
  put(MIX, 'g-exit1-green-tally.test.cjs', "console.log('2 passed, 0 failed');\nprocess.exit(1);\n");
  put(MIX, 'h-cwd.test.cjs',
    "const fs = require('fs'); const path = require('path');\n" +
    "const want = fs.realpathSync(path.join(__dirname, '..', '..')).toLowerCase(); const got = fs.realpathSync(process.cwd()).toLowerCase();\n" +
    "if (want === got) { console.log('1 passed, 0 failed'); } else { console.log('  FAIL cwd ' + got); console.log('0 passed, 1 failed'); process.exit(1); }\n");
  const mixPool = D.runTests(MIX, { jobs: 4, timeoutMs: 1500, durationsFile: durFile(MIX) });
  const mixSeq = D.runTests(MIX, { jobs: 1, timeoutMs: 1500 });
  t('WP-SPD-C: the mixed fixture really ran through the pool (runner=pool, jobs=4) and the reference sequentially', mixPool.runner === 'pool' && mixPool.jobs === 4 && !mixPool.poolError && mixSeq.runner === 'sequential', JSON.stringify({ runner: mixPool.runner, jobs: mixPool.jobs, poolError: mixPool.poolError }));
  t('WP-SPD-C: pool result is IDENTICAL to the sequential result (ok/fail/vacuous/timeout/throw/suffix/exit-1/cwd suites)', JSON.stringify(withoutRunner(mixPool)) === JSON.stringify(withoutRunner(mixSeq)), JSON.stringify(mixPool) + ' vs ' + JSON.stringify(mixSeq));
  const byName = (rep, n) => rep.perSuite.find((s) => s.suite === n) || {};
  t('WP-SPD-C: perSuite stays in name order although the pool ran longest-first', mixPool.perSuite.map((s) => s.suite).join() === mixPool.perSuite.map((s) => s.suite).slice().sort().join());
  t('WP-SPD-C: a pool-killed suite is timedOut/blocked with signal SIGTERM, never failed or passed', byName(mixPool, 'd-busy.test.cjs').timedOut === true && byName(mixPool, 'd-busy.test.cjs').ok === false && byName(mixPool, 'd-busy.test.cjs').signal === 'SIGTERM' && mixPool.suitesBlocked === 1);
  t('WP-SPD-C: tally rules unchanged in the pool: vacuous 0/0 red, exit 1 with a green tally red, throw-before-tally red, p>0 f=0 exit 0 green',
    byName(mixPool, 'c-vacuous.test.cjs').ok === false && byName(mixPool, 'g-exit1-green-tally.test.cjs').ok === false && byName(mixPool, 'e-throws.test.cjs').ok === false
    && byName(mixPool, 'a-ok.test.cjs').ok === true && byName(mixPool, 'f-suffix.test.cjs').passed === 43 && byName(mixPool, 'h-cwd.test.cjs').ok === true
    && mixPool.suitesFailed === 4 && mixPool.ok === false);
  t('WP-SPD-C: failing test names are still recorded through the pool', Array.isArray(byName(mixPool, 'b-fail.test.cjs').failures) && /the broken case/.test(byName(mixPool, 'b-fail.test.cjs').failures[0]));

  // FORGE_DOCTOR_JOBS=1 restores the old sequential path exactly.
  {
    const saved = process.env.FORGE_DOCTOR_JOBS;
    process.env.FORGE_DOCTOR_JOBS = '1';
    try {
      const envSeq = D.runTests(MIX, { timeoutMs: 1500 });
      t('WP-SPD-C: FORGE_DOCTOR_JOBS=1 -> sequential runner with the identical result', envSeq.runner === 'sequential' && envSeq.jobs === 1 && JSON.stringify(withoutRunner(envSeq)) === JSON.stringify(withoutRunner(mixSeq)));
    } finally { if (saved === undefined) delete process.env.FORGE_DOCTOR_JOBS; else process.env.FORGE_DOCTOR_JOBS = saved; }
  }
  t('WP-SPD-C: default pool size is 4', D.DOCTOR_SUITE_JOBS === 4 && D.resolveSuiteJobs({}) === (Number(process.env.FORGE_DOCTOR_JOBS) >= 1 ? Math.floor(Number(process.env.FORGE_DOCTOR_JOBS)) : 4));
  t('WP-SPD-C: a single suite keeps the plain spawnSync path (the real-timeout tests above stay real spawnSync timeouts)', rtTimeout.runner === 'sequential' && rtReal.runner === 'sequential');

  // A missing or broken helper is never a silent pass and never a crash: the suites run sequentially and it is said.
  const SMALL = mkRoot('small');
  put(SMALL, 'a-ok.test.cjs', "console.log('3 passed, 0 failed');\n");
  put(SMALL, 'b-fail.test.cjs', "console.log('  FAIL the broken case');\nconsole.log('1 passed, 1 failed');\nprocess.exit(1);\n");
  const smallSeq = D.runTests(SMALL, { jobs: 1 });
  const sameVerdicts = (x) => JSON.stringify(withoutRunner(Object.assign({}, x, { poolError: undefined }))) === JSON.stringify(withoutRunner(smallSeq));
  const missingPool = D.runTests(SMALL, { jobs: 4, poolFile: path.join(SMALL, 'no-such-pool.cjs'), durationsFile: durFile(SMALL) });
  t('WP-SPD-C: missing pool helper -> sequential fallback, poolError named, same verdicts', missingPool.runner === 'sequential' && /missing/.test(missingPool.poolError || '') && sameVerdicts(missingPool) && smallSeq.suitesFailed === 1);
  const brokenPoolFile = path.join(SMALL, 'broken-pool.cjs');
  fs.writeFileSync(brokenPoolFile, "process.stdout.write('not json'); process.exit(0);\n");
  const brokenPool = D.runTests(SMALL, { jobs: 4, poolFile: brokenPoolFile, durationsFile: durFile(SMALL) });
  t('WP-SPD-C: a pool that returns garbage -> sequential fallback with poolError, same verdicts', brokenPool.runner === 'sequential' && /suite pool failed/.test(brokenPool.poolError || '') && sameVerdicts(brokenPool));

  // Concurrency is real and capped: each suite records when it started and ended.
  const CONC = mkRoot('conc');
  const stampSuite = "const fs = require('fs'); const path = require('path'); const f = path.join(__dirname, '..', '..', 'stamps.jsonl');\n" +
    "const s = Date.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); fs.appendFileSync(f, JSON.stringify({ s, e: Date.now() }) + '\\n');\n" +
    "console.log('1 passed, 0 failed');\n";
  for (let i = 0; i < 6; i++) put(CONC, 'c' + i + '.test.cjs', stampSuite);
  const maxOverlap = (r) => {
    const st = fs.readFileSync(path.join(r, 'stamps.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    let best = 0; for (const a of st) best = Math.max(best, st.filter((b) => b.s <= a.s && a.s < b.e).length);
    return { best, n: st.length };
  };
  const conc2 = D.runTests(CONC, { jobs: 2, timeoutMs: 60000, durationsFile: durFile(CONC) });
  const ov2 = maxOverlap(CONC);
  t('WP-SPD-C: jobs=2 runs suites at the same time but never more than 2 at once', conc2.ok === true && conc2.runner === 'pool' && ov2.n === 6 && ov2.best === 2, JSON.stringify(ov2));
  fs.rmSync(path.join(CONC, 'stamps.jsonl'), { force: true });
  const conc4 = D.runTests(CONC, { jobs: 4, timeoutMs: 60000, durationsFile: durFile(CONC) });
  const ov4 = maxOverlap(CONC);
  t('WP-SPD-C: jobs=4 runs up to 4 suites at once (and no more)', conc4.ok === true && ov4.n === 6 && ov4.best >= 2 && ov4.best <= 4, JSON.stringify(ov4));

  // Longest-first ordering from recorded durations; unknown suites first (they may be long), largest file first.
  const ORD = mkRoot('order');
  put(ORD, 'a.test.cjs', '// small\n'); put(ORD, 'b.test.cjs', '// ' + 'x'.repeat(500) + '\n'); put(ORD, 'c.test.cjs', '//\n'); put(ORD, 'd.test.cjs', '//\n');
  const ordTests = ['a', 'b', 'c', 'd'].map((n) => path.join(ORD, '.claude', 'forge-bin', n + '.test.cjs'));
  const ordFile = durFile(ORD);
  const firstOrder = D.suiteOrder(ORD, ordTests, ordFile);
  t('WP-SPD-C order: with no recorded durations the largest file goes first', ordTests[firstOrder[0]].endsWith('b.test.cjs') && firstOrder.length === 4 && new Set(firstOrder).size === 4);
  fs.writeFileSync(ordFile, JSON.stringify({ [D.suiteRootKey(ORD)]: { at: Date.now(), ms: { 'a.test.cjs': 100, 'c.test.cjs': 9000, 'd.test.cjs': 500 } } }));
  const knownOrder = D.suiteOrder(ORD, ordTests, ordFile).map((i) => path.basename(ordTests[i]));
  t('WP-SPD-C order: unknown suite first, then recorded durations longest-first', knownOrder.join() === 'b.test.cjs,c.test.cjs,d.test.cjs,a.test.cjs', knownOrder.join());
  fs.writeFileSync(ordFile, '{ corrupt');
  t('WP-SPD-C order: a corrupt durations file is ignored (no hint, no crash)', D.suiteOrder(ORD, ordTests, ordFile).length === 4);
  const savedMix = D.readSuiteDurations(durFile(MIX))[D.suiteRootKey(MIX)];
  t('WP-SPD-C: a pool run records per-suite durations for the next ordering (hint file only)', !!savedMix && Number.isFinite(savedMix.ms['d-busy.test.cjs']) && savedMix.ms['d-busy.test.cjs'] >= 1500);

  // A suite over its limit is killed by ITS OWN PID together with what it started; an unrelated node process lives on.
  const KILL = mkRoot('kill');
  put(KILL, 'k-ok.test.cjs', "console.log('1 passed, 0 failed');\n");
  put(KILL, 'k-hang.test.cjs',
    "const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');\n" +
    "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n" +
    "fs.writeFileSync(path.join(__dirname, '..', '..', 'grandchild.pid'), String(c.pid));\n" +
    "setInterval(() => {}, 1000);\n");
  const bystander = spawnC(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const killRep = D.runTests(KILL, { jobs: 2, timeoutMs: 2500, durationsFile: durFile(KILL) });
  let grandPid = NaN; try { grandPid = Number(fs.readFileSync(path.join(KILL, 'grandchild.pid'), 'utf8')); } catch { grandPid = NaN; }
  // give the OS a moment to reap the killed tree before probing it
  const deadline = Date.now() + 5000; while (Number.isFinite(grandPid) && alive(grandPid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  t('WP-SPD-C kill: the hung suite is blocked (timedOut) and the other suite still passes', killRep.runner === 'pool' && byName(killRep, 'k-hang.test.cjs').timedOut === true && byName(killRep, 'k-ok.test.cjs').ok === true && killRep.suitesBlocked === 1);
  t('WP-SPD-C kill: the process the hung suite started is gone too (its own PID tree was killed)', Number.isFinite(grandPid) && grandPid > 0 && !alive(grandPid), 'grandchild pid ' + grandPid);
  t('WP-SPD-C kill: an unrelated node process outside the pool is still alive (no kill by image name)', alive(bystander.pid));
  try { process.kill(bystander.pid); } catch { /* best effort: our own bystander by its PID */ }
  if (Number.isFinite(grandPid) && alive(grandPid)) { try { process.kill(grandPid); } catch { /* best effort */ } }
  const poolSrc = fs.readFileSync(path.join(__dirname, 'forge-suite-pool.cjs'), 'utf8');
  t('WP-SPD-C kill: the pool helper only kills by PID (no /IM, pkill, killall, or Stop-Process -Name)', /'\/PID'/.test(poolSrc) && !/['"]\/IM['"]|\bpkill\b|\bkillall\b|Stop-Process\s+-Name/i.test(poolSrc));
  const poolInvalid = spawnSyncC(process.execPath, [path.join(__dirname, 'forge-suite-pool.cjs')], { input: '{}', encoding: 'utf8' });
  t('WP-SPD-C: the pool helper refuses an invalid job (exit 2, nothing on stdout)', poolInvalid.status === 2 && poolInvalid.stdout === '');
}

// =====================================================================================================
// WP-TMP-HYGIENE: every suite — pooled or sequential — runs with TEMP/TMP/TMPDIR pointing at a private
// forge-run-<pid>-<n> folder directly under os.tmpdir(), removed after the suite ends (pass, fail or timeout). Each
// fixture suite below records the temp env it saw and leaves a mkdtemp folder behind on purpose.
// =====================================================================================================
{
  const P = require('./forge-suite-pool.cjs');
  const tmpRoot = os.tmpdir();
  const lc = (p) => path.resolve(p).toLowerCase();
  const forgeRunCount = () => fs.readdirSync(tmpRoot).filter((n) => n.startsWith('forge-run-')).length;
  const mkRoot = (tag) => { const r = fs.mkdtempSync(path.join(tmpRoot, 'forge-doctor-tmph-' + tag + '-')); fs.mkdirSync(path.join(r, '.claude', 'forge-bin'), { recursive: true }); return r; };
  const leakSuite = (name, tail) =>
    "const fs = require('fs'); const os = require('os'); const path = require('path');\n" +
    "const leak = fs.mkdtempSync(path.join(os.tmpdir(), 'leaky-fixture-')); fs.writeFileSync(path.join(leak, 'x.txt'), 'x');\n" +
    "fs.writeFileSync(path.join(__dirname, '..', '..', '" + name + ".json'), JSON.stringify({ tmp: os.tmpdir(), TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, leak }));\n" + tail;
  const put = (r, name, tail) => fs.writeFileSync(path.join(r, '.claude', 'forge-bin', name + '.test.cjs'), leakSuite(name, tail));
  const seen = (r, name) => { try { return JSON.parse(fs.readFileSync(path.join(r, name + '.json'), 'utf8')); } catch { return null; } };
  const isolated = (s) => !!s && s.TEMP === s.tmp && s.TMP === s.tmp && s.TMPDIR === s.tmp
    && path.dirname(lc(s.tmp)) === lc(tmpRoot) && /^forge-run-\d+-\d+$/.test(path.basename(s.tmp));
  const gone = (s) => !!s && !fs.existsSync(s.tmp) && !fs.existsSync(s.leak);

  for (const mode of [{ label: 'pool', jobs: 3 }, { label: 'sequential', jobs: 1 }]) {
    const R = mkRoot(mode.label);
    put(R, 'a-pass', "console.log('1 passed, 0 failed');\n");
    put(R, 'b-fail', "console.log('  FAIL on purpose'); console.log('0 passed, 1 failed'); process.exit(1);\n");
    put(R, 'c-hang', 'for (;;) {}\n');
    const before = forgeRunCount();
    const rep = D.runTests(R, { jobs: mode.jobs, timeoutMs: 2500, durationsFile: path.join(R, 'durations.json') });
    const after = forgeRunCount();
    const a = seen(R, 'a-pass'), b = seen(R, 'b-fail'), c = seen(R, 'c-hang');
    t('WP-TMP-HYGIENE ' + mode.label + ': ran through the ' + mode.label + ' runner (pass, fail, timeout)', rep.runner === mode.label && rep.suitesFailed === 1 && rep.suitesBlocked === 1, JSON.stringify({ runner: rep.runner, f: rep.suitesFailed, b: rep.suitesBlocked }));
    t('WP-TMP-HYGIENE ' + mode.label + ': every suite saw TEMP=TMP=TMPDIR=os.tmpdir() = its own forge-run-<pid>-<n> folder under the temp dir', isolated(a) && isolated(b) && isolated(c) && new Set([a.tmp, b.tmp, c.tmp]).size === 3, JSON.stringify([a, b, c]));
    t('WP-TMP-HYGIENE ' + mode.label + ': each private folder (and the fixture the suite left in it) is removed after pass, fail AND timeout', gone(a) && gone(b) && gone(c));
    t('WP-TMP-HYGIENE ' + mode.label + ': no forge-run-* folder is left behind in the temp dir (' + before + ' before, ' + after + ' after)', after === before);
  }

  // The helpers only ever remove what they could have made: a forge-run-* folder directly under the temp dir.
  const made = P.makeSuiteTmp();
  t('WP-TMP-HYGIENE helper: makeSuiteTmp makes forge-run-<pid>-<n> directly under os.tmpdir()', !!made && fs.existsSync(made) && path.dirname(lc(made)) === lc(tmpRoot) && path.basename(made) === 'forge-run-' + process.pid + '-' + path.basename(made).split('-').pop());
  const keep = fs.mkdtempSync(path.join(tmpRoot, 'forge-doctor-tmph-keep-'));
  const nested = path.join(made, 'forge-run-1-1'); fs.mkdirSync(nested);
  t('WP-TMP-HYGIENE helper: refuses the temp dir itself, a non-forge-run folder, a nested forge-run folder, a traversal and a path outside temp',
    P.isSuiteTmp(tmpRoot) === false && P.removeSuiteTmp(keep) === false && fs.existsSync(keep)
    && P.removeSuiteTmp(nested) === false && fs.existsSync(nested)
    && P.isSuiteTmp(path.join(tmpRoot, 'forge-run-1-1', '..', 'x')) === false
    && P.isSuiteTmp(path.join(path.dirname(tmpRoot), 'forge-run-1-1')) === false
    && P.isSuiteTmp(path.join(tmpRoot, 'forge-run-')) === false && P.isSuiteTmp('') === false && P.isSuiteTmp(null) === false);
  t('WP-TMP-HYGIENE helper: removeSuiteTmp removes its own folder with everything inside', P.removeSuiteTmp(made) === true && !fs.existsSync(made));
  const env = P.suiteEnv({ A: '1', TEMP: 'old' }, '/x/forge-run-1-1');
  t('WP-TMP-HYGIENE helper: suiteEnv copies the env and sets TEMP/TMP/TMPDIR (input untouched; null dir = unchanged copy)', env.A === '1' && env.TEMP === '/x/forge-run-1-1' && env.TMP === env.TEMP && env.TMPDIR === env.TEMP && P.suiteEnv({ TEMP: 'old' }, null).TEMP === 'old');
}

// =====================================================================================================
// WP-LONGPATH: every suite — pooled or sequential — gets core.longpaths=true and
// protocol.file.allow=always through GIT_CONFIG_COUNT/KEY_n/VALUE_n env vars (never a git config file), appended to
// any entries already in the environment. The fixture suite asks git itself; a clean HOME + GIT_CONFIG_NOSYSTEM prove
// the values come from the env and not from the owner's global/system git config.
// =====================================================================================================
{
  const P = require('./forge-suite-pool.cjs');
  const saved = Object.assign({}, process.env);
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-lp-home-'));
  const lpSuite = (name) =>
    "const { spawnSync } = require('child_process'); const fs = require('fs'); const path = require('path');\n" +
    "const g = (k) => { const r = spawnSync('git', ['config', '--get', k], { encoding: 'utf8' }); return (r.stdout || '').trim(); };\n" +
    "fs.writeFileSync(path.join(__dirname, '..', '..', '" + name + ".json'), JSON.stringify({ longpaths: g('core.longpaths'), fileAllow: g('protocol.file.allow'), marker: g('forge.lpmarker'), count: process.env.GIT_CONFIG_COUNT }));\n" +
    "console.log('1 passed, 0 failed');\n";
  const seenLp = (r, name) => { try { return JSON.parse(fs.readFileSync(path.join(r, name + '.json'), 'utf8')); } catch { return null; } };
  for (const preset of [false, true]) {
    for (const mode of [{ label: 'pool', jobs: 2 }, { label: 'sequential', jobs: 1 }]) {
      const R = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-lp-' + mode.label + '-'));
      fs.mkdirSync(path.join(R, '.claude', 'forge-bin'), { recursive: true });
      fs.writeFileSync(path.join(R, '.claude', 'forge-bin', 'lp-a.test.cjs'), lpSuite('lp-a'));
      fs.writeFileSync(path.join(R, '.claude', 'forge-bin', 'lp-b.test.cjs'), lpSuite('lp-b'));
      for (const k of Object.keys(process.env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(k)) delete process.env[k];
      Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' });
      if (preset) Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'forge.lpmarker', GIT_CONFIG_VALUE_0: 'kept' });
      let rep = null;
      try { rep = D.runTests(R, { jobs: mode.jobs, timeoutMs: 60000, durationsFile: path.join(R, 'durations.json') }); } finally { restore(); }
      const a = seenLp(R, 'lp-a'), b = seenLp(R, 'lp-b');
      const okSeen = (s) => !!s && s.longpaths === 'true' && s.fileAllow === 'always'
        && (preset ? s.marker === 'kept' && s.count === '3' : s.count === '2');
      t('WP-LONGPATH ' + mode.label + (preset ? ' (existing GIT_CONFIG_COUNT=1)' : ' (clean HOME)') + ': every suite sees core.longpaths=true + protocol.file.allow=always via env'
        + (preset ? ', and the existing entry is preserved and extended' : ''),
        !!rep && rep.runner === mode.label && okSeen(a) && okSeen(b), JSON.stringify({ runner: rep && rep.runner, a, b }));
      try { fs.rmSync(R, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }

  // Helper-level: append, do not overwrite; a key the env already sets is respected; input untouched; invalid count untouched.
  const input = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'core.longpaths', GIT_CONFIG_VALUE_1: 'false' };
  const out = P.withSuiteGitConfig(input);
  t('WP-LONGPATH helper: appends after existing entries, keeps a key the env already sets, leaves the input untouched',
    out.GIT_CONFIG_COUNT === '3' && out.GIT_CONFIG_KEY_0 === 'a.b' && out.GIT_CONFIG_VALUE_1 === 'false'
    && out.GIT_CONFIG_KEY_2 === 'protocol.file.allow' && out.GIT_CONFIG_VALUE_2 === 'always' && input.GIT_CONFIG_COUNT === '2' && !('GIT_CONFIG_KEY_2' in input));
  const fresh = P.withSuiteGitConfig({});
  t('WP-LONGPATH helper: no prior count = exactly the two suite entries; a bogus count is left as it is',
    fresh.GIT_CONFIG_COUNT === '2' && fresh.GIT_CONFIG_KEY_0 === 'core.longpaths' && fresh.GIT_CONFIG_VALUE_0 === 'true'
    && fresh.GIT_CONFIG_KEY_1 === 'protocol.file.allow' && fresh.GIT_CONFIG_VALUE_1 === 'always'
    && P.withSuiteGitConfig({ GIT_CONFIG_COUNT: 'x' }).GIT_CONFIG_COUNT === 'x' && !('GIT_CONFIG_KEY_0' in P.withSuiteGitConfig({ GIT_CONFIG_COUNT: 'x' })));
  const poolSrcLp = fs.readFileSync(path.join(__dirname, 'forge-suite-pool.cjs'), 'utf8');
  t('WP-LONGPATH helper: the pool never writes a git config file (no `git config --global/--system/--local` or .gitconfig write)',
    !/['"]config['"]\s*,\s*['"]--(global|system|local|file)['"]/.test(poolSrcLp) && !/writeFileSync\([^)]*gitconfig/i.test(poolSrcLp));
}

// =====================================================================================================
// 2026-07-14 FOLLOWUP A — FIX 1: anchor the tally regex so a phrase inside a test DESCRIPTION (echoed by
// the suite's own harness) can never be mistaken for the suite's real trailing "N passed, M failed" line.
// =====================================================================================================
const RT_DESC_COLLISION = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-desccollision-'));
fs.mkdirSync(path.join(RT_DESC_COLLISION, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_DESC_COLLISION, '.claude', 'forge-bin', 'desccollision.test.cjs'),
  "console.log('  ok  a test describing a 0 passed, 0 failed edge case');\n" +
  "console.log('12 passed, 0 failed');\n" +
  "process.exit(0);\n");
const rtDesc = D.runTests(RT_DESC_COLLISION);
t('runTests: a mid-line "0 passed, 0 failed" INSIDE a description does not fool the tally', rtDesc.perSuite[0].passed === 12 && rtDesc.perSuite[0].failed === 0);
t('runTests: description-collision suite reads the REAL trailing summary and is ACCEPTED', rtDesc.perSuite[0].ok === true && rtDesc.ok === true);

// Regression guard for a REAL sibling-suite format discovered while re-running the full doctor against this
// repo: forge-learn.test.cjs legitimately prints "N passed, M failed, K skipped" (extra trailing content on
// the SAME summary line). An over-strict end-of-line anchor would misread this as 0/0 evidence — must still
// read the leading counts correctly.
const RT_TRAILING_SUFFIX = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-trailingsuffix-'));
fs.mkdirSync(path.join(RT_TRAILING_SUFFIX, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_TRAILING_SUFFIX, '.claude', 'forge-bin', 'trailingsuffix.test.cjs'), "console.log('43 passed, 0 failed, 1 skipped');\nprocess.exit(0);\n");
const rtTrailing = D.runTests(RT_TRAILING_SUFFIX);
t('runTests: a real "N passed, M failed, K skipped" trailing-suffix line is still read correctly (43/0, not 0/0)', rtTrailing.perSuite[0].passed === 43 && rtTrailing.perSuite[0].failed === 0);
t('runTests: trailing-suffix suite is correctly ACCEPTED, not misread as vacuous', rtTrailing.perSuite[0].ok === true && rtTrailing.ok === true);

const RT_REAL_FAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-realfail-'));
fs.mkdirSync(path.join(RT_REAL_FAIL, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_REAL_FAIL, '.claude', 'forge-bin', 'realfail.test.cjs'),
  "console.log('  ok  a test naming a 9 passed, 0 failed scenario');\n" +
  "console.log('3 passed, 2 failed');\n" +
  "process.exit(1);\n");
const rtRealFail = D.runTests(RT_REAL_FAIL);
t('runTests: a genuinely failing suite (3 passed, 2 failed) is STILL read correctly', rtRealFail.perSuite[0].passed === 3 && rtRealFail.perSuite[0].failed === 2);
t('runTests: real failure is still marked failed — anchoring does NOT weaken existing detection', rtRealFail.perSuite[0].ok === false && rtRealFail.suitesFailed === 1 && rtRealFail.ok === false);

// a failing suite names its failing tests; a passing or timed-out suite carries no failures field.
const RT_NAMED_FAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-namedfail-'));
fs.mkdirSync(path.join(RT_NAMED_FAIL, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_NAMED_FAIL, '.claude', 'forge-bin', 'namedfail.test.cjs'),
  "console.log('  ok   a passing case');\n" +
  "console.log('  FAIL the broken case — expected 1, got 2');\n" +
  "console.log('not ok 7 - a node:test style failure');\n" +
  "console.log('1 passed, 2 failed');\n" +
  "process.exit(1);\n");
const rtNamed = D.runTests(RT_NAMED_FAIL);
t('runTests: a failing suite records its failing test NAMES (FAIL and not ok lines)', Array.isArray(rtNamed.perSuite[0].failures) && rtNamed.perSuite[0].failures.length === 2 && /the broken case/.test(rtNamed.perSuite[0].failures[0]) && /node:test style failure/.test(rtNamed.perSuite[0].failures[1]), JSON.stringify(rtNamed.perSuite[0].failures));
t('runTests: passing lines are not recorded as failures', !rtNamed.perSuite[0].failures.some((l) => /a passing case/.test(l)));
t('runTests: a passing suite carries no failures field', rtReal.perSuite[0].failures === undefined);
t('runTests: a timed-out suite carries no failures field (it never finished)', rtTimeout.perSuite[0].failures === undefined);
const manyFails = Array.from({ length: 9 }, (_, i) => '  FAIL case ' + i).join('\n');
t('failingTestNames: capped at FAIL_NAMES_MAX lines', D.failingTestNames(manyFails).length === D.FAIL_NAMES_MAX && D.FAIL_NAMES_MAX === 5);
t('failingTestNames: each line capped at 200 chars', D.failingTestNames('  FAIL ' + 'x'.repeat(500))[0].length === 200);
t('failingTestNames: a secret-shaped value in a failure line is redacted', !/sk-ant-api03-[A-Za-z0-9_-]{20}/.test(D.failingTestNames('  FAIL leaked sk-ant-api03-' + 'A'.repeat(40))[0]));
t('failingTestNames: no failure lines -> empty list', D.failingTestNames('  ok   fine\n3 passed, 0 failed').length === 0);
// redactValue() on a bare string never caught a LABELLED secret (only object-key
// heuristics did) — "FAIL test password=hunter2" kept the raw value. Fixed by switching to redactText().
t('failingTestNames: a labelled key=value secret in a failure line is redacted (F9)', (() => {
  const line = D.failingTestNames('  FAIL test password=hunter2')[0];
  return !line.includes('hunter2') && line.includes('password=') && /REDACTED/.test(line);
})());

// --- FIX 3: --json prints exactly ONE parseable JSON object on stdout, matching the fixed contract keys ---
const { spawnSync } = require('child_process');
const DOCTOR_CLI = path.join(__dirname, 'forge-doctor.cjs');
const jsonRun = spawnSync(process.execPath, [DOCTOR_CLI, '--root', RT_REAL, '--json'], { encoding: 'utf8' });
let jsonParsed = null, jsonParseError = '';
try { jsonParsed = JSON.parse(jsonRun.stdout); } catch (e) { jsonParseError = e.message; }
t('CLI --json: stdout parses as exactly one JSON object (no trailing/leading text)', jsonParsed !== null);
t('CLI --json: stdout does NOT also contain the human summary banner', !jsonRun.stdout.includes('Forge Doctor —'));
if (jsonParsed) {
  t('CLI --json: top-level has ok (boolean) + root (string)', typeof jsonParsed.ok === 'boolean' && typeof jsonParsed.root === 'string');
  const requiredCheckKeys = ['node_check', 'tests', 'strict_events', 'dashboard_spa', 'leak_scan', 'agents', 'chain', 'rebinding_guard'];
  t('CLI --json: checks object has all 8 fixed-name keys', requiredCheckKeys.every((k) => Object.prototype.hasOwnProperty.call(jsonParsed.checks, k)));
  t('CLI --json: node_check has ok+total+failed count fields', typeof jsonParsed.checks.node_check.ok === 'boolean' && typeof jsonParsed.checks.node_check.total === 'number' && typeof jsonParsed.checks.node_check.failed === 'number');
  t('CLI --json: tests has ok+suites+suitesFailed+passed+failed count fields', typeof jsonParsed.checks.tests.ok === 'boolean' && typeof jsonParsed.checks.tests.suites === 'number' && typeof jsonParsed.checks.tests.suitesFailed === 'number' && typeof jsonParsed.checks.tests.passed === 'number' && typeof jsonParsed.checks.tests.failed === 'number');
  t('CLI --json: exit code matches reported ok', jsonRun.status === (jsonParsed.ok ? 0 : 1));
} else {
  t('CLI --json: SKIPPED downstream contract checks (stdout was not valid JSON) — ' + jsonParseError, false);
}

// default (no --json) CLI output stays the human-readable summary, and is NOT parseable as JSON
const humanRun = spawnSync(process.execPath, [DOCTOR_CLI, '--root', RT_REAL], { encoding: 'utf8' });
t('CLI default (no --json): prints the human summary banner', humanRun.stdout.includes('Forge Doctor —'));
let humanParsedOk = true; try { JSON.parse(humanRun.stdout); } catch { humanParsedOk = false; }
t('CLI default (no --json): stdout is NOT a bare JSON object', humanParsedOk === false);

// =====================================================================================================
// 2026-07-14 FOLLOWUP A — FIX 2: dispatch_id backfill-continuity, ADVISORY ONLY. Bash-less Bosses (review/
// security/search/seo/boss/head-chef/docs/skill) cannot self-log; the Lead backfills both their
// subagent_started + subagent_completed events with the SAME dispatch_id. This must WARN on inconsistency,
// SKIP runs that predate the convention (no dispatch_id anywhere), and NEVER flip runDoctor's ok to false.
// =====================================================================================================
function bfWriteRun(root, id, events) {
  const dir = path.join(root, '.claude', 'forge-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const BF_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bf-'));
// (a) consistent dispatch_id across start+completion -> no warning
bfWriteRun(BF_ROOT, 'bf-consistent', [
  { event_type: 'subagent_started', agent: 'review-boss', dispatch_id: 'toolu_aaa' },
  { event_type: 'subagent_completed', agent: 'review-boss', dispatch_id: 'toolu_aaa' },
]);
// (b) started WITH a dispatch_id, completed WITHOUT one -> advisory warning
bfWriteRun(BF_ROOT, 'bf-missing-completion-id', [
  { event_type: 'subagent_started', agent: 'security-boss', dispatch_id: 'toolu_bbb' },
  { event_type: 'subagent_completed', agent: 'security-boss' },
]);
// (b') started with one dispatch_id, completed with a DIFFERENT one -> advisory warning
bfWriteRun(BF_ROOT, 'bf-different-completion-id', [
  { event_type: 'subagent_started', agent: 'boss', dispatch_id: 'toolu_ccc' },
  { event_type: 'subagent_completed', agent: 'boss', dispatch_id: 'toolu_zzz' },
]);
// (c) an OLD run with NO dispatch_id anywhere at all -> "not applicable", skipped, never a warning
bfWriteRun(BF_ROOT, 'bf-legacy-no-dispatch', [
  { event_type: 'subagent_started', agent: 'docs-boss' },
  { event_type: 'subagent_completed', agent: 'docs-boss' },
]);
// a Bash-CAPABLE Boss's self-logged completion legitimately carries no dispatch_id even in an otherwise
// dispatch_id-using run (see log-event.cjs's DISPATCH_PROOF_EVENTS note) — must never be judged at all.
bfWriteRun(BF_ROOT, 'bf-full-build-not-judged', [
  { event_type: 'subagent_started', agent: 'build-boss', dispatch_id: 'toolu_ddd' },
  { event_type: 'subagent_completed', agent: 'build-boss' },
]);

const bf = D.backfillContinuity(BF_ROOT);
t('backfillContinuity: consistent dispatch_id -> no warning for that run', !bf.warnings.some((w) => w.run === 'bf-consistent'));
t('backfillContinuity: completion missing its dispatch_id -> advisory warning', bf.warnings.some((w) => w.run === 'bf-missing-completion-id' && w.agent === 'security-boss'));
t('backfillContinuity: completion with a DIFFERENT dispatch_id -> advisory warning', bf.warnings.some((w) => w.run === 'bf-different-completion-id' && w.agent === 'boss'));
t('backfillContinuity: a run with NO dispatch_id anywhere is skipped (not applicable), never warned', !bf.warnings.some((w) => w.run === 'bf-legacy-no-dispatch'));
t('backfillContinuity: a Bash-capable Boss (build-boss) is NEVER judged, even if its completion omits dispatch_id', !bf.warnings.some((w) => w.agent === 'build-boss'));
t('backfillContinuity: applicableRuns counts only runs using dispatch_id somewhere (4 of 5 fixture runs)', bf.applicableRuns === 4 && bf.checkedRuns === 5);
t('backfillContinuity: own report is honest — ok=false with exactly the 2 real warnings', bf.ok === false && bf.warnings.length === 2);

// (d) THE CORE GUARANTEE: an advisory warning must NEVER flip runDoctor()'s overall ok to false. Build a
// real, fully-green 8-check fixture root (reusing this actual project's own real agents/, tool-policy, and
// dashboard files — the same files this repo's own `node forge-doctor.cjs` already reports ALL GREEN for)
// plus one backfill-inconsistent run, then assert runDoctor's ok stays true while the advisory itself is
// honestly ok=false.
const REAL_ROOT = path.resolve(__dirname, '..', '..'); // this actual project (two levels up from forge-bin)

/** sanitizeReadOnlyAgentMemory(agentsDir) — TRANSITIONAL fixture shim (2026-09-26 laptop re-audit).
 *  agentsCheck() now requires `memory: project` to be ABSENT on any agent whose policy class forbids Write
 *  (memoryAllowedForClass()) — the class-aware fix for N5 (Claude Code grants Write+Edit to any agent
 *  carrying `memory: project`, regardless of its `tools:` line). The N5 REMOVAL of that line from the real
 *  read-only agent-md files lands in a separate, parallel work package and is not merged into THIS worktree
 *  yet, so every fixture below that copies the real .claude/agents/ wholesale would otherwise fail on a
 *  defect this very check exists to catch. This helper makes those fixtures simulate the POST-MERGE state —
 *  the one both packages will actually ship together — by stripping a `memory:` frontmatter line from any
 *  copied agent-md whose class forbids Write. Once the real files no longer carry that line, every strip
 *  below is a no-op (nothing left to remove) and this function stops doing anything at all. */
function sanitizeReadOnlyAgentMemory(agentsDir) {
  let policyFile;
  try { policyFile = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), 'utf8')); }
  catch { return; }
  let files; try { files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')); } catch { return; }
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    if (D.memoryAllowedForClass(policyFile, name) !== false) continue; // only strip where memory is FORBIDDEN
    const p = path.join(agentsDir, f);
    const text = fs.readFileSync(p, 'utf8');
    const stripped = text.replace(/^memory:\s*.*\r?\n/m, '');
    if (stripped !== text) fs.writeFileSync(p, stripped, 'utf8');
  }
}

/** copyShippedAgents(destAgentsDir) — WP-DEVTREE-TESTS. Copies ONLY the real agent-md files the
 *  SHIPPED agent-tool-policy.json names, so a fixture that pairs the real agents with the real (shipped) policy is
 *  self-contained. In the development tree that is exactly every file in .claude/agents/ (forge-agents.test.cjs
 *  pins it), so the fixtures are byte-for-byte what they were. In a synced project its own agents (registered in its
 *  never-synced agent-tool-policy.user.json overlay, which these fixtures do not copy) are left out — visibly, once
 *  — instead of turning every "green fixture" red for a reason that is not a defect of the code under test. */
let copyShippedAgentsNoted = false;
function copyShippedAgents(destAgentsDir) {
  const srcDir = path.join(REAL_ROOT, '.claude', 'agents');
  const shipped = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), 'utf8')).agents || {};
  fs.mkdirSync(destAgentsDir, { recursive: true });
  const left = [];
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.md')) continue;
    if (!Object.prototype.hasOwnProperty.call(shipped, f.replace(/\.md$/, ''))) { left.push(f); continue; }
    fs.copyFileSync(path.join(srcDir, f), path.join(destAgentsDir, f));
  }
  if (left.length && !copyShippedAgentsNoted) {
    copyShippedAgentsNoted = true;
    console.log('  NOTE fixtures copy the shipped agents only — ' + left.length + ' project-own agent(s) not in the shipped tool policy left out: ' + left.join(', '));
  }
}

const GREEN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-green-'));
fs.mkdirSync(path.join(GREEN_ROOT, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(GREEN_ROOT, '.claude', 'forge-bin', 'good.cjs'), "'use strict';\nmodule.exports = {};\n");
// V9-INTEGRATE: check_the_checks is now ENFORCED — this fixture's "clean" suite must carry a
// REAL assertion site or it would trip check_the_checks itself as a green no-op.
fs.writeFileSync(path.join(GREEN_ROOT, '.claude', 'forge-bin', 'good.test.cjs'), "const assert = require('assert');\nassert.ok(true);\nconsole.log('1 passed, 0 failed');\nprocess.exit(0);\n");
fs.mkdirSync(path.join(GREEN_ROOT, '.claude', 'forge-dashboard'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), path.join(GREEN_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'));
// the retired server.cjs + its 6 static SPA files are gone from REAL_ROOT — spaPresent()'s `ok`
// no longer depends on their presence (see forge-doctor.cjs's spaPresent doc comment), so this GREEN
// fixture no longer needs to fabricate them to pass.
copyShippedAgents(path.join(GREEN_ROOT, '.claude', 'agents'));
sanitizeReadOnlyAgentMemory(path.join(GREEN_ROOT, '.claude', 'agents'));
fs.mkdirSync(path.join(GREEN_ROOT, '.claude', 'config', 'agents'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), path.join(GREEN_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
bfWriteRun(GREEN_ROOT, 'green-bf-warning', [
  { event_type: 'subagent_started', agent: 'seo-boss', dispatch_id: 'toolu_green_1' },
  { event_type: 'subagent_completed', agent: 'seo-boss' },
]);
const greenRep = D.runDoctor(GREEN_ROOT);
t('runDoctor GREEN fixture: all 9 real checks pass (setup sanity check)', greenRep.ok === true);
if (greenRep.ok !== true) console.error('    GREEN fixture check failures: ' + JSON.stringify(Object.entries(greenRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('runDoctor GREEN fixture: advisory DOES surface the real backfill warning', greenRep.advisory.backfill_continuity.warnings.length === 1 && greenRep.advisory.backfill_continuity.ok === false);
t('runDoctor GREEN fixture: an advisory warning does NOT flip doctor.ok to false', greenRep.ok === true);

// =====================================================================================================
// GOAT model routing — checks.model_routing is ENFORCED (forge-policy.cjs routingCheck()).
// GREEN_ROOT carries no routing files -> honestly n/a; a copy WITH the real routing files is green; one
// drifted value turns the whole doctor red; an owner override is visible, never silent.
// =====================================================================================================
t('model_routing: runDoctor() wires checks.model_routing through applyDoctorOverride(modelRoutingCheck(root))',
  new RegExp('model_routing:' + ROW + String.raw`applyDoctorOverride\(overrideMap,\s*'model_routing',\s*modelRoutingCheck\(root\)\)`).test(DOCTOR_ALL_SRC));
t('model_routing: the REAL project is consistent (frontmatter == agent-model-map == tool-policy)', (() => { const r = D.modelRoutingCheck(REAL_ROOT); return r.ok === true && r.applicable === true && r.checked >= 19; })());
t('model_routing: GREEN fixture without routing files -> applicable:false, ok:true, and it says so on its summary line',
  greenRep.checks.model_routing && greenRep.checks.model_routing.applicable === false && greenRep.checks.model_routing.ok === true && /model routing\s+n\/a/.test(D.printSummary(greenRep)));
const MR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-modelrouting-'));
fs.cpSync(GREEN_ROOT, MR_ROOT, { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'FORGE_MODEL_ROUTING.json'), path.join(MR_ROOT, '.claude', 'FORGE_MODEL_ROUTING.json'));
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-model-map.json'), path.join(MR_ROOT, '.claude', 'config', 'agents', 'agent-model-map.json'));
const mrGreenRep = D.runDoctor(MR_ROOT);
t('model_routing: a fixture WITH the real routing files is green and the doctor stays ok', mrGreenRep.ok === true && mrGreenRep.checks.model_routing.ok === true && mrGreenRep.checks.model_routing.applicable === true);
{
  const mm = path.join(MR_ROOT, '.claude', 'config', 'agents', 'agent-model-map.json');
  const j = JSON.parse(fs.readFileSync(mm, 'utf8'));
  j.agents['build-boss'].claudeEffort = 'xhigh'; // frontmatter still says medium
  fs.writeFileSync(mm, JSON.stringify(j, null, 2));
}
const mrRedRep = D.runDoctor(MR_ROOT);
t('model_routing DRIFT: one claudeEffort out of line with the frontmatter -> checks.model_routing red AND doctor.ok false',
  mrRedRep.ok === false && mrRedRep.checks.model_routing.ok === false && mrRedRep.checks.model_routing.violations.some((v) => v.kind === 'effort-drift' && v.agent === 'build-boss'));
t('skill_adapters: a fixture root is n/a (the machine adapters never run for it) and prints a ✓ n/a line', greenRep.checks.skill_adapters && greenRep.checks.skill_adapters.applicable === false && /✓ skill adapters\s+n\/a/.test(D.printSummary(greenRep)));
t('skill_adapters: a broken adapter prints a ✗ line naming it', /✗ skill adapters\s+graphify: forge-graphify\.cjs exit 1/.test(D.printSummary({ root: 'x', ok: false, checks: Object.assign({}, greenRep.checks, { skill_adapters: { ok: false, applicable: true, enforced: true, broken: ['graphify'], adapters: [], reason: 'graphify: forge-graphify.cjs exit 1 (x)' } }), advisory: {} })));
t('skill_adapters: a stale-session warning (claude-mem launcher only on the user PATH) is PRINTED on the ✓ line, never hidden (2026-11-05 review M1)', /✓ skill adapters\s+claude-mem ok \(0 ms\) · WARN claude-mem: .*record nothing/.test(D.printSummary({ root: 'x', ok: true, checks: Object.assign({}, greenRep.checks, { skill_adapters: { ok: true, applicable: true, enforced: true, broken: [], warnings: ['claude-mem: claude-mem hook launcher is on the user PATH but not on this process PATH: this Claude Code session started before it was added, so its claude-mem hooks record nothing'], adapters: [{ id: 'claude-mem', applicable: true, ok: true, ms: 0 }], reason: 'warn: x' } }), advisory: {} })));
t('model_routing DRIFT: printSummary names the violation on a ✗ line', /✗ model routing\s+.*effort-drift/.test(D.printSummary(mrRedRep)));
fs.mkdirSync(path.join(MR_ROOT, '.claude', 'config', 'orchestration'), { recursive: true });
fs.writeFileSync(path.join(MR_ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({ doctor_check_overrides: [{ check: 'model_routing', reason: 'fixture: owner accepted a temporary drift', by: 'test' }] }));
const mrOvRep = D.runDoctor(MR_ROOT);
t('model_routing: an owner override passes it VISIBLY ([OVERRIDDEN ...] tag), never silently',
  mrOvRep.checks.model_routing.ok === true && mrOvRep.checks.model_routing.overridden === true && /model routing.*\[OVERRIDDEN by test/.test(D.printSummary(mrOvRep)));
try { fs.rmSync(MR_ROOT, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }

// =====================================================================================================
// N5 (2026-09-26 laptop re-audit) — agentsCheck()'s `memory:` requirement is now CLASS-AWARE:
// Claude Code grants Write+Edit to any agent-md carrying `memory: project`, regardless of its `tools:`
// line, so a class whose policy forbids Write (read-only-audit, exec-reviewer) must never carry that line,
// and every other class must. Both directions are proven against a real GREEN_ROOT-style agents/ copy —
// never invented fixture text — so a genuine drift in the real agent-md files is what this test protects.
// =====================================================================================================
const AGENTSCHK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-agentscheck-'));
copyShippedAgents(path.join(AGENTSCHK_ROOT, '.claude', 'agents'));
sanitizeReadOnlyAgentMemory(path.join(AGENTSCHK_ROOT, '.claude', 'agents'));
fs.mkdirSync(path.join(AGENTSCHK_ROOT, '.claude', 'config', 'agents'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), path.join(AGENTSCHK_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
const agentsCleanRep = D.agentsCheck(AGENTSCHK_ROOT);
t('agentsCheck: with every read-only agent correctly missing `memory:`, badFrontmatter is empty and the check is green', agentsCleanRep.badFrontmatter.length === 0 && agentsCleanRep.ok === true, JSON.stringify(agentsCleanRep.badFrontmatter));

// the project's own, never-synced agent-tool-policy.user.json may only ADD agents (an
// existing shipped class, tools that class allows) — never redefine a shipped agent, add or change a class, or set
// any other key. 26H2's own idea-reviewer agent kept 4 suites red because only the shipped policy was read.
{
  const ovRoot = (name, overlay) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-overlay-' + name + '-'));
    fs.cpSync(path.join(AGENTSCHK_ROOT, '.claude'), path.join(r, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(r, '.claude', 'agents', 'idea-reviewer.md'), '---\nname: idea-reviewer\ndescription: a project-own read-only reviewer\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nReviews ideas.\n');
    if (overlay !== undefined) fs.writeFileSync(path.join(r, '.claude', 'config', 'agents', 'agent-tool-policy.user.json'), typeof overlay === 'string' ? overlay : JSON.stringify(overlay));
    return r;
  };
  const idea = { class: 'read-only-audit', tools: ['Read', 'Grep', 'Glob'], model: 'sonnet', rationale: 'project-own reviewer' };
  const none = D.agentsCheck(ovRoot('none'));
  t('SYNC-04: a project-own agent with NO overlay is a tool-policy gap (the 26H2 red baseline, reproduced)', none.ok === false && none.toolPolicy.missingPolicy.includes('idea-reviewer'));
  const goodRoot = ovRoot('good', { _doc: 'project agents', agents: { 'idea-reviewer': idea } });
  const shippedBefore = fs.readFileSync(path.join(goodRoot, '.claude', 'config', 'agents', 'agent-tool-policy.json'), 'utf8');
  const good = D.agentsCheck(goodRoot);
  t('SYNC-04: the overlay ADDS the project agent -> the agents check is green and names the added agent', good.ok === true && (good.toolPolicy.overlayAdded || []).includes('idea-reviewer'));
  t('SYNC-04: the shipped agent-tool-policy.json is byte-identical after the merge (the overlay is read, never written into it)', fs.readFileSync(path.join(goodRoot, '.claude', 'config', 'agents', 'agent-tool-policy.json'), 'utf8') === shippedBefore);
  t('SYNC-04: the summary line names the project agent the overlay added', /tool-policy clean \(\+1 project agent\(s\) from agent-tool-policy\.user\.json: idea-reviewer\)/.test(D.printSummary({ root: goodRoot, ok: true, checks: Object.assign({}, greenRep.checks, { agents: good }), advisory: {} })));
  const loosen = D.agentsCheck(ovRoot('loosen', { agents: { 'idea-reviewer': idea, 'review-boss': { class: 'full-build', tools: ['Read', 'Write', 'Edit', 'Bash', 'PowerShell', 'Grep', 'Glob'] } } }));
  t('SYNC-04: redefining (loosening) a SHIPPED agent is rejected and fails the check', loosen.ok === false && (loosen.toolPolicy.overlayProblems || []).some((p) => /review-boss/.test(p) && /never redefine/.test(p)));
  const newClass = D.agentsCheck(ovRoot('class', { classes: { 'god-mode': { tools: ['Bash'], forbidden: [] } }, agents: { 'idea-reviewer': idea } }));
  t('SYNC-04: an overlay that tries to add/change a CLASS is rejected (a class is template-owned)', newClass.ok === false && (newClass.toolPolicy.overlayProblems || []).some((p) => /"classes" is not allowed/.test(p)));
  const unknownClass = D.agentsCheck(ovRoot('unknown', { agents: { 'idea-reviewer': { class: 'god-mode', tools: ['Read'] } } }));
  t('SYNC-04: an agent naming a class the shipped policy does not have is rejected', unknownClass.ok === false && (unknownClass.toolPolicy.overlayProblems || []).some((p) => /god-mode/.test(p)));
  const forbidden = D.agentsCheck(ovRoot('forbidden', { agents: { 'idea-reviewer': { class: 'read-only-audit', tools: ['Read', 'Grep', 'Glob', 'Bash'] } } }));
  t('SYNC-04: a tool the chosen class forbids (Bash for read-only-audit) is rejected', forbidden.ok === false && (forbidden.toolPolicy.overlayProblems || []).some((p) => /Bash/.test(p) && /forbids/.test(p)));
  const broken = D.agentsCheck(ovRoot('broken', '{ not json'));
  t('SYNC-04: a malformed overlay fails visibly (never silently ignored)', broken.ok === false && (broken.toolPolicy.overlayProblems || []).some((p) => /not valid JSON/.test(p)));
  const base = JSON.parse(shippedBefore);
  const snap = JSON.stringify(base);
  const merged = D.mergeToolPolicyOverlay(base, { agents: { 'idea-reviewer': idea } });
  t('SYNC-04: mergeToolPolicyOverlay is pure — the shipped policy object is not mutated, the merge is a copy', JSON.stringify(base) === snap && merged.policy !== base && !!merged.policy.agents['idea-reviewer'] && !base.agents['idea-reviewer']);
  t('SYNC-04: no overlay -> the shipped policy is returned as-is', D.mergeToolPolicyOverlay(base, null).policy === base);
}

// the REGRESSION this whole fix exists to catch: a read-only-audit agent (review-boss) REGAINS `memory:
// project` in its frontmatter — agentsCheck() must flag it, exactly the way N5 was originally found.
const REGROW_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-agentscheck-regrow-'));
copyShippedAgents(path.join(REGROW_ROOT, '.claude', 'agents'));
sanitizeReadOnlyAgentMemory(path.join(REGROW_ROOT, '.claude', 'agents'));
fs.mkdirSync(path.join(REGROW_ROOT, '.claude', 'config', 'agents'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), path.join(REGROW_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
const reviewBossPath = path.join(REGROW_ROOT, '.claude', 'agents', 'review-boss.md');
const reviewBossText = fs.readFileSync(reviewBossPath, 'utf8');
assert.ok(/^---\r?\n/.test(reviewBossText), 'fixture assumption: review-boss.md starts with a frontmatter block');
fs.writeFileSync(reviewBossPath, reviewBossText.replace(/^---\r?\n/, '---\nmemory: project\n'), 'utf8');
const agentsRegrowRep = D.agentsCheck(REGROW_ROOT);
// an agent whose model is not a Claude Code alias is never loaded; the doctor must say so.
const REAL_AGENTS = D.agentsCheck(path.resolve(__dirname, '..', '..'));
t('agentsCheck: every shipped agent file uses a model alias Claude Code loads (opus/sonnet/haiku/fable/inherit)', Array.isArray(REAL_AGENTS.unloadableModel) && REAL_AGENTS.unloadableModel.length === 0, JSON.stringify(REAL_AGENTS.unloadableModel));
const UNLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-unloadable-'));
fs.mkdirSync(path.join(UNLOAD_ROOT, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(UNLOAD_ROOT, '.claude', 'agents', 'my-helper.md'), '---\nname: my-helper\ndescription: x\ntools: Read\nmodel: claude-opus-5-5\n---\nbody\n');
const unloadRep = D.agentsCheck(UNLOAD_ROOT);
t('agentsCheck: a full model id (claude-opus-5-5) is reported as not loadable', unloadRep.unloadableModel.some((u) => u.agent === 'my-helper' && u.model === 'claude-opus-5-5'), JSON.stringify(unloadRep.unloadableModel));
t('agentsCheck: a read-only-audit agent (review-boss) regaining `memory: project` is caught in badFrontmatter', agentsRegrowRep.badFrontmatter.includes('review-boss') && agentsRegrowRep.ok === false, JSON.stringify(agentsRegrowRep.badFrontmatter));
t('agentsCheck: the regression is isolated to review-boss — every other Boss stays clean', agentsRegrowRep.badFrontmatter.length === 1, JSON.stringify(agentsRegrowRep.badFrontmatter));

// the mirror case: a full-build agent (build-boss) LOSING its required `memory: project` is caught too —
// class-awareness cuts both ways, it is not a one-directional relaxation of the old blanket requirement.
const LOSE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-agentscheck-lose-'));
copyShippedAgents(path.join(LOSE_ROOT, '.claude', 'agents'));
sanitizeReadOnlyAgentMemory(path.join(LOSE_ROOT, '.claude', 'agents'));
fs.mkdirSync(path.join(LOSE_ROOT, '.claude', 'config', 'agents'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), path.join(LOSE_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
const buildBossPath = path.join(LOSE_ROOT, '.claude', 'agents', 'build-boss.md');
const buildBossText = fs.readFileSync(buildBossPath, 'utf8');
assert.ok(/^memory:\s*project\r?\n/m.test(buildBossText), 'fixture assumption: build-boss.md currently carries memory: project');
fs.writeFileSync(buildBossPath, buildBossText.replace(/^memory:\s*.*\r?\n/m, ''), 'utf8');
const agentsLoseRep = D.agentsCheck(LOSE_ROOT);
t('agentsCheck: a full-build agent (build-boss) LOSING its required `memory: project` is also caught', agentsLoseRep.badFrontmatter.includes('build-boss') && agentsLoseRep.ok === false, JSON.stringify(agentsLoseRep.badFrontmatter));

t('memoryAllowedForClass: returns false for read-only-audit and exec-reviewer, true for write-no-exec and full-build, null when unresolvable', (() => {
  const pf = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), 'utf8'));
  return D.memoryAllowedForClass(pf, 'review-boss') === false
    && D.memoryAllowedForClass(pf, 'security-boss') === false
    && D.memoryAllowedForClass(pf, 'verify-boss') === false
    && D.memoryAllowedForClass(pf, 'boss') === true
    && D.memoryAllowedForClass(pf, 'build-boss') === true
    && D.memoryAllowedForClass(null, 'boss') === null
    && D.memoryAllowedForClass(pf, 'totally-unknown-agent') === null;
})());

// =====================================================================================================
// 2026-07-15 KRITIEKE FIX-RONDE — 3 bugs found by an adversarial break-swarm, each reproduced twice
// against the REAL tools before fixing. See forge-certify.test.cjs for the certify-side mirror tests.
// =====================================================================================================

// --- BUG 1 [HIGH, security]: leak_scan missed a REAL secret containing '+' (misclassified as "regex
// source"). Repro: a genuine 2048-bit RSA PEM (crypto.generateKeyPairSync) + a '+'-containing DB password
// must both be flagged; regex-source strings and FAKE fixtures must still NOT be flagged (no regression).
const BUG1_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug1-'));
const { privateKey: BUG1_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
fs.writeFileSync(path.join(BUG1_ROOT, 'id_rsa.pem'), BUG1_PEM);
const BUG1_DB_PASS = synthKey('bug1-pass-a', 9) + '+' + synthKey('bug1-pass-b', 8); // synthetic test password (FAKE) with a '+'
fs.writeFileSync(path.join(BUG1_ROOT, 'prod.env'), 'DATABASE_URL=postgres://dbuser:' + BUG1_DB_PASS + '@host:5432/app\n'); // synthetic (FAKE), built at runtime
const bug1Leak = D.leakScan(BUG1_ROOT);
t('BUG1 FIX: a REAL RSA private key (PEM) is flagged, not waved through for containing base64 "+"', bug1Leak.hits.some((h) => h.file.endsWith('id_rsa.pem') && h.pattern === 'pem-private-key'));
t('BUG1 FIX: a REAL DB password containing "+" in a connection string is flagged', bug1Leak.hits.some((h) => h.file.endsWith('prod.env') && h.pattern === 'url-embedded-credentials'));
t('BUG1 FIX: leakScan is ok=false when both real secrets are present', bug1Leak.ok === false);
t('BUG1 FIX: leakScan never echoes the raw PEM or password text', !JSON.stringify(bug1Leak).includes(BUG1_DB_PASS) && !JSON.stringify(bug1Leak).includes(BUG1_PEM.trim()));

// regression (c): a FAKE-marked fixture must still NOT be flagged
const BUG1_FAKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug1-fake-'));
fs.writeFileSync(path.join(BUG1_FAKE_ROOT, 'fixture.md'), 'sample = nvapi-FAKEFAKEFAKEFAKE1234567890\n');
const bug1FakeLeak = D.leakScan(BUG1_FAKE_ROOT);
t('BUG1 regression: a FAKE-marked fixture is still NOT flagged', bug1FakeLeak.ok === true && bug1FakeLeak.hits.length === 0);

// =====================================================================================================
// 2026-07-15 TWEEDE FIX-RONDE — ISSUE 1 [SYSTEM-BREAKING + HIGH]: round 1's
// REGEX_SOURCE_RE character-shape filter (`/\\|\{\d+,?\d*\}|\[[^\]\r\n]{1,200}\]/`) was ITSELF fundamentally
// broken: it tried to tell a regex SOURCE apart from a secret VALUE by looking at loose characters
// (backslash / `{n,m}` / `[...]`), but a genuine secret can legitimately contain every one of those. Fixed
// by replacing it with isPatternDefinitionContext() — a CONTEXT check (is this match literally inside
// `/…/` or `RegExp(...)` syntax on its own source line?), never a character-shape guess. See the MUTATION
// PROOF section further down: reinstating the old REGEX_SOURCE_RE filter makes REPRO A/B below go RED.
// =====================================================================================================

// REPRO A [SYSTEM-BREAKING, a NEW gap introduced by round 1's own fix]: a real PEM private key inlined in
// JSON, its real newlines becoming literal `\n` escape sequences via JSON.stringify — the exact shape of a
// committed GCP service-account key (creds.json). The whole PEM match sits on ONE physical line (no real
// newline bytes), so it is NOT inside any `/…/` regex-literal syntax — it must be flagged.
const ISSUE1A_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue1a-'));
const { privateKey: ISSUE1A_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
fs.writeFileSync(path.join(ISSUE1A_ROOT, 'creds.json'), JSON.stringify({ private_key: ISSUE1A_PEM.trim() }) + '\n');
const issue1aLeak = D.leakScan(ISSUE1A_ROOT);
t('ISSUE1 REPRO A FIX: a PEM key inlined in JSON with \\n escapes (single physical line, GCP-service-account shape) IS flagged', issue1aLeak.hits.some((h) => h.file.endsWith('creds.json') && h.pattern === 'pem-private-key'));
t('ISSUE1 REPRO A FIX: leakScan ok=false', issue1aLeak.ok === false);
t('ISSUE1 REPRO A: leakScan never echoes the raw PEM text', !JSON.stringify(issue1aLeak).includes(ISSUE1A_PEM.trim()));

// REPRO B [HIGH]: a connection-string password containing `[Secret]`, a literal backslash, and a
// `{2,5}`-shaped substring all at once — every character class the old REGEX_SOURCE_RE mistook for "a
// regex source" packed into one real value.
const ISSUE1B_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue1b-'));
const ISSUE1B_PASSWORD = 'My[Secret]Pa\\ss{2,5}Word99xx'; // contains [ ] \ and {n,m} — all "regex-looking", all real
fs.writeFileSync(path.join(ISSUE1B_ROOT, 'prod.env'), 'DATABASE_URL=postgres://admin:' + ISSUE1B_PASSWORD + '@dbhost:5432/prod\n');
const issue1bLeak = D.leakScan(ISSUE1B_ROOT);
t('ISSUE1 REPRO B FIX: a DB password containing "[Secret]" + backslash + "{2,5}" IS flagged', issue1bLeak.hits.some((h) => h.file.endsWith('prod.env') && h.pattern === 'url-embedded-credentials'));
t('ISSUE1 REPRO B FIX: leakScan ok=false', issue1bLeak.ok === false);
t('ISSUE1 REPRO B: leakScan never echoes the raw password', !JSON.stringify(issue1bLeak).includes(ISSUE1B_PASSWORD));

// parity: JWT / AWS AKIA / OpenAI-style sk- / NVIDIA nvapi- keys must ALL still be flagged (no regression
// from the redesign) — plus the existing BUG1 PEM + '+' password above already covers "gewone PEM" and
// "DB-wachtwoord met '+'".
const PARITY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsImlhdCI6MTIzNDU2Nzg5MH0.k3JzXow9pQAbCdEfGhIjKlMnOpQrStUvWxYz1234567890';
const PARITY_SK = 'sk-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop1234567890';
// Samengesteld, niet als literal: de waarde is bij het draaien identiek (AKIA + 16 hoofdletters),
// maar de repository bevat geen string die een scanner als AWS-sleutel leest.
const PARITY_AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const PARITY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue1-parity-'));
fs.writeFileSync(path.join(PARITY_ROOT, 'secrets.txt'), [
  'jwt=' + PARITY_JWT,
  'openai=' + PARITY_SK,
  'aws=' + PARITY_AKIA,
  'nvidia=' + REAL,
].join('\n') + '\n');
const parityLeak = D.leakScan(PARITY_ROOT);
t('ISSUE1 parity: JWT (eyJ) flagged', parityLeak.hits.some((h) => h.pattern === 'jwt'));
t('ISSUE1 parity: OpenAI-style sk- key flagged', parityLeak.hits.some((h) => h.pattern === 'openai-style-key'));
t('ISSUE1 parity: AWS AKIA key flagged', parityLeak.hits.some((h) => h.pattern === 'aws-access-key'));
t('ISSUE1 parity: NVIDIA nvapi- key flagged', parityLeak.hits.some((h) => h.pattern === 'nvidia-nvapi-key'));
t('ISSUE1 parity: leakScan never echoes any raw secret', !JSON.stringify(parityLeak).includes(PARITY_JWT) && !JSON.stringify(parityLeak).includes(PARITY_SK));

// no false positive on the REAL forge-store.cjs (the actual SECRET_PATTERNS regex-literal definitions) and
// the REAL forge-doctor.cjs (the short "sk-"/"nvapi-key" LABEL strings in secretLabel()) — the two files the
// task explicitly requires stay clean under the new context-based filter.
const REALCODE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue1-realcode-'));
const REALCODE_BIN = path.join(REALCODE_ROOT, '.claude', 'forge-bin');       // real repo-relative path (4th round: exemption is path-gated)
fs.mkdirSync(REALCODE_BIN, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'forge-store.cjs'), path.join(REALCODE_BIN, 'forge-store.cjs'));
copyDoctorInto(REALCODE_BIN);
const realcodeLeak = D.leakScan(REALCODE_ROOT);
t('ISSUE1 no false positive: leakScan on the REAL forge-store.cjs + forge-doctor.cjs (at their real .claude/forge-bin/ path) is clean (SECRET_PATTERNS sources + sk-/nvapi-key labels correctly exempted)', realcodeLeak.ok === true && realcodeLeak.hits.length === 0, JSON.stringify(realcodeLeak.hits));

// fail-closed, REVISED behavior (deliberate change from round 1): a secret-SHAPED string merely mentioned
// IN PROSE (no actual `/…/` or RegExp(...) JS syntax around it) is now correctly FLAGGED, not silently
// exempted — round 1's over-broad character heuristic exempted ANY regex-shaped text regardless of
// context, which is exactly what let REPRO A/B slip through. The owner's explicit instruction: "BIJ TWIJFEL:
// FLAG". (Note: the literal SECRET_PATTERNS source strings themselves, e.g. "nvapi-[A-Za-z0-9_-]+", do not
// actually self-match their own pattern at all — the "[" right after "nvapi-" fails that pattern's own
// character class — so a prose mention of the SOURCE syntax verbatim produces no hit either way; this test
// instead uses a real key-SHAPED value in prose to prove the context gate, not the source syntax itself.)
const BUG1_DOC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug1-doc-'));
fs.writeFileSync(path.join(BUG1_DOC_ROOT, 'patterns-doc.md'), 'aws key shape looks like ' + PARITY_AKIA + ' when documented in prose\n');
const bug1DocLeak = D.leakScan(BUG1_DOC_ROOT);
t('ISSUE1 fail-closed (deliberate change): a secret-shaped value merely mentioned in PROSE (no /…/ syntax) is now correctly FLAGGED, not silently exempted', bug1DocLeak.hits.length > 0);

// SUPERSEDED by the 3rd fix round (see the ROUND3 whitelist-gate tests further down): a secret-shaped string
// written as genuine `/pattern/flags` JS syntax is ONLY exempted when the FILE's basename is one of the
// known pattern-definition source files (forge-store.cjs / forge-doctor.cjs) — an arbitrary .cjs data file
// (e.g. "patterns.cjs") using the exact same regex-literal syntax is now correctly FLAGGED, not exempted,
// because isPatternDefinitionContext() is caller-gated by basename in leakScan() and no longer decides
// exemption scope on its own. This closes ROUND3 MISS3 (a real secret disguised as a regex literal in an
// ordinary .js/.cjs file used to slip through the old file-agnostic text-shape check).
const BUG1_REGEXLIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug1-regexlit-'));
fs.writeFileSync(path.join(BUG1_REGEXLIT_ROOT, 'patterns.cjs'), "const p = /" + PARITY_AKIA + "/g; // a real-key-shaped PATTERN DEFINITION, not a value\nmodule.exports = p;\n");
const bug1RegexLitLeak = D.leakScan(BUG1_REGEXLIT_ROOT);
t('ROUND3 whitelist-gate FIX: /pattern/flags JS syntax in a NON-whitelisted basename (patterns.cjs) is now FLAGGED, not exempted', bug1RegexLitLeak.ok === false && bug1RegexLitLeak.hits.some((h) => h.file.endsWith('patterns.cjs')));

// direct unit coverage of isPatternDefinitionContext()
{
  const ctxMatch = PARITY_AKIA;
  const ctxLine1 = 'const p = /' + PARITY_AKIA + '/g;';
  t('isPatternDefinitionContext: true for a /pattern/flags literal on its own line', D.isPatternDefinitionContext(ctxLine1, ctxLine1.indexOf(ctxMatch), ctxMatch.length) === true);
  const ctxLine2 = 'const p = new RegExp("' + PARITY_AKIA + '");';
  t('isPatternDefinitionContext: true for new RegExp("pattern")', D.isPatternDefinitionContext(ctxLine2, ctxLine2.indexOf(ctxMatch), ctxMatch.length) === true);
  const ctxLine3 = '{"k":"' + PARITY_AKIA + '"}';
  t('isPatternDefinitionContext: false for a JSON string VALUE (REPRO A/B shape) — no /…/ or RegExp(...) syntax', D.isPatternDefinitionContext(ctxLine3, ctxLine3.indexOf(ctxMatch), ctxMatch.length) === false);
  const ctxMultiline = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIB1234567890ABCDEF\n-----END PRIVATE KEY-----';
  t('isPatternDefinitionContext: false when the match spans multiple physical lines (a real JS regex literal never does)', D.isPatternDefinitionContext(ctxMultiline, 0, ctxMultiline.length) === false);
}

// direct unit coverage of the (now pure content-only) looksLikeRealSecret — no more regex-source judgement
// here at all; that job belongs solely to isPatternDefinitionContext (tested above).
t('looksLikeRealSecret: a regex-shaped string (char class) is now content-ACCEPTED — context decides separately', D.looksLikeRealSecret('nvapi-[A-Za-z0-9_-]+') === true);
t('looksLikeRealSecret: a regex-shaped string (quantifier brace, no repeated filler) is also content-ACCEPTED', D.looksLikeRealSecret('sk-ABCDEFGHIJKLMNOP{20,}') === true);
t('looksLikeRealSecret: STILL rejects genuine repeated-filler (7+ same char), independent of regex shape', D.looksLikeRealSecret('sk-AAAAAAAAAAAAAAAA{20,}') === false);
// Samengesteld i.p.v. als literal: 40 tekens base64 met een '+' leest voor een scanner als een AWS
// secret access key. De waarde is bij het draaien identiek, dus de test bewijst nog exact hetzelfde.
const B64_LIKE = 'Xk9wPz2LqMn7Rt4Vb' + 'AbCdEfGhIjKlMn';
t('looksLikeRealSecret: ACCEPTS a real-looking base64 value containing "+"', D.looksLikeRealSecret(B64_LIKE + '+opqrstuv') === true);
t('looksLikeRealSecret: ACCEPTS a real-looking value containing "=" (base64 padding)', D.looksLikeRealSecret(B64_LIKE + '==') === true);

// --- BUG 2 [HIGH]: log-event on a LEGACY run (no entry_hash) used to make chainCheck flip red on a benign
// continuation event. Repro: a real legacy run (2 events, no hash) + 1 event appended via the REAL
// log-event.cjs must NOT be reported broken; a genuine tamper in the chained section must STILL be caught.
function bug2WriteLegacyRun(root, id, events) {
  const dir = path.join(root, '.claude', 'forge-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}
const REAL_LOG_EVENT = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
function bug2PlantLogEvent(root) {
  const dashDir = path.join(root, '.claude', 'forge-dashboard');
  fs.mkdirSync(dashDir, { recursive: true });
  const copy = path.join(dashDir, 'log-event.cjs');
  fs.copyFileSync(REAL_LOG_EVENT, copy);
  return copy;
}

const BUG2_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug2-'));
bug2WriteLegacyRun(BUG2_ROOT, 'legacy-continued', [
  { run_id: 'legacy-continued', event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
  { run_id: 'legacy-continued', event_type: 'agent_note', agent: 'orchestrator', note: 'legacy note', timestamp: '2026-01-01T00:00:01.000Z' },
]);
const bug2Before = D.chainCheck(BUG2_ROOT);
t('BUG2 sanity: a pure legacy run (no entry_hash anywhere) is skipped, not broken', bug2Before.ok === true && bug2Before.chained === 0);
const bug2LogEvent = bug2PlantLogEvent(BUG2_ROOT);
const bug2Append = spawnSync(process.execPath, [bug2LogEvent, 'legacy-continued', 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'continuation after adopting hash chain' })], { encoding: 'utf8' });
t('BUG2 sanity: the real log-event.cjs accepted the continuation event (exit 0)', bug2Append.status === 0);
const bug2After = D.chainCheck(BUG2_ROOT);
t('BUG2 FIX: a benign continuation of a legacy run is NOT reported as broken', bug2After.ok === true, JSON.stringify(bug2After));
t('BUG2 FIX: the continuation is counted as 1 chained run (validated from its own start, not index 0)', bug2After.chained === 1 && bug2After.broken.length === 0);

// requirement (b): a REAL tamper within the chained section of a legacy+continued run must STILL be caught
const BUG2B_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug2b-'));
bug2WriteLegacyRun(BUG2B_ROOT, 'legacy-tampered', [
  { run_id: 'legacy-tampered', event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
  { run_id: 'legacy-tampered', event_type: 'agent_note', agent: 'orchestrator', note: 'legacy note', timestamp: '2026-01-01T00:00:01.000Z' },
]);
const bug2bLogEvent = bug2PlantLogEvent(BUG2B_ROOT);
spawnSync(process.execPath, [bug2bLogEvent, 'legacy-tampered', 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'first chained event' })], { encoding: 'utf8' });
spawnSync(process.execPath, [bug2bLogEvent, 'legacy-tampered', 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'second chained event' })], { encoding: 'utf8' });
const bug2bCleanCheck = D.chainCheck(BUG2B_ROOT);
t('BUG2 requirement (b) sanity: untampered legacy+continuation (2 chained events) is clean', bug2bCleanCheck.ok === true);
const bug2bEvFile = path.join(BUG2B_ROOT, '.claude', 'forge-runs', 'legacy-tampered', 'events.jsonl');
const bug2bLines = fs.readFileSync(bug2bEvFile, 'utf8').split('\n').filter(Boolean);
const bug2bLastEv = JSON.parse(bug2bLines[bug2bLines.length - 1]);
bug2bLastEv.note = 'TAMPERED AFTER HASHING';
bug2bLines[bug2bLines.length - 1] = JSON.stringify(bug2bLastEv);
fs.writeFileSync(bug2bEvFile, bug2bLines.join('\n') + '\n');
const bug2bTampered = D.chainCheck(BUG2B_ROOT);
t('BUG2 requirement (b) CRITICAL: a real tamper in the chained section is STILL caught (tamper-detection NOT weakened)', bug2bTampered.ok === false && /self-hash mismatch/.test(bug2bTampered.broken[0].reason));

// requirement: log-event.cjs's prev_hash lookup searches BACKWARD past a non-hashed line for the nearest
// REAL chained ancestor, instead of trusting only the literal last line (the task's explicit fix option:
// "prev_hash correct naar de entry_hash van de vorige chained event of 'genesis'"). Contrived-but-provable
// fixture: [chained eventA] + [blank line] + [an unhashed event B] as the file's CURRENT state, then log-
// event.cjs appends event C — the new event's prev_hash must point at eventA's real entry_hash, not genesis
// (which would silently abandon/fork the real chain).
{
  const LG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-logevent-backsearch-'));
  const lgRunId = 'backsearch-run';
  const lgRunDir = path.join(LG_ROOT, '.claude', 'forge-runs', lgRunId);
  fs.mkdirSync(lgRunDir, { recursive: true });
  const eventA = { run_id: lgRunId, event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' };
  eventA.prev_hash = 'genesis:' + lgRunId;
  const canonA = (() => { const k = Object.keys(eventA).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = eventA[x]; return JSON.stringify(o); })();
  eventA.entry_hash = crypto.createHash('sha256').update(canonA + eventA.prev_hash).digest('hex');
  const eventB = { run_id: lgRunId, event_type: 'agent_note', agent: 'orchestrator', note: 'unhashed event after A', timestamp: '2026-01-01T00:00:01.000Z' }; // no entry_hash
  fs.writeFileSync(path.join(lgRunDir, 'events.jsonl'), [JSON.stringify(eventA), '', JSON.stringify(eventB)].join('\n') + '\n');

  const lgLogEvent = bug2PlantLogEvent(LG_ROOT);
  const lgAppend = spawnSync(process.execPath, [lgLogEvent, lgRunId, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'event C' })], { encoding: 'utf8' });
  t('log-event.cjs BACKSEARCH sanity: event C was appended (exit 0)', lgAppend.status === 0);
  const lgLines = fs.readFileSync(path.join(lgRunDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  const eventC = JSON.parse(lgLines[lgLines.length - 1]);
  t('log-event.cjs BACKSEARCH FIX: prev_hash points to the nearest REAL chained ancestor (event A), not genesis', eventC.prev_hash === eventA.entry_hash);
}

// --- BUG 3 [MEDIUM]: doctor vs certify disagreed on a single internal blank line in events.jsonl.
// Repro: a real hash-chained run with 1 blank line inserted mid-file must be tolerated (not "unparseable"),
// while a genuinely corrupt non-blank line must still be flagged.
function bug3ChainCanon(ev) { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev[x]; return JSON.stringify(o); }
function bug3BuildChain(runId, rawEvents) {
  let prevHash = 'genesis:' + runId;
  const out = [];
  for (const raw of rawEvents) {
    const ev = Object.assign({ run_id: runId }, raw);
    ev.prev_hash = prevHash;
    ev.entry_hash = crypto.createHash('sha256').update(bug3ChainCanon(ev) + prevHash).digest('hex');
    prevHash = ev.entry_hash;
    out.push(ev);
  }
  return out;
}
const BUG3_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug3-'));
const bug3Evs = bug3BuildChain('chained-blankline', [
  { event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
  { event_type: 'subagent_completed', agent: 'build-boss', task: 'WP1', status: 'completed', timestamp: '2026-01-01T00:00:01.000Z' },
  { event_type: 'run_completed', agent: 'orchestrator', timestamp: '2026-01-01T00:00:02.000Z' },
]);
const bug3Lines = bug3Evs.map((e) => JSON.stringify(e));
bug3Lines.splice(1, 0, ''); // 1 blank line inserted in the MIDDLE
const bug3Dir = path.join(BUG3_ROOT, '.claude', 'forge-runs', 'chained-blankline');
fs.mkdirSync(bug3Dir, { recursive: true });
fs.writeFileSync(path.join(bug3Dir, 'events.jsonl'), bug3Lines.join('\n') + '\n');
const bug3Result = D.chainCheck(BUG3_ROOT);
t('BUG3 FIX: an internal blank line is tolerated (chainCheck ok=true, not "unparseable")', bug3Result.ok === true && bug3Result.chained === 1);

// requirement (b): a genuinely corrupt (non-blank) JSON line must still be flagged, same as before
const BUG3B_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug3b-'));
const bug3bEvs = bug3BuildChain('chained-corrupt', [
  { event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
  { event_type: 'subagent_completed', agent: 'build-boss', task: 'WP1', status: 'completed', timestamp: '2026-01-01T00:00:01.000Z' },
]);
const bug3bLines = bug3bEvs.map((e) => JSON.stringify(e));
bug3bLines.splice(1, 0, 'THIS IS NOT JSON {{{'); // genuinely corrupt, non-blank
const bug3bDir = path.join(BUG3B_ROOT, '.claude', 'forge-runs', 'chained-corrupt');
fs.mkdirSync(bug3bDir, { recursive: true });
fs.writeFileSync(path.join(bug3bDir, 'events.jsonl'), bug3bLines.join('\n') + '\n');
const bug3bResult = D.chainCheck(BUG3B_ROOT);
t('BUG3 requirement (b): a genuinely corrupt non-blank line is STILL flagged (not weakened)', bug3bResult.ok === false && /unparseable/.test(bug3bResult.broken[0].reason));

// =====================================================================================================
// 2026-07-15 TWEEDE FIX-RONDE — ISSUE 2 [HIGH]: doctor.chainCheck and forge-certify disagreed on a
// events.jsonl line that is VALID JSON but NOT a plain object (a bare number/array/string/null/bool).
// Round 1's parseEventsJsonlLenient accepted it as a fake "event" with no entry_hash — chainCheck just
// skipped past it when locating the chain's start index, so the run still validated ok:true — while
// certify.readEventsJsonl has ALWAYS counted that exact line shape as malformed -> NOT CERTIFIED. OPPOSITE
// verdicts on identical bytes. Fixed by making parseEventsJsonlLenient throw on a non-plain-object line,
// mirroring certify's own classification exactly (proven below by comparing against certify's real module
// functions, not a re-implementation). Never touches forge-certify.cjs itself (read-only reference).
// =====================================================================================================
const certifyRef = require('./forge-certify.cjs');
function issue2BuildChain(runId, rawEvents) {
  let prevHash = 'genesis:' + runId;
  const out = [];
  for (const raw of rawEvents) {
    const ev = Object.assign({ run_id: runId }, raw);
    ev.prev_hash = prevHash;
    const canon = (() => { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev[x]; return JSON.stringify(o); })();
    ev.entry_hash = crypto.createHash('sha256').update(canon + prevHash).digest('hex');
    prevHash = ev.entry_hash;
    out.push(ev);
  }
  return out;
}
function issue2WriteRun(root, runId, firstLine, tamperLast) {
  const evs = issue2BuildChain(runId, [
    { event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
    { event_type: 'subagent_completed', agent: 'build-boss', task: 'WP1', status: 'completed', timestamp: '2026-01-01T00:00:01.000Z' },
  ]);
  if (tamperLast) evs[evs.length - 1].note = 'TAMPERED AFTER HASHING';
  const lines = evs.map((e) => JSON.stringify(e));
  if (firstLine !== null) lines.unshift(firstLine);
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  return dir;
}
function issue2CertifyExpr(runDir, runId) {
  const { malformed } = certifyRef.readEventsJsonl(runDir);
  // certify's verifyChain now takes the events FILE path and reads it through log-event.cjs's
  // strict classifier (the same reader forge-runcontract's check() uses), not an in-memory array.
  const chain = certifyRef.verifyChain(path.join(runDir, 'events.jsonl'), runId);
  return malformed === 0 && chain.ok;
}
const ISSUE2_CASES = [
  { name: 'leeg (blank line)', firstLine: '', tamperLast: false },
  { name: 'non-object: number', firstLine: '123', tamperLast: false },
  { name: 'non-object: array', firstLine: '[1,2,3]', tamperLast: false },
  { name: 'non-object: string', firstLine: '"x"', tamperLast: false },
  { name: 'non-object: null', firstLine: 'null', tamperLast: false },
  { name: 'non-object: bool', firstLine: 'true', tamperLast: false },
  { name: 'corrupt non-blank', firstLine: 'THIS IS NOT JSON {{{', tamperLast: false },
  { name: 'echte tamper', firstLine: null, tamperLast: true },
  { name: 'schoon (clean)', firstLine: null, tamperLast: false },
];
for (const c of ISSUE2_CASES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue2-'));
  const runId = 'issue2-' + c.name.replace(/[^a-z0-9]+/gi, '-');
  const runDir = issue2WriteRun(root, runId, c.firstLine, c.tamperLast);
  const doctorOk = D.chainCheck(root).ok;
  const certifyExpr = issue2CertifyExpr(runDir, runId);
  t('ISSUE2 MIRRORED [' + c.name + ']: doctor.chainCheck.ok === (certify malformed===0 && certify.verifyChain.ok) [doctor=' + doctorOk + ', certify=' + certifyExpr + ']', doctorOk === certifyExpr);
}
// tamper-detection sanity, checked explicitly on BOTH sides (never weakened by this fix)
{
  const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue2-tamper-'));
  const tRunDir = issue2WriteRun(tRoot, 'issue2-tamper-sanity', null, true);
  t('ISSUE2 tamper-detection NOT weakened: doctor.chainCheck flags the tamper', D.chainCheck(tRoot).ok === false);
  t('ISSUE2 tamper-detection NOT weakened: certify.verifyChain flags the tamper too', issue2CertifyExpr(tRunDir, 'issue2-tamper-sanity') === false);
}

// =====================================================================================================
// 2026-07-15 DERDE FIX-RONDE (3rd break-swarm) — round 2's isPatternDefinitionContext
// was CONTEXT-based (an improvement over round 1's broken character-shape guess) but was ITSELF still too
// broad: it judged purely from text shape around the match (`/.../ `), with no idea whether the scanned FILE
// is even JavaScript, and a URL/path trailing "/" satisfies the same shape as a regex-literal close. Fixed by
// gating the exemption to a basename WHITELIST (PATTERN_DEFINITION_BASENAMES: forge-store.cjs, forge-doctor.cjs
// only) in leakScan() — isPatternDefinitionContext() is now only ever CALLED for those two files; every other
// tracked file gets no `/.../ ` exemption at all (PLACEHOLDER_RE remains the only exemption elsewhere).
// =====================================================================================================

// MISS 1 [SYSTEM-BREAKING]: a real secret in a NON-JS data file (.md/.yaml), merely WRAPPED in `/.../ `
// character shape, used to be waved through by the old file-agnostic context check. Must now be a real HIT.
const ROUND3A_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3a-'));
fs.writeFileSync(path.join(ROUND3A_ROOT, 'notes.md'), 'Deploy key: /' + REAL + '/g and more\n');
fs.writeFileSync(path.join(ROUND3A_ROOT, 'config.yaml'), 'pattern: /' + REAL + '/\n');
const round3aLeak = D.leakScan(ROUND3A_ROOT);
t('ROUND3 MISS1 FIX: a real secret wrapped in /.../  inside notes.md (non-JS data file) is HIT', round3aLeak.hits.some((h) => h.file.endsWith('notes.md') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND3 MISS1 FIX: a real secret wrapped in /.../  inside config.yaml (non-JS data file) is HIT', round3aLeak.hits.some((h) => h.file.endsWith('config.yaml') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND3 MISS1 FIX: leakScan is ok=false for both wrapped-secret data files', round3aLeak.ok === false);
t('ROUND3 MISS1 FIX: leakScan never echoes the raw secret', !JSON.stringify(round3aLeak).includes(REAL));

// MISS 2 [SYSTEM-BREAKING]: a real secret in a URL/path ending in "/" used to satisfy the same
// "regex-literal-close" text shape and was waved through. Must now be a real HIT.
const ROUND3B_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3b-'));
const ROUND3B_GH = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'; // real-shaped GitHub token (ghp_ + 32 alnum, >=20 required)
const ROUND3B_AWS = 'AKIA' + 'JKLMNOPQRSTUVWXY'; // real-shaped AWS access key id (AKIA + exactly 16 upper/digit), samengesteld
fs.writeFileSync(path.join(ROUND3B_ROOT, 'config.txt'), 'GITHUB_WEBHOOK_URL=https://api.github.com/repos/x/' + ROUND3B_GH + '/\n');
fs.writeFileSync(path.join(ROUND3B_ROOT, 'aws.txt'), 'AWS_URL=https://' + ROUND3B_AWS + '/\n');
const round3bLeak = D.leakScan(ROUND3B_ROOT);
t('ROUND3 MISS2 FIX: a real GitHub token in a trailing-slash URL (config.txt) is HIT', round3bLeak.hits.some((h) => h.file.endsWith('config.txt') && h.pattern === 'github-token'));
t('ROUND3 MISS2 FIX: a real AWS access key in a trailing-slash URL (aws.txt) is HIT', round3bLeak.hits.some((h) => h.file.endsWith('aws.txt') && h.pattern === 'aws-access-key'));
t('ROUND3 MISS2 FIX: leakScan is ok=false for both trailing-slash-URL secrets', round3bLeak.ok === false);
t('ROUND3 MISS2 FIX: leakScan never echoes the raw token/key', !JSON.stringify(round3bLeak).includes(ROUND3B_GH) && !JSON.stringify(round3bLeak).includes(ROUND3B_AWS));

// MISS 3: `x = /sk-.../gi` (genuine JS regex-literal SYNTAX) in an ORDINARY .js data file (not forge-store.cjs
// / forge-doctor.cjs) is now HIT — the exemption is basename-gated, not shape-gated.
const ROUND3C_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3c-'));
fs.writeFileSync(path.join(ROUND3C_ROOT, 'somefile.js'), 'x = /sk-ABCDEFGHIJKLMNOPQRSTUV/gi;\n');
const round3cLeak = D.leakScan(ROUND3C_ROOT);
t('ROUND3 MISS3 FIX: a secret-shaped /pattern/flags literal in an ordinary .js file (not forge-store/doctor) is HIT', round3cLeak.hits.some((h) => h.file.endsWith('somefile.js') && h.pattern === 'openai-style-key'));
t('ROUND3 MISS3 FIX: leakScan is ok=false', round3cLeak.ok === false);

// Direct proof of the whitelist MECHANISM: identical /pattern/flags content is exempted ONLY when the
// basename is a whitelisted pattern-definition file, and HIT for the exact same content under any other name.
const ROUND3D_CONTENT = 'const p = /' + PARITY_AKIA + '/g; // pattern definition (regex literal)\nmodule.exports = p;\n';
const ROUND3D_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3d-'));
const ROUND3D_BIN = path.join(ROUND3D_ROOT, '.claude', 'forge-bin');
fs.mkdirSync(ROUND3D_BIN, { recursive: true });
fs.mkdirSync(path.join(ROUND3D_ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROUND3D_BIN, 'forge-store.cjs'), ROUND3D_CONTENT);            // the ONE legit path -> EXEMPT
fs.writeFileSync(path.join(ROUND3D_ROOT, 'random-name.js'), ROUND3D_CONTENT);            // ordinary file -> HIT
fs.writeFileSync(path.join(ROUND3D_ROOT, 'forge-store.cjs'), ROUND3D_CONTENT);           // 4th round BUG2: root basename decoy -> HIT
fs.writeFileSync(path.join(ROUND3D_ROOT, 'docs', 'forge-store.cjs'), ROUND3D_CONTENT);   // 4th round BUG2: subdir basename decoy -> HIT
const round3dLeak = D.leakScan(ROUND3D_ROOT);
const r3dHit = (rel) => round3dLeak.hits.some((h) => h.file.replace(/\\/g, '/') === rel && h.pattern === 'aws-access-key');
t('ROUND4 whitelist mechanism: identical /pattern/flags content is EXEMPTED only at the exact path .claude/forge-bin/forge-store.cjs', !round3dLeak.hits.some((h) => h.file.replace(/\\/g, '/') === '.claude/forge-bin/forge-store.cjs'));
t('ROUND3 whitelist mechanism: the SAME content is HIT under a non-whitelisted name (random-name.js)', r3dHit('random-name.js'));
t('ROUND4 BUG2 FIX: a root-level forge-store.cjs (basename collision, wrong path) is now HIT, not exempted', r3dHit('forge-store.cjs'));
t('ROUND4 BUG2 FIX: a docs/forge-store.cjs decoy (basename collision in a subdir) is now HIT, not exempted', r3dHit('docs/forge-store.cjs'));

// Parity: all round-1/round-2 secret shapes (PEM, PEM-in-JSON, base64 +/=, JWT, connection-string with
// [ ] { } \, plain sk-/AKIA/nvapi-/JWT) still HIT — none of this fix's changes touch content-only detection.
t('ROUND3 parity: BUG1 PEM+"+" password fixture (round 1) still HIT', D.leakScan(BUG1_ROOT).ok === false);
t('ROUND3 parity: ISSUE1 REPRO A (PEM-in-JSON, round 2) still HIT', D.leakScan(ISSUE1A_ROOT).ok === false);
t('ROUND3 parity: ISSUE1 REPRO B (connection-string [ ] \\ { } password, round 2) still HIT', D.leakScan(ISSUE1B_ROOT).ok === false);
t('ROUND3 parity: JWT/sk-/AKIA/nvapi- parity fixture (round 2) still all HIT', D.leakScan(PARITY_ROOT).ok === false);
t('ROUND3 parity: FAKE-marked fixture is still NOT flagged (placeholder exemption unaffected)', D.leakScan(BUG1_FAKE_ROOT).ok === true);

// No false positive: the REAL forge-store.cjs (post-fix) + REAL forge-doctor.cjs (post-fix, THIS file's own
// source, self-referential and current) scanned verbatim under their real basenames stay clean.
const ROUND3_REALCODE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3-realcode-'));
const ROUND3_REALCODE_BIN = path.join(ROUND3_REALCODE_ROOT, '.claude', 'forge-bin');   // real repo-relative path (4th round)
fs.mkdirSync(ROUND3_REALCODE_BIN, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'forge-store.cjs'), path.join(ROUND3_REALCODE_BIN, 'forge-store.cjs'));
copyDoctorInto(ROUND3_REALCODE_BIN);
const round3RealcodeLeak = D.leakScan(ROUND3_REALCODE_ROOT);
t('ROUND3 no false positive: the REAL forge-store.cjs + forge-doctor.cjs (post-fix, at their real path) are still clean', round3RealcodeLeak.ok === true && round3RealcodeLeak.hits.length === 0, JSON.stringify(round3RealcodeLeak.hits));

// =====================================================================================================
// 2026-07-15 VIERDE FIX-RONDE (4th break-swarm) — two CONFIRMED honesty gaps:
//   BUG1 [HIGH]: the old hard 512KB cap SILENTLY skipped any larger tracked file; a real committed secret in
//     a >512KB file was never scanned yet the verdict stayed "clean/ALL GREEN". Fixed: scan up to
//     LEAK_SCAN_MAX_BYTES (10MB) so realistic text files ARE scanned, and surface every remaining skip in
//     result.skipped (+ printSummary) so the verdict can't imply total coverage silently.
//   BUG2 [MEDIUM]: the whitelist keyed on path.basename(rel), so ANY file merely NAMED forge-store.cjs /
//     forge-doctor.cjs in any subdir got the regex-literal exemption. Fixed: gate on the exact repo-relative
//     PATH (PATTERN_DEFINITION_PATHS). BUG2 regression is proven in the ROUND3D block above.
// =====================================================================================================

// BUG1 REPRO (break-swarm #4): a real store-redactable secret in a 600KB tracked file (over the OLD 512KB
// cap) must now be SCANNED and HIT, and never echoed.
const R4_BIG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r4-bigfile-'));
// ~630KB of realistic normal-length markdown lines (over the OLD 512KB cap) with a real secret on its own
// line. Every line is < LEAK_SCAN_MAX_LINE so the WHOLE file is scanned (no long-line bounding), proving the
// cap raise actually scans large realistic files.
fs.writeFileSync(path.join(R4_BIG_ROOT, 'big.md'), 'normal markdown documentation text line with several words here.\n'.repeat(10000) + 'Deploy key: ' + REAL + '\n');
const r4BigLeak = D.leakScan(R4_BIG_ROOT);
t('ROUND4 BUG1 FIX: a real secret in a ~630KB file (over the OLD 512KB cap) is now SCANNED and HIT', r4BigLeak.hits.some((h) => h.file.endsWith('big.md') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND4 BUG1 FIX: leakScan ok=false for the large-file secret (no more silent GREEN)', r4BigLeak.ok === false);
t('ROUND4 BUG1 FIX: leakScan never echoes the raw secret from the large file', !JSON.stringify(r4BigLeak).includes(REAL));
t('ROUND4 BUG1: the large realistic file was fully scanned, not skipped', r4BigLeak.scanned >= 1 && !r4BigLeak.skipped.some((s) => s.file.endsWith('big.md')));

// Per-line structural scan: a file with ONE pathological over-long line (a minified blob) AND a real secret
// on a separate normal line -> the secret is STILL caught, and the over-long line is SURFACED as long-line
// (bounded out of regex scanning, never a silent hole and never a ReDoS).
const R4_LONGLINE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r4-longline-'));
fs.writeFileSync(path.join(R4_LONGLINE_ROOT, 'bundle.js'), 'x'.repeat(D.LEAK_SCAN_MAX_LINE + 5000) + '\nconst k = "' + REAL + '";\n');
const r4LongLeak = D.leakScan(R4_LONGLINE_ROOT);
t('ROUND4 per-line: a real secret on a normal line is HIT even when the file also has an over-long line', r4LongLeak.hits.some((h) => h.file.endsWith('bundle.js') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND4 per-line: the over-long line is SURFACED as reason=long-line (bounded, not a silent hole)', r4LongLeak.skipped.some((s) => s.file.endsWith('bundle.js') && s.reason === 'long-line'));
t('ROUND4 per-line: LEAK_SCAN_MAX_LINE is exported and >= 8KB (covers real secret-bearing lines incl RSA-4096 PEM-in-JSON)', typeof D.LEAK_SCAN_MAX_LINE === 'number' && D.LEAK_SCAN_MAX_LINE >= 8 * 1024);

// PEM detection via the single-line HEADER (leakScan swaps the multi-line block for its header — linear,
// and catches even a truncated key). A real multi-line RSA private key is flagged as pem-private-key.
const R4_PEM_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r4-pem-'));
const { privateKey: R4_PK } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(R4_PEM_ROOT, 'id_rsa'), R4_PK);
const r4PemLeak = D.leakScan(R4_PEM_ROOT);
t('ROUND4 per-line: a real multi-line PEM private key is HIT via its header (pem-private-key)', r4PemLeak.hits.some((h) => h.file.endsWith('id_rsa') && h.pattern === 'pem-private-key'));
t('ROUND4 per-line: leakScan never echoes the raw PEM body', !JSON.stringify(r4PemLeak).includes(R4_PK.trim().split('\n')[1]));

// A genuinely huge file (> LEAK_SCAN_MAX_BYTES) is SURFACED in skipped[] (reason too-large), never silently
// dropped — the verdict must account for what it did not scan. printSummary must show it too.
const R4_HUGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r4-huge-'));
fs.writeFileSync(path.join(R4_HUGE_ROOT, 'huge.txt'), 'x'.repeat(D.LEAK_SCAN_MAX_BYTES + 1024));
const r4HugeLeak = D.leakScan(R4_HUGE_ROOT);
t('ROUND4 BUG1: a file over LEAK_SCAN_MAX_BYTES is SURFACED in skipped[] (reason too-large), never invisible', Array.isArray(r4HugeLeak.skipped) && r4HugeLeak.skipped.some((s) => s.file.endsWith('huge.txt') && s.reason === 'too-large'));
t('ROUND4 BUG1: LEAK_SCAN_MAX_BYTES is exported and generous (>= 5MB, so realistic text files are always scanned)', typeof D.LEAK_SCAN_MAX_BYTES === 'number' && D.LEAK_SCAN_MAX_BYTES >= 5 * 1024 * 1024);
const r4HugeSummary = D.printSummary(D.runDoctor(R4_HUGE_ROOT));
t('ROUND4 BUG1: printSummary surfaces "not scanned" + "too-large" for a skipped file (verdict never implies total coverage)', /not scanned/.test(r4HugeSummary) && /too-large/.test(r4HugeSummary));

// ReDoS GUARD [SYSTEM-BREAKING regression, found while fixing BUG1]: raising the scan cap first exposed that
// the URL-creds / JWT SECRET_PATTERNS backtracked catastrophically (O(n^2)) on long runs of ordinary
// characters — a 600KB single-char file took ~160s to scan, hanging the WHOLE doctor. Root-caused by
// upper-bounding those patterns' quantifiers in forge-store.cjs. This test is the structural guard: leakScan
// over adversarial input MUST stay near-instant. Any future pattern that reintroduces backtracking blows the
// budget (a real ReDoS is tens of seconds to minutes; the fixed scan is sub-second) and fails here.
const REDOS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-redos-'));
// Single pathological long lines (must be length-bounded out, never scanned into a ReDoS):
fs.writeFileSync(path.join(REDOS_ROOT, 'oneline-a.txt'), 'a'.repeat(4 * 1024 * 1024));
fs.writeFileSync(path.join(REDOS_ROOT, 'oneline-eyj.txt'), 'eyJ'.repeat(Math.floor(4 * 1024 * 1024 / 3)));
// Many medium lines that ARE actually scanned (bounded patterns must stay linear PER LINE, so many lines
// x bounded work is still fast) — this is the case a trivial long-line-only guard would miss:
fs.writeFileSync(path.join(REDOS_ROOT, 'manylines-a.txt'), ('a'.repeat(15000) + '\n').repeat(140));
fs.writeFileSync(path.join(REDOS_ROOT, 'manylines-eyj.txt'), ('eyJ'.repeat(5000) + '\n').repeat(140));
// PEM marker spam (header detection must be instant — NOT an O(markers*N) multi-line block scan):
fs.writeFileSync(path.join(REDOS_ROOT, 'pem-spam.txt'), ('-----BEGIN A ' + 'PRIVATE KEY-----\n').repeat(100000));
const redosT0 = Date.now();
const redosLeak = D.leakScan(REDOS_ROOT);
const redosMs = Date.now() - redosT0;
t('ROUND4 ReDoS GUARD: leakScan over ~14MB of assorted adversarial input (huge lines + many medium lines + PEM-marker spam) completes fast (< 4000ms), never superlinear', redosMs < 4000, redosMs + 'ms');
t('ROUND4 ReDoS GUARD: all 5 adversarial files were processed (scanned=5) — nothing silently dropped from the count', redosLeak.scanned === 5);
t('ROUND4 ReDoS GUARD: the pathological single-line files are surfaced as long-line (bounded, honest)', redosLeak.skipped.filter((s) => s.reason === 'long-line').length >= 2);

// =====================================================================================================
// 2026-07-15 VIJFDE FIX-RONDE (break-swarm #6, authoritative run vs stable code) — 4 CONFIRMED misses that
// were all SILENT (file counted scanned, ok stayed true, nothing in skipped):
//   BUG1 [SYSTEM-BREAKING]: looksLikeRealSecret ran PLACEHOLDER_RE against the WHOLE match, so a benign
//     'example'/'sample' in a URL-cred scheme/username (postgres://example_user:REALPASS@ — ubiquitous
//     staging-DB shape) exempted the REAL password. Fix: judge placeholders on the SECRET portion only
//     (password for URL creds) via secretPortion().
//   BUG2 [HIGH] + BUG3 [MEDIUM]: an INCIDENTAL 'xxxx' / 7-char filler run inside a real token silently
//     exempted it. Fix: XXXX + repeated-filler are WEAK signals that exempt ONLY when they DOMINATE (>= half)
//     the secret; explicit intent words (FAKE/EXAMPLE/YOUR_/...) stay strong (STRONG_PLACEHOLDER_RE).
//   BUG4 [MEDIUM]: leakScan's read try/catch swallowed EACCES/ENOENT/EISDIR with no skipped entry -> an
//     unreadable tracked file was silently dropped from the account. Fix: surface reason='unreadable'.
// =====================================================================================================
const R5_URL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-url-'));
fs.writeFileSync(path.join(R5_URL_ROOT, 'staging.yaml'), 'DATABASE_URL=postgres://example_user:S3cr3tStagingPw99@staging-db.internal:5432/app\n');
const r5UrlLeak = D.leakScan(R5_URL_ROOT);
t('ROUND5 BUG1 FIX: a real URL password behind an "example_user" username is HIT (no silent whole-match placeholder exemption)', r5UrlLeak.ok === false && r5UrlLeak.hits.some((h) => h.pattern === 'url-embedded-credentials'));
t('ROUND5 BUG1 FIX: the real password is never echoed', !JSON.stringify(r5UrlLeak).includes('S3cr3tStagingPw99'));
const R5_URL_FP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-urlfp-'));
fs.writeFileSync(path.join(R5_URL_FP, 'readme.md'), 'Example: postgres://user:YOUR_PASSWORD@host:5432/db\n');
t('ROUND5 BUG1 no-FP: a genuine YOUR_PASSWORD placeholder password stays EXEMPT (no new false positive)', D.leakScan(R5_URL_FP).ok === true);
t('ROUND5 BUG1 unit: secretPortion returns only the password of a URL-cred match', D.secretPortion('postgres://example_user:S3cr3tStagingPw99@') === 'S3cr3tStagingPw99');
t('ROUND5 BUG1 unit: looksLikeRealSecret true for a real password behind an example username; false for YOUR_PASSWORD', D.looksLikeRealSecret('postgres://example_user:S3cr3tStagingPw99@') === true && D.looksLikeRealSecret('postgres://user:YOUR_PASSWORD@') === false);

const R5_INCID_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-incid-'));
fs.writeFileSync(path.join(R5_INCID_ROOT, 'a.md'), 'gh=ghp_aB3xxxxKz9RealTokenMaterial01234\n');
fs.writeFileSync(path.join(R5_INCID_ROOT, 'b.txt'), 'nv=nvapi-Zk9RealNvidiaKeyMaterialAAAAAAA0123456789abcdef\n');
const r5IncidLeak = D.leakScan(R5_INCID_ROOT);
t('ROUND5 BUG2 FIX: a real ghp_ token with an incidental "xxxx" is HIT (XXXX is weak, does not dominate)', r5IncidLeak.hits.some((h) => h.file.endsWith('a.md') && h.pattern === 'github-token'));
t('ROUND5 BUG3 FIX: a real nvapi key with an incidental 7-char run is HIT (filler must dominate to exempt)', r5IncidLeak.hits.some((h) => h.file.endsWith('b.txt') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND5 BUG2/3 regression: a filler/placeholder-DOMINATED value is still exempt', D.looksLikeRealSecret('sk-AAAAAAAAAAAAAAAA{20,}') === false && D.looksLikeRealSecret('nvapi-FAKEFAKEFAKEFAKE1234567890') === false);
t('ROUND5 STRONG_PLACEHOLDER_RE guard: exported, matches EXAMPLE, and does NOT match a bare XXXX (moved to weak)', D.STRONG_PLACEHOLDER_RE instanceof RegExp && D.STRONG_PLACEHOLDER_RE.test('EXAMPLE') && !D.STRONG_PLACEHOLDER_RE.test('aXXXXb'));

// BUG4: an unreadable tracked file is SURFACED (git fixture: staged then deleted -> ls-files lists it,
// readFileSync throws ENOENT). Guarded so a git-less environment skips gracefully rather than false-failing.
const R5_UNREAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-unread-'));
const r5GitOk = spawnSync('git', ['init', '-q'], { cwd: R5_UNREAD_ROOT }).status === 0;
if (r5GitOk) {
  fs.writeFileSync(path.join(R5_UNREAD_ROOT, 'secret.conf'), 'api_key=nvapi-' + synthKey('r5-unread', 49) + '\n'); // synthetic test value (FAKE), built at runtime
  spawnSync('git', ['add', 'secret.conf'], { cwd: R5_UNREAD_ROOT });
  fs.unlinkSync(path.join(R5_UNREAD_ROOT, 'secret.conf'));
  const r5UnreadLeak = D.leakScan(R5_UNREAD_ROOT);
  t('ROUND5 BUG4 FIX: an unreadable/absent tracked file is SURFACED in skipped (reason=unreadable), never silently dropped', r5UnreadLeak.skipped.some((s) => s.file.endsWith('secret.conf') && s.reason === 'unreadable'));
  t('ROUND5 BUG4: printSummary surfaces "unreadable" in the not-scanned coverage note', /unreadable/.test(D.printSummary(D.runDoctor(R5_UNREAD_ROOT))));
} else {
  t('ROUND5 BUG4: (git unavailable in this env — unreadable-file fixture skipped, not a failure)', true);
  t('ROUND5 BUG4: (git unavailable — printSummary check skipped)', true);
}

// =====================================================================================================
// 2026-07-15 ZESDE FIX-RONDE (exposed by the re-sync itself, not a break-swarm) — the stricter round-5 leak
// scan flagged forge-chaos.cjs's fake test key sitting in a git-tracked .claude/forge-backups/ (a backup of
// Forge's OWN system files, taken by the sync). That failed the post-sync doctor on 3 projects and rolled
// them back. Fix: leakScan excludes Forge's operational artifact dirs (.claude/forge-backups/ = backups of
// Forge system files incl. test fixtures; .claude/forge-runs/ = Forge event logs) — never project source.
// =====================================================================================================
// Uses a GIT fixture on purpose: the real bug was in GIT mode (git ls-files lists a tracked .claude/
// forge-backups/, which the walk-fallback SKIP set would never even reach), so the leakScan path-filter — not
// the walk SKIP — is what must exclude it. Guarded so a git-less env skips gracefully.
const R6_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r6-'));
const r6GitOk = spawnSync('git', ['init', '-q'], { cwd: R6_ROOT }).status === 0;
if (r6GitOk) {
  fs.mkdirSync(path.join(R6_ROOT, '.claude', 'forge-backups', 'sync-1', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(R6_ROOT, '.claude', 'forge-runs', 'run-1'), { recursive: true });
  fs.mkdirSync(path.join(R6_ROOT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(R6_ROOT, '.claude', 'forge-backups', 'sync-1', 'forge-bin', 'forge-chaos.cjs'), 'const k = "' + REAL + '";\n');
  fs.writeFileSync(path.join(R6_ROOT, '.claude', 'forge-runs', 'run-1', 'events.jsonl'), '{"note":"' + REAL + '"}\n');
  fs.writeFileSync(path.join(R6_ROOT, 'src', 'config.txt'), 'key=' + REAL + '\n');
  spawnSync('git', ['add', '-A'], { cwd: R6_ROOT });
  const r6Leak = D.leakScan(R6_ROOT);
  t('ROUND6: leakScan uses git mode in this fixture (tracked files listed)', r6Leak.source === 'git');
  t('ROUND6: a real key in a git-tracked .claude/forge-backups/ (backup of Forge system files) is NOT flagged', !r6Leak.hits.some((h) => h.file.includes('forge-backups')));
  t('ROUND6: a real key in a git-tracked .claude/forge-runs/ (Forge event logs) is NOT flagged', !r6Leak.hits.some((h) => h.file.includes('forge-runs')));
  t('ROUND6: a real key in ordinary project source (src/config.txt) is STILL flagged (exclusion is scoped to Forge artifacts)', r6Leak.hits.some((h) => h.file.endsWith('config.txt')) && r6Leak.ok === false);
} else {
  t('ROUND6: (git unavailable — forge-backups exclusion fixture skipped, not a failure)', true);
}

// PATTERN_DEFINITION_PATHS is exported and exactly the 2 real repo-relative paths (mutation-guard: a
// whitelist that silently grew back to "everything", or that reverted to basename-keying, fails this).
t('PATTERN_DEFINITION_PATHS is exported and contains exactly the two real .claude/forge-bin pattern-def paths', D.PATTERN_DEFINITION_PATHS instanceof Set && D.PATTERN_DEFINITION_PATHS.size === 2 && D.PATTERN_DEFINITION_PATHS.has('.claude/forge-bin/forge-store.cjs') && D.PATTERN_DEFINITION_PATHS.has('.claude/forge-bin/forge-doctor.cjs'));

// =====================================================================================================
// WAVE A / A2 — the 4 doctor completeness checks: sync_completeness, check_the_checks,
// memory_discipline, unregistered_event. All ADVISORY-ONLY (see forge-doctor.cjs's header doc comment) —
// their own `ok` is honestly computed, but runDoctor()'s top-level `ok` must never be affected by them.
// =====================================================================================================

// --- sync-completeness ---------------------------------------------------------------------------------
// syncCompleteness() requires the REAL sibling forge-sync.cjs.: its delivery list is DERIVED
// from the shipping manifest — the root's own config/orchestration/FORGE_SHIP_MANIFEST.json when it has one, else
// forge-sync's. The real manifest ships every skill folder whole, so this fixture carries its OWN manifest that
// ships forge-bin/*.cjs, agents/*.md and only the forge-doctor skill: a skill dir outside it is the drift the
// check exists to flag (the old "not in SYSTEM[]" case), and the two globs still auto-cover new tools/agents.
const SC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-synccomplete-'));
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'config', 'orchestration'), { recursive: true });
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'), JSON.stringify({
  schema: 'forge-ship-manifest/v1',
  rules: [
    { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture toolkit' },
    { pattern: '.claude/agents/*.md', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture agents' },
    { pattern: '.claude/skills/forge-doctor/**', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture skill' },
  ],
  known_gaps: [],
}));
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'skills', 'definitely-not-in-any-manifest-skill'), { recursive: true });
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'skills', 'definitely-not-in-any-manifest-skill', 'SKILL.md'), '# not synced\n');
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'skills', 'forge-doctor'), { recursive: true }); // a REAL SYSTEM[] entry
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'skills', 'forge-doctor', 'SKILL.md'), '# real manifest entry\n');
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'forge-bin', 'brandnewtool.cjs'), "'use strict';\nmodule.exports = {};\n");
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'agents', 'brand-new-agent.md'), '---\nname: x\n---\nbody\n');
const sc = D.syncCompleteness(SC_ROOT);
t('syncCompleteness: flags a real skill dir the shipping manifest does NOT ship (not in forge-sync\'s delivery list)', sc.missing.includes('skills/definitely-not-in-any-manifest-skill/SKILL.md'));
t('syncCompleteness: does NOT flag a skill dir the manifest ships (skills/forge-doctor/SKILL.md)', !sc.missing.includes('skills/forge-doctor/SKILL.md'));
t('syncCompleteness: a brand-new forge-bin tool is auto-covered by the manifest glob (never flagged)', !sc.missing.includes('forge-bin/brandnewtool.cjs'));
t('syncCompleteness: a brand-new agent .md is auto-covered by the manifest glob (never flagged)', !sc.missing.includes('agents/brand-new-agent.md'));
t('syncCompleteness: own ok is honestly false when a real gap exists', sc.ok === false);

// no-gap fixture (no manifest of its own -> forge-sync's real manifest, which ships every skill folder whole) -> ok:true
const SC_CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-synccomplete-clean-'));
fs.mkdirSync(path.join(SC_CLEAN, '.claude', 'skills', 'forge-doctor'), { recursive: true });
fs.writeFileSync(path.join(SC_CLEAN, '.claude', 'skills', 'forge-doctor', 'SKILL.md'), '# real manifest entry\n');
const scClean = D.syncCompleteness(SC_CLEAN);
t('syncCompleteness: a fixture whose skills the real manifest ships is ok=true, 0 missing', scClean.ok === true && scClean.missing.length === 0);

// WP-DOC-ADV: a forge-bin file the manifest classifies local-only (a maintainer tool) is NOT a gap —
// it goes to intentionallyLocal and ok stays true; an UNCLASSIFIED forge-bin file is still flagged (tight variant).
const SC_LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-synccomplete-local-'));
fs.mkdirSync(path.join(SC_LOCAL, '.claude', 'config', 'orchestration'), { recursive: true });
fs.writeFileSync(path.join(SC_LOCAL, '.claude', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'), JSON.stringify({
  schema: 'forge-ship-manifest/v1',
  rules: [
    { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture toolkit' },
    { pattern: '.claude/forge-bin/forge-maint-*.cjs', class: 'local-only', channels: [], reason: 'fixture maintainer tool' },
  ],
  known_gaps: [],
}));
fs.mkdirSync(path.join(SC_LOCAL, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(SC_LOCAL, '.claude', 'forge-bin', 'shipped.cjs'), "'use strict';\n");
fs.writeFileSync(path.join(SC_LOCAL, '.claude', 'forge-bin', 'forge-maint-tool.cjs'), "'use strict';\n");
const scLocal = D.syncCompleteness(SC_LOCAL);
t('syncCompleteness: a forge-bin file matching a local-only rule is NOT flagged and ok=true',
  scLocal.ok === true && scLocal.missing.length === 0);
t('syncCompleteness: the local-only file is listed in intentionallyLocal (visible, not hidden)',
  Array.isArray(scLocal.intentionallyLocal) && scLocal.intentionallyLocal.includes('forge-bin/forge-maint-tool.cjs'));
fs.writeFileSync(path.join(SC_LOCAL, '.claude', 'forge-bin', 'unclassified.ps1'), '# no rule matches me\n');
const scUncl = D.syncCompleteness(SC_LOCAL);
t('syncCompleteness: an UNCLASSIFIED forge-bin file is still flagged (narrowed-rule guard kept)',
  scUncl.ok === false && scUncl.missing.includes('forge-bin/unclassified.ps1') && !scUncl.missing.includes('forge-bin/forge-maint-tool.cjs'));

// WP-DOC-ADV: run_liveness tags a finding silent >= 7 days as abandoned (still advisory).
const RL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-liveness-abandoned-'));
const RL_NOW = Date.parse('2026-10-10T12:00:00Z');
const mkRun = (id, agoMs) => {
  fs.mkdirSync(path.join(RL_ROOT, '.claude', 'forge-runs', id), { recursive: true });
  fs.writeFileSync(path.join(RL_ROOT, '.claude', 'forge-runs', id, 'run.json'),
    JSON.stringify({ run_id: id, status: 'running', started_at: new Date(RL_NOW - agoMs).toISOString() }));
};
mkRun('run-old', 8 * 24 * 3600 * 1000);
mkRun('run-recent', 7 * 3600 * 1000);
const rl = D.runLiveness(RL_ROOT, { now: RL_NOW });
const rlOld = (rl.findings || []).find((f) => f.run_id === 'run-old');
const rlRecent = (rl.findings || []).find((f) => f.run_id === 'run-recent');
t('runLiveness: LIVENESS_ABANDONED_MS is exported and equals 7 days', D.LIVENESS_ABANDONED_MS === 7 * 24 * 3600 * 1000);
t('runLiveness: a run silent 8 days is a finding tagged abandoned:true', !!rlOld && rlOld.abandoned === true);
t('runLiveness: a run silent 7 hours is a finding tagged abandoned:false', !!rlRecent && rlRecent.abandoned === false);
t('runLiveness: abandoned tagging does not change the advisory ok semantics (findings -> ok:false)', rl.ok === false && rl.checked === 2);

// --- check-the-checks -----------------------------------------------------------------------------------
const CTC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-checkthechecks-'));
fs.mkdirSync(path.join(CTC_ROOT, '.claude', 'forge-bin'), { recursive: true });
// a GREEN NO-OP: prints a passing tally, but never calls t(...)/test(...)/assert(...) anywhere.
fs.writeFileSync(path.join(CTC_ROOT, '.claude', 'forge-bin', 'noop.test.cjs'), "console.log('5 passed, 0 failed');\nprocess.exit(0);\n");
// a REAL suite: genuine t(...) call sites, also passes.
fs.writeFileSync(path.join(CTC_ROOT, '.claude', 'forge-bin', 'real.test.cjs'),
  "let pass=0,fail=0;\nconst t=(n,c)=>{if(c){pass++;}else{fail++;}};\nt('one plus one is two', 1+1===2);\nt('two plus two is four', 2+2===4);\nconsole.log(pass+' passed, '+fail+' failed');\nprocess.exit(fail?1:0);\n");
// a genuinely vacuous suite (0 assertions, 0 passed) -> already caught by runTests' own suiteOk=false, must
// NOT be double-flagged as a NEW check-the-checks finding.
fs.writeFileSync(path.join(CTC_ROOT, '.claude', 'forge-bin', 'vacuous.test.cjs'), "console.log('0 passed, 0 failed');\nprocess.exit(0);\n");
const ctcTests = D.runTests(CTC_ROOT);
const ctc = D.checkTheChecks(CTC_ROOT, ctcTests);
t('checkTheChecks: flags a suite reporting a passing tally with 0 real assertion sites (green no-op)', ctc.noOp.some((n) => n.suite === 'noop.test.cjs'));
t('checkTheChecks: does NOT flag a suite with real t(...) assertion call sites', !ctc.noOp.some((n) => n.suite === 'real.test.cjs'));
t('checkTheChecks: does NOT double-flag a genuinely vacuous (0 passed) suite — runTests already rejects it', !ctc.noOp.some((n) => n.suite === 'vacuous.test.cjs'));
t('checkTheChecks: own ok is honestly false when a green no-op exists', ctc.ok === false);

// --- vacuousBooleanTHelperSites: a DIFFERENT shape of no-op than the whole-suite one
// above -- a suite with plenty of real t(...) sites overall, but ONE call site passing a bare, un-invoked
// function literal to a BOOLEAN-style t(name, cond) helper (always truthy, so that one assertion body never
// runs). This is exactly the shape found live in this file's own gateWatchdogHealth/printSummary tests.
const PLANTED_VACUOUS_SRC = [
  "let pass=0,fail=0;",
  "const assert=require('assert');",
  "const t=(name,cond)=>{if(cond){pass++;}else{fail++;console.error('FAIL '+name);}};",
  "t('one plus one is two', 1+1===2);",
  "t('a genuinely vacuous site: a bare, un-invoked arrow literal', () => {",
  "  assert.strictEqual(1, 2); // would fail for real if this ever actually ran -- it never does",
  "});",
  "t('two plus two is four', 2+2===4);",
  "console.log(pass+' passed, '+fail+' failed');",
  "process.exitCode = fail ? 1 : 0;",
  "",
].join('\n');
const plantedFindings = D.vacuousBooleanTHelperSites(PLANTED_VACUOUS_SRC);
t('vacuousBooleanTHelperSites: a planted bare-function-literal call site in a boolean-style t() file IS flagged', plantedFindings.length === 1, JSON.stringify(plantedFindings));
t('vacuousBooleanTHelperSites: the flagged line number points at the real t(...) call site, not line 1', plantedFindings[0] && plantedFindings[0].line === 5, JSON.stringify(plantedFindings));

// a callback-style t(name, fn) file (forge-standing.test.cjs's own real shape) that ALSO passes a bare
// function literal to t() -- exempt by construction: this t() genuinely calls fn(), so nothing is vacuous.
const CALLBACK_STYLE_SRC = [
  "let passed=0,failed=0;",
  "const assert=require('assert');",
  "function t(name, fn) {",
  "  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL '+name+' — '+e.message); }",
  "}",
  "t('one plus one is two', () => { assert.strictEqual(1+1, 2); });",
  "t('two plus two is four', () => { assert.strictEqual(2+2, 4); });",
  "console.log(passed+' passed, '+failed+' failed');",
  "",
].join('\n');
t('vacuousBooleanTHelperSites: a real callback-style t(name, fn) file (fn is genuinely invoked) is NEVER flagged', D.vacuousBooleanTHelperSites(CALLBACK_STYLE_SRC).length === 0, JSON.stringify(D.vacuousBooleanTHelperSites(CALLBACK_STYLE_SRC)));
t('classifyTHelper: correctly names the planted boolean-style helper "boolean"', D.classifyTHelper(D.stripJsComments(PLANTED_VACUOUS_SRC)) === 'boolean');
t('classifyTHelper: correctly names the real callback-style helper "callback"', D.classifyTHelper(D.stripJsComments(CALLBACK_STYLE_SRC)) === 'callback');
// a node:test suite whose helper forwards its callback to test()/it() (`function t(name, fn) { test(name, fn); }`)
// was read as boolean-style, so every `t('x', async () => {...})` became a false "bare, un-invoked function" no-op.
const FORWARDING_SRC = "const { test } = require('node:test');\nconst assert = require('assert');\nt('a', async () => { assert.ok(true); });\nfunction t(name, fn) { test(name, fn); }\n";
t('classifyTHelper: a helper that forwards its second parameter to test()/it() is "callback", and none of its call sites is a no-op', D.classifyTHelper(D.stripJsComments(FORWARDING_SRC)) === 'callback' && D.vacuousBooleanTHelperSites(FORWARDING_SRC).length === 0);
t('classifyTHelper: a helper that only passes its second parameter to assert.ok() stays "boolean"', D.classifyTHelper("function t(name, cond) { assert.ok(cond, name); }\n") === 'boolean');

// an IIFE-wrapped call (the FIX this whole package applies) must never be flagged, even in a boolean-style file
const IIFE_FIXED_SRC = [
  "let pass=0,fail=0;",
  "const assert=require('assert');",
  "const t=(name,cond)=>{if(cond){pass++;}else{fail++;}};",
  "t('an IIFE that actually runs its assertions and returns a real boolean', (() => {",
  "  assert.strictEqual(1+1, 2);",
  "  return true;",
  "})());",
  "",
].join('\n');
t('vacuousBooleanTHelperSites: a properly-invoked IIFE in a boolean-style file is NEVER flagged', D.vacuousBooleanTHelperSites(IIFE_FIXED_SRC).length === 0, JSON.stringify(D.vacuousBooleanTHelperSites(IIFE_FIXED_SRC)));

// checkTheChecks() itself must surface the planted per-call-site finding under the SAME `noOp` field the
// whole-suite check uses, on a suite that otherwise has plenty of real assertion sites (so the whole-suite
// branch alone would have let it through silently).
fs.writeFileSync(path.join(CTC_ROOT, '.claude', 'forge-bin', 'planted-vacuous-site.test.cjs'), PLANTED_VACUOUS_SRC);
const ctcTests2 = D.runTests(CTC_ROOT);
const ctc2 = D.checkTheChecks(CTC_ROOT, ctcTests2);
t('checkTheChecks: a suite with real assertion sites overall, but one bare-function-literal call site, IS flagged via the SAME noOp field', ctc2.noOp.some((n) => n.suite === 'planted-vacuous-site.test.cjs' && /bare, un-invoked function/.test(n.reason)), JSON.stringify(ctc2.noOp));
t('checkTheChecks: own ok is honestly false for the planted per-call-site finding too', ctc2.ok === false);

// the doctor's OWN scan over the REAL forge-bin tree (this fix + 's IIFE conversions above) must
// report zero NEW findings — the exact thing this whole detector exists to guarantee going forward.
// Deliberately a STATIC-ONLY call: checkTheChecks() itself never spawns anything, but D.runTests(REAL_ROOT)
// would (it actually RUNS every *.test.cjs suite in the real project as a child process) -- that is "the
// full doctor" this package's own instructions say not to run here, and would recurse into this very file.
// An empty perSuite[] disables only the (unrelated, testsResult-dependent) whole-suite-no-op branch; the
// per-call-site scan this test cares about never looks at testsResult at all.
const realCtc = D.checkTheChecks(REAL_ROOT, { perSuite: [] });
const realVacuousFindings = realCtc.noOp.filter((n) => /bare, un-invoked function/.test(n.reason));
t('checkTheChecks: scanning the REAL project tree finds zero bare-function-literal call sites (this file’s own 12 are fixed)', realVacuousFindings.length === 0, JSON.stringify(realVacuousFindings));
t('countAssertionSites: recognizes the test(...) helper convention too (not just t(...))', D.countAssertionSites("function test(name, fn) {}\ntest('x', () => {});\n") > 0);
t('countAssertionSites: recognizes direct assert.ok(...)/assert(...) calls', D.countAssertionSites("const assert = require('assert');\nassert.ok(1 === 1);\nassert(true);\n") > 0);
t('countAssertionSites: a truly empty suite has 0 sites', D.countAssertionSites("console.log('hello');\n") === 0);

// real-project regression guard: this project's OWN 51 real *.test.cjs suites must never be flagged as
// no-ops (proven at build time against every one of them; re-asserted here so a future suite can't silently
// slip below the detection threshold without this test catching it).
// NOTE: deliberately does NOT call D.runTests()/D.checkTheChecks() against the real project here — this
// file (forge-doctor.test.cjs) is itself one of the suites runTests() would spawn, which would recursively
// re-execute this entire file (and, in turn, spawn itself again) on every level. A pure STATIC scan (no
// execution, no subprocess spawning) is sufficient to prove the same guarantee: checkTheChecks() only ever
// flags a suite when it has ZERO real assertion sites, so confirming every real suite has >=1 site statically
// proves none of them can ever be flagged, without needing to run any of them.
const REAL_PROJECT_ROOT = path.resolve(__dirname, '..', '..');
// CANONICAL DEV-TREE GATE (install-deadlock fix): a handful of assertions below pin the EXACT
// current state of the canonical development tree (the exact set of skills carrying an evals.json sibling,
// the exact known skill-hygiene finding set). Those exact sets depend on files that are DELIBERATELY never
// synced to installed projects (evals.json/learnings.md siblings — see forge-sync.cjs's FILES doc — and
// provisioned per-project state), so in every installed project they failed for a reason that is not a
// defect, which turned every fresh `forge-sync install`'s post-validation red and rolled the install back.
// The vendor-pin based `pinned()` gate above cannot express this (installs DO ship the vendored skills), so
// these guards key on the dev-tree marker file instead — present only in the canonical checkout, never in
// forge-sync's FILES manifest. Strict where the sets are real; visibly skipped everywhere else.
// ONE discriminator for both gates — installationProfile() now keys on this same marker
// (and additionally requires it to parse as {"dev_tree": true}), so pinned() and devTreeOnly() can no
// longer disagree about which tree this is.
const IS_DEV_TREE = DEV_TREE.profile === 'development';
const devTreeOnly = (name, fn) => {
  if (IS_DEV_TREE) { fn(); return true; }
  skip(name, 'canonical dev-tree regression guard · ' + DEV_TREE.reason + ' — the exact sets this pins are deliberately not shipped to installed projects');
  return false;
};
const realSuiteFiles = fs.readdirSync(path.join(REAL_PROJECT_ROOT, '.claude', 'forge-bin')).filter((f) => f.endsWith('.test.cjs'));
const realSuitesWithZeroSites = realSuiteFiles.filter((f) => D.countAssertionSites(fs.readFileSync(path.join(REAL_PROJECT_ROOT, '.claude', 'forge-bin', f), 'utf8')) === 0);
t('checkTheChecks static guard: every real *.test.cjs suite in this project has >=1 real assertion site (none COULD be flagged as a green no-op)', realSuitesWithZeroSites.length === 0, JSON.stringify(realSuitesWithZeroSites));

// --- memory-discipline -----------------------------------------------------------------------------------
const MD_MISSING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memdisc-missing-'));
fs.mkdirSync(path.join(MD_MISSING, '.claude'), { recursive: true });
const mdMissing = D.memoryDiscipline(MD_MISSING);
t('memoryDiscipline: FORGE_MEMORY.md absent -> ok=false, present=false', mdMissing.ok === false && mdMissing.present === false);

const MD_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memdisc-empty-'));
fs.mkdirSync(path.join(MD_EMPTY, '.claude'), { recursive: true });
fs.writeFileSync(path.join(MD_EMPTY, '.claude', 'FORGE_MEMORY.md'), '   \n\n');
const mdEmpty = D.memoryDiscipline(MD_EMPTY);
t('memoryDiscipline: FORGE_MEMORY.md present but whitespace-only -> ok=false', mdEmpty.ok === false && mdEmpty.present === true);

const MD_PLACEHOLDER = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memdisc-placeholder-'));
fs.mkdirSync(path.join(MD_PLACEHOLDER, '.claude'), { recursive: true });
fs.writeFileSync(path.join(MD_PLACEHOLDER, '.claude', 'FORGE_MEMORY.md'),
  '# Memory\nStatus: <PLACEHOLDER>\nOwner: <PROJECT_OWNER_NAME>\nTODO: fill this in\nReal note about the router.\n');
const mdPlaceholder = D.memoryDiscipline(MD_PLACEHOLDER);
t('memoryDiscipline: flags a literal <PLACEHOLDER> marker', mdPlaceholder.ok === false && mdPlaceholder.placeholderLines.includes(2));
t('memoryDiscipline: flags an ALL-CAPS scaffold token like <PROJECT_OWNER_NAME>', mdPlaceholder.placeholderLines.includes(3));
t('memoryDiscipline: flags a "TODO:" marker', mdPlaceholder.placeholderLines.includes(4));

const MD_CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memdisc-clean-'));
fs.mkdirSync(path.join(MD_CLEAN, '.claude'), { recursive: true });
fs.writeFileSync(path.join(MD_CLEAN, '.claude', 'FORGE_MEMORY.md'),
  '# Memory\nReal decision: adopted the router.\nPer-Boss memory lives in `.claude/agent-memory/<boss>/MEMORY.md` (a real, lowercase prose reference, not an unfilled scaffold token).\n');
const mdClean = D.memoryDiscipline(MD_CLEAN);
t('memoryDiscipline: a populated memory file with only lowercase prose <boss> references is ok=true (no false positive)', mdClean.ok === true && mdClean.placeholderLines.length === 0);

// real-project regression guard: IF this project has a FORGE_MEMORY.md, it must stay placeholder-clean.
// PORTABILITY: this test file is synced verbatim into every Forge project. memory-discipline is ADVISORY —
// a freshly-synced project may legitimately have no FORGE_MEMORY.md yet (or an empty one), which must NOT
// hard-fail its test suite (that would make forge-sync roll back a perfectly healthy install). So the guard
// only asserts placeholder-cleanliness WHEN memory is present; absence/emptiness is a valid advisory state.
const realMd = D.memoryDiscipline(REAL_PROJECT_ROOT);
t('memoryDiscipline: this project\'s FORGE_MEMORY.md, when present, carries no unfilled placeholder/scaffold tokens', !realMd.present || realMd.placeholderLines.length === 0, JSON.stringify(realMd));

// --- unregistered-event ----------------------------------------------------------------------------------
function ueWrite(root, logEventTypes, toolSource) {
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'),
    "'use strict';\nconst KNOWN_EVENT_TYPES = new Set([" + logEventTypes.map((s) => "'" + s + "'").join(', ') + "]);\nmodule.exports = {};\n");
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'mytool.cjs'), toolSource);
}
const UE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-unregevent-'));
ueWrite(UE_ROOT, ['known_type_a', 'known_type_b'],
  "function logEvent(runId, eventType, extra) { /* real.impl(runId, eventType, extra) */ }\n" +
  "logEvent(RUN, 'known_type_a', { agent: 'x' });\n" +                 // registered -> not flagged
  "logEvent(RUN, 'totally_unregistered_type', { agent: 'x' });\n" +    // NOT registered -> flagged
  "function paperclipStyle(type, obj) { logEvent2(type, obj); }\n" +
  "logEvent('paperclip_style_unregistered', { agent: 'y' });\n" +      // 1st-arg convention, NOT registered -> flagged
  "logEvent(RUN, ev.event_type, { agent: 'z' });\n");                  // dynamic literal -> can't resolve, skipped
const ue = D.unregisteredEvent(UE_ROOT);
t('unregisteredEvent: does NOT flag a literal event_type that IS in KNOWN_EVENT_TYPES', !ue.unregistered.some((u) => u.event_type === 'known_type_a'));
t('unregisteredEvent: flags a literal event_type (2nd-arg convention) NOT in KNOWN_EVENT_TYPES', ue.unregistered.some((u) => u.event_type === 'totally_unregistered_type'));
t('unregisteredEvent: flags a literal event_type (1st-arg / paperclip convention) NOT in KNOWN_EVENT_TYPES', ue.unregistered.some((u) => u.event_type === 'paperclip_style_unregistered'));
t('unregisteredEvent: a dynamically-built event_type (ev.event_type) is honestly skipped, not guessed', !ue.unregistered.some((u) => u.event_type && u.event_type.includes('event_type')));
t('unregisteredEvent: every flagged entry names the offending file', ue.unregistered.every((u) => u.file === '.claude/forge-bin/mytool.cjs' || u.file.endsWith('mytool.cjs')));
t('unregisteredEvent: own ok is honestly false when a real gap exists', ue.ok === false);

const UE_CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-unregevent-clean-'));
ueWrite(UE_CLEAN, ['known_type_a'], "function logEvent(runId, eventType, extra) {}\nlogEvent(RUN, 'known_type_a', { agent: 'x' });\n");
const ueClean = D.unregisteredEvent(UE_CLEAN);
t('unregisteredEvent: a tool using only registered event types is ok=true, 0 unregistered', ueClean.ok === true && ueClean.unregistered.length === 0);

const UE_MISSING_LOGEVENT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-unregevent-missinglog-'));
const ueMissingLog = D.unregisteredEvent(UE_MISSING_LOGEVENT);
t('unregisteredEvent: log-event.cjs absent -> ok=false, explicit reason (never a silent pass)', ueMissingLog.ok === false && /could not read/.test(ueMissingLog.reason));

// direct unit coverage of extractLoggedEventTypes / extractKnownEventTypesFromSource
t('extractKnownEventTypesFromSource: parses a real KNOWN_EVENT_TYPES Set literal', (() => { const s = D.extractKnownEventTypesFromSource("const KNOWN_EVENT_TYPES = new Set(['a_b', 'c_d']);"); return s instanceof Set && s.has('a_b') && s.has('c_d'); })());
t('extractKnownEventTypesFromSource: returns null when no Set literal is present', D.extractKnownEventTypesFromSource('no set literal here') === null);

// COMMENT-PROOF PARSING (independent-witness defect 2). The scanner used to run its
// /'([^']+)'|"([^"]+)"/g literal regex over the RAW Set body, comment lines included, so a single APOSTROPHE
// in comment prose inside the block was read as a string delimiter and flipped quote parity for everything
// after it. Measured against this project's own real log-event.cjs before the fix: 186 types registered,
// 175 seen, 20 real types INVISIBLE (e2e_passed, workflow_validated, audit_iteration, audit_finding,
// rejected_approach, review_started, review_completed, ...) plus 9 junk "types" invented out of comment
// prose — while the ENFORCED "unreg. events" gate showed a green tick, i.e. the gate read stronger than it
// was. The old workaround ("write no apostrophe in that comment block", see log-event.cjs) was enforced by
// nothing. Comments are now stripped first, the same way forge-event-wiring.test.cjs already strips them
// before reading app.js's taskStatus() buckets.
const APOSTROPHE_COMMENT_SRC = [
  'const KNOWN_EVENT_TYPES = new Set([',
  "  'before_comment_a', 'before_comment_b',",
  "  // the AUDIT-LOOP tool's own events — this apostrophe used to flip the quote parity for the rest",
  "  'after_comment_a',",
  "  'after_comment_b', // trailing comment, also with an apostrophe in the boss's prose",
  ']);',
].join('\n');
t('extractKnownEventTypesFromSource: an apostrophe in a // comment does not hide the types after it',
  (() => {
    const s = D.extractKnownEventTypesFromSource(APOSTROPHE_COMMENT_SRC);
    return s instanceof Set && s.has('before_comment_a') && s.has('before_comment_b') &&
      s.has('after_comment_a') && s.has('after_comment_b');
  })());
// ANTI-TIEBREAK: seeing all four is not enough — a scanner that swallowed comment prose could also INVENT
// "types" out of it (9 such ghosts were measured on the real file). Exactly the four real members, nothing else.
t('extractKnownEventTypesFromSource: comment prose never becomes a phantom event type',
  (() => {
    const s = D.extractKnownEventTypesFromSource(APOSTROPHE_COMMENT_SRC);
    return s.size === 4;
  })());
t('extractKnownEventTypesFromSource: a /* block comment */ with an apostrophe is stripped too',
  (() => {
    const s = D.extractKnownEventTypesFromSource(
      "const KNOWN_EVENT_TYPES = new Set([\n  'block_a',\n  /* the loop's brake, in a block comment */\n  'block_b',\n]);");
    return s instanceof Set && s.has('block_a') && s.has('block_b') && s.size === 2;
  })());
t('extractLoggedEventTypes: ignores a string literal INSIDE the payload object (a note value)', !D.extractLoggedEventTypes("logEvent(RUN, 'real_event_type', { note: 'not_an_event_type_value' });").has('not_an_event_type_value'));
t('extractLoggedEventTypes: ignores the logEvent(...) function DEFINITION line itself', D.extractLoggedEventTypes('function logEvent(runId, eventType, extra) {}').size === 0);

// real-project regression guard: this project's own real forge-paperclip.cjs previously had a KNOWN,
// already-tracked gap (23 unregistered paperclip_* event types, see forge-doctor.cjs's WAVE A/A2 header doc
// comment) — CLOSED by WAVE C / C-INTEGRATE: all 23 real paperclip_* event types are now
// registered in log-event.cjs's KNOWN_EVENT_TYPES. This assertion now proves the fix stuck (evidence of
// closure), not evidence of the original gap — a future re-introduction of an unregistered paperclip_*
// event_type would flip this back to failing, which is the whole point of a regression guard.
const realUe = D.unregisteredEvent(REAL_PROJECT_ROOT);
t('unregisteredEvent: the real forge-paperclip.cjs gap is CLOSED (paperclip_selected is now registered)', !realUe.unregistered.some((u) => u.file.endsWith('forge-paperclip.cjs') && u.event_type === 'paperclip_selected'));
t('unregisteredEvent: the real project now has ZERO unregistered event_type usages at all (ok:true)', realUe.ok === true && realUe.unregistered.length === 0);

// --- mcp-dormancy (WAVE G / G-INTEGRATE) -----------------------------------------------------------------
function mdWrite(root, { servers, bosses, optIn, mcpJson } = {}) {
  const cd = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(cd, { recursive: true });
  fs.writeFileSync(path.join(cd, 'mcp-registry.json'), JSON.stringify({ servers: servers || [] }));
  fs.writeFileSync(path.join(cd, 'mcp-grants.json'), JSON.stringify({ bosses: bosses || {} }));
  if (optIn) fs.writeFileSync(path.join(cd, 'mcp-opt-in.json'), JSON.stringify(optIn));
  if (mcpJson) fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(mcpJson));
}
const SERVER_T0 = { id: 'serena-lsp', tier: 0, status: 'not-installed' };
const SERVER_T1 = { id: 'context7', tier: 1, status: 'not-installed' };
const SERVER_T2 = { id: 'playwright', tier: 2, status: 'not-installed' };
const SERVER_T3 = { id: 'github-write', tier: 3, status: 'not-installed' };

// (a) auto-active without opt-in -> flagged
const MCPD_AUTOACTIVE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-autoactive-'));
mdWrite(MCPD_AUTOACTIVE, { servers: [{ id: 'context7', tier: 1, status: 'active' }], bosses: {} });
const mcpdAutoActive = D.mcpDormancy(MCPD_AUTOACTIVE);
t('mcpDormancy: a registry server with status "active" and NO opt-in marker is flagged', mcpdAutoActive.ok === false && mcpdAutoActive.violations.some((v) => v.type === 'auto_active_without_optin' && v.server === 'context7'));

// same server, but genuinely opted-in -> NOT flagged (dormancy respects the owner's explicit opt-in)
const MCPD_OPTEDIN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-optedin-'));
mdWrite(MCPD_OPTEDIN, { servers: [{ id: 'context7', tier: 1, status: 'active' }], bosses: {}, optIn: { opted_in: ['context7'] } });
const mcpdOptedIn = D.mcpDormancy(MCPD_OPTEDIN);
t('mcpDormancy: an active server that IS listed in mcp-opt-in.json is NOT flagged', !mcpdOptedIn.violations.some((v) => v.type === 'auto_active_without_optin'));

// a real .mcp.json host config listing a server not in opted_in[] -> flagged
const MCPD_MCPJSON = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-mcpjson-'));
mdWrite(MCPD_MCPJSON, { servers: [SERVER_T1], bosses: {}, mcpJson: { mcpServers: { context7: { command: 'npx' } } } });
const mcpdMcpJson = D.mcpDormancy(MCPD_MCPJSON);
t('mcpDormancy: a real .mcp.json server not in opted_in[] is flagged', mcpdMcpJson.violations.some((v) => v.type === 'mcp_json_server_without_optin' && v.server === 'context7'));

// (b) a grant referencing a server whose tier exceeds the boss's own max_tier -> flagged
const MCPD_TIEREXCEED = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-tierexceed-'));
mdWrite(MCPD_TIEREXCEED, { servers: [SERVER_T2], bosses: { 'build-boss': { max_tier: 0, allow_servers: ['playwright'] } } });
const mcpdTierExceed = D.mcpDormancy(MCPD_TIEREXCEED);
t('mcpDormancy: a grant above the boss\'s own max_tier is flagged', mcpdTierExceed.ok === false && mcpdTierExceed.violations.some((v) => v.type === 'grant_exceeds_max_tier' && v.boss === 'build-boss' && v.server === 'playwright'));

// a grant referencing an unknown server id -> flagged
const MCPD_UNKNOWN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-unknown-'));
mdWrite(MCPD_UNKNOWN, { servers: [SERVER_T0], bosses: { 'build-boss': { max_tier: 1, allow_servers: ['nonexistent-server'] } } });
const mcpdUnknown = D.mcpDormancy(MCPD_UNKNOWN);
t('mcpDormancy: a grant referencing an unknown server id is flagged', mcpdUnknown.violations.some((v) => v.type === 'unknown_server_in_grant' && v.server === 'nonexistent-server'));

// (c) tier-3 must NEVER be a standing/default grant, even when max_tier numerically covers it
const MCPD_TIER3 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-tier3-'));
mdWrite(MCPD_TIER3, { servers: [SERVER_T3], bosses: { 'integration-boss': { max_tier: 3, allow_servers: ['github-write'] } } });
const mcpdTier3 = D.mcpDormancy(MCPD_TIER3);
t('mcpDormancy: a tier-3 server in any boss\'s allow_servers is flagged, even with a covering max_tier', mcpdTier3.ok === false && mcpdTier3.violations.some((v) => v.type === 'tier3_default_grant' && v.server === 'github-write'));

// (c') POISONED tier type: a tier-3 write-primitive with tier as the STRING '3' must STILL be flagged (was a
// real break-swarm finding — strict `=== 3` and `> max_tier` both missed a string tier, certifying all-clear).
const MCPD_STR3 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-str3-'));
mdWrite(MCPD_STR3, { servers: [{ id: 'github-write', tier: '3', status: 'not-installed' }], bosses: { 'integration-boss': { max_tier: 3, allow_servers: ['github-write'] } } });
const mcpdStr3 = D.mcpDormancy(MCPD_STR3);
t('mcpDormancy: a tier-3 server whose tier is the STRING "3" is STILL flagged (poisoned-tier no longer evades the doctor)', mcpdStr3.ok === false && mcpdStr3.violations.some((v) => v.server === 'github-write' && (v.type === 'tier3_default_grant' || v.type === 'malformed_server_tier')));

// a non-integer / out-of-range / non-numeric tier is treated as a violation, never all-clear
const MCPD_BADTIER = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-badtier-'));
mdWrite(MCPD_BADTIER, { servers: [{ id: 'weird', tier: '2.5', status: 'not-installed' }, { id: 'huge', tier: 999, status: 'not-installed' }, { id: 'bogus', tier: 'abc', status: 'not-installed' }], bosses: { 'search-boss': { max_tier: 1, allow_servers: ['weird', 'huge', 'bogus'] } } });
const mcpdBad = D.mcpDormancy(MCPD_BADTIER);
t('mcpDormancy: a float-string / out-of-range / non-numeric tier is each flagged (fail-closed, never certified clean)', mcpdBad.ok === false && ['weird', 'huge', 'bogus'].every((s) => mcpdBad.violations.some((v) => v.server === s)));

// a covering-max string tier below 3 must still be caught as exceeding when appropriate (normalized compare)
const MCPD_STR_EXCEED = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-strexceed-'));
mdWrite(MCPD_STR_EXCEED, { servers: [{ id: 'playwright', tier: '2', status: 'not-installed' }], bosses: { 'build-boss': { max_tier: 0, allow_servers: ['playwright'] } } });
const mcpdStrExceed = D.mcpDormancy(MCPD_STR_EXCEED);
t('mcpDormancy: a string tier "2" is normalized and still flagged as exceeding a max_tier of 0', mcpdStrExceed.ok === false && mcpdStrExceed.violations.some((v) => v.server === 'playwright' && (v.type === 'grant_exceeds_max_tier' || v.type === 'malformed_server_tier')));

// a fully clean config -> ok:true, 0 violations
const MCPD_CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-clean-'));
mdWrite(MCPD_CLEAN, { servers: [SERVER_T0, SERVER_T1, SERVER_T2], bosses: { 'build-boss': { max_tier: 0, allow_servers: ['serena-lsp'] }, 'search-boss': { max_tier: 1, allow_servers: ['context7'] } } });
const mcpdClean = D.mcpDormancy(MCPD_CLEAN);
t('mcpDormancy: a fully dormant, self-consistent, least-privilege config is ok=true with 0 violations', mcpdClean.ok === true && mcpdClean.violations.length === 0);

// missing config files -> ok:false, explicit reason, never a silent pass
const MCPD_MISSING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-missing-'));
const mcpdMissing = D.mcpDormancy(MCPD_MISSING);
t('mcpDormancy: missing mcp-registry.json -> ok=false, explicit reason (never a silent pass)', mcpdMissing.ok === false && /could not read\/parse mcp-registry\.json/.test(mcpdMissing.reason));

// real-project regression guard: this project's OWN mcp-registry.json/mcp-grants.json (WAVE G1) must stay
// dormant and least-privilege — a real violation here would mean the safety doctrine itself regressed.
const mcpdReal = D.mcpDormancy(REAL_PROJECT_ROOT);
t('mcpDormancy: the real project\'s MCP registry/grants are fully dormant + least-privilege (ok:true)', mcpdReal.ok === true, JSON.stringify(mcpdReal.violations || mcpdReal.reason));

// --- runDoctor()/printSummary(): sync_completeness/memory_discipline/mcp_dormancy/run_contract stay
// ADVISORY-ONLY — a real gap in ANY of these must NEVER flip runDoctor()'s top-level ok, mirroring the exact
// same core guarantee backfillContinuity already proves above. (unregistered_event/check_the_checks moved OUT
// of this guarantee 2026-07-22 — V9-INTEGRATE promoted them to ENFORCED; see the dedicated section below.)
function makeCompletenessBase(dirName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), dirName));
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'good.cjs'), "'use strict';\nmodule.exports = {};\n");
  // V9-INTEGRATE: check_the_checks is now ENFORCED — this base fixture's own "clean" suite must
  // carry a REAL assertion site (assert.ok(...)) or it would trip check_the_checks itself as a green no-op,
  // which would make every "stays advisory" fixture below fail for the wrong reason.
  fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'good.test.cjs'), "const assert = require('assert');\nassert.ok(true);\nconsole.log('1 passed, 0 failed');\nprocess.exit(0);\n");
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  // same reasoning as GREEN_ROOT above — server.cjs + its stub SPA files are no longer needed
  // for spaPresent()'s `ok` to be true (absent is now the healthy state).
  copyShippedAgents(path.join(root, '.claude', 'agents'));
  sanitizeReadOnlyAgentMemory(path.join(root, '.claude', 'agents'));
  fs.mkdirSync(path.join(root, '.claude', 'config', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), path.join(root, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
  return root;
}

const COMPLETE_GREEN_ROOT = makeCompletenessBase('forge-doctor-completeness-green-');
// deliberately introduce a real completeness GAP that is STILL advisory-only: an unsynced skill dir
// (sync_completeness). Does NOT introduce an unregistered-event usage here — that gap now belongs to the
// dedicated ENFORCED-check fixtures below (unregistered_event genuinely flips doctor.ok since 2026-07-22).
// forge-sync's delivery list is derived from the shipping manifest and the REAL manifest ships
// every skill folder whole, so the gap is built the honest way — this fixture carries its own valid manifest that
// ships the toolkit, dashboard, agents and config but no skills (a synced project validates its shape; still n/a).
fs.mkdirSync(path.join(COMPLETE_GREEN_ROOT, '.claude', 'config', 'orchestration'), { recursive: true });
fs.writeFileSync(path.join(COMPLETE_GREEN_ROOT, '.claude', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'), JSON.stringify({
  schema: 'forge-ship-manifest/v1',
  rules: [
    { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture toolkit' },
    { pattern: '.claude/forge-dashboard/*.cjs', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture dashboard' },
    { pattern: '.claude/agents/*.md', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture agents' },
    { pattern: '.claude/config/**', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'fixture config' },
  ],
  known_gaps: [],
}));
fs.mkdirSync(path.join(COMPLETE_GREEN_ROOT, '.claude', 'skills', 'never-in-any-manifest'), { recursive: true });
fs.writeFileSync(path.join(COMPLETE_GREEN_ROOT, '.claude', 'skills', 'never-in-any-manifest', 'SKILL.md'), '# gap\n');
const completeGreenRep = D.runDoctor(COMPLETE_GREEN_ROOT);
t('runDoctor completeness fixture: all real checks still pass (an advisory-only gap never touches `checks`)', completeGreenRep.ok === true, JSON.stringify(Object.entries(completeGreenRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('runDoctor completeness fixture: advisory.completeness DOES surface the real sync gap', completeGreenRep.advisory.completeness.sync_completeness.missing.includes('skills/never-in-any-manifest/SKILL.md'));
// run_contract moved from advisory.completeness to the ENFORCED checks.
t('runDoctor completeness fixture: checks.run_contract (enforced since WP-5) degrades honestly to ok:true (no forge-runs dir -> "no dispatched run to check yet")', completeGreenRep.checks.run_contract.ok === true && completeGreenRep.checks.run_contract.run_id === null && /no dispatched run to check yet/.test(completeGreenRep.checks.run_contract.reason));
t('runDoctor completeness fixture: run_contract is no longer an advisory.completeness key (one verdict, not two)', !Object.prototype.hasOwnProperty.call(completeGreenRep.advisory.completeness, 'run_contract'));
t('runDoctor completeness fixture: a real advisory-only gap does NOT flip doctor.ok to false (advisory-STOP surfacing, never a hard crash)', completeGreenRep.ok === true);
const completeSummary = D.printSummary(completeGreenRep);
t('printSummary: prints one compact "completeness" advisory line naming the real gap', /completeness \(advisory, non-blocking\)/.test(completeSummary) && /sync-completeness/.test(completeSummary));
t('printSummary: unregistered-event/check-the-checks no longer appear in the completeness advisory line (they are now enforced checks-lines)', !/completeness[^\n]*unregistered-event/.test(completeSummary) && !/completeness[^\n]*check-the-checks/.test(completeSummary));
t('printSummary: the completeness advisory line never appears as a ✗ (hard-fail) line', !/✗ completeness/.test(completeSummary));

// --- skill_evals (wp-skill-evals): ADVISORY-ONLY wrapper around forge-skill-evals.cjs -------
// A real failing per-skill assertion must surface in advisory.completeness.skill_evals and in
// printSummary's compact completeness line, but must NEVER flip runDoctor()'s hard `ok` verdict — same
// core guarantee every other completeness sub-check above already proves.
const SKILLEVALS_ROOT = makeCompletenessBase('forge-doctor-skillevals-');
fs.mkdirSync(path.join(SKILLEVALS_ROOT, '.claude', 'skills', 'fixture-skill'), { recursive: true });
fs.writeFileSync(path.join(SKILLEVALS_ROOT, '.claude', 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: a fixture skill\n---\n\n# fixture-skill\n');
fs.writeFileSync(path.join(SKILLEVALS_ROOT, '.claude', 'skills', 'fixture-skill', 'evals.json'), JSON.stringify({
  skill: 'fixture-skill', assertions: [{ id: 'missing-thing', type: 'file_exists', path: 'this/does/not/exist.txt' }],
}));
const skillEvalsRep = D.runDoctor(SKILLEVALS_ROOT);
t('runDoctor skill_evals fixture: all real checks still pass (an advisory-only eval failure never touches `checks`)', skillEvalsRep.ok === true, JSON.stringify(Object.entries(skillEvalsRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('runDoctor skill_evals fixture: advisory.completeness.skill_evals surfaces the real failing assertion', skillEvalsRep.advisory.completeness.skill_evals.ok === false && skillEvalsRep.advisory.completeness.skill_evals.skills.some((s) => s.skill === 'fixture-skill' && s.failed === 1));
t('runDoctor skill_evals fixture: a real advisory-only eval failure does NOT flip doctor.ok to false', skillEvalsRep.ok === true);
const skillEvalsSummary = D.printSummary(skillEvalsRep);
t('printSummary: names the failing skill+assertion under "skill-evals:"', /skill-evals: fixture-skill/.test(skillEvalsSummary) && /missing-thing/.test(skillEvalsSummary));
t('printSummary: skill_evals gap still renders as advisory (⚠), never a hard ✗ completeness line', !/✗ completeness/.test(skillEvalsSummary));

// real-project regression guard: this project's OWN 5 wired skills (forge-intake/router/code-review/
// verify/snapshot, wp-skill-evals 2026-07-31) must all be green — a real failure here would mean one of
// those skills' own evals genuinely regressed.
const realSkillEvalsCheck = D.skillEvalsDoctorCheck(REAL_PROJECT_ROOT);
t('skillEvalsDoctorCheck: the real project\'s own wired skills (forge-intake/router/code-review/verify/snapshot) are all green', realSkillEvalsCheck.ok === true, JSON.stringify(realSkillEvalsCheck.skills.filter((s) => !s.ok)));
// wp-disclosure-ab added a 6th wired skill (forge-skill-testing, dogfooding its own protocol) —
// this list grows again the next time a real skill opts into evals.json; that is expected drift, not a bug.
// 2026-10-10 (overhaul): forge-scribe opted into evals.json (10 binary checks + activation fixture).
// 2026-10-24 (modernization WP I.3, integrated in 2.9b): the new forge-craft skill ships its own evals.json.
// 2026-11-02 (WP Q3-SKILLS): the new forge-auth and forge-database playbooks ship their own evals.json.
// 2026-11-05 (batch A): 9 more skills ship evals.json: forge-context, forge-debug, forge-memory,
// forge-plan-large, forge-security-review, forge-team-orchestration, forge-testing, forge-token-economy, ponytail.
// 2026-11-05 (batch B): 15 more ship evals.json: claude-md-improver, forge-a11y, forge-autoresearch, forge-bots, forge-i18n-docs,
// forge-integration, forge-long-form-writing, forge-mcp-clients, forge-n8n, forge-payments, forge-projectbrain, forge-skill-authoring,
// forge-ui-polish, humanizer, poteto-mode.
devTreeOnly('skillEvalsDoctorCheck: the real project has exactly the 43 evaluated skills (10 up to Q3-SKILLS 2026-11-02 + 9 wave 1 batch A + 15 wave 1 batch B + 6 wave 1 batch C 2026-11-05 + 2 W2-WIRE + 1 W2-GRAFTS (forge-data) 2026-11-06; no silent drift)', () =>
  t('skillEvalsDoctorCheck: the real project has exactly the 43 evaluated skills (10 up to Q3-SKILLS 2026-11-02 + 9 wave 1 batch A + 15 wave 1 batch B + 6 wave 1 batch C 2026-11-05 + 2 W2-WIRE + 1 W2-GRAFTS (forge-data) 2026-11-06; no silent drift)', realSkillEvalsCheck.skills.map((s) => s.skill).sort().join(',') === ['claude-md-improver', 'forge-a11y', 'forge-auth', 'forge-autoresearch', 'forge-bots', 'forge-code-review', 'forge-context', 'forge-craft', 'forge-data', 'forge-database', 'forge-debug', 'forge-devops', 'forge-ecc-adapter', 'forge-i18n-docs', 'forge-intake', 'forge-integration', 'forge-long-form-writing', 'forge-mcp-clients', 'forge-memory', 'forge-n8n', 'forge-observability', 'forge-payments', 'forge-plan-large', 'forge-projectbrain', 'forge-release', 'forge-research-evidence', 'forge-router', 'forge-scraping', 'forge-scribe', 'forge-security-review', 'forge-skill-authoring', 'forge-skill-testing', 'forge-snapshot', 'forge-team-orchestration', 'forge-testing', 'forge-token-economy', 'forge-ui-polish', 'forge-verify', 'forge-windows-shell', 'humanizer', 'ponytail', 'poteto-mode', 'ship-readiness'].sort().join(','), JSON.stringify(realSkillEvalsCheck.skills.map((s) => s.skill).sort())));

// ===========================================================================================================
// V9-INTEGRATE: unregistered_event / check_the_checks are now ENFORCED (folded into `checks`/
// `ok`) — a genuine gap DOES flip doctor.ok to false; FORGE_HARD_RULES.json's doctor_check_overrides gives an
// explicit, logged, recoverable escape hatch. Mirrors the exact same fixture shape as the advisory-only
// guarantee above, just proving the opposite direction (ENFORCED -> blocks; overridden -> recovers).
// ===========================================================================================================
function writeHardRules(root, doctorOverrides) {
  const p = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'FORGE_HARD_RULES.json'), JSON.stringify({ version: 1, rules: [], doctor_check_overrides: doctorOverrides || [] }));
}

// (a) unregistered_event: a genuine unregistered literal event_type flips doctor.ok to false
const UE_GAP_ROOT = makeCompletenessBase('forge-doctor-v9-ue-gap-');
fs.writeFileSync(path.join(UE_GAP_ROOT, '.claude', 'forge-bin', 'gap-tool.cjs'),
  "function logEvent(runId, eventType, extra) {}\nlogEvent(RUN, 'a_completely_made_up_type', {});\n");
const ueGapRep = D.runDoctor(UE_GAP_ROOT);
t('V9-INTEGRATE: an unregistered event_type usage flips checks.unregistered_event.ok to false', ueGapRep.checks.unregistered_event.ok === false && ueGapRep.checks.unregistered_event.unregistered.some((u) => u.event_type === 'a_completely_made_up_type'));
t('V9-INTEGRATE: an unregistered event_type usage flips the WHOLE doctor.ok to false (now enforced, not advisory)', ueGapRep.ok === false);
t('V9-INTEGRATE: an unenforced/un-overridden unregistered_event never has overridden:true', !ueGapRep.checks.unregistered_event.overridden);
const ueGapSummary = D.printSummary(ueGapRep);
t('printSummary: unregistered event line renders as ✗ (hard-fail), naming the gap', /✗ unreg\. events[^\n]*a_completely_made_up_type/.test(ueGapSummary));
t('printSummary: overall verdict reads FAILURES ABOVE, not ALL GREEN', /FAILURES ABOVE/.test(ueGapSummary) && !/ALL GREEN/.test(ueGapSummary));

// (measured on the first CI run) a suite that CRASHES before its tally used to leave the
// tests line reading "… / 0 failed · 1 SUITE(S) FAILED" and naming nothing — useless on a runner where the
// per-suite output is not at hand. The red suites are now named, with why.
const CRASH_ROOT = makeCompletenessBase('forge-doctor-crash-suite-');
fs.writeFileSync(path.join(CRASH_ROOT, '.claude', 'forge-bin', 'boom.test.cjs'), "const assert = require('assert');\nassert.ok(true);\nthrow new Error('boom before the tally');\n");
const crashRep = D.runDoctor(CRASH_ROOT);
t('runTests: a suite that throws before its tally counts as a FAILED suite with 0 failed assertions', crashRep.checks.tests.ok === false && crashRep.checks.tests.failed === 0 && crashRep.checks.tests.suitesFailed === 1);
const crashSummary = D.printSummary(crashRep);
t('printSummary: the tests line NAMES the crashed suite and says why (crashed or no tally)', /✗ tests[^\n]*boom\.test\.cjs \(crashed or no tally\)/.test(crashSummary), crashSummary.split('\n').find((l) => /tests/.test(l)));
t('printSummary: a green suite in the same fixture is NOT listed as red', !/good\.test\.cjs/.test(crashSummary.split('\n').find((l) => /✗ tests/.test(l)) || ''));

// (a') the SAME gap, but with a real, reasoned, logged doctor_check_overrides entry -> recovers to ok:true
const UE_OVERRIDE_ROOT = makeCompletenessBase('forge-doctor-v9-ue-override-');
fs.writeFileSync(path.join(UE_OVERRIDE_ROOT, '.claude', 'forge-bin', 'gap-tool.cjs'),
  "function logEvent(runId, eventType, extra) {}\nlogEvent(RUN, 'a_completely_made_up_type', {});\n");
writeHardRules(UE_OVERRIDE_ROOT, [{ check: 'unregistered_event', reason: 'owner-reviewed: gap-tool.cjs is a throwaway test fixture, not real code', by: 'owner', ts: '2026-07-22T00:00:00Z' }]);
const ueOverrideRep = D.runDoctor(UE_OVERRIDE_ROOT);
t('V9-INTEGRATE override: a logged doctor_check_overrides entry recovers checks.unregistered_event.ok to true', ueOverrideRep.checks.unregistered_event.ok === true && ueOverrideRep.checks.unregistered_event.overridden === true);
t('V9-INTEGRATE override: the real reason/by are carried on the result, never fabricated', ueOverrideRep.checks.unregistered_event.override_reason.includes('throwaway test fixture') && ueOverrideRep.checks.unregistered_event.override_by === 'owner');
t('V9-INTEGRATE override: the WHOLE doctor.ok recovers to true', ueOverrideRep.ok === true);
const ueOverrideSummary = D.printSummary(ueOverrideRep);
t('printSummary: an overridden check still prints ✓ (it IS a pass) but with a visible [OVERRIDDEN...] tag — never a silent bypass', /✓ unreg\. events[^\n]*\[OVERRIDDEN by owner: owner-reviewed/.test(ueOverrideSummary));
t('printSummary: an overridden-recovery run reads ALL GREEN', /ALL GREEN/.test(ueOverrideSummary));

// (b) check_the_checks: a genuine green-no-op suite flips doctor.ok to false
const CTC_GAP_ROOT = makeCompletenessBase('forge-doctor-v9-ctc-gap-');
fs.writeFileSync(path.join(CTC_GAP_ROOT, '.claude', 'forge-bin', 'noop.test.cjs'), "console.log('5 passed, 0 failed');\nprocess.exit(0);\n");
const ctcGapRep = D.runDoctor(CTC_GAP_ROOT);
t('V9-INTEGRATE: a green no-op suite flips checks.check_the_checks.ok to false', ctcGapRep.checks.check_the_checks.ok === false && ctcGapRep.checks.check_the_checks.noOp.some((n) => n.suite === 'noop.test.cjs'));
t('V9-INTEGRATE: a green no-op suite flips the WHOLE doctor.ok to false', ctcGapRep.ok === false);

// (b') the SAME gap, overridden -> recovers to ok:true
const CTC_OVERRIDE_ROOT = makeCompletenessBase('forge-doctor-v9-ctc-override-');
fs.writeFileSync(path.join(CTC_OVERRIDE_ROOT, '.claude', 'forge-bin', 'noop.test.cjs'), "console.log('5 passed, 0 failed');\nprocess.exit(0);\n");
writeHardRules(CTC_OVERRIDE_ROOT, [{ check: 'check_the_checks', reason: 'owner-reviewed: noop.test.cjs is a deliberately minimal smoke stub, tracked in a follow-up ticket', by: 'owner', ts: '2026-07-22T00:00:00Z' }]);
const ctcOverrideRep = D.runDoctor(CTC_OVERRIDE_ROOT);
t('V9-INTEGRATE override: a logged doctor_check_overrides entry recovers checks.check_the_checks.ok to true', ctcOverrideRep.checks.check_the_checks.ok === true && ctcOverrideRep.checks.check_the_checks.overridden === true);
t('V9-INTEGRATE override: the WHOLE doctor.ok recovers to true', ctcOverrideRep.ok === true);

// (c) loadDoctorCheckOverrides()/applyDoctorOverride() pure-function guarantees
t('loadDoctorCheckOverrides: a missing FORGE_HARD_RULES.json degrades to [] (never throws)', Array.isArray(D.loadDoctorCheckOverrides(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nohardrules-')))) && D.loadDoctorCheckOverrides(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nohardrules2-'))).length === 0);
const BLANK_OV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-blankoverride-'));
writeHardRules(BLANK_OV_ROOT, [{ check: 'unregistered_event', reason: '   ' }, { check: '', reason: 'valid reason but no check id' }, { reason: 'no check field at all' }]);
t('loadDoctorCheckOverrides: a blank/templated reason or missing check id is silently dropped (never a fabricated override)', D.loadDoctorCheckOverrides(BLANK_OV_ROOT).length === 0);
t('applyDoctorOverride: a check that ALREADY passes is returned unchanged, even with a matching override entry (never fabricates extra positivity)', (() => {
  const map = new Map([['x', { reason: 'r', by: 'owner' }]]);
  const passing = { ok: true, foo: 1 };
  const out = D.applyDoctorOverride(map, 'x', passing);
  return out === passing || (out.ok === true && !out.overridden);
})());
t('applyDoctorOverride: a failing check with NO matching override entry is returned unchanged', (() => {
  const failing = { ok: false, reason: 'gap' };
  const out = D.applyDoctorOverride(new Map(), 'x', failing);
  return out.ok === false && !out.overridden;
})());

// --- runContractDoctorCheck() / latestRunIdFor() — direct pure-function proof (real forge-runs fixtures) ---
t('latestRunIdFor: a fresh project with no forge-runs dir returns null', D.latestRunIdFor(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-norunsdir-'))) === null);
const RC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-runcontract-'));
/** R6-06 (zesde Codex-herreview): `opts.root` stuurt sinds die fix ook de REGELSET — een run uit root B
 *  mag niet tegen de regels van installatie A worden beoordeeld. Deze fixture leunde op precies die
 *  fallback (temp-root zonder regelbestand), dus hij brengt zijn regels nu zelf mee, zoals een echt
 *  project dat ook doet. */
const seedRules = (root) => {
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'),
    path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
};
seedRules(RC_ROOT);
fs.mkdirSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-01-01-old'), { recursive: true });
fs.mkdirSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-06-01-newest'), { recursive: true });
fs.writeFileSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-01-01-old', 'events.jsonl'), '');
fs.writeFileSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-06-01-newest', 'events.jsonl'), '');
// a genuinely DISPATCHED run always carries a real run.json — give both fixture
// dirs one so they qualify under latestDispatchedRunIdFor()'s stricter filter too (this fixture predates
// that filter and only ever seeded events.jsonl; see the dedicated receipt-only-vs-dispatched block below
// for the NEW behavior this refinement adds).
fs.writeFileSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-01-01-old', 'run.json'), '{}');
fs.writeFileSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-06-01-newest', 'run.json'), '{}');
t('latestRunIdFor: picks the lexically-newest run id, not just readdir order', D.latestRunIdFor(RC_ROOT) === 'forge-2026-06-01-newest');
t('latestDispatchedRunIdFor: agrees with latestRunIdFor when every candidate genuinely has a real run.json', D.latestDispatchedRunIdFor(RC_ROOT) === 'forge-2026-06-01-newest');
/** MEASURED REGRESSION (on this very project): ranking by file mtime means ANY metadata write
 *  reorders history. forge-finalize's new markRunFinalized() rewrote an old run's run.json; that single
 *  touch promoted a long-finished (green) run to "latest dispatched run", so runContractDoctorCheck
 *  reported "run contract satisfied" while the genuinely active run still had 5 required rules missing —
 *  a real gap made INVISIBLE by a bookkeeping write. forge-snapshot.cjs already learned this exact lesson
 *  on 2026-08-01 and re-ranked by work recency in ITS OWN code; the shared core kept the flaw, so the next
 *  caller inherited it. Recency of a RUN is the recency of its WORK: event timestamps are written once and
 *  never rewritten, file mtimes are not. */
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rank-mtime-'));
  const mk = (naam, laatsteEventISO) => {
    const d = path.join(R, '.claude', 'forge-runs', naam);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ run_id: naam, status: 'completed' }));
    fs.writeFileSync(path.join(d, 'events.jsonl'), JSON.stringify({ event_type: 'run_started', timestamp: laatsteEventISO }) + '\n');
    return d;
  };
  const oud = mk('forge-2026-01-01-oud', '2026-01-01T10:00:00.000Z');
  mk('forge-2026-08-01-actief', '2026-08-01T10:00:00.000Z');
  t('rankRunCandidates: het echte werk bepaalt de volgorde, niet de bestandsdatum',
    D.latestDispatchedRunIdFor(R) === 'forge-2026-08-01-actief');
  // nu exact de regressie: alleen de METADATA van de oude run aanraken, geen enkel nieuw event
  fs.writeFileSync(path.join(oud, 'run.json'), JSON.stringify({ run_id: 'forge-2026-01-01-oud', status: 'completed', finalized_at: 'nu' }));
  t('rankRunCandidates: een metadata-write op een OUDE run promoveert hem NIET tot nieuwste',
    D.latestDispatchedRunIdFor(R) === 'forge-2026-08-01-actief', 'gekozen: ' + D.latestDispatchedRunIdFor(R));
  t('rankRunCandidates: de activiteitstijd is zichtbaar naast de mtime (controleerbaar, niet verstopt)',
    D.rankRunCandidates(R, { requireDispatched: true }).every((c) => Number.isFinite(c.activityMs)));
  // en zonder events valt hij eerlijk terug op de mtime — een run zonder eventlog mag niet onzichtbaar worden
  const geenEvents = path.join(R, '.claude', 'forge-runs', 'forge-2026-09-01-geen-events');
  fs.mkdirSync(geenEvents, { recursive: true });
  fs.writeFileSync(path.join(geenEvents, 'run.json'), JSON.stringify({ run_id: 'x', status: 'running' }));
  t('rankRunCandidates: zonder eventlog is de mtime de eerlijke terugval',
    D.latestDispatchedRunIdFor(R) === 'forge-2026-09-01-geen-events', 'gekozen: ' + D.latestDispatchedRunIdFor(R));
}

const rcCheck = D.runContractDoctorCheck(RC_ROOT);
// enforced, but phase-aware — a dispatched run that has not claimed completion is never red;
// it is reported as in progress with its missing rules still named (the red cases are proven in the block below).
t('runContractDoctorCheck: an empty dispatched run that never claimed completion is in progress — ok:true, the missing rules still named, never red before completion', rcCheck.ok === true && rcCheck.status === 'in-progress' && Array.isArray(rcCheck.missing) && rcCheck.missing.length > 0 && rcCheck.run_id === 'forge-2026-06-01-newest', JSON.stringify(rcCheck).slice(0, 300));
const rcNoRuns = D.runContractDoctorCheck(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rc-norun-'))); // no .claude/forge-runs at all yet
t('runContractDoctorCheck: a project with zero runs at all degrades honestly to ok:true ("no dispatched run to check yet"), never a false-red on a fresh project', rcNoRuns.ok === true && /no dispatched run to check yet/.test(rcNoRuns.reason));

// ===========================================================================================================
// receipt-only directory vs. a genuine dispatched run. `forge-doctor --run <id>`'s
// own CLI body (see below) writes a doctor.json snapshot + logs one synthetic `doctor_run` event into
// forge-runs/<id>/events.jsonl but NEVER writes a run.json — that directory must never be mistaken for a
// real dispatched run whose non-negotiables are worth evaluating (this was a REAL bug found live against
// this project's own forge-runs/ — see build-boss MEMORY.md).
// ===========================================================================================================
const RECEIPT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-receiptonly-'));
seedRules(RECEIPT_ROOT); // elke root draagt zijn eigen regels (zie seedRules hierboven)
const receiptDir = path.join(RECEIPT_ROOT, '.claude', 'forge-runs', 'forge-2026-07-22-receipt-only');
fs.mkdirSync(receiptDir, { recursive: true });
fs.writeFileSync(path.join(receiptDir, 'doctor.json'), JSON.stringify({ ok: true }));
fs.writeFileSync(path.join(receiptDir, 'events.jsonl'), JSON.stringify({ run_id: 'forge-2026-07-22-receipt-only', event_type: 'doctor_run', agent: 'reviewer', ok: true }) + '\n');
t('latestRunIdFor (general picker): a receipt-only dir (doctor.json + one doctor_run event, no run.json) IS still a pickable "any run" candidate', D.latestRunIdFor(RECEIPT_ROOT) === 'forge-2026-07-22-receipt-only');
t('latestDispatchedRunIdFor: the SAME receipt-only dir is correctly IGNORED (no real run.json -> not a genuine dispatch)', D.latestDispatchedRunIdFor(RECEIPT_ROOT) === null);
const receiptOnlyCheck = D.runContractDoctorCheck(RECEIPT_ROOT);
t('runContractDoctorCheck: a project whose ONLY forge-runs/ entry is a receipt-only dir degrades honestly to ok:true ("no dispatched run to check yet"), NEVER "N rules missing on <receipt dir>"', receiptOnlyCheck.ok === true && receiptOnlyCheck.run_id === null && /no dispatched run to check yet/.test(receiptOnlyCheck.reason));

// now add a genuine dispatched run (real run.json) OLDER than the receipt dir, then a NEWER one — proves the
// picker correctly ignores the receipt dir regardless of its own recency and picks the real dispatched run.
const dispatchedDir = path.join(RECEIPT_ROOT, '.claude', 'forge-runs', 'forge-2026-07-21-real-dispatch');
fs.mkdirSync(dispatchedDir, { recursive: true });
fs.writeFileSync(path.join(dispatchedDir, 'run.json'), '{}');
fs.writeFileSync(path.join(dispatchedDir, 'events.jsonl'), '');
const OLDER = new Date('2020-01-01T00:00:00Z'), NEWER = new Date('2020-06-01T00:00:00Z');
fs.utimesSync(dispatchedDir, OLDER, OLDER); fs.utimesSync(path.join(dispatchedDir, 'run.json'), OLDER, OLDER); fs.utimesSync(path.join(dispatchedDir, 'events.jsonl'), OLDER, OLDER);
fs.utimesSync(receiptDir, NEWER, NEWER); fs.utimesSync(path.join(receiptDir, 'events.jsonl'), NEWER, NEWER); fs.utimesSync(path.join(receiptDir, 'doctor.json'), NEWER, NEWER);
t('latestDispatchedRunIdFor: a real dispatched run is picked even when a receipt-only dir is objectively MORE recent', D.latestDispatchedRunIdFor(RECEIPT_ROOT) === 'forge-2026-07-21-real-dispatch');
const mixedCheck = D.runContractDoctorCheck(RECEIPT_ROOT);
t('runContractDoctorCheck: with a real dispatched run present, it is evaluated (naming ITS missing rules), never the newer receipt-only dir', mixedCheck.run_id === 'forge-2026-07-21-real-dispatch' && mixedCheck.status === 'in-progress' && mixedCheck.missing.length > 0, JSON.stringify(mixedCheck).slice(0, 300));

// ===========================================================================================================
// break-swarm DEFECT 4 repro: the OLD latestRunIdFor() picked "latest" by a plain
// lexical NAME sort — a clean decoy run whose directory name simply sorts higher masked a genuinely NEWER,
// real-violating run whose name sorts lower, so runContractDoctorCheck() silently evaluated the WRONG run.
// This fixture proves the fix ranks by REAL recency (mtime) instead, with an explicit, deterministic mtime
// per candidate (fs.utimesSync) so the assertion never depends on real wall-clock execution speed.
// ===========================================================================================================
const DEFECT4_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-defect4-'));
seedRules(DEFECT4_ROOT); // elke root draagt zijn eigen regels
const decoyDir = path.join(DEFECT4_ROOT, '.claude', 'forge-runs', 'zzz-decoy-clean-run'); // name sorts HIGHEST
const violatingDir = path.join(DEFECT4_ROOT, '.claude', 'forge-runs', 'aaa-real-violating-run'); // name sorts LOWEST
const strayDir = path.join(DEFECT4_ROOT, '.claude', 'forge-runs', 'zzzz-not-a-real-run-dir'); // not a real run dir at all
fs.mkdirSync(decoyDir, { recursive: true });
fs.mkdirSync(violatingDir, { recursive: true });
fs.mkdirSync(strayDir, { recursive: true });

// decoy: a genuinely CLEAN run (satisfies every real "always" rule) — proves the fix isn't just "pick the
// dirtiest run", it genuinely tracks real recency regardless of which run happens to look clean.
const decoyEvents = [
  { event_type: 'memory_loaded', agent: 'orchestrator' },
  { event_type: 'owner_prefs_loaded', agent: 'orchestrator' },
  { event_type: 'research_done', agent: 'orchestrator' }, { event_type: 'skill_map_created', agent: 'orchestrator' },
  { event_type: 'prd_generated', agent: 'orchestrator' },
  { event_type: 'agent_started', agent: 'Build Boss' },
  { event_type: 'zero_console_errors_noted', agent: 'UI Boss' },
  { event_type: 'check_passed', agent: 'Test Boss' },
].map((o) => JSON.stringify(o)).join('\n') + '\n';
fs.writeFileSync(path.join(decoyDir, 'events.jsonl'), decoyEvents);
fs.writeFileSync(path.join(decoyDir, 'final-report.md'), '# Report\n');
fs.writeFileSync(path.join(decoyDir, 'run.json'), '{}');
// violating: a run that did nothing yet CLAIMED completion (misses every always-rule).: the
// enforced run_contract check is red only for a completion claim, so the violation is a run_completed over an
// empty contract — stamped now, i.e. after RUN_CONTRACT_ENFORCED_SINCE.
fs.writeFileSync(path.join(violatingDir, 'events.jsonl'), [
  { run_id: 'aaa-real-violating-run', event_type: 'run_started', agent: 'orchestrator', timestamp: new Date().toISOString() },
  { run_id: 'aaa-real-violating-run', event_type: 'run_completed', agent: 'orchestrator', timestamp: new Date().toISOString() },
].map((o) => JSON.stringify(o)).join('\n') + '\n');
fs.writeFileSync(path.join(violatingDir, 'run.json'), '{}');
// stray: no run.json / events.jsonl at all — must never be treated as a run directory
fs.writeFileSync(path.join(strayDir, 'readme.txt'), 'not a run');

// explicit, deterministic mtimes: decoy is OLD, violating is NEWER, stray is NEWEST of all (must still be ignored)
const OLD_TIME = new Date('2020-01-01T00:00:00Z');
const NEW_TIME = new Date('2020-06-01T00:00:00Z');
const NEWEST_TIME = new Date('2020-06-02T00:00:00Z');
fs.utimesSync(path.join(decoyDir, 'events.jsonl'), OLD_TIME, OLD_TIME);
fs.utimesSync(path.join(decoyDir, 'run.json'), OLD_TIME, OLD_TIME);
fs.utimesSync(decoyDir, OLD_TIME, OLD_TIME);
fs.utimesSync(path.join(violatingDir, 'events.jsonl'), NEW_TIME, NEW_TIME);
fs.utimesSync(path.join(violatingDir, 'run.json'), NEW_TIME, NEW_TIME);
fs.utimesSync(violatingDir, NEW_TIME, NEW_TIME);
fs.utimesSync(path.join(strayDir, 'readme.txt'), NEWEST_TIME, NEWEST_TIME);
fs.utimesSync(strayDir, NEWEST_TIME, NEWEST_TIME);

t('DEFECT 4 repro: latestRunIdFor picks the NEWER violating run, not the lexically-higher-named clean decoy', D.latestRunIdFor(DEFECT4_ROOT) === 'aaa-real-violating-run');
t('DEFECT 4 repro: a stray non-run directory (no run.json/events.jsonl) is never picked, even with the newest mtime and the highest name', D.latestRunIdFor(DEFECT4_ROOT) !== 'zzzz-not-a-real-run-dir');

const defect4Check = D.runContractDoctorCheck(DEFECT4_ROOT);
t('DEFECT 4 repro: runContractDoctorCheck evaluates the NEWER violating run, not the older clean decoy', defect4Check.run_id === 'aaa-real-violating-run');
t('DEFECT 4 repro: the doctor honestly reports the (correctly-selected) violating run as ok:false — the enforcement surface now points at the right run', defect4Check.ok === false && defect4Check.missing.length > 0);

// ===========================================================================================================
// audit T11/S4/S5): run_contract is ENFORCED.
// Red ONLY for the newest run's completion claim over an unmet sequence, a skipped finalize, or a STALE receipt;
// never for a run in progress, an honest failure close, or a claim older than RUN_CONTRACT_ENFORCED_SINCE.
// Finalized runs are read through forge-finalize check() with cause/reverified — a bare HISTORICAL is never
// called "re-verified". Fixtures are built through COPIES of the real writer/contract/finalize in temp roots.
// ===========================================================================================================
{
  const { spawnSync } = require('child_process');
  const wp5Roots = [];
  const wp5Root = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-wp5-'));
    wp5Roots.push(root);
    const cd = path.join(root, '.claude');
    for (const d of ['forge-dashboard', 'forge-bin', path.join('config', 'orchestration'), path.join('config', 'agents'), 'agents', 'forge-runs']) fs.mkdirSync(path.join(cd, d), { recursive: true });
    fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), path.join(cd, 'forge-dashboard', 'log-event.cjs'));
    for (const f of ['forge-runcontract.cjs', 'forge-finalize.cjs', 'forge-proof-gate.cjs', 'forge-claim-check.cjs', 'forge-claim-reports.cjs']) fs.copyFileSync(path.join(__dirname, f), path.join(cd, 'forge-bin', f));
    fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), path.join(cd, 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
    fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-registry.json'), path.join(cd, 'config', 'agents', 'agent-registry.json'));
    copyShippedAgents(path.join(cd, 'agents'));
    return root;
  };
  const wenv = Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '1' });
  delete wenv.FORGE_COMPLETION_GATE;
  const wbatch = (root, run, lines) => spawnSync(process.execPath, [path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'), '--batch', run], { input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', encoding: 'utf8', env: wenv });
  const wrc = (root, args) => spawnSync(process.execPath, [path.join(root, '.claude', 'forge-bin', 'forge-runcontract.cjs'), ...args, '--root', root], { encoding: 'utf8', env: wenv });
  const runDir = (root, run) => path.join(root, '.claude', 'forge-runs', run);
  /** a full L1 run through steps 1-3 of the completion sequence (gate evidence, report, green proof) */
  const greenRun = (root, run) => {
    const steps = [];
    steps.push(wbatch(root, run, [{ event_type: 'run_started', agent: 'orchestrator' }, { event_type: 'memory_loaded', agent: 'orchestrator' }, { event_type: 'owner_prefs_loaded', agent: 'orchestrator' }, { event_type: 'research_done', agent: 'orchestrator', note: 'looked for an existing implementation' }, { event_type: 'skill_map_created', agent: 'orchestrator' }]));
    steps.push(wrc(root, ['check', '--run', run, '--phase', 'preview', '--log-event']));
    steps.push(wbatch(root, run, [
      { event_type: 'agent_work_package_created', agent: 'Build Boss', wp_id: 'WP-1', mission: 'build it' },
      { event_type: 'subagent_started', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_doctor_wp5_1' },
      { event_type: 'zero_console_errors_noted', agent: 'Build Boss' },
      { event_type: 'check_passed', agent: 'Test Boss', task: 'suite', command: 'node suite.test.cjs', output: '2 passed, 0 failed', exit_code: 0 },
      { event_type: 'subagent_completed', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_doctor_wp5_1', status: 'completed' },
      { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'WP-1', evidence: 'node suite.test.cjs exit 0' },
      { event_type: 'wp_verified', agent: 'Verify Boss', wp_id: 'WP-1', verdict: 'PASS', evidence: 're-ran node suite.test.cjs exit 0' },
    ]));
    for (const f of ['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md']) fs.writeFileSync(path.join(root, '.claude', f), '# ' + f + ' updated\n');
    fs.writeFileSync(path.join(runDir(root, run), 'final-report.md'), '# Report\n\nDone, with evidence.\n');
    steps.push(wbatch(root, run, [{ event_type: 'memory_updated', agent: 'orchestrator', files_changed: ['.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', '.claude/FORGE_AGENT_LEDGER.md'] }, { event_type: 'report_generated', agent: 'orchestrator', note: 'final-report.md' }]));
    // the gate's raw output must exist and hash-verify, or the evidence is unverified (never green)
    const outText = 'suite: 2 passed, 0 failed\n';
    fs.mkdirSync(path.join(root, 'gate-output'), { recursive: true });
    fs.writeFileSync(path.join(root, 'gate-output', 'suite.txt'), outText);
    fs.writeFileSync(path.join(runDir(root, run), 'gate-evidence.json'), JSON.stringify({ run_id: run, gates: [{ name: 'suite', command: 'node suite.test.cjs', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: crypto.createHash('sha256').update(outText).digest('hex'), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
    steps.push(wrc(root, ['check', '--run', run, '--log-event']));
    return steps.every((s) => s.status === 0) ? null : steps.map((s) => s.status + ':' + String(s.stderr || '').slice(0, 160)).join(' | ');
  };
  try {
    // (1) in progress: work started, no completion claimed -> never red, overdue obligations listed
    const IP = wp5Root();
    wbatch(IP, 'ip-run', [{ event_type: 'run_started', agent: 'orchestrator' }, { event_type: 'agent_work_package_created', agent: 'Build Boss', wp_id: 'WP-1', mission: 'x' }, { event_type: 'subagent_started', agent: 'Build Boss', wp_id: 'WP-1', dispatch_id: 'toolu_doctor_ip' }]);
    const ip = D.runContractDoctorCheck(IP);
    t('WP-5 run_contract: a run in progress is never red — status in-progress, overdue preview obligations listed', ip.ok === true && ip.status === 'in-progress' && ip.overdue.includes('memory-read') && ip.enforced === false, JSON.stringify(ip).slice(0, 300));

    // (2) completion claimed over a red contract (after the enforcement date) -> RED
    const CR = wp5Root();
    wbatch(CR, 'cr-run', [{ event_type: 'run_started', agent: 'orchestrator' }, { event_type: 'run_completed', agent: 'orchestrator', summary: 'done?' }]);
    const cr = D.runContractDoctorCheck(CR);
    t('WP-5 run_contract: run_completed over an unmet sequence is RED (completed-red, enforced) and names the missing rules + the plan command', cr.ok === false && cr.status === 'completed-red' && cr.enforced === true && cr.missing.length > 0 && /plan --run cr-run/.test(cr.reason), JSON.stringify(cr).slice(0, 400));

    // (3) the same claim BEFORE the enforcement date -> reported, not enforced (a synced project keeps its history green).
    // a caller-supplied timestamp no longer survives the WRITER (it is kept only as claimed_ts and the
    // writer stamps ingested_at), so genuine history is modelled the only way it can exist: a log written BEFORE the
    // writer stamped ingested_at — unchained lines with a plain timestamp, written straight to the file.
    const OLD = wp5Root();
    fs.mkdirSync(runDir(OLD, 'old-run'), { recursive: true });
    fs.writeFileSync(path.join(runDir(OLD, 'old-run'), 'events.jsonl'), [{ run_id: 'old-run', event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-09-01T10:00:00.000Z' }, { run_id: 'old-run', event_type: 'run_completed', agent: 'orchestrator', summary: 'done?', timestamp: '2026-09-01T11:00:00.000Z' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const old = D.runContractDoctorCheck(OLD);
    t('WP-5 run_contract: a completion claimed before ' + D.RUN_CONTRACT_ENFORCED_SINCE + ' is reported, not enforced (ok:true, enforced:false, said so)', old.ok === true && old.status === 'completed-red' && old.enforced === false && /reported, not enforced/.test(old.reason), JSON.stringify(old).slice(0, 300));
    // the SAME backdated claim sent THROUGH the writer is stamped with the real ingestion time -> enforced
    const BD = wp5Root();
    wbatch(BD, 'backdated-run', [{ event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-09-01T10:00:00.000Z' }, { event_type: 'run_completed', agent: 'orchestrator', summary: 'done?', timestamp: '2026-09-01T11:00:00.000Z' }]);
    const bd = D.runContractDoctorCheck(BD);
    const bdEvents = fs.readFileSync(path.join(runDir(BD, 'backdated-run'), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    t('F05 run_contract: a run_completed BACKDATED by the caller through the writer is still ENFORCED (ingested_at wins) — red', bd.ok === false && bd.enforced === true && bd.status === 'completed-red', JSON.stringify(bd).slice(0, 300));
    t('F05 the writer kept the caller claim only as claimed_ts and stamped ingested_at = timestamp', bdEvents.every((e) => typeof e.ingested_at === 'string' && e.timestamp === e.ingested_at && e.claimed_ts && e.claimed_ts.startsWith('2026-09-01')), JSON.stringify(bdEvents.map((e) => [e.timestamp, e.claimed_ts])));
    t('WP-5 run_contract: an explicit later enforcement date is honoured (opts.enforcedSince)', D.runContractDoctorCheck(CR, { enforcedSince: '2099-01-01T00:00:00Z' }).ok === true);

    // (4) a green run that logged run_completed but was never finalized -> RED with the --finalize command
    const NF = wp5Root();
    const nfSetup = greenRun(NF, 'nf-run');
    t('WP-5 setup: green run built through the real writer/contract copies', nfSetup === null, nfSetup);
    wbatch(NF, 'nf-run', [{ event_type: 'run_completed', agent: 'orchestrator', summary: 'done' }]);
    const nf = D.runContractDoctorCheck(NF);
    t('WP-5 run_contract: finalize skipped is RED (completed-not-finalized) and the reason carries the exact --finalize command', nf.ok === false && nf.status === 'completed-not-finalized' && /check --run nf-run --log-event --finalize/.test(nf.reason), JSON.stringify(nf).slice(0, 400));

    // (5) ... finalize it -> green, read through the receipt (FINALIZED)
    const fin = wrc(NF, ['check', '--run', 'nf-run', '--log-event', '--finalize']);
    const nfDone = D.runContractDoctorCheck(NF);
    t('WP-5 run_contract: after finalize the newest run is green and read through the receipt (finalized, FINALIZED)', fin.status === 0 && nfDone.ok === true && nfDone.status === 'finalized' && nfDone.acceptance.verdict === 'FINALIZED', String(fin.stdout).slice(0, 200) + JSON.stringify(nfDone).slice(0, 300));

    // (6) the rules change after finalization -> HISTORICAL cause ruleset, not re-verified, still green
    const rulesFile = path.join(NF, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
    const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
    rules._doc_wp5_fixture = 'a later edit of the rules registry';
    fs.writeFileSync(rulesFile, JSON.stringify(rules, null, 2));
    const hist = D.runContractDoctorCheck(NF);
    // finalize stored the rules next to the receipt, so the record is RE-VERIFIED under its own
    // pinned rules (reverified:true) and remains a completion proof — green, honestly labelled re-verified.
    t('WP-5/F02 run_contract: a receipt judged under an older ruleset is HISTORICAL (cause ruleset), re-verified under its pinned rules, green', hist.ok === true && hist.status === 'finalized-historical' && hist.acceptance.cause === 'ruleset' && hist.acceptance.reverified === true && hist.acceptance.completion_proof === true, JSON.stringify(hist).slice(0, 400));
    t('WP-5/F02 run_contract: the label says re-verified only because finalize said so', /re-verified as of its own pinned ruleset/.test(hist.reason), hist.reason);
    // strip the pinned copy -> the record is archival (unverified-archival, not re-verified) and, because this
    // run started in the enforcement era, NOT a completion proof -> RED, labelled "archival, not a completion proof"
    fs.rmSync(path.join(runDir(NF, 'nf-run'), 'ruleset-pinned.json'), { force: true });
    const arch = D.runContractDoctorCheck(NF);
    t('F01 run_contract: an archival (not re-verified) receipt of an enforcement-era run is RED (finalized-archival, enforced)', arch.ok === false && arch.status === 'finalized-archival' && arch.enforced === true && arch.acceptance.reverified === false && arch.acceptance.completion_proof === false && /archival/i.test(arch.reason) && /not a completion proof/i.test(arch.reason), JSON.stringify(arch).slice(0, 500));
    t('F01 run_contract: a bare HISTORICAL is never called re-verified — the label says "not re-verified"', /not re-verified/.test(arch.reason) && !/,\s*re-verified/.test(arch.reason), arch.reason);

    // (7) the log grows after finalization -> STALE receipt -> RED
    const ST = wp5Root();
    const stSetup = greenRun(ST, 'st-run');
    wbatch(ST, 'st-run', [{ event_type: 'run_completed', agent: 'orchestrator', summary: 'done' }]);
    const stFin = wrc(ST, ['check', '--run', 'st-run', '--log-event', '--finalize']);
    wbatch(ST, 'st-run', [{ event_type: 'agent_note', agent: 'orchestrator', note: 'one more thing after finalize' }]);
    const st = D.runContractDoctorCheck(ST);
    t('WP-5 run_contract: a receipt that no longer holds (log grew after finalize) is RED (finalized-stale)', stSetup === null && stFin.status === 0 && st.ok === false && st.status === 'finalized-stale' && st.acceptance.verdict === 'STALE', JSON.stringify(st).slice(0, 400));

    // (8) an honest failure close is not a completion claim -> never red
    const FC = wp5Root();
    wbatch(FC, 'fc-run', [{ event_type: 'run_started', agent: 'orchestrator' }, { event_type: 'run_completed', agent: 'orchestrator', status: 'failed', summary: 'stopped' }]);
    const fc = D.runContractDoctorCheck(FC);
    t('WP-5 run_contract: an honest failure close is closed-failed and green (no completion claimed)', fc.ok === true && fc.status === 'closed-failed', JSON.stringify(fc).slice(0, 300));

    // (9) a newer in-progress run does not hide a STALE latest finalized receipt
    wbatch(ST, 'st-next', [{ event_type: 'run_started', agent: 'orchestrator' }]);
    const st2 = D.runContractDoctorCheck(ST);
    t('WP-5 run_contract: the latest FINALIZED run is also read; its STALE receipt keeps the check red behind a newer in-progress run', st2.run_id === 'st-next' && st2.status === 'in-progress' && st2.latest_finalized && st2.latest_finalized.run_id === 'st-run' && st2.latest_finalized.status === 'finalized-stale' && st2.ok === false, JSON.stringify(st2).slice(0, 400));

    // (10) genuine-run selection: a run.json-less run with run_started counts; a doctor receipt folder does not
    t('WP-5 isGenuineRunDir: run_started without run.json is a genuine run; a doctor receipt folder is not', D.isGenuineRunDir(runDir(IP, 'ip-run')) === true && D.isGenuineRunDir(receiptDir) === false);

    // (11) wired into runDoctor: red flips doctor.ok, printSummary names it, an owner override passes it VISIBLY
    const RD = makeCompletenessBase('forge-doctor-wp5-rundoctor-');
    seedRules(RD);
    const rdRun = path.join(RD, '.claude', 'forge-runs', 'rd-run');
    fs.mkdirSync(rdRun, { recursive: true });
    fs.writeFileSync(path.join(rdRun, 'events.jsonl'), [{ run_id: 'rd-run', event_type: 'run_started', agent: 'orchestrator', timestamp: new Date().toISOString() }, { run_id: 'rd-run', event_type: 'run_completed', agent: 'orchestrator', timestamp: new Date().toISOString() }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const rdRep = D.runDoctor(RD);
    const rdOthers = Object.entries(rdRep.checks).filter(([k, c]) => k !== 'run_contract' && !c.ok).map(([k]) => k);
    t('WP-5 runDoctor: checks.run_contract is ENFORCED — a completion claimed over a red contract turns the WHOLE doctor red (and is the only red check)', rdRep.ok === false && rdRep.checks.run_contract.ok === false && rdOthers.length === 0, 'others red: ' + rdOthers.join(','));
    const rdSummary = D.printSummary(rdRep);
    t('WP-5 printSummary: a ✗ run contract line names the run and the plan command; the completeness line no longer mentions run contract', /✗ run contract\s+rd-run — run_completed was logged over an unmet completion sequence/.test(rdSummary) && /plan --run rd-run/.test(rdSummary) && !/completeness[^\n]*run.contract/i.test(rdSummary), rdSummary.split('\n').filter((l) => /run contract|completeness/.test(l)).join(' // '));
    const rulesWithOverride = JSON.parse(fs.readFileSync(path.join(RD, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8'));
    rulesWithOverride.doctor_check_overrides = [{ check: 'run_contract', reason: 'fixture: owner reviewed this run and accepts it unfinalized', by: 'owner' }];
    fs.writeFileSync(path.join(RD, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify(rulesWithOverride));
    const rdOv = D.runDoctor(RD);
    t('WP-5 runDoctor: doctor_check_overrides "run_contract" passes it VISIBLY ([OVERRIDDEN ...]), never silently', rdOv.ok === true && rdOv.checks.run_contract.ok === true && rdOv.checks.run_contract.overridden === true && /✓ run contract[^\n]*\[OVERRIDDEN by owner: fixture/.test(D.printSummary(rdOv)));
  } finally {
    for (const r of wp5Roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
  }
}

// ===========================================================================================================
// wp-disclosure-ab — skill_hygiene: progressive-disclosure hygiene as a doctor advisory
// (backlog item 12, YT-SWEEP-2026-07-31). ADVISORY-ONLY, same core guarantee as skill_evals above: a real
// finding must surface in advisory.completeness.skill_hygiene and in printSummary's compact completeness
// line, but must NEVER flip runDoctor()'s hard `ok` verdict. Five RED->GREEN-proving fixtures: all-clean,
// over-long description, over-long body, dangling reference, prose-with-slash NOT flagged.
// ===========================================================================================================

// (1) all-clean: a short description, a small body, one ANCHORED reference that DOES exist (proves an
// anchored-and-real reference is never mistaken for a dangling one). Named after a REAL skill already in
// forge-sync.cjs's FILES manifest ("forge-router") so this fixture's own sync_completeness sub-check also
// stays clean — an arbitrary fixture-only name would trip sync_completeness's OWN gap-detection instead
// (proven by the COMPLETE_GREEN_ROOT fixture above), muddying this specific advisory's isolation.
const SH_CLEAN_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-clean-');
fs.mkdirSync(path.join(SH_CLEAN_ROOT, '.claude', 'skills', 'forge-router'), { recursive: true });
fs.writeFileSync(path.join(SH_CLEAN_ROOT, '.claude', 'skills', 'forge-router', 'SKILL.md'),
  '---\nname: forge-router\ndescription: A short, valid hygiene-test description well under the 200-char budget.\n---\n\n'
  + '# forge-router (fixture)\n\nUses `.claude/forge-bin/good.cjs` (a real anchored reference the completeness base already ships).\n');
const shCleanRep = D.runDoctor(SH_CLEAN_ROOT);
t('skillHygiene clean fixture: runDoctor checks all still pass (an advisory-only hygiene gap never touches `checks`)', shCleanRep.ok === true, JSON.stringify(Object.entries(shCleanRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('skillHygiene clean fixture: advisory.completeness.skill_hygiene reports ok:true, 1/1 skill clean', shCleanRep.advisory.completeness.skill_hygiene.ok === true && shCleanRep.advisory.completeness.skill_hygiene.checked === 1, JSON.stringify(shCleanRep.advisory.completeness.skill_hygiene));
t('skillHygiene clean fixture: this fixture\'s OWN sync_completeness sub-check is also clean (proves isolation from the unrelated sync-gap fixture above)', shCleanRep.advisory.completeness.sync_completeness.ok === true, JSON.stringify(shCleanRep.advisory.completeness.sync_completeness));
const shCleanSummary = D.printSummary(shCleanRep);
t('printSummary: clean fixture never renders a ✗ completeness line', !/✗ completeness/.test(shCleanSummary));
// printSummary's "skill hygiene N/M" clean-branch text only renders when EVERY completeness sub-check is
// clean (memory_discipline/mcp_dormancy have no equivalent fixture-population helper in this file — no
// existing sub-check's fully-clean branch is exercised elsewhere in this suite either, e.g. "sync manifest
// complete"/"skill evals green" never appear literally in this test file). Isolate printSummary's OWN
// rendering logic instead, by cloning a REAL report and overriding just the unrelated sub-checks to ok:true
// — a legitimate, surgical way to prove the format string itself is correct without re-building every other
// advisory's own clean-state fixture.
const shCleanRepAllOk = JSON.parse(JSON.stringify(shCleanRep));
for (const k of Object.keys(shCleanRepAllOk.advisory.completeness)) if (k !== 'skill_hygiene') shCleanRepAllOk.advisory.completeness[k].ok = true;
const shCleanAllOkSummary = D.printSummary(shCleanRepAllOk);
t('printSummary: once every completeness sub-check is clean, shows "skill hygiene 1/1" in the composed clean sentence', /skill hygiene 1\/1/.test(shCleanAllOkSummary), shCleanAllOkSummary);
t('printSummary: that fully-clean sentence renders as ✓ completeness, never ⚠', /✓ completeness \(advisory\)/.test(shCleanAllOkSummary) && !/⚠ completeness/.test(shCleanAllOkSummary));

// (2) over-long description: frontmatter description > 200 chars -> named finding
const SH_DESC_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-desc-');
const longDesc = 'A'.repeat(220);
fs.mkdirSync(path.join(SH_DESC_ROOT, '.claude', 'skills', 'desc-too-long'), { recursive: true });
fs.writeFileSync(path.join(SH_DESC_ROOT, '.claude', 'skills', 'desc-too-long', 'SKILL.md'), '---\nname: desc-too-long\ndescription: ' + longDesc + '\n---\n\n# desc-too-long\n');
const shDescRep = D.runDoctor(SH_DESC_ROOT);
t('skillHygiene over-long-description fixture: RED -> advisory.completeness.skill_hygiene.ok is false', shDescRep.advisory.completeness.skill_hygiene.ok === false);
t('skillHygiene over-long-description fixture: names the exact char count over budget', shDescRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'desc-too-long' && s.issues.some((i) => /description is 220 chars \(max 200\)/.test(i))), JSON.stringify(shDescRep.advisory.completeness.skill_hygiene));
t('skillHygiene over-long-description fixture: an advisory-only hygiene gap does NOT flip doctor.ok to false', shDescRep.ok === true);
const shDescSummary = D.printSummary(shDescRep);
t('printSummary: names the failing skill under "skill-hygiene:"', /skill-hygiene: desc-too-long/.test(shDescSummary) && /description is 220 chars/.test(shDescSummary), shDescSummary);
t('printSummary: over-long-description fixture still renders as advisory (⚠), never a hard ✗ completeness line', !/✗ completeness/.test(shDescSummary));

// (3) over-long body: whole-file line count > 500 -> named finding (with a valid, in-budget description, to
// isolate this from the description-length check above).
const SH_BODY_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-body-');
fs.mkdirSync(path.join(SH_BODY_ROOT, '.claude', 'skills', 'body-too-long'), { recursive: true });
const bodyFiller = '---\nname: body-too-long\ndescription: A short, valid description.\n---\n\n# body-too-long\n\n' + 'filler line\n'.repeat(510);
fs.writeFileSync(path.join(SH_BODY_ROOT, '.claude', 'skills', 'body-too-long', 'SKILL.md'), bodyFiller);
const shBodyRep = D.runDoctor(SH_BODY_ROOT);
t('skillHygiene over-long-body fixture: RED -> advisory.completeness.skill_hygiene.ok is false', shBodyRep.advisory.completeness.skill_hygiene.ok === false);
t('skillHygiene over-long-body fixture: names the exact line count over budget', shBodyRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'body-too-long' && s.issues.some((i) => /SKILL\.md is \d+ lines \(max 500\)/.test(i))), JSON.stringify(shBodyRep.advisory.completeness.skill_hygiene));
t('skillHygiene over-long-body fixture: an advisory-only hygiene gap does NOT flip doctor.ok to false', shBodyRep.ok === true);
const shBodySummary = D.printSummary(shBodyRep);
t('printSummary: names the failing skill+line-count under "skill-hygiene:"', /skill-hygiene: body-too-long/.test(shBodySummary) && /lines \(max 500\)/.test(shBodySummary), shBodySummary);

// (4) dangling reference: an ANCHORED reference (.claude/... and a skill-relative references/... one) that
// does NOT exist -> named finding, distinct from the "not anchored -> not checked" case in (5) below.
const SH_DANGLE_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-dangle-');
fs.mkdirSync(path.join(SH_DANGLE_ROOT, '.claude', 'skills', 'dangling-ref'), { recursive: true });
fs.writeFileSync(path.join(SH_DANGLE_ROOT, '.claude', 'skills', 'dangling-ref', 'SKILL.md'),
  '---\nname: dangling-ref\ndescription: A short, valid description.\n---\n\n# dangling-ref\n\n'
  + 'See `.claude/forge-bin/does-not-exist.cjs` and `references/missing.md` for details.\n');
const shDangleRep = D.runDoctor(SH_DANGLE_ROOT);
t('skillHygiene dangling-reference fixture: RED -> advisory.completeness.skill_hygiene.ok is false', shDangleRep.advisory.completeness.skill_hygiene.ok === false);
t('skillHygiene dangling-reference fixture: names BOTH dangling refs (root-anchored + skill-relative)', shDangleRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'dangling-ref' && s.issues.some((i) => i.includes('.claude/forge-bin/does-not-exist.cjs') && i.includes('references/missing.md'))), JSON.stringify(shDangleRep.advisory.completeness.skill_hygiene));
t('skillHygiene dangling-reference fixture: an advisory-only hygiene gap does NOT flip doctor.ok to false', shDangleRep.ok === true);
const shDangleSummary = D.printSummary(shDangleRep);
t('printSummary: names the failing skill+dangling refs under "skill-hygiene:"', /skill-hygiene: dangling-ref/.test(shDangleSummary) && /dangling reference/.test(shDangleSummary), shDangleSummary);

// (4a) PRIVATE USER-STATE file is NOT dangling. A skill that documents where the user's own
// `*.user.json` lives (e.g. `.claude/config/orchestration/codex-review.user.json`) points at a file that is
// absent on every fresh install by design — the maintainer's machine has one, which is exactly how the
// laptop audit's "works here, fails there" happened. Reclassified under optional_refs, never silenced; a
// missing ordinary file next to it is still a real dangling reference.
const SH_USER_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-userstate-');
fs.mkdirSync(path.join(SH_USER_ROOT, '.claude', 'skills', 'user-state-ref'), { recursive: true });
fs.writeFileSync(path.join(SH_USER_ROOT, '.claude', 'skills', 'user-state-ref', 'SKILL.md'),
  '---\nname: user-state-ref\ndescription: A short, valid description.\n---\n\n# user-state-ref\n\n'
  + 'Your own pin lives in `.claude/config/orchestration/codex-review.user.json` (optional).\n');
const shUserSkill = D.runDoctor(SH_USER_ROOT).advisory.completeness.skill_hygiene.skills.find((s) => s.skill === 'user-state-ref') || {};
t('skillHygiene: a missing *.user.json reference is NOT dangling (private user state, absent on a fresh install)', shUserSkill.ok === true && !JSON.stringify(shUserSkill.issues || []).includes('codex-review.user.json'), JSON.stringify(shUserSkill));
t('skillHygiene: the missing *.user.json is still REPORTED, under optional_refs', Array.isArray(shUserSkill.optional_refs) && shUserSkill.optional_refs.includes('.claude/config/orchestration/codex-review.user.json'), JSON.stringify(shUserSkill));
const SH_USER2_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-userstate2-');
fs.mkdirSync(path.join(SH_USER2_ROOT, '.claude', 'skills', 'plain-json-ref'), { recursive: true });
fs.writeFileSync(path.join(SH_USER2_ROOT, '.claude', 'skills', 'plain-json-ref', 'SKILL.md'),
  '---\nname: plain-json-ref\ndescription: A short, valid description.\n---\n\n# plain-json-ref\n\n'
  + 'Settings live in `.claude/config/orchestration/codex-review.json`.\n');
const shPlainSkill = D.runDoctor(SH_USER2_ROOT).advisory.completeness.skill_hygiene.skills.find((s) => s.skill === 'plain-json-ref') || {};
t('skillHygiene counterfactual: a missing ordinary .json reference IS still dangling', shPlainSkill.ok === false && JSON.stringify(shPlainSkill.issues || []).includes('codex-review.json'), JSON.stringify(shPlainSkill));

// (4b) RUNTIME-GENERATED marker is NOT dangling. MEASURED FALSE POSITIVE: the real doctor run
// reported `skill-hygiene: forge-snapshot (1 dangling reference(s): .claude/.forge-snapshot-due.json)` — a
// file that forge-snapshot-marker.cjs WRITES and the SessionStart hook consumes, so its normal state is
// "not on disk". Documenting your own output path is not a broken link, and an advisory that fills up with
// false positives stops being read — which is how it would miss a REAL dangling reference. The reference is
// reclassified (still reported, under generated_refs) rather than silenced.
const SH_GEN_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-generated-');
fs.writeFileSync(path.join(SH_GEN_ROOT, '.claude', 'forge-bin', 'marker.cjs'),
  "'use strict';\nconst fs = require('fs');\nfs.writeFileSync(require('path').join(dir, '.a-runtime-marker.json'), '{}');\n");
fs.mkdirSync(path.join(SH_GEN_ROOT, '.claude', 'skills', 'gen-ref'), { recursive: true });
fs.writeFileSync(path.join(SH_GEN_ROOT, '.claude', 'skills', 'gen-ref', 'SKILL.md'),
  '---\nname: gen-ref\ndescription: A short, valid description.\n---\n\n# gen-ref\n\n'
  + 'Writes `.claude/.a-runtime-marker.json` and also mentions `.claude/forge-bin/really-missing.cjs`.\n');
const shGenRep = D.runDoctor(SH_GEN_ROOT);
const shGenSkill = shGenRep.advisory.completeness.skill_hygiene.skills.find((s) => s.skill === 'gen-ref') || {};
t('skillHygiene: a path our OWN code writes is not counted as dangling',
  !JSON.stringify(shGenSkill.issues || []).includes('.a-runtime-marker.json'), JSON.stringify(shGenSkill));
t('skillHygiene: but it is still REPORTED, under generated_refs (reclassified, not silenced)',
  Array.isArray(shGenSkill.generated_refs) && shGenSkill.generated_refs.includes('.claude/.a-runtime-marker.json'), JSON.stringify(shGenSkill));
t('skillHygiene: a genuinely missing reference in the SAME skill is still flagged',
  (shGenSkill.issues || []).some((i) => i.includes('.claude/forge-bin/really-missing.cjs')), JSON.stringify(shGenSkill));
t('skillHygiene: so the skill is still not ok (the real gap survives the reclassification)', shGenSkill.ok === false);

// (4c) the written path lives in a VARIABLE. MEASURED on forge-setup.cjs, restored this release:
// `const projMarkerPath = path.join(projectDir, '.claude', '.forge-setup.json')` … fifteen lines later
// `fs.writeFileSync(projMarkerPath, …)`. Neither line holds both the write API and the literal, so (4b)'s
// same-line window missed it and forge-router's honest reference to `.claude/.forge-setup.json` was reported
// as dangling. generatedPathBasenames() now resolves the written argument to its declaration in the same file.
// Guards in both directions: the resolved name IS reclassified; an identifier that is never written to is NOT.
const SH_VAR_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-generated-var-');
fs.writeFileSync(path.join(SH_VAR_ROOT, '.claude', 'forge-bin', 'marker-var.cjs'),
  "'use strict';\nconst fs = require('fs');\nconst path = require('path');\n"
  + "const unusedPath = path.join(dir, '.never-written.json');\n"
  + "const markerPath = path.join(dir, '.claude', '.a-variable-marker.json');\n"
  + "function save(dir) {\n  const body = '{}';\n  fs.writeFileSync(markerPath, body, 'utf8');\n}\n"
  + "module.exports = { save, unusedPath };\n");
fs.mkdirSync(path.join(SH_VAR_ROOT, '.claude', 'skills', 'gen-var'), { recursive: true });
fs.writeFileSync(path.join(SH_VAR_ROOT, '.claude', 'skills', 'gen-var', 'SKILL.md'),
  '---\nname: gen-var\ndescription: A short, valid description.\n---\n\n# gen-var\n\n'
  + 'Reads `.claude/.a-variable-marker.json` (written by marker-var.cjs) and mentions `.claude/.never-written.json`.\n');
const shVarRep = D.runDoctor(SH_VAR_ROOT);
const shVarSkill = shVarRep.advisory.completeness.skill_hygiene.skills.find((s) => s.skill === 'gen-var') || {};
t('skillHygiene: a path built into a variable and written later is resolved to its declaration (not dangling)',
  !JSON.stringify(shVarSkill.issues || []).includes('.a-variable-marker.json') && Array.isArray(shVarSkill.generated_refs) && shVarSkill.generated_refs.includes('.claude/.a-variable-marker.json'), JSON.stringify(shVarSkill));
t('skillHygiene: a path variable that is NEVER handed to a write API stays a dangling reference (the resolution did not widen into "every literal in the file")',
  (shVarSkill.issues || []).some((i) => i.includes('.claude/.never-written.json')), JSON.stringify(shVarSkill));

// (4d) the written path comes from a HELPER FUNCTION. MEASURED on every fresh install's doctor in CI:
// forge-docdrift (`const statePath = opts.statePath || defaultStatePath(root)`) and forge-audit-loop
// (`fs.appendFileSync(ledgerPath(root), …)`) were flagged for paths their own helpers build. One more bounded hop:
// a function CALLED in the write/declaration window has its `function NAME(` line harvested. A helper that is
// never called from a write path contributes nothing.
const SH_FN_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-generated-fn-');
fs.writeFileSync(path.join(SH_FN_ROOT, '.claude', 'forge-bin', 'marker-fn.cjs'),
  "'use strict';\nconst fs = require('fs');\nconst path = require('path');\n"
  + "function ledgerPath(root) { return path.join(root, '.claude', 'forge-audit', '.fn-ledger.jsonl'); }\n"
  + "function defaultStatePath(root) { return path.join(root, '.claude', 'forge-research', '.fn-state.json'); }\n"
  + "function decoyPath(root) { return path.join(root, '.claude', '.fn-decoy-never-written.json'); }\n"
  + "function save(root, opts) {\n  const statePath = opts.statePath || defaultStatePath(root);\n  fs.writeFileSync(statePath, '{}', 'utf8');\n"
  + "  fs.appendFileSync(ledgerPath(root), '{}\\n', 'utf8');\n}\n"
  + "module.exports = { save, decoyPath };\n");
fs.mkdirSync(path.join(SH_FN_ROOT, '.claude', 'skills', 'gen-fn'), { recursive: true });
fs.writeFileSync(path.join(SH_FN_ROOT, '.claude', 'skills', 'gen-fn', 'SKILL.md'),
  '---\nname: gen-fn\ndescription: A short, valid description.\n---\n\n# gen-fn\n\n'
  + 'Appends to `.claude/forge-audit/.fn-ledger.jsonl`, persists `.claude/forge-research/.fn-state.json` and mentions `.claude/.fn-decoy-never-written.json`.\n');
const shFnRep = D.runDoctor(SH_FN_ROOT);
const shFnSkill = shFnRep.advisory.completeness.skill_hygiene.skills.find((s) => s.skill === 'gen-fn') || {};
t('skillHygiene: a path built by a helper called directly in the write (appendFileSync(ledgerPath(root))) is a generated ref',
  Array.isArray(shFnSkill.generated_refs) && shFnSkill.generated_refs.includes('.claude/forge-audit/.fn-ledger.jsonl') && !JSON.stringify(shFnSkill.issues || []).includes('.fn-ledger.jsonl'), JSON.stringify(shFnSkill));
t('skillHygiene: a path built by a helper reached through a declaration (const p = opts.p || defaultStatePath(root)) is a generated ref',
  Array.isArray(shFnSkill.generated_refs) && shFnSkill.generated_refs.includes('.claude/forge-research/.fn-state.json') && !JSON.stringify(shFnSkill.issues || []).includes('.fn-state.json'), JSON.stringify(shFnSkill));
t('skillHygiene: a helper that is NEVER called from a write path still yields a dangling reference (the hop is bounded to called helpers)',
  (shFnSkill.issues || []).some((i) => i.includes('.claude/.fn-decoy-never-written.json')), JSON.stringify(shFnSkill));

// (5) prose-with-slash NOT flagged: an alternation phrase ("manifest.json/events.jsonl", meaning "either
// file", not a nested directory) and an UNANCHORED path-shaped example (a generic downstream-project
// illustration with neither a .claude/ nor a references//scripts//assets/ prefix) must both be silently
// skipped — proves the false-positive-on-prose guard actually holds, not just that anchored real gaps work.
const SH_PROSE_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-prose-');
fs.mkdirSync(path.join(SH_PROSE_ROOT, '.claude', 'skills', 'prose-skill'), { recursive: true });
fs.writeFileSync(path.join(SH_PROSE_ROOT, '.claude', 'skills', 'prose-skill', 'SKILL.md'),
  '---\nname: prose-skill\ndescription: A short, valid description.\n---\n\n# prose-skill\n\n'
  + 'The briefing only ever renders what `manifest.json/events.jsonl` already say. See `docs/ARCHITECTURE.md` '
  + 'for how a downstream built project might document its own contract — neither of these is a reference into '
  + 'THIS project\'s own tree.\n');
const shProseRep = D.runDoctor(SH_PROSE_ROOT);
t('skillHygiene prose-with-slash fixture: GREEN -> advisory.completeness.skill_hygiene.ok is true (no false positive)', shProseRep.advisory.completeness.skill_hygiene.ok === true, JSON.stringify(shProseRep.advisory.completeness.skill_hygiene));
t('skillHygiene prose-with-slash fixture: the alternation phrase + the unanchored example are both absent from any issue', !shProseRep.advisory.completeness.skill_hygiene.skills.some((s) => s.issues.some((i) => i.includes('manifest.json') || i.includes('docs/ARCHITECTURE.md'))));
const shProseSummary = D.printSummary(shProseRep);
t('printSummary: prose-with-slash fixture never mentions "skill-hygiene:" (nothing to name)', !/skill-hygiene:/.test(shProseSummary), shProseSummary);

// (6) NESTED skill dir: a skill that lives at `skills/<parent>/<child>/SKILL.md` rather than
// `skills/<name>/SKILL.md`. MEASURED on this project the same day: `ls .claude/skills/*/SKILL.md | wc -l`
// = 49 but `find .claude/skills -name SKILL.md | wc -l` = 57 — the 8 gsap sub-skills sit one level deeper
// and were therefore evaluated by NOTHING, while every one of them is over the description budget this
// check exists to police. skillHygiene() read only the FIRST level of `.claude/skills/` (a single
// readdirSync + a direct `<dir>/SKILL.md` read), so a nested skill was not "passing" — it was invisible,
// which is strictly worse than a red finding. A sibling TOP-LEVEL skill is included in the same fixture so
// this also proves the recursion ADDS the nested level rather than replacing the flat one.
const SH_NESTED_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-nested-');
fs.mkdirSync(path.join(SH_NESTED_ROOT, '.claude', 'skills', 'bundle', 'nested-child'), { recursive: true });
fs.writeFileSync(path.join(SH_NESTED_ROOT, '.claude', 'skills', 'bundle', 'nested-child', 'SKILL.md'),
  '---\nname: nested-child\ndescription: ' + 'B'.repeat(240) + '\n---\n\n# nested-child\n');
fs.mkdirSync(path.join(SH_NESTED_ROOT, '.claude', 'skills', 'flat-sibling'), { recursive: true });
fs.writeFileSync(path.join(SH_NESTED_ROOT, '.claude', 'skills', 'flat-sibling', 'SKILL.md'),
  '---\nname: flat-sibling\ndescription: A short, valid description.\n---\n\n# flat-sibling\n');
const shNestedRep = D.runDoctor(SH_NESTED_ROOT);
t('skillHygiene nested fixture: BOTH the nested and the flat skill are evaluated (checked === 2 — the nested one used to be invisible, not passing)', shNestedRep.advisory.completeness.skill_hygiene.checked === 2, JSON.stringify(shNestedRep.advisory.completeness.skill_hygiene));
t('skillHygiene nested fixture: RED -> the nested skill\'s over-long description is reported, named by its skills/-relative id', shNestedRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'bundle/nested-child' && s.issues.some((i) => /description is 240 chars \(max 200\)/.test(i))), JSON.stringify(shNestedRep.advisory.completeness.skill_hygiene));
t('skillHygiene nested fixture: the flat sibling is still evaluated and still clean (recursion ADDS a level, never replaces the flat one)', shNestedRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'flat-sibling' && s.ok === true), JSON.stringify(shNestedRep.advisory.completeness.skill_hygiene));
t('skillHygiene nested fixture: a nested finding is still ADVISORY — doctor.ok stays true', shNestedRep.ok === true);
const shNestedSummary = D.printSummary(shNestedRep);
t('printSummary: names the nested skill by its full skills/-relative id under "skill-hygiene:"', /skill-hygiene: bundle\/nested-child/.test(shNestedSummary), shNestedSummary);

// (6b) 2026-11-05: a skill link into a gitignored, never-shipped folder resolved on the maintainer's machine and
// dangled on a fresh clone (forge-security-review -> .claude/forge-research/.../round1.json, found by gating a
// clean worktree). The file EXISTS in this fixture, and the link must still be red; a name our own code writes
// there stays a generated ref.
{
  const LO_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-localonly-');
  fs.mkdirSync(path.join(LO_ROOT, '.claude', 'forge-research', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(LO_ROOT, '.claude', 'forge-research', 'notes', 'round1.json'), '{}\n');
  fs.mkdirSync(path.join(LO_ROOT, '.claude', 'skills', 'cites-local'), { recursive: true });
  fs.writeFileSync(path.join(LO_ROOT, '.claude', 'skills', 'cites-local', 'SKILL.md'),
    '---\nname: cites-local\ndescription: A short, valid description.\n---\n\n# cites-local\n\nSee `.claude/forge-research/notes/round1.json`.\n');
  const lo = D.skillHygiene(LO_ROOT).skills.find((s) => s.skill === 'cites-local');
  t('skillHygiene: a link into .claude/forge-research/ is dangling even though the file exists here (local-only, never shipped)',
    !!lo && lo.ok === false && /round1\.json \[local-only folder, not shipped\]/.test(JSON.stringify(lo.issues)), JSON.stringify(lo));
}

// (7) VENDORED skills: the two findings this check had left standing were `humanizer` (626
// lines, upstream github.com/blader/humanizer @1b48564) and the 8 gsap sub-skills (upstream
// github.com/greensock/gsap-skills @aed9cfd) — every one of them THIRD-PARTY CONTENT COPIED VERBATIM AT A
// RECORDED PIN. Restyling them to satisfy our own budget would rewrite someone else's file and make the
// recorded pin describe something that is no longer on disk, and the whole gain is ~250 tokens of a 33k
// always-loaded budget. So a permanently unactionable advisory, which is worse than no advisory: it teaches
// the reader to skim past the line where a REAL finding will one day appear.
//
// The split is between SHAPE and FUNCTION, and only shape is upstream's business:
//   · description length / body length  -> upstream's editorial choice. Reported as `vendored_style`, with
//     the real numbers, so the cost stays visible — but it is not OUR hygiene gap.
//   · missing description / dangling reference -> broken IN OUR TREE regardless of who wrote it. Still a
//     real issue, still red.
// Provenance must be EARNED: both a `Source:` and a `Pinned commit:` line. A half-marker proves nothing and
// must not buy an exemption, or "vendored" becomes a comment anyone can type to silence the check.
const SH_VENDOR_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-vendor-');
const VENDOR_HEADER = '\n<!--\n  Source: https://github.com/example/upstream-skills\n'
  + '  Pinned commit: 1b48564898e999219882660237fde01bf4843a0f (2026-06-29T20:43:04Z)\n  License: MIT\n-->\n';
fs.mkdirSync(path.join(SH_VENDOR_ROOT, '.claude', 'skills', 'vendored-long'), { recursive: true });
fs.writeFileSync(path.join(SH_VENDOR_ROOT, '.claude', 'skills', 'vendored-long', 'SKILL.md'),
  '---\nname: vendored-long\ndescription: ' + 'V'.repeat(260) + '\n---\n' + VENDOR_HEADER + '\n# vendored-long\n\n' + 'filler line\n'.repeat(520));
// a skill WE authored, same two style violations, no provenance marker — must stay red
fs.mkdirSync(path.join(SH_VENDOR_ROOT, '.claude', 'skills', 'ours-long'), { recursive: true });
fs.writeFileSync(path.join(SH_VENDOR_ROOT, '.claude', 'skills', 'ours-long', 'SKILL.md'),
  '---\nname: ours-long\ndescription: ' + 'O'.repeat(260) + '\n---\n\n# ours-long\n');
const shVendorRep = D.runDoctor(SH_VENDOR_ROOT);
const shVendorHyg = shVendorRep.advisory.completeness.skill_hygiene;
t('skillHygiene vendored: a pinned upstream skill\'s over-long description is NOT one of our hygiene issues',
  shVendorHyg.skills.some((s) => s.skill === 'vendored-long' && !s.issues.some((i) => /description is \d+ chars/.test(i))), JSON.stringify(shVendorHyg));
t('skillHygiene vendored: nor is its over-long body',
  shVendorHyg.skills.some((s) => s.skill === 'vendored-long' && !s.issues.some((i) => /SKILL\.md is \d+ lines/.test(i))), JSON.stringify(shVendorHyg));
t('skillHygiene vendored: but the real numbers ARE still reported under vendored_style — the cost stays visible',
  shVendorHyg.skills.some((s) => s.skill === 'vendored-long' && Array.isArray(s.vendored_style)
    && s.vendored_style.some((i) => /description is 260 chars/.test(i))
    && s.vendored_style.some((i) => /SKILL\.md is \d+ lines/.test(i))), JSON.stringify(shVendorHyg));
t('skillHygiene vendored: the upstream source and pin are recorded, so the exemption is traceable to evidence',
  shVendorHyg.skills.some((s) => s.skill === 'vendored-long' && s.vendored && /github\.com\/example\/upstream-skills/.test(s.vendored.source) && /^1b48564/.test(s.vendored.pin)), JSON.stringify(shVendorHyg));
t('skillHygiene vendored: OUR OWN skill with the identical violation is still RED (the exemption is scoped to provenance, not to the rule)',
  shVendorHyg.ok === false && shVendorHyg.skills.some((s) => s.skill === 'ours-long' && s.issues.some((i) => /description is 260 chars/.test(i))), JSON.stringify(shVendorHyg));
const shVendorSummary = D.printSummary(shVendorRep);
t('printSummary: still names OUR skill under "skill-hygiene:", and never the vendored one',
  /skill-hygiene: ours-long/.test(shVendorSummary) && !/skill-hygiene:[^\n]*vendored-long/.test(shVendorSummary), shVendorSummary);

// (7b) the exemption covers SHAPE only: a vendored skill that is BROKEN in our tree is still red.
const SH_VENDOR_BROKEN = makeCompletenessBase('forge-doctor-skillhygiene-vendorbroken-');
fs.mkdirSync(path.join(SH_VENDOR_BROKEN, '.claude', 'skills', 'vendored-broken'), { recursive: true });
fs.writeFileSync(path.join(SH_VENDOR_BROKEN, '.claude', 'skills', 'vendored-broken', 'SKILL.md'),
  '---\nname: vendored-broken\ndescription: A short, valid description.\n---\n' + VENDOR_HEADER
  + '\n# vendored-broken\n\nSee `references/missing.md`.\n');
const shVendorBrokenHyg = D.runDoctor(SH_VENDOR_BROKEN).advisory.completeness.skill_hygiene;
t('skillHygiene vendored: a DANGLING reference in a vendored skill is still a real issue (broken is broken, whoever wrote it)',
  shVendorBrokenHyg.ok === false && shVendorBrokenHyg.skills.some((s) => s.skill === 'vendored-broken' && s.issues.some((i) => /dangling reference/.test(i))), JSON.stringify(shVendorBrokenHyg));

// (7c) a HALF marker buys nothing — otherwise one typed line silences the check.
const SH_VENDOR_HALF = makeCompletenessBase('forge-doctor-skillhygiene-vendorhalf-');
fs.mkdirSync(path.join(SH_VENDOR_HALF, '.claude', 'skills', 'half-marked'), { recursive: true });
fs.writeFileSync(path.join(SH_VENDOR_HALF, '.claude', 'skills', 'half-marked', 'SKILL.md'),
  '---\nname: half-marked\ndescription: ' + 'H'.repeat(260) + '\n---\n\n<!--\n  Source: https://github.com/example/upstream-skills\n-->\n\n# half-marked\n');
const shVendorHalfHyg = D.runDoctor(SH_VENDOR_HALF).advisory.completeness.skill_hygiene;
t('skillHygiene vendored: a Source line WITHOUT a pinned commit does not count as vendored — still RED',
  shVendorHalfHyg.ok === false && shVendorHalfHyg.skills.some((s) => s.skill === 'half-marked' && s.issues.some((i) => /description is 260 chars/.test(i))), JSON.stringify(shVendorHalfHyg));

// direct extractSkillPathRefs() unit proof — the exact filtering rules, independent of the doctor plumbing
const proseRefs = D.extractSkillPathRefs('See `manifest.json/events.jsonl`, `docs/ARCHITECTURE.md`, `.claude/forge-bin/does-not-exist.cjs`, `references/missing.md`, `<run_id>/config.json`, `config/orchestration/*.json`.');
t('extractSkillPathRefs: rejects the alternation-prose token entirely (never returned)', !proseRefs.some((r) => r.ref.includes('manifest.json')));
t('extractSkillPathRefs: returns the unanchored example but marks it anchored:false', proseRefs.some((r) => r.ref === 'docs/ARCHITECTURE.md' && r.anchored === false));
t('extractSkillPathRefs: returns BOTH real anchor forms marked anchored:true', proseRefs.some((r) => r.ref === '.claude/forge-bin/does-not-exist.cjs' && r.anchored === true) && proseRefs.some((r) => r.ref === 'references/missing.md' && r.anchored === true));
t('extractSkillPathRefs: rejects a placeholder token containing "<"', !proseRefs.some((r) => r.ref.includes('<')));
t('extractSkillPathRefs: rejects a glob token containing "*"', !proseRefs.some((r) => r.ref.includes('*')));

// ===========================================================================================================
// context_budget — the ALWAYS-LOADED instruction surface as a doctor advisory. Same core
// guarantee as every other advisory: a real finding must surface in advisory.context_budget and in
// printSummary, but must NEVER flip runDoctor()'s hard `ok` verdict. See forge-contextbudget.cjs for the
// measured reason this exists (nothing counted the chain; its growth truncated the skill list on 07-31).
// ===========================================================================================================
const CBUD_ROOT = makeCompletenessBase('forge-doctor-contextbudget-');
const cbudRep = D.runDoctor(CBUD_ROOT);
t('context_budget: runDoctor exposes advisory.context_budget with a real estimated-token total', cbudRep.advisory.context_budget && typeof cbudRep.advisory.context_budget.total_approx_tokens === 'number', JSON.stringify(cbudRep.advisory.context_budget && Object.keys(cbudRep.advisory.context_budget)));
t('context_budget: it is labelled an ESTIMATE in the report itself (no fake tokenizer precision)', /estimate/i.test(cbudRep.advisory.context_budget.estimate_note));
t('context_budget: it lives under `advisory`, never under `checks` (it can never fail a build)', !Object.prototype.hasOwnProperty.call(cbudRep.checks, 'context_budget'));
// a REAL finding must surface without flipping doctor.ok — forced by baselining the project CLAUDE.md at a
// value the fixture's own file provably exceeds, i.e. a genuine over-baseline, not a mocked one.
fs.writeFileSync(path.join(CBUD_ROOT, 'CLAUDE.md'), 'z'.repeat(40000));
const cbudMod = require('./forge-contextbudget.cjs');
const cbudCfg = cbudMod.readConfig(CBUD_ROOT);
cbudCfg.baseline = { generated_at: '2026-08-01T00:00:00.000Z', total_approx_tokens: 1, posts: { project_claude_md: 1 } };
cbudMod.saveConfig(CBUD_ROOT, cbudCfg);
const cbudGrown = D.runDoctor(CBUD_ROOT);
t('context_budget: a genuine over-baseline post surfaces as a named advisory finding', cbudGrown.advisory.context_budget.findings.some((f) => f.kind === 'over_baseline' && f.id === 'project_claude_md'), JSON.stringify(cbudGrown.advisory.context_budget.findings));
t('context_budget: and that finding does NOT flip doctor.ok (advisory, exactly like skill_hygiene)', cbudGrown.ok === true, JSON.stringify(Object.entries(cbudGrown.checks).filter(([, c]) => !c.ok).map(([k]) => k)));
const cbudSummary = D.printSummary(cbudGrown);
t('printSummary: renders a context-budget line naming the grown post', /context budget/i.test(cbudSummary) && /project_claude_md|project CLAUDE\.md/.test(cbudSummary), cbudSummary);
t('printSummary: the context-budget line is advisory (⚠), never a hard ✗', !/✗ context budget/.test(cbudSummary));
// real project: the meter actually runs here and reports a plausible, non-zero surface
const cbudReal = D.runDoctor.length >= 0 && require('./forge-contextbudget.cjs').measure(REAL_PROJECT_ROOT, {});
t('context_budget: on the REAL project it measures a non-zero always-loaded surface across every named post', cbudReal.total_approx_tokens > 1000 && ['global_claude_md', 'ecc_rules_common', 'project_claude_md', 'skill_catalog_project', 'skill_catalog_global', 'skill_catalog_plugins'].every((id) => cbudReal.posts.some((p) => p.id === id)), 'total=' + cbudReal.total_approx_tokens);
t('context_budget: the REAL project has no dead @-include in its global chain', !cbudReal.findings.some((f) => f.kind === 'dead_include'), JSON.stringify(cbudReal.findings));
// the skill surface is THREE sources, reported separately (second pass): the meter used to count
// only this project's .claude/skills — 57 of the 278 skills a session carries — and the doctor line repeated
// that as the whole figure. Both the JSON and the printed line must now carry the breakdown.
// "none of them zero on THIS machine" is a statement about the author's ~/.claude, not about the meter:
// a fresh install or a CI runner has no global skill catalog and no plugins, so 0 is the truth there.
// The structural half (three sources, reported separately) stays strict everywhere; the non-zero half
// only where a global catalog actually exists (external audit II-B).
t('context_budget: the REAL measurement reports all three skill sources separately', cbudReal.skill_sources.length === 3, JSON.stringify((cbudReal.skill_sources || []).map((s) => s.id + '=' + s.skills)));
// N3/N8 (2026-09-26 laptop re-audit): a bare existsSync() on ~/.claude/skills and ~/.claude/plugins is NOT
// the same fact as "there is a real catalog here" — Claude Code itself creates an empty ~/.claude/plugins
// scaffold on a fresh install (the laptop shape: installed, but otherwise empty), so the folder can exist
// with zero skills inside it. That let this precondition run on an empty catalog and fail with "none of the
// three sources is zero". The precondition now asks the meter's own on-disk count, not the folder's mere
// existence.
const cbudGlobalOnDisk = (cbudReal.skill_sources.find((s) => s.id === 'skill_catalog_global') || {}).skills_on_disk || 0;
const cbudPluginOnDisk = (cbudReal.skill_sources.find((s) => s.id === 'skill_catalog_plugins') || {}).skills_on_disk || 0;
if (cbudGlobalOnDisk > 0 && cbudPluginOnDisk > 0) {
  t('context_budget: on a machine WITH a non-trivial global skills catalog and a non-trivial plugin catalog, none of the three sources is zero', cbudReal.skill_sources.every((s) => s.skills > 0), JSON.stringify((cbudReal.skill_sources || []).map((s) => s.id + '=' + s.skills)));
} else {
  skipped++;
  console.log('  SKIP context_budget non-zero-sources — this machine has no non-trivial ~/.claude/skills and/or ~/.claude/plugins catalog (0 skills on disk); a zero count is the truth here, not a defect');
}
t('context_budget: the two out-of-project catalogs are flagged read-only, never write-touched', cbudReal.skill_sources.filter((s) => !s.in_project).length === 2 && cbudReal.skill_sources.filter((s) => !s.in_project).every((s) => s.access === 'read-only'), JSON.stringify(cbudReal.skill_sources.map((s) => s.id + ':' + s.access)));
t('context_budget: no skill walk hit its depth cap on the real machine (a capped walk would be a finding, not a smaller number)', !cbudReal.findings.some((f) => f.kind === 'depth_capped'), JSON.stringify(cbudReal.findings.filter((f) => f.kind === 'depth_capped')));
// asserted on the doctor report ALREADY computed above — never on a second runDoctor(REAL_PROJECT_ROOT),
// because runDoctor() runs runTests(), i.e. spawns all 105 suites: calling it from inside a suite makes this
// file take 278s and hit the 120s per-suite timeout (measured 2026-08-01, the one red this work package
// produced). cbudGrown is a real doctor run whose context-budget post-set includes the two REAL out-of-project
// catalogs, so the breakdown in its printSummary line is genuine output, not a fixture value.
// the `( \(absent\))?` is not slack in the assertion — this fixture project genuinely has no .claude/skills
// directory, and the line says so ("project 0 (absent)") rather than printing a bare 0 that would read as an
// empty catalog. A source that is missing and a source that is empty are different facts.
t('printSummary: the context-budget line shows the per-source skill breakdown, not one project-only number', /skills: project \d+( \(absent\))? \+ global \d+( \(absent\))? \+ plugins \d+/.test(cbudSummary), (cbudSummary.split('\n').find((l) => /context budget/.test(l)) || 'no context-budget line'));
t('printSummary: a skill source that is absent rather than empty is marked as such in the line', /project 0 \(absent\)/.test(cbudSummary), (cbudSummary.split('\n').find((l) => /context budget/.test(l)) || 'no context-budget line'));

// ============================================================================================================
// LAPTOP + CI SHAPES (2026-09-26 re-audit): deterministic on every machine, unlike the REAL-project checks
// above which depend on whatever THIS developer's own ~/.claude happens to contain. HOME/USERPROFILE point at
// a throwaway dir so the doctor's context_budget advisory is proven honest on the exact two shapes the
// audit found. Both run on a FIXTURE root (never REAL_PROJECT_ROOT) — runDoctor() on the real project spawns
// all 105+ suites and blows the 120s per-suite budget (see the comment above cbudGrown).
function cbHomeOverride(fakeHome, fn) {
  const prevHome = process.env.HOME, prevProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try { return fn(); }
  finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  }
}
const LAPTOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-laptop-home-'));
fs.mkdirSync(path.join(LAPTOP_HOME, '.claude'), { recursive: true }); // present but EMPTY: no skills/, no plugins/, no CLAUDE.md
const LAPTOP_ROOT = makeCompletenessBase('forge-doctor-laptop-project-');
const laptopRep = cbHomeOverride(LAPTOP_HOME, () => D.runDoctor(LAPTOP_ROOT));
t('laptop shape: ~/.claude present but completely empty never flips doctor.ok', laptopRep.ok === true, JSON.stringify(Object.entries(laptopRep.checks).filter(([, c]) => !c.ok).map(([k]) => k)));
t('laptop shape: context-budget reports the three skill sources without crashing, global+plugins an honest zero', laptopRep.advisory.context_budget.skill_sources.length === 3
  && laptopRep.advisory.context_budget.skill_sources.filter((s) => s.id !== 'skill_catalog_project').every((s) => s.skills_on_disk === 0),
  JSON.stringify(laptopRep.advisory.context_budget.skill_sources));

const NOCLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-noclaude-home-'));
// deliberately do NOT create .claude at all here — the CI shape (no ~/.claude whatsoever)
const NOCLAUDE_ROOT = makeCompletenessBase('forge-doctor-noclaude-project-');
const noClaudeRep = cbHomeOverride(NOCLAUDE_HOME, () => D.runDoctor(NOCLAUDE_ROOT));
t('CI shape: no ~/.claude at all never flips doctor.ok either', noClaudeRep.ok === true, JSON.stringify(Object.entries(noClaudeRep.checks).filter(([, c]) => !c.ok).map(([k]) => k)));

// real-project regression guard: this project's OWN real skills are evaluated (no drift), and the KNOWN,
// already-real, non-blocking findings are named exactly — a genuine NEW regression elsewhere would show up
// as an EXTRA failing skill here, not silently absorbed into this fixed expectation.
const realSkillHygiene = D.skillHygiene(REAL_PROJECT_ROOT);
// COUNT: 49 -> 57. Not project growth: not one skill was added. The recursive-scope fix above
// simply made the 8 gsap sub-skills VISIBLE to a check that had never once looked at them. Measured both
// ways on this project the same day: `ls .claude/skills/*/SKILL.md | wc -l` = 49 vs
// `find .claude/skills -name SKILL.md | wc -l` = 57.
// DERIVED, NOT LITERAL: 59 -> 74 in one day as wp6/wp6b/wp13b vendored and wrote skills,
// and every literal went stale mid-run. The expectation is now read off the disk by an INDEPENDENT walk (not
// D.listSkillFiles — deriving the answer from the function under test would prove nothing) and compared as a
// SET of skill ids, which is stricter than the old count: a walk that stops one level too shallow, or skips a
// directory, now names the exact skill it lost.
function onDiskSkillIds(skillsDir) {
  const out = [];
  (function walk(dir, rel) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && e.name === 'SKILL.md' && rel) out.push(rel);
    }
  })(skillsDir, '');
  return out.sort();
}
const REAL_SKILLS_DIR = path.join(REAL_PROJECT_ROOT, '.claude', 'skills');
const diskSkillIds = onDiskSkillIds(REAL_SKILLS_DIR);
const diskNestedIds = diskSkillIds.filter((id) => id.includes('/'));
const evaluatedSkillIds = realSkillHygiene.skills.map((s) => s.skill).sort();
console.log('  info derived skill counts: ' + diskSkillIds.length + ' SKILL.md on disk (' + diskNestedIds.length + ' nested) · ' + realSkillHygiene.checked + ' evaluated by skillHygiene');
pinned('skillHygiene: evaluates exactly the SKILL.md set on disk (derived count, nested included — no drift)', () =>
  t('skillHygiene: evaluates exactly the ' + diskSkillIds.length + ' SKILL.md files on disk, all ' + diskNestedIds.length + ' NESTED ones included (derived set, no drift)',
    realSkillHygiene.checked === diskSkillIds.length && evaluatedSkillIds.join(',') === diskSkillIds.join(','),
    'missing from doctor: ' + JSON.stringify(diskSkillIds.filter((id) => !evaluatedSkillIds.includes(id))) + ' · extra in doctor: ' + JSON.stringify(evaluatedSkillIds.filter((id) => !diskSkillIds.includes(id)))));
// FINDINGS (second revision): 10 -> 1. The 9 that left are ALL third-party skills copied at a
// recorded pin (humanizer @1b48564, the 8 gsap sub-skills @aed9cfd) and they did NOT disappear — they moved
// to `vendored_style`, numbers intact, because their shape is upstream's editorial choice while their
// function in our tree is still judged. The limit was NOT relaxed and no name was allowlisted: the exemption
// is driven by provenance the vendoring step actually wrote into each file.
//
// Two guards, deliberately in opposite directions, so this cannot rot into a rubber stamp:
//   (a) exactly ONE real finding remains, named — a NEW regression cannot hide inside a total;
//   (b) exactly NINE skills carry vendored_style with a real source+pin — if a future edit made the
//       exemption too broad and swallowed one of ours, this count moves and the test fails.
// this list is now EMPTY, and that is a fix rather than a loosening. Its only entry was
// forge-snapshot, flagged for documenting `.claude/.forge-snapshot-due.json` — a marker its own
// forge-snapshot-marker.cjs writes and the SessionStart hook consumes, so "absent" is its normal state.
// generatedPathBasenames() now reclassifies such a reference under generated_refs instead of counting it
// as a broken link. Guard (c) below asserts that reclassification really happened, so an empty findings
// list can never be reached by simply switching the check off.
const KNOWN_HYGIENE_FINDINGS = [].sort();
// the vendored_style set is DERIVED too (it was a literal of 9; wp6 made it 14 and wp6b
// adds more). The derivation deliberately re-implements the rule from the raw files instead of reading the
// doctor's own verdict: a skill is expected in vendored_style exactly when the doctor's pin detector finds a
// Source: + Pinned commit: header AND the file breaks a shape budget (description > 200 chars or body > 500
// lines). Guard (b)'s intent survives both ways: an exemption that widens to one of OUR skills (no pin) makes
// the doctor's set larger than this one, and an unpinned skill breaking a budget must still show up as an
// ordinary finding (the complementary assertion right after guard (b) below).
const shapeBreaks = (text) => {
  const fm = D.parseFrontmatter(text);
  const desc = fm && fm.description;
  return !!(desc && desc.length > D.SKILL_DESCRIPTION_MAX_CHARS) || text.split(/\r?\n/).length > D.SKILL_BODY_MAX_LINES;
};
const diskSkillText = (id) => { try { return fs.readFileSync(path.join(REAL_SKILLS_DIR, ...id.split('/'), 'SKILL.md'), 'utf8'); } catch { return ''; } };
const KNOWN_VENDORED_EXEMPT = diskSkillIds.filter((id) => { const tx = diskSkillText(id); return D.detectVendorPin(tx) && shapeBreaks(tx); }).sort();
const OURS_BREAKING_SHAPE = diskSkillIds.filter((id) => { const tx = diskSkillText(id); return !D.detectVendorPin(tx) && shapeBreaks(tx); }).sort();
console.log('  info derived vendored_style set: ' + KNOWN_VENDORED_EXEMPT.length + ' pinned skill(s) over a shape budget · ' + OURS_BREAKING_SHAPE.length + ' unpinned skill(s) over a shape budget');
devTreeOnly('skillHygiene: the real project carries exactly the KNOWN findings — never a silent NEW regression', () =>
  t('skillHygiene: the real project carries exactly the KNOWN findings — never a silent NEW regression', realSkillHygiene.skills.filter((s) => !s.ok).map((s) => s.skill).sort().join(',') === KNOWN_HYGIENE_FINDINGS.join(','), JSON.stringify(realSkillHygiene.skills.filter((s) => !s.ok))));
// (c) the empty findings list above must be earned by RECLASSIFICATION, not by a check that stopped
// looking: forge-snapshot still has to surface its marker reference, now under generated_refs.
// found by the independent verify-boss re-execution: this assertion
// demanded "listed under generated_refs", which the classifier only does while the marker is ABSENT. The session's
// own precompact hook had just written `.claude/.forge-snapshot-due.json`, the reference resolved to a real file,
// dropped out of generated_refs, and the dev-tree doctor went red without any code change. Both states are correct
// — a generated marker that currently exists is simply a resolving reference — so the assertion now accepts either
// and only ever fails when the reference is FLAGGED AS DANGLING (the reclassification actually switched off).
function generatedRefReported(entry, basename, markerPath) {
  const listed = Array.isArray(entry.generated_refs) && entry.generated_refs.some((r) => r.includes(basename));
  const onDisk = fs.existsSync(markerPath);
  const flaggedDangling = JSON.stringify(entry.issues || []).includes(basename);
  return !flaggedDangling && (listed || onDisk);
}
devTreeOnly('skillHygiene: forge-snapshot still REPORTS its runtime marker, now as a generated ref', () =>
  t('skillHygiene: forge-snapshot still REPORTS its runtime marker, now as a generated ref (or the marker currently exists) — never as dangling',
    generatedRefReported(realSkillHygiene.skills.find((s) => s.skill === 'forge-snapshot') || {}, '.forge-snapshot-due.json', path.join(REAL_ROOT, '.claude', '.forge-snapshot-due.json')),
    JSON.stringify(realSkillHygiene.skills.find((s) => s.skill === 'forge-snapshot'))));
// (d) 2026-09-23: forge-router and forge-intake now read `.claude/.forge-setup.json` (what /setup-forge saved,
// so the silent intake never re-asks it). forge-setup.cjs writes that file through a path VARIABLE; the
// reference must surface as a generated ref, not as the dangling link the real doctor reported before the fix.
devTreeOnly('skillHygiene: forge-router REPORTS the /setup-forge marker as a generated ref (variable-written path resolved)', () =>
  t('skillHygiene: forge-router REPORTS the /setup-forge marker as a generated ref (or /setup-forge already wrote it) — never as dangling',
    generatedRefReported(realSkillHygiene.skills.find((s) => s.skill === 'forge-router') || {}, '.forge-setup.json', path.join(REAL_ROOT, '.claude', '.forge-setup.json')),
    JSON.stringify(realSkillHygiene.skills.find((s) => s.skill === 'forge-router'))));
// The three assertions below all describe the VENDORED skills specifically, which is exactly the surface
// the distribution strips. Note that two of them are `every(...)` over a filtered array: in a tree with no
// vendored skills they would not fail, they would pass VACUOUSLY over an empty list — a silent green that
// looks like coverage and is none. Being visibly skipped is the honest outcome there; being strict is the
// honest outcome here.
pinned('skillHygiene: exactly the pinned upstream skills over a shape budget carry a vendored_style entry (derived set)', () =>
  t('skillHygiene: exactly the ' + KNOWN_VENDORED_EXEMPT.length + ' pinned upstream skills over a shape budget carry a vendored_style entry (derived; the exemption did not widen to cover one of ours)', realSkillHygiene.skills.filter((s) => s.vendored && s.vendored_style.length).map((s) => s.skill).sort().join(',') === KNOWN_VENDORED_EXEMPT.join(','), JSON.stringify(realSkillHygiene.skills.filter((s) => s.vendored && s.vendored_style.length).map((s) => ({ skill: s.skill, vendored: s.vendored, vendored_style: s.vendored_style })))));
pinned('skillHygiene: a skill WITHOUT a pin never gets vendored_style, and one over a budget stays an ordinary finding', () =>
  t('skillHygiene (wp17): no unpinned skill carries vendored_style, and each of the ' + OURS_BREAKING_SHAPE.length + ' unpinned skill(s) over a shape budget is still reported as an issue',
    realSkillHygiene.skills.every((s) => s.vendored || s.vendored_style === undefined)
      && OURS_BREAKING_SHAPE.every((id) => realSkillHygiene.skills.some((s) => s.skill === id && !s.ok && s.issues.some((i) => /chars \(max|lines \(max/.test(i)))),
    JSON.stringify(OURS_BREAKING_SHAPE)));
// wp13b writes forge-prompt-coach as FORGE-NATIVE content: it must never carry a vendoring pin (a
// pin would quietly buy it the upstream-shape exemption). Absent -> a visible skip, never a silent pass.
if (fs.existsSync(path.join(REAL_SKILLS_DIR, 'forge-prompt-coach', 'SKILL.md'))) {
  t('skillHygiene (wp17): forge-prompt-coach is Forge-native — no vendoring pin, so no shape exemption', D.detectVendorPin(diskSkillText('forge-prompt-coach')) === null && !realSkillHygiene.skills.some((s) => s.skill === 'forge-prompt-coach' && s.vendored));
} else {
  skip('skillHygiene (wp17): forge-prompt-coach is Forge-native', '.claude/skills/forge-prompt-coach/SKILL.md is not on disk in this tree');
}
pinned('skillHygiene: every exempted skill really does carry BOTH an upstream source and a commit pin', () =>
  t('skillHygiene: every exempted skill really does carry BOTH an upstream source and a commit pin (evidence, not a label)', realSkillHygiene.skills.filter((s) => s.vendored).every((s) => /^https?:\/\/\S+/.test(s.vendored.source) && /^[0-9a-f]{7,40}$/.test(s.vendored.pin)), JSON.stringify(realSkillHygiene.skills.filter((s) => s.vendored).map((s) => s.vendored))));
// WP-SKILLBUDGET: the gsap descriptions were shortened to <=110 chars (skill-listing budget), so
// they no longer break the 200-char shape budget. The pin used to require exactly one vendored_style entry per
// gsap skill; it now DERIVES the expectation from the file on disk (same shapeBreaks rule as guard (b)): a gsap
// skill that breaks a shape budget must still carry exactly one measured vendored_style entry, one that does not
// must carry none, and none may ever become an ordinary issue. Still strict both ways, and the set must be 8.
pinned('skillHygiene: the gsap skills are MEASURED, and any shape break is filed as upstream shape', () =>
  t('skillHygiene: the 8 gsap skills are MEASURED — a shape break is filed as upstream shape (real char count survives), a skill within budget carries none',
    realSkillHygiene.skills.filter((s) => s.skill.startsWith('gsap/')).length === 8
      && realSkillHygiene.skills.filter((s) => s.skill.startsWith('gsap/')).every((s) => s.issues.length === 0
        && (shapeBreaks(diskSkillText(s.skill))
          ? (s.vendored_style.length === 1 && /^description is \d+ chars \(max 200\)$/.test(s.vendored_style[0]))
          : (s.vendored_style || []).length === 0)),
    JSON.stringify(realSkillHygiene.skills.filter((s) => s.skill.startsWith('gsap/')))));

// =====================================================================================================
// §9 NESTED GIT REPOSITORIES — the leak scan's biggest blind spot
//
// MEASURED, not assumed, on this very project the day this section was written:
//   git ls-files | wc -l                      -> 1298
//   git ls-files | grep -c '^command-center/' ->    0
// `command-center/` is its OWN git repository nested under the project root. trackedFiles() sourced the
// whole leak scan from a single `git ls-files` at the root, so every file in that tree — the gateway that
// spawns the real `claude` CLI, the Discord integration whose .env holds a live bot token — was never
// looked at even once, while the doctor printed "1146 tracked files (git) · clean" and the sync gate read
// that as coverage. The scan was not clean; it was blindfolded, and nothing in the output said so.
//
// The fixture below is the same shape in miniature: an outer repo, an inner repo, a real-looking secret
// tracked inside the inner one, and a genuinely gitignored .env next to it. Two things are proven at once
// and they pull in opposite directions on purpose — the secret must be FOUND (coverage), the .env must
// stay UNSEEN (gitignore is still honored, and a path we were never meant to read is not a path we may
// print).
// =====================================================================================================
const NESTED_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nested-'));
const NESTED_SECRET = 'nvapi-7hQ2rLm9vKcW4dTgB1yZxP6nUaEjR8sFoI3lMwYtHqZbNvCxDkSuGpJr';   // long, high-entropy, no placeholder marker
const NESTED_ENV_SECRET = 'nvapi-' + synthKey('nested-env', 56); // synthetic test value (FAKE), built at runtime
const gitOk = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).status === 0;
// the outer repo: one ordinary tracked file, no secret of its own
fs.writeFileSync(path.join(NESTED_ROOT, 'readme.md'), '# outer project\nnothing secret here\n');
// the inner repo: a TRACKED file carrying a real-looking secret, plus a genuinely IGNORED .env carrying
// another one. `git add -A` inside the inner repo honors its own .gitignore, so the .env is never listed.
const NESTED_SUB = path.join(NESTED_ROOT, 'command-center');
fs.mkdirSync(NESTED_SUB, { recursive: true });
fs.writeFileSync(path.join(NESTED_SUB, '.gitignore'), '.env\n');
fs.writeFileSync(path.join(NESTED_SUB, 'gateway-config.md'), 'deploy key = ' + NESTED_SECRET + '\n');
fs.writeFileSync(path.join(NESTED_SUB, '.env'), 'DISCORD_TOKEN=' + NESTED_ENV_SECRET + '\n');
// ORDER AND SCOPE MATTER, and getting them wrong silently destroys the test: the inner repo is created
// FIRST and the outer repo then tracks ONLY its own readme.md. That reproduces the measured shape of this
// project exactly — `git ls-files | grep -c '^command-center/'` = 0, the nested tree entirely absent from
// the outer index. (Written the other way round — outer `git add -A` before the inner `git init` — the
// outer repo happily absorbs the nested files, the secret is found by the ROOT source, and the test passes
// while proving nothing at all. That is the first version of this fixture, and it passed.)
const nestedGitReady = gitOk(NESTED_SUB, 'init', '-q')
  && gitOk(NESTED_SUB, 'add', '-A')
  && gitOk(NESTED_ROOT, 'init', '-q')
  && gitOk(NESTED_ROOT, 'add', 'readme.md');
if (!nestedGitReady) {
  // A visible skip, never a silent green: this section's whole claim is about what `git ls-files` reports,
  // so without a working git there is nothing here to prove either way.
  skip('nested-repo leak scan (§9)', 'git init/add unavailable in this environment — the section proves a git ls-files property and cannot be faked');
} else {
  const nestedLeak = D.leakScan(NESTED_ROOT);
  const nestedJson = JSON.stringify(nestedLeak);
  // PRECONDITION, asserted rather than assumed: the outer repo really does contribute only readme.md, so a
  // hit on the nested file can ONLY have come from a second source. Without this the test above could go
  // green because the fixture leaked into the root index instead of because the scan was widened.
  t('leakScan: the outer repo genuinely tracks only its own file (the nested tree is invisible to it)',
    (nestedLeak.sources || []).some((s) => s.root === '.' && s.files === 1), JSON.stringify(nestedLeak.sources));
  // THE BUG: before this fix the inner repo contributed nothing at all and this was 0 hits + "clean".
  t('leakScan: a secret tracked in a NESTED git repo is found (the command-center blind spot)',
    nestedLeak.hits.some((h) => h.file.replace(/\\/g, '/') === 'command-center/gateway-config.md' && h.pattern === 'nvidia-nvapi-key'), nestedJson);
  t('leakScan: and that makes the verdict red rather than a blindfolded "clean"', nestedLeak.ok === false);
  // gitignore is still the boundary: a file the inner repo deliberately does not track is not scanned, is
  // not reported as a path, and its contents never reach the output.
  t('leakScan: a gitignored .env inside the nested repo is NOT scanned and NOT named as a path',
    !nestedJson.includes('.env'), nestedJson);
  t('leakScan: neither secret is ever echoed into the report (paths and pattern labels only)',
    !nestedJson.includes(NESTED_SECRET) && !nestedJson.includes(NESTED_ENV_SECRET));
  // HONEST ACCOUNTING: the printed total must say how many files came from how many repos, or a reader has
  // no way to tell a widened scan from a lucky one.
  t('leakScan: reports one entry per contributing repo, each with its own listed-file count',
    Array.isArray(nestedLeak.sources) && nestedLeak.sources.length === 2
      && nestedLeak.sources.some((s) => s.root === '.' && s.method === 'git' && s.files > 0)
      && nestedLeak.sources.some((s) => s.root === 'command-center' && s.method === 'git' && s.files > 0),
    JSON.stringify(nestedLeak.sources));
  const nestedSummary = D.printSummary({ root: NESTED_ROOT, ok: false, checks: { node_check: { ok: true, total: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [] }, strict_events: { ok: true }, dashboard_spa: { ok: true, present: [] }, leak_scan: nestedLeak }, advisory: {} });
  t('printSummary: the leak-scan line names the nested repo as a separate source, not one anonymous total',
    /2 repos: \. \d+ \+ command-center \d+/.test(nestedSummary), (nestedSummary.split('\n').find((l) => /leak scan/.test(l)) || nestedSummary));
}
// A project with NO nested repo must behave exactly as it always did — one source, no extra clause, same
// single-repo line. A widened scan that quietly restyles every ordinary project's output is a regression
// of its own.
const SOLO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-solo-'));
fs.writeFileSync(path.join(SOLO_ROOT, 'readme.md'), '# solo project\nno secrets, no nesting\n');
if (!gitOk(SOLO_ROOT, 'init', '-q') || !gitOk(SOLO_ROOT, 'add', '-A')) {
  skip('single-repo leak scan is unchanged (§9)', 'git init/add unavailable in this environment');
} else {
  const soloLeak = D.leakScan(SOLO_ROOT);
  t('leakScan: a project with no nested repo still reports exactly one git source', soloLeak.source === 'git' && soloLeak.sources.length === 1 && soloLeak.sources[0].root === '.', JSON.stringify(soloLeak.sources));
  const soloSummary = D.printSummary({ root: SOLO_ROOT, ok: true, checks: { node_check: { ok: true, total: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [] }, strict_events: { ok: true }, dashboard_spa: { ok: true, present: [] }, leak_scan: soloLeak }, advisory: {} });
  t('printSummary: and its leak-scan line carries no multi-repo clause at all', /leak scan\s+\d+ tracked files \(git\) · clean/.test(soloSummary) && !/repos:/.test(soloSummary), (soloSummary.split('\n').find((l) => /leak scan/.test(l)) || soloSummary));
  t('printSummary: ...and no "not scanned" clause either (nothing was left out)', !/not scanned:/.test(soloSummary) && Array.isArray(soloLeak.notScanned) && soloLeak.notScanned.length === 0);
}

// =====================================================================================================
// §9b AGENT WORKTREE CHECKOUTS ARE NOT NESTED REPOSITORIES (WP-SYNC-R8)
//
// MEASURED on the 26H2 project: .claude/worktrees held 98 folders, 93 of them `git worktree add` checkouts
// (each with a .git FILE), about 3.2 million files, 29.5 GB. nestedGitRepos() (depth 4) found every checkout
// at depth 3 and trackedFiles() fed each one's whole `git ls-files` into the leak scan — millions of reads of
// copies of the project's own repository. Fixture: a real repo, a real nested command-center repo (must still
// be found and scanned) and three REAL worktree checkouts of the project's own repo under .claude/worktrees
// (must never be found, never be read, and must be NAMED as not scanned).
// =====================================================================================================
const WT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-wt-'));
const WT_FILES = 60;
const gitWt = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
for (let j = 0; j < WT_FILES; j++) wf(WT_ROOT, 'src/m' + (j % 6) + '/file' + j + '.md', 'plain project file ' + j + '\n');
wf(WT_ROOT, 'command-center/gateway.md', '# gateway\n');
const wtReady = gitWt(path.join(WT_ROOT, 'command-center'), 'init', '-q').status === 0
  && gitWt(path.join(WT_ROOT, 'command-center'), 'add', '-A').status === 0
  && gitWt(WT_ROOT, 'init', '-q').status === 0
  && gitWt(WT_ROOT, 'add', 'src').status === 0
  && gitWt(WT_ROOT, 'commit', '-q', '-m', 'base').status === 0
  && ['wt-1', 'wt-2', 'wt-3'].every((w) => gitWt(WT_ROOT, 'worktree', 'add', '-q', '-b', 'b-' + w, '.claude/worktrees/' + w).status === 0);
if (!wtReady) {
  skip('agent worktree checkouts (§9b)', 'git init/commit/worktree add unavailable here — the section proves a git-checkout property and cannot be faked');
} else {
  // PRECONDITION: these are real checkouts with a .git FILE each — exactly what the pre-R8 discovery counted as nested repos
  t('§9b (precondition) each checkout under .claude/worktrees has a .git FILE and its own copy of the project files',
    ['wt-1', 'wt-2', 'wt-3'].every((w) => { try { return fs.statSync(path.join(WT_ROOT, '.claude', 'worktrees', w, '.git')).isFile() && fs.existsSync(path.join(WT_ROOT, '.claude', 'worktrees', w, 'src', 'm0', 'file0.md')); } catch { return false; } }));
  t('isAgentWorktreesDir: .claude/worktrees at any depth and any case; nothing else',
    D.isAgentWorktreesDir('.claude/worktrees') && D.isAgentWorktreesDir('command-center/.Claude/Worktrees') && !D.isAgentWorktreesDir('worktrees') && !D.isAgentWorktreesDir('src/worktrees') && !D.isAgentWorktreesDir('.claude/worktrees/wt-1') && !D.isAgentWorktreesDir('.claude'));
  const notOut = [];
  const repos = D.nestedGitRepos(WT_ROOT, D.NESTED_REPO_MAX_DEPTH, notOut);
  t('nestedGitRepos: the real nested repo is still found, no worktree checkout is', JSON.stringify(repos) === JSON.stringify(['command-center']) && JSON.stringify(notOut) === JSON.stringify(['.claude/worktrees']), JSON.stringify({ repos, notOut }));
  // count every file read the leak scan makes (the doctor shares this fs module)
  const wrapped = ['readFileSync', 'statSync', 'existsSync', 'readdirSync'];
  const orig = {};
  let insideReads = 0, allReads = 0;
  const inside = (p) => /[\\/]\.claude[\\/]worktrees[\\/]/i.test(String(p));
  for (const n of wrapped) { orig[n] = fs[n]; fs[n] = function (p, ...rest) { if (n === 'readFileSync') allReads++; if (inside(p)) insideReads++; return orig[n].call(fs, p, ...rest); }; }
  let wtLeak;
  try { wtLeak = D.leakScan(WT_ROOT); } finally { for (const n of wrapped) fs[n] = orig[n]; }
  t('leakScan: zero reads inside .claude/worktrees (' + allReads + ' reads in all, ' + WT_FILES + ' project files scanned)', insideReads === 0 && wtLeak.scanned >= WT_FILES);
  t('leakScan: the sources are the project and command-center only', JSON.stringify(wtLeak.sources.map((s) => s.root)) === JSON.stringify(['.', 'command-center']), JSON.stringify(wtLeak.sources));
  t('leakScan: the skipped folder is NAMED (notScanned), never silently dropped', wtLeak.notScanned.length === 1 && wtLeak.notScanned[0].dir === '.claude/worktrees' && /agent worktree checkouts/.test(wtLeak.notScanned[0].reason));
  const wtSummary = D.printSummary({ root: WT_ROOT, ok: true, checks: { node_check: { ok: true, total: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [] }, strict_events: { ok: true }, dashboard_spa: { ok: true, present: [] }, leak_scan: wtLeak }, advisory: {} });
  t('printSummary: the leak-scan line says .claude/worktrees/ was not scanned', /leak scan.*not scanned: \.claude\/worktrees\/ \(agent worktree checkouts\)/.test(wtSummary), (wtSummary.split('\n').find((l) => /leak scan/.test(l)) || wtSummary));
}
// the gitless fallback walk skips the CHECKOUTS too (no git at the root -> bounded walk). WP-SYNC-R10 (Codex R8-03b): only a
// child that holds a .git entry is skipped — R8 skipped the whole folder, so a plain folder or file there was never scanned.
const WT_NOGIT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-wt-nogit-'));
wf(WT_NOGIT, 'src/a.md', 'a\n');
wf(WT_NOGIT, '.claude/agent-memory/MEMORY.md', '# memory\n');
for (let w = 0; w < 3; w++) wf(WT_NOGIT, '.claude/worktrees/wt-' + w + '/.git', 'gitdir: ../../../.git/worktrees/wt-' + w + '\n'); // real checkouts: a .git FILE each
for (let j = 0; j < 30; j++) wf(WT_NOGIT, '.claude/worktrees/wt-' + (j % 3) + '/src/f' + j + '.md', 'checkout copy ' + j + '\n');
const WT_SCRATCH_SECRET = 'nvapi-' + synthKey('wt-scratch', 56); // synthetic test value (FAKE), built at runtime
wf(WT_NOGIT, '.claude/worktrees/scratch/notes.md', 'api = "' + WT_SCRATCH_SECRET + '"\n'); // NOT a checkout (no .git)
wf(WT_NOGIT, '.claude/worktrees/loose.md', 'a plain file directly in the folder\n');
const wtWalk = D.trackedFiles(WT_NOGIT);
t('trackedFiles (gitless walk): nothing inside a CHECKOUT under .claude/worktrees is listed; the rest of .claude still is; the folder is named',
  wtWalk.source === 'walk' && !wtWalk.files.some((f) => /^\.claude\/worktrees\/wt-\d\//i.test(f)) && wtWalk.files.includes('.claude/agent-memory/MEMORY.md') && wtWalk.files.includes('src/a.md') && wtWalk.notScanned.length === 1 && wtWalk.notScanned[0].dir === '.claude/worktrees');
t('[R10] trackedFiles (gitless walk): a NON-checkout folder and a plain file in .claude/worktrees ARE listed (R8 skipped the whole folder)',
  wtWalk.files.includes('.claude/worktrees/scratch/notes.md') && wtWalk.files.includes('.claude/worktrees/loose.md'), JSON.stringify(wtWalk.files.filter((f) => /worktrees/.test(f))));
t('[R10] trackedFiles (gitless walk): the skipped checkouts are counted and named in notScanned (3 folders holding a .git entry)', wtWalk.notScanned[0].checkouts === 3 && /agent worktree checkouts \(3 folder\(s\) holding a \.git entry\)/.test(wtWalk.notScanned[0].reason));
const wtNoGitLeak = D.leakScan(WT_NOGIT);
t('[R10] leakScan (gitless): a secret in a non-checkout folder under .claude/worktrees is FOUND (never silently out of scope)', wtNoGitLeak.source === 'walk' && wtNoGitLeak.hits.some((h) => h.file === '.claude/worktrees/scratch/notes.md') && !JSON.stringify(wtNoGitLeak).includes(WT_SCRATCH_SECRET));
t('[R10] hasGitEntry: a .git FILE or folder counts, a plain folder does not', typeof D.hasGitEntry === 'function' && D.hasGitEntry(path.join(WT_NOGIT, '.claude', 'worktrees', 'wt-0')) && !D.hasGitEntry(path.join(WT_NOGIT, '.claude', 'worktrees', 'scratch')));

// =====================================================================================================
// §10 WHICH TREE IS THIS? — installationProfile + the skip contract it drives
//
// Five assertions across three suites pin an exact property of THIS installation ("57 skills"). They are
// real drift guards here and they fail in the published distribution for a reason that is not a defect:
// the 9 vendored third-party skills are deliberately not redistributed. The cure must not be a tolerance
// or a list of acceptable counts — a count that accepts two answers has stopped guarding anything. It is
// a detector, and the thing it detects has to be evidence rather than a label.
// =====================================================================================================
// the verdict now keys on .claude/config/forge-dev-tree.json, not on "has vendored skills"
// — the public distribution ships vendored skills since wp6, so vendoring stopped telling the trees apart.
// IP_DIST_VENDORED is the case that forced the change: vendored skills on disk, no marker.
const IP_DEV = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-dev-'));
const IP_DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-dist-'));
const IP_DIST_VENDORED = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-distvend-'));
const writeDevMarker = (base, body) => {
  fs.mkdirSync(path.join(base, '.claude', 'config'), { recursive: true });
  fs.writeFileSync(path.join(base, '.claude', 'config', 'forge-dev-tree.json'), body);
};
for (const [base, withVendor, withMarker] of [[IP_DEV, true, true], [IP_DIST, false, false], [IP_DIST_VENDORED, true, false]]) {
  if (withMarker) writeDevMarker(base, '{\n  "dev_tree": true\n}\n');
  fs.mkdirSync(path.join(base, '.claude', 'skills', 'ours'), { recursive: true });
  fs.writeFileSync(path.join(base, '.claude', 'skills', 'ours', 'SKILL.md'), '---\nname: ours\ndescription: a skill we wrote ourselves\n---\n\nbody\n');
  if (withVendor) {
    fs.mkdirSync(path.join(base, '.claude', 'skills', 'upstream'), { recursive: true });
    // the real vendoring header shape, copied from .claude/skills/humanizer/SKILL.md: two indented
    // frontmatter lines, not a comment block. A fixture that invents its own marker syntax proves only
    // that the fixture is wrong (the first version of this one did exactly that and failed).
    fs.writeFileSync(path.join(base, '.claude', 'skills', 'upstream', 'SKILL.md'),
      '---\nname: upstream\ndescription: copied verbatim at a pin\nvendored: |\n  Source: https://github.com/someone/upstream\n  Pinned commit: 1b48564898e999219882660237fde01bf4843a0f\n---\n\nbody\n');
  }
}
const ipDev = D.installationProfile(IP_DEV);
const ipDist = D.installationProfile(IP_DIST);
const ipDistVend = D.installationProfile(IP_DIST_VENDORED);
t('installationProfile: a tree carrying the dev-tree marker is the development tree', ipDev.profile === 'development' && ipDev.marker_present === true && ipDev.vendored.join(',') === 'upstream', JSON.stringify(ipDev));
t('installationProfile: a tree with neither marker nor vendored skills is a redistribution', ipDist.profile === 'redistribution' && ipDist.vendored.length === 0, JSON.stringify(ipDist));
t('installationProfile (wp17): vendored skill dirs WITHOUT forge-dev-tree.json are a distribution, not the dev tree', ipDistVend.profile === 'redistribution' && ipDistVend.marker_present === false && ipDistVend.vendored.join(',') === 'upstream', JSON.stringify(ipDistVend));
t('installationProfile: both verdicts state a reason with the real counts and name the marker, so a skip can quote it', /1 of 2 skills/.test(ipDev.reason) && /0 of 1 skills/.test(ipDist.reason) && /forge-dev-tree\.json/.test(ipDev.reason) && /forge-dev-tree\.json[^;]*absent/.test(ipDist.reason), ipDev.reason + ' || ' + ipDist.reason);
// the marker alone decides — a dev checkout with zero vendored skills is still the dev tree
const IP_MARKER_ONLY = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-markeronly-'));
writeDevMarker(IP_MARKER_ONLY, '{"dev_tree": true}');
t('installationProfile (wp17): the marker alone makes the development tree, vendored skills or not', D.installationProfile(IP_MARKER_ONLY).profile === 'development', JSON.stringify(D.installationProfile(IP_MARKER_ONLY)));
// a marker has to be EARNED too: garbled or dev_tree:false is reported, never promoted
const IP_BADMARK = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-badmark-'));
writeDevMarker(IP_BADMARK, '{ not json');
const ipBad = D.installationProfile(IP_BADMARK);
t('installationProfile (wp17): a malformed marker is NOT the dev tree, and the reason says why', ipBad.profile === 'redistribution' && ipBad.marker_present === true && /not a valid/.test(ipBad.reason), JSON.stringify(ipBad));
const IP_FALSEMARK = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-falsemark-'));
writeDevMarker(IP_FALSEMARK, '{"dev_tree": false}');
t('installationProfile (wp17): a marker saying dev_tree:false is NOT the dev tree', D.installationProfile(IP_FALSEMARK).profile === 'redistribution', JSON.stringify(D.installationProfile(IP_FALSEMARK)));
// provenance must be EARNED: a half-marker (a Source: line with no pin) is not vendoring, or "vendored"
// becomes a word anyone can type to silence a check.
const IP_HALF = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-half-'));
fs.mkdirSync(path.join(IP_HALF, '.claude', 'skills', 'claimed'), { recursive: true });
fs.writeFileSync(path.join(IP_HALF, '.claude', 'skills', 'claimed', 'SKILL.md'), '---\nname: claimed\ndescription: claims vendoring, proves nothing\nvendored: |\n  Source: https://github.com/someone/upstream\n---\n\nbody\n');
t('installationProfile: a Source: line with no commit pin is NOT counted as vendored (and no marker = not the dev tree)', D.installationProfile(IP_HALF).vendored.length === 0 && D.installationProfile(IP_HALF).profile === 'redistribution', JSON.stringify(D.installationProfile(IP_HALF)));
// THE SKIP CONTRACT — the whole point of the mechanism. In the development tree a pinned assertion runs
// strictly; anywhere else it must be VISIBLY skipped and must NOT run. A pin that quietly stops asserting
// is worse than one that fails: the output looks identical to success.
let pinnedRan = false;
const skippedBefore = skipped;
const ranStrict = makePinned(ipDev)('§10 probe (development)', () => { pinnedRan = true; });
t('pinned: in the development tree the assertion actually runs and is reported as run', ranStrict === true && pinnedRan === true);
pinnedRan = false;
const ranDist = makePinned(ipDist)('§10 probe (redistribution) — expected to be skipped, this line is the proof', () => { pinnedRan = true; });
t('pinned: in a redistribution the assertion body does NOT run', ranDist === false && pinnedRan === false);
t('pinned: and the skip is counted + printed, never a silent green', skipped === skippedBefore + 1);
pinnedRan = false;
const ranDistVend = makePinned(ipDistVend)('§10 probe (distribution WITH vendored skills) — expected to be skipped, this line is the proof', () => { pinnedRan = true; });
t('pinned (wp17): a distribution that ships vendored skills runs NO exact-count assertion either', ranDistVend === false && pinnedRan === false && skipped === skippedBefore + 2);

// --- the fixture exemption was JavaScript-only (found while widening the scan) --------------
// The rule "test fixtures legitimately hold fake secrets" has always existed; its implementation was
// /\.test\.[cm]?js$/i, which knows nothing about TypeScript. Every *.test.ts / *.test.tsx in a TS codebase
// was therefore scanned as production source and its deliberate fake credentials reported as leaks. That
// stayed invisible here only because the one TypeScript tree in this project — command-center/dashboard —
// was in the blind spot above: widening the scan surfaced 4 such cry-wolf hits immediately.
const TSFIX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-tsfixture-'));
const TSFIX_SECRET = 'nvapi-' + synthKey('tsfixture', 58); // synthetic test value (FAKE), built at runtime
for (const f of ['chat.test.ts', 'panel.test.tsx', 'gateway.test.mjs', 'legacy.test.cjs']) {
  fs.writeFileSync(path.join(TSFIX_ROOT, f), 'const key = "' + TSFIX_SECRET + '";\n');
}
fs.writeFileSync(path.join(TSFIX_ROOT, 'real-source.ts'), 'export const key = "' + TSFIX_SECRET + '";\n');
const tsfixLeak = D.leakScan(TSFIX_ROOT); // no git here -> walk fallback, same exemption rules
t('leakScan: *.test.ts / *.test.tsx are test fixtures too — the exemption is no longer JavaScript-only',
  !tsfixLeak.hits.some((h) => /\.test\.(ts|tsx|mjs|cjs)$/.test(h.file)), JSON.stringify(tsfixLeak.hits));
t('leakScan: and an ordinary .ts SOURCE file is still scanned (the exemption did not widen to all TypeScript)',
  tsfixLeak.hits.some((h) => h.file.endsWith('real-source.ts')), JSON.stringify(tsfixLeak.hits));

// =====================================================================================================
// §11 BEGINNER SETUP — six ADVISORY checks for the setup traps a first-time user hits.
// Hermetic: temp roots, a fake PATH holding stub tools (.cmd on Windows, sh scripts elsewhere), an injected
// platform for the WSL case. The real `claude` is never probed here; the stubs stand in for it.
// =====================================================================================================
const BS_WIN = process.platform === 'win32';
const bsTmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bs-' + tag + '-'));
function bsStub(dir, name, winBody, shBody) {
  if (BS_WIN) { fs.writeFileSync(path.join(dir, name + '.cmd'), winBody.split('\n').join('\r\n')); return path.join(dir, name + '.cmd'); }
  const p = path.join(dir, name);
  fs.writeFileSync(p, shBody);
  fs.chmodSync(p, 0o755);
  return p;
}
const bsVersionStub = (dir, name, version) => bsStub(dir, name, '@echo off\necho ' + version + '\n', '#!/bin/sh\necho "' + version + '"\n');
const BS_DOCTOR_WIN = '@echo off\nif "%~1"=="doctor" goto doctor\necho 0.0.1-stub\nexit /b 0\n:doctor\necho Claude Code doctor\necho.\necho Running: stub 0.0.1\necho Line three\necho Line four\necho Line five\necho Line six must be cut\nexit /b 0\n';
const BS_DOCTOR_SH = '#!/bin/sh\nif [ "$1" = "doctor" ]; then\n  printf \'Claude Code doctor\\n\\nRunning: stub 0.0.1\\nLine three\\nLine four\\nLine five\\nLine six must be cut\\n\'\n  exit 0\nfi\necho 0.0.1-stub\n';
function bsEnv(dir) {
  const env = { PATH: dir };
  if (BS_WIN) { env.PATHEXT = '.COM;.EXE;.BAT;.CMD'; env.SystemRoot = process.env.SystemRoot; env.ComSpec = process.env.ComSpec; }
  return env;
}

// --- claude-md-size ---
const BS_MD = bsTmp('md');
const mdAbsent = D.claudeMdSize(BS_MD);
t('beginner claude-md-size: no CLAUDE.md -> ok, and it says so', mdAbsent.level === 'ok' && mdAbsent.ok === true && /no project CLAUDE\.md/.test(mdAbsent.detail), JSON.stringify(mdAbsent));
fs.writeFileSync(path.join(BS_MD, 'CLAUDE.md'), 'line\n'.repeat(200));
const mdEdge = D.claudeMdSize(BS_MD);
t('beginner claude-md-size: exactly 200 lines -> info (the limit itself is fine)', mdEdge.level === 'info' && mdEdge.ok === true && mdEdge.files[0].lines === 200, JSON.stringify(mdEdge));
fs.writeFileSync(path.join(BS_MD, 'CLAUDE.md'), 'line\r\n'.repeat(250));
const mdLong = D.claudeMdSize(BS_MD);
t('beginner claude-md-size: a 250-line CLAUDE.md (CRLF) -> warn, counted as 250', mdLong.level === 'warn' && mdLong.ok === false && mdLong.files[0].lines === 250, JSON.stringify(mdLong));
t('beginner claude-md-size: the warn carries the beginner explanation', /Anthropic: long CLAUDE\.md files get ignored; move procedures into skills/.test(mdLong.detail), mdLong.detail);
const BS_MD_DOT = bsTmp('mddot');
fs.mkdirSync(path.join(BS_MD_DOT, '.claude'), { recursive: true });
fs.writeFileSync(path.join(BS_MD_DOT, '.claude', 'CLAUDE.md'), 'x\n'.repeat(201));
t('beginner claude-md-size: .claude/CLAUDE.md is measured too', D.claudeMdSize(BS_MD_DOT).level === 'warn' && D.claudeMdSize(BS_MD_DOT).files[0].file === '.claude/CLAUDE.md', JSON.stringify(D.claudeMdSize(BS_MD_DOT)));
const BS_MD_BAD = bsTmp('mdbad');
fs.mkdirSync(path.join(BS_MD_BAD, 'CLAUDE.md')); // a DIRECTORY named CLAUDE.md: present but unreadable
let mdBad;
try { mdBad = D.claudeMdSize(BS_MD_BAD); } catch (e) { mdBad = { threw: e.message }; }
t('beginner claude-md-size: an unreadable CLAUDE.md -> warn UNREADABLE, never a throw', mdBad.level === 'warn' && mdBad.files[0].lines === null && /UNREADABLE/.test(mdBad.detail), JSON.stringify(mdBad));

// --- path-tools ---
const BS_ALL = bsTmp('pathall');
bsVersionStub(BS_ALL, 'node', 'v99.1.0-stub');
bsVersionStub(BS_ALL, 'git', 'git version 9.9.9-stub');
bsStub(BS_ALL, 'claude', BS_DOCTOR_WIN, BS_DOCTOR_SH);
const ptAll = D.pathTools(BS_ALL, { env: bsEnv(BS_ALL) });
t('beginner path-tools: all three on PATH -> ok, each with the first line of its --version', ptAll.level === 'ok' && ptAll.ok === true && ptAll.tools.node.version === 'v99.1.0-stub' && ptAll.tools.git.version === 'git version 9.9.9-stub' && ptAll.tools.claude.version === '0.0.1-stub', JSON.stringify(ptAll));
const BS_PART = bsTmp('pathpart');
bsVersionStub(BS_PART, 'node', 'v99.1.0-stub');
bsVersionStub(BS_PART, 'git', 'git version 9.9.9-stub');
const ptPart = D.pathTools(BS_PART, { env: bsEnv(BS_PART) });
t('beginner path-tools: claude missing -> warn naming it MISSING with the reopen-your-terminal line', ptPart.level === 'warn' && ptPart.ok === false && ptPart.missing.join(',') === 'claude' && /claude: MISSING/.test(ptPart.detail) && /Close and reopen your terminal; if it is still missing, the install folder is not on PATH/.test(ptPart.detail), JSON.stringify(ptPart));
t('beginner path-tools: node present -> no Node explanation in the warn', !/Node 18/.test(ptPart.detail), ptPart.detail);
const BS_NONODE = bsTmp('pathnonode');
bsVersionStub(BS_NONODE, 'git', 'git version 9.9.9-stub');
const ptNoNode = D.pathTools(BS_NONODE, { env: bsEnv(BS_NONODE) });
t('beginner path-tools: node missing -> says plainly that Forge needs Node 18+ although Claude Code does not', ptNoNode.missing.includes('node') && /need Node 18 or newer, even though Claude Code itself does not/.test(ptNoNode.detail), ptNoNode.detail);
let ptEmpty;
try { ptEmpty = D.pathTools(BS_NONODE, { env: {} }); } catch (e) { ptEmpty = { threw: e.message }; }
t('beginner path-tools: an EMPTY/absent PATH -> all three missing, never a throw', Array.isArray(ptEmpty.missing) && ptEmpty.missing.length === 3 && ptEmpty.level === 'warn', JSON.stringify(ptEmpty));
const garbledPath = (BS_WIN ? ['', '"' + BS_ALL + '"', 'Z:\\no\\such\\dir', ';;'] : ['', '/no/such/dir', BS_ALL, '']).join(BS_WIN ? ';' : ':');
let ptGarbled;
try { ptGarbled = D.pathTools(BS_ALL, { env: Object.assign(bsEnv(BS_ALL), { PATH: garbledPath }) }); } catch (e) { ptGarbled = { threw: e.message }; }
t('beginner path-tools: a garbled PATH (empty segments, missing dirs' + (BS_WIN ? ', a quoted entry' : '') + ') still resolves the real entries', ptGarbled.level === 'ok' && ptGarbled.missing.length === 0, JSON.stringify(ptGarbled));
const BS_SILENT = bsTmp('pathsilent');
bsStub(BS_SILENT, 'git', '@echo off\n', '#!/bin/sh\nexit 0\n');
const ptSilent = D.pathTools(BS_SILENT, { env: bsEnv(BS_SILENT) });
t('beginner path-tools: a tool whose --version prints nothing is FOUND with an honest note, never a made-up version', ptSilent.tools.git.found === true && ptSilent.tools.git.version === null && /printed nothing/.test(ptSilent.tools.git.version_note), JSON.stringify(ptSilent.tools.git));
// the node on PATH that IS this process reports process.version without a spawn (same string --version prints)
const ptSelf = D.pathTools(BS_ALL, { env: Object.assign(bsEnv(BS_ALL), { PATH: path.dirname(process.execPath) }) });
t('beginner path-tools: when PATH node is this very binary, its version is process.version (no extra spawn)', ptSelf.tools.node.found === true && ptSelf.tools.node.version === process.version && ptSelf.tools.node.version_source === 'this doctor process', JSON.stringify(ptSelf.tools.node));
t('beginner path-tools: a stub node that is NOT this binary is still really probed', ptAll.tools.node.version_source === undefined && ptAll.tools.node.version === 'v99.1.0-stub');
// the shell only runs what it can execute: the extension-less npm sh shim on Windows, a 0644 file elsewhere
const BS_NOEXEC = bsTmp('pathnoexec');
fs.writeFileSync(path.join(BS_NOEXEC, 'claude'), '#!/bin/sh\necho nope\n');
if (!BS_WIN) fs.chmodSync(path.join(BS_NOEXEC, 'claude'), 0o644);
t('beginner path-tools: a non-executable "claude" file is NOT counted as on PATH (' + (BS_WIN ? 'no PATHEXT extension' : 'no execute bit') + ')', D.resolveOnPath('claude', bsEnv(BS_NOEXEC), process.platform) === null);

// --- claudeVersionAdvisory — pure-function tests with a stubbed version string, then the
//     real pathTools integration via the SAME stub-binary mechanism the tests above already use. ---
tFn('claudeVersionAdvisory: an older claude gets a plain, non-judgmental nudge naming CLAUDE_VERSION_ADVISORY_MIN', () => {
  const msg = D.claudeVersionAdvisory('2.1.220 (Claude Code)');
  if (!msg) throw new Error('expected an advisory for 2.1.220, got null');
  if (!/2\.1\.220/.test(msg)) throw new Error('does not name the installed version: ' + msg);
  if (!msg.includes(D.CLAUDE_VERSION_ADVISORY_MIN)) throw new Error('does not name the advisory threshold: ' + msg);
  if (!/claude update/.test(msg)) throw new Error('does not mention `claude update`: ' + msg);
});
t('claudeVersionAdvisory: exactly the threshold version -> no advisory (>= is current, not "older than")', D.claudeVersionAdvisory('2.1.280') === null);
t('claudeVersionAdvisory: a newer version -> no advisory', D.claudeVersionAdvisory('2.1.281 (Claude Code)') === null && D.claudeVersionAdvisory('3.0.0') === null);
t('claudeVersionAdvisory: an older MAJOR version is still caught (numeric triple comparison, not string comparison)', D.claudeVersionAdvisory('1.9.999') !== null);
t('claudeVersionAdvisory: an unparseable version string returns null rather than guessing', D.claudeVersionAdvisory('unknown') === null && D.claudeVersionAdvisory('') === null && D.claudeVersionAdvisory(null) === null);
t('claudeVersionAdvisory: never uses the word "broken" or similar alarm language — it is a heads-up, not a defect', !/broken|error|fail/i.test(D.claudeVersionAdvisory('0.0.1-stub')));
tFn('parseVersionTriple / compareVersionTriples: ordinary numeric triple behaviour', () => {
  const a = D.parseVersionTriple('2.1.9'), b = D.parseVersionTriple('2.1.10');
  if (!a || !b) throw new Error('failed to parse a real triple');
  if (!(D.compareVersionTriples(a, b) < 0)) throw new Error('2.1.9 must compare BELOW 2.1.10 (numeric, not lexicographic — "9" < "10")');
  if (D.parseVersionTriple('not-a-version') !== null) throw new Error('garbage input must return null, never a guessed triple');
});

const BS_OLDCLAUDE = bsTmp('patholdclaude');
bsVersionStub(BS_OLDCLAUDE, 'node', 'v99.1.0-stub');
bsVersionStub(BS_OLDCLAUDE, 'git', 'git version 9.9.9-stub');
bsVersionStub(BS_OLDCLAUDE, 'claude', '2.1.220 (Claude Code)');
const ptOldClaude = D.pathTools(BS_OLDCLAUDE, { env: bsEnv(BS_OLDCLAUDE) });
t('beginner path-tools: an OLD claude gets version_advisory attached, in ADDITION to (never instead of) the real version', ptOldClaude.tools.claude.version === '2.1.220 (Claude Code)' && typeof ptOldClaude.tools.claude.version_advisory === 'string' && /claude update/.test(ptOldClaude.tools.claude.version_advisory), JSON.stringify(ptOldClaude.tools.claude));
t('beginner path-tools: the advisory is folded into detail, but level/ok stay driven ONLY by missing tools — never red for a version alone', ptOldClaude.level === 'ok' && ptOldClaude.ok === true && /claude update/.test(ptOldClaude.detail), JSON.stringify({ level: ptOldClaude.level, ok: ptOldClaude.ok, detail: ptOldClaude.detail }));

const BS_NEWCLAUDE = bsTmp('pathnewclaude');
bsVersionStub(BS_NEWCLAUDE, 'node', 'v99.1.0-stub');
bsVersionStub(BS_NEWCLAUDE, 'git', 'git version 9.9.9-stub');
bsVersionStub(BS_NEWCLAUDE, 'claude', '2.1.281 (Claude Code)');
const ptNewClaude = D.pathTools(BS_NEWCLAUDE, { env: bsEnv(BS_NEWCLAUDE) });
t('beginner path-tools: a CURRENT claude gets no version_advisory field at all', ptNewClaude.tools.claude.version_advisory === undefined, JSON.stringify(ptNewClaude.tools.claude));
tFn('beginner path-tools: an old claude ALONGSIDE a missing tool still surfaces the advisory in the warn text too', () => {
  const dir = bsTmp('patholdclaudepartial');
  bsVersionStub(dir, 'claude', '2.0.0');
  // node and git deliberately absent -> forces the warn branch
  const rep = D.pathTools(dir, { env: bsEnv(dir) });
  if (rep.level !== 'warn') throw new Error('expected warn (node/git missing); got ' + rep.level);
  if (!/claude update/.test(rep.detail)) throw new Error('the version advisory must still appear in the warn branch: ' + rep.detail);
});

// --- bypass-mode ---
const BS_BY = bsTmp('bypass');
t('beginner bypass-mode: no project settings -> info', D.bypassMode(BS_BY).level === 'info' && D.bypassMode(BS_BY).ok === true, JSON.stringify(D.bypassMode(BS_BY)));
fs.mkdirSync(path.join(BS_BY, '.claude'), { recursive: true });
fs.writeFileSync(path.join(BS_BY, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
const byOk = D.bypassMode(BS_BY);
t('beginner bypass-mode: another defaultMode -> info, and it names the mode it saw', byOk.level === 'info' && /defaultMode acceptEdits/.test(byOk.detail), JSON.stringify(byOk));
fs.writeFileSync(path.join(BS_BY, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
const byWarn = D.bypassMode(BS_BY);
t('beginner bypass-mode: bypassPermissions in settings.local.json -> warn naming that file', byWarn.level === 'warn' && byWarn.ok === false && /settings\.local\.json sets permissions\.defaultMode "bypassPermissions"/.test(byWarn.detail), JSON.stringify(byWarn));
t('beginner bypass-mode: the warn ends with a pointer to the unsafe-advice reference (nl+en)', /skills\/forge-prompt-coach\/references\/unsafe-advice\.md/.test(byWarn.detail) && /Meer uitleg/.test(byWarn.detail) && /more detail/.test(byWarn.detail), byWarn.detail);
const BS_BY_BAD = bsTmp('bypassbad');
fs.mkdirSync(path.join(BS_BY_BAD, '.claude'), { recursive: true });
fs.writeFileSync(path.join(BS_BY_BAD, '.claude', 'settings.json'), '{ "permissions": { "defaultMode": ');
let byBad;
try { byBad = D.bypassMode(BS_BY_BAD); } catch (e) { byBad = { threw: e.message }; }
t('beginner bypass-mode: malformed settings JSON -> warn "settings unreadable", never a throw', byBad.level === 'warn' && /settings unreadable: \.claude\/settings\.json/.test(byBad.detail), JSON.stringify(byBad));
fs.writeFileSync(path.join(BS_BY_BAD, '.claude', 'settings.json'), 'null');
fs.writeFileSync(path.join(BS_BY_BAD, '.claude', 'settings.local.json'), '[1,2]');
let byOdd;
try { byOdd = D.bypassMode(BS_BY_BAD); } catch (e) { byOdd = { threw: e.message }; }
t('beginner bypass-mode: valid-but-odd JSON (null, an array) -> info, never a throw', byOdd.level === 'info', JSON.stringify(byOdd));

// --- wsl-mnt-c --- (the rule is a pure string check, so the Linux cases run on every OS via the injected platform)
const wslWarn = D.wslMntC('/mnt/c/Users/someone/project', { platform: 'linux' });
t('beginner wsl-mnt-c: linux + a /mnt/c root -> warn with the keep-it-in-the-Linux-home advice', wslWarn.level === 'warn' && wslWarn.ok === false && /WSL: keep the project inside the Linux home for speed/.test(wslWarn.detail), JSON.stringify(wslWarn));
t('beginner wsl-mnt-c: linux + a Linux-filesystem root -> ok', D.wslMntC('/home/someone/project', { platform: 'linux' }).level === 'ok');
t('beginner wsl-mnt-c: win32 / darwin -> n-a', D.wslMntC('/mnt/c/x', { platform: 'win32' }).level === 'n-a' && D.wslMntC('/mnt/c/x', { platform: 'darwin' }).level === 'n-a');
let wslOdd;
try { wslOdd = D.wslMntC(null, { platform: 'linux' }); } catch (e) { wslOdd = { threw: e.message }; }
t('beginner wsl-mnt-c: a missing root never throws', wslOdd.level === 'ok', JSON.stringify(wslOdd));
const wslReal = D.wslMntC(BS_MD);
if (process.platform === 'linux') t('beginner wsl-mnt-c: on this real Linux host a temp-dir root is not under /mnt -> ok', wslReal.level === (BS_MD.startsWith('/mnt/') ? 'warn' : 'ok'), JSON.stringify(wslReal));
else t('beginner wsl-mnt-c: on this real ' + process.platform + ' host the check is n-a', wslReal.level === 'n-a', JSON.stringify(wslReal));

// --- claude-doctor ---
const cdAbsent = D.claudeDoctorProbe(BS_ALL, { claudePath: null, probe: true });
t('beginner claude-doctor: claude absent -> info "not run (claude CLI absent ...)"', cdAbsent.level === 'info' && cdAbsent.ran === false && /not run \(claude CLI absent/.test(cdAbsent.detail), JSON.stringify(cdAbsent));
const cdLib = D.claudeDoctorProbe(BS_ALL, { claudePath: ptAll.tools.claude.path, probe: false });
t('beginner claude-doctor: a library call without the probe flag never spawns it, and says so', cdLib.ran === false && /not run \(library call/.test(cdLib.detail), JSON.stringify(cdLib));
const cdRun = D.claudeDoctorProbe(BS_ALL, { claudePath: ptAll.tools.claude.path, probe: true, env: bsEnv(BS_ALL) });
t('beginner claude-doctor: probe runs the stub and shows exactly the first 5 NON-EMPTY lines verbatim', cdRun.ran === true && cdRun.exit === 0 && cdRun.lines.length === 5 && cdRun.lines[0] === 'Claude Code doctor' && cdRun.lines[1] === 'Running: stub 0.0.1' && !cdRun.lines.includes('Line six must be cut'), JSON.stringify(cdRun));
t('beginner claude-doctor: always info, never a warn — it is shown, not parsed', cdRun.level === 'info' && cdRun.ok === true);
const BS_CD_FAIL = bsTmp('cdfail');
const cdFailStub = bsStub(BS_CD_FAIL, 'claude', '@echo off\necho ERROR something is broken\nexit /b 3\n', '#!/bin/sh\necho "ERROR something is broken"\nexit 3\n');
const cdFail = D.claudeDoctorProbe(BS_CD_FAIL, { claudePath: cdFailStub, probe: true, env: bsEnv(BS_CD_FAIL) });
t('beginner claude-doctor: a non-zero exit is reported with its code, still info (never parsed into a verdict)', cdFail.level === 'info' && cdFail.exit === 3 && cdFail.lines[0] === 'ERROR something is broken', JSON.stringify(cdFail));
const BS_CD_SLOW = bsTmp('cdslow');
const cdSlowStub = bsStub(BS_CD_SLOW, 'claude', '@echo off\nif "%~1"=="doctor" "%SystemRoot%\\System32\\ping.exe" -n 3 127.0.0.1 >nul\necho late\n', '#!/bin/sh\nif [ "$1" = "doctor" ]; then /bin/sleep 2; fi\necho late\n'); // absolute: the fake PATH holds only the stub dir, and sleep is not a shell builtin
const cdSlow = D.claudeDoctorProbe(BS_CD_SLOW, { claudePath: cdSlowStub, probe: true, env: bsEnv(BS_CD_SLOW), timeoutMs: 400 });
t('beginner claude-doctor: a CLI that hangs (e.g. wants a TTY) -> info "not run (timed out ...)", honestly', cdSlow.level === 'info' && cdSlow.ran === false && cdSlow.timed_out === true && /not run \(timed out/.test(cdSlow.detail), JSON.stringify(cdSlow));

// --- prompt-coach-present ---
const BS_PC = bsTmp('coach');
t('beginner prompt-coach-present: no forge-intake -> n-a', D.promptCoachPresent(BS_PC).level === 'n-a');
fs.mkdirSync(path.join(BS_PC, '.claude', 'skills', 'forge-intake'), { recursive: true });
fs.writeFileSync(path.join(BS_PC, '.claude', 'skills', 'forge-intake', 'SKILL.md'), '---\nname: forge-intake\ndescription: x\n---\n');
const pcWarn = D.promptCoachPresent(BS_PC);
t('beginner prompt-coach-present: intake WITHOUT the coach -> warn (incomplete install)', pcWarn.level === 'warn' && pcWarn.ok === false && /forge-prompt-coach\/SKILL\.md is missing/.test(pcWarn.detail), JSON.stringify(pcWarn));
fs.mkdirSync(path.join(BS_PC, '.claude', 'skills', 'forge-prompt-coach'), { recursive: true });
fs.writeFileSync(path.join(BS_PC, '.claude', 'skills', 'forge-prompt-coach', 'SKILL.md'), '---\nname: forge-prompt-coach\ndescription: x\n---\n');
t('beginner prompt-coach-present: intake + coach -> ok', D.promptCoachPresent(BS_PC).level === 'ok');
// the REAL tree: reported as whatever the disk says — a missing coach is a real warn here, never a skip
const pcReal = D.promptCoachPresent(REAL_PROJECT_ROOT);
const realHasCoach = fs.existsSync(path.join(REAL_SKILLS_DIR, 'forge-prompt-coach', 'SKILL.md'));
const realHasIntake = fs.existsSync(path.join(REAL_SKILLS_DIR, 'forge-intake', 'SKILL.md'));
t('beginner prompt-coach-present: the real project is reported exactly as on disk (intake ' + realHasIntake + ', coach ' + realHasCoach + ' -> ' + pcReal.level + ')', pcReal.level === (!realHasIntake ? 'n-a' : (realHasCoach ? 'ok' : 'warn')), JSON.stringify(pcReal));

// --- settings-wired (wp-l1, loop iteration 1) ---
// A minimal template with 1 hook entry + 1 deny rule, and a target that starts as a byte-for-byte copy.
const SW_TEMPLATE_SETTINGS = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 5 }] }] }, permissions: { deny: ['Bash(rm -rf /)'] } };
function swWriteTemplate(dir, settings) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'settings.json');
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return p;
}
// swWithHome — every settings-wired assertion about "no template available" must not depend on whether
// THIS machine happens to have a real canonical template at ~/.claude/forge/template/.claude (it does on
// the author's own machine — that is precisely the installer-written path settingsTemplatePath() now also
// checks). Point HOME/USERPROFILE at a throwaway empty dir first, so "no template" means it here too.
//"no template anywhere" also means no FORGE_SYNC_TEMPLATE_DIR: forge-sync passes its own environment to the
// post-sync doctor, so a sync from a staging template (FORGE_SYNC_TEMPLATE_DIR set) turned the three cases below red.
function swWithHome(fakeHome, fn) {
  const prevHome = process.env.HOME, prevProfile = process.env.USERPROFILE, prevTpl = process.env.FORGE_SYNC_TEMPLATE_DIR;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.FORGE_SYNC_TEMPLATE_DIR;
  try { return fn(); }
  finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    if (prevTpl !== undefined) process.env.FORGE_SYNC_TEMPLATE_DIR = prevTpl;
  }
}

const BS_SW_NOFILE = bsTmp('sw-nofile');
t('settings-wired: no .claude/settings.json at all -> note, ok:true (nothing to compare)', D.settingsWired(BS_SW_NOFILE, {}).level === 'note' && D.settingsWired(BS_SW_NOFILE, {}).ok === true, JSON.stringify(D.settingsWired(BS_SW_NOFILE, {})));

const BS_SW_NOTEMPLATE = bsTmp('sw-notemplate');
fs.mkdirSync(path.join(BS_SW_NOTEMPLATE, '.claude'), { recursive: true });
fs.writeFileSync(path.join(BS_SW_NOTEMPLATE, '.claude', 'settings.json'), JSON.stringify(SW_TEMPLATE_SETTINGS, null, 2) + '\n', 'utf8');
const swNoTemplateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-sw-notemplate-home-'));
const swNoTemplate = swWithHome(swNoTemplateHome, () => D.settingsWired(BS_SW_NOTEMPLATE, {}));
t('settings-wired: settings.json exists but no template given anywhere (env var or canonical install path) -> note, ok:true (cannot judge)', swNoTemplate.level === 'note' && swNoTemplate.ok === true && /no template settings\.json found/.test(swNoTemplate.detail), JSON.stringify(swNoTemplate));

const BS_SW_PRESENT = bsTmp('sw-present');
fs.mkdirSync(path.join(BS_SW_PRESENT, '.claude'), { recursive: true });
fs.writeFileSync(path.join(BS_SW_PRESENT, '.claude', 'settings.json'), JSON.stringify(SW_TEMPLATE_SETTINGS, null, 2) + '\n', 'utf8');
const SW_TEMPLATE_DIR = bsTmp('sw-template');
const swTemplatePath = swWriteTemplate(SW_TEMPLATE_DIR, SW_TEMPLATE_SETTINGS);
const swPresent = D.settingsWired(BS_SW_PRESENT, { source: swTemplatePath });
t('settings-wired: every template hook + deny rule already present -> ok', swPresent.level === 'ok' && swPresent.ok === true, JSON.stringify(swPresent));

const BS_SW_MISSING_HOOK = bsTmp('sw-missinghook');
fs.mkdirSync(path.join(BS_SW_MISSING_HOOK, '.claude'), { recursive: true });
fs.writeFileSync(path.join(BS_SW_MISSING_HOOK, '.claude', 'settings.json'), JSON.stringify({ hooks: {}, permissions: { deny: [] } }, null, 2) + '\n', 'utf8');
const swMissingHook = D.settingsWired(BS_SW_MISSING_HOOK, { source: swTemplatePath });
t('settings-wired: a missing hook + deny rule -> warn (never a hard failure)', swMissingHook.level === 'warn' && swMissingHook.ok === false && /missing 1 hook entry/.test(swMissingHook.detail) && /1 deny rule/.test(swMissingHook.detail), JSON.stringify(swMissingHook));

t('settings-wired: settingsTemplatePath honors FORGE_SYNC_TEMPLATE_DIR when opts.source is absent', (() => {
  const dir = path.dirname(swTemplatePath);
  const prev = process.env.FORGE_SYNC_TEMPLATE_DIR;
  process.env.FORGE_SYNC_TEMPLATE_DIR = dir;
  try { return D.settingsTemplatePath({}) === swTemplatePath; }
  finally { if (prev === undefined) delete process.env.FORGE_SYNC_TEMPLATE_DIR; else process.env.FORGE_SYNC_TEMPLATE_DIR = prev; }
})());
// N8 (2026-09-26 laptop re-audit): on an installer install there is no opts.source and no
// FORGE_SYNC_TEMPLATE_DIR, yet install.ps1/install.sh both copy the shipped .claude tree to
// `<home>/.claude/forge/template/.claude` — the exact same canonical path forge-sync.cjs already falls
// back to. settingsTemplatePath() must find it there (read-only — it never writes), or settings-wired can
// never run on an installer install and is stuck at "note" forever.
t('settings-wired: settingsTemplatePath falls back to the canonical installer template under the home directory', (() => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-sw-home-'));
  const templateSettings = swWriteTemplate(path.join(fakeHome, '.claude', 'forge', 'template', '.claude'), SW_TEMPLATE_SETTINGS);
  return swWithHome(fakeHome, () => D.settingsTemplatePath({}) === templateSettings);
})());
t('settings-wired: an injected opts.source still wins over the canonical installer template', (() => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-sw-home2-'));
  swWriteTemplate(path.join(fakeHome, '.claude', 'forge', 'template', '.claude'), SW_TEMPLATE_SETTINGS);
  return swWithHome(fakeHome, () => D.settingsTemplatePath({ source: swTemplatePath }) === swTemplatePath);
})());
t('settings-wired: with no injected source, no env var and no canonical template on this fake home, it honestly finds nothing', (() => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-sw-home3-'));
  return swWithHome(fakeHome, () => D.settingsTemplatePath({}) === null);
})());
t('settings-wired PORTABLE: an inherited FORGE_SYNC_TEMPLATE_DIR (a sync from a staging template) is hidden inside swWithHome and restored after it', (() => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-sw-home4-'));
  const prev = process.env.FORGE_SYNC_TEMPLATE_DIR;
  process.env.FORGE_SYNC_TEMPLATE_DIR = path.dirname(swTemplatePath);
  try {
    const outside = D.settingsTemplatePath({}) === swTemplatePath;
    const inside = swWithHome(fakeHome, () => D.settingsTemplatePath({}) === null);
    return outside && inside && process.env.FORGE_SYNC_TEMPLATE_DIR === path.dirname(swTemplatePath);
  } finally { if (prev === undefined) delete process.env.FORGE_SYNC_TEMPLATE_DIR; else process.env.FORGE_SYNC_TEMPLATE_DIR = prev; }
})());

// wired into beginnerSetup(): the source is threaded through via opts.settingsSource
const bsWithSettings = D.beginnerSetup(BS_SW_PRESENT, { env: bsEnv(BS_SW_PRESENT), settingsSource: swTemplatePath });
t('settings-wired: beginnerSetup() threads settingsSource through to the settings_wired check', bsWithSettings.checks.settings_wired.level === 'ok', JSON.stringify(bsWithSettings.checks.settings_wired));

// --- model-choice-hint (wp-l4, loop iteration 4) ---
const mch = D.modelChoiceHint();
t('model-choice-hint: id, always info, ok true (pure education, nothing evaluated)', mch.id === 'model-choice-hint' && mch.level === 'info' && mch.ok === true, JSON.stringify(mch));
t('model-choice-hint: mentions the balanced-model default and reserving a heavier model for high-risk work', /Sonnet-class/.test(mch.detail) && /high-risk/.test(mch.detail), mch.detail);
t('model-choice-hint: mentions the usage guard pausing before the limit, and /costs + /insights for visibility', /usage limit/.test(mch.detail) && /`\/costs`/.test(mch.detail) && /`\/insights`/.test(mch.detail), mch.detail);
t('model-choice-hint: no imperative "run this" telling the user what to type (a beginner is never told to run a command here)', !/\brun\b/i.test(mch.detail) && !/\bvoer .* uit\b/i.test(mch.detail) && !/\btype\b/i.test(mch.detail), mch.detail);
t('model-choice-hint: contract shape matches every other beginner_setup check ({id, ok, level, detail})', typeof mch.id === 'string' && typeof mch.detail === 'string' && typeof mch.ok === 'boolean' && ['ok', 'info'].includes(mch.level), JSON.stringify(mch));

// --- aggregate: shape, speed, override, and THE core guarantee (never flips the doctor verdict) ---
const bsAgg = D.beginnerSetup(BS_ALL, { env: bsEnv(BS_ALL) });
const BS_KEYS = ['claude_md_size', 'path_tools', 'bypass_mode', 'wsl_mnt_c', 'claude_doctor', 'prompt_coach_present', 'settings_wired', 'model_choice_hint'];
t('beginner setup: exactly the eight checks, each {id, ok, level, detail, ms}, ok false exactly when level is warn', Object.keys(bsAgg.checks).join(',') === BS_KEYS.join(',') && Object.values(bsAgg.checks).every((c) => typeof c.id === 'string' && typeof c.detail === 'string' && typeof c.ms === 'number' && ['ok', 'info', 'warn', 'n-a', 'note'].includes(c.level) && c.ok === (c.level !== 'warn')), JSON.stringify(bsAgg));
t('beginner setup: the claude found by path-tools is the one the probe would run (not-run in a library call, but not "absent")', /library call/.test(bsAgg.checks.claude_doctor.detail), bsAgg.checks.claude_doctor.detail);
t('beginner setup: every filesystem-only check stays under 300 ms', ['claude_md_size', 'bypass_mode', 'wsl_mnt_c', 'prompt_coach_present', 'settings_wired', 'model_choice_hint'].every((k) => bsAgg.checks[k].ms < 300), JSON.stringify(BS_KEYS.map((k) => k + '=' + bsAgg.checks[k].ms + 'ms')));
const bsProbed = D.beginnerSetup(BS_ALL, { env: bsEnv(BS_ALL), probeClaudeDoctor: true });
t('beginner setup: with probeClaudeDoctor the stub claude found on the fake PATH is really probed', bsProbed.checks.claude_doctor.ran === true && bsProbed.checks.claude_doctor.lines[0] === 'Claude Code doctor', JSON.stringify(bsProbed.checks.claude_doctor));

const BS_VERDICT = makeCompletenessBase('forge-doctor-bs-verdict-');
fs.writeFileSync(path.join(BS_VERDICT, 'CLAUDE.md'), 'line\n'.repeat(250));
fs.mkdirSync(path.join(BS_VERDICT, '.claude', 'skills', 'forge-intake'), { recursive: true });
fs.writeFileSync(path.join(BS_VERDICT, '.claude', 'skills', 'forge-intake', 'SKILL.md'), '---\nname: forge-intake\ndescription: A short, valid description.\n---\n');
fs.writeFileSync(path.join(BS_VERDICT, '.claude', 'settings.json'), '{ broken');
fs.writeFileSync(path.join(BS_VERDICT, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
const bsVerdictRep = D.runDoctor(BS_VERDICT, { env: bsEnv(BS_NONODE) });
const bsv = bsVerdictRep.advisory.beginner_setup;
t('beginner setup verdict fixture: every warn really fires (md 250 lines, bypass + unreadable settings, node/claude missing, coach missing)', bsv.checks.claude_md_size.level === 'warn' && bsv.checks.bypass_mode.level === 'warn' && /settings unreadable/.test(bsv.checks.bypass_mode.detail) && bsv.checks.path_tools.level === 'warn' && bsv.checks.prompt_coach_present.level === 'warn' && bsv.ok === false, JSON.stringify(bsv));
t('beginner setup verdict fixture: the warns do NOT flip doctor.ok (advisory, like every other advisory)', bsVerdictRep.ok === true, JSON.stringify(Object.entries(bsVerdictRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('beginner setup: it lives under `advisory`, never under `checks`', !Object.keys(bsVerdictRep.checks).some((k) => /beginner|claude_md|path_tools|bypass|wsl|claude_doctor|prompt_coach/.test(k)));
const bsSummary = D.printSummary(bsVerdictRep);
t('printSummary: each beginner warn is a ⚠ line labelled advisory, non-blocking', ['claude-md-size', 'path-tools', 'bypass-mode', 'prompt-coach-present'].every((id) => new RegExp('⚠ setup ' + id + ' \\(advisory, non-blocking\\)').test(bsSummary)), bsSummary.split('\n').filter((l) => /setup /.test(l)).join('\n'));
t('printSummary: non-warn beginner lines are labelled advisory too, and no beginner line is ever a ✗', /✓ setup wsl-mnt-c \(advisory\)|⚠ setup wsl-mnt-c/.test(bsSummary) && /ℹ setup claude-doctor \(advisory\)/.test(bsSummary) && !/✗ setup/.test(bsSummary), bsSummary.split('\n').filter((l) => /setup /.test(l)).join('\n'));
t('printSummary: with beginner warns present the verdict still reads ALL GREEN', /⇒ ALL GREEN/.test(bsSummary));
// the owner can acknowledge a deliberate warn (a throwaway VM) with the SAME override mechanism the enforced checks use
fs.mkdirSync(path.join(BS_VERDICT, '.claude', 'config', 'orchestration'), { recursive: true });
fs.writeFileSync(path.join(BS_VERDICT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({ doctor_check_overrides: [{ check: 'bypass-mode', reason: 'disposable CI VM, bypass is intended', by: 'owner', ts: '2026-09-24T00:00:00Z' }] }));
const bsOv = D.beginnerSetup(BS_VERDICT, { env: bsEnv(BS_NONODE), overrideMap: new Map(D.loadDoctorCheckOverrides(BS_VERDICT).map((o) => [o.check, o])) });
t('beginner setup: a doctor_check_overrides entry for "bypass-mode" turns that warn into a VISIBLE override, level unchanged', bsOv.checks.bypass_mode.ok === true && bsOv.checks.bypass_mode.overridden === true && bsOv.checks.bypass_mode.level === 'warn', JSON.stringify(bsOv.checks.bypass_mode));
t('beginner setup: the override covers only the check it names', bsOv.checks.claude_md_size.ok === false && !bsOv.checks.claude_md_size.overridden);
const bsOvSummary = D.printSummary(D.runDoctor(BS_VERDICT, { env: bsEnv(BS_NONODE) }));
t('printSummary: an overridden beginner warn prints ✓ with the [OVERRIDDEN by ...] tag, never silently', /✓ setup bypass-mode \(advisory\): .*\[OVERRIDDEN by owner: disposable CI VM, bypass is intended\]/.test(bsOvSummary), bsOvSummary.split('\n').filter((l) => /bypass-mode/.test(l)).join('\n'));

// --- static guards: nothing new reads the real home; the probe can never become interactive; the CLI opts in ---
const DOCTOR_SRC_TEXT = DOCTOR_ALL_SRC;
// the beginner-setup section is doctor/checks-setup.cjs from its banner up to its module.exports (WP A11 part 2)
const SETUP_SRC_TEXT = fs.readFileSync(path.join(__dirname, 'doctor', 'checks-setup.cjs'), 'utf8');
const bsStart = SETUP_SRC_TEXT.indexOf('// BEGINNER SETUP (wp17, 2026-09-24) — ADVISORY-ONLY');
const bsEnd = SETUP_SRC_TEXT.indexOf('module.exports = {');
const bsSection = bsStart > 0 && bsEnd > bsStart ? SETUP_SRC_TEXT.slice(bsStart, bsEnd) : '';
t('beginner setup static: the section was located in the doctor source (guards below are not vacuous)', bsSection.length > 2000, 'length=' + bsSection.length);
// N8 (2026-09-26 laptop re-audit): settingsTemplatePath() is now a DELIBERATE, reviewed exception — it
// reads os.homedir() to find the installer's own canonical template (`<home>/.claude/forge/template/.claude`,
// the exact path install.ps1/install.sh write), read-only, so settings-wired can run at all on an installer
// install (without it, settings-wired could never leave "note" on a real install — see its own header
// comment). The blanket guard below now carves OUT that one named function's own text and proves two things
// separately: (1) settingsTemplatePath() itself never writes anything, only checks existence/reads a path;
// (2) nothing ELSE in the beginner-setup section touches the home directory.
const settingsTemplatePathText = D.settingsTemplatePath.toString();
t('beginner setup static: settingsTemplatePath() is the one named exception, and it is read-only (existence checks only, never a write)', /homedir/.test(settingsTemplatePathText) && !/writeFile|mkdirSync|appendFile|rmSync|unlinkSync|rmdirSync/.test(settingsTemplatePathText), settingsTemplatePathText);
const bsSectionWithoutException = bsSection.split(settingsTemplatePathText).join('');
t('beginner setup static: no OTHER new code touches os.homedir() or a HOME/USERPROFILE variable', !/homedir|USERPROFILE|env\.HOME\b/.test(bsSectionWithoutException) && !/homedir/.test(D.installationProfile.toString()) && !/homedir/.test(D.readDevTreeMarker.toString()), 'exception text ' + (bsSection.includes(settingsTemplatePathText) ? 'found and removed' : 'NOT FOUND in bsSection — carve-out did not match'));
t('beginner setup static: every spawned tool gets stdin closed (ignore) — nothing can wait for a keypress', /stdio: \['ignore', 'pipe', 'pipe'\]/.test(bsSection) && (bsSection.match(/spawnSync\(/g) || []).length === 2);
t('beginner setup static: no shell:true anywhere in the section', !/shell:\s*true/.test(bsSection));
t('beginner setup static: the forge-doctor CLI is the caller that opts in to the claude doctor probe', /runDoctor\(root, \{ probeClaudeDoctor: true \}\)/.test(DOCTOR_SRC_TEXT));

// ---------------------------------------------------------------------------
// wp-v4 (sec-v3 L2, independent review) -- gateWatchdogHealth() used to check ONLY forge-gate-watchdog.cjs and
// claim the "full inspection pipeline runs watchdog-protected" from that alone. Now it resolves EVERY hook
// dependency file and runs the REAL forge-gate-hook.cjs end-to-end (a genuine spawned process) on a harmless
// command and a harmless destructive-SHAPED canary (never executed, only classified).
// ---------------------------------------------------------------------------
console.log('\ngateWatchdogHealth (wp-v4 sec-v3 L2)');

const GWH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-gwh-'));
const GWH_BIN = path.join(GWH_ROOT, '.claude', 'forge-bin');
fs.mkdirSync(GWH_BIN, { recursive: true });
for (const f of D.GATE_HOOK_DEPENDENCY_FILES) fs.copyFileSync(path.join(__dirname, f), path.join(GWH_BIN, f));
fs.copyFileSync(path.join(__dirname, 'forge-gate-classify-worker.cjs'), path.join(GWH_BIN, 'forge-gate-classify-worker.cjs'));

tFn('gateWatchdogHealth: a missing dependency file is reported (warn), names the exact file', () => {
  const victim = path.join(GWH_BIN, 'forge-gate-messages.cjs');
  const original = fs.readFileSync(victim, 'utf8');
  fs.unlinkSync(victim);
  try {
    const r = D.gateWatchdogHealth(GWH_ROOT);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.level, 'warn');
    assert.ok(/forge-gate-messages\.cjs/.test(r.detail), r.detail);
    assert.deepStrictEqual(r.missing, ['forge-gate-messages.cjs']);
  } finally {
    fs.writeFileSync(victim, original, 'utf8');
  }
});

tFn('gateWatchdogHealth: a present-but-syntactically-broken dependency file is reported (warn), distinct from missing', () => {
  const victim = path.join(GWH_BIN, 'forge-gate-selfdisable.cjs');
  const original = fs.readFileSync(victim, 'utf8');
  fs.writeFileSync(victim, 'this is not valid javascript {{{ syntax error', 'utf8');
  try {
    const r = D.gateWatchdogHealth(GWH_ROOT);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.level, 'warn');
    assert.ok(r.broken.some((b) => b.startsWith('forge-gate-selfdisable.cjs')), JSON.stringify(r.broken));
  } finally {
    fs.writeFileSync(victim, original, 'utf8');
  }
});

tFn('gateWatchdogHealth: the worker entry file is NEVER required directly (it would always fail loudly outside a real Worker) -- only checked for existence', () => {
  // sanity: loading it directly (as this check must NOT do) really does fail loudly, proving the exclusion is
  // load-bearing.: this used to `require(workerPath)` IN-PROCESS and assert.throws() on it,
  // which was true when this test was written -- but 's own fix (isMainThread guard, see the worker
  // file's own header) now makes a main-thread load print a friendly one-liner and call process.exit(1)
  // instead of throwing a catchable error. process.exit() cannot be caught by assert.throws(): calling
  // require() on this file in-process would silently kill the WHOLE test runner mid-suite, not fail one
  // assertion. Spawn it as a real child process instead, exactly like `node forge-gate-classify-worker.cjs`,
  // so the exit is observed safely.
  const workerPath = path.join(GWH_BIN, 'forge-gate-classify-worker.cjs');
  const r = require('child_process').spawnSync(process.execPath, [workerPath], { encoding: 'utf8', timeout: 5000 });
  assert.notStrictEqual(r.status, 0, 'running the worker file directly must never exit 0 (it must never be mistaken for a healthy standalone CLI): ' + JSON.stringify(r));
  assert.ok(/worker_threads entry point/.test(r.stderr), 'expected the friendly "library, not a CLI" message on stderr: ' + r.stderr);
  // yet the real health check, with every file genuinely present and healthy, still reaches "ok" (proven by the
  // end-to-end test below) -- i.e. it does not mistake the worker file's own direct-run exit for a real defect.
  assert.ok(!D.GATE_HOOK_DEPENDENCY_FILES.includes('forge-gate-classify-worker.cjs'), 'the worker entry file must not be in the direct-require list');
});

tFn('gateWatchdogHealth: end-to-end PASS (both canaries injected) -> ok:true, names the real classifier', () => {
  const spawnSyncImpl = (exe, args, opts) => {
    const input = JSON.parse(opts.input);
    const cmd = input.tool_input.command;
    if (/^echo /.test(cmd)) return { status: 0, stderr: '', error: null, signal: null };
    return { status: 2, stderr: 'FORGE GATE (destructive-delete): ...', error: null, signal: null };
  };
  const r = D.gateWatchdogHealth(GWH_ROOT, { spawnSyncImpl });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.real_classifier_engaged, true);
  assert.ok(/the real classifier/.test(r.detail), r.detail);
});

tFn('gateWatchdogHealth: end-to-end PASS via the fail-closed fallback (classifier-unavailable wording) -> ok:true, but names the fallback, not the real classifier', () => {
  const spawnSyncImpl = (exe, args, opts) => {
    const input = JSON.parse(opts.input);
    const cmd = input.tool_input.command;
    if (/^echo /.test(cmd)) return { status: 0, stderr: '', error: null, signal: null };
    return { status: 2, stderr: 'FORGE GATE (classifier-unavailable): ...', error: null, signal: null };
  };
  const r = D.gateWatchdogHealth(GWH_ROOT, { spawnSyncImpl });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.real_classifier_engaged, false);
  assert.ok(/fail-closed fallback/.test(r.detail), r.detail);
});

// FU-A7 (review medium): since FU-A7 a hook that cannot JUDGE a call still
// refuses it when it shows a hard-gate keyword (gate id cannot-judge-risky), so a BROKEN hook also gives the canary
// exit 2. That must read as unhealthy, never as "BLOCKED by the real classifier". The gate ids come from the first-line
// header only: the cannot-judge reason repeats keyword ids and the error text (here even "classifier-unavailable") later.
const GWH_CANNOT_JUDGE = 'FORGE GATE (cannot-judge-risky): Forge kan dit commando niet beoordelen en het lijkt riskant (destructive-delete; internal error (classifier-unavailable seam)), dus is het voor de zekerheid geweigerd; draai de doctor en probeer het daarna opnieuw. / Forge cannot judge this command and it looks risky (destructive-delete; internal error (classifier-unavailable seam)), so it was refused to be safe; run the doctor and try again.';
const gwhCanaryStub = (canaryStderr) => (exe, args, opts) => {
  const cmd = JSON.parse(opts.input).tool_input.command;
  if (/^echo /.test(cmd)) return { status: 0, stderr: '', error: null, signal: null };
  return { status: 2, stderr: canaryStderr, error: null, signal: null };
};
tFn('gateWatchdogHealth: a canary the hook could NOT judge (cannot-judge-risky, exit 2) -> warn, never "the real classifier" nor the fallback', () => {
  const r = D.gateWatchdogHealth(GWH_ROOT, { spawnSyncImpl: gwhCanaryStub(GWH_CANNOT_JUDGE) });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.level, 'warn');
  assert.strictEqual(r.real_classifier_engaged, false);
  assert.deepStrictEqual(r.canary_gates, ['cannot-judge-risky']);
  assert.ok(/could not judge/.test(r.detail) && !/BLOCKED \(exit 2\) by the real classifier/.test(r.detail), r.detail);
});
tFn('gateWatchdogHealth: a canary refused only as "too large / too slow to inspect" (command-too-large) -> warn, the classifier did not run', () => {
  const r = D.gateWatchdogHealth(GWH_ROOT, { spawnSyncImpl: gwhCanaryStub('FORGE GATE (command-too-large):\n- ...') });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.real_classifier_engaged, false);
  assert.deepStrictEqual(r.canary_gates, ['command-too-large']);
});
tFn('gateWatchdogHealth: REAL broken copy (forge-gate-messages.cjs loads, but its blockReason throws) -> warn, not "the real classifier"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-gwh-a7-'));
  try {
    const bin = path.join(root, '.claude', 'forge-bin');
    const cfgDir = path.join(root, '.claude', 'config', 'orchestration');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    for (const f of D.GATE_HOOK_DEPENDENCY_FILES.concat(['forge-gate-classify-worker.cjs'])) fs.copyFileSync(path.join(__dirname, f), path.join(bin, f));
    fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'hard-gates.json'), path.join(cfgDir, 'hard-gates.json'));
    fs.appendFileSync(path.join(bin, 'forge-gate-messages.cjs'), "\nmodule.exports.blockReason = () => { throw new Error('doctor-a7-broken-blockReason'); };\n", 'utf8');
    const r = D.gateWatchdogHealth(root);
    assert.strictEqual(r.harmless_exit, 0, 'the allow path never calls blockReason: ' + JSON.stringify(r));
    assert.strictEqual(r.canary_exit, 2, JSON.stringify(r));
    assert.strictEqual(r.ok, false, 'a hook that could not judge the canary is not healthy: ' + JSON.stringify(r));
    assert.strictEqual(r.real_classifier_engaged, false);
    assert.deepStrictEqual(r.canary_gates, ['cannot-judge-risky']);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
  }
});

tFn('gateWatchdogHealth: end-to-end FAIL when the harmless command does not exit 0 -> warn', () => {
  const spawnSyncImpl = () => ({ status: 1, stderr: 'boom', error: null, signal: null });
  const r = D.gateWatchdogHealth(GWH_ROOT, { spawnSyncImpl });
  assert.strictEqual(r.ok, false);
  assert.ok(/did NOT behave as expected/.test(r.detail), r.detail);
});

tFn('gateWatchdogHealth: end-to-end FAIL when the destructive-shaped canary is NOT blocked -> warn (the severe, doubly-failed case)', () => {
  const spawnSyncImpl = (exe, args, opts) => {
    const input = JSON.parse(opts.input);
    const cmd = input.tool_input.command;
    if (/^echo /.test(cmd)) return { status: 0, stderr: '', error: null, signal: null };
    return { status: 0, stderr: '', error: null, signal: null }; // canary NOT blocked -- the emergency case
  };
  const r = D.gateWatchdogHealth(GWH_ROOT, { spawnSyncImpl });
  assert.strictEqual(r.ok, false);
  assert.ok(/wanted 2, BLOCKED/.test(r.detail), r.detail);
});

tFn('gateWatchdogHealth: REAL end-to-end against the actual project (no injected spawnSyncImpl) reports ok:true, and never touches the real project config/once-store', () => {
  // sec-v3r M1 (independent re-review): this used to spawn the REAL hook with cwd pointed at the real project
  // root, which (via forge-config.cjs's own __dirname-relative default) made it read/write the REAL project's
  // FORGE_CONFIG.json and once-store on every doctor run -- risking spending a real pending owner one-off
  // approval on this canary. Snapshot both real config surfaces before/after and assert neither moved.
  const REAL_ROOT = path.resolve(__dirname, '..', '..');
  const REAL_CONFIG_DIR = path.join(REAL_ROOT, '.claude', 'config');
  const snapshot = () => {
    const out = {};
    (function walk(dir, prefix) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        const rel = prefix ? prefix + '/' + ent.name : ent.name;
        if (ent.isDirectory()) walk(full, rel);
        else { try { out[rel] = fs.statSync(full).mtimeMs + ':' + fs.statSync(full).size; } catch { out[rel] = 'unreadable'; } }
      }
    }(REAL_CONFIG_DIR, ''));
    return out;
  };
  const realOnceFilesOf = () => {
    try { return fs.readdirSync(path.join(REAL_ROOT, '.claude')).filter((f) => f.startsWith('FORGE_CONFIG')); }
    catch { return []; }
  };
  const before = snapshot();
  const onceBefore = realOnceFilesOf();
  const r = D.gateWatchdogHealth(REAL_ROOT);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.harmless_exit, 0);
  assert.strictEqual(r.canary_exit, 2);
  assert.deepStrictEqual(snapshot(), before, 'gateWatchdogHealth must never modify the real project .claude/config directory');
  assert.deepStrictEqual(realOnceFilesOf(), onceBefore, 'gateWatchdogHealth must never create/touch a real FORGE_CONFIG* file at the project root');
});

tFn('gateWatchdogHealth: an isolated copy with a PENDING one-off grant is recognised as not-clean and the canary is skipped, leaving the grant unspent', () => {
  const isolated = D.buildIsolatedGateProject();
  try {
    const CFG = require(path.join(__dirname, 'forge-config.cjs'));
    const onceStore = require(path.join(__dirname, 'forge-config-once-store.cjs'));
    CFG.set('gate-hook', 'off', { once: 'test owner approval quote', projectRoot: isolated.root, configHome: isolated.home });
    const pendingPath = onceStore.oncePendingPath(path.join(isolated.root, '.claude'), 'gate-hook');
    assert.ok(fs.existsSync(pendingPath), 'test setup: the once-grant must be armed before the check runs');
    const r = D.gateWatchdogHealth(GWH_ROOT, { isolated });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(/skipped the destructive-shaped canary/.test(r.detail), r.detail);
    assert.ok(fs.existsSync(pendingPath), 'the one-off grant must still be pending (unspent) after the health check ran');
  } finally {
    isolated.cleanup();
  }
});

tFn('gateWatchdogHealth: an isolated copy that is persistently OFF (no once-grant) is also recognised as not-clean and the canary is skipped', () => {
  const isolated = D.buildIsolatedGateProject();
  try {
    const CFG = require(path.join(__dirname, 'forge-config.cjs'));
    CFG.set('gate-hook', 'off', { projectRoot: isolated.root, configHome: isolated.home });
    const r = D.gateWatchdogHealth(GWH_ROOT, { isolated });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(/skipped the destructive-shaped canary/.test(r.detail), r.detail);
  } finally {
    isolated.cleanup();
  }
});

tFn('printSummary: renders the gate-watchdog-health line as advisory, ok as a green check', () => {
  // this fixture never set rep.ok — printSummary's ALL GREEN/FAILURES ABOVE verdict line
  // reads rep.ok directly (forge-doctor.cjs's own printSummary, near the end), it is NOT derived from the
  // `checks` object here. This test's own assertion never looked at the verdict line, so the gap was silent;
  // fixed here so this fixture is honest even though the gap did not fail this specific assertion.
  const rep = { root: GWH_ROOT, ok: true, checks: { node_check: { ok: true, total: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [] }, strict_events: { ok: true }, dashboard_spa: { ok: true, present: [] }, leak_scan: D.leakScan(GWH_ROOT) }, advisory: { gate_watchdog_health: { ok: true, detail: 'the real hook was run end-to-end: a harmless command exited 0, and a harmless destructive-SHAPED canary (never executed, only classified) was BLOCKED (exit 2) by the real classifier' } } };
  const out = D.printSummary(rep);
  assert.ok(/✓ gate watchdog health \(advisory\): the real hook was run end-to-end/.test(out), out);
});
tFn('printSummary: renders the gate-watchdog-health line as a visible, non-blocking warn when degraded', () => {
  // same fixture gap as above -- rep.ok was never set, so `/⇒ ALL GREEN/` below could
  // never have matched (printSummary reads rep.ok directly, never derives it from `checks`), regardless of
  // whether the advisory warn itself correctly stays out of the verdict. This test only became real once
  // tFn actually invoked the callback; ok:true here is what the fixture always meant to assert against.
  const rep = { root: GWH_ROOT, ok: true, checks: { node_check: { ok: true, total: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [] }, strict_events: { ok: true }, dashboard_spa: { ok: true, present: [] }, leak_scan: D.leakScan(GWH_ROOT) }, advisory: { gate_watchdog_health: { ok: false, detail: '1 hook dependency file(s) missing from X: forge-gate-messages.cjs' } } };
  const out = D.printSummary(rep);
  assert.ok(/⚠ gate watchdog health \(advisory, non-blocking\): 1 hook dependency/.test(out), out);
  assert.ok(/⇒ ALL GREEN/.test(out), 'an advisory warn alone must never flip the overall verdict: ' + out);
});

// --- printSummary: command_center_location — ALWAYS printed (like context budget), never
// a ✗, never part of the ALL GREEN/FAILURES verdict even when 'not-installed' (the ordinary case). ---
const CCL_PS_BASE_CHECKS = { node_check: { ok: true, total: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [] }, strict_events: { ok: true }, dashboard_spa: { ok: true, present: [] }, leak_scan: D.leakScan(GWH_ROOT) };
tFn('printSummary: command_center_location renders "not-installed" as an info line (ℹ), never a warn, and never flips the verdict', () => {
  const rep = { root: GWH_ROOT, ok: true, checks: CCL_PS_BASE_CHECKS, advisory: { command_center_location: { ok: true, location: 'not-installed', path: null } } };
  const out = D.printSummary(rep);
  assert.ok(/ℹ command center \(advisory\): not installed for this project/.test(out), out);
  assert.ok(!/⚠ command center/.test(out), 'not-installed must never render as a warning: ' + out);
  assert.ok(/⇒ ALL GREEN/.test(out), out);
});
tFn('printSummary: command_center_location renders "project-local" as a green line naming the real path', () => {
  const rep = { root: GWH_ROOT, ok: true, checks: CCL_PS_BASE_CHECKS, advisory: { command_center_location: { ok: true, location: 'project-local', path: path.join(GWH_ROOT, 'command-center') } } };
  const out = D.printSummary(rep);
  assert.ok(/✓ command center \(advisory\): project-local at /.test(out), out);
  assert.ok(out.includes(path.join(GWH_ROOT, 'command-center')), out);
});
tFn('printSummary: command_center_location renders "central" as a green line naming the real path', () => {
  const centralPath = path.join(GWH_ROOT, '.claude', 'forge', 'template', 'command-center');
  const rep = { root: GWH_ROOT, ok: true, checks: CCL_PS_BASE_CHECKS, advisory: { command_center_location: { ok: true, location: 'central', path: centralPath } } };
  const out = D.printSummary(rep);
  assert.ok(/✓ command center \(advisory\): central \(shared\) install at /.test(out), out);
  assert.ok(out.includes(centralPath), out);
});

// =====================================================================================================
// release_exclusions (prd-w2-discipline M2) — ENFORCED check wrapping
// forge-release-check.cjs. Uses D.releaseExclusionsCheck(root, {configPath}) directly, the same
// per-check direct-call convention as D.skillEvalsDoctorCheck()/D.runContractDoctorCheck() above —
// configPath is a TEST-ONLY injection point (see the doc comment on releaseExclusionsCheck()) so these
// fixtures never touch the real, shared release-exclusions.json.
// =====================================================================================================
const RE_REAL_CONFIG = path.join(REAL_ROOT, '.claude', 'config', 'orchestration', 'release-exclusions.json');

function reFreshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function reWriteDistMarkers(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'install.sh'), '#!/bin/sh\necho install\n');
  fs.writeFileSync(path.join(root, 'install.ps1'), '# install\n');
  fs.mkdirSync(path.join(root, 'plugins', 'forge', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', 'forge', '.claude-plugin', 'plugin.json'), '{}');
}
function reGit(cwd, ...args) { return require('child_process').spawnSync('git', args, { cwd, encoding: 'utf8' }); }
function reMakeGitRoot(prefix) {
  const dir = reFreshRoot(prefix);
  reGit(dir, 'init', '-q');
  reGit(dir, 'config', 'user.email', 'test@example.com');
  reGit(dir, 'config', 'user.name', 'Test');
  return dir;
}
function reCommitAll(dir, msg) { reGit(dir, 'add', '-A'); return reGit(dir, 'commit', '-q', '-m', msg); }
function reHeadLooksReal(dir) {
  const r = reGit(dir, 'rev-parse', 'HEAD');
  return !r.error && r.status === 0 && /^[0-9a-f]{7,40}$/i.test((r.stdout || '').trim());
}

// --- a broken config fails the check (bad JSON) ---
{
  const dir = reFreshRoot('forge-doctor-re-badconfig');
  const badConfig = path.join(dir, 'bad.json');
  fs.writeFileSync(badConfig, '{ not valid json', 'utf8');
  const res = D.releaseExclusionsCheck(dir, { configPath: badConfig });
  t('release_exclusions: a broken (invalid JSON) config fails the check', res.ok === false, JSON.stringify(res));
  t('release_exclusions: the reason names the real failure', /release-exclusions config/.test(res.reason || ''), res.reason);
}

// --- a config with a pattern that does not compile fails the check ---
{
  const dir = reFreshRoot('forge-doctor-re-badpattern');
  const badConfig = path.join(dir, 'badpattern.json');
  fs.writeFileSync(badConfig, JSON.stringify({ schema: 'x', sync_folders: [], never_sync: ['[unterminated'], dist_forbidden: [] }), 'utf8');
  const res = D.releaseExclusionsCheck(dir, { configPath: badConfig });
  t('release_exclusions: a pattern that does not compile fails the check', res.ok === false, JSON.stringify(res));
}

// --- the real shipped config, in an ordinary (non-distribution) temp root, passes with counts and never
// runs the (expensive/inapplicable) dist check ---
{
  const dir = reFreshRoot('forge-doctor-re-ordinary');
  const res = D.releaseExclusionsCheck(dir, { configPath: RE_REAL_CONFIG });
  t('release_exclusions: an ordinary (non-distribution-shaped) root passes', res.ok === true, JSON.stringify(res));
  t('release_exclusions: the dist check is skipped for a non-distribution root', res.dist_checked === false);
  t('release_exclusions: pattern_counts are reported even when the dist check is skipped', !!res.pattern_counts && res.pattern_counts.dist_forbidden > 0, JSON.stringify(res.pattern_counts));
  t('release_exclusions: the reason explains why the dist check was skipped', /dist check skipped/.test(res.reason || ''), res.reason);
}

// --- the dev tree itself (this real project root) passes with counts, dist check skipped ---
// 2026-10-10 (fresh-repo verification): in the public repository this root IS distribution-shaped, so the dist
// check legitimately runs there — the two assertions describe the development tree only and are visibly skipped
// (with the dev-tree marker's reason) anywhere else, never silently green and never a false red in that repo's CI.
devTreeOnly('release_exclusions: the development tree passes and does not run the dist check', () => {
  const res = D.releaseExclusionsCheck(REAL_ROOT, { configPath: RE_REAL_CONFIG });
  t('release_exclusions: the development tree passes (not a distribution-shaped root)', res.ok === true, JSON.stringify(res));
  t('release_exclusions: the development tree does not run the dist check', res.dist_checked === false);
});

// --- distribution-shaped root (git-fixture): a tracked forbidden file fails it; without it, passes ---
const RE_PROBE = reMakeGitRoot('forge-doctor-re-probe');
reWriteDistMarkers(RE_PROBE);
fs.writeFileSync(path.join(RE_PROBE, 'readme.md'), '# ok\n');
reCommitAll(RE_PROBE, 'seed');
if (!reHeadLooksReal(RE_PROBE)) {
  console.log('  SKIP release_exclusions distribution-repo scenarios: could not establish a real HEAD (git unavailable here)');
} else {
  // distribution-shaped + a tracked forbidden file -> fails
  {
    const dir = reMakeGitRoot('forge-doctor-re-dist-bad');
    reWriteDistMarkers(dir);
    fs.mkdirSync(path.join(dir, '.claude', 'forge-research'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'forge-research', 'x.md'), 'private\n');
    fs.writeFileSync(path.join(dir, 'readme.md'), '# ok\n');
    reCommitAll(dir, 'add forbidden file');
    const res = D.releaseExclusionsCheck(dir, { configPath: RE_REAL_CONFIG });
    t('release_exclusions: a distribution-shaped root with a tracked forbidden file fails the check', res.ok === false, JSON.stringify(res));
    t('release_exclusions: the dist check genuinely ran', res.dist_checked === true);
    t('release_exclusions: the violation names the forbidden path', (res.reason || '').includes('forge-research/x.md'), res.reason);
  }
  // the SAME distribution-shaped root WITHOUT that file -> passes
  {
    const dir = reMakeGitRoot('forge-doctor-re-dist-good');
    reWriteDistMarkers(dir);
    fs.writeFileSync(path.join(dir, 'readme.md'), '# ok\n');
    reCommitAll(dir, 'clean distribution tree');
    const res = D.releaseExclusionsCheck(dir, { configPath: RE_REAL_CONFIG });
    t('release_exclusions: a clean distribution-shaped root passes the check', res.ok === true, JSON.stringify(res));
    t('release_exclusions: the dist check genuinely ran on the clean tree too', res.dist_checked === true);
  }
  // an installed-project-shaped root (no install.sh/.ps1/plugin.json) with tracked forge-runs -> passes,
  // dist check skipped (this project's OWN run logs/memory are legitimate, not a distribution leak)
  {
    const dir = reMakeGitRoot('forge-doctor-re-installed');
    fs.mkdirSync(path.join(dir, '.claude', 'forge-runs', 'some-run'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'forge-runs', 'some-run', 'events.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'readme.md'), '# ok\n');
    reCommitAll(dir, 'installed project with its own run history');
    const res = D.releaseExclusionsCheck(dir, { configPath: RE_REAL_CONFIG });
    t('release_exclusions: an installed-project-shaped root with tracked forge-runs still passes', res.ok === true, JSON.stringify(res));
    t('release_exclusions: the dist check is skipped for the installed-project-shaped root', res.dist_checked === false);
  }
}

// --- an enumeration failure in checkDist() must surface at the doctor level too
// — ok:false with a reason naming the real failure, never read as "0 forbidden paths tracked" (which looks
// clean-ish and hides the real problem). Uses releaseExclusionsCheck's test-only `distCheckOpts` passthrough
// (same posture as `configPath`) to inject a fake git failure without corrupting a real repository. ---
if (!reHeadLooksReal(RE_PROBE)) {
  console.log('  SKIP release_exclusions enumeration-failure propagation: could not establish a real HEAD (git unavailable here)');
} else {
  const dir = reMakeGitRoot('forge-doctor-re-enumfail');
  reWriteDistMarkers(dir);
  fs.writeFileSync(path.join(dir, 'readme.md'), '# ok\n');
  reCommitAll(dir, 'seed');
  const fakeSpawn = (cmd, args) => {
    if (args[0] === 'rev-parse') return { status: 128, stdout: '', stderr: 'fatal: unable to read config file .git/config\n', error: null };
    throw new Error('unexpected spawn call: ' + args.join(' '));
  };
  const res = D.releaseExclusionsCheck(dir, { configPath: RE_REAL_CONFIG, distCheckOpts: { spawn: fakeSpawn } });
  t('release_exclusions: a real git enumeration failure fails the doctor check (ok:false)', res.ok === false, JSON.stringify(res));
  t('release_exclusions: the dist check genuinely attempted to run', res.dist_checked === true, JSON.stringify(res));
  t('release_exclusions: the reason names the real enumeration failure, not a bogus "0 forbidden paths"', /enumerat|git/i.test(res.reason || '') && !/^0 forbidden/.test(res.reason || ''), res.reason);
}

// --- wired into runDoctor(): a missing config degrades the WHOLE doctor to ok:false (ENFORCED, not advisory) ---
tFn('runDoctor: release_exclusions is wired into the top-level ENFORCED `checks`, not `advisory`', () => {
  const rep = D.runDoctor(GREEN_ROOT);
  assert.ok(rep.checks.release_exclusions, 'checks.release_exclusions must exist');
  assert.strictEqual(rep.checks.release_exclusions.ok, true, JSON.stringify(rep.checks.release_exclusions));
  assert.strictEqual(rep.checks.release_exclusions.dist_checked, false, 'GREEN_ROOT is not distribution-shaped');
});

// =====================================================================================================
// ship_manifest — ENFORCED in the development
// tree (the forge-dev-tree.json marker), n/a everywhere else (a synced project would otherwise get a
// "new + red" check, which forge-sync's regressionCheck treats as a regression). Fixtures use the test-only
// shipcheckOpts passthrough (files/delivered injection) so they never depend on the real forge-sync list.
// =====================================================================================================
const SM_REAL_MANIFEST = path.join(REAL_ROOT, '.claude', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json');
function smRoot(prefix, files, devTree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const all = Object.assign({}, files || {});
  if (devTree) all['.claude/config/forge-dev-tree.json'] = '{"dev_tree": true}\n';
  for (const [rel, body] of Object.entries(all)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}
const SM_MANIFEST = JSON.stringify({
  schema: 'forge-ship-manifest/v1',
  rules: [
    { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'toolkit' },
    { pattern: '.claude/config/**', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'config' },
    { pattern: '.claude/config/forge-dev-tree.json', class: 'local-only', channels: [], ref_ok: 'probed', reason: 'marker' },
    // a consistent manifest keeps the protected config paths out of every channel (as the real one does)
    { pattern: '.claude/config/{forge-owner-grant*,forge-usage-guard-override-grant.json}', class: 'per-project', channels: [], reason: 'owner secrets' },
    { pattern: '.claude/config/**/*.user.json', class: 'per-project', channels: [], reason: 'per-installation user state' },
  ],
  known_gaps: [],
});
const SM_FILES = { '.claude/forge-bin/a.cjs': "'use strict';\n", '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json': SM_MANIFEST };
const SM_DELIVERED = ['forge-bin/a.cjs', 'config/orchestration/FORGE_SHIP_MANIFEST.json'];
const smOpts = (root, extra) => ({ shipcheckOpts: Object.assign({ files: (function list() { const out = []; (function w(rel) { for (const e of fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) w(r); else out.push(r); } })(''); return out; })(), delivered: SM_DELIVERED, seedDelivered: [] }, extra || {}) });

t('ship_manifest: runDoctor() wires checks.ship_manifest through applyDoctorOverride(shipManifestCheck(root))',
  new RegExp('ship_manifest:' + ROW + String.raw`applyDoctorOverride\(overrideMap,\s*'ship_manifest',\s*shipManifestCheck\(root\)\)`).test(DOCTOR_ALL_SRC));
tFn('ship_manifest: GREEN fixture (not the dev tree, no manifest) -> applicable:false, ok:true, "n/a" on its summary line', () => {
  const sm = greenRep.checks.ship_manifest;
  assert.ok(sm, 'checks.ship_manifest must exist');
  assert.strictEqual(sm.ok, true, JSON.stringify(sm));
  assert.strictEqual(sm.applicable, false);
  assert.ok(/ship manifest\s+n\/a/.test(D.printSummary(greenRep)), D.printSummary(greenRep));
});
tFn('ship_manifest: a synced-project-shaped root carrying the REAL manifest -> n/a but the manifest shape is validated', () => {
  const root = smRoot('forge-doctor-sm-synced', { '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json': fs.readFileSync(SM_REAL_MANIFEST, 'utf8') }, false);
  const sm = D.shipManifestCheck(root);
  assert.strictEqual(sm.ok, true, JSON.stringify(sm));
  assert.strictEqual(sm.applicable, false);
  assert.ok(/manifest loads \(\d+ rules\)/.test(sm.reason), sm.reason);
});
tFn('ship_manifest: a synced project with a BROKEN shipped manifest fails (a broken manifest never lands quietly)', () => {
  const root = smRoot('forge-doctor-sm-broken', { '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json': '{ "schema": "forge-ship-manifest/v1", "rules": [ { "pattern": ".claude/**", "class": "per-project", "channels": [], "reason": "x" } ] }' }, false);
  const sm = D.shipManifestCheck(root);
  assert.strictEqual(sm.ok, false, JSON.stringify(sm));
  assert.ok(/does not load/.test(sm.reason) && /catch-all/.test(sm.reason), sm.reason);
});
tFn('ship_manifest: a consistent development-tree fixture passes (applicable:true)', () => {
  const root = smRoot('forge-doctor-sm-devgreen', SM_FILES, true);
  const sm = D.shipManifestCheck(root, smOpts(root));
  assert.strictEqual(sm.applicable, true);
  assert.strictEqual(sm.ok, true, JSON.stringify(sm.failures));
  assert.ok(sm.sources >= 3 && sm.by_class['ship-sync'] === 2, JSON.stringify(sm));
});
tFn('ship_manifest: an unclassified path in the development tree fails the check and names it', () => {
  const root = smRoot('forge-doctor-sm-devred', Object.assign({ '.claude/stray.md': 'x' }, SM_FILES), true);
  const sm = D.shipManifestCheck(root, smOpts(root));
  assert.strictEqual(sm.ok, false);
  assert.ok(sm.failures.some((f) => f.kind === 'unclassified' && f.path === '.claude/stray.md'), JSON.stringify(sm.failures));
});
tFn('ship_manifest: forge-sync drift in the development tree fails (manifest ship-sync, not delivered)', () => {
  const root = smRoot('forge-doctor-sm-drift', SM_FILES, true);
  const sm = D.shipManifestCheck(root, smOpts(root, { delivered: ['config/orchestration/FORGE_SHIP_MANIFEST.json'] }));
  assert.strictEqual(sm.ok, false);
  assert.ok(sm.failures.some((f) => f.kind === 'sync_not_delivered' && f.path === '.claude/forge-bin/a.cjs'), JSON.stringify(sm.failures));
});
tFn('ship_manifest: a known gap turns exactly that violation into a warning with its owner WP — and the summary line says so', () => {
  const m = JSON.parse(SM_MANIFEST);
  m.known_gaps.push({ id: 'KG-T', kinds: ['sync_not_delivered'], paths: ['.claude/forge-bin/a.cjs'], owner_wp: 'WP-2b', reason: 'fixture' });
  const root = smRoot('forge-doctor-sm-gap', Object.assign({}, SM_FILES, { '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json': JSON.stringify(m) }), true);
  const sm = D.shipManifestCheck(root, smOpts(root, { delivered: ['config/orchestration/FORGE_SHIP_MANIFEST.json'] }));
  assert.strictEqual(sm.ok, true, JSON.stringify(sm.failures));
  assert.ok(sm.warnings.length === 1 && sm.warnings[0].owner_wp === 'WP-2b', JSON.stringify(sm.warnings));
  const out = D.printSummary({ root, ok: true, checks: Object.assign({}, greenRep.checks, { ship_manifest: sm }), advisory: {} });
  assert.ok(/✓ ship manifest\s+.*known-gap warnings: KG-T→WP-2b ×1/.test(out), out);
});
tFn('ship_manifest: the development tree WITHOUT forge-shipcheck.cjs beside the doctor fails closed (never a silent pass)', () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-sm-iso-'));
  fs.copyFileSync(path.join(__dirname, 'forge-store.cjs'), path.join(iso, 'forge-store.cjs'));
  copyDoctorInto(iso);
  const isoDoctor = require(path.join(iso, 'forge-doctor.cjs'));
  const root = smRoot('forge-doctor-sm-nomod', SM_FILES, true);
  const sm = isoDoctor.shipManifestCheck(root);
  assert.strictEqual(sm.ok, false, JSON.stringify(sm));
  assert.ok(/not available/.test(sm.reason), sm.reason);
  const plain = isoDoctor.shipManifestCheck(GREEN_ROOT);
  assert.strictEqual(plain.ok, true, 'outside the dev tree a missing module stays n/a: ' + JSON.stringify(plain));
});
{
  // the WHOLE doctor: a GREEN_ROOT copy turned into a dev tree whose manifest misclassifies -> doctor.ok false
  // because of ship_manifest alone (every other check stays green), and an owner override passes it VISIBLY.
  const SM_DOC = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-sm-full-'));
  fs.cpSync(GREEN_ROOT, SM_DOC, { recursive: true });
  fs.mkdirSync(path.join(SM_DOC, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.writeFileSync(path.join(SM_DOC, '.claude', 'config', 'forge-dev-tree.json'), '{"dev_tree": true}\n');
  fs.writeFileSync(path.join(SM_DOC, '.claude', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json'), SM_MANIFEST);
  // the dev-tree marker makes feature_registry enforced here too, so the fixture gets its registry
  const RG = require('./forge-registry-gen.cjs');
  fs.writeFileSync(path.join(SM_DOC, '.claude', 'config', 'orchestration', 'FORGE_FEATURE_REGISTRY.json'), JSON.stringify(RG.genFeatureRegistry(SM_DOC, null).data, null, 2));
  const rep = D.runDoctor(SM_DOC);
  const others = Object.entries(rep.checks).filter(([k, c]) => k !== 'ship_manifest' && !c.ok).map(([k]) => k);
  t('ship_manifest: a real ship-manifest violation turns the WHOLE doctor red (and is the only red check)', rep.ok === false && rep.checks.ship_manifest.ok === false && others.length === 0, 'others red: ' + others.join(',') + ' · ' + JSON.stringify((rep.checks.ship_manifest.failures || []).slice(0, 3)));
  t('ship_manifest: printSummary names the violation on a ✗ line', /✗ ship manifest\s+\d+ violation\(s\): /.test(D.printSummary(rep)));
  fs.writeFileSync(path.join(SM_DOC, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({ doctor_check_overrides: [{ check: 'ship_manifest', reason: 'fixture: owner accepted a temporary ship gap', by: 'test' }] }));
  const ov = D.runDoctor(SM_DOC);
  t('ship_manifest: an owner override passes it VISIBLY ([OVERRIDDEN ...] tag), never silently', ov.checks.ship_manifest.ok === true && ov.checks.ship_manifest.overridden === true && /ship manifest.*\[OVERRIDDEN by test/.test(D.printSummary(ov)));
}
pinned('ship_manifest: the REAL development tree passes, applicable, in under 5 s', () => {
  const sm = D.shipManifestCheck(REAL_ROOT);
  t('ship_manifest (real tree): applicable and ok — every violation is a recorded known gap', sm.applicable === true && sm.ok === true, JSON.stringify((sm.failures || []).slice(0, 5)));
  t('ship_manifest (real tree): finishes in under 5 s', typeof sm.ms === 'number' && sm.ms < 5000, 'ms=' + sm.ms);
  t('ship_manifest (real tree): no stale known gaps', (sm.stale_known_gaps || []).length === 0, JSON.stringify(sm.stale_known_gaps));
});

// =====================================================================================================
// + part ii: feature_registry and
// skill_frontmatter (ENFORCED in the development tree only) + scribe_wiring / unpublished / structure /
// always_loaded_budget (advisory). Every fixture is a throwaway temp root; the real tree is only READ.
// =====================================================================================================
const RGEN = require('./forge-registry-gen.cjs');
const DOC_SRC = DOCTOR_ALL_SRC;
function wf(root, rel, text) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function frRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  wf(root, '.claude/config/forge-dev-tree.json', '{"dev_tree": true}\n');
  wf(root, '.claude/commands/forge.md', 'Run `node .claude/forge-bin/flow.cjs` at step 1.\n');
  wf(root, '.claude/forge-bin/flow.cjs', "'use strict';\nrequire('./helper');\n");
  wf(root, '.claude/forge-bin/helper.cjs', "'use strict';\n");
  wf(root, '.claude/forge-bin/lonely.cjs', "'use strict';\n");
  wf(root, '.claude/skills/forge-one/SKILL.md', '---\nname: forge-one\ndescription: "Forge one: does one thing."\n---\nbody\n');
  return root;
}
const writeReg = (root, mutate) => {
  const data = RGEN.genFeatureRegistry(root, null).data;
  if (mutate) mutate(data);
  wf(root, '.claude/config/orchestration/FORGE_FEATURE_REGISTRY.json', JSON.stringify(data, null, 2));
  return data;
};
const regEntry = (data, id) => data.features.find((f) => f.id === id);

t('feature_registry: runDoctor() wires checks.feature_registry through applyDoctorOverride(featureRegistryCheck(root))',
  new RegExp('feature_registry:' + ROW + String.raw`applyDoctorOverride\(overrideMap,\s*'feature_registry',\s*featureRegistryCheck\(root\)\)`).test(DOC_SRC));
t('skill_frontmatter: runDoctor() wires checks.skill_frontmatter through applyDoctorOverride(skillFrontmatterCheck(root))',
  new RegExp('skill_frontmatter:' + ROW + String.raw`applyDoctorOverride\(overrideMap,\s*'skill_frontmatter',\s*skillFrontmatterCheck\(root\)\)`).test(DOC_SRC));
tFn('feature_registry: GREEN fixture (not the dev tree) -> applicable:false, ok:true, "n/a" on its summary line', () => {
  const fr = greenRep.checks.feature_registry;
  assert.ok(fr && fr.ok === true && fr.applicable === false, JSON.stringify(fr));
  assert.ok(/feature registry\s+n\/a/.test(D.printSummary(greenRep)), D.printSummary(greenRep));
  assert.strictEqual(greenRep.checks.skill_frontmatter.ok, true, JSON.stringify(greenRep.checks.skill_frontmatter));
});
tFn('feature_registry: RED before the classification — a dev tree with tools but no registry names the gap and the fix', () => {
  const root = frRoot('fd-fr-none');
  const fr = D.featureRegistryCheck(root);
  assert.strictEqual(fr.ok, false, JSON.stringify(fr));
  assert.ok(/FORGE_FEATURE_REGISTRY\.json is missing/.test(fr.reason) && fr.missing.includes('tool:lonely.cjs') && /feature-registry --write/.test(fr.fix), JSON.stringify(fr));
});
tFn('feature_registry: GREEN after the classification — the generated registry passes with real counts (dormant is never red)', () => {
  const root = frRoot('fd-fr-green');
  writeReg(root);
  const fr = D.featureRegistryCheck(root);
  assert.strictEqual(fr.ok, true, fr.reason);
  assert.deepStrictEqual([fr.counts.tool.wired, fr.counts.tool.dormant, fr.counts.skill['on-request']], [2, 1, 1]);
  const out = D.printSummary({ root, ok: true, checks: Object.assign({}, greenRep.checks, { feature_registry: fr }), advisory: {} });
  assert.ok(/✓ feature registry\s+4 entries · tools 2 wired \/ 0 on-request \/ 1 dormant/.test(out), out);
});
tFn('feature_registry: a NEW tool on disk that nobody registered turns it red with its exact name', () => {
  const root = frRoot('fd-fr-new');
  writeReg(root);
  wf(root, '.claude/forge-bin/brand-new.cjs', "'use strict';\n");
  const fr = D.featureRegistryCheck(root);
  assert.ok(fr.ok === false && fr.missing.includes('tool:brand-new.cjs') && /not registered: tool:brand-new\.cjs/.test(fr.reason), JSON.stringify(fr));
});
tFn('feature_registry: a registered tool whose file is gone is red; a retired entry without a file is not', () => {
  const root = frRoot('fd-fr-gone');
  writeReg(root, (d) => d.features.push({ id: 'old-ui.cjs', kind: 'tool', status: 'retired', invoked_by: [], consumer: '-', replacement: 'the Command Center' }));
  assert.strictEqual(D.featureRegistryCheck(root).ok, true, 'a retired entry without a file must stay green');
  fs.rmSync(path.join(root, '.claude', 'forge-bin', 'lonely.cjs'));
  const fr = D.featureRegistryCheck(root);
  assert.ok(fr.ok === false && fr.gone.includes('tool:lonely.cjs') && !fr.gone.includes('tool:old-ui.cjs'), JSON.stringify(fr));
});
tFn('feature_registry: a WIRED tool that lost its caller is red (now dormant) and the ✗ line names it + the fix', () => {
  const root = frRoot('fd-fr-unwired');
  writeReg(root);
  wf(root, '.claude/commands/forge.md', 'nothing runs a tool any more\n');
  const fr = D.featureRegistryCheck(root);
  assert.ok(fr.ok === false && fr.wired_without_caller.some((x) => x.id === 'tool:flow.cjs' && x.now === 'dormant'), JSON.stringify(fr.wired_without_caller));
  const out = D.printSummary({ root, ok: false, checks: Object.assign({}, greenRep.checks, { feature_registry: fr }), advisory: {} });
  assert.ok(/✗ feature registry\s+.*marked wired with no wired caller now: tool:flow\.cjs \(now dormant\).*fix: node \.claude\/forge-bin\/forge-registry-gen\.cjs feature-registry --write/.test(out), out);
});
tFn('feature_registry: dormant/on-request entries are never red — a stale classification and a dormant without a note are warnings', () => {
  const root = frRoot('fd-fr-stale');
  writeReg(root, (d) => { regEntry(d, 'flow.cjs').status = 'on-request'; delete regEntry(d, 'lonely.cjs').note; });
  const fr = D.featureRegistryCheck(root);
  assert.strictEqual(fr.ok, true, fr.reason);
  assert.ok(fr.stale.some((s) => s.id === 'tool:flow.cjs' && s.now === 'wired') && fr.dormant_without_note.includes('tool:lonely.cjs'), JSON.stringify(fr));
  const out = D.printSummary({ root, ok: true, checks: Object.assign({}, greenRep.checks, { feature_registry: fr }), advisory: {} });
  assert.ok(/✓ feature registry.*1 stale classification\(s\) — regenerate · 1 dormant without a note/.test(out), out);
});
tFn('feature_registry: an invalid entry or unparseable JSON is red; a missing generator module in the dev tree fails closed', () => {
  const root = frRoot('fd-fr-bad');
  writeReg(root, (d) => d.features.push({ id: 'x.cjs', kind: 'tool', status: 'retired', invoked_by: [] }));
  const bad = D.featureRegistryCheck(root);
  assert.ok(bad.ok === false && bad.invalid.some((p) => /replacement/.test(p)), JSON.stringify(bad));
  wf(root, '.claude/config/orchestration/FORGE_FEATURE_REGISTRY.json', '{ nope');
  assert.ok(/does not load/.test(D.featureRegistryCheck(root).reason));
  const nomod = D.featureRegistryCheck(root, { regGen: null });
  assert.ok(nomod.ok === false && /not available/.test(nomod.reason), JSON.stringify(nomod));
});
tFn('feature_registry: a wired entry whose recorded caller is the Command Center is unverifiable (not red) when command-center/ is absent', () => {
  const root = frRoot('fd-fr-gw');
  wf(root, '.claude/forge-bin/gwonly.cjs', "'use strict';\n");
  writeReg(root, (d) => { const e = regEntry(d, 'gwonly.cjs'); e.status = 'wired'; e.invoked_by = ['command-center/gateway/src/x.mjs (code:gateway:spawn)']; });
  const fr = D.featureRegistryCheck(root);
  assert.ok(fr.ok === true && fr.unverifiable.includes('tool:gwonly.cjs') && fr.gateway_scanned === false, JSON.stringify(fr));
});
{
  // a GREEN_ROOT copy turned into a dev tree with its registry: the set of red checks before vs after one new,
  // unregistered tool differs by exactly feature_registry — so that check alone is what flips the verdict.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-fr-full-'));
  fs.cpSync(GREEN_ROOT, root, { recursive: true });
  wf(root, '.claude/config/forge-dev-tree.json', '{"dev_tree": true}\n');
  writeReg(root);
  const redOf = (r) => Object.entries(r.checks).filter(([, c]) => !c.ok).map(([k]) => k).sort();
  const before = D.runDoctor(root);
  wf(root, '.claude/forge-bin/brand-new.cjs', "'use strict';\n");
  const rep = D.runDoctor(root);
  t('feature_registry: green on the registered dev-tree copy', before.checks.feature_registry.ok === true && !redOf(before).includes('feature_registry'));
  t('feature_registry: one unregistered tool turns the WHOLE doctor red, and feature_registry is the only check that changed',
    rep.ok === false && rep.checks.feature_registry.ok === false && JSON.stringify(redOf(rep)) === JSON.stringify(redOf(before).concat(['feature_registry']).sort()));
  wf(root, '.claude/config/orchestration/FORGE_HARD_RULES.json', JSON.stringify({ doctor_check_overrides: [{ check: 'feature_registry', reason: 'fixture: owner accepted a temporary gap', by: 'test' }] }));
  const ov = D.runDoctor(root);
  t('feature_registry: an owner override passes it VISIBLY ([OVERRIDDEN ...] tag), never silently', ov.checks.feature_registry.ok === true && ov.checks.feature_registry.overridden === true && /feature registry.*\[OVERRIDDEN by test/.test(D.printSummary(ov)));
}

// --- skill_frontmatter ---
t('skillDescriptionIssues: an unquoted ": " is flagged; quoted, it is fine', D.skillDescriptionIssues(' Forge: AI agents and evals').length === 1 && D.skillDescriptionIssues(' "Forge: AI agents and evals"').length === 0 && D.skillDescriptionIssues(" 'Forge: AI agents'").length === 0);
t('skillDescriptionIssues: a trailing ":" and an unquoted " #" are flagged', D.skillDescriptionIssues(' Use when:').length === 1 && /comment/.test(D.skillDescriptionIssues(' Use it #now')[0] || ''));
t('skillDescriptionIssues: an unclosed quote, a block scalar and a leading YAML indicator are flagged', D.skillDescriptionIssues(' "half open').length === 1 && D.skillDescriptionIssues(' >').length === 1 && D.skillDescriptionIssues(' [x] y').length === 1 && D.skillDescriptionIssues(' - a list').length === 1);
t('skillDescriptionIssues: a plain description without colon-space is fine (a URL-like "a:b" too)', D.skillDescriptionIssues(' Generates a PRD. Use before a build — write a PRD.').length === 0 && D.skillDescriptionIssues(' see http:x and a:b').length === 0);
function sfRoot(prefix, dev) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  if (dev) wf(root, '.claude/config/forge-dev-tree.json', '{"dev_tree": true}\n');
  wf(root, '.claude/skills/good/SKILL.md', '---\nname: good\ndescription: "Good: quoted, so YAML reads it."\n---\n');
  return root;
}
tFn('skill_frontmatter: a clean dev tree is green; nested skill folders are out of scope', () => {
  const root = sfRoot('fd-sf-green', true);
  wf(root, '.claude/skills/bundle/inner/SKILL.md', '---\nname: inner\ndescription: Inner: unquoted, but nested\n---\n');
  const sf = D.skillFrontmatterCheck(root);
  assert.ok(sf.ok === true && sf.checked === 1 && sf.enforced === true, JSON.stringify(sf));
});
tFn('skill_frontmatter: unquoted colon, missing description, missing frontmatter and an over-long description are red, by name', () => {
  const root = sfRoot('fd-sf-red', true);
  wf(root, '.claude/skills/colon/SKILL.md', '---\nname: colon\ndescription: Forge: unquoted colon\n---\n');
  wf(root, '.claude/skills/nodesc/SKILL.md', '---\nname: nodesc\n---\n');
  wf(root, '.claude/skills/nofm/SKILL.md', '# just a heading\n');
  wf(root, '.claude/skills/long/SKILL.md', '---\nname: long\ndescription: ' + 'x'.repeat(201) + '\n---\n');
  const sf = D.skillFrontmatterCheck(root);
  assert.strictEqual(sf.ok, false);
  assert.deepStrictEqual(sf.failing.slice().sort(), ['colon', 'long', 'nodesc', 'nofm']);
  const out = D.printSummary({ root, ok: false, checks: Object.assign({}, greenRep.checks, { skill_frontmatter: sf }), advisory: {} });
  assert.ok(/✗ skill frontmatter\s+4 skill\(s\) with frontmatter\/catalog problems: .*colon \(the description contains ": " but is not quoted\)/.test(out), out);
});
tFn('skill_frontmatter: a vendored skill (Source + Pinned commit) over the length budget is reported, never counted', () => {
  const root = sfRoot('fd-sf-vend', true);
  wf(root, '.claude/skills/vend/SKILL.md', '---\nname: vend\ndescription: ' + 'y'.repeat(260) + '\n---\n<!--\n  Source: https://github.com/x/y\n  Pinned commit: abcdef1234567\n-->\n');
  const sf = D.skillFrontmatterCheck(root);
  const v = sf.skills.find((s) => s.skill === 'vend');
  assert.ok(sf.ok === true && v.issues.length === 0 && /260 chars/.test((v.vendored_style || [])[0] || ''), JSON.stringify(v));
});
tFn('skill_frontmatter: the catalog rule REUSES forge-quality catalogDrift (an uncatalogued forge-* skill is red)', () => {
  const root = sfRoot('fd-sf-cat', true);
  wf(root, '.claude/config/orchestration/domain-catalog.json', '{}');
  const stub = { catalogDrift: () => ({ ok: false, seams: [{ seam: 'router-playbooks', missing_in_seam: [], extra_in_seam: ['forge-loose'] }] }) };
  const sf = D.skillFrontmatterCheck(root, { qualityModule: stub });
  assert.ok(sf.ok === false && sf.failing.includes('forge-loose') && /neither a domain playbook/.test(sf.skills.find((s) => s.skill === 'forge-loose').issues[0]), JSON.stringify(sf));
  const real = D.skillFrontmatterCheck(root, { qualityModule: null });
  assert.ok(real.ok === false && /forge-quality\.cjs is missing/.test(real.reason), 'a catalog without its checker fails closed in the dev tree: ' + real.reason);
  assert.ok(/catalogDrift\(root\)/.test(DOC_SRC) && !/non_domain_skills\s*\|\|/.test(DOC_SRC.slice(DOC_SRC.indexOf('function skillFrontmatterCheck'), DOC_SRC.indexOf('function scribeWiring'))), 'the rule must be reused, not re-implemented');
});
tFn('skill_frontmatter: outside the dev tree it never turns red, but the findings stay visible on the line', () => {
  const root = sfRoot('fd-sf-synced', false);
  wf(root, '.claude/skills/colon/SKILL.md', '---\nname: colon\ndescription: Forge: unquoted colon\n---\n');
  const sf = D.skillFrontmatterCheck(root);
  assert.ok(sf.ok === true && sf.applicable === false && sf.failing.includes('colon') && /not enforced outside the development tree/.test(sf.reason), JSON.stringify(sf));
  const out = D.printSummary({ root, ok: true, checks: Object.assign({}, greenRep.checks, { skill_frontmatter: sf }), advisory: {} });
  assert.ok(/✓ skill frontmatter\s+1 skill\(s\) with frontmatter\/catalog problems: colon/.test(out), out);
});

// --- WP 1.9: hyphenated keys, when_to_use, the 1,536-char listing entry and the on/off switches ---
t('parseFrontmatter WP 1.9: hyphenated keys are read (the old [A-Za-z_]+ key regex skipped them); indented lines still never are',
  (() => { const fm = D.parseFrontmatter('---\nname: x\ndisable-model-invocation: true\nuser-invocable: false\nargument-hint: [file]\nmodel2: y\n  indented: no\n---\nbody: not frontmatter\n'); return fm.name === 'x' && fm['disable-model-invocation'] === 'true' && fm['user-invocable'] === 'false' && fm['argument-hint'] === '[file]' && fm.model2 === 'y' && !('indented' in fm) && !('body' in fm); })());
t('parseFrontmatter WP 1.9: an agent frontmatter still yields exactly its fields (agentsCheck input unchanged)',
  (() => { const fm = D.parseFrontmatter('---\nname: build-boss\ndescription: "Use PROACTIVELY when: coding"\ntools: Read, Write\nmodel: opus\neffort: medium\nmemory: project\n---\n'); return JSON.stringify(Object.keys(fm)) === JSON.stringify(['name', 'description', 'tools', 'model', 'effort', 'memory']) && fm.description === '"Use PROACTIVELY when: coding"'; })());
t('skillDescriptionIssues WP 1.9: the description messages are byte-identical; when_to_use gets the same rule under its own name',
  D.skillDescriptionIssues(' Forge: x')[0] === 'the description contains ": " but is not quoted — YAML reads it as a nested key, so Claude Code drops it and shows the first heading instead; wrap the whole description in double quotes'
  && /^when_to_use contains ": " but is not quoted/.test(D.skillDescriptionIssues(' Triggers: /forge, build', 'when_to_use')[0] || '')
  && D.skillDescriptionIssues(' "Triggers: /forge, build"', 'when_to_use').length === 0
  && /^the double-quoted when_to_use value is not closed/.test(D.skillDescriptionIssues(' "half', 'when_to_use')[0] || '')
  && /^when_to_use contains " #"/.test(D.skillDescriptionIssues(' use it #now', 'when_to_use')[0] || ''));
t('frontmatterScalarText WP 1.9: quotes are removed and escapes undone before counting', D.frontmatterScalarText(' "a \\"b\\" c" ') === 'a "b" c' && D.frontmatterScalarText("'it''s'") === "it's" && D.frontmatterScalarText('plain') === 'plain' && D.frontmatterScalarText(undefined) === '');
tFn('skill_frontmatter WP 1.9: an unquoted ": " in when_to_use is red by name; the quoted form is green', () => {
  const root = sfRoot('fd-sf-wtu', true);
  wf(root, '.claude/skills/wtu-bad/SKILL.md', '---\nname: wtu-bad\ndescription: "Does one thing."\nwhen_to_use: Triggers: /forge, build\n---\n');
  wf(root, '.claude/skills/wtu-ok/SKILL.md', '---\nname: wtu-ok\ndescription: "Does one thing."\nwhen_to_use: "Triggers: /forge, build. Not for one-line edits."\n---\n');
  const sf = D.skillFrontmatterCheck(root);
  assert.ok(sf.ok === false && JSON.stringify(sf.failing) === JSON.stringify(['wtu-bad']), JSON.stringify(sf.failing));
  assert.ok(/^when_to_use contains ": " but is not quoted/.test(sf.skills.find((s) => s.skill === 'wtu-bad').issues[0]), JSON.stringify(sf.skills));
});
tFn('skill_frontmatter WP 1.9: description + when_to_use over 1,536 chars is red; exactly 1,536 is green; vendored is reported, never counted', () => {
  assert.strictEqual(D.SKILL_LISTING_ENTRY_MAX_CHARS, 1536);
  const root = sfRoot('fd-sf-listcap', true);
  const desc = 'd'.repeat(150);
  wf(root, '.claude/skills/at-cap/SKILL.md', '---\nname: at-cap\ndescription: "' + desc + '"\nwhen_to_use: "' + 'w'.repeat(1536 - 150) + '"\n---\n');
  wf(root, '.claude/skills/over-cap/SKILL.md', '---\nname: over-cap\ndescription: "' + desc + '"\nwhen_to_use: "' + 'w'.repeat(1537 - 150) + '"\n---\n');
  wf(root, '.claude/skills/vend-cap/SKILL.md', '---\nname: vend-cap\ndescription: "' + desc + '"\nwhen_to_use: "' + 'w'.repeat(1600) + '"\n---\n<!--\n  Source: https://github.com/x/y\n  Pinned commit: abcdef1234567\n-->\n');
  const sf = D.skillFrontmatterCheck(root);
  assert.deepStrictEqual(sf.failing, ['over-cap'], JSON.stringify(sf.skills.filter((s) => s.issues.length)));
  assert.ok(/description \+ when_to_use is 1537 chars \(max 1536/.test(sf.skills.find((s) => s.skill === 'over-cap').issues[0]), JSON.stringify(sf.skills));
  const v = sf.skills.find((s) => s.skill === 'vend-cap');
  assert.ok(v.issues.length === 0 && /description \+ when_to_use is 1750 chars/.test((v.vendored_style || []).join(' ')), JSON.stringify(v));
});
tFn('skill_frontmatter WP 1.9: disable-model-invocation / user-invocable must be exactly true or false when present', () => {
  const root = sfRoot('fd-sf-bool', true);
  wf(root, '.claude/skills/b-true/SKILL.md', '---\nname: b-true\ndescription: "One."\ndisable-model-invocation: true\n---\n');
  wf(root, '.claude/skills/b-false/SKILL.md', '---\nname: b-false\ndescription: "One."\nuser-invocable: false # only the model loads it\n---\n');
  wf(root, '.claude/skills/b-quoted/SKILL.md', '---\nname: b-quoted\ndescription: "One."\ndisable-model-invocation: "true"\n---\n');
  wf(root, '.claude/skills/b-yes/SKILL.md', '---\nname: b-yes\ndescription: "One."\nuser-invocable: yes\n---\n');
  wf(root, '.claude/skills/b-empty/SKILL.md', '---\nname: b-empty\ndescription: "One."\ndisable-model-invocation:\n---\n');
  wf(root, '.claude/skills/b-upper/SKILL.md', '---\nname: b-upper\ndescription: "One."\ndisable-model-invocation: True\n---\n');
  const sf = D.skillFrontmatterCheck(root);
  assert.deepStrictEqual(sf.failing.slice().sort(), ['b-empty', 'b-quoted', 'b-upper', 'b-yes'], JSON.stringify(sf.skills.filter((s) => s.issues.length)));
  assert.ok(/^disable-model-invocation is "\\"true\\"" — it must be true or false/.test(sf.skills.find((s) => s.skill === 'b-quoted').issues[0]), sf.skills.find((s) => s.skill === 'b-quoted').issues[0]);
  assert.ok(/^user-invocable is "yes"/.test(sf.skills.find((s) => s.skill === 'b-yes').issues[0]) && /^disable-model-invocation is empty/.test(sf.skills.find((s) => s.skill === 'b-empty').issues[0]));
  assert.deepStrictEqual(D.SKILL_BOOLEAN_KEYS, ['disable-model-invocation', 'user-invocable']);
});

// --- advisories ---
function scribeRoot(prefix, opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  wf(root, '.claude/forge-bin/forge-scribe.cjs', "'use strict';\nmodule.exports = {};\n");
  const hooks = {};
  if (o.capture !== false) hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-scribe-hook.cjs"' }] }];
  if (o.stop !== false) hooks.Stop = [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-scribe-stop.cjs"' }] }];
  wf(root, '.claude/settings.json', JSON.stringify({ hooks }));
  wf(root, '.claude/config/orchestration/FORGE_SCRIBE.json', o.badConfig ? '{ nope' : '{"caps":{}}');
  return root;
}
const gitIgnored = () => ({ status: 0, stdout: '', stderr: '' });
const gitNotIgnored = () => ({ status: 1, stdout: '', stderr: '' });
tFn('scribe_wiring: n/a where forge-scribe.cjs is not installed', () => {
  const r = D.scribeWiring(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-sw-none-')));
  assert.ok(r.ok === true && r.applicable === false, JSON.stringify(r));
});
tFn('scribe_wiring: both hooks + parseable config + gitignored store = ok (no ledger yet is a note)', () => {
  const r = D.scribeWiring(scribeRoot('fd-sw-ok'), { spawnSyncImpl: gitIgnored });
  assert.ok(r.ok === true && r.notes.some((n) => /no scribe ledger yet/.test(n)), JSON.stringify(r));
});
tFn('scribe_wiring: a missing Stop hook, a broken FORGE_SCRIBE.json and a store that is not gitignored are each named', () => {
  const r = D.scribeWiring(scribeRoot('fd-sw-bad', { stop: false, badConfig: true }), { spawnSyncImpl: gitNotIgnored });
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => /Stop hook/.test(p)) && r.problems.some((p) => /FORGE_SCRIBE\.json does not parse/.test(p)) && r.problems.some((p) => /NOT gitignored/.test(p)), JSON.stringify(r.problems));
});
tFn('scribe_wiring: with a ledger present it runs verify-chain (a broken chain is a problem, an intact one a note)', () => {
  const root = scribeRoot('fd-sw-chain');
  wf(root, '.claude/forge-scribe/ledger.jsonl', '{}\n');
  const broken = D.scribeWiring(root, { spawnSyncImpl: gitIgnored, scribeModule: { verifyChains: () => ({ ok: false, inbox: { ok: true, lines: 1 }, ledger: { ok: false, lines: 1 } }) } });
  assert.ok(broken.ok === false && /verify-chain: BROKEN/.test(broken.reason), JSON.stringify(broken));
  const good = D.scribeWiring(root, { spawnSyncImpl: gitIgnored, scribeModule: { verifyChains: () => ({ ok: true, inbox: { ok: true, lines: 2 }, ledger: { ok: true, lines: 3 } }) } });
  assert.ok(good.ok === true && good.notes.some((n) => /verify-chain OK/.test(n)), JSON.stringify(good));
});
tFn('unpublished: n/a outside the dev tree; a missing template is a skip; a difference is ok:true with UNPUBLISHED + the fix', () => {
  assert.strictEqual(D.unpublishedCheck(GREEN_ROOT).applicable, false);
  const root = frRoot('fd-up');
  const tpl = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-up-tpl-'));
  assert.ok(/no central template/.test(D.unpublishedCheck(root, { templateDir: path.join(tpl, 'nope') }).reason));
  let seen = null;
  const stub = { verifyPublishTemplate: (o) => { seen = o; return { ok: false, differences: [{ kind: 'missing-in-template', paths: ['forge-bin/a.cjs'] }, { kind: 'template-version', paths: [] }], warnings: [] }; } };
  const r = D.unpublishedCheck(root, { syncTool: stub, templateDir: tpl });
  assert.ok(r.ok === true && r.unpublished === true && /^UNPUBLISHED \(template\): missing-in-template 1, template-version — fix: node \.claude\/forge-bin\/forge-sync\.cjs publish-template --plan/.test(r.summary), JSON.stringify(r));
  assert.ok(seen && seen.devDir === path.join(root, '.claude') && seen.templateDir === tpl, 'devDir/templateDir passed as specified: ' + JSON.stringify(seen));
  const out = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { unpublished: r } });
  assert.ok(/⚠ unpublished \(advisory, non-blocking\): UNPUBLISHED \(template\)/.test(out), out);
  const same = D.unpublishedCheck(root, { syncTool: { verifyPublishTemplate: () => ({ ok: true, differences: [], warnings: [] }) }, templateDir: tpl });
  assert.ok(same.ok === true && same.unpublished === false && same.verified === true, JSON.stringify(same));
  const thrown = D.unpublishedCheck(root, { syncTool: { verifyPublishTemplate: () => { throw new Error('boom'); } }, templateDir: tpl });
  assert.ok(thrown.ok === true && /could not verify the template: boom/.test(thrown.reason), JSON.stringify(thrown));
});
tFn('structure: dev tree only; tools without a test, a NEW oversized file, README/skill-registry drift, root clutter and no remote are listed', () => {
  assert.strictEqual(D.structureCheck(GREEN_ROOT).applicable, false);
  const root = frRoot('fd-st');
  wf(root, '.claude/forge-bin/helper.test.cjs', 'x');
  wf(root, '.claude/forge-bin/README.md', '| Tool | Purpose |\n|---|---|\n| `flow.cjs` | f |\n| `helper.cjs` | h |\n| `ghost.cjs` | g |\n');
  wf(root, '.claude/FORGE_SKILL_REGISTRY.md', '| Skill | Path |\n|---|---|\n| forge-one | p |\n| forge-gone | p |\n');
  wf(root, '.claude/forge-bin/huge.cjs', 'x\n'.repeat(900));
  writeReg(root, (d) => { d.structure.size_allowlist = []; });
  wf(root, '.claude/config/orchestration/FORGE_SHIP_MANIFEST.json', JSON.stringify({ schema: 'forge-ship-manifest/v1', rules: [{ pattern: 'CLAUDE.md', class: 'per-project', channels: [], reason: 'r' }, { pattern: '.claude/forge-bin/*.cjs', class: 'ship-sync', channels: ['sync', 'release', 'template'], reason: 'r' }], known_gaps: [] }));
  const noRemote = () => ({ status: 0, stdout: '', stderr: '' });
  const r = D.structureCheck(root, { spawnSyncImpl: noRemote, files: ['CLAUDE.md', 'notes.txt', '.claude/forge-bin/flow.cjs'] });
  const f = r.findings;
  assert.strictEqual(r.ok, false);
  assert.ok(f.tools_without_test.includes('flow.cjs') && !f.tools_without_test.includes('helper.cjs'), JSON.stringify(f.tools_without_test));
  assert.ok(f.oversize.some((x) => /huge\.cjs \(\d+\)/.test(x)), JSON.stringify(f.oversize));
  assert.ok(f.readme_missing.includes('lonely.cjs') && f.readme_extra.includes('ghost.cjs'), JSON.stringify([f.readme_missing, f.readme_extra]));
  assert.ok(f.skill_registry_extra.includes('forge-gone') && f.root_clutter.join() === 'notes.txt' && f.no_remote === true, JSON.stringify(f));
  writeReg(root, (d) => { d.structure.size_allowlist = ['.claude/forge-bin/huge.cjs']; });
  const withRemote = D.structureCheck(root, { spawnSyncImpl: () => ({ status: 0, stdout: 'origin\n', stderr: '' }), files: ['CLAUDE.md'] });
  assert.ok(withRemote.findings.oversize.length === 0 && withRemote.allowlisted_oversize === 1 && withRemote.findings.no_remote === false && withRemote.findings.root_clutter.length === 0, JSON.stringify(withRemote));
  const out = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { structure: r } });
  assert.ok(/⚠ structure \(advisory, non-blocking\): .*tool\(s\) without a test.*NO git remote/.test(out), out);
});
tFn('always_loaded_budget: sizes are reported; over the budget is a warning; mirrors forge-wp11-coverage.test.cjs CORE_BYTE_BUDGET', () => {
  const wp11 = fs.readFileSync(path.join(__dirname, 'forge-wp11-coverage.test.cjs'), 'utf8');
  const m = /const CORE_BYTE_BUDGET = (\d+);/.exec(wp11);
  assert.ok(m && Number(m[1]) === D.ALWAYS_LOADED_BUDGET_BYTES, 'budget drifted from the WP-11 test: ' + (m && m[1]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-alb-'));
  assert.strictEqual(D.alwaysLoadedBudget(root).applicable, false);
  wf(root, '.claude/commands/forge.md', 'x'.repeat(100));
  wf(root, '.claude/skills/forge-router/SKILL.md', 'y'.repeat(D.ALWAYS_LOADED_BUDGET_BYTES + 1));
  const r = D.alwaysLoadedBudget(root);
  assert.ok(r.ok === false && r.files[0].bytes === 100 && r.files[1].over === true, JSON.stringify(r));
  const out = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { always_loaded_budget: r } });
  assert.ok(/⚠ always-loaded budget \(advisory, non-blocking\): commands\/forge\.md 100 B, forge-router\/SKILL\.md 16385 B OVER/.test(out), out);
});
tFn('plugin_validate (WP 3.7): n/a without a built plugin or without claude; the CLI exit code is the verdict; never part of doctor.ok', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-pv-'));
  const calls = [];
  const spawnOk = (file, args, env, ms, cwd) => { calls.push({ file, args, cwd }); return { status: 0, stdout: '✔ Validation passed', stderr: '' }; };
  const noDist = D.pluginValidate(root, { spawnImpl: spawnOk });
  assert.ok(noDist.ok === true && noDist.applicable === false && /no built plugin/.test(noDist.reason) && calls.length === 0, JSON.stringify(noDist));
  wf(root, D.PLUGIN_DIST_REL + '/.claude-plugin/plugin.json', '{"name":"forge"}');
  const binDir = path.join(root, 'bin');
  const noClaude = D.pluginValidate(root, { env: { PATH: binDir, PATHEXT: '.EXE' }, spawnImpl: spawnOk });
  assert.ok(noClaude.ok === true && noClaude.applicable === false && /not on PATH/.test(noClaude.reason) && calls.length === 0, JSON.stringify(noClaude));
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  wf(root, 'bin/' + exe, 'stub');
  if (process.platform !== 'win32') fs.chmodSync(path.join(binDir, exe), 0o755);
  const env = { PATH: binDir, PATHEXT: '.EXE' };
  const pass = D.pluginValidate(root, { env, spawnImpl: spawnOk });
  assert.ok(pass.ok === true && pass.applicable === true && pass.status === 'pass', JSON.stringify(pass));
  assert.deepStrictEqual(calls[0].args, ['plugin', 'validate', 'dist/forge-plugin']);
  assert.ok(calls[0].cwd === root, 'cwd must be the project root: ' + calls[0].cwd);
  const failed = D.pluginValidate(root, { env, spawnImpl: () => ({ status: 1, stdout: '✘ Found 1 error:\n  ❯ plugin.json name: invalid', stderr: '' }) });
  assert.ok(failed.ok === false && failed.applicable === true && failed.errors.some((l) => /error/.test(l)), JSON.stringify(failed));
  const hung = D.pluginValidate(root, { env, spawnImpl: () => ({ status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) });
  assert.ok(hung.ok === true && hung.applicable === false && /timed out/.test(hung.reason), JSON.stringify(hung));
  const odd = D.pluginValidate(root, { env, spawnImpl: () => ({ status: 2, stdout: '', stderr: '' }) });
  assert.ok(odd.ok === true && odd.applicable === false && /exit 2/.test(odd.reason), JSON.stringify(odd));
  const outFail = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { plugin_validate: failed } });
  assert.ok(/⚠ plugin validate \(advisory, non-blocking\): `claude plugin validate dist\/forge-plugin` failed: .*error/.test(outFail), outFail);
  const outSkip = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { plugin_validate: noClaude } });
  assert.ok(/ℹ plugin validate \(advisory\): n\/a — the claude CLI is not on PATH/.test(outSkip), outSkip);
  assert.ok(greenRep.advisory.plugin_validate && greenRep.advisory.plugin_validate.ok === true && greenRep.ok === true, JSON.stringify(greenRep.advisory.plugin_validate));
});
tFn('skill_lint + agent_lint (WP-E2, WP-A1): advisory summaries of the two linters; an error is ⚠, never part of doctor.ok', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-lint-'));
  const none = D.skillLint(root), noneA = D.agentLint(root);
  assert.ok(none.ok === true && none.applicable === false && /no skills/.test(none.reason), JSON.stringify(none));
  assert.ok(noneA.ok === true && noneA.applicable === false && /no agents/.test(noneA.reason), JSON.stringify(noneA));
  const missing = D.skillLint(root, { tool: null });
  assert.ok(missing.applicable === false && /not installed/.test(missing.reason), JSON.stringify(missing));
  wf(root, '.claude/skills/Bad-Name/SKILL.md', '---\nname: Bad-Name\ndescription: Reviews diffs. Use when asked.\n---\nbody\n');
  wf(root, '.claude/agents/typo.md', '---\nname: typo\ndescription: x\nmaxTurn: 5\n---\nbody\n');
  const sl = D.skillLint(root), al = D.agentLint(root);
  assert.ok(sl.ok === false && sl.applicable === true && sl.checked === 1 && sl.counts.error >= 1 && sl.errors.some((e) => /lowercase/.test(e)), JSON.stringify(sl));
  assert.ok(al.ok === false && al.applicable === true && al.checked === 1 && al.errors.some((e) => /unknown key "maxTurn"/.test(e)), JSON.stringify(al));
  const out = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { skill_lint: sl, agent_lint: al } });
  assert.ok(/⚠ skill lint \(advisory, non-blocking\): 1 checked · \d+ error/.test(out) && /⚠ agent lint \(advisory, non-blocking\): 1 checked .*maxTurn.*forge-agentlint\.cjs/.test(out), out);
  const outNa = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { skill_lint: missing } });
  assert.ok(/ℹ skill lint \(advisory\): n\/a — forge-skilllint\.cjs is not installed here/.test(outNa), outNa);
  assert.throws(() => D.skillLint(root, { tool: { lintSkills: () => { throw new Error('boom'); } } }), /boom/, 'lintSummary does not swallow: runDoctor wraps it in advisorySafe');
  assert.ok(greenRep.advisory.skill_lint && typeof greenRep.advisory.skill_lint.ok === 'boolean' && greenRep.advisory.agent_lint && typeof greenRep.advisory.agent_lint.ok === 'boolean' && greenRep.ok === true, JSON.stringify([greenRep.advisory.skill_lint, greenRep.advisory.agent_lint]));
});
tFn('config_scan + harness_score (WP-E3, package 2.9e): advisory, in-process; n/a when the tool is missing; a finding is ⚠, never part of doctor.ok', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-e3-'));
  try {
    const missing = D.configScan(root, { tool: null }), missingH = D.harnessScore(root, { tool: null });
    assert.ok(missing.ok === true && missing.applicable === false && /forge-config-scan\.cjs is not installed/.test(missing.reason), JSON.stringify(missing));
    assert.ok(missingH.ok === true && missingH.applicable === false && /forge-harness-score\.cjs is not installed/.test(missingH.reason), JSON.stringify(missingH));
    const empty = D.configScan(root);
    assert.ok(empty.ok === true && empty.applicable === false && /no Claude configuration files/.test(empty.reason), JSON.stringify(empty));
    const noRubric = D.harnessScore(root, { rubricPath: path.join(root, 'absent-rubric.json') });
    assert.ok(noRubric.ok === true && noRubric.applicable === false && /^rubric not found/.test(noRubric.reason), JSON.stringify(noRubric));
    // a real error-level finding (an allow rule that grants every shell command) -> ⚠ with file:line rule, never the value
    wf(root, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(*)'] } }, null, 2) + '\n');
    const cs = D.configScan(root);
    assert.ok(cs.ok === false && cs.applicable === true && cs.checked >= 1 && cs.counts.error >= 1 && cs.errors.some((e) => /^\.claude\/settings\.json:\d+ perm-allow-all$/.test(e)), JSON.stringify(cs));
    // the scorecard: the tool's own --strict verdict (overall >= HARNESS_MIN and no outright fail); a fail is named
    const fake = { scoreHarness: () => ({ overall: 9, measured_categories: 2, total_categories: 3, categories: [{ checks: [{ id: 'a', status: 'pass' }, { id: 'b', status: 'fail' }] }], top_actions: [{ category: 'c', check: 'b', action: 'Fix b' }] }) };
    const hs = D.harnessScore(root, { tool: fake });
    assert.ok(hs.ok === false && hs.applicable === true && hs.overall === 9 && hs.failed[0] === 'b' && hs.top_actions[0] === 'c/b: Fix b', JSON.stringify(hs));
    const allPass = D.harnessScore(root, { tool: { scoreHarness: () => ({ overall: D.HARNESS_MIN, measured_categories: 1, total_categories: 1, categories: [{ checks: [{ id: 'a', status: 'pass' }] }], top_actions: [] }) } });
    assert.ok(allPass.ok === true && allPass.applicable === true, JSON.stringify(allPass));
    const none = D.harnessScore(root, { tool: { scoreHarness: () => ({ overall: null, categories: [], top_actions: [] }) } });
    assert.ok(none.ok === true && none.applicable === false && /could be measured/.test(none.reason), JSON.stringify(none));
    assert.throws(() => D.harnessScore(root, { tool: { scoreHarness: () => { throw new Error('boom'); } } }), /boom/, 'only a missing rubric is n/a: runDoctor wraps any other throw in advisorySafe');
    const out = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { config_scan: cs, harness_score: hs } });
    assert.ok(/⚠ config scan \(advisory, non-blocking\): \d+ file\(s\) · \d+ error .*perm-allow-all.*forge-config-scan\.cjs/.test(out), out);
    assert.ok(/⚠ harness score \(advisory, non-blocking\): overall 9\/10 over 2\/3 measured categories \(doctor checks not fed in\) · failed: b · first: c\/b: Fix b/.test(out), out);
    const outNa = D.printSummary({ root, ok: true, checks: greenRep.checks, advisory: { config_scan: missing, harness_score: missingH } });
    assert.ok(/ℹ config scan \(advisory\): n\/a — forge-config-scan\.cjs is not installed here/.test(outNa) && /ℹ harness score \(advisory\): n\/a — forge-harness-score\.cjs is not installed here/.test(outNa), outNa);
    assert.ok(greenRep.advisory.config_scan && typeof greenRep.advisory.config_scan.ok === 'boolean' && greenRep.advisory.harness_score && typeof greenRep.advisory.harness_score.ok === 'boolean' && greenRep.ok === true, JSON.stringify([greenRep.advisory.config_scan, greenRep.advisory.harness_score]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
t('advisories: runDoctor() reports all nine under report.advisory and never folds them into doctor.ok',
  ['scribe_wiring', 'unpublished', 'structure', 'always_loaded_budget', 'skill_lint', 'agent_lint', 'plugin_validate', 'config_scan', 'harness_score'].every((k) => greenRep.advisory[k] && typeof greenRep.advisory[k].ok === 'boolean') && greenRep.ok === true);
pinned('WP-8b: the REAL development tree — the feature registry is complete and every wired entry has a wired caller', () => {
  const fr = D.featureRegistryCheck(REAL_ROOT);
  t('feature_registry (real tree): applicable and ok', fr.applicable === true && fr.ok === true, fr.reason);
  t('feature_registry (real tree): forge-mindmap.cjs is wired through the router (audit S3/F4)', (() => { const c = RGEN.classifyFeatures(REAL_ROOT).nodes.get('tool:forge-mindmap.cjs'); return c && c.status === 'wired' && c.callers.some((x) => /forge-router\/SKILL\.md|router-intake-and-skill-discovery\.md/.test(x.from)); })());
  t('feature_registry (real tree): finishes in under 5 s', typeof fr.ms === 'number' && fr.ms < 5000, 'ms=' + fr.ms);
  const sf = D.skillFrontmatterCheck(REAL_ROOT);
  t('skill_frontmatter (real tree): runs over every top-level skill and names each failing skill with a concrete issue', sf.checked >= 70 && sf.skills.filter((s) => s.issues.length).every((s) => sf.failing.includes(s.skill) && typeof s.issues[0] === 'string' && s.issues[0].length > 10));
});

// =====================================================================================================
// WP A11 part 2: the doctor split into doctor/*.cjs. CONTRACT: the composition root's ordered
// check tables equal this snapshot — a lost, duplicated, renamed or reordered check fails here (proven with
// a temporary mutant that dropped a row and one that swapped two rows, in the A11 part 2 hand-off).
// =====================================================================================================
const DOCTOR_CHECK_ORDER_SNAPSHOT = {
  checks: ['node_check', 'tests', 'strict_events', 'dashboard_spa', 'leak_scan', 'agents', 'chain', 'rebinding_guard',
    'unregistered_event', 'check_the_checks', 'release_exclusions', 'model_routing', 'ship_manifest', 'run_contract',
    'feature_registry', 'skill_frontmatter', 'skill_adapters', 'ecc_path', 'citations'],
  advisory: ['command_center_location', 'backfill_continuity', 'run_liveness', 'context_budget', 'gate_watchdog_health',
    'scribe_wiring', 'unpublished', 'claim_sealed_drift', 'structure', 'always_loaded_budget', 'global_forge_handover', 'eol_drift', 'plugin_validate', 'skill_lint', 'agent_lint',
    'config_scan', 'harness_score', 'beginner_setup', 'completeness'],
  completeness: ['sync_completeness', 'memory_discipline', 'mcp_dormancy', 'quality_catalog', 'skill_evals', 'skill_hygiene'],
};
tFn('A11 contract: DOCTOR_CHECK_ORDER (the composition root\'s ordered check tables) equals the snapshot', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(D.DOCTOR_CHECK_ORDER)), DOCTOR_CHECK_ORDER_SNAPSHOT);
});
tFn('A11 contract: a real runDoctor() report carries exactly those keys in that order (checks, advisory, completeness)', () => {
  assert.deepStrictEqual(Object.keys(greenRep.checks), DOCTOR_CHECK_ORDER_SNAPSHOT.checks);
  assert.deepStrictEqual(Object.keys(greenRep.advisory), DOCTOR_CHECK_ORDER_SNAPSHOT.advisory);
  assert.deepStrictEqual(Object.keys(greenRep.advisory.completeness), DOCTOR_CHECK_ORDER_SNAPSHOT.completeness);
});
tFn('A11 contract: every DOCTOR_MODULES file exists, parses, stays under 800 lines and is loaded by the root', () => {
  assert.ok(D.DOCTOR_MODULES.length >= 10, 'expected the module list, got ' + D.DOCTOR_MODULES.length);
  for (const rel of D.DOCTOR_MODULES) {
    const abs = path.join(__dirname, ...rel.split('/'));
    const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
    assert.ok(lines < 800, rel + ' has ' + lines + ' lines');
    assert.ok(require.cache[require.resolve(abs)], rel + ' was not loaded by forge-doctor.cjs');
  }
  const onDisk = fs.readdirSync(path.join(__dirname, 'doctor')).filter((n) => n.endsWith('.cjs')).map((n) => 'doctor/' + n).sort();
  assert.deepStrictEqual(onDisk, [...D.DOCTOR_MODULES].sort(), 'doctor/ holds exactly the listed modules');
});
tFn('A11 contract: the DOCTOR_SUITE_TIMEOUT_MS literal kept in forge-doctor.cjs (read by forge-sync.test.cjs) equals the value doctor/checks-core.cjs uses', () => {
  const rootSrc = fs.readFileSync(path.join(__dirname, 'forge-doctor.cjs'), 'utf8');
  const m = /const DOCTOR_SUITE_TIMEOUT_MS = (\d+);/.exec(rootSrc);
  assert.ok(m, 'the literal is gone from forge-doctor.cjs');
  assert.strictEqual(Number(m[1]), require('./doctor/checks-core.cjs').DOCTOR_SUITE_TIMEOUT_MS);
  assert.strictEqual(D.DOCTOR_SUITE_TIMEOUT_MS, Number(m[1]));
});

console.log(pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exitCode = fail ? 1 : 0;
