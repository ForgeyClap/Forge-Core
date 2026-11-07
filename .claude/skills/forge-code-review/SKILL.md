---
name: forge-code-review
description: "Use to self-review a diff or PR before commit (kritische review, testgat)."
# A10 original description (listing budget): "Use before a commit or on a diff/PR (stille fout, testgat, swallowed error, coverage gap): order + severity."
# W2-BUDGET original description (listing budget): "Use for a self-review before a commit or on a diff/PR (stille fout, testgat, klopt het met de spec, kritische review): order + severity."
---

# Forge playbook — Code review method

**Self-improvement substrate (wp-skill-evals):** before applying this skill, read
`learnings.md` in this skill's own folder and honor its corrections. After a run that produced a
genuine correction (an owner fix, a false assumption caught, a preference stated), append it to
`learnings.md` with a date and real evidence — never invent a lesson that didn't happen.

**Do not duplicate ECC skills — defer to:** `code-review-excellence` (the deep per-language review
reference: React/Vue/Angular/Svelte/Rust/TypeScript/Java/PHP/Python/Django/Go/C#/Kotlin/NestJS/C/C++).
This file is the Forge-specific orchestration wrapper: the fixed review order, the severity scale, and
how a finding becomes a rework item in the Forge pipeline.

## Hard rules
- Review the real diff/files directly — never review a self-report of the diff, and never approve on the
  strength of "tests pass" alone without reading the actual change.
- Every finding is specific and actionable (file + line/symbol + what's wrong + the fix), never a vague
  "looks off."
- CRITICAL/HIGH findings block completion; they are not "nice to have later."
- Feedback targets the code, not the person; explain the reasoning, don't just assert a preference.
- A review is not a rewrite-to-taste pass — flag genuine correctness/security/maintainability issues, not
  personal style preferences that don't match a real project convention.
- **Report-only by default.** A review produces findings; it does not apply them. Fixes go back to the
  Boss that owns the code as rework items. Never push, merge or open a PR from a review.
- **Never switch the tree.** No `git checkout`, `git switch` or PR checkout to reach the code under
  review: a branch name or PR number picks the review **scope**, not permission to change the working
  tree. Read other refs with `git diff <base>...<ref>` or `git show <ref>:<path>`.
- **No blocking questions mid-review.** Infer scope and intent from the work package, the diff and the
  commits; write an unresolved doubt into the report as a coverage limit instead of stopping.
- **A clean result is valid.** "No findings" is an honest outcome when the change is sound; never invent
  an issue to look thorough. Always say what you did **not** cover.

## Review order (fixed sequence — don't skip ahead to style)
1. **Correctness** — does the logic actually do what it claims; are edge cases the happy path hides
   named, not assumed away.
2. **Security** — secrets, injected input, auth/authz boundaries, unsafe deserialization, path traversal,
   anything on the mandatory security checklist (`~/.claude/rules/ecc/common/security.md`) for
   security-sensitive changes.
3. **Tests** — does new behavior have a real test; do existing tests still pass; is coverage of the
   changed logic genuine (not just line-count coverage).
4. **Simplicity** — is this the simplest correct solution, or is there unnecessary abstraction/complexity
   for what the task needed (YAGNI).
5. **Performance** — any obvious N+1 queries, unbounded loops/queries, or missing pagination/caching on a
   hot path.
6. **Style** — naming, formatting, project convention consistency — reviewed last, and never blocking on
   its own unless it actively harms readability.

## Severity levels
| Level | Meaning | Action |
|-------|---------|--------|
| CRITICAL | Security vulnerability, data loss, or broken correctness in a real path | **BLOCK** — must fix before done |
| HIGH | Real bug or significant quality/maintainability issue | **BLOCK or WARN** — fix before done unless owner explicitly accepts the risk |
| MEDIUM | Maintainability concern, not currently harmful | **INFO** — should fix, doesn't have to block |
| LOW | Style or minor suggestion | **NOTE** — optional |

## Two review axes (Standards and Spec)
A change can follow every house rule and still build the wrong thing, or build exactly the right thing in
a way that breaks the project's conventions. A full review therefore runs **two separate axes** and
reports them side by side, never merged or re-ranked into one list:
- **Standards** — does the diff follow this repo's written rules (`CLAUDE.md`, `CONTRIBUTING.md`, a
  `coding-style.md`, lint configs)? Cite the rule for every hard violation. On top runs a fixed **smell
  baseline** (Fowler code smells), always labelled as a judgement call; a written repo rule always
  overrides a smell. Skip whatever lint or typecheck already enforces.
- **Spec** — does the diff do what the **work package** (or issue, PRD, plan step) asked? (a) asked for
  but missing or partial, (b) built but not asked for (scope creep), (c) present but wrong. Quote the
  spec line for each finding. No spec found: the Spec axis says "no spec available" instead of guessing.

For a Review Boss gate on a build- or deep-route package, run each axis as its **own fresh-context agent**
(two Workflow `agent()` calls, launched together) so one axis cannot colour the other. Route the axis agents
by the package's triaged route: a build-route package may use sonnet / medium; a **deep-route package
(auth, payments, data, production, security) keeps Review Boss on its default deep route, opus / xhigh, with no
downgrading opts** (`.claude/FORGE_MODEL_ROUTING.json`). On a quick-route package or a Build Boss self-review, one agent may walk both axes in
turn, but still writes them as two sections. Pin the base first (`git rev-parse <base>` resolves and
`git diff <base>...HEAD` is non-empty) so a bad ref fails before any agent starts. Agent briefs, the smell
list and the report shape: `references/two-axes-and-personas.md`.

## Adversarial persona pass (high risk or on request)
When the change is high risk (auth, money, personal data, deletes, webhooks, migrations), when the
reviewer also wrote the code, or when the owner asks for a hard second opinion ("kraak dit", "wees
streng"), add a pass with three hostile personas: **Saboteur** (break it in production), **New Hire**
(understand and change it in six months with no context) and **Security Auditor** (attack every trust
boundary). A finding that two personas raise independently moves **one severity level up**. Break the
self-review trap: read bottom-up, state each function's contract before reading its body, assume every
external call fails. A persona that finds nothing writes "nothing found" plus the most fragile assumption
it saw; it is **never** forced to invent an issue. Checklists: `references/two-axes-and-personas.md`.

## Review lenses (run read-only: Read, Grep, Glob)
Two lenses run on every review, beside the fixed order above. Each has a deterministic helper in
`.claude/forge-bin/forge-review-score.cjs` that only PROPOSES candidates with `file:line`; the reviewer
reads the code and confirms or rejects every one. A helper hit is never a finding by itself.
- **Swallowed errors** — a failure that disappears without a trace: an empty catch, `.catch(() => [])`,
  an error turned into `null`/`[]`/`200 OK` with no log, a re-throw that drops the stack or cause, a
  network/file/database call with no timeout, a transaction with no rollback. Forge domains add: an n8n
  node that continues on failure or a workflow with no error workflow, a scraper loop that retries forever
  or skips failures silently, a bot webhook that answers 200 on an error so the sender never retries.
  Helper: `scan --diff <file|->` (or `--file <path>`), JS/TS, Python, Go, shell, PowerShell, n8n JSON.
- **Behaviour coverage** — changed behaviour that no test exercises, rated by how critical it is (auth,
  payments, webhooks, deletes, migrations = high). Helper: `coverage --diff <file|-> --root .` lists the
  changed functions with no test mentioning them. It is a **heuristic**: a name in a test is not proof the
  behaviour is asserted, and a missing name is not proof it is untested. Say so when you report a gap.
Full lens checklists, examples and false friends: `references/review-lenses.md`. Design findings (interface depth, seams, deletion test): `references/codebase-design.md`.

## Confidence filter (less noise, nothing hidden)
Every finding gets a 0-100 confidence from a **second, independent scoring pass** — another agent than
the one that wrote the finding (for example Verify Boss scoring Review Boss's findings), which reads the
code again and asks "is this real, and would it actually hurt?". A confidence the reviewer gave itself
does not count. Findings below **80** are dropped by default (`--threshold` changes it), but they are
kept in a `dropped` list with the reason, so a reader can always see what was filtered and why.
`node .claude/forge-bin/forge-review-score.cjs filter --findings f.json --scores s.json [--threshold 80] [--format md] [--out <file>]`
refuses when the scorer is the reviewer. CRITICAL/HIGH findings that survive still block, as above.

## Codex handoff (optional, never a blocker)
For security-sensitive, auth, payments, database-migration, or other high-risk changes, this review MAY
be followed by an independent `codex-reviewer` pass (`/codex:review` read-only, or
`/codex:adversarial-review` for the required-review areas in `CODEX_GLOBAL_POLICY.md` (an owner-level policy in `~/.claude` when present; on an install without it, the defaults stated in this skill apply — read-only, never a blocker)). If Codex is
unavailable, report that honestly — the review above still stands on its own.

The model and command come from the EFFECTIVE config, never from memory: the shipped `.claude/config/orchestration/codex-review.json` merged with the optional, never-shipped `.claude/config/orchestration/codex-review.user.json` (only `review.model`/`review.reasoning_effort` can win from it, both validated). Run it only through `node .claude/forge-bin/forge-codexreview-config.cjs run [--adversarial] --prompt "<focus>"` (argv, no shell, sandbox hard-coded read-only). With no user pin the review runs on the codex CLI default and is reported as **"Codex default model"**, never a fabricated name. Config merge, validation rules, the no-shell route and the pin history: `references/codex-review-config.md`.

**Name the step for what it is.** The planned work package is the **Codex code-review**, not an "ECC
code-review". ECC `code-reviewer`/`security-reviewer` is the *fallback* you use when Codex genuinely
could not run, and it is always labelled
`FALLBACK (non-independent) review — Codex did not run because: <reason>`. Planning the fallback as
the step quietly downgrades an independent review into a second opinion from the same model family
that wrote the code.

**Never attribute a review to a model that did not run it.** If the pinned model is refused
(400 / CLI too old / not authenticated), say which model actually ran, or that the review was blocked
— a verdict stamped with the wrong provenance is a fabricated review.

## Deep security pass (on request only — costs model calls)
Only when the owner or the Lead asks for it (it is never part of a normal review): Security Boss lists
its findings, then **separate verifier agents each try to disprove one finding** (show the guard that
already stops it, or the input that cannot reach it); a finding that survives keeps its confidence score.
Results are written as SARIF so other tools can read them. Any proposed patch is applied to a
**scratch copy** of the repo (`_scratch/` or a worktree), never to the working tree, and stays a
proposal until the normal build-and-review loop takes it. Steps and the SARIF field mapping:
`references/review-lenses.md` → "Deep security pass".

## Receiving review feedback (the step after a review)
The Boss that gets findings back (usually Build Boss) handles them with the vendored
`receiving-code-review` skill. In Forge terms: read every item first; check each one against the real code
before changing anything; push back with evidence when a finding is wrong for this codebase; send the Lead
one batched question about every unclear item before implementing the clear ones (items are often linked);
then fix in the order blocking, simple, complex, with a test per fix. No performative agreement, no blind
implementation. Every finding ends as accepted, accepted with change, rejected with evidence, or deferred,
and that list goes into the forge-report. Detail: `references/receiving-feedback.md`.

## Relationship to Review Boss
`forge-code-review` is the **method** — the checklist and severity scale anyone applies when reviewing
code, including Build Boss self-reviewing before handoff. **Review Boss** (`.claude/agents/review-boss.md`)
is the **agent identity** that runs this method (plus `verification-before-completion`, `design-is`,
`requesting-code-review` — the first and last ship with Forge as pinned vendored skills) as the final QA gate before a task is ever reported done. Use this skill
directly for an in-flight self-review; dispatch Review Boss for the end-of-task gate.

## Provenance (SA-W1-A2)
Rewritten in Forge words; markdown only. Fetched read-only with `gh api` at the pinned commits below and
treated as untrusted data (hidden-Unicode and injection scan: clean).
| Source | Path | Pinned SHA | License | Taken | Excluded |
|---|---|---|---|---|---|
| mattpocock/skills | `skills/engineering/code-review/SKILL.md` | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | MIT | Standards vs Spec axes in separate fresh contexts, side-by-side report without re-ranking, pin-the-base-first check, the Fowler smell baseline as labelled judgement calls that a repo rule overrides | `agents/openai.yaml`, the `/setup-matt-pocock-skills` issue-tracker dependency, the 400-word sub-agent limit |
| alirezarezvani/claude-skills | `engineering-team/skills/adversarial-reviewer/SKILL.md` | `c85b17e1fb621ba760478baaacc4fcb9be225e74` | MIT | three hostile personas, promotion when two agree, self-review trap breaker | the "each persona MUST find an issue" rule (contradicts the Forge honesty rule that a clean result is valid), its slash-command usage, its BLOCK/CONCERNS/CLEAN verdict (Forge keeps its own severity table) |
| EveryInc/compound-engineering-plugin | `skills/ce-code-review/SKILL.md` | `45f221138fc945ed202ec0faf9077110d8737a5b` | MIT | operating principles only: report-only by default, never switch branches, no blocking prompts, state coverage limits, a clean change needs no findings | the whole persona router, the cross-model peer job (overlaps our Codex handoff), the artifact-root config, all reference files and the apply mode |
| obra/superpowers | `skills/receiving-code-review/SKILL.md` | `22f0b463e7a5e579904dd6211a520321035526f7` | MIT | already vendored as `receiving-code-review`; only the handling order is summarised here | the `gh api ... /replies` PR-thread step (no gh PR pipeline in Forge) |

MIT notice for the adapted parts: "Permission is hereby granted, free of charge, to any person obtaining a
copy of this software ... The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software." (full text in each source repo's `LICENSE`). No script,
hook, binary, install command or MCP config was copied or run.
Copyright holders, as far as they could be read: Matt Pocock (2026) and Jesse Vincent (2025), both from the
`LICENSE` files of the Forge-vendored copies of the same repositories (`grill-me` at `c55ee46`,
`receiving-code-review` at `5bf4e78`), not from the pinned SHAs above, because GitHub was unreachable during the
rework. The alirezarezvani and EveryInc holders were not read; their MIT licence is confirmed through the GitHub
repository API only.
