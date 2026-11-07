# Deploy platforms — Vercel, Cloudflare Workers, others

Every live action here (deploy, promote, rollback, secret write, domain change, temporary public link) is an owner
hard gate. The agent prepares, validates and reports; the owner approves each live step.

## Vercel
Pattern adapted from vercel-labs/agent-skills deploy-to-vercel (ideas only, rewritten).
- **Inspect state first, change nothing:** is there a git remote; is the folder linked (a `.vercel` folder with project
  metadata: ids, not tokens); is the CLI available and logged in (`vercel whoami` is the only command that is safe in an
  unlinked folder; others may prompt or link as a side effect).
- **Team:** if the account has several teams, ask which one; a linked project already fixes it. Pass it with `--scope`.
- **Preview by default; production only when the owner explicitly asks for production.**
- **Paths:**
  - linked + git remote: the owner approves the commit and push (explicit file paths, never stage everything); Vercel
    builds the preview from the push.
  - linked, no remote: `vercel deploy` (preview) after owner approval; check status with `vercel inspect`.
  - not linked: ask the owner before linking; `vercel link --repo` matches the git remote more reliably than a plain
    link.
  - not logged in: the owner logs in themselves. Do not use a no-login temporary deploy without asking: it uploads the
    whole folder to a public URL and produces a claim link that must not be shared.
- **CLI:** use the project-local, pinned CLI (dev dependency) or ask the owner before any global install; never an
  unpinned `@latest` runner.
- **Env vars:** set through the dashboard or `vercel env add` with interactive input, never echoed or in args.
- **Report** the deployment URL and say whether it is preview or production.

## Cloudflare Workers (Wrangler)
Adapted from cloudflare/skills wrangler and workers-best-practices (Apache-2.0), in our own words.
- **Docs first:** check current Cloudflare docs for limits, config keys and APIs instead of memory; the project's
  installed Wrangler version, generated types and compatibility settings are the baseline.
- **Confirm the target** before any state change: account, Worker name, environment (`--env`), and for data commands
  whether the target is local or remote.
- **Narrowest auth:** an account-owned API token with only the scopes needed; the interactive OAuth login is broad.
- **Validate without deploying:** `wrangler deploy --dry-run` with the intended config and env (checks build and
  packaging, not remote resources or runtime behaviour); typecheck after binding changes; run the runtime tests.
- **Secrets:** never in args, source, chat or logs; use interactive input or stdin; local secret files stay
  git-ignored and are not uploaded automatically. `wrangler secret put` and `secret delete` deploy immediately: use the
  versions secret workflow to stage a change, and treat both as owner-gated deploys.
- **Previews and versions:** branch/PR previews need a recent project-local Wrangler; pass the same `--env` to every
  preview command (leaving it out targets the top-level Worker). Preview URLs are public unless access control is on:
  tell the owner.
- **Rollback** restores Worker code only, not KV/D1/R2 data or other connected resources.
- **Per-field environment config:** a working default config does not mean staging is configured.
- **New Workers:** compatibility date = today; enable logs and traces with sampling for production
  (see `forge-observability`).
- **Code anti-patterns to flag:** buffering unbounded bodies instead of streaming; hard-coded secrets; `Math.random()`
  for security values (use the crypto APIs); unawaited promises (await, return, or `ctx.waitUntil`); module-level
  mutable request state; calling the REST API where a binding exists; `passThroughOnException` as error handling;
  hand-written `Env` types (generate them with `wrangler types`); plain string comparison of secrets (use a
  timing-safe compare); destructuring `ctx` methods; `any` or double casts on `Env` and handler types.

## Other hosts (Fly.io, Render, Railway, a VPS)
No vetted vendor skill was found for these (research 2026-11-02). Apply the same rules: inspect state read-only, pin the
CLI, preview or staging first, secrets through the platform's secret store with interactive input, deep health check,
written rollback, and every deploy, scale or secret change owner-approved. Read the vendor's current docs before
writing commands; do not guess flags.
