# Forge router reference — Step 3a web-quality contract, Step 3b MCP tool access, Step 3c Wave J tools

> **On-demand reference, moved VERBATIM** out of `.claude/skills/forge-router/SKILL.md`, so
> the forge-router skill core stays short enough to survive compaction. The core's numbered rules still govern; this file
> holds the full, unmodified wording of lines 127-204 of the earlier file (whole-file sha256 `66355b53d6a9f698d081e1a53a2595386a75871c86b88753bfca04435bae7184`).
> Nothing between the two markers below was reworded. **When to read:** for website/landing/spa/fullstack builders (auto-prepend the web-quality contract), when a Boss needs an external MCP tool, or when tournament/secondbrain/codemodel/beads/nightshift/audit-loop/guardian/scout/projectbrain may apply.

<!-- wp11-verbatim-begin source=.claude/skills/forge-router/SKILL.md lines=127-204 -->
## Step 3a — Auto Web-Quality Contract (default, not re-requested) — WAVE C / C3, 2026-07-18
When the classified domain (Step 1) is **website, landing, spa, or fullstack** (frontend surface work
within a full-stack build), the Lead/router **auto-prepends** the full text of
`config/orchestration/web-quality-contract.md` to that builder's dispatch prompt — every time, without
being separately asked. This is what encodes the repeated "fix the UI" / "make it responsive" / "better
animations" owner ask as a **default builder obligation**, not a follow-up request. Also attach the
matching **required-evidence set** for the work package's `evidence_required` field (the C2
evidence-schema piece owns that catalog; reference it by name in the dispatch — don't restate its
contents here). Skip this step only for pure backend/API-only, n8n, or CLI/tooling work packages within
a mixed build — those keep their own domain gates. Never mark a website/fullstack-frontend work package
`completed` without the contract's screenshot-check item having a real screenshot as evidence.

## Step 3b — External tool access (MCP, dormant/opt-in by default) — WAVE G
**Invoke `forge-mcp-gate.cjs` WHEN** a work package genuinely needs an external tool a Boss doesn't have
natively (versioned docs lookup, web search/scrape, browser-driven QA, GitHub read/write) **and config `mcp` is on**
(off = the honest native fallback below, said so in the work package): consult the
**`forge-mcp-clients`** skill and `config/orchestration/mcp-registry.json` / `mcp-grants.json` (via
`forge-bin/forge-mcp-gate.cjs::planLoad()`/`validateGrant()`) before assuming the tool is available. The MCP-as-client layer is **dormant + opt-in by
default** — nothing is installed/connected/activated by routing alone. A tool is usable only when the owner
has explicitly opted its server in **and** the dispatched Boss's tier + allow-list (least-privilege) covers
it; a tier-3 write-primitive additionally always routes through `forge-actiongate.cjs`, same as
deploy/push/spend. Absent either condition, the default is an honest **native fallback** — say so explicitly
in the work package/dispatch, never claim the tool ran.

## Step 3c — Wave J tools (tournament / second brain / codemodel / nightshift / guardian) — opt-in, 2026-07-19
Reach for these only when the signal is real, never by default:
- **Invoke `forge-tournament.cjs` WHEN** config `tournament` is not `off` **and** the task genuinely has a **wide solution space** (several defensible
  approaches, no single obvious "right" answer, worth planning N distinct angles up front rather than
  committing early to one path). `plan()` a best-of-N variant set, isolate each in its own worktree, judge
  REAL results against a transparent weighted rubric with `score()`, promote the winner with `promote()`
  (never a fabricated score — see the tool's own guardrails). Skip for an ordinary, single-obvious-approach
  work package.
- **Invoke `forge-secondbrain.cjs` WHEN** config `portfolio` is on **and** a task genuinely needs **cross-project/portfolio** strategy
  awareness beyond the current run (an explicit "how are my projects doing" ask, or a decision that should
  weigh more than just this repo) — `scan`/`report` (read-only) produces a weekly, evidence-cited
  cross-project digest (never opens `.env` contents, never fabricates a finding without a real
  `{project,file,fact}` citation). **`forge-codemodel.cjs`** is the sibling **repo-context** tool — when config `code-index` is on, use it
  for a persistent, incrementally-updated symbol/file index a Boss can query cheaply instead of re-reading
  the whole repo on every question (query answers are a SNAPSHOT — always check the returned
  `stale`/`changed_since_index`).
- **Invoke `forge-beads.cjs` WHEN** a run's own work genuinely breaks into many interdependent multi-step
  items (an L3/L4 phased backlog, or any run where "what can I actually start right now" isn't obvious by
  eye) — `add()`/`link()` beads to build the real dependency graph, `ready()` to compute what's actually
  unblocked instead of re-scanning a list by eye, `graph()`/`computeCycles()` to DETECT a deadlock (A depends
  on B depends on A) before it wastes a cycle. Skip for a small, linear work package — a flat TodoWrite list
  is enough there.
- **`forge-nightshift` skill** — load when config `nightshift` is on **and** a task is explicitly framed as "run this overnight", "keep going
  while I'm away", "resume this tomorrow", or a swarm is expected to outlast one session. Strictly **opt-in**
  scheduling (owner-enabled `usage-guard.cjs` watch or the owner's own OS cron) — never self-schedules; ends
  in a real `forge-briefing.cjs --run <id>` morning briefing, not a narrative guess.
- **`forge-audit-loop.cjs`** — the continuous project-health AUDIT-LOOP tool. Use when the owner
  asks for an ongoing/periodic health check on THIS project's own memory, agents, tooling usage, or doctor
  status (not a website/app feature). `node forge-audit-loop.cjs iterate [--json] [--run <run_id>]` runs ONE
  real, bounded iteration — MEMORY-INTEGRITY (owner profile/standing-rules/lessons parse cleanly),
  AGENT-HEALTH (forge-doctor's agentsCheck across all agent files), FEATURE-USAGE (forge-capabilities' real
  usage inventory — surfaces installed-but-never-used tools/skills/gates), DOCTOR-DELTA (forge-doctor's own
  red/advisory state) — and appends every finding to `.claude/forge-audit/ledger.jsonl` (never overwritten).
  Strictly **opt-in and non-self-scheduling** (same posture as forge-nightshift above) — it never auto-fixes
  anything beyond a trivially-safe repair it can prove; it only SURFACES findings for the owner/next step.
  `node forge-audit-loop.cjs ledger [--json]` reviews prior iterations.
- **`forge-guardian` skill** — **owner-gated scaffold only**, not a running capability. Load it only when
  explicitly discussing/designing production self-healing / auto-rollback / incident-response automation;
  every deploy/redeploy step it describes still routes through `forge-actiongate.cjs` with a real per-use
  `owner_confirmed:true`. Never report it as "active" or "monitoring" anything.
- **`forge-scout` skill** — load when a domain gap surfaces mid-build ("is there a skill/plugin/MCP for X?")
  or the owner explicitly asks Forge to research an external capability. Tailored per-domain search terms via
  `forge-bin/forge-scout.cjs terms`, mandatory `./watch` video verification before any verdict, and a real
  recorded APPROVE/HARD-PASS to the persistent ledger (`config/orchestration/FORGE_SCOUT_VETTING.json`) —
  never a generic "any Claude skills out there" sweep, never an auto-install. Skip for ordinary work packages
  that don't have a genuine external-capability question.
- **`forge-projectbrain` skill/tool** (`forge-bin/forge-projectbrain.cjs`) — the default method for producing
  or upgrading a project's `CLAUDE.md` at install/onboarding time or a `forge-deeplearn` deep-learn pass:
  real-stack detection (never assumed) + adapted environment rules + verbatim anti-generic guardrails/honesty
  core + a real `## Hard Rules` section wired to `FORGE_HARD_RULES.json` + safe-merge write (never clobbers an
  unmarked owner-authored file). Prefer this over hand-writing a thin bullet-list CLAUDE.md whenever a project
  has none, or has a thin/generic one — see Step 0b's `claude_md_checked`/`_created`/`_updated` step above,
  which this tool now implements rather than a bare template merge.

<!-- wp11-verbatim-end -->
