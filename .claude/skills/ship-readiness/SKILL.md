---
name: ship-readiness
description: "Use before a deploy, go-live or client handoff (live zetten, klaar voor productie)."
# A10 original when_to_use (listing budget): "Triggers: live zetten, opleveren, klaar voor productie, deploy, ship, go live, release, hand off."
# W2-BUDGET original description (listing budget): "Use before a deploy, go-live or client handoff (live zetten, opleveren, klaar voor productie): advisory pre/deploy/post checklist, rollback triggers set first. Not versioning or tags."
---

# Ship-readiness (advisory checklist — not a blocker)

This is a **practical checklist**, not an enforced gate. Report items as pass/fail with evidence — never assert without checking. Nothing here blocks a build; it just helps you not hand off something broken. **Production deploys should still have explicit user approval.**

## Deploy phases (when something goes live)
Decide the rollback triggers **before** the deploy, not during it. Full fill-in template: `references/deploy-phases.md`.
- **Pre-deploy:** CI green on the exact commit; reviewed; no known critical bug; migrations tested and backward-compatible for one release; flags set (off by default); rollback plan written; rollback triggers written with real numbers (error rate over <X> %, p95 latency over <X> ms, <critical flow> fails); who watches the first hour named; owner approval for production recorded.
- **Deploy:** preview or staging first plus smoke tests; production only on the owner's go; staged rollout where the project has flags or traffic splitting (stages and thresholds: `.claude/skills/forge-devops/references/rollout-thresholds.md`); watch error rate and latency during the rollout.
- **Post-deploy, first hour:** health route answers 200; no new error types in error tracking; latency at baseline; the critical user flow done by hand; logs arriving and readable; rollback confirmed ready (flag off-switch tested or previous artifact known). Read-only watch: `.claude/skills/forge-devops/references/canary-watch.md`. A trigger fires → stop the rollout, tell the owner, open the runbook (`.claude/skills/forge-observability/references/runbooks.md`).
- **After:** changelog or release notes updated, notes to stakeholders and clients **drafted** (sending is the owner's step), related tickets closed.
Deploy, push, tag, publish and DNS stay owner-gated; this checklist prepares and records, it never pulls the trigger.

## Universal
- Before declaring a run complete, run `node .claude/forge-bin/forge-verify.cjs <run_id>` and report its result; a mismatch means rework, not a pass.
- No test mode, mock backend, or fake/sample data left in.
- No localhost URLs, debug/test banners, or debug-only UI.
- Secrets in env; `.env.example` uses placeholders; no real secrets committed.
- Runtime artifacts swept for leaked secrets too, not just source: `node .claude/forge-bin/forge-secret-scrub.cjs [--json]` (advisory, reports location only) — covers `.claude/forge-runs/*/events.jsonl`, which the doctor's git-tracked leak scan cannot see because it is gitignored.
- No unfinished placeholder content/copy.
- Forms submit and validate; error handling present on all I/O.
- Mobile **and** desktop layout intact; primary CTA clear.
- *Optional:* for important code, run the `codex-reviewer` agent (Codex) and/or `security-reviewer` — advisory, not required.

## Verdict format (use when asked "is this ready to ship?")
Evidence comes from local sources only: `git status --short --branch`, `git log --oneline -20`, `git diff --stat origin/main...HEAD`, package scripts, CI files, routes, webhooks, migrations, env docs, health checks, rollback notes. No remote scanner and no upload of repo data without explicit owner approval; a deployed URL gets read-only HTTP or browser checks only. Green CI is not production readiness: it says the tests that exist passed, not that the risky paths are covered.
Answer in this order, with no numeric score:
1. **Verdict:** one sentence (ship, ship after fixes, or do not ship).
2. **Blockers:** the ship-block findings below that apply, each with file or command evidence.
3. **Evidence checked** and 4. **Evidence missing** (named, so a gap is never read as a pass).
5. **Next action:** one concrete step, never "let me know".

**Ship-block findings** (each one blocks on its own): auth missing or client-side only on sensitive data; payment or fulfilment webhook without signature check or idempotency; migration with no safe forward or recovery path; secrets in the client bundle, logs or repo; no rollback for a high-impact release. Red CI or an untested critical path is a serious finding, not an automatic block.

## Website / landing page
Perf/SEO/a11y pass; meta/OG + canonical; favicon; 404 route; no broken links; responsive at ~360/768/1280; no Lorem/test copy; CTAs/links resolve.

## Full-stack app / auth
Auth enforced server-side on protected routes; input validation per endpoint; secrets out of the client bundle; DB migrations reversible; e2e green.

## API integration
Retries/backoff + timeout; idempotent writes; consistent error envelope; pagination; webhook signature verification; safe logging.

## Dashboard / data viz
Empty/loading/error states; correct aggregation (no silent NULL drops); timezone correctness; no PII leaked client-side.

## n8n
Webhook method correct; input schema validated; credentials set (not hardcoded); error branch exists; retry/backoff defined; test/prod flows separated; `validate_workflow` clean. (Validation is good practice before calling it production-ready.)

## Scraping / lead-gen
Public/official-API/permitted sources only; rate limits + robots respected; no login/paywall bypass; data storage lawful + minimal; outreach **drafted only** (no bulk send without explicit user confirmation).

## AI / RAG / chatbot
Clear fallback for empty/low-confidence retrieval; source-aware answers; no hallucinated business facts; logging + human-handoff defined.

## Prediction systems
No certainty claims; confidence/risk labels on outputs; data-source quality verified; backtest shown with sample size; **no automatic real-money betting**.

## Telegram bot
Token in env only; webhook vs long-poll chosen; command allowlist; rate-limit; admin-only commands gated; graceful failure message.

## Business automation
Dry-run vs live separated; no bulk-send without confirmation; audit log; rollback/dead-letter for failed calls.

## References
- `references/deploy-phases.md` — fill-in deploy checklist: triggers first, pre/deploy/post with an evidence column, per change type.

## Provenance (SA-W1-C1)
Grafted in Forge words; markdown only. Fetched read-only with `gh api` at the pinned commits and treated as untrusted
data; hidden-Unicode and injection scan clean.
| Source | Path | Pinned SHA | License | Taken | Excluded |
|---|---|---|---|---|---|
| anthropics/knowledge-work-plugins | `engineering/skills/deploy-checklist/SKILL.md` | `d900840716eb262e1feb17c6f4406c9ce0e06bcf` | Apache-2.0 | three-phase structure, rollback triggers with numeric placeholders decided before the deploy, per-change-type additions | the slash command and argument hint, the connectors section (source control / CI / monitoring connectors), "I will remember your deploy process" |
| addyosmani/agent-skills | `skills/shipping-and-launch/SKILL.md` | `301b02b12bff98e4688e6984af6556802322bbde` | MIT | first-hour post-deploy checks, "rollback confirmed ready" | the web-only accessibility and Web Vitals lists (ours differ per project type), all code snippets |

Apache-2.0 notice: portions adapted from anthropics/knowledge-work-plugins, Copyright Anthropic, licensed under the
Apache License, Version 2.0 (a copy of the full text: `.claude/skills/forge-devops/LICENSE.txt`); changed by Forge (rewritten, owner gates and
evidence column added). MIT notice: Copyright (c) 2025 Addy Osmani; "The above copyright notice and this permission
notice shall be included in all copies or substantial portions of the Software." No script, hook, install command or
MCP config was copied or run.

## Provenance (W2-GRAFTS)
Verdict format, ship-block findings and the local-evidence line adapted in Forge words from ECC `production-audit`
(`skills/ecc/production-audit`, origin community, ECC pinned commit e2b8a51cea2228e515e1c3653effbeb62a2800fa, read-only
local copy). The numeric score table was not taken: this skill is advisory and a score would be false precision.
