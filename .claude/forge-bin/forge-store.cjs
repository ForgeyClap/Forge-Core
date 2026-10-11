#!/usr/bin/env node
'use strict';
/**
 * forge-store.cjs — hardened, append-only flat-file store writer for Forge Mission Control Phase 2
 * (WP1 "Foundations"). Zero-dependency, Windows-safe. Stores live under THIS project's .claude/ only:
 *   tickets   -> .claude/forge-tickets/
 *   artifacts -> .claude/forge-artifacts/
 *   prd       -> .claude/forge-prd/
 *   mindmaps  -> .claude/forge-mindmaps/
 *
 * Pattern per store: one file per entity (<id>.json) + an append-only index.jsonl (one compact row
 * per put: {id, ts, store}). This is a WRITER, not a database — index.jsonl is a log, not an index
 * that gets rewritten; readers replay it or just fs.readdir() the store dir.
 *
 * SECURITY GUARDS (mirror forge-dashboard/log-event.cjs exactly — read that file first):
 *   - store name is allowlisted (STORES) — no free-form store names, no path built from raw input.
 *   - id is restricted to ^[A-Za-z0-9_-]+$ (same shape as log-event.cjs's run_id guard) — rejects
 *     traversal attempts like "../evil" outright (the regex has no room for "/" or ".").
 *   - belt-and-braces path-containment check: the resolved store dir must stay inside CLAUDE_DIR, and
 *     the resolved entity file must stay inside the store dir (same startsWith(base + sep) idea as
 *     log-event.cjs's RUNS_DIR check) — defense in depth even though the id regex already blocks this.
 *
 * SECRET HYGIENE: every string leaf of the stored value is redacted before anything touches disk (same
 * masking idea as forge-bin/nvidia-provider.cjs mask(), applied recursively so JSON structure/keys are
 * left alone and only leaf string VALUES are scanned). A raw secret is never written, never echoed.
 *
 * CLI:
 *   node forge-store.cjs put <store> <id> '<json>'   # validate + redact + write <id>.json + append index row
 *   node forge-store.cjs get <store> <id>             # print the stored entity JSON
 *   node forge-store.cjs list <store>                 # print one id per line
 *   node forge-store.cjs index <store>                # print index.jsonl raw
 *
 * Module API: require(...) ->
 *   { putEntity, getEntity, listStore, readIndex, redactValue, isValidId, isValidStore, STORES,
 *     resolveStoreDir, CLAUDE_DIR }
 *
 * TEST ISOLATION: set FORGE_STORE_ROOT to redirect CLAUDE_DIR to a throwaway temp dir. This is a
 * TEST-ONLY escape hatch (used by forge-store.test.cjs) — never point it at a real project.
 */
const fs = require('fs');
const path = require('path');

// This file lives in .claude/forge-bin/, so CLAUDE_DIR is one level up — same resolution as
// forge-bin/nvidia-provider.cjs and forge-dashboard/log-event.cjs. FORGE_STORE_ROOT overrides it
// for hermetic tests only.
const CLAUDE_DIR = process.env.FORGE_STORE_ROOT
  ? path.resolve(process.env.FORGE_STORE_ROOT)
  : path.resolve(__dirname, '..');

// Allowlisted stores only (mirrors log-event.cjs's KNOWN_EVENT_TYPES strictness) — no store name is
// ever taken from user input and used to build a path directly.
const STORES = {
  tickets: 'forge-tickets',
  artifacts: 'forge-artifacts',
  prd: 'forge-prd',
  mindmaps: 'forge-mindmaps',
};

function isValidStore(store) { return Object.prototype.hasOwnProperty.call(STORES, store); }
// Same id shape as log-event.cjs's run_id guard — deliberately has no room for "/", "\", or "..".
function isValidId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id); }

function resolveStoreDir(store) {
  if (!isValidStore(store)) throw new Error('unknown store "' + store + '" — allowed: ' + Object.keys(STORES).join(', '));
  const dir = path.join(CLAUDE_DIR, STORES[store]);
  const base = path.resolve(CLAUDE_DIR), resolved = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('store escapes .claude/ — refused');
  return dir;
}
function resolveEntityFile(store, id) {
  if (!isValidId(id)) throw new Error('invalid id (allowed: A-Z a-z 0-9 _ -): ' + id);
  const dir = resolveStoreDir(store);
  const file = path.join(dir, id + '.json');
  const base = path.resolve(dir), resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('id escapes store dir — refused');
  return file;
}

// ---- secret redaction (same masking idea as forge-bin/nvidia-provider.cjs mask()) ----
// Applied recursively to string leaves; ALSO redacts a value whose KEY name reads like a credential
// (catches unformatted secrets — plain passwords/tokens — that match no fixed pattern). Hardened
// 2026-07-10 after an independent security review of the /api/artifact endpoint flagged coverage gaps
// (Stripe underscore keys, PEM body, URL connection-string creds, keyless secrets). This is the SERVED
// redaction (tickets/artifacts/prd/mindmaps), so completeness here is defense-in-depth for the dashboard.
const SECRET_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]+/g,                                            // NVIDIA Build/NIM key
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,                           // OpenAI-style secret key (hyphen) — boundary-anchored: no match mid-word ("task-orchestrator…" false positives); real keys (after quote/space/=/start) still match
  /sk_(?:live|test)_[A-Za-z0-9]{10,}/g,                              // Stripe secret key (underscore)
  /rk_(?:live|test)_[A-Za-z0-9]{10,}/g,                              // Stripe restricted key
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,                                      // GitHub tokens (ghp_/gho_/ghr_/ghs_/ghu_)
  /xox[baprs]-[A-Za-z0-9-]+/g,                                        // Slack bot/user/app/refresh tokens
  /AKIA[0-9A-Z]{16}/g,                                                // AWS access key id
  /AIza[0-9A-Za-z_-]{35}/g,                                           // Google API key
  /SG\.[A-Za-z0-9_-]{16,256}\.[A-Za-z0-9_-]{16,256}/g,                // SendGrid API key (upper-bounded: ReDoS-safe)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----/g, // full PEM block — body upper-bounded (ReDoS-safe: unbounded [\s\S]*? scanned to EOF per BEGIN marker; 8KB covers RSA-2048/4096 and RSA-8192 ~6.5KB)
  /eyJ[A-Za-z0-9_-]{10,256}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}/g, // JWT (header.payload.signature) — header tightly upper-bounded (ReDoS-safe vs eyJ-spam; real JWT headers are ~36 chars)
  // URL-embedded credentials in a connection string — mask the password only. 4th fix round:
  // every quantifier is UPPER-BOUNDED. The old `[a-z][a-z0-9+.\-]*` scheme was unbounded and — because its
  // leading `[a-z]` matches at almost every position in ordinary lowercase text — caused catastrophic O(n^2)
  // backtracking (a 600KB run of a single letter took ~160s to scan, hanging the whole doctor). Real schemes
  // are <=~15 chars, hosts/passwords well under 512, so these bounds change no real match while making the
  // pattern strictly linear on any input, at any file size.
  /([a-z][a-z0-9+.\-]{0,39}:\/\/[^\s:/@]{1,512}):[^\s:/@]{1,512}@/gi,
];
// Replacement for the URL-creds pattern keeps scheme://user and drops the password; all others → marker.
function redactString(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = re.source.includes(':\\/\\/') ? out.replace(re, '$1:***REDACTED***@') : out.replace(re, '***REDACTED***');
  }
  return out;
}
// Key names that mean "this value is a credential" — redact the whole value regardless of its shape.
// Separator/anchor-bounded so innocent keys like "author"/"description" never match.
const SECRET_KEY_RE = /(^|[_.\- ])(passwd|password|pwd|secret|secret[_-]?key|token|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|apikey|client[_-]?secret|access[_-]?key|private[_-]?key|credential|credentials|authorization|bearer)($|[_.\- ])/i;
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function redactValue(v, keyHint) {
  if (typeof v === 'string') {
    if (keyHint && SECRET_KEY_RE.test(String(keyHint)) && v.trim()) return '***REDACTED***';
    return redactString(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x));
  if (isPlainObject(v)) { const out = {}; for (const k of Object.keys(v)) out[k] = redactValue(v[k], k); return out; }
  return v; // numbers/booleans/null pass through unchanged
}

// ---- redactText(str) —: redactValue()'s key-name heuristic
// (SECRET_KEY_RE) only ever runs against OBJECT KEYS, so a labelled secret sitting inside ordinary FREE
// TEXT — "password=hunter2", "client_secret=abc123", "access_token: xyz", `"api_key": "..."` — passed
// straight through every existing caller that redacts a bare string (forge-vault.cjs's decision/mission
// notes, forge-doctor.cjs's failing-test lines, forge-snapshot.cjs's latest-check-failure quote). This is a
// SEPARATE, additive function — redactValue()/redactString()/SECRET_KEY_RE are UNCHANGED, so every existing
// caller and test keeps its exact current behaviour; only NEW callers that need free-text scanning use this.
//
// Two passes, in order: (1) the existing SECRET_PATTERNS (identical to redactString — catches an unlabelled
// secret shape anywhere in the text, so a value is still masked even before its label is checked); (2) a
// key=value / key: value / "key": "value" / key value scan reusing SECRET_KEY_RE's own vocabulary (widened
// with a few more common secret-labelled key names: pwd, auth, session, cookie), case-insensitive, with
// "_"/"-"/"." separators. The bare "key value" shape (no punctuation at all) is by far the noisiest of the
// four — an ordinary sentence can accidentally look like it ("a token of appreciation") — so it requires a
// materially longer value (8+ chars) before it fires; the three punctuated shapes only need 3+ (long enough
// to skip a bare trailing separator with nothing after it, short enough to still catch a short illustrative
// value like "xyz"). Every quantifier is UPPER-bounded (ReDoS-safe, same discipline as SECRET_PATTERNS
// above — no nested/ambiguous repetition anywhere, so both are strictly linear) and the overall input is
// length-capped before either regex ever sees it. Never throws.
const TEXT_KEY_TERM = '(?:password|passwd|pwd|client[_.-]?secret|secret[_.-]?key|secret|access[_.-]?token|refresh[_.-]?token|session[_.-]?token|token|api[_.-]?key|apikey|access[_.-]?key|private[_.-]?key|credentials?|authorization|bearer|auth|session|cookie)';
// Codex stop-gate K2-01: a QUOTED value is redacted in full up to its closing quote (an unterminated
// quote fails closed to the end of the line), and an unquoted punctuated value from its FIRST character — a 1-2
// character password is still a password. Order matters: quoted forms first, then the unquoted form.
const KEY_PART = '(?<![A-Za-z0-9])(["\']?)(' + TEXT_KEY_TERM + ')(["\']?)(\\s*[:=]\\s*)';
const KEY_VALUE_DQ_RE = new RegExp(KEY_PART + '"([^"\\r\\n]{1,4096})("?)', 'gi');
const KEY_VALUE_SQ_RE = new RegExp(KEY_PART + "'([^'\\r\\n]{1,4096})('?)", 'gi');
const KEY_VALUE_PUNCT_RE = new RegExp(KEY_PART + '(?!["\'])([^\\s"\',;]{1,4096})', 'gi');
// independent review N2: the {8,} floor on ANY non-whitespace run let the bare
// "key value" form (by far the noisiest of the four — a key term followed by whitespace is common ordinary
// prose, not a labelled secret) redact real English words: "The access token expiration is set to 3600
// seconds." lost "expiration" (10 chars), "The password recovery flow is enabled." lost "recovery" (8
// chars). Both sentences must stay byte-identical. Fixed two ways together: the floor raised to 12 (already
// excludes "recovery"/"expiration" on length alone), AND the candidate is only redacted when
// isTokenShapedBareValue() (below) says it mixes letters and digits — an ordinary word (all letters) or a
// bare number (all digits) never qualifies, but a real token/hash almost always mixes both (the existing
// 8a5 test's "4b19f0e2c9aa", "abcd1234efgh5678"). The regex still only captures a token-SAFE charset run
// (unchanged from before, minus the raised floor); the letter+digit check is applied in the replace()
// callback in redactText() below, not the pattern itself, so it stays easy to read and to test on its own.
const KEY_VALUE_BARE_RE = new RegExp('(?<![A-Za-z0-9])(' + TEXT_KEY_TERM + ')(\\s+)([A-Za-z0-9_.\\-/+=]{12,4096})', 'gi');
function isTokenShapedBareValue(v) { return /[A-Za-z]/.test(v) && /[0-9]/.test(v); }
/** decodesToBasicCredential(v) -> true when v is well-formed base64 that decodes to printable "user:password"
 *  (HTTP Basic). An ordinary word ("configuration") is not valid padded base64 or has no colon once decoded. */
function decodesToBasicCredential(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  let dec;
  try { dec = Buffer.from(v, 'base64').toString('utf8'); } catch { return false; }
  return /^[\x20-\x7e]+$/.test(dec) && dec.indexOf(':') > 0;
}
// ---- Authorization / Bearer credential handling ----
// KEY_VALUE_PUNCT_RE above only ever consumes the FIRST whitespace-free token after a labelled separator,
// so an UNQUOTED "Authorization: Bearer FAKEBEARER123456" redacted just the scheme word ("Bearer") and left
// the real credential sitting in plain sight right after it — an Authorization header's value is
// "<scheme> <credential>" as ONE unit, not two independent fields. A QUOTED form
// ("Authorization": "Bearer xyz") was already fully redacted by KEY_VALUE_DQ_RE/SQ_RE above (their value
// capture already spans embedded spaces up to the closing quote) — this is additive, UNQUOTED-only
// coverage. Case-insensitive (header names/scheme words are seen in every case in the wild); covers
// "Proxy-Authorization" too.
//
// The scheme list for the LABELLED form is intentionally broader than for the BARE form below — it only
// ever fires once the literal "Authorization"/"Proxy-Authorization" label is present, so there is no
// ordinary-English-sentence false-positive risk once that label is there.
// Verify Boss F1: ANY single scheme word counts once the label is there — a fixed list leaked
// Discord's "Bot <token>", Okta's "SSWS <token>", "ApiKey <key>" and any vendor-specific scheme. A trailing
// colon after the scheme ("Bearer: <token>") is accepted too.
const AUTH_HEADER_SCHEME = '(?:[A-Za-z][A-Za-z0-9._+\\-]{0,63}:?)';
const AUTH_HEADER_KEY_PART = '(?<![A-Za-z0-9])(["\']?)((?:Proxy-)?Authorization)(["\']?)(\\s*[:=]\\s*)';
const AUTH_HEADER_RE = new RegExp(AUTH_HEADER_KEY_PART + '(?!["\'])(' + AUTH_HEADER_SCHEME + ')(\\s+)([^\\s"\',;]{1,4096})', 'gi');
// A BARE "Bearer <token>" / "Basic <token>" with NO "Authorization:" label at all (pasted straight out of a
// curl command or a log line). Deliberately narrow — ONLY these two scheme words, not the full
// AUTH_HEADER_SCHEME list above — because unlike the labelled form, there is no "Authorization:" anchor to
// rule out an ordinary English sentence; "Token"/"Digest" in particular would collide head-on with
// TEXT_KEY_TERM's own, separately-tuned "token" handling (KEY_VALUE_BARE_RE's 12-char floor) and
// reintroduce exactly the prose false positives that floor exists to prevent. Only fires when the value
// right after the scheme word is actually TOKEN-SHAPED (isTokenShapedBareValue — mixes letters and digits),
// so "Basic setup" and "bearer of news" (neither "setup" nor "of"/"news" mixes letters and digits) are left
// untouched, and the pre-existing "the bearer had a bag" test stays byte-identical for the same reason.
const AUTH_BARE_SCHEME = '(?:Bearer|Basic)';
// Verify Boss round 2: '=' belongs to the value too (base64 padding), and a sentence-final period is split
// off in redactText() below so it stays in the text instead of being swallowed or blocking the decode check.
const AUTH_BARE_RE = new RegExp('(?<![A-Za-z0-9])(' + AUTH_BARE_SCHEME + ')(\\s+)([A-Za-z0-9+/_.=\\-]{1,4096})(?![A-Za-z0-9+/_.=\\-])', 'gi');
const TEXT_REDACT_MAX_CHARS = 50000; // defensive cap — every real caller today already bounds its own text far below this
function redactText(s) {
  if (typeof s !== 'string') return s == null ? '' : redactText(String(s));
  try {
    const truncated = s.length > TEXT_REDACT_MAX_CHARS;
    let out = redactString(truncated ? s.slice(0, TEXT_REDACT_MAX_CHARS) : s);
    out = out.replace(KEY_VALUE_DQ_RE, (_m, kq1, key, kq2, sep, _val, close) => kq1 + key + kq2 + sep + '"***REDACTED***' + close);
    out = out.replace(KEY_VALUE_SQ_RE, (_m, kq1, key, kq2, sep, _val, close) => kq1 + key + kq2 + sep + "'***REDACTED***" + close);
    // the UNQUOTED Authorization/Proxy-Authorization "<scheme> <token>" form, redacted as ONE unit
    // BEFORE the generic KEY_VALUE_PUNCT_RE pass below (which would otherwise only consume the scheme word).
    out = out.replace(AUTH_HEADER_RE, (_m, kq1, key, kq2, sep) => kq1 + key + kq2 + sep + '***REDACTED***');
    out = out.replace(KEY_VALUE_PUNCT_RE, (_m, kq1, key, kq2, sep) => kq1 + key + kq2 + sep + '***REDACTED***');
    out = out.replace(KEY_VALUE_BARE_RE, (m, key, sep, val) => isTokenShapedBareValue(val) ? key + sep + '***REDACTED***' : m);
    // a bare "Bearer <token>"/"Basic <token>" with no "Authorization:" label at all. Runs last so it
    // never fights with the labelled passes above.
    // Verify Boss F3: a letters-only Basic value (no digit, so not "token-shaped") is still a credential when
    // it is base64 that decodes to printable "user:password".
    out = out.replace(AUTH_BARE_RE, (m, scheme, _sp, val) => {
      // A sentence-final period is punctuation, not part of the credential. Stripped with a plain loop: the
      // regex /\.+$/ was quadratic on a value that is almost all dots (Verify Boss round 3, note 1).
      let end = val.length;
      while (end > 0 && val.charCodeAt(end - 1) === 46 /* '.' */) end--;
      const core = val.slice(0, end);
      if (!core) return m;
      const isCredential = isTokenShapedBareValue(core) || (/^basic$/i.test(scheme) && decodesToBasicCredential(core));
      return isCredential ? '***REDACTED***' + val.slice(core.length) : m;
    });
    return truncated ? out + '…[truncated]' : out;
  } catch { return '[redaction failed]'; }
}

function nowIso() { return new Date().toISOString(); }

// ---- store operations ----
function putEntity(store, id, value) {
  const file = resolveEntityFile(store, id);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const redacted = redactValue(value);
  // always land as an object envelope so `_stored` has somewhere to live, even for non-object input
  // (arrays/primitives) — JSON.stringify would silently drop a non-index property tacked onto an array.
  const envelope = isPlainObject(redacted) ? { ...redacted } : { value: redacted };
  envelope._stored = nowIso();
  // ---- WP-sizing lint (ADVISORY ONLY, tickets store only — Forge is security-light, never blocking) ----
  // A ticket touching many files with no stated reason is a signal the work package may be too large
  // to land safely in one pass (small scope = higher success). Warn on stderr and stamp the envelope;
  // never throw, never change the exit code, never touch any other store.
  if (store === 'tickets' && isPlainObject(value) && Array.isArray(value.related_files) &&
      value.related_files.length > 3 && !value.sizing_justification) {
    console.error('forge-store: ticket ' + id + ' touches ' + value.related_files.length +
      ' files (>3) without sizing_justification — consider splitting the work package (small scope = higher success)');
    envelope._sizing_warning = true;
  }
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({ id, ts: envelope._stored, store }) + '\n', 'utf8');
  return envelope;
}
function getEntity(store, id) {
  const file = resolveEntityFile(store, id);
  if (!fs.existsSync(file)) throw new Error('not found: ' + store + '/' + id);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function listStore(store) {
  const dir = resolveStoreDir(store);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
}
function readIndex(store) {
  const dir = resolveStoreDir(store);
  const file = path.join(dir, 'index.jsonl');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

module.exports = {
  putEntity, getEntity, listStore, readIndex, redactValue, redactText, isValidId, isValidStore,
  STORES, resolveStoreDir, CLAUDE_DIR, SECRET_PATTERNS, SECRET_KEY_RE,
  isTokenShapedBareValue, // exported for direct unit testing
};

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const args = process.argv.slice(2);
    const cmd = args[0];
    switch (cmd) {
      case 'put': {
        const [, store, id, json] = args;
        if (!store || !id || json === undefined) { console.error("Usage: put <store> <id> '<json>'"); process.exitCode = 1; return; }
        let value;
        try { value = JSON.parse(json); } catch (e) { console.error('invalid JSON: ' + e.message); process.exitCode = 1; return; }
        putEntity(store, id, value);
        console.log('stored ' + store + '/' + id + '.json');
        return;
      }
      case 'get': {
        const [, store, id] = args;
        if (!store || !id) { console.error('Usage: get <store> <id>'); process.exitCode = 1; return; }
        console.log(JSON.stringify(getEntity(store, id), null, 2));
        return;
      }
      case 'list': {
        const [, store] = args;
        if (!store) { console.error('Usage: list <store>'); process.exitCode = 1; return; }
        listStore(store).forEach((id) => console.log(id));
        return;
      }
      case 'index': {
        const [, store] = args;
        if (!store) { console.error('Usage: index <store>'); process.exitCode = 1; return; }
        process.stdout.write(readIndex(store));
        return;
      }
      default:
        console.error('Usage: node forge-store.cjs <put|get|list|index> <store> [id] [json]');
        console.error('Stores: ' + Object.keys(STORES).join(', '));
        process.exitCode = 1;
    }
  };
  try { main(); } catch (e) { console.error('forge-store: ' + e.message); process.exitCode = 1; }
}
