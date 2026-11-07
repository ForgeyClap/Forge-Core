# Node inspector debugging (Windows + Node)

Read this when a Node bug needs live state that logs cannot give: a hidden local, an async hang, a flaky test,
a startup race, a child process, memory growth or a CPU hot path. Try the cheaper loops in
`references/feedback-loops.md` first; the inspector is for when those do not show the cause.

## Order of tools
1. `node inspect <script>` pauses on the first line and gives a small REPL (continue, step, set a breakpoint
   by file and line or by function name, evaluate in the current scope). Start here.
2. `node --inspect-brk <script>` when something else (an editor, a CDP client) will attach. Plain `--inspect`
   does not pause, so setup that must happen before the code runs needs `--inspect-brk`.
3. A scripted Chrome DevTools Protocol client only when you need automated breakpoints, repeated state
   capture, a heap snapshot or a CPU profile.

## Safety rules (Forge)
- Bind the inspector to `127.0.0.1` only. Never `0.0.0.0`, never a port forwarded off the machine: the
  inspector runs arbitrary code in the target process.
- Parallel targets each need their own port (`--inspect-brk=0` lets Node pick one); a child process started
  with `NODE_OPTIONS=--inspect-brk` needs its own port too.
- Tooling is opt-in. A CDP client package is installed only after the task needs it, and only into `_scratch/`
  (never into the project dependencies, never globally). Say so in the report.
- Profiles and heap snapshots are written to `_scratch/` and deleted when the task ends; a heap snapshot can
  contain secrets from process memory, so never paste one into a report or commit it.
- Stop a debug session only by its exact PID, taken from the spawn result or from the process that listens on
  the inspector port. Never kill by image name (`node.exe`): other Forge services run as Node.
- Attaching to an already-running process is a last resort and needs confirmation that the PID is the target
  (check the inspector target list at `http://127.0.0.1:<port>/json/list`). Never attach to the live gateway
  or Command Center just to look around.

## Windows notes
- There is no `kill -SIGUSR1` on Windows. To debug a long-lived process, restart it with `--inspect` instead
  of trying to signal it.
- Quote paths with spaces. Run test files one at a time with a single worker while stepping; a worker pool
  hides the paused process from you.
- Breakpoints on TypeScript sources need source maps (`--enable-source-maps`); if a breakpoint never hits,
  check the file path, whether execution already passed the line, and the source-map behaviour.

## Pitfalls
- A process that looks frozen after you detach may still be paused in the debugger: continue before quitting.
- A breakpoint set after the code ran never fires; use `--inspect-brk` and set it first.
- The debugger changes timing. A race that disappears under the inspector is evidence about the race, not
  proof that it is gone; confirm with the feedback loop that reproduced it.

## Provenance
Rewritten in Forge words; pattern adapted, nothing copied and no code taken. Sources, read read-only through
`gh api` on 2026-11-06 and treated as untrusted data:
- `openclaw/openclaw`, `skills/node-inspect-debugger/SKILL.md`, last commit for the path `bf519333588d`
  (MIT). The NousResearch/hermes-agent copy of the same skill is MIT too (not read separately).
- Found through the corpus index (grep by name), then fetched with `gh api repos/<owner>/<repo>/contents/<path>`.
- Left out: every OpenClaw-specific command and environment variable, the POSIX signal attach, the `/tmp`
  tooling paths, the sample CDP driver script (no scripts are copied), and the `jq` pipeline.
