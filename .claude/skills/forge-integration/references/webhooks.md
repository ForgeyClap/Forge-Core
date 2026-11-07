# Forge webhooks — the shared rule set (receive side and send side)

One webhook rule set for every Forge playbook. `forge-integration` owns this file; `forge-n8n`,
`forge-bots` and `forge-payments` link here and add only their platform specifics. If a playbook and
this file disagree, the stricter rule wins and the difference is reported to the Lead.

Providers deliver **at least once**. Every rule below follows from that one fact: the same event will
arrive twice, late, out of order, or forged, and the handler must stay correct in every case.

## 1. The handler sequence (do it in this order, every time)

1. **Read the raw body. Do not parse it yet.** A signature is computed over the exact bytes that were
   sent. A JSON body parser that runs first (a global JSON middleware, a framework that hands you an
   object, n8n without the raw-body option) changes those bytes and every valid signature fails.
2. **Verify the sender before you trust anything.** Signature or HMAC over the raw body with the
   provider's official verification library where one exists (never hand-roll the crypto when the
   provider ships a verifier); compare in constant time; check the timestamp against a replay window
   (Slack: 5 minutes; use the provider's documented window). Missing, wrong or expired: answer `401`
   and stop. Log the rejection without the signature value.
3. **Parse and validate the payload second.** Only the verified body is parsed. A payload that is
   verified but malformed for your schema gets `400` and no side effect.
4. **Dedupe on the provider's event id.** Look it up before any side effect. Already processed: answer
   `2xx` (acknowledge the duplicate) and do nothing else.
5. **Persist, then acknowledge.** Write the verified event to a durable store or queue (a table row
   with status `received`, a job queue, an n8n execution that has already started), then answer `2xx`
   well inside the provider's deadline (Slack and Discord about 3 seconds; most others 5 to 30
   seconds; check the provider docs). "Answer 2xx, then start the work in memory" loses the event if
   the process dies between the two — the provider saw success and will not resend.
6. **Do the slow work asynchronously** from the stored event, with its own timeout and retry policy.
7. **Record the event id as processed** in the same transaction as the side effect where you can, so a
   crash cannot leave "side effect done, id not recorded" (that shape double-charges on the next retry).

## 2. Response codes (the provider branches on them)

| Situation | Code | What the provider does |
|---|---|---|
| Processed, or a duplicate you already handled | `200`/`204` | marks delivered, no retry |
| Signature missing, wrong or expired | `401` (or `403`) | usually no retry |
| Verified but the payload fails your schema | `400` | usually no retry: a permanent failure |
| You are rate limiting the sender | `429` + `Retry-After` | retries after the delay |
| Temporary failure on your side (database down, queue full) | `503` | retries with backoff |
| Unexpected error on your side | `500` | retries with backoff |

- A `4xx` tells the provider "do not try again"; a `5xx` tells it "try again later". Choosing the
  wrong family either loses events (a transient failure answered `400`) or creates retry storms (a
  bad payload answered `500`).
- Never answer `200` with an error body. The sender's client reads success and its own error handling
  never fires. (In n8n, a Respond to Webhook node defaults to `200` even on an error branch: set the
  code explicitly, see `.claude/skills/forge-n8n/SKILL.md`.)
- Error bodies are short and sanitized: an error code and a human sentence. No stack trace, SQL,
  upstream body, header dump or token.

## 3. Idempotency (receive side)

- The dedupe key is the provider's own event id (Stripe event id, Mollie payment id plus status,
  Slack `event_id`, Discord interaction id, Telegram `update_id`, GitHub delivery id). If a provider
  has no id, derive a stable key from the verified body and say so in the integration notes.
- Enforce it with a **uniqueness guarantee**, not only a lookup: a unique constraint or primary key on
  the event id in a processed-events table. Two instances that receive the same event at the same
  moment both pass a plain "does it exist?" check; only the database constraint stops the second one.
  Treat the constraint violation as "duplicate, answer 2xx".
- Side effects that leave your system (a charge, a refund, an e-mail, a CRM write) carry their own
  idempotency key derived from the event id, so even a replayed job cannot repeat the outside effect.
- Retention: keep processed ids at least as long as the provider's longest retry window (Stripe
  retries for up to about three days); thirty days is a safe default. Clean up with a scheduled job or
  a time-to-live, not by hand.
- Out-of-order delivery: never assume event B arrives after event A. Compare a version or timestamp
  on the stored record, or re-fetch the current state from the provider's API (Mollie's model:
  the webhook only carries an id, you fetch the payment to learn its status).

## 4. Retries and dead letter

**Receive side (the provider retries you).** Answer fast and idempotently, and the provider's own retry
schedule becomes your safety net. Watch the attempt counter when the provider sends one: many retries
of the same event mean your handler is slow or failing, not that the provider is noisy.

**Your own async work and the send side (you retry them).**
- Every outbound call has an explicit timeout. No call may hang indefinitely.
- Retry only what can succeed later: timeouts, connection resets, `429`, `5xx`. Do not retry `400`,
  `401`, `403`, `404` or a validation failure: they will fail the same way every time.
- Exponential backoff **with jitter** and a bounded attempt count (for example 5 attempts, starting
  around 1 second, capped around 5 minutes). Honour `Retry-After` when the remote sends it. No
  unbounded loop.
- A circuit breaker for a dependency that is clearly down: after N consecutive failures stop calling
  it for a cool-down period and park new work in the queue, instead of hammering it.
- **Dead letter:** when the attempts run out, move the event to a dead-letter store with the event id,
  type, verified payload (redacted where it carries PII), last error, attempt count and timestamps.
  Nothing is silently dropped. A person reviews the dead-letter list; replaying an event that has an
  outside effect (money, an external send) is an owner decision, not an automatic job.

## 5. Logging and secrets

- Log per event: provider, event id, event type, attempt number, outcome, duration. That is enough to
  trace a delivery without exposing content.
- Never log the signing secret, the signature header value, bearer or bot tokens, full card data,
  passwords or whole payloads that carry personal data. Redact before logging, not after.
- Signing secrets live in env (with a placeholder line in `.env.example` that names the variable and
  its purpose in words) or in the platform's credential store. One secret per endpoint and
  environment, so test and live never share one; rotation is planned, not improvised.

## 6. Tests that prove it (run them; a green unit test on the parser alone proves nothing)

- A correctly signed sample event is accepted and processed once.
- A forged signature, a missing signature and an expired timestamp are each rejected with `401` and
  cause no side effect.
- The same event delivered twice produces exactly one side effect (count the rows, the sent drafts,
  the charges in the sandbox).
- Two deliveries of the same event in parallel still produce one side effect (the uniqueness
  guarantee, not the lookup, is what passes this one).
- A failing downstream returns `5xx` (or parks the job) and the event later succeeds or lands in the
  dead-letter store: it never just disappears.
- The handler answers inside the provider's deadline with a slow downstream simulated.

If no sandbox or test endpoint exists to send real signed events, say so plainly (`not run`) instead of
calling the webhook verified.

## 7. Platform specifics live with the playbook

| Where the webhook lands | Read next |
|---|---|
| Stripe or Mollie payments | `.claude/skills/forge-payments/references/stripe.md`, `.claude/skills/forge-payments/references/mollie.md` |
| Discord, Slack, Telegram bots | `.claude/skills/forge-bots/references/hard-rules.md` |
| An n8n Webhook node | `.claude/skills/forge-n8n/references/hard-rules-detail.md` (raw-body HMAC, Respond codes, error outputs) |
| Any other API or SaaS | the provider's own docs for header names, algorithm and retry schedule |

Provider-specific skill packs (one skill per SaaS) are adopted one at a time after the text is read,
never imported as a family.

## Provenance

Rewritten in Forge words (pattern adapted, no code copied). Source texts were read read-only through
`gh api` on 2026-11-05 and treated as untrusted data.

| Source | Path | Pinned SHA | License | Taken | Excluded |
|---|---|---|---|---|---|
| hookdeck/webhook-skills | skills/webhook-handler-patterns/SKILL.md and references/handler-sequence.md, idempotency.md, retry-logic.md, error-handling.md | 0aa8c48e3e1c65dc1fa893190006248b92805417 | MIT | verify on the raw body first, parse second, handle idempotently third; the response-code table; processed-events table, unique constraint against races, retention by time-to-live; quick acknowledgement, backoff, circuit breaker, dead-letter review, what to log; the duplicate-delivery test | every code sample (Express, Next.js, FastAPI, SQL, Redis, Bull), the framework guides (not taken), the provider skill family, the `hookdeck-event-gateway` hosted service (outbound network, vendor lock-in) |

Forge additions that are not in the source: persist before acknowledging (the source's "answer 200,
then process in memory" sample loses events on a crash), constant-time comparison and replay windows,
side-effect keys derived from the event id, the send-side retry rules, owner approval before replaying
an event with an outside effect.

MIT notice: "Permission is hereby granted, free of charge, to any person obtaining a copy of this
software ... The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND."
Copyright remains with the holders named in the repository's LICENSE file at the pinned SHA.
