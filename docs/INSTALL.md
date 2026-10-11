# Installing Forge-Core

## The one-line install

Run it from the project folder. The installer writes the project part into the current folder and stops if that folder is your home folder.

```bash
curl -fsSL https://raw.githubusercontent.com/ForgeyClap/Forge-Core/main/install.sh | bash
```

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ForgeyClap/Forge-Core/main/install.ps1 | iex"
```

`-ExecutionPolicy Bypass` applies to that one command only. It is needed because Windows blocks piped scripts and unsigned `.ps1` files by default. Run `install.sh` in bash and `install.ps1` in PowerShell, never the other way round.

When piped like this, the installer downloads the `main` branch as an archive and installs from that. Set `FORGE_REF` to install another branch.

## Installing from a clone

```bash
git clone https://github.com/ForgeyClap/Forge-Core
bash Forge-Core/install.sh --project /path/to/project --yes
```

```powershell
git clone https://github.com/ForgeyClap/Forge-Core
powershell -ExecutionPolicy Bypass -File .\Forge-Core\install.ps1 -ProjectDir "C:\path\to\project" -Yes
```

Started from a clone, the installer uses the files next to it and downloads nothing.

## Options

| bash | PowerShell | Effect |
|---|---|---|
| `--project <dir>` | `-ProjectDir <dir>` | Target project (default: the current folder). |
| `--yes`, `-y` | `-Yes` | Do not ask for confirmation. `FORGE_YES=1` does the same. |
| `--dry-run` | `-DryRun` | Show what would be written or removed and change nothing. |
| `--global-only` | `-GlobalOnly` | Only the global part in `~/.claude`. |
| `--project-only` | `-ProjectOnly` | Only the project part in `<project>/.claude`. |
| `--uninstall` | `-Uninstall` | Remove what the installer wrote (see below). |

## What gets written

- `<project>/.claude/`: agents, commands, skills, scripts, configuration and `settings.json`. If the project already has a `.claude/settings.json`, the installer merges the Forge hooks and permission rules into it, keeps your own entries and writes a backup first.
- `<project>/CLAUDE.md`, only if the project does not have one yet, from `templates/project-CLAUDE.md`.
- A block of lines in `<project>/.gitignore` (from `templates/gitignore.snippet`) that keeps `.env` files, run logs and per-install state out of git.
- `~/.claude/commands/forge.md`, `~/.claude/commands/setup-forge.md` and `~/.claude/skills/forge-core/`, from `global-install/.claude/`.
- `~/.claude/forge/template/`: a copy of the project files that `forge-sync` compares projects against, and the Command Center with its dashboard already built.
- An install manifest with a sha256 per written file: `<project>/.claude/.forge-install-manifest.json` and `~/.claude/forge/install-manifest.json`.

Files that already exist and differ are renamed with a `.forge-bak-<timestamp>` suffix before the new copy is written. Running the installer again is safe; identical files are left alone.

## Updating

Run the installer again in the project. To see whether a project differs from the installed template:

```bash
node .claude/forge-bin/forge-sync.cjs status .
```

## Uninstalling

```bash
bash install.sh --uninstall --project /path/to/project
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -ProjectDir "C:\path\to\project"
```

Add `--dry-run` or `-DryRun` to see the list first. The uninstaller removes a file only when its current sha256 still matches the install manifest, so a file you changed stays and is reported as kept. Your own data always stays: a `CLAUDE.md` that existed before Forge or that you edited, `.env`, the `FORGE_MEMORY*` files, `.claude/forge-runs/`, `.claude/agent-memory/` and `.claude/settings.json`. Running it twice does nothing the second time. `--global-only` and `--project-only` work here too.

## Plugin or installer

The plugin is installed from inside Claude Code and lives in Claude Code's read-only plugin cache, so installing it writes nothing to your project or to `~/.claude`. Because of that it cannot bring a settings file, the shell-command hook or the dashboard.

| | Plugin | Installer |
|---|---|---|
| Commands | `/forge:forge`, `/forge:setup-forge` | `/forge`, `/setup-forge` |
| Agents and core skills | Yes | Yes |
| All skills, including the vendored public ones | No | Yes |
| Settings (`/forge config`) | No | Yes |
| Shell-command hook and `.env` read protection | No | Yes |
| Command Center dashboard | No | Yes |
