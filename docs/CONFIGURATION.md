# Configuration

## Settings

Every setting has a default, and most are on by default. Inside Claude Code:

```
/forge config list                     # every setting, its value and where the value comes from
/forge config explain <setting>        # what one setting does
/forge config set <setting> <value>    # change one for this project
/forge config set <setting> <value> --global
/forge config unset <setting>          # back to the default
```

You can also ask in plain words ("pause at 90 percent", "stop asking Codex for a second opinion") and Forge runs the command for you. From a terminal, the same tool is `node .claude/forge-bin/forge-config.cjs`.

Values are stored in two files. Neither holds secrets.

- `<project>/.claude/FORGE_CONFIG.json` for the project
- `~/.claude/FORGE_CONFIG.json` for all projects

A value given for one run wins over the project file, which wins over the global file, which wins over the default. A missing file means "use the defaults". A file that cannot be read is reported as an error and is never silently ignored.

The settings schema, with every key, type, default and description, is `.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json`.

### Settings most people look at

| Setting | Default | What it does |
|---|---|---|
| `usage-guard` | on | Pauses Forge when your Claude usage nears the limit. It measures every 2 minutes, so it pauses before the limit but cannot guarantee an instant stop. |
| `usage-guard.pause-at` | 98 | The percentage at which it pauses. |
| `autonomy` | `continue-within-mission` | Keeps working across phases without asking "continue?" each time. STOP always works. |
| `start-gate` | `off` | When on, Forge waits for START after posting the plan. |
| `gate-hook` | on | The shell-command hook described below. |
| `git-checkpoint` | on | Makes a local git commit or branch before a larger change, so it can be undone. It never pushes. |
| `intake` | `silent` | Forge answers its own intake questions from the request and the project, and asks you at most one multiple-choice question. |
| `explain-mode` | on | One plain sentence per phase about what Forge is doing. |
| `codex-review` | `auto` | Asks the OpenAI Codex CLI for a second review of important code, if that CLI is installed and logged in. |
| `dashboard` | on | Starts the Command Center on `127.0.0.1:4100` when needed. |
| `language` | `auto` | The language Forge answers in. Code and technical documents stay in English. |

### Rules that cannot be switched off

Some actions always need your approval first, whatever the settings say: deploying, `git push`, spending money, DNS changes, switching on production, credentials, sending anything outside your machine, killing processes by name, destructive deletes, and writing outside the project. These are listed in `.claude/config/orchestration/hard-gates.json`. Most of them are rules the assistant follows; the shell-command hook below enforces five of them in code.

## The shell-command hook

`.claude/settings.json` registers a hook (`.claude/forge-bin/forge-gate-hook.cjs`) that checks every shell command Claude Code is about to run. It blocks five kinds of command until you approve them:

- recursive deletes (`rm -r`, `Remove-Item -Recurse`)
- killing processes by name (`taskkill /IM`, `pkill`)
- git commands that throw away uncommitted work (`git reset --hard`, `git checkout .`, `git restore <path>`)
- commands that hide what they run (`eval`, `Invoke-Expression`, a script piped into a shell)
- commands that print the contents of a secret file (`.env`, private keys, credential files)

Cleanups inside temporary folders such as `node_modules`, `dist` or the system temp folder are allowed when the hook can prove the path is one of those. The hook is a pattern classifier, not a proof: a command it does not recognise is not stopped. The list of known gaps is in `hard-gates.json` under `_not_caught`.

To see only the variable names in a `.env` file, without values:

```bash
node .claude/forge-bin/forge-env-names.cjs .env
```

Only you can switch the hook off, with `/forge config set gate-hook off` typed yourself. An agent's attempt to do so is blocked.

## Files Claude Code may not read

The same `settings.json` denies Claude Code's file reader access to `.env` files and their common variants at any depth, `secrets/` folders, private keys, `~/.ssh/` and Claude Code's own credentials file. `.env.example` stays readable.

When a project already has a `.claude/settings.json`, the installer merges these hooks and rules into it and keeps your own entries.

## What leaves your machine

Forge itself runs locally. These settings contact an outside service, and only when the condition in the last column is met:

| Setting | Service | Condition |
|---|---|---|
| `usage-guard` | `api.anthropic.com` | On by default. It reads your Claude login token from `~/.claude/.credentials.json` locally and sends it only to Anthropic to read your usage. |
| `codex-review` | OpenAI, through the Codex CLI | The Codex CLI is installed and you are logged in to it. |
| `nvidia` | NVIDIA's API | An `NVIDIA_API_KEY` is set in `.env` or `~/.claude/nvidia.env`. |
| `account-rotator` | none (local files only) | Reads your Claude login files to switch between accounts you enrolled yourself. |

Switch any of them off with `/forge config set <setting> off`.

## Keys and `.env`

`/setup-forge` writes a temporary, already gitignored file with labelled placeholders. You fill it in and say "done"; Forge moves the values into a gitignored `.env`, writes a values-free `.env.example` and deletes the temporary file. Keys are optional.

If a `.env` file is already tracked by git, the setup stops and untracks it (`git rm --cached`, the file on disk stays) and tells you to rotate the exposed keys.

## Model routing

`.claude/FORGE_MODEL_ROUTING.json` maps each kind of work to a model and an effort level: cheaper settings for routine steps, stronger ones for risky changes. `.claude/settings.model-tier.example.json` is an example of per-project model settings.
