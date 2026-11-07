# Git Bash (MSYS2) on Windows: the traps agents hit

The Bash tool runs Git for Windows' Bash (MSYS2, `MSYSTEM=MINGW64`). It feels like Linux, but it calls
Windows programs and rewrites some of their arguments on the way.

## Which shell am I in?
| Check | Git Bash | PowerShell |
|---|---|---|
| `MSYSTEM` | `MINGW64` | empty |
| `PSModulePath` | inherited, may be set (not proof) | set |
| `$PSVersionTable` | does not exist | version object |
| `uname -s` | `MINGW64_NT-10.0-...` | not a command |

Check `MSYSTEM` first in Bash and `$PSVersionTable` first in PowerShell; `PSModulePath` alone is not proof,
because Git Bash started from PowerShell inherits it.

## Paths
- Bash style is `/c/Users/YOU/...`; Windows tools want `C:\Users\YOU\...` or `C:/Users/YOU/...`
  (forward slashes work for most Windows programs, including Node and git).
- Convert with `cygpath -w '/c/path'` (Windows), `cygpath -m '/c/path'` (mixed, forward slashes) and
  `cygpath -u 'C:\path'` (Bash).
- Quote every path. This project lives in `C:\Users\YOU\Documents\my project!`: spaces and a `!`.
  Single quotes are always safe. Double quotes are fine in the Bash tool (it is non-interactive, so `!`
  history expansion is off), but an interactive Bash expands `!` inside double quotes.
- The Bash tool resets the working directory between calls in an agent thread: use absolute paths, or
  `cd '<abs path>'; command` in one call.

## Automatic argument conversion (the trap that breaks Windows exes)
MSYS converts arguments that look like POSIX paths before it starts a Windows program:
- a leading `/` is rewritten. Measured here on 2026-11-05 with a Node program that prints its argv:
  `/R:1` arrived as `R:1` (slash dropped), `/PID` as `C:/Program Files/Git/PID`, and `--opt=/foo` as
  `--opt=C:/Program Files/Git/foo`; `//R:1` arrived as `/R:1` and `C:/x` unchanged;
- colon lists such as `/a:/b` are converted as path lists;
- exempt: arguments that already start with a drive letter (`C:/x`), contain `;`, or start with `//`.

Safe forms, best first:
1. Run tools that take `/switch` arguments (robocopy, taskkill, icacls, findstr) from the **PowerShell
   tool** instead.
2. Turn conversion off for one call: `MSYS_NO_PATHCONV=1 <exe> <args>`.
3. Double the slash: `//R:1` arrives as `/R:1`. This works but is hard to read; prefer 1 or 2.

## Line endings
- A shell script saved with CRLF fails in Bash with `$'\r': command not found` or `bad interpreter`. Save
  `.sh` files with LF; the repo's `.gitattributes` is the authority (this machine has no global
  `core.autocrlf`, measured 2026-11-05).
- Text compared byte for byte (test fixtures, snapshots, hashes) differs between a Windows-written and a
  git-checked-out copy. Normalise `\r\n` to `\n` in the comparison, never by rewriting the fixture
  silently.
- `git diff` showing every line changed with no visible difference is a line-ending change; look with
  `git diff --stat` and `git ls-files --eol <file>` before committing it.

## Calling the other shell
- From Bash: `powershell.exe -NoProfile -Command 'Get-NetTCPConnection -LocalPort 4100'`. Use single quotes
  so Bash does not expand `$`; convert paths with `cygpath -w` first. Do not build that command from a
  variable (opaque execution, gate-blocked) and do not pass `-ExecutionPolicy` (rule 4).
- From PowerShell: `& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/repo && git status'`.
- Cmdlets do not exist in Bash and Unix tools do not exist in PowerShell; an alias of the same name (`ls`,
  `rm`, `cat`) is a different program with different flags.

## This machine
- `python` and `python3` can resolve to a `WindowsApps` alias: a real install manager or a Store stub that
  hangs (a stub spun for hours unseen in 2026-10; on 2026-11-05 `python`, `py -3` and `python3` all answered
  3.14.6). Probe each with `--version` and a timeout before a step relies on it; Forge tooling uses Node
  (`node` is on PATH in the Bash tool).
- `/tmp` in Git Bash maps to the user's temp folder, which is shared with other sessions; use the session
  scratchpad or the project's `_scratch/`.
