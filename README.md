# Forge-Core

![Forge-Core](assets/logo.svg)

Forge-Core is a set of agents, skills, slash commands, hooks and small Node scripts for [Claude Code](https://claude.com/claude-code). With it installed, a request such as `/forge add a contact form to the landing page` is planned, split into work packages, handed to Claude Code subagents, tested and reviewed. Every step is written to a log inside your project, so you can see afterwards what ran and what did not.

It also includes the Command Center, an optional local web dashboard on `http://127.0.0.1:4100` that shows the runs of your Forge projects.

## Requirements

- Claude Code, on a plan that includes it (a paid Claude plan, or a Claude Console account with API billing).
- Node.js 18 or newer. The scripts in `.claude/forge-bin/` use only Node's built-in modules, so there is nothing to `npm install` for them.
- Git. Not strictly required, but the key setup and several checks use it.

## Install

There are two ways to install. The installer gives you everything; the plugin is a smaller, read-only subset.

### With the installer

Run it from inside the project you want to use Forge-Core in. It refuses to run in your home folder and asks once before it writes anything.

macOS and Linux:

```bash
cd my-project
curl -fsSL https://raw.githubusercontent.com/ForgeyClap/Forge-Core/main/install.sh | bash
```

Windows (PowerShell):

```powershell
cd my-project
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ForgeyClap/Forge-Core/main/install.ps1 | iex"
```

The installer copies `.claude/` into your project and the global part (`/forge`, `/setup-forge` and the `forge-core` skill) into `~/.claude`. It also puts the Command Center under `~/.claude/forge/template/command-center/`. A file that already exists and differs is backed up before it is replaced. [docs/INSTALL.md](docs/INSTALL.md) covers the options, installing from a clone, updating and uninstalling.

### As a Claude Code plugin

```
/plugin marketplace add ForgeyClap/Forge-Core
/plugin install forge@forge-core
/forge:setup-forge
```

The plugin gives you the `/forge:forge` and `/forge:setup-forge` commands, the agents and the core skills. It does not include the settings file, the shell-command hook or the dashboard. Plugin commands are namespaced; the installer gives you the plain `/forge` and `/setup-forge`.

## First use

1. In your project, run `/setup-forge`. It asks for the project name, goal, type and language. It can also set up a local `.env` for API keys you want Forge to use; none are required.
2. Ask for something, for example `/forge build a landing page for a bakery`.
3. Check the installation whenever you like:

   ```bash
   node .claude/forge-bin/forge-doctor.cjs
   ```

   The verdict at the end reads `ALL GREEN` when every check passes.

`/forge config list` shows the settings and `/forge config set <setting> <value>` changes one. You can also say it in the chat, for example "turn off the usage guard". See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## What is in this repository

| Path | Contents |
|---|---|
| `.claude/agents/` | The subagent definitions, listed in [docs/AGENTS.md](docs/AGENTS.md). |
| `.claude/commands/` | Project slash commands, including `/forge`. |
| `.claude/skills/` | Skills: task routing, domain playbooks (website, full-stack, n8n, RAG, scraping and others), reporting and verification, and vendored public skills that keep their own licences. |
| `.claude/forge-bin/` | The Node scripts behind the commands, each with a `*.test.cjs` file next to it, and terminal wrappers (`.cmd`, `.ps1`, `.sh`). |
| `.claude/config/` | Configuration read by the scripts: the settings schema, the command gates, agent and model maps, and the shipping manifest. |
| `.claude/docs/` | Reference pages that `/forge` loads when it needs them. |
| `.claude/forge-dashboard/` | `log-event.cjs`, which writes the events of each run, and a start script for the dashboard. |
| `.claude/settings.json` | Hooks and permission rules. The installer merges them into a project's own settings file. |
| `global-install/` | The files the installer puts in `~/.claude`. |
| `plugins/forge/`, `.claude-plugin/` | The Claude Code plugin and its marketplace entry. |
| `command-center/` | The dashboard: `gateway/` (the local server), `dashboard/` (the web app, included prebuilt) and `discord/` (an optional Discord bridge). |
| `templates/` | Files the installer adds to a project: a starter `CLAUDE.md` and the `.gitignore` lines. |
| `tests/installer/` | Installer tests for bash and PowerShell, run in CI. |
| `install.sh`, `install.ps1` | The installers. |

## Running the tests

Each script in `.claude/forge-bin/` has a test file next to it. Run one suite with:

```bash
node .claude/forge-bin/forge-sync.test.cjs
```

The doctor runs every suite plus a set of checks on the tree:

```bash
node .claude/forge-bin/forge-doctor.cjs --root .
```

The Command Center has its own tests. Run `npm test` in `command-center/gateway` and in `command-center/discord`, and `npm install` followed by `npm test` in `command-center/dashboard`. The workflows in `.github/workflows/` run the installer tests on Linux and Windows.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE). Vendored skills under `.claude/skills/` keep their own licence files.
