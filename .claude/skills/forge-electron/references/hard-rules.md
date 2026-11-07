# forge-electron — hard rules (full text)

## Hard rules (verify, don't assume — cite the exact config line)
- **`contextIsolation: true` on every `BrowserWindow`** — no exceptions. Required even with nodeIntegration off; it is what separates preload/renderer JS contexts from Electron internals.
- **`nodeIntegration: false` in all renderers.** Node reaches the renderer *only* through a preload `contextBridge.exposeInMainWorld` with an explicit, minimal API — never a raw `ipcRenderer` passthrough on `window`. (Enabling `nodeIntegration:true` also disables the sandbox for that renderer.)
- **`sandbox: true` where feasible; `webSecurity` left enabled; remote module disabled; `allowRunningInsecureContent: false`.**
- **Validated IPC.** Every IPC channel validates its payload and (where relevant) sender; the exposed API surface is a small allow-list, not the whole `ipcRenderer`.
- **Strict CSP** — no `'unsafe-eval'`, no wildcard remote script sources. (CSP limits, not cures, XSS — defense in depth on top of context isolation.)
- **No secrets baked into the bundle.** Sensitive data uses OS-appropriate secure storage (Keychain/DPAPI/libsecret — in Electron the built-in `safeStorage` API, no extra package), not plain files; secrets in env / secure store, never in the packaged asar.
- **A real, signed installer that actually opens.** The build produces the intended artifact (e.g. Windows NSIS), the installer installs and launches on a clean machine (verify — don't assume), and auto-update (if in scope) verifies signatures + supports rollback. Never ship an unsigned silent updater.
- **No test/demo/mock/placeholder data in the shipped build** (Forge desktop rule).
- **No global input in tests.** Tests and launch checks drive the app through Playwright's Electron support, its own window handle (PostMessage/SendMessage to its hwnd) or a built-in self-test flag, never through global SendKeys, SendInput, keybd_event or mouse_event: global input goes to whatever window is in front (in windows-game-v6, it typed into the owner's terminal).
