---
name: forge-cli
description: "Playbook for CLIs and dev tools: flags, exit codes (gebruik bij een CLI-tool)."
# A10 original description (listing budget): "Playbook for CLIs and dev tools: flags, --help, exit codes, stdin/stdout, cross-platform (gebruik bij een commandline-tool)."
# W2-BUDGET original description (listing budget): "Playbook for CLIs and dev tools: flags, exit codes, cross-platform (gebruik bij een commandline-tool)."
---

# Forge playbook — Command-line tool / CLI

## When to use
- Use for: command-line tools: arg parsing, exit codes, stdio/pipe behaviour, safe defaults, cross-platform.
- Domain framing, team roles and honesty rule: `references/overview.md`.

**Do not duplicate ECC skills — defer to:** the language reviewer skills (`python-reviewer`, `typescript-reviewer`, `go-review`, `rust-review`, etc. by stack) for idiomatic code, and `/test-coverage` for the test gate. This file is orchestration only.

## Hard rules (non-negotiable)
- **Real arg parser + `--help` + `--version`.** Use the stack's established parser (argparse/click, commander/yargs, clap, cobra) — not hand-rolled `argv` slicing.
- **Correct exit codes.** `0` = success only; distinct non-zero codes for distinct failure classes (usage error, not-found, permission, runtime).
- **Pipe / stdio discipline.** Machine output → **stdout**; diagnostics, logs, prompts, progress → **stderr** (so `cmd | other` stays clean).
- **No destructive default.**
- **Testable — I/O separated from logic.** Core behavior lives in pure functions callable without spawning a process; the thin CLI layer wires args → core → streams.
- **Cross-platform.** Use the platform path API (no hardcoded `/` or `\`), tolerate CRLF/LF, don't assume a POSIX-only shell or GNU-only flags, and handle Ctrl-C (SIGINT) cleanly.

Full text of every rule: `references/hard-rules.md`.

## Team (conditional)
Lead: `architect` for a multi-subcommand tool, else `build-boss` directly. Full roster: `references/team-and-tools.md`.

## Skills / commands / MCP
Skills, commands, MCP and opt-in dependencies: `references/team-and-tools.md`.

## Fan-out & flow
L1 for a single-purpose tool; L2 for a multi-subcommand CLI.
**Serial:** arg contract (flags + `--help` + exit-code table) → core logic (I/O-separated, pure) → stdio/pipe behavior → destructive-action guards → tests.
**Parallel (independent once the arg contract + shared core lib are fixed):** individual subcommands ∥ the help/usage docs ∥ the test suite.

## Domain gates
- `--help` and `--version` work and exit `0`; unknown flags fail cleanly with usage.
- Exit codes are distinct and correct; no path exits `0` on error (proven by a failing-input test).
- Machine output on stdout, diagnostics on stderr; reads stdin when piped; a pipeline `producer | tool | consumer` round-trips without leaking logs into the data stream.
- No destructive default: dry-run/confirm/force present and tested; a bare run is non-destructive.
- Cross-platform path + line-ending handling; no unguarded POSIX-only/GNU-only assumption; clean SIGINT.
- Tests cover exit codes + stdout + stderr + pipe; core logic is unit-testable without a subprocess.

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: no destructive default: irreversible actions need an explicit flag or confirmation, with `--dry-run`.
- Approval / safety: secrets/tokens come from env or a config file, never echoed or baked into the binary; add `security-boss` when the tool shells out, handles secrets or takes untrusted paths.
- Honest failure: never claim "cross-platform" for an OS you did not actually run on; other-OS results are inferred until a CI matrix run proves them.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/overview.md` — domain framing paragraph(s) from under the title.
- `references/hard-rules.md` — full text of every hard rule.
- `references/team-and-tools.md` — full team roster, skills, commands, MCP and opt-in runtimes.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.
