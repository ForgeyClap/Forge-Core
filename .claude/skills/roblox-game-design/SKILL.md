---
name: roblox-game-design
description: "Use when designing or reworking a Roblox game: core loop, tutorial/FTUE, levels, economy, retention phases, juice, grind, curation."
when_to_use: "Also when players quit early, the game feels boring or grindy, balancing rewards and prices, reviewing a design or game idea, and auditing the first session."
last_reviewed: 2026-10-14
sources:
  - original
  - https://departmentofplay.net/retention-framework-keep-your-players-forever/
  - https://gdcvault.com/play/1023845/This-is-a-Talk-About
  - https://www.youtube.com/watch?v=dBmIkEvEBtA
  - https://markfloryan.github.io/gamedesign/readings/Bartle_1996.pdf
  - https://devforum.roblox.com/t/roblox-curation-how-do-we-consider-games-for-today%E2%80%99s-picks/4005089
  - https://about.roblox.com/newsroom/2025/09/roblox-moments-user-generated-discovery
---

# Roblox Game Design Fundamentals

## Roblox binding (read first; it wins)

`roblox-economy-ethics` wins over this skill on every price, luck, reward or pressure question: no paid random items, no power, speed or luck for sale, no purchase prompt during play or in the first session, no countdown or fake scarcity next to a price. The field data in `references/full.md` records what developers reported. A line marked "rejected by this pack" is kept as an observation only and is never a design recommendation.

## When to Load

Load for the structural craft of a Roblox experience: core loop and meta-game architecture, tutorial/FTUE structure, level design, economy design, retention-phase planning, juice/game feel, Bartle balance, grind avoidance, Today's Picks or Moments readiness. Route elsewhere: persuasion/pricing → `roblox-player-psychology`, with `roblox-economy-ethics` deciding what may be sold; VFX → `roblox-vfx`; cost curves and rebirths → `roblox-simulator-economy`. Metrics, discovery and economy telemetry have no pack skill yet: say so and use the Roblox analytics docs.


## Quick Reference

- **Core loop first**: three layers must each work: core loop (moment-to-moment), meta-game (hour-to-hour), long-term progression (day-to-day). If the raw actions aren't fun, nothing above them survives.
- **Retention phases**: D0–7 understandability/novelty/stability → D7–30 progression/mastery/return triggers → D30–90 social comparison/LiveOps → D90+ community.
- **Teach invisibly**: teach through experience, never popups; environmental teaching, dynamic UI, kinesthetic learning, show don't tell, inverted pyramid of complexity.
- **Levels**: Kishōtenketsu (safe intro → develop → twist → conclusion) plus the invisible hand (coins/lighting guide without text) and fairness (deaths feel the player's fault).
- **Economy**: every source needs a sink; soft/hard/social currencies; prices must scale with the power curve; watch hoarding, churn at choke points, currency devaluation.
- **Anti-grind**: grind is a state of mind, not a mechanic. Fix with juice, skill ceilings, and measurable chunks.
- **Bartle**: Achievers/Explorers/Socializers/Killers form an ecosystem; over-serve one and the others leave.
- **Field data**: measured onboarding/monetization/retention numbers (2026; see full.md). Lines marked "rejected by this pack" break `roblox-economy-ethics` and are never followed.

> Full framework details, checklists, case studies (Stardew, Hades, Artifact), and the curation/Moments prep: [references/full.md](references/full.md)
