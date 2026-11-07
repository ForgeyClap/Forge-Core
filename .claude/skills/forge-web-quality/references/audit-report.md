# Audit order, site-type checks, report format

Part of `forge-web-quality`.

## Audit priority order
1. **Crawl and index** — robots.txt, noindex on important pages, status codes, redirects, canonicals,
   sitemap, content in initial HTML. A page that cannot be indexed makes everything else irrelevant.
2. **Technical foundations** — Core Web Vitals, HTTPS/mixed content, mobile rendering, broken links.
3. **On-page** — titles, descriptions, headings, internal links, image alt text, structured data.
4. **Content quality** — thin, duplicate or stale pages (report; content work is the owner's/copywriter's).
5. **Authority and links** — out of scope for Forge beyond noting it.

## Site-type checks
- **Shop:** thin category pages; duplicate product descriptions; Product schema with real offers; faceted
  filter URLs (canonical or noindex, kept out of the sitemap); out-of-stock pages kept (with availability) or
  redirected, not 404'd blindly.
- **SaaS / product site:** feature pages with real content; docs and blog linked to the product; app/account
  area `noindex`.
- **Blog / content:** stale posts, two pages competing for one topic, weak internal linking, dates in schema.
- **Multilingual:** hreflang return links and self-reference, valid language codes, canonical per language,
  untranslated main content.
- **Local business:** consistent name/address/phone across pages and schema; LocalBusiness markup; one page
  per real location.

## Report format
1. **Summary:** overall state in two lines, the top 3–5 issues, the quick wins.
2. **Measurements:** a before/after table — page, metric, value, conditions (device, network, cache, build),
   source (field/lab), date. Localhost rows say "local, indicative".
3. **Findings**, grouped technical / on-page / content, each with:
   `Issue · Impact (high/medium/low) · Evidence (URL, header, trace line, screenshot path) · Fix · Priority`.
4. **Action plan** in four tiers: critical blockers → high-impact → quick wins → longer-term.
5. **Pending:** what needs field data, search-engine re-crawl or owner access to confirm.

## Attempt log (keep every attempt, reverted ones too)
| # | Change | Baseline → result (same conditions) | Verdict (keep/revert) | Why |
|---|---|---|---|---|
| 1 | hero image to AVIF + fetchpriority | LCP 3.4 s → 2.6 s (lab, Moto G profile, cold) | keep | > noise, tests green |
| 2 | preload second font | LCP 2.6 s → 2.7 s | revert | no gain, competes with hero |

Store it in the run's report or a `PERF.md` in the project so failed ideas are not tried again.

## Common excuses to reject
- "It's fast on my machine" — measure on a throttled mobile profile and in the field.
- "The fix is obvious, no need to profile" — then measuring it costs one minute; do it.
- "Keep it, it's already written" — neutral changes add risk without gain; revert.
- "Lighthouse is 100, so we're done" — a lab score is not the field p75, and not INP.
- "Add an index/cache/preload just in case" — only for a measured bottleneck.
