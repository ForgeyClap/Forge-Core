// Forge Command Center — Claude session argv builder (WP A4). Pure: turns a stored session record
// into the extra `claude` argv that resumes it.
//
//   --resume <id>     resume that conversation's Claude session (the CLI then remembers earlier turns)
//   --fork-session    with --resume: continue from that session under a NEW session id, so the
//                     original conversation's session is left untouched
//
// The session id comes from a state file, so it is checked against a strict shape before it ever
// reaches an argv array (same rule the Discord runner applies). A fork without a session to fork
// from adds nothing: `--fork-session` only has meaning together with `--resume`.
import path from 'node:path';

// Never starts with '-', so a stored value can never be read by the CLI as another option.
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export function isResumableSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

/** `{ resumeSessionId, fork }` -> the extra argv (a fresh array every call). */
export function sessionArgv({ resumeSessionId = null, fork = false } = {}) {
  if (!isResumableSessionId(resumeSessionId)) return [];
  return fork === true ? ['--resume', resumeSessionId, '--fork-session'] : ['--resume', resumeSessionId];
}

function samePath(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Decides how a conversation's next turn should run, from its stored session record.
 *  - no record / unusable id -> a fresh session
 *  - the record was made in another working directory -> a fresh session (the CLI keeps sessions
 *    per project folder, so resuming there would fail)
 *  - `fork` requested, or the record is marked `pendingFork` (a forked conversation's first turn)
 *    -> resume with `--fork-session` */
export function sessionOptionsForConversation(record, { cwd = null, fork = false } = {}) {
  const fresh = { resumeSessionId: null, fork: false };
  if (!record || !isResumableSessionId(record.sessionId)) return fresh;
  if (record.cwd && cwd && !samePath(record.cwd, cwd)) return fresh;
  return { resumeSessionId: record.sessionId, fork: fork === true || record.pendingFork === true };
}

/** Convenience: the extra argv for a conversation's stored record. */
export function argvForConversation(record, opts = {}) {
  return sessionArgv(sessionOptionsForConversation(record, opts));
}
