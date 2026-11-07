import path from 'node:path';
import { SessionStore as SharedSessionStore } from '../../gateway/src/sessions/session-store.mjs';

// conversationId → Claude session-ID (plan §1: thread-ID → Claude session-ID).
// Hierdoor heeft elk kanaal/thread een doorlopend gesprek met geheugen.
//
// WP A4: thin adapter over the shared session module in
// gateway/src/sessions/session-store.mjs, so the gateway chat and this bot keep sessions in one
// format. The bot's interface is unchanged: get() still returns the bare session id (or null),
// set(conversationId, sessionId) and clear(conversationId) behave as before, and the file stays
// <stateDir>/sessions.json. An existing file with bare session-id strings is read as-is; the next
// write stores full records ({ sessionId, createdAt, lastUsedAt, ... }).
export class SessionStore {
  constructor(stateDir) {
    this.shared = new SharedSessionStore(path.join(stateDir, 'sessions.json'));
  }

  get(conversationId) {
    return this.shared.getSessionId(conversationId);
  }

  set(conversationId, sessionId) {
    if (!conversationId || !sessionId) return;
    this.shared.set(conversationId, { sessionId });
  }

  clear(conversationId) {
    this.shared.clear(conversationId);
  }
}
