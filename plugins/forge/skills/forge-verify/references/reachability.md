# Reachability and pretend-implementation audit

Used by Verify Boss when a done-claim says new code "is wired", "runs at X", "is hooked in" or "is implemented". A green test of the new file alone does not prove this: the question is whether anything live reaches it, and whether what it does is real. Read-only: Verify Boss never edits; fixes go back through Head Chef.

## 1. Split the claim
List each claimed item on its own line, including items that were never started. Each gets CONFIRMED, REFUTED or UNVERIFIABLE (same words as `claim-verdict.md`).

## 2. Reachability trace (start at the entry point, not at the new file)
Live entry points in this repo: a `/forge` command doc, a hook in the Claude Code project config file (read it, never write it), a skill doc that names a tool, another `.cjs` tool that requires or spawns it, a doctor check, a `package.json` script.
1. Find who names the new thing: `grep -rn "forge-newtool" .claude --include=*.cjs --include=*.md --include=*.json -l`
2. Exclude its own file and its own test: a caller that is only `*.test.cjs` or only the file itself does not count.
3. Follow the chain upward until an entry point: `grep -n "forge-newtool" .claude/commands/*.md .claude/skills/*/SKILL.md` and, read-only, the hooks block of the project config.
4. For an exported function: `grep -rn "functionName(" .claude/forge-bin | grep -v ".test.cjs"` and read the call site (is it inside a branch that can run?).
5. Run the entry point once if cheap (`--help`, a dry run) and quote the exit code.
6. Registry hint: `node .claude/forge-bin/forge-registry-gen.cjs feature-registry` (a dry run; never add `--write`) flags rows with "no caller found"; treat such a row as REFUTED for "is wired" unless the grep above finds a caller it missed.

An empty search result counts as evidence only when the search was able to hit: check the exit status, ignored or hidden paths, dynamic dispatch (string-keyed require, aliases, re-exports), and say which remain unchecked.

## 3. Pretend-implementation checklist
Look in the code behind each claimed item for:
- stubs: TODO, FIXME, a thrown "not implemented" error, empty function bodies, `return true` or a constant result
- functions that only log or print and return success
- hard-coded sample data standing in for real input
- a feature flag or config default that is off, so the path never runs
- paths exercised only by mocks, or only by the tool's own test that asserts nothing about the claimed outcome
- a registry or docs row with no caller (section 2)

Trace every hit to its callers: a placeholder that a live path reaches is a gap; a test double, or code with no caller, is dead code, which is worth noting but does not by itself refute the claim.

## 4. Outcome mapping
| Finding | Verdict |
|---|---|
| Entry point reaches it, behavior real, you re-ran it | CONFIRMED |
| No live caller, or a live path hits a stub or constant | REFUTED |
| Flag is off, caller exists but cannot be run here, or the search could not have matched | UNVERIFIABLE (name what would settle it) |

Any REFUTED makes the work package NOT-PROVEN; any UNVERIFIABLE left makes it PARTLY-PROVEN. Report the trace as a short ledger: item, verdict, the `file:line` or command output that decides it, and what was not checked.

## Provenance
- Source repo: boshu2/agentops, path skills/research/SKILL.md (the claimed-state audit section)
- Commit sha for that path: 73cbeae8be281b970389d8b2ea5636cfa972a9fa
- Licence: Apache-2.0 (confirmed with the GitHub licence API)
- Label: PATTERN_ADAPTED, re-written for Forge tools; no sentences copied
- Left out: its scripts, its tracker and report-file formats, delivery and remote-state rules, and its other research modes
- Date: 2026-11-07
