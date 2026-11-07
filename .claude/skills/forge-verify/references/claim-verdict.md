# Claim verdict — packet, judgement and rules

Reference for `forge-verify.cjs --claim`. The code is the source of truth:
`stripNarrative()`, `parseRunnerOutput()`, `findHedges()` and `assessClaim()` in
`.claude/forge-bin/forge-verify.cjs`. The four verdict words live in `forge-report.cjs` (`VERDICT_GRADES`).

## The input file

One JSON object. Everything except `judgement` is the packet.

```json
{
  "work_package": "WP-12",
  "artifact": ["src/parser.cjs"],
  "acceptance_criteria": ["parses the tally", { "id": "ac-2", "text": "rejects an absent test" }],
  "runner_output": "<the literal output of the command YOU re-ran>",
  "claimed_tests": ["parses the tally"],
  "report": "<the builder's raw final message, or its forge-report object>",
  "judgement": {
    "criteria_results": [
      { "id": "ac-1", "status": "met", "evidence": "runner line: ok  parses the tally" },
      { "id": "ac-2", "status": "met", "evidence": "runner line: ok  rejects an absent test" }
    ],
    "break_attempt": {
      "property": "a test name that says '3 passed' is never read as the tally",
      "tried": "fed such a line to the parser",
      "counterexample_found": false
    }
  }
}
```

- A criterion given as a plain string gets the id `ac-<n>` (1-based), the same fallback the PRD checks use.
- `--runner <file>` replaces `runner_output` with the file's text, so you can save the re-run output and
  pass it as is.
- Instead of judging, `judgement.abstain: "<reason>"` gives NO-CONFIDENT-RESULT. Use it when you cannot
  reproduce the environment; never guess.

## What is stripped

Only `work_package`, `artifact`, `acceptance_criteria`, `runner_output` and `claimed_tests` survive. Every
other packet field (summary, notes, narrative, reasoning) and, from the report, everything except
`status`, `work_package`, `files_changed`, `tests_run` and `claimed_tests` is dropped, plus all prose
around the forge-report block. The dropped field names are listed in `stripped`, so the verdict can say
what it refused to read.

## Claimed tests

The claimed test names are collected from three places: the packet's `claimed_tests`, the report's
`claimed_tests`, and any name in double quotes or backticks inside the report's `tests_run` that is not a
command or a file path. A claimed name counts as having run only when the runner output shows it (an exact
match, or contained in a longer test name; at least 4 characters). When the output has no per-test lines,
only a tally, the raw text is searched, and a name that cannot be seen there is absent.

## Runner formats understood

| Format | Test lines | Tally |
|---|---|---|
| node:test TAP | `ok 1 - name`, `not ok 2 - name` (`# SKIP`/`# TODO` ignored) | `# pass N`, `# fail N` |
| node:test spec | check mark / cross mark + name (`failing tests:` summary not counted twice) | `ℹ pass N`, `ℹ fail N` |
| Forge tests | `  ok  name`, `  FAIL name` | `N passed, M failed` |
| other runners | — | `N passed, M failed` or `M failed, N passed` |

Output that matches none of these is `unknown`. It is never read as green.

## Decision order

1. **NOT-PROVEN** when any of these holds: the runner reports failures, a claimed test is absent, a
   claimed test failed, a done-claim hedges, a criterion is `unmet`, or the break attempt found a
   counterexample. A finding that proves the claim false beats an abstention.
2. **NO-CONFIDENT-RESULT** when the verifier abstains, or the packet has no artifact or no criteria.
3. **PARTLY-PROVEN** when there is a proof gap: the runner output is unknown or shows no passing test, there
   is no break attempt (with a named property and an explicit `counterexample_found` true or false), or a
   criterion is not judged, is `unknown`, or is `met` without evidence.
4. **PROVEN** only when none of the above applies.

## Hedge words (done-claims only)

Checked in the report's `evidence` and `tests_run`, in the prose around the block, and in the packet's
`summary`/`narrative`, but only when the report claims `completed` (or gives no status). `blockers`,
`next_action` and `result_caveat` describe the future or a condition, so they are not checked.

- English: should work / should pass / should be fine, probably, presumably, hopefully, likely fixed,
  I think, I believe, seems to work, might work, in theory.
- Dutch: zou moeten, waarschijnlijk, vermoedelijk, hopelijk, wellicht, lijkt te werken, denk ik,
  in principe, als het goed is.

A bare "likely" is not a hedge. Real evidence quotes tool diagnoses such as "(backfill likely missed)".

## Logging the verdict

Log the GATE word, not the grade, in `wp_verified.verdict`, and put the grade in the evidence:
`"verdict":"NEEDS_MORE_EVIDENCE","evidence":"PARTLY-PROVEN: no break attempt ..."`. Only `PASS` closes
the rule `wp-verified-per-wp`, and only `FAIL` asks for the single escalation (`escalation-one-per-fail`).
A verifier's own forge-report block may carry `"verdict": "<grade>"`; `forge-report.cjs` rejects any
other word.

## Higher risk

On a high-risk package, when the claim rests on a test suite, run a mutation pass on the touched module
(`node .claude/forge-bin/forge-mutate.cjs <module> --sample 20`, which writes its mutants to the OS temp
folder). A surviving mutant means the tests do not pin the logic, so the claim is at most PARTLY-PROVEN.
