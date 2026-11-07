# Forge hooks in `.claude/settings.json` — what each one does and how to switch it off

`.claude/settings.json` holds only machine-read keys (`hooks`, `permissions`). Until 2026-10-24 (modernization
plan item 1.6) each hook entry also carried a prose key (`_doc` or `_matcher_doc`). Claude Code does not document
those keys, so they moved here **verbatim** (section 1). Nothing about any hook changed: same events, matchers,
commands and timeouts. The wider opt-in catalogue (hooks Forge ships but does NOT install) stays in
`.claude/config/orchestration/HOOKS_OPT_IN.md`.

**Setting a project up (WP 3.1):** `/forge init` (terminal: `node .claude/forge-bin/forge-init.cjs plan`,
then `apply --yes`) merges these hooks and the `permissions.deny` rules into a project's own `.claude/settings.json`
from `config/orchestration/forge-init.fragment.json` (generated from this tree's settings.json). Deny rules are
appended after the project's own; hooks are added only when every hook script is in that project's
`.claude/forge-bin/` and the Forge plugin is not enabled there (the plugin brings its own hooks). The merge backs
the file up first and restores the original bytes if any existing hook, deny rule or key did not survive.

Timeouts in settings.json are SECONDS (Claude Code hook contract).

## 1. Installed hooks — the removed prose, verbatim

### PostToolUse, matcher `Write|Edit|MultiEdit|NotebookEdit|Bash` -> forge-toolhook.cjs (timeout 10)

Former key `_matcher_doc` on `hooks.PostToolUse[0]`:

> 2026-09-23 (external audit II-D): shipped without a matcher, so it fired on EVERY tool call of every agent (461 in one audited session, ~56 ms each) and logged 320 paths outside the project. The ledger exists to record what CHANGED; reads are noise. Opt out entirely by deleting this entry — nothing else depends on it.

### PostToolUse, matcher `PowerShell` -> forge-toolhook.cjs (timeout 10)

Former key `_matcher_doc` on `hooks.PostToolUse[1]`:

> (fresh-laptop audit N8): the tool ledger missed every Windows shell call because the matcher above has Bash but not PowerShell. A SEPARATE entry (not an edit of the matcher above) so an upgrade merges cleanly and nothing fires twice.

### PreToolUse, matcher `Bash|PowerShell` -> forge-gate-hook.cjs (timeout 10)

Former key `_doc` on `hooks.PreToolUse[0]`:

> 2026-09-24 (WP16 + security wp9b + review wp9a): the GATE HOOK. Before every Bash or PowerShell tool call it asks forge-actiongate.cjs whether the command trips one of SEVEN command hard gates (FIVE until WP 3.3b, a classifier, not a proof) — destructive-delete (rm -rf, rm -r, Remove-Item -Recurse, rd /s, rimraf), kill-by-name (taskkill /IM or a non-PID /FI, Stop-Process -Name, pkill, kill $(pgrep …)) git-destructive (reset --hard, clean -f, checkout -f / . / -- <path>, restore <path>, switch -f, stash drop/clear), opaque-exec (a pipe into a shell, eval/iex, sh -c on a variable, an encoded PowerShell command), or secret-print (printing the CONTENTS of a .env/key/.claude/.credentials.json/secrets/**-shaped file via cat/type/Get-Content/grep/etc. — the shell-command route the permissions.deny block below cannot see), or (WP 3.3b) plugin-install-command (claude plugin install|enable|update, claude plugin marketplace add) and settings-edit-command (a shell write, move or delete of .claude/settings.json, .claude/settings.local.json or ~/.claude/settings.json, or claude config set — reading them, claude plugin list|validate|eval and Forge's own tools stay allowed) — or tries to switch the gate itself off. Exit 2 = blocked with a plain NL+EN reason and Claude must ask the owner; exit 1 = not blocked but VISIBLE (gate is off, or the hook could not check the call and the text it could still read shows no hard-gate keyword; with such a keyword a call it cannot check is blocked, exit 2, gate id cannot-judge-risky); exit 0 = allowed. Quoted data (writer heredocs, echo/commit-message/log-event/search-tool literals) is not treated as a command, and a delete whose every target is provably inside _scratch/, node_modules/, dist/ or the temp dir passes. The owner-approved one-off off-switch is `node .claude/forge-bin/forge-config.cjs set gate-hook off --once "<owner's words>"` (10 minutes); the owner can also run a command himself with `!`. Timeouts in this file are SECONDS (Claude Code hook contract). The permissions.deny block keeps .env variants, keys and secrets out of Claude's Read TOOL; secret-print closes the same gap for a shell COMMAND; .env.example stays readable either way. Details and honest limits: config/orchestration/HOOKS_OPT_IN.md section 6.

Added after the move (package 2.9e, not part of the former `_doc`): **write-scope freeze, OFF by default** (package 3.3c). The same hook can also judge the files a Bash/PowerShell call WRITES (redirects, `tee`, `sed -i`,
`Set-Content`/`Add-Content`/`Out-File`) against one folder. It is on only while `FORGE_WRITE_SCOPE=<absolute existing
folder>` is set in the environment Claude Code starts with (env-only: the config schema has no path type). A target
provably outside that folder gets a visible warning (exit 1) in mode `warn`, the default, or a block in mode `deny`
(`FORGE_WRITE_SCOPE_MODE=deny`, which an agent cannot change during the session, or `/forge config set
write-scope-mode deny`); a target it cannot check is a visible notice, never a block. It does not see
`cp`/`mv`/`Copy-Item`, `New-Item`, inline interpreter code, npm or git writes, or Edit/Write tool calls. Full
description and limits: config/orchestration/HOOKS_OPT_IN.md section 6, "Write-scope freeze".

### Stop (no matcher) -> forge-stop-obligations.cjs + forge-scribe-stop.cjs (timeout 5 each)

Former key `_doc` on `hooks.Stop[0]`:

> ADVISORY Stop hook. When Claude stops while a Forge run is active, it shows the owner that run's outstanding obligations (what `node .claude/forge-bin/forge-runcontract.cjs plan --run <id>` marks overdue or due now) as a short systemMessage. This obligations hook never blocks a stop; it prints nothing while stop_hook_active is set, when no run is active, or when nothing is due, and finishes in well under 1 s (silent failsafe at 900 ms). Opt out: env FORGE_STOP_OBLIGATIONS=off, or delete this entry — nothing else depends on it. The scribe stop hook in this same entry (forge-scribe-stop.cjs) is the one exception: it blocks a stop at most once per captured owner request per session (exit 2, three plain lines naming the open item and the command to plan, ack or defer it) and never twice in a row. Opt out: env FORGE_SCRIBE_STOP=off.

**Added 2026-10-24 (I.7, not part of the verbatim prose above): the run-required check.**
`forge-stop-obligations.cjs` now has one blocking part. When this session (the Stop payload's `session_id`) has at
least 3 finished subagents in `.claude/forge-runs/_hooks/subagent-stop.jsonl` (distinct `agent_id`; the read-only
research types `Explore`, `Plan` and `claude-code-guide` are not counted) and no real run was started or updated
during the session, it blocks the stop ONCE per session (`{"decision":"block","reason":...}`). The reason names
the exact next commands: `log-event.cjs <run_id> run_started`, one `agent_work_package_created` per lane, and
`forge-runcontract.cjs plan --run <run_id>`, plus honest `"retro":true` logging for work already done. A run
counts when it has `run_started` or a `run.json`, and has an event after the session window starts: the
earliest known moment of the session (first subagent stop, or the first line of its own `_toollog` file) minus
one hour. A `FORGE_RUN_ID` that names an existing run folder also counts. Doctor receipt folders do not count. It
never fires in a folder without `.claude/forge-bin` or `.forge`, never while `stop_hook_active` is set, and never
on any error. It never reads the transcript or any prompt or message text. The once-per-session marker is
`_hooks/run-required-stop/<hash>.json`, named by a hash of the session id. Opt out: env
`FORGE_RUN_REQUIRED_STOP=off` (or `FORGE_STOP_OBLIGATIONS=off`, which silences the whole hook).

### UserPromptSubmit (no matcher) -> forge-scribe-hook.cjs (timeout 5)

Former key `_doc` on `hooks.UserPromptSubmit[0]`:

> 2026-10-10 (part ii): the SCRIBE capture hook. Every owner prompt is kept word for word (secrets scrubbed) in .claude/forge-scribe/ as a tracked item R-n, in-process through forge-scribe.cjs capture (no LLM call, no network, fail-open: any error exits 0 silently, it never blocks a prompt). It skips text that is not the owner talking (a background agent's task-notification turn, tool results, slash-command expansions, bare slash commands, Forge tool subcommands) and machine-generated text (counted in a skip counter, not recorded). Plain questions and acks are now captured as items to answer (they are no longer dropped). It adds at most two short lines of context: the receipt naming the R-id, and the open-items digest only when it changed for this session. Fires in claude -p mode too (probed 2026-10-10). Opt out: env FORGE_SCRIBE_HOOK=off, or delete this entry. Details: config/orchestration/HOOKS_OPT_IN.md section 7.

## 2. Hooks added 2026-10-24 (plan item 1.6)

All three are fail-open: they always exit 0, print nothing on stdout, never block, stop themselves well inside
their 5-second timeout, write nothing while a fresh `.claude/.forge-sync.lock` exists, and never create a
`.claude/` folder in a project that has none. Every string they write passes the same scrub gate as the tool
ledger (`forge-toolhook.cjs` serialize(), backed by `forge-store.cjs` SECRET_PATTERNS). No matcher, so each
sees every subagent / session end / failed tool. No `if` filter: `if` is only honoured on tool events, and the
failure hook is meant to see every failed tool.

### SubagentStop -> `forge-subagent-stop.cjs` (timeout 5)

One line per finished subagent in `.claude/forge-runs/_hooks/subagent-stop.jsonl`: `ts`, `event`, `session`,
`agent_id`, `agent_type`, and `run` when `FORGE_RUN_ID` is set. Never `last_assistant_message`, never a
transcript path, never any message content. Harness-written, so it is evidence that the subagent really ran,
not a claim. Not written into a run's `events.jsonl` (that needs a run id and a registered event type).
Opt out: env `FORGE_SUBAGENT_STOP_HOOK=off`, or delete the entry.

### SessionEnd (async) -> `forge-session-end.cjs` (timeout 5)

Runs `forge-memory-consolidate.cjs --json` as a DRY RUN (never `--apply`) and appends one line to
`.claude/forge-runs/_hooks/session-end.jsonl`: `consolidation_due` (true when history / ledger / decisions or a
Boss MEMORY.md is over its limit), `due_files`, `lessons_stale`, `consolidate` (ok / absent / timeout / failed /
bad-output), `reason`, `session`, `ms`. Applying stays a deliberate step:
`node .claude/forge-bin/forge-memory-consolidate.cjs --apply`. Opt out: env `FORGE_SESSION_END_HOOK=off`.

### PostToolUseFailure -> `forge-tool-failure.cjs` (timeout 5)

`PostToolUse` only fires on success, so the tool ledger never saw a failed call. This hook appends one line per
failed tool call to the same `.claude/forge-runs/_toollog/<session>.jsonl`, in the same line shape, with
`ok:false`, `ok_basis:"is_error"`, `failure:true`, `hook`, `error_class` (a fixed label) and `error` (the
harness error text: one line, secrets redacted, capped at 200 characters). forge-loophealth already counts
`ok:false` attempts. Honours the owner setting `tool-log` (off = nothing written). Opt out: env
`FORGE_TOOL_FAILURE_HOOK=off`.

## 3. Hook added 2026-10-24 (account rotator Path A, merged in work package 2.9)

### StopFailure -> forge-rotator-hook.cjs (timeout 5)

**What it does.** `StopFailure` fires instead of `Stop` when a turn ends on an API error. The entry has matcher
`rate_limit|overloaded`, so it runs only when a turn ends on a usage limit or an overloaded API. The hook then
writes ONE marker file, `.claude/forge-runs/_rotator/pending-resume.json`, and replaces the previous marker, so
there is never more than one. The marker holds the time, the session id (`unknown-session` when it does not pass
the secret scrub), which of the two errors it was, the
reset time when the payload gives one (`resume_after`), and the payload's top-level field names. It never holds
message text, error details, a path or a token. Only
`node .claude/forge-bin/forge-rotator-supervisor.cjs run -- <prompt>` reads it. That supervisor is an owner-run
wrapper for ONE headless `claude -p` job: it waits for the reset and resumes that job with `--resume` on the SAME
account. It never switches accounts. Your interactive session does not need this hook, because Claude Code
already continues by itself after a usage limit.

**Off by default.** The entry is installed, but the hook does nothing (no file written) unless the owner setting
`rotator-auto-resume` is on. The default is off, and the setting applies to the whole machine. The hook also
does nothing in a folder without `.claude/`, during a forge-sync maintenance lock, or for any other error value.
It never blocks: Claude Code ignores StopFailure output and exit codes, and the hook always exits 0, prints
nothing on stdout and stops itself after 2 seconds. It is registered synchronously (no `async`) on purpose:
in `claude -p` mode Claude Code kills an async hook that is still running at teardown, and `-p` jobs are exactly
the runs the supervisor reads the marker for.

**Turn it on.** `/forge config set rotator-auto-resume on` (terminal:
`node .claude/forge-bin/forge-config.cjs set rotator-auto-resume on`). Turn it off again with
`/forge config set rotator-auto-resume off`.

**Switch it off or remove it.** Without editing anything: env `FORGE_ROTATOR_HOOK=off`. To remove it, delete
the whole `"StopFailure": [ ... ]` entry from `.claude/settings.json`; nothing else depends on it. An uninstall
(`forge-settings-merge.cjs unmerge`) removes it together with the other Forge hooks, and leaves a StopFailure
hook of your own in place. The source of this entry is `config/orchestration/rotator-hooks.fragment.json`, and
`forge-settings-merge.test.cjs` (section 17) fails when the two drift apart.
