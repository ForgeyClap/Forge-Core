# Working on this repository

This repository is Forge-Core itself. These notes are for Claude Code sessions that change it. Projects that install Forge-Core get their own `CLAUDE.md` from `templates/project-CLAUDE.md`.

- What users receive lives in `.claude/` (copied into their projects by the installer), `global-install/`, `plugins/forge/`, `command-center/` and the two installers.
- Scripts in `.claude/forge-bin/` use Node's built-in modules only. Do not add npm dependencies there.
- Every script has a `<name>.test.cjs` next to it. Run the suite of each script you change: `node .claude/forge-bin/<name>.test.cjs`.
- A new file needs a rule in `.claude/config/orchestration/FORGE_SHIP_MANIFEST.json`; `node .claude/forge-bin/forge-shipcheck.cjs` reports files without one.
- When you change a skill or an agent that the plugin carries, copy it to `plugins/forge/` too. CI compares the copies.
- Before you finish, run `node .claude/forge-bin/forge-doctor.cjs --root .`.
- Never commit secrets or `.env` files.
