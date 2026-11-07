# forge-website — React / Next.js and interface rules

<!--
  Pattern adapted from (ideas only, rewritten in Forge's words; no upstream text or rule files copied, nothing
  installed, read 2026-11-02 as untrusted data):
  - vercel-labs/agent-skills skills/react-best-practices (main, last change seen dc8367e); MIT is
    declared in its frontmatter, the repo has no LICENSE file, so ideas only.
  - vercel-labs/web-interface-guidelines command.md (main at 434b7f9, 2026-10-05; MIT, Copyright (c) 2025
    Vercel Labs; full notice in ../LICENSE). The upstream web-design-guidelines skill fetches these rules over the network at run time;
    Forge does not: the distilled rules live here, offline.
  Where upstream disagrees with Forge house style, Forge wins: sentence case for headings and buttons (not Title
  Case, per frontend-design), and copy rules from frontend-design's writing section.
-->

Use when a website or frontend build is React-based (React, Next.js, Remix, Vite + React) and as the review list
for any web UI. Speed, Core Web Vitals and SEO measurement belong to `forge-web-quality`; visual direction
to `frontend-design`. Rules are ordered by impact; fix the top categories first.

## 1. Remove waterfalls (critical)
- Start independent async work together (`Promise.all`); never await one fetch before starting an unrelated one.
- Check cheap synchronous conditions before awaiting anything; move each `await` into the branch that needs it.
- In route handlers and server components: start promises early, await them late.
- Stream slow parts behind `<Suspense>` boundaries so the shell and the LCP content are not blocked.
- Nested per-item fetches: run them in parallel, or better, fetch the relation in one query.

## 2. Bundle size (critical)
- Import from the module path, not a barrel `index` that pulls a whole library.
- Keep import paths statically analysable (no computed `import()` strings) so tree-shaking works.
- Heavy, below-the-fold or interaction-only components load with `next/dynamic` / `React.lazy`.
- Analytics, chat, A/B and logging load after hydration or on idle.
- Load a feature's code only when the feature is switched on; preload the next route on hover/focus of its link.

## 3. Server side (high)
- Server actions are authenticated and authorised exactly like API routes (they are public endpoints).
- Deduplicate per-request work (`React.cache`); cache across requests only with a bounded cache and a clear
  staleness window.
- Pass the smallest serialisable props to client components; never serialise the same data twice.
- No mutable module-level state that depends on the request (it leaks between users in SSR).
- Static I/O (fonts, logos, config) at module level; non-blocking follow-up work after the response (`after()`).

## 4. Client data (medium-high)
- Deduplicate requests with the project's data library (SWR, TanStack Query); one global listener, not one per
  component; passive listeners for scroll/touch.
- `localStorage`: versioned schema, small values, read once and cache; never secrets or tokens.

## 5. Re-renders (medium)
- Derive state during render instead of syncing it in an effect; subscribe to derived booleans, not raw objects.
- Primitive values in effect dependencies; functional `setState` for stable callbacks; lazy `useState(() => …)`
  for expensive initial values.
- Interaction logic in event handlers, not effects; `startTransition` / `useDeferredValue` for non-urgent work.
- Never define a component inside another component; hoist non-primitive default props and static JSX.
- Memoise only what profiling shows is hot; skip `useMemo` for cheap expressions; refs for fast-changing
  transient values.

## 6. Rendering (medium)
- `content-visibility: auto` or virtualisation for long lists (above ~50 rows).
- Ternaries instead of `&&` when the left side can be `0` or `""`.
- Client-only values (theme, locale time) without hydration flicker: an inline script or a guarded render;
  `suppressHydrationWarning` only for a known, harmless mismatch.
- Scripts `defer`/`async`; React DOM resource hints (`preload`, `preconnect`) for proven late resources.
- Animate a wrapper, not a complex SVG; trim SVG coordinate precision.

## 7. Plain JavaScript (low-medium)
`Set`/`Map` for repeated lookups; one loop instead of chained `filter().map()` on large arrays; hoist RegExps
and property reads out of loops; early returns; `toSorted()` instead of mutating sort; batch DOM style changes
through classes; idle-time work via `requestIdleCallback`.

## Interface rules (review list for every web UI)
**Accessibility and focus**
- Real `<button>` for actions, `<a href>` for navigation; never a click handler on a `div`/`span`.
- Icon-only buttons and every form control have an accessible name; decorative icons are hidden from assistive tech.
- Visible focus on everything interactive (`:focus-visible`); never remove an outline without a replacement;
  sticky headers must not cover the focused element; a skip link and a proper heading order.
- Toasts and inline validation are announced politely (`aria-live`); semantic HTML before ARIA.

**Forms**
- Correct `type`, `inputmode`, `autocomplete` and `name` on inputs; labels are clickable; never block paste.
- The submit button stays enabled until the request starts, then shows progress; errors appear inline next
  to the field, and focus moves to the first error.
- Spellcheck off for e-mail, codes and usernames; warn before leaving with unsaved changes.

**Motion**
- Respect `prefers-reduced-motion`; animate `transform`/`opacity` only; list properties instead of
  `transition: all`; animations are interruptible; motion that autoplays longer than 5 s can be paused.

**Content and layout**
- Text containers survive long words and very long or empty input (truncate, clamp, wrap; `min-width: 0` on
  flex children); every list has an empty state.
- `<img>` always has width and height; below-the-fold images lazy, the hero image high priority.
- No unwanted horizontal scroll; full-bleed layouts respect safe-area insets; layout with flex/grid, not JS
  measuring.
- Typography details: real ellipsis (…), curly quotes, non-breaking spaces in units ("10 MB"), tabular numbers
  in numeric columns, `text-wrap: balance` on headings.

**State, touch, theming, locale**
- The URL reflects filters, tabs and pagination so state can be shared and restored; links work with
  ctrl/cmd-click and middle-click; destructive actions get a confirmation or undo.
- `touch-action: manipulation`; `overscroll-behavior: contain` in modals and drawers; every gesture has a
  tap/keyboard alternative; `autoFocus` sparingly and not on mobile.
- Dark theme sets `color-scheme: dark` and a matching `theme-color`; native selects get explicit colours.
- Dates, numbers and currency through `Intl.DateTimeFormat` / `Intl.NumberFormat`; language from the browser
  setting, not the IP; brand names and code marked `translate="no"`.
- Hover, active and focus states are visibly stronger than rest.

**Copy (Forge style wins)**
Active voice, sentence case, specific button labels ("Save changes", not "Submit"), errors that say how to fix
the problem, numerals for counts. See `frontend-design` → writing.

## Anti-patterns to flag in review
Zoom disabled (`user-scalable=no`, `maximum-scale=1`); paste blocked; `transition: all`; outline removed without a
focus-visible style; `onClick` navigation instead of a link; click handlers on `div`s; images without size;
large unvirtualised `.map()` lists; inputs without labels; icon buttons without names; hard-coded date or
number formats; unjustified `autoFocus`; animated GIFs where a video would do; gesture-only actions.
