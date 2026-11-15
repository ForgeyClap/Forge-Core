# electron-pro: on-demand checklists

Read this when your work package includes build, packaging, performance or auto-update work. The installer config
itself belongs to desk-installer-engineer; these are the checks your app code must pass. Moved verbatim from
`.claude/agents/electron-pro.md` on 2026-11-13 (FIX-TUNE-C).

Before build or update work: Confirm OS targets, security constraints, and whether an installer or auto-update is in scope.

## Core focus

Secure process architecture (main / preload / renderer), safe IPC across the context bridge, native OS integration, and a reproducible multi-platform build that yields an installer which launches on a clean machine. No test / demo / mock data ships in the packaged app.

### Process & performance
- Main-process responsibilities kept off the renderer; heavy work in worker threads / child processes.
- Window state (size/position) persisted and restored; focus and modal handling correct.
- Cold-start startup measured (target under ~3s) and idle memory watched (target under ~200MB) — report the number you actually observed, not a guess.
- Listeners, watchers, and intervals cleaned up on window close to prevent leaks.

### Build & distribution
- Multi-platform build config produces the intended artifact (e.g. Windows NSIS installer) and the installer actually installs and opens — verify, don't assume.
- App icon, product name, and version are set; native dependencies rebuilt for the target platform/arch.
- Auto-update (if in scope) verifies signatures and supports rollback; never ship an unsigned silent updater.
- No test / demo / mock / placeholder data in the shipped build (Forge desktop rule).

_Adapted from VoltAgent awesome-claude-code-subagents (MIT): electron-pro._
