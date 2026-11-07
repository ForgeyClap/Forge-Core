# forge-a11y — WCAG 2.2 essentials

## POUR
- **Perceivable:** text alternatives, captions, adaptable structure, distinguishable (contrast, no colour-only).
- **Operable:** keyboard, enough time, no seizure triggers, navigable, input modalities beyond the mouse.
- **Understandable:** readable language, predictable behaviour, input assistance (labels, errors).
- **Robust:** valid names, roles and values for assistive technology; status messages exposed.

## Levels
- **A** — the minimum; failing it blocks users outright.
- **AA** — the usual legal and contract target (includes all of A).
- **AAA** — enhanced; aim for it on specific criteria, not as a blanket target.

## New in WCAG 2.2 (check these explicitly; older audits miss them)
| Criterion | Level | What to check |
|---|---|---|
| 2.4.11 Focus Not Obscured (Minimum) | AA | a focused element is not fully hidden by sticky headers, cookie banners or chat widgets |
| 2.4.12 Focus Not Obscured (Enhanced) | AAA | no part of the focused element is hidden |
| 2.4.13 Focus Appearance | AAA | focus indicator is large enough and has enough contrast |
| 2.5.7 Dragging Movements | AA | every drag action (sliders, sortable lists, maps) has a single-pointer alternative such as buttons |
| 2.5.8 Target Size (Minimum) | AA | pointer targets at least 24x24 CSS px, or enough spacing around them (inline text links excepted) |
| 3.2.6 Consistent Help | A | help links/contact info sit in the same relative place on every page |
| 3.3.7 Redundant Entry | A | do not make users retype information they already gave in the same process (offer it or auto-fill) |
| 3.3.8 Accessible Authentication (Minimum) | AA | no cognitive test to log in (memorising, transcribing); allow paste and password managers, offer alternatives to puzzles |
| 3.3.9 Accessible Authentication (Enhanced) | AAA | no object or personal-content recognition test either |

4.1.1 Parsing is obsolete in WCAG 2.2; do not report it as a failure.

## Frequent AA failures (quick list)
1.1.1 non-text content · 1.3.1 info and relationships (fake headings, unlabelled groups) · 1.4.3 contrast ·
1.4.10 reflow · 1.4.11 non-text contrast · 2.1.1 keyboard · 2.4.3 focus order · 2.4.4 link purpose ·
2.4.7 focus visible · 3.3.1 error identification · 3.3.2 labels or instructions · 4.1.2 name, role, value ·
4.1.3 status messages.
