# forge-security-review — Secrets and dependency risk

## Secret scanning
- Search the diff and the tracked tree for secret shapes, never for values you already know:
  private key headers (`BEGIN ... PRIVATE KEY`), provider key prefixes (for example `sk_live_`, `ghp_`,
  `xoxb-`, `AKIA`), `password=`/`secret=`/`token=` assignments with literal values, connection strings with
  embedded credentials, JWTs in fixtures.
- Use `git grep -nE '<pattern>'` on the working tree and `git log -p -S'<prefix>'` for history when a leak is
  suspected. A dedicated scanner (gitleaks, trufflehog) is fine when it is already installed in the project;
  installing one is an owner decision.
- Report a hit as: file, line, kind of secret, whether it is in history. Do not print, copy or validate the
  value against the provider.
- A secret that reached git history counts as leaked: the fix is rotation by the owner plus removal, not only a
  new commit that deletes the line.
- Check that `.env`, key files, `storageState` files, traces and local databases are gitignored and that
  `.env.example` holds names only.
- Check logs and error paths: no tokens, cookies, passwords or full card/IBAN numbers in log lines or responses.

## Dependency risk
- Lockfile committed and used in CI (`npm ci`, `pnpm install --frozen-lockfile`).
- Run the project's audit (`npm audit --omit=dev`, `pnpm audit`, `pip-audit` when installed) and report
  critical/high findings that are reachable from production code.
- For each NEW dependency: is it maintained (recent release, open issues answered), widely used, the exact
  name (typosquats: one letter off from a popular package), and does it have install scripts
  (`preinstall`/`postinstall`)? Install scripts run code at install time and need a reason.
- Prefer the standard library or an existing dependency over a new tiny package.
- Pin versions for tools that run with secrets in CI; review major upgrades as code changes.
