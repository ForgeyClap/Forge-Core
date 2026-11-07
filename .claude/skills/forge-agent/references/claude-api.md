# forge-agent — Building on the Claude API (agent design)

Provenance: adapted in Forge's words from anthropics/skills `skills/claude-api/` — `SKILL.md`,
`shared/agent-design.md`, `shared/evals/build-eval.md` (Apache-2.0, `LICENSE.txt` verified in that skill folder),
read on `main` at `ca45fc4` on 2026-11-02. Licence text: `../LICENSE.txt`. Changes (Apache-2.0 §4(b)):
condensed and rewritten; dropped every credential step (auth-status / print-credentials commands, reading API-key
or token variables), the live-doc fetch and SDK-clone instructions, the bundled scripts and report builders, and the
Managed-Agents onboarding subcommands.

**Facts that drift — model IDs, prices, context sizes, beta headers, SDK method names — come from the `claude-api`
skill or the official docs at build time, never from memory and never from this file.**

## Before writing code
- Find the provider surface (first-party API, Bedrock, Vertex, Foundry) and the SDK language already in the repo;
  match them. Do not switch provider or SDK as a side effect.
- Pin a dated model ID in config (one place), not a floating alias, so evals stay comparable.
- The API key lives in the environment / secret store and `.env.example` names it. Agents never print, read back or
  log a key, and never paste one into a prompt.

## Tool surface: start broad, promote what needs control
- A general tool (shell, file edit) gives breadth fast but the harness only sees an opaque string.
- **Promote an action to a dedicated tool** when it must be: **gated** (send, pay, delete, deploy, call an external
  API → human confirmation), **checked for staleness** (an edit tool that refuses if the file changed since it was
  read), **rendered** (a question tool that blocks until the user answers) or **parallelised** (read-only search tools).
- Every dedicated tool: strict input schema, least privilege, a clear description that matches what it really does,
  and results treated as data (see `untrusted-content.md`).
- Many tools: load schemas on demand (tool search) instead of sending all of them every turn.
- Many sequential calls or huge intermediate results: let the model write a script that calls the tools
  (programmatic tool calling) so only the filtered result returns to the context.

## Long-running agents: context
- **Context editing** drops stale tool results and old thinking within a session.
- **Compaction** summarises earlier turns near the limit; the loop must handle the compacted response content
  correctly — test it.
- **Memory** (a directory the agent reads/writes, your own storage backend) carries state across sessions; treat
  what it reads back as untrusted data too.

## Prompt caching (cost and latency)
- Put stable content first (tools, system prompt, fixed documents) and cache that prefix with one breakpoint;
  conversation tail after it.
- Three things break the cache mid-session: editing the system prompt, switching models, and adding/removing tools.
  Instead: append instructions as a new message, run the cheaper model as a **subagent**, use tool search.
- Measure the cache hit rate from the usage fields; do not claim savings you did not measure.

## Thinking and effort
- Current models think adaptively; tune **effort** before changing model. Lower effort = fewer, larger tool calls
  and shorter output; raise it only where correctness pays for the cost.

## Guards (the forge-agent hard rules, concretely)
- Iteration cap on the agent loop, per-call timeout, per-session token/cost budget, backoff with jitter on 429/529.
- Handle every `stop_reason` (tool use, end turn, max tokens, refusal); a truncated answer is not a finished one.
- Log tool calls and results (minus secrets/PII) so a failed run can be traced.

## Evals for a Claude-powered flow
- One flow per eval; 15–100 real inputs first (logs, tickets, user examples), synthetic only to fill gaps, PII checked.
- Grader ladder, cheapest first: code check (exact match, schema, end state of a sandbox) → blind pairwise vs a frozen
  baseline → model-graded rubric (the judge is not the model under test) → human spot check.
- Before a paid full run: pass an oracle (should score ~100%) and a null output (~0%) through the grader, confirm API
  errors are recorded as errors (not zero scores), estimate cost from a pilot, and get the owner's yes.
- The runner calls the app's **real** entry point, writes one row per case as it finishes (resumable), and reports
  the score with a confidence interval. Deeper eval method (error analysis, judges, synthetic data): `.claude/skills/forge-rag/references/evals.md`.
