---
name: forge-rag
description: "Playbook for chatbots and RAG: retrieval, cited answers (gebruik bij een chatbot)."
# A10 original description (listing budget): "Playbook for chatbots and RAG: retrieval, embeddings, source-grounded answers, leads (gebruik bij een chatbot bouwen)."
# W2-BUDGET original description (listing budget): "Playbook for chatbots and RAG: retrieval, source-grounded answers (gebruik bij een chatbot bouwen)."
---

# Forge playbook — AI chatbot / RAG

## Provenance
Forge-native playbook. `references/evals.md` adds eval method adapted in our own words (no file copied verbatim) from ai-evals-course/evals-skills (eval-audit, error-discovery, write-judge-prompt, validate-evaluator, generate-synthetic-data, evaluate-rag; Apache-2.0, `main` at `80d5f7b`, seen 2026-11-02) and anthropics/skills claude-api build-eval (Apache-2.0); see LICENSE.txt. Forge changes: no review web app, no code samples, no observability-MCP step; paid eval runs owner-approved.

## When to use
- Use for: AI chatbots and RAG: grounded answers with citations, honest fallback, human handoff, and measuring them (retrieval metrics, LLM judges).
- Not for: a tool-using agent (`forge-agent`), plain web search scraping (`forge-scraping`).

**Do not duplicate ECC skills — defer to:** `agentdb-vector-search` / `agentdb-memory-patterns` (vector store), `docs-lookup` (SDK docs), `learn-codebase` (grounding on a repo), `claude-api` (if Anthropic-based).

## Hard rules
- **Grounding:** answers are source-aware and cite their sources.
- **Clear fallback** response when retrieval is empty/low-confidence — no guessing.
- **No hallucinated business facts** (names, prices, contacts, claims).
- Safe data handling; conversation logging on; a defined human-handoff path.
- Lead capture is consent-aware; secrets/API keys in env only.
- **Measured, not felt:** retrieval and generation are evaluated separately on a real Q/A set; an LLM judge counts only after it is validated against human labels (`references/evals.md`).

## Retrieval design (defaults, change with evidence)
- Chunk on natural boundaries (sections, paragraphs, steps) and prefix each chunk with document title + heading; chunk size and overlap are tuned on the eval set, not guessed.
- Hybrid search (keyword/BM25 + vector, merged with reciprocal rank fusion) for names, codes and prices that embeddings miss; a reranker when precision matters.
- Metadata filters (tenant, language, product, date) applied **before** similarity search; tenant isolation is a filter, never a prompt instruction.
- A relevance threshold decides "nothing good found" → fallback, instead of always passing the top k.
- Ingestion is idempotent (stable chunk IDs, content hash) and re-embeds when the source or the embedding model changes.

## Team (conditional)
Lead: `architect`. Specialists: `mle-reviewer` (pipeline/serving), `data-scientist` (eval set, judge validation, honest metrics), `python-reviewer` / `typescript-reviewer`, `security-reviewer`, `database-reviewer` (vector store).

## Skills / commands / MCP
`agentdb-vector-search`, `docs-lookup`, `learn-codebase`; `claude-api` reference for model IDs/params if using Claude. `security-reviewer` on the serving layer. `forge-graded-verify` to grade answers at handoff.

## Fan-out & flow
L3 typical.
**Parallel:** ingestion/embeddings pipeline ∥ chat/retrieval layer ∥ frontend ∥ eval set (questions + gold chunks).
**Serial:** system prompt → retrieval → fallback → error analysis on traces → evaluators → safety eval.

## Domain gates
- System prompt reviewed; retrieval + embeddings correct; ingestion idempotent; citations present; fallback verified; no invented facts; logging + handoff defined.
- Retrieval is measured on an eval set on known Q/A with gold chunks: Recall@k (and MRR for single-fact lookups) reported; faithfulness and answer relevance checked separately from retrieval.
- Code checks first (citation present, cited ID in the retrieved set, refusal on out-of-scope); any LLM judge is binary, one failure mode per judge, with TPR/TNR measured on held-out labels.

## Ship-readiness (unique)
Fallback exercised with real output on empty or low-confidence retrieval; answers cite sources, and every answer in the eval set cites a retrievable source; out-of-scope questions are refused; no invented business info; PII + keys in env; logging on; handoff tested; regression eval run with retrieval metrics and judge results reported (with their TPR/TNR). The `ship-readiness` AI/RAG checklist is advisory; optionally run `codex-reviewer` (Codex) on important code — not a blocker.

## Safety, approval and honesty
- Approval / safety: lead capture is consent-aware; secrets/API keys in env only.
- Approval / safety: production transcripts used for evals only after PII/retention is checked; a paid full eval run waits for the owner's yes after an oracle/null check and a measured cost estimate.
- Honest failure: no hallucinated business facts; empty or low-confidence retrieval gets the fallback, not a guess.
- Honest failure: an unvalidated judge's pass rate is not a quality claim; report raw and corrected rates with an interval, or say the judge is unvalidated.
- Untrusted content: see `.claude/skills/forge-integration/references/untrusted-content.md`.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `.claude/skills/forge-integration/references/untrusted-content.md` — untrusted-content injection defense (shared, word-for-word the same for integration, rag and scraping).
- `references/evals.md` — error analysis, retrieval vs generation metrics, judge prompts, judge validation (TPR/TNR, bias correction), synthetic data, eval audit.
