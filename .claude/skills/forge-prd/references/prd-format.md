# forge-prd — JSON shape, write command and outputs (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps when to write a PRD, the write command and the honesty rule; this file keeps the complete original wording.

## How
1. The Lead produces the PRD content itself — real analysis, not filler — as a JSON object:
   ```json
   {
     "prd_id": "prd-<short-slug>",
     "title": "…", "project": "…",
     "sections": {
       "goal": "…", "users": ["…"], "problem": "…", "solution": "…", "modules": ["…"],
       "user_stories": ["…"], "mvp_scope": "…", "non_goals": "…", "architecture": "…",
       "risks": ["…"], "test_plan": "…", "roadmap": "…",
       "acceptance_criteria": [
         { "id": "ac-1", "text": "…", "owner": "coder", "required_tests": ["…"] }
       ]
     }
   }
   ```
   Each section value may be a plain string or an array of strings (rendered as bullets). A section the Lead genuinely has nothing for is simply omitted — it renders honestly as `_(not specified)_`, never invented.
2. Write it:
   ```
   node .claude/forge-bin/forge-prd.cjs write '<prd-json>' --run <run_id> --tickets
   ```
   - `--tickets` auto-creates one ticket per `acceptance_criteria` entry (`.claude/forge-tickets/tk-<prd_id>-<n>`, `status: "open"`) — these feed the Ticket Board and the review gates the same as any other ticket.
   - `--run <run_id>` logs `prd_generated` (and one `ticket_created` per ticket) to that run's dashboard events.
   - Dry-run a preview without writing anything: `node .claude/forge-bin/forge-prd.cjs render '<prd-json>'`.

## What it produces
`.claude/forge-prd/<prd_id>.md` (the rendered PRD, fixed section order: Goal, Users, Problem, Solution, Modules, User Stories, MVP Scope, Non-Goals, Architecture, Risks, Acceptance Criteria, Test Plan, Roadmap), `.claude/forge-prd/<prd_id>.meta.json` (the structured PRD + `_generated` timestamp), and an appended row in `.claude/forge-prd/index.jsonl`. The dashboard's **PRD** dock tab reads these read-only — it lists every generated PRD (title, project, created, acceptance-criteria count) and lets you expand one to see which sections are present.
