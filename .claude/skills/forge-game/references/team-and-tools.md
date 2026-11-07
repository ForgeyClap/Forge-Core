# forge-game — team, skills, commands, MCP

## Team (conditional)
Lead: `build-boss` (a game is implementation-heavy). HUD / menus / responsive canvas + visual quality: `ui-boss` (with `forge-website` for layout). QA: `test-boss` — drive the loop via `browser` automation (win / lose / restart reachable, no stuck states, cross-viewport, no console errors). Code review: `typescript-reviewer` for browser JS/TS (honest gap: **no dedicated Godot/GDScript reviewer agent exists** — Godot script review is `build-boss` + general review). Runtime efficiency (frame budget, asset weight): `seo-boss` (its non-web remit is runtime performance). `ml-engineer` / `data-scientist` only if the game has procedural-generation or ML-driven content (opt-in). Optional advisor: `codex-reviewer` on the core loop/state code.

## Skills / commands / MCP
`browser` is the key evidence tool — drive and screenshot the running browser game to produce real playtest proof (win/lose/restart, no console errors). `systematic-debugging` for stuck states, collision/physics bugs, and frame drops. `forge-website` for menus/HUD and a responsive canvas. Engine/API specifics via Context7 (Phaser, Godot/GDScript). **Opt-in:** the Godot editor/export toolchain is owner-side and not provisioned by Forge — browser games need no such dependency and can be driven directly.
