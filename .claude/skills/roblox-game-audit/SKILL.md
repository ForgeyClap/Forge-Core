---
name: roblox-game-audit
description: "Use when Roblox Luau code or a game plan needs a read-only audit with a ranked fix list: remotes, exploits, data safety, purchases, performance, scope (controleer de code, audit)."
license: CC-BY-4.0
last_reviewed: 2026-11-11
---

# roblox-game-audit: read-only audit, ranked fix list

An audit reads and reports. It does not change code and runs no third-party script; it uses Grep, Glob and Read. A
finding is proven later by a spec that the fixing lane writes (red first).

## When to use
- Before a publish, a wave sign-off or a big merge; when someone asks "are the remotes safe", "dupe risk",
  "memory leak", "is this plan doable in two weeks".
- Not for: the fix itself (a build package); a pre-release gate run (`roblox-publish-checklist`); pricing
  (`roblox-economy-ethics`).

## 1. Map the project first
Grep the source folder so the review covers whole systems. Note per file: server, client or shared.

| Area | Grep patterns |
|---|---|
| Entry points | `OnServerEvent`, `OnServerInvoke`, `InvokeClient`, `Touched`, `ProximityPrompt`, `ClickDetector`, remote contract rows |
| Data | `GetDataStore`, `GetOrderedDataStore`, `UpdateAsync`, `SetAsync`, `ProfileStore`, `BindToClose`, `PlayerRemoving` |
| Money | `ProcessReceipt`, `PromptProductPurchase`, `UserOwnsGamePassAsync`, `MarketplaceService`, `PolicyService`, `math.random` or `Random.new` near anything bought |
| Text | `FilterStringAsync`, `TextChatService`, any player-typed name |
| Runtime cost | `while true`, `Heartbeat`, `RenderStepped`, `:Connect(` inside loops or per-frame handlers, `Instance.new` in hot paths, missing `Disconnect` or cleanup |
| Authority | any write to `Workspace.AuthorityMode`; client-set currency, damage, position or inventory |

## 2. Review in this order
Use `roblox-security`, `roblox-networking`, `roblox-datastores` and `roblox-luau` where they apply.
1. **Remotes:** does every handler validate type, range, ownership and rate? Is anything trusted from the client
   (NaN, inf, negative numbers, other players' ids, huge strings, invalid UTF-8: `utf8.len` nil means reject)?
2. **Data:** load and save in pcall with retries, one session lock, `UpdateAsync` over `SetAsync`, autosave,
   `BindToClose`, `PlayerRemoving` clean-up, schema migrations.
3. **Purchases:** ProcessReceipt idempotent through a PurchaseId ledger, grant before `PurchaseGranted`, one
   `ProcessReceipt` only; monetisation rules from `roblox-economy-ethics`.
4. **Exploits:** economy and combat threat model, duplication races (two remotes in one frame, a trade during a
   save), purchase abuse, speed, fly, noclip and teleport checks.
5. **Performance:** leaks, unyielding loops, per-frame allocations, instance churn, replication churn. Without Studio
   measurements label each finding "static, not measured".
6. **Player safety:** filtered text, opt-in PvP, no paid random items, PolicyService gates, a flash limit for effects.

## 3. Confirm or dismiss every finding
A pattern match is a lead, not a finding. Open the line, read the context, decide. A confirmed finding states the
file, the line and the concrete failure; "might be a problem" is not confirmed. A confident wrong claim (an API that
does not exist, a wrong limit) is worse than saying nothing: check API names in the Roblox documentation when unsure.

## 4. Rank
Impact, then likelihood, then effort.
- **P0 (fix before publishing):** lost or duplicated player data or purchases; client-controlled currency, items,
  damage or position; exploitable remotes; ProcessReceipt errors; any paid random item; a client-settable leaderboard
  flag; an `AuthorityMode` change.
- **P1:** freezes and crashes (unyielding loops, `InvokeClient` hangs), unprotected DataStore calls, missing
  `BindToClose`, unfiltered player text.
- **P2:** memory leaks, per-frame waste, connection build-up, replication churn.
- **P3:** deprecated APIs, `Instance.new` with a parent argument, unchecked `FindFirstChild` chains, style.

## 5. Scope and content maths (for a plan)
Assume every plan is about 40 % more work than estimated, and say so.
- **Content treadmill:** a design that needs a weekly content drop to survive its first six weeks is a risk; prefer a
  finite collection plus an endless tail, so weekly drops are an upside.
- **Asset count:** count base models apart from variants (recolours, scale, tints). A base count above what the art
  lane can make in the wave is a scope failure.
- **Where time really goes:** rare-moment effects, inventory serialisation and dupe prevention, index UI that scales
  on a phone, DataStore reliability, Studio sync checks.
- **Data-driven test:** a new theme should mean new data rows, not a rewrite of services.

## 6. Report
1. One line: files scanned, findings confirmed and dismissed.
2. **Ranked fix list:** `# | P | Area | File:line | Problem | Why it matters | Fix | Effort S/M/L | Proof spec to add`.
3. **Dismissed findings:** `pattern | location | one-line reason`, every dismissed lead listed.
4. **Scope table** when a plan was audited.
5. **Next steps:** the top 3 fixes as work-package proposals for Head Chef, each with the spec that will prove it.

Who runs it: rbx-security-reviewer (deep) for money and data; Review Boss for a whole-project audit.

## Provenance
| Source | Taken | Excluded |
|---|---|---|
| fwjelaa Claude Code plugin by fwjelaa (FWJ STUDIOS), CC BY 4.0: the `/audit` command, the `scope-auditor` agent and the topics of its benchmark, through the adapted skill of an owner Roblox project () | the grep map, review order, confirm-or-dismiss, P0 to P3 ranking, scope maths | the checker scripts (one ran through an execution-policy bypass), ignore comments, the missing rubric and review skills, a fixed developer profile, the Python aggregator, write access for the auditor; every project-specific |

Changes: rewritten in generic Forge words on 2026-11-11. Based on work by fwjelaa (FWJ STUDIOS), licensed CC BY 4.0;
this adaptation is shared under the same terms.
