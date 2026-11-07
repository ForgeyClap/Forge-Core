# Search first: preflight, then Adopt / Extend / Compose / Build

Read this before Step 1 of a Scout pass and before any "let's just build it" decision. It decides whether Scout
looks for an outside capability at all, and what a found candidate is used for.

## 0. Tool preflight (no silent skipping)
Before a search channel is relied on, check that it exists and works here. A channel that is missing or fails is
named in the result with what was used instead; it is never left out quietly, and "nothing found" is never
reported for a channel that did not run.

| Channel | Check it works | When it does not |
|---|---|---|
| this project | Grep/Glob over the relevant folders | say only the visible files were searched |
| installed skills | `node .claude/forge-bin/forge-ecc-path.cjs list --json` | say which skill roots were missing |
| skill corpus | `.claude/forge-research/skills-corpus/` exists and has rows | fall back to `gh` search, and say so |
| GitHub | `gh auth status` | public web pages only; no repository-wide claim |
| package registry | `npm --version` (or the project's own manager) | docs and web search; no registry claim |
| MCP / docs tools | the tool is in the tool list | official docs on the web |
| video | the `watch` skill runs | the candidate cannot be APPROVED (Step 2) |

## 1. The decision matrix
After the search, every need gets one verdict, and the result logs the evidence for it:

| Verdict | When | Evidence to log |
|---|---|---|
| Adopt | one candidate fits as it is: exact match, maintained, a licence that allows it | source, commit or version, licence, one checked line on what it does |
| Extend | a candidate fits with a small Forge addition | what it lacks, and where the addition lives |
| Compose | two or three existing tools cover it together | the seam between them and who owns it |
| Build | nothing fits after the search | the searches run (terms, channels, counts) and why each near hit failed |

Adopt and Extend still go through Step 3 (APPROVE or HARD-PASS) and the adopt plan, including the security audit
(`node .claude/forge-bin/forge-skill-audit.cjs scan <folder>`). Build is written in Forge's own code, informed by what
the search found.

## Anti-patterns
- Jumping to code before the search ran.
- Reporting "nothing found" while a channel was down (silent skipping).
- Wrapping a tool so heavily that its benefit is gone.
- A large dependency for one small feature (Forge tools are zero-dependency).

## Provenance
Idea from ECC `search-first` (pinned local catalog, commit e2b8a51cea2228e515e1c3653effbeb62a2800fa, licence MIT):
the Adopt / Extend / Compose / Build matrix and the tool-availability preflight. Rewritten in Forge's own words with
Forge's own channels (PATTERN_ADAPTED); its wording, diagram and examples are not copied.
