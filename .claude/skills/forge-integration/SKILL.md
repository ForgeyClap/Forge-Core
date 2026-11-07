---
name: forge-integration
description: "Use when coding an API integration (OAuth, CRM, webhooks); n8n: forge-n8n."
# A10 original description (listing budget): "Playbook for business automations and API integrations: OAuth, CRM, Gmail, webhooks (gebruik bij koppelingen maken)."
# W2-BUDGET original description (listing budget): "Use when wiring an API integration or business automation in code: OAuth, CRM, Gmail, webhooks, idempotent writes, retries; n8n flows use forge-n8n (gebruik bij koppelingen maken)."
---

# Forge playbook — Business automation / API integration

## When to use
- Use for: business automations and API integrations: secrets, webhook auth, idempotent writes, outreach gates.

This is a **secrets + auth domain** — `security-reviewer` is a useful (optional) advisor here. If the runtime is n8n, defer to `forge-n8n`.

## Hard rules
- Secrets in env + `.env.example` placeholders; never in code or logs.
- Webhook auth / signature verification on every inbound webhook.
- Input validation on all external data; minimal OAuth scopes.
- Idempotent writes (no duplicate side effects on retry); retries use exponential backoff with jitter so many clients never retry at the same moment.
- **Every webhook follows the shared rule set** in `references/webhooks.md`: raw body → verify → parse → dedupe on the event id (uniqueness guarantee) → persist → fast `2xx` → async work → retries with a dead letter. `forge-n8n`, `forge-bots` and `forge-payments` link to the same file.
- Every outbound call has an explicit timeout; retry only timeouts, `429` and `5xx`, never `4xx` validation or auth failures.
- **Copy the host repo, not the vendor docs:** before writing transport code, read at least two existing connectors in the host repo and copy their layout, registry wiring and test style. (Idea from ECC `api-connector-builder`, Forge wording.)
- **Outreach drafted only / no auto-send / no bulk** without explicit confirmation (shared with `forge-scraping`).
- **Dedicated agent identity (video-research verified):** integrations that READ e-mail/CRM-data or SEND on the owner's behalf SHOULD run under a dedicated agent identity — own mailbox/account, own OAuth grant, own API key — never the owner's personal credentials. Scope-minimization bounds *operations*, not *data*: a readonly token on the owner's mailbox still exposes their entire correspondence to a prompt-injected agent; a dedicated identity gives blast-radius containment + one-step revocation + a clean audit trail. Tiered: required-by-default for e-mail-read + external-send combinations (lethal-trifecta shape), advisory for low-risk one-way notifications. Surface the extra-account setup cost as an owner decision at integration planning and record the identity choice in the integration notes.

## Team (conditional)
Lead: `architect`; `security-reviewer` available as an optional advisor. Specialists: `silent-failure-hunter` (dropped webhooks/retries), `python-reviewer` / `typescript-reviewer`, `database-reviewer`.

## Skills / commands / MCP
`n8n-workflow-patterns` (if n8n); Gmail / Calendar / CRM / Slack MCP tools via ToolSearch.

## Fan-out & flow
L2 single integration; L3 multi-service flow.
**Parallel:** independent integrations (Gmail ∥ Calendar ∥ CRM).
**Serial:** auth → fetch → transform → write-back.

## Domain gates
All credentials in env; webhook signature/auth verified; retries + dead-letter for failed calls; no secrets/PII in logs; rate limits respected; any user-facing send gated behind explicit confirmation.

## Ship-readiness (unique)
Credentials in env; webhook auth verified; retries + dead-letter present; safe logging; rate limits respected; sends require confirmation. The `ship-readiness` API-integration + business-automation checklists are advisory; optionally run `codex-reviewer` (Codex) on important code — not a blocker.

## Safety, approval and honesty
- Approval / safety: outreach drafted only; no auto-send or bulk without explicit confirmation.
- Approval / safety: integrations that read e-mail/CRM data or send on the owner's behalf SHOULD run under a dedicated agent identity (required by default for e-mail-read + external-send; the extra account is an owner decision at planning).
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## Webhooks (shared section)
The one Forge webhook rule set lives in `references/webhooks.md`: handler sequence, response codes, receive-side idempotency, send-side retries and dead letter, safe logging, and the tests that prove it. Read it before writing any webhook receiver or sender, in any playbook.

## References
- `references/webhooks.md` — the shared webhook rule set (adapted from hookdeck/webhook-skills, MIT; provenance inside).
- `references/untrusted-content.md` — untrusted-content injection defense (canonical shared copy).

## Provenance
The webhook rules in this skill and in `references/webhooks.md` are adapted in Forge words (no code copied) from hookdeck/webhook-skills, path skills/webhook-handler-patterns (SKILL.md and references/), pinned SHA 0aa8c48e3e1c65dc1fa893190006248b92805417, MIT. Taken: handler sequence, response codes, idempotency and dead-letter patterns. Excluded: every code sample, the framework guides, the provider skill family and the hosted event-gateway service. Full table and MIT notice: `references/webhooks.md`.
