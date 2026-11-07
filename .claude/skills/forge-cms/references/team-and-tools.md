# forge-cms — team, skills, commands, MCP

## Team (conditional)
Lead: `build-boss` (theme/plugin build) or `integration-boss` (headless integration + webhooks). Rendered front-end: the `forge-website` team (`ui-boss`, `seo-boss`). Support: `security-boss` (escaping/sanitization/nonces/capabilities, secrets in `wp-config`, plugin vetting), `database-reviewer` (migrations, serialized-data safety, schema), `php-reviewer` (WordPress theme/plugin PHP) or `typescript-reviewer` (headless front-end), `test-boss` (editor flows, template rendering, migration dry-run), `seo-boss` (metadata/schema/CWV). Optional advisors: `security-reviewer`, `codex-reviewer` on theme/plugin PHP or the headless token path.

## Skills / commands / MCP
`forge-website` for the rendered site (real content, responsive, a11y, SEO, performance — the CMS front-end IS a website). `forge-integration` for API-token hygiene + signed CMS→build webhooks. Exact API/config from WordPress + WP-CLI + ACF, or the headless vendor (Contentful/Sanity/Strapi/Payload), docs via Context7. `forge-n8n` if content automation runs through n8n. `systematic-debugging` for white-screen/plugin-conflict issues. **Opt-in dependency:** a local WordPress/PHP runtime (LocalWP / Docker / `wp-env`) and WP-CLI are owner-side — Forge does not provision them; without them, live migration/backup/verification are advisory + marked not-run.
