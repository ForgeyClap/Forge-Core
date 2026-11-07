# forge-extension — team, skills, commands, MCP

## Skills / commands / MCP
Chrome Extension **MV3** docs via Context7 (manifest v3, service-worker lifecycle, messaging + storage + identity APIs — get the current API, MV2 patterns are dead). `forge-website` for the popup/options page UI; `forge-integration` if it talks to an API; `systematic-debugging` for service-worker lifecycle bugs (the "why did my listener not fire after idle" class). `browser` skill / Playwright to load the unpacked build and drive the core flow. No special MCP required. Reuse a bundler (esbuild / Vite / webpack) with an MV3/CRX plugin — don't hand-assemble the package.
