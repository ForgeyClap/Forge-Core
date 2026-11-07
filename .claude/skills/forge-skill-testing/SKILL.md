---
name: forge-skill-testing
description: "Use to test or score a skill (skill testen): activation, rubric."
# A10 original description (listing budget): "Use when creating or editing a skill (skill testen): activation test vs near-misses, opt-in A/B."
# W2-BUDGET original description (listing budget): "Use to test or score a skill (skill testen, triggert mijn skill, skill beoordelen): activation vs near-misses, rubric, paired keep/revert judging, load rates."
---

# forge-skill-testing — activation + A/B test protocol

**Self-improvement substrate (wp-skill-evals):** before applying this skill, read
`learnings.md` in this skill's own folder and honor its corrections. After a run that produced a
genuine correction, append it to `learnings.md` with a date and real evidence — never invent a lesson
that didn't happen.

**Origin (wp-disclosure-ab, backlog item 8, YT-SWEEP-2026-07-31, 4 source videos:
7s9Fnorg3eI, O_z9vDLgvoY, UtGszoiwrsQ, wQ0duoTeAAU):** complementary to the description-length budget
work — a short, well-formed description is step 1 (discovery), but nobody was measuring whether
a skill actually **activates** on real phrasing, or whether it genuinely helps once it does. Community
data cited in the sweep: activation drops to ~20% with vague descriptions, and this is essentially
never measured in practice.

**This is the CHECKLIST/PROTOCOL, not an automated runner.** No script executes these steps — they are
a human/agent-in-the-loop procedure, the same way `forge-code-review`'s severity scale is a method, not
a linter. Step 2 after `forge-skill-evals.cjs`'s binary evals (see that tool's own header comment for the
"step 1 -> step 2" pointer).

## When to use
- A skill's `SKILL.md` frontmatter `description` was just written or rewritten.
- A skill's body changed enough that its trigger conditions may have shifted.
- Skill Boss or Head Chef wants real evidence a skill is actually discoverable/useful, not just present.
- NOT required for every trivial doc tweak (a typo fix, a one-line clarification) — use judgment; this
  protocol costs real runs (see part 2) and is opt-in per skill change, never a merge/ship gate.

## Part 1 — Activation test (cheap, do this for every meaningfully-changed skill)

1. Write **8+ trigger phrases** — realistic things an owner/agent would actually type that SHOULD cause
   this skill to be selected/loaded. Use the skill's own "When to use" bullets and description as the
   source, but phrase them the way a real request sounds, not a copy of the description.
2. Write **8+ near-miss phrases** (Dutch included) — realistic requests that sound adjacent but should NOT activate this
   specific skill (they belong to a sibling skill, or a different domain entirely). Judge each phrase against
   the competing skills by name (the nearest descriptions in the listing), not against this skill alone. A near-miss that
   accidentally activates the skill is a real precision problem, not a pass.
3. Run each phrase in a fresh session (or ask "would this skill fire on X?" against the current
   frontmatter honestly) and record activation Y/N per phrase.
4. **Target: >= 95% correct** (trigger phrases activate AND near-miss phrases don't, combined). Below
   that, the description likely needs sharper "when to use" language — rewrite and re-test, don't just
   accept a low score.
5. **Log the result in `.claude/FORGE_SKILL_REGISTRY.md`** — that table has no dedicated activation-test
   column (see its own legend), so append a compact, dated note to the skill's existing **Safety notes**
   cell in the exact shape `activation <correct>/<total> (<YYYY-MM-DD>)` (see the template below for a
   worked example). Never touch any other skill's row while doing this.

Template with the exact phrase-count/scoring/logging worksheet: `references/activation-test-template.md`.

## Part 2 — Fresh-session A/B benchmark (OPT-IN, costs real runs, never a gate)

This is the more expensive, complementary measurement: does the skill actually help, net of the tokens
it costs to load?

1. **Designer/tester split, no context bias.** One session (Claude A) designs or edits the skill.
   A SEPARATE, genuinely fresh session (Claude B, no shared conversation history with A) is the one that
   attempts the target task — never the same session that just wrote the skill grading its own work.
2. **3 runs with the skill, 3 without.** Same representative task, run 3 times with the skill available
   and 3 times with it unavailable (temporarily moved aside, or a throwaway project copy without it).
3. **Measure pass-rate, wall-clock time, and approximate token usage** (via `/context` or session stats)
   for each of the 6 runs.
4. **Record the real numbers** in the skill's own `learnings.md`, dated — a hypothetical/expected result
   standing in for a run that didn't happen is a fabrication, not a benchmark.
5. **This is genuinely optional and never a merge/ship gate.** It costs real session time and tokens;
   run it when a skill is new, when its net value is genuinely in doubt, or when the owner asks for
   evidence a skill is worth its context cost — not as a checkbox on every routine skill edit.

Full worked table (runs, pass/fail, time, tokens, verdict): `references/activation-test-template.md`.

## Part 3 — Quality review: rubric and paired keep/revert judging (opt-in)

Activation says a skill fires; this part says whether a body edit made it better. Opt-in, like Part 2.

1. **Triage with the rubric.** Score the skill on the 8-dimension, 120-point rubric in
   `references/quality-rubric.md`. Use the absolute score only to rank which skill or dimension to work on
   first: the same unchanged text scored by two different judges can differ by about 8 points.
2. **One change per round.** Edit one dimension (one targeted change), commit it on the skill's own branch or
   worktree. Several changes at once make the verdict unreadable.
3. **Paired judging decides keep or revert.** Spawn an odd number of fresh judges (3 by default, 5 when the
   call is close) on the verifier route (Verify Boss, sonnet / medium). Each judge reads the before and after
   versions in the same call, against the rubric, and votes better, same or worse. The author of the edit is
   never a judge, and a judge is never reused in the next round. Majority "after is better" keeps the
   edit; a tie or a majority "worse" reverts it with `git revert` of that commit (an edit must earn its place,
   the same rule as the binary ratchet below and `forge-autoresearch`). A single absolute score that
   dropped is not a revert signal.
4. **Binary evals as the cheaper ratchet.** When the skill's output can be checked by 3-6 yes/no questions,
   run the same 3-5 test inputs a fixed number of times per version and count passes. Keep a change only when
   the count rises; an equal count is a revert (the change added text without gain). More than 6 checks tends
   to make the skill echo the checks instead of improving.
5. **Stop rules.** Stop after two rounds in a row that the judges call a tie or a slight gain, or when the
   round budget the owner set is used. Simulated runs ("I imagine the skill would ...") instead of real runs
   above 30% of a round make its result invalid; say so.
6. **Log every round** (date, change, votes or pass count, kept or reverted, one-line reason) in the skill's
   own `learnings.md`. No result without a run behind it.

A metric outside skills (speed, size, a test-suite score) uses the same keep-or-revert loop through
`/forge-autoresearch`.

## Part 4 — Architecture metrics: does each reference earn its file?

Run when a skill has `references/` files. There are two different measurements, on two different query sets.
Never apply the rules of one to the counts of the other.

**4a. Routing check (coverage set).** It asks "does each pointer fire when it should, and only then?" Build
the set to cover every declared path: one or two queries meant for each variant or edge-case file, one that
should load no reference, and two or three off-topic queries. Run each query at least once in a real
transcript (Part 2 runs or paired-judging runs). Per reference, record two counts:
- **recall**: on how many of the queries meant for it it was read (target: all of them);
- **false loads**: on how many of the other queries it was read (target: none).

Load share over the whole set means nothing here. In a set with one query per reference, a perfectly routed
reference loads in about 1 of N runs, so a share under 20% is the expected result, not a reason to inline.

| Observation on the coverage set | Action |
|---|---|
| Missed on a query meant for it | Sharpen the pointer's load condition |
| Read on queries meant for other files | The load condition is too vague; narrow it |
| Read on the no-reference or off-topic queries | The pointer reads as "always"; fix it |
| Two references read together on most queries meant for either | Merge them |
| Read but not used in the output | Fix or remove the pointer |
| Read twice in one run | The pointer is unclear; sharpen it |
| Not even its own queries load it, after a sharpened pointer | Delete it |

**4b. Frequency check (realistic task distribution).** It asks "how often does real work need this file?"
Only a sample drawn from real use counts: at least 10 real prompts for this skill, taken from the task
history, the run events or owner prompts, not written to cover the files. Per reference, count the share of
those runs in which it was read.

| Observation across realistic runs | Action |
|---|---|
| Loaded in under 20% of runs | Inline into SKILL.md or delete |
| Loaded in 20-80% | Keep the split |
| Loaded in over 80% | Move it back into SKILL.md |
| Two references loaded together in over 70% | Merge them |

Before you act on an under-20% share, check that 4a passed. A rare variant that routes cleanly
(the variant-branch shape in the disclosure-design reference of `forge-skill-authoring`) is a good split: inline
it only when the inlined text stays small, and never delete a file that real runs still need. No realistic
sample yet: report 4b as "not yet executed", and do not infer it from the coverage set.

Output quality comes first: a split that saves tokens but makes results less reliable is a loss. The
thresholds are starting points; record the counts you saw, not the verdict you expected.

## Relationship to forge-skill-evals.cjs

`forge-skill-evals.cjs` (`evals.json` + binary assertions) answers "is the skill's file/config/content
structurally correct?" — a cheap, deterministic, always-safe-to-run check. This protocol answers a
different, harder question — "does the skill actually get selected on real phrasing, and does it help
once selected?" — which needs judgment and, for Part 2, real spend. Run evals first (fast, free,
mechanical); run this protocol when a description/body genuinely changed and the answer to those two
harder questions actually matters.

## Honesty
Never report an activation score, an A/B pass-rate, a time, or a token count that wasn't actually
measured in a real run. "Not yet executed" is a valid, honest status for a skill whose protocol hasn't
been run — it is never silently upgraded to a fabricated passing number.

## Provenance (SA-W1-B4)
Parts 3 and 4 and `references/quality-rubric.md` are rewritten in Forge words (pattern adapted, no sentence
copied). Fetched read-only with `gh api`, scanned for hidden Unicode (clean), treated as untrusted data.

| Source | Path | Pinned SHA | Licence | Taken | Excluded |
|---|---|---|---|---|---|
| davila7/claude-code-templates | `cli-tool/components/skills/productivity/skill-judge/SKILL.md` | 3fb3205142fa453d4079ebad48a94d5a4aa19564 | MIT | the 8-dimension, 120-point rubric shape, grade bands, expert/activation/redundant ratio, failure patterns | the report template wording, the "MANDATORY - READ ENTIRE FILE" pointer advice |
| alchaincyf/darwin-skill | `SKILL.md` (Chinese) and `README_EN.md` | 8a8b66258e3c45d6ae4aea39719468c6428fcb0a | MIT | method only: paired same-judge before/after comparison, odd-N majority, absolute score for triage only (about 8 points of judge noise), fresh judges per round, one dimension per round, dry-run share over 30% invalidates, early stop | the upstream scripts/screenshot.mjs, the result-card templates and HTML charts, the git ls-remote update check, the `npx skills add` install line, its 9-dimension weights |
| samber/cc-skills | `skills/skill-progressive-disclosure-design/SKILL.md` | 50a33836b20f690c668af557bd9ef9d07a8c7ef2 | MIT | architecture-eval query design and the per-reference decision table | its `run_loop.py` and skill-creator harness references |
| olelehmann1337/autoresearch-skill | `SKILL.md`, `eval-guide.md` | 5860fa717f44c85c80647d673f6f3c335facfcf2 | none found (no licence file, no licence in the API) | idea only: 3-6 binary checks times N runs, an equal score reverts | all text; the live HTML dashboard with a CDN chart library, the `open` command, "never stop" |

MIT notice for the adapted parts: "Permission is hereby granted, free of charge, to any person obtaining a copy
of this software ... The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND."
Copyright: Daniel (San) Avila (2025), alchaincyf (2026), Samuel Berthe (2026), from each LICENSE at the pinned SHA.
