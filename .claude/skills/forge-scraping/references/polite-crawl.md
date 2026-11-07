# Polite, incremental and resumable crawls

## Before the first request

- Read the site's terms and `robots.txt` and write a short note (`notes/robots-check.md`, the evidence the
  scraping domain gate asks for): which paths are allowed, the crawl delay, who owns the data, and why this
  use is permitted. Unclear → stop and ask.
- Also check rules aimed at AI agents in `robots.txt` (named AI user agents). If the site opts out of AI
  collection, treat that as a no unless the owner has the site owner's permission.

## robots.txt in the collector

- Fetch `robots.txt` once per domain at the start (and on the first request to a domain found mid-crawl),
  cache it for the run.
- Drop every disallowed URL before it is requested and count it (`robots_disallowed`); never fetch it "just
  to see".
- `Crawl-delay` and `Request-rate` are a floor: the effective delay is the larger of the robots value and
  your own setting. Robots can only make you slower.

## Pacing

- Per-domain concurrency 1 by default, 2 at most without a reason in the work package. A global limit on
  top when several domains run at once.
- A fixed delay with a little random jitter is the baseline. Better is an adaptive throttle per domain:
  - start slow (a few seconds), then move the delay toward the time the server takes to answer;
  - a latency spike raises the delay at once; recovery is gradual;
  - every non-2xx answer or blocked-looking page **doubles** that domain's delay up to a cap (a `429` or
    `403` often answers faster than real content, so latency alone would speed you up — wrong);
  - honour `Retry-After` even when it is above your cap (raise the cap, or stop);
  - two blocked answers in a row on the same domain: stop that domain for the run (see
    `failure-states.md`).
- Identify yourself: a descriptive User-Agent with a project name and a contact address (owner-chosen, not
  a personal address in the repo). Never a random or rotated browser User-Agent to blend in.

## Incremental crawls (do less work every run)

- Keep a "seen" store keyed by a canonical URL (lower-case host, sorted query, tracking parameters removed)
  or by a content id the site gives you. Dedupe before storing, not after.
- Send conditional requests when the server supports them (`If-None-Match` with the stored ETag,
  `If-Modified-Since` with the stored Last-Modified); a `304` costs the site almost nothing.
- Use the site's own change signals first: sitemap `lastmod`, feed dates, "sort by newest" listings with a
  stop when you reach an item you already have.
- Cache raw responses for the run so a parser fix does not need a second crawl.

## Resumable crawls (pause, crash, usage limit)

- Give the crawl a state folder inside the project scratch or run folder (`_scratch/` or the run's
  folder, never the OS temp of another project). It holds two things: the pending queue and the set of
  request fingerprints already done (plus the per-domain robots cache if you like).
- Write a checkpoint every N requests or every couple of minutes, and on a graceful stop (Ctrl+C: finish
  in-flight requests, write, exit; a second Ctrl+C exits at once). Write to a temporary file in the same
  folder, then rename over the old checkpoint, so a crash never leaves a half-written state.
- Keep the state plain JSON (strings, numbers, arrays). Anything that cannot be written to JSON (a parsed
  page object, a socket) must not live in the queue.
- On start: a checkpoint present → restore queue and seen set, skip the seed URLs, and say "resuming from
  checkpoint (N pending, M done)". No checkpoint → start from the seeds.
- On a clean finish, delete the checkpoint (the run report keeps the totals). On a paused or failed run,
  keep it and report `partial`.
- Learned throttle delays need not be checkpointed; after a resume start slow again.

## Run report (every run)

Counts, never only "done": requested, ok, not-modified, items stored, duplicates skipped, schema failures,
robots-disallowed, offsite-dropped, blocked, changed-layout, errors, and the final status from
`failure-states.md`. These counts are the evidence for the "failures surface loudly" gate.
