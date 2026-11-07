---
name: forge-mlops
description: "Playbook for production ML: model registry, serving, drift (gebruik bij ML in productie)."
# A10 original description (listing budget): "Playbook for production ML (opt-in Python): model registry, serving, drift, rollback (gebruik bij ML in productie)."
# W2-BUDGET original description (listing budget): "Playbook for production ML (opt-in Python): model registry, serving, drift (gebruik bij ML in productie)."
---

# Forge playbook — Production ML / MLOps

## When to use
- Use for: production ML: reproducible training, versioning, train/serve parity, evaluation, drift monitoring.
- Domain framing, team roles and honesty rule: `references/overview.md`.

**Do not duplicate ECC skills — defer to:** `systematic-debugging` (pipeline/training failures), `/test-coverage` (data-validation + feature-code tests), `forge-data` (the upstream ETL/feature pipeline), `forge-prediction` (uncertainty labeling + no-auto-bet rules when the model informs a betting/forecast decision). This file is orchestration only.

## Hard rules
- **Decision note before training.**
- **Metric selection by mistake cost.**
- **Reproducible training.**
- **Model versioning + working rollback.**
- **No train/serve skew.**
- **Offline + online evaluation before promotion.**
- **Drift + decay monitoring.**
- **No automatic real-money / irreversible / outward-facing action — ever.**

Full text of every rule: `references/hard-rules.md`.

## Team
Lead: `build-boss` (or `integration-boss` when serving wires into external systems). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L3 (a real production ML system is inherently multi-component).
**Parallel:** data-validation gate ∥ feature pipeline ∥ offline-eval harness ∥ drift/monitoring scaffolding (independent once the feature contract + metric are fixed).
**Serial:** data validation → feature engineering (versioned, parity-checked) → reproducible training → offline eval vs incumbent → register + version artifact → shadow/canary online eval → monitored rollout → **owner-gated promotion**. The go-live decision is a human checkpoint, not a pipeline step.

## Domain gates
Training reproducible (seed + pinned deps + versioned data/config regenerate the metric); model versioned in a registry with a tested rollback + fallback; no train/serve skew (feature parity proven); data-validation gate at entry; offline eval compares against the incumbent with the right metric + validation scheme; online eval via shadow/canary before any promotion; feature/prediction drift + performance decay monitored with alerts and defined retrain triggers; serving has health checks/timeouts/bounded retries; **no auto real-money/irreversible action path exists**; no secrets in pipeline code or artifacts.

## Ship-readiness
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: promotion to production is owner-gated; no automatic real-money / irreversible / outward-facing action.
- Approval / safety: no secrets or credentials in pipeline code or model artifacts.
- Honest failure: no Python/ML env or serving infra: label training, metrics, canary and monitors not-run.
- Untrusted content: see `references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/untrusted-content.md` — Untrusted-content note.
- `references/iteration-and-promotion.md` — iteration compact, observation ledger, error-analysis loop, data contract, fail-closed promotion gates.
