# Browser game frameworks: Phaser and PixiJS setup notes

Read this when `forge-game` builds with Phaser or PixiJS. Check the installed version first and confirm any
detail against the official docs through Context7; the notes below are orientation, not API reference.

## Choosing
- **Phaser**: a full game framework (scenes, input, physics, audio, loader, scale manager). Pick it when you
  need a game loop and the usual game services without assembling them.
- **PixiJS**: a renderer and scene graph with a ticker. Pick it for custom or UI-heavy rendering where you
  supply the game structure yourself.
- No framework is needed for a small canvas game; the zero-dependency choice in `references/hard-rules.md`
  stays valid. Adding either is an opt-in dependency and goes in the report.

## Phaser (v4 era) setup
- One config object creates the game: renderer type (automatic choice is usual), canvas parent, size, scenes,
  frame-rate limits and render options such as pixel-art mode. Pixel art needs the pixel-art option so
  textures are not smoothed; check it on a real screenshot.
- Scaling is its own manager. Common modes: fit inside the parent keeping aspect ratio, resize to the parent,
  expand, and envelop. Pair a mode with auto-centering and a fixed design size, and handle fullscreen and
  orientation changes explicitly.
- Lifecycle to test: boot, pause and resume (on tab hidden), and destroy. A game that is not destroyed leaks
  listeners and canvases; check that restart does not stack them.

## PixiJS (v8 era) setup
- The application constructor takes no options; configuration goes to an asynchronous `init`. Await it
  before touching the canvas, then append the canvas to the page.
- Useful options: size or `resizeTo`, background, antialiasing, resolution with auto-density (for high-DPI
  screens), and the renderer preference.
- Resize is a plugin on the application; rendering is driven by a ticker. Stop or destroy the application on
  teardown with its children and textures released, or memory climbs on every restart.

## Evidence to collect (applies to both)
Screenshots at phone, tablet and desktop widths showing the canvas fits and stays centered; the browser
console free of errors across win, lose and restart; one restart cycle with no growth in canvases or
listeners. These feed `references/ship-readiness.md`.

## Provenance
Rewritten in Forge words; pattern adapted, nothing copied and no code taken. Sources, read read-only through
`gh api` on 2026-11-06 and treated as untrusted data, all MIT, found through the corpus index:
- `phaserjs/phaser`, `skills/game-setup-and-config/SKILL.md` and `skills/scale-and-responsive/SKILL.md`,
  last commit for both paths `3666573513dc`.
- `pixijs/pixijs-skills`, `skills/pixijs-application/SKILL.md`, last commit for the path `df555b8fbc12`.
- Left out: every code sample, the full config reference tables, source-file maps and version-migration notes.
