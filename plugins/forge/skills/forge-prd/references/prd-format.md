# forge-prd — JSON shape, write command and outputs (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps when to write a PRD, the write command and the honesty rule; this file keeps the complete original wording.

## How
1. The Lead produces the PRD content itself — real analysis, not filler — as a JSON object:
   ```json
   {
     "prd_id": "prd-<short-slug>",
     "title": "…", "project": "…", "domain": "website",
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
   `domain` is optional: a forge-router slug (website, fullstack, n8n, scraping, rag, prediction, integration). It pulls that domain's requirements from `config/orchestration/domain-presets.json` into `domain_baseline` and renders them as a "Domain Baseline (<domain>)" section. The baseline is advisory and never becomes tickets; copy a requirement into `acceptance_criteria` to make it gate.
2. Save the JSON with the Write tool to `_scratch/prd-<prd_id>.json`, then write it (Git Bash or PowerShell 5.1):
   ```
   node .claude/forge-bin/forge-prd.cjs write --file _scratch/prd-<prd_id>.json --run <run_id> --tickets
   ```
   - `--file <path>` or `-` (stdin) avoids shell quoting. An inline JSON argument still works, but PowerShell 5.1 strips its inner double quotes and a single-quoted Git Bash argument breaks on the first apostrophe.
   - `--tickets` auto-creates one ticket per `acceptance_criteria` entry, `status: "open"`, at `.claude/forge-tickets/tk-<prd_id>-<criterion id>`; an `ac-<n>` id or a plain-string criterion keeps `tk-<prd_id>-<n>`. These feed the Ticket Board and the review gates the same as any other ticket. Give criteria their own ids so a reorder keeps each ticket on its criterion; two criteria that map to one ticket id fail the command.
   - `--run <run_id>` logs `prd_generated` (and one `ticket_created` per ticket) to that run's dashboard events.
   - Dry-run a preview without writing anything: `node .claude/forge-bin/forge-prd.cjs render --file _scratch/prd-<prd_id>.json`.

## What it produces
`.claude/forge-prd/<prd_id>.md` (the rendered PRD, fixed section order: Goal, Users, Problem, Solution, Modules, User Stories, MVP Scope, Non-Goals, Architecture, Risks, Acceptance Criteria, Test Plan, Roadmap; then Domain Baseline when `domain` is set), `.claude/forge-prd/<prd_id>.meta.json` (the structured PRD + `_generated` timestamp), and an appended row in `.claude/forge-prd/index.jsonl`. The dashboard's **PRD** dock tab reads these read-only — it lists every generated PRD (title, project, created, acceptance-criteria count) and lets you expand one to see which sections are present.
