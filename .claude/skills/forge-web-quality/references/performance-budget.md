# Performance budget and fix patterns

Part of `forge-web-quality`. Use a pattern only for a bottleneck the trace showed.

## Starting budget (guardrails; the project's own budget always wins)
| Resource (compressed, per page) | Starting budget |
|---|---|
| JavaScript, initial route | <= 200 KB (hard ceiling 300 KB for app-like pages) |
| CSS | <= 50–100 KB |
| Above-the-fold images | <= 500 KB total; each image <= 200 KB |
| Web fonts | <= 100 KB |
| Third-party scripts | <= 200 KB |
| Total page weight | <= 1.5 MB |
| Lighthouse Performance (mobile, lab) | >= 90 as a signal, never the only proof |

Guard in CI with a pinned dev-dependency the project already uses (for example size-limit, bundlesize or
Lighthouse CI added to `package.json` with a fixed version) or the bundler's own size warnings. Do not run an
unpinned `npx <tool>`; adding a new dev-dependency is a normal, reviewed change.

## Critical rendering path
- HTML: Brotli (else gzip), HTTP/2 or HTTP/3, cacheable at the edge where the content allows.
- `preconnect` only to origins needed for the first view (max 2–3); `preload` only what the trace shows
  being discovered late — extra high-priority requests can delay LCP.
- Critical CSS inline (keep the first response small, ~14 KB), the rest loaded without blocking.
- Scripts: `defer` or `type="module"` by default, `async` only for independent scripts; nothing
  parser-blocking in `<head>`.
- 103 Early Hints only when the trace shows slow HTML generation and the hinted files are stable.

## Images
- Format by content: AVIF/WebP for photos, SVG for icons and logos, PNG only when lossless is needed.
- `<picture>` / `srcset` + `sizes` that match the real layout widths; explicit `width` and `height`.
- `loading="lazy"` + `decoding="async"` below the fold; the LCP image eager with `fetchpriority="high"`.
- Prefer a muted looping video (with poster) over an animated GIF.

## Fonts
- Self-host when possible; WOFF2 only; subset (`unicode-range`); prefer one variable font over many weights.
- `font-display: swap` for text, `optional` for decorative fonts; preload only the one or two fonts used above
  the fold; a metric-matched system fallback limits CLS.

## Caching headers
| Asset | Cache-Control |
|---|---|
| HTML | `no-cache` (revalidate every time) or short `s-maxage` at the edge |
| Hashed static files (`app.3f9a.js`) | `public, max-age=31536000, immutable` |
| Unhashed static files | `public, max-age=86400, stale-while-revalidate=604800` |
| Personal API responses | `private, no-store` or `private, max-age=0, must-revalidate` |

## JavaScript and bundle size
Ordered by impact (pattern adapted from vercel-labs/agent-skills react-best-practices, bundle category):
1. **Split by route** and load heavy features on demand (dynamic `import()`, `next/dynamic`, `React.lazy`).
2. **No barrel imports** for big libraries: import the module you use (`lodash/debounce`, icon by path), or
   enable the bundler's package-import optimisation.
3. **Statically analysable imports** — no computed paths, so tree-shaking works.
4. **Load only when the feature is used** (editor, chart, map after a click or when visible).
5. **Third parties after the page is usable** (analytics, chat, A/B) — after load or on idle.
6. **Preload on intent** — start fetching the next route's code on hover or focus of its link.
7. Look at the bundle before and after (the bundler's analyzer or a source-map explorer pinned in the project);
   unexplained growth is a review finding.

## Third parties
- Every third-party script needs an owner and a reason; remove the unused ones first.
- Facade pattern: a static placeholder (thumbnail + play button) that loads the real video/map/chat embed only
  on click.
- Load below-the-fold widgets when they come into view (IntersectionObserver).
- Self-host what the licence allows (fonts, small libraries) to avoid extra connections.

## Runtime
- Batch DOM reads before writes; no layout reads inside loops.
- `requestAnimationFrame` for visual updates; passive listeners for scroll/touch; debounce resize/scroll work.
- Virtualise lists above ~50–100 rows, or `content-visibility: auto` for long static sections.
- Animate `transform` and `opacity` only; never `transition: all`.
- View Transitions for smoother navigations where supported; never required for function.
- Re-renders: memoise only what profiling shows is hot; derive state during render instead of syncing it in
  effects.
