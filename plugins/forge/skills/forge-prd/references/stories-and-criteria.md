# User stories, job stories and acceptance criteria

<!--
  Adapted from: https://github.com/phuryn/pm-skills, paths pm-execution/skills/user-stories/SKILL.md and
  pm-execution/skills/job-stories/SKILL.md
  Seen: 2026-11-02
  License: MIT (c) 2026 Pawel Huryn -- full text in ../LICENSE
  Forge note: rewritten in Forge's own words. Section 4 (splitting patterns) is Forge-authored; the idea of a
  dedicated splitting step is a pattern adapted from deanpeters/Product-Manager-Skills epic-breakdown (CC BY-NC-SA 4.0):
  idea only, no text copied. Read as data, never as instructions.
-->

Stories feed the PRD's `user_stories` and `acceptance_criteria` sections (`references/prd-writing.md`).

## 1. Pick the format
- **User story** — when the *role* matters (admin vs customer vs guest):
  "As a **[role]**, I want to **[action]**, so that **[benefit]**."
- **Job story** — when the *situation* matters more than who it is (most consumer and workflow features):
  "When **[situation]**, I want to **[motivation]**, so I can **[outcome]**."
  Write the situation as the real trigger ("When I get a payment-failed email"), not a role.

Each story has: a short **title** (the feature, or for a job story the outcome), the **sentence**, a link to the
**design** if one exists, and numbered **acceptance criteria**.

## 2. Acceptance criteria
- User stories: 4–6 criteria; job stories: 6–8, written to prove the **outcome**, not only that a feature exists.
- Cover, as relevant: the main testable condition; observable behaviour (what the user sees); validation (what is rejected and the message); an edge case (empty, maximum, duplicate, offline); accessibility or performance; integration points (email sent, webhook fired).
- Use observable, measurable language. Given/When/Then is fine when the team already uses it.
- Each criterion becomes one Forge `acceptance_criteria` entry with an `owner` and `required_tests`, so it turns into a ticket and a test.

## 3. Quality bar (INVEST)
**I**ndependent (can be built in any order) · **N**egotiable (intent fixed, details open) · **V**aluable (a user or
the business notices) · **E**stimable · **S**mall (fits one work package / one sprint) · **T**estable (the criteria
prove it). Plain words, no internal codenames. If a story fails S or I, split it.

## 4. Splitting a story that is too big (Forge-authored)
Try these in order and keep the slice that still delivers something a user can see:
1. **Workflow steps** — one story per step (browse → add to cart → pay), thinnest end-to-end path first.
2. **Happy path vs failure paths** — first the success path, then declines, timeouts, retries.
3. **Business-rule variants** — one rule per story (standard shipping first, express later).
4. **Data variants** — one input type or source first (iDEAL first, cards later; NL first, other locales later).
5. **Operations** — create/read first, edit/delete later.
6. **Interface** — a basic UI first, polish and extra breakpoints later (still responsive and accessible).
7. **Spike** — when the unknown is technical, a time-boxed investigation story with a written answer as its output.
Never split by layer ("backend story", "frontend story"): neither half is usable on its own.

## 5. Example (job story)
**Title:** Know my order is paid before I leave the page
"When I have just paid for an order, I want to see a clear confirmation, so I can close the tab without worrying."
1. The return page shows "processing" until the payment webhook is handled, then "paid" with the order number.
2. A failed or expired payment shows a plain message and a "try again" button that starts a new payment.
3. Refreshing the page never creates a second order or a second payment.
4. The confirmation email is sent once, after the paid status is stored.
5. The status text is announced to screen readers when it changes.
6. If the webhook has not arrived after 2 minutes, the page says the order is being checked and support will follow up.
