# Release pipeline: release PR and gated publish

Described in words. Forge writes the actual workflow file itself for the project, following these points and
the hardened rules in `.claude/skills/forge-devops/references/github-actions.md`. Nothing here is copied from a
source workflow.

## The release PR flow
1. Conventional commits land on the default branch through reviewed PRs (squash merge, conventional PR title).
2. A release job, triggered by pushes to the default branch, reads the commits since the last release tag and
   keeps one open release PR up to date: the version bump in every manifest plus the new changelog section.
3. Nothing is released while that PR is open. Merging it is the owner's decision.
4. On the merge, the release job creates the annotated tag and the GitHub release, and exposes "release created"
   plus the tag and version as outputs.
5. A separate publish job runs only when "release created" is true.

A release tool can do steps 2 and 4; which tool, and adding its pinned action, is an owner choice for the
project. Without a tool, Forge does steps 2 and 4 by hand with the flow in `SKILL.md`, and the owner runs the
tag and release commands.

## Outline of the workflow (rewritten, not a template)
- Triggers: push to the default branch (normal releases), plus a manual dispatch (`workflow_dispatch`) for
  pre-releases and the "dry run" input below. No trigger on pull requests from forks.
- Top-level permissions: read-only.
- Concurrency: one group per ref, and a running release is never cancelled (a cancelled release can leave a tag
  without a release, or a half-updated PR).
- Job "release": may write contents and pull requests; one pinned release-tool step; outputs "release created",
  tag and version; a timeout.
- Job "publish": needs "release"; runs only when "release created" is true and the ref is the default branch;
  runs inside the environment named for publishing, whose required reviewer is the owner; permissions are read
  contents plus the identity-token permission and nothing else; checks out the tag (credentials not persisted);
  installs from the lock file; builds and tests again; runs the idempotency check; publishes with provenance; a
  timeout.
- Every action pinned to a full commit SHA with the version tag as a comment.
- No secret is declared for the publish step: the registry login comes from OIDC.

## OIDC trusted publishing
The idea: instead of storing a long-lived registry token in repository secrets, the registry is told once (by
the owner, in the registry's web settings) to trust exactly one repository, one workflow file and, where
supported, one environment. At publish time the job asks GitHub for a short-lived identity token, the registry
checks who issued it and which repository, workflow and environment it names, and accepts the upload. The token
lives minutes and is useless anywhere else.
- npm, PyPI, crates.io and RubyGems support trusted publishing from GitHub Actions; other registries may not.
  When a registry does not, say so and let the owner decide; a stored token is then the owner's explicit
  choice, scoped to one package with publish rights only, and Forge never sees or writes its value.
- Setting up the trust relation is an owner action in the registry account (it needs the owner's login).
- npm provenance (a signed statement that links the package to the workflow run) comes with trusted publishing
  and is shown on the package page. Ask for it on every public package.
- Cloud deploys use the same pattern (identity federation instead of access keys); see `forge-devops`.

## Idempotent publish
Before publishing, the job asks the registry whether this exact name and version already exists. If it does,
the job reports "already published" and succeeds without uploading. A re-run of a half-failed workflow then
does no harm.

## Pre-releases
Alpha, beta and release-candidate versions (`1.4.0-rc.1`) go out only by a manual dispatch, publish under a
non-default dist-tag (never the default "latest" channel), and are marked as pre-release on GitHub.

## Dry run inside CI
A dispatch input "dry run" (default on) runs the whole publish job with the registry's dry-run mode and a pack
listing, so the owner can read the exact file list before approving a real run.

## Review list for a release workflow
- Publish job behind the environment with the owner as required reviewer; the environment exists and its
  reviewers are set (otherwise the job waits forever).
- Only the publish job has the identity-token permission.
- No stored registry token where the registry supports trusted publishing.
- All actions SHA-pinned; nothing runs with an unpinned `latest` tool version.
- Concurrency group without cancellation; timeouts on both jobs.
- Event values reach scripts only through `env:`, quoted.
