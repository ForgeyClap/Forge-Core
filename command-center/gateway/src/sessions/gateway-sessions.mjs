// Forge Command Center gateway — the gateway's own instance of the shared session store (WP A4).
//
// The store file lives beside the conversation files (`<conversations dir>/_claude-sessions.json`,
// inside the gateway's `.data/`), so it follows `_setConversationsDirForTests` automatically: a test
// that points conversations at a temp dir can never write into the real store. The conversation
// listing reads only `*.jsonl`, so this `.json` file is never mistaken for a conversation.
//
// Every helper here is best-effort towards the chat path: a session-store failure (unreadable or
// corrupt file, full disk) must never stop a turn from running. Readers fall back to "no session"
// (a fresh session, the pre-A4 behaviour); the run tracker reports write failures through its
// `onError` callback so the caller can record them as a visible conversation event.
import fs from 'node:fs';
import path from 'node:path';
import { activeConversationsDir } from '../conversation-store.mjs';
import { extractInitSessionId } from '../exec-stream-parse.mjs';
import { SessionStore, isValidConversationKey } from './session-store.mjs';
import { sessionOptionsForConversation } from './argv-session.mjs';

export const GATEWAY_SESSIONS_FILE_NAME = '_claude-sessions.json';

let sessionsFileOverride = null;
export function _setGatewaySessionsFileForTests(filePath) { sessionsFileOverride = filePath || null; }

export function gatewaySessionsFile() {
  return sessionsFileOverride || path.join(activeConversationsDir(), GATEWAY_SESSIONS_FILE_NAME);
}

export function gatewaySessionStore() {
  return new SessionStore(gatewaySessionsFile());
}

/** The stored session record for a conversation, or null (also when the store cannot be read). */
export function readConversationSession(convId) {
  try {
    return gatewaySessionStore().get(convId);
  } catch {
    return null;
  }
}

// ---- App router P2 (design 4.6, review finding 15): which account a stored session belongs to ----
//
// A Claude session lives in the config folder it ran in, so another account can never `--resume` it.
// The shared SessionStore (session-store.mjs, also used by the Discord bot) keeps a fixed record shape,
// so the binding "this session id ran under target X" lives in its own small file beside it:
// `<conversations dir>/_claude-session-targets.json` = { version: 1, targets: { <convId>: { target_id,
// session_id } } }. A binding counts only while its session_id is still the conversation's stored
// session; a conversation without a (matching) binding counts as the main account, so every session
// stored before the router existed, or while it is off, stays exactly as it was.
export const GATEWAY_SESSION_TARGETS_FILE_NAME = '_claude-session-targets.json';
export const MAIN_TARGET_ID = 'main';
const TARGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TARGET_BINDINGS = 5000;

export function gatewaySessionTargetsFile() {
  return path.join(path.dirname(gatewaySessionsFile()), GATEWAY_SESSION_TARGETS_FILE_NAME);
}

/** Every stored binding; {} when the file is missing or unreadable (then every session counts as main). */
function readTargetBindings() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(gatewaySessionTargetsFile(), 'utf8'));
  } catch {
    return {}; // missing or damaged: no binding is the safe reading (a session then counts as main)
  }
  const targets = parsed && typeof parsed === 'object' && parsed.targets && typeof parsed.targets === 'object' ? parsed.targets : {};
  const out = {};
  for (const [convId, b] of Object.entries(targets)) {
    if (!isValidConversationKey(convId) || !b || typeof b !== 'object') continue;
    if (typeof b.target_id !== 'string' || !TARGET_ID_RE.test(b.target_id) || typeof b.session_id !== 'string') continue;
    out[convId] = { target_id: b.target_id, session_id: b.session_id };
  }
  return out;
}

/** Atomic write of the binding map (temp file + rename). Throws on a write failure. */
function writeTargetBindings(map) {
  const keys = Object.keys(map);
  const kept = {};
  for (const k of keys.slice(Math.max(0, keys.length - MAX_TARGET_BINDINGS))) kept[k] = map[k];
  const file = gatewaySessionTargetsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, targets: kept }, null, 2));
  fs.renameSync(tmp, file);
}

/** Records that `sessionId` (the conversation's stored session) ran under `targetId`. Throws on a write failure. */
export function bindSessionTarget(convId, sessionId, targetId) {
  if (!isValidConversationKey(convId) || typeof sessionId !== 'string' || typeof targetId !== 'string' || !TARGET_ID_RE.test(targetId)) return false;
  const map = readTargetBindings();
  const prev = map[convId];
  if (prev && prev.target_id === targetId && prev.session_id === sessionId) return true;
  delete map[convId]; // re-insert so the newest binding is kept when the cap trims the oldest
  map[convId] = { target_id: targetId, session_id: sessionId };
  writeTargetBindings(map);
  return true;
}

/** The target the conversation's stored session belongs to: its binding when that still matches the
 *  stored session id, otherwise 'main'. `record` (optional) is the already-read session record. */
export function sessionTargetFor(convId, record = undefined) {
  const rec = record === undefined ? readConversationSession(convId) : record;
  if (!rec) return MAIN_TARGET_ID;
  const binding = readTargetBindings()[convId];
  return binding && binding.session_id === rec.sessionId ? binding.target_id : MAIN_TARGET_ID;
}

function dropTargetBinding(convId) {
  const map = readTargetBindings();
  if (!(convId in map)) return;
  delete map[convId];
  writeTargetBindings(map);
}

/** `{ resumeSessionId, fork }` for a conversation's next turn (see sessionOptionsForConversation).
 *  App router: `targetId` (default 'main') is the account the turn will run under. A stored session
 *  that belongs to another account is not resumed: the turn starts a fresh session instead (the
 *  router then hands the recent messages over). Router off = 'main', which matches every session
 *  that has no binding, so nothing changes for a conversation the router never touched. */
export function resumeOptionsFor(convId, { cwd = null, fork = false, targetId = MAIN_TARGET_ID } = {}) {
  const record = readConversationSession(convId);
  if (record && sessionTargetFor(convId, record) !== targetId) return { resumeSessionId: null, fork: false };
  return sessionOptionsForConversation(record, { cwd, fork });
}

/** Removes a conversation's session (and its account binding). Best-effort: returns false when the
 *  store cannot be written. A binding that cannot be removed is harmless: it no longer matches. */
export function clearConversationSession(convId) {
  let cleared;
  try {
    cleared = gatewaySessionStore().clear(convId);
  } catch {
    return false;
  }
  try {
    dropTargetBinding(convId);
  } catch {
    /* best-effort: a stale binding never matches a later session id, so it changes nothing */
  }
  return cleared;
}

/** Marks `targetConvId` to continue from `sourceConvId`'s Claude session under a new id on its first
 *  turn (`--resume <id> --fork-session`). Returns the stored record, or null when the source has no
 *  session (nothing to fork from; the new conversation then simply starts fresh). Throws on a store
 *  write failure so the caller can report it. */
export function markConversationForkedFrom(targetConvId, sourceConvId, { title = null } = {}) {
  const store = gatewaySessionStore();
  const source = store.get(sourceConvId);
  if (!source) return null;
  const stored = store.set(targetConvId, {
    sessionId: source.sessionId,
    model: source.model,
    cwd: source.cwd,
    title: title ?? source.title,
    pendingFork: true,
  });
  // App router (review finding 15): the fork continues the SAME session, so it belongs to the same
  // account. Without this the fork would count as 'main' and try to resume a profile's session there.
  const sourceTarget = sessionTargetFor(sourceConvId, source);
  if (stored && sourceTarget !== MAIN_TARGET_ID) bindSessionTarget(targetConvId, stored.sessionId, sourceTarget);
  return stored;
}

/** One tracker per execution. `observe(parsed)` stores the session id from the run's first main
 *  `system`/`init` line; `finish({ exitCode })` clears a resumed session that failed before the CLI
 *  ever started it (an expired or deleted session), so the next turn starts fresh instead of failing
 *  the same way forever. Returns 'stored' | 'cleared' | 'unchanged' from finish(). Unlike the
 *  Discord runner, the gateway does not retry the failed turn itself; the owner sends it again. */
// App router: `targetId` (optional; set only on routed turns) binds the stored session to the account
// the turn ran under. Without it (router off) the tracker behaves exactly as before.
export function createRunSessionTracker({ convId, cwd = null, model = null, title = null, resumeSessionId = null, onError = null, targetId = null }) {
  let storedSessionId = null;
  function report(action, err) {
    if (typeof onError === 'function') onError({ action, message: err && err.message ? err.message : String(err) });
  }
  return {
    observe(parsed) {
      if (storedSessionId !== null) return;
      const sessionId = extractInitSessionId(parsed);
      if (sessionId === null) return;
      storedSessionId = sessionId;
      try {
        gatewaySessionStore().set(convId, { sessionId, model, cwd, title, pendingFork: false });
      } catch (err) {
        report('store', err);
        return;
      }
      if (typeof targetId !== 'string') return;
      try {
        bindSessionTarget(convId, sessionId, targetId);
      } catch (err) {
        report('bind', err);
      }
    },
    finish({ exitCode = null } = {}) {
      if (storedSessionId !== null) return 'stored';
      // Only a real non-zero exit counts: a stopped/killed child (exitCode null) keeps its session.
      if (!resumeSessionId || typeof exitCode !== 'number' || exitCode === 0) return 'unchanged';
      try {
        const store = gatewaySessionStore();
        if (store.getSessionId(convId) !== resumeSessionId) return 'unchanged';
        store.clear(convId);
        return 'cleared';
      } catch (err) {
        report('clear', err);
        return 'unchanged';
      }
    },
    storedSessionId() { return storedSessionId; },
  };
}
