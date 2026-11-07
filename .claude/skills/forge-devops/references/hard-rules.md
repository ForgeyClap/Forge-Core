# Hard rules — full text

1. **No deploy, push, merge, release, `terraform apply`, DNS or secret change without explicit owner approval.**
   These match Forge's hard gates (deploy, push, production, DNS, credentials, spend). An agent may write the workflow,
   run a dry-run, build a preview on a branch the owner approved, or run `terraform plan`; it may not trigger the live
   action. Approval is per action and per environment; approval for staging is not approval for production.
2. **No destructive command without stating what is lost and getting a yes.** See `destructive-commands.md`. An action
   the agent takes on its own initiative (not asked for) is always confirmation-first, even on its own test resources.
3. **Preview first, production only on an explicit owner ask.** Default every deploy to a preview or staging target.
   Public preview URLs and temporary deploy links publish the project: tell the owner and let them decide.
4. **Secrets never in images, args, logs or git.** No credentials in `ARG`/`ENV` (image history shows them), no
   credential file copied into the build context, no secret on a command line (shell history, process list, CI logs).
   Use BuildKit secret mounts, the platform's secret store (interactive input or stdin), CI secrets, and OIDC
   federation for cloud access. Mounting a personal `.npmrc` or SSH key into a build touches credentials: ask the owner
   and prefer a scoped, short-lived token.
5. **Pin everything.** Base images to a version (a digest for production), GitHub Actions to a full commit SHA with the
   tag in a comment, CLIs as project-local dev dependencies at a fixed version (no unpinned `@latest` runners, no global
   installs without the owner), Terraform core and providers with version constraints plus the committed lock file.
6. **Least privilege in CI.** Top-level `permissions: {}` or `contents: read`, widened per job only where needed
   (`packages: write`, `id-token: write`). Cloud access through OIDC, not long-lived access keys. Values from the GitHub
   event (titles, branch names, PR bodies) go through `env:` and are quoted in the script; never a `${{ ... }}`
   expression inside a `run:` block. `pull_request_target` never checks out and runs untrusted PR code.
7. **Rollback is planned before rollout.** Migrations stay additive and backward-compatible for at least one release;
   destructive schema changes wait until the old version is gone everywhere. Health checks test real dependencies
   (a deep readiness probe), not a bare ping. The rollback step is written down, and it says what it does NOT roll
   back (data, connected resources, secrets).
8. **Rollback triggers carry numbers before the deploy starts.** The stage plan, the advance / hold / roll-back
   thresholds and the error-budget gate are in `rollout-thresholds.md`. A signal that returns no data is a hold. The
   post-deploy watch (`canary-watch.md`) is read-only and only reports; rolling back is an owner decision.
9. **Terraform: the reviewed plan file is what gets applied.** No fresh plan inside the apply job, no `-auto-approve`
   on a destroy, `plan -destroy` with every dependent shown before any destroy (`terraform.md`).
10. **Processes are stopped by exact PID only.** A browser, watch script or container helper the agent started is
    stopped by the PID from its own spawn result; never by image or process name.
