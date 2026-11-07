# forge-mobile — Flutter

Provenance: rewritten in Forge's words from flutter/skills `skills/` — `flutter-apply-architecture-best-practices`,
`flutter-add-integration-test`, `flutter-fix-layout-issues`, `flutter-setup-declarative-routing` (BSD-3-Clause,
Copyright 2026 The Flutter Authors), read on `main` at `1bd8f2c` on 2026-11-02. Licence text:
`../LICENSE`. The Flutter names are used descriptively only; this is not an endorsed product (BSD-3 clause 3).
The upstream steps that drive the Dart/Flutter MCP server were not taken over (opt-in MCP, see `forge-mcp-clients`).

## Architecture: UI → (Logic) → Data
- **Views**: lean widgets — layout, animation, simple routing. No business logic; all data comes from a ViewModel.
- **ViewModels**: `ChangeNotifier` (or another `Listenable`); expose immutable state snapshots and command methods;
  get repositories through the constructor.
- **Repositories**: the single source of truth; turn API models into domain models; own caching, offline sync and retry.
- **Services**: stateless wrappers around HTTP, local DB and platform plugins; return raw models or a `Result`.
- **Use cases** (optional): only when logic is shared between ViewModels or clutters one.
- Layout: `lib/data/{models,repositories,services}`, `lib/domain/{models,use_cases}`,
  `lib/ui/{core,features/<feature>/{view_models,views}}` — UI grouped by feature, data and domain by type.

## Feature checklist (in order)
1. Immutable domain model (`freezed` or `built_value`).
2. Service for the external API or store.
3. Repository returning domain models.
4. Use case only if the logic is complex or cross-repository.
5. ViewModel with injected dependencies and immutable state.
6. View listening via `ListenableBuilder`.
7. Register service, repository and ViewModel in DI (`provider` or `get_it`).
8. Unit tests for ViewModel and repository; run → read failures → fix → re-run until green.
State management beyond `ChangeNotifier` (Riverpod, Bloc) is a project choice; record it once and do not mix.

## Layout errors (constraints go down, sizes go up, the parent sets the position)
| Error | Cause | Fix |
|---|---|---|
| Vertical viewport was given unbounded height | `ListView`/`GridView` inside a `Column` | wrap in `Expanded` (fill) or `SizedBox` (fixed height) |
| InputDecorator cannot have an unbounded width | `TextField` inside a `Row` | wrap in `Expanded` or `Flexible` |
| RenderFlex overflowed (yellow/black stripes) | child wants more than its `Row`/`Column` share | `Expanded` to force fit, `Flexible` to allow shrink; let text wrap |
| Incorrect use of ParentDataWidget | `Expanded` outside a `Flex`, `Positioned` outside a `Stack` | make it a direct child of the right parent |
| RenderBox was not laid out | a side effect of another error | fix the first error in the log, ignore this one |

## Routing and deep links (go_router)
- `MaterialApp.router(routerConfig: GoRouter(...))`, nested `GoRoute`s, `initialLocation`, an `errorBuilder` for
  unknown routes. `redirect` is the auth guard (signed-out users go to login; never only hide a button).
- Tabs that keep their state: `StatefulShellRoute.indexedStack` with one `StatefulShellBranch` per tab;
  `navigationShell.goBranch(i, initialLocation: i == current)`.
- `context.go` replaces the stack; `context.push` adds to it. Path parameters for identity (`/item/:id`), query
  parameters for filters; validate both — a deep link is untrusted input.
- Android App Links: intent filter with `autoVerify="true"` + `/.well-known/assetlinks.json` (package name +
  SHA-256 of the **release** signing cert). iOS Universal Links: associated domain `applinks:<domain>` +
  `/.well-known/apple-app-site-association` (no extension). Test with `adb shell am start -a VIEW -d <url>` and
  `xcrun simctl openurl booted <url>`.

## Tests
- Unit: ViewModels and repositories with fakes. Widget tests: `testWidgets` + `find.byKey` on `ValueKey`s placed
  on purpose in app code.
- Integration: the `integration_test` package, tests in `integration_test/*_test.dart`,
  `IntegrationTestWidgetsFlutterBinding.ensureInitialized()` first, `pumpAndSettle()` after interactions,
  `scrollUntilVisible` for lazily built list items. Run on a real device or emulator (`flutter test integration_test`
  or `flutter drive` with a `test_driver/` host for web).
- `PumpAndSettleTimedOutException` usually means an endless animation in the screen under test.

## Release (owner-gated)
- Android: an upload keystore created and kept by the owner (never committed; `key.properties` git-ignored);
  `flutter build appbundle --release`; the Play listing is owner action.
- iOS: needs a Mac with Xcode and an Apple Developer account; without one the iOS build is **not-run**.
- Before handoff: `flutter analyze` clean, tests green, release build installed and launched on a device or
  emulator (screenshot/log), no debug banner, no test data, app icon/splash/version set.
