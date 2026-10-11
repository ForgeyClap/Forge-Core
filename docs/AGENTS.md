# Agents

The agents are Claude Code subagents defined in `.claude/agents/*.md`. Each file sets the agent's role, the tools it may use, and its default model and effort. `/forge` picks the smallest set that fits the task; a one-line fix may use a single agent.

## How a task moves through them

1. `boss` owns a larger task and splits it into goals.
2. `head-chef` turns those goals into concrete work packages, gives each a route (how much model and effort it needs) and checks that each package was actually done.
3. The specialists below do the work.
4. `test-boss` runs the real tests. `verify-boss` re-runs the commands a worker says passed and replies PASS or FAIL.
5. `review-boss` compares the result with what you asked for before Forge reports back. A failed check gets one more attempt with more effort or a stronger model; a second failure is reported to you.

## The agents

| File | Role |
|---|---|
| `boss.md` | Plans a larger task and decides how to handle a failed check. |
| `head-chef.md` | Splits the plan into work packages and checks that each one was completed. |
| `build-boss.md` | Writes and changes code. |
| `ui-boss.md` | Front-end and layout work, checked with screenshots at phone, tablet and desktop widths. |
| `integration-boss.md` | APIs, webhooks, n8n and other external services, with retries, timeouts and clear errors. |
| `test-boss.md` | Runs the automated tests (Playwright for web apps, the matching runner elsewhere). |
| `verify-boss.md` | Re-runs the build, test and health-check commands another agent reported, read and execute only. |
| `review-boss.md` | Final review against the original request: code, logic, tests, UX and missing pieces. |
| `security-boss.md` | Read-only review of keys, environment variables, authentication, webhooks, input handling and logging. |
| `seo-boss.md` | Website metadata, structure, performance, accessibility and indexability. |
| `search-boss.md` | Research with sources, for questions that need current information. |
| `docs-boss.md` | Setup instructions, architecture notes and the final report. |
| `skill-boss.md` | Keeps the skill registry and assigns skills to agents. |
| `scribe.md` | Records each instruction you give verbatim and tracks whether it was done. |
| `codex-reviewer.md` | Optional second review through the OpenAI Codex CLI, when it is installed. |
| `data-scientist.md` | Data analysis and statistical models, with stated uncertainty. |
| `ml-engineer.md` | Training-to-serving pipelines, model versioning and monitoring. |
| `electron-pro.md` | Electron desktop apps: safe IPC, context isolation and a working installer. |
| `mcp-developer.md` | Model Context Protocol servers and clients. |
| `payment-integration.md` | Payment providers, verified webhooks and idempotent charges and refunds. |

The plugin includes these agents as well. Forge can also hand work to other Claude Code agents you have installed yourself; those are not part of this repository.
