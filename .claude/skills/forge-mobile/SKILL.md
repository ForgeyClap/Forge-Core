---
name: forge-mobile
description: "Playbook for mobile apps: React Native, Expo, Flutter (gebruik bij een mobiele app)."
# A10 original description (listing budget): "Playbook for mobile apps: React Native, Expo, Flutter, secure storage, store releases (gebruik bij een mobiele app)."
---

# Forge playbook — Mobile app (React Native / Expo / Flutter)

## Provenance
Forge-native playbook. The references add material rewritten in our own words (no file copied verbatim), seen on `main` on 2026-11-02:
- expo/skills expo-overview, expo-upgrade, eas-update, eas-app-stores (MIT, (c) 650 Industries, see LICENSE) → `references/expo.md`.
- flutter/skills architecture, integration-test, layout-fix and routing skills (BSD-3-Clause, (c) 2026 The Flutter Authors, see LICENSE) → `references/flutter.md`.
Forge changes: no Expo MCP server, no Bash grants, no `eas login`/feedback upload steps; publishing, store submission and account actions are owner-gated.

## When to use
- Use for: mobile apps in React Native, Expo or Flutter: a release build that installs, secure storage, permissions.
- Not for: backend/API work (`forge-integration`) or money flows (`forge-payments`).
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules (non-negotiable)
- **A native build that actually installs.**
- **No secrets in the client bundle.** A mobile bundle is trivially extractable (decompile the APK, read the JS bundle).
- **Secure token storage.**
- **Least-privilege permissions with rationale.**
- **Offline-where-promised actually works.** If offline use is promised, cached reads, queued writes, and a clear "no connection" state exist — not network calls that silently fail.
- **No test/demo/mock data, no debug menus, no `__DEV__`-only shortcuts in the release build.**

Full text of every rule: `references/hard-rules.md`. Stack mechanics: `references/expo.md` (Expo/EAS: SDK detection, `npx expo install`, upgrades, OTA limits, store builds) and `references/flutter.md` (Flutter: layered architecture, layout errors, go_router, integration tests).

## Team (conditional by stack/level)
Lead: `build-boss`. Native work: **`mobile-dev`** (RN/Expo/Flutter). Support: `ui-boss` (touch targets, safe-area/notch, keyboard, orientation, dark mode), `test-boss` (device/emulator QA — Detox or Maestro for RN, `flutter test` + integration_test for Flutter), `security-boss` (secure storage + secrets audit), `typescript-reviewer` and/or `react-reviewer` for RN code (RN is React-based). Backend calls: `forge-integration` team.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L2 a single-screen or small app; L3 multi-screen + navigation + offline + native modules + a store build; L4 phased for a large app with several native integrations.
**Serial:** app architecture (navigation + state + data layer) → screens → secure-storage + offline layer → device/emulator QA → release build → store-readiness pass.
**Parallel:** independent screens/features build in parallel **once** the navigation contract and data layer are fixed (that contract is the integration seam — you are the integration layer).

## Domain gates
- Release binary **builds and installs + launches** on a device or emulator (evidence: build output + a launch screenshot/log), not just Metro/Expo Go.
- No secrets in the JS bundle or committed (`EXPO_PUBLIC_*` values are inlined into the bundle — never a secret); tokens in secure store (Keychain/Keystore/SecureStore), not AsyncStorage/SharedPreferences.
- Permissions minimal and justified — iOS usage-description strings present, Android manifest minimal.
- Offline paths work where promised (cached reads, queued writes, no-connection UI) — or offline is honestly declared out of scope.
- Safe-area/notch, keyboard avoidance, orientation, and dark mode (if supported) handled; touch targets adequate (~44pt); long lists use `FlatList`/virtualization, not a giant `ScrollView`.
- OTA updates (EAS Update) only for JS/assets the installed runtime supports; native changes and SDK upgrades ship as a new store build; runtime version and channel stated.
- No test/demo/mock data, no debug menu, no `__DEV__` shortcut in the release build; release signing configured; app icon + splash + version set.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: no secrets in the client bundle; tokens in the OS secure store.
- Approval / safety: store-listing assets and forms are owner action. So are store submission, production OTA publish, `eas login`/account setup, and creating or holding signing keystores and store credentials (agents never read them).
- Honest failure: Metro/Expo Go running is not a shipped app; show the release build installed and launched.
- Honest failure: no Mac/EAS: the iOS build is not-run.
- Honest failure: a finished EAS build or queued submission is not "accepted by the store" — report the real review status.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/expo.md` — Expo/EAS: detect SDK, version-pinned docs, upgrades, EAS Update rules, store builds.
- `references/flutter.md` — Flutter: UI/Logic/Data architecture, feature checklist, layout errors, go_router + deep links, tests, release.
- `references/rn-patterns.md` — React Native: Zod-validated deep links, state table, FlashList rules, safe-area, tests.
- `references/ios-swift.md` — native iOS: SwiftUI state and navigation, concurrency, testing; signing is an owner action.
- `references/android-kotlin.md` — native Android: layers, Compose state, Gradle hygiene, testing; keystore is an owner action.
- `references/store-release.md` — store listing (ASO) checklist, screenshots, review-rejection pitfalls; submission is an owner action.
