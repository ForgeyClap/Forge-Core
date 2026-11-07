# Rolling back a bad release

Forge words. A published version is permanent in practice: users, mirrors and caches already have it. So the
default is **fix forward**: withdraw the bad version from the default channel, ship a corrected version, tell
the readers. Every step that touches a registry, a tag on a remote or a GitHub release is an owner action;
Forge prepares the exact commands and the text.

## First ten minutes
1. Confirm the problem with evidence (an error, a failing install, a report), and which version introduced it.
2. Decide with the owner: patch forward (a fix is small and ready) or revert forward (revert the bad commits and
   release that as the next patch).
3. Stop the spread: point the default channel back to the last good version and mark the bad one deprecated
   with a one-line message naming the good version.

## Per registry (what exists, in words)
- **npm:** deprecate the bad version with a message; move the "latest" dist-tag back to the last good version;
  release the fix as a new patch. Unpublishing is limited (time window, dependants) and breaks anyone who
  pinned the version, so it is a last resort for a leaked secret or malware, and an owner decision.
- **PyPI, crates.io, RubyGems:** "yank" the bad version: existing pins still resolve, new installs skip it.
  Then release the fix.
- **Container images:** move the release tag back to the digest of the last good image; deploys pin digests.
- **GitHub release:** edit the notes to say the version is withdrawn and which version replaces it; mark it as
  pre-release if that keeps it off the "latest" badge. Do not delete it.
- **Deployed app:** use the platform's rollback to the previous deployment (`forge-devops`, `forge-guardian`).

## Never
- Never move, delete or force-push a tag that has been pushed: other clones keep the old one and history forks.
- Never re-publish the same version number with different content (most registries refuse it anyway).
- Never rewrite the default branch to remove the release commit; revert it with a new commit.
- Never rotate or revoke a credential without the owner; if a secret shipped in a package, the owner rotates it
  first, then the version is withdrawn.

## Database and data
Code can be rolled back; data written by the new version cannot always. Releases that change a schema keep the
change additive and backward-compatible for at least one release (see
`.claude/skills/forge-devops/references/pipeline-gates-and-rollback.md`).

## Rollback report
```
ROLLBACK
Bad version:   <x.y.z>, problem: <one line, evidence>
Last good:     <x.y.z>
Prepared:      <deprecate / yank / dist-tag / release-note commands, in order>
Run by owner:  <yes, at time | not yet>
Fix release:   <x.y.z+1>, status: prepared | released (read back)
Notice:        drafted (not sent) for <changelog, release notes, users>
```
