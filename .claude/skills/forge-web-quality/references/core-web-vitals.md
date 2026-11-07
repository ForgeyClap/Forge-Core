# Core Web Vitals — measure, diagnose, fix

Part of `forge-web-quality`. Thresholds live in `SKILL.md`; this file is the "how".

## Field vs lab (never mix them up)
| | Field (real users) | Lab (one controlled load) |
|---|---|---|
| Sources | CrUX (page, else origin, labelled), Search Console CWV report, first-party RUM | DevTools Performance trace, Lighthouse, PageSpeed Insights lab section |
| Answers | "Is it a problem for visitors?" (p75, 28-day window for CrUX) | "Why is it slow, and did my change help?" |
| Has INP? | Yes | No: use TBT and a recorded interaction as proxies |
| Updates after a fix | Only after new visits (days to weeks) | Immediately |

Rules:
- Prioritise by field data when it exists; diagnose with a trace.
- Compare a lab run only with a lab run under the same conditions (device, CPU/network throttling, cache
  cold or warm, same build). Run at least three times and use the median when the numbers are close.
- First-party RUM: the `web-vitals` library (`onLCP`, `onINP`, `onCLS`) reporting metric, value, route,
  device class and release. Where it reports to is an owner decision (outbound + privacy); no personal data.
- A `PerformanceObserver` in the console is a single-session debugging aid, not field data.

## LCP — Largest Contentful Paint
Find the LCP element first (trace "LCP by phase", or the observer). Typical: hero image, poster, large heading
block, CSS background image.

Split the time into four phases and fix the largest:
| Phase | Too long when | Fix |
|---|---|---|
| TTFB | > 800 ms | CDN/edge caching of HTML, fewer redirects, faster backend, static or streamed rendering |
| Resource load delay | the LCP resource is found late | put it in the initial HTML as a real `<img>`; `fetchpriority="high"`; never `loading="lazy"` on it; preload only if the trace shows late discovery (e.g. CSS background) |
| Resource load time | the file is big | right format (AVIF/WebP), responsive `srcset`/`sizes`, compression, same-origin or preconnected CDN |
| Element render delay | the resource is there but paint waits | remove render-blocking CSS/JS from `<head>` (inline critical CSS, `defer` scripts), avoid client-only rendering of the hero, font swap |

Extra levers: server or static rendering so the LCP content is in the HTML; Speculation Rules
(`<script type="speculationrules">`, eagerness `moderate`) to prerender likely next pages — Chromium only,
costs bandwidth, and analytics or other side effects must wait for activation (`document.prerendering` /
`prerenderingchange`).

## INP — Interaction to Next Paint
INP is the slow end of all clicks, taps and key presses in a visit. Each interaction has three parts:
- **Input delay** — the main thread was busy (long tasks from hydration, third-party scripts, timers).
  Fix: break up long tasks (yield with `scheduler.yield()` where available, else `setTimeout(0)` /
  `requestIdleCallback` for non-urgent work), defer or remove third parties, smaller hydration.
- **Processing time** — the handler itself is heavy. Fix: do the visible update first, push the rest later;
  mark non-urgent state updates as transitions (`startTransition` / `useTransition` in React); debounce input
  handlers; avoid big synchronous JSON or DOM work.
- **Presentation delay** — rendering the result is heavy. Fix: smaller DOM, `content-visibility: auto` on
  off-screen sections, virtualise long lists, avoid layout thrashing (batch reads before writes).

Find it: record a trace while doing the slow interaction; in the field, RUM with attribution (the
`web-vitals` attribution build names the target element and the long task).

## CLS — Cumulative Layout Shift
Identify the shifted node AND its cause; the element that moved is often not the one to fix.
| Cause | Fix |
|---|---|
| Images/video/iframes without size | `width` + `height` attributes or CSS `aspect-ratio` |
| Ads, embeds, banners injected above content | reserve the slot (min-height), insert below the fold, or overlay |
| Late content (cookie bar, "load more", personalisation) | reserve space or use an overlay that does not push content |
| Web fonts swapping | `font-display: swap` or `optional` + size-adjusted fallback (`size-adjust`, `ascent-override`) or preload the critical font |
| Animations of layout properties | animate `transform`/`opacity` only |

Shifts within 500 ms after a user input do not count; shifts during a session window add up (max 5 s window).

## Framework quick fixes
- **Next.js:** `next/image` with `priority` on the LCP image and real `sizes`; `next/font` for self-hosted
  fonts; `next/dynamic` for heavy client-only widgets; `next/script` with `strategy="lazyOnload"` for third
  parties.
- **React (any):** hero image as a plain `<img fetchpriority="high">` in server HTML; `useTransition` /
  `useDeferredValue` for expensive updates; no components defined inside components.
- **Vue / Nuxt:** `NuxtImg` with `preload` on the hero; async components for heavy widgets; CSS
  `aspect-ratio` for media.
- **Astro / static:** ship zero JS by default; hydrate islands with `client:visible` / `client:idle`.
