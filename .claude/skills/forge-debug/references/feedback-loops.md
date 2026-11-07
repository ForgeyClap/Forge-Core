# forge-debug — Building the feedback loop

The loop is most of the work. With one command that goes red on *this* bug, bisecting, testing hypotheses
and instrumenting all become mechanical. Without it, reading code only produces theories. Spend real
effort here before anything else.

## Ways to build one (try roughly in this order)
1. **A failing test** at the seam that reaches the bug: `node --test path/to/x.test.cjs`,
   `npx vitest run path/to/x.test.ts`, `npx playwright test path/to/x.spec.ts`.
2. **An HTTP probe** against the running dev server: a small Node script in `_scratch/` using `fetch`, or
   PowerShell `Invoke-WebRequest -UseBasicParsing`, asserting on status and body. Credentials come from
   env vars, never typed into the command.
3. **A CLI call with a fixture input**, diffing stdout against a known-good file
   (`node cli.cjs --in fixture.json > _scratch/out.txt` then `git diff --no-index expected.txt _scratch/out.txt`).
4. **A headless browser script** (Playwright) that drives the UI and asserts on the DOM, console errors or
   network responses.
5. **Replay a captured artefact.** Save one real request, payload, webhook body or event log (redacted) to
   `_scratch/` and feed it through the code path in isolation.
6. **A throwaway harness.** The smallest slice of the system (one module, dependencies mocked) that
   reaches the bug with one function call. It lives in `_scratch/` and is deleted afterwards.
7. **A property or fuzz loop.** For "sometimes wrong output": run 1000 generated inputs with a fixed seed
   and keep the first failing one.
8. **A bisection harness.** When the bug appeared between two known states (commit, dataset, version),
   make the check a script that exits 0/1 and run `git bisect run node _scratch/repro.cjs` in its own worktree (never the shared tree).
9. **A differential loop.** The same input through the old and new version, or two configs, and diff.
10. **Human in the loop, structured.** Last resort, when a person must click: write a numbered checklist
    (step, what to look at, what to paste back) and ask the Lead to relay it. The pasted result feeds the
    loop. No shell template is needed for this.

## Tighten it
Treat the loop as a product:
- **Faster:** cache setup, skip unrelated init, run one file or one test name.
- **Sharper:** assert the exact symptom (the message, the wrong value, the timing), not "did not crash".
- **Deterministic:** fake or pin the clock, seed random, use a temp directory per run, mock the network,
  set `TZ`/locale explicitly when dates are involved.

A 30-second flaky loop is barely better than none; a 2-second deterministic one is what you want.

## The loop is done when
You can name one command, already run at least once (show the command and its redacted output), that is
red-capable, deterministic, fast and agent-runnable. No such command means no hypothesis phase yet.

## Non-deterministic bugs
The goal is a higher reproduction rate, not a perfect repro. Loop the trigger many times, run in parallel,
add load, narrow the timing window. A PowerShell loop around one test:

```powershell
$fails = 0; 1..50 | ForEach-Object { node --test path/to/x.test.cjs *> $null; if ($LASTEXITCODE -ne 0) { $fails++ } }; "failed $fails/50"
```

Record the rate before and after the fix; a fix for a race that was never reproduced is not credible.
A test that passes and fails on unchanged code: classify it first with
`forge-testing` → `.claude/skills/forge-testing/references/flaky-tests.md`.

## Performance regressions
Logs usually mislead here. Establish a baseline first (`performance.now()` around the hot path, a timing
script run several times, `node --cpu-prof`, the database query plan), then bisect between a fast and a
slow state. Measure first, fix second, measure again with the same harness.

## When no loop can be built
Stop and say so. List what you tried. Ask the Lead for one of: access to the environment that reproduces
it, a redacted artefact (log dump, HAR file, screenshot or recording with timestamps), or permission for
temporary instrumentation. Do not move on to hypotheses without a loop.
