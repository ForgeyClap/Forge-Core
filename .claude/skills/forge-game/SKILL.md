---
name: forge-game
description: "Playbook for browser and Godot games: game loop, win/lose states (gebruik bij een spel)."
# A10 original description (listing budget): "Playbook for browser and Godot games: game loop, win/lose states, collisions, save/load (gebruik bij een spel maken)."
# W2-BUDGET original description (listing budget): "Playbook for browser and Godot games: game loop, win/lose states, collisions (gebruik bij een spel maken)."
---

# Forge playbook — Games (browser · Godot)

## When to use
- Use for: browser and Godot games: a playable loop, no stuck states, viewport and input coverage, playtest evidence.
- Not for: HUD/menus/responsive layout on their own (`forge-website` / `ui-boss`).
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules (non-negotiable)
- **A genuinely playable loop.** The core loop runs end-to-end: input → state update → render → feedback, reaching a **win** and a **lose** condition and a working **restart**.
- **No stuck / soft-lock states.** No dead-end where the player can't progress or restart; game-over and win are always reachable and recoverable; **pause/resume** works; input never stops responding.
- **Cross-viewport + declared inputs.** The canvas scales/letterboxes correctly at mobile **and** desktop sizes with no cut-off UI — or the game explicitly declares desktop-only.
- **Honor the dependency constraint.** If the brief says vanilla / no-framework / zero-dependency, honor it — no CDN pulls, self-contained assets.
- **Runtime health.**
- **Persistence works if promised.** If save/load or high-scores are in scope, they actually persist and restore correctly across reloads.
- **Real playtest evidence.** The loop is proven by actually playing it (or driving it via browser automation) with screenshots/recording showing win + lose + restart — evidence, never an assertion.
- **No global input in tests.** Drive a desktop game through its own window handle (PostMessage/SendMessage to its hwnd) or a built-in self-test flag, never global SendKeys/SendInput.

Full text of every rule: `references/hard-rules.md`.

## Team (conditional)
Lead: `build-boss` (a game is implementation-heavy). Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L2 for a single-mechanic browser game; L3 for a multi-level / multi-system game (physics + AI + save/load + audio).
**Serial:** core loop (input→update→render) → win/lose/restart states → feedback/juice → cross-viewport + input coverage → playtest evidence.
**Parallel:** independent systems (rendering ∥ input ∥ audio ∥ level data) and independent levels/assets — independent once the game-state contract is fixed (the state model is the contract).

## Domain gates
- Core loop runs and **completes**: start → play → win AND lose → restart, all reachable; no soft-lock; pause/resume works.
- Canvas scales/letterboxes correctly at mobile + desktop sizes (or desktop-only is declared); every declared input method works.
- **Zero console errors** across a full session; stable frame rate via a delta-time loop (fixed timestep for physics); listeners/timers/audio cleaned up on restart (no leak, no double-fire).
- If a zero-dependency constraint was set, no external/CDN deps; self-contained (and CSP-safe if delivered as an artifact).
- Save/load / high-scores (if promised) persist and restore across reloads.
- Real playtest evidence attached (screenshots/recording of win + lose + restart) — not asserted.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: honour a zero-dependency constraint when set (no CDN pulls; CSP-safe as an artifact).
- Honest failure: never call a game playable without real evidence of win + lose + restart reached.
- Honest failure: no Godot toolchain: mark export and clean-run not-run.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/frameworks.md` — Phaser and PixiJS setup, scaling and lifecycle notes.
