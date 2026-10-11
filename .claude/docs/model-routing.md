# Forge Model Routing — GOAT router (Claude) + NVIDIA Build/NIM as tool

## GOAT router (Claude runtime) — owner HARD rule 2026-10-06
Source: the Model Routing Playbook by @donimas (checked 2026-10-05). Machine-readable values: `.claude/FORGE_MODEL_ROUTING.json` (`routes`, `agentDefaults`, `escalation`, `lessons`). Global HARD MUST: `~/.claude/CLAUDE.md`.

**The five rules.** (1) Tune effort before you touch models. (2) Don't default to the top model (Fable). (3) Route by task type and risk with plain rules. (4) Verify with code; on FAIL escalate ONCE — more effort first, then a bigger model. (5) Log every miss as a one-line rule.

| Route | Model | Effort | When | Forge agent |
|---|---|---|---|---|
| router | sonnet (`sonnet[1m]`) | medium | the main session (the Lead) — classifies via triage and delegates | Lead |
| triage | sonnet | low | FIRST for every work package → `{route, risk, checks}` | Head Chef |
| quick | sonnet | low | small and well-specified, one or two files | owning Boss |
| build | opus | medium | a normal feature or bug fix | owning Boss |
| deep | opus | xhigh | architecture, migrations, auth, payments, data, production, security, or anything unclear | owning Boss |
| escalate | fable | high | ONLY after a failed check — never chosen up front | the same Boss, re-dispatched |
| verifier | sonnet | medium | after EVERY work package; PASS/FAIL with evidence; never edits | Verify Boss |

Haiku is not part of the standard: no route and no agent default uses it.

**Default route per agent** (frontmatter `model`/`effort` == `agent-model-map.json` `claudeTier`/`claudeEffort` == `agent-tool-policy.json` `model`):
head-chef → triage (sonnet/low) · verify-boss, test-boss, codex-reviewer → verifier (sonnet/medium) · docs-, skill-, search-, seo-boss → quick (sonnet/low) · build-, ui-, integration-boss, data-scientist, electron-pro, mcp-developer, ml-engineer → build (opus/medium) · boss, review-boss, security-boss, payment-integration → deep (opus/xhigh).

**Ultracode dispatch (default since 2026-10-06).** `~/.claude/settings.json` has `"ultracode": true`: for every substantive task the Lead (router) authors a fresh Workflow — no fixed templates, any domain — and gives each part its own fresh-context agent: triage (Head Chef, sonnet/low) → `agent({agentType:'<boss>', label:'<Boss Name> · <part>', model:<route model>, effort:<route effort>})` → Verify Boss (sonnet/medium) → one escalation step on FAIL. Live probe 2026-10-06: inside a Workflow an `agentType`'s frontmatter model + effort apply, opts override them, and an `agent()` with neither inherits the session model. So pass `model` + `effort` whenever the route differs from the Boss default; the PreToolUse hook `~/.claude/hooks/goat-workflow-guard.cjs` denies an unrouted `agent()`. Ultracode drops the built-in cost guards (no large-workflow warning, no subagent concurrency limit): triage, the low/medium routes, the workflow size guideline and the usage-guard pauses are the cost control, and trivial asks stay solo. On Claude Code 2.1.220 the Lead itself runs at xhigh; from 2.1.284 ultracode keeps the chosen effort (sonnet/medium). Off: remove the key (one session: `claude --settings '{"ultracode":false}'`; guard only: `GOAT_WORKFLOW_GUARD=off`). Machine-readable: `FORGE_MODEL_ROUTING.json` → `ultracodeDispatch`.

**How a dispatch works (fallback when ultracode/workflows are off).** The Lead passes the route model with `Agent({subagent_type:'<boss>', model:<route model>})` — the `model` param overrides the frontmatter. The Agent tool has **no effort param**: effort is the Boss frontmatter default, or the route effort via a Workflow `agent({agentType:'<boss>', model, effort})`. An unsupported effort is silently lowered (xhigh/max → high). Never set `CLAUDE_CODE_SUBAGENT_MODEL` or `CLAUDE_CODE_EFFORT_LEVEL` — each flattens every per-agent value. `/tasks` shows each running subagent's model and effort.

**Escalation ladder (exactly one retry, one step up).**
- Process failure (Verify Boss: a file was skipped, the tests were not run) → more effort first: same Boss one effort level up (Workflow), else the next route (quick → build).
- Capability failure (full context, still wrong) → bigger model: build → deep → escalate (fable/high).
- A second FAIL stops the package; report it honestly to the owner. No repair loop — failed cheap runs cost more than 4× a successful one.
- After any escalation: one line `<YYYY-MM-DD> <task pattern> → <route that worked>` in `.claude/agent-memory/head-chef/MEMORY.md`. Head Chef reads it before every triage.

**Test gate.** The global Stop hook `~/.claude/hooks/goat-stop-gate.cjs` (on by default) runs the tests related to the changed code files and blocks the stop while they fail. Per-repo config: `.claude/goat-gate.json`. Opt-out: see `config/orchestration/HOOKS_OPT_IN.md` §2.

## Two honest layers
1. **Agent runtime (Claude).** Forge subagents are Claude Code Agent-tool spawns — they run on `sonnet`/`opus` (and `fable` only as the escalate step) per the GOAT routes above + `config/agents/agent-model-map.json` (`claudeTier`/`claudeEffort`). NVIDIA models **cannot** host a Claude Code subagent — nobody should claim otherwise.
2. **NVIDIA as tool (bulk offload only).** A Boss calls NVIDIA via `forge-bin/nvidia-provider.cjs` ONLY for genuinely bulk, low-risk work (first-draft docs, metadata/audit first-pass, source pre-summarization, registry validation, bulk fixtures, mechanical scaffolding/CRUD codegen). **Claude-first is the default** (2026-07-07 evidence); reasoning/review/coding/security/integration/vision stay on Claude. **Enforced in code**: the 6 `claudeWinsSkipNvidia` Bosses (boss, head-chef, review-boss, security-boss, integration-boss, ui-boss) are HARD-BLOCKED from NVIDIA; every NVIDIA call must pass its Boss slug (`--agent <slug>`), and NVIDIA-generated code is stamped `codeGateRequired` and MUST pass the build+test gate. Text-only adapter → NVIDIA vision is NOT usable; screenshot analysis runs on Claude.

## Key & env (SAFE)
- **Real key location (only these, both git-ignored/outside git):** project `.env` → `NVIDIA_API_KEY=nvapi-…` **or** global `~/.claude/nvidia.env` (one key for ALL projects; project `.env` overrides global).
- Never in git, code, logs, or reports — the adapter masks `nvapi-…` in every output. `.env.example` carries placeholders only.
- Endpoint (official docs): `https://integrate.api.nvidia.com/v1/chat/completions`, `Authorization: Bearer $NVIDIA_API_KEY`, OpenAI-compatible. Free tier ≈ 40 req/min → adapter handles 429 + Retry-After.

## Role slots (env-overridable; RE-VALIDATED against the live catalog 2026-09-24)
| Slot | Model | Why |
|---|---|---|
| default | mistralai/mistral-nemotron | REMAPPED 2026-09-24 (was nvidia/nemotron-3-nano-30b-a3b — now HTTP 410 Gone); small non-reasoning instruct, live 'OK' in 365ms — drafts/summaries/classification |
| fast / coding-fast | mistralai/mistral-nemotron | same pick (nano is gone); terse and coding-capable — routing/formatting/bulk first-pass; NVIDIA code still goes through the build+test gate |
| reasoning | nvidia/nemotron-3-super-120b-a12b | REMAPPED 2026-09-24 (was deepseek-ai/deepseek-v4-flash — now HTTP 410 Gone); shares the coding model; live 724ms at 300 tokens — give it token headroom |
| review | z-ai/glm-5.3 | REMAPPED 2026-09-24 (was mistralai/mistral-small-4-119b-2603 — now HTTP 410 Gone); a different model family than the coder for an independent 2nd opinion; thinking model, needs >=400 max_tokens; liveness-only evidence so far |
| coding | nvidia/nemotron-3-super-120b-a12b | unchanged since 2026-07-17; still live 2026-09-24 (724ms clean at 300 tokens) |
| vision | meta/llama-3.2-11b-vision-instruct | REMAPPED 2026-09-24 (was meta/llama-4-maverick-17b-128e-instruct — now HTTP 410 Gone); adapter is still text-only, real vision stays on Claude |

> Do NOT use: the four former role models that answer **HTTP 410 Gone** since 2026-09-24 (nemotron-3-nano-30b-a3b, deepseek-v4-flash, mistral-small-4-119b-2603, llama-4-maverick-17b-128e-instruct); deepseek-v4-pro, qwen3-next-80b, qwen3.5-122b/397b (HANG), codestral/codellama/granite-code (404), gpt-oss-20b/nano-9b (empty) — see `model-capability-matrix.json` `notAvailableOrBroken`. `route <agent>` now warns if an env override points at an avoid/broken model.

Override per project via `.env`: `NVIDIA_REASONING_MODEL=…` etc. Change models in `config/models/model-capability-matrix.json` — **no core code edits needed**.

## Commands
```
node .claude/forge-bin/nvidia-provider.cjs health            # connectivity (mock-mode zonder key)
node .claude/forge-bin/nvidia-provider.cjs models --verify   # live list + warn on stale role models
node .claude/forge-bin/nvidia-provider.cjs route boss        # resolve+validate an agent's models
node .claude/forge-bin/nvidia-provider.cjs chat --role coding --prompt "..."
node .claude/forge-bin/nvidia-provider.test.cjs              # offline tests (46, no network)
```

## Rules
- **Fit first:** never assign a model outside its caps (vision task ⇒ vision model; implementation ⇒ coding model). `route <agent>` warns on violations; `prohibited` lists per agent block obvious misfits.
- **Fallback chain:** NVIDIA role model → NVIDIA fallback role → the agent just does the work on its Claude runtime model (labeled `nvidia-skipped`). NVIDIA down ≠ blocked work; mocks are never presented as real output.
- **Premium rule:** the Claude runtime follows the GOAT routes above (security/architecture/final QA = route deep, opus/xhigh); NVIDIA never replaces a Claude route.
- **No live calls without key**; with key, live verification only via the explicit commands above.

## Function fit (WP-NVIDIA-FIT, LAW for bulk offload, not advisory)
An agent's default NVIDIA role (above) is a starting point, not the last word: a Boss's bulk work must be routed by **function strength**, not just its flat role. `config/models/function-model-fit.json` maps each bulk-work function (code-draft, doc-draft, research-digest, data-extract, summarize, translate-rewrite, test-sketch) to the model *judged good at it by a real live probe* — pass `--function <fn>` to `chat`/`route` (`nvidia-provider.cjs`) to use it; omitting `--function` keeps the old role/model behavior unchanged. **A function with no fit model (all probes judged wrong) routes to NONE — Claude keeps that work, full stop; never force a bad-fit model onto NVIDIA.** `claudeWinsSkipNvidia` Bosses stay hard-blocked from NVIDIA regardless of `--function` — function-fit can never bypass that gate. Every fit judgment's literal probe evidence lives in `function-model-fit.json` itself (evidence field + verdict: correct / correct-but-slow / partial / none) — the same honesty discipline as `model-capability-matrix.json`. Re-probe function fit on the same ~1-week cadence as the role matrix; a model's function fit can drift the same way its role fit does.

## Consolidation (WP-NVIDIA-CONSOLIDATE)
Cross-probing every function's weak spot against `nemotron-3-nano`/`nemotron-3-super`/`deepseek-v4-flash` on the same real tasks found 2 models now cover all 7 bulk-work functions at fit="correct" — `nemotron-3-nano` (doc-draft, data-extract, summarize) and `nemotron-3-super` (code-draft, test-sketch, research-digest, translate-rewrite) — so `minimax-m3` and `mistral-small-4-119b-2603` are no longer needed by any function, and the `default` ROLE was remapped from `minimax-m3` to `nemotron-3-nano` (~16.7x faster on a real summarize task, same correctness). Full evidence (including every losing candidate) is in `function-model-fit.json`'s `consolidation` block; `deepseek-v4-flash`/`mistral-small-4-119b-2603` remain the `reasoning`/`review` ROLE defaults for non-function-routed calls, unchanged.

## Live re-validation
The live catalog drifted again: `models --verify` listed 82 live ids and 6 of the 7 role models were missing (only `coding` was LIVE). One minimal chat probe per model (`Reply with exactly: OK`, 16 tokens (300-400 for the thinking-model re-probes), 25 s timeout, one request per probe, sequential; 16 probes in total) returned HTTP 410 Gone ('has reached its end of life') for the old default/fast/coding-fast, reasoning, review and vision models. New map: default/fast/coding-fast -> `mistralai/mistral-nemotron`, reasoning -> `nvidia/nemotron-3-super-120b-a12b` (shared with coding), review -> `z-ai/glm-5.3`, vision -> `meta/llama-3.2-11b-vision-instruct`. After the change `models --verify` shows all 7 LIVE and `route` resolves every Boss with exit 0 (the 6 bulk Bosses with 0 warnings). Limits: a probe proves a model answers, not how well it does its role — mistral-nemotron and glm-5.3 are liveness-only for their new slots. **Open gap:** `function-model-fit.json` still pins the retired `nemotron-3-nano-30b-a3b` for doc-draft, data-extract and summarize, so those `--function` calls get HTTP 410 until a function-fit re-probe reassigns them (`route <agent> --function <fn>` warns BROKEN/avoid for them). The full probe table is in `model-capability-matrix.json` `_doc`. **Closed the same day:** same-task cross-probes re-pointed doc-draft and summarize to `nemotron-3-super` and data-extract to `glm-5.3` (11 probes; evidence in `function-model-fit.json`); all 9 allowed `route <agent> --function <fn>` calls now exit 0 with no warnings. Risk: `mistral-nemotron` (default/fast/coding-fast) answered pings fast but timed out on 3 of 4 real-task probes — its role binding needs a real-task re-probe.
