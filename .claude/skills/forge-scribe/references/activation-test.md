# forge-scribe — activation-test fixture (forge-skill-testing part 1)

**Skill under test:** `forge-scribe`
**Date:** 2026-10-10
**Tester / method (stated plainly):** the authoring build agent, using the protocol's
"ask *would this skill fire on X?* against the current frontmatter" method. This is a frontmatter
judgement, NOT a fresh-session run: a fresh-session confirmation is still **not executed**. Score
below is therefore a judgement score, never to be logged as a measured fresh-session result.

Sibling skills the near-misses are aimed at: `forge-prd`, `forge-snapshot`, `mem-search`,
`forge-code-review`, `forge-intake`.

## Trigger phrases (SHOULD activate)

| # | Phrase | Activated? | Notes |
|---|--------|-----------|-------|
| 1 | onthoud dit: de header moet donkerblauw worden | Y | literal trigger "onthoud dit" |
| 2 | wat wilde ik ook alweer voor de contactpagina? | Y | literal trigger |
| 3 | ik heb nog een wijziging: het logo moet groter | Y | literal trigger |
| 4 | note my change: drop the pricing table | Y | literal trigger |
| 5 | scrap that last request, I don't want the blog anymore | Y | "scrap that" (cancel path) |
| 6 | which of my wishes are still open? | Y | "open wishes" |
| 7 | did I ask that already, or is it new? | Y | "did I ask that" |
| 8 | did you miss anything I asked earlier this week? | Y | ledger / "every ask kept" semantics |

## Near-miss phrases (should NOT activate)

| # | Phrase | Activated? | Correct owner |
|---|--------|-----------|---------------|
| 1 | schrijf een PRD voor de login-feature | N | forge-prd |
| 2 | maak een snapshot van de missie voor compaction | N | forge-snapshot |
| 3 | hoe hebben we dit vorige keer opgelost? | N | mem-search |
| 4 | review my code changes before I commit | N | forge-code-review |
| 5 | help me turn this vague idea into a buildable request | N | forge-intake / forge-prompt-coach |

**Judgement score:** 13/13 (100%, target >= 95%) — frontmatter judgement only; fresh-session
measurement not executed. Not logged in `FORGE_SKILL_REGISTRY.md` (that file is outside this work
package's write scope); the Lead or Skill Boss logs it once a fresh-session run confirms it.

**Known precision risk:** a prompt that is itself a *new build request* ("bouw een contactformulier")
is captured by the hook regardless of skill activation; the skill only needs to fire when the
owner explicitly talks about their earlier asks or a change to them.
