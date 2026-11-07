# forge-electron — Tauri v2 (when the app is Tauri, not Electron)

Provenance: rewritten in Forge's words from hairyf/skills `skills/tauri/SKILL.md` and its references
`security-capabilities`, `security-permissions`, `features-updater` and `distribute-signing` (MIT, (c) 2025-present
Hairyf; the content is generated from the official tauri-apps/tauri-docs and dated 2026-01-30), read on `main` on
2026-11-02. Licence text: `../LICENSE`. Re-check a config key against the current Tauri v2 docs before relying on it.

## Tauri or Electron
Tauri: Rust core + the OS WebView (WebView2 / WKWebView / WebKitGTK), small installers, a capability-based
permission model, mobile targets. Electron: one bundled Chromium (same rendering everywhere) and the Node ecosystem
in main. Decide per project (`forge-brainstorm`); never migrate an existing app without an owner decision.

## Security model (the Tauri version of the hard rules)
- **Capabilities** (`src-tauri/capabilities/*.json|toml`): `identifier`, `windows` (window **labels**, not titles),
  optional `platforms`, `permissions`, optional `remote.urls`. They decide which window may call which command.
- Once `app.security.capabilities` is set in `tauri.conf.json`, only the listed capabilities apply — set it.
- **Permissions**: identifiers such as `core:window:allow-set-title` or `fs:default`; `commands.allow/deny` plus
  `scope.allow/deny` for paths and URLs. Start from nothing and add the narrowest permission; avoid broad fs/shell scopes.
- Every command registered in `invoke_handler` is callable by default: restrict the command list in `build.rs`
  (`AppManifest::new().commands(...)`) and give high-privilege commands to as few window labels as possible.
- `remote` capabilities (a web origin calling commands) are a last resort; on Linux and Android Tauri cannot tell
  an iframe from the top frame.
- Capabilities do not protect against buggy Rust code or over-broad scopes: command handlers still validate every
  argument and check their scope.
- Set a strict CSP in `tauri.conf.json` (`app.security.csp`); no `'unsafe-eval'`.

## Updater
- Signing is mandatory: generate a key pair with the Tauri signer; the **public key content** goes in
  `plugins.updater.pubkey`; the private key and its password exist only as CI secrets (env vars at build time).
- `bundle.createUpdaterArtifacts: true` produces the update bundles plus `.sig` files.
- `plugins.updater.endpoints`: HTTPS only (TLS is enforced in production). A static JSON (`version`, `notes`,
  `pub_date`, `platforms.<target>.url|signature`) on a CDN or release page is the simple default.
- The capability that checks for updates needs `updater:default` (plus the process plugin to relaunch).
- Losing the private key means existing installs can never be updated again — the owner keeps a safe backup.

## Distribution and signing
- macOS: Developer ID Application cert + notarization outside the App Store (a free Apple account cannot notarize).
- Windows: a code-signing cert (OV/EV or a cloud signing service); unsigned builds show SmartScreen warnings.
- Linux: signing depends on the package format (deb/rpm/AppImage/Flatpak).
- Android/iOS: keystore and provisioning profiles as for any mobile app (see `forge-mobile`).
- All key material in CI secrets, never committed. Release and publish steps are owner-gated (`release.md`).

## Testing
- Frontend unit tests mock IPC (`mockIPC`, `mockWindows`, `clearMocks` from `@tauri-apps/api/mocks`).
- End-to-end through WebDriver (`tauri-driver`); Rust commands get ordinary `cargo test`.
- Same proof bar as Electron: the built installer installs and launches on a clean machine.
