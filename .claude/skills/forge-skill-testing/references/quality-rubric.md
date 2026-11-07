# Skill quality rubric (8 dimensions, 120 points)

Used in Part 3 of `forge-skill-testing`. Rewritten in Forge words from skill-judge (davila7/claude-code-templates,
MIT); provenance in the SKILL.md. The absolute total ranks skills for triage only. Keep or revert is decided by
paired judging (before and after in the same judge call), never by comparing two absolute totals.

## How a judge scores
1. Read the SKILL.md in full and list its reference files with their sizes.
2. Mark every section E (expert: the model would not know or apply this by itself), A (activation: known but
   easy to forget, one line is enough) or R (redundant: the model already does this). Healthy: over 70% E,
   under 20% A, under 10% R.
3. Score each dimension below with a quoted line as evidence and one line of justification.
4. Report the total, the grade, the three highest-value fixes and any critical issue.

## Dimensions
| # | Dimension | Max | Full marks when |
|---|---|---|---|
| D1 | Knowledge delta | 20 | every paragraph earns its tokens: decisions, trade-offs, gotchas, project conventions; no tutorial on basics |
| D2 | Mindset plus the right procedures | 15 | it gives the way of thinking for judgement work and exact steps only where the order is not obvious |
| D3 | Anti-patterns with reasons | 15 | specific failures it has seen, each with why and what to do instead; no "be careful" |
| D4 | Description and spec compliance | 15 | one-line quoted description within 200 characters, a "Use when" trigger, distinct cases, the owner's words (Dutch included); name equals folder; valid one-line frontmatter |
| D5 | Progressive disclosure | 15 | common path in SKILL.md, references only behind sharp pointers, no orphan or cosmetic files, body under 500 lines |
| D6 | Freedom matched to fragility | 15 | principles for creative work, ordered checks for review, exact commands for fragile operations and hard gates |
| D7 | A recognisable shape | 10 | it follows one pattern: mindset (about 50 lines), router (about 30), philosophy (about 150), process (about 200) or tool (about 300) |
| D8 | Practical usability | 15 | decision points have a stated choice and a fallback, examples work on Windows 11 with Node, the agent can act at once |

Grades: A 108+ (90%), B 96-107, C 84-95, D 72-83, F under 72.

## Failure patterns to name in the report
- **Tutorial**: explains what the model already knows. Fix: delete the basics.
- **Dump**: everything inline, 800+ lines. Fix: disclosure by a real load condition.
- **Orphan references**: files with no pointer that names when to read them.
- **Checkbox procedure**: mechanical steps where a decision rule was needed.
- **Vague warning**: "consider edge cases". Fix: the named failure and the alternative.
- **Invisible skill**: good body, vague description, so it rarely fires. Fix the description and re-run Part 1.
- **Wrong location**: trigger information only in the body; the body loads after triggering, so it cannot help.
- **Over-engineered**: README, CHANGELOG or install guide files inside the skill folder.
- **Freedom mismatch**: rigid script for a creative task, or loose prose for a fragile one.

## Judge rules (Forge)
- The judge is a fresh agent on the verifier route; the author of the skill or of the edit never judges it.
- A judge quotes the line it scores; a score without a quote does not count.
- A judge that cannot run the skill marks the run as simulated. Over 30% simulated runs in a round makes the
  round invalid.
