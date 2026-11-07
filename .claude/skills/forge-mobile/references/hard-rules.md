# forge-mobile — hard rules (full text)

## Hard rules (non-negotiable)
- **A native build that actually installs.** The app compiles to the real artifact (Android `.apk`/`.aab`, iOS `.ipa`, or an Expo dev/prod build) and **installs + launches** on a device or emulator/simulator — verified, not assumed. "It runs in Expo Go / Metro" is not proof a standalone build works.
- **No secrets in the client bundle.** A mobile bundle is trivially extractable (decompile the APK, read the JS bundle). Real secrets (API signing keys, private tokens) stay **server-side behind an API**; only genuinely public keys ship. Nothing sensitive committed or baked into the binary.
- **Secure token storage.** Auth tokens / credentials live in the OS secure store — `expo-secure-store`, `react-native-keychain` (iOS Keychain / Android Keystore), or Flutter `flutter_secure_storage` — **never** `AsyncStorage` / `SharedPreferences` / plain files.
- **Least-privilege permissions with rationale.** Request only permissions the app actually uses; iOS requires a real usage-description string per permission (`NSCameraUsageDescription`, etc.) or App Store rejection; Android manifest kept minimal.
- **Offline-where-promised actually works.** If offline use is promised, cached reads, queued writes, and a clear "no connection" state exist — not network calls that silently fail.
- **No test/demo/mock data, no debug menus, no `__DEV__`-only shortcuts in the release build.** Release signing configured (Android release keystore, iOS distribution), version/build numbers set, app icon + splash present.
