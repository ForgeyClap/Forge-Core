# Slop diagnostic — score before you fix
 gradient-blobs, default-palette | default-palette | hero-plus-three-cards, uniform-grids | (polish-only) | gradient-blobs, same-shadow | (polish-only) | hero-plus-three-cards | (polish-only) | one-font | (polish-only) |
Generated-looking UI fails in a small, predictable set of ways. Run this as a written self-audit
against the screenshots, report it, and only then repair. The report says where to spend effort; it is
not a to-do list to apply blindly.

## Step 0 — first ten seconds (from the forge-craft web-ui lens)

Open each capture cold, as each stakeholder (the visitor, the keyboard or screen-reader user, the
client who paid for it), and write what you notice before reading any check:
- Can you say what it is, who it is for and what to do next at phone width?
- Is the main action visible without scrolling at phone and at desktop width?
- Does anything look unfinished: clipped text, a missing image, placeholder words, a default tab title
  or favicon?
- Does it look made for this business, or like a template you have seen before?

Full lens: `node .claude/forge-bin/forge-craft.cjs lens --type web-ui`.

## Step 1 — the ten tells (one point each, lower is better)

The **canonical** tell list is the forge-craft web-ui lens (`.claude/config/quality/lenses/web-ui.json` → `tells`: default-palette, hero-plus-three-cards, uniform-grids, gradient-blobs, random-spacing, vague-copy, no-focus-states, one-font, same-shadow, mixed-icons). Check those ten first; a finding is reported under its canonical id. The table below is the polish view of the same ground: the last column names the canonical id each row maps to, and rows marked *(polish-only)* add what the lens does not cover. Never keep a second, diverging list: change a tell in `web-ui.json` first, then here.

| # | Tell | What it looks like | Kind | Canonical id |
|---|---|---|---|---|
| 1 | Tech gradient | a glossy blue, violet or indigo gradient on everything | colour | gradient-blobs, default-palette |
| 2 | Generic hue | the accent is the model's favourite indigo or violet, not the brand's | colour | default-palette |
| 3 | Feature-tile grid | icon + heading + sentence, three times, equal weight, nothing prioritised | composition | hero-plus-three-cards, uniform-grids |
| 4 | Accent rail | a coloured strip on the left of cards or callouts as fake organisation | decoration | (polish-only) |
| 5 | Unearned blur | glass and backdrop blur with no depth system behind it | decoration | gradient-blobs, same-shadow |
| 6 | Monument stat | oversized numbers filling space that should carry the story | decoration | (polish-only) |
| 7 | Icon topper | a rounded-square icon centred above every heading | decoration | hero-plus-three-cards |
| 8 | Centre stack | everything centred because no composition was chosen | composition | (polish-only) |
| 9 | Default type | Inter or the system sans used by default, one family for everything | type | one-font |
| 10 | Wrong surface | the composition does not match the surface (a hero on a Monitor screen) | composition | (polish-only) |

Write the score out of 10 and list which tells fired, with the screenshot path for each.

## Step 2 — repair by diagnosis

- Tells 3, 8, 10 (composition) → **re-compose**: go back to the surface choice and the design
  contract. Do not recolour.
- Tells 1, 2, 9 (colour and type) → **recolour or re-typeset** from the token plan and the brand.
- Tells 4, 5, 6, 7 (decoration) → **remove** the decoration and replace it with real hierarchy:
  scale, weight, spacing, grouping.
- Re-score after the repair. Compositional tells still firing means not done: they are the causes,
  the rest are usually symptoms.

## Step 3 — the refuse list (category defaults, not bans)

The brief's own words can earn any of these back. Reaching for one when the brief is silent means no
decision was made; rewrite the element, do not soften it.
- Same-size cards of icon plus heading plus text as the page structure; nested cards (always wrong).
- The hero-metric template: big number, small label, supporting stats, accent.
- A modal for a task that needs neither interruption nor protected focus.
- Gradient text; emphasis comes from weight or size.
- A coloured side border thicker than 1 px on cards, list items, callouts or alerts.
- Hard offset block shadows outside a world that actually chose neo-brutalism.
- Sparklines, progress rings and soft rounded rectangles standing in for content.
- Geometric masks faking an organic cut-out of a photo.
- Light or dark theme picked by category instead of by the use scene (who, where, what light).
- Vague labels ("Insights", "Growth", "Seamless solutions") without content behind them.
- Decorative SVG illustrations pretending to be product imagery.

## Step 4 — themed browser surfaces

The parts nobody drew still ship: text selection colour, the caret, scrollbars where they are custom,
focus rings, link underline offset and the numerals in tables. Give them values from the palette.
This is the cheapest signal that a page was built, not assembled. (Focus rings stay at 3:1 contrast;
see `forge-a11y`.)

## Report shape

```
Surface: Operate (primary), Monitor (secondary)
Slop score: 3/10 — fired: 3 feature-tile grid (shots/home-1440.png), 7 icon topper (same), 9 default type
Composition tells firing: 1 (tell 3) -> re-compose before anything else
Plan: replace the three tiles with a task list ordered by urgency; drop the icon toppers; re-typeset
headings in the display face from the token plan
```
