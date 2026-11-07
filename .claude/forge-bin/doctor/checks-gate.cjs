'use strict';
/**
 * doctor/checks-gate.cjs — one module of forge-doctor.cjs (WP A11 part 2): context_budget and gate_watchdog_health (the real gate hook run end to end in an isolated copy).
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { claudeDir, contextBudgetTool } = require('./context.cjs');
const { beginnerResult } = require('./checks-setup.cjs');

/** contextBudgetCheck(root) -> the forge-contextbudget.cjs report, or an honest "unavailable" stand-in.
 *  ADVISORY-ONLY and deliberately so: the numbers are ESTIMATES (characters/4, no tokenizer), and failing a
 *  build on an estimate would be exactly the fake precision that check refuses to produce. It is also the
 *  one doctor check that reads files OUTSIDE the project root — read-only, counted, never written (see
 *  forge-contextbudget.cjs's header). A throw is swallowed into ok:true + a reason: a meter must never be
 *  able to take down the doctor it is only advising. */
function contextBudgetCheck(root) {
  if (!contextBudgetTool) return { ok: true, reason: 'forge-contextbudget.cjs module not available (context-budget check unavailable)', posts: [], findings: [], total_approx_tokens: 0 };
  try { return contextBudgetTool.measure(root, {}); }
  catch (e) { return { ok: true, reason: 'forge-contextbudget.measure threw: ' + e.message, posts: [], findings: [], total_approx_tokens: 0 }; }
}

// wp-v4 (sec-v3 L2, independent review): EVERY module file forge-gate-hook.cjs (or something it requires)
// loads, resolved by real path relative to the TARGET project's own forge-bin — never this doctor's own bundled
// copy — so a genuinely broken or out-of-sync install is caught rather than assumed healthy just because the
// doctor's own copies happen to be fine. Deliberately placed OUTSIDE the BEGINNER SETUP section below (this is
// a security/dependency health check, not a beginner preference) so that section's own static guards (exact
// spawnSync call counts, etc.) never have to account for it.
// (2026-09-26 laptop re-audit): forge-config-cli.cjs was already listed below, but its own two
// UNCONDITIONAL top-level requires -- forge-config.cjs and forge-config-text.cjs (never wrapped in
// try/catch, unlike the OPTIONAL siblings forge-config.cjs itself soft-loads lazily inside gateIds()/
// productDefaults(), e.g. forge-autonomy.cjs and forge-prefs.cjs, which are deliberately excluded here) --
// were missing, and forge-config.cjs's own two unconditional requires (forge-config-once.cjs, in turn
// required unconditionally by forge-config-once-store.cjs) were missing too. Found by making this file's
// own test suite's 12 gateWatchdogHealth/printSummary tests genuinely execute (they used to pass a function
// literal to a boolean-style t(name, cond) helper and never actually run): the health check's isolated
// fixture copies EXACTLY this list, so a missing transitive dependency here surfaced as a hard "broken"
// result for forge-config-cli.cjs even though the real installed tree was perfectly healthy -- the same gap
// would also make this check under-report a REAL broken forge-config.cjs/forge-config-text.cjs/
// forge-config-once(-store).cjs in a live install, since the loop below only walks this named list.
const GATE_HOOK_DEPENDENCY_FILES = [
  'forge-gate-hook.cjs', 'forge-gate-watchdog.cjs', 'forge-gate-inspect.cjs',
  'forge-gate-selfdisable.cjs', 'forge-gate-messages.cjs', 'forge-gate-scratch.cjs', 'forge-gate-data.cjs',
  'forge-actiongate.cjs', 'forge-actiongate-position.cjs', 'forge-gate-quotes.cjs', 'forge-config-cli.cjs',
  'forge-config.cjs', 'forge-config-text.cjs', 'forge-config-once.cjs', 'forge-config-once-store.cjs',
  // package 2.9e: the optional write-scope freeze (3.3c). The hook soft-loads it (absent -> a visible "NOT
  // checked" notice when a scope is set); its own only require, forge-gate-quotes.cjs, is listed above.
  'forge-gate-writescope.cjs',
  // FU-A7: the cannot-judge keyword scan (soft-loaded; absent -> every call the hook cannot judge is refused).
  'forge-gate-cannot-judge.cjs',
];
/** canaryGateIds(stderr) -> the gate ids a block names in its first-line header `FORGE GATE (<id>, <id>):` ([] = none).
 *  Only the header counts: the cannot-judge reason repeats keyword ids and the error text later on the same line. */
const GATE_HEADER_RE = /^\s*FORGE GATE \(([^)\n]{1,200})\)/;
function canaryGateIds(stderr) {
  const m = GATE_HEADER_RE.exec(String(stderr || ''));
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}
// forge-gate-classify-worker.cjs is a worker_threads ENTRY POINT, not an ordinary library module: it reads
// `workerData` (populated ONLY inside a real Worker thread) and runs immediately on load, so a plain require()
// on the main thread always throws ("Cannot destructure property 'command' of 'workerData' as it is null") even
// when the file is perfectly healthy — found by actually running this check against the real project before
// trusting it. Checked for EXISTENCE only below; the end-to-end spawnHook() calls exercise it for real, inside
// an actual worker, exactly like production.
const GATE_HOOK_WORKER_ENTRY_FILE = 'forge-gate-classify-worker.cjs';
// sec-v3r M1 (independent re-review): used ONLY to read back the gate-hook state of the THROWAWAY isolated
// copy gateWatchdogHealth() builds for itself below (via an explicit opts.projectRoot/configHome override,
// never the real machine's actual config) — a self-check that the isolation actually produced a clean start
// state before the destructive canary runs, never a read of the real project's own current setting.
let CFG = null;
try { CFG = require('../forge-config.cjs'); } catch { CFG = null; }

/** buildIsolatedGateProject() -> { root, home, env, cleanup() } — a throwaway, fully isolated project+home
 *  pair for gateWatchdogHealth's own end-to-end spawn (fixing a regression introduced in wp-v4).
 *  `root`/`home` are freshly created empty directories; NO FORGE_CONFIG.json is ever written into either, so
 *  forge-config.cjs's own get('gate-hook') resolves to the schema DEFAULT (protective, ON) with no once-grant
 *  ever pending — never the real project's or the real machine's actual current setting or once-store.
 *  `env` is a full process.env copy with FORGE_PROJECT_ROOT/FORGE_CONFIG_HOME (and CLAUDE_PROJECT_DIR, for
 *  good measure) pointed at these two throwaway directories — confirmed by inspection to be the ONLY two
 *  inputs forge-config.cjs's own pathsFor() ever reads for its DATA files (SCHEMA_PATH_DEFAULT is a fixed,
 *  __dirname-relative path, never affected by either). The REAL, UNMODIFIED forge-gate-hook.cjs is still
 *  spawned from its real, installed location (never copied) — this stays a genuine test of the INSTALLED
 *  copy, only its config/once-store I/O is redirected. `cleanup()` never throws — best-effort only. */
function buildIsolatedGateProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-gate-health-'));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    root, home,
    env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root, FORGE_CONFIG_HOME: home, CLAUDE_PROJECT_DIR: root }),
    cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort only */ } },
  };
}

/** gate-watchdog-health — wp-v3 (sec-v1r, item 4) originally checked ONLY forge-gate-watchdog.cjs and claimed
 *  "the full inspection pipeline runs watchdog-protected" from that alone — sec-v3 L2 correctly called this an
 *  overclaim: loading ONE module proves nothing about the other eleven files the hook also needs, and loading
 *  code proves nothing about whether the DEPLOYED hook actually classifies a real command correctly end to end.
 *
 *  Fixed in two steps. (1) Resolve (fresh require, never a stale cache entry from an earlier doctor run in this
 *  same process) EVERY file in GATE_HOOK_DEPENDENCY_FILES, catching both a MISSING file and a PRESENT-but-broken
 *  (syntactically invalid) one. (2) Run the REAL forge-gate-hook.cjs end to end as a genuine spawned process —
 *  exactly how Claude Code invokes it — on two benign-timing canaries: a harmless command (must exit 0) and a
 *  harmless DESTRUCTIVE-SHAPED string (`rm -rf` on a canary path that is never created and never touched — it is
 *  only ever classified, never executed) which must exit 2 (BLOCKED). The gate ids the canary's block NAMES (its
 *  first line) also decide the verdict: destructive-delete = the REAL classifier engaged, classifier-unavailable =
 *  only the cruder FALLBACK_RE fail-closed fallback did (both are "safe", but they are not the same thing, and
 *  wp-v4's own M1/L1 fixes are exactly what makes the fallback path reachable at all without a crash); any other id
 *  (cannot-judge-risky since FU-A7, command-too-large) means the hook could not judge the canary: a WARN.
 *
 *  ADVISORY, NOT ENFORCED — a deliberate choice, not an oversight (sec-v3 L2 asked for this to be explained).
 *  Three reasons: (a) the doctor's own `tests` check is ALREADY enforced and runs forge-gate-hook.test.cjs +
 *  forge-actiongate.test.cjs on every doctor call — a regression in the gate-hook's own logic is already a hard
 *  failure there; this check is a complementary signal (proving the INSTALLED copy works, not just the test
 *  suite's copy), not the only line of defense. (b) wp-v4's own M1 fix means even a WORST-CASE broken
 *  dependency still fails closed (blocks the destructive canary) rather than failing open — the exact
 *  "fallback itself is safe" precedent wp-v3 already established for the narrower watchdog-only check stays
 *  true here too, now proven for the WHOLE dependency set instead of assumed. (c) spawning a real child process
 *  as a HARD gate risks a doctor that cannot pass AT ALL in a sandboxed/CI environment that restricts spawning —
 *  a flaky enforced check would erode trust in doctor.ok more than an honest advisory warning does. If this
 *  check ever DOES report the destructive canary NOT blocked, that is a severe, doubly-layered failure (both
 *  the real classifier AND FALLBACK_RE failed) worth treating as an emergency regardless of the advisory label. */
function gateWatchdogHealth(root, opts) {
  const o = opts || {};
  const bin = path.join(claudeDir(root), 'forge-bin');
  const hookPath = path.join(bin, 'forge-gate-hook.cjs');
  const allFiles = GATE_HOOK_DEPENDENCY_FILES.concat([GATE_HOOK_WORKER_ENTRY_FILE]);
  const missing = allFiles.filter((f) => !fs.existsSync(path.join(bin, f)));
  if (missing.length) {
    return beginnerResult('gate-watchdog-health', 'warn',
      missing.length + ' hook dependency file(s) missing from ' + bin + ': ' + missing.join(', ')
      + ' — forge-gate-hook.cjs is designed to degrade safely (never runs a command unchecked) even so, but has '
      + 'NOT been run end-to-end to confirm that here', { present: false, missing });
  }
  const broken = [];
  for (const f of GATE_HOOK_DEPENDENCY_FILES) {
    try {
      const resolved = require.resolve(path.join(bin, f));
      delete require.cache[resolved];
      require(resolved);
    } catch (e) {
      broken.push(f + ' (' + String((e && e.message) || e).split('\n')[0] + ')');
    }
  }
  if (broken.length) {
    return beginnerResult('gate-watchdog-health', 'warn',
      broken.length + ' hook dependency file(s) fail to load: ' + broken.join('; ')
      + ' — forge-gate-hook.cjs is designed to degrade safely even so, but has NOT been run end-to-end to '
      + 'confirm that here', { present: true, broken });
  }
  // sec-v3r M1 (independent re-review, closes a regression introduced in wp-v4): the canaries below now run
  // against a fully ISOLATED, throwaway project+home pair (buildIsolatedGateProject, above) — never the real
  // project's own config or once-store. Before this fix, spawning with cwd:root made forge-config.cjs (loaded
  // from its real, unmodified location — its data-file paths are __dirname/env-relative, never cwd-relative)
  // read/write the REAL project's FORGE_CONFIG.json and once-store: a pending owner one-off approval would be
  // SPENT on this canary (consumeOnceGrant has no way to tell "the doctor's own canary" apart from "the
  // command the owner actually approved" — the sha256 is evidence only, never verified against anything, see
  // forge-config-once-store.cjs's own header), and a persistently-off gate would make this check report a
  // false malfunction instead of recognising it never touched anything real. opts.isolated (test seam only,
  // used by forge-doctor.test.cjs's own "grant stays unspent" test) lets a caller reuse a specific throwaway
  // pair it already armed a grant in, instead of always getting a brand-new empty one.
  const isolated = o.isolated || buildIsolatedGateProject();
  const ownsIsolated = !o.isolated;
  try {
    // A self-check on our OWN isolation setup, never a read of the real project: confirm the throwaway copy
    // actually starts clean (gate on, no once-grant pending) before running the destructive-shaped canary
    // through it. Cannot confirm (module unavailable, or the read itself throws) -> skip the canary rather
    // than assume — this ADVISORY check simply could not safely proceed this time.
    let gateState = null;
    if (CFG && typeof CFG.get === 'function') {
      try {
        const e = CFG.get('gate-hook', { projectRoot: isolated.root, configHome: isolated.home });
        gateState = { on: e.value !== false, pending: !!e.expires_at };
      } catch { gateState = null; }
    }
    if (!gateState || !gateState.on || gateState.pending) {
      return beginnerResult('gate-watchdog-health', 'warn',
        'skipped the destructive-shaped canary this time: could not confirm the throwaway isolated copy this '
        + 'check builds for itself starts clean (gate on, no one-off pending) before running it — this says '
        + 'nothing about the real project\'s own gate-hook setting, only that this ADVISORY check could not '
        + 'safely proceed', { present: true, isolated_gate_state: gateState });
    }
    const spawnSyncImpl = o.spawnSyncImpl || require('child_process').spawnSync;
    const spawnHook = (command) => {
      try {
        const r = spawnSyncImpl(process.execPath, [hookPath], {
          input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
          encoding: 'utf8', timeout: o.timeoutMs || 8000, cwd: isolated.root, env: isolated.env,
        });
        return { status: r.status, stderr: r.stderr || '', error: r.error || null, signal: r.signal || null };
      } catch (e) {
        return { status: null, stderr: '', error: e, signal: null };
      }
    };
    const harmless = spawnHook('echo forge-doctor-gate-watchdog-health-check');
    // never executed, only classified — a canary path under a name this project would never actually use.
    const canary = spawnHook('rm -rf ./__forge_doctor_gate_watchdog_health_canary__/do-not-create-this-path');
    const harmlessOk = harmless.status === 0 && !harmless.error && !harmless.signal;
    const canaryBlocked = canary.status === 2 && !canary.error && !canary.signal;
    // FU-A7: judged by the gate ids the block NAMES, never by a word anywhere in stderr. Since FU-A7 a hook that
    // cannot judge a call still refuses a keyword call (cannot-judge-risky), so exit 2 alone no longer proves the
    // classifier ran: only destructive-delete (the real classifier) or classifier-unavailable (FALLBACK_RE) count.
    const canaryGates = canaryGateIds(canary.stderr);
    const realClassifierEngaged = canaryBlocked && canaryGates.includes('destructive-delete');
    const fallbackEngaged = canaryBlocked && !realClassifierEngaged && canaryGates.includes('classifier-unavailable');
    if (!harmlessOk || !canaryBlocked) {
      return beginnerResult('gate-watchdog-health', 'warn',
        'the real hook did NOT behave as expected end-to-end (isolated throwaway copy, never the real '
        + 'project\'s own config or once-store): a harmless command exited ' + harmless.status + ' (wanted 0), '
        + 'a harmless destructive-SHAPED canary (never executed, only classified) exited ' + canary.status
        + ' (wanted 2, BLOCKED)', { harmless, canary });
    }
    if (!realClassifierEngaged && !fallbackEngaged) {
      return beginnerResult('gate-watchdog-health', 'warn',
        'the hook could not judge the harmless destructive-SHAPED canary (never executed, only classified): it was '
        + 'refused (exit 2) as ' + (canaryGates.join(', ') || 'an unnamed block') + ', not by the real classifier or its '
        + 'fail-closed fallback. Nothing ran unchecked, but the hook is broken: run the gate-hook test suite to find the part',
        { present: true, harmless_exit: harmless.status, canary_exit: canary.status, canary_gates: canaryGates, real_classifier_engaged: false });
    }
    return beginnerResult('gate-watchdog-health', 'ok',
      'the real hook was run end-to-end against an isolated throwaway copy (never the real project\'s own '
      + 'config or once-store): a harmless command exited 0, and a harmless destructive-SHAPED canary (never '
      + 'executed, only classified) was BLOCKED (exit 2) by ' + (realClassifierEngaged ? 'the real classifier' : 'the fail-closed fallback — the real classifier itself may be degraded, see any dependency warning above'),
      { present: true, harmless_exit: harmless.status, canary_exit: canary.status, canary_gates: canaryGates, real_classifier_engaged: realClassifierEngaged });
  } finally {
    if (ownsIsolated) isolated.cleanup();
  }
}

module.exports = {
  contextBudgetCheck, GATE_HOOK_DEPENDENCY_FILES, GATE_HOOK_WORKER_ENTRY_FILE, CFG, buildIsolatedGateProject,
  gateWatchdogHealth,
};
