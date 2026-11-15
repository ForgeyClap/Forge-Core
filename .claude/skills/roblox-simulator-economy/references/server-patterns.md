# Server patterns for a Roblox simulator economy

Read this when you implement the economy in a place: the shared config, the income tick, buy max,
rebirth, offline earnings on join, repairing loaded data. (The paid random item section of the source was removed.) Persistence
calls (`GetAsync`/`UpdateAsync`, session locking, retries) belong to `roblox-datastores`; remote
rate limits and payload validation in depth belong to `roblox-networking`.

The snippets use only `Players`, `ReplicatedStorage`, `RemoteEvent`, `Random`,
`task`, and `os.time()`. They were compiled and run under Lune 0.11.0 against minimal stand-ins
for those services (not shipped with this skill); behaviour inside Studio still needs a Server &
Clients playtest.

## Layout

```text
ReplicatedStorage/
  Shared/EconomyMath      ModuleScript: scripts/economy_math.luau, unchanged
  Shared/EconomyConfig    ModuleScript: the numbers (same shape as balance.luau's JSON)
  Remotes/BuyUpgrade      RemoteEvent  (client -> server: upgrade id)
  Remotes/BuyMax          RemoteEvent  (client -> server: upgrade id)
  Remotes/Rebirth         RemoteEvent  (client -> server: no arguments)
  Remotes/WalletChanged   RemoteEvent  (server -> client: wallet snapshot)
ServerScriptService/
  Economy.server.luau     owns every session table
```

The config sits in `ReplicatedStorage` so the client can show prices and odds from the same table
the server uses. That is safe because the server never reads amounts from the client.

```lua
-- ReplicatedStorage/Shared/EconomyConfig
return {
	baseIncome = 1,
	upgrades = {
		Income = { currency = "Coins", baseCost = 10, costGrowth = 1.15, incomePerLevel = 1, maxLevel = 100 },
	},
	rebirth = { baseRequirement = 1e6, requirementGrowth = 1.8, multiplierPerRebirth = 0.5 },
	offline = { maxHours = 8, efficiency = 0.5 },
	rollTable = {
		Basic = {
			-- free roll, odds always visible to the player (no price: see roblox-economy-ethics)
			outcomes = {
				{ id = "Cat", weight = 70 },
				{ id = "Dog", weight = 25 },
				{ id = "Dragon", weight = 5 },
			},
		},
	},
}
```

## Sessions and the income tick

```lua
-- ServerScriptService/Economy.server.luau
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local EconomyMath = require(ReplicatedStorage.Shared.EconomyMath)
local Config = require(ReplicatedStorage.Shared.EconomyConfig)
local Remotes = ReplicatedStorage.Remotes

type Session = {
	wallet: { [string]: number },
	levels: { [string]: number },
	rebirths: number,
	carry: number, -- fractional income not yet paid
}
local sessions: { [Player]: Session } = {}

local function incomePerSecond(session: Session): number
	local upgrade = Config.upgrades.Income
	local base = Config.baseIncome + (session.levels.Income or 0) * upgrade.incomePerLevel
	return base * EconomyMath.rebirthMultiplier(Config.rebirth.multiplierPerRebirth, session.rebirths)
end

local function pushWallet(player: Player, session: Session)
	Remotes.WalletChanged:FireClient(player, table.clone(session.wallet))
end

task.spawn(function()
	while true do
		local elapsed = task.wait(1)
		for player, session in sessions do
			session.carry += incomePerSecond(session) * elapsed
			local whole = math.floor(session.carry)
			session.carry -= whole
			session.wallet.Coins = (session.wallet.Coins or 0) + whole
			pushWallet(player, session)
		end
	end
end)
```

`task.wait` returns the time that actually passed, so a slow frame does not lose income, and the
`carry` field keeps fractional multipliers (x1.5 on 41/s) from being floored away every second.

## Buy one and buy max

```lua
Remotes.BuyUpgrade.OnServerEvent:Connect(function(player: Player, upgradeId: unknown)
	local session = sessions[player]
	if not session or type(upgradeId) ~= "string" then return end
	local upgrade = Config.upgrades[upgradeId]
	if not upgrade then return end
	local owned = session.levels[upgradeId] or 0
	if owned >= upgrade.maxLevel then return end
	local price = EconomyMath.levelCost(upgrade.baseCost, upgrade.costGrowth, owned)
	if EconomyMath.trySpend(session.wallet, { [upgrade.currency] = price }) then
		session.levels[upgradeId] = owned + 1
		pushWallet(player, session)
	end
end)

Remotes.BuyMax.OnServerEvent:Connect(function(player: Player, upgradeId: unknown)
	local session = sessions[player]
	if not session or type(upgradeId) ~= "string" then return end
	local upgrade = Config.upgrades[upgradeId]
	if not upgrade then return end
	local owned = session.levels[upgradeId] or 0
	local money = session.wallet[upgrade.currency] or 0
	local count, total = EconomyMath.maxAffordable(upgrade.baseCost, upgrade.costGrowth, owned, money, upgrade.maxLevel)
	if count > 0 and EconomyMath.trySpend(session.wallet, { [upgrade.currency] = total }) then
		session.levels[upgradeId] = owned + count
		pushWallet(player, session)
	end
end)
```

Neither handler yields between the balance check and the spend, so two requests from the same
player cannot both pass the check. Put a per-player token bucket (see `roblox-networking`) in front
of both before shipping.

## Rebirth

```lua
Remotes.Rebirth.OnServerEvent:Connect(function(player: Player)
	local session = sessions[player]
	if not session then return end
	local rb = Config.rebirth
	local requirement = EconomyMath.rebirthRequirement(rb.baseRequirement, rb.requirementGrowth, session.rebirths)
	if (session.wallet.Coins or 0) < requirement then return end
	session.wallet.Coins = 0
	table.clear(session.levels)
	session.carry = 0
	session.rebirths += 1
	pushWallet(player, session)
end)
```

## Loading: repair first, then pay offline income

`saved` is whatever `roblox-datastores` loaded (or `nil` for a new player). Repairing never errors
and reports what it changed, so you can log tampering or old-version data.

```lua
local function repair(saved: any, now: number): (Session, { string })
	local notes = {}
	local data = if type(saved) == "table" then saved else {}
	local session: Session = { wallet = {}, levels = {}, rebirths = 0, carry = 0 }

	local wallet = if type(data.wallet) == "table" then data.wallet else {}
	for currency, amount in wallet do
		local fixed = EconomyMath.sanitizeAmount(amount)
		if fixed ~= amount then table.insert(notes, `wallet.{currency}`) end
		if type(currency) == "string" then session.wallet[currency] = fixed end
	end

	local levels = if type(data.levels) == "table" then data.levels else {}
	for id, level in levels do
		local upgrade = Config.upgrades[id]
		if upgrade then
			local fixed = EconomyMath.sanitizeLevel(level, upgrade.maxLevel)
			if fixed ~= level then table.insert(notes, `levels.{id}`) end
			session.levels[id] = fixed
		else
			table.insert(notes, `dropped unknown upgrade {tostring(id)}`)
		end
	end

	session.rebirths = EconomyMath.sanitizeAmount(data.rebirths)

	-- Offline income from the server clock only. A missing, non-number or future
	-- timestamp counts as "now", which pays nothing.
	local lastSeen = data.lastSeen
	if type(lastSeen) ~= "number" or not (lastSeen <= now) then
		lastSeen = now
	end
	local off = Config.offline
	local paid = EconomyMath.offlineIncome(now - lastSeen, incomePerSecond(session), off.maxHours, off.efficiency)
	session.wallet.Coins = (session.wallet.Coins or 0) + paid
	return session, notes
end
```

On leave, save `lastSeen = os.time()` from the server along with the wallet, levels and rebirth
count, then clear `sessions[player]` in `Players.PlayerRemoving`. Never accept a timestamp from the
client.

## Random items

Removed: the `openEgg` example for paid eggs with luck boosts. No random outcome and no luck is sold
(`roblox-economy-ethics`). A free roll uses `EconomyMath.pickWeighted` on the server with the same list the odds
panel (`EconomyMath.oddsPercent`) is built from.

