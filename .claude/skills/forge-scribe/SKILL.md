---
name: forge-scribe
description: "Use for multi-ask, change or scrap requests."
when_to_use: "Triggers: onthoud dit, wat wilde ik ook alweer, ik heb nog een wijziging, note my change."
# W2-BUDGET original description (listing budget): "Use for multi-ask, change or scrap requests: keeps each owner ask verbatim until done and acknowledged."
---

# Forge Scribe — never lose what the owner asked

**Self-improvement substrate:** before applying this skill, read `learnings.md` in this skill's own folder
and honor its corrections. After a run that produced a genuine correction, append it there with a date
and real evidence — never invent a lesson.

Every owner prompt is kept word-for-word (secrets scrubbed) and becomes a tracked item `R-n` that stays
visible until it is planned, done **with evidence** and acked **by the owner**. The only way to change
scribe state is `node .claude/forge-bin/forge-scribe.cjs`. Never edit the files under `.claude/forge-scribe/`
by hand.

## When to use
- The owner sends a new wish, change, cancel or preference mid-project ("onthoud dit", "ik heb nog een
  wijziging", "note my change", "scrap that", "voortaan…").
- The owner asks what they asked before ("wat wilde ik ook alweer", "open wensen", "did you miss
  anything I asked").
- End-of-run reconciliation (before finalize) and on resume of a long project.

Not for: storing a standing rule directly (that is `/forge remember`), writing a PRD (`forge-prd`), or
taking meeting minutes of a document.

## Context rule
Only `DIGEST.md` (<= 1200 chars) goes back into context. Never paste `inbox.jsonl` or `ledger.jsonl`.

## Wiring (hooks, rule, finalize)
The hook prints `[forge-scribe] Genoteerd: R-n …` per captured prompt (the digest only when it changed); act on it.
A Stop reminder blocks once per unplanned item; before completion log `owner_requests_reconciled` (the writer refuses
it unless `gate` is OK) — see `config/orchestration/HOOKS_OPT_IN.md` section 7.

## Only the owner's words (origin filter, WP 3.8)
The hook also fires for text that is not the owner: a subagent hand-back (`<agent-message from=...>`,
`[Subagent hand-back]`), a cross-session or teammate message, a system notification, a task notification. Such text is
judged on its START (or a wrapper that fills almost all of it, never a mere mention) and is not recorded: one line in
`skipped.jsonl` (reason `system-origin`, char count, hashed session, never the text), no item, no digest line, no REPEAT
or split hint. Owner prose that quotes such a tag is recorded as usual. When unsure the scribe records and marks the item
`origin_uncertain` (the receipt says "origin uncertain"): check those words are really the owner's. A hand-back recorded
before WP 3.8 is set aside once with `reclassify --system-origin --apply` (backup first, text kept, folds as
`superseded` with reason `system-origin`; the gate re-checks it, so it can never hide owner text; `reopen` brings one back).

## Repeats (OWNER REPEATS v2)
`REPEAT xN of R-a,R-b — why: R-a 75% (shared words)` means the owner had to ask again: make the HARD RULE now, then link
it with `transition R-n repeat-rule --ref standing_rule:<id>`. Only owner items are compared, on the owner's own words:
pasted command or skill bodies (`# /forge (global)`), fenced code, block quotes, long quotations and a re-pasted earlier
prompt are cut first, so two different `/forge` tasks never match on the shared boilerplate. A match needs at least two
shared meaningful words and an overlap (dice) of 0.40 or more, or 60% of the new prompt already said before (config
`repeat.*` in FORGE_SCRIBE.json). At most the 3 closest earlier asks are named. Stored links from before WP 3.8 are
re-judged on display, so an old false "REPEAT x37" no longer shows. The split hint counts only the owner's own asks.

## Toggle corrections (`[tc]`, WP I.8c)
An owner message that says Forge should have turned something on, used it or done it unasked ("zet de lanes aan",
"ik moet steeds vragen om ...", "je bent de watchdog vergeten", "why didn't you run the review", "stop asking me") gets
the TAG `toggle-correction` (not a class, not a status). It is judged on the owner's own words only (hand-backs, pasted
blocks, quotes and re-pasted prompts never count) and needs a corrective cue; a plain task ("zet de lamp aan in de app")
is never tagged. The receipt ends with `[tc] toggle-correction (make it a default/rule/check)`: do that in this run.
`[tc]` marks the item in the digest and `list`; `node .claude/forge-bin/forge-anticipate.cjs metric` counts them per
mission. Older records: `retag --toggle-correction` (dry run), then `--apply` (backup first; `--skip R-n` for a doubtful hit).

## Lifecycle
`unclassified -> open -> planned -> in-progress -> done (evidence) -> acked (owner)`;
side states: `defer-proposed` (an agent's `defer`, with reason; NOT final until the owner acks it, then `deferred` = a recorded carry-over), `cancelled` (owner), `superseded`, `answered`.

| Step | Command (`node .claude/forge-bin/forge-scribe.cjs ...`) |
|---|---|
| capture (automatic: the UserPromptSubmit hook `forge-scribe-hook.cjs`; by hand only for a missed prompt) | `capture --text "<prompt>" --source cli --transcript <path>` |
| settle an unclassified item | `classify R-n change` (split a multi-ask: `--split "<exact quote>"` per ask) |
| mid-run change: which packages? | `impact R-n --run <run_id>` (read-only proposal) |
| plan it | `link R-n --wp wp-3,wp-5 --run <run_id>` |
| start / done | `transition R-n start` · `transition R-n done --evidence wp_completed:wp-3 --run <run_id>` |
| propose a carry-over (becomes `defer-proposed`; needs the owner's ack) | `transition R-n defer --reason "<why>"` |
| question answered | `transition R-n answer --reason "<where>"` |
| owner ack / cancel | `transition R-n ack --prompt P-n` (`--pid` is kept as an alias). P-n must be a hook-captured owner prompt with a clear yes for that exact R-id in the same sentence; no other wording counts as owner approval |
| status | `list --status open,planned --json` · `digest --write` |
| set aside hand-backs recorded before WP 3.8 (one time) | `reclassify --system-origin` (dry run) · `reclassify --system-origin --apply` |
| tag older toggle corrections (one time, WP I.8c) | `retag --toggle-correction` (dry run) · `retag --toggle-correction --apply [--skip R-n,...]` |
| gate | `gate` (run) · `gate --final` (programme end: also done-but-unacked) — exit 3 = blocked |

Evidence types: `wp_completed:<wp_id>` (linked wp, real event in the run), `check_passed:<event_id>`,
`commit:<sha>`, `standing_rule:<rule id>` (preference items only).

## Preferences
A `preference` item ("voortaan…", "always…") is NOT stored as a rule by the scribe. Run
`forge-scribe.cjs route R-n`, ask the owner to confirm, then `forge-standing.cjs remember "<text>"`
(the existing `/forge remember` path) and close with `done --evidence standing_rule:<id>`.

## Mid-run change protocol
1. `impact R-n --run <id>` → proposed wp_ids. 2. Confirm with `link`. 3. Amend a not-started package, or
re-create a completed one as a new `agent_work_package_created` with `supersedes` and `req_ids:["R-n"]`.
4. Head Chef triages only that delta.

## Acks are batched
At the end of a run present ONE list of done-unacked items to the owner (batch-the-asks rule). Never
pause mid-run per item. Ack/cancel are refused unless the prompt is a real owner message in the session
transcript — a classifier, not a proof.

## When to dispatch the Scribe agent (sonnet/low, GOAT quick route)
The `scribe` specialist (`.claude/agents/scribe.md`, exec-reviewer class, no Write/Edit) is dispatched by
the Lead only for a prompt flagged `multi_ask` (3+ asks), end-of-run reconciliation, or a resume with
>= 20 open items. The normal path costs no LLM call: the Lead runs the CLI directly.

## Honesty
Never report an item as planned, done or acked unless `forge-scribe.cjs` output says so; quote the
literal `gate` exit code.
