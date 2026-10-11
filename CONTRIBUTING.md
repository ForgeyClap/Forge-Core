# Contributing

Bug reports, fixes, skills, agents and documentation are welcome. By contributing you agree that your work is published under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- No npm dependencies in `.claude/forge-bin/` or in `global-install/`. Those scripts use Node's built-in modules only. The Command Center under `command-center/` has its own `package.json` files and is the exception.
- Every script in `.claude/forge-bin/` has a test file next to it (`<name>.test.cjs`). Add or update the test with the change.
- The project runs on Windows, macOS and Linux. If you change a script that has `.cmd`, `.ps1` and `.sh` wrappers, check the wrappers too.
- Never commit secrets. Real values belong in `.env`, which is gitignored; `.env.example` holds names only.
- When you describe a check in a pull request, say whether you ran it and what the result was.

## Adding a skill

1. Create `.claude/skills/<name>/SKILL.md` with `name` and `description` in its frontmatter, and any reference files next to it.
2. If the plugin should carry it, copy the whole folder to `plugins/forge/skills/<name>/`. Use real files, not symlinks. CI fails when a plugin copy differs from its source.
3. Give it a rule in `.claude/config/orchestration/FORGE_SHIP_MANIFEST.json` if the existing patterns do not cover it. `node .claude/forge-bin/forge-shipcheck.cjs` reports files that no rule classifies.
4. If `/forge` should pick it for a kind of task, mention it in the `forge-router` skill.

## Adding an agent

1. Create `.claude/agents/<name>.md` with valid frontmatter.
2. Copy it to `plugins/forge/agents/<name>.md`.

## Checks to run before a pull request

```bash
node .claude/forge-bin/forge-doctor.cjs --root .
node .claude/forge-bin/forge-shipcheck.cjs
```

The doctor syntax-checks every script, runs every test suite and scans tracked files for secrets. Its verdict should read `ALL GREEN`. If you have the Claude Code CLI, also run `claude plugin validate .`.

If you changed the setup or key flow, run `node .claude/forge-bin/forge-setup.test.cjs` as well.

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep the change focused.
3. Use a short commit message that says what changed, for example `fix: forge-sync keeps owner overlays`.
4. In the pull request, describe what changed, why, and which checks you ran.

CI runs `.github/workflows/validate.yml` (syntax, test suites, doctor, manifests, plugin copies) and `.github/workflows/fresh-install.yml` (installs into an empty folder with an empty home folder on Linux and Windows). Both must pass before a merge.
