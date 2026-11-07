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

import crypto from 'node:crypto';
import { appendConversationEvent } from '../conversations.mjs';
import { redactDeep } from '../redact.mjs';
import { scrubGatewayTokens } from '../security.mjs';
import { classifyPermission, sessionRuleKey } from './rules.mjs';

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

let runHooks = { pause: () => false, resume: () => {} };
let pauseAfterOverride = null;

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
  const parents = mapFor(toolParents, convId);
  for (const block of content) {
    if (!block || block.type !== 'tool_use' || typeof block.id !== 'string') continue;
    if (parents.size < MAX_TRACKED_TOOL_USES) parents.set(block.id, parent);
    const isDispatch = (block.name === 'Agent' || block.name === 'Task') && block.input && typeof block.input.subagent_type === 'string';
    if (isDispatch) {
      const agents = mapFor(dispatchAgents, convId);
      if (agents.size < MAX_TRACKED_TOOL_USES) agents.set(block.id, block.input.subagent_type);
    }
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

  const folder = typeof cwd === 'string' && cwd.length > 0 ? cwd : runFolders.get(convId) || null;
  const rule = classifyPermission(toolName, safeInput, { cwd: folder });
  const kind = sessionRuleKey(toolName, safeInput, { cwd: folder });
  const id = 'perm-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const record = {
    id,
    conv_id: convId,
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
  const answered = { id, behavior: applied, tool_name: record.tool_name, rule_kind: record.kind, remembered, answered_at: record.answered_at };
  if (applied !== behavior) answered.requested_behavior = behavior;
  logEvent(record, 'permission_answered', scrubGatewayTokens(answered));
  settle(record, decisionFor(applied === 'deny' ? 'deny' : 'allow', record.input));
  pending.delete(id);
  if (openCountFor(record.conv_id) === 0) onLastClosed(record.conv_id);
  return { ok: true, status: 200, convId: record.conv_id, behavior: applied, remembered };
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
  return closed;
}

function toPublic(record) {
  return {
    id: record.id,
    conversation_id: record.conv_id,
    turn_id: record.turn_id,
    tool_name: record.tool_name,
    input: record.input,
    tool_use_id: record.tool_use_id,
    agent: agentForToolUse(record.conv_id, record.tool_use_id),
    categories: record.categories,
    summary_nl: record.summary_nl,
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

/** Test-only: forget everything and restore defaults. */
export function _resetPermissionStoreForTests() {
  for (const r of pending.values()) if (r.pauseTimer) clearTimeout(r.pauseTimer);
  pending.clear();
  sessionAllow.clear();
  toolParents.clear();
  dispatchAgents.clear();
  pausedByPermission.clear();
  runFolders.clear();
  decided.clear();
  pauseAfterOverride = null;
}

export function _setPauseAfterMsForTests(ms) {
  pauseAfterOverride = ms;
}
