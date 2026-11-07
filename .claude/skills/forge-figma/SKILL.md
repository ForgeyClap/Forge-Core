---
name: forge-figma
description: "Playbook for design-to-code: Figma, design tokens (gebruik bij ontwerp naar code)."
# A10 original description (listing budget): "Playbook for design-to-code: Figma, mockups, design tokens, pixel-perfect responsive UI (gebruik bij ontwerp naar code)."
# W2-BUDGET original description (listing budget): "Playbook for design-to-code: Figma, mockups, design tokens (gebruik bij ontwerp naar code)."
---

# Forge playbook — Design → code (Figma / mockups)

## When to use
- Use for: design-to-code from Figma files or mockups: tokens, components, responsive fidelity, accessibility.
- Not for: generic page building on its own: the built result also runs under `forge-website`.
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules (non-negotiable)
- **Faithful translation, verified visually.**
- **Design tokens, not scattered magic values.**
- **Responsive fidelity.** The design's breakpoints are honoured (Figma usually ships desktop + mobile frames); layout adapts.
- **Accessibility is not optional.** Semantic HTML, WCAG **AA** contrast, visible focus states, keyboard navigation, alt text, ARIA where needed.
- **Component structure mirrors the design system.** A Figma variant set (e.g.

Full text of every rule: `references/hard-rules.md`.

## Team (conditional by stack/level)
Lead: `ui-boss` (design-led) or `build-boss`. Build review: `react-reviewer` **or** `vue-reviewer` (by stack). Accessibility: `a11y-architect`. Figma MCP wiring (opt-in): **`mcp-developer`**. Design critique of the translated result: the `design-is` skill. If it's a marketing/landing surface, `seo-boss` for meta/perf.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L2 a single component or screen; L3 a full design-system / multi-screen translation.
**Serial:** ingest the design (MCP read **or** exported frames + specs) → extract tokens → build components → wire responsive breakpoints → a11y pass → visual diff vs source.
**Parallel:** independent components/screens translate in parallel **once** the token system is fixed (tokens are the shared contract).

## Domain gates
- Rendered output matches the source frame at the design's breakpoints — side-by-side screenshot evidence.
- Design tokens extracted to variables/theme and reused; no per-component hardcoded palette/spacing drift.
- Responsive at the design's declared breakpoints; no fixed-pixel-only layout.
- a11y: contrast meets AA, semantic HTML, visible focus, keyboard-navigable — any contrast failure **in the source** is flagged, not shipped silently.
- Components mirror the design's variant/component system (reusable, prop-driven), not copy-paste duplicates.
- The translation **source** is stated — Figma MCP read vs provided exports — and no measurements are invented.

## Ship-readiness (unique)
Side-by-side visual match at the design's breakpoints (screenshots attached); a tokens file/theme present and used; responsive verified; a11y (contrast AA / focus / keyboard) checked with any source-side a11y defects flagged back; component structure mirrors the design system; the translation source (MCP vs exports) stated honestly — and if neither was available, the output is labelled approximate. Defers to `forge-website` ship-readiness for the built page (real content, no test copy, secrets in env). Advisory checklist; optionally run `codex-reviewer` on component code — not a blocker.

## Safety, approval and honesty
- Approval / safety: the Figma MCP is opt-in and needs a Figma access token + MCP wiring (`mcp-developer`).
- Honest failure: state the translation source (Figma MCP read vs provided exports); never invent measurements.
- Honest failure: without the MCP or exports Claude cannot see the Figma file: label the output approximate and request the assets.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/code-to-tokens.md` — recovering design tokens from existing code (scan, cluster, name, emit, AA check).
