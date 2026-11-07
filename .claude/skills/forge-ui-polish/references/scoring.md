# Scoring — audit, critique, severity and the score card

Two scores, one severity scale. The audit is measurable and gates; the critique is judgement and
informs. Every number cites evidence (a screenshot path that was read, a command and its exit code,
or file:line). A dimension you could not inspect is NOT_INSPECTED, never a guessed number.

## Audit — five dimensions, 0 to 4 each (gate)

| # | Dimension | Check for | 0 | 2 | 4 |
|---|---|---|---|---|---|
| 1 | Accessibility | contrast (4.5:1 body, 3:1 large text and UI parts), focus visible and in order, labels, semantic headings and landmarks, alt text, reduced motion that keeps state changes visible | fails WCAG A | some effort, real gaps | WCAG 2.2 AA met on the scoped pages, near AAA |
| 2 | Performance | layout-property animation, image weight and lazy loading, layout shift, `will-change` left on at rest, unused imports | layout thrash, nothing optimised | some optimisation | lean; local numbers labelled "local, indicative" |
| 3 | Theming | hard-coded colours outside the tokens, dark mode gaps, values that do not follow a theme switch | everything hard-coded | tokens exist, used unevenly | full token use, both themes correct |
| 4 | Responsive | fixed widths, sideways scroll, clipped text, touch targets, text zoom to 200 %, touch gestures that fail | desktop only | works on phone with rough edges | fluid at every tested width, targets and gestures fine |
| 5 | System integrity | one button pair, one card style, one radius and shadow scale, spacing on the scale, type hierarchy steps, same element looks the same everywhere, no structure interchangeable with an unrelated product | systemic drift | several verified issues | coherent and product-specific |

Bands (out of 20): 18-20 excellent · 14-17 good · 10-13 needs real work · 6-9 poor · 0-5 critical.
**Gate: at least 15, with Accessibility and Responsive each at least 3.**

Use the ten consistency questions as prompts inside dimensions 1, 3, 4 and 5: colour consistency, type
hierarchy, spacing rhythm, component consistency, responsive behaviour, dark mode, motion purpose,
accessibility, information density, finishing states (hover, loading, empty).

Recording touch evidence: say what produced it (an emulated viewport, a synthesised touch in
Playwright, a real phone). A rendered viewport proves layout, not a gesture.

## Critique — ten usability heuristics, 0 to 4 each (advisory)

1 visibility of system status · 2 match with the real world (the user's words) · 3 user control and
freedom (undo, cancel, a way out) · 4 consistency and standards · 5 error prevention · 6 recognition
rather than recall · 7 flexibility and efficiency · 8 aesthetic and minimalist design · 9 helping users
recover from errors · 10 help and documentation.

- A heuristic that cannot apply (7 and 10 are often n/a on a landing page or a portfolio) is written
  `n/a` with a one-line reason. The total is then out of 4 x the number scored, never out of 40 over a
  partial set. Report it as a percentage.
- Be honest: 4 means genuinely excellent. Most real interfaces land between 50 % and 80 %.
- Add 2 or 3 things that work, 3 to 5 priority issues, and the cognitive-load check: too many options
  at once, information the user must remember between screens, hidden navigation, jargon, visual noise.

## Severity — P0 to P3

| Tag | Meaning | Forge mapping | Action |
|---|---|---|---|
| P0 | blocks a task, loses data, misleads about state, or an inaccessible path | `forge-a11y` Critical; `forge-code-review` HIGH (CRITICAL when data is lost) | fix now; gate fails |
| P1 | major difficulty or a WCAG AA failure | `forge-a11y` Serious; `forge-code-review` HIGH | fix before hand-over; gate fails |
| P2 | annoyance with a workaround | MEDIUM | fix in this pass when cheap, else a stated weakness |
| P3 | polish, no real user impact | LOW | fix if time allows; keep the list short |

Each finding: tag, name, location (component, file:line, or screenshot + region), dimension, impact on
a real user, the standard if any (WCAG criterion number and name), and the fix. Keep P3s few: a long
tail buries what matters. Report no finding you are under 80 % sure of; verify first.

Triage order for repairs: (1) broken or blocked tasks, data loss, misleading state, inaccessible paths;
(2) missing loading, empty, error, success, disabled and permission states; (3) flow, hierarchy,
responsive and system drift; (4) visual and motion inconsistencies; (5) code and asset clean-up. Do not
perfect one corner while the rest stays below the bar.

## Score card (paste into the report)

```
forge-ui-polish score card — <page/surface>, run <run_id>, round <n>
Surface: <one of seven>     Design contract: <path or "inline above">
Captured: 390, 768, 1024, 1440 px · themes: light, dark · states: empty, error, success
          (not captured: <list, with reason>)
Slop: <n>/10 — fired: <tells>; composition tells: <n>
Audit: A11y <n> · Perf <n> · Theming <n> · Responsive <n> · Integrity <n> = <total>/20 (<band>)
Critique (advisory): <score>/<max> = <pct> % (n/a: <numbers and reason>)
Open: P0 <n> · P1 <n> · P2 <n> · P3 <n>
Evidence check: forge-craft-evidence.cjs check --run <id> --type web-ui -> exit <code>
Rounds: 1 <date/time> -> 2 <date/time> (what changed between them)
Gate: PASS | FAIL (<the failing row>)
Not checked: <browsers, devices, screen readers, gestures not run>
```

Before and after a repair round, show the score change per dimension; a total that rose while a
compositional tell still fires is still a FAIL.
