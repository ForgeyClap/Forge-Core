// Forge Command Center gateway — exec-bridge argv construction (modes/effort/prompt-validation +
// the mock child spawn spec) (refactor-gateway-split). Split out of the
// single exec-bridge.mjs (had grown to ~754 lines, over this project's own 500-line-per-file
// guidance) into its own real seam. Every name below is re-exported from exec-bridge.mjs under its
// EXACT original name — see that file's own header for the full architecture/history/honesty rules
// this slice still follows; no other file in the codebase needed to change a single import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveClaudeCliPath, claudeCliSupportsFlag } from './exec-cli.mjs';
import { COMMAND_CENTER_DATA_DIR } from './paths.mjs';
import { gatewayOrigin } from './runtime-state.mjs';
import { FORGE_LEAD_PREAMBLE } from './forge-preamble.mjs';
import { sessionArgv } from './sessions/argv-session.mjs';

// Fixed mock script (never string-built from request input) — emits exactly 3 fake stream-json
// lines then exits 0, echoing the real prompt text back so gateway tests can assert genuine
// round-tripping through the same parsing path the real CLI's stream-json output uses. An
// optional CC_EXEC_MOCK_DELAY_MS lets concurrency tests observe an execution while still "running".
//
// fix-stream-insights: when the prompt text contains the literal marker '__MOCK_TOOLS__', the
// assistant message's `content` array ALSO carries an Edit tool_use block, a Write tool_use block,
// a TodoWrite tool_use block and (feat-live-stream) a Bash tool_use block — the real shapes
// captured live from this project's own `.data/conversations/*.jsonl` (see this WP's forge-report
// for the exact JSON and the _extractFileEditForTests/_extractTodoSnapshotForTests/
// _extractShellCommandForTests/_extractShellResultForTests unit tests that assert against those
// real fixtures directly). feat-live-stream also adds one extra `type:'user'` line right after the
// assistant line — a real tool_result reply to the Bash command, matched back by `tool_use_id` —
// ONLY when the marker is present; every OTHER test's prompt text (never containing the marker)
// keeps emitting exactly the same 3 lines as before, which is what proves "no tool_use -> the new
// fields are genuinely absent" without needing a second mock script.
//
// feat-live-stream gap #2 test support: a SECOND marker, '__MOCK_HANG_AFTER_TOOLS__', writes the
// real tool activity lines (system/assistant-with-tools/tool_result) IMMEDIATELY, then never emits
// a `result` line at all — it just keeps the process alive (a pending timer, same idiom the
// existing CC_EXEC_MOCK_DELAY_MS-based timeout tests already use to keep a mock child "still
// running") until the gateway's own wall-clock timeout kills it. This is the real shape a wedged
// CLI that already reported some tool_use activity but never finished takes — proving the timeout
// path genuinely carries forward whatever activity was captured before the kill, not just an
// honest "nothing happened" turn.
// feat-subagent-visibility: two MORE markers, '__MOCK_SUBAGENT__' and
// '__MOCK_SUBAGENT_NO_HOOKS__' (deliberately NOT substrings of each other, so each selects exactly
// one behaviour). Both emit the REAL line shapes captured live from claude CLI v2.1.220 and stored
// under test/fixtures/subagent-stream-*.jsonl: a parent `Agent` tool_use, its `system:task_started`
// (task_type local_agent, tool_use_id === the Agent block's id) / `system:task_updated` pair, and
// three lines carrying a non-null `parent_tool_use_id` — the subagent's own thinking, its Glob
// tool_use, its tool_result, and its final reply. The '__MOCK_SUBAGENT__' variant additionally
// emits the two real SubagentStart/SubagentStop hook_started+hook_response pairs; the
// '_NO_HOOKS__' variant emits none at all, which is the honest shape on a machine where no hook is
// configured or matches (measured: without --include-hook-events only SessionStart hooks appear,
// and on a hook-less machine the flag yields nothing whatsoever).
// feat-gateway-cost-sampling: two MORE markers, '__MOCK_USAGE__' and '__MOCK_USAGE_HANG__'
// (neither is a substring of the other, nor of any marker above, so each selects exactly one
// behaviour). Both replay the REAL usage shape captured live in
// test/fixtures/subagent-stream-both-flags.jsonl: TWO `system:init` lines and TWO `result` lines for
// ONE invocation (the Agent tool runs async and the CLI flushes a second result for the task
// notification), each result carrying its own PER-SEGMENT `usage` block plus the SAME cumulative
// `modelUsage` snapshot — the exact shape a naive aggregator would double count. The numbers below
// are copied verbatim from that capture, so a test asserting them is asserting measured reality.
// '__MOCK_USAGE_HANG__' writes those same lines and then never exits, which is the real shape of a
// child that already reported its usage and then wedged — proving the wall-clock timeout path still
// records the measurement it genuinely observed.
// WP A4 (shared session module): '__MOCK_SESSION__' (not a substring of any marker above), or a
// `--resume <id>` in the argv that buildSpawnSpec passes after the prompt, switches the DEFAULT
// path into session mode: its init and result lines carry a session_id (the resumed id; with
// --fork-session or on a first turn a fresh 'mock-fork-…'/'mock-sess-…' id) and the reply text ends
// with ' SESSION_ARGS:[<argv after the prompt>]', so a test can read back what the turn was really
// spawned with. Without the marker and without --resume every line is byte-identical to before.
const MOCK_SCRIPT = `
const t = process.argv[1] || '';
const delay = Number(process.env.CC_EXEC_MOCK_DELAY_MS || '0');
const hasTools = t.indexOf('__MOCK_TOOLS__') !== -1;
const hangAfterTools = t.indexOf('__MOCK_HANG_AFTER_TOOLS__') !== -1;
const subagentWithHooks = t.indexOf('__MOCK_SUBAGENT__') !== -1;
const subagentNoHooks = t.indexOf('__MOCK_SUBAGENT_NO_HOOKS__') !== -1;
const hasSubagent = subagentWithHooks || subagentNoHooks;
const usageHang = t.indexOf('__MOCK_USAGE_HANG__') !== -1;
const hasUsage = t.indexOf('__MOCK_USAGE__') !== -1;
const extraArgs = process.argv.slice(2);
const resumeIdx = extraArgs.indexOf('--resume');
const resumeId = resumeIdx !== -1 ? (extraArgs[resumeIdx + 1] || null) : null;
const forkSession = extraArgs.indexOf('--fork-session') !== -1;
const sessionMode = t.indexOf('__MOCK_SESSION__') !== -1 || resumeId !== null;
const mockSessionId = !sessionMode ? null : (resumeId && !forkSession) ? resumeId
  : 'mock-' + (forkSession ? 'fork' : 'sess') + '-' + Math.random().toString(16).slice(2, 10).padEnd(8, '0');
function writeLine(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
// fix-cap-order: '__MOCK_STDERR_SPLIT_SECRET__' makes the mock child echo a PEM private key to its
// OWN stderr in TWO separate writes that deliberately split the key in half, positioned so the key
// also straddles STDERR_CAP_BYTES. That is the real shape of the leak measured on this path: a child
// does not control where the pipe splits, so per-chunk redaction saw two non-matching halves and the
// cap then cut the reassembled key before anything redacted it again. Only the real spawn path can
// prove this, so the mock has to be able to produce it.
// The armour markers are joined from two halves rather than written as one literal. The generated
// key is byte-for-byte what it always was — this changes nothing the mock emits — but a complete
// marker sitting in a tracked source file is, to any credential scanner including this project's
// own, indistinguishable from a real leaked key, and it was reported as one. The fixture has to
// keep the exact marker to be a fixture at all, so the marker is assembled instead of spelled.
if (t.indexOf('__MOCK_STDERR_SPLIT_SECRET__') !== -1) {
  const PEM_TAIL = 'PRIVATE KEY-----';
  const pem = '-----BEGIN RSA ' + PEM_TAIL + '\\n' + 'MIIEow'.repeat(600) + '\\n-----END RSA ' + PEM_TAIL;
  const whole = 'e'.repeat(3900) + pem + 'tail';
  process.stderr.write(whole.slice(0, 3950));
  process.stderr.write(whole.slice(3950));
}
function emitUsage() {
  const SID = 'mock-session-usage';
  const MU = { 'claude-haiku-4-5-20251001': { inputTokens: 46, outputTokens: 1531, cacheReadInputTokens: 205304, cacheCreationInputTokens: 79337, webSearchRequests: 0, costUSD: 0.15797190000000003, contextWindow: 200000, maxOutputTokens: 32000, canonicalModel: 'claude-haiku-4-5', provider: 'firstParty' } };
  writeLine({ type: 'system', subtype: 'init', session_id: SID, uuid: 'mock-init-1', model: 'claude-haiku-4-5-20251001' });
  writeLine({ type: 'assistant', session_id: SID, message: { content: [{ type: 'text', text: 'MOCK-USAGE' }] } });
  writeLine({ type: 'system', subtype: 'init', session_id: SID, uuid: 'mock-init-2', model: 'claude-haiku-4-5-20251001' });
  writeLine({ type: 'result', subtype: 'success', is_error: false, result: 'MOCK-USAGE', session_id: SID, uuid: 'mock-result-1', num_turns: 2, total_cost_usd: 0.08159340000000001, duration_ms: 6167, stop_reason: 'end_turn', usage: { input_tokens: 18, output_tokens: 386, cache_creation_input_tokens: 35616, cache_read_input_tokens: 84134 }, modelUsage: MU });
  writeLine({ type: 'result', subtype: 'success', is_error: false, result: 'MOCK-USAGE', session_id: SID, uuid: 'mock-result-2', num_turns: 1, total_cost_usd: 0.15797190000000003, duration_ms: 1738, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 43, cache_creation_input_tokens: 5143, cache_read_input_tokens: 60188 }, modelUsage: MU });
}
function emitSubagent() {
  const AGENT_ID = 'toolu_mock_agent';
  const SID = 'mock-session-subagent';
  writeLine({ type: 'system', subtype: 'init', session_id: SID });
  writeLine({ type: 'assistant', parent_tool_use_id: null, session_id: SID, message: { content: [
    { type: 'text', text: 'PARENT-TEXT' },
    { type: 'tool_use', id: AGENT_ID, name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Count the test files', prompt: 'count them' } },
  ] } });
  if (subagentWithHooks) {
    // A real NON-subagent hook pair (captured verbatim in the fixtures as PreToolUse:Agent) — it
    // must stay a plain raw system event and never get a distilled hook_event record of its own.
    writeLine({ type: 'system', subtype: 'hook_started', hook_id: 'hook-pre-1', hook_name: 'PreToolUse:Agent', hook_event: 'PreToolUse', session_id: SID });
    writeLine({ type: 'system', subtype: 'hook_response', hook_id: 'hook-pre-1', hook_name: 'PreToolUse:Agent', hook_event: 'PreToolUse', output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success', session_id: SID });
    writeLine({ type: 'system', subtype: 'hook_started', hook_id: 'hook-start-1', hook_name: 'SubagentStart:general-purpose', hook_event: 'SubagentStart', session_id: SID });
    writeLine({ type: 'system', subtype: 'hook_response', hook_id: 'hook-start-1', hook_name: 'SubagentStart:general-purpose', hook_event: 'SubagentStart', output: '[OK] Hook: status\\n', stdout: '[OK] Hook: status\\n', stderr: '', exit_code: 0, outcome: 'success', session_id: SID });
  }
  writeLine({ type: 'system', subtype: 'task_started', task_id: 'mock_task_1', tool_use_id: AGENT_ID, description: 'Count the test files', subagent_type: 'general-purpose', task_type: 'local_agent', session_id: SID });
  writeLine({ type: 'user', parent_tool_use_id: null, session_id: SID, message: { content: [
    { type: 'tool_result', tool_use_id: AGENT_ID, content: 'Agent is working. Waiting for completion notification.', is_error: false },
  ] } });
  // The subagent runs its OWN Bash and Edit tools. Same real tool_use block shape the fixtures
  // capture (only name/input differ from the Glob call recorded there) — and deliberately the two
  // tool names the parent-turn extractors DO act on, so a test can prove those blocks are never
  // accumulated onto the parent turn's own shell_commands/file_edits.
  writeLine({ type: 'assistant', parent_tool_use_id: AGENT_ID, session_id: SID, message: { content: [
    { type: 'thinking', thinking: 'SUBAGENT-THINKING about the test directory' },
    { type: 'tool_use', id: 'toolu_mock_sub_bash', name: 'Bash', input: { command: 'ls test', description: 'SUBAGENT-ONLY shell command' } },
    { type: 'tool_use', id: 'toolu_mock_sub_edit', name: 'Edit', input: { file_path: '/mock/subagent/only.txt', old_string: 'a', new_string: 'b' } },
  ] } });
  writeLine({ type: 'user', parent_tool_use_id: AGENT_ID, session_id: SID, message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_mock_sub_bash', content: 'test/a.test.mjs\\ntest/b.test.mjs', is_error: false },
  ] } });
  writeLine({ type: 'assistant', parent_tool_use_id: AGENT_ID, session_id: SID, message: { content: [
    { type: 'text', text: 'SUBAGENT-ONLY-TEXT-67' },
  ] } });
  if (subagentWithHooks) {
    writeLine({ type: 'system', subtype: 'hook_started', hook_id: 'hook-stop-1', hook_name: 'SubagentStop', hook_event: 'SubagentStop', session_id: SID });
    writeLine({ type: 'system', subtype: 'hook_response', hook_id: 'hook-stop-1', hook_name: 'SubagentStop', hook_event: 'SubagentStop', output: '[OK] Task completed\\n', stdout: '[OK] Task completed\\n', stderr: '', exit_code: 0, outcome: 'success', session_id: SID });
  }
  writeLine({ type: 'system', subtype: 'task_updated', task_id: 'mock_task_1', patch: { status: 'completed', end_time: Date.now() }, session_id: SID });
  writeLine({ type: 'result', is_error: false, result: 'PARENT-TEXT', total_cost_usd: 0.0002, duration_ms: 5, num_turns: 1, stop_reason: 'end_turn', session_id: SID });
}
const replyText = 'MOCK:' + t + (sessionMode ? ' SESSION_ARGS:[' + extraArgs.join(' ') + ']' : '');
function buildContent() {
  const content = [{ type: 'text', text: replyText }];
  if (hasTools || hangAfterTools) {
    content.push({ type: 'tool_use', id: 'toolu_mock_edit', name: 'Edit', input: { file_path: '/mock/project/file.txt', old_string: 'old line', new_string: 'new line' } });
    content.push({ type: 'tool_use', id: 'toolu_mock_write', name: 'Write', input: { file_path: '/mock/project/new-file.txt', content: 'brand new file contents' } });
    content.push({ type: 'tool_use', id: 'toolu_mock_todo', name: 'TodoWrite', input: { todos: [
      { content: 'Do the mock thing', status: 'in_progress', activeForm: 'Doing the mock thing' },
      { content: 'Do the next mock thing', status: 'pending', activeForm: 'Doing the next mock thing' },
    ] } });
    content.push({ type: 'tool_use', id: 'toolu_mock_bash', name: 'Bash', input: { command: 'echo mock-command', description: 'Run a mock shell command' } });
  }
  return content;
}
// App router P2 (design 6.1, review finding 16): an explicit test seam, ONLY when CC_ROUTER_MOCK=1
// (the router's own tests and the e2e set it). Without it nothing below runs and every other branch
// is byte-identical to before. With it the mock acts like the CLI under a Claude Code profile:
//   - the profile is the CLAUDE_CONFIG_DIR folder name, or 'main' when none is set;
//   - a file 'mock-limit' in that folder (or CC_ROUTER_MOCK_MAIN_LIMIT=1 for 'main') makes it emit the
//     recorded rate-limit-rejected line shape (resetsAt one hour from now, so the hit is still in
//     force) plus a result with is_error:true and api_error_status 429, then exit 1; '__MOCK_TOOLS__'
//     in the prompt puts a tool_use assistant line in front of the limit;
//   - a file 'mock-logged-out' in the profile folder makes it answer like the real CLI 2.1.316 does for
//     an empty profile in stream-json mode (captured 2026-11-02 at zero cost: an assistant line with
//     error 'authentication_failed', then a result with is_error:true, api_error_status null and the
//     text 'Not logged in · Please run /login') and exit 1;
//   - otherwise it answers 'MOCK-PROFILE:<name>', plus ' HANDOVER_CHARS:<n>' when context arrived on
//     stdin and ' SESSION_ARGS:[...]' when session flags were passed; with '__MOCK_STDIN_STATE__' in the
//     prompt it also says how stdin ended (' STDIN:end' = closed by the gateway, ' STDIN:timeout' = left open).
// It reads stdin until it ends (the router always closes it) or 1.5 s pass (router off leaves it open).
function runRouterMock() {
  const fs = require('fs');
  const path = require('path');
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || '';
  const name = cfgDir ? path.basename(cfgDir) : 'main';
  const limited = cfgDir ? fs.existsSync(path.join(cfgDir, 'mock-limit')) : process.env.CC_ROUTER_MOCK_MAIN_LIMIT === '1';
  const sid = (resumeId && !forkSession) ? resumeId : 'mock-' + name.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) + '-' + Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  let stdinText = '';
  let proceeded = false;
  function answer() {
    if (cfgDir && fs.existsSync(path.join(cfgDir, 'mock-logged-out'))) {
      const notLoggedIn = 'Not logged in · Please run /login';
      writeLine({ type: 'system', subtype: 'init', session_id: sid });
      writeLine({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: notLoggedIn }] }, parent_tool_use_id: null, session_id: sid, error: 'authentication_failed', is_api_error_message: true });
      writeLine({ type: 'result', subtype: 'success', is_error: true, api_error_status: null, result: notLoggedIn, session_id: sid, total_cost_usd: 0, num_turns: 1, stop_reason: 'stop_sequence', terminal_reason: 'api_error' });
      process.exitCode = 1;
      return;
    }
    writeLine({ type: 'system', subtype: 'init', session_id: sid });
    if (limited) {
      if (hasTools) writeLine({ type: 'assistant', session_id: sid, message: { content: buildContent() } });
      writeLine({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false }, uuid: '00000000-0000-4000-8000-0000000000c1', session_id: sid });
      writeLine({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your limit", session_id: sid, total_cost_usd: 0, duration_ms: 5, num_turns: 1, stop_reason: null });
      process.exitCode = 1;
      return;
    }
    const reply = 'MOCK-PROFILE:' + name + (stdinText ? ' HANDOVER_CHARS:' + stdinText.length : '') + (extraArgs.length ? ' SESSION_ARGS:[' + extraArgs.join(' ') + ']' : '') + (t.indexOf('__MOCK_STDIN_STATE__') !== -1 ? ' STDIN:' + stdinHow : '');
    writeLine({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: reply }] } });
    writeLine({ type: 'result', is_error: false, result: reply, session_id: sid, total_cost_usd: 0.0002, duration_ms: 5, num_turns: 1, stop_reason: 'end_turn' });
  }
  let stdinHow = 'timeout';
  function proceed(how) {
    if (proceeded) return;
    proceeded = true;
    if (typeof how === 'string') stdinHow = how;
    clearTimeout(stdinTimer);
    process.stdin.removeAllListeners('data');
    process.stdin.destroy();
    if (delay > 0) setTimeout(answer, delay); else answer();
  }
  const stdinTimer = setTimeout(proceed, 1500);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { stdinText += c; });
  process.stdin.on('end', () => proceed('end'));
  process.stdin.on('error', () => proceed('error'));
}
if (process.env.CC_ROUTER_MOCK === '1') {
  runRouterMock();
} else if (usageHang) {
  emitUsage();
  // Deliberately no exit — a pending timer keeps this process alive until the gateway's own
  // wall-clock timeout kills it, exactly like __MOCK_HANG_AFTER_TOOLS__ above.
  setTimeout(() => {}, Math.max(delay, 5000));
} else if (hasUsage) {
  if (delay > 0) setTimeout(emitUsage, delay); else emitUsage();
} else if (hasSubagent) {
  if (delay > 0) setTimeout(emitSubagent, delay); else emitSubagent();
} else if (hangAfterTools) {
  writeLine({ type: 'system', subtype: 'init' });
  writeLine({ type: 'assistant', message: { content: buildContent() } });
  writeLine({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_mock_bash', content: 'mock-command\\n', is_error: false },
  ] } });
  // Deliberately no 'result' line and no exit — a pending timer keeps this process alive until
  // the gateway's own wall-clock timeout (or a manual stop) kills it via taskkill/SIGKILL.
  setTimeout(() => {}, Math.max(delay, 5000));
} else {
  function emit() {
    const lines = [
      sessionMode ? { type: 'system', subtype: 'init', session_id: mockSessionId } : { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: buildContent() } },
    ];
    if (hasTools) {
      lines.push({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_mock_bash', content: 'mock-command\\n', is_error: false },
      ] } });
    }
    lines.push({ type: 'result', is_error: false, result: replyText, total_cost_usd: 0.0002, duration_ms: 5, num_turns: 1, stop_reason: 'end_turn' });
    for (const l of lines) writeLine(l);
  }
  if (delay > 0) setTimeout(emit, delay); else emit();
}
`.trim();

// fix-exec-modes: real, verified `claude --help` / `claude -p --help` output (identical flag set
// in both modes — no "(only works with --print)" annotation restricts `--permission-mode` or
// `--effort` to interactive-only use) is the ONLY source of truth for this mapping:
//   --permission-mode <mode>   choices: "acceptEdits", "auto", "bypassPermissions", "manual",
//                              "dontAsk", "plan"
//   --dangerously-skip-permissions   Bypass all permission checks. Recommended only for sandboxes
//                              with no internet access.
//   --effort <level>          Effort level for the current session (low, medium, high, xhigh, max)
// Every one of this route's own 'execute' | 'plan' | 'accept-edits' | 'bypass' mode values maps to
// a REAL, help-confirmed --permission-mode choice — 'bypass' uses --permission-mode
// bypassPermissions (the same single flag/mechanism as plan/acceptEdits) rather than the separate
// --dangerously-skip-permissions flag, so one mechanism covers every mode with no extra argv shape
// to test or reason about.
//
// SECURITY FRAME (owner-requested 2026-07-29, transcript in this run's events — a non-interactive
// dashboard chat session cannot ever receive an interactive permission grant, so every write path
// was previously denied by design): 'bypass' is scoped to THIS loopback, single-user gateway tool
// only. It does not widen anything else — the spawned child's cwd is still forced to the target
// conversation's registered project path (never user-supplied), and filteredEnv() above still
// allowlists the child's own environment regardless of which permission mode is requested.
const MODE_TO_PERMISSION_FLAG = {
  plan: 'plan',
  'accept-edits': 'acceptEdits',
  bypass: 'bypassPermissions',
};

// cc-fix-chat-identity / fix-exec-modes: kept as its own tiny pure function so a unit test can
// assert the EXACT argv shape without spawning a real child (mirrors filteredEnv()'s own "assert
// the shape directly" rationale above) — mock mode never touches this, it stays exactly as it was.
// Neither `mode` nor `effort` nor `model` is re-validated here — all three are already checked
// against a strict allowlist at the HTTP route (server.mjs) before ever reaching this function.
// feat-model-picker: `model` mirrors `effort`'s own "push exactly one flag+value pair, only when
// truthy" shape — real, help-confirmed `claude --model <model>` (see server.mjs's EXEC_MODEL_VALUES
// comment for the exact help text and the "[1m]" context-window suffix that was investigated and
// deliberately left out for lack of INPUT-side evidence).
// WP A4 (shared session module): `session` (`{ resumeSessionId, fork }`, optional) appends the
// session flags AFTER every pre-existing flag, so no existing argv position shifts: `--resume <id>`
// when the conversation has a stored Claude session, plus `--fork-session` when a fork is requested.
// sessions/argv-session.mjs owns the shape check of the id; without a session nothing is added and
// the argv stays byte-identical to the pre-A4 shape.
function buildRealArgs(text, mode, effort, model, session) {
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose'];
  const permissionFlag = MODE_TO_PERMISSION_FLAG[mode];
  if (permissionFlag) args.push('--permission-mode', permissionFlag);
  if (effort) args.push('--effort', effort);
  if (model) args.push('--model', model);
  args.push(...sessionArgv(session || {}));
  return args;
}

export function _buildRealArgsForTests(text, mode, effort, model, session) {
  return buildRealArgs(text, mode, effort, model, session);
}

// feat-subagent-visibility: two REAL, help-confirmed optional flags (verified on this machine
// against claude CLI v2.1.220 — `claude --help` prints both verbatim):
//   --forward-subagent-text   Forward subagent text and thinking blocks as assistant/user messages
//                             with parent_tool_use_id set (only works with --print and
//                             --output-format=stream-json)
//   --include-hook-events     Include all hook lifecycle events in the output stream (only works
//                             with --output-format=stream-json)
// buildRealArgs() above already passes `-p` + `--output-format stream-json`, so both documented
// preconditions genuinely hold for every real spawn this gateway makes.
//
// MEASURED HONESTY NOTE (four real captures, see test/fixtures/subagent-stream-*.jsonl and
// test/subagent-visibility.test.mjs): on v2.1.220 `--forward-subagent-text` produced NO observable
// difference for a general-purpose `Agent` dispatch — all four runs carried the same 5
// parent_tool_use_id-bearing lines, so subagent text/thinking is already forwarded by default
// there. It is passed anyway because it is the documented CONTRACT for that behaviour (a future
// version could stop defaulting it on), not because it was observed to unlock anything.
// `--include-hook-events` IS the real delta: hook lines went from 4+4 (SessionStart only) to 19+19
// across six lifecycle events. Hook events only ever appear for hooks that genuinely exist and
// match on the machine — on a machine with no configured hooks this flag yields nothing.
//
// OLDER CLIs MUST NOT BREAK: an unknown flag makes the CLI exit with a usage error instead of
// running the turn, so support is detected against the resolved binary's own `--help`
// (exec-cli.mjs's cached claudeCliSupportsFlag) and unknown help degrades to adding nothing.
const STREAM_VISIBILITY_FLAGS = ['--forward-subagent-text', '--include-hook-events'];

/**
 * The stream-visibility flags this gateway should actually spawn with, per the
 * `CC_EXEC_STREAM_VISIBILITY` switch (this file's own CC_* env convention, already used by
 * CC_EXEC_MOCK/CC_EXEC_TIMEOUT_MS):
 *   - `auto` (DEFAULT, and the value any unrecognised setting falls back to): only the flags the
 *     resolved CLI's own `--help` genuinely documents. Safe on every CLI version.
 *   - `off`: never add either flag, even on a CLI that fully supports them.
 *   - `on`: add both regardless of detection — an explicit operator override for the case where
 *     `--help` cannot be read but the flags are known to work.
 * Returns a fresh array every call (never a shared mutable constant).
 */
export function resolveStreamVisibilityFlags() {
  const setting = String(process.env.CC_EXEC_STREAM_VISIBILITY || '').trim().toLowerCase();
  if (setting === 'off') return [];
  if (setting === 'on') return [...STREAM_VISIBILITY_FLAGS];
  return STREAM_VISIBILITY_FLAGS.filter((flag) => claudeCliSupportsFlag(flag));
}

// fix-sec-round #4 (LOW): buildRealArgs() above pushes `-p` (a real, help-confirmed BOOLEAN flag —
// `claude --help`/`claude -p --help` both print "-p, --print  Print response and exit", taking no
// value of its own) immediately followed by `text`, which is only safe because Commander-style CLI
// argument parsing then treats `text` as the separate positional `[prompt]` argument the usage line
// documents (`claude [options] [command] [prompt]`). A `text` value whose first character is '-'
// risks being parsed as ANOTHER option instead of the positional prompt.
//
// The two candidate fixes this finding named were (a) a literal `--` end-of-options separator
// before `text`, or (b) rejecting such input outright. Neither `claude --help` nor `claude -p
// --help` documents `--` end-of-options handling explicitly, and proving it empirically would
// require a REAL (non-mock) `claude` invocation — which this fix round must not perform (a live E2E
// run is in progress against this same gateway process during this round, and spawning a second
// real `claude` session from inside this build task risks cost/hangs/process interference that this
// round is explicitly forbidden from causing). The safe, conservative choice is therefore (b):
// reject the input outright rather than gamble on unverified CLI parsing behaviour for a real
// code-executing write path. See server.mjs's own route-level comment for where this returns an
// honest 400, and this file's own exec-bridge.test.mjs for the proof this function actually flags
// the risky shape.
//
// WP A4 note: this rejection deliberately STAYS for now. It can only go once the prompt
// is sent over stdin instead of as a positional argument (planned in B2/B3), which removes the
// parsing risk at its root; until then a prompt such as "- maak een lijst" still gets the honest 400.
export function isUnsafeExecPromptText(text) {
  return typeof text === 'string' && text.trim().startsWith('-');
}

// feat-ask-owner: every REAL (non-mock) execution gets the forge-ask
// MCP tool wired in via its OWN per-execution --mcp-config file — a fresh, single-use JSON file
// under command-center/.data/ask-mcp-configs/ (the project's existing gateway-owned .data/ write
// boundary — never .claude/), never a shared/global one, so each spawned session only ever learns
// the ONE conversation/turn/request id it actually belongs to.
//
// WP B1a: the ask callback origin is this gateway's REAL listening origin
// (runtime-state.mjs gatewayOrigin(): 4100 by default, an env-pinned port, or the free loopback port
// bin.mjs fell back to), read per execution so a fallback port is never missed.

const ASK_MCP_SCRIPT_PATH = fileURLToPath(new URL('./ask-mcp.mjs', import.meta.url));

// Test-only override seam (mirrors conversation-store.mjs's own `_setConversationsDirForTests`
// convention exactly): the real config directory lives under this gateway's own `.data/`, but a
// test must never write real files into that real directory.
let askMcpConfigDirOverride = null;
function activeAskMcpConfigDir() {
  return askMcpConfigDirOverride || path.join(COMMAND_CENTER_DATA_DIR, 'ask-mcp-configs');
}
export function _setAskMcpConfigDirForTests(dir) {
  askMcpConfigDirOverride = dir;
}

/** Pure — builds the mcpServers JSON object for one execution's ask-mcp config, with NO file I/O
 *  (exported so a unit test can assert its exact shape without touching the filesystem at all).
 *  WP B1a rework (A8 follow-up): no token is in this object. Since WP B3-sec-impl the
 *  forge-ask server authenticates with its conversation's AGENT token (CC_ASK_AGENT_TOKEN, never the
 *  dashboard's exec token), which reaches ask-mcp.mjs through the spawned child's environment
 *  (exec-cli.mjs execSpawnEnv), so the per-turn config file on disk never holds it;
 *  exec-lifecycle.mjs still strips every token variable defensively. */
export function _buildAskMcpConfigObjectForTests({ convId, turnId, requestId }) {
  return {
    mcpServers: {
      'forge-ask': {
        command: process.execPath,
        args: [ASK_MCP_SCRIPT_PATH],
        env: {
          CC_ASK_GATEWAY_ORIGIN: gatewayOrigin(),
          CC_ASK_CONV_ID: convId || '',
          CC_ASK_TURN_ID: turnId || '',
          CC_ASK_REQUEST_ID: requestId || '',
        },
      },
    },
  };
}

/** Writes a fresh, single-use mcp-config file for this one execution and returns its real absolute
 *  path. A real side effect (the ONLY reason this is not folded into the pure builder above) —
 *  exec-lifecycle.mjs best-effort-deletes this file again once the execution closes/errors/times
 *  out, so these files do not accumulate across a long-running gateway process. */
function writeAskMcpConfig(askContext) {
  const dir = activeAskMcpConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const fileName = 'ask-' + (askContext.turnId || Date.now().toString(36)) + '-' + crypto.randomBytes(3).toString('hex') + '.json';
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(_buildAskMcpConfigObjectForTests(askContext)), 'utf8');
  return filePath;
}

// `askContext` (`{ convId, turnId, requestId }`, optional — mock mode never uses it at all):
// appends `--mcp-config <file> --strict-mcp-config` when present. 2026-07-30 CORRECTION
// (coordinator-measured, two real non-mock runs, see this file's own forge-report + ask-mcp.mjs's
// header for the full evidence): this NEVER also adds --allowed-tools/--disallowedTools. A real
// test proved --allowed-tools silently starves every OTHER built-in tool (Write/Edit/Bash) while
// the model still claims success — exactly the dishonest, crippled-agent outcome this feature must
// never cause. --strict-mcp-config alone only restricts WHICH MCP SERVERS load (just this one),
// never which built-in tools the session may use — do not "helpfully" add an allowlist flag here
// later without re-reading this comment and re-verifying against a real run first.
// WP A4: `session` (`{ resumeSessionId, fork }`, optional) — see buildRealArgs above. In mock mode
// the same session argv is passed to the mock script after the prompt, so a test can prove a second
// turn really asks for `--resume <id>` (the mock echoes it back, see '__MOCK_SESSION__' above).
export function buildSpawnSpec(text, mode, effort, model, askContext, session) {
  if (process.env.CC_EXEC_MOCK === '1') {
    return { cmd: process.execPath, args: ['-e', MOCK_SCRIPT, text, ...sessionArgv(session || {})] };
  }
  // feat-forge-preamble: every REAL (non-mock) execution carries the Forge Lead preamble via
  // --append-system-prompt — see forge-preamble.mjs's own header for the owner findings this
  // answers. Appended right after the base mode/effort/model flags (buildRealArgs itself, and
  // therefore _buildRealArgsForTests, stay byte-identical — this is layered on top here, not inside
  // that function, so it never disturbs that function's own exact-argv tests), and BEFORE any
  // --mcp-config flags below, so it is present whether or not this turn also carries an askContext.
  const baseArgs = [...buildRealArgs(text, mode, effort, model, session), '--append-system-prompt', FORGE_LEAD_PREAMBLE];
  // feat-subagent-visibility: appended at the very END, after every pre-existing flag — the two
  // visibility flags are order-independent booleans, and keeping them last means no existing
  // argv POSITION shifts (test/exec-ask-mcp-config.test.mjs asserts the exact base argv in front
  // of --mcp-config, and that assertion must keep holding byte-for-byte).
  const visibilityFlags = resolveStreamVisibilityFlags();
  if (!askContext || !askContext.convId) {
    return { cmd: resolveClaudeCliPath(), args: [...baseArgs, ...visibilityFlags] };
  }
  const askMcpConfigPath = writeAskMcpConfig(askContext);
  return {
    cmd: resolveClaudeCliPath(),
    args: [...baseArgs, '--mcp-config', askMcpConfigPath, '--strict-mcp-config', ...resolvePermissionPromptArgs(mode), ...visibilityFlags],
    askMcpConfigPath,
  };
}

// App router P2 (design 6.1, Test route): the fixed argv of one user-clicked probe turn on a Claude
// account: the cheapest real turn (`-p .` on haiku, one model turn), no session file left behind,
// and no MCP server at all (an empty strict MCP config, passed as a JSON string, never a file).
// Nothing in it comes from request input. Mock mode runs the same fixed mock script as a chat turn.
export const PROBE_ARGS = Object.freeze([
  '-p', '.', '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json', '--verbose',
  '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
]);

/** `{ cmd, args }` for a probe turn; cmd is null when the claude CLI cannot be resolved. */
export function buildProbeSpawnSpec() {
  if (process.env.CC_EXEC_MOCK === '1') return { cmd: process.execPath, args: ['-e', MOCK_SCRIPT, '.'] };
  return { cmd: resolveClaudeCliPath(), args: [...PROBE_ARGS] };
}

// WP B3 (plan 4.4): in -p mode a tool call that needs permission is DENIED unless a permission
// prompt tool is named. The forge-ask MCP server (ask-mcp.mjs, already wired per turn above)
// exposes that tool as `permission_prompt`, so Claude Code addresses it as
// mcp__forge-ask__permission_prompt. It is only added together with the ask-mcp config (the tool
// cannot exist without it), never in plan mode (plan mode runs nothing that needs a grant), and only
// when the resolved CLI documents the flag. `CC_EXEC_PERMISSION_PROMPT` mirrors
// CC_EXEC_STREAM_VISIBILITY: 'auto' (default, help-detected) | 'on' | 'off'.
// Measured 2026-11-02 on CLI 2.1.316: `claude --help` names --permission-prompt-tool only inside
// another flag's description; claudeCliSupportsFlag still finds it there (substring match).
export const PERMISSION_PROMPT_TOOL_NAME = 'permission_prompt';
export const PERMISSION_PROMPT_TOOL_REF = 'mcp__forge-ask__' + PERMISSION_PROMPT_TOOL_NAME;
const PERMISSION_PROMPT_FLAG = '--permission-prompt-tool';

/** The `--permission-prompt-tool <ref>` pair for this turn, or [] (fresh array every call). */
export function resolvePermissionPromptArgs(mode) {
  if (mode === 'plan') return [];
  const setting = String(process.env.CC_EXEC_PERMISSION_PROMPT || '').trim().toLowerCase();
  if (setting === 'off') return [];
  if (setting !== 'on' && !claudeCliSupportsFlag(PERMISSION_PROMPT_FLAG)) return [];
  return [PERMISSION_PROMPT_FLAG, PERMISSION_PROMPT_TOOL_REF];
}
