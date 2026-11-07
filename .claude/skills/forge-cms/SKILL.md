---
name: forge-cms
description: "Playbook for WordPress and headless CMS: themes, plugins (gebruik bij een CMS)."
# A10 original description (listing budget): "Playbook for WordPress and headless CMS work: themes, plugins, content models, WP-CLI (gebruik bij WordPress of een CMS)."
# W2-BUDGET original description (listing budget): "Playbook for WordPress and headless CMS work: themes, plugins (gebruik bij WordPress of een CMS)."
---

# Forge playbook — CMS (WordPress · headless)

## When to use
- Use for: WordPress and headless CMS builds: content model, editor safety, the CMS attack surface, backup and migration.
- Not for: the rendered front-end (`forge-website`) or API/secret/webhook plumbing (`forge-integration`).
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules (non-negotiable)
- **Content model first.**
- **No secrets in the theme or repo.**
- **WordPress output/input safety.**
- **Headless token + webhook hygiene.**
- **Backup before change; reversible, staged migrations.**
- **Keep it patched; least privilege.**
- **Performance + accessibility are gates, not extras.**

Full text of every rule: `references/hard-rules.md`.

## Team (conditional)
Lead: `build-boss` (theme/plugin build) or `integration-boss` (headless integration + webhooks). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L2 for a single theme or headless integration; L3 for a full site with custom post types + migration + multiple templates.
**Serial:** content model → **backup** → theme/plugin or headless integration → migration (reversible, on staging) → performance + a11y pass → SEO.
**Parallel:** independent templates/components ∥ content-type definitions ∥ SEO / a11y / performance audits on rendered output (independent once the content model is fixed).

## Domain gates
- Content model defined (post types / fields / taxonomies or headless schema); editors can edit content without code.
- No secrets in the theme/repo; `wp-config` values + API tokens in env; `wp-config.php` not committed.
- WordPress: output escaped, input sanitized, `$wpdb->prepare` used; nonces + capability checks on state-changing actions; child theme (no core edits); third-party plugins vetted + version-pinned.
- Headless: server-side tokens not exposed to the client; CMS→build webhooks signature-verified; CORS locked to known origins.
- Backup taken before any migration/update; migrations reversible + tested on staging; serialized data changed with a serialization-safe tool (`wp search-replace`).
- Performance (caching, image optimization, CWV budget — see `~/.claude/rules/ecc/web/performance.md`) and a11y (semantic, alt text, heading order, contrast) verified on rendered output.
- Core/themes/plugins on patched versions; user roles least-privilege.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: back up DB + uploads before any plugin/theme/core update or content migration; migrate on staging first.
- Approval / safety: no secrets in the theme or repo; `wp-config.php` with real values never in git; headless tokens server-side only.
- Honest failure: without PHP + MySQL + WP-CLI (owner-side), mark backup, migration and live verification not-run.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
