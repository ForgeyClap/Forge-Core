#!/usr/bin/env node
'use strict';
/**
 * forge-gate-hook.cjs — PreToolUse hook (matcher `Bash|PowerShell`): the SEVEN command hard gates become a real
 * stop (WP16,; opaque-exec added in the codex-recheck-2026-09-24
 * remediation, wp-f1; secret-print added, 2026-09-27; plugin-install-command and settings-edit-command added
 * WP 3.3b, 2026-10-24 — this header said FIVE until then). Written rules are advice; a hook runs BEFORE the
 * tool call and exit 2 blocks it and feeds stderr back to Claude. ON by default for beginners (config key
 * `gate-hook`, FORGE_CONFIG_SCHEMA.json) after the beginner sweep (rows A4/B10). Doctrine + honest limits:
 * config/orchestration/HOOKS_OPT_IN.md §6.
 *
 * BLOCKS the match.kind "command" gates of hard-gates.json via the single classifier forge-actiongate.cjs:
 * destructive-delete, kill-by-name, git-destructive, opaque-exec, secret-print, plugin-install-command (`claude plugin
 * install|enable|update`, `claude plugin marketplace add`) and settings-edit-command (a shell write/replace/move/delete
 * of .claude/settings(.local).json or ~/.claude/settings.json, `claude config set`) and, since W1 (an EIGHTH),
 * global-input-command (a command whose own code sends global keyboard/mouse input: SendKeys, SendInput, keybd_event,
 * mouse_event, WScript.Shell SendKeys/AppActivate) — plus the hook's own
 * `gate-hook-self-disable`
 * (security wp9b M3): a Bash/PowerShell forge-config call that sets gate-hook off, unsets it, with a mutating
 * verb, read from a PARSED argv rather than a spelling match (codex-recheck S05). The ONE allowed off-switch is
 * the owner-approved one-off `node .claude/forge-bin/forge-config.cjs set gate-hook off --once "<owner's
 * words>"`. A once-grant is consumed ATOMICALLY, per affected command, through
 * forge-config.cjs::consumeOnce() (codex-recheck S06) — never a blanket window. Text gates and
 * write-outside-root are NOT enforced here (legitimate flows; no reliable target path in a command line).
 *
 * (sec-v1r-H1/L1/L2, independent re-review): the WHOLE inspection pipeline — stripInertData, selfDisable,
 * classify, the destructive-delete raw recheck, scratchPassThrough — now runs in forge-gate-inspect.cjs::
 * inspect(), called from EITHER the worker_threads Worker (forge-gate-watchdog.cjs, the normal protected path)
 * OR, only when the watchdog module itself is unavailable and the command is small enough
 * (WATCHDOG_UNAVAILABLE_FALLBACK_CHARS), directly from evaluate() below. This file's OWN job is now narrow: read
 * input, apply the cheap top-level size ceiling, run the watchdog (or the explicitly-bounded fallback), map the
 * result, and do the parts that must stay on the main thread because they read/write persistent state
 * (gateHookEnabled()'s config read; decide()'s once-approval consumption via forge-config.cjs::consumeOnce()).
 * Nothing else runs unbounded on the main thread — see forge-gate-inspect.cjs's own header for the full "why".
 *
 * EXIT CODES (security wp9b M2, tightened by codex-recheck C01/S07): 2 = blocked · 1 = non-blocking but
 * VISIBLE (hook internal error, oversized/hanging/unparseable/ambiguous stdin, gate-hook OFF while a gate
 * would have fired, classifier unavailable and the fallback regex silent) · 0 = allowed. A call this hook
 * cannot actually judge — malformed JSON, a null/array/string payload, a shell tool with a missing or
 * non-string command, or an UNRECOGNISED hook_event_name (codex-recheck V01: only a name Claude Code really
 * sends for a non-tool-call event is silently unrelated) — is NEVER silently allowed: it exits 1 with a
 * visible "NOT checked" line. Silent exit 0 is reserved for a call this hook can POSITIVELY tell is unrelated
 * (a real recognised non-PreToolUse event, a recognised non-shell tool, or an empty no-op command). A
 * self-disable attempt is BLOCKED (exit 2) whenever gate-hook is ON, and also while a ONCE-style grant is
 * PENDING (codex-recheck V03 — the plain off/unset form must never upgrade a one-off approval into a
 * persistent OFF); it is visible-but-allowed only under a PERSISTENT off with no once-window open. When
 * hard-gates.json / the classifier cannot load, FALLBACK_RE blocks the obviously destructive verbs (fail-CLOSED).
 * FU-A7: a call it cannot judge (unparseable or oversized stdin, a stdin that
 * breaks off, an internal error, a classifier that cannot run) whose command text still shows a hard-gate KEYWORD
 * exits 2 (gate id cannot-judge-risky; the classifier-unavailable branch keeps its own id) with the plain NL/EN reason
 * "Forge kan dit commando niet beoordelen en het lijkt riskant"; without a keyword it stays the visible exit 1, so
 * exit 1 keeps meaning "visible and non-blocking" and the settings carry no onFailure (see "CANNOT JUDGE" below; the
 * keyword scan itself lives in forge-gate-cannot-judge.cjs since FU-A7).
 * The structural envelope cases (a non-object payload, an unknown hook event, a missing tool name or command) keep
 * their plain exit 1: there is no shell command there to read.
 * Never writes stdout; zero dependencies beyond Node core (fs/os/path/crypto). PowerShell is matched
 * because the tool ledger shows real PowerShell tool calls (same `command` field) and kill-by-name's forbidden
 * forms are PowerShell-native.
 *
 * RUN RECORD: only AFTER a block (exit 2) is final and on stderr, the CLI appends ONE
 * `gate_blocked {gate, gates, command_digest, tool}` to the project's active run (only the command's sha256) via
 * forge-stop-obligations.cjs::recordGateBlock — best effort, one attempt, hard time budget inside the 10 s hook
 * timeout, never a different exit code; skipped for non-live calls (no session_id + transcript_path),
 * FORGE_GATE_RUN_EVENT=off, no active run, or a missing helper. MAINTENANCE MODE: while the project
 * holds a fresh `.claude/.forge-sync.lock` (< 6 h) the record is skipped as well — nothing is written into a project
 * forge-sync is replacing files in; the block/allow verdict is unchanged. An older lock is ignored (fail-open).
 *
 * (package 3.3c) — WARN CHECKS. (ii) An optional per-task WRITE-SCOPE freeze, OFF by default:
 * with FORGE_WRITE_SCOPE (env only: the config schema has no string/path type, so `write-scope` is not a key) set to a directory, every
 * shell write this file can read (redirects, tee, sed -i, Set-Content/Add-Content/Out-File/Tee-Object) is judged by
 * forge-gate-writescope.cjs: outside -> a visible warning (exit 1), or a block (gate id `write-scope`) only when the
 * owner set FORGE_WRITE_SCOPE_MODE / `write-scope-mode` to `deny`; a target it cannot check -> a visible notice, never
 * a block (applyWriteScope below). (i) "Inspect before edit" is NOT built: this matcher sees only Bash/PowerShell,
 * and no hook records a Read, so there is no turn memory to compare with (it would need a Read matcher and a
 * per-session read-set file: an owner-gated settings change).
 *
 * MODEL: gateHookEnabled · selfDisable · scratchPassThrough · decide(payload, opts) -> {block, warn, gates, reason,
 * notice, why} · run(rawStdin, opts) -> {exitCode, stderr, why, gates?} · recordGateBlocked · writeScopeSetting ·
 * applyWriteScope. CLI: stdin -> run() -> stderr -> (exit 2 only) recordGateBlocked() -> exit with run()'s code.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// SCRATCH is still required directly here for the exported direct-test wrappers below (scratchPassThrough,
// tokenize, verbIndex, extractTargets, resolveTarget, areaOf) — those are test conveniences, not part of the
// quadratic-risk inspection pipeline (which reaches SCRATCH's scratchPassThrough independently, via
// forge-gate-inspect.cjs). Absent -> no pass-through (stricter).
let SCRATCH = null;
try { SCRATCH = require('./forge-gate-scratch.cjs'); } catch { SCRATCH = null; }
// the worker_threads watchdog that now runs the WHOLE inspection pipeline —
// see forge-gate-watchdog.cjs's header for the full design. Absent -> evaluate() falls back to running
// forge-gate-inspect.cjs::inspect() directly, bounded by WATCHDOG_UNAVAILABLE_FALLBACK_CHARS.
let WATCHDOG = null;
try { WATCHDOG = require('./forge-gate-watchdog.cjs'); } catch { WATCHDOG = null; }
// wp-v4 (independent review): these three used to be required UNGUARDED — a broken or missing file
// made THIS require() throw, which made require('./forge-gate-hook.cjs') itself throw, which crashed the WHOLE
// process before run()'s CLI handler ever ran: every command (destructive or not) exited non-zero with no
// verdict computed at all, the exact "every command runs unchecked" regression this fix closes. Before
// every dependency was optional with a fail-closed fallback (FALLBACK_RE still blocked destructive verbs when
// the classifier could not load) — restored below via minimal, zero-dependency LOCAL fallbacks for the handful
// of exports evaluate()/decide()/run() actually call, so this file can never crash at require-time again
// regardless of which sibling is missing or corrupted.
let SELFDISABLE = null;
try { SELFDISABLE = require('./forge-gate-selfdisable.cjs'); } catch { SELFDISABLE = null; }
let MSG = null;
try { MSG = require('./forge-gate-messages.cjs'); } catch { MSG = null; }
let INSPECT = null;
try { INSPECT = require('./forge-gate-inspect.cjs'); } catch { INSPECT = null; }
let OBLIGATIONS = null; // gate_blocked run record helper; guarded (absent/broken -> no record, same verdict)
try { OBLIGATIONS = require('./forge-stop-obligations.cjs'); } catch { OBLIGATIONS = null; }
// (3.3c): the optional per-task write-scope freeze (see applyWriteScope below). Absent -> a configured
// scope gets a visible "NOT checked" notice, never a silent pass.
let WRITESCOPE = null;
try { WRITESCOPE = require('./forge-gate-writescope.cjs'); } catch { WRITESCOPE = null; }
// FU-A7: the cannot-judge keyword scan. Absent/broken -> every call this hook cannot judge is refused (see below).
let CANNOT_JUDGE = null;
try { CANNOT_JUDGE = require('./forge-gate-cannot-judge.cjs'); } catch { CANNOT_JUDGE = null; }

// Fallback self-disable (mirrors forge-gate-inspect.cjs's own copy — see that file's header for why a small
// duplication is deliberate here): a crude, over-inclusive check that still catches the obvious "forge-config
// ... set/unset ... gate-hook" shape when the precise parser cannot load. Only used for this file's OWN
// backward-compat exports (hook.selfDisable etc.) — the real pipeline's self-disable check lives in
// forge-gate-inspect.cjs and has its own, independently-guarded copy of the same fallback.
//
// sec-v3r L3 (independent re-review): the old single ordered regex only matched two of the six possible
// orderings of (script name, mutating verb, "gate-hook"), and never stripped quotes/backslashes or joined a
// Bash backslash-newline / PowerShell backtick-newline line continuation before testing, so a trivially
// reordered or quote-broken or continuation-split call could slip past this LAST-RESORT net. Replaced with
// three independent, unordered word-boundary checks (script present AND a mutating verb present AND
// "gate-hook" present, in ANY order) over a normalised copy of the text — every check is a single linear
// scan, so this stays exactly as safe against ReDoS as the regex it replaces despite matching more shapes.
function fallbackSelfDisableNormalize(seen) {
  return String(seen)
    .replace(/\\\r?\n/g, '') // Bash line continuation: backslash-newline is deleted, not a real separator
    .replace(/`\r?\n/g, '') // PowerShell line continuation: backtick-newline is deleted, not a real separator
    .replace(/["'\\]/g, ''); // quotes/backslashes stripped, same de-gluing looksLikeAmbiguousConfigMutation does
}
const FALLBACK_SELFDISABLE_SCRIPT_RE = /forge-config(?:-cli)?\.cjs/i;
const FALLBACK_SELFDISABLE_VERB_RE = /\b(?:set|unset)\b/i;
const FALLBACK_SELFDISABLE_KEY_RE = /\bgate-hook\b/i;
function fallbackSelfDisableTest(seen) {
  const norm = fallbackSelfDisableNormalize(seen);
  return FALLBACK_SELFDISABLE_SCRIPT_RE.test(norm) && FALLBACK_SELFDISABLE_VERB_RE.test(norm)
    && FALLBACK_SELFDISABLE_KEY_RE.test(norm);
}

// Fallback messages: no per-gate wording (that lives in forge-gate-messages.cjs), but still a real, honest,
// NL/EN block reason and a bounded notice — used by evaluate()/decide()/offNotice() below whenever MSG itself
// could not load, so a broken forge-gate-messages.cjs can never crash THIS file's own require either.
const FALLBACK_NOTICE_CHARS = 300;
function fallbackCap(s) { return s.length > FALLBACK_NOTICE_CHARS ? s.slice(0, FALLBACK_NOTICE_CHARS - 1) + '…' : s; }
function fallbackBlockReason(ids) {
  return 'FORGE GATE (' + ids.join(', ') + '): dit commando lijkt destructief; de uitleg-module kon niet laden, '
    + 'dus is het voor de zekerheid geweigerd — herstel forge-gate-messages.cjs (draai de doctor). / '
    + 'this command looks destructive; the wording module could not load, so it was refused to be safe — '
    + 'restore forge-gate-messages.cjs (run the doctor).';
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// V01 (codex-recheck 2026-09-24): only a hook_event_name Claude Code ACTUALLY sends for something other than a
// tool call may pass silently as "not-pretooluse" — an unrecognised/corrupted name (a bogus envelope, not a
// real Claude Code event) is never proof this call is unrelated, so it stays VISIBLE (exit 1) instead.
const KNOWN_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd', 'PreCompact',
  'UserPromptSubmit', 'Notification', 'SubagentStop', 'SubagentStart', 'PermissionRequest']);
const FAILSAFE_MS = 3000;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
// WP 2.1 (2.1.C): the project this hook guards (the scratch-area root and the run-record root). An installed copy
// (<project>/.claude/forge-bin/) keeps its own project exactly as before: synced projects, the central template and
// every test fixture copy. A plugin copy (<plugin>/scripts/) has no project of its own: forge-paths scriptRoot then
// takes CLAUDE_PROJECT_DIR, else the first folder holding .claude/.forge/.git above the cwd, and never a folder inside
// the plugin, so `rm -rf node_modules` in the project passes there exactly as in a synced install. Nothing found ->
// null: no scratch pass-through (fail closed) and no run record. forge-paths.cjs is optional (guarded require): a copy
// without it, or an older resolver without scriptRoot, keeps the old own-folder answer.
let FORGE_PATHS = null;
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.scriptRoot === 'function') FORGE_PATHS = fp; } catch { FORGE_PATHS = null; }
function hookProjectRoot() {
  if (!FORGE_PATHS) return path.resolve(__dirname, '..', '..'); // forge-paths fallback
  try { return FORGE_PATHS.scriptRoot(__dirname); } catch { return null; }
}
const PROJECT_ROOT = hookProjectRoot();
// SB-M5 (codex-recheck twelfth pass / wp-t1). MAX_STDIN_BYTES above bounds the whole JSON payload
// (8 MiB); it says nothing about how expensive the inspection pipeline is on whatever command text sits inside
// that payload. MAX_COMMAND_CHARS is a much smaller, cheap-to-check ceiling on the COMMAND TEXT ALONE
// (comfortably above any real Bash/PowerShell command a normal session ever constructs, comfortably below
// MAX_STDIN_BYTES) checked BEFORE anything else runs; DEADLINE_MS is a wall-clock safety net measured around
// the inspection call itself (inline OR the watchdog round-trip, whichever runs).
// wp-v1 (codex-fixes, security probe secl17-m1): DEADLINE_MS ALONE was proven insufficient — it is
// only ever compared AFTER the inspection call returns, so it cannot stop a call that has not returned yet.
// wp-v3 (sec-v1r-H1, independent re-review): the SAME danger existed one level deeper than wp-v1/wp-v2 ever
// protected — stripInertData() (called on the MAIN thread, entirely BEFORE the watchdog branch) had its own
// super-linear cost on harmless input (many `echo a`-shaped segments; see forge-gate-data.cjs's own header for
// the measured numbers), and the destructive-delete recheck / scratchPassThrough ALSO ran unguarded on the main
// thread afterwards (sec-v1r L2). evaluate() below now routes the WHOLE inspection pipeline — not just
// classify() — through the worker_threads Worker guarded by a 6000ms Atomics.wait whenever the watchdog module
// is available (sec-v1 M2: no size threshold — see forge-gate-watchdog.cjs's header), so a runaway step
// ANYWHERE in that pipeline is ABANDONED (and answered with this same "too large / too slow to inspect" BLOCK)
// instead of silently exceeding the hook's own external timeout. DEADLINE_MS still catches the case where the
// inspection genuinely finishes, just too slowly (4s-6s). WATCHDOG_UNAVAILABLE_FALLBACK_CHARS (sec-v1 M1,
// lowered from 20,000 to 10,000 by sec-v1r L1) is the fail-closed ceiling used ONLY when the watchdog module
// itself could not be required at all (e.g. no worker_threads in this environment): a command at or under it is
// still classified inline (the pre-wp-v1 behaviour for an ordinary small command); anything larger is refused
// outright rather than silently running an unbounded classification with nothing left to bound it. Justified
// from measurements, not a guess: kill-by-name's own worst confirmed benign shape (a search piped through many
// "| xargs echo" stages, no kill word anywhere) costs ~503ms at 10,000 chars (interpolated from 67ms/5,000 and
// 4,028ms/20,000) — comfortably fast for an inline fallback path — and forge-gate-data.cjs's own
// MAX_INERT_SCAN_SEGMENTS fix makes stripInertData() itself linear regardless of size, so 10,000 chars carries
// negligible extra risk from that stage either. All three refuse with a plain "too large to inspect" BLOCK
// (exit 2), never the non-blocking "NOT checked" exit 1 an ordinary inspection failure gets — an oversized or
// slow-to-judge command is exactly the shape this hook exists to stop from running unchecked, not a shape to
// wave through with a warning.
const MAX_COMMAND_CHARS = 200000;
const DEADLINE_MS = 4000;
const LATER_PASS_MIN_MS = 250; // WP-GATEFP2: floor for a later pass's watchdog budget (a Worker needs time to start)
const WATCHDOG_UNAVAILABLE_FALLBACK_CHARS = 10000;
// sec-v3r L1 (independent re-review): four additions below, each kept BOUNDED — this regex still runs
// unprotected on the main thread (the watchdog only ever protects the REAL classifier, never this fallback),
// so no new alternative may reintroduce the \S*-before-a-literal shape sec-v1r-H1 already proved catastrophic
// on adversarial dense input. `eval` uses a negative lookahead so a legitimate hyphenated token like
// "eval-source-map" (a real webpack --devtool value) does not trip it. The pipe-into-a-shell and
// kill-with-substitution alternatives use `\s*`/`{0,200}` (bounded), never `[^\n]*`. The encoded-PowerShell-flag
// alternative is a fully deterministic nested-literal chain (no repeated class, so no backtracking ambiguity is
// possible regardless of nesting depth) covering every real unambiguous abbreviation of -EncodedCommand,
// starting at -en (the shortest prefix powershell.exe itself accepts without also matching -ExecutionPolicy).
// v2.7.3 (post-release review sec-release-v272 L1, defense-in-depth): two more bounded alternatives so the
// classifier-unavailable branch also blocks a shell self-disable of the gate itself — a `forge-config[-cli]`
// invocation naming `gate-hook` in either order. Bounded `{0,200}` (same rule as the kill/pipe alternatives,
// never an unbounded `[^\n]*`); over-blocking is the safe direction in a corrupt-classifier state, so even the
// legitimate once-shape is refused here (visible, retriable when the classifier is healthy) rather than allowed.
// WP 3.3b: the plugin-install-command / settings-edit-command shapes join, under the same bounded rule
// (`\s+` between fixed words, `{0,200}` before the settings path, never an unbounded `[^\n]*`): `claude plugin
// install|i|enable|update`, `claude plugin marketplace add`, `claude config set|add|remove`, and a redirect, tee,
// Set-Content/Add-Content/Out-File, cp/mv/Copy-Item/Move-Item or sed/perl naming `.claude/settings`. Over-blocking a
// backup copy here is the accepted price of a broken classifier.
// WP 3.3c: the git alternative starts with the exact first-anchor guard `(?=\bgit\b)(?<!\bgit\b[^\n]*?)`
// (only the first `git` of a line scans the rest; the verdict is unchanged), so 200k chars of `git ` cost ~ms instead of
// 2.8 s on this unprotected main-thread path — the same guard hard-gates.json's rest-of-line arms carry.
// the global-input-command words (SendKeys, SendWait, SendInput, keybd_event, mouse_event, AppActivate)
// join as one fixed-word alternative (linear, no class before a literal).
const FALLBACK_RE = /\b(rm|Remove-Item|rd|rmdir|del|taskkill|Stop-Process|pkill|killall)\b|\b(?:SendKeys|SendWait|SendInput|keybd_event|mouse_event|AppActivate)\b|(?=\bgit\b)(?<!\bgit\b[^\n]*?)\bgit\b[^\n]*\b(reset|clean|checkout|restore|switch|stash)\b|\biex\b|\bInvoke-Expression\b|\beval\b(?!-)|\|\s*(?:sudo\s+|env\s+)?(?:sh|bash|zsh|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?)\b|-en(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?\b|\bkill\b[^\n]{0,200}(?:\$\(|`)\s*(?:pgrep|pidof)\b|\bforge-config(?:-cli)?\b[^\n]{0,200}\bgate-hook\b|\bgate-hook\b[^\n]{0,200}\bforge-config(?:-cli)?\b|(?<![.\w-])claude(?:-code)?(?:\.exe|\.cmd|\.ps1)?\s+(?:plugins?\s+(?:install|i|enable|update|marketplace\s+add)|config\s+(?:set|add|remove))\b|(?:>{1,2}\s*["']?[^\s"'<>|;&()]{0,200}|\b(?:tee|Set-Content|Add-Content|Out-File|cp|mv|Copy-Item|Move-Item|sed|perl)\b[^\n]{0,200})\.claude[\\/]settings/i;

/** sha256(s) -> hex digest, used only to bind a once-consumption call to the exact command being evaluated
 *  (codex-recheck S06); never logged, never echoed back to the user. */
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

// WORDS/blockReason/cap/passNotice/ONCE_HINT now live in forge-gate-messages.cjs (wp-v3) so BOTH this file and
// the worker build the exact same message text from one source. wp-v4: read defensively (never
// destructure MSG directly — that would throw immediately at require-time if MSG is null) and fall back to the
// minimal local implementations above when the real module could not load.
const WORDS = MSG ? MSG.WORDS : {};
const blockReason = MSG ? MSG.blockReason : fallbackBlockReason;
const cap = MSG ? MSG.cap : fallbackCap;
const passNotice = MSG ? MSG.passNotice : ((targets) => fallbackCap('FORGE GATE: destructive delete allowed — all targets inside a project scratch area or in the OS temp dir outside the project (' + targets.join(', ') + ')'));

/** gateHookEnabled(opts) -> { on, source, set_at, set_by, expires_at, quote }. opts.config injects a forge-config
 *  module (tests); null = "module absent". Never throws; an absent/unreadable config means the default ON.
 *  The one-off fields come from forge-config.cjs; the quote's field name is read defensively. */
function resolveConfigModule(opts) {
  let cfg = opts.config;
  if (cfg === undefined) { try { cfg = require('./forge-config.cjs'); } catch { cfg = null; } }
  return cfg;
}
function gateHookEnabled(opts) {
  opts = opts || {};
  const cfg = resolveConfigModule(opts);
  if (!cfg || typeof cfg.get !== 'function') return { on: true, source: 'schema-default (forge-config.cjs absent)' };
  try {
    const e = cfg.get('gate-hook');
    const quote = e.once_quote || e.approval_quote || e.quote || e.approval || null;
    return { on: e.value !== false, source: e.source || 'unknown', set_at: e.set_at || null, set_by: e.set_by || null,
      expires_at: e.expires_at || null, quote: typeof quote === 'string' ? quote : null };
  } catch (err) {
    return { on: true, source: 'schema-default (config unreadable: ' + (err.code || err.name || 'error') + ')' };
  }
}

/** commandGateIds(gateModule) -> Set of the "command"-kind gate ids — delegates to forge-gate-inspect.cjs so
 *  there is exactly one implementation. wp-v4: INSPECT may be null (guarded require) — an empty
 *  Set is the honest, fail-safe answer (this export is a convenience for callers/tests, never part of the real
 *  block/allow decision, which lives entirely inside forge-gate-inspect.cjs::inspect() itself). */
function commandGateIds(gateModule) {
  return INSPECT ? INSPECT.commandGateIds(gateModule) : new Set();
}

// ---- SCRATCH PASS-THROUGH — direct-test wrappers only (the real inspection pipeline reaches SCRATCH through
// forge-gate-inspect.cjs independently). Delegated to forge-gate-scratch.cjs (split out 2026-09-24 to keep this
// file under 500 lines). An absent scratch module fails closed: no pass-through.
function scratchPassThrough(command, ctx) {
  if (!SCRATCH) return { ok: false, why: 'scratch-module-unavailable' };
  return SCRATCH.scratchPassThrough(command, ctx);
}
const tokenize = (...a) => (SCRATCH ? SCRATCH.tokenize(...a) : null);
const verbIndex = (...a) => (SCRATCH ? SCRATCH.verbIndex(...a) : -1);
const extractTargets = (...a) => (SCRATCH ? SCRATCH.extractTargets(...a) : null);
const resolveTarget = (...a) => (SCRATCH ? SCRATCH.resolveTarget(...a) : null);
const areaOf = (...a) => (SCRATCH ? SCRATCH.areaOf(...a) : null);

// selfDisable/parseConfigCall/isSelfDisableCall/isOnceExempt now live in forge-gate-selfdisable.cjs (wp-v3) so
// BOTH this file (fallback path) and the worker call the exact same implementation. wp-v4: read
// defensively — SELFDISABLE may be null (guarded require); these exports are backward-compat/test surface only
// (the real pipeline's self-disable check lives inside forge-gate-inspect.cjs, independently guarded there).
const selfDisable = SELFDISABLE ? SELFDISABLE.selfDisable : (seen) => fallbackSelfDisableTest(seen);
const parseConfigCall = SELFDISABLE ? SELFDISABLE.parseConfigCall : () => null;
const isSelfDisableCall = SELFDISABLE ? SELFDISABLE.isSelfDisableCall : () => false;
const isOnceExempt = SELFDISABLE ? SELFDISABLE.isOnceExempt : () => false;

function offNotice(en, gates) {
  const tail = ' — this would have been blocked (' + gates.join(', ') + ')';
  if (en.expires_at) return cap('FORGE GATE is OFF until ' + en.expires_at + ' — one-off approval: "' + (en.quote || '?') + '"' + tail);
  return cap('FORGE GATE is OFF (set_at ' + (en.set_at || 'unknown') + ', set_by ' + (en.set_by || 'unknown') + ')' + tail);
}

/** buildInspectCtx(payload, opts) -> the plain, structured-cloneable context forge-gate-inspect.cjs::inspect()
 *  (and, via classifyWithWatchdog(), the worker's own copy of it) needs — mirrors forge-gate-scratch.cjs's own
 *  scratchPassThrough(seen, ctx) shape exactly, so it threads straight through unchanged. ctx.gate is read ONLY
 *  on the inline path (a function cannot cross a Worker boundary; evaluate() never sets useWatchdog when
 *  opts.gate is present, so the worker path never sees it). */
function buildInspectCtx(payload, opts) {
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const env = opts.env || process.env;
  return {
    gate: opts.gate,
    shell: payload.tool_name,
    cwd,
    root: opts.projectRoot || PROJECT_ROOT,
    protectedRoots: [opts.projectRoot || PROJECT_ROOT, env.CLAUDE_PROJECT_DIR || cwd],
    tmp: opts.tmpdir || os.tmpdir(),
    platform: opts.platform || process.platform,
    configPath: opts.configPath,
  };
}

/** inspectOnce(command, ctx, opts, useWatchdog, watchdogModule) -> { verdict } | { final } — ONE run of the
 *  inspection pipeline (watchdog path or the bounded inline fallback). `final` is a verdict evaluate() must return
 *  as-is (watchdog failure / classifier unavailable); throws only where evaluate()'s own catch already handled it. */
function inspectOnce(command, ctx, opts, useWatchdog, watchdogModule) {
  if (!useWatchdog) {
    if (!INSPECT) throw new Error('forge-gate-inspect.cjs unavailable');
    return { verdict: INSPECT.inspect(command, ctx) };
  }
  const w = watchdogModule.classifyWithWatchdog(command, Object.assign({}, ctx, {
    watchdogTimeoutMs: opts.watchdogTimeoutMs, simulateSlowMs: opts.simulateSlowMs,
    simulateCrash: opts.simulateCrash, WorkerImpl: opts.WorkerImpl,
    SharedArrayBufferImpl: opts.SharedArrayBufferImpl, atomicsWait: opts.atomicsWait,
    simulateInspectThrow: opts.simulateInspectThrow, // sec-v3r L2 test seam — never set outside a test
  }));
  if (w.ok) return { verdict: w.verdict };
  // sec-v3 L1 (independent review): the worker tags a THROW INSIDE inspect() itself (a broken/missing
  // hard-gates.json, a broken forge-actiongate.cjs, etc.) distinctly from a genuine watchdog/infrastructure
  // failure (timeout, crash, payload corruption) — only the former is "the classifier could not run at
  // all", which restores the EXACT pre-wave-13 classifier-unavailable branch (FALLBACK_RE + honest
  // wording) instead of blanket-blocking it as "too large to inspect", a claim that would be false here.
  if (w.classifierUnavailable) return { final: classifierUnavailableVerdict(command, w.error || w.why, ctx.shell) };
  const ids = ['command-too-large'];
  return { final: { block: true, gates: ids, reason: blockReason(ids), why: w.why + (w.error ? ' (' + String(w.error).split('\n')[0] + ')' : '') } };
}

/** neutralizeSafeRedirects(command, shell) -> the command with every UNQUOTED harmless OUTPUT redirect blanked to
 *  spaces (same length), or null when it cannot judge (quote module missing, unterminated quoting, unknown shell).
 *  WP-GATEFP: secret-print's pattern-vs-file veto (forge-actiongate.cjs::secretPrintPatternExempt)
 *  refuses ANY unquoted `>`, so `grep -o "\.env" src/a.cjs 2>/dev/null` was blocked as if `.env` were a file it read.
 *  Harmless = an output redirect into `&N`, a null sink (/dev/null, $null, NUL) or a plain file name that is not
 *  itself secret-shaped: writing output never reads a file. Never touched: `<`, `$(`, backticks, a quoted `>`, a
 *  redirect glued to a preceding word — those stay in the text, so the re-check keeps blocking (fail closed).
 *  WP-GATEFP2 (checked against real Git Bash and Windows PowerShell 5.1 on a dummy temp file):
 *  the operator set is SHELL-SPECIFIC, because blanking a token the shell passes on as an ARGUMENT deletes a real
 *  read target from the re-check. Bash: `>`, `>>`, `N>`, `N>>`, `&>`, `&>>`, `>&M`, `N>&M` for ONE digit N/M (0-9;
 *  WP-GATEFP3 / Codex r10 G4: real Git Bash passes `3>/dev/null`, `0>o`, `9>o`, `7>&2` on as redirects, never as
 *  arguments; a two-digit fd and the `{fd}>` word form stay unblanked, so they keep blocking) — never a leading
 *  `*` (bash reads `*>out` as a glob word plus a redirect; `grep *>out .env` really printed the file). PowerShell:
 *  `>`, `>>`, `1>`..`6>`, `*>` and their `>>` forms, `2>&1`..`6>&1`, `*>&1`; `0>` and `7>`..`9>` are literal
 *  arguments there (`Select-String -Pattern 7> -Path .env` printed the file), `&>`/`1>&2`/`>&1` are parse errors
 *  and `&` is never a boundary. `shell` omitted = Bash (the direct-call unit tests); any other name -> null.
 *  Built in one pass: matched ranges are collected and joined once (linear; the old per-match rebuild was quadratic). */
const SAFE_REDIRECT_RES = {
  Bash: /(^|[\s;|&(])(\d?>&\d|(?:\d|&)?>>?[ \t]*[A-Za-z0-9_.\/\\:$-]+)(?=$|[\s;|&)])/g,
  PowerShell: /(^|[\s;|(])([2-6*]>&1|[1-6*]?>>?[ \t]*[A-Za-z0-9_.\/\\:$-]+)(?=$|[\s;|)])/g,
};
const NULL_SINK_RE = /^(?:&\d|\/dev\/null|\/dev\/stdout|\/dev\/stderr|\$null|nul)$/i;
function neutralizeSafeRedirects(command, shell) {
  const re = SAFE_REDIRECT_RES[shell === undefined ? 'Bash' : shell];
  if (!(re instanceof RegExp)) return null;
  let Q = null;
  let SECRET_RE = null;
  try { Q = require('./forge-gate-quotes.cjs'); } catch { return null; }
  try { SECRET_RE = require('./forge-actiongate.cjs').SECRET_TARGET_RE || null; } catch { SECRET_RE = null; }
  const text = String(command);
  const mask = Q.scanQuotes(text);
  if (!mask || mask.unterminated) return null;
  const parts = [];
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    let quoted = false;
    for (let i = start; i < end; i++) { if (mask.inside(i)) { quoted = true; break; } }
    if (quoted) continue;
    const target = m[2].replace(/^[\d&*]?>>?[ \t]*/, '');
    // a plain file target is only blanked when the secret target list is loadable AND it is not secret-shaped
    if (!NULL_SINK_RE.test(target) && (!SECRET_RE || SECRET_RE.test(target) || target.includes('$'))) continue;
    parts.push(text.slice(last, start), ' '.repeat(end - start));
    last = end;
  }
  if (!parts.length) return text;
  parts.push(text.slice(last));
  return parts.join('');
}

/** glueRedirectAmpersands(text) -> a same-length copy in which every `&` that belongs to a redirect operator (`>&`,
 *  `<&`, `&>`; never the second `&` of `&&`) is a space. WP-GATEFP2: the classifier treats every `&` as a command
 *  separator, so `grep -e abc 3>&2 2>/dev/null .env` and `grep *>&2 .env` put `.env` in a segment with no reading
 *  verb and passed, while real bash printed the file (pre-existing: the hook from before WP-GATEFP allowed them too).
 *  Bash never splits a command there, and in PowerShell such an `&` is a redirect or a parse error. A space and an
 *  `&` are alike to the secret target list, and inside quoted data a space is still data — used for EXTRA
 *  inspections only (a tightening pass that can add a block, and the relax re-check). Linear, quote-blind.
 *  WP-GATEFP3: the bar of the clobber operator `>|` (also `1>|`, `2>|`, `3>|`, ...) is blanked the same
 *  way. The classifier split `cat >|out .env` at the bar into `cat >` and `out .env`; bash reads `[n]>|` as ONE
 *  redirect, so `out` is the target and `.env` stays cat's argument (real Git Bash copied/printed a dummy file for the
 *  bare, 1-, 2- and 3-prefixed forms). In PowerShell `>|` is a parse error ("Missing file specification"), so gluing
 *  there can only over-block. An ESCAPED `\>` is literal in bash and its following `&`/`|` is a real separator —
 *  relaxRefused() refuses the relaxation on an unquoted `\>`, so the re-check never merges at one. */
function glueRedirectAmpersands(text) {
  let chars = null;
  const blank = (i) => { (chars = chars || text.split(''))[i] = ' '; };
  for (let i = text.indexOf('&'); i !== -1; i = text.indexOf('&', i + 1)) {
    const prev = text[i - 1];
    if (prev === '>' || prev === '<' || (text[i + 1] === '>' && prev !== '&')) blank(i);
  }
  for (let i = text.indexOf('|'); i !== -1; i = text.indexOf('|', i + 1)) {
    if (text[i - 1] === '>') blank(i);
  }
  return chars ? chars.join('') : text;
}

/** relaxRefused(command, shell) -> true when the WP-GATEFP relaxation must not run at all. Defence in depth
 *  (WP-GATEFP2; over-blocking is the safe side). Judged on the ORIGINAL text with quoting ignored: a redirect target
 *  that is a variable (only the literal `$null` sink is exempt), a substitution or a process substitution; a backtick;
 *  a PowerShell here-string or stop-parsing `--%` (after it PowerShell passes `2>x` on as a literal argument —
 *  verified); bash `$'`/`$"` quoting or an escaped quote, which the bash-only quote mask cannot place; a WORD that is
 *  a writer once its quotes/backslashes are removed (`"tee" o`, `t"ee" o`, `t\ee o`, `& 'Out-File' o` still run the
 *  writer; quoted search text such as `"x | Out-File"` is not such a word). WP-GATEFP3: judged on
 *  the UNQUOTED text only (quoted characters blanked with the quote mask; a `$(...)` or backtick body inside double
 *  quotes stays visible because it runs): any `<` (input redirect, heredoc, here-string, `<(`), a tee/Tee-Object/
 *  Out-File/Set-Content/Add-Content word, a glob character touching a `>`, and an escaped `\>` (literal in bash, so the
 *  `&`/`|` after it is a real separator the re-check's glue must never merge). So `grep "<tag>.*\.env" src/a.cjs
 *  2>/dev/null` is search data again, while the same text unquoted is refused. Unplaceable quoting (unterminated,
 *  mask unavailable or throwing) refuses.
 *  in PowerShell `*>` / `*>>` / `*>&1` at a token start is a real all-streams redirect (verified: `*>$null X`
 *  passes only `X`), so that `*` is no glob there; in bash (and for any other or omitted shell) it stays refused. */
const RELAX_REFUSE_BLIND_RES = [
  />[>&|]?[ \t]*(?:\$(?!null(?=$|[\s;|&)]))|`|\()/i,
  /`|@["']|\$["']|\\["']|--%/,
];
const RELAX_WRITER_WORD_RE = /(?:^|[\\/])(?:tee|tee-object|out-file|set-content|add-content)(?:\.exe)?$/i;
const RELAX_REFUSE_UNQUOTED_RES = [/</, /\\>/, /\b(?:tee|tee-object|out-file|set-content|add-content)\b/i];
const RELAX_GLOB_RE = /[*?[\]{}][\d&]*>|>[>&|]?[ \t]*[*?[{]/; // touching only: `grep * >&2 .env` keeps its `*` word
const PS_STREAM_STAR_RE = /(^|[\s;|(])\*(?=>)/g;
const RELAX_WORD_BREAK_RE = /[\s;|&()]/;
const isWriterWord = (w) => !!w && (RELAX_WRITER_WORD_RE.test(w.replace(/["']/g, '')) || RELAX_WRITER_WORD_RE.test(w.replace(/["'\\]/g, '')));
function relaxRefused(command, shell) {
  const text = String(command);
  if (RELAX_REFUSE_BLIND_RES.some((re) => re.test(text))) return true;
  let mask = null;
  try { mask = require('./forge-gate-quotes.cjs').scanQuotes(text); } catch { return true; }
  if (!mask || mask.unterminated) return true; // quoting that cannot be placed refuses (fail closed)
  // one linear pass: the unquoted view (quoted characters blanked, same length) and the words split at UNQUOTED breaks
  const chars = text.split('');
  let wordStart = 0;
  for (let i = 0; i <= text.length; i++) {
    const inside = i < text.length && mask.inside(i);
    if (inside) chars[i] = ' ';
    if (i === text.length || (!inside && RELAX_WORD_BREAK_RE.test(text[i]))) {
      if (isWriterWord(text.slice(wordStart, i))) return true;
      wordStart = i + 1;
    }
  }
  const bare = chars.join('');
  if (RELAX_REFUSE_UNQUOTED_RES.some((re) => re.test(bare))) return true;
  return RELAX_GLOB_RE.test(shell === 'PowerShell' ? bare.replace(PS_STREAM_STAR_RE, '$1 ') : bare);
}

/** relaxSecretPrint(verdict, command, shell, pass) -> `verdict`, or the cleared verdict when ONLY harmless output
 *  redirects made a search pattern look like a file (WP-GATEFP). Subtractive only and FAIL CLOSED (WP-GATEFP2, Codex
 *  it has its own try/catch, so an exception, a refused shape, unjudgeable quoting, a watchdog failure or a
 *  re-check that is not fully clean all keep the ORIGINAL block — never evaluate()'s classifier-unavailable branch. */
function relaxSecretPrint(verdict, command, shell, pass) {
  try {
    if (relaxRefused(command, shell)) return verdict;
    const relaxed = neutralizeSafeRedirects(command, shell);
    if (relaxed === null || relaxed === command) return verdict;
    const again = pass(glueRedirectAmpersands(relaxed));
    const v2 = again && again.verdict;
    if (!again || again.final || !v2 || v2.block || v2.warn || (v2.gates && v2.gates.length)) return verdict;
    return { block: false, gates: [], reason: null, why: 'secret-print cleared: only harmless output redirects made the pattern look like a file (WP-GATEFP)' };
  } catch {
    return verdict;
  }
}

/** evaluate(payload, command, opts) -> the ON-verdict { block, warn?, gates, reason, notice, why }. SB-M5 (wave
 *  12): opts.maxCommandChars/opts.deadlineMs/opts.now are test seams (defaults MAX_COMMAND_CHARS/DEADLINE_MS/
 *  Date.now) for the size ceiling and wall-clock deadline described at their own declaration above.
 *
 *  wp-v3 (sec-v1r-H1/L2): this function's OWN job is now narrow — the size ceiling, deciding whether the
 *  watchdog is usable, and mapping whichever result comes back. The entire inspection (stripInertData,
 *  selfDisable, classify, the destructive-delete recheck, scratchPassThrough) lives in ONE shared function,
 *  forge-gate-inspect.cjs::inspect(), called either through the watchdog (normal path) or directly here (the
 *  watchdog-unavailable fallback, and any opts.gate-stubbed test — a test-injected classifier module can never
 *  cross a Worker boundary). opts.watchdog is a test seam overriding the required WATCHDOG module for this one
 *  call (default: the real module-level WATCHDOG; pass null to simulate an environment where
 *  worker_threads/forge-gate-watchdog.cjs itself is unavailable). opts.watchdogTimeoutMs/opts.simulateSlowMs/
 *  opts.simulateCrash/opts.WorkerImpl/opts.SharedArrayBufferImpl/opts.atomicsWait/opts.simulateInspectThrow are
 *  test seams threaded straight through to classifyWithWatchdog(). */
function evaluate(payload, command, opts) {
  const maxChars = opts.maxCommandChars || MAX_COMMAND_CHARS;
  if (command.length > maxChars) {
    const ids = ['command-too-large'];
    return { block: true, gates: ids, reason: blockReason(ids), why: 'command-too-large (' + command.length + ' chars > ' + maxChars + ')' };
  }
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const deadlineMs = opts.deadlineMs || DEADLINE_MS;
  const startedAt = now();

  const watchdogModule = opts.watchdog !== undefined ? opts.watchdog : WATCHDOG;
  // wp-v4 ("the watchdog and worker included"): a missing/deleted WORKER SCRIPT FILE means the same
  // thing as the watchdog MODULE itself being unavailable (no working watchdog-protected path) — both must
  // degrade identically to the inline fallback below, not one gracefully and the other by blocking everything.
  // Only checked for the REAL, non-test-injected watchdog (opts.watchdog === undefined); a test supplying its
  // own opts.watchdog stub is never second-guessed by a filesystem check it may not even need to satisfy.
  const watchdogFileIntact = opts.watchdog !== undefined || !watchdogModule || !watchdogModule.WORKER_SCRIPT
    || fs.existsSync(watchdogModule.WORKER_SCRIPT);
  const useWatchdog = !!watchdogModule && watchdogFileIntact && !opts.gate;
  // sec-v1 M1 / sec-v1r L1: when the watchdog is genuinely unavailable (not merely absent from a test stub via
  // opts.gate), a command past this fail-closed fallback ceiling is refused outright rather than silently
  // running an unbounded, unprotected inline inspection with nothing left to bound it.
  if (!useWatchdog && !opts.gate && command.length > WATCHDOG_UNAVAILABLE_FALLBACK_CHARS) {
    const ids = ['command-too-large'];
    return {
      block: true, gates: ids, reason: blockReason(ids),
      why: 'watchdog-unavailable (' + command.length + ' chars > ' + WATCHDOG_UNAVAILABLE_FALLBACK_CHARS + ' fallback ceiling)',
    };
  }

  const ctx = buildInspectCtx(payload, opts);
  const tooSlow = (elapsedMs) => {
    const ids = ['command-too-large'];
    return { block: true, gates: ids, reason: blockReason(ids), why: 'inspection-deadline-exceeded (' + elapsedMs + 'ms > ' + deadlineMs + 'ms)' };
  };
  // WP-GATEFP2: every pass after the first gets only the time left before the deadline (never the full watchdog
  // budget again), so extra passes cannot add up past the hook's own external timeout; none left -> too slow (block).
  const laterPass = (text) => {
    const elapsedMs = now() - startedAt;
    const left = deadlineMs - elapsedMs;
    if (left <= 0) return { final: tooSlow(elapsedMs) };
    const own = typeof opts.watchdogTimeoutMs === 'number' ? opts.watchdogTimeoutMs : left;
    const capped = Object.assign({}, opts, { watchdogTimeoutMs: Math.max(LATER_PASS_MIN_MS, Math.min(own, left)) });
    return inspectOnce(text, ctx, capped, useWatchdog, watchdogModule);
  };
  try {
    const first = inspectOnce(command, ctx, opts, useWatchdog, watchdogModule);
    if (first.final) return first.final;
    let verdict = first.verdict;
    // WP-GATEFP2 tightening pass: re-inspect with the `&` of `>&`/`<&`/`&>` glued (see glueRedirectAmpersands). It can
    // only ADD a block; a pass that cannot finish returns its own fail-closed verdict.
    const glued = glueRedirectAmpersands(command);
    if (verdict && !verdict.block && glued !== command) {
      const tight = laterPass(glued);
      if (tight.final) return tight.final;
      if (tight.verdict && tight.verdict.block) verdict = tight.verdict;
    }
    // WP-GATEFP: a secret-print-only block is re-judged ONCE with harmless output redirects blanked —
    // subtractive only and fail closed (relaxSecretPrint; WP-GATEFP2 F1-F3).
    if (verdict && verdict.block && Array.isArray(verdict.gates) && verdict.gates.length === 1 && verdict.gates[0] === 'secret-print') {
      verdict = relaxSecretPrint(verdict, command, payload.tool_name, laterPass);
    }
    const elapsedMs = now() - startedAt;
    if (elapsedMs > deadlineMs) return tooSlow(elapsedMs);
    return verdict;
  } catch (e) {
    // Defense in depth (the sec-v1 M1 lesson: never trust a "never throws" claim without covering every path) —
    // classifyWithWatchdog() and inspect() are both designed to never throw/always resolve safely, but a throw
    // here (from either, or INSPECT being unavailable on the inline path) still fails toward the SAME
    // classifier-unavailable handling every prior version used.
    return classifierUnavailableVerdict(command, String(e && e.message || e).split('\n')[0], payload.tool_name);
  }
}

/** classifierUnavailableVerdict(command, msg) -> the pre-wave-13 classifier-unavailable ON-verdict (sec-v3 L1):
 *  a destructive-SHAPED command (FALLBACK_RE) is still BLOCKED (exit 2, fail-closed) even with the real
 *  classifier unreachable; anything else is a VISIBLE, non-blocking "this call was NOT checked" notice (exit 1)
 *  — never a silent allow, and never the (inaccurate) "too large to inspect" wording for a command that was
 *  never actually too large or too slow, just unclassifiable.
 *  FU-A7 closed Codex r10 G6 (it was ACCEPTED as info): FALLBACK_RE has no secret list, so with the classifier
 *  unable to load a secret-file print took the visible exit-1 path. A call FALLBACK_RE misses is now also read by the
 *  cannot-judge keyword scan (riskySignals over cannotJudgeView: AFTER the inert-data rule, so data that only mentions
 *  a keyword is not one) and a hit blocks with the same classifier-unavailable id. FALLBACK_RE itself still reads the
 *  raw text, unchanged. Only a call with no keyword at all keeps the visible exit-1 "NOT checked" notice. The
 *  redirect relaxation's own second-pass failures always keep the first block (relaxSecretPrint). */
function classifierUnavailableVerdict(command, msg, shell) {
  if (FALLBACK_RE.test(command)) {
    const ids = ['classifier-unavailable'];
    return { block: true, gates: ids, reason: blockReason(ids), why: 'classifier-unavailable, fail-closed fallback (' + msg + ')' };
  }
  const risky = riskySignals(cannotJudgeView(command, shell));
  if (risky.length) {
    const ids = ['classifier-unavailable'];
    return { block: true, gates: ids, reason: blockReason(ids), why: 'classifier-unavailable, risky signal (' + risky.join(', ') + ') (' + msg + ')' };
  }
  return { block: false, warn: true, gates: [], notice: cap('forge-gate-hook: classifier unavailable (' + msg + ') — this call was NOT checked'), why: 'classifier-unavailable' };
}

// ---- CANNOT JUDGE + A RISKY KEYWORD -> exit 2 (FU-A7) ----------
// A call this hook cannot judge used to exit 1 in every case: visible, but under Claude Code's hook contract a
// non-blocking pass. The owner's choice (keep "exit 1 = visible and non-blocking", no onFailure in the settings) keeps
// that answer for a call whose command text shows no hard-gate keyword. When it does show one, the call is refused.
// WHICH keywords a text shows is read by forge-gate-cannot-judge.cjs (split out in FU-A7; its header holds the
// keyword rules). The wrappers below keep this file's exports unchanged and fail CLOSED when that module cannot load:
// no keyword can be read then, so every call this hook cannot judge reports `risk-scan-failed` and is refused.
const CANNOT_JUDGE_GATE = 'cannot-judge-risky';
const scanFailed = () => ['risk-scan-failed'];
const riskySignals = CANNOT_JUDGE ? CANNOT_JUDGE.riskySignals : scanFailed;
const createRiskScanner = CANNOT_JUDGE ? CANNOT_JUDGE.createRiskScanner : () => ({ push() {}, signals: scanFailed });
const rawCommandText = CANNOT_JUDGE ? CANNOT_JUDGE.rawCommandText : (raw) => (raw === undefined || raw === null ? '' : String(raw));
const cannotJudgeView = (command, shell) => (CANNOT_JUDGE ? CANNOT_JUDGE.cannotJudgeView(command, shell, WATCHDOG_UNAVAILABLE_FALLBACK_CHARS) : String(command));
const RISKY_SIGNALS = CANNOT_JUDGE ? CANNOT_JUDGE.RISKY_SIGNALS : [];

/** payloadCommandSignals(payload) -> the keyword ids of a parsed PreToolUse shell call's command; [] for every call
 *  decide() would never inspect (another event, another tool, no command). Used when decide() itself failed. */
function payloadCommandSignals(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const ev = payload.hook_event_name;
  if (ev !== undefined && ev !== null && ev !== 'PreToolUse') return [];
  if (!SHELL_TOOLS.has(payload.tool_name)) return [];
  const input = payload.tool_input;
  const command = input && typeof input === 'object' && !Array.isArray(input) ? input.command : null;
  if (typeof command !== 'string' || !command.trim()) return [];
  return riskySignals(cannotJudgeView(command, payload.tool_name));
}

/** cannotJudgeReason(cause, ids) -> the one-line NL/EN block reason. Built here, never from forge-gate-messages.cjs:
 *  a broken wording module is one of the ways this path is reached. */
function cannotJudgeReason(cause, ids) {
  const what = ' (' + ids.join(', ') + '; ' + cause + ')';
  return 'FORGE GATE (' + CANNOT_JUDGE_GATE + '): Forge kan dit commando niet beoordelen en het lijkt riskant' + what
    + ', dus is het voor de zekerheid geweigerd; draai de doctor en probeer het daarna opnieuw. / Forge cannot judge'
    + ' this command and it looks risky' + what + ', so it was refused to be safe; run the doctor and try again.';
}

/** cannotJudgeResult({why, cause, notice}, ids, opts) -> the run()-shaped { exitCode, stderr, why, gates? } for a call
 *  this hook could not judge. No keyword: the old visible exit 1 with `notice` and `why`, unchanged. A keyword: exit 2
 *  with the NL/EN reason, except under a PERSISTENT gate-hook OFF (the owner's own switch; decide() treats every other
 *  block the same way): then the old notice plus the off-notice, exit 1. A pending ONE-OFF approval is never spent
 *  here: there is no command the hook could read to bind it to, so the call is refused. A config that cannot be read
 *  counts as ON, gateHookEnabled's own default. */
function cannotJudgeResult(kind, ids, opts) {
  if (!Array.isArray(ids) || !ids.length) return { exitCode: 1, stderr: kind.notice, why: kind.why };
  let en;
  try { en = gateHookEnabled(opts || {}); } catch { en = { on: true }; } // a config seam that throws reads as ON
  const why = CANNOT_JUDGE_GATE + ' (' + kind.why + ': ' + ids.join(', ') + ')';
  if (en && en.on === false && !en.expires_at) {
    return { exitCode: 1, stderr: kind.notice + '\n' + offNotice(en, [CANNOT_JUDGE_GATE + ': ' + ids.join('+')]), why: why + ', gate-hook-off' };
  }
  return { exitCode: 2, stderr: cannotJudgeReason(kind.cause, ids), why, gates: [CANNOT_JUDGE_GATE] };
}
const firstLine = (e) => String((e && e.message) || e).split('\n')[0];
const shortCause = (e) => 'internal error (' + firstLine(e).slice(0, 160) + ')'; // the block reason stays one short line

/** writeScopeSetting(opts) -> null (the freeze is off: the default) | { raw, mode }. (3.3c). The environment first
 *  (FORGE_WRITE_SCOPE / FORGE_WRITE_SCOPE_MODE: set when Claude Code starts, so an agent cannot change them for this
 *  hook), then forge-config: `write-scope-mode` is a schema key since package 2.9e (enum warn|deny, default warn);
 *  `write-scope` is NOT (the schema has no string/path type), so get() throws unknown_key for it and the config side
 *  simply reads as unset: the scope is env-only. The mode is read only when a scope is set. Test seam:
 *  opts.writeScope = {raw, mode} | null. Never throws. */
function writeScopeSetting(opts) {
  if (opts.writeScope !== undefined) return opts.writeScope;
  const env = opts.env || process.env;
  const cfg = () => resolveConfigModule(opts);
  const read = (key) => {
    try { const m = cfg(); const e = m && typeof m.get === 'function' ? m.get(key) : null; return e && typeof e.value === 'string' && e.value.trim() ? e.value.trim() : null; } catch { return null; }
  };
  const raw = (typeof env.FORGE_WRITE_SCOPE === 'string' && env.FORGE_WRITE_SCOPE.trim()) || read('write-scope');
  if (!raw) return null;
  const mode = (typeof env.FORGE_WRITE_SCOPE_MODE === 'string' && env.FORGE_WRITE_SCOPE_MODE.trim()) || read('write-scope-mode') || 'warn';
  return { raw, mode };
}

/** applyWriteScope(verdict, payload, command, opts) -> the verdict, plus the write-scope result. A call a gate
 *  already blocks is returned as is. Otherwise, with a scope configured: a target PROVABLY outside it blocks only in
 *  mode `deny` (gate id `write-scope`, so the gate-hook off / one-off approval rules below apply to it unchanged);
 *  in mode `warn`, and for every target that cannot be checked, the call stays allowed with a VISIBLE notice (exit 1).
 *  No scope -> nothing changes and nothing is printed. A missing checker or an unknown mode is said out loud. */
function applyWriteScope(verdict, payload, command, opts) {
  if (!verdict || verdict.block) return verdict;
  const set = writeScopeSetting(opts);
  if (!set) return verdict;
  const withNotice = (text) => Object.assign({}, verdict, {
    warn: true, notice: verdict.notice ? verdict.notice + '\n' + cap(text) : cap(text), why: (verdict.why || 'no-gate') + ' + write-scope-notice',
  });
  if (!WRITESCOPE) return withNotice('FORGE WRITE SCOPE: de controlemodule ontbreekt (forge-gate-writescope.cjs), dit commando is NIET gecontroleerd tegen ' + set.raw + ' / the checker module is missing, this call was NOT checked against ' + set.raw);
  const modeOk = WRITESCOPE.MODES.has(set.mode);
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const res = WRITESCOPE.checkWriteScope(command, {
    scopeRaw: set.raw, mode: modeOk ? set.mode : 'warn', shell: payload.tool_name, cwd,
    platform: opts.platform, homedir: opts.homedir, fsImpl: opts.fsImpl,
  });
  const d = WRITESCOPE.describe(res, cap);
  if (d.block) return { block: true, gates: ['write-scope'], reason: d.reason, why: 'write-scope-deny' };
  const notes = [];
  if (!modeOk) notes.push('FORGE WRITE SCOPE: onbekende modus "' + set.mode + '", warn gebruikt / unknown mode "' + set.mode + '", using warn');
  if (d.notice) notes.push(d.notice);
  return notes.length ? withNotice(notes.join('\n')) : verdict;
}

/** applyInlineScriptHint(verdict, payload, command) -> the verdict, plus a VISIBLE notice (exit 1, never a block) when a
 *  Bash call runs `node -e "..."` whose double-quoted script holds a double backslash. Bash turns `\\` into `\` inside
 *  double quotes, so Windows paths and regex escapes reach Node changed (2026-11-05, three times in one session: a
 *  broken regex in checks-hygiene.cjs, a lost path in a settings edit, a regex that matched the start of a file).
 *  The fix is to write the script with a file tool and run the file. A call a gate blocks is returned as is. */
const INLINE_NODE_DQ_RE = /\bnode(?:\.exe)?\s+-e\s+"((?:[^"\\]|\\.)*)"/;
function applyInlineScriptHint(verdict, payload, command) {
  if (!verdict || verdict.block || !payload || payload.tool_name !== 'Bash' || typeof command !== 'string') return verdict;
  const m = INLINE_NODE_DQ_RE.exec(command);
  if (!m || !m[1].includes('\\\\')) return verdict;
  const text = 'FORGE HINT: node -e "..." met \\\\ binnen dubbele aanhalingstekens: bash maakt van \\\\ een enkele \\, dus paden en regex-escapes komen veranderd aan. Schrijf het script naar een bestand en draai dat. / '
    + 'node -e "..." with \\\\ inside double quotes: bash turns \\\\ into a single \\, so paths and regex escapes arrive changed. Write the script to a file and run the file.';
  return Object.assign({}, verdict, { warn: true, notice: verdict.notice ? verdict.notice + '\n' + cap(text) : cap(text), why: (verdict.why || 'no-gate') + ' + inline-script-hint' });
}

/** decide(payload, opts) -> { block, warn, gates, reason, notice, why }. Seams: opts.gate (classifier), opts.config,
 *  opts.projectRoot (scratch-area root), opts.tmpdir, opts.platform. When gate-hook is OFF the verdict is still
 *  computed: a call that WOULD have been blocked is never silently allowed (S07) — an inspection failure stays
 *  visible regardless of on/off, a self-disable attempt still gets the off-notice, and (S06) a call that WOULD
 *  have been blocked while a ONCE-style grant is active must be individually consumed through
 *  forge-config.cjs::consumeOnce(); absent/throwing/refused means BLOCK, fail-closed. */
function decide(payload, opts) {
  opts = opts || {};
  const none = (why) => ({ block: false, gates: [], reason: null, why });
  const unchecked = (why) => ({ block: false, warn: true, gates: [], notice: cap('forge-gate-hook: ' + why + ' — this call was NOT checked'), why });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unchecked('invalid-payload');
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== null) {
    if (typeof payload.hook_event_name !== 'string') return unchecked('invalid-hook-event');
    if (payload.hook_event_name !== 'PreToolUse') {
      // an unrecognised event name is never positively known to be unrelated — visible, not silent.
      if (!KNOWN_HOOK_EVENTS.has(payload.hook_event_name)) return unchecked('unknown-hook-event');
      return none('not-pretooluse');
    }
  }
  if (typeof payload.tool_name !== 'string' || !payload.tool_name) return unchecked('missing-tool-name');
  if (!SHELL_TOOLS.has(payload.tool_name)) return none('not-a-shell-tool');
  const input = payload.tool_input;
  const command = input && typeof input === 'object' && !Array.isArray(input) ? input.command : null;
  if (typeof command !== 'string') return unchecked('missing-or-non-string-command');
  if (!command.trim()) return none('no-command'); // an empty command runs nothing; nothing to classify
  const en = gateHookEnabled(opts);
  const verdict = applyInlineScriptHint(applyWriteScope(evaluate(payload, command, opts), payload, command, opts), payload, command); // no scope -> unchanged; inline-script hint is a notice only
  if (verdict.warn && !verdict.block) return verdict; // S07: an inspection failure is always visible, on or off
  if (en.on) return verdict;
  if (!verdict.block) return none('gate-hook-off (' + en.source + ')');
  if (en.expires_at) {
    // a ONCE-style grant: never a blanket window (S06) — self-disable is never approvable through it either.
    // V03 (codex-recheck 2026-09-24): a self-disable attempt while a grant is PENDING is BLOCKED outright, not
    // merely noticed — a warn-only verdict here would let the plain "set gate-hook off"/"unset gate-hook" call
    // actually EXECUTE and persist a permanent OFF through forge-config.cjs's own writer, upgrading a one-off
    // approval into indefinite disablement. The once-exempt shape itself (`set gate-hook off --once "<quote>"`)
    // never reaches this branch at all — selfDisable() excludes it before evaluate() ever names this gate.
    if (verdict.gates[0] === 'gate-hook-self-disable') {
      return { block: true, gates: verdict.gates, reason: verdict.reason, why: 'gate-hook-once-pending-self-disable-blocked' };
    }
    const cfg = resolveConfigModule(opts);
    let outcome;
    try {
      outcome = (cfg && typeof cfg.consumeOnce === 'function')
        ? cfg.consumeOnce('gate-hook', { commandSha256: sha256(command) })
        : { ok: false, reason: 'consumeOnce-unavailable' };
    } catch (e) {
      outcome = { ok: false, reason: 'consumeOnce-threw (' + String(e && e.message || e).split('\n')[0] + ')' };
    }
    if (outcome && outcome.ok === true) {
      return { block: false, warn: true, gates: verdict.gates, notice: cap('FORGE GATE: one-off approval used for this command (' + verdict.gates.join(', ') + ')'), why: 'gate-hook-once-consumed' };
    }
    return { block: true, gates: verdict.gates, reason: verdict.reason, why: 'gate-hook-once-not-consumed (' + (outcome && outcome.reason || 'unknown') + ')' };
  }
  // a PERSISTENT off (no expiry) is an out-of-band owner action outside this hook's own matcher (e.g. the
  // dashboard); stays visible-but-allowed, unchanged from the pre-codex-recheck behaviour.
  return { block: false, warn: true, gates: verdict.gates, notice: offNotice(en, verdict.gates), why: 'gate-hook-off, would have blocked' };
}

/** run(rawStdin, opts) -> { exitCode, stderr, why, gates? }. Never throws. FU-A7: unparseable stdin and an internal
 *  error go through cannotJudgeResult (exit 2 only when the command text shows a hard-gate keyword). */
function run(rawStdin, opts) {
  const raw = String(rawStdin || '');
  let payload;
  try { payload = JSON.parse(raw); } catch {
    return cannotJudgeResult({ why: 'unparseable-stdin', cause: 'unparseable stdin', notice: 'forge-gate-hook: unparseable stdin, this call was NOT checked' },
      riskySignals(rawCommandText(raw)), opts);
  }
  try {
    const d = decide(payload, opts);
    if (d.block) return { exitCode: 2, stderr: d.reason, why: d.why, gates: Array.isArray(d.gates) ? d.gates.slice() : [] };
    return { exitCode: d.warn ? 1 : 0, stderr: d.notice || '', why: d.why };
  } catch (e) {
    const msg = firstLine(e);
    let ids;
    try { ids = payloadCommandSignals(payload); } catch { ids = ['risk-scan-failed']; } // cannot even scan: refuse
    return cannotJudgeResult({ why: 'internal-error', cause: shortCause(e), notice: 'forge-gate-hook: internal error, this call was NOT checked: ' + msg }, ids, opts);
  }
}

/** syncMaintenance(root) -> true while <root>/.claude/.forge-sync.lock is younger than SYNC_LOCK_STALE_MS (6 h): a
 *  forge-sync run is replacing files there (SYNC-02 maintenance mode). The age comes from the lock's own
 *  started_at/ts, else the file time. Fail-open: no lock, an unreadable root or a lock older than 6 h (left behind by a
 *  crashed run) is "no maintenance". Never throws, never writes. Same rule as forge-sync.cjs::readLockStatus. */
const SYNC_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
function syncMaintenance(root) {
  try {
    const lp = path.join(root, '.claude', '.forge-sync.lock');
    const st = fs.statSync(lp);
    let started = NaN;
    try { const b = JSON.parse(fs.readFileSync(lp, 'utf8')); started = Date.parse(b && (b.started_at || b.ts)); } catch { /* unreadable body: use the file time */ }
    let age = Date.now() - (Number.isFinite(started) ? started : st.mtimeMs);
    if (!(age >= 0)) age = Date.now() - st.mtimeMs; // a lock dated in the future is judged by its file time
    return age < SYNC_LOCK_STALE_MS;
  } catch { return false; }
}

/** recordGateBlocked(raw, runResult, opts) -> {recorded, run_id?, gate?, reason} — (header "RUN RECORD");
 *  opts.obligationsModule injects the helper (null = absent). Never throws, never changes runResult. */
function recordGateBlocked(rawOrPayload, runResult, opts) {
  opts = opts || {};
  const OBL = opts.obligationsModule !== undefined ? opts.obligationsModule : OBLIGATIONS;
  if (!OBL || typeof OBL.recordGateBlock !== 'function') return { recorded: false, reason: 'forge-stop-obligations.cjs unavailable' };
  // WP 2.1: a plugin copy that found no project has nowhere to record into (and never records into the plugin).
  if (!opts.projectRoot && !PROJECT_ROOT) return { recorded: false, reason: 'no project root (a plugin copy outside any project): nothing is recorded' };
  // while forge-sync replaces files in this project, write nothing into it. The verdict itself is
  // unchanged — this only skips the run record.
  if (syncMaintenance(opts.projectRoot || PROJECT_ROOT)) return { recorded: false, reason: 'maintenance mode: a fresh .forge-sync.lock (a sync is running), so nothing is written into the project' };
  try { return OBL.recordGateBlock(rawOrPayload, runResult, Object.assign({ projectRoot: PROJECT_ROOT }, opts)); }
  catch (e) { return { recorded: false, reason: 'internal: ' + String(e && e.message || e).split('\n')[0] }; }
}

module.exports = {
  run, decide, evaluate, gateHookEnabled, commandGateIds, blockReason, selfDisable, scratchPassThrough, tokenize, verbIndex,
  extractTargets, resolveTarget, areaOf, parseConfigCall, isSelfDisableCall, isOnceExempt, sha256,
  SHELL_TOOLS, WORDS, FAILSAFE_MS, MAX_STDIN_BYTES, PROJECT_ROOT, FALLBACK_RE, KNOWN_HOOK_EVENTS,
  fallbackSelfDisableTest, fallbackSelfDisableNormalize, recordGateBlocked, syncMaintenance, SYNC_LOCK_STALE_MS,
  neutralizeSafeRedirects, // WP-GATEFP
  glueRedirectAmpersands, relaxRefused, relaxSecretPrint, SAFE_REDIRECT_RES, // WP-GATEFP2
  writeScopeSetting, applyWriteScope, // (3.3c)
  applyInlineScriptHint, INLINE_NODE_DQ_RE, // notice for node -e "...\\..." in Bash
  riskySignals, createRiskScanner, rawCommandText, cannotJudgeView, cannotJudgeResult, RISKY_SIGNALS, // FU-A7
};

// ---- CLI (PreToolUse hook target). Async stdin collection (proven safe on Windows by forge-toolhook.cjs); every
// path that cannot inspect the call exits 1 — non-blocking but visible to the user (security wp9b M2) — unless the
// bytes it did receive show a hard-gate keyword: then it exits 2 (FU-A7, cannotJudgeResult). Past MAX_STDIN_BYTES
// nothing more is KEPT, but every byte is still SCANNED (createRiskScanner), so a keyword hidden past the limit counts.
if (require.main === module) {
  let finished = false;
  // `after` runs after the verdict text is written; whatever it does or throws, the exit code stays `code`.
  const finish = (code, text, after) => {
    if (finished) return;
    finished = true;
    // synchronous write: an async stderr write can be cut off by process.exit() on a pipe
    if (text) { try { fs.writeSync(2, text + '\n'); } catch { /* nothing left to report to */ } }
    if (typeof after === 'function') { try { after(); } catch { /* best effort — never changes the verdict */ } }
    process.exit(code);
  };
  const chunks = [];
  let size = 0;
  let oversize = false;
  let overScan = null; // FU-A7: created once the payload is too large to keep; then reads every byte
  const receivedSignals = () => (oversize ? overScan.signals() : riskySignals(rawCommandText(Buffer.concat(chunks).toString('utf8'))));
  // FU-A7: a stdin this hook could not read in full. No keyword in what arrived -> the old visible exit 1.
  const cannotJudgeExit = (why, cause) => {
    const notice = 'forge-gate-hook: ' + cause + ', this call was NOT checked';
    let r;
    try { r = cannotJudgeResult({ why, cause, notice }, receivedSignals(), {}); } catch (e) { r = { exitCode: 1, stderr: notice + ' (keyword scan failed: ' + firstLine(e) + ')' }; }
    finish(r.exitCode, r.stderr);
  };
  const failsafe = setTimeout(() => cannotJudgeExit('stdin-timeout', 'stdin did not end in time'), FAILSAFE_MS);
  if (failsafe.unref) failsafe.unref();
  process.stdin.on('data', (c) => {
    size += c.length;
    if (!oversize && size > MAX_STDIN_BYTES) {
      oversize = true;
      overScan = createRiskScanner();
      for (const k of chunks) overScan.push(k);
      chunks.length = 0; // never parsed now: free the memory
    }
    if (oversize) overScan.push(c); else chunks.push(c);
  });
  process.stdin.on('error', () => cannotJudgeExit('stdin-error', 'stdin error'));
  process.stdin.on('end', () => {
    clearTimeout(failsafe);
    if (oversize) { cannotJudgeExit('oversized-stdin', 'payload larger than ' + MAX_STDIN_BYTES + ' bytes'); return; }
    let r, raw = '';
    try { raw = Buffer.concat(chunks).toString('utf8'); r = run(raw); } catch (e) {
      const notice = 'forge-gate-hook: internal error, this call was NOT checked: ' + firstLine(e);
      r = cannotJudgeResult({ why: 'internal-error', cause: shortCause(e), notice }, riskySignals(rawCommandText(raw)), {});
    }
    finish(r.exitCode, r.stderr, r.exitCode === 2 ? () => { recordGateBlocked(raw, r, { elapsedMs: process.uptime() * 1000 }); } : null);
  });
  process.stdin.resume();
}
