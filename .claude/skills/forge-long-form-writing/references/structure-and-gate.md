# forge-long-form-writing: structure, tests and the quality gate

## Shapes per type

**Technical tutorial (as an article).** Open with what the reader will have at the end. Every major section
shows code, a command, output or a screenshot. Use the step loop in
`.claude/skills/forge-i18n-docs/references/guides-and-reference-pages.md` §1. End with concrete next steps,
not a recap.

**Essay or opinion.** Start with a tension, a contradiction or one specific observation. One argument thread
per section. Every opinion answers to evidence from the source; mixed feelings stay mixed.

**Newsletter.** The first screen does real work: the news, the result, the thing the reader came for. No diary
filler up front. Section labels only when they help a reader scan.

**Case study ("hoe we X bouwden").** Chronological: the situation, what was tried, what went wrong, what worked,
the measured result **from the source**. Show the messy middle. No invented before/after numbers; if the
client has no figure, describe the change in words.

**Long LinkedIn post.** No markdown headings, no bold, no hashtag stacks (zero to two, in the text). The first
two lines carry the point, because the rest is folded away.

## The opening test
The first paragraph does one of these: names a problem the reader has felt; gives a surprising fact from the
source; describes a moment of friction, failure or discovery; asks a real (not rhetorical) question.
It never: defines a term everyone knows; starts with background that has no stakes; opens with "In de wereld
van vandaag" / "In today's ..."; states something nobody disagrees with; runs past three sentences.

## The ending test
The last paragraph extends the argument somewhere new, gives one concrete next step, leaves an honest open
question, or reframes what came before. It never: summarises the piece; starts with "Kortom", "Al met al",
"In conclusion"; predicts a bright future; ends with a call to action that would fit any article.

## The paragraph test
1. Could this paragraph move into an article on another subject unchanged? Then it is too generic: use the
   specifics the source gives, or cut it.
2. Does every paragraph start with its broadest claim? Start some with the specific case.
3. Is every paragraph the same length and shape? Vary them; a paragraph may be one sentence.

## Banned patterns (rewrite on sight)
Article-level patterns. Word-level and sentence-level tells (Dutch and English) are owned by `humanizer`
(§1 to §26 and `humanizer/references/forge-additions.md` §27 to §31); this list does not repeat them.

| Dutch | English |
|---|---|
| "In de snel veranderende wereld van vandaag" | "In today's rapidly evolving landscape" |
| "een gamechanger", "baanbrekend", "revolutionair" | "game-changer", "cutting-edge", "revolutionary" |
| "Daarom is dit belangrijk:" as a bridge on its own | "Here's why this matters" as a standalone bridge |
| a made-up kwetsbaarheidsverhaal ("Ik lag wakker van ...") that the writer never told | a fake vulnerability arc |
| a slotvraag only for engagement ("Wat vind jij? Laat het weten!") | a closing question added only to drive engagement |
| "Ik ben trots om te delen dat ..." | "Excited to share ..." |
| biography padding that does not move the argument | the same |
| "Geen poespas, gewoon ..." | "No fluff, just ..." |
| a nep-nieuwsgierigheidshaak ("Je raadt nooit wat er toen gebeurde") | a fake curiosity hook |

## The quality gate (before the humanizer pass)
- [ ] Every factual claim comes from the task, the owner's material or a named source; open claims are marked
      `[bron nodig]` and listed.
- [ ] No invented quote, customer, number, date or result.
- [ ] The opening and ending tests pass.
- [ ] Every section has one job and adds something new.
- [ ] Each section starts with proof, an artefact, a conflict or an example.
- [ ] Every code block and command was run, or is marked as an excerpt.
- [ ] The voice matches the profile; `je`/`u` is consistent; Dutch headings use Dutch capitals.
- [ ] Formatting fits the medium.
- [ ] Nothing was published, scheduled or sent.
