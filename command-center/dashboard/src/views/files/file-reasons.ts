/** The copy key for a `files.mjs` denylist reason code (`rd.files.reason.*`). */

import type { MessageKey } from '@/i18n';

const REASONS = new Set(['env-file', 'key-or-pem-file', 'ssh-private-key', 'git-config', 'node-modules-content', 'secret-pattern-detected']);

/** The key for a reason code, or null for an unknown code (shown as is). */
export function reasonKey(reason: string | null): MessageKey | null {
  if (reason === null) return 'rd.files.reason.policy';
  return REASONS.has(reason) ? (`rd.files.reason.${reason}` as MessageKey) : null;
}
