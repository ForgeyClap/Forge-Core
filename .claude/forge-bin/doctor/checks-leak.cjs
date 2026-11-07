'use strict';
/**
 * doctor/checks-leak.cjs — one module of forge-doctor.cjs (WP A11 part 2): leak_scan: tracked-file discovery (nested repos, gitless walk) and the hardened secret-pattern scan.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { store } = require('./context.cjs');

// friendly label for a hardened SECRET_PATTERN (source-based, no parallel list to drift)
function secretLabel(src) {
  if (src.includes('nvapi')) return 'nvidia-nvapi-key';
  if (src.includes('sk_')) return 'stripe-key';
  if (src.includes('sk-')) return 'openai-style-key';
  if (src.includes('rk_')) return 'stripe-restricted-key';
  if (src.includes('gh[')) return 'github-token';
  if (src.includes('xox')) return 'slack-token';
  if (src.includes('AKIA')) return 'aws-access-key';
  if (src.includes('AIza')) return 'google-api-key';
  if (src.includes('SG')) return 'sendgrid-key';
  if (src.includes('PRIVATE KEY')) return 'pem-private-key';
  if (src.includes('eyJ')) return 'jwt';
  if (src.includes('/') && src.includes('@')) return 'url-embedded-credentials'; // source has escaped slashes (:\/\/)
  return 'secret-pattern';
}

// 5) leak scan of git-tracked files (falls back to a bounded working-tree walk if git is unavailable)
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'forge-runs', 'forge-backups', '.cache',
  // VENV/VENDOR CONTAINMENT (gemeten op "aiTraining"): the gitless WALK crawled a Python
  // virtualenv (12.728 files) and flagged 16 third-party docstring URL-examples (fsspec/httpx/pandas/
  // pyarrow/urllib3) as url-embedded-credentials. A venv/site-packages tree is dependency territory
  // exactly like node_modules: third-party code we do not own. Fixed dir names here; arbitrary venv
  // names (.venv-train, …) are caught by the pyvenv.cfg marker check in isVenvDir() below.
  '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.mypy_cache', '.ruff_cache', '.pytest_cache']);
/** isVenvDir — definitive Python-venv detection by its marker file, so a venv is skipped whatever its
 *  directory name is (measured real case: `.venv-train`). Cheap: one existsSync per DIRECTORY walked. */
function isVenvDir(absDir) { return fs.existsSync(path.join(absDir, 'pyvenv.cfg')); }
/** WP 2.1: the same two operational folders in the opt-in .forge/ state root (root-relative, case-folded): run logs and
 *  the sync's own backups, skipped by both walks exactly like forge-runs/forge-backups above. The rest of .forge/
 *  (research, memory, scribe, ...) is scanned like its legacy .claude/ counterpart. */
const FORGE_STATE_WALK_SKIP = new Set(['.forge/runs', '.forge/backups']);
function isForgeStateSkip(rootRel) { return FORGE_STATE_WALK_SKIP.has(String(rootRel).split(/[\\/]/).filter(Boolean).join('/').toLowerCase()); }
// How deep below the project root a nested repository is still looked for. Four levels covers every real
// layout this project has met (`command-center/`, `apps/<x>/`, `packages/<x>/<y>/`) without turning repo
// discovery into a full-tree walk of a large monorepo.
const NESTED_REPO_MAX_DEPTH = 4;
/**
 * isAgentWorktreesDir(rel) -> true for a `.claude/worktrees` folder (root-relative, any depth, any case).
 *
 * WP-SYNC-R8 (measured on the 26H2 project): `.claude/worktrees/` there held 98 folders, 93 of them
 * agent checkouts made by `git worktree add` — about 3.2 million files, 29.5 GB. Each checkout has a `.git` FILE,
 * so nestedGitRepos() (depth 4) found every one as a "nested repository" at `.claude/worktrees/<name>` (depth 3)
 * and trackedFiles() fed its whole `git ls-files` into the leak scan: millions of reads. They are not nested
 * repositories of the project — they are worktrees OF the project's own repository (scratch copies of its tracked
 * content at other commits), never shipped and never app code of this tree. The doctor no longer descends into
 * them anywhere (nested-repo discovery and the gitless walk) and says so in the leak-scan line (`notScanned`).
 * Stated limit: a secret committed ONLY on an agent's worktree branch is not scanned here.
 */
function isAgentWorktreesDir(rel) {
  const segs = String(rel).split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
  return segs.length >= 2 && segs[segs.length - 1] === 'worktrees' && segs[segs.length - 2] === '.claude';
}
/** hasGitEntry(dirAbs) — WP-SYNC-R10: the folder holds a `.git` entry of ANY kind (file, folder, link — lstat, never followed).
 *  In the gitless walk this is what makes a child of `.claude/worktrees` an agent checkout (skipped); every other child there is
 *  walked and scanned like the rest of the tree. Nested-repo discovery (git mode) still skips the whole `.claude/worktrees`
 *  folder: there only tracked files are scanned anyway, and every child there that is a repository is a checkout. */
function hasGitEntry(dirAbs) { try { fs.lstatSync(path.join(dirAbs, '.git')); return true; } catch { return false; } }

/**
 * nestedGitRepos(root, maxDepth) -> ['command-center', ...] (root-relative, forward slashes, sorted)
 *
 * THE BLIND SPOT THIS EXISTS FOR (measured on this project, not assumed):
 *     git ls-files | wc -l                      -> 1298
 *     git ls-files | grep -c '^command-center/' ->    0
 * `command-center/` is its own git repository nested under the project root, so the outer index has never
 * heard of a single file in it. trackedFiles() sourced the entire leak scan from that one index, which
 * means the gateway that spawns the real `claude` CLI and the Discord integration that holds a live bot
 * token were never scanned once — while the doctor printed "1146 tracked files (git) · clean" and the sync
 * gate consumed that as coverage. A scan cannot honestly call a tree clean when it never opened it, and
 * nothing in the output distinguished "found nothing" from "looked at nothing". When that same tree was
 * later published as one repository, 9 findings appeared on the first scan.
 *
 * A directory counts as a nested repo when it contains a `.git` entry of ANY kind — a directory (ordinary
 * clone) or a file (worktree / submodule gitlink). Descent continues past a found repo so a doubly-nested
 * one is still discovered, and the ordinary heavy/vendor directories are skipped exactly as the walk
 * fallback below skips them. Never throws: an unreadable directory is simply not descended into.
 */
function nestedGitRepos(root, maxDepth, notScannedOut) {
  const cap = Number.isFinite(maxDepth) ? maxDepth : NESTED_REPO_MAX_DEPTH;
  const found = [];
  (function walk(dir, depth, rel) {
    if (depth > cap) return;
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory() || WALK_SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childAbs = path.join(dir, e.name);
      // WP-SYNC-R8: agent worktree checkouts — never a nested repo of ours, never descended (see isAgentWorktreesDir)
      if (isAgentWorktreesDir(childRel)) { if (Array.isArray(notScannedOut)) notScannedOut.push(childRel); continue; }
      if (isForgeStateSkip(childRel)) continue; // WP 2.1: .forge/runs, .forge/backups (like forge-runs/forge-backups)
      if (isVenvDir(childAbs)) continue; // a venv is dependency territory — never a nested repo of ours
      if (fs.existsSync(path.join(childAbs, '.git'))) found.push(childRel);
      walk(childAbs, depth + 1, childRel);
    }
  })(root, 1, '');
  return found.sort();
}

/** gitLsFiles(dirAbs) -> string[] | null — the repo's own tracked-file list, or null when this is not a
 *  usable git repository. `git ls-files` is the only listing method used for a nested repo, deliberately:
 *  it lists TRACKED files and nothing else, so whatever that repo gitignores (its `.env`, its build output)
 *  is never opened, never scanned, and never even named as a path in the report. Widening the scan must not
 *  become a way to read files the repository itself declared out of bounds. */
function gitLsFiles(dirAbs) {
  const r = spawnSync('git', ['-C', dirAbs, 'ls-files'], { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** trackedFiles(root) -> {source, files, sources}
 *  `sources` is the honest accounting the old single-number output could not give: one entry per repository
 *  that actually contributed, `{root, method, files}`, so "N tracked files" can never again mean "N files
 *  from however many of this tree's repositories we happened to notice". A source whose `git ls-files`
 *  fails is reported with `unavailable` rather than dropped — and is NOT walked as a consolation prize,
 *  because a walk would read exactly the ignored files the git listing exists to exclude.
 *  Nested discovery only applies when the ROOT itself is a git repo. When git is unavailable the walk
 *  fallback already covers the whole tree from the root down (including any nested repo's working files),
 *  and it is left byte-for-byte as it was. */
function trackedFiles(root) {
  // WP-SYNC-R8: folders deliberately not descended into (agent worktree checkouts), reported — never silently dropped
  const notScannedDirs = [];
  // WP-SYNC-R10 (Codex R8-03b): in the gitless walk only the CHECKOUTS inside .claude/worktrees are skipped; how many, per folder
  const checkoutsSkipped = new Map();
  const notScanned = () => [...new Set(notScannedDirs)].sort().map((dir) => (checkoutsSkipped.has(dir)
    ? { dir, reason: 'agent worktree checkouts (' + checkoutsSkipped.get(dir) + ' folder(s) holding a .git entry) — scratch copies of this repository, not scanned; every other file in ' + dir + '/ was scanned', checkouts: checkoutsSkipped.get(dir) }
    : { dir, reason: 'agent worktree checkouts (git worktree add) — scratch copies of this repository, not scanned' }));
  const rootList = gitLsFiles(root);
  if (rootList) {
    const files = rootList.slice();
    const seen = new Set(rootList);
    const sources = [{ root: '.', method: 'git', files: rootList.length }];
    for (const relDir of nestedGitRepos(root, NESTED_REPO_MAX_DEPTH, notScannedDirs)) {
      const nested = gitLsFiles(path.join(root, relDir.split('/').join(path.sep)));
      if (nested === null) { sources.push({ root: relDir, method: 'git', files: 0, unavailable: 'git ls-files failed' }); continue; }
      let added = 0;
      for (const f of nested) {
        // de-duplicated on purpose: a nested repo's directory can also be tracked by the outer index (an
        // added submodule, a directory that gained its own .git later), and one file must not be scanned
        // twice nor counted twice in the totals.
        const rel = relDir + '/' + f;
        if (seen.has(rel)) continue;
        seen.add(rel); files.push(rel); added++;
      }
      sources.push({ root: relDir, method: 'git', files: added });
    }
    return { source: 'git', files, sources, notScanned: notScanned() };
  }
  // fallback: bounded walk, skip the usual heavy/secret-bearing dirs (git absent). forge-runs + forge-backups
  // are Forge's OWN operational artifacts (run logs; backups of Forge's own system files, which include test
  // fixtures) — never the project source we scan for leaked credentials.
  const out = [];
  (function walk(dir, depth) {
    if (depth > 6) return; let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // WP-SYNC-R10 (Codex R8-03b): R8 skipped the WHOLE .claude/worktrees folder here, so a plain folder or file there (not a
    // checkout) was never leak-scanned in gitless mode. Now the walk goes in, and skips only a child that holds a `.git` entry
    // of any kind (a `git worktree add` checkout's .git FILE, a clone's .git folder) — that one is named in notScanned.
    const dirRel = path.basename(dir).toLowerCase() === 'worktrees' ? path.relative(root, dir).split(path.sep).join('/') : null;
    const inWorktrees = dirRel !== null && isAgentWorktreesDir(dirRel);
    for (const e of es) {
      if (e.isDirectory()) {
        const childAbs = path.join(dir, e.name);
        if (inWorktrees && hasGitEntry(childAbs)) { notScannedDirs.push(dirRel); checkoutsSkipped.set(dirRel, (checkoutsSkipped.get(dirRel) || 0) + 1); continue; }
        if (depth === 1 && isForgeStateSkip(path.relative(root, childAbs))) continue; // WP 2.1: .forge/runs, .forge/backups
        if (!WALK_SKIP_DIRS.has(e.name) && !isVenvDir(childAbs)) walk(childAbs, depth + 1);
        continue;
      }
      if (e.isFile()) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  })(root, 0);
  return { source: 'walk', files: out, sources: [{ root: '.', method: 'walk', files: out.length }], notScanned: notScanned() };
}
// A matched string only counts as a REAL leak if it isn't a placeholder, a short label, or a repeated-
// filler test fixture. (Redaction patterns are intentionally aggressive; leak DETECTION must be precise so
// it doesn't cry wolf on the security tooling + test fixtures. The match text is used only transiently for
// this decision — it is NEVER stored or printed.)
// Explicit "this is not a real credential" intent markers — a human deliberately wrote one of these into a
// placeholder / fixture value. Present in the SECRET portion of a match -> exempt. (5th fix round, break-swarm
// #6: XXXX was moved OUT of this STRONG set into the WEAK signals in looksLikeRealSecret — 4 literal X's occur
// INCIDENTALLY inside real high-entropy tokens, e.g. ghp_aB3xxxxKz9..., so on their own they must never
// exempt a genuine, store-redactable secret.)
const STRONG_PLACEHOLDER_RE = /FAKE|EXAMPLE|PLACEHOLDER|REDACTED|SAMPLE|DUMMY|CHANGE[_-]?ME|YOUR[_-]?|SECRETSECRET/i;
// Fix (SYSTEM-BREAKING + HIGH, 2nd fix round): the previous "REGEX_SOURCE_RE" character-shape
// heuristic (`/\\|\{\d+,?\d*\}|\[[^\]\r\n]{1,200}\]/`, added in the FIRST fix round) was ITSELF fundamentally
// broken — it tried to distinguish a regex SOURCE from a secret VALUE by looking at loose characters
// (backslash / `{n,m}` / `[...]`), but a genuine secret can legitimately contain every one of those:
//   - a PEM private key inlined in JSON (`JSON.stringify({private_key: '...BEGIN...\n'+body+'\n...END...'})`,
//     the exact shape of a committed GCP service-account key) has LITERAL two-character `\n` escape
//     sequences in the file — the backslash alone tripped REGEX_SOURCE_RE and the WHOLE PEM match was waved
//     through as "just a regex source", even though `store.redactValue` on the same content redacts it fine.
//   - a connection-string password containing `[`, `]`, `\`, or a `{n,m}`-shaped substring (e.g.
//     `postgres://user:EXAMPLE-My[Secret]Pass99xx@host/db` — the PASSWORD is deliberately marked EXAMPLE so
//     this very comment doesn't itself trip this file's own leak_scan) tripped the same false exemption.
// There is no reliable CHARACTER-based signal here; the only reliable signal is CONTEXT: is this exact text
// sitting literally between `/` delimiters (or inside a `new RegExp('...')` call) on its own source line —
// i.e. it IS a pattern DEFINITION (like store.SECRET_PATTERNS itself, or an AGENT_INJECTION_PATTERNS entry),
// not a secret VALUE — see isPatternDefinitionContext() below, which replaces REGEX_SOURCE_RE entirely.
// looksLikeRealSecret() is now a PURE content check only (length / placeholder / repeated-filler); it no
// longer makes any regex-source judgement — that job belongs solely to isPatternDefinitionContext(), which
// needs the surrounding source text + match position to decide honestly instead of guessing from characters
// the match happens to contain.
// secretPortion — for a url-embedded-credentials match (scheme://user:YOUR_PASSWORD@) return only the password (the
// actual secret); for every other pattern the whole match IS the secret. 5th fix round (break-swarm #6,
// SYSTEM-BREAKING): the placeholder heuristic used to run against the WHOLE match, so a benign 'example'/
// 'sample' in the scheme or username (an "example_user" login with a REAL password on a staging DB — a
// ubiquitous shape) waved the REAL password through with a SILENT miss. Judging placeholders on the PASSWORD
// only fixes that while still exempting a genuine placeholder password like YOUR_PASSWORD.
function secretPortion(match) {
  if (/^[a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+:[^\s:/@]+@$/i.test(match)) {
    const noAt = match.slice(0, -1);                 // drop trailing '@'
    return noAt.slice(noAt.lastIndexOf(':') + 1);    // password after the last ':' (scheme/user colons are earlier)
  }
  return match;
}
function looksLikeRealSecret(match) {
  if (typeof match !== 'string' || match.length < 16) return false;  // real keys are long; short = a label like "nvapi-key"
  const secret = secretPortion(match);
  if (STRONG_PLACEHOLDER_RE.test(secret)) return false;              // explicit placeholder / fixture intent in the secret itself
  // WEAK signals — an XXXX run or a repeated-filler run (7+ same char). A REAL high-entropy secret can contain
  // such a substring INCIDENTALLY (ghp_...xxxx..., a base64 all-zero run -> AAAAAAA), so these exempt ONLY when
  // they DOMINATE the secret (cover >= half of it, i.e. it is really a filler/placeholder token, not a key that
  // merely happens to contain the substring). break-swarm #6 proved the old whole-match test silently dropped
  // real secrets on both triggers.
  const residue = secret.replace(/X{4,}/gi, '').replace(/(.)\1{6,}/g, '');
  if (secret.length > 0 && (secret.length - residue.length) >= secret.length / 2) return false; // dominated -> fixture/placeholder
  return true;
}
// Fix (SYSTEM-BREAKING, 3rd fix round): round 2's isPatternDefinitionContext() was context-based
// (not character-based) instead of round 1's broken character-shape guess — an improvement, but it was ITSELF
// still too broad: it judged purely from the TEXT SURROUNDING the match (an unescaped `/` immediately before
// + `/[flags]` immediately after), with no idea whether the scanned FILE is even JavaScript, or whether that
// trailing `/` is a real regex-literal close versus an ordinary trailing-slash URL/path. Two system-breaking
// misses, both proven by an adversarial break-swarm against the REAL tool:
//   1. A real secret in a NON-JS data file (.md/.yaml/.json/.env/.txt) merely WRAPPED in `/.../ ` character-
//      shape (e.g. `notes.md` containing "Deploy key: /nvapi-<realkey>/g and more") reads exactly like a regex
//      literal in raw text, even though the file has no JS regex syntax at all — store.redactValue redacts it,
//      leakScan missed it.
//   2. A real secret sitting in a URL/path that happens to END in "/" (e.g.
//      "https://api.github.com/repos/x/ghp_<realtoken>/") — the trailing slash satisfies the same
//      "regex-literal-close" text shape, so it was waved through too.
// There is no reliable way to tell a genuine JS regex literal apart from these shapes using text alone — `/`
// is division, a regex start, AND a path separator, and context alone can't disambiguate without knowing what
// kind of file it's even looking at. The root fix: shrink the exemption surface to the only place a REAL
// pattern definition can legitimately exist — the two source files that literally DEFINE
// store.SECRET_PATTERNS / doctor's own AGENT_INJECTION_PATTERNS (forge-store.cjs, forge-doctor.cjs;
// PATTERN_DEFINITION_PATHS below). Every other tracked file (.md/.yaml/.json/.env/.txt, any other .js/.cjs,
// agent-memory, docs, etc.) gets NO `/.../ ` exemption anymore — only the PLACEHOLDER_RE marker exempts there.
// isPatternDefinitionContext() itself is UNCHANGED (still the best-available regex-literal-shape heuristic);
// what changed is that leakScan() below now only ever CALLS it for a whitelisted FULL PATH, never globally.
// 4th fix round (break-swarm #4): key on the exact repo-relative PATH, not path.basename(rel).
// Basename-matching WIDENED the exemption to any file merely NAMED forge-store.cjs / forge-doctor.cjs in ANY
// subdirectory (docs/forge-store.cjs, sub/forge-doctor.cjs, an other-project copy path), silently exempting a
// real store-redactable secret disguised as a `/pattern/flags` literal there. The two files that legitimately
// DEFINE these patterns only ever live at exactly these two repo-relative paths — here and in every synced
// project (the template copies them to the same location) — so the exemption is gated on the exact path.
// 2026-09-23 (external audit II-C): the four leak-scan hits the audit saw in `command-center/` were a STALE copy of
// that code in the distribution — the source had already rewritten those lines (a PEM header split across two
// literals, comments without the dashed marker). Measured after the sync: 0 hits with the set exactly as below,
// so the exemption surface was deliberately NOT widened to a third file.
const PATTERN_DEFINITION_PATHS = new Set(['.claude/forge-bin/forge-store.cjs', '.claude/forge-bin/forge-doctor.cjs']);
// isPatternDefinitionContext — CONTEXT-based (not character-based) check: does this match sit literally
// inside a JS `/pattern/flags` regex literal, or inside the quoted first argument of a `new RegExp('...')`/
// `RegExp("...")` call, on its OWN source line in the scanned file? That is a genuine pattern DEFINITION
// (store.SECRET_PATTERNS, AGENT_INJECTION_PATTERNS, etc.), never a secret VALUE sitting in JSON/env/config
// content. Fail-closed by design (per the owner's explicit instruction): a match that spans more than one
// physical line can NEVER be a real JS regex literal (they cannot contain a literal newline), so it is
// immediately rejected here rather than risk exempting a real multi-line PEM secret. Anything this function
// cannot POSITIVELY confirm as `/…/` or `RegExp(...)` syntax is NOT exempted — ambiguous text (including a
// pattern merely quoted in prose/documentation, with no surrounding regex syntax) counts as a real leak,
// which is the safer failure mode than silently waving through an actual credential. CALLER-GATED (2026-07-15,
// 3rd/4th fix round): leakScan() below only invokes this function at all when the scanned file's exact
// repo-relative path is in PATTERN_DEFINITION_PATHS — this function no longer decides exemption scope by
// itself, only shape within an already-whitelisted file.
function isPatternDefinitionContext(text, idx, matchLen) {
  if (text.slice(idx, idx + matchLen).includes('\n')) return false; // spans lines -> can't be a JS literal
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  let lineEnd = text.indexOf('\n', idx + matchLen);
  if (lineEnd === -1) lineEnd = text.length;
  const before = text.slice(lineStart, idx);
  const after = text.slice(idx + matchLen, lineEnd);
  // `/pattern/flags` regex literal: an UNESCAPED `/` immediately precedes the match, and an unescaped `/`
  // (+ optional valid regex flags, then a normal token boundary) immediately follows it on the same line.
  const slashBefore = before === '/' || /[^\\]\/$/.test(before);
  if (slashBefore && /^\/[gimsuy]*(?:[\s,;)\]]|$)/.test(after)) return true;
  // `new RegExp('pattern')` / `RegExp("pattern")` call: match sits inside the quoted first argument.
  if (/RegExp\s*\(\s*['"`]$/.test(before) && /^['"`]\s*[,)]/.test(after)) return true;
  return false;
}
// 4th fix round (break-swarm #4): the old hard 512KB cap SILENTLY skipped any larger tracked
// file — a real committed credential in a >512KB file was never scanned, yet leak_scan still reported
// "clean / ALL GREEN" because nothing surfaced the skip. Two coupled fixes: (a) raise the scan ceiling to
// LEAK_SCAN_MAX_BYTES so every realistically-sized text file (source, config, lockfile, markdown) IS actually
// scanned — regex over a few MB of text is milliseconds; (b) make every remaining skip VISIBLE in the
// returned `skipped` array (and in printSummary), so the verdict can never again claim total coverage while
// silently dropping a file. `ok` stays hits-only on purpose: a too-large or binary file is a SURFACED
// coverage note, not a hard red — flipping the gate red on any large binary asset (an image, a dataset, a
// lockfile) would break every real project's sync gate, the exact kind of self-inflicted breakage this
// honesty loop exists to prevent. The honesty requirement is met by making the skip visible, not by lying
// about it and not by crying wolf on it.
const LEAK_SCAN_MAX_BYTES = 8 * 1024 * 1024;  // 8MB: scans every realistic text file; a larger file is surfaced in skipped, never silently dropped
const LEAK_SCAN_MAX_LINE = 16 * 1024;         // 16KB: a single line longer than this (minified bundle, data blob) is length-bounded out of regex scanning and surfaced — the structural ReDoS guard (see below)
// "test fixtures legitimately hold fake secrets" — a rule this scan has always had. Its implementation was
// /\.test\.[cm]?js$/i, i.e. JavaScript-only, and nothing about the rule was ever meant to be: a
// `chat.test.ts` holds fake credentials for exactly the same reason a `chat.test.cjs` does. The gap stayed
// invisible only because this project's one TypeScript tree (command-center/dashboard) sat inside the
// nested-repo blind spot fixed above — widening the scan surfaced 4 cry-wolf hits on *.test.ts / *.test.tsx
// in the first run. Deliberately kept to the SAME rule rather than a broader one: only the `.test.`
// infix before a JS/TS extension, so `real-source.ts` is still scanned and a file merely named
// `latest.ts` or `contest.js` is untouched. The trade-off (a genuine secret hidden in a file named
// `*.test.ts` is missed) is not new — it is the pre-existing, deliberate trade-off of the JS rule, now
// applied consistently instead of by accident of file extension.
const TEST_FIXTURE_RE = /\.test\.(?:[cm]?jsx?|[cm]?tsx?)$/i;
// leakScan detection pattern list = store.SECRET_PATTERNS EXCEPT the one MULTI-LINE PEM BLOCK pattern
// (/-----BEGIN...[\s\S]{0,N}?...-----END/) is replaced by its single-line HEADER. Reasons: (a) a
// `-----BEGIN ... PRIVATE KEY-----` line is itself the leak signal — present even in a truncated key — so
// header detection is at least as sensitive; (b) the multi-line block's lazy [\s\S]{0,N}? re-scans up to N
// chars at EVERY `-----BEGIN` position, which an adversarial many-marker file turns into O(markers*N) and
// used to take seconds on a multi-MB file. The full BLOCK pattern stays in store.SECRET_PATTERNS for
// REDACTION (redactString must remove the whole key body); leakScan only needs to DETECT, and does so
// linearly. store keeps redaction correct; leakScan stays ReDoS-proof.
const PEM_HEADER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const LEAK_SCAN_PATTERNS = store.SECRET_PATTERNS.map((re) => (re.source.includes('[\\s\\S]') ? PEM_HEADER_RE : re));
// leakScan (4th fix round, structural): scans every tracked file PER LINE with a per-line length cap, so no
// SECRET_PATTERN can ever run on more than LEAK_SCAN_MAX_LINE characters at once — catastrophic backtracking
// (O(n^2) on a long char run, which once hung the whole doctor for ~160s) is impossible by construction,
// independent of how any individual pattern is written. Coverage is honest: file-level skips (too-large /
// binary) and any length-bounded long line are all surfaced in `skipped`, never silently dropped.
function leakScan(root) {
  const { source, files, sources, notScanned } = trackedFiles(root);
  const hits = []; const skipped = []; let scanned = 0;
  for (const rel of files) {
    if (rel.endsWith('.env.example')) continue;                       // placeholders expected
    if (TEST_FIXTURE_RE.test(rel)) continue;                          // test fixtures legitimately hold fake secrets
    // Forge's OWN operational artifacts are never the project source we scan for leaked credentials: a git-
    // tracked .claude/forge-backups/ holds backups of Forge's own system files (which contain deliberate test
    // fixtures like forge-chaos.cjs's fake keys) — scanning them is circular and false-positives; .claude/
    // forge-runs/ holds Forge's own event logs (run integrity is covered by chainCheck/certify, not here).
    if (/(^|\/)\.claude\/forge-(backups|runs)\//.test(rel.replace(/\\/g, '/'))) continue;
    const abs = path.join(root, rel);
    let buf;
    try {
      const st = fs.statSync(abs);
      if (st.size > LEAK_SCAN_MAX_BYTES) { skipped.push({ file: rel, bytes: st.size, reason: 'too-large' }); continue; }
      buf = fs.readFileSync(abs);
    } catch (e) {
      // 5th fix round (break-swarm #6): a tracked file that stat/read throws on (EACCES/EPERM permission,
      // ENOENT TOCTOU-deleted, EISDIR submodule/gitlink, EBUSY Windows lock, dangling symlink) must be
      // SURFACED, not silently swallowed — otherwise the verdict claims "clean" over a file it never scanned,
      // the exact silent-drop this round's whole design forbids. It is a coverage note, not a hard red.
      skipped.push({ file: rel, reason: 'unreadable', error: (e && e.code) ? e.code : 'read-error' });
      continue;
    }
    if (buf.includes(0)) { skipped.push({ file: rel, bytes: buf.length, reason: 'binary' }); continue; } // binary-ish
    const text = buf.toString('utf8');
    scanned++;
    // Fail-closed whitelist gate (3rd round, tightened to a FULL-PATH match in the 4th): the regex-literal-
    // context exemption is only ever eligible for the two files that actually DEFINE these patterns, at their
    // exact repo-relative path. Every other tracked file — regardless of extension OR basename, including an
    // ordinary .js/.cjs data file or a docs/forge-store.cjs decoy — gets no `/.../ ` exemption at all.
    const isPatternDefFile = PATTERN_DEFINITION_PATHS.has(rel.replace(/\\/g, '/'));
    const fired = new Set();                                          // one hit row per (file, pattern) — matches the old per-pattern semantics
    let longLines = 0;
    for (const line of text.split('\n')) {
      if (line.length > LEAK_SCAN_MAX_LINE) { longLines++; continue; } // don't regex a pathological long line
      for (const re of LEAK_SCAN_PATTERNS) {
        if (fired.has(re)) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {                        // transient only — never stored
          const exempt = isPatternDefFile && isPatternDefinitionContext(line, m.index, m[0].length);
          if (looksLikeRealSecret(m[0]) && !exempt) { hits.push({ file: rel, pattern: secretLabel(re.source) }); fired.add(re); break; }
          if (re.lastIndex === m.index) re.lastIndex++;               // guard against a zero-length match loop
        }
      }
    }
    if (longLines) skipped.push({ file: rel, reason: 'long-line', lines: longLines });
  }
  return { source, sources, scanned, skipped, ok: hits.length === 0, hits, notScanned: notScanned || [] };
}

module.exports = {
  secretLabel, WALK_SKIP_DIRS, isVenvDir, FORGE_STATE_WALK_SKIP, isForgeStateSkip, NESTED_REPO_MAX_DEPTH,
  isAgentWorktreesDir, hasGitEntry, nestedGitRepos, gitLsFiles, trackedFiles, STRONG_PLACEHOLDER_RE, secretPortion,
  looksLikeRealSecret, PATTERN_DEFINITION_PATHS, isPatternDefinitionContext, LEAK_SCAN_MAX_BYTES, LEAK_SCAN_MAX_LINE,
  TEST_FIXTURE_RE, PEM_HEADER_RE, LEAK_SCAN_PATTERNS, leakScan,
};
