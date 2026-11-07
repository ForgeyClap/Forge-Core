---
name: forge-report
description: "Use when delivering a /forge build or fix (eindverslag, wrap up)."
# A10 original description (listing budget): "Use when delivering a /forge build or fix (eindverslag, wat is er gedaan, wrap up): end-of-task report."
# W2-BUDGET original description (listing budget): "Use when delivering a /forge build or fix (eindverslag, wat is er gedaan, wrap up): end-of-task report."
---

# Forge delivery report

Be concrete and honest; reflect **only** checks that actually ran. Never claim agents/Codex/tests/preview that did not really happen. Do not say "done" if it isn't. Include all sections below.

## 0. Chat reply vs the file on disk (usage-minimisation)
The sections below are the CONTRACT for `.claude/forge-runs/<run_id>/final-report.md` — never trimmed, never skipped, always complete on disk. What actually goes in the **chat reply** is a SHORT summary only: **verdict** (Section 13's one-line pick) · **what changed** (2-4 lines, from Sections 3-4) · **checks run** (Section 5's real commands, one line each) · **blockers** (Section 11, or "none") · **still weak or unverified** (Section 15, q11) · **next step** (Section 14) — then the exact path to the full report for anyone who wants the rest. Never re-paste the whole file into chat by default; the owner can always open the path. A small L1 fix may compress this into 3-5 plain lines. A large/client deliverable still gets this short chat form **plus** the complete file — never a full re-paste in chat instead of writing the file.

## Sections of `final-report.md` (the on-disk contract)
Write ALL of these, in this order. The required content of each section (tables, allowed statuses and wording) is in `references/report-sections.md`; open it before writing the file.

1 Classification · 2 Project Adaptation · 2b Mission Blueprint + Skill Discovery · 3 What was done · 4 Files changed · 5 Checks/tests run · 6 Agent Activity Ledger · 6c Rework loop · 6b ECC Status block · 7 Memory Update · 8 Dashboard Update · 8b Command Pack Update · 8c Project governance · 9 Issues found · 10 Issues fixed · 11 Remaining risks · 12 Codex block · 12b Browser proof + Skill Registry + Fresh-install · 13 Final verdict · 14 Next step · 15 Self-review.

## Rules that hold in every section
- Section 5 lists actual commands and results only; run `node .claude/forge-bin/forge-verify.cjs <run_id>` before declaring a run complete (a mismatch means rework, not a pass).
- Ledger statuses ONLY: `ECC REAL INVOKED` · `ECC SKILL LOADED` · `NATIVE AGENT INVOKED` · `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED` · `BLOCKED`. Never label a native role as ECC; never claim a custom subagent/skill, a parallel agent, Codex, a screenshot or a dashboard that did not really run.
- The dashboard is reported as running only if the Command Center health check (`GET http://127.0.0.1:4100/api/health`) passed; never print a start/build command for the user to run.
- Final verdict is ONE of FULL PASS · PASS CORE / PARTIAL PROOF · PARTIAL · BLOCKED · FAIL, plus the per-layer verdicts; no FULL PASS when a required Codex/browser proof was blocked; BLOCKED needs `node .claude/forge-bin/forge-recovery.cjs check-block <record.json>` to report `ok:true`.
- Section 15 is the `## Self-review` section (owner HARD MUST, `docs/claude-md/end-self-review.md`): print it with `node .claude/forge-bin/forge-endreview.cjs template --run <run_id>`, answer every question with evidence or an open item, then `node .claude/forge-bin/forge-endreview.cjs record --run <run_id> --answers <answers.json>`. On an L2+ run the contract rule `end-self-review` warns while it is missing; a report without it is not finished.

The FILE on disk keeps every section above in full. The CHAT reply stays short — see Section 0.
