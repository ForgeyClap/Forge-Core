# Swarm patterns, adapted to Forge

The claude-flow / ruflo skill pack describes swarms of invented agents run through a claude-flow MCP server or CLI. Forge keeps the
useful METHOD and replaces the execution layer.

**REAL AGENTS ONLY.** Work is done by the named Forge Bosses (`.claude/agents/*.md`) or the GOAT agents, dispatched as Workflow
`agent()` calls or Agent-tool calls. A claude-flow "queen", "worker" or "specialist" never stands in for a Boss, and nothing here
creates a new agent name on the dashboard. Every `agent()` carries a route (agentType, or model plus effort opts).

## Shared execution layer (replaces claude-flow spawning)
- Fan-out: Workflow `parallel([...])`; sequencing: `pipeline()` or consecutive awaits; one routed `agent()` per card.
- Isolation: one worktree and branch per writer (`forge-worktrees`); disjoint `owns` lists (see SKILL.md section 2).
- Memory: Forge memory files and claude-mem (`forge-memory`), written by the Lead from real evidence.
- Browser work: Playwright specs, never simulated clicks.
- Hooks: only the existing Forge hook chain. No new hook, no settings edit.

## 1. Swarm topologies (swarm-orchestration, swarm-advanced, v3-swarm-coordination)
Method kept: pick a shape by dependency, not by fashion. Hierarchical (one coordinator, several workers) for a package with a
contract; mesh (peers that share findings) for research or review lanes; pipeline for staged transformation; adaptive means
re-planning after each wave when a lane returns something unexpected. Balance load by splitting the slowest card.
Forge layer: hierarchical = the Lead as integrator plus a wave of Bosses; mesh = read-only Bosses in one `parallel()` that
SendMessage each other short findings; pipeline = `pipeline()`; adaptive = the next wave is authored after reading the last
wave's forge-reports. Patterns and anti-patterns: `graphs-and-teams.md`. Cap 4 parts per package, lanes from the lane budget.

## 2. SPARC phases (sparc-methodology)
Method kept: Specification, Pseudocode, Architecture, Refinement (test-first), Completion (integrate, document). Each phase has
an exit check before the next starts.
Forge layer: Specification = Head Chef work package with acceptance; Pseudocode and Architecture = Boss (deep) or a Build Boss
design card; Refinement = Build Boss with Test Boss writing tests first; Completion = Verify Boss, Docs Boss, Lead integration.
The 17 "modes" are not agents; they map to routes (quick, build, deep) and the existing playbooks.

## 3. Stream chains (stream-chain)
Method kept: each step's output is the next step's input; keep the hand-off structured (JSON or a short file) so a step can be
re-run alone.
Forge layer: `pipeline()` where each `agent()` returns a forge-report and the next prompt is built from its fields only. No
stream-json process piping between CLI sessions.

## 4. Pair programming (pair-programming)
Method kept: driver/navigator roles, switching, continuous verification, TDD and debugging modes.
Forge layer: driver = one writer Boss in its worktree; navigator = a read-only reviewer Boss (Review Boss, Test Boss in verifier
mode) in the same `parallel()` or after each slice. Navigators never write. Switch roles by a new card, not a shared tree.

## 5. Memory and learning (agentdb-*, reasoningbank-*)
Method kept: separate session memory from long-term memory; store what worked with its evidence and the context it applies to;
recall before planning; expire stale lessons.
Forge layer: session state = run events and the card ledger; long-term = `FORGE_MEMORY.md`, the lesson files under
`.claude/agent-memory/`, and claude-mem (`forge-memory`). Entries need real evidence and no secrets. No vector store is added;
use claude-mem search.

## 6. Hooks automation (hooks-automation)
Method kept: run a check before and after a task, keep session state, format and validate on edit.
Forge layer: the existing hook chain (gate hook, stop test gate, workflow guard) and forge-bin checks run by the Lead or Verify
Boss. Any new hook is an owner decision and a separate work package.

## Skipped, with the reason
| Part | Reason |
|---|---|
| claude-flow / agentic-flow agent spawning, `swarm_init`, `agent_spawn` | Conflicts with REAL AGENTS ONLY; simulated agents have no route, ledger or verifier. |
| The claude-flow MCP server and CLI, `npx` calls | Not used in Forge; an unpinned external runtime and a new MCP need owner approval. |
| Neural training, "pattern learning" and performance claims (150x, 84.8%, token savings) | Unmeasured vendor claims; Forge reports only measured numbers. |
| `v3-*` internals: the 15-agent, 10-ADR, 14-week claude-flow v3 plan | Specific to building claude-flow itself; only its hierarchical-mesh idea is kept (topology above). |
| hive-mind / queen-worker consensus voting | No hive-mind skill is installed; a vote has no verifier. Use Verify Boss plus an adversarial review. |
| Session restore and hook-driven auto-spawn | A hook that spawns agents breaks the hotspot and lane-budget rules. |

## Provenance
Sources, read as data only: the claude-flow / ruflo skills in the global skills folder (swarm-orchestration, swarm-advanced,
v3-swarm-coordination, sparc-methodology, stream-chain, pair-programming, hooks-automation, agentdb-memory-patterns and the other
agentdb-* skills, reasoningbank-intelligence and reasoningbank-agentdb). Their frontmatter names no author or version and states
no license; no text was copied. Ideas only, reimplemented in Forge's own words on Forge's execution layer.
