# forge-token-economy: full-output enforcement

Short answers are the default. This file covers the opposite case: the owner wants the whole thing.

## When it applies
It fires only when full output is asked for or the output tier is **Full**: a complete copy-paste prompt, a
whole file, a client deliverable, a complete report. It never makes a normal answer longer. The tiers come
from the owner's `TOKEN_EFFICIENCY_GLOBAL_POLICY.md` (read only, not edited here):

| Tier | Meaning | This file |
|---|---|---|
| Tiny | 1-5 lines | does not apply |
| Standard | concise status and next step | does not apply |
| Full | complete prompt or deliverable, never truncated | applies |
| Audit | detailed, evidence-backed | applies to the evidence: no gaps in what is reported |

In the Full tier completeness beats brevity, and the policy says so too.

## The rule
The answer contains every part the owner asked for, written out.
- No `...` or ellipsis standing in for content.
- No "rest unchanged", "same as above", "and so on", "etc." in place of items.
- No `// existing code`, `# TODO`, `<insert here>` or empty placeholder sections.
- No silent truncation, no summary where the text was requested, no "I shortened this".
- A whole file means the whole file, first line to last, not a diff, unless a diff was asked for.
- Do not ask permission first ("shall I write it all out?") when the request was already clear.

## When it does not fit
If the content cannot fit in one reply:
1. Say up front how many parts there are: "Part 1 of 3".
2. Split at natural boundaries (section, file, function), never mid-sentence or mid-block.
3. Each part ends with the exact label of what comes next; the last part says it is the last.
4. Never end a part with a vague promise. If a limit stops the answer mid-way, say so, say what is missing
   and continue from exactly there.

## Check before sending
Scan the draft for the banned patterns above, count the requested items against what is written, and for code
confirm every function that is mentioned is also present. Deliberate ellipses inside quoted source text or
sample output are fine when they belong to that text.

## What it must not become
It does not change the Standard tier, does not add padding, repeated sections or restated policies to look
complete, and does not override safety, secret handling or owner approval gates. Complete means complete,
not longer.

## Provenance
Checked 2026-11-06, read-only. The brief named a skill `full-output-enforcement` in a "taste-skill" repository.
- `Leonxlnx/taste-skill` (identity: HIGH_CONFIDENCE, licence MIT per the GitHub licence endpoint). Its README
  changelog says `full-output-enforcement` was **removed** and points to `Leonxlnx/unlazy` (MIT). The skill file
  is not in the current tree, so no source text for this skill was read.
- `Leonxlnx/unlazy` (latest commit 16671491 at check time) was identified but not used.

Label: FORGE_NATIVE_ORIGINAL (BEHAVIOR_REIMPLEMENTED from the owner's brief and the Full tier of the owner
policy). No text from either repository was copied. If the old file is wanted as a source, read it from the
repository history first and recheck its licence.
