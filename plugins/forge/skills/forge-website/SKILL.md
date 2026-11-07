---
name: forge-website
description: "Playbook for websites, landing pages and frontend UI: responsive, SEO (gebruik bij een website)."
# A10 original description (listing budget): "Playbook for websites, landing pages and frontend UI: responsive, SEO, accessibility (gebruik bij een website maken)."
# W2-BUDGET original description (listing budget): "Playbook for websites, landing pages and frontend UI: responsive, SEO (gebruik bij een website maken)."
---

# Forge playbook — Website / landing / frontend

## When to use
- Use for: websites, landing pages and frontend UI: responsive, SEO, accessibility.

**Do not duplicate ECC skills — defer to:** `design-is` (design audit), `browser` (screenshot loop). This file is orchestration only.

## Hard rules
- Mobile **and** desktop layout verified by screenshot before claiming done.
- No placeholder/Lorem/test/mock content in anything headed for prod.
- Forms validate input and hit a real endpoint; clear error + success states.
- Any analytics/form keys live in env, never in the committed bundle.
- Meta and sharing basics: every page has a unique title and meta description, a canonical URL, Open Graph title/description/image, and JSON-LD (Organization or WebSite) where it fits — checked in the built HTML.
- Performance proof: run Lighthouse or PageSpeed on the built site and report LCP, CLS and INP; numbers measured on localhost are labelled "local, indicative".
- Design before markup: write the token plan from `forge-craft.cjs lens --type web-ui` (guidance: colours, type roles, spacing, layout sketch) and hold it against the brief; the brief's own visual direction always wins.
- **Finish gate:** a page is done only when `craft-evidence-web-ui.json` (a screenshot per viewport and per state, or n/a with a reason) passes `node .claude/forge-bin/forge-craft-evidence.cjs check --run <run_id> --type web-ui` (exit 0).

## Team (conditional by stack/level)
- Lead: `planner` / `architect`.
- Build review: `react-reviewer` **or** `vue-reviewer` (by stack).
- Audits (parallel): `a11y-architect`, `seo-specialist`, `performance-optimizer`.
- Copy/CTA: `marketing-agent`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L2 for a single page, L3 for a multi-page site.
**Serial:** design direction (`design-is`) → build → audits → fixes → review gate.
**Parallel:** a11y ∥ seo ∥ performance ∥ copy audits on the built artifact (independent).

## Domain gates
Accessibility pass; SEO meta/OG + canonical; performance budget (see `~/.claude/rules/ecc/web/performance.md`); responsive at ~360/768/1280; CTA clarity; no broken links.

## Ship-readiness (unique)
Screenshots at mobile+desktop breakpoints; no test copy; all CTAs/links resolve; forms submit to a real endpoint with validation; favicon/meta/OG present; 404 route; secrets in env. The `ship-readiness` website checklist is advisory; optionally run `codex-reviewer` (Codex) on important code — not a blocker.

## Safety, approval and honesty
- Approval / safety: analytics/form keys in env, never in the committed bundle.
- Honest failure: mobile and desktop verified by screenshot before claiming done; localhost performance numbers are labelled "local, indicative".
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/react-best-practices.md` — React / Next.js rules by impact plus the interface review list (a11y, forms, motion, state, copy); measured speed and SEO work goes to `forge-web-quality`.
