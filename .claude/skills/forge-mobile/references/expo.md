# forge-mobile — Expo and EAS

Provenance: rewritten in Forge's words from expo/skills `plugins/expo/skills/` — `expo-overview`, `expo-upgrade`,
`eas-update`, `eas-app-stores` (MIT, (c) 2025-present 650 Industries, Inc. (aka Expo)), read on `main` on 2026-11-02.
Licence text: `../LICENSE`. Not taken over: the Expo plugin's remote MCP server (it needs an Expo account login and
owner approval), the `allowed-tools: Bash(...)` grant of `eas-update`, the `npx --yes @expo/agent-cli feedback`
step (it sends data to Expo) and every `eas login` / `eas init` instruction (account actions are owner actions).

## First: detect, then route
- Read the `expo` version in `package.json` and `app.json` / `app.config.*` before anything else.
- Use the docs **pinned to that SDK** (`docs.expo.dev/versions/v<NN>.0.0/...`), not `latest`: latest describes
  APIs an older project does not have.
- Committed `ios/` and `android/` folders mean native projects exist (bare/prebuild); without them the app uses
  Continuous Native Generation (CNG) and native config lives in `app.json` + config plugins.
- An app that only *uses EAS* for builds (no `expo` dependency) follows the store-release rules below, not the
  Expo SDK rules.

## Everyday rules
- Install packages with `npx expo install <pkg>`, not raw npm/yarn/pnpm: it picks versions that match the SDK.
- Expo Go is a sandbox, not your app. Anything with custom native code needs a **development build**
  (`expo-dev-client`); the release build is what counts as proof (see the forge-mobile domain gates).
- Navigation: Expo Router (file-based) — tabs, stacks, modals and deep links from the `app/` tree.
- Long lists: `FlatList` / `FlashList`; `@expo/ui` `List` renders grouped native rows and is **not** virtualised.
- Data fetching with React Query or SWR, with an explicit offline/no-connection state.
- `EXPO_PUBLIC_*` variables are inlined into the JS bundle: never put a secret in one. Secrets stay server-side.

## SDK upgrades (one SDK at a time, unless the release notes say otherwise)
1. `npx expo install expo@<target>` then `npx expo install --fix` to align every dependency.
2. `npx expo-doctor`; fix what it reports, and re-run it after removing any dependency (peers go missing).
3. Clear caches (`.expo`, Metro cache) and reinstall `node_modules`.
4. Only with `ios/`/`android/` folders and native changes: `npx expo prebuild --clean` (this regenerates native
   folders — review the diff and keep a checkpoint first).
5. Read the release notes for removed APIs and moved imports; re-test camera, audio, video and navigation.
- Remove stale `expo.install.exclude` entries and `patches/` workarounds; delete `sdkVersion` from `app.json`.
- The New Architecture is the default on current SDKs; check that native libraries support it before upgrading.

## Over-the-air updates (EAS Update)
- The **runtime version** is the compatibility line between an update and the native code in a build. Changing the
  runtime-version policy changes which installed builds still receive updates — that is its own decision.
- OTA can ship JS, styling and bundled assets the installed native runtime already supports. It can **not** ship
  native code, native config, most new native libraries or an SDK upgrade: those need a new store build.
- A build gets an update only when platform + runtime version match and its channel points to a branch holding it.
  `eas channel:edit` re-points **every** build on that channel.
- Publishing to production is an **owner action**: confirm project, channel, environment, platform, runtime version
  and message; never infer production from the current git branch. Validate on preview/staging first.
- QA: a release build usually applies a downloaded update on the **next** cold start, so test with two launches.
  Do not lower `fallbackToCacheTimeout` just to skip that.

## Store builds and submission (EAS Build / Submit)
- `eas.json` profiles: `development` (`developmentClient: true`, internal distribution), `preview` (internal test
  build), `production` (store build; `autoIncrement: true` with `cli.appVersionSource: "remote"` lets EAS own the
  build number).
- Store credentials (Apple account, App Store Connect API key, Google Play service-account JSON) are configured by
  the owner via `eas credentials` / the EAS dashboard. Agents never read or print them; a service-account file is
  git-ignored and referenced only by path.
- A finished EAS build or a queued submission does **not** mean Apple or Google accepted it: check processing and
  review status before reporting "submitted".
- Play tracks go internal → closed → open → production; promote one step at a time.
- Apple Developer and Google Play accounts and EAS paid tiers cost money: owner decisions.
