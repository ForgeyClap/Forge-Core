# forge-mobile — native Android (Kotlin / Compose)

Provenance: rewritten in Forge's words, no sentence copied. Sources read 2026-11-06:
- ECC `android-clean-architecture`, `kotlin-testing` (affaan-m/ECC, MIT, pinned `e2b8a51cea2228e515e1c3653effbeb62a2800fa`):
  module layout, dependency rule, mapper/Result patterns, anti-patterns, test styles.
- android/skills `jetpack-compose/jetpack-compose-performance/SKILL.md` at `4ebabf2b0fd6c04b7150023c8b612f80592a6226`
  (repo HEAD read `bf68e2d66a992a1e6aeb7e9263293cc23fcbf475`; Apache-2.0; its frontmatter points to LICENSE.txt):
  release/R8/baseline-profile prerequisites, state deferral, lazy-list keys. Its `references/` were not read.
- chrisbanes/skills `skills/kotlin-concurrency-and-flow/SKILL.md` at `367546f2376db70b1bd4e67c2575af07f8239013`
  (Apache-2.0): scope ownership, state versus one-shot events.
Not taken over: the `r8-analyzer` script, any Gradle wrapper call recommended by the sources, MCP use.

## Layers (dependency points inward)
`app` wires DI and the entry point; `presentation` (screens, ViewModels) and `data` (repositories, Room, network) both
depend on `domain` (pure Kotlin: use cases, models, repository interfaces); `core` depends on nothing. `domain` never
imports Android classes or data types. Map DTOs and entities to domain models at the boundary. Big apps add
`feature/*` modules and a `design-system` module.

## Compose state
- ViewModel exposes one immutable UI state in a `StateFlow`; the screen collects with `collectAsStateWithLifecycle()`.
- One-shot effects (navigation, snackbar) use a bounded `Channel` as a flow when each event must reach one consumer;
  never a replay-zero `SharedFlow` for something that must not be lost.
- Every coroutine has an owner (`viewModelScope`, a lifecycle scope); no `GlobalScope`, no `runBlocking` in app code.
- Lazy lists: give each item a primitive `key` and a `contentType`. Read fast-changing state in lambdas
  (`Modifier.offset { }`, `graphicsLayer { }`) so recomposition is skipped. Do not sprinkle `@Stable` on collection models.

## Gradle hygiene
Version catalog plus convention plugins for shared config; R8 minification on in release; profile and benchmark only
release-like builds; baseline profiles for startup and main scroll. Run Gradle through the project's documented task
(wrapper pinned in the repo); do not add network plugins you cannot name.

## Testing
JUnit plus Kotest or MockK for domain and ViewModel (fake the repository interface), Turbine for flows, Compose UI
tests for the key screens, one instrumented smoke on an emulator. Red first, then green.

## Owner actions
Play Console account, upload keystore and Play App Signing, service-account keys and track publishing are owner
actions; agents never read a keystore or its passwords.
