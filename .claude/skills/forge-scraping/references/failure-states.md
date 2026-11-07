# Honest failure states and what is excluded on purpose

A scraper that fails quietly returns an empty list, and an empty list looks like "nothing new". Every run
ends in exactly one of the states below, and the run report names it.

## Run states

| State | What it means | What the collector does |
|---|---|---|
| `ok` | Pages fetched, records valid, counts in the normal range | Store, report counts. |
| `empty` | Zero records | A failure until proven otherwise: compare with the last good run and a fixture. Only a page that really says "no results" counts as a true empty, and the report says why. |
| `blocked` | 401, 403, 407, a persistent 429, a login wall, a paywall, a CAPTCHA or challenge page, an explicit "automated access not allowed" | **Stop that domain.** Record URL, status and the marker that matched. No retry with another identity, proxy or browser. Next step for a human: official API, export, licensed data, or permission from the site owner. |
| `changed-layout` | A required selector found nothing, or adaptive relocation was used | Relocated above threshold → warning plus the score; below → failure. Never store guessed fields. |
| `robots-disallowed` | URLs dropped by `robots.txt` | Counted, not fetched. |
| `partial` | Paused, crashed or hit a page or time cap | Checkpoint kept, counts so far, "resume to continue". |
| `error` | Network failure, timeout, 5xx after the normal retries, parse crash | Retry only ordinary transient errors (timeouts, 502, 503, 504) a few times with backoff; then report. |

## Poison-pill pages (a 200 that is not data)

Many blocks come back as `200 OK` with a page that is not the content: "Just a moment", "checking your
browser", "verify you are human", "enable JavaScript and cookies", "subscribe to continue", "sign in to
see", a cookie wall with no content, or a body far smaller than the usual page. Check every response for
these markers before parsing. A match is `blocked` (or `changed-layout` when it is a cookie wall the site
also shows humans), never a set of empty records. Keep the marker list per project and add to it when a
new one is seen.

## Excluded on purpose (Forge rule: public or permitted sources only)

These features exist in popular scraping tools, including Scrapling (its stealth fetcher, Cloudflare
solver, canvas noise and impersonation options) and anti-detect browser skills in the corpus. Forge does not
teach, build or run them, whatever the tool offers, because each one exists to defeat a site's own access
control:

- stealth or "undetected" browser modes, fingerprint spoofing (TLS/JA3, canvas, WebGL, WebRTC, fonts),
  browser impersonation and rotated fake User-Agents meant to blend in;
- anti-bot evasion: Cloudflare Turnstile or interstitial solvers, WAF bypass, reusing challenge-clearance
  cookies;
- CAPTCHA solving, by code or by a paid solver service;
- proxy rotation, residential or mobile proxies, "upgrade the proxy when blocked" retry chains, and multi-
  account scraping, when used to get around blocks or rate limits;
- login or paywall circumvention, reusing someone else's session cookies, scraping after a cease-and-desist
  or an explicit block;
- storing real cookies or tokens in skill files, references or "vaults" in the repo.

Rendering JavaScript in a normal, honestly identified browser for content you may read is allowed (fetcher
rung 4). Using a proxy that the owner's network itself requires is allowed when the owner configures it;
using one to dodge a block is not.
