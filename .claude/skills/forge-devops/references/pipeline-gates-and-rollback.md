# Pipeline gates, rollout and rollback

Ideas adapted from wshobson/agents cicd-automation deployment-pipeline-design (MIT, (c) 2024 Seth Hobson), in our own
words, plus Forge's owner gates.

## Stages
1. **Build** once; the same artifact (image digest, bundle hash) moves through every environment. Never rebuild per
   environment.
2. **Verify:** lint, typecheck, unit and integration tests, dependency audit (SCA), static analysis (SAST) where the
   project has it, container or filesystem scan.
3. **Preview / staging:** deploy the artifact, run smoke tests and a deep readiness check.
4. **Production:** behind a manual approval (the owner), then progressive rollout.

## Gates
- Automated gates: tests green, coverage not lower than the agreed floor, no critical scan finding, smoke test passes.
- Manual gate: a GitHub environment with required reviewers, or an equivalent platform approval. Without reviewers set,
  the production job waits forever and nobody is told.
- A gate that cannot be evaluated (metric query returns no data) must fail, not hang: set an "inconclusive" limit.

## Rollout strategies
| strategy | when | watch out |
|---|---|---|
| rolling | stateless services, small changes | mixed versions run side by side: APIs and schema must be compatible |
| blue-green | instant switch-back needed | double capacity; shared database must serve both colours |
| canary | risky change, real traffic signal available | needs error-rate / latency metrics and a promotion rule |
| preview per branch | web apps on Vercel / Cloudflare | preview URLs are public unless protected |

## Rollback
- Write the rollback step before the rollout: what command, who runs it, what it restores, what it does NOT restore
  (data, secrets, connected resources such as queues, KV, buckets).
- Migrations: additive and backward-compatible for at least one release; keep a versioned undo script; delay dropping
  columns or tightening constraints until the old version is gone everywhere. Rolling back code without a compatible
  schema causes errors.
- Automated rollback on degraded metrics is advanced (see `forge-guardian` for the pattern); a manual runbook is the
  minimum.

## Thresholds, flags and the post-deploy watch
- Stage plan, advance/hold/roll-back thresholds, the error-budget gate and the flag lifecycle: `rollout-thresholds.md`.
- Read-only checks after each stage: `canary-watch.md`.
- Rollback triggers are written with real numbers **before** the deploy (`ship-readiness` → "Deploy phases"); when one
  fires, `.claude/skills/forge-observability/references/runbooks.md` takes over.

## Troubleshooting
- **Health check green, production broken:** the check was a shallow ping. Use a readiness check that touches the real
  dependencies (database, cache, upstream API) with a short timeout.
- **Canary never promotes:** the metric query returns nothing (renamed metric, wrong label). Fail on inconclusive.
- **Production job never starts:** required reviewers or environment protection not configured, or the branch is not
  allowed by the environment's branch rule.
- **Slow image builds:** dependency manifests copied after the source, so every change busts the dependency layer.
- **Schema mismatch after rollback:** a non-backward-compatible migration shipped together with the code.
