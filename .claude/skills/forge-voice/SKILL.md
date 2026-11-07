---
name: forge-voice
description: "Playbook for AI voice and phone agents: Twilio, Vapi (gebruik bij een belagent)."
# A10 original description (listing budget): "Playbook for AI voice and phone agents: Dutch-first calls, Twilio, Vapi, TTS/STT (gebruik bij een belagent)."
# W2-BUDGET original description (listing budget): "Playbook for AI voice and phone agents: Dutch-first calls, Twilio, Vapi (gebruik bij een belagent)."
---

# Forge playbook — AI voice / phone agent

## When to use
- Use for: AI voice and phone agents (Dutch client phone agents: booking, reception, callback).
- Not for: the knowledge/answer layer (`forge-rag`) or post-call e-mail/CRM (`forge-integration`).
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules
- **Dutch-first when configured for a Dutch client.**
- **One question at a time.**
- **Natural turn-taking + barge-in.**
- **AI disclosure + recording consent (EU/NL).**
- **One email per call maximum; idempotency before any notification.**
- **No outbound calls and no SMS without explicit owner approval.**
- **Honest fallback — no hallucinated business facts.**

Full text of every rule: `references/hard-rules.md`.

## Team (conditional)
Lead: `integration-boss` (telephony wiring + notifications) with `head-chef`/`build-boss` if there's an app around it. Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
`forge-rag` (grounded answers + citations for the knowledge layer), `forge-integration` (post-call e-mail/CRM, draft-gated + idempotent), `humanizer` (natural Dutch phrasing, on-demand), telephony/voice SDK docs via Context7 (Twilio / Vapi / Retell / LiveKit / ElevenLabs — exact turn-taking + barge-in config). `claude-api` if the dialogue LLM is Claude.

## Fan-out & flow
L2 single inbound flow (answer → intent → one action); L3 multi-intent agent + booking + notifications + knowledge layer.
**Parallel:** telephony/turn-taking wiring ∥ knowledge/answer layer (`forge-rag`) ∥ post-call notification (`forge-integration`) — independent once the conversation-state contract is fixed.
**Serial:** conversation design (states, one-question-per-turn, Dutch prompts) → AI disclosure + consent → intent/slot filling → action (book/callback) → single idempotent notification → clean close.

## Domain gates
- Dutch-first caller experience verified (spoken-natural, correct voice) when configured for a Dutch client.
- Exactly one question per turn; barge-in works and cuts TTS within ~200ms; latency measured, not assumed.
- AI disclosure present + early; recording consent basis recorded; opt-out honoured immediately.
- ≤1 email per call; notification path is idempotent (a retried turn sends zero extra mails); lead capture consent-aware.
- No outbound/SMS/customer traffic enabled without owner approval (verify none was auto-enabled).
- Unknown → honest fallback + human handoff; no invented business facts; secrets in env.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: no outbound calls and no SMS without explicit owner approval; at most one email per call, idempotent.
- Approval / safety: AI disclosure and recording consent (EU/NL).
- Honest failure: never claim a live call worked unless a real call was placed and observed; label anything not exercised not-run.
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/untrusted-content.md` — Untrusted-content note.
