# Lean lens for a code review

Forge wording, adapted from DietrichGebert/ponytail `.openclaw/skills/ponytail-review/SKILL.md`
(SHA `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`, MIT, Copyright (c) 2026 DietrichGebert).

`forge-code-review` owns the review: its fixed order (correctness, security, tests, simplicity,
performance, style) and its severity scale decide what blocks. This file only sharpens the
**simplicity** step. A lean finding is never more important than a bug or a security issue.

## Lean finding kinds
| Kind | Means | Example fix |
|---|---|---|
| delete | Dead code, unused options, speculative features | Remove it; name what it was for |
| reuse | The repo already has this helper | Point to the exact path and use it |
| stdlib | The standard library or platform already does it; or a new dependency for a few lines | Replace with the built-in |
| yagni | An abstraction with one implementation, config nobody sets | Inline it |
| merge | Near-copies that must change together | One shared function |
| split | One function doing several unrelated jobs | Split by job — never by line count, never into helpers that exist only to shorten a function |

## Before you report a lean finding
- Give a concrete case ("this option is never set anywhere: grep shows 0 callers"). No case, no finding.
- Re-read the lines: the code really is unused, the helper really does the same thing.
- A `shortcut:` comment that names its limit is a deliberate choice, not a finding — unless the limit is
  already reached.
- Removing code must keep its validation, error handling, security and accessibility behaviour.

## Also worth checking (from the same senior-dev view)
- A changed signature or return value: grep every caller, including files outside the diff.
- The load the project really expects (one user running a script, or many users at once): judge
  check-then-write races, per-item queries and lists that only grow against that load, and say which
  load you assumed.
