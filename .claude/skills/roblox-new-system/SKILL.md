---
name: roblox-new-system
description: "Use when planning a new Roblox gameplay system (shop, quests, daily reward, leaderboard, codes, a Service or Controller) as a test-first work package (nieuw systeem, systeem toevoegen)."
license: CC-BY-4.0
last_reviewed: 2026-11-11
---

# roblox-new-system: plan a gameplay system as a test-first work package

This skill turns a system idea into a Forge work package with the spec written first. It plans; it never writes game
code itself. The build lane Head Chef assigns writes the code inside its file ownership.

## When to use
- A new system is proposed: shop, quests, daily reward, leaderboard, codes, trading, rebirth, an inventory, a Service
  or a Controller.
- Not for: changing one function (a normal build package); auditing existing code (`roblox-game-audit`); pricing
  decisions (`roblox-economy-ethics`).

## 0. Survey before planning
Grep the source for anything the system would duplicate: `ProcessReceipt`, `GetDataStore`, `UpdateAsync`, `SetAsync`,
the remote contract module, existing Services and Controllers. Never plan a second data writer, a second
`ProcessReceipt` or a second session lock. If a service already covers part of it, extend or migrate it and say which.
*Done when:* the plan names every existing file it extends and states "no second writer".

## 1. Decisions table
What the system stores, who owns the truth (always the server), which remotes it needs, rate limits, failure
behaviour (what the player sees when a save or a call fails), and the config values (data-driven in a shared config
module, never hard-coded). *Done when:* every row has a value or the word "open" with an owner.

## 2. Pipeline, in order
| Step | Artefact | Rule |
|---|---|---|
| 1 Design doc | `docs/design/<system>.md` (or the project's design folder) | overview, player fantasy, rules, formulas, edge cases, dependencies, tuning knobs, acceptance criteria |
| 2 Spec first | a spec in the project's test runner (TestEZ, Jest-Lua or a Luau spec run in Studio) | written before the code; it fails first for the right reason; the run log is kept |
| 3 Remote contract row | the project remote contract module | every remote is one row: name, direction, payload type, rate limit; no remote outside the contract |
| 4 Server Service | `<System>Service` | an init with no yields, then start; validates type, range, ownership and rate on every call; persists only through the data service |
| 5 Client Controller | `<System>Controller` | shows state, sends intents, trusts nothing; UI follows the project style bible |
| 6 Authority | — | the server decides every outcome; never change `Workspace.AuthorityMode` without an owner decision |
| 7 Sync check | Rojo sync or a hash check against Studio | disk and Studio match before the system counts as installed |
| 8 Evidence | the project QA evidence folder | a retained capture of every player-visible screen the system touches |

## 3. Checks per system type
- **Anything with Robux:** run `roblox-economy-ethics`; ProcessReceipt idempotent with a PurchaseId ledger; product
  creation through Open Cloud is an owner gate.
- **Anything random:** odds listed and summing to 100 %, shown before the roll; the roll stays free.
- **Codes:** server-side list, a per-player redeemed set in the profile, rate-limited remote, no code that grants a
  Robux-only item.
- **Daily or streak:** a missed day pauses the streak; nothing expires under pressure.
- **Trading:** PolicyService `IsPaidItemTradingAllowed` gate, a server-side swap in one transaction, no trade during a save.
- **Leaderboards:** only the server writes scores; names are the Roblox DisplayName, never free text.
- **Exploit cases in the spec:** NaN, inf, negative numbers, wrong types, another player's id, spam above the rate
  limit, two calls in one frame.

## 4. Work package for Head Chef
```
WP: <id> <system>
Route (triage): quick | build | deep, risk, checks
Parts and file ownership (no overlap): design doc | spec | contract row | Service | Controller | UI
Order: design -> spec (red) -> contract row -> Service + Controller in parallel -> spec green -> sync check -> evidence
Acceptance: spec green with a kept log, sync matches, captures retained, economy-ethics PASS if money is involved
Owner gates: product ids, Open Cloud creation, publish
```
Who: rbx-game-director writes the design; rbx-luau-engineer and rbx-ui-engineer build; rbx-qa-tester and rbx-verifier
check; rbx-security-reviewer for money and data.

## Provenance
| Source | Taken | Excluded |
|---|---|---|
| fwjelaa Claude Code plugin by fwjelaa (FWJ STUDIOS), CC BY 4.0: the `/new-system` command, through the adapted skill of an owner Roblox project () | its list of standard systems, "survey first, never a second data writer", a decisions table, wire it then test it | direct writes to source from a command, the secrets module, copying modules from libraries that are not present, eggs as a standard system, its quality-score rubric and ledger, Rojo project merges as an install step; every project-specific |

Changes: rewritten in generic Forge words on 2026-11-11. Based on work by fwjelaa (FWJ STUDIOS), licensed CC BY 4.0;
this adaptation is shared under the same terms.
