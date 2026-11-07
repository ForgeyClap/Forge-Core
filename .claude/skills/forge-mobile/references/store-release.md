# forge-mobile — store listing and release readiness

Provenance: rewritten in Forge's words, no sentence copied. Sources read 2026-11-06:
- coreyhaines31/marketingskills `skills/aso/SKILL.md` at `15b38b5388dfdd17f4ab424e986ccd32c24d5b22` (MIT): scoring
  dimensions, per-store indexing rules, common-issue list. Its `references/` spec files were not read, so numeric
  limits below are the ones quoted in the SKILL.md and must be re-checked against the current store docs.
- ParthJadhav/ios-marketing-capture `SKILL.md` at `00ae3cbe2250f6350b66aa23e24ba5883221836c` (MIT): the idea of
  reproducible, seeded screenshots per locale and its gotcha list. Its Swift and shell are NOT taken and never run here.
- REJECTED: sickn33 `app-store-optimization` (corpus: risk critical, no licence). Not read, not used.
Origin: the 2026-11-04 skills audit proposed a separate store-release skill; it was folded into this file (listing budget).

## Owner actions (hard line)
Submitting to the App Store or Google Play, App Store Connect / Play Console logins, signing keys, store credentials,
pricing, and answering review questions are the owner's. Agents prepare text and assets and a checklist; they do not
submit, and a queued build is not "approved".

## Listing checklist (verify limits in current store docs)
- Apple: title 30 chars, subtitle 30, hidden keyword field 100 bytes (comma separated, no repeated words, no spaces);
  the long description is not search-indexed, so write it for conversion. Google: title 30, short description 80, full
  description 4,000 and indexed, so keywords must appear naturally; no emoji, ALL CAPS or "best/#1/free" in the title.
- Screenshots: the first three carry the page; one message per screenshot; real UI, real data. Apple up to 10,
  Google 2 to 8; Google also needs a 1024x500 feature graphic for featured placements.
- Localise at least the markets you sell in; keep icon, name and category honest.
- Rating prompts: ask only after a success moment and within the platform's prompt limits.

## Screenshots and metadata process
Seed deterministic demo data in a debug-only path, fix locale, device and appearance, capture, then review each image
by eye. Demo data must never ship in the release build. Live Activities, sheets and stale view models can leak state
between locale runs: restart clean for each locale.

## Review-rejection pitfalls
Crashes or placeholder content; login-walled apps without a demo account; permission strings that do not explain use;
missing privacy policy or data-safety/privacy-nutrition answers that contradict the app; broken links; metadata that
mentions other platforms; in-app purchase rules ignored; background modes or permissions not needed.
Google Vitals (crash and ANR rates) also lower visibility.

## Evidence before handoff
Release build installs and launches; listing text within limits (character count shown); screenshot set per locale
listed; privacy answers drafted and flagged for owner confirmation; version and build numbers set.
