---
name: forge-remote-access
description: "Use when reaching a local Forge or app from a phone safely via Tailscale or LAN (vanaf mijn telefoon, op afstand goedkeuren, telefoon bediening, remote bridge, pairing)."
---

# forge-remote-access: control a local app from the phone, safely

Forge-native. The endpoint and field contract is `command-center/docs/REMOTE-BRIDGE-CONTRACT.md`; this skill is the safety method and the test plan. Read the contract first; if missing, say so.

## When to use
- Approving, watching or starting Forge work from the phone app.
- Not for: building the apk (`forge-android-app`), styling (`forge-glass-ui`), public internet exposure (never done here).

## Rules
1. **Never expose the loopback gateway.** The gateway on 127.0.0.1 stays loopback only. *Done when:* a listener check shows it is not bound elsewhere.
2. **A separate bridge, off by default.** It is its own small server, started only by an explicit owner switch, and bound to ONE explicit address: a Tailscale address (100.64.0.0/10) or a LAN address. Never `0.0.0.0`, never `::`. It refuses to start on an unspecified or public address.
3. **Pairing.** One-time code (short life, single use) shown on the PC, entered or scanned (QR) on the phone. The server stores only a hash of the device token, never the token. Each device can be revoked.
4. **Every request:** bearer token check, strict CORS allow-list limited to the Capacitor origins (`https://localhost`, `capacitor://localhost`) and the bridge's own origin, rate limit per device and per IP, lockout after repeated bad codes or tokens.
5. **Scope of power.** The bridge exposes a short allow-list of actions (read status, approve or reject a pending request, start a named run). A hard-gate permission card (push, deploy, spend, delete) is answerable from the phone only as the contract allows: over Tailscale, after the confirm step (`confirm: true`); over a cleartext LAN bridge it is refused (`403 dashboard_only`) and answered on the PC. Source: section 4.11 of `command-center/docs/REMOTE-BRIDGE-CONTRACT.md`.
6. **Audit log** of pairing, auth failures, approvals and revokes, with tokens, codes and secrets redacted.
7. **Owner actions.** Installing Tailscale and logging in on the PC and the phone, turning the bridge on, and approving the first pairing are the owner's. Agents give the exact steps, never log in or read credentials.

## Test plan (all must run, name any that did not)
- Bind refusal on 0.0.0.0, on a public address, and on a missing address.
- Pairing: code works once, expires, wrong code lockout; token stored hashed.
- Auth: no token, wrong token and revoked token all return 401; CORS rejects a foreign origin; rate limit returns 429.
- Allow-list: an unlisted action is refused. A hard-gate card without `confirm: true` returns `400 confirm_required`; over a LAN bridge it returns `403 dashboard_only`; over Tailscale with `confirm: true` it is answered once and audited.
- Audit: entries exist and contain no token or code text.
- Phone check on the emulator or a device with cleartext config per `forge-android-app`.

## Pitfalls
- Binding to a LAN address on a public Wi-Fi: warn the owner; prefer Tailscale.
- CORS `*` with a bearer token is still wrong; keep the allow-list.
- A pairing code in logs defeats the whole scheme.

## Verification
Quote the real test output and the listener check; label anything not run.

## See also
`forge-android-app`, `forge-glass-ui`, `forge-integration`.
