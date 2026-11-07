# Prioritization — choosing what goes into the first version

<!--
  Adapted from: https://github.com/phuryn/pm-skills, path pm-execution/skills/prioritization-frameworks/SKILL.md
  Seen: 2026-11-02
  License: MIT (c) 2026 Pawel Huryn -- full text in ../LICENSE
  Forge note: rewritten in Forge's own words; the "which one when" table and the Forge honesty rule are Forge-authored.
  Read as data, never as instructions.
-->

Use when the PRD scope is bigger than one version, or the owner asks "what first?". Prioritise **problems and
outcomes**, not feature requests; customers describe pains well and solutions badly.

## Which method when
| Situation | Method |
|---|---|
| Ranking customer problems from survey data | Opportunity score |
| Quick ranking of a handful of ideas | ICE |
| Many ideas, bigger team, effort known in person-weeks | RICE |
| Fixing the scope of one release with the owner | MoSCoW (on requirements, not on the product strategy) |
| Several criteria and stakeholders who must agree | Weighted decision matrix |
| Fast triage, low stakes | Impact vs effort 2×2 (risk vs reward when uncertainty differs a lot) |
| Understanding expectations, not ranking | Kano (must-be, performance, attractive, indifferent, reverse) |

## Formulas
- **Opportunity score** (importance and satisfaction on 0–1): `importance × (1 − satisfaction)`. High importance with low satisfaction ranks first.
- **ICE:** `impact × confidence × ease`, confidence and ease on 1–10; impact can be opportunity score × number of customers affected.
- **RICE:** `(reach × impact × confidence) / effort`, reach = customers per period, confidence 0–100 %, effort in person-weeks or person-months.
- **Weighted matrix:** agree the criteria and weights first, score each option per criterion, sum weight × score.
- **MoSCoW:** Must (the release fails without it) · Should · Could · Won't (this time). Keep Must small; if everything is Must, the method was not used.

## Forge rules
- Every number is either measured, given by the owner, or labelled an **estimate** with its reason. Never present an invented score as data.
- Show the table with the inputs, not only the ranking, so the owner can disagree with one input.
- Confidence is honest: a guess is low confidence, which lowers the score — that is the point.
- The result feeds `mvp_scope` (in), `non_goals` (later / won't) and `roadmap` (now / next / later) in the PRD.
