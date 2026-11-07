# Files and processes on Windows: long paths, locks, copies, one PID

## Long paths
- Windows keeps a 260-character limit per path for programs that did not opt in. git hits it first in deep
  `node_modules`, in worktrees under long folder names, and in `.claude/forge-research/` dumps.
- For git, pass the option per call: `git -c core.longpaths=true worktree add <path> -b <branch>`, and the
  same for `worktree remove`, `checkout`, `clean -n` and `status`. (This repo also has `core.longpaths=true`
  in its config, measured 2026-11-05; a fresh clone or a synced client project may not.)
- Node handles long paths itself; PowerShell 5.1 cmdlets may not. When a cmdlet reports "could not find a
  part of the path" on a long name, use `-LiteralPath '\\?\C:\full\path'` or do the step from Node or git.
- Turning on long-path support for the whole machine (a registry or group-policy change) is an owner action,
  never a step an agent takes.

## File locks: EPERM, EBUSY, "access denied", "being used by another process"
Windows does not let you rename or delete a file another process has open. Common holders here: the editor,
the search indexer, antivirus scanning a freshly written file, a running `node` (a dev server or a test
watcher), and OneDrive or backup tools.

Handle it in this order:
1. Retry with a short, **bounded** backoff. A Node helper (write it into the tool that needs it):
   ```js
   const fs = require('node:fs');
   const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
   function renameWithRetry(from, to, tries = 5) {
     for (let i = 0; i < tries; i++) {
       try { return fs.renameSync(from, to); }
       catch (err) {
         if (!RETRY_CODES.has(err.code) || i === tries - 1) throw err;
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * 2 ** i);
       }
     }
   }
   ```
   Five tries wait 0.1 + 0.2 + 0.4 + 0.8 s, about 1.5 seconds in total. Never an unbounded loop.
2. Still locked: find out what holds it before acting. If it is a process this task started, stop that one
   PID (below). If it is anything else (the editor, the gateway, another lane), report the path and the
   holder to the Lead; do not stop it.
3. Never treat "access denied" as a reason to elevate (run as administrator) or to change file
   permissions; both are owner decisions.

An unreadable folder (EPERM on read, often a locked .NET scratch folder) is "not comparable", not
"changed": count it separately in any check that compares two readings.

## Copying with robocopy
- Run it from the PowerShell tool (Git Bash rewrites its `/switch` arguments, see `git-bash.md`).
- Always `/R:1 /W:1`. Add `/NP` (no per-file percentage) so logs stay readable, and `/LOG:<file>` for a big
  copy.
  `robocopy 'C:\src\dir' 'C:\dst\dir' /E /R:1 /W:1 /NP`
- Exit codes are a bit mask, not "0 = success": 0 nothing copied, 1 files copied, 2 extra files in the
  target, 4 mismatches; any value from 0 to 7 is success. **8 or higher is a failure.** Check
  `if ($LASTEXITCODE -ge 8) { ... }`, and remember that a script ending on robocopy's exit code 1 looks like
  a failure to CI.
- `/MIR` and `/PURGE` delete target files that are not in the source. Treat them as a delete: ask the owner
  with the exact target first.

## Stop exactly one process
### Prefer the PID you got when you started it
- `Start-Process` with `-PassThru` returns an object with `.Id`; Node's `spawn` returns `child.pid`.
- Start long-running services with their output going to a log file (`-RedirectStandardOutput` and
  `-RedirectStandardError` in PowerShell; `stdio` to a file stream in Node) and write the PID next to it.
  A service started hidden with no log and no recorded PID cannot be stopped safely later.

### Otherwise resolve it from the port
```powershell
$pids = @(Get-NetTCPConnection -LocalPort 4100 -State Listen -ErrorAction Stop |
  Select-Object -ExpandProperty OwningProcess -Unique)
$pids.Count
```
Fallback without the cmdlet: `netstat -ano | findstr :4100`, then read the PID in the last column of the
`LISTENING` line for that exact port (`:41000` also matches `:4100`, so check the column).

### Check before stopping
```powershell
Get-CimInstance Win32_Process -Filter "ProcessId=$($pids[0])" |
  Select-Object ProcessId, Name, CommandLine, CreationDate, ParentProcessId
```
Stop only when all of these hold:
- exactly one PID came back (zero: nothing to stop; several: stop and report, never widen the filter);
- the command line is the one you started for this task (the script path, the port, the run folder);
- the creation time is after you started it. PIDs are reused: a PID from an old log can belong to a new,
  unrelated process.

The Forge Command Center listens on port 4100 and other projects' dev servers run on this machine too. A
process you did not start is reported, not stopped.

### Stop it
- `Stop-Process -Id <pid>`; add `-Force` only after a plain stop did not end it.
- From cmd-style tools: `taskkill /PID <pid>` (run from PowerShell). `/T` also ends the child tree: only
  when that whole tree is yours.
- Confirm: run the port query again; it must return nothing. A process that ignores a stop is reported with
  its PID, not retried in a loop.
- Never by name, image name, window title, user name or wildcard filter, not in any shell. The gate hook
  blocks the common forms and the owner's HARD MUST forbids all of them.

## Node child processes on Windows
- Pass arguments as an array with `shell: false` (the default) so spaces and `!` in paths need no quoting.
- `.cmd` and `.bat` files (`npm`, `npx`, `pnpm` on Windows) cannot be spawned without a shell on current
  Node releases: since the April 2024 security releases (Node 18.20.2, 20.12.2, 21.7.3) that call fails
  with `EINVAL`. Prefer running the JavaScript entry point with `process.execPath`; if `shell: true` is
  unavoidable, pass only fixed literal arguments, never user or file input.
- Kill a child with `child.kill()` on its own PID. On Windows that ends the process, not its children; a
  tree you started can be ended with `taskkill /PID <pid> /T` from your own code.
- Every spawn that can hang gets a timeout and a log, and its PID goes into the run record so the watchdog
  can see it.
