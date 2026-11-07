---
name: forge-ecc-adapter
description: "Use when running an ECC skill or command that hard-codes ~/.claude/skills paths (ECC skill draaien)."
---

# forge-ecc-adapter: run path-bound ECC skills through the resolver

ECC is installed under `~/.claude/skills/ecc/<name>`, but several ECC skills and commands still say
`~/.claude/skills/<name>` or use POSIX `find -maxdepth 2`. Followed literally on this machine they read a folder
that does not exist, or count the ecc subtree as "global". This skill is the Forge way to run them: ask
`.claude/forge-bin/forge-ecc-path.cjs` where the skill really is, then run the ECC step from there. The pinned
ECC files are never edited (ECC policy section 7). Hands off: finding a NEW third-party skill → `forge-scout`;
writing or slimming a skill → `forge-skill-authoring`.

## When to use
- An ECC skill or command (skill-stocktake, skill-scout, evolve, promote, prune, projects, learn) names a
  `~/.claude/skills/<name>` path, or a `find ~/.claude/skills -maxdepth 2` inventory.
- A "file not found" under `~/.claude/skills/<name>` while the skill exists under `~/.claude/skills/ecc/<name>`.
- Listing every installed skill with its true source (project, global, ecc, plugin).
- Not for: switching on ECC hooks, MCP servers or continuous learning (owner-only, off by policy); editing an
  ECC file; skills that already resolve normally (project and global skills).

## The resolver
- `node .claude/forge-bin/forge-ecc-path.cjs resolve <name> [--json]` prints the skill folder. Search order:
  project, global, ecc, plugin. Exit 1 = not found (the message lists every root it searched), exit 2 = bad name.
  A plugin skill is asked for as `<plugin>:<name>`.
- `node .claude/forge-bin/forge-ecc-path.cjs list [--depth N] [--json]` replaces `find <root> -maxdepth N -name
  SKILL.md`; every item carries its `source` label, and the ecc subtree is never counted as global.
- It prints a Windows path (`C:\Users\...`). Git Bash accepts it inside double quotes; keep the quotes, the
  path may hold spaces.
  *Done when:* `resolve` exits 0 and the folder it printed has a SKILL.md.

## Per skill: what it hard-codes and what to run instead

| ECC item | Hard-codes | Run instead |
|---|---|---|
| skill-stocktake (SKILL.md) | `~/.claude/skills/skill-stocktake/results.json` and `bash ~/.claude/skills/skill-stocktake/scripts/*.sh` | `D="$(node .claude/forge-bin/forge-ecc-path.cjs resolve skill-stocktake)"`, then `bash "$D/scripts/scan.sh"`, `quick-diff.sh` and `save-results.sh`. Give the results file as a path under `_scratch/`, never inside the pinned ECC folder. |
| skill-stocktake scripts | `GLOBAL_DIR=$HOME/.claude/skills` with an unlimited `find`, so ecc counts as global | Take the inventory from `list --depth 3 --json`, which labels ecc correctly. The scripts' own `SKILL_STOCKTAKE_GLOBAL_DIR` override is marked "for testing only" in scan.sh, so do not lean on it. |
| skill-scout (SKILL.md) | `find ~/.claude/skills -maxdepth 2 -name SKILL.md` and a marketplaces `find` | `list --json` (depth 2 covers ecc and the installed plugins from installed_plugins.json), then filter names and paths by the keyword. Its `grep -RilE` content search stays as it is. |
| evolve, promote, prune, projects (commands) | `python3 ~/.claude/skills/continuous-learning-v2/scripts/instinct-cli.py <cmd>` | Nothing: disabled by ECC policy: owner approval required. `~/.claude/ECC_GLOBAL_POLICY.md` keeps instincts, evolution and continuous learning off, and `prune` deletes files outside the project. The resolver only shows where the script lives (`resolve continuous-learning-v2`); do not run it. Say "disabled by ECC policy (instincts are off)", never "nothing to evolve". |
| learn, learn-eval (commands) | write a new skill into `~/.claude/skills/learned/` | Not a resolver case. That write lands outside the project, which is an owner-gated edit; point it at the project `.claude/skills/` and let `forge-skill-authoring` shape the result. |
| continuous-learning v1 and v2 | a Stop hook or observer hooks under `~/.claude/skills/...` | Out of scope: ECC hooks stay off by policy. Only the folder can be resolved (`resolve continuous-learning-v2`); nothing is wired. |

*Done when:* the ECC step ran from the resolved folder, and every write landed inside the project.

## Pitfalls
- The stocktake scripts need `jq` and Bash; on a machine without `jq` they stop with an error. Report that, do
  not hand-roll the JSON.
- `python3` on Windows can be missing or the Microsoft Store stub; the resolver does not check it. Run
  `python3 --version` first and report a stub as a blocker.
- A `resolve` hit with source `project` or `global` wins over ecc on purpose: a local override shadows the
  pinned copy. Read the `--json` `source` field when the result surprises you.
- `learn` writing outside the project is the hard gate, not a path bug. Never "fix" it by resolving a global
  folder.

## Verification
- `node .claude/forge-bin/forge-ecc-path.cjs resolve skill-stocktake` exits 0 on a machine with ECC.
- The doctor line `ecc path` is green: it resolves skill-stocktake and skill-scout and counts the ecc skills, and
  it shows a visible skip on a machine without ECC (`.claude/forge-bin/doctor/checks-tools.cjs`).
- `node .claude/forge-bin/forge-skill-evals.cjs run --skill forge-ecc-adapter` passes.

## Provenance
Forge-native (FORGE_NATIVE_ORIGINAL). The table restates the W2-ECCPATH adapter notes of 2026-11-06
(the local research note forge-research/skills-audit-2026-11-04/ADAPTER-ECC-PATH.md), which were written by reading the pinned
local ECC catalog (commit e2b8a51); no ECC text, script or hook is copied, and no ECC file is changed.
