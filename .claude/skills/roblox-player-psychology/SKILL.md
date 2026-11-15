---
name: roblox-player-psychology
description: "Use when designing or reviewing player-behavior mechanics: first minute, rewards, streaks, daily rewards, pricing, RNG/pity, community."
when_to_use: "Also for why players don't come back, reward timing, offer placement, crate odds, and auditing a feature for manipulative or dark patterns."
last_reviewed: 2026-11-13
sources:
  - original
  - https://create.roblox.com/docs/production/monetization/paid-random-items
---

# Roblox Player Psychology

## Roblox binding (read first; it wins)

`roblox-economy-ethics` wins over this skill on every price, luck, reward or pressure question. Nothing bought with Robux gives a random outcome, luck, power or speed. No purchase prompt in the first session or during play, no countdown, fake scarcity, "value" anchor or decoy next to a price, no reward that expires and no streak that resets. The effects below explain how players behave: use them to make playing and earning feel good, never to make stopping or not paying feel bad. About a third of age-checked daily users are under 13.

## When to Load

Load for behavior/persuasion questions: what happens in the first 60 seconds, why players return, reward schedules, streaks, pricing psychology, gamepass ladders, crate/RNG odds and pity, or turning players into a community. For structural craft (core loop, FTUE structure, level design, economy sources/sinks, retention phases) load `roblox-game-design`. Dashboard diagnosis, discovery and the algorithm have no pack skill yet: say so and work from `roblox-game-design` plus the Roblox analytics docs. For purchase implementation load `roblox-economy-ethics` (what may be sold) and `roblox-security` (receipts and purchase exploits).

## Quick Reference

### First 60 seconds (50% of new players never return)

0–5s spawn in-world (no logo/cutscene) → 5–10s do the core verb → 10–30s first reward lands → 30–45s open a loop (next milestone looks close) → 45–60s show what is ahead (a free preview of the next unlock; no shop prompt in the first session). Six effects: Zeigarnik (hand an incomplete goal in 10s), endowed progress (never start at zero), peak-end (best effect in minute one), cognitive load (one mechanic/one button/one goal), isolation (only the wanted action glows), reciprocity (give before the shop).

### Retention benchmarks & levers

D1 20/30/40% · D7 8/15/20% · D30 3/7/10% (good/great/excellent; compounds; 40% D1 ≈ 3× the players of 25% D1 by day 30). Low number → lever: PTR→curiosity gap/social proof; D1→Zeigarnik, endowed progress; session→flow, variable reward; D7→goal gradient, collections; D30→habit loop, social identity; conversion→a fair first purchase, charm pricing (no anchors or decoys); ARPPU→ladders, visible status.

### Hooks, pricing, RNG

Four reward schedules (fixed/variable × ratio/interval); layer all four. Hooks: appointments, streaks that pause on a missed day instead of resetting, rotation of free items, shared clan goals, hook model, specific timers ("Back in 4h 32m"). Ladder: 49–99 first purchase · 199–399 convenience and capped time boosts · 499–799 bigger cosmetic sets and private servers · 999+ identity; never luck, power or speed. RNG stays free (rolls earned by play): 5 tiers (55/27/12/5/1%), show the odds, the pool and the pity counter. Paid random items are out (`roblox-economy-ethics` rule 1).

> Full detail, tables, and community loop: [references/full.md](references/full.md)
