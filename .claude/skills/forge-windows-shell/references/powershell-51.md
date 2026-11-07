# Windows PowerShell 5.1: the traps agents hit

The PowerShell tool on this machine is Windows PowerShell 5.1 (measured 2026-11-05: `5.1.26100`). PowerShell
7 (`pwsh`) is not installed, so advice written for 7.x often does not apply. Check before you trust a
snippet: `$PSVersionTable.PSVersion`.

## Operators and control flow
- `&&` and `||` do not exist in 5.1 (parser error). Run B only when A succeeded: `A; if ($?) { B }`.
  Run both regardless: `A; B`. For a native exe, `$?` is unreliable after a redirect (see below), so prefer
  `A; if ($LASTEXITCODE -eq 0) { B }`.
- No ternary `?:`, no `??`, no `?.`. Use `if ($null -eq $x) { ... } else { ... }`.
- Put each cmdlet call in parentheses inside `-and` / `-or`:
  `if ((Test-Path 'a') -or (Test-Path 'b')) { ... }`. Without them PowerShell reads `-or` as a parameter.
- Put `$null` on the left of a comparison (`$null -eq $list`), because `$list -eq $null` filters an array.
- `ConvertTo-Json` stops at depth 2 by default; nested objects become strings. Always pass `-Depth 10` (or
  what the data needs). `ConvertFrom-Json` returns a PSCustomObject; there is no `-AsHashtable` in 5.1.

## Quoting and paths
- Single quotes are literal: `'C:\Users\YOU\Documents\my project!'`. Double quotes expand `$name`
  and `$(...)`; a `$` in a password-like or regex string inside double quotes is silently eaten.
- An exe whose path is quoted needs the call operator: `& 'C:\Program Files\nodejs\node.exe' --version`.
- A literal apostrophe inside single quotes is doubled: `'it''s'`. The curly quotes U+2018 to U+201B are
  also read as apostrophes by PowerShell, so text pasted from a document can end a string early.
- `-LiteralPath` instead of `-Path` when a name contains `[` or `]` (wildcard characters for `-Path`).
- `Join-Path` builds paths; do not glue strings with `\`.
- Arguments that look like operators (`--format=%H`, `@file`) can be passed verbatim after the stop-parsing
  token: `git log --% --format=%H`. Nothing after `--%` is expanded, not even `$env:`.

## Here-strings
```powershell
git commit -m @'
feat: one line summary

Body with $literal dollar signs and `backticks`.
'@
```
- `@'` must end its line; the closing `'@` must start at column 0 on its own line. Indenting it is a parse
  error, which is the most common reason a multi-line commit message fails here.
- Use `@"` ... `"@` only when you want variables expanded.

## Native executables and stderr
- `2>&1` on a native exe (git, node, npm, robocopy) in 5.1 wraps every stderr line in an error record
  (`NativeCommandError`) and sets `$?` to false even when the exit code is 0. With
  `$ErrorActionPreference = 'Stop'` the first stderr line throws, and git prints progress on stderr.
  Do not redirect stderr for a native exe in the PowerShell tool (it is captured for you); judge success by
  `$LASTEXITCODE`.
- `try/catch` does not catch a native exe that fails; it only sets `$LASTEXITCODE`. Check it explicitly.
- Native argument passing in 5.1 drops embedded double quotes, so an inline program such as a
  `node -e` call with quotes inside arrives broken. Put the code in a `.cjs` file in `_scratch/` (or the
  session scratchpad) and run the file.
- `curl` is an alias of `Invoke-WebRequest`, `where` of `Where-Object`, `sc` of `Set-Content`, `ls` of
  `Get-ChildItem`, `rm` of `Remove-Item`. Call `curl.exe`, `where.exe`, `sc.exe` when you mean the tool.

## Encoding (measured on this machine)
Written text `he` with an accented e, first bytes read back:

| Command | Bytes | Meaning |
|---|---|---|
| `'x' > file` | `EF BB BF ...` | UTF-8 with BOM (this profile sets `$PSDefaultParameterValues['Out-File:Encoding']`) |
| `'x' \| Out-File file` | `EF BB BF ...` | same default |
| `'x' \| Out-File file -Encoding utf8` | `EF BB BF ...` | UTF-8 with BOM, explicitly |
| `Set-Content file 'x'` | single byte for the accented letter | the ANSI code page (Windows-1252), not UTF-8 |

Consequences:
- Stock 5.1 without that profile default writes UTF-16LE from `>` and `Out-File`. Never rely on the
  default: pass `-Encoding utf8` to `Out-File`, `Set-Content` and `Add-Content`.
- 5.1 has no BOM-less UTF-8 option on those cmdlets. A file that must be BOM-less (JSON read by a strict
  parser, a shell script, a file under byte-compare) is written with the Write tool or from Node
  (`fs.writeFileSync(p, text, 'utf8')`), not from 5.1.
- A `.ps1` with non-ASCII text must be saved as UTF-8 **with** BOM, or 5.1 reads it as ANSI.
- A log a tool cannot read was probably UTF-16: re-read it with `Get-Content -Encoding Unicode` and write a
  UTF-8 copy instead of editing the original.

## Errors and exit codes
- `-ErrorAction SilentlyContinue` hides the message but the PowerShell tool still reports exit 1 for the
  failed cmdlet. To make a failure truly non-fatal: `try { Cmdlet ... -ErrorAction Stop } catch { <say why it
  is fine> }`. An empty catch is a swallowed error (see `forge-code-review` lenses).
- Destructive cmdlets may prompt; the tool has no console, so a prompt reads end-of-input and fails. Use
  `-Confirm:$false` only for a step you are allowed to do; it never makes a gated step allowed.
- Never `Read-Host`, `Get-Credential`, `Out-GridView` or `pause`: they block or fail without a console.

## Not here, on purpose
No execution-policy change, no PATH change, no profile edit, no module install from the gallery: each
changes the machine beyond the task and is an owner decision. No encoded or evaluated command
(`-EncodedCommand`, `Invoke-Expression` on a variable): the gate hook blocks them because nobody can read
what they run.
