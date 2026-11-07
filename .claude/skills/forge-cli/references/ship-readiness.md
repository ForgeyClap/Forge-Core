# forge-cli — ship-readiness (full text)

## Ship-readiness (unique)
`--help`/`--version` verified; exit-code table documented AND tested (including a deliberate error path that returns non-zero); pipe round-trip proven (`echo ... | tool | tool`); destructive operations gated behind flag/confirm with a working `--dry-run`; runs on the declared target OSes (state which were actually run vs inferred); no secrets echoed to stdout/stderr; test suite green. Advisory checklist — optionally run `codex-reviewer` on the arg-dispatch + destructive-path code; not a blocker, but if a target OS was not actually run, say so.
