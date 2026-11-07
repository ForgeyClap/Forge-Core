# Writing craft for agent documents

Read this before writing or rewriting the body of a skill, a Boss prompt, or a reference file. It is the
vocabulary behind steps 4, 5 and 7 of `forge-skill-authoring`. Rewritten in Forge words from mattpocock
writing-for-agents and SKILL-MECHANICS (MIT), hermes skill authoring (MIT), skill-judge (MIT) and pstack
authoring-a-skill (MIT); provenance in the SKILL.md.

## Contents
1. Context pointers
2. The two loads
3. The information hierarchy
4. Completion criteria
5. Leading words and positive phrasing
6. Knowledge delta and freedom
7. Pruning

## 1. Context pointers
A pointer is a line that sits in the agent's context, names material that is not loaded, and says when to
reach it. A skill description is a pointer; so is a line in CLAUDE.md that names a doc, and so is "read
`references/<file>.md` when ...". The wording of the pointer, not the quality of the target, decides how reliably
the material is reached. When a must-have target is missed, sharpen the pointer first; move the material
inline only if sharpening fails.

A pointer states what the material is and lists the distinct cases (branches) that should send the agent
there. Always-loaded pointers cost tokens on every turn, so:
- put the trigger word first;
- write one trigger per distinct case; synonyms of one case are one case written twice;
- drop identity the body already carries.

## 2. The two loads
- **Context load**: what sits in the window every turn (CLAUDE.md lines, skill descriptions). It costs tokens
  and attention whether or not it fires.
- **Owner load**: what the owner must remember (which user-invoked skills exist, when to type them). This is
  the price of the owner staying in control; spend it where the owner's judgement matters.

A model-invoked skill pays context load for discoverability. A user-invoked skill pays owner load instead. A
reference reached only through a pointer pays just the pointer's line.

## 3. The information hierarchy
A document mixes **steps** (ordered actions) and **reference** (rules and facts consulted on demand). Place
each piece on a ladder by how soon the agent needs it:
1. in-file step;
2. in-file reference (a flat list of rules on one rung is fine);
3. disclosed reference: a separate file behind a pointer.

Push too little down and the top bloats; push too much and needed material hides. The cleanest test: inline
what every branch needs, disclose what only some branches reach. Reference that should be disclosed but sits
between steps makes attending to those steps a coin flip.

Keep a concept's definition, rules and caveats under one heading (co-location). Scattering one meaning over
many places is a different fault from duplicating it, and both make the document read less like documentation.

A document that is too long, even when every line is live, thins the agent's attention. The cure is the
ladder and a split by branch or sequence, never cutting live content to hit a number.

## 4. Completion criteria
Every step ends on a condition that tells the agent the step is done. Two properties matter:
- **Clarity**: can the agent tell done from not done? A vague bound ("understanding reached") invites
  stopping early, because the visible later steps pull attention forward. Sharpen the bound first. Only if it
  stays fuzzy and you see the rush, hide the later steps by splitting the sequence, and only across a real
  context boundary (a hand-off to a fresh Boss or Workflow agent; an inline call hides nothing).
- **Demand**: how much it requires. "Every changed file accounted for" drives more legwork than "list the
  changes". Demand also binds flat reference: "every rule applied" is a criterion too.

The strongest criteria are both checkable and exhaustive. In Forge they are usually a command and its output
("`node --test` green", "the eval run shows 0 failed").

## 5. Leading words and positive phrasing
A leading word is a compact concept the model already knows (red, tight loop, root cause, regression test,
sediment, tracer bullet). Repeated as a token, it anchors a whole behaviour in few tokens. Prefer an existing
word to a coined one: a coined word must be defined, a known word brings its meaning for free. Hunt for a
phrase spelled out at three sites, or a sentence gesturing at one idea, and collapse it into one word.

Steering by prohibition puts the forbidden behaviour into context and makes it more likely. State the target
behaviour instead ("write one-line comments"). Keep a prohibition only as a hard guardrail that cannot be said
positively, and pair it with the positive target. Forge's hard gates (no push, deploy or spend without the
owner) are such guardrails.

A rule that tells the agent what to do usually needs no reason. Add the reason only when the rule is
confusing without it, or when the reason marks the rule's boundary.

## 6. Knowledge delta and freedom
- Value = what the document adds minus what the model already knows. Sort each section into expert (keep),
  activation (keep if one line), redundant (delete). A tutorial on basics is redundant by definition.
- Match freedom to fragility: high freedom (principles) for design and writing, medium (ordered checks) for
  review, low (exact command, exact file) for fragile operations such as frontmatter syntax, migrations and
  hard gates. Ask: if the agent gets this wrong, what breaks?
- A vague warning ("be careful with edge cases") is a no-op. Replace it with the specific failure and what to
  do instead, or delete it.

## 7. Pruning
- **Single source of truth**: one meaning, one place, so a change is a one-place edit. Duplication also
  inflates a meaning's weight beyond its real rank.
- **The environment is a source**: scripts, config files, folder layout and `--help` output. A document that
  restates them is a cache that goes stale. Cache only what is expensive to look up.
- **Relevance**: a line that never bears on the task, or describes behaviour that changed, is dead weight.
  Without pruning, old layers settle because adding feels safe and removing feels risky (sediment).
- **No-ops**: a sentence the model already obeys by default. The test is relative to the model, so settle a
  disagreement by running the document (`forge-skill-testing`), not by debate. Delete the whole sentence,
  not a few words of it. A leading word too weak to beat the default is a no-op too; reach for a stronger word.
