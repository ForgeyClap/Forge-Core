# forge-prompt-coach — evidence base and why this exists (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps a two-sentence summary; this file keeps the complete original wording.

**Evidence base.** Every rule below is grounded in Forge's own internal UX research (35 sources). The ids in square brackets, such as [GOOG] or [G-Q], are short internal
source labels kept for traceability during development — the underlying research file is a dev-only
artifact and is not part of a fresh install, so the labels are not meant to be dereferenced by the shipped
product; treat this SKILL.md as self-contained. Nothing here is new research. Where this skill makes a
Forge design choice that no source states (for example the exact gap ranking in §2), it says so.

**Why this exists.** The owner builds Forge for beginners who do not think in computer terms. Beginners
write short requests: successful prompts are about 21 words, first attempts fewer than 9 [GOOG]. They expect
the AI to understand them the way a person would [JOHNNY] and often cannot put into words what they want
[NNG-AB]. One good clarifying question gives a large gain (more than 170% better retrieval in [ALI]); asking
only where the intent is genuinely uncertain doubles the benefit [ZC]; bad questions make things worse ([ZOU],
secondary, abstract not verified). Anthropic lists checking in or asking clarifying questions too often on
simple agentic tasks as something to avoid [CONST]. So this skill does two things: it fills most gaps
**silently** with safe, stated assumptions, and when one gap really matters it asks **one** easy
multiple-choice question.
