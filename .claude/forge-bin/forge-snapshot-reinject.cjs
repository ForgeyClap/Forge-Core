#!/usr/bin/env node
'use strict';
/**
 * forge-snapshot-reinject.cjs — SessionStart hook target, matcher `compact` (owner request 2026-07-29:
 * after a compaction, the very next turn must not have lost the mission). Verified contract (Search Boss,
 * SessionStart's stdin JSON carries `source` (`startup|resume|clear|
 * compact|fork`), and — per the official docs — **whatever this hook writes to stdout is added back into
 * Claude's context.** This is the ONE re-injection point this whole snapshot system relies on.
 *
 * Behavior: if `.claude/.forge-snapshot-due.json` (written by forge-snapshot-marker.cjs's PreCompact hook)
 * exists, read the just-regenerated `.claude/FORGE_SNAPSHOT.md` and print a SHORT, high-signal block to
 * stdout — Mission + Current state + Next actions + one explicit instruction to refresh sections 3-9 from
 * real evidence before continuing — then delete the marker so the NEXT ordinary session-start stays silent.
 * If no marker exists, print NOTHING and exit 0 (this hook fires on every SessionStart with matcher
 * `compact`, i.e. only after an actual compaction, but stays defensive regardless).
 *
 * SIZE DISCIPLINE: re-injection costs real context — this block targets <= ~600 tokens (chars/4 heuristic),
 * well under FORGE_SNAPSHOT.md's own ~2000-token full-document budget. Only 3 of the 10 snapshot sections
 * are ever re-injected; the rest stay in the file, referenced by path, never inlined here.
 *
 * DUAL DEPLOYMENT (same file, byte-identical, two locations — see forge-snapshot-marker.cjs's file header
 * for the identical rationale): project-local `.claude/forge-bin/` (this project's own settings.json) and
 * GLOBAL `~/.claude/forge-bin/` (the global settings.json, firing for every project — resolves the target
 * project root from `CLAUDE_PROJECT_DIR`/cwd, same convention as the marker). A project with no
 * `.claude/FORGE_SNAPSHOT.md` and no due-marker degrades SILENTLY: no output, exit 0.
 *
 * GUARANTEES: never blocks (exit 0 always), never prints a secret (FORGE_SNAPSHOT.md itself never contains
 * one — it only ever holds paths/pointers/short evidenced text, never file bodies), never prints anything
 * when there is no due-marker and SessionStart's source is not "compact" (the common case: an ordinary
 * SessionStart, or one that already consumed its marker). Since a "compact" start without a marker (another
 * copy consumed it) prints only the active run's obligations block, if there is an active run.
 *
 * OWNER SETTING `snapshots` (forge-config.cjs, default ON): OFF -> run() returns
 * {ok:true, skipped:true, printed:false, reason:'owner config snapshots=off'} — nothing printed, nothing read
 * back into context, the due-marker left untouched (nothing written or deleted), exit 0. Same soft-require and
 * project-root rule as forge-snapshot-marker.cjs (read through the fail-safe safeGet; absent/throwing module or a
 * damaged settings file -> ON plus a one-line `config_note`, which the CLI prints after a real re-inject; the
 * GLOBAL copy falls back to the target project's own forge-config.cjs; FORGE_PROJECT_ROOT wins when set).
 *
 * (audit enforcement-core T8):
 *   - OBLIGATIONS: after the snapshot block, the ACTIVE run's outstanding obligations are appended — what
 *     `forge-runcontract.cjs plan` marks overdue or due now, condensed by forge-stop-obligations.cjs to at most
 *     10 lines and OBLIGATIONS_MAX_CHARS characters (its own cap, separate from MAX_CHARS). No active run ->
 *     nothing extra. A corrupt log, a missing checker or a throwing plan FAILS OPEN: the snapshot is still
 *     printed, plus one honest line naming the `plan` command to run by hand. The whole printed text never
 *     exceeds TOTAL_MAX_CHARS.
 *   - session_resumed: when a real compaction resume happened (a due-marker existed, or SessionStart said
 *     source "compact") and an active run exists, ONE session_resumed event is appended to that run through
 *     the project's own log-event.cjs (best effort, hard timeout, never blocks, never retried).
 *   - PROJECT COPY IS AUTHORITATIVE (the "double registration" of the dual deployment above): the due-marker is
 *     claimed by deleting it BEFORE printing; when another copy already consumed it (ENOENT) this copy does not
 *     print the snapshot a second time, but it still prints the obligations and logs session_resumed. And when
 *     THIS file runs as the GLOBAL copy (it is not the project's own forge-bin file) in a project whose
 *     settings.json registers its own copy, it DEFERS (prints nothing, touches nothing) — so the owner fix for
 *     the global copy is a plain file copy of this file to ~/.claude/forge-bin/ (owner queue; never done here).
 *   - opts.source (the CLI passes SessionStart's `source`), opts.obligations / opts.appendEvent (test seams;
 *     false disables), opts.selfFile (test seam for the global-copy detection), opts.now.
 *
 * (same run, usage audit U-05, "exactly 1 re-inject per compaction"):
 *   - ONE CLAIM PER COMPACTION: Claude Code starts every matching hook at once, so two registrations (the project
 *     copy plus a global copy the deferral cannot recognise, or one copy wired twice) used to print twice: the
 *     marker claim above stopped a second SNAPSHOT, but the second copy still printed the obligations block and
 *     logged a second session_resumed. Before printing anything, a copy now creates a claim file exclusively
 *     (flag 'wx' — one creator wins). The loser prints nothing and logs nothing (result `deduped:true`). A claim
 *     belongs to one compaction: it records the due-marker's `at`; a claim older than CLAIM_TTL_MS, or one made
 *     for a different marker (a newer compaction), is taken over.
 *   - The claim lives OUTSIDE the project — <os.tmpdir()>/forge-snapshot-reinject/<sha256 of the resolved
 *     project root>.claim.json (FORGE_REINJECT_CLAIM_DIR or opts.claimDir override the folder) — so it can never
 *     dirty the git worktree that gate evidence requires to be clean.
 *   - FAIL-OPEN: a claim folder or file that cannot be written never suppresses the re-inject; the copy prints as
 *     before and says why in `claim_note`.
 *   - LIMIT (owner queue): a copy older than (the global ~/.claude/forge-bin copy until the owner copies this
 *     file there) knows no claim and prints whenever it reads the marker. If it starts at the very same moment as
 *     the project copy, both can still print the snapshot. The project side cannot stop a copy it does not run.
 *
 * MODEL: run(opts) -> {ok, printed, dueConsumed, root, text|null, skipped?, obligations?, session_resumed?} —
 * pure-ish, testable without a real stdin/stdout pipe (opts.configModule injects a config module; null =
 * "absent"). CLI: reads the stdin JSON (only its `source` is used), calls run(), prints text if any, always
 * exits 0.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_CHARS = 2400; // ~600 tokens (chars/4 heuristic) — see file header SIZE DISCIPLINE
const OBLIGATIONS_MAX_CHARS = 1600; // the obligations block's own cap (<= 10 lines, ~400 tokens)
const TOTAL_MAX_CHARS = MAX_CHARS + 100 + OBLIGATIONS_MAX_CHARS + 200; // snapshot + truncation note + block + slack
const APPEND_TIMEOUT_MS = 2000; // the CLI failsafe is 4s; obligations + one append fit well inside it
// every copy of this hook for one compaction starts within a few seconds (each ends within its 4 s
// failsafe); a claim older than this belongs to an earlier compaction. A newer marker takes over sooner.
const CLAIM_TTL_MS = 60000;
const CLAIM_FUTURE_SLACK_MS = 5000; // a claim stamped slightly in the future (clock step) still counts as fresh

// shared helpers (active run, obligations, one best-effort append). Soft-required: absent or broken ->
// the re-inject works exactly as before (no obligations, no event). The GLOBAL copy has no sibling, so it falls
// back to the target project's own copy.
let OBL_SIBLING = null;
try { OBL_SIBLING = require('./forge-stop-obligations.cjs'); } catch { OBL_SIBLING = null; }
function obligationsModuleFor(root) {
  if (OBL_SIBLING) return OBL_SIBLING;
  try { return require(path.join(root, '.claude', 'forge-bin', 'forge-stop-obligations.cjs')); } // eslint-disable-line global-require
  catch { return null; }
}

let cfg = null;
try { cfg = require('./forge-config.cjs'); } catch { cfg = null; }
function configModuleFor(root) {
  if (cfg) return cfg;
  try { return require(path.join(root, '.claude', 'forge-bin', 'forge-config.cjs')); } // eslint-disable-line global-require
  catch { return null; }
}
/** configRead(key, fallback, opts) -> { value, source, degraded, reason } via forge-config.safeGet (FAIL-SAFE,
 *  review-boss M3: a damaged settings file never switches a flagged feature on). `fallback` is this file's copy of
 *  the schema default, used only when forge-config.cjs is absent or broken; an older copy without safeGet is read
 *  through get(). Never throws. opts.projectRoot = the root this hook acts on (ignored when FORGE_PROJECT_ROOT is
 *  set); opts.configModule injects a module (tests; null = "absent"). */
function configRead(key, fallback, opts) {
  opts = opts || {};
  const mod = opts.configModule !== undefined ? opts.configModule : configModuleFor(opts.projectRoot || process.cwd());
  const o = opts.projectRoot && !process.env.FORGE_PROJECT_ROOT ? { projectRoot: opts.projectRoot } : {};
  let why = 'forge-config.cjs not found';
  try {
    if (mod && typeof mod.safeGet === 'function') {
      const r = mod.safeGet(key, Object.assign({ fallback }, o));
      if (r && typeof r.value === typeof fallback) return r;
      why = 'forge-config gave no usable value';
    } else if (mod && typeof mod.get === 'function') {
      const e = mod.get(key, o);
      if (e && typeof e.value === typeof fallback) return { value: e.value, source: e.source || 'unknown', degraded: false, reason: null };
      why = 'forge-config gave a value of the wrong type';
    }
  } catch (e) { why = 'settings unreadable: ' + ((e && e.message) || e); }
  return { value: fallback, source: 'built-in', degraded: true, reason: why + ' — ' + key + ' uses the built-in ' + JSON.stringify(fallback) };
}
/** configOn(key, def, opts) -> just the value of configRead(). */
function configOn(key, def, opts) { return configRead(key, def, opts).value; }

function resolveProjectRoot(opts) {
  opts = opts || {};
  if (opts.projectRoot) return path.resolve(opts.projectRoot);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return process.cwd();
}

// WP 2.1 (opt-in .forge layout): FORGE_SNAPSHOT.md is read from forge-paths.cjs memoryFile(read) — .forge/memory only
// in a project with a .forge folder (or FORGE_STATE_DIR), else exactly .claude/FORGE_SNAPSHOT.md. The sibling copy is
// tried first, then the target project's own copy (the GLOBAL hook has no sibling); an older or missing copy keeps the
// legacy literal. The .forge-snapshot-due.json marker has no canon key and stays in .claude (shared with the marker).
let FP_SIBLING = null;
try { FP_SIBLING = require('./forge-paths.cjs'); } catch { FP_SIBLING = null; }
function snapshotFileFor(root) {
  let P = FP_SIBLING && typeof FP_SIBLING.memoryFile === 'function' ? FP_SIBLING : null;
  if (!P) { try { P = require(path.join(root, '.claude', 'forge-bin', 'forge-paths.cjs')); } catch { P = null; } } // eslint-disable-line global-require
  if (P && typeof P.memoryFile === 'function') {
    try { return P.memoryFile(root, 'FORGE_SNAPSHOT.md', { read: true }); } catch { /* unresolvable canon: the legacy file */ }
  }
  return path.join(root, '.claude', 'FORGE_SNAPSHOT.md');
}
/** snapshotRelFor(root) — the project-relative pointer shown to the model ('.claude/FORGE_SNAPSHOT.md' in the legacy layout). */
function snapshotRelFor(root) { return path.relative(root, snapshotFileFor(root)).split(path.sep).join('/'); }
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJsonSafe(p) { const t = readFileSafe(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }

/** extractSection(text, heading) -> the body text of the FIRST `## <n>. <heading>` block (case-sensitive
 *  match on the exact heading text this generator always writes), or null if not found — never guesses. */
function extractSection(text, heading) {
  if (!text) return null;
  const re = new RegExp('^##\\s+\\d+\\.\\s+' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^##\s+\d+\./m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function truncate(text, max, pointer) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, '') + '\n_(truncated — see ' + (pointer || '.claude/FORGE_SNAPSHOT.md') + ')_';
}

function normCase(p) { return process.platform === 'win32' ? p.toLowerCase() : p; }
/** sameFile(a, b) — true when both paths name one file (realpath, else device+inode). Never throws. */
function sameFile(a, b) {
  try { if (normCase(fs.realpathSync.native(a)) === normCase(fs.realpathSync.native(b))) return true; } catch { /* fall through */ }
  try {
    const sa = fs.statSync(a, { bigint: true }), sb = fs.statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { return false; }
}
const REINJECT_LEAF = 'forge-snapshot-reinject.cjs';
/** projectRegistersReinject(root) — the project's own settings(.local).json wires ITS OWN copy of this hook
 *  (a cwd-relative or $CLAUDE_PROJECT_DIR command, or the absolute path of the project copy). */
function projectRegistersReinject(root) {
  const projectCopy = normCase(path.join(root, '.claude', 'forge-bin', REINJECT_LEAF).replace(/\\/g, '/'));
  for (const f of ['settings.json', 'settings.local.json']) {
    const t = readFileSafe(path.join(root, '.claude', f));
    if (t == null) continue;
    let j;
    try { j = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); } catch { continue; }
    const list = j && j.hooks && Array.isArray(j.hooks.SessionStart) ? j.hooks.SessionStart : [];
    for (const e of list) {
      for (const h of (e && Array.isArray(e.hooks) ? e.hooks : [])) {
        const cmd = h && typeof h.command === 'string' ? h.command.replace(/\\/g, '/') : '';
        if (!cmd.includes(REINJECT_LEAF)) continue;
        if (cmd.includes('$CLAUDE_PROJECT_DIR/.claude/forge-bin/' + REINJECT_LEAF) || /^node\s+"?\.claude\/forge-bin\//.test(cmd)
          || normCase(cmd).includes(projectCopy)) return true;
      }
    }
  }
  return false;
}
/** deferToProjectCopy(root, opts) -> reason | null. Non-null only when THIS file is not the project's own copy
 *  (i.e. it runs as the global copy), the project HAS its own copy, and the project's settings wire it. */
function deferToProjectCopy(root, opts) {
  try {
    const projectCopy = path.join(root, '.claude', 'forge-bin', REINJECT_LEAF);
    if (!fs.existsSync(projectCopy)) return null;
    if (sameFile(opts.selfFile || __filename, projectCopy)) return null; // this IS the project copy: authoritative
    if (!projectRegistersReinject(root)) return null;
    return 'the project registers its own ' + REINJECT_LEAF + ' (authoritative) — this copy defers';
  } catch { return null; }
}

/** claimPathFor(root, opts) — the one claim file for this project root, outside the project. */
function claimPathFor(root, opts) {
  const dir = (opts && opts.claimDir) || process.env.FORGE_REINJECT_CLAIM_DIR || path.join(os.tmpdir(), 'forge-snapshot-reinject');
  let key = path.resolve(root);
  try { key = fs.realpathSync.native(key); } catch { /* an unresolvable root keys on its resolved spelling */ }
  return path.join(dir, crypto.createHash('sha256').update(normCase(key)).digest('hex').slice(0, 32) + '.claim.json');
}
/** claimCompaction(root, due, opts) -> {won, note?, reason?}. Exactly one copy wins per compaction: an exclusive
 *  create ('wx'); on EEXIST the existing claim is judged — fresh and for the same (or an unknown) marker = this
 *  compaction is taken, stale or made for another marker = taken over. Anything unwritable fails OPEN (won, with a
 *  note). Never throws. */
function claimCompaction(root, due, opts) {
  opts = opts || {};
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const markerAt = due && typeof due.at === 'string' ? due.at : null;
  const code = (e) => (e && e.code) || String((e && e.message) || e).split('\n')[0];
  let p;
  try {
    p = claimPathFor(root, opts);
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch (e) {
    return { won: true, note: 'the re-inject claim folder is not writable (' + code(e) + ') — printed without the one-copy check (fail-open)' };
  }
  const rec = JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, marker_at: markerAt, root: path.resolve(root) });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { fs.writeFileSync(p, rec, { flag: 'wx' }); return { won: true }; }
    catch (e) {
      if (!e || e.code !== 'EEXIST') return { won: true, note: 'the re-inject claim could not be written (' + code(e) + ') — printed without the one-copy check (fail-open)' };
    }
    let prev = null, mtime = null;
    try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { prev = null; } // a claim still being written reads as unknown
    try { mtime = fs.statSync(p).mtimeMs; } catch { mtime = null; }
    const prevMs = prev && Number.isFinite(Date.parse(prev.at)) ? Date.parse(prev.at) : mtime;
    const age = prevMs == null ? Infinity : now - prevMs;
    const fresh = age >= -CLAIM_FUTURE_SLACK_MS && age < CLAIM_TTL_MS;
    const otherMarker = !!(markerAt && prev && typeof prev.marker_at === 'string' && prev.marker_at !== markerAt);
    if (fresh && !otherMarker) return { won: false, reason: 'another copy of this hook already re-injected this compaction (claim ' + Math.max(0, Math.round(age)) + ' ms old) — this copy prints nothing' };
    try { fs.unlinkSync(p); } catch { /* another copy is taking it over too; the next exclusive create decides */ }
  }
  return { won: false, reason: 'another copy of this hook took over the re-inject claim first — this copy prints nothing' };
}

/** obligationsBlock(root, opts) -> {run_id, text|null, due_count, ok, reason}. Never throws. */
function obligationsBlock(root, opts) {
  if (opts.obligations === false) return { run_id: null, text: null, reason: 'disabled' };
  const OBL = opts.obligations || obligationsModuleFor(root);
  if (!OBL || typeof OBL.findActiveRun !== 'function' || typeof OBL.obligationsFor !== 'function') {
    return { run_id: null, text: null, reason: 'forge-stop-obligations.cjs not available' };
  }
  try {
    const act = OBL.findActiveRun(root, { now: opts.now });
    if (!act || !act.run) return { run_id: null, text: null, reason: (act && act.reason) || 'no active run' };
    const ob = OBL.obligationsFor(root, act.run.run_id, { mode: 'reinject', runcontract: opts.runcontract });
    const text = ob && typeof ob.text === 'string' && ob.text ? ob.text.slice(0, OBLIGATIONS_MAX_CHARS) : null;
    return { run_id: act.run.run_id, text, due_count: ob ? ob.due_count : null, ok: !!(ob && ob.ok), reason: ob ? ob.reason : 'no result' };
  } catch (e) {
    return { run_id: null, text: null, reason: 'internal: ' + String((e && e.message) || e).split('\n')[0] };
  }
}

/** logSessionResumed(root, runId, info, opts) -> {ok, reason}. ONE best-effort append; never throws. */
function logSessionResumed(root, runId, info, opts) {
  if (opts.appendEvent === false) return { ok: false, reason: 'disabled' };
  try {
    const OBL = opts.obligations || obligationsModuleFor(root);
    const append = typeof opts.appendEvent === 'function' ? opts.appendEvent : (OBL && typeof OBL.appendRunEvent === 'function' ? OBL.appendRunEvent : null);
    if (!append) return { ok: false, reason: 'forge-stop-obligations.cjs appendRunEvent not available' };
    const fields = {
      agent: 'system', role: 'snapshot-reinject', source: 'compact',
      reason: info.reason || null, snapshot_reinjected: !!info.snapshotPrinted, obligations_due: info.due_count == null ? null : info.due_count,
      note: 'session resumed after a context compaction; the snapshot re-inject printed the run obligations (forge-snapshot-reinject.cjs, WP-6)',
    };
    const r = append(root, runId, 'session_resumed', fields, { timeoutMs: APPEND_TIMEOUT_MS });
    return { ok: !!(r && r.ok), reason: r && r.reason ? r.reason : null };
  } catch (e) {
    return { ok: false, reason: 'internal: ' + String((e && e.message) || e).split('\n')[0] };
  }
}

/** run(opts) -> see file header MODEL. Never throws. */
function run(opts) {
  opts = opts || {};
  const root = resolveProjectRoot(opts);
  const deferred = deferToProjectCopy(root, opts);
  if (deferred) return { ok: true, skipped: true, reason: deferred, printed: false, dueConsumed: false, root, text: null };
  const sc = configRead('snapshots', true, { projectRoot: root, configModule: opts.configModule });
  const note = sc.degraded ? { config_note: sc.reason } : {}; // the CLI prints it after a real re-inject
  if (sc.value === false) {
    return Object.assign({ ok: true, skipped: true, reason: 'owner config snapshots=off', printed: false, dueConsumed: false, root, text: null }, note);
  }
  const duePath = path.join(root, '.claude', '.forge-snapshot-due.json');
  const due = readJsonSafe(duePath);
  const compactResume = opts.source === 'compact';
  if (!due && !compactResume) return Object.assign({ ok: true, printed: false, dueConsumed: false, root, text: null }, note);

  // one copy per compaction prints anything at all (snapshot, obligations) and logs session_resumed.
  const claim = opts.claim === false ? { won: true } : claimCompaction(root, due, opts);
  if (!claim.won) return Object.assign({ ok: true, printed: false, dueConsumed: false, deduped: true, reason: claim.reason, root, text: null }, note);
  const claimNote = claim.note ? { claim_note: claim.note } : {}; // fail-open: printed without the one-copy check

  // claim the marker BEFORE printing. ENOENT = another copy (the global one) consumed it first, so this
  // copy does not print the snapshot a second time. Any other unlink error keeps the old behaviour (print; a
  // leftover marker is re-consumed or ignored next time, never fatal).
  let dueConsumed = false, consumedElsewhere = false;
  if (due) {
    try { fs.unlinkSync(duePath); dueConsumed = true; } catch (e) { consumedElsewhere = !!(e && e.code === 'ENOENT'); }
  }
  const printSnapshot = !!due && !consumedElsewhere;

  let snapshotPart = null;
  if (printSnapshot) {
    const snapFile = snapshotFileFor(root);
    const snapRel = path.relative(root, snapFile).split(path.sep).join('/');
    const snapshotText = readFileSafe(snapFile);
    const mission = snapshotText ? extractSection(snapshotText, 'Mission') : null;
    const currentState = snapshotText ? extractSection(snapshotText, 'Current state') : null;
    const nextActions = snapshotText ? extractSection(snapshotText, 'Next actions') : null;
    const lines = [];
    lines.push('[forge-snapshot] Context was just compacted (reason: ' + (due.reason || 'unknown') + '). Re-injecting the last snapshot so the mission is not lost:');
    if (snapshotText) {
      lines.push('');
      lines.push('MISSION:');
      lines.push(mission || '_(no Mission section found in ' + snapRel + ')_');
      lines.push('');
      lines.push('CURRENT STATE:');
      lines.push(currentState || '_(no Current state section found)_');
      lines.push('');
      lines.push('NEXT ACTIONS:');
      lines.push(nextActions || '_(no Next actions section found)_');
    } else {
      lines.push('_' + snapRel + ' was not found — no prior snapshot to re-inject; this is likely the FIRST compaction on this project._');
    }
    lines.push('');
    lines.push('ACTION REQUIRED: refresh ' + snapRel + ' (sections 3-9) from real evidence before continuing (`node .claude/forge-bin/forge-snapshot.cjs write --reason phase`).');
    snapshotPart = truncate(lines.join('\n'), MAX_CHARS, snapRel);
  }

  // the active run's outstanding obligations, then ONE session_resumed on that run.
  const ob = obligationsBlock(root, opts);
  let obligationsPart = null;
  if (ob.text) {
    obligationsPart = (printSnapshot ? '' : '[forge-snapshot] Context was just compacted; the snapshot was re-injected by another copy of this hook.\n')
      + 'OUTSTANDING RUN OBLIGATIONS:\n' + ob.text;
  }
  let sessionResumed = null;
  if (ob.run_id) sessionResumed = logSessionResumed(root, ob.run_id, { reason: due ? due.reason : 'compact', snapshotPrinted: printSnapshot, due_count: ob.due_count }, opts);

  const parts = [snapshotPart, obligationsPart].filter(Boolean);
  let text = parts.length ? parts.join('\n\n') : null;
  if (text && text.length > TOTAL_MAX_CHARS) text = text.slice(0, TOTAL_MAX_CHARS - 1) + '…';
  const extra = { obligations: { run_id: ob.run_id, due_count: ob.due_count == null ? null : ob.due_count, ok: ob.ok === true, reason: ob.reason || null } };
  if (sessionResumed) extra.session_resumed = sessionResumed;
  if (consumedElsewhere) extra.consumed_elsewhere = true;
  return Object.assign({ ok: true, printed: !!text, dueConsumed, root, text }, extra, note, claimNote);
}

module.exports = {
  run, resolveProjectRoot, extractSection, truncate, configOn, configRead, MAX_CHARS, snapshotFileFor, snapshotRelFor,

  deferToProjectCopy, projectRegistersReinject, sameFile, obligationsBlock, OBLIGATIONS_MAX_CHARS, TOTAL_MAX_CHARS,

  claimCompaction, claimPathFor, CLAIM_TTL_MS,
};

// CLI: node forge-snapshot-reinject.cjs — a hook target, not a discretionary CLI; it never reads argv (no
// --help/flags — command-line arguments are ignored entirely), only SessionStart's own JSON on stdin (only its
// `source` field is used), and always exits 0 within ~4s regardless of input.
// ---- CLI (SessionStart hook target — ALWAYS exits 0, never blocks; stdout IS re-injected into context) ----
if (require.main === module) {
  let done = false;
  const finish = () => { if (done) return; done = true; process.exit(0); };
  const failsafe = setTimeout(finish, 4000);
  if (failsafe.unref) failsafe.unref();
  let data = '';
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('error', finish);
  process.stdin.on('end', () => {
    try {
      // The project root is resolved via CLAUDE_PROJECT_DIR/cwd — never from payload content. Only SessionStart's
      // `source` is read (: "compact" means a real resume even when another copy consumed the marker).
      let source = null;
      try { const p = JSON.parse(data || '{}'); if (p && typeof p.source === 'string') source = p.source; } catch { /* malformed payload never blocks — proceed with cwd resolution */ }
      const result = run({ source });
      if (result.printed && result.text) process.stdout.write(result.text + '\n' + (result.config_note ? '[forge-config] ' + result.config_note + '\n' : ''));
    } catch { /* an advisory hook must never fail session start */ }
    clearTimeout(failsafe);
    finish();
  });
  process.stdin.resume();
}
