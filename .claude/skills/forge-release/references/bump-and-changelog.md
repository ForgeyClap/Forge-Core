# Version bump and changelog

Forge words, written for this skill. Semantic versioning: MAJOR.MINOR.PATCH. Conventional commits: a header
`type(scope)!: description`, an optional body, optional footers.

## Commit type to bump
| Commit | Bump | Notes |
|---|---|---|
| any type with `!` after the type or scope, or a `BREAKING CHANGE:` footer | major | the footer text is the migration note; put it first in the changelog |
| `feat` | minor | a new user-visible capability |
| `fix` | patch | a bug fix in shipped behaviour |
| `perf` | patch | Forge default; some release tools release nothing for `perf` on its own, check the configured tool |
| `deps` (or `build(deps)`) | patch | a runtime dependency change that users get |
| `revert` | the bump of what it reverts | a revert of an unreleased commit needs no release |
| `refactor`, `test`, `docs`, `style`, `chore`, `ci`, `build` | none on its own | listed in the changelog only when a reader cares |

The highest bump in the range wins: one breaking commit among twenty fixes is a major release.

## Before 1.0.0
Many projects treat 0.x as unstable: a breaking change bumps the minor, a feature bumps the patch or the
minor. Pick one rule per project, write it in the project's release notes or config, and keep it. Leaving 0.x
is a deliberate owner decision (it promises stability), never a side effect of a commit.

## Forcing a version
When the computed bump is wrong (a first release, a marketing version, commits that did not follow the
convention), the owner names the version. Release tools usually accept a footer on a commit for this; without a
tool, the owner's chosen number goes straight into step 4 of the flow. Record why in the release notes.

## Commits that do not follow the convention
Do not guess silently. List the commits that have no type, propose a bump with the reason ("adds the export
screen: minor"), and let the owner confirm. Squash merges with a conventional PR title keep the history clean
from then on.

## Every file that carries the version
Find them all before editing: package manifests, lock files that record the root version, plugin or extension
manifests, a version constant in the code, docs that show the install version. Prove the result with two
searches: the new version is in every one of them, the old version is left only where it is history (the
changelog itself). A manifest added later that the list missed is the most common half-bumped release.

## Changelog entry
- One section per version, newest on top: version, date (YYYY-MM-DD), then groups.
- Group order: Breaking changes (with the migration step), Features, Fixes, Performance, Dependencies, then
  anything else worth a reader's time. Leave out pure chores and CI changes.
- One line per change, in user words ("Export now keeps the column order"), with the commit or PR reference.
- Generated entries are a draft: Docs Boss rewrites unclear lines; nothing is invented that is not in the commits.

## Release notes
The GitHub release (or the tag message when there is no remote) carries the same content as the changelog
section, shorter: what changed for the reader, what they must do to update, known issues. No internal codenames,
no secrets, no customer names without consent.

## Monorepos
One version per package, one changelog per package, a scope per package in the commits (`feat(core): ...`).
Release only the packages whose files changed. When packages depend on each other, bump the dependants that
pin the changed version, and release them in dependency order.
