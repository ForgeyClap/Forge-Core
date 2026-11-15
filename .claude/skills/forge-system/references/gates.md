<!-- generated: forge-system-skill; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->
# Forge hard gates (21)

Generated from: `.claude/config/orchestration/hard-gates.json`.

## 8 command gates: blocked by the PreToolUse gate hook

The hook is a classifier, not a proof: what it does not recognise it does not stop (the file lists that under `_not_caught`).

| id | class | reason |
|---|---|---|
| `kill-by-name` | irreversible | Killing a process by IMAGE/NAME (taskkill /IM, Stop-Process -Name, pkill, killall, wmic process where name=..., a taskkill /FI filter other than PID, a name-scoped Get-Process/gps/ps piped into Stop-Process / $_.Kill(), or kill $(pgrep …) / pgrep … \| xargs kill) takes down every process with that name, including unrelated live services — the owner's global HARD MUST allows only killing an exact P… |
| `destructive-delete` | irreversible | A recursive, forced delete (rm -rf, Remove-Item -Recurse, and their Windows aliases del/erase/rd/rmdir/ri, plus rmdir /s, del /s, rimraf) destroys a whole tree with no undo — confirm the exact target with the owner first. `rm` is itself a Remove-Item alias on Windows, so `rm -Recurse .claude` is caught too; the two-letter `rm -r` is NOT, because it is also POSIX's ordinary recursive fla… |
| `git-destructive` | irreversible | A git command that discards work that was never committed cannot be undone from the reflog — confirm with the owner before running it. Covered: reset --hard, clean -f, checkout --force / -f, checkout . (a bare dot), checkout -- <path> and checkout <tree-ish> -- <path> (any pathspec after `--`), restore <path> / restore . (unless it is only `restore --staged`, which merely unstages), switch -f / -… |
| `opaque-exec` | irreversible | Feeding unknown or decoded content straight into an interpreter hides the actual command from every other gate: a pipe into sh/bash/zsh/dash/ksh/pwsh/powershell, iex/Invoke-Expression, eval, sh -c/bash -c/pwsh -c/powershell -c evaluating a variable or command substitution, or a certutil -decode chained with `&`. Forge cannot see what this would run, so it stops and asks instead of guessing. |
| `secret-print` | irreversible | Printing the CONTENTS of a secret file (.env and its variants except .env.example/.env.sample/.env.template, *.pem, *.key, id_rsa*, id_ed25519*, *credentials*.json, service-account*.json, *.p12/*.pfx, .npmrc/.pypirc/.netrc/.git-credentials, .docker/config.json, .aws/credentials, secrets/**) to the terminal or transcript exposes the real values — once seen/logged that exposure cannot be undone, so… |
| `plugin-install-command` | irreversible | A `claude plugin install\|enable\|update` or `claude plugin marketplace add` command brings new code with its own hooks, agents and permissions into Claude Code for this user or project — ask the owner first. `claude plugin list`, `validate` and `eval` stay allowed. |
| `settings-edit-command` | irreversible | A shell command that writes, replaces, moves or deletes the Claude Code settings (.claude/settings.json, .claude/settings.local.json, ~/.claude/settings.json) — or `claude config set` — changes which commands run without asking and which hooks run, the Forge gate included. The same holds for Forge's own config store (.claude/FORGE_CONFIG.json, ~/.claude/FORGE_CONFIG.json and the FORGE_CONFIG.once… |
| `global-input-command` | irreversible | A command whose own code sends GLOBAL keyboard or mouse input (Windows Forms SendKeys.Send/SendWait, Win32 SendInput, keybd_event, mouse_event, a WScript.Shell object's SendKeys/AppActivate) types into whatever window is in front, not into the app under test; in windows-game-v6 a launch check typed Enter, Esc and b into the owner's other terminal that way. Post the input to the a… |

## 1 path gate(s): classifier and prose

| id | class | reason |
|---|---|---|
| `write-outside-root` | isolation | Writing outside the current project's root breaks Forge project isolation — refuse and confirm the exact target folder with the owner before proceeding. |

## 12 owner gates: the owner decides

A request that matches one of these waits for the owner (classifier on the text plus the written rule). They go into the one batched owner queue at the end of a run.

| id | class | reason |
|---|---|---|
| `deploy` | irreversible | Deploying or publishing to a live environment (or going live) is irreversible without explicit owner approval. |
| `git-push` | irreversible | Pushing commits to a remote (especially a force-push or a push to main/master) is irreversible without explicit owner approval. |
| `spend` | irreversible | Spending money, charging a card, issuing a refund, or placing a real bet is irreversible without explicit owner approval. |
| `dns-change` | irreversible | Changing DNS records or nameservers can break production traffic and is irreversible without explicit owner approval. |
| `prod-activate` | irreversible | Activating a production environment or switching a system into production is irreversible without explicit owner approval. |
| `credential-attach` | irreversible | Attaching, inserting, or hardcoding a real credential/secret/token/password is irreversible-risk (exposure) without explicit owner approval. |
| `credential-rotate` | irreversible | Rotating or revoking a live credential/secret/token invalidates the old one irreversibly without explicit owner approval. |
| `workflow-activate` | irreversible | Activating a live n8n/automation workflow can trigger real-world side effects and is irreversible without explicit owner approval. |
| `outbound-sms` | irreversible | Sending an SMS, outbound call, or live outreach/email is irreversible without explicit owner approval (draft-only unless approved). |
| `data-delete` | irreversible | Deleting or wiping a folder, files, a database, a table, a branch or backups is irreversible without explicit owner approval — confirm the exact target first. This is the TEXT twin of the command gate destructive-delete: it catches the intent in words (English and Dutch); the hook never enforces it. |
| `plugin-install` | irreversible | Installing or enabling a Claude Code plugin or adding a marketplace brings in new code with its own hooks, agents and permissions for this user or project — ask the owner first and name the plugin, the marketplace and its source. This is the TEXT twin of the command gate plugin-install-command; the hook never enforces it. |
| `settings-edit` | irreversible | Editing the Claude Code settings (.claude/settings.json, .claude/settings.local.json or ~/.claude/settings.json) changes which commands run without asking and which hooks run — including the Forge gate itself — so ask the owner first, or use the Forge tool (forge-config for Forge settings, forge-sync/forge-init for hooks, which make a backup). This is the TEXT twin of the command gate settings-ed… |
