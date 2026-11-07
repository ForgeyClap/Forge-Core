# UI engineering checks for the polish pass

What "production quality" means once the visuals are right. These are checks on the built result,
not intentions.

## AI default versus production quality

| AI default | Why it hurts | Production quality |
|---|---|---|
| purple or indigo everything | every app looks the same | the project's own palette from the token plan |
| rounded-2xl on everything | ignores the radius hierarchy | two or three named radius steps |
| generic hero section | no link to the content or the user's need | content-first composition for the surface |
| lorem ipsum or vague copy | hides wrapping and overflow problems | real or realistic copy at real lengths |
| equal big padding everywhere | destroys grouping and hierarchy | the spacing scale: tight inside a group, generous between groups |
| stock card grid | ignores priority and scanning | layout chosen by the content (list, table, timeline, quote) |
| arbitrary values (13 px, 2.3 rem) | drift and inconsistency | only values on the scale |

(Shadows and gradients follow the global depth rule, not this table.)

## States checklist

Every data-bearing view and every control, where it applies:
- **Loading:** a skeleton that matches the final layout for content, a pressed or busy state for
  actions; `aria-busy` on the region; nothing jumps when data lands.
- **Empty:** says what is missing, why, and the one next step (with a button when there is one).
- **Error:** plain words, what went wrong and how to fix it; keeps what the user typed; focus moves to
  the first field that needs fixing.
- **Partial and long content:** long names, many items, missing images, translated strings that run
  30 % longer.
- **Success:** confirms the result; announced through a live region when it is not a page change.
- **Disabled and permission-limited:** visible, explained ("Only admins can edit this").
- **Controls:** default, hover, focus-visible, active, disabled, loading, on every clickable element.

## State ladder (choose the simplest that works)

Local component state → lifted state for two or three siblings → context for read-heavy, write-rare
values (theme, locale, auth) → URL state for filters, pagination and anything shareable → a server
cache for remote data → a global store only for complex client state shared across the app. Passing
props through three or more layers that do not use them is a sign to restructure.

## Test widths and what to look at

Capture at **320 (or 390), 768, 1024 and 1440 px**; the `forge-website` domain gate widths 360, 768 and
1280 are covered when 390 and 1440 are in the set, and 1024 catches the tablet-landscape breakage that
the others miss. Per width check:
- no sideways scroll, no clipped or overlapping text, no orphaned single word in a heading;
- the primary action visible without scrolling;
- splits stack text first; no half-empty row; one column at phone width;
- stable dimensions: toolbars, counters, tiles and grids do not shift when labels change or on hover;
- every image or visual renders and keeps its aspect ratio (width and height set, or an aspect-ratio box);
- both themes when the project has two.

## Finish checks

- Zero console errors on every captured page and state.
- Keyboard: Tab through the whole path; order is logical; focus always visible; Escape closes overlays.
- Text zoom to 200 % and reflow at 320 CSS px without loss of content (`forge-a11y` owns the method).
- Remove debug output, dead code, unused imports, obsolete styles and duplication the polish created.
- Promote a value to a token only when it is genuinely reused.
- Finish with a diff read: remove accidental churn and temporary files (scratch goes in `_scratch/`).
