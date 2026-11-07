# Surface, art direction and taste

Read this before judging a page. Most generic-looking UI is a composition problem, not a colour
problem: the page reached for a centred hero and three equal cards before anyone asked what the
screen is for. Restyling that layout never fixes it.

## 1. Name the surface first (one line, out loud)

| Surface | The user is... | Composition that fits | Wrong move |
|---|---|---|---|
| Monitor | watching state change (dashboards, status pages) | density, glanceable hierarchy, the most urgent state first | a hero, marketing copy |
| Operate | acting on things (admin, queues, inboxes, editors) | action affordances, selection state, stable toolbars | decorative sections around the tool |
| Compare | weighing options (pricing, plans, spec tables, results) | aligned columns, parity of structure, one differentiator emphasised | cards of different shapes per option |
| Configure | setting things up (settings, forms, wizards, onboarding) | progressive disclosure, clear save and validation states, low decoration | everything on one long screen |
| Decide / Learn | being convinced or taught (landing pages, docs, articles) | one idea per section; the only surface where a hero is usually right | feature-tile grid as the whole story |
| Explore | browsing an open space (galleries, catalogues, maps) | filters, result grid, peek and zoom | a narrative scroll |
| Command / Inspect | driving by keyboard or drilling into one object | speed, focus, a detail pane | breadth and chrome |

Rules:
- Write the surface in one line before any token or score ("This is a Monitor surface, so density
  beats a hero").
- A screen that spans two surfaces names the primary one and treats the other as secondary.
- A tool or dashboard shows the usable screen first, not a landing hero in front of the tool.
- The same product has different surfaces: its landing page is Decide, its docs are Learn, its app is
  Operate. Judge the surface in front of you, not the product.

## 2. The kind of business decides what leads (Taste)

When the brief is silent about direction, the kind of business decides what carries each screen:

| Kind | Examples | What leads | What it never needs |
|---|---|---|---|
| Place | cafe, bakery, guesthouse, shop, gym, salon | real photographs of the place and its goods; the visit block (where, when) early; one main action (book, order, directions) | shader effects, fake dashboards, tech gradients |
| Service | clinic, law firm, agency, studio, trade | the people, the work, the proof; one clear way to make contact | stock "team high-five" photos passed off as the client |
| Product | a physical product or brand | the product shown big and whole, a different view per section, every headline promise pictured | the product mid-size in a grey box; the same picture twice |
| Software | SaaS, AI, developer tool, app | the product's own UI showing real work, at true size | a generic dashboard full of arbitrary numbers |

General taste rules (all subordinate to the brief and the global rules):
- Say plainly what is sold, to whom, on the first screen, with one hard fact (a price, a place, a
  number that is real).
- One idea per section; the section heading is the first thing in it and names a thing.
- Left and right content edges line up across the page; nothing hangs off to one side; no sideways
  scroll at any width.
- Every visual actually renders at every tested width; an empty frame or a broken effect is a defect.
- Hover answers are quiet and transform-only: a linked card lifts about 2 px, a photo scales about 1.02
  inside its frame, a button presses on click. No tilt, no carousels on timers.
- Nothing fades or slides in just because the page scrolled; one authored moment at most, not the
  same entrance on every block.
- No invented reviews, quotes, customers, logos or figures; no stock image passed off as the client's
  own product, people or place. Missing material is listed for the owner.
- One system: one button pair, one card style, one radius scale, one link look, at most two boxes deep
  (never a card inside a card).

## 3. Reference images and references

- **"Match this" reference (the global rule):** match layout, spacing, type, colour and radius exactly,
  swap in placeholder content, add nothing, improve nothing. Compare screenshot against reference in at
  least two rounds and name concrete differences ("heading 32 px, reference about 24 px").
- **Inspiration references (not "match this"):** study two or three screens, write down the decisions
  (hierarchy, density, navigation, controls, responsive behaviour, states) and rebuild them in the
  project's own tokens and content. Never copy another product's branding, text, imagery, exact layout
  or signature effect.
- **No references at all:** document the assumptions in the design contract and judge against the
  project's own design system and the per-business brand guideline.

## 4. Anti-generic defaults (each is a tell unless the brief asked for it)

- A violet, lavender or indigo accent or gradient that was not chosen for this brand.
- The framework's default palette, or grey on white with one lonely accent.
- Maximum rounding on everything instead of a radius hierarchy.
- Equal generous padding everywhere, so nothing groups and nothing separates.
- Uniform card grids as the page structure.
- A system face or the same sans for headings and body (the global rule asks for a display or serif
  paired with a clean sans).
- Emoji or mixed icon sets standing in for an icon system.
- Monospace as a costume for "technical" outside code or data.
- A small kicker label above every heading, or 01 / 02 / 03 numbering that carries no sequence.

Where Taste and the global rules differ, the global rules win: depth comes from layered radial
gradients with grain and from layered tinted shadows (not "flat grounds only"); captions are allowed
where they help (not banned outright).

## 5. The design contract (five lines, before repair)

```
Screen job:       <what this screen is for, in one sentence>
Primary action:   <the one action that leads>
Required states:  <loading, empty, error, partial, success, permission, as they apply>
Responsive rules: <what stacks, what hides, what stays fixed at 320/768/1024/1440>
Reject:           <the patterns this screen must not use>
```

Keep it short for a small change. Hold every repair against it.
