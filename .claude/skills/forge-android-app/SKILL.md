---
name: forge-android-app
description: "Use when building an Android .apk from a web UI with Vite + Capacitor and proving it in the emulator (apk maken, telefoon app, android app bouwen, apk testen)."
---

# forge-android-app: web UI to a real .apk (Vite + Capacitor 6)

Forge-native. Complements `forge-mobile` (general mobile gates); this is the concrete wrap-a-web-UI path with proof on this machine.

## When to use
- The owner wants a phone app of an existing web UI (dashboard, Forge remote).
- Not for: React Native / Expo / Flutter / native Kotlin (`forge-mobile`), styling (`forge-glass-ui`), the network side (`forge-remote-access`).

## Steps (each ends on evidence)
1. **Pick versions.** Capacitor 6 builds with JDK 17. Capacitor 7 needs JDK 21: do not use it unless JDK 21 is installed. *Done when:* `@capacitor/core` major is 6.
2. **Layout.** The web app builds with Vite to `dist/`; `capacitor.config` has `appId`, `appName`, `webDir: "dist"`. Local fonts and assets only (offline). *Done when:* `dist/index.html` exists and references no remote URL.
3. **Add and sync.** `npx cap add android` once, then `npx cap sync` after every web build. *Done when:* `android/` exists and holds the new `dist` copy.
4. **Build.** Run `node .claude/forge-bin/forge-device-env.cjs` first and use what it prints: its `Java` line (the JDK folder is the one above `bin/java.exe`; the version must be 17) and its `Android SDK` line. Never copy a JDK patch folder or SDK path from another machine or an older note. From `android/`: `gradlew assembleDebug` with `JAVA_HOME` set to that JDK folder and `ANDROID_HOME` to that SDK. The apk lands in `android/app/build/outputs/apk/debug/app-debug.apk`. *Done when:* that file exists; quote its size.
5. **Signing.** Debug builds use the debug keystore, fine for the emulator. A release keystore and its passwords are an owner-gated secret: agents never create, read or print them. Without it, label release signing not-run.
6. **Network config.** Android blocks cleartext `http://` by default. Pick the narrowest rule that works: (a) best, serve https (for example a Tailscale `*.ts.net` certificate) and keep cleartext off; (b) when the host is fixed at build time, a `network-security-config` `domain-config` that allows cleartext for that one host only; (c) only when the host is typed in at runtime (a Tailscale or LAN IP known at pairing, and Android cannot scope cleartext by IP range or CIDR), app-wide `cleartextTrafficPermitted="true"` is allowed, and then all of these must hold: the app talks only to the one paired address, every call carries a per-device bearer token, the link is Tailscale (WireGuard-encrypted) or the owner's own LAN, and the reason plus the switch-off condition is written in the config file's comment and the app README. The WebView origin is `https://localhost`, so (c) also needs `android.allowMixedContent` in `capacitor.config`. Auth and pairing: `forge-remote-access`. *Done when:* the config file names which of (a), (b) or (c) applies and why.
7. **Emulator proof.** Use the output of `node .claude/forge-bin/forge-device-env.cjs` (step 4): it prints the exact commands and the AVDs on this machine. Then: boot one of those AVDs, `adb wait-for-device`, wait for `sys.boot_completed`, `adb install -r <apk>`, `aapt2 dump badging <apk>` (package, version), launch with `adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1`, screenshot with `adb exec-out screencap -p > shot.png` **from Git Bash** (PowerShell redirection corrupts PNGs). Read the PNG. *Done when:* a launch screenshot shows the real first screen.
8. **Stop.** `adb -s <serial> emu kill`. Never stop by process name; only an exact PID you own or `emu kill`.

## Pitfalls
- A built apk is not a played apk: install and launch it.
- Forgetting `cap sync` ships the old UI.
- WebView ignores `prefers-color-scheme` surprises: test dark and light on the emulator.
- Gradle first run downloads dependencies; give it time, do not assume a hang.

## Verification
Quote: apk path and size, badging line, the screenshot path, and the `emu kill` result. Name any step not run.

## See also
`forge-mobile`, `forge-glass-ui`, `forge-remote-access`.
