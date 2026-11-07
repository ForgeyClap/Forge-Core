// Allowlists for the chat send route's optional `mode` / `effort` / `model` fields (moved verbatim
// out of server.mjs, WP A11 part 1). Exact-match arrays: a value outside them is a 400, never a
// free string that reaches the spawned CLI's argv.
//
// fix-exec-modes: the real, help-confirmed `claude`/`claude -p` permission-mode + effort choices
// (verified via `claude --help` and `claude -p --help`, both print the identical flag set — see
// exec-bridge.mjs's MODE_TO_PERMISSION_FLAG comment for the exact help text this allowlist is
// derived from). 'execute' is this route's own default (no --permission-mode flag at all), not a
// real CLI flag value itself. Owner-requested 'bypass' mode is scoped to this loopback,
// single-user gateway tool only — see the SECURITY FRAME comment in exec-bridge.mjs.
export const EXEC_MODE_VALUES = ['execute', 'plan', 'accept-edits', 'bypass'];
export const EXEC_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];
// feat-model-picker: the real, help-confirmed `claude --model <model>` values — same
// allowlist-or-400 pattern as `mode`/`effort` above, same "never a free string reaches argv" rule.
// Source, verbatim from `claude --help`:
//   --model <model>   Model for the current session. Provide an alias for the latest model
//                      (e.g. 'fable', 'opus', or 'sonnet') or a model's full name
//                      (e.g. 'claude-fable-5').
// The three aliases 'fable'/'opus'/'sonnet' are exactly the three the help text names as
// examples ("e.g." — never claimed exhaustive). The four full names are this environment's own
// known model ids (claude-fable-5/claude-opus-5/claude-sonnet-5/claude-haiku-4-5-20251001) —
// already established as real independent of the alias examples above.
//
// 2026-07-30 CORRECTION (coordinator-reported real, non-mock CLI verification — NOT re-run
// independently by Build Boss, attributed here rather than claimed as self-verified): five short,
// paid `claude -p --model <value> '<prompt>'` calls from a neutral directory each answered
// correctly with exit code 0:
//   --model 'claude-opus-5[1m]'  'Antwoord met precies: MODELTEST'  -> "MODELTEST"
//   --model 'opus[1m]'           'zeg OK'                            -> "OK"
//   --model 'fable'              'zeg OK'                            -> "OK"
//   --model 'sonnet'             'zeg OK'                            -> "OK"
//   --model 'haiku'              'zeg OK'                            -> "OK"
// This proves two things a `--help`-only pass could not: (1) `haiku` IS a real, working alias —
// `--help`'s three examples were never claimed exhaustive, this is simply the first real test of
// the fourth one; (2) the "[1m]" context-window suffix IS real, accepted `--model` INPUT syntax,
// on both the full id (`claude-opus-5[1m]`) and the short alias (`opus[1m]`) — an earlier round of
// this same allowlist excluded the suffix on exactly the "`--help` text alone gives no evidence"
// reasoning this real-run evidence now supersedes, not merely re-asserts over.
// INPUT/OUTPUT NOW CONSISTENT: this project's own `.data/conversations/*.jsonl` already showed
// `"claude-opus-5[1m]"` as a real OUTPUT `modelUsage` key (10 occurrences, always paired with
// `canonicalModel:"claude-opus-5"` and `contextWindow:1000000`) — the CLI reports this exact
// string when a 1M-context Opus run happens. The two facts now corroborate each other: the same
// string that the CLI reports back as having run is confirmed to also be a real, acceptable
// `--model` INPUT value.
// `opus[1m]` (the alias+suffix form) is allowlisted too since aliases are already accepted
// generally and this specific combination was itself one of the five real-verified runs above.
// No OTHER bracket-suffixed combination (e.g. 'claude-fable-5[1m]', never observed as either
// input or output) is allowlisted — this stays an exact-match array, not a permissive pattern.
//
// 2026-10-06 GOAT model routing: the current model ids
// are claude-opus-5-5, claude-sonnet-5-5 and claude-fable-5-1 (the running session itself reports
// `claude-opus-5-5[1m]`). The GOAT router default is `sonnet[1m]` (Sonnet with 1M context); Opus and
// Fable are chosen by routing. The current ids (plus their [1m] forms for Opus/Sonnet and the
// `sonnet[1m]` alias) are added; the older ids above stay accepted for compatibility with saved
// conversations and existing clients. Still an exact-match array, never a pattern.
export const EXEC_MODEL_VALUES = [
  'fable', 'opus', 'sonnet', 'haiku',
  'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
  'claude-opus-5[1m]', 'opus[1m]',
  'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]',
  'claude-fable-5-1', 'sonnet[1m]',
];
