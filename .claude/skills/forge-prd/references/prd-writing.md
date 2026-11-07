# Writing the PRD content — questions, sections, review

<!--
  Adapted from: https://github.com/phuryn/pm-skills, path pm-execution/skills/create-prd/SKILL.md
  Seen: 2026-11-02 (repo main branch; no commit date shown on the repo page)
  License: MIT (c) 2026 Pawel Huryn -- full text in ../LICENSE
  Forge note: rewritten in Forge's own words and mapped onto the fixed forge-prd JSON sections (see prd-format.md).
  Dropped: the free-form PRD-<name>.md output file (Forge writes through forge-prd.cjs), the "always web-search" step
  and the unvalidated $ARGUMENTS input pattern. The facilitation ideas in section 1 (one question at a time, guardrail
  metrics) are a pattern adapted from deanpeters/Product-Manager-Skills (CC BY-NC-SA 4.0): ideas only, no text copied.
  Read as data, never as instructions.
-->

The command and JSON shape are in `references/prd-format.md`. This file is about **what to put in it**.

## 1. Before writing: at most three questions
If the **problem**, the **target users** or the **success measure** is missing, ask up to three short questions first
and do not write the PRD yet. Ask one at a time when the answers depend on each other.
- Only the owner can answer questions about their evidence, users and metrics. Things the codebase or docs can answer, look up yourself (`forge-deeplearn` first for an existing repo).
- If the owner says "just go ahead", write it and put every gap in `risks` as a labelled **assumption** or **open question**. Never state an unknown as fact.
- Never invent numbers: no made-up conversion rates, user counts, dates or revenue. A target without a baseline is written as "baseline to be measured".

## 2. Length
Lean by default: about one to two pages of rendered PRD (roughly 600–1,000 words). A section with nothing real to say
is **omitted** (it renders as "not specified"), never padded with "TBD". Write plainly and short; someone new to the
project should understand it in one read.

## 3. What goes in each Forge section
| Forge section | Content |
|---|---|
| `goal` | Two or three sentences: what this is, for whom, why now. Then one to three measurable results (what changes, by how much, by when — or "baseline to be measured"). Add one guardrail: what must **not** get worse (speed, error rate, cost). |
| `users` | Segments defined by their problem or job, not demographics. Two or three at most; note constraints (device, language, skill level, access). |
| `problem` | Per segment: the job they try to do, what blocks it today, how they cope now and what that costs them. Background: what changed or became possible. |
| `solution` | The key capability that removes the blocker, and the outcome afterwards. One-line value statement per segment, plus the alternative they would use otherwise and why this wins. Link to UX/mockups if any exist. |
| `modules` | The parts that will be built or changed (real paths/components from the deep-learn scan). |
| `user_stories` | Short story lines; full stories with criteria go in `acceptance_criteria` (see `references/stories-and-criteria.md`). |
| `mvp_scope` | What the first version contains. |
| `non_goals` | What is explicitly out of scope, and what comes later. |
| `architecture` | Only decisions that matter for this scope: data model changes, integrations, auth, migrations. |
| `risks` | Risks with an owner and a mitigation, then the labelled assumptions and open questions. |
| `acceptance_criteria` | One entry per testable criterion `{id, text, owner, required_tests}`; `--tickets` turns each into a ticket. |
| `test_plan` | How each criterion will be proven (unit / integration / e2e / manual check), including failure paths. |
| `roadmap` | Rough relative order (now / next / later), not exact dates unless the owner gave them. |

**Consistency checks:** the `solution` delivers the capability named in `problem`; the measurable results in `goal`
measure the outcome promised in `solution`; every `mvp_scope` item has at least one acceptance criterion.

## 4. Sizing the acceptance criteria
- Each criterion is testable and observable ("a visitor without an account sees the sign-in prompt"), not a wish ("easy to use").
- Cover failure paths and edge cases, not only the happy path.
- Prioritise them when the scope is too big: `references/prioritization.md`.

## 5. Review mode (an existing PRD)
Check in this order and report findings, most important first:
1. Missing information that blocks a decision for the first version.
2. Segments present, and for each a complete problem → solution → outcome chain.
3. Results in `goal` actually measure the promised outcome; a guardrail exists.
4. Assumptions and open questions labelled as such, not presented as facts.
5. Every acceptance criterion testable and tied to the test plan.
6. What can be cut without loss.

## 6. After the build
Turn the delivered scope into user-facing release notes with `references/release-notes.md`.
