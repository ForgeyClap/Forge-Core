---
name: forge-prediction
description: "Playbook for predictions and sports data: odds, backtests, no betting (gebruik bij voorspellingen)."
# A10 original description (listing budget): "Playbook for predictions and sports data: odds, backtests, confidence labels, no betting (gebruik bij voorspellingen)."
---

# Forge playbook — Prediction / sports-data

## When to use
- Use for: prediction and sports-data systems, including Telegram delivery.

## Hard rules
- **Never claim certainty.** Every output carries a confidence/risk label.
- **No automatic real-money betting / no auto-stake code path.**
- Backtest before trusting any model; show sample size.
- Verify data-source quality; track all assumptions.
- Telegram token in env only; one message format, tested.

## Team (conditional)
Lead: `mle-reviewer` + `planner`. Specialists: `mle-reviewer`, `python-reviewer`, `silent-failure-hunter` (data gaps look like clean zeros), `database-reviewer` (data store).

## Skills / commands / MCP
`systematic-debugging`, `/test-coverage`. For delivery, defer to `forge-n8n` or a Telegram layer (Telegram bots fold in here).

## Fan-out & flow
L3.
**Parallel:** data ingestion ∥ model/stat logic ∥ delivery formatting.
**Serial:** ingest → backtest → value/odds calc → uncertainty labeling → delivery.

## Domain gates
Data sources + quality verified; statistical logic reviewed; backtesting done; odds/value checked; confidence/risk labels on every output; assumptions documented; data freshness check.

## Ship-readiness (unique)
Backtest results shown with sample size; every output labeled with confidence/risk; assumptions + data-quality notes attached; **no auto-bet path**; Telegram message format tested. The `ship-readiness` prediction + Telegram checklists are advisory; optionally run `codex-reviewer` (Codex) on important code — not a blocker.

## Safety, approval and honesty
- Approval / safety: no automatic real-money betting / no auto-stake code path.
- Approval / safety: Telegram token in env only.
- Honest failure: never claim certainty: every output carries a confidence/risk label; backtests show sample size.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.
