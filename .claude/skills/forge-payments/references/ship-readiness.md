# forge-payments — ship-readiness (full text)

## Ship-readiness (unique)
Tokenized/hosted capture proven (no PAN on server); minor-units money verified; idempotency key on every charge with a persisted store; webhook signature verification + `event.id` dedupe proven against a replayed event; auth→capture→refund state transitions have an audit trail (no card data stored); test-mode fully separated from live; **no live charge performed without explicit owner approval**; sandbox test output attached as evidence. Advisory checklist — optionally run `codex-reviewer` on the charge + webhook code (strongly recommended here); not a blocker, but if Codex was not run, say so.
