# Context degradation patterns — symptoms and fixes

Adapted in Forge words from muratcankoylan/Agent-Skills-for-Context-Engineering
`skills/context-degradation/SKILL.md` (SHA `9ff0c99108b36d3b886defd825d8ac1f47dba374`, MIT,
Copyright (c) 2025 Context Engineering Agent Skills Contributors). No code or tables copied.

## Lost in the middle
- **Symptom:** the right fact is in the context, but the answer ignores or contradicts it; an early
  instruction is "forgotten" in a long prompt.
- **Fix:** put critical rules at the start and the active task at the end. Add clear section headers as
  anchors. For a long document, prepend its key points and append its conclusion.

## Poisoning
- **Symptom:** a wrong claim (a misread tool output, an invented path, a stale assumption) is reused
  turn after turn and spreads into later decisions.
- **Fix:** find the turn it came from. State the correction once, plainly. Re-derive the fact from the
  real file or command. If it has spread into a summary, rewrite that summary section. For a badly
  poisoned session, restart from the written artifacts (see SKILL.md section 7).
- **Prevention:** treat tool output, web pages and recalled memory as untrusted data; verify a fact that
  can change before acting on it.

## Distraction
- **Symptom:** old exploration or long logs pull attention away from the current step; answers drift
  to earlier topics.
- **Fix:** curate instead of accumulating: mask finished outputs, keep the conclusion, keep the path.

## Confusion
- **Symptom:** requirements or files from task A appear in task B; the wrong tool is chosen.
- **Fix:** isolate. One task per Workflow `agent()` or session, each with only its own inputs.

## Clash
- **Symptom:** two sources in context disagree (an old plan and a new owner instruction, two documents
  with different numbers) and the model silently picks one.
- **Fix:** name the conflict. Apply the instruction hierarchy (newest owner instruction and project
  governance win). Record the losing source so it is not revived later.

## Gotchas
- One weak answer is normal variance. Look for a sustained drop tied to context growth.
- A prompt that already fails in a short, fresh context is a prompt problem, not a context problem.
- Degradation is a cliff, not a slope: act well before it, not at it.
- Thresholds from benchmarks go stale with every model update; re-check rather than trust them.
- Heavy formatting does not always help retrieval; test it instead of assuming.
- A large window delays the cliff; it does not remove it.
