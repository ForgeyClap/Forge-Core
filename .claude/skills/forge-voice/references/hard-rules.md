# forge-voice — hard rules (full text)

## Hard rules
- **Dutch-first when configured for a Dutch client.** The caller-facing conversation is Dutch (natural, spoken Dutch — not translated-English cadence); female/Dutch voice when the owner asks. Code/comments stay English. Confirm language + voice per project.
- **One question at a time.** Ask a single question, wait, listen, then proceed — never stack multiple asks in one turn. Keep prompts short and spoken-natural; design the call as a small set of workflow states, each with one job to do.
- **Natural turn-taking + barge-in.** The caller can interrupt; the agent stops speaking within ~200ms of a real interruption. Keep voice-to-voice latency tight (aim well under ~1s). Handle endpointing / silence gracefully; short, polite closing phrases; no endless loop — end the call cleanly.
- **AI disclosure + recording consent (EU/NL).** Disclose clearly and early that the caller is speaking with an AI (EU AI Act Art. 50, in force Aug 2026). If the call is recorded, get a valid, specific, informed basis — a vague "this call may be recorded" is not enough under GDPR/AVG; record the legal basis. Honour opt-out immediately.
- **One email per call maximum; idempotency before any notification.** At most one outbound email per call, sent only after an idempotency check (a retry/duplicate turn must not fire a second mail). Consent-aware lead capture only.
- **No outbound calls and no SMS without explicit owner approval.** Inbound answering is the default safe mode; outbound dialing, SMS, and any customer traffic are owner-gated, irreversible actions. No autonomous dialing.
- **Honest fallback — no hallucinated business facts.** If the agent doesn't know (price, availability, policy), it says so and offers a human handoff / callback — never invents a business answer on a live call. Secrets (telephony/LLM keys) in env only.
