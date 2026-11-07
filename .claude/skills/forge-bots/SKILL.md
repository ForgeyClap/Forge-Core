---
name: forge-bots
description: "Use when building a Discord, Slack or Telegram bot in code; n8n bots: forge-n8n."
# A10 original description (listing budget): "Playbook for Discord, Slack and Telegram bots: commands, webhooks, signatures, scopes (gebruik bij een bot bouwen)."
# W2-BUDGET original description (listing budget): "Use when building a Discord, Slack or Telegram bot in code: verified events, fast ack, dedupe, minimal scopes; n8n bots use forge-n8n (gebruik bij een bot bouwen)."
---

# Forge playbook — Chat / messaging bots (Discord · Slack · Telegram)

## When to use
- Use for: Discord, Slack and Telegram bots: per-platform event verification, fast ack, dedupe, minimal scopes, send-side retries.
- Not for: the shared OAuth/secret/webhook backbone (lead it through `forge-integration`); bots that run through n8n (`forge-n8n`).
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules (non-negotiable)
- **Verify every inbound event — per platform, on the raw body, before acting.**
- **Fast ack, background work.**
- **Idempotent handling — dedupe on the platform id.**
- **Minimal scopes / intents / permissions.**
- **Retries + dead-letter on the send side.**
- **Safe logging — no token/PII leak.**
- **Ignore the bot's own messages (no self-loop).**
- **Outreach drafted only.**

Full text of every rule: `references/hard-rules.md`. The shared webhook rule set (sequence, response codes, dedupe with a uniqueness guarantee, persist before ack, dead letter) is `.claude/skills/forge-integration/references/webhooks.md`; this playbook adds only the per-platform details.

## Team (conditional)
Lead: `integration-boss` (a bot is an external-system/webhook integration; use `build-boss` if the bot is one slice of a larger app). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L1/L2 for a single-platform bot with a few commands; L3 for multi-platform or many interactions + background jobs.
**Serial:** register app + minimal scopes/intents → raw-body signature/secret verification → fast ack + dedupe → command routing → background processing + outbound retries → dead-letter.
**Parallel:** independent command handlers ∥ per-platform adapters (independent once the *verified-event* contract is fixed — the verified, deduped event is the contract).

## Domain gates
- Every inbound webhook/interaction verifies the platform's auth on the **raw body** (Discord Ed25519 + PONG; Slack HMAC `v0` + ≤5-min replay window; Telegram secret-token header); unsigned/expired/forged events are rejected.
- Ack returned within the platform deadline (Slack/Discord ~3s, Discord defers long work); heavy logic runs in the background.
- Redelivered events deduped on `interaction.id` / `event_id` / `update_id` with a uniqueness guarantee.
- Outbound calls honor rate limits (429 + `Retry-After`), retry with bounded backoff, and dead-letter permanent failures — no silent drop.
- Scopes/intents/permissions minimal; no privileged Discord intents or broad Slack scopes without justification + approval.
- No token / signing secret / PII in logs; secrets in env.
- No unsolicited DM / broadcast / mass-mention; any outreach is drafted-only until owner approves.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: no unsolicited DMs, mass-mentions or broadcasts without explicit owner approval; outreach drafted only.
- Approval / safety: privileged Discord intents or broad Slack scopes only when truly needed and owner-approved.
- Approval / safety: bot token and signing secrets in env; logs redacted.
- Honest failure: never claim a bot is "live"/"verified" unless a signed event was accepted and a forged one rejected.
- Honest failure: no platform sandbox/test app to exercise real events: say so (not-run).
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/untrusted-content.md` — Untrusted-content note.
- `.claude/skills/forge-integration/references/webhooks.md` — the shared Forge webhook rule set.

## Provenance
the self-loop rule is an idea from n8n-io/skills (skills/n8n-ai-nodes-official/SKILL.md, pinned SHA 27b6b9f429ac0be90cae764512dbc579d7107e95, Apache-2.0; idea only, no text reused); the persist-before-ack rule is a Forge addition. The webhook link points at the shared section, whose own provenance (hookdeck/webhook-skills, MIT) is inside that file. Excluded: all upstream code and workflow JSON.
