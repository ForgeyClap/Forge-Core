# forge-figma — hard rules (full text)

## Hard rules (non-negotiable)
- **Faithful translation, verified visually.** Rendered output is compared **side-by-side** against the source frame at the design's breakpoints (spacing, sizing, hierarchy, states) — "close enough" from memory is not translation. Screenshot evidence, not assertion.
- **Design tokens, not scattered magic values.** Colours, typography, spacing, radii, shadows are extracted into tokens/variables (CSS custom properties, a tokens file, or a theme object) and reused — the design's real scale, not a fresh hardcoded hex/px per component.
- **Responsive fidelity.** The design's breakpoints are honoured (Figma usually ships desktop + mobile frames); layout adapts. No fixed-pixel-only layout that breaks off-frame.
- **Accessibility is not optional.** Semantic HTML, WCAG **AA** contrast, visible focus states, keyboard navigation, alt text, ARIA where needed. A design can look right and still fail contrast — **flag the failure back**, don't silently ship it. a11y wins over exact pixel-match.
- **Component structure mirrors the design system.** A Figma variant set (e.g. a `Button` with variants) becomes **one** prop-driven component, not copy-pasted one-offs. Real content from the design, no Lorem where real copy exists.
