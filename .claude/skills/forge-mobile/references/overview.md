# forge-mobile — domain overview

The `mobile-dev` specialist leads the native work under `build-boss`. Native UX/touch/layout defers to `ui-boss`; any backend/API the app calls defers to `forge-integration`; if it handles money defer to `forge-payments`. The core honesty rule for mobile: a Metro/dev bundler running is **not** a shipped app — the release binary must actually build and launch on a real device or emulator, and you must say so with evidence.
