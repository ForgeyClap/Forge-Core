# Disclosure design: what goes in SKILL.md and what goes in references/

Read this when a SKILL.md passes about 300 lines, when a section has a variant or depth-tier shape, or before
you create a `references/` file. Rewritten in Forge words from samber skill-progressive-disclosure-design
(MIT) and skill-judge (MIT); provenance in the SKILL.md. Measuring the result (load rates) is Part 4 of
`forge-skill-testing`.

## First separate triggering from disclosure
- **Triggering** is whether the skill loads at all. Only the description decides it. A skill that does not
  fire is fixed in its description; splitting files cannot help.
- **Disclosure** is what loads after triggering. The SKILL.md body always loads; a reference loads only when
  the body tells the agent to read it; a Node script in `.claude/forge-bin/` runs without entering context.

When someone asks to split a skill because "it does not trigger", name the mix-up and fix the description.

## Default: one file
A single SKILL.md wins until evidence says otherwise: one load, no routing prose, no risk of loading the wrong
reference, one source of truth, easy to review end to end. Its cost: every run pays for all of it, and past
about 500 lines the agent finds the relevant part less reliably.

Split only when at least one holds:
- the file is past about 400 lines and the content has natural branches;
- transcripts show the agent spending context on sections the task did not need;
- a large block is needed only under a narrow, visible condition.

## Three split shapes that work
1. **Variant branch.** The request selects exactly one path (platform, database engine, output format,
   language). SKILL.md keeps the decision and shared steps; each variant file keeps its own detail. Breaks down
   when variants share more than about 60% of their content, or the request is ambiguous and the agent loads
   several.
2. **Workflow versus lookup data.** SKILL.md keeps the procedure; the reference keeps tables queried by key
   (schemas, error codes, option matrices, examples). Highest leverage. The pointer must name the lookup key.
   Lookup data under about 50 lines is rarely worth a file.
3. **Depth tier.** SKILL.md covers the common path; an edge-case file covers the rest, with a pointer shaped
   like "if you see X, Y or Z, stop and read `references/<edge-cases>.md`". Works only when X, Y and Z are visible
   in the request; a vague condition means the file is always or never loaded.

## Splits that fail
- **By topic when real tasks span topics** (unit, integration and mocks files for one testing skill): most
  runs load two or three files and cross-topic rules fragment.
- **To hit a line target** with no branching condition: the references load anyway and the router prose makes
  the total longer.
- **Rare but critical content in a reference**: references are optional by design and can be skipped.
  Critical content belongs in SKILL.md; "rare and critical" often means the skill does two jobs.
- **Cosmetic files** (Examples, Notes, Tips) with no load condition: either always loaded or dead.

## Pointer hygiene
- Name the signal the agent can see: "if the request mentions snapshot tests", not "for testing concerns".
- One sentence per pointer; do not summarise the reference in SKILL.md.
- Put the load condition in the file name (`flaky-tests.md`, not `advanced.md`).
- Give any reference over about 300 lines a table of contents at the top.
- Two references loaded together in most runs should be one file.
- Before writing a pointer, open the target and confirm the content is there. A pointer to a file that does
  not hold the content is worse than no pointer: it hides the loss.

## Scripts before references
For anything deterministic (validate, count, format, transform, parse), a tested script beats prose: zero
context cost, the same result every run, testable on its own. In Forge that is a zero-dependency `.cjs` in
`.claude/forge-bin/` with a `node:test` file beside it, Windows-safe paths, and no shell interpolation of
inputs. Cost: code to maintain and sharper failure modes. Never copy a script from an external skill; write
the Forge equivalent and test it.

## Decision checklist
Before moving content out of SKILL.md:
1. Is there a sharp load condition visible in the request? If unclear, do not split.
2. Does the split reduce context once the routing prose is counted?
3. Is it lookup data or procedure? Procedure usually stays.
4. Could a script do it deterministically instead?
5. In realistic runs (a sample of real prompts, not a set written to cover each file), what share would
   load the file? Under 20%: inline or delete. 20-80%: split. Over 80%: move it back into SKILL.md.
   These thresholds never apply to a coverage set (one query per file): there a well-routed file loads in
   about 1 of N runs by design. On a coverage set, judge each file by recall (did it load on the queries
   meant for it) and false loads (did it load on the others). A rare variant that routes cleanly is a good
   split. Both checks are Part 4 of `forge-skill-testing`.
