/**
 * Permission request shapes (WP B3, plan §4.4).
 *
 * The contract with the gateway side lives in `_scratch/b3/contract-permissions.md` (B3-cards and
 * B3-gw): the gateway sends the tool call as Claude Code asked it, unmodified; the card derives its
 * own plain-Dutch first line from a fixed rule table (`permission-rules.ts`), never from the model.
 */

/** One tool call that waits for the user's answer. */
export interface PendingPermission {
  readonly id: string;
  /** Exactly as Claude Code sends it: "Bash", "Write", "Edit", "WebFetch", "mcp__server__tool", ... */
  readonly tool_name: string;
  /** The tool input as received (command, file_path, url, ...). */
  readonly input: Readonly<Record<string, unknown>>;
  /** The helper that asked, as the logs name it ("Build Boss"); null/absent = the main assistant. */
  readonly agent?: string | null;
  /** ISO 8601. */
  readonly created_at: string;
  /**
   * Optional, from the gateway's own rule table (`network|delete|outside_folder|exec|edit`). The card
   * adds the matching badges to its own, so it never warns less than the gateway; absent = none.
   */
  readonly categories?: readonly string[];
  /**
   * Optional, from the gateway (contract addition 2026-11-02): whether an allow_session answer would be remembered.
   * Bash/PowerShell requests are never remembered (empty allow-list), so the card offers no "Altijd toestaan" then.
   * Absent = unknown, treated as rememberable for backwards compatibility with older gateways.
   */
  readonly rememberable?: boolean;
}

/** allow = this call only · allow_session = this kind of call for the rest of the conversation · deny = refuse. */
export type PermissionBehavior = 'allow' | 'allow_session' | 'deny';

export const PERMISSION_BEHAVIORS: readonly PermissionBehavior[] = ['allow', 'allow_session', 'deny'];

/** The parent wires this to the gateway. A rejected promise shows "Je antwoord kwam niet aan". */
export type AnswerPermission = (id: string, behavior: PermissionBehavior) => Promise<void> | void;
