# Polish details — the small things that compound

Run these after the composition and the system are right. Each item was checked against current CSS
behaviour while adopting it; notes say where support or the global rules limit it.

## Checklist

- **Concentric radius.** Nested rounded surfaces: outer radius = inner radius + the padding between
  them. With large padding treat the layers as separate surfaces instead of forcing the formula.
  (Geometry: the two curves share a centre only when the offset is equal on both axes.)
- **Optical alignment.** Play triangles, arrows, stars and asymmetric icons look off-centre when
  centred by their box. Fix the SVG's viewBox first; otherwise nudge by 1 to 2 px. Check on the
  screenshot at 2x zoom, not in the code.
- **Borders versus shadows.** Borders separate and carry focus rings; shadows carry elevation. Follow
  the global depth rule: layered, colour-tinted, low-opacity shadows in two or three named steps
  (base, raised, floating), never one flat grey shadow on everything.
- **Text wrapping.** `text-wrap: balance` on headings and short titles; `text-wrap: pretty` on short
  body text, captions and list items; neither on long prose, code or preformatted text. Both are
  progressive enhancement: browsers without support ignore them, and Chromium balances only short
  blocks (a few lines). Still read the real copy at every width.
- **Tabular numbers.** `font-variant-numeric: tabular-nums` on counters, timers, prices, tables and
  anything that updates, so digits stop shifting. It only works when the font has tabular figures:
  check the face.
- **Image outlines.** A neutral inset outline keeps photo edges from bleeding into a light surface:
  `outline: 1px solid` black at about 10 % alpha with `outline-offset: -1px`, white at about 10 % in the
  dark theme. Neutral only, never tinted with the brand colour. This sits under the global photo rule
  (gradient overlay plus a colour treatment layer) and does not replace it.
- **Hit areas.** At least 40 x 40 px, ideally 44 x 44 px, for every control. WCAG 2.2 AA (2.5.8) asks
  at least 24 x 24 CSS px or enough spacing; 44 px is the AAA bar (2.5.5) and our default. Grow a small
  icon's target with a pseudo-element; expanded targets must not overlap.
- **Font smoothing.** `-webkit-font-smoothing: antialiased` changes rendering on macOS only; Windows
  and most Linux browsers ignore it. Optional, never a fix for a Windows screenshot.

## Motion inside the global rules

The global rules allow animating **only `transform` and `opacity`**, never `transition-all`, with
spring-style easing. Within that:
- Use CSS transitions for interactive state changes: they retarget from the current value when the
  user changes their mind mid-motion. Keep keyframes for one-shot entrances or loading sequences.
- Name the properties: `transition-property: transform, opacity` with a duration (about 150 to 250 ms
  for a control) and an easing. Never `transition: all`, never `will-change: all`; use `will-change`
  only for a known first-frame stutter on `transform` or `opacity`, and remove it at rest.
- Enter with opacity plus a small `translateY`; exit shorter and quieter than the enter (about 150 ms).
- Press: `scale(0.96)` to `scale(0.98)` on tactile buttons; offer a way to turn it off where it
  distracts.
- A hover shadow or colour change: do not animate `box-shadow` or `background-color`. Put the hover
  shadow or tint on a pseudo-element and fade its `opacity`, or switch the colour without a transition.
- Icon swaps: cross-fade with opacity and a slight scale instead of an instant visibility flip.
- Under `prefers-reduced-motion: reduce`: movement stops or becomes a plain fade, and the state change
  stays visible (a global kill to 0.01 ms that hides feedback is a defect).

## Before / after table (report format)

| Principle | Before | After | Where |
|---|---|---|---|
| Concentric radius | parent and child both 16 px | parent 24 px (16 + 8 padding) | `src/components/Card.css:12` |
| Tabular numbers | price column shifts as digits change | `tabular-nums` on `.price` | `pricing.css:40` |
| Transition scope | `transition: all 0.3s` | `transition-property: transform, opacity` | `button.css:7` |

List only what changed; omit principles that were checked and fine.

## Not taken from the sources, and why

| Source idea | Why it was dropped |
|---|---|
| Animate blur, backdrop-filter, clip-path, mask and shadow as part of the motion palette (impeccable) | global rule: animate only transform and opacity |
| `transition-property: transform, background-color, box-shadow` (ECC example) | colour and shadow transitions break the same rule; pseudo-element opacity does the job |
| Blur in the enter animation (ECC) | filter is not transform or opacity |
| Antialiased smoothing as a root default (ECC) | macOS-only, does nothing on Windows; kept as optional |
| "Flat or subtle gradients", "subtle or no shadows" (addy) | global rule asks for layered radial gradients with grain and layered tinted shadows |
| Flat grounds only on non-tech pages; no captions ever (Taste house rules) | contradicts the global depth rule; captions are a judgement call, not a ban |
| Run the design-detector binary and its hook after every edit (impeccable) | binary download, Bash grants and hooks are excluded; the screenshot loop and this checklist replace it |
| Deal palettes and heroes at random (Taste scripts) | scripts excluded; Forge chooses deliberately from the brief and the brand guideline |
