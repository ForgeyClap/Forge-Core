# forge-prompt-coach — §7 how it plugs into Forge (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps a one-paragraph summary; this file keeps the complete original wording.

### `forge-intake`, silent mode (the default)
1. Run `node .claude/forge-bin/forge-promptcheck.cjs ask "<raw request>" --json` — the raw-request
   prompt-doctor (exit 0 = CLEAR/OK, 3 = VAGUE, 2 = usage). Its JSON carries `gaps` (the F-ids found, ranked as
   in §2), `gapDetails` (`[{id, midrun}]`; F12 is mid-run only), `nextQuestion` (`{id, nl, en, options,
   recommended, assume}` or `null`) and `assumptions` (`[{id, nl, en}]`). `nextQuestion` only ever comes from
   the askable gaps F13/F9/F8/F5/F7/F3/F4/F1 (plus F12 with `--midrun`); F11/F10/F6/F2 are always recorded as
   assumptions, never asked. It is set whenever a question is due — the verdict is VAGUE, or the top gap is
   F13 (outward/irreversible actions are always confirmed). Use what it actually prints; if the tool is
   missing or fails, apply §1–§2 by hand and say so.
2. Answer the intake list yourself (`forge-intake` §1). `node .claude/forge-bin/forge-intake.cjs --type <slug>
   --json` passes each bank question's beginner fields through unchanged; `--trigger F<id>` keeps only the
   questions that answer that gap (for example `--trigger F9` → the bugfix symptom set). Each bank question's
   `beginner.assume` / `beginner.assume_nl` is the safe default when nothing in the request or the project
   answers it.
3. Ask **at most one** question: `nextQuestion` from step 1 when it is set, otherwise the highest-ranked gap of
   §2 that passes protocol rule 2. Ask it in its beginner form (`question_nl` + `beginner.options_nl`,
   recommended option first; `forge-intake.cjs --lang nl` prints exactly that form, `--beginner` does the same
   in English). No gap passes rule 2 → ask nothing.
4. Confirm (§4), record (§5), tip (§6).

### `forge-intake`, interview mode (`/forge interview`, or config `intake` = `interview`)
One question per turn, each from the next open gap; laddering is allowed here and only here
[LADDERBOT][LADDERTEAM]; close with `forge-intake`'s meta-question ("what should I still clarify that I did not
ask?").

### The question bank
`.claude/config/intake/question-bank.json` carries the beginner layer this skill uses:

- per question: `question_nl`, `options_nl`, `why_nl`; a `beginner` block with at most 3 outcome-worded
  options plus "Something else" / "Iets anders" (`options`, `options_nl`), a `recommended` index and
  `assume` / `assume_nl`; `triggers` lists the F-ids the question answers;
- universal dimensions added for this skill: `must-not-break`, `why`, `success-measure` (F2,
  the outcome rather than the process), `budget` (separate from the deadline), `language`, and
  `outward-action` (the consent question); `must-not-break` and `outward-action` are `required`;
- `recommended` is `null` on pure fact questions ("what are you selling?") where no option is better — ask
  those neutrally, without a recommendation;
- the `bugfix` set (F9: symptom, steps, error text, since when, expected) and the `bots` set (platform, who
  talks to it, what it may answer, handoff) are live intake packs under `byType` (`--type bugfix`,
  `--type bots`); `bugfix` is a task kind that applies across every domain.

`forge-intake.cjs --json` carries every field in both languages, the beginner layer (`question_nl`,
`options_nl`, `why_nl`, `beginner`, `triggers`) included, passed through unchanged. `--lang nl` and
`--beginner` only change the human print (at most 3 options + "Iets anders"/"Something else", the recommended
one first with its reason); `--trigger F<id>` filters to the questions whose `triggers` contain that id (an
empty result is an honest empty list).
