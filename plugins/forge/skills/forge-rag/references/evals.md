# forge-rag — Evals for RAG and LLM apps

Provenance: adapted in Forge's words from ai-evals-course/evals-skills `skills/` — `eval-audit`, `error-discovery`,
`write-judge-prompt`, `validate-evaluator`, `generate-synthetic-data`, `evaluate-rag` (Apache-2.0 per the repo
LICENSE; successor of the archived hamelsmu/evals-skills), read on `main` at `80d5f7b` on 2026-11-02,
plus the grader ladder and pre-run checks from anthropics/skills `skills/claude-api/shared/evals/build-eval.md`
(Apache-2.0). Licence text: `../LICENSE.txt`. Changes (Apache-2.0 §4(b)): condensed and rewritten; the
review web app of `error-discovery` (local server + CDN scripts), all code samples and the observability-MCP
connection step are not taken over.

Order matters: **look at traces → name the failures → build checks for those failures → validate the checks →
measure**. Building judges or dashboards before error analysis is the most common waste.

## 1. Error analysis first (before any metric)
- Collect real end-to-end traces (input, retrieved chunks, tool calls, output). No real traffic yet: generate
  synthetic inputs (section 5), run them, then analyse.
- Sample for variety: about two thirds cluster representatives, one third random; 15–25 to start, ~100 over time
  until new traces stop showing new kinds of failure (saturation).
- A domain expert (often the owner) reads full traces — not only final answers — and writes a free-text note on what
  went wrong first. Group the notes into **application-specific** failure categories ("quotes a price not in the
  source", "misses the opening-hours chunk"), not generic labels like "hallucination". Count each category.
- Re-run error analysis after a model switch, a prompt rewrite, a new feature or an incident.

## 2. RAG: evaluate retrieval and generation separately
Fix retrieval first: a generator cannot use what it never received.

| Query type | Primary retrieval metric |
|---|---|
| single-fact lookup | MRR (how early the first relevant chunk appears), k ≈ 1–2 |
| broad / synthesis | Recall@k, k ≈ 5–10 (first priority for first-pass retrieval) |
| reranking quality | Precision@k or NDCG@k (pair NDCG with Recall) |
| multi-hop | two-hop Recall@k (both chunks in the top k); classify hop-1 vs hop-2 misses |

- **Retrieval eval set**: queries mapped to the chunks that answer them — hand-curated (best), synthetic (one fact
  per chunk → one question only that fact answers) and adversarial (questions in the vocabulary of look-alike
  distractor chunks that only the target answers). Keep only realistic synthetic questions.
- **Chunking is a hyperparameter**: grid-search chunk size × overlap on the same eval set (re-index each time); split
  on natural boundaries and prefix each chunk with document title and section heading.
- **Generation**, once retrieval works: *faithfulness* (every claim supported by the retrieved context — a correct
  fact from the model's own memory still counts as a failure in RAG; also omissions and misreadings) and *answer
  relevance* (it answers the actual question).

| Context relevance | Faithfulness | Answer relevance | Diagnosis |
|---|---|---|---|
| high | high | low | the generator used the wrong part of a right document |
| high | low | — | hallucination or misreading |
| low | — | — | retrieval problem: chunking, embeddings, query rewriting, filters |

## 3. Evaluator design
- **Code first**: format, schema, required citation present, cited ID exists in the retrieved set, refusal phrase on
  out-of-scope, length — regex, parsing, schema validation, execution. No LLM judge for what code can check.
- **LLM judge** only for subjective failure modes (faithfulness, tone, completeness), with:
  1. one failure mode per judge (never "is this helpful?");
  2. **binary Pass/Fail** with precise definitions of both (no Likert, no letter grades; severity = several binary judges);
  3. 2–4 labelled few-shot examples from the *training* split (one clear pass, one clear fail, one borderline);
  4. structured output with the critique **before** the verdict;
  5. only the inputs it needs (question + retrieved snippet + answer for faithfulness).
- Start the judge on a strong model; make it cheaper only after alignment is proven. The judge is not the model
  under test. A missing instruction in the app prompt is fixed in the prompt first, not papered over with a judge.
- Not as the main generation metric: ROUGE, BERTScore, cosine/embedding similarity (fine for ranking, not for quality).

## 4. Validate every LLM judge against human labels
- ~100 expert-labelled traces per failure mode, near 50/50 pass/fail. Split: train 10–20% (few-shot source only),
  dev 40–45% (iterate here), test 40–45% (measure **once**). Never put dev/test examples in the prompt.
- Report **TPR** (human-pass judged pass) and **TNR** (human-fail judged fail), not accuracy or percent agreement
  (an always-pass judge looks accurate on skewed data). Target > 90% each on dev; minimum > 80%.
- Read every disagreement: false passes → tighten the fail definition / add edge examples; false fails → clarify pass.
- Production pass rate: correct the raw judge rate `p` with
  `θ = (p + TNR − 1) / (TPR + TNR − 1)`, clipped to [0, 1] (invalid when TPR + TNR − 1 ≈ 0), and report it with a
  bootstrap confidence interval. Below ~60 labels the interval is too wide to act on.
- Pin a dated judge model ID; re-validate after any prompt or model change.

## 5. Synthetic data (only to fill gaps)
- Start from where the app is likely to fail. Pick ~3 dimensions (e.g. task type × user persona × scenario:
  well-specified / ambiguous / out-of-scope); draft ~20 tuples with the owner, then generate more tuples.
- Two separate steps: tuples first, then each tuple → a natural user question (one prompt for both gives repetitive
  phrasing). Drop unrealistic, off-tuple or near-duplicate questions.
- Run them through the full pipeline and keep the whole trace. Re-check against real queries regularly.
- Do not use synthetic data when ~100 representative real traces exist, when nobody can judge realism, or for
  specialised legal/medical documents and low-resource languages or dialects (Dutch dialects included).

## 6. Running an eval honestly
- Before a paid run: grade an oracle (expected ~100%) and a null answer (~0%) to prove the grader works; make sure API
  errors are recorded as errors, not zero scores; estimate cost from a small pilot; owner approves the full run.
- The runner calls the app's real entry point, writes one row per case as it finishes, and the report gives the
  score with a confidence interval plus the failure-category counts. Constant or zero columns are runner bugs until
  proven otherwise.

## 7. Audit checklist (an existing eval setup)
Problem if any is true: no error analysis on real traces · generic failure labels · Likert or unthresholded scores ·
holistic judges · LLM judges on code-checkable criteria · judges never validated against human labels · accuracy or
Kappa as the alignment metric · few-shot examples from the measurement data · reviewers see only final outputs · too
few labels (< ~100 traces; < ~50 pass and 50 fail) · error analysis older than the last model or prompt change ·
evaluators never re-validated. Each finding: status (problem / OK / cannot tell), one-line why, the fix.
