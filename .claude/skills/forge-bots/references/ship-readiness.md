# forge-bots — ship-readiness (full text)

## Ship-readiness (unique)
Signature/secret verification proven **both ways** — a forged or replayed event is rejected and a genuine one accepted (attach the evidence); fast-ack + background offload demonstrated; dedupe proven against a redelivered id; rate-limit backoff + dead-letter present; scopes/intents listed and minimal; secrets in env with logs redacted; no auto-outreach. Advisory checklist; optionally run `security-reviewer` / `codex-reviewer` on the verification + auth path — recommended, not a blocker. If a platform sandbox/test app wasn't available to exercise real events, say so (not-run), don't imply it passed.
