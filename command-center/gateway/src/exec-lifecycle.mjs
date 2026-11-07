// Forge Command Center gateway — exec-bridge execution lifecycle (spawn/timeout/kill/slots)
// (refactor-gateway-split). Split out of the single exec-bridge.mjs (had
// grown to ~754 lines, over this project's own 500-line-per-file guidance) into its own real seam:
// the concurrent-execution slot bookkeeping, the per-execution wall-clock timeout, the shared
// tree-kill logic, and startExecution/stopExecution themselves. Every name below is re-exported from
// exec-bridge.mjs under its EXACT original name — see that file's own header for the full
// architecture/history/honesty rules this slice still follows; no other file in the codebase needed
// to change a single import.
//
// Honest scope note (see the WP4 forge-report, carried here from exec-bridge.mjs's own header):
// this spawns ONE `claude -p` process per composer turn — a direct chat-turn bridge, NOT the
// "composer drives a real /forge mission" executor mode D2 describes as the eventual target.
import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import { appendAssistantTurn, appendConversationEvent, deriveTitleFromText } from './conversations.mjs';
import { redact, redactDeep, createCappedRedactedCapture } from './redact.mjs';
import { executionAvailability, execSpawnEnv, stripExecTokenFromAskMcpConfig, isUsableClaudeConfigDir, withClaudeProfileEnv, _resetClaudeCliResolutionForTests } from './exec-cli.mjs';
import { buildSpawnSpec } from './exec-argv.mjs';
import { abandonPendingAsksForConversation } from './ask-store.mjs';
import {
  extractResultUsage,
  extractFileEditFromToolUseBlock,
  extractTodoSnapshotFromToolUseBlock,
  extractShellCommandFromToolUseBlock,
  extractShellResultFromToolResultBlock,
  extractSessionIdFromParsedLine,
  extractAgentDispatchFromToolUseBlock,
  extractSubagentLine,
  extractHookEventFromParsedLine,
  isSubagentLifecycleHook,
  createSubagentActivityBudget,
  SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH,
  MAX_FILE_EDITS_PER_TURN,
  MAX_SHELL_COMMANDS_PER_TURN,
} from './exec-stream-parse.mjs';
import { createExecCostAggregator, buildCostSampledRecord } from './exec-cost.mjs';
import { resumeOptionsFor, createRunSessionTracker } from './sessions/gateway-sessions.mjs';
// WP B3 (plan 4.4): permission prompts, the acceptEdits default, error codes and the stop sequence.
import {
  setRunPauseHooks,
  registerPermissionRun,
  observeStreamLine as observePermissionStreamLine,
  abandonPermissionsForConversation,
} from './permissions/store.mjs';
import { resolveEffectiveMode } from './permissions/mode.mjs';
import { isProjectTrusted } from './permissions/trust.mjs';
import { extractForgeErrorFromParsedLine } from './exec-stream-parse.mjs';
import { classifyErrorText, classifyExit, gatewayRestartedError, toForgeErrorEvent } from './error-catalogue.mjs';

// WP B8-3 (Review B8-2, HIGH): a child that ends before its FIRST stdout line never started the turn at all.
// Before this, such a turn closed with error:null (chat-runs.mjs then counted it 'completed') and the
// conversation stayed silent. It now closes as a FAILED turn whose error starts with this Dutch sentence, plus
// one forge_error with an error-catalogue code (the stderr's own code when it names one, else `unknown`).
export const START_FAILED_MESSAGE = 'Claude kon niet starten';
let spawnSpecOverride = null; // test-only, set via _setSpawnSpecOverrideForTests()
/** Test-only: replace buildSpawnSpec for the next executions (fn(text, mode, ...) -> { cmd, args, askMcpConfigPath }); null restores it. */
export function _setSpawnSpecOverrideForTests(fn) { spawnSpecOverride = typeof fn === 'function' ? fn : null; }

/** The turn error and the catalogue payload for a child that exited before any output (exported for tests). */
export function startFailure({ exitCode, signal, stderr }) {
  const how = exitCode !== null && exitCode !== undefined ? 'afsluitcode ' + exitCode : signal ? 'signaal ' + signal : 'onbekende afsluiting';
  const message = START_FAILED_MESSAGE + ' (' + how + ', geen uitvoer)';
  const classified = classifyExit({ exitCode, stderr }) || classifyErrorText('');
  const stderrText = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : null;
  const payload = { ...classified, details: (message + (stderrText ? ': ' + (classified.details || stderrText) : '')).slice(0, 600) };
  return { message, payload };
}

const MAX_CONCURRENT_EXECUTIONS = 3;
const STDERR_CAP_BYTES = 4000;
// WP A8: how much child stderr is read at all before the capture is cut (fail-closed, see
// createCappedRedactedCapture). Far above the 4000 chars a turn stores; it only bounds memory.
const STDERR_INPUT_LIMIT_CHARS = 256 * 1024;

// fix-exec-timeout (HIGH, checkup finding): a spawned `claude -p` child previously had NO wall-clock
// cap — it was only ever cleaned up on 'close'/'error'/an explicit stopExecution() call, so a
// genuinely wedged child stayed in `running` forever, kept its conversation permanently "busy"
// (every new send 409s) and permanently occupied one of MAX_CONCURRENT_EXECUTIONS=3 slots; three
// wedged children fully wedge the gateway. DEFAULT_EXEC_TIMEOUT_MS is a generous but real 30-minute
// cap per execution, overridable via CC_EXEC_TIMEOUT_MS (this file's own CC_* env convention,
// already used by CC_EXEC_MOCK/CC_EXEC_MOCK_DELAY_MS above) for anyone who needs a different real
// cap. A separate stale-slot reaper was deliberately NOT added: since every single execution now
// gets its own per-instance timer that force-releases its OWN slot (see startExecution below), a
// second sweeping reaper would only ever find slots this timer already frees itself — it would be
// redundant, not a genuine second line of defense.
const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000;
let execTimeoutMsOverride = null; // test-only, set via _setExecTimeoutMsForTests()

/** The wall-clock cap of one execution in ms (CLI turns and, App router P2, provider turns alike). */
export function resolveExecTimeoutMs() {
  if (execTimeoutMsOverride !== null) return execTimeoutMsOverride;
  const envValue = Number(process.env.CC_EXEC_TIMEOUT_MS);
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_EXEC_TIMEOUT_MS;
}

// Test-only: inject a short wall-clock timeout so `node --test` can exercise the real timeout path
// without waiting the real 30-minute default. Pass null to restore the default/env-driven value.
export function _setExecTimeoutMsForTests(ms) {
  execTimeoutMsOverride = ms;
}

/* Every wall-clock timeout timer that has been scheduled and neither fired nor been cleared.
 *
 * WHY THIS EXISTS (coordinator finding 2026-07-30): the test claiming "a normal completion clears the
 * timer" was VACUOUS — deleting the `clearTimeout` in the `close` handler left it green. What actually
 * prevents a second, timed-out turn is `markFinished()`, not the clearing; the clearing is real
 * resource hygiene (a surviving 30-minute timer holds a closure over the child and the buffers) that
 * nothing verified. Routing every schedule/clear through this set makes that hygiene observable, so
 * the test can fail when it genuinely regresses. */
const pendingTimeoutTimers = new Set();

function scheduleExecTimeout(fn, ms) {
  const timer = setTimeout(() => {
    pendingTimeoutTimers.delete(timer);
    fn();
  }, ms);
  pendingTimeoutTimers.add(timer);
  return timer;
}

/** Idempotent: clearing an already-fired or already-cleared timer is a no-op, never a miscount. */
function clearExecTimeout(timer) {
  if (timer === null || timer === undefined) return;
  pendingTimeoutTimers.delete(timer);
  clearTimeout(timer);
}

/** Test-only: how many scheduled timeout timers are still alive right now. */
export function _pendingExecTimeoutCountForTests() {
  return pendingTimeoutTimers.size;
}

// convId -> running entry. App router P2 (review finding 9) defines the entry contract:
//   kind 'cli'      { kind, child, turnId, requestId, startedAt, timeoutTimer, markFinished, fireExecTimeout, ... }
//                   one spawned `claude -p` child (startExecution below);
//   kind 'provider' { kind, turnId, requestId, startedAt, timeoutTimer: null, abort(reason), markFinished,
//                   stoppedByUser } one answers-only provider or codex turn (app-router/provider-turn.mjs),
//                   registered through registerProviderRun(). It has no child: stop and drain call abort().
// Both kinds make the conversation busy (isConversationBusy), so chat-runs.mjs and agent-dispatches.mjs
// need no change. The caps are separate: CLI children count toward MAX_CONCURRENT_EXECUTIONS only,
// provider turns toward MAX_CONCURRENT_PROVIDER_TURNS only (a provider turn spawns no claude child).
// The ask/permission pause functions below act only on entries with a reaper (fireExecTimeout), so a
// provider entry is a no-op there.
const running = new Map();
const MAX_CONCURRENT_PROVIDER_TURNS = 3;

export function isConversationBusy(convId) { return running.has(convId); }
export function runningExecutionCount() { return running.size; }
export function maxConcurrentExecutions() { return MAX_CONCURRENT_EXECUTIONS; }
export function maxConcurrentProviderTurns() { return MAX_CONCURRENT_PROVIDER_TURNS; }
function countRunning(kind) {
  let n = 0;
  for (const e of running.values()) if ((e.kind === 'provider' ? 'provider' : 'cli') === kind) n += 1;
  return n;
}
/** Running provider turns (App router P2). */
export function providerRunCount() { return countRunning('provider'); }

/**
 * App router P2: registers one provider turn in the shared running map, so the conversation is busy,
 * Stop aborts it and a gateway drain interrupts it. Returns { ok: true, entry } or { ok: false, reason }
 * with the same honest reasons startExecution gives. `abort(reason)` must end the turn's stream.
 */
export function registerProviderRun(convId, { turnId, requestId, abort }) {
  if (drainModeReason !== null) return { ok: false, reason: 'gateway is draining (' + drainModeReason + ') — no new executions; the supervisor will start a fresh gateway' };
  if (typeof abort !== 'function') return { ok: false, reason: 'provider turn has no abort handle' };
  if (isConversationBusy(convId)) return { ok: false, reason: 'conversation already has a pending execution' };
  if (providerRunCount() >= MAX_CONCURRENT_PROVIDER_TURNS) {
    return { ok: false, reason: 'gateway-wide provider turn limit reached (' + MAX_CONCURRENT_PROVIDER_TURNS + ' running)' };
  }
  const entry = { kind: 'provider', turnId, requestId, startedAt: Date.now(), timeoutTimer: null, abort, stoppedByUser: false, finished: false };
  entry.markFinished = () => {
    if (entry.finished) return false;
    entry.finished = true;
    return true;
  };
  running.set(convId, entry);
  return { ok: true, entry };
}

/** App router P2: removes a provider turn's entry, but only while it is still that conversation's entry. */
export function releaseProviderRun(convId, entry) {
  if (running.get(convId) !== entry) return false;
  running.delete(convId);
  return true;
}

// Shared tree-kill logic, used by BOTH an explicit stopExecution() call and the wall-clock timeout
// below — one kill path, not two, per the WP instruction to reuse stopExecution's own kill logic
// rather than adding a second kill mechanism. Tree-kill on Windows via taskkill /T so no orphaned
// grandchildren survive. Best-effort only: the caller has already released the slot/state regardless
// of whether the underlying OS kill actually succeeds.
export function killChildTree(child) {
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => { /* best-effort */ });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch {
    /* best-effort kill only */
  }
}

// WP B3 (plan 4.4) stop sequence: interrupt -> close stdin -> kill the exact PID (tree).
//   1. interrupt: SIGINT to the child on POSIX. On Windows a signal cannot be delivered without
//      killing (Node maps every signal to TerminateProcess), and in -p text mode the CLI has no
//      stdin control channel, so nothing is sent there;
//   2. close stdin, so a CLI that reads it sees end-of-input;
//   3. kill the exact PID with killChildTree: at once when no interrupt could be delivered,
//      otherwise after `graceMs` if the child has not exited by itself.
// Returns the steps taken, in order (the test asserts them). Never throws.
const STOP_GRACE_MS = 2000;
export function interruptThenKill(child, { platform = process.platform, graceMs = STOP_GRACE_MS, kill = killChildTree } = {}) {
  const steps = [];
  let interrupted = false;
  if (platform !== 'win32') {
    try {
      interrupted = child.kill('SIGINT') === true;
    } catch {
      interrupted = false;
    }
  }
  steps.push(interrupted ? 'interrupt' : 'interrupt_unavailable');
  try {
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    steps.push('stdin_closed');
  } catch {
    steps.push('stdin_close_failed');
  }
  if (!interrupted || graceMs <= 0) {
    kill(child);
    steps.push('killed');
    return steps;
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) kill(child);
  }, graceMs);
  if (typeof timer.unref === 'function') timer.unref();
  steps.push('kill_scheduled');
  return steps;
}

// WP B3 (error catalogue): one classified error as its own `forge_error` conversation event, next to
// (never instead of) the raw event it came from. Best-effort like every other event write here.
function emitForgeError(convId, turnId, requestId, event) {
  if (!event) return false;
  try {
    appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'forge_error', data: event });
    return true;
  } catch {
    return false;
  }
}

// fix-ghost-asks: every real place an execution ends — stopped,
// closed normally, errored, or reaped by the wall-clock timeout — must close out any ask THIS
// execution still has genuinely pending, per the diagnosis's own root-cause finding
// (`command-center/mission/DIAGNOSE-2026-07-30-spookvragen.md`: "stopExecution() ... never
// touches the ask registry — the file does not even import it"). One shared helper, one real event
// kind (`ask_abandoned`, `data:{id,reason}` — matches `ask_answered`/`ask_timed_out`'s own
// `data.id` shape one field over, so the dashboard's existing resolution-scan logic only ever
// needs one more string added to its own allowlist), reused by all four call sites below instead
// of four hand-rolled copies. Best-effort throughout: a store write failure here must never crash
// the exec lifecycle it is merely cleaning up after.
function abandonPendingAsk(convId, reason) {
  // WP B3: an open permission card of this run is closed out too (permission_abandoned event,
  // never a user deny); the store logs its own events.
  try { abandonPermissionsForConversation(convId, reason); } catch { /* best-effort */ }
  let abandonedAsks;
  try {
    abandonedAsks = abandonPendingAsksForConversation(convId, reason);
  } catch {
    return; // best-effort only — never let ask-store cleanup crash the exec lifecycle
  }
  for (const ask of abandonedAsks) {
    try {
      appendConversationEvent(convId, { turn_id: ask.turnId, request_id: ask.requestId, kind: 'ask_abandoned', data: { id: ask.id, reason } });
    } catch { /* best-effort — mirrors every other post-kill event write in this file */ }
  }
}

// Starts one `claude -p` turn for `convId`. Returns { started:true, turnId, requestId } or
// { started:false, reason }. Never throws — every failure path is a truthful, reported reason
// (per D2: "a degraded but truthful product beats a fake send button").
// WP A4: `fork` (optional) continues the conversation's stored Claude session under a new session
// id (`--resume <id> --fork-session`); without it a stored session is simply resumed.
// App router P2 (design 4.1, 6.1): four optional fields, all absent when the router is off (then this
// function runs exactly as before; no `route` field is written anywhere):
//   route           the RouteDecision record of design 4.7 for this attempt (target_id, kind, label, ...);
//                   it is stamped on the assistant record with its `outcome` and `retried`;
//   claudeConfigDir an absolute Claude Code profile folder (extra account), or null for the main login;
//   handover        { text, turns, chars, truncated } context piped into the child's stdin, or null;
//   onSettled(r)    called ONCE, synchronously, at the end of the attempt and BEFORE its record is
//                   written (review finding 10). It may start attempt 2 and returns { retried }. When it
//                   reports retried:true this attempt is stored as a `route_attempt_failed` event instead
//                   of a turn record, so a turn_id always has exactly one assistant record (finding 1).
// On a routed turn stdin is always closed (spike S2: an open, silent stdin costs a 3 s wait).
export function startExecution({ convId, turnId, requestId, text, cwd, mode, effort, model, fork = false, route = null, claudeConfigDir = null, handover = null, onSettled = null }) {
  if (drainModeReason !== null) return { started: false, reason: 'gateway is draining (' + drainModeReason + ') — no new executions; the supervisor will start a fresh gateway' };
  const routed = route !== null && typeof route === 'object';
  if (claudeConfigDir !== null && claudeConfigDir !== undefined && !isUsableClaudeConfigDir(claudeConfigDir)) {
    return { started: false, reason: 'the account folder for this turn is not an absolute path — turn refused' };
  }
  const availability = executionAvailability();
  if (!availability.available) return { started: false, reason: availability.note };
  if (isConversationBusy(convId)) return { started: false, reason: 'conversation already has a pending execution' };
  if (countRunning('cli') >= MAX_CONCURRENT_EXECUTIONS) {
    return { started: false, reason: 'gateway-wide execution limit reached (' + MAX_CONCURRENT_EXECUTIONS + ' running)' };
  }

  // feat-ask-owner: every real (non-mock) execution is offered the forge-ask MCP tool, scoped to
  // exactly this conversation/turn/request via a fresh, single-use --mcp-config file
  // (exec-argv.mjs's own header carries the full rationale + the 2026-07-30 --allowed-tools
  // correction). `askMcpConfigPath` is undefined in mock mode (buildSpawnSpec's mock branch never
  // looks at askContext at all) — `cleanupAskMcpConfig` below is then a harmless no-op.
  // WP A4 (shared session module): a conversation with a stored Claude session resumes it, so the
  // model remembers earlier turns (before A4 every spawn was a fresh session). The tracker stores
  // the session id from this run's first main system/init line (see gateway-sessions.mjs).
  const sessionOptions = resumeOptionsFor(convId, routed ? { cwd, fork, targetId: route.target_id } : { cwd, fork });
  // WP B3: what the turn is SPAWNED with. No mode / 'execute' -> acceptEdits (every other tool
  // asks through the permission card); 'bypass' only for a project the user marked trusted.
  const effective = resolveEffectiveMode(mode, { trusted: mode === 'bypass' && isProjectTrusted(cwd) });
  const { cmd, args, askMcpConfigPath } = (spawnSpecOverride || buildSpawnSpec)(text, effective.mode, effort, model, { convId, turnId, requestId }, sessionOptions);
  if (!cmd) return { started: false, reason: 'claude CLI path could not be resolved' };
  const sessionTracker = createRunSessionTracker({
    convId,
    cwd,
    model,
    title: deriveTitleFromText(redact(text)),
    resumeSessionId: sessionOptions.resumeSessionId,
    targetId: routed && typeof route.target_id === 'string' ? route.target_id : null,
    onError: ({ action, message }) => {
      try {
        appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'session_store_error', data: { action, message } });
      } catch { /* best-effort — same rationale as every other event write from the stream handlers */ }
    },
  });

  // Best-effort: the per-execution mcp-config file is single-use, so it is removed again the moment
  // this execution closes/errors/times out — never left to accumulate across a long-running gateway
  // process. Missing/already-removed is fine.
  function cleanupAskMcpConfig() {
    if (!askMcpConfigPath) return;
    try {
      fs.unlinkSync(askMcpConfigPath);
    } catch {
      /* best-effort only */
    }
  }

  // WP A8 item 3: the exec token must not sit on disk for the turn. The config builder
  // (exec-argv.mjs) still writes it, so it is stripped here BEFORE the child exists and handed over
  // in the child's environment instead (execSpawnEnv). Fail-closed: a config that cannot be proven
  // token-free is deleted and the turn is refused with the real reason.
  if (askMcpConfigPath) {
    const stripped = stripExecTokenFromAskMcpConfig(askMcpConfigPath);
    if (!stripped.ok) {
      cleanupAskMcpConfig();
      return { started: false, reason: 'ask-mcp config could not be cleared of the exec token (' + stripped.reason + ') — turn refused' };
    }
  }

  let child;
  try {
    const spawnOptions = {
      cwd,
      env: execSpawnEnv({ askMcpConfigPath }),
      shell: false, // NEVER shell:true — args are passed as a real argv array, never interpolated
      windowsHide: true,
      detached: process.platform !== 'win32', // enables a POSIX process-group kill on stop
    };
    // App router: a turn on an extra account runs with that account's profile folder (exec-cli.mjs
    // withClaudeProfileEnv: drops inherited credential-shaped claude_ names, sets the folder). Without
    // a folder (router off, or the main account) the env is exactly execSpawnEnv's.
    if (claudeConfigDir) spawnOptions.env = withClaudeProfileEnv(spawnOptions.env, claudeConfigDir);
    child = spawn(cmd, args, spawnOptions);
  } catch (err) {
    cleanupAskMcpConfig(); // a config file for a child that never existed must not linger
    return { started: false, reason: 'spawn failed: ' + (err && err.message ? err.message : String(err)) };
  }

  // feat-fix-ghost-asks item 4: `currentTimeoutMs`/`timeoutDeadline` track whichever wall-clock
  // window is ACTIVE right now (the original exec budget, an ask-paused replacement, or a resumed
  // remainder — see `pauseExecTimeoutForAsk`/`resumeExecTimeoutAfterAsk` below); `pausedRemainingMs`
  // is `undefined` except while genuinely paused for a pending ask (`askPaused`) and/or an open
  // permission card (`permissionPaused`, WP B3) — two separate flags; `fireExecTimeout` is a STABLE
  // per-execution reference to the one real timeout callback, re-scheduled (never redefined) by
  // both functions so every phase shares the exact same kill/cleanup/event logic.
  const entry = {
    kind: 'cli',
    child,
    turnId,
    requestId,
    startedAt: Date.now(),
    timeoutTimer: null,
    currentTimeoutMs: null,
    timeoutDeadline: null,
    pausedRemainingMs: undefined,
    askPaused: false,
    askDeadline: undefined,
    permissionPaused: false,
    fireExecTimeout: null,
  };
  running.set(convId, entry);
  registerPermissionRun(convId, { cwd });
  // Only a downgrade is logged: the 'execute' -> acceptEdits default is the normal case and adds no event.
  if (effective.downgraded) {
    try {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'permission_mode', data: { requested: effective.requested, effective: effective.mode, downgraded: effective.downgraded, reason: effective.reason } });
    } catch { /* best-effort */ }
  }
  let forgeErrorEmitted = false;
  let stdoutLineCount = 0; // WP B8-3: 0 at close = the child never produced its first output line

  // App router P2: what a routed attempt needs to decide its outcome. Router off: null, never read.
  const routeTrack = routed ? { toolUse: false, rateLimitEvents: [], streamError: null, unparsed: '' } : null;
  if (routed) writeRouteStdin(child, handover && typeof handover.text === 'string' ? handover.text : '', (err) => {
    try {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'context_handover_failed', data: { code: (err && err.code) || 'error' } });
    } catch { /* best-effort: the turn's own close path still reports the turn */ }
  });
  let routeSettled = false;
  // Called once by whichever end path writes the record. Returns null on an unrouted turn.
  function settleRoute(end) {
    if (!routed || routeSettled) return null;
    routeSettled = true;
    const result = routeAttemptResult(end, routeTrack, entry.stoppedByUser === true);
    let retried = false;
    if (typeof onSettled === 'function') {
      try {
        const r = onSettled(result);
        retried = !!(r && r.retried === true);
      } catch (err) {
        try {
          appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'route_settle_error', data: { message: err && err.message ? err.message : String(err) } });
        } catch { /* best-effort */ }
      }
    }
    return { retried, route: { ...route, outcome: result.outcome, retried } };
  }
  // Writes the attempt's record: the assistant turn as before, or (attempt 2 really started) the
  // route_attempt_failed event with the same fields (review findings 1 and 10).
  function writeTurnRecord(fields, end) {
    const settled = settleRoute(end);
    if (settled && settled.retried) {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'route_attempt_failed', data: { ...fields, route: settled.route } });
      return;
    }
    appendAssistantTurn(convId, settled ? { ...fields, route: settled.route } : fields);
  }

  let resultPayload = null;
  let textBuffer = '';
  const stderrCapture = createCappedRedactedCapture({ maxChars: STDERR_CAP_BYTES, maxInputChars: STDERR_INPUT_LIMIT_CHARS });
  // fix-stream-insights: accumulated straight off the SAME real tool_use blocks the readline
  // handler below already parses out of every assistant line — `fileEdits` grows (bounded,
  // MAX_FILE_EDITS_PER_TURN) across the whole turn, `todoSnapshot` is overwritten by the LAST
  // TodoWrite call seen (see extractTodoSnapshotFromToolUseBlock's own doc comment for why a
  // snapshot, not an accumulation, is the honest representation).
  let fileEdits = [];
  let todoSnapshot = null;
  // feat-live-stream: same accumulation shape as `fileEdits` above — grows (bounded,
  // MAX_SHELL_COMMANDS_PER_TURN) across the whole turn. `shellCommandIndexById` lets a LATER
  // tool_result line find and fill in the `result`/`is_error` of the command it belongs to, by
  // the same real `tool_use_id` the CLI's own stream-json output carries.
  let shellCommands = [];
  const shellCommandIndexById = new Map();
  // fix-unavailable (checkup): captured live off ANY parsed stream-json
  // line (extractSessionIdFromParsedLine reads it off nearly every line the CLI emits, not just the
  // final `result` line) / the last real `Agent` tool_use dispatch seen this turn — mirrors
  // `todoSnapshot`'s own "last one wins, a real snapshot of current reality" rationale one field
  // over (a turn that dispatches several sub-agents in sequence honestly reports the MOST RECENT
  // one, the same "latest known" semantics `model` already uses at the conversation level). `null`
  // until a real line/block reports one — never a guess.
  let capturedSessionId = null;
  let lastAgentType = null;
  // feat-subagent-visibility: one budget per EXECUTION, keyed inside by parent_tool_use_id, so a
  // turn that dispatches several sub-agents bounds each of them separately (see
  // createSubagentActivityBudget's own doc comment).
  const subagentActivityBudget = createSubagentActivityBudget();
  // feat-gateway-cost-sampling: one aggregator per EXECUTION, fed every main-conversation `result`
  // line (never a subagent line — those return early below). It exists because `resultPayload` is
  // OVERWRITTEN by each result line, and a single real invocation emits two of them (see
  // exec-cost.mjs's own header for the measured evidence), so the last-one-wins value that closes
  // the turn is not the whole story. This never changes what the turn itself stores; it only adds
  // one honest measurement event that nothing was recording before.
  const costAggregator = createExecCostAggregator();
  // Writes ONE `cost_sampled` event for this execution — or none at all. A run whose stream never
  // reported a usable token number produces NO event (snapshot() === null), deliberately: absence
  // of measurement is not a measurement of zero, and an event full of zeroes would be a lie that
  // sums cleanly. Best-effort, in its own try/catch and after the turn record itself, so a failure
  // here can never cost the caller its actual turn.
  function emitCostSampled() {
    let record;
    try {
      record = buildCostSampledRecord(costAggregator.snapshot());
    } catch {
      return; // a measurement bug must never take down an execution's own close path
    }
    if (record === null) return;
    try {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'cost_sampled', data: record });
    } catch { /* best-effort — mirrors every other post-close event write in this file */ }
  }
  // `finished` guards against the timeout firing and the child's own 'close'/'error' racing each
  // other right at the boundary — JS is single-threaded, so a synchronous check-then-set inside
  // markFinished() is race-free even though both a timer callback and an I/O callback are involved.
  let finished = false;
  function markFinished() {
    if (finished) return false;
    finished = true;
    return true;
  }
  // r5 #27: interruptAllExecutions (drain) moet dezelfde terminal-guard kunnen zetten als de timeout- en
  // close-handlers — anders schreef een late 'close' na het interrupted-event alsnog een normale
  // assistant-turn en was "interrupted" niet terminaal.
  entry.markFinished = markFinished;

  const timeoutMs = resolveExecTimeoutMs();
  // feat-fix-ghost-asks: pulled out of the inline scheduleExecTimeout() arrow this used to be, into
  // a named, STABLE function stored on `entry.fireExecTimeout` — pauseExecTimeoutForAsk/
  // resumeExecTimeoutAfterAsk below re-schedule this exact same function at a different duration;
  // they never redefine the kill/cleanup/event logic a second time.
  function fireExecTimeout() {
    if (!markFinished()) return; // the child already closed/errored right as the timer fired
    // Release the slot IMMEDIATELY rather than waiting for the killed child's own 'close' event —
    // this is deliberately the more defensive design: a genuinely wedged child is exactly the
    // scenario this fix targets, and such a child may never emit 'close' even after being killed.
    running.delete(convId);
    killChildTree(child);
    cleanupAskMcpConfig();
    abandonPendingAsk(convId, 'execution_timed_out');
    const firedTimeoutMs = entry.currentTimeoutMs;
    try {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'timed_out', data: { timeout_ms: firedTimeoutMs } });
      writeTurnRecord({
        turn_id: turnId,
        request_id: requestId,
        text: textBuffer,
        cost_usd: null,
        duration_ms: Date.now() - entry.startedAt,
        stop_reason: 'timed_out',
        exit_code: null,
        error: 'execution exceeded the ' + firedTimeoutMs + 'ms wall-clock timeout and was terminated',
        stderr: stderrCapture.finish(),
        // feat-live-stream gap #2: a killed-for-timeout turn can genuinely have real Edit/Write/
        // TodoWrite/Bash activity from before the timeout fired — carrying it here (instead of
        // the previous silent omission) means Test Boss/the owner sees the real work a wedged
        // child actually did, not a turn that looks like it did nothing at all.
        file_edits: fileEdits.length > 0 ? fileEdits : null,
        todos: todoSnapshot,
        shell_commands: shellCommands.length > 0 ? shellCommands : null,
        // fix-unavailable: same honest carry-through as file_edits/todos/shell_commands above —
        // a killed-for-timeout turn can genuinely have captured a real session id/agent dispatch
        // before the timeout fired.
        session_id: capturedSessionId,
        agent_type: lastAgentType,
      }, { timedOut: true });
    } catch { /* best-effort — mirrors the 'close'/'error' handlers' own rationale below */ }
    // feat-gateway-cost-sampling: a wedged child can genuinely have reported its real usage before
    // the timeout fired — same honest carry-through as file_edits/todos/session_id above. A child
    // that never got that far reported no usage, so this writes nothing.
    emitCostSampled();
  }
  entry.fireExecTimeout = fireExecTimeout;
  entry.currentTimeoutMs = timeoutMs;
  entry.timeoutDeadline = Date.now() + timeoutMs;
  entry.timeoutTimer = scheduleExecTimeout(fireExecTimeout, timeoutMs);
  // Never let this timer alone keep the gateway process alive (e.g. during a clean shutdown).
  if (typeof entry.timeoutTimer.unref === 'function') entry.timeoutTimer.unref();

  // WP8-13 gap-closing round: redact the child's raw stdout/stderr at the exact point it is
  // captured/forwarded — defense in depth ON TOP OF conversations.mjs's own write-path redaction
  // (appendConversationEvent/appendAssistantTurn). This is the highest-risk raw-output surface in
  // the gateway: a spawned `claude` child's stream-json output is never sanitized upstream, and
  // this same raw path is what feeds live SSE frames before a turn ever closes.
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    stdoutLineCount += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'stdout_unparsed', data: redact(line) });
      // App router: kept (bounded, in memory only) to classify a plain-text failure such as a lost login.
      if (routeTrack && routeTrack.unparsed.length < ROUTE_UNPARSED_CAP) routeTrack.unparsed += line.slice(0, ROUTE_UNPARSED_CAP - routeTrack.unparsed.length) + '\n';
      return;
    }
    // fix-unavailable: checked on EVERY line regardless of `type` — the real session id rides
    // along on system/assistant/user/result lines alike (see extractSessionIdFromParsedLine's own
    // doc comment for the live grep evidence), so this must not be gated to `parsed.type ===
    // 'result'` the way model/tokens/contextWindow are.
    const sessionId = extractSessionIdFromParsedLine(parsed);
    if (sessionId !== null) capturedSessionId = sessionId;
    sessionTracker.observe(parsed);
    observePermissionStreamLine(convId, parsed); // WP B3: which helper asked a permission

    // Redacted ONCE per line and reused by every branch below — the subagent/hook records are
    // distilled from the already-redacted object, so a credential can never reach a stored record
    // through the new paths either (defense in depth on top of appendConversationEvent's own
    // write-path redactDeep, exactly like the raw append has always had).
    const redactedParsed = redactDeep(parsed);

    // feat-subagent-visibility (routing branch): a line carrying a non-null `parent_tool_use_id`
    // belongs to a DISPATCHED SUBAGENT, not to this conversation. Before this branch existed such a
    // line fell straight through into the parent's own handling below. What that genuinely broke,
    // stated exactly (each point is covered by a test in test/subagent-visibility.test.mjs):
    //   - the subagent's Edit/Write/Bash/TodoWrite tool_use blocks were accumulated as the PARENT
    //     turn's own `file_edits`/`shell_commands`/`todos` — on every close path, the real bug;
    //   - every subagent line was stored as an ordinary main-conversation `assistant`/`user` event,
    //     indistinguishable in the event log (and in the live SSE tail) from the parent's own lines;
    //   - the subagent's text was concatenated into `textBuffer`. On a NORMAL close that buffer is
    //     not what the turn stores (`finalText` prefers the CLI's own `result` line), so this one
    //     surfaced only on the timeout / spawn-error paths, which do store `textBuffer`.
    // Such a line is now stored under its own `subagent_activity` kind, keyed by the dispatch's
    // tool_use id (agent-dispatches.mjs reads it back and attaches it to that dispatch's row), and
    // the handler RETURNS so none of the main-conversation branches below ever see it.
    //
    // The raw line is deliberately NOT also stored: a subagent can emit an unbounded amount of
    // thinking/tool output, and storing both the raw line and the distilled record would double
    // exactly the volume this feature has to bound. The distilled record is capped per entry and
    // per line (exec-stream-parse.mjs), and this execution's own per-dispatch byte budget
    // (`subagentActivityBudget`, created above) stops the stream of records entirely once a dispatch
    // has produced SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH of them, emitting ONE honest truncation
    // marker rather than silently dropping the rest.
    const subagentLine = extractSubagentLine(redactedParsed);
    if (subagentLine !== null) {
      const record = { parent_tool_use_id: subagentLine.parentToolUseId, role: subagentLine.role, entries: subagentLine.entries };
      const verdict = subagentActivityBudget.admit(subagentLine.parentToolUseId, record);
      if (verdict.admit) {
        appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'subagent_activity', data: record });
      } else if (verdict.truncatedNow) {
        appendConversationEvent(convId, {
          turn_id: turnId,
          request_id: requestId,
          kind: 'subagent_activity_truncated',
          data: { parent_tool_use_id: subagentLine.parentToolUseId, budget_bytes: SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH },
        });
      }
      return;
    }

    appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: parsed.type || 'unknown', data: redactedParsed });
    const streamError = extractForgeErrorFromParsedLine(parsed);
    // api_retry is transient (the CLI keeps going), so it never stands in for the final exit error.
    if (emitForgeError(convId, turnId, requestId, streamError) && streamError.code !== 'api_retry') forgeErrorEmitted = true;
    if (routeTrack) {
      if (streamError && streamError.code !== 'api_retry') routeTrack.streamError = streamError;
      if (parsed.type === 'rate_limit_event' && routeTrack.rateLimitEvents.length < ROUTE_RATE_LIMIT_EVENTS_CAP) routeTrack.rateLimitEvents.push(redactedParsed);
    }

    // feat-subagent-visibility (hook branch): a real SubagentStart/SubagentStop hook line becomes
    // its own bounded, typed `hook_event` record ALONGSIDE the raw system line above — unlike a
    // subagent line, a hook line is genuinely part of this conversation's own lifecycle, so nothing
    // is removed from the main event log here; only a distilled, directly-readable signal is added.
    // This is the only place a subagent start/end time reported by the HARNESS itself enters the
    // store, instead of being derived from the task_started/task_updated pair.
    //
    // Deliberately scoped to the two subagent lifecycle hooks (isSubagentLifecycleHook — see its
    // own comment for why that is a volume bound by construction). Every OTHER hook line
    // (PreToolUse/Stop/UserPromptSubmit/SessionStart) is still stored raw exactly as before; it
    // simply gets no second, distilled copy.
    const hookEvent = extractHookEventFromParsedLine(redactedParsed);
    if (hookEvent !== null && isSubagentLifecycleHook(hookEvent.hook_event)) {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'hook_event', data: hookEvent });
    }
    if (parsed.type === 'assistant' && parsed.message && Array.isArray(parsed.message.content)) {
      for (const block of parsed.message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') textBuffer += block.text;
        if (routeTrack && block && block.type === 'tool_use') routeTrack.toolUse = true;
        const fileEdit = extractFileEditFromToolUseBlock(block);
        if (fileEdit && fileEdits.length < MAX_FILE_EDITS_PER_TURN) {
          fileEdits.push(fileEdit);
          // feat-live-stream gap #1: emitted the moment the block arrives (not only once the
          // turn finally closes) — a dedicated `kind` so a live SSE consumer can render it
          // without reparsing the full raw `assistant` event this turn already gets above.
          appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'file_edit', data: fileEdit });
        }
        const todos = extractTodoSnapshotFromToolUseBlock(block);
        if (todos !== null) {
          todoSnapshot = todos;
          appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'todo_snapshot', data: { todos } });
        }
        const shellCommand = extractShellCommandFromToolUseBlock(block);
        if (shellCommand && shellCommands.length < MAX_SHELL_COMMANDS_PER_TURN) {
          shellCommands.push(shellCommand);
          if (shellCommand.id) shellCommandIndexById.set(shellCommand.id, shellCommands.length - 1);
          appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'shell_command', data: shellCommand });
        }
        // fix-unavailable: a real Agent dispatch this turn — "last one wins" (see this file's own
        // `capturedSessionId`/`lastAgentType` doc comment above for why).
        const agentDispatch = extractAgentDispatchFromToolUseBlock(block);
        if (agentDispatch !== null) lastAgentType = agentDispatch.subagentType;
      }
    }
    // feat-live-stream (item 3): the real tool_result reply to a Bash command arrives as a
    // SEPARATE, later stream-json line — role 'user', not 'assistant' — carrying the command's
    // own `tool_use_id` back. Only a result whose id matches a Bash command THIS turn already
    // recorded is ever attached; a tool_result for any other tool (Edit/Write/TodoWrite never
    // produce one the CLI reports this way) simply finds no match and is a no-op here.
    if (parsed.type === 'user' && parsed.message && Array.isArray(parsed.message.content)) {
      for (const block of parsed.message.content) {
        const shellResult = extractShellResultFromToolResultBlock(block);
        if (shellResult === null) continue;
        const idx = shellCommandIndexById.get(shellResult.toolUseId);
        if (idx === undefined) continue;
        shellCommands[idx] = { ...shellCommands[idx], result: shellResult.result, is_error: shellResult.is_error };
        appendConversationEvent(convId, {
          turn_id: turnId,
          request_id: requestId,
          kind: 'shell_result',
          data: { id: shellResult.toolUseId, result: shellResult.result, is_error: shellResult.is_error },
        });
      }
    }
    if (parsed.type === 'result') resultPayload = parsed;
    // feat-gateway-cost-sampling: fed the redacted line (numbers pass through redactDeep untouched)
    // AFTER the subagent early-return above, so a subagent's own lines can never be counted as this
    // execution's own result segments. Unlike `resultPayload` this accumulates instead of
    // overwriting — see exec-cost.mjs for which fields are summed and which are taken once.
    costAggregator.observe(redactedParsed);
  });

  if (child.stderr) {
    // fix-cap-order: this used to be `stderrBuffer += redact(chunk)` — redaction PER CHUNK, before the
    // buffer was later cut at STDERR_CAP_BYTES. Two ways for a secret to survive that, both measured:
    //   1. a 'data' event boundary can fall inside a credential (a child echoing a PEM to stderr does
    //      not control where the pipe splits), and neither half then matches on its own;
    //   2. the surviving raw text was then cut at STDERR_CAP_BYTES and only redacted AFTER the cut, so
    //      the PEM pattern lost the `-----END ...` it needs and left its readable head behind.
    // Measured: a PEM split at char 3950 came through the cap with its `BEGIN RSA PRIVATE KEY`
    // armour line (dashes and all) plus body intact. The dashes are left off this sentence on
    // purpose — spelled in full, the marker makes this comment itself look like a leaked key to
    // every credential scanner that reads the file, including this project's own, which reported
    // it. fix-cap-order closed both by accumulating raw and redacting ONCE at close — but that raw
    // buffer had no bound at all. WP A8 keeps the guarantee and adds the bound: stderrCapture
    // (redact.mjs createCappedRedactedCapture) streams every chunk through the stream redactor, which
    // never releases part of a secret (a split token or an open private key is held until it is
    // whole), keeps only the first STDERR_CAP_BYTES redacted chars, and stops reading after
    // STDERR_INPUT_LIMIT_CHARS. setEncoding('utf8') makes Node decode across chunk seams, so a
    // multi-byte character split by the pipe is no longer turned into two replacement characters.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrCapture.write(chunk); });
  }

  child.on('error', (err) => {
    clearExecTimeout(entry.timeoutTimer);
    if (!markFinished()) return; // the timeout handler already closed this turn out — no-op
    running.delete(convId);
    cleanupAskMcpConfig();
    abandonPendingAsk(convId, 'execution_closed');
    // Best-effort store write: this fires from Node's own child-process plumbing with no HTTP
    // caller left to report a failure to — a synchronous throw here (e.g. the store directory
    // vanished from under a stopped/late-exiting child, which real tests hit under mock mode)
    // must never escape as an uncaught process-level exception.
    try {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'spawn_error', data: { message: err.message } });
      emitForgeError(convId, turnId, requestId, toForgeErrorEvent(classifyExit({ spawnError: err.message }), 'spawn'));
      writeTurnRecord({
        turn_id: turnId,
        request_id: requestId,
        text: '',
        error: err.message,
        exit_code: null,
        // feat-live-stream gap #2: same honest carry-through as the timeout handler above — a
        // late 'error' (e.g. an EPIPE after some real stdout was already read) can still have
        // real tool activity recorded before it fired.
        file_edits: fileEdits.length > 0 ? fileEdits : null,
        todos: todoSnapshot,
        shell_commands: shellCommands.length > 0 ? shellCommands : null,
        // fix-unavailable: same honest carry-through, one field over — a late 'error' can still
        // have captured a real session id/agent dispatch from before it fired.
        session_id: capturedSessionId,
        agent_type: lastAgentType,
      }, { spawnError: true });
    } catch { /* best-effort — see comment above */ }
  });

  child.on('close', (code, signal) => {
    clearExecTimeout(entry.timeoutTimer);
    // NOTE: `timedOut`/markFinished() means this branch can never observe timedOut===true — if the
    // timeout fired first it already set `finished` and closed the turn out itself (see above), so
    // this handler would have returned above instead of reaching here. Not re-checked below.
    if (!markFinished()) return; // the timeout handler already closed this turn out — no-op
    running.delete(convId);
    cleanupAskMcpConfig();
    abandonPendingAsk(convId, 'execution_closed');
    const finalText = resultPayload ? (resultPayload.result || '') : textBuffer;
    // fix-usage-capture: the same real usage/model data the readline handler already parsed off
    // `resultPayload` above, finally kept instead of discarded — null (never 0/'') whenever the CLI
    // did not report it (mock mode, a spawn error, or a shape this parser does not recognize).
    const usageFields = extractResultUsage(resultPayload);
    // WP B8-3: no output line at all and not stopped by the user = the turn never started; make it a
    // visible FAILED turn instead of an empty "completed" one.
    const failedToStart = stdoutLineCount === 0 && resultPayload === null && !entry.stoppedByUser
      ? startFailure({ exitCode: code, signal, stderr: stderrCapture.finish() })
      : null;
    // Same best-effort rationale as the 'error' handler above.
    try {
      writeTurnRecord({
        turn_id: turnId,
        request_id: requestId,
        text: finalText,
        cost_usd: resultPayload ? (resultPayload.total_cost_usd ?? null) : null,
        duration_ms: resultPayload ? (resultPayload.duration_ms ?? null) : null,
        stop_reason: resultPayload ? (resultPayload.stop_reason ?? null) : (signal ? 'killed:' + signal : null),
        exit_code: code,
        error: failedToStart ? failedToStart.message : resultPayload && resultPayload.is_error ? 'the model reported is_error:true' : null,
        stderr: stderrCapture.finish(),
        input_tokens: usageFields.inputTokens,
        output_tokens: usageFields.outputTokens,
        cache_creation_input_tokens: usageFields.cacheCreationInputTokens,
        cache_read_input_tokens: usageFields.cacheReadInputTokens,
        model: usageFields.model,
        // fix-unavailable: `context_window` shares `usageFields`' own null-when-unreported
        // convention (it comes off the same `resultPayload.modelUsage` entry as `model`);
        // `session_id`/`agent_type` are captured independently of `resultPayload` (see this file's
        // own `capturedSessionId`/`lastAgentType` doc comment above), so they stay real even on a
        // turn shape `extractResultUsage` cannot otherwise parse.
        context_window: usageFields.contextWindow,
        session_id: capturedSessionId,
        agent_type: lastAgentType,
        // fix-stream-insights: explicit null (never omitted) when this turn never called
        // Edit/Write/TodoWrite — mirrors the usage fields' own "explicit null, never a fabricated
        // value" convention directly above.
        file_edits: fileEdits.length > 0 ? fileEdits : null,
        todos: todoSnapshot,
        // feat-live-stream: same explicit-null convention, one field over, for real Bash
        // commands (command/description/result/is_error) this turn genuinely ran.
        shell_commands: shellCommands.length > 0 ? shellCommands : null,
      }, { exitCode: code, isErrorResult: !!(resultPayload && resultPayload.is_error), failedToStart, stderr: stderrCapture.finish() });
    } catch { /* best-effort — see comment above */ }
    // WP B3: a failed exit that the stream itself did not explain gets one classified error.
    if (failedToStart && !forgeErrorEmitted) {
      emitForgeError(convId, turnId, requestId, toForgeErrorEvent(failedToStart.payload, 'exit'));
    } else if (!forgeErrorEmitted && !entry.stoppedByUser && code !== 0) {
      emitForgeError(convId, turnId, requestId, toForgeErrorEvent(classifyExit({ exitCode: code, stderr: stderrCapture.finish() }), 'exit'));
    }
    // WP A4: a resumed session that failed before the CLI started it is dropped, so the next turn
    // starts a fresh session instead of failing on the same stale id; recorded as a visible event.
    if (sessionTracker.finish({ exitCode: code }) === 'cleared') {
      try {
        appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'session_resume_failed', data: { session_id: sessionOptions.resumeSessionId, exit_code: code } });
      } catch { /* best-effort — see comment above */ }
    }
    // feat-gateway-cost-sampling: the normal run-close path — the one place a full, real stream has
    // genuinely finished arriving, so this is where the measurement is honest and complete.
    emitCostSampled();
  });

  return { started: true, turnId, requestId };
}

// Stop = kill the child (via the shared killChildTree() helper above), clear its wall-clock timeout
// timer (fix-exec-timeout — no dangling timer left behind after a manual stop), then record the stop
// event. Idempotent: stopping an already-finished/unknown conversation is a truthful no-op, never an
// error. The real, normal 'close' event still fires afterward for the now-killed child and records
// the assistant turn exactly as before this fix — this function only stops the child and clears the
// timer, it does not itself close out the turn.
export function stopExecution(convId) {
  const entry = running.get(convId);
  if (!entry) return { stopped: false };
  if (entry.kind === 'provider') return stopProviderRun(convId, entry);
  const { child, turnId, requestId, timeoutTimer } = entry;
  running.delete(convId);
  clearExecTimeout(timeoutTimer);
  entry.stoppedByUser = true;
  interruptThenKill(child); // WP B3: interrupt -> close stdin -> kill the exact PID
  appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'stopped_by_user' });
  // fix-ghost-asks: the real root cause this WP measured — a stop used to kill the child and log
  // stopped_by_user without ever touching a still-pending ask, leaving the dashboard showing a
  // question nobody is listening to anymore (see this file's own `abandonPendingAsk` header).
  abandonPendingAsk(convId, 'execution_stopped');
  return { stopped: true };
}

// ---- App router P2 helpers ----------------------------------------------------------------------

const ROUTE_UNPARSED_CAP = 600;
const ROUTE_RATE_LIMIT_EVENTS_CAP = 16;

// Closes the child's stdin after writing the handover (if any). An 'error' on stdin (EPIPE: the child
// exited before it read) is reported through onError only when context was really being written; an
// empty close that races the child's exit loses nothing, and the turn's close path reports the turn.
function writeRouteStdin(child, text, onError) {
  const stdin = child && child.stdin;
  if (!stdin) return;
  stdin.on('error', (err) => { if (text) onError(err); });
  if (text) stdin.write(text);
  stdin.end();
}

/**
 * The outcome of one routed attempt (design 4.7 `outcome`). Pure; exported for tests.
 * Order: a user stop, then a timeout or spawn error, then a clean answer, then the classified code.
 */
export function routeOutcomeFor({ stoppedByUser = false, timedOut = false, spawnError = false, exitCode = null, isErrorResult = false, errorCode = null } = {}) {
  if (stoppedByUser) return 'stopped';
  if (timedOut || spawnError) return 'error';
  if (exitCode === 0 && !isErrorResult) return 'ok';
  if (errorCode === 'rate_limited') return 'rate_limited';
  if (errorCode === 'logged_out') return 'logged_out';
  return 'error';
}

// Everything onSettled gets about a finished CLI attempt.
function routeAttemptResult(end, track, stoppedByUser) {
  let errorCode = track.streamError ? track.streamError.code : null;
  let resumeAt = track.streamError ? track.streamError.resume_at || null : null;
  if (!errorCode && !end.timedOut && !end.spawnError && end.exitCode !== 0) {
    const fromExit = end.failedToStart ? end.failedToStart.payload : classifyExit({ exitCode: end.exitCode, stderr: end.stderr });
    if (fromExit && fromExit.code !== 'unknown') errorCode = fromExit.code;
    if (!errorCode && track.unparsed) {
      const fromText = classifyErrorText(track.unparsed);
      if (fromText.code !== 'unknown') errorCode = fromText.code;
    }
    if (fromExit && fromExit.resume_at) resumeAt = fromExit.resume_at;
  }
  const outcome = routeOutcomeFor({ stoppedByUser, timedOut: end.timedOut, spawnError: end.spawnError, exitCode: end.exitCode === undefined ? null : end.exitCode, isErrorResult: end.isErrorResult, errorCode });
  return {
    outcome,
    errorCode,
    resumeAt,
    hadToolUse: track.toolUse,
    stoppedByUser,
    timedOut: end.timedOut === true,
    exitCode: end.exitCode === undefined ? null : end.exitCode,
    rateLimitEvents: track.rateLimitEvents.slice(),
  };
}

function stopProviderRun(convId, entry) {
  running.delete(convId);
  entry.stoppedByUser = true;
  try {
    entry.abort('stopped');
  } catch (err) {
    try {
      appendConversationEvent(convId, { turn_id: entry.turnId, request_id: entry.requestId, kind: 'stop_failed', data: { message: err && err.message ? err.message : String(err) } });
    } catch { /* best-effort */ }
  }
  appendConversationEvent(convId, { turn_id: entry.turnId, request_id: entry.requestId, kind: 'stopped_by_user' });
  abandonPendingAsk(convId, 'execution_stopped');
  return { stopped: true };
}

function interruptProviderRun(convId, entry, reason) {
  running.delete(convId);
  entry.markFinished(); // terminal: the provider turn's own finish path then writes no turn record
  try { entry.abort('drain'); } catch { /* best-effort — the interrupted event below is the ledger outcome */ }
  try { appendConversationEvent(convId, { turn_id: entry.turnId, request_id: entry.requestId, kind: 'interrupted', data: { reason: reason || 'gateway drain' } }); } catch { /* best-effort */ }
  emitForgeError(convId, entry.turnId, entry.requestId, toForgeErrorEvent(gatewayRestartedError(reason || 'gateway drain'), 'gateway'));
  abandonPendingAsk(convId, 'gateway_drain');
  return { convId, pid: null, kind: 'provider' };
}

/** SHUTDOWN-COÖRDINATIE (Codex r4 #13-rest). De drain sloot alleen HTTP: actieve claude-
 *  children liepen door terwijl de supervisor al een verse gateway startte — twee schrijvers op dezelfde
 *  bestanden. Nu: (1) `enterDrainMode()` blokkeert elke NIEUWE executie met een eerlijke reden;
 *  (2) `interruptAllExecutions()` markeert iedere lopende executie duurzaam als 'interrupted' in haar
 *  conversation-ledger, tree-killt de exacte kind-PID (killChildTree — /T op win32, eigen spawns) en
 *  sluit hangende asks af. Beide worden door bin.mjs' degradeAndDrain aangeroepen vóór de exit. */
let drainModeReason = null;
export function enterDrainMode(reason) { drainModeReason = reason || 'gateway is draining after a fatal error'; }
export function isDraining() { return drainModeReason !== null; }
export function interruptAllExecutions(reason) {
  const interrupted = [];
  for (const [convId, entry] of [...running.entries()]) {
    if (entry.kind === 'provider') {
      interrupted.push(interruptProviderRun(convId, entry, reason));
      continue;
    }
    const { child, turnId, requestId, timeoutTimer } = entry;
    running.delete(convId);
    clearExecTimeout(timeoutTimer);
    // r5 #27: terminal-guard EERST — de close/error-handlers van dit kind zien finished=true en schrijven
    // geen normale assistant-turn meer; 'interrupted' is daarmee de ene terminale ledgeruitkomst.
    if (typeof entry.markFinished === 'function') entry.markFinished();
    killChildTree(child);
    try { appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'interrupted', data: { reason: reason || 'gateway drain' } }); } catch { /* best-effort — de kill zelf is het belangrijkst */ }
    emitForgeError(convId, turnId, requestId, toForgeErrorEvent(gatewayRestartedError(reason || 'gateway drain'), 'gateway'));
    abandonPendingAsk(convId, 'gateway_drain');
    interrupted.push({ convId, pid: child && child.pid });
  }
  return interrupted;
}

/**
 * feat-fix-ghost-asks item 4: called by server.mjs the instant a real `ask_owner` call registers a
 * pending question for THIS conv's currently running execution (`POST /api/ask`, BEFORE it starts
 * awaiting the owner's answer) — pauses that execution's own wall-clock reaper timer for exactly
 * as long as the ask itself is willing to wait (`askTimeoutMs`, ask-store.mjs's own real per-ask
 * timeout), never longer.
 *
 * WHY: fix-exec-timeout's own header states the exec timeout exists to reap a genuinely WEDGED
 * child; a child parked on `ask_owner`, waiting for an answer the gateway itself asked the owner
 * for, is not wedged (this WP's own diagnosis: "a child that waits for the owner is not
 * vastgelopen"). Before this fix the two clocks contradicted each other — a question arriving at
 * minute 25 of a 30-minute exec budget really only gave the owner 5 minutes to answer, while the
 * ask registry's own promised `timeoutMs` kept claiming a full 30. Pausing the reaper for the
 * ask's own real window fixes the EXPERIENCE, not just the label: the owner genuinely gets up to
 * the full ask window regardless of when in the run the question arrives.
 *
 * SAFETY CAP (bounded, per the WP's own instruction): the replacement timer runs for EXACTLY
 * `askTimeoutMs` — never "however much of the original exec budget was left" (that would defeat
 * the point of pausing) and never unbounded (a genuinely abandoned ask must still eventually reap
 * the child — it does, at essentially the same moment ask-store.mjs's own per-ask timeout would
 * fire). On resume (`resumeExecTimeoutAfterAsk`) the ORIGINAL remaining budget is restored, never
 * reset to a fresh full window — so no number of sequential asks can extend an execution's total
 * real lifetime beyond (original remaining budget + one ask window), which stays bounded.
 *
 * No-op (never throws) when this convId has no running execution (mock mode aside, this simply
 * means the execution already ended before the pause call landed).
 */
export function pauseExecTimeoutForAsk(convId, askTimeoutMs) {
  const entry = running.get(convId);
  if (!entry || typeof entry.fireExecTimeout !== 'function') return;
  if (entry.timeoutTimer === null && !entry.permissionPaused) return;
  const now = Date.now();
  // WP B3-gw fix: the ORIGINAL budget is saved once, by whichever pause came first; a second ask
  // (or an ask under an open permission card) never overwrites it with an active cap's remainder.
  if (entry.pausedRemainingMs === undefined) entry.pausedRemainingMs = Math.max(0, entry.timeoutDeadline - now);
  entry.askPaused = true;
  entry.askDeadline = now + Math.max(0, askTimeoutMs);
  applyReaperPauseState(entry, now);
}

/**
 * feat-fix-ghost-asks item 4: the resume half of `pauseExecTimeoutForAsk` above — called by
 * server.mjs the moment an ask's blocked promise settles (answered, timed out, OR abandoned — see
 * that route's own comment), regardless of outcome. Restores the ORIGINAL remaining exec budget
 * that was left when the pause began, never a fresh full window, so the reaper still eventually
 * fires for a genuinely wedged execution once the ask concludes. WP B3-gw: while a permission card
 * is still open the run stays paused; the budget comes back only when both pauses are clear
 * (applyReaperPauseState below).
 *
 * No-op (never throws) when this convId is not currently paused: never paused, already resumed, or
 * the execution already ended (`running.get(convId)` returns nothing once any of the four real
 * end-paths above has run — including this exact ask's own abandonment, which is the common case).
 */
export function resumeExecTimeoutAfterAsk(convId) {
  const entry = running.get(convId);
  if (!entry || !entry.askPaused) return;
  entry.askPaused = false;
  entry.askDeadline = undefined;
  applyReaperPauseState(entry, Date.now());
}

/**
 * WP B3 (plan 4.4): while a permission card of this run is open the wall-clock reaper is paused
 * WITHOUT a cap: an unanswered card is "Gepauzeerd", never a failure. The remaining budget is kept
 * and restored by resumeExecTimeoutAfterPermission once the last open card is answered. Called by
 * permissions/store.mjs through setRunPauseHooks (below). Returns true when it paused a run.
 */
export function pauseExecTimeoutForPermission(convId) {
  const entry = running.get(convId);
  if (!entry || typeof entry.fireExecTimeout !== 'function') return false;
  if (entry.permissionPaused) return true;
  const now = Date.now();
  if (entry.pausedRemainingMs === undefined) entry.pausedRemainingMs = Math.max(0, entry.timeoutDeadline - now);
  entry.permissionPaused = true;
  applyReaperPauseState(entry, now);
  return true;
}

export function resumeExecTimeoutAfterPermission(convId) {
  const entry = running.get(convId);
  if (!entry || !entry.permissionPaused) return;
  entry.permissionPaused = false;
  applyReaperPauseState(entry, Date.now());
}

/**
 * WP B3-gw fix (Review Boss LOW): the ONE place that turns the two independent pause flags into
 * the reaper's actual timer, so neither resume path can restore the budget while the other pause
 * is still active:
 *   - an open permission card (permissionPaused): no deadline at all;
 *   - else an open ask (askPaused): the rest of that ask's own window, counted from the ask's start;
 *   - else (both clear): the ORIGINAL remaining budget saved by the first pause, never a fresh one.
 */
function applyReaperPauseState(entry, now) {
  if (!entry.permissionPaused && !entry.askPaused && entry.pausedRemainingMs === undefined) return;
  clearExecTimeout(entry.timeoutTimer);
  entry.timeoutTimer = null;
  if (entry.permissionPaused) {
    entry.timeoutDeadline = Infinity;
    return;
  }
  let ms;
  if (entry.askPaused) {
    ms = Math.max(0, entry.askDeadline - now);
  } else {
    ms = entry.pausedRemainingMs;
    delete entry.pausedRemainingMs;
  }
  entry.currentTimeoutMs = ms;
  entry.timeoutDeadline = now + ms;
  entry.timeoutTimer = scheduleExecTimeout(entry.fireExecTimeout, ms);
  if (typeof entry.timeoutTimer.unref === 'function') entry.timeoutTimer.unref();
}

setRunPauseHooks({ pause: pauseExecTimeoutForPermission, resume: resumeExecTimeoutAfterPermission });

/** Test-only: exposes whether `convId`'s currently running execution has its wall-clock timer
 *  paused for a pending ask right now — `null` when there is no running execution for it at all. */
export function _isExecTimeoutPausedForAskForTests(convId) {
  const entry = running.get(convId);
  if (!entry) return null;
  return entry.askPaused === true;
}

/** Test-only: approximately how many ms remain before `convId`'s currently ACTIVE timeout timer
 *  would fire (negative once it is already overdue) — lets a test assert the real scheduled
 *  deadline deterministically instead of waiting out an actual timer fire. `null` when there is no
 *  running execution for it at all. */
export function _execTimeoutRemainingMsForTests(convId) {
  const entry = running.get(convId);
  if (!entry) return null;
  return entry.timeoutDeadline - Date.now();
}

// Test-only hooks: never leak resolved-path/running-map state across test files. Clearing every
// tracked entry's own timeoutTimer BEFORE clearing the map matters — a bare `running.clear()` only
// drops the Map's references, it does not cancel a still-pending real setTimeout, which could
// otherwise fire later (mid a LATER, unrelated test) and write into whatever store that later test
// has set up.
export function _resetExecBridgeForTests() {
  _resetClaudeCliResolutionForTests();
  for (const entry of running.values()) {
    clearExecTimeout(entry.timeoutTimer);
    if (entry.kind === 'provider') {
      entry.markFinished();
      try { entry.abort('reset'); } catch { /* test reset only: the stream is being thrown away */ }
    }
  }
  running.clear();
  execTimeoutMsOverride = null;
  drainModeReason = null;
  spawnSpecOverride = null;
}
