# forge-electron — domain overview

The `electron-pro` specialist (`.claude/agents/electron-pro.md`) leads the Electron-specific work under Build Boss or Integration Boss. Renderer UI defers to `forge-website` (real content, responsive, a11y); anything that talks to a gateway/API defers to `forge-integration` / `forge-payments`. Forge context: the an accounting desktop app (accounting) desktop app — offline-first, safe IPC, an installer that opens on a clean machine. Modern Electron ships these secure defaults; **the rule is to never regress them**, and to prove they hold.
