<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# Forge hooks (17 registrations)

Generated from: `.claude/settings.json`.

Read only: this list mirrors the settings file. Writing the Claude Code settings files is an owner hard gate.

| event | matcher | script | purpose (from its header) |
|---|---|---|---|
| PreCompact | manual | `forge-snapshot-marker.cjs` | PreCompact hook target (matchers `manual` AND `auto`, owner request 2026-07-29: a real snapshot must exist by the time context actually compacts, not just when someone remembers to ask). |
| PreCompact | auto | `forge-snapshot-marker.cjs` | PreCompact hook target (matchers `manual` AND `auto`, owner request 2026-07-29: a real snapshot must exist by the time context actually compacts, not just when someone remembers to ask). |
| SessionStart | compact | `forge-snapshot-reinject.cjs` | SessionStart hook target, matcher `compact` (owner request 2026-07-29: after a compaction, the very next turn must not have lost the mission). |
| SessionStart | startup\|resume\|clear | `forge-resume-brief.cjs` | `SessionStart` hook for startup \| resume \| clear (.7, owner request R-0069). |
| PostToolUse | Write\|Edit\|MultiEdit\|NotebookEdit\|Bash | `forge-toolhook.cjs` | the tool-behaviour LEDGER: one compact line per real tool call, written by a `PostToolUse` hook, i.e. |
| PostToolUse | PowerShell | `forge-toolhook.cjs` | the tool-behaviour LEDGER: one compact line per real tool call, written by a `PostToolUse` hook, i.e. |
| PostToolUse | Agent | `forge-agent-tool-hook.cjs` | `PreToolUse` + `PostToolUse` hook, matcher "Agent" (WP A2). |
| PreToolUse | Bash\|PowerShell | `forge-gate-hook.cjs` | PreToolUse hook (matcher `Bash\|PowerShell`): the SEVEN command hard gates become a real stop (WP16,; opaque-exec added in the codex-recheck-2026-09-24 remediation, wp-f1; secret-… |
| PreToolUse | Agent | `forge-agent-tool-hook.cjs` | `PreToolUse` + `PostToolUse` hook, matcher "Agent" (WP A2). |
| Stop | (all) | `forge-stop-obligations.cjs` | (audit enforcement-core T3/T8/T10 + P1 "call sites"). |
| Stop | (all) | `forge-scribe-stop.cjs` | the scribe's project Stop hook (part ii, Codex R3 SC-07/SC-12 the same day). |
| UserPromptSubmit | (all) | `forge-scribe-hook.cjs` | the project UserPromptSubmit hook that feeds Forge Scribe (part ii, 2026-10-10; design: audit SCRIBE-F1/F5/F10 in .claude/forge-research/overhaul-2026-10-09/audit-scribe… |
| SubagentStop | (all) | `forge-subagent-stop.cjs` | `SubagentStop` hook (modernization plan item 1.6). |
| SessionEnd | (all) | `forge-session-end.cjs` | `SessionEnd` hook, registered async (modernization plan item 1.6). |
| PostToolUseFailure | (all) | `forge-tool-failure.cjs` | `PostToolUseFailure` hook (modernization plan item 1.6). |
| StopFailure | rate_limit\|overloaded | `forge-rotator-hook.cjs` | `StopFailure` hook for the account rotator, PATH A (work packages R.2+R.3). |
| SubagentStart | (all) | `forge-subagent-start.cjs` | `SubagentStart` hook (WP A2). |
