// Forge Command Center gateway — pending-permission store (WP B3).
//
// One record per tool call that Claude Code routed to the forge-ask permission prompt tool
// (ask-mcp.mjs `permission_prompt`, wired by exec-argv.mjs with --permission-prompt-tool). The MCP
// subprocess registers the request over HTTP (routes/permissions.mjs) and then long-polls for the
// decision; the dashboard lists the pending records and answers them.
//
// Rules this store keeps (plan 4.4, contract _scratch/b3/contract-permissions.md):
//   - An unanswered request NEVER turns into a deny. After PAUSE_AFTER_MS it is marked `paused`
//     (status "Gepauzeerd" in the UI) and keeps waiting; the run's wall-clock reaper is paused for
//     as long as at least one request of that conversation is open (hooks set by exec-lifecycle).
//   - Every decision is logged as a conversation event: permission_requested, permission_paused,
//     permission_answered, permission_auto_allowed (an "Altijd toestaan in dit gesprek" rule
//     matched), permission_abandoned (the run ended before anyone answered).
//   - "Altijd toestaan in dit gesprek" (allow_session) remembers the rule-table session key
//     (rules.mjs sessionRuleKey: an allow-list of WebSearch, WebFetch by origin host:port and the
//     forge-ask tool; never a shell, edit, read or unknown tool), in memory, per conversation, for
//     the lifetime of this gateway process. Every record carries
//     `rememberable` (true only when such a key exists) so the card can hide that button. A request
//     without a key (EVERY Bash/PowerShell command, a delete, a path outside the project folder) is
//     allowed once: an allow_session answer on it acts exactly like allow and is logged with
//     remembered:false.
//   - Long-poll binding (WP B3-sec-impl): a wait for a request of another conversation is answered
//     as unknown, so the forge-ask server of one conversation cannot read another one's decisions.
//   - Nothing this store shows or logs carries a gateway token: every public row and event payload
//     goes through redactDeep() and security.mjs scrubGatewayTokens().
//   - The helper that asked is resolved from the stream: a tool_use block seen on a line with a
//     parent_tool_use_id belongs to the subagent dispatched by that parent Agent tool_use.
//   - Autonomy (WP-AUTONOMY-GW, owner decision R-0203): every record carries `gate` (hard-gate.mjs:
//     { hard, code, reason_nl }), `project` and a short `command_preview`. When the autonomy check
//     wired in by server.mjs createServer() (setPermissionAutonomy) says yes for the conversation's
//     project and the allow-list proved the card safe (gate.code 'routine': hard-gate.mjs + allow-list.mjs),
//     it is answered allow at once: status auto_allowed, a permission_auto_allowed event with the reason,
//     and one line in the auto-allow log (listAutoAllowed). Nothing wired, an unknown project, a hard gate
//     or a card the allow-list cannot prove safe ('not_allowlisted'): the card waits as before.
//   - Write-then-run (HIGH-2): a test runner, build, lint or typecheck runs the project's code. Every
//     card and every tool call seen in the stream (also an edit Claude Code accepted itself, and a subagent's)
//     that writes a file a run may execute (hard-gate.mjs codeWriteTargets) marks its place with a rising
//     number. A card in a folder with a mark newer than what the owner last approved running there is
//     classified with codeWritten: its runner asks ('wrote_code'). The owner allowing such a card clears the
//     marks up to the number the card was made at (a write after that keeps the folder marked). Marks are per
//     folder, not per conversation (another conversation in the same project sees them).
//   - Verify round 8:
//     F2  the clearing is per runner FAMILY (allow-list.mjs runnerFamily): approving a lint or typecheck does not
//         cover the tests, approving the tests does not cover the build. The classifier gets `codeWritten` as a
//         function of the family and names every family the card runs (record.runners).
//     A4  while a card that writes code waits for the owner, a runner in its folder asks; when the owner allows such a
//         card its write lands then, so it is marked again at that moment (postRunWrites). An owner-allowed package
//         script other than test/lint/typecheck, or vite build, marks the folder too (it writes code when it runs).
//     F3  the marks survive a restart: permissions/code-marks.mjs (~/.forge/permissions/code-marks.json, atomic,
//         bounded, a 30-day safety-floor expiry (was 24 hours), a corrupt file marks every folder once). Saved at most once a second (a burst of
//         writes is one save; a stop of the process saves what is left).
//     F1  a subagent's cards are judged where it works: the stream (and an Agent or Task card) tells where each
//         subagent was started (hard-gate.mjs dispatchFolder). A card of a subagent started with a cwd outside the run
//         folder waits ('outside_folder'), and so does every card the stream has not placed yet while such a subagent
//         runs in the conversation (until its run ends). A known limit: a runner card that reaches the gateway BEFORE
//         the card of a write that runs at the same time (two agents in parallel) cannot see that write.
//   - Round 11 (L1): the marks only know writes this gateway saw, so code already on disk was never seen
//     run. The first runner of each family in a folder after a start asks ('first_runner'); the owner allowing it
//     clears that family there like a 'wrote_code' card does.
//   - WP-AUTO-REWORK (owner rule "Remote autonomy"): that asked once per folder PER FAMILY, so every lane
//     worktree and every runner family asked. Inside the gateway's project root (PROJECT_ROOT: lane worktrees under
//     .claude/worktrees and _scratch included) one owner-approved runner card per start now covers every family and
//     folder; folders outside the root keep the per-folder/family card. 'wrote_code' is unchanged (per folder/family).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendConversationEvent, listConversations } from '../conversations.mjs';
import { PROJECT_ROOT } from '../paths.mjs';
import { realLocation } from '../remote/real-location.mjs';
import { redact, redactDeep } from '../redact.mjs';
import { scrubGatewayTokens } from '../security.mjs';
import { classifyPermission, sessionRuleKey } from './rules.mjs';
import { classifyHardGate, codeWriteTargets, postRunWrites, dispatchFolder, folderStillInside, HARD_GATE_REASONS } from './hard-gate.mjs';
import { loadCodeMarks, saveCodeMarks, CODE_MARKS_TTL_MS, _setCodeMarksDirForTests as setCodeMarksDir, enableCodeMarkPersistence as enableMarks } from './code-marks.mjs';

export const PERMISSION_BEHAVIORS = Object.freeze(['allow', 'allow_session', 'deny']);

const DEFAULT_PAUSE_AFTER_MS = 5 * 60 * 1000;
const MAX_PENDING_TOTAL = 200;
const MAX_TRACKED_TOOL_USES = 4000;
const DENY_MESSAGE = 'The user declined this action in Forge. Do not retry it; continue without it or ask the user.';

const pending = new Map(); // id -> record
// A decision made between two long-poll rounds of the MCP client must not be lost: answered and
// abandoned records stay readable here (decision only) for DECIDED_TTL_MS.
const decided = new Map(); // id -> { decision, convId, expiresAt }
const DECIDED_TTL_MS = 10 * 60 * 1000;
const MAX_DECIDED = 500;
const sessionAllow = new Map(); // convId -> Set<kind>
const toolParents = new Map(); // convId -> Map<toolUseId, parentToolUseId>
const dispatchAgents = new Map(); // convId -> Map<agentToolUseId, subagentType>
const pausedByPermission = new Set(); // convIds whose run reaper this store paused
const runFolders = new Map(); // convId -> the running turn's project folder (for outside_folder)
// F8 (security review rv-autonomy-sec): conversations whose latest turn came from a phone on a LAN
// (cleartext) bridge. Their cards are never auto-allowed: a sniffed device token must not become code
// that runs on the PC without the owner seeing a card. M1 (rv-autonomy-sec-2): set before a LAN phone
// turn starts and when a LAN phone answers an ask of the conversation; cleared only by a turn from the
// dashboard that really started.
const lanPhoneTurns = new Set();

// Write-then-run: see the header. codeSeq rises with every write seen; '*' is a write whose place is unknown.
// a place is kept by its REAL location (remote/real-location.mjs: a junction or symlink, an 8.3 short
// name and the letter case all resolve to one path; a trailing slash is gone), so a write through one spelling of a
// folder marks every other spelling. A write marks its target AND the folder of the run that made it; a card looks at
// its own folder, the conversation's run folder and the repository each of them is in (a write in P marks P/sub, a
// write in P/sub2 marks its sibling P/sub).
let codeSeq = 0;
const codeWrites = new Map(); // place key (a file or folder) -> { seq, at } of the last write seen there
const codeCleanAt = new Map(); // project folder key -> Map<runner family, { seq, at }>: up to where the owner approved running it
const MAX_CODE_WRITES = 2000;
const MAX_CLEAN_FOLDERS = 500;
const SAVE_GAP_MS = 1000;
let marksLoaded = false; // F3: read from disk at the first use after a start
let firstRunnerAsks = true; // test-only switch (_setFirstRunnerForTests): the write-mark suites of rounds 6-10 turn it off
let startSeq = 0; // round 11 (L1): the write number of this start; a family not approved in a folder since then asks once
let firstRunRoot = PROJECT_ROOT; // WP-AUTO-REWORK: the root one first-run approval covers (test seam: _setFirstRunRootForTests)
let rootRunApproved = false; // WP-AUTO-REWORK: the owner allowed a runner card inside firstRunRoot since this start
let marksUnsaved = false;
let repairPending = false; // the file read at the start was broken; the next save repairs it
let lastSaveAt = 0;
let saveTimer = null;
let exitHook = false;
const isUncPath = (p) => /^[\\/]{2}/.test(p);
const codeKey = (p) => {
  if (!p || p === '*') return '*';
  const r = path.resolve(p);
  const real = isUncPath(r) ? r : realLocation(r) || r; // a network path is never touched
  return process.platform === 'win32' ? real.toLowerCase() : real;
};
const within = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** the marks of earlier runs of this gateway, once. A corrupt file marks every folder (fail closed). */
function ensureMarks() {
  if (marksLoaded) return;
  marksLoaded = true;
  loadMarks();
  codeSeq += 1;
  startSeq = codeSeq;
}

function loadMarks() {
  let got = null;
  try { got = loadCodeMarks(); } catch { got = { corrupt: true }; }
  if (!got) return;
  if (got.corrupt) {
    codeSeq += 1;
    codeWrites.set('*', { seq: codeSeq, at: Date.now() });
    repairPending = true; // the next save rewrites the file without marking everything a second time
    persistMarks();
    return;
  }
  codeSeq = Math.max(codeSeq, got.seq);
  for (const [k, m] of got.writes) { const cur = codeWrites.get(k); if (!cur || cur.seq < m.seq) codeWrites.set(k, m); }
  for (const [k, families] of got.clean) {
    const cur = codeCleanAt.get(k) || new Map();
    for (const [f, m] of families) { const c = cur.get(f); if (!c || c.seq < m.seq) cur.set(f, m); }
    codeCleanAt.set(k, cur);
  }
}

/** Saves the marks soon: at once when the last save is a second old, else one save for the whole burst. */
function persistMarks() {
  marksUnsaved = true;
  if (!exitHook) { exitHook = true; process.once('exit', () => flushMarks()); }
  const wait = lastSaveAt + SAVE_GAP_MS - Date.now();
  if (wait <= 0) { flushMarks(); return; }
  if (!saveTimer) {
    saveTimer = setTimeout(flushMarks, wait);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }
}

function flushMarks() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!marksUnsaved) return;
  marksUnsaved = false;
  lastSaveAt = Date.now();
  try { saveCodeMarks({ seq: codeSeq, writes: codeWrites, clean: codeCleanAt }, Date.now(), { merge: mergeDiskMarks }); } catch { /* best effort: the marks stay in memory */ }
}

/**
 * a save merges what is on disk first, so two gateways that share the marks file keep each other's marks.
 * A write mark on disk that is newer (by time) than this gateway's own mark for that place is taken over with a new
 * number of this gateway: it counts as unseen by every runner family here until the owner approves a run again (the
 * other gateway's numbers do not compare with these). Another gateway's approvals are not taken over (fail closed). A
 * file that is broken while this gateway runs marks every folder once more; right after a broken file was read at the
 * start it is only rewritten.
 */
function mergeDiskMarks(disk) {
  if (disk && disk.corrupt) {
    if (!repairPending) { codeSeq += 1; codeWrites.set('*', { seq: codeSeq, at: Date.now() }); }
  } else if (disk && disk.writes) {
    for (const [k, m] of disk.writes) {
      const cur = codeWrites.get(k);
      if (!cur || cur.at < m.at) { codeSeq += 1; codeWrites.set(k, { seq: codeSeq, at: m.at }); }
    }
    if (codeWrites.size > MAX_CODE_WRITES) { codeSeq += 1; const mark = { seq: codeSeq, at: Date.now() }; codeWrites.clear(); codeWrites.set('*', mark); }
  }
  repairPending = false;
  return { seq: codeSeq, writes: codeWrites, clean: codeCleanAt };
}

function noteCodeWrites(targets, folder) {
  if (!Array.isArray(targets) || targets.length === 0) return;
  ensureMarks();
  codeSeq += 1;
  const mark = { seq: codeSeq, at: Date.now() };
  for (const t of targets) codeWrites.set(codeKey(t), mark);
  if (typeof folder === 'string' && folder.length > 0) codeWrites.set(codeKey(folder), mark);
  if (codeWrites.size > MAX_CODE_WRITES) { codeWrites.clear(); codeWrites.set('*', mark); } // too many places: somewhere
  persistMarks();
}

/** the owner approved running `families` in folder key `k` up to write number `seq`. */
function setClean(k, families, seq) {
  if (!k || !families || families.length === 0) return;
  const m = codeCleanAt.get(k) || new Map();
  const at = Date.now();
  for (const f of families) { const c = m.get(f); if (!c || c.seq < seq) m.set(f, { seq, at }); }
  codeCleanAt.delete(k);
  codeCleanAt.set(k, m); // the newest last, so the oldest goes first when there are too many
  while (codeCleanAt.size > MAX_CLEAN_FOLDERS) codeCleanAt.delete(codeCleanAt.keys().next().value);
  persistMarks();
}

/** The repository a folder key is in: the nearest folder (itself or above) holding .git; null at the home folder or a
 *  drive root, which are never one project. */
function repositoryOf(key) {
  if (!key || key === '*' || isUncPath(key)) return null;
  const home = codeKey(os.homedir());
  let dir = key;
  for (let k = 0; k < 40; k++) {
    if (dir === home || path.dirname(dir) === dir) return null;
    try { fs.statSync(path.join(dir, '.git')); return dir; } catch { /* go up */ }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * The `codeWritten` function for the classifier: `(family) => true` when the card's `folder` (also the
 * conversation's run folder, and the repository either is in) holds a write newer than what the owner approved running
 * with that runner family in `folder`, or a card that writes code there still waits for the owner (A4). A mark expires
 * only at the 30-day safety floor; until then only an owner-approved runner of its family clears it.
 */
/** WP-AUTO-REWORK: folder key `k` is inside the project root. Fails closed (false) when the root is missing, the home
 *  folder, a drive root or a UNC path: such a root is never one project. */
function inFirstRunRoot(k) {
  if (!k || k === '*' || typeof firstRunRoot !== 'string' || firstRunRoot.length === 0) return false;
  const root = codeKey(firstRunRoot);
  if (!root || isUncPath(root) || root === codeKey(os.homedir()) || path.dirname(root) === root) return false;
  return within(root, k);
}

function dirtyChecker(folder, runFolder) {
  if (!folder) return false; // without a folder the classifier asks anyway
  ensureMarks();
  const k = codeKey(folder);
  const scopes = [...new Set([k, runFolder ? codeKey(runFolder) : null].flatMap((s) => [s, repositoryOf(s)]).filter(Boolean))];
  const inScope = (w) => w === '*' || scopes.some((sc) => within(sc, w) || within(w, sc));
  const waitingWrite = [...pending.values()].some((r) => (r.status === 'waiting' || r.status === 'paused') && r.write_keys.some(inScope));
  return (family) => {
    if (waitingWrite) return true;
    const m = codeCleanAt.get(k);
    const c = m && m.get(family);
    const clean = c ? c.seq : 0;
    const now = Date.now();
    for (const [w, mark] of codeWrites) if (mark.seq > clean && now - mark.at <= CODE_MARKS_TTL_MS && inScope(w)) return true;
    if (rootRunApproved && inFirstRunRoot(k)) return false; // WP-AUTO-REWORK: one first-run card covers the whole root
    return firstRunnerAsks && clean < startSeq ? 'first_runner' : false; // round 11 (L1): code already on disk was never seen run
  };
}

// where each subagent works. convId -> Map<Agent/Task tool_use id, { folder, outside }>, from the stream and
// from Agent or Task cards. Round 9 (F1, F2): subagentRuns: conversations in which any subagent was seen this run (a
// dispatch, or a stream line made under a parent); there a card the stream has not placed is outside.
const subagents = new Map();
const subagentRuns = new Set();
const OUTSIDE = Object.freeze({ folder: null, outside: true });
const isDispatchTool = (name) => name === 'Agent' || name === 'Task';

/** a tracking map keeps its newest MAX_TRACKED_TOOL_USES entries; the oldest goes for a new one (it used
 *  to stop recording, so every later card was judged in the run folder). */
function setBounded(m, key, value) {
  if (m.has(key)) m.delete(key);
  else if (m.size >= MAX_TRACKED_TOOL_USES) m.delete(m.keys().next().value);
  m.set(key, value);
}

/** Where a tool call made under `parentId` (the Agent or Task call of its subagent; null for the main agent) works:
 *  `{ folder, outside }`, or null for the run folder. Round 9 (F1): a parent that is not a dispatch the store knows (the
 *  stream never showed it, it was dropped as the oldest, or it is not an Agent or Task call) is outside. */
function placeUnder(convId, parentId) {
  if (!parentId) return null;
  const subs = subagents.get(convId);
  return (subs && subs.get(parentId)) || OUTSIDE;
}

/** Where the tool call of a card works. Round 9 (F1, F2): once any subagent was seen in the run, a card the stream has
 *  not placed (an unknown or dropped id, or no id at all) is outside: it may be any subagent's. Round 10 (F5): the same
 *  while an Agent/Task dispatch is in flight (a pending dispatch card whose subagent may not have shown a stream line
 *  yet) — the explicit check, so the OUTSIDE verdict does not rest only on subagentRuns having been set in time. */
function placeOfCard(convId, toolUseId) {
  const parents = toolParents.get(convId);
  const placed = typeof toolUseId === 'string' && toolUseId.length > 0 && parents && parents.has(toolUseId);
  if (!placed) return subagentRuns.has(convId) || hasPendingDispatch(convId) ? OUTSIDE : null;
  return placeUnder(convId, parents.get(toolUseId));
}

/** true while an Agent or Task dispatch card of this conversation is still waiting for the owner. */
function hasPendingDispatch(convId) {
  for (const r of pending.values()) {
    if (r.conv_id === convId && isDispatchTool(r.tool_name) && (r.status === 'waiting' || r.status === 'paused')) return true;
  }
  return false;
}

const parentOf = (convId, toolUseId) => { const p = toolParents.get(convId); return p ? p.get(toolUseId) || null : null; };

/** An Agent or Task call `toolUseId` made under `parentId` starts a subagent: remember where it works. `from` (optional)
 *  is where the call itself was placed (a card); an outside caller starts an outside subagent.
 *  the first placement wins — a later CARD (`fromCard`) can never loosen an existing OUTSIDE placement to
 *  inside (the stream is authoritative and may still tighten or correct it; only a card is held to the first verdict). */
function noteDispatch(convId, toolUseId, input, parentId, from = placeUnder(convId, parentId), { fromCard = false } = {}) {
  subagentRuns.add(convId);
  const runFolder = runFolders.get(convId) || null;
  const info = from && from.outside ? OUTSIDE : dispatchFolder(input, { cwd: (from && from.folder) || runFolder, root: runFolder });
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return;
  const subs = mapFor(subagents, convId);
  const prev = subs.get(toolUseId);
  if (fromCard && prev && prev.outside && info && !info.outside) return; // a card may not loosen outside -> inside
  setBounded(subs, toolUseId, info);
}

/** Marks (true) or clears (false) a conversation as fed from a LAN phone. Callers: routes/conversations.mjs, remote/phone-routes.mjs. */
export function setTurnFromLanPhone(convId, fromLanPhone) {
  if (typeof convId !== 'string' || convId.length === 0) return;
  if (fromLanPhone === true) lanPhoneTurns.add(convId); else lanPhoneTurns.delete(convId);
}

let runHooks = { pause: () => false, resume: () => {} };
let pauseAfterOverride = null;
let autonomyCheck = null; // (projectName) => boolean, wired by server.mjs createServer()
const autoLog = []; // newest last; the auto-allow log
const MAX_AUTO_LOG = 200;
const PREVIEW_MAX = 200;
export const AUTO_ALLOW_REASON = 'Autonomie aan voor dit project: routine-actie, geen harde poort';

/** server.mjs createServer() wires permissions/autonomy.mjs isAutonomyOn here; null switches it off. */
export function setPermissionAutonomy(check) {
  autonomyCheck = typeof check === 'function' ? check : null;
}

function autonomyOn(project) {
  if (!autonomyCheck || !project) return false;
  try {
    return autonomyCheck(project) === true;
  } catch {
    return false; // fail closed: the card waits
  }
}

function projectOf(convId) {
  try {
    const row = listConversations().find((c) => c.id === convId);
    return row && typeof row.project === 'string' && row.project.length > 0 ? row.project : null;
  } catch {
    return null;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every spelling of `dir` in a command: native, forward slashes, and (Windows) the Git Bash /c/... form. */
function spellings(dir) {
  const fwd = dir.replace(/\\/g, '/');
  const out = [dir, fwd];
  const m = /^([A-Za-z]):\/(.*)$/.exec(fwd);
  if (m) out.push('/' + m[1].toLowerCase() + '/' + m[2]);
  return [...new Set(out)];
}

/** At most 200 characters of what the card is about: the project folder as `.`, the home folder as `~`,
 *  other long paths cut to their last two parts, secrets and gateway tokens removed. */
function commandPreview(input, folder) {
  const pick = [input.command, input.file_path, input.notebook_path, input.path, input.url, input.query, input.pattern].find((v) => typeof v === 'string' && v.length > 0);
  let s = pick !== undefined ? pick : JSON.stringify(input);
  for (const [dir, to] of [[folder, '.'], [os.homedir(), '~']]) {
    if (!dir) continue;
    for (const form of spellings(dir)) s = s.replace(new RegExp(escapeRe(form), process.platform === 'win32' ? 'gi' : 'g'), to);
  }
  s = s.replace(/\b([A-Za-z]:[\\/])(?:[^\s"'\\/]+[\\/]){2,}(?=[^\s"'\\/]+[\\/][^\s"'\\/]+)/g, '$1…\\');
  s = scrubGatewayTokens(redact(s)).replace(/\s+/g, ' ').trim();
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX - 1) + '…' : s;
}

/** The auto-allow log, newest first: [{ id, at, conversation_id, project, tool_name, summary_nl, categories, reason, command_preview }]. */
export function listAutoAllowed({ limit = 50 } = {}) {
  return autoLog.slice(Math.max(0, autoLog.length - limit)).reverse();
}

/** exec-lifecycle.mjs wires the run-timeout pause/resume here at module load (avoids an import cycle).
 *  `pause(convId)` returns true when it really paused a running execution's reaper. */
export function setRunPauseHooks(hooks) {
  runHooks = { ...runHooks, ...hooks };
}

/** exec-lifecycle.mjs: a turn started in `cwd` (the conversation's registered project folder). */
export function registerPermissionRun(convId, { cwd } = {}) {
  if (typeof convId !== 'string' || convId.length === 0) return;
  if (typeof cwd === 'string' && cwd.length > 0) runFolders.set(convId, cwd);
}

function pauseAfterMs() {
  if (pauseAfterOverride !== null) return pauseAfterOverride;
  const n = Number(process.env.CC_PERMISSION_PAUSE_AFTER_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAUSE_AFTER_MS;
}

function logEvent(record, kind, data) {
  try {
    appendConversationEvent(record.conv_id, { turn_id: record.turn_id, request_id: record.request_id, kind, data });
  } catch {
    /* best-effort: a store write failure must never break the permission flow itself */
  }
}

function displayAgentName(subagentType) {
  if (typeof subagentType !== 'string' || subagentType.length === 0) return null;
  return subagentType
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function mapFor(store, convId) {
  let m = store.get(convId);
  if (!m) {
    m = new Map();
    store.set(convId, m);
  }
  return m;
}

/** Feeds one parsed stream-json line (exec-lifecycle readline handler) into the agent tracking. */
export function observeStreamLine(convId, parsed) {
  if (!convId || !parsed || typeof parsed !== 'object') return;
  const content = parsed.message && Array.isArray(parsed.message.content) ? parsed.message.content : null;
  if (parsed.type !== 'assistant' || !content) return;
  const parent = typeof parsed.parent_tool_use_id === 'string' && parsed.parent_tool_use_id.length > 0 ? parsed.parent_tool_use_id : null;
  if (parent) subagentRuns.add(convId); // a line made under a parent proves a subagent runs
  const parents = mapFor(toolParents, convId);
  for (const block of content) {
    if (!block || block.type !== 'tool_use' || typeof block.id !== 'string') continue;
    // a write Claude Code may run without a card (acceptEdits) is only seen here;
    // a subagent's relative path is read from the folder it works in
    try {
      const runFolder = runFolders.get(convId) || null;
      const place = placeUnder(convId, parent);
      noteCodeWrites(codeWriteTargets(block.name, block.input, { cwd: (place && !place.outside && place.folder) || runFolder }), runFolder);
    } catch { /* never breaks the stream */ }
    setBounded(parents, block.id, parent);
    // where the subagent this call starts works
    if (isDispatchTool(block.name)) {
      try { noteDispatch(convId, block.id, block.input, parent); } catch { subagentRuns.add(convId); }
    }
    const isDispatch = (block.name === 'Agent' || block.name === 'Task') && block.input && typeof block.input.subagent_type === 'string';
    if (isDispatch) setBounded(mapFor(dispatchAgents, convId), block.id, block.input.subagent_type);
  }
}

/** The helper that issued `toolUseId`, as a log name ("Build Boss"), or null for the main assistant. */
export function agentForToolUse(convId, toolUseId) {
  const parents = toolParents.get(convId);
  if (!parents || typeof toolUseId !== 'string') return null;
  const parent = parents.get(toolUseId);
  if (!parent) return null;
  const agents = dispatchAgents.get(convId);
  return displayAgentName(agents ? agents.get(parent) : null) || 'Helper';
}

function openCountFor(convId) {
  let n = 0;
  for (const r of pending.values()) if (r.conv_id === convId && (r.status === 'waiting' || r.status === 'paused')) n += 1;
  return n;
}

function onFirstOpen(convId) {
  if (pausedByPermission.has(convId)) return;
  let paused = false;
  try {
    paused = runHooks.pause(convId) === true;
  } catch {
    paused = false; // a hook failure must never break the request itself
  }
  if (paused) pausedByPermission.add(convId);
}

function onLastClosed(convId) {
  if (!pausedByPermission.has(convId)) return;
  pausedByPermission.delete(convId);
  try {
    runHooks.resume(convId);
  } catch {
    /* best-effort: the run's own close path still clears its timer */
  }
}

function rememberDecision(id, decision, convId) {
  const now = Date.now();
  for (const [key, value] of decided) {
    if (value.expiresAt <= now || decided.size >= MAX_DECIDED) decided.delete(key);
    else break; // insertion order = expiry order
  }
  decided.set(id, { decision, convId, expiresAt: now + DECIDED_TTL_MS });
}

function settle(record, decision) {
  if (record.pauseTimer) clearTimeout(record.pauseTimer);
  record.pauseTimer = null;
  record.decision = decision;
  rememberDecision(record.id, decision, record.conv_id);
  for (const resolve of record.waiters) resolve(decision);
  record.waiters.clear();
}

function decisionFor(behavior, input) {
  if (behavior === 'deny') return { decided: true, behavior: 'deny', message: DENY_MESSAGE };
  return { decided: true, behavior: 'allow', updatedInput: input };
}

/**
 * Registers one permission request. Returns `{ ok:true, id, decision? }` — `decision` is present
 * only when an "Altijd toestaan in dit gesprek" rule already covers it — or `{ ok:false, error }`.
 */
export function createPermissionRequest({ convId, turnId, requestId, toolName, input, toolUseId, cwd }) {
  if (typeof convId !== 'string' || convId.length === 0) return { ok: false, error: 'conv_id is required' };
  if (typeof toolName !== 'string' || toolName.length === 0 || toolName.length > 200) return { ok: false, error: 'tool_name must be a non-empty string' };
  const safeInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (pending.size >= MAX_PENDING_TOTAL) return { ok: false, error: 'too many open permission requests' };

  const runFolder = runFolders.get(convId) || null;
  const useId = typeof toolUseId === 'string' && toolUseId.length > 0 ? toolUseId : null;
  // a subagent's card is judged in the folder it works in; one started outside the run folder always waits
  let place = typeof cwd === 'string' && cwd.length > 0 ? null : placeOfCard(convId, useId);
  // that folder is checked again now, at its real location (a junction made or swapped in since the dispatch)
  if (place && !place.outside && place.folder && !folderStillInside(place.folder, runFolder)) place = OUTSIDE;
  const folder = typeof cwd === 'string' && cwd.length > 0 ? cwd : (place && !place.outside && place.folder) || runFolder;
  const rule = classifyPermission(toolName, safeInput, { cwd: folder });
  const kind = sessionRuleKey(toolName, safeInput, { cwd: folder });
  const id = 'perm-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const writes = codeWriteTargets(toolName, safeInput, { cwd: folder });
  noteCodeWrites(writes, folder); // before it is judged
  const runners = new Set(); // the runner families this card runs
  const gate = place && place.outside
    ? { hard: true, code: 'outside_folder', reason_nl: HARD_GATE_REASONS.outside_folder }
    : classifyHardGate(toolName, safeInput, { cwd: folder, codeWritten: dirtyChecker(folder, runFolder), runners });
  if (isDispatchTool(toolName)) {
    try { noteDispatch(convId, useId, safeInput, useId ? parentOf(convId, useId) : null, place, { fromCard: true }); } catch { subagentRuns.add(convId); }
  }
  const record = {
    id,
    conv_id: convId,
    project: projectOf(convId),
    gate,
    folder,
    code_seq: codeSeq,
    runners: [...runners],
    write_keys: writes.map(codeKey),
    command_preview: commandPreview(safeInput, folder),
    turn_id: turnId || null,
    request_id: requestId || null,
    tool_name: toolName,
    input: safeInput,
    tool_use_id: typeof toolUseId === 'string' ? toolUseId : null,
    categories: rule.categories,
    summary_nl: rule.summary_nl,
    kind,
    rememberable: kind !== null,
    created_at: new Date().toISOString(),
    answered_at: null,
    behavior: null,
    status: 'waiting',
    waiters: new Set(),
    pauseTimer: null,
    decision: null,
  };
  const publicData = () => publicView(record);

  const allowed = sessionAllow.get(convId);
  if (kind && allowed && allowed.has(kind)) {
    record.status = 'answered';
    record.behavior = 'allow_session';
    record.answered_at = record.created_at;
    logEvent(record, 'permission_auto_allowed', { ...publicData(), rule_kind: kind });
    return { ok: true, id, decision: decisionFor('allow', safeInput) };
  }

  // only a card the allow-list proved safe (code 'routine'; hard-gate.mjs) is allowed without the owner
  if (record.gate.hard === false && record.gate.code === 'routine' && !lanPhoneTurns.has(convId) && autonomyOn(record.project)) {
    record.status = 'auto_allowed';
    record.behavior = 'allow';
    record.answered_at = record.created_at;
    const entry = {
      id, at: record.created_at, conversation_id: convId, project: record.project, tool_name: toolName,
      summary_nl: record.summary_nl, categories: record.categories, reason: AUTO_ALLOW_REASON, command_preview: record.command_preview,
    };
    autoLog.push(scrubGatewayTokens(redactDeep(entry)));
    if (autoLog.length > MAX_AUTO_LOG) autoLog.shift();
    logEvent(record, 'permission_auto_allowed', { ...publicData(), reason: AUTO_ALLOW_REASON, hard_gate: false, autonomy: true });
    return { ok: true, id, decision: decisionFor('allow', safeInput) };
  }

  pending.set(id, record);
  logEvent(record, 'permission_requested', publicData());
  record.pauseTimer = setTimeout(() => {
    if (record.status !== 'waiting') return;
    record.status = 'paused';
    logEvent(record, 'permission_paused', { id, waited_ms: pauseAfterMs() });
  }, pauseAfterMs());
  if (typeof record.pauseTimer.unref === 'function') record.pauseTimer.unref();
  if (openCountFor(convId) === 1) onFirstOpen(convId);
  return { ok: true, id };
}

/**
 * Resolves with the decision, or `{ decided:false }` after `ms` (the caller then polls again).
 * With `convId`, a request of ANOTHER conversation is answered exactly like an unknown id.
 */
export function waitForDecision(id, ms, { convId } = {}) {
  const record = pending.get(id);
  if (!record) {
    const done = decided.get(id);
    const visible = done && done.expiresAt > Date.now() && (convId === undefined || done.convId === convId);
    if (visible) return Promise.resolve(done.decision);
    return Promise.resolve({ decided: false, unknown: true });
  }
  if (convId !== undefined && record.conv_id !== convId) return Promise.resolve({ decided: false, unknown: true });
  if (record.decision) return Promise.resolve(record.decision);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      record.waiters.delete(done);
      resolve({ decided: false });
    }, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
    function done(decision) {
      clearTimeout(timer);
      resolve(decision);
    }
    record.waiters.add(done);
  });
}

/**
 * The dashboard's answer. Returns `{ ok, status, error? }` with an HTTP-style status; on success
 * also `behavior` (what was really applied) and `remembered`. allow_session on a request without a
 * session key (`rememberable: false`) is applied as a one-time allow.
 */
export function answerPermission(id, behavior) {
  if (!PERMISSION_BEHAVIORS.includes(behavior)) return { ok: false, status: 400, error: 'behavior must be one of: ' + PERMISSION_BEHAVIORS.join(', ') };
  const record = pending.get(id);
  if (!record && decided.has(id)) return { ok: false, status: 409, error: 'permission request already decided' };
  if (!record) return { ok: false, status: 404, error: 'unknown or expired permission request' };
  if (record.status === 'answered' || record.status === 'abandoned') return { ok: false, status: 409, error: 'permission request already ' + record.status };
  const remembered = behavior === 'allow_session' && record.kind !== null;
  const applied = behavior === 'allow_session' && !remembered ? 'allow' : behavior;
  record.status = 'answered';
  record.behavior = applied;
  record.answered_at = new Date().toISOString();
  if (remembered) {
    let kinds = sessionAllow.get(record.conv_id);
    if (!kinds) {
      kinds = new Set();
      sessionAllow.set(record.conv_id, kinds);
    }
    kinds.add(record.kind);
  }
  if (applied !== 'deny') noteOwnerAllowed(record);
  const answered = { id, behavior: applied, tool_name: record.tool_name, rule_kind: record.kind, remembered, answered_at: record.answered_at };
  if (applied !== behavior) answered.requested_behavior = behavior;
  logEvent(record, 'permission_answered', scrubGatewayTokens(answered));
  settle(record, decisionFor(applied === 'deny' ? 'deny' : 'allow', record.input));
  pending.delete(id);
  if (openCountFor(record.conv_id) === 0) onLastClosed(record.conv_id);
  return { ok: true, status: 200, convId: record.conv_id, behavior: applied, remembered };
}

/**
 * The owner allowed `record`. Round 6: a 'wrote_code' card covers what was written up to when it was made; round 8 (F2):
 * only for the runner families it runs. Round 8 (A4, LOW): what the card writes when it runs (a Write card that waited,
 * a `cargo add`, an `npm run fix`, a vite build) lands now, so it is marked now; the card's own families then stay clean
 * when nothing else was written in between (the owner saw them run over it).
 */
function noteOwnerAllowed(record) {
  try {
    ensureMarks();
    const k = record.folder ? codeKey(record.folder) : null;
    if (record.gate && (record.gate.code === 'wrote_code' || record.gate.code === 'first_runner')) {
      setClean(k, record.runners, record.code_seq);
      if (inFirstRunRoot(k)) rootRunApproved = true; // WP-AUTO-REWORK: the owner saw a runner run in this root once
    }
    const after = postRunWrites(record.tool_name, record.input, { cwd: record.folder });
    if (after.length === 0) return;
    let othersSince = false;
    for (const m of codeWrites.values()) if (m.seq > record.code_seq) { othersSince = true; break; }
    noteCodeWrites(after, record.folder);
    if (!othersSince) setClean(k, record.runners, codeSeq);
  } catch { /* the answer itself never fails on this */ }
}

/** The run that opened these requests ended: close them out honestly (never as a user deny). */
export function abandonPermissionsForConversation(convId, reason) {
  const closed = [];
  for (const record of [...pending.values()]) {
    if (record.conv_id !== convId) continue;
    record.status = 'abandoned';
    logEvent(record, 'permission_abandoned', { id: record.id, reason: reason || 'execution_closed' });
    settle(record, { decided: true, behavior: 'deny', message: 'The Forge run ended before the user answered.', abandoned: true });
    pending.delete(record.id);
    closed.push(record.id);
  }
  if (pausedByPermission.delete(convId)) {
    try {
      runHooks.resume(convId);
    } catch {
      /* best-effort */
    }
  }
  toolParents.delete(convId);
  dispatchAgents.delete(convId);
  runFolders.delete(convId);
  subagents.delete(convId);
  subagentRuns.delete(convId);
  return closed;
}

function toPublic(record) {
  return {
    id: record.id,
    conversation_id: record.conv_id,
    project: record.project,
    turn_id: record.turn_id,
    tool_name: record.tool_name,
    input: record.input,
    tool_use_id: record.tool_use_id,
    agent: agentForToolUse(record.conv_id, record.tool_use_id),
    categories: record.categories,
    summary_nl: record.summary_nl,
    gate: record.gate,
    command_preview: record.command_preview,
    rememberable: record.rememberable,
    status: record.status,
    created_at: record.created_at,
    answered_at: record.answered_at,
    behavior: record.behavior,
  };
}

/** The one shape a record is shown or logged in: redacted, and with every gateway token scrubbed. */
function publicView(record) {
  return scrubGatewayTokens(redactDeep(toPublic(record)));
}

/** Open requests (waiting or paused), oldest first, redacted; optionally for one conversation. */
export function listPendingPermissions({ convId } = {}) {
  return [...pending.values()]
    .filter((r) => (!convId || r.conv_id === convId) && (r.status === 'waiting' || r.status === 'paused'))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((r) => publicView(r));
}

/**
 * Concurrent requests per conversation, for one group card ("Het team wil 4 dingen doen") and the
 * Windows notification text. Input: the output of listPendingPermissions().
 */
export function groupPendingPermissions(list) {
  const groups = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    let g = groups.get(item.conversation_id);
    if (!g) {
      g = { conversation_id: item.conversation_id, count: 0, ids: [], agents: [], categories: [], summary_nl: '' };
      groups.set(item.conversation_id, g);
    }
    g.count += 1;
    g.ids.push(item.id);
    const agent = item.agent || null;
    if (agent && !g.agents.includes(agent)) g.agents.push(agent);
    for (const c of item.categories || []) if (!g.categories.includes(c)) g.categories.push(c);
    g.summary_nl = g.count === 1 ? item.summary_nl : 'Het team wil ' + g.count + ' dingen doen';
  }
  return [...groups.values()];
}

/** True when the conversation has at least one open request (status "Wacht op jou"/"Gepauzeerd"). */
export function hasOpenPermissions(convId) {
  return openCountFor(convId) > 0;
}

/** routes/permissions.mjs (the running gateway) keeps the write-then-run marks on disk. */
export function enableCodeMarkPersistence() {
  enableMarks();
}

/** Test-only: forget everything and restore defaults. Like a stop of the gateway, the marks not saved yet are saved
 *  first, and the marks file stays: the next use reads it again (a restart). */
export function _resetPermissionStoreForTests() {
  flushMarks();
  for (const r of pending.values()) if (r.pauseTimer) clearTimeout(r.pauseTimer);
  pending.clear();
  sessionAllow.clear();
  toolParents.clear();
  dispatchAgents.clear();
  subagents.clear();
  subagentRuns.clear();
  pausedByPermission.clear();
  runFolders.clear();
  lanPhoneTurns.clear();
  decided.clear();
  autoLog.length = 0;
  pauseAfterOverride = null;
  codeSeq = 0;
  codeWrites.clear();
  codeCleanAt.clear();
  marksLoaded = false;
  startSeq = 0;
  rootRunApproved = false;
  marksUnsaved = false;
  repairPending = false;
  lastSaveAt = 0;
}

/** Test-only: the folder of the marks file (null: the per-user folder, which tests never touch). */
export function _setCodeMarksDirForTests(dir) {
  setCodeMarksDir(dir);
}

/** Test-only (WP-AUTO-REWORK): the root one first-run approval covers; null restores PROJECT_ROOT. Not reset by
 *  _resetPermissionStoreForTests. */
export function _setFirstRunRootForTests(dir) {
  firstRunRoot = dir === null || dir === undefined ? PROJECT_ROOT : dir;
}

/** Test-only: false makes the first runner after a start routine again, for the suites that test the write
 *  marks alone. Not reset by _resetPermissionStoreForTests (a suite's restarts keep it). */
export function _setFirstRunnerForTests(on) {
  firstRunnerAsks = on !== false;
}

/** Test-only: save the marks now. */
export function _flushCodeMarksForTests() {
  flushMarks();
}

export function _setPauseAfterMsForTests(ms) {
  pauseAfterOverride = ms;
}
