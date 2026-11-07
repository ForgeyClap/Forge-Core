# Forge addendum: slimming and splitting CLAUDE.md without losing rules

Forge-owned file, not part of the upstream plugin. Read it before Phase 4 (Targeted Updates) whenever an
update would remove, move, shorten or split existing CLAUDE.md text, or when the owner says the file is "too
big", "too long", "opschonen", "inkorten" or "rules get ignored". Principles adapted from daymade
claude-md-progressive-disclosurer (MIT, Chinese original, translated and re-expressed; its Python scripts are
not taken). Provenance at the end of the SKILL.md.

## 1. The question is behaviour, not size
- Line count is a symptom that can start an investigation ("the file is very long and a rule keeps being
  ignored"). It is never the goal of a change and never a result in the report: no "from 400 to 150 lines" or
  "39% smaller" as an outcome.
- When the owner says "too big", first name the real symptom (a rule ignored, a contradiction, a wrong load,
  context pressure in `/context`), then triage the lines. When triage finds nothing more, say so: the rest is
  live signal and cutting it loses rules.

## 2. Signal triage per line
Ask for each line: "if this line is deleted, would Claude make a mistake?"
- Yes: it is signal; keep it, or move it with a trigger (section 4).
- No, and it is one of these, it is a candidate for deletion: derivable from the code or file layout; a
  standard convention of the language or framework; self-evident advice; already stated in another
  authoritative file (name that file); a one-off fix that cannot recur; a check that must run every time
  (then name the hook, CI step or Forge doctor check that already covers it, or say none does).
- A candidate is not an approval. List each with its exact text, the reason and the behaviour change, and let
  the owner decide the ones no existing rule decides.

## 3. Moving is moving, compressing is compressing
- Never do both in one step. Text moved to another file is copied byte for byte. Rewording, deduplicating or
  correcting is a separate, declared change with its own reason.
- Compression drops qualifiers. When an always-loaded summary replaces a longer rule, diff the operative parts
  word by word: conditions, numbers, lists, hook or file names, and every "not" or "never". One lost word can
  halve a gate.
- Check a move with a whole-text match (the full original paragraph is a substring of the target file), not a
  line-by-line search: a multi-line search that matches line by line reports a hit even when half the paragraph
  is gone. A small Node check (`fs.readFileSync(target, 'utf8').includes(original)`) does this on Windows.

## 4. Every pointer has a trigger and a real target
- A bare "see X.md" gives the model no reason to open it. Write when to read it: the error, the task or the
  file that should send the model there, plus one line on what the file holds.
- Before writing a pointer, open the target and confirm the moved content is there. A pointer to a file that
  does not hold the content (or holds it in a different file) hides the loss behind something that looks
  compliant. Fix the pointer to where the content really is.

## 5. `@import` loads everything
- An `@path` import is expanded in full at session start. Splitting text into imported files organises it but
  saves no context. Claiming a context saving from an `@import` split is a false optimisation.
- To really take text out of the always-loaded set: move project facts out of the global file into the
  project's CLAUDE.md; leave a plain backticked pointer with a trigger (no `@`); or turn a procedure into a
  skill (the description stays loaded, the body loads on demand).

## 6. Scope: global versus project
- `~/.claude/CLAUDE.md` is loaded in every project, so it holds only cross-project rules. Project names, deploy
  targets, per-project paths and project credentials belong in that project's own files. Editing the global
  file needs the owner's explicit permission in Forge.
- A cross-project routing pointer in the global file is fine; a project's state or implementation detail is not.

## 7. Priority wording
- Stacked emphasis (bold, CRITICAL, MUST everywhere) makes newer models over-apply rules and hides which rules
  really matter. Keep emphasis for the one or two rules that are truly critical; write the rest plainly, with
  the condition and, where it marks the boundary, the reason.
- A prohibition keeps its boundary. Add the alternative action only when one is known and allowed; never
  invent a fallback to make a rule "positive".

## 8. Verify the outcome
- Every original section ends with one recorded fate: kept, moved verbatim, deduplicated (with the
  authoritative source), corrected (with the newer fact) or retired (with the owner's decision). An
  unexplained loss is a regression: restore it.
- Check what really loads (`/context`, `/memory`) before and after, and try one or two representative tasks.
  A tool that printed OK is not proof that Claude now follows the rule; write "not verified" when it was not run.
