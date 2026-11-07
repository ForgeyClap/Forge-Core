# forge-electron — Electron security (defense in depth)

Provenance: rewritten in Forge's words from agents-inc/skills `src/skills/desktop-security-electron/SKILL.md`
(MIT, (c) 2025 Vincent; LICENSE verified at commit 845a1f2, 2026-10-27), read on 2026-11-02, and checked against
the Electron security checklist. Pattern adapted from (ideas only, no text) jwynia/agent-skills
`electron-best-practices`: MIT is declared only in its frontmatter and the repo has no LICENSE file.
License text: `../LICENSE`. The upstream Deno scripts were not read, not run and not shipped.

Never rely on one mechanism. Each layer below stops a different attack; a review cites the file:line for each.

## The eight layers (outside in)
| # | Layer | What it stops | Evidence to cite |
|---|---|---|---|
| 1 | **Fuses** (`@electron/fuses`) | Features removed from the binary itself (run-as-node, inspect flags) | the build step that calls `flipFuses` |
| 2 | **ASAR integrity** | Tampering with the packaged app code | fuse config + packager version |
| 3 | **Process sandbox** | Renderer reaching the OS | `sandbox` not overridden to `false` |
| 4 | **Context isolation** | Renderer reaching preload/Electron internals | `contextIsolation` not overridden to `false` |
| 5 | **CSP** | Loading/executing injected script | `<meta>` CSP or `session` response header |
| 6 | **Permission handlers** | Silent camera/mic/geolocation grants | both handlers set, allow-list |
| 7 | **Navigation limits** | Renderer leaving the app origin | `will-navigate` + `setWindowOpenHandler` |
| 8 | **Input validation** | Hostile IPC payloads and URLs | schema check in every `ipcMain.handle` |

## webPreferences: keep the secure defaults
Secure defaults: `contextIsolation` (Electron 12+), `sandbox` (20+), `nodeIntegration: false` (5+), `webSecurity: true`.
Prefer not setting them at all; an explicit `false` anywhere is a red flag. A dev-only audit that warns when a
window overrides one of them catches regressions cheaply.

## Fuses — flip before signing
| Fuse | Default choice |
|---|---|
| `RunAsNode` | off (it allows code execution via `ELECTRON_RUN_AS_NODE`) |
| `EnableNodeOptionsEnvironmentVariable` | off unless production really needs `NODE_OPTIONS` |
| `EnableNodeCliInspectArguments` | off in production builds |
| `EnableEmbeddedAsarIntegrityValidation` | on for ASAR apps, **always together with** `OnlyLoadAppFromAsar` |
| `OnlyLoadAppFromAsar` | on (blocks loading an unpacked `app` folder) |
| `EnableCookieEncryption` | on, but one-way: existing plain cookies become unreadable, plan the migration |
| `GrantFileProtocolExtraPrivileges` | off after moving local content to a custom protocol |

- Flip fuses **before** code signing; flipping after invalidates the signature (and breaks the app on macOS).
- Unsigned arm64 macOS dev builds need `resetAdHocDarwinSignature: true` or they will not launch.
- `strictlyRequireAllFuses: true` fails the build when a new Electron fuse appears that nobody decided on.
- ASAR integrity: macOS from Electron 16, Windows from Electron 30. It detects tampering; it is not encryption,
  so sensitive logic still belongs on a server.

## IPC contract (the preload API is the contract)
- Request/response over `ipcRenderer.invoke` / `ipcMain.handle`, described by one typed channel map
  (channel → argument tuple → return type).
- The preload exposes small named functions through `contextBridge.exposeInMainWorld`, never `ipcRenderer` itself.
- Validate every argument in main (zod or manual checks); check `event.senderFrame` origin on privileged channels.
- Return a result object (`{ ok, data, error }`): Electron serialises only an Error's message across IPC.
- Event subscriptions return an unsubscribe function; React effects call it in cleanup (Strict Mode's double
  mount exposes leaks).

## Navigation, windows, links, protocols
- `will-navigate`: `preventDefault()` for any URL outside the app's own origin.
- `setWindowOpenHandler`: return `{ action: 'deny' }`; hand only parsed, `https:`-only URLs to `shell.openExternal`.
  The old `new-window` event does nothing on recent Electron.
- Deep links (`myapp://…`) are attacker-controlled input: parse, allow-list the action, validate parameters.
- Serve local content from a custom scheme registered with `protocol.registerSchemesAsPrivileged`
  (`standard`, `secure`, `supportFetchAPI`) instead of `file://`.

## Permissions and CSP
- Set **both** `session.setPermissionRequestHandler` (prompted requests) and `setPermissionCheckHandler` (silent
  checks) with a deny-by-default allow-list; one alone leaves gaps.
- CSP `default-src 'self'`; never ship `'unsafe-eval'`. A bundler may need `'unsafe-inline'` in dev only — scope
  that to dev builds.
- A local helper server binds `127.0.0.1`, never `0.0.0.0`.

## Red flags (block the review)
- Critical: `contextIsolation: false` · `nodeIntegration: true` · fuses flipped after signing · integrity
  validation without `OnlyLoadAppFromAsar` · `RunAsNode` left on · unvalidated `shell.openExternal` · raw
  `ipcRenderer` on `window`.
- Medium: no CSP · no permission handlers · unhandled `will-navigate` · `'unsafe-eval'` · `webSecurity: false` ·
  `allowRunningInsecureContent: true` · Spectron tests (deprecated; use Playwright's Electron support).
