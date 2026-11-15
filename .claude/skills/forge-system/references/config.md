<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# Forge settings (58)

Generated from: `.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json`.

Read a setting with `node .claude/forge-bin/forge-config.cjs get <key>`; explain one with `explain <key>`. Only the owner changes settings.

| key | type | default | group | what it does |
|---|---|---|---|---|
| `account-rotator` | bool | true | when-needed | Watches your enrolled Claude accounts and keeps you on one that still has room once the active account reaches the threshold (92% by default) on a session, weekly or per-model window. By default (token mode) it measures and recommends: you start a new session with `launch --auto`. Only in the exper… |
| `account-rotator.cooldown-min` | int | 10 | advanced | Minimum time (in minutes) between two automatic account switches, against flip-flopping. On top of that, never more than 6 automatic switches per 24 hours. |
| `account-rotator.interval` | int | 120 | advanced | How often (in seconds) the account rotator measures the active account. |
| `account-rotator.mode` | enum | "token" | advanced | token (default): the rotator measures and recommends; you switch by starting a new session with `launch --auto` — the login files are never written. file (experimental): the rotator swaps the login files of running sessions itself; that cannot be made race-free against Claude Code's own token refre… |
| `account-rotator.threshold` | int | 92 | when-needed | At this percentage of a usage limit (session, weekly or a per-model window) Forge switches to another enrolled account. Keep it below the usage guard's pause point. |
| `agent-memory` | bool | true | core | Agents remember lessons from earlier runs of this project (passwords and keys are always redacted). |
| `anticipate` | bool | true | core | Before building, Forge works out which safe switches, skills and checks this task needs (for example a lane watchdog for several lanes, screenshots for a web page) and uses them without you having to ask; you get one line saying what and why. Anything that costs money or quota, sends something out,… |
| `autonomy` | enum | "continue-within-mission" | core | Keeps working across phases without asking 'continue?' each time. STOP always works; deploy/push/spend/DNS/production always ask first. |
| `brain-path` | string | "" | core | The folder where Forge writes the central brain (one Obsidian knowledge base of all your projects), for example your own Obsidian vault. Empty means the default folder Documents/Forge-Brain. The folder must already exist; Forge does not create it and leaves your own notes alone. |
| `budget-usd` | number | 5 | advanced | Cost ceiling per unattended run (claude -p); your own interactive session is not affected. |
| `cleanup` | enum | "report" | when-needed | Old backups and logs: report only (default) or clean up automatically (deletes files older than 14 days, keeps the last 5). |
| `code-index` | bool | true | when-needed | Keeps an index of your code so agents find the right files faster. |
| `codex-review` | enum | "off" | core | Has an independent second AI (OpenAI Codex) review important code when the codex CLI is installed and logged in on your machine. Off by default: reviews then run through Review Boss and the ECC reviewers. Never a blocker. |
| `council` | enum | "auto" | core | On doubtful or risky choices Forge brings in several advisors (costs extra tokens; only when the signal is real). |
| `dashboard` | bool | true | core | Starts the Forge Command Center (this machine only, 127.0.0.1:4100) so you can watch the agents live. The installer puts it next to Forge's global files; if it is missing anyway, Forge says so once and simply continues. |
| `discord-autostart` | bool | true | when-needed | Starts your Discord bot by itself whenever the Command Center starts, also after a reboot, so you can keep controlling Forge from Discord. Only when you connected Discord and did not switch the bot off yourself; switch it off in the dashboard and it stays off. |
| `docdrift` | bool | true | core | Checks that the documentation Forge relies on still matches the real tools (n8n, Claude Code) before using it. |
| `ecc-full-test` | bool | false | advanced | Extended ECC diagnostics (inventory, permission tests). Heavy and noisy — only for hunting an ECC problem. |
| `explain-mode` | bool | true | core | Forge explains each phase in one plain sentence — what it is doing and why — useful when you are new. |
| `gate-hook` | bool | true | core | A real stop (not advice) on dangerous commands: recursive deletes, killing processes by name, git commands that throw away uncommitted work, commands that hide what they run (eval, a pipe into a shell), printing a secret file's contents (.env, keys), installing a Claude Code plugin or marketplace, … |
| `git-checkpoint` | bool | true | core | Creates a local git safety point (commit or branch, never pushed) before a bigger build so everything can be undone. |
| `intake` | enum | "silent" | core | Answers the intake questions itself from your request and the project; asks at most one multiple-choice question (2-3 options), only when two readings would lead to materially different builds or when something must be sent, paid or deployed. |
| `lanes.full-until` | int | 20 | advanced | Up to and including this usage Forge uses the full number of lanes (lanes.max); above it the count drops ever faster until lanes.stop-at. Must be lower than lanes.stop-at. |
| `lanes.max` | int | 10 | core | The highest number of parallel lanes (agents or workflow parts at once) Forge uses while your usage is still low. As your weekly and 5-hour usage rises, Forge automatically uses fewer and fewer lanes. |
| `lanes.min` | int | 1 | advanced | The lowest number of lanes, even at high usage or low memory or disk space. May not be higher than lanes.max. |
| `lanes.stop-at` | int | 80 | core | From this usage (weekly or 5-hour, whichever is higher) Forge works with the minimum number of lanes, so your limit does not run out too fast. Must be higher than lanes.full-until. |
| `lanes.unknown` | int | 4 | advanced | Number of lanes when Forge does not know your usage (no measurement or an outdated one): a careful middle, until you refresh the usage. |
| `language` | enum | "auto" | core | Language Forge speaks to you in (auto = the language you write in; code and technical docs stay English). |
| `lead-write-guard` | bool | true | core | A real notice (not advice) when the Lead of a /forge build session writes app files itself: with no started run (prefs and memory not loaded) or with no work package. The Lead is told what to do now: start the run, or log a work package and dispatch a Boss. A one- or two-file fix by the Lead itself… |
| `mcp` | bool | true | when-needed | May use external tools (MCP servers) you enabled yourself; never installs or activates one on its own. |
| `model-tiering` | bool | true | core | Runs heavy agents on the strongest model and simple tasks on a cheaper one so your quota lasts longer. |
| `nightshift` | bool | true | when-needed | May resume an interrupted run itself and write a morning briefing; never schedules itself. |
| `nvidia` | bool | true | core | Uses NVIDIA models for bulk work when you put an NVIDIA_API_KEY in .env; without a key nothing happens. |
| `paperclip` | bool | false | when-needed | Local agent runtime (127.0.0.1:3100) with agents that keep working unattended. OFF: it uses your quota while you are not watching, so only when you explicitly ask for it (Forge decision 2026-07-04). |
| `plan-approval` | enum | "gated" | core | Before building, Forge always shows and records a plan card: goal, assumptions, work packages, expected parallel lanes, risks, what it will NOT do, the hard gates that need you and how done is proven. gated (default): only the work packages that hold a hard gate (push, deploy, spending, DNS, produc… |
| `portfolio` | bool | true | when-needed | May reuse lessons from your other Forge projects when you ask (read-only, never passwords). |
| `prompt-doctor` | bool | true | core | Checks your request for the classic traps (vague goal, no definition of done, no context) and fills the gaps itself or asks the one targeted question. |
| `real-file-testing` | bool | true | core | For money, invoices, parsers and data: tests on your real sample files, not on made-up data. |
| `research-first` | bool | true | core | Looks up existing solutions and documentation before building anything new. |
| `rotator-auto-resume` | bool | false | when-needed | Lets an unattended Claude job (claude -p, through the rotator supervisor) carry on by itself after a usage limit on the SAME account: wait for the reset (or a bounded pause when the reset time is unknown), then resume the conversation with --resume. Never switches accounts. Your own interactive ses… |
| `rotator-max-attempts` | int | 8 | advanced | The most times the rotator supervisor starts Claude in one job (the first start plus every resume). |
| `rotator-max-waits` | int | 6 | advanced | The most times the rotator supervisor waits for a limit reset in one job before it gives up. |
| `scribe-autoack` | bool | true | core | The scribe-acker accepts routine requests for you (your decision R-0233): a request that is done with real evidence in a run that is not red, or a proposal to carry something over with a reason. A question, an unclear request, or anything with push, deploy, publishing, money, sign-in, production, d… |
| `skill-proposals` | bool | true | when-needed | Forge may propose a new skill when it sees a real gap; activating it always stays your decision. |
| `snapshots` | bool | true | core | Saves the mission when the conversation is compacted so Forge never forgets what it was doing after a long session. |
| `start-gate` | enum | "off" | core | Does not wait for a START before building — the plan is posted and work continues immediately (say STOP to pause). |
| `team-max` | int-or-auto | "auto" | core | Maximum agents at once (auto = Forge picks the smallest team that fits: small work 1-3, large work up to 12). When the lane budget is lower (forge-lane-budget.cjs, the lanes.* settings), the lane budget wins. |
| `tool-log` | bool | true | core | Records which files agents change (in .claude/forge-runs/_toollog/, not in git). |
| `tournament` | enum | "auto" | when-needed | Builds several variants and picks the best when no approach is clearly right (costs N times as much). |
| `ui-quality` | bool | true | core | Websites and apps are only done with real desktop, tablet and phone screenshots and a real quality check. |
| `usage-guard` | bool | true | core | Pauses Forge automatically when your Claude usage nears the limit. It measures on an interval (2 minutes by default), so this is a pause before the limit, not a guaranteed instant block. |
| `usage-guard.interval` | int | 120 | advanced | How often (in seconds) the guard measures your usage. |
| `usage-guard.nvidia-shift-at` | int | 80 | advanced | From this weekly percentage Forge prefers NVIDIA models for bulk work (a hint only, pauses nothing). |
| `usage-guard.pause-at` | int | 98 | core | Forge pauses at this percentage of your usage limit. |
| `usage-guard.resume-at` | int | 0 | advanced | Forge resumes on its own once usage drops to this percentage (0 = only after your limit resets). |
| `usage-guard.week-pause-at` | int | 0 | core | Forge pauses at this percentage of your WEEKLY limit (0 = the same as the normal pause point). The session limit keeps following usage-guard.pause-at. |
| `vault` | bool | true | core | After a genuinely finished run, writes readable notes in .claude/forge-vault/ (mission, decisions, topics) that link to each other — plain markdown, optionally opened in Obsidian for a graph view. |
| `write-scope-mode` | enum | "warn" | advanced | What the write-scope freeze does with a shell command that writes outside the chosen folder: warn (the default) lets it run with a visible warning, deny blocks it. Only takes effect while the freeze is on, which you turn on with the environment variable FORGE_WRITE_SCOPE=<folder> when you start Cla… |
