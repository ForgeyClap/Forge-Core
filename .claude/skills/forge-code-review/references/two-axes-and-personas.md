# Two review axes and the adversarial persona pass

Detail for `forge-code-review` (SA-W1-A2). Both parts are read-only: they produce findings, never
edits. Sources and licences: the provenance block at the end of `../SKILL.md`.

## 1. Pin the base before anything runs
1. Take the base from the work package (a commit, branch, tag or `main`). None given: use the branch the
   work package was cut from; still unclear: write it as a coverage limit, do not stop to ask.
2. `git rev-parse <base>` must resolve and `git diff --stat <base>...HEAD` must be non-empty. Three dots, so
   the comparison is against the merge-base. A bad ref or an empty diff fails here, not inside two agents.
3. Save the diff once: `git diff <base>...HEAD > _scratch/review.diff` plus `git log <base>..HEAD --oneline`.
   Both axis agents read the same file, so they review the same change.

## 2. Find the spec and the standards
**Spec**, in this order: the work package text (Head Chef's card: goal, files, acceptance), the PRD or plan
step it points to (`docs/`, `.claude/forge-runs/<run>/`), issue numbers in the commit messages, a spec file
matching the branch name. Nothing found: the Spec axis reports "no spec available" and is skipped.

**Standards**: every file that says how code is written here: the project `CLAUDE.md`, `CONTRIBUTING.md`,
`CODING_STANDARDS.md` or a `coding-style.md`, `.editorconfig`, lint and format configs, `AGENTS.md`. When
`CONTRIBUTING.md` or a coding-standards file exists it must be on the list.

## 3. The smell baseline (Standards axis)
Always applied, even when the repo documents nothing. Two binding rules: **a written repo rule wins** (where
the repo endorses something a smell would flag, drop the smell), and **every smell is a judgement call**,
reported as "possible <smell>", never as a hard violation. Skip anything lint already enforces.

| Smell | What it looks like in the diff | Usual fix |
|---|---|---|
| Mysterious name | a name that does not say what the thing does or holds | rename; no honest name means the design is unclear |
| Duplicated code | the same logic shape in two hunks or files | extract once, call from both |
| Feature envy | a function that uses another object's data more than its own | move it next to that data |
| Data clumps | the same few fields or parameters always travel together | bundle them into one type |
| Primitive obsession | a bare string or number standing in for a domain idea | give the idea its own small type |
| Repeated switches | the same `switch`/`if` chain on the same kind recurs | one shared map or polymorphism |
| Shotgun surgery | one logical change forces edits scattered over many files | gather what changes together |
| Divergent change | one file edited for several unrelated reasons | split by reason to change |
| Speculative generality | hooks, options or layers the spec does not need | delete; add when a real need appears |
| Message chains | long `a.b().c().d()` walks the caller should not know | one method on the first object |
| Middle man | a function or class that only forwards | call the real target directly |
| Refused bequest | a subclass that ignores most of what it inherits | composition instead of inheritance |

## 4. Agent briefs (one fresh-context agent per axis)
Launch both in one message as Workflow `agent()` calls routed by the package's triaged route. Build route,
for example `agent({agentType:'review-boss', label:'Review Boss · standards axis', model:'sonnet', effort:'medium'})`;
deep route (auth, payments, data, production, security) keeps Review Boss's default deep route, for example
`agent({agentType:'review-boss', label:'Review Boss · standards axis', model:'opus', effort:'xhigh'})` — never
downgrade a deep package's review.
Each brief is self-contained: the agent has no other access to this file.

**Standards brief** contains: the diff path and commit list; the list of standards files from step 2; the
smell table from step 3 pasted in full; the instruction "Report per file and hunk: (a) every place the diff
breaks a written standard, citing file and rule; (b) every smell you see, named and with the hunk quoted.
Written-rule breaches can be hard violations; smells are always judgement calls and a written rule
overrides them. Skip what lint enforces. Under 400 words. Read-only: no edits, no checkout."

**Spec brief** contains: the diff path and commit list; the spec text or path; the instruction "Report:
(a) requirements that are missing or partial; (b) behaviour in the diff that was not asked for; (c)
requirements that look implemented but are wrong. Quote the spec line for each finding. Under 400 words.
Read-only: no edits, no checkout."

## 5. Report shape
```
## Standards
<findings, each: file:line, rule or smell, hard | judgement, fix>
## Spec
<findings, each: spec line quoted, missing | not asked | wrong, file:line>
Summary: Standards <n> findings (worst: ...) · Spec <n> findings (worst: ...)
Not covered: <files, behaviours or axes skipped and why>
```
Do not merge or re-rank across axes and do not pick one overall winner: that is exactly the masking the
split exists to prevent. The fixed review order and the severity table still apply **within** each axis.
Findings then go through the normal confidence filter (independent scorer) before they block anything.

## 6. Adversarial persona pass
Run after the axes, by the same reviewer or a separate agent, when the change is high risk, when the
reviewer wrote the code, or when the owner asks for a harsh review. Read every changed file in full, not
only the changed lines: bugs live where new code meets old code.

**Saboteur** — "I want this to break in production."
- For every changed function: what is the worst input I could send?
- For every external call (network, file, database, child process): what if it fails, hangs or returns
  garbage? Is there a timeout?
- For every state change: what if it runs twice, at the same time, or never? (idempotency, races)
- For every condition: what if neither branch is right? Off-by-one, null, overflow, leaked handles or
  listeners, errors swallowed into a misleading result.

**New Hire** — "I must change this in six months with no one to ask."
- Can each changed function be understood from its name, parameters and body alone?
- How many files must I open to follow one path end to end?
- Magic numbers or strings, a function doing more than its name says, comments that say *what* instead of
  *why*, tests that pin implementation details instead of behaviour, knowledge only the author had.

**Security Auditor** — "This will be attacked."
- List every trust boundary the change crosses (user input, API, database, file system, environment, LLM
  output) and ask per boundary: validated in, encoded out, least privilege?
- Injection, missing auth or ownership checks (IDOR), sensitive data in errors, logs or responses,
  insecure defaults (debug on, wildcard CORS), new dependencies, secrets even "temporary" ones.
- Can a signed-in user raise their own rights through this change? Deep checks: `forge-security-review`.

**Merging the personas.** Merge duplicates. A finding raised independently by two personas moves one level
up in the Forge severity table (LOW to MEDIUM, MEDIUM to HIGH, HIGH to CRITICAL). A persona with nothing to
report writes "nothing found" plus the most fragile assumption it noticed, which is a note, not a finding.

**Breaking the self-review trap** (the reviewer shares the author's mental model, especially when it is the
same model family): read the diff bottom-up; write each function's contract before reading its body and
compare; treat every value as possibly null until proven otherwise; treat every external call as failing;
ask "if this change were deleted, what would break?" — if nothing, the change may be unnecessary.

## What this pass is not
Not a licence to pad the report, not a style crusade, not a replacement for the confidence filter, and not
a reason to block on a judgement-call smell. Cosmetic-only findings while a null dereference goes unseen is
worse than no review.
