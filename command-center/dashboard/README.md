# Forge Command Center — dashboard

The browser front end of the Forge Command Center. It started as a visual prototype on
local example data; it is now the real dashboard and reads live Forge data (projects,
conversations, runs, events, missions, agents, skills, tools, models, proof, usage,
files) from the local gateway in `../gateway/` on `http://127.0.0.1:4100`.

The gateway is the only layer that touches the file system or starts the real `claude`
CLI. The dashboard talks to it over REST and Server-Sent Events, always on loopback.
There is no Anthropic API call and no API-key path anywhere in this code.

## Run it

```bash
npm install
npm run dev            # http://127.0.0.1:5173 (needs the gateway on :4100 for live data)
```

The gateway is started from `../gateway/` (`node bin.mjs`). In a Forge project the
command `/forge dashboard` launches the Command Center on `127.0.0.1:4100`.

## Data modes

Production is the default. Example (fixture) data needs two explicit switches, both
in `src/config/mode.ts`: the build-time env var `VITE_FORGE_FIXTURES=true` **and** a
run-time `allowFixtureData()` call. Without both, no example record can load
(`PRODUCTION_MOCK_DATA_ALLOWED = false`), and an empty or unreachable gateway shows an
honest empty or error state instead of example content.

## Test it

```bash
npm run verify         # theme check, typecheck, lint, unit tests, legacy path guard, build
npm run test:e2e       # Playwright (builds first)
```

| Command | What it proves |
| --- | --- |
| `npm run theme:check` | the generated CSS has not drifted from `brand/tokens.json` |
| `npm run typecheck` | strict TypeScript over `src/`, `archive/` and `tests/` |
| `npm run lint` | ESLint; bare `fetch` / `WebSocket` / `EventSource` / `XMLHttpRequest` are banned in `src/` (live calls go through `globalThis` with a loopback target, which a unit test checks) |
| `npm test` | the default vitest run: `unit` (jsdom), `shared` (property tests of `src/shared`) and `fuzz` |
| `npm run build` | production build (`tsc --noEmit && vite build`) into `dist/` |
| `npm run test:e2e` | browser tests against the built app |
| `npm run test:legacy-bridge` | tests of the archived bridge only (see below); not part of `npm test` |
| `npm run test:security` | the archived bridge's path guard (`legacy-bridge-paths`) |
| `npm run test:integration` | spawns the archived bridge as a child process |

## Layout

```
brand/                     design system; tokens.json is the single source of truth
src/
  App.tsx, main.tsx        app shell and router
  config/                  run mode (production vs fixtures)
  prototype/
    state/                 gateway client, adapters and stores (the live data path)
    types/, data/, fixtures/   view contracts and the fixture-only example data
  shared/                  protocol, state machines, declarations, latency tracker
  components/              primitives and shell (sidebar, dock, inspector, palette)
  views/                   one folder per screen
  styles/                  global stylesheet
archive/
  bridge/                  the legacy WebSocket bridge, archived and not mounted
tests/
  unit/, property/, fuzz/  the default run
  e2e/, e2e-real/          Playwright
  chaos/, idempotency/, negative/, legacy-bridge-unit/   archived-bridge suites
  security/, integration/, load/                         archived-bridge suites with their own configs
```

## The archived bridge

`archive/bridge/**` is a 39-operation WebSocket bridge from an earlier design. The
product does not run it. It was moved out of `src/` on 2026-11-01 (never deleted, per
the owner's rule "niks verwijderen"); live code may only import its **types**, which a
unit test enforces. Details, and how to revive it: `docs/LEGACY_BRIDGE.md`.

## The design rules

**Tokens carry every value.** No raw hex in component CSS. If a semantic value is
missing, add a named token to `tokens.json` and rebuild (`npm run theme`); do not reach
past the semantic layer.

**The accent is rationed.** The palette is monochrome. Ember appears only on focus
rings, the active-control indicator and running progress. The primary button is an
inverted surface, not an accent fill.

**Status never depends on colour.** Every state renders an icon, an uppercase label and
a border treatment (`--forge-status-<key>-style` / `-width`). Read the interface in
greyscale and nothing is lost.

**Type marks provenance.** Monospace (`.fg-machine`) is what the system recorded: ids,
paths, model labels, timestamps, commands, test output. Sans is what a person wrote.
