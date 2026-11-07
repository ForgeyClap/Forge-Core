# Forge Systeem theme (brand v1.0)

One palette, one type scale, one set of surfaces for the dashboard, the chat and the registry home view.
Zero dependencies: plain JSON in, plain CSS out. The design and its reasons live in
`docs/forge-systeem/redesign/BRAND.md` (blued steel and one spark: mineral greys tinted toward Pauw, one accent).

## Files

| File                     | Owner       | What it is                                                     |
| ------------------------ | ----------- | -------------------------------------------------------------- |
| `tokens.json`            | you         | The single source of truth. This is the file you edit.         |
| `build-theme.cjs`        | you         | Generator. Node 18+, no packages.                              |
| `forge-tokens.css`       | *generated* | Do not edit. It gets overwritten.                              |
| `forge-base.css`         | you         | Shared primitives built on the `--fs-*` tokens.                |
| `forge-mark*.svg`        | you         | The mark: light, on-dark, mono (`currentColor`) and favicon.   |

## Use it

`src/styles/app.css` imports `forge-tokens.css` and then `forge-base.css`; view stylesheets come after.

**Light is the default.** `index.html` sets `data-theme` on `<html>` before first paint from
`localStorage forge.prototype.appearance` (`light`, `dark` or `system`). `system` ("Zoals Windows") follows
`prefers-color-scheme`, so a Windows set to dark still opens dark. Without any attribute the stylesheet itself
falls back to the OS preference.

For the registry home view, which has to stay a single self-contained file:

```bash
node brand/build-theme.cjs --inline >> home-view.html
```

## Rebuild

```bash
node brand/build-theme.cjs          # write forge-tokens.css
node brand/build-theme.cjs --check  # exit 1 if the CSS drifted from the JSON (part of npm run verify)
```

## What `tokens.json` holds

- `fs.global`: type (Bahnschrift display, Segoe UI Variable body, Cascadia Mono for machine text only), the
  4-based space scale, radii (including `--fs-radius-struck`, the struck corner), layout, focus and motion.
- `fs.light` and `fs.dark`: surfaces, ink, the one accent (Pauw), the four status colours with their soft
  fills, shadows and the scrim. Both lists must hold the same names in the same order.
- `fs.reduced-motion`: every duration is 0 under `prefers-reduced-motion: reduce`.

## The alias bridge is gone (redesign)

Waves 1 to 3 kept an alias block that mapped the old `--forge-*` names and the v0.1 `--fs-*` names onto v1.0.
moved every remaining use to the v1.0 `--fs-*` names (or to the fixed value the alias gave it, for old
geometry such as the dock height) and deleted the block. `build-theme.cjs` now fails when `tokens.json` carries a
`bridge` block again, and `tests/unit/redesign-tokens.test.ts` fails on any `--forge-` name in `src/**`.

## The rules

- **One accent.** Pauw marks "you can act here" and "Forge is working". Status colours are only for status.
- **No raw colour outside `brand/`.** A view that needs a colour that does not exist is a missing token: add it
  here. The few legacy files that still hold hex are listed in the ratchet test and may only shrink.
- **Motion is transform and opacity only**, at 140 / 220 / 320 ms. Reduced motion switches it all off.
- **No ALL CAPS.** Labels are sentence case, 12-13 px, weight 600.
- **Mono marks machine text** (addresses, commands, file paths, run ids), never a label.
