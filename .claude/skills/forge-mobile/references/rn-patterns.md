# forge-mobile — React Native patterns

Provenance: rewritten in Forge's words, no sentence copied. Sources read 2026-11-06:
- vercel-labs/agent-skills `skills/react-native-skills/SKILL.md` at `757ccb42a20478be6b7284088978070358b52d5e`
  (its frontmatter says MIT; the repo licence file could not be confirmed through the API and the corpus lists
  `license: null`, so only the ideas are used, in our own wording). Used: the list-performance, animation, navigation
  and UI rule headings. Its per-rule files and `AGENTS.md` were not read.
- ECC `react-native-patterns`: NOT_FOUND in pinned ECC `e2b8a51cea2228e515e1c3653effbeb62a2800fa` (checked
  `skills/` locally; only `react-patterns` exists). The deep-link, state and safe-area sections below follow the
  work-package plan and Forge's own gates, not an ECC text.
- Maestro (mobile-dev-inc/maestro, Apache-2.0): only the fact that it drives flows from YAML; repo not read.
Not taken over: any device or simulator MCP server (opt-in only, see `forge-mcp-clients`), any script.

## Deep links: validate before you navigate
A deep link or push payload is outside input. Parse it with a schema before it reaches a screen.
- One `parseLink(url)` function: `new URL`, an allow-list of hosts and paths, then a Zod schema per route
  (`z.object({ id: z.string().uuid() })`). Anything that fails goes to a neutral "not found" screen, never to a crash.
- Never pass raw query strings into a WebView, a file path or an API call. Never put a token in a link.
- Test the table of good, malformed and hostile links as plain unit tests (no device needed).

## Which state goes where
| State | Home | Why |
|---|---|---|
| Server data (lists, profile) | a query cache (TanStack Query) | caching, retry, offline reads |
| Form input, toggles | local `useState` / form library | dies with the screen |
| Cross-screen UI (theme, session flag) | a small store or context | few writers, many readers |
| Navigation position | the router (Expo Router / React Navigation) | deep links and back stack stay consistent |
| Secrets, tokens | SecureStore / Keychain / Keystore | never AsyncStorage |

Record the choice once; do not mix two stores for the same data.

## Lists
- Long or unknown-length lists use FlashList (or FlatList with `getItemLayout` when heights are fixed), never a mapped
  `ScrollView`.
- Give every row a stable `keyExtractor`, memoise the row component, keep callbacks stable, no inline style objects or
  functions created per row, and set `getItemType` for mixed row shapes.
- Do heavy work (formatting, sorting) before the list, not inside the row. Size images to their slot.

## Layout and polish
- Safe area: wrap screens with `SafeAreaProvider` and use insets (or `contentInsetAdjustmentBehavior`) so notch,
  home indicator and keyboard never cover content; test one notch phone and one small phone.
- Animate only `transform` and `opacity` (Reanimated, on the UI thread). Prefer native stack and native tabs over JS ones.
- Use `Pressable`, `expo-image` and `StyleSheet.create`; every text sits inside `<Text>`; avoid `cond && <X/>` when
  `cond` can be `0` or an empty string.
- In a monorepo keep native dependencies in the app package and one version per dependency.

## Tests
Unit-test `parseLink` and reducers first; run UI flows with Maestro or Detox on a release build. Assertions to add
if this skill ever gets evals: a hostile link never navigates; a 5,000-row list uses a virtualised list; no token in
AsyncStorage; no `console.log` of payloads in the release build.
