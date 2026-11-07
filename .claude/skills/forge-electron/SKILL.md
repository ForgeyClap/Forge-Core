---
name: forge-electron
description: "Playbook for Electron desktop apps: safe IPC, installer (gebruik bij een desktop-app)."
# A10 original description (listing budget): "Playbook for Electron desktop apps: safe IPC, contextBridge, installer, signing, updates (gebruik bij een desktop-app)."
# W2-BUDGET original description (listing budget): "Playbook for Electron desktop apps: safe IPC, installer, updates (gebruik bij een desktop-app)."
---

# Forge playbook — Electron / desktop app

## Provenance
Forge-native playbook. The references add material rewritten in our own words (no file copied verbatim), seen on `main` on 2026-11-02:
- agents-inc/skills desktop-security-electron (MIT, commit 845a1f2, see LICENSE) → `references/electron-security.md`; pattern adapted from jwynia/agent-skills electron-best-practices (MIT only in frontmatter, no LICENSE file: ideas only, no text).
- hairyf/skills tauri (MIT, see LICENSE; generated from the official tauri-docs) → `references/tauri.md`.
- Pattern adapted from pedronauck/skills electron-release (licence not confirmed: ideas only, no text) → `references/release.md`.
Forge changes: no scripts or allowed-tools taken over, no unattended tag/push, every key in a secret store, release steps owner-gated.

## When to use
- Use for: Electron desktop apps: hardened renderer, safe IPC, secure storage, a signed installer that opens on a clean machine.
- Also for: Tauri v2 apps — same bar, Tauri mechanics (capabilities, permissions, updater keys) in `references/tauri.md`.
- Not for: renderer UI (`forge-website`) or gateway/API and money flows (`forge-integration` / `forge-payments`).
- Domain framing, team roles and honesty rule: `references/overview.md`.

## Hard rules (verify, don't assume — cite the exact config line)
- **`contextIsolation: true` on every `BrowserWindow`**
- **`nodeIntegration: false` in all renderers.**
- **`sandbox: true` where feasible; `webSecurity` left enabled; remote module disabled; `allowRunningInsecureContent: false`.**
- **Validated IPC.**
- **Strict CSP**
- **No secrets baked into the bundle.**
- **A real, signed installer that actually opens.**
- **No test/demo/mock/placeholder data in the shipped build**
- **No global input in tests.** Drive the app through Playwright, its own window handle (PostMessage to its hwnd) or a built-in self-test, never global SendKeys/SendInput.

Full text of every rule: `references/hard-rules.md`. The eight defense layers, fuses (flip before signing), navigation and permission handlers and the red-flag list: `references/electron-security.md`.

## Team (conditional)
Lead: `build-boss` (app) or `integration-boss` (desktop wrapper over a service). Desktop work: **`electron-pro`** specialist. Support: `typescript-reviewer` (main/preload/renderer), `security-reviewer` (IPC surface + CSP — desktop is a reasonable Codex/security trigger), `database-reviewer` (local store, e.g. SQLite for an offline app). Renderer UI: `forge-website` team.

## Skills / commands / MCP
Electron + electron-builder docs via Context7 for exact API/config; `forge-website` for the renderer UI; `forge-integration` / `forge-payments` if the app calls external services or handles money; `systematic-debugging` for build/native-dep failures; `forge-testing` for Playwright (it drives Electron; Spectron is dead). Reuse `electron-builder`'s signing config — don't hand-roll packaging.

## Fan-out & flow
L2 single-window app; L3 multi-window + native integration + installer + auto-update.
**Parallel:** main-process services ∥ preload API surface ∥ renderer UI (independent once the IPC contract is fixed — the preload API is the contract).
**Serial:** process architecture (main/preload/renderer) → hardened `BrowserWindow` options → contextBridge IPC API → renderer UI → build config + fuses → signed installer → clean-machine launch test.

## Domain gates
- `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true` (where feasible), `webSecurity:true` verified on every window (cite the file:line).
- Preload exposes a minimal, validated API; no raw `ipcRenderer` on `window`; IPC payloads validated.
- Strict CSP set; no `unsafe-eval`/wildcard script sources.
- Fuses set in the build (`RunAsNode` off, ASAR integrity together with `OnlyLoadAppFromAsar`) and flipped before signing; both permission handlers, `will-navigate` and `setWindowOpenHandler` set; `shell.openExternal` only on validated `https:` URLs.
- No secrets in the bundle; secure OS storage used for sensitive data.
- Build produces the intended installer and it **actually installs + launches on a clean machine** (evidence, not assumption).
- Cold-start + idle-memory numbers reported are **observed**, not guessed; listeners/watchers/intervals cleaned up on window close.
- No test/demo/mock data in the shipped artifact.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`. Signing matrix, auto-update, staged rollout and the honest unsigned path: `references/release.md`.

## Safety, approval and honesty
- Approval / safety: no secrets in the bundle; OS secure storage (`safeStorage`).
- Approval / safety: never ship an unsigned silent updater.
- Approval / safety: tag, push, publish, store upload and certificate purchase are owner actions; signing keys stay in the CI secret store and are never read or printed by an agent.
- Honest failure: verify, don't assume: cite the exact config line for every hardening flag.
- Honest failure: no signing cert or no clean-machine test: label it not-run.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
- `references/electron-security.md` — eight-layer defense, fuses, IPC contract, navigation and permissions, red flags.
- `references/release.md` — signing matrix, auto-update, staged rollout, unsigned path, pre-release checklist.
- `references/tauri.md` — Tauri v2 capabilities and permissions, updater signing, distribution, testing.
