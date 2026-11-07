# forge-cli — team, skills, commands, MCP

## Team (conditional)
Lead: `architect` for a multi-subcommand tool, else `build-boss` directly. Implementation: **`build-boss`**. Review: `python-reviewer` / `typescript-reviewer` / the stack's reviewer (idiomatic parsing + error handling), `silent-failure-hunter` (a command that swallows an error and still exits `0` is the classic CLI bug). Tests: **`test-boss`** (exit-code + stdout/stderr + pipe integration). Docs: **`docs-boss`** (`--help` text, usage examples, man page/README, exit-code table). Optional advisor: `security-boss` when the tool shells out, handles secrets, or takes untrusted paths (command-injection / path-traversal).

## Skills / commands / MCP
Stack reviewer skill + `/test-coverage`; the parser library's own docs (Context7 / vendor) for exact flag/subcommand API. No special MCP needed. **Opt-in dependency:** genuine cross-platform verification needs a CI matrix (Windows + macOS + Linux runners) or local VMs — Forge writes portable code and tests, but a single dev box can only *run* the OS it is on; treat other-OS results as inferred until a matrix run proves them.
