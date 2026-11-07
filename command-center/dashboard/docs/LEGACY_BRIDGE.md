# The legacy bridge — what it is, where it lives, and how its tests run

_First written 2026-07-30 after a read-only system-checkup flagged it as a HIGH finding.
Updated 2026-11-01 (WP A9, mission): the bridge was
archived out of `src/`._

## The short version

`dashboard/archive/bridge/**` (34 TypeScript files; it lived in `src/bridge/**` until
2026-11-01) is a 39-operation **WebSocket bridge** from an earlier design of this
dashboard. **The shipped product never runs it.** The live data path is REST + SSE to the
zero-dependency Node gateway on `127.0.0.1:4100`.

Nothing was deleted. The owner's standing rule is "niks verwijderen", and the files are a
working implementation a future design might want back. They were moved with `git mv`,
so history follows them.

## What the move changed

| Before | After |
|---|---|
| `src/bridge/**` | `archive/bridge/**` (the bridge's own imports of `src/shared/**` now use `../../src/shared/...`; it still runs with `node archive/bridge/main.ts`) |
| `src/bridge/usage/latency.ts` | `src/shared/latency.ts` — see "The one value import" below |
| `@/bridge/...` imports in tests | `@archive/bridge/...` (alias in `tsconfig.json`, `vite.config.ts` and every `vitest.*.config.ts`) |
| 5 bridge-only tests and 3 exercise scripts in `tests/unit/` | `tests/legacy-bridge-unit/` |
| vitest project `legacy-bridge` inside the default `npm test` | its own config `vitest.legacy-bridge.config.ts`, run with `npm run test:legacy-bridge` |

### The one value import

Before the move, live code was described as importing the bridge "type-only". That was
not fully true: `src/prototype/state/bridge-client.ts` constructed `LatencyTracker` from
`src/bridge/usage/latency.ts`, and `bridge-client.ts` is reachable from the production
bundle through `live-store.ts` (its `statusKeyOf` helper is used by the usage strip). So
the tracker was in the shipped bundle. Rather than let `src/` import a value from the
archive, the tracker moved to `src/shared/latency.ts`; the archived bridge imports it
from there. All other live imports of the archive are `import type` and are erased at
build time.

**Bundle effect, measured:** `npm run build` before and after the move produced the same
44 files with identical names and byte sizes (1,315,470 bytes in `dist/`). Archiving
removed no bytes because the only bridge code that was ever bundled is the latency
tracker, which is still used.

## The guards

`tests/unit/legacy-bridge-labels.test.ts` (in the default run) checks, off the real files:

- every test in a legacy directory (`chaos`, `idempotency`, `negative`, `security`,
  `integration`, `legacy-bridge-unit`) really targets `archive/bridge/**`, so live
  coverage cannot hide behind a "dead code" label;
- no bridge test sits in `tests/property` (labelled `shared`, live code);
- `src/bridge` no longer exists and `archive/bridge` does;
- `src/**` imports `archive/bridge` with `import type` only. A value import would put
  dead code back in the bundle. (Proven to fail: changing one import in
  `bridge-client.ts` to `import { type ServerFrame }` turns it red.)

`tests/unit/no-runtime-contact.test.ts` and `tests/unit/runtime-declarations.test.ts`
still scan the archived bridge as their "bridge zone", so its no-shell, loopback-only and
no-fixture invariants keep being checked in the default run.

## Which suite tests what

| Directory | How it runs | Label |
|---|---|---|
| `tests/chaos`, `tests/idempotency`, `tests/negative`, `tests/legacy-bridge-unit` | `npm run test:legacy-bridge` | `legacy-bridge` |
| `tests/security` | `npm run test:security` (also in `npm run verify`) | `legacy-bridge-paths` |
| `tests/integration` | `npm run test:integration` (spawns `node archive/bridge/main.ts`) | `integration` |
| `tests/property` | `npm test` | `shared` — live `src/shared/**` code |
| `tests/unit` | `npm test` | `unit` — live code; `mutation-guards.test.ts` still imports one archived module (`usage/aggregator`) next to live state machines |

**Live security coverage lives in the gateway suite** (`gateway/test/`):
`security.test.mjs`, `static-security.test.mjs`, `recovery-redaction.test.mjs`,
`chaos.test.mjs`, plus the route tests. That is the suite to look at when asking "is the
running thing hardened".

## Known follow-up

`stryker.config.mjs` still mutates `archive/bridge/security/paths.ts` and
`archive/bridge/usage/aggregator.ts`, but it runs vitest with `vite.config.ts`, which no
longer includes the `legacy-bridge` suites. A mutation run will therefore see fewer
killing tests for those two files than before. Either point Stryker at a config that also
includes the legacy suites, or drop the two archived files from `mutate`.

## If you ever revive the bridge

Move it back with `git mv archive/bridge src/bridge`, move `src/shared/latency.ts` back if
you like, put the `legacy-bridge` project back into `vite.config.ts`, rename the projects
to say what they now prove, update the guards above, and say so in the commit.
