# forge-code-review — Codex review config, validation and run route (moved verbatim from SKILL.md, WP 2.4a)

SKILL.md keeps a one-paragraph summary plus the two naming/provenance rules; this file keeps the complete original wording.

**The model comes from the EFFECTIVE config, and it is NOT a detail you restate from memory.** Read
`.claude/config/orchestration/codex-review.json` — the SHIPPED, template-owned default (engine, model,
reasoning effort, sandbox) — merged with the optional, NEVER-shipped
`.claude/config/orchestration/codex-review.user.json` (one account's own override, same shape, only
`review.model`/`review.reasoning_effort` can ever win from that file; every other field always comes from
the shipped file). `.claude/forge-bin/forge-codexreview-config.cjs::effectiveConfig()` does that
merge; its `buildCommand()` derives the real command as an **argv ARRAY** — never a hardcoded or
hand-concatenated shell string.

** finding 3.1 (2026-09-26 independent review):** the user-override file is gitignored and never
reviewed, so it may weaken nothing beyond the model/effort pin. Both are validated — an invalid value is
ignored, with a warning, and the shipped value is kept, never passed through. **The review sandbox is
hard-coded read-only** in `buildCommand()` — it is never read from either config file, so no override can
loosen it.

**Validation rule (2026-09-26 independent review):** `review.model` is usable only when it matches
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` — it must START with a letter or digit, never `-` (a leading dash
would make the "model" look like a CLI flag once it lands after `-m`, e.g.
`--dangerously-bypass-approvals-and-sandbox`). `review.reasoning_effort` must be one of (case-insensitive):
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Anything else is invalid and the shipped value is kept.

**The runnable, no-shell route:** `node .claude/forge-bin/forge-codexreview-config.cjs run [--adversarial]
--prompt "<review prompt or focus text>"` — this reads the effective config, validates it, derives the
argv, and spawns the real `codex` binary directly with `spawnSync(codexBin, argv, { shell: false })`; no
shell ever parses the model/effort/prompt values. A real run needs `--prompt`, a prompt starting with `-` is
refused, and on Windows the npm install's `codex.js` behind `codex.cmd` is found on PATH automatically
(`FORGE_CODEX_BIN` overrides). `run --dry-run --json` inspects the exact argv without spawning anything. `commandToDisplayString(argv)` (used internally for the subcommand's non-JSON display
line) is for a report/log line only and must never be re-parsed or re-executed.

**Portable default (no user file, or one that leaves `review.model` unset):** no model/effort pin at
all — the review runs on the codex CLI's own current default, and is reported honestly as
**"Codex default model"**, never a fabricated name. **Pinned:** an account's `codex-review.user.json` sets
`review.model`/`review.reasoning_effort`, and the command passes exactly those as `-m <model>` /
`-c model_reasoning_effort=<effort>`. This repo's own maintainer account currently pins `gpt-6-astra` at
`model_reasoning_effort=xhigh` in its own user file (long thinking = xhigh;
history: gpt-5.6-sol 2026-08-04 → HTTP 400 on that account 2026-09-24) — that pin lives in the
never-shipped user file, never in this shipped skill text, so a different account never inherits it.
Before the shipped config existed at all the model was pinned nowhere, so `/codex:review` silently used
whatever default the plugin happened to carry; reaching a specific pinned model can still need a newer
Codex CLI (gpt-5.6-sol needed ≥ 0.146.0 — 0.142.3 got an HTTP 400 telling it to upgrade, measured
2026-08-03).
