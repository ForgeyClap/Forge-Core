# Structured data (JSON-LD)

Part of `forge-web-quality`.

## Principles
1. **Accurate:** the markup describes only content a visitor can see on that page, and stays in sync with it
   (price, availability, dates, ratings). Never invent reviews, ratings or FAQs to earn a rich result.
2. **JSON-LD** in a `<script type="application/ld+json">` block (head or end of body), rendered on the server.
3. **Most specific type** that fits, absolute URLs, stable `@id` values so nodes can reference each other.
4. **Check support first.** schema.org validity says nothing about whether a search engine still shows a
   feature. Look up Google's current "search gallery" list before adding a type for a rich result, and re-check
   on every project: features are retired regularly (examples: HowTo rich results ended in 2023, the sitelinks
   search box in 2024, and FAQ rich results were reported retired in 2026 — verify the current state). A
   retired type may still be kept when it truly describes the content for other consumers; just do not
   promise a rich result, and do not remove other, still-supported markup.
5. **Validate the rendered page**, not the template.

## Common types (required properties first)
| Type | Use on | Required | Worth adding |
|---|---|---|---|
| Organization | homepage / about | name, url | logo, sameAs, contactPoint |
| WebSite | homepage | name, url | alternateName (site name) |
| BreadcrumbList | deep pages | itemListElement (position, name, item) | — |
| Article / BlogPosting | posts, news | headline, image, datePublished, author | dateModified, publisher |
| Product | product pages | name, image, offers (price, priceCurrency, availability) | sku, brand, aggregateRating, review (only real ones) |
| SoftwareApplication | app pages | name, offers | operatingSystem, applicationCategory |
| LocalBusiness | location pages | name, address | geo, openingHours, telephone |
| Event | events, webinars | name, startDate, location | endDate, eventStatus, offers |

Dates in ISO 8601, URLs fully qualified, enumerations exact (`https://schema.org/InStock`).

## Several types on one page
Use one block with an `@graph` array (for example Organization + WebSite + BreadcrumbList + the page's main
entity), linking nodes by `@id` rather than repeating them.

## Validation
- Google Rich Results Test: only Google-supported features, on the live URL or pasted rendered HTML.
- Schema Markup Validator (validator.schema.org): general vocabulary validity.
- Search Console enhancement reports after launch (owner access).
- Typical errors: missing required property, wrong date/URL format, markup that does not match the page.

## Detecting JavaScript-injected schema
A plain HTTP fetch (curl, a fetch tool) only sees the server HTML. If a framework, tag manager or plugin injects
JSON-LD in the browser, a plain fetch reports "no schema" wrongly. Check in a rendered browser: query
`script[type="application/ld+json"]` in the DOM, or use the Rich Results Test, before reporting it missing. Also
prefer server rendering of schema: crawlers that do not run JavaScript never see injected markup.

## Implementation paths
- Static sites: JSON-LD in the layout/partials, filled from page front matter.
- React / Next.js / Nuxt: a small component that serialises a typed object to JSON-LD on the server; escape
  `<` in the JSON so user content cannot break out of the script tag.
- CMS (WordPress etc.): the SEO plugin's schema output or custom fields mapped to properties; check that the
  plugin and the theme do not both output the same type.

## Output when adding schema
The complete JSON-LD block, which feature it targets and whether that feature is currently supported, the
validator results, and the list of required + recommended properties with their source on the page.
