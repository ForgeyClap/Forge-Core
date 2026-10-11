# Discord bridge

An optional part of the Command Center that lets you send tasks to Claude Code from Discord. Each project gets its own channel; a message in that channel runs as a Claude Code task in that project's folder, and the result is posted back.

The easiest way to set it up is the Connect Discord wizard in the Command Center. It walks you through creating a server and a bot, takes the bot token, gives you the invite link, and creates the category, the channels and a test message. The token is stored only in `command-center/discord/.env` and is never shown or logged. The bridge installs its own npm package (`discord.js`) the first time you connect.

## Running it by hand

```bash
npm install
npm test              # the test suite, against a simulated Discord
npm run demo          # an end-to-end run without Discord
node src/main.js      # the service
```

Configuration is read from `.env`; `.env.example` lists every variable. The main ones:

| Variable | Meaning |
|---|---|
| `TRANSPORT` | `mock` (simulated, for tests) or `discord`. |
| `RUNNER` | `fake` (echoes the prompt, for tests) or `claude` (runs Claude Code headless). |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` | The bot and the server, only for `TRANSPORT=discord`. |
| `OWNER_USER_IDS` | Comma-separated Discord user IDs allowed to send tasks. Everyone else is ignored. |
| `FORGE_PROJECTS_DIR` | Folder whose projects each get a channel. |
| `STATE_DIR` | Where the queue, channel mappings, outbox and audit log are stored. |

The bridge needs Node.js 20 or newer.

## Commands in Discord

Type `/forge` in a project channel for the menu.

| Command | What it does |
|---|---|
| (a plain message) | Runs it as a task in that channel's project folder. |
| `/forge status`, `/forge queue` | Active runs and the queue. |
| `/forge stop`, `/forge interrupt` | Stops the current run; its checkpoint is kept. |
| `/forge retry <id>`, `/forge remove <id>` | Runs a queued item again, or removes it. |
| `/forge usage [hours]` | Plan usage and the bot's own usage. |
| `/forge diff [hours]` | The files that actually changed. |
| `/forge model`, `/forge effort` | Model and effort level for the project. |
| `/forge write on` or `off` | Whether runs in this project may write files. |
| `/forge schedule`, `/forge schedules`, `/forge unschedule` | Scheduled tasks. |
| `/forge briefing` | Sends the daily briefing now. |
| `/forge memory` | What the bot keeps about this project. |
| `/forge pause`, `/forge resume` | Pause and resume by hand. |
| `/forge reset`, `/forge session reset` | Clears the channel, or starts a fresh conversation. |

## How it is built

| File | Role |
|---|---|
| `src/permissions.js` | Allows only the listed owners; ignores the bot itself, other bots and webhooks. |
| `src/router.js` | Maps a channel to a project and a thread to a conversation. |
| `src/queue.js` | A durable queue: duplicate messages are dropped, messages older than two hours ask for confirmation, at most ten waiting per thread, and runs interrupted by a restart are queued again. |
| `src/scheduler.js` | One active run per thread, first in first out with priorities, real cancellation and a clean shutdown. |
| `src/outbox.js` | Posts each final report exactly once and marks a report as uncertain if the process stopped while sending. |
| `src/commands.js` | The `/forge` thread commands. |
| `src/transport/mock.js`, `src/transport/discord.js` | The simulated Discord used by the tests, and the real adapter. |
| `src/runner-fake.js`, `src/runner-claude.js` | The echo runner for tests, and the runner that starts `claude -p` with the prompt on stdin. |
