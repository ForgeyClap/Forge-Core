# forge-cli — domain overview

A CLI is a **contract with other programs, not just humans.** It is invoked by scripts, pipelines, CI, and other tools — so its arg surface, exit codes, and stdio behavior are the real API. `build-boss` implements; `test-boss` drives the exit-code + pipe integration tests; `docs-boss` produces the `--help`/usage/README. Never claim "cross-platform" for an OS you did not actually run on (see honest limit).
