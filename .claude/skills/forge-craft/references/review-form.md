# Filling the craft review form well

Print the form with `node .claude/forge-bin/forge-craft.cjs review-template --type <type>` (or
`--deliverables "a,b"`, or `--domain <d>`). Add `--json` when a tool will read it back.

## Order
1. **First ten seconds, cold.** Answer the lens's first-ten-seconds questions before you read any check.
   Write what you actually saw, not what the code is meant to do.
2. **Per stakeholder, two lines.** "Would notice in the first ten seconds" and "would notice on closer
   inspection". Name concrete things ("the Install section gives no command for a new machine"), not
   virtues ("clear", "clean").
3. **Per check: mark, evidence, finding, fix or weakness.** Evidence is a path or a command with its exit
   code: `shots/home-360.png`, `node x.cjs --help (exit 0)`, the rendered e-mail text. "Looked at it" is
   not evidence.
4. **Stated weaknesses.** Everything not fixed: what it is, who would notice, why it is not fixed now.
5. **Count.** Block checks marked DEFECT or NOT_INSPECTED: any above zero means not done.

## Marks
- CLEAN: inspected, evidence attached, nothing the stakeholder would notice.
- DEFECT: something the stakeholder would notice. Fix it and inspect again, or state it.
- NOT_INSPECTED: the evidence could not be produced (no browser, no clean machine, no account). Say why.
  On a block check this is honest, and it still means not done.
- N/A: the check does not apply (a page without forms). Give the reason in a few words.

## Record it (the run contract reads it)
A run that declares a visible deliverable type (run.json `deliverable_types`: web-ui, copy-and-content,
documents-and-spreadsheets, game-and-interactive, voice-and-chat or cli-and-devtools) is not done until each
type has a recorded review: contract rule `craft-review-recorded`.
1. `node .claude/forge-bin/forge-craft.cjs review-template --type web-ui --json > review.json`, then fill it.
2. `node .claude/forge-bin/forge-craft.cjs record --run <run_id> --type web-ui --file review.json` stores
   `craft-review-web-ui.json` in the run folder and logs one note. It never marks anything itself.
3. `node .claude/forge-bin/forge-craft.cjs check --run <run_id>` re-reads what was recorded.

`record` refuses the form (exit 3, nothing written) when: a check has no mark; a block check is
NOT_INSPECTED (honest, but not done: report it as not done instead); CLEAN has no evidence; N/A or a warn
NOT_INSPECTED has no reason in `finding`; a DEFECT has no `finding`, or no `fix_or_weakness` shaped as
`{"fix": "...", "evidence": "..."}` or `{"weakness": "...", "reason": "..."}`; a stakeholder or check is
missing; the form was printed from another lens version; no block check was inspected at all. Evidence,
findings and reasons need at least 8 characters.

The rule passes for a type only when the record is untampered (its hash still matches), belongs to this run
and holds no unresolved block DEFECT. An accepted weakness on a block check stays unresolved: fix it, add the
fix and its evidence, record again. If a type was declared by mistake, log the exception instead:
`decision_logged {"rule":"craft-review-recorded","decision":"not-applicable","deliverable_type":"web-ui","reason":"..."}`.
It shows up in the contract's `exceptions` and never replaces a review that was recorded.

## Pitfalls
- A quick search that finds nothing is not proof that something is missing: check the real file or run
  the real command before you file a DEFECT. A false alarm costs the same trust as a missed defect.
- Do not soften a block DEFECT into a warn because it is quick to fix. Fix it instead.
- Do not mark CLEAN for a breakpoint, state or platform you did not actually look at.

## Worked example (from the real replay of Forge's own install guide)
Lens `documents-and-spreadsheets`, stakeholder `reader` (a beginner on a new machine).
- First ten seconds: clear title and date; a prerequisites table with a check command per tool.
- Closer inspection: route A, the only route for a new machine, names the public repository but gives no
  link and no command, and ends with "follow that repository's own README".
- `exact-steps` (block): DEFECT. Evidence: section 2, route A. Finding: the reader cannot start from this
  page. Fix: add the repository link and the two install commands, or state the gap plainly in the hand-off.
- `fresh-machine` (block): NOT_INSPECTED, because no clean machine was available in that session.
- Count: 2 block checks open, so the page is not done.
