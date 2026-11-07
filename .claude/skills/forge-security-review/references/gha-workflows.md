# forge-security-review — GitHub Actions workflows

Review `.github/workflows/*.yml`, `action.yml` files in the repo and `.github/actions/*/action.yml`, plus the
files a workflow loads (`Makefile`, scripts under `.github/`, and agent instruction files such as
`CLAUDE.md` / `AGENTS.md` when an AI step reads them). Read-only: never trigger, re-run or edit a workflow
during a review. SA-W1-A2, 2026-11-05.

Contains material adapted from getsentry/skills `skills/gha-security-review` (SKILL.md and its references),
Licensed under the Apache License, Version 2.0. Changes: condensed and rewritten in Forge words; examples
reduced to safe fragments; attack payloads, grep recipes and the real-world incident file not copied.
Pinned SHA and exclusions: the provenance block of `../SKILL.md`.

## Threat model
Report what an **outside attacker** can exploit: someone without write access who can fork, open pull
requests, open issues and post comments. Things that need write access (manual `workflow_dispatch` inputs,
pushes to protected branches, internal-only `workflow_call` inputs, secrets in schedule-only workflows) are
outside this model; at most a note.

## Confidence
HIGH = the full path is traced and needs five parts: entry point (fork PR, comment, branch name), payload,
how it executes (expression expansion, checkout plus script), impact (token theft, code execution, repo
write), and the attacker's steps. Missing a part: MEDIUM, under "Needs verification". Theoretical or mitigated
elsewhere: not reported. Zero findings is a valid result: "All workflows reviewed and cleared."

## The checks
1. **Pwn request.** `pull_request_target` (runs with the base repo's secrets and write token) **and** a
   checkout of the fork's code (`actions/checkout` with `ref:` the PR head) followed by anything that runs it:
   install with lifecycle scripts, build, test, `make`, a local action from `./.github/actions/` (the fork can
   replace it). Safe: `pull_request_target` that only reads PR metadata, or the split pattern (an
   unprivileged `pull_request` build uploads an artifact; a separate privileged workflow consumes only data).
2. **Expression injection.** `${{ ... }}` with attacker text inside a `run:` block is pasted into the shell
   before it runs. Attacker text: PR title and body, head ref / branch name (`github.head_ref`), fork label,
   issue title and body, comment and review body, discussion title and body, changed file names. Not
   injectable: PR number, `github.sha`, `github.repository`, `github.actor`, run ids, `secrets.*`.
   Expressions in `if:`, `with:` and step `env:` are evaluated by the runner, not the shell. Fix: move the
   value into `env:` and quote it in the script (`"$PR_TITLE"`).
3. **Comment-triggered commands.** An `issue_comment` workflow that runs a command for anyone: check
   `author_association` (OWNER, MEMBER, COLLABORATOR) or an explicit allowlist before acting.
4. **Credential escalation.** Long-lived PATs, deploy keys or cloud keys reachable by a job that also touches
   untrusted code. Prefer the job's `GITHUB_TOKEN` with minimal scope or OIDC with a narrow trust policy.
5. **Config poisoning.** A privileged job that checks out PR code and then lets an AI agent or a build read
   instruction or config files from it (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `Makefile`): the fork
   writes the instructions. Treat it like a pwn request.
6. **Third-party actions.** Actions from outside `actions/*`, `github/*` and the repo itself are pinned to a
   full 40-character commit SHA (with a version comment) when the job holds secrets, OIDC, a write token or
   release, deploy, package or signing power. First-party actions on version tags and local actions are not
   pinning findings. A step that downloads and pipes a script into a shell at run time is the same risk.
7. **Permissions.** A top-level `permissions:` block with the minimum (`contents: read`), widened per job
   only where needed. `write-all`, broad write on an untrusted trigger, or `id-token: write` on a job that
   does not deploy are findings. Secrets never echoed, never passed on the command line, never written to
   artifacts or caches.
8. **Runners, caches, artifacts.** Self-hosted runners never serve public fork PRs. A cache or artifact
   written by an untrusted run and read by a privileged one is a poisoning path.

## Write-up
Use `severity-and-writeup.md` with these extra fields per finding: workflow file and line, trigger, the five
parts above. End with "Reviewed and cleared: <workflows>" and "Needs verification".

## Forge notes
- Forge itself never pushes, re-runs or edits CI as part of a review; a fix is a proposal for the owning
  Boss, and any change to a release or deploy workflow is reviewed by Security Boss and lands only after the
  owner approves the diff.
- For writing new workflows (SHA-pinned actions, OIDC, least privilege) see `forge-devops`.
