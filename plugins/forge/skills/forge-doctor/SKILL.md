---
name: forge-doctor
description: "User-invoked only: /forge-doctor. Runs Forge's multi-minute self-test (every suite) plus the secret-leak scan; kept manual because one run costs minutes of CPU."
disable-model-invocation: true
---

# forge-doctor — self-test + leak scan

One command that proves the Forge install in this project actually works and leaks nothing.

## When to use
- The owner asks to "test everything", "check it all executes", or "find leaks".
- Before a sync/handoff, or after a batch of tooling changes.
- As the Security Boss's evidence step (the leak scan is a real security check).

## How to run
```
node .claude/forge-bin/forge-doctor.cjs                 # print a green/red summary, exit 0/1
node .claude/forge-bin/forge-doctor.cjs --run <run_id>  # also write <run>/doctor.json + log doctor_run
node .claude/forge-bin/forge-doctor.cjs --json          # full machine-readable report
```

## What it checks (all real — no fabrication)
1. **node --check** on every `.cjs`/`.js` under `forge-bin/` + `forge-dashboard/`.
2. **tests** — runs every `forge-bin/*.test.cjs` and tallies passed/failed.
3. **honesty gate** — feeds `log-event.cjs` a known type (expect accept) and an unknown type (expect
   hard-reject / exit 2), then deletes the throwaway run. Proves strict events still reject junk.
4. **legacy dashboard cleanup (advisory)** — the retired per-project Control Center's SPA files are gone;
   finding them is an advisory (an older install `forge-sync` has not cleaned up yet), never a failure.
5. **leak scan** — scans **git-tracked files** with the hardened `SECRET_PATTERNS`; reports only
   `{file, pattern}`, **never** the matched secret. `.env.example` + binaries are skipped.

These are the first five. The doctor enforces many more (agents, model routing, ship manifest, run contract,
feature registry, skill frontmatter and others) plus a set of advisories. The one full list is the header
comment of `.claude/forge-bin/forge-doctor.cjs` and the keys of `checks` and `advisory` in the `--json` output.

Writes `<run>/doctor.json` (read by the dashboard Doctor panel + the Project Registry's `test_status`).
Exit code 0 = all green, 1 = a check failed — safe to gate a hook/CI on it.

## Honesty
Real command output only. A failing check is reported as failing; the leak scan never prints a secret,
only the file + which pattern matched. `test_status` in the registry mirrors this doctor.json.
