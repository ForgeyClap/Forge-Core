---
name: forge-fullstack
description: "Playbook for full-stack apps: backend, auth, SaaS, CRUD dashboards (gebruik bij een webapp)."
# A10 original description (listing budget): "Playbook for full-stack apps: frontend, backend, database, auth, SaaS and CRUD dashboards (gebruik bij een webapp bouwen)."
# W2-BUDGET original description (listing budget): "Playbook for full-stack apps: frontend, backend, database, auth, SaaS and CRUD dashboards (gebruik bij een webapp bouwen)."
---

# Forge playbook — Full-stack app

## When to use
- Use for: full-stack apps: frontend, backend, database and auth together.

**Do not duplicate ECC skills — defer to:** `make-plan`/`do` (planning+execution), `using-git-worktrees` (parallel isolation), `subagent-driven-development` (both ship with Forge as pinned vendored skills). Orchestration only.

## Hard rules
- Auth on **every** protected route, enforced server-side (authn + authz). Protected pages and API routes read the session server-side (cookies); a client-side check is never the only guard, and auth tokens are not kept in localStorage.
- Input validation on every endpoint; never trust client data.
- Secrets in env + `.env.example` placeholders; no secrets in the client bundle.
- DB migrations reviewed by `database-reviewer` and reversible.
- Auth/secret/DB changes are a **required Codex review area** — force `/codex:adversarial-review`.

## Team (conditional by stack/level)
- Lead: `architect` + `planner`.
- Frontend: `react-reviewer` / `vue-reviewer`.
- Backend: `fastapi-reviewer` / `django-reviewer` (Python) or `typescript-reviewer` / `go-reviewer` (by stack).
- Data: `database-reviewer` (Postgres/Supabase).
- Cross-cutting: `security-reviewer`, `tdd-guide`, `e2e-runner` / `production-validator`.

## Skills / commands / MCP
`make-plan`→`do`, `using-git-worktrees`, language build/test commands (`/react-build`, `/python-review`, etc.), `/test-coverage`, `security-reviewer`. Supabase/Shopify MCP via ToolSearch if relevant.

## Fan-out & flow
L3 standard; L4 for a platform / prod client delivery (phased, review after each phase).
**Serial:** plan → DB schema + API contract first → integration → e2e → security → review.
**Parallel:** frontend ∥ backend ∥ schema in **separate worktrees**; you integrate. Don't let two agents write the same tree.

## Domain gates
Auth flow tested (signup/login/logout/refresh); validation on all endpoints; migrations clean on a fresh DB; e2e green; no folder mixing.

## Ship-readiness (unique)
Migrations run clean on a fresh DB; auth flow verified; `.env.example` complete; no secrets in repo; rollback/seed documented; dev/preview by default (production needs explicit user approval). The `ship-readiness` full-stack/auth checklist is advisory; optionally run `codex-reviewer` (Codex) on auth/migration code — not a blocker.

## Safety, approval and honesty
- Approval / safety: dev/preview by default; production needs explicit user approval.
- Approval / safety: secrets in env + `.env.example`; none in the client bundle or repo.
- Honest failure: auth flow and fresh-DB migrations count as verified only when actually run.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.
