---
name: forge-extension
description: "Playbook for MV3 browser extensions: permissions, CSP (gebruik bij een extensie)."
# A10 original description (listing budget): "Playbook for Chrome/Edge MV3 browser extensions: permissions, CSP, Web Store policy (gebruik bij een browserextensie)."
# W2-BUDGET original description (listing budget): "Playbook for Chrome/Edge MV3 browser extensions: permissions, CSP (gebruik bij een browserextensie)."
---

# Forge playbook — Browser extension (Chrome MV3)

## When to use
- Use for: Chrome/Edge Manifest V3 browser extensions: permissions, messaging, CSP, service worker, store policy.
- Not for: Firefox/Safari ports (separate, only on request); popup/options UI defers to `forge-website`, backend calls to `forge-integration`.
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules (non-negotiable)
- **Least-privilege permissions.**
- **No remotely-hosted code (MV3 policy).**
- **Safe content-script + messaging.**
- **Strict CSP kept strict.**
- **Termination-resilient service worker.**
- **No secrets in the package; store-policy compliance.**

Full text of every rule: `references/hard-rules.md`.

## Team (conditional by stack/level)
Lead: `build-boss`. Security: **`security-boss`** (permission surface, CSP, message validation, no-remote-code — the defining risk of this domain). Support: `typescript-reviewer` (background/content/messaging code), `test-boss` (load the unpacked extension in Playwright/Puppeteer for E2E), `ui-boss` (popup/options UI via `forge-website`). Backend calls: `forge-integration` team.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L2 a single-purpose extension (popup + one content script); L3 a service worker + multiple content scripts + options page + messaging + a backend.
**Serial:** manifest + permission model → service worker + messaging contract → content scripts → popup/options UI → CSP + security review → load-unpacked E2E → production zip.
**Parallel:** content script ∥ popup/options UI ∥ background logic build in parallel **once** the message contract is fixed (the message schema is the seam).

## Domain gates
- Manifest requests only permissions/`host_permissions` the code uses; `activeTab`/optional preferred over `<all_urls>` (each justified).
- No remotely-hosted code — no `eval`/`new Function`/remote `<script>`; all JS bundled.
- Runtime + content-script messages validate `sender` + payload; page-supplied data is never `eval`'d; `externally_connectable` and `web_accessible_resources` scoped to specific matches.
- Default MV3 CSP kept strict (`script-src 'self'`, no `unsafe-eval`/`unsafe-inline`).
- Service worker is event-driven and termination-resilient — listeners at top level, durable state in `chrome.storage`, no global-state reliance.
- No secrets in the package; OAuth via `chrome.identity` with minimal scopes.
- Extension **loads unpacked and the core flow works** (evidence: load + a screenshot/log), and a production zip is produced.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: no API secret in the package; real secrets sit behind a backend.
- Approval / safety: store submission needs a developer account and is owner-gated.
- Honest failure: "loads unpacked" counts only with the core flow actually exercised; every permission must be one the code uses.
- Honest failure: if `security-boss` / `codex-reviewer` did not run, say so.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
