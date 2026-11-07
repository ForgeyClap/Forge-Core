---
name: forge-payments
description: "Playbook for payments and billing: Stripe, Mollie, refunds (gebruik bij betalingen)."
# A10 original description (listing budget): "Playbook for payments and billing: Stripe, Mollie, webhooks, idempotency, refunds, PCI (gebruik bij betalingen)."
# W2-BUDGET original description (listing budget): "Playbook for payments and billing: Stripe, Mollie, idempotency, refunds (gebruik bij betalingen)."
---

# Forge playbook — Payments / checkout / billing

## When to use
- Use for: payments, checkout and billing: tokenized capture, minor-units money, idempotent charges, verified webhooks.
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules (non-negotiable)
- **No raw PAN, ever.**
- **Integer minor units only.**
- **Idempotency-key per charge (send side).**
- **Signature-verified webhooks (receive side).**
- **Test vs live separation.**
- **Secrets in env + `.env.example` placeholders.**
- **Refunds, disputes, and chargebacks handled explicitly.**

Full text of every rule: `references/hard-rules.md`.

## Team (conditional)
Lead: `integration-boss` (or `build-boss` if payments are one slice of a larger app). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
`claude-api` only if an LLM is in the loop; otherwise gateway SDK docs (Context7 / vendor docs) for exact API + version behavior. Reuse the gateway's official verification library — never hand-roll HMAC. If checkout renders a UI, load `forge-website` for the checkout page (real content, responsive, a11y). If billing runs through n8n, defer webhook handling to `forge-n8n`.

**Provider references (read the one that applies before writing gateway code):** Stripe → `references/stripe.md` (API choice, fulfil-in-webhook, restricted keys, subscription event set); Mollie → `references/mollie.md` (triage, fetch-to-verify webhooks, mandates, refund `409` handling). Both add a Forge-authored idempotency section the vendor skills lack.

## Fan-out & flow
L2 single gateway + one charge flow; L3 subscriptions + refunds + multi-event webhooks + reconciliation.
**Parallel:** checkout/capture path ∥ webhook receiver ∥ refund/void path (independent once the money model + idempotency schema are fixed).
**Serial:** money model (minor units + currency) → tokenized capture → idempotent charge → signature-verified webhook → state machine (auth→capture→refund) → reconciliation/audit trail.

## Domain gates
- No raw PAN/CVV in code, logs, DB, or memory (grep the diff for card-shaped literals + `cardNumber`/`cvv`/`pan`).
- Money is integer minor units + currency everywhere; no float money math.
- Every charge/refund call sends an `Idempotency-Key`; keys are persisted.
- Every webhook verifies the signature on the raw body, dedupes on `event.id`, returns `2xx` before heavy work, and is safe under duplicate/out-of-order delivery.
- Auth / capture / void / full + partial refund each handled explicitly with a clear failure path (timeout + bounded retry, never a silent failure).
- SCA / 3D Secure supported where the market/regulator requires it (EU/EEA cards).
- **Payment-page script integrity (SAQ A r1 / reqs 6.4.3 + 11.6.1):** the checkout page either (a) carries the processor's written confirmation that its embedded solution self-protects against script tampering, or (b) applies script-management + tamper/change-detection on the page that includes the iframe. Record which path is used.
- Sandbox + test-card scenarios exercised (success, decline, 3DS challenge, duplicate webhook) before anything is called production-ready.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: no live charge and no live-key touch without explicit owner approval.
- Approval / safety: gateway and webhook signing secrets in env only.
- Honest failure: never claim PCI compliance or a working live charge that was not verified in the sandbox; if Codex did not run, say so.
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/untrusted-content.md` — Untrusted-content note.
- `references/stripe.md` — Stripe specifics (adapted from stripe/ai, MIT; notice in `LICENSE`).
- `references/mollie.md` — Mollie specifics (adapted from mollie/ai, MIT; notice in `LICENSE`).
- `.claude/skills/forge-integration/references/webhooks.md` — the shared Forge webhook rule set (raw-body verify, dedupe with a uniqueness guarantee, persist before `2xx`, retries and dead letter); the payment rules above stay stricter where they differ.

## Provenance
only a link to the shared webhook section was added here; no external text. That section's own provenance (hookdeck/webhook-skills, pinned SHA 0aa8c48e3e1c65dc1fa893190006248b92805417, MIT) is inside the linked file.
