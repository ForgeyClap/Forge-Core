# forge-bots — team, skills, commands, MCP

## Team (conditional)
Lead: `integration-boss` (a bot is an external-system/webhook integration; use `build-boss` if the bot is one slice of a larger app). Support: `security-boss` (signature/secret verification, minimal scopes, token hygiene — this is a real security trigger), `test-boss` (drive signed vs forged/replayed events, rate-limit + dedupe behavior), `silent-failure-hunter` (dropped deliveries / swallowed 429s look like success), `typescript-reviewer` / `python-reviewer` by stack. `mcp-developer` only if the bot is exposed as or consumes MCP tools. Optional advisors: `security-reviewer`, `codex-reviewer` on the verification + auth code.

## Skills / commands / MCP
Defer the OAuth/secret/webhook backbone + the reader-side capability-split to `forge-integration`. Get the **exact** signature algorithm and API/version behavior from the platform SDK / vendor docs via Context7 (discord.js / discord-interactions, Slack Bolt / `@slack/*`, Telegram Bot API / grammY / python-telegram-bot) — never hand-roll the crypto; reuse the platform's official verification helper. `systematic-debugging` for delivery/ack failures. If the bot runs through n8n, defer webhook handling to `forge-n8n`. **Opt-in:** any Discord/Slack/Telegram MCP tools via ToolSearch only when present — not assumed.
