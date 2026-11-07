# forge-intake — Iteratieve intake (opt-in) (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps the heading and a short summary; this file keeps the complete original wording.

## Iteratieve intake — OPT-IN via `/forge interview` of config `intake: interview` (sweep-verbetering 2026-07-31; opt-in sinds 2026-09-23)

**Standaard vult de Lead de intake zélf in** (config `intake: silent`; forge-router Stap 0a: antwoorden uit de
missietekst, de projectscan, `.claude/.forge-setup.json` en het projectprofiel, vastgelegd als *Assumptions
(auto-filled)* in de PRD). Hooguit één vraag aan de owner, en alleen als (a) twee lezingen tot wezenlijk
verschillende bouwsels leiden, of (b) de actie naar buiten gaat of onomkeerbaar is (versturen, publiceren,
betalen, deployen) — gekozen door `forge-prompt-coach`, als 2–3 uitkomst-opties + "iets anders" (A aanbevolen
met één regel reden), gevolgd door één bevestigingszin: "Ik bouw dus: {herschreven opdracht}. Klopt dat?".
Een externe audit mat dat de verplichte vragenlijst een beginner 21–24 vragen voorlegde vóór er
iets gebouwd werd. De interviewmodus hieronder is waardevol, maar alleen wanneer de owner er expliciet om
vraagt (`/forge interview`, config `intake: interview`) of zelf "vraag het me eerst" zegt; de skills
`grill-me` / `grilling` zijn dan de interviewmotor. De laddering-methode (herhaald "waarom?") hoort hier,
niet in de standaardflow.

Waar het kanaal het toelaat (dashboard-wizard, interactieve chat): stel vragen **één per keer** in
plaats van één batchlijst — elk antwoord stuurt de vólgende vraag, tot er gedeeld begrip is. Sluit
ALTIJD af met de meta-vraag: **"Wat moet ik zelf nog verhelderen dat ik niet gevraagd heb?"** — die
vangt de gaten die de vragensteller zelf mist. Leg de scope-uitkomst vast in vier lagen:
**core** (moet nu) · **nice-to-have** (mag nu) · **maybe-later** (mét concrete trigger wanneer wel) ·
**expliciet-uit-scope** (opgeschreven zodat niemand het stilzwijgend alsnog bouwt). Batch-vragen
blijven het terugvalpad voor niet-interactieve runs; de recommended-markering per vraag blijft
gelden (verdiend advies, nooit random).
