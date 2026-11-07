# forge-i18n-docs — technical docs and ADRs

Forge-native. The ADR format follows Michael Nygard's "Documenting Architecture Decisions" (2011), restated in
our own words.

## README checklist
- One line: what it is and who it is for.
- Requirements with versions (Node, Python, OS); install and run commands that were executed in this run.
- How to check it works (a test command, or a URL and what you should see).
- Configuration: every environment variable with its meaning and a placeholder example, pointing at
  `.env.example`.
- A short project layout, how to run the tests, how to deploy (or a link), the licence, where to ask for help.
- Keep it short and move depth to `docs/`. Bilingual projects: one README per language, or an English README with
  a Dutch section, as the owner prefers.

## API reference
- Generated from the contract (OpenAPI or GraphQL SDL, see `forge-api`), never copied by hand. Every endpoint shows
  auth, request, response, errors and one runnable example with placeholder credentials.
- A getting-started page: get a key, make the first call, handle the first error.

## Changelog
- Keep a Changelog style: `## [1.4.0] - 2026-11-02` with Added, Changed, Fixed, Removed and Security sections,
  written for users. Breaking changes come first and are marked. Link versions to tags.

## ADR template (`docs/adr/NNNN-short-title.md`)
```
# NNNN. <Decision in a short phrase>

Status: proposed | accepted | superseded by NNNN | deprecated
Date: YYYY-MM-DD
Deciders: <names or roles>

## Context
The forces at play: the problem, the constraints, the options considered and the main trade-off of each.

## Decision
What we will do, in active voice ("We will ...").

## Consequences
What becomes easier, what becomes harder, follow-up work, and how we will notice if the decision was wrong.
```

## ADR lifecycle and index
- Number sequentially and never reuse a number. `docs/adr/README.md` lists every ADR with number, title, status
  and date.
- Write an ADR when a decision is hard to reverse or affects other people: a framework, a database, an auth
  model, a hosting choice, a data format. Not for routine choices.
- Accepted ADRs are not edited except for status and links. Reversing one means a new ADR that says
  "Supersedes NNNN", and the old one's status becomes "superseded by MMMM".

## Writing style
- Write for a competent reader arriving cold; define terms once; use short sentences and real examples.
- Every code block runs as shown, or is marked as an excerpt. Dates are absolute, never "last week".
