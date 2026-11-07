#!/usr/bin/env node
'use strict';
/**
 * Forge installer / sync — SAFE SYNC (2026-07-14 hardening WP1 + 2026-07-14 FIX ROUND). Zero-dependency
 * (fs/path/crypto/child_process/os only), Windows-safe. Replaces the old "fs.copyFileSync straight over the
 * project file, no backup, no canary, no validation, no rollback" design that made this the highest-blast-radius
 * file in Forge (one bad template could break all 12 projects with no undo).
 *
 * FIX ROUND (this pass) closed 7 blockers + 4 high findings + 11 medium findings found by an
 * adversarial review, independent QA (mutation-tested), and a 4-lens pre-mortem swarm:
 *   B1 cumulative drift baseline (receipt.knownHashes, not just filesChanged)      B2 receipt itself is now
 *   backed up/restored on rollback   B3 "unreadable" != "missing" (refuses instead of treating as new)
 *   B4 rollback-batch reaches the central backup + counts only real successes     B5 default central backup
 *   hub (<root>/.forge-backup-hub)   B6 no more ~/Documents default for multi-project commands   B7 rollback
 *   refuses to clobber content that diverged since this sync wrote it (--force-rollback-newer to override)
 *   H1 rollback never claims "restored" without a post-restore verify   H2 install exits 1 + prints BLOCKED
 *   when drift blocks (was silently exit 0)   H3 pre-sync validation baseline distinguishes a genuine
 *   regression from pre-existing red   H4 validation requires positive evidence (forge-doctor --json), a
 *   degraded (no-doctor) pass needs --allow-degraded   M1-M11 (see inline // M<n> markers).
 *
 * FIX (wp4 canary repro): the dedicated canary was aborting stage 0 on EVERY sync-all run,
 * regardless of template health. Direct repro (canaryInit + buildPlan + applyPlanSafely + a real `node
 * forge-doctor.cjs --json` run against the freshly-populated canary, before any rollback) isolated the exact
 * cause: one real, non-fabricated test (forge-capabilities-panel.test.cjs) has a genuine precondition of "at
 * least one real run with events.jsonl exists in this project" — true for every real Forge project, but
 * structurally impossible for a scaffold that canaryInit wipes and recreates empty on every single run.
 * Every other check/suite was genuinely green (89 suites, only this 1 assertion red). See seedCanaryRun's own
 * doc comment (near runValidation) for the fix: log ONE real, honestly-described run_started event into the
 * canary's own just-synced forge-runs/ (via its own freshly-copied log-event.cjs, going through the same
 * strict-mode honesty gate any real event would) right before validation runs — canary-only, opt-in via
 * opts.seedRunForValidation, wired ONLY into canarySyncOpts in runSyncAll. A real project's forge-runs/ is
 * never touched by this. This is not a gate weakening: a genuinely broken template still fails the doctor for
 * real reasons; a genuinely safe template now gets an honest, unconditional pass instead of being blocked by
 * an environment gap that was never the template's fault.
 *
 * SAFE FLOW (default for `install` and `sync-all`):
 *   1. PREFLIGHT   — classify every system file per project into: unchanged / to-change / expected_override
 *                     (declared in <project>/.claude/config/forge-overrides.json) / unknown_drift (project
 *                     changed, template didn't, no matching receipt) / conflict (BOTH project and template
 *                     changed since the last receipt) / eol_only (raw bytes differ ONLY by line-ending style
 *                     — always safe to sync, classification-only, RAW bytes still backed up/copied verbatim).
 *                     unknown_drift/conflict are NEVER silently overwritten. An existing-but-UNREADABLE system
 *                     file REFUSES the whole project sync (never silently treated as "new").
 *   2. BACKUP      — before ANY write: copy every file about to change into BOTH
 *                     <project>/.claude/forge-backups/<batchId>/<rel> (per-project) AND a second, central
 *                     copy at <centralRoot>/.claude/forge-backups/<batchId>/<projectId>/<rel>, unless
 *                     --no-central-backup is passed. `centralRoot` defaults differently per command (N10
 *                     fix, 2026-09-26 external audit — see defaultCentralBackupRoot()'s own doc comment):
 *                     for the single-project commands `install`/`rollback` it now defaults INSIDE the
 *                     project itself (<project>/.claude/forge-backups-central) — never a folder outside
 *                     .claude/ that forge-sync has no business writing to by default; for the multi-project
 *                     commands `sync-all`/`rollback-batch` it still defaults to <rootDir>/.forge-backup-hub,
 *                     since the caller already explicitly named that whole multi-project root. Any command
 *                     accepts --central-backup-root to point the second copy somewhere else entirely.
 *                     manifest.json records batchId/ts/runId/templateVersion/projectId/projectPath/
 *                     files[{rel,oldHash,newHash,existed}]/hadVersionFile/oldVersion/hadReceipt/oldReceipt.
 *                     Reusing a --batch-id that already backed up THIS project refuses (pass --resume-batch).
 *   3. DRY-RUN     — `--dry-run` prints the full plan and writes NOTHING (including no lock file).
 *   4. TWO-STAGE CANARY — `sync-all` ALWAYS syncs a dedicated, disposable, dot-prefixed canary project
 *      (`.forge-canary/`, wiped and recreated fresh on every canary-init/sync-all run) FIRST — a real project
 *      can never occupy that slot. Only if it validates does sync-all sync ONE representative real project,
 *      then a staged ladder (2 -> 3 -> --stage-size thereafter, default 3) over the rest. ANY validation
 *      failure OR any unresolved unknown_drift/conflict (without --force-overwrite) rolls back that project
 *      and STOPS the whole batch — later projects stay byte-untouched. `--force-overwrite` in sync-all
 *      requires the explicit `--force-all` co-flag and prints the exact per-project forced file list first.
 *   5. VALIDATE    — spawn forge-doctor.cjs BOTH before (baseline) and after writing, with --json, and
 *      require POSITIVE EVIDENCE (node_check.total >= files just synced, tests.suites>0, tests.passed>0) —
 *      a bare exit code is never trusted. A post-sync failure that was ALREADY present pre-sync (same
 *      checks red before and after, and the node_check hard gate on the just-synced files is clean) is
 *      reported as "already-red, not attributed to this sync" rather than blamed on the sync. Missing
 *      forge-doctor -> DEGRADED node --check fallback; a degraded pass never counts as synced unless
 *      --allow-degraded is passed. A doctor timeout is BLOCKED, not a confirmed failure.
 *      --reuse-pre-baseline (opt-in, install + sync-all; owner request 2026-10-06 'doctor 1x i.p.v. 2x'):
 *      skips the pre-sync doctor run and reuses the previous receipt's post-sync validation as the baseline,
 *      ONLY when decidePreBaseline proves it safe — a complete, fully green, evidence-backed (non-degraded)
 *      forge-doctor summary, receipt.postSyncManifestHash equal to the manifest computed now (system files
 *      byte-identical), and receipt.workspace (git HEAD + content-aware status hash, recorded after every
 *      sync's last write) exactly equal to now; a receipt without a fingerprint is never reused. Otherwise the doctor runs as normal, with a one-line reason. decideValidationOutcome
 *      is unchanged; it just receives the reused summary. receipt.baselineSource says REUSED or RUN.
 *   6. RECEIPT     — <project>/.claude/forge-sync-receipt.json: projectId/projectPath, batchId, runId,
 *      templateVersionFrom/To, backupRef, pre/post-sync manifest hashes, filesChanged, knownHashes (the
 *      CUMULATIVE per-file baseline — every system file's last-known-good hash, carried forward across
 *      syncs so an untouched file never "forgets" its baseline), overridesPreserved, validation +
 *      preValidation (both baselines persisted), baselineSource (pre-sync baseline RUN or REUSED, and why),
 *      workspace (git fingerprint, null when not a git repo), rollbackStatus, syncedAt.
 *   7. ROLLBACK    — restores byte-for-byte from whichever backup (project-local, else central) passes an
 *      integrity check; refuses (never fabricates "restored") when: the backup is missing/corrupt, the
 *      on-disk content has diverged from what this sync wrote (pass --force-rollback-newer), or a NEWER
 *      batch already touched the same file for this project. Every restored file is RE-VERIFIED by hash
 *      after restore — a file that could not actually be restored/verified is never counted as restored;
 *      the result is PARTIAL — MANUAL RECOVERY REQUIRED instead. forge-sync-receipt.json and
 *      FORGE_VERSION.json are restored/removed in the same pass. Journaled (resumable/idempotent).: settings.json
 *      too — byte-for-byte from the batch's settings ledger, only while it still holds what the sync wrote.
 *   8. --unsafe    — skips canary + validation only. It STILL takes a real backup (never "no undo"), STILL
 *      honors the forge-overrides.json allow-list, STILL respects the containment/symlink guard, and STILL
 *      refuses on an unreadable existing file rather than treating it as "new" (S2 fix).: it now
 *      runs the same preflight as the safe path — it REFUSES unknown drift/conflicts unless --force-overwrite is
 *      also given, never touches a seed-only file, refuses an incomplete template, and writes a receipt.
 *
 * WHAT IS SHIPPED (audit F3/F12/SYNC-03/05/09/13):
 * the hand-kept SYSTEM/SYSTEM_GLOB lists are gone. listSystemFiles()/listSeedFiles() are DERIVED from the
 * template's config/orchestration/FORGE_SHIP_MANIFEST.json (else this forge-sync's own copy) — see the block above
 * shipPlan(). `ship-sync` = synced and kept fresh; `seed-only` = created when absent, never overwritten (immune to
 * --force-overwrite and --unsafe); anything else is never delivered; a code-level NEVER-TOUCH floor (isNeverTouch:
 * per-project memory, runtime state, *.user.json overlays, grants/keys, forge-sync bookkeeping, .claude/forge-scribe/)
 * holds even against a broken manifest. preflight/status LIST every manifest entry the template lacks
 * (missingInTemplate — never a silent skip); install/sync REFUSE before writing when a ship-sync entry is missing
 * from a template that carries its own manifest, except release_excluded entries. A batch id is validated
 * (isSafeBatchId) on every path that turns it into a folder. A pre-split FORGE_SCOUT_VETTING.json's own verdicts
 * move to FORGE_SCOUT_VETTING.user.json before the shipped file is replaced (migrateScoutVerdicts).
 *
 * SYNC SAFETY FOR A LIVE PROJECT (part 1, 2026-10-10 — audit SYNC-02/06/07/11/12; the code is the block above
 * module.exports):
 *   - quiesce-check: a real `install` (safe or --unsafe) first proves the project idle — no Claude Code transcript of it
 *     and no forge-runs/<run>/events.jsonl modified within --idle-min (default 10), no .forge-sync.lock, no live process
 *     naming it (structured listing, never kills). Unknown counts as busy. Refused unless idle, or a recorded
 *     --quiesce-override "<reason>" (receipt + report). R3: `sync-all` runs the same check per real project (see
 *     below); library callers opt in with requireQuiesce + quiesce.
 *   - protect manifest: every real sync hashes EVERYTHING it must not change (all of .claude/ except the shipped files
 *     minus forge-overrides.json, plus root CLAUDE.md/AGENTS.md/.gitignore; .env* and key material by size+mtime only)
 *     BEFORE its first write and re-checks it after its LAST. Only the batch's own recorded actions (seed creations,
 *     the scaffold, retired/orphan moves, migration writes) and its bookkeeping (receipt, version, settings.json, a new
 *     .forge-bak/report, forge-backups*) may differ. Anything else — e.g. a doctor suite writing into forge-runs/ or
 *     agent-memory/ — rolls the WHOLE batch back automatically and exits non-zero naming every path. The rollback cannot
 *     undo the protected change itself; that needs the owner's own backup.
 *   - settings.json: merged with an undo record in the batch (settings-ledger.json + settings-pre/ copy + the .forge-bak,
 *     mirrored into manifest.json `settings`); a merge whose record cannot be written is refused.
 *   - install --dry-run --json: the full plan (per-file action, scaffold preview, settings delta, orphans, coupled verdict).
 *   - provenance: FORGE_VERSION.json and the receipt carry devCommitFrom/devCommitTo (template-provenance.json, else the
 *     template's own git work tree, else null); each batch writes .claude/forge-sync-report-<batch>.md.
 *   - coupled delivery: log-event.cjs, forge-verify.cjs and forge-runcontract.cjs are only ever delivered together; a plan
 *     that would update a subset refuses before any write.
 *
 * TEMPLATE PUBLISHING (the code is the publish-template block above module.exports):
 *   `publish-template --plan|--apply|--verify` refreshes the central template (~/.claude/forge/template/.claude, or
 *   --template-dir <x>/.claude) from the development tree this file lives in, driven by the shipping manifest: the
 *   ship-sync + seed-only set plus the other `template`-channel files (settings.json, the retired-dashboard hash list).
 *   --apply refuses (exit 4) on an unsafe batch id, the real template without --confirm-real-template, uncommitted
 *   published paths (unless --allow-dirty "<reason>"), or a backup that does not match the template file by file; it
 *   writes atomically, MOVES proven orphans into the backup (unproven ones only with --retire-unproven-orphans
 *   "<reason>"), writes template-provenance.json + a receipt, and restores from the backup on any failure. --verify (read-only) exits 3 on any difference. Every "missing in template" message
 *   (status, dry-run, install refusal) now points at `publish-template --plan` as the fix.
 *
 * CODEX REVIEW OF SYNC SAFETY (2026-10-10,, findings SYNC-01..13; see
 * .claude/forge-research/overhaul-2026-10-09/codex-r3-sync.md). In one line each:
 *   01 backups (project, central, settings, retired, orphans) are written and read only through REAL folders inside the
 *      project (realDirChain: no junction/symlink on the chain, realpath containment) — else refused, nothing applied.
 *   02 manifest.json is bound to the project's real path + the batch id with a self-hash (writeBoundManifest); rollback
 *      refuses a never-touch entry, a foreign/edited manifest, and a legacy-unbound one unless --allow-legacy-manifest;
 *      it deletes only files the batch itself created (apply-journal.jsonl) — anything else is kept, or under
 *      --force-rollback-newer MOVED into the batch backup, never deleted.
 *   03 the never-touch floor compares lower-cased names and covers .env/.env.* (not .env.example), secrets/, key material;
 *      a template with two paths that differ only in case is refused.
 *   04 right before each write the template bytes and the destination are re-hashed against the plan; a changed
 *      destination is skipped (never overwritten) and the batch rolls its own writes back as NEEDS REVIEW; creations are
 *      create-if-absent (exclusive).
 *   05 orphan/retired removals move the live file aside and re-hash what moved; changed bytes are put back, never deleted.
 *   06 settings.json is owned by a batch only when the merge applied; a refused merge is a no-op ledger; a settings
 *      conflict is found BEFORE any file is restored (no half rollback).
 *   07 a failed publish restores only template files that still hold what it wrote (changed-since-publish is kept).
 *   08 publish-template pins the PHYSICAL template folder once (realpath of it and its ancestors) and uses only that for
 *      plan, lock, backup, writes and restore; --confirm-real-template is judged on it; the receipt records both paths.
 *   09 sync-all proves every real project idle like install (same --idle-min / --quiesce-override, recorded per receipt)
 *      and its --unsafe branch runs under the per-project lock.
 *   10 a lock carries a random nonce; it is reclaimed only when older than 6 h AND its pid is gone (or it names no
 *      readable owner); release removes only this run's own lock.
 *   11 quiesce-check: a junction/symlink or unreadable activity folder is unknown = busy, never skipped as idle.
 *   12 protect manifest: two "unreadable" readings are a violation; app code outside .claude/ is guarded through git
 *      (HEAD + status + content hashes; git-ignored files are not seen — a stated limit). [WP-SYNC-R13 narrows the first
 *      half: two readings with the same error code + operation (+ the same modified time/size where both recorded one) are
 *      "not comparable", counted and reported, never a violation — see the WP-SYNC-R13 paragraph below; WP-SYNC-R13B limits
 *      that to paths strictly inside .claude/worktrees/<name>/ — everywhere else two unreadable readings are a violation again.]
 *   13 coupled trio: a member the template lacks refuses the install (only "none of it anywhere" is out of scope).
 *
 * CODEX R6 VERIFICATION FIXES (2026-10-10, findings F14..F19; .claude/forge-research/overhaul-2026-10-09/
 * codex-r6-sync-verify.md). In one line each:
 *   F14 rollback re-judges every file against the manifest right before staging: only this batch's own bytes (newHash) or an
 *       absent file is replaced — an owner edit made after the divergence scan is kept — unless --force-rollback-newer.
 *   F15 the writer re-checks the never-touch floor on ITS OWN resolved destination and refuses any physical parent other than
 *       the one the caller's floor check approved (apply; rollback restore + move-aside; the retired/orphan moves and their
 *       ledger restores through copyNoFollow).
 *   F16 a resume keeps the apply-journal anchor and checks the journal against it before the manifest is rewritten or a record
 *       appended; the interrupted-append recovery rules are written out at takeBackupUnsafe.
 *   F17 a journal head that cannot be persisted fails the batch (its writes rolled back) in install and in --unsafe.
 *   F18 the ignored-file inventory also works for a project nested inside a larger repository (git ls-files --full-name).
 *   F19 a dirty submodule / nested repository is fingerprinted by its own worktree (HEAD + status + content hashes); one that
 *       cannot be read makes the application-code guard 'partial', never true.
 *
 * WP-SYNC-R7 — 26H2 SYNC REHEARSAL FIXES (logs in .claude/forge-research/overhaul-2026-10-09/rehearsal-26h2/). One line each:
 *   1 a file without a baseline (newly shipped) whose bytes equal ANY version that path has had in the template — the template's
 *     publish history (publish-template now keeps a cumulative per-path `history` in its receipt) or a development tree's git
 *     history (proveTemplateOrphan) — is an unmodified copy, synced as 'template_history' instead of blocking as drift;
 *     `install --accept-template <rel>` (repeatable) replaces just the named drifted file(s), recorded in receipt + report.
 *   2 the doctor summary carries EVERY suite (failing_suites uncapped + suiteOk name map); regressionCheck flags a suite that
 *     went green -> red or is red for the first time, also while `tests` was already red.
 *   3 quiesce-check: raw control characters inside the PowerShell process JSON are escaped before JSON.parse.
 *   4 doctor limit: 1800 s default, or 12 s per suite when that is more (--doctor-timeout still wins); the measured duration and
 *     the limit are recorded on the validation result, the receipt and the change report.
 *   5 a failed validation prints its reason and the change-report path.
 *   6 a development tree (config/forge-dev-tree.json) is refused as a sync target (install, --unsafe, library) unless
 *     --allow-dev-tree-target "<reason>" (recorded); sync-all skips one it discovers and names it.
 *   7 .claude/forge-adoption/ and .claude/FORGE-SYNC-BRIEFING.md are on the never-touch floor (never shipped, overwritten or retired).
 *
 * WP-SYNC-R9 — THE REAL 26H2 INSTALL: three suites were red inside the post-sync doctor run, 173 files were rolled
 * back, and each suite passed alone. Now: (1) every flagged suite (green->red / red for the first time) carries its failing lines
 * (the doctor's own, max 5 x 200, plus the isolated run's, max 12 x 300; scrubbed with forge-store redactText, withheld when that
 * cannot load) into the result, the change report (Doctor -> "Suite regression check") and the receipt; (2) before a SUITE-ONLY
 * regression rolls back, each flagged suite is re-run ONCE, alone, sequentially, from the synced project (cwd = the project, the
 * doctor's per-suite limit, killed by its own PID). Exit 0 with passed > 0 and failed == 0 alone = 'flaky-under-load' (kept, said
 * plainly: NOT proven healthy under load); fails again / times out / 0-0 tally = regression, rolled back as before. A regressed
 * CHECK never re-runs. `--no-isolated-rerun` switches it off (install and sync-all).
 *
 * WP-SYNC-R10 — CODEX VERIFICATION OF R9/R8 (final round): passing alone is not enough. (1) coverage parity: when the
 * doctor run reached a tally, passed alone >= its passed + failed (a partial / skipping run stays a regression); without one the
 * acceptance is a stated HEURISTIC; (2) the tally comes from STDOUT only and must be ONE distinct tally, with no FAIL / not ok line
 * in stdout; (3) shown lines come from the WHOLE output redacted first (credential blocks cut out whole, an unterminated one withheld
 * to the end); (4) a throw in the step keeps the failed outcome and the rollback runs; (5) a suite that TIMED OUT in the doctor run
 * is never re-run, the whole phase is capped (--isolated-rerun-budget <ms>, default 20 min) and every timeout kills the suite's
 * process TREE by its exact PID; (6) the re-run gets an allow-listed environment and the files it created / changed under the
 * project are named in the report (not auto-rejected); (7) error / reason strings are scrubbed. .claude/worktrees: only children
 * holding a .git entry (real checkouts) are one entry each, everything else there is walked and hashed; a never-touch / memory link
 * into it is refused.
 *
 * WP-SYNC-R11 — VALIDATE THE FINAL STATE (the second real 26H2 install): the post-sync doctor ran BEFORE the settings.json
 * merge (the WP22 order: merge after the receipt/version stamp), so every shipped suite that asserts the project's own settings.json
 * (forge-stop-obligations: one Stop hook; forge-gate-secretprint: the forge-accounts deny rule) judged the OLD settings and failed —
 * alone as well — and every real project crossing that boundary was rolled back. Now install/sync-all merge settings.json (same undo
 * record in the batch) after the files and the scaffold and BEFORE the doctor and the isolated re-run; a validation failure or an
 * unresolved-drift refusal restores it byte-for-byte (undoSettingsMerge -> restoreSettingsLedger), the protect-violation rollback as
 * before. A refused-safe merge still never fails or rolls back the file sync by itself. The pre-sync baseline doctor still runs before
 * any write; the no-op path and --unsafe run no doctor, so their order is unchanged.
 *
 * WP-SYNC-R12 — THE VALIDATION WINDOW (Codex r8 settings-order review R11-01..R11-06): with the merge in front of the
 * doctor, settings.json holds this batch's merge while the doctor, its suites and the isolated re-runs run. (1) A throw in the
 * validation step is a FAILED validation and takes the normal in-run rollback (files, scaffold, settings.json, report) — it no longer
 * escapes with merged settings and no receipt. (2) Before the receipt, settings.json must be exactly what the doctor judged (and what
 * the merge wrote); a suite that rewrote it fails the sync like any validation failure — rolled back, recorded, no receipt — and every
 * receipt records the judged settings.json so --reuse-pre-baseline is refused once it differs. (3) Every in-run rollback restores
 * settings.json FIRST, to the pre-sync bytes read under the lock; bytes found there that this batch did not write are moved into the
 * batch backup, never lost; this batch's own .forge-bak is removed. (4) A merge step that threw after the tool wrote (or could not
 * finalise its ledger) is settled at once: pre-sync bytes back, ledger marked not-applied, so no later rollback is refused over it.
 * (5) The in-run protect-violation rollback is no longer refused wholesale by a settings.json conflict (reported separately).
 * (6) abortNote says "files rolled back" only when the file restore confirmed it. The no-op path still merges without a doctor.
 *
 * WP-SYNC-R13 — UNREADABLE ON BOTH SIDES (the third real 26H2 install): the install rolled back over 567 "CHANGED"
 * entries that nothing had changed — folders under .claude/worktrees/<wp>/src/.../scratch/<guid>/ left with a locked ACL by .NET
 * tests (Node gets EPERM on scandir). The R3 rule "two unreadable readings are never equal" made every such project un-installable.
 * Now a path unreadable BEFORE and AFTER is "not comparable (unreadable on both sides)" — counted, listed (--json), shown by
 * protect-manifest / verify-protect / the install line / the change report, never a violation — when the error CODE is the same and
 * known, the failing operation (scandir / open / lstat) is the same, and, where both readings recorded them, the lstat modified time
 * (and a file's size) are the same: a locked folder whose time moved IS a change. The code/operation are compared, never the message
 * with its absolute path; manifests written before R13 carry only the message and are parsed from it (they have no time, so the time
 * is not compared for them — said in the output). Unreadable on one side only (became unreadable / became readable), another code or
 * operation, or a time/size that moved stays a violation. An agent checkout / summarized folder that cannot be read stays fail closed
 * (never "not comparable"); hashing, links, the never-touch floor and the worktree summary are unchanged.
 *
 * WP-SYNC-R13B — CODEX ADVERSARIAL REVIEW OF R13 (one round, NEEDS FIXES, each finding reproduced). One line each:
 *   R13-01 nothing below an unreadable folder is recorded, so a change under it that leaves the folder's own time alone is unseen.
 *          "Not comparable" now exists ONLY strictly inside .claude/worktrees/<name>/ (agent-checkout territory, already summary-only
 *          for real checkouts); unreadable in both readings anywhere else — memory, the never-touch floor, other .claude paths, the
 *          root files, .claude/worktrees itself or a direct child of it — is a VIOLATION, "unverifiable protected path" (also with
 *          two null times). protectUnreadableSame takes the key; without one it is never "the same".
 *   R13-02 hasGitEntry answered "no .git" on ANY lstat error, so a checkout whose .git probe failed (EPERM) was walked as a plain
 *          folder and never failed closed. Only ENOENT/ENOTDIR is "absent" now (gitEntryState); a failed probe is recorded as a
 *          checkout that cannot be identified ({kind:'unreadable', failClosed:'checkout'}, a violation) and the worktrees signature
 *          marks it 'u'.
 *   R13-03 the size is compared on its own (it used to be skipped whenever a time was missing); size or time recorded in one
 *          reading only is a change. The one stated exception: a pre-R13 "before" entry ({kind, error} only) has its time not
 *          compared — its size still is.
 *   R13-04 the failing operation must be known in BOTH readings (unknown/unknown was a match).
 *   R13-05 the install line, the change report, the receipt and verify-protect count inventoried / verified / NOT verified
 *          separately; "unchanged" / "nothing protected changed" is never claimed for an entry that was not compared.
 *
 * WP-SYNC-R14 — CODEX VERIFICATION OF ccbe9e7 (four more fail-OPEN gaps; each reproduced first). One line each:
 *   R14-01 a link whose target cannot be read is an unreadable entry (code + syscall 'readlink'), never {symlink, target:null}; a
 *          checkout whose .git LINK cannot be read is fail closed (never git 'link:null'); an app-code link never 'link ?'. Two failed
 *          reads used to compare equal, so a retargeted link / swapped checkout passed. A .git probe that fails in BOTH readings is a
 *          PERMANENT violation until it can be read again — intended (fail closed), and said by protect-manifest and verify-protect.
 *   R14-02 the app-code guard records a failed read as 'unreadable:<CODE>:<operation>' (only ENOENT/ENOTDIR on lstat is 'missing'),
 *          and such an entry — or an older manifest's literal 'unreadable' / 'link ?' — is never "unchanged": a violation, with the
 *          reason, and appCode.guarded 'partial' (app code lies outside .claude/, so the worktrees "not comparable" scope never applies).
 *   R14-03 a link/junction outside the .claude/worktrees tree is refused when it resolves INTO that tree (any link, conservative: a
 *          folder link such as .claude/config hides never-touch files below it), or when it sits at or above a never-touch / memory
 *          path and resolves outside the project (or cannot be resolved). Stated limit: the floor's name patterns (.env*, *.user.json,
 *          secrets/, FORGE_MEMORY*) can sit below any folder; only literal floor paths make a folder "above" one.
 *   R14-04 verified = content compared and equal (file hash, link target, walked folder, absent root file still absent); summaries
 *          (meta, node_modules/.git presence, checkouts, the R8 worktrees summary, 'other') and changes the sync recorded itself are
 *          counted apart; the app-code coverage stands next to every "unchanged"; "nothing protected changed" only when complete,
 *          otherwise "no violation detected within the verified scope".
 *
 * `adopt <projectDir>` establishes a baseline receipt from a project's CURRENT file hashes without writing
 * a single template/system file — prints which files differ from the template so a human can triage them
 * into forge-overrides.json. This replaces a blind --force-overwrite for a project's very first safe sync.
 * S5: adopt REFUSES to replace an already-adopted baseline unless --force is passed (a second adopt would
 * otherwise silently un-protect every previously-drifted file); --force snapshots the pre-adopt receipt first.
 *
 * NOT BUILT (honest gap, not silently ignored): forge-sync has no GENERAL mechanism for the template to
 * DELETE/prune a project's system file (SYSTEM/SYSTEM_GLOB stay purely additive). Rollback already supports
 * restoring an ADDED file back to non-existence (oldHash:null), the one deletion-shaped case the general
 * mechanism can produce today. The ONE named exception is pruneRetiredFiles(): a fixed,
 * explicit list of exactly the 7 files the removed per-project Control Center used to ship, cleaned out of
 * an already-synced project when unmodified (hash-gated against receipt.knownHashes — a modified copy is
 * kept and reported, never deleted), plus its 2 generated runtime-state files (PORT/DASHBOARD_STATE.json,
 * removed unconditionally — never template-shipped, never user data). Backed up into the SAME batch's
 * backup dir under its own retired-prune/ subfolder before deletion, with a small separate ledger
 * (retired-prune-manifest.json) `rollback` restores best-effort (restoreRetiredPruneLedger) — intentionally
 * simpler than the main manifest.json/journal machinery, since it only ever restores files this same
 * function proved were unmodified. This does not generalize: a future removed file needs its own equally
 * explicit, hash-gated list, never a blanket "delete anything the template no longer ships".
 * closes the REPORTING half of that gap and adds an opt-in mover, still never a deleter:
 * findOrphans() lists every file the receipt says forge-sync shipped before that the template no longer ships
 * (seed-only, never-touch and the named retired-dashboard files excluded), HASH-GATED — "unmodified" only when the
 * bytes still equal the last shipped hash. status/install/dry-run print it. `install --retire-orphans` (opt-in,
 * safe path only) MOVES the unmodified ones into forge-backups/<batch>/retired-orphans/ with a ledger that
 * `rollback` restores (restoreRetiredOrphansLedger); a modified orphan is always kept.
 *
 * Usage:
 *   node forge-sync.cjs status [<projectDir>] [--verbose]
 *   node forge-sync.cjs install <projectDir> [--dry-run [--json]] [--force-overwrite] [--accept-template <rel>]... [--unsafe] [--batch-id <id>]
 *     [--central-backup-root <dir>] [--no-central-backup] [--run-id <id>] [--allow-degraded]
 *     [--doctor-timeout <ms>] [--resume-batch] [--reuse-pre-baseline] [--retire-orphans] [--no-isolated-rerun] [--isolated-rerun-budget <ms>]
 *     [--idle-min <n>] [--quiesce-override "<reason>"] [--allow-dev-tree-target "<reason>"]
 *   node forge-sync.cjs quiesce-check <projectDir> [--idle-min <n>] [--json]   # read-only; exit 0 idle, 1 busy/unknown
 *   node forge-sync.cjs protect-manifest <projectDir> --out <file>             # read-only on the project
 *   node forge-sync.cjs verify-protect <projectDir> <file> [--batch <id>] [--json]  # exit 0 unchanged, 1 violation
 *   node forge-sync.cjs lock-status <projectDir> [--json]   # read-only; exit 0 no fresh lock, 1 a fresh lock (maintenance mode)
 *   (--doctor-timeout default: 1800000 ms, or 12000 ms per *.test.cjs suite when that is more — measured 791-1091 s on 155 suites)
 *   node forge-sync.cjs adopt <projectDir> [--dry-run] [--force]
 *   node forge-sync.cjs list <rootDir>                                    # root REQUIRED (no ~/Documents default)
 *   node forge-sync.cjs canary-init <rootDir>                             # root REQUIRED; wipes+recreates the canary
 *   node forge-sync.cjs sync-all <rootDir> [--canary <projectName>] [--stage-size N] [--dry-run]
 *     [--force-overwrite --force-all] [--unsafe] [--batch-id <id>] [--central-backup-root <dir>]
 *     [--no-central-backup] [--run-id <id>] [--allow-degraded] [--doctor-timeout <ms>] [--reuse-pre-baseline]
 *     [--no-isolated-rerun] [--isolated-rerun-budget <ms>] [--idle-min <n>] [--quiesce-override "<reason>"]
 *   node forge-sync.cjs doctor [<projectDir>]                             # alias for status
 *   node forge-sync.cjs rollback <projectDir> [--batch <batchId>] [--central-backup-root <dir>]
 *     [--force-rollback-newer] [--allow-legacy-manifest]
 *   node forge-sync.cjs rollback-batch <batchId> <rootDir> [--central-backup-root <dir>] [--force-rollback-newer] [--allow-legacy-manifest]
 *   node forge-sync.cjs publish-template [--plan|--apply|--verify] [--template-dir <template>/.claude] [--batch-id <id>]
 *     [--json] [--verbose] [--allow-dirty "<reason>"] [--retire-unproven-orphans "<reason>"] [--confirm-real-template]
 *     [--backup-dir <dir>]
 *     # exit 0 ok · 1 could not run / failed (restored) · 2 usage · 3 differences · 4 apply refused (nothing written)
 *
 * Exit codes: 0 = all projects synced+validated (or a read-only command succeeded); 1 = batch aborted /
 * rolled back / operational refusal (bad path, missing backup, drift-blocked, etc.); 2 = usage error.
 *
 * Module API (for direct unit testing — every exported function takes its root/template dir as an explicit
 * argument; NONE of them call Date.now()/generate their own batchId — batchId/nowIso are always injected by
 * the caller so tests stay deterministic):
 *   listSystemFiles, sha256, sha256Normalized, fileStatus, templateVersion, claudeDirOf, safeJoin,
 *   isSymlinkPath, containmentSafe, projectId, receiptPath, readReceipt, writeReceipt,
 *   receiptLastTemplateHashMap, readOverrideAllowlist, migrateOwnerStandingRules, preflight, buildPlan, fullFileManifest,
 *   aggregateManifestHash, backupDirFor, centralBackupDir, takeBackup, applyPlanSafely, runValidation,
 *   decideValidationOutcome, decidePreBaseline, preBaselineManifestHash, manifestForRels, workspaceFingerprint, seedCanaryRun, verifyBackupIntegrity, loadTrustedManifest, findNewerOverlappingBatches,
 *   restoreFromManifest, rollbackProject, rollbackBatch, acquireLock, releaseLock, safeSyncProject,
 *   adoptProject, rawInstall, status, findForgeProjects, dedicatedCanaryDir, canaryInit, runSyncAll,
 *   parseArgs, CANARY_DIR_NAME, pruneRetiredFiles, restoreRetiredPruneLedger, RETIRED_TEMPLATE_FILES,
 *   RETIRED_STATE_FILES;: listSeedFiles, shipPlan, loadShipManifest, isNeverTouch, isNeverTouchDir,
 *   isSafeBatchId, migrateScoutVerdicts, findOrphans, retireOrphans, restoreRetiredOrphansLedger;
 *   quiesceCheck, isUntouchedFreshInstall, buildProtectManifest, verifyProtect, diffProtectManifests, protectExpectationsFromRun/FromBatch,
 *   mergeSettingsForBatch, restoreSettingsLedger, coupledDeliveryCheck, templateProvenance, provenanceFor,
 *   previewProjectScaffold, settingsDelta, installPlanJson, buildSyncReport, writeSyncReport;
 *   planPublishTemplate, applyPublishTemplate, verifyPublishTemplate, publishSourceSet, proveTemplateOrphan,
 *   devGitState, backupTemplateTree, restorePublish, parsePublishTemplateArgs, publishTemplateCli (see module.exports);
 *   WP-SYNC-R8: PROTECT_SUMMARIZED, protectSummaryFor, gitExcludePathspec (.claude/worktrees is never descended into).
 *   WP-SYNC-R9: confirmSuiteRegressions, suiteRerunPlan, runIsolatedSuite, summaryWithSuitesGreen, scrubFailLines, suiteTally,
 *   suiteCheckReportLines, doctorSuiteDurationHint (failing lines + one isolated re-run per flagged suite);
 *   WP-SYNC-R10: redactSuiteOutput, stripCredentialBlocks, scrubOneLine, isolatedAcceptance, isolatedRerunBudget, isolatedRerunEnv,
 *   projectChangeSnapshot, projectChangesBetween, suiteCheckErrorRecord, protectCheckoutEntry, linkIntoWorktrees, worktreesChildrenSignature.
 *   WP-SYNC-R13: protectUnreadableEntry, protectUnreadableSame, protectErrorCode, protectErrorSyscall, protectUnreadableSummary,
 *   protectNotComparableLine (unreadable on both sides = not comparable, counted; one-sided / other code / moved time = a change).
 *   WP-SYNC-R13B: protectNotComparableScope, gitEntryState, protectCounts, protectWhyLines.
 *   WP-SYNC-R14: protectLinkRefusal, protectLinkGuardsFloor, linkResolvesOutside, appUnreadableMarker, appEntryUnreadable,
 *   protectAppCoverage, protectScopeVerdict, protectInstallLine, protectReceiptRecord, PROTECT_CONTENT_KINDS.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ---- WHAT forge-sync ships (SYNC-03/05/09/13) ----
// The hand-kept SYSTEM pin list (~480 lines) and SYSTEM_GLOB are gone. The ONE shipping truth is the shipping
// manifest, config/orchestration/FORGE_SHIP_MANIFEST.json (schema forge-ship-manifest/v1), read with
// forge-shipcheck.cjs's own loadManifest()/classify() — ordered globs, LAST MATCH WINS — so forge-sync and the
// doctor's ship_manifest check can never disagree about a path:
//   ship-sync -> listSystemFiles(): copied into a project and kept fresh (drift-gated, backed up, rolled back);
//   seed-only -> listSeedFiles():   created when the project lacks the file, NEVER overwritten — immune to
//                                   --force-overwrite and --unsafe (owner state with a template default);
//   every other class (per-project, local-only, ship-release-only, installer-only, global-install, retired) and
//   every unclassified path -> never delivered.
// WHICH manifest: the TEMPLATE's own copy when it carries one — it describes exactly that template, and only then
// is "a ship-sync entry missing from the template" a hard refusal. A template without one (an older,
// pre-manifest template, or a hand-built test fixture) is classified with THIS forge-sync's sibling copy and a
// missing entry is reported as advisory. No usable manifest at all, an invalid one, or no forge-shipcheck.cjs
// beside this file -> shipPlan()/listSystemFiles() THROW: forge-sync never guesses what to ship.
const SHIP_MANIFEST_REL = 'config/orchestration/FORGE_SHIP_MANIFEST.json';
const OWN_SHIP_MANIFEST = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_SHIP_MANIFEST.json');
const SHIP_DELIVERY_CLASSES = new Set(['ship-sync', 'seed-only']);
const TEMPLATE_WALK_SKIP = new Set(['node_modules', '.git']);

// ---- NEVER-TOUCH floor: code, not manifest data, so no manifest edit can lower it ----
// Per-project memory and data folders, runtime state, owner overlays (*.user.json), grants and key material, and
// forge-sync's own bookkeeping. Even when a broken or hostile manifest classifies one of these ship-sync or
// seed-only, forge-sync never lists, writes, seeds, retires or deletes it: shipPlan() drops it (reported as
// neverTouchClaimed), and the orphan report / --retire-orphans skip it. forge-sync.test.cjs section 85 asserts
// that this floor covers every per-project entry of the real manifest, so a new per-project path has to be
// mirrored here on purpose (that is the point: a second, independent key on the memory door).
const NEVER_TOUCH_DIRS = new Set([
  'agent-memory', 'forge-runs', 'forge-research', 'forge-prd', 'forge-tickets', 'forge-vault', 'forge-artifacts',
  'forge-audit', 'forge-mindmaps', 'forge-index', 'forge-backups', 'forge-backups-central', 'forge-adopt-snapshots',
  'forge-genesis-staging', 'forge-scribe', 'forge-beads', 'forge-codemodel', 'graphify-out', 'forge-accounts', 'worktrees',
  'forge-adoption', // WP-SYNC-R7: the post-sync adoption record (forge-adopt-post-sync) — per-project, never shipped/overwritten/retired
  '.forge', // WP 2.1: a stray .claude/.forge folder (the state root belongs at the project root, see NEVER_TOUCH_ROOT_DIRS)
]);
// WP 2.1 (opt-in per project): the STATE ROOT at the PROJECT root (forge-canon paths.state_root, `.forge/`; forge-paths.cjs)
// holds the same runs, research, scribe store, memory and backups as the legacy .claude/forge-* folders above, so it is on
// the floor as well — a second key. forge-sync's world is the project's .claude/ folder: every shipped, seeded, retired or
// rolled-back path is .claude-relative (a `..` path is never-touch), and the only writes outside .claude/ are the scaffold's
// root .gitignore / CLAUDE.md (SCAFFOLD_ALLOWED), so <project>/.forge/ is unreachable by construction. On top of that the
// protect manifest inventories it (stateRootOf / walkStateRoot below; .forge/backups not walked, like .claude/forge-backups),
// so a change in it during an install is a VIOLATION, and `status` names it as protected.
const NEVER_TOUCH_ROOT_DIRS = new Set(['.forge']);
const STATE_ROOT_NOT_WALKED = new Set(['backups']); // inside the state root: other tools' backups, like PROTECT_NOT_WALKED
let forgePathsMod = null; // optional (guarded): an older install without forge-paths.cjs keeps the plain .forge default
try { const fp = require('./forge-paths.cjs'); if (fp && typeof fp.stateDirFor === 'function' && typeof fp.stateDir === 'function') forgePathsMod = fp; } catch { forgePathsMod = null; }
const NEVER_TOUCH_FILES = new Set([
  'CLAUDE.md', 'settings.json', 'settings.local.json', '.credentials.json', 'goat-gate.json',
  'forge-sync-receipt.json', 'scheduled_tasks.lock', 'ECC_TEST_MODE.md',
  'FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_DECISIONS.md', 'FORGE_PROJECT_PROFILE.md',
  'FORGE_SNAPSHOT.md', 'FORGE_SESSION_STATE.json', 'FORGE_VERSION.json', 'FORGE_CONFIG.json', 'FORGE_USAGE_GUARD_ACK.json',
  'FORGE_USAGE_GUARD_STATE.json', 'FORGE_ACCOUNT_ROTATION.json', 'FORGE_PAPERCLIP_BINDING.json', 'FORGE_RESUME_STATE.json',
  'FORGE_PROJECT_HARD_RULES.json', 'LESSONS.md', // LESSONS.md: per-project distilled lessons (forge-memory-consolidate), never shipped/overwritten/retired
  'FORGE-SYNC-BRIEFING.md', // WP-SYNC-R7: the per-project post-sync briefing written for the next session — never shipped/overwritten/retired
  'template-provenance.json', 'template-publish-receipt.json', // the TEMPLATE's own publish bookkeeping, never shipped to a project
  'config/forge-overrides.json', 'config/forge-usage-guard-override-grant.json', 'config/forge-genesis-approval.txt',
  'config/forge-mcp-owner-grant.txt', 'config/forge-stores.json', 'config/forge-stores.lock',
  'config/orchestration/FORGE_CONTEXT_BUDGET.json', 'config/orchestration/mcp-opt-in.json',
]);
// the only two paths INSIDE the per-project fixtures vault the template ships (README) or seeds (.gitignore)
const FIXTURES_VAULT_SHIPPED = new Set(['forge-fixtures/README.md', 'forge-fixtures/.gitignore']);
/** isNeverTouch(rel) -> true when forge-sync must never list, write, seed, retire or delete this .claude-relative
 *  path. Anything that is not a plain relative path (empty, absolute, a drive letter, `.`/`..`/empty segments)
 *  counts as never-touch too — fail closed. */
// the floor compares LOWER-CASED names (Windows and macOS treat FORGE_MEMORY.md and forge_memory.md as one
// file; on a case-sensitive system a case variant of a memory name is never-touch too — stricter, never looser). The
// original spelling is kept for reporting by the callers.
const NEVER_TOUCH_DIRS_LC = new Set([...NEVER_TOUCH_DIRS].map((s) => s.toLowerCase()));
const NEVER_TOUCH_FILES_LC = new Set([...NEVER_TOUCH_FILES].map((s) => s.toLowerCase()));
const FIXTURES_VAULT_SHIPPED_LC = new Set([...FIXTURES_VAULT_SHIPPED].map((s) => s.toLowerCase()));
/** isSecretFloorName(base) — SYNC-03: key material and env files by NAME, at any depth: .env and .env.* (except the
 *  committed .env.example), *.pem, *.key, *.pfx, *.p12, names starting id_rsa, id_dsa, id_ecdsa or id_ed25519, and
 *  .credentials.json. */
function isSecretFloorName(baseLc) {
  // every `.env*` name except the committed `.env.example` (so `.envrc`, `.env.local`, `.environment` too), and
  // every `*.env` (`prod.env`), not only `.env` and `.env.<x>`.
  if (baseLc === '.env' || (baseLc.startsWith('.env') && baseLc !== '.env.example') || /\.env$/.test(baseLc)) return true;
  return /\.(pem|key|pfx|p12)$/.test(baseLc) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(baseLc) || baseLc === '.credentials.json';
}
/** MEMORY_NAME_PREFIXES_LC — R4 / F07: the project's memory files by PREFIX at any depth (FORGE_MEMORY_backup.md,
 *  FORGE_DECISIONS-2026.md, forge_task_history.old.md ...), not only the four exact names. */
const MEMORY_NAME_PREFIXES_LC = ['forge_memory', 'forge_task_history', 'forge_agent_ledger', 'forge_decisions'];
/** WINDOWS_DEVICE_NAMES — R4 / F07: reserved device names; `CON`, `con.txt`, `COM1.cjs` all open the device on Windows. */
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** pathHygieneProblem(rel) -> null | reason. R4 / F07: a path spelling that Windows resolves to something other than the plain
 *  file it names is refused everywhere a manifest/template/journal path is accepted: an alternate data stream (`:` in a
 *  segment — `tool.cjs:hidden` writes into tool.cjs's ADS, invisible to readdir), a segment ending in a dot or a space (the
 *  Win32 layer strips them, so `FORGE_MEMORY.md.` IS FORGE_MEMORY.md), a reserved device name, or an 8.3 short-name alias
 *  (`AGENT-~1` resolves to agent-memory — the floor is judged on the spelling, so an alias could slip under it; the real
 *  path is checked again at write time by realTargetProblem, this is the cheap, context-free half). Stricter than any
 *  real file forge-sync ships (no shipped file carries `:`, `~<digit>`, a trailing dot/space or a device name). */
function pathHygieneProblem(rel) {
  const r = String(rel == null ? '' : rel).split('\\').join('/');
  for (const s of r.split('/')) {
    if (!s) continue;
    if (s.includes(':')) return 'contains ":" (an alternate data stream or a drive prefix is never a plain file name)';
    if (/[. ]$/.test(s)) return 'segment "' + s + '" ends in a dot or a space (Windows strips it, so it names another file)';
    if (WINDOWS_DEVICE_RE.test(s)) return 'segment "' + s + '" is a reserved Windows device name';
    if (/~\d/.test(s)) return 'segment "' + s + '" looks like an 8.3 short-name alias (it may resolve to a protected folder)';
  }
  return null;
}
/** normKey(rel) — R4 / F13: the ONE normalisation every override / floor / protect comparison uses: backslashes to `/`, a
 *  leading `./` dropped, repeated separators collapsed, and case folded on a case-insensitive file system (Windows, macOS). */
function normKey(rel) {
  let r = String(rel == null ? '' : rel).split('\\').join('/').replace(/\/{2,}/g, '/');
  while (r.startsWith('./')) r = r.slice(2);
  return foldCase(r);
}
function isNeverTouch(rel) {
  const r = String(rel == null ? '' : rel).split('\\').join('/');
  const segs = r.split('/');
  if (!r || r.startsWith('/') || /^[A-Za-z]:/.test(r) || segs.some((s) => s === '' || s === '.' || s === '..')) return true;
  if (pathHygieneProblem(r)) return true; // an ADS / device / trailing-dot / 8.3 spelling is never a path a sync may touch
  const lc = r.toLowerCase();
  const lsegs = lc.split('/');
  const base = lsegs[lsegs.length - 1];
  if (NEVER_TOUCH_DIRS_LC.has(lsegs[0]) || NEVER_TOUCH_FILES_LC.has(lc) || PROTECT_LC.has(lc)) return true;
  if (lsegs[0].startsWith('.forge-') || lsegs.includes('.claude-flow') || lsegs.includes('node_modules') || lsegs.includes('.git')) return true;
  if (lsegs.includes('secrets') || isSecretFloorName(base)) return true; // secrets/** and key/env material, any depth
  if (MEMORY_NAME_PREFIXES_LC.some((p) => base.startsWith(p))) return true; // FORGE_MEMORY*, FORGE_TASK_HISTORY*, FORGE_AGENT_LEDGER*, FORGE_DECISIONS*
  if (/\.user\.json$/.test(base)) return true;
  if (/^forge_killswitch_state/.test(lc) || /^forge_config\.once\./.test(lc) || /^config\/forge-owner-grant/.test(lc)) return true;
  if (/^forge-sync-report-[^/]*\.md$/.test(lc)) return true; // the per-batch change report forge-sync writes into the project
  if (/^forge_memory_archive_[^/]*\.md$/.test(lc)) return true; // dated verbatim archive of the project's FORGE_MEMORY.md (project memory)
  return lsegs[0] === 'forge-fixtures' && !FIXTURES_VAULT_SHIPPED_LC.has(lc);
}
/** isNeverTouchDir(dirRel) -> true when NOTHING inside this folder may ever be shipped (the template walk skips it).
 *  forge-fixtures/ is deliberately not one: it is never-touch file by file, except its README and .gitignore. */
function isNeverTouchDir(dirRel) {
  const segs = String(dirRel).split('\\').join('/').toLowerCase().split('/');
  return NEVER_TOUCH_DIRS_LC.has(segs[0]) || segs[0].startsWith('.forge-') || segs.some((s) => s === '.claude-flow' || s === 'node_modules' || s === '.git' || s === 'secrets' || s === '..' || s === '');
}
/** caseCollisions(rels) -> [[a, b], ...] — SYNC-03: two delivered paths that differ only in case are ONE file on Windows and
 *  macOS; delivering both would write the same file twice with different bytes. shipPlan refuses such a template. */
function caseCollisions(rels) {
  const seen = new Map(), out = [];
  for (const r of rels) { const k = String(r).toLowerCase(); if (seen.has(k) && seen.get(k) !== r) out.push([seen.get(k), r]); else seen.set(k, r); }
  return out;
}

/** shipcheckModule() — loaded lazily, because forge-shipcheck.cjs itself require()s this file (a top-level
 *  require here would hand it a half-initialised module). One more circular case is handled: when
 *  forge-shipcheck.cjs is the CLI entry point it calls its main() BEFORE assigning module.exports, so a require
 *  from inside that run sees an empty object. Then ONE complete, non-CLI instance of the same file is loaded
 *  through Node's documented require.cache semantics (the CLI's own cache entry is put back afterwards; the new
 *  instance runs no CLI because require.main is not it). Missing or incomplete reader -> a plain error: no
 *  reader, no sync. (Cleaner long-term: shipcheck assigns module.exports before its main() call.) */
let shipcheckLoaded = null;
function shipcheckModule() {
  if (shipcheckLoaded) return shipcheckLoaded;
  // own-property probe: reading a MISSING key on a half-loaded module's exports makes Node print a circular-require warning
  const has = (m, k) => !!m && Object.prototype.hasOwnProperty.call(m, k) && typeof m[k] === 'function';
  const complete = (m) => has(m, 'loadManifest') && has(m, 'classify') && has(m, 'globToRegExp');
  const fail = (why) => new Error('forge-sync: forge-shipcheck.cjs (the shipping-manifest reader) ' + why + ' beside ' + __filename + ' — refusing to guess what to ship');
  let sc;
  try { sc = require('./forge-shipcheck.cjs'); } catch (e) { throw fail('could not be loaded (' + e.message + ')'); }
  if (!complete(sc)) {
    const file = require.resolve('./forge-shipcheck.cjs');
    const cliInstance = require.cache[file];
    delete require.cache[file];
    try { sc = require('./forge-shipcheck.cjs'); }
    catch (e) { throw fail('could not be loaded (' + e.message + ')'); }
    finally { if (cliInstance) require.cache[file] = cliInstance; }
    if (!complete(sc)) throw fail('does not export loadManifest/classify/globToRegExp');
  }
  shipcheckLoaded = sc;
  return sc;
}
function isDirectory(p) { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } }
/** loadShipManifest(templateDir) -> {sc, rules, source:'template'|'forge-sync', file}. The template's own manifest
 *  wins; else this forge-sync's sibling copy. Throws when neither exists or the chosen one is invalid. */
function loadShipManifest(templateDir) {
  const sc = shipcheckModule();
  const inTemplate = path.join(templateDir, ...SHIP_MANIFEST_REL.split('/'));
  const tplHas = fs.existsSync(inTemplate);
  const file = tplHas ? inTemplate : OWN_SHIP_MANIFEST;
  if (!tplHas && !fs.existsSync(file)) {
    throw new Error('forge-sync: no shipping manifest — neither the template (' + inTemplate + ') nor this forge-sync (' + OWN_SHIP_MANIFEST + ') carries ' + SHIP_MANIFEST_REL + ' — refusing to guess what to ship');
  }
  const loaded = sc.loadManifest(file);
  const bad = loaded.errors.filter((e) => e.kind === 'manifest_invalid');
  if (bad.length || !loaded.rules.length) {
    throw new Error('forge-sync: the shipping manifest ' + file + ' is invalid (' + (bad.length ? bad.slice(0, 5).map((e) => e.path + ': ' + e.detail).join('; ') : 'no rules') + ') — refusing to guess what to ship');
  }
  return { sc, rules: loaded.rules, source: tplHas ? 'template' : 'forge-sync', file };
}
/** ruleCouldMatchUnder(patternSegs, dirSegs, segRe) — can a path inside folder dirSegs still match this glob?
 *  Prunes the template walk (a development tree's forge-runs/ alone holds thousands of files). Conservative: a
 *  `**` segment means "maybe". */
function ruleCouldMatchUnder(patternSegs, dirSegs, segRe) {
  for (let i = 0; i < dirSegs.length; i++) {
    if (i >= patternSegs.length) return false;
    if (patternSegs[i].includes('**')) return true;
    if (!segRe(patternSegs[i]).test(dirSegs[i])) return false;
  }
  return patternSegs.length > dirSegs.length;
}
function expandBraces(s) {
  const m = /^([^{]*)\{([^{}]*)\}(.*)$/.exec(s);
  return m ? m[2].split(',').flatMap((alt) => expandBraces(m[1] + alt + m[3])) : [s];
}
/** literalDirPrefixes(pattern) -> the literal .claude-relative folder(s) a glob entry lives in, braces expanded:
 *  `.claude/skills/{gsap,humanizer}/**` -> ['skills/gsap', 'skills/humanizer'], `.claude/forge-bin/*.cjs` ->
 *  ['forge-bin'], `.claude/*.md` -> [] (the wildcard starts right under .claude/). */
function literalDirPrefixes(pattern) {
  const segs = pattern.split('/').slice(1);
  const prefix = [];
  for (let i = 0; i < segs.length - 1; i++) { if (/[*?]/.test(segs[i])) break; prefix.push(segs[i]); }
  let out = prefix.length ? [''] : [];
  for (const s of prefix) out = out.flatMap((o) => expandBraces(s).map((a) => (o ? o + '/' : '') + a));
  return out;
}
/** shipPlan(templateDir) -> {system, seed, missing, missingBlocking, neverTouchClaimed, manifest:{source, file, rules}}.
 *  system / seed: sorted .claude-relative paths of the template files the manifest classifies ship-sync /
 *  seed-only (a never-touch path never appears). missing: [{rel, kind:'file'|'dir', class, rule, releaseExcluded}]
 *  — a literal ship-sync/seed-only entry the template lacks, or the literal folder of a glob entry that is absent
 *  altogether (skills/gsap/). missingBlocking: the ship-sync ones NOT marked release_excluded, and only when the
 *  manifest is the template's own; install and sync refuse on it before writing anything. */
function shipPlan(templateDir) {
  const tdir = path.resolve(templateDir);
  if (!isDirectory(tdir)) throw new Error('forge-sync: the template folder does not exist (or is not a plain folder): ' + tdir);
  const m = loadShipManifest(tdir);
  const { sc, rules } = m;
  const shipRules = rules.filter((r) => SHIP_DELIVERY_CLASSES.has(r.class) && r.pattern.startsWith('.claude/'));
  const reCache = new Map();
  const segRe = (s) => { if (!reCache.has(s)) reCache.set(s, sc.globToRegExp(s)); return reCache.get(s); };
  const ruleSegs = shipRules.map((r) => (/\{[^}]*\//.test(r.pattern) ? null : r.pattern.split('/')));
  const couldDescend = (dirRel) => {
    const ds = ('.claude/' + dirRel).split('/');
    return ruleSegs.some((ps) => ps === null || ruleCouldMatchUnder(ps, ds, segRe));
  };
  const files = [];
  const system = [], seed = [], neverTouchClaimed = [];
  (function walk(rel) {
    const abs = rel ? path.join(tdir, ...rel.split('/')) : tdir;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { throw new Error('forge-sync: cannot read the template folder ' + abs + ' (' + e.message + ') — refusing to ship a partial template'); }
    for (const e of entries) {
      if (TEMPLATE_WALK_SKIP.has(e.name) || e.isSymbolicLink()) continue; // a symlink is never shipped
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!couldDescend(r)) continue;
        if (!isNeverTouchDir(r)) { walk(r); continue; }
        // a ship rule reaches into a top-level memory/state folder: say so (a manifest bug made visible), never walk it.
        // Nested runtime folders (skills/x/.claude-flow, node_modules) are skipped quietly — local-only by the manifest.
        if (!rel) neverTouchClaimed.push({ rel: r + '/', kind: 'dir', class: null, rule: null });
      } else if (e.isFile()) files.push(r);
    }
  })('');
  for (const rel of files) {
    const r = sc.classify(rules, '.claude/' + rel);
    if (!r || !SHIP_DELIVERY_CLASSES.has(r.class)) continue;
    if (isNeverTouch(rel)) { neverTouchClaimed.push({ rel, class: r.class, rule: r.pattern }); continue; }
    (r.class === 'ship-sync' ? system : seed).push(rel);
  }
  const collisions = caseCollisions(system.concat(seed));
  if (collisions.length) {
    throw new Error('forge-sync: the template delivers paths that differ only in case (' + collisions.slice(0, 6).map((c) => c.join(' / ')).join('; ')
      + ') — on Windows and macOS they are ONE file, so the sync would write it twice; refusing (SYNC-03). Rename or remove one of them in the template');
  }
  const present = new Set(files);
  const missing = [];
  const seen = new Set();
  const addMissing = (x) => { if (!seen.has(x.rel)) { seen.add(x.rel); missing.push(x); } };
  for (const r of shipRules) {
    const releaseExcluded = typeof r.release_excluded === 'string' && r.release_excluded.trim() ? r.release_excluded.trim() : null;
    if (r.literalPaths) {
      for (const lp of r.literalPaths) {
        const rel = lp.slice('.claude/'.length);
        if (sc.classify(rules, lp) !== r || isNeverTouch(rel) || present.has(rel)) continue;
        addMissing({ rel, kind: 'file', class: r.class, rule: r.pattern, releaseExcluded });
      }
      continue;
    }
    for (const dirRel of literalDirPrefixes(r.pattern)) {
      if (isNeverTouchDir(dirRel) || isDirectory(path.join(tdir, ...dirRel.split('/')))) continue;
      addMissing({ rel: dirRel + '/', kind: 'dir', class: r.class, rule: r.pattern, releaseExcluded });
    }
  }
  const missingBlocking = m.source === 'template' ? missing.filter((x) => x.class === 'ship-sync' && !x.releaseExcluded) : [];
  return { system: system.sort(), seed: seed.sort(), missing, missingBlocking, neverTouchClaimed, manifest: { source: m.source, file: m.file, rules: rules.length } };
}
const PROTECT = new Set([ // NEVER overwrite these project-local files even inside a system dir
  'forge-dashboard/PORT', 'forge-dashboard/DASHBOARD_STATE.json',
  'FORGE_CONFIG.json', // the owner's own settings written by forge-config.cjs set — user-owned, never a template file
]);
const PROTECT_LC = new Set([...PROTECT].map((s) => s.toLowerCase())); // compared lower-cased by isNeverTouch
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'graphify-out']);
const CANARY_DIR_NAME = '.forge-canary'; // dot-prefixed -> structurally excluded from findForgeProjects discovery
// extensions treated as text for EOL-only classification (raw bytes ALWAYS backed up/copied/restored —
// normalization below is for CLASSIFICATION ONLY, never for the actual bytes on disk).
const TEXT_EXTS_FOR_EOL = new Set(['.md', '.json', '.cjs', '.js', '.css', '.html', '.ps1', '.sh', '.txt']);

// ---- retired per-project Control Center cleanup --------------------------------------
// The old Control Center (server.cjs + its static UI) was removed from the template — it is simply no
// longer in listSystemFiles()'s output, so an install/sync-all naturally stops SHIPPING it. That alone
// does not clean up a project that already HAS a copy from an earlier sync: SYSTEM/SYSTEM_GLOB stay
// purely additive (see the header doc's "NOT BUILT" note above), so a genuinely general delete mechanism
// still does not exist. This is a narrow, NAMED, one-time exception — see pruneRetiredFiles() below —
// scoped to exactly these files, with two different safety rules:
//  - RETIRED_TEMPLATE_FILES were shipped BY THE TEMPLATE (SYSTEM_GLOB used to cover forge-dashboard's
//    .js/.cjs/.html/.css) — removed ONLY when the on-disk hash still matches the LAST hash this tool
//    itself shipped (receipt.knownHashes), i.e. genuinely unmodified since the last sync. A project that
//    edited one of these keeps its copy; it is reported, never silently deleted.
//  - RETIRED_STATE_FILES were NEVER template-shipped (PROTECT-listed above, generated at runtime by the
//    now-deleted server.cjs) — removed when present UNLESS RETIRED_SERVER_FILE_REL itself is being kept
//    a kept, owner-modified server.cjs may still read/write this state — see the
//    `serverKept` gate in pruneRetiredFiles). There is no "last shipped hash" to check state against, and
//    it is not user data, but it is no longer removed unconditionally, and it is now ALWAYS added to the
//    ledger when it IS removed, so rollback can bring it back like any other pruned file.
const RETIRED_TEMPLATE_FILES = [
  'forge-dashboard/server.cjs', 'forge-dashboard/index.html', 'forge-dashboard/app.js',
  'forge-dashboard/graph.js', 'forge-dashboard/lenses.js', 'forge-dashboard/panels.js', 'forge-dashboard/styles.css',
];
const RETIRED_STATE_FILES = ['forge-dashboard/PORT', 'forge-dashboard/DASHBOARD_STATE.json'];
// the ONLY retired file that actually reads/writes RETIRED_STATE_FILES at runtime (/SYNC-2 gate).
const RETIRED_SERVER_FILE_REL = RETIRED_TEMPLATE_FILES[0]; // 'forge-dashboard/server.cjs'
const RETIRED_PRUNE_SUBDIR = 'retired-prune'; // namespaced backup subfolder inside a batch's backup dir
const RETIRED_PRUNE_MANIFEST_NAME = 'retired-prune-manifest.json';
// files the template STOPPED shipping ("orphans") — see findOrphans/retireOrphans.
const RETIRED_ORPHANS_SUBDIR = 'retired-orphans';
const RETIRED_ORPHANS_MANIFEST_NAME = 'retired-orphans-manifest.json';

/** isSafeBatchId — /SYNC-4: a strict allow-list on the ONE untrusted string backupDirFor() joins
 *  straight into a filesystem path for this retired-prune subsystem (pruneRetiredFiles /
 *  restoreRetiredPruneLedger). Letters, digits, `-` and `_` only, 1-100 chars: covers every batchId this
 *  tool itself ever generates ('sync-'+Date.now(), 'unsafe-'+Date.now()) and every batchId already used
 *  across --batch-id/--batch and this suite's own fixtures, while rejecting '.', '..', '/', '\\', and any
 *  other traversal/separator character outright — before path.join() ever sees it.:
 *  no longer scoped to the retired-prune subsystem — the audit found backupDirFor() joining a raw --batch-id on
 *  the MAIN backup path too (takeBackup mkdir+writes there). It is now enforced on every path: parseArgs (usage
 *  error), safeSyncProject, rawInstall, runSyncAll, rollbackProject, rollbackBatch, takeBackup,
 *  loadTrustedManifest, the orphan helpers — and backupDirFor()/centralBackupDir() themselves throw on an unsafe
 *  id as the last line of defence (assertSafeBatchId). */
function isSafeBatchId(batchId) {
  return typeof batchId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(batchId);
}
/** retiredPruneDirsFor(projectDir, batchId) -> {ok:true, dst, bdir, pruneDir} | {ok:false, reason}.
 *  centralizes the batch-id allow-list PLUS the symlink/junction + containment refusal for
 *  the retired-prune backup dir, so pruneRetiredFiles (write/delete) and restoreRetiredPruneLedger
 *  (read/restore) apply the exact same gate before ever touching it. Purely a check — never creates
 *  anything; callers mkdirSync when they actually intend to write. */
function retiredPruneDirsFor(projectDir, batchId) {
  if (!isSafeBatchId(batchId)) return { ok: false, reason: 'unsafe --batch-id (' + JSON.stringify(batchId) + ') for the retired-file backup path — must be 1-100 characters, letters/digits/-/_ only' };
  const dst = claudeDirOf(projectDir);
  const bdir = backupDirFor(projectDir, batchId);
  const pruneDir = path.join(bdir, RETIRED_PRUNE_SUBDIR);
  let chain;
  try { assertClaudeBaseContained(projectDir); chain = realDirChain(dst, pruneDir, { create: false }); } catch (e) { chain = { ok: false }; }
  if (!chain.ok || isSymlinkPath(bdir) || isSymlinkPath(pruneDir) || !containmentSafe(dst, pruneDir)) { // the whole chain
    return { ok: false, reason: 'the retired-file backup directory for batch ' + batchId + ' is a symlink/junction, or resolves outside the project (' + pruneDir + ') — refusing' };
  }
  return { ok: true, dst, bdir, pruneDir };
}
/** describeRetiredPruneFailure(r) — one-line, human-readable summary of why a retired-prune restore/
 *  ledger step was not fully ok, shared by rollbackProject's two retired-prune call sites (the normal
 *  path and the /SYNC-1 ledger-only fallback) so both report the same shape of message. */
function describeRetiredPruneFailure(r) {
  if (!r) return 'unknown reason';
  if (r.error) return r.error;
  const parts = (r.failed || []).concat(r.conflicts || []).map((f) => f.rel + ' (' + f.reason + ')');
  return parts.length ? parts.join('; ') : 'unknown reason';
}

/** listSystemFiles(templateDir) -> the ship-sync files of this template (.claude-relative, sorted), derived from
 *  the shipping manifest (see shipPlan). listSeedFiles(templateDir) -> its seed-only files. Both THROW when the
 *  manifest cannot be read — callers never get a guessed list. */
function listSystemFiles(templateDir) { return shipPlan(templateDir).system; }
function listSeedFiles(templateDir) { return shipPlan(templateDir).seed; }
function sha256(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } }
function sha256Str(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
// normalized (CRLF/CR -> LF) hash, used ONLY to classify a raw-byte difference as "eol_only" — never used
// for the actual copy/backup/restore, which always operate on raw bytes.
/** normalizeEolBuffer — S7 FIX: normalize CRLF/CR -> LF on the raw BYTE buffer, never on a decoded string.
 *  The old code called `.toString('utf8')` before normalizing — that decode is LOSSY: any invalid/non-UTF8
 *  byte sequence gets replaced with the SAME U+FFFD replacement character, so two files holding genuinely
 *  DIFFERENT invalid byte sequences (e.g. two different binary corruptions) can decode to an IDENTICAL
 *  normalized string -> identical normalized hash -> a real drift gets misclassified as eol_only and bypasses
 *  the drift gate entirely. Operating byte-for-byte avoids any decode step, so only genuine \r/\r\n bytes are
 *  ever touched; every other byte (valid or not) passes through unchanged. */
function normalizeEolBuffer(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d) { // CR
      out[j++] = 0x0a; // normalize CR and CRLF alike to a single LF
      if (buf[i + 1] === 0x0a) i++; // consume the paired LF of a CRLF pair
    } else {
      out[j++] = b;
    }
  }
  return out.subarray(0, j);
}
function sha256Normalized(p) {
  try {
    return crypto.createHash('sha256').update(normalizeEolBuffer(fs.readFileSync(p))).digest('hex');
  } catch { return null; }
}
/** fileStatus — B3: distinguishes MISSING (legitimately "new" -> safe to write) from UNREADABLE (exists but
 *  can't be read — permission/lock/exotic error, or a directory sitting where a file is expected). An
 *  unreadable file must never be silently treated as "new" (which would skip backing it up and then delete
 *  it on rollback). */
function fileStatus(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return e && e.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: e.message }; }
  if (st.isDirectory()) return { kind: 'unreadable', error: 'is a directory, not a file' };
  if (!st.isFile()) return { kind: 'unreadable', error: 'not a regular file' };
  try { return { kind: 'ok', hash: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }; }
  catch (e) { return { kind: 'unreadable', error: e.message }; }
}
function templateVersion(templateDir) { // deterministic hash of all system files -> the "version"
  const h = crypto.createHash('sha256');
  for (const rel of listSystemFiles(templateDir).sort()) h.update(rel + ':' + (sha256(path.join(templateDir, rel)) || '-'));
  return h.digest('hex').slice(0, 12);
}
function claudeDirOf(projectDir) { return path.join(projectDir, '.claude'); }

// ---- containment / symlink guards (never write outside a project's .claude/, never follow a symlink) ----
function safeJoin(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}
function isSymlinkPath(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
/** containmentSafe — M6: a leaf-only symlink check misses a symlinked/junctioned INTERMEDIATE directory
 *  (e.g. .claude/forge-bin itself replaced with a junction pointing outside .claude). Resolves the REAL path
 *  of the longest existing ancestor (a not-yet-existing leaf can't itself be a reparse point) and confirms
 *  the resolved path still lives under the resolved base. */
/** realpathViaExistingAncestor — the REAL path of `p` even when `p` does not exist yet: resolve the longest
 *  existing ancestor and re-append the missing tail. Both sides of a containment comparison MUST go through this
 *  same function. Measured on the GitHub windows runner: its TEMP is an 8.3 short path
 *  (`C:\Users\RUNNER~1\…`). The old code realpath'd the target's ancestor (long form, `…\runneradmin\…`) but fell
 *  back to `path.resolve()` (short form) for a base that did not exist yet — the dedicated canary's `.claude/` on a
 *  dry run — so every file "escaped" its own base and the canary plan was empty. */
function realpathViaExistingAncestor(p) {
  let existing = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try { real = fs.realpathSync.native(existing); } catch { real = existing; }
  return tail.length ? path.join(real, ...tail) : real;
}
function containmentSafe(baseDir, targetPath) {
  const realBase = realpathViaExistingAncestor(baseDir);
  const realTarget = realpathViaExistingAncestor(targetPath);
  return realTarget === realBase || realTarget.startsWith(realBase + path.sep);
}

// ---- shared safety helpers ----------------------
/** foldCase(s) — Windows and macOS file systems ignore case, so a path comparison there must too. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
function foldCase(s) { return CASE_INSENSITIVE_FS ? String(s).toLowerCase() : String(s); }
/** gitExcludePathspec(rel) — WP-SYNC-R8: a git `:(exclude)` pathspec for a folder relative to the `git -C` folder, case-folded
 *  (`icase`) exactly where foldCase() folds. It prunes git's walk of a folder that is NOT ignored; an IGNORED folder skips the
 *  pathspec check inside git, so a listing that includes ignored files needs a command-line negation too (appCodeGitState). */
function gitExcludePathspec(rel) { return ':(exclude' + (CASE_INSENSITIVE_FS ? ',icase' : '') + ')' + rel; }
function lstatKind(p) {
  try { const st = fs.lstatSync(p); return st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'dir' : 'other'); }
  catch (e) { return e && e.code === 'ENOENT' ? 'missing' : 'error'; }
}
/** isPlainRel(rel) — a plain relative posix path: no absolute/drive prefix, no '', '.' or '..' segment. */
function isPlainRel(rel) { return typeof rel === 'string' && !!rel && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.split(/[\\/]/).some((s) => s === '' || s === '.' || s === '..') && !pathHygieneProblem(rel); } // hygiene too
/** realTargetProblem(dst, out) -> null | reason. R4 / F06: the never-touch floor judged on the PHYSICAL path. The parent folder
 *  of a write/delete/move target is resolved through every junction/symlink/8.3 alias it may contain (realpath of the longest
 *  existing ancestor), and the resolved location must (1) still lie inside the real .claude of the project and (2) not fall
 *  under the floor by its REAL spelling — so `.claude/skills/x/` as a junction into `.claude/agent-memory/` (which the
 *  containment check alone accepts: it resolves inside the project) can never receive or lose a file. Never throws. */
function realTargetProblem(dst, out) { return realTargetCheck(dst, out).problem; }
/** realTargetCheck(dst, out) -> {problem, realParent}. R6 / F15: the same floor verdict as realTargetProblem, plus the PHYSICAL
 *  parent folder it was judged on. A writer that receives that folder as approvedRealParent refuses when its own resolution of
 *  the parent differs (a junction/symlink swapped in between this check and the staging), and re-checks the floor on its own
 *  resolved destination (writeBytesNoFollow {approvedRealParent, floor}). Never throws. */
function realTargetCheck(dst, out) {
  let realBase, realParent;
  try { realBase = fs.realpathSync.native(dst); } catch (e) { return { problem: 'the sync base ' + dst + ' cannot be resolved (' + e.message + ')', realParent: null }; }
  try { realParent = realpathViaExistingAncestor(path.dirname(out)); } catch (e) { return { problem: 'the parent of ' + out + ' cannot be resolved (' + e.message + ')', realParent: null }; }
  return { problem: realFloorProblem(dst, realBase, out, realParent), realParent };
}
/** realFloorProblem(dst, realBase, out, realParent) -> null | reason: the floor judged on `out` placed in the RESOLVED parent. */
function realFloorProblem(dst, realBase, out, realParent) {
  const realOut = path.join(realParent, path.basename(out));
  if (foldCase(realOut) !== foldCase(realBase) && !foldCase(realOut).startsWith(foldCase(realBase) + path.sep)) return out + ' resolves to ' + realOut + ', outside ' + realBase;
  const realRel = path.relative(realBase, realOut).split(path.sep).join('/');
  const spelledRel = path.relative(path.resolve(dst), path.resolve(out)).split(path.sep).join('/');
  // the same name by real path as by spelling: the caller already judged that spelling (pruneRetiredFiles' named PROTECT
  // exception included) — this check only speaks when a junction/symlink/alias makes the REAL location a different, floored path
  if (normKey(realRel) === normKey(spelledRel)) return null;
  if (!realRel || isNeverTouch(realRel)) return out + ' resolves to ' + realOut + ' — under the never-touch floor by its REAL path (a junction, symlink or short-name alias on the way)';
  return null;
}
/** realDirChain(anchorDir, targetDir, {create}) -> {ok, problem?, realTarget?}. SYNC-01: every folder from anchorDir down to
 *  targetDir must be a REAL folder — never a symlink/junction, never a file. With create:true a missing folder is made one
 *  level at a time (never `recursive` through a folder nobody checked). Then the deepest existing folder must resolve to
 *  exactly realpath(anchorDir) + the same names (a mount point or alias on the path is refused too). Never throws. */
function realDirChain(anchorDir, targetDir, opts) {
  opts = opts || {};
  const anchor = path.resolve(anchorDir), target = path.resolve(targetDir);
  const rel = path.relative(anchor, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, problem: target + ' is not inside ' + anchor };
  const ak = lstatKind(anchor);
  if (ak !== 'dir') return { ok: false, problem: anchor + (ak === 'link' ? ' is a symlink/junction' : (ak === 'missing' ? ' does not exist' : ' is not a plain folder')) };
  let cur = anchor, deepest = anchor;
  for (const s of (rel ? rel.split(path.sep) : [])) {
    cur = path.join(cur, s);
    let k = lstatKind(cur);
    if (k === 'missing' && opts.create) {
      try { fs.mkdirSync(cur); } catch (e) { if (!e || e.code !== 'EEXIST') return { ok: false, problem: 'could not create ' + cur + ' (' + e.message + ')' }; }
      k = lstatKind(cur);
    }
    if (k === 'missing') break; // a check-only call: the rest does not exist yet (whoever creates it goes through this check)
    if (k !== 'dir') return { ok: false, problem: cur + (k === 'link' ? ' is a symlink/junction — a backup is never written or read through a reparse point' : ' is not a plain folder') };
    deepest = cur;
  }
  let realAnchor, realDeepest;
  try { realAnchor = fs.realpathSync.native(anchor); realDeepest = fs.realpathSync.native(deepest); }
  catch (e) { return { ok: false, problem: 'realpath failed on ' + deepest + ' (' + e.message + ')' }; }
  const expected = path.join(realAnchor, path.relative(anchor, deepest));
  if (foldCase(realDeepest) !== foldCase(expected)) return { ok: false, problem: deepest + ' resolves to ' + realDeepest + ', not ' + expected + ' (a reparse point or alias on the path)' };
  return { ok: true, realTarget: path.join(realDeepest, path.relative(deepest, target)) };
}
function ensureRealDir(anchorDir, targetDir) {
  const c = realDirChain(anchorDir, targetDir, { create: true });
  if (!c.ok) throw new Error('refusing to write a backup: ' + c.problem);
  return c.realTarget;
}
/** centralAnchorFor(projectDir, centralRoot, {create}) -> {anchor, root}. SYNC-01: a central backup root INSIDE the project
 *  (the default <project>/.claude/forge-backups-central) is checked like the project's own backups, from the project's
 *  .claude (or root) down. A root OUTSIDE the project was named on purpose (sync-all's <root>/.forge-backup-hub,
 *  --central-backup-root): it is created when missing and its REAL path is the anchor; everything below it is checked. */
function centralAnchorFor(projectDir, centralRoot, opts) {
  const proj = path.resolve(projectDir), dst = claudeDirOf(proj), root = path.resolve(centralRoot);
  const within = (a, b) => foldCase(a) === foldCase(b) || foldCase(a).startsWith(foldCase(b) + path.sep);
  if (within(root, dst)) { assertClaudeBaseContained(proj); return { anchor: dst, root }; }
  if (within(root, proj)) return { anchor: proj, root };
  if (opts && opts.create) fs.mkdirSync(root, { recursive: true });
  return { anchor: fs.realpathSync.native(root), root: fs.realpathSync.native(root) };
}
/** writeBytesNoFollow(buf, out, baseDir, {exclusive, expectOldHash}) -> 'written' | 'exists' | 'changed'. The copyNoFollow
 *  write path for bytes already in memory (SYNC-04: the bytes that are hashed are exactly the bytes that are written).
 *  exclusive: the final name is created with a hard link from a fresh 'wx' temp file, which fails with EEXIST instead of
 *  replacing anything that appeared meanwhile (create-if-absent); a file system without hard links falls back to opening
 *  the final name with 'wx'. R4 / F05: expectOldHash (a sha256, or null for "must still be absent") re-hashes the destination
 *  AFTER the temp file is staged and IMMEDIATELY before the rename — the last point at which a check is possible; a
 *  destination that no longer holds those bytes returns 'changed' and nothing is replaced (the window left is the rename
 *  system call itself, which no user-mode check can close).
 *  approvedRealParent (from realTargetCheck) — the physical folder the never-touch floor was judged on; the writer's
 *  own resolution of the parent must still be exactly that folder, else nothing is staged. floor:true — the floor is judged
 *  again on the writer's OWN resolved destination (realFloorProblem), so a junction swapped in after the caller's check (while
 *  the source was read, say) can never land a file in agent-memory/ or another floored folder inside .claude. */
function writeBytesNoFollow(buf, out, baseDir, opts) {
  opts = opts || {};
  let realParent = null;
  if (baseDir) {
    let realBase;
    try { realParent = fs.realpathSync.native(path.dirname(out)); } catch (e) { throw new Error('containment pre-check failed for ' + out + ': ' + e.message); }
    try { realBase = fs.realpathSync.native(baseDir); } catch { realBase = path.resolve(baseDir); }
    if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) throw new Error('containment guard tripped BEFORE staging: parent of ' + out + ' resolves outside ' + baseDir + ' — no bytes written');
    if (typeof opts.approvedRealParent === 'string' && foldCase(realParent) !== foldCase(opts.approvedRealParent)) {
      throw new Error('never-touch floor guard tripped BEFORE staging: the parent of ' + out + ' now resolves to ' + realParent + ', not ' + opts.approvedRealParent + ' where the floor was checked (a junction/symlink was swapped in) — no bytes written');
    }
    if (opts.floor) { const fp = realFloorProblem(baseDir, realBase, out, realParent); if (fp) throw new Error('never-touch floor guard tripped BEFORE staging: ' + fp + ' — no bytes written'); }
  }
  const outReal = realParent ? path.join(realParent, path.basename(out)) : out;
  const tmp = outReal + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx'); fs.writeSync(fd, buf); fs.closeSync(fd); fd = null;
    if (realParent && fs.realpathSync.native(path.dirname(outReal)) !== realParent) throw new Error('containment guard tripped at write time: parent of ' + out + ' changed identity during staging');
    if (opts.expectOldHash !== undefined) { // the destination must still be exactly what the caller judged
      const st = fileStatus(outReal);
      const cur = st.kind === 'ok' ? st.hash : (st.kind === 'missing' ? null : 'unreadable');
      if (cur !== opts.expectOldHash) return 'changed';
    }
    if (!opts.exclusive) { fs.renameSync(tmp, outReal); return 'written'; }
    try { fs.linkSync(tmp, outReal); }
    catch (e) {
      if (e && e.code === 'EEXIST') return 'exists';
      if (!e || !['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(e.code)) throw e;
      let fd2;
      try { fd2 = fs.openSync(outReal, 'wx'); } catch (e2) { if (e2 && e2.code === 'EEXIST') return 'exists'; throw e2; }
      try { fs.writeSync(fd2, buf); } finally { fs.closeSync(fd2); }
    }
    return 'written';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* renamed away, or never created */ }
  }
}
/** quarantineAndVerify(out, expectedHash) -> {removed, keptAt?, reason?}. SYNC-05: the live file is first RENAMED aside (one
 *  atomic step, after which no new writer can reach these bytes by name), then the moved bytes are hashed. Only bytes that
 *  still equal the backed-up hash are removed; anything else is someone's newer work and is put back (hard link, so a file
 *  that took the name meanwhile is never replaced) — never deleted. */
function quarantineAndVerify(out, expectedHash, approvedRealParent) {
  // when the caller judged the floor on a physical folder, the move aside happens only while out's parent still is it
  if (typeof approvedRealParent === 'string') {
    let now;
    try { now = fs.realpathSync.native(path.dirname(out)); } catch (e) { throw new Error('the parent of ' + out + ' cannot be resolved right before the move aside (' + e.message + ') — kept'); }
    if (foldCase(now) !== foldCase(approvedRealParent)) throw new Error('the parent of ' + out + ' now resolves to ' + now + ', not ' + approvedRealParent + ' where the floor was checked — kept, nothing moved');
  }
  const q = out + '.forge-quarantine-' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.renameSync(out, q);
  const h = sha256(q);
  if (h !== null && h === expectedHash) {
    fs.rmSync(q, { force: true });
    if (fs.existsSync(q)) throw new Error(q + ' is still present after removal');
    return { removed: true };
  }
  let keptAt = q;
  try { fs.linkSync(q, out); fs.rmSync(q, { force: true }); keptAt = out; } catch { /* a new file holds the name now: keep both */ }
  return { removed: false, keptAt, reason: 'changed since it was backed up (now ' + (h ? h.slice(0, 12) : 'unreadable') + ', expected ' + String(expectedHash).slice(0, 12) + ') — kept' + (keptAt !== out ? ' at ' + keptAt + ' because another file now holds its name' : '') };
}

// ---- a backup manifest is bound to its project and batch, with a self-hash --------------------------------
const BACKUP_MANIFEST_SCHEMA = 'forge-sync-backup-manifest/v2';
const APPLY_JOURNAL_NAME = 'apply-journal.jsonl';
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function manifestSelfHash(m) { const c = Object.assign({}, m); delete c.manifest_sha256; return sha256Str(stableStringify(c)); }
function realProjectPath(projectDir) { try { return fs.realpathSync.native(path.resolve(projectDir)); } catch { return path.resolve(projectDir); } }
/** writeBoundManifest(dir, manifest) — every write of a batch's manifest.json goes through here, so its self-hash always
 *  covers the current content (the scaffold and settings patches included). */
function writeBoundManifest(dir, manifest) {
  const m = Object.assign({}, manifest);
  delete m.manifest_sha256;
  m.manifest_sha256 = manifestSelfHash(m);
  writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  return m;
}
/** manifestBinding(m, projectDir, batchId) -> {state: 'bound'|'legacy-unbound'|'mismatch'|'tampered', reason}. A manifest from
 *  an older forge-sync (no schema, no self-hash, no project_real) is 'legacy-unbound': still readable, but an unattended
 *  rollback refuses it unless --allow-legacy-manifest. */
function manifestBinding(m, projectDir, batchId) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { state: 'tampered', reason: 'the manifest is not a JSON object' };
  if (m.schema === undefined && m.manifest_sha256 === undefined && m.project_real === undefined) return { state: 'legacy-unbound', reason: 'written by an older forge-sync: not bound to a project or batch, no self-hash' };
  if (m.schema !== BACKUP_MANIFEST_SCHEMA || typeof m.manifest_sha256 !== 'string') return { state: 'tampered', reason: 'unknown manifest schema or missing self-hash' };
  if (manifestSelfHash(m) !== m.manifest_sha256) return { state: 'tampered', reason: 'its self-hash does not match its content (edited or corrupted after it was written)' };
  if (m.batch_id !== batchId || m.batchId !== batchId) return { state: 'mismatch', reason: 'it belongs to batch ' + JSON.stringify(m.batch_id) + ', not ' + JSON.stringify(batchId) };
  if (typeof m.project_real !== 'string' || foldCase(m.project_real) !== foldCase(realProjectPath(projectDir))) return { state: 'mismatch', reason: 'it belongs to project ' + JSON.stringify(m.project_real) + ', not ' + realProjectPath(projectDir) };
  return { state: 'bound', reason: null };
}
/** manifestEntryProblems(m) -> [problem]. SYNC-02(a): a rollback never writes or deletes a never-touch path, and only ever
 *  works on plain .claude-relative entries with a real (or null) old hash. Checked BEFORE any mutation. */
function manifestEntryProblems(m) {
  if (!m || !Array.isArray(m.files)) return ['the manifest has no files list'];
  const out = [];
  for (const f of m.files) {
    if (!f || typeof f !== 'object' || !isPlainRel(f.rel)) { out.push('malformed entry ' + JSON.stringify(f && f.rel)); continue; }
    if (isNeverTouch(f.rel)) out.push(f.rel + ' is under the never-touch floor (project memory, state or key material) — a rollback never writes or deletes it');
    if (!(f.oldHash === null || (typeof f.oldHash === 'string' && /^[0-9a-f]{64}$/.test(f.oldHash)))) out.push(f.rel + ': oldHash is neither null nor a sha256');
  }
  return out;
}
// ---- the apply journal ------------------------------------------------
// <batch>/apply-journal.jsonl records what the apply did per file (intent-create, created, written, skipped). It is the ONLY
// evidence a rollback has for "this batch created that file", so it must be impossible to redirect — the file is created
// exclusively and every append first lstat()s it: a plain regular file, not a link, ONE hard link (a pre-planted hard link to
// FORGE_MEMORY.md or .env would otherwise receive the JSON lines), and the same dev/ino this process saw when it created or
// first verified it — and tamper-evident against accidents: every record carries the batch id, a 1-based `seq` and
// `prev` (the sha256 of the previous line, 'genesis' for the first); the head (hash + seq) is written into the bound manifest
// after the apply. The reader re-derives the chain and marks the journal UNTRUSTED on a gap, a reorder, a truncation, a
// malformed or unbound line or a head mismatch; an untrusted journal proves nothing, so a rollback then deletes nothing
// (updates are still restored from their verified backups). Documented limit: the chain carries no secret — it detects
// accidents, truncation and stray files, not an actor who rewrites .claude/ and the manifest together (out of scope).
const JOURNAL_GENESIS = 'genesis';
const JOURNAL_ACTIONS = new Set(['intent-create', 'created', 'written', 'skipped']);
const journalIdentity = new Map(); // journal path -> {dev, ino}: pinned when THIS process created or first verified the file
function journalFileProblem(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return e && e.code === 'ENOENT' ? null : 'cannot lstat ' + p + ' (' + e.message + ')'; }
  if (st.isSymbolicLink()) return p + ' is a symlink/junction — the apply journal is never written through a link';
  if (!st.isFile()) return p + ' is not a regular file';
  if (typeof st.nlink === 'number' && st.nlink > 1) return p + ' has ' + st.nlink + ' hard links — an alias of another file was planted under the journal\'s name; refusing to append';
  const known = journalIdentity.get(p);
  if (known && known.ino && st.ino && (known.dev !== st.dev || known.ino !== st.ino)) return p + ' changed identity (another file now holds the journal\'s name)';
  return null;
}
/** openJournalFd(p) -> fd for appending. Creates exclusively ('wx') when absent; otherwise verifies with lstat FIRST (see
 *  journalFileProblem), opens for append and re-verifies on the open handle (fstat: regular, one link, same identity). Windows
 *  has no O_NOFOLLOW, so the lstat->open window is the stated residue; a link planted in that instant is still caught by the
 *  fstat on the handle (a link's target has its own nlink/identity). */
function openJournalFd(p) {
  const problem = journalFileProblem(p);
  if (problem) throw new Error(problem);
  let fd = null;
  try { fd = fs.openSync(p, 'wx'); }
  catch (e) { if (!e || e.code !== 'EEXIST') throw e; fd = fs.openSync(p, 'a'); }
  let st;
  try { st = fs.fstatSync(fd); } catch (e) { fs.closeSync(fd); throw e; }
  const known = journalIdentity.get(p);
  if (!st.isFile() || (typeof st.nlink === 'number' && st.nlink > 1) || (known && known.ino && st.ino && (known.dev !== st.dev || known.ino !== st.ino))) {
    fs.closeSync(fd);
    throw new Error(p + ' is not a plain, single-link file of this run at open time — refusing to append');
  }
  if (!known) journalIdentity.set(p, { dev: st.dev, ino: st.ino });
  return fd;
}
/** appendApplyJournal(dirs, rec, chain) — appends ONE chained record to every journal dir (the FIRST is mandatory, the central
 *  mirror is best-effort). chain = {batchId, seq, head} is advanced in place after the mandatory copy was written. */
function appendApplyJournal(dirs, rec, chain) {
  chain = chain || { batchId: null, seq: 0, head: JOURNAL_GENESIS };
  const record = Object.assign({}, rec, { batch_id: chain.batchId, seq: chain.seq + 1, prev: chain.head });
  const line = JSON.stringify(record);
  (dirs || []).filter(Boolean).forEach((d, i) => {
    try {
      if (lstatKind(d) !== 'dir') throw new Error(d + ' is not a plain folder');
      const fd = openJournalFd(path.join(d, APPLY_JOURNAL_NAME));
      try { fs.writeSync(fd, line + '\n'); } finally { fs.closeSync(fd); }
    } catch (e) { if (i === 0) throw new Error('the apply journal could not be written (' + e.message + ') — refusing to write without a record of what this batch creates'); }
  });
  chain.seq += 1; chain.head = sha256Str(line);
  return record;
}
/** readApplyJournal(dir, {batchId, expectedHead}) -> {present, trusted, reason, created:Set, createdHash:Map, intent:Set,
 *  skipped:Set, head, seq, records}. Per rel, the LAST record decides. trusted is false on any chain defect (see the block
 *  comment above); with expectedHead ({head, seq} from the bound manifest) the file must end exactly there, and a MISSING
 *  file is then untrusted too (present:false, trusted:false — the manifest says a journal was written). */
/** opts.anchorPrefix (used by a resume and by every append): the anchor {head, seq} must still be IN the journal —
 *  record #seq hashes to head and everything up to it chains from genesis — while complete, chained records AFTER it are
 *  accepted (out.beyondAnchor counts them; see the interrupted-append rules at takeBackupUnsafe). Without anchorPrefix (a
 *  rollback) the journal must END exactly at the anchor. An anchor of {genesis, 0} means the apply recorded nothing: a missing
 *  file is then consistent. out.tornTail: the file does not end with a line end (an append was cut off). */
function readApplyJournal(dir, opts) {
  opts = opts || {};
  const out = { present: false, trusted: false, reason: null, created: new Set(), createdHash: new Map(), intent: new Set(), skipped: new Set(), head: JOURNAL_GENESIS, seq: 0, records: 0, tornTail: false, beyondAnchor: 0 };
  const untrusted = (why) => { out.trusted = false; out.reason = why; return out; };
  const anchor = opts.expectedHead && opts.expectedHead.head ? opts.expectedHead : null;
  if (anchor && (typeof anchor.head !== 'string' || !Number.isInteger(anchor.seq) || anchor.seq < 0)) return untrusted('the journal anchor recorded in the manifest is malformed (' + JSON.stringify(anchor) + ')');
  const emptyAnchor = !!anchor && anchor.seq === 0 && anchor.head === JOURNAL_GENESIS;
  let raw;
  try { raw = fs.readFileSync(path.join(dir, APPLY_JOURNAL_NAME), 'utf8'); }
  catch (e) {
    if (anchor && !emptyAnchor) return untrusted('the manifest records an apply journal (seq ' + anchor.seq + ') but the file is ' + (e && e.code === 'ENOENT' ? 'missing' : 'unreadable: ' + e.message));
    return out; // no journal at all: nothing proven, nothing untrusted
  }
  out.present = true;
  out.tornTail = raw.length > 0 && !raw.endsWith('\n');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  let head = JOURNAL_GENESIS, batchId = opts.batchId || null;
  let headAtAnchor = anchor && anchor.seq === 0 ? JOURNAL_GENESIS : null;
  const last = new Map(), lastHash = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let r; try { r = JSON.parse(line); } catch { return untrusted('line ' + (i + 1) + ' is not JSON' + (i === lines.length - 1 && out.tornTail ? ' — the last record is incomplete (an append was interrupted mid-write)' : '')); }
    if (!r || typeof r !== 'object' || typeof r.rel !== 'string' || !JOURNAL_ACTIONS.has(r.action)) return untrusted('line ' + (i + 1) + ' is not an apply record');
    if (!Number.isInteger(r.seq) || r.seq !== i + 1) return untrusted('line ' + (i + 1) + ' has seq ' + JSON.stringify(r.seq) + ' (a gap, a reorder or an unbound record)');
    if (r.prev !== head) return untrusted('line ' + (i + 1) + ' does not chain to the previous record');
    if (typeof r.batch_id !== 'string' || !isSafeBatchId(r.batch_id)) return untrusted('line ' + (i + 1) + ' is not bound to a batch');
    if (batchId == null) batchId = r.batch_id;
    if (r.batch_id !== batchId) return untrusted('line ' + (i + 1) + ' belongs to batch ' + r.batch_id + ', not ' + batchId);
    if (!isPlainRel(r.rel) || isNeverTouch(r.rel)) return untrusted('line ' + (i + 1) + ' names a path a sync never writes (' + r.rel + ')');
    head = sha256Str(line);
    if (anchor && i + 1 === anchor.seq) headAtAnchor = head;
    last.set(r.rel, r.action);
    lastHash.set(r.rel, typeof r.hash === 'string' ? r.hash : null);
  }
  out.head = head; out.seq = lines.length; out.records = lines.length;
  if (anchor && opts.anchorPrefix) {
    if (lines.length < anchor.seq || headAtAnchor !== anchor.head) return untrusted('the journal no longer contains the head the manifest recorded (seq ' + anchor.seq + '; the file holds ' + lines.length + ' chained record(s)) — truncated or rewritten');
    out.beyondAnchor = lines.length - anchor.seq;
  } else if (anchor) {
    if (anchor.head !== head || anchor.seq !== lines.length) return untrusted('the journal does not end at the head the manifest recorded (seq ' + lines.length + ' vs ' + anchor.seq + ') — truncated or rewritten');
  }
  for (const [rel, action] of last) {
    if (action === 'skipped') out.skipped.add(rel);
    else if (action === 'intent-create') out.intent.add(rel);
    else if (action === 'created') { out.created.add(rel); out.createdHash.set(rel, lastHash.get(rel)); }
  }
  out.trusted = true;
  return out;
}
/** recordApplyJournalHead(backup, apply) — R4 / F02: after the apply, the journal's head (hash + seq) goes into the bound
 *  manifest (and its central mirror), so a later rollback can prove the journal complete. Best-effort on the mirror; the
 *  result says whether the mandatory copy took it. */
function recordApplyJournalHead(backup, apply) {
  if (!backup || !backup.backupDir || !apply || !apply.journal) return { recorded: false, reason: 'no journal to record' };
  const head = { head: apply.journal.head, seq: apply.journal.seq };
  if (backup.manifest && typeof backup.manifest === 'object') backup.manifest.apply_journal = head; // the in-run rollback verifies the head too
  let recorded = false, reason = null;
  for (const dir of [backup.backupDir, backup.centralDir]) {
    if (!dir) continue;
    try {
      const mPath = path.join(dir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      m.apply_journal = head;
      if (m.schema === BACKUP_MANIFEST_SCHEMA) writeBoundManifest(dir, m); else writeAtomic(mPath, JSON.stringify(m, null, 2) + '\n');
      if (dir === backup.backupDir) recorded = true;
    } catch (e) { if (dir === backup.backupDir) reason = e.message; }
  }
  return { recorded, reason, head };
}
/** journalHeadError(apply, headRec) -> null | reason. R6 / F17: an apply that kept a journal must have its head
 *  persisted in the MANDATORY (project-local) manifest before the batch may count as applied; recordApplyJournalHead's
 *  {recorded:false} is a failed batch in every caller, never ignored. */
function journalHeadError(apply, headRec) {
  if (!apply || !apply.journal) return null; // no journal kept (no journal dirs): nothing to anchor
  if (headRec && headRec.recorded) return null;
  return 'the apply journal head could not be recorded in the batch manifest (' + ((headRec && headRec.reason) || 'unknown reason') + ') — without it a later rollback cannot prove the journal complete, so this batch is not committed';
}

function projectId(projectDir) {
  const abs = path.resolve(projectDir);
  return path.basename(abs) + '-' + sha256Str(abs).slice(0, 8);
}

// ---- receipt (records what THIS tool last wrote, so drift can be told apart from a hand-edit) ----
function receiptPath(projectDir) { return path.join(claudeDirOf(projectDir), 'forge-sync-receipt.json'); }
function readReceipt(projectDir) { try { return JSON.parse(fs.readFileSync(receiptPath(projectDir), 'utf8')); } catch { return null; } }
function readRawReceipt(projectDir) { // B2: raw bytes (for byte-exact backup/restore, mirrors readVersionFile)
  try { return { exists: true, content: fs.readFileSync(receiptPath(projectDir), 'utf8') }; } catch { return { exists: false, content: null }; }
}
/** writeAtomic — temp file in the same directory + rename (broad Codex audit #22).
 *  The version stamp and the receipt were two separate in-place writes AFTER validation, outside any
 *  rollback protection: a crash or a full disk between them left an install whose files and version say
 *  "synced" while the receipt — the thing every later drift/rollback decision reads — was absent or
 *  half-written. Rename within one filesystem is atomic on both Windows and POSIX, so a reader sees
 *  either the whole previous file or the whole new one, never a torn one. */
function writeAtomic(file, contents) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}
function writeReceipt(projectDir, receipt) { writeAtomic(receiptPath(projectDir), JSON.stringify(receipt, null, 2) + '\n'); }
/** copyNoFollow — schrijf src-bytes naar out ZONDER ooit door een symlink/junction op de eindcomponent te
 *  kunnen schrijven (uitgesteld punt 3, gesloten 2026-08-06). fs.copyFileSync VOLGT links, en tussen de
 *  lstat-guard en de copy zat een TOCTOU-venster. Op Windows bestaat O_NOFOLLOW niet in Node (gemeten:
 *  fs.constants.O_NOFOLLOW === undefined), maar dit sluit het leaf-venster per constructie: de bytes gaan
 *  eerst naar een VERSE tempnaam in dezelfde directory, geopend met 'wx' (CREATE_NEW faalt op elke
 *  bestaande naam — ook een link, want de naam bestaat dan); daarna vervangt renameSync de eindcomponent
 *  ZELF in plaats van er doorheen te schrijven. Vlak voor de rename wordt de parent-directory nogmaals
 *  realpath-gecontroleerd tegen de containment-basis: een junction die intussen op een TUSSENliggende
 *  directory verscheen wordt zo ook gevangen (volledig sluiten van dat pad zou openat-semantiek vergen
 *  die Node niet biedt — dat restrisico blijft benoemd, niet verstopt). */
/** copyNoFollow (r4 #18): de containment-check kwam NA het vullen van de temp — was de parent
 *  al een junction naar buiten, dan stonden de bytes al buiten het project toen de check ze ontdekte (en
 *  een crash in dat venster liet ze daar staan). Nu: (1) resolve en verifieer de parent VOOR er ook maar
 *  een byte wordt geschreven; (2) schrijf temp en doel op basis van het GERESOLVEDE parent-realpath —
 *  een junction-swap na de check verlegt onze writes dan niet meer (wij houden het opgeloste pad vast);
 *  (3) her-verifieer na het stagen en rename dan. Het restvenster is daarmee gereduceerd tot een swap
 *  tussen de allereerste resolve en de open van de temp — en zelfs dan landen de bytes op het OUDE,
 *  geverifieerde echte pad, nooit door de nieuwe junction heen. */
function copyNoFollow(src, out, baseDir, opts) {
  opts = opts || {};
  const data = fs.readFileSync(src);
  let realParent = null, realBase = null;
  if (baseDir) {
    try { realParent = fs.realpathSync.native(path.dirname(out)); } catch (e) { throw new Error('containment pre-check failed for ' + out + ': ' + e.message); }
    try { realBase = fs.realpathSync.native(baseDir); } catch { realBase = path.resolve(baseDir); }
    if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) {
      throw new Error('containment guard tripped BEFORE staging: parent of ' + out + ' resolves outside ' + baseDir + ' — no bytes written');
    }
    // the same physical-parent + floor re-check as writeBytesNoFollow (for the ledger restores into the project)
    if (typeof opts.approvedRealParent === 'string' && foldCase(realParent) !== foldCase(opts.approvedRealParent)) {
      throw new Error('never-touch floor guard tripped BEFORE staging: the parent of ' + out + ' now resolves to ' + realParent + ', not ' + opts.approvedRealParent + ' where the floor was checked (a junction/symlink was swapped in) — no bytes written');
    }
    if (opts.floor) { const fp = realFloorProblem(baseDir, realBase, out, realParent); if (fp) throw new Error('never-touch floor guard tripped BEFORE staging: ' + fp + ' — no bytes written'); }
  }
  // schrijf via het geresolvede parent-pad: een junction-swap na de pre-check raakt onze writes niet meer
  const outReal = realParent ? path.join(realParent, path.basename(out)) : out;
  const tmp = outReal + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, data);
    fs.closeSync(fd); fd = null;
    if (baseDir) {
      // her-verificatie na het stagen (defense-in-depth): het opgeloste parent-pad moet nog steeds
      // hetzelfde echte pad zijn en binnen de basis liggen.
      let realParent2;
      try { realParent2 = fs.realpathSync.native(path.dirname(outReal)); } catch (e) { throw new Error('containment re-check failed for ' + out + ': ' + e.message); }
      if (realParent2 !== realParent) throw new Error('containment guard tripped at copy time: parent of ' + out + ' changed identity during staging');
    }
    fs.renameSync(tmp, outReal);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch { } }
    try { fs.unlinkSync(tmp); } catch { }
    throw e;
  }
}
/** receiptLastTemplateHashMap — B1: prefer the CUMULATIVE receipt.knownHashes (every system file's
 *  last-known-good hash, carried forward across every sync) over the old filesChanged-only map, which
 *  ERASED the baseline for any file that wasn't touched in the MOST RECENT sync (a same-since-last-sync file
 *  never appears in filesChanged, so its baseline vanished the moment any OTHER file changed — from the 3rd
 *  template version onward this falsely declared untouched files "drifted"). Falls back to the legacy
 *  filesChanged-derived map for a receipt written before this fix. */
function receiptLastTemplateHashMap(receipt) {
  if (receipt && receipt.knownHashes && typeof receipt.knownHashes === 'object') return Object.assign({}, receipt.knownHashes);
  const map = {};
  if (receipt && Array.isArray(receipt.filesChanged)) for (const f of receipt.filesChanged) if (f && f.rel) map[f.rel] = f.newHash;
  return map;
}

// ---- WP-SYNC-R7 item 1 (26H2 rehearsal): "every hash this path ever had in the template" ---------------------
// A file the template starts shipping (FORGE_SKILL_REGISTRY.md, HOOKS_OPT_IN.md in the rehearsal) can already sit in a
// project, byte-identical to an EARLIER template/development version, with no baseline in the old receipt (it was never
// shipped before). preflight called that "unknown drift" and the whole install blocked on two untouched Forge files. Before
// declaring drift or a conflict, preflight now asks this matcher whether the project's bytes equal ANY version that path has
// had: (1) the template's own publish record (template-publish-receipt.json: `files` of the last publish + the cumulative
// `history` publish-template keeps per path), or (2) the git history of a Forge DEVELOPMENT tree (a folder carrying
// config/forge-dev-tree.json — the one recorded as the publisher in that receipt, the template folder itself when it is a
// dev tree, and whatever the caller adds; the CLI adds the dev tree its own forge-sync.cjs lives in), checked exactly like
// proveTemplateOrphan (`git hash-object` with and without filters vs `git log --all --raw`). A match is an UNMODIFIED Forge
// copy, synced like any update (overrideClass 'template_history', with where it matched). No match -> drift/conflict exactly
// as before. Read-only; git work is bounded (TEMPLATE_HISTORY_GIT_MAX checks per preflight) and only runs for candidates
// that would otherwise be drift or a conflict.
const TEMPLATE_HISTORY_MAX_PER_PATH = 64;
const TEMPLATE_HISTORY_GIT_MAX = 200;
/** readTemplatePublishHistory(templateDir) -> {map: Map(normKey(rel) -> Set(sha256)), devDir} | null — the last publish's
 *  `files` plus the cumulative `history` of template-publish-receipt.json; anything malformed is ignored, never trusted. */
function readTemplatePublishHistory(templateDir) {
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(templateDir, TEMPLATE_PUBLISH_RECEIPT_NAME), 'utf8')); } catch { return null; }
  if (!r || typeof r !== 'object' || r.schema !== PUBLISH_RECEIPT_SCHEMA) return null;
  const map = new Map();
  const add = (rel, h) => {
    if (!isPlainRel(rel) || typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return;
    const k = normKey(rel);
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(h);
  };
  if (r.files && typeof r.files === 'object') for (const [k, v] of Object.entries(r.files)) add(k, v);
  if (r.history && typeof r.history === 'object' && !Array.isArray(r.history)) for (const [k, v] of Object.entries(r.history)) if (Array.isArray(v)) v.forEach((h) => add(k, h));
  return { map, devDir: typeof r.devDir === 'string' && r.devDir ? r.devDir : null };
}
/** devTreeGitContext(devDir) -> {available:true, devDir, top} | null — only a plain folder that carries the development-tree
 *  marker (config/forge-dev-tree.json {dev_tree:true}) inside a git work tree; real paths, as git prints them. */
function devTreeGitContext(devDirIn) {
  if (!devDirIn || typeof devDirIn !== 'string') return null;
  const devDir = path.resolve(devDirIn);
  if (!isDirectory(devDir) || isSymlinkPath(devDir) || !readDevTreeMarker(devDir)) return null;
  const real = realpathViaExistingAncestor(devDir);
  const top = gitIn(real, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.out.trim()) return null;
  return { available: true, devDir: real, top: realpathViaExistingAncestor(path.resolve(top.out.trim())) };
}
/** templateHistoryMatcher(templateDir, opts) -> match(rel, absOut, outHash) -> null | {by:'publish-history'|'dev-git-history',
 *  source}. Lazy (nothing is read before the first candidate). opts.templateHistory: false disables it; {devDirs:[...]} adds
 *  development trees to consult; {git:false} uses the publish record only. */
function templateHistoryMatcher(templateDir, opts) {
  const cfg = opts ? opts.templateHistory : undefined;
  if (cfg === false) return () => null;
  const o = cfg && typeof cfg === 'object' ? cfg : {};
  let state = null;
  let gitBudget = TEMPLATE_HISTORY_GIT_MAX;
  const setup = () => {
    if (state) return state;
    const pub = readTemplatePublishHistory(templateDir);
    const gits = [];
    if (o.git !== false) {
      const seen = new Set();
      for (const d of [].concat(Array.isArray(o.devDirs) ? o.devDirs : [], pub && pub.devDir ? [pub.devDir] : [], [templateDir])) {
        const ctx = devTreeGitContext(d);
        if (!ctx || seen.has(foldCase(ctx.devDir))) continue;
        seen.add(foldCase(ctx.devDir));
        gits.push(ctx);
      }
    }
    state = { pub, gits };
    return state;
  };
  return (rel, absOut, outHash) => {
    if (typeof outHash !== 'string' || !outHash) return null;
    const s = setup();
    const known = s.pub && s.pub.map.get(normKey(rel));
    if (known && known.has(outHash)) return { by: 'publish-history', source: TEMPLATE_PUBLISH_RECEIPT_NAME };
    for (const g of s.gits) {
      if (gitBudget <= 0) return null;
      gitBudget--;
      if (proveTemplateOrphan(rel, absOut, outHash, null, g).proven) return { by: 'dev-git-history', source: g.devDir };
    }
    return null;
  };
}

/** pruneRetiredFiles(projectDir, opts) -> {removable, kept, removed, failed, applied}.
 *  Classification is ALWAYS computed (removable/kept), even in preview mode — so `status`/`--dry-run`
 *  can honestly report what would happen. A real removal additionally needs opts.batchId != null AND
 *  opts.dryRun falsy AND opts.write !== false; without a batchId this stays preview-only (never deletes
 *  without somewhere to back the bytes up to first).
 *
 *  Backup: every real removal is backed up to <project>/.claude/forge-backups/<batchId>/retired-prune/<rel>
 *  BEFORE the live file is deleted — the SAME per-project backup root every other change in this batch
 *  already uses (backupDirFor), just namespaced under its own subfolder so this never collides with or
 *  needs to be understood by the main manifest.json's toChange-shaped entries (resume-batch/central-mirror/
 *  divergence-check logic is untouched by this — see the header doc's module API list for what those cover).
 *  A separate, deliberately SIMPLE ledger (retired-prune-manifest.json, LOCAL backup dir only — never
 *  mirrored centrally) records exactly what was removed so `rollback` can restore it; see rollbackProject's
 *  own best-effort restore step for that half.
 *
 *  hardening (independent Codex adversarial review):
 *   - a RETIRED_STATE_FILES entry is only classified removable when RETIRED_SERVER_FILE_REL is NOT
 *     itself being kept (a kept, owner-modified server.cjs may still depend on that state) — see the
 *     `serverKept` gate below. Every state file actually removed is now ALSO written to the ledger (no
 *     longer excluded), so rollback can restore it like any other pruned file.
 *   - opts.batchId is validated (isSafeBatchId) and the resolved backup directory is checked for
 *     symlink/junction + containment (retiredPruneDirsFor) BEFORE anything is written or deleted, and each
 *     backup is written via copyNoFollow (no-follow + containment-checked, not a bare fs.copyFileSync) and
 *     re-verified by hash immediately before the matching original is deleted — a hostile --batch-id (e.g.
 *     path traversal) or a pre-planted symlinked/junctioned backup dir now refuses the whole operation
 *     instead of silently backing up outside the project while still deleting the original in place. */
function pruneRetiredFiles(projectDir, opts) {
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  const receipt = readReceipt(projectDir);
  const lastTemplateHash = receiptLastTemplateHashMap(receipt);
  const removable = [], kept = [];
  for (const rel of RETIRED_TEMPLATE_FILES) {
    const out = safeJoin(dst, rel);
    if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) continue; // same guards as every other write path — never touch anything outside .claude/
    if (!fs.existsSync(out)) continue; // already gone — the healthy state, nothing to report
    const outStatus = fileStatus(out);
    if (outStatus.kind === 'unreadable') { kept.push({ rel, reason: 'unreadable: ' + outStatus.error }); continue; }
    const outHash = outStatus.kind === 'ok' ? outStatus.hash : null;
    if (!Object.prototype.hasOwnProperty.call(lastTemplateHash, rel)) {
      kept.push({ rel, reason: 'no last-shipped hash on record for this file — cannot verify it is unmodified, left in place' });
      continue;
    }
    if (outHash !== lastTemplateHash[rel]) { kept.push({ rel, reason: 'modified since the last sync — kept, not deleted' }); continue; }
    removable.push({ rel, oldHash: outHash, generatedState: false });
  }
  // a state file is only safe to remove when the ONE retired file that actually reads/writes
  // it (server.cjs) is not itself being kept — a kept, owner-modified server.cjs may still depend on it.
  const serverKept = kept.some((k) => k.rel === RETIRED_SERVER_FILE_REL);
  for (const rel of RETIRED_STATE_FILES) {
    const out = safeJoin(dst, rel);
    if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) continue;
    if (!fs.existsSync(out)) continue;
    const outStatus = fileStatus(out);
    if (outStatus.kind === 'unreadable') { kept.push({ rel, reason: 'unreadable: ' + outStatus.error }); continue; }
    if (serverKept) {
      kept.push({ rel, reason: 'the retired server.cjs that reads/writes this file is still present (kept, modified since last sync) — may still be in use, kept alongside it' });
      continue;
    }
    removable.push({ rel, oldHash: outStatus.kind === 'ok' ? outStatus.hash : null, generatedState: true });
  }
  if (!removable.length || opts.dryRun || opts.write === false) return { removable, kept, removed: [], failed: [], applied: false };
  if (!opts.batchId) return { removable, kept, removed: [], failed: [], applied: false, error: 'batchId required to actually remove files (none given — treated as preview-only)' };
  const dirs = retiredPruneDirsFor(projectDir, opts.batchId); // /SYNC-4
  if (!dirs.ok) return { removable, kept, removed: [], failed: [], applied: false, error: dirs.reason };
  const { bdir, pruneDir } = dirs;
  const removed = [], failed = [];
  try { ensureRealDir(dst, pruneDir); } // R3 / SYNC-01
  catch (e) { return { removable, kept, removed: [], failed: [], applied: false, error: 'could not create the retired-file backup dir: ' + e.message }; }
  for (const entry of removable) {
    const out = safeJoin(dst, entry.rel);
    try {
      const rt = realTargetCheck(dst, out); if (rt.problem) throw new Error('refused by the real-path floor: ' + rt.problem); // R4 / F06
      if (entry.oldHash !== null) {
        const backupTarget = path.join(pruneDir, ...entry.rel.split('/'));
        ensureRealDir(pruneDir, path.dirname(backupTarget)); // R3 / SYNC-01
        copyNoFollow(out, backupTarget, pruneDir); // no-follow + containment-checked write, not a bare fs.copyFileSync
        if (sha256(backupTarget) !== entry.oldHash) throw new Error('backup for ' + entry.rel + ' could not be verified after writing — refusing to delete the original'); // never delete without a verified-correct backup in hand
        // move aside, re-hash what moved; bytes that changed since the backup are put back, never deleted
        const q = quarantineAndVerify(out, entry.oldHash, rt.realParent); // only while the parent is the checked one
        if (!q.removed) { kept.push({ rel: entry.rel, reason: 'changed-since-plan: ' + q.reason }); continue; }
      } else fs.rmSync(out, { force: true });
      if (fs.existsSync(out)) throw new Error('file still present after delete attempt'); // H1-style post-step verification
      removed.push(entry.rel);
    } catch (e) { failed.push({ rel: entry.rel, reason: e.message }); }
  }
  const ledgerEntries = removed
    .map((rel) => removable.find((r) => r.rel === rel))
    .filter((e) => e && e.oldHash !== null) // state files are ledgered too now (no longer excluded)
    .map((e) => ({ rel: e.rel, oldHash: e.oldHash }));
  if (ledgerEntries.length) {
    try {
      writeAtomic(path.join(bdir, RETIRED_PRUNE_MANIFEST_NAME), JSON.stringify({ batchId: opts.batchId, projectPath: path.resolve(projectDir), files: ledgerEntries }, null, 2) + '\n');
    } catch (e) {
      failed.push({ rel: '(retired-prune ledger)', reason: 'file(s) removed but the rollback ledger could not be written: ' + e.message });
    }
  }
  return { removable, kept, removed, failed, applied: true, backupDir: pruneDir };
}

// ---- orphans — files forge-sync once shipped that the template no longer ships ----------------
/** findOrphans(projectDir, shipped) -> {unmodified:[{rel, hash}], modified:[{rel, reason}]}. READ-ONLY.
 *  shipped = {system: Set|Array, seed: Set|Array} of the CURRENT template. A candidate is every path in the
 *  receipt's knownHashes (what forge-sync shipped before) that the template no longer ships, minus the seed-only
 *  files, the never-touch floor and the two named retired-dashboard lists (pruneRetiredFiles owns those).
 *  HASH-GATED: `unmodified` only when the on-disk bytes still equal the hash forge-sync last shipped; anything
 *  else (edited since, unreadable, a symlink or a path outside .claude) is `modified` and is never retired. */
function findOrphans(projectDir, shipped) {
  const asSet = (x) => (x instanceof Set ? x : new Set(x || []));
  const system = asSet(shipped && shipped.system);
  const seed = asSet(shipped && shipped.seed);
  const retiredNamed = new Set(RETIRED_TEMPLATE_FILES.concat(RETIRED_STATE_FILES));
  const known = receiptLastTemplateHashMap(readReceipt(projectDir));
  const dst = claudeDirOf(projectDir);
  const unmodified = [], modified = [];
  for (const rel of Object.keys(known).sort()) {
    if (system.has(rel) || seed.has(rel) || retiredNamed.has(rel) || isNeverTouch(rel)) continue;
    const out = safeJoin(dst, rel);
    if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) { modified.push({ rel, reason: 'resolves through a symlink or outside .claude — never touched' }); continue; }
    const st = fileStatus(out);
    if (st.kind === 'missing') continue; // already gone — nothing to report
    if (st.kind === 'unreadable') { modified.push({ rel, reason: 'unreadable (' + st.error + ') — kept' }); continue; }
    if (typeof known[rel] === 'string' && st.hash === known[rel]) unmodified.push({ rel, hash: st.hash });
    else modified.push({ rel, reason: 'changed since forge-sync last shipped it — kept' });
  }
  return { unmodified, modified };
}
/** retiredOrphansDirsFor — same batch-id allow-list + symlink/containment gate as retiredPruneDirsFor. */
function retiredOrphansDirsFor(projectDir, batchId) {
  if (!isSafeBatchId(batchId)) return { ok: false, reason: unsafeBatchIdReason(batchId) || 'a batch id is required to retire orphans' };
  const dst = claudeDirOf(projectDir);
  const bdir = backupDirFor(projectDir, batchId);
  const orphanDir = path.join(bdir, RETIRED_ORPHANS_SUBDIR);
  let chain;
  try { assertClaudeBaseContained(projectDir); chain = realDirChain(dst, orphanDir, { create: false }); } catch (e) { chain = { ok: false }; }
  if (!chain.ok || isSymlinkPath(bdir) || isSymlinkPath(orphanDir) || !containmentSafe(dst, orphanDir)) { // the whole chain
    return { ok: false, reason: 'the orphan backup folder for batch ' + batchId + ' is a symlink/junction or resolves outside the project (' + orphanDir + ') — refusing' };
  }
  return { ok: true, dst, bdir, orphanDir };
}
/** retireOrphans(projectDir, report, opts) -> {moved[], failed[], applied, backupDir?, error?}. OPT-IN only
 *  (`--retire-orphans`). MOVES each `unmodified` orphan into <project>/.claude/forge-backups/<batch>/retired-orphans/
 *  <rel>: copy (no-follow, containment-checked), verify the copy's hash, record it in the ledger, and only then
 *  remove the original — so the bytes always exist in exactly one verified place and `rollback --batch <id>` can
 *  put them back (restoreRetiredOrphansLedger). It never deletes anything that was not first copied and verified,
 *  and never touches a `modified` orphan. The hash is re-checked right before the move (it may have changed since
 *  the report). */
function retireOrphans(projectDir, report, opts) {
  opts = opts || {};
  const candidates = (report && report.unmodified) || [];
  if (!candidates.length) return { moved: [], failed: [], applied: false };
  const dirs = retiredOrphansDirsFor(projectDir, opts.batchId);
  if (!dirs.ok) return { moved: [], failed: [], applied: false, error: dirs.reason };
  const { dst, bdir, orphanDir } = dirs;
  try { ensureRealDir(dst, orphanDir); } // R3 / SYNC-01
  catch (e) { return { moved: [], failed: [], applied: false, error: 'could not create the orphan backup folder: ' + e.message }; }
  const ledgerPath = path.join(bdir, RETIRED_ORPHANS_MANIFEST_NAME);
  let ledgerFiles = [];
  try { const prior = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); if (prior && Array.isArray(prior.files)) ledgerFiles = prior.files.slice(); } catch { /* first retire in this batch */ }
  const writeLedger = () => writeAtomic(ledgerPath, JSON.stringify({ batchId: opts.batchId, projectPath: path.resolve(projectDir), files: ledgerFiles }, null, 2) + '\n');
  const testHooksEnabled = process.env.FORGE_SYNC_TEST_HOOKS === '1'; // same gate as the M11 rollback hook
  const moved = [], failed = [], kept = [];
  for (const c of candidates) {
    const out = safeJoin(dst, c.rel);
    try {
      if (isNeverTouch(c.rel) || out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) throw new Error('not a retirable path — refused');
      const rt = realTargetCheck(dst, out); if (rt.problem) throw new Error('refused by the real-path floor: ' + rt.problem); // R4 / F06
      if (sha256(out) !== c.hash) { kept.push({ rel: c.rel, reason: 'changed-since-plan: changed since the orphan report — kept' }); continue; }
      const backupTarget = path.join(orphanDir, ...c.rel.split('/'));
      ensureRealDir(orphanDir, path.dirname(backupTarget));
      copyNoFollow(out, backupTarget, orphanDir);
      if (sha256(backupTarget) !== c.hash) throw new Error('the backup copy could not be verified — original kept');
      ledgerFiles = ledgerFiles.filter((f) => f.rel !== c.rel).concat([{ rel: c.rel, oldHash: c.hash }]);
      writeLedger(); // the ledger names the file BEFORE the original goes, so rollback can always find it
      if (testHooksEnabled && typeof opts.__beforeRemove === 'function') opts.__beforeRemove(c.rel, out); // test seam: a write in the race window
      // the live file is moved aside and the MOVED bytes re-hashed right before removal. If they no longer
      // equal the hash just verified in the backup, someone changed the file in between: it is put back (never deleted),
      // reported as changed-since-plan, and taken out of the ledger again.
      const q = quarantineAndVerify(out, c.hash, rt.realParent); // only while the parent is the checked one
      if (!q.removed) {
        ledgerFiles = ledgerFiles.filter((f) => f.rel !== c.rel);
        writeLedger();
        kept.push({ rel: c.rel, reason: 'changed-since-plan: ' + q.reason });
        continue;
      }
      if (fs.existsSync(out)) throw new Error('still present after the move');
      moved.push(c.rel);
    } catch (e) { failed.push({ rel: c.rel, reason: e.message }); }
  }
  return { moved, failed, kept, applied: true, backupDir: orphanDir };
}
/** restoreRetiredOrphansLedger(projectDir, batchId) -> {ok, restored[], failed[], conflicts[], skipped?, error?}.
 *  The rollback half of retireOrphans. The ledger is untrusted input: its batchId/projectPath must match, every
 *  entry must be a plain .claude-relative path outside the never-touch floor, its backup must sit inside the
 *  orphan backup folder and hash-match. A destination that exists again is restored only when byte-identical
 *  (an earlier restore) — anything else is a conflict, kept and reported, never overwritten. No ledger = a silent,
 *  honest no-op (`skipped`). */
function restoreRetiredOrphansLedger(projectDir, batchId) {
  const dirs = retiredOrphansDirsFor(projectDir, batchId);
  if (!dirs.ok) return { ok: false, restored: [], failed: [], conflicts: [], error: dirs.reason };
  const { dst, bdir, orphanDir } = dirs;
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(path.join(bdir, RETIRED_ORPHANS_MANIFEST_NAME), 'utf8')); }
  catch (e) { return { ok: true, restored: [], failed: [], conflicts: [], skipped: e && e.code === 'ENOENT' ? 'no orphans were retired in this batch' : ('orphan ledger unreadable: ' + e.message) }; }
  if (!ledger || !Array.isArray(ledger.files) || !ledger.files.length) return { ok: true, restored: [], failed: [], conflicts: [], skipped: 'empty orphan ledger' };
  if (ledger.batchId !== batchId || ledger.projectPath !== path.resolve(projectDir)) {
    return { ok: false, restored: [], failed: [{ rel: '(orphan ledger)', reason: 'ledger batchId/projectPath do not match this batch/project — refusing to trust it' }], conflicts: [] };
  }
  const restored = [], failed = [], conflicts = [];
  for (const f of ledger.files) {
    if (!f || typeof f.rel !== 'string' || typeof f.oldHash !== 'string' || isNeverTouch(f.rel)) { failed.push({ rel: (f && f.rel) || '(entry)', reason: 'malformed or never-touch ledger entry — ignored' }); continue; }
    const out = safeJoin(dst, f.rel);
    const backupSrc = path.join(orphanDir, ...f.rel.split('/'));
    try {
      if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) throw new Error('containment guard tripped');
      const rt = realTargetCheck(dst, out); if (rt.problem) throw new Error('refused by the real-path floor: ' + rt.problem); // R4 / F06
      if (!containmentSafe(orphanDir, backupSrc) || sha256(backupSrc) !== f.oldHash) throw new Error('backup payload missing, outside the orphan folder, or hash mismatch — refusing to restore unverified content');
      if (fs.existsSync(out)) {
        if (sha256(out) === f.oldHash) { restored.push(f.rel); continue; }
        conflicts.push({ rel: f.rel, reason: 'a different file exists at this path again — not overwritten' });
        continue;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      copyNoFollow(backupSrc, out, dst, { approvedRealParent: rt.realParent, floor: true }); // R6 / F15
      if (sha256(out) !== f.oldHash) throw new Error('hash mismatch after restore');
      restored.push(f.rel);
    } catch (e) { failed.push({ rel: f.rel, reason: e.message }); }
  }
  return { ok: failed.length === 0 && conflicts.length === 0, restored, failed, conflicts };
}

// ---- project-declared "I own this file on purpose" allow-list ----
function overridesAllowlistPath(projectDir) { return path.join(claudeDirOf(projectDir), 'config', 'forge-overrides.json'); }
/** readOverrideAllowlist(projectDir) -> Set of normKey()ed override paths. R4 / F13: an override entry is matched the way the
 *  file system matches names — `FORGE-BIN/Tool.cjs` IS forge-bin/tool.cjs on Windows and macOS — so every comparison goes
 *  through normKey (callers compare normKey(rel)). An entry that normalises to a never-touch path is REFUSED (dropped and
 *  listed on the returned set as `.refused`): the floor can never be relaxed by declaring memory or key material an override. */
function readOverrideAllowlist(projectDir) {
  const out = new Set();
  out.refused = [];
  let list = [];
  try { const obj = JSON.parse(fs.readFileSync(overridesAllowlistPath(projectDir), 'utf8')); list = Array.isArray(obj.overrides) ? obj.overrides : []; }
  catch { return out; }
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) { out.refused.push({ entry: raw, reason: 'not a path' }); continue; }
    const k = normKey(raw.trim());
    if (!isPlainRel(k) || isNeverTouch(k)) { out.refused.push({ entry: raw, reason: 'normalises to a never-touch or non-plain path — an override can never lower the floor' }); continue; }
    out.add(k);
  }
  return out;
}

// ---- v2.7-era owner-standing-rule preflight migration (external-audit 3.4, LOW) ----
const STANDING_RULES_REL = 'config/orchestration/FORGE_STANDING_RULES.json';
const STANDING_RULES_USER_REL = 'config/orchestration/FORGE_STANDING_RULES.user.json';
const STANDING_OWNER_REMEMBER_SOURCE = 'owner /forge remember';

/** migrateOwnerStandingRules(projectDir) — 3.4 fix: before 's template/user split
 *  (forge-standing.cjs, N4/P1), an owner "/forge remember" wrote its new rule straight into the SYSTEM
 *  (template-synced) FORGE_STANDING_RULES.json. That file is compared/replaced on every install/sync-all —
 *  including a --force-overwrite of an unresolved conflict — so upgrading a v2.7-era project either (a)
 *  looks unchanged-since-last-receipt and gets silently overwritten by the new, rule-free template, or (b)
 *  looks like drift/conflict and gets replaced the moment --force-overwrite runs, in both cases BEFORE
 *  forge-standing.cjs's own load()-time migration ever gets a chance to run against the old content. This
 *  runs as a preflight step, called at the very top of every real write path (safeSyncProject, rawInstall)
 *  BEFORE that file is ever compared or replaced: it reads the project's CURRENT on-disk copy, and MOVES
 *  (never duplicates — checked by id) every rule whose source is exactly STANDING_OWNER_REMEMBER_SOURCE
 *  into that project's own FORGE_STANDING_RULES.user.json — a file this SYSTEM list deliberately never
 *  syncs/overwrites (see the comment next to 'FORGE_STANDING_RULES.json' in SYSTEM above). It never rewrites
 *  the template copy itself here (the imminent sync/replace does that; forge-standing.cjs's own load()-time
 *  migration cleans up a leftover copy on any run that does not proceed to replace it) — no duplication risk
 *  either way, since re-migration is id-checked. Best-effort and silently a no-op when the project has no
 *  such file yet, the file is unreadable/malformed, or there is nothing to migrate — this is a safety net
 *  for an old install shape, never a hard requirement for a project that never had the file. Returns the
 *  migrated rule ids (possibly empty) so a caller can log/report it. */
/** N8 fix (2026-09-26 independent review, LOW) — before this fix, ANY user-file read/parse/shape problem
 *  (not just "the file does not exist yet") fell into the same `catch { userDoc = { version: 1, rules: [] } }`
 *  as a genuinely fresh install, so a MALFORMED-but-PRESENT FORGE_STANDING_RULES.user.json (bad JSON, no
 *  "rules" array) got silently REPLACED with just the migrated rules — no backup, the owner's existing
 *  (if broken) content gone — exactly the case forge-standing.cjs's own load()-time migration deliberately
 *  refuses to touch. This starts from an empty doc ONLY on a confirmed ENOENT; any OTHER read/parse/shape
 *  failure now warns ONCE and skips the migration entirely (nothing written, template copy left as-is —
 *  it gets another chance on a later sync once the owner fixes or removes the file). The write itself now
 *  goes through the same safeJoin/isSymlinkPath/containmentSafe guards every other forge-sync write uses,
 *  and forge-sync's own writeAtomic() instead of a plain writeFileSync — this file is written outside the
 *  normal preflight/apply pipeline (it runs BEFORE that pipeline, see the doc comment above), so it never
 *  inherited those guards for free. A `null`/non-object entry in either rules array is skipped when
 *  computing ids instead of throwing (`r.id` on `null` used to crash the whole sync); it is left in place,
 *  untouched, in whatever gets written — never silently dropped.
 *
 *  F4 fix (2026-09-26 independent review, LOW): every early-return below used to be a bare `[]`, so a
 *  caller could not tell "nothing to migrate" apart from "there IS an owner rule, but this pass could not
 *  move it (unreadable/malformed/refused user file, or a write failure)" — under --force-overwrite (or the
 *  rawInstall/--unsafe path, which has no drift/conflict analysis at all), the caller went ahead and
 *  replaced the template file anyway, permanently dropping the never-migrated owner rule. The returned
 *  array's CONTENTS are unchanged (still `[]` on every failure path, for exact backward compatibility with
 *  every existing caller/test that only reads `.length`/`.includes(...)`); a non-enumerable-looking but
 *  perfectly normal own property, `.pending`, is attached to that same array — `true` whenever the template
 *  holds an owner rule that this call did NOT confirm is now safely represented in the user file, `false`
 *  otherwise (including "nothing to migrate" and "already migrated"). Callers (safeSyncProject, rawInstall)
 *  check `.pending` and skip replacing FORGE_STANDING_RULES.json for this pass when it is true. */
/** R6(a) fix (2026-09-26 independent review, LOW) — `opts.dryRun` (default false): every READ-only guard
 *  check below (parse the template, parse/shape-check the user file, safeJoin/isSymlinkPath/
 *  containmentSafe) runs identically in dry-run mode, so `.pending` is computed the SAME way a real run
 *  would — before this fix, callers passed `opts.dryRun ? [] : migrateOwnerStandingRules(projectDir)`,
 *  which skipped this function entirely in dry-run (a bare `[]` has no `.pending` at all), so a dry-run
 *  preview showed FORGE_STANDING_RULES.json as replaced even when a real run would have skipped it (an
 *  unmigratable owner rule). Only the final WRITE (mkdirSync + writeAtomic) is skipped in dry-run — never
 *  even the directory creation — so dry-run stays a true zero-write operation; the happy-path result
 *  (`.pending: false`) is reported as if the write had succeeded, exactly matching what a real run does
 *  once every guard above it already passed. */
function migrateOwnerStandingRules(projectDir, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const dst = claudeDirOf(projectDir);
  const templatePath = path.join(dst, STANDING_RULES_REL);
  const userPath = path.join(dst, STANDING_RULES_USER_REL);
  const done = (ids, pending) => { ids.pending = !!pending; return ids; };

  let templateDoc;
  try { templateDoc = JSON.parse(fs.readFileSync(templatePath, 'utf8')); }
  catch { return done([], false); } // no file yet, or unreadable/corrupt — nothing this safety net can act on
  if (!templateDoc || !Array.isArray(templateDoc.rules)) return done([], false);

  const toMigrate = templateDoc.rules.filter((r) => r && typeof r === 'object' && r.source === STANDING_OWNER_REMEMBER_SOURCE);
  if (toMigrate.length === 0) return done([], false);

  let userDoc;
  let userRaw;
  try {
    userRaw = fs.readFileSync(userPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      userDoc = { version: 1, rules: [] }; // genuinely fresh — no owner file yet, safe to start empty
    } else {
      // R6(c) fix (2026-09-26 independent review, NOTE): "fix or remove that file" is risky advice — the
      // file may hold the owner's OWN rules, and "remove" reads as "delete it" (which throws those rules
      // away). Say to fix the JSON (offering a copy as a safety net first), never to delete it.
      console.error('forge-sync: WARNING — could not read ' + userPath + ' while migrating owner rule(s) out of ' +
        templatePath + ' (' + e.message + '); skipping this migration pass, nothing written — fix that file\'s ' +
        'JSON (make a copy first if you want a safety net) to let it complete on a later sync; never delete it, ' +
        'it may hold your own rules');
      return done([], true);
    }
  }
  if (userRaw !== undefined) {
    try {
      userDoc = JSON.parse(userRaw);
    } catch (e) {
      console.error('forge-sync: WARNING — ' + userPath + ' is not valid JSON; skipping this migration pass, ' +
        'nothing written (' + e.message + ')');
      return done([], true);
    }
    if (!userDoc || typeof userDoc !== 'object' || !Array.isArray(userDoc.rules)) {
      console.error('forge-sync: WARNING — ' + userPath + ' is present but missing a "rules" array; skipping ' +
        'this migration pass, nothing written — the existing (malformed) file is left exactly as-is');
      return done([], true);
    }
  }

  const existingIds = new Set(userDoc.rules.filter((r) => r && typeof r === 'object').map((r) => r.id));
  const toAppend = toMigrate.filter((r) => !existingIds.has(r.id));
  const migratedIds = toMigrate.map((r) => r.id);
  if (toAppend.length === 0) return done(migratedIds, false); // already migrated on an earlier pass — nothing new to write

  const nextUserDoc = Object.assign({}, userDoc, { rules: userDoc.rules.concat(toAppend) });

  const safeUserPath = safeJoin(dst, STANDING_RULES_USER_REL);
  if (safeUserPath == null || path.resolve(safeUserPath) !== path.resolve(userPath)) {
    console.error('forge-sync: WARNING — refusing to migrate owner rule(s): ' + userPath + ' does not resolve to a safe path under .claude/');
    return done([], true);
  }
  if (isSymlinkPath(userPath)) {
    console.error('forge-sync: WARNING — refusing to migrate owner rule(s): ' + userPath + ' is a symlink');
    return done([], true);
  }
  if (!containmentSafe(dst, userPath)) {
    console.error('forge-sync: WARNING — refusing to migrate owner rule(s): ' + userPath + ' escapes .claude/ via a symlinked/junctioned ancestor directory');
    return done([], true);
  }

  // R6(a): every guard above this point is a read-only check — dry-run stops HERE, before the directory
  // is even created, and reports the same non-pending outcome a real run's happy path would reach.
  if (dryRun) return done(migratedIds, false);

  try {
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    writeAtomic(userPath, JSON.stringify(nextUserDoc, null, 2) + '\n');
  } catch (e) {
    // Best-effort, same posture as forge-standing.cjs's own migration: a write failure here never blocks
    // the sync — the owner rule simply stays visible in the (about to be replaced) template copy for this
    // pass, and gets another migration chance on a later sync or the next forge-standing.cjs load().
    console.error('forge-sync: could not write ' + userPath + ' while migrating owner rule(s) out of ' + templatePath + ' (' + e.message + ') — continuing sync');
    return done([], true);
  }
  return done(migratedIds, false);
}

// ---- pre-split Scout verdict migration ----
const SCOUT_VETTING_REL = 'config/orchestration/FORGE_SCOUT_VETTING.json';
const SCOUT_VETTING_USER_REL = 'config/orchestration/FORGE_SCOUT_VETTING.user.json';
const SCOUT_VERDICTS = new Set(['approve', 'hard-pass']);
/** migrateScoutVerdicts(templateDir, projectDir, opts) -> moved verdict list (with `.pending`), same contract as
 *  migrateOwnerStandingRules. Before the 2026-09-26 template/user split (forge-scout.cjs) Scout's record()
 *  appended the project's OWN verdicts to the SHIPPED FORGE_SCOUT_VETTING.json — which this sync replaces. Runs
 *  before that file is compared or replaced (every real write path, dry-run included as a zero-write preview):
 *   - the project's copy still equals the hash forge-sync last shipped -> it holds template verdicts only: no-op;
 *   - otherwise every VALID entry (capability + approve|hard-pass + reason, exactly forge-scout's own ledger
 *     validation) that is not in the NEW template ledger is appended to FORGE_SCOUT_VETTING.user.json — never
 *     duplicated (keyed on capability/verdict/reason/source/ts), and the user file is never rewritten when nothing
 *     is new. forge-scout.cjs already merges template + user ledgers, so the verdicts stay effective;
 *   - `.pending` = true (the caller then keeps FORGE_SCOUT_VETTING.json untouched this pass, under every flag) when
 *     the user file is unreadable/malformed, a write fails, or the project copy holds an INVALID non-template entry
 *     (it cannot be moved, and replacing the file would drop it).
 *  Known limit, stated: a verdict an OLD template shipped and the new template corrected in place is migrated too
 *  when the project copy is otherwise drifted — it then shows up (visibly) in the project's own user ledger. */
function migrateScoutVerdicts(templateDir, projectDir, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const dst = claudeDirOf(projectDir);
  const projPath = path.join(dst, ...SCOUT_VETTING_REL.split('/'));
  const userPath = path.join(dst, ...SCOUT_VETTING_USER_REL.split('/'));
  const done = (moved, pending) => { moved.pending = !!pending; return moved; };
  let projRaw;
  try { projRaw = fs.readFileSync(projPath); } catch { return done([], false); } // no project copy yet
  const known = receiptLastTemplateHashMap(readReceipt(projectDir));
  if (known[SCOUT_VETTING_REL] === crypto.createHash('sha256').update(projRaw).digest('hex')) return done([], false);
  let projDoc;
  try { projDoc = JSON.parse(projRaw.toString('utf8').replace(/^﻿/, '')); } catch { return done([], false); } // unreadable: the drift gate keeps it
  if (!projDoc || !Array.isArray(projDoc.entries)) return done([], false);
  let tplEntries = [];
  try { const t = JSON.parse(fs.readFileSync(path.join(templateDir, ...SCOUT_VETTING_REL.split('/')), 'utf8')); if (t && Array.isArray(t.entries)) tplEntries = t.entries; } catch { /* no template ledger: every project entry is the project's own */ }
  const isObj = (e) => !!e && typeof e === 'object' && !Array.isArray(e);
  const key = (e) => JSON.stringify([String(e.capability).trim().toLowerCase(), e.verdict, e.reason, e.source == null ? null : e.source, e.ts == null ? null : e.ts]);
  const valid = (e) => isObj(e) && typeof e.capability === 'string' && !!e.capability.trim() && SCOUT_VERDICTS.has(e.verdict) && typeof e.reason === 'string' && !!e.reason.trim();
  const tplKeys = new Set(tplEntries.filter(isObj).map(key));
  const own = projDoc.entries.filter((e) => !(isObj(e) && tplKeys.has(key(e))));
  const invalidOwn = own.filter((e) => !valid(e));
  const candidates = own.filter(valid);
  if (invalidOwn.length) {
    console.error('forge-sync: WARNING — ' + projPath + ' holds ' + invalidOwn.length + ' Scout verdict(s) that are not valid ledger entries (capability, verdict approve|hard-pass, reason); keeping that file untouched this pass so nothing is lost — fix those entries (make a copy first if you want a safety net; never delete the file, it may hold your own research)');
  }
  if (!candidates.length) return done([], invalidOwn.length > 0);
  let userDoc;
  try {
    const raw = fs.readFileSync(userPath, 'utf8');
    try { userDoc = JSON.parse(raw.replace(/^﻿/, '')); }
    catch (e) { console.error('forge-sync: WARNING — ' + userPath + ' is not valid JSON; Scout verdict migration skipped this pass, nothing written (' + e.message + ') — fix that file\'s JSON (make a copy first if you want a safety net — never delete it, it may hold your own research)'); return done([], true); }
    if (!isObj(userDoc) || !Array.isArray(userDoc.entries)) { console.error('forge-sync: WARNING — ' + userPath + ' has no "entries" array; Scout verdict migration skipped this pass, nothing written — fix that file (never delete it, it may hold your own research)'); return done([], true); }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') { console.error('forge-sync: WARNING — could not read ' + userPath + ' (' + e.message + '); Scout verdict migration skipped this pass, nothing written — fix that file (never delete it, it may hold your own research)'); return done([], true); }
    userDoc = { _doc: 'FORGE_SCOUT_VETTING.user.json — this project\'s OWN Scout verdicts (never shipped; forge-scout.cjs merges it with the shipped baseline). Created by forge-sync\'s pre-split migration.', version: 1, entries: [] };
  }
  const userKeys = new Set(userDoc.entries.filter(isObj).map(key));
  const toAppend = candidates.filter((e) => !userKeys.has(key(e)));
  const moved = candidates.map((e) => e.capability + ' (' + e.verdict + ')');
  if (!toAppend.length) return done(moved, invalidOwn.length > 0); // already migrated on an earlier pass
  const safeUserPath = safeJoin(dst, SCOUT_VETTING_USER_REL);
  if (safeUserPath == null || isSymlinkPath(userPath) || !containmentSafe(dst, userPath)) {
    console.error('forge-sync: WARNING — refusing to migrate Scout verdicts: ' + userPath + ' is a symlink or resolves outside .claude/');
    return done([], true);
  }
  if (dryRun) return done(moved, invalidOwn.length > 0);
  try {
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    const stamp = 'forge-sync pre-split migration (WP-2b) from FORGE_SCOUT_VETTING.json';
    writeAtomic(userPath, JSON.stringify(Object.assign({}, userDoc, { entries: userDoc.entries.concat(toAppend.map((e) => Object.assign({}, e, { migrated_by: stamp }))) }), null, 2) + '\n');
  } catch (e) {
    console.error('forge-sync: could not write ' + userPath + ' while migrating Scout verdicts (' + e.message + ') — keeping FORGE_SCOUT_VETTING.json untouched this pass');
    return done([], true);
  }
  return done(moved, invalidOwn.length > 0);
}
/** holdPendingMigrations(plan, standing, scout) — the ONE place both pending migrations keep their shipped file out
 *  of this pass's writes (any route: a plain toChange or a --force-overwrite-folded drift/conflict). Mutates and
 *  returns the plan object it was given (always a fresh object from buildPlan/preflight). */
function holdPendingMigrations(plan, standingMigration, scoutMigration) {
  const hold = (rel, reason, message) => {
    const before = plan.toChange.length;
    plan.toChange = plan.toChange.filter((e) => e.rel !== rel);
    if (plan.toChange.length !== before) {
      plan.skipped = (plan.skipped || []).concat([{ rel, reason }]);
      console.error(message);
    }
  };
  if (standingMigration && standingMigration.pending) {
    // R6(c): never suggest deleting the private rules file — it may hold the owner's own rules.
    hold(STANDING_RULES_REL, 'owner-rule-pending-migration', 'forge-sync: WARNING — refusing to replace ' + STANDING_RULES_REL + ' this pass: an owner rule from a pre-v2.8.0 install is still sitting in it and could not be migrated into ' +
      STANDING_RULES_USER_REL + ' (see the warning above). Fix that file\'s JSON (make a copy first if you want a safety net — never delete it, it may hold your own rules), ' +
      'then re-run sync so the owner rule can be moved to safety before this file is replaced.');
  }
  if (scoutMigration && scoutMigration.pending) {
    hold(SCOUT_VETTING_REL, 'scout-verdict-pending-migration', 'forge-sync: WARNING — refusing to replace ' + SCOUT_VETTING_REL + ' this pass: it holds this project\'s own Scout verdict(s) that could not be moved into ' +
      SCOUT_VETTING_USER_REL + ' (see the warning above). Fix that file (make a copy first if you want a safety net — never delete it, it may hold your own research), then re-run sync.');
  }
  return plan;
}

/**
 * preflight(templateDir, projectDir) -> classify every system file into exactly one bucket:
 *   toChange            — safe to sync (unchanged since our last write, brand new, or an eol_only diff)
 *   expectedOverrides    — declared in forge-overrides.json -> NEVER touched
 *   unknownDrift          — project differs from template; template unchanged since last receipt (or no
 *                           receipt at all -> conservative default); NOT overwritten unless --force-overwrite
 *   conflicts            — BOTH project and template changed since the last receipt; NOT overwritten unless
 *                           --force-overwrite
 *   skipped               — symlink/containment-guard trip; never touched, ever
 *   unreadable            — B3: exists but could not be read; the WHOLE project sync refuses on this
 * additions (shipping manifest):
 *   seed-only files      — created when the project lacks them (toChange, overrideClass 'seed', isNew), otherwise
 *                           NEVER touched: a differing copy is only listed in seedKept. They never enter
 *                           unknownDrift/conflicts, so --force-overwrite (buildPlan) and --unsafe cannot reach them.
 *   missingInTemplate     — F3: every ship-sync/seed-only entry the template lacks is LISTED (never a silent
 *                           `continue`); missingBlocking is the part install/sync refuse on (see shipPlan).
 *   seedSame, seedRels, shipManifest {source, file, rules}, neverTouchClaimed — reporting fields.
 * WP-SYNC-R7 (opts.templateHistory, see templateHistoryMatcher): a file that differs from the template AND from its receipt
 *   baseline (or has none) is first compared with every version that path has had in the template; a match goes to
 *   toChange as overrideClass 'template_history' (historyMatch: where it matched) instead of unknownDrift/conflicts.
 */
function preflight(templateDir, projectDir, opts) {
  const sp = shipPlan(templateDir);
  const dst = claudeDirOf(projectDir);
  const receipt = readReceipt(projectDir);
  const lastTemplateHash = receiptLastTemplateHashMap(receipt);
  const allowlist = readOverrideAllowlist(projectDir);
  const historyMatch = templateHistoryMatcher(templateDir, opts); // WP-SYNC-R7 item 1 (lazy: only drift/conflict candidates reach it)
  const toChange = [], expectedOverrides = [], unknownDrift = [], conflicts = [], skipped = [], unreadable = [], seedKept = [];
  const missingInTemplate = sp.missing.slice();
  let same = 0, seedSame = 0;
  for (const rel of sp.system) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) { missingInTemplate.push({ rel, kind: 'file', class: 'ship-sync', rule: null, releaseExcluded: null, vanished: true }); continue; } // listed, never silently skipped
    const out = safeJoin(dst, rel);
    if (out == null) { skipped.push({ rel, reason: 'unsafe-path' }); continue; }
    if (isSymlinkPath(out)) { skipped.push({ rel, reason: 'symlink' }); continue; }
    if (!containmentSafe(dst, out)) { skipped.push({ rel, reason: 'symlink-parent-escape' }); continue; }
    const outStatus = fileStatus(out);
    if (outStatus.kind === 'unreadable') { unreadable.push({ rel, error: outStatus.error }); continue; }
    const templateHash = sha256(src);
    const outHash = outStatus.kind === 'ok' ? outStatus.hash : null;
    if (outHash === templateHash) { same++; continue; }
    if (allowlist.has(normKey(rel))) { expectedOverrides.push(rel); continue; } // case-folded like the file system
    if (outHash === null) { toChange.push({ rel, oldHash: null, newHash: templateHash, isNew: true, overrideClass: null }); continue; }
    const ext = path.extname(rel).toLowerCase();
    if (TEXT_EXTS_FOR_EOL.has(ext)) { // raw bytes differ, but ONLY by line-ending style -> always safe
      const normOut = sha256Normalized(out), normSrc = sha256Normalized(src);
      if (normOut !== null && normOut === normSrc) { toChange.push({ rel, oldHash: outHash, newHash: templateHash, isNew: false, overrideClass: 'eol_only' }); continue; }
    }
    const hasBaseline = Object.prototype.hasOwnProperty.call(lastTemplateHash, rel);
    if (hasBaseline && outHash === lastTemplateHash[rel]) { toChange.push({ rel, oldHash: outHash, newHash: templateHash, isNew: false, overrideClass: null }); continue; }
    // WP-SYNC-R7 item 1: before calling it drift or a conflict — are these bytes a version this path has had in the template?
    const hm = historyMatch(rel, out, outHash);
    if (hm) { toChange.push({ rel, oldHash: outHash, newHash: templateHash, isNew: false, overrideClass: 'template_history', historyMatch: hm.by, historySource: hm.source }); continue; }
    if (hasBaseline) {
      if (templateHash === lastTemplateHash[rel]) { unknownDrift.push(rel); continue; }
      conflicts.push(rel); continue;
    }
    unknownDrift.push(rel); // no receipt at all yet -> can't tell drift from conflict, be conservative
  }
  // SEED-ONLY: create when absent, otherwise never touched — a project copy that differs from the template
  // default is the owner's own state, listed for information only.
  for (const rel of sp.seed) {
    const src = path.join(templateDir, rel);
    const out = safeJoin(dst, rel);
    if (out == null) { skipped.push({ rel, reason: 'unsafe-path' }); continue; }
    if (isSymlinkPath(out)) { skipped.push({ rel, reason: 'symlink' }); continue; }
    if (!containmentSafe(dst, out)) { skipped.push({ rel, reason: 'symlink-parent-escape' }); continue; }
    const st = fileStatus(out);
    if (st.kind === 'unreadable') { seedKept.push({ rel, reason: 'present but unreadable (' + st.error + ') — never touched' }); continue; }
    const templateHash = sha256(src);
    if (templateHash === null) { missingInTemplate.push({ rel, kind: 'file', class: 'seed-only', rule: null, releaseExcluded: null, vanished: true }); continue; }
    if (st.kind === 'ok') {
      if (st.hash === templateHash) seedSame++;
      else seedKept.push({ rel, reason: 'differs from the template default — kept (seed-only: never overwritten)' });
      continue;
    }
    if (allowlist.has(normKey(rel))) { expectedOverrides.push(rel); continue; } // R4 / F13
    toChange.push({ rel, oldHash: null, newHash: templateHash, isNew: true, overrideClass: 'seed' });
  }
  // a file that vanished between the walk and here means the template is changing under us: always blocking
  const missingBlocking = missingInTemplate.filter((x) => x.vanished || (sp.manifest.source === 'template' && x.class === 'ship-sync' && !x.releaseExcluded));
  return {
    toChange, expectedOverrides, unknownDrift, conflicts, skipped, unreadable, same,
    seedKept, seedSame, seedRels: sp.seed.slice(), missingInTemplate, missingBlocking, shipManifest: sp.manifest, neverTouchClaimed: sp.neverTouchClaimed,
    overridesRefused: allowlist.refused || [], // override entries that normalise to the floor (dropped, reported)
  };
}

/** normalizeAcceptRel(raw) -> the .claude-relative spelling of an --accept-template value: backslashes to `/`, a leading
 *  `./` and a leading `.claude/` dropped, repeated separators collapsed. Validation happens in applyAcceptTemplate. */
function normalizeAcceptRel(raw) {
  let r = String(raw == null ? '' : raw).trim().split('\\').join('/').replace(/\/{2,}/g, '/');
  while (r.startsWith('./')) r = r.slice(2);
  if (/^\.claude\//i.test(r)) r = r.slice('.claude/'.length);
  return r;
}
/** applyAcceptTemplate(templateDir, projectDir, plan, requested) -> a NEW plan. WP-SYNC-R7 item 1: `install --accept-template
 *  <rel>` (repeatable) is the per-file alternative to --force-overwrite: each named file that the plan holds as unknown drift or
 *  a conflict is replaced by the template version (backed up first, like every write; overrideClass 'accepted_template').
 *  Recorded in plan.acceptTemplate {requested, accepted[{rel, was}], unused[{rel, reason}], refused[{rel, reason}]} — the
 *  receipt and the change report carry it. A name that is not a shipped (ship-sync) file of this template, a seed-only or
 *  never-touch path, or a file declared in forge-overrides.json is REFUSED (the install then refuses before any write — a
 *  typo never silently accepts nothing); a shipped file that is not drifted is listed as unused (nothing to accept). */
function applyAcceptTemplate(templateDir, projectDir, plan, requested) {
  const reqs = (Array.isArray(requested) ? requested : []).filter((x) => x != null);
  if (!reqs.length) return plan;
  const dst = claudeDirOf(projectDir);
  const drift = new Map(plan.unknownDrift.map((rel) => [normKey(rel), rel]));
  const conf = new Map(plan.conflicts.map((rel) => [normKey(rel), rel]));
  const overrides = new Set((plan.expectedOverrides || []).map(normKey));
  const seed = new Set((plan.seedRels || []).map(normKey));
  let system = [];
  try { system = listSystemFiles(templateDir); } catch { system = []; }
  const systemKeys = new Map(system.map((rel) => [normKey(rel), rel]));
  const accepted = [], unused = [], refused = [], seen = new Set();
  for (const raw of reqs) {
    const rel = normalizeAcceptRel(raw);
    const k = normKey(rel);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!isPlainRel(rel)) { refused.push({ rel: String(raw), reason: 'not a plain path inside .claude/' }); continue; }
    if (isNeverTouch(rel)) { refused.push({ rel, reason: 'on the never-touch floor (project memory, state or bookkeeping) — forge-sync never writes it' }); continue; }
    if (seed.has(k)) { refused.push({ rel, reason: 'a seed-only file (the project\'s own state once it exists) — never overwritten, not even with --accept-template' }); continue; }
    if (overrides.has(k)) { refused.push({ rel, reason: 'declared in .claude/config/forge-overrides.json (never touched) — remove it there first if the template version should win' }); continue; }
    if (!systemKeys.has(k)) { refused.push({ rel, reason: 'not a file this template ships (check the spelling; paths are relative to .claude/)' }); continue; }
    if (drift.has(k)) accepted.push({ rel: drift.get(k), was: 'unknown_drift' });
    else if (conf.has(k)) accepted.push({ rel: conf.get(k), was: 'conflict' });
    else unused.push({ rel: systemKeys.get(k), reason: 'not drifted — it is current, a plain update or a template-history match; nothing to accept' });
  }
  const acceptedRels = new Set(accepted.map((a) => a.rel));
  const forced = accepted.map((a) => ({ rel: a.rel, oldHash: sha256(safeJoin(dst, a.rel)), newHash: sha256(path.join(templateDir, a.rel)), isNew: false, overrideClass: 'accepted_template', acceptedFrom: a.was }));
  return Object.assign({}, plan, {
    toChange: plan.toChange.concat(forced),
    unknownDrift: plan.unknownDrift.filter((rel) => !acceptedRels.has(rel)),
    conflicts: plan.conflicts.filter((rel) => !acceptedRels.has(rel)),
    acceptTemplate: { requested: reqs.map(String), accepted, unused, refused },
  });
}
/** acceptTemplateRefusal(plan) -> null, or the plain refusal text when an --accept-template name was refused. */
function acceptTemplateRefusal(plan) {
  const ref = plan && plan.acceptTemplate ? plan.acceptTemplate.refused : [];
  if (!ref || !ref.length) return null;
  return 'refusing to sync: --accept-template named ' + ref.length + ' path(s) it cannot accept: ' + ref.map((x) => x.rel + ' (' + x.reason + ')').join('; ') + ' — fix or drop them and re-run; nothing was written';
}

function buildPlan(templateDir, projectDir, opts) {
  opts = opts || {};
  let pf = preflight(templateDir, projectDir, { templateHistory: opts.templateHistory });
  if (Array.isArray(opts.acceptTemplate) && opts.acceptTemplate.length) pf = applyAcceptTemplate(templateDir, projectDir, pf, opts.acceptTemplate); // WP-SYNC-R7
  if (!opts.forceOverwrite || (pf.unknownDrift.length === 0 && pf.conflicts.length === 0)) return pf;
  const dst = claudeDirOf(projectDir);
  const forceRel = (rel, cls) => {
    const src = path.join(templateDir, rel);
    const out = safeJoin(dst, rel);
    return { rel, oldHash: sha256(out), newHash: sha256(src), isNew: false, overrideClass: cls };
  };
  // only ship-sync drift/conflicts are ever forced — seed-only files never enter those buckets
  const forced = pf.unknownDrift.map((rel) => forceRel(rel, 'unknown_drift')).concat(pf.conflicts.map((rel) => forceRel(rel, 'conflict')));
  return Object.assign({}, pf, { toChange: pf.toChange.concat(forced), unknownDrift: [], conflicts: [] });
}
/** PUBLISH_TEMPLATE_HINT —: the ONE fix every "missing in template" message points at (status, preflight/dry-run,
 *  install refusal): publish the template again from the development tree, plan first. */
const PUBLISH_TEMPLATE_HINT = 'fix: refresh the template from the development tree — `node .claude/forge-bin/forge-sync.cjs publish-template --plan` there (then --apply in an owner-approved window)';
/** missingInTemplateReason(plan) -> null, or the plain refusal text for a template that lacks ship-sync file(s). */
function missingInTemplateReason(plan) {
  const m = (plan && plan.missingBlocking) || [];
  if (!m.length) return null;
  return 'refusing to sync: the template is INCOMPLETE — ' + m.length + ' file(s) its own shipping manifest says it ships are missing from it: '
    + m.slice(0, 12).map((x) => x.rel + (x.vanished ? ' (vanished during this sync)' : '')).join(', ') + (m.length > 12 ? ', … +' + (m.length - 12) + ' more' : '')
    + ' — ' + PUBLISH_TEMPLATE_HINT + ', and re-run; nothing was written';
}

/** fullFileManifest — the FULL relevant-file hash manifest (rel -> {exists,hash,mode}), used for real
 *  before/after byte-exactness proof (not just "rollback exited 0"). */
function fullFileManifest(templateDir, projectDir) { return manifestForRels(projectDir, listSystemFiles(templateDir)); }
/** manifestForRels(projectDir, rels) — the same manifest shape over an explicit file set (F11: the set a receipt recorded). */
function manifestForRels(projectDir, rels) {
  const dst = claudeDirOf(projectDir);
  const out = {};
  for (const rel of rels) {
    const p = safeJoin(dst, rel) || path.join(dst, rel);
    let exists = false, hash = null, mode = null;
    try { const st = fs.lstatSync(p); exists = true; mode = st.mode; if (st.isFile()) hash = sha256(p); } catch { exists = false; }
    out[rel] = { exists, hash, mode };
  }
  return out;
}
function aggregateManifestHash(manifestObj) {
  const keys = Object.keys(manifestObj).sort();
  const h = crypto.createHash('sha256');
  for (const k of keys) h.update(k + ':' + (manifestObj[k].hash || '-') + ':' + manifestObj[k].exists);
  return h.digest('hex');
}
/** preBaselineManifestHash(templateDir, projectDir, receipt) -> the manifest hash --reuse-pre-baseline compares with
 *  receipt.postSyncManifestHash. Category tests F11: that hash used to be computed over the system-file list of the
 *  CURRENT template, so a file that is new (or gone) in a newer template changed it although no project file had changed, and
 *  every update right after an install ran the doctor twice. A receipt that records its file set (postSyncManifestRels) is now
 *  re-hashed over exactly that set. A system file of the current template outside that set that EXISTS in the project (the
 *  doctor never judged it) makes the hash unmatchable, and so does a malformed recorded set. A receipt without the record (older
 *  forge-sync) is judged over the current template list, as before. */
function preBaselineManifestHash(templateDir, projectDir, receipt) {
  const rels = receipt && receipt.postSyncManifestRels;
  if (rels === undefined) return aggregateManifestHash(fullFileManifest(templateDir, projectDir));
  if (!Array.isArray(rels) || !rels.every(isPlainRel)) return 'unusable:the receipt\'s postSyncManifestRels is malformed';
  const recorded = new Set(rels);
  const unjudged = listSystemFiles(templateDir).filter((rel) => !recorded.has(rel) && manifestForRels(projectDir, [rel])[rel].exists);
  if (unjudged.length) return 'unusable:system file(s) the last validation never judged exist now: ' + unjudged.slice(0, 5).join(', ');
  return aggregateManifestHash(manifestForRels(projectDir, rels));
}

function versionFilePath(projectDir) { return path.join(claudeDirOf(projectDir), 'FORGE_VERSION.json'); }
function readVersionFile(projectDir) {
  try { return { exists: true, content: fs.readFileSync(versionFilePath(projectDir), 'utf8') }; }
  catch { return { exists: false, content: null }; }
}

/** assertSafeBatchId —: the LAST line of defence. Every entry point (parseArgs, safeSyncProject,
 *  rawInstall, rollbackProject, rollbackBatch, runSyncAll, takeBackup, loadTrustedManifest) already refuses an
 *  unsafe batch id with a clean message; these two path builders additionally throw, so no future caller can ever
 *  join a traversal-shaped id ('..', '/', '\\', ':') into a backup path by forgetting that check. */
function assertSafeBatchId(batchId) {
  if (!isSafeBatchId(batchId)) throw new Error('unsafe batch id ' + JSON.stringify(batchId) + ' — must be 1-100 characters, letters/digits/-/_ only');
}
function backupDirFor(projectDir, batchId) { assertSafeBatchId(batchId); return path.join(claudeDirOf(projectDir), 'forge-backups', batchId); }
function centralBackupDir(centralRoot, batchId, pid) { assertSafeBatchId(batchId); return path.join(centralRoot, '.claude', 'forge-backups', batchId, pid); }
/** unsafeBatchIdReason(batchId) -> null when the id is acceptable, else the one plain refusal message every entry
 *  point prints. `null`/`undefined` are acceptable here (the caller generates or does not need an id). */
function unsafeBatchIdReason(batchId) {
  if (batchId == null || isSafeBatchId(batchId)) return null;
  return 'unsafe batch id ' + JSON.stringify(batchId) + ' — a batch id must be 1-100 characters, letters/digits/-/_ only (it becomes a backup folder name; "..", "/" or "\\" could write outside .claude)';
}

/** defaultCentralBackupRoot(projectDir) — N10 fix (external audit): `install`/`rollback` used
 *  to default the central backup hub to <parent-of-project>/.forge-backup-hub — OUTSIDE the project (on the
 *  audit's machine, literally the user's Desktop), while /forge's own promise is "only ever touches
 *  .claude/". The per-project backup (<project>/.claude/forge-backups/<batchId>/<rel>, always taken
 *  regardless of this setting) already covers the ordinary "undo my last sync" case; this SECOND, central
 *  copy is only a belt-and-braces safety net. Its default now lives INSIDE the project instead of silently
 *  reaching into whatever folder happens to be the project's parent (a folder forge-sync has no business
 *  writing to by default) — --central-backup-root still lets a caller opt back into a real cross-project
 *  hub outside the project when that is genuinely wanted (e.g. for `sync-all`/`rollback-batch`, which
 *  operate over a whole multi-project root the caller already named explicitly and are unchanged here). */
function defaultCentralBackupRoot(projectDir) {
  return path.join(path.resolve(projectDir), '.claude', 'forge-backups-central');
}

/** takeBackup — copies every about-to-change file's CURRENT bytes to the per-project backup dir (and, when
 *  centralBackupRoot is given, mirrors the same manifest+files to a central, project-independent location)
 *  BEFORE any write happens. B2: also snapshots the CURRENT forge-sync-receipt.json (raw bytes) so rollback
 *  can restore it exactly like FORGE_VERSION.json — without this, a rollback left the receipt describing a
 *  sync that was undone, causing false unknown_drift on the very next preflight. B7: each file entry now
 *  records BOTH oldHash and newHash (+existed) so rollback can tell "still what I wrote" from "changed since". */
function takeBackup(projectDir, batchId, plan, templateVer, nowIso, opts) {
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  if (!isSafeBatchId(batchId)) return { ok: false, error: unsafeBatchIdReason(batchId) || 'a batch id is required to take a backup', backupDir: null }; // SYNC-13
  const bdir = backupDirFor(projectDir, batchId);
  // S8 FIX: every fs write below used to be unguarded — an unwritable hub (permission denied, disk full, a
  // read-only central mount) threw an UNCAUGHT exception straight out of takeBackup, crashing the whole
  // install/sync-all process with a raw stack trace instead of the honest, clean refusal every other
  // failure mode in this tool already produces. The entire body is now one try/catch that returns
  // {ok:false, error, backupDir} on ANY I/O failure — callers must check backup.ok before proceeding to apply.
  try {
    return takeBackupUnsafe(projectDir, batchId, plan, templateVer, nowIso, opts, dst, bdir);
  } catch (e) {
    return { ok: false, error: 'failed to take backup: ' + e.message, backupDir: bdir };
  }
}
function takeBackupUnsafe(projectDir, batchId, plan, templateVer, nowIso, opts, dst, bdir) {
  // .claude itself, forge-backups/ and forge-backups/<batch>/ must all be REAL folders inside the project —
  // a pre-planted junction anywhere on that chain would carry every backup byte (and later the rollback source) outside.
  assertClaudeBaseContained(projectDir);
  ensureRealDir(dst, bdir);

  /** S1 FIX: a `--resume-batch` re-run calls takeBackup a SECOND time for the SAME batchId (the M3 guard that
   *  normally refuses batchId reuse is intentionally bypassed by opts.resumeBatch in safeSyncProject). The OLD
   *  code unconditionally re-copied CURRENT on-disk bytes over every already-backed-up file and recomputed its
   *  oldHash from preflight()'s plan — but after a crash mid-apply, "current on-disk" is the MIXED (half-
   *  applied) state, not the true pre-batch state. That silently clobbered the pristine backup with wrong
   *  bytes/wrong oldHash, so a later rollback of that batch restored the mixed state and reported ok. Fix:
   *  if this batch dir already has a manifest.json (a resume), reuse each already-recorded file entry AND its
   *  on-disk backup bytes VERBATIM — never re-copy, never recompute oldHash for a rel already backed up. Only
   *  a rel truly never reached by the prior attempt gets a fresh backup taken now. hadVersionFile/oldVersion/
   *  hadReceipt/oldReceipt are pinned to the FIRST attempt's recorded pre-batch values too, for the same reason. */
  let priorManifest = null;
  // CODEX ronde-3 #5: een BESTAAND maar onparseerbaar manifest is geen "eerste poging" —
  // het is een half geschreven/beschadigd transactielog. Het stilzwijgend negeren zou de rollback-dekking
  // van de vorige poging weggooien terwijl haar writes wél op schijf staan. Weigeren, met het bestand
  // als bewijs; ENOENT (echt de eerste poging) blijft het normale pad.
  const manifestPath = path.join(bdir, 'manifest.json');
  try { priorManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) {
    if (!e || e.code !== 'ENOENT') {
      throw new Error('existing but unreadable/corrupt backup manifest for batch ' + batchId + ' (' + manifestPath + '): '
        + e.message + ' — refusing to treat a damaged transaction log as a first attempt (a prior attempt\'s writes may be unprotected)');
    }
  }
  // CODEX ronde-3 #5 stelde voor een resume tegen een ANDERE templateversie hard te weigeren (verouderde
  // newHash-verwachtingen in unie-entries). Test 36 codificeert resume-met-nieuwere-template echter als
  // ONTWORPEN gedrag; de echte zorg — een prior-entry wiens newHash niet meer beschrijft wat de resume
  // gaat schrijven — wordt hieronder opgelost door de newHash van elk hergebruikt entry te verversen naar
  // het HUIDIGE plan (oldHash + backup-bytes blijven heilig van poging 1). Een rel die buiten het nieuwe
  // plan valt kan geen stale newHash dragen: viel hij eruit omdat de schijf al gelijk is aan de huidige
  // template, dan wees zijn oude newHash daar ook al naar; anders zit hij per constructie IN het plan.
  // a resume builds on the first attempt's manifest — only when it is bound to THIS project and batch (or an
  // explicitly allowed legacy one) and every entry is a plain, non-never-touch path.
  if (priorManifest) {
    const b = manifestBinding(priorManifest, projectDir, batchId);
    if (b.state === 'tampered' || b.state === 'mismatch') throw new Error('the existing backup manifest of batch ' + batchId + ' cannot be trusted (' + b.reason + ') — refusing to resume on it');
    if (b.state === 'legacy-unbound' && !opts.allowLegacyManifest) throw new Error('the existing backup manifest of batch ' + batchId + ' is legacy-unbound (' + b.reason + ') — pass --allow-legacy-manifest to resume on it after checking it');
    const bad = manifestEntryProblems(priorManifest);
    if (bad.length) throw new Error('the existing backup manifest of batch ' + batchId + ' has entries a sync never writes: ' + bad.slice(0, 4).join('; '));
    // a resume never drops the journal's integrity anchor, and checks the journal against it
    // BEFORE the manifest is rewritten or a record appended. Interrupted-append recovery rules:
    //  (a) anchor {head, seq} present: the journal must still contain it (record #seq hashes to head, chained from genesis).
    //      A truncation or a rewrite of the anchored prefix refuses the resume — nothing rewritten, nothing appended.
    //  (b) complete, chained records AFTER the anchor are what an attempt left when it crashed after appending but before it
    //      re-anchored: accepted; the resume continues from the true end and re-anchors after its own apply. (A rollback run
    //      before that re-anchor sees records beyond the anchor, treats the journal as untrusted and deletes nothing it
    //      cannot prove — updates are still restored from the verified backups.)
    //  (c) a final record cut off mid-write (no line end, or not JSON): a later record would be glued onto it, so the resume
    //      refuses. Recovery: `forge-sync rollback <project> --batch <id>` (untrusted journal: deletes nothing unproven,
    //      restores updates), then a sync with a NEW batch id.
    //  (d) no anchor (the first attempt crashed before it recorded one): the chain is verified from genesis; there is nothing
    //      to compare its length with — a truncation of an UNANCHORED journal to a shorter valid chain is not detectable
    //      (stated residue; the chain carries no secret either — accepted limit).
    const anchor = priorManifest.apply_journal;
    if (anchor !== undefined && anchor !== null && !(typeof anchor === 'object' && typeof anchor.head === 'string' && anchor.head && Number.isInteger(anchor.seq) && anchor.seq >= 0)) {
      throw new Error('the existing backup manifest of batch ' + batchId + ' carries a malformed apply-journal anchor (' + JSON.stringify(anchor) + ') — refusing to resume on it');
    }
    const jr = readApplyJournal(bdir, { batchId, expectedHead: anchor || null, anchorPrefix: true });
    const recovery = ' — refusing to resume; nothing was rewritten or appended. Recovery: `forge-sync rollback <project> --batch ' + batchId + '` (an untrusted journal deletes nothing it cannot prove; updates come back from the verified backups), then sync with a new batch id';
    if (jr.reason) throw new Error('the apply journal of batch ' + batchId + ' cannot be trusted for a resume (' + jr.reason + ')' + recovery);
    if (jr.present && jr.tornTail) throw new Error('the apply journal of batch ' + batchId + ' ends in a record without a line end (an append was interrupted mid-write)' + recovery);
  }
  // a FRESH batch folder (no manifest yet) must not already hold an apply journal — a leftover or a planted file
  // (a hard link to a protected file would receive this batch's records). A real resume has a manifest and continues its own
  // journal, which is verified link-free on every append.
  if (!priorManifest) {
    const jp = path.join(bdir, APPLY_JOURNAL_NAME);
    if (lstatKind(jp) !== 'missing') throw new Error('the batch folder ' + bdir + ' already holds an apply journal (' + APPLY_JOURNAL_NAME + ') although this is not a resume — a leftover or planted file; refusing (remove it, or pass --resume-batch for a real resume)');
  }
  const priorFilesByRel = {};
  if (priorManifest && Array.isArray(priorManifest.files)) for (const f of priorManifest.files) priorFilesByRel[f.rel] = f;

  const files = [];
  for (const entry of plan.toChange) {
    const already = priorFilesByRel[entry.rel];
    // S1: never re-back-up / never recompute oldHash on resume — but DO refresh newHash to what THIS
    // attempt will actually write (ronde-3 #5: a stale newHash from attempt 1 would misjudge divergence
    // after the template moved between attempts).
    if (already) { files.push(Object.assign({}, already, { newHash: entry.newHash })); continue; }
    if (!isPlainRel(entry.rel) || isNeverTouch(entry.rel)) throw new Error(entry.rel + ' is not a path a sync may write (never-touch floor) — refusing');
    if (entry.oldHash !== null) {
      const out = safeJoin(dst, entry.rel);
      if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) throw new Error(entry.rel + ' resolves through a symlink or outside the project — refusing to back it up');
      const backupTarget = path.join(bdir, ...entry.rel.split('/'));
      ensureRealDir(bdir, path.dirname(backupTarget)); // every sub-folder of the backup is a real folder too
      copyNoFollow(out, backupTarget, bdir); // no-follow + containment-checked (was a bare fs.copyFileSync)
      // the backup must hold exactly the bytes the plan saw — otherwise the file changed since planning
      if (sha256(backupTarget) !== entry.oldHash) throw new Error(entry.rel + ' changed since the plan was made (its bytes no longer match the planned old hash) — refusing to sync; nothing in the project was written');
    }
    files.push({ rel: entry.rel, oldHash: entry.oldHash, newHash: entry.newHash, existed: entry.oldHash !== null });
  }
  /** AUDIT #19: the loop above builds files[] from the NEW plan only, and on a resume the new
   *  plan is SMALLER by construction — a file the crashed first attempt already wrote now hashes equal to
   *  the template, so preflight files it under `same` and it never re-enters plan.toChange. S1 (above)
   *  protected the entries still IN the plan; entries that fell OUT of it were silently dropped from the
   *  manifest that was then unconditionally rewritten below — and restoreFromManifest only iterates
   *  manifest.files, so a rollback of the batch left exactly those files on template content while
   *  reporting ok, with their pristine backup bytes lying orphaned in the backup dir. The manifest is now
   *  a UNION: every prior-attempt entry that the new plan no longer names is carried forward verbatim
   *  (its backup bytes are already on disk in bdir; the central-mirror loop below copies them through the
   *  same existsSync non-clobber path). A rollback after a resume can therefore always reach the true
   *  pre-batch state. */
  const keptRels = new Set(files.map((f) => f.rel));
  if (priorManifest && Array.isArray(priorManifest.files)) {
    for (const f of priorManifest.files) if (!keptRels.has(f.rel)) { files.push(f); keptRels.add(f.rel); }
  }
  const versionState = priorManifest ? { exists: priorManifest.hadVersionFile, content: priorManifest.oldVersion } : readVersionFile(projectDir);
  const receiptState = priorManifest ? { exists: priorManifest.hadReceipt, content: priorManifest.oldReceipt } : readRawReceipt(projectDir);
  const pid = projectId(projectDir);
  // S3: record the ACTUAL resolved central-hub path this batch used, so a later rollback can read it back
  // from here instead of re-deriving its own guess — install/rollback derive a default from dirname(project)
  // while sync-all/rollback-batch derive theirs from rootDir, which disagree for any project that is not a
  // direct child of root (the sync-all backup becomes unreachable by a per-project rollback). Preserved across
  // a resume (never overwritten by a differing value on a second takeBackup call for the same batch).
  const centralBackupRootResolved = priorManifest && Object.prototype.hasOwnProperty.call(priorManifest, 'centralBackupRoot')
    ? priorManifest.centralBackupRoot
    : (opts.centralBackupRoot ? path.resolve(opts.centralBackupRoot) : null);
  const manifest = {
    // bound to this project (its REAL path) and this batch; writeBoundManifest adds the self-hash
    schema: BACKUP_MANIFEST_SCHEMA, batch_id: batchId, project_real: realProjectPath(projectDir),
    batchId, ts: priorManifest ? (priorManifest.ts || nowIso) : nowIso,
    runId: opts.runId || (priorManifest ? priorManifest.runId : null) || null, templateVersion: templateVer,
    projectId: pid, projectPath: path.resolve(projectDir), centralBackupRoot: centralBackupRootResolved,
    files, hadVersionFile: versionState.exists, oldVersion: versionState.exists ? versionState.content : null,
    hadReceipt: receiptState.exists, oldReceipt: receiptState.exists ? receiptState.content : null,
    // CODEX ronde-3 #6: de scaffold-undo-informatie van de vorige poging moet een resume OVERLEVEN —
    // deze herbouw schreef het manifest zonder dat veld en gooide daarmee het enige record weg waarmee
    // een latere rollback de .gitignore-append/created files van poging 1 kon terugdraaien.
    ...(priorManifest && priorManifest.scaffold ? { scaffold: priorManifest.scaffold } : {}),
    // the journal anchor survives the rebuild (validated above); the resume's apply re-anchors after it ran
    ...(priorManifest && priorManifest.apply_journal ? { apply_journal: priorManifest.apply_journal } : {}),
    // the owner-data migrations' exact writes (rel, existed, preHash, postHash) — not rolled back (they only
    // ever ADD the project's own rules/verdicts to its *.user.json), but recorded so verify-protect --batch can tell
    // them apart from anything else that touched those files. A resume keeps the first attempt's record.
    ...((priorManifest && Array.isArray(priorManifest.migrations)) ? { migrations: priorManifest.migrations }
      : (Array.isArray(opts.migrations) && opts.migrations.length ? { migrations: opts.migrations } : {})),
  };
  // CODEX ronde-3 #5: het manifest is het transactielog van deze batch — atomair schrijven (temp+rename),
  // zodat een crash halverwege nooit een half JSON-bestand achterlaat dat de volgende resume zou weigeren.
  const bound = writeBoundManifest(bdir, manifest); // + self-hash

  let centralDir = null;
  if (opts.centralBackupRoot) {
    // the central copy gets the same real-folder chain check (forge-backups-central inside the project from
    // the project's .claude down; an explicitly named outside hub from its own real path down).
    const anchor = centralAnchorFor(projectDir, opts.centralBackupRoot, { create: true });
    centralDir = centralBackupDir(anchor.root, batchId, pid);
    ensureRealDir(anchor.anchor, centralDir);
    if (!priorManifest && lstatKind(path.join(centralDir, APPLY_JOURNAL_NAME)) !== 'missing') throw new Error('the central batch folder ' + centralDir + ' already holds an apply journal although this is not a resume — refusing'); // R4 / F01
    for (const f of files) {
      if (f.oldHash !== null) {
        const centralTarget = path.join(centralDir, ...f.rel.split('/'));
        ensureRealDir(centralDir, path.dirname(centralTarget));
        if (!fs.existsSync(centralTarget)) copyNoFollow(path.join(bdir, ...f.rel.split('/')), centralTarget, centralDir); // S1: non-clobber on resume
        if (sha256(centralTarget) !== f.oldHash) throw new Error('the central backup copy of ' + f.rel + ' does not match its recorded hash (' + centralTarget + ')');
      }
    }
    writeBoundManifest(centralDir, manifest); // atomair, ronde-3 #5
  }
  return { ok: true, backupDir: bdir, centralDir, manifest: bound };
}

/** applyPlanSafely — writes plan.toChange; STOPS at the first failure (never leaves it to throw uncaught) so
 *  the caller can roll back exactly what was actually applied. copyFileImpl is injectable (defaults to
 *  fs.copyFileSync) purely so a test can simulate a mid-batch write failure without monkey-patching the
 *  global fs module. */
/** assertClaudeBaseContained (r5 #25): de containment-checks meten alles t.o.v. de
 *  GERESOLVEDE .claude-basis — maar als <project>/.claude zelf een junction naar buiten is, resolvet
 *  die basis naar buiten en "klopt" ieder doel eronder. Eis: de echte .claude-basis ligt binnen de
 *  echte projectroot en is geen reparse-point. Fail-closed voor elke apply/restore. */
function assertClaudeBaseContained(projectDir) {
  const base = claudeDirOf(projectDir);
  let lst = null;
  try { lst = fs.lstatSync(base); } catch (e) { throw new Error('sync-basis onleesbaar (' + base + '): ' + e.message); }
  if (lst.isSymbolicLink()) throw new Error('sync-basis ' + base + ' is zelf een symlink/junction — geweigerd (r5 #25): een omgeleide .claude-basis maakt elke containment-check zinloos');
  let realBase, realRoot;
  try { realBase = fs.realpathSync.native(base); } catch (e) { throw new Error('realpath van de sync-basis faalde: ' + e.message); }
  try { realRoot = fs.realpathSync.native(projectDir); } catch (e) { throw new Error('realpath van de projectroot faalde: ' + e.message); }
  if (realBase !== path.join(realRoot, '.claude')) {
    throw new Error('sync-basis resolvet naar ' + realBase + ' — dat ligt niet als .claude direct onder de echte projectroot ' + realRoot + ' (r5 #25, fail-closed)');
  }
}

/** between the plan and the write sit the backup and a whole pre-sync doctor run.
 *  Immediately before EACH write the template bytes are read and hashed (they must still equal the planned newHash — those
 *  exact bytes are what gets written) and the destination is re-hashed: it must still be absent (a creation) or still hold
 *  the planned oldHash (an update). A destination that changed since planning — e.g. a seed file the owner created
 *  meanwhile — is SKIPPED and reported (result.skipped, needsReview), never overwritten; the caller rolls its own writes
 *  back and marks the batch NEEDS REVIEW. A creation is create-if-absent: the final name is made exclusively (hard link
 *  from a 'wx' temp, or 'wx' itself), so a file appearing in the last microseconds makes it a skip too. With opts.journalDirs
 *  every creation intent, creation, update and skip is appended to the batch's apply-journal.jsonl, which is what lets a
 *  later rollback delete ONLY what this batch created. Returns {ok, applied, created, skipped, needsReview}. */
/** F01/F02/F03/F05/F06): the journal is chained and bound to the batch (opts.batchId is
 *  required with opts.journalDirs; an existing journal of the batch is continued only when its chain verifies), the hash
 *  recorded for a write is the hash of the BYTES THIS FUNCTION WROTE (the template buffer), never a re-read of the
 *  destination afterwards; the destination is re-hashed once more after staging, immediately before the rename
 *  (writeBytesNoFollow expectOldHash) and a mismatch is a skip; a post-rename read that does not show those bytes is reported
 *  as `changed-during-write` and stops the apply — it is never "repaired" by writing again; and every target is checked
 *  against the never-touch floor by its REAL path (realTargetProblem), so a junction/alias on the way can never land a file
 *  in agent-memory/ or another protected folder. The result carries `journal` {head, seq} for the manifest. */
function applyPlanSafely(templateDir, projectDir, plan, copyFileImpl, opts) {
  assertClaudeBaseContained(projectDir);
  opts = opts || {};
  // default is nu copyNoFollow (uitgesteld punt 3) — de copyFileImpl-injectieseam blijft voor tests
  const dst = claudeDirOf(projectDir);
  const journalDirs = (opts.journalDirs || []).filter(Boolean);
  const chain = { batchId: isSafeBatchId(opts.batchId) ? opts.batchId : null, seq: 0, head: JOURNAL_GENESIS };
  const applied = [], created = [], skipped = [], changedDuringWrite = [];
  const done = (obj) => Object.assign(obj, { journal: journalDirs.length ? { head: chain.head, seq: chain.seq, batchId: chain.batchId } : null, changedDuringWrite });
  if (journalDirs.length) {
    if (!chain.batchId) return done({ ok: false, applied, created, skipped, error: 'an apply journal needs a valid batch id to bind its records to — none given' });
    // a resume passes the anchor its bound manifest carries (opts.expectedHead); the journal must still contain it
    const prior = readApplyJournal(journalDirs[0], { batchId: chain.batchId, expectedHead: opts.expectedHead || null, anchorPrefix: true });
    if (prior.reason) return done({ ok: false, applied, created, skipped, error: 'the existing apply journal of batch ' + chain.batchId + ' cannot be trusted (' + prior.reason + ') — refusing to append to it; nothing was written' });
    if (prior.present && prior.tornTail) return done({ ok: false, applied, created, skipped, error: 'the existing apply journal of batch ' + chain.batchId + ' ends without a line end (an append was interrupted) — refusing to append to it; nothing was written' });
    if (prior.present) { chain.seq = prior.seq; chain.head = prior.head; }
  }
  const journal = (rec) => { if (journalDirs.length) appendApplyJournal(journalDirs, Object.assign({ ts: new Date().toISOString() }, rec), chain); };
  const skip = (entry, reason, current) => { skipped.push({ rel: entry.rel, reason, planned: entry.oldHash, current }); journal({ rel: entry.rel, action: 'skipped', reason }); };
  try {
    for (const entry of plan.toChange) {
      const src = path.join(templateDir, ...entry.rel.split('/'));
      const out = safeJoin(dst, entry.rel);
      /** AUDIT #24: containment (isSymlinkPath + containmentSafe) ran ONLY at plan time in
       *  preflight, and between plan and apply sits at minimum a full-file manifest plus preValidation —
       *  an entire forge-doctor run, seconds to minutes. In that window a directory on the path (or the
       *  leaf itself) can become a symlink/junction pointing outside the project; safeJoin is purely
       *  lexical and copyFileSync follows links, so the "checked" write would then land outside the tree
       *  it was checked against. Re-verify per entry at the WRITE moment, before mkdirSync; a trip is an
       *  ordinary apply-failure so the existing applied-subset rollback handles it. The --unsafe path
       *  calls this same function and gets the guard for free. */
      if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) {
        return done({ ok: false, applied, created, skipped, error: 'containment guard tripped at write time: ' + entry.rel + ' resolves through a symlink or outside the project — refusing to write' });
      }
      if (!isPlainRel(entry.rel) || isNeverTouch(entry.rel)) return done({ ok: false, applied, created, skipped, error: entry.rel + ' is under the never-touch floor — refusing to write it' });
      const real = realTargetCheck(dst, out); // the floor by the REAL path (a junction into agent-memory/ ...)
      if (real.problem) return done({ ok: false, applied, created, skipped, error: 'refusing to write ' + entry.rel + ': ' + real.problem });
      const floorOpts = { approvedRealParent: real.realParent, floor: true }; // the writer re-checks on ITS resolution
      // SYNC-04 (source): read once, hash, and write exactly these bytes
      let buf;
      try { buf = fs.readFileSync(src); } catch (e) { return done({ ok: false, applied, created, skipped, error: 'the template file ' + entry.rel + ' cannot be read now (' + e.message + ')' }); }
      const srcHash = crypto.createHash('sha256').update(buf).digest('hex');
      if (srcHash !== entry.newHash) return done({ ok: false, applied, created, skipped, error: 'the template changed since the plan was made: ' + entry.rel + ' no longer has the planned bytes — refusing to write unplanned content' });
      // SYNC-04 (destination): still exactly what the plan saw?
      const st = fileStatus(out);
      const now = st.kind === 'ok' ? st.hash : (st.kind === 'missing' ? null : 'unreadable');
      if (now !== entry.oldHash) {
        skip(entry, entry.oldHash === null ? 'appeared since the plan was made (a creation never overwrites)' : (now === null ? 'removed since the plan was made' : 'changed since the plan was made'), now);
        continue;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // writtenHash = the hash of the buffer THIS run writes — never sampled from the destination afterwards
      const writtenHash = srcHash;
      if (entry.oldHash === null) {
        journal({ rel: entry.rel, action: 'intent-create', hash: writtenHash });
        let r = 'written';
        if (copyFileImpl) copyFileImpl(src, out); else r = writeBytesNoFollow(buf, out, dst, Object.assign({ exclusive: true }, floorOpts));
        if (r === 'exists') { skip(entry, 'appeared while it was being created (create-if-absent: never overwritten)', sha256(out)); continue; }
        applied.push(entry.rel); created.push(entry.rel);
        journal({ rel: entry.rel, action: 'created', hash: writtenHash });
      } else {
        let r = 'written';
        if (copyFileImpl) copyFileImpl(src, out); else r = writeBytesNoFollow(buf, out, dst, Object.assign({ expectOldHash: entry.oldHash }, floorOpts)); // re-hashed right before the rename
        if (r === 'changed') { skip(entry, 'changed while it was being replaced (re-hashed right before the rename) — never overwritten', sha256(out)); continue; }
        applied.push(entry.rel);
        journal({ rel: entry.rel, action: 'written', hash: writtenHash });
      }
      // a verification READ after the rename — on a mismatch the file is NOT written again ("repaired"); someone
      // else is writing here right now. Reported as changed-during-write; the caller rolls back its own writes and the
      // divergence check keeps the newer bytes.
      const after = sha256(out);
      if (after !== writtenHash) {
        changedDuringWrite.push({ rel: entry.rel, written: writtenHash, observed: after });
        return done({ ok: false, applied, created, skipped, error: 'changed-during-write: ' + entry.rel + ' no longer holds the bytes this sync just wrote (another writer is active) — not overwritten again; stop the writer and re-run' });
      }
    }
    return done({ ok: true, applied, created, skipped, needsReview: skipped.length > 0 });
  } catch (e) {
    return done({ ok: false, applied, created, skipped, error: e.message });
  }
}

// ---- validation: H4 evidence-based gate + H3 pre/post baseline comparison ----
// build a human-copy-pasteable command STRING from an argv array with proper quoting — naive string
// concatenation breaks on a project path containing a space and/or a "!" (e.g. "my project!").
function quoteArg(a) {
  const s = String(a);
  return /[\s"!]/.test(s) ? ('"' + s.replace(/"/g, '\\"') + '"') : s;
}
function cmdArrToString(execPath, argsArr) { return [execPath].concat(argsArr).map(quoteArg).join(' '); }

/** evidenceOk — H4: a forge-doctor --json report is only trusted when it shows POSITIVE evidence of having
 *  actually run real checks: node_check covered at least as many files as we just synced, AND at least one
 *  test suite ran with at least one passing assertion. A 0-files/0-suites "pass" is rejected outright. */
/** evidenceGap(parsed, minCjsCount) -> null when evidenceOk, else the one plain reason the report is not trusted
 *  (category tests F5d, 2026-11-07: every fresh install was refused with "--json missing/unparsable/0-count" while
 *  the real reason was node_check 444 < 461 files written, which cost an hour to find). */
function evidenceGap(parsed, minCjsCount) {
  if (!parsed || typeof parsed !== 'object') return 'the doctor gave no --json report (missing or unparsable)';
  if (!parsed.checks) return 'the doctor --json report has no checks';
  const nc = parsed.checks.node_check, ts = parsed.checks.tests;
  if (!nc || typeof nc.total !== 'number') return 'the doctor report has no node_check count';
  if (nc.total < minCjsCount) return 'node_check covered ' + nc.total + ' file(s) but this sync wrote ' + minCjsCount + ' .cjs file(s)';
  if (!ts || typeof ts.suites !== 'number' || ts.suites <= 0) return 'the doctor ran no test suite';
  if (typeof ts.passed !== 'number' || ts.passed <= 0) return 'the doctor recorded no passing test';
  return null;
}
function evidenceOk(parsed, minCjsCount) {
  if (!parsed || typeof parsed !== 'object' || !parsed.checks) return false;
  const nc = parsed.checks.node_check, ts = parsed.checks.tests;
  if (!nc || typeof nc.total !== 'number' || nc.total < minCjsCount) return false;
  if (!ts || typeof ts.suites !== 'number' || ts.suites <= 0) return false;
  if (typeof ts.passed !== 'number' || ts.passed <= 0) return false;
  return true;
}
/** condenseDoctorSummary — B1 FIX: forge-doctor emits EIGHT checks (node_check, tests, strict_events,
 *  dashboard_spa, leak_scan, agents, chain, rebinding_guard) and its top-level `ok` is the AND of all eight.
 *  The OLD code only ever kept node_check + tests, so docCheckOkMap/regressionCheck could NEVER see a
 *  regression on any of the other 6 checks (e.g. a sync-caused break in dashboard_spa or rebinding_guard —
 *  both files THIS tool syncs — would be silently waved through as "already-red, not attributed to this
 *  sync"). Now carries {ok} for EVERY key actually present in parsed.checks, generically, plus the
 *  node_check/tests detail fields kept for existing consumers (evidenceOk, printSafeSyncResult, etc). */
function condenseDoctorSummary(parsed) {
  if (!parsed || !parsed.checks) return null;
  const c = parsed.checks;
  const pick = (obj, keys) => { if (!obj) return null; const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; };
  const checksOk = {};
  for (const k of Object.keys(c)) checksOk[k] = { ok: !!(c[k] && c[k].ok) };
  // OPERABILITEIT (a card-game project-vloot-diagnose): de samenvatting verzweeg WELKE suites rood of
  // geblokkeerd (per-suite timeout) waren — een install meldde alleen "forge-doctor, exit 1" en elke
  // diagnose moest de hele doctor handmatig herdraaien. De namen van falende/geblokkeerde suites reizen
  // nu mee (afgekapt tot 8), en 'blocked' telt zichtbaar mee: de doctor rekent een geblokkeerde suite
  // terecht als niet-groen, dus de samenvatting mag dat niet verstoppen.
  // WP-SYNC-R7 (26H2 rehearsal): the list was cut at 8 names, and nothing below the `tests` check was compared — 4 suites
  // went red during a sync while `tests` was already red and nobody saw it. Now EVERY suite travels: failing_suites is the
  // full list (name + count, no cap) and suiteOk maps every suite NAME to green/not-green (names only, no failure text), so
  // regressionCheck can see a single suite go green -> red or turn up red for the first time.
  const failing = [];
  const suiteOk = {};
  // WP-SYNC-R9: per RED suite, what the doctor itself kept — its counts and the failing-test lines forge-doctor prints into
  // perSuite[].failures (the doctor keeps at most 5 lines of 200 characters, already redacted; re-scrubbed here with the same
  // scrubber). Before this the summary held counts only, so a rolled-back install could not say WHICH assertion failed.
  const suiteFailures = {};
  const scrub = loadDoctorScrubber();
  let failuresWithheld = false;
  const entries = c.tests && Array.isArray(c.tests.perSuite) ? c.tests.perSuite.map((s) => [s && s.suite, s])
    : (c.tests && c.tests.perSuite && typeof c.tests.perSuite === 'object' ? Object.entries(c.tests.perSuite).map(([k, s]) => [(s && s.suite) || k, s]) : []);
  for (const [nameIn, sIn] of entries) {
    const s = sIn && typeof sIn === 'object' ? sIn : {};
    const name = typeof nameIn === 'string' && nameIn ? nameIn : '?';
    const red = (s.failed || 0) > 0 || !!s.timedOut || !!s.blocked || s.ok === false;
    suiteOk[name] = !red && suiteOk[name] !== false; // a duplicate name stays red once any copy is red
    if (red) failing.push(name + ((s.failed || 0) > 0 ? ' (' + s.failed + ' failed)' : (s.timedOut || s.blocked ? ' (blocked/timeout)' : ' (suite ok:false — non-zero exit of lege testrun)')));
    if (red && !Object.prototype.hasOwnProperty.call(suiteFailures, name)) {
      const scrubbed = scrubFailLines(Array.isArray(s.failures) ? s.failures : [], scrub);
      if (scrubbed.withheld) failuresWithheld = true;
      suiteFailures[name] = {
        passed: Number.isFinite(s.passed) ? s.passed : null, failed: Number.isFinite(s.failed) ? s.failed : null,
        timedOut: !!(s.timedOut || s.blocked), lines: scrubbed.lines,
      };
    }
  }
  return {
    ok: parsed.ok,
    node_check: pick(c.node_check, ['ok', 'total', 'failed']),
    tests: pick(c.tests, ['ok', 'suites', 'passed', 'failed', 'suitesFailed', 'suitesBlocked']),
    ...(failing.length ? { failing_suites: failing } : {}),
    ...(entries.length ? { suiteOk } : {}),
    ...(Object.keys(suiteFailures).length ? { suiteFailures } : {}),
    ...(failuresWithheld ? { suiteFailuresWithheld: SCRUBBER_MISSING_REASON } : {}),
    checksOk, // B1: EVERY doctor check's {ok}, not just node_check/tests -> regressionCheck can see all 8
  };
}
// ---- WP-SYNC-R9: failing-assertion lines + isolated re-run -----------
// FOUND during the real 26H2 install: three suites were red inside the post-sync doctor run (forge-gate-hook.test green->red,
// forge-gate-secretprint.test green->red, forge-stop-obligations.test red for the first time) and 173 files were rolled back,
// yet each of the three passed when run alone with the same files. The sync report kept counts only, so WHAT failed was lost.
// Two answers: every flagged suite now carries its failing lines (result, change report, receipt), and before a SUITE-ONLY
// regression rolls back, each flagged suite is re-run ONCE, alone, from the synced project (confirmSuiteRegressions below).
/** The failing-line shape forge-doctor's failingTestNames() reads (forge-doctor.cjs FAIL_LINE_RE): this project's `  FAIL <name>`,
 *  node:test's `not ok`, or a cross mark. */
const SUITE_FAIL_LINE_RE = /^\s*(?:FAIL\b|not ok\b|✖|✗)/;
const SUITE_FAIL_LINES_MAX = 12;
const SUITE_FAIL_LINE_MAX_CHARS = 300;
const SUITE_FAIL_TAIL_MAX = 3; // a run that printed no FAIL line at all (a crash): its last few output lines instead
const SCRUBBER_MISSING_REASON = 'forge-store.cjs (the scrubber forge-doctor uses) could not be loaded — the lines are withheld, never shown unscrubbed';
let doctorScrubber; // undefined = not tried yet; null = unavailable
/** loadDoctorScrubber() -> forge-store.cjs redactText (the function forge-doctor.cjs runs over every failing-test line), or null. */
function loadDoctorScrubber() {
  if (doctorScrubber !== undefined) return doctorScrubber;
  try { const st = require('./forge-store.cjs'); doctorScrubber = typeof st.redactText === 'function' ? st.redactText : null; } catch { doctorScrubber = null; }
  return doctorScrubber;
}
/** scrubFailLines(lines, scrub) -> {lines, withheld} — trim, scrub, THEN cut to 300 characters (cutting first could split a
 *  secret so the pattern no longer sees it), at most 12 lines. No scrubber -> nothing is returned (fail closed). */
function scrubFailLines(lines, scrub) {
  const list = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === 'string' && l.trim()).slice(0, SUITE_FAIL_LINES_MAX);
  if (!list.length) return { lines: [], withheld: false };
  if (typeof scrub !== 'function') return { lines: [], withheld: true };
  const out = [];
  for (const l of list) {
    let s;
    try { s = scrub(l.trim()); } catch { return { lines: [], withheld: true }; }
    out.push(String(s == null ? '' : s).slice(0, SUITE_FAIL_LINE_MAX_CHARS));
  }
  return { lines: out, withheld: false };
}
/** suiteOutputFailLines(out) -> the failing lines in `out`, at most 12. Not a scrubber: what it returns is only ever shown when
 *  `out` was ALREADY redacted as a whole (redactSuiteOutput); on raw output it is used for counting only. */
function suiteOutputFailLines(out) {
  return String(out || '').split(/\r?\n/).filter((l) => SUITE_FAIL_LINE_RE.test(l)).slice(0, SUITE_FAIL_LINES_MAX);
}
/** suiteOutputTail(out) — for a failed run that printed no FAIL line (a crash): the first thrown-error lines ("Error: ...",
 *  "TypeError: ...") when there are any, else the last non-empty output lines; at most 3 (same rule as above: shown only from
 *  output that was redacted as a whole first). */
const SUITE_ERROR_LINE_RE = /^\s*(?:[A-Z][A-Za-z]*Error\b|Error\b|Uncaught\b)/;
function suiteOutputTail(out) {
  const lines = String(out || '').split(/\r?\n/).filter((l) => l.trim());
  const errs = lines.filter((l) => SUITE_ERROR_LINE_RE.test(l));
  return errs.length ? errs.slice(0, SUITE_FAIL_TAIL_MAX) : lines.slice(-SUITE_FAIL_TAIL_MAX);
}
/** suiteTally(out) -> {parsed, passed, failed} (+ ambiguous, tallies when it refuses). WP-SYNC-R10: the caller
 *  passes the suite's STDOUT only (stderr can carry anything — a child harness, a warning that happens to look like a tally).
 *  Every line that STARTS with "<n> passed, <m> failed" is a tally line (a description mentioning one mid-line never counts).
 *  Exactly ONE distinct tally is accepted — the same line printed twice is still one; two or more DIFFERENT tallies are
 *  ambiguous and nothing is parsed (forge-doctor itself takes the last one; a sync that turns a red doctor run into a kept
 *  install must not decide on "the last of several"). */
function suiteTally(out) {
  const re = /^\s*(\d+)\s+passed,\s+(\d+)\s+failed\b/gm;
  const seen = new Map();
  let tm;
  while ((tm = re.exec(String(out || ''))) !== null) { const k = Number(tm[1]) + '/' + Number(tm[2]); if (!seen.has(k)) seen.set(k, { passed: Number(tm[1]), failed: Number(tm[2]) }); }
  if (seen.size === 1) { const v = [...seen.values()][0]; return { parsed: true, passed: v.passed, failed: v.failed }; }
  if (!seen.size) return { parsed: false, passed: 0, failed: 0 };
  return { parsed: false, passed: 0, failed: 0, ambiguous: true, tallies: [...seen.keys()].slice(0, 5) };
}
// ---- WP-SYNC-R10: the WHOLE output is redacted before a single line is picked ---------------------------------
// R9 split a suite's output into lines first and scrubbed the picked lines one by one: a multi-line PEM block was never seen
// whole, so its base64 body lines survived, and a crash "tail" (the last 3 lines of arbitrary output) could be exactly that body.
const CREDENTIAL_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{1,64}-----/;
const CREDENTIAL_END_RE = /-----END [A-Z0-9 ]{1,64}-----/;
const CREDENTIAL_BLOCK_MARK = '***REDACTED*** (credential block)';
const UNTERMINATED_BLOCK_MARK = '[output withheld from here to the end: an unterminated -----BEGIN ...----- credential block]';
const REDACT_LINE_MAX_CHARS = 40000; // forge-store redactText reads at most 50,000 characters per call
const REDACT_PIECE_MAX_CHARS = 40000;
const REDACT_WINDOW_MAX_CHARS = 48000;
const REDACT_CONTEXT_LINES = 3;
/** stripCredentialBlocks(text) -> {text, blocks, unterminated} — every `-----BEGIN <label>-----` ... `-----END <label>-----` region
 *  (whole lines, across any number of lines) becomes ONE marker line; a BEGIN with no END after it cuts the text at the start of
 *  its line — everything from there to the end is withheld (never shown, not even as a "tail"). Any label counts (RSA / EC /
 *  OPENSSH / PGP private keys, certificates): stricter than the private-key pattern, never looser. Linear: one pass. */
function stripCredentialBlocks(text) {
  let s = String(text == null ? '' : text);
  let out = '', blocks = 0, unterminated = false;
  for (;;) {
    const m = CREDENTIAL_BEGIN_RE.exec(s);
    if (!m) { out += s; break; }
    const lineStart = s.lastIndexOf('\n', m.index) + 1;
    const after = m.index + m[0].length;
    const e = CREDENTIAL_END_RE.exec(s.slice(after));
    if (!e) { out += s.slice(0, lineStart); unterminated = true; break; }
    const endAbs = after + e.index + e[0].length;
    const nl = s.indexOf('\n', endAbs);
    out += s.slice(0, lineStart) + CREDENTIAL_BLOCK_MARK;
    blocks++;
    s = nl === -1 ? '' : s.slice(nl); // keeps the newline that ended the END line
  }
  return { text: out, blocks, unterminated };
}
/** redactSuiteOutput(text, scrub) -> {lines, withheld, unterminated, blocks} — the whole output, redacted, as lines. (1) credential
 *  blocks are cut out whole (stripCredentialBlocks); (2) the rest goes through the scrubber (forge-store redactText) in
 *  line-aligned pieces of at most 40,000 characters (redactText reads at most 50,000), each preceded by up to 3 earlier lines as
 *  context, so a label on one line and its value on the next ("password:" / "<value>") are seen together; only the piece's own
 *  lines are kept, counted from the END of the redacted window — a redaction that joins two lines can then only repeat an
 *  already-redacted context line, never expose an unredacted one. A single line over 40,000 characters is withheld whole.
 *  No scrubber, or one that throws -> {lines: [], withheld: true} (fail closed). */
function redactSuiteOutput(text, scrub) {
  const stripped = stripCredentialBlocks(String(text == null ? '' : text).replace(/\r\n?/g, '\n'));
  if (typeof scrub !== 'function') return { lines: [], withheld: true, unterminated: stripped.unterminated, blocks: stripped.blocks };
  const raw = stripped.text.split('\n').map((l) => (l.length > REDACT_LINE_MAX_CHARS ? '[a line of ' + l.length + ' characters — withheld (too long to redact as one piece)]' : l));
  const out = [];
  try {
    let i = 0;
    while (i < raw.length) {
      let j = i, size = 0;
      while (j < raw.length && (j === i || size + raw[j].length + 1 <= REDACT_PIECE_MAX_CHARS)) { size += raw[j].length + 1; j++; }
      const ctx = [];
      let ctxSize = 0;
      for (let k = i - 1; k >= 0 && ctx.length < REDACT_CONTEXT_LINES && size + ctxSize + raw[k].length + 1 <= REDACT_WINDOW_MAX_CHARS; k--) { ctx.unshift(raw[k]); ctxSize += raw[k].length + 1; }
      const piece = raw.slice(i, j);
      const red = String(scrub(ctx.concat(piece).join('\n'))).split('\n');
      for (const l of red.slice(Math.max(0, red.length - piece.length))) out.push(l);
      i = j;
    }
  } catch { return { lines: [], withheld: true, unterminated: stripped.unterminated, blocks: stripped.blocks }; }
  if (stripped.unterminated) out.push(UNTERMINATED_BLOCK_MARK);
  return { lines: out, withheld: false, unterminated: stripped.unterminated, blocks: stripped.blocks };
}
/** scrubOneLine(s, scrub) — WP-SYNC-R10: an error / reason string that may quote external text (a spawn error, the
 *  pool's error, a thrown message) goes through the same redactor, THEN is cut to 300 characters; without a scrubber it is
 *  withheld (never shown raw). */
function scrubOneLine(s, scrub) {
  if (s == null || s === '') return s == null ? null : '';
  if (typeof scrub !== 'function') return '[withheld: ' + SCRUBBER_MISSING_REASON + ']';
  try {
    const r = redactSuiteOutput(String(s), scrub);
    if (r.withheld) return '[withheld: the redactor failed on this text]';
    return r.lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, SUITE_FAIL_LINE_MAX_CHARS);
  } catch { return '[withheld: the redactor failed on this text]'; }
}
/** suiteRegressions(preSummary, postSummary) -> [{suite, kind:'green->red'|'red for the first time'}] — WP-SYNC-R7: per SUITE,
 *  a suite that is red after the sync while it was green before, or that is red and did not exist before (a suite the sync
 *  itself shipped). A suite red before AND after is pre-existing (not attributed); a suite that vanished is not judged here.
 *  Needs the per-suite map on BOTH sides (condenseDoctorSummary's suiteOk); a summary without one (an older receipt, a
 *  doctor that reports no per-suite list) cannot be compared per suite, and the check-level comparison stands alone. */
function suiteRegressions(preSummary, postSummary) {
  const map = (s) => (s && s.suiteOk && typeof s.suiteOk === 'object' && !Array.isArray(s.suiteOk) ? s.suiteOk : null);
  const pre = map(preSummary), post = map(postSummary);
  if (!pre || !post) return [];
  const out = [];
  for (const name of Object.keys(post).sort()) {
    if (post[name] !== false) continue;
    if (pre[name] === true) out.push({ suite: name, kind: 'green->red' });
    else if (!Object.prototype.hasOwnProperty.call(pre, name)) out.push({ suite: name, kind: 'red for the first time' });
  }
  return out;
}
/** docCheckOkMap — B1 FIX: iterate ALL checks carried in summary.checksOk (every key forge-doctor emitted),
 *  not a hardcoded {node_check, tests} pair. Falls back to the legacy node_check/tests-only shape for a
 *  summary produced before this fix (e.g. a receipt persisted by an older sync run), so old receipts don't
 *  crash a later regressionCheck call. */
function docCheckOkMap(summary) {
  const out = {};
  if (summary && summary.checksOk && typeof summary.checksOk === 'object') {
    for (const k of Object.keys(summary.checksOk)) out[k] = !!summary.checksOk[k].ok;
  } else {
    if (summary && summary.node_check) out.node_check = !!summary.node_check.ok;
    if (summary && summary.tests) out.tests = !!summary.tests.ok;
  }
  if (summary) out.overall = summary.ok !== false;
  return out;
}
/** regressionCheck — H3/B1: a check that was RED before this sync and is STILL red after is not a new
 *  problem caused by the sync; a check that was GREEN before and is RED after on ANY of forge-doctor's
 *  checks (not just node_check/tests) is a genuine regression.
 *  MEDIUM FIX: a check that did NOT EXIST in the pre-sync doctor
 *  at all (`pre[k] === undefined`) — i.e. a check the sync ITSELF just introduced, by writing a new
 *  forge-doctor.cjs that emits a check the old one never had — must ALSO count as a regression when it is
 *  red post-sync. The old condition (`pre[k] === true && post[k] === false`) only fired on a genuine
 *  green->red flip of a check present BOTH times; a check absent pre-sync could never satisfy `pre[k] ===
 *  true`, so a brand-new-and-already-red check was silently swallowed by the "already-red, not attributed
 *  to this sync" exemption below (decideValidationOutcome) even though nothing was ever green to compare
 *  against — "absent" must be treated as "was not red" (there is nothing yet to be already-red about), so a
 *  new+red check is exactly as much a regression as an old green check turning red. A check that already
 *  existed and was ALREADY red both before and after (`pre[k] === false && post[k] === false`) remains
 *  correctly exempted — this is the pre-existing-redness case the already-red logic exists to protect,
 *  and is intentionally NOT touched by this fix.
 *
 *  MEDIUM FIX: the round-1 fix above only ever iterates
 *  `Object.keys(post)`, so it can only ever notice a check that is STILL PRESENT post-sync (red, new, or
 *  otherwise). A check that existed pre-sync and was GREEN, but is entirely ABSENT from post-sync's
 *  checksOk (the new forge-doctor.cjs simply stopped emitting that check-key at all — a sync deleting or
 *  silently degrading a check), can never be seen by that loop at all: it never appears in
 *  `Object.keys(post)`, so `post[k]` is never even evaluated for it. A validator quietly LOSING a check is
 *  exactly as dangerous as it flipping red — a sync must never be allowed to "fix" a regression by simply
 *  making the doctor stop reporting on it. Fix: a SECOND pass over `Object.keys(pre)` flags any key that was
 *  `true` pre-sync and is `undefined` (absent) post-sync. The full, precise truth table this function now
 *  implements: pre green + post absent = FAILURE (this fix); pre absent + post red = FAILURE (round-1 fix,
 *  unchanged above); pre red + post red (same key present both times) = already-red, exempted (unchanged);
 *  pre red + post green/absent = improvement, not a regression (unchanged — dropping an already-broken
 *  check, or fixing it, is never itself a new problem). */
function regressionCheck(preSummary, postSummary) {
  const pre = docCheckOkMap(preSummary), post = docCheckOkMap(postSummary);
  const regressed = [];
  for (const k of Object.keys(post)) {
    if (post[k] === false && (pre[k] === true || pre[k] === undefined)) regressed.push(k);
  }
  for (const k of Object.keys(pre)) {
    if (pre[k] === true && post[k] === undefined) regressed.push(k);
  }
  // WP-SYNC-R7: below the check level, every SUITE too — a suite that went green -> red, or is red for the first time, is a
  // regression even while the `tests` check was already red before the sync (entries read 'suite:<name>').
  for (const s of suiteRegressions(preSummary, postSummary)) regressed.push('suite:' + s.suite);
  return regressed;
}
function runDoctorJson(projectDir, doctorPath, timeoutMs) {
  const argsArr = ['--root', projectDir, '--json'];
  const started = Date.now();
  // WP-SYNC-R7: the doctor's --json report of a 155-suite project is large; never let the 1 MB default cut it into "no evidence"
  const r = spawnSync(process.execPath, [doctorPath].concat(argsArr), { cwd: projectDir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  const durationMs = Date.now() - started; // WP-SYNC-R7: the measured wall time, recorded on the result and in the report
  const exitCode = r.status == null ? 1 : r.status;
  // spawnSync sets status:null + a kill signal (or r.error.code === 'ETIMEDOUT') when its timeout fires —
  // treat that as BLOCKED (couldn't confirm), never as a confirmed validation failure.
  const timedOut = r.status === null && (!!r.signal || (r.error && r.error.code === 'ETIMEDOUT'));
  let parsed = null; try { parsed = JSON.parse(r.stdout || ''); } catch { parsed = null; }
  return { exitCode, parsed, timedOut, signal: r.signal || null, cmdArgs: [doctorPath].concat(argsArr), durationMs, startedAtMs: started };
}
/** runValidation — the gate for "did this sync leave the project provably OK". opts.doctorTimeoutMs
 *  overrides the default limit (doctorTimeoutFor: DEFAULT_DOCTOR_TIMEOUT_MS = 1800 s, or 12 s per suite when that is more;
 *  `--doctor-timeout` makes this a real, settable flag). The result carries durationMs, timeoutMs and timeoutSource. */
/** doctorProvenance — WHO WROTE THE GATE (broad Codex audit #2).
 *  The install validated itself with `<project>/.claude/forge-bin/forge-doctor.cjs` — a file this very sync
 *  had just written. That is fine while the doctor really is the template's, but system files can legally
 *  be SKIPPED (a forge-overrides.json entry, unresolved unknown_drift, a conflict), and a skipped doctor is
 *  the PROJECT's own. A project holding a stub doctor that prints plausible JSON and exits 0 would then
 *  approve every future sync into itself, forever, and the receipt would read "validated". The gate would
 *  be authored by the thing it is gating. We hash the doctor that is about to run against the template's
 *  and say plainly which one it is; only a byte-identical template doctor counts as the trusted gate. */
/** doctorTreeHash — WP A11 part 2 (Lead, Review Boss HIGH): since the split, almost every check lives in
 *  forge-bin/doctor/*.cjs. A gate that hashed only forge-doctor.cjs would accept a project whose doctor/checks-core.cjs
 *  was edited to always pass. So the trusted-gate hash covers the ROOT plus every module, sorted by name, each with
 *  sha256Normalized (EOL-insensitive), and the module NAMES are part of the digest: a module present on one side only
 *  can never hash equal. Returns { hash, modules, missing } — missing names a file that exists but cannot be read. */
function doctorTreeHash(doctorFile) {
  const modDir = path.join(path.dirname(doctorFile), 'doctor');
  let names = [];
  try { names = fs.readdirSync(modDir).filter((n) => /\.cjs$/.test(n) && !/\.test\.cjs$/.test(n)).sort(); } catch { names = []; }
  const root = sha256Normalized(doctorFile);
  if (!root) return { hash: null, modules: names, missing: ['forge-doctor.cjs'] };
  const h = crypto.createHash('sha256');
  h.update('forge-doctor.cjs:' + root);
  for (const n of names) {
    const m = sha256Normalized(path.join(modDir, n));
    if (!m) return { hash: null, modules: names, missing: ['doctor/' + n] };
    h.update('|doctor/' + n + ':' + m);
  }
  return { hash: h.digest('hex'), modules: names, missing: [] };
}
function doctorProvenance(projectDir, templateDir) {
  const rel = path.join('forge-bin', 'forge-doctor.cjs');
  const projectDoctor = path.join(claudeDirOf(projectDir), rel);
  if (!fs.existsSync(projectDoctor)) return { kind: 'absent' };
  if (!templateDir) return { kind: 'unknown', reason: 'no template directory was given, so the doctor could not be compared with the canonical one' };
  const templateDoctor = path.join(templateDir, rel);
  if (!fs.existsSync(templateDoctor)) return { kind: 'unknown', reason: 'the template ships no forge-doctor.cjs to compare against' };
  const a = doctorTreeHash(projectDoctor), b = doctorTreeHash(templateDoctor);
  const onlyProject = a.modules.filter((n) => !b.modules.includes(n)), onlyTemplate = b.modules.filter((n) => !a.modules.includes(n));
  if (onlyProject.length || onlyTemplate.length) {
    return { kind: 'project-local', projectHash: a.hash, templateHash: b.hash, reason: 'the doctor module set differs from the template (only in project: ' + (onlyProject.join(', ') || '-') + '; only in template: ' + (onlyTemplate.join(', ') || '-') + ') — an install may not be approved by a gate the project itself authored' };
  }
  if (a.hash && b.hash && a.hash === b.hash) return { kind: 'template', hash: a.hash, modules: a.modules.length };
  return { kind: 'project-local', projectHash: a.hash, templateHash: b.hash, reason: 'the doctor in this project (forge-doctor.cjs or one of its doctor/*.cjs modules' + (a.missing.length ? '; unreadable: ' + a.missing.join(', ') : '') + ') is NOT the template doctor (it was overridden, drifted or skipped) — an install may not be approved by a gate the project itself authored' };
}
/** installerSyntaxGate — the one check the doctor cannot fake, because the INSTALLER runs it: every .cjs
 *  this sync wrote must parse under this Node runtime. It is a floor, not a substitute for the doctor —
 *  but it holds even when the doctor is missing, lying, or the project's own (audit #2). */
function installerSyntaxGate(projectDir, cjsRels) {
  const failures = [], commands = [];
  for (const rel of cjsRels) {
    const out = safeJoin(claudeDirOf(projectDir), rel);
    const argsArr = ['--check', out];
    commands.push(cmdArrToString(process.execPath, argsArr));
    const r = spawnSync(process.execPath, argsArr, { encoding: 'utf8' });
    if (r.status !== 0) failures.push(rel);
  }
  return { checked: cjsRels.length, failures, commands };
}
/** DEFAULT_DOCTOR_TIMEOUT_MS — 30 minutes (WP-SYNC-R7, was 15 minutes / SYNC-10). The real doctor
 *  runs every forge-bin suite (the doctor gives each suite up to 1500 s, FORGE_DOCTOR_SUITE_TIMEOUT_MS overrides it). The 26H2
 *  rehearsal measured 791-1091 s per full doctor run on 155 suites and one install timed out at the old 900 s, rolling a
 *  good sync back as "could not confirm". Without --doctor-timeout the limit is the LARGER of this default and
 *  DOCTOR_TIMEOUT_PER_SUITE_MS per *.test.cjs suite in the project's forge-bin (doctorTimeoutFor), so a growing suite count
 *  raises it by itself. `--doctor-timeout <ms>` still overrides both. Every validation records its measured duration and
 *  the limit it ran under (runValidation -> durationMs/timeoutMs, printed in the change report). */
const DEFAULT_DOCTOR_TIMEOUT_MS = 1800000;
const DOCTOR_TIMEOUT_PER_SUITE_MS = 12000;
/** doctorTimeoutFor(projectDir, doctorTimeoutMs) -> {timeoutMs, source:'flag'|'default'|'suite-count', suites}: the explicit
 *  --doctor-timeout when given, else the larger of DEFAULT_DOCTOR_TIMEOUT_MS and 12 s per *.test.cjs in <project>/.claude/forge-bin. */
function doctorTimeoutFor(projectDir, doctorTimeoutMs) {
  const explicit = Number.isFinite(doctorTimeoutMs) && doctorTimeoutMs > 0;
  const base = explicit ? doctorTimeoutMs : DEFAULT_DOCTOR_TIMEOUT_MS;
  if (explicit) return { timeoutMs: base, source: 'flag', suites: null };
  let suites = 0;
  try { suites = fs.readdirSync(path.join(claudeDirOf(projectDir), 'forge-bin')).filter((n) => n.endsWith('.test.cjs')).length; } catch { suites = 0; }
  const bySuites = suites * DOCTOR_TIMEOUT_PER_SUITE_MS;
  return bySuites > base ? { timeoutMs: bySuites, source: 'suite-count', suites } : { timeoutMs: base, source: 'default', suites };
}
function runValidation(projectDir, plan, opts) {
  opts = opts || {};
  const limit = doctorTimeoutFor(projectDir, opts.doctorTimeoutMs); // WP-SYNC-R7: >= DEFAULT_DOCTOR_TIMEOUT_MS unless --doctor-timeout
  const timeoutMs = limit.timeoutMs;
  const doctorPath = path.join(claudeDirOf(projectDir), 'forge-bin', 'forge-doctor.cjs');
  const cjsRels = (plan.toChange || []).map((e) => e.rel).filter((rel) => rel.endsWith('.cjs'));
  // ALWAYS run the installer-owned syntax gate first, whatever the doctor is going to say. A file that
  // does not parse is broken no matter which doctor validates it, and this result is ours, not the
  // doctor's — so a self-approving doctor still cannot turn a broken sync green.
  const syntax = installerSyntaxGate(projectDir, cjsRels);
  const provenance = doctorProvenance(projectDir, opts.templateDir);
  if (syntax.failures.length) {
    return {
      tool: 'installer-syntax-gate', exitCode: 1, ok: false, commands: syntax.commands,
      syntaxGate: syntax, doctorProvenance: provenance.kind,
      reason: syntax.failures.length + ' just-synced .cjs file(s) do not parse (' + syntax.failures.join(', ')
        + ') — the installer checked this itself; no doctor verdict can override it',
    };
  }
  if (fs.existsSync(doctorPath)) {
    const { exitCode, parsed, timedOut, signal, cmdArgs, durationMs, startedAtMs } = runDoctorJson(projectDir, doctorPath, timeoutMs);
    const commandStr = cmdArrToString(process.execPath, cmdArgs);
    // WP-SYNC-R7: how long the doctor really took, and under which limit (flag / default / derived from the suite count)
    // WP-SYNC-R9: startedAtMs bounds the doctor's own per-suite duration hint (doctorSuiteDurationHint)
    const base = { tool: 'forge-doctor', doctorProvenance: provenance.kind, syntaxGate: syntax, durationMs, timeoutMs, timeoutSource: limit.source, startedAtMs };
    if (timedOut) return { ...base, exitCode, ok: false, timedOut: true, signal, commands: [commandStr] };
    if (parsed && evidenceOk(parsed, cjsRels.length)) {
      // Only a doctor that DIFFERS from a template doctor that actually exists is the hole this closes:
      // the project overrode/skipped the canonical gate and would then approve its own installs. When the
      // template ships no doctor at all ('unknown'), this sync did not install the gate, so it is not the
      // "gated by its own artifact" case — it is still recorded on the result, never silently dropped.
      const trusted = provenance.kind !== 'project-local';
      const ok = exitCode === 0 && parsed.ok !== false;
      if (ok && !trusted) {
        // The doctor said yes, but it is not the canonical one. That is a DEGRADED pass — it still has to
        // clear the installer's own syntax gate (it did, above), and decideValidationOutcome's existing
        // degraded handling decides whether a degraded pass is acceptable for this run.
        return {
          ...base, exitCode, ok: true, degraded: true, commands: [commandStr], summary: condenseDoctorSummary(parsed),
          reason: 'validated by a doctor that is not the template doctor — ' + (provenance.reason || 'provenance ' + provenance.kind)
            + '; the independent evidence for this install is the installer syntax gate over ' + syntax.checked + ' file(s)',
        };
      }
      return { ...base, exitCode, ok, commands: [commandStr], summary: condenseDoctorSummary(parsed) };
    }
    return {
      ...base, exitCode, ok: false, noEvidence: true, commands: [commandStr], summary: condenseDoctorSummary(parsed),
      reason: 'forge-doctor gave no positive evidence (' + (evidenceGap(parsed, cjsRels.length) || '--json missing/unparsable/0-count') + ') — refusing to trust a bare exit code',
    };
  }
  // DEGRADED fallback: no forge-doctor present -> the installer syntax gate is all we have, and it passed.
  return {
    tool: 'node-check-fallback', exitCode: 0, ok: true, degraded: true, checked: syntax.checked, failures: [],
    commands: syntax.commands, syntaxGate: syntax, doctorProvenance: provenance.kind,
  };
}
/** seedCanaryRun — CANARY-ONLY, opt-in via opts.seedRunForValidation (set ONLY on the dedicated canary's own
 *  sync options in runSyncAll, NEVER for a real project's syncOpts). WHY THIS EXISTS (root cause, found via
 *  direct repro 2026-07-26): the dedicated canary is wiped fresh on every canary-init/sync-all run and
 *  therefore NEVER accumulates any forge-runs/ history of its own — but the REAL forge-doctor.cjs this tool
 *  syncs into it runs the project's REAL *.test.cjs suite, and at least one real, non-fabricated test
 *  (forge-capabilities-panel.test.cjs) has a genuine precondition of "at least one real run with
 *  events.jsonl exists in this project" — true for every actual Forge project (they accumulate real run
 *  history through real /forge usage) but structurally impossible for a scaffold that is deleted and
 *  recreated empty every single time. That is not a template defect; it is the canary's own environment
 *  missing something every real project already has. Confirmed with `preValidation` ALWAYS degraded for the
 *  canary too (no doctor exists pre-sync in a freshly wiped scaffold), so decideValidationOutcome's existing
 *  "already-red / pre-existing, not attributed to this sync" exemption can never fire for it either — this
 *  precondition would fail EVERY canary run, for every template, forever, with no rescue path.
 *  THE FIX: after this sync's files are applied but BEFORE post-sync validation runs, log ONE real, honestly
 *  described `run_started` event into the JUST-SYNCED project's own forge-runs/ via ITS OWN freshly-copied
 *  forge-dashboard/log-event.cjs (never a template copy, never a hand-crafted file — going through the exact
 *  same strict-mode honesty gate a real event would, so this can never smuggle in something that would fail
 *  STRICT). The canary genuinely WAS just initialized — recording that fact is accurate, not fabricated. This
 *  makes the precondition honestly, unconditionally TRUE (not merely exempted-as-pre-existing), so a
 *  template that is actually broken still fails the doctor for real reasons, and a genuinely safe template
 *  now gets an honest, unconditional pass instead of being blocked by an environment gap unrelated to it.
 *  Best-effort and silent-no-op when the just-synced project has no forge-dashboard/log-event.cjs at all
 *  (e.g. a minimal test-fixture template that ships no dashboard) — the SAME "the canary can't be blocked by
 *  a capability its template doesn't ship" leniency already established for --allow-degraded above, not a new
 *  bypass. Never throws; a failed/skipped seed simply leaves the real (honest) gap to surface as it always
 *  did. */
function seedCanaryRun(projectDir, batchId, nowIso) {
  const logEventPath = path.join(claudeDirOf(projectDir), 'forge-dashboard', 'log-event.cjs');
  if (!fs.existsSync(logEventPath)) return { ok: false, skipped: true, reason: 'no forge-dashboard/log-event.cjs synced into this project — leniently skipped' };
  const rawId = 'canary-init-' + String(batchId || nowIso || Date.now());
  const runId = rawId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || ('canary-init-' + Date.now());
  const payload = JSON.stringify({
    note: 'dedicated sync canary initialized by forge-sync.cjs — a real, honest event proving forge-runs/ genuinely exists for this fresh canary, never fabricated data',
    canary: true,
  });
  let r;
  try { r = spawnSync(process.execPath, [logEventPath, runId, 'run_started', payload], { cwd: projectDir, encoding: 'utf8' }); }
  catch (e) { return { ok: false, runId, error: e.message }; }
  return { ok: !!r && r.status === 0, runId, exitCode: r ? r.status : null, stderr: (r && r.stderr) || '' };
}

/** seedProjectScaffold — INSTALL-DEADLOCK FIX. The post-install validation doctor runs test
 *  suites that assert the PROJECT ENVIRONMENT: CLAUDE.md exists (forge-configdrift), .gitignore carries the
 *  forge-runs/forge-index rules (forge-tool-index, forge-toolhook). Those files were Phase-16 duties of the
 *  INSTALLING AGENT — a step that by definition can only run AFTER forge-sync returns. Net effect measured
 *  live: every fresh-project install failed its own validation and rolled back all ~357 files ("a trading project
 *  trading", 2×, and a clean sandbox repro). The installer therefore seeds exactly the environment its own
 *  validation checks, from the template HOME (the directory above the template's .claude content dir):
 *    - .gitignore  — created verbatim from gitignore.snippet when absent; otherwise APPEND-ONLY: only
 *      snippet rule-lines whose trimmed form is not already present are appended (comments/order/custom
 *      lines untouched — the safe-merge discipline CLAUDE.md's Phase 16 already prescribes).
 *    - CLAUDE.md   — created from the template home's stub ONLY when absent; an existing CLAUDE.md is
 *      NEVER touched by the syncer (safe-merge of the Forge section stays an agent responsibility).
 *  Missing template assets degrade honestly to 'template-missing' (fixture templates have none).
 *  Returns { gitignore, claude_md, created:[rootRelNames], errors:[] } — callers surface it on the result
 *  and undoScaffold() removes CREATED files on the rollback paths (append-only edits are left in place). */
function seedProjectScaffold(templateDir, projectDir) {
  const out = { gitignore: 'template-missing', claude_md: 'template-missing', created: [], errors: [] };
  const tplHome = path.dirname(path.resolve(templateDir));
  const snippetPath = path.join(tplHome, 'gitignore.snippet');
  const stubPath = path.join(tplHome, 'CLAUDE.md');
  // CODEX ADVERSARIAL REVIEW (gpt-5.6-sol) findings #21/#22: this seeding bypassed the
  // installer's own containment/symlink discipline. A project `.gitignore` that is a SYMLINK to a file
  // outside the project was read and appended to through the link — the installer writing outside the
  // project it is installing into. And `existsSync` + `writeFileSync` is a check-then-write race: a
  // file created in between was truncated. Both are closed here: refuse non-regular targets, verify
  // containment against the resolved real path, and create with the exclusive 'wx' flag.
  const root = path.resolve(projectDir);
  // the project root itself must be a plain folder that resolves to itself (a junction as the root would send the
  // scaffold's .gitignore append and CLAUDE.md stub into another tree)
  let rootReal = null; try { rootReal = fs.realpathSync.native(root); } catch { rootReal = null; }
  const rootProblem = lstatKind(root) !== 'dir' ? 'the project root is not a plain folder' : (rootReal == null || foldCase(rootReal) !== foldCase(root) ? 'the project root ' + root + ' resolves to ' + rootReal + ' (a junction/alias on the path)' : null);
  const targetOk = (rel) => {
    if (rootProblem) return { ok: false, reason: rootProblem };
    const p = path.join(root, rel);
    if (path.resolve(p) !== path.normalize(p) || path.relative(root, p).startsWith('..')) return { ok: false, reason: 'path escapes the project root' };
    let st = null;
    try { st = fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return { ok: true, path: p, exists: false }; return { ok: false, reason: e.message }; }
    if (st.isSymbolicLink()) return { ok: false, reason: 'target is a symlink — refusing to write through it' };
    if (!st.isFile()) return { ok: false, reason: 'target exists but is not a regular file' };
    return { ok: true, path: p, exists: true };
  };
  // .gitignore
  try {
    if (fs.existsSync(snippetPath)) {
      const snippet = fs.readFileSync(snippetPath, 'utf8');
      const chk = targetOk('.gitignore');
      if (!chk.ok) { out.errors.push('.gitignore: ' + chk.reason); out.gitignore = 'refused'; throw new Error('scaffold refused: ' + chk.reason); }
      const target = chk.path;
      if (!chk.exists) {
        try {
          fs.writeFileSync(target, snippet.endsWith('\n') ? snippet : snippet + '\n', { encoding: 'utf8', flag: 'wx' });
          out.gitignore = 'created';
          out.created.push('.gitignore');
          out.createdHashes = Object.assign({}, out.createdHashes, { '.gitignore': sha256(target) }); // ronde-3 #7: alleen ONZE bytes mogen later verwijderd worden
        } catch (e) {
          if (e && e.code === 'EEXIST') { out.gitignore = 'raced-existing'; out.errors.push('.gitignore: created by another process during install — left untouched'); }
          else throw e;
        }
      } else {
        const priorBytes = fs.readFileSync(target, 'utf8');
        const existing = new Set(priorBytes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
        const missing = snippet.split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && !existing.has(l));
        if (missing.length === 0) out.gitignore = 'unchanged';
        else {
          const appended = GITIGNORE_SCAFFOLD_HEADER + missing.join('\n') + '\n';
          fs.appendFileSync(target, appended, 'utf8');
          out.gitignore = 'appended:' + missing.length;
          /** AUDIT #21: the append was irreversible — the batch manifest only backs up files
           *  under .claude/, never the root .gitignore, and undoScaffold only unlinks files it CREATED. A
           *  failed install therefore left the Forge block in the owner's .gitignore forever, with no
           *  record of the pre-append bytes anywhere. The exact prior bytes and the exact appended block
           *  are now carried on the scaffold result, so undoScaffold can restore the file byte-for-byte —
           *  and ONLY when the current content still equals prior+appended, so an owner edit made after
           *  the append is never clobbered by a rollback. */
          out.gitignorePrior = priorBytes;
          out.gitignoreAppended = appended;
        }
      }
    }
  } catch (e) { out.errors.push('.gitignore: ' + e.message); out.gitignore = 'error'; }
  // CLAUDE.md (create-only)
  try {
    if (fs.existsSync(stubPath)) {
      const chk = targetOk('CLAUDE.md');
      if (!chk.ok) { out.errors.push('CLAUDE.md: ' + chk.reason); out.claude_md = 'refused'; throw new Error('scaffold refused: ' + chk.reason); }
      if (chk.exists) out.claude_md = 'unchanged';
      else {
        try {
          // COPYFILE_EXCL: fail rather than clobber a file that appeared between the check and the copy.
          fs.copyFileSync(stubPath, chk.path, fs.constants.COPYFILE_EXCL);
          out.claude_md = 'created';
          out.created.push('CLAUDE.md');
          out.createdHashes = Object.assign({}, out.createdHashes, { 'CLAUDE.md': sha256(chk.path) }); // ronde-3 #7
        } catch (e) {
          if (e && e.code === 'EEXIST') { out.claude_md = 'raced-existing'; out.errors.push('CLAUDE.md: created by another process during install — left untouched'); }
          else throw e;
        }
      }
    }
  } catch (e) { out.errors.push('CLAUDE.md: ' + e.message); out.claude_md = 'error'; }
  return out;
}

/** undoScaffold — removes ONLY the files seedProjectScaffold reports it CREATED (never an append-edited or
 *  pre-existing file), so a rolled-back install leaves no half-provisioned root behind. Best-effort. */
const SCAFFOLD_ALLOWED = new Set(['.gitignore', 'CLAUDE.md']); // the ONLY files seeding may ever create
// The exact header seedProjectScaffold puts above the rule lines it appends to an existing .gitignore.: the
// protect check (diffProtectManifests) recognises a legitimate append by it when no batch record names the block.
const GITIGNORE_SCAFFOLD_HEADER = '\n# Forge scaffold rules (seeded by forge-sync install — append-only)\n';
function undoScaffold(scaffold, projectDir) {
  const result = { removedCreated: [], keptForeign: [], gitignore: 'not-applicable', errors: [] };
  if (!scaffold) return result;
  const root = path.resolve(projectDir);
  const createdHashes = scaffold.createdHashes && typeof scaffold.createdHashes === 'object' ? scaffold.createdHashes : null;
  for (const name of (Array.isArray(scaffold.created) ? scaffold.created : [])) {
    // CODEX finding #22: this deleted by filename string alone, so a caller-supplied created:["../victim"]
    // (the function IS exported) would delete outside the project, and a file REPLACED between creation
    // and rollback was removed even though it was no longer ours. Allow-list + containment + regular-file
    // check, and never follow a symlink out of the tree.
    if (!SCAFFOLD_ALLOWED.has(name)) continue;
    const p = path.join(root, name);
    if (path.relative(root, p).startsWith('..') || path.dirname(p) !== root) continue;
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile()) { result.keptForeign.push(name + ' (not a regular file anymore)'); continue; }
      // CODEX ronde-3 #7: een LATE rollback (crash-pad, alleen het manifest) verwijderde een
      // created bestand ongeacht de inhoud — een CLAUDE.md die de owner intussen bewerkte ging mee de
      // prullenbak in. Met een vastgelegde creation-hash verwijderen we alleen exact ONZE bytes; zonder
      // hash (legacy scaffold-object) blijft het oude gedrag, dat de in-run paden al beschermde.
      if (createdHashes && typeof createdHashes[name] === 'string' && sha256(p) !== createdHashes[name]) {
        result.keptForeign.push(name + ' (content changed since creation — owner work, not ours to delete)');
        continue;
      }
      fs.rmSync(p, { force: true });
      result.removedCreated.push(name);
    } catch (e) { result.errors.push(name + ': ' + e.message); }
  }
  /** AUDIT #21: revert the .gitignore APPEND too — but only when the file's current bytes
   *  are exactly prior+appended. Any other content means the owner (or another process) touched the file
   *  after the seed, and clobbering their edit to undo ours would be worse than leaving both; that case
   *  is left in place deliberately, matching the "never delete what is no longer ours" rule above. */
  if (typeof scaffold.gitignorePrior === 'string' && typeof scaffold.gitignoreAppended === 'string') {
    const p = path.join(root, '.gitignore');
    try {
      const st = fs.lstatSync(p);
      if (st.isFile()) {
        const now = fs.readFileSync(p, 'utf8');
        if (now === scaffold.gitignorePrior + scaffold.gitignoreAppended) {
          writeAtomic(p, scaffold.gitignorePrior);
          result.gitignore = 'reverted';
        } else result.gitignore = 'kept (content changed since the append — never clobber owner work)';
      } else result.gitignore = 'kept (no longer a regular file)';
    } catch (e) { result.gitignore = 'kept (' + (e.code === 'ENOENT' ? 'file gone' : e.message) + ')'; }
  }
  return result;
}
/** decideValidationOutcome — H3+H4 gating decision, kept as a pure function so it's directly unit-testable.
 *  Priority: timeout -> blocked. Degraded (no doctor) -> requires --allow-degraded even when clean, and NEVER
 *  passes if the fallback itself found syntax failures. Evidence-backed pass -> ok, UNLESS a previously-green
 *  check silently vanished (see below). No-evidence -> rejected. Evidence-backed fail -> ok ONLY if it is
 *  provably the SAME pre-existing redness (no new regression) AND the node_check hard gate on the
 *  just-synced files is clean; otherwise a real failure.
 *
 *  MEDIUM FIX (mirrors regressionCheck's own fix): a naive
 *  `validation.ok===true` from the POST-sync doctor is NOT sufficient proof that nothing regressed — the
 *  doctor's own top-level `ok` is only `Object.values(checks).every(c=>c.ok)` over whatever keys IT still
 *  emits, so a sync that replaces forge-doctor.cjs with a version that silently stopped emitting a
 *  previously-green check reports a happy `ok:true` with ZERO awareness that real coverage was lost — "a
 *  sync that removes a check passes" is exactly the bug this closes. Before trusting a naive `ok:true`,
 *  compare against the pre-sync baseline via the SAME regressionCheck used for the evidence-backed-fail path
 *  below; if it finds a previously-green check now entirely absent, that overrides the naive pass. A
 *  brand-new green check, or identical checks on both sides, are unaffected (regressionCheck returns []). */
/** redDetail(summary) -> ' — red checks: a, b; failing suites: x (1 failed), ...' or '' — WP-SYNC-R7 item 5: a failed validation
 *  says WHAT was red (every failing suite by name, never a bare "failed"). */
function redDetail(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const parts = [];
  if (summary.checksOk && typeof summary.checksOk === 'object') { const red = Object.keys(summary.checksOk).filter((k) => !(summary.checksOk[k] && summary.checksOk[k].ok)); if (red.length) parts.push('red checks: ' + red.join(', ')); }
  if (Array.isArray(summary.failing_suites) && summary.failing_suites.length) parts.push('failing suites: ' + summary.failing_suites.join(', '));
  return parts.length ? ' — ' + parts.join('; ') : '';
}
function decideValidationOutcome(preValidation, validation, opts) {
  opts = opts || {};
  if (validation.timedOut) {
    const lim = Number.isFinite(validation.timeoutMs) ? ' after ' + Math.round(validation.timeoutMs / 1000) + ' s (' + (validation.timeoutSource || 'unknown') + ' limit — raise it with --doctor-timeout <ms>)' : '';
    return { ok: false, timedOut: true, reason: 'forge-doctor timed out' + lim + ' (' + (validation.signal || 'no signal') + ') — treating as BLOCKED, not a confirmed validation failure' };
  }
  if (validation.degraded) {
    if (!validation.ok) return { ok: false, reason: 'degraded validator (node --check fallback, no forge-doctor present) found syntax failure(s) in synced file(s)' };
    if (!opts.allowDegraded) return { ok: false, degradedBlocked: true, reason: 'degraded validator (no forge-doctor present) cannot count as synced without --allow-degraded' };
    return { ok: true, degradedAllowed: true };
  }
  if (validation.ok) {
    const vanished = regressionCheck(preValidation && preValidation.summary, validation.summary);
    if (vanished.length > 0) {
      return { ok: false, regressed: vanished, reason: 'this sync\'s own doctor no longer reports previously-green check(s), or reports a red suite, even though it otherwise claims ok:true: ' + vanished.join(', ') + ' (a check must never silently disappear)' };
    }
    return { ok: true };
  }
  if (validation.noEvidence) return { ok: false, reason: validation.reason || 'forge-doctor gave no positive evidence' };
  const preHasEvidence = !!(preValidation && preValidation.summary && !preValidation.noEvidence && !preValidation.degraded);
  const preWasRed = preHasEvidence && preValidation.summary.ok === false;
  if (!preHasEvidence || !preWasRed) return { ok: false, reason: 'post-sync validation failed' + redDetail(validation.summary) + (preHasEvidence ? ' (the project was green before this sync)' : '') };
  const regressed = regressionCheck(preValidation.summary, validation.summary);
  const postNodeCheckOk = validation.summary && validation.summary.node_check ? !!validation.summary.node_check.ok : true;
  if (regressed.length === 0 && postNodeCheckOk) {
    // WP-SYNC-R7: say whether the per-suite comparison could run (both summaries carry the suite list) — never imply it did
    const perSuite = !!(preValidation.summary.suiteOk && validation.summary && validation.summary.suiteOk);
    return { ok: true, alreadyRedSkipped: true, suitesCompared: perSuite, note: 'project was already red before this sync (pre-existing, unrelated failures) — no NEW regression' + (perSuite ? ' (no check and no suite went green -> red or turned up red for the first time)' : ' at check level (no per-suite list on both sides, so suites were not compared one by one)') + ' and the synced file(s) pass node_check; not attributing pre-existing redness to this sync' };
  }
  // WP-SYNC-R7: name each suite with how it regressed, not just "tests"
  const suites = suiteRegressions(preValidation.summary, validation.summary);
  const named = regressed.filter((k) => !k.startsWith('suite:')).concat(suites.map((s) => 'suite ' + s.suite + ' (' + s.kind + ')'));
  return { ok: false, regressed, regressedSuites: suites, reason: regressed.length ? ('regression on: ' + named.join(', ') + ' (green->red, or a check/suite newly introduced by this sync that is already red)') : 'node_check hard gate failed on synced file(s)' };
}

// ---- WP-SYNC-R9: isolated confirmation of a SUITE-ONLY regression before rolling back ---------------------------------------
/** The doctor's own per-suite limit: forge-doctor.cjs DOCTOR_SUITE_TIMEOUT_MS (1500 s; WP-LIMITS 2026-10-10 — forge-sync.test.cjs
 *  alone needs ~750 s), FORGE_DOCTOR_SUITE_TIMEOUT_MS overrides it
 *  (the doctor inherits this process's environment, so the same variable gives both runs the same limit). Mirrored here, not
 *  required from the project's doctor: the re-run must not depend on loading a project file as a module. */
const DOCTOR_SUITE_TIMEOUT_MS_MIRROR = 1500000;
/** forge-doctor.cjs SUITE_DURATIONS_FILE — the doctor's own hint of how long each suite took in its last POOLED run (it orders the
 *  next run longest-first with it). Read here, read-only, only to show the first run's per-suite duration: forge-doctor --json
 *  reports no per-suite duration. A hint, never evidence — missing, stale or foreign data simply shows "not reported". */
const DOCTOR_SUITE_DURATIONS_FILE = path.join(os.tmpdir(), 'forge-doctor-suite-durations.json');
const SUITE_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.test\.cjs$/; // a suite name from the doctor's JSON is data: a plain file name only
const SUITE_POOL_BACKSTOP_EXTRA_MS = 35000; // forge-suite-pool's kill grace (5 s) + slack, on top of the suite's own limit
const SUITE_RERUN_MAX_BUFFER = 256 * 1024 * 1024;
const FLAKY_HONESTY = 'a suite that passed when run alone but failed inside the doctor run was NOT proven healthy under load — it was only shown to be not deterministically broken';
/** isolatedRerunTimeout(opts) -> {timeoutMs, source}. opts.isolatedRerunTimeoutMs is a library-only seam (tests). */
function isolatedRerunTimeout(opts) {
  if (opts && Number.isFinite(opts.isolatedRerunTimeoutMs) && opts.isolatedRerunTimeoutMs > 0) return { timeoutMs: opts.isolatedRerunTimeoutMs, source: 'option' };
  const env = Number(process.env.FORGE_DOCTOR_SUITE_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return { timeoutMs: env, source: 'FORGE_DOCTOR_SUITE_TIMEOUT_MS' };
  return { timeoutMs: DOCTOR_SUITE_TIMEOUT_MS_MIRROR, source: 'the doctor per-suite default' };
}
// ---- WP-SYNC-R10: the re-run phase is bounded, killed by tree, cleaned, and observed ----
/** WP-SYNC-R10 (Codex R9-05b): the WHOLE re-run phase (every flagged suite, plus the change snapshots) is capped by one budget,
 *  default 20 minutes, while the project lock and maintenance mode are held. A suite that would start after the budget is used
 *  up is not run and counts as a regression; a suite that starts gets min(its own limit, what is left). */
const ISOLATED_RERUN_BUDGET_DEFAULT_MS = 20 * 60 * 1000;
/** isolatedRerunBudget(opts) -> {budgetMs, source}: --isolated-rerun-budget <ms> (opts.isolatedRerunBudgetMs) or the default. */
function isolatedRerunBudget(opts) {
  if (opts && Number.isFinite(opts.isolatedRerunBudgetMs) && opts.isolatedRerunBudgetMs > 0) return { budgetMs: opts.isolatedRerunBudgetMs, source: '--isolated-rerun-budget' };
  return { budgetMs: ISOLATED_RERUN_BUDGET_DEFAULT_MS, source: 'default (20 min)' };
}
/** WP-SYNC-R10: the environment of an isolated re-run. forge-doctor itself has NO environment allow-list — its suites
 *  inherit forge-sync's environment unchanged — so there is no doctor list to copy; this is the one forge-sync defines and names
 *  in the report. Only these names pass (case-insensitive): what Windows, a POSIX shell, git and node need to start (system
 *  folders, PATH, temp, user profile, locale) plus the doctor's own FORGE_DOCTOR_SUITE_TIMEOUT_MS. Everything else is dropped —
 *  NODE_OPTIONS / NODE_PATH (could preload code), GIT_* , CLAUDE_* , every other FORGE_* (test seams such as
 *  FORGE_SYNC_TEST_HOOKS), and any credential variable. Values are never recorded; only the kept names and the dropped count. */
const ISOLATED_ENV_ALLOW = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PSMODULEPATH',
  'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'FORGE_DOCTOR_SUITE_TIMEOUT_MS',
]);
const ISOLATED_ENV_ALLOW_PREFIXES = ['LC_'];
/** isolatedRerunEnv(base) -> {env, kept:[names], dropped:<count>} — pure. */
function isolatedRerunEnv(base) {
  const env = {};
  let dropped = 0;
  for (const k of Object.keys(base || {})) {
    const u = k.toUpperCase();
    if (ISOLATED_ENV_ALLOW.has(u) || ISOLATED_ENV_ALLOW_PREFIXES.some((p) => u.startsWith(p))) env[k] = base[k]; else dropped++;
  }
  return { env, kept: Object.keys(env).sort(), dropped };
}
/** ISOLATED_RUNNER_SRC — WP-SYNC-R10 (Codex R9-05c): forge-sync's OWN one-suite runner (run with `node -e`; never a project file),
 *  used whenever the template-identical suite pool is not. spawnSync's own timeout killed only the node child: on Windows the
 *  suite's grandchildren survived and could hold files the rollback needs. This runner spawns the suite (detached = its own
 *  process group outside Windows), and at the limit kills the suite's process TREE by the suite's exact PID — `taskkill /PID
 *  <pid> /T /F` on Windows, SIGKILL to its process group elsewhere — never by image name. It reads one JSON job on stdin
 *  {node, file, cwd, timeoutMs} and prints one JSON document {status, signal, timedOut, stdout, stderr, ms, pid, killed}. */
const ISOLATED_RUNNER_SRC = [
  '"use strict";',
  'var cp = require("child_process"), fs = require("fs"), path = require("path");',
  'var job = JSON.parse(fs.readFileSync(0, "utf8"));',
  'var out = [], err = [], started = Date.now(), timedOut = false, finished = false, code = null, sig = null, spawnError = null, killed = null, timer = null, grace = null, child = null;',
  'function finish() {',
  '  if (finished) return; finished = true; clearTimeout(timer); clearTimeout(grace);',
  '  var res = { status: timedOut ? null : code, signal: timedOut ? (sig || "SIGTERM") : sig, timedOut: timedOut, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), ms: Date.now() - started, pid: child && child.pid ? child.pid : null, killed: killed };',
  '  if (spawnError) res.error = spawnError;',
  '  process.stdout.write(JSON.stringify(res), function () { process.exit(0); });',
  '}',
  'function killTree() {',
  '  if (!child || !child.pid) return;',
  '  if (process.platform === "win32") {',
  '    var tk = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\\\Windows", "System32", "taskkill.exe");',
  '    var r = cp.spawnSync(fs.existsSync(tk) ? tk : "taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });',
  '    killed = r.status === 0 ? "taskkill /PID " + child.pid + " /T /F" : "taskkill /PID " + child.pid + " /T /F failed (status " + r.status + ")";',
  '    if (r.status !== 0) { try { child.kill("SIGTERM"); } catch (e) {} }',
  '    return;',
  '  }',
  '  try { process.kill(-child.pid, "SIGKILL"); killed = "SIGKILL to process group " + child.pid; } catch (e) { try { child.kill("SIGKILL"); killed = "SIGKILL to pid " + child.pid; } catch (e2) {} }',
  '}',
  'try { child = cp.spawn(job.node, [job.file], { cwd: job.cwd, env: process.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }); }',
  'catch (e) { spawnError = String((e && e.message) || e); finish(); }',
  'if (child) {',
  '  try { child.stdin.end(); } catch (e) {}',
  '  child.stdin.on("error", function () {});',
  '  child.stdout.on("data", function (d) { out.push(d); }); child.stderr.on("data", function (d) { err.push(d); });',
  '  child.on("error", function (e) { spawnError = String((e && e.message) || e); if (!child.pid) finish(); });',
  '  child.on("exit", function (c, s) { code = c; sig = s; });',
  '  child.on("close", function (c, s) { if (code === null && sig === null) { code = c; sig = s; } finish(); });',
  '  timer = setTimeout(function () {',
  '    if (child.exitCode === null && child.signalCode === null) { timedOut = true; killTree(); }',
  '    grace = setTimeout(function () { try { child.stdout.destroy(); } catch (e) {} try { child.stderr.destroy(); } catch (e) {} finish(); }, 5000);',
  '  }, job.timeoutMs);',
  '}',
].join('\n');
/** WP-SYNC-R10: which files under the project an isolated re-run created, changed or removed. A suite that passes
 *  alone only because the doctor run (or an earlier re-run) left a marker behind is then VISIBLE — it is not rejected
 *  automatically (a suite may legitimately write its own run folder), the report names the files (names only, capped) for a
 *  human to judge. Metadata only (lstat: kind, size, modified time) — no file is read. Not walked: node_modules, .git and the
 *  usual build/cache/venv folders, the sync's own backups, and every agent checkout under .claude/worktrees (a child holding a
 *  .git entry). Bounded: at most 200,000 entries and 20 s per snapshot, beyond that it says "incomplete". */
const RERUN_SNAPSHOT_MAX_ENTRIES = 200000;
const RERUN_SNAPSHOT_MAX_MS = 20000;
const RERUN_CHANGES_NAMES_MAX = 15;
const RERUN_SNAPSHOT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.mypy_cache', '.ruff_cache', '.pytest_cache']);
/** gitEntryState(dirAbs) -> 'present' | 'absent' | 'unknown' — WP-SYNC-R13B: the lstat of <dir>/.git. Only
 *  ENOENT / ENOTDIR mean "no .git entry"; any other error (EPERM, EACCES, EBUSY, ...) means the probe FAILED — whether the folder
 *  is a checkout cannot be told, which is never the same as "it is not one". */
function gitEntryState(dirAbs) {
  try { fs.lstatSync(path.join(dirAbs, '.git')); return 'present'; }
  catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'absent' : 'unknown'; }
}
/** hasGitEntry(dirAbs) — WP-SYNC-R10: a folder holding a `.git` entry of any kind (the FILE of a `git worktree add` checkout, the
 *  folder of a clone, a link) — a real checkout. WP-SYNC-R13B: a .git probe that FAILED (gitEntryState 'unknown')
 *  answers true as well — fail closed: such a child is recorded as a checkout that cannot be identified (protectCheckoutEntry ->
 *  {kind:'unreadable', failClosed:'checkout'}, a violation when verified), never walked as a plain folder whose unreadable bits
 *  would pass as "not comparable". Only a .git that is really absent (ENOENT / ENOTDIR) answers false. */
function hasGitEntry(dirAbs) { return gitEntryState(dirAbs) !== 'absent'; }
/** worktreesChildrenSignature(dirAbs) -> a sha256 over the sorted children of .claude/worktrees: name + kind ('g' a checkout =
 *  a folder holding a .git entry, 'u' a folder whose .git probe failed (WP-SYNC-R13B), 'd' another folder, 'l' a link,
 *  'f:<size>:<mtime>' a plain file, 'o' other); 'absent' when the folder does not exist, 'unreadable:<code>' when it cannot be
 *  lstat'ed or listed, 'not-a-folder:<kind>' when it is a link or a file. One readdir + one lstat per child — cheap. */
function worktreesChildrenSignature(dirAbs) {
  let st;
  try { st = fs.lstatSync(dirAbs); } catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'absent' : 'unreadable:' + ((e && e.code) || 'error'); }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'not-a-folder:' + (st.isSymbolicLink() ? 'link' : 'file');
  let list;
  try { list = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (e) { return 'unreadable:' + (e.code || 'error'); }
  const sig = list.map((e) => {
    const p = path.join(dirAbs, e.name);
    if (e.isSymbolicLink()) return e.name + '\tl';
    if (e.isDirectory()) { const g = gitEntryState(p); return e.name + '\t' + (g === 'present' ? 'g' : (g === 'unknown' ? 'u' : 'd')); }
    if (e.isFile()) { try { const s = fs.lstatSync(p); return e.name + '\tf:' + s.size + ':' + s.mtimeMs; } catch { return e.name + '\tf:?'; } }
    return e.name + '\to';
  }).sort();
  return crypto.createHash('sha256').update(sig.join('\n')).digest('hex');
}
/** projectChangeSnapshot(projectDir) -> {entries: Map(rel -> signature), incomplete: null|reason, ms}. */
function projectChangeSnapshot(projectDir) {
  const root = path.resolve(projectDir);
  const t0 = Date.now();
  const entries = new Map();
  let incomplete = null;
  const walk = (dirAbs, rel) => {
    let list;
    try { list = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (incomplete) return;
      if (entries.size >= RERUN_SNAPSHOT_MAX_ENTRIES) { incomplete = 'more than ' + RERUN_SNAPSHOT_MAX_ENTRIES + ' entries'; return; }
      if (Date.now() - t0 > RERUN_SNAPSHOT_MAX_MS) { incomplete = 'took longer than ' + Math.round(RERUN_SNAPSHOT_MAX_MS / 1000) + ' s'; return; }
      const r = rel ? rel + '/' + e.name : e.name;
      const p = path.join(dirAbs, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const fr = foldCase(r);
        if (RERUN_SNAPSHOT_SKIP_DIRS.has(foldCase(e.name)) || fr === '.claude/forge-backups' || fr === '.claude/forge-backups-central') continue;
        if (foldCase(rel) === '.claude/worktrees' && hasGitEntry(p)) continue; // an agent checkout (or one whose .git probe failed, R13B): never walked
        entries.set(r + '/', 'd');
        walk(p, r);
        continue;
      }
      let sig = 'x';
      try { const st = fs.lstatSync(p); sig = (st.isSymbolicLink() ? 'l' : (st.isFile() ? 'f' : 'o')) + ':' + st.size + ':' + st.mtimeMs; } catch { sig = 'x'; }
      entries.set(r, sig);
    }
  };
  walk(root, '');
  return { entries, incomplete, ms: Date.now() - t0 };
}
/** projectChangesBetween(before, after, scrub) -> {created, changed, removed, names:[...], namesTruncated, incomplete} — counts and
 *  at most 15 names ('+ ' created, '~ ' changed, '- ' removed), each name scrubbed like an output line. */
function projectChangesBetween(before, after, scrub) {
  const created = [], changed = [], removed = [];
  for (const [k, v] of after.entries) { if (!before.entries.has(k)) created.push(k); else if (before.entries.get(k) !== v) changed.push(k); }
  for (const k of before.entries.keys()) if (!after.entries.has(k)) removed.push(k);
  const all = created.sort().map((k) => '+ ' + k).concat(changed.sort().map((k) => '~ ' + k), removed.sort().map((k) => '- ' + k));
  const names = all.slice(0, RERUN_CHANGES_NAMES_MAX).map((n) => scrubOneLine(n, scrub));
  const incomplete = before.incomplete || after.incomplete || null;
  return { created: created.length, changed: changed.length, removed: removed.length, names, namesTruncated: all.length > names.length, incomplete };
}
/** suiteRerunPlan(preValidation, validation) -> {flagged:[{suite,kind}], eligible, reason} — pure. flagged = the suites the
 *  regression check names (green->red, or red for the first time). The isolated re-run is only for a regression that is made of
 *  SUITES: a red check (leak_scan, agents, node_check, a vanished check, ...) that regressed is never re-run and rolls back as
 *  before; so does a doctor that timed out, gave no evidence, was degraded, or is not the template doctor. The `tests` check must
 *  be red only because of named suites (suitesFailed + suitesBlocked equals the red names in the per-suite list). */
function suiteRerunPlan(preValidation, validation) {
  const pre = preValidation && preValidation.summary && !preValidation.noEvidence && !preValidation.degraded ? preValidation.summary : null;
  const post = validation && validation.summary ? validation.summary : null;
  const flagged = pre && post ? suiteRegressions(pre, post) : [];
  const no = (reason) => ({ flagged, eligible: false, reason });
  if (!flagged.length) return no(pre ? 'no suite went green -> red or turned up red for the first time' : 'there is no evidence-backed pre-sync doctor summary with a per-suite list to compare against');
  if (!validation || validation.tool !== 'forge-doctor') return no('the validator was not forge-doctor');
  if (validation.timedOut) return no('the doctor run timed out (blocked)');
  if (validation.noEvidence) return no('the doctor gave no positive evidence');
  if (validation.degraded) return no('the validation was degraded');
  if (validation.doctorProvenance === 'project-local') return no('the doctor that ran is not the template doctor — an install may not be rescued by a gate the project itself authored');
  const checkRegs = regressionCheck(pre, post).filter((k) => !k.startsWith('suite:') && k !== 'tests' && k !== 'overall');
  if (checkRegs.length) return no('a red check regressed (' + checkRegs.join(', ') + ') — a red check always rolls back and is never re-run');
  if (post.node_check && post.node_check.ok !== true) return no('the node_check hard gate is red');
  const tests = post.tests || {};
  const redNames = Object.keys(post.suiteOk || {}).filter((n) => post.suiteOk[n] === false);
  if (!Number.isFinite(tests.suitesFailed) || !Number.isFinite(tests.suitesBlocked)) return no('the doctor summary has no suitesFailed/suitesBlocked counts, so the tests check cannot be shown to be red only because of named suites');
  if (tests.suitesFailed + tests.suitesBlocked !== redNames.length) return no('the tests check counts ' + (tests.suitesFailed + tests.suitesBlocked) + ' red suite(s) but the per-suite list names ' + redNames.length + ' — its redness is not fully explained by named suites');
  return { flagged, eligible: true, reason: null };
}
/** summaryWithSuitesGreen(summary, names) — pure: a COPY of a condensed doctor summary in which the named suites count as green.
 *  The `tests` check turns green only when no other suite is still red; the overall ok is recomputed from every check. Used ONLY
 *  to re-decide the outcome after an isolated re-run; it is never persisted (the receipt keeps the doctor's real summary). */
function summaryWithSuitesGreen(summary, names) {
  const set = new Set(names);
  const suiteOk = Object.assign({}, summary.suiteOk || {});
  for (const n of set) suiteOk[n] = true;
  const stillRed = Object.keys(suiteOk).some((k) => suiteOk[k] === false);
  const failing = (summary.failing_suites || []).filter((s) => ![...set].some((n) => s === n || s.startsWith(n + ' (')));
  const checksOk = {};
  for (const k of Object.keys(summary.checksOk || {})) checksOk[k] = { ok: !!(summary.checksOk[k] && summary.checksOk[k].ok) };
  if (checksOk.tests && !stillRed) checksOk.tests = { ok: true };
  const tests = summary.tests ? Object.assign({}, summary.tests, stillRed ? {} : { ok: true }) : summary.tests;
  const out = Object.assign({}, summary, { suiteOk, checksOk, tests, ok: Object.keys(checksOk).length ? Object.values(checksOk).every((c) => c.ok) : summary.ok });
  if (failing.length) out.failing_suites = failing; else delete out.failing_suites;
  return out;
}
/** trustedSuitePool(projectDir, templateDir) -> the project's forge-suite-pool.cjs when it is byte-identical (EOL-normalized) to the
 *  template's, else null. The pool runs a suite exactly like the doctor does (cwd = root, inherited environment) and on a timeout
 *  kills it by its OWN PID with its process tree (taskkill /PID <pid> /T /F on Windows, its process group elsewhere). A pool the
 *  project overrode is not used: the re-run can turn a rollback into a kept sync, so it must not run through project-authored code. */
function trustedSuitePool(projectDir, templateDir) {
  if (!templateDir) return null;
  const rel = path.join('forge-bin', 'forge-suite-pool.cjs');
  const p = path.join(claudeDirOf(path.resolve(projectDir)), rel), tp = path.join(templateDir, rel);
  if (!fs.existsSync(p) || !fs.existsSync(tp) || isSymlinkPath(p)) return null;
  const a = sha256Normalized(p), b = sha256Normalized(tp);
  return a && b && a === b ? p : null;
}
/** runIsolatedSuite(projectDir, suite, opts) — run ONE suite once, alone: `node <project>/.claude/forge-bin/<suite>` with cwd = the
 *  project folder (the folder forge-doctor gives every suite) and the doctor's per-suite limit (opts.timeoutMs). Through the
 *  template-identical suite pool when there is one, else forge-sync's own runner (ISOLATED_RUNNER_SRC); BOTH kill the suite's
 *  process tree by its exact PID at the limit, never by image name. WP-SYNC-R10: the environment is the allow-listed one
 *  (isolatedRerunEnv; opts.env when the caller already built it). Returns {runner, exitCode, signal, timedOut, error, passed,
 *  failed, tallyParsed, tallyAmbiguous, stdoutFailLines, durationMs, healthy, lines, tail, linesWithheld, outputWithheld, pid,
 *  killed}. healthy (WP-SYNC-R10) = exit 0, no timeout, no error, exactly ONE distinct tally in STDOUT with
 *  passed > 0 and failed == 0, and no FAIL / not ok line in stdout. Shown lines come from the WHOLE output redacted first
 *  (redactSuiteOutput), error strings are scrubbed too (scrubOneLine). */
function runIsolatedSuite(projectDir, suite, opts) {
  opts = opts || {};
  const rec = { suite, runner: null, exitCode: null, signal: null, timedOut: false, error: null, passed: 0, failed: 0, tallyParsed: false, tallyAmbiguous: false, stdoutFailLines: 0, durationMs: null, healthy: false, lines: [], tail: [], linesWithheld: null, outputWithheld: null, pid: null, killed: null };
  // opts.scrubberUnavailable: library-only seam that can only make this STRICTER (simulates a missing forge-store.cjs)
  const scrub = opts.scrubberUnavailable ? null : loadDoctorScrubber();
  if (typeof suite !== 'string' || !SUITE_FILE_NAME_RE.test(suite)) return Object.assign(rec, { error: 'not a plain *.test.cjs file name — never run' });
  const root = path.resolve(projectDir);
  const bin = path.join(claudeDirOf(root), 'forge-bin');
  const file = path.join(bin, suite);
  let st = null;
  try { st = fs.lstatSync(file); } catch { st = null; }
  if (!st) return Object.assign(rec, { error: 'the suite file does not exist in the synced project — it could not be re-run' });
  if (!st.isFile() || st.isSymbolicLink() || !containmentSafe(bin, file)) return Object.assign(rec, { error: 'not a regular file inside forge-bin (a link, or outside it) — never run' });
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DOCTOR_SUITE_TIMEOUT_MS_MIRROR;
  const env = opts.env && typeof opts.env === 'object' ? opts.env : isolatedRerunEnv(process.env).env;
  const pool = opts.forceDirect ? null : trustedSuitePool(root, opts.templateDir);
  const started = Date.now();
  let status, signal, timedOut, stdout, stderr, error = null;
  const spawnOpts = { cwd: root, env, encoding: 'utf8', timeout: timeoutMs + SUITE_POOL_BACKSTOP_EXTRA_MS, maxBuffer: SUITE_RERUN_MAX_BUFFER, windowsHide: true };
  let x = null, r;
  if (pool) {
    rec.runner = 'suite-pool';
    const job = { node: process.execPath, root, suites: [file], order: [0], jobs: 1, timeoutMs };
    r = spawnSync(process.execPath, [pool], Object.assign({ input: JSON.stringify(job) }, spawnOpts));
    let parsed = null; try { parsed = JSON.parse(r.stdout || ''); } catch { parsed = null; }
    x = parsed && Array.isArray(parsed.results) && parsed.results.length === 1 ? parsed.results[0] : null;
  } else {
    rec.runner = 'direct';
    r = spawnSync(process.execPath, ['-e', ISOLATED_RUNNER_SRC], Object.assign({ input: JSON.stringify({ node: process.execPath, file, cwd: root, timeoutMs }) }, spawnOpts));
    try { x = JSON.parse(r.stdout || ''); } catch { x = null; }
  }
  rec.durationMs = Date.now() - started;
  if (r.status !== 0 || !x || typeof x.stdout !== 'string' || typeof x.stderr !== 'string') {
    // The runner may have started the suite: it is NOT run a second time some other way (once means once).
    return Object.assign(rec, { error: 'the ' + (pool ? 'suite pool' : 'isolated runner') + ' delivered no result (status ' + r.status + (r.signal ? ', signal ' + r.signal : '') + ')' });
  }
  status = x.status; signal = x.signal || null; timedOut = !!x.timedOut || (x.status === null && !!x.signal);
  stdout = x.stdout; stderr = x.stderr;
  if (x.error) error = 'the suite could not be started: ' + scrubOneLine(String(x.error), scrub);
  if (Number.isFinite(x.ms)) rec.durationMs = x.ms;
  if (Number.isFinite(x.pid)) rec.pid = x.pid;
  if (typeof x.killed === 'string') rec.killed = x.killed;
  const tally = suiteTally(stdout); // WP-SYNC-R10: STDOUT only, one distinct tally only
  const stdoutFail = suiteOutputFailLines(stdout).length;
  Object.assign(rec, { exitCode: status == null ? null : status, signal, timedOut, error, passed: tally.passed, failed: tally.failed, tallyParsed: tally.parsed, tallyAmbiguous: !!tally.ambiguous, stdoutFailLines: stdoutFail });
  if (tally.ambiguous) rec.tallies = tally.tallies;
  rec.healthy = !timedOut && !error && status === 0 && tally.parsed && tally.passed > 0 && tally.failed === 0 && stdoutFail === 0;
  if (!rec.healthy) {
    // WP-SYNC-R10: redact each stream WHOLE first, only then pick lines
    const so = redactSuiteOutput(stdout, scrub), se = redactSuiteOutput(stderr, scrub);
    if (so.withheld || se.withheld) rec.linesWithheld = SCRUBBER_MISSING_REASON;
    else {
      const all = so.lines.concat(se.lines).join('\n');
      const cut = (l) => String(l).trim().slice(0, SUITE_FAIL_LINE_MAX_CHARS);
      rec.lines = suiteOutputFailLines(all).map(cut);
      if (!rec.lines.length) rec.tail = suiteOutputTail(all).map(cut);
    }
    if (so.unterminated || se.unterminated) rec.outputWithheld = 'an unterminated -----BEGIN ...----- credential block: the output from it to the end is withheld';
  }
  return rec;
}
/** isolatedVerdict(run) -> one plain line for a failed isolated run. */
function isolatedVerdict(run) {
  if (!run) return 'not run';
  if (run.error) return run.error;
  if (run.timedOut) return 'timed out' + (run.limitedByBudget ? ' at the end of the aggregate re-run budget' : ' after the doctor\'s per-suite limit') + (run.killed ? ' (process tree killed: ' + run.killed + ')' : '');
  if (run.tallyAmbiguous) return 'exit ' + run.exitCode + ', several DIFFERENT tallies in stdout (' + (run.tallies || []).join('; ') + ') — ambiguous, no evidence';
  if (!run.tallyParsed) return 'exit ' + run.exitCode + ', no parsable "<n> passed, <m> failed" tally in stdout (0/0 is no evidence)';
  if (run.passed === 0 && run.failed === 0) return 'exit ' + run.exitCode + ', 0 passed, 0 failed (no evidence)';
  if (run.exitCode === 0 && run.failed === 0 && run.stdoutFailLines > 0) return 'exit 0, ' + run.passed + ' passed, 0 failed, but ' + run.stdoutFailLines + ' FAIL / not ok line(s) in stdout — contradictory, not a pass';
  return 'exit ' + run.exitCode + ', ' + run.passed + ' passed, ' + run.failed + ' failed';
}
/** ACCEPTANCE_HEURISTIC_NOTE — WP-SYNC-R10: when the doctor run gave no usable tally for a suite there is nothing to
 *  hold the isolated run's coverage against; the acceptance is then a HEURISTIC, said so in the record and the report. */
const ACCEPTANCE_HEURISTIC_NOTE = 'HEURISTIC: the doctor run gave no usable tally for this suite, so its coverage could not be compared — accepted only because the isolated run exited 0 with exactly one tally (passed > 0, failed == 0) and no FAIL / not ok line in stdout';
/** isolatedAcceptance(firstRun, isolated) -> {accept, rule, reason|note} — pure. WP-SYNC-R10: "passes alone" is not
 *  enough. When the doctor run reached a tally for the suite (passed + failed > 0), the isolated run must reach at least the same
 *  coverage — passed alone >= passed + failed in the doctor run (coverage parity); a suite that skips most of itself alone, or
 *  runs only the part that passes, stays a regression. Without a first-run tally the heuristic above applies. */
function isolatedAcceptance(firstRun, iso) {
  if (!iso) return { accept: false, rule: null, reason: 'not run' };
  if (!iso.healthy) return { accept: false, rule: null, reason: (iso.error && !iso.runner ? 'could not be re-run alone: ' : 'did not pass alone: ') + isolatedVerdict(iso) };
  const fr = firstRun || {};
  const known = Number.isFinite(fr.passed) && Number.isFinite(fr.failed) && fr.passed + fr.failed > 0;
  if (known) {
    const need = fr.passed + fr.failed;
    if (iso.passed < need) return { accept: false, rule: 'coverage-parity', reason: 'passed alone with LESS coverage than inside the doctor run: ' + iso.passed + ' passed alone < ' + fr.passed + ' passed + ' + fr.failed + ' failed = ' + need + ' in the doctor run — a partial or skipping run is not a pass' };
    return { accept: true, rule: 'coverage-parity', note: 'coverage parity: ' + iso.passed + ' passed alone >= ' + need + ' (' + fr.passed + ' passed + ' + fr.failed + ' failed in the doctor run)' };
  }
  return { accept: true, rule: 'heuristic', note: ACCEPTANCE_HEURISTIC_NOTE };
}
/** doctorSuiteDurationHint(projectDir, suite, sinceMs, untilMs, file) -> ms or null: the duration forge-doctor recorded for this
 *  suite in its own pooled run, ONLY when that record was written inside [sinceMs, untilMs] (i.e. by the doctor run just made). */
function doctorSuiteDurationHint(projectDir, suite, sinceMs, untilMs, file) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return null;
  try {
    let r = path.resolve(projectDir);
    if (process.platform === 'win32') r = r.toLowerCase();
    const key = crypto.createHash('sha256').update(r).digest('hex').slice(0, 16); // forge-doctor.cjs suiteRootKey()
    const all = JSON.parse(fs.readFileSync(file || DOCTOR_SUITE_DURATIONS_FILE, 'utf8'));
    const e = all && all[key];
    if (!e || !Number.isFinite(Number(e.at)) || Number(e.at) < sinceMs || Number(e.at) > untilMs + 5000 || !e.ms) return null;
    const ms = Number(e.ms[suite]);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  } catch { return null; }
}
/** firstRunOf(summary, suite, ...) — what the doctor run reported for a flagged suite: counts, timeout, its failing lines. */
function firstRunOf(summary, suite, projectDir, validation, opts) {
  const f = summary && summary.suiteFailures && summary.suiteFailures[suite] ? summary.suiteFailures[suite] : null;
  const since = validation && Number.isFinite(validation.startedAtMs) ? validation.startedAtMs : null;
  const until = since != null && Number.isFinite(validation.durationMs) ? since + validation.durationMs : null;
  const hint = since != null && until != null ? doctorSuiteDurationHint(projectDir, suite, since, until, opts && opts.suiteDurationsFile) : null;
  return {
    passed: f ? f.passed : null, failed: f ? f.failed : null, timedOut: f ? !!f.timedOut : null,
    lines: f && Array.isArray(f.lines) ? f.lines.slice(0, SUITE_FAIL_LINES_MAX) : [],
    linesWithheld: summary && summary.suiteFailuresWithheld ? summary.suiteFailuresWithheld : null,
    durationMs: hint, durationSource: hint != null ? 'forge-doctor suite-duration hint (pooled run)' : 'not reported per suite by forge-doctor --json',
  };
}
/** confirmSuiteRegressions(projectDir, preValidation, validation, outcome, opts) -> {record, outcome}. Called ONLY after a FAILED
 *  validation outcome, BEFORE the rollback. record is null when no suite was flagged (nothing to say, nothing re-run).
 *  - Every flagged suite gets its first-run detail (the doctor's counts + failing lines) — also with the re-run disabled.
 *  - opts.noIsolatedRerun (CLI --no-isolated-rerun) or an ineligible plan (suiteRerunPlan): no re-run; the rollback stands.
 *  - Otherwise each flagged suite is re-run ONCE, alone, one after the other (never in parallel, never a second time). One that
 *    exits 0 with a parsed tally of passed > 0 and failed == 0 is 'flaky-under-load'; one that fails again, times out or has no
 *    parsable tally stays a 'regression'. Only when EVERY flagged suite is flaky-under-load is the outcome re-decided — through
 *    decideValidationOutcome itself, on a copy of the summary with those suites green — so every other rule still applies. */
function confirmSuiteRegressions(projectDir, preValidation, validation, outcome, opts) {
  opts = opts || {};
  const plan = suiteRerunPlan(preValidation, validation);
  if (!plan.flagged.length) return { record: null, outcome };
  const scrub = opts.scrubberUnavailable ? null : loadDoctorScrubber();
  const post = validation.summary;
  const timeout = isolatedRerunTimeout(opts);
  const budget = isolatedRerunBudget(opts); // WP-SYNC-R10 (Codex R9-05b)
  const mode = opts.noIsolatedRerun ? 'disabled' : (plan.eligible ? 'rerun' : 'not-eligible');
  const suites = plan.flagged.map((f) => ({ suite: f.suite, kind: f.kind, firstRun: firstRunOf(post, f.suite, projectDir, validation, opts), isolated: null, classification: 'regression', acceptance: null, reason: null }));
  const envInfo = mode === 'rerun' ? isolatedRerunEnv(process.env) : null; // WP-SYNC-R10
  const phaseStart = Date.now();
  // WP-SYNC-R10: one metadata snapshot before the first re-run, one after each — the difference is what that re-run
  // created / changed / removed under the project (a marker that made it pass becomes visible). Only when a suite will run.
  let snap = mode === 'rerun' && suites.some((s) => !s.firstRun.timedOut) ? projectChangeSnapshot(projectDir) : null;
  for (const s of suites) { // sequential: one suite at a time, each at most once
    if (mode !== 'rerun') { s.reason = mode === 'disabled' ? 'not re-run (--no-isolated-rerun)' : 'not re-run — ' + plan.reason; continue; }
    // WP-SYNC-R10 (Codex R9-05a): a suite that TIMED OUT inside the doctor run is never re-run — a hang under load is exactly
    // what must not be waved through because it happens to finish alone.
    if (s.firstRun.timedOut) { s.reason = 'not re-run — it TIMED OUT inside the doctor run; a hang under load is never accepted as flaky (counted as a regression)'; continue; }
    const left = budget.budgetMs - (Date.now() - phaseStart);
    if (left <= 0) { s.budgetExhausted = true; s.reason = 'not re-run — the aggregate re-run budget (' + Math.round(budget.budgetMs / 1000) + ' s, ' + budget.source + ') was used up before it (counted as a regression)'; continue; }
    const limit = Math.min(timeout.timeoutMs, left);
    s.isolated = runIsolatedSuite(projectDir, s.suite, { timeoutMs: limit, templateDir: opts.templateDir, scrubberUnavailable: !!opts.scrubberUnavailable, forceDirect: !!opts.forceDirectRerun, env: envInfo.env });
    if (limit < timeout.timeoutMs) s.isolated.limitedByBudget = true;
    if (snap) { const after = projectChangeSnapshot(projectDir); s.isolated.projectChanges = projectChangesBetween(snap, after, scrub); snap = after; }
    const acc = isolatedAcceptance(s.firstRun, s.isolated); // WP-SYNC-R10: coverage parity
    s.acceptance = acc.rule;
    if (acc.accept) { s.classification = 'flaky-under-load'; s.reason = 'failed inside the doctor run, passed alone (' + s.isolated.passed + ' passed, 0 failed) — ' + acc.note; }
    else s.reason = acc.reason;
  }
  const flaky = suites.filter((s) => s.classification === 'flaky-under-load').map((s) => s.suite);
  const still = suites.filter((s) => s.classification !== 'flaky-under-load');
  let newOutcome = outcome, kept = false, decision;
  if (mode === 'rerun' && !still.length) {
    const adjustedSummary = summaryWithSuitesGreen(post, flaky);
    const re = decideValidationOutcome(preValidation, Object.assign({}, validation, { ok: adjustedSummary.ok === true, summary: adjustedSummary }), { allowDegraded: opts.allowDegraded });
    if (re.ok) {
      kept = true;
      newOutcome = Object.assign({}, re, { flakyUnderLoad: flaky, isolatedRerun: true, firstReason: outcome.reason || null });
      decision = 'every flagged suite passed when re-run alone (flaky-under-load: ' + flaky.join(', ') + ') — not counted as a regression, the sync is kept (NOT proven healthy under load; see the honesty note)';
    } else {
      decision = 'every flagged suite passed alone, but with them counted green the validation is still not acceptable (' + re.reason + ') — the sync is rolled back';
    }
  } else if (mode === 'rerun') {
    decision = still.length + ' of ' + suites.length + ' flagged suite(s) did not pass when re-run alone (' + still.map((s) => s.suite + ': ' + (s.isolated ? (s.isolated.healthy ? s.reason : isolatedVerdict(s.isolated)) : String(s.reason).replace(/^not re-run — /, 'not re-run: '))).join('; ') + ') — counted as a regression, the sync is rolled back' + (flaky.length ? '; flaky-under-load: ' + flaky.join(', ') : '');
  } else if (mode === 'disabled') {
    decision = 'disabled (--no-isolated-rerun) — every flagged suite counts as a regression, the sync is rolled back as before';
  } else {
    decision = 'not run — ' + plan.reason + ' — the sync is rolled back as before';
  }
  // WP-SYNC-R10: every string that reaches the console, the report or the receipt is scrubbed — suite names come
  // from the doctor's JSON and reasons can quote a runner error
  const scrubLong = (str) => { if (typeof scrub !== 'function') return str; try { const r = redactSuiteOutput(str, scrub); return r.withheld ? '[withheld: the redactor failed on this text]' : r.lines.join(' '); } catch { return '[withheld: the redactor failed on this text]'; } };
  for (const s of suites) if (typeof s.reason === 'string') s.reason = scrubLong(s.reason);
  decision = scrubLong(decision);
  if (!kept) newOutcome = Object.assign({}, outcome, { reason: scrubLong((outcome.reason || 'validation failed') + ' — isolated re-run: ' + decision) });
  const record = {
    schema: 'forge-sync-suite-check/v1', mode, eligible: plan.eligible, notEligibleReason: plan.eligible ? null : scrubLong(plan.reason),
    timeoutMs: timeout.timeoutMs, timeoutSource: timeout.source, suites, flakyUnderLoad: flaky, kept, decision,
    doctorDurationMs: Number.isFinite(validation.durationMs) ? validation.durationMs : null, // the whole doctor run the suites failed in
    // WP-SYNC-R10: the bounds and the environment of the phase, said out loud (names of the kept variables, never a value)
    budgetMs: budget.budgetMs, budgetSource: budget.source, phaseMs: mode === 'rerun' ? Date.now() - phaseStart : null,
    env: envInfo ? { allowList: 'forge-sync isolated re-run allow-list (forge-doctor has none of its own)', kept: envInfo.kept, dropped: envInfo.dropped } : null,
    ...(flaky.length ? { honesty: FLAKY_HONESTY } : {}),
    ...(suites.some((s) => s.acceptance === 'heuristic' && s.classification === 'flaky-under-load') ? { heuristic: ACCEPTANCE_HEURISTIC_NOTE } : {}),
  };
  return { record, outcome: newOutcome };
}
/** suiteCheckErrorRecord(error, outcome, scrub) -> {record, outcome} — WP-SYNC-R10: the isolated re-run step THREW.
 *  The original failed outcome stands (with the error added to its reason) and the caller falls through to the rollback. */
function suiteCheckErrorRecord(error, outcome, scrub) {
  const msg = scrubOneLine(error && error.message ? error.message : String(error), scrub) || 'unknown error';
  const decision = 'the isolated re-run step failed unexpectedly (' + msg + ') — the doctor run\'s failed outcome stands, the sync is rolled back as before';
  return {
    record: { schema: 'forge-sync-suite-check/v1', mode: 'error', eligible: false, notEligibleReason: null, error: msg, suites: [], flakyUnderLoad: [], kept: false, decision },
    outcome: Object.assign({}, outcome, { ok: false, reason: (outcome && outcome.reason ? outcome.reason : 'validation failed') + ' — isolated re-run: ' + decision }),
  };
}
/** projectChangesLine(pc) -> one plain line about what an isolated run changed under the project (null when nothing to say). */
function projectChangesLine(pc) {
  if (!pc) return null;
  const n = pc.created + pc.changed + pc.removed;
  const inc = pc.incomplete ? ' (snapshot INCOMPLETE: ' + pc.incomplete + ' — not every file was compared)' : '';
  if (!n) return 'files under the project changed by this run: none' + inc;
  return 'files under the project changed by this run: ' + pc.created + ' created, ' + pc.changed + ' changed, ' + pc.removed + ' removed — ' + pc.names.join(', ') + (pc.namesTruncated ? ', ...' : '') + inc
    + ' (a marker left behind can make a re-run pass: NOT rejected automatically — judge it)';
}
/** suiteCheckLines(sc) -> plain lines (no markdown) for the console. */
function suiteCheckLines(sc) {
  if (!sc) return [];
  const sec = (ms) => (ms < 10000 ? (Math.round(ms / 100) / 10) : Math.round(ms / 1000)) + ' s';
  if (sc.mode === 'error') return ['suite regression check: FAILED — ' + sc.decision];
  const L = ['suite regression check: ' + sc.suites.length + ' flagged suite(s) — ' + (sc.mode === 'rerun' ? 'each re-run ONCE, alone, before deciding on the rollback (limit ' + Math.round(sc.timeoutMs / 1000) + ' s, ' + sc.timeoutSource + (Number.isFinite(sc.budgetMs) ? '; whole phase capped at ' + Math.round(sc.budgetMs / 1000) + ' s, ' + sc.budgetSource : '') + ')' : (sc.mode === 'disabled' ? 'isolated re-run DISABLED (--no-isolated-rerun)' : 'no isolated re-run (' + sc.notEligibleReason + ')'))];
  if (sc.env) L.push('  environment: ' + sc.env.kept.length + ' allow-listed variable(s) kept, ' + sc.env.dropped + ' dropped (' + sc.env.allowList + ')');
  for (const s of sc.suites) {
    const fr = s.firstRun || {};
    L.push('  ' + s.suite + ' (' + s.kind + '): in the doctor run ' + (fr.timedOut ? 'blocked/timed out' : (fr.passed != null ? fr.passed : '?') + ' passed, ' + (fr.failed != null ? fr.failed : '?') + ' failed')
      + (s.isolated ? '; alone: ' + (s.isolated.healthy ? 'exit 0, ' + s.isolated.passed + ' passed, 0 failed' : isolatedVerdict(s.isolated)) + (Number.isFinite(s.isolated.durationMs) ? ' in ' + sec(s.isolated.durationMs) : '') : '')
      + ' -> ' + (s.classification === 'flaky-under-load' ? 'FLAKY-UNDER-LOAD' : 'REGRESSION'));
    if (s.reason && (!s.isolated || s.acceptance)) L.push('      ' + s.reason);
    const lines = (s.isolated && !s.isolated.healthy && (s.isolated.lines.length || s.isolated.tail.length)) ? (s.isolated.lines.length ? s.isolated.lines : s.isolated.tail) : (fr.lines || []);
    for (const l of lines) L.push('      ' + l);
    if ((s.isolated && s.isolated.linesWithheld) || fr.linesWithheld) L.push('      (failing lines withheld: ' + SCRUBBER_MISSING_REASON + ')');
    if (s.isolated && s.isolated.outputWithheld) L.push('      (' + s.isolated.outputWithheld + ')');
    const pcl = s.isolated ? projectChangesLine(s.isolated.projectChanges) : null;
    if (pcl) L.push('      ' + pcl);
  }
  L.push('  decision: ' + sc.decision);
  if (sc.honesty) L.push('  honesty: ' + sc.honesty);
  if (sc.heuristic) L.push('  heuristic: ' + sc.heuristic);
  return L;
}

// ---- --reuse-pre-baseline (owner request 2026-10-06: "de doctor 1x draaien in plaats van 2x") ----
/** Paths forge-sync itself writes as bookkeeping. They change on every sync (and the receipt cannot contain
 *  its own hash), so they are left out of the workspace fingerprint. Everything else that git reports as
 *  changed or untracked counts. */
function isSyncBookkeepingPath(projectDir, absPath) {
  const base = path.basename(absPath);
  if (base === '.forge-sync.lock' || /\.\d+\.[a-z0-9]+\.tmp$/.test(base)) return true; // lock + writeAtomic temp
  const rel = path.relative(claudeDirOf(projectDir), absPath).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel === 'forge-sync-receipt.json' || rel === 'FORGE_VERSION.json'
    || /^forge-sync-report-[^/]*\.md$/.test(rel) // the change report is written after the receipt
    || /^(forge-backups|forge-backups-central|forge-adopt-snapshots)(\/|$)/.test(rel);
}
/** workspaceFingerprint(projectDir) — {gitHead, gitStatusHash} for the project folder, or null when it is not
 *  a git repo / git is unavailable (best-effort, never throws). Uses `git --no-optional-locks` so the probe
 *  never takes the index lock or rewrites the index. gitStatusHash covers `status --porcelain` (limited to
 *  this project folder, untracked files listed individually) AND the CONTENT hash of every listed file —
 *  porcelain alone prints " M file" for a file that is edited again after it was already dirty, so a hash of
 *  the porcelain text alone could not see a second edit. Gitignored files are not covered (git does not list
 *  them); that is a stated limit, not a hidden one. */
function workspaceFingerprint(projectDir) {
  const git = (args) => {
    try {
      const r = spawnSync('git', ['--no-optional-locks', '-C', path.resolve(projectDir)].concat(args), { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      return r.status === 0 && !r.error ? r.stdout : null;
    } catch { return null; }
  };
  const top = git(['rev-parse', '--show-toplevel']);
  if (top == null) return null;
  const topDir = top.trim();
  const head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  // WP-SYNC-R8: .claude/worktrees/ (agent scratch checkouts) is left out — when it is not gitignored, -uall would otherwise list
  // (and this function hash) every file of every non-repository folder in it. Everything else under .claude still counts.
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', gitExcludePathspec('.claude/worktrees')]);
  if (status == null) return null;
  const tokens = status.split('\0');
  const lines = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 4) continue;
    const xy = tok.slice(0, 2);
    const relPath = tok.slice(3);
    let origPath = '';
    if (xy[0] === 'R' || xy[0] === 'C') { origPath = tokens[i + 1] || ''; i++; } // -z: rename source follows
    const abs = path.join(topDir, relPath);
    if (isSyncBookkeepingPath(projectDir, abs)) continue;
    let content = 'missing';
    try { const st = fs.lstatSync(abs); content = st.isFile() ? sha256(abs) : (st.isDirectory() ? 'dir' : 'other'); } catch { content = 'missing'; }
    lines.push(xy + ' ' + relPath + (origPath ? ' <- ' + origPath : '') + ' ' + content);
  }
  // WP-SYNC-R10 (Codex R8-03c): the status above leaves .claude/worktrees/ out (its non-checkout folders would be listed file by
  // file). Two CHEAP stand-ins keep it from being invisible to --reuse-pre-baseline: (1) the TRACKED-file status under it
  // (`--untracked-files=no`: git only checks index entries there, it never walks the folder), and (2) one readdir of its children
  // — name, kind, checkout marker, and size + modified time of a plain file directly in it. Stated limit: an edit to an UNTRACKED
  // file deeper inside a non-checkout folder there does not change the fingerprint (the doctor's git-mode leak scan does not
  // read untracked files either).
  const wtStatus = git(['status', '--porcelain', '-z', '--untracked-files=no', '--', (CASE_INSENSITIVE_FS ? ':(icase)' : '') + '.claude/worktrees']);
  if (wtStatus == null) return null;
  for (const tok of wtStatus.split('\0')) if (tok.length >= 4) lines.push('worktrees-tracked ' + tok);
  lines.push('worktrees-children ' + worktreesChildrenSignature(path.join(claudeDirOf(projectDir), 'worktrees')));
  lines.sort();
  return {
    gitHead: head == null ? null : (head.trim() || null),
    gitStatusHash: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'),
  };
}
/** decidePreBaseline — pure decision for --reuse-pre-baseline: may the previous receipt's post-sync
 *  validation stand in for this sync's pre-sync doctor run (H3 baseline)? Only when it is proven safe:
 *   (1) a receipt with a real, evidence-backed, fully GREEN forge-doctor summary (not degraded / no-evidence /
 *       missing, and not red-but-accepted via alreadyRedSkipped or degradedAllowed);
 *   (2) its postSyncManifestHash equals the manifest computed NOW — every system file is byte-identical to
 *       the moment that validation ran;
 *   (3) the workspace: the receipt's recorded git fingerprint must match the current one exactly; a
 *       receipt without one (written before this feature, or a non-git project) is never reused.
 *   The summary itself must be a complete, consistent, fully green doctor summary (preBaselineSummaryProblem).
 *  Anything else returns reuse:false with a one-line reason; the caller then runs the doctor as normal. The
 *  returned preValidation feeds decideValidationOutcome unchanged — the regression comparison is not
 *  weakened, it only receives a summary that was measured earlier on byte-identical system files. */
/** WP-SYNC-R12: currentSettings (optional, a settingsSnapshot) — a receipt that records the settings.json its doctor
 *  judged (receipt.settingsJudged) is reused only while settings.json still is exactly that; a receipt without the record (written
 *  before WP-SYNC-R12) is judged as before. */
function decidePreBaseline(receipt, currentManifestHash, currentWorkspace, nowMs, currentSettings) {
  if (!receipt) return { reuse: false, reason: 'no forge-sync-receipt.json (nothing to reuse)' };
  const v = receipt.validation;
  if (!v || !v.summary) return { reuse: false, reason: 'the last receipt has no validation summary' };
  if (v.degraded || v.noEvidence || v.timedOut) return { reuse: false, reason: 'the last receipt\'s validation was ' + (v.degraded ? 'degraded' : (v.noEvidence ? 'without evidence' : 'timed out')) + ' — not a usable baseline' };
  if (v.tool !== 'forge-doctor') return { reuse: false, reason: 'the last receipt was not validated by forge-doctor (' + (v.tool ? v.tool : 'no tool recorded') + ')' };
  // Only a fully GREEN receipt is a baseline. A red-but-accepted one (alreadyRedSkipped) would let
  // decideValidationOutcome wave a NEW regression on an already-red check through as "pre-existing".
  if (v.ok !== true || (v.summary && v.summary.ok === false) || v.alreadyRedSkipped || v.degradedAllowed) return { reuse: false, reason: 'the last receipt was not green — a red baseline is always re-measured' };
  const schemaProblem = preBaselineSummaryProblem(v.summary);
  if (schemaProblem) return { reuse: false, reason: 'the last receipt\'s validation summary is not a usable baseline (' + schemaProblem + ') — re-measured' };
  if (!receipt.postSyncManifestHash) return { reuse: false, reason: 'the last receipt has no post-sync manifest hash' };
  if (typeof currentManifestHash === 'string' && currentManifestHash.startsWith('unusable:')) return { reuse: false, reason: 'system files cannot be compared with the last sync (' + currentManifestHash.slice(9) + ')' };
  if (receipt.postSyncManifestHash !== currentManifestHash) return { reuse: false, reason: 'system files changed since the last sync (manifest hash differs)' };
  const syncedMs = Date.parse(receipt.syncedAt || '');
  const ageMs = Number.isFinite(syncedMs) ? nowMs - syncedMs : null;
  const source = { batchId: receipt.batchId || null, syncedAt: receipt.syncedAt || null, ageMs };
  // R1 (Codex rev-goat-215cee4-2): the workspace must be PROVEN by an exact fingerprint match. A receipt
  // without one (pre-feature, non-git project, or a failed fingerprint write) is never reused, whatever its age.
  const recorded = receipt.workspace && typeof receipt.workspace === 'object' && receipt.workspace.gitStatusHash ? receipt.workspace : null;
  if (!recorded) return { reuse: false, reason: 'the last receipt has no workspace fingerprint — re-measured' };
  if (!currentWorkspace || !currentWorkspace.gitStatusHash) return { reuse: false, reason: 'the last receipt recorded a git workspace fingerprint but the current one could not be computed' };
  if (recorded.gitHead !== currentWorkspace.gitHead) return { reuse: false, reason: 'workspace changed since the last sync (git HEAD differs)' };
  if (recorded.gitStatusHash !== currentWorkspace.gitStatusHash) return { reuse: false, reason: 'workspace changed since the last sync (git status/content differs)' };
  // WP-SYNC-R12: the doctor verdict covers only the settings.json it judged — a different one now (whatever changed it) is re-measured
  if (receipt.settingsJudged && typeof receipt.settingsJudged === 'object') {
    const rec = receipt.settingsJudged;
    const cur = currentSettings && typeof currentSettings === 'object' ? currentSettings : null;
    const same = !!cur && cur.kind !== 'unreadable' && cur.kind === rec.kind && (cur.kind === 'missing' || (typeof rec.sha256 === 'string' && cur.hash === rec.sha256));
    if (!same) return { reuse: false, reason: 'settings.json is not the one the last receipt\'s doctor judged (judged ' + (rec.kind === 'ok' ? 'sha256 ' + String(rec.sha256).slice(0, 12) : rec.kind) + ', now ' + settingsStateLabel(cur) + ') — re-measured' };
  }
  return {
    reuse: true, workspaceProven: true, note: null, source,
    preValidation: { tool: 'forge-doctor', exitCode: v.exitCode, ok: v.ok, summary: v.summary, degraded: false, commands: [], reused: true },
  };
}
/** preBaselineSummaryProblem — R2 (Codex rev-goat-215cee4-2): a reused summary becomes the `pre` side of
 *  regressionCheck, which compares docCheckOkMap(summary) — i.e. summary.checksOk plus summary.ok. An empty
 *  or partial summary would hide a check that vanishes post-sync (pre undefined + post undefined = no
 *  regression), so only a complete, self-consistent, fully green condenseDoctorSummary shape is accepted.
 *  Returns a one-line problem, or null when the summary is a usable baseline. */
function preBaselineSummaryProblem(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'the summary is not an object';
  if (s.ok !== true) return 'summary.ok is not true';
  const map = s.checksOk;
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length === 0) return 'no per-check map (summary.checksOk missing or empty)';
  const notGreen = Object.keys(map).filter((k) => !(map[k] && typeof map[k] === 'object' && map[k].ok === true));
  if (notGreen.length) return 'checks not green: ' + notGreen.join(', ');
  if (s.failing_suites !== undefined && !(Array.isArray(s.failing_suites) && s.failing_suites.length === 0)) return 'failing_suites is not empty';
  const inconsistent = ['node_check', 'tests'].filter((k) => s[k] != null && !(typeof s[k] === 'object' && s[k].ok === true));
  if (inconsistent.length) return 'inconsistent: checksOk is green but the ' + inconsistent.join(', ') + ' detail is not';
  return null;
}
function formatAgeMs(ms) {
  if (!Number.isFinite(ms)) return 'unknown age';
  const min = Math.round(ms / 60000);
  return min < 60 ? min + ' min' : (Math.floor(min / 60) + 'h ' + (min % 60) + 'min');
}

// ---- rollback: integrity-checked, journaled (resumable/idempotent), project-local-first then central ----
function verifyBackupIntegrity(manifestDir, manifest) {
  const problems = [];
  for (const f of manifest.files) {
    if (f.oldHash === null) continue; // nothing to check — this file didn't exist pre-sync
    const p = path.join(manifestDir, f.rel);
    if (!fs.existsSync(p)) { problems.push({ rel: f.rel, reason: 'backup file missing' }); continue; }
    if (sha256(p) !== f.oldHash) problems.push({ rel: f.rel, reason: 'backup file hash mismatch (corrupt)' });
  }
  return { ok: problems.length === 0, problems };
}
/** loadTrustedManifest(projectDir, batchId, centralBackupRoot, opts) -> {ok, source, manifestDir, manifest, binding} |
 *  {ok:false, found, legacyUnbound?, reason}. R3: a manifest is trusted only when (1) its folder chain has no reparse point
 *  and stays inside the project (or below the named central root) — SYNC-01; (2) it is BOUND to this project's real path
 *  and this batch id with a matching self-hash — SYNC-02(b); a legacy-unbound manifest (older forge-sync) only with
 *  opts.allowLegacyManifest; (3) every entry passes manifestEntryProblems — SYNC-02(a); (4) its backup bytes hash-match.
 *  `found` says whether any manifest existed at all (rollbackProject only falls back to the ledger-only path without one). */
function loadTrustedManifest(projectDir, batchId, centralBackupRoot, opts) {
  opts = opts || {};
  if (!isSafeBatchId(batchId)) return { ok: false, reason: unsafeBatchIdReason(batchId) || 'no batch id given' }; // SYNC-13
  const reasons = [];
  let found = false, legacyUnbound = false;
  const tryDir = (dir, source, chain) => {
    if (!chain.ok) { if (lstatKind(dir) !== 'missing') { found = true; reasons.push(source + ': ' + chain.problem); } return null; }
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
    catch (e) { if (e && e.code !== 'ENOENT') { found = true; reasons.push(source + ': manifest unreadable (' + e.message + ')'); } return null; }
    found = true;
    const b = manifestBinding(m, projectDir, batchId);
    if (b.state === 'tampered' || b.state === 'mismatch') { reasons.push(source + ': not trusted — ' + b.reason); return null; }
    if (b.state === 'legacy-unbound' && !opts.allowLegacyManifest) {
      legacyUnbound = true;
      reasons.push(source + ': legacy-unbound manifest (' + b.reason + ') — refusing an unattended rollback; check it, then re-run with --allow-legacy-manifest');
      return null;
    }
    const bad = manifestEntryProblems(m);
    if (bad.length) { reasons.push(source + ': ' + bad.slice(0, 4).join('; ')); return null; }
    if (!verifyBackupIntegrity(dir, m).ok) { reasons.push(source + ': backup bytes missing or corrupt'); return null; }
    return { ok: true, source, manifestDir: dir, manifest: m, binding: b.state };
  };
  const pDir = backupDirFor(projectDir, batchId);
  let pChain;
  try { assertClaudeBaseContained(projectDir); pChain = realDirChain(claudeDirOf(projectDir), pDir, { create: false }); }
  catch (e) { pChain = { ok: false, problem: e.message }; }
  const local = tryDir(pDir, 'project', pChain);
  if (local) return local;
  if (centralBackupRoot) {
    const pid = projectId(projectDir);
    let cDir = centralBackupDir(centralBackupRoot, batchId, pid), cChain;
    try {
      if (lstatKind(path.resolve(centralBackupRoot)) === 'missing') cChain = { ok: false, problem: 'no central backup root' };
      else { const a = centralAnchorFor(projectDir, centralBackupRoot, { create: false }); cDir = centralBackupDir(a.root, batchId, pid); cChain = realDirChain(a.anchor, cDir, { create: false }); }
    } catch (e) { cChain = { ok: false, problem: e.message }; }
    const central = tryDir(cDir, 'central', cChain);
    if (central) return central;
  }
  return {
    ok: false, found, legacyUnbound,
    reason: (found ? 'no TRUSTED backup manifest for batch ' + batchId + ' (' + reasons.join(' | ') + ')' : 'no valid (uncorrupted) backup manifest found for batch ' + batchId + ' (checked project-local' + (centralBackupRoot ? ' and central' : '') + ' locations)')
      + ' — REFUSING to restore rather than fabricate a result',
  };
}
/** findNewerOverlappingBatches — B7 (part 2). S4 FIX: the OLD code only ever inspected the PROJECT-LOCAL
 *  backups dir. In a central-only recovery (the project's own `.claude/forge-backups/` is damaged/wiped —
 *  exactly the scenario a central hub exists for), a genuinely newer batch that already touched the same
 *  file(s) went completely undetected here, so this function silently returned [] and the caller fell through
 *  to a LESS informative generic "content diverged" refusal (from computeDivergence) that never names WHICH
 *  batch caused it. Now also scans <centralBackupRoot>/.claude/forge-backups/<batchId>/<projectId>/
 *  manifest.json for every batch id found there, in addition to the local scan, de-duplicated by batchId
 *  (local checked first) so the SAME batch is never double-counted. */
function findNewerOverlappingBatches(projectDir, batchId, manifest, centralBackupRoot) {
  const targetRels = new Set((manifest.files || []).map((f) => f.rel));
  const seen = new Set();
  const overlaps = [];
  const consider = (id, m) => {
    if (id === batchId || seen.has(id)) return;
    seen.add(id);
    if (!m || !m.ts || !manifest.ts || !(m.ts > manifest.ts)) return; // only strictly-newer batches matter
    const overlapRels = (m.files || []).map((f) => f.rel).filter((rel) => targetRels.has(rel));
    if (overlapRels.length) overlaps.push({ batchId: id, ts: m.ts, rels: overlapRels });
  };

  const bdir = path.join(claudeDirOf(projectDir), 'forge-backups');
  let localEntries = [];
  try { localEntries = fs.readdirSync(bdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* local backups dir gone/damaged */ }
  for (const id of localEntries) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(bdir, id, 'manifest.json'), 'utf8')); } catch { continue; }
    consider(id, m);
  }

  if (centralBackupRoot) { // S4: also scan the central hub — findable even when local is entirely gone
    const centralBatchesDir = path.join(centralBackupRoot, '.claude', 'forge-backups');
    const pid = projectId(projectDir);
    let centralBatchIds = [];
    try { centralBatchIds = fs.readdirSync(centralBatchesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no central hub / not created yet */ }
    for (const id of centralBatchIds) {
      let m; try { m = JSON.parse(fs.readFileSync(path.join(centralBatchesDir, id, pid, 'manifest.json'), 'utf8')); } catch { continue; }
      consider(id, m);
    }
  }
  return overlaps;
}
function journalPath(manifestDir) { return path.join(manifestDir, 'rollback-journal.json'); }
/** subsetManifest — a shallow copy of a backup manifest restricted to a subset of rels (used when only
 *  PART of a plan was actually applied before a failure, so rollback never touches an untouched file). */
function subsetManifest(manifest, rels) {
  const relSet = new Set(rels);
  return Object.assign({}, manifest, { files: manifest.files.filter((f) => relSet.has(f.rel)) });
}
/** computeDivergence — B7 (part 1): for every file NOT yet restored (per the journal), confirm the CURRENT
 *  on-disk content still matches what THIS sync wrote (newHash). A file that is simply ABSENT is not treated
 *  as diverged (nothing to protect — restoring/removing it is harmless); a file holding SOME OTHER content
 *  (neither newHash nor absent) means someone changed it since this sync, and rolling back would destroy
 *  that — refuse unless --force-rollback-newer. Legacy manifests (no newHash field) can't be checked and are
 *  allowed through unchanged (backward compatible with a pre-B7 backup). */
function computeDivergence(dst, manifest, doneSet) { // doneSet: rels to leave out (already restored, or never written)
  const diverged = [];
  for (const f of manifest.files) {
    if (doneSet.has(f.rel)) continue;
    if (!Object.prototype.hasOwnProperty.call(f, 'newHash')) continue;
    const out = safeJoin(dst, f.rel);
    if (out == null) continue;
    const currentHash = sha256(out);
    if (currentHash === f.newHash) continue;
    // AUDIT #19: a file still at its recorded OLD hash is by definition the pre-batch state
    // — the exact bytes this rollback would restore. Refusing it as "diverged" made every rollback of a
    // half-applied batch (a crash left some files unwritten) refuse without --force-rollback-newer, which
    // punished the one situation rollback exists for. Foreign work (neither newHash nor oldHash) is still
    // refused; restoring an oldHash-file is a verified no-op.
    if (Object.prototype.hasOwnProperty.call(f, 'oldHash') && currentHash === f.oldHash) continue;
    if (currentHash === null) continue; // missing entirely -> nothing to protect
    diverged.push({ rel: f.rel, expected: f.newHash, current: currentHash });
  }
  return diverged;
}
/** restoreFromManifest — restores byte-for-byte from an already-TRUSTED manifest/manifestDir. Journaled: a
 *  thrown interruption (real or the __throwAfter test hook, gated behind FORGE_SYNC_TEST_HOOKS=1) leaves
 *  rollback-journal.json with the rels already restored; calling this again on the SAME manifestDir resumes
 *  from there (idempotent). H1: every restore step is verified — ENOENT-on-delete is tolerated, but any OTHER
 *  error (EPERM, an unsafe path) is recorded as a real failure, and every file is RE-HASHED after its restore
 *  attempt; a rel is only ever added to `restored` when that verification actually passed. If any file fails,
 *  the whole call returns {ok:false, partial:true, restored, failed} — never a false "restored" claim — and
 *  the journal is left in-progress so a later re-run (e.g. after fixing a lock) can retry just the failures.
 *  B7: refuses up front (before touching anything) if any not-yet-restored file has diverged from what this
 *  sync wrote, unless opts.forceRollbackNewer. B2: also restores/removes forge-sync-receipt.json, exactly
 *  like FORGE_VERSION.json, so a rolled-back project's next preflight() sees a receipt consistent with its
 *  actual (reverted) file contents instead of a stale receipt describing the undone sync. */
function restoreFromManifest(projectDir, manifestDir, manifest, opts) {
  assertClaudeBaseContained(projectDir);
  opts = opts || {};
  // R3 / SYNC-02(a): validate EVERY entry before anything is touched — a never-touch path (FORGE_MEMORY.md, agent-memory/,
  // key material) or a non-plain path refuses the whole restore, whatever the manifest says.
  const entryProblems = manifestEntryProblems(manifest);
  if (entryProblems.length) return { ok: false, refusedManifest: true, problems: entryProblems, restored: [], reason: 'refusing to restore from this manifest: ' + entryProblems.slice(0, 6).join('; ') };
  const dst = claudeDirOf(projectDir);
  // R3 / SYNC-02(c) + SYNC-04: what this batch really did, per file (the apply journal beside the manifest). A file it
  // SKIPPED was never written by it; a file it CREATED is the only kind a rollback may delete.
  // the journal is verified as a chain bound to this batch, and against the head the bound manifest recorded. An
  // UNTRUSTED journal (gap, reorder, truncation, unbound or malformed record, head mismatch, or missing although recorded)
  // proves nothing: no file is deleted on its say-so and no "skipped" record suppresses a restore; it is reported.
  const applyRec = readApplyJournal(manifestDir, { batchId: manifest.batchId, expectedHead: manifest.apply_journal || null });
  const journalTrusted = applyRec.present ? applyRec.trusted : !applyRec.reason; // no file: untrusted only when the manifest anchored records (R6: a {genesis, 0} anchor recorded none)
  const journalNote = journalTrusted ? null : ('journal-untrusted: ' + (applyRec.reason || 'the apply journal is missing although the manifest recorded one'));
  const bound = manifest.schema === BACKUP_MANIFEST_SCHEMA;
  const jPath = journalPath(manifestDir);
  let journal;
  try { journal = JSON.parse(fs.readFileSync(jPath, 'utf8')); } catch { journal = null; }
  if (!journal || journal.status === 'complete') journal = { batchId: manifest.batchId, status: 'in-progress', doneRels: [], versionRestored: false, receiptRestored: false };
  const doneSet = new Set(journal.doneRels);
  const notWritten = journalTrusted ? manifest.files.filter((f) => applyRec.skipped.has(f.rel)).map((f) => f.rel) : [];
  const excluded = new Set([...doneSet, ...notWritten]);

  if (!opts.forceRollbackNewer) {
    const diverged = computeDivergence(dst, manifest, excluded);
    if (diverged.length) return { ok: false, refusedDivergence: true, diverged, restored: [] };
  }

  const testHooksEnabled = process.env.FORGE_SYNC_TEST_HOOKS === '1'; // gate the test-only throw switch
  const restored = [], failed = [], kept = [], quarantined = [];
  for (const f of manifest.files) {
    if (doneSet.has(f.rel)) { restored.push(f.rel); continue; }
    if (journalTrusted && applyRec.skipped.has(f.rel)) continue; // never written by this batch: nothing of ours to undo
    if (testHooksEnabled && opts.__throwAfter != null && restored.length === opts.__throwAfter) {
      journal.doneRels = [...doneSet];
      fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
      throw new Error('SIMULATED rollback interruption after ' + restored.length + ' file(s) (test-only injection hook)');
    }
    const out = safeJoin(dst, f.rel);
    let ok = true, reason = null, real = null;
    if (out == null) { ok = false; reason = 'unsafe path (containment guard tripped)'; }
    // CODEX ronde-3 #8: het RESTORE-pad had geen symlink/realpath-guard — het scenario "A is
    // toegepast, een junction verschijnt, B triggert de apply-refusal, en de rollback schrijft A dwars
    // door diezelfde junction naar buiten" liep dus om de write-time guard van applyPlanSafely heen.
    // Dezelfde check, op hetzelfde moment: vlak voor de write/delete. (Volledig raceloos kan alleen met
    // no-follow-handles die fs.copyFileSync niet biedt — dat restrisico is gedocumenteerd, niet verstopt.)
    else if (isSymlinkPath(out) || !containmentSafe(dst, out)) { ok = false; reason = 'containment guard tripped at restore time (symlink/junction on the path)'; }
    else if ((real = realTargetCheck(dst, out)).problem) { ok = false; reason = 'refused by the real-path floor: ' + real.problem; } // the folder it was judged on is kept)
    else if (f.oldHash === null) {
      // R3 / SYNC-02(c): a rollback deletes ONLY a file this batch itself created, and only while it still holds exactly
      // those bytes. R4 / F02: "created" means a TRUSTED journal's post-write `created` record whose recorded hash equals the
      // manifest's newHash; a creation INTENT is not proof (another writer may have won the exclusive create). A legacy
      // manifest has no journal: there only an exact newHash match counts. Anything else is kept and reported; under
      // --force-rollback-newer a file this batch provably created but someone changed since is MOVED into the batch backup.
      const cur = sha256(out);
      if (cur !== null) {
        const exact = typeof f.newHash === 'string' && cur === f.newHash;
        const provenCreated = journalTrusted && applyRec.created.has(f.rel) && applyRec.createdHash.get(f.rel) === f.newHash;
        const ours = provenCreated || (!bound && !applyRec.present && exact);
        try {
          if (ours && exact) {
            const q = quarantineAndVerify(out, cur, real.realParent); // moved aside, re-hashed, removed only when still ours
            if (!q.removed) throw new Error('changed while it was being moved aside — kept (' + q.reason + ')');
          } else if (ours && opts.forceRollbackNewer) {
            const qTarget = path.join(manifestDir, 'rollback-quarantine', ...f.rel.split('/'));
            ensureRealDir(manifestDir, path.dirname(qTarget));
            copyNoFollow(out, qTarget, manifestDir);
            if (sha256(qTarget) !== cur) throw new Error('the quarantine copy could not be verified — kept');
            const q = quarantineAndVerify(out, cur, real.realParent);
            if (!q.removed) throw new Error('changed again while it was being moved aside — kept (' + q.reason + ')');
            quarantined.push({ rel: f.rel, movedTo: qTarget });
          } else {
            kept.push({ rel: f.rel, reason: ours ? 'created by this batch but changed since — kept (pass --force-rollback-newer to move it into the batch backup)' : (journalNote ? journalNote + ' — not proven to be created by this batch, never deleted' : 'not proven to be created by this batch (no apply-journal record of its creation) — never deleted') });
            ok = false; reason = 'kept: ' + kept[kept.length - 1].reason;
          }
        } catch (e) { if (!e || e.code !== 'ENOENT') { ok = false; reason = e.message; } }
      }
    } else {
      // the backup bytes are read and verified IN MEMORY against the recorded oldHash, then written with a
      // re-hash of the destination right before the rename: it must still hold what was judged a moment ago (this sync's
      // newHash, or be absent) — otherwise 'changed-during-restore', kept.
      // the sample taken here is itself judged against the manifest BEFORE anything is staged — the divergence scan
      // above ran earlier, and an owner edit in between must not become the "expected" bytes of the write. Unless the owner
      // asked for --force-rollback-newer, only this batch's own bytes (newHash) or an absent file may be replaced; anything
      // else is kept and reported. (A legacy entry without newHash cannot be judged — unchanged, as computeDivergence.)
      try {
        const cur = sha256(out);
        if (cur !== f.oldHash) {
          const judgeable = Object.prototype.hasOwnProperty.call(f, 'newHash');
          if (!opts.forceRollbackNewer && judgeable && cur !== null && cur !== f.newHash) {
            const why = 'changed since the divergence check (now ' + cur.slice(0, 12) + ', neither the bytes this batch wrote ' + String(f.newHash).slice(0, 12) + ' nor absent) — kept, never overwritten (pass --force-rollback-newer to replace it anyway)';
            kept.push({ rel: f.rel, reason: why });
            throw new Error('kept: ' + why);
          }
          const buf = fs.readFileSync(path.join(manifestDir, ...f.rel.split('/')));
          if (crypto.createHash('sha256').update(buf).digest('hex') !== f.oldHash) throw new Error('the backup copy does not hold the recorded pre-batch bytes — refusing to restore unverified content');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const r = writeBytesNoFollow(buf, out, dst, { expectOldHash: cur, approvedRealParent: real.realParent, floor: true }); // R6 / F15
          if (r === 'changed') throw new Error('changed-during-restore: the file changed again right before it was replaced — kept');
        }
      } catch (e) { ok = false; reason = e.message; }
    }
    if (ok && out != null) { // H1: post-step verification — never trust "no exception" alone
      if (f.oldHash === null) { if (fs.existsSync(out)) { ok = false; reason = 'file still present after delete attempt'; } }
      else { const h = sha256(out); if (h !== f.oldHash) { ok = false; reason = 'hash mismatch after restore (expected ' + f.oldHash + ', got ' + h + ')'; } }
    }
    if (ok) { restored.push(f.rel); doneSet.add(f.rel); } else failed.push({ rel: f.rel, reason });
    journal.doneRels = [...doneSet];
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }

  if (failed.length) return { ok: false, partial: true, restored, failed, kept, quarantined, notWritten, journal: { trusted: journalTrusted, note: journalNote } };

  if (!journal.versionRestored) {
    if (manifest.hadVersionFile) writeAtomic(versionFilePath(projectDir), manifest.oldVersion); // atomic on rollback too (audit #22)
    else { try { fs.rmSync(versionFilePath(projectDir), { force: true }); } catch { /* already gone */ } }
    journal.versionRestored = true;
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }
  if (!journal.receiptRestored) {
    if (Object.prototype.hasOwnProperty.call(manifest, 'hadReceipt')) {
      if (manifest.hadReceipt) writeAtomic(receiptPath(projectDir), manifest.oldReceipt); // atomic on rollback too (audit #22)
      else { try { fs.rmSync(receiptPath(projectDir), { force: true }); } catch { /* already gone */ } }
    }
    journal.receiptRestored = true;
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }
  // AUDIT #21: a manifest written by a sync that seeded the project scaffold carries the
  // undo-information for it (see safeSyncProject's manifest-persist step). A LATER rollback — the crash
  // case that never reached the in-run undoScaffold — can therefore revert the scaffold too: created
  // files via the same allow-listed remover, the .gitignore append only when the bytes still equal
  // prior+appended (an owner edit in between is never clobbered).
  let scaffoldAction = 'none';
  if (manifest.scaffold) {
    // CODEX ronde-3 #7: rapporteer wat de scaffold-undo WERKELIJK deed — "reverted" zonder
    // te kijken was een claim, geen observatie. createdHashes beschermt owner-bewerkte created files.
    const undone = undoScaffold({
      created: manifest.scaffold.created || [],
      createdHashes: manifest.scaffold.createdHashes,
      gitignorePrior: manifest.scaffold.gitignorePrior,
      gitignoreAppended: manifest.scaffold.gitignoreAppended,
      errors: [],
    }, projectDir);
    scaffoldAction = 'created removed: [' + undone.removedCreated.join(', ') + ']'
      + (undone.keptForeign.length ? ' · kept (owner work): [' + undone.keptForeign.join('; ') + ']' : '')
      + ' · gitignore: ' + undone.gitignore
      + (undone.errors.length ? ' · errors: ' + undone.errors.join('; ') : '');
  }
  journal.status = 'complete';
  fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  return {
    ok: true, restored, versionAction: manifest.hadVersionFile ? 'restored' : 'removed',
    receiptAction: !('hadReceipt' in manifest) ? 'unknown (legacy manifest predates receipt backup)' : (manifest.hadReceipt ? 'restored' : 'removed'),
    scaffoldAction, quarantined, notWritten, journal: { trusted: journalTrusted, note: journalNote },
  };
}
/** batchRecency(bdir, id) -> epoch-millis number, or null when `id` is not a real batch at all.
 *  SYNC-6 fix (Codex adversarial-review, MEDIUM): the pre-fix latestBatchId() only ever considered a
 *  batch directory that has a main manifest.json — but safeSyncProject's no-op path can call
 *  pruneRetiredFiles() with a real batchId WITHOUT ever calling takeBackup() (there is nothing else to
 *  back up), leaving that batch with ONLY its own retired-prune-manifest.json (see rollbackProject's own
 *  doc comment for the full "ledger-only batch" model). Such a batch was invisible to "the latest batch",
 *  so `forge-sync rollback <project>` with no explicit --batch could silently skip a newer ledger-only
 *  batch and roll back an older one instead.
 *  manifest.json's own `ts` (an ISO-8601 string, recorded once by takeBackup() and never touched again)
 *  remains the AUTHORITATIVE recency signal when present — converted to epoch millis via Date.parse() so
 *  it is directly comparable against the fallback below, rather than relying on ISO-string lexical
 *  ordering (still correct for valid ISO strings, but numeric comparison is what lets a ledger-only
 *  batch's mtime-based recency be compared on equal footing). A manifest.json that exists but is
 *  unreadable/unparseable for a reason OTHER than ENOENT keeps the pre-fix "skip, do not trust" posture
 *  (returns null) — this fix only reaches a batch that has genuinely NO main manifest.json at all.
 *  For that ledger-only case, retired-prune-manifest.json carries no `ts` field of its own (see
 *  pruneRetiredFiles' writeAtomic call) — the ledger FILE's own mtime is the best available recency
 *  signal: still real evidence of when this project's sync actually ran, never a guess, and the only
 *  reason this batch would otherwise be silently invisible to "the latest batch". A batch directory with
 *  NEITHER file is not a real batch at all (e.g. an empty or foreign directory) and returns null. */
function batchRecency(bdir, id) {
  let manifestRaw;
  try { manifestRaw = fs.readFileSync(path.join(bdir, id, 'manifest.json'), 'utf8'); }
  catch (e) {
    if (!e || e.code !== 'ENOENT') return null; // present but unreadable for another reason — skip, do not trust
    try { return fs.statSync(path.join(bdir, id, RETIRED_PRUNE_MANIFEST_NAME)).mtimeMs; }
    catch { /* no retired-prune ledger either */ }
    try { return fs.statSync(path.join(bdir, id, RETIRED_ORPHANS_MANIFEST_NAME)).mtimeMs; } // orphan-ledger-only batch
    catch { /* no orphan ledger either */ }
    try { return fs.statSync(path.join(bdir, id, SETTINGS_LEDGER_NAME)).mtimeMs; } // settings-ledger-only batch
    catch { return null; } // no file at all — not a real batch
  }
  try {
    const m = JSON.parse(manifestRaw);
    const t = Date.parse(m && m.ts);
    return Number.isFinite(t) ? t : 0; // present but no/malformed ts — treat as very old, never throw
  } catch { return null; } // present but unparseable manifest.json — same "skip unreadable" posture as before
}
function latestBatchId(projectDir) {
  const bdir = path.join(claudeDirOf(projectDir), 'forge-backups');
  let entries = [];
  try { entries = fs.readdirSync(bdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  let best = null, bestTs = -Infinity;
  for (const id of entries) {
    const t = batchRecency(bdir, id);
    if (t === null) continue;
    if (best === null || t > bestTs) { best = id; bestTs = t; }
  }
  return best;
}
/** verifyRetiredPruneLedger(ledger, batchId, projectDir, pruneDir) -> {entries[], dropped[]}.
 *  validates a retired-prune-manifest.json ledger is trustworthy BEFORE any restore touches
 *  disk, mirroring loadTrustedManifest's "refuse rather than restore something unverified" posture for the
 *  main manifest:
 *   1. the ledger's own batchId/projectPath must match the batch/project actually being restored — a
 *      forged or copied-in ledger for a DIFFERENT batch or project is rejected outright, not honored;
 *   2. every entry's `rel` must be EXACTLY one of RETIRED_TEMPLATE_FILES/RETIRED_STATE_FILES — an entry
 *      naming any other path (however it got there) is dropped, never restored, regardless of what
 *      safeJoin/containmentSafe alone would have allowed;
 *   3. each surviving entry's backup source must resolve inside pruneDir and its bytes must hash-match
 *      the recorded oldHash — a missing/corrupt backup payload is dropped, never restored blind. */
function verifyRetiredPruneLedger(ledger, batchId, projectDir, pruneDir) {
  if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.files)) return { entries: [], dropped: [{ rel: null, reason: 'ledger has no files array' }] };
  if (ledger.batchId !== batchId) return { entries: [], dropped: [{ rel: null, reason: 'ledger batchId (' + ledger.batchId + ') does not match the batch being restored (' + batchId + ') — refusing to trust it' }] };
  if (ledger.projectPath !== path.resolve(projectDir)) return { entries: [], dropped: [{ rel: null, reason: 'ledger projectPath (' + ledger.projectPath + ') does not match this project (' + path.resolve(projectDir) + ') — refusing to trust it' }] };
  const knownRels = new Set(RETIRED_TEMPLATE_FILES.concat(RETIRED_STATE_FILES));
  const entries = [], dropped = [];
  for (const f of ledger.files) {
    if (!f || typeof f.rel !== 'string' || typeof f.oldHash !== 'string') { dropped.push({ rel: f && f.rel, reason: 'malformed ledger entry' }); continue; }
    if (!knownRels.has(f.rel)) { dropped.push({ rel: f.rel, reason: 'not a known retired-file path — ignored' }); continue; }
    const backupSrc = path.join(pruneDir, f.rel);
    if (!containmentSafe(pruneDir, backupSrc)) { dropped.push({ rel: f.rel, reason: 'backup source resolves outside the prune backup directory — refusing' }); continue; }
    if (sha256(backupSrc) !== f.oldHash) { dropped.push({ rel: f.rel, reason: 'backup payload missing or hash mismatch — refusing to restore unverified content' }); continue; }
    entries.push(f);
  }
  return { entries, dropped };
}
/** restoreRetiredPruneLedger(projectDir, batchId) -> {ok, restored[], failed[], conflicts[], skipped?, error?}.
 *  Deliberately SIMPLE compared to restoreFromManifest (no journal/resume, no central-mirror lookup) —
 *  proportionate to what it restores: inert legacy dashboard files pruneRetiredFiles() removed because
 *  they were UNMODIFIED. Absent ledger (nothing was ever pruned for this batch, or the local backup dir
 *  itself is gone) is a silent, honest no-op (`skipped`) — never an error, since most batches never touch
 *  retired files at all.
 *
 *  hardening (independent Codex adversarial review):
 *   - batchId + the resolved backup dir are validated (retiredPruneDirsFor) before any read.
 *   - the ledger itself is validated (verifyRetiredPruneLedger) before any write — a dropped entry
 *     is reported via `failed`, never silently vanished, and never restored.
 *   - a destination that was RECREATED since the prune (a fresh sync re-shipped it, or a new file
 *     landed there) is a rollback CONFLICT — kept as-is, reported in `conflicts`, never overwritten. */
function restoreRetiredPruneLedger(projectDir, batchId) {
  const dirs = retiredPruneDirsFor(projectDir, batchId); // SYNC-4
  if (!dirs.ok) return { ok: false, restored: [], failed: [], conflicts: [], error: dirs.reason };
  const { dst, bdir, pruneDir } = dirs;
  const ledgerPath = path.join(bdir, RETIRED_PRUNE_MANIFEST_NAME);
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
  catch (e) { return { ok: true, restored: [], failed: [], conflicts: [], skipped: e && e.code === 'ENOENT' ? 'no retired files were pruned for this batch' : ('ledger unreadable: ' + e.message) }; }
  if (!ledger || !Array.isArray(ledger.files) || !ledger.files.length) return { ok: true, restored: [], failed: [], conflicts: [], skipped: 'empty ledger' };
  const { entries, dropped } = verifyRetiredPruneLedger(ledger, batchId, projectDir, pruneDir); // SYNC-5
  const restored = [], failed = [], conflicts = [];
  for (const f of entries) {
    const out = safeJoin(dst, f.rel);
    const backupSrc = path.join(pruneDir, f.rel);
    try {
      if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) throw new Error('containment guard tripped');
      const rt = realTargetCheck(dst, out); if (rt.problem) throw new Error('refused by the real-path floor: ' + rt.problem); // R4 / F06
      // never overwrite a path that was recreated since the prune — report it, keep it, move on.
      // A re-run of an ALREADY-completed restore (no journal here, so a second call re-examines every
      // entry) hits this same existsSync check too; a byte-identical match is the restore's own prior
      // work, not a foreign recreation, so it is treated as done rather than a conflict — only content
      // that genuinely differs from the retired backup counts as recreated.
      if (fs.existsSync(out)) {
        if (sha256(out) === f.oldHash) { restored.push(f.rel); continue; }
        conflicts.push({ rel: f.rel, reason: 'a file already exists at this path (created/recreated after the prune) — not overwritten; move it aside yourself if you want the retired copy restored' });
        continue;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      copyNoFollow(backupSrc, out, dst, { approvedRealParent: rt.realParent, floor: true }); // R6 / F15
      const h = sha256(out);
      if (h !== f.oldHash) throw new Error('hash mismatch after restore (expected ' + f.oldHash + ', got ' + h + ')');
      restored.push(f.rel);
    } catch (e) { failed.push({ rel: f.rel, reason: e.message }); }
  }
  for (const d of dropped) failed.push({ rel: d.rel || '(ledger)', reason: d.reason }); // never silently vanish a dropped entry
  return { ok: failed.length === 0 && conflicts.length === 0, restored, failed, conflicts, partial: failed.length > 0 || conflicts.length > 0 };
}
/** rollbackProject — `node forge-sync.cjs rollback <projectDir> [--batch <batchId>]`. An interruption
 *  (thrown by restoreFromManifest) is caught and reported as ok:false, interrupted:true — the journal already
 *  on disk means a SECOND call to this function resumes and completes it.
 *
 *  safeSyncProject's no-op path can call pruneRetiredFiles() with a real batchId WITHOUT ever
 *  calling takeBackup() (there is nothing else to back up), so that batch has no main manifest.json for
 *  loadTrustedManifest to trust — yet it DID leave its own retired-prune-manifest.json ledger. Rather than
 *  inventing a fake/empty main manifest just to satisfy loadTrustedManifest's shape, this teaches rollback
 *  to validate and restore a LEDGER-ONLY batch on its own terms (restoreRetiredPruneLedger already carries
 *  its own SYNC-4/SYNC-5 trust checks) — chosen because it reuses that one already-hardened ledger path
 *  instead of growing the much bigger, more sensitive main-manifest machinery (resume/central-mirror/
 *  divergence) to cover a case that never has any of those files to begin with. */
function rollbackProject(projectDir, batchId, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, reason: 'project path missing: ' + projectDir };
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) return { ok: false, reason: 'not a project (.claude missing): ' + projectDir };
  const targetBatch = batchId || latestBatchId(projectDir);
  if (!targetBatch) return { ok: false, reason: 'no backup batch found for ' + projectDir };
  if (!isSafeBatchId(targetBatch)) return { ok: false, batchId: targetBatch, reason: 'refusing to roll back: ' + unsafeBatchIdReason(targetBatch) }; // SYNC-13
  // S3: unless the caller EXPLICITLY chose a central hub (a real --central-backup-root / --no-central-backup
  // flag, signaled by opts.centralBackupRootExplicit), prefer whatever hub THIS BATCH itself recorded in its
  // own project-local manifest.json over a freshly re-derived guess — this is what makes a `rollback` command
  // able to find a `sync-all`-written central backup even when the project isn't a direct child of root.
  let centralBackupRoot = opts.centralBackupRoot;
  if (!opts.centralBackupRootExplicit) {
    try {
      const localManifest = JSON.parse(fs.readFileSync(path.join(backupDirFor(projectDir, targetBatch), 'manifest.json'), 'utf8'));
      if (localManifest && localManifest.centralBackupRoot) centralBackupRoot = localManifest.centralBackupRoot;
    } catch { /* no project-local manifest available (or none recorded pre-S3) -> keep the caller-supplied value */ }
  }
  const trusted = loadTrustedManifest(projectDir, targetBatch, centralBackupRoot, { allowLegacyManifest: opts.allowLegacyManifest });
  if (!trusted.ok && trusted.found) {
    // a manifest EXISTS but is not trusted (legacy-unbound, bound to another project/batch, tampered, a
    // never-touch entry, behind a junction, corrupt). Restoring only the side ledgers would leave a half rollback — refuse.
    return { ok: false, batchId: targetBatch, legacyUnbound: !!trusted.legacyUnbound, reason: trusted.reason };
  }
  if (!trusted.ok) {
    // /SYNC-1 fallback: no main manifest — but maybe a real, validatable retired-prune ledger exists
    // for this exact batch. `skipped` on the result means there was genuinely nothing there (unknown or
    // empty batch); only THEN does the original no-manifest refusal below apply, unchanged.
    const ledgerOnly = restoreRetiredPruneLedger(projectDir, targetBatch);
    // a no-op sync run with --retire-orphans leaves ONLY the orphan ledger — same treatment.
    const orphanOnly = restoreRetiredOrphansLedger(projectDir, targetBatch);
    // a no-op sync that only merged settings.json leaves ONLY the settings ledger — same treatment.
    const settingsOnly = restoreSettingsLedger(projectDir, targetBatch, { forceRollbackNewer: opts.forceRollbackNewer });
    if (!ledgerOnly.skipped || !orphanOnly.skipped || !settingsOnly.skipped) {
      const ledgerOk = ledgerOnly.ok !== false && orphanOnly.ok !== false && settingsOnly.ok !== false;
      const problems = [ledgerOnly.ok === false ? describeRetiredPruneFailure(ledgerOnly) : '', orphanOnly.ok === false ? 'orphans: ' + describeRetiredPruneFailure(orphanOnly) : '',
        settingsOnly.ok === false ? 'settings.json: ' + settingsOnly.error : ''].filter(Boolean).join('; ');
      return Object.assign(
        {
          ok: ledgerOk, batchId: targetBatch, source: !ledgerOnly.skipped ? 'retired-prune-ledger-only' : (!orphanOnly.skipped ? 'retired-orphans-ledger-only' : 'settings-ledger-only'), restored: [],
          versionAction: 'not-applicable (ledger-only batch)', receiptAction: 'not-applicable (ledger-only batch)',
          retiredPruneRestore: ledgerOnly, retiredOrphansRestore: orphanOnly, settingsRestore: settingsOnly, settingsAction: settingsOnly.action || 'none',
        },
        ledgerOk ? {} : { reason: 'ledger-only rollback did not fully succeed: ' + problems },
      );
    }
    return { ok: false, reason: trusted.reason, batchId: targetBatch };
  }
  if (!opts.forceRollbackNewer) {
    const overlaps = findNewerOverlappingBatches(projectDir, targetBatch, trusted.manifest, centralBackupRoot);
    if (overlaps.length) {
      return {
        ok: false, batchId: targetBatch, source: trusted.source, newerOverlaps: overlaps,
        reason: 'refusing to roll back batch ' + targetBatch + ': a NEWER batch (' + overlaps.map((o) => o.batchId).join(', ') + ') already touched the same file(s) for this project — this would destroy the newer sync (pass --force-rollback-newer to override; prefer rolling back the newest batch first)',
      };
    }
  }
  // settings.json is checked BEFORE any file is restored. A settings conflict (an owner edit since this sync
  // merged it) used to be found only after every file was already restored — a half rollback. Now nothing is touched.
  // WP-SYNC-R12 (the aggravation): opts.settingsConflictNonBlocking — set ONLY by safeSyncProject's own in-run
  // protect-violation rollback. There the batch was just applied and stamped inside this same run, and refusing the WHOLE rollback
  // over settings.json left every file synced and the version stamped while the result said ok:false. In that mode the files,
  // receipt, version and scaffold are restored anyway; settings.json keeps its ownership rule (restored only while it holds exactly
  // what this sync merged) and a conflict there is reported separately (ok:false, reason names settings.json). The manual
  // `rollback` command never sets it, so it still refuses a half rollback there.
  const settingsPre = restoreSettingsLedger(projectDir, targetBatch, { forceRollbackNewer: opts.forceRollbackNewer, checkOnly: true });
  if (settingsPre.ok === false && !opts.settingsConflictNonBlocking) {
    return {
      ok: false, batchId: targetBatch, source: trusted.source, restored: [], settingsRestore: settingsPre, settingsAction: 'none',
      reason: 'refusing to roll back batch ' + targetBatch + ': settings.json was not restored — ' + settingsPre.error + ' — nothing was restored, so the project is not left half rolled back',
    };
  }
  try {
    const result = restoreFromManifest(projectDir, trusted.manifestDir, trusted.manifest, { __throwAfter: opts.__throwAfter, forceRollbackNewer: opts.forceRollbackNewer });
    if (result.ok === false && result.refusedManifest) return { ok: false, batchId: targetBatch, source: trusted.source, problems: result.problems, reason: result.reason };
    if (result.ok === false && result.refusedDivergence) {
      return {
        ok: false, batchId: targetBatch, source: trusted.source, diverged: result.diverged,
        reason: 'refusing to roll back: ' + result.diverged.length + ' file(s) diverged since this sync wrote them (newer content present) — pass --force-rollback-newer to override: ' + result.diverged.map((d) => d.rel).join(', '),
      };
    }
    if (result.ok === false && result.partial) {
      return {
        ok: false, partial: true, batchId: targetBatch, source: trusted.source, restored: result.restored, failed: result.failed,
        reason: 'PARTIAL — MANUAL RECOVERY REQUIRED: ' + result.failed.length + ' file(s) failed to restore/verify (backup at ' + trusted.manifestDir + '): ' + result.failed.map((f) => f.rel + ' (' + f.reason + ')').join('; '),
      };
    }
    // hardened /SYNC-5: best-effort restore of anything pruneRetiredFiles() removed
    // for this SAME batch (see that function's own doc comment). The main, heavily-guarded restore above
    // already fully succeeded on its own files; a retired legacy file failing to come back no longer stays
    // silently folded into an unconditional ok:true — it now propagates into this result's own `ok`/
    // `reason`, so a caller (and the CLI, via the existing `if (!r.ok)` branch) can see and act on
    // a partial retired-file recovery instead of it being invisible. LOCAL-backup-only (never mirrored
    // centrally) — a central-only recovery (project-local backups wiped) genuinely cannot recover these;
    // that gap is reported, not hidden.
    const retiredPruneRestore = restoreRetiredPruneLedger(projectDir, targetBatch);
    const retiredOrphansRestore = restoreRetiredOrphansLedger(projectDir, targetBatch);
    // settings.json back to its pre-merge bytes — only while it still holds what this sync wrote.
    const settingsRestore = restoreSettingsLedger(projectDir, targetBatch, { forceRollbackNewer: opts.forceRollbackNewer });
    const retiredOk = retiredPruneRestore.ok !== false && retiredOrphansRestore.ok !== false;
    const allOk = retiredOk && settingsRestore.ok !== false;
    const problems = [retiredPruneRestore.ok === false ? describeRetiredPruneFailure(retiredPruneRestore) : '', retiredOrphansRestore.ok === false ? 'orphans: ' + describeRetiredPruneFailure(retiredOrphansRestore) : ''].filter(Boolean).join('; ');
    return Object.assign(
      {
        ok: allOk, batchId: targetBatch, source: trusted.source, binding: trusted.binding, restored: result.restored,
        versionAction: result.versionAction, receiptAction: result.receiptAction, retiredPruneRestore, retiredOrphansRestore,
        settingsRestore, settingsAction: settingsRestore.action || 'none', quarantined: result.quarantined || [], notWritten: result.notWritten || [],
      },
      allOk ? {} : {
        reason: 'the main rollback succeeded, but ' + [retiredOk ? '' : 'restoring retired legacy file(s) did not: ' + problems,
          settingsRestore.ok === false ? 'settings.json was not restored: ' + settingsRestore.error : ''].filter(Boolean).join('; and '),
      },
    );
  } catch (e) {
    return { ok: false, interrupted: true, batchId: targetBatch, reason: 'rollback interrupted: ' + e.message + ' (re-run rollback to resume/complete — journal is on disk)' };
  }
}
/** rollbackBatch — `node forge-sync.cjs rollback-batch <batchId> <rootDir>`. B4: a project whose LOCAL
 *  backup dir is gone (damaged/wiped) but whose CENTRAL backup is intact must still be attempted — gating on
 *  "local dir exists" alone silently skipped exactly the scenario the central hub exists for. Only projects
 *  with NO evidence anywhere (neither local nor a valid central manifest) are skipped as "not part of this
 *  batch". */
function rollbackBatch(rootDir, batchId, opts) {
  opts = opts || {};
  if (!isSafeBatchId(batchId)) return [{ projectDir: rootDir, ok: false, reason: 'refusing to roll back: ' + (unsafeBatchIdReason(batchId) || 'no batch id given') }]; // SYNC-13
  const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
  const results = [];
  for (const p of projects) {
    const hasLocal = fs.existsSync(path.join(claudeDirOf(p), 'forge-backups', batchId));
    const trusted = loadTrustedManifest(p, batchId, opts.centralBackupRoot, { allowLegacyManifest: opts.allowLegacyManifest });
    if (!hasLocal && !trusted.ok && !trusted.found) continue; // a refused (found but untrusted) manifest is reported, not skipped
    // S6: hold this project's OWN lock while restoring it (in addition to the CLI's root lock held for the
    // whole batch), so a concurrent single-project `install`/`rollback` on the SAME project cannot race this.
    const lock = acquireLock(claudeDirOf(p), { batchId });
    if (!lock.ok) { results.push({ projectDir: p, ok: false, reason: 'S6: could not acquire project lock for ' + p + ': ' + lock.reason }); continue; }
    try { results.push(Object.assign({ projectDir: p }, rollbackProject(p, batchId, opts))); }
    finally { releaseLock(lock); }
  }
  return results;
}

// ---- a lightweight, cooperative concurrency lock (CLI-layer only — library functions stay lock-free so
// direct unit tests remain deterministic and dry-run stays a true zero-write operation). ----
function lockPathFor(dir) { return path.join(dir, '.forge-sync.lock'); }
/** LOCK_STALE_MS — the one freshness window for `.forge-sync.lock`. A younger lock means "a sync is running here":
 *  another forge-sync refuses, and the gate-hook, the tool hook and the gateway write routes go into maintenance
 *  mode (they stop writing into the project). An older lock is treated as left behind by a crashed run (fail-open). */
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
/** lockBody(opts, nonce) — what a lock file holds: who (pid), which batch, since when, and a random
 *  ownership nonce so only the run that took the lock ever removes it. No secret in it: the batch id is kept only when it
 *  has the safe batch-id shape, the nonce is random hex with no meaning outside this lock, the rest are numbers/times. */
function lockBody(opts, nonce) {
  const now = new Date().toISOString();
  const batchId = opts && isSafeBatchId(opts.batchId) ? opts.batchId : null;
  return JSON.stringify({ pid: process.pid, batch_id: batchId, started_at: now, ts: now, nonce });
}
/** acquireLock(dir, opts) -> {ok, lockPath, nonce, pid, batchId, reclaimedStale?} | {ok:false, held?, reason}. R3 / SYNC-10:
 *  a held lock is reclaimed ONLY when it is older than the 6 h window (opts.staleMs) AND its owner is provably gone: its
 *  pid is not running, or the lock names no readable owner at all (then its age comes from the file time). A lock whose pid
 *  is alive — or whose liveness cannot be told — is never reclaimed, however old. The reclaim is a RENAME of the exact stale
 *  file to a private name followed by a re-read: if someone else replaced the lock in between, it is put back untouched.
 *  opts.pidAlive and opts.now are test seams. */
/** the reclaim is TWO-PHASE and serialised on a stable primitive. A contender that judged
 *  the lock stale first creates `<lock>.reclaim-<sha256 of the stale lock's bytes>` EXCLUSIVELY — every other contender that
 *  judged the same stale lock derives the same name and fails with EEXIST (held: "another run is reclaiming it"). Holding the
 *  marker it re-reads the lock: it must still be byte-identical (same owner nonce, pid, time) and its pid still dead; only then
 *  is the stale file renamed away and the new lock created exclusively. An incumbent that changed in between is never vacated.
 *  A marker left behind by a crashed reclaimer is ignored once it is older than LOCK_RECLAIM_MARKER_STALE_MS. The lock
 *  directory itself must be a plain folder (never a junction/symlink): a redirected .claude/ would otherwise be locked — and
 *  later written — elsewhere. */
const LOCK_RECLAIM_MARKER_STALE_MS = 10 * 60 * 1000;
function acquireLock(dir, opts) {
  opts = opts || {};
  const lp = lockPathFor(dir);
  const staleMs = opts.staleMs != null ? opts.staleMs : LOCK_STALE_MS; // 6h freshness window
  const nonce = crypto.randomBytes(16).toString('hex');
  const mine = { ok: true, lockPath: lp, nonce, pid: process.pid, batchId: isSafeBatchId(opts.batchId) ? opts.batchId : null };
  const dk = lstatKind(dir);
  if (dk === 'link') return { ok: false, reason: 'the lock folder ' + dir + ' is a symlink/junction — refusing to lock (and to write) through a redirected folder' }; // R4 / F11
  if (dk === 'missing') return { ok: true, lockPath: null, skippedMissingDir: true }; // see the ENOENT note below
  if (dk !== 'dir') return { ok: false, reason: 'the lock folder ' + dir + ' is not a plain folder' };
  const create = () => { const fd = fs.openSync(lp, 'wx'); try { fs.writeSync(fd, lockBody(opts, nonce)); } finally { fs.closeSync(fd); } };
  try { create(); return mine; } catch (e) {
    // The lock target directory not existing yet (e.g. a project whose .claude/ is missing entirely) is NOT
    // a locking problem — never fs.mkdirSync it into existence as a side effect (that would silently mask the
    // "not a project" refusal safeSyncProject is about to report moments later). Just skip locking cleanly.
    if (e.code === 'ENOENT') return { ok: true, lockPath: null, skippedMissingDir: true };
    if (e.code !== 'EEXIST') return { ok: false, reason: 'could not create lock at ' + lp + ': ' + e.message };
  }
  const judge = () => {
    let raw = null, info = null, st = null;
    try { raw = fs.readFileSync(lp, 'utf8'); } catch { /* unreadable lock content */ }
    try { info = raw == null ? null : JSON.parse(raw); } catch { info = null; }
    try { st = fs.statSync(lp); } catch { /* vanished meanwhile */ }
    const nowMs = opts.now != null ? opts.now : Date.now();
    const ownerReadable = !!(info && typeof info === 'object' && Number.isInteger(info.pid) && info.pid > 0);
    const startedMs = info ? Date.parse(info.started_at || info.ts || '') : NaN;
    const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : (st ? nowMs - st.mtimeMs : null);
    const alive = ownerReadable ? (opts.pidAlive || pidAlive)(info.pid) : null;
    return { raw, info, st, ageMs, ownerReadable, alive, ownerGone: !ownerReadable || alive === false, present: st != null };
  };
  const first = judge();
  if (!first.present) { try { create(); return mine; } catch (e) { if (e.code !== 'EEXIST') return { ok: false, reason: 'could not create lock at ' + lp + ': ' + e.message }; return { ok: false, held: true, reason: 'another forge-sync run took the lock at ' + lp + ' a moment ago — refusing to run concurrently' }; } }
  const heldReason = (j, why) => ({
    ok: false, held: true, pid: j.ownerReadable ? j.info.pid : null, ageMs: j.ageMs,
    reason: 'another forge-sync run is in progress (lock held' + (j.ownerReadable ? ' by pid ' + j.info.pid : '') + (j.info && j.info.ts ? ' since ' + j.info.ts : '') + (j.ageMs != null ? ', ' + Math.round(j.ageMs / 60000) + ' min old' : '') + ') at ' + lp + ' — refusing to run concurrently' + (why ? ' (' + why + ')' : ''),
  });
  if (first.ageMs == null || first.ageMs <= staleMs) return heldReason(first, null);
  if (!first.ownerGone) return heldReason(first, 'older than ' + Math.round(staleMs / 3600000) + ' h, but its process ' + first.info.pid + (first.alive === true ? ' is still running' : ' could not be checked') + ' — a lock whose owner may be alive is never reclaimed');
  // phase 1: the reclaim marker, named after the stale lock's exact bytes — one reclaimer per stale lock
  const marker = lp + '.reclaim-' + sha256Str(first.raw == null ? 'unreadable' : first.raw).slice(0, 16);
  try {
    const mst = fs.lstatSync(marker);
    const nowMs = opts.now != null ? opts.now : Date.now();
    if (mst.isFile() && nowMs - mst.mtimeMs > LOCK_RECLAIM_MARKER_STALE_MS) { try { fs.rmSync(marker, { force: true }); } catch { /* another reclaimer removed it */ } }
  } catch { /* no marker */ }
  let mfd;
  try { mfd = fs.openSync(marker, 'wx'); }
  catch (e) {
    if (e && e.code === 'EEXIST') return { ok: false, held: true, reclaiming: true, reason: 'the stale lock at ' + lp + ' is being reclaimed by another run (' + marker + ') — refusing to run concurrently' };
    return { ok: false, reason: 'stale lock reclaim could not start (' + e.message + ')' };
  }
  try {
    try { fs.writeSync(mfd, JSON.stringify({ pid: process.pid, nonce, ts: new Date().toISOString() })); } finally { fs.closeSync(mfd); }
    if (process.env.FORGE_SYNC_TEST_HOOKS === '1' && typeof opts.__afterReclaimMarker === 'function') opts.__afterReclaimMarker(lp, marker); // test seam: a contender acts in the window
    // phase 2: re-read under the marker — still the SAME stale owner, still dead?
    const second = judge();
    if (!second.present) { try { create(); return Object.assign({}, mine, { reclaimedStale: true, reclaimedFrom: { pid: first.ownerReadable ? first.info.pid : null, ageMs: first.ageMs, ownerReadable: first.ownerReadable, vanished: true } }); } catch (e) { return { ok: false, held: true, reason: 'the stale lock vanished and another run took the name at ' + lp + ' — refusing' }; } }
    if (second.raw !== first.raw || !second.ownerGone || second.ageMs == null || second.ageMs <= staleMs) {
      return { ok: false, held: true, reason: 'the lock at ' + lp + ' changed while it was being reclaimed (another owner now holds it) — refusing, left in place' };
    }
    const gone = marker + '.gone';
    try { fs.renameSync(lp, gone); } catch (e2) { return { ok: false, held: true, reason: 'stale lock reclaim failed (' + e2.message + ') — refusing' }; }
    let movedRaw = null;
    try { movedRaw = fs.readFileSync(gone, 'utf8'); } catch { /* unreadable */ }
    if (movedRaw !== first.raw) { // not the bytes we judged: put them back (link fails if a new lock appeared — then keep both)
      try { fs.linkSync(gone, lp); fs.rmSync(gone, { force: true }); } catch { /* left beside the lock for the owner to see */ }
      return { ok: false, held: true, reason: 'the lock at ' + lp + ' changed in the last instant of the reclaim — refusing (left in place)' };
    }
    try { fs.rmSync(gone, { force: true }); create(); }
    catch (e3) { return { ok: false, reason: 'stale lock reclaim failed: ' + e3.message }; }
    return Object.assign({}, mine, { reclaimedStale: true, reclaimedFrom: { pid: first.ownerReadable ? first.info.pid : null, ageMs: first.ageMs, ownerReadable: first.ownerReadable } });
  } finally {
    try { fs.rmSync(marker, { force: true }); } catch { /* best-effort */ }
  }
}
/** releaseLock(lockResult) -> {released, reason?}. R3 / SYNC-10: removes the lock ONLY when it still carries this run's
 *  nonce and pid — a lock another run took over (or replaced) is left alone. */
function releaseLock(lockResult) {
  if (!lockResult || !lockResult.ok || !lockResult.lockPath) return { released: false, reason: 'no lock taken' };
  let info = null;
  try { info = JSON.parse(fs.readFileSync(lockResult.lockPath, 'utf8')); } catch (e) { return { released: false, reason: e && e.code === 'ENOENT' ? 'already gone' : 'unreadable — left in place' }; }
  if (!info || info.nonce !== lockResult.nonce || info.pid !== lockResult.pid) return { released: false, reason: 'the lock is no longer this run\'s (another owner) — left in place' };
  try { fs.rmSync(lockResult.lockPath, { force: true }); return { released: true }; } catch (e) { return { released: false, reason: e.message }; }
}
/** pidAlive(pid) -> true | false | null. Signal 0 only tests whether the process exists; it NEVER stops anything.
 *  EPERM means it exists but belongs to someone else (alive). null = could not tell. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM' ? true : (e && e.code === 'ESRCH' ? false : null); }
}
/** readLockStatus(claudeDir, opts?) — READ-ONLY view of `<claudeDir>/.forge-sync.lock` for `forge-sync lock-status`.
 *  -> { path, present, fresh, stale, ageMs, pid, pidAlive, batchId, startedAt, corrupt }. The age comes from the
 *  lock's own started_at/ts, falling back to the file time for an unreadable body. opts.now / opts.staleMs / opts.pidAlive
 *  are test seams. Never writes, never kills. */
/** `stale` now means "old AND its owner is provably gone" — the only lock acquireLock would reclaim. An old lock whose
 *  pid is still alive is `liveOwnerOld` (state 'live-owner-old': a sync IS still running, however long); one whose owner cannot
 *  be told is 'unknown-owner-old' (not reclaimable either). `state` is one of fresh | stale | live-owner-old | unknown-owner-old. */
function readLockStatus(claudeDir, opts) {
  opts = opts || {};
  const lp = lockPathFor(claudeDir);
  const out = { path: lp, present: false, fresh: false, stale: false, liveOwnerOld: false, state: null, ageMs: null, pid: null, pidAlive: null, batchId: null, startedAt: null, corrupt: false };
  let st;
  try { st = fs.statSync(lp); } catch { return out; }
  out.present = true;
  let info = null;
  try { info = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { info = null; }
  if (!info || typeof info !== 'object') out.corrupt = true;
  const started = info && (info.started_at || info.ts);
  const startedMs = started ? new Date(started).getTime() : NaN;
  const now = opts.now != null ? opts.now : Date.now();
  out.ageMs = Math.max(0, now - (Number.isFinite(startedMs) ? startedMs : st.mtimeMs));
  out.startedAt = Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null;
  out.pid = info && Number.isInteger(info.pid) ? info.pid : null;
  out.batchId = info && isSafeBatchId(info.batch_id) ? info.batch_id : null;
  out.fresh = out.ageMs < (opts.staleMs != null ? opts.staleMs : LOCK_STALE_MS);
  out.pidAlive = (opts.pidAlive || pidAlive)(out.pid);
  const old = !out.fresh;
  out.liveOwnerOld = old && out.pidAlive === true;
  out.stale = old && (out.pid == null || out.pidAlive === false);
  out.state = out.fresh ? 'fresh' : (out.liveOwnerOld ? 'live-owner-old' : (out.stale ? 'stale' : 'unknown-owner-old'));
  return out;
}

/**
 * safeSyncProject — the whole safe flow for ONE project. opts: { dryRun, forceOverwrite, batchId, nowIso,
 * centralBackupRoot, runId, copyFileImpl, allowDegraded, doctorTimeoutMs, resumeBatch }. NEVER calls
 * Date.now()/generates its own batchId — both must be supplied by the caller (CLI computes real ones; tests
 * inject fixed ones) so behavior stays deterministic.
 */
/** devTreeTargetCheck(projectDir, allowReason) -> {refused:false, override:null|reason} | {refused:true, reason}. WP-SYNC-R7
 *  item 6: a Forge DEVELOPMENT tree (its .claude/config/forge-dev-tree.json exists) is the SOURCE the template is published
 *  from. Syncing the template into it would overwrite newer development files with older template copies, so install,
 *  --unsafe and sync-all refuse it — unless the caller passes allowReason (CLI: --allow-dev-tree-target "<reason>", 3-500
 *  characters), which is recorded in the receipt and the change report. The marker's mere presence counts (an unreadable or
 *  malformed marker still refuses: fail closed). */
function devTreeTargetCheck(projectDir, allowReason) {
  const marker = path.join(claudeDirOf(projectDir), ...DEV_TREE_MARKER_REL.split('/'));
  let present;
  try { fs.lstatSync(marker); present = true; } catch (e) { present = !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); } // any other error: fail closed
  if (!present) return { refused: false, override: null };
  if (validAllowDirtyReason(allowReason)) return { refused: false, override: String(allowReason).trim(), marker };
  return {
    refused: true, marker,
    reason: 'refusing to sync: ' + path.resolve(projectDir) + ' is a Forge DEVELOPMENT TREE (it contains .claude/' + DEV_TREE_MARKER_REL + '). It is the source the template is published FROM, '
      + 'so syncing the template into it would overwrite newer development files with older template copies. Publish from it instead (`node .claude/forge-bin/forge-sync.cjs publish-template --plan`), '
      + 'or, only if you really mean it, pass --allow-dev-tree-target "<reason>" (recorded in the receipt and the change report). Nothing was written',
  };
}
function safeSyncProject(templateDir, projectDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, refused: true, reason: 'project path missing: ' + projectDir, projectDir };
  const dst = claudeDirOf(projectDir);
  /** De weigering hieronder is een VEILIGHEIDSFEATURE, geen bug (heroverwogen 2026-08-13 na de
   *  fresh-install audit): forge-sync werkt een BESTAAND Forge-project bij naar de nieuwste
   *  template. Zou hij .claude/ zelf aanmaken, dan zet één typefout in een pad een willekeurige map
   *  vol systeembestanden. De eerste installatie hoort via install.sh / install.ps1 te lopen, die
   *  wél vanuit niets bootstrappen (gemeten 2026-08-13: verse map -> volledige install -> doctor).
   *  Wat hier WEL fout was: de melding noemde de oplossing niet, dus een nieuwe gebruiker liep vast
   *  op "not a project" zonder te weten wat dan wel. Die melding wijst nu de weg. */
  if (!fs.existsSync(dst)) {
    return {
      ok: false, refused: true, projectDir,
      reason: 'not a project (.claude missing): ' + projectDir
        + ' — forge-sync updates an EXISTING Forge project; it deliberately never creates .claude/ itself, so a mistyped path can never fill a random folder.'
        + ' For a FIRST install run the installer instead: `bash install.sh --project "' + projectDir + '"` (or install.ps1 on Windows).',
    };
  }

  // WP-SYNC-R7 item 6: never sync the template INTO the development tree it is published from (dry-run says so too).
  const devTree = devTreeTargetCheck(projectDir, opts.allowDevTreeTarget);
  if (devTree.refused) return { ok: false, refused: true, refusedDevTree: true, projectDir, reason: devTree.reason, ...(opts.dryRun ? { dryRun: true, wouldRefuse: devTree.reason } : {}) };

  // a batch id becomes a backup folder name — validate it before anything else, on every route.
  const badBatch = unsafeBatchIdReason(opts.batchId);
  if (badBatch) return { ok: false, refused: true, projectDir, reason: 'refusing to sync: ' + badBatch };

  // a real install only writes into an idle project. The CLI runs quiesceCheck BEFORE it takes the
  // lock and passes the result in (opts.quiesce, opts.requireQuiesce); --quiesce-override "<reason>" lets a deliberate
  // exception through and is recorded in the receipt and the report. A dry-run never needs it.
  const quiesceRec = quiesceRecord(opts.quiesce, opts.quiesceOverride);
  if (!opts.dryRun && opts.requireQuiesce && !(opts.quiesce && opts.quiesce.idle) && !opts.quiesceOverride) {
    return {
      ok: false, refused: true, refusedQuiesce: true, projectDir, quiesce: opts.quiesce || null,
      reason: 'refusing to sync: the project is not proven idle — ' + (opts.quiesce ? opts.quiesce.reasons.join(' | ') : 'no quiesce check result was supplied')
        + ' — stop the sessions/agents/processes writing to it and re-run, or pass --quiesce-override "<reason>" to record a deliberate exception; nothing was written',
    };
  }
  // the inverse hash manifest of everything this sync must NOT change, taken BEFORE the first write
  // (the owner-data migrations below are writes too). Re-checked after the last write; any difference rolls back.
  let protectBefore = null;
  if (!opts.dryRun) {
    try { protectBefore = buildProtectManifest(templateDir, projectDir, { nowIso: opts.nowIso, centralBackupRoot: opts.centralBackupRoot }); }
    catch (e) { return { ok: false, refused: true, projectDir, reason: 'refusing to sync: the protection manifest could not be taken before writing (' + e.message + ') — nothing was written' }; }
  }
  const migrationSnaps = opts.dryRun ? null : snapshotMigrationTargets(projectDir);

  // 3.4 fix: move any v2.7-era owner standing rule into the project's own user file BEFORE the SYSTEM
  // FORGE_STANDING_RULES.json is ever compared/replaced below — including under --force-overwrite.
  // R6(a) fix (2026-09-26 independent review, LOW): dry-run used to skip this call entirely (a bare `[]`
  // has no `.pending`), so a dry-run preview showed FORGE_STANDING_RULES.json as replaced even when a real
  // run would skip it. migrateOwnerStandingRules() itself now stays a true zero-write operation in
  // dry-run (see its own doc comment) — calling it here unconditionally makes the preview match reality.
  const standingMigration = migrateOwnerStandingRules(projectDir, { dryRun: !!opts.dryRun });
  // the same safety net for the project's own pre-split Scout verdicts.
  const scoutMigration = migrateScoutVerdicts(templateDir, projectDir, { dryRun: !!opts.dryRun });
  const migrationWrites = migrationSnaps ? migrationWritesSince(projectDir, migrationSnaps) : []; // exact hashes, for the protect check
  const migrationsSummary = {
    standingRules: { ids: standingMigration.slice(), pending: !!standingMigration.pending },
    scoutVerdicts: { moved: scoutMigration.slice(), pending: !!scoutMigration.pending },
    writes: migrationWrites,
  };

  let templateVer, plan;
  try {
    templateVer = templateVersion(templateDir);
    // WP-SYNC-R7 item 1: template-history matching (opts.templateHistory) and the per-file --accept-template list
    plan = buildPlan(templateDir, projectDir, { forceOverwrite: !!opts.forceOverwrite, templateHistory: opts.templateHistory, acceptTemplate: opts.acceptTemplate });
  } catch (e) { // no readable shipping manifest / template -> a clean refusal, never a guessed file list
    return { ok: false, refused: true, projectDir, reason: 'refusing to sync: ' + e.message };
  }

  // F4 fix (2026-09-26 independent review, LOW): migrateOwnerStandingRules()'s return value used to be
  // ignored entirely. When it reports `.pending` (an owner rule exists in the template but this pass could
  // NOT confirm it is safely represented in FORGE_STANDING_RULES.user.json — e.g. that user file is
  // unreadable/malformed), FORGE_STANDING_RULES.json must never be replaced THIS pass, on any path —
  // whether preflight already classified it as a plain toChange, or --force-overwrite is about to force it
  // out of unknownDrift/conflicts (buildPlan() already folded both into plan.toChange above).: the
  // Scout verdict migration has the same contract; holdPendingMigrations() closes both routes for both files.
  holdPendingMigrations(plan, standingMigration, scoutMigration);

  if (plan.unreadable && plan.unreadable.length) { // B3: never silently treat an unreadable file as "new"
    return {
      ok: false, refused: true, projectDir, plan, templateVersion: templateVer, dryRun: !!opts.dryRun,
      reason: 'refusing to sync: ' + plan.unreadable.length + ' existing system file(s) could not be read (exists but unreadable — permission/lock issue, NEVER treated as "new"): '
        + plan.unreadable.map((u) => u.rel + ' (' + u.error + ')').join('; '),
    };
  }

  // a template that lacks a file its own manifest ships is incomplete — refuse before any write.
  // WP-SYNC-R7: so does an --accept-template name that cannot be accepted (a typo must never silently accept nothing).
  const missingRefusal = missingInTemplateReason(plan) || acceptTemplateRefusal(plan);
  // read-only orphan report on every route; --retire-orphans acts on it below.
  const orphans = findOrphans(projectDir, { system: listSystemFiles(templateDir), seed: plan.seedRels });
  // (fleet risk): log-event / forge-verify / forge-runcontract are only ever delivered together.
  const coupled = coupledDeliveryCheck(templateDir, projectDir, plan);
  const provenance = provenanceFor(templateDir, projectDir); // devCommitFrom/devCommitTo

  if (opts.dryRun) {
    return {
      ok: true, dryRun: true, projectDir, plan, templateVersion: templateVer, wouldRefuse: missingRefusal || coupled.reason || null, orphans,
      settingsMerge: syncProjectSettings(templateDir, projectDir, { dryRun: true }),
      retiredPrune: pruneRetiredFiles(projectDir, { dryRun: true }),
      // what the dry-run used to hide — the scaffold, the coupled verdict, provenance, migrations
      scaffoldPreview: previewProjectScaffold(templateDir, projectDir), coupledDelivery: coupled, provenance, migrations: migrationsSummary,
    };
  }
  if (missingRefusal) return { ok: false, refused: true, ...(acceptTemplateRefusal(plan) && !missingInTemplateReason(plan) ? { refusedAcceptTemplate: true } : { refusedMissingInTemplate: true }), projectDir, plan, templateVersion: templateVer, orphans, reason: missingRefusal };
  if (!coupled.ok) return { ok: false, refused: true, refusedCoupled: true, projectDir, plan, templateVersion: templateVer, orphans, coupledDelivery: coupled, reason: coupled.reason };

  /** protectVerdict(run) —: re-check the protect manifest against what this run recorded doing. A re-check that
   *  cannot run counts as a violation (fail closed). */
  const protectVerdict = (run) => {
    if (!protectBefore) return null;
    try { return verifyProtect(projectDir, protectBefore, protectExpectationsFromRun(Object.assign({ migrationWrites }, run))); }
    catch (e) { return { ok: false, error: e.message, changed: [], added: [], removed: [], allowed: [], checked: Object.keys(protectBefore.entries).length }; }
  };
  const reportBase = { runId: opts.runId || null, nowIso: opts.nowIso, templateDir: path.resolve(templateDir), provenance, quiesce: quiesceRec, coupled, devTreeOverride: devTree.override || null };

  if (plan.toChange.length === 0) { // H2: distinguish a clean no-op from a project BLOCKED by unresolved drift
    const blocked = plan.unknownDrift.length > 0 || plan.conflicts.length > 0;
    // WP22: even when the FILE plan is a no-op, settings.json may still be behind the template (a project
    // synced before wp22 shipped, or hand-edited) — the settings merge is independent of the file plan.
    // with a batch id the merge keeps its undo record in that batch (rollback restores it).
    // WP-SYNC-R12 — STATED LIMIT: this no-op path merges settings.json WITHOUT any doctor run (no file changed, so
    // there is nothing to validate), and so does --unsafe (rawInstall). WP-SYNC-R11's "the doctor judges the final state" therefore
    // holds only for a sync that changes files. A settings-only change here still has its undo record in the batch and is
    // protect-checked below, but no suite has judged the merged settings.json — the next file-changing sync's doctor is the first to.
    const settingsMergeNoop = blocked ? null : (isSafeBatchId(opts.batchId) ? mergeSettingsForBatch(templateDir, projectDir, opts.batchId, { nowIso: opts.nowIso }) : syncProjectSettings(templateDir, projectDir, {}));
    // a project can be fully up to date on every regular SYSTEM/SYSTEM_GLOB file (a real
    // toChange no-op) while STILL carrying a retired dashboard file from an older sync — that file is no
    // longer in listSystemFiles() at all, so preflight()/buildPlan() never see it. Cleaning it up must not
    // wait for some OTHER file to need a real sync first, so it runs here too, using the same real batchId
    // (creating this batch's backup dir only when there is actually something to remove).
    const retiredPrune = blocked ? { removable: [], kept: [], removed: [], failed: [], applied: false, skippedBlocked: true } : pruneRetiredFiles(projectDir, { batchId: opts.batchId });
    // --retire-orphans is opt-in and, like the prune above, only on an unblocked project.
    const retiredOrphans = (!blocked && opts.retireOrphans) ? retireOrphans(projectDir, orphans, { batchId: opts.batchId }) : null;
    // SUCCESS-WITHOUT-SETTINGS (wp-f2): a file-plan no-op must not report ok:true when the required gate
    // (settings.json merge) itself failed/was refused — the caller would otherwise see a plain success.
    const noopResult = {
      ok: !blocked && !settingsMergeFailed(settingsMergeNoop) && !(retiredPrune.failed && retiredPrune.failed.length) && !retireOrphansFailed(retiredOrphans),
      noop: !blocked, blocked, projectDir, plan, templateVersion: templateVer, settingsMerge: settingsMergeNoop, retiredPrune, orphans, retiredOrphans,
      coupledDelivery: coupled, quiesce: quiesceRec,
    };
    // even a file no-op may have written (settings.json, retired files, orphans) — and a live writer
    // may have touched protected files meanwhile. Re-check; a violation rolls back whatever this batch recorded.
    const verdict = protectVerdict({ plan, retiredPrune, retiredOrphans });
    noopResult.protect = verdict;
    const wroteSomething = !!(settingsMergeNoop && (settingsMergeNoop.status === 'merged' || settingsMergeNoop.status === 'created'))
      || !!(retiredPrune.removed && retiredPrune.removed.length) || !!(retiredOrphans && retiredOrphans.moved && retiredOrphans.moved.length);
    if (verdict && !verdict.ok) {
      const hasBatch = isSafeBatchId(opts.batchId) && fs.existsSync(backupDirFor(projectDir, opts.batchId));
      const rb = hasBatch ? rollbackProject(projectDir, opts.batchId, { centralBackupRoot: opts.centralBackupRoot, centralBackupRootExplicit: true }) : null;
      Object.assign(noopResult, {
        ok: false, noop: false, protectViolation: true, rolledBack: rb ? !!rb.ok : null, rollback: rb,
        reason: protectViolationReason(verdict) + (rb ? (rb.ok ? ' — this batch\'s own writes were rolled back' : ' — rollback did NOT complete: ' + rb.reason) : ' — this batch wrote nothing that needed rolling back'),
      });
    }
    if (isSafeBatchId(opts.batchId) && (wroteSomething || noopResult.protectViolation)) {
      noopResult.report = reportFor(projectDir, opts.batchId, Object.assign({}, reportBase, {
        outcome: noopResult.protectViolation ? 'ROLLED BACK — protected files changed' : 'no file changes (settings / clean-up only)', reason: noopResult.protectViolation ? noopResult.reason : null,
        plan, templateVersionFrom: templateVer, templateVersionTo: templateVer, settingsDelta: settingsMergeNoop ? settingsDelta(templateDir, settingsMergeNoop) : null,
        settingsLedger: settingsMergeNoop && settingsMergeNoop.ledger, orphans, retiredOrphans, protect: verdict, rollback: noopResult.rollback || null,
        backupDir: fs.existsSync(backupDirFor(projectDir, opts.batchId)) ? backupDirFor(projectDir, opts.batchId) : null,
      }));
    }
    return noopResult;
  }

  const nowIso = opts.nowIso || new Date().toISOString();
  const batchId = opts.batchId;
  if (!isSafeBatchId(batchId)) return { ok: false, refused: true, projectDir, plan, templateVersion: templateVer, reason: 'refusing to sync: a valid batch id is required before anything is written (none given)' };

  // reusing a --batch-id already backed up for THIS project would silently overwrite that manifest.
  const existingBatchManifestPath = path.join(backupDirFor(projectDir, batchId), 'manifest.json');
  if (fs.existsSync(existingBatchManifestPath) && !opts.resumeBatch) {
    return {
      ok: false, refused: true, projectDir, plan, templateVersion: templateVer,
      reason: 'batch ' + batchId + ' already has a backup manifest for this project (' + existingBatchManifestPath + ') — refusing to silently overwrite it (pass --resume-batch to intentionally reuse this batch id)',
    };
  }

  const preManifest = fullFileManifest(templateDir, projectDir);
  // H3 baseline. --reuse-pre-baseline (opt-in): reuse the previous receipt's post-sync validation instead of a
  // second doctor run, ONLY when decidePreBaseline proves it safe; otherwise the normal doctor run below.
  const fingerprintImpl = typeof opts.workspaceFingerprintImpl === 'function' ? opts.workspaceFingerprintImpl : workspaceFingerprint;
  let preValidation = null, baselineSource;
  if (opts.reusePreBaseline) {
    const nowMs = Date.parse(nowIso);
    const priorForReuse = readReceipt(projectDir); // re-hashed over the file set that receipt recorded
    const decision = decidePreBaseline(priorForReuse, preBaselineManifestHash(templateDir, projectDir, priorForReuse), fingerprintImpl(projectDir), Number.isFinite(nowMs) ? nowMs : Date.now(), settingsSnapshot(projectDir, false));
    if (decision.reuse) {
      preValidation = decision.preValidation;
      baselineSource = { mode: 'reused', batchId: decision.source.batchId, syncedAt: decision.source.syncedAt, ageMs: decision.source.ageMs, workspaceProven: decision.workspaceProven, note: decision.note };
      console.log(path.basename(projectDir) + ': pre-sync baseline REUSED from batch ' + (decision.source.batchId || '?') + ' (' + formatAgeMs(decision.source.ageMs) + ' old) — doctor run once instead of twice');
      if (decision.note) console.log('  ' + decision.note);
    } else {
      baselineSource = { mode: 'run', reuseRequested: true, fallbackReason: decision.reason };
      console.log(path.basename(projectDir) + ': pre-sync baseline RUN (reuse not possible: ' + decision.reason + ')');
    }
  } else {
    baselineSource = { mode: 'run', reuseRequested: false };
  }
  if (!preValidation) preValidation = runValidation(projectDir, { toChange: [] }, { doctorTimeoutMs: opts.doctorTimeoutMs, templateDir });
  const backup = takeBackup(projectDir, batchId, plan, templateVer, nowIso, { centralBackupRoot: opts.centralBackupRoot, runId: opts.runId, migrations: migrationWrites, allowLegacyManifest: !!opts.allowLegacyManifest });
  if (!backup.ok) { // S8: a backup I/O failure is a clean refusal, never an uncaught crash — nothing was applied yet
    return { ok: false, refused: true, projectDir, plan, templateVersion: templateVer, preManifest, backup, reason: 'refusing to sync: ' + backup.error };
  }

  const apply = applyPlanSafely(templateDir, projectDir, plan, opts.copyFileImpl, { journalDirs: [backup.backupDir, backup.centralDir], batchId, expectedHead: backup.manifest && backup.manifest.apply_journal }); // a resume's anchor
  // the journal head goes into the bound manifest BEFORE any rollback reads it. R6 / F17: when that mandatory write
  // fails the batch is NOT committed — a later rollback could not prove the journal complete — so it is rolled back like a
  // failed write (the in-memory manifest already carries the head, so this in-run rollback can still prove its creations).
  const headRec = recordApplyJournalHead(backup, apply);
  const headError = journalHeadError(apply, headRec);
  if (!apply.ok || apply.skipped.length || headError) {
    // Only the subset that was ACTUALLY written needs restoring — a file applyPlanSafely never reached
    // (e.g. the one that threw, or anything after it) was never modified from its pre-sync state.
    // AUDIT #19: on a RESUME the union-manifest (see takeBackupUnsafe) also carries the
    // PRIOR attempt's rels — files that crashed attempt already wrote and that this attempt's smaller
    // plan no longer names. They were genuinely modified, so a failed resume must restore them too;
    // "this attempt's applied list" alone would leave them on template content.
    // a file SKIPPED because it changed since the plan was never written by this batch — it is not in
    // `applied`, so the owner's newer bytes are never "restored" over; the batch is marked NEEDS REVIEW.
    const planRels = new Set(plan.toChange.map((e) => e.rel));
    const priorRels = backup.manifest.files.map((f) => f.rel).filter((rel) => !planRels.has(rel));
    const appliedManifest = subsetManifest(backup.manifest, apply.applied.concat(priorRels));
    let restored = null, rollbackError = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, appliedManifest); }
    catch (e) { rollbackError = e.message; }
    const rolledBack = !rollbackError && !!(restored && restored.ok !== false); // H1: never trust "no throw" alone
    const needsReview = apply.skipped.length > 0;
    const reviewReason = needsReview ? 'NEEDS REVIEW — ' + apply.skipped.length + ' file(s) changed since the plan was made and were NOT overwritten: '
      + apply.skipped.slice(0, 8).map((s) => s.rel + ' (' + s.reason + ')').join('; ') + ' — this batch\'s own writes were ' + (rolledBack ? 'rolled back' : 'NOT confirmed rolled back')
      + '; check those files, then re-run the sync when the project is idle' : null;
    const applyError = apply.ok ? headError : apply.error + (headError ? '; and ' + headError : '');
    const applyFail = {
      ok: false, projectDir, plan, backup, applyError, rolledBack, rollbackError, restored, preManifest,
      ...(headError ? { journalHeadFailed: true, reason: headError + ' — this batch\'s own writes were ' + (rolledBack ? 'rolled back' : 'NOT confirmed rolled back') } : {}),
      ...(needsReview ? { needsReview: true, refusedChangedSincePlan: true, skippedChangedSincePlan: apply.skipped, reason: reviewReason } : {}),
    };
    applyFail.protect = protectVerdict({ plan, applied: apply }); // reported, the rollback above already ran
    applyFail.report = reportFor(projectDir, batchId, Object.assign({}, reportBase, {
      outcome: needsReview ? 'NEEDS REVIEW — files changed since the plan (not overwritten)' : (rolledBack ? (apply.ok ? 'ROLLED BACK — the apply journal head could not be recorded' : 'ROLLED BACK — a write failed') : 'WRITE FAILED — rollback not confirmed'),
      reason: needsReview ? reviewReason : applyError, plan,
      templateVersionTo: templateVer, preValidation, baselineSource, protect: applyFail.protect, backupDir: backup.backupDir,
      rollback: { ok: rolledBack, reason: rollbackError || (restored && restored.ok === false ? 'partial restore' : null) },
    }));
    return applyFail;
  }

  // Canary-only, opt-in (see seedCanaryRun's own doc comment above for the full root-cause rationale): the
  // files just applied above may include a real forge-dashboard/log-event.cjs — use it, right before
  // validation reads it, to log ONE honest run_started event so the canary's own forge-runs/ is never
  // structurally empty going into the doctor it is about to run. Never set for a real project's own sync.
  let canarySeed = null;
  if (opts.seedRunForValidation) canarySeed = seedCanaryRun(projectDir, batchId, nowIso);

  // INSTALL-DEADLOCK FIX: seed the environment the validation below actually checks —
  // see seedProjectScaffold's own doc. Runs for every real (non-dry-run) sync; created files are
  // removed again on every rollback path below.
  const scaffold = seedProjectScaffold(templateDir, projectDir);
  // AUDIT #21: persist the scaffold's undo-information INTO the batch manifest. The in-run
  // rollback paths below hold the scaffold object in memory, but a crashed process never reaches them —
  // a LATER `forge-sync rollback` only has the manifest, which never mentioned the .gitignore append or
  // the created files, so exactly the crash case left the scaffold edits behind forever. Best-effort:
  // a manifest that cannot be rewritten leaves rollback no worse than it already was.
  if (scaffold && (scaffold.created.length || typeof scaffold.gitignorePrior === 'string')) {
    try {
      const mPath = path.join(backup.backupDir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      m.scaffold = {
        created: scaffold.created,
        ...(scaffold.createdHashes ? { createdHashes: scaffold.createdHashes } : {}),
        ...(typeof scaffold.gitignorePrior === 'string' ? { gitignorePrior: scaffold.gitignorePrior, gitignoreAppended: scaffold.gitignoreAppended } : {}),
      };
      writeBoundManifest(backup.backupDir, m); // the self-hash covers the scaffold record too
      if (backup.centralDir) { try { writeBoundManifest(backup.centralDir, m); } catch { /* mirror only */ } }
    } catch (e) {
      // CODEX ronde-3 #6: een scaffold-mutatie waarvan het undo-record NIET persistent kon
      // worden is op het crash-pad onherstelbaar. Dan liever de mutatie zelf DIRECT terugdraaien dan een
      // niet-terugdraaibare wijziging laten staan met alleen een logregel als spoor.
      const undone = undoScaffold(scaffold, projectDir);
      scaffold.errors.push('manifest-persist: ' + e.message + ' — scaffold reverted immediately (created removed: '
        + undone.removedCreated.join(',') + '; gitignore: ' + undone.gitignore + ') because a mutation without a durable undo-record must not outlive this process');
      scaffold.gitignore = 'reverted (undo-record could not be persisted)';
      scaffold.claude_md = scaffold.claude_md === 'created' ? 'reverted (undo-record could not be persisted)' : scaffold.claude_md;
      scaffold.created = [];
      delete scaffold.gitignorePrior; delete scaffold.gitignoreAppended;
    }
  }

  // WP-SYNC-R11 (the second real 26H2 install): VALIDATE THE FINAL STATE. The settings.json merge runs HERE —
  // after the files, the canary seed and the scaffold, BEFORE the post-sync doctor and the isolated re-run — so the doctor
  // judges exactly the project this sync will leave behind. It used to run after the receipt/version stamp (the WP22 order),
  // so every shipped suite that asserts the project's own settings.json (forge-stop-obligations: exactly one Stop hook running
  // forge-stop-obligations.cjs; forge-gate-secretprint: the Read(~/.claude/forge-accounts/**) deny rule) judged the OLD
  // settings and failed — deterministically, alone as well — and every real project crossing that boundary was rolled back.
  // Unchanged: the merge keeps its undo record in this batch (settings-ledger.json + settings-pre/ + the .forge-bak,
  // SYNC-06); a refused-safe merge (malformed / unexpected-shape settings.json) writes nothing, is reported, and never by
  // itself fails or rolls back the file sync (the doctor then simply judges the settings.json the project really keeps).
  // Every in-run rollback below (validation failure, unresolved drift) restores settings.json byte-for-byte from that record
  // (undoSettingsMerge), and the protect-violation rollback does so through rollbackProject, as before.
  // WP-SYNC-R12: settings.json as it is right now, read under this run's lock in a quiesced project,
  // bytes kept in memory — the pre-sync state every in-run rollback below puts back (restoreSettingsInRun, via settingsTarget).
  const settingsPreSync = settingsSnapshot(projectDir, true);
  let settingsMerge;
  try { settingsMerge = mergeSettingsForBatch(templateDir, projectDir, batchId, { nowIso, centralDir: backup.centralDir }); }
  catch (e) { // never an uncaught throw between the applied files and their rollback; whatever the ledger recorded stays the undo record
    settingsMerge = { ok: false, status: 'refused', skipped: 'merge-error', error: e.message, message: 'settings.json merge failed unexpectedly (' + e.message + ') — the doctor judges the settings.json the project has now' };
  }
  // The state an in-run rollback restores: that snapshot — or, on a --resume-batch whose earlier attempt already merged, the ledger's
  // recorded pre-sync state (settingsRollbackTarget).
  const settingsTarget = settingsRollbackTarget(projectDir, batchId, settingsPreSync);
  // WP-SYNC-R12: a merge that threw — possibly after the merge tool wrote settings.json — or whose ledger could not be
  // finalised is never left half-recorded: the pre-sync bytes go back (what was there moves into the batch backup) and the ledger is
  // marked as not applied, so neither this run's rollback nor a later `rollback` of the batch is refused over it.
  if (settingsMerge && (settingsMerge.skipped === 'merge-error' || settingsMerge.ledgerWarning)) {
    settingsMerge = settleUnconfirmedSettingsMerge(projectDir, batchId, settingsTarget, settingsMerge, backup.centralDir);
  }
  // WP-SYNC-R12: exactly the settings.json the doctor and every isolated re-run are about to judge.
  const settingsJudged = settingsSnapshot(projectDir, false);
  /** inRunRollback() — WP-SYNC-R12: THE restore path of every in-run failure after the settings merge (a failed
   *  or throwing validation, settings.json changed during validation, an unresolved-drift refusal). settings.json goes FIRST — it
   *  needs no other file, and the merged settings.json names hook files the file restore is about to remove — then the files (receipt
   *  and version included), then the scaffold. Each step is guarded, so none of them can skip the others or the report. */
  const inRunRollback = () => {
    const settingsRestore = restoreSettingsInRun(projectDir, batchId, settingsTarget);
    let restored = null, rollbackError = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, backup.manifest); }
    catch (e) { rollbackError = e.message; }
    try { undoScaffold(scaffold, projectDir); } catch (e) { if (scaffold && Array.isArray(scaffold.errors)) scaffold.errors.push('undo: ' + e.message); }
    const rolledBack = !rollbackError && !!(restored && restored.ok !== false) && settingsRestore.ok !== false;
    const problems = [filesRestoreProblem(restored, rollbackError), settingsRestoreProblem(settingsRestore)].filter(Boolean);
    return { settingsRestore, restored, rollbackError, rolledBack, reason: problems.length ? problems.join('; and ') : null };
  };

  // WP-SYNC-R12: the validation step itself can throw (the doctor runner, the syntax gate, the outcome decision). Since
  // WP-SYNC-R11 that throw would escape with the files applied AND settings.json merged and no receipt or report at all; now it is a
  // FAILED validation (never a pass) and takes the same rollback path as every other failure below.
  let validation = null, outcome;
  try {
    validation = runValidation(projectDir, plan, { doctorTimeoutMs: opts.doctorTimeoutMs, templateDir });
    outcome = decideValidationOutcome(preValidation, validation, { allowDegraded: opts.allowDegraded });
  } catch (e) {
    const why = 'the post-sync validation step threw unexpectedly (' + (e && e.message ? e.message : String(e)) + ')';
    if (!validation) validation = { tool: 'forge-sync validation step', exitCode: null, ok: false, threw: true, commands: [], reason: why };
    outcome = { ok: false, validationThrew: true, reason: why + ' — treated as a FAILED validation, never as a pass; this batch is rolled back' };
  }
  // WP-SYNC-R9: a failed outcome whose regression is made of SUITES gets each flagged suite's failing lines and — unless
  // --no-isolated-rerun, and only when nothing else regressed — one isolated re-run per flagged suite BEFORE the rollback.
  // Runs while the synced files and the scaffold are still in place (the same environment the doctor saw).
  let suiteCheck = null;
  if (!outcome.ok && !outcome.validationThrew) {
    // WP-SYNC-R10: this step sits between a FAILED validation and the rollback. ANY throw inside it keeps the
    // original failed outcome (the error is recorded) and falls through to the rollback below — it can never skip it.
    const failedOutcome = outcome;
    let sc;
    try {
      sc = confirmSuiteRegressions(projectDir, preValidation, validation, outcome, {
        noIsolatedRerun: !!opts.noIsolatedRerun, templateDir, allowDegraded: opts.allowDegraded,
        isolatedRerunBudgetMs: opts.isolatedRerunBudgetMs, // WP-SYNC-R10: --isolated-rerun-budget <ms>
        isolatedRerunTimeoutMs: opts.isolatedRerunTimeoutMs, suiteDurationsFile: opts.suiteDurationsFile, // library-only seams (tests)
        scrubberUnavailable: !!opts.scrubberUnavailable, forceDirectRerun: !!opts.forceDirectRerun,
      });
      if (!sc || !sc.outcome) throw new Error('the isolated re-run step returned no outcome');
    } catch (e) {
      sc = suiteCheckErrorRecord(e, failedOutcome, opts.scrubberUnavailable ? null : loadDoctorScrubber());
    }
    suiteCheck = sc.record;
    outcome = sc.outcome;
    try { if (suiteCheck) for (const l of suiteCheckLines(suiteCheck)) console.log(path.basename(projectDir) + ': ' + l); }
    catch (e) { console.log(path.basename(projectDir) + ': suite regression check: (its lines could not be printed)'); }
  }
  // WP-SYNC-R12: settings.json has protect allowance 'any' (the merge owns it), so nothing else would notice a doctor
  // suite or an isolated re-run rewriting it after its own assertions passed: the run would read green, be stamped SYNCED, and the
  // recorded fingerprint would bless settings that nobody judged. The commit may stamp only the settings.json the validation judged
  // (and, when the merge applied, exactly what it wrote); anything else fails like any other validation failure and is rolled back
  // (the pre-sync bytes put back, the bytes found there kept in the batch backup) — recorded on the result and in the report, and no
  // receipt is written for it. Checked on a failed outcome too, so the record is there either way.
  const settingsDrift = settingsDriftCheck(projectDir, settingsJudged, settingsMerge);
  if (settingsDrift && outcome.ok) {
    const accepted = outcome.flakyUnderLoad && outcome.flakyUnderLoad.length ? ' (the doctor verdict had been accepted: ' + outcome.flakyUnderLoad.length + ' suite(s) flaky under load)' : (outcome.alreadyRedSkipped ? ' (the doctor verdict had been accepted: pre-existing red, no new regression)' : '');
    outcome = { ok: false, settingsChanged: true, reason: settingsDrift.reason + accepted, acceptedOutcome: outcome };
  }
  if (!outcome.ok) {
    const rb = inRunRollback();
    const { settingsRestore, restored, rollbackError, rolledBack } = rb;
    const valFail = { ok: false, projectDir, plan, backup, validation, preValidation, baselineSource, outcome, suiteCheck, canarySeed, scaffold, settingsMerge, settingsRestore, settingsDrift, rolledBack, rollbackError, restored, preManifest };
    // report what the failed validation run did to protected files (e.g. a doctor suite writing into
    // forge-runs/ — SYNC-10) — the rollback above cannot undo that, so it must at least be named.
    valFail.protect = protectVerdict({ plan, scaffold, canarySeed });
    const label = outcome.validationThrew ? (rolledBack ? 'ROLLED BACK — the validation step threw' : 'VALIDATION THREW — rollback not confirmed')
      : (outcome.settingsChanged ? (rolledBack ? 'ROLLED BACK — settings.json changed during validation' : 'SETTINGS.JSON CHANGED DURING VALIDATION — rollback not confirmed')
        : (rolledBack ? 'ROLLED BACK — validation failed' : 'VALIDATION FAILED — rollback not confirmed'));
    valFail.report = reportFor(projectDir, batchId, Object.assign({}, reportBase, {
      outcome: label, reason: outcome.reason || null, plan,
      templateVersionTo: templateVer, preValidation, validation, suiteCheck, baselineSource, protect: valFail.protect, backupDir: backup.backupDir,
      settingsDelta: settingsDelta(templateDir, settingsMerge), settingsLedger: settingsMerge && settingsMerge.ledger, settingsDrift, // what the doctor judged
      rollback: { ok: rolledBack, reason: rb.reason, settingsRestore },
    }));
    return valFail;
  }

  /** B3 (Blocker 3) FIX: opts.refuseOnUnresolvedDrift (set ONLY by the single-project `install` CLI path —
   *  sync-all deliberately does NOT set it, since its staged-rollout M8 semantics already treat "this
   *  project's own partial sync succeeded, but the batch still stops" as an accepted, distinct outcome, proven
   *  by section 40b). Without this fix, a project with SOME safely-syncable files AND unresolved
   *  unknown_drift/conflict on OTHER files would fall through the `plan.toChange.length === 0` early-return
   *  above (which is the ONLY place H2's `blocked` classification is computed) and proceed to apply+validate+
   *  STAMP the template version as if the whole project were fully synced — silently hiding the drift. A
   *  direct `install` refuses that: it is all-or-nothing — either every system file resolves cleanly (or via
   *  --force-overwrite/forge-overrides.json/adopt), or NOTHING is stamped and whatever WAS just applied is
   *  rolled back, so the project never falsely claims templateVersionTo. */
  if (opts.refuseOnUnresolvedDrift && !opts.forceOverwrite && (plan.unknownDrift.length > 0 || plan.conflicts.length > 0)) {
    const rb = inRunRollback(); // WP-SYNC-R12: the same path as a failed validation — settings.json first, then files, scaffold
    const { settingsRestore, restored, rollbackError, rolledBack } = rb;
    const driftFail = {
      ok: false, refusedPartialDrift: true, projectDir, plan, backup, validation, preValidation, baselineSource, suiteCheck, scaffold, settingsMerge, settingsRestore, rolledBack, rollbackError, restored, preManifest,
      reason: 'refusing to stamp templateVersionTo: ' + plan.unknownDrift.length + ' unresolved drift + ' + plan.conflicts.length
        + ' conflict file(s) remain (use --accept-template <rel> per file, --force-overwrite for all of them, or resolve via .claude/config/forge-overrides.json/adopt) — a partially-synced project must never claim the new template version',
    };
    driftFail.protect = protectVerdict({ plan, scaffold, canarySeed });
    driftFail.report = reportFor(projectDir, batchId, Object.assign({}, reportBase, {
      outcome: 'ROLLED BACK — unresolved drift', reason: driftFail.reason, plan, templateVersionTo: templateVer, preValidation, validation, suiteCheck, baselineSource,
      settingsDelta: settingsDelta(templateDir, settingsMerge), settingsLedger: settingsMerge && settingsMerge.ledger, // WP-SYNC-R11
      protect: driftFail.protect, backupDir: backup.backupDir, rollback: { ok: rolledBack, reason: rb.reason, settingsRestore },
    }));
    return driftFail;
  }

  // the main sync is confirmed good (validation passed above, no unresolved drift blocking
  // the stamp) — clean up any retired dashboard file this project already carries from an older sync,
  // backed up into this SAME real batch's backup dir first (see pruneRetiredFiles's own doc comment). A
  // failure here is reported on the result but never rolls back the (already-validated) main sync.
  const retiredPrune = pruneRetiredFiles(projectDir, { batchId });
  // opt-in orphan retirement, on the same validated batch (moves into its backup, never deletes).
  const retiredOrphans = opts.retireOrphans ? retireOrphans(projectDir, orphans, { batchId }) : null;

  const priorReceipt = readReceipt(projectDir);
  const ver = {
    forge_version: templateVer, synced_at: nowIso, template: templateDir, system_files: listSystemFiles(templateDir).length,
    // which development commits this sync moved the project between (null = not recorded/unknown)
    devCommitFrom: provenance.devCommitFrom, devCommitTo: provenance.devCommitTo, provenanceSource: provenance.source, templateDirty: provenance.dirty,
  };

  const postManifest = fullFileManifest(templateDir, projectDir);
  const knownHashes = rebuildKnownHashes(priorReceipt, plan, postManifest);

  const receipt = {
    projectId: projectId(projectDir), projectPath: path.resolve(projectDir),
    batchId, runId: opts.runId || null,
    templateVersionFrom: priorReceipt ? (priorReceipt.templateVersionTo || priorReceipt.forge_version || null) : null,
    templateVersionTo: templateVer,
    backupRef: { project: backup.backupDir, central: backup.centralDir || null },
    preSyncManifestHash: aggregateManifestHash(preManifest),
    postSyncManifestHash: aggregateManifestHash(postManifest),
    postSyncManifestRels: Object.keys(postManifest).sort(), // the exact file set the hash above covers (preBaselineManifestHash)
    filesChanged: plan.toChange.map((e) => ({ rel: e.rel, oldHash: e.oldHash, newHash: e.newHash, overrideClass: e.overrideClass || null })),
    knownHashes,
    overridesPreserved: { expectedOverride: plan.expectedOverrides, unknownDriftSkipped: plan.unknownDrift, conflictSkipped: plan.conflicts },
    validation: {
      tool: validation.tool, exitCode: validation.exitCode, ok: validation.ok, commands: validation.commands || [],
      summary: validation.summary || null, degraded: !!validation.degraded, degradedAllowed: !!outcome.degradedAllowed,
      alreadyRedSkipped: !!outcome.alreadyRedSkipped,
      durationMs: Number.isFinite(validation.durationMs) ? validation.durationMs : null, timeoutMs: Number.isFinite(validation.timeoutMs) ? validation.timeoutMs : null, // WP-SYNC-R7
      // WP-SYNC-R9: the doctor run itself was NOT green (ok/summary above say so); these suites passed only when re-run alone.
      // A receipt like this is never a --reuse-pre-baseline (decidePreBaseline demands ok:true).
      ...(suiteCheck ? { suiteRegressionCheck: suiteCheck, flakyUnderLoad: suiteCheck.flakyUnderLoad } : {}),
    },
    preValidation: {
      ok: preValidation.ok, summary: preValidation.summary || null, degraded: !!preValidation.degraded, reused: !!preValidation.reused,
      durationMs: Number.isFinite(preValidation.durationMs) ? preValidation.durationMs : null, // WP-SYNC-R7
    },
    // WP-SYNC-R7 item 1: files synced because they matched an earlier template version, and the --accept-template record
    templateHistoryMatches: plan.toChange.filter((e) => e.overrideClass === 'template_history').map((e) => ({ rel: e.rel, by: e.historyMatch || null })),
    acceptTemplate: plan.acceptTemplate || null,
    devTreeTarget: devTree.override ? { override: devTree.override } : null, // WP-SYNC-R7 item 6
    // --reuse-pre-baseline: whether the H3 baseline above was RUN now or REUSED from an earlier receipt (and why not).
    baselineSource,
    // WP-SYNC-R12: the settings.json this receipt's doctor judged (= the one committed: settingsDriftCheck above). A later
    // --reuse-pre-baseline is refused when settings.json differs from it (decidePreBaseline), whatever changed it, tracked by git or not.
    settingsJudged: { kind: settingsJudged.kind, sha256: settingsJudged.kind === 'ok' ? settingsJudged.hash : null },
    // receipt.workspace (git HEAD + content-aware status hash, null when not a git repo) is added just below,
    // after this sync's LAST write — a later --reuse-pre-baseline compares against it.
    // S8: this field used to be a bare hardcoded 'n/a' in every path, which reads as "not tracked" rather
    // than a real status. It is honestly always this exact value AT THE MOMENT this receipt is written: a
    // receipt only ever gets written for a sync that just SUCCEEDED, so by construction nothing has been (or
    // needed to be) rolled back yet. If this sync IS rolled back later, this receipt is itself restored/
    // removed by restoreFromManifest (see its receiptAction handling) — a rolled-back sync's receipt does not
    // persist in this form to have its OWN rollbackStatus flipped. Named explicitly rather than a vague 'n/a'.
    rollbackStatus: 'not_rolled_back_as_of_this_write',
    // which shipping manifest decided the file list, and what the template lacked (advisory or not)
    shipManifest: plan.shipManifest ? plan.shipManifest.source : null,
    missingInTemplate: (plan.missingInTemplate || []).map((x) => x.rel),
    // provenance, the quiesce result + any recorded override, the coupled-delivery
    // verdict, and (added after the final re-check below) the protect verdict and the report path.
    provenance, quiesce: quiesceRec,
    coupledDelivery: coupled.groups.map((g) => ({ id: g.id, ok: g.ok, members: g.members.map((m) => ({ rel: m.rel, outcome: m.outcome })) })),
    syncedAt: nowIso,
  };
  /** COMMIT ORDER (broad Codex audit #22). The version stamp and the receipt together are this
   *  install's commit record, and they were two separate NON-ATOMIC in-place writes after validation, outside
   *  any rollback protection — with the version stamped FIRST. A crash, a full disk, or a killed process
   *  between them left the worst of the two orderings: FORGE_VERSION.json says "synced to X" (so the staleness
   *  check never re-syncs) while the receipt — which holds the knownHashes drift baseline AND the backupRef
   *  needed to roll this very sync back — is missing or torn. The project then looks current while its audit
   *  trail and its undo pointer are gone, and the next drift check sees every system file as unknown drift.
   *  Reversed: the RECEIPT is written first and the version stamp is the commit marker written LAST. Crashing
   *  in between now leaves a project whose files+receipt are correct but whose stamp still reads the OLD
   *  version — so the next `/forge` simply sees it as behind and re-syncs against an accurate baseline. That
   *  is self-healing rather than silently wrong. Both writes are atomic (temp file + rename in the same
   *  directory), so a concurrent reader always sees one whole file, never a half-written one. */
  writeReceipt(projectDir, receipt);
  writeAtomic(versionFilePath(projectDir), JSON.stringify(ver, null, 2) + '\n');
  // WP-SYNC-R11: the settings.json merge is NO LONGER here. It ran before the doctor (see "VALIDATE THE FINAL STATE" above),
  // so the receipt and version stamp above commit a project whose settings.json the doctor already judged. Kept from WP22:
  // the merge stays independent of that commit — a refused-safe merge is reported on the result (ok:false overall, below),
  // never rolls back or fails an otherwise-successful file sync; its undo record lives in this batch.
  const sDelta = settingsDelta(templateDir, settingsMerge);
  const flakyNote = outcome.flakyUnderLoad && outcome.flakyUnderLoad.length ? 'kept although the doctor run was red: ' + outcome.flakyUnderLoad.length + ' suite(s) flaky under load (' + outcome.flakyUnderLoad.join(', ') + ') — ' + FLAKY_HONESTY : null;
  const reportData = Object.assign({}, reportBase, {
    plan, templateVersionFrom: receipt.templateVersionFrom, templateVersionTo: templateVer, preValidation, validation, suiteCheck, baselineSource,
    outcomeNote: [flakyNote, outcome.alreadyRedSkipped ? ('the project was already red before this sync; no new regression' + (outcome.suitesCompared ? ' — no check and no suite went green -> red or turned up red for the first time' : ' at check level (suites were NOT compared one by one: no per-suite list on both sides)') + ' (not attributed to this sync)') : (outcome.degradedAllowed ? 'DEGRADED validator accepted via --allow-degraded' : null)].filter(Boolean).join(' · ') || null,
    settingsDelta: sDelta, settingsLedger: settingsMerge && settingsMerge.ledger, orphans, retiredOrphans, backupDir: backup.backupDir,
  });

  // the FINAL re-check, after this batch's last write. Anything protected that changed and that this
  // batch did not record doing (a doctor suite writing into forge-runs/, a live session, a bug) rolls the WHOLE batch
  // back — files, receipt, version stamp, scaffold, retired/orphan moves and settings.json — and exits non-zero naming
  // every offending path. The rollback cannot undo the protected change itself: restore that from your own backup.
  const verdict = protectVerdict({ plan, scaffold, retiredPrune, retiredOrphans, canarySeed });
  if (verdict && !verdict.ok) {
    // WP-SYNC-R12 (Codex R11-02 aggravation): a settings.json conflict no longer refuses this WHOLE rollback — the files, receipt,
    // version and scaffold come back, the settings conflict is reported separately (settingsConflictNonBlocking, see rollbackProject).
    const rb = rollbackProject(projectDir, batchId, { centralBackupRoot: opts.centralBackupRoot, centralBackupRootExplicit: true, settingsConflictNonBlocking: true });
    // once settings.json verifiably holds its pre-sync bytes again, this batch's own .forge-bak goes too
    if (rb && rb.settingsRestore && rb.settingsRestore.ok !== false && sameSettingsState(settingsSnapshot(projectDir, false), settingsTarget)) {
      const fb = removeOwnForgeBak(projectDir, batchId, settingsTarget);
      if (fb) rb.forgeBak = fb;
    }
    const reason = protectViolationReason(verdict) + (rb.ok ? ' — the whole batch was rolled back automatically (files, receipt, version, scaffold, settings.json)' : ' — automatic rollback did NOT complete: ' + rb.reason)
      + '; the rollback cannot undo the protected change itself — restore that from your own backup';
    const report = reportFor(projectDir, batchId, Object.assign({}, reportData, { outcome: 'ROLLED BACK — protected files changed', reason, protect: verdict, rollback: rb }));
    return {
      ok: false, protectViolation: true, projectDir, plan, backup, validation, preValidation, baselineSource, outcome, suiteCheck, canarySeed, scaffold, preManifest, postManifest,
      settingsMerge, retiredPrune, orphans, retiredOrphans, protect: verdict, rolledBack: !!rb.ok, rollback: rb, report, reason,
    };
  }
  const syncedLabel = outcome.flakyUnderLoad && outcome.flakyUnderLoad.length ? 'SYNCED — ' + outcome.flakyUnderLoad.length + ' suite(s) flaky under load (failed inside the doctor run, passed alone; see Doctor)' : 'SYNCED';
  const report = reportFor(projectDir, batchId, Object.assign({}, reportData, { outcome: syncedLabel, protect: verdict }));
  receipt.protect = verdict ? protectReceiptRecord(verdict) : null; // R13B: verified / NOT verified; R14: summarized, app code, complete
  receipt.report = report.path ? path.relative(claudeDirOf(projectDir), report.path).split(path.sep).join('/') : null;
  // --reuse-pre-baseline: record the workspace fingerprint AFTER this sync's last write (settings.json merge
  // included), so the next sync can prove the workspace has not changed since this receipt was written. It
  // does NOT prove the workspace equals what the doctor saw: the summary above was measured BEFORE the
  // prune / version stamp (WP-SYNC-R11: the settings merge now runs BEFORE the doctor, so that part it did see;
  // system files are covered separately by postSyncManifestHash,
  // and only a fully green receipt is ever reused — see decidePreBaseline). Best-effort: a failed
  // rewrite leaves the receipt without a fingerprint, which a later reuse treats as unproven (the doctor re-runs).
  try { receipt.workspace = fingerprintImpl(projectDir) || null; writeReceipt(projectDir, receipt); }
  catch (e) { console.error('forge-sync: WARNING — could not record the workspace fingerprint in the receipt (' + e.message + ')'); }
  // SUCCESS-WITHOUT-SETTINGS (wp-f2): the file sync itself succeeded (receipt/version already committed
  // above, deliberately independent of this step — see syncProjectSettings's own doc comment), but the
  // OVERALL result must not claim plain success when the settings.json gate failed/was refused. Same
  // discipline applied to the retired-file prune: a prune failure never rolls back the
  // already-committed main sync, but it must not be silently absorbed into a plain ok:true either.
  return {
    ok: !settingsMergeFailed(settingsMerge) && !(retiredPrune.failed && retiredPrune.failed.length) && !retireOrphansFailed(retiredOrphans),
    projectDir, plan, backup, validation, preValidation, baselineSource, outcome, suiteCheck, canarySeed, scaffold, receipt, preManifest, postManifest, settingsMerge, retiredPrune,
    orphans, retiredOrphans, protect: verdict, report, coupledDelivery: coupled, provenance,
  };
}
/** retireOrphansFailed — an opted-in --retire-orphans that could not run or failed a move must not hide inside ok:true. */
function retireOrphansFailed(ro) { return !!(ro && (ro.error || (ro.failed && ro.failed.length))); }
/** rebuildKnownHashes(priorReceipt, plan, postManifest) — B1: rebuild the CUMULATIVE baseline — carry forward every
 *  prior known hash, then overlay this sync's toChange/same rels (anything NOT excluded/skipped) with their post-sync
 *  hash. unknownDrift/conflicts left unresolved this round keep whatever baseline they already had (or none), never
 *  silently adopted.: seed-only and never-touch paths have no shipped baseline (forge-sync never overwrites
 *  them), so a stale entry for one (e.g. FORGE_OWNER_PROFILE.json from before the seed-only class) is dropped. */
function rebuildKnownHashes(priorReceipt, plan, postManifest) {
  const knownHashes = receiptLastTemplateHashMap(priorReceipt);
  const seedRels = new Set(plan.seedRels || []);
  for (const rel of Object.keys(knownHashes)) if (seedRels.has(rel) || isNeverTouch(rel)) delete knownHashes[rel];
  const excludedRels = new Set([].concat(plan.expectedOverrides, plan.unknownDrift, plan.conflicts));
  const skippedRels = new Set((plan.skipped || []).map((s) => s.rel));
  for (const rel of Object.keys(postManifest)) {
    if (excludedRels.has(rel) || skippedRels.has(rel)) continue;
    if (postManifest[rel].hash != null) knownHashes[rel] = postManifest[rel].hash;
  }
  return knownHashes;
}
/** settingsMergeFailed — true only when a settings-merge result explicitly reports ok:false (a genuine
 *  usage-error/refused/skipped-containment/skipped-tool-error) — never true for `null` (blocked before the
 *  step ran) or a `{ok:true, skipped:'no-template-settings'}` benign skip. */
function settingsMergeFailed(sm) { return !!(sm && sm.ok === false); }

/** adoptProject — NEW COMMAND: `forge-sync adopt <projectDir>`. Establishes a baseline receipt from the
 *  project's CURRENT file hashes WITHOUT writing a single template/system file, and reports which files
 *  differ from the template so a human can triage them into forge-overrides.json. Replaces a blind
 *  --force-overwrite as the safe way to onboard a project's very first sync. */
function adoptProject(templateDir, projectDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, refused: true, reason: 'project path missing: ' + projectDir };
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) return { ok: false, refused: true, reason: 'not a project (.claude missing): ' + projectDir };
  const priorReceipt = readReceipt(projectDir);
  const priorBaselineCount = priorReceipt && priorReceipt.knownHashes && typeof priorReceipt.knownHashes === 'object' ? Object.keys(priorReceipt.knownHashes).length : 0;
  /** S5 FIX: running adopt a SECOND time on an already-baselined project used to silently REPLACE the
   *  existing knownHashes baseline — every file that was previously a protected unknown_drift (because its
   *  current content differed from an earlier trusted baseline) instantly became a plain, safe-to-overwrite
   *  toChange the moment the new baseline adopted its CURRENT (possibly hand-edited) bytes, and the OLD
   *  receipt was never preserved anywhere, so the replacement could not be undone. Now: refuse unless the
   *  caller explicitly opts in via opts.force, and when forced, snapshot the pre-adopt receipt first. */
  if (priorBaselineCount > 0 && !opts.force) {
    return {
      ok: false, refused: true, existingBaseline: true, priorBaselineCount, projectDir,
      reason: 'refusing to adopt: an existing baseline of ' + priorBaselineCount + ' file(s) is already recorded in forge-sync-receipt.json — '
        + 'this replaces an existing baseline of ' + priorBaselineCount + ' file(s) — these WILL be overwritten by the next sync; '
        + 'pass --force to intentionally replace it (the current receipt is snapshotted first, so this can still be undone)',
    };
  }
  const nowIso = opts.nowIso || new Date().toISOString();
  const knownHashes = {};
  const differing = [];
  let systemFiles;
  try { systemFiles = listSystemFiles(templateDir); }
  catch (e) { return { ok: false, refused: true, reason: 'refusing to adopt: ' + e.message }; } // never a guessed list
  for (const rel of systemFiles) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) continue; // vanished since the manifest walk — nothing to baseline
    const out = safeJoin(dst, rel);
    if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) continue;
    const status = fileStatus(out);
    if (status.kind !== 'ok') continue; // missing or unreadable -> nothing to adopt for this rel
    knownHashes[rel] = status.hash; // adopt WHATEVER is currently there, verbatim, as the trusted baseline
    if (status.hash !== sha256(src)) differing.push(rel);
  }
  // S5: snapshot the OLD receipt BEFORE replacing it, whenever one existed, so a --force replace is undoable.
  let snapshotPath = null;
  if (priorReceipt && !opts.dryRun) {
    const snapDir = path.join(dst, 'forge-adopt-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    snapshotPath = path.join(snapDir, 'pre-adopt-' + nowIso.replace(/[^0-9a-zA-Z]/g, '-') + '.json');
    fs.writeFileSync(snapshotPath, JSON.stringify(priorReceipt, null, 2) + '\n', 'utf8');
  }
  const receipt = Object.assign({}, priorReceipt || {}, {
    projectId: projectId(projectDir), projectPath: path.resolve(projectDir),
    adopted: true, adoptedAt: nowIso,
    knownHashes,
    filesChanged: priorReceipt && Array.isArray(priorReceipt.filesChanged) ? priorReceipt.filesChanged : [],
    rollbackStatus: priorReceipt ? (priorReceipt.rollbackStatus || 'not_rolled_back_as_of_this_write') : 'not_rolled_back_as_of_this_write', // S8
    priorBaselineSnapshot: snapshotPath, // S5: undo pointer (null when there was no prior receipt to replace)
  });
  if (!opts.dryRun) writeReceipt(projectDir, receipt);
  return { ok: true, projectDir, differing, knownHashesCount: Object.keys(knownHashes).length, receipt, dryRun: !!opts.dryRun, priorBaselineCount, snapshotPath };
}

/** rawInstall — `--unsafe`: skips canary + validation ONLY. M7: it STILL takes a real, restorable backup first —
 *  "no undo" is never acceptable by construction. Dry-run remains a true zero-write preview.
 *  S2 FIX: --unsafe must NEVER also mean "no override allow-list, no containment/symlink guard, no undo".
 *  decision, recorded: the audit offered "refuse drift + write a receipt" or "remove --unsafe".
 *  Chosen: KEEP it, made safe, because it is the one documented escape hatch for a target whose own doctor is broken
 *  (validation impossible), and removing it would push that case onto hand-copying files. It now runs the SAME
 *  preflight/buildPlan as the safe path, so it:
 *   - REFUSES unknown drift and conflicts unless --force-overwrite is also given (was: overwrote them blindly);
 *   - never touches a seed-only file except to create it when absent (immune to --unsafe and --force-overwrite);
 *   - refuses an incomplete template (missingBlocking), an unreadable file and an unsafe batch id;
 *   - honours the pending owner-rule / Scout-verdict migrations;
 *   - writes a RECEIPT with the cumulative knownHashes (was: none, so the next safe sync saw every file it wrote as
 *     unknown drift), marked validation {tool:'none', skipped:'--unsafe'} so it is never reused as a doctor baseline.
 *  What stays "unsafe": no canary, no doctor run before or after. */
function rawInstall(templateDir, projectDir, opts) {
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) { console.error('not a project (.claude missing): ' + projectDir); return { ok: false, exitCode: 1, projectDir }; }
  const devTree = devTreeTargetCheck(projectDir, opts.allowDevTreeTarget); // WP-SYNC-R7 item 6: --unsafe too
  if (devTree.refused) { const msg = devTree.reason.replace(/^refusing to sync/, 'refusing --unsafe install'); console.error(msg); return { ok: false, exitCode: 1, refused: true, refusedDevTree: true, projectDir, reason: msg }; }
  const badBatch = unsafeBatchIdReason(opts.batchId);
  if (badBatch) { console.error('refusing --unsafe install: ' + badBatch); return { ok: false, exitCode: 1, projectDir, reason: badBatch }; }
  // --unsafe skips the canary and the doctor, NOT the live-project safety: the same quiesce gate, the same
  // protect manifest (taken before the first write, re-checked after the last) and the same coupled-delivery refusal.
  const quiesceRec = quiesceRecord(opts.quiesce, opts.quiesceOverride);
  if (!opts.dryRun && opts.requireQuiesce && !(opts.quiesce && opts.quiesce.idle) && !opts.quiesceOverride) {
    const msg = 'refusing --unsafe install: the project is not proven idle — ' + (opts.quiesce ? opts.quiesce.reasons.join(' | ') : 'no quiesce check result was supplied') + ' (or pass --quiesce-override "<reason>")';
    console.error(msg);
    return { ok: false, exitCode: 1, projectDir, refusedQuiesce: true, reason: msg };
  }
  let protectBefore = null;
  if (!opts.dryRun) {
    try { protectBefore = buildProtectManifest(templateDir, projectDir, { nowIso: opts.nowIso, centralBackupRoot: opts.centralBackupRoot }); }
    catch (e) { console.error('refusing --unsafe install: the protection manifest could not be taken (' + e.message + ')'); return { ok: false, exitCode: 1, projectDir, reason: e.message }; }
  }
  const migrationSnaps = opts.dryRun ? null : snapshotMigrationTargets(projectDir);
  // 3.4 fix +: the same preflight migrations as safeSyncProject (zero-write in dry-run).
  const standingMigration = migrateOwnerStandingRules(projectDir, { dryRun: !!opts.dryRun });
  const scoutMigration = migrateScoutVerdicts(templateDir, projectDir, { dryRun: !!opts.dryRun });
  const migrationWrites = migrationSnaps ? migrationWritesSince(projectDir, migrationSnaps) : [];
  let plan, templateVer;
  try {
    templateVer = templateVersion(templateDir);
    plan = buildPlan(templateDir, projectDir, { forceOverwrite: !!opts.forceOverwrite, templateHistory: opts.templateHistory, acceptTemplate: opts.acceptTemplate }); // WP-SYNC-R7
  } catch (e) { console.error('refusing --unsafe install: ' + e.message); return { ok: false, exitCode: 1, projectDir, reason: e.message }; }
  holdPendingMigrations(plan, standingMigration, scoutMigration);
  const refuse = (msg, extra) => { console.error(msg); return Object.assign({ ok: false, exitCode: 1, projectDir, reason: msg, plan }, extra || {}); };
  if (plan.unreadable.length) { // S2: same B3-style policy — never silently treat "unreadable" as "new"
    return refuse('refusing --unsafe install: ' + plan.unreadable.length + ' existing system file(s) could not be read (never treated as "new"): ' + plan.unreadable.map((u) => u.rel + ' (' + u.error + ')').join('; '), { unreadable: plan.unreadable });
  }
  const missingRefusal = missingInTemplateReason(plan);
  if (missingRefusal) return refuse(missingRefusal.replace(/^refusing to sync/, 'refusing --unsafe install'), { refusedMissingInTemplate: true });
  const acceptRefusal = acceptTemplateRefusal(plan); // WP-SYNC-R7
  if (acceptRefusal) return refuse(acceptRefusal.replace(/^refusing to sync/, 'refusing --unsafe install'), { refusedAcceptTemplate: true });
  if (plan.unknownDrift.length || plan.conflicts.length) { // --unsafe never overwrites drift on its own
    printPlanSummary(plan);
    return refuse('refusing --unsafe install: ' + plan.unknownDrift.length + ' drifted / ' + plan.conflicts.length + ' conflicted file(s) — the project changed them since forge-sync last wrote them. Review them, then declare them in .claude/config/forge-overrides.json, run `adopt`, or add --accept-template <rel> per file / --force-overwrite for all (backed up first) to replace them.', { refusedDrift: true });
  }
  const coupled = coupledDeliveryCheck(templateDir, projectDir, plan); // delivered together or not at all
  if (!coupled.ok) return refuse(coupled.reason.replace(/^refusing to sync/, 'refusing --unsafe install'), { refusedCoupled: true, coupledDelivery: coupled });
  const provenance = provenanceFor(templateDir, projectDir);
  const skippedOverrides = plan.expectedOverrides;
  const orphans = findOrphans(projectDir, { system: listSystemFiles(templateDir), seed: plan.seedRels });
  if (opts.dryRun) {
    plan.toChange.forEach((e) => console.log('  would ' + (e.overrideClass === 'seed' ? 'create (seed) ' : 'update ') + e.rel));
    console.log('[dry] ' + path.basename(projectDir) + ': ' + plan.toChange.length + ' would update, ' + plan.same + ' current' + (skippedOverrides.length ? (', ' + skippedOverrides.length + ' expected override(s) preserved') : ''));
    return { ok: true, exitCode: 0, projectDir, copied: plan.toChange.length, same: plan.same, skippedOverrides, plan, orphans, retiredPrune: pruneRetiredFiles(projectDir, { dryRun: true }) };
  }
  const batchId = opts.batchId || ('unsafe-' + Date.now());
  const nowIso = opts.nowIso || new Date().toISOString();
  const preManifest = fullFileManifest(templateDir, projectDir);
  const backup = takeBackup(projectDir, batchId, plan, templateVer, nowIso, { centralBackupRoot: opts.centralBackupRoot, runId: opts.runId, migrations: migrationWrites, allowLegacyManifest: !!opts.allowLegacyManifest });
  if (!backup.ok) { // S8: clean refusal instead of an uncaught crash
    console.error(path.basename(projectDir) + ': --unsafe refused: backup could not be taken — ' + backup.error);
    return { ok: false, exitCode: 1, projectDir, reason: backup.error, backup };
  }
  const apply = applyPlanSafely(templateDir, projectDir, plan, null, { journalDirs: [backup.backupDir, backup.centralDir], batchId, expectedHead: backup.manifest && backup.manifest.apply_journal }); // R6 / F16
  const headError = journalHeadError(apply, recordApplyJournalHead(backup, apply)); // a failed head write fails the batch
  if (!apply.ok || apply.skipped.length || headError) {
    const appliedManifest = subsetManifest(backup.manifest, apply.applied);
    let restored = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, appliedManifest); } catch (e) { restored = { ok: false, error: e.message }; }
    const rolledBack = !!(restored && restored.ok !== false);
    if (headError && apply.ok && !apply.skipped.length) { // R6 / F17
      const reason = headError + ' — this batch\'s own writes were ' + (rolledBack ? 'rolled back' : 'NOT confirmed rolled back (backup at ' + backup.backupDir + ')');
      console.error(path.basename(projectDir) + ': --unsafe install FAILED — ' + reason);
      return { ok: false, exitCode: 1, projectDir, applyError: headError, journalHeadFailed: true, rolledBack, reason, backup };
    }
    if (apply.skipped.length) { // changed since the plan -> never overwritten, the batch needs review
      const reason = 'NEEDS REVIEW — ' + apply.skipped.length + ' file(s) changed since the plan was made and were NOT overwritten: ' + apply.skipped.map((s) => s.rel + ' (' + s.reason + ')').join('; ')
        + ' — this batch\'s own writes were ' + (rolledBack ? 'rolled back' : 'NOT confirmed rolled back');
      console.error(path.basename(projectDir) + ': --unsafe ' + reason);
      return { ok: false, exitCode: 1, projectDir, needsReview: true, refusedChangedSincePlan: true, skippedChangedSincePlan: apply.skipped, rolledBack, reason, backup };
    }
    console.error(path.basename(projectDir) + ': --unsafe write FAILED (' + apply.error + ') -> ' + (rolledBack ? 'rolled back applied subset' : 'rollback NOT confirmed') + ' (backup at ' + backup.backupDir + ')');
    return { ok: false, exitCode: 1, projectDir, applyError: apply.error, rolledBack, backup };
  }
  // --unsafe "STILL takes a real backup" (see the header doc's point 8) — the retired-file
  // prune reuses that exact same guarantee (backupDirFor/containment guards), just like the safe path.
  const retiredPrune = pruneRetiredFiles(projectDir, { batchId });
  const priorReceipt = readReceipt(projectDir);
  const postManifest = fullFileManifest(templateDir, projectDir);
  const receipt = { // the --unsafe path writes a real receipt too (commit order: receipt, then version stamp)
    projectId: projectId(projectDir), projectPath: path.resolve(projectDir), batchId, runId: opts.runId || null,
    templateVersionFrom: priorReceipt ? (priorReceipt.templateVersionTo || priorReceipt.forge_version || null) : null,
    templateVersionTo: templateVer,
    backupRef: { project: backup.backupDir, central: backup.centralDir || null },
    preSyncManifestHash: aggregateManifestHash(preManifest), postSyncManifestHash: aggregateManifestHash(postManifest), postSyncManifestRels: Object.keys(postManifest).sort(),
    filesChanged: plan.toChange.map((e) => ({ rel: e.rel, oldHash: e.oldHash, newHash: e.newHash, overrideClass: e.overrideClass || null })),
    knownHashes: rebuildKnownHashes(priorReceipt, plan, postManifest),
    overridesPreserved: { expectedOverride: plan.expectedOverrides, unknownDriftSkipped: [], conflictSkipped: [] },
    validation: { tool: 'none', skipped: '--unsafe (no canary, no doctor run)', ok: null, summary: null, degraded: false },
    preValidation: { ok: null, summary: null, skipped: '--unsafe' },
    baselineSource: { mode: 'none', reason: '--unsafe' },
    unsafe: true,
    templateHistoryMatches: plan.toChange.filter((e) => e.overrideClass === 'template_history').map((e) => ({ rel: e.rel, by: e.historyMatch || null })), // WP-SYNC-R7
    acceptTemplate: plan.acceptTemplate || null,
    devTreeTarget: devTree.override ? { override: devTree.override } : null,
    rollbackStatus: 'not_rolled_back_as_of_this_write',
    shipManifest: plan.shipManifest ? plan.shipManifest.source : null,
    missingInTemplate: (plan.missingInTemplate || []).map((x) => x.rel),
    provenance, quiesce: quiesceRec,
    coupledDelivery: coupled.groups.map((g) => ({ id: g.id, ok: g.ok, members: g.members.map((m) => ({ rel: m.rel, outcome: m.outcome })) })),
    syncedAt: nowIso,
  };
  writeReceipt(projectDir, receipt);
  const ver = {
    forge_version: templateVer, synced_at: nowIso, template: templateDir, system_files: listSystemFiles(templateDir).length,
    devCommitFrom: provenance.devCommitFrom, devCommitTo: provenance.devCommitTo, provenanceSource: provenance.source, templateDirty: provenance.dirty,
  };
  writeAtomic(path.join(dst, 'FORGE_VERSION.json'), JSON.stringify(ver, null, 2) + '\n'); // atomic here too (audit #22)
  // opts.mergeSettings lets the CLI/sync-all merge settings.json HERE, with its undo record in this
  // batch and before the protect re-check, instead of after rawInstall returns.
  const settingsMerge = opts.mergeSettings ? mergeSettingsForBatch(templateDir, projectDir, batchId, { nowIso, centralDir: backup.centralDir }) : undefined;
  const reportData = {
    runId: opts.runId || null, nowIso, templateDir: path.resolve(templateDir), provenance, quiesce: quiesceRec, coupled, plan, devTreeOverride: devTree.override || null,
    templateVersionFrom: receipt.templateVersionFrom, templateVersionTo: templateVer,
    preValidation: { skipped: '--unsafe (no doctor run)' }, validation: { skipped: '--unsafe (no doctor run)' },
    settingsDelta: settingsMerge ? settingsDelta(templateDir, settingsMerge) : null, settingsLedger: settingsMerge && settingsMerge.ledger,
    orphans, backupDir: backup.backupDir,
  };
  const verdict = protectBefore ? (() => {
    try { return verifyProtect(projectDir, protectBefore, protectExpectationsFromRun({ plan, retiredPrune, migrationWrites })); }
    catch (e) { return { ok: false, error: e.message, changed: [], added: [], removed: [], allowed: [], checked: Object.keys(protectBefore.entries).length }; }
  })() : null;
  if (verdict && !verdict.ok) {
    const rb = rollbackProject(projectDir, batchId, { centralBackupRoot: opts.centralBackupRoot, centralBackupRootExplicit: true });
    const reason = protectViolationReason(verdict) + (rb.ok ? ' — the whole batch was rolled back automatically' : ' — automatic rollback did NOT complete: ' + rb.reason)
      + '; the rollback cannot undo the protected change itself — restore that from your own backup';
    console.error(path.basename(projectDir) + ': --unsafe install ROLLED BACK — ' + reason);
    const report = reportFor(projectDir, batchId, Object.assign({}, reportData, { outcome: 'ROLLED BACK — protected files changed', reason, protect: verdict, rollback: rb }));
    return { ok: false, exitCode: 1, protectViolation: true, projectDir, backup, plan, orphans, retiredPrune, settingsMerge, protect: verdict, rolledBack: !!rb.ok, rollback: rb, report, reason };
  }
  const report = reportFor(projectDir, batchId, Object.assign({}, reportData, { outcome: 'SYNCED (UNSAFE: no canary, no doctor)', protect: verdict }));
  receipt.protect = verdict ? protectReceiptRecord(verdict) : null; // R13B: verified / NOT verified; R14: summarized, app code, complete
  receipt.report = report.path ? path.relative(dst, report.path).split(path.sep).join('/') : null;
  writeReceipt(projectDir, receipt);
  console.log(path.basename(projectDir) + ': ' + plan.toChange.length + ' updated (UNSAFE — no canary/no validation), ' + plan.same + ' current' + (skippedOverrides.length ? (', ' + skippedOverrides.length + ' expected override(s) preserved') : '') + ' -> version ' + ver.forge_version + ' · backup at ' + backup.backupDir + ' · receipt written');
  printOrphanReport(projectDir, orphans, null);
  return {
    ok: !(retiredPrune.failed && retiredPrune.failed.length), exitCode: 0, projectDir, copied: plan.toChange.length, same: plan.same, backup, skippedOverrides, retiredPrune, receipt, plan, orphans,
    protect: verdict, report, coupledDelivery: coupled, provenance, ...(settingsMerge !== undefined ? { settingsMerge } : {}),
  };
}

/** gitBlobIds(buf, idLen) -> Set of git blob ids for the bytes as-is and with CRLF folded to LF (what a checkout with
 *  core.autocrlf would have committed), in the repository's object format (40 hex = sha1, 64 hex = sha256). */
function gitBlobIds(buf, idLen) {
  const algo = idLen === 64 ? 'sha256' : 'sha1';
  const id = (b) => crypto.createHash(algo).update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex');
  const out = new Set([id(buf)]);
  if (buf.includes(13)) out.add(id(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')));
  return out;
}
/** devHistoryBlobIndex(devClaudeDir) -> {available:true, top, byPath:Map<repoRel, Set<blobId>>, idLen} | {available:false, reason}.
 *  ONE `git log --all --raw` over the tree's .claude folder: every blob each path has ever had. */
function devHistoryBlobIndex(devClaudeDir) {
  const ctx = devTreeGitContext(devClaudeDir);
  if (!ctx) return { available: false, reason: 'not a git work tree with a development-tree marker' };
  const prefix = path.relative(ctx.top, ctx.devDir).split(path.sep).join('/');
  const log = gitIn(ctx.top, ['-c', 'core.quotePath=false', 'log', '--all', '--format=', '--raw', '--no-abbrev', '--no-renames', '--', prefix || '.']);
  if (!log.ok) return { available: false, reason: 'git log failed: ' + log.err };
  const byPath = new Map();
  let idLen = 40;
  for (const line of log.out.split('\n')) {
    const m = /^:\d+ \d+ ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) \S+\t(.+)$/.exec(line);
    if (!m) continue;
    idLen = m[2].length;
    if (!byPath.has(m[3])) byPath.set(m[3], new Set());
    byPath.get(m[3]).add(m[1]).add(m[2]);
  }
  return { available: true, prefix, byPath, idLen };
}
/** devTreeStatus — WP A0: status on a Forge DEVELOPMENT TREE. The tree is the SOURCE the template is published
 *  from, and install refuses it, so "N files behind — run: forge-sync install" was the wrong direction. Every differing file
 *  is classified by the tree's git history: template bytes that are an earlier version of the same path = the template lags
 *  (publish fixes it); template bytes that never existed in the tree = TEMPLATE AHEAD (edited in the template itself; a
 *  publish would overwrite them). Returns 1 when the template is ahead or the direction cannot be proven, else 0. */
function devTreeStatus(templateDir, projectDir, s) {
  const dst = claudeDirOf(projectDir), name = path.basename(projectDir);
  const idx = devHistoryBlobIndex(dst);
  const lagging = [], ahead = [];
  for (const rel of s.drift.concat(s.seedsAbsent)) {
    let buf; try { buf = fs.readFileSync(path.join(templateDir, rel)); } catch { continue; }
    const known = idx.available && idx.byPath.get(idx.prefix ? idx.prefix + '/' + rel : rel);
    const fromTree = !!known && [...gitBlobIds(buf, idx.idLen)].some((id) => known.has(id));
    (fromTree ? lagging : ahead).push(rel);
  }
  let unpublished = [];
  try { const dp = shipPlan(dst); unpublished = dp.system.concat(dp.seed).filter((rel) => !fs.existsSync(path.join(templateDir, rel))); }
  catch (e) { console.error('  ' + name + ': could not read this tree\'s own shipping manifest — ' + e.message); }
  const behind = lagging.length + unpublished.length;
  console.log(name + ': DEVELOPMENT TREE (the source the template is published from) · tree=' + (s.vf.forge_version || 'none') + ' · template=' + s.tv + ' · '
    + (behind ? 'the template is ' + behind + ' file(s) behind this tree (' + lagging.length + ' changed, ' + unpublished.length + ' not published yet) — publish: forge-sync publish-template --plan' : 'the template matches this tree ✓'));
  if (s.verbose) lagging.forEach((f) => console.log('    template lags: ' + f));
  if (s.verbose) unpublished.forEach((f) => console.log('    not published yet: ' + f));
  if (!idx.available) {
    console.error('  ' + name + ': direction NOT proven for ' + ahead.length + ' differing file(s) — ' + idx.reason);
    return 1;
  }
  if (ahead.length) console.error('  ' + name + ': TEMPLATE AHEAD: ' + ahead.length + ' file(s) whose template bytes are no version in this tree\'s git history (edited in the template itself) — a publish would overwrite them; port them into this tree or get the owner\'s ok first: ' + ahead.join(', '));
  return ahead.length ? 1 : 0;
}

/** status — read-only.: it no longer filters template-missing files away silently: every ship-sync /
 *  seed-only entry the template lacks is listed, an incomplete template (missingBlocking) is never "up to date",
 *  seed files the project still lacks count as behind, and the orphan report says which files the template no
 *  longer ships. Returns 1 when the project is behind OR the template is incomplete, else 0. */
function status(templateDir, projectDir, verbose) {
  const dst = claudeDirOf(projectDir);
  let sp, tv;
  try { sp = shipPlan(templateDir); tv = templateVersion(templateDir); }
  catch (e) { console.error(path.basename(projectDir) + ': status could not be determined — ' + e.message); return 1; }
  let vf = {}; try { vf = JSON.parse(fs.readFileSync(path.join(dst, 'FORGE_VERSION.json'), 'utf8')); } catch { /* none */ }
  const drift = sp.system.filter((rel) => sha256(path.join(templateDir, rel)) !== sha256(path.join(dst, rel)));
  const seedsAbsent = sp.seed.filter((rel) => !fs.existsSync(path.join(dst, rel)));
  const behind = drift.length + seedsAbsent.length;
  if (readDevTreeMarker(dst)) return devTreeStatus(templateDir, projectDir, { tv, vf, drift, seedsAbsent, verbose });
  const head = sp.missingBlocking.length ? 'TEMPLATE INCOMPLETE (' + sp.missingBlocking.length + ' shipped file(s) missing from it) — install would refuse; fix: forge-sync publish-template --plan (from the development tree)'
    : (behind ? ('DRIFT (' + behind + ' files behind) — run: forge-sync install') : 'up to date ✓');
  console.log(path.basename(projectDir) + ': installed=' + (vf.forge_version || 'none') + ' · template=' + tv + ' · ' + head);
  if (drift.length && verbose) drift.forEach((f) => console.log('    behind: ' + f));
  if (seedsAbsent.length) console.log('  ' + seedsAbsent.length + ' seed file(s) this project does not have yet — install creates them (never overwrites an existing one): ' + (verbose ? seedsAbsent.join(', ') : seedsAbsent.slice(0, 6).join(', ') + (seedsAbsent.length > 6 ? ', …' : '')));
  printMissingInTemplate(projectDir, sp.missing, sp.missingBlocking, sp.manifest, verbose);
  // read-only preview of the retired Control Center cleanup — `status` never writes, so
  // this is always a dry-run classification; `install`/`sync-all` are what actually remove anything.
  const rp = pruneRetiredFiles(projectDir, { dryRun: true });
  if (rp.removable.length) console.log('  ' + rp.removable.length + ' retired dashboard file(s) present and unmodified — `forge-sync install` will remove them: ' + rp.removable.map((e) => e.rel).join(', '));
  if (rp.kept.length) console.log('  ' + rp.kept.length + ' retired dashboard file(s) present but kept (see reasons): ' + rp.kept.map((k) => k.rel + ' (' + k.reason + ')').join('; '));
  printOrphanReport(projectDir, findOrphans(projectDir, sp), null);
  const sr = stateRootOf(projectDir); // WP 2.1
  if (sr.present) console.log('  ' + sr.rel + '/ (per-project state root: runs, memory, scribe store, ...) — protected: forge-sync never ships, writes, seeds or retires anything in it');
  return (behind || sp.missingBlocking.length) ? 1 : 0;
}
/** printMissingInTemplate — F3: say which shipped entries the template lacks, never a silent skip. Blocking ones are
 *  always named; advisory ones (release_excluded, or a template without its own manifest) are counted, and named
 *  with --verbose. */
function printMissingInTemplate(projectDir, missing, blocking, manifest, verbose) {
  const name = path.basename(projectDir);
  const all = missing || [];
  const block = blocking || [];
  if (!all.length) return;
  const blockSet = new Set(block.map((x) => x.rel));
  const advisory = all.filter((x) => !blockSet.has(x.rel));
  if (block.length) {
    console.error('  ' + name + ': MISSING IN TEMPLATE (blocking — the template\'s own manifest ships these): ' + block.map((x) => x.rel).join(', '));
    console.error('  ' + name + ': ' + PUBLISH_TEMPLATE_HINT); // the one fix, never "refresh it somehow"
  }
  if (advisory.length) {
    const legacy = !!(manifest && manifest.source !== 'template');
    const why = legacy
      ? 'the template carries no shipping manifest of its own (an older template) — checked against this forge-sync\'s manifest, advisory'
      : 'release-excluded or seed-only — allowed to be absent';
    console.log('  ' + name + ': ' + advisory.length + ' manifest entr' + (advisory.length === 1 ? 'y' : 'ies') + ' missing in template (' + why + ')' + (verbose ? ': ' + advisory.map((x) => x.rel).join(', ') : ' — --verbose lists them'));
    if (legacy) console.log('  ' + name + ': ' + PUBLISH_TEMPLATE_HINT + ' (publishing also gives the template its own manifest)');
  }
}
/** printOrphanReport — SYNC-09: files forge-sync shipped before that the template no longer ships. */
function printOrphanReport(projectDir, orphans, retired) {
  if (!orphans) return;
  const name = path.basename(projectDir);
  const un = orphans.unmodified || [], mod = orphans.modified || [];
  if (retired && retired.moved && retired.moved.length) console.log('  ' + name + ': retired ' + retired.moved.length + ' orphan(s) into ' + retired.backupDir + ' (moved, not deleted — `forge-sync rollback` puts them back): ' + retired.moved.join(', '));
  if (retired && (retired.error || (retired.failed && retired.failed.length))) console.error('  ' + name + ': --retire-orphans problem: ' + (retired.error || retired.failed.map((f) => f.rel + ' (' + f.reason + ')').join('; ')));
  const stillThere = un.filter((u) => !(retired && retired.moved && retired.moved.includes(u.rel)));
  if (stillThere.length) console.log('  ' + name + ': ' + stillThere.length + ' file(s) the template no longer ships, unmodified since forge-sync wrote them — `install --retire-orphans` moves them into the batch backup: ' + stillThere.map((u) => u.rel).join(', '));
  if (mod.length) console.log('  ' + name + ': ' + mod.length + ' file(s) the template no longer ships but that were changed here — kept, never retired: ' + mod.map((m) => m.rel).join(', '));
}

// Bounded-depth recursive project scan. Skips heavy/irrelevant dirs AND any dot-prefixed directory (which is
// how the dedicated canary at .forge-canary/ stays structurally excluded from real-project discovery).
function findForgeProjects(root, maxDepth) {
  maxDepth = maxDepth == null ? 3 : maxDepth;
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (fs.existsSync(path.join(dir, '.claude', 'forge-dashboard'))) { out.push(dir); return; }
    if (depth === maxDepth) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  let top = []; try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of top) { if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(root, e.name), 1); }
  return out;
}

// ---- dedicated, disposable sync canary (never one of the real 12 projects) ----
function dedicatedCanaryDir(rootDir) { return path.join(rootDir, CANARY_DIR_NAME); }
/** canary-init — create/refresh the dedicated canary project scaffold. M5: WIPES any prior canary state
 *  first (a canary that accumulates its own receipt/FORGE_VERSION/forge-runs across calls is not a canary —
 *  it would eventually accumulate a false-drift baseline of its own and abort every batch at stage 0).
 *  opts.doctorSource lets a test/CLI point it at a specific forge-doctor.cjs (real or stub); without one, the
 *  canary has no doctor and validation falls back to node --check on synced .cjs files. */
function canaryInit(templateDir, rootDir, opts) {
  opts = opts || {};
  const dir = dedicatedCanaryDir(rootDir);
  if (path.basename(dir) === CANARY_DIR_NAME) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort wipe */ } }
  fs.mkdirSync(path.join(dir, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'FORGE_CANARY_MARKER.json'), JSON.stringify({
    canary: true, createdAt: opts.nowIso || new Date().toISOString(),
    purpose: 'disposable dedicated sync canary — never a real project, never counted by findForgeProjects, wiped fresh on every canary-init',
  }, null, 2) + '\n', 'utf8');
  if (opts.doctorSource && fs.existsSync(opts.doctorSource)) {
    fs.copyFileSync(opts.doctorSource, path.join(dir, '.claude', 'forge-bin', 'forge-doctor.cjs'));
    // WP A11-2: a real doctor needs its check modules next to it (a single-file stub doctor has none)
    const modules = path.join(path.dirname(opts.doctorSource), 'doctor');
    if (fs.existsSync(modules)) fs.cpSync(modules, path.join(dir, '.claude', 'forge-bin', 'doctor'), { recursive: true });
  }
  return { dir, refreshed: true };
}

function abortNote(result) { // never say "(if applicable)" — say plainly whether anything was rolled back.
  // Three distinct shapes since H2: (1) blocked/refused before any write -> nothing to roll back; (2) ok:true
  // but STILL has unresolved drift on THIS project (some files synced fine, others left drifted) -> the
  // project's OWN sync succeeded and is stamped, nothing needs rolling back, but the batch still can't proceed
  // past it; (3) a genuine post-write failure -> rolled back (or not confirmed).
  if (result.blocked || result.refused) return 'nothing was written (blocked/refused before any write — never applied, so there was nothing to roll back)';
  if (result.ok) return 'this project\'s own sync succeeded (and is stamped) — but it still has unresolved drift/conflict blocking the batch from proceeding; nothing to roll back here';
  if (result.rolledBack) return 'rolled back';
  // WP-SYNC-R11: the files came back but settings.json (merged before the doctor) was kept — say exactly that.
  // WP-SYNC-R12: "files rolled back" ONLY when the file restore itself confirmed it (no throw AND restored.ok !== false);
  // restoreFromManifest can refuse (diverged files) or stop part-way without throwing — then both failures are named.
  const settingsProblem = settingsRestoreProblem(result.settingsRestore);
  const filesBack = !result.rollbackError && !!result.restored && result.restored.ok !== false;
  const filesProblem = filesBack ? null : (Object.prototype.hasOwnProperty.call(result, 'restored') || result.rollbackError ? filesRestoreProblem(result.restored, result.rollbackError) : null);
  if (settingsProblem && filesBack) return 'files rolled back, but ' + settingsProblem;
  if (settingsProblem) return 'ROLLBACK NOT CONFIRMED — the files: ' + (filesProblem || 'not confirmed') + '; and ' + settingsProblem;
  if (result.rollbackError) return 'ROLLBACK NOT CONFIRMED (' + result.rollbackError + ')';
  if (filesProblem) return 'ROLLBACK NOT CONFIRMED (' + filesProblem + ')';
  if (result.rollback && result.rollback.reason) return 'ROLLBACK NOT CONFIRMED (' + result.rollback.reason + ')';
  return 'rollback status unknown — see diagnostics';
}
function printRemediation(rootDir, batchId, centralBackupRoot, processedSoFar) {
  const alreadySynced = (processedSoFar || []).filter((pr) => pr.ok).map((pr) => path.basename(pr.projectDir));
  console.error('Already synced to the new version before this abort: ' + (alreadySynced.length ? alreadySynced.join(', ') : '(none)'));
  console.error('Remediation: node ' + quoteArg(__filename) + ' rollback-batch ' + batchId + ' ' + quoteArg(rootDir) + (centralBackupRoot ? (' --central-backup-root ' + quoteArg(centralBackupRoot)) : ''));
}

/**
 * runSyncAll — the safe multi-project orchestrator. opts: { projects (explicit override array, else
 * discovered from rootDir), canaryName (representative real project), stageSize, dryRun, forceOverwrite,
 * unsafe, batchId, nowIso, centralBackupRoot, runId, canaryDoctorSource, allowDegraded, doctorTimeoutMs }.
 * Flow: dedicated canary (ALWAYS first, never a real project) -> ONE representative real project ->
 * staged ladder (2 -> 3 -> stageSize thereafter). ANY validation failure OR unresolved unknown_drift/conflict
 * (without --force-overwrite) rolls back that project and STOPS the whole batch. H3c: prints a per-project
 * summary as each project is processed, and on any abort prints which projects are already on the new
 * version plus the literal rollback-batch remediation command.
 */
function runSyncAll(templateDir, rootDir, opts) {
  opts = opts || {};
  const nowIso = opts.nowIso || new Date().toISOString();
  const batchId = opts.batchId;
  const runId = opts.runId || null;
  const centralBackupRoot = opts.centralBackupRoot;
  const badBatch = unsafeBatchIdReason(batchId); // refuse before the canary or any project is touched
  if (badBatch) { console.error('forge-sync: refusing sync-all: ' + badBatch); return { ok: false, refused: true, reason: badBatch, batchId, projects: [] }; }
  const hasUnresolvedDrift = (r) => !opts.forceOverwrite && r && r.plan && (r.plan.unknownDrift.length > 0 || r.plan.conflicts.length > 0);
  const syncOpts = { forceOverwrite: opts.forceOverwrite, batchId, nowIso, centralBackupRoot, runId, allowDegraded: opts.allowDegraded, doctorTimeoutMs: opts.doctorTimeoutMs, reusePreBaseline: !!opts.reusePreBaseline, retireOrphans: !!opts.retireOrphans, templateHistory: opts.templateHistory, noIsolatedRerun: !!opts.noIsolatedRerun, isolatedRerunBudgetMs: opts.isolatedRerunBudgetMs };
  /** WP-SYNC-R7 item 6: a Forge development tree DISCOVERED under the root is skipped — named on the console and in the result
   *  (skippedDevTrees), never synced and never the reason the batch stops. An explicit opts.projects list is not filtered:
   *  safeSyncProject itself refuses a development tree named on purpose. */
  const skippedDevTrees = [];
  const discoverProjects = () => {
    if (Array.isArray(opts.projects)) return opts.projects;
    const all = findForgeProjects(rootDir);
    const dev = all.filter((p) => devTreeTargetCheck(p, null).refused);
    for (const p of dev) { skippedDevTrees.push(p); console.error('skipping ' + p + ' — a Forge development tree (the template is published FROM it; it is never a sync target)'); } // stderr: a --json dry-run keeps stdout pure JSON
    return all.filter((p) => !dev.includes(p));
  };
  // The dedicated canary is Forge's own disposable, synthetic smoke-test scaffold — in REAL production use it
  // always inherits the template's real forge-doctor.cjs (a SYSTEM file) on its very first sync, so the
  // degraded fallback essentially never triggers for it there. Only a template that genuinely lacks a doctor
  // (e.g. a minimal test fixture) hits the fallback for the canary specifically; treat that leniently
  // (allowDegraded) so the canary's job — proving the SYNC MECHANISM is safe — isn't blocked by the absence of
  // a doctor it doesn't own. Real projects (representative + staged) always respect the caller's actual
  // --allow-degraded flag (default strict) via plain `syncOpts`. seedRunForValidation: true is the OTHER
  // canary-only leniency (see seedCanaryRun's doc comment) — logs one real run_started event into the
  // canary's own just-synced forge-runs/ before validation runs, since the canary structurally never
  // accumulates real run history the way an actual project does. Real projects NEVER get this — their
  // forge-runs/ stays exactly what real /forge usage produced.
  const canarySyncOpts = Object.assign({}, syncOpts, { allowDegraded: true, seedRunForValidation: true });
  /** S6 FIX: sync-all's CLI wrapper already holds the ROOT lock for the whole batch, but that alone doesn't
   *  stop a concurrent single-project `install <root>/proj` (which only locks THAT project's own
   *  `.claude/.forge-sync.lock`, a different path) from racing sync-all on the same files. Hold each
   *  project's OWN lock for exactly the duration this batch is writing to it, in addition to the root lock. */
  /** sync-all proves EACH real project idle exactly like `install` does — the same
   *  quiesceCheck, run right before that project is touched (sync-all can run for a long time), BEFORE its own lock is
   *  taken (the lock itself counts as busy) — and passes the result in with the same semantics: not idle and no
   *  --quiesce-override "<reason>" -> refused, nothing written; an override is recorded in that project's receipt and
   *  report. opts.requireQuiesce turns it on (the CLI always does for a real run); opts.quiesceOpts are quiesceCheck's
   *  options (idleMin and the test seams). The disposable dedicated canary is not a real project and is not checked. */
  // the project lock is taken FIRST and the quiesce check runs UNDER it (check-after-lock); the check recognises this
  // run's own lock by nonce + pid, so it is never mistaken for "another sync running".
  const quiesceFor = (p, lock) => {
    if (!opts.requireQuiesce || opts.dryRun) return null;
    try { return (typeof opts.quiesceCheckImpl === 'function' ? opts.quiesceCheckImpl : quiesceCheck)(p, Object.assign({}, opts.quiesceOpts || {}, { ownLock: lock && lock.ok && lock.lockPath ? { nonce: lock.nonce, pid: lock.pid } : null })); }
    catch (e) { return { schema: 'forge-sync-quiesce/v1', idle: false, unknown: true, idleMin: null, checkedAt: nowIso, checks: {}, reasons: ['quiesce-check could not run (' + e.message + ') — unknown counts as NOT idle'] }; }
  };
  const quiesceOptsFor = (p, isCanary, lock) => (isCanary || !opts.requireQuiesce || opts.dryRun ? {} : { requireQuiesce: true, quiesce: quiesceFor(p, lock), quiesceOverride: opts.quiesceOverride || null });
  const lockedSync = (p, sOpts, isCanary) => {
    const lock = acquireLock(claudeDirOf(p), { batchId });
    if (!lock.ok) return { ok: false, refused: true, projectDir: p, reason: 'S6: could not acquire project lock for ' + p + ': ' + lock.reason };
    try { return safeSyncProject(templateDir, p, Object.assign({}, sOpts, quiesceOptsFor(p, isCanary, lock))); } // settings.json merge is now internal to safeSyncProject (WP22)
    finally { releaseLock(lock); }
  };

  if (opts.unsafe) {
    console.warn('*** --unsafe: legacy-style sync (NO canary, NO validation) — a real backup is still taken per project (never "no undo") ***');
    const projects = discoverProjects();
    let bad = 0; const results = [];
    for (const p of projects) {
      // the --unsafe branch runs under the per-project lock and the same quiesce gate as `install --unsafe`
      // (a dry-run stays lock-free and zero-write)
      const unsafeOpts = { dryRun: opts.dryRun, batchId, nowIso, centralBackupRoot, runId, forceOverwrite: !!opts.forceOverwrite, mergeSettings: !opts.dryRun, templateHistory: opts.templateHistory };
      let r;
      if (opts.dryRun) r = rawInstall(templateDir, p, unsafeOpts);
      else {
        const lock = acquireLock(claudeDirOf(p), { batchId }); // lock first, then the quiesce check under it
        if (!lock.ok) r = { ok: false, refused: true, exitCode: 1, projectDir: p, reason: 'could not acquire the project lock for ' + p + ': ' + lock.reason };
        else { try { r = rawInstall(templateDir, p, Object.assign(unsafeOpts, quiesceOptsFor(p, false, lock))); } finally { releaseLock(lock); } }
        if (r.refused && !r.ok) console.error(path.basename(p) + ': REFUSED — ' + r.reason);
      }
      // SUCCESS-WITHOUT-SETTINGS (wp-f2): sync-all --unsafe used to call ONLY rawInstall, so an --unsafe
      // batch never installed/reported settings.json at all — single-project `install --unsafe` already did.
      // Both now share this exact step.: a real run merges INSIDE rawInstall (ledgered in the batch).
      let settingsResult = null;
      if (r.ok) { settingsResult = r.settingsMerge !== undefined ? r.settingsMerge : syncProjectSettings(templateDir, p, { dryRun: opts.dryRun }); r.settingsMerge = settingsResult; printSettingsMergeResult(p, settingsResult); }
      results.push(r);
      if (!r.ok || settingsMergeFailed(settingsResult)) bad++;
    }
    return { ok: bad === 0, unsafe: true, batchId, projects: results, skippedDevTrees };
  }

  if (opts.dryRun) {
    // True dry-run: ZERO filesystem writes, including scaffolding. buildPlan()/preflight() are fully
    // read-only and tolerate a project directory that doesn't exist yet -> the dedicated canary's plan can
    // be previewed WITHOUT ever calling canaryInit() (which would create real files on disk).
    let dedicatedPlan;
    try { dedicatedPlan = buildPlan(templateDir, dedicatedCanaryDir(rootDir), { forceOverwrite: !!opts.forceOverwrite, templateHistory: opts.templateHistory }); }
    catch (e) { console.error('forge-sync: refusing sync-all dry-run: ' + e.message); return { ok: false, dryRun: true, refused: true, reason: e.message, batchId, projects: [] }; }
    const projects = discoverProjects();
    // DRY-RUN-MUTATION (wp-f2): sync-all's dry-run used to keep ONLY `.plan` from safeSyncProject's dry-run
    // result, discarding `.settingsMerge` — so the settings.json preview a REAL run would perform (create/
    // merge/refuse) never appeared in a dry-run at all. Kept here too now.
    const plans = projects.map((p) => {
      const r = safeSyncProject(templateDir, p, Object.assign({}, syncOpts, { dryRun: true }));
      return { projectDir: p, plan: r.plan, settingsMerge: r.settingsMerge, wouldRefuse: r.wouldRefuse || null, orphans: r.orphans || null, reason: r.reason || null };
    });
    // an incomplete template would refuse every project — the preview says so instead of "ok".
    const wouldRefuse = missingInTemplateReason(dedicatedPlan) || (plans.find((x) => x.wouldRefuse) || {}).wouldRefuse || null;
    return { ok: !wouldRefuse, dryRun: true, wouldRefuse, batchId, dedicatedCanary: { projectDir: dedicatedCanaryDir(rootDir), plan: dedicatedPlan }, projects: plans, skippedDevTrees };
  }

  // Stage 0: dedicated canary — MANDATORY, always first, structurally never a real project.
  canaryInit(templateDir, rootDir, { nowIso, doctorSource: opts.canaryDoctorSource });
  const dedicatedDir = dedicatedCanaryDir(rootDir);
  console.log('stage 0 (dedicated canary): ' + dedicatedDir);
  const dedicatedResult = lockedSync(dedicatedDir, canarySyncOpts, true); // the disposable canary: no quiesce gate
  printSafeSyncResult(dedicatedDir, dedicatedResult);
  if (!dedicatedResult.ok || hasUnresolvedDrift(dedicatedResult)) {
    console.error('DEDICATED CANARY ' + (dedicatedResult.ok ? 'HAS UNRESOLVED DRIFT' : 'FAILED') + ' -> ' + abortNote(dedicatedResult) + '. ABORTING before touching ANY real project.');
    printRemediation(rootDir, batchId, centralBackupRoot, []);
    return { ok: false, aborted: true, stage: 'dedicated-canary', batchId, dedicatedCanary: dedicatedResult, projects: [] };
  }

  const projects = discoverProjects();
  if (!projects.length) { console.log('no real Forge project found under ' + rootDir); return { ok: true, batchId, dedicatedCanary: dedicatedResult, projects: [], skippedDevTrees }; }

  // Stage 1: ONE representative real project.
  let repIdx = 0;
  if (opts.canaryName) {
    const idx = projects.findIndex((p) => path.basename(p) === opts.canaryName || p === opts.canaryName);
    if (idx === -1) { console.error('forge-sync: --canary ' + opts.canaryName + ' not found among discovered projects'); return { ok: false, usageError: true, batchId, dedicatedCanary: dedicatedResult, projects: [] }; }
    repIdx = idx;
  }
  const repDir = projects[repIdx];
  const rest = projects.filter((_, i) => i !== repIdx);
  console.log('stage 1 (representative real project): ' + path.basename(repDir));
  const repResult = lockedSync(repDir, syncOpts);
  printSafeSyncResult(repDir, repResult);
  const processed = [repResult];
  if (!repResult.ok || hasUnresolvedDrift(repResult)) {
    console.error('REPRESENTATIVE PROJECT ' + (repResult.ok ? 'HAS UNRESOLVED DRIFT' : 'FAILED') + ' -> ' + abortNote(repResult) + '. ABORTING batch. Remaining ' + rest.length + ' project(s) untouched.');
    printRemediation(rootDir, batchId, centralBackupRoot, processed);
    return { ok: false, aborted: true, stage: 'representative', batchId, dedicatedCanary: dedicatedResult, projects: processed };
  }

  // Ladder: 2 -> 3 -> --stage-size (default 3) thereafter.
  const ladder = [2, 3];
  const stageSize = opts.stageSize > 0 ? opts.stageSize : 3;
  let idx2 = 0, stopped = false, stageNum = 2;
  while (idx2 < rest.length && !stopped) {
    const size = ladder.length ? ladder.shift() : stageSize;
    const stage = rest.slice(idx2, idx2 + size);
    console.log('stage ' + stageNum + ' (' + stage.length + ' project(s), ladder-size ' + size + ')');
    for (const p of stage) {
      const r = lockedSync(p, syncOpts);
      printSafeSyncResult(p, r);
      processed.push(r);
      if (!r.ok || hasUnresolvedDrift(r)) {
        console.error('VALIDATION/DRIFT FAILURE for ' + path.basename(p) + ' -> ' + abortNote(r) + '. STOPPING batch.');
        printRemediation(rootDir, batchId, centralBackupRoot, processed);
        stopped = true; break;
      }
    }
    idx2 += size; stageNum++;
  }
  const ok = processed.every((r) => r.ok && !hasUnresolvedDrift(r));
  return { ok, aborted: stopped, batchId, dedicatedCanary: dedicatedResult, representative: repResult, projects: processed, skippedDevTrees };
}

/** printTemplateHistoryAndAccept(plan) — WP-SYNC-R7 item 1: say which files were synced because their bytes matched an earlier
 *  template version, and what --accept-template accepted / did not need / refused. Silent when there is nothing to say. */
function printTemplateHistoryAndAccept(plan) {
  if (!plan) return;
  const hist = (plan.toChange || []).filter((e) => e.overrideClass === 'template_history');
  if (hist.length) console.log('  unmodified earlier template copies (no baseline needed — matched ' + [...new Set(hist.map((e) => e.historyMatch))].join(' / ') + '), synced like updates: ' + hist.map((e) => e.rel).join(', '));
  const at = plan.acceptTemplate;
  if (!at) return;
  if (at.accepted.length) console.log('  --accept-template: replaced by the template version (old copies go into the batch backup): ' + at.accepted.map((a) => a.rel + ' (was ' + a.was + ')').join(', '));
  if (at.unused.length) console.log('  --accept-template: not needed (not drifted): ' + at.unused.map((u) => u.rel).join(', '));
  if (at.refused.length) console.error('  --accept-template REFUSED: ' + at.refused.map((x) => x.rel + ' (' + x.reason + ')').join('; '));
}
function printPlanSummary(plan) {
  console.log('  to-change: ' + plan.toChange.length + (plan.toChange.length ? ' (' + plan.toChange.map((e) => e.rel).join(', ') + ')' : ''));
  if (plan.expectedOverrides && plan.expectedOverrides.length) console.log('  expected overrides (never touched): ' + plan.expectedOverrides.join(', '));
  if (plan.unknownDrift && plan.unknownDrift.length) console.log('  UNKNOWN DRIFT (blocked, use --accept-template <rel> per file or --force-overwrite): ' + plan.unknownDrift.join(', '));
  if (plan.conflicts && plan.conflicts.length) console.log('  CONFLICT — both changed (blocked, use --accept-template <rel> per file or --force-overwrite): ' + plan.conflicts.join(', '));
  // R6(b) fix (2026-09-26 independent review, LOW): an owner-rule-pending-migration skip is not a
  // symlink/unsafe trip at all — it is a deliberate, temporary hold while a owner rule waits
  // to be moved to safety. Labeling it under "symlink/unsafe" reads like a security refusal instead of
  // what it actually is; it now gets its own honest line.
  const pendingSkips = (plan.skipped || []).filter((s) => s.reason === 'owner-rule-pending-migration');
  const scoutPendingSkips = (plan.skipped || []).filter((s) => s.reason === 'scout-verdict-pending-migration');
  const otherSkips = (plan.skipped || []).filter((s) => s.reason !== 'owner-rule-pending-migration' && s.reason !== 'scout-verdict-pending-migration');
  if (pendingSkips.length) console.log('  kept (owner rules still waiting to move — fix your private rules file first): ' + pendingSkips.map((s) => s.rel).join(', '));
  if (scoutPendingSkips.length) console.log('  kept (your own Scout verdicts still waiting to move — fix your private vetting file first): ' + scoutPendingSkips.map((s) => s.rel).join(', '));
  if (otherSkips.length) console.log('  skipped (symlink/unsafe): ' + otherSkips.map((s) => s.rel + ':' + s.reason).join(', '));
  if (plan.unreadable && plan.unreadable.length) console.log('  UNREADABLE (refuses the whole sync): ' + plan.unreadable.map((u) => u.rel).join(', '));
  // seed-only files are created when absent and otherwise left exactly as the project has them
  const seedsNew = (plan.toChange || []).filter((e) => e.overrideClass === 'seed').map((e) => e.rel);
  if (seedsNew.length) console.log('  seed files to create (absent here; never overwritten once present): ' + seedsNew.join(', '));
  if (plan.seedKept && plan.seedKept.length) console.log('  seed files kept as this project has them: ' + plan.seedKept.map((s) => s.rel).join(', '));
  printTemplateHistoryAndAccept(plan); // WP-SYNC-R7 item 1
  const blocking = plan.missingBlocking || [];
  if (blocking.length) console.log('  MISSING IN TEMPLATE (blocking — refuses the whole sync): ' + blocking.map((x) => x.rel).join(', ') + '\n  ' + PUBLISH_TEMPLATE_HINT);
  const advisoryMissing = (plan.missingInTemplate || []).length - blocking.length;
  if (advisoryMissing > 0) console.log('  missing in template (advisory' + (plan.shipManifest && plan.shipManifest.source !== 'template' ? ' — the template has no manifest of its own' : ' — release-excluded or seed-only') + '): ' + advisoryMissing);
  console.log('  unchanged: ' + plan.same);
}
/** printRetiredPruneResult —: "say so in the sync output" for the retired-dashboard
 *  cleanup (pruneRetiredFiles) — silent when there was nothing to report (the common case: nothing
 *  retired was ever present, or it was already cleaned up by an earlier sync). In dry-run mode
 *  pruneRetiredFiles() never populates `removed` (nothing was actually touched) — the preview lives in
 *  `removable` instead, so dry-run reads THAT list rather than silently printing nothing. */
function printRetiredPruneResult(projectDir, rp) {
  if (!rp) return;
  const name = path.basename(projectDir);
  if (rp.dryRun) {
    if (rp.removable && rp.removable.length) console.log('  ' + name + ': would remove retired dashboard file(s) [dry-run]: ' + rp.removable.map((e) => e.rel).join(', '));
  } else if (rp.removed && rp.removed.length) {
    console.log('  ' + name + ': removed retired dashboard file(s): ' + rp.removed.join(', '));
  }
  if (rp.kept && rp.kept.length) console.log('  ' + name + ': kept retired dashboard file(s) (not verifiably unmodified): ' + rp.kept.map((k) => k.rel + ' (' + k.reason + ')').join('; '));
  if (rp.failed && rp.failed.length) console.error('  ' + name + ': FAILED to remove retired dashboard file(s): ' + rp.failed.map((f) => f.rel + ' (' + f.reason + ')').join('; '));
}
function printSafeSyncResult(projectDir, r) {
  const name = path.basename(projectDir);
  // WP-SYNC-R7 item 5: every failure line also names the change report when this batch wrote one
  const reportLine = () => { if (r.report && r.report.path) console.error('  change report: ' + r.report.path); else if (r.report && r.report.error) console.error('  change report could not be written: ' + r.report.error); };
  if (!r.ok && r.refused) { console.error(name + ': REFUSED — ' + r.reason); reportLine(); return; }
  if (r.needsReview) { // files changed since the plan were skipped, never overwritten
    console.error(name + ': ' + r.reason);
    if (r.report && r.report.path) console.error('  change report: ' + r.report.path);
    return;
  }
  if (r.protectViolation) { // name every offending path, say what was rolled back
    console.error(name + ': ROLLED BACK — protected file(s) changed during the sync (' + (r.rolledBack ? 'batch rolled back' : 'rollback NOT complete' + (r.rollback && r.rollback.reason ? ': ' + r.rollback.reason : '')) + '):');
    protectViolationLines(r.protect).forEach((l) => console.error('  ' + l));
    protectWhyLines(r.protect, 20).forEach((l) => console.error('    ' + l)); // WP-SYNC-R13B: why an unreadable pair is a change
    if (protectNotComparableLine(r.protect)) console.error('  (' + protectNotComparableLine(r.protect) + ' — not counted as a change)'); // WP-SYNC-R13
    console.error('  The rollback restores what THIS sync wrote; restore the protected file(s) above from your own backup if they matter.');
    if (r.report && r.report.path) console.error('  change report: ' + r.report.path);
    return;
  }
  if (r.dryRun) {
    console.log('[dry-run] ' + name + ':'); printPlanSummary(r.plan); printSettingsMergeResult(projectDir, r.settingsMerge); printRetiredPruneResult(projectDir, r.retiredPrune && Object.assign({ dryRun: true }, r.retiredPrune));
    printOrphanReport(projectDir, r.orphans, null);
    if (r.wouldRefuse) console.error('[dry-run] ' + name + ': WOULD REFUSE — ' + r.wouldRefuse);
    return;
  }
  if (r.blocked) { console.error(name + ': BLOCKED: ' + r.plan.unknownDrift.length + ' drifted / ' + r.plan.conflicts.length + ' conflicted (use --force-overwrite or declare .claude/config/forge-overrides.json)'); return; }
  if (r.refusedPartialDrift) { // B3: never silently stamp a partially-synced project
    console.error(name + ': BLOCKED — ' + r.plan.unknownDrift.length + ' drifted / ' + r.plan.conflicts.length + ' conflicted file(s) prevent a full sync (use --accept-template <rel> per file, --force-overwrite for all, or declare .claude/config/forge-overrides.json); safely-syncable file(s) were rolled back, NOT partially stamped');
    if (r.plan.unknownDrift.length) console.error('  UNKNOWN DRIFT: ' + r.plan.unknownDrift.join(', '));
    if (r.plan.conflicts.length) console.error('  CONFLICT: ' + r.plan.conflicts.join(', '));
    if (r.settingsRestore && r.settingsRestore.ok === false) console.error('  ' + settingsRestoreProblem(r.settingsRestore)); // WP-SYNC-R11
    reportLine();
    return;
  }
  if (r.noop) { console.log(name + ': up to date (' + r.plan.same + ' unchanged)'); if (r.plan.unknownDrift.length || r.plan.conflicts.length) printPlanSummary(r.plan); printSettingsMergeResult(projectDir, r.settingsMerge); printRetiredPruneResult(projectDir, r.retiredPrune); printOrphanReport(projectDir, r.orphans, r.retiredOrphans); return; }
  if (r.ok) {
    // WP-SYNC-R9: a sync kept because its flagged suites passed alone never reads as a plain "OK"
    const flaky = r.outcome && Array.isArray(r.outcome.flakyUnderLoad) && r.outcome.flakyUnderLoad.length ? r.outcome.flakyUnderLoad : null;
    const note = (flaky ? ' [doctor run RED; ' + flaky.length + ' suite(s) flaky under load — passed alone, NOT proven healthy under load: ' + flaky.join(', ') + ']' : '')
      + (r.outcome && r.outcome.alreadyRedSkipped ? ' [pre-existing unrelated failure(s), not attributed to this sync]' : (r.outcome && r.outcome.degradedAllowed ? ' [DEGRADED validator, --allow-degraded]' : ''));
    console.log(name + ': ' + r.plan.toChange.length + ' updated, ' + r.plan.same + ' current -> version ' + r.receipt.templateVersionTo + ' · validation: ' + r.validation.tool + (flaky ? ' accepted' : ' OK') + note);
    if (r.plan.expectedOverrides.length) console.log('  expected overrides preserved: ' + r.plan.expectedOverrides.join(', '));
    if (r.plan.seedKept && r.plan.seedKept.length) console.log('  seed files kept as this project has them (never overwritten): ' + r.plan.seedKept.map((s) => s.rel).join(', '));
    printTemplateHistoryAndAccept(r.plan); // WP-SYNC-R7 item 1
    if (r.validation && Number.isFinite(r.validation.durationMs)) console.log('  doctor: ran ' + Math.round(r.validation.durationMs / 1000) + ' s (limit ' + Math.round((r.validation.timeoutMs || 0) / 1000) + ' s, ' + (r.validation.timeoutSource || 'unknown') + ')');
    printSettingsMergeResult(projectDir, r.settingsMerge);
    printRetiredPruneResult(projectDir, r.retiredPrune);
    printOrphanReport(projectDir, r.orphans, r.retiredOrphans);
    // WP-SYNC-R13B / WP-SYNC-R14: only VERIFIED entries are called unchanged; the app-code coverage
    // stands next to it and the line ends with the scope verdict (protectInstallLine)
    if (r.protect) console.log('  ' + protectInstallLine(r.protect));
    if (r.protect && protectNotComparableLine(r.protect)) console.log('  ' + protectNotComparableLine(r.protect)); // WP-SYNC-R13
    if (r.receipt && r.receipt.quiesce && r.receipt.quiesce.override) console.log('  quiesce override recorded: ' + r.receipt.quiesce.override);
    if (r.report && r.report.path) console.log('  change report: ' + r.report.path);
    else if (r.report && r.report.error) console.error('  change report could not be written: ' + r.report.error);
  } else {
    const failLabel = r.outcome && r.outcome.validationThrew ? 'the validation step threw' // WP-SYNC-R12
      : (r.outcome && r.outcome.settingsChanged ? 'settings.json changed during validation; ' + (r.validation ? r.validation.tool + ', exit ' + r.validation.exitCode : 'no validation result')
        : (r.validation ? (r.validation.timedOut ? (r.validation.tool + ' TIMED OUT (blocked, not a confirmed failure)') : (r.validation.tool + ', exit ' + r.validation.exitCode)) : (r.applyError || 'unknown')));
    let rbNote;
    if (r.rollbackError) rbNote = 'rollback ERROR: ' + r.rollbackError;
    else if (r.restored && r.restored.refusedDivergence) rbNote = 'rollback REFUSED (content diverged since this sync — see diagnostics)';
    else if (r.restored && r.restored.ok === false) rbNote = 'PARTIAL ROLLBACK — MANUAL RECOVERY REQUIRED (' + (r.restored.failed || []).length + ' file(s); backup at ' + (r.backup ? r.backup.backupDir : '?') + ')';
    else rbNote = 'rolled back ' + (r.restored ? r.restored.restored.length : 0) + ' file(s)';
    // WP-SYNC-R11: settings.json was merged before the doctor — say whether the rollback put it back
    if (r.settingsRestore && r.settingsRestore.ok === false) rbNote += '; ' + settingsRestoreProblem(r.settingsRestore);
    else if (r.settingsRestore && /^(restored|removed)/.test(r.settingsRestore.action || '')) rbNote += '; settings.json ' + r.settingsRestore.action;
    console.error(name + ': FAILED (' + failLabel + ') -> ' + rbNote);
    // WP-SYNC-R7 item 5: WHY it failed (the validation outcome's own reason, else the result's) and where the report is
    const why = (r.outcome && r.outcome.reason) || r.reason || r.applyError || null;
    if (why) console.error('  reason: ' + why);
    if (r.validation && Number.isFinite(r.validation.durationMs)) console.error('  doctor: ran ' + Math.round(r.validation.durationMs / 1000) + ' s' + (Number.isFinite(r.validation.timeoutMs) ? ' (limit ' + Math.round(r.validation.timeoutMs / 1000) + ' s, ' + (r.validation.timeoutSource || 'unknown') + ')' : ''));
    reportLine();
  }
}

/** parseArgs — M1: a value-taking flag (e.g. --run-id) that is followed by ANOTHER flag or nothing at all
 *  (e.g. `--run-id --dry-run`) must be refused, not silently swallow the next flag as its value (which would
 *  leave --dry-run's own flag unset while a real, non-dry-run sync proceeds). Returns argError (non-null on
 *  a bad value) for the caller to turn into a usage exit(2). */
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  let argError = null;
  const takeValue = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { if (!argError) argError = 'missing value for ' + name; return { value: null, consumed: 0 }; }
    return { value: v, consumed: 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force-overwrite') flags.forceOverwrite = true;
    else if (a === '--force-all') flags.forceAll = true;
    else if (a === '--force') flags.force = true; // S5: adopt's explicit opt-in to replace an existing baseline
    else if (a === '--unsafe') flags.unsafe = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--allow-degraded') flags.allowDegraded = true;
    else if (a === '--no-central-backup') flags.noCentralBackup = true;
    else if (a === '--force-rollback-newer') flags.forceRollbackNewer = true;
    else if (a === '--resume-batch') flags.resumeBatch = true;
    else if (a === '--reuse-pre-baseline') flags.reusePreBaseline = true;
    else if (a === '--no-isolated-rerun') flags.noIsolatedRerun = true; // WP-SYNC-R9: a flagged suite rolls back without its isolated re-run
    else if (a === '--retire-orphans') flags.retireOrphans = true; // opt-in, moves into the batch backup
    else if (a === '--allow-legacy-manifest') flags.allowLegacyManifest = true; // trust an older, unbound backup manifest on purpose
    else if (a === '--canary') { const r = takeValue(i, '--canary'); flags.canary = r.value; i += r.consumed; }
    else if (a === '--stage-size') { // S8: a non-numeric value must be a usage error, not a silent NaN-fallback-to-default
      const r = takeValue(i, '--stage-size'); i += r.consumed;
      if (r.value != null) { const n = Number(r.value); if (!Number.isFinite(n)) { if (!argError) argError = '--stage-size must be a number, got: ' + r.value; } else flags.stageSize = n; }
    }
    else if (a === '--batch-id' || a === '--batch') { // a batch id becomes a folder name — usage error when unsafe
      const r = takeValue(i, '--batch-id'); flags.batchId = r.value; i += r.consumed;
      if (r.value != null && !isSafeBatchId(r.value) && !argError) argError = unsafeBatchIdReason(r.value);
    }
    else if (a === '--central-backup-root') { const r = takeValue(i, '--central-backup-root'); flags.centralBackupRoot = r.value; i += r.consumed; }
    else if (a === '--run-id') { const r = takeValue(i, '--run-id'); flags.runId = r.value; i += r.consumed; }
    else if (a === '--doctor-timeout') { // S8: same numeric-validation treatment as --stage-size
      const r = takeValue(i, '--doctor-timeout'); i += r.consumed;
      if (r.value != null) { const n = Number(r.value); if (!Number.isFinite(n)) { if (!argError) argError = '--doctor-timeout must be a number, got: ' + r.value; } else flags.doctorTimeout = n; }
    }
    else if (a === '--isolated-rerun-budget') { // WP-SYNC-R10 (Codex R9-05b): the cap on the WHOLE isolated re-run phase, in ms
      const r = takeValue(i, '--isolated-rerun-budget'); i += r.consumed;
      if (r.value != null) { const n = Number(r.value); if (!Number.isFinite(n) || n <= 0) { if (!argError) argError = '--isolated-rerun-budget must be a positive number of milliseconds, got: ' + r.value; } else flags.isolatedRerunBudget = n; }
    }
    else if (a === '--idle-min') { // the quiesce window in minutes
      const r = takeValue(i, '--idle-min'); i += r.consumed;
      if (r.value != null) { const n = Number(r.value); if (!Number.isFinite(n) || n < 0 || n > 10080) { if (!argError) argError = '--idle-min must be a number of minutes between 0 and 10080, got: ' + r.value; } else flags.idleMin = n; }
    }
    else if (a === '--quiesce-override') { // a deliberate, RECORDED exception — the reason is mandatory
      const r = takeValue(i, '--quiesce-override'); i += r.consumed;
      if (r.value != null) {
        const reason = String(r.value).trim();
        if (reason.length < 3 || reason.length > 500) { if (!argError) argError = '--quiesce-override needs a reason of 3-500 characters (it is recorded in the receipt and the change report)'; }
        else flags.quiesceOverride = reason;
      }
    }
    else if (a === '--out') { const r = takeValue(i, '--out'); flags.out = r.value; i += r.consumed; } // protect-manifest
    else if (a === '--accept-template') { // WP-SYNC-R7 item 1: repeatable, one .claude-relative path per flag
      const r = takeValue(i, '--accept-template'); i += r.consumed;
      if (r.value != null) {
        if (!String(r.value).trim()) { if (!argError) argError = '--accept-template needs a path (relative to .claude/)'; }
        else (flags.acceptTemplate = flags.acceptTemplate || []).push(String(r.value).trim());
      }
    }
    else if (a === '--allow-dev-tree-target') { // WP-SYNC-R7 item 6: a deliberate, RECORDED exception — the reason is mandatory
      const r = takeValue(i, '--allow-dev-tree-target'); i += r.consumed;
      if (r.value != null) {
        const reason = String(r.value).trim();
        if (reason.length < 3 || reason.length > 500) { if (!argError) argError = '--allow-dev-tree-target needs a reason of 3-500 characters (it is recorded in the receipt and the change report)'; }
        else flags.allowDevTreeTarget = reason;
      }
    }
    else if (!a.startsWith('--')) pos.push(a);
  }
  return { flags, pos, argError };
}

/** syncProjectSettings — WP22 ("alles standaard aan" / never "merge by
 *  hand"): after this project's system FILES are synced, also merge the template's `settings.json` into the
 *  project's own — absent -> create (a copy); present -> merge (forge-settings-merge.cjs, foreign hooks/
 *  rules kept); malformed/unexpected shape -> refused-safe, reported, NEVER fails the file sync. Deliberately
 *  independent of the file-sync backup/receipt/rollback machinery above: settings.json is user-owned content,
 *  not a SYSTEM file (see the SYSTEM list's own "does not itself write settings.json" comment, now
 *  superseded by this function), so it gets its own dedicated merge tool and its own `.forge-bak-<ts>`
 *  backup instead of joining the receipt ledger. A template without a settings.json, or a merge tool that
 *  cannot load, is a silent, honestly-labelled skip — this step must never turn a successful file sync into
 *  a failure.: install/sync now call it through mergeSettingsForBatch, which records the pre-merge
 *  bytes + hash in the batch so `rollback` restores settings.json too; this function itself is unchanged.
 *  WP-SYNC-R11: the safe install now merges right after the file sync and BEFORE the post-sync doctor (the doctor judges
 *  the final settings.json), not after the receipt; an in-run rollback undoes the merge (undoSettingsMerge). */
function syncProjectSettings(templateDir, projectDir, opts) {
  opts = opts || {};
  const srcPath = path.join(templateDir, 'settings.json');
  if (!fs.existsSync(srcPath)) return { ok: true, skipped: 'no-template-settings' };
  const dst = claudeDirOf(projectDir);
  // PROJECT-DIRECTORY-ESCAPE (wp-f2): the settings step runs in EVERY branch
  // (dry-run, the no-op branch, and the real success path — all three call this one function), so the SAME
  // containment/symlink guard the per-file sync path already applies to every system file is applied here
  // too, once, rather than only in the "normal" branch. A `.claude` that is itself a symlink/junction (or
  // resolves outside its own project) refuses instead of merging settings.json across that boundary.
  if (isSymlinkPath(dst) || !containmentSafe(projectDir, dst)) {
    return { ok: false, skipped: 'refused-containment', error: '.claude resolves outside its project (or is itself a symlink/junction) — refusing to merge settings.json across that boundary' };
  }
  let mergeTool;
  try { mergeTool = require('./forge-settings-merge.cjs'); }
  catch (e) { return { ok: false, skipped: 'merge-tool-unavailable', error: e.message }; }
  const dstPath = path.join(dst, 'settings.json');
  try { return mergeTool.applySettingsMerge({ target: dstPath, source: srcPath, dryRun: !!opts.dryRun, projectRoot: dst }); }
  catch (e) { return { ok: false, skipped: 'merge-error', error: e.message }; }
}
/** printSettingsMergeResult — one plain status line for the CLI/sync-all output, never throws, never blocks
 *  the caller on a skip/refusal (see syncProjectSettings's own doc comment for why a refusal is reported,
 *  not fatal). */
function printSettingsMergeResult(projectDir, r) {
  const name = path.basename(projectDir);
  if (!r) return;
  if (r.skipped) { if (r.skipped !== 'no-template-settings') console.error(name + ': settings.json merge skipped (' + r.skipped + (r.error ? ': ' + r.error : '') + ')'); return; }
  const dupNote = (rr) => (rr.duplicate_matchers && rr.duplicate_matchers.length ? (' (NOTE: ' + rr.duplicate_matchers.length + ' pre-existing duplicate matcher group(s) found — not auto-repaired)') : '');
  if (r.status === 'created') console.log(name + ': settings.json created (from template)');
  else if (r.status === 'would-create') console.log('[dry-run] ' + name + ': settings.json would be created (from template)');
  else if (r.status === 'noop') console.log(name + ': settings.json already merged' + dupNote(r));
  else if (r.status === 'would-merge') console.log('[dry-run] ' + name + ': settings.json would merge — +' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + (Array.isArray(r.upgraded) ? r.upgraded.length : 0) + ' hook command update(s), +' + r.deny_added.length + ' deny rule(s)');
  else if (r.status === 'merged') console.log(name + ': settings.json merged — +' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + (Array.isArray(r.upgraded) ? r.upgraded.length : 0) + ' hook command update(s), +' + r.deny_added.length + ' deny rule(s); your own entries kept; backup: ' + r.backupPath + dupNote(r));
  else if (r.status === 'refused' || r.status === 'would-refuse') console.error(name + ': ' + r.message);
  // SUCCESS-WITHOUT-SETTINGS (wp-f2): a malformed TEMPLATE source (usage-error) used to be silently omitted
  // from every printer — the ONLY status this function never printed anything for.
  else if (r.status === 'usage-error') console.error(name + ': settings.json merge could not run (' + r.message + ')');
}
/** WP 3.1 (modernization): forge-sync stays the route for updating and adopting existing (legacy) installs;
 *  a NEW project uses the two-step install (add the Forge plugin, then `/forge init`, see docs/INSTALL.md). These two
 *  notices only point there: one extra line when `install` refuses a folder without .claude/, and one line after a
 *  successful real install whose project now carries forge-init.cjs (never in --json or dry-run output). Output only;
 *  nothing about the install itself changes, and a notice can never fail it. */
const INIT_NOTICE_NEW = 'forge-sync: a new project can also use the two-step install: add the Forge plugin, then run `/forge init` in the project (docs/INSTALL.md).';
function printInitNotice(projectDir) {
  try {
    if (!fs.existsSync(path.join(claudeDirOf(projectDir), 'forge-bin', 'forge-init.cjs'))) return;
    console.log('  next: run `/forge init` in this project (or `node .claude/forge-bin/forge-init.cjs check`) for its memory files and CLAUDE.md pointer; forge-sync stays for updates and existing installs');
  } catch { /* a notice never fails an install */ }
}

// =====================================================================================================================
// part 1 (2026-10-10,; audit SYNC-02, SYNC-06, SYNC-07, SYNC-11, SYNC-12
// and the coupled-delivery risk): safety tooling for writing into a live, memory-bearing project.
//   quiesce-check    read-only: is the project idle? A real install refuses unless it is (or an override is recorded).
//   protect-manifest an inverse hash manifest of everything the sync must NOT change. install takes one before its
//                    first write and re-checks it after its last; any difference rolls the whole batch back.
//   settings ledger  the pre-merge settings.json bytes + hash live in the batch backup, so rollback restores it.
//   --dry-run --json the full machine-readable install plan.
//   provenance       devCommitFrom/devCommitTo in FORGE_VERSION.json and a forge-sync-report-<batch>.md per batch.
//   coupled trio     log-event.cjs / forge-verify.cjs / forge-runcontract.cjs are only ever delivered together.
// Not here (part 2): the maintenance-mode lock check in the hooks/log-event/gateway, the doctor timeout and the
// test-suite isolation (FORGE_STORE_ROOT). The protect check below is what CATCHES a suite that writes into the target.
// =====================================================================================================================

// ---- quiesce-check ----------------------------------------------------------------------------------------
const QUIESCE_DEFAULT_IDLE_MIN = 10;
const QUIESCE_TRANSCRIPT_MAX_DEPTH = 8;
/** claudeProjectSlug(projectDir) — the folder name Claude Code uses for a project under ~/.claude/projects: every
 *  character that is not a letter or digit becomes '-'. Observed on this machine: `C:\Users\YOU\Documents\my project
 *!` -> `c--Users-YOU-Documents-my-project-v2-` (the drive letter's case varies, so matching is
 *  case-insensitive). */
function claudeProjectSlug(projectDir) { return path.resolve(projectDir).replace(/[^A-Za-z0-9]/g, '-'); }
function defaultClaudeProjectsRoot() { return path.join(os.homedir(), '.claude', 'projects'); }
/** transcriptFoldersFor(projectDir, projectsRoot) -> {slug, root, dirs[], missingRoot, error}. A folder counts when its
 *  name equals the slug or starts with slug + '-' (a session started in a SUBFOLDER, e.g. the project's .claude/, gets
 *  `<slug>--claude`). Over-matching a sibling that shares the prefix only makes the check stricter, never looser. */
function transcriptFoldersFor(projectDir, projectsRoot) {
  const slug = claudeProjectSlug(projectDir);
  const lower = slug.toLowerCase();
  let entries;
  try { entries = fs.readdirSync(projectsRoot, { withFileTypes: true }); }
  catch (e) {
    const missing = !!(e && e.code === 'ENOENT');
    return { slug, root: projectsRoot, dirs: [], linked: [], missingRoot: missing, error: missing ? null : e.message };
  }
  const matches = (n) => { const l = n.toLowerCase(); return l === lower || l.startsWith(lower + '-'); };
  const dirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && matches(e.name)).map((e) => e.name).sort().map((n) => path.join(projectsRoot, n));
  // a matching folder that is a junction/symlink was silently dropped (Dirent.isDirectory() is false for it),
  // which made "no transcript folder" — idle. It is reported so the caller can count it as UNKNOWN (never idle).
  const linked = entries.filter((e) => e.isSymbolicLink() && matches(e.name)).map((e) => path.join(projectsRoot, e.name)).sort();
  return { slug, root: projectsRoot, dirs, linked, missingRoot: false, error: null };
}
/** freshestFileUnder(dir, cutoffMs, maxDepth) -> {fresh, newest, files, truncated, error}. File TIMES only — never reads
 *  a byte. Stops at the first file modified at/after cutoffMs (a future time from clock skew counts as fresh). A folder
 *  deeper than maxDepth sets `truncated` (the caller treats that as unknown, never as idle). */
function freshestFileUnder(dir, cutoffMs, maxDepth) {
  let newest = null, files = 0, error = null, truncated = false;
  const linked = [];
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { if (!error && !(e && e.code === 'ENOENT')) error = d + ': ' + e.message; return null; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      // a junction/symlink inside an activity folder is never followed — and never skipped as idle either:
      // whatever it points at could be a live session. It makes the result unknown.
      if (e.isSymbolicLink()) { linked.push(p); if (!error) error = p + ': a junction/symlink — not inspected, counts as unknown'; continue; }
      if (e.isDirectory()) {
        if (depth >= maxDepth) { truncated = true; continue; }
        const hit = walk(p, depth + 1);
        if (hit) return hit;
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(p); } catch (err) { if (!error) error = p + ': ' + err.message; continue; }
      files++;
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs: st.mtimeMs };
      if (st.mtimeMs >= cutoffMs) return { path: p, mtimeMs: st.mtimeMs };
    }
    return null;
  };
  const fresh = walk(dir, 0);
  return { fresh, newest, files, truncated, error, linked };
}
/** listProcessesStructured(opts?) -> [{pid, ppid, name, cmd}] from the OS process table (Windows: Get-CimInstance Win32_Process,
 *  the same structured source forge-killswitch uses; elsewhere `ps -eo pid=,ppid=,args=`). Read-only: it never
 *  signals, stops or matches a process by image name. Throws when the listing cannot be taken — the caller turns that
 *  into "unknown", which counts as NOT idle. */
/** escapeJsonStringControlChars(text) — WP-SYNC-R7 item 3 (26H2 rehearsal): Windows PowerShell 5.1's ConvertTo-Json leaves
 *  some control characters RAW inside a JSON string (seen: 0x1A in one process's command line), and JSON.parse rejects the
 *  whole listing ("Bad control character in string literal") — quiesce-check then counted the project as not idle on EVERY
 *  run. Every U+0000-U+001F that sits INSIDE a string literal becomes \u00XX; characters between tokens (JSON whitespace)
 *  are left alone, and escapes already present (\\, \") are respected. A no-op on clean input. */
function escapeJsonStringControlChars(text) {
  const s = String(text == null ? '' : text);
  if (!/[\u0000-\u001f]/.test(s)) return s;
  let out = '', last = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!inStr) { if (c === 0x22) inStr = true; continue; }
    if (esc) { esc = false; if (c >= 0x20) continue; } // a raw control character right after a backslash is escaped below too
    else if (c === 0x5c) { esc = true; continue; }
    else if (c === 0x22) { inStr = false; continue; }
    if (c < 0x20) { out += s.slice(last, i) + '\\u' + c.toString(16).padStart(4, '0'); last = i + 1; }
  }
  return out + s.slice(last);
}
/** parseWin32ProcessJson(stdout) -> [{pid, ppid, name, cmd}] — the Get-CimInstance Win32_Process | ConvertTo-Json output,
 *  control characters escaped first (escapeJsonStringControlChars). Throws on anything that still is not JSON. */
function parseWin32ProcessJson(stdout) {
  const parsed = JSON.parse(escapeJsonStringControlChars(String(stdout || '').trim()) || 'null');
  const arr = parsed == null ? [] : (Array.isArray(parsed) ? parsed : [parsed]);
  return arr.map((p) => ({ pid: Number(p && p.ProcessId), ppid: Number(p && p.ParentProcessId), name: p && p.Name != null ? String(p.Name) : null, cmd: p && p.CommandLine != null ? String(p.CommandLine) : null })).filter((p) => Number.isFinite(p.pid));
}
function listProcessesStructured(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform; // test seams: platform + spawnSyncImpl (never a real listing in the suite)
  const run = typeof o.spawnSyncImpl === 'function' ? o.spawnSyncImpl : spawnSync;
  if (platform === 'win32') {
    // the image Name is read too — it is readable for every process, also those whose command line is not
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3; exit 0'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true });
    if (r.error || r.status !== 0) throw new Error('Get-CimInstance Win32_Process failed (' + (r.error ? r.error.message : 'exit ' + r.status) + ')');
    return parseWin32ProcessJson(r.stdout); // WP-SYNC-R7 item 3: raw control characters escaped before JSON.parse
  }
  const r = run('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  if (r.error || r.status !== 0) throw new Error('ps failed (' + (r.error ? r.error.message : 'exit ' + r.status) + ')');
  return String(r.stdout || '').split(/\r?\n/).map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(l); return m ? { pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] } : null; }).filter(Boolean);
}
/** QUIESCE_SUSPECT_IMAGE_RE — R4 / F09: image names that can plausibly be an agent, a tool or a shell writing into a project.
 *  A process with such a name whose command line (or, on Linux, working directory) cannot be read is UNKNOWN — never idle.
 *  Measured on the owner's machine (not elevated): 115 of 856 processes have no readable command line, all of
 *  them services and system images (svchost x40, postgres x10, conhost, WmiPrvSE, csrss ...); treating every one of those as
 *  unknown would make a real project never idle, so they stay "counted, not inspected" — the stated limit of this check. */
const QUIESCE_SUSPECT_IMAGE_RE = /^(node|nodejs|deno|bun|npm|npx|pnpm|yarn|tsx|ts-node|python[0-9.]*|pythonw|py|pwsh|powershell|powershell_ise|cmd|bash|sh|zsh|dash|fish|git|git-bash|mintty|claude|claude-code|code|code-insiders|codex|cursor|windsurf|ruby|perl|java|dotnet|go|cargo|rustc|make|gradle|mvn|php)(\.exe)?$/i;
function isSuspectImage(name) { return typeof name === 'string' && QUIESCE_SUSPECT_IMAGE_RE.test(name.trim()); }
/** processCwd(pid) -> absolute path | null (not exposed / not readable). Linux exposes /proc/<pid>/cwd; Windows and macOS
 *  expose nothing a zero-dependency Node tool can read, so null means "unknown", and the caller says so. */
function processCwd(pid) {
  if (process.platform !== 'linux') return null;
  try { return fs.readlinkSync('/proc/' + pid + '/cwd'); } catch { return null; }
}
/** pathVariantsForMatch(projectDir) -> the lower-cased spellings a command line may use for this folder: backslashes,
 *  forward slashes, and the Git Bash/MSYS form (/c/users/...). */
function pathVariantsForMatch(projectDir) {
  const win = path.resolve(projectDir).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const fwd = win.replace(/\\/g, '/');
  const out = new Set([win, fwd]);
  const m = /^([a-z]):(\/.*)$/.exec(fwd);
  if (m) out.add('/' + m[1] + m[2]);
  return [...out];
}
/** commandLineMentions(cmd, variants) — true when the command line names the folder itself or something inside it
 *  (the match must end at a path separator, a quote, whitespace or the end, so `...\proj` does not match `...\proj2`). */
function commandLineMentions(cmd, variants) {
  const lc = String(cmd == null ? '' : cmd).toLowerCase();
  for (const v of variants) {
    let idx = lc.indexOf(v);
    while (idx !== -1) {
      const next = lc.charAt(idx + v.length);
      if (next === '' || /[\\/"'\s;,)]/.test(next)) return true;
      idx = lc.indexOf(v, idx + 1);
    }
  }
  return false;
}
/** ancestorPidSet(list, selfPid, parentPid) — this process and the chain that started it (they legitimately name the
 *  project: `forge-sync install <project>` and the shell around it). Bounded walk, cycle-safe. */
function ancestorPidSet(list, selfPid, parentPid) {
  const parent = new Map((list || []).map((p) => [Number(p.pid), Number(p.ppid)]));
  const out = new Set([selfPid]);
  if (Number.isFinite(parentPid) && parentPid > 0) out.add(parentPid);
  // walk upward from this process's parent (from the listing when it has us, else the parent pid we were given)
  let cur = parent.has(selfPid) ? parent.get(selfPid) : parentPid;
  const seen = new Set([selfPid]);
  for (let i = 0; i < 64 && Number.isFinite(cur) && cur > 0 && !seen.has(cur); i++) {
    out.add(cur); seen.add(cur);
    cur = parent.get(cur);
  }
  return out;
}
/** quiesceCheck(projectDir, opts) -> {schema, idle, unknown, idleMin, projectPath, checkedAt, checks, reasons}.
 *  READ-ONLY. Idle means ALL of: (1) no Claude Code transcript of this project (~/.claude/projects/<slug>*) modified
 *  within idleMin minutes; (2) no .claude/forge-runs/<run>/events.jsonl modified within it; (3) no
 *  .claude/.forge-sync.lock; (4) no live process (other than this one and its ancestors) naming the project on its
 *  command line. Every check is ok | busy | unknown, and unknown counts as NOT idle (fail-safe). It never kills, never
 *  reads a transcript's contents, and only records a matching process's pid and executable name (a command line can
 *  carry secrets). Stated limits: a process whose cwd is the project but whose command line does not name it is
 *  invisible here (the transcript check covers Claude Code sessions); processes without a readable command line
 *  (system processes, other users) are counted, not inspected; the gateway's /api/active-runs is not queried.
 *  opts: idleMin, nowMs, projectsRoot, listProcesses (fn), selfPid, parentPid — all injectable for tests. */
function quiesceCheck(projectDir, opts) {
  opts = opts || {};
  const idleMin = Number.isFinite(opts.idleMin) && opts.idleMin >= 0 ? opts.idleMin : QUIESCE_DEFAULT_IDLE_MIN;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const cutoffMs = nowMs - idleMin * 60000;
  const abs = path.resolve(projectDir);
  const dst = claudeDirOf(abs);
  const iso = (ms) => new Date(ms).toISOString();
  const checks = {};

  // (1) Claude Code transcripts of this project (file times only)
  const tf = transcriptFoldersFor(abs, opts.projectsRoot || defaultClaudeProjectsRoot());
  if (tf.error) checks.transcripts = { state: 'unknown', detail: 'could not list ' + tf.root + ' (' + tf.error + ')', slug: tf.slug, dirs: [] };
  else if (!tf.dirs.length && !tf.linked.length) checks.transcripts = { state: 'ok', detail: 'no Claude Code transcript folder for ' + tf.slug + ' under ' + tf.root, slug: tf.slug, dirs: [] };
  else {
    let state = 'ok', freshest = null;
    const problems = tf.linked.map((l) => path.basename(l) + ': the transcript folder is a junction/symlink — not inspected, counts as unknown (R3 / SYNC-11)');
    for (const d of tf.dirs) {
      const f = freshestFileUnder(d, cutoffMs, QUIESCE_TRANSCRIPT_MAX_DEPTH);
      if (f.fresh) { state = 'busy'; freshest = f.fresh; break; }
      if (f.error || f.truncated) problems.push(path.basename(d) + ': ' + (f.error || 'nested deeper than ' + QUIESCE_TRANSCRIPT_MAX_DEPTH + ' levels — not fully scanned'));
      if (f.newest && (!freshest || f.newest.mtimeMs > freshest.mtimeMs)) freshest = f.newest;
    }
    if (state === 'ok' && problems.length) state = 'unknown';
    const detail = state === 'busy' ? 'a transcript was modified ' + iso(freshest.mtimeMs) + ' (within ' + idleMin + ' min): ' + freshest.path
      : (state === 'unknown' ? 'transcripts could not be fully checked: ' + problems.join('; ')
        : tf.dirs.length + ' transcript folder(s); newest activity ' + (freshest ? iso(freshest.mtimeMs) : 'none') + ', older than ' + idleMin + ' min');
    checks.transcripts = { state, detail, slug: tf.slug, dirs: tf.dirs };
  }

  // (2) Forge run event logs inside the project
  const runsDir = path.join(dst, 'forge-runs');
  let runNames = null, runsErr = null;
  const linkedRuns = [];
  // forge-runs itself, or a run folder, or an events.jsonl that is a junction/symlink is UNKNOWN (never idle)
  if (lstatKind(runsDir) === 'link') runsErr = 'forge-runs is a junction/symlink — not inspected, counts as unknown';
  else {
    try {
      const ents = fs.readdirSync(runsDir, { withFileTypes: true });
      runNames = ents.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
      for (const e of ents) if (e.isSymbolicLink()) linkedRuns.push(e.name);
    } catch (e) { if (e && e.code === 'ENOENT') runNames = []; else runsErr = e.message; }
  }
  if (runsErr) checks.events = { state: 'unknown', detail: 'could not list ' + runsDir + ' (' + runsErr + ')' };
  else {
    const fresh = [], errs = linkedRuns.map((n) => n + ': a junction/symlink run folder — not inspected, counts as unknown');
    for (const n of runNames) {
      const ev = path.join(runsDir, n, 'events.jsonl');
      if (lstatKind(ev) === 'link') { errs.push(n + ': events.jsonl is a junction/symlink — not inspected, counts as unknown'); continue; }
      try { const st = fs.statSync(ev); if (st.mtimeMs >= cutoffMs) fresh.push({ run: n, modified: iso(st.mtimeMs) }); }
      catch (e) { if (!(e && e.code === 'ENOENT')) errs.push(n + ': ' + e.message); }
    }
    if (fresh.length) checks.events = { state: 'busy', detail: fresh.length + ' run event log(s) written within ' + idleMin + ' min: ' + fresh.slice(0, 5).map((f) => f.run + ' @ ' + f.modified).join(', '), fresh };
    else if (errs.length) checks.events = { state: 'unknown', detail: 'could not stat ' + errs.length + ' event log(s): ' + errs.slice(0, 3).join('; ') };
    else checks.events = { state: 'ok', detail: runNames.length + ' run folder(s); no events.jsonl written within ' + idleMin + ' min' };
  }

  // (3) another forge-sync run's lock. R4 / F09: the caller takes ITS OWN lock first and then runs this check (check-after-lock,
  // so no other sync can slip in between the verdict and the first write); its own lock — recognised by nonce AND pid — is ok.
  const lp = lockPathFor(dst);
  let checkedUnderLock = false;
  try {
    fs.lstatSync(lp);
    let info = null;
    try { info = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { /* unreadable lock content — still a lock */ }
    const own = opts.ownLock && info && typeof info === 'object' && info.nonce === opts.ownLock.nonce && info.pid === opts.ownLock.pid;
    if (own) { checkedUnderLock = true; checks.lock = { state: 'ok', detail: 'only this run\'s own .forge-sync.lock (taken before this check)' }; }
    else checks.lock = { state: 'busy', detail: '.forge-sync.lock present — another forge-sync run is in progress' + (info && info.pid ? ' (pid ' + info.pid + (info.ts ? ', since ' + info.ts : '') + ')' : '') };
  } catch (e) {
    checks.lock = e && e.code === 'ENOENT' ? { state: 'ok', detail: 'no .forge-sync.lock' } : { state: 'unknown', detail: 'could not check the lock (' + e.message + ')' };
  }

  // (4) live processes that name the project on their command line (structured listing; never kills anything)
  let list = null, listErr = null;
  try {
    list = (typeof opts.listProcesses === 'function' ? opts.listProcesses : listProcessesStructured)();
    if (!Array.isArray(list)) throw new Error('the process listing is not a list');
  } catch (e) { listErr = e && e.message ? e.message : String(e); }
  if (listErr) checks.processes = { state: 'unknown', detail: 'process listing unavailable (' + listErr + ') — unknown counts as NOT idle' };
  else {
    const selfPid = Number.isFinite(opts.selfPid) ? opts.selfPid : process.pid;
    const parentPid = Number.isFinite(opts.parentPid) ? opts.parentPid : (selfPid === process.pid ? process.ppid : null);
    const skip = ancestorPidSet(list, selfPid, parentPid);
    const variants = pathVariantsForMatch(abs);
    const hits = [], unknowns = [];
    let noCmd = 0, cwdChecked = 0;
    const cwdOf = typeof opts.processCwd === 'function' ? opts.processCwd : processCwd;
    const absFold = foldCase(path.resolve(abs));
    for (const p of list) {
      const pid = Number(p && p.pid);
      if (!Number.isFinite(pid) || skip.has(pid)) continue;
      const exeOf = () => { const first = String(p.cmd || '').trim().match(/^"([^"]+)"|^(\S+)/); return first ? path.basename(first[1] || first[2]) : (p.name || '?'); };
      // a process whose working directory the platform exposes (Linux) is matched by cwd too — `node worker.js`
      // started inside the project names it on no command line
      const cwd = cwdOf(pid);
      if (typeof cwd === 'string') { cwdChecked++; const cf = foldCase(path.resolve(cwd)); if (cf === absFold || cf.startsWith(absFold + path.sep)) { hits.push({ pid, exe: exeOf(), via: 'cwd' }); continue; } }
      if (p.cmd == null || p.cmd === '') {
        // an interpreter/tool/shell image whose command line cannot be read COULD be working in this project — unknown
        if (isSuspectImage(p.name)) unknowns.push({ pid, exe: p.name }); else noCmd++;
        continue;
      }
      if (commandLineMentions(p.cmd, variants)) hits.push({ pid, exe: exeOf(), via: 'cmdline' });
    }
    const cwdNote = process.platform === 'linux' ? ' (' + cwdChecked + ' working director' + (cwdChecked === 1 ? 'y' : 'ies') + ' checked)' : ' (working directories are not exposed on ' + process.platform + ' — a process started inside the project that does not name it on its command line is invisible here; the transcript check covers Claude Code sessions)';
    checks.processes = hits.length
      ? { state: 'busy', detail: hits.length + ' live process(es) name this project on their command line' + (hits.some((h) => h.via === 'cwd') ? ' or run inside it' : '') + ': ' + hits.slice(0, 6).map((h) => 'pid ' + h.pid + ' (' + h.exe + ')').join(', '), hits }
      : (unknowns.length
        ? { state: 'unknown', detail: unknowns.length + ' interpreter/tool process(es) whose command line cannot be read could be working in this project — unknown counts as NOT idle: ' + unknowns.slice(0, 6).map((u) => 'pid ' + u.pid + ' (' + u.exe + ')').join(', ') + ' (run elevated, or stop them, or pass --quiesce-override)', unknowns }
        : { state: 'ok', detail: list.length + ' process(es) listed, none names this project' + (noCmd ? ' (' + noCmd + ' without a readable command line — service/system images, counted, not inspected)' : '') + cwdNote, excluded: [...skip] });
  }
  // Category tests F9: ONLY-unknown processes (no command line readable, nothing naming this folder) do not
  // block a FIRST install into a bare dashboard scaffold: there is no app file and no Forge install in it that a running
  // process could be writing. A process that names the folder, a recent transcript or run, or a lock still blocks.
  // Only the "unreadable command line" kind of unknown (it carries `unknowns`); an unavailable process listing stays blocking.
  // the same holds for an UPDATE of an untouched fresh install (every file under .claude is one the receipt says
  // the installer wrote, with those bytes; no app file, no run file, no session file) — see isUntouchedFreshInstall.
  const onlyUnreadableElsewhere = checks.processes && checks.processes.state === 'unknown' && Array.isArray(checks.processes.unknowns) && Object.keys(checks).every((k) => k === 'processes' || checks[k].state === 'ok');
  if (onlyUnreadableElsewhere && isBareScaffold(abs)) {
    checks.processes = { state: 'ok', detail: 'fresh scaffold (only CLAUDE.md / .gitignore and an empty .claude, no Forge install yet): ' + checks.processes.unknowns.length + ' unreadable interpreter process(es) elsewhere cannot be writing into it', unknowns: checks.processes.unknowns };
  } else if (onlyUnreadableElsewhere && isUntouchedFreshInstall(abs)) {
    checks.processes = { state: 'ok', detail: 'untouched fresh install (only CLAUDE.md / .gitignore and the files the last install wrote, unchanged; no run, no app file): ' + checks.processes.unknowns.length + ' unreadable interpreter process(es) elsewhere cannot be writing into it', unknowns: checks.processes.unknowns };
  }
  const states = Object.keys(checks).map((k) => checks[k].state);
  return {
    schema: 'forge-sync-quiesce/v1', idle: states.every((s) => s === 'ok'), unknown: states.includes('unknown'), idleMin,
    projectPath: abs, checkedAt: iso(nowMs), checks, checkedUnderLock,
    reasons: Object.keys(checks).filter((k) => checks[k].state !== 'ok').map((k) => k + ' ' + checks[k].state.toUpperCase() + ': ' + checks[k].detail),
  };
}
/** isBareScaffold(dir) -> true when dir holds nothing but what the dashboard's New project scaffold writes (CLAUDE.md,
 *  .gitignore) plus a .claude folder with no Forge install (no forge-bin/forge-sync.cjs) and only scaffold or earlier
 *  rolled-back sync leftovers (empty folders, forge-sync-report-*.md, backup folders). */
function isBareScaffold(dir) {
  let top;
  try { top = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of top) {
    if (e.isFile() && (e.name === 'CLAUDE.md' || e.name === '.gitignore')) continue;
    if (e.isDirectory() && e.name === '.claude') continue;
    return false;
  }
  const cd = path.join(dir, '.claude');
  if (fs.existsSync(path.join(cd, 'forge-bin', 'forge-sync.cjs')) || fs.existsSync(path.join(cd, 'forge-sync-receipt.json'))) return false;
  // .forge-sync.lock: the installer takes its own lock BEFORE the quiesce check (check-after-lock), so it is always there
  const okFile = (rel) => rel === '.forge-sync.lock' || /^forge-sync-report-[^/]+\.md$/.test(rel) || /^forge-backups(-central)?\//.test(rel);
  const walk = (d, rel) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of es) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) return false;
      if (e.isDirectory()) { if (!walk(path.join(d, e.name), r)) return false; } else if (!okFile(r)) return false;
    }
    return true;
  };
  return walk(cd, '');
}
/** isUntouchedFreshInstall(dir) -> true when dir holds a Forge install nobody has used yet (category tests F10): the top
 *  level has only CLAUDE.md / .gitignore / .claude, and every file under .claude is one the installer itself wrote, judged by the
 *  receipt and not by name guessing: a file the receipt records (knownHashes, or filesChanged.newHash) with exactly those bytes,
 *  the settings.json its doctor judged (settingsJudged.sha256), or the sync's own bookkeeping (the receipt, FORGE_VERSION.json, the
 *  lock, forge-sync-report-*.md, forge-backups/ and forge-backups-central/). So any app file, any run folder file (an events.jsonl),
 *  any changed Forge file and any file a session wrote makes it false. Without a readable receipt it is false. Stated limit: a seed
 *  file is recognised only through the latest receipt's filesChanged, so after a later update that did not rewrite it the folder
 *  no longer counts as fresh (fail-safe: it then blocks as before). */
function isUntouchedFreshInstall(dir) {
  let top;
  try { top = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of top) {
    if (e.isFile() && (e.name === 'CLAUDE.md' || e.name === '.gitignore')) continue;
    if (e.isDirectory() && e.name === '.claude') continue;
    return false;
  }
  const cd = path.join(dir, '.claude');
  if (lstatKind(receiptPath(dir)) !== 'other' || lstatKind(versionFilePath(dir)) !== 'other') return false; // a real entry, never a link
  const receipt = readReceipt(dir);
  if (!receipt || typeof receipt !== 'object' || !receipt.knownHashes || typeof receipt.knownHashes !== 'object') return false;
  const expected = new Map();
  for (const rel of Object.keys(receipt.knownHashes)) if (typeof receipt.knownHashes[rel] === 'string') expected.set(rel, new Set([receipt.knownHashes[rel]]));
  for (const f of Array.isArray(receipt.filesChanged) ? receipt.filesChanged : []) {
    if (!f || typeof f.rel !== 'string' || typeof f.newHash !== 'string') continue;
    if (!expected.has(f.rel)) expected.set(f.rel, new Set());
    expected.get(f.rel).add(f.newHash);
  }
  const sj = receipt.settingsJudged;
  if (sj && sj.kind === 'ok' && typeof sj.sha256 === 'string') expected.set('settings.json', new Set([sj.sha256]));
  const bookkeeping = (rel) => rel === 'forge-sync-receipt.json' || rel === 'FORGE_VERSION.json' || rel === '.forge-sync.lock'
    || /^forge-sync-report-[^/]+\.md$/.test(rel) || /^forge-backups(-central)?\//.test(rel);
  const walk = (d, rel) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of es) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) return false;
      if (e.isDirectory()) { if (!walk(path.join(d, e.name), r)) return false; continue; }
      if (bookkeeping(r)) continue;
      const want = expected.get(r);
      if (!want || !e.isFile()) return false;
      const h = sha256(path.join(d, e.name));
      if (!h || !want.has(h)) return false;
    }
    return true;
  };
  return walk(cd, '');
}
/** quiesceRecord(quiesce, override) — the compact form that goes into the receipt and the report. */
function quiesceRecord(quiesce, override) {
  if (!quiesce && !override) return null;
  return {
    idle: !!(quiesce && quiesce.idle), checkedAt: quiesce ? quiesce.checkedAt : null, idleMin: quiesce ? quiesce.idleMin : null,
    checkedUnderLock: !!(quiesce && quiesce.checkedUnderLock), // the check ran AFTER this run took the project lock
    reasons: quiesce ? quiesce.reasons : ['no quiesce check result was supplied'], override: override || null,
  };
}

// ---- protect-manifest -------------------------------------------------------------------------------------
const PROTECT_SCHEMA = 'forge-sync-protect/v1';
const PROTECT_ROOT_FILES = ['CLAUDE.md', 'AGENTS.md', '.gitignore'];
const PROTECT_NOT_WALKED = new Set(['forge-backups', 'forge-backups-central']); // the sync's own backups (top of .claude)
const PROTECT_SKIP_DIR_NAMES = new Set(['node_modules', '.git']); // recorded as present, not descended into
// WP-SYNC-R8 (measured 2026-10-10 on the 26H2 project: .claude/worktrees held 98 folders, 93 of them full git checkouts,
// about 3.2 million files, 29.5 GB): .claude/worktrees/ holds agent scratch CHECKOUTS (`git worktree add`), never a shipped
// file and never application code of the main tree. Hashing it file by file would have taken hours. It is recorded as ONE
// entry and never descended into: {kind:'skipped-dir', summarized:true, count, names, namesHash} — the sorted names of its
// immediate children (suffix '/' = folder, '@' = link, '?' = other) and their count, from ONE readdir, no file read. A child
// that appears, vanishes or changes kind is a change; an edit INSIDE a checkout is not seen (stated limit). verifyProtect
// recomputes with exactly the folders the "before" manifest summarized (summarizedDirs; an older manifest without that field
// is recomputed the old, walking way), and only names in this set can ever be summarized, so no manifest file can turn a
// memory folder (agent-memory, forge-runs, forge-scribe, ...) into an unhashed one.
// WP-SYNC-R10: the WHOLE-folder summary above hid more than checkouts — a plain folder or file
// directly under .claude/worktrees (26H2: 5 of its 98 children had no .git) was covered by NAME only, so `.claude/agent-memory` as a
// junction into `.claude/worktrees/shared-memory` could change without the manifest moving. Now only a child that holds a `.git`
// entry (a real checkout) is summarized, as ONE entry {kind:'skipped-dir', summarized:true, checkout:true, git} — `git` identifies
// its .git entry (the hash of a worktree's small `gitdir:` FILE, 'dir' for a clone, the link target), so swapping checkout A for B
// under one name is a change too. Every OTHER child (a plain folder, a file, a link) is walked and hashed exactly like the rest of
// .claude (node_modules/.git still skipped). `.claude/worktrees` itself must be a real folder: a link or a file of that name is
// recorded as what it is (symlink / file), never walked through. Manifests say which mode they used: `checkoutDirs` (this one);
// `summarizedDirs` (the R8 whole-folder mode, still honoured when a "before" manifest written by R8 is verified, symmetric by
// construction); neither (pre-R8: everything walked). And a never-touch / memory path under .claude that is a link or junction
// RESOLVING INTO .claude/worktrees is refused loudly (buildProtectManifest throws): memory never lives in agent-checkout territory.
const PROTECT_SUMMARIZED = new Set(['worktrees']);
const PROTECT_SUMMARY_NAMES_MAX = 1000; // names KEPT for reading; the comparison uses count + namesHash over ALL of them
const PROTECT_CHECKOUT_GIT_FILE_MAX = 65536; // a worktree's .git FILE is one "gitdir: <path>" line; larger is recorded by size only
/** protectCheckoutEntry(dirAbs) -> the one entry of an agent checkout (a child of .claude/worktrees holding a .git entry); no file of
 *  the checkout is read except its small .git pointer FILE. Unreadable -> {kind:'unreadable', code, syscall, mtimeMs,
 *  failClosed:'checkout'} (never equal and, WP-SYNC-R13, never "not comparable" either — a checkout that cannot be identified stays
 *  fail closed: a PERMANENT violation while its .git probe keeps failing, intended). WP-SYNC-R14: a .git LINK whose
 *  target cannot be read is such a checkout too — it used to be git 'link:null', and two failed reads compared equal, so a checkout
 *  swapped behind the link passed. */
function protectCheckoutEntry(dirAbs) {
  const g = path.join(dirAbs, '.git');
  const failed = (e, st) => Object.assign(protectUnreadableEntry(e, g, st), { failClosed: 'checkout' });
  let st;
  try { st = fs.lstatSync(g); } catch (e) { return failed(e, null); }
  let git;
  if (st.isSymbolicLink()) { try { git = 'link:' + fs.readlinkSync(g); } catch (e) { return failed(e, st); } }
  else if (st.isDirectory()) git = 'dir';
  else if (st.isFile()) {
    if (st.size > PROTECT_CHECKOUT_GIT_FILE_MAX) git = 'file-size:' + st.size;
    else { try { git = 'file:' + crypto.createHash('sha256').update(fs.readFileSync(g)).digest('hex'); } catch (e) { return failed(e, st); } }
  } else git = 'other';
  return { kind: 'skipped-dir', summarized: true, checkout: true, git };
}
/** linkIntoWorktrees(linkAbs, claudeAbs) -> the resolved target when the link/junction at linkAbs resolves INTO
 *  <claudeAbs>/worktrees (or onto it), else null. Both the literal target and the fully resolved real path are checked, against
 *  the lexical and the real path of the worktrees folder, compared case-folded where the file system ignores case. */
function linkIntoWorktrees(linkAbs, claudeAbs) {
  const wt = path.join(claudeAbs, 'worktrees');
  const real = (p) => { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return null; } };
  const roots = [wt, real(wt), real(claudeAbs) ? path.join(real(claudeAbs), 'worktrees') : null].filter(Boolean);
  const cands = [];
  try { cands.push(path.resolve(path.dirname(linkAbs), fs.readlinkSync(linkAbs))); } catch { /* not readable as a link */ }
  const r = real(linkAbs);
  if (r) cands.push(r);
  for (const c of cands) {
    for (const root of roots) {
      const rel = path.relative(foldCase(path.resolve(root)), foldCase(path.resolve(c)));
      if (rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))) return c;
    }
  }
  return null;
}
/** linkResolvesOutside(linkAbs, projectAbs) -> {outside: <path>} | {unknown: <reason>} | {} — WP-SYNC-R14: where a
 *  link/junction points. Judged on its fully resolved REAL path (where its content really lives — a literal target spelled through
 *  another alias or an 8.3 short name that lands inside the project is inside); only a link that cannot be resolved (dangling) is
 *  judged on its literal target, resolved against the link's folder. Compared with the lexical and the real project root,
 *  case-folded where the file system ignores case. Neither readable is unknown. Never reads what is behind the link. */
function linkResolvesOutside(linkAbs, projectAbs) {
  const real = (p) => { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return null; } };
  const roots = [path.resolve(projectAbs), real(projectAbs)].filter(Boolean);
  const inside = (c) => roots.some((root) => { const rel = path.relative(foldCase(path.resolve(root)), foldCase(path.resolve(c))); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); });
  const r = real(linkAbs);
  if (r) return inside(r) ? {} : { outside: r };
  let lit;
  try { lit = path.resolve(path.dirname(linkAbs), fs.readlinkSync(linkAbs)); } catch (e) { return { unknown: ((e && e.code) || 'error') + ' on readlink, and the path cannot be resolved either' }; }
  return inside(lit) ? {} : { outside: lit + ' (dangling)' };
}
/** PROTECT_FLOOR_LITERALS_LC — the never-touch floor's literal .claude-relative paths (lower-cased), for "is this link ABOVE one". */
const PROTECT_FLOOR_LITERALS_LC = [...NEVER_TOUCH_FILES, ...PROTECT].map((s) => s.toLowerCase());
/** protectLinkGuardsFloor(rel) — WP-SYNC-R14: true when a link at this .claude-relative path sits AT a never-touch /
 *  memory path (isNeverTouch / isNeverTouchDir: agent-memory, forge-scribe, forge-runs/<run>, FORGE_MEMORY*, ...) or ABOVE one of the
 *  floor's literal paths (config -> config/forge-overrides.json, config/orchestration -> .../FORGE_CONTEXT_BUDGET.json, ...). Stated
 *  limit: the floor's NAME patterns (.env*, *.user.json, secrets/, FORGE_MEMORY* at any depth) can occur below any folder; for those
 *  only a link that itself carries such a name is judged. */
function protectLinkGuardsFloor(rel) {
  const r = String(rel == null ? '' : rel).split('\\').join('/');
  if (isNeverTouch(r) || isNeverTouchDir(r)) return true;
  const below = r.toLowerCase() + '/';
  return PROTECT_FLOOR_LITERALS_LC.some((f) => f.startsWith(below));
}
/** protectLinkRefusal(linkAbs, rel, claudeAbs, projectAbs) -> null | why buildProtectManifest refuses a link/junction under .claude
 *  that is NOT inside the .claude/worktrees tree (links in there are no alias of memory and are recorded as before). A link is
 *  recorded by its target only and never followed, so whatever lives behind it is never inventoried:
 *   - WP-SYNC-R10 / WP-SYNC-R14: ANY link that resolves into .claude/worktrees is refused. Conservative on
 *     purpose: a FOLDER link such as .claude/config -> .claude/worktrees/<x>/config hides the never-touch files below it even though
 *     its own name is not on the floor, and inside a checkout nothing is recorded at all (it used to be refused only when the link's
 *     own name was never-touch);
 *   - WP-SYNC-R14: a link AT or ABOVE a never-touch / memory path (protectLinkGuardsFloor) that resolves OUTSIDE the
 *     project, or whose target cannot be told at all, is refused (R10 recorded such a memory link by its target).
 *  Any other link (a shared docs folder outside the project, say) is still recorded by its target. */
function protectLinkRefusal(linkAbs, rel, claudeAbs, projectAbs) {
  const into = linkIntoWorktrees(linkAbs, claudeAbs);
  if (into) {
    return 'is a link/junction that resolves into .claude/worktrees (' + into + ') — project memory and never-touch data may not live in the agent-checkout folder, '
      + 'and a link is recorded by its target only (a checkout there by its name only), so what it holds — or anything below it — could change unseen; make it a real folder/file again';
  }
  if (!protectLinkGuardsFloor(rel)) return null;
  const where = linkResolvesOutside(linkAbs, projectAbs);
  if (where.unknown) return 'is a link/junction at or above a never-touch / memory path whose target cannot be told (' + where.unknown + ') — fail closed; make it a real folder/file again';
  if (where.outside) {
    return 'is a link/junction at or above a never-touch / memory path that resolves outside the project (' + where.outside + ') — what it holds is never inventoried '
      + '(a link is recorded by its target only, never followed), so a change there could not be seen; make it a real folder/file inside the project again';
  }
  return null;
}
/** protectSummaryFor(dirAbs) -> the one entry of a summarized folder (see PROTECT_SUMMARIZED); unreadable ->
 *  {kind:'unreadable', failClosed:'summary'} (never equal to anything, never "not comparable" — fail closed, as before R13). */
function protectSummaryFor(dirAbs) {
  let list;
  try { list = fs.readdirSync(dirAbs, { withFileTypes: true }); }
  catch (e) { return { kind: 'unreadable', error: e.message, failClosed: 'summary' }; }
  const names = list.map((e) => e.name + (e.isSymbolicLink() ? '@' : (e.isDirectory() ? '/' : (e.isFile() ? '' : '?')))).sort();
  const out = { kind: 'skipped-dir', summarized: true, count: names.length, namesHash: sha256Str(names.join('\n')), names: names.slice(0, PROTECT_SUMMARY_NAMES_MAX) };
  if (names.length > PROTECT_SUMMARY_NAMES_MAX) out.namesTruncated = true;
  return out;
}
/** summarizeSetFrom(list) — the allow-listed, case-folded subset of folder names (`worktrees` or `.claude/worktrees/`). */
function summarizeSetFrom(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const n = foldCase(String(raw == null ? '' : raw).split('\\').join('/').replace(/^\.claude\//i, '').replace(/\/+$/, ''));
    if (PROTECT_SUMMARIZED.has(n)) out.add(n);
  }
  return out;
}
const ENV_FILE_RE = /^\.env(\..*)?$/i;
const APP_SUBTREE_MAX_DEPTH = 4; // submodules inside submodules are inventoried this deep, deeper is guarded:'partial'
/** isSecretLikeRel(rel) — files whose CONTENT the protect manifest must never read: only size + modified time are
 *  recorded (.env*, .credentials.json, key material, anything under a secrets/ folder). */
function isSecretLikeRel(rel) {
  const segs = String(rel).split('/');
  const base = segs[segs.length - 1];
  return ENV_FILE_RE.test(base) || base === '.credentials.json' || /\.(key|pem|p12|pfx)$/i.test(base)
    || /^id_(rsa|dsa|ecdsa|ed25519)/i.test(base) || segs.includes('secrets');
}
/** protectAllowance(key) -> 'any' | 'add-only' | null — the sync's own bookkeeping, the ONLY protected-territory paths an
 *  install may write without a record in its batch. 'any': receipt, FORGE_VERSION.json, settings.json (its own
 *  ledger covers it), the lock, an atomic-write temp file. 'add-only': a NEW settings .forge-bak, a settings
 *  recommended-copy (written on a refused merge) or a forge-sync report — an existing one changing or vanishing still
 *  counts. forge-backups/ and forge-backups-central/ are never walked at all. */
function protectAllowance(key) {
  // compared case-insensitively on Windows/macOS (`.claude/Settings.json` IS settings.json there)
  const k = foldCase(key);
  if (['.claude/forge-sync-receipt.json', '.claude/FORGE_VERSION.json', '.claude/settings.json', '.claude/.forge-sync.lock'].some((x) => foldCase(x) === k)) return 'any';
  if (/^\.claude\/[^/]+\.\d+\.[a-z0-9]+\.tmp$/.test(k)) return 'any';
  if (/^\.claude\/settings\.json\.forge-bak-[^/]+$/.test(k) || /^\.claude\/settings\.forge-recommended-[^/]+\.json$/.test(k) || /^\.claude\/forge-sync-report-[^/]+\.md$/.test(k)) return 'add-only';
  return null;
}
/** protectUnreadableEntry(err, abs, st) — WP-SYNC-R13: the entry of a path the protect manifest could not read (a folder it
 *  could not list, a file it could not open, a path it could not lstat): {kind:'unreadable', error, code, syscall, mtimeMs, size?}.
 *  `code` / `syscall` come from the error object (what protectUnreadableSame compares — never the message, which carries the
 *  absolute path); `mtimeMs` is the lstat modified time where lstat works (null = it failed too) and a regular file also gets its
 *  `size`. st: undefined = lstat it here; null = lstat is known to have failed; a Stats object = use that one. */
function protectUnreadableEntry(err, abs, st) {
  const out = {
    kind: 'unreadable', error: err && err.message ? String(err.message) : String(err),
    code: err && typeof err.code === 'string' && err.code ? err.code : null,
    syscall: err && typeof err.syscall === 'string' && err.syscall ? err.syscall : null,
  };
  let s = st;
  if (s === undefined) { try { s = fs.lstatSync(abs); } catch { s = null; } }
  out.mtimeMs = s && Number.isFinite(s.mtimeMs) ? s.mtimeMs : null;
  if (s && s.isFile()) out.size = s.size;
  return out;
}
/** protectEntryFor(abs, rel) — one manifest entry: {kind:'file', size, hash} | {kind:'meta', size, mtimeMs} (secret-like,
 *  content never read) | {kind:'symlink', target} (never followed) | {kind:'dir'} | {kind:'absent'} | {kind:'other'} |
 *  {kind:'unreadable', error, code, syscall, mtimeMs, size?} (WP-SYNC-R13, see protectUnreadableEntry). WP-SYNC-R14:
 *  a link whose target cannot be read is unreadable (syscall 'readlink'), never {kind:'symlink', target:null} — two failed reads
 *  compared equal, so a link retargeted in between passed; now such a pair is a violation outside .claude/worktrees/<name>/ and
 *  "not comparable" inside it, exactly like every other unreadable entry (protectUnreadableSame). */
function protectEntryFor(abs, rel) {
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { return e && e.code === 'ENOENT' ? { kind: 'absent' } : protectUnreadableEntry(e, abs, null); }
  if (st.isSymbolicLink()) { try { return { kind: 'symlink', target: fs.readlinkSync(abs) }; } catch (e) { return protectUnreadableEntry(e, abs, st); } }
  if (st.isDirectory()) return { kind: 'dir' };
  if (!st.isFile()) return { kind: 'other' };
  if (isSecretLikeRel(rel)) return { kind: 'meta', size: st.size, mtimeMs: st.mtimeMs };
  try { return { kind: 'file', size: st.size, hash: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') }; }
  catch (e) { return protectUnreadableEntry(e, abs, st); }
}
/** buildProtectManifest(templateDir, projectDir, opts) -> the inverse manifest: EVERY file and folder under
 *  <project>/.claude that this template does not ship (listSystemFiles minus the project's forge-overrides.json), plus the
 *  root CLAUDE.md, AGENTS.md, .gitignore (recorded as `absent` when missing, so a creation is visible) and every root
 *  .env* file (size + modified time only). That covers per-project memory (agent-memory/**, FORGE_MEMORY.md, ...),
 *  forge-runs/**, seed-only files, never-touch paths, the project's own skills/commands and *.user.json overlays by
 *  construction — nothing has to be listed by hand. Not walked: forge-backups/, forge-backups-central/ (the sync's own
 *  backups), node_modules/ and .git/ folders (recorded as present), and every agent CHECKOUT directly under .claude/worktrees/
 *  (WP-SYNC-R10: a child holding a .git entry — one entry each, see PROTECT_SUMMARIZED; every other child is walked).
 *  opts: shippedRels + exactShipped (reuse a recorded list instead of reading the template), selfPath (the manifest file itself,
 *  skipped when it sits in the project), checkoutDirs (WP-SYNC-R10; default: every PROTECT_SUMMARIZED name — the folders whose
 *  checkout children are summarized), summarizeDirs (the R8 whole-folder mode; default none — only verifyProtect passes it, for a
 *  "before" manifest written by R8), nowIso. Throws when the project has no .claude/, the template cannot be read, or a
 *  never-touch / memory path is a link resolving into .claude/worktrees (fail closed, loud). */
function buildProtectManifest(templateDir, projectDir, opts) {
  opts = opts || {};
  const abs = path.resolve(projectDir);
  const dst = claudeDirOf(abs);
  if (isSymlinkPath(dst)) throw new Error(dst + ' is itself a symlink/junction — its contents live outside the project, so nothing can be protected (or synced) through it');
  if (!isDirectory(dst)) throw new Error('not a project (.claude missing or not a plain folder): ' + abs);
  if (!Array.isArray(opts.shippedRels) && !templateDir) throw new Error('a template (or a recorded shipped list) is required to know what is NOT shipped');
  const overrides = readOverrideAllowlist(abs);
  const shippedList = Array.isArray(opts.shippedRels) ? opts.shippedRels : listSystemFiles(templateDir);
  const shipped = new Set(opts.exactShipped ? shippedList : shippedList.filter((rel) => !overrides.has(normKey(rel)))); // R4 / F13
  // on Windows/macOS a project file that differs from a shipped path only in case IS that shipped file (the
  // sync writes it, drift-gated by preflight) — compare folded, so it is neither double-counted nor a false violation
  const shippedFold = new Set([...shipped].map(foldCase));
  const selfAbs = opts.selfPath ? path.resolve(opts.selfPath) : null;
  // WP-SYNC-R8 (legacy whole-folder mode) and WP-SYNC-R10 (checkout mode, the default). Only PROTECT_SUMMARIZED names can ever be
  // in either set, whatever is asked — no option and no manifest file can turn a memory folder into an unhashed one.
  const summarize = summarizeSetFrom(Array.isArray(opts.summarizeDirs) ? opts.summarizeDirs : []);
  const checkoutParents = summarizeSetFrom(Array.isArray(opts.checkoutDirs) ? opts.checkoutDirs : [...PROTECT_SUMMARIZED]);
  const entries = {};
  for (const name of PROTECT_ROOT_FILES) entries[name] = protectEntryFor(path.join(abs, name), name);
  let rootNames = [];
  try { rootNames = fs.readdirSync(abs); } catch { /* unreadable root: the .claude walk below still runs */ }
  for (const name of rootNames) {
    if (!ENV_FILE_RE.test(name)) continue;
    const e = protectEntryFor(path.join(abs, name), name);
    if (e.kind !== 'absent') entries[name] = e;
  }
  const walk = (dirAbs, rel) => {
    let list;
    try { list = fs.readdirSync(dirAbs, { withFileTypes: true }); }
    catch (e) { entries[rel ? '.claude/' + rel : '.claude'] = protectUnreadableEntry(e, dirAbs); return; } // WP-SYNC-R13: code, syscall, lstat time
    for (const e of list) {
      const r = rel ? rel + '/' + e.name : e.name;
      const key = '.claude/' + r;
      const p = path.join(dirAbs, e.name);
      if (selfAbs && foldCase(path.resolve(p)) === foldCase(selfAbs)) continue;
      if (!rel && PROTECT_NOT_WALKED.has(foldCase(e.name))) continue; // folded (the set holds lower-case names)
      // WP-SYNC-R8 (legacy mode only): a real folder (not a link — a link is recorded by its target below, never followed) at the top of .claude
      if (!rel && e.isDirectory() && !e.isSymbolicLink() && summarize.has(foldCase(e.name))) { entries[key] = protectSummaryFor(p); continue; }
      // WP-SYNC-R10: a real CHECKOUT (a folder holding a .git entry) directly under a real .claude/worktrees: one entry, never descended.
      // WP-SYNC-R13B: a child whose .git probe FAILED (not ENOENT) counts too — protectCheckoutEntry then records it
      // fail closed ({kind:'unreadable', failClosed:'checkout'}); it is never walked as a plain folder.
      if (rel && e.isDirectory() && !e.isSymbolicLink() && !rel.includes('/') && checkoutParents.has(foldCase(rel)) && hasGitEntry(p)) { entries[key] = protectCheckoutEntry(p); continue; }
      if (protectAllowance(key) === 'any') continue;
      if (e.isDirectory() && !e.isSymbolicLink()) {
        if (PROTECT_SKIP_DIR_NAMES.has(foldCase(e.name))) { entries[key] = { kind: 'skipped-dir' }; continue; }
        entries[key] = { kind: 'dir' };
        walk(p, r);
        continue;
      }
      if (shippedFold.has(foldCase(r)) && !e.isSymbolicLink()) continue;
      entries[key] = protectEntryFor(p, r);
      // WP-SYNC-R10 / WP-SYNC-R14: a link or junction outside the .claude/worktrees tree is refused when
      // it resolves INTO that tree (any link — not only one whose own name is never-touch), or when it sits at or above a never-touch
      // / memory path and resolves outside the project (protectLinkRefusal). A link whose target could not be read (R14-01: an
      // unreadable entry, syscall 'readlink') is judged the same way, through its resolved real path. Links that are themselves
      // inside .claude/worktrees are not aliases of memory and are recorded as before.
      const linkHere = e.isSymbolicLink() || entries[key].kind === 'symlink' || (entries[key].kind === 'unreadable' && entries[key].syscall === 'readlink');
      if (linkHere && !PROTECT_SUMMARIZED.has(foldCase(r.split('/')[0]))) {
        const refusal = protectLinkRefusal(p, r, dst, abs);
        if (refusal) throw new Error('refusing: ' + key + ' ' + refusal);
      }
    }
  };
  walk(dst, '');
  // WP 2.1: the project's .forge/ state root (only when it exists and sits inside the project, outside .claude/ — a state
  // root inside .claude/ is already covered by the walk above). Every entry is keyed '.forge/...'; nothing is followed.
  const stateRoot = stateRootOf(abs);
  const stateRootRel = stateRoot.present && isPlainRel(stateRoot.rel) && foldCase(stateRoot.rel.split('/')[0]) !== '.claude' ? stateRoot.rel : null;
  if (stateRootRel) walkStateRoot(stateRoot.abs, stateRootRel, entries);
  const sorted = {};
  const counts = { total: 0 };
  for (const k of Object.keys(entries).sort()) { sorted[k] = entries[k]; counts.total++; counts[entries[k].kind] = (counts[entries[k].kind] || 0) + 1; }
  // the application code outside .claude/ is guarded through git (HEAD + status + content hashes). Folders
  // the sync itself may write outside .claude/ (a central backup root inside the project) and the manifest file itself
  // are excluded. opts.git === false skips it (the recompute in verifyProtect only runs it when the "before" side had it).
  const gitExclude = [];
  for (const extra of [opts.selfPath, opts.centralBackupRoot]) {
    if (!extra) continue;
    const rel = path.relative(abs, path.resolve(extra)).split(path.sep).join('/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) gitExclude.push(rel);
  }
  for (const g of Array.isArray(opts.gitExclude) ? opts.gitExclude : []) if (isPlainRel(g) && !gitExclude.includes(g)) gitExclude.push(g);
  const gitState = opts.git === false ? null : appCodeGitState(abs, gitExclude, { ignoredExclude: opts.gitIgnoredExclude });
  return {
    schema: PROTECT_SCHEMA, createdAt: opts.nowIso || new Date().toISOString(), projectPath: abs,
    templateDir: templateDir ? path.resolve(templateDir) : null, selfPath: selfAbs,
    shippedRels: [...shipped].sort(), overrides: [...overrides].sort(),
    notWalked: [...PROTECT_NOT_WALKED].map((n) => '.claude/' + n + '/').concat(stateRootRel ? [...STATE_ROOT_NOT_WALKED].map((n) => stateRootRel + '/' + n + '/') : []),
    ...(stateRootRel ? { stateRoot: stateRootRel } : {}), // WP 2.1: present only when the project has a .forge/ state root
    summarizedDirs: [...summarize].sort().map((n) => '.claude/' + n + '/'), // WP-SYNC-R8 legacy mode: one entry each, child list only
    checkoutDirs: [...checkoutParents].sort().map((n) => '.claude/' + n + '/'), // WP-SYNC-R10: their CHECKOUT children are one entry each
    counts, entries: sorted,
    git: gitState, gitExclude,
  };
}
/** stateRootOf(projectDir) -> {rel, abs, present, layout} — the project's opt-in state root (WP 2.1): forge-paths' answer
 *  (FORGE_STATE_DIR honoured) when forge-paths.cjs is there, else <project>/.forge. present = it is a real folder. */
function stateRootOf(projectDir) {
  const root = path.resolve(projectDir);
  let abs = path.join(root, '.forge'), layout = null;
  if (forgePathsMod) { try { const d = forgePathsMod.stateDirFor(root, 'state_root'); abs = d.forge; layout = d.layout; } catch { /* the plain default */ } }
  const present = isDirectory(abs) && !isSymlinkPath(abs);
  return { rel: path.relative(root, abs).split(path.sep).join('/'), abs, present: present || isSymlinkPath(abs), layout: layout || (present ? 'forge' : 'legacy') };
}
/** walkStateRoot(rootAbs, relBase, entries) — records every file and folder below the state root as protect entries keyed
 *  relBase/...; a link is recorded by its target, never followed; node_modules/.git folders as present only; its backups
 *  folder is not walked. */
function walkStateRoot(rootAbs, relBase, entries) {
  if (isSymlinkPath(rootAbs)) { entries[relBase] = protectEntryFor(rootAbs, relBase); return; }
  entries[relBase] = { kind: 'dir' };
  const walk = (dirAbs, rel) => {
    let list;
    try { list = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (e) { entries[rel] = protectUnreadableEntry(e, dirAbs); return; }
    for (const e of list) {
      const r = rel + '/' + e.name;
      const p = path.join(dirAbs, e.name);
      if (rel === relBase && STATE_ROOT_NOT_WALKED.has(foldCase(e.name))) continue;
      if (e.isDirectory() && !e.isSymbolicLink()) {
        if (PROTECT_SKIP_DIR_NAMES.has(foldCase(e.name))) { entries[r] = { kind: 'skipped-dir' }; continue; }
        entries[r] = { kind: 'dir' };
        walk(p, r);
        continue;
      }
      entries[r] = protectEntryFor(p, r);
    }
  };
  walk(rootAbs, relBase);
}
function writeProtectManifest(manifest, outFile) {
  const out = path.resolve(outFile);
  if (isDirectory(out)) throw new Error('--out points at a folder, not a file: ' + out);
  if (isSymlinkPath(out)) throw new Error('--out is a symlink — refusing to write through it: ' + out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeAtomic(out, JSON.stringify(manifest, null, 1) + '\n');
  return out;
}
function readProtectManifest(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!m || m.schema !== PROTECT_SCHEMA || !m.entries || typeof m.entries !== 'object' || !Array.isArray(m.shippedRels) || typeof m.projectPath !== 'string') {
    throw new Error(file + ' is not a ' + PROTECT_SCHEMA + ' manifest');
  }
  return m;
}
/** ancestorDirKeys(keys) — every folder key above each key ('.claude/a/b/c' -> '.claude', '.claude/a', '.claude/a/b'). */
function ancestorDirKeys(keys) {
  const out = new Set();
  for (const k of keys) { const segs = String(k).split('/'); for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('/')); }
  return out;
}
/** protectErrorCode(e) — WP-SYNC-R13: the error code of an unreadable entry: its recorded `code`, else the leading CODE of its
 *  message ('EPERM: operation not permitted, scandir ...' -> 'EPERM'; a manifest written before R13 has only the message). null =
 *  no code can be told. */
function protectErrorCode(e) {
  if (e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(e.code)) return e.code;
  const m = /^([A-Z][A-Z0-9_]{1,31})(?::|$)/.exec(String((e && e.error) || ''));
  return m ? m[1] : null;
}
/** protectErrorSyscall(e) — the failing operation of an unreadable entry: its recorded `syscall`, else the word after the first
 *  comma of a Node message ('EPERM: operation not permitted, scandir ...' -> 'scandir'). null = not recorded / not told. */
function protectErrorSyscall(e) {
  if (e && typeof e.syscall === 'string' && /^[a-z_]{1,32}$/.test(e.syscall)) return e.syscall;
  const m = /^[A-Z][A-Z0-9_]{1,31}: [^,]*, ([a-z_]{1,32})\b/.exec(String((e && e.error) || ''));
  return m ? m[1] : null;
}
/** protectNotComparableScope(key) -> true only for a key STRICTLY inside a child of .claude/worktrees ('.claude/worktrees/<name>/…')
 *  — WP-SYNC-R13B. That is agent-checkout territory: a real checkout there is ONE summary entry anyway (WP-SYNC-R10)
 *  and what lies below a stale non-checkout child is an agent's scratch (the 567 .NET scratch folders of the third 26H2 install).
 *  Everywhere else — project memory, the never-touch floor, every other .claude path, the root files, and .claude/worktrees itself
 *  or one of its direct children (whose kind cannot be told when it cannot be read) — a path unreadable in both readings is
 *  UNVERIFIABLE: nothing below it is recorded, so a change under it that leaves its own time alone would be unseen. A key with an
 *  empty, '.' or '..' segment or a backslash is never in scope. Compared case-folded where the file system ignores case. */
function protectNotComparableScope(key) {
  if (typeof key !== 'string' || !key) return false;
  const segs = key.split('/');
  if (segs.length < 4) return false;
  if (segs.some((s) => !s || s === '.' || s === '..' || s.includes('\\'))) return false;
  return foldCase(segs[0]) === '.claude' && PROTECT_SUMMARIZED.has(foldCase(segs[1]));
}
/** protectUnreadableSame(before, after, key) -> {same:true, code, syscall, mtimeCompared} | {same:false, why} — WP-SYNC-R13, narrowed
 *  by WP-SYNC-R13B (Codex R13-01..R13-04). A path unreadable in BOTH readings could not be hashed either time, so nothing can be
 *  proven changed or unchanged. It is "not comparable" (counted and reported as NOT verified, never a violation) only when ALL hold:
 *    - `key` lies strictly inside .claude/worktrees/<name>/ (protectNotComparableScope); anywhere else, and without a key, it is a
 *      change: "unverifiable protected path" (fail closed);
 *    - the error code is known on both sides and the same (EPERM == EPERM; the message text, which holds the absolute path, is
 *      never compared);
 *    - the failing operation is known on BOTH sides and the same (a folder that could not be listed is not a file that could not
 *      be opened; unknown on either side cannot be matched);
 *    - the size — compared on its own, whatever the time says — is absent in both readings or the same in both; recorded in one
 *      reading only is a change;
 *    - the lstat modified time is the same in both readings, or null in both (lstat failed both times: not compared). Recorded in
 *      one reading only, or moved, is a change — a locked folder whose time moved IS a change.
 *  The one stated exception: a "before" entry written by a manifest older than R13 carries only {kind, error} (no code, operation
 *  field, time or size — the real 26H2 pre-install3 manifest): its time is then not compared (mtimeCompared:false, said in the
 *  output); its size is still compared, so a pre-R13 unreadable FILE against a reading with a size is a change. An agent checkout
 *  / summarized folder that could not be read (failClosed) stays a change, as before R13. */
function protectUnreadableSame(b, a, key) {
  const no = (why) => ({ same: false, why });
  if (!b || !a || b.kind !== 'unreadable' || a.kind !== 'unreadable') return no('not unreadable on both sides');
  // WP-SYNC-R14: said in the output — a checkout whose .git probe fails in BOTH readings stays a violation for as long as it fails
  if (b.failClosed === 'checkout' && a.failClosed === 'checkout') {
    const lbl = (e) => (protectErrorCode(e) || 'no code') + (protectErrorSyscall(e) ? ' ' + protectErrorSyscall(e) : '');
    return no('an agent checkout whose .git probe failed in both readings (' + lbl(b) + ' / ' + lbl(a) + ') cannot be identified — a PERMANENT violation until its .git entry can be read again (intended: fail closed)');
  }
  if (b.failClosed || a.failClosed) return no('an agent checkout / summarized folder that cannot be read is never comparable (fail closed)');
  if (!protectNotComparableScope(key)) return no('unverifiable protected path — unreadable in both readings and not inside an agent folder (.claude/worktrees/<name>/): nothing below it was recorded, so a change there could not be seen (fail closed)');
  const cb = protectErrorCode(b), ca = protectErrorCode(a);
  if (!cb || !ca) return no('no error code was recorded, so the two readings cannot be matched');
  if (cb !== ca) return no('the error changed (' + cb + ' -> ' + ca + ')');
  const sb = protectErrorSyscall(b), sa = protectErrorSyscall(a);
  if (!sb || !sa) return no('the failing operation was not recorded in ' + (!sb && !sa ? 'either reading' : 'one reading') + ', so the two readings cannot be matched');
  if (sb !== sa) return no('the failing operation changed (' + sb + ' -> ' + sa + ')');
  const has = (e, k) => Object.prototype.hasOwnProperty.call(e, k);
  const sizeOf = (e) => (has(e, 'size') && e.size != null ? e.size : null);
  const zb = sizeOf(b), za = sizeOf(a);
  if (zb !== za) return no(zb === null || za === null ? 'its size was recorded in one reading only (' + (zb === null ? 'none' : zb) + ' -> ' + (za === null ? 'none' : za) + ')' : 'its size changed (' + zb + ' -> ' + za + ')');
  const preR13 = (e) => !has(e, 'code') && !has(e, 'syscall') && !has(e, 'mtimeMs') && !has(e, 'size');
  if (preR13(b)) return { same: true, code: cb, syscall: sb, mtimeCompared: false };
  // an R13 entry always carries mtimeMs (a number, or null when lstat failed); one without it is damaged — never "the same"
  if (!has(b, 'mtimeMs') || !has(a, 'mtimeMs')) return no(!has(b, 'mtimeMs') && !has(a, 'mtimeMs') ? 'neither reading carries its modified-time field (a damaged manifest entry), so the two readings cannot be matched' : 'its modified time was recorded in one reading only');
  const timeOf = (e) => (e.mtimeMs == null ? null : (Number.isFinite(e.mtimeMs) ? e.mtimeMs : NaN));
  const tb = timeOf(b), ta = timeOf(a);
  if (Number.isNaN(tb) || Number.isNaN(ta)) return no('its recorded modified time is not a number');
  if (tb === null && ta === null) return { same: true, code: cb, syscall: sb, mtimeCompared: false };
  if (tb === null || ta === null) return no('its modified time could be read in one reading only');
  if (tb !== ta) return no('its modified time changed (' + new Date(tb).toISOString() + ' -> ' + new Date(ta).toISOString() + ')');
  return { same: true, code: cb, syscall: sb, mtimeCompared: true };
}
/** protectUnreadableSummary(before, after, notComparable) — the counts the owner sees: how many entries could not be read (and so
 *  were not hashed) on each side, how many are not comparable, how many of those had their time compared, per error code. */
function protectUnreadableSummary(before, after, notComparable) {
  const count = (m) => (m && m.entries ? Object.keys(m.entries).filter((k) => m.entries[k] && m.entries[k].kind === 'unreadable').length : 0);
  const byCode = {};
  for (const n of notComparable) byCode[n.code] = (byCode[n.code] || 0) + 1;
  return { before: count(before), after: count(after), notComparable: notComparable.length, mtimeCompared: notComparable.filter((n) => n.mtimeCompared).length, byCode };
}
/** protectNotComparableLine(diff) -> null | one plain line about the entries that were unreadable on both sides. */
function protectNotComparableLine(diff) {
  const u = diff && diff.unreadable;
  if (!u || !u.notComparable) return null;
  const codes = Object.keys(u.byCode || {}).sort().map((c) => c + ' ' + u.byCode[c]).join(', ');
  const noTime = u.notComparable - u.mtimeCompared;
  return 'not comparable (unreadable on both sides): ' + u.notComparable + ' entr' + (u.notComparable === 1 ? 'y' : 'ies') + ' — the same error each time (' + codes + '); recorded, not hashed'
    + '; modified time compared for ' + u.mtimeCompared + (noTime ? ' (' + noTime + ' without a recorded time — a "before" manifest older than WP-SYNC-R13, or lstat failed both times)' : '');
}
/** protectCounts(diff) -> {inventoried, verified, summarized, changedBySync, notVerified, complete} — WP-SYNC-R13B,
 *  narrowed by WP-SYNC-R14: what an output may claim. inventoried = the "before" entries (`checked`); verified = the
 *  ones whose content was compared and equal, exactly as diffProtectManifests counted them; summarized = equal by a summary only;
 *  changedBySync = changes this sync recorded itself; notVerified = not comparable (unreadable on both sides); complete = no
 *  violation, all of them verified and the app code fully guarded. A verdict without these counts (the could-not-re-check shape, an
 *  older verdict) has verified NOTHING and is never complete — never "inventoried minus not verified" (that counted summaries and
 *  allowed changes as verified). */
function protectCounts(diff) {
  const d = diff || {};
  const num = (x) => (Number.isFinite(x) ? x : null);
  const inventoried = num(d.inventoried) !== null ? d.inventoried : (num(d.checked) !== null ? d.checked : 0);
  const notVerified = num(d.notVerified) !== null ? d.notVerified : (Array.isArray(d.notComparable) ? d.notComparable.length : 0);
  const exact = num(d.verified) !== null && num(d.summarized) !== null && num(d.changedBySync) !== null;
  return { inventoried, verified: exact ? d.verified : 0, summarized: exact ? d.summarized : 0, changedBySync: exact ? d.changedBySync : 0, notVerified, complete: exact && d.complete === true };
}
/** protectAppCoverage(appCode) -> the app-code coverage phrase printed next to every "unchanged" (WP-SYNC-R14):
 *  'guarded through git (N status entries, M ignored file(s) by name) — unchanged' | 'PARTIAL — <reason>' | 'NOT guarded (<reason>)'. */
function protectAppCoverage(app) {
  if (!app) return 'not checked';
  const changedPart = app.changed ? ' — ' + app.changed + ' CHANGED' : ' — unchanged';
  if (app.guarded === true) return 'guarded through git (' + app.files + ' status entr' + (app.files === 1 ? 'y' : 'ies') + (Number.isFinite(app.ignored) ? ', ' + app.ignored + ' ignored file(s) by name' : '') + ')' + changedPart;
  if (app.guarded === 'partial') return 'PARTIAL — ' + (app.reason || 'a probe could not run') + changedPart;
  return 'NOT guarded (' + (app.reason || 'unknown reason') + ')';
}
/** protectScopeVerdict(diff) -> 'VIOLATION' | 'nothing protected changed' | 'no violation detected within the verified scope (outside
 *  it: ...)' — WP-SYNC-R14: "nothing protected changed" only when every inventoried entry was verified and the app code
 *  was fully guarded; otherwise the claim is limited to what was verified, and what lies outside it is named. */
function protectScopeVerdict(diff) {
  const d = diff || {};
  if (!d.ok) return 'VIOLATION';
  const pc = protectCounts(d);
  if (pc.complete) return 'nothing protected changed';
  const outside = [];
  if (pc.notVerified) outside.push(pc.notVerified + ' NOT verified');
  if (pc.summarized) outside.push(pc.summarized + ' summarized');
  const g = d.appCode ? d.appCode.guarded : null;
  if (g !== true) outside.push('app code ' + (g === 'partial' ? 'partially guarded' : 'not guarded'));
  return 'no violation detected within the verified scope' + (outside.length ? ' (outside it: ' + outside.join(', ') + ')' : '');
}
/** protectInstallLine(verdict) — the install / sync-all line about the protected entries (WP-SYNC-R13B counts; WP-SYNC-R14: only the
 *  verified entries are "unchanged", summaries and not-comparable ones are counted apart, the app-code coverage stands next to it and
 *  the line ends with protectScopeVerdict). */
function protectInstallLine(pr) {
  const pc = protectCounts(pr);
  const allowedN = (pr.allowed || []).length;
  return 'protected entries: ' + pc.inventoried + ' inventoried · ' + pc.verified + ' verified after the last write — ' + (pr.ok ? 'unchanged' : 'VIOLATION')
    + (pc.summarized ? ' · ' + pc.summarized + ' summarized (presence / metadata only — content not compared)' : '')
    + (pc.notVerified ? ' · ' + pc.notVerified + ' NOT verified (unreadable on both sides — not comparable, never counted as unchanged)' : '')
    + (allowedN ? ' · ' + allowedN + ' change(s) this sync recorded itself (allowed)' : '')
    + ' · app code: ' + protectAppCoverage(pr.appCode) + ' → ' + protectScopeVerdict(pr);
}
/** protectReceiptRecord(verdict) — the receipt's `protect` record (WP-SYNC-R13B counts, WP-SYNC-R14 summarized / app code / complete). */
function protectReceiptRecord(v) {
  const pc = protectCounts(v);
  return { checked: v.checked, verified: pc.verified, summarized: pc.summarized, changedBySync: pc.changedBySync, notVerified: pc.notVerified, complete: pc.complete,
    appCode: v.appCode ? v.appCode.guarded : null, ok: v.ok, allowed: (v.allowed || []).length };
}
/** protectWhyLines(diff, max) -> 'why <key>: <reason>' for each CHANGED entry that carries a reason (an unreadable pair: another
 *  error, a moved time, an unverifiable protected path, ...), at most `max`, then a "+N more" line. */
function protectWhyLines(diff, max) {
  const whys = ((diff && diff.changed) || []).filter((c) => c && c.why);
  const out = whys.slice(0, max).map((c) => 'why ' + c.key + ': ' + c.why);
  if (whys.length > max) out.push('… +' + (whys.length - max) + ' more reason(s) (--json lists them)');
  return out;
}
function protectEntriesEqual(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  // "unreadable" before and after proves nothing about what happened in between — never EQUAL (fail closed).
  // WP-SYNC-R13: diffProtectManifests classifies such a pair first (protectUnreadableSame): "not comparable" or a change.
  if (a.kind === 'unreadable') return false;
  if (a.kind === 'file') return a.hash === b.hash && a.size === b.size;
  if (a.kind === 'meta') return a.size === b.size && a.mtimeMs === b.mtimeMs;
  if (a.kind === 'symlink') return a.target === b.target;
  // WP-SYNC-R8: a summarized folder (.claude/worktrees) is equal only with the same child count and the same child-name hash
  // WP-SYNC-R10: an agent CHECKOUT entry is equal only with the same .git identity (swapping checkout A for B under one name is a change)
  if (a.kind === 'skipped-dir' && (a.summarized || b.summarized)) return !!a.summarized === !!b.summarized && !!a.checkout === !!b.checkout && a.count === b.count && a.namesHash === b.namesHash && a.git === b.git;
  return true; // dir, skipped-dir, other
}
/** APP_UNREADABLE_PREFIX / appUnreadableMarker(err, op) — WP-SYNC-R14: the content the application-code guard records
 *  for a path it could NOT read: 'unreadable:<CODE>:<operation>' (EPERM:open, EACCES:lstat, EPERM:readlink, ...) — from the error's
 *  own code / syscall, `op` when it carries none. Structured so it is never mistaken for a state and never compared as one. */
const APP_UNREADABLE_PREFIX = 'unreadable:';
function appUnreadableMarker(err, op) {
  const code = err && typeof err.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(err.code) ? err.code : 'UNKNOWN';
  const sys = err && typeof err.syscall === 'string' && /^[a-z_]{1,32}$/.test(err.syscall) ? err.syscall : op;
  return APP_UNREADABLE_PREFIX + code + ':' + sys;
}
/** appEntryUnreadable(value) -> null | {code, syscall, legacy?} — WP-SYNC-R14: does this app-code entry (a status entry
 *  '<XY> <content>', a '(link) <rel>' entry's content, or a bare content) record a FAILED read? This version's marker, or the
 *  literal 'unreadable' / 'link ?' a manifest written before R14 recorded (legacy: true). Such an entry is never "unchanged". */
function appEntryUnreadable(v) {
  if (typeof v !== 'string') return null;
  for (const c of [v, v.slice(3)]) { // a status entry starts with '<XY> ', which no content and no marker does
    if (c === 'unreadable' || c === 'link ?') return { code: null, syscall: null, legacy: true };
    if (c.startsWith(APP_UNREADABLE_PREFIX)) { const parts = c.slice(APP_UNREADABLE_PREFIX.length).split(':'); return { code: parts[0] || null, syscall: parts[1] || null }; }
  }
  return null;
}
/** appUnreadableLabel(u) — 'EPERM open' for a marker, 'an older manifest\'s bare marker' for a pre-R14 one. */
function appUnreadableLabel(u) { return u.legacy ? 'recorded as unreadable by an older manifest' : (u.code || 'UNKNOWN') + ' ' + (u.syscall || 'unknown'); }
/** appCodeGitState(projectDir, exclude) -> null | {head, entries, count}. R3 / SYNC-12: the cheap application-code guard.
 *  When the project is in a git work tree: HEAD plus every entry `git status --porcelain` reports for the project folder
 *  OUTSIDE .claude/ and the three root files (CLAUDE.md, AGENTS.md, .gitignore — the protect manifest covers those),
 *  each with its content hash (a second edit to an already-dirty file changes it). Read-only (`--no-optional-locks`).
 *  null = not a git work tree / no git; a git that answers "inside a work tree" but then fails THROWS (fail closed).
 *  Stated limit: git-ignored files are not seen (git does not list them). `exclude` = extra project-relative folders. */
/** the guard is made honest and wider:
 *   - git itself unavailable -> {unavailable} (never null, which means "not a work tree");
 *   - IGNORED files are inventoried too (`git ls-files --others --ignored --exclude-standard -z`): their COUNT and the sha256
 *     of the sorted name list outside .claude/ — cheap, and a created or deleted ignored file changes it (contents are not
 *     hashed: node_modules alone can hold tens of thousands);
 *   - submodule HEADs (`git submodule status`) are recorded per path;
 *   - a symlink/junction among the status paths or at the top of the project is recorded by its TARGET string
 *     (`link <target>`), never followed;
 *   - text files are hashed with line endings normalised (CRLF/CR -> LF): a checkout that flips line endings is not a
 *     violation, any other byte change is; a file with a NUL byte in its first 8 KiB is hashed raw;
 *   - a probe that cannot run (ignored listing, submodule status) is recorded in `partial` with its reason, and the diff then
 *     reports guarded:'partial' — never true.
 *  opts.ignoredExclude: names to leave out of the ignored inventory (verifyProtect passes the names that were UNTRACKED in
 *  the "before" manifest, so a file the scaffold's .gitignore block newly hides is reconciled by F12, not counted twice).
 *  WP-SYNC-R8 scope, stated: git is told not to ENUMERATE .claude/ at all (exclude pathspec; for the ignored listing also a
 *  command-line negation) — the guard never used anything under .claude/ (isExcluded drops it), the protect manifest covers
 *  .claude/ file by file, except .claude/worktrees/, which it records as child names + count only. So nothing guards the
 *  files INSIDE an agent worktree checkout: they are agent scratch, not shipped files and not app code of this tree (their
 *  git metadata lives in the main .git/worktrees/<name>, which git never lists as a file). */
function appCodeGitState(projectDir, exclude, opts) {
  opts = opts || {};
  const abs = path.resolve(projectDir);
  let spawnFailure = null;
  const gitAt = (dir, args) => {
    try {
      const r = spawnSync('git', ['--no-optional-locks', '-C', dir].concat(args), { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
      if (r.error) { spawnFailure = r.error.message; return null; }
      return r.status === 0 ? r.stdout : null;
    } catch (e) { spawnFailure = e.message; return null; }
  };
  const git = (args) => gitAt(abs, args);
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside == null && spawnFailure) return { unavailable: 'git could not be run (' + spawnFailure + ')' };
  if (inside == null || inside.trim() !== 'true') return null;
  const prefix = git(['rev-parse', '--show-prefix']);
  const top = git(['rev-parse', '--show-toplevel']);
  // WP-SYNC-R8: nothing under .claude/ is ever used by this guard (isExcluded drops it; the protect manifest covers .claude/
  // itself), so git is told not to enumerate it: an exclude pathspec here and below. Status never descends into an IGNORED
  // folder anyway; the pathspec prunes a NON-ignored one (e.g. a .claude/worktrees/ that is not gitignored, whose
  // non-repository folders `-uall` would list file by file).
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', gitExcludePathspec('.claude')]);
  if (prefix == null || top == null || status == null) throw new Error('git reports ' + abs + ' as a work tree but its status could not be read — the application-code guard cannot run');
  const head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  const pre = prefix.trim();
  const topDir = top.trim();
  const excl = PROTECT_ROOT_FILES.concat(exclude || []).map(foldCase);
  const isExcluded = (rel) => { const f = foldCase(rel); return f === '.claude' || f.startsWith('.claude/') || excl.some((x) => f === x || f.startsWith(x + '/')); };
  const entries = {};
  const partial = [];
  const testHooks = process.env.FORGE_SYNC_TEST_HOOKS === '1' ? (opts.__failProbe || null) : null; // test seam: simulate an unavailable probe
  // WP-SYNC-R14: a FAILED read is a structured marker 'unreadable:<code>:<operation>' (appUnreadableMarker),
  // never a plain word — 'unreadable' / 'missing' / 'link ?' in both readings compared equal, so an app file edited while the guard
  // could not read it passed as unchanged (guarded:true, changed:0). diffProtectManifests never treats a marker as "the same".
  // Only ENOENT / ENOTDIR on lstat is 'missing': a tracked file that is really gone (' D'), a real state.
  const linkTargetOf = (p) => { try { return 'link ' + fs.readlinkSync(p); } catch (e) { return appUnreadableMarker(e, 'readlink'); } };
  const contentOf = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'missing' : appUnreadableMarker(e, 'lstat'); }
    if (st.isSymbolicLink()) return linkTargetOf(p);
    if (st.isDirectory()) return 'dir';
    if (!st.isFile()) return 'other';
    let buf;
    try { buf = fs.readFileSync(p); } catch (e) { return appUnreadableMarker(e, 'open'); }
    const probe = buf.subarray(0, 8192);
    const binary = probe.includes(0);
    return (binary ? '' : 'eol:') + crypto.createHash('sha256').update(binary ? buf : normalizeEolBuffer(buf)).digest('hex');
  };
  // a dirty submodule (or an untracked nested repository) is ONE status line (` M vendor/sub`) whose content
  // is a folder, so a second edit inside an already-dirty one changed nothing the guard recorded. Such a folder's own worktree
  // is inventoried now, recursively: its HEAD plus every path ITS `git status` lists, each with the same content hash, folded
  // into one fingerprint (`dir:<sha256>`). A worktree that cannot be inventoried (git fails on it, or repositories nested
  // deeper than APP_SUBTREE_MAX_DEPTH) is named in `partial` — the verdict then says guarded:'partial', never true. Stated
  // limit: IGNORED files inside a submodule are not inventoried (the top-level ignored listing does not descend into them).
  const isRepoRoot = (dirAbs) => lstatKind(path.join(dirAbs, '.git')) !== 'missing';
  const subtreeFingerprint = (dirAbs, depth) => {
    if (testHooks === 'submodule-worktree') return { problem: 'the worktree probe is unavailable (test seam)' };
    if (depth > APP_SUBTREE_MAX_DEPTH) return { problem: 'repositories nested deeper than ' + APP_SUBTREE_MAX_DEPTH + ' levels' };
    const pfx = gitAt(dirAbs, ['rev-parse', '--show-prefix']);
    if (pfx == null) return { problem: 'git could not read it as a repository' };
    if (pfx.trim() !== '') return { problem: 'it is not the root of its own repository' };
    const st = gitAt(dirAbs, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (st == null) return { problem: 'its git status could not be read' };
    const h = gitAt(dirAbs, ['rev-parse', '--verify', '-q', 'HEAD']);
    const rows = [];
    const t = st.split('\0');
    for (let i = 0; i < t.length; i++) {
      if (t[i].length < 4) continue;
      const xy = t[i].slice(0, 2);
      const ps = [t[i].slice(3)];
      if (xy[0] === 'R' || xy[0] === 'C') { ps.push(t[i + 1] || ''); i++; }
      for (const rp of ps) {
        if (!rp) continue;
        const p = path.join(dirAbs, ...rp.replace(/\/$/, '').split('/'));
        let c = contentOf(p);
        // WP-SYNC-R14: a path inside it that could not be read makes the whole worktree unverifiable — its marker is
        // handed up as the entry's content (a violation, fail closed), never hashed into a fingerprint two failed reads would share
        if (appEntryUnreadable(c)) return { problem: rp + ' could not be read (' + c + ')', unreadable: c };
        if (c === 'dir' && isRepoRoot(p)) { const sub = subtreeFingerprint(p, depth + 1); if (sub.problem) return { problem: rp + ': ' + sub.problem, unreadable: sub.unreadable }; c = 'dir:' + sub.fp; }
        rows.push(xy + ' ' + rp + ' ' + c);
      }
    }
    return { fp: sha256Str('HEAD ' + (h == null ? '-' : h.trim()) + '\n' + rows.sort().join('\n')) };
  };
  const linkDirs = new Set();
  const toks = status.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.length < 4) continue;
    const xy = tok.slice(0, 2);
    const paths = [tok.slice(3)];
    if (xy[0] === 'R' || xy[0] === 'C') { paths.push(toks[i + 1] || ''); i++; } // -z: the rename/copy source follows
    for (const rp of paths) {
      if (!rp || !rp.startsWith(pre)) continue;
      const rel = rp.slice(pre.length).replace(/\/$/, '');
      if (!rel || isExcluded(rel)) continue;
      const p = path.join(topDir, ...rp.split('/'));
      let content = contentOf(p);
      if (content === 'dir' && isRepoRoot(p)) { // a submodule / nested repository — fingerprint its own worktree
        const sub = subtreeFingerprint(p, 1);
        if (sub.unreadable) content = sub.unreadable; // WP-SYNC-R14: a path inside it could not be read — unverifiable (fail closed)
        else if (sub.problem) partial.push('the worktree of ' + rel + ' (a submodule or nested repository) could not be inventoried: ' + sub.problem + ' — edits inside it are not guarded');
        else content = 'dir:' + sub.fp;
      }
      entries[rel] = xy + ' ' + content;
      // every folder on the way may be a junction/symlink into another tree: record its target too (never followed)
      const segs = rel.split('/');
      for (let d = 1; d < segs.length; d++) linkDirs.add(segs.slice(0, d).join('/'));
    }
  }
  // the project's top-level entries: a junction/symlink there is recorded by its target even when git lists nothing under it
  try { for (const name of fs.readdirSync(abs)) if (!isExcluded(name)) linkDirs.add(name); } catch { partial.push('the project root could not be listed'); }
  for (const rel of linkDirs) {
    const p = path.join(abs, ...rel.split('/'));
    // WP-SYNC-R14: a link whose target cannot be read is a marker, never 'link ?'; an lstat that fails for another
    // reason than "gone" (ENOENT / ENOTDIR) cannot tell whether the entry is a link at all — recorded as a marker too (fail closed)
    try { const st = fs.lstatSync(p); if (st.isSymbolicLink()) entries['(link) ' + rel] = linkTargetOf(p); }
    catch (e) { if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) entries['(link) ' + rel] = appUnreadableMarker(e, 'lstat'); }
  }
  // ignored files: count + hash of the sorted name list (outside .claude/, minus the names the caller reconciles itself)
  let ignored = null;
  // --full-name — `git ls-files` otherwise prints paths relative to its working directory (the project), so in a
  // project nested inside a larger repository no name carried the repository prefix and every ignored file was dropped
  // WP-SYNC-R8 (measured on the 26H2 project): git skips the pathspec check for an IGNORED folder and walks it whole,
  // so `:(exclude).claude` alone did not stop it walking .claude/worktrees/ (ignored there via .git/info/exclude): 8,770
  // folders, 237,691 paths and 228,794 "could not open directory" warnings inside it. Two command-line patterns (the highest
  // gitignore precedence) negate .claude/ and everything under it, so git sees those folders as not ignored, applies the
  // exclude pathspec and prunes them. They are anchored to THIS project's .claude/ (the repository prefix in front), so the
  // ignored status of every path outside .claude/ is unchanged — measured: the 169,411 ignored names outside .claude/ were
  // byte-identical with and without them, read_directory 6.5 s -> 2.8 s. A prefix with glob characters gets no negation (still
  // correct, only slower: everything git lists under .claude/ is dropped by isExcluded below).
  const claudeNegation = /[*?[\\]/.test(pre) ? [] : ['-x', '!/' + pre + '.claude/', '-x', '!/' + pre + '.claude/**'];
  const ignoredRaw = testHooks === 'ignored' ? null : git(['ls-files', '--others', '--ignored', '--exclude-standard'].concat(claudeNegation, ['--full-name', '-z', '--', '.', gitExcludePathspec('.claude')]));
  if (ignoredRaw == null) partial.push('the ignored-files listing is unavailable (git ls-files --others --ignored failed)');
  else {
    const skipNames = new Set((opts.ignoredExclude || []).map(foldCase));
    const names = ignoredRaw.split('\0').filter(Boolean).map((rp) => rp.startsWith(pre) ? rp.slice(pre.length) : null).filter((rel) => rel && !isExcluded(rel) && !skipNames.has(foldCase(rel))).sort();
    ignored = { count: names.length, listHash: sha256Str(names.join('\n')) };
  }
  // submodules: HEAD per path (an empty answer with exit 0 = none)
  let submodules = null;
  const subRaw = testHooks === 'submodules' ? null : git(['submodule', 'status']);
  if (subRaw == null) partial.push('the submodule listing is unavailable (git submodule status failed)');
  else {
    submodules = {};
    for (const line of subRaw.split(/\r?\n/)) { const m = /^([ +\-U])([0-9a-f]{7,64}) (\S+)/.exec(line); if (m) submodules[m[3]] = m[1].trim() + m[2]; }
  }
  // notEnumerated (WP-SYNC-R8): what git was told not to list at all — reported, so the guard's scope is never implicit
  return { head: head == null ? null : (head.trim() || null), entries, count: Object.keys(entries).length, ignored, submodules, partial, notEnumerated: ['.claude/'] };
}
function protectEntrySummary(e) {
  if (!e) return null;
  const s = { kind: e.kind };
  if (e.size != null) s.size = e.size;
  if (e.hash) s.hash = e.hash.slice(0, 16);
  if (e.mtimeMs != null) s.mtime = new Date(e.mtimeMs).toISOString();
  if (e.target != null) s.target = e.target;
  if (e.error) s.error = e.error;
  if (e.kind === 'unreadable') { s.code = protectErrorCode(e); s.syscall = protectErrorSyscall(e); } // WP-SYNC-R13
  if (e.summarized && e.checkout) { s.checkout = true; s.git = typeof e.git === 'string' ? e.git.slice(0, 24) : null; } // WP-SYNC-R10: an agent checkout, by its .git identity
  else if (e.summarized) { s.children = e.count; s.names = (e.names || []).slice(0, 50); } // WP-SYNC-R8: which children, not their files
  return s;
}
/** gitignoreAppendOnly — the root .gitignore changed ONLY by an append: the current bytes start with exactly the
 *  recorded bytes (prefix hash), and what follows is the exact block this batch recorded — or, without a batch record,
 *  a block that starts with forge-sync's own scaffold header. */
function gitignoreAppendOnly(projectDir, before, after, exactAppended) {
  if (!before || before.kind !== 'file' || !after || after.kind !== 'file' || after.size <= before.size) return false;
  let buf;
  try { buf = fs.readFileSync(path.join(projectDir, '.gitignore')); } catch { return false; }
  if (buf.length !== after.size) return false;
  if (crypto.createHash('sha256').update(buf.subarray(0, before.size)).digest('hex') !== before.hash) return false;
  const tail = buf.subarray(before.size).toString('utf8');
  return typeof exactAppended === 'string' ? tail === exactAppended : tail.startsWith(GITIGNORE_SCAFFOLD_HEADER);
}
/** PROTECT_CONTENT_KINDS — WP-SYNC-R14: the entry kinds whose CONTENT an equal pair has really compared (a file's
 *  hash, a link's target, a folder that is walked entry by entry). Every other equal kind is only a summary (see the tally). */
const PROTECT_CONTENT_KINDS = new Set(['file', 'symlink', 'dir']);
/** diffProtectManifests(before, after, expected) -> {ok, changed[], added[], removed[], allowed[], checked, inventoried, verified,
 *  summarized, changedBySync, notVerified, complete, appCode, notComparable[], unreadable}.
 *  expected (what THIS batch itself recorded doing; see protectExpectationsFromRun / ...FromBatch):
 *    addedOk[]     keys this batch created (seed-only files, a scaffold CLAUDE.md/.gitignore, a migration's user file)
 *    removedOk[]   keys this batch moved into its backup (retired dashboard files, --retire-orphans)
 *    changedOk{}   key -> the exact hash this batch wrote there (a created/changed key must END at that hash)
 *    addedPrefixes the canary's own seeded run folder
 *    gitignoreAppended the exact block appended to the root .gitignore
 *  A new folder is allowed when it holds a shipped file or a sync-created key. Anything else that differs — a changed
 *  hash, a changed size/mtime of a secret-like file, a new or vanished file — is a violation. */
function diffProtectManifests(before, after, expected) {
  expected = expected || {};
  const addedOk = new Set(expected.addedOk || []);
  const removedOk = new Set(expected.removedOk || []);
  const changedOk = expected.changedOk || {};
  const prefixes = (expected.addedPrefixes || []).map((p) => String(p).replace(/\/+$/, ''));
  const allowedDirs = new Set([
    ...ancestorDirKeys((before.shippedRels || []).map((r) => '.claude/' + r)),
    ...ancestorDirKeys([...addedOk]),
    ...ancestorDirKeys(prefixes), ...prefixes,
  ]);
  const changed = [], added = [], removed = [], allowed = [], notComparable = [];
  const afterKeys = Object.keys(after.entries);
  // an added folder with NOTHING inside carries no data (measured 2026-10-10: the real doctor's suites leave an empty
  // .claude/forge-runs/ behind in a project that had none). It is allowed but always listed; a leaked folder WITH
  // content is still a violation, because every file inside it is one.
  const isEmptyDirAfter = (key) => !afterKeys.some((k) => k.startsWith(key + '/') && after.entries[k] && after.entries[k].kind !== 'absent' && after.entries[k].kind !== 'dir');
  const keys = new Set(Object.keys(before.entries).concat(afterKeys));
  // WP-SYNC-R14: what each INVENTORIED ("before") entry came to — verified (its content compared and equal: a file's
  // hash, a link's target, a folder walked entry by entry, an absent root file still absent), summarized (equal, but only by a
  // summary: a secret-like file's size + time, node_modules/.git presence, an agent checkout's .git identity, the R8 worktrees name
  // list, 'other'), or changedBySync (a change this sync recorded itself). With notComparable and the violations they add up to
  // `inventoried`; only `verified` may ever be called unchanged.
  const tally = { verified: 0, summarized: 0, changedBySync: 0 };
  for (const key of [...keys].sort()) {
    const b = before.entries[key], a = after.entries[key];
    const bAbsent = !b || b.kind === 'absent', aAbsent = !a || a.kind === 'absent';
    if (bAbsent && aAbsent) { if (b) tally.verified++; continue; }
    if (bAbsent) {
      let why = null;
      if (addedOk.has(key) && (typeof changedOk[key] !== 'string' || (a.kind === 'file' && a.hash === changedOk[key]))) why = 'created by this sync (recorded in its batch)';
      else if (prefixes.some((p) => key === p || key.startsWith(p + '/'))) why = 'the canary run this sync seeded';
      else if (protectAllowance(key) === 'add-only') why = 'sync bookkeeping (add-only)';
      else if (a.kind === 'dir' && allowedDirs.has(key)) why = 'folder for a shipped or sync-created file';
      else if (a.kind === 'dir' && isEmptyDirAfter(key)) why = 'an EMPTY folder appeared (no content, no data) — listed, not a violation';
      else if (a.kind === 'skipped-dir' && a.summarized && a.count === 0) why = 'an EMPTY folder appeared (no content, no data) — listed, not a violation'; // WP-SYNC-R8
      if (why) { allowed.push({ key, change: 'added', why }); if (b) tally.changedBySync++; } else added.push({ key, after: protectEntrySummary(a) });
      continue;
    }
    if (aAbsent) {
      if (removedOk.has(key)) { allowed.push({ key, change: 'removed', why: 'moved into this batch\'s backup by this sync' }); tally.changedBySync++; }
      else removed.push({ key, before: protectEntrySummary(b) });
      continue;
    }
    // WP-SYNC-R13: unreadable in BOTH readings — "not comparable" (counted, listed as NOT verified, never a violation) only strictly
    // inside .claude/worktrees/<name>/ (WP-SYNC-R13B) with the same known error code + operation, size and modified
    // time (see protectUnreadableSame); anything else is a change, with the reason
    if (b.kind === 'unreadable' && a.kind === 'unreadable') {
      const u = protectUnreadableSame(b, a, key);
      if (u.same) { notComparable.push({ key, code: u.code, syscall: u.syscall, mtimeCompared: u.mtimeCompared }); continue; }
      changed.push({ key, before: protectEntrySummary(b), after: protectEntrySummary(a), why: u.why });
      continue;
    }
    if (protectEntriesEqual(b, a)) { if (PROTECT_CONTENT_KINDS.has(b.kind)) tally.verified++; else tally.summarized++; continue; }
    if (a.kind === 'file' && typeof changedOk[key] === 'string' && changedOk[key] === a.hash) { allowed.push({ key, change: 'changed', why: 'written by this sync (recorded in its batch)' }); tally.changedBySync++; continue; }
    if (key === '.gitignore' && gitignoreAppendOnly(after.projectPath || before.projectPath, b, a, expected.gitignoreAppended)) { allowed.push({ key, change: 'appended', why: 'the Forge scaffold block appended by this sync' }); tally.changedBySync++; continue; }
    changed.push({ key, before: protectEntrySummary(b), after: protectEntrySummary(a) });
  }
  // application code outside .claude/ — any change in git HEAD or in the status/content of a path outside
  // .claude/ and the three root files is a violation (it is reported under `changed`, keyed "(app) <path>").
  // the ignored inventory, the submodule HEADs and link targets are compared too; a probe the "before" side could not
  // run makes the verdict guarded:'partial'. R4 / F12: a file that was UNTRACKED before and is absent from the status after is
  // NOT a violation when THIS sync's scaffold wrote the .gitignore block, the file is still there with the same (normalised)
  // bytes, and git confirms it is now ignored — the scaffold's own ignore rules hid it, nothing changed it.
  const appChanged = [];
  const appUnverifiable = []; // WP-SYNC-R14: app paths that could not be read in one reading or both
  let appPartial = null;
  if (before.git && !before.git.unavailable) {
    const ag = after.git;
    if (!ag || ag.unavailable) appChanged.push({ key: '(app) git state', before: 'recorded', after: ag && ag.unavailable ? ag.unavailable : 'could not be re-read' });
    else {
      if (before.git.head !== ag.head) appChanged.push({ key: '(app) git HEAD', before: before.git.head, after: ag.head });
      const be = before.git.entries || {}, ae = ag.entries || {};
      const scaffoldGitignore = typeof expected.gitignoreAppended === 'string' || addedOk.has('.gitignore');
      const nowHidden = [], eolOnly = [];
      const root = after.projectPath || before.projectPath;
      // a committed file whose ONLY change is its line endings newly appears in (or vanishes from) `git status` as
      // ` M`; its normalised hash is compared with the normalised HEAD blob — equal means eol-only, not a violation
      const eolSame = (k, h) => {
        try {
          const r = spawnSync('git', ['--no-optional-locks', '-C', root, 'show', 'HEAD:./' + k], { encoding: 'buffer', timeout: 60000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
          if (r.error || r.status !== 0) return false;
          return crypto.createHash('sha256').update(normalizeEolBuffer(r.stdout)).digest('hex') === h;
        } catch { return false; }
      };
      for (const k of [...new Set(Object.keys(be).concat(Object.keys(ae)))].sort()) {
        // WP-SYNC-R14: a path that could not be read proves nothing about what happened to it — never "unchanged",
        // also when both readings recorded the very same marker (fail closed: a violation, and the guard is 'partial')
        const ub = appEntryUnreadable(be[k]), ua = appEntryUnreadable(ae[k]);
        if (ub || ua) {
          appUnverifiable.push(k);
          appChanged.push({ key: '(app) ' + k, before: be[k] || 'clean', after: ae[k] || 'clean',
            why: 'unverifiable application path — it could not be read ' + (ub && ua ? 'in either reading' : (ub ? 'in the "before" reading' : 'now')) + ' (' + [ub, ua].filter(Boolean).map(appUnreadableLabel).join(' / ') + '), so its content cannot be compared (fail closed: a violation, never "unchanged")' });
          continue;
        }
        if (be[k] === ae[k]) continue;
        if (scaffoldGitignore && typeof be[k] === 'string' && be[k].startsWith('?? ') && ae[k] === undefined) { nowHidden.push({ key: k, beforeContent: be[k].slice(3) }); continue; }
        const oneSided = (be[k] === undefined && typeof ae[k] === 'string' && ae[k].startsWith(' M eol:')) ? ae[k] : ((ae[k] === undefined && typeof be[k] === 'string' && be[k].startsWith(' M eol:')) ? be[k] : null);
        if (oneSided && eolSame(k, oneSided.slice(' M eol:'.length))) { eolOnly.push(k); allowed.push({ key: '(app) ' + k, change: 'eol-only', why: 'only its line endings differ from the committed file (CRLF/LF) — the content is unchanged' }); continue; }
        appChanged.push({ key: '(app) ' + k, before: be[k] || 'clean', after: ae[k] || 'clean' });
      }
      if (nowHidden.length) {
        let ignoredNow = new Set();
        try {
          const r = spawnSync('git', ['--no-optional-locks', '-C', root, 'check-ignore', '-z', '--stdin'], { input: nowHidden.map((h) => h.key).join('\0') + '\0', encoding: 'utf8', timeout: 60000, windowsHide: true });
          if (!r.error && (r.status === 0 || r.status === 1)) ignoredNow = new Set(String(r.stdout || '').split('\0').filter(Boolean).map(foldCase));
        } catch { /* no answer: every candidate stays a violation */ }
        for (const h of nowHidden) {
          const p = path.join(root, ...h.key.split('/'));
          let same = false;
          try { const st = fs.lstatSync(p); if (st.isFile()) { const buf = fs.readFileSync(p); const bin = buf.subarray(0, 8192).includes(0); same = ((bin ? '' : 'eol:') + crypto.createHash('sha256').update(bin ? buf : normalizeEolBuffer(buf)).digest('hex')) === h.beforeContent; } } catch { same = false; }
          if (same && ignoredNow.has(foldCase(h.key))) allowed.push({ key: '(app) ' + h.key, change: 'now-ignored', why: 'hidden from git status by the .gitignore block this sync seeded; the file itself is unchanged' });
          else appChanged.push({ key: '(app) ' + h.key, before: be[h.key], after: 'not in git status any more' + (same ? ' (not confirmed ignored)' : ' (and its bytes changed or it is gone)') });
        }
      }
      const bi = before.git.ignored, ai = ag.ignored;
      if (bi && !ai) appChanged.push({ key: '(app) ignored files', before: bi.count + ' file(s)', after: 'listing unavailable' });
      else if (bi && ai && (bi.count !== ai.count || bi.listHash !== ai.listHash)) appChanged.push({ key: '(app) ignored files', before: bi.count + ' file(s), list ' + bi.listHash.slice(0, 12), after: ai.count + ' file(s), list ' + ai.listHash.slice(0, 12) });
      const bs = before.git.submodules, as = ag.submodules;
      if (bs && !as) appChanged.push({ key: '(app) submodules', before: Object.keys(bs).length + ' recorded', after: 'listing unavailable' });
      else if (bs && as) for (const k of [...new Set(Object.keys(bs).concat(Object.keys(as)))].sort()) if (bs[k] !== as[k]) appChanged.push({ key: '(app) submodule ' + k, before: bs[k] || 'absent', after: as[k] || 'absent' });
    }
    if (Array.isArray(before.git.partial) && before.git.partial.length) appPartial = before.git.partial.join('; ');
    if (appUnverifiable.length) {
      appPartial = (appPartial ? appPartial + '; ' : '') + appUnverifiable.length + ' application path(s) could not be read (' + appUnverifiable.slice(0, 5).join(', ')
        + (appUnverifiable.length > 5 ? ', … +' + (appUnverifiable.length - 5) + ' more' : '') + ') — not verified, each counted as a violation (fail closed)';
    }
  }
  for (const c of appChanged) changed.push(c);
  const appCode = !before.git ? { guarded: false, reason: 'not a git work tree' }
    : (before.git.unavailable ? { guarded: false, reason: before.git.unavailable }
      : { guarded: appPartial ? 'partial' : true, ...(appPartial ? { reason: appPartial } : {}), changed: appChanged.length, files: Object.keys(before.git.entries || {}).length, ignored: before.git.ignored ? before.git.ignored.count : null, unverifiable: appUnverifiable.length });
  // WP-SYNC-R13: notComparable lists the both-sides-unreadable keys; `unreadable` counts what could not be hashed on each side.
  // WP-SYNC-R13B: `checked` (kept for receipts / older readers) is what was INVENTORIED, not what was verified.
  // WP-SYNC-R14: verified = the inventoried entries whose CONTENT was compared and found equal (protectTally); the
  // summaries (meta, node_modules/.git presence, checkouts, the R8 worktrees summary, 'other'), the changes this sync recorded itself
  // and the not-comparable ones are counted apart. complete = no violation, every inventoried entry verified, app code fully guarded.
  const inventoried = Object.keys(before.entries).length;
  const ok = !changed.length && !added.length && !removed.length;
  const complete = ok && notComparable.length === 0 && tally.summarized === 0 && appCode.guarded === true;
  return { ok, changed, added, removed, allowed, checked: inventoried, appCode,
    inventoried, verified: tally.verified, summarized: tally.summarized, changedBySync: tally.changedBySync, notVerified: notComparable.length, complete,
    notComparable, unreadable: protectUnreadableSummary(before, after, notComparable) };
}
/** verifyProtect(projectDir, before, expected) — recompute the manifest with the SAME shipped list and compare. */
function verifyProtect(projectDir, before, expected) {
  if (!before || before.schema !== PROTECT_SCHEMA) throw new Error('not a protect manifest');
  if (path.resolve(projectDir) !== before.projectPath) throw new Error('this manifest was taken for ' + before.projectPath + ', not ' + path.resolve(projectDir));
  // names that were untracked before are left out of the "after" ignored inventory — the F12 reconciliation above
  // judges each of them individually (still present, same bytes, now confirmed ignored), so they are never counted twice
  const untrackedBefore = before.git && before.git.entries ? Object.keys(before.git.entries).filter((k) => typeof before.git.entries[k] === 'string' && before.git.entries[k].startsWith('?? ')) : [];
  // WP-SYNC-R8: summarize exactly what the "before" side summarized — symmetric by construction. A manifest written before
  // R8 has no summarizedDirs and is recomputed the old, walking way; buildProtectManifest's allow-list still applies.
  const summarizeDirs = Array.isArray(before.summarizedDirs) ? before.summarizedDirs : [];
  // WP-SYNC-R10: likewise the checkout mode — only when the 'before' manifest used it (an R8 or older manifest has no checkoutDirs)
  const checkoutDirs = Array.isArray(before.checkoutDirs) ? before.checkoutDirs : [];
  const after = buildProtectManifest(null, projectDir, { shippedRels: before.shippedRels, exactShipped: true, selfPath: before.selfPath, git: !!before.git, gitExclude: before.gitExclude, gitIgnoredExclude: untrackedBefore, summarizeDirs, checkoutDirs });
  return diffProtectManifests(before, after, expected);
}
/** protectExpectationsFromRun(run) — what an in-process sync recorded doing (plan, scaffold, retired/orphan moves,
 *  migration writes, the canary seed), in the shape diffProtectManifests expects. */
function protectExpectationsFromRun(run) {
  run = run || {};
  const out = { addedOk: [], removedOk: [], changedOk: {}, addedPrefixes: [], gitignoreAppended: null };
  for (const e of (run.plan && run.plan.toChange) || []) {
    const k = '.claude/' + e.rel;
    if (e.oldHash === null) out.addedOk.push(k);
    if (typeof e.newHash === 'string') out.changedOk[k] = e.newHash;
  }
  if (run.scaffold) {
    for (const n of run.scaffold.created || []) if (SCAFFOLD_ALLOWED.has(n)) out.addedOk.push(n);
    if (typeof run.scaffold.gitignoreAppended === 'string') out.gitignoreAppended = run.scaffold.gitignoreAppended;
  }
  for (const rel of (run.retiredPrune && run.retiredPrune.removed) || []) out.removedOk.push('.claude/' + rel);
  for (const rel of (run.retiredOrphans && run.retiredOrphans.moved) || []) out.removedOk.push('.claude/' + rel);
  for (const w of run.migrationWrites || []) { const k = '.claude/' + w.rel; out.changedOk[k] = w.postHash; if (!w.existed) out.addedOk.push(k); }
  if (run.canarySeed && run.canarySeed.runId) {
    out.addedPrefixes.push('.claude/forge-runs/' + run.canarySeed.runId);
    // WP 2.1: in a .forge/ project log-event.cjs writes the canary run into the active runs folder instead
    if (forgePathsMod && run.projectDir) {
      try {
        const rel = path.relative(path.resolve(run.projectDir), forgePathsMod.stateDir(run.projectDir, 'runs')).split(path.sep).join('/');
        if (isPlainRel(rel) && rel !== '.claude/forge-runs') out.addedPrefixes.push(rel + '/' + run.canarySeed.runId);
      } catch { /* legacy prefix only */ }
    }
  }
  return out;
}
/** protectExpectationsFromBatch(projectDir, batchId) — the same expectations, read back from the batch's own on-disk
 *  records (manifest.json files/scaffold/migrations, the retired-prune and retired-orphans ledgers), for a standalone
 *  `verify-protect --batch`. The records are untrusted input: only plain .claude-relative rels and the two scaffold
 *  names are accepted. */
function protectExpectationsFromBatch(projectDir, batchId) {
  const out = { addedOk: [], removedOk: [], changedOk: {}, addedPrefixes: [], gitignoreAppended: null, sources: [] };
  if (!isSafeBatchId(batchId)) return Object.assign(out, { error: unsafeBatchIdReason(batchId) || 'no batch id given' });
  const dst = claudeDirOf(projectDir);
  const bdir = backupDirFor(projectDir, batchId);
  if (isSymlinkPath(bdir) || !containmentSafe(dst, bdir)) return Object.assign(out, { error: 'the backup folder of batch ' + batchId + ' is a symlink or resolves outside the project' });
  const plainRel = (rel) => typeof rel === 'string' && !!rel && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.split(/[\\/]/).some((s) => s === '' || s === '.' || s === '..');
  const readJson = (n) => { try { return JSON.parse(fs.readFileSync(path.join(bdir, n), 'utf8')); } catch { return null; } };
  const m = readJson('manifest.json');
  if (m && m.batchId === batchId && Array.isArray(m.files)) {
    out.sources.push('manifest.json');
    for (const f of m.files) {
      if (!f || !plainRel(f.rel)) continue;
      const k = '.claude/' + f.rel;
      if (f.existed === false || f.oldHash === null) out.addedOk.push(k);
      if (typeof f.newHash === 'string') out.changedOk[k] = f.newHash;
    }
    if (m.scaffold) {
      for (const n of m.scaffold.created || []) if (SCAFFOLD_ALLOWED.has(n)) out.addedOk.push(n);
      if (typeof m.scaffold.gitignoreAppended === 'string') out.gitignoreAppended = m.scaffold.gitignoreAppended;
    }
    for (const w of Array.isArray(m.migrations) ? m.migrations : []) {
      if (!w || !plainRel(w.rel) || typeof w.postHash !== 'string') continue;
      out.changedOk['.claude/' + w.rel] = w.postHash;
      if (!w.existed) out.addedOk.push('.claude/' + w.rel);
    }
  }
  for (const name of [RETIRED_PRUNE_MANIFEST_NAME, RETIRED_ORPHANS_MANIFEST_NAME]) {
    const l = readJson(name);
    if (!l || l.batchId !== batchId || !Array.isArray(l.files)) continue;
    out.sources.push(name);
    for (const f of l.files) if (f && plainRel(f.rel)) out.removedOk.push('.claude/' + f.rel);
  }
  return out;
}
/** protectViolationLines(diff) — one line per offending path, for refusals, the CLI and the report. */
function protectViolationLines(diff) {
  if (!diff) return [];
  const lines = [];
  if (diff.error) lines.push('could not re-check: ' + diff.error);
  for (const c of diff.changed || []) lines.push('CHANGED ' + c.key);
  for (const a of diff.added || []) lines.push('ADDED   ' + a.key);
  for (const r of diff.removed || []) lines.push('REMOVED ' + r.key);
  return lines;
}
function protectViolationReason(diff) {
  const lines = protectViolationLines(diff);
  return 'protected path(s) changed during this sync (' + lines.length + '): ' + lines.slice(0, 12).join('; ') + (lines.length > 12 ? '; … +' + (lines.length - 12) + ' more' : '');
}
/** snapshotMigrationTargets / migrationWritesSince — the two owner-data migrations (standing rules, Scout verdicts) run
 *  before the plan and may write a *.user.json. Their exact before/after hashes are captured so the protect check (and
 *  the batch manifest, for a later standalone verify) can tell that write apart from anything else touching the file. */
function snapshotMigrationTargets(projectDir) {
  const dst = claudeDirOf(projectDir);
  return [STANDING_RULES_USER_REL, SCOUT_VETTING_USER_REL].map((rel) => ({ rel, st: fileStatus(path.join(dst, ...rel.split('/'))) }));
}
function migrationWritesSince(projectDir, snaps) {
  const dst = claudeDirOf(projectDir);
  const out = [];
  for (const s of snaps || []) {
    const post = fileStatus(path.join(dst, ...s.rel.split('/')));
    const preHash = s.st.kind === 'ok' ? s.st.hash : null;
    const postHash = post.kind === 'ok' ? post.hash : null;
    if (postHash && postHash !== preHash) out.push({ rel: s.rel, existed: s.st.kind === 'ok', preHash, postHash });
  }
  return out;
}

// ---- settings.json ledger ---------------------------------------------------------------------------------
const SETTINGS_LEDGER_NAME = 'settings-ledger.json';
const SETTINGS_PRE_DIR = 'settings-pre';
function settingsLedgerDirs(projectDir, batchId) {
  if (!isSafeBatchId(batchId)) return { ok: false, reason: unsafeBatchIdReason(batchId) || 'a batch id is required for the settings.json undo record' };
  const dst = claudeDirOf(projectDir);
  const bdir = backupDirFor(projectDir, batchId);
  const preDir = path.join(bdir, SETTINGS_PRE_DIR);
  let chain;
  try { assertClaudeBaseContained(projectDir); chain = realDirChain(dst, preDir, { create: false }); } catch (e) { chain = { ok: false, problem: e.message }; }
  if (!chain.ok || isSymlinkPath(bdir) || isSymlinkPath(preDir) || !containmentSafe(dst, preDir)) { // the whole chain, not just the leaf
    return { ok: false, reason: 'the settings backup folder for batch ' + batchId + ' is a symlink/junction or resolves outside the project' + (chain.problem ? ' (' + chain.problem + ')' : '') + ' — refusing' };
  }
  return { ok: true, dst, bdir, preDir, ledgerPath: path.join(bdir, SETTINGS_LEDGER_NAME), settingsPath: path.join(dst, 'settings.json') };
}
/** patchBatchManifestSettings — mirror the settings ledger into the batch's manifest.json (and its central copy) as
 *  `settings`, so the batch manifest itself names the pre-merge hash and the .forge-bak. Best-effort: a no-op batch has
 *  no manifest.json; the ledger file stays the record rollback reads. */
function patchBatchManifestSettings(dirs, ledger) {
  for (const dir of dirs) {
    if (!dir) continue;
    const mPath = path.join(dir, 'manifest.json');
    try {
      const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      m.settings = ledger;
      // a bound manifest keeps a valid self-hash; a legacy one is patched as before (it stays legacy)
      if (m.schema === BACKUP_MANIFEST_SCHEMA) writeBoundManifest(dir, m); else writeAtomic(mPath, JSON.stringify(m, null, 2) + '\n');
    } catch { /* no main manifest for this batch, or an unwritable mirror */ }
  }
}
/** mergeSettingsForBatch(templateDir, projectDir, batchId, opts) — syncProjectSettings with an undo record. When the
 *  merge would actually write settings.json (would-merge / would-create), FIRST the current bytes are copied into
 *  forge-backups/<batch>/settings-pre/settings.json (hash-verified) and a ledger (settings-ledger.json: existed,
 *  preHash, status pending) is written; THEN the merge runs; the ledger is finalised with postHash and the merge
 *  tool's own .forge-bak. A merge whose undo record cannot be written is REFUSED (never a settings change without a
 *  way back). Anything that writes no settings.json (noop, refused, skipped) goes straight through. */
function mergeSettingsForBatch(templateDir, projectDir, batchId, opts) {
  opts = opts || {};
  const preview = syncProjectSettings(templateDir, projectDir, { dryRun: true });
  if (!preview || (preview.status !== 'would-merge' && preview.status !== 'would-create')) return syncProjectSettings(templateDir, projectDir, {});
  const dirs = settingsLedgerDirs(projectDir, batchId);
  const refuse = (why) => ({ ok: false, status: 'refused', skipped: 'no-undo-record', error: why, message: 'settings.json was NOT merged: ' + why + ' — a settings change without an undo record in the batch is refused' });
  if (!dirs.ok) return refuse(dirs.reason);
  const { dst, bdir, preDir, ledgerPath, settingsPath } = dirs;
  let ledger;
  try {
    ensureRealDir(dst, bdir); // never written through a junction
    const st = fileStatus(settingsPath);
    if (st.kind === 'unreadable') throw new Error('settings.json exists but cannot be read (' + st.error + ')');
    const existed = st.kind === 'ok';
    if (existed) {
      ensureRealDir(bdir, preDir);
      const copy = path.join(preDir, 'settings.json');
      if (fs.existsSync(copy)) {
        if (sha256(copy) !== st.hash) throw new Error('this batch already holds a different pre-merge settings.json copy');
      } else copyNoFollow(settingsPath, copy, preDir);
      if (sha256(copy) !== st.hash) throw new Error('the pre-merge copy of settings.json could not be verified');
    }
    ledger = {
      schema: 'forge-sync-settings-ledger/v1', batchId, projectPath: path.resolve(projectDir), rel: 'settings.json',
      existed, preHash: existed ? st.hash : null, preBackupRel: existed ? SETTINGS_PRE_DIR + '/settings.json' : null,
      status: 'pending', postHash: null, forgeBak: null, recordedAt: opts.nowIso || new Date().toISOString(),
    };
    writeAtomic(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  } catch (e) { return refuse('its undo record could not be written (' + e.message + ')'); }
  patchBatchManifestSettings([bdir, opts.centralDir], ledger);
  // test seam (FORGE_SYNC_TEST_HOOKS=1 only, like the M11 rollback hook): an owner edit between the preview and the merge
  if (process.env.FORGE_SYNC_TEST_HOOKS === '1' && typeof opts.__afterPreview === 'function') opts.__afterPreview();
  const result = syncProjectSettings(templateDir, projectDir, {});
  // the batch OWNS settings.json only when the merge really applied (merged / created). A refused or failed
  // merge — e.g. the merge tool saw a concurrent owner edit and backed off — records a no-op with NO postHash, so a
  // rollback can never mistake the owner's bytes for "what this sync wrote" and overwrite them.
  const applied = !!result && result.ok === true && (result.status === 'merged' || result.status === 'created');
  const post = fileStatus(settingsPath);
  let postHash = null, postHashSource = null;
  const postObserved = post.kind === 'ok' ? post.hash : null;
  if (applied) {
    // postHash is the hash of the bytes the MERGE TOOL WROTE (forge-settings-merge.cjs reports writtenSha256 for
    // its create and merge writes), never a sample of the destination taken afterwards — an owner edit in that instant is
    // then a conflict on rollback (kept), never mistaken for this sync's output and replaced.
    if (typeof result.writtenSha256 === 'string' && /^[0-9a-f]{64}$/.test(result.writtenSha256)) { postHash = result.writtenSha256; postHashSource = 'writer'; }
    else if (result.status === 'created') {
      // an older merge tool: a create writes exactly the template's settings.json text with a final newline
      try { const raw = fs.readFileSync(path.join(templateDir, 'settings.json'), 'utf8'); postHash = sha256Str(raw.endsWith('\n') ? raw : raw + '\n'); postHashSource = 'template-text'; } catch { postHash = null; }
    }
    // a merged write by an older tool that reports no writtenSha256: the bytes cannot be attributed — postHash stays null, so
    // rollback treats the merge as unconfirmed (kept, reported) rather than claiming the observed bytes as its own
    if (postHash === null) postHashSource = 'unattributed';
  }
  const finalLedger = Object.assign({}, ledger, {
    status: applied ? result.status : 'no-op', applied, mergeStatus: result.status || (result.skipped ? 'skipped:' + result.skipped : 'unknown'),
    postHash, postHashSource, postObserved,
    forgeBak: applied && result.backupPath ? path.relative(dst, result.backupPath).split(path.sep).join('/') : null,
  });
  finalLedger.changed = applied && finalLedger.postHash !== finalLedger.preHash;
  let ledgerWarning = null;
  try { writeAtomic(ledgerPath, JSON.stringify(finalLedger, null, 2) + '\n'); }
  catch (e) { ledgerWarning = 'the settings ledger could not be finalised (' + e.message + ') — rollback treats the merge as unconfirmed'; }
  patchBatchManifestSettings([bdir, opts.centralDir], finalLedger);
  return Object.assign({}, result, {
    ledger: { path: ledgerPath, existed: finalLedger.existed, preHash: finalLedger.preHash, postHash: finalLedger.postHash, forgeBak: finalLedger.forgeBak },
    ...(ledgerWarning ? { ledgerWarning } : {}),
  });
}
/** restoreSettingsLedger(projectDir, batchId, opts) -> {ok, action, skipped?, conflict?, error?} — rollback's
 *  settings.json step. No ledger = nothing recorded (an honest no-op). The ledger is checked against the batch and the
 *  project. settings.json is restored byte-for-byte (from the batch copy, else the .forge-bak when it hashes to the
 *  recorded preHash) ONLY while it still holds exactly what this sync wrote (postHash); an owner edit since then is a
 *  conflict, kept and reported, unless opts.forceRollbackNewer. A settings.json this sync created is removed. Every
 *  restore is re-hashed before it is reported. */
function restoreSettingsLedger(projectDir, batchId, opts) {
  opts = opts || {};
  const dirs = settingsLedgerDirs(projectDir, batchId);
  if (!dirs.ok) return { ok: false, action: 'none', error: dirs.reason };
  const { dst, preDir, ledgerPath, settingsPath } = dirs;
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, action: 'none', skipped: 'no settings.json change recorded for this batch' };
    return { ok: false, action: 'none', error: 'the settings ledger is unreadable (' + e.message + ') — settings.json not restored' };
  }
  if (!ledger || ledger.batchId !== batchId || ledger.projectPath !== path.resolve(projectDir) || ledger.rel !== 'settings.json') {
    return { ok: false, action: 'none', error: 'the settings ledger does not match this batch/project — refusing to trust it' };
  }
  // a merge that did not apply (refused, failed, a no-op) never owned settings.json — nothing to undo, even
  // under --force-rollback-newer (the bytes there are not this sync's to replace).
  // A ledger from before this fix has no `applied` field: only 'merged'/'created' ever owned the file there (a 'refused'
  // one recorded the owner's concurrent bytes as postHash — exactly the bug); 'pending' = a merge cut off mid-way.
  const appliedMerge = ledger.applied === true || (ledger.applied === undefined && (ledger.status === 'merged' || ledger.status === 'created'));
  if (!appliedMerge && ledger.status !== 'pending') return { ok: true, action: 'none (the merge was not applied by this sync: ' + (ledger.mergeStatus || ledger.status || 'no-op') + ')' };
  const cur = fileStatus(settingsPath);
  if (cur.kind === 'unreadable') return { ok: false, action: 'none', error: 'settings.json cannot be read now (' + cur.error + ') — not restored' };
  const curHash = cur.kind === 'ok' ? cur.hash : null;
  const preState = ledger.existed ? ledger.preHash : null;
  if (curHash === preState) return { ok: true, action: 'unchanged (already the pre-sync state)' };
  if (!opts.forceRollbackNewer && (ledger.postHash == null || curHash !== ledger.postHash)) {
    return {
      ok: false, action: 'none', conflict: true,
      error: 'settings.json changed since this sync ' + (ledger.postHash == null ? 'started merging it (the merge was never confirmed)' : 'merged it') + ' — kept as it is (pass --force-rollback-newer to restore the pre-sync bytes anyway)',
    };
  }
  if (isSymlinkPath(settingsPath) || !containmentSafe(dst, settingsPath)) return { ok: false, action: 'none', error: 'containment guard tripped for settings.json' };
  if (opts.checkOnly) return { ok: true, action: 'would restore', checkOnly: true }; // rollbackProject's up-front check
  try {
    if (!ledger.existed) {
      if (curHash !== null && curHash !== ledger.postHash) {
        // R3 / SYNC-02(c): created by this sync, changed since, and forced: MOVED into the batch backup, never deleted
        const q = path.join(dirs.bdir, 'rollback-quarantine', 'settings.json');
        ensureRealDir(dirs.bdir, path.dirname(q));
        copyNoFollow(settingsPath, q, dirs.bdir);
        if (sha256(q) !== curHash) throw new Error('the quarantine copy of settings.json could not be verified — kept');
        const moved = quarantineAndVerify(settingsPath, curHash);
        if (!moved.removed) throw new Error('settings.json changed again while it was being moved aside — kept');
        return { ok: true, action: 'moved into the batch backup (this sync had created it; it was changed since): ' + q };
      }
      fs.rmSync(settingsPath, { force: true });
      if (fs.existsSync(settingsPath)) throw new Error('settings.json is still present after removal');
      return { ok: true, action: 'removed (this sync had created it)' };
    }
    let src = path.join(preDir, 'settings.json');
    let label = 'the batch copy';
    if (sha256(src) !== ledger.preHash) {
      const bak = typeof ledger.forgeBak === 'string' ? safeJoin(dst, ledger.forgeBak) : null;
      if (bak && !isSymlinkPath(bak) && containmentSafe(dst, bak) && sha256(bak) === ledger.preHash) { src = bak; label = ledger.forgeBak; }
      else throw new Error('no verified pre-sync copy of settings.json (the batch copy is missing or corrupt, and the .forge-bak does not hash to the recorded value)');
    }
    copyNoFollow(src, settingsPath, dst);
    if (sha256(settingsPath) !== ledger.preHash) throw new Error('hash mismatch after restoring settings.json');
    return { ok: true, action: 'restored byte-for-byte from ' + label };
  } catch (e) { return { ok: false, action: 'none', error: e.message }; }
}
/** undoSettingsMerge(projectDir, batchId) -> restoreSettingsLedger's result — WP-SYNC-R11. safeSyncProject now merges
 *  settings.json BEFORE the post-sync doctor, so its in-run rollbacks (validation failure, unresolved drift) must undo that
 *  merge as well. The same byte-for-byte restore `rollback` uses, with the same ownership rule: settings.json is put back
 *  only while it still holds exactly what this batch's merge wrote (postHash); a merge that did not apply (noop, refused,
 *  skipped — no ledger, or a no-op ledger) has nothing to undo; a settings.json changed since the merge is KEPT and
 *  reported (ok:false, conflict), never overwritten. A .forge-bak the merge took stays where it is (it hashes to the
 *  ledger's preHash, so ledger, backup and the restored file agree). Never throws.
 *  WP-SYNC-R12: safeSyncProject's in-run rollbacks now call restoreSettingsInRun, which runs this first and, only when settings.json
 *  is still not back at its pre-sync bytes, puts them back with the bytes found there moved into the batch backup; it then removes
 *  this batch's own .forge-bak. A manual `rollback` keeps the rule above unchanged. */
function undoSettingsMerge(projectDir, batchId) {
  try { return restoreSettingsLedger(projectDir, batchId, {}); }
  catch (e) { return { ok: false, action: 'none', error: 'restoring settings.json threw (' + e.message + ')' }; }
}
/** settingsRestoreProblem(sr) -> null | one plain line saying why settings.json was not put back (WP-SYNC-R11). */
function settingsRestoreProblem(sr) { return sr && sr.ok === false ? 'settings.json was not restored: ' + (sr.error || 'unknown reason') : null; }

// ---- WP-SYNC-R12 (Codex r8 settings-order findings R11-01..R11-06): settings.json inside the validation window ------
// WP-SYNC-R11 moved the settings.json merge in front of the post-sync doctor. That widened the window in which settings.json holds
// this batch's merge while other code runs: the doctor itself (its suites may write the file), the isolated re-runs, a validation
// step that throws, and a merge step that throws after the merge tool already wrote. The helpers below keep that window honest:
// the pre-sync bytes are read once under this run's lock (quiesced) and every in-run rollback puts exactly those bytes back.
function sha256Buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
/** settingsSnapshot(projectDir, withBytes) -> {kind:'ok', hash, buf?} | {kind:'missing'} | {kind:'unreadable', error}. The state of
 *  <project>/.claude/settings.json: a regular file is hashed (withBytes: its bytes are kept in memory too — it is a small file); a
 *  link, a folder or an unreadable entry is 'unreadable' and is never followed. Never throws. */
function settingsSnapshot(projectDir, withBytes) {
  const p = path.join(claudeDirOf(projectDir), 'settings.json');
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return e && e.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: e.message }; }
  if (!st.isFile()) return { kind: 'unreadable', error: st.isSymbolicLink() ? 'it is a symlink/junction' : (st.isDirectory() ? 'it is a directory, not a file' : 'it is not a regular file') };
  try { const buf = fs.readFileSync(p); return Object.assign({ kind: 'ok', hash: sha256Buf(buf) }, withBytes ? { buf } : {}); }
  catch (e) { return { kind: 'unreadable', error: e.message }; }
}
/** settingsRollbackTarget(projectDir, batchId, snap) -> the pre-sync settings.json state an in-run rollback must restore. Normally
 *  `snap` itself (read under this run's lock right before the merge). But when this batch's ledger already owns settings.json from an
 *  EARLIER attempt (a --resume-batch after a crash: the snapshot then holds that attempt's merged bytes), the ledger's recorded pre
 *  state is the truth: absent when the batch created the file, else the batch copy (settings-pre/) verified against the ledger's
 *  preHash. Without a verified copy the snapshot stays the target (the start of this attempt is the best state known). Never throws. */
function settingsRollbackTarget(projectDir, batchId, snap) {
  try {
    const dirs = settingsLedgerDirs(projectDir, batchId);
    if (!dirs.ok) return snap;
    let ledger = null;
    try { ledger = JSON.parse(fs.readFileSync(dirs.ledgerPath, 'utf8')); } catch { return snap; }
    if (!ledger || ledger.batchId !== batchId || ledger.projectPath !== path.resolve(projectDir) || ledger.rel !== 'settings.json') return snap;
    const owns = ledger.applied === true || ledger.status === 'pending' || (ledger.applied === undefined && (ledger.status === 'merged' || ledger.status === 'created'));
    if (!owns) return snap;
    if (ledger.existed === false) return { kind: 'missing', fromLedger: true };
    if (typeof ledger.preHash !== 'string') return snap;
    if (snap && snap.kind === 'ok' && snap.hash === ledger.preHash) return snap; // the usual case: the ledger was written by this attempt
    const b = fs.readFileSync(path.join(dirs.preDir, 'settings.json'));
    return sha256Buf(b) === ledger.preHash ? { kind: 'ok', hash: ledger.preHash, buf: b, fromLedger: true } : snap;
  } catch { return snap; }
}
/** sameSettingsState(a, b) — both readable and equal: both absent, or both a regular file with the same bytes. */
function sameSettingsState(a, b) { return !!a && !!b && a.kind !== 'unreadable' && a.kind === b.kind && (a.kind === 'missing' || a.hash === b.hash); }
function settingsStateLabel(s) { return !s ? 'unknown' : (s.kind === 'ok' ? 'sha256 ' + String(s.hash).slice(0, 12) : (s.kind === 'missing' ? 'absent' : 'unreadable (' + (s.error || '?') + ')')); }
/** settingsDriftCheck(projectDir, judged, settingsMerge) -> null | {judged, now, postHash, reason} — R11-02. The commit may stamp only the
 *  settings.json the post-sync doctor (and every isolated re-run) judged. `judged` is the snapshot taken right after the merge, before
 *  the doctor. Drift = settings.json is different now (a suite, a re-run or any other writer changed it during validation), or — when
 *  this batch's merge applied — the doctor did not even start on exactly the bytes the merge wrote (its ledger postHash). settings.json
 *  has protect allowance 'any' (the merge owns it), so without this check such a write went unseen. Never throws. */
function settingsDriftCheck(projectDir, judged, settingsMerge) {
  const now = settingsSnapshot(projectDir, false);
  const led = settingsMerge && settingsMerge.ledger;
  const postHash = led && typeof led.postHash === 'string' ? led.postHash : null;
  const changed = !judged || now.kind !== judged.kind || (now.kind === 'ok' && now.hash !== judged.hash);
  const notMerged = !!postHash && !(judged && judged.kind === 'ok' && judged.hash === postHash);
  if (!changed && !notMerged) return null;
  const plain = (s) => (s ? { kind: s.kind, hash: s.kind === 'ok' ? s.hash : null } : null);
  const reason = changed
    ? 'settings.json changed DURING validation (the doctor judged ' + settingsStateLabel(judged) + ', it is now ' + settingsStateLabel(now) + ') — a suite the doctor or an isolated re-run ran (or another writer) rewrote it, so the verdict does not cover the settings.json this sync would leave behind'
    : 'settings.json did not hold what this sync merged when the doctor started (merged ' + postHash.slice(0, 12) + ', judged ' + settingsStateLabel(judged) + ')';
  return { judged: plain(judged), now: plain(now), postHash, reason: reason + ' — not committed: failed and rolled back like any other validation failure' };
}
/** putBackPreSyncSettings(projectDir, batchId, pre) -> {ok, action, error?, conflict?, quarantined?, forced?} — R11-02 / R11-04. Writes
 *  the pre-sync bytes back into settings.json whatever it holds now, WITHOUT losing what it holds: those bytes are first copied into
 *  this batch's backup (forge-backups/<batch>/rollback-quarantine/settings.json[.N], the copy hash-verified, never deleted), and the
 *  write then replaces only exactly the bytes that were copied (writeBytesNoFollow expectOldHash; anything newer is kept). The bytes
 *  put back come from the batch copy (settings-pre/) when it holds exactly the pre-sync hash, else from `pre` — the snapshot read
 *  under this run's lock right before the merge. pre-sync absent -> the file is moved aside (verified) instead. A settings.json that
 *  is not a readable regular file now, or pre-sync bytes that were never readable: KEPT, reported. Never throws. */
function putBackPreSyncSettings(projectDir, batchId, pre) {
  try {
    const dirs = settingsLedgerDirs(projectDir, batchId);
    if (!dirs.ok) return { ok: false, action: 'none', error: dirs.reason };
    const { dst, bdir, preDir, settingsPath } = dirs;
    if (!pre || pre.kind === 'unreadable') return { ok: false, action: 'none', error: 'the pre-sync settings.json was not readable when this run started, so there is nothing verified to put back — kept as it is' };
    const cur = settingsSnapshot(projectDir, false);
    if (sameSettingsState(cur, pre)) return { ok: true, action: 'unchanged (already the pre-sync state)' };
    if (cur.kind === 'unreadable') return { ok: false, action: 'none', conflict: true, error: 'settings.json is not a readable regular file now (' + cur.error + ') — kept as it is, not restored' };
    if (!containmentSafe(dst, settingsPath)) return { ok: false, action: 'none', error: 'containment guard tripped for settings.json — kept as it is' };
    let buf = null, label = null;
    if (pre.kind === 'ok') {
      try { const b = fs.readFileSync(path.join(preDir, 'settings.json')); if (sha256Buf(b) === pre.hash) { buf = b; label = 'the batch copy'; } } catch { /* no batch copy: this batch's merge did not apply */ }
      if (!buf && Buffer.isBuffer(pre.buf) && sha256Buf(pre.buf) === pre.hash) { buf = pre.buf; label = 'the pre-sync snapshot read under this run\'s lock'; }
      if (!buf) return { ok: false, action: 'none', error: 'no verified copy of the pre-sync settings.json — kept as it is' };
    }
    let quarantined = null;
    if (cur.kind === 'ok') {
      const qdir = path.join(bdir, 'rollback-quarantine');
      ensureRealDir(bdir, qdir);
      let q = path.join(qdir, 'settings.json');
      for (let i = 1; fs.existsSync(q) || isSymlinkPath(q); i++) q = path.join(qdir, 'settings.json.' + i);
      copyNoFollow(settingsPath, q, bdir);
      if (sha256(q) !== cur.hash) return { ok: false, action: 'none', error: 'the copy of the current settings.json in the batch backup could not be verified — kept as it is, not restored' };
      quarantined = q;
    }
    const keptAt = quarantined ? '; the bytes it held (' + cur.hash.slice(0, 12) + ') were moved into the batch backup: ' + quarantined : '';
    if (pre.kind === 'ok') {
      const w = writeBytesNoFollow(buf, settingsPath, dst, { expectOldHash: cur.kind === 'ok' ? cur.hash : null });
      if (w === 'changed') return { ok: false, action: 'none', quarantined, error: 'settings.json changed again while it was being restored — kept' };
      if (sha256(settingsPath) !== pre.hash) return { ok: false, action: 'none', quarantined, error: 'hash mismatch after restoring settings.json' };
      return { ok: true, forced: true, quarantined, action: 'restored byte-for-byte from ' + label + keptAt };
    }
    const moved = quarantineAndVerify(settingsPath, cur.hash);
    if (!moved.removed) return { ok: false, action: 'none', quarantined, error: 'settings.json changed again while it was being moved aside (' + moved.reason + ')' };
    return { ok: true, forced: true, quarantined, action: 'removed (there was no settings.json before this sync)' + keptAt };
  } catch (e) { return { ok: false, action: 'none', error: 'putting the pre-sync settings.json back threw (' + e.message + ')' }; }
}
/** removeOwnForgeBak(projectDir, batchId, pre) -> null | string — R11-05. After an in-run rollback put settings.json back to its pre-sync
 *  bytes, the .forge-bak this batch's merge took is a third copy of those bytes (the batch keeps settings-pre/settings.json), and every
 *  failed attempt used to leave one more in .claude/. Exactly that one is removed: the name recorded in THIS batch's ledger, a plain
 *  settings.json.forge-bak-* file directly in .claude/, still holding exactly the pre-sync bytes (moved aside and re-hashed before it
 *  is removed). hintName: the name this run's in-memory ledger holds when the on-disk ledger could not be finalised (it must pass
 *  every check above). Anything else is kept and named. Never throws. */
function removeOwnForgeBak(projectDir, batchId, pre, hintName) {
  try {
    const dirs = settingsLedgerDirs(projectDir, batchId);
    if (!dirs.ok) return null;
    let ledger = null;
    try { ledger = JSON.parse(fs.readFileSync(dirs.ledgerPath, 'utf8')); } catch { return null; }
    if (!ledger || ledger.batchId !== batchId || ledger.projectPath !== path.resolve(projectDir)) return null;
    const name = typeof ledger.forgeBak === 'string' ? ledger.forgeBak : (typeof hintName === 'string' ? hintName : null);
    if (!name) return null;
    if (!/^settings\.json\.forge-bak-[A-Za-z0-9._-]+$/.test(name)) return 'kept ' + name + ' (not a plain settings.json.forge-bak-* name directly in .claude/)';
    const bak = path.join(dirs.dst, name);
    const st = fileStatus(bak);
    if (st.kind === 'missing') return 'already gone: ' + name;
    if (st.kind !== 'ok' || isSymlinkPath(bak) || !containmentSafe(dirs.dst, bak)) return 'kept ' + name + ' (not a plain file inside .claude/)';
    const want = pre && pre.kind === 'ok' ? pre.hash : null;
    if (!want || st.hash !== want || st.hash !== ledger.preHash) return 'kept ' + name + ' (it does not hold exactly the pre-sync bytes)';
    const q = quarantineAndVerify(bak, st.hash);
    return q.removed ? 'removed ' + name + ' (this batch\'s merge backup; the batch keeps settings-pre/settings.json)' : 'kept ' + name + ' (' + q.reason + ')';
  } catch (e) { return 'kept the merge backup (' + e.message + ')'; }
}
/** restoreSettingsInRun(projectDir, batchId, pre) -> {ok, action, error?, conflict?, quarantined?, ledgerSaid?, forgeBak?} — R11-02 /
 *  R11-05. The settings.json step of every IN-RUN rollback (a failed or throwing validation, settings changed during validation, an
 *  unresolved-drift refusal). It runs FIRST, before the files: it needs no other file, and the merged settings.json names hook files
 *  the file restore is about to remove. `pre` = the rollback target (settingsRollbackTarget): the snapshot read under this run's lock
 *  right before the merge (bytes in memory), or on a --resume-batch the ledger's recorded pre-sync state.
 *   1. settings.json holds exactly what this batch's merge wrote (or the merge wrote nothing) -> undoSettingsMerge, unchanged
 *      (byte-for-byte from the batch copy or the .forge-bak; a file this sync created is removed).
 *   2. anything else that is not the pre-sync state — rewritten during this run's validation (a doctor suite, an isolated re-run),
 *      a merge whose bytes were never confirmed, or a file that changed although the merge did not apply — putBackPreSyncSettings:
 *      the bytes found there are MOVED into the batch backup (verified, never deleted) and the pre-sync bytes are written back.
 *      (A later manual `rollback` keeps its stricter rule: a changed settings.json is a conflict there, never overwritten.)
 *  Once settings.json verifiably holds the pre-sync bytes, this batch's own .forge-bak is removed (removeOwnForgeBak). Never throws. */
function restoreSettingsInRun(projectDir, batchId, pre) {
  try {
    if (!pre || pre.kind === 'unreadable') return undoSettingsMerge(projectDir, batchId); // no pre-sync bytes in hand: the ledger rules alone
    const plain = undoSettingsMerge(projectDir, batchId);
    let result;
    if (plain.ok !== false && sameSettingsState(settingsSnapshot(projectDir, false), pre)) result = plain;
    else {
      result = putBackPreSyncSettings(projectDir, batchId, pre);
      if (plain.ok === false && plain.error) result.ledgerSaid = plain.error;
    }
    if (result.ok !== false && sameSettingsState(settingsSnapshot(projectDir, false), pre)) {
      const fb = removeOwnForgeBak(projectDir, batchId, pre);
      if (fb) result.forgeBak = fb;
    }
    return result;
  } catch (e) { return { ok: false, action: 'none', error: 'restoring settings.json threw (' + e.message + ')' }; }
}
/** settleUnconfirmedSettingsMerge(projectDir, batchId, pre, merge, centralDir) -> the settingsMerge result to use from here on — R11-04.
 *  A merge step that threw — possibly AFTER the merge tool had already written settings.json — or whose ledger could not be finalised
 *  (ledgerWarning) leaves the ledger 'pending' with postHash null. The doctor would then judge merged bytes reported as "not merged",
 *  an in-run rollback could not prove them to be its own, and a later `rollback` of the batch would call settings.json "changed since
 *  this sync started merging it" and refuse the WHOLE batch. Under this run's lock and quiesce the pre-sync bytes are known, so they
 *  are put back (putBackPreSyncSettings: whatever the tool wrote goes into the batch backup, never deleted) and the ledger is then
 *  marked as a merge that did NOT apply (status 'reverted', applied:false, postHash null), so the batch no longer claims settings.json.
 *  When the bytes cannot be put back the ledger stays pending and a later rollback reports the conflict. The merge is reported as
 *  refused (ok:false) — never a settings change without a confirmed undo record. Never throws. */
function settleUnconfirmedSettingsMerge(projectDir, batchId, pre, merge, centralDir) {
  const threw = merge.skipped === 'merge-error';
  const why = threw ? 'the merge step threw (' + (merge.error || 'unknown error') + ')' : String(merge.ledgerWarning);
  const put = putBackPreSyncSettings(projectDir, batchId, pre);
  let ledgerMark = 'not marked (settings.json could not be put back — the ledger stays pending, so a later rollback reports the conflict)';
  if (put.ok) {
    // the merge's own .forge-bak: named by a ledger that WAS finalised before a throw, or by this run's in-memory ledger (ledgerWarning)
    const fb = removeOwnForgeBak(projectDir, batchId, pre, merge.ledger && merge.ledger.forgeBak);
    try {
      const dirs = settingsLedgerDirs(projectDir, batchId);
      let ledger = null;
      if (dirs.ok) { try { ledger = JSON.parse(fs.readFileSync(dirs.ledgerPath, 'utf8')); } catch { ledger = null; } }
      if (ledger && ledger.batchId === batchId && ledger.projectPath === path.resolve(projectDir) && ledger.rel === 'settings.json') {
        const marked = Object.assign({}, ledger, {
          status: 'reverted', applied: false, changed: false, postHash: null, postHashSource: null, forgeBak: null,
          mergeStatus: 'reverted after an unconfirmed merge — ' + why + '; settings.json was put back to its pre-sync bytes, unchanged by this batch',
          revert: { action: put.action, quarantined: put.quarantined || null, forgeBak: fb || null, at: new Date().toISOString() },
        });
        writeAtomic(dirs.ledgerPath, JSON.stringify(marked, null, 2) + '\n');
        patchBatchManifestSettings([dirs.bdir, centralDir], marked);
        ledgerMark = 'marked reverted (this batch does not own settings.json)';
      } else ledgerMark = 'no ledger of this batch to mark (nothing recorded)';
    } catch (e) {
      ledgerMark = 'could not be marked (' + e.message + ') — it stays pending; settings.json holds the pre-sync bytes, which a later rollback reads as unchanged';
    }
  }
  const head = threw ? merge.message : 'settings.json merge could not be confirmed: ' + why;
  return {
    ok: false, status: 'refused', skipped: threw ? 'merge-error' : 'ledger-unconfirmed', error: threw ? merge.error : merge.ledgerWarning,
    message: head + ' — ' + (put.ok ? 'settings.json ' + put.action : 'and it could NOT be put back to its pre-sync bytes (' + put.error + ')') + '; the settings ledger: ' + ledgerMark,
    settle: { put, ledgerMark },
  };
}
/** filesRestoreProblem(restored, rollbackError) -> null | one plain line: why the in-run FILE restore is not confirmed. */
function filesRestoreProblem(restored, rollbackError) {
  if (rollbackError) return 'the file restore threw (' + rollbackError + ')';
  if (!restored) return 'the file restore did not run';
  if (restored.ok !== false) return null;
  if (restored.refusedDivergence) return 'the file restore was REFUSED: ' + (restored.diverged || []).length + ' file(s) changed since this sync wrote them (' + (restored.diverged || []).slice(0, 6).map((d) => d.rel).join(', ') + ') — kept, never overwritten';
  if (restored.refusedManifest) return 'the file restore was REFUSED (' + (restored.reason || 'the backup manifest was not trusted') + ')';
  if (restored.partial) return 'partial restore: ' + (restored.failed || []).length + ' file(s) failed to restore or verify';
  return 'the file restore was not confirmed';
}

// ---- coupled delivery (fleet risk) ----------------------------------------------------------------------------
const COUPLED_DELIVERY_GROUPS = [{
  id: 'completion-trio',
  rels: ['forge-dashboard/log-event.cjs', 'forge-bin/forge-verify.cjs', 'forge-bin/forge-runcontract.cjs'],
  why: 'log-event.cjs (the event writer and its completion gate), forge-verify.cjs (the verify loop, which mirrors the writer\'s event-type registry) and forge-runcontract.cjs (the run contract that judges those events) share one event vocabulary. A project that receives a new writer with an old checker, or the reverse, rejects or misjudges its own completions — so the three are only ever delivered together.',
}];
/** coupledDeliveryCheck(templateDir, projectDir, plan) -> {ok, groups[], reason}. For every coupled group: when the
 *  plan changes ANY member, every other member the template ships must also be changed by the plan or already be
 *  byte-identical to the template ("the project already holds matching versions"). A member left behind (declared in
 *  forge-overrides.json, unknown drift or a conflict without --force-overwrite, skipped, unreadable, or MISSING in the
 *  project) refuses the whole install before anything is written.
 *  a member the template LACKS no longer switches the guard off. When the template
 *  ships some of the trio but not all of it, or the project holds a member the template lacks, the install refuses with a
 *  plain "missing in the template" reason — a partial trio can never be delivered. Only a template AND project that hold
 *  none of the trio at all (a minimal fixture, a template without the completion machinery) are outside the check. */
function coupledDeliveryCheck(templateDir, projectDir, plan) {
  const dst = claudeDirOf(projectDir);
  plan = plan || {};
  const toChange = new Map((plan.toChange || []).map((e) => [e.rel, e]));
  const heldReason = (rel) => {
    if ((plan.expectedOverrides || []).includes(rel)) return 'declared in forge-overrides.json — kept as the project has it';
    if ((plan.unknownDrift || []).includes(rel)) return 'changed in this project since the last sync (unknown drift, not overwritten without --force-overwrite)';
    if ((plan.conflicts || []).includes(rel)) return 'changed in both the project and the template (conflict, not overwritten without --force-overwrite)';
    const sk = (plan.skipped || []).find((s) => s.rel === rel);
    if (sk) return 'skipped (' + sk.reason + ')';
    const un = (plan.unreadable || []).find((u) => u.rel === rel);
    if (un) return 'unreadable (' + un.error + ')';
    return 'differs from the template and is not in this plan';
  };
  const groups = COUPLED_DELIVERY_GROUPS.map((g) => {
    let projectHasAny = false;
    const members = g.rels.map((rel) => {
      const tplHash = sha256(path.join(templateDir, ...rel.split('/')));
      const out = safeJoin(dst, rel);
      const st = out && !isSymlinkPath(out) ? fileStatus(out) : { kind: 'unreadable' };
      if (st.kind !== 'missing') projectHasAny = true;
      if (tplHash === null) return { rel, outcome: 'missing-in-template', reason: 'the template has no copy of it' };
      const e = toChange.get(rel);
      if (e) return { rel, outcome: e.oldHash === null ? 'add' : 'update' };
      if (st.kind === 'ok' && st.hash === tplHash) return { rel, outcome: 'current' };
      return { rel, outcome: 'held', reason: st.kind === 'missing' ? 'missing in the project and not in this plan' : heldReason(rel) };
    });
    const missingTpl = members.filter((m) => m.outcome === 'missing-in-template');
    const changing = members.filter((m) => m.outcome === 'add' || m.outcome === 'update').map((m) => m.rel);
    const held = members.filter((m) => m.outcome === 'held');
    // none of the trio anywhere (template and project) -> not applicable; otherwise every member must be in the template
    const notApplicable = missingTpl.length === g.rels.length && !projectHasAny;
    const ok = notApplicable || (missingTpl.length === 0 && (changing.length === 0 || held.length === 0));
    return { id: g.id, why: g.why, members, changing, held: held.map((m) => m.rel), missingInTemplate: missingTpl.map((m) => m.rel), notApplicable, ok };
  });
  const bad = groups.filter((g) => !g.ok);
  const describe = (g) => (g.missingInTemplate.length
    ? g.id + ': the template is MISSING ' + g.missingInTemplate.join(', ') + ' — the template must ship all of ' + g.members.map((m) => m.rel).join(', ') + ' (fix the template: ' + PUBLISH_TEMPLATE_HINT + ')'
    : g.id + ' would update ' + g.changing.join(', ') + ' but leave ' + g.members.filter((m) => m.outcome === 'held').map((m) => m.rel + ' (' + m.reason + ')').join(', '));
  return {
    ok: bad.length === 0, groups,
    reason: bad.length ? 'refusing to sync: coupled delivery — ' + bad.map(describe).join('; ')
      + '. These files are only ever delivered together: resolve the held/missing file(s) (or update none of them) and re-run — nothing was written' : null,
  };
}

// ---- provenance -------------------------------------------------------------------------------------------
/** templateProvenance(templateDir) -> {devCommit, dirty, source, file, publishedAt}. Which development commit this
 *  template was published from: (1) a template-provenance.json {devCommit, dirty?, publishedAt?} inside the template's
 *  .claude or its home folder ('s publish-template writes it); else (2) git, ONLY when the template's home folder is
 *  itself the top of a git work tree (a dev tree used as the template via FORGE_SYNC_TEMPLATE_DIR) — a repository
 *  further up (e.g. a home folder under git) is never mistaken for it; else (3) unknown. Never throws. */
function templateProvenance(templateDir) {
  const tdir = path.resolve(templateDir);
  const home = path.dirname(tdir);
  for (const f of [path.join(tdir, 'template-provenance.json'), path.join(home, 'template-provenance.json')]) {
    let p;
    try { p = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const c = p && typeof p.devCommit === 'string' ? p.devCommit.trim() : '';
    if (/^[0-9a-f]{7,64}$/i.test(c)) return { devCommit: c, dirty: typeof p.dirty === 'boolean' ? p.dirty : null, source: 'template-provenance.json', file: f, publishedAt: typeof p.publishedAt === 'string' ? p.publishedAt : null };
  }
  const git = (args) => {
    try {
      const r = spawnSync('git', ['--no-optional-locks', '-C', home].concat(args), { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      return r.status === 0 && !r.error ? String(r.stdout).trim() : null;
    } catch { return null; }
  };
  const top = git(['rev-parse', '--show-toplevel']);
  if (top) {
    let same = false;
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p); // NTFS is case-insensitive; POSIX is not
    try { same = norm(fs.realpathSync.native(path.resolve(top))) === norm(fs.realpathSync.native(home)); } catch { same = false; }
    if (same) {
      const head = git(['rev-parse', '--verify', '-q', 'HEAD']);
      if (head && /^[0-9a-f]{7,64}$/i.test(head)) {
        const st = git(['status', '--porcelain', '--', path.basename(tdir)]);
        return { devCommit: head, dirty: st == null ? null : st.length > 0, source: 'git', file: null, publishedAt: null };
      }
    }
  }
  return { devCommit: null, dirty: null, source: 'unknown', file: null, publishedAt: null };
}
/** provenanceFor(templateDir, projectDir) -> {devCommitFrom, devCommitTo, source, dirty}. devCommitFrom is the commit the
 *  project was last synced to (its FORGE_VERSION.json, else its receipt), null when never recorded. */
function provenanceFor(templateDir, projectDir) {
  const tp = templateProvenance(templateDir);
  let from = null;
  try { const v = JSON.parse(fs.readFileSync(versionFilePath(projectDir), 'utf8')); if (v && typeof v.devCommitTo === 'string') from = v.devCommitTo; } catch { /* none */ }
  if (!from) { const rc = readReceipt(projectDir); if (rc && rc.provenance && typeof rc.provenance.devCommitTo === 'string') from = rc.provenance.devCommitTo; }
  return { devCommitFrom: from, devCommitTo: tp.devCommit, source: tp.source, dirty: tp.dirty, publishedAt: tp.publishedAt };
}

// ---- install --dry-run --json -----------------------------------------------------------------------------
/** previewProjectScaffold(templateDir, projectDir) — a read-only twin of seedProjectScaffold: what a real install would do
 *  to the root .gitignore and CLAUDE.md. Writes nothing. */
function previewProjectScaffold(templateDir, projectDir) {
  const out = { gitignore: { action: 'template-missing' }, claudeMd: { action: 'template-missing' } };
  const tplHome = path.dirname(path.resolve(templateDir));
  const root = path.resolve(projectDir);
  const kind = (name) => {
    try { const st = fs.lstatSync(path.join(root, name)); return st.isSymbolicLink() ? 'symlink' : (st.isFile() ? 'file' : 'other'); }
    catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  };
  const refusal = (k) => (k === 'symlink' ? 'the target is a symlink — never written through' : (k === 'other' ? 'the target exists but is not a regular file' : 'the target cannot be read'));
  try {
    const snippetPath = path.join(tplHome, 'gitignore.snippet');
    if (fs.existsSync(snippetPath)) {
      const snippet = fs.readFileSync(snippetPath, 'utf8');
      const k = kind('.gitignore');
      if (k === 'absent') out.gitignore = { action: 'create', lines: snippet.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')) };
      else if (k !== 'file') out.gitignore = { action: 'refused', reason: refusal(k) };
      else {
        const existing = new Set(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
        const missing = snippet.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !existing.has(l));
        out.gitignore = missing.length ? { action: 'append', linesToAppend: missing } : { action: 'unchanged' };
      }
    }
  } catch (e) { out.gitignore = { action: 'error', reason: e.message }; }
  try {
    if (fs.existsSync(path.join(tplHome, 'CLAUDE.md'))) {
      const k = kind('CLAUDE.md');
      out.claudeMd = k === 'absent' ? { action: 'create' } : (k === 'file' ? { action: 'unchanged' } : { action: 'refused', reason: refusal(k) });
    }
  } catch (e) { out.claudeMd = { action: 'error', reason: e.message }; }
  return out;
}
/** settingsDelta(templateDir, r) — the settings.json change in reviewable form: every hook command that becomes active
 *  (event, matcher, command), every hook command/timeout that changes, every deny rule added. For a settings.json that
 *  does not exist yet ('would-create'/'created') that is the template's whole hook + deny set. */
function settingsDelta(templateDir, r) {
  if (!r) return { status: 'not-run', hooksAdded: [], hooksChanged: [], denyAdded: [] };
  if (r.skipped && !r.status) return { status: 'skipped', reason: r.skipped, error: r.error || null, hooksAdded: [], hooksChanged: [], denyAdded: [] };
  let addedRows = r.added_detail, deny = r.deny_added, upgraded = r.upgraded, adjusted = r.adjusted;
  const out = { status: r.status || (r.skipped ? 'skipped' : 'unknown'), message: r.message || null, backupPath: r.backupPath || null };
  if (r.status === 'would-create' || r.status === 'created') {
    try {
      const mt = require('./forge-settings-merge.cjs');
      const src = JSON.parse(fs.readFileSync(path.join(templateDir, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
      const m = mt.mergeForgeSettings({}, src);
      addedRows = m.added_detail; deny = m.deny_added; upgraded = []; adjusted = [];
    } catch (e) { out.error = 'could not enumerate the template settings.json: ' + e.message; }
  }
  out.hooksAdded = (addedRows || []).map((h) => ({ event: h.event, matcher: h.matcher, command: h.command, kind: h.kind }));
  if (!r.added_detail && Array.isArray(r.added) && r.added.length && r.status !== 'would-create' && r.status !== 'created') out.hooksAddedText = r.added.slice(); // an older merge tool without added_detail
  out.hooksChanged = (upgraded || []).map((u) => ({ kind: 'command-upgrade', event: u.event, matcher: u.matcher, from: u.from, to: u.to }))
    .concat((adjusted || []).map((a) => ({ kind: 'timeout-fix', event: a.event, matcher: a.matcher, command: a.command, from: a.from, to: a.to })));
  out.denyAdded = (deny || []).slice();
  return out;
}
/** installPlanJson(templateDir, projectDir, r) — the full machine-readable plan from a safeSyncProject dry-run result
 *  `r`: one row per file (add | update | current | seed-created | seed-kept | drift | conflict | override | held |
 *  skipped | unreadable | missing-in-template | orphan) with hashes and sizes, the scaffold preview, the settings delta,
 *  the orphans, the coupled-delivery verdict and the provenance. Writes nothing. */
function installPlanJson(templateDir, projectDir, r) {
  const abs = path.resolve(projectDir);
  const dst = claudeDirOf(abs);
  const base = { schema: 'forge-sync-install-plan/v1', generatedAt: new Date().toISOString(), dryRun: true, project: abs, template: path.resolve(templateDir) };
  if (!r || !r.plan) return Object.assign(base, { ok: false, wouldRefuse: (r && r.reason) || 'no plan could be computed', files: [], counts: {} });
  const plan = r.plan;
  const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return null; } };
  const files = [];
  const seen = new Set();
  const row = (rel, action, extra) => {
    seen.add(rel);
    const oldSize = sizeOf(path.join(dst, ...rel.split('/'))), newSize = sizeOf(path.join(templateDir, ...rel.split('/')));
    files.push(Object.assign({ rel, action, oldSize, newSize, sizeDelta: oldSize != null && newSize != null ? newSize - oldSize : null }, extra || {}));
  };
  const hashes = (rel) => ({ oldHash: sha256(path.join(dst, ...rel.split('/'))), newHash: sha256(path.join(templateDir, ...rel.split('/'))) });
  for (const e of plan.toChange) row(e.rel, e.overrideClass === 'seed' ? 'seed-created' : (e.oldHash === null ? 'add' : 'update'), Object.assign({ oldHash: e.oldHash, newHash: e.newHash, overrideClass: e.overrideClass || null }, e.historyMatch ? { historyMatch: e.historyMatch } : {}, e.acceptedFrom ? { acceptedFrom: e.acceptedFrom } : {})); // WP-SYNC-R7
  for (const rel of plan.expectedOverrides || []) row(rel, 'override', Object.assign(hashes(rel), { reason: 'declared in forge-overrides.json — never touched' }));
  for (const rel of plan.unknownDrift || []) row(rel, 'drift', Object.assign(hashes(rel), { reason: 'changed in the project since the last sync, and not a version the template ever had — blocked without --accept-template <rel> or --force-overwrite' }));
  for (const rel of plan.conflicts || []) row(rel, 'conflict', Object.assign(hashes(rel), { reason: 'changed in both the project and the template — blocked without --accept-template <rel> or --force-overwrite' }));
  for (const s of plan.skipped || []) row(s.rel, /pending-migration$/.test(s.reason) ? 'held' : 'skipped', { reason: s.reason });
  for (const u of plan.unreadable || []) row(u.rel, 'unreadable', { reason: u.error });
  for (const s of plan.seedKept || []) row(s.rel, 'seed-kept', { reason: s.reason });
  for (const m of plan.missingInTemplate || []) if (!seen.has(m.rel)) row(m.rel, 'missing-in-template', { class: m.class, blocking: (plan.missingBlocking || []).some((x) => x.rel === m.rel) });
  let system = [];
  try { system = listSystemFiles(templateDir); } catch { /* the plan already exists, so the template was readable a moment ago */ }
  for (const rel of system) if (!seen.has(rel)) row(rel, 'current');
  for (const rel of plan.seedRels || []) if (!seen.has(rel)) row(rel, 'seed-kept', { reason: 'identical to the template default' });
  const orphans = r.orphans || { unmodified: [], modified: [] };
  for (const o of orphans.unmodified || []) if (!seen.has(o.rel)) row(o.rel, 'orphan', { modified: false, reason: 'the template no longer ships it; unmodified since forge-sync wrote it (install --retire-orphans moves it into the batch backup)' });
  for (const o of orphans.modified || []) if (!seen.has(o.rel)) row(o.rel, 'orphan', { modified: true, reason: o.reason });
  files.sort((a, b) => (a.rel < b.rel ? -1 : (a.rel > b.rel ? 1 : 0)));
  const counts = {};
  for (const f of files) counts[f.action] = (counts[f.action] || 0) + 1;
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(versionFilePath(abs), 'utf8')).forge_version || null; } catch { /* none */ }
  const rp = r.retiredPrune || {};
  const wouldRefuse = r.wouldRefuse || (r.refused ? r.reason : null) || null;
  return Object.assign(base, {
    ok: !wouldRefuse, wouldRefuse,
    templateVersion: r.templateVersion || null, installedVersion: installed, provenance: r.provenance || null,
    shipManifest: plan.shipManifest || null, counts, files,
    scaffold: r.scaffoldPreview || null,
    settings: settingsDelta(templateDir, r.settingsMerge),
    orphans: { unmodified: (orphans.unmodified || []).map((o) => o.rel), modified: (orphans.modified || []).map((o) => ({ rel: o.rel, reason: o.reason })) },
    retiredPrune: { removable: (rp.removable || []).map((x) => x.rel), kept: rp.kept || [] },
    coupledDelivery: r.coupledDelivery || null,
    migrations: r.migrations || null,
    missingInTemplate: plan.missingInTemplate || [], neverTouchClaimed: plan.neverTouchClaimed || [],
    acceptTemplate: plan.acceptTemplate || null, // WP-SYNC-R7 item 1
    templateHistoryMatches: (plan.toChange || []).filter((e) => e.overrideClass === 'template_history').map((e) => ({ rel: e.rel, by: e.historyMatch || null })),
    note: 'dry-run: nothing was written; a real install additionally needs quiesce-check to pass and re-verifies the protect manifest after its last write',
  });
}

// ---- forge-sync-report-<batch>.md -------------------------------------------------------------------------
function reportArea(rel) {
  const segs = String(rel).split('/');
  if (segs.length === 1) return '.claude (top level)';
  if (segs[0] === 'skills' && segs.length > 2) return 'skills/' + segs[1];
  return segs[0];
}
/** changedFileLabel(e) — how one toChange entry is described in the change report. */
function changedFileLabel(e) {
  if (e.overrideClass === 'seed') return 'created (seed)';
  if (e.oldHash === null) return 'added';
  if (e.overrideClass === 'unknown_drift' || e.overrideClass === 'conflict') return 'FORCED over ' + e.overrideClass;
  if (e.overrideClass === 'accepted_template') return 'REPLACED by the template version (--accept-template, was ' + (e.acceptedFrom || 'drift') + ')'; // WP-SYNC-R7
  if (e.overrideClass === 'template_history') return 'updated (an unmodified earlier template copy — ' + (e.historyMatch || 'template history') + ')'; // WP-SYNC-R7
  if (e.overrideClass === 'eol_only') return 'updated (line endings only)';
  return 'updated';
}
function doctorLine(v) {
  if (!v) return 'not run';
  if (v.reused) return 'reused from the previous receipt (not re-run)';
  if (v.skipped) return 'not run (' + v.skipped + ')';
  const s = v.summary;
  const parts = [(v.tool || '?') + ' ' + (v.timedOut ? 'TIMED OUT' : (v.ok ? 'OK' : 'NOT OK'))];
  if (v.degraded) parts.push('degraded');
  if (s && s.tests) parts.push('tests: ' + (s.tests.passed != null ? s.tests.passed : '?') + ' passed, ' + (s.tests.failed || 0) + ' failed, ' + (s.tests.suites != null ? s.tests.suites : '?') + ' suite(s)');
  if (s && s.node_check) parts.push('node --check: ' + (s.node_check.total != null ? s.node_check.total : '?') + ' file(s)');
  if (s && s.checksOk) { const red = Object.keys(s.checksOk).filter((k) => !s.checksOk[k].ok); if (red.length) parts.push('red checks: ' + red.join(', ')); }
  // WP-SYNC-R7 item 2: the FULL failing-suite list (it used to stop at 8 names), with the count
  if (s && Array.isArray(s.failing_suites) && s.failing_suites.length) parts.push('failing suites (' + s.failing_suites.length + '): ' + s.failing_suites.join(', '));
  if (s && s.suiteOk && typeof s.suiteOk === 'object') parts.push(Object.keys(s.suiteOk).length + ' suite(s) listed by name');
  // WP-SYNC-R7 item 4: how long the doctor really ran, and under which limit
  if (Number.isFinite(v.durationMs)) parts.push('took ' + Math.round(v.durationMs / 1000) + ' s' + (Number.isFinite(v.timeoutMs) ? ' (limit ' + Math.round(v.timeoutMs / 1000) + ' s, ' + (v.timeoutSource || 'unknown') + ')' : ''));
  return parts.join(' · ');
}
/** fencedBlock(lines) — a markdown code fence longer than any backtick run inside the (untrusted) lines, so a line can never
 *  close the block early. */
function fencedBlock(lines) {
  let fence = '```';
  const body = lines.join('\n');
  while (body.includes(fence)) fence += '`';
  return [fence + 'text'].concat(lines, [fence]);
}
/** suiteCheckReportLines(sc) — WP-SYNC-R9: the "Suite regression check" subsection under Doctor (empty when nothing was flagged):
 *  per flagged suite how it regressed, the doctor run's outcome, the isolated outcome, durations and the failing lines. */
function suiteCheckReportLines(sc) {
  // WP-SYNC-R10: a re-run step that THREW is reported too (it has no suites; the rollback still ran)
  if (sc && sc.mode === 'error') return ['### Suite regression check (isolated re-run)', '', '- **FAILED** — ' + sc.decision, ''];
  if (!sc || !Array.isArray(sc.suites) || !sc.suites.length) return [];
  const q = (s) => '`' + String(s).replace(/`/g, "'") + '`';
  const sec = (ms) => (Number.isFinite(ms) ? (ms < 10000 ? (Math.round(ms / 100) / 10) + ' s' : Math.round(ms / 1000) + ' s') : null);
  const L = ['### Suite regression check (isolated re-run)', ''];
  L.push('- Mode: ' + (sc.mode === 'rerun' ? 'each flagged suite re-run ONCE, alone and one after the other, from the synced project (`node .claude/forge-bin/<suite>`, cwd = the project folder, limit ' + sec(sc.timeoutMs) + ' — ' + sc.timeoutSource + (Number.isFinite(sc.budgetMs) ? '; the whole re-run phase capped at ' + sec(sc.budgetMs) + ' — ' + sc.budgetSource : '') + ')'
    : (sc.mode === 'disabled' ? '**disabled** (--no-isolated-rerun) — every flagged suite counts as a regression, as before' : '**not re-run** — ' + sc.notEligibleReason)));
  // 'ROLLBACK' (not "rolled back"): the decision is made before the restore runs — whether it completed is under "Rollback"
  L.push('- Decision: **' + (sc.kept ? 'KEPT' : 'ROLLBACK') + '** — ' + sc.decision);
  if (Number.isFinite(sc.doctorDurationMs)) L.push('- The doctor run these suites failed in took ' + sec(sc.doctorDurationMs) + ' in total (forge-doctor --json reports no per-suite time; a per-suite figure below comes from its own duration hint when it ran pooled).');
  if (sc.env) L.push('- Environment of the re-runs: only an allow-list of ' + sc.env.kept.length + ' variable(s) (' + sc.env.kept.join(', ') + '); ' + sc.env.dropped + ' other variable(s) dropped — ' + sc.env.allowList + '.');
  if (Number.isFinite(sc.phaseMs)) L.push('- The re-run phase took ' + sec(sc.phaseMs) + '. A suite that timed out inside the doctor run is never re-run (a hang under load is not accepted as flaky).');
  if (sc.honesty) L.push('- **Honesty note:** ' + sc.honesty + '. Watch ' + (sc.flakyUnderLoad.length === 1 ? 'it' : 'them') + ' on the next sync.');
  if (sc.heuristic) L.push('- **Heuristic:** ' + sc.heuristic + '.');
  L.push('');
  for (const s of sc.suites) {
    const fr = s.firstRun || {};
    const iso = s.isolated;
    L.push('#### ' + q(s.suite) + ' — ' + s.kind + ' → **' + (s.classification === 'flaky-under-load' ? 'flaky-under-load' : 'regression') + '**');
    L.push('- Inside the doctor run: ' + (fr.timedOut ? 'blocked / timed out' : (fr.passed != null ? fr.passed : '?') + ' passed, ' + (fr.failed != null ? fr.failed : '?') + ' failed')
      + ' · duration ' + (fr.durationMs != null ? sec(fr.durationMs) + ' (' + fr.durationSource + ')' : fr.durationSource || 'not reported'));
    L.push('- Alone: ' + (iso ? (iso.healthy ? 'exit 0, ' + iso.passed + ' passed, 0 failed' : isolatedVerdict(iso)) + (sec(iso.durationMs) ? ' · took ' + sec(iso.durationMs) : '') + (iso.runner ? ' · runner ' + iso.runner : '') : 'not run') + (s.reason ? ' — ' + s.reason : ''));
    if (fr.lines && fr.lines.length) { L.push('- Failing lines the doctor kept (at most 5 per suite):', ''); for (const l of fencedBlock(fr.lines)) L.push(l); L.push(''); }
    else if (!fr.linesWithheld) L.push('- The doctor kept no failing line for this suite' + (fr.timedOut ? ' (it was stopped at its limit)' : '') + '.');
    if (iso && !iso.healthy && iso.lines.length) { L.push('- Failing lines of the isolated run:', ''); for (const l of fencedBlock(iso.lines)) L.push(l); L.push(''); }
    else if (iso && !iso.healthy && iso.tail.length) { L.push('- The isolated run printed no FAIL line; its error / last output lines:', ''); for (const l of fencedBlock(iso.tail)) L.push(l); L.push(''); }
    if (fr.linesWithheld || (iso && iso.linesWithheld)) L.push('- Failing lines withheld: ' + SCRUBBER_MISSING_REASON + '.');
    if (iso && iso.outputWithheld) L.push('- Output withheld: ' + iso.outputWithheld + '.');
    const pcl = iso ? projectChangesLine(iso.projectChanges) : null; // WP-SYNC-R10
    if (pcl) L.push('- The isolated run: ' + pcl + '.');
  }
  L.push('');
  return L;
}
/** buildSyncReport(d) — the human-readable change report for one batch (plain markdown). `d` carries what the run
 *  already knows: project, batch, outcome, versions, provenance, plan, settings result, orphans, coupled verdict,
 *  doctor before/after, quiesce record, protect verdict, rollback result. */
function buildSyncReport(d) {
  const L = [];
  const q = (s) => '`' + String(s) + '`';
  const plan = d.plan || { toChange: [] };
  L.push('# Forge sync report — batch ' + d.batchId, '');
  L.push('- Project: ' + q(path.resolve(d.projectDir)));
  L.push('- Outcome: **' + d.outcome + '**' + (d.reason ? ' — ' + d.reason : ''));
  L.push('- When: ' + (d.nowIso || new Date().toISOString()) + (d.runId ? ' · run ' + q(d.runId) : ''));
  L.push('- Template: ' + q(d.templateDir) + ' · version ' + (d.templateVersionFrom || '(none)') + ' → ' + (d.templateVersionTo || '?'));
  const pv = d.provenance || {};
  L.push('- Development commits: ' + (pv.devCommitFrom || '(unknown)') + ' → ' + (pv.devCommitTo || '(unknown)') + ' (source: ' + (pv.source || 'unknown') + (pv.dirty === true ? '; the template tree had uncommitted changes' : '') + ')');
  if (d.backupDir) L.push('- Backup: ' + q(d.backupDir) + ' — undo with ' + q('node forge-sync.cjs rollback "' + path.resolve(d.projectDir) + '" --batch ' + d.batchId));
  L.push('');
  L.push('## Quiesce (was the project idle?)', '');
  if (!d.quiesce) L.push('- Not checked by this call (library use, a dry-run, or sync-all — only `install` requires it).');
  else {
    L.push('- Idle: ' + (d.quiesce.idle ? 'yes' : 'NO') + (d.quiesce.checkedAt ? ' (checked ' + d.quiesce.checkedAt + ', window ' + d.quiesce.idleMin + ' min)' : ''));
    for (const r of d.quiesce.reasons || []) L.push('  - ' + r);
    if (d.quiesce.override) L.push('- **Quiesce override recorded:** ' + d.quiesce.override);
  }
  L.push('');
  const changed = plan.toChange || [];
  L.push('## Changed files (' + changed.length + '), by area', '');
  const byArea = new Map();
  for (const e of changed) { const a = reportArea(e.rel); if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(e); }
  if (!changed.length) L.push('- none');
  for (const a of [...byArea.keys()].sort()) {
    L.push('### ' + a + ' (' + byArea.get(a).length + ')');
    for (const e of byArea.get(a)) L.push('- ' + changedFileLabel(e) + ' ' + q(e.rel));
  }
  L.push('');
  // WP-SYNC-R7 item 1: the per-file --accept-template decisions, and the files that matched an earlier template version
  const at = plan.acceptTemplate;
  if (at) {
    L.push('## Accepted template versions (--accept-template)', '');
    L.push('- Requested: ' + (at.requested.map(q).join(', ') || 'none'));
    L.push('- Replaced by the template version (the old copy is in the batch backup): ' + (at.accepted.map((x) => q(x.rel) + ' (was ' + x.was + ')').join(', ') || 'none'));
    if (at.unused.length) L.push('- Not needed (not drifted): ' + at.unused.map((x) => q(x.rel)).join(', '));
    if (at.refused.length) L.push('- **Refused:** ' + at.refused.map((x) => q(x.rel) + ' — ' + x.reason).join('; '));
    L.push('');
  }
  const hist = changed.filter((e) => e.overrideClass === 'template_history');
  if (hist.length) {
    L.push('## Earlier template copies (no baseline needed)', '');
    L.push('- These files had no forge-sync baseline (or a different one) but their bytes equal a version the template itself once had, so they are unmodified Forge copies and were updated like any other file:');
    for (const e of hist) L.push('  - ' + q(e.rel) + ' — matched ' + (e.historyMatch || '?') + (e.historySource ? ' (' + e.historySource + ')' : ''));
    L.push('');
  }
  if (d.devTreeOverride) { L.push('## Development tree', '', '- **This target is a Forge development tree; synced anyway under --allow-dev-tree-target:** ' + d.devTreeOverride, ''); }
  L.push('## settings.json', '');
  const sd = d.settingsDelta;
  if (!sd) L.push('- not touched by this batch');
  else {
    L.push('- Status: ' + sd.status + (sd.backupPath ? ' · merge backup ' + q(sd.backupPath) : '') + (d.settingsLedger ? ' · undo record in the batch (pre-merge hash ' + String(d.settingsLedger.preHash || 'none — created').slice(0, 16) + ')' : ''));
    if (sd.message) L.push('- ' + sd.message);
    L.push('- Hook commands added (' + (sd.hooksAdded || []).length + '):');
    for (const h of sd.hooksAdded || []) L.push('  - ' + h.event + (h.matcher != null ? '[' + h.matcher + ']' : '') + ': ' + q(h.command));
    L.push('- Hook commands changed (' + (sd.hooksChanged || []).length + '):');
    for (const h of sd.hooksChanged || []) L.push('  - ' + h.event + (h.matcher != null ? '[' + h.matcher + ']' : '') + ' ' + h.kind + ': ' + q(h.from) + ' → ' + q(h.to));
    L.push('- Deny rules added (' + (sd.denyAdded || []).length + '): ' + ((sd.denyAdded || []).map(q).join(', ') || 'none'));
  }
  if (d.settingsDrift) L.push('- **Changed during validation — not committed:** ' + d.settingsDrift.reason); // WP-SYNC-R12
  L.push('');
  L.push('## Kept as the project has them', '');
  L.push('- Protected overrides (forge-overrides.json): ' + ((plan.expectedOverrides || []).map(q).join(', ') || 'none'));
  L.push('- Seed files kept: ' + ((plan.seedKept || []).map((s) => q(s.rel)).join(', ') || 'none'));
  const held = (plan.skipped || []).filter((s) => /pending-migration$/.test(s.reason));
  if (held.length) L.push('- Held this pass (owner data still waiting to move): ' + held.map((s) => q(s.rel)).join(', '));
  if ((plan.unknownDrift || []).length || (plan.conflicts || []).length) L.push('- NOT synced — drift: ' + ((plan.unknownDrift || []).map(q).join(', ') || 'none') + '; conflicts: ' + ((plan.conflicts || []).map(q).join(', ') || 'none'));
  L.push('');
  L.push('## Orphans (files the template no longer ships)', '');
  const orph = d.orphans || { unmodified: [], modified: [] };
  const moved = (d.retiredOrphans && d.retiredOrphans.moved) || [];
  L.push('- Unmodified: ' + ((orph.unmodified || []).map((o) => q(o.rel)).join(', ') || 'none'));
  L.push('- Modified here (always kept): ' + ((orph.modified || []).map((o) => q(o.rel)).join(', ') || 'none'));
  L.push('- Moved into the batch backup this run (--retire-orphans): ' + (moved.map(q).join(', ') || 'none'));
  L.push('');
  L.push('## Coupled delivery', '');
  for (const g of COUPLED_DELIVERY_GROUPS) L.push('- Rule ' + q(g.id) + ': ' + g.why);
  for (const g of (d.coupled && d.coupled.groups) || []) L.push('- This batch: ' + g.members.map((m) => q(m.rel) + ' ' + m.outcome + (m.reason ? ' (' + m.reason + ')' : '')).join(', ') + ' → ' + (g.ok ? 'consistent' : 'REFUSED'));
  L.push('');
  L.push('## Doctor (validation)', '');
  L.push('- Before: ' + doctorLine(d.preValidation) + (d.baselineSource && d.baselineSource.mode ? ' (baseline ' + d.baselineSource.mode + ')' : ''));
  L.push('- After: ' + doctorLine(d.validation));
  if (d.outcomeNote) L.push('- ' + d.outcomeNote);
  L.push('');
  for (const line of suiteCheckReportLines(d.suiteCheck)) L.push(line); // WP-SYNC-R9
  L.push('## Protected files (everything this sync must not change)', '');
  const pr = d.protect;
  if (!pr) L.push('- not checked');
  else {
    // WP-SYNC-R13B: inventoried / verified / NOT verified — "unchanged" is never claimed for a not-comparable entry.
    // WP-SYNC-R14: verified = content compared and equal; summaries and the sync's own changes counted apart; the
    // app-code coverage in the same line as "unchanged", then the scope verdict
    const pc = protectCounts(pr);
    L.push('- ' + pc.inventoried + ' protected entr' + (pc.inventoried === 1 ? 'y' : 'ies') + ' inventoried · ' + pc.verified + ' verified after the last write: ' + (pr.ok ? 'unchanged' : '**VIOLATION**')
      + ' · ' + pc.notVerified + ' NOT verified' + (pc.notVerified ? ' (unreadable on both sides — not comparable, never counted as unchanged)' : '')
      + ' · ' + pc.summarized + ' summarized (presence / metadata only — content not compared) · ' + pc.changedBySync + ' changed by this sync (recorded in its batch)'
      + ' · app code: ' + protectAppCoverage(pr.appCode));
    L.push('  - verdict: ' + protectScopeVerdict(pr));
    const folderAdds = (pr.allowed || []).filter((a) => /^folder for a shipped/.test(a.why));
    if (folderAdds.length) L.push('  - allowed: ' + folderAdds.length + ' new folder(s) that hold shipped or sync-created files');
    for (const a of (pr.allowed || []).filter((x) => !/^folder for a shipped/.test(x.why)).slice(0, 60)) L.push('  - allowed: ' + a.change + ' ' + q(a.key) + ' — ' + a.why);
    // WP-SYNC-R13: what could not be read (not hashed) and what was unreadable both times (not comparable, never a violation)
    if (pr.unreadable) L.push('  - unreadable entries recorded: ' + pr.unreadable.before + ' before, ' + pr.unreadable.after + ' after (not hashed)');
    const ncl = protectNotComparableLine(pr);
    if (ncl) {
      L.push('  - ' + ncl);
      for (const n of (pr.notComparable || []).slice(0, 20)) L.push('    - ' + q(n.key) + ' (' + n.code + (n.syscall ? ' ' + n.syscall : '') + (n.mtimeCompared ? ', same modified time' : ', time not compared') + ')');
      if ((pr.notComparable || []).length > 20) L.push('    - … +' + (pr.notComparable.length - 20) + ' more');
    }
    for (const line of protectViolationLines(pr)) L.push('  - ' + line);
    for (const line of protectWhyLines(pr, 20)) L.push('    - ' + line); // WP-SYNC-R13B: why an unreadable pair is a change
  }
  if (d.rollback) {
    L.push('');
    L.push('## Rollback', '');
    const srl = d.rollback.settingsRestore; // WP-SYNC-R11: a restore that did not happen shows WHY, not the bare action 'none'
    L.push('- ' + (d.rollback.ok ? 'Rolled back' : 'Rollback NOT complete') + (d.rollback.reason ? ' — ' + d.rollback.reason : '') + (srl ? ' · settings.json: ' + (srl.ok === false ? 'NOT restored — ' + (srl.error || 'unknown reason') : (srl.action || srl.error)) : ''));
  }
  L.push('');
  return L.join('\n');
}
/** writeSyncReport(projectDir, batchId, markdown) -> the absolute path written, or null. Atomic, containment-checked,
 *  never through a symlink. The report is sync bookkeeping (never shipped, add-only in the protect allow-list). */
function writeSyncReport(projectDir, batchId, markdown) {
  if (!isSafeBatchId(batchId)) return null;
  const dst = claudeDirOf(projectDir);
  const p = path.join(dst, 'forge-sync-report-' + batchId + '.md');
  if (isSymlinkPath(p) || !containmentSafe(dst, p)) return null;
  writeAtomic(p, markdown);
  return p;
}
/** reportFor(projectDir, batchId, d) — build + write, never throwing into the caller; returns {path} or {error}. */
function reportFor(projectDir, batchId, d) {
  try { const p = writeSyncReport(projectDir, batchId, buildSyncReport(Object.assign({ projectDir, batchId }, d))); return p ? { path: p } : { error: 'no safe batch id / report path' }; }
  catch (e) { return { error: e.message }; }
}

// =====================================================================================================================
// publish-template.
// The central template (~/.claude/forge/template/.claude) is what `forge-sync install` copies into every project. It was
// refreshed by hand / an unversioned scratch script and carried no shipping manifest, so nothing could tell whether it
// matched the development tree. publish-template refreshes it FROM the development tree this forge-sync.cjs lives in
// (proven by config/forge-dev-tree.json {dev_tree:true}), driven by the shipping manifest:
//   source   the dev tree's ship-sync + seed-only files (exactly shipPlan(): what forge-sync delivers) plus every other
//            .claude/ file whose manifest rule carries the `template` channel (today settings.json — merged into
//            projects, never copied — and the installer-only retired-dashboard hash list); the manifest itself is always in it.
//            Never: the dev-tree marker, or anything on the never-touch floor (settings.json excepted).
//   --plan   read-only: add / update / unchanged, orphans, foreign files, templateVersion now -> after, dev git state.
//   --apply  refuses (exit 4, nothing written) unless the batch id is safe, the REAL template is named with
//            --confirm-real-template, every published path is committed (or --allow-dirty "<reason>", recorded), no
//            published path is blocked, and a full backup of the template folder (a dated folder outside both trees,
//            compared file by file) matches. Then it writes atomically (temp + rename, no-follow, containment-checked),
//            MOVES retirable orphans into the backup (never deletes), writes template-provenance.json {devCommit, dirty,
//            publishedAt, fileCount, manifestSha256, batch} and a receipt (template-publish-receipt.json in the template,
//            receipt.json in the backup). Any failure restores every touched path from the backup and exits 1. A no-op
//            apply (nothing to change and the provenance already current) writes nothing at all.
//   --verify read-only: the template holds the source set byte-identically, no managed orphan is left, the template's
//            own manifest finds no ship-sync entry missing (release_excluded respected), templateVersion equals the dev
//            tree's. Exit 3 on any difference.
// Orphans = template files outside the source set. FOREIGN ones (per-project placeholders and runtime state the installer
// puts in the template, e.g. FORGE_MEMORY.md, forge-runs/) are never managed. MANAGED ones (unclassified, retired,
// local-only, or a shipped path the dev tree no longer has — forge-sync would keep delivering those) are HASH-GATED like
// moved only when the bytes are proven to be ours (equal to what the previous publish recorded, or to a version of
// that path in the dev tree's git history). Unproven ones are kept and reported; --verify stays red until a human decides:
// either by hand, or with --apply --retire-unproven-orphans "<reason>" (still a MOVE into the backup, recorded in the
// receipt with the reason; foreign files are never touched either way). Measured on the real template 2026-10-10: 7
// managed orphans, all unproven (FORGE_FAILURE_PATTERNS.md + six never-committed *.bak-* copies).
// The template HOME (CLAUDE.md, gitignore.snippet, env.example, .claude-plugin/ next to .claude/) is not managed here.
// Exit codes: 0 ok · 1 could not run / failed (restored) · 2 usage · 3 differences (--verify, or after --apply) · 4 refused.
// =====================================================================================================================
const PUBLISH_SCHEMA = 'forge-sync-publish-template/v1';
const PUBLISH_RECEIPT_SCHEMA = 'forge-sync-publish-template-receipt/v1';
const PUBLISH_BACKUP_SCHEMA = 'forge-sync-publish-template-backup/v1';
const TEMPLATE_PROVENANCE_NAME = 'template-provenance.json';
const TEMPLATE_PUBLISH_RECEIPT_NAME = 'template-publish-receipt.json';
const PUBLISH_BOOKKEEPING = new Set([TEMPLATE_PROVENANCE_NAME, TEMPLATE_PUBLISH_RECEIPT_NAME, '.forge-sync.lock']);
const DEV_TREE_MARKER_REL = 'config/forge-dev-tree.json';
const PUBLISH_NEVER = new Set([DEV_TREE_MARKER_REL]); // a template carrying it would make every project a "dev tree"
const TEMPLATE_CARRIED_NEVER_TOUCH = new Set(['settings.json']); // the template's settings reach projects by MERGE
const PUBLISH_EXIT = { ok: 0, error: 1, usage: 2, differs: 3, refused: 4 };
const PUBLISH_ORPHAN_PROOF_MAX = 200; // git calls per orphan are cheap, but never unbounded
const PUBLISH_USAGE = 'usage: forge-sync publish-template [--plan|--apply|--verify] [--template-dir <template>/.claude] [--batch-id <id>] [--json] [--verbose]\n'
  + '         --apply only: [--allow-dirty "<reason>"] [--retire-unproven-orphans "<reason>"] [--confirm-real-template] [--backup-dir <dir>]';

function publishError(msg) { const e = new Error(msg); e.publishError = true; return e; }
/** defaultRealTemplateDir() — the REAL central template: os.homedir() (USERPROFILE on Windows) + .claude/forge/template/.claude. */
function defaultRealTemplateDir() { return path.join(os.homedir(), '.claude', 'forge', 'template', '.claude'); }
function normRealPath(p) { const r = realpathViaExistingAncestor(p); return process.platform === 'win32' ? r.toLowerCase() : r; }
/** pathWithin(child, parent) — real-path containment (junctions resolved, case-insensitive on Windows); equal counts. */
function pathWithin(child, parent) {
  const c = normRealPath(child), p = normRealPath(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
function samePath(a, b) { return normRealPath(a) === normRealPath(b); }
function isNeverPublish(rel) { return PUBLISH_NEVER.has(rel) || (isNeverTouch(rel) && !TEMPLATE_CARRIED_NEVER_TOUCH.has(rel)); }
function readDevTreeMarker(devDir) {
  try { return JSON.parse(fs.readFileSync(path.join(devDir, ...DEV_TREE_MARKER_REL.split('/')), 'utf8')).dev_tree === true; } catch { return false; }
}
function validAllowDirtyReason(r) { return typeof r === 'string' && r.trim().length >= 3 && r.trim().length <= 500; }
function compactStamp(iso) { return String(iso).replace(/[-:]/g, '').replace('T', '-').slice(0, 15); }
function gitIn(dir, args) {
  try {
    const r = spawnSync('git', ['--no-optional-locks', '-C', dir].concat(args), { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 && !r.error ? { ok: true, out: String(r.stdout) } : { ok: false, err: r.error ? r.error.message : (String(r.stderr || '').trim() || 'exit ' + r.status) };
  } catch (e) { return { ok: false, err: e.message }; }
}

/** walkRel(base, opts) -> {files, symlinks, others, skippedDirs} (.claude-relative, posix). Never follows a symlink;
 *  skips .git/node_modules; opts.start walks one sub-folder; opts.stopAt(dirRel) records a folder without entering it;
 *  opts.skipTopFiles drops named top-level files; opts.missingOk tolerates an absent start folder. */
function walkRel(base, opts) {
  const o = opts || {};
  const files = [], symlinks = [], others = [], skippedDirs = [];
  (function walk(rel) {
    const abs = rel ? path.join(base, ...rel.split('/')) : base;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { if (o.missingOk && e.code === 'ENOENT') return; throw publishError('cannot read ' + abs + ' (' + e.message + ')'); }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (TEMPLATE_WALK_SKIP.has(e.name)) { skippedDirs.push(r); continue; }
      if (e.isSymbolicLink()) { symlinks.push(r); continue; }
      if (e.isDirectory()) { if (o.stopAt && o.stopAt(r)) skippedDirs.push(r); else walk(r); continue; }
      if (e.isFile()) { if (!(rel === '' && o.skipTopFiles && o.skipTopFiles.has(e.name))) files.push(r); continue; }
      others.push(r);
    }
  })(o.start || '');
  return { files: files.sort(), symlinks: symlinks.sort(), others: others.sort(), skippedDirs: skippedDirs.sort() };
}

/** templateChannelExtras(devDir, rules, sc) -> [{rel, class, rule}] — dev files whose LAST matching rule is NOT a
 *  delivery class but carries the `template` channel (settings.json, the retired-dashboard hash list). */
function templateChannelExtras(devDir, rules, sc) {
  const out = new Map();
  for (const r of rules) {
    if (!r.pattern.startsWith('.claude/') || SHIP_DELIVERY_CLASSES.has(r.class) || !(r.channels || []).includes('template')) continue;
    let cands = [];
    if (r.literalPaths) cands = r.literalPaths.filter((lp) => lp.startsWith('.claude/')).map((lp) => lp.slice('.claude/'.length));
    else {
      const prefixes = literalDirPrefixes(r.pattern);
      for (const pre of (prefixes.length ? prefixes : [''])) {
        if (pre && isNeverTouchDir(pre)) continue;
        cands = cands.concat(walkRel(devDir, { start: pre, missingOk: true, stopAt: isNeverTouchDir }).files);
      }
    }
    for (const rel of cands) {
      let st; try { st = fs.lstatSync(path.join(devDir, ...rel.split('/'))); } catch { continue; }
      if (st.isFile() && !out.has(rel) && sc.classify(rules, '.claude/' + rel) === r) out.set(rel, { rel, class: r.class, rule: r.pattern });
    }
  }
  return [...out.values()];
}

/** publishSourceSet(devDir) -> {files: Map(rel -> 'ship-sync'|'seed-only'|'template-only'|'manifest'), claimed[], rules,
 *  sc, devMissing[], devMissingBlocking[]}. Throws (publishError) when the dev tree has no manifest of its own. */
function publishSourceSet(devDir) {
  const sp = shipPlan(devDir);
  if (sp.manifest.source !== 'template') throw publishError('the development tree has no shipping manifest of its own (' + SHIP_MANIFEST_REL + ') — nothing defines what to publish');
  const { sc, rules } = loadShipManifest(devDir);
  const files = new Map();
  const claimed = sp.neverTouchClaimed.map((x) => Object.assign({ why: 'never-touch floor' }, x));
  const put = (rel, kind) => {
    if (PUBLISH_NEVER.has(rel)) { const r = sc.classify(rules, '.claude/' + rel); claimed.push({ rel, class: r ? r.class : null, rule: r ? r.pattern : null, why: 'the development-tree marker is never published' }); return; }
    if (!files.has(rel)) files.set(rel, kind);
  };
  sp.system.forEach((rel) => put(rel, 'ship-sync'));
  sp.seed.forEach((rel) => put(rel, 'seed-only'));
  for (const x of templateChannelExtras(devDir, rules, sc)) {
    if (isNeverPublish(x.rel)) { claimed.push(Object.assign({ why: 'never-touch floor' }, x)); continue; }
    put(x.rel, 'template-only');
  }
  if (!files.has(SHIP_MANIFEST_REL)) put(SHIP_MANIFEST_REL, 'manifest'); // the template must carry its own manifest
  const sorted = new Map([...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0))));
  return { files: sorted, claimed, rules, sc, devMissing: sp.missing, devMissingBlocking: sp.missingBlocking };
}

/** classifyTemplateExtra(rel, rules, sc) -> {managed, class, why} for a template file OUTSIDE the source set. */
function classifyTemplateExtra(rel, rules, sc) {
  if (isNeverTouch(rel)) return { managed: false, class: null, why: 'per-project placeholder or runtime state (never-touch floor) — installer content, not managed by publish-template' };
  const r = sc.classify(rules, '.claude/' + rel);
  if (!r) return { managed: true, class: null, why: 'matches no manifest rule (no longer in the development tree)' };
  if (r.class === 'per-project') return { managed: false, class: r.class, why: 'per-project placeholder or state — not managed by publish-template' };
  if (SHIP_DELIVERY_CLASSES.has(r.class)) return { managed: true, class: r.class, why: r.class + ' path the development tree no longer has — forge-sync would keep delivering it from the template' };
  if (r.class === 'retired') return { managed: true, class: r.class, why: 'retired (replacement: ' + (r.replacement || '?') + ')' };
  if (r.class === 'local-only') return { managed: true, class: r.class, why: 'local-only — must never leave the development tree' };
  if ((r.channels || []).includes('template')) return { managed: true, class: r.class, why: r.class + ' template-channel path the development tree no longer has' };
  return { managed: false, class: r.class, why: r.class + ' without the template channel — not managed by publish-template' };
}

/** proveTemplateOrphan(rel, absFile, hash, priorFiles, git) -> {proven, by, reason}. HASH GATE (semantics): the
 *  bytes are "ours" when they equal what the previous publish recorded (priorFiles), or equal a version of the same
 *  path in the dev tree's git history (`git hash-object` with and without filters vs `git log --all --raw`). */
function proveTemplateOrphan(rel, absFile, hash, priorFiles, git) {
  const recorded = priorFiles && typeof priorFiles[rel] === 'string' ? priorFiles[rel] : null;
  if (recorded && recorded === hash) return { proven: true, by: 'publish-receipt', reason: null };
  if (git && git.available && git.top) {
    const repoRel = path.relative(git.top, path.join(git.devDir, ...rel.split('/'))).split(path.sep).join('/');
    if (repoRel && !repoRel.startsWith('..')) {
      const ids = new Set();
      for (const args of [['hash-object', '--path=' + repoRel, '--', absFile], ['hash-object', '--no-filters', '--', absFile]]) {
        const r = gitIn(git.top, args);
        if (r.ok && /^[0-9a-f]{40,64}$/.test(r.out.trim())) ids.add(r.out.trim());
      }
      const log = ids.size ? gitIn(git.top, ['log', '--all', '--format=', '--raw', '--no-abbrev', '--no-renames', '--', repoRel]) : { ok: false };
      if (log.ok) {
        for (const line of log.out.split('\n')) {
          const m = /^:\d+ \d+ ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) /.exec(line);
          if (m && (ids.has(m[1]) || ids.has(m[2]))) return { proven: true, by: 'dev-git-history', reason: null };
        }
      }
    }
  }
  return { proven: false, by: null, reason: recorded ? 'changed since the last publish recorded it, and not byte-identical to any version in the development tree\'s git history — kept' : 'not proven to come from the development tree (no publish record, no identical version in its git history) — kept' };
}

/** devGitState(devDir, src) -> {available, devDir, top, head, dirtyPaths[], error}. A published path is dirty when git
 *  reports it changed/untracked, when it is not tracked at all (git-ignored content), or when a publishable path is
 *  deleted/renamed without a commit. Read-only (`git --no-optional-locks`). */
function devGitState(devDirIn, src) {
  const devDir = realpathViaExistingAncestor(devDirIn); // long, real form: git prints real paths (an 8.3 TEMP would not map)
  const top = gitIn(devDir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { available: false, devDir, top: null, head: null, dirtyPaths: [], error: 'git could not confirm the development tree state (' + top.err + ')' };
  const topDir = realpathViaExistingAncestor(path.resolve(top.out.trim()));
  const head = gitIn(devDir, ['rev-parse', '--verify', '-q', 'HEAD']);
  const spec = path.relative(topDir, devDir).split(path.sep).join('/') || '.';
  const st = gitIn(topDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', spec]);
  const ls = gitIn(topDir, ['ls-files', '-z', '--', spec]);
  if (!st.ok || !ls.ok) return { available: false, devDir, top: topDir, head: null, dirtyPaths: [], error: 'git status/ls-files failed (' + (st.err || ls.err) + ')' };
  const toRel = (repoPath) => path.relative(devDir, path.join(topDir, repoPath)).split(path.sep).join('/');
  const publishable = (rel) => {
    if (src.files.has(rel)) return true;
    if (!rel || rel.startsWith('..') || isNeverPublish(rel)) return false;
    const r = src.sc.classify(src.rules, '.claude/' + rel);
    return !!r && (SHIP_DELIVERY_CLASSES.has(r.class) || (r.channels || []).includes('template'));
  };
  const dirty = new Map();
  const toks = st.out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.length < 4) continue;
    const xy = tok.slice(0, 2);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // -z: the rename/copy source follows
    const rel = toRel(tok.slice(3));
    if (publishable(rel)) dirty.set(rel, xy.trim() + ' ' + rel);
  }
  const tracked = new Set(ls.out.split('\0').filter(Boolean).map(toRel));
  for (const rel of src.files.keys()) if (!tracked.has(rel) && !dirty.has(rel)) dirty.set(rel, '!! ' + rel + ' (not tracked — ignored by git)');
  return { available: true, devDir, top: topDir, head: head.ok && head.out.trim() ? head.out.trim() : null, dirtyPaths: [...dirty.values()].sort(), error: null };
}

function readPriorPublishReceipt(templateDir) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(templateDir, TEMPLATE_PUBLISH_RECEIPT_NAME), 'utf8'));
    if (!r || r.schema !== PUBLISH_RECEIPT_SCHEMA || !r.files || typeof r.files !== 'object') return null;
    const files = {};
    for (const [k, v] of Object.entries(r.files)) if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) files[k] = v;
    return { batch: typeof r.batch === 'string' ? r.batch : null, publishedAt: typeof r.publishedAt === 'string' ? r.publishedAt : null, files };
  } catch { return null; }
}
function readTemplateProvenanceFile(templateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(templateDir, TEMPLATE_PROVENANCE_NAME), 'utf8')); } catch { return null; }
}
/** parentChainProblem(baseDir, rel) -> null, or why a file at rel cannot be created (a parent is a file/symlink). */
function parentChainProblem(baseDir, rel) {
  const segs = rel.split('/');
  let cur = baseDir;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    let st; try { st = fs.lstatSync(cur); } catch { return null; } // the rest of the chain does not exist yet: mkdir creates it
    if (st.isSymbolicLink()) return 'a parent folder in the template (' + segs.slice(0, i + 1).join('/') + ') is a symlink/junction';
    if (!st.isDirectory()) return 'a parent path in the template (' + segs.slice(0, i + 1).join('/') + ') is not a folder';
  }
  return null;
}

/** publishContext(o) -> {devDir, devRoot, templateDir, templateHome, realTemplateDir, realTemplate}. Throws publishError on
 *  anything that makes a publish meaningless or unsafe to even plan. */
function publishContext(o) {
  if (!o || !o.devDir || !o.templateDir) throw publishError('devDir and templateDir are required');
  const devDir = path.resolve(o.devDir), templateDir = path.resolve(o.templateDir);
  const realTemplateDir = path.resolve(o.realTemplateDir || defaultRealTemplateDir());
  if (path.basename(devDir) !== '.claude' || path.basename(templateDir) !== '.claude') throw publishError('both the development tree and the template must be named by their .claude folder (got ' + devDir + ' -> ' + templateDir + ')');
  if (!readDevTreeMarker(devDir)) throw publishError('this is not the development tree (' + path.join(devDir, DEV_TREE_MARKER_REL) + ' with dev_tree:true is missing) — publish-template only runs from the canonical Forge development checkout');
  if (!isDirectory(templateDir) || isSymlinkPath(templateDir)) throw publishError('the template folder does not exist (or is not a plain folder): ' + templateDir + ' — the installer creates the template; publish-template only refreshes it');
  const devRoot = path.dirname(devDir), templateHome = path.dirname(templateDir);
  if (pathWithin(templateDir, devRoot) || pathWithin(devDir, templateHome)) throw publishError('the template and the development tree must not contain each other (' + templateDir + ' / ' + devDir + ')');
  return { devDir, devRoot, templateDir, templateHome, realTemplateDir, realTemplate: samePath(templateDir, realTemplateDir) };
}

/** planPublishTemplate(opts) -> plan. READ-ONLY. opts: {devDir, templateDir, realTemplateDir?}. Throws publishError
 *  (could not run) on a bad dev tree / template folder / manifest. */
function planPublishTemplate(opts) {
  const ctx = publishContext(opts);
  const src = publishSourceSet(ctx.devDir);
  const tree = walkRel(ctx.templateDir, { stopAt: isNeverTouchDir, skipTopFiles: PUBLISH_BOOKKEEPING });
  const tplFiles = new Set(tree.files);
  const tplOdd = new Set(tree.symlinks.concat(tree.others));
  const add = [], update = [], unchanged = [], blocked = [];
  const srcHashes = {};
  for (const [rel, kind] of src.files) {
    const newHash = sha256(path.join(ctx.devDir, ...rel.split('/')));
    if (newHash === null) { blocked.push({ rel, reason: 'unreadable in the development tree' }); continue; }
    srcHashes[rel] = newHash;
    const out = safeJoin(ctx.templateDir, rel);
    if (out == null || !containmentSafe(ctx.templateDir, out)) { blocked.push({ rel, reason: 'resolves outside the template (a symlink/junction on its path)' }); continue; }
    if (tplOdd.has(rel)) { blocked.push({ rel, reason: 'is a symlink or not a regular file in the template — never written through' }); continue; }
    if (!tplFiles.has(rel)) {
      const st = fileStatus(out);
      const why = st.kind === 'missing' ? parentChainProblem(ctx.templateDir, rel) : 'present in the template but ' + (st.error || 'not walkable');
      if (why) { blocked.push({ rel, reason: why }); continue; }
      add.push({ rel, kind, newHash });
      continue;
    }
    const oldHash = sha256(out);
    if (oldHash === null) { blocked.push({ rel, reason: 'unreadable in the template' }); continue; }
    if (oldHash === newHash) unchanged.push(rel);
    else update.push({ rel, kind, oldHash, newHash });
  }
  const git = devGitState(ctx.devDir, src);
  const prior = readPriorPublishReceipt(ctx.templateDir);
  const orphans = [], foreign = [];
  let budget = PUBLISH_ORPHAN_PROOF_MAX;
  for (const rel of tree.files) {
    if (src.files.has(rel)) continue;
    const c = classifyTemplateExtra(rel, src.rules, src.sc);
    if (!c.managed) { foreign.push({ rel, class: c.class, why: c.why }); continue; }
    const abs = path.join(ctx.templateDir, ...rel.split('/'));
    const hash = sha256(abs);
    const proof = budget-- > 0 ? proveTemplateOrphan(rel, abs, hash, prior && prior.files, git) : { proven: false, by: null, reason: 'more than ' + PUBLISH_ORPHAN_PROOF_MAX + ' orphans — not proven, kept' };
    orphans.push({ rel, class: c.class, why: c.why, hash, retirable: proof.proven && hash !== null, provenBy: proof.by, keptReason: proof.proven ? null : proof.reason });
  }
  for (const d of tree.skippedDirs) foreign.push({ rel: d + '/', class: null, why: 'per-project/runtime folder — never walked, never managed' });
  const symlinks = tree.symlinks.filter((r) => !src.files.has(r)).concat(tree.others.filter((r) => !src.files.has(r)));
  let currentTv = null, currentTvError = null;
  try { currentTv = templateVersion(ctx.templateDir); } catch (e) { currentTvError = e.message; }
  const devTv = templateVersion(ctx.devDir);
  const manifestFile = path.join(ctx.devDir, ...SHIP_MANIFEST_REL.split('/'));
  const kinds = [...src.files.values()];
  const plan = Object.assign({ schema: PUBLISH_SCHEMA, mode: 'plan' }, ctx, {
    manifest: { file: manifestFile, sha256: sha256(manifestFile) },
    counts: {
      source: src.files.size, shipSync: kinds.filter((k) => k === 'ship-sync' || k === 'manifest').length, seedOnly: kinds.filter((k) => k === 'seed-only').length,
      templateOnly: kinds.filter((k) => k === 'template-only').length, add: add.length, update: update.length, unchanged: unchanged.length, blocked: blocked.length,
      orphansRetirable: orphans.filter((x) => x.retirable).length, orphansKept: orphans.filter((x) => !x.retirable).length, foreign: foreign.length,
    },
    add, update, unchanged, blocked, orphans, foreign, symlinks, neverPublishClaimed: src.claimed,
    devMissing: src.devMissing, devMissingBlocking: src.devMissingBlocking,
    templateVersion: { current: currentTv, currentError: currentTvError, dev: devTv, afterPublish: devTv, exactAfterPublish: !orphans.some((x) => !x.retirable && x.class === 'ship-sync') },
    dev: { git },
    provenance: { current: templateProvenance(ctx.templateDir), priorPublish: prior ? { batch: prior.batch, publishedAt: prior.publishedAt, files: Object.keys(prior.files).length } : null },
    inSync: !add.length && !update.length && !orphans.length && !blocked.length,
  });
  // the digest covers the RESOLVED root identity too, so a re-plan under the lock that lands on another
  // physical folder (a swapped junction) never matches the first plan
  plan.digest = sha256Str(JSON.stringify([foldCase(realpathViaExistingAncestor(ctx.templateDir)), add, update, unchanged, blocked, orphans.map((x) => [x.rel, x.hash, x.retirable]), foreign.map((x) => x.rel)]));
  Object.defineProperty(plan, 'srcHashes', { value: srcHashes, enumerable: false }); // internal: the receipt's file list
  plan.applyWouldRefuse = publishApplyBlockers(plan, {});
  return plan;
}

/** devCheckTheChecks(devDir, injected) -> the dev tree's check_the_checks result, or null when it cannot be run (no
 *  forge-doctor.cjs next to it, a load error): never a blocker by itself. `injected` replaces it in tests. */
function devCheckTheChecks(devDir, injected) {
  try {
    if (typeof injected === 'function') return injected(devDir);
    if (typeof devDir !== 'string' || !devDir) return null;
    const doctor = path.join(devDir, 'forge-bin', 'forge-doctor.cjs');
    if (!fs.existsSync(doctor)) return null;
    const D = require(doctor);
    if (typeof D.checkTheChecks !== 'function') return null;
    return D.checkTheChecks(path.basename(devDir).toLowerCase() === '.claude' ? path.dirname(devDir) : devDir);
  } catch { return null; }
}
/** publishApplyBlockers(plan, o) -> [reason] that make --apply refuse (exit 4) before anything is written. */
function publishApplyBlockers(plan, o) {
  const reasons = [];
  const g = plan.dev.git;
  const how = ' — commit first, or pass --allow-dirty "<reason>" (recorded in the provenance and the receipt)';
  if (!o.allowDirty) {
    if (!g.available) reasons.push(g.error + how);
    else if (!g.head) reasons.push('the development tree has no commit yet' + how);
    else if (g.dirtyPaths.length) reasons.push(g.dirtyPaths.length + ' published path(s) are not committed in the development tree, e.g. ' + g.dirtyPaths.slice(0, 6).join(', ') + how);
  }
  if (plan.blocked.length) reasons.push(plan.blocked.length + ' published path(s) cannot be written safely: ' + plan.blocked.slice(0, 6).map((b) => b.rel + ' (' + b.reason + ')').join('; '));
  if (plan.devMissingBlocking.length) reasons.push('the development tree itself lacks ' + plan.devMissingBlocking.length + ' file(s) its manifest ships (' + plan.devMissingBlocking.slice(0, 6).map((x) => x.rel).join(', ') + ') — publishing would leave the template incomplete');
  // Category tests I1: a test the doctor's check_the_checks reads as a no-op reached the template and every
  // fresh install ran a 30-minute doctor and rolled back. The scan is static (~0.2 s), so it runs before anything ships.
  const ctc = devCheckTheChecks(plan.devDir, o.checkTheChecks);
  if (ctc && ctc.ok === false) {
    const sites = (ctc.noOp || []).slice(0, 6).map((x) => (x.suite || '?') + (x.line ? ':' + x.line : '')).join(', ');
    reasons.push('the development tree\'s own check_the_checks is red (' + (ctc.noOp || []).length + ' no-op assertion site(s): ' + sites + ') — every install would roll back on it; fix the tests first');
  }
  for (const name of [TEMPLATE_PROVENANCE_NAME, TEMPLATE_PUBLISH_RECEIPT_NAME]) {
    const p = path.join(plan.templateDir, name);
    if (isSymlinkPath(p) || (fs.existsSync(p) && !fs.lstatSync(p).isFile())) reasons.push(name + ' in the template is a symlink or not a regular file — never written through');
  }
  return reasons;
}

/** backupTemplateTree(templateDir, backupDir, hooks) -> {ok, problems[], hashes, fileCount}. Pure-Node full copy of the
 *  template folder (all files, .git/node_modules skipped, symlinks recorded, never followed) into <backup>/files, then a
 *  FILE-BY-FILE comparison of the live template against the copy and the recorded hashes. */
function backupTemplateTree(templateDir, backupDir, hooks) {
  const filesDir = path.join(backupDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const lockOnly = new Set(['.forge-sync.lock']);
  const tree = walkRel(templateDir, { skipTopFiles: lockOnly });
  const hashes = {};
  for (const rel of tree.files) {
    const dst = path.join(filesDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    copyNoFollow(path.join(templateDir, ...rel.split('/')), dst, filesDir);
    hashes[rel] = sha256(dst);
  }
  writeAtomic(path.join(backupDir, 'backup-manifest.json'), JSON.stringify({ schema: PUBLISH_BACKUP_SCHEMA, templateDir, files: hashes, symlinks: tree.symlinks, skipped: tree.skippedDirs.concat(tree.others) }, null, 2) + '\n');
  if (hooks && typeof hooks.afterBackup === 'function') hooks.afterBackup(backupDir); // test seam: tamper with the copy
  const problems = [];
  const live = walkRel(templateDir, { skipTopFiles: lockOnly });
  const copy = walkRel(filesDir);
  const liveSet = new Set(live.files), copySet = new Set(copy.files);
  for (const rel of live.files) {
    if (!copySet.has(rel)) { problems.push(rel + ': missing from the backup'); continue; }
    const a = sha256(path.join(templateDir, ...rel.split('/'))), b = sha256(path.join(filesDir, ...rel.split('/')));
    if (a === null || a !== b || hashes[rel] !== b) problems.push(rel + ': backup differs from the template');
  }
  for (const rel of copy.files) if (!liveSet.has(rel)) problems.push(rel + ': in the backup but not in the template');
  return { ok: problems.length === 0, problems, hashes, fileCount: live.files.length };
}

function templateTarget(templateDir, rel) {
  const out = safeJoin(templateDir, rel);
  if (out == null || !containmentSafe(templateDir, out) || isSymlinkPath(out)) throw new Error(rel + ': resolves outside the template or through a symlink — refused');
  return out;
}
/** ensureParents(baseDir, out) -> the folders it had to create (deepest last), for the restore to remove again. */
function ensureParents(baseDir, out) {
  const created = [];
  let cur = path.dirname(out);
  while (!fs.existsSync(cur) && pathWithin(cur, baseDir) && cur !== path.resolve(baseDir)) { created.unshift(cur); cur = path.dirname(cur); }
  if (created.length) fs.mkdirSync(path.dirname(out), { recursive: true });
  return created;
}
/** moveIntoBackup(out, dest, destBase, hash, hook) -> {moved:true} | {moved:false, keptAt, reason}. Copy (no-follow), verify,
 *  THEN remove the original: a move, never a delete. R3 / SYNC-05: the original is first moved aside and the MOVED bytes are
 *  re-hashed; if they no longer equal the verified backup (changed in between), they are put back and reported, never
 *  removed. `hook(out)` is a test seam that runs in that window. */
function moveIntoBackup(out, dest, destBase, hash, hook) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyNoFollow(out, dest, destBase);
  if (sha256(dest) !== hash) throw new Error('the backup copy of ' + out + ' could not be verified — original kept');
  if (typeof hook === 'function') hook(out);
  const q = quarantineAndVerify(out, hash);
  if (!q.removed) return { moved: false, keptAt: q.keptAt, reason: q.reason };
  if (fs.existsSync(out)) throw new Error(out + ' is still present after the move');
  return { moved: true };
}
function pruneEmptyParents(baseDir, out) {
  const removed = [];
  let cur = path.dirname(out);
  const base = path.resolve(baseDir);
  while (cur !== base && pathWithin(cur, base)) {
    try { if (fs.readdirSync(cur).length) break; fs.rmdirSync(cur); removed.push(cur); } catch { break; }
    cur = path.dirname(cur);
  }
  return removed;
}

/** runPublishAction(ctx, act) — one journaled step. write: dev bytes -> template (temp + rename, no-follow), verified.
 *  orphan: moved into <backup>/retired-orphans (copy, verify, remove). meta: staged in the backup, then written. */
function runPublishAction(ctx, act) {
  const out = templateTarget(ctx.templateDir, act.rel);
  const now = sha256(out);
  // someone else changed it after the plan: abort WITHOUT touching it (the restore then leaves it alone, too)
  if (act.existed ? now !== act.oldHash : fs.existsSync(out)) throw new Error(act.rel + ' changed in the template after the plan — aborting');
  if (act.type === 'orphan') {
    act.touched = true;
    const hook = ctx.hooks && typeof ctx.hooks.beforeOrphanRemove === 'function' ? (p) => ctx.hooks.beforeOrphanRemove(act.rel, p) : null;
    const mv = moveIntoBackup(out, path.join(ctx.backupDir, 'retired-orphans', ...act.rel.split('/')), path.join(ctx.backupDir, 'retired-orphans'), act.oldHash, hook);
    if (!mv.moved) { act.keptChanged = mv.reason; throw new Error(act.rel + ' changed in the template after the plan (changed-since-plan) — kept, never removed: ' + mv.reason); }
    act.writtenHash = null; // what this publish left there — nothing
    act.removedDirs = pruneEmptyParents(ctx.templateDir, out);
    return;
  }
  // the bytes are read ONCE into memory, hashed, and exactly those bytes are written; act.writtenHash is that hash —
  // never a re-read of the template file afterwards (an owner edit in that instant would otherwise be attributed to the
  // publish and replaced on restore). R4 / F05: the destination is re-hashed right before the rename (expectOldHash); a
  // post-rename read that differs is 'changed-during-write' — reported, never written again.
  let buf;
  if (act.type === 'meta') buf = Buffer.from(act.content, 'utf8');
  else buf = fs.readFileSync(path.join(ctx.devDir, ...act.rel.split('/')));
  const bufHash = crypto.createHash('sha256').update(buf).digest('hex');
  if (bufHash !== act.newHash) throw new Error(act.rel + ': the bytes to publish do not match ' + (act.type === 'meta' ? 'the staged content' : 'the plan (the development tree changed during the publish?)') + ' — nothing written for it');
  act.touched = true;
  act.createdDirs = ensureParents(ctx.templateDir, out);
  const r = writeBytesNoFollow(buf, out, ctx.templateDir, act.existed ? { expectOldHash: act.oldHash } : { exclusive: true });
  if (r === 'changed') throw new Error(act.rel + ' changed in the template right before it was replaced (changed-since-plan) — not overwritten');
  if (r === 'exists') throw new Error(act.rel + ' appeared in the template while it was being created — not overwritten');
  act.writtenHash = bufHash;
  const after = sha256(out);
  if (after !== bufHash) { act.changedDuringWrite = after; throw new Error(act.rel + ': changed-during-write — the template file no longer holds the bytes this publish just wrote (another writer is active); not written again'); }
}

/** restorePublish(ctx, started) -> {ok, restored[], problems[]}. Undo every STARTED action in reverse from the backup:
 *  a file that existed gets its backup bytes back (verified); a file this publish created is MOVED into
 *  <backup>/restore-removed (never deleted); folders this publish created are removed only when empty. */
/** the restore compares the LIVE template file with the hash this publish itself
 *  wrote there (act.writtenHash: the written bytes, or null = removed). Only a file that still holds exactly that is put
 *  back; a file someone changed after the publish touched it is NOT overwritten — it is reported as changed-since-publish
 *  and the restore is ok:false (manual review), so a newer owner edit is never replaced by the backup. */
/** before the restore writes a single byte — and again before EACH write — the pinned
 *  physical template folder must still resolve to itself. A template folder swapped for a junction after the publish pinned
 *  it (the failure path used to restore straight through it, into whatever it now points at — e.g. the real central
 *  template) aborts the restore WITHOUT writing: ok:false, identityChanged:true, every started action listed for manual
 *  recovery from the backup. R4 / F03 + F05: a restored update is written with a re-hash of the destination right before the
 *  rename (it must still hold exactly what this publish wrote). */
function restorePublish(ctx, started) {
  const restored = [], problems = [], changedSincePublish = [];
  const identityProblem = () => {
    let nowReal = null;
    try { nowReal = fs.realpathSync.native(ctx.templateDir); } catch { /* vanished */ }
    return nowReal == null || foldCase(nowReal) !== foldCase(ctx.templateDir) ? 'the template folder ' + ctx.templateDir + ' no longer resolves to itself (now ' + nowReal + ') — a junction or a move replaced it after the publish pinned it; NOTHING was written by the restore' : null;
  };
  const idp = identityProblem();
  if (idp) {
    for (const act of started) if (act.touched) problems.push({ rel: act.rel, reason: 'not restored: ' + idp });
    return { ok: false, identityChanged: true, restored, problems, changedSincePublish };
  }
  for (const act of started.slice().reverse()) {
    if (!act.touched) continue; // its pre-check refused before any byte moved: nothing of ours to undo
    try {
      const idNow = identityProblem();
      if (idNow) throw new Error('identity-changed: ' + idNow);
      const out = templateTarget(ctx.templateDir, act.rel);
      const cur = sha256(out);
      if (act.keptChanged) { restored.push(act.rel); continue; } // the move kept it in place (changed meanwhile): nothing of ours to undo
      const wrote = Object.prototype.hasOwnProperty.call(act, 'writtenHash');
      if (act.existed) {
        if (cur !== act.oldHash) {
          // ours = exactly what this action left there; an action that threw before writing left the old bytes (cur === oldHash)
          if (!wrote || cur !== act.writtenHash) {
            changedSincePublish.push(act.rel);
            throw new Error('changed-since-publish: the template file no longer holds what this publish wrote — kept, not overwritten (check it by hand; the pre-publish copy is in ' + path.join(ctx.backupDir, 'files') + ')');
          }
          const bak = path.join(ctx.backupDir, 'files', ...act.rel.split('/'));
          const bakBuf = fs.readFileSync(bak);
          if (crypto.createHash('sha256').update(bakBuf).digest('hex') !== act.oldHash) throw new Error('the backup copy is missing or differs');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const w = writeBytesNoFollow(bakBuf, out, ctx.templateDir, { expectOldHash: act.writtenHash });
          if (w === 'changed') { changedSincePublish.push(act.rel); throw new Error('changed-since-publish: the file changed right before the restore replaced it — kept'); }
          if (sha256(out) !== act.oldHash) throw new Error('hash mismatch after the restore');
        }
      } else if (cur !== null) {
        if (!wrote || cur !== act.writtenHash) {
          changedSincePublish.push(act.rel);
          throw new Error('changed-since-publish: a file this publish created was changed afterwards — kept, not moved');
        }
        const mv = moveIntoBackup(out, path.join(ctx.backupDir, 'restore-removed', ...act.rel.split('/')), path.join(ctx.backupDir, 'restore-removed'), cur);
        if (!mv.moved) { changedSincePublish.push(act.rel); throw new Error('changed-since-publish: ' + mv.reason); }
      }
      for (const d of (act.createdDirs || []).slice().reverse()) { try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* not empty / gone: leave it */ } }
      restored.push(act.rel);
    } catch (e) { problems.push({ rel: act.rel, reason: e.message }); }
  }
  return { ok: problems.length === 0, restored, problems, changedSincePublish, identityChanged: problems.some((p) => /^identity-changed:/.test(p.reason)) };
}

/** publishActions(plan, o) — updates, adds, then orphan moves: every PROVEN orphan, plus the unproven ones only when the
 *  owner passed --retire-unproven-orphans "<reason>" (o.retireUnprovenOrphans; still a move into the backup, recorded). */
function publishActions(plan, o) {
  const acts = [];
  const unproven = !!(o && o.retireUnprovenOrphans);
  for (const u of plan.update) acts.push({ type: 'write', rel: u.rel, existed: true, oldHash: u.oldHash, newHash: u.newHash });
  for (const a of plan.add) acts.push({ type: 'write', rel: a.rel, existed: false, oldHash: null, newHash: a.newHash });
  for (const x of plan.orphans) if (x.hash !== null && (x.retirable || unproven)) acts.push({ type: 'orphan', rel: x.rel, existed: true, oldHash: x.hash, newHash: null, proven: x.retirable });
  return acts;
}
function metaAction(templateDir, name, obj) {
  const content = JSON.stringify(obj, null, 2) + '\n';
  const p = path.join(templateDir, name);
  const old = sha256(p);
  return { type: 'meta', rel: name, existed: old !== null, oldHash: old, newHash: sha256Str(content), content };
}
function publishDirtyFlag(plan) { const g = plan.dev.git; return !(g.available && g.head && g.dirtyPaths.length === 0); }
function provenanceIsCurrent(plan) {
  const p = readTemplateProvenanceFile(plan.templateDir);
  return !!p && p.devCommit === (plan.dev.git.head || null) && p.dirty === publishDirtyFlag(plan) && p.fileCount === plan.counts.source && p.manifestSha256 === plan.manifest.sha256;
}

/** applyPublishTemplate(opts) -> result {ok, refused, exitCode, reasons, plan, backupDir, applied, verify, ...}.
 *  opts: {devDir, templateDir, realTemplateDir?, batchId, nowIso, allowDirty?, confirmRealTemplate?, backupDir?, hooks?}.
 *  Never generates its own batch id or time (callers inject both). */
function applyPublishTemplate(opts) {
  let o = opts || {};
  const base = { schema: PUBLISH_SCHEMA, mode: 'apply', batch: o.batchId || null };
  const refuse = (reasons, extra) => Object.assign({}, base, { ok: false, refused: true, exitCode: PUBLISH_EXIT.refused, reasons: [].concat(reasons) }, extra || {});
  if (!isSafeBatchId(o.batchId)) return refuse(unsafeBatchIdReason(o.batchId) || 'a batch id is required (--batch-id <id>)');
  if (typeof o.nowIso !== 'string' || !Number.isFinite(Date.parse(o.nowIso))) return refuse('the publish time (nowIso) is required');
  if (o.allowDirty != null && !validAllowDirtyReason(o.allowDirty)) return refuse('--allow-dirty needs a reason of 3-500 characters');
  if (o.retireUnprovenOrphans != null && !validAllowDirtyReason(o.retireUnprovenOrphans)) return refuse('--retire-unproven-orphans needs a reason of 3-500 characters');
  if (!o.templateDir) return refuse('a template folder is required');
  const realTemplateDir = path.resolve(o.realTemplateDir || defaultRealTemplateDir());
  // the publish is bound to the PHYSICAL target. The requested path is resolved
  // through every junction/symlink on it (and on its ancestors) once, here; from then on the plan, the lock, the backup,
  // every write and the restore use that resolved path only — a junction retargeted later cannot steer a single write
  // into another folder (e.g. the real template). The confirm flag is checked against the physical identity, never the
  // spelling, and the receipt records both the requested and the physical path.
  const requestedTemplateDir = path.resolve(o.templateDir);
  let physicalTemplateDir;
  try { physicalTemplateDir = fs.realpathSync.native(requestedTemplateDir); } catch { physicalTemplateDir = realpathViaExistingAncestor(requestedTemplateDir); }
  const physicalReal = realpathViaExistingAncestor(realTemplateDir);
  const isRealTemplate = foldCase(physicalTemplateDir) === foldCase(physicalReal) || samePath(requestedTemplateDir, realTemplateDir);
  // decided from the two paths alone — the real template is not even read before the owner names it on purpose
  if (isRealTemplate && !o.confirmRealTemplate) {
    return refuse('the target is the REAL central template (' + realTemplateDir + (foldCase(requestedTemplateDir) !== foldCase(physicalTemplateDir) ? '; requested as ' + requestedTemplateDir + ', which resolves to ' + physicalTemplateDir : '') + ') — pass --confirm-real-template to publish into it (owner-approved window only); tests and dry runs use --template-dir <temp>/.claude');
  }
  const pinned = Object.assign({}, o, { templateDir: physicalTemplateDir, realTemplateDir, _requestedTemplateDir: requestedTemplateDir, _isRealTemplate: isRealTemplate });
  o = pinned; // every later step runs on the pinned physical identity
  let plan;
  try { plan = planPublishTemplate(o); } catch (e) { return Object.assign({}, base, { ok: false, refused: false, exitCode: PUBLISH_EXIT.error, error: e.message }); }
  const blockers = publishApplyBlockers(plan, o);
  const backupDir = path.resolve(o.backupDir || path.join(path.dirname(plan.templateHome), 'template-backups', 'template-' + compactStamp(o.nowIso) + '-' + o.batchId));
  const trees = [plan.templateHome, plan.devRoot].concat(plan.dev.git.top ? [plan.dev.git.top] : []);
  if (trees.some((t) => pathWithin(backupDir, t) || pathWithin(t, backupDir))) blockers.push('the backup folder must be outside both the template and the development tree: ' + backupDir);
  else if (isSymlinkPath(backupDir) || (fs.existsSync(backupDir) && (!isDirectory(backupDir) || fs.readdirSync(backupDir).length))) blockers.push('the backup folder already exists and is not empty (or is not a plain folder): ' + backupDir);
  if (blockers.length) return refuse(blockers, { plan });
  if (!publishActions(plan, o).length && provenanceIsCurrent(plan)) {
    const v = verifyFromPlan(plan);
    return Object.assign({}, base, { ok: true, refused: false, noop: true, exitCode: v.ok ? PUBLISH_EXIT.ok : PUBLISH_EXIT.differs, plan, backupDir: null, applied: { added: [], updated: [], orphansMoved: [], orphansKept: plan.orphans.map((x) => x.rel) }, verify: v });
  }
  const lock = acquireLock(plan.templateDir);
  if (!lock.ok) return refuse(lock.reason, { plan });
  let res;
  try { res = applyUnderLock(o, plan, backupDir); } finally { releaseLock(lock); }
  if (res.ok) {
    res.verify = verifyPublishTemplate(o); // the pinned physical target, not whatever the requested spelling resolves to now
    res.exitCode = res.verify.ok ? PUBLISH_EXIT.ok : PUBLISH_EXIT.differs;
  }
  // report both identities, and say so plainly when the requested path now points somewhere else
  let requestedNow = null;
  try { requestedNow = fs.realpathSync.native(o._requestedTemplateDir); } catch { /* gone */ }
  const retargeted = foldCase(requestedNow || '') !== foldCase(o.templateDir);
  return Object.assign({}, base, res, {
    templateDirRequested: o._requestedTemplateDir, templateDirPhysical: o.templateDir, realTemplate: !!o._isRealTemplate,
    ...(retargeted ? { requestedRetargeted: true, warning: 'the requested template path ' + o._requestedTemplateDir + ' now resolves to ' + requestedNow + ' — this publish wrote ONLY into the pinned physical folder ' + o.templateDir } : {}),
  });
}

/** applyUnderLock — re-plan (nothing may have changed since the refusal checks), back up + compare, then run the
 *  journaled actions; any throw restores from the backup. */
function applyUnderLock(o, plan, backupDir) {
  let again;
  try { again = planPublishTemplate(o); }
  catch (e) { return { ok: false, refused: false, exitCode: PUBLISH_EXIT.error, error: 'the re-plan under the lock failed (' + e.message + ') — nothing was written', plan }; }
  if (again.digest !== plan.digest) return { ok: false, refused: false, exitCode: PUBLISH_EXIT.error, error: 'the template or the development tree changed between the plan and the lock — nothing was written; re-run', plan: again };
  let bk;
  try { bk = backupTemplateTree(plan.templateDir, backupDir, o.hooks); }
  catch (e) { return { ok: false, refused: true, exitCode: PUBLISH_EXIT.refused, reasons: ['the template backup could not be written (' + e.message + ') — nothing in the template was changed'], plan, backupDir }; }
  if (!bk.ok) return { ok: false, refused: true, exitCode: PUBLISH_EXIT.refused, reasons: ['the template backup does not match the template (' + bk.problems.slice(0, 6).join('; ') + ') — aborted before any write'], plan, backupDir };
  const ctx = { devDir: plan.devDir, templateDir: plan.templateDir, backupDir, hooks: o.hooks || null };
  const acts = publishActions(plan, o);
  const movedSet = new Set(acts.filter((a) => a.type === 'orphan').map((a) => a.rel));
  const moved = plan.orphans.filter((x) => movedSet.has(x.rel)).map((x) => x.rel);
  const movedUnproven = plan.orphans.filter((x) => movedSet.has(x.rel) && !x.retirable).map((x) => ({ rel: x.rel, reason: x.keptReason }));
  const kept = plan.orphans.filter((x) => !movedSet.has(x.rel)).map((x) => ({ rel: x.rel, reason: x.keptReason }));
  const dirty = publishDirtyFlag(plan);
  const provenance = { devCommit: plan.dev.git.head || null, dirty, publishedAt: o.nowIso, fileCount: plan.counts.source, manifestSha256: plan.manifest.sha256, batch: o.batchId };
  const receipt = {
    schema: PUBLISH_RECEIPT_SCHEMA, batch: o.batchId, publishedAt: o.nowIso, devDir: plan.devDir, devCommit: provenance.devCommit, dirty,
    allowDirtyReason: o.allowDirty ? String(o.allowDirty).trim() : null, dirtyPaths: dirty ? plan.dev.git.dirtyPaths : [],
    templateDir: plan.templateDir, backupDir, manifestSha256: plan.manifest.sha256, templateVersion: plan.templateVersion.dev,
    added: plan.add.map((x) => x.rel), updated: plan.update.map((x) => x.rel), orphansMoved: moved, orphansKept: kept,
    orphansMovedUnproven: movedUnproven, retireUnprovenReason: o.retireUnprovenOrphans ? String(o.retireUnprovenOrphans).trim() : null,
    foreign: plan.foreign.length, files: plan.srcHashes,
    // WP-SYNC-R7 item 1: every hash each published path has had in this template (read by install's templateHistoryMatcher)
    history: buildPublishHistory(plan.templateDir, plan),
    // which folder was asked for, and which physical folder was actually written
    templateDirRequested: o._requestedTemplateDir || plan.templateDir, templateDirPhysical: plan.templateDir,
    realTemplate: !!o._isRealTemplate, confirmRealTemplate: !!o.confirmRealTemplate,
  };
  acts.push(metaAction(plan.templateDir, TEMPLATE_PROVENANCE_NAME, provenance), metaAction(plan.templateDir, TEMPLATE_PUBLISH_RECEIPT_NAME, receipt));
  const journal = path.join(backupDir, 'journal.jsonl');
  const log = (x) => { try { fs.appendFileSync(journal, JSON.stringify(x) + '\n'); } catch { /* the in-memory list still drives the restore */ } };
  const started = [];
  try {
    acts.forEach((act, i) => {
      if (o.hooks && typeof o.hooks.beforeAction === 'function') o.hooks.beforeAction(i, act); // test seam: fail mid-way
      // the pinned physical target must still BE that folder (no component swapped for a reparse point)
      let nowReal = null;
      try { nowReal = fs.realpathSync.native(plan.templateDir); } catch { /* vanished */ }
      if (nowReal == null || foldCase(nowReal) !== foldCase(plan.templateDir)) throw new Error('the template folder ' + plan.templateDir + ' no longer resolves to itself (now ' + nowReal + ') — aborting before ' + act.rel);
      started.push(act);
      log({ i, phase: 'start', type: act.type, rel: act.rel });
      runPublishAction(ctx, act);
      log({ i, phase: 'done', type: act.type, rel: act.rel });
    });
  } catch (e) {
    const restore = restorePublish(ctx, started);
    writePublishBackupReceipt(backupDir, Object.assign({}, receipt, { outcome: restore.ok ? 'FAILED — RESTORED' : 'FAILED — RESTORE INCOMPLETE', error: e.message, restore }));
    return { ok: false, refused: false, exitCode: PUBLISH_EXIT.error, error: e.message, restore, plan, backupDir, manualRecovery: restore.ok ? null : 'copy the listed files back from ' + path.join(backupDir, 'files') };
  }
  writePublishBackupReceipt(backupDir, Object.assign({}, receipt, { outcome: 'PUBLISHED' }));
  return { ok: true, refused: false, plan, backupDir, provenance, receiptPath: path.join(plan.templateDir, TEMPLATE_PUBLISH_RECEIPT_NAME), applied: { added: receipt.added, updated: receipt.updated, orphansMoved: moved, orphansKept: kept.map((k) => k.rel) } };
}
/** buildPublishHistory(templateDir, plan) -> {rel: [sha256, ...]} — WP-SYNC-R7 item 1: the cumulative per-path history the
 *  template receipt keeps: what the previous receipt knew (its `history` and its `files`), the bytes this publish replaces
 *  (update.oldHash — what the template held and shipped until now) and the bytes it publishes (srcHashes). Oldest first, a
 *  re-seen hash moves to the end, at most TEMPLATE_HISTORY_MAX_PER_PATH per path (the oldest dropped). Orphans are left out
 *  (an unproven orphan is not proven to be a Forge version). install reads it through readTemplatePublishHistory. */
function buildPublishHistory(templateDir, plan) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(templateDir, TEMPLATE_PUBLISH_RECEIPT_NAME), 'utf8')); } catch { raw = null; }
  const valid = !!raw && typeof raw === 'object' && raw.schema === PUBLISH_RECEIPT_SCHEMA;
  const hist = new Map();
  const add = (rel, h) => {
    if (!isPlainRel(rel) || typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return;
    if (!hist.has(rel)) hist.set(rel, []);
    const a = hist.get(rel);
    const i = a.indexOf(h);
    if (i !== -1) a.splice(i, 1);
    a.push(h);
  };
  if (valid && raw.history && typeof raw.history === 'object' && !Array.isArray(raw.history)) for (const [k, v] of Object.entries(raw.history)) if (Array.isArray(v)) v.forEach((h) => add(k, h));
  if (valid && raw.files && typeof raw.files === 'object') for (const [k, v] of Object.entries(raw.files)) add(k, v);
  for (const u of plan.update || []) add(u.rel, u.oldHash);
  for (const [rel, h] of Object.entries(plan.srcHashes || {})) add(rel, h);
  const out = {};
  for (const rel of [...hist.keys()].sort()) out[rel] = hist.get(rel).slice(-TEMPLATE_HISTORY_MAX_PER_PATH);
  return out;
}
function writePublishBackupReceipt(backupDir, obj) {
  const r = Object.assign({}, obj);
  delete r.files; // the full list lives in backup-manifest.json (before) and the template receipt (after)
  delete r.history; // WP-SYNC-R7: the per-path history lives in the template receipt only
  try { writeAtomic(path.join(backupDir, 'receipt.json'), JSON.stringify(r, null, 2) + '\n'); } catch { /* best-effort forensics */ }
}

/** verifyPublishTemplate(opts) -> {ok, exitCode, differences[], warnings[], ...}. READ-ONLY. */
function verifyPublishTemplate(opts) {
  let plan;
  try { plan = planPublishTemplate(opts); } catch (e) { return { schema: PUBLISH_SCHEMA, mode: 'verify', ok: false, exitCode: PUBLISH_EXIT.error, error: e.message }; }
  return verifyFromPlan(plan);
}
function verifyFromPlan(plan) {
  const differences = [];
  const diff = (kind, paths, detail) => differences.push({ kind, paths: paths || [], detail: detail || null });
  if (plan.add.length) diff('missing-in-template', plan.add.map((x) => x.rel), 'published files the template does not have');
  if (plan.update.length) diff('different', plan.update.map((x) => x.rel), 'bytes differ from the development tree');
  if (plan.blocked.length) diff('blocked', plan.blocked.map((x) => x.rel), 'cannot be compared or written safely');
  if (plan.orphans.length) diff('orphan', plan.orphans.map((x) => x.rel), 'files the development tree does not publish (forge-sync may deliver them)');
  let tplShip = null;
  try { tplShip = shipPlan(plan.templateDir); } catch (e) { diff('template-manifest', [], 'the template\'s shipping manifest cannot be read: ' + e.message); }
  if (tplShip && tplShip.manifest.source !== 'template') diff('template-manifest', [SHIP_MANIFEST_REL], 'the template carries no shipping manifest of its own');
  if (tplShip && tplShip.missingBlocking.length) diff('missing-ship-sync', tplShip.missingBlocking.map((x) => x.rel), 'ship-sync entries of the template\'s own manifest that it lacks (release_excluded ones are allowed)');
  if (plan.templateVersion.current !== plan.templateVersion.dev) diff('template-version', [], 'template ' + (plan.templateVersion.current || '(unknown: ' + plan.templateVersion.currentError + ')') + ' != development tree ' + plan.templateVersion.dev);
  const warnings = [];
  const pv = readTemplateProvenanceFile(plan.templateDir);
  if (!pv) warnings.push('the template has no ' + TEMPLATE_PROVENANCE_NAME + ' — which development commit it holds is unknown');
  else if (plan.dev.git.head && pv.devCommit !== plan.dev.git.head) warnings.push('the template was published from ' + (pv.devCommit || '(unknown)') + ', the development tree is at ' + plan.dev.git.head + ' (files may still match)');
  const ok = differences.length === 0;
  return {
    schema: PUBLISH_SCHEMA, mode: 'verify', ok, exitCode: ok ? PUBLISH_EXIT.ok : PUBLISH_EXIT.differs, templateDir: plan.templateDir, devDir: plan.devDir,
    templateVersion: { template: plan.templateVersion.current, dev: plan.templateVersion.dev }, missingInTemplate: tplShip ? tplShip.missingBlocking : null,
    differences, warnings, provenance: pv, counts: plan.counts,
  };
}

/** parsePublishTemplateArgs(argv) -> {mode, templateDir, batchId, batchIdUnsafe, json, verbose, allowDirty, confirmRealTemplate, backupDir, error}. */
function parsePublishTemplateArgs(argv) {
  const a = { mode: 'plan', modes: 0, templateDir: null, batchId: null, batchIdUnsafe: false, json: false, verbose: false, allowDirty: null, retireUnprovenOrphans: null, confirmRealTemplate: false, backupDir: null, error: null };
  const setErr = (m) => { if (!a.error) a.error = m; };
  const val = (i, name) => { const v = argv[i + 1]; if (v === undefined || String(v).startsWith('--')) { setErr('missing value for ' + name); return null; } return v; };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--plan' || x === '--apply' || x === '--verify') { a.mode = x.slice(2); a.modes++; continue; }
    if (x === '--confirm-real-template') { a.confirmRealTemplate = true; continue; }
    if (x === '--json') { a.json = true; continue; }
    if (x === '--verbose') { a.verbose = true; continue; }
    if (x === '--template-dir' || x === '--batch-id' || x === '--batch' || x === '--allow-dirty' || x === '--retire-unproven-orphans' || x === '--backup-dir') {
      const v = val(i, x);
      if (v == null) continue;
      i++;
      if (x === '--template-dir') a.templateDir = v;
      else if (x === '--backup-dir') a.backupDir = v;
      else if (x === '--allow-dirty' || x === '--retire-unproven-orphans') {
        if (!validAllowDirtyReason(v)) setErr(x + ' needs a reason of 3-500 characters (it is recorded in the receipt)');
        else if (x === '--allow-dirty') a.allowDirty = v.trim();
        else a.retireUnprovenOrphans = v.trim();
      } else { a.batchId = v; a.batchIdUnsafe = !isSafeBatchId(v); }
      continue;
    }
    setErr('unknown argument ' + x);
  }
  if (a.modes > 1) setErr('choose one of --plan, --apply, --verify');
  if (a.mode !== 'apply' && (a.allowDirty != null || a.retireUnprovenOrphans != null || a.confirmRealTemplate || a.backupDir != null)) setErr('--allow-dirty, --retire-unproven-orphans, --confirm-real-template and --backup-dir only apply to --apply');
  if (a.batchIdUnsafe && a.mode !== 'apply') setErr(unsafeBatchIdReason(a.batchId)); // with --apply it is a refusal (exit 4)
  return a;
}

function publishList(out, label, items, cap, fmt) {
  if (!items.length) return;
  out.push('  ' + label + ' (' + items.length + ')');
  for (const x of items.slice(0, cap)) out.push('    ' + (fmt ? fmt(x) : x));
  if (items.length > cap) out.push('    … +' + (items.length - cap) + ' more (--verbose)');
}
/** formatPublishPlan(plan, verbose) -> human text for --plan (and the plan part of --apply). */
function formatPublishPlan(plan, verbose) {
  const cap = verbose ? Infinity : 15;
  const c = plan.counts, g = plan.dev.git, out = [];
  out.push('forge-sync publish-template ' + plan.mode + ' — ' + plan.devDir + ' -> ' + plan.templateDir + (plan.realTemplate ? '  [the REAL central template]' : ''));
  out.push('  publish set: ' + c.source + ' file(s) (ship-sync ' + c.shipSync + ' · seed-only ' + c.seedOnly + ' · template-channel ' + c.templateOnly + ') · add ' + c.add + ' · update ' + c.update + ' · unchanged ' + c.unchanged + (c.blocked ? ' · BLOCKED ' + c.blocked : ''));
  out.push('  orphans: ' + c.orphansRetirable + ' proven ours (moved into the backup on --apply) · ' + c.orphansKept + ' unproven (kept, never moved) · ' + c.foreign + ' foreign (installer/per-project content, never managed)');
  out.push('  templateVersion: ' + (plan.templateVersion.current || '(unknown)') + ' -> ' + plan.templateVersion.afterPublish + (plan.templateVersion.current === plan.templateVersion.dev ? ' (already equal)' : '') + (plan.templateVersion.exactAfterPublish ? '' : ' (NOT exact: a kept ship-sync orphan stays in the template)'));
  out.push('  development tree: ' + (g.available ? 'HEAD ' + (g.head || '(no commit)') + ' · ' + (g.dirtyPaths.length ? g.dirtyPaths.length + ' published path(s) NOT committed' : 'published paths committed') : 'git state unknown (' + g.error + ')'));
  const pv = plan.provenance.current;
  out.push('  template provenance now: ' + (pv.devCommit ? pv.devCommit + ' (' + pv.source + (pv.publishedAt ? ', published ' + pv.publishedAt : '') + ')' : 'unknown (' + pv.source + ')'));
  publishList(out, 'ADD', plan.add, cap, (x) => x.rel);
  publishList(out, 'UPDATE', plan.update, cap, (x) => x.rel);
  publishList(out, 'BLOCKED', plan.blocked, cap, (x) => x.rel + ' — ' + x.reason);
  publishList(out, 'ORPHAN, proven ours', plan.orphans.filter((x) => x.retirable), cap, (x) => x.rel + ' — ' + x.why + ' [' + x.provenBy + ']');
  publishList(out, 'ORPHAN, unproven — kept (an owner can move them with --apply --retire-unproven-orphans "<reason>")', plan.orphans.filter((x) => !x.retirable), cap, (x) => x.rel + ' — ' + x.why + '; ' + x.keptReason);
  publishList(out, 'foreign (left alone)', plan.foreign, verbose ? Infinity : 8, (x) => x.rel + ' — ' + x.why);
  publishList(out, 'never published (manifest claims, floor refuses)', plan.neverPublishClaimed, cap, (x) => x.rel + ' — ' + x.why);
  publishList(out, 'uncommitted published paths', g.dirtyPaths || [], cap);
  if (plan.applyWouldRefuse && plan.applyWouldRefuse.length) publishList(out, '--apply would REFUSE', plan.applyWouldRefuse, Infinity);
  out.push(plan.inSync ? '  ⇒ the template matches the development tree' : '  ⇒ the template DIFFERS from the development tree');
  return out.join('\n');
}
function formatPublishVerify(v) {
  if (v.error) return 'forge-sync publish-template verify: could not run — ' + v.error;
  const out = ['forge-sync publish-template verify — ' + v.devDir + ' vs ' + v.templateDir];
  out.push('  templateVersion: template ' + (v.templateVersion.template || '(unknown)') + ' · development tree ' + v.templateVersion.dev);
  for (const d of v.differences) out.push('  DIFFERENCE ' + d.kind + (d.paths.length ? ' (' + d.paths.length + '): ' + d.paths.slice(0, 12).join(', ') + (d.paths.length > 12 ? ', …' : '') : '') + (d.detail ? ' — ' + d.detail : ''));
  for (const w of v.warnings) out.push('  note: ' + w);
  out.push(v.ok ? '  ⇒ VERIFIED: the template holds exactly the development tree\'s published set' : '  ⇒ NOT VERIFIED (' + v.differences.length + ' difference kind(s))');
  return out.join('\n');
}
function formatPublishApply(r, verbose) {
  const out = [];
  if (r.plan) out.push(formatPublishPlan(Object.assign({}, r.plan, { mode: 'apply' }), verbose));
  if (r.refused) { out.push('  ⇒ APPLY REFUSED — nothing in the template was changed:'); (r.reasons || []).forEach((x) => out.push('    - ' + x)); return out.join('\n'); }
  if (r.error && !r.ok) {
    out.push('  ⇒ APPLY FAILED: ' + r.error);
    if (r.restore) out.push('  restore: ' + (r.restore.ok ? 'every touched path is back as it was (' + r.restore.restored.length + ')' : 'INCOMPLETE — MANUAL RECOVERY REQUIRED: ' + r.restore.problems.map((p) => p.rel + ' (' + p.reason + ')').join('; ') + ' — ' + r.manualRecovery));
    if (r.backupDir) out.push('  backup: ' + r.backupDir);
    return out.join('\n');
  }
  if (r.noop) out.push('  ⇒ nothing to publish (files identical, provenance current) — nothing was written');
  else out.push('  applied: ' + r.applied.added.length + ' added, ' + r.applied.updated.length + ' updated, ' + r.applied.orphansMoved.length + ' orphan(s) moved into the backup, ' + r.applied.orphansKept.length + ' kept · backup + receipt: ' + r.backupDir);
  if (r.verify) out.push(formatPublishVerify(r.verify));
  return out.join('\n');
}
function publishJson(x) { return JSON.stringify(x, (k, v) => (k === 'content' ? undefined : v), 2); }

/** publishTemplateCli(argv, env) -> exit code. env: {devDir, defaultTemplateDir, hooks?}. Generates the batch id and the
 *  time (the library never does). */
function publishTemplateCli(argv, env) {
  const a = parsePublishTemplateArgs(argv);
  if (a.error) { console.error('forge-sync publish-template: ' + a.error + '\n' + PUBLISH_USAGE); return PUBLISH_EXIT.usage; }
  const opts = {
    devDir: env.devDir, templateDir: a.templateDir ? path.resolve(a.templateDir) : env.defaultTemplateDir, realTemplateDir: env.defaultTemplateDir,
    batchId: a.batchId || ('publish-' + Date.now()), nowIso: new Date().toISOString(), allowDirty: a.allowDirty, retireUnprovenOrphans: a.retireUnprovenOrphans,
    confirmRealTemplate: a.confirmRealTemplate, backupDir: a.backupDir ? path.resolve(a.backupDir) : null, hooks: env.hooks || null,
  };
  if (a.mode === 'apply') {
    const r = applyPublishTemplate(opts);
    console.log(a.json ? publishJson(r) : formatPublishApply(r, a.verbose));
    return r.exitCode;
  }
  if (a.mode === 'verify') {
    const v = verifyPublishTemplate(opts);
    console.log(a.json ? publishJson(v) : formatPublishVerify(v));
    return v.exitCode;
  }
  let plan;
  try { plan = planPublishTemplate(opts); }
  catch (e) { console.error('forge-sync publish-template: could not plan — ' + e.message); return PUBLISH_EXIT.error; }
  console.log(a.json ? publishJson(plan) : formatPublishPlan(plan, a.verbose));
  return PUBLISH_EXIT.ok;
}

module.exports = {
  publishApplyBlockers, listSystemFiles, sha256, sha256Normalized, normalizeEolBuffer, fileStatus, templateVersion, claudeDirOf, safeJoin, isSymlinkPath,
  containmentSafe, projectId, receiptPath, readReceipt, writeReceipt, writeAtomic, receiptLastTemplateHashMap,
  overridesAllowlistPath, readOverrideAllowlist, migrateOwnerStandingRules,
  preflight, buildPlan, fullFileManifest, aggregateManifestHash,
  versionFilePath, readVersionFile, backupDirFor, centralBackupDir, takeBackup, applyPlanSafely, runValidation,
  decideValidationOutcome, decidePreBaseline, preBaselineManifestHash, manifestForRels, workspaceFingerprint, evidenceOk, evidenceGap, condenseDoctorSummary, regressionCheck, seedCanaryRun, seedProjectScaffold, undoScaffold,
  doctorProvenance, doctorTreeHash, installerSyntaxGate, copyNoFollow,
  verifyBackupIntegrity, loadTrustedManifest, findNewerOverlappingBatches, restoreFromManifest, subsetManifest,
  journalPath, latestBatchId, batchRecency, acquireLock, releaseLock, lockPathFor, readLockStatus, pidAlive, LOCK_STALE_MS, DEFAULT_DOCTOR_TIMEOUT_MS,
  rollbackProject, rollbackBatch, safeSyncProject, adoptProject, rawInstall, status, findForgeProjects,
  dedicatedCanaryDir, canaryInit, runSyncAll, parseArgs, CANARY_DIR_NAME,
  syncProjectSettings, printSettingsMergeResult, defaultCentralBackupRoot,
  // R6(b) — exported so a test can exercise the plan-summary labeling directly, same pattern as the other
  // print* helpers above.
  printPlanSummary, STANDING_RULES_REL, STANDING_RULES_USER_REL,
  // retired per-project Control Center cleanup; see pruneRetiredFiles's own doc comment.
  pruneRetiredFiles, restoreRetiredPruneLedger, RETIRED_TEMPLATE_FILES, RETIRED_STATE_FILES, printRetiredPruneResult,
  // the shipping manifest drives delivery; seed-only; never-touch floor; orphans; batch ids
  listSeedFiles, shipPlan, loadShipManifest, literalDirPrefixes, isNeverTouch, isNeverTouchDir, NEVER_TOUCH_DIRS, NEVER_TOUCH_FILES, NEVER_TOUCH_ROOT_DIRS, stateRootOf, walkStateRoot,
  SHIP_MANIFEST_REL, OWN_SHIP_MANIFEST, isSafeBatchId, migrateScoutVerdicts, SCOUT_VETTING_REL, SCOUT_VETTING_USER_REL,
  findOrphans, retireOrphans, restoreRetiredOrphansLedger, RETIRED_ORPHANS_SUBDIR, RETIRED_ORPHANS_MANIFEST_NAME,
  // part 1 — quiesce, protect manifest, settings ledger, dry-run JSON, provenance + report, coupled trio
  quiesceCheck, isBareScaffold, isUntouchedFreshInstall, claudeProjectSlug, transcriptFoldersFor, listProcessesStructured, pathVariantsForMatch, commandLineMentions, QUIESCE_DEFAULT_IDLE_MIN,
  buildProtectManifest, writeProtectManifest, readProtectManifest, verifyProtect, diffProtectManifests, protectExpectationsFromRun,
  protectExpectationsFromBatch, protectAllowance, isSecretLikeRel, protectViolationLines, PROTECT_SCHEMA,
  // WP-SYNC-R8 — .claude/worktrees is one summary entry, never descended; git does not enumerate .claude/
  PROTECT_SUMMARIZED, PROTECT_SUMMARY_NAMES_MAX, protectSummaryFor, gitExcludePathspec,
  mergeSettingsForBatch, restoreSettingsLedger, SETTINGS_LEDGER_NAME, coupledDeliveryCheck, COUPLED_DELIVERY_GROUPS,
  undoSettingsMerge, settingsRestoreProblem, abortNote, // WP-SYNC-R11: the merge precedes the doctor; in-run rollbacks undo it
  // WP-SYNC-R12 — the validation window: snapshots, drift check, in-run settings restore, unconfirmed-merge settle
  settingsSnapshot, sameSettingsState, settingsRollbackTarget, settingsDriftCheck, putBackPreSyncSettings, removeOwnForgeBak, restoreSettingsInRun,
  settleUnconfirmedSettingsMerge, filesRestoreProblem,
  templateProvenance, provenanceFor, previewProjectScaffold, settingsDelta, installPlanJson, buildSyncReport, writeSyncReport,
  GITIGNORE_SCAFFOLD_HEADER, printSafeSyncResult,
  // publish-template: refresh the central template from the development tree, manifest-driven
  planPublishTemplate, applyPublishTemplate, verifyPublishTemplate, publishSourceSet, classifyTemplateExtra, proveTemplateOrphan,
  devGitState, backupTemplateTree, restorePublish, parsePublishTemplateArgs, publishTemplateCli, formatPublishPlan, formatPublishVerify,
  defaultRealTemplateDir, missingInTemplateReason, printMissingInTemplate, PUBLISH_TEMPLATE_HINT, PUBLISH_EXIT, PUBLISH_SCHEMA, PUBLISH_RECEIPT_SCHEMA,
  TEMPLATE_PROVENANCE_NAME, TEMPLATE_PUBLISH_RECEIPT_NAME, DEV_TREE_MARKER_REL,
  // R3 (SYNC-01..13) — real-folder chains, bound manifests, the apply journal, quarantine moves,
  // case collisions, the git application-code guard
  realDirChain, ensureRealDir, centralAnchorFor, writeBoundManifest, manifestBinding, manifestEntryProblems, manifestSelfHash,
  readApplyJournal, quarantineAndVerify, writeBytesNoFollow, caseCollisions, appCodeGitState, isPlainRel, foldCase,
  BACKUP_MANIFEST_SCHEMA, APPLY_JOURNAL_NAME,
  // R4 (F01..F13) — chained no-follow journal, path hygiene, the real-path floor, normKey,
  // two-phase lock reclaim, lock states, suspect images, the merge-tool-attributed settings hash
  appendApplyJournal, recordApplyJournalHead, pathHygieneProblem, normKey, realTargetProblem, isSuspectImage, LOCK_RECLAIM_MARKER_STALE_MS,
  JOURNAL_GENESIS, quiesceRecord,
  // R6 (F14..F19) — the floor verdict with its physical folder, the journal-head check
  realTargetCheck, journalHeadError, APP_SUBTREE_MAX_DEPTH,
  // WP-SYNC-R7 (26H2 rehearsal) — template history + --accept-template, per-suite regressions, control characters
  // in the process listing, the doctor limit + duration, the dev-tree refusal
  templateHistoryMatcher, readTemplatePublishHistory, devTreeGitContext, buildPublishHistory, TEMPLATE_HISTORY_MAX_PER_PATH,
  applyAcceptTemplate, normalizeAcceptRel, acceptTemplateRefusal, suiteRegressions, doctorTimeoutFor, DOCTOR_TIMEOUT_PER_SUITE_MS,
  escapeJsonStringControlChars, parseWin32ProcessJson, devTreeTargetCheck, changedFileLabel, doctorLine, printTemplateHistoryAndAccept,
  // WP-SYNC-R9 (real 26H2 install) — failing lines of every flagged suite + one isolated re-run before a suite-only rollback
  confirmSuiteRegressions, suiteRerunPlan, runIsolatedSuite, summaryWithSuitesGreen, scrubFailLines, suiteOutputFailLines, suiteOutputTail, suiteTally,
  suiteCheckReportLines, suiteCheckLines, doctorSuiteDurationHint, isolatedRerunTimeout, trustedSuitePool, loadDoctorScrubber,
  SUITE_FAIL_LINES_MAX, SUITE_FAIL_LINE_MAX_CHARS, FLAKY_HONESTY, DOCTOR_SUITE_TIMEOUT_MS_MIRROR,
  // WP-SYNC-R10 — coverage parity, stdout-only single tally, whole-output redaction, budget + tree kill,
  // allow-listed env + change snapshot, scrubbed errors, error record; checkout-only worktrees summary + memory-link refusal
  stripCredentialBlocks, redactSuiteOutput, scrubOneLine, isolatedAcceptance, ACCEPTANCE_HEURISTIC_NOTE, isolatedRerunBudget, ISOLATED_RERUN_BUDGET_DEFAULT_MS,
  isolatedRerunEnv, ISOLATED_ENV_ALLOW, ISOLATED_RUNNER_SRC, projectChangeSnapshot, projectChangesBetween, projectChangesLine, suiteCheckErrorRecord,
  hasGitEntry, protectCheckoutEntry, linkIntoWorktrees, worktreesChildrenSignature, isolatedVerdict,
  // WP-SYNC-R13 (third real 26H2 install) — unreadable on both sides = not comparable (counted), never a violation
  protectUnreadableEntry, protectUnreadableSame, protectErrorCode, protectErrorSyscall, protectUnreadableSummary, protectNotComparableLine,
  // WP-SYNC-R13B (Codex R13-01..05) — "not comparable" only inside .claude/worktrees/<name>/; a failed .git probe is fail closed; counts
  protectNotComparableScope, gitEntryState, protectCounts, protectWhyLines,
  // WP-SYNC-R14 (Codex R14-01..04) — failed link / app reads fail closed; links into worktrees or out of the project above memory refused
  protectLinkRefusal, protectLinkGuardsFloor, linkResolvesOutside, appUnreadableMarker, appEntryUnreadable, protectAppCoverage,
  protectScopeVerdict, protectInstallLine, protectReceiptRecord, PROTECT_CONTENT_KINDS,
};

// ---- CLI ----
if (require.main === module) {
  const GLOBAL_TEMPLATE = path.join(os.homedir(), '.claude', 'forge', 'template', '.claude');
  const OWN_CLAUDE = path.resolve(__dirname, '..');
  const TEMPLATE = process.env.FORGE_SYNC_TEMPLATE_DIR
    ? path.resolve(process.env.FORGE_SYNC_TEMPLATE_DIR)
    : (fs.existsSync(GLOBAL_TEMPLATE) ? GLOBAL_TEMPLATE : OWN_CLAUDE);
  // FAIL CLOSED WHEN THE CANONICAL TEMPLATE IS MISSING (broad Codex audit #23).
  // The fallback above quietly turns THIS project's own .claude into "the template". Installing into
  // another project then copies this project's governance and identity into it — a cross-project
  // contamination that looks like a normal successful sync. The fallback is legitimate for one case
  // only: operating on this very project (status / self-refresh). Any OTHER target must name a template
  // explicitly, so nobody can seed project B from project A by accident.
  const TEMPLATE_IS_FALLBACK = !process.env.FORGE_SYNC_TEMPLATE_DIR && !fs.existsSync(GLOBAL_TEMPLATE);
  function refuseForeignTargetOnFallback(targetDir) {
    if (!TEMPLATE_IS_FALLBACK || !targetDir) return;
    const ownProject = path.resolve(OWN_CLAUDE, '..');
    if (path.resolve(targetDir) === ownProject) return; // self-operation: fine
    console.error('forge-sync: REFUSING to sync "' + path.resolve(targetDir) + '" — the canonical template is missing');
    console.error('  (' + GLOBAL_TEMPLATE + ' does not exist), so the only template available is THIS project\'s own .claude.');
    console.error('  Using it would copy this project\'s governance and identity into another project.');
    console.error('  Install the global template, or pass one explicitly: FORGE_SYNC_TEMPLATE_DIR=<path-to-template/.claude>');
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const { flags, pos, argError } = parseArgs(argv.slice(1));

  function exitUsage(msg) { console.error(msg); process.exit(2); }
  /** quiesceOptsFromEnv — test seams for the CLI ONLY, honoured only under FORGE_SYNC_TEST_HOOKS=1 (the same gate as
   *  the M11 rollback hook): FORGE_SYNC_TEST_PROCESS_LIST (a JSON process list) and FORGE_SYNC_TEST_PROJECTS_ROOT (a
   *  stand-in for ~/.claude/projects), so the suite never depends on — or reads — the real machine's sessions. */
  function quiesceOptsFromEnv(base) {
    const o = Object.assign({}, base);
    if (process.env.FORGE_SYNC_TEST_HOOKS === '1') {
      if (process.env.FORGE_SYNC_TEST_PROCESS_LIST != null) { const list = JSON.parse(process.env.FORGE_SYNC_TEST_PROCESS_LIST); o.listProcesses = () => list; }
      if (process.env.FORGE_SYNC_TEST_PROJECTS_ROOT) o.projectsRoot = process.env.FORGE_SYNC_TEST_PROJECTS_ROOT;
    }
    return o;
  }

  /** templateHistoryOpts — WP-SYNC-R7 item 1: the development tree THIS forge-sync.cjs lives in (only when it carries the
   *  dev-tree marker) is one more source of template history for install / sync-all. Test seam, honoured ONLY under
   *  FORGE_SYNC_TEST_HOOKS=1: FORGE_SYNC_TEST_DEV_DIRS (a JSON array) replaces it, so the suite never reads the real
   *  development tree's git history. */
  function templateHistoryOpts() {
    if (process.env.FORGE_SYNC_TEST_HOOKS === '1' && process.env.FORGE_SYNC_TEST_DEV_DIRS != null) {
      let dirs = [];
      try { const v = JSON.parse(process.env.FORGE_SYNC_TEST_DEV_DIRS); if (Array.isArray(v)) dirs = v.filter((x) => typeof x === 'string'); } catch { dirs = []; }
      return { devDirs: dirs };
    }
    return { devDirs: readDevTreeMarker(OWN_CLAUDE) ? [OWN_CLAUDE] : [] };
  }

  if (cmd === 'publish-template') {
    // its own flags (--template-dir, --allow-dirty "<reason>", ...), parsed by parsePublishTemplateArgs — dispatched
    // before the generic parser's checks. The development tree is the one THIS forge-sync.cjs lives in; the default target
    // is the real central template (an --apply there needs --confirm-real-template). FORGE_SYNC_TEMPLATE_DIR is never a
    // publish target (it names what install READS, often the dev tree itself).
    let hooks = null;
    if (process.env.FORGE_SYNC_TEST_HOOKS === '1' && process.env.FORGE_SYNC_TEST_PUBLISH_FAIL_AT != null) { // test seam only
      const at = Number(process.env.FORGE_SYNC_TEST_PUBLISH_FAIL_AT);
      hooks = { beforeAction: (i) => { if (i === at) throw new Error('test seam: simulated failure before action ' + i); } };
    }
    process.exit(publishTemplateCli(argv.slice(1), { devDir: OWN_CLAUDE, defaultTemplateDir: GLOBAL_TEMPLATE, hooks }));
  }

  if (argError) exitUsage('forge-sync: ' + argError); // M1

  // status/doctor only: read-only, low risk. WP 2.1: forge-paths scriptRoot when it is there (an installed copy keeps the
  // old own-folder answer); without forge-paths the old expression.
  let ownProject0 = null;
  if (!forgePathsMod || typeof forgePathsMod.scriptRoot !== 'function') ownProject0 = path.resolve(__dirname, '..', '..'); // forge-paths fallback
  else { try { ownProject0 = forgePathsMod.scriptRoot(__dirname); } catch { ownProject0 = null; } }
  const defaultProject = pos[0] || ownProject0;
  if (!defaultProject && (cmd === 'status' || cmd === 'doctor')) exitUsage('forge-sync: no project root found (no .claude, .forge or .git above the current folder) — pass the project folder: forge-sync ' + cmd + ' <projectDir>');
  const batchId = flags.batchId || ('sync-' + Date.now());

  if (cmd === 'status' || cmd === 'doctor') {
    /** 2026-09-23 (external audit II-A): with no canonical template, TEMPLATE silently became this
     *  project's OWN .claude, and status compared the tree with itself — printing "up to date ✓" on
     *  every fresh install, forever, because a tree can never be behind itself. That is a tautology, not
     *  a check. Say so plainly instead of pretending the update check ran. */
    if (TEMPLATE_IS_FALLBACK) {
      console.log('forge-sync status: NO canonical template at ' + GLOBAL_TEMPLATE);
      console.log('  Without it this tree can only be compared with itself, which can never detect that it is behind.');
      console.log('  Run the installer without --project-only to create the template, or set FORGE_SYNC_TEMPLATE_DIR.');
      let vfStatus = {}; try { vfStatus = JSON.parse(fs.readFileSync(path.join(claudeDirOf(defaultProject), 'FORGE_VERSION.json'), 'utf8')); } catch { /* none */ }
      console.log('  (installed version: ' + (vfStatus.forge_version || 'none') + ' · update check: NOT PERFORMED)');
      process.exit(0);
    }
    process.exit(status(TEMPLATE, defaultProject, flags.verbose));
  } else if (cmd === 'install') {
    if (!pos[0]) exitUsage('usage: forge-sync install <projectDir> [--dry-run [--json]] [--force-overwrite] [--accept-template <rel>]... [--unsafe] [--batch-id <id>] [--central-backup-root <dir>] [--no-central-backup] [--run-id <id>] [--allow-degraded] [--doctor-timeout <ms>] [--resume-batch] [--reuse-pre-baseline] [--retire-orphans] [--no-isolated-rerun] [--isolated-rerun-budget <ms>] [--idle-min <n>] [--quiesce-override "<reason>"] [--allow-dev-tree-target "<reason>"]');
    if (flags.unsafe && flags.retireOrphans) exitUsage('forge-sync: --retire-orphans is not available with --unsafe (it needs the validated safe path); run install without --unsafe');
    if (flags.json && (!flags.dryRun || flags.unsafe)) exitUsage('forge-sync: install --json is only available together with --dry-run on the safe path (it prints the full plan as JSON and writes nothing)');
    if (flags.quiesceOverride != null && flags.dryRun) exitUsage('forge-sync: --quiesce-override only applies to a real install (a dry-run never needs the project to be idle)');
    /** 2026-09-23 (external audit II-B): on a machine WITHOUT the canonical template, the template-refusal
     *  below fired before anything looked at the target — so a user pointing `install` at a folder that
     *  simply has no .claude/ yet got "the canonical template is missing" instead of the one message that
     *  tells them what to do ("not a project (.claude missing) — run the installer"). The most specific,
     *  actionable diagnosis goes first. */
    if (fs.existsSync(pos[0]) && !fs.existsSync(claudeDirOf(pos[0]))) {
      console.error('forge-sync: not a project (.claude missing): ' + path.resolve(pos[0]) + ' — forge-sync updates an EXISTING Forge project and never creates .claude/ itself. For a FIRST install run the installer: `bash install.sh --project "' + path.resolve(pos[0]) + '"` (or install.ps1 on Windows).');
      console.error(INIT_NOTICE_NEW);
      process.exit(2);
    }
    refuseForeignTargetOnFallback(pos[0]); // audit #23: never seed another project from this one
    // default central backup hub now lives INSIDE the project — see
    // defaultCentralBackupRoot()'s own comment for why (was <parent-of-project>/.forge-backup-hub).
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || defaultCentralBackupRoot(pos[0]));
    if (flags.dryRun && centralBackupRoot && !flags.json) console.log('[dry-run] backups would also be written to: ' + centralBackupRoot + ' (inside the project — pass --no-central-backup to skip this second copy, or --central-backup-root to point it elsewhere)');
    // the lock is taken BEFORE the first write of the batch and removed in the finally below, also after a
    // refusal or an automatic rollback. It carries pid + batch id + started_at. R4 / F09 + F11: the lock comes FIRST — a
    // stale lock left by a dead run is reclaimed by acquireLock's own two-phase reclaim (a live owner refuses with its pid
    // and age) — and the quiesce check then runs UNDER our lock (check-after-lock), recognising it as this run's own.
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(claudeDirOf(pos[0]), { batchId });
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    if (lock.reclaimedStale) console.warn('forge-sync: reclaimed a stale lock left by a run that is no longer alive (pid ' + (lock.reclaimedFrom && lock.reclaimedFrom.pid) + ', ' + Math.round(((lock.reclaimedFrom && lock.reclaimedFrom.ageMs) || 0) / 3600000) + ' h old)');
    let exitCode = 1;
    try {
      // a real install proves the target idle. Not idle and no recorded override -> refuse, nothing written.
      let quiesce = null;
      if (!flags.dryRun) {
        quiesce = quiesceCheck(pos[0], quiesceOptsFromEnv({ idleMin: flags.idleMin, ownLock: lock.lockPath ? { nonce: lock.nonce, pid: lock.pid } : null }));
        if (!quiesce.idle) {
          if (!flags.quiesceOverride) {
            console.error('forge-sync: REFUSING install — ' + path.resolve(pos[0]) + ' is not proven idle (window ' + quiesce.idleMin + ' min):');
            quiesce.reasons.forEach((r) => console.error('  - ' + r));
            console.error('  Stop the sessions/agents/processes that write to it and re-run, or pass --quiesce-override "<reason>" to record a deliberate exception. Nothing was written.');
            releaseLock(lock);
            process.exit(1);
          }
          console.warn('forge-sync: WARNING — the project is NOT proven idle; continuing under --quiesce-override (recorded in the receipt and the change report): ' + flags.quiesceOverride);
          quiesce.reasons.forEach((r) => console.warn('  - ' + r));
        }
      }
      if (flags.unsafe) {
        console.warn('*** --unsafe: install for ' + pos[0] + ' WITHOUT canary and WITHOUT validation; drift still refuses (unless --force-overwrite), a real backup and a receipt are still written ***');
        const r = rawInstall(TEMPLATE, pos[0], {
          dryRun: flags.dryRun, batchId, centralBackupRoot, runId: flags.runId, forceOverwrite: flags.forceOverwrite,
          mergeSettings: !flags.dryRun, requireQuiesce: !flags.dryRun, quiesce, quiesceOverride: flags.quiesceOverride || null,
          acceptTemplate: flags.acceptTemplate || null, allowDevTreeTarget: flags.allowDevTreeTarget || null, templateHistory: templateHistoryOpts(), // WP-SYNC-R7
        });
        let settingsResult = null;
        if (r.ok) { settingsResult = r.settingsMerge !== undefined ? r.settingsMerge : syncProjectSettings(TEMPLATE, pos[0], { dryRun: flags.dryRun }); printSettingsMergeResult(pos[0], settingsResult); }
        if (r.report && r.report.path) console.log('  change report: ' + r.report.path);
        // SUCCESS-WITHOUT-SETTINGS (wp-f2): --unsafe must not exit 0 when the file copy succeeded but the
        // required settings.json gate failed/was refused.
        exitCode = (r.ok && !settingsMergeFailed(settingsResult)) ? 0 : 1;
      } else {
        const r = safeSyncProject(TEMPLATE, pos[0], {
          dryRun: flags.dryRun, forceOverwrite: flags.forceOverwrite, batchId, centralBackupRoot, runId: flags.runId,
          allowDegraded: flags.allowDegraded, doctorTimeoutMs: flags.doctorTimeout, resumeBatch: flags.resumeBatch,
          reusePreBaseline: flags.reusePreBaseline, retireOrphans: flags.retireOrphans, allowLegacyManifest: !!flags.allowLegacyManifest,
          noIsolatedRerun: !!flags.noIsolatedRerun, isolatedRerunBudgetMs: flags.isolatedRerunBudget, // WP-SYNC-R9 / WP-SYNC-R10
          refuseOnUnresolvedDrift: true, // B3: a direct single-project install is all-or-nothing (sync-all is not)
          requireQuiesce: !flags.dryRun, quiesce, quiesceOverride: flags.quiesceOverride || null,
          acceptTemplate: flags.acceptTemplate || null, allowDevTreeTarget: flags.allowDevTreeTarget || null, templateHistory: templateHistoryOpts(), // WP-SYNC-R7
        }); // settings.json merge is internal to safeSyncProject (WP22) — r.settingsMerge is already set, and
        // r.ok already folds settingsMergeFailed(r.settingsMerge) in (see safeSyncProject's own return sites)
        if (flags.json) console.log(JSON.stringify(installPlanJson(TEMPLATE, pos[0], r), null, 2)); // stdout = the plan, nothing else
        else printSafeSyncResult(pos[0], r);
        // an incomplete template exits non-zero — the real install refuses, and its dry-run says so too.
        // so does any other dry-run refusal (unreadable file, coupled delivery).
        exitCode = r.dryRun ? ((r.wouldRefuse || r.refused) ? 1 : 0) : (r.ok ? 0 : 1);
      }
    } finally { releaseLock(lock); }
    if (exitCode === 0 && !flags.dryRun && !flags.json) printInitNotice(pos[0]);
    process.exit(exitCode);
  } else if (cmd === 'adopt') {
    if (!pos[0]) exitUsage('usage: forge-sync adopt <projectDir> [--dry-run] [--force]');
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(claudeDirOf(pos[0])); // S6: adopt writes the receipt — must lock like install does
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let r;
    try { r = adoptProject(TEMPLATE, pos[0], { dryRun: flags.dryRun, force: flags.force }); }
    finally { releaseLock(lock); }
    if (!r.ok) {
      console.error(r.reason);
      process.exit(1);
    }
    if (r.priorBaselineCount > 0) console.log('  NOTE: this replaces an existing baseline of ' + r.priorBaselineCount + ' file(s) — these WILL be overwritten by the next sync' + (r.snapshotPath ? (' (pre-adopt receipt snapshotted to ' + r.snapshotPath + ')') : ''));
    console.log((r.dryRun ? '[dry-run] ' : '') + 'adopted baseline for ' + path.basename(path.resolve(pos[0])) + ': ' + r.knownHashesCount + ' file(s) baselined' + (r.dryRun ? ' (NOT written)' : ''));
    if (r.differing.length) {
      console.log('  ' + r.differing.length + ' file(s) differ from the template — triage into .claude/config/forge-overrides.json if intentionally project-owned:');
      r.differing.forEach((rel) => console.log('    ' + rel));
    } else console.log('  no files differ from the template.');
    process.exit(0);
  } else if (cmd === 'list') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6: no ~/Documents default
    if (!rootDir) exitUsage('usage: forge-sync list <rootDir> (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    const ps = findForgeProjects(rootDir);
    console.log(ps.length + ' Forge project(s) under ' + rootDir + ':');
    ps.forEach((p) => console.log('  ' + p));
    process.exit(0);
  } else if (cmd === 'canary-init') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync canary-init <rootDir> (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    const r = canaryInit(TEMPLATE, rootDir, {});
    console.log('dedicated canary ready at ' + r.dir);
    process.exit(0);
  } else if (cmd === 'sync-all') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync sync-all <rootDir> [...] (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    /** Argument validation comes BEFORE any environment check (external audit II-B): the
     *  template-refusal used to sit in front of the --force-overwrite/--force-all usage gate, so on a
     *  machine without the canonical template a plain flag mistake was reported as a template problem, and
     *  the usage gate itself was unreachable — its tests failed on every fresh install. Exit codes are now
     *  distinct as well: 2 = you typed it wrong (usage), 3 = the environment cannot do it (no template). */
    if (flags.forceOverwrite && !flags.forceAll) exitUsage('forge-sync: --force-overwrite in sync-all requires the explicit --force-all co-flag (prevents an accidental blanket override across every discovered project)');
    // WP-SYNC-R7: both name things of ONE project — they belong to `install`, never to a multi-project batch
    if (flags.acceptTemplate) exitUsage('forge-sync: --accept-template names files of ONE project — use it with `install <projectDir>`, not sync-all');
    if (flags.allowDevTreeTarget) exitUsage('forge-sync: --allow-dev-tree-target is only for `install <projectDir>`; sync-all always skips a development tree it discovers');
    if (flags.quiesceOverride != null && flags.dryRun) exitUsage('forge-sync: --quiesce-override only applies to a real sync-all (a dry-run never needs the projects to be idle)'); // R3 / SYNC-09
    // audit #23: without a canonical template, sync-all would seed EVERY discovered project from this
    // one project's own .claude — the widest possible cross-project contamination. Fail closed.
    if (TEMPLATE_IS_FALLBACK) {
      console.error('forge-sync: REFUSING sync-all — the canonical template is missing (' + GLOBAL_TEMPLATE + '), so this project\'s own .claude would become the template for every discovered project. Install the global template (install.sh / install.ps1 without --project-only creates it), or set FORGE_SYNC_TEMPLATE_DIR explicitly.');
      process.exit(3);
    }
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || path.join(rootDir, '.forge-backup-hub')); // B5
    if (flags.unsafe) console.warn('*** --unsafe: legacy-style sync-all — NO canary, NO validation; a real backup is still taken per project (never "no undo") ***');
    if (flags.forceOverwrite && flags.forceAll && !flags.dryRun) { // print the exact per-project file list BEFORE writing
      const previewProjects = findForgeProjects(rootDir);
      console.log('--force-overwrite --force-all: the following file(s) will be forced through per project (backed up first):');
      for (const p of previewProjects) {
        const pf = preflight(TEMPLATE, p);
        const forced = pf.unknownDrift.concat(pf.conflicts);
        if (forced.length) console.log('  ' + path.basename(p) + ': ' + forced.join(', '));
      }
    }
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(rootDir, { batchId }); // M2
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let exitCode = 1;
    try {
      const result = runSyncAll(TEMPLATE, rootDir, {
        canaryName: flags.canary, stageSize: flags.stageSize, dryRun: flags.dryRun,
        forceOverwrite: flags.forceOverwrite, unsafe: flags.unsafe, batchId,
        centralBackupRoot, runId: flags.runId, allowDegraded: flags.allowDegraded, doctorTimeoutMs: flags.doctorTimeout,
        reusePreBaseline: flags.reusePreBaseline, retireOrphans: flags.retireOrphans, allowLegacyManifest: !!flags.allowLegacyManifest,
        noIsolatedRerun: !!flags.noIsolatedRerun, isolatedRerunBudgetMs: flags.isolatedRerunBudget, // WP-SYNC-R9 / WP-SYNC-R10
        templateHistory: templateHistoryOpts(), // WP-SYNC-R7 item 1
        // every real project is proven idle first, exactly like install (same --idle-min, same --quiesce-override)
        requireQuiesce: !flags.dryRun, quiesceOverride: flags.quiesceOverride || null, quiesceOpts: quiesceOptsFromEnv({ idleMin: flags.idleMin }),
      });
      // A dry-run computes the full per-project plan but writes nothing — SHOW it, otherwise the preview is
      // useless (the operator cannot see what would change before authorising a real 12-project sync).
      if (result.dryRun) {
        if (flags.json) { console.log(JSON.stringify(result, null, 2)); }
        else {
          console.log('[DRY-RUN] sync-all plan for ' + (result.projects ? result.projects.length : 0) + ' project(s) under ' + rootDir + ' — WRITES NOTHING:');
          if (result.dedicatedCanary && result.dedicatedCanary.plan) { console.log('\ndedicated canary (' + path.basename(result.dedicatedCanary.projectDir) + '):'); printPlanSummary(result.dedicatedCanary.plan); }
          for (const p of (result.projects || [])) { console.log('\n' + path.basename(p.projectDir) + ':'); if (p.plan) printPlanSummary(p.plan); else console.log('  (no plan — ' + (p.reason || 'unavailable') + ')'); printSettingsMergeResult(p.projectDir, p.settingsMerge); printOrphanReport(p.projectDir, p.orphans, null); }
          if (result.wouldRefuse) console.error('\nWOULD REFUSE: ' + result.wouldRefuse);
        }
      }
      exitCode = result.ok ? 0 : 1;
    } finally { releaseLock(lock); }
    process.exit(exitCode);
  } else if (cmd === 'rollback') {
    if (!pos[0]) exitUsage('usage: forge-sync rollback <projectDir> [--batch <batchId>] [--central-backup-root <dir>] [--no-central-backup] [--force-rollback-newer] [--allow-legacy-manifest]');
    // must match install's new default exactly, or rollback would look in the old
    // outside-the-project location for a backup install just wrote inside the project.
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || defaultCentralBackupRoot(pos[0]));
    const centralBackupRootExplicit = !!(flags.centralBackupRoot || flags.noCentralBackup); // S3
    const lock = acquireLock(claudeDirOf(pos[0])); // S6: rollback writes to the project — must lock like install does
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let r;
    try { r = rollbackProject(pos[0], flags.batchId || null, { centralBackupRoot, centralBackupRootExplicit, forceRollbackNewer: flags.forceRollbackNewer, allowLegacyManifest: !!flags.allowLegacyManifest }); }
    finally { releaseLock(lock); }
    if (!r.ok) { console.error('rollback failed: ' + r.reason); process.exit(1); }
    console.log('rolled back ' + pos[0] + ' (batch ' + r.batchId + ', source ' + r.source + '): ' + r.restored.length + ' file(s) restored, version ' + r.versionAction + ', receipt ' + r.receiptAction + ', settings.json ' + (r.settingsAction || 'none'));
    if (r.binding === 'legacy-unbound') console.log('  note: this batch had a legacy-unbound manifest (older forge-sync) — restored because --allow-legacy-manifest was given');
    if (r.quarantined && r.quarantined.length) console.log('  moved into the batch backup (created by this batch, changed since — never deleted): ' + r.quarantined.map((q) => q.rel).join(', '));
    if (r.notWritten && r.notWritten.length) console.log('  left as they are (this batch never wrote them — they had changed since its plan): ' + r.notWritten.join(', '));
    process.exit(0);
  } else if (cmd === 'rollback-batch') {
    if (!pos[0]) exitUsage('usage: forge-sync rollback-batch <batchId> <rootDir> [--central-backup-root <dir>] [--no-central-backup] [--force-rollback-newer]');
    const bId = pos[0];
    if (!isSafeBatchId(bId)) exitUsage('forge-sync: ' + unsafeBatchIdReason(bId)); // the positional batch id too
    const rootDir = pos[1] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync rollback-batch <batchId> <rootDir> (root required — no home-dir default)');
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || path.join(rootDir, '.forge-backup-hub'));
    const centralBackupRootExplicit = !!(flags.centralBackupRoot || flags.noCentralBackup); // S3
    const rootLock = acquireLock(rootDir); // S6: mirrors sync-all's root lock
    if (!rootLock.ok) { console.error('forge-sync: ' + rootLock.reason); process.exit(1); }
    let results;
    try { results = rollbackBatch(rootDir, bId, { centralBackupRoot, centralBackupRootExplicit, forceRollbackNewer: flags.forceRollbackNewer, allowLegacyManifest: !!flags.allowLegacyManifest }); }
    finally { releaseLock(rootLock); }
    results.forEach((r) => console.log((r.ok ? 'rolled back ' : 'FAILED ') + r.projectDir + (r.ok ? (': ' + r.restored.length + ' file(s)') : (': ' + r.reason))));
    const okCount = results.filter((r) => r.ok).length; // B4: count only real successes, never results.length
    console.log(okCount + ' of ' + results.length + ' project(s) rolled back for batch ' + bId);
    process.exit(results.length > 0 && okCount === results.length ? 0 : 1);
  } else if (cmd === 'quiesce-check') {
    // read-only. Exit 0 = idle, 1 = busy or unknown (unknown is never idle), 2 = usage.
    if (!pos[0]) exitUsage('usage: forge-sync quiesce-check <projectDir> [--idle-min <n>] [--json]');
    if (!fs.existsSync(claudeDirOf(pos[0]))) exitUsage('forge-sync: not a project (.claude missing): ' + path.resolve(pos[0]));
    const q = quiesceCheck(pos[0], quiesceOptsFromEnv({ idleMin: flags.idleMin }));
    if (flags.json) console.log(JSON.stringify(q, null, 2));
    else {
      console.log('quiesce-check ' + q.projectPath + ' (window ' + q.idleMin + ' min): ' + (q.idle ? 'IDLE' : (q.unknown ? 'NOT PROVEN IDLE (unknown counts as busy)' : 'BUSY')));
      for (const k of Object.keys(q.checks)) console.log('  ' + (q.checks[k].state === 'ok' ? 'ok     ' : q.checks[k].state.toUpperCase().padEnd(7)) + k + ': ' + q.checks[k].detail);
    }
    process.exit(q.idle ? 0 : 1);
  } else if (cmd === 'lock-status') {
    // read-only. Exit 0 = no fresh lock, 1 = a fresh lock (the project is in maintenance mode), 2 = usage.
    if (!pos[0]) exitUsage('usage: forge-sync lock-status <projectDir> [--json]');
    if (!fs.existsSync(claudeDirOf(pos[0]))) exitUsage('forge-sync: not a project (.claude missing): ' + path.resolve(pos[0]));
    const ls = readLockStatus(claudeDirOf(pos[0]));
    if (flags.json) console.log(JSON.stringify(ls, null, 2));
    else if (!ls.present) console.log('lock-status ' + path.resolve(pos[0]) + ': no .forge-sync.lock — no sync is running');
    else {
      const mins = Math.round(ls.ageMs / 60000);
      // an OLD lock whose process is still alive is a RUNNING sync, not a stale lock
      const label = ls.fresh ? 'FRESH lock — a sync is running, maintenance mode is on'
        : (ls.liveOwnerOld ? 'OLD lock with a LIVE owner (live-owner-old) — a sync is still running after more than 6 h; never reclaimed'
          : (ls.stale ? 'STALE lock (older than 6 h, owner gone) — ignored by the hooks and the gateway; the next sync reclaims it' : 'OLD lock whose owner cannot be checked (unknown-owner-old) — not reclaimed automatically'));
      console.log('lock-status ' + path.resolve(pos[0]) + ': ' + label);
      console.log('  age: ' + mins + ' min' + (ls.startedAt ? ' (since ' + ls.startedAt + ')' : ' (from the file time — the lock body is unreadable)'));
      console.log('  pid: ' + (ls.pid == null ? 'unknown' : ls.pid + ' — ' + (ls.pidAlive === true ? 'still running' : ls.pidAlive === false ? 'no longer running' : 'could not tell')));
      console.log('  batch: ' + (ls.batchId || 'unknown'));
      if (ls.fresh && ls.pidAlive === false) console.log('  The process that took this lock is gone. Check the sync log; remove the lock by hand only when you are sure no sync runs.');
    }
    process.exit(ls.present && (ls.fresh || ls.liveOwnerOld) ? 1 : 0);
  } else if (cmd === 'protect-manifest') {
    // read-only on the project; writes ONLY the --out file.
    if (!pos[0] || !flags.out) exitUsage('usage: forge-sync protect-manifest <projectDir> --out <file>');
    if (!fs.existsSync(claudeDirOf(pos[0]))) exitUsage('forge-sync: not a project (.claude missing): ' + path.resolve(pos[0]));
    let m, written;
    const t0 = Date.now();
    try { m = buildProtectManifest(TEMPLATE, pos[0], { selfPath: flags.out }); written = writeProtectManifest(m, flags.out); }
    catch (e) { console.error('forge-sync: protect-manifest failed — ' + e.message); process.exit(1); }
    console.log('protect manifest for ' + m.projectPath + ' written to ' + written + ' (' + (Date.now() - t0) + ' ms)');
    console.log('  ' + m.counts.total + ' protected entr' + (m.counts.total === 1 ? 'y' : 'ies') + ' (' + (m.counts.file || 0) + ' file(s) hashed, ' + (m.counts.meta || 0) + ' secret-like file(s) size+mtime only, ' + (m.counts.dir || 0) + ' folder(s)) · '
      + m.shippedRels.length + ' shipped file(s) excluded (template ' + (m.templateDir || '?') + (TEMPLATE_IS_FALLBACK ? ' — the FALLBACK template: this project\'s own .claude' : '') + ')');
    // WP-SYNC-R13: how much could NOT be read (and so is not hashed) — always said, also when it is 0
    const unr = Object.keys(m.entries).filter((k) => m.entries[k].kind === 'unreadable');
    const unrCodes = {};
    for (const k of unr) { const c = protectErrorCode(m.entries[k]) || 'unknown'; unrCodes[c] = (unrCodes[c] || 0) + 1; }
    console.log('  ' + unr.length + ' unreadable entr' + (unr.length === 1 ? 'y' : 'ies') + ' recorded (not hashed: a folder that cannot be listed or a file that cannot be read'
      + (unr.length ? '; ' + Object.keys(unrCodes).sort().map((c) => c + ' ' + unrCodes[c]).join(', ') + '; ' + unr.filter((k) => m.entries[k].mtimeMs != null).length + ' with their modified time' : '') + ')');
    // WP-SYNC-R14: links — recorded by their target, never followed — and the ones whose target could not be read
    const linkKeys = Object.keys(m.entries).filter((k) => m.entries[k].kind === 'symlink');
    const linkUnr = unr.filter((k) => m.entries[k].syscall === 'readlink' && !m.entries[k].failClosed);
    console.log('  ' + linkKeys.length + ' link(s)/junction(s) recorded by their target (never followed)' + (linkUnr.length ? '; ' + linkUnr.length + ' more whose target could not be read (recorded as unreadable — never a link with an unknown target)' : ''));
    // WP-SYNC-R14: an agent checkout whose .git probe failed is a violation in EVERY verify against this manifest (intended)
    const ckFail = unr.filter((k) => m.entries[k].failClosed === 'checkout');
    if (ckFail.length) {
      const lbl = (e) => (protectErrorCode(e) || 'no code') + (protectErrorSyscall(e) ? ' ' + protectErrorSyscall(e) : '');
      const why = [...new Set(ckFail.map((k) => lbl(m.entries[k])))].sort().join(', ');
      console.log('  ' + ckFail.length + ' agent checkout' + (ckFail.length === 1 ? ' could not be identified (its' : 's could not be identified (their') + ' .git probe failed: ' + why + ') — a PERMANENT violation in every verify against this manifest until the .git entry can be read again (intended: fail closed): '
        + ckFail.slice(0, 10).join(', ') + (ckFail.length > 10 ? ', … +' + (ckFail.length - 10) + ' more' : ''));
    }
    // WP-SYNC-R8: say which folders were recorded as one summary entry (never descended), and what the app-code guard saw
    for (const k of m.summarizedDirs || []) {
      const e = m.entries[k.replace(/\/$/, '')];
      if (e && e.summarized) console.log('  ' + k + ': ' + e.count + ' child entr' + (e.count === 1 ? 'y' : 'ies') + ' recorded by name only — not descended (agent worktree checkouts)');
    }
    // WP-SYNC-R10: per checkout folder, how many children were real checkouts (one entry each) and how many were walked + hashed
    for (const k of m.checkoutDirs || []) {
      const base = k.replace(/\/$/, '');
      const fb = foldCase(base);
      const top = Object.keys(m.entries).find((x) => foldCase(x) === fb);
      if (!top) continue;
      if (m.entries[top].kind !== 'dir') { console.log('  ' + k + ': a ' + m.entries[top].kind + ', not a real folder — recorded as such, nothing behind it read'); continue; }
      const kids = Object.keys(m.entries).filter((x) => foldCase(x).startsWith(fb + '/') && !x.slice(base.length + 1).includes('/'));
      const co = kids.filter((x) => m.entries[x].checkout).length;
      const under = Object.keys(m.entries).filter((x) => foldCase(x).startsWith(fb + '/')).length;
      console.log('  ' + k + ': ' + co + ' checkout(s) (a child holding a .git entry) recorded as one entry each — not descended; '
        + (kids.length - co) + ' other child entr' + (kids.length - co === 1 ? 'y' : 'ies') + ' walked and hashed (' + (under - co) + ' entr' + (under - co === 1 ? 'y' : 'ies') + ' under them in all)');
    }
    const g = m.git;
    console.log('  app-code git guard: ' + (!g ? 'off (not a git work tree)' : (g.unavailable ? 'unavailable (' + g.unavailable + ')'
      : g.count + ' status entr' + (g.count === 1 ? 'y' : 'ies') + ' outside .claude/, ' + (g.ignored ? g.ignored.count + ' ignored file(s)' : 'ignored listing unavailable')
        + ', ' + (g.submodules ? Object.keys(g.submodules).length + ' submodule(s)' : 'submodule listing unavailable') + (g.partial && g.partial.length ? ' — PARTIAL: ' + g.partial.join('; ') : ' — complete'))));
    process.exit(0);
  } else if (cmd === 'verify-protect') {
    // exit 0 = nothing protected changed (beyond the allow-list / the batch's own records), 1 = violation.
    if (!pos[0] || !pos[1]) exitUsage('usage: forge-sync verify-protect <projectDir> <manifestFile> [--batch <id>] [--json]');
    let before;
    try { before = readProtectManifest(pos[1]); } catch (e) { exitUsage('forge-sync: ' + e.message); }
    let bId = flags.batchId || null, bSource = bId ? '--batch' : null;
    if (!bId) { const rc = readReceipt(pos[0]); if (rc && isSafeBatchId(rc.batchId) && fs.existsSync(backupDirFor(pos[0], rc.batchId))) { bId = rc.batchId; bSource = 'the receipt\'s latest batch'; } }
    const expected = bId ? protectExpectationsFromBatch(pos[0], bId) : null;
    let diff;
    try { diff = verifyProtect(pos[0], before, expected); } catch (e) { console.error('forge-sync: verify-protect failed — ' + e.message); process.exit(1); }
    if (flags.json) console.log(JSON.stringify(Object.assign({ batch: bId, batchSource: bSource, expectationSources: expected ? expected.sources : [] }, diff), null, 2));
    else {
      // WP-SYNC-R13B: the counts are printed separately (inventoried / verified / NOT verified) and a not-comparable
      // entry is never called unchanged. WP-SYNC-R14: "nothing protected changed" only when the verdict is COMPLETE
      // (every inventoried entry's content compared and equal, the app code fully guarded); otherwise "no violation detected within
      // the verified scope". Summaries are counted apart and the app-code coverage stands in the same line.
      const pc = protectCounts(diff);
      const head = diff.ok ? (pc.complete ? 'OK — nothing protected changed' : 'OK — no violation detected within the verified scope') : 'VIOLATION';
      console.log('verify-protect ' + before.projectPath + ': ' + head + ' (' + pc.inventoried + ' entr' + (pc.inventoried === 1 ? 'y' : 'ies') + ' inventoried, ' + pc.verified + ' verified, ' + pc.notVerified + ' NOT verified'
        + (pc.notVerified ? ' — unreadable on both sides, not comparable' : '') + ', ' + pc.summarized + ' summarized (presence / metadata only — content not compared)'
        + (pc.changedBySync ? ', ' + pc.changedBySync + ' changed by the batch (recorded)' : '') + '; app code: ' + protectAppCoverage(diff.appCode)
        + '; batch records: ' + (bId ? bId + ' via ' + bSource : 'none — only the bookkeeping allow-list applies') + ')');
      const folderAdds = diff.allowed.filter((a) => /^folder for a shipped/.test(a.why));
      if (folderAdds.length) console.log('  allowed  ' + folderAdds.length + ' new folder(s) that hold shipped or sync-created files (--json lists them)');
      diff.allowed.filter((a) => !/^folder for a shipped/.test(a.why)).forEach((a) => console.log('  allowed  ' + a.change + ' ' + a.key + ' — ' + a.why));
      // WP-SYNC-R13: what could not be read on each side, and how many of those were unreadable both times (not comparable)
      const un = diff.unreadable || { before: 0, after: 0, notComparable: 0 };
      console.log('  unreadable entries recorded: ' + un.before + ' before, ' + un.after + ' now (not hashed)');
      const ncl = protectNotComparableLine(diff);
      if (ncl) console.log('  ' + ncl + ' (--json lists them)');
      protectViolationLines(diff).forEach((l) => console.error('  ' + l));
      protectWhyLines(diff, 20).forEach((l) => console.error('    ' + l)); // WP-SYNC-R13B: why an unreadable pair is a change
    }
    process.exit(diff.ok ? 0 : 1);
  } else {
    exitUsage('unknown command: ' + cmd + ' (use status|install|adopt|list|canary-init|sync-all|doctor|rollback|rollback-batch|quiesce-check|lock-status|protect-manifest|verify-protect|publish-template)');
  }
}
