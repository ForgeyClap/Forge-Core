# Technical SEO — crawl, index, canonical, metadata

Part of `forge-web-quality`. Audits are read-only: GET/HEAD on public URLs only.

## Crawl vs index vs links (the most common mix-up)
| Tool | Controls | Stops indexing? |
|---|---|---|
| `robots.txt` Disallow | which paths a crawler may fetch | No — a blocked URL can still be listed (without snippet) |
| `noindex` (meta robots or `X-Robots-Tag` header) | whether a fetched page is indexed | Yes, but only if the crawler can fetch the page |
| `nofollow` | link signals only | No |
| `rel="canonical"` | which URL represents a group of duplicates | No — it is a strong hint, not a block |

So: never Disallow a page that carries `noindex`; never use robots.txt, `noindex` or a removal tool as a
substitute for a canonical or redirect.

## robots.txt
- At the site root, UTF-8, RFC 9309. `Disallow`/`Allow` take root-relative paths; `Sitemap:` takes an absolute
  URL. Paths are case-sensitive; the most specific rule wins.
- Block only paths with no crawl value (`/admin/`, `/api/`, staging, temp). Never block CSS, JS, images or the
  framework asset folder (`/_next/`, `/assets/`): the renderer needs them.
- robots.txt is public and advisory; it is not access control.
- AI crawlers: set rules per user agent and check each vendor's current documentation. Separate search/answer
  crawlers (e.g. OAI-SearchBot, PerplexityBot, Claude-SearchBot, user-triggered fetchers) from training
  crawlers (e.g. GPTBot, ClaudeBot); `Google-Extended` affects Gemini use, not Google Search. Which ones to
  allow is an owner decision, written down.
- `llms.txt` is an optional, unstandardised proposal; never a priority over crawlable HTML.

## Pages that usually get `noindex`
Login/sign-up/password reset/account (login: `noindex, nofollow`), admin and staging, thank-you and checkout
confirmation (`noindex, follow`), internal search results and filter combinations, the 404 page. Keep them out
of the sitemap.

## Canonicals — the variant matrix
Pick the preferred form once (scheme, host, trailing slash, case) and test real URLs of every template:
| Dimension | Variants | Expected |
|---|---|---|
| Scheme | http / https | one permanent redirect to https |
| Host | www / apex / aliases | one host |
| Slash | `/page` / `/page/`, `/a//b` | one convention |
| Default document | `/docs/` / `/docs/index.html` | converge when content is the same |
| Extension | `/guide.html` / `/guide` | old alias redirects to the matching page, not the homepage |
| Case | `/Guide` / `/guide` | converge unless they are really different resources |
| Tracking | `?utm_*`, `gclid` | analytics still works; canonical is the clean URL |
| Combined | any mix of the above | ONE hop to the final URL, no chains |

Decision rules: a duplicate that should disappear → 301/308 redirect; a duplicate that must stay reachable →
`rel="canonical"`; every canonical page → self-referencing absolute canonical; PDFs → canonical `Link` header;
paginated pages → each page its own canonical (never all to page 1); a parameter that changes the content is
a separate page, not a duplicate. Canonical targets are absolute, return 200, are indexable and agree with
internal links, the sitemap, hreflang and structured-data URLs. Check that client-side code does not rewrite
the server canonical.

Record per sample URL: requested URL, status and every redirect hop, final URL, canonical found, indexable yes/no.

## XML sitemap
- Only canonical, indexable, 200 URLs, absolute and on the same host. Max 50,000 URLs or 50 MB uncompressed per
  file; above that a sitemap index (split by type or language).
- `lastmod` = the real last content change in W3C date format; never the build time for every URL (search
  engines then ignore it). `changefreq` and `priority` are hints at best; leave them out rather than guess.
- Referenced from robots.txt. Submitting it in Search Console is an owner action.

## Status codes and removals
Moved → 301/308 to the closest replacement. Gone for good, no replacement → 410. Unsure → 404. A page that says
"not found" or is empty but returns 200 is a soft 404: return a real 404, or give it real content, or `noindex`.

## Rendering strategy
Content, links, title, meta and canonical must be in the initial HTML. Many AI crawlers do not run
JavaScript, and Google renders it later in a queue.
| Content | Rendering |
|---|---|
| Marketing, blog, docs | static (SSG) or incremental (ISR) |
| Product, news, often-changing | server rendering (SSR) or ISR |
| Dashboard, account (no search value) | client rendering is fine, plus `noindex` |
Tabs, accordions and carousels: all content in the DOM at load (show/hide with CSS or `<details>`); content
loaded only on click is not indexed. Navigation links are real `<a href>` in the HTML.

## On-page metadata
- `<title>`: unique per page, topic first, brand last when it helps; ~50–60 characters is a lint signal, not a
  limit (Google cuts by pixel width and may rewrite it).
- Meta description: unique, specific, ~150–160 characters as a signal; Google may show page text instead.
- One clear primary heading (`h1`) and a logical heading order without skipped levels.
- Descriptive anchor text (never "click here"); no broken internal links; breadcrumbs on deep sites.
- Images: descriptive file names and `alt` text (empty `alt` for decoration), dimensions set.
- Open Graph title/description/image and a canonical on every shareable page.
- URLs: lowercase, hyphenated, readable, few parameters, always HTTPS; no mixed content; HSTS where the owner
  approves it.

## Mobile
`<meta name="viewport" content="width=device-width, initial-scale=1">` and never disable zoom; same content as
desktop; tap targets about 48×48 px; base text 16 px; no horizontal scroll at 360 px.

## International
- `<html lang>` on every page (region where it matters, e.g. `nl-NL`, `nl-BE`).
- `hreflang` alternates on every language version, each pointing to all others AND itself, plus `x-default`;
  return links must exist on the other side; the canonical stays within the same language. Large sites keep
  hreflang in the sitemap (`xhtml:link`) instead of the HTML head.
- Pick language by the browser setting or an explicit switch, never by IP alone.
