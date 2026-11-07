# forge-prompt-coach — §1 the 9 ingredients of a buildable request (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps the ingredient names and the scoring rule; this file keeps the complete original wording.

| # | Ingredient | Beginner line (EN) | Beginner line (NL) | Text signals (heuristic) | Sources |
|---|---|---|---|---|---|
| 1 | Result | "Say what you want to have at the end." | "Zeg wat er aan het eind moet staan." | a deliverable noun (website, page, bot, workflow, list, dashboard, form, report) plus a concrete verb (build, make, add, connect, remove); missing when only vague verbs appear | [CC-BP][PBP] |
| 2 | Why and for whom | "Say who it's for and why." | "Zeg voor wie het is en waarom." | `voor/for` + a person (customers, members, team, me); `zodat/so that/omdat/because/om te` | [CONST][CARE] |
| 3 | What already exists | "Say what you already have and where." | "Zeg wat er al is en waar het staat." | URL, path, extension, folder name, existing/current/"we hebben"; RISK: "mijn site", "de app" without an anchor | [CC-BP][SUPA] |
| 4 | How we see it is done | "Say how we'll both see it worked." | "Zeg hoe we zien dat het gelukt is." | `klaar als/is goed als/done when/moet kunnen`, numbers, `test`, "ik wil kunnen…" | [CC-BP][DEF-SUCCESS] |
| 5 | One example | "Show one example instead of adjectives." | "Laat één voorbeeld zien in plaats van 'modern'." | URL, `zoals/net als/like/bijvoorbeeld`, a quote, a pasted error, a screenshot; RISK: taste words (modern, strak, mooi, professioneel, cool) without a reference | [PBP][LOV][EXMAP] |
| 6 | What must not change | "Say what must stay the same." | "Zeg wat niet mag veranderen." | `niet/geen/zonder/alleen/blijft/laat…staan/don't/only/keep` | [LOV][CODEX] |
| 7 | Size of the first step | "Ask for the smallest useful first version." | "Vraag eerst de kleinste versie die al nuttig is." | `eerst/first/alleen/simpel/één pagina/demo/MVP`; RISK: platform names (Facebook, Uber, Airbnb, Amazon, Bol, Marktplaats), `alles`, `platform`, `net als X maar` | [LOV][SHAPEUP] |
| 8 | Limits (time, money, tools, language, sending) | "Say what we must stay within." | "Zeg binnen welke grenzen: tijd, geld, programma's, taal." | `€`, gratis/free, budget, dates, "voor vrijdag", tool names (n8n, WordPress, Shopify, Telegram, Sheets), Nederlands; RISK: send verbs (stuur, mail, post, betaal, publiceer) without a limit | [SHAPEUP][GOOG] |
| 9 | (bugs) Symptom, steps, error | "Say what you did, what you saw, what you expected." | "Zeg wat je deed, zag en verwachtte." | error text, `als ik…dan…`, `sinds`, `verwacht`, a stack trace; RISK: only "werkt niet / kapot / doet raar" | [CC-BP][CODEX] |

Global signals: fewer than 9 words is high risk [GOOG]. Dutch vague words: beter, mooier, strakker, moderner,
professioneler, fixen, regelen, iets met, dingen, enzo, beetje, optimaliseren, verbeteren, opschonen.
**Not every request needs every ingredient** [CARE][WPDS]: score the gaps that change the build, not
completeness.
