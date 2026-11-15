---
name: forge-glass-ui
description: "Use when styling a UI in Mono Glass: black and white, glassy buttons, fast, simple like Grok (glassy, zwart wit, zoals grok, dashboard, exe, apk ontwerp)."
---

# forge-glass-ui: the Mono Glass design language

Forge-native. The live token contract (colours, radii, blur, motion values) is `command-center/dashboard/brand/MONO-GLASS.md`; this skill is the method and the checklist, the contract holds the numbers. Read the contract first; if it is missing, say so and use the values below as provisional.

## When to use
- A Forge dashboard, the desktop .exe renderer, or the phone app (.apk web UI) in the owner's black and white glass style.
- Any app the owner wants "simple, snel, zoals Grok".
- Not for: brand-led marketing sites (`forge-website` and its per-business guideline), Electron security (`forge-electron`), Android packaging (`forge-android-app`).

## Rules
1. **Pure monochrome.** Black, white and a gray ladder. Two status colours only, as in the contract: a muted green (`--fs-ok`) for done/connected and a desaturated red (`--fs-danger`) for failed/delete, each shown as a dot or icon plus a word. Warn and info stay grey. No accent hues, no gradients with colour. *Done when:* a screenshot has no pixel with visible hue except the ok and danger status marks.
2. **Glass only on floating layers:** composer, rail, modals, menus, toasts. Cards in long lists and the page body are flat. Blur never sits on a scrolling list (speed). *Done when:* `backdrop-filter` appears only on floating selectors.
3. **Glass pill button:** sheen (top-to-bottom white gradient at low alpha), 1px hairline border, inset top highlight, hover lift (translateY -1px), active scale .97, `:focus-visible` white ring. Primary = solid white with black text (inverted in light theme). Every clickable has hover, focus-visible and active.
4. **Prompt-first layout like Grok:** quiet left rail, one centred composer, a few suggestion chips, a simple list of runs or items. One primary action per screen. No dashboard of widgets.
5. **Speed budget:** animate only `transform` and `opacity`, 120-180 ms, never `transition-all`; honour `prefers-reduced-motion`; lean bundle; local fonts only (the .exe and .apk work offline); no CDN. *Done when:* no remote URL in the built HTML/CSS.
6. **Accessibility:** AA contrast (4.5:1 text, 3:1 large and borders that carry meaning) on glass too, so check text over the blur against the worst background behind it; targets at least 44px on phone.
7. **Honest data:** empty, loading and error states are designed, never fake rows.

## Screenshot checklist (before "done")
Four shots minimum: desktop 1440x900 and phone 390x844, each dark and light. Per shot check: spacing rhythm, alignment, contrast over glass, focus ring visible, empty state, first ten seconds. Do at least two compare rounds against the contract. Serve from localhost, never `file:///`.

## Pitfalls
- Blur on 50 list rows drops frames on a phone; flatten them.
- White-on-white glass in light theme: raise border alpha, not blur.
- A green or red used for anything but a status mark (an accent, a button fill, a link) breaks the monochrome rule.

## Verification
Quote the screenshot paths and one measured contrast ratio; name any shot not taken.

## See also
`forge-electron` (the .exe shell), `forge-android-app` (the .apk), `forge-remote-access` (phone control), `forge-craft`.
