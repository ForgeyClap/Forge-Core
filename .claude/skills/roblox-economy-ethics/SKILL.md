---
name: roblox-economy-ethics
description: "Use when designing, pricing or reviewing Roblox Robux items, odds, rewards or retention: shop, game pass, battle pass, loot table, daily reward, streak (winkel, prijzen, kansen, pay-to-win)."
license: CC-BY-4.0
last_reviewed: 2026-11-11
---

# roblox-economy-ethics: fair monetisation and retention

A monetisation or retention design is judged first on whether it is fair to a free player and keeps every
leaderboard honest, then on whether it is fun, and only then on revenue. These are the pack's default rules.
A project may tighten them (for example for a younger audience) in its own design docs; it never loosens rule 1,
3 or 5 without an owner decision recorded in the project decision log.

## When to use
- A shop item, game pass, developer product, battle pass, loot table, daily reward, streak or offer is designed,
  priced or reviewed.
- Someone asks "is this pay-to-win", "may this be sold", "are the odds right", "what will this earn".
- Not for: the maths of cost curves and rebirths (`roblox-simulator-economy`); DataStore safety (`roblox-datastores`);
  exploit review of the purchase code (`roblox-security`).

## Default rules
1. **No paid random items.** Nothing bought with Robux, directly or through anything bought with Robux, gives a
   random outcome: no luck boosts, rerolls, paid pity counters, mystery boxes, chest keys or paid hatches. Random
   rolls stay free. Check `PolicyService:GetPolicyInfoForPlayerAsync` (`ArePaidRandomItemsRestricted`) anyway: the
   platform rule wins where it is stricter.
2. **What may be sold:** time (capped boosts and skips), convenience (slots, capacity, private servers), second
   chances bought before a run with a free route next to them, and cosmetics at a fixed price. The project sets the
   caps in data (for example the largest boost and how many skips per season).
3. **Never for sale: power, speed, luck or a skill outcome.** No Robux item changes movement, damage, health,
   cooldowns, drop rates, luck or anything that decides a fight, a race or a climb. A cosmetic never changes what a
   player can see or hear of the game (size, visibility, audibility).
4. **Paid assists keep boards honest.** A run that used a bought assist is marked on the server and kept apart from
   the unassisted board (or the project explains how its boards stay fair). Only the server sets that flag; paid and
   earned versions of an item are separate item ids.
5. **No pressure next to a price.** No countdown, "only today", "last chance", "x left" or fake scarcity on a Robux
   item. `MarketplaceService:Prompt*` runs only after the player opened the shop or a pass panel; never inside play,
   never in the first session, never after a loss, a death or a rare moment.
6. **Free random rewards show their odds:** every outcome with a number, summing to exactly 100 %, visible before the roll.
7. **One honest price.** Robux prices are shown directly. No premium currency bought with Robux hides the price; no
   fake discounts or "value" anchors.
8. **Model the median player first.** Every estimate shows what a median free player earns and can reach at day 1,
   7 and 28, before the top spender.

## Retention without pressure
- Retention is measured in buckets (day 1, days 2 to 7, days 8 to 28); the first 90 seconds decide whether a new
  player stays; days 8 to 28 need a real reason to return; co-play is worth designing for; honest thumbnails beat clickbait.
- Good return reasons: an unfinished collection page, a pet or plot that grew, this week's board, a new mode each
  season. Not: a streak that is lost, a reward that expires, a daily luck reset, anything that punishes a missed day.
- A streak forgives missed days (it pauses, it does not reset). A daily reward can be claimed late.
- The first rare-looking moment is earned by play and is never followed by a shop prompt.

## Revenue estimate (honest, median first)
1. State the median month, then the 90th percentile, then the outlier. The median is the headline.
2. Every estimate states its conversion rate and average spend per paying player, with a source or the word "assumption".
3. State the visits needed to reach the DevEx cashout floor, and say plainly when the median does not reach it.
4. Platform numbers (DevEx rate, cashout floor, Roblox's cut) are dated facts: confirm them in the Roblox
   documentation with the check date before they enter a document. No tax advice; that is for the owner and a professional.

## Sink and faucet sanity
For every currency list each faucet and each sink per hour for a median player, per mode, at day 1, 7 and 28. Check:
no sink that only a Robux buyer can reach in practice; no faucet a bot or a duplication exploit can run (server-side
grants only, rate-limited remotes); every price also shown in minutes of median play; no mode that is the farm mode
(currency per hour per mode within about 20 % of each other); loot table weights sum to 100 %.

## Checklist a monetisation design must pass
Mark each PASS, FAIL or UNKNOWN with the file or line that decides it. One FAIL blocks the design.

| # | Check | How to check |
|---|---|---|
| 1 | No paid random item, direct or indirect | read the product list and the grant code |
| 2 | PolicyService read (`ArePaidRandomItemsRestricted`, `IsPaidItemTradingAllowed`) in a pcall that fails closed | Grep `GetPolicyInfoForPlayerAsync` in server code |
| 3 | Trading UI hidden when `IsPaidItemTradingAllowed` is false | read the trade UI gate |
| 4 | Free random rewards show every outcome with odds summing to 100 % before the roll | read the UI and the data table |
| 5 | No Robux item changes power, speed, luck or what a player sees or hears | read the product and pass grants |
| 6 | No countdown or scarcity text on a Robux surface; no `Prompt*` call outside the shop and pass UI | read the shop strings and every prompt call site |
| 7 | ProcessReceipt is idempotent: a PurchaseId ledger in the profile, grant before `PurchaseGranted` | read the receipt path and its test |
| 8 | Prices in Robux with no fake anchors; nothing sold for a Robux-bought currency | read the shop strings and product data |
| 9 | Median player model attached (day 1, 7, 28 per mode) | the design doc |
| 10 | Time items capped in data; every paid assist marks the run on the server | read the caps and the run ledger |
| 11 | Dated platform facts carry a check date and a source | the design doc |

Who checks: the rbx-game-director agent writes the design; the rbx-security-reviewer agent (or Security Boss) reviews
rules 1 to 5 and rows 7 and 10 on the deep route. Creating paid products through Open Cloud is an owner gate.

## Output
```
## Economy ethics review: <item or design>
Median player: earns <x>/h per mode, reaches <y> by day 1 / 7 / 28 (assumptions: ...)
Checklist: # | PASS/FAIL/UNKNOWN | evidence
Sink/faucet table: currency | mode | faucet/h | sink/h | day 1 / 7 / 28
Verdict: passes / blocked by #...
```

## Provenance
| Source | Taken | Excluded |
|---|---|---|
| fwjelaa Claude Code plugin by fwjelaa (FWJ STUDIOS), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/): the `revenue-modeler` and `retention-architect` agents, through the adapted skill of an owner Roblox project () | retention buckets, refusing to extrapolate from success stories, median-first estimates, sink/faucet checks | selling luck, auto-roll, limited-time rarity, daily luck resets, "front-load the dopamine", the agent files and their model pins, tax advice; every project-specific |

Changes: rewritten in generic Forge words on 2026-11-11 as a default rule set for any Roblox project. Based on work by
fwjelaa (FWJ STUDIOS), licensed CC BY 4.0; this adaptation is shared under the same terms.
