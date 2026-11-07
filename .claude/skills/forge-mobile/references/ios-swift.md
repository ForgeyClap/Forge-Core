# forge-mobile — native iOS (Swift / SwiftUI)

Provenance: rewritten in Forge's words, no sentence copied. Sources read 2026-11-06:
- ECC `swiftui-patterns`, `swift-concurrency-6-2`, `swift-protocol-di-testing` (affaan-m/ECC, MIT, pinned
  `e2b8a51cea2228e515e1c3653effbeb62a2800fa`, local copy under Claude Tooling/ECC/skills): state wrappers, NavigationStack
  routing, performance list, anti-patterns, actor isolation, protocol-based test doubles.
- CharlesWiltgen/Axiom (MIT) and rshankras/claude-code-apple-skills (MIT): checked through the skills corpus metadata only
  (licence MIT; Axiom skills ship no scripts; several rshankras `generators/*` skills ship scripts). No content and no
  script was taken; their SKILL.md bodies were not read, so nothing here is attributed to them.
Not taken over: any generator or shell script, Xcode MCP use.

## State
| Need | Use |
|---|---|
| view-local value (toggle, field, sheet flag) | `@State` |
| two-way link to a parent value | `@Binding` |
| owned model with several properties | `@Observable` class held in `@State` |
| model passed in read-only | plain `@Observable` parameter; `@Bindable` when it needs bindings |
| shared dependency | `.environment(...)` |

New code uses Observation, not `ObservableObject` / `@Published` / `@StateObject`.

## Views and navigation
- Small subviews limit what re-renders; reusable styling goes in a `ViewModifier`. No `AnyView`.
- One `NavigationStack` with a typed `NavigationPath`; destinations are a `Hashable` enum registered with
  `navigationDestination(for:)`. Keep one owner for the path (the view's `@State`, or a router object shared through the environment); whoever owns it pushes and pops by changing it, and no other code edits it directly.
- Async work goes in `.task {}` or a load method, never in `body` or `init`. Lists use lazy containers with stable ids.

## Concurrency
- UI types are `@MainActor`; shared mutable state lives in an `actor`; values crossing isolation are `Sendable`.
- Mark genuinely background work explicitly (`@concurrent` on Swift 6.2 projects); do not rely on implicit offloading.
- Read the project's Swift language mode and Xcode version before choosing between 6.0 and 6.2 behaviour.

## Testing
- Small protocols for network, storage and clock; production implementation as default parameter; mocks in tests.
- Swift Testing (`@Test`, `#expect`) for new unit tests; previews for empty, loaded and error states; XCUITest only for
  the one or two critical flows.

## Owner actions (never run by an agent)
Apple Developer account, signing certificates, provisioning profiles, App Store Connect, TestFlight upload and review
submission. Agents may write code and an unsigned simulator build command; evidence for a device build is the owner's.
Without a Mac the iOS build is "not run", stated plainly.
