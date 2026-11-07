---
name: forge-prd
description: "Use before a non-trivial feature (schrijf een PRD, spec this out): PRD + tickets."
# A10 original description (listing budget): "Use before a non-trivial feature (schrijf een PRD, spec this out): PRD + one ticket per criterion."
---

# Forge PRD generator (WP3)

A **Forge PRD** is a structured product-requirements document the Lead writes before a non-trivial build — it forces the scope, acceptance criteria, and test plan to be explicit before agents start touching files. It is rendered to markdown by `.claude/forge-bin/forge-prd.cjs`, a zero-dependency writer that stores both the markdown and its structured JSON meta under `.claude/forge-prd/`.

## When the Lead generates one
- Before a non-trivial feature/build (new module, new integration, anything touching 3+ files) — not for a 1-2 line fix.
- Typically right after **Deep Learn Mode** (`forge-deeplearn` skill) so the PRD's risks/architecture sections are grounded in the real codebase, not guesswork.
- Too big for one session (several deliverables, open decisions): the owner charts it first with `forge-plan-large` (owner-invoked), then one PRD per deliverable.
- Not needed when the task is a small, well-understood change or a PRD for this exact scope already exists — check `.claude/forge-prd/index.jsonl` first.

## How (short)
The Lead writes the PRD content itself (real analysis, no filler) as JSON with `prd_id`, `title`, `project` and `sections` (goal … roadmap, plus `acceptance_criteria` entries `{id, text, owner, required_tests}`), then runs:
   ```
   node .claude/forge-bin/forge-prd.cjs write '<prd-json>' --run <run_id> --tickets
   ```
   - `--tickets` auto-creates one ticket per `acceptance_criteria` entry (`.claude/forge-tickets/tk-<prd_id>-<n>`, `status: "open"`) — these feed the Ticket Board and the review gates the same as any other ticket.
   - `--run <run_id>` logs `prd_generated` (and one `ticket_created` per ticket) to that run's dashboard events.
The JSON shape, the dry-run `render` command and what gets written where: `references/prd-format.md`.

## Writing the content
- Missing problem, users or success measure? Ask at most three short questions first; gaps the owner waves through become labelled assumptions in `risks`, never facts. Lean by default (one to two pages); omit empty sections. Section-by-section guide and review mode: `references/prd-writing.md`.
- Stories and testable acceptance criteria (user vs job stories, INVEST, splitting): `references/stories-and-criteria.md`.
- Scope too big for one version: `references/prioritization.md` (opportunity score, ICE, RICE, MoSCoW).
- After delivery, user-facing release notes: `references/release-notes.md`.

## Honesty rule (non-negotiable)
- **Real content only.** Every section reflects an actual decision the Lead made — no placeholder/lorem sections, no invented acceptance criteria just to pad the count.
- **Secrets are auto-redacted.** Every string in the PRD is redacted (`forge-store.cjs`'s `redactValue`) before it is rendered to markdown or written to disk — never write a raw secret into a PRD.
- **The PRD viewer is read-only.** There is no write endpoint on the dashboard for PRDs; the only way to create or change one is `forge-prd.cjs write` (or hand-editing the store files, which the dashboard will simply reflect on next read).

## References
- `references/prd-format.md` — JSON shape, write/render commands, outputs.
- `references/prd-writing.md` — questions, section content, consistency checks, review mode.
- `references/stories-and-criteria.md` — story formats, acceptance criteria, INVEST, splitting patterns.
- `references/prioritization.md` — which prioritization method when, formulas, honesty rules.
- `references/release-notes.md` — categories, benefit-first entries, audience tone.
- The four files above are adapted from phuryn/pm-skills (MIT); notice in `LICENSE`.
