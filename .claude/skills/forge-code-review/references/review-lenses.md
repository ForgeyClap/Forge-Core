# Review lenses, confidence filter and the deep security pass

Detail for `forge-code-review`. The helper is
`.claude/forge-bin/forge-review-score.cjs`: zero dependencies, read-only on the repo, and the only file it
writes is the one named by `--out`. Exit codes: 0 ok, 1 refused or bad input, 2 usage.

## The flow in one review

1. `git diff <base>...HEAD > _scratch/review.diff` (or pipe the diff with `--diff -`).
2. `node .claude/forge-bin/forge-review-score.cjs scan --diff _scratch/review.diff --out _scratch/cand.json`
3. `node .claude/forge-bin/forge-review-score.cjs coverage --diff _scratch/review.diff --root . --out _scratch/cov.json`
4. The reviewer reads every candidate in the real code, deletes the ones that are wrong, and adds its own
   findings from the fixed review order. Result: `findings.json` (`{"reviewer": "...", "findings": [...]}`).
5. A different agent scores each finding (below) into `scores.json`.
6. `node .claude/forge-bin/forge-review-score.cjs filter --findings findings.json --scores scores.json --format md`
   gives the table for the report; the `dropped` list goes in the report too (one line each).

Each finding: `id`, `lens`, `severity`, `file`, `line`, `title`, `evidence`. The scan and coverage
output already have this shape and can be passed to `filter` as they are.

## Lens: swallowed errors

The question: "if this fails in production, will anyone ever find out?"

| What to look for | Why it hurts |
|---|---|
| empty `catch {}` / `except: pass` / empty `if err != nil {}` | the failure leaves no trace at all |
| `.catch(() => [])`, `catch { return null }`, `return nil` on an error | the caller cannot tell "no data" from "broke" |
| a re-throw that keeps only `err.message` (no `cause`, no `raise ... from`) | the stack that says where it broke is gone |
| a network, file or database call with no timeout | one slow server freezes the whole run |
| a transaction with no rollback path | a half-written change stays behind |
| `|| true`, `set +e`, `-ErrorAction SilentlyContinue` | a script reports success after a failed step |

Forge domain additions:
- **n8n**: a node with `continueOnFail` / `onError: continue...` and no error branch after it; a workflow
  with no `settings.errorWorkflow`. Failures should reach an error workflow that alerts someone.
- **Scrapers**: a loop that catches and `continue`s without counting or logging the skip; a retry loop with
  no maximum or no backoff; requests with no `timeout=`.
- **Bots and webhooks**: a handler that answers `200 OK` from its error path, so the sender never retries
  and the event is lost; a webhook error that is logged but never surfaced.

Not a finding (false friends): an optional `require` wrapped in a try that falls back on purpose and says so
in a comment; a catch that logs with context and re-throws; a cleanup `finally`; a `|| true` on a command
whose failure genuinely does not matter, with a comment saying why. Reject these candidates.

The pre-scan is line-based. It misses errors swallowed across functions and can flag a deliberate
fallback. Confirm each candidate by reading the code; never report a candidate unread.

## Lens: behaviour coverage

The question: "which changed behaviour would break silently, because no test would notice?"

- List the changed functions. For each, look for a test that **asserts** its behaviour, not just one that
  imports the file.
- Rate the gap by criticality: **high** = auth, tokens, payments, webhooks, deletes, migrations,
  permissions, crypto; **medium** = API routes, handlers, database writes, parsing, validation, sync;
  **low** = formatting and internal helpers.
- A high gap is a HIGH finding; a medium gap MEDIUM; a low gap usually LOW or dropped.

The helper is a heuristic and says so in its output (`"heuristic": true`): it matches names in test files
(`covered: diff-test | existing-test | file-test-indirect | none`). A test that only mentions the name may
not assert anything, and a test that calls the function through another name is missed. Without `--root`
it does not look at existing tests at all, and it lists every test file it could not read.

## Confidence scoring (the second pass)

The scorer is a different agent from the reviewer (the tool refuses a scores file whose `scorer` equals
the findings' `reviewer`). It reads the code again for each finding and gives one integer 0-100:

| Score | Meaning |
|---|---|
| 90-100 | verified in the code: the failure path is real and reachable |
| 80-89 | very likely real; one assumption left, named in the reason |
| 50-79 | plausible but unproven, or only matters in an unusual setup |
| 0-49 | style, taste, a guard already handles it, or wrong |

`scores.json`: `{"scorer": "verify-boss", "scores": {"<id>": {"confidence": 92, "reason": "..."}}}` (a bare
number is accepted too). A finding without a score is dropped with the reason "no independent score"; an
invalid score is dropped as invalid; a score for an unknown id is listed under `orphan_scores`. The
counts always add up: `in = kept + dropped`.

## Deep security pass (on request only)

Costs one model call per finding at least, so it runs only when asked. The tool does not run it.

1. **Collect.** Security Boss lists findings for the changed scope (same shape as above, `lens: "security"`).
2. **Try to disprove.** One fresh verifier agent per finding, read-only, gets only the finding and the code.
   Its job is to break the finding: find the guard that already stops it, show the input cannot reach it,
   or show the impact is lower. It answers `upheld` or `refuted` with file:line evidence.
3. **Score.** Upheld findings get their confidence from the verifier's evidence; refuted ones go to
   `dropped` with the refutation as the reason. Then the normal `filter` step runs.
4. **SARIF.** Write the kept findings as SARIF: one `run` with `tool.driver.name` = "forge-review",
   `rules[].id` = the finding rule, `results[]` with `ruleId`, `level` (CRITICAL/HIGH -> `error`,
   MEDIUM -> `warning`, LOW -> `note`), `message.text` = title + reason, `locations[].physicalLocation`
   (`artifactLocation.uri` = file, `region.startLine` = line), and `properties.confidence`.
5. **Patches go to a scratch copy only.** A proposed fix is made in a copy (`_scratch/` or a separate git
   worktree), never in the working tree, and handed over as a diff. It becomes real only through the
   normal Build Boss -> Test Boss -> Review Boss loop.
