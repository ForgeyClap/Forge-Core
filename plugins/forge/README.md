# Forge-Core plugin

This folder is the Claude Code plugin version of [Forge-Core](https://github.com/ForgeyClap/Forge-Core).

## Install

```
/plugin marketplace add ForgeyClap/Forge-Core
/plugin install forge@forge-core
/reload-plugins
/forge:setup-forge
```

## What it contains

- `/forge:forge`: classifies a task, picks a small team of agents, does the work and reports what ran.
- `/forge:setup-forge`: first-run questions (name, goal, project type, language). It notices that it runs as a plugin and offers the full installer.
- The Forge agents, the same files as in `.claude/agents/`.
- The core skills: `forge-core`, the task router, the domain playbooks (website, full-stack, n8n, RAG, scraping, prediction, integration), reporting and verification.

Plugin commands are namespaced (`/forge:forge`). The installer gives you the plain `/forge` and `/setup-forge`.

## What it does not contain

Claude Code keeps plugins in a read-only cache, so a plugin cannot write to `~/.claude` or set up a project's `.claude/` folder. That leaves out the settings file and `/forge config`, the shell-command hook, the `.env` key setup, the vendored public skills and the Command Center dashboard. The installer in the repository root provides all of those; see the [installation guide](https://github.com/ForgeyClap/Forge-Core/blob/main/docs/INSTALL.md).

## License

MIT, see [LICENSE](https://github.com/ForgeyClap/Forge-Core/blob/main/LICENSE).
