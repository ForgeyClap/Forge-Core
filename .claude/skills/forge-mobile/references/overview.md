# forge-mobile — domain overview

`build-boss` leads and does the native work (there is no separate mobile agent); `kotlin-reviewer`, `swift-reviewer` and `flutter-reviewer` review native code. Native UX/touch/layout defers to `ui-boss`; any backend/API the app calls defers to `forge-integration`; if it handles money defer to `forge-payments`. The core honesty rule for mobile: a Metro/dev bundler running is **not** a shipped app — the release binary must actually build and launch on a real device or emulator, and you must say so with evidence.
