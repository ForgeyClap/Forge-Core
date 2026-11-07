# Adding or changing a craft lens

A lens is data: `.claude/config/quality/lenses/<type>.json`, one file per deliverable type. The schema is
printed by `node .claude/forge-bin/forge-craft.cjs lens --schema`; `validate` checks every lens.

## What a lens holds
- `stakeholders`: 2 to 5 people who will look at the deliverable or work with it. Each has `who`,
  `cares_about` and `would_notice` (concrete things they would see, not virtues).
- `checks`: at most 20. Each names one stakeholder, a `claim`, a concrete `how_to_inspect` action, the
  `evidence_required`, a `severity` (block or warn) and its provenance.
- `first_ten_seconds`: 2 to 6 questions to answer cold, before reading the checks.
- `common_sloppy_defects`: what a professional spots, each with the visible symptom.
- `domains`: the domain-catalog.json domains this lens usually applies to (used by `plan --domain`).
- `selected_by` (optional): `{en: [...], nl: [...]}` request words that name this deliverable (used by
  `plan --text` and the name of an unknown type). A word matches its plurals, never a shorter word;
  `word*` = starts with; `-word` / `word-` = also at the end / start of a Dutch compound (5+ letters).
  Check every word for look-alikes first: `sheet` matches "style sheet", `-tabel` would match "databasetabel".

## Rules
1. Every stakeholder has at least one block check. Block means a professional would not hand the work
   over with this defect; warn means fix it or state it.
2. Provenance is honest. `cited` needs a path, a quote and one locator: `section` (a markdown heading
   prefix) or `rule_id` (FORGE_HARD_RULES.json or FORGE_STANDING_RULES.json). The quote must still be
   found there, or the lens shows as STALE. Cite only text that really says this. Otherwise use
   `professional_practice` with a one-line rationale; never dress practice up as a citation.
3. Do not invent domain rules and do not pad. A short lens with real checks beats a long one.
4. `how_to_inspect` is an action someone can do: "screenshot at 360, 768 and 1280 px and read each
   image", not "check the layout".
5. A lens never carries results (no status or mark field); the schema rejects them.
6. Citations under `docs/` exist only in the Forge development tree. The tool reports them as "not
   shipped here" in other projects; the ship manifest needs a matching `ref_ignore` entry.
7. After a change run `node .claude/forge-bin/forge-craft.cjs validate` and
   `node .claude/forge-bin/forge-craft.test.cjs`. A new deliverable type also needs its name in the
   test's expected list.
